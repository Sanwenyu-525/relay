# 本机部署、身份与运维设计

> 2026-09-24 当前适配：按 [ADR-010](../decisions/ADR-010-agent-stack-react-desktop.md)迁移到 React 桌面。保留本机 PostgreSQL，持久命令分发优先复用 PG，不增加 Redis 安装前提。M01 的隔离技术实验和 M02 的 React/Windows 桌面基础已分别独立验收；M03 的 Mock Worker 与恢复仍在实施，未获整体验收。原始附件的 Linux 四服务 Compose 仅作来源参考，可选开发容器不能替代 Windows 产品。

日期：2026-09-19。状态：部署细节 Proposed。用户已确认 Windows 可安装应用、独立窗口和启动入口，并允许本机 PostgreSQL。桌面方案见 [ADR-007](../decisions/ADR-007-windows-desktop.md)，数据库与运行时组合以[技术选型](../architecture/technology-selection.md)为准。尚无安装包；其他平台不属于本轮交付承诺。

## 1. 拓扑与启动

Windows 启动入口 → 桌面壳 → 随包 React UI + 本机 Node API/Worker；UI 经已鉴权 loopback HTTP 访问应用用例，再访问 PG / 受管 data_root。推荐 Tauri 2 + Node sidecar，待验证后冻结。只有经过 Gateway 的模型/Web/Git 调用访问显式外部目标；没有远程 Runtime 或公开服务。

M02 桌面发布目录由 [构建脚本](../../apps/desktop/scripts/build-release.ps1)生成；其已验收的基础机制见 [开发记录](../development/m02-desktop-foundation.md)。随包使用**真实 Fastify API**，没有另起业务接口；发布物尚无安装器。API 的桌面模式只绑定 `127.0.0.1` 的 OS 分配端口、仅接受 `http://tauri.localhost` Origin 与本次令牌；无 Origin 的本机请求仍需令牌。API 仅用私有 stdin 取得令牌与 nonce，在确认 PG/schema/Workspace/HTTP 边界后用类型化 stdout 报端口。启动失败显示可操作错误，不放行工作台；服务在运行中退出后，页面重载会拒绝失效凭据并显示阻断页，而非回落到可操作示例数据。独立 PG 是用户事先配置的服务，不由桌面程序安装或停止。

M03 宿主已接入独立 supervisor 的私有恢复握手，但完整 M03 尚未验收。宿主先检查随包编译后的 supervisor 入口包含精确 `relay-desktop-supervisor-v1` 协议标记；旧入口在任何 Node 启动前被拒绝，构建脚本也拒绝缺标记的发布资源。宿主为 API 与 supervisor 分别创建 Windows Job，经 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 在 `CreateProcessW` 时绑定，关闭最后 Job 句柄终止进程组；不以父 PID 退出或租约过期证明 Worker 停止。宿主在实际 `data_root/runtime-launches/` 原子写入每次唯一 `ARMED` 启动记录后，才发送 supervisor 私有帧。下次启动只对格式、版本和 Job 不变量完整的旧记录核验命名 Job：仍存在则终止并查询 `ActiveProcesses=0`，已不存在则依赖已持久化记录、创建时绑定、非继承 Job 句柄和禁止 breakaway 的组合证明；记录缺损、Job 查询失败或停机超时均拒绝新 Worker。启动前还检查旧记录不超过 4096 条，私有 JSON 帧连同换行不超过 1 MiB；超限拒绝启动 Node。

隔离桌面验收的 [会话启动脚本](../../apps/desktop/scripts/start-acceptance-session.ps1)现提供可选 `-InstallGraph`：在临时 PostgreSQL 的业务 migration 后，以同一 migrator URL 调用随包 `install-graph.js`，随后清除该 migrator URL，再以 runtime 身份初始化 Workspace 和启动桌面。旧验收脚本未指定该开关时保持原顺序，也会在运行期前清除 migrator URL。该开关只操作本次创建的临时集群；[新图包 Windows 开发自检](../../apps/desktop/results/m03-review-resume-evidence.txt)已核对顺序、角色隔离与无运行期 migrator 会话，尚待协调 Agent 独立复跑。

