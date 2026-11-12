// Organisation structure and edit permissions.
// A unit may edit a task when the task's owner (or, if it has none, the nearest
// parent task's owner) is that unit or a unit below it. The branch (root) edits everything.
import { db } from './db.js';

// Example structure (unit names only). Heads are kept in the data model but not shown.
// The head names are used once, to convert old free-text owners ("יוסי") into units.
const EXAMPLE = {
  name: 'הנהלת הענף', head: '',
  sections: [
    { name: 'מדור תכנון', head: '', teams: [['צוות אפיון', 'דנה'], ['צוות תכנון עבודה', ''], ['צוות דרישות', ''], ['צוות מחקר', ''], ['צוות תיעוד', '']] },
    { name: 'מדור פיתוח', head: '', teams: [['צוות צד שרת', 'יוסי'], ['צוות ממשקים', 'רועי'], ['צוות אפליקציות', 'מיכל']] },
    { name: 'מדור תשתיות', head: '', teams: [['צוות רשתות', ''], ['צוות שרתים', 'אבי']] },
    { name: 'מדור בקרה', head: '', teams: [['צוות בדיקות', 'נועה'], ['צוות איכות', '']] },
    { name: 'מדור הדרכה', head: '', teams: [['צוות פיתוח הדרכה', 'שירה']] },
    { name: 'מדור מבצעים', head: '', teams: [['צוות תפעול', ''], ['צוות לוגיסטיקה', '']] },
  ],
};

/**
 * One-time restructure of an existing example tree to the team counts above
 * (תכנון 5, פיתוח 3, תשתיות 2, בקרה 2, הדרכה 1, מבצעים 2). Removed teams hand their
 * tasks to their section, so nothing loses its owner. Runs once ('units_v2').
 */
export async function restructureUnits() {
  if ((await db.query("SELECT 1 FROM settings WHERE key='units_v2'")).length) return null;
  const log = [];
  await db.tx(async (tx) => {
    const units = await tx.query('SELECT * FROM units');
    const byName = (n) => units.find((u) => u.name === n);
    for (const sec of EXAMPLE.sections) {
      const s = byName(sec.name);
      if (!s) continue;
      const teams = units.filter((u) => u.parent_id === s.id);
      const wanted = sec.teams.map(([n]) => n);
      for (const t of teams) {
        if (wanted.includes(t.name)) continue;
        await tx.query('UPDATE tasks SET owner_unit_id=$1 WHERE owner_unit_id=$2', [s.id, t.id]);
        await tx.query('DELETE FROM units WHERE id=$1', [t.id]);
        log.push(`removed ${t.name}`);
      }
      let so = teams.length;
      for (const n of wanted) {
        if (teams.some((t) => t.name === n)) continue;
        await tx.query('INSERT INTO units (parent_id, kind, name, head, sort_order) VALUES ($1,$2,$3,$4,$5)', [s.id, 'team', n, '', so++]);
        log.push(`added ${n}`);
      }
    }
    // role-holder names are no longer used anywhere (owners were already converted)
    await tx.query("UPDATE units SET head=''");
    await tx.query(`INSERT INTO settings (key, value) VALUES ('units_v2', 'true') ON CONFLICT (key) DO NOTHING`);
  });
  return log;
}

/** Create the example structure when there are no units yet. */
export async function ensureUnits() {
  const n = (await db.query('SELECT count(*)::int AS n FROM units'))[0].n;
  if (n > 0) return false;
  await db.tx(async (tx) => {
    const ins = async (parent, kind, name, head, so) =>
      (await tx.query('INSERT INTO units (parent_id, kind, name, head, sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING id', [parent, kind, name, head, so]))[0].id;
    const root = await ins(null, 'branch', EXAMPLE.name, EXAMPLE.head, 0);
    let s = 0;
    for (const sec of EXAMPLE.sections) {
      const sid = await ins(root, 'section', sec.name, sec.head, s++);
      let t = 0;
      for (const [name, head] of sec.teams) await ins(sid, 'team', name, head, t++);
    }
    await tx.query(`INSERT INTO settings (key, value) VALUES ('units_v2', 'true') ON CONFLICT (key) DO NOTHING`);
  });
  return true;
}

/**
 * One-time conversion of the old free-text "owner" into a unit:
 * a name is matched to the unit whose head has that first name. Phases of the demo plan
 * are handed to the matching section. Runs once (settings key 'owners_migrated').
 */
