# Relay：当前技术选型与历史依据


角色：技术组合与引入边界的唯一主文档。更新：2026-09-24。用户确认 React 全量迁移、Windows 桌面，并要求选择适配现有项目的方案；决策依据与替代关系见 [ADR-010](../decisions/ADR-010-agent-stack-react-desktop.md)。M01 隔离兼容实验、旧工程基线与独立复验见 [验收记录](../testing/m01-independent-acceptance.md)；当前生产迁移进度仅见 [CODEX_NEXT_STEP](../../CODEX_NEXT_STEP.md)。

## 当前实施组合

| 层 | 选择 | 接入与验证边界 |
|---|---|---|
| 前端 | React + TypeScript + Vite | 全部既有页面/交互迁移，保留现有视觉、CSS/token、路由语义和业务功能；不是新建另一套产品 |
| 前端状态 | React 局部状态 + 窄 API client | 服务端事实仍归后端；共享查询缓存有真实需要时再选库，不预装 Redux/整套组件框架 |
| 桌面 | Tauri 2 + 随包 Node sidecar 优先实施 | 复用 desktop-p00 的有效证据，M02 验证真实 Windows 窗口/进程树，M07 验证安装升级卸载；Electron 只在具体阻塞后重评 |
| 主运行时 | Node.js 24 LTS、TypeScript strict、pnpm | API/Worker 同版本、分进程，生产执行编译 JS；M01 在便携 Node 24.21.0 验证 |
| API | 现有 Fastify 5、TypeBox、HTTP + fetch SSE | 保留 loopback Bearer、Host/Origin 和 workspace/project 边界；写入经过应用命令 |
| 数据与迁移 | 现有 PostgreSQL + Kysely + pg | 保留短事务、CAS/锁序、无损 bigint、角色分离及 SHA 校验的单一迁移入口；不引入 Drizzle 迁移既有 ORM |
| 通用编排 | LangGraph.js 1.x | M01 验证与现有 Run/Step/控制边界兼容，M03 接入唯一通用图；领域仍拥有完成/权限/动作事实 |
| 检查点 | 官方 PostgresSaver | schema、DDL 权限、保留策略与业务表分开；重放与业务提交按稳定身份对账 |
| 分发 | PG 持久 run command/outbox、有界 Worker | 先对照成熟 pg-boss/现有机制，按需要选包；单用户本机不预设 Redis/BullMQ 服务 |
| 模型 | @langchain/core + 一个实际 Provider 包 | 优先评估 @langchain/openai；M03 Mock 全出口通过后进入 M04，配置/能力/取消逐项核验 |
| 工具 | 现有 Gateway + ToolAdapter/CodingWorkerAdapter | Files/Web 先行，Git/受控 CLI 后续；当前无真实 Coding CLI，按实际能力声明 |
| 产物/搜索 | 受管不可变内容 + PG 元数据、有界字面搜索 | 沿用 data_root；pgvector 有检索需求再启用，不默认独立向量服务 |
| 测试/部署 | 复用后端 node:test、前端适配 React 的组件/E2E 测试 | 无需为附件统一名称而改全部测试框架；可选 Compose 仅开发/测试，Windows 安装是产品出口 |

