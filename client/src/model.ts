import type { AppData, Dep, Project, Task, Status, Unit } from './types';
import { WorkCalendar } from './dates';

export const STATUS_LABEL: Record<Status, string> = {
  done: 'הושלמה', active: 'בביצוע', planned: 'מתוכננת', behind: 'בפיגור', late: 'באיחור',
};
export const DEP_LABEL: Record<string, string> = { FS: 'סיום ← התחלה', SS: 'התחלה ← התחלה', FF: 'סיום ← סיום' };
export const DEP_SHORT: Record<string, string> = { FS: 'אחרי סיום', SS: 'עם ההתחלה', FF: 'יחד בסיום' };
export const depText = (type: string, lag: number) =>
  `${DEP_SHORT[type] || type}${lag ? ` ${lag > 0 ? '+' : '−'}${Math.abs(lag)} ימים` : ''}`;

export class Model {
  tasks = new Map<number, Task>();
  projects = new Map<number, Project>();
  depsIn = new Map<number, Dep[]>();   // by successor
  depsOut = new Map<number, Dep[]>();  // by predecessor
  cal: WorkCalendar;
  projectList: Project[];
  units = new Map<number, Unit>();
  unitKids = new Map<number | null, Unit[]>();

  constructor(public data: AppData) {
    for (const u of data.units || []) {
      this.units.set(u.id, u);
      if (!this.unitKids.has(u.parent_id)) this.unitKids.set(u.parent_id, []);
      this.unitKids.get(u.parent_id)!.push(u);
    }
    for (const l of this.unitKids.values()) l.sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
    for (const t of data.tasks) this.tasks.set(t.id, t);
    for (const p of data.projects) this.projects.set(p.id, p);
    this.projectList = [...data.projects].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
    for (const d of data.dependencies) {
      if (!this.depsIn.has(d.successor_id)) this.depsIn.set(d.successor_id, []);
      if (!this.depsOut.has(d.predecessor_id)) this.depsOut.set(d.predecessor_id, []);
      this.depsIn.get(d.successor_id)!.push(d);
      this.depsOut.get(d.predecessor_id)!.push(d);
    }
    this.cal = new WorkCalendar(data.calendar.workDays, data.calendar.days);
  }

  // ---- organisation units
  /** units in tree order with their depth (root first) */
  unitTree(rootId: number | null = null): { unit: Unit; depth: number }[] {
    const out: { unit: Unit; depth: number }[] = [];
    const walk = (parent: number | null, depth: number) => {
      for (const u of this.unitKids.get(parent) || []) { out.push({ unit: u, depth }); walk(u.id, depth + 1); }
    };
    if (rootId == null) walk(null, 0);
    else { const r = this.units.get(rootId); if (r) { out.push({ unit: r, depth: 0 }); walk(r.id, 1); } }
    return out;
  }
  /** is unit a inside unit b (or equal)? */
  unitWithin(a: number | null, b: number | null) {
    let x = a;
    for (let i = 0; i < 50 && x != null; i++) { if (x === b) return true; x = this.units.get(x)?.parent_id ?? null; }
    return false;
  }
  /** owner of the task, or inherited from its nearest parent task */
  effOwner(id: number): { unit: number | null; inherited: boolean } {
    let x: number | null = id, inherited = false;
    for (let i = 0; i < 100 && x != null; i++) {
      const t = this.tasks.get(x);
      if (!t) break;
      if (t.owner_unit_id != null) return { unit: t.owner_unit_id, inherited };
      x = t.parent_id; inherited = true;
    }
    return { unit: null, inherited: false };
  }
  ownerName(id: number) { const o = this.effOwner(id); return o.unit != null ? this.units.get(o.unit)?.name || '' : ''; }

  task(id: number) { return this.tasks.get(id); }
  project(id: number) { return this.projects.get(id); }
  ancestors(id: number): number[] {
    const out: number[] = [];
    let p = this.tasks.get(id)?.parent_id ?? null;
    while (p != null) { out.push(p); p = this.tasks.get(p)?.parent_id ?? null; }
    return out;
  }
  subtree(id: number): Set<number> {
    const s = new Set<number>();
    const st = [id];
    while (st.length) { const x = st.pop()!; s.add(x); for (const c of this.tasks.get(x)?.children || []) st.push(c); }
    return s;
  }
  siblings(t: Task): number[] {
    return t.parent_id != null ? this.tasks.get(t.parent_id)!.children : this.projects.get(t.project_id)!.roots;
  }
  /** "Project › Parent › Grandparent" (without the task itself) */
  path(id: number) {
    const t = this.tasks.get(id);
    if (!t) return '';
    const names = this.ancestors(id).reverse().map((a) => this.tasks.get(a)!.name);
    return [this.projects.get(t.project_id)?.name || '', ...names].join(' › ');
  }

