// Scheduling engine.
// Forward pass  -> earliest start/finish of every task (in working-day indices).
// Backward pass -> latest start/finish, total float and the critical path.
// Summary tasks (tasks with children) take their dates and progress from their children.
// A dependency on a summary task applies to everything inside it.
import { buildCalendar, toDay, fromDay } from './calendar.js';

export const DEP_TYPES = ['FS', 'SS', 'FF'];

/**
 * data: { projects, tasks, deps, calendarSettings, calendarExceptions, today:'YYYY-MM-DD' }
 * returns { tasks: Map<id, computed>, projects: Map<id, computed>, cal, order, cycle }
 */
export function computeSchedule(data) {
  const { projects, tasks, deps } = data;
  const todayDay = toDay(data.today);

  // ---- calendar range
  let minDay = todayDay;
  for (const p of projects) minDay = Math.min(minDay, toDay(p.start_date));
  for (const t of tasks) if (t.start_constraint) minDay = Math.min(minDay, toDay(t.start_constraint));
  const cal = buildCalendar(data.calendarSettings, data.calendarExceptions, minDay - 400, todayDay + 365 * 6);

  // ---- tree
  const projById = new Map(projects.map((p) => [p.id, p]));
  const node = new Map();
  for (const t of tasks) node.set(t.id, { ...t, children: [] });
  const rootsByProject = new Map(projects.map((p) => [p.id, []]));
  for (const n of node.values()) {
    const parent = n.parent_id != null ? node.get(n.parent_id) : null;
    if (parent && parent.project_id === n.project_id) parent.children.push(n.id);
    else {
      n.parent_id = null;
      if (!rootsByProject.has(n.project_id)) rootsByProject.set(n.project_id, []);
      rootsByProject.get(n.project_id).push(n.id);
    }
  }
  const bySort = (a, b) => (node.get(a).sort_order - node.get(b).sort_order) || (a - b);
  for (const n of node.values()) n.children.sort(bySort);
  for (const list of rootsByProject.values()) list.sort(bySort);

  // WBS numbers and levels
  const walk = (ids, prefix, level) => ids.forEach((id, i) => {
    const n = node.get(id);
    n.wbs = prefix ? `${prefix}.${i + 1}` : String(i + 1);
    n.level = level;
    walk(n.children, n.wbs, level + 1);
  });
  for (const list of rootsByProject.values()) walk(list, '', 0);

  const ancestors = (id) => {
    const out = [];
    let p = node.get(id)?.parent_id;
    while (p != null) { out.push(p); p = node.get(p).parent_id; }
    return out;
  };
  const leavesOf = (id) => {
    const n = node.get(id);
    if (!n.children.length) return [id];
    return n.children.flatMap(leavesOf);
  };

  // incoming deps for each leaf (direct + inherited from ancestors)
  const validDeps = deps.filter((d) => node.has(d.predecessor_id) && node.has(d.successor_id));
  const incoming = new Map(); // leafId -> [{dep, direct}]
  for (const id of node.keys()) incoming.set(id, []);
  for (const d of validDeps) {
    for (const leaf of leavesOf(d.successor_id)) {
      incoming.get(leaf).push({ dep: d, direct: leaf === d.successor_id });
    }
  }

  // ---- topological order (dep edges pred->leaf, rollup edges child->parent)
  const out = new Map([...node.keys()].map((id) => [id, []]));
  const indeg = new Map([...node.keys()].map((id) => [id, 0]));
  const addEdge = (a, b) => { out.get(a).push(b); indeg.set(b, indeg.get(b) + 1); };
  for (const [leaf, list] of incoming) for (const { dep } of list) addEdge(dep.predecessor_id, leaf);
  for (const n of node.values()) if (n.parent_id != null) addEdge(n.id, n.parent_id);
  const queue = [...node.keys()].filter((id) => indeg.get(id) === 0);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const b of out.get(id)) {
      indeg.set(b, indeg.get(b) - 1);
      if (indeg.get(b) === 0) queue.push(b);
    }
  }
  const cycle = order.length !== node.size ? [...node.keys()].filter((id) => indeg.get(id) > 0) : null;
  if (cycle) for (const id of cycle) order.push(id); // still produce something

  const isMs = (n) => n.kind === 'milestone' && !n.children.length;
  const dur = (n) => (isMs(n) ? 0 : Math.max(1, n.duration | 0));

  // ---- special days of a unit: they apply to its tasks and to tasks of the units below it.
  // Kept as work-day indices of the shared calendar that this unit does not work on.
  const unitParent = new Map((data.units || []).map((u) => [u.id, u.parent_id]));
  const unitRanges = (data.specialDays || []).filter((r) => r.unit_id != null && r.kind !== 'work');
  const offCache = new Map();
  const unitOff = (unitId) => {
    if (unitId == null || !unitRanges.length) return null;
    if (offCache.has(unitId)) return offCache.get(unitId);
    const chain = new Set();
    for (let x = unitId, i = 0; x != null && i < 50; i++) { chain.add(x); x = unitParent.get(x) ?? null; }
    const set = new Set();
    for (const r of unitRanges) {
      if (!chain.has(r.unit_id)) continue;
      for (let d = toDay(r.start_day); d <= toDay(r.end_day); d++) if (cal.isWork(d)) set.add(cal.idxOf(d));
    }
    const v = set.size ? set : null;
    offCache.set(unitId, v);
    return v;
  };
  const ownerOf = (n) => {
    for (let x = n, i = 0; x && i < 100; i++) { if (x.owner_unit_id != null) return x.owner_unit_id; x = x.parent_id != null ? node.get(x.parent_id) : null; }
    return null;
  };

  // ---- forward pass
  for (const id of order) {
    const n = node.get(id);
    if (n.children.length) {
      const kids = n.children.map((c) => node.get(c));
      n.ES = Math.min(...kids.map((k) => k.ES ?? Infinity));
      n.EF = Math.max(...kids.map((k) => k.EF ?? -Infinity));
      if (!Number.isFinite(n.ES)) n.ES = n.EF = cal.idxOf(toDay(projById.get(n.project_id).start_date));
      continue;
    }
    const proj = projById.get(n.project_id);
    const base = cal.idxOf(toDay(n.start_constraint || proj.start_date));
    const D = dur(n);
    const ms = isMs(n);
    let es = base;
    const reqs = [];
    for (const { dep, direct } of incoming.get(id)) {
      const p = node.get(dep.predecessor_id);
      if (p.ES == null) continue; // cycle member
      const lag = dep.lag | 0;
      let req = null;
      if (dep.type === 'SS') req = p.ES + lag;
      else if (dep.type === 'FF') req = direct ? p.EF + lag - (ms ? 0 : D - 1) : null;
      else req = p.EF + lag + (ms ? 0 : 1);
      if (req == null) continue;
      reqs.push({ depId: dep.id, req });
      if (req > es) es = req;
    }
    n.drivingDepIds = es > base ? reqs.filter((r) => r.req === es).map((r) => r.depId) : [];
    n.constrained = !!n.start_constraint && es === base;
    // the owner unit's special days: start after them, and do not count them as work
    const off = unitOff(ownerOf(n));
    if (off) {
      while (off.has(es)) es++;
      let ef = es;
      for (let left = ms ? 0 : D - 1; left > 0;) { ef++; if (!off.has(ef)) left--; }
      n.ES = es; n.EF = ef;
    } else {
      n.ES = es;
      n.EF = ms ? es : es + D - 1;
    }
  }

  // ---- progress, cost and driving roll-up (children before parents: reuse order)
  for (const id of order) {
    const n = node.get(id);
    if (!n.children.length) {
      n.weight = dur(n);
      n.pct = Math.max(0, Math.min(100, n.percent | 0));
      n.costSum = n.cost == null ? null : Number(n.cost);
      continue;
    }
    const kids = n.children.map((c) => node.get(c));
    const w = kids.reduce((s, k) => s + k.weight, 0);
    n.weight = w;
    n.pct = w > 0
      ? Math.round(kids.reduce((s, k) => s + k.pct * k.weight, 0) / w)
      : Math.round(kids.reduce((s, k) => s + k.pct, 0) / kids.length);
    const costs = kids.map((k) => k.costSum).filter((c) => c != null);
    n.costSum = costs.length ? costs.reduce((a, b) => a + b, 0) : (n.cost == null ? null : Number(n.cost));
    n.drivingDepIds = [...new Set(kids.flatMap((k) => k.drivingDepIds || []))];
  }

  // ---- backward pass (critical path)
  const projFinish = new Map();
  for (const [pid, roots] of rootsByProject) {
    projFinish.set(pid, roots.length ? Math.max(...roots.map((r) => node.get(r).EF)) : null);
  }
  const lfB = new Map(), lsB = new Map();
  const minSet = (m, k, v) => { if (!(m.get(k) <= v)) m.set(k, v); };
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    const n = node.get(id);
    if (n.parent_id != null) {
      const par = node.get(n.parent_id);
      if (par.LFb != null) minSet(lfB, id, par.LFb);
      if (lsB.has(n.parent_id) && n.ES === par.ES) minSet(lsB, id, lsB.get(n.parent_id));
    }
    const pf = projFinish.get(n.project_id);
    if (n.children.length) { n.LFb = Math.min(lfB.get(id) ?? Infinity, pf); continue; }
    const ms = isMs(n);
    const span1 = ms ? 0 : n.EF - n.ES; // length in shared work days (longer when the unit has special days)
    let LF = Math.min(pf, lfB.get(id) ?? Infinity, (lsB.get(id) ?? Infinity) + span1);
    const LS = LF - span1;
    n.LS = LS; n.LF = LF;
    n.float = LS - n.ES;
    for (const { dep, direct } of incoming.get(id)) {
      const lag = dep.lag | 0;
      const p = dep.predecessor_id;
      if (dep.type === 'SS') minSet(lsB, p, LS - lag);
      else if (dep.type === 'FF') { if (direct) minSet(lfB, p, LF - lag); }
      else minSet(lfB, p, LS - lag - (ms ? 0 : 1));
    }
  }
  for (const id of order) {
    const n = node.get(id);
    if (n.children.length) {
      const kids = n.children.map((c) => node.get(c));
      n.float = Math.min(...kids.map((k) => k.float ?? Infinity));
    }
    n.critical = n.float != null && n.float <= 0;
  }

  // ---- status vs today
  const todayIdx = cal.idxOf(todayDay);
  const result = new Map();
  for (const n of node.values()) {
    const start = fromDay(cal.dayOf(n.ES));
    const finish = fromDay(cal.dayOf(n.EF));
    const span = isMs(n) ? 0 : n.EF - n.ES + 1;
    let expected = 0;
    if (span > 0) expected = Math.max(0, Math.min(100, Math.round(((todayIdx - n.ES) / span) * 100)));
    else expected = todayIdx > n.ES ? 100 : 0;
    const done = n.pct >= 100;
    const late = !done && toDay(finish) < todayDay;
    const behind = !done && !late && n.ES < todayIdx && n.pct + 15 < expected;
    const deadline = isMs(n) ? null : n.deadline; // a milestone is a moment, it has no deadline of its own
    const deadlineMissed = !!deadline && toDay(finish) > toDay(deadline);
    result.set(n.id, {
      id: n.id,
      project_id: n.project_id,
      parent_id: n.parent_id,
      sort_order: n.sort_order,
      name: n.name,
      kind: n.children.length ? 'summary' : n.kind,
      input_kind: n.kind,
      duration: n.duration,
      start_constraint: n.start_constraint,
      percent: n.pct,
      own_percent: n.percent,
      owner: n.owner,
      owner_unit_id: n.owner_unit_id ?? null,
      notes: n.notes,
      deadline,
      cost: n.cost == null ? null : Number(n.cost),
      cost_total: n.costSum,
      baseline_start: n.baseline_start,
      baseline_finish: n.baseline_finish,
      start,
      finish,
      work_days: n.children.length ? span : (isMs(n) ? 0 : dur(n)),
      wbs: n.wbs,
      level: n.level,
      children: n.children,
      critical: n.critical,
      float: Number.isFinite(n.float) ? n.float : null,
      expected_percent: expected,
      status: done ? 'done' : late ? 'late' : behind ? 'behind' : n.ES > todayIdx ? 'planned' : 'active',
      deadline_missed: deadlineMissed,
      driving_dep_ids: n.drivingDepIds || [],
      constrained: !!n.constrained,
      in_cycle: !!(cycle && cycle.includes(n.id)),
      _ES: n.ES,
      _EF: n.EF,
    });
  }

  // roll problem flags up to parents
  for (const id of order) {
    const r = result.get(id);
    const kids = r.children.map((c) => result.get(c));
    r.has_late = r.status === 'late' || kids.some((k) => k.has_late);
    r.has_deadline_issue = r.deadline_missed || kids.some((k) => k.has_deadline_issue);
  }

  const projOut = new Map();
  for (const p of projects) {
    const roots = (rootsByProject.get(p.id) || []).map((id) => result.get(id));
    const all = [...result.values()].filter((t) => t.project_id === p.id);
    const leaves = all.filter((t) => !t.children.length);
    const w = roots.reduce((s, r) => s + node.get(r.id).weight, 0);
    projOut.set(p.id, {
      ...p,
      start: roots.length ? fromDay(cal.dayOf(Math.min(...roots.map((r) => r._ES)))) : p.start_date,
      finish: roots.length ? fromDay(cal.dayOf(Math.max(...roots.map((r) => r._EF)))) : p.start_date,
      percent: w > 0 ? Math.round(roots.reduce((s, r) => s + r.percent * node.get(r.id).weight, 0) / w)
        : roots.length ? Math.round(roots.reduce((s, r) => s + r.percent, 0) / roots.length) : 0,
      roots: roots.map((r) => r.id),
      task_count: leaves.length,
      late_count: leaves.filter((t) => t.status === 'late').length,
      behind_count: leaves.filter((t) => t.status === 'behind').length,
      deadline_issues: all.filter((t) => t.deadline_missed).length,
      baseline_finish: maxDate(roots.map((r) => r.baseline_finish)),
      cost_total: sumOrNull(roots.map((r) => r.cost_total)),
    });
  }

  return { tasks: result, projects: projOut, cal, order, cycle, incoming, ancestors, leavesOf, validDeps };
}

function maxDate(list) {
  const v = list.filter(Boolean).sort();
  return v.length ? v[v.length - 1] : null;
}
function sumOrNull(list) {
  const v = list.filter((x) => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) : null;
}

/** Compare two schedules: tasks whose dates moved. */
export function diffSchedules(before, after, excludeId) {
  const moved = [];
  for (const [id, a] of after.tasks) {
    if (id === excludeId) continue;
    const b = before.tasks.get(id);
    if (!b) continue;
    if (a.start !== b.start || a.finish !== b.finish) {
      moved.push({
        id, name: a.name, kind: a.kind,
        from: { start: b.start, finish: b.finish },
        to: { start: a.start, finish: a.finish },
        shift: a._EF - b._EF,
      });
    }
  }
  return moved;
}
