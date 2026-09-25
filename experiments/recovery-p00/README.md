# recovery-p00：真实 PostgreSQL 跨进程恢复实验

这是 P00 的最小恢复 Spike，不是生产后端或完整 Workflow。它用独立的 PostgreSQL 18 临时集群、独立 Node 子进程和 `ai@7.0.107` 的官方 `MockLanguageModelV4`，验证一个固定受管 WRITE_FILE 候选的审批、动作与恢复边界，并用同一套实验表验证两步位置推进、联合准入/结果短事务、业务完成短事务与控制/完成竞争顺序。

依赖和来源冻结在 [package.json](package.json)、[pnpm-lock.yaml](pnpm-lock.yaml) 和 [upstream-lock.json](upstream-lock.json)。AI SDK Core 固定为 `ai@7.0.107`、Apache-2.0、Vercel AI 仓库 commit `08ae5ad05bc12496dd1ffcf64e34419e0831300d`。工具只提供 `inputSchema`，没有 `execute`；SDK 负责生成和校验候选，文件效果只在持久化批准与准入后由实验 Worker 执行。

## 运行

仅使用便携 Node 24，不修改系统默认 Node。运行时准备步骤复用 [数据库基础实验](../typescript-p00/README.md)。运行器会在 `experiments/recovery-p00/.local/<run_id>/` 中创建独立 `initdb` data directory，申请动态 `127.0.0.1` 端口，并在结果写为 `PASSED` 前停止本次 PostgreSQL 子进程。每个子进程的边界为 30 秒。

```powershell
cd D:\Develop\Relay-Agent\experiments\recovery-p00
& D:\Develop\Relay-Agent\.research\runtime-cache\node-v24.21.0-win-x64\node.exe D:\Develop\Relay-Agent\.research\runtime-cache\node-v24.21.0-win-x64\node_modules\corepack\dist\corepack.js pnpm@9.15.9 install --frozen-lockfile
& D:\Develop\Relay-Agent\.research\runtime-cache\node-v24.21.0-win-x64\node.exe node_modules\typescript\bin\tsc --noEmit -p tsconfig.json
& D:\Develop\Relay-Agent\.research\runtime-cache\node-v24.21.0-win-x64\node.exe node_modules\typescript\bin\tsc -p tsconfig.json
& D:\Develop\Relay-Agent\.research\runtime-cache\node-v24.21.0-win-x64\node.exe dist\src\run-recovery.js
```

运行开始时，`results/latest.json` 和本次 `results/<run_id>.json` 先写 `RUNNING`；断言失败时写 `FAILED`，不会继承旧的 `PASSED`。当前运行器只会产生 `RUNNING` / `FAILED` / `PASSED` 三种状态；`results/` 里更早出现的 `ABORTED` 记录来自上一版运行器（当时为区分修管道期间的无效运行而引入），当前运行器不再写该状态，也不把那些历史记录当作证据。

## 实际结果

早期逐次记录示例为 [recovery-p00-55a25156-c594-442e-b04f-cba72006d2be.json](results/recovery-p00-55a25156-c594-442e-b04f-cba72006d2be.json)，Node `24.21.0`、PostgreSQL `18.6`、14 个场景、61 个进程记录，所有子进程未超时，`pg_ctl_stop` exit code 为 0。它只证明其自身 `input_sha256`，不代表当前源码。每次运行都会新建 `results/<run_id>.json`；[results/latest.json](results/latest.json) 是可变指针，只指向最近一次运行，不覆盖既有逐次记录。

每个场景记录 `model_calls`、`tool_calls`、`external_effect_writes_observed`、`artifact_matches_expected_now`、`evidence_records`、`protocol_commit_count` 和 `business_completion_count`。在 exit 73 后，父进程会在删除或篡改证据前读取操作专属文件并记录 `external_effect_writes_observed`；`artifact_matches_expected_now` 仅描述结果采样时该文件是否仍为原内容，不能反推历史效果次数。`protocol_commit_count` 是候选、批准、准入、调用结果、UNKNOWN、Step、控制与完成等短事务提交计数；`business_completion_count` 只按 `completion_records` 统计，协议提交数不冒充业务完成数。每个场景还带 `harness` 字段区分 `main-worker` 与 `control-worker`。子进程在自身 stdout 事件里上报本进程真实发生的模型轮次与工具调用次数（`model_rounds_this_process`、`tool_calls_this_process`，只在确实调用模型/工具处递增），父进程据此断言恢复进程没有重复轮次。

