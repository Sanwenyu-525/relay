-- 会话局部 diff 的「生成中」临时预览（工作台 §34.4 / CD-09/10/11）。
--
-- 语义：
--   * 一行 = 一次模型调用里某个工具 ordinal 的**可丢弃**预览；它属于展示证据，
--     不是发起写动作的授权，也不进入会话总数（总数只采用已落盘内容）。
--   * 键（workspace, model_call, ordinal）：模型调用 id 在参数流动期间就已经存在，
--     工具调用行要等整轮落库才有 id，所以预览先按调用+序号存，UI 再按同样的键配对。
--   * files 是 JSONB 数组，每条 { path, action, added, removed, target_complete }；
--     数不出来时用 added/removed = -1 表示「待核对」，绝不把半截内容当删除数。
--   * revision 全局单调：同一次预览的更新只增不减，旧响应不能覆盖新值（CD-15）。
--   * 生命周期：模型调用失败/取消/整轮落库后由应用层删除；重启后允许为空的读取结果，
--     不要求恢复半截预览。
CREATE SEQUENCE IF NOT EXISTS run_tool_call_preview_revision;

CREATE TABLE run_tool_call_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL,
  model_call_id uuid NOT NULL,
  ordinal integer NOT NULL,
  tool_name text NOT NULL,
  files jsonb NOT NULL,
  truncated boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT nextval('run_tool_call_preview_revision'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_run_tool_call_previews_call UNIQUE (workspace_id, model_call_id, ordinal)
);

CREATE INDEX run_tool_call_previews_run_idx
  ON run_tool_call_previews (workspace_id, run_id, updated_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON run_tool_call_previews TO relay_app;
GRANT USAGE ON SEQUENCE run_tool_call_preview_revision TO relay_app;
