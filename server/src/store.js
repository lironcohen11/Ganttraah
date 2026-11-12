// Loading data, running mutations inside a transaction, audit log, and change broadcast.
import { db, isoDate } from './db.js';
import { computeSchedule, diffSchedules } from './scheduler.js';
import { DEFAULT_CALENDAR, expandRanges } from './calendar.js';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function todayISO() {
  if (process.env.GANTRAAH_TODAY) return process.env.GANTRAAH_TODAY; // for demos / tests
  return new Intl.DateTimeFormat('en-CA', { timeZone: process.env.TZ_NAME || 'Asia/Jerusalem' }).format(new Date());
}

export async function loadAll(q = db) {
  const projects = (await q.query('SELECT * FROM projects ORDER BY sort_order, id')).map((p) => ({
    ...p, start_date: isoDate(p.start_date),
  }));
  const tasks = (await q.query('SELECT * FROM tasks ORDER BY project_id, sort_order, id')).map((t) => ({
    ...t,
    start_constraint: isoDate(t.start_constraint),
    deadline: isoDate(t.deadline),
    baseline_start: isoDate(t.baseline_start),
    baseline_finish: isoDate(t.baseline_finish),
    cost: t.cost == null ? null : Number(t.cost),
  }));
  const deps = await q.query('SELECT * FROM dependencies ORDER BY id');
  const calRow = (await q.query("SELECT value FROM settings WHERE key = 'calendar'"))[0];
  const specialDays = (await q.query('SELECT * FROM special_days ORDER BY start_day, id')).map((e) => ({
    ...e, start_day: isoDate(e.start_day), end_day: isoDate(e.end_day),
  }));
  const units = await q.query('SELECT id, parent_id FROM units');
  return {
    projects, tasks, deps,
    // the working week is fixed: Sunday to Thursday
    calendarSettings: { ...DEFAULT_CALENDAR, ...(calRow?.value || {}), workDays: DEFAULT_CALENDAR.workDays },
    // global special days feed the shared calendar; unit special days are applied per task
    calendarExceptions: expandRanges(specialDays.filter((r) => r.unit_id == null)),
    specialDays,
    units,
    today: todayISO(),
  };
}

export async function currentSchedule() {
  const data = await loadAll();
  return { data, sched: computeSchedule(data) };
}

// ---- change listeners (WebSocket broadcast is registered in index.js)
const listeners = new Set();
export const onChange = (fn) => listeners.add(fn);
const emit = (msg) => { for (const fn of listeners) { try { fn(msg); } catch { /* ignore */ } } };

/**
 * Run a mutation. fn(tx, before) must return { audit, result }.
 * The schedule is recomputed before and after, so the audit log records which
 * other tasks moved because of this change.
 */
