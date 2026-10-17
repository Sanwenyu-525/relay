-- F25 内置官方 GitHub Skill 的首片：GitHub 只读能力的 Gateway 词表
-- （docs/decisions/ADR-023-builtin-github-skill.md、docs/architecture/relay-skills.md §10）。
--
-- 设计要点：
--   * 只新增一个能力 GITHUB_READ（effect READ），不新增写能力。GitHub 侧的写动作
--     （开 PR、评论、合并）另片，且必须先冻结 UNKNOWN 核对协议——gh 的写结果没有
--     像 commit sha / remote ref 那样可稳定回读的证据。
--   * 不复用 CLI_RUN：CLI_RUN 是写语义（approvalPassthrough=false、resumable=false、
--     UNKNOWN 恒隔离），且其入口必须是连接上的绝对路径白名单、连接创建后不可更新。
--     把「读一下 PR 列表」挂在写能力上会让只读查询进入 UNKNOWN 隔离，反而更不安全。
--   * 会话读取来源（ASSISTANT_READ / AGENT_SESSION_READ）放行 GITHUB_READ，与 0060/0087/0092
--     的只读词表同构；RUN 来源本迁移不放行——工具循环信封的 connections 形状是冻结协议，
--     放开它需要执行契约与审批链一起改，属于写动作那片的前置。
--   * GITHUB_READ 绑定受管资源（resource_id NOT NULL）：目标就是那个仓库目录，适配器在
--     该目录里让 gh 自己解析 remote，因此「读的是哪一个仓库」由受管根与权限前缀共同决定，
--     模型不能指名别人的仓库。origin 与调用身份词表本迁移不改动。
--   * 三条 CHECK 逐条重述既有分支再追加（0054/0060/0087/0092 的教训：漏分支会让历史
--     动作在下次写入时违反约束）。

INSERT INTO gateway_capabilities VALUES ('GITHUB_READ', 'REAL', 'READ');

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
);