supervisor 的私有 stdout 先给出同一 nonce/launchId 与随包 Node 版本的 `supervisor_ready`，再按启动帧中的旧 launch 顺序逐一给出 `launch_recovery_ack {nonce,launchId,retainedClaims}`，最后给出 `dispatch_ready`；握手完成后宿主继续有界读取 Worker 运行事件，避免关闭管道导致 sidecar 写入失败。宿主要求所有旧 launch 均获一次合法 ack，且 `retainedClaims` 是非负、未超过 JavaScript 安全整数范围的计数；缺失、重复、乱序、超长或不完整事件和意外 EOF 都会拒绝启动。第二阶段每条 ack 重置 120 秒空闲期限，但总计不超过 20 分钟；单 launch 核对超过空闲期限也只会安全失败并保留证据。收到最终 `dispatch_ready` 且进程仍存活后，宿主重新校验旧记录路径和身份，只删除 ack 中 `retainedClaims=0` 的旧 `ARMED`；仍有 claim 的记录与任何失败前的记录保留。`dispatch_ready` 的 Run ID 数组仅是有界样本，不能当作全量恢复清单或删除依据。这一宿主处理不能替代后端对原 command_id/operation_id、UNKNOWN 和资源占用的恢复核对。

2026-09-24 的 **pre-ack 隔离实测** 使用当次冻结的目录包、便携 PostgreSQL 18.6 和 [可重跑脚本](../../apps/desktop/scripts/test-m03-host-real-pg.ps1)：先经随包 API 创建真实 Run，再由独立 PG 会话锁住 `run_steps`，确认真实 Worker 已领取且在步骤表锁上等待，随后只强杀 Tauri 宿主。Clean 1 和同一旧 launch 的 Clean 32 均核对 API、supervisor、Worker 三个 Node PID 与宿主 PID 结束；重启同一 data root 后原命令仅保留一份回执，首 Run 的领取 epoch 从 1 到 2，首步骤尝试一次。Clean 32 的重启至窗口 bootstrap 用时 1981 ms，不能据此外推 4096 条或任意长单 launch 核对。UNKNOWN 反例在 OS 停机之后用测试钩子制造原 `operation_id` 的内容不符，重启后同一动作仍为 `UNKNOWN`、`dispatch_count=1`，原 claim 和 `ARMED` 保留且未启动新 Worker。三次临时 PG 都正常停止并清理，原始 PID/PG 证据在 `apps/desktop/results/m03-host-real-pg-{Clean-1,Clean-32,Unknown-1}.evidence.txt`。这些是旧包的局部证据，不等于最终目录包或 G04/G05 全部通过。

同日的 **逐 launch ack 组合自检** 使用冻结 EXE SHA-256 `0769b1dd762fce84690bdc9955bd18a4562c253f2854a49c6630015b0082523e`、随包 supervisor JS SHA-256 `9fb50ab6f0de7cc3bf6d6efed74ed662061bdd0c7682e2e04b26b5`，运行脚本的 `-ExpectLaunchAck` 模式。Clean 1 与同一旧 launch 的 Clean 32 均在只杀宿主后核对四个进程结束，恢复后旧 claim 清除、原命令与回执各一份、首 Run epoch 由 1 到 2、首步骤尝试一次，并在最终 `dispatch_ready` 后删除零残留旧 `ARMED`；完整原始流复跑的 32 条恢复至窗口 bootstrap 用时 2292 ms。UNKNOWN 使用同一受控测试钩子制造结果歧义，恢复后原 `operation_id` 仍为 `UNKNOWN`、`dispatch_count=1`，旧 ACTIVE/CLAIMED claim 和 `ARMED` 保留，没有新 Worker。三组临时 PG 均 `pg_stop=0` 且清理了临时目录；原始 PID/PG 回执、PowerShell transcript 和含 PG 初始化/迁移的外层原始流位于 `apps/desktop/results/m03-host-real-pg-ack-{Clean-1,Clean-32,Unknown-1}.{evidence.txt,log,console.log}`，输入和日志哈希见同目录 [M03 宿主证据清单](../../apps/desktop/results/m03-host-ack-evidence.txt)。这里验证的是实际 Windows/PG/Mock Worker 组合，4096 条只在 Rust 有界管道反例中验证；单 launch 极慢核对、真实 Provider、安装器与整个 M03 仍未验收。

