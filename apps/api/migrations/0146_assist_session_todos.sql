-- Agent Todo List（ADR-038，2026-10-30）。
--
-- 目标是长任务的执行方向可见、可恢复：模型用 `todo_write` 全量复写一份会话级清单，
-- 界面与下一次模型调用都读同一份权威投影。
--
-- 两个表分工明确：
--   * `assist_session_todo_events`  版本化更新事件，**只用于恢复与审计**；
--   * `assist_session_todo_snapshots` 最新快照，**UI 与模型唯一读取的投影**。
-- 只留最新快照、不重建历史，是因为「旧事件不得覆盖新快照」必须由数据模型兜住，
-- 而不是靠应用层记得先比版本。
--
-- 归属在会话上，不在项目上：同一项目下的两个会话各有各的进度，新会话不继承旧清单。

CREATE TABLE assist_session_todo_snapshots (
  session_id uuid PRIMARY KEY REFERENCES assist_sessions(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  version bigint NOT NULL CHECK (version >= 1),
  items jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array'),
  in_progress_limit integer NOT NULL DEFAULT 1 CHECK (in_progress_limit BETWEEN 1 AND 8),
  last_tool_call_id uuid NOT NULL,
  last_message_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE assist_session_todo_events (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES assist_sessions(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  version bigint NOT NULL CHECK (version >= 1),
  items jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array'),
  tool_call_id uuid NOT NULL,
  message_id uuid NOT NULL,
  origin_version bigint NOT NULL CHECK (origin_version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, version),
  UNIQUE (session_id, tool_call_id)
);

CREATE INDEX assist_session_todo_events_session
  ON assist_session_todo_events(session_id, version DESC);

ALTER TABLE assist_sessions ADD COLUMN todo_parallel_limit integer NOT NULL DEFAULT 1
  CHECK (todo_parallel_limit BETWEEN 1 AND 8);

-- 应用内工具（委派、待办）没有 Gateway Operation：执行证据在各自的表里。
-- 0060 的「SETTLED 必须有 Operation」只对这两类放开，其它会话工具不变量不变。
ALTER TABLE session_tool_calls DROP CONSTRAINT ck_session_tool_calls_operation;
ALTER TABLE session_tool_calls ADD CONSTRAINT ck_session_tool_calls_operation CHECK (
    (status = 'REJECTED' AND operation_id IS NULL)
    OR (status IN ('SETTLED', 'UNKNOWN') AND operation_id IS NOT NULL)
    OR (status = 'SETTLED' AND operation_id IS NULL AND tool_name IN ('delegate_subagent', 'todo_write'))
    OR status = 'REQUESTED');

GRANT SELECT, INSERT, UPDATE ON assist_session_todo_snapshots, assist_session_todo_events TO relay_app;