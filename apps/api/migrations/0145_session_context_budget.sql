-- 2026-10-30：上下文档位从「工作区默认」改为**会话级事实**（用户指令：每个会话独立保存，
-- 新会话继承跳转前所在会话的选择）。
--
-- 三档仍是同三个值（单次调用预算 256K / 512K / 1M），但归属换成 `assist_sessions`：
--   * `context_budget_tokens` 不可空：每个会话从建立那一刻起就有一个确切档位，
--     「没选过」不再是一种状态，因此也不需要「跟随应用默认」这个选项；
--   * `context_budget_revision` 是该列自己的 CAS 版本，只在保存档位时 +1。
--     不复用 `revision`：那份修订号被改名、置顶、归档、切模式共用，拿它做档位 CAS
--     会让一次无关的重命名把用户的保存打成 409。
--
-- 迁移兼容：既有会话按「它当时实际生效的口径」回填——工作区设过档位就用那个值，
-- 没设过用 262144（与冻结快照里 `workspace_context_budget_tokens IS NULL` 时的进程默认
-- 同量级；这里给的是明确值而不是 NULL，避免升级后行为再随进程配置漂移）。
ALTER TABLE assist_sessions ADD COLUMN context_budget_tokens integer;
ALTER TABLE assist_sessions ADD COLUMN context_budget_revision bigint NOT NULL DEFAULT 0
  CHECK (context_budget_revision >= 0);

UPDATE assist_sessions s
SET context_budget_tokens = w.context_budget_tokens
FROM workspace_default_directories w
WHERE w.workspace_id = s.workspace_id AND w.context_budget_tokens IS NOT NULL;

UPDATE assist_sessions SET context_budget_tokens = 262144 WHERE context_budget_tokens IS NULL;

ALTER TABLE assist_sessions ALTER COLUMN context_budget_tokens SET NOT NULL;
ALTER TABLE assist_sessions ADD CONSTRAINT ck_assist_session_context_budget CHECK (
  context_budget_tokens IN (262144, 524288, 1048576)
);

-- 每次真实模型调用的上下文构成摘要（只存分类与数值，不存提示词、正文、路径或凭据）。
-- 绑定确切调用身份：一行 model_calls 就是一次外呼，多次工具轮次各自一行，不会互相覆盖。
ALTER TABLE model_calls ADD COLUMN context_usage jsonb;
ALTER TABLE model_calls ADD CONSTRAINT ck_model_calls_context_usage CHECK (
  context_usage IS NULL OR jsonb_typeof(context_usage) = 'object'
);
