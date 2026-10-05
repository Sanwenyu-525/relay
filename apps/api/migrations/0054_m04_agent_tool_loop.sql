-- M04 内部工具循环：模型可自主调用的只读文件查询能力，以及一次工具请求与其
-- Gateway 逻辑动作之间的持久对应。
-- 依据 docs/architecture/runtime-context.md §2.3 与 docs/architecture/tool-adapters.md §1.4：
--   * FILE_QUERY 是第三个 REAL 只读能力：目录浏览、路径查找与内容搜索共用同一套
--     受管根边界与权限前缀判定，只有 action_type 区分查询形态。与 FILE_READ 一样
--     不产生副作用，恢复走安全重读而不是 UNKNOWN 隔离。
--   * run_tool_calls 行的 id 直接作为 logical_operations.id：工具请求一旦落库就
--     有了稳定动作身份，重放沿用同一行，Provider 的 tool_call_id 不承担唯一性。
--   * 未派发行（REJECTED）不连 Operation；已准备/已结算行必须指向真实 Operation，
--     复合外键保证二者同属一次调用。
--   * 循环 transcript 不保存：模型工具请求取自 arguments，工具结果取自该行
--     operation 的 result_ref，恢复不需要也不保存私有思考链或正文副本。

INSERT INTO gateway_capabilities VALUES ('FILE_QUERY', 'REAL', 'READ');

ALTER TABLE logical_operations DROP CONSTRAINT ck_logical_operation_resource;
-- 完整保留 0030 的既有分支（含 WEB_FETCH 的 RUN 无资源与 USER_IMPORT 两种形态），
-- 只把 FILE_QUERY 并入「RUN 且绑定受管资源」那一支。漏掉任何一支都会让历史动作在
-- 下一次写入时违反约束，因此这里逐条重述而不是就地追加。
ALTER TABLE logical_operations ADD CONSTRAINT ck_logical_operation_resource CHECK (
  (capability_key = 'FAKE_WRITE' AND origin = 'RUN' AND resource_id IS NOT NULL)
  OR (capability_key = 'FAKE_PUBLIC_READ' AND origin = 'USER_IMPORT' AND resource_id IS NULL)
  OR (capability_key = 'WEB_FETCH' AND origin = 'RUN' AND resource_id IS NULL)
  OR (capability_key = 'WEB_FETCH' AND origin = 'USER_IMPORT' AND resource_id IS NULL)
  OR (capability_key IN ('FILE_READ', 'FILE_QUERY') AND origin = 'RUN' AND resource_id IS NOT NULL)
  OR (capability_key IN ('FILE_WRITE', 'GIT_READ', 'GIT_WRITE', 'CLI_RUN')
    AND origin = 'RUN' AND resource_id IS NOT NULL)
);

CREATE TABLE run_tool_calls (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  -- 固定 Workflow 里工具请求只发生在 DRAFT Attempt 内；行与该 Attempt 同生共死。
  step_id uuid NOT NULL,
  step_attempt_id uuid NOT NULL,
  -- 产生本次请求的那一次真实模型调用；同一轮可能有多个工具请求。
  model_call_id uuid NOT NULL REFERENCES model_calls (id),
  -- 0 起轮次；同一 Attempt 内单调递增，重放按此定位原轮次。
  round integer NOT NULL,
  -- 本轮内第几个请求（0 起）。Provider 的 tool_call_id 只是轮内关联标签，
  -- 跨 Run/轮次可能重名，因此唯一性由 (attempt, round, ordinal) 与本行 id 承担。
  ordinal integer NOT NULL,
  provider_tool_call_id text NOT NULL,
  tool_name text NOT NULL,
  -- 已通过 schema 校验并规范化的参数；半截/非法参数在落库前即被拒绝。
  arguments jsonb NOT NULL,
  arguments_sha256 text NOT NULL,
  status text NOT NULL,
  -- 派发后指向真实 Operation；未派发行保持 NULL。
  operation_id uuid,
  -- 供下一轮模型消费的有界结果投影；REJECTED 行只带类型化原因。
  result_ref jsonb,
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- 一个 Attempt 的一轮里同一个位置只有一个请求：重放不会插入第二行。
  CONSTRAINT uq_run_tool_calls_position UNIQUE (step_attempt_id, round, ordinal),
  CONSTRAINT fk_run_tool_calls_run FOREIGN KEY (workspace_id, run_id)
    REFERENCES runs (workspace_id, id),
  CONSTRAINT fk_run_tool_calls_project FOREIGN KEY (workspace_id, project_id)
    REFERENCES projects (workspace_id, id),
  CONSTRAINT fk_run_tool_calls_attempt FOREIGN KEY (step_attempt_id, step_id)
    REFERENCES step_attempts (id, step_id),
  CONSTRAINT fk_run_tool_calls_model_call FOREIGN KEY (model_call_id)
    REFERENCES model_calls (id),
  -- 已连上 Operation 的行必须与该 Operation 同属本次调用，避免结果被错挂。
  CONSTRAINT fk_run_tool_calls_operation FOREIGN KEY (operation_id)
    REFERENCES logical_operations (id),
  CONSTRAINT ck_run_tool_calls_round CHECK (round >= 0),
  CONSTRAINT ck_run_tool_calls_ordinal CHECK (ordinal >= 0),
  CONSTRAINT ck_run_tool_calls_status CHECK (
    status IN ('REQUESTED', 'PREPARED', 'WAITING_APPROVAL', 'SETTLED', 'REJECTED', 'ABANDONED')),
  CONSTRAINT ck_run_tool_calls_arguments CHECK (
    jsonb_typeof(arguments) = 'object'
    AND arguments_sha256 ~ '^[0-9a-f]{64}$'),
  -- REJECTED/REQUESTED 尚未连 Operation；一旦派发就必须在同一次提交里带上身份。
  CONSTRAINT ck_run_tool_calls_operation_binding CHECK (
    (status IN ('REQUESTED', 'REJECTED') AND operation_id IS NULL)
    OR (status IN ('PREPARED', 'WAITING_APPROVAL', 'SETTLED', 'ABANDONED') AND operation_id IS NOT NULL)),
  -- 未派发必须留下类型化原因，不能只留一个状态字。
  CONSTRAINT ck_run_tool_calls_rejected_reason CHECK (
    status <> 'REJECTED' OR (result_ref IS NOT NULL
      AND jsonb_typeof(result_ref) = 'object'
      AND result_ref ? 'reason' AND result_ref ? 'detail')),
  CONSTRAINT ck_run_tool_calls_result CHECK (result_ref IS NULL OR jsonb_typeof(result_ref) = 'object')
);

CREATE INDEX ix_run_tool_calls_run ON run_tool_calls (run_id, round, ordinal);
CREATE INDEX ix_run_tool_calls_pending ON run_tool_calls (run_id, created_at, id)
  WHERE status IN ('REQUESTED', 'PREPARED', 'WAITING_APPROVAL');

-- 请求、工具名与参数摘要写入后不可改写；只允许推进状态、绑定动作身份与写入结果。
-- 恢复核对因此总能看到「模型实际请求了什么」，不能被后续轮次覆盖成别的参数。
GRANT SELECT, INSERT ON run_tool_calls TO relay_app;
GRANT UPDATE (status, operation_id, result_ref, revision, updated_at) ON run_tool_calls TO relay_app;