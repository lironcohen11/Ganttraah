import express from 'express';
import { db, isoDate } from './db.js';
import { HttpError, mutate, loadAll, currentSchedule, audit, broadcast, undoState, undoRedo, HISTORY_DAYS } from './store.js';
import { computeSchedule, DEP_TYPES } from './scheduler.js';
import { toDay, fromDay, holidaysInRange, DEFAULT_CALENDAR } from './calendar.js';
import { impactGraph, simulate, taskPath } from './impact.js';
import { authenticate, requireRole, login, logout, sessionCookie, clearCookie, hashPassword, publicUser, enterAsUnit, userFromCookieHeader, checkAdminPassword, setAdminPassword } from './auth.js';
import { loadUnits, isWithin, effectiveOwner, canEditTask, kindAtDepth, unitDepth, unitSubtree } from './units.js';

export const api = express.Router();
api.use(express.json({ limit: '1mb' }));
api.use(authenticate);

const viewer = requireRole('viewer');
const editor = requireRole('editor');
const admin = requireRole('admin');

const FIELD_LABELS = {
  name: 'שם', kind: 'סוג', duration: 'משך', start_constraint: 'התחלה מתוכננת', percent: 'התקדמות',
  owner: 'אחראי', notes: 'הערות', deadline: 'תאריך יעד', cost: 'עלות',
  start_date: 'תאריך התחלה', color: 'צבע', description: 'תיאור',
};
const KIND_LABEL = { task: 'משימה', milestone: 'אבן דרך' };
const DEP_LABEL = { FS: 'סיום ← התחלה', SS: 'התחלה ← התחלה', FF: 'סיום ← סיום' };
const showVal = (k, v) => {
  if (v == null || v === '') return '—';
  if (k === 'kind') return KIND_LABEL[v] || v;
  if (k === 'percent') return `${v}%`;
  if (k === 'duration') return `${v} ימים`;
  if (k === 'notes') return String(v).length > 30 ? String(v).slice(0, 30) + '…' : v;
  return v;
};
const isDate = (v) => v == null || v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v);
const intOr = (v, d) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d);
const idParam = (req) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new HttpError(400, 'מזהה לא תקין');
  return id;
};

// ------------------------------------------------------------------ auth
api.post('/login', async (req, res) => {
  const { token, user, expires } = await login(req.body?.username, req.body?.password);
  res.setHeader('Set-Cookie', sessionCookie(token, expires));
  res.json({ user });
});
api.post('/logout', async (req, res) => {
  await logout(req.headers.cookie);
  res.setHeader('Set-Cookie', clearCookie());
  res.json({ ok: true });
});
api.get('/me', (req, res) => res.json({ user: req.user ? publicUser(req.user) : null }));

// ------------------------------------------------------------------ organisation & entering as a unit
api.get('/units', async (_req, res) => res.json(await loadUnits()));
api.post('/enter', async (req, res) => {
  const { token, expires } = await enterAsUnit(req.body?.unit_id, !!req.body?.view_only, req.body?.password);
  res.setHeader('Set-Cookie', sessionCookie(token, expires));
  res.json({ user: publicUser(await userFromCookieHeader(`gantraah_sid=${token}`)) });
});
// the branch management password (only branch management, already signed in, can change it)
api.put('/admin-password', admin, async (req, res) => {
  const next = String(req.body?.next ?? '');
  if (next.trim().length < 4) throw new HttpError(400, 'הסיסמה החדשה קצרה מדי (לפחות 4 תווים)');
  await setAdminPassword(next);
  await audit(req.user, { entity: 'settings', action: 'update', summary: 'הוחלפה הסיסמה של הנהלת הענף' });
  res.json({ ok: true });
});

const unitChanged = (req, summary) => broadcast({ type: 'changed', by: req.user.display_name, summary });