已实测的局部裂缝：

- 一个 AI SDK Mock 子进程持久化完整请求、响应、`responseMessages`、完整规范化参数、逻辑动作 ID 与 Review 绑定；之后的批准和执行子进程不重调模型。
- 两个批准和两个执行进程使用独立连接运行。holder 在锁定 Review 或 Operation/Run/Review 后进入测试专用 barrier，waiter 被 `pg_stat_activity.wait_event_type = 'Lock'` 实际观测到等待，且 `pg_blocking_pids` 报告的阻塞者后端 PID 必须属于 holder 自己的 application_name（不是任意锁）；释放后批准最多消费一次，模型调用、工具调用、文件效果观测和效果证据均为一次。
- 在批准后 `PREPARED` 短事务提交后用 exit 72 退出，新进程从原候选继续；在受管文件和效果日志写入后用 exit 73 退出，新进程以原逻辑动作 ID、effect ID、参数/基线/内容哈希和当前目标哈希核对后补记同一调用结果，不重调工具。
- 缺失、截断或合法 JSON `null` 效果证据，以及效果后外部编辑目标，都会保持 `UNKNOWN` 并把 probe Run 标为 `PAUSED` 加 `INSUFFICIENT_EVIDENCE` 原因；不会重调工具或标记完成。
- 批准后外部编辑操作专属固定文件会因真实基线变化拒绝，`wx` 原子新建不会覆盖外部内容。参数、基线、权限、验收或 ownership 变化也会使批准失效，工具调用为 0。外部效果后的 ownership epoch 变化会拒绝旧快照的结果提交，并单独保留协调证据。

WRITE_FILE 只接受模型给出的字面目标 `managed-artifact.txt`，实际路径固定为该操作专属临时根中的同名文件；模型参数无法指定宿主任意路径。效果和日志各调用 `fsync` 后才触发 exit 73，这只覆盖进程退出窗口，不证明掉电或文件系统硬件持久化。

## 2026-09-20 接续覆盖与边界

当前运行器会分别记录 **33 个主恢复 Worker 场景** 和 **6 个 control-worker 场景**（[latest.json](results/latest.json) 里按 `harness` 分列）。它们使用同一个每次新建的 PostgreSQL 18 临时集群，但表、入口和结论边界不同；不要把 control-worker 的状态替身当作主 Worker 已接入的生产协议。

运行器每次都把实际 Node/PostgreSQL 版本、场景数、子进程记录、超时、停止结果和 `worker.ts`、`control-worker.ts`、运行器的 SHA-256 写入新的 `results/<run_id>.json`。读取当前结论时先查看 [latest.json](results/latest.json)，再核对该文件的 `input_sha256`；任何逐次记录只适用于其中的固定输入，不能把场景数当成完整 Spike、37 个验收场景或生产功能通过数。

主恢复 Worker 新增了以下实测裂缝：

- `DISPATCHING` 后、受控文件 Adapter 入口前以 exit 74 退出。父进程按 `invocation_id` 保存并绑定 operation、Invocation、effect ID、dispatch PID 的退出收据；恢复还要求旧 PID 已不可存活、零 `TOOL_CALL`、目标和效果日志均不存在，才以实验内部 `CONFIRMED_NOT_STARTED` 沿用原 logical action、候选和 Review 建立下一次 Invocation。旧或重放收据即使注入同一 PID 也不能确认新 Invocation；存活旧 PID 的 barrier 负向场景也必须拒绝该确认。
- Adapter 进入后只写入部分文件、尚未写动作身份效果日志时以 exit 75 退出。恢复保持 `UNKNOWN` 与 `PAUSED`，不把部分文件当成功或未发生，也不重调工具。主 Worker 的同一 UNKNOWN 短事务会把该动作的资源 claim 转为 `QUARANTINED`（`unknown_resource_claim_stays_quarantined_before_second_adapter` 场景）。
- 外部效果写入后以 exit 73 退出时，父运行器会关闭自身连接，以 `pg_ctl immediate` 停止并用同一 data directory、端口重新启动真实 PostgreSQL；重启后的新 Worker 仍只按原 Invocation/effect 身份核对并补记结果，不增加模型或工具调用。最近通过记录见 [recovery-p00-a1c543bd-3bcb-418c-bbac-ab7a1b7eff27.json](results/recovery-p00-a1c543bd-3bcb-418c-bbac-ab7a1b7eff27.json)。

