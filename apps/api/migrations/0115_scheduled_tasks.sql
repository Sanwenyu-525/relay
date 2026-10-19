-- N08 周期定时启动任务（ADR-026）。
-- scheduled_tasks 只拥有模板、重复规则、下次触发时刻与提前授权；
-- scheduled_task_occurrences 记录每次触发发生，Task/Run 身份只在这里引用，不复制业务状态。
CREATE TABLE scheduled_tasks (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  -- {task_title, objective, criteria[], expected_outputs, mode}：复用 CreateTask 的入参形状。
  template jsonb NOT NULL CHECK (jsonb_typeof(template) = 'object'),
  -- {kind:'DAILY',interval_days:1..30} 或 {kind:'WEEKLY',weekdays:[1..7]}。
  repeat_rule jsonb NOT NULL CHECK (jsonb_typeof(repeat_rule) = 'object'
    AND repeat_rule ->> 'kind' IN ('DAILY', 'WEEKLY')),
  timezone text NOT NULL,
  -- 墙钟时刻 HH:MM；跨 DST 仍按这个本地时刻解释，不存固定偏移。
  local_time text NOT NULL CHECK (local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  first_run_at timestamptz NOT NULL,
  next_due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'ENABLED' CHECK (status IN ('ENABLED', 'PAUSED', 'DISABLED', 'EXPIRED')),
  schedule_generation bigint NOT NULL DEFAULT 1 CHECK (schedule_generation >= 1),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  max_runs integer NOT NULL CHECK (max_runs BETWEEN 1 AND 100),
  -- runs_reserved 是「已产生的时段数」，只用于序号与顺序；runs_started 才是预算口径，
  -- 因为用户理解的 max_runs 是「最多真正启动多少次」，跳过的时段不该吃掉额度。
  runs_reserved integer NOT NULL DEFAULT 0 CHECK (runs_reserved >= 0),
  runs_started integer NOT NULL DEFAULT 0 CHECK (runs_started >= 0),
  authorization_expires_at timestamptz NOT NULL,
  -- 用户选定的执行范围意图；触发时再按当时状态冻结到 occurrence。
  execution_input jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(execution_input) = 'object'),
  history jsonb NOT NULL CHECK (jsonb_typeof(history) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (runs_started <= runs_reserved)
);
CREATE INDEX scheduled_tasks_due ON scheduled_tasks(next_due_at) WHERE status = 'ENABLED';
CREATE INDEX scheduled_tasks_project ON scheduled_tasks(workspace_id, project_id, created_at);

CREATE TABLE scheduled_task_occurrences (
  id uuid PRIMARY KEY,
  scheduled_task_id uuid NOT NULL REFERENCES scheduled_tasks(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  schedule_generation bigint NOT NULL,
  sequence bigint NOT NULL CHECK (sequence >= 1),
  due_at timestamptz NOT NULL,
  timezone text NOT NULL,
  missed boolean NOT NULL,
  -- DISPATCHING 是租约：插入即置，兼作崩溃恢复入口；SKIPPED 表示按规则不执行。
  status text NOT NULL DEFAULT 'DISPATCHING'
    CHECK (status IN ('DISPATCHING', 'DISPATCHED', 'BLOCKED', 'SKIPPED', 'RESOLVED')),
  task_id uuid REFERENCES tasks(id),
  run_id uuid REFERENCES runs(id),
  -- 三个命令身份在落库时预生成：重跑靠回执重放，不会重复建 Task。
  create_command_id uuid NOT NULL,
  ready_command_id uuid NOT NULL,
  delegate_command_id uuid NOT NULL,
  frozen_execution jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(frozen_execution) = 'object'),
  reason text,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scheduled_task_id, schedule_generation, sequence),
  UNIQUE (create_command_id),
  UNIQUE (ready_command_id),
  UNIQUE (delegate_command_id)
);
CREATE INDEX scheduled_task_occurrences_recent
  ON scheduled_task_occurrences(scheduled_task_id, created_at DESC, id DESC);
CREATE INDEX scheduled_task_occurrences_attention
  ON scheduled_task_occurrences(workspace_id, created_at, id) WHERE status = 'BLOCKED';

GRANT SELECT, INSERT, UPDATE ON scheduled_tasks, scheduled_task_occurrences TO relay_app;
