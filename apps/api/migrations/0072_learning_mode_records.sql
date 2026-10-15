-- 学习模式：会话身份与个人学习记录（ADR-020 / 总纲 §0.12 / 领域模型 §13）。
--
-- 这一条迁移做三件事，都是**纯追加**，旧代码不读新列/新表即行为逐字不变：
--   1. 会话身份增加第三种取值 `LEARNING`（重建 0059 的 ck_assist_session_mode）。
--   2. 消息行增加「本轮不记录」标记，随发送命令持久（进命令体，因而进幂等摘要）。
--   3. 五张学习记录表：知识点身份、证据行、清除代次、会话记录控制、轮次结算依据。
--
-- 为什么身份必须独立、不能复用 ASSISTANT：
--   * ASSISTANT 是纯只读身份（ADR-018），且它的只读工具轮次路径**没有**接入
--     recordModelInvocation 计量，结算只把 usage 汇总到消息行——学习模式不能照抄。
--   * 权限等级必须是会话属性：同一条会话前半段只读、后半段可写会让「这段讨论产生过什么」
--     无法回答，违反既有不变量。
--
-- 为什么用「证据行」而不是一个熟练度枚举：
--   接触过 / 用户自述 / 实际表现 / 具体缺口是**性质不同**的证据，必须分别保留依据与时间；
--   矛盾表现为并存 + PENDING_REVIEW，而不是靠「最后一条覆盖全部」消灭矛盾。
--
-- 为什么轮次要事前冻结代次：
--   结算时读当前记录会让在途期间的纠正/删除被旧轮次吸收（复用 NLS 的
--   interpretation_baseline 形状）。旧轮次在清除或纠正后**无写入资格**。
--
-- 删除范围：全清/单项删除清掉 concepts 与 evidence（评估内容）；轮次行只改状态、**保留**
-- 为最小控制元数据（它只有冻结代次与概念代次，不含任何评估正文），这样迟到轮次能拿到
-- 「依据已过期」这一可核对原因，而不是笼统的「依据不存在」。命令回执（command_receipts）
-- 同样只存最小身份与结果元数据、**不含评估正文**，保留它不构成「借回执保留可复原评估副本」
-- （提示词 §9.3 明确允许保留最小控制元数据阻止复活）。

-- ── 1. 会话身份：AGENT | ASSISTANT | LEARNING ─────────────────────────────────
ALTER TABLE assist_sessions DROP CONSTRAINT ck_assist_session_mode;
ALTER TABLE assist_sessions ADD CONSTRAINT ck_assist_session_mode CHECK (
  (conversation_mode = 'AGENT' AND assistant_profile_id IS NULL
    AND assistant_profile_revision IS NULL AND assistant_role_snapshot IS NULL)
  OR (conversation_mode = 'ASSISTANT' AND assistant_profile_id IS NOT NULL
    AND assistant_profile_revision IS NOT NULL AND assistant_role_snapshot IS NOT NULL
    AND jsonb_typeof(assistant_role_snapshot) = 'object')
  -- 学习身份不由配置文本获得能力：人设四列必须全空。
  OR (conversation_mode = 'LEARNING' AND assistant_profile_id IS NULL
    AND assistant_profile_revision IS NULL AND assistant_role_snapshot IS NULL)
);

-- ── 2. 消息级「本次不记录」────────────────────────────────────────────────────
-- 默认 false 即「照常记录」；关闭记录是显式动作，随发送命令持久，不由模型提示决定。
ALTER TABLE assist_messages ADD COLUMN learning_record_disabled boolean NOT NULL DEFAULT false;

-- ── 3. 知识点身份 ─────────────────────────────────────────────────────────────
-- 解析只按 slug / 别名**精确**匹配，不做模糊合并、不引入向量库；命中多个候选时保留区分。
CREATE TABLE learning_concepts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  -- 主题归组（用户可见的分类），不是课程结构。
  topic text NOT NULL,
  -- 稳定标识：workspace 内唯一，跨轮次找到同一概念的依据。
  slug text NOT NULL,
  display_name text NOT NULL,
  -- 有限别名数组；形状在这里挡住，内容由应用校验。
  aliases jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- 概念代次：单项删除或纠正替换时递增，使旧轮次失去写入资格。
  generation bigint NOT NULL DEFAULT 0,
  revision bigint NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_learning_concept_slug UNIQUE (workspace_id, slug),
  CONSTRAINT ck_learning_concept_topic CHECK (length(btrim(topic)) > 0),
  CONSTRAINT ck_learning_concept_slug CHECK (length(btrim(slug)) > 0),
  CONSTRAINT ck_learning_concept_display CHECK (length(btrim(display_name)) > 0),
  CONSTRAINT ck_learning_concept_aliases CHECK (jsonb_typeof(aliases) = 'array'),
  CONSTRAINT ck_learning_concept_generation CHECK (generation >= 0),
  CONSTRAINT ck_learning_concept_revision CHECK (revision >= 1),
  CONSTRAINT ck_learning_concept_status CHECK (status IN ('ACTIVE', 'ARCHIVED'))
);
CREATE INDEX ix_learning_concept_topic ON learning_concepts (workspace_id, topic, id);

