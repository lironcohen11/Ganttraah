-- Ganttraah database schema. Safe to run on every start (idempotent).

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'viewer',   -- admin | editor | viewer
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  color       TEXT NOT NULL DEFAULT '#3b6fd8',
  start_date  DATE NOT NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A task with children is a summary task: its dates and progress are computed from them.
CREATE TABLE IF NOT EXISTS tasks (
  id               SERIAL PRIMARY KEY,
  project_id       INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id        INT REFERENCES tasks(id) ON DELETE CASCADE,
  sort_order       INT NOT NULL DEFAULT 0,
  name             TEXT NOT NULL,
  kind             TEXT NOT NULL DEFAULT 'task',   -- task | milestone
  duration         INT NOT NULL DEFAULT 1,         -- working days (milestone = 0)
  start_constraint DATE,                           -- "start no earlier than"; NULL = as soon as possible
  percent          INT NOT NULL DEFAULT 0,
  owner            TEXT NOT NULL DEFAULT '',
  notes            TEXT NOT NULL DEFAULT '',
  deadline         DATE,
  cost             NUMERIC,
  baseline_start   DATE,
  baseline_finish  DATE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks(project_id);
CREATE INDEX IF NOT EXISTS tasks_parent_idx ON tasks(parent_id);

-- type: FS = finish->start, SS = start->start, FF = finish->finish. lag in working days (may be negative).
CREATE TABLE IF NOT EXISTS dependencies (
  id             SERIAL PRIMARY KEY,
  predecessor_id INT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  successor_id   INT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type           TEXT NOT NULL DEFAULT 'FS',
  lag            INT NOT NULL DEFAULT 0,
  UNIQUE (predecessor_id, successor_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

-- Single-day overrides of the working calendar.
CREATE TABLE IF NOT EXISTS calendar_exceptions (
  day   DATE PRIMARY KEY,
  kind  TEXT NOT NULL,          -- off | work
  label TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         SERIAL PRIMARY KEY,
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id    INT,
  user_name  TEXT NOT NULL DEFAULT '',
  entity     TEXT NOT NULL,      -- task | dependency | project | calendar | user
  entity_id  INT,
  project_id INT,
  task_id    INT,
  action     TEXT NOT NULL,      -- create | update | delete | move | baseline
  summary    TEXT NOT NULL,
  details    JSONB
);
CREATE INDEX IF NOT EXISTS audit_task_idx ON audit_log(task_id);
CREATE INDEX IF NOT EXISTS audit_project_idx ON audit_log(project_id);
CREATE INDEX IF NOT EXISTS audit_at_idx ON audit_log(at);   -- the yearly cleanup

-- Undo / redo: full snapshot of the plan before each change (the plan is small).
CREATE TABLE IF NOT EXISTS undo_stack (
  id         SERIAL PRIMARY KEY,
  user_id    INT NOT NULL,
  kind       TEXT NOT NULL,      -- undo | redo
  label      TEXT NOT NULL,
  rev        INT NOT NULL,       -- plan revision this entry belongs to
  data       JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS undo_user_idx ON undo_stack(user_id, kind, id);

-- Organisation units: branch (management) > sections > teams. Entering the system = choosing a unit.
CREATE TABLE IF NOT EXISTS units (
  id         SERIAL PRIMARY KEY,
  parent_id  INT REFERENCES units(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,           -- branch | section | team
  name       TEXT NOT NULL,
  head       TEXT NOT NULL DEFAULT '',
  sort_order INT NOT NULL DEFAULT 0
);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS owner_unit_id INT REFERENCES units(id) ON DELETE SET NULL;
ALTER TABLE sessions ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS unit_id INT REFERENCES units(id) ON DELETE CASCADE;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS view_only BOOLEAN NOT NULL DEFAULT FALSE;

-- 1.5.0: special days with date ranges, global (unit_id NULL) or for one unit and the units below it.
CREATE TABLE IF NOT EXISTS special_days (
  id        SERIAL PRIMARY KEY,
  unit_id   INT REFERENCES units(id) ON DELETE CASCADE,
  start_day DATE NOT NULL,
  end_day   DATE NOT NULL,
  kind      TEXT NOT NULL DEFAULT 'off',   -- off | work (work: global only)
  label     TEXT NOT NULL DEFAULT ''
);
-- favourites are kept per unit (everyone who enters as the unit shares them)
CREATE TABLE IF NOT EXISTS favorites (
  unit_id INT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  task_id INT NOT NULL,
  PRIMARY KEY (unit_id, task_id)
);
-- a unit marked edit_all may edit every task in the plan (not settings or projects)
ALTER TABLE units ADD COLUMN IF NOT EXISTS edit_all BOOLEAN NOT NULL DEFAULT FALSE;

-- 1.5.1: when the original plan (baseline) of a project was last saved
ALTER TABLE projects ADD COLUMN IF NOT EXISTS baseline_at TIMESTAMPTZ;
