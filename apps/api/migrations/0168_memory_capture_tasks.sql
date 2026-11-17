-- 0168：自动捕获任务化 + 记忆注入/生命周期补列
--
-- 背景（MEMORY-ACCEPTANCE-20261115）：0164 的自动捕获只发生在助手轮次结算之后，
-- 是一次 30 秒上界的“附带外呼”。调用失败、超时或 Worker 崩溃时，这一轮提取既没有
-- 持久记录，也无法与“本来就没有可提取内容”区分；上下文压缩又可能在提取完成前把
-- 原始轮次压掉。于是“记忆没保存”无法被观察，也无法重试。
--
-- 本迁移只追加，不修改已应用的 0164/0166：
--   1. memory_capture_tasks：每条已结算助手轮次一条持久捕获任务。身份幂等
--      （session_id + trigger_message_id + kind），状态区分
--      PENDING / RUNNING / SUCCEEDED / EMPTY / FAILED / CANCELLED；
--      重试次数、退避时间、租约与错误类别都落库，Worker 重启后按行恢复。
--   2. memory_items.instruction_risk：写入时确定性检测到的指令覆盖风险。它只用于
--      “不自动召回 + 管理页提示”，不给记忆任何指令权限，也不改变 origin/verification。
--   3. memory_items.expires_at_override：只延长/缩短有效期的确定性入口。版本正文
--      仍不可变，旧 expires_at 保留在原版本，避免“延长有效期”被迫改写正文并重置验证。
--
-- API Breaking Change: No —— 纯新增表/列，默认值保持既有行为（无任务时召回不变，
-- instruction_risk=false，expires_at_override=null 时继续读版本 expires_at）。
-- 回滚：DROP TABLE memory_capture_tasks；DROP 两列。捕获历史与覆盖值随之丢失，
--       记忆正文、版本、来源、替代关系不受影响。

CREATE TABLE memory_capture_tasks (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  project_id uuid,
  session_id uuid NOT NULL REFERENCES assist_sessions (id) ON DELETE CASCADE,
  -- 触发提取的助手消息（轮次身份）；也是“这一轮是否已捕获”的幂等键。
  trigger_message_id uuid NOT NULL REFERENCES assist_messages (id) ON DELETE CASCADE,
  -- 用户原话所在的消息；用户陈述类证据绑定它。
  user_message_id uuid,
  kind text NOT NULL DEFAULT 'AUTO' CHECK (kind IN ('AUTO', 'EXPLICIT')),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN
    ('PENDING', 'RUNNING', 'SUCCEEDED', 'EMPTY', 'FAILED', 'CANCELLED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  claimed_by text,
  error_kind text,
  last_error text,
  -- 结果摘要（写入条数、memory_id、来源类别、是否降级）；不含正文。
  result jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT uq_memory_capture_identity UNIQUE (session_id, trigger_message_id, kind),
  CONSTRAINT ck_memory_capture_completed CHECK (
    (status IN ('PENDING', 'RUNNING') AND completed_at IS NULL) OR
    (status IN ('SUCCEEDED', 'EMPTY', 'FAILED', 'CANCELLED') AND completed_at IS NOT NULL)),
  CONSTRAINT ck_memory_capture_running_lease CHECK (
    status <> 'RUNNING' OR lease_until IS NOT NULL)
);

CREATE INDEX ix_memory_capture_due
  ON memory_capture_tasks (status, next_attempt_at)
  WHERE status IN ('PENDING', 'RUNNING');
CREATE INDEX ix_memory_capture_workspace
  ON memory_capture_tasks (workspace_id, created_at DESC);
CREATE INDEX ix_memory_capture_session
  ON memory_capture_tasks (session_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON memory_capture_tasks TO relay_app;

COMMENT ON TABLE memory_capture_tasks IS
  '自动/显式记忆捕获的持久任务；状态与重试落库，不把“辅助模型失败”当成“没有可提取内容”';
COMMENT ON COLUMN memory_capture_tasks.kind IS
  'AUTO = 结算后提取；EXPLICIT = 用户明确要求记住，确定性写入，不依赖模型';
COMMENT ON COLUMN memory_capture_tasks.result IS
  '捕获回执：written / memory_ids / source_kinds / explicit / degraded；不含记忆正文';

ALTER TABLE memory_items
  ADD COLUMN instruction_risk boolean NOT NULL DEFAULT false,
  ADD COLUMN expires_at_override timestamptz;

COMMENT ON COLUMN memory_items.instruction_risk IS
  '正文含“忽略/无视系统指令”等覆盖意图；只阻止自动召回并在管理页提示，不授予任何指令权限';
COMMENT ON COLUMN memory_items.expires_at_override IS
  '用户手动延长/缩短的有效期；优先于当前版本的 expires_at，避免为改期而改写正文';
