-- V001：人工闭环必要的表、约束、索引与应用角色权限。
--
-- 依据：
--   docs/database/logical-model.md（身份、Owner、字段语义）
--   docs/database/physical-design-postgresql.md 第 2、3、6、8 节（类型、约束、索引、V001 批次）
--   docs/development/first-human-slice.md（工程形态与角色分离）
--
-- 约定：
--   * uuid 主键由应用预分配；revision/epoch/acceptance_revision 用 bigint，公开 JSON 用十进制字符串。
--   * 状态/类型使用 text + 有名称的 CHECK，后续批次用新 migration 显式扩展合法取值。
--   * 跨 Workspace 引用使用复合外键；循环外键只在必要时 DEFERRABLE INITIALLY DEFERRED。
--   * 不可变历史表对应用角色只授予 SELECT/INSERT，不授予 UPDATE/DELETE。
--   * 本文件一旦应用即不可改写；迁移入口按内容 SHA-256 校验（relay_schema_migrations）。
--
-- 本批次不创建（留给 V002/V003 及后续 migration）：runs、execution_contracts、run_steps、
-- execution_attempts、verification_*、review_*、permission_*、managed_resources、resource_claims、
-- logical_operations、invocation_*、reconciliation_records、run_control_requests、run_worker_claims、
-- decisions（state_decision_refs 因此留待建好目标表后新增）。V001 不引用尚未存在的表。
--
-- 前置：迁移角色持有 DDL 与表所有权；应用角色 relay_app 已由 sql/bootstrap-roles.sql 创建。

-- ---------------------------------------------------------------------------
-- 1. Workspace 与 Workspace 级执行权威
-- ---------------------------------------------------------------------------

CREATE TABLE workspaces (
  id uuid NOT NULL,
  name text NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_workspaces PRIMARY KEY (id),
  CONSTRAINT ck_workspaces_name CHECK (name <> ''),
  CONSTRAINT ck_workspaces_revision CHECK (revision >= 0)
);

-- 物理设计第 4 节：Workspace 创建时同步建立该行，动作准入与权限撤销以它为串行化点。
CREATE TABLE workspace_execution_authority (
  workspace_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_workspace_execution_authority PRIMARY KEY (workspace_id),
  CONSTRAINT fk_workspace_execution_authority_workspace
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  CONSTRAINT ck_workspace_execution_authority_revision CHECK (revision >= 0)
);

-- ---------------------------------------------------------------------------
-- 2. Project 与 Goal
-- ---------------------------------------------------------------------------

CREATE TABLE projects (
  id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  title text NOT NULL,
  project_type text NOT NULL,
  archived_at timestamptz,
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_projects PRIMARY KEY (id),
  CONSTRAINT uq_projects_workspace_id UNIQUE (workspace_id, id),
  CONSTRAINT fk_projects_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  CONSTRAINT ck_projects_title CHECK (title <> ''),
  CONSTRAINT ck_projects_type CHECK (project_type IN ('GENERAL', 'THESIS', 'DEVELOPMENT')),
  CONSTRAINT ck_projects_revision CHECK (revision >= 0)
);

CREATE TABLE goals (
  id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_goals PRIMARY KEY (id),
  CONSTRAINT uq_goals_workspace_id UNIQUE (workspace_id, id),
  CONSTRAINT fk_goals_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  CONSTRAINT ck_goals_title CHECK (title <> ''),
  CONSTRAINT ck_goals_status CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  CONSTRAINT ck_goals_revision CHECK (revision >= 0)
);

-- 关联表冗余 workspace_id，用复合外键保证 Project 与 Goal 同 Workspace。
CREATE TABLE project_goals (
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  goal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_project_goals PRIMARY KEY (project_id, goal_id),
  CONSTRAINT fk_project_goals_project
    FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id),
  CONSTRAINT fk_project_goals_goal
    FOREIGN KEY (workspace_id, goal_id) REFERENCES goals (workspace_id, id)
);

-- ---------------------------------------------------------------------------
-- 3. Task、验收契约与显式 Goal 对齐
-- ---------------------------------------------------------------------------

