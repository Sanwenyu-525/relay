-- 2026-10-24：工作区级上下文长度档位（256K / 512K / 1M）。
--
-- 三档就是「单次调用预算」（max_call_tokens）的取值，和 `default_write_tier` 同属
-- 「这个工作区的默认」：共用同一行、同一个修订号，一次 CAS 管住两处选择。
-- 不在这一列上新增权限事实，也不改任何既有闸门——它只决定模型调用时申请多大的预算。
-- 列可空＝还没选过；读取方按进程默认值（RELAY_MODEL_MAX_CALL_TOKENS）解释，不把空当成 0。
ALTER TABLE workspace_default_directories ADD COLUMN context_budget_tokens integer;
ALTER TABLE workspace_default_directories ADD CONSTRAINT ck_workspace_context_budget CHECK (
  context_budget_tokens IS NULL OR
  context_budget_tokens IN (262144, 524288, 1048576)
);