后续 M03 SSE 组合开发自检使用另一个精确 release（EXE SHA-256 `b49af3bacd622587a68337ac7448a2d60201a5102502fb8a47593718ef4ffbba`），随包包含 `0012_m03_run_events.sql` 和 SSE API 入口。隔离 PG18.6 中的三个真实 Mock Run 分别验证 WebView2 初读/持续刷新、SSE 不可用时快照校正、宿主强杀后的持久历史回放；安全边界和可复跑命令见 [SSE 桌面自检](../../apps/desktop/results/m03-sse-webview-evidence.txt)。`start-acceptance-session.ps1 -SkipDesktop` 的清理工具在构建后修正了 PID 0 与已停 PG 的处理，因此此 release 的 manifest 绑定构建时脚本，而非当前整棵工作树；重建必须重新固定后端输入，不能在并行开发中直接混入后续 migration。该次组合自检未切断已建立的同页 SSE；后续使用**同一冻结 release** 的[同页断流反例](../../apps/desktop/results/m03-sse-same-page-evidence.txt)在隔离 PG 中精确终止被测试表锁阻塞的 SSE 查询会话，确认旧 WebView 请求关闭、宿主/API 保持运行，RunView 自行以 `after=1` 重连并补读 Mock Worker 已提交的 seq 2–31，随后重读权威 Run 快照。该有界片已独立复跑通过；浏览器路由只延迟已发出的重连请求以形成确定的补历史窗口，不能外推其他网络故障。

2026-09-24 的[图包 WebView2 Review/RESUME 开发自检](../../apps/desktop/results/m03-review-resume-evidence.txt)使用固定 EXE SHA-256 `090be139084062914b4b85974bfed1d1e779658adfe16d1ac25361091f0a2bed`、随包 `0013` 与官方 PostgresSaver 1.0.5，在单次隔离 PG18.6 中从真实窗口创建 Project/Task、Delegate、观察 SSE、重启宿主/API、接受 `CRITERION` Review，并由原决定的 `RESUME` 完成 Run/Task。测试用短时表锁只在独立 Worker 正在执行时读取其 PID、父 supervisor 与 PG ACTIVE claim；释放锁后 Run 在人工等待时不再要求 Worker 常驻。原 Run 的空 namespace checkpoint 由 6 增至 8，Review interrupt 持久化；动作 `operation_id` 和 `dispatch_count=1` 未变，最终五个步骤尝试、一份候选产物版本和一条完成凭据。会话按业务迁移→受信图安装→应用角色运行，运行配置与环境不保留 migrator URL；本次临时 PG/宿主进程均已清理。原始构建红灯和测试红灯保留在证据清单；该次是开发自检，不代表整个 M03/G01–G08、ACTION_APPROVAL 工具效果、真实 Provider 或 Windows 安装交付已验收。

Windows 内容缩放由宿主显式启用 WebView2 原生快捷键：`Ctrl++` 放大、`Ctrl+-` 缩小、`Ctrl+0` 回到默认倍率，也可用 `Ctrl+鼠标滚轮`。不保存缩放倍率；[WebView2 用户缩放](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2controller)在导航后重置。验收需分别记录 100% 与目标 200% 内容大小和布局，再独立核对 Windows 显示 DPI 200%；显示 DPI 改变不能代替内容缩放证据。当前目录发布包已包含开关，真窗口验证仍单独记录。

桌面配置模板为 [desktop.env.example](../../apps/desktop/desktop.env.example)：默认位置为 `%APPDATA%\dev.relay.agent\desktop.env`，也可用 `RELAY_DESKTOP_CONFIG_PATH` 指向绝对路径。至少填写现有应用角色 `RELAY_DB_URL`、连接池上限、连接超时和现有 `RELAY_DESKTOP_WORKSPACE_ID`；先用迁移角色显式运行 Relay migrations，再用现有 `init:workspace` 创建 Workspace。`RELAY_DATA_ROOT` 由壳固定到自身应用数据目录的 `data` 子目录，并在启动时创建；仅隔离验收会话使用 `RELAY_DESKTOP_DATA_ROOT` 将数据改到该会话临时目录。不要把配置文件放在发布目录；不要在 README、命令行或日志复制真实 DB URL。页面连接令牌由壳每次启动生成，不需写入配置文件。

