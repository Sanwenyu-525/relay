-- 0128：有界多 Agent 首版（ADR-017、总纲 §0.9、运行架构 §2.5）。
--
-- 首版产品规则：主 Agent 负责实施、协调与汇总；子 Agent 只读调查或独立审查；
-- 最多两个并发子 Agent，仅一层委派；子执行不创建独立业务 Task/Run，不取得写权限。
--
-- 三处持久化，全部沿用 Assist 原写入口，不新建第二套会话或执行状态：
--   * assist_sessions.parent_session_id     —— 主子会话关联（仅一层）
--   * assist_sessions.budget_scope_session_id —— 子会话的模型预算作用域根（§2.5.3 共享预算）
--   * assist_delegations                    —— 委派账本（一次委派一行，角色/范围/基线/输出要求冻结）
--   * assist_delegation_attempts            —— 子尝试（独立 claim/epoch、状态与结果消息）
--
-- 并发槽（最多两个 RUNNING 委派）与层级（子会话不再委派）由应用层按词汇表与计数校验，
-- 不写进数据库 CHECK：它们是运行期规则，随时可以按产品决定调整，而迁移不可改。

ALTER TABLE assist_sessions
  ADD COLUMN parent_session_id uuid REFERENCES assist_sessions (id),
  ADD COLUMN budget_scope_session_id uuid,
  -- 根会话两列皆为 NULL（预算作用域是自己）；子会话两列皆非 NULL。
  -- 这条 CHECK 挡住「有父会话但没有预算根」的半成品状态——那会让子调用绕开共享预算。
  ADD CONSTRAINT ck_assist_session_parent_budget CHECK (
    (parent_session_id IS NULL) = (budget_scope_session_id IS NULL)
  );
CREATE INDEX ix_assist_sessions_parent ON assist_sessions (parent_session_id);

CREATE TABLE assist_delegations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  -- 发起委派的主会话（必须是根会话：仅一层委派）。
  parent_session_id uuid NOT NULL REFERENCES assist_sessions (id),
  -- 本次委派建立的子会话；创建时不落，执行前回填。
  child_session_id uuid REFERENCES assist_sessions (id),
  -- 冻结的只读角色：INVESTIGATE 调查 / REVIEW 独立审查。
  role text NOT NULL,
  -- 冻结的任务说明（来自主 Agent 的委派请求，经服务端校验后落库）。
  objective text NOT NULL,
  -- 冻结的只读范围提示（受管根内的相对路径）；不授予任何能力。
  scope jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- 审查基线（如 git HEAD 摘要）：子结论只对该基线成立，基线变化不自动继承。
  baseline jsonb,
  -- 冻结的输出要求（子必须回答什么、以什么形式）。
  output_requirements text NOT NULL,
  -- 必要审查标记：冻结后不能由模型失败后改为可选（运行架构 §2.5.4）。
  required boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'QUEUED',
  -- 初次加至多一次修正重试（总纲 §0.9）； attempt_count 由应用层推进。
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 2 CHECK (max_attempts >= 1),
  -- 发起这次委派的主会话消息与工具账本行（结果回传的配对身份）。
  parent_message_id uuid NOT NULL REFERENCES assist_messages (id),
  parent_tool_call_id uuid,
  -- 子结论摘要（有界）；完整结论在子会话消息里，不复制第二份。
  result_summary text,
  stop_reason jsonb,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CONSTRAINT ck_assist_delegation_role CHECK (role IN ('INVESTIGATE', 'REVIEW')),
  CONSTRAINT ck_assist_delegation_status CHECK (status IN (
    'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'
  )),
  CONSTRAINT ck_assist_delegation_closed CHECK (
    (status IN ('SUCCEEDED', 'FAILED', 'CANCELLED') AND closed_at IS NOT NULL) OR
    (status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED') AND closed_at IS NULL)
  )
);
-- 并发槽计数：同一主会话下未终结的委派。应用层在创建前计数（含本行），> 2 拒绝。
CREATE INDEX ix_assist_delegations_parent_open ON assist_delegations (parent_session_id, status);
CREATE INDEX ix_assist_delegations_child ON assist_delegations (child_session_id);

CREATE TABLE assist_delegation_attempts (
  id uuid PRIMARY KEY,
  delegation_id uuid NOT NULL REFERENCES assist_delegations (id),
  attempt_index integer NOT NULL CHECK (attempt_index >= 1),
  -- 领取代次：迟到结果必须带同一 epoch 才能落定（租约过期不证明旧执行已停止）。
  claim_epoch bigint NOT NULL DEFAULT 1 CHECK (claim_epoch >= 1),
  worker_id text,
  status text NOT NULL DEFAULT 'RUNNING',
  -- 本次尝试对应的子会话消息（结论落在那里，回传只带摘要）。
  result_message_id uuid REFERENCES assist_messages (id),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_assist_delegation_attempt_status CHECK (status IN (
    'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'
  )),
  -- 同一委派的尝试序号唯一：重试建立关联原委派的新尝试，不产生第二个委派身份。
  CONSTRAINT uq_assist_delegation_attempt UNIQUE (delegation_id, attempt_index)
);
CREATE INDEX ix_assist_delegation_attempts_delegation ON assist_delegation_attempts (delegation_id, attempt_index);

GRANT SELECT, INSERT, UPDATE ON assist_delegations TO relay_app;
GRANT SELECT, INSERT, UPDATE ON assist_delegation_attempts TO relay_app;

-- 应用内工具（委派）没有 Gateway Operation：它的执行证据在 assist_delegation_attempts
-- （子尝试的状态、领取代次与结果消息）。因此只对 delegate_subagent 放开 0060 的
-- 「SETTLED 必须有 Operation」——其它会话工具一字不变，那条不变量对它们继续成立。
ALTER TABLE session_tool_calls DROP CONSTRAINT ck_session_tool_calls_operation;
ALTER TABLE session_tool_calls ADD CONSTRAINT ck_session_tool_calls_operation CHECK (
  (status = 'REJECTED' AND operation_id IS NULL)
  OR (status IN ('SETTLED', 'UNKNOWN') AND operation_id IS NOT NULL)
  OR (status = 'SETTLED' AND operation_id IS NULL AND tool_name = 'delegate_subagent')
  OR status = 'REQUESTED');
