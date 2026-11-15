-- 0164：长期记忆系统 V2（分层、索引化检索、冲突替代、生命周期与可观测性）
--
-- 现状（0009/0118/0125/0130）已有：长期 Memory 根/不可变版本、人工确认、自动捕获、
-- 来源冻结、作用域（Workspace/Project）、有效期与召回设置。缺少的是「记忆类型」这层
-- 语义（用户偏好 / 项目事实 / 经验 / 事件）、结构化冲突键、验证状态、去重与替代关系、
-- 索引化的全文检索、Token 预算、整理运行记录和检索度量。
--
-- 本迁移只追加，不改已应用迁移的既有列语义：
--   * memory_items.status 仍只有 ACTIVE / RETIRED；「被替代」由 superseded_by_id 派生，
--     「过期」仍由版本 expires_at 派生，避免再造一套可写状态。
--   * 旧行 memory_type 一律 UNKNOWN：没有依据从 Project 作用域推断成项目事实。
--   * 旧人工确认行标记 VERIFIED（用户当时显式确认过正文），verified_at 留空表示
--     「确认时刻未知」；旧自动捕获行保持 UNVERIFIED，不冒充已验证经验。
--
-- 检索索引：search_title_tokens / search_body_tokens 由应用层写入（中文双字 + 拉丁词），
-- 表达式 GIN 索引提供真正的倒排检索；空 token 的旧行由应用层有界回填，回填前召回查询
-- 用「未索引行字面匹配」兜底，不会让旧记忆凭空消失。

ALTER TABLE memory_items
  ADD COLUMN memory_type text NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN scope text NOT NULL DEFAULT 'WORKSPACE',
  ADD COLUMN task_id uuid,
  ADD COLUMN agent_id text,
  ADD COLUMN memory_key text,
  ADD COLUMN importance smallint NOT NULL DEFAULT 3,
  ADD COLUMN confidence smallint NOT NULL DEFAULT 50,
  ADD COLUMN verification text NOT NULL DEFAULT 'UNVERIFIED',
  ADD COLUMN verified_at timestamptz,
  ADD COLUMN last_accessed_at timestamptz,
  ADD COLUMN stale_at timestamptz,
  ADD COLUMN pinned boolean NOT NULL DEFAULT false,
  ADD COLUMN supersedes_id uuid,
  ADD COLUMN superseded_by_id uuid,
  ADD COLUMN content_hash text,
  ADD COLUMN search_title_tokens text NOT NULL DEFAULT '',
  ADD COLUMN search_body_tokens text NOT NULL DEFAULT '',
  ADD COLUMN retired_reason text;

-- 旧行只有「有项目 / 无项目」两种作用域；task/agent 作用域在旧数据里不存在。
UPDATE memory_items SET scope = 'PROJECT' WHERE project_id IS NOT NULL;

-- 旧人工记忆是用户显式确认保存的正文；旧自动捕获没有经过验证，不能标成已验证经验。
UPDATE memory_items SET verification = 'VERIFIED'
  WHERE origin = 'HUMAN_CONFIRMED';

