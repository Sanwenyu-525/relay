-- 0004：P05（固定 Workflow、Run/Step/Attempt 与 Delegate）所需的 schema 增量，即 V002 第一批。
--
-- 依据：
--   docs/database/physical-design-postgresql.md 第 2、2.1、2.2、5.1、6、8 节
--   contracts/02-state-and-execution.md 第 1–4 节（Run 迁移、执行权不变量）
--   docs/architecture/runtime-context.md 第 1、2 节（markdown-deliverable-v1 固定步骤、StepResult 边界）
--   docs/api/http-command-contract.md 第 4 节（POST /tasks/{id}/delegations）
--
-- 只做追加，不改写已应用的 0001/0002/0003（迁移入口按内容 SHA-256 校验，改写会被拒绝）。
--
-- 本批次的范围与边界：
--   * 建立 Run 的执行契约、Run、Step、Attempt 与不可变 Context Manifest；
--   * tasks 开放 DELEGATE_AI 与 AI 执行权，并用复合外键保证 executor_run_id 属于同一 Task；
--   * 本批次不建立 Verification/Review（P06/P07）、不建立控制请求与资源 claim（V003）；
--     Run 的 WAITING_APPROVAL/PAUSED 取值先落在 CHECK 内，但本批次没有能设置它们的命令，
--     因此不会出现“能写却无法恢复”的半成品状态。
--   * tasks.status 仍为 INBOX/READY/IN_PROGRESS/DONE/CANCELLED：WAITING/BLOCKED 需要控制请求
--     与阻塞事实，随 P08 的控制用例一起扩展，本批次不提前开放无人能设置的状态。
--   * Fake Worker 只在本进程内执行固定步骤，没有外部副作用，也没有真实模型调用。

-- ---------------------------------------------------------------------------
-- 1. Task 的执行权扩展（V001 只允许 HUMAN）
-- ---------------------------------------------------------------------------

ALTER TABLE tasks ADD COLUMN executor_run_id uuid;

-- V001 的 ck_tasks_mode 只允许 ME/AI_ASSIST；Delegate 用例会原子设置 DELEGATE_AI。
ALTER TABLE tasks DROP CONSTRAINT ck_tasks_mode;
ALTER TABLE tasks ADD CONSTRAINT ck_tasks_mode
  CHECK (mode IN ('ME', 'AI_ASSIST', 'DELEGATE_AI'));

