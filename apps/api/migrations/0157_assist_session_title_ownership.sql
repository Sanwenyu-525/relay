-- 0157：会话标题的来源、自动生成任务与辅助模型调用用途（2026-11-01 SESSION_AUTO_TITLE）。
--
-- 背景：此前标题只有两种来路——界面把首条消息截 30 字、或关联目标时写 `关于<目标>`；之后
-- 只能人工改名。标题因此既不能反映真实任务，也没有「谁写过它」的事实，无法在不覆盖用户
-- 手动命名的前提下做自动命名。
--
-- 三件事分开：
--   1. `title_source` 记录**标题的来源**（会话行自身的事实）：旧行一律 LEGACY 并保持原样，
--      迁移不批量改名；新建会话是 PROVISIONAL；后台语义生成成功后才是 AI_GENERATED；
--      用户手动改名永远是 USER_DEFINED，并且只有用户显式重新生成才允许被替换。
--   2. `assist_title_generations` 记录**一次自动命名请求**的持久身份与领取状态。它是后台
--      辅助调用的可核对凭据，不是业务状态：模型输出不直接写会话标题，只有通过应用层
--      校验、且标题仍等于请求时的那一份，才由同一事务 CAS 落地。
--   3. `model_calls.purpose` 增 `TITLE`：标题生成是一次真实外呼，必须进既有账本与预算闸门，
--      但按 0153 的口径它不参与「最近一次调用」读数，也不计入本轮 PRIMARY 用量。
--
-- 回滚：删除新表与两列、把 purpose 约束恢复为三个值即回到旧形状。已生成的标题不会被
-- 回滚；那是会话行自己的值，不是本迁移派生的缓存。

ALTER TABLE assist_sessions
  ADD COLUMN title_source text NOT NULL DEFAULT 'LEGACY',
  ADD COLUMN title_generated_at timestamptz;

ALTER TABLE assist_sessions
  ADD CONSTRAINT ck_assist_sessions_title_source
  CHECK (title_source IN ('LEGACY', 'PROVISIONAL', 'AI_GENERATED', 'USER_DEFINED'));

COMMENT ON COLUMN assist_sessions.title_source IS
  '标题来源：LEGACY=旧版本已有（保护原样）；PROVISIONAL=系统临时标题；AI_GENERATED=语义生成成功；USER_DEFINED=用户手动设置（自动生成不得覆盖）';
COMMENT ON COLUMN assist_sessions.title_generated_at IS
  '最近一次自动命名成功落标题的观察时刻；人工改名与旧行不写。';

CREATE TABLE assist_title_generations (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES assist_sessions(id) ON DELETE CASCADE,
  request_kind text NOT NULL CHECK (request_kind IN ('AUTO', 'REGENERATE')),
  status text NOT NULL CHECK (status IN ('PENDING', 'CLAIMED', 'COMPLETED', 'FAILED', 'SKIPPED')),
  -- 请求发出那一刻的标题与来源。落标题必须在同一事务里核对这两项仍然相等：
  -- 用户之后手动改过的标题不能被迟到的模型结果覆盖。
  base_title text NOT NULL CHECK (base_title <> '' AND length(base_title) <= 200),
  base_title_source text NOT NULL
    CHECK (base_title_source IN ('LEGACY', 'PROVISIONAL', 'AI_GENERATED', 'USER_DEFINED')),
  -- 自动请求的输入身份：同一段输入不重复外呼（与人工可随时显式重新生成不同）。
  input_digest text NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  -- 冻结的脚手架消息：辅助外呼的 model_calls 行挂在它上面，与会话预算作用域一致。
  anchor_message_id uuid REFERENCES assist_messages(id) ON DELETE SET NULL,
  generator text CHECK (generator IS NULL OR generator IN ('MODEL', 'RULES')),
  result_title text CHECK (result_title IS NULL OR (result_title <> '' AND length(result_title) <= 200)),
  error_code text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claimed_by text,
  lease_until timestamptz,
  requested_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  settled_at timestamptz,
  CONSTRAINT ck_assist_title_generations_settled CHECK (
    (status IN ('PENDING', 'CLAIMED') AND settled_at IS NULL)
    OR (status IN ('COMPLETED', 'FAILED', 'SKIPPED') AND settled_at IS NOT NULL)
  )
);

-- 一条会话同时最多只有一个在途请求：两个生成任务并发时，后来的必须显式取代前一个，
-- 不能各自拿到一份「我会写进去」的错觉。
CREATE UNIQUE INDEX assist_title_generations_active
  ON assist_title_generations(session_id)
  WHERE status IN ('PENDING', 'CLAIMED');

CREATE INDEX assist_title_generations_claim
  ON assist_title_generations(status, lease_until, requested_at);

CREATE INDEX assist_title_generations_session
  ON assist_title_generations(session_id, requested_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON assist_title_generations TO relay_app;

-- 标题生成是辅助外呼：复用会话冻结预算与同一本账，但按 0153 的口径不抢
-- 「最近一次调用」读数、不计入本轮 PRIMARY 用量。
ALTER TABLE model_calls DROP CONSTRAINT ck_model_calls_purpose;
ALTER TABLE model_calls ADD CONSTRAINT ck_model_calls_purpose
  CHECK (purpose IN ('PRIMARY', 'MEMORY_CAPTURE', 'MEMORY_COMPACT', 'TITLE'));

COMMENT ON COLUMN model_calls.purpose IS
  'PRIMARY=面向用户的生成（含工具续轮）；MEMORY_CAPTURE/COMPACT/TITLE=辅助外呼，不参与「最近一次调用」读数';