CREATE TABLE tasks (
  id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  project_id uuid,
  title text NOT NULL,
  status text NOT NULL,
  mode text NOT NULL,
  acceptance_revision bigint NOT NULL,
  executor_kind text NOT NULL,
  ownership_epoch bigint NOT NULL DEFAULT 0,
  current_completion_id uuid,
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_tasks PRIMARY KEY (id),
  CONSTRAINT uq_tasks_workspace_id UNIQUE (workspace_id, id),
  CONSTRAINT uq_tasks_id_project UNIQUE (id, project_id),
  CONSTRAINT uq_tasks_project_id UNIQUE (project_id, id),
  CONSTRAINT fk_tasks_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  CONSTRAINT fk_tasks_project
    FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id),
  CONSTRAINT ck_tasks_title CHECK (title <> ''),
  -- V001 只有人工执行权；AI 相关状态与 DELEGATE_AI 在 V002 建好 runs 后扩展。
  CONSTRAINT ck_tasks_status CHECK (
    status IN ('INBOX', 'READY', 'IN_PROGRESS', 'DONE', 'CANCELLED')
  ),
  CONSTRAINT ck_tasks_mode CHECK (mode IN ('ME', 'AI_ASSIST')),
  CONSTRAINT ck_tasks_executor CHECK (executor_kind = 'HUMAN'),
  -- 显式写 IS NOT NULL：NULL 不能让完成指针与状态脱钩。
  CONSTRAINT ck_tasks_completion CHECK (
    (status = 'DONE' AND current_completion_id IS NOT NULL)
    OR (status <> 'DONE' AND current_completion_id IS NULL)
  ),
  CONSTRAINT ck_tasks_acceptance_revision CHECK (acceptance_revision >= 1),
  CONSTRAINT ck_tasks_ownership_epoch CHECK (ownership_epoch >= 0),
  CONSTRAINT ck_tasks_revision CHECK (revision >= 0)
);

-- 不可变验收版本；重开也创建新版本，不覆盖旧版本。
CREATE TABLE task_acceptances (
  task_id uuid NOT NULL,
  acceptance_revision bigint NOT NULL,
  objective text NOT NULL,
  required_output_spec jsonb NOT NULL,
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_task_acceptances PRIMARY KEY (task_id, acceptance_revision),
  CONSTRAINT fk_task_acceptances_task FOREIGN KEY (task_id) REFERENCES tasks (id),
  CONSTRAINT ck_task_acceptances_revision CHECK (acceptance_revision >= 1),
  CONSTRAINT ck_task_acceptances_objective CHECK (objective <> ''),
  CONSTRAINT ck_task_acceptances_source CHECK (
    source IN ('CREATE', 'REOPEN', 'CONTRACT_CHANGE')
  ),
  CONSTRAINT ck_task_acceptances_output_spec CHECK (jsonb_typeof(required_output_spec) = 'object')
);

-- 版本内 criterion_id 唯一；改动生成新验收版本，不原地修改。
CREATE TABLE acceptance_criteria (
  task_id uuid NOT NULL,
  acceptance_revision bigint NOT NULL,
  criterion_id text NOT NULL,
  statement text NOT NULL,
  required boolean NOT NULL,
  method text NOT NULL,
  target_spec jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_acceptance_criteria PRIMARY KEY (task_id, acceptance_revision, criterion_id),
  CONSTRAINT fk_acceptance_criteria_acceptance
    FOREIGN KEY (task_id, acceptance_revision)
    REFERENCES task_acceptances (task_id, acceptance_revision),
  CONSTRAINT ck_acceptance_criteria_id CHECK (criterion_id <> ''),
  CONSTRAINT ck_acceptance_criteria_statement CHECK (statement <> ''),
  -- 人工切片只开放 HUMAN；自动检查方式在建立 Verification 后扩展。
  CONSTRAINT ck_acceptance_criteria_method CHECK (method IN ('HUMAN')),
  CONSTRAINT ck_acceptance_criteria_target CHECK (jsonb_typeof(target_spec) = 'object')
);

