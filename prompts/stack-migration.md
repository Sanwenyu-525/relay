# 技术栈改造与后续开发：大模块工作包

角色：当前执行顺序与模块范围。依据：[ADR-010](../docs/decisions/ADR-010-agent-stack-react-desktop.md)、[技术选型](../docs/architecture/technology-selection.md)、[测试计划](../docs/testing/verification-plan.md#10-技术栈改造的大模块验收)。当前状态只看 [CODEX_NEXT_STEP](../CODEX_NEXT_STEP.md)。本文定义工作包，不记录开发或验收结论。

## 共用执行契约

~~~text
在 D:/Develop/Relay-Agent 执行当前模块。先读 AGENTS.md、CODEX_NEXT_STEP.md、prompts/README.md、本文件、ADR-010、技术选型和相关契约。以实际代码核对已有能力，不从空仓重建。

具体实现、测试、构建和修复使用 gpt-6-sol / ultra。协调 Agent 分派明确文件/模块所有权，告知执行者并非独占工作区，不得回退他人修改；协调 Agent 独立验收。实际工具不能选择该模型时说明阻塞，不默换模型或虚报调用。

沿用现有业务、视觉与数据；React 是全部既有界面迁移，Windows 是安装交付目标。按 ADR-010 选择项目需要的组件：保留 Fastify/Kysely/pg/PostgreSQL，API 与 Worker 分进程，LangGraph/PostgresSaver 先通过兼容出口，队列优先 PG 持久命令分发。不要照搬附件引入 Drizzle 或 Redis/BullMQ。

新依赖核对正式发布、许可、维护和兼容范围，精确锁定并提交 pnpm-lock.yaml；禁止 beta/RC、浮动 latest 或以仓库 main 的 package.json 代替发布依据。复用 .research 中相关机制与测试，研究缓存不成为产品依赖。

每模块完成实现和自检后交 READY_FOR_ACCEPTANCE；协调 Agent 在当前文件基准上复跑必要测试和反例。失败交回修复、再复验；验收通过才进入依赖它的模块。自述、静态图、Mock、浏览器和桌面安装证据不能互相替代。

同步受影响文档，运行 node scripts/check-docs.mjs。记录实际文件、命令/退出码、证据、未验证项与风险。保留未提交改动、旧 migration 和历史证据，不自动 push 或公开发布。
~~~

## M01：现状基线与技术适配

前置：用户已启动总目标。

- 盘点前后端、鉴权、路由、数据/迁移、CLI/Worker、测试及启动入口。保存既有功能和文件基准；无初始 Git commit 时用文件摘要，不能以空 diff 证明无变化。
- 映射新能力到既有目录和 Owner，不新增第二套 Task/Run/Review/Artifact。复跑相关旧基线，区分既有失败与本轮回归。
- 保留 Kysely 单一事务/迁移入口、SHA 校验、bigint 字符串和角色分离。验证 LangGraph 1.x/PostgresSaver 的 interrupt、检查点重放及与领域提交之间的崩溃窗口，确定检查点独立 schema/迁移与保留策略。
- 比较现有 PG 锁/领取机制与本地 pg-boss 参考，选择满足单用户规模的最小持久 command/outbox 分发；只负责命令，不拥有图流程。没有实测需求不增加 Redis/BullMQ。
- 锁定正式稳定依赖，明确 React/Vite/Tauri/Node 24 的兼容组合和 Windows 本机依赖方案。现有 PostgreSQL 不强制换主版本。

出口：模块映射、兼容决策、依赖版本及可重跑基线齐备；真实 PG 下事务、迁移、检查点重放和领取排他验证通过。无法满足的选型写具体证据，再调整方案，不能省略恢复约束。

## M02：完整 React 工作台与 Windows 桌面基础

前置：M01 通过。

- 建立全部旧→新路由/交互覆盖表，迁移 apps/workbench 的页面与组件：fixture/live、项目/任务创建、产物编辑/接受/完成/重开、Run/Review/控制/来源、资料管理、草稿保护、连接面板及既有其他页面。保留 CSS/token、现有图、错误/Loading/键盘与安全 Markdown 行为。
- 复用窄 API client、revision、命令回执与内存凭据规则；替换 Vue 响应式边界。不以 iframe 包 Vue 或只迁页壳声称完成。旧入口在覆盖验证通过后退出当前入口，并保留历史来源。
- 优先实施 Tauri 2 + 随包 Node sidecar。核验实际运行时、受限 IPC、Host/Origin/CSP、凭据引导/轮换、单实例、退出与进程树监管；desktop-p00 仅作参考。

出口：迁移覆盖无遗漏，React 类型/构建/组件/浏览器回归通过，真实 Windows 窗口验证人工闭环、中文输入、键盘、缩放和生命周期。完整安装升级/卸载留 M07。

## M03：Mock Agent Runtime 与可靠性闭环

前置：M01、M02 通过；真实 Provider 保持关闭。

- 复用 Task 创建和 Delegate；同事务保存 Run、command、outbox 后返回 202，独立 Worker 领取 start/resume/recovery。LangGraph 是唯一通用图，节点调用既有领域入口，PostgresSaver 与业务事实按稳定身份对账。
- 实现创建/查询 Run、SSE、审批、取消、恢复、产物查询并接回 React 页面。先映射现有 workspace 路径、command_id 与状态；若新增 Idempotency-Key，明确身份/端点/载荷绑定及旧客户端兼容。
- DB 租约、递增 fencing、心跳失败停止新动作；同 execution_thread_id 至多一个有效 invocation。审批绑定工具、规范参数、目标/hash/策略版本，审批与效果节点分开；等待释放槽位，批准产生新 resume command。
- PG 保存权威事件，关键事件/状态同事务，每 Run 串行 seq；带 Bearer 的 fetch SSE 支持 Last-Event-ID/after、去重、断线补历史和周期补查。断页仅关闭订阅。取消意图持久化并传给实际模型/工具，终态不得复活。
- 故障注入覆盖工具完成/检查点前崩溃、UNKNOWN、重复命令、双 Worker、失租、审批重复/过期、取消/完成竞争、分发器重启和队列通知丢失；原 operation_id 核对，不盲重试。
- 提供固定 Mock 任务集及最小压测，测接受/排队/输出/完成延迟分位数、成功吞吐、取消收敛、事件循环、CPU/RSS、DB/领取等待；数据不足指标如实标明。

出口：[G01–G08](../docs/testing/verification-plan.md#10-技术栈改造的大模块验收)在真实 PG、独立 API/Worker、Mock Provider 下通过。PG 领取不可只用内存队列替身测试。独立验收后才可进入真实模型阶段。

## M04：真实模型、Context、Assist 与低风险工具

前置：M03 通过；承接 P11/P12 与 P16/P17 的必要低风险部分。

- 使用 @langchain/core 和一个实际 Provider 包，优先评估 @langchain/openai。模型、endpoint、secret_ref 外置，能力显式声明；base_url 限制目标、防 SSRF，compatible API 逐项验证。
- 外发前补显式来源选择与最小必要输入，禁止直接外发 P11 最近资料补位；Manifest 的来源、版本、hash、权限和预算可追溯。
- 流式、工具参数、结构化输出、用量/未知用量、错误、长输出、多轮与取消实测；模型/工具分别有界并发、超时、总步数/调用/token 预算，多个 Worker 的全局限制不能冒充本地限制。
- 接 Files/Web 低风险能力和 Gateway，显式 allowed_roots、deadline、AbortSignal、operation_id、输出限额。完成原 P12 的 Assist、类型化提案、SemanticChecker 与已确认首批 Skill/最小 Pack；Assist 不获得 Task 自主写权。

出口：Mock 回归不退化，至少一个获授权 Provider 的真实闭环、用量与取消有证据；旧两 Provider 兼容研究门槛单列。缺配置不得扫描宿主会话密钥，真实出口保持未验证。Mock 开销与真实端到端结果分开。

## M05：完整工作体验与追溯

前置：M04 通过；业务细目见 [D 阶段](D-context-product.md) P13–P15 和已确认 P12 剩余项。

完成 Today/Focus、General/Thesis/Development 工作台、Activity/Trace/Lineage、首批 Skill 界面与来源，补齐 V1 既定真实入口；共用事实源，模型不能注入可执行页面。

出口：React 桌面真实 API 路径、版本冲突、提案/批准失效、重开及证据导航通过，F24 已确认范围有证据。

## M06：真实工具与 Coding Worker

前置：M05 通过；业务细目见 [E 阶段](E-real-adapters.md)。

补齐 Files/Web、Git 和受控 Terminal/CLI。先核对是否已有适配器再决定复用/新增，不能把管理 CLI 当 Coding Worker。逐适配器声明并实测 resumable、cancellable、approval_passthrough、sandboxed；不支持审批穿透的执行器不承担需审批的自动写。命令使用可执行文件和参数数组，验证 Windows 进程树取消、权限、跨任务资源排他与 UNKNOWN；子进程不宣称安全沙箱。

出口：真实工具与故障/冲突测试通过，不能用 Fake Gateway 成绩放行真实能力。

## M07：Windows 安装交付与 V1 总验收

前置：M01–M06 通过；业务细目见 [F 阶段](F-release-research.md) P20/P21。

完成安装入口、随包 React/Node、依赖诊断、备份与隔离恢复、升级/卸载、OpenAPI、发布说明。在真实 Windows 验证安装、单实例、强杀重启、离线人工路径、DPI/IME、孤儿进程、权限与数据保留。汇总 F01–F22/F24、A01–D11、G01–G08，压测固定任务/模型/权限/持久化语义。

出口：必要能力与安装验收全部通过才报告目标完成；有阻塞则不得以代码齐备或构建成功收尾。P22 论文实验、V1.5 不属于默认目标。

## 单模块交接模板

~~~text
执行模块 Mxx：<名称>。本次文件/模块所有权：<实际列出>。你不是唯一在工作区工作的 Agent，不回退他人修改，交叉修改先协调。
前置验收证据：<路径和文件基准>。范围：本文件对应模块及当前主文档。
使用 gpt-6-sol / ultra 实现、测试、修复并同步文档。不要自行宣布独立验收通过或进入下一大模块。
返回实际文件、命令/结果、证据、未验证项目及 READY_FOR_ACCEPTANCE 或具体阻塞。
~~~
