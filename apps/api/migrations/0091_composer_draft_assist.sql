-- 输入框草稿辅助（工作台 §30、HTTP §10.84）：停笔后的自动分点与手动润色都属于
-- 「发送前的草稿辅助」。它们**不是**聊天消息、Task、Run、提案或业务批准，但仍是一次
-- 真实模型调用，因此必须进入既有 model_calls 账本（§30.4：不把「未发聊天」写成
-- 「没有模型调用」）。
--
-- 最小扩展而不是第二套账本：既有 kind 的四种取值都要求一个 Run 或 Assist 作用域
-- （DRAFT/SEMANTIC_CHECK 要 step_attempt_id，ASSIST 要 assist_message_id，VERIFY 无作用域
-- 但语义是实例连通性探针）。草稿辅助既没有 Run 也没有消息，因此新增一个无作用域的
-- kind 取值 'COMPOSER'，与 VERIFY 一样不占 Run/会话预算，但语义上明确是草稿处理调用，
-- 不冒用验证探针的身份。
--
-- 只做两件事：给 kind 增加枚举值，并补一条「无作用域」来源分支。不新建表、不加列、
-- 不回填历史行、不改 status 约束与索引。
--
-- 兼容与回滚：旧行与新枚举值不冲突，旧读取方按 kind 过滤时不会看到 COMPOSER 行，
-- Breaking Change: No。回退只需把两条约束恢复为 0043 的版本；期间写入的 COMPOSER 行
-- 会因枚举不再包含该值而违反约束——因此回退前应先删除这些调用证据行（它们只是成本
-- 证据，不是业务事实），或保留列与新值继续前进。

DO $$
DECLARE
  cons record;
BEGIN
  -- 与 0043 同一套定位方式：凡是同时提到 DRAFT 与 SEMANTIC_CHECK 的 CHECK 都是
  -- kind 枚举或 kind↔来源配对约束，逐条丢弃后重建，避免按名字硬删漏掉历史改名。
  FOR cons IN
    SELECT conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE conrelid = 'model_calls'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%DRAFT%'
      AND pg_get_constraintdef(oid) LIKE '%SEMANTIC_CHECK%'
  LOOP
    EXECUTE format('ALTER TABLE model_calls DROP CONSTRAINT %I', cons.conname);
  END LOOP;
END $$;

ALTER TABLE model_calls ADD CONSTRAINT ck_model_calls_kind
  CHECK (kind IN ('DRAFT', 'SEMANTIC_CHECK', 'ASSIST', 'VERIFY', 'COMPOSER'));

ALTER TABLE model_calls ADD CONSTRAINT ck_model_calls_kind_origin CHECK (
  (kind = 'DRAFT' AND step_attempt_id IS NOT NULL AND manifest_id IS NOT NULL
    AND assist_message_id IS NULL AND criterion_id IS NULL AND check_attempt IS NULL)
  OR (kind = 'SEMANTIC_CHECK' AND step_attempt_id IS NOT NULL AND manifest_id IS NULL
    AND assist_message_id IS NULL AND criterion_id IS NOT NULL AND criterion_id <> ''
    AND check_attempt IS NOT NULL)
  OR (kind = 'ASSIST' AND step_attempt_id IS NULL AND manifest_id IS NULL
    AND assist_message_id IS NOT NULL AND criterion_id IS NULL AND check_attempt IS NULL)
  OR (kind = 'VERIFY' AND step_attempt_id IS NULL AND manifest_id IS NULL
    AND assist_message_id IS NULL AND criterion_id IS NULL AND check_attempt IS NULL)
  OR (kind = 'COMPOSER' AND step_attempt_id IS NULL AND manifest_id IS NULL
    AND assist_message_id IS NULL AND criterion_id IS NULL AND check_attempt IS NULL)
);

-- 权限：0018/0043 的表级 SELECT/INSERT 与列级 UPDATE 已覆盖既有列，本迁移不加列，
-- 因此不追加 GRANT；应用角色仍无 DELETE，调用证据行永不删除。
--
-- 编号说明：0090 的注释把「阶段 C 余下（Run 模型快照与 OpenRouter 聊天连接）」预告为
-- 「以 0091+ 追加」；那只是当时对下一批的泛指。本批先占 0091，该批顺延到 0092 起编，
-- 不改写任何已应用的迁移。
