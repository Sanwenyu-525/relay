# 2026-09-27 人和 AI 共用知识库补充：开发自检

状态：已实现本轮可由现有 Owner 支持的阅读、导读投影和显式收录界面；整体知识体验尚未完成独立 Windows 验收。依据为 [27 日工作包](../../prompts/product-supplement-2026-09-27.md)、[交互第 12 节](../frontend/workbench-design.md#12-人和-ai-共用的知识库体验)及已选三张图。本文记录本次实现与未定边界，不改变 M03–M07 状态。

## 条目与实际边界

| 工作包条目 | 本次结果 | 限制或后续 |
|---|---|---|
| 同源知识与版本核对 | 沿用 Knowledge/KnowledgeVersion、ArtifactVersion、现有搜索与 Context 来源；列表仍只返回 240 字摘录。新增确切版本只读查询，不复制可独立编辑的正文。 | Context Builder 的选源、预算和权限语义未修改；阅读不授权 AI 使用。 |
| 完整正文与来源 | `GET /knowledge/:id/versions/:version/content` 读取确切版本，校验 Workspace/Project、`availability`、内联 hash 或 ArtifactVersion 的来源归属、hash 与受管内容。正文状态区分 `FULL`、`PARTIAL`、`UNAVAILABLE`、`UNSUPPORTED`、`READ_FAILED`；来源失权按 404，不用最新版本补旧版本。 | 当前数据模型没有可核验的“仅存部分正文”来源，故本轮不会生成 `PARTIAL`；不能把摘录冒充全文。网页快照只代表保存的快照全文，不代表原网页至今未变。 |
| 人的阅读 | `/knowledge` 和项目资料页保留四类页签、列表、搜索、原有写入；Knowledge 增完整 Markdown/纯文本阅读、按版本选择、实际渲染标题目录、来源辅助栏及明确异常状态。搜索命中携带的版本写入页面 query，打开时不会偷换为当前版本。 | 目录仅覆盖现有 SafeMarkdown 支持的 1–4 级标题；未知 Markdown 语法按其既有安全渲染能力显示。旧来源关系缺失时不造反向链接。 |
| 项目导读 | 项目页可打开基于真实 Project、关联 Goal、项目 Decision/Rule/Knowledge 的只读导航，任务验收入口指向原任务页。无资料和无流程关系显示缺口。 | 当前没有 Goal 详情 UI 路由，导读显示 Goal 标识与修订作为来源；“关键决定”、人工排序、流程与资料关系尚无明确保存契约，不推断完整知识图谱。 |
| 收录核对 | 原 Knowledge 命令前显示正文/来源类型、归类和目标范围。ArtifactVersion 收录须先从确切版本只读预览，再显式核对；输入、连接或草稿变化会废弃迟到预览。成功仍以服务端命令回执和重读为准；不把收录标为验收通过。 | AI 整理建议持久保存、跨对象人工编排及确认语义没有现成契约，本轮未新建通用状态/表。人工可审阅内容后用原 CreateKnowledge 或 Artifact 提升命令保存，原件不被修改。 |
| 修订与恢复 | Knowledge 起草时冻结 ID、revision、Project 归属；即使详情随后刷新，提交仍使用原 revision。冲突时表单和正文草稿保留；原 command_id 的回执核对流程不变。 | 未新增自动合并或自动替换旧版。 |

## 接口与改动

只读 API 为 `GET /api/v1/workspaces/:workspace_id/knowledge/:id/versions/:version/content`，以合法 PostgreSQL 正 `bigint` 为版本边界。返回所选版本的来源、范围、hash、时间、`content_status` 与 `content`；非完整状态不返回未经核对的正文。已有版本列表和写命令响应不变，Breaking Change: No。查询位于 `apps/api/src/application/information-queries.ts`，HTTP 路由与客户端由协调 Agent 接线。没有数据库 migration 或新依赖。

前端改动为 `KnowledgeView`、`KnowledgeReader`、`ProjectKnowledgeGuide` 及本页样式；复用原 `SafeMarkdown`，目录从其实际渲染标题生成，不运行第二套 Markdown 解析器。阅读、搜索、切版和目录操作只读本机 API；打开外部原件必须由用户主动点击。

## 实际验证

- 本包前端：`pnpm --dir apps/workbench exec vitest run tests/knowledgeReading.spec.ts tests/knowledge.spec.ts`，16/16 通过。覆盖长中文 Markdown 与纯文本、确切旧版与迟到响应、显式缺失版本、搜索命中旧版、安全 HTML/链接、冻结修订与冲突保稿、空项目导读、产物预览迟到失效及收录门槛；旧四类信息操作测试继续通过。
- 本包前端类型检查：`pnpm --dir apps/workbench typecheck` 通过。
- 协调 Agent 执行的真实隔离 PG/HTTP：`knowledge-reading.integration.test.ts` 4/4，通过 38 项当时 migration、graph 安装、API 构建及 PG 启停，临时集群已清理。覆盖长正文与旧版、作用域/非法版本、不可用和 hash 损坏、离线网页快照、受管产物完整/缺失/损坏及重复提升。该结果是协调侧检查，非本包执行者重复运行。

未做真实 Windows WebView2 手动阅读、键盘辅助技术/桌面缩放、离线断网或真人项目理解效果验收；不据组件测试宣布完整体验交付。真实 Provider 保持关闭，未重建桌面 release。

## 协调侧复核与集成

2026-09-28：协调 Agent 接入严格 HTTP 响应契约与客户端身份/版本/可用性检查，独立编写并执行知识读取真实 PG/HTTP 4 项测试。首轮测试把 NOTE 误作为 Markdown 请求而被既有契约拒绝，改用 MANAGED_TEXT 后全部通过；未为通过测试放宽生产约束。Artifact 引用带残留内联正文的形态由现有数据库 CHECK 拒绝，测试没有禁用该约束。API 类型检查及构建通过。

协调复查退回修正了显式旧版本回退、搜索命中版本丢失、修订草稿 CAS 被刷新暗换、收录预览迟到和目标范围误示。最终独立运行 `knowledgeReading.spec.ts`、`knowledge.spec.ts`、`knowledgeContentClient.spec.ts`、`run-sources.spec.ts`、`assist-source-picker.spec.ts`，32/32 通过；工作台类型检查通过。生产前端构建写入独立临时目录并通过，未覆盖并行桌面 release；构建仍提示主 chunk 超过 500 KiB，本轮未做无关拆包优化。源码、工程测试与文档链接复核不等于 Windows 阅读及真人项目理解验收。

## 待定的最小契约选择

导读关系若要持久化，应先明确关系 Owner、引用对象的确切版本、失效规则与人工排序命令，再决定是否需要存储；当前只读投影不保存第二套 Project State。AI 整理建议若要入队，应先明确建议文本与来源版本、审阅责任、批准时的 revision/权限重检及“确认收录”和“确认内容正确”的区别，再接原信息命令。原仓库文件/网页自动同步亦需单独定义原件身份、快照更新与失权行为。本轮没有替用户默选这些策略。
