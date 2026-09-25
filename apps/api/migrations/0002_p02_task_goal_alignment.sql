-- 0002：P02（Project / Goal / Task / State 应用用例）所需的最小 schema 增量。
--
-- 依据：
--   docs/database/logical-model.md 第 2 节（tasks 的显式 Goal 对齐、task_explicit_goals 子集约束）
--   docs/architecture/information-planning.md 第 5 节（goal_alignment_mode = INHERIT/EXPLICIT，显式可为空集合）
--   docs/api/http-command-contract.md 第 3、6 节与 docs/api/module-api.md 第 1 节（任务列表分页与 Goal 对齐）
--
-- 本文件只做追加，不改写已应用的 0001_v001_human_core.sql（迁移入口按内容 SHA-256 校验，改写会被拒绝）。
-- 既有 tasks 行由列默认值回填为 INHERIT，不需要数据迁移脚本。
--
-- 本批次不扩展领域取值：
--   * tasks.mode 仍只允许 ME/AI_ASSIST（DELEGATE_AI 需要 Run 与 Delegate 用例，V002 之后开放）。
--   * tasks.executor_kind 仍只允许 HUMAN。
--   * tasks.status 仍为 INBOX/READY/IN_PROGRESS/DONE/CANCELLED；WAITING/BLOCKED 由 Run/控制落地后扩展。
--   * task_acceptances / acceptance_criteria / artifact_versions 的取值集不变。

-- ---------------------------------------------------------------------------
-- 1. Task 的显式 Goal 对齐模式
-- ---------------------------------------------------------------------------
-- INHERIT：读取时继承所属 Project 当前 Goals；EXPLICIT：使用 task_explicit_goals 的显式集合。
-- 显式空集合与 INHERIT 是两种不同事实，因此必须显式列，不能用“没有行”含糊表示。

ALTER TABLE tasks ADD COLUMN goal_alignment_mode text NOT NULL DEFAULT 'INHERIT';

ALTER TABLE tasks ADD CONSTRAINT ck_tasks_goal_alignment_mode
  CHECK (goal_alignment_mode IN ('INHERIT', 'EXPLICIT'));

-- 无 Project 的 Me Inbox 事项没有可继承/可显式引用的目标集合：
-- task_explicit_goals 的复合外键要求 project_id 非空，这里把同一条不变量前移到 tasks 上，避免出现
-- “EXPLICIT 但无法表达任何显式集合”的行。
ALTER TABLE tasks ADD CONSTRAINT ck_tasks_goal_alignment_project
  CHECK (goal_alignment_mode = 'INHERIT' OR project_id IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 2. 任务列表分页的稳定排序键
-- ---------------------------------------------------------------------------
-- 列表按 (created_at DESC, id DESC) 的键集游标分页（最新在前），游标绑定过滤条件；
-- 稳定排序键与过滤条件的组合索引在此建立，避免全表排序。

CREATE INDEX ix_tasks_project_created ON tasks (project_id, created_at DESC, id DESC);

-- 默认 Inbox（无 Project 的人工事项）
CREATE INDEX ix_tasks_inbox_created
  ON tasks (workspace_id, created_at DESC, id DESC)
  WHERE project_id IS NULL;

-- ---------------------------------------------------------------------------
-- 3. 应用角色权限
-- ---------------------------------------------------------------------------
-- 新增列随 tasks 的表级授权生效（列权限由表级 GRANT 覆盖），这里显式重申任务表的可写授权，
-- 便于审计“新增列不会造成 42501”。本批次不新增表，因此不需要新的表级授权。

GRANT SELECT, INSERT, UPDATE ON tasks TO relay_app;