按 [ADR-006](../decisions/ADR-006-typescript-first.md)，人工阶段有桌面壳、UI 与 API，阶段 B 增加同仓同版本 Worker，API/Worker 经应用用例及 PG 协议共享事实，不新增领域 RPC。桌面壳不拥有业务事务；独立限制连接池和并发，监督健康/退出，Worker 先恢复核对再领取。进程分离不隔离 CPU、磁盘及数据库竞争，也不构成沙箱。Python 仅按需启动固定工具入口；子进程树取消和实际资源限制需 Windows 验证。

当前桌面启动顺序：取得单实例锁并校验配置/随包资源 → 逐一核验旧 `ARMED` 对应 Job 整组停机 → 持久化本次 `ARMED` 并以创建时 Job 绑定启动 API → API 校验 DB/schema/Workspace 并完成私有 readiness → 启动 supervisor、核对旧 claim 与动作并完成私有 dispatch readiness → 开放窗口 bootstrap 与新领取。未就绪只提供最小存活/启动错误信息，业务写入关闭。PG 未安装、未启动或 schema 不兼容时在窗口给出可操作错误，不要求用户找隐藏终端。旧 UNKNOWN 不阻止全部浏览，但阻止相关写资源。重复启动聚焦已有窗口；锁不替代数据库 claim 和恢复隔离。

配置项最低包含：DB URL/账号/secret_ref、data_root、bind_host/port 策略、allowed_origins、worker 并发、模型/工具预算、日志级别与脱敏。安装版推荐由系统分配空闲 loopback 端口，启动器通过私有父子进程通道取得实际端口和实例握手；禁止探测某端口就信任已有服务。开发可显式固定端口，被占用则失败。完整凭据不出现在命令行参数、端口发现文件或普通 stdout 日志中。

data_root 分 artifacts、knowledge、staging、runtime-workspaces、logs；数据库备份放用户指定的独立 backup_root。运行账号最小文件权限；data_root 不能是源码仓库根、共享网络路径或系统目录。配置/凭据不写入 Context。

## 2. 本机身份与前端凭据

V1 延续 Bearer 模式，改为桌面受控引导：壳为每次服务实例生成高熵临时凭据，经私有通道交给 API；readiness 需验证本次实例，不能只信 PID/端口。窄 IPC 仅向受信本地窗口的主 frame 返回当前端点和凭据，renderer 仅保存在内存。正常启动无需用户复制 token；页面重载可在身份校验后重新获取当前实例连接。服务重启轮换凭据，旧连接失效；已发送但结果未知的命令保留原 command_id 并查询回执，不重新生成动作。

后端严格绑定 loopback，校验实际 Host/端口与显式 Origin；无 Origin 的测试客户端也必须鉴权，不开放 wildcard 或 null Origin。生产 UI 从随包受信资源加载，实际 Tauri Windows 来源在 Spike 中记录并精确放行；它与 API 不假定同源。只允许所需 CORS 方法/请求头，预检不返回业务数据。CSP 的 connect-src 按当前服务端点配置并实测；开发 Vite 来源单独配置，不能泄入发布配置。若宿主行为不兼容应修正方案，不关闭来源校验凑通。

所有业务读写、健康详情和下载需鉴权；最小 liveness 只返回 alive。保持无 Cookie 身份，令牌不写 localStorage、URL、日志或产物。DB/Provider 密钥只交业务进程，不交 renderer。壳不授予通用 shell/文件读写 IPC；外部链接不能在拥有桥能力的窗口加载，资料预览不能执行脚本。该边界不承诺抵御已控制同一 OS 用户的恶意进程。

