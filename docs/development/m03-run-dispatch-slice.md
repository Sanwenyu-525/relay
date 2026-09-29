# M03 首片：Run 持久命令与独立 Mock Worker

日期：2026-09-24。状态：首片、失租修复、桌面私有监督协议、逐旧 launch 确认、Run SSE、Review/RESUME 顺序、LangGraph/PostgresSaver 固定图与 ACTION_APPROVAL 节点已由协调 Agent 分片独立验收；新版 Windows 包的 CRITERION/ACTION 两条链也已复验。M03 整体仍未通过。当前正式状态仍看 [CODEX_NEXT_STEP](../../CODEX_NEXT_STEP.md)。

## 目标与取舍

原有 Delegate 已原子建立 Task 执行权、Run/冻结契约与 HTTP 回执，却没有能在 API 退出后驱动独立 Worker 的持久命令。原有 `runs.worker_id/worker_epoch` 每步释放，无法保护整条执行线程。首片保留业务 Run/Task/Review Owner，追加不可变 `run_commands`、可变 `run_command_outbox` 和每 Run 一行的 `run_invocations`。图线程身份固定为 `run_id`；HTTP `command_id` 仍负责请求幂等，内部 command UUID 只负责投递，工具 `operation_id` 仍负责外部效果对账。

Delegate 在原业务事务中增加 START/outbox/invocation，回执仍为旧 202 格式。Worker 从真实 PG 周期扫描并短事务领取，没有进程内队列事实源。`run_invocations.epoch` 在领取时递增，续租、步骤开始、效果派发和步骤提交核对同一 epoch 与数据库租约；租约判断使用 `clock_timestamp()`，避免事务等待期间沿用事务开始时的 `now()`。租约到期使旧 Worker 失去新业务写入资格，但仍占用线程。监督器实际启动子 Worker，观察其 `close` 后才调用原恢复用例处理 `runs.worker_id`、原 `operation_id` 与 UNKNOWN，再将没有未决效果的同一 outbox 重新置 PENDING。监督器死亡且未观察到退出时保留占有，需后续可信停机处置；不伪造“租约过期即进程停止”。单次投递最多推进 32 步，耗尽时显式 BLOCKED，避免未完成 Run 被结清为 DONE。

当前打包入口是 `apps/api/dist/src/worker/supervisor-main.js`（`apps/api/package.json` 的 `files=dist/src,migrations` 覆盖它），另有仅供被监督器启动的 `worker/main.js`。前者使用应用角色 `RELAY_DB_URL`、`RELAY_DATA_ROOT`，不读取迁移凭据、不调用 PostgresSaver `setup()`；启动核对 schema，stdout 发 `supervisor_ready`（含可选 `RELAY_SUPERVISOR_READY_NONCE` 回显和 `nodeVersion`），正常停止 0、配置/schema 错误 2、运行故障 1。宿主可设置 `RELAY_SUPERVISOR_STOP_ON_STDIN_EOF=true`，关闭 stdin 触发优雅停机并等待子 Worker 退出；`--once` 用于隔离进程测试。首片当时桌面组合尚未验收，现已完成第三片的 Windows 宿主组合独立复验。真实 Provider 未启用；固定图基础、可靠事件/SSE、Review/RESUME 顺序与 ACTION_APPROVAL 效果节点已分别通过分片验收，该首片时在途取消尚未开发；后续 G06 开发增量见下文。

## 固定上游机制对照