-- 执行者与 Run 指针必须一致：HUMAN 不得带 Run，AI 必须带 Run。
ALTER TABLE tasks DROP CONSTRAINT ck_tasks_executor;
ALTER TABLE tasks ADD CONSTRAINT ck_tasks_executor CHECK (
  (executor_kind = 'HUMAN' AND executor_run_id IS NULL)
  OR (executor_kind = 'AI' AND executor_run_id IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- 2. Run
-- ---------------------------------------------------------------------------

CREATE TABLE runs (
  id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  task_id uuid NOT NULL,
  status text NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  -- Delegate 授予执行权时 Task 的 ownership_epoch 快照：Run 的写提交必须同时匹配
  -- Task 当前 epoch 与 executor_run_id，旧 epoch 的结果不能推进新执行者（契约 02 第 2 节）。
  ownership_epoch bigint NOT NULL,
  -- 人工再次执行时指向原终态 Run；自动 Retry 走同一 Run 内的新 Attempt，不建新 Run。
  retry_of_run_id uuid,
  -- 恢复位置：WAITING_APPROVAL/PAUSED 之后回到哪个 phase 继续。
  resume_phase text,
  wait_reason text,
  current_step_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  terminal_at timestamptz,
  CONSTRAINT pk_runs PRIMARY KEY (id),
  -- 供 tasks(id, executor_run_id) 复合外键引用：Run 必须属于同一个 Task。
  CONSTRAINT uq_runs_task_id UNIQUE (task_id, id),
  CONSTRAINT uq_runs_workspace_id UNIQUE (workspace_id, id),
  CONSTRAINT fk_runs_task
    FOREIGN KEY (workspace_id, task_id) REFERENCES tasks (workspace_id, id),
  CONSTRAINT fk_runs_retry_of FOREIGN KEY (retry_of_run_id) REFERENCES runs (id),
  CONSTRAINT ck_runs_status CHECK (
    status IN (
      'CREATED', 'CONTEXT_BUILDING', 'PLANNING', 'RUNNING', 'WAITING_APPROVAL',
      'VERIFYING', 'RETRYING', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED'
    )
  ),
  CONSTRAINT ck_runs_revision CHECK (revision >= 0),
  CONSTRAINT ck_runs_ownership_epoch CHECK (ownership_epoch >= 0),
  CONSTRAINT ck_runs_retry_of_self CHECK (retry_of_run_id IS NULL OR retry_of_run_id <> id),
  -- 终态与结束时间必须同时成立，避免“已结束但可继续领取”的行。
  CONSTRAINT ck_runs_terminal CHECK (
    (status IN ('COMPLETED', 'FAILED', 'CANCELLED')) = (terminal_at IS NOT NULL)
  ),
  CONSTRAINT ck_runs_resume_phase CHECK (
    resume_phase IS NULL
    OR resume_phase IN ('CONTEXT_BUILDING', 'PLANNING', 'RUNNING', 'VERIFYING', 'RETRYING')
  ),
  CONSTRAINT ck_runs_wait_reason CHECK (wait_reason IS NULL OR wait_reason <> '')
);

-- 一个 Task 至多一个未释放的 AI 执行权占有者（契约 02 第 2 节不变量 1）。
-- PAUSED / WAITING_APPROVAL 仍占有执行权，因此仍在索引内。
CREATE UNIQUE INDEX uq_run_live_task ON runs (task_id)
  WHERE status IN (
    'CREATED', 'CONTEXT_BUILDING', 'PLANNING', 'RUNNING', 'WAITING_APPROVAL',
    'VERIFYING', 'RETRYING', 'PAUSED'
  );

-- 待工作候选：按状态与创建顺序扫描（物理设计第 6 节）。
CREATE INDEX ix_runs_status_created ON runs (status, created_at, id);

-- Task 当前 Run 指针：复合外键保证 Run 属于该 Task；延迟检查允许 Delegate 在同一事务内
-- 先插 Run 再更新 Task。
ALTER TABLE tasks ADD CONSTRAINT fk_tasks_executor_run
  FOREIGN KEY (id, executor_run_id) REFERENCES runs (task_id, id)
  DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------------------
-- 3. 执行契约（创建 Run 时冻结，不可变）
-- ---------------------------------------------------------------------------

CREATE TABLE execution_contracts (
  -- 以 run_id 为 PK：一个 Run 恰有一份冻结契约，不需要额外的 execution_contract_id。
  run_id uuid NOT NULL,
  task_id uuid NOT NULL,
  acceptance_revision bigint NOT NULL,
  workflow_key text NOT NULL,
  workflow_version text NOT NULL,
  execution_config_version text NOT NULL,
  contract_hash bytea NOT NULL,
  -- 冻结时的验收快照（objective、criteria、expected_outputs 与来源版本）。
  frozen_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_execution_contracts PRIMARY KEY (run_id),
  CONSTRAINT fk_execution_contracts_run
    FOREIGN KEY (run_id, task_id) REFERENCES runs (id, task_id),
  CONSTRAINT fk_execution_contracts_acceptance
    FOREIGN KEY (task_id, acceptance_revision) REFERENCES task_acceptances (task_id, acceptance_revision),
  CONSTRAINT ck_execution_contracts_hash CHECK (octet_length(contract_hash) = 32),
  CONSTRAINT ck_execution_contracts_snapshot CHECK (jsonb_typeof(frozen_snapshot) = 'object'),
  CONSTRAINT ck_execution_contracts_workflow CHECK (workflow_key <> '' AND workflow_version <> ''),
  CONSTRAINT ck_execution_contracts_config CHECK (execution_config_version <> '')
);

-- runs.id 反向延迟外键：提交时必须恰好存在一份契约，且不允许把契约挪到别的 Run。
ALTER TABLE runs ADD CONSTRAINT fk_runs_contract
  FOREIGN KEY (id) REFERENCES execution_contracts (run_id)
  DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------------------
-- 4. Step 与 Attempt
-- ---------------------------------------------------------------------------

CREATE TABLE run_steps (
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  step_index integer NOT NULL,
  step_kind text NOT NULL,
  status text NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  result_ref jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_run_steps PRIMARY KEY (id),
  -- 供 runs(id, current_step_id) 复合外键引用。
  CONSTRAINT uq_run_steps_run_id UNIQUE (run_id, id),
  -- 固定 Workflow 的每个步骤在一个 Run 内只出现一次；修正通过新 Attempt 表达，不新建步骤。
  CONSTRAINT uq_run_steps_index UNIQUE (run_id, step_index),
  CONSTRAINT uq_run_steps_kind UNIQUE (run_id, step_kind),
  CONSTRAINT fk_run_steps_run FOREIGN KEY (run_id) REFERENCES runs (id),
  CONSTRAINT ck_run_steps_kind CHECK (
    step_kind IN ('BUILD_CONTEXT', 'DRAFT', 'PERSIST_CANDIDATE', 'VERIFY', 'COMPLETE')
  ),
  CONSTRAINT ck_run_steps_status CHECK (
    status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED')
  ),
  CONSTRAINT ck_run_steps_index CHECK (step_index >= 0),
  CONSTRAINT ck_run_steps_revision CHECK (revision >= 0),
  CONSTRAINT ck_run_steps_result CHECK (result_ref IS NULL OR jsonb_typeof(result_ref) = 'object')
);

ALTER TABLE runs ADD CONSTRAINT fk_runs_current_step
  FOREIGN KEY (id, current_step_id) REFERENCES run_steps (run_id, id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE step_attempts (
  id uuid NOT NULL,
  step_id uuid NOT NULL,
  attempt_number bigint NOT NULL,
  -- 稳定来源尝试 ID：重复提交同一来源尝试（含重放）由唯一约束去重，不产生第二条尝试。
  attempt_key text NOT NULL,
  status text NOT NULL,
  -- Worker 领取与 Task 执行权是两层：claim_epoch 只表达“这次尝试由谁领取”。
  worker_id text,
  claim_epoch bigint NOT NULL DEFAULT 0,
  lease_until timestamptz,
  result_ref jsonb,
  evidence jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_step_attempts PRIMARY KEY (id),
  CONSTRAINT uq_step_attempts_number UNIQUE (step_id, attempt_number),
  CONSTRAINT uq_step_attempts_key UNIQUE (step_id, attempt_key),
  CONSTRAINT fk_step_attempts_step FOREIGN KEY (step_id) REFERENCES run_steps (id),
  CONSTRAINT ck_step_attempts_status CHECK (
    status IN ('PREPARED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'REJECTED_STALE')
  ),
  CONSTRAINT ck_step_attempts_number CHECK (attempt_number >= 1),
  CONSTRAINT ck_step_attempts_key CHECK (attempt_key <> ''),
  CONSTRAINT ck_step_attempts_claim_epoch CHECK (claim_epoch >= 0),
  -- 领取信息必须成对出现，避免“有租约没 worker”或反之的不可解释行。
  CONSTRAINT ck_step_attempts_claim CHECK (
    (worker_id IS NULL AND lease_until IS NULL)
    OR (worker_id IS NOT NULL AND lease_until IS NOT NULL AND worker_id <> '')
  ),
  CONSTRAINT ck_step_attempts_result CHECK (result_ref IS NULL OR jsonb_typeof(result_ref) = 'object'),
  CONSTRAINT ck_step_attempts_evidence CHECK (evidence IS NULL OR jsonb_typeof(evidence) = 'object')
);

-- 过期 Worker 核对：只按在跑尝试的租约扫描。
CREATE INDEX ix_step_attempts_lease ON step_attempts (lease_until, step_id)
  WHERE status = 'RUNNING';

-- ---------------------------------------------------------------------------
-- 5. 不可变 Context Manifest（BUILD_CONTEXT 只装配，不重写快照）
-- ---------------------------------------------------------------------------

CREATE TABLE context_manifests (
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  step_id uuid,
  builder_version text NOT NULL,
  manifest_hash bytea NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_context_manifests PRIMARY KEY (id),
  -- 同一 Run 不重复写同一份快照：重复执行 BUILD_CONTEXT 命中已有 Manifest，不产生第二份。
  CONSTRAINT uq_context_manifests_run_hash UNIQUE (run_id, manifest_hash),
  CONSTRAINT fk_context_manifests_run FOREIGN KEY (run_id) REFERENCES runs (id),
  CONSTRAINT fk_context_manifests_step FOREIGN KEY (step_id) REFERENCES run_steps (id),
  CONSTRAINT ck_context_manifests_hash CHECK (octet_length(manifest_hash) = 32),
  CONSTRAINT ck_context_manifests_payload CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT ck_context_manifests_builder CHECK (builder_version <> '')
);

-- ---------------------------------------------------------------------------
-- 6. 审计主体与产物来源扩展（V001 只有 HUMAN/SYSTEM 与 HUMAN 版本来源）
-- ---------------------------------------------------------------------------

ALTER TABLE activity_records DROP CONSTRAINT ck_activity_records_actor;
ALTER TABLE activity_records ADD CONSTRAINT ck_activity_records_actor
  CHECK (actor_kind IN ('HUMAN', 'SYSTEM', 'AI'));

-- PERSIST_CANDIDATE 由 Worker 写入候选版本；版本本身仍不可变，只扩展来源取值。
-- 人工保存入口仍要求 HUMAN 执行权，不会因为这里放开取值就允许 Worker 冒充人工保存。
ALTER TABLE artifact_versions DROP CONSTRAINT ck_artifact_versions_source_kind;
ALTER TABLE artifact_versions ADD CONSTRAINT ck_artifact_versions_source_kind
  CHECK (source_kind IN ('HUMAN', 'AI'));

-- ---------------------------------------------------------------------------
-- 7. 应用角色权限
-- ---------------------------------------------------------------------------
-- 可变的运行事实：状态、位置、租约与结果由应用角色更新。
GRANT SELECT, INSERT, UPDATE ON runs, run_steps, step_attempts TO relay_app;
-- 不可变事实：只允许读与首次写入，与 execution_contracts/context_manifests 的语义一致。
GRANT SELECT, INSERT ON execution_contracts, context_manifests TO relay_app;
-- 新增列随 tasks 的表级授权生效；这里重申，便于审计“新增列不会造成 42501”。
GRANT SELECT, INSERT, UPDATE ON tasks TO relay_app;
