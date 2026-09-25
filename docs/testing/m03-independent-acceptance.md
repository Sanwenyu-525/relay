# M03 独立验收记录

日期：2026-09-25。范围：Mock Agent Runtime 与可靠性闭环。当前结论：**按用户最新范围，当前冻结试用包基础 Mock 闭环通过**；M03 完整可靠性保持未验收，详见末节的范围调整。Manifest 正文与摘要失配、UNKNOWN 桌面故障脚本不兼容等发现保留为后续可靠性事项，不阻塞本轮基础功能结论。模块状态与下一步以 [CODEX_NEXT_STEP](../../CODEX_NEXT_STEP.md)为准，出口以 [M03 工作包](../../prompts/stack-migration.md#m03mock-agent-runtime-与可靠性闭环)和[测试计划 G01–G08](verification-plan.md#102-m03-必需可靠性场景)为准。

## 前置与分工

M01、M02 已独立验收。实现、测试和修复由实际调用的 `gpt-6-sol / ultra` 执行者负责；协调 Agent 对每个提交片独立检查，并在完整 G01–G08 通过后给出 M03 结论。后端执行者负责 `apps/api` 的持久命令、独立 Worker、Mock 图运行与故障测试；前端执行者负责 React 的 Delegate、Run、Review 与 SSE 接入。各片通过前不把开发自检或局部测试作为模块放行。

在首片早期保存 [144 个 API 输入摘要](evidence/m03/api-start-snapshot.sha256)，清单 SHA-256 为 `aba1b46f93482eeba5220d04da2d815b083825a5814c60b5cf5ac01e71082648`。它用于辨认后续增量，不声称该清单必然早于执行者的第一处编辑。每个 READY 片仍需重新冻结实际输入并绑定独立测试输出；本仓库尚无初始 commit，不能用空 Git diff 代替文件基准。

## 独立验收门槛

| 范围 | 核查重点 |
|---|---|
| 持久受理与分发 | 同事务 Run、command、outbox、回执；相同/不同载荷重放；实际独立 API/Worker 进程和真实 PostgreSQL；丢通知、重启与重复领取 |
| 执行与恢复 | 同 thread 单有效 invocation、租约与递增 fence、旧 Worker 迟到；停机证据、原 operation_id 核对、UNKNOWN 资源隔离与提交窗口 |
| 图与审批 | 唯一通用 LangGraph、PostgresSaver 与业务事实对账；审批等待释放槽位，重复/失效批准及新 resume command；完成仍经领域入口 |
| 控制与事件 | 取消持久化并传到实际执行端；完成竞争与终态不复活；PG 权威 SSE 序列、带 Bearer 补历史、实时竞态、断页不取消 |
| 安全与 UI | Host/Origin、Workspace/Project 边界、回执及敏感数据边界；React 的真实 Delegate/Run/Review/控制/SSE 页面与受影响旧功能回归 |
| 交付记录 | 运行环境、精确命令/退出码、冻结输入、原始日志、失败修复复验、压测样本与限制、受影响文档一致性 |

G01–G08 必须以真实 PostgreSQL、独立 API/Worker 和可控 Mock Model/工具验证；受影响的旧 A01–D11 不变量要回归。真实 Provider 在 M03 **ACCEPTED** 前保持关闭。检查表本身不是测试成绩；下述每项分片结论仅覆盖其列明的输入和场景。

| 总出口 | 已有分片证据 | 仍需独立证明 |
|---|---|---|
| G01 | 持久 202/重放及真实 WebView Run/SSE | UI 创建→Delegate 与重启、同/异载荷 Key、事件补读的同链路组合 |
| G02 | 0013 Review/RESUME 顺序、批准失效栅栏与固定图验证 Review interrupt/原决定 RESUME | ACTION_APPROVAL 图内效果只执行一次及目标/权限变化反例 |
| G03 | 原 operation_id、UNKNOWN、桌面停机保留及受管候选效果的业务提交/checkpoint 窗口 | Gateway 工具效果与图 checkpoint/业务提交各崩溃窗口 |
| G04–G05 | 独立 Worker、PG outbox、强杀重启、失租及固定图恢复/旧 epoch 不写正常后继 checkpoint | 真实桌面与 Gateway 节点的同 thread 双 Worker、过期写入组合 |
| G06 | 持久控制与安全点竞争 | 在途模型/子进程实际中止、取消与完成竞争的组合收敛 |
| G07 | SSE/部分 Run 与受管内容边界 | Run、审批、产物、文件的完整跨 Workspace/Project 与桌面泄密反例 |
| G08 | PG SSE 连续补读、同页重连和受控背压 | 跨提交排序、尾部校正、大输出、失败/预算耗尽及固定负载测量的总出口 |

上表保留早期分片的出口缺口，后续增量与本次覆盖以各节、尤其末节为准；表中“已有”均指限定的分片结论，任何一行都不是 G 项整体通过。

## React 首片独立检查

结论：**FRONTEND_SLICE1_ACCEPTED（仅 Delegate 入口与 Review 回执子范围）**；M03 仍为 IN_PROGRESS。执行者交付的 [9 项变更输入清单](../../apps/workbench/artifacts/m03-slice1/changed-inputs.sha256) SHA-256 为 `c0590a04746872afdaa15ca379c495761476dea5dc3b0741aeb3b9bbfc799a5d`。协调 Agent 在复跑前后核对 9/9 摘要一致，并检查了新 Delegate 的 202、响应不明/原 ID 查询、错类型/错目标回执反例，以及 Review 即时与查询回执的决定绑定。后端确认本片沿用现有 Delegate 请求与 202 结果字段；创建页不把 `DELEGATE_AI` 选择当作自动启动。

| 独立命令（项目根目录） | 退出码与结果 | 输出 |
|---|---|---|
| `pnpm --dir apps/workbench typecheck` | 0 | [类型检查](evidence/m03/independent-frontend-slice1-typecheck.txt) |
| `pnpm --dir apps/workbench test` | 0；22 文件、122/122 | [组件测试](evidence/m03/independent-frontend-slice1-vitest.txt) |
| `pnpm --dir apps/workbench test:browser` | 0；20/20 | [Chromium 回归](evidence/m03/independent-frontend-slice1-browser.txt) |
| `node scripts/check-docs.mjs` | 0；76 Markdown、1041 链接、912 锚点 | [文档检查](evidence/m03/independent-frontend-slice1-docs.txt) |

以上使用便携 Node 24.21.0。浏览器回归主要覆盖既有页面与创建路径；新增 Delegate/Review 反例是模拟 HTTP 的组件测试，尚未证明真实 PG/API、独立 Worker、SSE 或 Windows 桌面端到端链路。这些留在 M03 完整验收，不因本片通过而提前放行。

## React SSE 客户端准备片独立检查

结论：**FRONTEND_SSE_SLICE_ACCEPTED（仅客户端有界事件解析、补历史与快照重读）**；M03 仍为 IN_PROGRESS。执行者的[20 项输入/构建清单](../../apps/workbench/results/m03-sse-inputs.sha256) SHA-256 为 `457185999731a594fa9d2e64f7830a424065eda576b5252ec48fc60e230e148e`。协调 Agent 在独立复跑前后核对 20/20 一致，源码核对 Bearer 仅在请求头、`after` 为 PG bigint 范围内十进制游标、分片 UTF-8/完整帧与连续序号、密集事件合并重读、离页只 Abort。

| 独立命令（`apps/workbench`，便携 Node 24.21.0） | 结果 | 原始输出 |
|---|---|---|
| `node node_modules/typescript/bin/tsc --noEmit` | 退出 0 | [类型检查](evidence/m03/independent-frontend-sse-typecheck.txt) |
| `node node_modules/vitest/vitest.mjs run` | 退出 0；23 文件、127/127 | [组件与受控流测试](evidence/m03/independent-frontend-sse-vitest.txt) |
| `node node_modules/@playwright/test/cli.js test --reporter=line` | 退出 0；Chromium 21/21 | [浏览器回归](evidence/m03/independent-frontend-sse-browser.txt) |
| `npm run build`（同便携 Node PATH） | 退出 0；产物摘要仍与输入清单一致 | [生产构建](evidence/m03/independent-frontend-sse-build.txt) |
| `node scripts/check-docs.mjs`（项目根目录） | 退出 0；77 Markdown、1081 链接、926 锚点 | [文档检查](evidence/m03/independent-frontend-sse-docs.txt) |

受控流测试覆盖 Bearer 不入 URL、跨 chunk 的中文、CRLF、重复/缺号、截断帧、超长/溢出 ID、大数据仅作重读提示、10 事件 burst 的请求合并、安静流周期快照、401 停止旧凭据重连、页面卸载不发取消；浏览器用模拟 API 验证连接 UI 与权威 Run 快照。客户端按首序号 1、初始 `after=0` 和 `text/event-stream` 准备，服务端合同与真实 PostgreSQL 的事件顺序、历史/实时竞态、独立 Worker、跨 Workspace 拒绝及 Windows WebView 尚未联调，G01/G07/G08 因此未通过。

## 后端首片独立检查与退回项（历史结论）

结论：**CHANGES_REQUESTED（首片尚未验收）**；M03 仍为 IN_PROGRESS。首片范围是持久 Run command/outbox、独立 Worker 与 supervisor、同一命令的保守恢复。执行者冻结的 [16 项后端输入清单](evidence/m03/backend-slice-01.sha256) SHA-256 为 `45dd0b5af4a2506dcaac09cf1d05ac6ed14c50d7384dd5b3a4a26d72c99b94dd`；协调 Agent 在全量测试前后核对 16/16 摘要一致。

隔离 PostgreSQL 18.6 上重新构建并运行完整 API 集成套件，退出码 0、176/176 通过、零跳过，临时集群已清除；原始输出见[独立后端 PG 日志](evidence/m03/independent-backend-slice1-full-pg.txt)。该结果证明已覆盖的事务和分发回归，不证明 G01–G08 全部通过。

源码审查发现两个尚未由上述测试覆盖的反例：`runOneCommand` 在领取命令与执行 `onClaim` 后才订阅取消信号，预先中止的信号可能仍领取并执行；`PERSIST_CANDIDATE` 在初次 invocation 栅栏之后、效果分发之前另开事务写入 `PREPARED`，执行途中失租时需要再次验证旧 Worker 不会产生未授权写入。已有 G05 测试覆盖“再次调用前失租”，没有覆盖步骤运行中失租；效果核对的现有分支也需按原身份验证旧 epoch 写入边界。已要求执行者用真实 PG 反例复现、修复、复验并重新冻结输入。是否存在更深的锁序或恢复影响，以修复后的独立复验为准；在此之前不将首片标为 ACCEPTED。

## 后端首片失租修复复验

结论：**BACKEND_SLICE1_ACCEPTED（仅持久 Run 命令、独立 Mock Worker 和保守恢复的首片范围）**；上述 CHANGES_REQUESTED 已经修复并复验，不是 M03 G01–G08 整体放行。执行者的[24 项最终输入清单](evidence/m03/backend-slice-01-remediation.sha256) SHA-256 为 `b3d966a3347fbffa33b54127bb30f3af9c9d6e8c712620d4584bf9b4d6f3f512`；[8 项开发日志清单](evidence/m03/backend-slice-01-remediation-logs.sha256) SHA-256 为 `a84bb1a49566bcc0b18cf90a23f39bc174ad605158f7654b647abbea6676ed50`。协调 Agent 独立核对 24/24 输入、8/8 日志，并在复跑前后再次核对输入 24/24 未变。三份红灯源码归档是事后按同缺陷重建的可复跑输入，不冒充原始临时源码；原始与重建红灯的差别、退出码和边界见[开发记录](../development/m03-run-dispatch-slice.md#独立源码审查后的失租修复)。

| 独立命令（项目根目录） | 结果 | 原始输出 |
|---|---|---|
| `powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1 -TestFile run-dispatch` | 退出 0；真实隔离 PostgreSQL 18.6，12/12，零失败/跳过；临时集群已删除 | [分发与失租反例](evidence/m03/independent-backend-remediation-run-dispatch.txt) |
| `powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1` | 退出 0；同环境全量 181/181，零失败/跳过；临时集群已删除 | [完整 API 集成回归](evidence/m03/independent-backend-remediation-full-pg.txt) |
| `pnpm --filter @relay-agent/api typecheck` | 退出 0；本机 pnpm 进程为 Node 22，提示项目 Node 24 engine 警告；PG 包装器以便携 Node 24.21.0 构建/运行 | [类型检查](evidence/m03/independent-backend-remediation-typecheck.txt) |
| `node scripts/check-docs.mjs`（便携 Node 24.21.0） | 退出 0；77 Markdown、1062 链接、922 锚点 | [文档检查](evidence/m03/independent-backend-remediation-docs.txt) |

源码复核确认 `runOneCommand` 先订阅并复查取消信号，再领取和执行 `onClaim`；PERSIST 的 PREPARED 插入与 DISPATCHING/UNKNOWN 结果登记均在同一短事务中锁 Task/Run，并核对步骤 Worker、epoch、Task Owner 与当前 invocation/数据库租约。迟到写返回 `INVOCATION_LOST`；外部效果若已发出，仍由可信恢复路径以原 `operation_id` 核对，UNKNOWN 继续隔离。红灯复现、绿灯测试和源码栅栏共同支撑本片结论，故障注入强制新 epoch 只证明内层拒绝迟到写，不代表生产可以在旧进程未停止时重新领取。

本片仍无 LangGraph/PostgresSaver 生产图、桌面私有恢复协议、SSE、审批后新 RESUME、取消传播和 G01–G08 全量端到端证据；这些继续作为 M03 出口，真实 Provider 保持关闭。

## Windows 宿主安全基础片独立检查

结论：**HOST_SAFETY_SLICE_ACCEPTED（仅 Windows 进程组与启动门子范围）**；M03 仍为 IN_PROGRESS。执行者冻结的 [11 项输入清单](../../apps/desktop/results/m03-host-slice-inputs.sha256) SHA-256 为 `103a72bbf5158223e89d79a8dabd24594d21947827cfedf4cbc27718df97099f`，协调 Agent 复跑前后核对 11/11 一致。Rust 宿主现在以 Windows `PROC_THREAD_ATTRIBUTE_JOB_LIST` 在 `CreateProcessW` 时把 API 与 supervisor 分别绑定到命名 Job，并先持久保存 `ARMED` 启动记录；旧记录缺损、旧 Job 无法核验或旧 supervisor 缺少协议标记时拒绝启动。执行者的[原始自检与限制](../../apps/desktop/results/m03-host-slice-evidence.txt)供对照；下表为协调 Agent 的独立复跑。

| 独立检查 | 结果 | 原始输出 |
|---|---|---|
| `cargo test --locked --target x86_64-pc-windows-msvc`（带便携 Node 24 与旧 supervisor 入口） | 退出 0；12/12，零忽略 | [Rust 测试](evidence/m03/independent-host-slice-rust.txt) |
| `test-host-crash-job.ps1`（强杀宿主后新进程核验） | 退出 0；两个 Node PID 均消失，旧命名 Job 核验通过，临时根已清理 | [强杀反例](evidence/m03/independent-host-slice-crash.txt) |
| `test-job-in-outer-job.ps1`（外层 Job 内启动） | 退出 0；内层 Job 运行通过 | [嵌套反例](evidence/m03/independent-host-slice-outer-job.txt) |
| `cargo check --locked --target x86_64-pc-windows-msvc` | 退出 0 | [编译检查](evidence/m03/independent-host-slice-cargo-check.txt) |
| `node scripts/check-docs.mjs` | 退出 0；77 Markdown、1053 链接、921 锚点 | [文档检查](evidence/m03/independent-host-slice-docs.txt) |

本片明确保留后端私有首帧、`dispatch_ready` 和按旧 launch 的 PG 恢复为待实现：现有编译 supervisor 不含 `relay-desktop-supervisor-v1`，Rust 与发布脚本在启动 Node 前拒绝它。此次没有生成新 release，也没有真实 PG/Worker 联调、桌面窗口、UNKNOWN 或 G04/G05 全场景通过证据。`ARMED` 记录在协议确认恢复之前保留；长期整理和强杀后真实业务恢复须在 M03 集成片验证。Windows Job 的进程树继承、关闭最后句柄与创建时绑定依据微软 [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)和[进程创建属性](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)，本片的具体行为以上述实测为准。

## Windows 监督器事件读取准备片独立检查

结论：**HOST_READER_SLICE_ACCEPTED（仅握手后持续读取与异常输出处理）**；M03 仍为 IN_PROGRESS。执行者的[11 项输入清单](../../apps/desktop/results/m03-host-reader-inputs.sha256) SHA-256 为 `4beb0ab3a1cd0a3be7e4cae30f1881324e2cc17aae59ede7771780f58729597c`，协调 Agent 在独立复跑前后核对 11/11 一致；源代码与上述宿主基础片基准相比只改 `apps/desktop/src-tauri/src/lib.rs` 和[本机部署说明](../deployment/local-deployment.md)。

| 独立检查 | 结果 | 原始输出 |
|---|---|---|
| `cargo test --locked --target x86_64-pc-windows-msvc`（便携 Node 24、旧 supervisor 入口） | 退出 0；14/14，零忽略 | [Rust 测试](evidence/m03/independent-host-reader-rust.txt) |
| `cargo check --locked --target x86_64-pc-windows-msvc` | 退出 0 | [编译检查](evidence/m03/independent-host-reader-cargo-check.txt) |
| `node scripts/check-docs.mjs`（便携 Node 24.21.0） | 退出 0；77 Markdown、1069 链接、923 锚点 | [文档检查](evidence/m03/independent-host-reader-docs.txt) |

源码与定向分段流测试确认：`supervisor_ready`、`dispatch_ready` 身份/顺序/Node 版本及 64 KiB 每行界限严格校验；函数返回后，reader 仍消费随后到达的 `worker_started`、`worker_exit`，未知运行事件在管道保持打开时立即设宿主故障，EOF 也触发故障处理。宿主监视线程在故障时停止 supervisor Job，避免关闭 stdout 阅读端后 Node 写入失败。当前后端编译入口仍缺 v1 协议标记，本片未构建新发行包、未运行真实 PG/Worker 或强杀重启集成；此前宿主强杀测试绑定旧基础片二进制，不自动继承到本片。长期 `ARMED` 记录增长和 UNKNOWN 停机证明保留待联调处理。

## 后端桌面私有协议与 64 KiB 回执补救独立检查

结论：**BACKEND_DESKTOP_PROTOCOL_SLICE_ACCEPTED（仅私有首帧、旧 launch 核对及有界启动回执）**；M03 仍为 IN_PROGRESS。初版协议在真实 PG 定向 18/18、全量 187/187 等自检和独立复跑后，另经只读审查发现 P1：合法旧 launch 积压可让完整 `dispatch_ready` Run ID 数组超过宿主 stdout 单行 64 KiB 上限，进而在 UNKNOWN 阻断时反复启动失败。执行者用[旧序列化源码](evidence/m03/desktop-protocol-red-dispatch-ready.ts.txt)复现最终 4 项纯协议测试 0/4、退出 1，修复后为 4/4、退出 0；协调 Agent 复核了红绿输入、现行有界序列化、Rust 读取上限，以及 [30 项最终输入清单](evidence/m03/backend-desktop-protocol-line-limit.sha256) SHA-256 `b4f10fbb3d1c1dafc14088c3295059a20373ebffa66cb1cdde1ffcc7b6ea981c`、[7 项开发日志清单](evidence/m03/backend-desktop-protocol-line-limit-logs.sha256) SHA-256 `08296d0f54cf181c2b08deaac4d9ca2f78ef5e52013a142603c75e506bddea8b`。两份清单分别 30/30、7/7 一致，独立复跑前后最终输入仍 30/30 一致。

| 独立命令（项目根目录） | 结果 | 原始输出 |
|---|---|---|
| 便携 Node 24.21.0 `--test apps/api/dist/test/unit/desktop-supervisor-protocol.test.js` | 退出 0；4/4，含 1677 阻断 ID、4096+4096 ID、UTF-8 字节边界 | [纯协议复验](evidence/m03/independent-backend-line-limit-unit.txt) |
| `powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1 -TestFile run-dispatch` | 退出 0；隔离 PostgreSQL 18.6，18/18，零失败/跳过，临时集群已删除 | [分发/桌面协议](evidence/m03/independent-backend-line-limit-run-dispatch.txt) |
| `powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1` | 退出 0；隔离 PostgreSQL 18.6，187/187，零失败/跳过，临时集群已删除 | [完整 API 回归](evidence/m03/independent-backend-line-limit-full-pg.txt) |
| `pnpm --filter @relay-agent/api typecheck` | 退出 0；本机 pnpm 使用 Node 22 提示 engine 警告，PG 包装器使用便携 Node 24 | [类型检查](evidence/m03/independent-backend-line-limit-typecheck.txt) |
| `node scripts/check-docs.mjs`（便携 Node 24） | 退出 0；77 Markdown、1092 链接、927 锚点 | [文档检查](evidence/m03/independent-backend-line-limit-docs.txt) |
| `npm pack --dry-run --json`（`apps/api`） | 退出 0；包含新协议 JS、supervisor、Worker、0011 migration | [打包清单](evidence/m03/independent-backend-line-limit-pack.json) |

私有帧在 PostgreSQL 连接或 Worker 启动前校验，旧 Job 已停证明由宿主提供；`supervisor_ready` 后逐 launch 核对原 claim，`dispatch_ready` 后才开始新领取。两个旧数组仍供当前 Rust 反序列化，但只是不超过 64 KiB 实际 UTF-8 行长的前缀样本；新增完整结果计数和截断标志。实际旧 claim 的核对未因输出截断而减少。`dispatch_ready` **不是删除所有旧 `ARMED` 记录的持久确认**：UNKNOWN/残留 claim 可能仍依赖旧停机证明；当前 30 秒第二阶段等待亦可能在大积压时安全超时。逐 launch 可清理回执、宿主计时、真实 Windows/PG/Worker 强杀联调和 G01–G08 整体出口继续待验，真实 Provider 保持关闭。

## 后端逐旧 launch 恢复回执独立检查

结论：**BACKEND_LAUNCH_ACK_SLICE_ACCEPTED（仅后端逐 launch 回执及持久残留计数）**；M03 仍为 IN_PROGRESS。执行者的[32 项输入清单](evidence/m03/backend-desktop-launch-ack.sha256) SHA-256 为 `7bfe35ddbed0d35f89b484d350dd4708dc1b85fcb337888d0d69ee0b2a889a31`，[8 项开发日志清单](evidence/m03/backend-desktop-launch-ack-logs.sha256) SHA-256 为 `dc7234eb1f42fcf087f043c74b1fc085c90cb8d885808ffe4bea101be541d314`。协调 Agent 在独立复跑前后核对输入 32/32 一致，日志 8/8 一致；源码复核确认每条旧 launch 完成恢复事务后重新查询 PG 中该 launch 的 ACTIVE/STOP_REQUIRED invocation 数，按输入顺序发 `launch_recovery_ack`，全部完成后才发最终 `dispatch_ready` 并开始新领取。计数为非负安全 JSON 整数，输出受单行 64 KiB 边界约束；若恢复/计数异常或 EOF，不发未完成的回执或最终 ready。

| 独立命令（项目根目录） | 结果 | 原始输出 |
|---|---|---|
| 便携 Node 24.21.0 `--test apps/api/dist/test/unit/desktop-supervisor-protocol.test.js` | 退出 0；5/5 | [纯协议复验](evidence/m03/independent-backend-launch-ack-unit.txt) |
| `powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1 -TestFile run-dispatch` | 退出 0；隔离 PostgreSQL 18.6，22/22，零失败/跳过，临时集群已删除 | [定向分发与恢复](evidence/m03/independent-backend-launch-ack-run-dispatch.txt) |
| `powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1` | 退出 0；隔离 PostgreSQL 18.6，全量 191/191，零失败/跳过，临时集群已删除 | [完整 API 回归](evidence/m03/independent-backend-launch-ack-full-pg.txt) |
| `pnpm --filter @relay-agent/api typecheck` | 退出 0；本机 pnpm 的 Node 22 报 engine 警告，PG 包装器用便携 Node 24 | [类型检查](evidence/m03/independent-backend-launch-ack-typecheck.txt) |
| `node scripts/check-docs.mjs`（便携 Node 24） | 退出 0；77 Markdown、1112 链接、930 锚点 | [文档检查](evidence/m03/independent-backend-launch-ack-docs.txt) |
| `npm pack --dry-run --json`（`apps/api`） | 退出 0；包含新协议 JS、supervisor、Worker 和 0011 migration | [打包清单](evidence/m03/independent-backend-launch-ack-pack.json) |

真实 PG 故障注入还覆盖：零 claim 发 0、成功重排发 0、UNKNOWN 在未持久写入停机证明时仍有残留并发 `retainedClaims=1`、慢速多 claim 中途杀死后原身份重试、EOF/异常只留已完成进度且没有最终 ready。后端回执**不能单独授权清理旧 `ARMED`**；Windows 宿主必须验证 nonce、顺序和最终 ready，且只清理 `retainedClaims=0` 的旧记录。组合包、真实 Windows 强杀/恢复与 G01–G08 仍待独立验收，真实 Provider 保持关闭。

## Windows 宿主与后端回执组合独立检查

结论：**HOST_LAUNCH_ACK_INTEGRATION_SLICE_ACCEPTED（仅真实 Windows/PG/Mock Worker 的旧 launch 清理和 UNKNOWN 保留）**；M03 整体仍为 IN_PROGRESS。执行者冻结的[18 项输入清单](../../apps/desktop/results/m03-host-ack-inputs.sha256) SHA-256 为 `665e01aa203bb225ca6e6cfb33957ae711b04b838b0a31692ad968f6a10057f2`，[13 项原始日志清单](../../apps/desktop/results/m03-host-ack-logs.sha256) SHA-256 为 `a835d7e240a17584024784be35b7f45666444813759f14d20d546d07c4328197`。协调 Agent 在独立复跑前后核对分别 18/18、13/13 未变；组合 release 的 EXE SHA-256 为 `0769b1dd762fce84690bdc9955bd18a4562c253f2854a49c6630015b0082523e`，构建清单 SHA-256 为 `067e2068aae09eb37466de6af711129e55f5684abf2961a8003ab8c126803409`，随包 API/监督器/Worker/0011 四项摘要均与清单相同，清单含 7870 个资源文件哈希、无配置凭据文件。执行者的[自检命令、环境与限度](../../apps/desktop/results/m03-host-ack-evidence.txt)和本节独立结果分开记录。

| 独立命令 | 结果 | 原始输出 |
|---|---|---|
| `cargo +stable-x86_64-pc-windows-msvc test --locked --target x86_64-pc-windows-msvc`（`apps/desktop/src-tauri`） | 退出 0；Rust 20/20，零忽略 | [Rust 测试](evidence/m03/independent-host-ack-rust.txt) |
| `cargo +stable-x86_64-pc-windows-msvc check --locked --target x86_64-pc-windows-msvc`（同目录） | 退出 0 | [编译检查](evidence/m03/independent-host-ack-cargo-check.txt) |
| `node scripts/check-docs.mjs`（便携 Node 24，项目根目录） | 退出 0；77 Markdown、1121 链接、931 锚点 | [文档检查](evidence/m03/independent-host-ack-docs.txt) |
| `test-m03-host-real-pg.ps1 -Scenario Clean -BacklogCount 1 -ExpectLaunchAck`（PowerShell，项目根目录） | 退出 0；真实 Windows Job、隔离 PG18.6 和 Mock Worker；四个旧 PID 均停止，旧 claim 恢复到 epoch 2，原命令/回执/首步尝试各一，旧 ARMED 清理；PG stop 0、临时目录删除 | [实机事实](evidence/m03/independent-host-ack-Clean-1.evidence.txt)、[PowerShell transcript](evidence/m03/independent-host-ack-Clean-1.log) |
| 同脚本 `-Scenario Clean -BacklogCount 32 -ExpectLaunchAck` | 退出 0；同一旧 launch 的 32 个 claim 不再占用，四 PID 均停止，最终 ready 后旧 ARMED 清理；PG stop 0、临时目录删除 | [实机事实](evidence/m03/independent-host-ack-Clean-32.evidence.txt)、[transcript](evidence/m03/independent-host-ack-Clean-32.log)、[完整控制台](evidence/m03/independent-host-ack-Clean-32-console.txt) |
| 同脚本 `-Scenario Unknown -BacklogCount 1 -ExpectLaunchAck` | 退出 0；四 PID 均停止，原 `operation_id` 的 `dispatch_count=1` 与 UNKNOWN 保留，旧 ACTIVE claim/ARMED 保留，新 Worker 为零；PG stop 0、临时目录删除 | [实机事实](evidence/m03/independent-host-ack-Unknown-1.evidence.txt)、[transcript](evidence/m03/independent-host-ack-Unknown-1.log)、[完整控制台](evidence/m03/independent-host-ack-Unknown-1-console.txt) |

源码复核确认宿主按旧 launch 输入顺序验证 nonce、唯一 ack 和 `retainedClaims` 安全整数，全部 ack 后只认同一 launch 的最终 `dispatch_ready`；随后重新核对旧 ARMED 文件身份，仅删除零残留记录。部分 ack、乱序/重复/外来 ID、EOF、超时和大于 64 KiB 的私有输出均安全拒绝。Rust 受控流测试覆盖 4096 个 ack 不堵管道；**真实 PG 积压实测仅为单个旧 launch 的 32 个 claim**。单个 launch 的慢核对仍可能达到 120 秒 idle/20 分钟总时限并拒绝打开工作台，保留 ARMED 等待再次核对；UNKNOWN 由实际停机后注入的结果不明故障构造，不是已验证真实 Provider 在途副作用。安装器、干净机、完整 G01–G08 和 M03 整体仍未放行。

## Run SSE 后端片独立检查

结论：**BACKEND_RUN_SSE_SLICE_ACCEPTED（仅 PG 事件持久化与 API 流）**；M03 仍为 IN_PROGRESS。执行者冻结的[15 项输入清单](evidence/m03/sse-inputs.sha256) SHA-256 为 `6f3023c260b6349cf2ce844f0f7c4f1770dc0b37f352293fbfafc55c62a3beca`，[19 项原始日志/包清单](evidence/m03/sse-logs.sha256) SHA-256 为 `92fec3156b69b9bc90d28b4535c80a04488cba49c7bf20d4be32f9d5f6f4b41a`。协调 Agent 在独立复验前后逐项核对 15/15、19/19 一致。新增 0012 migration 的 AFTER trigger 把每 Run 连续序号刷新提示写入原业务事务；源码复核确认 SSE 先检查 Bearer/Host/Origin 与 Workspace，再使用分批 PG 补读、完整帧游标及有界写入等待。恢复 Effect 路径先锁 Task→Run 后写 Effect，避免新触发器造成反向锁序。

| 独立命令（项目根目录） | 结果 | 原始输出 |
|---|---|---|
| `powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1 -TestFile migration` | 退出 0；隔离 PostgreSQL 18.6，7/7，临时集群已删除 | [迁移与 SHA](evidence/m03/independent-sse-migration.txt) |
| 同脚本 `-TestFile run-events` | 退出 0；真实 PG/HTTP/独立 Worker，7/7，临时集群已删除 | [SSE、权限、重放与大量历史](evidence/m03/independent-sse-run-events.txt) |
| 同脚本 `-TestFile recovery` | 退出 0；恢复与锁序 17/17，临时集群已删除 | [恢复反例](evidence/m03/independent-sse-recovery.txt) |
| 同脚本无 `-TestFile` | 退出 0；全量 199/199，零失败/跳过；build/test/PG 启停均 0，临时集群已删除 | [完整 API 回归](evidence/m03/independent-sse-full-pg.txt) |
| 便携 Node 24.21.0 `--test apps/api/dist/test/unit/run-events-api.test.js` | 退出 0；4/4，含 `write(false)` 后 drain、取消和约 5 秒超时 | [背压单测](evidence/m03/independent-sse-unit.txt) |
| `pnpm --filter @relay-agent/api typecheck` | 退出 0；本机 pnpm 使用 Node 22 并提示 engine，PG 包装器以便携 Node 24 构建/运行 | [类型检查](evidence/m03/independent-sse-typecheck.txt) |
| 便携 Node 24.21.0 `scripts/check-docs.mjs` | 退出 0；初次 77 Markdown、1146 链接、935 锚点；本节与状态文档编辑后再次通过 | [初次检查](evidence/m03/independent-sse-docs.txt)、[编辑后检查](evidence/m03/independent-sse-docs-postaccept.txt) |
| `npm pack --dry-run --json`（`apps/api`） | 退出 0；124 个文件，含 0012、SSE API/repository、supervisor/Worker JS | [包清单](evidence/m03/independent-sse-pack.json) |

真实 socket 慢读用例证明 50,000 条已提交事件积压时其他 PG 写入与 Run GET 未被阻塞、断连后可从原游标补读；它没有稳定触发 Node `write(false)`，因此不把该场景记作真实 socket 必在 5 秒内关闭的证明。执行者保留更早 50,000/250,000 条超时试验的[原始红灯](evidence/m03/sse-run-events-backpressure-socket.log)与[原始红灯](evidence/m03/sse-run-events-large-backpressure.log)；受控写入流独立复验了 `write(false)` 后的超时分支。首次全量 196/199 失败于迁移测试预期固定为 11 份，加入 0012 的第 12 份预期后复跑 199/199；[首次红灯](evidence/m03/sse-full-integration-initial.log)仍保留。当前事件不裁剪、旧 Run 不回填；真实 WebView2 长连接、导航/重启补读和 G01/G07/G08 端到端仍待验证。审批后 RESUME、LangGraph/PostgresSaver、在途取消、真实 Provider 和 M03 总出口均未放行。

## Windows WebView2 与 PG SSE 组合独立检查

结论：**HOST_SSE_INTEGRATION_SLICE_ACCEPTED（仅已测真实 Windows/PG/Mock Worker 路径）**；M03 仍为 IN_PROGRESS。执行者冻结的[18 项输入清单](../../apps/desktop/results/m03-sse-webview-inputs.sha256) SHA-256 为 `7e6fa67f70cd3e1ff75f77d9f9e117e8f46f30a46aefcaea023ac99f44b0217a`，[9 项原始日志清单](../../apps/desktop/results/m03-sse-webview-logs.sha256) SHA-256 为 `e16feb520dcf45db6e821f07378bd3fbe9afddb3f2406f6a714ceba601c89fd3`；协调 Agent 独立复跑前后核对分别 18/18、9/9 一致。使用构建时冻结的 EXE SHA-256 `b49af3bacd622587a68337ac7448a2d60201a5102502fb8a47593718ef4ffbba` 和 manifest SHA-256 `b782780435fd9129f168ccc29d2adaa84f7611d31997734df6917967c1fb1514`；随包 SSE JS/0012 与已验收后端哈希相同。协调 Agent 另逐项重算 7873 个随包资源哈希，均匹配 manifest，禁带配置文件数为 0。

独立执行便携 Node 24.21.0 `apps/desktop/tests/m03-sse-webview.mjs`，参数为冻结 SSE JS 与 0012 的 SHA-256，退出 0；[完整原始输出](evidence/m03/independent-sse-webview.txt)末行 `M03_SSE_WEBVIEW_REAL_PG=PASS`，`postgres_stop_exit=0`、`temporary_root_removed=True`。隔离 PostgreSQL 18.6、真实 Tauri/WebView2、随包 Fastify API、独立 supervisor/Mock Worker 下，三条 Run 分别覆盖：首帧 `id=1` 与 Worker 提交到 `seq=31` 后 Run 页权威 GET/修订刷新；WebView 内受控 Bearer 流 Abort 后从原完整游标补读、离页没有控制 POST；屏蔽两次 SSE 请求时 Run 页仍由 GET 快照从旧序号对应状态校正；只强杀宿主后 API/supervisor/Worker 进程树均停止，旧 ACTIVE epoch 1 与 `seq=1` 保留，重启核对 `seq=31`、IDLE epoch 2、原命令数 1、控制请求数 0。真实 SSE 边界无 Bearer 401、错误 Origin 403、错误 Host 400、跨 Workspace 404；测试仅检查鉴权头存在，URL/前端存储/宿主日志没有令牌，未输出令牌。执行者的[环境、重试史与限制](../../apps/desktop/results/m03-sse-webview-evidence.txt)单独保留。

测试工具 `stop-acceptance-session.ps1` 在包构建后修正了 `-SkipDesktop` 的 PID 0/已停 PG 清理路径；本次独立运行使用修正后的外部测试工具和原封不动的冻结产品包。manifest 准确描述**构建时**脚本输入，不声称当前并行开发工作树可重建同一包。CDP `setOffline(true)` 未切断已建立的 loopback SSE 流，不能据此证明产品缺陷，也不能充当同页自动重连证据；**此片当时未验证**已建立连接强制切断后的同页自动重连，后续[独立反例](#windows-webview2-同页-sse-重连独立检查)单独补证。受控 Abort/补读、SSE 请求屏蔽期间的快照校正和组件/浏览器重连测试是不同证据；完整 G01/G07/G08、审批、取消、LangGraph 与安装总验收仍待后续。

本次状态与验收记录同步后，便携 Node 24.21.0 执行 `scripts/check-docs.mjs` 退出 0；[原始文档检查](evidence/m03/independent-sse-webview-docs.txt)保留。

## Windows WebView2 同页 SSE 重连独立检查

结论：**HOST_SSE_SAME_PAGE_RECONNECT_SLICE_ACCEPTED（仅单一受控 PG 会话故障）**；M03 仍为 IN_PROGRESS。继续使用上节冻结的 Windows release。执行者的[21 项输入清单](../../apps/desktop/results/m03-sse-same-page-inputs.sha256) SHA-256 为 `571bb758e010dfcd62d14d51ff21e97b2f857410dfa704b6b255ca52b668044c`，[6 项原始日志清单](../../apps/desktop/results/m03-sse-same-page-logs.sha256) SHA-256 为 `815851f814082c6fb97040417bab971f4e11ed625a3984e82f5b2f0c6ba122cc`。协调 Agent 在独立复跑前后逐项核对 21/21、6/6 一致；测试入口源码复核确认目标 SSE PG backend 必须同时唯一匹配 relay_app/本隔离数据库/loopback、`listAfter` 查询、被测试持锁会话阻塞及 `backend_start`，终止语句重检同一身份。测试所持两把 PG 锁的释放也在终止语句内重检 PID、启动时间、角色、数据库和已授予的具体锁；身份变化安全失败，保留临时根供核对。

独立执行便携 Node 24.21.0 `apps/desktop/tests/m03-sse-same-page-reconnect.mjs`，参数为上节冻结 EXE/SSE JS/0012 的 SHA-256，退出 0；[完整原始输出](evidence/m03/independent-sse-same-page.txt)末行 `M03_SSE_SAME_PAGE_RECONNECT_REAL_PG=PASS`，`postgres_stop_exit=0`、`temporary_root_removed=True`。真实 WebView2 Run 页原 SSE `after=0` 收到持久 `seq=1` 后，测试只终止被 `run_events` 表锁住的那一个 API PG 轮询会话；原 HTTP 流关闭，RunView 保持原页面，自主且只发一个 `after=1` 请求，宿主/API/supervisor 的 PID 与启动时间不变。路由仅延迟这条已发出的请求；释放表锁和步骤行锁后，真实 Mock Worker 通过既有领域入口提交 `seq=2..31`。放行原请求后，API 从 `after=1` 补历史，页面新增权威 Run GET 并显示修订 v6；控制请求仍为 0，Bearer 未出现在 URL/宿主日志。执行者的[方法、红灯史与范围](../../apps/desktop/results/m03-sse-same-page-evidence.txt)单独保留。

此片证明的是**已建立 loopback SSE 的数据库轮询连接被精确终止时**，产品 RunView 的同页自动重连与持久历史补读；不外推到所有网络故障、权限变化或大输出。前一片 CDP 离线模拟失败不再用作这个判断。完整 G01/G07/G08、审批、取消、LangGraph 与安装交付仍需继续验证。

## Review/Resume 顺序片首轮独立复验：退回修复

首轮执行者冻结的[23 项输入](evidence/m03/order-inputs.sha256) SHA-256 为 `a3a8db409c2525510f7603b3da612fec8d1beab538745dfdbb2da8227ba4f6a0`，[16 项日志](evidence/m03/order-logs.sha256) SHA-256 为 `c2a27aa66798577bb827a27ee8d6b573a19fae5e4a2bca75394274851bd757c1`。协调 Agent 在独立复验前后分别核对 23/23、16/16 一致；定向真实 PG [5/5](evidence/m03/independent-order-targeted.txt)、[全量 205/205](evidence/m03/independent-order-full-pg.txt)、[单测 66/66](evidence/m03/independent-order-unit.txt)、[类型检查](evidence/m03/independent-order-typecheck.txt)、[文档检查](evidence/m03/independent-order-docs.txt)和[包预览](evidence/m03/independent-order-pack.json)均退出 0。全量包装器报告 PG 启停为 0、临时集群已删除；包内含 0013、Worker 与 supervisor 入口。

源码复核随后发现首轮测试未覆盖的高风险控制序列，因此**首轮不予验收**。已批准 `ACTION_APPROVAL` 的 deferred RESUME 在 PAUSE 安全点撤销原操作后仍为 PENDING，手工恢复生成的后继 RESUME 被永久阻塞；若旧 START 在 APPROVE 后先遇到 `COMMAND_SUPERSEDED` 而跳过 pending control 检查，PAUSE/CANCEL/HANDOFF 可长期停留 PENDING。另有 Gateway Worker 在审批过期或 Connection/Permission 变化后可先 claim，随后 admit 拒绝，而未决操作阻止其释放，留下无效果的占有。已向实现者退回，要求真实 PG 红灯、修复与全量复验并重新冻结；上述绿灯仅证明旧场景，不构成该片或 G02/G04/G06 的通过结论。真实 Provider 仍关闭。

## Review/Resume 顺序片修复后独立复验

结论：**BACKEND_ORDER_RESUME_SLICE_ACCEPTED（仅 0013 顺序命令、Review 决定后的 RESUME 与上述控制/Gateway 栅栏）**；M03 整体仍为 IN_PROGRESS。修复版[24 项输入清单](evidence/m03/order-remediation-inputs.sha256) SHA-256 `916f7f36f18be1c2b11ee1ff88df5d7e8fb5ab7cf22c3059b1dd2b1193fbf36d`、[20 项开发日志清单](evidence/m03/order-remediation-logs.sha256) SHA-256 `0cb1cb62365bb1c94e320bec1144bae3325ef6953bbc25b418de6397669d63ce` 在独立复跑前后分别核对 24/24、20/20 未变；0013 migration SHA-256 仍为 `5c1fcc64211a0441f975f864169b3d683d889a3723cb9aa0e7bc2517ceee8ebb`。首轮拒收记录保留在上节，不以修复版结果覆盖原始失败。

| 协调 Agent 独立复跑 | 结果 | 原始输出 |
|---|---|---|
| 隔离真实 PG18.6 顺序/控制定向 | 6/6；PG 启停 0，临时集群删除 | [顺序与安全点](evidence/m03/independent-order-remediation-order.txt) |
| 隔离真实 PG18.6 Gateway 定向 | 19/19；PG 启停 0，临时集群删除 | [审批与准入](evidence/m03/independent-order-remediation-gateway.txt) |
| 隔离真实 PG18.6 恢复定向 | 17/17；PG 启停 0，临时集群删除 | [恢复回归](evidence/m03/independent-order-remediation-recovery.txt) |
| 隔离真实 PG18.6 Worker 分发定向 | 22/22；PG 启停 0，临时集群删除 | [分发回归](evidence/m03/independent-order-remediation-dispatch.txt) |
| 隔离真实 PG18.6 全量 API 集成 | 210/210；build/test/PG 启停均 0，临时集群删除 | [完整回归](evidence/m03/independent-order-remediation-full-pg.txt) |
| API 单测、类型、文档、打包预览 | 66/66，检查均退出 0；包含 0013、Worker、supervisor、Gateway 和控制入口 | [单测](evidence/m03/independent-order-remediation-unit.txt)、[类型](evidence/m03/independent-order-remediation-typecheck.txt)、[文档](evidence/m03/independent-order-remediation-docs.txt)、[打包](evidence/m03/independent-order-remediation-pack.json) |

源码及故障注入复核确认：pending control 先于旧命令被后继取代的判断；PAUSE/CANCEL/HANDOFF 安全点在同一 Task→Run 锁序和事务内撤回仍 PENDING 的批准 RESUME、将原 operation 置为 DENIED 并提交控制，若 outbox 更新失败则整笔回滚。`DONE` 只表示该待发送命令被撤回，不表示工具效果成功。Gateway claim 与 Admit 都重新检查批准期限、Connection 与 Permission；claim 后准入失效时仅在尚无 Invocation/未决外部效果且 Worker 身份与 epoch 一致的条件下释放占有。新测试覆盖失效批准、连接停用、权限撤销、claim→revoke、已 DISPATCHING 不释放和控制竞争。

该片未接 LangGraph/PostgresSaver 生产图，也未完成真实 Windows 从创建到审批、取消与故障恢复的 G01–G08 闭环。ACTION_APPROVAL 的新 RESUME 仍只持久排队，不能据此宣称批准后真实工具效果已执行；真实 Provider 保持关闭。

## React 创建后直达 Task 入口独立检查

结论：**CREATE_TASK_NAVIGATION_SLICE_ACCEPTED（仅创建结果导航）**。真实创建成功结果中的任务 ID 现在链接到 `/tasks/:id`，保留原返回入口与示例模式；不隐式 Delegate 或创建 Run。执行者冻结的 `CreateTaskView.tsx`、`liveCreate.spec.ts`、`workbench-design.md` SHA-256 依次为 `0045fcdf6d608a05ddfd004da2622c9efc431976d174b603f3502933b47fa1d0`、`2c094a3fa4180bcbc527aa89b7c1f60cb9943cbc264043a02868df8cbc1a62ea`、`59b0384ae5700944deecb0390a1415f2902128738a3abeb8d9ac61414890fb69`；协调 Agent 复跑前后核对均一致。

便携 Node 24.21.0 独立复跑[创建组件测试](evidence/m03/independent-create-link-vitest.txt) 4/4、[类型检查](evidence/m03/independent-create-link-typecheck.txt)、[Vite 构建](evidence/m03/independent-create-link-build.txt)及[文档检查](evidence/m03/independent-create-link-docs.txt)均退出 0。组件测试还核对创建流程只有原 `CreateTask`/`MarkTaskReady` POST，没有自动启动 Run。这不证明真实 Windows 从 Task 创建到 Delegate、Review、取消和恢复的组合链；该出口仍待 M03 新 release。

## LangGraph/PostgresSaver 固定 Mock 图独立复验

结论：**BACKEND_RUN_GRAPH_SLICE_ACCEPTED（仅固定 Mock Run 图、官方检查点安装及已列故障窗口）**；M03 整体仍为 IN_PROGRESS。执行者冻结的[37 项输入](evidence/m03/graph-inputs.sha256) SHA-256 为 `85bafed92e57b1fd3aa35921fd5c2ee977864895a54dc9d6623b2b16fee9c365`，[26 项原始日志/包清单](evidence/m03/graph-logs.sha256) SHA-256 为 `a4e779a303b1561055964bc8da0dd6a224f3834f6d1e138fb1a638898ef7ffa8`。协调 Agent 在独立复跑前后核对 37/37、26/26 一致；[复跑后清单核对](evidence/m03/independent-graph-manifests-post.txt)无不匹配。

| 独立命令（项目根目录） | 结果 | 原始输出 |
|---|---|---|
| `run-integration.ps1 -TestFile run-graph` | 隔离真实 PG18.6，7/7；build、业务迁移、图安装、PG 启停均 0，临时集群删除 | [图与崩溃窗口](evidence/m03/independent-graph-run-graph.txt) |
| `run-integration.ps1 -TestFile run-command-order` | 隔离真实 PG18.6，6/6；同样完成迁移、安装与清理 | [Review/RESUME 顺序](evidence/m03/independent-graph-run-command-order.txt) |
| `run-integration.ps1` | 隔离真实 PG18.6，全量 217/217，零失败/跳过；build、业务迁移、图安装、PG 启停均 0，临时集群删除 | [完整 API 回归](evidence/m03/independent-graph-full-pg.txt) |
| API 单测、类型、文档、打包预览 | 66/66；其余检查退出 0；包内含 `install-graph.js`、`graph-checkpoints.js`、`run-graph.js`、Worker/supervisor 与 0013 | [单测](evidence/m03/independent-graph-unit.txt)、[类型](evidence/m03/independent-graph-typecheck.txt)、[文档](evidence/m03/independent-graph-docs.txt)、[包清单](evidence/m03/independent-graph-pack.json) |

源码与真实 PG 故障注入复核确认：业务迁移后由独立 migrator 安装官方 PostgresSaver 1.0.5 固定 `relay_graph_v1` schema；运行角色无 DDL/台账写权，Worker/supervisor 在 claim 前只读校验完整 schema。一个 `StateGraph` 的 `advance` 节点每次只调用一个已有业务步骤；仅 OPEN 验证 Review 保存 interrupt，原决定的 RESUME 唤醒。测试覆盖业务 WAITING_APPROVAL 已提交但 interrupt 前退出、interrupt 已持久而旧 START 未结清、PAUSE 后恢复等待再 APPROVE、RESUME claim 后 checkpoint 前退出、受管效果业务提交后 checkpoint 前退出，以及旧 epoch 不写正常后继 checkpoint；原命令/Review/attempt/operation 身份保持。独立高风险只读审查未发现 P0/P1；其提出的测试包装器在干净 checkout 中先检查 `dist/test` 再 build 的 P2 可用性问题留待后续修复。

官方 Saver 检查点与业务提交不是同一事务，不能据此宣称外部动作恰好一次；epoch 核对到 Saver 写入之间没有跨事务原子证明，旧进程仍须由可信宿主停机并由业务 Owner 按原动作身份核对。该后端分片验收时，`ACTION_APPROVAL` 工具节点、在途模型/子进程取消、任意外部效果的 UNKNOWN 组合、真实 Windows 新图包与 G01–G08 整体出口仍未验收，真实 Provider 保持关闭。执行者早期红灯与误设测试的修正保留在冻结日志中，不将其改写为最终通过证据。

验收通过后仅追记 README、架构、数据库、开发记录和 `CODEX_NEXT_STEP.md` 的验收状态；这些后续文字更新不再等同于执行者输入清单的旧哈希。追记后重新运行[文档检查](evidence/m03/independent-graph-docs-postaccept.txt)，退出 0。

## Windows 新图包 CRITERION Review/RESUME 独立复验

结论：**HOST_REVIEW_RESUME_GRAPH_SLICE_ACCEPTED（仅固定 Mock 创建、SSE、CRITERION Review、宿主重启与原决定 RESUME）**；M03 仍为 IN_PROGRESS。执行者的[冻结包与开发自检证据](../../apps/desktop/results/m03-review-resume-evidence.txt)列出 EXE SHA-256 `090be139084062914b4b85974bfed1d1e779658adfe16d1ac25361091f0a2bed`、manifest SHA-256 `65189178e5d040a2570fbe6c682a0d38f83414e5469ffcfdf8bf3582724a1ea7`、测试脚本 SHA-256 `da83775a6498aa573e2a5ec14d45b079617dd637683626e79c9b5058cde749c4` 和开发绿灯/红灯原始日志；首轮 Windows 长路径构建及 r1–r4 测试失败保留，其中 r3 的孤立 PG 会话另有[精确身份清理补证](../../apps/desktop/results/m03-review-resume-r3-cleanup.log)。协调 Agent 独立复跑前后核对上述冻结输入不变、证据列出的 26 项哈希无不匹配、发行资源 [13,203/13,203 哈希一致](evidence/m03/independent-review-resume-release-hashes-post.txt)，且 129 项 API、55 项 React、20 项桌面源码均与该包 manifest 匹配（均在并行新开发改动前核对）。

便携 Node 24.21.0 独立执行 `apps/desktop/tests/m03-review-resume-webview.mjs`，参数为上述 EXE SHA-256 和 0013 migration SHA-256 `5c1fcc64211a0441f975f864169b3d683d889a3723cb9aa0e7bc2517ceee8ebb`，退出 0；[完整原始输出](evidence/m03/independent-review-resume-webview.txt)末行 `M03_REVIEW_RESUME_WEBVIEW_REAL_PG=PASS`，`postgres_stop_exit=0 temporary_root_removed=True`。隔离 PG18.6 中，真实 WebView2 创建 Project/Task、Delegate 固定 Mock Run，原命令同载荷重放返回同一回执，异载荷冲突。独立 supervisor 启动的 Worker 活跃身份由定向 PG 闩锁捕获；旧宿主/API/supervisor 退出后，Run 保持 WAITING_APPROVAL、事件 seq=31、原 Review/产物/效果不变。重启后的 WebView2 用新 bearer 读取权威快照与 SSE 历史，批准原 `CRITERION` Review；唯一后继 RESUME 按序在 START DONE 后完成，Task 为 DONE、事件 seq=39。根命名空间图 checkpoint 从 6 增至 8、保留一次 interrupt；原 operation `dispatch_count=1` 未重放，5 个唯一步骤尝试、1 个不可变产物版本、1 条 CompletionRecord。旧 bearer 失效，跨 Workspace 查询不可见，URL/storage/宿主日志无 bearer，迁移角色未进入 runtime，进程与临时 PG 清理通过；协调 Agent 再查两次宿主及 API/supervisor/Worker 的 PID、PG backend PID 均不存在，独立会话临时根不存在。

此片不含 `ACTION_APPROVAL` 工具效果、真实 Provider、在途模型/子进程取消、任意外部效果 UNKNOWN 或安装器验证；不能替代完整 G01–G08。下一段开发先补 Mock 工具批准与原动作恢复，再继续取消、Task 产物查询及 React 刷新恢复。真实 Provider 保持关闭。

追记验收状态后运行[文档检查](evidence/m03/independent-review-resume-docs-postaccept.txt)，退出 0。

## Task 产物页保存身份与重开选版修复独立复验

结论：**ARTIFACT_PANEL_P1_SLICE_ACCEPTED（仅 React 交互修复）**；M03 仍为 IN_PROGRESS。受权 Task 产物列表 API 与真实 PG/Chromium 刷新路径尚待当前后端源码稳定后独立复跑，不能由本节推断通过。只读审查发现两项 P1：同页重开沿用上一轮的待接受版本选择；保存响应不明后继续编辑会丢失原 `command_id`。实现者修复并补了不整页刷新的重开及 A→B 草稿/回执反例，开发自检见[原始说明](../../apps/workbench/results/m03-artifact-panel-p1-evidence.txt)。

协调 Agent 在复跑前后核对[3 项输入清单](../../apps/workbench/results/m03-artifact-panel-p1-owned-inputs.sha256) 3/3 不变（清单 SHA-256 `d8774e2b706f8ac8cb3005f7eb6f6523bae012416b7afc3f16c316fd8f2989b9`），[5 项开发日志清单](../../apps/workbench/results/m03-artifact-panel-p1-logs.sha256) 5/5 一致（清单 SHA-256 `b574f50098581c03451216633ebe5e969935e4c143809d26b26a1ed5f9705a53`）。便携 Node 24.21.0 独立复跑定向 [14/14](evidence/m03/independent-artifact-panel-p1-vitest.txt)、全部组件 [133/133](evidence/m03/independent-artifact-panel-p1-full-vitest.txt)，[类型](evidence/m03/independent-artifact-panel-p1-typecheck.txt)、[Vite 构建](evidence/m03/independent-artifact-panel-p1-build.txt)和[文档检查](evidence/m03/independent-artifact-panel-p1-docs.txt)均退出 0。源码复核确认同 Task 新验收轮次清空旧选版与条件勾选；保存命令固定原载荷和 ID，网络不明/503 时保留原 ID，核对 A 后编辑中的 B 仍是草稿，新提交才生成新 ID。当前组件实例之外的未决保存身份持久化不在本片结论内；未构建新 Windows 包，真实 Provider 保持关闭。

## ACTION_APPROVAL 固定 Mock 图后端独立复验

结论：**BACKEND_ACTION_APPROVAL_SLICE_ACCEPTED（仅固定 Mock Gateway 图动作及列明的恢复、控制和双层租约反例）**；M03 仍为 IN_PROGRESS。执行者冻结的[177 项输入](evidence/m03/gateway-action-inputs.sha256) SHA-256 为 `06694d22721a7233f8bb08b2098ec7d15d7f238d50958867e02e36dd15474e0e`，[45 项原始日志](evidence/m03/gateway-action-logs.sha256) SHA-256 为 `3a1dce82c38c009e048516e0fdf4749c3d4a482ee589bf21b38307fa6d20c4ce`；协调 Agent 在独立复验[前](evidence/m03/independent-action-manifests-pre.txt)、[后](evidence/m03/independent-action-manifests-post.txt)逐项重算，177/177 与 45/45 均一致。

| 协调 Agent 独立执行 | 结果 | 原始输出 |
|---|---|---|
| 隔离 PG18.6 固定图 | 26/26，含外层心跳有效而内层 Gateway 失租；构建/迁移/图安装/PG 启停均 0，临时库删除 | [图动作](evidence/m03/independent-action-run-graph.txt) |
| 隔离 PG18.6 Gateway、命令顺序、Verification/P07 | 分别 21/21、7/7、25/25；各自 PG 启停 0、临时库删除 | [Gateway](evidence/m03/independent-action-gateway.txt)、[顺序](evidence/m03/independent-action-run-command-order.txt)、[验证](evidence/m03/independent-action-verification.txt) |
| 隔离 PG18.6 全量 API 集成 | 241/241，零失败/跳过；迁移、图安装、PG 启停均 0，临时库删除 | [全量回归](evidence/m03/independent-action-full-pg.txt) |
| 便携 Node 24.21.0 单测、类型、文档与包预览 | 66/66，其余退出 0；包 129 文件，含 0013、固定图、Worker/supervisor，无编译备份目录 | [单测](evidence/m03/independent-action-unit.txt)、[类型](evidence/m03/independent-action-typecheck.txt)、[文档](evidence/m03/independent-action-docs.txt)、[包状态](evidence/m03/independent-action-pack-status.txt)与[清单](evidence/m03/independent-action-pack.json) |

源码与 PG 事实复核确认：可选冻结 `mock_gateway_action` 只在 DRAFT 后/PERSIST 前进入 Gateway；ASK 保存原 Review/operation 并释放等待槽，只有绑定该决定的新 RESUME 执行一次 Fake marker，DENY 使 Run 失败并归还 Task。批准不等于效果完成；后继 CRITERION Review 不受旧 ACTION RESUME 唤醒。快速批准、旧 START 崩溃、Fake 写入与图 checkpoint 间崩溃、Admit 后结果不明、权限撤销、PAUSE/CANCEL/HANDOFF 竞争、同 Run 错绑 Review 及双 Worker 争领均以原身份测试。P07 预留审批和 P09 直接 Gateway 保留旧调用语义，不生成固定图无法领取的 RESUME；冻结 Mock 的 outbox 故障注入验证决定、业务状态、命令和回执一起回滚。

只读高风险审查发现内层 Gateway lease 过期仍可提交 `SUCCEEDED` 的 P1；执行者在真实 PG 保存[修复前 19/21 红灯](evidence/m03/gateway-inner-lease-red.log)及[修复后 21/21 绿灯](evidence/m03/gateway-inner-lease-green.log)。独立复跑又验证效果前不写 marker、效果后过期保留原 Invocation/operation UNKNOWN 与 QUARANTINED claim；图反例明确观测外层 invocation 仍 ACTIVE，不能用它替代内层租约。检查点、数据库与文件效果不构成原子事务，写入中途失租仍须按同一 operation 核对，不能因 lease 到期释放资源。旧固定图 checkpoint 缺少本版 Review ID/类型，待审旧 Run 升级当前失败关闭；[部署记录](../deployment/local-deployment.md)要求 M07 前用受信迁移或可证明身份的重建及真实升级反例解决。G03 Gateway UNKNOWN 的 Run 查询/UI、G06 在途取消、真实 Windows ACTION 组合和完整 G01–G08 尚未通过；真实 Provider 保持关闭。

## Task 产物历史与 React 刷新恢复独立复验

结论：**TASK_ARTIFACT_HISTORY_SLICE_ACCEPTED（仅真实 API/PG 与 Chromium 浏览器增量）**；不代表 Windows 新发行包或 M03 整体验收。执行者旧[13 项增量输入清单](../../apps/workbench/results/m03-task-artifacts-owned-inputs.sha256)中的 8 项未受后续开发影响；`ArtifactPanel.tsx`、组件测试与工作台设计文档已由上节 P1 修复的[3 项输入清单](../../apps/workbench/results/m03-artifact-panel-p1-owned-inputs.sha256)替代。协调 Agent 对当前组合[逐项核对 8/8 与 3/3](evidence/m03/independent-task-artifacts-combined-inputs.txt)；API 契约和测试计划文档因 ACTION 说明更新，不用旧哈希冒称当前代码输入。

当前组合源码上，协调 Agent 使用另一隔离 PG18.6 复跑 `run-integration.ps1 -SkipBuild -TestFile api-artifacts` [17/17](evidence/m03/independent-task-artifacts-pg-combined.txt)，迁移、图安装、PG 启停均 0，临时库删除。再运行[真实 API + Chromium](evidence/m03/independent-task-artifacts-browser-combined.txt) 1/1，`playwright=0 pg_stop=0 temporary_removed=True`：Project/Task 创建、v1 保存后整页刷新并重建内存连接，向原 Artifact 续写 v2；再次刷新不自动勾选版本，项目当前选用与 Task 本轮接受分别显示，完成和重开后仍按服务端事实恢复。跨 Workspace、同 Task 多 Artifact 各自 v1、旧版已接受而新版最新、重开仅清当前指针、无 Bearer 和列表失败阻断写入由 PG/既有[组件复验](evidence/m03/independent-artifact-panel-p1-full-vitest.txt)共同覆盖。当前组件实例之外的响应不明保存身份持久化仍未验证，真实 WebView2 新包尚待后续组合测试。

追记两项分片结论与 `CODEX_NEXT_STEP.md` 后重新运行[文档检查](evidence/m03/independent-action-docs-postaccept.txt)，退出 0；该追记不回写执行者冻结输入清单。

## Windows ACTION_APPROVAL 首轮组合：拒收并退回修复

新 Windows 开发包已构建，但**HOST_ACTION_APPROVAL 组合未通过**。该包 EXE SHA-256 `764b77efbef3ea1f8e219cf7e0c76655e28b2501934b7e54e5ee9832ccf90792`、manifest `1936b4c9369cf9501f1d66c8fcadec24920714be96c8b7db6f609ee4353e26a7`、随包 0013 `5c1fcc64211a0441f975f864169b3d683d889a3723cb9aa0e7bc2517ceee8ebb`。协调 Agent 对执行者[6 项输入](../../apps/desktop/results/m03-action-diagnostic-inputs.sha256)与[13 项日志](../../apps/desktop/results/m03-action-diagnostic-logs.sha256)分别核对 6/6、13/13 一致，并独立重算[13,204 项随包资源](evidence/m03/independent-action-webview-red-release-hashes.txt)零不匹配、禁带配置 0；[清单核对](evidence/m03/independent-action-webview-red-manifests.txt)保留。

真实 WebView2/隔离 PG 的[r1](../../apps/desktop/results/m03-action-webview-r1.log)和加诊断但未放宽断言的[r2](../../apps/desktop/results/m03-action-webview-r2.log)均退出 1。WebView2 创建 Project/Task、受权 HTTP 冻结 Mock Delegate、ASK 等待、宿主重启、APPROVE、原 operation 的单次 Fake marker 与后继 CRITERION Review 均已实际到达；失败点是 `BUILD_CONTEXT` 与 `DRAFT` 各出现两条不同 ID/key 的成功 attempt。r2 在原 Context manifest 的 Task revision=2、ASK 后 Task revision=3、ACTION RESUME 后 Task revision=5 时，观察到新 Context manifest 绑定 revision=4；Project/Context/Authority revision 未变。`run-steps.ts` 的 Context 失效判断把状态性 Task revision 变化当成内容变化，于 Gateway operation 已 `SUCCEEDED`、候选仍 `PENDING` 时重置已成功的模型步骤。这是实际重做 Context 与 DRAFT，不是测试显示重复或原 START 的无操作重放。两轮的[清理 r1](../../apps/desktop/results/m03-action-webview-r1-cleanup.txt)、[清理 r2](../../apps/desktop/results/m03-action-webview-r2-cleanup.txt)确认 PG stop 0、相关进程/端口消失、临时根删除。

已退回 gpt-6-sol / ultra 后端实现者补真实 PG 红灯、区分 Task 状态修订与真实 Context 输入变化并全量复验；修复后须重新独立验收后端，再重建 Windows 包复跑。上节后端分片结论只绑定其原冻结源码，不延伸到待修的新源码。真实 Provider 仍关闭。

## Windows ACTION Context 修复与新版 Mock 试用链独立复验

结论：**HOST_ACTION_APPROVAL_CONTEXT_SLICE_ACCEPTED**，并在同一新版包复验 **HOST_REVIEW_RESUME_GRAPH_SLICE_ACCEPTED** 的当前代码组合；仅覆盖以下固定 Mock、WebView2、隔离 PG 与明确的恢复窗口。M03 仍为 **IN_PROGRESS**，不从本节推断 G01–G08 整体、真实 Provider 或安装交付已通过。

首轮 r1/r2 拒收证据保留在上节。执行者新增的[状态修订红灯](evidence/m03/backend-action-context-red.txt)先观测 BUILD_CONTEXT/DRAFT 重跑；[来源变化红灯](evidence/m03/backend-gateway-context-red.txt)先观测 ASK 等待期间真正输入改变后仍发生 Fake 写入。修复使纯 Task 状态修订不重建 Context 或 DRAFT；冻结 Mock 工具动作在 Gateway Admit 前复核 DRAFT 使用的 Manifest，来源变化则以原 operation 预效果拒绝，成功效果后的变化也不重做模型步骤。P09 直接 Gateway 入口保持原准入语义，UNKNOWN/DISPATCHING 不用新身份重试。执行者[全量隔离 PG](evidence/m03/backend-gateway-context-full-pg-final.txt) 246/246、零跳过，业务迁移、Graph 安装、PG 启停及临时根清理均成功；单测 66/66、类型检查及新 Windows 构建退出 0。

协调 Agent 独立重算当前 EXE SHA-256 `0537479de765526516001a47587c4c509b9839acbe91605f32b9f9dbd989ff5b`、`desktop-build-manifest.json` SHA-256 `89c73a4dff91f818b7cdd3cca7da4b6895a2f95ad1fd1c9a686f1928738f61a9` 与随包 `0013_m03_run_command_order.sql` SHA-256 `5c1fcc64211a0441f975f864169b3d683d889a3723cb9aa0e7bc2517ceee8ebb`，与执行者自检及独立脚本的冻结参数一致。项目便携 Node 24.21.0 对该包执行两条未放宽断言的真实 Windows 用例：

| 独立复跑 | 观察结果 | 原始输出 |
|---|---|---|
| `run-integration.ps1 -SkipBuild -TestFile run-graph` | 隔离 PG18.6，29/29；含状态性修订、ASK 中来源变化、Gateway 效果后变化；业务迁移/图安装/PG 启停 0，临时根删除 | [Context 与图定向](evidence/m03/independent-context-run-graph-final.txt) |
| `m03-action-approval-webview.mjs <EXE> <0013> <manifest>` | 退出 0，`M03_ACTION_APPROVAL_WEBVIEW_REAL_PG=PASS`；WebView 创建 Project/Task、固定 Mock ASK、宿主重启、原批准、单次 Fake marker、后继 CRITERION Review 与 Task DONE；BUILD_CONTEXT/DRAFT 各 1 条成功 Attempt、1 Invocation/ArtifactVersion/CompletionRecord | [ACTION 组合](evidence/m03/independent-action-webview-final.txt) |
| `m03-review-resume-webview.mjs <EXE> <0013>` | 退出 0，`M03_REVIEW_RESUME_WEBVIEW_REAL_PG=PASS`；WebView 创建/Delegate、宿主重启、原 Review 决定 RESUME、Task DONE，1 ArtifactVersion/CompletionRecord | [CRITERION 组合](evidence/m03/independent-review-resume-webview-final.txt) |

两条 WebView 用例都用独立临时 PG 与受信桌面宿主，观察实际 API/supervisor/Worker；旧 bearer 不复用，迁移角色未进入 runtime。两轮均报告 `postgres_stop_exit=0 temporary_root_removed=True`。本次修复没有业务 migration 或公开 HTTP breaking change，内部 `GATEWAY_CONTEXT_STALE` 只作用于匹配原冻结 operation 的 Mock 图动作。Admit 提交与 Fake 文件写入仍不是原子事务；中途不明效果继续按同一 operation 核对。Manifest 异形字段的逐项完整性反例、Gateway UNKNOWN 的 Run 查询/UI、G06 在途取消、旧 checkpoint 升级和 G01–G08 完整出口仍未覆盖。真实 Provider 保持关闭。

## 2026-09-25 当前 M03 增量与模块出口复验

范围调整前的完整可靠性结论：**CHANGES_REQUESTED，未达到完整 M03 出口**；随后用户将本轮验收收敛为基础功能，当前结论见末节。本轮最初授权验收，覆盖 2026-09-24 后继的 Gateway UNKNOWN 投影、Mock 在途取消、React Mock 动作入口、Manifest 字段反例和结算竞争测试，以及当前 Windows 试用包。测试执行由实际调用的两个 `gpt-6-sol / ultra` 执行者完成；协调 Agent 读取源码、原始日志、探针与包清单后作出以下结论。本轮未修改生产代码、原有测试或重建发行包。

### 本次通过的范围

| 检查 | 本次结果 | 原始证据 |
|---|---|---|
| API 类型、编译、单测 | 类型/编译退出 0；66/66，零跳过 | [类型与单测](evidence/m03/independent-20260925-backend-type-unit.log) |
| 全量真实 PG 集成 | 254/254，零失败/跳过；业务迁移、Graph 安装、PG 启停均 0，临时集群删除 | [全量 PG](evidence/m03/independent-20260925-backend-full-pg.log) |
| React 类型、组件、Chromium | 类型退出 0；136/136 组件、21/21 Chromium | [类型](evidence/m03/independent-20260925-frontend-typecheck.txt)、[组件](evidence/m03/independent-20260925-frontend-vitest.txt)、[Chromium](evidence/m03/independent-20260925-frontend-chromium.txt) |
| 当前 Windows 包一致性 | 208 个源码文件、13,205 个资源，前后零不匹配 | [前验](evidence/m03/independent-20260925-desktop-hashes.txt)、[后验](evidence/m03/independent-20260925-desktop-hashes-post.txt) |
| Windows ACTION_APPROVAL 正常链 | 真实 WebView2/隔离 PG：重启、原审批、单次 Fake 效果、后继 CRITERION Review 和 DONE；1 Invocation、1 ArtifactVersion、1 CompletionRecord，退出 0 | [ACTION](evidence/m03/independent-20260925-desktop-action-webview.txt) |
| Windows CRITERION Review/RESUME | 原 START/RESUME 按序结清，事件 31→39；单次效果、Task DONE，退出 0 | [Review/RESUME](evidence/m03/independent-20260925-desktop-review-resume.txt) |

环境：项目便携 Node 24.21.0、PostgreSQL 18.6、当前 Windows WebView2。EXE SHA-256 `ad4a40cd08502c3a5013f081acc08bce0bed4bfb671991f91609979f52086a25`，manifest SHA-256 `867c2cdfa9ff9a0752073bede4088e36131b43e9fc10c83537564f7c071a8538`，0013 SHA-256 `5c1fcc64211a0441f975f864169b3d683d889a3723cb9aa0e7bc2517ceee8ebb`。三次 Windows 会话（含下述失败分支）均报告 PG stop 0、临时根删除；[后验清理](evidence/m03/independent-20260925-desktop-cleanup.txt)核对相应宿主 PID、PG 端口和会话目录已消失。

确切复跑入口：便携 Node 执行 API `typescript/bin/tsc --noEmit -p tsconfig.json`、`tsc -p tsconfig.json`、`--test dist/test/unit/**/*.test.js`；根目录执行 `powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1`；Workbench 执行 `tsc --noEmit`、`vitest run`、`playwright test`（4173 启动前无既有监听）。Windows 执行 `m03-action-approval-webview.mjs <上述 EXE> <上述 0013> <上述 manifest>` 与 `m03-review-resume-webview.mjs <上述 EXE> <上述 0013>`。

### 退回项

1. **P2：Manifest 正文与摘要失配仍可准入。** `apps/api/src/application/context-fence.ts:34–41` 按保存的 `manifest_hash` 查行，再比较部分身份/版本字段，未重算实际 payload 摘要。沿用现有 15 种完整性用例的异常注入边界，在 ASK 等待期间用迁移角色仅改变 `sources[kind=CONTRACT].content`，保留原 `manifest_hash`；重算摘要明确不同。批准原操作后实际 `marker_exists=true`、operation=`SUCCEEDED`、Invocation=1、Run=`WAITING_APPROVAL`，预期应在效果前拒绝，因此补充探针 **0/1，退出 1**。[红灯日志](evidence/m03/independent-20260925-backend-manifest-probe.log)、[探针片段](evidence/m03/independent-20260925-backend-manifest-probe.js.txt)、[可复跑拼装输入](evidence/m03/independent-20260925-backend-manifest-probe-assembled.js.txt)保留。探针使用 `run-integration.ps1 -SkipBuild -TestFile independent-manifest-probe`；迁移/Graph/PG 启停均 0，临时库删除。此结果是迁移或存储异常的完整性反例，**不是普通 HTTP 客户端可修改 Manifest 或越权的证据**。修复应核对实际规范 payload 的摘要与冻结引用，再执行 freshness 门禁，并补非 TASK 来源正文/契约正文及未篡改对照，不能仅补另一个字段白名单。
2. **P2：UNKNOWN 桌面故障用例无法到达目标场景。** 正常 ACTION 脚本加 `--gateway-unknown` 后退出 1，宿主重启退出 101。[原始失败](evidence/m03/independent-20260925-desktop-gateway-unknown.txt)保留。源码核对：`apps/desktop/tests/m03-action-approval-webview.mjs:170–181` 把 `NODE_ENV` 和 `RELAY_WORKER_TEST_EXIT_AFTER_GATEWAY_ADMIT` 写进临时配置，但 `apps/desktop/src-tauri/src/lib.rs:263–265` 的配置白名单拒绝这两个键。故该路径未到达 UNKNOWN 效果核对/页面断言，不能标为 G03 桌面通过，也不能据此断言 UNKNOWN UI 本身有缺陷。应修复隔离测试的故障注入方式，保留生产宿主配置白名单与子进程环境清理，再复跑原 operation、UNKNOWN、资源隔离和刷新告警。

### G01–G08 覆盖判定与剩余边界

- G01：当前包的创建/委托、同/异载荷命令、宿主/API 重启和事件恢复链通过；后端持久受理与 SSE 回归通过。
- G02：原决定 RESUME、单次工具效果、失效批准及来源版本变化的既有图/PG反例通过；但正文/hash 异常仍有上述漏验，不给完整门禁结论。
- G03：后端原动作恢复、UNKNOWN 查询投影与隔离反例通过；真实 Windows UNKNOWN 分支因脚本失败未验证。
- G04/G05：当前独立 Worker、PG outbox、重复领取、失租、旧 Worker 栅栏及固定图恢复反例随全量回归通过；仅限现有 Mock 与已列组合，不推断任意真实工具或安装升级。
- G06：独立 Worker 的在途 Mock CANCEL/CANCEL_TASK、退出证据与终态不复活通过。结算竞争用例允许 `LOST` 或 `DONE` 两支，本次日志未标明命中支，不能称两种时序均被独立固定验证；已完成后遗留 PENDING 控制用例直接构造仓储状态，不能替代真实完成/取消竞跑。新增 UI 的在途取消尚无本轮 WebView 用例。
- G07：当前 API/SSE/作用域与既有桌面 bearer、URL/storage/日志边界检查通过；结论绑定本次输入和脚本实际覆盖，不宣称新增的全部入口组合均已穷尽。
- G08：连续 seq、跨事务提交顺序、断流补历史、慢消费者/大事件积压和组件快照校正的既有回归通过。不得把 21 个 Chromium 用例视为真实 API/桌面总出口，普通浏览器配置排除了 `real-api.spec.ts`。

当前正常 ACTION WebView 脚本通过受权 **HTTP Delegate** 冻结 Mock 动作（608–617 行），并未点击这次新增的 Task Mock 配置入口；该入口目前只有组件层证据。本次没有新增其真实桌面交互验收，也未执行真实 Provider、任意外部工具、旧 checkpoint 升级或安装交付。修复上述两项、补确定性竞争与缺少的桌面交互后再复验，不能凭 254 个既有绿灯覆盖本轮红灯。

### 固定小样本与输入一致性收尾

另独立执行 `powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-m03-mock-benchmark.ps1`，固定 8 个完成、2 个取消、Delegate 并发 4、Mock 延迟 250 ms，保留 PostgresSaver；没有 Gateway 动作或人工审批。API/supervisor、测试与 PG 启停退出 0、临时集群删除，[测量日志](evidence/m03/independent-20260925-backend-benchmark.log)与[原始结果](evidence/m03/mock-bench-20260925-083623-6b090a0a/summary.json)保留。成功吞吐 0.42/s；受理 P50 15 ms、完成 P50 11,163 ms、取消收敛 P50 79 ms（仅 2 样本）；尾部分位均标记样本不足。这只是固定 Mock 基线，不证明真实模型性能或审批/工具负载能力。

**源码在验收收尾发生漂移，不能把以上成绩转授当前全部工作区。** [测试前 171 项清单](evidence/m03/independent-20260925-backend-source-pre.sha256)与[后验清单](evidence/m03/independent-20260925-backend-source-post.sha256)有 1 项不同：`apps/api/src/worker/run-graph.ts` 从 `2ae05f1da6a0bd95a7274ae694b1abffe310217f0213f9aa218559e9ffca5fea` 变成 `eaeec36fa10cc59df196fb3f670b7f41a912bcc91c0f9daf6edb8147d67ad413`。协调 Agent 于 08:38 后读取到源码新增 `layoutVersion` / `rebuildLayout` 和旧 checkpoint 重建，文件修改时间 08:38:16；当时 `dist/src/worker/run-graph.js` 修改时间 08:36:30，仍是本次测试的旧图实现。该并发新改动保留，不回退、不修复，也不在当前验收通过项内。Windows 包的前后哈希一致性结论绑定其核对时点与冻结 EXE，不能推断后来的源码仍匹配。Manifest 漏验与桌面脚本失败均有原始复现证据；它们不因另一个文件发生改动而自动解决。

文档影响检查：本轮只更新本验收记录与 `CODEX_NEXT_STEP.md`，没有需求、API、数据库、架构或生产行为变更。`node scripts/check-docs.mjs` 的[原始结果](evidence/m03/independent-20260925-docs.txt)保留；其通过只说明文档静态检查，不改变上述退回结论。

### 用户收敛范围后的当前结论

2026-09-25，用户明确“现在只需要保证基础的功能能打通即可”。本轮验收因此只要求基础功能闭环，不继续以完整 G01–G08 或故障注入反例作为本轮放行条件。

**基础功能验收通过，范围绑定上文冻结的 Windows 试用 EXE：**真实 WebView2 创建 Project/Task、委托固定 Mock、等待 CRITERION Review、人工确认、保存产物并使 Task 到达 DONE 已有本轮实跑证据。正常 ACTION_APPROVAL 链也通过，但附加动作经受权 HTTP 配置和委托，新增 Task 动作配置 UI 未另作桌面验收。真实 Provider 不在此次基础 Mock 结论内。

上文两项 P2、UNKNOWN 故障分支、时序分支覆盖与新增附加 UI 用例作为后续可靠性事项保留，不要求现在修复、不阻塞基础闭环。M03 整体仍为 IN_PROGRESS，不能把本轮基础通过写成 G01–G08 或整个产品全部验收通过。验收收尾出现的并发图源码改动仍未验证；本轮结论不自动覆盖它。本轮到此收束，不追加测试或生产修改。
