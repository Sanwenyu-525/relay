# M01：现状基线与技术适配开发记录

日期：2026-09-23 至 2026-09-24。本文为 M01 开发自检交付时点的记录；后续结论见 [独立验收](../testing/m01-independent-acceptance.md)。范围仅为 [M01 工作包](../../prompts/stack-migration.md#m01现状基线与技术适配)；该交付时点生产 Vue/HTTP/业务迁移保持原样，M02、M03 尚未开始。这里记录源码事实、采用依据与运行证据；模块的正式状态只看 [CODEX_NEXT_STEP](../../CODEX_NEXT_STEP.md)。

## 输入基准与当前入口

修改前工作区没有首个 Git commit，原文件都显示为未跟踪，不能用 `git diff` 重建基准。先于本轮写入生成了 [489 份原文件的 SHA-256 清单](m01-source-baseline.sha256)，清单自身 SHA-256 为 `3cc1aa6cd65e4d44555d4e58b527dada4a601f53bc2d229b68d661fa97f997f0`。清单逐文件覆盖项目源码、配置、文档与既有 10 份 migration；排除 `.git`、研究缓存、依赖/构建生成物、浏览器临时目录与 `.env*`。旧文件没有清理。最终 [508 份当前输入 SHA-256](../../experiments/m01-stack-adapter/results/m01-current-inputs.sha256)由原清单的 489 条路径加本轮 19 个新增源码/文档输入组成；逐项对比可见原文件只修改了 Vue 截图测试、当前状态、技术/部署/文档导航及提示词索引，10 份旧 migration 与其余业务源码哈希不变。实验日志、PNG 与协调 Agent 的独立验收记录是输出，不混入输入清单；旧 Vue 截图另有独立 SHA 清单。

| 层 | 当前源码与功能事实 | M01 边界 |
|---|---|---|
| 启动、身份、HTTP | `apps/api/src/main.ts` 启动 Fastify；`api/routes.ts` 在 `/api/v1/workspaces/:workspace_id` 注册 Project、Task、Artifact、Completion、State、Run、Context、Gateway、Information、Review、Command，外加 `/health/live`、鉴权的 `/health/ready`。`api/boundary.ts` 维护 loopback Bearer/Host/Origin；`main.ts` 处理信号及受管 stdin 关闭。 | 未新增生产 API、SSE 或 Worker。既有业务路由不是本次 LangGraph probe 的入口。 |
| 应用/领域 | `application/*` 的创建、Delegate、Run step、Verification、Review、控制、恢复、完成和 Context 用例复用各自 Repository；`workflow/*` 为固定 `markdown-deliverable-v1` 与 FakeModelPort。`run/run-repository.ts` 的 worker/attempt 领取以状态、worker、epoch 条件更新。 | `recoverStoppedWorker` 接收非空 `stoppedEvidence`，但可信进程停机证明仍需未来宿主提供；不能用字符串替身宣称自动进程恢复通过。Completion 仍由应用用例和领域 Owner 提交。 |
| 持久化 | `infrastructure/database.ts`/`application/unit-of-work.ts` 组织 Kysely/pg 短事务，`infrastructure/pg-types.ts` 保持 bigint 无损处理；`infrastructure/migration-runner.ts` 用独立迁移连接、单事务 `pg_advisory_xact_lock`、文件 SHA-256 台账。`apps/api/migrations/0001`–`0010` 不改写。 | PostgresSaver schema 另设，不把其整数迁移表或图 checkpoint 当业务事实。 |
| CLI/部署 | `apps/api/src/cli/migrate.ts`、`init-workspace.ts` 是生产迁移/初始化入口；`apps/api/scripts/run-integration.ps1` 启动隔离 PG；旧 `experiments/desktop-p00` 有 Tauri/Node/FakeWorker release 目录实验。 | 目前没有新的生产 React 入口、独立 Agent Worker、真实 Coding CLI 或安装器。旧桌面证据属于 2026-09-20 的 Vue+FakeWorker 范围。 |
| 前端 | `apps/workbench/src/main.ts`/`router.ts` 为 Vue3 + vue-router，`api/relayClient.ts` 保留窄 HTTP client、command 回执、revision 和连接边界；`fixtures/fixtureAdapter.ts` 支撑预览。 | 不用独立 React smoke 页替代旧功能迁移。M02 对照以下路由、交互和截图。 |

## 旧前端路由与可见交互基线

`apps/workbench/src/router.ts` 有 **11 条路由记录**（含根重定向与兜底）。页面数量不能只按顶层 component 计：同一路由的 `skill` 查询和任务详情页签承载独立交互。下表按当前代码而非设计稿列出 M02 必须保留的入口。

| URL / 条件 | 实际页面 | 核心交互与状态 |
|---|---|---|
| `/` | 重定向 `/projects` | 保留深链入口语义。 |
| `/projects` | `ProjectsView` | 列表/范围搜索、进行中与归档分组、创建项目入口、空态/加载/错误。 |
| `/projects/:id/tasks` | `ProjectTasksView` | 项目任务列表、筛选/依赖判断、任务导航与窄视口局部滚动。 |
| `/projects/:id/knowledge` | `KnowledgeView` | 项目范围信息、类型化资料/搜索和来源；与全局 Knowledge 同组件但作用域不同。 |
| `/projects/:id`、`?skill=blueprint` | `ProjectSkillView` → `BlueprintView` | 蓝图编辑、预览候选、应用/暂不采用、超时查同一命令回执、冲突重新核对和来源查看。 |
| `/projects/:id?skill=resume` | `ProjectSkillView` → `ProjectResumeView` | 继续项目摘要、重新读取/刷新、风险来源、进度目标和建议跳转。 |
| `/tasks` | `TasksView` | 全部任务筛选、清除筛选、创建/详情导航。 |
| `/reviews` | `ReviewsView` | Review inbox、详情与决定；现有组件/浏览器测试验证目标 hash 和命令回执边界。 |
| `/knowledge` | `KnowledgeView` | 工作区范围信息列表、类型过滤、有界搜索与迟到结果处理。 |
| `/runs/:id` | `RunView` | fixture 显示“没有真实 Run”的 gap；连接真实 API 后可看 Run/Step/Review/来源 Manifest，按权限读来源详情，并有暂停、恢复、取消、交接、取消任务、刷新与原命令回执核对。 |
| `/tasks/:id`，无 `skill` | `TaskSkillView` → `TaskDetailView` | 任务概览、Artifact 编辑/版本/接受/完成或重开、Run 页签；自己的草稿守卫。 |
| `/tasks/:id?skill=definition` | `TaskSkillView` → `TaskDefinitionView` | 定义建议修改/放弃/采用/暂不采用、采用阻塞原因与来源。 |
| `/tasks/:id?skill=verification` | `TaskSkillView` → `VerificationPlanView` | 验收检查列表、缺能力/基准过期提示、建议备注编辑/保存/取消与来源。 |
| `/:pathMatch(.*)*` | `UnsupportedView` | 未支持深链兜底，不静默跳回其他业务页。 |

`ProjectSkillView` 的两个页签和 `TaskSkillView` 的定义/验收页签经 `useSkillNavigation.ts` 保留原查询参数；未保存草稿时弹“保留并继续编辑 / 丢弃草稿并离开”，同时拦截局部页签与路由离开。`TaskDetailView` 则用自己的产物编辑守卫，避免叠加双对话框。`CreateProjectView`、`CreateTaskView` 在列表入口以页面/对话流程复用，不独占上述路由记录。`AssistView.vue` 存在，但当前 `router.ts` 没有 Assist 路由，故 M01 只能盘点源码，不能宣称可见 Assist 已实现。

旧 Vue 视觉的可重复证据是 [15 张浏览器截图](../../experiments/m01-stack-adapter/results/vue-screenshots/)及其 [SHA 清单](../../experiments/m01-stack-adapter/results/vue-screenshots.sha256)。`apps/workbench/tests/screenshots/pages.spec.ts` 本轮只追加任务概览/产物/Run、Review、全局/项目 Knowledge 六种现有页面截图；原九种仍在。它们来自**实际旧 Vue fixture**，不是 `docs/frontend/mockups` 设计图，也不证明 Windows WebView、DPI 或 IME。

## 技术采用与证据链

M01 固定独立实验的直接依赖和完整 `pnpm-lock.yaml` / `Cargo.lock`；本轮不将实验依赖加入生产 API 或替换 Vue。以下为 2026-09-23/24 核验并实际安装/编译的精确稳定版本，不是浮动 `latest`。

| 责任 | 精确版本和一手发行依据 | 本机验证 / 接入条件 |
|---|---|---|
| Node/包管理 | [Node 24.21.0 官方发行索引](https://nodejs.org/dist/index.json)、pnpm 9.15.9 | 便携 Node 24.21.0；PATH 上另有 22.22.3，复跑显式前置便携目录。`pnpm install --frozen-lockfile --ignore-workspace` 退出 0。 |
| 通用图与检查点 | [`@langchain/langgraph` 1.4.17](https://registry.npmjs.org/@langchain/langgraph/1.4.17)、[`@langchain/core` 1.2.12](https://registry.npmjs.org/@langchain/core/1.2.12)、[`@langchain/langgraph-checkpoint` 1.1.5](https://registry.npmjs.org/@langchain/langgraph-checkpoint/1.1.5)、[PostgresSaver 1.0.5](https://registry.npmjs.org/@langchain/langgraph-checkpoint-postgres/1.0.5) | 官方包和 `pg` 8.16.3 在真实 PG 18.6 上运行 3/3；graph 1.4.17 对 core 要求 `^1.1.48`，PostgresSaver 1.0.5 对 core/checkpoint 要求 `^1.1.44`/`^1.1.4`。M03 将 graph 嵌入既有用例后还要全量回归。 |
| React 构建 | [React 19.3.0](https://registry.npmjs.org/react/19.3.0)、[ReactDOM 19.3.0](https://registry.npmjs.org/react-dom/19.3.0)、[Vite 8.3.0](https://registry.npmjs.org/vite/8.3.0)、[plugin-react 6.1.1](https://registry.npmjs.org/@vitejs/plugin-react/6.1.1) | ReactDOM peer 为 React `^19.3.0`；Vite/plugin 的 Node engines 包含 Node24；最小 TS/React 页 `pnpm build:react` 退出 0。Vite 8 使用 Rolldown，属于主版本替换；M02 需完整页面、测试、窗口回归，不能把 peer/烟测当产品验收。若有具体阻塞，再比较现有 Vite 7.3.1 + plugin-react 5.2.0。 |
| Windows 薄壳 | [Tauri core 2.11.6 发行](https://github.com/tauri-apps/tauri/releases/tag/tauri-v2.11.6)、[tauri crate 2.11.6](https://crates.io/api/v1/crates/tauri/2.11.6)、[tauri-build 2.6.3](https://crates.io/api/v1/crates/tauri-build/2.6.3)、[CLI 2.11.5](https://registry.npmjs.org/@tauri-apps/cli/2.11.5)、[API 2.11.1](https://registry.npmjs.org/@tauri-apps/api/2.11.1) | CLI 启动验证与最小宿主 `cargo check --locked --target x86_64-pc-windows-msvc` 均退出 0。core 2.11.6 的正式修复避免沿用旧实验 2.11.5。没有本轮窗口启动、sidecar 打包或安装器证明。 |

本机 Windows 11 10.0.22631 x64，便携 PG 18.6 二进制、Rust/Cargo 1.95.0、已安装 MSVC target、VS 2022 BuildTools 17.14/MSVC 14.44 和 WebView2 153.0.4234.48。默认 Rust toolchain 是 GNU，故实验通过 `VsDevCmd.bat` 与 MSVC target 显式编译。旧 `desktop-p00` 的发布输入/EXE manifest 属 2026-09-20 Vue+FakeWorker 证据；本轮只读核对一致，没有 MSI/NSIS、干净机、真实 DPI/IME 验收。[Tauri Windows 前置](https://v2.tauri.app/start/prerequisites/)与 [sidecar 说明](https://v2.tauri.app/develop/sidecar/)定义 M02/M07 的后续验证范围。

直接依赖许可证和维护/发行依据以**上述精确版本的官方 npm registry / crates.io metadata**核对：LangChain/LangGraph 四包、React/ReactDOM、Vite/plugin-react、`pg`、三个 `@types` 均为 MIT；TypeScript 5.9.3 为 Apache-2.0；Tauri CLI/API/Rust core/tauri-build 为 `Apache-2.0 OR MIT`。registry metadata 指向各项目官方源码仓库，固定版本均为正式发行而非 beta/RC；核验时 LangGraph 1.4.17（2026-09-21）与 React 19.3.0（2026-09-09）为 npm `latest`，PostgresSaver 1.0.5 于 2026-08-19 发布，Tauri core 2.11.6 于 2026-09-19 发布并有[官方发行记录](https://github.com/tauri-apps/tauri/releases/tag/tauri-v2.11.6)。这说明本轮选用的是近期公开发行且可锁定的包，不等于长期维护承诺或生产安全审计；正式升级仍核对兼容与发布说明。

| 需求与已有机制 | 上游固定参考 | 采用/保留差异 | M01 测试 |
|---|---|---|---|
| PG 队列并发领取 | `.research/upstream/pg-boss` 固定提交 `4e05af1eeaad3a645b16e3dd6c389fb4610ee0e9`，`src/plans.ts` 的 `fetchNextJob` 用 `FOR UPDATE SKIP LOCKED`；`test/fetchTest.ts` 覆盖领取。 | 采用 PostgreSQL 行锁/跳过已锁行的最小领取思路，不引入 pg-boss 包、其 job schema 或第二套业务 Owner；最终 command/outbox 仍由 Relay 应用事务生成。 | 双连接并发仅一方领取，同一事务 command+outbox 回滚后均不存在，非 Owner 迟到完成更新 0 行。 |
| 迁移与角色 | 现有 `apps/api/src/infrastructure/migration-runner.ts` 与 `.research/upstream/kysely` 的对照记录；pg-boss `test/multiMasterTest.ts` 是其自身迁移/多主协调测试，并非 Relay 双领取证明。 | 保留 Relay 的显式 SQL、SHA-256、同事务 DDL+台账、迁移角色与无损 bigint，不引入另一迁移器；checkpoint 安装独立管理。 | 旧真实 PG 迁移 7/7、集成全量 167/167；新实验实测运行身份 DDL/版本台账写拒绝。 |
| 事务工作 | pg-boss 固定源码 `test/transactionalWorkTest.ts` 是上游的事务能力参考。 | Relay 业务完成由领域 Owner 既有短事务负责；图 checkpoint 是另一个提交边界。稳定 `operation_id` 和业务回执负责重放对账。 | 注入“业务提交成功、checkpoint 尚未保存”错误后图重放；业务节点执行两次，效果仅一行。 |

上游仓库是 `.research` 下的研究缓存，不是生产依赖或新的规则源。参考提交及路径是可追溯对照，M01 的业务正确性由本工程真实 PG 测试证明。

## Checkpoint 安装、恢复与保留决定

官方 [LangGraph interrupt 文档](https://docs.langchain.com/oss/javascript/langgraph/interrupts)要求相同 `thread_id` 恢复，且中断节点从开头重新运行；[persistence 文档](https://docs.langchain.com/oss/javascript/langgraph/persistence)说明 checkpoint。M01 实测了中断前代码两次执行，并在业务事务 `COMMIT` 后、图 checkpoint 落库前注入异常，再重建 `PostgresSaver`/graph 并以相同 thread 恢复。结果业务节点也执行两次，但 probe 的唯一 `operation_id` 只提交一行；图状态最终从未完成转为已完成。这是确定性异常和重建连接实验，**不是强杀独立 Worker 或外部工具效果已验证**。M03 必须用现有 Run/Step、Invocation、`UNKNOWN`、claim epoch 和资源排他接入，真实进程停止证明由宿主负责。

检查已安装 PostgresSaver 1.0.5 的 `dist/index.js`：`setup()` 直接插入传入的 schema 标识符，建立 schema/表，按整数 `checkpoint_migrations.v` 执行 DDL 与版本插入；没有 Relay 的内容 SHA-256 校验、整体事务或并发安装锁。因此选用**代码固定的受信 schema 名、单一迁移维护身份、串行的一次性安装/升级步骤**，版本升级前备份并检查 schema/包兼容；API/Worker 不能调用 `setup()`，也不能拥有该 schema 的 CREATE 或 `checkpoint_migrations` 写权。只给 `checkpoints`、`checkpoint_blobs`、`checkpoint_writes` 所需 DML；M01 已用 `42501` 反例实测拒绝越权。上游 checkpoint 迁移与 Relay `0001`–`0010` 是两条维护流程，不能声称前者继承 Relay 的 SHA/事务保证。未来正式接入需在部署/升级脚本显式实施并验证并发序列化、失败后的兼容检查和最小授权。

业务事务与 checkpoint 写入分离，不能假装原子。领域 Run、Task、审批、外部动作和完成事实仍只由应用命令/Repository 写入；Graph state 仅保存可重放的编排位置。节点每次外部效果前使用已持久的稳定动作身份；提交结果后先查领域回执再决定继续，`UNKNOWN` 只核对原动作，不新造 ID 盲重试。长期保留策略在 M03 实装前不设自动删除：活动、等待人工、恢复中或 `UNKNOWN` 线程及其恢复证据必须保留；未来只可在业务终态、无未决动作且备份/审计保留条件满足后按明确策略清理，不能先拍定天数。checkpoint 内容纳入数据库备份与版本兼容检查。

## 开发自检与未验证项

固定输入和完整命令见 [实验 README](../../experiments/m01-stack-adapter/README.md)；以下日志均保留原始输出，而非只写“通过”。环境为上述 Windows、便携 Node24/PG18、pnpm9.15.9；测试脚本内部使用动态 loopback 端口和独立临时 PG 数据目录。日志无 Provider 请求或会话密钥。

| 检查 | 结果 | 原始证据 |
|---|---|---|
| 旧 API 单测 / 真实 PG 集成 | 57/57；167/167，集成 build/PG 启停退出均 0、临时集群删除 `True` | [unit](../../experiments/m01-stack-adapter/results/legacy-api-unit.log)、[integration](../../experiments/m01-stack-adapter/results/legacy-api-integration.log) |
| 旧 Vue 组件 / Chromium / build | 110/110；19/19；`vue-tsc` 与 Vite 7.3.1 build 退出 0 | [component](../../experiments/m01-stack-adapter/results/legacy-workbench-vitest.log)、[browser](../../experiments/m01-stack-adapter/results/legacy-workbench-browser.log)、[build](../../experiments/m01-stack-adapter/results/legacy-workbench-build.log) |
| 旧 Vue 页面截图 | 15/15，15 张 PNG 和 SHA 保存；包括旧九页与新增六个实际子页面/状态 | [截图日志](../../experiments/m01-stack-adapter/results/legacy-workbench-screenshots.log)、[SHA](../../experiments/m01-stack-adapter/results/vue-screenshots.sha256) |
| 依赖冻结 / React 构建 | `pnpm install --frozen-lockfile --ignore-workspace` 退出 0；React TS/Vite 8 build 退出 0 | [install](../../experiments/m01-stack-adapter/results/frozen-install.log)、[React 独立复跑](../../experiments/m01-stack-adapter/results/independent-react-build.log) |
| 真实 PG adapter | 3/3；测试/PG 停止退出 0，临时集群删除 `True` | [开发复跑](../../experiments/m01-stack-adapter/results/m01-real-pg.log)、[协调 Agent 独立复跑](../../experiments/m01-stack-adapter/results/independent-real-pg.log) |
| 旧迁移/持久化定向独立复跑 | 迁移 7/7、持久化 15/15；各自临时 PG 清理 `True` | [迁移](../../experiments/m01-stack-adapter/results/independent-migration.log)、[持久化](../../experiments/m01-stack-adapter/results/independent-persistence.log) |
| Tauri 最小宿主 | CLI 2.11.5 可执行；Rust core 2.11.6 + build 2.6.3 的 Windows MSVC `cargo check --locked` 退出 0 | [CLI](../../experiments/m01-stack-adapter/results/tauri-cli-version.log)、[cargo](../../experiments/m01-stack-adapter/results/tauri-msvc-check.log)、[独立复跑](../../experiments/m01-stack-adapter/results/independent-tauri-check.log) |
| 文档链接/导航/设计 token | 便携 Node24 执行 `node scripts/check-docs.mjs` 退出 0 | [检查原始输出](../../experiments/m01-stack-adapter/results/m01-docs-check.log) |

旧迁移的 7 项反例实际覆盖已应用文件缺失/改写的 SHA 拒绝、DDL+台账+摘要同事务回滚、advisory 锁等待与并发仅应用一次、非 superuser 的迁移/应用角色；持久化 15 项包括 `2^53` 以上 revision/epoch 往返无损、应用身份最小授权、多模块事务回滚和并发 `command_id` 去重/冲突。两组都是本轮在真实隔离 PG 由协调 Agent 定向复跑，不把普通单测替代这些保证。

未验证：M02 的 11 条路由/全部子页面 React 迁移、真实 Windows Tauri 窗口与连接/IME/DPI、随包 Node 生命周期；M03 的生产 PG outbox/独立 Worker 强杀与自动恢复、可信停机证明和外部动作 UNKNOWN；M04 的真实 Provider；M07 的安装/升级/卸载。M01 新 probe 表和 React/Tauri 烟测均未接入产品入口。最终文档检查与输入哈希核对结果见下方最新证据，协调 Agent 的独立验收结论另行记录，不由开发记录自批。

## 文档影响检查

本轮没有改变需求、HTTP API、领域状态、业务数据库表或历史 ADR，故不改对应契约和 migration。已同步 [技术选型](../architecture/技术选型.md)的精确实验组合、[本机部署](../deployment/本机部署.md)的 checkpoint 安装/角色与保留边界、[实验索引](../../experiments/README.md)及当前模块状态。旧页面视觉数值仍以既有设计系统和旧源码为准；M01 截图是迁移比对输入。
