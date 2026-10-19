-- F26 浏览器任务的展示状态（M3）。
--
-- 与 0106 的分工：0106 是「后端本身健康吗」（安装级、单行）；本表是「现在有哪个任务
-- 在操作哪个页面」（按任务、可多行）。读方仍是 API 与桌面壳，写方仍是 Worker。
--
-- 为什么不用"任务表扩展"：浏览器任务可能来自 Run，也可能来自只读会话轮次
-- （0105 放行 BROWSER_READ 给 ASSISTANT_READ / AGENT_SESSION_READ），两者的身份列
-- 形状不同；合成一张会迫使 Run 与会话互相冒充。owner_kind/owner_id 是一个显式的
-- 联合身份，与 Gateway 的 origin 词表一一对应。
--
--   * RUNNING        上次浏览器动作刚刚发生（动作之间会话保持，updated_at 持续刷新）
--   * STOP_REQUESTED 用户请求退出：既有 run_control_requests 已入队，Worker 尚未确认
--   * STOPPED        无活跃操作（读取方按空闲阈值惰性落库，Worker 不留后台定时器）
--
-- 本表只承载展示事实：不参与审批、不参与结算、不属于账本；浏览器动作的真实记账仍在
-- logical_operations / run_tool_calls / run_control_requests。

CREATE TABLE browser_sessions (
  owner_kind text NOT NULL CHECK (owner_kind IN ('RUN', 'SESSION')),
  owner_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  page_id integer NOT NULL CHECK (page_id > 0),
  url text NOT NULL DEFAULT '',
  title text NOT NULL DEFAULT '',
  action_type text NOT NULL DEFAULT '',
  action_label text NOT NULL DEFAULT '',
  state text NOT NULL CHECK (state IN ('RUNNING', 'STOP_REQUESTED', 'STOPPED')),
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_kind, owner_id)
);

-- 桌面壳按工作区读"现在有哪些浏览器任务"；不再加别的索引——单用户本机库规模下
-- 一次全表扫描比多一个索引更可解释。
CREATE INDEX browser_sessions_workspace_state ON browser_sessions (workspace_id, state);

-- 应用角色只读写状态：没有 DELETE——停止是改写而不是删除，历史留在 updated_at 里。
GRANT SELECT, INSERT, UPDATE ON browser_sessions TO relay_app;
