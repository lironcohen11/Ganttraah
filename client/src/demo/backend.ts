// Demo backend: the whole API running inside the browser, for the single-file demo
// (Gantraah-demo.html). The scheduling engine, Hebrew calendar and impact map are the
// real server modules, imported as-is; data lives in this browser only (localStorage).
// @ts-ignore - plain JS module shared with the server
import { computeSchedule, diffSchedules, DEP_TYPES } from '../../../server/src/scheduler.js';
// @ts-ignore
import { toDay, fromDay, holidaysInRange, DEFAULT_CALENDAR } from '../../../server/src/calendar.js';
// @ts-ignore
import { impactGraph, simulate, taskPath } from '../../../server/src/impact.js';
import seed from './seed.json';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

const KEY = 'gantraah.demo.v1';
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

interface Core { projects: Any[]; tasks: Any[]; deps: Any[]; calendarSettings: Any; calendarExceptions: Any[] }
interface Store extends Core {
  units: Any[]; audit: Any[]; seq: Record<string, number>;
  undo: { label: string; core: Core }[]; redo: { label: string; core: Core }[];
}

function fresh(): Store {
  const s = clone(seed) as Any;
  const max = (l: Any[]) => l.reduce((m, x) => Math.max(m, x.id), 0);
  return {
    projects: s.projects, tasks: s.tasks, deps: s.deps, units: s.units,
    calendarSettings: { ...DEFAULT_CALENDAR }, calendarExceptions: [],
    audit: [{ id: 1, at: new Date().toISOString(), user_name: 'מערכת', entity: 'plan', action: 'create', summary: 'נטענו נתוני ההדגמה', details: {} }],
    seq: { project: max(s.projects), task: max(s.tasks), dep: max(s.deps), audit: 1 },
    undo: [], redo: [],
  };
}
let store: Store = (() => {
  try { const v = localStorage.getItem(KEY); if (v) return JSON.parse(v); } catch { /* ignore */ }
  return fresh();
})();
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* storage full or blocked */ } };
export function resetDemo() { store = fresh(); save(); try { sessionStorage.removeItem('gantraah.demo.unit'); } catch { /* ignore */ } }

// ---- "session": which unit the visitor entered as (kept for this browser tab)
const getUnitId = (): number | null => { try { const v = sessionStorage.getItem('gantraah.demo.unit'); return v ? Number(v) : null; } catch { return null; } };
const setUnitId = (id: number | null) => { try { if (id == null) sessionStorage.removeItem('gantraah.demo.unit'); else sessionStorage.setItem('gantraah.demo.unit', String(id)); } catch { /* ignore */ } };
function currentUser() {
  const id = getUnitId();
  const u = store.units.find((x) => x.id === id);
  if (!u) return null;
  return { id: u.id, unit_id: u.id, username: `unit-${u.id}`, display_name: u.name, head: '', kind: u.kind, role: u.parent_id == null ? 'admin' : 'editor', active: true };
}

// ---- schedule helpers
const todayISO = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
const data = () => ({ ...store, today: todayISO() });
const sched = () => computeSchedule(data());
const core = (): Core => clone({ projects: store.projects, tasks: store.tasks, deps: store.deps, calendarSettings: store.calendarSettings, calendarExceptions: store.calendarExceptions });
const restore = (c: Core) => { Object.assign(store, clone(c)); };