远程访问和团队登录不在 V1；扩大部署边界必须另设计 TLS、身份与会话。窗口重载或 token 失效不改变 Run 执行权。桌面连接协议只处理引导和生命周期，业务仍走原 HTTP 契约与 Gateway。

## 3. Schema 与角色

版本化迁移采用单一显式 SQL 入口：迁移角色在同一事务内取得 advisory lock、执行 DDL 并写入名称与 SHA-256 台账；不使用 Kysely Migrator 的无摘要台账。发布前由 migration 身份显式执行迁移，API 启动与 readiness 都不自动执行 DDL。应用身份无 DDL，也不能直读 `relay_schema_migrations`；`0003_schema_readiness` 仅授予其受限兼容视图的名称与摘要读取权，供 readiness 比对随应用发布的清单。不可变表不给 UPDATE/DELETE；领域可变表仅所需权限。开发测试也验证应用身份能运行，不总以 owner/superuser 测试。

M01 实验证明官方 PostgresSaver 1.0.5 的 `setup()` 使用另一套仅记录整数 `v` 的 `checkpoint_migrations`，其 DDL 与版本写入没有 Relay 迁移入口的单事务或内容 SHA。M03 当前源码提供独立受信入口 `apps/api/dist/src/cli/install-graph.js`：先以 `RELAY_MIGRATION_DB_URL` 执行业务 `migrate.js`，再由同一 migrator URL 执行该安装入口。它在固定 `relay_graph_v1` schema 上持有会话级 advisory lock 跨越官方 `setup()`、版本核对与 GRANT；启动 API/Worker 不调用 setup。`relay_app` 仅获 schema USAGE、整数台账 SELECT 和三个 checkpoint 表的 SELECT/INSERT/UPDATE，无 CREATE 或台账写权。Worker/supervisor 在任何 claim 或 spawn 前只读核对确切版本 `0`–`4`、权限并执行官方 Saver 的空 thread `getTuple`；缺表/损坏列均拒绝启动。`apps/desktop/scripts/start-acceptance-session.ps1 -InstallGraph` 已在隔离会话中按业务迁移后、runtime 启动前执行随包安装 CLI；固定 CRITERION Review/RESUME 的 Windows 图组合已由协调 Agent [独立验收](../testing/m03-independent-acceptance.md)，新增 ACTION_APPROVAL 工具效果的 Windows 组合与 M03 整体仍待验证。未提供生产自动升级/回滚脚本，升级前需备份和兼容性核对，不能声称 Saver 继承 Relay migration 的 SHA/事务保证。

V001–V003 业务分期以物理设计为准，后续逐模块追加。`0003_schema_readiness` 是运维兼容门，不是规划中的 V003 Authority/Worker 批次。已应用 migration 不改内容；破坏性变更先备份并明确兼容策略。当前 API 保持启动以提供 liveness，但 readiness 在 schema 不兼容时拒绝就绪；不自动回退数据。回滚优先兼容版本或备份恢复，不承诺每次 DDL 都能无损 down migration。

## 4. 备份/恢复

备份协调命令进入维护态，拒绝新写命令/领取，等当前短事务结束及受管内容发布安全点，记录未决 UNKNOWN；禁止清理。数据库使用 pg_dump 自定义归档，内容按 DB 引用和 manifest 保存，记录 schema/app 版本、时间、hash 清单。pg_dump 提供一致数据库快照，但不会替项目备份外部文件。[PostgreSQL pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html)

恢复到空的新数据库和新 data_root，先恢复 schema/data 再校验所有引用内容 hash，禁用真实外部适配器并启动恢复器检查历史未决动作。不能直接清空 UNKNOWN 或重发旧动作。验证成功后切换配置；原目录保留到用户确认恢复可用，工具不自动递归删除旧数据。

首版默认人工备份，无后台删除策略；RPO 为上次成功备份时刻，RTO 通过演练测量，不编造承诺。敏感正文和凭据按用户选择保留，凭据本身优先重新配置，备份不得明文复制供应商密钥。

