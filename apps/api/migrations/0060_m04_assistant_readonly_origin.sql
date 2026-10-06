-- M04 人设助手 的只读执行身份：第四种 Gateway 来源与它的会话级工具账本。
-- 依据 docs/superpowers/specs/2026-10-05-conversation-mode-and-assistant-readonlys-design.md §3–§5
-- 与 docs/decisions/ADR-018：
--   * B 档要读真实文件，但既有的 run_tool_calls 绑定 Run、Run 属于 Task，而 B 档明确
--     不建 Task 与 Run。绕开 Gateway 直调 file/git adapter 会造出第二条准入路径，
--     违反「Permission/Gateway 控制动作准入」，因此 B 档的只读动作仍走 Gateway，
--     只是换一种来源：ASSISTANT_READ，自带 Project 与受管资源，没有 run/task/step/import_job。
--   * B 档的工具请求行落在新的 session_tool_calls 上，按 (session_id, message_id, round,
--     ordinal) 唯一。它与 run_tool_calls 是两张表而不是一张表的两种形状：两种执行身份
--     不得互相填对方的 id 冒充。
--   * 停止不新增列：沿用 assist_messages.cancel_requested 与既有轮询、CAS 结算。
--
-- 本迁移**只放宽三条 CHECK 并新增一张表**：不改任何表结构、不新增列到既有表、
-- 不回填历史行、不改已应用迁移。三条 CHECK 都逐条重述既有分支而不是就地追加——
-- 0054 重述 ck_logical_operation_resource 时漏掉 WEB_FETCH 与 FILE_WRITE，
-- 造成 9 例既有动作在下一次写入时违反约束，同一类教训。

-- 1) origin 词表：追加 ASSISTANT_READ。task/run/step/import_job 四列必须同时为 NULL，
--    防止「人设会话的只读动作挂到一个 Run 上」这种既冒充执行权又让 Run 未决列表漏掉它的形态。
ALTER TABLE logical_operations DROP CONSTRAINT ck_logical_operation_origin;
ALTER TABLE logical_operations ADD CONSTRAINT ck_logical_operation_origin CHECK (
  (origin = 'RUN' AND task_id IS NOT NULL AND run_id IS NOT NULL AND step_id IS NOT NULL AND import_job_id IS NULL)
  OR (origin = 'USER_IMPORT' AND task_id IS NULL AND run_id IS NULL AND step_id IS NULL AND import_job_id IS NOT NULL)
  OR (origin = 'USER_ACTION' AND task_id IS NULL AND run_id IS NULL AND step_id IS NULL AND import_job_id IS NULL)
  OR (origin = 'ASSISTANT_READ' AND task_id IS NULL AND run_id IS NULL AND step_id IS NULL AND import_job_id IS NULL)
);

-- 2) capability × origin 矩阵：只放行三种只读能力，且必须绑定受管资源。
--    FILE_WRITE / GIT_WRITE / CLI_RUN / WEB_FETCH 一律不放开——B 档是「可读不可写」，
--    写入口继续只有 RUN。
ALTER TABLE logical_operations DROP CONSTRAINT ck_logical_operation_resource;
ALTER TABLE logical_operations ADD CONSTRAINT ck_logical_operation_resource CHECK (
  (capability_key = 'FAKE_WRITE' AND origin = 'RUN' AND resource_id IS NOT NULL)
  OR (capability_key = 'FAKE_PUBLIC_READ' AND origin = 'USER_IMPORT' AND resource_id IS NULL)
  OR (capability_key = 'WEB_FETCH' AND origin = 'RUN' AND resource_id IS NULL)
  OR (capability_key = 'WEB_FETCH' AND origin = 'USER_IMPORT' AND resource_id IS NULL)
  OR (capability_key IN ('FILE_READ', 'FILE_QUERY') AND origin = 'RUN' AND resource_id IS NOT NULL)
  OR (capability_key IN ('FILE_WRITE', 'GIT_READ', 'GIT_WRITE', 'CLI_RUN')
    AND origin = 'RUN' AND resource_id IS NOT NULL)
  OR (capability_key = 'GIT_READ' AND origin = 'USER_ACTION' AND resource_id IS NOT NULL)
  OR (capability_key IN ('FILE_READ', 'FILE_QUERY', 'GIT_READ')
    AND origin = 'ASSISTANT_READ' AND resource_id IS NOT NULL)
);