// ---- permissions (same rules as server/src/units.js)
const isWithin = (a: number | null, b: number | null) => {
  let x = a;
  for (let i = 0; i < 50 && x != null; i++) { if (x === b) return true; x = store.units.find((u) => u.id === x)?.parent_id ?? null; }
  return false;
};
const effOwner = (s: Any, id: number | null) => {
  for (let i = 0; i < 100 && id != null; i++) { const t = s.tasks.get(id); if (!t) return null; if (t.owner_unit_id != null) return t.owner_unit_id; id = t.parent_id; }
  return null;
};
function mustEdit(user: Any, s: Any, taskId: number, what = 'לערוך את המשימה הזו') {
  if (user.role === 'admin') return;
  const o = effOwner(s, taskId);
  if (o != null && isWithin(o, user.unit_id)) return;
  const name = store.units.find((u) => u.id === o)?.name;
  throw new HttpError(403, `אין לך הרשאה ${what}${name ? `: היא באחריות "${name}"` : ': רק הנהלת הענף יכולה'}.`);
}
function mustAssign(user: Any, ownerId: number | null) {
  if (user.role === 'admin') return;
  if (ownerId == null) throw new HttpError(403, 'רק הנהלת הענף יכולה להשאיר משימה בלי אחראי.');
  if (!isWithin(ownerId, user.unit_id)) throw new HttpError(403, 'אפשר להעביר אחריות רק ליחידה שלך או ליחידות שמתחתיה.');
}
const needAdmin = (user: Any) => { if (user.role !== 'admin') throw new HttpError(403, 'רק הנהלת הענף יכולה לבצע את הפעולה הזו.'); };

// ---- a change: recompute, refuse cycles, record history and undo
function mutate(user: Any, fn: (before: Any) => { summary: string; taskId?: number; projectId?: number; action: string; result?: Any }) {
  const snapshot = core();
  const before = sched();
  let out;
  try { out = fn(before); } catch (e) { restore(snapshot); throw e; }
  const after = sched();
  if (after.cycle) { restore(snapshot); throw new HttpError(400, 'השינוי יוצר תלות מעגלית (משימה שתלויה בעצמה דרך שרשרת), ולכן לא נשמר.'); }
  const moved = diffSchedules(before, after, out.taskId);
  let summary = out.summary;
  if (moved.length) summary += ` · ${moved.length === 1 ? 'משימה אחת זזה' : `${moved.length} משימות זזו`} בעקבות השינוי`;
  store.audit.unshift({ id: ++store.seq.audit, at: new Date().toISOString(), user_name: user.display_name, entity: 'task', action: out.action, task_id: out.taskId ?? null, project_id: out.projectId ?? null, summary, details: { moved: moved.slice(0, 200) } });
  store.audit = store.audit.slice(0, 500);
  store.undo.push({ label: out.summary, core: snapshot });
  store.undo = store.undo.slice(-40);
  store.redo = [];
  save();
  return { result: out.result, moved };
}

const KIND_LABEL: Record<string, string> = { task: 'משימה', milestone: 'אבן דרך' };
const DEP_LABEL: Record<string, string> = { FS: 'סיום ← התחלה', SS: 'התחלה ← התחלה', FF: 'סיום ← סיום' };
const isDate = (v: Any) => v == null || v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v);
const int = (v: Any, d: Any) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d);
const subtree = (s: Any, id: number) => { const out = new Set([id]); const st = [id]; while (st.length) for (const c of s.tasks.get(st.pop())?.children || []) { out.add(c); st.push(c); } return out; };
function renumber(projectId: number, parentId: number | null) {
  store.tasks.filter((t) => t.project_id === projectId && (t.parent_id ?? null) === parentId)
    .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id).forEach((t, i) => { t.sort_order = i * 10; });
}

// ---------------------------------------------------------------- routes
type Handler = (user: Any, body: Any, m: RegExpMatchArray, q: URLSearchParams) => Any;
const routes: [string, RegExp, Handler, ('viewer' | 'editor' | 'public')?][] = [];
const on = (method: string, re: RegExp, h: Handler, need: 'viewer' | 'editor' | 'public' = 'editor') => routes.push([method, re, h, need]);