Graph checkpoint 属可恢复编排证据而非领域事实，但应随 PG 一起备份并记录应用/包/schema 兼容版本。当前 `thread_id=run_id`，根图实际使用空 `checkpoint_ns`；版本隔离由固定物理 schema 承担。M03 定义清理机制前不自动删除活动、等待人工、恢复中或 `UNKNOWN` 的 thread；以后也仅可在业务终态、无未决动作且备份/审计条件满足后按明示保留策略清理。业务提交与 checkpoint 各自事务，恢复时按稳定 `operation_id`/原动作回执核对，不因图重放而创造第二次外部效果。M01 的受控异常实验证据见 [开发记录](../development/m01-stack-baseline.md#checkpoint-安装恢复与保留决定)；M03 图接入的强杀证据与限制另见 [开发记录](../development/m03-run-dispatch-slice.md)，均不代表最终 Windows 安装验收。

当前 M03 ACTION_APPROVAL 图扩展为阻止旧 RESUME 唤醒后继 Review，在新 checkpoint 中持久化确切 `reviewId/reviewKind`。此前已冻结的 Windows 固定图包只保存 `runId/lastStatus/runStatus`，验证 interrupt 没有可证明的 Review ID；按当前源码校验，这些仍在人工等待的旧 checkpoint 将失败关闭，不能猜测“最新 Review”并绕过人工决定。此升级路径尚未做旧包→新包真实 PG 实测。**M07 升级出口前必须提供受信迁移或能从业务事实与原命令唯一证明绑定的安全重建方案，并用升级反例验证。** 目前不能声称保留既有待审 Run 执行状态的升级已验收。

扩展定义保留：备份与升级兼容检查需覆盖已引用的 Skill/Pack/Profile/Recipe 定义快照及摘要，位置按实际存储实现确定；不能仅备份当前应用随包新版。恢复时校验历史依赖完整性，缺失不可用而非加载新版顶替。配置恢复、Project Checkpoint 与本节整机数据恢复是不同操作，均不能撤销已经发生的外部效果；产品中的来源视图仍按当前权限读取历史内容。

## 5. 观察与排障

结构化日志包含 request_id/command_id/project_id/task_id/run_id/operation_id/invocation_id，缺字段可空；不包含 token、完整提示词、资料全文。关键证据在业务表，日志不是唯一来源。

指标最小包括运行中/等待/未知动作数、claim 超时、命令冲突、模型/工具耗时和已知用量、存储失败。没有 provider token 用量时记 unknown，不估算成精确账单。

readiness 区分 DB/schema/storage 与可选 provider。模型离线仍应能做 Me；CLI 不可用只禁用相应 capability。推荐关闭窗口即退出，最小化继续运行。先处理未保存草稿，再进入停机态：拒绝新业务写命令/领取、等待短事务和外部动作安全点，显示正在退出及未决动作。等待上限待验证；超时可由用户选择继续等待或退出，不能显示已安全完成。

正常退出尝试终止受管进程树；崩溃/强杀不假定能补写状态。执行前已有的 durable 意图供恢复核对；无法证明旧子进程结束或外部效果时隔离相关资源，禁止因租约到期就放行。不得停止或卸载用户独立 PG 服务。升级前使用同一停机协议，不能边执行边替换程序。

## 6. 发布清单

交付可安装的 Windows 应用与开始菜单启动入口，桌面快捷方式可由安装器选项提供。安装器类型、目标 CPU/Windows 版本、WebView2 检测/引导和签名流程在 P00/P20 验证后记录；当前不承诺已有签名或无系统提示。应用携带所需 Node 运行时，用户无需安装开发工具链或手动启动 API。PG 推荐作为独立前提，不由安装器静默安装或管理；首次启动检查连接并提供配置入口。

安装目录与用户数据分离。升级前备份并校验 schema；不兼容则停止，不能自动破坏性降级。卸载默认保留 PG、data_root 和用户配置，清理业务数据须另行明确选择。V1 不预设自动更新、后台常驻或开机启动。

干净 Windows 环境演练安装、从入口启动、重复启动、运行中关闭、崩溃恢复、升级与卸载保留数据；记录 WebView2/Node/壳版本、进程树和端口。再验证人工闭环、Fake/真实模型闭环、UNKNOWN 恢复及备份恢复。输出实际证据与限制，不把开发模式能开窗口当安装验收。
