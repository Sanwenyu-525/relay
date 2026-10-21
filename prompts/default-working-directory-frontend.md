# 默认工作目录：前端开发任务书

请在 `D:/Develop/Relay-Agent` 完成默认工作目录的剩余前端实现，直接开发、测试并同步文档，不停在方案。所有汇报用中文；不 commit/push，不派子代理。

## 1. 范围与事实源

先读 `AGENTS.md`、`CODEX_NEXT_STEP.md`、统一功能验收表的「默认工作目录后端」行，再读：

- [工作台 §18.1.5](../docs/frontend/workbench-design.md#1815-未选目录时的默认工作目录2026-10-18已确认未实施)
- [HTTP §10.96](../docs/api/http-command-contract.md#1096-workspace-默认工作目录2026-10-19-后端实现)
- [运行架构 §2.8](../docs/architecture/runtime-context.md#28-新会话的默认工作目录作用域2026-10-18已确认待实施)
- [测试计划 §17.1.5](../docs/testing/verification-plan.md#1715-未选目录时的默认工作目录2026-10-18已确认未实施)
- [原完整任务书](default-working-directory.md)，只接剩余前端部分，原迁移计划号 0111 已过期，实际为 0117。

后端配置、创建继承与来源投影已实现。不要重做后端、迁移或目录读取链，也不要因旧标题含「未实施」就重新设计。当前共享工作区另有输入器、图片附件、插件菜单和模型选择器等未提交改动，动手前读 git status 与目标 diff，定点合并，不覆盖他人代码。后端正继续开发其他功能，不修改其文件；发现接口缺陷先报告具体请求、响应与预期，不自行扩大权限。

## 2. 负责的文件

按现有组织维护 `apps/workbench/src/api/dtos/assist.ts`、`api/parse/assist.ts`、`api/resources/assist.ts` 及其实际 facade/导出；视图优先 `SettingsView.tsx`、`CollaborationView.tsx`、`AssistView.tsx`，必要时复用已有组件。测试归现有 client、设置、新会话与目录绑定套件。不要移动输入器、重构聊天布局或建立第二套样式/token。

## 3. 已实现接口

路径前缀均为 `/workspaces/{workspace_id}`：

- GET `/default-working-directory` 返回 `{resource_id, canonical_root, display_name, write_tier, status, reason, revision}`。status 为 UNSET/READY/UNAVAILABLE；无配置时 revision="0"，其余字段为 null；UNAVAILABLE 不等于未配置。
- POST `/default-working-directory`：`{command_id, expected_revision, resource_id}`，200 命令信封，result 为 `{workspace_id, resource_id, revision}`。
- POST `/default-working-directory/clear`：`{command_id, expected_revision}`，200 命令信封，result 同上且 resource_id=null。清除保留单调修订，不回到 0。
- 目录登记继续复用 POST `/working-directories/open`；只有结果 READY 且存在 association.resource_id 才能设置默认。不得按 write_readiness=READY 判断可否设置，READ_ONLY 目录也可成为默认。
- `GET /assist-sessions/{id}?include_context=true` 的 `context.working_directory` 已带 `source: USER_PICKED / WORKSPACE_DEFAULT / null`，旧服务端缺字段按 null 兼容。
- CreateAssistSession 回执形状保持不变。仅无 Project/Task 的普通 AGENT 在创建事务继承默认；显式 Project/Task、ASSISTANT、LEARNING 不继承。创建成功后按回执 session_id 读上下文，不自己补一次目录绑定，不把默认目录所属项目当成用户显式选择。

## 4. 实现要求

1. 在设置页现有基本设置分组加入「默认工作目录」配置行，展示未设置、读取中、有效、失效、读取失败；复用现有目录选择器 `desktopHost.selectWorkingDirectory()` 与非桌面手输回退。取消选择保留原设置。
2. 选择目录后先走 OpenWorkingDirectory，READY 才设置默认；AMBIGUOUS/NOT_READY 展示服务端原因并保留原值，不猜项目、不建替代根、不自动调写档位。默认配置行不提供自动批准/完全访问选项。
3. 设置/清除严格使用最近读取的 revision。核对命令 ID、目标资源与返回修订；结果未明保留原命令和原载荷，走现有回执核对机制，不换 ID 重发、不误报成功。409 刷新当前事实并提示冲突，不能自动覆盖新设置。点击期间有忙碌态，防重复提交。
4. 更换 API/Workspace 后清除旧投影，迟到响应不能落入新范围。GET、进设置页、刷新及恢复旧会话均零写入，默认配置不得写进 localStorage。
5. 新普通会话由服务端决定作用域。创建后读回准确 session_id 的 context，更新目录和 Project 显示；显式选目录仍走原流程。不要用本地「最近目录」或前端 GET 配置推断会话实际绑定。
6. 目录细条/顶栏在 source=WORKSPACE_DEFAULT 时显示「默认目录（来自设置）」；USER_PICKED 不显示默认标记；null/缺字段不能编造来源。显式换目录后按原回执重读来源，历史会话不因全局设置变化而变更。
7. 收敛新会话空态和首条说明：未设置仍可普通讨论，读取需要选目录；默认生效时说明会用默认目录。保留「不需要先创建项目、任务」。默认失效要说明，不能显示成已有可读目录。
8. 写档位沿用服务端原投影与现有控件；配置默认不等于授予写能力，不扩大任何 Git/CLI/浏览器/电脑权限。DD-06 完整 Gateway 矩阵尚未闭合，不在前端伪造其通过。

## 5. 验证与交付

先补能暴露缺口的测试，再实现：

- client：三接口请求/解析、UNSET/UNAVAILABLE、修订保持、source 三态及旧字段缺省、命令核对失败。
- 设置：取消无写入、Open 非 READY 不设置、只读 READY 可设置、设置/清除后读回、409、传输结果不明原命令核对、切 Workspace 迟到响应隔离。
- 会话：默认继承后重读上下文且零额外绑定；显式目录优先、历史保持、ASSISTANT/LEARNING 不伪造默认目录、来源标签与换目录后更新。
- 回归：现有 settingsView、newConversationEntry、assistBinding、folderFirstConversation、emptyConversationWelcome、conversationDiffSummary 等相关套件；两侧同名文件以当前仓库实际路径为准。
- Workbench 全量 typecheck、生产构建；定向组件测试；有可用运行环境时做真实浏览器 API 链路。前端 fixture、真实 PG/HTTP、浏览器、Windows/WebView2 与真实 Provider 分开报告，不继承旧成绩。无法完成的出口如实列明原因。
- 文档只同步受影响主文档与统一验收表，不新建逐轮验收报告；阶段状态只归 CODEX_NEXT_STEP。保留历史标题锚点或同步所有引用，运行 `node scripts/check-docs.mjs` 与 `git diff --check`。

完成标准：设置→选择真实目录→保存→新普通会话→服务端继承→来源可见能跑通，旧无默认流程保持。最终说明改动、实际验证、文档同步与未验范围；不得把组件绿灯写成完整桌面交付。