-- 3) 调用身份：完整保留既有四支，只追加 ASSISTANT_READ 一支——绑定受管资源但没有 Worker、
--    没有 ownership_epoch、也没有资源 claim。与 0058 的 USER_ACTION 同构：
--    只读不建 claim，资源排他靠 prepare 与 admit 各自按 listOccupiedResources() 拒绝
--    在途目录（RESOURCE_OCCUPIED），而不是让只读读取与写动作互相阻塞。
--    这一支同时挡住「人设只读动作伪造 Worker 占用」。
ALTER TABLE invocation_attempts DROP CONSTRAINT ck_invocation_run_identity;
ALTER TABLE invocation_attempts ADD CONSTRAINT ck_invocation_run_identity CHECK (
  (origin = 'USER_IMPORT' AND task_id IS NULL AND run_id IS NULL AND resource_id IS NULL
    AND ownership_epoch IS NULL AND worker_id IS NULL AND worker_epoch IS NULL
    AND resource_claim_id IS NULL AND claim_token IS NULL AND claim_epoch IS NULL)
  OR (origin = 'RUN' AND task_id IS NOT NULL AND run_id IS NOT NULL AND resource_id IS NOT NULL
    AND ownership_epoch IS NOT NULL AND worker_id IS NOT NULL AND worker_epoch IS NOT NULL
    AND resource_claim_id IS NOT NULL AND claim_token IS NOT NULL AND claim_epoch IS NOT NULL)
  OR (origin = 'RUN' AND task_id IS NOT NULL AND run_id IS NOT NULL AND resource_id IS NULL
    AND ownership_epoch IS NOT NULL AND worker_id IS NOT NULL AND worker_epoch IS NOT NULL
    AND resource_claim_id IS NULL AND claim_token IS NULL AND claim_epoch IS NULL)
  OR (origin = 'USER_ACTION' AND task_id IS NULL AND run_id IS NULL AND resource_id IS NOT NULL
    AND ownership_epoch IS NULL AND worker_id IS NULL AND worker_epoch IS NULL
    AND resource_claim_id IS NULL AND claim_token IS NULL AND claim_epoch IS NULL)
  OR (origin = 'ASSISTANT_READ' AND task_id IS NULL AND run_id IS NULL AND resource_id IS NOT NULL
    AND ownership_epoch IS NULL AND worker_id IS NULL AND worker_epoch IS NULL
    AND resource_claim_id IS NULL AND claim_token IS NULL AND claim_epoch IS NULL)
);

-- 4) 会话级工具账本。它是 B 档唯一的工具事实：没有 Run、没有 Step、没有 Attempt。
CREATE TABLE session_tool_calls (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES assist_sessions (id),
  message_id uuid NOT NULL REFERENCES assist_messages (id),
  -- 轮次与序号：一次回答内的第几轮、第几个请求。恢复时按它重建，不依赖内存。
  round integer NOT NULL,
  ordinal integer NOT NULL,
  tool_name text NOT NULL,
  -- 参数逐字节透传（未通过校验时是被拒请求的原文），摘要用于核对未被改写。
  arguments jsonb NOT NULL DEFAULT '{}'::jsonb,
  arguments_sha256 text NOT NULL,
  provider_tool_call_id text,
  -- 被拒请求不连 Operation：模型下一轮看到的是类型化原因，不是一条半可信的动作。
  operation_id uuid REFERENCES logical_operations (id),
  status text NOT NULL DEFAULT 'REQUESTED',
  rejection_reason text,
  rejection_detail text,
  result_digest text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  -- 同一条消息的同一轮同一序号只能有一个请求：重放返回原行，异载荷另说。
  CONSTRAINT uq_session_tool_calls_ordinal UNIQUE (session_id, message_id, round, ordinal),
  CONSTRAINT ck_session_tool_calls_status CHECK (
    status IN ('REQUESTED', 'SETTLED', 'REJECTED', 'ABANDONED', 'UNKNOWN')),
  CONSTRAINT ck_session_tool_calls_round CHECK (round >= 0 AND ordinal >= 0),
  -- 被拒的行必须说明为什么；已结算的行必须有 Operation；UNKNOWN 必须仍留着 Operation。
  CONSTRAINT ck_session_tool_calls_settlement CHECK (
    (status = 'REJECTED' AND rejection_reason IS NOT NULL AND rejection_reason <> ''
      AND operation_id IS NULL AND settled_at IS NOT NULL)
    OR (status <> 'REJECTED' AND rejection_reason IS NULL)
    OR status = 'UNKNOWN'),
  CONSTRAINT ck_session_tool_calls_digest CHECK (
    arguments_sha256 ~ '^[0-9a-f]{64}$'),
  -- Operation 绑定与状态必须自洽：
  --   * REJECTED 从未派发，因此没有 Operation；
  --   * SETTLED / UNKNOWN 已经派发，必须留着原 Operation 身份（UNKNOWN 尤其不能清空）；
  --   * REQUESTED 两种都合法——prepare 已绑定、派发未完成，崩溃后要按这同一个身份核对，
  --     因此这一支不额外收紧，也不允许被当成「什么都没发生」。
  CONSTRAINT ck_session_tool_calls_operation CHECK (
    (status = 'REJECTED' AND operation_id IS NULL)
    OR (status IN ('SETTLED', 'UNKNOWN') AND operation_id IS NOT NULL)
    OR status = 'REQUESTED')
);

CREATE INDEX ix_session_tool_calls_message ON session_tool_calls (message_id, round, ordinal);
CREATE INDEX ix_session_tool_calls_operation ON session_tool_calls (operation_id)
  WHERE operation_id IS NOT NULL;

-- 应用角色对这张表只有读写与状态推进：工具事实只能由 SessionToolCallRepository 写入，
-- 不允许直接删行（删行等于抹掉一次真实读取发生过的事实）。
GRANT SELECT, INSERT ON session_tool_calls TO relay_app;
GRANT UPDATE (status, operation_id, rejection_reason, rejection_detail, result_digest, settled_at)
  ON session_tool_calls TO relay_app;