on('GET', /^\/me$/, () => ({ user: currentUser() }), 'public');
on('GET', /^\/units$/, () => store.units, 'public');
on('POST', /^\/enter$/, (_u, b) => {
  const u = store.units.find((x) => x.id === Number(b.unit_id));
  if (!u) throw new HttpError(400, 'היחידה לא נמצאה');
  setUnitId(u.id);
  return { user: currentUser() };
}, 'public');
on('POST', /^\/logout$/, () => { setUnitId(null); return { ok: true }; }, 'public');

on('GET', /^\/data$/, () => {
  const d = data();
  const s = computeSchedule(d);
  const tasks = [...s.tasks.values()];
  let lo = toDay(d.today) - 60, hi = toDay(d.today) + 400;
  for (const t of tasks) { lo = Math.min(lo, toDay(t.start) - 60); hi = Math.max(hi, toDay(t.finish) + 400); }
  const days = [];
  for (let x = lo; x <= hi; x++) {
    const info = s.cal.dayInfo(x);
    const ruleWork = d.calendarSettings.workDays.includes(new Date(x * 86400000).getUTCDay());
    if (info.label || info.work !== ruleWork) days.push({ d: fromDay(x), off: !info.work, label: info.label });
  }
  const top = (l: Any[]) => (l.length ? { label: l[l.length - 1].label, blocked: false } : null);
  return {
    today: d.today, projects: [...s.projects.values()], tasks: tasks.map(({ _ES, _EF, ...t }: Any) => t),
    dependencies: s.validDeps, calendar: { workDays: d.calendarSettings.workDays, days }, cycle: s.cycle, db: 'demo',
    undo: { undo: top(store.undo), redo: top(store.redo) }, units: store.units,
  };
}, 'viewer');

for (const kind of ['undo', 'redo'] as const) {
  on('POST', new RegExp(`^/${kind}$`), (user) => {
    const from = kind === 'undo' ? store.undo : store.redo, to = kind === 'undo' ? store.redo : store.undo;
    const e = from.pop();
    if (!e) throw new HttpError(400, kind === 'undo' ? 'אין שינוי לבטל' : 'אין שינוי לבצע שוב');
    const before = sched();
    to.push({ label: e.label, core: core() });
    restore(e.core);
    const moved = diffSchedules(before, sched(), null);
    const summary = `${kind === 'undo' ? 'בוטל' : 'בוצע שוב'}: ${e.label}`;
    store.audit.unshift({ id: ++store.seq.audit, at: new Date().toISOString(), user_name: user.display_name, entity: 'plan', action: kind, summary, details: { moved } });
    save();
    return { summary, moved };
  });
}

// projects (branch management only)
on('POST', /^\/projects$/, (user, b) => {
  needAdmin(user);
  if (!String(b.name || '').trim() || !b.start_date) throw new HttpError(400, 'חסר שם או תאריך התחלה');
  return mutate(user, () => {
    const p = { id: ++store.seq.project, name: String(b.name).trim(), description: b.description || '', color: b.color || '#3b6fd8', start_date: b.start_date, sort_order: store.projects.length + 1 };
    store.projects.push(p);
    return { result: p, action: 'create', projectId: p.id, summary: `נוצר פרויקט "${p.name}"` };
  }).result;
});
on('PATCH', /^\/projects\/(\d+)$/, (user, b, m) => {
  needAdmin(user);
  const p = store.projects.find((x) => x.id === Number(m[1]));
  if (!p) throw new HttpError(404, 'הפרויקט לא נמצא');
  return mutate(user, () => {
    for (const k of ['name', 'start_date', 'color', 'description', 'sort_order']) if (k in b) p[k] = b[k];
    return { result: p, action: 'update', projectId: p.id, summary: `עודכן פרויקט "${p.name}"` };
  }).result;
});
on('DELETE', /^\/projects\/(\d+)$/, (user, _b, m) => {
  needAdmin(user);
  const id = Number(m[1]);
  const p = store.projects.find((x) => x.id === id);
  if (!p) throw new HttpError(404, 'הפרויקט לא נמצא');
  mutate(user, () => {
    const gone = new Set(store.tasks.filter((t) => t.project_id === id).map((t) => t.id));
    store.projects = store.projects.filter((x) => x.id !== id);
    store.tasks = store.tasks.filter((t) => !gone.has(t.id));
    store.deps = store.deps.filter((d) => !gone.has(d.predecessor_id) && !gone.has(d.successor_id));
    return { action: 'delete', projectId: id, summary: `נמחק פרויקט "${p.name}"` };
  });
  return { ok: true };
});
on('POST', /^\/projects\/(\d+)\/baseline$/, (user, _b, m) => {
  needAdmin(user);
  const id = Number(m[1]);
  mutate(user, (before) => {
    for (const t of before.tasks.values()) {
      if (t.project_id !== id) continue;
      const raw = store.tasks.find((x) => x.id === t.id);
      raw.baseline_start = t.start; raw.baseline_finish = t.finish;
    }
    return { action: 'baseline', projectId: id, summary: 'נשמר התכנון המקורי' };
  });
  return { ok: true };
});