export async function mutate(user, fn) {
  const out = await db.tx(async (tx) => {
    const beforeData = await loadAll(tx);
    const before = computeSchedule(beforeData);
    const { audit, result } = (await fn(tx, before)) || {};
    const after = computeSchedule(await loadAll(tx));
    if (after.cycle) throw new HttpError(400, 'השינוי יוצר תלות מעגלית (משימה שתלויה בעצמה דרך שרשרת), ולכן לא נשמר.');
    const moved = diffSchedules(before, after, audit?.task_id);
    if (audit) {
      let summary = audit.summary;
      if (moved.length) summary += ` · ${moved.length === 1 ? 'משימה אחת זזה' : `${moved.length} משימות זזו`} בעקבות השינוי`;
      await tx.query(
        `INSERT INTO audit_log (user_id, user_name, entity, entity_id, project_id, task_id, action, summary, details)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [user?.id ?? null, user?.display_name ?? 'מערכת', audit.entity, audit.entity_id ?? null,
          audit.project_id ?? null, audit.task_id ?? null, audit.action, summary,
          JSON.stringify({ ...(audit.details || {}), moved: moved.slice(0, 200) })],
      );
      audit.fullSummary = summary;
    }
    // undo support: remember the plan as it was before this change
    const rev = await bumpRev(tx);
    if (user?.id && audit) {
      await tx.query('INSERT INTO undo_stack (user_id, kind, label, rev, data) VALUES ($1,$2,$3,$4,$5)',
        [user.id, 'undo', audit.summary, rev, JSON.stringify(snapshotOf(beforeData))]);
      await tx.query("DELETE FROM undo_stack WHERE kind='redo'");
      await tx.query(`DELETE FROM undo_stack WHERE user_id=$1 AND kind='undo' AND id NOT IN
        (SELECT id FROM undo_stack WHERE user_id=$1 AND kind='undo' ORDER BY id DESC LIMIT ${UNDO_DEPTH})`, [user.id]);
    }
    return { result, moved, audit };
  });
  emit({ type: 'changed', by: user?.display_name || '', summary: out.audit?.fullSummary || '', moved: out.moved.length });
  return out;
}

// ------------------------------------------------------------------ undo / redo
// Each change stores a snapshot of the plan from before it. Undo restores that snapshot.
// An entry can be used only if nobody changed the plan since (its rev == current rev),
// so one user's undo never wipes out another user's later work.
const UNDO_DEPTH = 40;

const snapshotOf = (d) => ({
  projects: d.projects, tasks: d.tasks, deps: d.deps,
  calendarSettings: d.calendarSettings, specialDays: d.specialDays,
});

async function getRev(tx) {
  const r = (await tx.query("SELECT value FROM settings WHERE key='rev'"))[0];
  return Number(r?.value ?? 0);
}
async function bumpRev(tx) {
  const n = (await getRev(tx)) + 1;
  await tx.query(`INSERT INTO settings (key, value) VALUES ('rev', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(n)]);
  return n;
}

async function insertRow(tx, table, row) {
  const cols = Object.keys(row);
  await tx.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
    cols.map((c) => row[c]));
}

async function restoreSnapshot(tx, s) {
  await tx.query('DELETE FROM dependencies');
  await tx.query('DELETE FROM tasks');
  await tx.query('DELETE FROM projects');
  for (const p of s.projects) await insertRow(tx, 'projects', p);
  // a unit may have been deleted since the snapshot: its tasks go back to "no owner"
  const unitIds = new Set((await tx.query('SELECT id FROM units')).map((u) => u.id));
  const ownerOk = (u) => (u == null || unitIds.has(u) ? u : null);
  for (const t of s.tasks) await insertRow(tx, 'tasks', { ...t, parent_id: null, owner_unit_id: ownerOk(t.owner_unit_id ?? null) });
  for (const t of s.tasks) if (t.parent_id != null) await tx.query('UPDATE tasks SET parent_id=$1 WHERE id=$2', [t.parent_id, t.id]);
  for (const d of s.deps) await insertRow(tx, 'dependencies', d);
  await tx.query(`INSERT INTO settings (key, value) VALUES ('calendar', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(s.calendarSettings)]);
  if (s.specialDays) { // snapshots from before 1.5.0 have no special days: leave them as they are
    await tx.query('DELETE FROM special_days');
    for (const e of s.specialDays) if (e.unit_id == null || unitIds.has(e.unit_id)) await insertRow(tx, 'special_days', e);
  }
  for (const t of ['projects', 'tasks', 'dependencies', 'special_days']) {
    await tx.query(`SELECT setval(pg_get_serial_sequence('${t}','id'), (SELECT COALESCE(MAX(id),0)+1 FROM ${t}), false)`);
  }
}

export async function undoState(user) {
  if (!user?.id) return { undo: null, redo: null };
  const rev = await getRev(db);
  const top = async (kind) => {
    const e = (await db.query('SELECT id, label, rev FROM undo_stack WHERE user_id=$1 AND kind=$2 ORDER BY id DESC LIMIT 1', [user.id, kind]))[0];
    return e ? { label: e.label, blocked: e.rev !== rev } : null;
  };
  return { undo: await top('undo'), redo: await top('redo') };
}

/** kind: 'undo' | 'redo' */
export async function undoRedo(user, kind) {
  const other = kind === 'undo' ? 'redo' : 'undo';
  const verb = kind === 'undo' ? 'לבטל' : 'לבצע שוב';
  const out = await db.tx(async (tx) => {
    const rev = await getRev(tx);
    const top = (await tx.query('SELECT * FROM undo_stack WHERE user_id=$1 AND kind=$2 ORDER BY id DESC LIMIT 1', [user.id, kind]))[0];
    if (!top) throw new HttpError(400, kind === 'undo' ? 'אין שינוי לבטל' : 'אין שינוי לבצע שוב');
    if (top.rev !== rev) {
      const last = (await tx.query('SELECT user_name FROM audit_log ORDER BY id DESC LIMIT 1'))[0];
      throw new HttpError(409, `אי אפשר ${verb}: ${last?.user_name || 'משתמש אחר'} שינה את התוכנית בינתיים.`);
    }
    const currentData = await loadAll(tx);
    const before = computeSchedule(currentData);
    const data = typeof top.data === 'string' ? JSON.parse(top.data) : top.data;
    await restoreSnapshot(tx, data);
    const after = computeSchedule(await loadAll(tx));
    const moved = diffSchedules(before, after, null);
    await tx.query('DELETE FROM undo_stack WHERE id=$1', [top.id]);
    const newRev = await bumpRev(tx);
    await tx.query('INSERT INTO undo_stack (user_id, kind, label, rev, data) VALUES ($1,$2,$3,$4,$5)',
      [user.id, other, top.label, newRev, JSON.stringify(snapshotOf(currentData))]);
    // the next entry in this user's stack now continues from the new revision
    await tx.query(`UPDATE undo_stack SET rev=$1 WHERE id = (SELECT id FROM undo_stack WHERE user_id=$2 AND kind=$3 ORDER BY id DESC LIMIT 1)`,
      [newRev, user.id, kind]);
    const summary = `${kind === 'undo' ? 'בוטל' : 'בוצע שוב'}: ${top.label}`;
    await tx.query(`INSERT INTO audit_log (user_id, user_name, entity, action, summary, details) VALUES ($1,$2,'plan',$3,$4,$5)`,
      [user.id, user.display_name, kind, summary, JSON.stringify({ moved: moved.slice(0, 200) })]);
    return { summary, moved };
  });
  emit({ type: 'changed', by: user.display_name, summary: out.summary, moved: out.moved.length });
  return out;
}

export async function audit(user, entry) {
  await db.query(
    `INSERT INTO audit_log (user_id, user_name, entity, entity_id, project_id, task_id, action, summary, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [user?.id ?? null, user?.display_name ?? 'מערכת', entry.entity, entry.entity_id ?? null, entry.project_id ?? null,
      entry.task_id ?? null, entry.action, entry.summary, JSON.stringify(entry.details || {})],
  );
}
export const broadcast = emit;

// History is kept for one year. Older entries are deleted at start-up and once a day,
// and VACUUM lets the database reuse the space, so the file stops growing.
export const HISTORY_DAYS = Math.max(30, Number(process.env.HISTORY_DAYS) || 365);
export async function pruneHistory() {
  const gone = await db.query(`DELETE FROM audit_log WHERE at < now() - make_interval(days => ${HISTORY_DAYS}) RETURNING id`);
  if (gone.length) await db.exec('VACUUM audit_log');
  return gone.length;
}
