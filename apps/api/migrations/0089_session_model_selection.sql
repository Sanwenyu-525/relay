-- 会话模型选择（专项 prompts/free-model-catalog.md 阶段 C；
-- roadmap §9.1、runtime §8.6、HTTP §10.82、测试 FM-06/FM-08）。
-- 2026-10-15，源码实现（本批落「会话选择」持久化与 /model 写读接线；
-- Task Delegate 的 Run 冻结快照与 OpenRouter 聊天连接的实际外呼执行留下一批）。
--
-- 仅新增一张会话作用域表，不改写任何既有迁移、不回填、不触碰 model_calls / runs /
-- assist_sessions 的既有列。选择是「该会话后续新请求用哪个模型」的事实，不是应用默认——
-- 应用默认仍只由进程 RELAY_MODEL_* 决定，本表绝不写回进程配置。
-- API Breaking Change: No——新增表与新端点 + /model 由「仅解析」变为「写会话选择」，
-- 既有端点、表、CHECK 分支原样保留；无旧行需回填，旧会话无选择行即保留原默认。

-- 每个会话至多一条当前选择（会话作用域，随会话生命周期）。revision 供 CAS：
-- 并发/重放的选择命令以 revision 单调递增收敛，旧值不覆盖新值（FM-06 revision/幂等）。
CREATE TABLE session_model_selection (
  session_id uuid PRIMARY KEY REFERENCES assist_sessions(id),
  -- 已登记连接只两枚：原默认与 OpenRouter 免费目录连接。客户端只能选这两者之一，
  -- 目录内容不得引入第三主机；凭据各自服务端解析、互不串用（FM-05 隔离）。
  connection text NOT NULL CHECK (connection IN ('default','openrouter')),
  -- 冻结的确切模型 ID：续轮/重启按此恢复，不换成目录里的其他型号；不用 openrouter/free 随机路由。
  model text NOT NULL CHECK (model ~ '^.{1,200}$'),
  -- 所选连接当时解析出的配置指纹（64 hex，不含密钥）；连接配置变化后指纹不符即视为失效。
  config_fingerprint text NOT NULL CHECK (config_fingerprint ~ '^[0-9a-f]{64}$'),
  -- free_only 为真才在每次外呼附服务商端零价硬限制；缺省/假保持原默认行为、不受目录故障影响。
  free_only boolean NOT NULL DEFAULT false,
  -- 免费判定依据：来自哪一版目录快照、哪个目录模型 ID。三列同现同缺；非免费且非 openrouter 连接可全空。
  catalog_source text NULL CHECK (catalog_source IS NULL OR catalog_source = 'openrouter'),
  catalog_snapshot_seq bigint NULL CHECK (catalog_snapshot_seq IS NULL OR catalog_snapshot_seq >= 0),
  catalog_model_id text NULL CHECK (catalog_model_id IS NULL OR catalog_model_id ~ '^.{1,200}$'),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  -- 最近一次写入该选择的原命令身份：随选择留存，供核对与「原命令重放返回当时结果」追溯。
  selected_by_command_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- 「仅免费」必须带可核对的目录依据；openrouter 连接必须来自目录快照。
  CHECK (
    (free_only = false
      OR (catalog_source = 'openrouter' AND catalog_snapshot_seq IS NOT NULL
          AND catalog_model_id IS NOT NULL))
    AND (connection = 'default' OR catalog_source = 'openrouter')
  ),
  -- 目录依据三列同现同缺，不留半截依据。
  CHECK (
    (catalog_source IS NULL) = (catalog_snapshot_seq IS NULL)
    AND (catalog_source IS NULL) = (catalog_model_id IS NULL)
  )
);

-- 应用角色权限：选择只有「读 + 幂等写（INSERT）+ CAS（UPDATE）」，无 DELETE。
-- 会话归档不删选择行（保留可核对历史，重开会读到原选择并可显示失效原因）。
GRANT SELECT, INSERT, UPDATE ON session_model_selection TO relay_app;

-- 兼容与回滚：纯追加一张会话作用域表，无旧数据依赖，无自动 down migration。
-- 回退应用可保留该表（旧代码不读）；删表会丢失各会话的选择与目录依据，用户需重选，
-- 但不影响任何业务事实（选择从不写 model_calls / runs / 应用默认）。
