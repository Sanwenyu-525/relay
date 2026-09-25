-- 0005：P06（Verification 与完成 Gate）所需的 schema 增量，即 V002 第二批。
--
-- 依据：
--   docs/database/physical-design-postgresql.md 第 3、6 节（Verification 与 completion 依据）
--   docs/database/logical-model.md 第 5 节（verification_*、completion_records）
--   contracts/03-verification-and-approval.md 第 3–5、9 节（总决策、绑定集合、失效与 C01–C08）
--   docs/architecture/runtime-context.md 第 4 节（CheckPlan、Checker ERROR 与 HUMAN）
--
-- 只做追加与约束替换，不改写已应用的 0001–0004（迁移入口按内容 SHA-256 校验）。
--
-- 本批次的范围与边界：
--   * 建立 verification_sessions、verification_targets、check_results、verification_applicability；
--   * completion_records 开放 AUTO 依据（绑定 session + run），HUMAN 仍要求 human_acceptances；
--   * acceptance_criteria.method 扩展自动检查方式；target_spec 可声明 HARD/PREFERENCE 分类；
--   * Review/批准仍属 P07；控制请求与资源 claim 仍属 V003；
--   * Worker 不写 CheckPlan：CheckPlan 由应用从冻结契约与注册 checker 派生，session 冻结计划摘要。
--   * check_results 对应用角色只读+插入：历史结果不可改写，撤销适用性另表记录。

-- ---------------------------------------------------------------------------
-- 1. Verification Session / Target / CheckResult / Applicability
-- ---------------------------------------------------------------------------

CREATE TABLE verification_sessions (
  id uuid NOT NULL,
  task_id uuid NOT NULL,
  acceptance_revision bigint NOT NULL,
  run_id uuid,
  execution_contract_id uuid,
  verifier_policy_version text NOT NULL,
  -- 冻结的 CheckPlan 规范摘要：Worker/前端不能改计划而不留下新 session。
  check_plan_hash bytea NOT NULL,
  check_plan jsonb NOT NULL,
  status text NOT NULL,
  verdict text,
  revision bigint NOT NULL DEFAULT 0,
  correction_budget_used bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  CONSTRAINT pk_verification_sessions PRIMARY KEY (id),
  -- 供 completion_records 的 (id, task_id, acceptance_revision) 复合外键引用。
  CONSTRAINT uq_verification_sessions_cycle UNIQUE (id, task_id, acceptance_revision),
  CONSTRAINT fk_verification_sessions_acceptance
    FOREIGN KEY (task_id, acceptance_revision)
    REFERENCES task_acceptances (task_id, acceptance_revision),
  CONSTRAINT fk_verification_sessions_contract
    FOREIGN KEY (execution_contract_id)
    REFERENCES execution_contracts (run_id),
  CONSTRAINT ck_verification_sessions_hash CHECK (octet_length(check_plan_hash) = 32),
  CONSTRAINT ck_verification_sessions_plan CHECK (jsonb_typeof(check_plan) = 'object'),
  CONSTRAINT ck_verification_sessions_policy CHECK (verifier_policy_version <> ''),
  CONSTRAINT ck_verification_sessions_status CHECK (
    status IN ('OPEN', 'PASS', 'RETRY', 'HUMAN')
  ),
  CONSTRAINT ck_verification_sessions_verdict CHECK (
    (status = 'OPEN' AND verdict IS NULL)
    OR (status IN ('PASS', 'RETRY', 'HUMAN') AND verdict = status)
  ),
  CONSTRAINT ck_verification_sessions_revision CHECK (revision >= 0),
  CONSTRAINT ck_verification_sessions_budget CHECK (correction_budget_used >= 0),
  -- run 关联要么同时给出（自动验证路径），要么都为空（人工补验入口，后续阶段）。
  CONSTRAINT ck_verification_sessions_run_pair CHECK (
    (run_id IS NULL AND execution_contract_id IS NULL)
    OR (run_id IS NOT NULL AND execution_contract_id IS NOT NULL)
  )
);

-- 验证及证据查询入口（物理设计第 6 节）。
CREATE INDEX ix_verification_sessions_task
  ON verification_sessions (task_id, acceptance_revision, created_at, id);

CREATE INDEX ix_verification_sessions_run
  ON verification_sessions (run_id, created_at, id)
  WHERE run_id IS NOT NULL;

CREATE TABLE verification_targets (
  session_id uuid NOT NULL,
  artifact_version_id uuid NOT NULL,
  content_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_verification_targets PRIMARY KEY (session_id, artifact_version_id),
  CONSTRAINT fk_verification_targets_session
    FOREIGN KEY (session_id) REFERENCES verification_sessions (id),
  CONSTRAINT fk_verification_targets_version
    FOREIGN KEY (artifact_version_id) REFERENCES artifact_versions (id),
  CONSTRAINT ck_verification_targets_hash CHECK (octet_length(content_hash) = 32)
);

CREATE INDEX ix_verification_targets_version
  ON verification_targets (artifact_version_id);