-- 显式 Goal 对齐：三列均非空，冗余 project_id 由复合外键保证与 Task/Project 一致。
CREATE TABLE task_explicit_goals (
  task_id uuid NOT NULL,
  project_id uuid NOT NULL,
  goal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_task_explicit_goals PRIMARY KEY (task_id, goal_id),
  CONSTRAINT fk_task_explicit_goals_task
    FOREIGN KEY (task_id, project_id) REFERENCES tasks (id, project_id),
  CONSTRAINT fk_task_explicit_goals_project_goal
    FOREIGN KEY (project_id, goal_id) REFERENCES project_goals (project_id, goal_id)
);

-- 依赖关系的两个端点都必须与非空 workspace_id 组合，避免跨 Workspace 依赖。
CREATE TABLE task_dependencies (
  workspace_id uuid NOT NULL,
  task_id uuid NOT NULL,
  depends_on_task_id uuid NOT NULL,
  dependency_kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_task_dependencies PRIMARY KEY (task_id, depends_on_task_id),
  CONSTRAINT fk_task_dependencies_task
    FOREIGN KEY (workspace_id, task_id) REFERENCES tasks (workspace_id, id),
  CONSTRAINT fk_task_dependencies_depends_on
    FOREIGN KEY (workspace_id, depends_on_task_id) REFERENCES tasks (workspace_id, id),
  CONSTRAINT ck_task_dependencies_not_self CHECK (task_id <> depends_on_task_id),
  CONSTRAINT ck_task_dependencies_kind CHECK (dependency_kind IN ('BLOCKS', 'INFORMS'))
);

-- ---------------------------------------------------------------------------
-- 4. Project State 与类型化引用
-- ---------------------------------------------------------------------------

CREATE TABLE project_states (
  project_id uuid NOT NULL,
  phase_key text NOT NULL,
  next_action_task_id uuid,
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_project_states PRIMARY KEY (project_id),
  CONSTRAINT fk_project_states_project FOREIGN KEY (project_id) REFERENCES projects (id),
  CONSTRAINT fk_project_states_next_action
    FOREIGN KEY (project_id, next_action_task_id) REFERENCES tasks (project_id, id),
  -- phase_key 属于 Project Type 的阶段词汇，可版本化配置，不在 V001 固化取值。
  CONSTRAINT ck_project_states_phase CHECK (phase_key <> ''),
  CONSTRAINT ck_project_states_revision CHECK (revision >= 0)
);

CREATE TABLE project_blockers (
  id uuid NOT NULL,
  project_id uuid NOT NULL,
  target_kind text NOT NULL,
  target_id uuid NOT NULL,
  reason text NOT NULL,
  source_ref text NOT NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_project_blockers PRIMARY KEY (id),
  CONSTRAINT fk_project_blockers_project FOREIGN KEY (project_id) REFERENCES projects (id),
  CONSTRAINT ck_project_blockers_target_kind CHECK (target_kind IN ('PROJECT', 'TASK', 'GOAL')),
  CONSTRAINT ck_project_blockers_reason CHECK (reason <> ''),
  CONSTRAINT ck_project_blockers_source CHECK (source_ref <> '')
);

CREATE TABLE project_risks (
  id uuid NOT NULL,
  project_id uuid NOT NULL,
  statement text NOT NULL,
  source_ref text NOT NULL,
  confirmation_ref text NOT NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_project_risks PRIMARY KEY (id),
  CONSTRAINT fk_project_risks_project FOREIGN KEY (project_id) REFERENCES projects (id),
  CONSTRAINT ck_project_risks_statement CHECK (statement <> ''),
  CONSTRAINT ck_project_risks_source CHECK (source_ref <> ''),
  CONSTRAINT ck_project_risks_confirmation CHECK (confirmation_ref <> '')
);

-- ---------------------------------------------------------------------------
-- 5. Artifact 与不可变版本
-- ---------------------------------------------------------------------------

