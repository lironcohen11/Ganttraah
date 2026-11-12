// Demo backend: the whole API running inside the browser, for the single-file demo
// (Ganttraah-demo.html). The scheduling engine, Hebrew calendar and impact map are the
// real server modules, imported as-is; data lives in this browser only (localStorage).
// @ts-ignore - plain JS module shared with the server
import { computeSchedule, diffSchedules, DEP_TYPES } from '../../../server/src/scheduler.js';
// @ts-ignore
import { toDay, fromDay, holidaysInRange, DEFAULT_CALENDAR, expandRanges } from '../../../server/src/calendar.js';
// @ts-ignore
import { impactGraph, simulate, taskPath } from '../../../server/src/impact.js';
import seed from './seed.json';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

const KEY = 'gantraah.demo.v1';
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

interface Core { projects: Any[]; tasks: Any[]; deps: Any[]; calendarSettings: Any; specialDays: Any[] }
interface Store extends Core {
  units: Any[]; audit: Any[]; seq: Record<string, number>; favorites: Record<string, number[]>; adminPassword?: string;
  undo: { label: string; core: Core }[]; redo: { label: string; core: Core }[];
}

function fresh(): Store {
  const s = clone(seed) as Any;
  const max = (l: Any[]) => l.reduce((m, x) => Math.max(m, x.id), 0);
  return {
    projects: s.projects, tasks: s.tasks, deps: s.deps, units: s.units.map((u: Any) => ({ ...u, edit_all: false })),
    calendarSettings: { ...DEFAULT_CALENDAR }, specialDays: [], favorites: {},
    audit: [{ id: 1, at: new Date().toISOString(), user_name: 'מערכת', entity: 'plan', action: 'create', summary: 'נטענו נתוני ההדגמה', details: {} }],
    seq: { project: max(s.projects), task: max(s.tasks), dep: max(s.deps), audit: 1, unit: max(s.units), special: 0 },
    undo: [], redo: [],
  };
}
let store: Store = (() => {
  try {
    const v = localStorage.getItem(KEY);
    if (v) {
      const st = JSON.parse(v);
      // a demo saved by an older version: single-day exceptions become special days
      if (!st.specialDays) {
        st.specialDays = (st.calendarExceptions || []).map((e: Any, i: number) => ({ id: i + 1, unit_id: null, start_day: e.day, end_day: e.day, kind: e.kind, label: e.label || '' }));
        delete st.calendarExceptions;
      }
      st.favorites = st.favorites || {};
      st.seq.unit = st.seq.unit || st.units.reduce((m: number, u: Any) => Math.max(m, u.id), 0);
      st.seq.special = st.seq.special || st.specialDays.length;
      return st;
    }
  } catch { /* ignore */ }
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
  return { id: u.id, unit_id: u.id, username: `unit-${u.id}`, display_name: u.name, head: '', kind: u.kind, role: u.parent_id == null ? 'admin' : 'editor', active: true, edit_all: !!u.edit_all };
}

// ---- schedule helpers
const todayISO = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
const data = () => ({
  ...store, today: todayISO(),
  calendarSettings: { ...store.calendarSettings, workDays: DEFAULT_CALENDAR.workDays },
  calendarExceptions: expandRanges(store.specialDays.filter((r) => r.unit_id == null)),
});
const sched = () => computeSchedule(data());
const core = (): Core => clone({ projects: store.projects, tasks: store.tasks, deps: store.deps, calendarSettings: store.calendarSettings, specialDays: store.specialDays });
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
  if (user.role === 'admin' || user.edit_all) return;
  const o = effOwner(s, taskId);
  if (o != null && isWithin(o, user.unit_id)) return;
  const name = store.units.find((u) => u.id === o)?.name;
  throw new HttpError(403, `אין לך הרשאה ${what}${name ? `: היא באחריות "${name}"` : ': רק הנהלת הענף יכולה'}.`);
}
function mustAssign(user: Any, ownerId: number | null) {
  if (user.role === 'admin') return;
  if (user.edit_all && ownerId != null) return;
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
  if (u.parent_id == null && String(b.password ?? '') !== (store.adminPassword || 'ליורד')) throw new HttpError(403, 'הסיסמה שגויה');
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
    unitDays: store.specialDays.filter((r) => r.unit_id != null && r.kind !== 'work'),
    favorites: ((store.favorites[String(getUnitId())] || []) as number[]).filter((id) => s.tasks.has(id)),
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
    const pr = store.projects.find((x) => x.id === id);
    if (pr) pr.baseline_at = new Date().toISOString();
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
    if (sort == null && b.first) sort = Math.min(0, ...store.tasks.filter((t) => t.project_id === projectId && (t.parent_id ?? null) === parentId).map((t) => t.sort_order)) - 10;
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
// same rules as the server: one year back, filtered here, newest first, "before" for the next page
const HISTORY_DAYS = 365;
const historyRows = (q: URLSearchParams) => {
  const from = Date.now() - HISTORY_DAYS * 86400000;
  let rows = store.audit.filter((r) => Date.parse(r.at) >= from);
  if (q.get('task_id')) rows = rows.filter((r) => r.task_id === Number(q.get('task_id')));
  if (q.get('project_id')) rows = rows.filter((r) => r.project_id === Number(q.get('project_id')));
  if (q.get('user')) rows = rows.filter((r) => r.user_name === q.get('user'));
  if (q.get('action')) rows = rows.filter((r) => r.action === q.get('action'));
  return rows;
};
on('GET', /^\/history$/, (_u, _b, _m, q) => {
  let rows = historyRows(q);
  if (q.get('before')) rows = rows.filter((r) => r.id < Number(q.get('before')));
  return rows.slice(0, Math.min(1000, Number(q.get('limit') || 200)));
}, 'viewer');
on('GET', /^\/history\/meta$/, (_u, _b, _m, q) => {
  const all = historyRows(new URLSearchParams());
  return { count: historyRows(q).length, people: [...new Set(all.map((r) => r.user_name).filter(Boolean))], actions: [...new Set(all.map((r) => r.action))], days: HISTORY_DAYS };
}, 'viewer');

// calendar and special days (same rules as server/src/api.js)
on('GET', /^\/calendar$/, (_u, _b, _m, q) => {
  const year = Number(q.get('year')) || Number(todayISO().slice(0, 4));
  const s = computeSchedule({ ...data(), tasks: [], deps: [] });
  const holidays = holidaysInRange(toDay(`${year}-01-01`), toDay(`${year}-12-31`)).map((h: Any) => ({ ...h, off: !s.cal.isWork(toDay(h.day)) }));
  return { settings: data().calendarSettings, defaults: DEFAULT_CALENDAR, specialDays: store.specialDays, holidays, year };
}, 'viewer');
on('PUT', /^\/calendar$/, (user, b) => {
  needAdmin(user);
  mutate(user, () => {
    store.calendarSettings = { workDays: DEFAULT_CALENDAR.workDays, chagOff: !!b.chagOff, independenceOff: !!b.independenceOff, cholHamoedOff: !!b.cholHamoedOff, erevChagOff: !!b.erevChagOff };
    return { action: 'update', summary: 'עודכנו הגדרות החגים' };
  });
  return { ok: true };
});
on('POST', /^\/calendar\/special$/, (user, b) => {
  if (!b.start_day || !isDate(b.start_day)) throw new HttpError(400, 'תאריך לא תקין');
  const end = b.end_day && isDate(b.end_day) && b.end_day >= b.start_day ? b.end_day : b.start_day;
  let unitId = b.unit_id == null || b.unit_id === '' ? null : int(b.unit_id, null);
  const root = store.units.find((u) => u.parent_id == null);
  if (unitId === root?.id) unitId = null;
  if (user.role !== 'admin') {
    if (unitId == null) unitId = user.unit_id;
    if (!isWithin(unitId, user.unit_id)) throw new HttpError(403, 'אפשר להוסיף ימים מיוחדים רק למסגרת שלך או למסגרות שמתחתיה.');
  }
  if (b.kind === 'work' && unitId != null) throw new HttpError(400, 'יום עבודה מיוחד אפשר להגדיר רק לכל הענף');
  const kind = b.kind === 'work' ? 'work' : 'off';
  mutate(user, () => {
    store.specialDays.push({ id: ++store.seq.special, unit_id: unitId, start_day: b.start_day, end_day: end, kind, label: String(b.label || '') });
    const who = unitId == null ? 'כל הענף' : store.units.find((u) => u.id === unitId)?.name;
    return { action: 'create', summary: `${b.start_day === end ? b.start_day : `${b.start_day} עד ${end}`}: ${kind === 'work' ? 'יום עבודה' : 'יום חופש'} ל${who}` };
  });
  return { ok: true };
});
on('DELETE', /^\/calendar\/special\/(\d+)$/, (user, _b, m) => {
  const r = store.specialDays.find((x) => x.id === Number(m[1]));
  if (!r) throw new HttpError(404, 'היום המיוחד לא נמצא');
  if (user.role !== 'admin' && (r.unit_id == null || !isWithin(r.unit_id, user.unit_id))) throw new HttpError(403, 'אפשר להסיר רק ימים מיוחדים של המסגרת שלך או של המסגרות שמתחתיה.');
  mutate(user, () => { store.specialDays = store.specialDays.filter((x) => x !== r); return { action: 'delete', summary: 'הוסר יום מיוחד' }; });
  return { ok: true };
});

on('PUT', /^\/admin-password$/, (user, b) => {
  needAdmin(user);
  if (String(b.next ?? '').trim().length < 4) throw new HttpError(400, 'הסיסמה החדשה קצרה מדי (לפחות 4 תווים)');
  store.adminPassword = String(b.next);
  save();
  return { ok: true };
});

// import from a file (same rules as server/src/api.js)
on('POST', /^\/import$/, (user, b) => {
  const rows: Any[] = Array.isArray(b.tasks) ? b.tasks.slice(0, 3000) : [];
  if (!rows.length) throw new HttpError(400, 'אין משימות לייבוא');
  if (b.new_project && user.role !== 'admin') throw new HttpError(403, 'רק הנהלת הענף יכולה ליצור פרויקט חדש.');
  const owners = rows.map((r) => { let o = r.owner_unit_id == null ? null : int(r.owner_unit_id, null); if (o != null && !store.units.some((u) => u.id === o)) o = null; if (o == null && user.role !== 'admin') o = user.unit_id; mustAssign(user, o); return o; });
  return mutate(user, () => {
    let projectId = int(b.project_id, null);
    if (b.new_project) {
      const p = { id: ++store.seq.project, name: String(b.new_project.name || 'פרויקט מיובא'), description: 'יובא מקובץ', color: '#3b6fd8', start_date: b.new_project.start_date, sort_order: store.projects.length + 1 };
      store.projects.push(p); projectId = p.id;
    }
    const proj = store.projects.find((x) => x.id === projectId);
    if (!proj) throw new HttpError(404, 'הפרויקט לא נמצא');
    const idOf = new Map<string, number>();
    rows.forEach((r, i) => {
      const name = String(r.name || '').trim();
      if (!name) return;
      const parentId = r.parent_key != null && idOf.has(String(r.parent_key)) ? idOf.get(String(r.parent_key))! : null;
      const kind = r.kind === 'milestone' ? 'milestone' : 'task';
      const t = { id: ++store.seq.task, project_id: projectId, parent_id: parentId, sort_order: (i + 1) * 10 + 100000, name, kind,
        duration: kind === 'milestone' ? 0 : Math.max(1, int(r.duration, 1)), start_constraint: isDate(r.start) && r.start ? r.start : null,
        percent: Math.max(0, Math.min(100, int(r.percent, 0))), owner: '', notes: String(r.notes || ''), deadline: kind !== 'milestone' && isDate(r.deadline) && r.deadline ? r.deadline : null,
        cost: null, baseline_start: null, baseline_finish: null, owner_unit_id: owners[i] };
      store.tasks.push(t); idOf.set(String(r.key), t.id);
    });
    let deps = 0;
    for (const d of Array.isArray(b.deps) ? b.deps : []) {
      const pId = idOf.get(String(d.from)), sId = idOf.get(String(d.to));
      if (pId == null || sId == null || pId === sId || store.deps.some((x) => (x.predecessor_id === pId && x.successor_id === sId) || (x.predecessor_id === sId && x.successor_id === pId))) continue;
      store.deps.push({ id: ++store.seq.dep, predecessor_id: pId, successor_id: sId, type: DEP_TYPES.includes(d.type) ? d.type : 'FS', lag: int(d.lag, 0) }); deps++;
    }
    return { result: { project_id: projectId, tasks: idOf.size, deps }, action: 'create', projectId: projectId!, summary: `יובאו ${idOf.size} משימות מקובץ אל "${proj.name}"` };
  }).result;
});

// favourites, kept per unit
on('POST', /^\/favorites$/, (user, b) => {
  const key = String(user.unit_id);
  const list = new Set<number>(store.favorites[key] || []);
  if (b.on === false) list.delete(int(b.task_id, 0)); else list.add(int(b.task_id, 0));
  store.favorites[key] = [...list];
  save();
  return { ok: true };
});

// organisation units and permissions (branch management only)
const subtreeUnits = (id: number) => { const out = new Set([id]); let grew = true; while (grew) { grew = false; for (const u of store.units) if (u.parent_id != null && out.has(u.parent_id) && !out.has(u.id)) { out.add(u.id); grew = true; } } return out; };
const depthOf = (id: number | null) => { let d = 0; let x = store.units.find((u) => u.id === id)?.parent_id ?? null; while (x != null && d < 50) { d++; x = store.units.find((u) => u.id === x)?.parent_id ?? null; } return d; };
const kindAt = (d: number) => (d === 0 ? 'branch' : d === 1 ? 'section' : 'team');
const unitLog = (user: Any, summary: string) => { store.audit.unshift({ id: ++store.seq.audit, at: new Date().toISOString(), user_name: user.display_name, entity: 'unit', action: 'update', summary, details: {} }); save(); };
on('POST', /^\/units$/, (user, b) => {
  needAdmin(user);
  const parent = store.units.find((u) => u.id === int(b.parent_id, null));
  const name = String(b.name || '').trim();
  if (!parent || !name) throw new HttpError(400, 'חסר שם או מסגרת אם');
  const u = { id: ++store.seq.unit, parent_id: parent.id, kind: kindAt(depthOf(parent.id) + 1), name, head: '', sort_order: store.units.filter((x) => x.parent_id === parent.id).length, edit_all: false };
  store.units.push(u);
  unitLog(user, `נוספה מסגרת "${name}" תחת "${parent.name}"`);
  return u;
});
on('PATCH', /^\/units\/(\d+)$/, (user, b, m) => {
  needAdmin(user);
  const u = store.units.find((x) => x.id === Number(m[1]));
  if (!u) throw new HttpError(404, 'המסגרת לא נמצאה');
  if (b.name != null && String(b.name).trim()) u.name = String(b.name).trim();
  if ('edit_all' in b) { if (u.parent_id == null) throw new HttpError(400, 'הנהלת הענף עורכת הכול ממילא'); u.edit_all = !!b.edit_all; }
  if ('parent_id' in b && int(b.parent_id, null) !== u.parent_id) {
    const np = int(b.parent_id, null);
    if (u.parent_id == null || !store.units.some((x) => x.id === np)) throw new HttpError(400, 'אי אפשר להעביר לשם');
    if (subtreeUnits(u.id).has(np)) throw new HttpError(400, 'אי אפשר להעביר מסגרת אל תוך עצמה');
    u.parent_id = np;
    u.sort_order = store.units.filter((x) => x.parent_id === np).length;
    for (const x of subtreeUnits(u.id)) { const y = store.units.find((z) => z.id === x)!; y.kind = kindAt(depthOf(x)); }
  }
  unitLog(user, `עודכנה מסגרת "${u.name}"`);
  return { ok: true };
});
on('DELETE', /^\/units\/(\d+)$/, (user, _b, m) => {
  needAdmin(user);
  const u = store.units.find((x) => x.id === Number(m[1]));
  if (!u) throw new HttpError(404, 'המסגרת לא נמצאה');
  if (u.parent_id == null) throw new HttpError(400, 'אי אפשר למחוק את הנהלת הענף');
  const sub = subtreeUnits(u.id);
  const s = sched();
  const open = [...s.tasks.values()].filter((t: Any) => t.owner_unit_id != null && sub.has(t.owner_unit_id) && t.percent < 100);
  if (open.length) throw new HttpError(400, `אי אפשר למחוק: יש ${open.length} משימות פתוחות באחריות המסגרת או מתחתיה.`);
  for (const t of store.tasks) if (t.owner_unit_id != null && sub.has(t.owner_unit_id)) t.owner_unit_id = u.parent_id;
  store.units = store.units.filter((x) => !sub.has(x.id));
  store.specialDays = store.specialDays.filter((r) => r.unit_id == null || !sub.has(r.unit_id));
  unitLog(user, `נמחקה מסגרת "${u.name}"`);
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