// tasks
on('POST', /^\/tasks$/, (user, b) => {
  const projectId = int(b.project_id, null);
  if (!store.projects.some((p) => p.id === projectId)) throw new HttpError(404, 'הפרויקט לא נמצא');
  const kind = b.kind === 'milestone' ? 'milestone' : 'task';
  const name = String(b.name || '').trim() || (kind === 'milestone' ? 'אבן דרך חדשה' : 'משימה חדשה');
  const parentId = b.parent_id == null ? null : int(b.parent_id, null);
  let owner = b.owner_unit_id == null || b.owner_unit_id === '' ? null : int(b.owner_unit_id, null);
  if (owner == null && user.role !== 'admin') owner = user.unit_id;
  if (owner != null || user.role !== 'admin') mustAssign(user, owner);
  return mutate(user, () => {
    let sort = null;
    if (b.after_id != null) { const a = store.tasks.find((t) => t.id === int(b.after_id, 0)); if (a && (a.parent_id ?? null) === parentId) sort = a.sort_order + 5; }
    if (sort == null) sort = Math.max(0, ...store.tasks.filter((t) => t.project_id === projectId && (t.parent_id ?? null) === parentId).map((t) => t.sort_order)) + 10;
    const t = {
      id: ++store.seq.task, project_id: projectId, parent_id: parentId, sort_order: sort, name, kind,
      duration: kind === 'milestone' ? 0 : Math.max(1, int(b.duration, 5)), start_constraint: null, percent: 0, owner: '', notes: '',
      deadline: null, cost: null, baseline_start: null, baseline_finish: null, owner_unit_id: owner,
    };
    store.tasks.push(t);
    renumber(projectId, parentId);
    return { result: t, action: 'create', taskId: t.id, projectId, summary: `נוצרה ${KIND_LABEL[kind]} "${name}"` };
  }).result;
});

