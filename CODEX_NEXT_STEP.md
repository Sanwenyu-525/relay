# Relay 当前状态与下一步

角色：项目当前进度的唯一主文档。更新：2026-09-24（M01/M02 已验收；M03 固定 Mock 图、Task 产物历史与新版 Windows CRITERION/ACTION_APPROVAL 组合分片已验收，G01–G08 待验）。目标、实现、自检和验收分别记录。

**迁移前的业务线正式验收仅覆盖 P05/P06 已实现的 Fake Workflow 与完成 Gate，整体产品未放行。** R05 两项修复的独立复验记录见[第 9 节](docs/testing/frontend-backend-acceptance-2026-09-21.md#9-r05-修复后独立复验2026-09-23)：当时后端 57/57 单测、113/113 真实 PG 集成，前端 80/80 组件、19/19 Chromium 通过。此后 P07–P11 是继续开发和自检；M01、M02 及 M03 分片验收只证明各自列明的改造范围，不能推断 P07–P11 完整业务、Provider、安装或整体恢复已获放行。

## 当前改造模块状态

当前模块：M03，状态：IN_PROGRESS（分片实现与验收中）。M02 已完成独立验收：React 全量迁移与真实 Windows 桌面基础通过，J 发现的 live 任务入口示例泄漏及缩放快捷键关闭已在新包 K/L 原生会话复验；125%→150% 系统 DPI 后恢复原设置，接近 200% 内容缩放时导航和 ID 输入可达。该 M02 EXE SHA-256 为 `3e56ff5efd4fd321593f10fe8e016796db9c288dd5c2b1077b7f926c30187ebb`，完整链路、PG 事实、安全边界与过程限制见 [M02 独立验收记录](docs/testing/m02-independent-acceptance.md)。M03 已分别独立验收 React Delegate/Review、SSE 客户端与创建结果导航片、后端持久命令与独立 Mock Worker、0013 顺序命令与 Review/RESUME 栅栏、桌面私有协议及 64 KiB 回执补救、Windows 进程组与事件读取、逐旧 launch 恢复回执和真实 Windows/PG/Worker 宿主组合、PG Run SSE 后端片、LangGraph/PostgresSaver 固定 Mock 图与 ACTION_APPROVAL 后端动作、Task 产物历史 API/Chromium 刷新路径、冻结包的真实 WebView2/PG/Mock Worker SSE 联测与单一受控断流同页自动重连片，以及新版 Windows 包中的创建→Delegate→CRITERION Review→宿主重启→原 RESUME 和 ACTION_APPROVAL→单次 Fake 效果→后继 CRITERION Review 两条链；[M03 记录](docs/testing/m03-independent-acceptance.md)明确各片边界。ACTION 组合首轮 r1/r2 曾因 Task 状态修订误触发 BUILD_CONTEXT/DRAFT 重跑而拒收；修复后新版包独立复验通过，可用隔离桌面会话试用固定 Mock Agent。G03 Gateway UNKNOWN Run 查询/UI 和 G06 在途 Mock 模型取消已开发并完成定向自检；React 已接入可选 Mock 文件动作委托与 Run 动作历史，并构建新的试用包。按用户要求，本轮只做开发，不进行 M03 G01–G08 正式验收。完整 Mock 创建、SSE、审批、取消、恢复 G01–G08 尚未通过，真实 Provider 保持关闭。旧图 checkpoint 的待审 Run 升级兼容仍须在 M07 前实测解决。M01 证据见 [独立验收记录](docs/testing/m01-independent-acceptance.md)。

| 模块 | 范围 | 状态 | 验收证据 |
|---|---|---|---|
| M01 | 现状基线与技术适配 | ACCEPTED | [独立验收](docs/testing/m01-independent-acceptance.md)：PG 适配 3/3、迁移 7/7、持久化 15/15、React 构建、Tauri MSVC check 与文档检查通过；[开发记录与基准](docs/development/m01-stack-baseline.md) |
| M02 | 完整 React 工作台与 Windows 桌面基础 | ACCEPTED | [独立验收](docs/testing/m02-independent-acceptance.md)：最终包类型检查、116/116 组件、20/20 Chromium、Rust 4/4；旧→新路由与视觉、真实 WebView 人工链/SQL、原生 IME/草稿/长文本、DPI/内容缩放、安全边界与生命周期通过；安装总验收留 M07 |
| M03 | Mock Agent Runtime 与可靠性闭环 | IN_PROGRESS | React 首片、SSE 客户端与创建导航、后端分发/PG SSE/0013 顺序命令/固定 Mock 图与 ACTION_APPROVAL 后端、Task 产物历史 API/Chromium、桌面私有协议及逐旧 launch 恢复回执、Windows 宿主强杀恢复、真实 WebView2 SSE/同页重连和新版包的 CRITERION Review/RESUME 与 ACTION_APPROVAL→单次 Fake 效果均通过分片独立复验，范围见[独立验收记录](docs/testing/m03-independent-acceptance.md)；G03 查询/UI、G06 Mock 在途取消和可选 Mock 动作 React 入口已开发，仍无 G01–G08 整体通过结论，真实 Provider 保持关闭 |
| M04 | 真实模型、Context、Assist、低风险工具 | NOT_STARTED | 尚未执行 |
| M05 | 完整工作体验与追溯 | NOT_STARTED | 尚未执行 |
| M06 | 真实工具与 Coding Worker | NOT_STARTED | 尚未执行 |
| M07 | Windows 安装交付与 V1 总验收 | NOT_STARTED | 尚未执行 |

2026-09-24 前一版开发自检增量：G03 Gateway UNKNOWN 原 ID 已进入 Run 查询与 React 告警；G06 持久控制可中止在途 Mock 模型，并在旧 Worker 退出后收敛。API 隔离 PG 全量 251/251、React 组件 134/134、Chromium 21/21；固定 Mock 小负载 8 个完成、2 个取消，原始结果见 [Mock 测量](docs/testing/evidence/m03/mock-bench-20260924-225511-ad4f1b7c/summary.json)，只作小样本基线。该版 Windows 开发包 EXE SHA-256 为 `521b65e08c5dbdaaaf8aa3962bad6cf8d2fbd1e548efd85c3a6b00635c0adbca`，现已由下述新包替换；原始输出见[日志](docs/testing/evidence/m03/mock-g03-g06-build-release-retry.log)。按用户本轮指令，只继续开发和试用，不进行 G01–G08 独立总验收；M03 保持 IN_PROGRESS，真实 Provider 保持关闭。

同日后续 React 接入增量：Task 可从同 Project 现有 P09 配置选择可选 Mock 文件动作，并随 Delegate 原命令冻结；Run 按需读取本次 Gateway 动作与 Invocation 历史。普通 Mock 委托不带该字段。前端全量组件 136/136、类型检查与 Vite 构建、文档检查通过；未更改公开 API、数据迁移或权限边界。当前试用 release EXE SHA-256 `ad4a40cd08502c3a5013f081acc08bce0bed4bfb671991f91609979f52086a25`，构建日志见[记录](docs/testing/evidence/m03/mock-action-ui-build-release.log)，清单见[当前 manifest](apps/desktop/release/desktop-build-manifest.json)。已启动新的隔离桌面试用会话，仅作开发交付，不作为 G01–G08 验收。

同日再后继可靠性反例增量（开发自检）：run-graph 集成测试新增三组真实隔离 PG 反例，36/36 通过、构建/迁移/图安装/PG 启停退出 0、临时集群已删除，日志见[证据](docs/testing/evidence/m03/manifest-integrity-settle-race-run-graph.log)。（1）持久 Manifest 逐项完整性：15 种篡改（逐字段失配、异形类型、sources 结构异常、BUILD_CONTEXT result_ref 剥离 `manifest_hash`、Manifest 行缺失）在 ASK 等待期间经迁移角色注入后，已批准 RESUME 一律在 Gateway Admit 前以 `GATEWAY_CONTEXT_STALE` 拒绝：无 Invocation、无 Fake 写入、原 operation_id 转 DENIED、Run FAILED/Task READY；未篡改对照组单次准入。（2）G06 取消与结算竞争：控制请求于结算窗口内持久化后，无论 100 ms 控制轮询是否先行观察到意图，`settleRunCommand` 结算安全点或重投递的 CONTROL_PENDING 领取都把 Run 收敛为 CANCELLED/Task READY、控制 APPLIED，已发布候选保留且无后续可领取命令。（3）G06 终态收敛：完成竞胜后遗留的 PENDING CANCEL（以仓储入口直接重构该持久状态，API 对终态 Run 会直接拒绝同请求）在安全点被拒绝（REJECTED / `RUN_TERMINAL_OR_STALE`），Run/Task 保持 COMPLETED/DONE，1 ArtifactVersion/CompletionRecord 保留，无复活投递。测试改动仅限 `apps/api/test/integration/run-graph.integration.test.ts`，无生产代码、迁移或公开 API 变化。同基准全量隔离 PG 集成 254/254、零跳过，单测 66/66、类型检查通过；定向日志见[证据](docs/testing/evidence/m03/manifest-integrity-settle-race-run-graph.log)，全量输出见[记录](docs/testing/evidence/m03/manifest-integrity-settle-race-full-pg.log)。本增量仍是开发自检，不构成 G01–G08 验收。

当前选择：React 全量迁移；Tauri 2 + Node sidecar 优先实施；保留 Fastify、Kysely/pg 和 PostgreSQL；LangGraph/PostgresSaver 先做适配；PG 持久 command/outbox 优先，不照搬附件增加 Drizzle/Redis/BullMQ。具体开发为 gpt-6-sol / ultra，协调 Agent 在每个大模块后独立验收，门槛见 [测试计划第 10 节](docs/testing/verification-plan.md#10-技术栈改造的大模块验收)。决策依据见 [ADR-010](docs/decisions/ADR-010-agent-stack-react-desktop.md)。

M01 基线时点 apps/workbench 为 Vue；M02 已完整迁移到 React 并完成上述范围的独立桌面验收。apps/api 已有 Fastify/Kysely、Bearer 与 workspace 边界、Task/Run/Review/控制/Fake Gateway；M03 已有生产 SSE、固定 Mock LangGraph 图、ACTION_APPROVAL 后端效果与独立 Mock Worker；尚无真实 Coding CLI；Mock 在途模型取消已接入，真实 Provider/工具取消未接。M01 使用现有便携 Node24/PG18 复跑旧 API 57/57 单测、167/167 真实 PG 集成、旧 Vue 110/110 组件与 19/19 Chromium，并保存 15 张真实 Vue fixture 截图；新隔离适配实验的真实 PG 3/3、React/Vite 构建与 Tauri MSVC 编译检查均通过，未变成产品运行验收。P12 旧接续计划由 M01–M07 替代。

## 1. 当前阶段

`apps/api` 已实现 P00–P11 的 Project/Goal/Task/State、受管 Artifact 与人工完成/重开、Fake Run、Verification/自动完成 Gate、Review、持久控制、Fake Gateway、长期信息/规则/搜索，以及 Context Builder。`0010_v005_context_revision` 独立记录来源修订；接口状态见[HTTP 契约第 10 节](docs/api/http-command-contract.md)，持久化见[物理设计](docs/database/physical-design-postgresql.md)。`apps/workbench` 保留示例预览与真实 API 人工路径，含「待审」页、Run 详情/控制/来源页和 Workspace/Project 资料页；P09 配置尚无前端管理页。P11 开发自检：后端真实 PG 全量 **167/167**、Context 定向 **9/9**、Verification 回归 **24/24**、单测 **57/57**，前端 Sources/Run 定向组件 **14/14**；类型检查、构建与文档检查通过，PG 临时集群已停止并删除。**这不是新的正式验收结论。** P12 真实模型与 AI Assist 待按新模块顺序接续；桌面完整路径、真实 Provider 连通、安装交付及整体产品仍未验收。

P09 当前只允许固定 Fake marker 写和公共假读。配置及动作历史有 HTTP 接口，Prepare、Worker claim、Admit、执行、结果登记和 UNKNOWN 核对仍是内部应用端口；DISPATCHING 后目标当前缺失不能证明未执行，资源保持隔离。P08/P09 都没有生产自动恢复调度器或进程停机证明，也不能由 Fake 结果推断真实 Web/Git/CLI 与 Windows 宿主隔离已通过。P10 已接四类信息事实源、Rule 适用性和有界字面搜索；Rule 修订目前用 Workspace 级全局栅栏，可能保守地使其他 Project 的旧 Run 失效。P11 只给 FakeModelPort 构建 Context，尚无用户显式选源入口、真实 Provider 外发、Assist 或精确 token 计量；最近同范围资料补位的外发边界见[运行设计](docs/architecture/runtime-context.md#p11-当前实现边界2026-09-23)。P17 URL 抓取未实现。

### P06 时点的历史基线

后端已实现 P00–P03：`apps/api` 具备工程边界、V001/0002/0003 持久化、Project/Goal/Task/State 命令与查询、受管 Artifact 内容、人工完成/重开，以及 `/health/ready` 的只读 schema 兼容门。**P05 已完成**：`0004_v002_runs` 建立 Run/执行契约/Step/Attempt/Context Manifest，`POST /tasks/{id}/delegations` 原子授予 AI 执行权并创建 `CREATED` Run，内部应用端口 `advanceRunStep` 以固定 `markdown-deliverable-v1` 与 FakeModelPort 推进 `BUILD_CONTEXT → DRAFT → PERSIST_CANDIDATE`，最终候选写入不可变 ArtifactVersion 后 Run 停在 `VERIFYING`；失败路径释放执行权回 READY，B01 并发 Delegate、B06 `retry_of_run_id`、A08 无 Project 拒绝、步骤结果去重与迟到 epoch 拒绝均有真实 PG 用例。**P06 已完成**：`0005_v002_verification` 建立 Verification Session/Target/CheckResult 与适用性撤销，`VERIFY` 由冻结契约派生 CheckPlan（Worker 无写权）并给出 `PASS`/`RETRY`/`HUMAN` 总判定，检查器 `ERROR` 只重试检查本身、修正预算耗尽转人工，`COMPLETE` 以统一短事务写 `completion_records`（basis `AUTO`）、Task 完成指针、Project State delta 与审计并释放执行权；C01/C04/C05/C06/C07 与 D04/D05/D06、验证撤销、基准删减、修正回路均有用例。真实复跑为集成 **109/109**、单测 **57/57**。前端已有 9 页 fixture 预览与真实 API 人工路径（连接后可创建项目、创建任务、开始、任务详情、保存 Markdown 版本、选择接受、完成与重开）。**整体验收仍不放行**：Review 与人工判断、控制与恢复（P07–P08）、桌面窗口内的完整路径、并发竞争与 Windows 安装交付仍未验收。证据见[独立验收记录](docs/testing/frontend-backend-acceptance-2026-09-21.md)、[前端预览记录第 9、10 节](docs/development/ui-preview-acceptance.md#10-ui-10-任务详情与-ui-11-产物编辑2026-09-21)、[HTTP 契约 §10.7/§10.8](docs/api/http-command-contract.md#108-p06verification-与完成-gate2026-09-22)与[物理设计 §15/§16](docs/database/physical-design-postgresql.md#16-0005-实际-migration-与兼容性2026-09-22-p06-实施记录)。当前工作区为 D:/Develop/Relay-Agent；旧迁入路径仅在历史记录保留。产品与设计导航见 [README](README.md)和[文档地图](docs/README.md)。

### 当前设计与交付边界

当前目标由 ADR-010 接续，历史实现与未完成出口保留；准确组合、可选项及验证条件只看[技术选型](docs/architecture/technology-selection.md)和 [ADR-010](docs/decisions/ADR-010-agent-stack-react-desktop.md)。前端视觉按用户指定的现有图提炼，准确值见[设计系统](docs/frontend/design-system.md)与 [tokens](docs/frontend/design-tokens.json)；并行页面实现与验收状态由[前端预览记录](docs/development/ui-preview-acceptance.md)维护。

交付形态已明确确认：Windows 可安装应用，有独立窗口和启动入口。桌面壳推荐与旧浏览器提案的替代关系见 [ADR-007](docs/decisions/ADR-007-windows-desktop.md)；Tauri 2 + Node sidecar 优先验证，技术细节仍为 Proposed，没有安装包。

## 2. 已有产出与证据边界

| 产出 | 证据入口 | 能证明什么 |
|---|---|---|
| 产品范围与业务契约 | [范围](docs/requirements/v1-scope.md)、[契约](contracts/README.md) | 设计与验收规格，不是功能通过 |
| 源码研究、隔离实验 | [P00 记录](docs/research/p00-source-study.md) | 该记录明确的框架/替身/单机实验范围，不能转为生产结论 |
| TypeScript-first 验证准备 | [ADR-006](docs/decisions/ADR-006-typescript-first.md)、[数据库实验](experiments/typescript-p00/README.md)、[SDK 实验](experiments/ai-sdk-p00/README.md) | 13 项真实 PG 基础断言及 8 项 SDK 离线测试已通过并独立复验，后者含 Fastify/TypeBox 共享 schema 输入；三个完整业务 Spike 尚未通过，不代表生产栈冻结 |
| 恢复与桌面局部验证 | [恢复实验](experiments/recovery-p00/README.md)、[桌面实验](experiments/desktop-p00/README.md) | 恢复/控制的局部结果与复验见 P00 记录，含联合准入、两步推进、业务完成短事务及控制/完成顺序的第三批证据；受控外部效果后的单次 PostgreSQL 重启恢复已验证，release 目录包已独立验证真实 WebView 握手、单实例、错误 readiness 拒绝、强杀宿主后的子进程回收及构建来源绑定；多产物/人工处置、Provider 出口、桌面安装与安全出口尚未通过 |
| P00 生产工程骨架 | [apps/api](apps/api/package.json)、[README](README.md#后端工程appsapi) | 最小 workspace 与 API 骨架：配置缺失明确失败、未鉴权 401、错误 Host/Origin 拒绝、liveness/readiness、停止后退出，均有真实 PostgreSQL 集成测试；只有存活与就绪检查，无业务端点、桌面壳或安装交付 |
| P01 V001 与持久化 | [migrations/0001](apps/api/migrations/0001_v001_human_core.sql)、[物理设计 §11](docs/database/physical-design-postgresql.md) | V001 21 张人工切片表、复合/延迟外键、CHECK、周期唯一与不可变表只读均落在真实 migration；单一迁移入口含 SHA-256 内容校验，应用角色与迁移角色真实分离，30 项真实 PG 集成测试通过并独立复验。没有业务端点或人工闭环 |
| P02 应用用例与 HTTP | [apps/api/src/api](apps/api/src/api)、[HTTP 契约 §10](docs/api/http-command-contract.md) | Project/Goal/Task/State 的真实 HTTP 用例：`command_id` 回执重放、期望版本冲突、作用域不可见、类型化 State 命令、键集分页；P02 当时 56 项真实 PG+HTTP 集成测试与 22 项单测通过并独立复验；Artifact/完成/重开由 P03 接续 |
| P03 与本轮前后端验收 | [独立验收](docs/testing/frontend-backend-acceptance-2026-09-21.md) | 后端受管内容、人工完成/重开与 9 页 fixture 已实现；BE/FE 修复在各自真实 PG 或 fixture 范围复验通过，但未真实联调或桌面验收 |
| 真实 API 最小闭环（批次三） | [前端预览记录第 9 节](docs/development/ui-preview-acceptance.md#9-真实-api-接入最小闭环2026-09-21) | Workbench 默认 fixture，显式连接本机 API 后可真实创建项目、创建任务（含 ready）、读取项目任务与开始任务；已在真实 PostgreSQL 上以 Chromium 闭环自测通过并交叉核对数据库行。仍是开发期自测，未覆盖产物/完成/重开、项目列表、并发竞争与桌面 |
| P04 人工路径（批次四） | [前端预览记录第 10 节](docs/development/ui-preview-acceptance.md#10-ui-10-任务详情与-ui-11-产物编辑2026-09-21) | UI-10 任务详情与 UI-11 产物编辑接入真实 API：保存不可变 Markdown 版本、Project State 选择接受、必需条件完成、重开新验收版本；Chromium 全路径 16 项断言与数据库交叉核对通过。版本列表仍依赖会话内记忆（产物列表端点待接入），桌面窗口内未验证 |
| P05 固定 Workflow 与 Run | [HTTP 契约 §10.7](docs/api/http-command-contract.md#107-p05delegate-与-run-查询2026-09-21)、[物理设计 §15](docs/database/physical-design-postgresql.md#15-0004-实际-migration-与兼容性2026-09-21-p05-实施记录) | `0004_v002_runs` + `POST /tasks/{id}/delegations` + `GET /runs/{id}` + 内部 `advanceRunStep`：固定 `markdown-deliverable-v1`、FakeModelPort、执行契约冻结、Step/Attempt 去重与 epoch fencing；真实 PG 集成 95/95、单测 37/37。只有 Fake Runtime，没有控制请求、Verification、Review 或外部副作用 |
| P06 Verification 与完成 Gate | [HTTP 契约 §10.8](docs/api/http-command-contract.md#108-p06verification-与完成-gate2026-09-22)、[物理设计 §16](docs/database/physical-design-postgresql.md#16-0005-实际-migration-与兼容性2026-09-22-p06-实施记录) | `0005_v002_verification` + `VERIFY`/`COMPLETE` 步骤：冻结 CheckPlan、不可变 `check_results`、`PASS`/`RETRY`/`HUMAN` 总判定、检查器故障有界重试、修正预算与修正回路、适用性撤销、自动完成短事务与 `COMPLETION_BLOCKED`；真实 PG 集成 109/109、单测 57/57。FakeSemanticChecker 是替身，Review/控制/资源仍属 P07–P08 |
| P07 Review 开发自检 | [HTTP 契约 §10.9](docs/api/http-command-contract.md)、[物理设计 §17](docs/database/physical-design-postgresql.md)、[待审页](docs/development/archive/m02-vue-workbench-baseline/src/views/ReviewsView.vue) | `0006_v002_reviews` + 待审/Run Review 查询及决定接口、人工判断/修正预算/检查器重试/动作批准占位/State 提案效果；后端 121/121 真实 PG 集成、57/57 单测，前端 83/83 组件与构建通过。未做正式验收，动作批准不表示执行，控制与恢复仍待 P08 |
| P08 控制与受控恢复开发自检 | [HTTP 契约 §10.10](docs/api/http-command-contract.md)、[物理设计](docs/database/physical-design-postgresql.md)、[Run 页](docs/development/archive/m02-vue-workbench-baseline/src/views/RunView.vue) | `0007_v003_recovery_control` + PENDING 控制/Resume、Task→Run 锁序、Worker fence、同一动作身份的 Fake 发布恢复、HANDOFF 事实引用；后端真实 PG 137/137、单测 57/57，前端组件 90/90，类型检查与构建通过。未做正式验收；自动恢复调度与真实工具未实现，通用资源由后续 P09 接续 |
| P09 Fake Gateway 开发自检 | [HTTP 契约 §10.11](docs/api/http-command-contract.md)、[0008 migration](apps/api/migrations/0008_v003_gateway.sql)、[工具架构](docs/architecture/tool-adapters.md) | Connection/Capability/Permission 分离、策略不可变版本与默认 DENY、authority 撤销/准入、跨 Workspace 重叠根占用、RUN/USER_IMPORT 来源、批准占用及 Invocation 历史；真实 PG 全量 150/150、P09 定向 13/13、单测 57/57，类型检查/构建通过。未做正式验收；真实工具、生产停机证明及宿主外进程隔离未实现 |
| P10 长期信息、Rule 与搜索开发自检 | [HTTP 契约 §10](docs/api/http-command-contract.md)、[0009 migration](apps/api/migrations/0009_v004_information_rules.sql)、[资料页](docs/development/archive/m02-vue-workbench-baseline/src/views/KnowledgeView.vue) | Knowledge/Memory/Decision/Rule 类型化根与版本、明确确认/替代/检查路径、Rule 与冻结契约联动、有界字面搜索和真实管理 UI；P10 时点后端真实 PG 全量 158/158、定向 7/7、Gateway 14/14、单测 57/57，前端定向组件 7/7，类型检查/构建/文档检查通过。未做正式验收；当时 Context Builder 未实现 |
| P11 Context Builder 开发自检 | [HTTP 契约 §10.13](docs/api/http-command-contract.md#1013-p11run-context-manifest-只读证据2026-09-23)、[0010 migration](apps/api/migrations/0010_v005_context_revision.sql)、[Run 来源页](docs/development/archive/m02-vue-workbench-baseline/src/views/RunView.vue) | 真实 Builder、来源修订栅栏、预算与裁剪、不可变实际片段 Manifest、读时范围复核及只读 Sources View；后端真实 PG 全量 167/167、Context 9/9、Verification 24/24、单测 57/57，前端 Sources/Run 14/14，类型检查/构建/文档检查通过。未做正式验收；ModelPort 仍为 Fake，显式选源与真实 Provider 待 P12 |
| UI 概念图与规范 | [工作台](docs/frontend/workbench-design.md)、[设计系统](docs/frontend/design-system.md)、[效果图目录](docs/frontend/mockups/2026-09-19/README.md)、[页面开发提示词](docs/frontend/page-development-prompts.md) | 32张生成图与1张原始参考、33个开发单元及组件规则，含首批四项 Skill；未证明交互可用 |
| 文档维护与静态检查 | [文档地图](docs/README.md) | 主文档归属、链接、token 引用及预设纯色组合检查能力；实际运行结果见交付审计 |
| Relay 扩展模型与闭环方案 | [扩展专题](docs/architecture/relay-skills.md)、[ADR-008](docs/decisions/ADR-008-declarative-skills.md) | 首批四项及 Pack/Profile/Proposal/Eval 组合方向已纳入；实现设计仍 Proposed，没有运行实现 |

## 3. 未完成与待确认

- 三个完整 TypeScript/AI SDK/真实 PG Spike 与端到端性能尚未通过。主恢复 Worker 现已把 DISPATCHING 准入、资源 claim、结果落库、两步位置与 PASS/CompletionRecord 完成短事务放进同一批短事务，并用锁内 barrier 与 `pg_stat_activity` 观测 Pause/Cancel 与完成的两种确定提交顺序、双批准/双执行竞争，以及租约过期但旧进程仍存活时的资源隔离；外部效果后经真实 PostgreSQL 重启仍按原 Invocation 核对。仍未覆盖多产物版本集合、人工处置链、生产权限/Gateway，`control-worker` 也尚未并入生产协议。Fastify/TypeBox/AI SDK 已通过同组离线 schema 输入。它们不能替代 Provider 兼容出口、桌面验收或 37 项业务验收，具体见[测试计划](docs/testing/verification-plan.md#6-typescript-first-冻结前-spike)与[第三批证据](docs/research/p00-source-study.md#联合提交步骤推进与业务完成第三批证据2026-09-20)。
- 2026-09-20 已复测并建立项目内 Node 24.21.0 / PostgreSQL 18.6 便携测试环境；系统 Node 22.22.3、pnpm 9.15.9 和停止的 Docker 服务保持原状。隔离 PG 已用于基础实验，不再将“本机没有可用 PG”作为未验证的原因；重跑步骤与证据见数据库实验说明。
- 持久化遗留：V001 没有 down migration（回退靠备份）；`0003_schema_readiness` 已让 readiness 区分数据库不可连与数据库可连但 schema 不兼容，但 API 为 liveness 仍会启动，业务路由也尚未逐一加独立 schema gate；新增表列若漏 GRANT 只在运行期暴露。P02 已有 `0002_*`，P03 已有 Artifact 落盘与 hash；后续仍不得改写已应用 migration。
- R01–R04 已完成：BE-01/02 的真实 PG+HTTP 修复、FE-01–04 的 fixture 修复、类型/能力映射及有限视觉/文案复验均有证据；schema readiness 已以真实 PG+HTTP 复跑 79/79。完整清单、修复前复现和修复后边界只维护在[独立验收记录](docs/testing/frontend-backend-acceptance-2026-09-21.md)。待实施的是真实 API 接入、桌面验收和其余业务场景，不得把此轮结果合并成“全通过”。
- 性能预算数值待确认；2026-09-20 用户确认两个真实 Provider 暂未配置，先完成其余验证。Spike 3 保留为配置缺失、未运行；不读取宿主凭据，也不以此跳过可独立执行的验证。
- 桌面 release 目录包已局部验证真实 WebView 握手/重载、正常退出、命名互斥单实例、错误 FakeWorker readiness 拒绝及强杀宿主后的自有 Node 回收；构建输入不匹配会在启动前拒绝。完整 frame 准入、服务重启凭据轮换、干净机安装/升级卸载及整机性能仍待[桌面验证](docs/testing/verification-plan.md#7-windows-桌面交付验证)。没有 MSI/NSIS 安装交付。
- UI 的字体实装、窗口/DPI/内容缩放、键盘和页面对比度待真实桌面验证；浅色 token 是实现推荐，不代表深色主题或品牌名已经决定。
- 产品细化待确认项仍按[范围矩阵](docs/requirements/v1-scope.md)和[设计审计](docs/development/design-audit.md)定位，不在此复制另一份完整需求清单。
- Skill/Blueprint 的正式 schema、定义保留、D 阶段 migration/锁协议待实施冻结；V1.5 AI Page Schema 生成前移待确认，详见 [Skill 出口](docs/architecture/relay-skills.md#6-分期验证与实施出口)。

## 4. 下一步与本轮范围

2026-09-23 的文档体系调整、提示词更新和 goal 总提示词先于本次 M01 实施；那一轮本身没有执行代码改造。现已完成 M01 开发自检并交独立验收，保留已实现 P00–P11 及历史验收，不重建已有能力。M01 独立验收通过后才开始 React 桌面迁移；再通过 Mock 创建/SSE/审批/取消/故障恢复门槛，之后接真实模型并继续 V1。

每模块具体开发交给 gpt-6-sol / ultra，开发自检后由协调 Agent 独立验收；未通过则修复复验，通过后自动继续已授权下一模块。缺 Provider 凭据、Windows 环境或兼容出口时记录真实阻塞，不自行降低验收要求。M01、M02 已通过独立验收；M03 开始前核对现有 Run/Review/Recovery/Gateway 与本地参考源码，先完成 Mock G01–G08，再考虑 M04 真实模型。

### 历史阶段经过

2026-09-23 本轮授权已完成：R05 两个验收阻塞项已修复，新增正式回归并通过主 Agent 独立复验。下一步 P07（Review 与人工判断）可按原阶段顺序接续，本轮没有实施 P07/P08。以下 2026-09-22 及更早段落保留为阶段经过，其测试数量为历史基线。

2026-09-22 最新范围：用户要求继续推进阶段实现。P05 与 P06 均已完成：P05 交付 `0004_v002_runs`（Run/执行契约/Step/Attempt/Context Manifest）、`POST /tasks/{id}/delegations`（202，原子授予 AI 执行权）、`GET /runs/{id}`、内部应用端口 `advanceRunStep`（固定 `markdown-deliverable-v1` + FakeModelPort，推进到 `VERIFYING` 后停止）、执行契约冻结、步骤结果去重与 claim/ownership epoch fencing（集成 95/95、单测 37/37）；P06 交付 `0005_v002_verification` 与 `VERIFY`/`COMPLETE` 两步（冻结 CheckPlan、不可变 `check_results`、`PASS`/`RETRY`/`HUMAN` 总判定、检查器故障有界重试、修正预算与修正回路、适用性撤销、自动完成短事务、`COMPLETION_BLOCKED` 与执行权释放；集成 109/109、单测 57/57）。证据见 [HTTP 契约 §10.7/§10.8](docs/api/http-command-contract.md#108-p06verification-与完成-gate2026-09-22) 与 [物理设计 §15/§16](docs/database/physical-design-postgresql.md#16-0005-实际-migration-与兼容性2026-09-22-p06-实施记录)。下一步按阶段推进：**P07（Review 与人工判断）** 接续“必需 HUMAN 未决”的人工请求、决定与效果，随后 P08（控制与恢复，含 15.4/16.3 记录的锁序统一）；桌面宿主与安装交付按 [ADR-007](docs/decisions/ADR-007-windows-desktop.md) 单独验收。以下保留 2026-09-20/21 的实施经过，其中“完成”描述当时实现和已跑测试，不覆盖本轮的分层结论。

此前已按扩展模型评审补齐 Pack 固定依赖与应用边界、四类 Profile、Proposal 受控恢复、Adapter/来源视图、工程 Eval 及后续 Trigger/Importer/Checkpoint 边界；首批四项 Skill 保持。同步范围、ADR、逻辑存储要求、交互、验收和实施提示词，没有产品代码、生产依赖安装或 Spike。正式定义格式、兼容矩阵、Eval 预算/阈值、schema 与 migration 待实施冻结；AI Schema 前移和远期市场仍不作为已批准交付。

视觉工作按“继续效果图的生成”接续补齐项目蓝图、任务定义、验收方案与项目恢复摘要四张静态概念，图片、完整生成提示词与检查说明见[效果图目录](docs/frontend/mockups/2026-09-19/README.md)。这些视觉产出不证明生产能力；Pack/Profile、来源视图等其余扩展交互尚未配图。

后端本轮从 [P00 Terra 接续提示词](prompts/00-foundation.md#terra-后端开工接续提示词)的验证段继续；已按用户最新指定调用 GPT-5.6 Terra 极高（`gpt-5.6-terra` / `xhigh`）承担数据库、AI SDK、跨进程恢复与桌面宿主实验。本轮又补入受控外部效果后的真实 PG 停止/重启/reconciliation，证据见[P00 接续记录](docs/research/p00-source-study.md#8-terra-验证接续与主-agent-复验2026-09-20)。下一步复用已有证据，补主动作与资源/claim 的联合恢复、完整步骤与业务完成事务、宿主剩余必要安全边界及固定工作量性能测量；前两项已同日补齐（见下段），其余按用户放行决定处理；首批生产后端交接到 P01，完成后核对 P02 前置，不一次实现全部阶段。不把模型配置写成产品技术栈，也不因已有提示词宣布准备完成。

2026-09-20 又一批接续证据补齐主 Worker 与资源/claim 的联合提交、两步推进、PASS/CompletionRecord 完成短事务及控制/完成确定顺序，独立复跑 39 场景 PASSED，见[第三批证据](docs/research/p00-source-study.md#联合提交步骤推进与业务完成第三批证据2026-09-20)。据此用户同日确认：在保留挂账项的前提下放行进入工程搭建。挂账项为 Spike 3（缺两个真实 Provider 端点）、多产物版本集合与人工处置链、生产权限/Gateway、桌面宿主剩余必要安全边界、固定工作量性能预算；挂账不等于通过，也不支持冻结 ADR-006/007。

[第二段](prompts/00-foundation.md#第二段建立最小生产工程)已完成：根 workspace 与 apps/api 骨架按上述范围建立；锁定安装、strict 类型检查、构建、配置单测 7/7、真实 PostgreSQL 集成测试 4/4（未鉴权 401、错误 Host/Origin 拒绝、liveness/readiness、停止后退出）与临时集群清理已由主 Agent 独立复跑通过，命令与边界见根 README。骨架没有业务端点，因此不是人工闭环。同时修复根 workspace 对 apps/workbench 依赖安装的影响：两个开发脚本显式传 `--ignore-workspace`。

[P01](prompts/A-human-core.md#p01v001-与持久化基础)已完成：V001 把人工切片表、复合与延迟外键、周期唯一约束和不可变表只读落到真实 migration，单一入口含 SHA-256 内容校验，应用与迁移角色真实分离；显式 SQL Repository、多仓储同事务与命令回执基础已在真实 PG 验证（30 项集成测试 + 11 项单测，主 Agent 独立复跑通过）。差异与遗留：V001 不建 `executor_run_id`（物理设计第 8 节要求 V001 不引用 V002 才建的表），`state_decision_refs` 待 decisions 表，Artifact 内容存储未实现；没有 down migration，回退靠备份。跨任务待确认：物理设计与[运行设计](docs/architecture/runtime-context.md#5-ai-assist-与提案)把 `Task.mode` 定义为 `ME/AI_ASSIST/DELEGATE_AI`；本段记录的当时前端 `HUMAN` 词汇已在 R03 对齐为 `ME`，`executor_kind=HUMAN` 保持独立，见[独立验收](docs/testing/frontend-backend-acceptance-2026-09-21.md#7-修复后独立复验2026-09-21)。下一步 P02：需要新增 `0002_*` migration（`goal_alignment_mode`，必要时扩展状态集），不得改写 V001。

P02 已完成：Project / Goal /Task / State 以真实 HTTP 用例交付，含 `command_id` 回执重放、期望版本冲突（409）、未知字段与缺必需版本（422）、跨作用域不可见、类型化 State 命令、Goal `INHERIT`/`EXPLICIT`（含显式空集）与依赖环拒绝、键集分页；`0002_p02_task_goal_alignment.sql` 新增对齐列与索引，未改写 V001。56 项真实 PG+HTTP 集成测试与 22 项单测已由主 Agent 独立复跑通过。差异与风险：新增 Goal/依赖端点来自模块 API（契约第 3 节未列）、`CreateTask` 增加可选 `mode`、`INHERIT/EXPLICIT` 一致性只能由用例保证、`SET_PHASE` 未按词汇表校验、blocker 无创建入口；`0003` 后 readiness 已覆盖 schema 兼容，但不代表 P02 业务路由已获得独立 schema gate。

P03 已完成：Artifact 受管内容存储（staging → 完整写入 → hash/size → fsync → 不可变发布 → 登记）与不可变版本、人工接受、完成/重开短事务交付，含按固定版本完成而不接受更新版本、重开新建 `acceptance_revision` 且历史凭据保留、旧命令重放只回历史回执、内容已发布而登记失败留下可核对孤儿、完成事务注入失败整体回滚、证据缺失或篡改拒绝完成（503 `EVIDENCE_UNAVAILABLE`）。69 项真实 PG+HTTP+文件系统集成测试与 28 项单测已由主 Agent 独立复跑通过；本段无需新 migration。风险：保存/完成事务含一次有界本地写入与 `fsync`；发布靠服务端新 UUID 保证不重叠，目录项持久性未在断电路径验证；孤儿清理按 V1 明确暂不启用。至此 A 阶段后端人工主线闭合（尚无对应 UI 与桌面窗口）。下一步候选：P04（前端工作台，属并行前端任务）或 P05（Fake Workflow/Run，需 V002 migration）。

本次接续按“主 Agent 编写提示词并核对证据、Terra 开发”的分工，由两个 `gpt-5.6-terra / xhigh` 执行者分别完成恢复/SDK 与 desktop-p00 的本批实验；文件所有权分开。审查发现的调用身份、退出收据、结果条件更新及旧 EXE 来源问题已交 Terra 修复，结果与独立复验见 [P00 接续记录](docs/research/p00-source-study.md#8-terra-验证接续与主-agent-复验2026-09-20)。本批局部证据不表示其余验证全部完成，Provider 暂未配置不构成放宽生产工程前置的授权。

前端另有用户授权：由主 Agent编写提示词，Terra 最高可用推理档开发页面，再由主 Agent验收。[四页实施提示词](prompts/ui-first-four-terra.md)已保存；全部33页范围未确认，按批次推进。[前端预览记录](docs/development/ui-preview-acceptance.md)跟踪各批次的实现、自测证据与待验证项，尚未通过页面验收。此项与上述后端准备并行，不能相互覆盖当前状态。

更早的任务与停止条件见[初始设计任务存档](docs/development/archive/2026-09-18-initial-design-task.md)；它们不覆盖当前用户授权。task_plan/progress/findings 只保留研究历史，不再并行维护“当前阶段”。
