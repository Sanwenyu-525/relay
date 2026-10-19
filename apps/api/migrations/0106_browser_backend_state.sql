-- F26 浏览器后端健康投影（M2）。
--
-- 背景：浏览器后端（Chrome + chrome-devtools-mcp）由 **Worker 进程**懒启动并持有，
-- 而读取它的是 API 进程与桌面壳。三个进程之间只共享 PostgreSQL，因此「浏览器后端
-- 现在是什么状态」必须落成数据库里的一行展示事实，而不是任何进程的内存单例
-- （与 0096 的 computer_control_state 同一理由）。
--
-- 语义：
--   * 没有行 = NOT_STARTED：本机从未使用过浏览器能力，后端尚未启动。
--   * 有行 = Worker 最近一次 ensureStarted / 失败后的真实结论（含版本与可操作建议）。
--   * updated_at 是「这个结论是什么时候测出来的」：桌面壳可以据此显示"上次检查于…"。
--     本表不做惰性过期——READY 的进程在 Worker 存活期间一直活着，猜测过期只会制造
--     假阴性；进程真的退出时 Worker 会写 DISCONNECTED。
--
-- 本表只承载展示事实：不参与准入、不参与审批、不属于账本。浏览器动作的真实记账
-- 仍在 logical_operations / run_tool_calls。

CREATE TABLE browser_backend_state (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  status text NOT NULL CHECK (
    status IN ('READY', 'CHROME_MISSING', 'BACKEND_MISSING', 'INCOMPATIBLE', 'DISCONNECTED')),
  backend_version text NOT NULL DEFAULT '',
  chrome_version text NOT NULL DEFAULT '',
  detail text NOT NULL DEFAULT '',
  remediation text NOT NULL DEFAULT '',
  tool_count integer NOT NULL DEFAULT 0 CHECK (tool_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 应用角色只需读写这一行：没有 DELETE —— 后端状态永远不该被"删掉"，只应被改写。
GRANT SELECT, INSERT, UPDATE ON browser_backend_state TO relay_app;