ALTER TABLE memory_items
  ADD CONSTRAINT ck_memory_type CHECK (memory_type IN
    ('USER_PREFERENCE', 'PROJECT_FACT', 'EXPERIENCE', 'EPISODIC', 'UNKNOWN')),
  ADD CONSTRAINT ck_memory_scope CHECK (scope IN ('WORKSPACE', 'PROJECT', 'TASK', 'AGENT')),
  ADD CONSTRAINT ck_memory_scope_shape CHECK (
    (scope = 'WORKSPACE' AND project_id IS NULL AND task_id IS NULL AND agent_id IS NULL) OR
    (scope = 'PROJECT' AND project_id IS NOT NULL AND task_id IS NULL AND agent_id IS NULL) OR
    (scope = 'TASK' AND project_id IS NOT NULL AND task_id IS NOT NULL AND agent_id IS NULL) OR
    (scope = 'AGENT' AND agent_id IS NOT NULL)
  ),
  ADD CONSTRAINT ck_memory_key CHECK (
    memory_key IS NULL OR (length(memory_key) BETWEEN 1 AND 80
      AND memory_key ~ '^[a-z0-9][a-z0-9._:-]*$')),
  ADD CONSTRAINT ck_memory_importance CHECK (importance BETWEEN 1 AND 5),
  ADD CONSTRAINT ck_memory_confidence CHECK (confidence BETWEEN 0 AND 100),
  ADD CONSTRAINT ck_memory_verification CHECK (verification IN
    ('VERIFIED', 'UNVERIFIED', 'FAILED')),
  ADD CONSTRAINT ck_memory_content_hash CHECK (
    content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT fk_memory_task FOREIGN KEY (workspace_id, task_id)
    REFERENCES tasks (workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT fk_memory_supersedes FOREIGN KEY (supersedes_id)
    REFERENCES memory_items (id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT fk_memory_superseded_by FOREIGN KEY (superseded_by_id)
    REFERENCES memory_items (id) DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX ix_memory_items_type ON memory_items (workspace_id, memory_type, status);
CREATE INDEX ix_memory_items_key ON memory_items (workspace_id, memory_key, status)
  WHERE memory_key IS NOT NULL;
CREATE INDEX ix_memory_items_hash ON memory_items (workspace_id, content_hash)
  WHERE content_hash IS NOT NULL;
CREATE INDEX ix_memory_items_pinned ON memory_items (workspace_id, pinned)
  WHERE pinned;
CREATE INDEX ix_memory_items_scope_v2 ON memory_items
  (workspace_id, scope, project_id, task_id, status, memory_type);
-- 倒排索引：title 权重 A、正文权重 B；查询侧用同一表达式算 ts_rank。
CREATE INDEX ix_memory_items_fts ON memory_items USING gin (
  (setweight(to_tsvector('simple', search_title_tokens), 'A') ||
   setweight(to_tsvector('simple', search_body_tokens), 'B')
));

COMMENT ON COLUMN memory_items.memory_type IS
  'USER_PREFERENCE / PROJECT_FACT / EXPERIENCE / EPISODIC / UNKNOWN；旧行为 UNKNOWN';
COMMENT ON COLUMN memory_items.scope IS
  'WORKSPACE / PROJECT / TASK / AGENT；task_id/agent_id 与 project_id 共同约束归属';
COMMENT ON COLUMN memory_items.memory_key IS
  '结构化冲突键（小写 slug）。同一作用域+类型+键的有效记忆互斥，新事实替代旧事实';
COMMENT ON COLUMN memory_items.verification IS
  'VERIFIED / UNVERIFIED / FAILED；自动捕获默认 UNVERIFIED，失败经验不得标成功';
COMMENT ON COLUMN memory_items.superseded_by_id IS
  '被哪条新记忆替代；status 仍为 RETIRED，有效状态由该列派生';
COMMENT ON COLUMN memory_items.content_hash IS
  '归一化 title+text 的 SHA256；用于精确去重，不用来判定事实真假';
COMMENT ON COLUMN memory_items.search_title_tokens IS
  '标题分词（中文双字+拉丁词，空格分隔）；GIN 表达式索引的输入';
COMMENT ON COLUMN memory_items.search_body_tokens IS
  '正文分词（有界）；空值旧行由应用层回填，回填前按未索引行字面兜底';

ALTER TABLE workspace_memory_settings
  ADD COLUMN core_token_budget integer NOT NULL DEFAULT 2000,
  ADD COLUMN retrieval_token_budget integer NOT NULL DEFAULT 3000,
  ADD COLUMN retrieval_top_k integer NOT NULL DEFAULT 5,
  ADD COLUMN retrieval_mode text NOT NULL DEFAULT 'LITERAL',
  ADD COLUMN auto_consolidate boolean NOT NULL DEFAULT true,
  ADD COLUMN consolidation_interval_hours integer NOT NULL DEFAULT 24,
  ADD COLUMN memory_stale_after_days integer NOT NULL DEFAULT 180,
  ADD COLUMN embedding_provider text NOT NULL DEFAULT 'disabled',
  ADD COLUMN remote_embedding_allowed boolean NOT NULL DEFAULT false,
  ADD COLUMN include_stale_in_recall boolean NOT NULL DEFAULT false;

ALTER TABLE workspace_memory_settings
  ADD CONSTRAINT ck_memory_core_budget CHECK (core_token_budget BETWEEN 0 AND 20000),
  ADD CONSTRAINT ck_memory_retrieval_budget CHECK (retrieval_token_budget BETWEEN 0 AND 50000),
  ADD CONSTRAINT ck_memory_retrieval_top_k CHECK (retrieval_top_k BETWEEN 1 AND 20),
  ADD CONSTRAINT ck_memory_retrieval_mode CHECK (retrieval_mode IN ('LITERAL', 'HYBRID')),
  ADD CONSTRAINT ck_memory_consolidation_interval CHECK (consolidation_interval_hours BETWEEN 1 AND 720),
  ADD CONSTRAINT ck_memory_stale_after CHECK (memory_stale_after_days BETWEEN 7 AND 3650),
  ADD CONSTRAINT ck_memory_embedding_provider CHECK (embedding_provider IN
    ('disabled', 'openai-compatible'));

COMMENT ON COLUMN workspace_memory_settings.core_token_budget IS
  '固定（pinned）记忆每轮常驻预算；0 表示不常驻。默认 2000 tokens';
COMMENT ON COLUMN workspace_memory_settings.retrieval_token_budget IS
  '单次自动召回预算；默认 3000 tokens，超出时优先丢弃低相关候选';
COMMENT ON COLUMN workspace_memory_settings.retrieval_mode IS
  'LITERAL = 倒排全文；HYBRID = 有语义端口时叠加语义重排，否则降级并记录原因';

CREATE TABLE memory_recall_events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  project_id uuid,
  session_id uuid,
  query_sha256 text NOT NULL CHECK (query_sha256 ~ '^[0-9a-f]{64}$'),
  query_excerpt text NOT NULL DEFAULT '',
  mode text NOT NULL,
  candidates integer NOT NULL DEFAULT 0 CHECK (candidates >= 0),
  selected integer NOT NULL DEFAULT 0 CHECK (selected >= 0),
  tokens integer NOT NULL DEFAULT 0 CHECK (tokens >= 0),
  latency_ms integer NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
  degraded text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_memory_recall_events_workspace
  ON memory_recall_events (workspace_id, created_at DESC);
GRANT SELECT, INSERT ON memory_recall_events TO relay_app;

CREATE TABLE memory_maintenance_runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  trigger text NOT NULL CHECK (trigger IN ('MANUAL', 'AUTO', 'CLI')),
  status text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
  stats jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(stats) = 'object'),
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_memory_maintenance_finished CHECK (
    (status = 'RUNNING' AND finished_at IS NULL) OR
    (status IN ('COMPLETED', 'FAILED') AND finished_at IS NOT NULL))
);
CREATE INDEX ix_memory_maintenance_workspace
  ON memory_maintenance_runs (workspace_id, started_at DESC);
GRANT SELECT, INSERT, UPDATE ON memory_maintenance_runs TO relay_app;

COMMENT ON TABLE memory_recall_events IS
  '召回度量：只存查询摘要与计数，不存完整查询正文；用于统计检索次数与平均耗时';
COMMENT ON TABLE memory_maintenance_runs IS
  '整理运行记录：确定性去重/替代/过期标记/索引回填的结果，不保存模型生成的新事实';

-- 回滚：先删两张新表与设置列，再删 memory_items 新增列。已经写入的类型/验证/替代关系
-- 会随列删除丢失；既有正文、版本、来源与状态不受影响。
