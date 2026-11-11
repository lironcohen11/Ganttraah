// "Impact map": what drives a task (upstream) and what it drives (downstream),
// following dependencies through the task hierarchy, plus what-if simulation.
import { computeSchedule, diffSchedules } from './scheduler.js';
import { fromDay } from './calendar.js';

function subtreeSet(s, id) {
  const set = new Set();
  const stack = [id];
  while (stack.length) {
    const x = stack.pop();
    set.add(x);
    for (const c of s.tasks.get(x)?.children || []) stack.push(c);
  }
  return set;
}

/** Direct relations of one task, including links inherited from its parents and links of its sub-tasks. */
export function relations(s, tid) {
  const anc = new Set(s.ancestors(tid));
  const sub = subtreeSet(s, tid);
  const drivers = [];
  const driven = [];
  for (const d of s.validDeps) {
    const pIn = sub.has(d.predecessor_id);
    const sIn = sub.has(d.successor_id);
    if (!pIn && (sIn || anc.has(d.successor_id))) {
      drivers.push({ dep: d, other: d.predecessor_id, via: d.successor_id === tid ? null : d.successor_id });
    }
    if (!sIn && (pIn || anc.has(d.predecessor_id))) {
      driven.push({ dep: d, other: d.successor_id, via: d.predecessor_id === tid ? null : d.predecessor_id });
    }
  }
  return { drivers, driven };
}

const isDriving = (s, succId, depId) => (s.tasks.get(succId)?.driving_dep_ids || []).includes(depId);

export function impactGraph(s, rootId, { maxDepth = 6, maxNodes = 80 } = {}) {
  const nodes = new Map([[rootId, { id: rootId, side: 'center', level: 0 }]]);
  const edges = new Map();
  let truncated = false;
  for (const side of ['up', 'down']) {
    let frontier = [rootId];
    let level = 0;
    while (frontier.length && level < maxDepth) {
      level++;
      const next = [];
      for (const id of frontier) {
        const rel = relations(s, id);
        for (const r of side === 'up' ? rel.drivers : rel.driven) {
          const other = r.other;
          if (!nodes.has(other)) {
            if (nodes.size >= maxNodes) { truncated = true; continue; }
            nodes.set(other, { id: other, side, level });
            next.push(other);
          }
          const from = side === 'up' ? other : id;
          const to = side === 'up' ? id : other;
          const key = `${from}>${to}>${r.dep.id}`;
          if (!edges.has(key)) {
            edges.set(key, {
              from, to, dep_id: r.dep.id, type: r.dep.type, lag: r.dep.lag,
              via: r.via,
              driving: isDriving(s, r.dep.successor_id, r.dep.id) || isDriving(s, to, r.dep.id),
            });
          }
        }
      }
      frontier = next;
    }
    if (frontier.length && level >= maxDepth) truncated = true;
  }
  return { root: rootId, nodes: [...nodes.values()], edges: [...edges.values()], truncated };
}

export function taskPath(s, id) {
  const t = s.tasks.get(id);
  if (!t) return '';
  const names = s.ancestors(id).reverse().map((a) => s.tasks.get(a).name);
  const proj = s.projects.get(t.project_id)?.name || '';
  return [proj, ...names].join(' › ');
}

/**
 * mode 'delay': the task finishes `days` working days later.
 * mode 'cancel': the task does not happen -> everything downstream is blocked.
 */
export function simulate(data, base, taskId, mode, days) {
  const t = base.tasks.get(taskId);
  if (!t) return null;
  if (mode === 'cancel') {
    const g = impactGraph(base, taskId, { maxDepth: 50, maxNodes: 1000 });
    const blocked = g.nodes.filter((n) => n.side === 'down').map((n) => {
      const x = base.tasks.get(n.id);
      return { id: n.id, name: x.name, path: taskPath(base, n.id), level: n.level, start: x.start, finish: x.finish, kind: x.kind, deadline: x.deadline };
    });
    const projects = [...new Set(blocked.map((b) => base.tasks.get(b.id).project_id))]
      .map((pid) => ({ id: pid, name: base.projects.get(pid).name }));
    return { mode, task_id: taskId, blocked, projects, edges: g.edges };
  }

  const n = Math.max(1, Math.min(500, days | 0));
  const leafIds = t.children.length ? base.leavesOf(taskId).filter((id) => base.tasks.get(id)._EF === t._EF) : [taskId];
  const tasks = data.tasks.map((x) => {
    if (!leafIds.includes(x.id)) return x;
    const c = base.tasks.get(x.id);
    if (x.kind === 'milestone') return { ...x, start_constraint: fromDay(base.cal.dayOf(c._EF + n)) };
    return { ...x, duration: Math.max(1, x.duration | 0) + n };
  });
  const after = computeSchedule({ ...data, tasks });
  const moved = diffSchedules(base, after, null)
    .filter((m) => m.id !== taskId && !base.ancestors(taskId).includes(m.id))
    .map((m) => ({ ...m, path: taskPath(base, m.id) }));
  const deadlines = [...after.tasks.values()]
    .filter((x) => x.deadline_missed && !base.tasks.get(x.id).deadline_missed)
    .map((x) => ({ id: x.id, name: x.name, path: taskPath(base, x.id), deadline: x.deadline, finish: x.finish }));
  const projects = [...after.projects.values()]
    .filter((p) => p.finish !== base.projects.get(p.id).finish)
    .map((p) => ({ id: p.id, name: p.name, from: base.projects.get(p.id).finish, to: p.finish }));
  const self = after.tasks.get(taskId);
  return { mode, task_id: taskId, days: n, self: { from: t.finish, to: self.finish }, moved, deadlines, projects };
}