-- ── 4. 证据行 ────────────────────────────────────────────────────────────────
-- 一个知识点可以同时存在接触、自述、表现与缺口；每一行独立保留依据性质与时间。
CREATE TABLE learning_evidence (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  concept_id uuid NOT NULL REFERENCES learning_concepts (id),
  kind text NOT NULL,
  -- 具体子场景：同一术语在不同场景的表现不被无依据合并。
  scenario text NOT NULL,
  -- 具体能力或缺口描述，例如「能说明响应丢失为何导致重复提交」。
  detail text NOT NULL,
  disposition text NOT NULL DEFAULT 'ACTIVE',
  -- 依据性质：来自本轮教学交互，还是用户明确控制（纠正/撤回）。
  source_kind text NOT NULL,
  source_message_id uuid REFERENCES assist_messages (id),
  session_id uuid REFERENCES assist_sessions (id),
  observed_at timestamptz NOT NULL,
  -- 建立时的记录代次，用于清除后过滤。
  epoch bigint NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_learning_evidence_kind CHECK (
    kind IN ('EXPOSURE', 'SELF_REPORT', 'OBSERVED', 'GAP')),
  CONSTRAINT ck_learning_evidence_disposition CHECK (
    disposition IN ('ACTIVE', 'PENDING_REVIEW', 'SUPERSEDED', 'WITHDRAWN')),
  CONSTRAINT ck_learning_evidence_source_kind CHECK (
    source_kind IN ('LEARNING_MESSAGE', 'USER_CONTROL')),
  CONSTRAINT ck_learning_evidence_scenario CHECK (length(btrim(scenario)) > 0),
  CONSTRAINT ck_learning_evidence_detail CHECK (length(btrim(detail)) > 0),
  CONSTRAINT ck_learning_evidence_epoch CHECK (epoch >= 0),
  CONSTRAINT ck_learning_evidence_revision CHECK (revision >= 1),
  -- 依据性质与来源必须一致：教学行绑定本轮消息，用户控制行不绑模型消息。
  -- 这条同时挡住「模型伪造用户答题/自述」——它没有用户消息可以引用。
  CONSTRAINT ck_learning_evidence_source CHECK (
    (source_kind = 'LEARNING_MESSAGE' AND source_message_id IS NOT NULL AND session_id IS NOT NULL)
    OR (source_kind = 'USER_CONTROL' AND source_message_id IS NULL))
);
CREATE INDEX ix_learning_evidence_concept
  ON learning_evidence (workspace_id, concept_id, observed_at DESC, id DESC);
CREATE INDEX ix_learning_evidence_session
  ON learning_evidence (session_id, observed_at DESC) WHERE session_id IS NOT NULL;

-- ── 5. 清除边界（每 workspace 一行，惰性建立）────────────────────────────────
CREATE TABLE learning_record_epochs (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces (id),
  epoch bigint NOT NULL DEFAULT 0,
  cleared_at timestamptz,
  clear_command_id text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_learning_epoch_value CHECK (epoch >= 0),
  CONSTRAINT ck_learning_epoch_clear CHECK (
    (cleared_at IS NULL AND clear_command_id IS NULL)
    OR (cleared_at IS NOT NULL AND clear_command_id IS NOT NULL))
);

-- ── 6. 会话级「后续不记录」───────────────────────────────────────────────────
-- 与消息级开关分开：消息级管「本轮」，会话级管「直到用户重新开启」。
CREATE TABLE learning_session_controls (
  session_id uuid PRIMARY KEY REFERENCES assist_sessions (id),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  records_enabled boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 0,
  updated_by_message_id uuid REFERENCES assist_messages (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_learning_session_control_revision CHECK (revision >= 0)
);
CREATE INDEX ix_learning_session_controls_workspace
  ON learning_session_controls (workspace_id, updated_at DESC);

-- ── 7. 轮次结算依据（在调用模型**之前**写入）─────────────────────────────────
CREATE TABLE learning_rounds (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  session_id uuid NOT NULL REFERENCES assist_sessions (id),
  -- 一条助手消息最多一轮结算依据。
  message_id uuid NOT NULL REFERENCES assist_messages (id),
  epoch bigint NOT NULL,
  -- 冻结的相关知识点代次：{ "<concept_id>": <generation>, ... }
  concept_generations jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- 冻结时的记录控制（消息级 ∨ 会话级）；false 时模型返回增量也不写。
  record_enabled boolean NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  rejection_reason text,
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_learning_round_message UNIQUE (message_id),
  CONSTRAINT ck_learning_round_status CHECK (
    status IN ('PENDING', 'SETTLED', 'REJECTED', 'CANCELLED')),
  CONSTRAINT ck_learning_round_epoch CHECK (epoch >= 0),
  CONSTRAINT ck_learning_round_generations CHECK (jsonb_typeof(concept_generations) = 'object')
);
CREATE INDEX ix_learning_round_session ON learning_rounds (session_id, created_at DESC);

-- 学习记录由应用用例独占写入；DELETE 只服务单项删除与全清（提示词 §9.3 的删除范围）。
GRANT SELECT, INSERT, UPDATE, DELETE ON
  learning_concepts, learning_evidence, learning_record_epochs,
  learning_session_controls, learning_rounds TO relay_app;