api.post('/units', admin, async (req, res) => {
  const units = await loadUnits();
  const parentId = intOr(req.body?.parent_id, null);
  const parent = units.find((u) => u.id === parentId);
  if (!parent) throw new HttpError(400, 'חסרה מסגרת אם');
  const name = String(req.body?.name || '').trim();
  if (!name) throw new HttpError(400, 'חסר שם');
  const so = units.filter((u) => u.parent_id === parentId).reduce((m, u) => Math.max(m, u.sort_order + 1), 0);
  const u = (await db.query('INSERT INTO units (parent_id, kind, name, head, sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [parentId, kindAtDepth(unitDepth(units, parentId) + 1), name, '', so]))[0];
  await audit(req.user, { entity: 'unit', entity_id: u.id, action: 'create', summary: `נוספה מסגרת "${name}" תחת "${parent.name}"` });
  unitChanged(req, `נוספה מסגרת "${name}"`);
  res.json(u);
});

api.patch('/units/:id', admin, async (req, res) => {
  const id = idParam(req);
  const units = await loadUnits();
  const u = units.find((x) => x.id === id);
  if (!u) throw new HttpError(404, 'המסגרת לא נמצאה');
  const b = req.body || {};
  const name = b.name != null ? String(b.name).trim() : u.name;
  if (!name) throw new HttpError(400, 'חסר שם');
  const editAll = 'edit_all' in b ? !!b.edit_all : !!u.edit_all;
  if (editAll && u.parent_id == null) throw new HttpError(400, 'הנהלת הענף עורכת הכול ממילא');
  let parentId = u.parent_id;
  const notes = [];
  if ('parent_id' in b && intOr(b.parent_id, null) !== u.parent_id) {
    parentId = intOr(b.parent_id, null);
    if (u.parent_id == null) throw new HttpError(400, 'אי אפשר להזיז את הנהלת הענף');
    const np = units.find((x) => x.id === parentId);
    if (!np) throw new HttpError(400, 'המסגרת שאליה מעבירים לא נמצאה');
    if (unitSubtree(units, id).has(parentId)) throw new HttpError(400, 'אי אפשר להעביר מסגרת אל תוך עצמה');
    notes.push(`הועברה אל "${np.name}"`);
  }
  await db.tx(async (tx) => {
    await tx.query('UPDATE units SET name=$1, parent_id=$2, edit_all=$3 WHERE id=$4', [name, parentId, editAll, id]);
    if (parentId !== u.parent_id) {
      const so = units.filter((x) => x.parent_id === parentId).reduce((m, x) => Math.max(m, x.sort_order + 1), 0);
      await tx.query('UPDATE units SET sort_order=$1 WHERE id=$2', [so, id]);
      // the kind follows the depth (section / team), for the unit and everything under it
      const after = await loadUnits(tx);
      for (const x of unitSubtree(after, id)) await tx.query('UPDATE units SET kind=$1 WHERE id=$2', [kindAtDepth(unitDepth(after, x)), x]);
    }
  });
  if (name !== u.name) notes.push(`שם: "${u.name}" ← "${name}"`);
  if (editAll !== !!u.edit_all) notes.push(editAll ? 'הרשאה: עורך (כל התוכנית)' : 'הרשאה: צופה (עורכת רק את המשימות שלה)');
  if (notes.length) {
    await audit(req.user, { entity: 'unit', entity_id: id, action: 'update', summary: `עודכנה מסגרת "${name}": ${notes.join(', ')}` });
    unitChanged(req, '');
  }
  res.json({ ok: true });
});

api.delete('/units/:id', admin, async (req, res) => {
  const id = idParam(req);
  const units = await loadUnits();
  const u = units.find((x) => x.id === id);
  if (!u) throw new HttpError(404, 'המסגרת לא נמצאה');
  if (u.parent_id == null) throw new HttpError(400, 'אי אפשר למחוק את הנהלת הענף');
  const sub = unitSubtree(units, id);
  const { sched } = await currentSchedule();
  const open = [...sched.tasks.values()].filter((t) => t.owner_unit_id != null && sub.has(t.owner_unit_id) && t.percent < 100);
  if (open.length) throw new HttpError(400, `אי אפשר למחוק: יש ${open.length === 1 ? 'משימה פתוחה אחת' : `${open.length} משימות פתוחות`} באחריות המסגרת או מתחתיה. קודם מעבירים אותן למסגרת אחרת.`);
  await db.tx(async (tx) => {
    // finished tasks stay in the plan and move to the unit above
    for (const x of sub) await tx.query('UPDATE tasks SET owner_unit_id=$1 WHERE owner_unit_id=$2', [u.parent_id, x]);
    await tx.query('DELETE FROM units WHERE id=$1', [id]);
  });
  await audit(req.user, { entity: 'unit', entity_id: id, action: 'delete', summary: `נמחקה מסגרת "${u.name}"${sub.size > 1 ? ` יחד עם ${sub.size - 1} מסגרות שמתחתיה` : ''}` });
  unitChanged(req, `נמחקה מסגרת "${u.name}"`);
  res.json({ ok: true });
});

// ------------------------------------------------------------------ favourites (kept per unit)
api.post('/favorites', editor, async (req, res) => {
  const taskId = intOr(req.body?.task_id, null);
  if (!req.user.unit_id || taskId == null) throw new HttpError(400, 'לא ניתן לשמור מועדף');
  if (req.body?.on === false) await db.query('DELETE FROM favorites WHERE unit_id=$1 AND task_id=$2', [req.user.unit_id, taskId]);
  else await db.query('INSERT INTO favorites (unit_id, task_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.user.unit_id, taskId]);
  res.json({ ok: true });
});

/** throws 403 unless the current user may edit this task */
const mustEdit = (req, units, sched, taskId, what = 'לערוך את המשימה הזו') => {
  if (!canEditTask(req.user, units, sched, taskId)) {
    const owner = effectiveOwner(sched, taskId);
    const name = units.find((u) => u.id === owner)?.name;
    throw new HttpError(403, `אין לך הרשאה ${what}${name ? `: היא באחריות "${name}"` : ': רק הנהלת הענף יכולה'}.`);
  }
};
/** owner chosen by a non-admin must be their own unit or below it */
const mustAssign = (req, units, ownerId) => {
  if (req.user.role === 'admin') return;
  if (req.user.edit_all && ownerId != null) return; // may edit the whole plan, so may hand a task to any unit
  if (ownerId == null) throw new HttpError(403, 'רק הנהלת הענף יכולה להשאיר משימה בלי אחראי.');
  if (!isWithin(units, ownerId, req.user.unit_id)) throw new HttpError(403, 'אפשר להעביר אחריות רק ליחידה שלך או ליחידות שמתחתיה.');
};

// ------------------------------------------------------------------ everything the UI needs
api.get('/data', viewer, async (req, res) => {
  const { data, sched } = await currentSchedule();
  const tasks = [...sched.tasks.values()];
  let lo = toDay(data.today) - 60, hi = toDay(data.today) + 400;
  for (const t of tasks) { lo = Math.min(lo, toDay(t.start) - 60); hi = Math.max(hi, toDay(t.finish) + 400); }
  const days = [];
  for (let d = lo; d <= hi; d++) {
    const info = sched.cal.dayInfo(d);
    const wd = new Date(d * 86400000).getUTCDay();
    const ruleWork = data.calendarSettings.workDays.includes(wd);
    if (info.label || info.work !== ruleWork) days.push({ d: fromDay(d), off: !info.work, label: info.label });
  }
  res.json({
    today: data.today,
    projects: [...sched.projects.values()],
    tasks: tasks.map(({ _ES, _EF, ...t }) => t),
    dependencies: sched.validDeps,
    calendar: { workDays: data.calendarSettings.workDays, days },
    cycle: sched.cycle,
    db: db.kind,
    undo: await undoState(req.user),
    units: await loadUnits(),
    unitDays: data.specialDays.filter((r) => r.unit_id != null && r.kind !== 'work'),
    favorites: req.user.unit_id ? (await db.query('SELECT task_id FROM favorites WHERE unit_id=$1', [req.user.unit_id])).map((r) => r.task_id).filter((id) => sched.tasks.has(id)) : [],
  });
});

// ------------------------------------------------------------------ undo / redo
api.post('/undo', editor, async (req, res) => res.json(await undoRedo(req.user, 'undo')));
api.post('/redo', editor, async (req, res) => res.json(await undoRedo(req.user, 'redo')));

// ------------------------------------------------------------------ projects
api.post('/projects', admin, async (req, res) => {
  const { name, start_date, color, description } = req.body || {};
  if (!String(name || '').trim()) throw new HttpError(400, 'חסר שם פרויקט');
  if (!start_date || !isDate(start_date)) throw new HttpError(400, 'חסר תאריך התחלה');
  const { result } = await mutate(req.user, async (tx) => {
    const so = (await tx.query('SELECT coalesce(max(sort_order),0)+1 AS n FROM projects'))[0].n;
    const p = (await tx.query(
      'INSERT INTO projects (name, start_date, color, description, sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [String(name).trim(), start_date, color || '#3b6fd8', description || '', so]))[0];
    return { result: p, audit: { entity: 'project', entity_id: p.id, project_id: p.id, action: 'create', summary: `נוצר פרויקט "${p.name}"` } };
  });
  res.json(result);
});

api.patch('/projects/:id', admin, async (req, res) => {
  const id = idParam(req);
  const body = req.body || {};
  const { result } = await mutate(req.user, async (tx) => {
    const p = (await tx.query('SELECT * FROM projects WHERE id=$1', [id]))[0];
    if (!p) throw new HttpError(404, 'הפרויקט לא נמצא');
    const changes = [];
    const sets = [], vals = [];
    for (const k of ['name', 'start_date', 'color', 'description', 'sort_order']) {
      if (!(k in body)) continue;
      let v = body[k];
      if (k === 'start_date' && (!v || !isDate(v))) throw new HttpError(400, 'תאריך לא תקין');
      if (k === 'name' && !String(v).trim()) throw new HttpError(400, 'חסר שם');
      if (k === 'sort_order') v = intOr(v, p.sort_order);
      vals.push(v); sets.push(`${k}=$${vals.length}`);
      if (k !== 'sort_order') changes.push(`${FIELD_LABELS[k]}: ${showVal(k, String(p[k] ?? ''))} → ${showVal(k, v)}`);
    }
    if (!sets.length) return { result: p };
    vals.push(id);
    const np = (await tx.query(`UPDATE projects SET ${sets.join(',')}, updated_at=now() WHERE id=$${vals.length} RETURNING *`, vals))[0];
    return { result: np, audit: changes.length ? { entity: 'project', entity_id: id, project_id: id, action: 'update', summary: `עודכן פרויקט "${np.name}": ${changes.join(', ')}` } : null };
  });
  res.json(result);
});

api.delete('/projects/:id', admin, async (req, res) => {
  const id = idParam(req);
  await mutate(req.user, async (tx) => {
    const p = (await tx.query('SELECT * FROM projects WHERE id=$1', [id]))[0];
    if (!p) throw new HttpError(404, 'הפרויקט לא נמצא');
    await tx.query('DELETE FROM projects WHERE id=$1', [id]);
    return { audit: { entity: 'project', entity_id: id, project_id: id, action: 'delete', summary: `נמחק פרויקט "${p.name}"` } };
  });
  res.json({ ok: true });
});

api.post('/projects/:id/baseline', admin, async (req, res) => {
  const id = idParam(req);
  await mutate(req.user, async (tx, before) => {
    const p = before.projects.get(id);
    if (!p) throw new HttpError(404, 'הפרויקט לא נמצא');
    let n = 0;
    for (const t of before.tasks.values()) {
      if (t.project_id !== id) continue;
      await tx.query('UPDATE tasks SET baseline_start=$1, baseline_finish=$2 WHERE id=$3', [t.start, t.finish, t.id]);
      n++;
    }
    await tx.query('UPDATE projects SET baseline_at=now() WHERE id=$1', [id]);
    return { audit: { entity: 'project', entity_id: id, project_id: id, action: 'baseline', summary: `נשמר תכנון מקורי לפרויקט "${p.name}" (${n} משימות)` } };
  });
  res.json({ ok: true });
});

// ------------------------------------------------------------------ tasks
async function renumber(tx, projectId, parentId) {
  const sibs = parentId == null
    ? await tx.query('SELECT id FROM tasks WHERE project_id=$1 AND parent_id IS NULL ORDER BY sort_order, id', [projectId])
    : await tx.query('SELECT id FROM tasks WHERE parent_id=$1 ORDER BY sort_order, id', [parentId]);
  for (let i = 0; i < sibs.length; i++) await tx.query('UPDATE tasks SET sort_order=$1 WHERE id=$2', [i * 10, sibs[i].id]);
}

api.post('/tasks', editor, async (req, res) => {
  const b = req.body || {};
  const projectId = intOr(b.project_id, null);
  if (!projectId) throw new HttpError(400, 'חסר פרויקט');
  const kind = b.kind === 'milestone' ? 'milestone' : 'task';
  const name = String(b.name || '').trim() || (kind === 'milestone' ? 'אבן דרך חדשה' : 'משימה חדשה');
  const units = await loadUnits();
  const { result } = await mutate(req.user, async (tx, before) => {
    const p = (await tx.query('SELECT * FROM projects WHERE id=$1', [projectId]))[0];
    if (!p) throw new HttpError(404, 'הפרויקט לא נמצא');
    let parentId = b.parent_id == null ? null : intOr(b.parent_id, null);
    if (parentId != null) {
      const par = (await tx.query('SELECT * FROM tasks WHERE id=$1', [parentId]))[0];
      if (!par || par.project_id !== projectId) throw new HttpError(400, 'אב-משימה לא תקינה');
    }
    // Any unit may create a task anywhere; the owner must be the unit itself or a unit below it.
    // A unit's new task is owned by that unit unless it picked a unit below it.
    let ownerUnit = b.owner_unit_id == null || b.owner_unit_id === '' ? null : intOr(b.owner_unit_id, null);
    if (ownerUnit == null && req.user.role !== 'admin') ownerUnit = req.user.unit_id;
    if (ownerUnit != null || req.user.role !== 'admin') mustAssign(req, units, ownerUnit);
    let sort = null;
    if (b.after_id != null) {
      const after = (await tx.query('SELECT * FROM tasks WHERE id=$1', [intOr(b.after_id, 0)]))[0];
      if (after && after.project_id === projectId && (after.parent_id ?? null) === parentId) sort = after.sort_order + 5;
    }
    if (sort == null && b.first) { // a new sub-task goes right under its parent
      const r = parentId == null
        ? await tx.query('SELECT coalesce(min(sort_order),0)-10 AS n FROM tasks WHERE project_id=$1 AND parent_id IS NULL', [projectId])
        : await tx.query('SELECT coalesce(min(sort_order),0)-10 AS n FROM tasks WHERE parent_id=$1', [parentId]);
      sort = r[0].n;
    }
    if (sort == null) {
      const r = parentId == null
        ? await tx.query('SELECT coalesce(max(sort_order),0)+10 AS n FROM tasks WHERE project_id=$1 AND parent_id IS NULL', [projectId])
        : await tx.query('SELECT coalesce(max(sort_order),0)+10 AS n FROM tasks WHERE parent_id=$1', [parentId]);
      sort = r[0].n;
    }
    const duration = kind === 'milestone' ? 0 : Math.max(1, intOr(b.duration, 5));
    const t = (await tx.query(
      `INSERT INTO tasks (project_id, parent_id, sort_order, name, kind, duration, start_constraint, owner, owner_unit_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [projectId, parentId, sort, name, kind, duration, isDate(b.start_constraint) && b.start_constraint ? b.start_constraint : null, '', ownerUnit]))[0];
    await renumber(tx, projectId, parentId);
    return { result: t, audit: { entity: 'task', entity_id: t.id, project_id: projectId, task_id: t.id, action: 'create', summary: `נוצרה ${KIND_LABEL[kind]} "${name}"` } };
  });
  res.json(result);
});

api.patch('/tasks/:id', editor, async (req, res) => {
  const id = idParam(req);
  const b = req.body || {};
  const units = await loadUnits();
  const { result, moved } = await mutate(req.user, async (tx, before) => {
    const t = (await tx.query('SELECT * FROM tasks WHERE id=$1', [id]))[0];
    if (!t) throw new HttpError(404, 'המשימה לא נמצאה');
    mustEdit(req, units, before, id);
    const isSummary = (before.tasks.get(id)?.children || []).length > 0;
    const next = {};
    if ('owner_unit_id' in b) {
      const v = b.owner_unit_id == null || b.owner_unit_id === '' ? null : intOr(b.owner_unit_id, null);
      if (v != null && !units.some((u) => u.id === v)) throw new HttpError(400, 'יחידה לא קיימת');
      mustAssign(req, units, v);
      next.owner_unit_id = v;
    }
    if ('name' in b) { const v = String(b.name || '').trim(); if (!v) throw new HttpError(400, 'חסר שם'); next.name = v; }
    if ('kind' in b) {
      next.kind = b.kind === 'milestone' ? 'milestone' : 'task';
      if (next.kind === 'milestone') { next.duration = 0; next.deadline = null; }
      else if ((t.duration | 0) < 1) next.duration = 1;
    }
    if ('duration' in b && !isSummary) next.duration = Math.max((next.kind || t.kind) === 'milestone' ? 0 : 1, Math.min(5000, intOr(b.duration, t.duration)));
    if ('start_constraint' in b) { if (!isDate(b.start_constraint)) throw new HttpError(400, 'תאריך לא תקין'); next.start_constraint = b.start_constraint || null; }
    if ('deadline' in b) { if (!isDate(b.deadline)) throw new HttpError(400, 'תאריך לא תקין'); next.deadline = b.deadline || null; }
    if ('percent' in b && !isSummary) next.percent = Math.max(0, Math.min(100, intOr(b.percent, t.percent)));
    if ('owner' in b) next.owner = String(b.owner ?? '').slice(0, 200);
    if ('notes' in b) next.notes = String(b.notes ?? '').slice(0, 20000);
    if ('cost' in b) next.cost = b.cost === '' || b.cost == null ? null : Number(b.cost);
    if (next.cost != null && !Number.isFinite(next.cost)) throw new HttpError(400, 'עלות לא תקינה');

    const changes = [];
    const sets = [], vals = [];
    const cur = { ...t, start_constraint: isoDate(t.start_constraint), deadline: isoDate(t.deadline) };
    for (const [k, v] of Object.entries(next)) {
      const old = cur[k] == null ? null : (k === 'cost' ? Number(cur[k]) : cur[k]);
      if (old === v || (old == null && v == null)) continue;
      vals.push(v); sets.push(`${k}=$${vals.length}`);
      const unitName = (x) => (x == null ? 'ללא' : units.find((u) => u.id === x)?.name || x);
      if (k === 'notes') changes.push('הערות עודכנו');
      else if (k === 'owner_unit_id') changes.push(`אחראי: ${unitName(old)} → ${unitName(v)}`);
      else changes.push(`${FIELD_LABELS[k]}: ${showVal(k, old)} → ${showVal(k, v)}`);
    }
    if (!sets.length) return { result: t };
    vals.push(id);
    const nt = (await tx.query(`UPDATE tasks SET ${sets.join(',')}, updated_at=now() WHERE id=$${vals.length} RETURNING *`, vals))[0];
    return {
      result: nt,
      audit: { entity: 'task', entity_id: id, project_id: t.project_id, task_id: id, action: 'update', summary: `"${nt.name}": ${changes.join(', ')}`, details: { changes: next } },
    };
  });
  res.json({ task: result, moved });
});

api.post('/tasks/:id/move', editor, async (req, res) => {
  const id = idParam(req);
  const b = req.body || {};
  const units = await loadUnits();
  await mutate(req.user, async (tx, before) => {
    const t = (await tx.query('SELECT * FROM tasks WHERE id=$1', [id]))[0];
    if (!t) throw new HttpError(404, 'המשימה לא נמצאה');
    mustEdit(req, units, before, id, 'להזיז את המשימה הזו');
    const parentId = b.parent_id == null ? null : intOr(b.parent_id, null);
    // moving your own task anywhere is allowed, like creating it there
    let projectId = t.project_id;
    if (parentId != null) {
      if (parentId === id || before.ancestors(parentId).includes(id)) throw new HttpError(400, 'אי אפשר להכניס משימה לתוך עצמה');
      const par = (await tx.query('SELECT * FROM tasks WHERE id=$1', [parentId]))[0];
      if (!par) throw new HttpError(400, 'אב-משימה לא נמצאה');
      projectId = par.project_id;
    } else if (b.project_id != null) projectId = intOr(b.project_id, t.project_id);
    // dependencies between a task and its new ancestors are not allowed
    const newAnc = parentId == null ? [] : [parentId, ...before.ancestors(parentId)];
    const sub = [...subtreeIds(before, id)];
    const bad = before.validDeps.find((d) =>
      (sub.includes(d.predecessor_id) && newAnc.includes(d.successor_id)) || (sub.includes(d.successor_id) && newAnc.includes(d.predecessor_id)));
    if (bad) throw new HttpError(400, 'יש תלות בין המשימה לבין אב-המשימה החדשה. מחק את התלות קודם.');
    const sibs = parentId == null
      ? await tx.query('SELECT id FROM tasks WHERE project_id=$1 AND parent_id IS NULL AND id<>$2 ORDER BY sort_order, id', [projectId, id])
      : await tx.query('SELECT id FROM tasks WHERE parent_id=$1 AND id<>$2 ORDER BY sort_order, id', [parentId, id]);
    const index = Math.max(0, Math.min(sibs.length, intOr(b.index, sibs.length)));
    const ids = sibs.map((s) => s.id);
    ids.splice(index, 0, id);
    await tx.query('UPDATE tasks SET parent_id=$1, project_id=$2, updated_at=now() WHERE id=$3', [parentId, projectId, id]);
    if (projectId !== t.project_id) {
      const all = [...subtreeIds(before, id)];
      for (const x of all) await tx.query('UPDATE tasks SET project_id=$1 WHERE id=$2', [projectId, x]);
    }
    for (let i = 0; i < ids.length; i++) await tx.query('UPDATE tasks SET sort_order=$1 WHERE id=$2', [i * 10, ids[i]]);
    if ((t.parent_id ?? null) !== parentId) await renumber(tx, t.project_id, t.parent_id ?? null);
    const parentName = parentId == null ? 'רמה עליונה' : `"${before.tasks.get(parentId)?.name}"`;
    return { audit: { entity: 'task', entity_id: id, project_id: projectId, task_id: id, action: 'move', summary: (t.parent_id ?? null) === parentId ? `"${t.name}" הוזזה בסדר המשימות` : `"${t.name}" הועברה אל ${parentName}` } };
  });
  res.json({ ok: true });
});

function subtreeIds(s, id) {
  const out = new Set([id]);
  const stack = [id];
  while (stack.length) for (const c of s.tasks.get(stack.pop())?.children || []) { out.add(c); stack.push(c); }
  return out;
}

api.delete('/tasks/:id', editor, async (req, res) => {
  const id = idParam(req);
  const units = await loadUnits();
  await mutate(req.user, async (tx, before) => {
    const t = before.tasks.get(id);
    if (!t) throw new HttpError(404, 'המשימה לא נמצאה');
    mustEdit(req, units, before, id, 'למחוק את המשימה הזו');
    const n = subtreeIds(before, id).size;
    await tx.query('DELETE FROM tasks WHERE id=$1', [id]);
    await renumber(tx, t.project_id, t.parent_id ?? null);
    return { audit: { entity: 'task', entity_id: id, project_id: t.project_id, task_id: id, action: 'delete', summary: `נמחקה "${t.name}"${n > 1 ? ` יחד עם ${n - 1} תתי-משימות` : ''}`, details: { task: t } } };
  });
  res.json({ ok: true });
});

// ------------------------------------------------------------------ import (from Excel / CSV, mapped in the browser)
// One request = one change: the whole import is undone with a single "undo".
// tasks: [{ key, parent_key, name, kind, duration, start, percent, owner_unit_id, deadline, notes }] parents first
// deps:  [{ from, to, type, lag }] by key
api.post('/import', editor, async (req, res) => {
  const b = req.body || {};
  const rows = Array.isArray(b.tasks) ? b.tasks.slice(0, 3000) : [];
  if (!rows.length) throw new HttpError(400, 'אין משימות לייבוא');
  const units = await loadUnits();
  const isAdmin = req.user.role === 'admin';
  if (b.new_project && !isAdmin) throw new HttpError(403, 'רק הנהלת הענף יכולה ליצור פרויקט חדש.');
  // every owner must be one this unit may assign; without an owner, a unit's tasks are its own
  const ownerOf = (r) => {
    let o = r.owner_unit_id == null || r.owner_unit_id === '' ? null : intOr(r.owner_unit_id, null);
    if (o != null && !units.some((u) => u.id === o)) o = null;
    if (o == null && !isAdmin) o = req.user.unit_id;
    mustAssign(req, units, o);
    return o;
  };
  const owners = rows.map(ownerOf);
  const { result } = await mutate(req.user, async (tx) => {
    let projectId = intOr(b.project_id, null), pname;
    if (b.new_project) {
      const np = b.new_project;
      if (!String(np.name || '').trim() || !isDate(np.start_date) || !np.start_date) throw new HttpError(400, 'חסר שם או תאריך התחלה לפרויקט החדש');
      const so = (await tx.query('SELECT coalesce(max(sort_order),0)+1 AS n FROM projects'))[0].n;
      const p = (await tx.query('INSERT INTO projects (name, start_date, color, description, sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [String(np.name).trim(), np.start_date, np.color || '#3b6fd8', 'יובא מקובץ', so]))[0];
      projectId = p.id; pname = p.name;
    } else {
      const p = (await tx.query('SELECT * FROM projects WHERE id=$1', [projectId]))[0];
      if (!p) throw new HttpError(404, 'הפרויקט לא נמצא');
      pname = p.name;
    }
    const idOf = new Map();
    const base = (await tx.query('SELECT coalesce(max(sort_order),0) AS n FROM tasks WHERE project_id=$1 AND parent_id IS NULL', [projectId]))[0].n;
    const order = new Map(); // sort order per parent
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const name = String(r.name || '').trim().slice(0, 300);
      if (!name) continue;
      const parentId = r.parent_key != null && idOf.has(String(r.parent_key)) ? idOf.get(String(r.parent_key)) : null;
      const pk = parentId ?? 'root';
      const n = (order.get(pk) ?? (parentId == null ? base : 0)) + 10;
      order.set(pk, n);
      const kind = r.kind === 'milestone' ? 'milestone' : 'task';
      const duration = kind === 'milestone' ? 0 : Math.max(1, Math.min(5000, intOr(r.duration, 1)));
      const t = (await tx.query(
        `INSERT INTO tasks (project_id, parent_id, sort_order, name, kind, duration, start_constraint, percent, owner, owner_unit_id, notes, deadline)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'',$9,$10,$11) RETURNING id`,
        [projectId, parentId, n, name, kind, duration, isDate(r.start) && r.start ? r.start : null,
          Math.max(0, Math.min(100, intOr(r.percent, 0))), owners[i], String(r.notes || '').slice(0, 20000),
          kind !== 'milestone' && isDate(r.deadline) && r.deadline ? r.deadline : null]))[0];
      idOf.set(String(r.key), t.id);
    }
    // dependencies: skip anything that does not make sense (unknown, itself, between a task and its parent, twice)
    const parent = new Map();
    for (const r of rows) if (idOf.has(String(r.key)) && r.parent_key != null && idOf.has(String(r.parent_key))) parent.set(idOf.get(String(r.key)), idOf.get(String(r.parent_key)));
    const anc = (id) => { const out = []; for (let x = parent.get(id); x != null; x = parent.get(x)) out.push(x); return out; };
    const seen = new Set();
    let deps = 0;
    for (const d of Array.isArray(b.deps) ? b.deps.slice(0, 10000) : []) {
      const p = idOf.get(String(d.from)), s = idOf.get(String(d.to));
      if (p == null || s == null || p === s || anc(s).includes(p) || anc(p).includes(s)) continue;
      const k = p < s ? `${p}-${s}` : `${s}-${p}`;
      if (seen.has(k)) continue;
      seen.add(k);
      await tx.query('INSERT INTO dependencies (predecessor_id, successor_id, type, lag) VALUES ($1,$2,$3,$4)',
        [p, s, DEP_TYPES.includes(d.type) ? d.type : 'FS', Math.max(-500, Math.min(500, intOr(d.lag, 0)))]);
      deps++;
    }
    return {
      result: { project_id: projectId, tasks: idOf.size, deps },
      audit: { entity: 'project', entity_id: projectId, project_id: projectId, action: 'create', summary: `יובאו ${idOf.size} משימות${deps ? ` ו-${deps} תלויות` : ''} מקובץ אל "${pname}"${b.file ? ` (${String(b.file).slice(0, 80)})` : ''}` },
    };
  });
  res.json(result);
});

// ------------------------------------------------------------------ dependencies
api.post('/dependencies', editor, async (req, res) => {
  const b = req.body || {};
  const p = intOr(b.predecessor_id, null), s = intOr(b.successor_id, null);
  const type = DEP_TYPES.includes(b.type) ? b.type : 'FS';
  const lag = Math.max(-500, Math.min(500, intOr(b.lag, 0)));
  const units = await loadUnits();
  const { result, moved } = await mutate(req.user, async (tx, before) => {
    const pt = before.tasks.get(p), st = before.tasks.get(s);
    if (!pt || !st) throw new HttpError(404, 'משימה לא נמצאה');
    mustEdit(req, units, before, s, 'לקשר אל המשימה הזו (תלות משנה את התאריכים שלה)');
    if (p === s) throw new HttpError(400, 'משימה לא יכולה להיות תלויה בעצמה');
    if (before.ancestors(s).includes(p) || before.ancestors(p).includes(s)) throw new HttpError(400, 'אי אפשר ליצור תלות בין משימה לבין אב-המשימה שלה. ההיררכיה כבר קושרת ביניהן.');
    const exists = before.validDeps.find((d) => (d.predecessor_id === p && d.successor_id === s) || (d.predecessor_id === s && d.successor_id === p));
    if (exists) throw new HttpError(400, 'כבר קיימת תלות בין שתי המשימות האלה');
    const d = (await tx.query('INSERT INTO dependencies (predecessor_id, successor_id, type, lag) VALUES ($1,$2,$3,$4) RETURNING *', [p, s, type, lag]))[0];
    const cross = pt.project_id !== st.project_id ? ' (בין פרויקטים)' : '';
    return { result: d, audit: { entity: 'dependency', entity_id: d.id, project_id: st.project_id, task_id: s, action: 'create', summary: `נוספה תלות${cross}: "${st.name}" תלויה ב-"${pt.name}" (${DEP_LABEL[type]}${lag ? `, ${lag > 0 ? '+' : ''}${lag} ימים` : ''})`, details: { predecessor_id: p, successor_id: s, type, lag } } };
  });
  res.json({ dependency: result, moved });
});

api.patch('/dependencies/:id', editor, async (req, res) => {
  const id = idParam(req);
  const b = req.body || {};
  const units = await loadUnits();
  const { moved } = await mutate(req.user, async (tx, before) => {
    const d = (await tx.query('SELECT * FROM dependencies WHERE id=$1', [id]))[0];
    if (!d) throw new HttpError(404, 'התלות לא נמצאה');
    mustEdit(req, units, before, d.successor_id, 'לשנות את התלות הזו');
    const type = DEP_TYPES.includes(b.type) ? b.type : d.type;
    const lag = 'lag' in b ? Math.max(-500, Math.min(500, intOr(b.lag, d.lag))) : d.lag;
    await tx.query('UPDATE dependencies SET type=$1, lag=$2 WHERE id=$3', [type, lag, id]);
    const st = before.tasks.get(d.successor_id), pt = before.tasks.get(d.predecessor_id);
    return { audit: { entity: 'dependency', entity_id: id, project_id: st?.project_id, task_id: d.successor_id, action: 'update', summary: `עודכנה תלות "${st?.name}" ב-"${pt?.name}": ${DEP_LABEL[d.type]} ${d.lag} → ${DEP_LABEL[type]} ${lag}` } };
  });
  res.json({ ok: true, moved });
});

api.delete('/dependencies/:id', editor, async (req, res) => {
  const id = idParam(req);
  const units = await loadUnits();
  const { moved } = await mutate(req.user, async (tx, before) => {
    const d = (await tx.query('SELECT * FROM dependencies WHERE id=$1', [id]))[0];
    if (!d) throw new HttpError(404, 'התלות לא נמצאה');
    mustEdit(req, units, before, d.successor_id, 'להסיר את התלות הזו');
    await tx.query('DELETE FROM dependencies WHERE id=$1', [id]);
    const st = before.tasks.get(d.successor_id), pt = before.tasks.get(d.predecessor_id);
    return { audit: { entity: 'dependency', entity_id: id, project_id: st?.project_id, task_id: d.successor_id, action: 'delete', summary: `הוסרה תלות: "${st?.name}" כבר לא תלויה ב-"${pt?.name}"` } };
  });
  res.json({ ok: true, moved });
});

// ------------------------------------------------------------------ impact & what-if
api.get('/tasks/:id/impact', viewer, async (req, res) => {
  const id = idParam(req);
  const { sched } = await currentSchedule();
  if (!sched.tasks.has(id)) throw new HttpError(404, 'המשימה לא נמצאה');
  const g = impactGraph(sched, id);
  res.json({
    ...g,
    nodes: g.nodes.map((n) => ({ ...n, path: taskPath(sched, n.id) })),
    ancestors: sched.ancestors(id).reverse(),
  });
});

api.post('/simulate', viewer, async (req, res) => {
  const b = req.body || {};
  const id = intOr(b.task_id, null);
  const data = await loadAll();
  const base = computeSchedule(data);
  if (!base.tasks.has(id)) throw new HttpError(404, 'המשימה לא נמצאה');
  res.json(simulate(data, base, id, b.mode === 'cancel' ? 'cancel' : 'delay', intOr(b.days, 5)));
});

// ------------------------------------------------------------------ history
function historyWhere(q) {
  const where = [`at >= now() - make_interval(days => ${HISTORY_DAYS})`], vals = [];
  const add = (col, v) => { vals.push(v); where.push(`${col}=$${vals.length}`); };
  if (q.task_id) add('task_id', intOr(q.task_id, 0));
  if (q.project_id) add('project_id', intOr(q.project_id, 0));
  if (q.user) add('user_name', String(q.user));
  if (q.action) add('action', String(q.action));
  return { where, vals };
}
// newest first; "before" (an id) gives the next page
api.get('/history', viewer, async (req, res) => {
  const { where, vals } = historyWhere(req.query);
  if (req.query.before) { vals.push(intOr(req.query.before, 0)); where.push(`id < $${vals.length}`); }
  const limit = Math.max(1, Math.min(1000, intOr(req.query.limit, 200)));
  res.json(await db.query(`SELECT * FROM audit_log WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${limit}`, vals));
});
// for the history page: how many entries match the filter, who changed things, which actions, how long history is kept
api.get('/history/meta', viewer, async (req, res) => {
  const { where, vals } = historyWhere(req.query);
  const all = historyWhere({}).where.join(' AND ');
  const [{ n }] = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE ${where.join(' AND ')}`, vals);
  const people = (await db.query(`SELECT DISTINCT user_name FROM audit_log WHERE ${all}`)).map((r) => r.user_name).filter(Boolean);
  const actions = (await db.query(`SELECT DISTINCT action FROM audit_log WHERE ${all}`)).map((r) => r.action);
  res.json({ count: n, people, actions, days: HISTORY_DAYS });
});

// ------------------------------------------------------------------ calendar
api.get('/calendar', viewer, async (req, res) => {
  const data = await loadAll();
  const year = intOr(req.query.year, Number(data.today.slice(0, 4)));
  const from = toDay(`${year}-01-01`), to = toDay(`${year}-12-31`);
  const s = computeSchedule({ ...data, tasks: [], deps: [] });
  const holidays = holidaysInRange(from, to).map((h) => ({ ...h, off: !s.cal.isWork(toDay(h.day)) }));
  res.json({ settings: data.calendarSettings, defaults: DEFAULT_CALENDAR, specialDays: data.specialDays, holidays, year });
});

api.put('/calendar', admin, async (req, res) => {
  const b = req.body || {};
  const value = {
    workDays: DEFAULT_CALENDAR.workDays, // fixed: Sunday to Thursday
    chagOff: !!b.chagOff, independenceOff: !!b.independenceOff, cholHamoedOff: !!b.cholHamoedOff, erevChagOff: !!b.erevChagOff,
  };
  await mutate(req.user, async (tx) => {
    await tx.query(`INSERT INTO settings (key, value) VALUES ('calendar', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(value)]);
    return { audit: { entity: 'calendar', action: 'update', summary: 'עודכנו הגדרות החגים' } };
  });
  res.json({ ok: true });
});

const rangeText = (a, b) => (a === b ? a : `${a} עד ${b}`);

/**
 * Special days. Branch management: for everyone (unit_id null) or for one unit.
 * Any other unit: days off for itself or a unit below it, which apply only to those units' tasks.
 */
api.post('/calendar/special', editor, async (req, res) => {
  const b = req.body || {};
  if (!b.start_day || !isDate(b.start_day)) throw new HttpError(400, 'תאריך לא תקין');
  const end = b.end_day && isDate(b.end_day) ? b.end_day : b.start_day;
  if (end < b.start_day) throw new HttpError(400, 'תאריך הסיום לפני תאריך ההתחלה');
  if (toDay(end) - toDay(b.start_day) > 366) throw new HttpError(400, 'הטווח ארוך מדי');
  const units = await loadUnits();
  const isAdmin = req.user.role === 'admin';
  let unitId = b.unit_id == null || b.unit_id === '' ? null : intOr(b.unit_id, null);
  const root = units.find((u) => u.parent_id == null);
  if (unitId === root?.id) unitId = null; // the branch's own day is everyone's day
  if (!isAdmin) {
    if (unitId == null) unitId = req.user.unit_id;
    if (!isWithin(units, unitId, req.user.unit_id)) throw new HttpError(403, 'אפשר להוסיף ימים מיוחדים רק למסגרת שלך או למסגרות שמתחתיה.');
  }
  if (b.kind === 'work' && unitId != null) throw new HttpError(400, 'יום עבודה מיוחד אפשר להגדיר רק לכל הענף');
  const kind = b.kind === 'work' ? 'work' : 'off';
  const unitName = unitId == null ? 'כל הענף' : units.find((u) => u.id === unitId)?.name;
  await mutate(req.user, async (tx) => {
    await tx.query('INSERT INTO special_days (unit_id, start_day, end_day, kind, label) VALUES ($1,$2,$3,$4,$5)',
      [unitId, b.start_day, end, kind, String(b.label || '').slice(0, 100)]);
    return { audit: { entity: 'calendar', action: 'create', summary: `${rangeText(b.start_day, end)}: ${kind === 'work' ? 'יום עבודה' : 'יום חופש'} ל${unitName}${b.label ? ` (${b.label})` : ''}` } };
  });
  res.json({ ok: true });
});

api.delete('/calendar/special/:id', editor, async (req, res) => {
  const id = idParam(req);
  const units = await loadUnits();
  await mutate(req.user, async (tx) => {
    const r = (await tx.query('SELECT * FROM special_days WHERE id=$1', [id]))[0];
    if (!r) throw new HttpError(404, 'היום המיוחד לא נמצא');
    if (req.user.role !== 'admin' && (r.unit_id == null || !isWithin(units, r.unit_id, req.user.unit_id))) {
      throw new HttpError(403, 'אפשר להסיר רק ימים מיוחדים של המסגרת שלך או של המסגרות שמתחתיה.');
    }
    await tx.query('DELETE FROM special_days WHERE id=$1', [id]);
    return { audit: { entity: 'calendar', action: 'delete', summary: `הוסר יום מיוחד: ${rangeText(isoDate(r.start_day), isoDate(r.end_day))}${r.label ? ` (${r.label})` : ''}` } };
  });
  res.json({ ok: true });
});

// ------------------------------------------------------------------ users
api.get('/users', admin, async (_req, res) => {
  res.json((await db.query('SELECT * FROM users ORDER BY id')).map(publicUser));
});
api.post('/users', admin, async (req, res) => {
  const b = req.body || {};
  const username = String(b.username || '').trim();
  if (!username || !b.password || String(b.password).length < 6) throw new HttpError(400, 'נדרש שם משתמש וסיסמה של 6 תווים לפחות');
  const role = ['admin', 'editor', 'viewer'].includes(b.role) ? b.role : 'viewer';
  const exists = await db.query('SELECT 1 FROM users WHERE lower(username)=lower($1)', [username]);
  if (exists.length) throw new HttpError(400, 'שם המשתמש כבר קיים');
  const u = (await db.query('INSERT INTO users (username, display_name, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING *',
    [username, String(b.display_name || username).trim(), hashPassword(b.password), role]))[0];
  await audit(req.user, { entity: 'user', entity_id: u.id, action: 'create', summary: `נוצר משתמש "${u.display_name}"` });
  res.json(publicUser(u));
});
api.patch('/users/:id', admin, async (req, res) => {
  const id = idParam(req);
  const b = req.body || {};
  const u = (await db.query('SELECT * FROM users WHERE id=$1', [id]))[0];
  if (!u) throw new HttpError(404, 'המשתמש לא נמצא');
  if (id === req.user.id && (b.role && b.role !== 'admin' || b.active === false)) throw new HttpError(400, 'אי אפשר להוריד הרשאות מעצמך');
  const sets = [], vals = [];
  if (b.display_name) { vals.push(String(b.display_name).trim()); sets.push(`display_name=$${vals.length}`); }
  if (['admin', 'editor', 'viewer'].includes(b.role)) { vals.push(b.role); sets.push(`role=$${vals.length}`); }
  if ('active' in b) { vals.push(!!b.active); sets.push(`active=$${vals.length}`); }
  if (b.password) {
    if (String(b.password).length < 6) throw new HttpError(400, 'סיסמה של 6 תווים לפחות');
    vals.push(hashPassword(b.password)); sets.push(`password_hash=$${vals.length}`);
  }
  if (!sets.length) return res.json(publicUser(u));
  vals.push(id);
  const nu = (await db.query(`UPDATE users SET ${sets.join(',')} WHERE id=$${vals.length} RETURNING *`, vals))[0];
  if (b.password || b.active === false) await db.query('DELETE FROM sessions WHERE user_id=$1 AND token<>$2', [id, req.user.token]);
  await audit(req.user, { entity: 'user', entity_id: id, action: 'update', summary: `עודכן משתמש "${nu.display_name}"${b.password ? ' (סיסמה הוחלפה)' : ''}` });
  broadcast({ type: 'users' });
  res.json(publicUser(nu));
});

// ------------------------------------------------------------------ errors
api.use((req, _res, next) => next(new HttpError(404, 'נתיב לא קיים')));
// eslint-disable-next-line no-unused-vars
api.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'שגיאה בשרת. הפרטים נרשמו ביומן השרת.' : err.message });
});
