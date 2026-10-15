-- 日常查看基线的**可信读取顺序**（总纲 §0.8.1「日常比较基线」/ 测试计划 NLS-06）。
--
-- 问题：基线此前只按 viewed_state_revision 单调推进。State revision 不变而 Task 新增/关闭时
-- （State 仍为 v0），同一次 revision 的确认被判为「重复确认回放」，基线永远不推进，
-- 已查看过的新增任务会被反复报成「新增」。
--
-- 修复：读取（GET /daily-continuation）时由服务端签发一个**按项目单调递增的展示序号**。
-- 确认必须携带该序号；推进条件是「序号严格增大且 viewed_state_revision 不倒退」，
-- 因此：
--   * 同 State revision 下只展示过一次的事实也能推进基线；
--   * 同 State revision 的迟到旧确认（序号更小）不会覆盖新查看结果；
--   * 顺序由服务端签发，不用客户端时钟，也不接受客户端自造序号（上限即已签发值）。
--
-- 表只保存签发计数与最后签发的展示身份，不复制任何业务正文。
CREATE TABLE project_daily_view_presentation_counters (
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  project_id uuid NOT NULL REFERENCES projects (id),
  issued_seq bigint NOT NULL DEFAULT 0,
  last_presentation_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, project_id)
);
GRANT SELECT, INSERT, UPDATE ON project_daily_view_presentation_counters TO relay_app;

-- 基线行记录它所对应那次展示的序号；历史行按 0 处理，任何新签发的序号都大于它。
ALTER TABLE project_daily_view_baselines
  ADD COLUMN viewed_presentation_seq bigint NOT NULL DEFAULT 0;
