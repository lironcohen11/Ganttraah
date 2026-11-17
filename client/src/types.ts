export type Status = 'done' | 'late' | 'behind' | 'planned' | 'active';
export type DepType = 'FS' | 'SS' | 'FF';
export type Role = 'admin' | 'editor' | 'viewer';

export interface Task {
  id: number;
  project_id: number;
  parent_id: number | null;
  sort_order: number;
  name: string;
  kind: 'task' | 'milestone' | 'summary';
  input_kind: 'task' | 'milestone';
  duration: number;
  start_constraint: string | null;
  percent: number;
  own_percent: number;
  owner: string;
  owner_unit_id: number | null;
  notes: string;
  deadline: string | null;
  cost: number | null;
  cost_total: number | null;
  baseline_start: string | null;
  baseline_finish: string | null;
  start: string;
  finish: string;
  work_days: number;
  wbs: string;
  level: number;
  children: number[];
  critical: boolean;
  float: number | null;
  /** free slack: work days the task can move later without moving any other task or its project's end */
  free_float?: number | null;
  /** the latest finish within that slack */
  free_until?: string | null;
  expected_percent: number;
  status: Status;
  deadline_missed: boolean;
  driving_dep_ids: number[];
  constrained: boolean;
  in_cycle: boolean;
  has_late: boolean;
  has_deadline_issue: boolean;
}

export interface Project {
  id: number;
  name: string;
  description: string;
  color: string;
  start_date: string;
  sort_order: number;
  start: string;
  finish: string;
  percent: number;
  roots: number[];
  task_count: number;
  late_count: number;
  behind_count: number;
  deadline_issues: number;
  baseline_finish: string | null;
  /** the estimated finish date set for the project, and whether the plan ends after it */
  target_finish?: string | null;
  target_missed?: boolean;
  /** when the original plan was last saved */
  baseline_at?: string | null;
  cost_total: number | null;
}

export interface Dep {
  id: number;
  predecessor_id: number;
  successor_id: number;
  type: DepType;
  lag: number;
}

export interface AppData {
  today: string;
  projects: Project[];
  tasks: Task[];
  dependencies: Dep[];
  calendar: { workDays: number[]; days: { d: string; off: boolean; label: string }[] };
  cycle: number[] | null;
  db: string;
  undo: { undo: UndoEntry | null; redo: UndoEntry | null };
  units: Unit[];
  /** special days off of one unit (and the units below it) */
  unitDays: UnitDay[];
  /** updates in the bell that the unit has not seen yet */
  notif_unread?: number;
  /** favourite task ids of the unit you entered as */
  favorites: number[];
  /** the latest postponement of each task that was postponed */
  delays?: Delay[];
  /** ask why a task with an original plan is postponed (branch management can turn it off) */
  delay_reasons?: boolean;
  /** the task pool: tasks with no date yet, not in the plan */
  backlog?: BacklogItem[];
}

/** a task in the pool (backlog): no date yet, not scheduled, not in the Gantt */
export interface BacklogItem {
  id: number;
  name: string;
  notes: string;
  /** the project it is expected to go to (may be unknown) */
  project_id: number | null;
  owner_unit_id: number | null;
  /** estimated work days (optional) */
  duration: number | null;
  sort_order: number;
}

/** a task's finish moved later: why (a reason from the list), or because a task it depends on moved (cause_task_id) */
export interface Delay {
  id: number; at: string; task_id: number; unit_id: number | null; user_name: string;
  reason: string | null; reason_other: string; description: string; cause_task_id: number | null;
  from_finish: string | null; to_finish: string | null;
}

export interface UnitDay { id: number; unit_id: number; start_day: string; end_day: string; kind: 'off' | 'work'; label: string }

export interface Unit {
  id: number;
  parent_id: number | null;
  kind: 'branch' | 'section' | 'team';
  name: string;
  head: string;
  sort_order: number;
  /** may edit every task in the plan, not only its own */
  edit_all: boolean;
}

export interface UndoEntry { label: string; blocked: boolean }

export interface User {
  id: number;
  username: string;
  display_name: string;
  role: Role;
  active: boolean;
  unit_id: number | null;
  head: string;
  kind: 'branch' | 'section' | 'team' | 'viewer' | 'account';
  edit_all?: boolean;
}

export interface AuditEntry {
  id: number;
  at: string;
  user_name: string;
  entity: string;
  entity_id: number | null;
  project_id: number | null;
  task_id: number | null;
  action: string;
  summary: string;
  details: { moved?: Moved[]; [k: string]: unknown } | null;
}

export interface Moved {
  id: number;
  name: string;
  kind: string;
  from: { start: string; finish: string };
  to: { start: string; finish: string };
  shift: number;
  path?: string;
}

export interface ImpactNode { id: number; side: 'up' | 'down' | 'center'; level: number; path: string }
export interface ImpactEdge { from: number; to: number; dep_id: number; type: DepType; lag: number; via: number | null; driving: boolean }
export interface Impact { root: number; nodes: ImpactNode[]; edges: ImpactEdge[]; truncated: boolean; ancestors: number[] }

export interface SimDelay {
  mode: 'delay';
  task_id: number;
  days: number;
  self: { from: string; to: string };
  moved: Moved[];
  deadlines: { id: number; name: string; path: string; deadline: string; finish: string }[];
  projects: { id: number; name: string; from: string; to: string }[];
}
export interface SimCancel {
  mode: 'cancel';
  task_id: number;
  blocked: { id: number; name: string; path: string; level: number; start: string; finish: string; kind: string; deadline: string | null }[];
  projects: { id: number; name: string }[];
}
export type SimResult = SimDelay | SimCancel;
