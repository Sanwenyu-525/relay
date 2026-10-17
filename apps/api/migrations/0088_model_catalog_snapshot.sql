-- 免费模型目录快照与同步状态（专项 prompts/free-model-catalog.md 阶段 B；
-- roadmap §9.1、runtime §8.6、测试 FM-01–FM-05）。
-- 2026-10-15，源码实现（本批只做目录同步与严格免费判定；会话选择/Run 冻结留下一批）。
--
-- 仅新增两张全局表，不改写任何既有迁移、不回填、不触碰 model_calls / assist / runs 契约。
-- API Breaking Change: No——新增表与新端点，既有端点、表、CHECK 分支原样保留。
--
-- 目录是进程级全局事实，不隶属某个 Workspace；读取目录不建 Task/Run、不写 model_calls、
-- 不发推理。是否免费由应用层按「本次支持的文本调用计价项」严格计算后落库；数据库只保存
-- 解析结果与逐字原始定价供核对，不把「目录收录」当成认证、实际工具能力或额度可用。
-- 旧会话/旧 Run 无模型选择或快照时保持原默认行为，本批不动 assist_sessions / runs。

-- 1) 当前成功快照的发布头 + 跨进程同步租约 + 失败退避。单例行，迁移预置 openrouter 空状态。
CREATE TABLE model_catalog_sync_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  source text NOT NULL CHECK (source IN ('openrouter')),
  -- 已成功发布快照的规范内容摘要（sha256 hex，64）；无成功快照时为 NULL，绝不伪造。
  directory_digest text NULL CHECK (directory_digest IS NULL OR directory_digest ~ '^[0-9a-f]{64}$'),
  -- 每次成功发布 +1。领取租约时记下 base_seq，发布以 snapshot_seq = base_seq 做 CAS：
  -- 期间已有更新的发布推进 seq 时，本次较旧结果被丢弃，旧响应不得覆盖新快照。
  snapshot_seq bigint NOT NULL DEFAULT 0 CHECK (snapshot_seq >= 0),
  last_success_at timestamptz NULL,
  last_attempt_at timestamptz NULL,
  last_failure_at timestamptz NULL,
  -- 失败分类是状态而非审计；未知收费/非法分页如实记 INCOMPLETE，不刷新成功时间。
  last_failure_reason text NULL CHECK (last_failure_reason IS NULL OR last_failure_reason IN
    ('NETWORK','TIMEOUT','AUTH','RATE_LIMIT','PROTOCOL','INCOMPLETE','ENDPOINT_NOT_ALLOWED','NOT_CONFIGURED')),
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  -- 跨进程/多客户端去重：只有拿到未过期租约的执行体才发起外呼。租约过期不代表旧进程已停，
  -- 迟到结果仍由 snapshot_seq CAS 兜住；租约两列同现同缺。
  sync_lease_token uuid NULL,
  sync_lease_expires_at timestamptz NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  CHECK ((sync_lease_token IS NULL) = (sync_lease_expires_at IS NULL))
);

-- 2) 当前快照的免费判定条目；随成功发布整体原子替换，只保留最新一份（同事务 DELETE 后 INSERT，
--    读取不会看到半份快照）。合法完整空目录 → 替换后无行，可选免费集合随之清空。
CREATE TABLE model_catalog_entries (
  -- OpenRouter 确切模型 ID，`:free` 等后缀原样保留；判定不依赖此后缀，只依赖价格项。
  source_model_id text PRIMARY KEY CHECK (length(source_model_id) BETWEEN 1 AND 200),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  -- 上下文窗口：未知为 NULL，不写 0（0 会被读成「窗口为零」这一错误事实）。
  context_window integer NULL CHECK (context_window IS NULL OR context_window >= 0),
  -- 逐字保留来源原始计价项（字符串单价，含 prompt/completion/request 等键），供恢复核对；
  -- 键集合随来源变化，不预设固定列，免费判定在应用层按启用能力计算。
  pricing jsonb NOT NULL CHECK (jsonb_typeof(pricing) = 'object'),
  -- 已知能力：tools / text_input / text_output 取 true|false|null，null = 未知，不冒充可用。
  capabilities jsonb NOT NULL CHECK (jsonb_typeof(capabilities) = 'object'),
  is_free boolean NOT NULL,
  -- 非免费必须给出保守原因；免费则原因 NULL。挡住「仅名称带 free 就入选」「缺价默认零」两类误判。
  not_free_reason text NULL CHECK (not_free_reason IS NULL OR not_free_reason IN
    ('MISSING_PRICE','INVALID_PRICE','NEGATIVE_PRICE','NONZERO_PRICE','UNKNOWN_BILLABLE_ITEM')),
  fetched_at timestamptz NOT NULL,
  CHECK ((is_free AND not_free_reason IS NULL) OR ((NOT is_free) AND not_free_reason IS NOT NULL))
);

-- 初始发布头：由迁移（relay_migrator，schema owner）预置，运行期应用角色只 UPDATE 不 INSERT。
INSERT INTO model_catalog_sync_state (singleton, source) VALUES (true, 'openrouter');

-- 应用角色权限：
--   * sync_state：读取 + 定向列 UPDATE（发布/租约/退避/时间戳），无 INSERT/DELETE——单例状态行由迁移建立。
--   * entries：读取 + 整体替换所需 INSERT/DELETE，不给 UPDATE——条目由发布整体替换，不可被单点改写。
GRANT SELECT ON model_catalog_sync_state, model_catalog_entries TO relay_app;
GRANT UPDATE (source, directory_digest, snapshot_seq, last_success_at, last_attempt_at,
  last_failure_at, last_failure_reason, consecutive_failures, sync_lease_token,
  sync_lease_expires_at, revision) ON model_catalog_sync_state TO relay_app;
GRANT INSERT, DELETE ON model_catalog_entries TO relay_app;

-- 兼容与回滚：纯追加两张表，无旧数据依赖；回退应用可直接保留两表（旧代码不读），
-- 删表会丢失目录快照与同步/退避状态，下次需重新同步；无自动 down migration。
-- 本批不含会话选择/Run 冻结表，那些在阶段 C 以 0089+ 追加，不预建无当前调用方的列。
