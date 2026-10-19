-- F26 内置浏览器自动化：浏览器能力的 Gateway 词表
-- （docs/architecture/browser-automation-v1.md、docs/decisions/ADR-024-builtin-browser-automation.md）。
--
-- 设计要点：
--   * 三个能力而不是一个，因为「读」「普通交互」「有外部影响的提交」的默认策略与
--     可授权性不同：BROWSER_READ 可 AUTO；BROWSER_ACTION 默认 ASK 但可被「本次任务
--     允许」覆盖；BROWSER_COMMIT（提交表单、上传文件）永不免批。合成一个能力会让
--     「看页面可以自动、提交必须逐次批准」无法表达。
--   * 不并入 COMPUTER_READ / COMPUTER_INPUT：那是 SendInput/GDI 的桌面 GUI 自动化，
--     权限语义（接管电脑）、结果形状（坐标/窗口）与恢复语义（不可重放）都不同；
--     合并会让「允许操作电脑」与「允许点网页」变成同一条授权。
--   * 浏览器动作没有受管根，但沿用 Computer 的归属方式：绑定 Project 的受管资源
--     （origin 身份与账本归属），normalized_target 用 browser://<origin> 合成值。
--   * 会话读取来源（ASSISTANT_READ / AGENT_SESSION_READ）只放行 BROWSER_READ，与
--     0060/0087/0092/0103 的只读词表同构；BROWSER_ACTION / BROWSER_COMMIT 只在 RUN
--     （Task/Run 工具循环）出现——会话轮次不产生浏览器外部效果，本迁移不新增会话写身份。
--   * CHECK 逐条重述既有分支再追加（0054/0060/0087/0092/0103 的教训：漏分支会让历史
--     动作在下次写入时违反约束）。origin 与调用身份词表本迁移不改动。

INSERT INTO gateway_capabilities VALUES ('BROWSER_READ', 'REAL', 'READ');
INSERT INTO gateway_capabilities VALUES ('BROWSER_ACTION', 'REAL', 'WRITE');
INSERT INTO gateway_capabilities VALUES ('BROWSER_COMMIT', 'REAL', 'WRITE');

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
  OR (capability_key = 'GITHUB_READ'
    AND origin IN ('ASSISTANT_READ', 'AGENT_SESSION_READ') AND resource_id IS NOT NULL)
  OR (capability_key = 'BROWSER_READ'
    AND origin IN ('ASSISTANT_READ', 'AGENT_SESSION_READ') AND resource_id IS NOT NULL)
  OR (capability_key IN ('BROWSER_READ', 'BROWSER_ACTION', 'BROWSER_COMMIT')
    AND origin = 'RUN' AND resource_id IS NOT NULL)
);

-- 兼容与回滚：纯追加三行能力 + 收紧为「新分支并集仍覆盖全部历史分支」的 CHECK 重述，
-- 不改既有行、不新增表列。回退需先确认没有 BROWSER_* 的 logical_operations 行，
-- 否则删除能力行会因外键失败——这正是「不要盲目回滚」的预期行为。