依赖选择必须依据正式发布与当前兼容性，精确锁定并更新锁文件；禁止 beta/RC、浮动 latest 和用 main 源码版本冒充发行版。M01 的独立实验锁定 React/ReactDOM 19.3.0、Vite 8.3.0、plugin-react 6.1.1、LangGraph 1.4.17、core 1.2.12、checkpoint 1.1.5、PostgresSaver 1.0.5、Tauri Rust core 2.11.6 / tauri-build 2.6.3 / CLI 2.11.5 / API 2.11.1；完整发行依据、peer/engines、`pnpm-lock.yaml`、`Cargo.lock` 与 Windows MSVC 构建证据见 [M01 开发记录](../development/m01-stack-baseline.md#技术采用与证据链)和[隔离实验](../../experiments/m01-stack-adapter/README.md)。其中 React/ReactDOM、Vite/plugin-react 与 Tauri API 已进入 M02 工作台实际入口；新增路由、图标及测试包和逐页证据见 [M02 开发记录](../development/m02-react-migration.md)。LangGraph 仍以 M01 隔离适配结论为准。Vite 8 的 Rolldown 主版本变化要求 M02 对旧 Vue 基线逐页和全量回归，若发生具体阻塞再重评 Vite 7.3.1。React peer 与构建烟测不能替代桌面运行验收。

## 当前责任与迁移原则

API 在短事务保存 Run、command 和 outbox 后返回 202；Worker 只领取运行指令，LangGraph 推进图，业务 Owner 校验状态、权限和完成事务。不得并存两套自主规划/重试/恢复写 Owner。现有固定 Workflow 的节点和规则应复用，框架 checkpoint 不替代 Relay 的 operation_id、UNKNOWN、租约/fencing 或资源排他。

M01 用官方 PostgresSaver 与真实 PG 验证 `interrupt`/resume、节点代码重入、业务提交后 checkpoint 尚未保存的重放窗口，并对照固定 pg-boss 源码验证最小 PG command/outbox 排他；实验仅以受控异常重建 saver/graph，没有证明生产 Worker 强杀恢复。PostgresSaver 的 `setup()` 自有整数迁移台账、没有 Relay 的 SHA-256/事务/并发安装保证，必须由固定受信 schema 的单一迁移身份串行执行，运行身份只持 checkpoint 数据表 DML；具体边界和保留策略见 [M01 开发记录](../development/m01-stack-baseline.md#checkpoint-安装恢复与保留决定)。M03 正式接入不得另造业务状态 Owner。

保留现有表、API、数据和应用用例；新增接口先映射 workspace 路径及 command_id，附件状态名按现有语义映射。SSE 由 PG 可靠事件重放，按 Run 串行提交 seq；断开订阅不取消任务。取消与审批是持久命令，审批等待释放槽位。具体约束分别维护在 API、Runtime、数据库和测试主文档。

不将单用户同机系统改为微服务产品，不新增 Rust 业务网关、常驻 Python、Kafka、Kubernetes、Temporal、多 Agent Router 或独立向量库。薄 Tauri Rust 宿主只管窗口和生命周期。选择 PG 分发的代价是需要监控轮询延迟、DB 连接/锁开销和积压；实测不能满足预算时才比较队列替代，不先假定 Redis 更快。

实施顺序与大模块出口见 [工作包](../../prompts/stack-migration.md)和[测试计划第 10 节](../testing/verification-plan.md#10-技术栈改造的大模块验收)。这些是目标和验收规格，尚未构成产品运行证据。

## 历史方案：2026-09-19 至 2026-09-20

以下保留当时推荐、取舍和来源。涉及 Vue、AI SDK Core、调度和候选框架的旧推荐已由上面的当前组合及 ADR-010 接续，不再作为新代码选型指令；历史实验结果仍按原范围有效。

日期：2026-09-19；2026-09-20 补充实施授权。状态：Proposed。2026-09-19 为 TypeScript-first 文档评审；2026-09-20 用户要求补齐准备后开始后端编码。不据此宣布生产选型冻结或 Spike 通过。历史关系见 [ADR-006](../decisions/ADR-006-typescript-first.md)，实验与新证据见 [P00 研究记录](../research/p00-source-study.md)。

角色：技术组合、引入阶段与冻结门槛的唯一主文档。UI 视觉与 token 以[设计系统](../frontend/design-system.md)为准，组件库默认样式不能覆盖已有图的方向；当前实施进度见 [CODEX_NEXT_STEP](../../CODEX_NEXT_STEP.md)。

## 1. 评审结论与变化

推荐 **TypeScript 主栈 + 可选 Python 工具层**，以产品适配度、可恢复正确性和实测性能共同决定是否冻结。Node.js 承担业务应用与模型适配，PostgreSQL 保存业务权威事实；Python 仅在具体计算/实验工具需要时按需启动。这是架构判断，不是“TypeScript 性能已胜过 Rust”的实验结论。

用户已明确交付 Windows 可安装应用、独立窗口和启动入口；桌面框架仍 Proposed。按 [ADR-007](../decisions/ADR-007-windows-desktop.md)优先验证 Tauri 2 + Node sidecar，Electron 作对照。薄 Rust 壳只管宿主与生命周期，不代表业务后端改为 Rust；性能收益须以包含 WebView、Node、Worker 和工具子进程的整机证据判断。

原 Java/JDBC 方案保留为历史提案；Rust/Rig 保留为研究与性能对照，不继续作为默认开工路径。Java 简历标签不再约束本轮推荐，代价是 Relay 本身不提供 Java 后端实现证明。领域边界、37 项验收和 [ADR-005](../decisions/ADR-005-reuse-first.md) 的成熟机制复用原则继续有效。

| 原建议中的断言 | 评审后的处理 |
|---|---|
| TypeScript 不会成为主要瓶颈 | 改为待测假设；模型等待不能掩盖 API p95、事件循环延迟、总 RSS 和数据库竞争 |
| API 与 Worker 分进程即可避免互相影响 | 隔离事件循环和进程故障，仍共享 CPU、磁盘、数据库连接及锁 |
| 审批后工具只执行一次 | 批准最多消费一次；未知结果先核对，不承诺任意外部系统的通用 exactly-once 效果 |
| pg-boss 作为必装基础栈 | 可选唤醒组件；首版可扫描持久化 Run，队列状态不决定业务完成 |
| PostgreSQL FTS 直接作为首版搜索 | 保留中文有界字面匹配；FTS 分词与召回待验证，pgvector 后置 |
| 一次建立所有 packages 和 Python 目录 | 只建立当前切片有调用方的包，逻辑模块不等于独立构建包 |

## 2. 推荐组合与引入阶段

| 层次 | 推荐 | 引入边界 |
|---|---|---|
| 语言与环境 | TypeScript strict、Node.js 24 LTS、pnpm workspace | P00 验证后锁定 Node/pnpm/依赖精确版本；隔离实验依赖不自动成为生产依赖 |
| 应用布局 | 同仓库、同版本模块化单体；桌面壳 + API + 独立 Worker | 人工切片有 desktop/web/API；阶段 B 引入 Worker，共享应用/领域代码和数据库 |
| 桌面宿主 | Tauri 2 + 随包 Node sidecar 优先验证，Electron 对照 | Windows 安装包、独立窗口/启动入口；WebView2、打包、签名、进程监管与实际版本待核验 |
| API | Fastify 5、REST；模型阶段按需 SSE | 阶段 A 保留轮询；流不是事实源，见 [HTTP 契约](../api/http-command-contract.md) |
| 边界契约 | TypeBox / JSON Schema | HTTP、工具、事件、模型输出共享定义原则；领域规则仍在领域模块 |
| 持久化 | PostgreSQL 18、Kysely、pg | 显式 SQL、短事务、CAS 和锁协议；真实 PG 验证后冻结 |
| 迁移 | Kysely Migrator 候选、单一迁移入口 | 版本化迁移可执行显式 SQL；验证锁、事务、历史完整性和内容校验 |
| 模型接入 | AI SDK Core | P00 Spike 验证边界，生产真实接入仍在 P12；早期使用 FakeModelPort |
| Assist | 按需使用 ToolLoopAgent | 仅建议、受准入约束的读取和提案；不自动写项目文件或执行 Git/CLI |
| Delegate | Relay Workflow 驱动 Core 单次调用及工具循环 | Run/步骤/审批/动作身份由 Relay 持久化，SDK 不拥有业务完成权 |
| 前端 | Vue 3、Vite、Router、Pinia；TanStack Query 管服务端缓存 | Pinia 只管 UI；缓存不是第二事实源，revision 与冲突按服务端契约 |
| 样式与长列表 | Tailwind CSS、shadcn-vue；TanStack Virtual 按需 | 版本兼容待验证；出现真实长列表再加虚拟化 |
| 内容 | 本机受管不可变内容 + DB 元数据 | 使用现有 data_root 布局，源码与运行数据分开 |
| 可选组件 | pg-boss、Python 工具、OpenAI Agents SDK Adapter | 有具体调用方和能力缺口再引入，不同时安装所有 Runtime |

2026-09-19 官方页面核验：Node 24 为 LTS；PostgreSQL 18 为受支持主版本，当前补丁为 18.6。这是候选版本依据，不证明本机已安装或组合兼容。[Node 发布状态](https://nodejs.org/en/about/previous-releases)、[PostgreSQL 版本策略](https://www.postgresql.org/support/versioning/)。

Fastify 支持 schema 验证和序列化；其 schema 编译执行意味着只能装载受信应用定义，不能将模型或用户提交的任意 schema 当可执行配置。JSON Schema 方言、TypeBox 包/主版本、Fastify type provider、AI SDK 与 Provider 的 schema 子集必须联合测试；Zod 若有必要仅留在适配边界。共享 schema 不等于运行时已经验证，工具输出和模型输出仍需显式校验。[Fastify 官方说明](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)。

## 3. Runtime 与恢复边界

AI SDK Core 支持手动循环，适合将模型调用置于 Relay 持久步骤内。Delegate 工具定义不注册可绕过 Gateway 的自动 execute；完整工具请求解析并验证后，先保存模型响应、逻辑动作身份与规范化参数，再审批/准入、执行、保存结果，最后决定下次模型调用。流中的未完成参数不能触发动作。[AI SDK Loop Control](https://ai-sdk.dev/docs/agents/loop-control)。

恢复需要持久化的上下文引用、完整请求/结果及协议所需的 Provider 元数据；只保存最终文本不足以恢复工具对话。只保存必要 API 协议数据，不索取模型私有思考链。断流后的半成品不执行；已登记工具动作的恢复不得重新生成参数来冒充原动作。审批前后重查参数、目标基线、权限、ownership epoch 和 resource claim。

Assist 没有 Run 和执行权，使用 ToolLoopAgent 也不扩大权限；获准读取仍经过 Gateway，无 Project 时遵守既有作用域限制。Delegate 人工等待落到 Review 和现有 Run 状态，不保留等待中的事务。HUMAN 是需人工处理的结果/路径，不新增同名 Run 状态。

OpenAI Agents SDK 的 RunState 可序列化恢复，但 Session、Handoff、RunState、Trace 均不等同 Relay 业务对象。仅当专用能力需要时接入，验证工具准入、版本恢复、取消与 Trace 外发配置，不预建通用多 Runtime 路由。[SDK 审批与恢复](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/)。

Mastra/LangGraph 不作为本轮推荐的业务状态权威，这不是认定框架无法适配。LangGraph 实验继续提供重放边界证据。Temporal/Restate 等在执行规模、跨服务协调或恢复维护成本证明必要时重评；恢复测试失败先定位原因，换平台也必须通过相同验收。

## 4. 数据、调度与事务

沿用[物理设计](../database/physical-design-postgresql.md)的关系、唯一性、锁序与业务身份；提案中的 workflow_run 等是示意名称，不据此重命名现有 runs/run_steps 或生成第二套表。Kysely 的类型接口适合表达 SQL 条件更新，但不能证明事务正确；跨 Repository 操作必须使用同一事务连接，模型/工具等待在事务外。[Kysely 官方项目](https://github.com/kysely-org/kysely)。

revision/epoch 在 PG 使用 bigint，公开 JSON 继续使用十进制字符串。应用层比较/运算使用无损转换，禁止先转 JavaScript number；数据库返回类型、日期精度、JSONB 编解码和受影响行数需集成验证。Kysely 类型声明不替代运行时转换。核心关系/状态保留列与约束，JSONB 仅存版本化扩展载荷。

Kysely Migrator 不应未经核验就等同 Flyway 的内容校验保证。P00 必须验证已应用文件缺失/更改、并发迁移及版本不匹配的失败行为；内置能力不足时，用单一迁移入口补最小内容校验或调整工具，不删除完整性要求。[Migrator 源码入口](https://github.com/kysely-org/kysely/blob/master/src/migration/migrator.ts)。

2026-09-20 独立实验确认内容摘要需补充，并发现已有事务发生 SQL 错误时的会话锁清理限制；实验采用专属迁移连接及故障回归验证。精确版本、固定源码和结果见 [P00 研究记录](../research/p00-source-study.md#7-后端开工前准备接续2026-09-20)，不把实验入口直接当作已冻结生产方案。

Worker 周期扫描持久化待执行事实，短事务领取、事务外执行；重启后扫描兜底，不能只靠进程内通知。若引入 pg-boss，仅承载 run_id 等唤醒引用：业务提交与投递采用已验证的同事务适配，或由扫描弥补提交后丢失通知；不能假定同一 PG 就天然原子。重复唤醒依赖 Relay claim/CAS 去重。[pg-boss 官方项目](https://github.com/timgit/pg-boss)。

每次重投先读 Relay 状态、控制意图和未决 Invocation，再恢复/核对。SDK 连接重试、队列重投、Workflow 语义修正分别有预算和责任，避免次数相乘；UNKNOWN 未核对禁止重新调用、换 Adapter 或换逻辑动作 ID。

## 5. 性能、搜索与工具层

同时测 API/审批 p50/p95、事件循环延迟、桌面冷启动、壳 + WebView + API + Worker + 工具子进程总 RSS、吞吐、PG 连接/锁等待和 SSE 背压；PG 占用单列并计入整机总量。将本地开销与真实模型/工具耗时分开；减少模型往返不能代替这些指标。沿用 P00 等工作量基准方法，保留 Rust Release 对照；性能预算须测试前明确，当前数值待确认。

API 与 Worker 分进程避免共享事件循环，但异步 LLM I/O 本身不等于阻塞。CPU 密集解析进入受限 worker thread/工具进程，Worker 仍需保证心跳和取消及时。进程分离不是沙箱，也不自动隔离宿主 CPU/内存和数据库负载。

搜索先满足[既有中文字面检索](information-planning.md)，再用真实中英文资料评估 FTS 分词与召回。PG 提供默认解析器，不据此宣称中文分词已满足产品要求；必要分词/索引组件另行验证。pgvector 仅在 Context Eval 证明收益后引入。[PostgreSQL 文本解析器](https://www.postgresql.org/docs/18/textsearch-parsers.html)。

Python 仅为受控 Capability：固定工具 ID、输入输出 schema、固定入口/解释器与依赖、参数数组、允许资源、超时及输出大小上限，使用 stdin/stdout JSON 或受管文件。取消覆盖子进程树；实际 OS 资源限制和隔离能力在 Windows 验证后才能声称具备。V1 不建立常驻 FastAPI 服务，不让模型拼接任意 Python 命令；不需要 Python 的部署不要求安装它。

## 6. 工程组织与冻结出口

推荐 pnpm monorepo，人工切片先建立 apps/desktop、apps/web、apps/api；desktop 仅含窗口、引导、监管和打包，Tauri 薄壳使用必要 Cargo 工具链。执行阶段增加 apps/worker。仅在 API/Worker 或前后端有真实共享时提取 packages/application、domain、contracts、storage 等包；Context/Verification 可先为模块。前端只共享 DTO/schema，不导入领域内部实体；Worker 经应用用例调用领域与存储，Runtime 不绕过 Gateway。

发布携带经验证的 Node 运行时；Node 24 是候选基线，不假定任一打包工具已支持所有依赖。Electron 对照若使用内置 Node 承载业务，须核验实际版本及 AI SDK/pg 等兼容性，不能沿用外部 Node 的测试结论。用户安装版无需开发工具链，独立 PG 与 WebView2 前提见部署文档。

三个 Spike 的故障点及通过标准统一见[测试计划第 6 节](../testing/verification-plan.md#6-typescript-first-冻结前-spike)。三个完整出口仍未通过；2026-09-20 已开始运行真实 PG 审批恢复与 UNKNOWN 的局部实验，实际覆盖与缺口见 [P00 研究记录](../research/p00-source-study.md#7-后端开工前准备接续2026-09-20)，不替代 37 项完整验收。Spike 1/2 使用真实 PG 与可控工具；Spike 3 需两个真实 Provider/模型端点，Fake 只证明协议测试。

P00 在已有研究上补 AI SDK/Kysely 等必要源码与兼容验证及[桌面验证](../testing/verification-plan.md#7-windows-桌面交付验证)，不重做全部实验。通过对应 Spike、事务/迁移、桌面交付及性能预算评估后，再分别提议冻结 ADR-006/007 的技术部分。2026-09-20 起已授权补齐验证准备并按出口进入后端编码；环境复测与实际通过范围记入 P00 研究记录，当前阶段由 CODEX_NEXT_STEP 维护。不得以实现授权替代验证证据。
