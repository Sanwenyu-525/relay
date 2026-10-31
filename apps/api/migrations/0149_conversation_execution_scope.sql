-- 0149：把执行范围冻结在执行请求上（2026-10-30）。
--
-- 历史行选择「失败关闭」，不做任何推断：迁移前没有持久化事实能还原「这条请求当初
-- 是不是纯机器执行」。按会话当前的 working_resource_id 或 project_id 反推，等于用今天
-- 的状态改写昨天的授权；直接给 FILE_SCOPE 则会把原本的纯机器请求解释成可以读写工作
-- 目录。两者都是静默扩权，因此历史行统一标为 LEGACY_UNCLASSIFIED：可查询、可审计，
-- 但不参与执行或接续，也不新建 Task/Run，需要用户重新发起请求。
--
-- 已经产生的 Task/Run 保持其冻结契约不变：本迁移只加列，不改 status、command_id 与
-- 任何已委托字段。
ALTER TABLE conversation_execution_requests
  ADD COLUMN execution_kind text,
  ADD COLUMN machine_capability text;

UPDATE conversation_execution_requests
  SET execution_kind = 'LEGACY_UNCLASSIFIED'
  WHERE execution_kind IS NULL;

ALTER TABLE conversation_execution_requests
  ALTER COLUMN execution_kind SET NOT NULL;

ALTER TABLE conversation_execution_requests
  ADD CONSTRAINT conversation_execution_requests_execution_kind_check
  CHECK (execution_kind IN ('FILE_SCOPE', 'MACHINE', 'LEGACY_UNCLASSIFIED'));

ALTER TABLE conversation_execution_requests
  ADD CONSTRAINT conversation_execution_requests_machine_scope_check
  CHECK ((execution_kind = 'MACHINE') = (machine_capability IS NOT NULL)
    AND (machine_capability IS NULL
      OR machine_capability IN ('COMPUTER_INPUT', 'BROWSER_ACTION')));
