-- 普通 Agent 连续工具主流程的最小持久协议（ADR-022 / 运行架构 §2.7.1）。
--
-- 实施任务书要求「修改前先核对现状再定最小协议差异」。核对源码后确认两处真实缺口：
--
--   1) assist_sessions 没有目录列。会话绑定哪个工作目录只存在于浏览器组件状态
--      （CollaborationView.folder → AssistView.executionScope），刷新或换设备就没了；
--      assistant-readonly-round.ts 的 projectManagedResource() 因此只能取 rows[0]，
--      这正是「同项目多个受管资源时任取第一项」。
--      本迁移**只增一列可空列**并把它作为普通会话目录的唯一判定来源。不回填历史行：
--      升级前建的会话为 NULL，按「未绑定目录」处理，不会因为升级就获得新的读取能力。
--
--   2) Gateway 来源只有 ASSISTANT_READ（人设助手）。普通 AGENT 轮次不能复用这个名字：
--      运行架构 §2.6.3 要求两种执行身份不得互相冒充，而 attachOperation() 与
--      originMatches() 都按来源核对；复用会让两类账本行在库层面无法区分。
--      因此新增第五种来源 AGENT_SESSION_READ：与 ASSISTANT_READ 同形（自带 project 与
--      受管资源、会话/消息身份用于核对归属、task/run/step/import_job 四列全 NULL），
--      capability 词表同样只放行 FILE_READ / FILE_QUERY / GIT_READ。
--      写入口继续只有 RUN：本次不给普通会话任何写能力。

-- 三条 CHECK 都**逐条重述**既有分支再追加新支，而不是就地追加——0060 的注释记录了
-- 0054 重述 ck_logical_operation_resource 时漏掉 WEB_FETCH 与 FILE_WRITE，
-- 造成 9 例既有动作在下一次写入时违反约束。这里以 0060 之后的实际约束正文为准。

-- 1) 会话的当前工作目录。只增列，不改既有列、不回填、不建 CHECK：
--    「资源是否 ACTIVE」「是否属于本会话的 Project」属于应用层判定，
--    写进数据库 CHECK 只会让绑定与执行两处规则各有一份。
ALTER TABLE assist_sessions ADD COLUMN working_resource_id uuid
  REFERENCES managed_resources (id);
CREATE INDEX ix_assist_sessions_working_resource ON assist_sessions (working_resource_id)
  WHERE working_resource_id IS NOT NULL;

-- 2) origin 词表：追加 AGENT_SESSION_READ。与 ASSISTANT_READ 同样要求四个执行身份列全为
--    NULL，防止「普通会话的只读动作挂到一个 Run 上」这种既冒充执行权又让 Run 未决列表
--    漏掉它的形态。
ALTER TABLE logical_operations DROP CONSTRAINT ck_logical_operation_origin;
ALTER TABLE logical_operations ADD CONSTRAINT ck_logical_operation_origin CHECK (
  (origin = 'RUN' AND task_id IS NOT NULL AND run_id IS NOT NULL AND step_id IS NOT NULL AND import_job_id IS NULL)
  OR (origin = 'USER_IMPORT' AND task_id IS NULL AND run_id IS NULL AND step_id IS NULL AND import_job_id IS NOT NULL)
  OR (origin = 'USER_ACTION' AND task_id IS NULL AND run_id IS NULL AND step_id IS NULL AND import_job_id IS NULL)
  OR (origin = 'ASSISTANT_READ' AND task_id IS NULL AND run_id IS NULL AND step_id IS NULL AND import_job_id IS NULL)
  OR (origin = 'AGENT_SESSION_READ' AND task_id IS NULL AND run_id IS NULL AND step_id IS NULL AND import_job_id IS NULL)
);

-- 3) capability × origin 矩阵：与 ASSISTANT_READ 同一只读词表。
--    FILE_WRITE / GIT_WRITE / CLI_RUN / WEB_FETCH 一律不放开。
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
  OR (capability_key IN ('FILE_READ', 'FILE_QUERY', 'GIT_READ')
    AND origin = 'AGENT_SESSION_READ' AND resource_id IS NOT NULL)
);

-- 4) 调用身份：完整保留既有五支，只追加 AGENT_SESSION_READ 一支——绑定受管资源但没有
--    Worker、没有 ownership_epoch、没有资源 claim。与 ASSISTANT_READ 同构：只读不建 claim，
--    资源排他靠 prepare 与 admit 各自按 listOccupiedResources() 拒绝在途目录。
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
  OR (origin = 'AGENT_SESSION_READ' AND task_id IS NULL AND run_id IS NULL AND resource_id IS NOT NULL
    AND ownership_epoch IS NULL AND worker_id IS NULL AND worker_epoch IS NULL
    AND resource_claim_id IS NULL AND claim_token IS NULL AND claim_epoch IS NULL)
);

-- 绑定目录是会话自身的一条事实，由 AssistRepository 独占写入；资源本身的写入
-- 仍只归 Gateway 配置入口。
GRANT UPDATE (working_resource_id) ON assist_sessions TO relay_app;