`control-worker.ts` 只作独立的最小控制模型：真实 PG 与独立子进程/barrier 覆盖 B01 的 Delegate 行锁竞争、B03 的持久 Pause、B04 的完成优先/取消优先两种确定顺序、B05 在 `DISPATCHING` 和 `UNKNOWN + 旧进程已停` 时继续隔离资源、租约过期但旧子进程仍存活时拒绝跨 Task 冲突领取，以及 claim epoch 与 ownership epoch 分离 fencing。

其中 `resolve-unknown` 是明确标注的**注入式控制替身**，只代表"另有独立核对已确认未发生"的前提，不读取真实 Adapter 结果。因此 B05 的安全拒绝路径得到局部证据，但该控制场景不能称为完整 B05 或 Spike 2 通过。主动作 Worker 侧的 UNKNOWN 与资源隔离现在是真实路径：exit 75 的部分写入由主 Worker 自己的恢复事务转 `QUARANTINED`，`complete` 用例在有未决 UNKNOWN 动作时拒绝业务完成。

## 2026-09-20 联合提交、步骤推进、业务完成与控制竞争

本轮补齐了主动作 Worker 侧的四个缺口：联合准入/结果与资源 claim、持久化两步推进、业务完成短事务、控制意图与完成的确定竞争顺序。全部在主 Worker 的实验表上实现（`probe_steps`、`control_requests`、`verifications`、`completion_records`、`state_deltas`、`probe_project_state`、`command_receipts`），没有引入生产 schema 或通用 DSL。

新增 worker 命令（argv 与既有风格一致）：

```text
complete <operation_id> <command_id> [after-completion-commit]
control-request <operation_id> PAUSE|CANCEL
control-apply <operation_id> PAUSE|CANCEL
expire-lease <operation_id>
```

新增真实子进程退出码（沿用 72/73/74/75 风格）：

| 退出码 | 含义 |
|---|---|
| 72 | 批准后的 PREPARED 短事务已提交，进程在调用前退出 |
| 73 | 受管文件与效果日志 fsync 后退出 |
| 74 | DISPATCHING 后、受控 Adapter 入口前退出 |
| 75 | 已写入部分文件、尚无动作身份效果日志时退出 |
| 76 | 事务内注入失败：连接执行真实 `ROLLBACK` 后退出（`RECOVERY_INJECT_FAILURE=admission-rollback` / `result-rollback` / `completion-rollback`） |
| 77 | 准入事务未提交时直接退出进程，由 PostgreSQL 在连接断开后回滚（`RECOVERY_INJECT_FAILURE=admission-crash`） |
| 79 | 业务完成短事务提交后退出 |

三个注入点都位于所属短事务**全部写入之后、提交之前**，这样"回滚失效"才会被断言捕获：只要事务真的提交了，claim 行、Invocation 行、`DISPATCHING`/`SUCCEEDED` 状态、审计事件、Step 位置和命令回执就会一起可见，而不是全部消失。具体位置：

- `admission-rollback` / `admission-crash`：在 claim 行、Invocation 行、`operations.status = 'DISPATCHING'`、`probe_runs.phase = 'RUNNING'`、Step 启动、`RESOURCE_CLAIM_HELD` 与 `DISPATCH_CLAIMED` 事件、`DISPATCH` 协议提交之后。
- `result-rollback`：在 claim 释放、Invocation/Operation `SUCCEEDED`、Step 推进、`RESOURCE_CLAIM_RELEASED` 与 `RESULT_RECORDED` 事件之后。
- `completion-rollback`：在 PASS 记录、完成记录、Task `DONE`、Project State delta、Run `COMPLETED`、命令回执与两项审计之后。

