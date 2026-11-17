// Loading data, running mutations inside a transaction, audit log, and change broadcast.
import { db, isoDate } from './db.js';
import { computeSchedule, diffSchedules } from './scheduler.js';
import { DEFAULT_CALENDAR, expandRanges } from './calendar.js';

export class HttpError extends Error {
  /** data: extra fields sent with the error (e.g. what the client needs to ask the user) */
  constructor(status, message, data) { super(message); this.status = status; this.data = data; }
}

/** why a task was postponed (the list is fixed; "other" comes with a free text) */
export const DELAY_REASONS = {
  tech_debt: 'חוב טכני', fault: 'תקלה', product: 'מוצרי', staffing: 'אילוצי כוח-אדם',
  pricing: 'תמחור לקוי', external: 'תלות בגורם חיצוני', other: 'אחר',
};
export const delayLabel = (r, other) => (r === 'other' ? (other ? `אחר: ${other}` : 'אחר') : DELAY_REASONS[r] || '');

export function todayISO() {
  if (process.env.GANTRAAH_TODAY) return process.env.GANTRAAH_TODAY; // for demos / tests
  return new Intl.DateTimeFormat('en-CA', { timeZone: process.env.TZ_NAME || 'Asia/Jerusalem' }).format(new Date());
}

export async function loadAll(q = db) {
  const projects = (await q.query('SELECT * FROM projects ORDER BY sort_order, id')).map((p) => ({
    ...p, start_date: isoDate(p.start_date), target_finish: isoDate(p.target_finish),
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
  // the task pool: tasks without a date, kept apart from the plan (not scheduled)
  const backlog = await q.query('SELECT id, name, notes, project_id, owner_unit_id, duration, sort_order FROM backlog ORDER BY sort_order, id');
  // the latest postponement of every task (for the tooltip and the task card)
  const delays = (await q.query(`SELECT DISTINCT ON (task_id) id, at, task_id, unit_id, user_name, reason, reason_other, description, cause_task_id, from_finish, to_finish
    FROM task_delays ORDER BY task_id, id DESC`)).map((x) => ({ ...x, from_finish: isoDate(x.from_finish), to_finish: isoDate(x.to_finish) }));
  // asking why a task is postponed: on unless branch management turned it off
  const reasonsRow = (await q.query("SELECT value FROM settings WHERE key = 'delay_reasons'"))[0];
  return {
    delays,
    delayReasons: reasonsRow ? reasonsRow.value !== false : true,
    projects, tasks, deps,
    // the working week is fixed: Sunday to Thursday
    calendarSettings: { ...DEFAULT_CALENDAR, ...(calRow?.value || {}), workDays: DEFAULT_CALENDAR.workDays },
    // global special days feed the shared calendar; unit special days are applied per task
    calendarExceptions: expandRanges(specialDays.filter((r) => r.unit_id == null)),
    specialDays,
    units,
    backlog,
    today: todayISO(),
  };
}

/**
 * The plan as computed now. Computing it means reading everything and scheduling every task, so it
 * is kept until the next change: every change announces itself through emit(), which drops it.
 * When many screens reload together after a change, they share one computation instead of each
 * doing its own. (A computation that started before a change is not kept.)
 * Callers must treat the result as read-only.
 */
let planCache = null;
let planGen = 0;
export async function currentSchedule() {
  const today = todayISO();
  if (planCache && planCache.today === today) return planCache;
  const gen = planGen;
  const data = await loadAll();
  const out = { today, data, sched: computeSchedule(data), extra: {} };
  if (gen === planGen) planCache = out;
  return out;
}
const dropPlan = () => { planGen++; planCache = null; };

// ---- change listeners (WebSocket broadcast is registered in index.js)
const listeners = new Set();
export const onChange = (fn) => listeners.add(fn);
const emit = (msg) => { dropPlan(); for (const fn of listeners) { try { fn(msg); } catch { /* ignore */ } } };

/**
 * Run a mutation. fn(tx, before) must return { audit, result }.
 * The schedule is recomputed before and after, so the audit log records which
 * other tasks moved because of this change.
 */
/**
 * Updates for the bell: a change by one unit moved the dates of another unit's tasks (through a
 * dependency, a holiday, a deleted link...). One row per unit that was affected, naming its first
 * moved task, the task that was changed (when there is one), and how many of its tasks moved.
 * The unit that made the change is not told. Summary tasks only follow their children: skipped.
 */
function movedNotices(user, before, after, moved, audit) {
  const ownerOf = (id) => { for (let x = after.tasks.get(id), i = 0; x && i < 100; x = after.tasks.get(x.parent_id), i++) if (x.owner_unit_id != null) return x.owner_unit_id; return null; };
  const per = new Map();
  for (const m of moved) {
    const t = after.tasks.get(m.id);
    if (!t || t.children?.length) continue;
    const u = ownerOf(m.id);
    if (u == null || u === user?.unit_id) continue;
    const row = per.get(u);
    if (row) row.n++;
    else per.set(u, { first: m, n: 1 });
  }
  const causeId = audit?.task_id ?? null;
  const cause = causeId != null ? (after.tasks.get(causeId) || before.tasks.get(causeId)) : null;
  return [...per].map(([unit, { first, n }]) => ({
    unit, task_id: first.id, name: first.name, cause_id: cause ? causeId : null, cause: cause?.name || '',
    detail: JSON.stringify({ n, from: first.from, to: first.to, why: cause ? '' : String(audit?.summary || '').slice(0, 140) }),
  }));
}

export async function mutate(user, fn) {
  const out = await db.tx(async (tx) => {
    const beforeData = await loadAll(tx);
    const before = computeSchedule(beforeData);
    const { audit, result, delayCheck, delay } = (await fn(tx, before)) || {};
    const after = computeSchedule(await loadAll(tx));
    if (after.cycle) throw new HttpError(400, 'השינוי יוצר תלות מעגלית (משימה שתלויה בעצמה דרך שרשרת), ולכן לא נשמר.');
    const moved = diffSchedules(before, after, audit?.task_id);
    // postponing a task that has an original plan (baseline) needs a reason: before an original plan
    // is saved, dates change freely. The tasks with an original plan that move later because of it
    // are recorded too, pointing at it. Branch management can turn the whole thing off.
    const delays = [];
    const reasonsOn = beforeData.delayReasons !== false;
    if (reasonsOn && audit?.task_id != null) {
      const id = audit.task_id, tb = before.tasks.get(id), ta = after.tasks.get(id);
      // within the task's free slack nothing else moves and its project ends on the same day: no question
      const pid = ta?.project_id;
      const affects = moved.some((m) => { const t = after.tasks.get(m.id); return t && !t.children?.length && m.to.finish > m.from.finish; })
        || (pid != null && (after.projects.get(pid)?.finish || '') > (before.projects.get(pid)?.finish || ''));
      const later = !!(tb && ta && !ta.children?.length && ta.finish > tb.finish && tb.baseline_finish && affects);
      if (delayCheck && later && !delay) {
        // what the plan would look like: shown behind the question, dropped if the user cancels
        const pv = (x) => ({ id: x.id, start: x.start, finish: x.finish, duration: x.duration, work_days: x.work_days });
        const preview = [pv(ta), ...moved.slice(0, 500).map((m) => pv(after.tasks.get(m.id)))];
        throw new HttpError(409, 'דחיית מועד הסיום דורשת סיבה.', { need_reason: true, task_id: id, name: ta.name, kind: ta.kind, from: tb.finish, to: ta.finish, preview });
      }
      const own = later && delay ? delay : null;
      if (own) {
        delays.push({ task_id: id, reason: own.reason, reason_other: own.reason_other, description: own.description, cause_task_id: null, from: tb.finish, to: ta.finish });
        audit.summary += ` · סיבת הדחייה: ${delayLabel(own.reason, own.reason_other)}`;
      }
      for (const m of moved) {
        const t = after.tasks.get(m.id);
        if (!t || t.children?.length || !t.baseline_finish || !(m.to.finish > m.from.finish)) continue;
        delays.push({ task_id: m.id, reason: own?.reason ?? null, reason_other: own?.reason_other ?? '', description: '', cause_task_id: id, from: m.from.finish, to: m.to.finish });
      }
    }
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
    const notices = movedNotices(user, before, after, moved, audit);
    for (const x of notices) {
      await tx.query(`INSERT INTO notifications (unit_id, actor_unit_id, actor_name, kind, task_id, pred_id, succ_id, pred_name, succ_name, detail)
        VALUES ($1,$2,$3,'moved',$4,$5,$4,$6,$7,$8)`,
        [x.unit, user?.unit_id ?? null, user?.display_name ?? 'מערכת', x.task_id, x.cause_id, x.cause, x.name, x.detail]);
    }
    // undo support: remember the plan as it was before this change
    const rev = await bumpRev(tx);
    for (const x of delays) {
      await tx.query(`INSERT INTO task_delays (rev, task_id, unit_id, user_name, reason, reason_other, description, cause_task_id, from_finish, to_finish)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [rev, x.task_id, user?.unit_id ?? null, user?.display_name ?? 'מערכת', x.reason, x.reason_other || '', x.description || '', x.cause_task_id, x.from, x.to]);
    }
    if (user?.id && audit) {
      await tx.query('INSERT INTO undo_stack (user_id, kind, label, rev, data) VALUES ($1,$2,$3,$4,$5)',
        [user.id, 'undo', audit.summary, rev, JSON.stringify(snapshotOf(beforeData))]);
      await tx.query("DELETE FROM undo_stack WHERE kind='redo'");
      await tx.query(`DELETE FROM undo_stack WHERE user_id=$1 AND kind='undo' AND id NOT IN
        (SELECT id FROM undo_stack WHERE user_id=$1 AND kind='undo' ORDER BY id DESC LIMIT ${UNDO_DEPTH})`, [user.id]);
    }
    return { result, moved, audit, notified: notices.map((x) => x.unit) };
  });
  emit({ type: 'changed', by: user?.display_name || '', client: user?.client || '', task_id: out.audit?.task_id ?? null, summary: out.audit?.fullSummary || '', moved: out.moved.length });
  if (out.notified.length) emit({ type: 'notify', units: out.notified });
  return out;
}

// ------------------------------------------------------------------ undo / redo
// Each change stores a snapshot of the plan from before it. Undo restores that snapshot.
// An entry can be used only if nobody changed the plan since (its rev == current rev),
// so one user's undo never wipes out another user's later work.
const UNDO_DEPTH = 20;

const snapshotOf = (d) => ({
  projects: d.projects, tasks: d.tasks, deps: d.deps,
  calendarSettings: d.calendarSettings, specialDays: d.specialDays, backlog: d.backlog,
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

/**
 * Insert many rows in one statement (a plan of thousands of tasks restored row by row took seconds).
 * Only the columns the rows carry are written; Postgres checks the links (a task's parent) at the end
 * of the statement, so parents and children can come in any order.
 */
async function insertRows(tx, table, rows) {
  if (!rows.length) return;
  const have = new Set((await tx.query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [table])).map((r) => r.column_name));
  const cols = Object.keys(rows[0]).filter((c) => have.has(c));
  const list = cols.map((c) => `"${c}"`).join(',');
  await tx.query(`INSERT INTO ${table} (${list}) SELECT ${list} FROM json_populate_recordset(NULL::${table}, $1::json)`, [JSON.stringify(rows)]);
}

/** tasks with their parent before them (so the order never matters, whatever the database checks when) */
function parentsFirst(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out = [], seen = new Set();
  const add = (t) => { if (seen.has(t.id)) return; seen.add(t.id); const p = t.parent_id != null ? byId.get(t.parent_id) : null; if (p) add(p); out.push(t); };
  tasks.forEach(add);
  return out;
}

async function restoreSnapshot(tx, s) {
  // the task pool goes back too; a snapshot from before it existed keeps the pool as it is now
  // (deleting the projects below would otherwise drop the pool's links to them)
  const pool = s.backlog ?? await tx.query('SELECT id, name, notes, project_id, owner_unit_id, duration, sort_order FROM backlog');
  await tx.query('DELETE FROM backlog');
  await tx.query('DELETE FROM dependencies');
  await tx.query('DELETE FROM tasks');
  await tx.query('DELETE FROM projects');
  await insertRows(tx, 'projects', s.projects);
  // a unit may have been deleted since the snapshot: its tasks go back to "no owner"
  const unitIds = new Set((await tx.query('SELECT id FROM units')).map((u) => u.id));
  const ownerOk = (u) => (u == null || unitIds.has(u) ? u : null);
  const ids = new Set(s.tasks.map((t) => t.id));
  await insertRows(tx, 'tasks', parentsFirst(s.tasks).map((t) => ({ ...t, parent_id: t.parent_id != null && ids.has(t.parent_id) ? t.parent_id : null, owner_unit_id: ownerOk(t.owner_unit_id ?? null) })));
  await insertRows(tx, 'dependencies', s.deps.filter((d) => ids.has(d.predecessor_id) && ids.has(d.successor_id)));
  await tx.query(`INSERT INTO settings (key, value) VALUES ('calendar', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(s.calendarSettings)]);
  if (s.specialDays) { // snapshots from before 1.5.0 have no special days: leave them as they are
    await tx.query('DELETE FROM special_days');
    await insertRows(tx, 'special_days', s.specialDays.filter((e) => e.unit_id == null || unitIds.has(e.unit_id)));
  }
  const projIds = new Set(s.projects.map((p) => p.id));
  await insertRows(tx, 'backlog', pool.map((b) => ({ ...b, project_id: b.project_id != null && projIds.has(b.project_id) ? b.project_id : null, owner_unit_id: ownerOk(b.owner_unit_id ?? null) })));
  for (const t of ['projects', 'tasks', 'dependencies', 'special_days', 'backlog']) {
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
    // the postponements written by the change being undone go with it (same transaction time as its undo entry;
    // any later change was undone first, since undo needs an unchanged plan)
    if (kind === 'undo' && top.created_at) await tx.query('DELETE FROM task_delays WHERE at >= $1', [top.created_at]);
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
  emit({ type: 'changed', by: user.display_name, client: user.client || '', task_id: null, summary: out.summary, moved: out.moved.length });
  return out;
}

/**
 * Housekeeping, at start and every night. The embedded database runs no background workers, so
 * nothing else cleans up: space left by replaced rows (every change rewrites an undo snapshot) is
 * reclaimed by VACUUM, and the change journal is trimmed by CHECKPOINT (old rows are deleted by
 * pruneHistory, once a day). Takes about a second; requests wait.
 */
export async function maintenance() {
  const t0 = Date.now();
  try {
    await db.exec('VACUUM');
    await db.exec('CHECKPOINT');
    console.log(`[gantraah] maintenance: space reclaimed (${Date.now() - t0}ms)`);
  } catch (e) { console.error('[gantraah] maintenance failed:', e.message); }
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
  // in a plan that runs for years these would only pile up: updates in the bell are kept half a
  // year, and undo steps two weeks (nobody undoes a change from last month)
  const notes = await db.query(`DELETE FROM notifications WHERE at < now() - interval '180 days' RETURNING id`);
  const undos = await db.query(`DELETE FROM undo_stack WHERE created_at < now() - interval '14 days' RETURNING id`);
  if (notes.length || undos.length) console.log(`[gantraah] cleanup: ${notes.length} old updates, ${undos.length} old undo steps`);
  return gone.length;
}
