-- 会话内直接写文件：新增 AGENT_SESSION_WRITE 来源（2026-10-20）。
--
-- 背景：0060 / 0087 把会话轮次定为「可读不可写」，写入口只有 RUN。用户明确要求
-- 「会话内直接写」，因此新增第六种来源。
--
-- 为什么不是放宽 AGENT_SESSION_READ：读身份只读是一条要在库层面成立的语义。
-- 放宽它会让 attachOperation() 与 originMatches() 的按来源核对失去意义，也让
-- 「这条会话动作到底是读还是写」在账本上无法分辨。新增来源是唯一不改语义的做法。
--
-- 为什么只放行 FILE_WRITE 能力、且应用层再收一层到 APPLY_CHANGESET：
--   会话没有 Run 的 resource_claim 保护（resource_claims 强制绑定 task/run/worker，
--   0060 与 0058 都记过这条限制）。两个会话并发写同一文件时，唯一可靠的闸门是
--   apply_changeset 的 SHA-256 基线——prepare 与落盘前各无条件比对一次，后到者
--   按 TOOL_CHANGESET_BASELINE_CONFLICT 拒绝，而不是悄悄覆盖对方刚写的正文。
--   WRITE_FILE（全文覆盖、无基线）因此不开放给会话来源。
--
-- 排他口径与 USER_ACTION 一致：不建 claim，靠 prepare 与 admit 各自按
-- listOccupiedResources() 拒绝在途目录。这不是更弱的检查，而是同一规则的另一种表达。
--
-- 三条 CHECK 均按**最新正文**逐条重述：ck_logical_operation_origin 与
-- ck_invocation_run_identity 以 0087 为准，ck_logical_operation_resource 以 0105 为准
-- （含 COMPUTER / GITHUB / BROWSER 分支）。0060 注释记录过 0054 重述时漏掉
-- WEB_FETCH 与 FILE_WRITE、造成 9 例既有动作违反约束；这里以正文重述，不照抄旧版。

-- 1) origin 词表：追加 AGENT_SESSION_WRITE。与 AGENT_SESSION_READ 同形——四个执行
--    身份列全为 NULL，防止「会话的写动作挂到一个 Run 上」这种既冒充执行权、又让
--    Run 未决列表漏掉它的形态。
ALTER TABLE logical_operations DROP CONSTRAINT ck_logical_operation_origin;
ALTER TABLE logical_operations ADD CONSTRAINT ck_logical_operation_origin CHECK (
  (origin = 'RUN' AND task_id IS NOT NULL AND run_id IS NOT NULL AND step_id IS NOT NULL AND import_job_id IS NULL)
  OR (origin = 'USER_IMPORT' AND task_id IS NULL AND run_id IS NULL AND step_id IS NULL AND import_job_id IS NOT NULL)
  OR (origin = 'USER_ACTION' AND task_id IS NULL AND run_id IS NULL AND step_id IS NULL AND import_job_id IS NULL)
  OR (origin = 'ASSISTANT_READ' AND task_id IS NULL AND run_id IS NULL AND step_id IS NULL AND import_job_id IS NULL)
  OR (origin = 'AGENT_SESSION_READ' AND task_id IS NULL AND run_id IS NULL AND step_id IS NULL AND import_job_id IS NULL)
  OR (origin = 'AGENT_SESSION_WRITE' AND task_id IS NULL AND run_id IS NULL AND step_id IS NULL AND import_job_id IS NULL)
);

-- 2) capability × origin 矩阵：只给 AGENT_SESSION_WRITE 追加 FILE_WRITE。
--    GIT_WRITE / CLI_RUN / WEB_FETCH 一律不放开——会话写只改本会话绑定目录内的文件。
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
  OR (capability_key = 'FILE_WRITE'
    AND origin = 'AGENT_SESSION_WRITE' AND resource_id IS NOT NULL)
  OR (capability_key = 'COMPUTER_READ'
    AND origin IN ('ASSISTANT_READ', 'AGENT_SESSION_READ') AND resource_id IS NOT NULL)
  OR (capability_key IN ('COMPUTER_READ', 'COMPUTER_INPUT')
    AND origin = 'RUN' AND resource_id IS NOT NULL)
  OR (capability_key = 'GITHUB_READ'
    AND origin IN ('ASSISTANT_READ', 'AGENT_SESSION_READ') AND resource_id IS NOT NULL)
  OR (capability_key = 'BROWSER_READ'
    AND origin IN ('ASSISTANT_READ', 'AGENT_SESSION_READ') AND resource_id IS NOT NULL)
  OR (capability_key IN ('BROWSER_READ', 'BROWSER_ACTION', 'BROWSER_COMMIT')
    AND origin = 'RUN' AND resource_id IS NOT NULL)
);

-- 3) 调用身份：追加 AGENT_SESSION_WRITE 一支——绑定受管资源但没有 Worker、没有
--    ownership_epoch、没有资源 claim。与 AGENT_SESSION_READ 同构；差别只在 capability
--    词表与账本来源可分辨，不在调用身份的形状。
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
  OR (origin = 'AGENT_SESSION_WRITE' AND task_id IS NULL AND run_id IS NULL AND resource_id IS NOT NULL
    AND ownership_epoch IS NULL AND worker_id IS NULL AND worker_epoch IS NULL
    AND resource_claim_id IS NULL AND claim_token IS NULL AND claim_epoch IS NULL)
);
