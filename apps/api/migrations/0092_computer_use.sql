-- Computer Plugin V1：桌面级能力的 Gateway 词表（docs/architecture/computer-plugin-v1.md）。
--
-- 设计要点：
--   * COMPUTER_READ（截图/窗口枚举，effect READ）与 COMPUTER_INPUT（窗口激活/鼠标/
--     键盘，effect WRITE）是两个能力而不是一个：approvalPassthrough、恢复语义与
--     权限默认值都不同，混成一个能力会让「读允许、写要批」无法表达。
--   * 会话读取来源（ASSISTANT_READ / AGENT_SESSION_READ）只放行 COMPUTER_READ，
--     与既有只读词表同构；COMPUTER_INPUT 只在 RUN（Task/Run 工具循环）出现，
--     由单动作审批或本次任务范围授权放行——会话轮次不产生输入类外部效果。
--   * Computer 动作没有受管根，但仍绑定 Project 的受管资源（origin 身份与账本
--     归属），normalized_target 用合成值 computer://desktop。
--   * 三条 CHECK 逐条重述既有分支再追加（0054/0060/0087 的教训：漏分支会让历史
--     动作在下次写入时违反约束）。origin 与调用身份词表本迁移不改动。

INSERT INTO gateway_capabilities VALUES ('COMPUTER_READ', 'REAL', 'READ');
INSERT INTO gateway_capabilities VALUES ('COMPUTER_INPUT', 'REAL', 'WRITE');

ALTER TABLE logical_operations DROP CONSTRAINT ck_logical_operation_resource;
ALTER TABLE logical_operations ADD CONSTRAINT ck_logical_operation_resource CHECK (
  (capability_key = 'FAKE_WRITE' AND origin = 'RUN' AND resource_id IS NOT NULL)
  OR (capability_key = 'FAKE_PUBLIC_READ' AND origin = 'USER_IMPORT' AND resource_id IS NULL)
  OR (capability_key = 'WEB_FETCH' AND origin = 'RUN' AND resource_id IS NULL)
  OR (capability_key = 'WEB_FETCH' AND origin = 'USER_IMPORT' AND resource_id IS NULL)
  OR (capability_key IN ('FILE_READ', 'FILE_QUERY') AND origin = 'RUN' AND resource_id IS NOT NULL)
  OR (capability_key IN ('FILE_WRITE', 'GIT_READ', 'GIT_WRITE', 'CLI_RUN')
    AND origin = 'RUN' AND resource_id IS NOT NULL)
  OR (capability_key = 'GIT_READ' AND origin = 'USER_ACTION' AND resource_id IS NOT NULL)
  OR (capability_key IN ('FILE_READ', 'FILE_QUERY', 'GIT_READ')
    AND origin = 'ASSISTANT_READ' AND resource_id IS NOT NULL)
  OR (capability_key IN ('FILE_READ', 'FILE_QUERY', 'GIT_READ')
    AND origin = 'AGENT_SESSION_READ' AND resource_id IS NOT NULL)
  OR (capability_key = 'COMPUTER_READ'
    AND origin IN ('ASSISTANT_READ', 'AGENT_SESSION_READ') AND resource_id IS NOT NULL)
  OR (capability_key IN ('COMPUTER_READ', 'COMPUTER_INPUT')
    AND origin = 'RUN' AND resource_id IS NOT NULL)
);