export async function migrateOwners() {
  const done = (await db.query("SELECT 1 FROM settings WHERE key='owners_migrated'")).length;
  if (done) return 0;
  const units = await db.query('SELECT * FROM units');
  const byFirst = new Map();
  for (const u of units) {
    const first = u.head.split(' ')[0];
    if (first && !byFirst.has(first)) byFirst.set(first, u.id);
  }
  const PHASES = {
    'אפיון': 'מדור תכנון', 'פיתוח': 'מדור פיתוח', 'בדיקות': 'מדור בקרה', 'הטמעה': 'מדור מבצעים',
    'הכנת חומרי הדרכה': 'מדור הדרכה', 'ביצוע הדרכות': 'מדור הדרכה',
  };
  const byName = new Map(units.map((u) => [u.name, u.id]));
  let n = 0;
  await db.tx(async (tx) => {
    const tasks = await tx.query('SELECT id, name, owner FROM tasks WHERE owner_unit_id IS NULL');
    for (const t of tasks) {
      const first = String(t.owner || '').trim().split(' ')[0];
      const uid = (first && byFirst.get(first)) || (PHASES[t.name] && byName.get(PHASES[t.name])) || null;
      if (uid) { await tx.query('UPDATE tasks SET owner_unit_id=$1 WHERE id=$2', [uid, t.id]); n++; }
    }
    // undo history from before the switch belongs to the old user accounts
    await tx.query('DELETE FROM undo_stack');
    await tx.query(`INSERT INTO settings (key, value) VALUES ('owners_migrated', 'true') ON CONFLICT (key) DO NOTHING`);
  });
  return n;
}

export async function loadUnits(q = db) {
  return q.query('SELECT * FROM units ORDER BY sort_order, id');
}

/** is unit a inside unit b's subtree (or equal)? */
export function isWithin(units, a, b) {
  if (a == null || b == null) return false;
  const parent = new Map(units.map((u) => [u.id, u.parent_id]));
  let x = a;
  for (let i = 0; i < 50 && x != null; i++) {
    if (x === b) return true;
    x = parent.get(x) ?? null;
  }
  return false;
}

/** owner of the task, or of its nearest parent that has one */
export function effectiveOwner(sched, taskId) {
  let id = taskId;
  for (let i = 0; i < 100 && id != null; i++) {
    const t = sched.tasks.get(id);
    if (!t) return null;
    if (t.owner_unit_id != null) return t.owner_unit_id;
    id = t.parent_id;
  }
  return null;
}

export function canEditTask(user, units, sched, taskId) {
  if (!user) return false;
  if (user.role === 'admin' || (user.role === 'editor' && user.edit_all)) return true;
  if (user.role !== 'editor' || !user.unit_id) return false;
  return isWithin(units, effectiveOwner(sched, taskId), user.unit_id);
}

/** One-time move of the old single-day exceptions into special_days (1.5.0). */
export async function migrateSpecialDays() {
  if ((await db.query("SELECT 1 FROM settings WHERE key='special_days_v1'")).length) return 0;
  let n = 0;
  await db.tx(async (tx) => {
    const old = await tx.query('SELECT * FROM calendar_exceptions ORDER BY day');
    for (const e of old) {
      await tx.query('INSERT INTO special_days (unit_id, start_day, end_day, kind, label) VALUES (NULL,$1,$1,$2,$3)', [e.day, e.kind, e.label || '']);
      n++;
    }
    await tx.query(`INSERT INTO settings (key, value) VALUES ('special_days_v1', 'true') ON CONFLICT (key) DO NOTHING`);
  });
  return n;
}

/** kind of a unit by its depth: root = branch, depth 1 = section, deeper = team */
export const kindAtDepth = (depth) => (depth === 0 ? 'branch' : depth === 1 ? 'section' : 'team');
export function unitDepth(units, id) {
  const parent = new Map(units.map((u) => [u.id, u.parent_id]));
  let d = 0;
  for (let x = parent.get(id) ?? null; x != null && d < 50; x = parent.get(x) ?? null) d++;
  return d;
}
export function unitSubtree(units, id) {
  const out = new Set([id]);
  let grew = true;
  while (grew) { grew = false; for (const u of units) if (u.parent_id != null && out.has(u.parent_id) && !out.has(u.id)) { out.add(u.id); grew = true; } }
  return out;
}
