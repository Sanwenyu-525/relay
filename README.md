# Relay / Personal Workflow OS

> 2026-09-26 当前接续：M01 技术适配与 M02 React/桌面基础已独立验收；M03 固定 Mock 图的 Windows/PG 基础闭环通过，完整 G01–G08 仍未验收。M04 的 OpenAI 兼容模型端口、Context/Assist/Skill/Blueprint 与低风险读取，M05 的 Today/工作台/追溯及部分全局入口已开发自检；未外呼真实 Provider，也未做 M04/M05 独立验收。阶段与剩余缺口只看 [CODEX_NEXT_STEP](CODEX_NEXT_STEP.md)。取舍见 [ADR-010](docs/decisions/ADR-010-agent-stack-react-desktop.md)，工作包见 [M01–M07](prompts/stack-migration.md)。

面向长期项目的人与 AI 协作工作系统，交付目标为 Windows 可安装应用，具有独立窗口和启动入口。仓库包含产品设计、业务契约、研究实验、UI 视觉规范、Fastify/Kysely/PostgreSQL 后端、React 工作台与 Tauri 桌面宿主。显式连接本机 API 后可走人工路径——创建项目 → 创建任务（含 ready）→ 开始 → 任务详情 → 保存 Markdown 产物版本 → 选择接受版本 → 完成 → 重开（[前端预览记录第 9、10 节](docs/development/前端预览实施与验收.md#10-ui-10-任务详情与-ui-11-产物编辑2026-09-21)），也可在待审页处理 Review、在 Run 页查看控制和追溯、在资料页管理 Knowledge/Memory/Decision/Rule。当前还提供 Mock Runtime、Context、Assist/首批 Skill 与蓝图、Today 和三套内置工作台的开发实现；真实 Provider 连通、真实 Git/CLI 工具、完整恢复及 Windows 安装交付未完成验证。后端接口见 [HTTP 契约第 10 节](docs/api/http-command-contract.md)，阶段及独立验收边界见 [CODEX_NEXT_STEP](CODEX_NEXT_STEP.md)。本项目与 AI Manga Drama Studio 独立。

当前工作区为 D:/Develop/Relay-Agent。阶段、已有证据、缺口及下一步统一见 [CODEX_NEXT_STEP](CODEX_NEXT_STEP.md)；旧迁入路径与变更经过见[交付审计](docs/development/design-audit.md)，不作为当前启动位置。

产品目标补充（2026-09-26）：降低并行委托 AI 时的注意力切换与上下文恢复成本，让开发者依据关键行为的验证证据接受成果。问题定义与目标见[产品总纲第 0.4 节](Personal_Workflow_OS_Master_Spec.md#04-ai-并行开发中的注意力与验收依据)；统一待处理队列、恢复摘要和面向需求的验收视图仍是待细化的体验方案，不表示现有功能已解决上述问题，也不自动改变当前开发范围。

P10 开发自检：后端真实 PostgreSQL 全量 158/158、P10 定向 7/7、Gateway 14/14、单测 57/57；前端 P10 定向组件 7/7，双方类型检查、构建及文档检查通过。四类信息有类型化根/版本、HTTP 命令与查询、真实资料页和有界字面搜索；Rule 在 Delegate 时冻结到执行契约，版本变化阻止旧 Run 继续准入。现阶段仍使用 Fake Runtime 与 Fake Gateway，生产进程停机证明、真实 Web/Git/CLI 与宿主外进程隔离尚未实现；这些开发自检不构成正式验收。下一段按 [P11 提示词](prompts/D-context-product.md#p11context-builder)接入 Context Builder。

## 阅读入口

25–27 日产品补充的执行入口见[三日工作包](prompts/README.md#产品补充的执行映射)。当前代码中的人工待处理入口为 `/tasks?tab=attention`，原 `/tasks?tab=inbox` 仍用于未归属项目的人工任务；产物来源页可查看确切正文、版本比较和已登记直接引用。知识库支持按版本阅读保存的 Markdown/纯文本、查看来源、项目事实导读和显式收录核对。相关实现范围与证据见[工作台交互第 10–12 节](docs/frontend/workbench-design.md#10-成果共创与变化守护探索)，当前进度仍归 CODEX_NEXT_STEP。

1. [AGENTS.md](AGENTS.md)：协作规则与项目边界。
2. [文档地图与维护规范](docs/README.md)：每类内容的唯一主文档、状态与历史材料的阅读规则。
3. [产品总纲](Personal_Workflow_OS_Master_Spec.md)和[V1 范围](docs/requirements/v1-scope.md)：目标、范围和分期。
4. [四份契约](contracts/README.md)和[当前架构](docs/architecture/domain-model.md)：业务约束、Owner、依赖与事务。
5. [技术选型](docs/architecture/技术选型.md)和[桌面决策](docs/decisions/ADR-007-windows-desktop.md)：推荐主栈、桌面边界与冻结门槛；设计提案不等于已实现。
6. [工作台交互](docs/frontend/workbench-design.md)、[设计系统](docs/frontend/design-system.md)、[设计 tokens](docs/frontend/design-tokens.json)：业务操作、图像依据和视觉实现规范。
7. [测试计划](docs/testing/verification-plan.md)、[部署设计](docs/deployment/本机部署.md)、[实施提示词](prompts/README.md)：分阶段验证与后续工程入口。
8. [Relay 扩展模型](docs/architecture/relay-skills.md)：Skill、项目蓝图、Pack、Profile 与 Proposal 的组合边界，含版本、评测和受控恢复；首批 Skill/Pack、Task 提案确认及项目蓝图已进入开发自检，其余设计项仍按文档中的状态区分。
9. [V1 后续长期协作路线](docs/requirements/post-v1-roadmap.md)：项目接续、共创、知识整理与有限自动推进的推荐分期，配套[架构提案](docs/decisions/ADR-013-bounded-project-continuation.md)和[N 工作包提示词](prompts/post-v1-collaboration.md)；仅规划，未增加当前 V1 交付范围。

## 当前可运行内容

实验位于 experiments/，运行命令和局限见[实验说明](experiments/README.md)及 [P00 记录](docs/research/p00-source-study.md)。研究缓存 .research/ 不进入产品源码。实验成绩不代表生产 PostgreSQL、模型适配或全部业务验收通过。

文档与 token 静态检查使用 Node 内置模块，无需安装依赖：

```sh
node scripts/check-docs.mjs
```

检查范围与限制见[文档维护规范](docs/README.md#5-轻量检查)。

根目录双击 `dev-stack.bat` 打开桌面测试菜单；命令行入口如下：

```text
dev-stack.bat Build            # 构建最新桌面测试包到根目录 test-release
dev-stack.bat Start            # 启动测试版，首次初始化，后续保留并复用数据
dev-stack.bat Stop             # 先关闭桌面窗口，再停止专用测试数据库；不删除数据
dev-stack.bat Status           # 查看目录、包进程数量和数据库运行状态
```

程序固定为 `test-release/relay-desktop.exe`，测试数据独立保存在 `.relay-test/`；两者均不纳入 Git。请通过 `dev-stack.bat Start` 启动，以准备数据库和配置；直接双击 EXE 不会自动准备该测试环境。这是本机目录测试包，不是安装器，也不承诺复制到其他电脑即可运行。实现及升级边界见[持久测试入口](docs/deployment/本机部署.md#持久桌面测试入口)。首次使用先 Build；更新代码后重新 Build，平时启动无需重打包。

发布包的配置、Node/WebView2 和数据库只读诊断见[部署诊断入口](docs/deployment/本机部署.md#发布包只读诊断)；诊断通过不代表安装或业务总验收通过。

开发期浏览器预览仍可同时启动 `apps/api` 的 Fastify API 与 `apps/workbench`：

```text
dev-stack.bat Preview                                # 同时启动前后端开发预览
dev-stack.bat -FrontendOnly                          # 只启动前端 fixture 预览，不需要 apps/api/.env
dev-stack.bat -FrontendPort 5173 -SkipInstall -SkipBuild
```

逻辑在 [scripts/dev-stack.ps1](scripts/dev-stack.ps1)：默认先做启动前检查（Node 24、pnpm 入口、`apps/api/.env` 必填键、`RELAY_DATA_ROOT` 目录存在、API 与前端两个端口空闲），再构建 `apps/api` 并启动两个进程，随后探测 `/health/live`、`/health/ready` 与前端地址；`-FrontendOnly` 只检查前端端口与 Vite 的 Node 版本范围（^20.19.0 或 >=22.12.0），不读 `.env`、不构建也不启动 API。两种模式都按 Ctrl+C 停止（API 先关闭 stdin 正常退出，超时才强制结束），退出码非 0 时 bat 会暂停并显示原因。脚本不创建 `.env`、不生成凭据、不创建数据目录、不静默换端口。

`Preview` 需要 `apps/api/.env` 指向的数据库真实存在。本机开发数据库（与 `.env` 的 `127.0.0.1:5432/relay_dev` 对应）放在 `/.relay-dev/`（不入 Git），2026-09-28 起已初始化：便携 PostgreSQL 18 监听 5432、`bootstrap-roles.sql` 角色、`relay_dev` 库、42 条迁移、Graph 安装与默认工作空间（`11111111-1111-4111-8111-111111111111`）。开机后需先启动数据库再运行 `dev-stack.bat Preview`：

```text
.research\runtime-cache\postgresql-18.6-2\pgsql\bin\pg_ctl.exe start -D .relay-dev\cluster -l .relay-dev\postgres.log -o "-h 127.0.0.1 -p 5432"
.research\runtime-cache\postgresql-18.6-2\pgsql\bin\pg_ctl.exe stop -D .relay-dev\cluster -m fast
```

用便携 Node 直接起前后端等价于 Preview 的两个进程（修改代码时常用）：`cd apps/api && sleep infinity | <便携node> --env-file=.env dist/src/main.js`（stdin 保持打开，Ctrl+C 或关管道即正常退出）；前端 `cd apps/workbench && <便携node> node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173 --strictPort`。迁移/图安装/工作空间初始化在 `apps/api/dist/src/cli/`（migrate / install-graph / init-workspace，迁移与图安装需 `RELAY_MIGRATION_DB_URL`）。若数据库未启动，`Preview` 能拉起 API 但 `/health/ready` 返回 503 `DATABASE_UNAVAILABLE`，live 连接会失败——这是明确的环境反馈而非脚本故障。

`dev-stack` 不启动独立 Mock Worker，也不安装 Graph checkpoint；浏览器页默认显示示例数据。试用固定 Mock Agent 请使用下方桌面隔离会话。Windows 桌面宿主位于 [apps/desktop](apps/desktop)，M02 的 React/桌面基础已独立验收。它加载同一份 React 工作台构建产物并监督真实 API 和 Mock Worker；M03 的固定 Mock 图已通过真实 Windows/PG 的 CRITERION Review/RESUME 与 ACTION_APPROVAL 局部联测，Mock 在途取消已完成开发自检，G01–G08 完整闭环尚未验收。安装、升级和卸载仍属 M07。

修改前端界面时不必每次完整打包：`apps/desktop/scripts/dev-desktop.ps1` 启动 `tauri dev` 开发窗口——真实桌面窗口加载 Vite 开发服务器，前端改动经 HMR 数秒内生效，Rust 源码改动自动重编译并重启窗口，不生成安装包。加 `-Action start` 可后台启动（命令立即返回，runner 进程与日志记录在 `.relay-dev/dev-desktop/`），`-Action stop` 按 runner 进程树一键停止并清理 dev 版窗口与 Vite 残留，`-Action status` 查看运行状态；无参数时保持前台运行（Ctrl+C 停止）。`desktop_bootstrap` 私有协议在 dev 来源下的放行见 [UI 联通开发记录](docs/development/ui-live-integration-2026-09-28.md)。正式构建入口 `dev-stack.bat Build` 保持不变；开发窗口与打包版共用单实例互斥，不可同时运行。

`apps/api` 提供存活/就绪检查、迁移、事务与命令回执、Project/Goal/Task/State、受管 Artifact、人工完成/重开、Mock Run、Verification/Review、持久控制、Gateway、长期信息/规则/搜索、Context、Assist/首批 Skill/蓝图以及 Today/Activity/Trace/Lineage。`apps/workbench` 默认渲染示例数据；浏览器可在页壳右上「数据来源」手工填入 API 地址、Workspace ID 与 `RELAY_API_BEARER_TOKEN`，只有 `/health/ready` 返回 200 才进入 live，刷新后回到示例模式。打包桌面从受信宿主内存取得本次连接并在重载时重新引导，无须在页面填写令牌；若本机 API 引导或就绪失败，桌面显示需重启应用的阻断页。live 模式可走人工闭环、Delegate/Review/Run 控制、资料和 URL 导入、Today、三套工作台、Assist/蓝图及确切证据追溯；「设置」页只读显示当前服务实例的模型端口状态（Mock/真实 Provider，密钥不读取不显示，配置仍归服务端环境变量，见 [HTTP 契约 §10.49](docs/api/http-command-contract.md#1049-模型端口只读状态2026-09-28开发自检)）；Assist 普通讨论与 Run DRAFT 可显示有界的生成中草稿，最终内容仍以已结算消息和产物为准。本地 `.md/.txt` 首次导入单独写入 Knowledge。凭据只保存在页面内存，不写 URL、localStorage、日志或源码。P09 Connection、受管目录和权限策略可在项目设置页操作；委托页可选择显式 Context 来源和可选 Mock 文件动作。真实项目与全空间任务列表已接通；后端 ArchiveProject 命令、关联写入栅栏、live 归档按钮及主要 live 写入口的归档门槛已有开发自检。PDF 导入与真实 Git/CLI 工具尚未交付。M03 完整闭环、真实 Provider、M04/M05 与安装交付的验收状态见 [CODEX_NEXT_STEP](CODEX_NEXT_STEP.md)。

## Windows 桌面开发包（M02）

桌面发布目录通过 [构建脚本](apps/desktop/scripts/build-release.ps1)生成，要求仓库内便携 Node 24.21.0、pnpm 9.15.9、Rust MSVC toolchain、VS Build Tools 和 WebView2。脚本构建真实 `apps/api`、完整 `apps/workbench` React 产物与 Windows 文件 I/O 助手，再执行 Tauri `--no-bundle`；从 Cargo 输出中只提取可执行文件、随包 Node/API/文件助手到 `apps/desktop/release`，不混入编译缓存。`desktop-build-manifest.json` 记录可执行文件、助手、源码/锁/脚本和发布资源 SHA-256。该目录是可重复的开发 release 包，**不是安装包**。Windows 集成测试若涉及受管资源且未指定 `RELAY_FILE_IO_HELPER`，[测试脚本](apps/api/scripts/run-integration.ps1)会先用锁文件构建源码 debug 助手；要核对确切发布包时显式设置该变量为随包助手路径。

```powershell
Set-Location D:\Develop\Relay-Agent
powershell -NoProfile -ExecutionPolicy Bypass -File apps\desktop\scripts\build-release.ps1
```

桌面启动使用现有独立 PostgreSQL。先用迁移角色执行 Relay 业务 migrations，再用同一受信迁移身份安装 Graph checkpoint schema，最后用应用角色 CLI 初始化 Workspace；Graph 安装顺序和权限见[部署设计](docs/deployment/本机部署.md)。然后将 [配置模板](apps/desktop/desktop.env.example)填写为 `%APPDATA%\dev.relay.agent\desktop.env`，或用 `RELAY_DESKTOP_CONFIG_PATH` 指向配置文件绝对路径。模板需要 `RELAY_DB_URL`（现有应用角色）、连接池大小/超时和已存在的 Workspace UUID；桌面每次启动自行生成临时 Bearer 并通过私有管道交给随包 Node，配置文件不填 token。应用数据默认位于自身 AppData 的 `data` 子目录。缺 PG、schema 或 Workspace 时桌面拒绝放行并显示诊断，不安装、启动或停止用户的 PG 服务。

```powershell
& .\apps\desktop\release\relay-desktop.exe
```

真实 Windows 验收可用 [隔离会话脚本](apps/desktop/scripts/start-acceptance-session.ps1)创建**仅测试用途**的临时 PG、真实角色、migration、Workspace 与临时桌面配置，并启动该 release 窗口。M02 基础包的进程生命周期检查使用[会话检查脚本](apps/desktop/scripts/check-acceptance-processes.ps1)：先 `Snapshot`，再检查 `SecondInstance`；真实 UI 正常关闭后运行 `AssertStopped`。该脚本按 M02 的单 Node 子进程编写，不适用于当前同时启动 API 与 supervisor 的 M03 包；M03 进程事实以对应[独立验收](docs/testing/m03-independent-acceptance.md)和当前进程检查为准。另起会话可对 M02 宿主执行 `KillHostAndAssertJob`，验证 Job Object 回收其 Node。最后运行[清理脚本](apps/desktop/scripts/stop-acceptance-session.ps1)停止临时 PG 并删除会话目录；窗口仍在运行时清理脚本拒绝操作。临时 PG 不接触用户库，也不是发布依赖。桌面实现和验收边界见 [M02 开发记录](docs/development/m02-desktop-foundation.md)；M02 独立验收仍以协调 Agent 的记录为准。

### 临时试用固定 Mock Agent

先按上文构建最新桌面开发包，再在仓库根目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File apps\desktop\scripts\start-acceptance-session.ps1 -InstallGraph
```

该命令在隔离 PostgreSQL 中依次安装业务迁移与 Graph checkpoint、初始化 Workspace，并打开自动连接真实 API/Worker 的桌面窗口。窗口内依次创建项目、新建任务（填写预期结果与人工验收条件）、打开任务详情的「执行记录」页签、点击「委托给 Mock Agent 执行」，再从 Run 的未决 Review 链接进入待审页接受结果。返回 Run/任务详情查看状态与 Markdown 产物。若项目已通过 P09 HTTP 配置写入连接、受管目录及权限策略，可在委托前勾选可选 Mock 文件动作，指定目录内的完整目标路径和内容；Run 页可按需查看原 operation_id、动作与 Invocation 状态。这里运行的是固定 Mock 模型，不调用真实 Provider；`202` 仅表示已受理，最终状态以 Run 查询为准。

会话数据位于启动输出的 `session_root` 临时目录，供试用而非长期保存。试用后先关闭桌面窗口，再运行启动输出给出的 `cleanup` 命令停止该临时 PostgreSQL 并清理目录。M03 的完整 G01–G08 与安装交付仍按 [当前状态](CODEX_NEXT_STEP.md)验收。

## 后端工程（apps/api）

2026-09-23 开发接续：P07 Review 已加入 `0006_v002_reviews`、待审查询/决定接口、人工判断与修正预算等效果及工作台待审页。开发自检为后端 121/121 真实 PG 集成、57/57 单测、类型检查与构建通过；前端 83/83 组件测试与构建通过。集成测试文件串行执行，因为共享临时数据库中的一项 RLS 用例会切换全局表策略；测试结束后 PostgreSQL 已停止且临时目录已删除。这些检查不是正式验收。

P08 接续：`0007_v003_recovery_control`、控制请求/Resume、Worker fence、固定 `operation_id` 的受控 Fake 发布恢复和 HANDOFF 事实引用已落地；Run 页面显示 PENDING 与实际安全点结果。开发自检为后端真实 PG 137/137、单测 57/57，前端组件 90/90，类型检查、构建和文档检查通过；临时 PG 已停止清理。内部恢复入口需要调用方提供旧 Worker 停止依据，生产自动扫描和停机确认尚未实现。这些检查不是正式验收。

P09 接续：`0008_v003_gateway` 与内部 Fake Gateway 实现 Connection/Capability/Permission 独立事实、不可变策略版本、authority 撤销/准入锁序、跨 Workspace 重叠根资源占用、类型化 USER_IMPORT、批准与 Invocation 绑定，以及 UNKNOWN 按原动作身份核对；配置命令和历史只读查询已接 HTTP。最新开发自检为真实 PG 全量 150/150、P09 定向 13/13、单测 57/57，类型检查、构建与文档检查通过；临时 PG 已清理。仅固定 Fake 写与公共假读，不表示真实工具或生产进程停机证明已交付，也未做正式验收。

P10 接续：`0009_v004_information_rules` 增加 Knowledge、Memory、Decision、Rule 的类型化根与不可变版本；明确确认、替代、规则作用域/强度/检查路径、Rule 修订栅栏与有界字面搜索均接应用命令和 HTTP。前端加入真实资料页及项目资料入口，示例模式不伪造资料。P10 当时开发自检为后端真实 PG 全量 158/158、P10 定向 7/7、Gateway 14/14、单测 57/57，前端 P10 定向组件 7/7，类型检查、构建与文档检查通过；本段不是正式验收。

P11 接续：`0010_v005_context_revision` 给 Context 来源变化独立修订号；BUILD_CONTEXT 使用冻结契约与当前合法事实装配必需、相关及修正输入，保存实际片段/版本/hash/范围、估算预算与裁剪原因。`GET /runs/{id}/context-manifests` 及详情只读端点重新过滤失效来源，Run 页展示可读证据。首次全量回归发现已发布候选后的 Task 修订被过宽 Context 栅栏拦截，修复后真实 PG 全量 **167/167**、Context 定向 **9/9**、Verification 回归 **24/24**、单测 **57/57**，前端 Sources/Run 定向组件 **14/14**；类型检查、构建、文档检查通过，临时 PG 已清理。P11 时点仍用 FakeModelPort，最近同范围资料补位最多 3 条且仅为有界降级；后续 M04 已增加显式选源，并阻止真实 Provider 外发近期补位资料。本段测试未做正式验收。

此前 2026-09-23 的 R05 独立复验结果保留在[独立验收第 9 节](docs/testing/frontend-backend-acceptance-2026-09-21.md#9-r05-修复后独立复验2026-09-23)：当时 57/57 单测、113/113 真实 PG 集成、前端 80/80 组件及 19/19 Chromium 通过。该历史结果不覆盖 P07 的阶段状态；当前阶段只看 [CODEX_NEXT_STEP](CODEX_NEXT_STEP.md)。

依赖与运行时来自仓库内便携包（`.research/runtime-cache`，被 Git 忽略；缺失时按 [typescript-p00 实验说明](experiments/typescript-p00/README.md)补齐，不修改系统 Node）。下列命令沿用当前 PowerShell 会话并固定 pnpm 与 registry：

```powershell
Set-Location D:\Develop\Relay-Agent
$runtime = (Resolve-Path .research\runtime-cache\node-v24.21.0-win-x64).Path
$env:PATH = "$runtime;$env:PATH"
$corepack = Join-Path $runtime 'node_modules\corepack\dist\corepack.js'
$env:NO_PROXY = '*'; $env:HTTP_PROXY = ''; $env:HTTPS_PROXY = ''
```

安装与检查（从 `apps/api` 直接运行，避免多一层 pnpm 调用；`pnpm-lock.yaml` 已固定 LangGraph 1.4.17、core 1.2.12、checkpoint 1.1.5、PostgresSaver 1.0.5，及 fastify 5.12.5、kysely 0.29.6、pg 8.16.3、@sinclair/typebox 0.34.52、typescript 5.9.3、@types/node 24.10.1、@types/pg 8.15.6）：

```powershell
Push-Location apps\api
& "$runtime\node.exe" $corepack pnpm@9.15.9 install --frozen-lockfile --registry=https://registry.npmjs.org
& "$runtime\node.exe" $corepack pnpm@9.15.9 run typecheck    # tsc --noEmit，strict
& "$runtime\node.exe" $corepack pnpm@9.15.9 run build        # tsc → apps/api/dist
& "$runtime\node.exe" $corepack pnpm@9.15.9 run test         # 单元测试（配置校验、命令摘要规范化）；不需要数据库
Pop-Location
```

仓库根也提供同名快捷脚本（`run typecheck` / `build` / `test` / `test:integration` / `start`），它们通过 `pnpm --filter` 转发到 `apps/api`。若 PATH 上的 `pnpm` 由另一套系统 Node 提供，这一层转发会打印 `Unsupported engine` 警告：那是 pnpm 自身进程的 Node 版本，实际构建与测试仍使用 PATH 最前面的便携 Node 24（`pnpm exec node -v` 可核对）。

配置：复制 `apps/api/.env.example`（不含真实凭据）为 `apps/api/.env`（该文件被忽略）并填入真实值；脚本不代填凭据。

```powershell
Copy-Item apps\api\.env.example apps\api\.env
```

启动（等价于 `apps/api` 的 `start` 脚本；必须在 `apps/api` 目录下运行）：

```powershell
Push-Location apps\api
& "$runtime\node.exe" --env-file=.env dist/src/main.js
Pop-Location
```

M03 固定 Mock 图的独立 Worker 由另一个 Node 进程运行。先以迁移角色按顺序执行业务 `migrate.js` 和官方 Saver 的 `install-graph.js`（二者均需 `RELAY_MIGRATION_DB_URL`）；仅在安装成功后启动 Worker/supervisor，运行进程使用 `RELAY_DB_URL` 应用角色，不执行 DDL：

`RELAY_DB_POOL_MAX` 配置的是 API 进程的连接池，允许值 1；独立 Worker 不读取该键，当前固定使用自己的 4 连接池。M04 语义检查在 VERIFY 事务持有一个连接时，会用同一 Worker 池的另一连接先提交 `model_calls` 调用事实，因此 API 配成 1 不会造成该路径等待。自建 Worker 或直接调用 `advanceRunStep` 时若使用单连接池，须提供独立计量连接或至少两个可用连接；当前受监督 Worker 路径以定向真实 PG 测试覆盖。

```powershell
Push-Location apps\api
& "$runtime\node.exe" --env-file=.env dist/src/worker/supervisor-main.js
Pop-Location
```

监督器读取 `RELAY_DB_URL` 与已存在的绝对路径 `RELAY_DATA_ROOT`，在任何领取或 spawn 前只读核对业务与 Saver schema；缺失或损坏时以配置错误退出。非桌面 `--once` 供隔离验证；桌面模式先验证私有启动帧、逐旧 launch 核对并按序发 ack 与最终 `dispatch_ready`，随后才轮询，详情见[部署设计](docs/deployment/本机部署.md)。收到 SIGINT/SIGTERM 或桌面 stdin EOF 后停止新领取并等待子 Worker 退出；正常退出码 0，配置/schema 错误为 2，其余故障为 1。旧进程停机不由租约过期推定，UNKNOWN 保持原身份隔离。现有桌面 supervisor 组合已做局部独立复验，新图版 Windows 组合仍待验证；真实 Provider 仍关闭。

必须显式给出、否则以退出码 2 结束的键：`RELAY_API_BIND_HOST`（只接受 127.0.0.1 或 ::1）、`RELAY_API_PORT`、`RELAY_API_ALLOWED_ORIGINS`（显式 origin 列表，拒绝 `*` 与 `null`）、`RELAY_API_BEARER_TOKEN`（至少 32 字符，占位符被拒）、`RELAY_DB_URL`、`RELAY_DB_POOL_MAX`、`RELAY_DB_CONNECT_TIMEOUT_MS`、`RELAY_DATA_ROOT`（绝对路径、必须已存在、必须在源码仓库之外）、`RELAY_LOG_LEVEL`、`RELAY_API_STOP_ON_STDIN_EOF`；没有任何静默默认值。

### V001/V002 持久化与 Workspace 初始化（P01/P02）

数据库角色与迁移都显式运行，不依赖手工改库，也不和应用启动混在一起：

```powershell
Push-Location apps\api
# 1) 由管理员角色执行一次角色 bootstrap，并把应用库 owner 交给迁移角色
#    （sql/bootstrap-roles.sql 建立 relay_migrator 与 relay_app，两者都是真实非超级用户角色）
$psql = Join-Path (Resolve-Path ..\.research\runtime-cache\postgresql-18.6-2\pgsql\bin).Path 'psql.exe'
& $psql "postgresql://<管理员角色>@127.0.0.1:5432/postgres" -w -v ON_ERROR_STOP=1 -f sql\bootstrap-roles.sql
& $psql "postgresql://<管理员角色>@127.0.0.1:5432/postgres" -w -c "create database relay_dev owner relay_migrator"
# 2) 迁移入口只使用迁移连接；应用角色不允许 DDL，因此两个连接必须分开
& "$runtime\node.exe" $corepack pnpm@9.15.9 run migrate           # 需要 RELAY_MIGRATION_DB_URL
# 3) 同一迁移身份安装固定 relay_graph_v1（官方 Saver setup；API/Worker 不运行 DDL）
& "$runtime\node.exe" $corepack pnpm@9.15.9 run migrate:graph     # 需要 RELAY_MIGRATION_DB_URL
# 4) Workspace 初始化使用应用连接，建立 Workspace、authority 行、审计记录与命令回执
& "$runtime\node.exe" $corepack pnpm@9.15.9 run init:workspace -- --name "<工作区名称>"
Pop-Location
```

- 迁移入口（`node dist/src/cli/migrate.js`）是单一入口：按文件名顺序执行 `migrations/*.sql`，在同一事务内取 `pg_advisory_xact_lock`、执行显式 SQL 并写入台账 `relay_schema_migrations`（name + 内容 SHA-256）。**已应用迁移做内容校验**：文件缺失或内容变化一律拒绝；已应用的迁移文件绝不改写。P02 的 schema 增量是 [0002 migration](apps/api/migrations/0002_p02_task_goal_alignment.sql)；[0003 migration](apps/api/migrations/0003_schema_readiness.sql) 建立 readiness 受限兼容视图；[0004 migration](apps/api/migrations/0004_v002_runs.sql) 建立 Run/执行契约/Step/Attempt/Context Manifest；[0005 migration](apps/api/migrations/0005_v002_verification.sql) 建立验证会话与检查结果；[0006 migration](apps/api/migrations/0006_v002_reviews.sql) 建立 Review 请求与决定。与 Kysely Migrator 0.29.6 的兼容限制及本工程的处理方式记录在[物理设计](docs/database/physical-design-postgresql.md)。
- Workspace 初始化（`node dist/src/cli/init-workspace.js --name "<名称>"`）只使用 `RELAY_DB_URL`（应用角色），在同一个事务内写入 `workspaces`、`workspace_execution_authority`、`activity_records` 与 `command_receipts`。原样重试必须同时复用 `--workspace-id` 与 `--command-id`：命令目标（Workspace ID）也进入 `payload_hash`，只换目标会被判为不同命令并再建一个 Workspace。
- API 启动本身不执行迁移；启动后仍提供 liveness，但 `/health/ready` 会将随发布物的迁移名称/SHA-256 清单与应用角色可读的受限视图逐项比对。空库、缺迁移、未知未来迁移或摘要不匹配均返回 `SCHEMA_UNAVAILABLE`，启动前仍必须先跑迁移入口。

当前 HTTP 边界：`GET /health/live` 不需要鉴权，只返回 `{"status":"alive"}`；`GET /health/ready` 需要 `Authorization: Bearer <token>`，数据库与 schema 均匹配时返回 200（两个组件都为 `up`）。数据库不可连返回 503 `DATABASE_UNAVAILABLE`（`database=down`、`schema=unknown`）；数据库可连但 schema 不兼容返回 503 `SCHEMA_UNAVAILABLE`（`database=up`、`schema=down`）。每个请求都校验实际 Host 与端口，带 Origin 的请求按允许列表校验（浏览器预检不返回业务数据），错误响应带 `code`/`request_id`/`retryable` 且不含堆栈、SQL、路径或凭据，凭据与连接串不写日志。停止：`RELAY_API_STOP_ON_STDIN_EOF=true` 时，启动方关闭该进程 stdin（或发送 SIGINT）会关闭 HTTP 服务与连接池并以退出码 0 结束；该通道要求启动方保持 stdin 打开。

### 人工闭环 API（P02/P03）

P02 在 `apps/api` 上实现了 Project / Goal / Task / State 的应用用例与 HTTP DTO，P03 补齐受管 Markdown 内容存储、Artifact 版本、人工接受、完成与重开；前缀 `/api/v1/workspaces/{workspace_id}`（统一前缀、`command_id`、回执与 Problem Details 见 [HTTP 契约](docs/api/http-command-contract.md)）。可用端点与差异见该文档第 10 节「实现状态」；V001 之后的 schema 增量见 [物理设计](docs/database/physical-design-postgresql.md)（P03 不需要新的 migration，P05/P06/P07 分别为 `0004`/`0005`/`0006`）。

- 写命令：`POST /projects`、`POST /goals`、`POST /projects/{id}/goal-links`、`goal-unlinks`、`POST /tasks`、`PATCH /tasks/{id}`、`POST /tasks/{id}/ready`、`start`、`cancel`、`goal-alignment`、`dependency-links`、`dependency-unlinks`、`POST /projects/{id}/state-commands`、`POST /tasks/{id}/artifacts`、`POST /artifacts/{id}/versions`、`POST /tasks/{id}/complete`、`POST /tasks/{id}/reopen`。
- 读端点：`GET /projects/{id}`、`GET /projects/{id}/goals`、`GET /projects/{id}/state`、`GET /goals/{id}`、`GET /tasks/{id}`、`GET /tasks?project_id=…｜inbox=true`、`GET /artifacts/{id}`、`GET /artifact-versions/{id}/content`、`GET /commands/{command_id}`、`GET /runs/{id}`、`GET /runs/{id}/context-manifests`、`GET /runs/{id}/context-manifests/{manifest_id}`、`GET /runs/{id}/control-requests/{request_id}`、`GET /reviews`、`GET /reviews/{id}`、`GET /runs/{id}/reviews`。
- Delegate 与 Run（P05）：`POST /tasks/{id}/delegations` 只接受 READY 且由人工执行、有 Project、依赖已满足的 Task，成功返回 202 与 `run_id`/`task_revision`/`run_revision`/`status=CREATED`，并在同一事务冻结执行契约、持久化固定步骤计划、把执行权交给该 Run（`ownership_epoch` +1）。`GET /runs/{id}` 返回 Run 事实、契约摘要与步骤/尝试。内部应用端口 `advanceRunStep` 推进 `BUILD_CONTEXT → DRAFT → PERSIST_CANDIDATE`，最终候选写入不可变 ArtifactVersion 后 Run 停在 `VERIFYING`。
- Verification 与完成 Gate（P06）：`VERIFY` 从冻结契约派生 CheckPlan（Worker 无写权），把 `check_results` 只追加地写入 `verification_sessions`，并给出 `PASS`/`RETRY`/`HUMAN` 总判定；检查器 `ERROR` 只重试检查本身（两次仍不可用转人工），可修正失败在修正预算（默认 2 次）内回到 `RETRYING` 重跑“装配上下文 → 起草 → 落盘新版本 → 验证”，预算耗尽或必需人工项未决则转 `WAITING_APPROVAL`。`COMPLETE` 在统一短事务里写 `completion_records`（basis `AUTO`）、Task 完成指针、Project State delta 与审计并释放 AI 执行权（保留 `mode='DELEGATE_AI'` 供展示）；完成前置不满足时返回 `COMPLETION_BLOCKED`（不建立步骤尝试、不改任何表）。这两个步骤只走内部端口，**不新增 HTTP 端点**。
- Review 与人工决定（P07）：`0006` 保存绑定目标摘要与版本的 Review 请求及决定；`GET /reviews` 为待审列表，`GET /reviews/{id}` 与 `GET /runs/{id}/reviews` 可读详情，`POST /reviews/{id}/decisions` 在同一数据库事务写决定与对应业务效果。人工验收判断、请求修改、修正预算、检查器重试、动作批准/拒绝及 State 提案有各自适用条件；批准动作只保留预分配身份，不表示工具已经执行。工作台「待审」页读取真实请求并按服务端允许的决定提交。
- 控制与受控恢复（P08）：`POST /runs/{id}/control-requests` 以 202 先保存 PAUSE/CANCEL/HANDOFF/CANCEL_TASK，安全点后才将请求标为 APPLIED；`POST /runs/{id}/resume` 恢复原 Run。AI 占有 Task 时 `POST /tasks/{id}/cancel` 返回 202/PENDING，人工路径仍返回 200。内部恢复按原动作身份核对受管 Fake 发布结果；UNKNOWN 未决时不交接或恢复。
- Fake Gateway（P09）：`POST/GET /projects/{id}/connections`、`POST/GET /projects/{id}/permission-policies` 和 `POST/GET /projects/{id}/managed-resources` 的具体版本、停用与撤销路径见[HTTP 契约 §10.11](docs/api/http-command-contract.md#1011-p09fake-gateway-配置与动作历史2026-09-23)；`GET /runs/{id}/operations`、`GET /import-jobs/{id}/operations` 和 `GET /operations/{id}` 只读返回动作与调用历史。执行、结果登记及 UNKNOWN 核对没有公开任意操作端点，只能走内部受控端口。
- Context 来源（P11）：`GET /runs/{id}/context-manifests` 与详情返回构建状态及按当前范围重新过滤的历史 Manifest 片段；端点与 Breaking Change 边界见[HTTP 契约 §10.13](docs/api/http-command-contract.md#1013-p11run-context-manifest-只读证据2026-09-23)。模型真实调用、Assist 与精确 token 用量仍属 P12。
- 所有写命令带 `command_id`：同 ID 同内容返回原回执与原成功码（响应头 `Command-Replayed: true`），同 ID 异内容返回 409 `COMMAND_ID_REUSED`；版本不匹配 409 `REVISION_CONFLICT`，缺必需版本 422。状态只走显式命令（INBOX→READY→IN_PROGRESS、取消、完成、重开），PATCH 不能改状态与验收。
- Artifact 内容只接受 `text/markdown` 的 UTF-8 文本（否则 415），正文上限 256 KiB（否则 413）；宿主路径由服务端按内部 ID 生成、数据库只保存受管相对路径，正文只能经受授权下载接口获取。版本不可变：旧版本不覆盖、新版本不继承任何验收凭据；内容发布成功而数据库失败会留下可核对的孤儿（V1 不自动清理），内容缺失或被篡改时返回 503 `EVIDENCE_UNAVAILABLE` 并阻止依赖该证据的完成。
- 完成是一次短事务：Task 状态与当前完成指针、必要的 Project State delta、HumanAcceptance/CompletionRecord、命令回执与关键审计一起提交；不伪造 Run 或 Verification PASS。重开新建 `acceptance_revision` 并保留历史凭据，旧完成命令的重放只返回当时回执。
- 跨作用域 ID 按不可见处理（404）；未鉴权 401；错误为 `application/problem+json`，含 `code`/`request_id`/`retryable`/`retry_action`，不含堆栈、SQL、路径或凭据。
- 本小节 P02/P03 阶段当时尚未实现 Review、控制与恢复等后续范围；Review 已由 P07 接续，控制与受控 Fake 恢复已由 P08 接续。Artifact 列表端点、孤儿核对报告和 OpenAPI 生成仍未实现。

真实 PostgreSQL 集成测试使用项目内便携 PostgreSQL 18.6 自建一次性集群（动态回环端口、随机 `relay_api_test_*` 库名，结束必须 `pg_ctl stop` 并删除临时目录），不连接其他项目或用户生产库，也不依赖系统已安装的 PostgreSQL。入口按当前 `test/integration/**/*.test.ts` 映射编译文件，避免已删除的临时验收源码留下的旧 JS 混入回归；缺少编译文件明确失败。显式 Mock 性能测试仍由 `run-m03-mock-benchmark.ps1` 选择当前 `.bench.ts` 产物，不加入默认测试集合：

```powershell
Push-Location apps\api
& "$runtime\node.exe" $corepack pnpm@9.15.9 run test:integration
Pop-Location
```

2026-09-22 P06 当时复跑为 **109 个真实 PG+HTTP+文件系统集成用例**和 **57 个单元用例**均通过（含 P05 的 Delegate 并发、`retry_of_run_id`、无 Project 拒绝、步骤结果去重、迟到 claim epoch 与 ownership epoch 拒绝，以及 P06 的自动完成短事务、C01/C04/C05/C06/C07、修正回路与预算耗尽、验证撤销、基准删减、D04/D05/D06，还有既有的完成/重开、schema readiness 用例）。此前 2026-09-22 P05 后的 95 项集成 + 37 项单测、2026-09-21 的分层结论（79 项集成 + 28 项单测）与修复前证据见[独立验收](docs/testing/frontend-backend-acceptance-2026-09-21.md)。

覆盖（69 个集成用例 + 28 个单元用例，2026-09-20 实测通过，`node --test`）：配置缺失与非法值明确失败、未鉴权 401、错误 Host 与错误 Origin 拒绝、liveness 最小响应、数据库正常与不可用两种 readiness、停止后进程退出与端口释放；空库迁移成功且重复启动不重复执行、并发迁移在 advisory lock 上串行化、已应用迁移文件缺失或内容变化被拒绝、迁移失败时 DDL 与台账同事务回滚；延迟外键在 COMMIT 失败、跨 Workspace 引用被拒、NULL 与越界值不能绕过 CHECK、完成周期唯一、0002 的 Goal 对齐列与 CHECK、应用角色不能 DDL 且不能 UPDATE/DELETE 不可变表、多 Repository 同事务整体回滚、相同命令重放与异 payload 拒绝、bigint（> 2^53）往返无损；两个 CLI 入口的真实进程运行（重复迁移不重建、同目标重试返回 `replayed=true`）；P02 的真实 HTTP 路径：Project/Goal/Task 创建与查询、INBOX→READY→IN_PROGRESS→CANCELLED 显式状态迁移、非法迁移被拒、展示字段更新与 status 字段被拒、缺必需版本 422、命令重放与 `COMMAND_ID_REUSED`、两个客户端版本冲突（含并发 CASE，恰一个成功）、依赖环/自依赖/跨项目/跨 Workspace 引用被拒、BLOCKS 前置阻止开始、键集分页与非法游标、Inbox 无 Project 事项、Goal 继承/显式/显式空集与解除关联影响清单、Goal 并发解除的确定结果、State 类型化命令（拒绝整对象覆盖、5 个 action、重复集合写入被拒）、State 依赖版本；P03 的受管内容与人工完成：发布后落盘内容与 SHA-256/大小一致、受授权下载返回确切版本正文、不支持类型 415 与超限 413（按 UTF-8 字节判定，边界值可接受）、未知路径字段与路径遍历输入被拒、跨作用域与未鉴权不可见、旧版本不覆盖且新版本只递增、按固定 v1 完成后 v2 不被标为已验收、无产物要求允许空集合、声明的产物种类与必需人工项必须满足、完成后上传被拒且重开后须重新 start、重开新建验收版本并保留历史凭据、旧完成命令重放只返回历史回执、旧周期新命令返回 `ACCEPTANCE_STALE`、两个并发完成命令恰一个生效、完成事务在 Task/State 之间失败整笔回滚且原样重试收敛、版本登记失败留下可核对孤儿且 Task 不误完成、证据文件缺失或被篡改时拒绝完成（503 `EVIDENCE_UNAVAILABLE`）。其后的 schema readiness 真实 PG 覆盖另行验证空库、缺 `0003`、完整当前清单、未知未来迁移和摘要不匹配；应用角色仍不能直读台账，但可读受限兼容视图。测试库 owner 为 `relay_migrator`，应用连接使用 `relay_app`，不使用超级用户冒充应用角色。包装脚本见 [apps/api/scripts/run-integration.ps1](apps/api/scripts/run-integration.ps1)、[角色 bootstrap](apps/api/sql/bootstrap-roles.sql)、[V001 migration](apps/api/migrations/0001_v001_human_core.sql)、[0002 migration](apps/api/migrations/0002_p02_task_goal_alignment.sql) 与 [0003 migration](apps/api/migrations/0003_schema_readiness.sql)。

尚未交付或尚未完成整体验证（不要当作已放行）：M03 生产恢复全场景、真实 Provider 故障路径与 Windows 联测、首输出延迟验收（2026-09-29 隔离 DRAFT/HARD SEMANTIC/取消已定向通过，详见当前进度）；真实 Git/CLI Gateway 适配与宿主外进程隔离、PDF 导入、孤儿核对报告与启动内容抽检；项目归档写命令；Python 工具层、Windows 安装包、备份恢复与 OpenAPI。OpenAI 兼容 ModelPort、Assist、首批 Skill/Pack、蓝图、低风险 Files/Web 和追溯已有代码及开发自检，不能据此宣称真实模型、真实桌面业务或 M04/M05 独立验收通过。M02 桌面基础已独立验收，但不能据此称完整 Windows 安装交付。本段实际覆盖与下一步见 [CODEX_NEXT_STEP](CODEX_NEXT_STEP.md)。

## workspace 与嵌套目录

Git 保留源码、迁移、文档及验收证据；`docs/testing/evidence` 下的日志也纳入版本。`.tmp-*` 临时工具、构建/缓存、进程输出和本机环境配置由 `.gitignore` 排除，已有跟踪项仅解除跟踪，文件仍保留在本机。`.env.example` 与 `desktop.env.example` 配置模板继续保留。

根 `pnpm-workspace.yaml` 只把 `apps/api` 纳入 workspace；`apps/workbench` 与 `experiments/*` 保留各自独立的 `package.json` 与 `pnpm-lock.yaml`，未纳入也不会被改动。需要知道的副作用：pnpm 会从上层目录发现 workspace 根，因此在那些子目录里执行 `pnpm install` 会解析到根 workspace（只安装根 workspace 的依赖）；`pnpm run <script>` 仍使用所在目录的 manifest。要在子目录按自身锁文件安装，使用 `pnpm install --ignore-workspace`（pnpm 9.15.9 实测可行）；`scripts/dev-stack.ps1` 已显式这样调用，前端依赖仍装在自己的目录。