on('PATCH', /^\/tasks\/(\d+)$/, (user, b, m) => {
  const id = Number(m[1]);
  const { result, moved } = mutate(user, (before) => {
    const t = store.tasks.find((x) => x.id === id);
    if (!t) throw new HttpError(404, 'המשימה לא נמצאה');
    mustEdit(user, before, id);
    const isSummary = (before.tasks.get(id)?.children || []).length > 0;
    const changes: string[] = [];
    const set = (k: string, v: Any, label: string) => { if (t[k] !== v) { changes.push(label); t[k] = v; } };
    if ('owner_unit_id' in b) { const v = b.owner_unit_id == null || b.owner_unit_id === '' ? null : int(b.owner_unit_id, null); mustAssign(user, v); set('owner_unit_id', v, 'אחראי'); }
    if ('name' in b) { const v = String(b.name || '').trim(); if (!v) throw new HttpError(400, 'חסר שם'); set('name', v, 'שם'); }
    if ('kind' in b) {
      const k = b.kind === 'milestone' ? 'milestone' : 'task';
      set('kind', k, 'סוג');
      if (k === 'milestone') { t.duration = 0; t.deadline = null; } else if ((t.duration | 0) < 1) t.duration = 1;
    }
    if ('duration' in b && !isSummary) set('duration', Math.max(t.kind === 'milestone' ? 0 : 1, int(b.duration, t.duration)), 'משך');
    if ('start_constraint' in b) { if (!isDate(b.start_constraint)) throw new HttpError(400, 'תאריך לא תקין'); set('start_constraint', b.start_constraint || null, 'התחלה'); }
    if ('deadline' in b) { if (!isDate(b.deadline)) throw new HttpError(400, 'תאריך לא תקין'); set('deadline', b.deadline || null, 'תאריך יעד'); }
    if ('percent' in b && !isSummary) set('percent', Math.max(0, Math.min(100, int(b.percent, t.percent))), 'התקדמות');
    if ('notes' in b) set('notes', String(b.notes ?? ''), 'הערות');
    return { result: t, action: 'update', taskId: id, projectId: t.project_id, summary: `"${t.name}": ${changes.join(', ') || 'ללא שינוי'}` };
  });
  return { task: result, moved };
});

on('POST', /^\/tasks\/(\d+)\/move$/, (user, b, m) => {
  const id = Number(m[1]);
  mutate(user, (before) => {
    const t = store.tasks.find((x) => x.id === id);
    if (!t) throw new HttpError(404, 'המשימה לא נמצאה');
    mustEdit(user, before, id, 'להזיז את המשימה הזו');
    const parentId = b.parent_id == null ? null : int(b.parent_id, null);
    if (parentId != null && (parentId === id || before.ancestors(parentId).includes(id))) throw new HttpError(400, 'אי אפשר להכניס משימה לתוך עצמה');
    const projectId = parentId != null ? store.tasks.find((x) => x.id === parentId).project_id : int(b.project_id, t.project_id);
    const newAnc = parentId == null ? [] : [parentId, ...before.ancestors(parentId)];
    const sub = [...subtree(before, id)];
    if (before.validDeps.some((d: Any) => (sub.includes(d.predecessor_id) && newAnc.includes(d.successor_id)) || (sub.includes(d.successor_id) && newAnc.includes(d.predecessor_id))))
      throw new HttpError(400, 'יש תלות בין המשימה לבין אב-המשימה החדשה. מחקו את התלות קודם.');
    const oldParent = t.parent_id ?? null, oldProject = t.project_id;
    const sibs = store.tasks.filter((x) => x.id !== id && x.project_id === projectId && (x.parent_id ?? null) === parentId).sort((a, c) => a.sort_order - c.sort_order);
    const index = Math.max(0, Math.min(sibs.length, int(b.index, sibs.length)));
    sibs.splice(index, 0, t);
    t.parent_id = parentId;
    if (projectId !== oldProject) for (const x of sub) store.tasks.find((y) => y.id === x).project_id = projectId;
    sibs.forEach((x, i) => { x.sort_order = i * 10; });
    if (oldParent !== parentId) renumber(oldProject, oldParent);
    return { action: 'move', taskId: id, projectId, summary: `"${t.name}" הועברה` };
  });
  return { ok: true };
});

on('DELETE', /^\/tasks\/(\d+)$/, (user, _b, m) => {
  const id = Number(m[1]);
  mutate(user, (before) => {
    const t = before.tasks.get(id);
    if (!t) throw new HttpError(404, 'המשימה לא נמצאה');
    mustEdit(user, before, id, 'למחוק את המשימה הזו');
    const gone = subtree(before, id);
    store.tasks = store.tasks.filter((x) => !gone.has(x.id));
    store.deps = store.deps.filter((d) => !gone.has(d.predecessor_id) && !gone.has(d.successor_id));
    renumber(t.project_id, t.parent_id ?? null);
    return { action: 'delete', taskId: id, projectId: t.project_id, summary: `נמחקה "${t.name}"${gone.size > 1 ? ` יחד עם ${gone.size - 1} תתי-משימות` : ''}` };
  });
  return { ok: true };
});

