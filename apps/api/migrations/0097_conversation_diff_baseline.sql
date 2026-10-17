-- 会话局部与总 diff（工作台 §34）的会话基线快照。
--
-- 语义（与产品方案一致，不新增第二套业务状态）：
--   * 基线是「本轮对话开始以来」的受管根内容快照，用于计算净变化；
--     它只是展示证据，不是 ArtifactVersion / Verification / Task 完成 / 恢复动作的权威。
--   * 一行对应一次原子发布的基线（一个会话 + 一个受管资源 + 一个根路径 = 一个统计段）；
--     切换目录会产生新根路径的新段，不跨段求和。
--   * 不创建 Git commit / stash / 分支 / worktree，不改用户 index；快照文本落库即可重启恢复。
--   * 超限/二进制的文件不编造行数：files 里对应条目带 unavailable_reason，不把部分数据冒充完整。
--
-- files 内容（JSONB 数组，每条）：
--   { path, sha256, size_bytes, text(可空，仅小文件), line_count(可空), unavailable_reason(可空) }
--
-- revision 为全局单调序列：总数/列表/正文在同一 revision 下一致，供前端一致性判定（CD-15）。

CREATE SEQUENCE IF NOT EXISTS conversation_diff_baseline_revision;

CREATE TABLE conversation_diff_baselines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  root_path text NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  files jsonb NOT NULL,
  incomplete boolean NOT NULL DEFAULT false,
  capture_reason text NOT NULL DEFAULT '',
  revision bigint NOT NULL DEFAULT nextval('conversation_diff_baseline_revision'),
  -- 一个会话 + 一个受管资源 + 一个根路径只有一条基线（CD-08 原子发布）：
  -- 仓库层的 insert ... on conflict 就按这组键复用，保证并发首条消息不发布两个起点。
  CONSTRAINT uq_conversation_diff_baselines_segment
    UNIQUE (workspace_id, session_id, resource_id, root_path)
);

CREATE INDEX conversation_diff_baselines_session_idx
  ON conversation_diff_baselines (workspace_id, session_id, captured_at DESC);

-- 应用角色读取基线快照；删除不做表级授权，行随会话归档由上层显式入口处理。
GRANT SELECT, INSERT ON conversation_diff_baselines TO relay_app;
GRANT USAGE ON SEQUENCE conversation_diff_baseline_revision TO relay_app;