新增 12 个主 Worker 场景：

- `dispatching_admission_and_resource_claim_commit_or_roll_back_together`：DISPATCHING 准入、Invocation、run 阶段与 claim 取得在同一短事务；注入点在该事务全部写入之后，因此 exit 76（真实 ROLLBACK）和 exit 77（未提交断连）后都会核对 claim 行、Invocation 行、`DISPATCH_CLAIMED` / `RESOURCE_CLAIM_HELD` 事件全部为 0 且动作回到 `PREPARED`。未提交行的回滚**不能被另一连接观测成中间态**，所以该场景先断言这些写入缺席、再由无注入执行成功取得唯一 claim 作为回滚证据，不声称观测到了中间态。
- `call_result_and_resource_state_commit_in_one_transaction`：外部效果已写入后结果事务注入失败（exit 76），动作保持 `DISPATCHING`、claim 保持 `HELD`、无 `RESULT_RECORDED`/`RESOURCE_CLAIM_RELEASED`、Step 未推进；恢复进程用原 Invocation 与 effect 身份核对证据后提交结果，同一短事务释放 claim 并把 Step 推进到 2/2；再次运行恢复路径只读到终态 `SUCCEEDED`。
- `stale_worker_claim_epoch_result_rejected_without_changing_claim`：claim epoch 推进后，旧 epoch 的结果被拒绝并保留核对证据，claim 既未释放也未隔离，Step 位置停在 1/2。
- `two_step_position_is_persisted_and_resumed_without_repeating_model_rounds`：`prepare` 在同一短事务持久化两步计划（Step 0 `CAPTURE_CANDIDATE` 成功、Step 1 `APPLY_MANAGED_WRITE` 待执行，位置 1/2）；两步之间 exit 72 崩溃后，新进程从数据库读到 `step_index=1`，并报道本进程真实测得的 `model_rounds_this_process=0`；模型调用全程为 1，最终位置 2/2；重复执行只跳过，不重跑步骤。
- `business_completion_transaction_writes_pass_record_task_done_delta_and_receipt_atomically`：完成事务内注入失败后整事务回滚（无 PASS 记录、无完成记录、无 State delta、无命令回执，Task 仍 `IN_PROGRESS`、`state_revision` 仍 0）；重试把 PASS 记录、CompletionRecord、Task `DONE` + `completion_basis`、State delta、命令回执与 Run `COMPLETED` 一起提交。
- `completion_commit_crash_replays_receipt_without_second_completion`：完成提交后 exit 79；新进程读出已提交状态；相同 `command_id` 重放返回原回执且完成记录、状态 delta、Project State revision 都不再增加；同 Task 换 `command_id` 被拒绝且不写回执；迟到恢复路径只观察终态。
- `completion_refuses_conflicting_command_ids_and_unresolved_unknown_actions`：同一 `command_id` 用于另一操作时 payload 冲突被拒绝，只保留冲突审计；存在 UNKNOWN 在途动作时完成被拒绝，无 PASS 记录、Task 保持 `IN_PROGRESS`、claim 保持 `QUARANTINED`。
- `pause_applied_first_refuses_completion_and_keeps_execution_right`：控制进程（barrier 持锁）先提交 Pause；完成子进程的等待必须是它自己处于 `wait_event_type = 'Lock'`，且 `pg_blocking_pids` 报告的阻塞者后端 PID 属于 holder 的 `application_name`，holder 子进程句柄同时确认仍在运行，barrier ready 文件里的 PID 与句柄一致。释放后完成读到 `PAUSED` 并拒绝提交，Task 为 `WAITING`，ownership epoch 不变。
- `cancel_applied_first_refuses_completion_and_releases_execution_right`：Cancel 在安全点入库后 Run 为 `CANCELLED`、Task 回到 `READY` 且 ownership epoch +1，完成命令被拒绝且不产生完成记录。
- `completion_committed_first_makes_late_control_act_on_the_new_state`：完成事务（barrier 持锁）先提交，后到的控制子进程以同样方式被证明等待的是完成 holder 自己的后端连接，随后把控制请求记为 `REJECTED` 并引用原完成记录；Task 保持 `DONE`、Run 保持 `COMPLETED`，没有被退回。
- `persisted_pending_control_request_blocks_completion_before_it_is_applied`：控制意图先持久化为 `PENDING`，完成用例在执行前检查到未决请求即拒绝；Run 仍 `RUNNING`、Task 仍 `IN_PROGRESS`，因此"已请求"与"已停止"在数据里可区分。
- `expired_claim_lease_with_live_old_writer_refuses_conflicting_resource_claim`：旧 Writer 子进程由 barrier 保持真实存活，存活判据是父进程持有的该子进程句柄（`exitCode === null` 且未被 kill），PID 探测、barrier ready 文件与持久化 `dispatch_worker_pid` 三者一致只作辅助关联；随后把持久化 lease 强制改为过期，claim 仍为 `HELD`，另一 Task 的准入仍被拒绝且无 Invocation、`TOOL_CALL` 或文件写入；释放 barrier 后句柄报告退出、旧 Writer 正常提交并释放 claim。