// dependencies (need rights on the task that is affected)
on('POST', /^\/dependencies$/, (user, b) => {
  const p = int(b.predecessor_id, null), s = int(b.successor_id, null);
  const type = DEP_TYPES.includes(b.type) ? b.type : 'FS';
  const lag = Math.max(-500, Math.min(500, int(b.lag, 0)));
  const { result, moved } = mutate(user, (before) => {
    const pt = before.tasks.get(p), st = before.tasks.get(s);
    if (!pt || !st) throw new HttpError(404, 'משימה לא נמצאה');
    mustEdit(user, before, s, 'לקשר אל המשימה הזו (תלות משנה את התאריכים שלה)');
    if (p === s) throw new HttpError(400, 'משימה לא יכולה להיות תלויה בעצמה');
    if (before.ancestors(s).includes(p) || before.ancestors(p).includes(s)) throw new HttpError(400, 'אי אפשר ליצור תלות בין משימה לבין אב-המשימה שלה.');
    if (store.deps.some((d) => (d.predecessor_id === p && d.successor_id === s) || (d.predecessor_id === s && d.successor_id === p))) throw new HttpError(400, 'כבר קיימת תלות בין שתי המשימות האלה');
    const d = { id: ++store.seq.dep, predecessor_id: p, successor_id: s, type, lag };
    store.deps.push(d);
    return { result: d, action: 'create', taskId: s, projectId: st.project_id, summary: `נוספה תלות: "${st.name}" תלויה ב-"${pt.name}" (${DEP_LABEL[type]})` };
  });
  return { dependency: result, moved };
});
on('PATCH', /^\/dependencies\/(\d+)$/, (user, b, m) => {
  const d = store.deps.find((x) => x.id === Number(m[1]));
  if (!d) throw new HttpError(404, 'התלות לא נמצאה');
  const { moved } = mutate(user, (before) => {
    mustEdit(user, before, d.successor_id, 'לשנות את התלות הזו');
    if (DEP_TYPES.includes(b.type)) d.type = b.type;
    if ('lag' in b) d.lag = Math.max(-500, Math.min(500, int(b.lag, d.lag)));
    return { action: 'update', taskId: d.successor_id, summary: `עודכנה תלות (${DEP_LABEL[d.type]} ${d.lag})` };
  });
  return { ok: true, moved };
});
on('DELETE', /^\/dependencies\/(\d+)$/, (user, _b, m) => {
  const id = Number(m[1]);
  const d = store.deps.find((x) => x.id === id);
  if (!d) throw new HttpError(404, 'התלות לא נמצאה');
  const { moved } = mutate(user, (before) => {
    mustEdit(user, before, d.successor_id, 'להסיר את התלות הזו');
    store.deps = store.deps.filter((x) => x.id !== id);
    return { action: 'delete', taskId: d.successor_id, summary: 'הוסרה תלות' };
  });
  return { ok: true, moved };
});

// impact map & what-if
on('GET', /^\/tasks\/(\d+)\/impact$/, (_u, _b, m) => {
  const s = sched();
  const id = Number(m[1]);
  if (!s.tasks.has(id)) throw new HttpError(404, 'המשימה לא נמצאה');
  const g = impactGraph(s, id);
  return { ...g, nodes: g.nodes.map((n: Any) => ({ ...n, path: taskPath(s, n.id) })), ancestors: s.ancestors(id).reverse() };
}, 'viewer');
on('POST', /^\/simulate$/, (_u, b) => {
  const d = data();
  const base = computeSchedule(d);
  const id = int(b.task_id, null);
  if (!base.tasks.has(id)) throw new HttpError(404, 'המשימה לא נמצאה');
  return simulate(d, base, id, b.mode === 'cancel' ? 'cancel' : 'delay', int(b.days, 5));
}, 'viewer');