CREATE TABLE artifacts (
  id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  project_id uuid,
  task_id uuid NOT NULL,
  artifact_kind text NOT NULL,
  title text NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_artifacts PRIMARY KEY (id),
  CONSTRAINT fk_artifacts_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  -- 单独一条 task_id 外键：project_id 为空时复合外键不检查，Task 归属仍需成立。
  CONSTRAINT fk_artifacts_task FOREIGN KEY (task_id) REFERENCES tasks (id),
  CONSTRAINT fk_artifacts_task_project
    FOREIGN KEY (task_id, project_id) REFERENCES tasks (id, project_id),
  CONSTRAINT fk_artifacts_project
    FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id),
  CONSTRAINT ck_artifacts_kind CHECK (artifact_kind IN ('MARKDOWN_DOCUMENT')),
  CONSTRAINT ck_artifacts_title CHECK (title <> ''),
  CONSTRAINT ck_artifacts_revision CHECK (revision >= 0)
);

-- 只有完整保存后才登记；版本不可变，应用角色无 UPDATE/DELETE。
CREATE TABLE artifact_versions (
  id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  version_number bigint NOT NULL,
  storage_ref text NOT NULL,
  content_hash bytea NOT NULL,
  size bigint NOT NULL,
  media_type text NOT NULL,
  source_kind text NOT NULL,
  source_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_artifact_versions PRIMARY KEY (id),
  CONSTRAINT uq_artifact_versions_number UNIQUE (artifact_id, version_number),
  CONSTRAINT fk_artifact_versions_artifact FOREIGN KEY (artifact_id) REFERENCES artifacts (id),
  CONSTRAINT ck_artifact_versions_number CHECK (version_number >= 1),
  CONSTRAINT ck_artifact_versions_hash CHECK (octet_length(content_hash) = 32),
  CONSTRAINT ck_artifact_versions_size CHECK (size >= 0),
  CONSTRAINT ck_artifact_versions_media_type CHECK (media_type IN ('text/markdown')),
  -- 人工切片只登记人工保存的版本；Worker/导入来源在后续批次扩展。
  CONSTRAINT ck_artifact_versions_source_kind CHECK (source_kind IN ('HUMAN')),
  -- 只保存受管相对路径：禁止绝对路径、盘符、上级目录与冒号。
  CONSTRAINT ck_artifact_versions_storage_ref CHECK (
    storage_ref <> ''
    AND position('/' in left(storage_ref, 1)) = 0
    AND position('\' in left(storage_ref, 1)) = 0
    AND position('..' in storage_ref) = 0
    AND position(':' in storage_ref) = 0
  )
);

-- ---------------------------------------------------------------------------
-- 6. 人工接受与完成凭据
-- ---------------------------------------------------------------------------

CREATE TABLE human_acceptances (
  id uuid NOT NULL,
  task_id uuid NOT NULL,
  acceptance_revision bigint NOT NULL,
  actor_kind text NOT NULL,
  actor_ref text NOT NULL,
  statement text NOT NULL,
  accepted_criterion_ids jsonb NOT NULL,
  accepted_version_refs jsonb NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_human_acceptances PRIMARY KEY (id),
  CONSTRAINT uq_human_acceptances_cycle UNIQUE (id, task_id, acceptance_revision),
  CONSTRAINT fk_human_acceptances_acceptance
    FOREIGN KEY (task_id, acceptance_revision)
    REFERENCES task_acceptances (task_id, acceptance_revision),
  CONSTRAINT ck_human_acceptances_revision CHECK (acceptance_revision >= 1),
  CONSTRAINT ck_human_acceptances_actor CHECK (actor_kind IN ('HUMAN')),
  CONSTRAINT ck_human_acceptances_actor_ref CHECK (actor_ref <> ''),
  CONSTRAINT ck_human_acceptances_statement CHECK (statement <> ''),
  CONSTRAINT ck_human_acceptances_criteria CHECK (jsonb_typeof(accepted_criterion_ids) = 'array'),
  CONSTRAINT ck_human_acceptances_versions CHECK (jsonb_typeof(accepted_version_refs) = 'array')
);

-- 周期唯一：两个不同 command_id 也不能在同一 acceptance_revision 完成两次。
CREATE TABLE completion_records (
  id uuid NOT NULL,
  task_id uuid NOT NULL,
  acceptance_revision bigint NOT NULL,
  basis_kind text NOT NULL,
  human_acceptance_id uuid NOT NULL,
  state_delta jsonb NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_completion_records PRIMARY KEY (id),
  CONSTRAINT uq_completion_records_cycle UNIQUE (task_id, acceptance_revision),
  CONSTRAINT uq_completion_records_cycle_id UNIQUE (task_id, acceptance_revision, id),
  CONSTRAINT fk_completion_records_acceptance
    FOREIGN KEY (task_id, acceptance_revision)
    REFERENCES task_acceptances (task_id, acceptance_revision),
  CONSTRAINT fk_completion_records_human_acceptance
    FOREIGN KEY (human_acceptance_id) REFERENCES human_acceptances (id),
  -- 完成依据必须属于同一 Task 周期，不能借别人的接受记录完成本轮。
  CONSTRAINT fk_completion_records_acceptance_cycle
    FOREIGN KEY (human_acceptance_id, task_id, acceptance_revision)
    REFERENCES human_acceptances (id, task_id, acceptance_revision),
  -- 人工切片只允许人工完成依据；自动完成在 Verification 落地后扩展。
  CONSTRAINT ck_completion_records_basis CHECK (basis_kind IN ('HUMAN')),
  CONSTRAINT ck_completion_records_revision CHECK (acceptance_revision >= 1),
  CONSTRAINT ck_completion_records_delta CHECK (jsonb_typeof(state_delta) = 'object')
);

-- State 的类型化引用使用真实外键，不用裸多态 ID。
-- state_decision_refs 需要尚未存在的 decisions 表，留待 D 阶段 migration 新增。
CREATE TABLE state_completion_refs (
  project_id uuid NOT NULL,
  completion_id uuid NOT NULL,
  source_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_state_completion_refs PRIMARY KEY (project_id, completion_id),
  CONSTRAINT fk_state_completion_refs_project
    FOREIGN KEY (project_id) REFERENCES project_states (project_id),
  CONSTRAINT fk_state_completion_refs_completion
    FOREIGN KEY (completion_id) REFERENCES completion_records (id),
  CONSTRAINT ck_state_completion_refs_source CHECK (source_ref <> '')
);

CREATE TABLE state_artifact_refs (
  project_id uuid NOT NULL,
  artifact_version_id uuid NOT NULL,
  source_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_state_artifact_refs PRIMARY KEY (project_id, artifact_version_id),
  CONSTRAINT fk_state_artifact_refs_project
    FOREIGN KEY (project_id) REFERENCES project_states (project_id),
  CONSTRAINT fk_state_artifact_refs_version
    FOREIGN KEY (artifact_version_id) REFERENCES artifact_versions (id),
  CONSTRAINT ck_state_artifact_refs_source CHECK (source_ref <> '')
);

-- ---------------------------------------------------------------------------
-- 7. 循环外键：建表完成后用 ALTER 添加，并在提交时校验
-- ---------------------------------------------------------------------------

-- Task 当前验收指针（CreateTask 在同一事务内插入 Task 与 acceptance v1）。
ALTER TABLE tasks ADD CONSTRAINT fk_tasks_current_acceptance
  FOREIGN KEY (id, acceptance_revision)
  REFERENCES task_acceptances (task_id, acceptance_revision)
  DEFERRABLE INITIALLY DEFERRED;

-- Task 当前完成凭据指针（先插入 completion_records，再设置指针）。
ALTER TABLE tasks ADD CONSTRAINT fk_tasks_current_completion
  FOREIGN KEY (id, acceptance_revision, current_completion_id)
  REFERENCES completion_records (task_id, acceptance_revision, id)
  DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------------------
-- 8. 命令回执与关键审计
-- ---------------------------------------------------------------------------

-- 重放先比 payload_hash，再返回原结果；摘要算法与规范化版本随回执保存。
CREATE TABLE command_receipts (
  scope_key text NOT NULL,
  command_id uuid NOT NULL,
  command_type text NOT NULL,
  payload_hash bytea NOT NULL,
  payload_hash_algorithm text NOT NULL,
  canonicalization_version text NOT NULL,
  result_ref jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_command_receipts PRIMARY KEY (scope_key, command_id),
  CONSTRAINT ck_command_receipts_scope CHECK (scope_key <> ''),
  CONSTRAINT ck_command_receipts_type CHECK (command_type <> ''),
  CONSTRAINT ck_command_receipts_hash CHECK (octet_length(payload_hash) = 32),
  CONSTRAINT ck_command_receipts_algorithm CHECK (payload_hash_algorithm = 'sha256'),
  CONSTRAINT ck_command_receipts_canonicalization CHECK (canonicalization_version <> ''),
  CONSTRAINT ck_command_receipts_result CHECK (jsonb_typeof(result_ref) = 'object')
);

CREATE TABLE activity_records (
  id uuid NOT NULL,
  actor_kind text NOT NULL,
  actor_ref text NOT NULL,
  command_id uuid,
  project_id uuid,
  task_id uuid,
  event_type text NOT NULL,
  fact_refs jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_activity_records PRIMARY KEY (id),
  CONSTRAINT fk_activity_records_project FOREIGN KEY (project_id) REFERENCES projects (id),
  CONSTRAINT fk_activity_records_task FOREIGN KEY (task_id) REFERENCES tasks (id),
  -- V001 只有人工与系统写入；Worker/AI 主体在 V002 引入。
  CONSTRAINT ck_activity_records_actor CHECK (actor_kind IN ('HUMAN', 'SYSTEM')),
  CONSTRAINT ck_activity_records_actor_ref CHECK (actor_ref <> ''),
  CONSTRAINT ck_activity_records_event CHECK (event_type <> ''),
  CONSTRAINT ck_activity_records_facts CHECK (jsonb_typeof(fact_refs) = 'object')
);

-- ---------------------------------------------------------------------------
-- 9. 索引
-- ---------------------------------------------------------------------------

-- 项目任务列表
CREATE INDEX ix_tasks_project_status ON tasks (project_id, status, id);
-- 默认 Inbox（无 Project 的人工事项）
CREATE INDEX ix_tasks_inbox ON tasks (workspace_id, status, id) WHERE project_id IS NULL;
CREATE INDEX ix_artifacts_task ON artifacts (task_id, created_at, id);
-- 外键引用侧索引：按 Goal 求受影响 Task、按被依赖 Task 求下游
CREATE INDEX ix_project_goals_goal ON project_goals (goal_id);
CREATE INDEX ix_task_explicit_goals_goal ON task_explicit_goals (goal_id);
CREATE INDEX ix_task_dependencies_depends_on ON task_dependencies (depends_on_task_id);
-- 周期内人工接受与证据追溯
CREATE INDEX ix_human_acceptances_cycle ON human_acceptances (task_id, acceptance_revision);
CREATE INDEX ix_state_completion_refs_completion ON state_completion_refs (completion_id);
CREATE INDEX ix_state_artifact_refs_version ON state_artifact_refs (artifact_version_id);
-- 审计查询
CREATE INDEX ix_activity_records_project ON activity_records (project_id, created_at, id);
CREATE INDEX ix_activity_records_task ON activity_records (task_id, created_at, id);
CREATE INDEX ix_activity_records_command ON activity_records (command_id);

-- ---------------------------------------------------------------------------
-- 10. 应用角色权限
-- ---------------------------------------------------------------------------
-- 迁移角色持有 DDL 与表所有权；应用角色只获得必要的 SELECT/INSERT/UPDATE。
-- 可变根（状态、revision、指针）允许 UPDATE；不可变历史只允许 SELECT/INSERT；
-- 关联表允许 DELETE 以支持显式解除；任何表都不授予 DELETE 历史事实的能力。

GRANT USAGE ON SCHEMA public TO relay_app;

GRANT SELECT, INSERT, UPDATE ON
  workspaces,
  workspace_execution_authority,
  projects,
  goals,
  tasks,
  project_states,
  artifacts,
  project_blockers,
  project_risks
TO relay_app;

GRANT SELECT, INSERT, DELETE ON
  project_goals,
  task_explicit_goals,
  task_dependencies,
  state_completion_refs,
  state_artifact_refs
TO relay_app;

GRANT SELECT, INSERT ON
  task_acceptances,
  acceptance_criteria,
  artifact_versions,
  human_acceptances,
  completion_records,
  command_receipts,
  activity_records
TO relay_app;