| 本次需求 | 固定上游源码与测试 | 采用与 Relay 差异 | 本次证据 |
|---|---|---|---|
| PG 并发领取 | `.research/upstream/pg-boss` 提交 `4e05af1eeaad3a645b16e3dd6c389fb4610ee0e9` 的 `src/plans.ts` `fetchNextJob` 使用 `FOR UPDATE ... SKIP LOCKED`；`test/fetchTest.ts` 为领取测试 | 借鉴跳过已锁行与状态二次核对；Relay 先锁已有 Run，再锁 outbox/invocation，不引入 pg-boss schema 或包。持久命令仍与业务 Run 同事务写入 | `run-dispatch.integration.test.ts` 的两个独立监督器竞争，epoch 与首步 Attempt 均只增加一次 |
| 同事务待执行事实 | 同一 pg-boss 提交的 `test/transactionalWorkTest.ts` 检查 handler 写与 job 完成同事务 | Relay 复用 `runIdempotentCommand`/Kysely 事务与迁移 SHA；START/outbox 与 Task/Run/回执一起提交，Worker 不拥有业务完成 | outbox 插入后注入异常，Task/Run/command/outbox/invocation/receipt 整体回滚 |
| 图检查点重放 | M01 已固定的官方 LangGraph.js/PostgresSaver 1.x 实验，见 [M01 记录](m01-stack-baseline.md#checkpoint-安装恢复与保留决定) | 本片尚未接图；只固定将来 `execution_thread_id=run_id` 和业务/图两事务对账边界，不把本片旧固定步骤冒充已接入 LangGraph | 待下一片真实 PG 独立 Worker 图重放测试 |

`.research` 是只读研究缓存，不是生产依赖。固定源码的行为不能替代本工程的 PG/独立进程证据。

## 首片历史自检与边界

- `pnpm --filter @relay-agent/api typecheck`：退出 0；当前系统 pnpm 进程提示 Node 22 engine 警告，真实集成包装器使用仓库便携 Node 24.21.0 编译/运行。
- `powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1 -TestFile cli`：5/5，退出 0；11 份迁移台账预期一致。
- 同命令 `-TestFile api-delegations`：12/12，退出 0；旧 202、重放/异载荷冲突、跨 Workspace 与执行权回归通过。
- 同命令 `-TestFile run-dispatch`：7/7，退出 0。包括 API 重启和丢通知后真实 Worker 领取、旧 Worker 失租仍存活时拒绝迟到写/第二领取（含事务开始后才过期的数据库时钟反例）、子进程退出后原命令 requeue、两个独立监督器竞争、监督器在 CLAIMED 后崩溃且租约过期时仍不重领并报告 `worker_recovery_required`、sidecar nonce 回显/Node 版本与 stdin EOF 停机、32 步边界的缩小反例、同事务回滚。包装器报告编译/测试/PG 启停均 0，临时集群已删除。
- 全量集成：175/175，退出 0；随后仅对 sidecar 启停、租约实时判断及其新测试作修改，使用上述 7/7 定向真实 PG 集成再次验证最终代码。全量包装器报告编译、测试、PG 启停均 0，临时集群已删除。
- `npm pack --dry-run --json`：退出 0，清单包含 `dist/src/worker/main.js`、`supervisor-main.js` 和 `migrations/0011_m03_run_dispatch.sql`；未生成安装包。

## 独立源码审查后的失租修复

原 Worker 在 `claimNextRunCommand` 和 `onClaim` 之后才订阅外部 AbortSignal：启动前已取消仍可领取并执行，领取到订阅之间的取消事件也会丢失。现在先订阅并双重核对已取消状态，领取返回及 `onClaim` 返回后再核对一次；领取期间才取消的命令不启动任何步骤或效果，保留原 claim，交由监督器观察子进程退出后按同一 command 重新排队，不凭取消信号伪造停机证明。

原 PERSIST 流程在单步初始领取后，可长时间读取草稿；之后的 PREPARED 效果意图单独事务插入时未再次核对整线程 invocation。已有 DISPATCHING/UNKNOWN 的效果核对路径也能由过期 Worker 直接改状态。现在 PREPARED 插入和每次效果结果写入都在同一短事务中锁定 Task/Run、核对原单步 Worker/epoch、Task 执行权和当前整线程 epoch/数据库租约。失效调用返回 `INVOCATION_LOST`，不释放尚需可信停机处置的旧 claim。已 DISPATCHING 的外部发布若在迟到检查前实际发生，恢复器仍按原 `operation_id` 核对目标：匹配则登记 SUCCEEDED，损坏则保持 UNKNOWN；不增加 dispatch_count，不换动作 ID。

真实 PG 红灯差分与修复后日志保存在 [M03 证据目录](../testing/evidence/m03/)：

- `remediation-repro-unfenced-start-intent.log`：把修复前的取消订阅与 PREPARED 插入路径短暂恢复后，12 项中 3 项失败、退出 1；预取消被结清 DONE、`onClaim` 取消被结清 DONE、旧 epoch 额外插入一条 PREPARED。差分输入 SHA：`run-command.ts=b88a775c6d9bd5fba419581ab82fec345d75b264baaf1ffdc7ee7b36aa8cfdb3`，`run-steps.ts=9f18b22d0c5c4f6689d7a83657c997917f3eca8b8c5cf0f84567041b7e00cb32`。
- `remediation-repro-unfenced-reconcile.log`：只恢复已有 DISPATCHING 分支的旧无栅栏 `resolveEffect` 后，12 项中 1 项失败、退出 1；旧 epoch 把同一 `operation_id` 从 DISPATCHING 错写 SUCCEEDED。该差分 `run-steps.ts=5e43a4e79fbbc5576a8097c550cc71b1861cf3b55409593d79ba5386d45e07f9`。
- 修复版 `remediation-run-dispatch.log`：12/12、退出 0；`remediation-recovery.log`：16/16、退出 0；`remediation-run-steps.log`：6/6、退出 0；`remediation-full-integration.log`：181/181、退出 0。各包装器均报告 build/test/PG 启停 0、`temporary cluster removed: True`。全量运行后仅整理了 Worker 函数缩进，行为无变化；最终源码将由协调 Agent 按新 SHA 清单独立复跑。

为保留可直接复跑的红灯输入，证据目录还存有三份非产品源码快照：`remediation-red-start.run-command.ts.txt` 与 `remediation-red-start.run-steps.ts.txt` 同时撤去取消订阅与 PREPARED 栅栏；`remediation-red-reconcile.run-steps.ts.txt` 仅撤去已有 DISPATCHING 的结果写栅栏。它们配合同一份冻结的 `run-dispatch.integration.test.ts`（SHA-256 `99983a67c14052c049ab05d58ce9625ef15551c6dd639a25cc5f8d6e4b66a34f`），在 `remediation-repro-archived-start-intent.log` 再次得到 9/12、退出 1，在 `remediation-repro-archived-reconcile.log` 再次得到 11/12、退出 1；build/PG 启停均为 0，临时集群均已删除。原始差分运行的确切临时源码仅保留上列 SHA 与原始日志，归档快照是随后按同一缺陷重建并重跑的输入，不冒充原始字节快照。每次红灯运行后均恢复产品源码；归档文件使用 `.txt` 扩展名，不能被 API 构建或打包选入。

用于压缩竞争窗口的测试在旧回调暂停时，以受控故障注入令数据库租约过期并取得新 epoch；这只验证迟到写的内层栅栏。生产监督器仍必须先取得旧进程已停止的可信证据，不能据此测试推断可以并发运行新旧 Worker。

首片结束时的已知范围：G01 的 SSE 历史重放、G02/G03/G06–G08 尚未实现；G04/G05 证据限首片 Mock 运输与受管发布。监督器对其直接子 Worker 的 `close` 有可信停止观察；监督器本身在 CLAIMED 后崩溃时只报告 `worker_recovery_required`，不能自行证实旧子进程停止，Run 会保持占有等待可信外部处置。当前也没有证明宿主强杀或未来 CLI 子进程树已停止；桌面宿主需另行建立进程树关闭/等待证据。UNKNOWN 时仍必须按原动作核对，不释放冲突写权。

## 桌面私有监督与旧 launch 恢复（第二片）

本节保留已独立验收的第二片在当时的协议与边界；当前扩展见第三片。

第二片沿用 0011 的唯一 Run/command/outbox/invocation 事实，不新增迁移或公开 HTTP 路由。`RELAY_SUPERVISOR_DESKTOP_MODE=true` 时，监督器在构造数据库连接或启动 Worker 前，从 stdin 读取一行严格 UTF-8 JSON：`{nonce,launchId,stoppedLaunches:[{launchId,stopEvidence}]}`。`nonce` 与各 `launchId` 是小写规范 UUID v4；旧 launch 不得重复或等于本次 launch；只能出现这些字段。`stopEvidence` 只能为 `armed_job_terminated_and_active_count_zero` 或 `armed_job_absent_after_last_handle_closed`。首帧上限 1 MiB，旧 launch 最多 4096 个，30 秒内必须结束；错帧以退出码 2 失败，测试中的伪 PG 监听器确认在失败前没有数据库连接或 Worker 事件。后续 stdin 字节或 EOF 停止新领取；已启动 Worker 收到终止信号，监督器等待子进程 `close` 后再退出。

宿主在启动 Node 前读取随包 `supervisor-main.js` 中的精确静态标记 `relay-desktop-supervisor-v1`；源码常量被校验错误路径实际引用。该标记只做版本门。经过首帧验证及 schema readiness 后，stdout 先发 `supervisor_ready`（`nonce,launchId,nodeVersion`），按已证明停机的旧 launch 恢复后发 `dispatch_ready`（`nonce,launchId,requeuedRunIds,blockedRunIds`），然后才允许扫描/启动 Worker。运行期 stdout 只发 `worker_started`、`worker_exit`、`worker_recovery_required`，沿用已有字段。新 Worker ID 固定为 `worker:desktop:<launchId>:<uuid>`。非桌面 `--once` 和原进程测试入口仍保留。

独立审查发现合法首帧可列出大量旧 launch；若 `dispatch_ready` 输出所有 Run UUID，约 1677 项就可能超过宿主单行 64 KiB 上限，导致宿主在核对完成后仍拒绝就绪。现对 stdout 的**实际 UTF-8 JSON 加换行字节数**施加 `<65536` 约束：保留 `requeuedRunIds`、`blockedRunIds` 两个数组供现有 Rust `Vec<String>` 解码，但它们只是各最多 512 项的前缀样本，必要时还会按实测字节再缩小。新增 `requeuedRunCount`、`blockedRunCount` 表示完整处理结果的总数，`runIdsTruncated` 表示任一数组被截断；Rust 当前反序列化默认忽略这些附加字段。计数不限制实际旧 claim 核对，数组不得用于推断未出现的 Run 已无风险。[旧序列化源码](../testing/evidence/m03/desktop-protocol-red-dispatch-ready.ts.txt)为确切非产品差分输入；同一最终 4 项纯协议测试的[红灯](../testing/evidence/m03/desktop-protocol-line-limit-red-final.log)为 0/4、退出 1，[修复版](../testing/evidence/m03/desktop-protocol-line-limit-green-final.log)为 4/4、退出 0，覆盖 1677、4096+4096 和多字节 JSON 实测回退。真实 PG 小样本仍核对原数组及新计数/截断语义。

行长补救最终开发自检：[定向真实 PG](../testing/evidence/m03/desktop-protocol-line-limit-run-dispatch.log) 18/18、[全量真实 PG](../testing/evidence/m03/desktop-protocol-line-limit-full-integration.log) 187/187，命令退出码均 0，build/test/PG 启停均 0，临时集群均已删除；类型检查、文档检查和打包 dry-run 退出 0，打包仍包含新协议 JS、supervisor/Worker 入口与 0011。原 Rust 事件类型仍要求 `requeuedRunIds`/`blockedRunIds` 为 `Vec<String>`，没有拒绝附加 JSON 字段；宿主源码的 `SUPERVISOR_LINE_LIMIT` 为 `64 * 1024`，本片未改 Rust。这是第二片验收前的开发自检，随后已由协调 Agent 独立复验并仅在该片范围内接受。

桌面宿主负责从 Windows Job/ARMED 记录获取整组旧进程已停的 OS 证据；Node 仅通过私有 stdin 接收已验证事实，不能凭自己重启、租约过期或字符串断言推定停机。恢复只扫描对应 `worker:desktop:<旧 launchId>:` 的 ACTIVE/STOP_REQUIRED claim；每 Run 使用 PostgreSQL session advisory 锁串行两个监督器的核对，拿锁后重新检查 worker ID、epoch、command ID 和状态，再调用原 `recoverStoppedWorker`。外部受管目标核对不持有长业务事务；无未决效果时只将原 command 的 outbox 条件式重排。已 `DISPATCHING` 的效果沿原 `operation_id` 核对；完整目标登记 `SUCCEEDED`，损坏/不明目标保持 `UNKNOWN` 且列入 `blockedRunIds`，不换 ID、不重发。对 `SUCCEEDED` 效果但 Attempt 尚为 RUNNING 的提交前崩溃窗口，必须先复核目标 hash/size；复核通过后同一 Attempt/operation 可由下一 invocation 完成业务步骤，否则转 UNKNOWN 阻断。旧 Worker 迟到仍受 Run/epoch 栅栏拒绝。

真实 PG/独立进程反例覆盖错帧零连接、READY 顺序、两个监督器并发仅重排一次、旧 Worker 迟到、已发效果的完整/损坏目标、stdin EOF。迟到 Worker 用例为缩小栅栏窗口而**人工伪造了旧进程已停首帧**，并非生产宿主会给出的 OS 证据；它仅证明即使证明源出错，旧 epoch 业务写仍被拒绝，不能据此宣称允许两代 Worker 同时执行外部效果。恢复误阻断最初在 17 项用例中红灯 16/17；随后把按缺陷重建的 [非产品旧源码快照](../testing/evidence/m03/desktop-protocol-red-recover-run.ts.txt) 与最终 18 项测试组合重跑，[红灯日志](../testing/evidence/m03/desktop-protocol-repro-unverified-succeeded.log) 为 17/18、退出 1。快照不是最初运行的字节副本。恢复产品修复版后，定向 [Run 分发日志](../testing/evidence/m03/desktop-protocol-run-dispatch.log) 为 18/18、[原恢复日志](../testing/evidence/m03/desktop-protocol-recovery.log) 为 16/16、[全量日志](../testing/evidence/m03/desktop-protocol-full-integration.log) 为 187/187，三次包装器退出 0，build/test/PG 启停均 0，临时 PG 集群已删除。类型检查、文档检查与打包 dry-run 均退出 0，打包清单包含 supervisor/Worker JS 入口与 0011 migration。这是第二片开发自检记录，独立验收结论由协调 Agent 的验收文档保存。

第二片验收时的剩余边界：宿主 Job 的真实强杀/重启证明与私有帧组合尚待端到端独立复验；未来 CLI/外部工具子进程树未由本 Mock Worker 测试覆盖。ARMED 记录由宿主管理，后端不会删除；积累超过 4096 或 1 MiB 时拒绝首帧。此时 `dispatch_ready` **不是所有旧 ARMED 可删的持久确认**：无单步 claim 的阻断 Run 不一定写 `RUN_WORKER_FENCED`，BLOCKED/UNKNOWN invocation 的 `stop_evidence` 不一定已入库，下次监督器仍依赖宿主重新提供该旧 launch 的停机依据。截断 Run 样本不能决定哪些 launch 可清理。宿主等待第二阶段事件固定 30 秒，众多旧 launch 或慢内容核对可能超时并安全失败。后续第三片的逐 launch ack 语义见下一节；G01 的 SSE 历史重放、G02/G03/G06–G08 仍未实现，G04/G05 不因本片自测宣称完整通过。没有 M03 整体验收前不进入 M04 真实 Provider。

## 逐旧 launch 恢复确认（第三片）

第二片的 `dispatch_ready` Run ID 数组只是有界样本，无法指出哪个旧 launch 仍有占有；`RUN_WORKER_FENCED` 活动也只在存在单步 `runs.worker_id` 时记录，不能从活动缺失推断没有残留。第三片不新增表或更改公开 HTTP，而是在每个输入 `stoppedLaunches` 的**全部**旧 claim 完成原有核对/提交后，重新查询 PostgreSQL 中 `worker:desktop:<该 launchId>:` 的 ACTIVE/STOP_REQUIRED invocation 数，再发一行有界 `launch_recovery_ack {nonce,launchId,retainedClaims}`。PG `count(*)::bigint` 在转为 JSON 数值前须是非负、安全整数；超界或查询失败即停止并不发该 launch ack/最终 ready。该计数不从首次扫描、`requeuedRunIds` 或 `blockedRunIds` 推导。两个监督器并发时，各自拿原 Run 恢复锁后再查询；过时扫描不产生错误重排。

stdout 顺序为 `supervisor_ready`、按首帧顺序的零个或多个 `launch_recovery_ack`、最后 `dispatch_ready`，之后才允许新 Worker 领取。`retainedClaims=0` 表示宿主已证明旧 Job 停止且该 launch 处理后没有持久活跃 claim；宿主**只能在最终 `dispatch_ready` 到达后**删除对应旧 ARMED。`retainedClaims>0`（包括 UNKNOWN、损坏受管目标、畸形旧 claim）必须保留 ARMED 以备再次核对。若第 N 个 launch 核对异常或 stdin EOF/停止，不能发它的 ack 或最终 ready；前 N−1 个 ack 仅是进度，不能单独触发清理。BLOCKED invocation 的 `stop_evidence` 仍不保证入库，因此 retained>0 的宿主停机依据不能丢。原 `dispatch_ready` 两个 Run ID 数组仍只作样本，不成为按 launch 的清理依据。后续 Windows 宿主组合片已按 ack 与最终 ready 处理旧 ARMED；后端不直接修改宿主记录。

真实 PG/独立进程反例覆盖无旧 claim 的有序零计数 ack、可重排 claim 的零计数、两个监督器并发、损坏目标转 UNKNOWN 后 retained=1、没有 `RUN_WORKER_FENCED` 活动仍 retained=1、同一 launch 两 claim 在受控 PG 行锁等待期间不提前 ack、监督器被杀后按原 launch 重启、EOF 和核对异常不发未完成 ack/最终 ready。最终定向回归中受控行锁等待 1201 ms 无 ack；旧宿主 pre-ack [32 claim / 1981 ms 样本](../../apps/desktop/results/m03-host-real-pg-Clean-32.evidence.txt)也远未逼近其当时的 30 秒等待。Windows 宿主组合片现采用第二阶段 120 秒空闲及 20 分钟总时限；这些样本仍不能证明更大或单个慢 launch 必定在时限内完成。本片不添加额外进度帧；若后续真实 backlog 超时，须协同有界进度/等待策略，不能通过提前发最终 ready 绕开核对。

开发自检：加入反例后，旧代码的首次[红灯日志](../testing/evidence/m03/desktop-launch-ack-red.log)为 16/19、退出 1；补齐测试后，将保存的旧 `supervisor-main.ts` 与 repository 源码短暂替换到产品位置得到[最终红灯日志](../testing/evidence/m03/desktop-launch-ack-red-final.log)，15/22、退出 1（首个缺 ack 的失败使部分后续测试级联失败），随即恢复修复版。修复版[定向真实 PG 日志](../testing/evidence/m03/desktop-launch-ack-run-dispatch-final.log) 22/22、[全量真实 PG 日志](../testing/evidence/m03/desktop-launch-ack-full-integration.log) 191/191，包装器各退出 0，build/test/PG 启停均为 0，临时 PG 集群均已删除。新增[纯协议单测](../testing/evidence/m03/desktop-launch-ack-unit.log) 5/5；[typecheck](../testing/evidence/m03/desktop-launch-ack-typecheck.log)、[文档检查](../testing/evidence/m03/desktop-launch-ack-doccheck.log)与[打包 dry-run](../testing/evidence/m03/desktop-launch-ack-pack.json)均退出 0，打包清单包含监督器和 Worker JS 入口。其后的独立后端及 Windows 宿主组合验收已通过；该结论不扩大为 M03 整体验收。

## Run SSE 后端片（第四片，已独立验收）

既有 Run API 只有权威快照，React 需要断线后按每 Run 游标补齐变更提示。追加 [0012 migration](../../apps/api/migrations/0012_m03_run_events.sql) 的 `run_events`，业务表 AFTER trigger 在原事务中先锁 Run、再以该 Run 已提交最大序号加一；回滚同时撤销事实与提示，不使用会留下空洞的 PostgreSQL sequence。触发器只追加 `RUN_CHANGED|STEP_CHANGED|ATTEMPT_CHANGED|REVIEW_CHANGED|CONTROL_CHANGED|EFFECT_CHANGED` 小型提示，不承担业务状态写入。旧 Run 不回填；初次连接仍须 GET Run 权威快照。事件目前不裁剪，未来必须先设计游标保留/淘汰协议，不能直接删历史。`relay_app` 对事件只有 SELECT/INSERT，无 UPDATE/DELETE。

触发源与原锁序逐项核对：Run 创建/状态写入由 Delegate 或应用用例持 Task→Run；Step 和 Attempt 推进、Review 决定、Control 请求/应用已有 Task→Run 前置锁；Effect 的 PREPARED/派发/结果写入也先核对 Task→Run。原 `recoverStoppedWorker` 的两个直接 `resolveEffect` 分支曾能先锁 Effect，再由新触发器反向等待 Run；本片在这两处分支改成先锁 Task→Run 再写 Effect。真实 PG 受控竞争让另一事务持 Task→Run 后等待 Effect，证实该恢复路径不会反向死锁。触发器只在 UI 可见字段真实变化时发：无变化 UPDATE、Run/Attempt 租约续期不会产生事件；`run_invocations` 与 outbox 运输状态当前不在 Run HTTP 快照中，因此不触发。State Review 的 `run_id=NULL` 也不发 Run 提示。

公开 GET `/api/v1/workspaces/:workspace_id/runs/:run_id/events` 在 Bearer、回环 Host/允许 Origin 与 Run Workspace 检查后建立 SSE。`after` 优先于 `Last-Event-ID`，两者缺省为 0；非法、未来或重复游标返回 422。每个帧的 `id` 是连续 Run seq，`data` 只含 kind；服务端每秒补查 PG 已提交记录，不依赖可能丢失的通知；每批最多 100 条，写入背压后暂停读、最多等待 5 秒 drain，空闲约 15 秒发无 ID 心跳。断开连接不等于取消 Run。详情见 [API 契约 §10.17](../api/http-command-contract.md#1017-m03-run-sse-后端片2026-09-24已独立验收)；这只提供刷新提示，不把历史帧当作业务快照。

定向真实 PG/HTTP 反例涵盖同事务回滚无缺号、双事务提交顺序、无变化/lease 不发事件、应用角色不可改写、无 Bearer/非法 Host/Origin/跨 Workspace、`after`/`Last-Event-ID`、单独 API 与 Worker 进程、API 重启后的历史补查、控制安全点与断连重连。受控写入流使 `write(false)` 恒不 drain，5 秒后关闭；真实 socket 暂停读取时确认大量已提交历史不会阻塞另一 PG 写入或 GET，并在客户端主动断连后从原游标重取。原始 50,000/250,000 条慢读 socket 超时试验没有稳定观察到内核触发 `write(false)`，日志保留为测试方法限制，不能以它们证明 5 秒关闭行为；确定性写入流反例专门验证该分支。SSE 片验收时仍未接入 LangGraph/PostgresSaver、审批后 RESUME、在途模型取消或真实 Provider；此后审批顺序片的进展见下一节，G01/G07/G08 及 M03 整体仍需后续独立验收。

开发自检的[迁移定向日志](../testing/evidence/m03/sse-migration-targeted.log)为 7/7、[SSE 定向日志](../testing/evidence/m03/sse-run-events-final.log)为 7/7、[恢复锁序日志](../testing/evidence/m03/sse-recovery-lock-order.log)为 17/17、[全量真实 PG 日志](../testing/evidence/m03/sse-full-integration-final.log)为 199/199；各包装器退出 0，build/test/PG 启停均 0，临时集群均已删除。[纯背压单测](../testing/evidence/m03/sse-unit-final.log) 4/4，其中永久不 drain 的可控流在 5006 ms 内返回关闭；typecheck、文档检查及 pack dry-run 退出 0，包清单包含 0012、SSE API/repository JS、supervisor/Worker 入口。首次全量[红灯](../testing/evidence/m03/sse-full-integration-initial.log)为 196/199，原因仅是迁移测试预期还硬编码 11 份文件；同步 0012 后重新全量通过。较早慢读 socket 的[50,000 条红灯](../testing/evidence/m03/sse-run-events-backpressure-socket.log)与[250,000 条红灯](../testing/evidence/m03/sse-run-events-large-backpressure.log)是无法在给定时限强制内核背压的试验，不把超时伪称产品已证实故障或后续绿灯证明实际 socket 必于 5 秒关闭。此后协调 Agent 已独立复验并仅接受该 SSE 后端片，不把它扩大为 G01/G07/G08 或 M03 整体通过。

## Review/Resume 持久顺序片（第五片，已分片独立验收）

0013 为 `run_commands` 增加每 Run 的 `ordinal` 与可空唯一 `review_decision_id`。新命令沿 Task→Run 锁顺序分配序号，Review 决定、业务状态、绑定决定的 RESUME、outbox、活动和 HTTP 回执在同一短事务；手工 PAUSED→可运行状态同样写 RESUME。PAUSED→WAITING_APPROVAL 不会生成可运行命令。轮询与领取两处都拒绝越过未结清前驱；BLOCKED 前驱不能靠较新的命令绕开。ACTION_APPROVAL 的批准仅形成绑定原决定的持久等待意图，固定 Mock Worker 以 Review 类型 gate 排除；真正 Gateway 效果仍须在未来唯一图节点按原 operation_id、目标/hash 和连接/策略版本重新准入，不能把 200 Review 回执写成效果已执行。

真实 PG 红灯揭示两个不同的旧 START 竞跑。其一，固定 Worker 在 VERIFY 写入 WAITING_APPROVAL 后仍循环，审批若在下轮前提交，旧 START 会执行 COMPLETE；[红灯](../testing/evidence/m03/order-fast-approval-red.log)为 0/1、退出 1，新增等待安全点 barrier 后同例绿灯。其二，旧 START 在写入 Review 后、结清 outbox 前子进程退出，监督器在观察到 `close` 后重排原命令；若审批已提交，重启 Worker 可用旧 START 执行 COMPLETE。[独立子进程红灯](../testing/evidence/m03/order-restarted-start-red.log)为 4/5、退出 1，实际是 COMPLETED 而预期 VERIFYING。修复是在 `advanceRunStep` 的 Task→Run 短事务内用当前 invocation 的 command ordinal 检查已提交的后继命令，发现后只结清旧投递；[绿灯](../testing/evidence/m03/order-restarted-start-green-initial.log)为 5/5、退出 0。两次红灯包装器均正常停止并删除临时 PG 集群，不代表真实 Provider 或 LangGraph 已接入。

定向反例还覆盖前驱 PENDING/CLAIMED/BLOCKED 的顺序、Review/RESUME/outbox/回执故障注入整体回滚、同 HTTP `command_id` 重放一条 RESUME、跨 Workspace Review 404、拒绝/过期批准无 RESUME、PAUSED→WAITING_APPROVAL 无假入队，以及已 DISPATCHING 的原 Gateway operation 在批准后仍只按原身份准入。应用角色不能改写 `run_commands`，同一 Review 决定的第二条 RESUME 由唯一约束拒绝。现有 P09 内部显式 Gateway 入口仍能按原身份准入；本片只阻止固定 Mock Worker 把持久 RESUME 当作已接通的运行图节点。

开发自检：[最终顺序定向真实 PG](../testing/evidence/m03/order-targeted-final.log) 5/5、[Gateway 定向](../testing/evidence/m03/order-gateway-expanded.log) 15/15、[恢复定向](../testing/evidence/m03/order-recovery-targeted.log) 17/17、[Run 分发/迟到 Worker 定向](../testing/evidence/m03/order-run-dispatch-regression.log) 22/22、[最终全量真实 PG](../testing/evidence/m03/order-full-integration-final.log) 205/205；各包装器退出 0，build（SkipBuild 一次除外）、test、PG 启停均为 0，临时集群均已删除。[单测](../testing/evidence/m03/order-unit-final.log) 66/66，[typecheck](../testing/evidence/m03/order-typecheck-final.log)与[文档检查](../testing/evidence/m03/order-doccheck-final.log)均退出 0。[`npm pack --dry-run --json`](../testing/evidence/m03/order-pack.json) 退出 0，清单含 0013、Worker 与 supervisor JS；先误用 `pnpm pack --dry-run` 的[工具命令失败日志](../testing/evidence/m03/order-pack-initial.json)退出 1，不计产品测试红灯。最终输入和原始日志分别由[输入 SHA 清单](../testing/evidence/m03/order-inputs.sha256)与[日志 SHA 清单](../testing/evidence/m03/order-logs.sha256)冻结。此片不接 LangGraph/PostgresSaver、正式 ACTION_APPROVAL 效果节点、在途模型取消或真实 Provider，故不能自行宣称 G01–G08 或 M03 整体通过；独立验收由协调 Agent 决定。

### 0013 独立审查后的安全点修复（已独立验收）

旧版真实 PG 反例发现三处 P1：已批准 ACTION_APPROVAL 的 deferred RESUME 在 PAUSE 后仍 PENDING，后续手工 RESUME 被前驱顺序门禁永久挡住；旧 START 已有后继批准时先返回 `COMMAND_SUPERSEDED`，跳过 PAUSE/CANCEL/HANDOFF 的 `applySafeControl`；Gateway 批准领取不查到期/Connection/Permission，领取后至 Admit 前撤权还会因未决 operation 留住 `runs.worker_id`。对应[旧投递/Gateway 红灯](../testing/evidence/m03/order-remediation-gateway-red-expanded.log)为 15/18，[控制顺序红灯](../testing/evidence/m03/order-remediation-order-red.log)包含预期的 `COMMAND_SUPERSEDED`；该次测试失败后未 await 受控旧 Worker，污染后续四例，随后修正测试 `finally` 清理。[首次修复后顺序运行](../testing/evidence/m03/order-remediation-order-green-initial.log) 5/6 的唯一失败是新增测试错用不存在的 `created_at`，应读 `requested_at`，不计产品失败。原有 0013 冻结输入和日志不覆盖。

修复保持 Task→Run 锁序和原 operation_id：安全点先处理 PENDING control，再判断旧命令被后继取代；`applySafeControl` 在原业务事务中锁定原 Review 决定绑定的 deferred outbox，仅撤回仍 PENDING 的投递，再 DENIED 原操作并提交控制。若 outbox 更新故障，operation/Run/control 一并回滚；Review 决定与不可变命令原件保留，DONE 不代表效果成功。Gateway claim 与 Admit 共用有效批准、连接和策略版本核对；两事务之间发生撤权时，只有原 worker/epoch 仍持有 WAITING_APPROVAL 且无 Invocation/未决效果，拒绝 Admit 才释放该 claim，随后已有控制可安全应用。DISPATCHING/UNKNOWN 不因此释放。定向修复绿灯与最终全量结果在本次新冻结清单中单独记录，不修改拒收前的日志。

修复自检命令均在 `D:/Develop/Relay-Agent` 执行：`powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1 -TestFile gateway` [19/19](../testing/evidence/m03/order-remediation-gateway-final-v2.log)，同命令以 `-TestFile run-command-order` [6/6](../testing/evidence/m03/order-remediation-order-green.log)，`-SkipBuild -TestFile recovery` [17/17](../testing/evidence/m03/order-remediation-recovery-final.log)，`-SkipBuild -TestFile run-dispatch` [22/22](../testing/evidence/m03/order-remediation-run-dispatch-final.log)，不带 `-TestFile` 的[最终全量](../testing/evidence/m03/order-remediation-full-integration-final.log) 210/210。每次包装器退出 0，PG 启停 0，临时目录删除 `True`。[单测](../testing/evidence/m03/order-remediation-unit.log) 66/66，[typecheck](../testing/evidence/m03/order-remediation-typecheck-final.log)、[文档检查](../testing/evidence/m03/order-remediation-doccheck-final.log)、[`npm pack --dry-run --json`](../testing/evidence/m03/order-remediation-pack-final.json)退出 0；包清单含 0013、Worker 与 supervisor JS。失效批准的后续收敛通过现有 PAUSE/CANCEL/HANDOFF，不自动生成新 Review；正式 LangGraph/Gateway ACTION_APPROVAL 节点和真实 Provider 仍未接入，M03/G02/G04/G05 整体结论待独立验收。

## 官方 LangGraph/PostgresSaver 固定 Mock 图（第六片，后端分片已独立验收）

本基础片沿用 0011–0013 的 Run/command/outbox/invocation 事实，不新增业务迁移或第二套 Run 状态。锁定 `@langchain/langgraph` 1.4.17、`@langchain/core` 1.2.12、`@langchain/langgraph-checkpoint` 1.1.5 与官方 `@langchain/langgraph-checkpoint-postgres` 1.0.5。一个 `StateGraph` 的 `advance` 节点每次只调一次既有 `advanceRunStep`；旧 Worker 的显式 32 步循环已删除。32 次仍是单次交付预算，非终态耗尽标 BLOCKED，恰在预算边界进入 COMPLETED/FAILED/CANCELLED 则正常结清。此基础片只有 OPEN 的 CRITERION/RETRY_BUDGET/CHECKER_RETRY Review 进入 `awaitCommand` interrupt；当时尚不能领取 ACTION_APPROVAL deferred RESUME 或执行工具效果。后续本轮固定 Mock Gateway 接入见下节。图只保存 Run ID、上次返回类型与 Run 路由提示，Task/Run/Review/Artifact/Gateway 仍由原应用用例拥有。

M01 固定版本实测显示根图忽略传入非空 `checkpoint_ns` 并实际写入空 namespace，因此使用固定物理 `relay_graph_v1` schema 隔离这版图契约，`thread_id=run_id`。受信 `install-graph.js` 以 migrator URL 在业务迁移之后单独调用官方 `setup()`；会话 advisory lock 跨越 Saver 自身连接上的 DDL、版本核对和最小 GRANT。Saver 整数版本预期恰为 0–4；`relay_app` 只能读台账和读写三张 checkpoint 表，不能 DDL 或改台账。Worker/supervisor 启动前只读核对这些条件，并执行官方 `getTuple` 的空保留 thread 查询，缺表或损坏列在领取前失败。测试包装器与每个启动独立 Worker 的临时数据库 fixture 都显式先跑业务迁移、再安装 Graph；没有把安装藏在通用 `openDatabase`、API 或 Worker。

业务提交与官方 Saver checkpoint 不是一个事务，图使用同步持久模式 `durability: 'sync'`。独立进程故障点覆盖：VERIFY 写出 WAITING_APPROVAL 后而 interrupt 前退出（该 Run 的 Saver `__interrupt__` 写入数实测为 0）；interrupt 已存而 START 尚未结清（`__interrupt__` 写入数大于 0）；RESUME 已领而唤醒 checkpoint 前退出；PERSIST_CANDIDATE 业务提交后而图 checkpoint 前退出。可信停止后的重派使用原 command/Review 决定/step attempt/`operation_id`，不追加第二个 ArtifactVersion 或重复派发效果。失去 invocation 的旧节点在写正常后继 checkpoint 前再次核对 epoch；测试用受控假停机置换 epoch 仅验证迟到栅栏，**不**表示生产可依据租约到期证明旧进程已停止。官方 Saver 写入与 Relay invocation 栅栏并非同一事务，极窄的核对后至 Saver 写入间竞争没有跨数据库原子证明；业务事实与效果仍须以原 Owner 和停机/恢复协议为准，不能凭 checkpoint 授权第二个效果。

对“PAUSE→恢复 Review 等待→批准会被未结 START 永久挡住”的审查假设，真实 PG/子进程试验表明批准将 Run 转回可领取的 VERIFYING：第一次 Worker 只确认原 interrupt 并将 START 结为 DONE，第二次 Worker 才领取绑定原决定的 RESUME；旧 START 不执行 COMPLETE，效果 `operation_id/dispatch_count` 未变。最初单次 Worker 必须完成的[红灯](../testing/evidence/m03/graph-pause-interrupt-red.log)是测试预期错误，修正为逐投递观察后的[绿灯](../testing/evidence/m03/graph-pause-interrupt-green.log)为 7/7，产品源码无需针对该假设变更。

本基础片当时仍不覆盖 ACTION_APPROVAL 真正工具节点、在途模型/工具取消与完成竞争、真实 Provider、任意进程树停机证明或新图包的 Windows 组合发布；这些不能由固定 Mock 图的局部通过外推为 G01–G08 或 M03 整体通过。ACTION_APPROVAL 的后续实现见下节。

开发自检在隔离 PostgreSQL 18.6、Node 24.21.0 上运行。图专属故障反例[最终 7/7](../testing/evidence/m03/graph-checkpoint-window-final.log)，原有命令顺序含 interrupt 前观察[6/6](../testing/evidence/m03/graph-order-checkpoint-final.log)、分发[22/22](../testing/evidence/m03/graph-dispatch-initial.log)，装配修正后的 CLI [5/5](../testing/evidence/m03/graph-cli-recheck.log)与 SSE 独立 Worker [7/7](../testing/evidence/m03/graph-events-recheck.log) 均退出 0。[最终全量真实 PG](../testing/evidence/m03/graph-full-integration-frozen.log) 217/217，包装器、build、业务迁移、Graph 安装、PG 启停退出码均为 0，临时集群删除 `True`；[单测](../testing/evidence/m03/graph-unit-final.log) 66/66、[typecheck](../testing/evidence/m03/graph-typecheck-final.log)、[文档检查](../testing/evidence/m03/graph-doccheck-complete.log)、[`npm pack --dry-run --json`](../testing/evidence/m03/graph-pack-frozen.json) 退出 0。包清单含 `dist/src/cli/install-graph.js`、Graph/readiness、Worker 与 supervisor 入口。

首次[图定向红灯](../testing/evidence/m03/graph-new-initial.log) 3/4 来自测试查询错用不存在的 `run_effect_actions.id`，修正为 `operation_id` 后通过；首次[全量红灯](../testing/evidence/m03/graph-full-integration-initial.log) 214/216 是包装器把临时 `RELAY_MIGRATION_DB_URL` 泄入 CLI 缺变量负例、以及 SSE 临时数据库启动独立 Worker 前未显式安装 Graph。包装器现先做业务迁移、再 Graph 安装并恢复调用方原环境变量；CLI 负例显式清除子进程继承值，SSE fixture 显式安装。三份初始红灯均保留，不当作产品图状态机故障或绿灯证据。全部测试使用临时数据库/集群，未使用真实 Provider。

当前分片供独立复验的[输入 SHA-256 清单](../testing/evidence/m03/graph-inputs.sha256)与[原始日志 SHA-256 清单](../testing/evidence/m03/graph-logs.sha256)分开冻结。清单只绑定本片与前一已验收片的相关输入，不代表尚未运行的 Windows 新图包或完整 M03 已通过。

## 固定 Mock Gateway 的 ACTION_APPROVAL 图动作（已分片独立验收）

本轮仍只有一个官方 `StateGraph` 和原 Task/Run/Gateway Owner；不新增 migration、通用工具路由或真实 Provider。可选 Delegate `mock_gateway_action` 在原 HTTP `command_id` 事务中冻结 WRITE_MARKER 的连接、资源、目标、内容及唯一 `operation_id`，旧客户端不传该字段时固定 Markdown 路径不变。图在 DRAFT 后、PERSIST_CANDIDATE 前进入 `gatewayAction`：ASK 先持久化 Gateway operation/Review，再使旧 START 在 ACTION interrupt 处结清；APPROVE 只保存原决定与唯一 RESUME，批准 200 回执不代表效果完成。Gateway Prepare/Claim/Admit 和 Fake 写入前同时检查原外层 command/epoch 与内层 worker/epoch，并重核目标/hash、Connection、Permission、政策和批准有效期。DENY 与可证明尚无 Invocation/效果的准入前撤权使原 operation DENIED、Run FAILED、Task READY；已 DISPATCHING/UNKNOWN 不作无效果拒绝，也不换 ID 盲重试。

内层 `runs.worker_lease_until` 与外层 command invocation 的租约独立。Admit 提交后、Fake adapter 前再次在短 Task→Run 事务检查内层租约、worker/epoch、资源 claim 和外层 invocation；失效则不调用 adapter，原已 DISPATCHING 的 Invocation 记 UNKNOWN、原资源 claim 隔离。Fake 效果后结算也查内层租约；若此时已过期，即使 marker 可见也只记原 Invocation/operation UNKNOWN、隔离原 claim，待可信停机后按同一 `operation_id` 核对，不能把外层心跳当内层续租。检查与文件写入仍非一个事务；写入中途失租的保守结果是 UNKNOWN，不以租约过期授权第二个 Worker 抢占。

图 interrupt 现在绑定确切 Review ID、种类及 ACTION 的冻结 operation ID；旧 ACTION RESUME 遇到后继 CRITERION Review 只能确认旧投递，不得借旧批准唤醒新人工检查。效果已按原身份 SUCCEEDED 时，即使批准随后到期，恢复只读核对既有结果并推进后继步骤，不用过期授权发出新效果。可信旧 Worker 退出后 supervisor 先按原 PREPARED/DISPATCHING/UNKNOWN Invocation 对账，NOT_EXECUTED 且仍获授权、无 PENDING control 才以原 operation 重试；UNKNOWN 保持隔离。PAUSE/CANCEL/HANDOFF 在外层 invocation ACTIVE 时仍显示 PENDING，旧投递结清释放后尝试应用；若进程恰在这两个短事务之间退出，supervisor 从 PG 分页扫描空闲的 PENDING control，按 Task→Run 锁重新裁决。已撤销必需动作的 PAUSED Run 手工恢复返回 409，而不会变成没有后继命令的 RUNNING。

真实 PG 红灯依次留下[初始工具路径 7/8](../testing/evidence/m03/gateway-graph-red-pg.log)、[ASK 提交后崩溃顺序 8/9](../testing/evidence/m03/gateway-graph-crash-red-pg.log)、[后继 Review 错唤醒 10/11](../testing/evidence/m03/gateway-graph-review-race-red-pg.log)、[撤权拒绝 16/17](../testing/evidence/m03/gateway-graph-revocation-red-pg.log)、[控制/已 PREPARED 竞争 18/20](../testing/evidence/m03/gateway-graph-prepared-control-red-pg.log)。旧 Gateway 回归首轮仍断言“未来图节点尚未接入，ACTION RESUME 不可领取”，与本轮正式图入口相冲突；修订该断言时保留唯一批准命令、旧 epoch 拒绝、原目标和单次批准绑定观察。[旧命令顺序首轮红灯](../testing/evidence/m03/gateway-action-run-command-order-regression.log)还揭示外层 ACTIVE 时控制应先保持 PENDING，而结清后必须自动收敛；旧失败留下的待处理命令使该轮后续四例级联，修复后的独立监督器重启反例从无 PENDING outbox 的 PG 状态收敛控制。红灯不作为成功证据。

[首次全量 PG](../testing/evidence/m03/gateway-action-full-integration.log) 233/235、退出 1：控制竞跑测试在 `settleRunCommand` 已自动应用后仍期待第二次手工应用返回 APPLIED，改为核对 PG 的控制/Run/Task/operation/Invocation 事实并允许重复调用返回 null；另 P07 旧 `requestActionApproval` 可先保留 operation ID、没有 Gateway 行，本轮一度错误要求所有 RUN ACTION_APPROVAL 都已有 operation。修复仅对本轮冻结的必需 Mock 动作要求原 Gateway 行及 DENY→Run FAILED；非 Mock 的 P07 Review 保持旧决定语义，[首轮验证回归](../testing/evidence/m03/gateway-action-verification-regression.log) 24/24。随后发现旧 P07 APPROVE 虽能决定，却会插入永远无法被固定图领取的通用 RESUME；已将自动入队限制为契约确有同 operation_id 的冻结 Mock 意图，P07 预留审批和 P09 直接 Gateway 保留原决定/动作入口而无该图命令。[旧 Gateway 15/19 红灯](../testing/evidence/m03/gateway-action-gateway-final-v2.log)是四个直接 Gateway 反例继续假设有 deferred RESUME；修订为同一 Review/operation/旧 epoch/撤权/资源效果以及“无图命令”观察，outbox 故障注入转移到真正冻结 Mock 图反例，不能仅删掉安全断言。旧全量的 PG 启停和临时目录清理仍均成功，红灯不能算产品绿灯。

[内层租约故障红灯](../testing/evidence/m03/gateway-inner-lease-red.log)在真实 PG 中以 1000 ms claim 分别于 Admit 后、Fake 写入后等待 1200 ms，并在钩子内确认数据库租约已过期；旧代码两例仍回 SUCCEEDED，整轮 19/21、退出 1。新增两处栅栏后[同组绿灯](../testing/evidence/m03/gateway-inner-lease-green.log) 21/21、退出 0，前窗不产生 marker，后窗保留唯一原 marker/Invocation 并将结果设 UNKNOWN、claim QUARANTINED；两轮 PG 启停、迁移和 graph 安装均成功，临时集群清理 True。固定图另有同一反例：外层 invocation 心跳仍保持 ACTIVE、内层已到期，正式 `runOneCommand` 不派 Fake 效果而保留原 UNKNOWN；其最终定向与全量日志记录在本节后续自检结果中。

`apps/api/scripts/run-integration.ps1` 原在 build 前要求 `dist/test/integration` 已存在，干净检出无法运行；本轮把这一检查移到 build 之后。清洁入口试验临时把生成的 `dist/test` 移至绝对路径 `D:\Develop\Relay-Agent\apps\api\dist\test.m03-clean-entry-backup`，确认缺目录后执行包装器 `-TestFile cli`，编译与真实 PG 自检成功。自动审查拒绝了对此备份目录的递归删除，返回原文 `blocked by policy`；未重试或改用其他清理方式。该生成备份未进入 `package.json` 的发布 `files` 白名单，也不纳入源码/文档冻结输入；PG 临时集群的停止与清理另按每个测试包装器 footer 记录。

本片定向真实 PG 自检：Gateway [21/21](../testing/evidence/m03/gateway-inner-lease-green.log)、官方图 [26/26](../testing/evidence/m03/gateway-action-run-graph-final-v4.log)、Review/验证 [25/25](../testing/evidence/m03/gateway-action-verification-final-v3.log)、命令顺序/控制 [7/7](../testing/evidence/m03/gateway-action-run-command-order-final-v3.log)，均退出 0；后两项在内层 lease 修复前单独执行，最终同源码的完整回归包括它们。[完整真实 PG 回归](../testing/evidence/m03/gateway-action-full-integration-final.log) 241/241、退出 0，business migration、graph 安装、PostgreSQL 启停均退出 0，临时集群清理 True；此前[240/240 中间轮](../testing/evidence/m03/gateway-action-full-integration-pre-graph-lease.log)未编入最后一条外层心跳/内层失租图反例，保留为历史而不作为最终覆盖。其他静态/打包结果见本片 SHA 证据清单，均仅为开发自检，需协调 Agent 独立复验。

本片尚未验证旧版 Windows 固定图包的待审 checkpoint 原样升级：旧状态没有 `reviewId/reviewKind`，不能安全猜测新 interrupt 的绑定，当前版本失败关闭。M07 安装/升级出口须有受信迁移或唯一性证明并做真实 PG 旧包→新包试验，见[部署限制](../deployment/本机部署.md)。本片交付时，G06 在途模型取消与 G03 Gateway UNKNOWN 页面可见性尚未完成；后续开发切片见下文。任一后端局部结果均不代表 G01–G08、M03 整体或真实 Provider 已通过。

## Windows ACTION 组合重跑的 Context 栅栏修复

首轮真实 WebView2/PG 在 ACTION APPROVE 后发现 BUILD_CONTEXT 与 DRAFT 各产生第二条成功 Attempt。ASK 与 RESUME 会改变 Task 状态和行 revision，但 DRAFT 所消费的标题、验收版本、Project 和 Context 来源并未变化；旧栅栏把行 revision 当作输入变化，效果已成功而候选尚未保存时也重建了模型步骤。

现在从已保存的 Context Manifest 比较实际消费的 Task 内容、验收版本、Project/Context/Authority 来源及 Run epoch；纯状态修订不失效。冻结 Mock 动作在 Gateway Admit 的短事务里再次核对该 Manifest，真实来源变化在 Fake 写入前拒绝原 operation；效果已成功之后的来源变化不重新执行 BUILD_CONTEXT/DRAFT，也不新造工具动作身份。该 Admit 栅栏仅适用于冻结 Mock operation，P09 直接 Gateway 沿用原入口。数据库提交和 Fake 文件写入仍非原子事务，写入窗口的不确定结果继续按原 operation 核对。

开发自检保留[状态修订红灯](../testing/evidence/m03/backend-action-context-red.txt)与[来源变化红灯](../testing/evidence/m03/backend-gateway-context-red.txt)；修复后隔离 PG [全量 246/246](../testing/evidence/m03/backend-gateway-context-full-pg-final.txt)、单测 66/66、类型检查与 Windows 构建退出 0。新包的[Review/RESUME](../testing/evidence/m03/backend-gateway-context-review-resume-webview.txt)与[ACTION_APPROVAL](../testing/evidence/m03/backend-gateway-context-action-webview.txt)真实 WebView2/PG 自检均通过。协调 Agent 的独立复验及其边界见[M03 验收记录](../testing/m03-independent-acceptance.md)。

## G03 查询可见性与 G06 在途取消开发增量

G03 沿用 Run 查询的 `unresolved_operation_ids` 字段，把同一 Workspace、同一 Run 的 Gateway `UNKNOWN` 原动作 ID 与 P08 未结清效果 ID 去重合并。Run 页沿用告警组件显示原 ID 与核对要求；列表没有逐项状态，不能把全部 ID 都称为已发生效果。Gateway 状态变化目前没有专属 Run SSE 事件，页面靠手动刷新、重开或约 15 秒周期查询校正。新增真实 PG 定向用例验证 PREPARED/DISPATCHING/SUCCEEDED 不混入、另一 Run 与 Workspace 隔离及 HTTP 404；浏览器端另核对可见文案。实际桌面 Gateway UNKNOWN 组合待独立运行。

G06 在 `runOneCommand` 增加对持久 `PENDING` 控制的定时观察，向固定图和 FakeModelPort 传播中止信号。DRAFT 模型等待在业务事务外；结果提交在 Task→Run 锁下复核控制，未发布效果时以失败 Attempt 记录抢占，不继续 PERSIST/COMPLETE。Worker 子进程停止后，恢复器用旧 epoch 的停机栅栏结清没有未决效果的纯计算 Attempt，再应用 PAUSE/CANCEL/CANCEL_TASK/HANDOFF；已有或不明效果保持原身份核对。新增轮询后曾出现 `worker_settled` 已输出、子进程却不退出的随机超时：定时器被清除时已有查询仍可能与数据库关闭竞跑；Worker 现在等在途 heartbeat/控制查询收尾再退出。Windows 强杀不能假设 JS 收到可处理的 SIGTERM；回归只要求监督器观察 `close` 后按原身份恢复，不伪造用户控制。隔离 PG 图与恢复测试的开发自检分别见[33 项图测试](../testing/evidence/m03/g06-run-graph-full-final.log)和[17 项恢复测试](../testing/evidence/m03/g06-recovery-full-final.log)。这两份属于开发自检；M03 当前状态见[接续文档](../../CODEX_NEXT_STEP.md)，按本轮用户要求不作正式模块验收。

本轮直接开发自检又跑了完整隔离 PG [251/251](../testing/evidence/m03/independent-g03-g06-full-pg.log)、React 组件 [134/134](../testing/evidence/m03/independent-g03-react-full-vitest.log)和 Chromium [21/21](../testing/evidence/m03/independent-g03-react-browser.log)。固定 Mock 负载脚本复用临时 PG、真实角色与 Saver 安装，8 个 `MARKDOWN_STRUCTURE` Run 完成、2 个控制取消收敛，4 路 Delegate、测试专用模型等待 250 ms；[原始 JSON 与摘要](../testing/evidence/m03/mock-bench-20260924-225511-ad4f1b7c/summary.json)保留请求、领取、首个已持久草稿、完成、取消、CPU/RSS 与 DB 采样。样本不足以推断 P95/P99 稳态容量，FakeModelPort 不产生真实首 token 或 Provider 成本。首次运行因 PowerShell 5.1 将 `initdb` 的非致命 stderr 合并输出当作异常而中止；包装脚本改为按子进程退出码判定，[重跑日志](../testing/evidence/m03/mock-benchmark-console-retry.log)通过。

Windows 发布脚本首次在编译期间检测到 `icon.ico` 输入哈希变化，拒绝发布清单与替换旧 release；不推断该变化来源。以当前稳定输入重跑后构建成功，新 EXE SHA-256 `521b65e08c5dbdaaaf8aa3962bad6cf8d2fbd1e548efd85c3a6b00635c0adbca`，资源文件 13205 项、未发现配置凭据文件；[重跑日志](../testing/evidence/m03/mock-g03-g06-build-release-retry.log)与[清单](../../apps/desktop/release/desktop-build-manifest.json)记录精确输入。已用此包启动隔离桌面试用会话；这只是开发包，不代表 G01–G08 总验收或安装交付。

## Mock 文件动作的 React 委托与历史入口（开发自检）

2026-09-24 继续将现有 M03 HTTP 动作契约接到 React，不新增业务路由、migration 或权限。Task 详情默认仍是普通固定 Markdown Delegate；只有用户主动勾选可选文件动作，页面才读取同 Project 的可用 `FAKE_WRITE` Connection 与受管目录，收集完整目标路径和内容，并随原 `command_id` 提交 `mock_gateway_action`。缺少配置或输入时不提交；路径是否真正落在目录内、策略/批准是否有效仍由 Gateway 在 Prepare/Admit 判断。客户端的 202 核对和响应不明时原 ID 回执查询沿用既有逻辑。Run 页按需读取 `GET /runs/{id}/operations`，展示原 operation ID、目标及 Operation/Invocation 状态；不把批准或 `SUCCEEDED` 以外的状态推断为完成，也不提供 UNKNOWN 直接结清入口。P09 配置写入口仍为 HTTP，本片未新增通用管理页。

前端定向开发自检：`pnpm --dir apps/workbench typecheck` 退出 0，`pnpm --dir apps/workbench exec vitest run tests/delegate-task.spec.ts tests/run.spec.ts` 14/14 通过。新增组件断言覆盖普通委托不带动作字段、可选动作冻结原请求以及 Run 动作历史按需读取；这些不是 Windows 或 M03 G01–G08 正式验收。

随后 `pnpm --dir apps/workbench test` 全量 136/136、`pnpm --dir apps/workbench build` 与文档检查退出 0。用户确认旧试用窗口已结束后，旧隔离会话通过匹配 session 路径和进程身份关闭并清理（PG 停止 0、临时根删除 True）；新桌面包[构建日志](../testing/evidence/m03/mock-action-ui-build-release.log)退出 0，EXE SHA-256 `ad4a40cd08502c3a5013f081acc08bce0bed4bfb671991f91609979f52086a25`，资源哈希 13205 项、禁带配置 0 项。新的隔离 PG/Graph 桌面试用会话已打开，启动输出见[日志](../testing/evidence/m03/mock-action-ui-trial-start.log)。这里只记录打包和启动事实，没有执行本次新增 UI 的真实窗口业务验收；M03 仍为 IN_PROGRESS。

## 2026-09-29 桌面 Assist 派发补漏

真实 Windows 调试桌面只启动 `supervisor-main.js`。此前监督器仅按 Run outbox 启动 `worker --once`，而该入口按设计不领取 Assist，导致已提交的 ASSISTANT 消息长期停在 PENDING。现在监督器每轮最多派发一个 Run 子进程和一个 Assist 子进程，后者通过 `--assist-once` 只调用现有 Assist 领取/生成用例；两类工作仍由各自原 Owner 写入，同一轮有积压时均有处理机会。只有存在可领取 Assist 消息或过期 RUNNING 租约才启动子进程，沿用桌面 launch Worker ID、宿主 Job、stdout 启停事件与 stdin EOF 停机链路。公开 HTTP、数据库结构、Run 命令及 `--once` 的原语义均未改变。

用户取消继续先持久化 `cancel_requested`，生成方按原身份结算 CANCELLED；模型/Skill 失败沿原错误码结算 FAILED。宿主停机中断不产生虚假的用户取消：原消息保持 RUNNING 与原 `worker_id`，下次监督器检测到过期租约后由原 Assist repository 清扫为 `FAILED/LEASE_LOST`，不重新调用模型。停机期间的 Provider 调用结果仍以已有 model_calls 事实记录为准，不能把消息租约过期理解为外部请求没有发生。隔离 PostgreSQL 的进程级反例覆盖自动派发、Run/Assist 同轮积压、模型失败、运行中取消与 EOF 后租约清扫；`run-dispatch` 定向 27/27、`assist` 原回归 29/29、`assist-live-preview` 6/6 均通过，临时 PG 均已清理。真实 WebView2 结果由当前独立验收记录限定。