// history
on('GET', /^\/history$/, (_u, _b, _m, q) => {
  let rows = store.audit;
  if (q.get('task_id')) rows = rows.filter((r) => r.task_id === Number(q.get('task_id')));
  if (q.get('project_id')) rows = rows.filter((r) => r.project_id === Number(q.get('project_id')));
  return rows.slice(0, Number(q.get('limit') || 200));
}, 'viewer');

// calendar
on('GET', /^\/calendar$/, (_u, _b, _m, q) => {
  const year = Number(q.get('year')) || Number(todayISO().slice(0, 4));
  const s = computeSchedule({ ...data(), tasks: [], deps: [] });
  const holidays = holidaysInRange(toDay(`${year}-01-01`), toDay(`${year}-12-31`)).map((h: Any) => ({ ...h, off: !s.cal.isWork(toDay(h.day)) }));
  return { settings: store.calendarSettings, defaults: DEFAULT_CALENDAR, exceptions: store.calendarExceptions, holidays, year };
}, 'viewer');
on('PUT', /^\/calendar$/, (user, b) => {
  needAdmin(user);
  mutate(user, () => {
    store.calendarSettings = { workDays: (b.workDays || []).map(Number), chagOff: !!b.chagOff, independenceOff: !!b.independenceOff, cholHamoedOff: !!b.cholHamoedOff, erevChagOff: !!b.erevChagOff };
    return { action: 'update', summary: 'עודכנו הגדרות לוח העבודה' };
  });
  return { ok: true };
});
on('POST', /^\/calendar\/exceptions$/, (user, b) => {
  needAdmin(user);
  mutate(user, () => {
    store.calendarExceptions = store.calendarExceptions.filter((e) => e.day !== b.day);
    store.calendarExceptions.push({ day: b.day, kind: b.kind === 'work' ? 'work' : 'off', label: String(b.label || '') });
    return { action: 'update', summary: `${b.day} הוגדר כיום ${b.kind === 'work' ? 'עבודה' : 'חופש'}` };
  });
  return { ok: true };
});
on('DELETE', /^\/calendar\/exceptions\/([\d-]+)$/, (user, _b, m) => {
  needAdmin(user);
  mutate(user, () => { store.calendarExceptions = store.calendarExceptions.filter((e) => e.day !== m[1]); return { action: 'delete', summary: 'בוטלה חריגה בלוח העבודה' }; });
  return { ok: true };
});

// organisation units (rename)
on('PATCH', /^\/units\/(\d+)$/, (user, b, m) => {
  needAdmin(user);
  const u = store.units.find((x) => x.id === Number(m[1]));
  if (!u) throw new HttpError(404, 'היחידה לא נמצאה');
  if (b.name != null && String(b.name).trim()) u.name = String(b.name).trim();
  save();
  return { ok: true };
});

/** Entry point used by api.ts in the demo build. */
export async function demoRequest<T>(method: string, url: string, body?: unknown): Promise<T> {
  const [path, qs] = url.split('?');
  const q = new URLSearchParams(qs || '');
  for (const [m, re, h, need] of routes) {
    if (m !== method) continue;
    const match = path.match(re);
    if (!match) continue;
    const user = currentUser();
    if (need !== 'public' && !user) throw Object.assign(new Error('יש להתחבר'), { status: 401 });
    try {
      return clone(h(user, body || {}, match, q)) as T;
    } catch (e) {
      if (e instanceof HttpError) throw Object.assign(new Error(e.message), { status: e.status });
      console.error(e);
      throw Object.assign(new Error('שגיאה בהדגמה'), { status: 500 });
    }
  }
  throw Object.assign(new Error('נתיב לא קיים'), { status: 404 });
}
