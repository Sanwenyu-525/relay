-- M06 人工触发的 Git 只读入口：新增第三种 Gateway 来源 USER_ACTION。
-- 依据 docs/architecture/tool-adapters.md 开头 2026-10-02 段与
-- docs/frontend/workbench-design.md §14.9：
--   * prepareGatewayAction 此前只接受 RUN 与 USER_IMPORT 两种 origin，且对非 RUN 只放行
--     FAKE_PUBLIC_READ / WEB_FETCH，因此人工在已登记受管资源上触发 GIT_STATUS / GIT_DIFF
--     没有公开入口。补它必须新增 origin 词表，而不是加一条 SELECT 路由。
--   * USER_ACTION 的语义：人工在受管资源上直接触发的受控动作，没有 run / task / step /
--     import_job，但必须绑定人工 actor、受管资源与能力。人工 actor 落在 activity_records
--     （prepare 事务内写入），本迁移因此不需要任何新增列。
--
-- 本迁移**只放宽三条 CHECK**：不改表结构、不新增表、不新增列、不回填历史行、不改任何已应用
-- 迁移。三条 CHECK 都逐条重述既有分支而不是就地追加——0054 重述 ck_logical_operation_resource
-- 时漏掉 WEB_FETCH 与 FILE_WRITE，造成 9 例既有动作在下一次写入时违反约束，同一类教训。
--
-- 只读为何不建 Invocation claim：resource_claims 强制绑定 task_id / run_id / worker（0008），
-- 人工动作没有这两者，因此 USER_ACTION 调用在 ck_invocation_run_identity 上取「绑定受管资源
-- 但所有 claim / worker 列为 NULL」这一支，与 0016 为 WEB_FETCH 放宽的 RUN 形态同构。
-- 资源排他因此不靠 claim 争用：prepare 与 admit 各自按 listOccupiedResources() 拒绝在途目录
-- （RESOURCE_OCCUPIED），而不是让只读读取与写动作互相阻塞。

-- 1) origin 词表：追加 USER_ACTION。它没有 task/run/step/import_job，这四列必须同时为 NULL，
--    防止「人工动作挂到一个 Run 上」这种既冒充执行权又让 Run 未决列表漏掉它的形态。
ALTER TABLE logical_operations DROP CONSTRAINT ck_logical_operation_origin;
ALTER TABLE logical_operations ADD CONSTRAINT ck_logical_operation_origin CHECK (
  (origin = 'RUN' AND task_id IS NOT NULL AND run_id IS NOT NULL AND step_id IS NOT NULL AND import_job_id IS NULL)
  OR (origin = 'USER_IMPORT' AND task_id IS NULL AND run_id IS NULL AND step_id IS NULL AND import_job_id IS NOT NULL)
  OR (origin = 'USER_ACTION' AND task_id IS NULL AND run_id IS NULL AND step_id IS NULL AND import_job_id IS NULL)
);

-- 2) capability × origin 矩阵：只放行 GIT_READ + USER_ACTION，且必须绑定受管资源。
--    GIT_WRITE / CLI_RUN / FILE_WRITE / FILE_QUERY 一律不放开——人工触发的写入、暂存、提交、
--    推送与受控 CLI 不在本轮范围，写入口继续只有 RUN。
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
);

-- 3) 调用身份：完整保留 0016 的三支，只追加 USER_ACTION 一支——绑定受管资源但没有 Worker、
--    没有 ownership_epoch、也没有资源 claim。这支同时挡住「人工只读动作伪造 Worker 占用」。
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
);

-- 不需要新增 GRANT：本次没有新表、新列或新函数，应用角色沿用 0008/0014/0016/0054 已有的
-- logical_operations 与 invocation_attempts 读写权限。
