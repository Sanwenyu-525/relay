-- 返回轻量核对（总纲 §0.8.1 / 工作台 §18.9 / 测试计划 NLS-05、NLS-08、NLS-09，
-- 任务书第五节第 4 项 Slice C）。
--
-- 「基线查询/顶部卡不是检查运行」：返回项目时的轻量核对是一条**有持久身份的核对记录**，
-- 与查看基线分开。一次核对 = 一个 (project, fingerprint) 行：
--   * fingerprint 由已查看差异涉及的事实（阶段 / 下一步 / 任务集合 / 阻塞数）与
--     完成证据适用性（完成记录 + 验收版本 + AUTO 会话适用性）共同决定；
--   * 事实没变 → 复用同一行（重复打开、双击、重启都不产生第二次核对）；
--   * 事实变了 → 新 fingerprint → 新核对，不把旧结论冒充新结果（证据版本变化重新核对）；
--   * 核对是同步只读：不伪造 Run、不启动进程、不自动修复或新建任务（NLS-05）。
--
-- 回滚风险：纯追加表；回退应用后旧代码不读它，行保留为历史账本。
CREATE TABLE project_return_reviews (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  project_id uuid NOT NULL REFERENCES projects (id),
  fingerprint text NOT NULL,
  status text NOT NULL,
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_return_review_fingerprint UNIQUE (workspace_id, project_id, fingerprint),
  CONSTRAINT ck_return_review_status CHECK (status IN ('APPLICABLE', 'CHANGED'))
);
CREATE INDEX ix_return_review_project ON project_return_reviews (project_id, created_at DESC);
GRANT SELECT, INSERT, UPDATE ON project_return_reviews TO relay_app;