  /** Direct relations, following links of parents (inherited) and of sub-tasks. */
  relations(id: number) {
    const anc = new Set(this.ancestors(id));
    const sub = this.subtree(id);
    const drivers: { dep: Dep; other: number; via: number | null }[] = [];
    const driven: { dep: Dep; other: number; via: number | null }[] = [];
    for (const d of this.data.dependencies) {
      const pIn = sub.has(d.predecessor_id), sIn = sub.has(d.successor_id);
      if (!pIn && (sIn || anc.has(d.successor_id))) drivers.push({ dep: d, other: d.predecessor_id, via: d.successor_id === id ? null : d.successor_id });
      if (!sIn && (pIn || anc.has(d.predecessor_id))) driven.push({ dep: d, other: d.successor_id, via: d.predecessor_id === id ? null : d.predecessor_id });
    }
    return { drivers, driven };
  }

  /** All tasks upstream (affecting) and downstream (affected), transitively. */
  chain(id: number) {
    const walk = (side: 'drivers' | 'driven') => {
      const seen = new Set<number>();
      const deps = new Set<number>();
      let frontier = [id];
      while (frontier.length) {
        const next: number[] = [];
        for (const x of frontier) {
          for (const r of this.relations(x)[side]) {
            deps.add(r.dep.id);
            if (!seen.has(r.other) && r.other !== id) { seen.add(r.other); next.push(r.other); }
          }
        }
        frontier = next;
      }
      return { tasks: seen, deps };
    };
    const up = walk('drivers');
    const down = walk('driven');
    return { up: up.tasks, down: down.tasks, upDeps: up.deps, downDeps: down.deps };
  }

  /** Is task linked to a task of another project? */
  crossProject(id: number) {
    const t = this.tasks.get(id)!;
    const other = (x: number) => this.tasks.get(x)?.project_id !== t.project_id;
    return (this.depsIn.get(id) || []).some((d) => other(d.predecessor_id)) || (this.depsOut.get(id) || []).some((d) => other(d.successor_id));
  }
}

export type Row =
  | { key: string; type: 'project'; project: Project; depth: 0 }
  | { key: string; type: 'task'; project: Project; task: Task; depth: number; external?: boolean; context?: boolean }
  | { key: string; type: 'group'; label: string; depth: 0 };

export interface RowOptions {
  projectIds?: number[] | null;  // null = all
  rootTaskId?: number | null;    // show only this subtree
  collapsed: Set<string>;
  maxLevel?: number | null;      // 0 = top level only
  includeExternal?: boolean;     // tasks outside the scope that are linked to it
  showProjects?: boolean;
  owners?: number[] | null;      // show only tasks of these units (and units below them)
}

export function buildRows(m: Model, o: RowOptions): Row[] {
  const rows: Row[] = [];
  const inScope = new Set<number>();
  // owner filter: a task is shown if it matches, or if something inside it matches (as context)
  let visible: Set<number> | null = null;
  const matches = new Set<number>();
  if (o.owners?.length) {
    visible = new Set();
    for (const t of m.data.tasks) {
      const own = m.effOwner(t.id).unit;
      if (own != null && o.owners.some((u) => m.unitWithin(own, u))) {
        matches.add(t.id);
        visible.add(t.id);
        for (const a of m.ancestors(t.id)) visible.add(a);
      }
    }
  }
  const addTask = (id: number, depth: number) => {
    const t = m.task(id);
    if (!t) return;
    if (visible && !visible.has(id)) return;
    const p = m.project(t.project_id)!;
    rows.push({ key: 't:' + id, type: 'task', project: p, task: t, depth, context: !!visible && !matches.has(id) });
    inScope.add(id);
    const base = o.rootTaskId ? m.task(o.rootTaskId)!.level + 1 : 0;
    const lvlOk = o.maxLevel == null || t.level + 1 - base < o.maxLevel;
    if (!o.collapsed.has('t:' + id) && lvlOk) for (const c of t.children) addTask(c, depth + 1);
    else for (const c of m.subtree(id)) inScope.add(c);
  };
  if (o.rootTaskId != null && m.task(o.rootTaskId)) {
    addTask(o.rootTaskId, 0);
  } else {
    for (const p of m.projectList) {
      if (o.projectIds && !o.projectIds.includes(p.id)) continue;
      if (visible && !p.roots.some((r) => visible!.has(r))) continue;
      if (o.showProjects !== false) rows.push({ key: 'p:' + p.id, type: 'project', project: p, depth: 0 });
      const collapsed = o.collapsed.has('p:' + p.id);
      if (!collapsed) for (const r of p.roots) addTask(r, o.showProjects !== false ? 1 : 0);
      else for (const r of p.roots) for (const x of m.subtree(r)) inScope.add(x);
    }
  }
  if (o.includeExternal) {
    const ext = new Set<number>();
    for (const d of m.data.dependencies) {
      const a = inScope.has(d.predecessor_id), b = inScope.has(d.successor_id);
      if (a && !b) ext.add(d.successor_id);
      if (b && !a) ext.add(d.predecessor_id);
    }
    // drop externals that sit inside other externals' parents chain duplicates
    if (ext.size) {
      rows.push({ key: 'g:ext', type: 'group', label: 'משימות קשורות מחוץ לתצוגה', depth: 0 });
      const list = [...ext].map((id) => m.task(id)!).filter(Boolean).sort((a, b) => a.start.localeCompare(b.start));
      for (const t of list) rows.push({ key: 'x:' + t.id, type: 'task', project: m.project(t.project_id)!, task: t, depth: 0, external: true });
    }
  }
  return rows;
}
