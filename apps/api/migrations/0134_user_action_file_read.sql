-- 人工触发的受管目录浏览与文件读取：USER_ACTION 来源放行 FILE_READ / FILE_QUERY
-- 能力（2026-10-24，工具面板「文件」页签后端；契约出处 docs/architecture/tool-adapters.md
-- 「人工 FILE_READ / FILE_QUERY 只读入口」段）。
--
-- 背景：0058 为人工 Git 只读新增 USER_ACTION 来源时，词表只放行 GIT_READ，
-- 当时明确记录「人工触发的目录浏览（FILE_QUERY）仍无公开入口」。工作台右侧工具面板
-- 的文件页签需要浏览受管目录与读取工作目录普通文件，本轮把这两类只读动作开放给
-- 人工来源。模型侧适配器（files/file-query.ts 的 LIST_DIRECTORY、gateway-actions.ts
-- 的 fileReadExecute）与权限裁决（prepareGatewayAction）自 2026-10-03/2026-10-04 起
-- 已存在，本迁移不新增任何执行路径，只补来源许可。
--
-- 只放宽一条 CHECK：ck_logical_operation_resource 以 0126 的最新正文为准逐条重述，
-- 并追加 FILE_READ / FILE_QUERY × USER_ACTION 一支（必须绑定受管资源）。
-- 不改表结构、不新增表/列/索引、不回填、不动 ck_logical_operation_origin 与
-- ck_invocation_run_identity——USER_ACTION 的来源形状与调用身份自 0058 起已成立。
-- 放宽只影响新行：既有行没有 USER_ACTION 的 FILE_READ / FILE_QUERY 动作，重述正文
-- 与既有约束等价。回滚＝恢复 0126 版约束文本。
--
-- 应用层词表（originAllows 的 USER_ACTION 分支）另收一层到具体动作：
-- FILE_QUERY×LIST_DIRECTORY 与 FILE_READ×READ_FILE；FIND_PATHS / SEARCH_TEXT /
-- GIT 写入 / CLI_RUN 不对人工来源开放，词表与数据库 CHECK 两层各说各的边界。

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
  OR (capability_key IN ('FILE_READ', 'FILE_QUERY')
    AND origin = 'USER_ACTION' AND resource_id IS NOT NULL)
  OR (capability_key IN ('FILE_READ', 'FILE_QUERY', 'GIT_READ')
    AND origin = 'ASSISTANT_READ' AND resource_id IS NOT NULL)
  OR (capability_key IN ('FILE_READ', 'FILE_QUERY', 'GIT_READ')
    AND origin = 'AGENT_SESSION_READ' AND resource_id IS NOT NULL)
  OR (capability_key = 'FILE_WRITE'
    AND origin = 'AGENT_SESSION_WRITE' AND resource_id IS NOT NULL)
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