-- 不可变检查结果：同一 session 内同一 criterion 的同一次检查尝试唯一；
-- 追加补验用更大 check_attempt，不覆盖历史。ERROR 不转 PASS（应用层总决策）。
CREATE TABLE check_results (
  id uuid NOT NULL,
  session_id uuid NOT NULL,
  criterion_id text NOT NULL,
  check_attempt integer NOT NULL,
  checker_id text NOT NULL,
  checker_version text NOT NULL,
  result text NOT NULL,
  required boolean NOT NULL,
  severity text NOT NULL,
  evidence_refs jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_check_results PRIMARY KEY (id),
  CONSTRAINT uq_check_results_attempt UNIQUE (session_id, criterion_id, check_attempt),
  CONSTRAINT fk_check_results_session
    FOREIGN KEY (session_id) REFERENCES verification_sessions (id),
  CONSTRAINT ck_check_results_criterion CHECK (criterion_id <> ''),
  CONSTRAINT ck_check_results_attempt CHECK (check_attempt >= 1),
  CONSTRAINT ck_check_results_checker CHECK (checker_id <> '' AND checker_version <> ''),
  CONSTRAINT ck_check_results_result CHECK (
    result IN ('PASS', 'FAIL', 'UNCERTAIN', 'ERROR', 'NOT_RUN', 'NOT_APPLICABLE')
  ),
  CONSTRAINT ck_check_results_severity CHECK (
    severity IN ('HARD', 'RULE', 'PREFERENCE', 'SEMANTIC')
  ),
  CONSTRAINT ck_check_results_evidence CHECK (jsonb_typeof(evidence_refs) = 'object')
);

CREATE INDEX ix_check_results_session
  ON check_results (session_id, criterion_id, check_attempt);

-- 显式撤销适用性：保留原结果与 verdict，只阻止旧 PASS 继续用于完成提交。
CREATE TABLE verification_applicability (
  session_id uuid NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL,
  source_ref text NOT NULL,
  CONSTRAINT pk_verification_applicability PRIMARY KEY (session_id),
  CONSTRAINT fk_verification_applicability_session
    FOREIGN KEY (session_id) REFERENCES verification_sessions (id),
  CONSTRAINT ck_verification_applicability_reason CHECK (reason <> ''),
  CONSTRAINT ck_verification_applicability_source CHECK (source_ref <> '')
);

-- ---------------------------------------------------------------------------
-- 2. 完成依据扩展：AUTO 绑定 Verification Session 与 Run
-- ---------------------------------------------------------------------------

-- 人工完成仍要求 human_acceptance_id；自动完成改为 verification_session_id + run_id。
ALTER TABLE completion_records DROP CONSTRAINT ck_completion_records_basis;
ALTER TABLE completion_records DROP CONSTRAINT fk_completion_records_human_acceptance;
ALTER TABLE completion_records DROP CONSTRAINT fk_completion_records_acceptance_cycle;

ALTER TABLE completion_records ALTER COLUMN human_acceptance_id DROP NOT NULL;
ALTER TABLE completion_records ADD COLUMN verification_session_id uuid;
ALTER TABLE completion_records ADD COLUMN run_id uuid;

ALTER TABLE completion_records ADD CONSTRAINT fk_completion_records_human_acceptance
  FOREIGN KEY (human_acceptance_id) REFERENCES human_acceptances (id);

ALTER TABLE completion_records ADD CONSTRAINT fk_completion_records_acceptance_cycle
  FOREIGN KEY (human_acceptance_id, task_id, acceptance_revision)
  REFERENCES human_acceptances (id, task_id, acceptance_revision);

ALTER TABLE completion_records ADD CONSTRAINT fk_completion_records_verification_session
  FOREIGN KEY (verification_session_id, task_id, acceptance_revision)
  REFERENCES verification_sessions (id, task_id, acceptance_revision);

ALTER TABLE completion_records ADD CONSTRAINT fk_completion_records_run
  FOREIGN KEY (run_id) REFERENCES runs (id);

-- HUMAN 与 AUTO 依据互斥且必须绑定到本周期的有效证据。
ALTER TABLE completion_records ADD CONSTRAINT ck_completion_records_basis CHECK (
  (
    basis_kind = 'HUMAN'
    AND human_acceptance_id IS NOT NULL
    AND verification_session_id IS NULL
    AND run_id IS NULL
  )
  OR (
    basis_kind = 'AUTO'
    AND human_acceptance_id IS NULL
    AND verification_session_id IS NOT NULL
    AND run_id IS NOT NULL
  )
);

-- ---------------------------------------------------------------------------
-- 3. 验收条件：开放自动检查方式（仍不开放 Worker 改计划）
-- ---------------------------------------------------------------------------

ALTER TABLE acceptance_criteria DROP CONSTRAINT ck_acceptance_criteria_method;
ALTER TABLE acceptance_criteria ADD CONSTRAINT ck_acceptance_criteria_method
  CHECK (method IN (
    'HUMAN',
    -- 确定性 Markdown 结构（必需节、标题、非空）
    'MARKDOWN_STRUCTURE',
    -- 引用标识/链接存在（存在性 ≠ 论断被支持）
    'CITATION_EXISTS',
    -- 语义质量：P06 为 FakeSemanticChecker，真实接入属 P12
    'SEMANTIC'
  ));

-- ---------------------------------------------------------------------------
-- 4. 应用角色权限
-- ---------------------------------------------------------------------------

-- Session 可变事实：状态、总决策、修正预算由应用写入口更新。
GRANT SELECT, INSERT, UPDATE ON verification_sessions TO relay_app;
-- 目标绑定与历史检查结果不可改写：只允许读与首次写入。
GRANT SELECT, INSERT ON verification_targets, check_results TO relay_app;
-- 适用性撤销是一次性事实：读与首次写入。
GRANT SELECT, INSERT ON verification_applicability TO relay_app;
-- completion_records 新列随表级授权生效；重申便于审计。
GRANT SELECT, INSERT ON completion_records TO relay_app;
GRANT SELECT, INSERT, UPDATE ON acceptance_criteria TO relay_app;
