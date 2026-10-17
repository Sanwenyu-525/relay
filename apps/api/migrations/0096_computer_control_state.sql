-- Computer Control 全局状态 UI（屏幕边缘光效 + 顶部状态条）的真实状态来源。
--
-- 背景：电脑操控（COMPUTER_INPUT）只经 Run 工具循环在 Worker 进程执行，而读它的是
-- 桌面壳（Tauri 宿主，经 API 读取）。三个进程之间只共享 PostgreSQL，因此「Relay 是否
-- 正在操控电脑」必须落成数据库里的一行展示事实，而不是任何进程的内存单例。
--
-- 语义（与真实执行对齐，不新增虚拟状态）：
--   * RUNNING        最近一次 Run 来源的 Computer 动作仍活跃；动作之间（模型推理、
--                    截图核对）会话保持，updated_at 持续刷新。
--   * STOP_REQUESTED 用户已请求退出（Esc）：Run 控制已入队既有 run_control_requests
--                    通道，Worker 尚未确认停止。
--   * STOPPED        无活跃操控。没有行也按 STOPPED 理解。
--   * updated_at 超过空闲阈值（应用层常量）仍未刷新时，读取方按 STOPPED 理解并惰性
--     落库——Worker 不留后台定时器，过期判定由读取路径完成。
--
-- 本表只承载「当前是否在操控电脑」这一展示事实：不参与审批、不参与结算、不属于账本；
-- 输入效果的真实记账仍在 logical_operations / run_tool_calls / run_control_requests。

CREATE TABLE computer_control_state (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  run_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('RUNNING', 'STOP_REQUESTED', 'STOPPED')),
  action_type text NOT NULL DEFAULT '',
  action_label text NOT NULL DEFAULT '',
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
