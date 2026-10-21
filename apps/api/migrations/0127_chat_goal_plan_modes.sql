-- 0127：聊天 `/plan` 与 `/goal` 模式（总纲 §0.15、工作台 §44、运行架构 §9）。
--
-- 三张业务表 + 两张账本表：
--   * assist_plans            —— 计划版本（不可变：每次修改产生新版本行）
--   * assist_goals            —— 会话内活动目标的持久状态（唯一活跃目标）
--   * assist_goal_rounds      —— 每个推进轮次的结算回执（同一消息只结算一次）
--   * assist_goal_budget_grants —— 额度耗尽后用户点击「继续」的显式授权账本
--
-- 会话上的 chat_mode 是**行为模式**，与 conversation_mode（AGENT/ASSISTANT/LEARNING
-- 会话身份）分开：模式不改变身份、权限或工具准入来源，只决定提示词与写入闸门。
-- assist_messages 上的同名列是**发送时的模式快照**：之后切换模式不改写已排队消息的
-- 处理方式（与 intent、method_snapshot 的冻结语义一致）。

ALTER TABLE assist_sessions
  ADD COLUMN chat_mode text NOT NULL DEFAULT 'CHAT',
  ADD CONSTRAINT ck_assist_session_chat_mode CHECK (chat_mode IN ('CHAT', 'PLAN', 'GOAL'));

ALTER TABLE assist_messages
  ADD COLUMN chat_mode text NOT NULL DEFAULT 'CHAT',
  ADD COLUMN goal_id uuid,
  -- 目标轮次的结构化结论（成功条件状态、步骤、下一步）。正文仍是 content；
  -- 这一列让推进器不必再解析一遍正文，也让「模型说了什么」与「用户看到什么」各自可核对。
  ADD COLUMN goal_outcome jsonb,
  ADD CONSTRAINT ck_assist_message_chat_mode CHECK (chat_mode IN ('CHAT', 'PLAN', 'GOAL'));

CREATE TABLE assist_plans (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  session_id uuid NOT NULL REFERENCES assist_sessions (id),
  -- 版本号从 1 起严格递增；版本行本身不可变，修改＝插入新版本并把旧版本标 SUPERSEDED。
  version integer NOT NULL CHECK (version >= 1),
  status text NOT NULL DEFAULT 'CURRENT',
  goal text NOT NULL,
  scope jsonb NOT NULL DEFAULT '[]'::jsonb,
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  verification jsonb NOT NULL DEFAULT '[]'::jsonb,
  open_questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- 产出这一版的会话消息。同一消息只允许落一版，重放与恢复都按这条身份核对。
  source_message_id uuid NOT NULL REFERENCES assist_messages (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_assist_plan_status CHECK (status IN ('CURRENT', 'SUPERSEDED')),
  CONSTRAINT uq_assist_plan_version UNIQUE (session_id, version),
  CONSTRAINT uq_assist_plan_source UNIQUE (session_id, source_message_id)
);
CREATE INDEX ix_assist_plans_session ON assist_plans (session_id, version DESC);

CREATE TABLE assist_goals (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  session_id uuid NOT NULL REFERENCES assist_sessions (id),
  -- 从哪一版计划启动；自由目标（没有计划）为 NULL。
  plan_version_id uuid REFERENCES assist_plans (id),
  objective text NOT NULL,
  -- 成功条件、步骤在执行开始时冻结；后续计划版本不改写已冻结的执行契约。
  criteria jsonb NOT NULL DEFAULT '[]'::jsonb,
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'ACTIVE',
  current_step text,
  progress text,
  -- 停止/等待/耗尽的具体原因（类型化代码 + 用户可读正文），由服务端写入。
  stop_reason jsonb,
  round_count integer NOT NULL DEFAULT 0 CHECK (round_count >= 0),
  no_progress_rounds integer NOT NULL DEFAULT 0 CHECK (no_progress_rounds >= 0),
  -- 推进租约：同一目标同一时刻只允许一个 Worker 组织下一轮，重扫不产生第二条链。
  lease_owner text,
  lease_expires_at timestamptz,
  next_round_at timestamptz,
  -- 最近一次结算过的目标轮次消息（恢复时据此判断「有没有未结算的在途轮次」）。
  last_round_message_id uuid,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CONSTRAINT ck_assist_goal_status CHECK (status IN (
    'ACTIVE', 'PAUSING', 'PAUSED', 'CANCELLING', 'CANCELLED',
    'WAITING_USER', 'BLOCKED', 'BUDGET_EXHAUSTED', 'AWAITING_ACCEPTANCE',
    'COMPLETED', 'FAILED'
  )),
  CONSTRAINT ck_assist_goal_closed CHECK (
    (status IN ('COMPLETED', 'CANCELLED', 'FAILED') AND closed_at IS NOT NULL) OR
    (status NOT IN ('COMPLETED', 'CANCELLED', 'FAILED') AND closed_at IS NULL)
  )
);
-- 一条会话最多一个「未终结」目标：终结态才让出槽位，BUDGET_EXHAUSTED 仍占位，
-- 因此额度耗尽后不会因为再发一条消息就悄悄长出第二个目标。
CREATE UNIQUE INDEX uq_assist_goal_open_per_session ON assist_goals (session_id)
  WHERE status NOT IN ('COMPLETED', 'CANCELLED', 'FAILED');
CREATE INDEX ix_assist_goals_active ON assist_goals (status, next_round_at);
CREATE INDEX ix_assist_goals_session ON assist_goals (session_id, created_at DESC);

ALTER TABLE assist_messages
  ADD CONSTRAINT fk_assist_message_goal FOREIGN KEY (goal_id) REFERENCES assist_goals (id);
CREATE INDEX ix_assist_messages_goal ON assist_messages (goal_id, seq);

CREATE TABLE assist_goal_rounds (
  id uuid PRIMARY KEY,
  goal_id uuid NOT NULL REFERENCES assist_goals (id),
  -- 一个目标轮次消息只结算一次：恢复重扫按这条唯一键幂等。
  message_id uuid NOT NULL REFERENCES assist_messages (id),
  round_index integer NOT NULL CHECK (round_index >= 1),
  -- 本轮结论（含失败原因），由服务端从消息结果与目标信封确定性推导。
  outcome text NOT NULL,
  note text,
  criteria_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_assist_goal_round_message UNIQUE (message_id),
  CONSTRAINT uq_assist_goal_round_index UNIQUE (goal_id, round_index)
);

CREATE TABLE assist_goal_budget_grants (
  id uuid PRIMARY KEY,
  goal_id uuid NOT NULL REFERENCES assist_goals (id),
  -- 用户的一次「继续」：同一命令重放只写一行，不重复加额度。
  command_id uuid NOT NULL,
  granted_calls integer NOT NULL CHECK (granted_calls > 0),
  granted_tokens bigint NOT NULL CHECK (granted_tokens > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_assist_goal_grant_command UNIQUE (command_id)
);
CREATE INDEX ix_assist_goal_grants_goal ON assist_goal_budget_grants (goal_id);

GRANT SELECT, INSERT, UPDATE ON assist_plans TO relay_app;
GRANT SELECT, INSERT, UPDATE ON assist_goals TO relay_app;
GRANT SELECT, INSERT ON assist_goal_rounds TO relay_app;
GRANT SELECT, INSERT ON assist_goal_budget_grants TO relay_app;
