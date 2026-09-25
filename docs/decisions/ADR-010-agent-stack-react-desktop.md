# ADR-010：适配现有工程的 Agent 栈与 React 桌面迁移

## 状态与日期

2026-09-23。React 全量迁移、Windows 桌面交付、GPT-6 Sol / Ultra 开发和大模块验收流程为 Accepted（用户明确要求）。以下组件取舍为本轮依据仓库现状选定的实施方案，具体兼容性须通过模块出口；不表示实现或验收已完成。

本轮仅修改文档和提示词。当前代码仍以 [CODEX_NEXT_STEP](../../CODEX_NEXT_STEP.md) 为准。

## 背景

用户提供 [Agent Stack 原始规格](../../Agent_Stack_Integration.md)，要求先检查代码、增量接入、保留功能与界面、Mock 闭环先于真实模型；随后明确将全部既有界面迁移至 React、做桌面端，并要求挑选适配本项目的技术。

实际工程是 Vue 3 + Fastify 5 + Kysely/pg + PostgreSQL，已有 Task/Run、Verification、Review、持久控制、Fake Gateway 和 Context。没有 Redis/BullMQ、生产 LangGraph、SSE 或真实 CodingWorkerAdapter；migrate/init 管理 CLI 不属于编程执行器。单用户同机 Windows 部署使新增数据库或通用调度系统的运维成本需要单独证明。

## 候选与取舍

| 问题 | 选择 | 原因与代价 |
|---|---|---|
| Vue 或 React | 全部既有界面迁移到 React + TypeScript + Vite | 用户明确选择；需要逐路由、交互和视觉回归 |
| 桌面宿主 | Tauri 2 + 随包 Node sidecar 优先实施 | 已有 desktop-p00 局部证据；生产进程监管、打包和安装仍须验证。Electron 仅在具体阻塞证据成立时重评 |
| Kysely 或 Drizzle | 保留 Kysely + pg | 既有 Repository、事务、迁移摘要和真实 PG 测试已依赖它；当前没有值得承担全库 ORM 迁移成本的能力缺口 |
| BullMQ/Redis 或 PG 分发 | PostgreSQL 持久 run command/outbox 与有界领取 | 单用户同机无需额外常驻 Redis；沿用同一数据库原子性。先核对 pg-boss 等成熟实现，必要时用稳定包，不提前增加第二队列 |
| 自研通用图或 LangGraph | LangGraph.js 1.x + 官方 PostgresSaver，先做适配出口 | 复用图、检查点与 interrupt；不能与旧流程形成两套规划/恢复 Owner，不能替代业务事务和 UNKNOWN 核对 |
| 模型接入 | @langchain/core + 一个实际 Provider 包 | 与选定编排边界一致；默认评估 @langchain/openai，不安装全部 Provider SDK |
| UI 状态与样式 | React 局部状态、现有窄 API client、现有 CSS/token | 不为迁移同时引入 Redux、重做设计系统或强制组件库；真实共享缓存需求出现后再选查询库 |

精确稳定版本在实施时核验官方发布、兼容范围与实际构建后锁定，不在本次文档里编造版本。完整技术组合只维护在 [技术选型](../architecture/technology-selection.md)。

## 责任边界

保留现有业务表、身份和 workspace/project 作用域。LangGraph 是接入后的唯一通用图编排器；Relay 领域入口继续拥有执行权、业务状态有效性、审批绑定、动作身份、验证及完成事务。现有固定步骤可适配为图节点，但不得留下另一套自动规划/重试循环。

API 与 Worker 分进程。API 在同一短事务保存 Run、command 和待分发事实后返回 202；PG 分发器只做领取、有限重投及对账。审批等待结束本次 invocation，释放槽位；批准后产生 resume command。框架 checkpoint 与业务提交不天然原子，恢复沿用稳定 operation_id、版本前置条件和核对证据。

Mock 创建/SSE/审批/取消/幂等/失租/崩溃恢复先通过，才启用真实 Provider。真实模型之前补显式来源选择，禁止直接外发 P11 的最近资料补位。现有旧 API 和状态枚举先映射；附件的建议命名不能覆盖当前契约。

## 替代关系与兼容性

- 部分接续 [ADR-006](ADR-006-typescript-first.md)：React 和 LangGraph/模型适配改变原 Vue、AI SDK Core 默认推荐；TypeScript、Kysely、PG、业务 Owner 和短事务原则保留。
- [ADR-007](ADR-007-windows-desktop.md) 的交付目标与宿主边界保留，窗口内容改 React。Linux Compose 仅作可选开发/测试入口，不能替代 Windows 产品。
- 原始附件保留原文。其 React“已经存在”、Drizzle、Redis/BullMQ 和 Linux 生产部署假设均由本决策明确适配，不将整份附件当作无条件安装清单。
- P00–P22 保留需求与历史证据，当前顺序由 [大模块提示词](../../prompts/stack-migration.md)接续；P22 和 V1.5 不在默认产品目标内。

API Breaking Change：No（本轮无代码）。未来路径、SSE 和幂等头在 API 主文档明确兼容策略，所有新旧入口保持同一权限边界。数据库本轮无 DDL；未来只能追加迁移，保留原内容摘要、账本、角色权限、业务数据和备份恢复能力。已有受支持 PostgreSQL 不强制升级主版本。

## 执行、验收与后续

具体实现、测试、构建和修复使用 gpt-6-sol / ultra；协调 Agent 在执行者自检后独立验收，未通过则修复并复验。普通模块验收通过后继续已授权下一模块，不重复索取例行许可。

验收门槛只维护在 [测试计划](../testing/verification-plan.md#10-技术栈改造的大模块验收)，当前模块状态只维护在 CODEX_NEXT_STEP。M01 先验证 LangGraph/PostgresSaver 与当前事务、恢复、Windows 生命周期兼容性；发现不适配时记录具体证据和替代方案，不为满足选型名称降低业务约束。
