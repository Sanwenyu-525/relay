-- 2026-11-15：上下文容量与压缩阈值解耦（模型决定容量，用户决定压缩时机）。
--
-- 背景：0145/0162 把「会话档位」（256K / 512K / 1M）同时当成单次调用预算与压缩
-- 目标窗口；用户改档位会改变模型被允许的最大请求，普通用户被迫配置两个数
-- （档位 + 压缩阈值）。本次重构明确区分：
--
--   * 模型真实上下文窗口 = 模型能力参数，来自目录 / 高级能力声明 / 部署配置；
--   * 自动压缩阈值 = 用户偏好，默认 350K，单独保存在 workspace_memory_settings；
--   * 实际生效阈值 = min(用户阈值, 安全输入上限 × 0.9)。
--
-- 本迁移只做三件**兼容性**事情，不删除任何既有事实：
--
--   1. 能力声明表新增 `context_window_tokens`：这是「人已核对的模型能力元数据」，
--      只补目录与部署配置没有覆盖的模型；它不是普通用户的压缩设置入口。
--   2. 把「仍是出厂默认」的模型连接预算抬高到 1M 目标容量。0143 的 65536 是旧
--      的单次预算默认值；本次产品目标改为 1M 后，如果继续保留 65536，会让默认
--      350K 阈值在任何模型上都被压到 ~59K。仅当两列都仍是旧默认值时才回填，
--      用户通过 API 显式调过的值不动。
--   3. 给三档档位列加注释标记 LEGACY：数据保留、旧客户端仍可读写，但新的上下文
--      预算与压缩判定不再读取它。**不**把旧档位值无条件转成压缩阈值——那是两个
--      语义不同的数（容量 vs 触发时机）。
--
-- API Breaking Change: No —— 纯新增列、默认值调整与注释；既有列与数据不动。
-- 回滚：ALTER TABLE ... DROP COLUMN context_window_tokens；预算回填无法精确还原
--       （旧默认值 65536/262144 可反向识别），但不影响业务事实。

ALTER TABLE model_capability_declarations
  ADD COLUMN context_window_tokens integer;

-- 16K 是「能装下一轮最小可用上下文」的下界；4M 给超长窗口模型留出空间，同时
-- 拒绝明显来自单位错误的值（例如把 1,000,000 写成 1,000,000,000）。
ALTER TABLE model_capability_declarations
  ADD CONSTRAINT ck_model_capability_context_window CHECK (
    context_window_tokens IS NULL OR
    (context_window_tokens >= 16384 AND context_window_tokens <= 4000000));

COMMENT ON COLUMN model_capability_declarations.context_window_tokens IS
  '已核对的模型上下文窗口（tokens）；NULL = 未声明。只作为模型能力元数据，不是用户的压缩阈值。';

-- 旧默认值组合（0143 出厂值）。只回填仍然完全等于旧默认的行：任何一列被用户
-- 通过 API 调整过，都不在这个条件里。
UPDATE model_connections
SET max_call_tokens = 1048576,
    max_scope_tokens = 1048576
WHERE max_call_tokens = 65536
  AND max_scope_tokens = 262144;

ALTER TABLE model_connections
  ALTER COLUMN max_call_tokens SET DEFAULT 1048576;
ALTER TABLE model_connections
  ALTER COLUMN max_scope_tokens SET DEFAULT 1048576;

COMMENT ON COLUMN model_connections.max_call_tokens IS
  '单次请求总量上限（服务商硬约束）。默认 1M 目标容量；真实模型窗口更小时由系统按窗口收敛。';
COMMENT ON COLUMN model_connections.max_scope_tokens IS
  '作用域累计 token 上限；必须不小于 max_call_tokens。';

-- 0145 的三档档位是「用户人为设置的有效窗口」，不是模型能力。新实现不再读取它
-- 计算预算/压缩阈值；保留列与数据，只为旧会话投影与旧客户端的读写兼容。
COMMENT ON COLUMN assist_sessions.context_budget_tokens IS
  'LEGACY（0165）：旧会话上下文档位。保留数据供旧客户端读取；不再参与单次预算或自动压缩判定。';
COMMENT ON COLUMN assist_sessions.context_budget_revision IS
  'LEGACY（0165）：旧档位的 CAS 修订；仍用于旧端点写入，但不改变上下文预算。';
COMMENT ON COLUMN workspace_default_directories.context_budget_tokens IS
  'LEGACY（0165）：旧工作区默认档位。保留数据；新建会话的模型容量由模型能力解析，不读这一列。';