本轮通过记录为 [recovery-p00-a1c543bd-3bcb-418c-bbac-ab7a1b7eff27.json](results/recovery-p00-a1c543bd-3bcb-418c-bbac-ab7a1b7eff27.json)：39 个场景（33 主 + 6 控制）、203 个进程记录、0 个超时、`pg_ctl_stop` exit code 0、Node `24.21.0`、PostgreSQL `18.6`、用时约 133 秒，`input_sha256` 与当前 `src/worker.ts`、`src/run-recovery.ts` 一致。子进程退出码分布为 0×181、72×2、73×9、74×3、75×3、76×3、77×1、79×1。同一次数分布的独立复跑为 [recovery-p00-95532f5e-2a57-47a5-b6dd-87174a514c62.json](results/recovery-p00-95532f5e-2a57-47a5-b6dd-87174a514c62.json)（约 125 秒，同样 0 超时、`pg_ctl_stop` exit code 0、相同输入哈希）。

为验证被加强的断言真的能失败，本轮做了两次**故意破坏**运行（结果同样写为 `FAILED`，不作为通过证据）：

- [recovery-p00-5e528e91-5bc3-44b1-b27b-ed247796c0ec.json](results/recovery-p00-5e528e91-5bc3-44b1-b27b-ed247796c0ec.json)：把 `inTransaction` 的 `ROLLBACK` 临时改成 `COMMIT`（模拟回滚失效）。准入场景立刻失败，实际值为 `claims: ['HELD']`、`invocations: 1`、`DISPATCH_CLAIMED`/`RESOURCE_CLAIM_HELD` 各 1、动作 `DISPATCHING`，说明这些行/事件确实是回滚证据而不是恒为空转。
- [recovery-p00-18515a35-f736-4350-8916-8cdd015a525c.json](results/recovery-p00-18515a35-f736-4350-8916-8cdd015a525c.json)：把一个等待场景的 holder 身份临时改成不存在的 `application_name`。锁等待断言失败，说明该断言要求阻塞者必须是 holder 自己的后端连接，而不是任意 `Lock` 状态。

更早还有两次运行因完成事务里 `state_deltas` 外键顺序与漏放注入点而失败，同样写为 `FAILED`（各 25 个场景），保留在 [recovery-p00-e8c63982-8a57-4af1-a354-66eb533eae05.json](results/recovery-p00-e8c63982-8a57-4af1-a354-66eb533eae05.json) 与 [recovery-p00-404964d6-7f37-4fe4-a9f6-53f6ebeeb4e3.json](results/recovery-p00-404964d6-7f37-4fe4-a9f6-53f6ebeeb4e3.json)。

FAILED 记录现在会在 `failure` 字段持久化失败原因与已完成的场景数，不再只截断在失败场景处。该字段用一次自检运行验证：[recovery-p00-5bce8062-81fb-4d91-853f-8254e9bd87c6.json](results/recovery-p00-5bce8062-81fb-4d91-853f-8254e9bd87c6.json) 在已编译运行器中临时注入启动即失败，退出码 1，`failure` 为 `{message: "[reporting-self-check] …", scenarios_completed: 0}`。这条记录是报告机制的负向自检，不是实验场景失败；按非破坏流程重建 `dist` 后已确认临时注入标记不存在。

