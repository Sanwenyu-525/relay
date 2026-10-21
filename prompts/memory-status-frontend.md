# 长期记忆状态与筛选：前端开发任务书

请在 `D:/Develop/Relay-Agent` 完成长期记忆有效状态和筛选的前端接线，直接实现、测试并维护文档；所有汇报用中文，不 commit/push，不派子代理。

## 1. 已确认范围与事实源

用户已选择「长期记忆状态与筛选」，不开发自动记忆、会话提取或学习模式。先读 AGENTS.md、CODEX_NEXT_STEP.md、统一验收表「长期记忆状态与筛选后端」行，再读：

- [工作台 §13.3](../docs/frontend/workbench-design.md#133-长期记忆状态与筛选2026-10-19已确认前端已接)
- [HTTP §10.98](../docs/api/http-command-contract.md#1098-长期记忆有效状态与筛选2026-10-19-后端接续)
- [信息与计划 §1.3](../docs/architecture/information-planning.md#13-长期记忆的有效状态2026-10-19)
- [恢复前端任务书](information-restore-frontend.md)：恢复入口已被并行工作接入，先读当前代码，不重复实现。

共享工作区存在输入器、默认目录、信息恢复等并行改动；检查 git status 和目标 diff，定点合并。只改本片，不覆盖已有恢复反馈、未决命令守卫和版本阅读，不修改后端、数据库或其他页签的业务行为。

## 2. 文件责任

主要维护 `apps/workbench/src/api/dtos/information.ts`、`api/parse/information.ts`、`api/resources/information.ts` 与实际 relayClient facade/导出，视图为 `views/KnowledgeView.tsx` 的 Memory 页签，必要样式沿既有 KnowledgeView.css。复用原筛选控件和 token，不重构页面或新增独立 Memory 页面。

## 3. 已实现协议

- GET `/workspaces/{workspace_id}/memories?effective_status=ALL|ACTIVE|EXPIRED|RETIRED`，可同时传 project_id。缺省 ALL；返回原数组，不是分页信封。项目查询含该 Project 与 Workspace 全局记忆，不含其他项目；跨 Workspace Project 为 404，非法状态为 422。
- 列表与 GET `/memories/{id}` 均增加 `effective_status`。原 `status` 仍只有 ACTIVE/RETIRED，用于写操作；不能把 EXPIRED 作为命令状态提交。
- effective_status：根 RETIRED 优先；否则当前版本 expires_at ≤ 数据库 now() 为 EXPIRED；否则 ACTIVE。状态由后端一次快照查询计算，客户端不按浏览器时钟推断。
- 历史 GET `/memories/{id}/revisions` 保持原不可变形状，不新增动态状态。
- 恢复已过期记忆后 status=ACTIVE，effective_status 仍是 EXPIRED；续期或取消到期必须使用既有 AddMemoryRevision，保留原内容并让用户明确确认，产生新版本。此片不新增续期 API。
- ACTIVE 只表示生命周期/有效期符合，不保证项目或权限可用，不保证一定进入模型 Context；查询不执行模型、不写命令、不创建审计。

## 4. 实现要求

1. 为 Memory DTO/解析器接 effectiveStatus。已知枚举严格解析；旧服务端缺字段以 null/未知兼容，展示「状态待核对」并保留原 status/到期信息，不把未知当有效，非法枚举明确失败。
2. 扩展 getMemories 的可选有效状态参数，保留所有旧调用方式；默认全部，不改 knowledge/decision/rule 的请求。验证查询参数实际发送，不能仅在前端过滤已有全部列表。
3. Memory 页签提供「全部 / 有效 / 已过期 / 已停用」筛选。沿既有页面层级放置，不增加一级导航。由真实 GET 获取结果；切换 API/Workspace/Project/页签/筛选后清理旧状态并隔离迟到响应。加载、读取失败、首次没有记忆、筛选无匹配分别表达。
4. 列表与详情状态展示基于 effectiveStatus；明确显示确认信息和有效期。已停用且已到期仍展示「已停用」；恢复后如到期则显示「已过期」，不要用命令回执只有 ACTIVE 的字段提前报「记忆现已有效」。成功后定向重读完整 DTO，原持久状态与有效状态各用其职责。
5. 保留现有停用、撤销、永久恢复、修订和明确确认入口。操作使用原 status 与最新 revision，不能把 EXPIRED 当成已停用而只给恢复。提供到原修订流程的可达入口，续期/取消到期保留原内容并由用户明确确认；不静默延长、不直接改历史版本、不自动保存。
6. 修订、停用和恢复成功后重读当前筛选结果；条目不再匹配时从列表移除，并按原草稿/选中守卫处理详情，不留错误状态。冲突或回执不明保留原命令核对机制，不换 ID 重发。
7. 时间流逝本身不会生成状态事件。回到页面/手动刷新按现有加载机制重读；不自行引入后台轮询、定时写入或每条记忆的计时器，不把上次查询结果冒充实时状态。

## 5. 验证与交付

先补能暴露缺口的用例，再实现：

- client：默认 ALL 兼容、四个枚举参数、与 project_id 组合、三态及旧服务端缺字段、非法枚举，详情和历史版本解析互不混淆。
- UI：四筛选请求与状态标签、加载/错误/空态/无匹配、切范围与迟到响应隔离；不按本机时钟自行推断。
- 生命周期：过期 ACTIVE 仍可修订/停用；恢复过期项重读后仍显示已过期；明确修订取消到期后显示有效；停用/恢复后结果不匹配筛选时正确移除，原恢复条/永久入口/未决命令不回归。
- 回归现有 knowledge、knowledgeReading、informationRestore、informationRestoreClient 及受影响 API client 套件；Workbench typecheck 和生产构建。
- 有可用环境时用真实 API 浏览器验证 Workspace/Project 范围和过期数据。组件、真实 PG/HTTP、浏览器、Windows 证据分开报告；不把后端已有成绩当作本轮前端验收。

同步所属主文档、统一验收表与 CODEX_NEXT_STEP，运行 `node scripts/check-docs.mjs`、`git diff --check`。不新建逐轮验收报告。遇协议不符，给出具体请求/响应并报告，不在前端降低权限或静默修改后端。

交付包含改动、实际验证、文档同步与未验边界；此片完成不代表自动记忆、学习模式或全记忆产品均已交付。
