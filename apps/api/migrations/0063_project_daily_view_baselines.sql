-- 日常查看基线（总纲 §0.8.1 / 工作台 §18.9 / 领域模型 §12.5）：
-- 返回项目时，顶部接续卡展示「相对上次实际查看摘要时」的变化；无基线只展示当前事实。
--
-- 一条基线 = 一次「实际查看确认」：针对一次已成功展示的结果（presentation_id），
-- 保存必要版本引用（viewed_state_revision 与 viewed_fact_refs），不复制业务正文——
-- 任务、State、blocker 仍各归原 Owner，这里只记录「用户上次看到了什么」。
--
-- 命名接续点（N01，project_continuation_points）不受日常查看影响：打开项目不重设基线，
-- 也不重设命名接续点；基线只随「实际查看确认」单调推进（viewed_state_revision 只增不减）。
-- 「已查看」不是接受或接手：本表不参与任何验收、批准或执行权转移。

CREATE TABLE project_daily_view_baselines (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  project_id uuid NOT NULL REFERENCES projects (id),
  viewed_state_revision bigint NOT NULL,
  viewed_fact_refs jsonb NOT NULL CHECK (jsonb_typeof(viewed_fact_refs) = 'object'),
  presentation_id uuid NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_daily_view_baseline_project UNIQUE (workspace_id, project_id),
  CONSTRAINT uq_daily_view_baseline_presentation UNIQUE (workspace_id, presentation_id)
);
GRANT SELECT, INSERT, UPDATE ON project_daily_view_baselines TO relay_app;
