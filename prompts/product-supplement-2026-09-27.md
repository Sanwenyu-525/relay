# 9 月 27 日补充：人和 AI 共用知识库

## 授权与依据

2026-09-27 用户授权三个 `gpt-6-sol` 子代理分别执行三日产品补充，本包负责知识阅读、来源版本和收录体验。相邻工作包见 [25 日](product-supplement-2026-09-25.md)、[26 日](product-supplement-2026-09-26.md)。工作目录 `D:/Develop/Relay-Agent`。

先读 AGENTS、CODEX_NEXT_STEP、docs/README、contracts/01–04、领域模型、复用策略、ADR-010。[总纲 Knowledge](../Personal_Workflow_OS_Master_Spec.md#33-knowledge)、[信息设计 1.1](../docs/architecture/information-planning.md#11-人和-ai-共用知识来源)、[交互第 12 节](../docs/frontend/workbench-design.md#12-人和-ai-共用的知识库体验)、[验证第 12 节](../docs/testing/verification-plan.md#12-共享知识库的阅读与来源验证)为主依据；必须查看 [三张已选概念图](../docs/frontend/mockups/2026-09-27/README.md)及现有设计系统/tokens，再实现布局。

你不是唯一修改者。保留已有和他人修改，不 reset/checkout/stash/提交他人文件。共享客户端、API 注册、主文档由协调 Agent 集成；必要修改先发送确切方案。阅读同一资料不能另建第二份独立正文或改变原 Owner。

## 实施责任

1. 核对现有 Knowledge/KnowledgeVersion、受管文本、Artifact 引用、搜索和 Context DTO，逐项记录已有/补齐/待定/后置。优先解决当前详情只能读 excerpt 的实际缺口。
2. 提供按确切知识版本的完整内容读取，校验 Workspace/Project 与来源可用性，复用受管内容 hash 校验。历史引用不能被当前版本替代；区分完整正文、部分摘录、不可用、不支持、读取失败。必要新增只读 API 的路由/schema/client 修改清单交协调 Agent，应用查询、信息 repository 和专用测试由本包负责。
3. 在既有 `/knowledge` 与项目资料页实现阅读主体、版本选择、安全 Markdown/纯文本、适用时目录、来源辅助栏和返回入口。复用现有 SafeMarkdown，不引入任意 HTML；不因阅读、切版或目录跳转发起模型/外网请求。准确保留旧知识四类页签和原有写入功能。
4. 项目导读采用现有事实和明确引用的导航投影；目标/关键决定/规则/验收来源可达，缺数据显示缺口。无人工编排契约时不要新增一套关系持久化。收录确认围绕现有命令展示正文、来源类型、确切版本、归类和目标范围；保存成功才显示已收录，无证据不标为已验证。不要把所有聊天或候选自动收录。
5. 新笔记/修订保留原命令幂等、revision 冲突保稿、原件与产物不被隐式改写。AI 整理提议保存、人工编排、原件同步等缺契约部分给协调 Agent 最小方案；不以自行新增通用可信度状态代替讨论。

## 文件归属与验证

可修改：`apps/workbench/src/views/KnowledgeView.tsx/.css`、本包专用阅读/导读/收录组件及测试；`apps/api/src/application/information-queries.ts`、必要的专用 knowledge 阅读查询模块、information repository 的定向扩展和专用测试。共享 `SafeMarkdown` 如需变更先协调，优先封装复用。不要直接改 relayClient.ts、domain-schemas.ts、information-api.ts 或其他 API 注册、unit-of-work、数据库 schema/migration、全局路由/styles.css；给协调 Agent 最小补丁需求。

独占证据文档 `docs/development/product-supplement-2026-09-27.md`。API Breaking Change、契约/交互/测试文档更新内容交协调 Agent 合并。真实 PG 和写 dist 的构建与协调 Agent 约定时段；不启用真实 Provider 或覆盖现有 release。

至少验证：长中文 Markdown/纯文本全文、当前 v2 引用 v1、切换版本迟到响应、权限/作用域拒绝、缺内容和 Artifact 受管读取、原网页不可达但旧快照可读、恶意 Markdown、阅读零模型调用、修订冲突保稿、重复收录不重复写、导读无资料不造事实。执行真实隔离 PG/HTTP 定向测试、React 定向测试与类型检查。浏览器和 Windows 实测范围据实报告，未测不能宣布交付。

交付条目映射、源码/接口、实际命令与结果、待确定方案及未验证限制；完成自检后接受协调 Agent 独立复核，不把三张图或页面存在当成体验验收。