主 Agent 在最终源码上独立复跑 [recovery-p00-48492df1-6452-4f22-82d5-102fb565c2cc.json](results/recovery-p00-48492df1-6452-4f22-82d5-102fb565c2cc.json)：39 个场景（33 主 + 6 控制）、203 个进程记录、0 超时、`pg_ctl_stop` exit code 0、临时集群目录无残留，六个 `input_sha256` 与当前文件一致（`src/run-recovery.ts` = `f6e05bf0b29f…`）。更早的 `a1c543bd`、`95532f5e`、`42ce76c8`、`94901d6c`、`ea9c73e8` 等记录只适用于它们各自的输入摘要，不代表当前源码。

实际执行命令（全部使用项目内便携运行时，未修改系统 Node）：

```powershell
cd D:\Develop\Relay-Agent\experiments\recovery-p00
& D:\Develop\Relay-Agent\.research\runtime-cache\node-v24.21.0-win-x64\node.exe node_modules\typescript\bin\tsc --noEmit -p tsconfig.json
& D:\Develop\Relay-Agent\.research\runtime-cache\node-v24.21.0-win-x64\node.exe node_modules\typescript\bin\tsc -p tsconfig.json
& D:\Develop\Relay-Agent\.research\runtime-cache\node-v24.21.0-win-x64\node.exe dist\src\run-recovery.js
```

依赖未新增：`package.json` 与 `pnpm-lock.yaml` 保持原样（`@sinclair/typebox` 0.34.52、`ai` 7.0.107、`pg` 8.16.3、`typescript` 5.9.3）。

## 边界与未覆盖项

结果仅局部支撑验证计划第 6 节的批准恢复、PREPARED/AFTER_EXTERNAL_EFFECT 裂缝、UNKNOWN 保守处理、审批失效、ownership/claim fencing、联合准入与结果提交、两步位置推进、业务完成事务与控制/完成竞争顺序。它不通过 Spike 1/2 整体，也不通过 37 个契约验收场景。

仍然没有覆盖的部分：

- 业务完成只覆盖"单一受控文件动作 + 固定两步计划"。没有多产物集合、产物版本存储、部分应用后的定向重试、重开 Task 后的历史凭据规则，也没有 Hard/Rule/Semantic 分类验证器与真实人工 Review 审批链；PASS 由实验内确定性检查器直接写入。
- 控制请求、Pause/Cancel 语义与 Step 推进都是实验简化模型，没有生产 Workflow 生命周期、resume_phase、预算与 Retry 状态机，也没有生产 Gateway、权限判定或动作准入。
- control-worker 仍是独立状态替身，其 UNKNOWN 结果核对是显式注入；主 Worker 侧的 UNKNOWN 处置只有"转 `QUARANTINED` + 拒绝完成"，没有人工处置入口。
- 单一受控外部效果后的 PostgreSQL 重启恢复已实测，但不能推广为完整业务恢复。官方 Mock 只验证 AI SDK 协议边界；没有真实 Provider 网络调用、Provider 可替换性、生产文件适配器或审计存储证明。
- 并发证据只覆盖本实验声明的行锁与 barrier 组合：阻塞关系已用 `pg_blocking_pids` 校核到 holder 的连接身份，但没有覆盖连接池耗尽、网络分区、时钟回拨、长事务超时或锁升级，也没有覆盖多个 holder 同时竞争的更复杂分工。
- `model_rounds_this_process` / `tool_calls_this_process` 是本进程内的静态计数，进程重启后会归零，只能证明"本进程没有重跑"，不能替代跨进程的全局调用计数（后者由 `MODEL_CALL` / `TOOL_CALL` 审计事件给出）。
- 存活判据基于父进程句柄与持久化 PID 的交叉核对；若父进程自身崩溃，句柄消失后只能退回 PID 探测或退出收据，本实验没有覆盖父进程崩溃后的存活判定。
- `results/` 中早于当前运行器的逐次记录（包括两版 `ABORTED`、早期小场景数与三次预修复 `PASSED`）与当前 `input_sha256` 不同，只能作为历史，不代表当前源码。
