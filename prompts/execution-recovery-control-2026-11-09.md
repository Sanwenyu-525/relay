# 执行恢复与控制跑通任务书

日期：2026-11-09。状态：**待执行**。本文件是执行提示词，不是已实施记录；成绩只写[统一功能验收表](../docs/testing/overall-acceptance-2026-09-28.md#当前功能验收表)。授权：允许为跑通本模块做**最小产品代码修复**；不 commit/push，不扩展功能，不新增第二 Owner。

## 1. 目标与「跑通」定义

让控制意图与恢复事实在真实进程崩溃/停止/交接后仍然可解释、可核对、可继续：

> 控制意图先持久化 → 安全点应用 → Worker 确认停止 → Task/Run 状态如实收口 → 需要时按 fence/人工证据恢复 → 同一业务身份继续或明确 BLOCKED。

「跑通」必须同时满足：

1. 暂停/继续/停止/取消 Task/接手都先落持久请求，202 只表示 PENDING，不表示已暂停/已停止；
2. 只有安全点（无在途 Worker、无未决效果、无待审批动作）才 APPLIED；界面不得提前显示 PAUSED/STOPPED；
3. 租约过期不被当成旧进程已停止；无 fence 不抢执行权；
4. `UNKNOWN` 保持原 `operation_id`，核对成功才收口，缺证据返回 BLOCKED 并列未决动作；
5. HANDOFF 只保存步骤/产物引用并交回 Task，不转授 AI 执行权；
6. 后台 tick 只调用既有 Application Owner，不内联第二套状态机。

## 2. 开工检查与必读事实源

1. 读根 `AGENTS.md`、[CODEX_NEXT_STEP](../CODEX_NEXT_STEP.md)；验收表搜索 `CORE-EXECUTION-CONTROL`、`CONTROL-RECOVERY-FOLLOWUP`、`RUNTIME-01`、`ENG-SA-01`、`ENG-SA-02`。
2. 读恢复契约 [contracts/04](../contracts/04-recovery-and-commit.md)、状态契约 [contracts/02 §控制/Handoff](../contracts/02-state-and-execution.md)、[ADR-039](../docs/decisions/ADR-039-background-work-tick-host.md)、[运行架构 §2.11–2.12](../docs/architecture/runtime-context/part-02.md)。
3. `git status` 有大量未提交改动；本链相关文件包括 `control-requests.ts`、`recover-run.ts`、`run-dispatch.ts`、`run-dispatch-repository.ts`、`supervisor.ts`、`supervisor-main.ts`、`background-work-scheduler.ts`、`run-api.ts` 及相关测试。逐文件读 diff，不覆盖、不回退、不 reset/clean/stash。
4. 行号可能随并行改动移动；下表入口先 `rg` 复核。
5. 高开销前查磁盘；D 盘低于 15 GiB 或分区 10% 先报告。

## 3. 当前实现地图

| 环节 | 当前入口 | 关键事实 |
|---|---|---|
| 控制请求 | `apps/api/src/application/control-requests.ts:61/149/179` | 锁 Task→Run；每 Run 至多一条 PENDING；PAUSE 安全点落 `PAUSED` `:220-224`；CANCEL/HANDOFF/CANCEL_TASK `:231-243` |
| Resume | `control-requests.ts:277/302/311-316` | 仅 PAUSED + AI 仍持权 + 无 PENDING + 无未决效果 + `worker_id=null` + invocation IDLE |
| HTTP | `apps/api/src/api/run-api.ts:186/197-199/204/213/230` | 202 只描述 PENDING；安全点另事务；`POST /runs/:run_id/recovery` |
| Task 取消 | `apps/api/src/application/task-commands.ts:315/362` | AI 持权时只登记 `CANCEL_TASK` |
| Worker | `apps/api/src/worker/run-command.ts:23/49/62-70/72-88/117-119` | 领取、心跳、100ms 控制轮询、仅当前 claim 可结算 |
| 派发/租约 | `apps/api/src/application/run-dispatch.ts:20/58-60/78/85-105` | 租约到期不证明旧进程停止；结算四重核对 |
| 仓储 | `run-dispatch-repository.ts:228/251/301/312/356`；`run-repository.ts:250` | claim/renew/release/requireStop/listExpired；fence 递增 epoch |
| fence | `recovery-repository.ts:144/154/166`；迁移 `0129_run_worker_fences.sql` | 持久停机证据；唯一重入依据 |
| 恢复 Owner | `apps/api/src/application/recover-run.ts:19/31/56/218/314/356-362/364/376` | 扫描不作滞留判定；受控恢复校验租约/归属；BLOCKED 列未决 |
| Supervisor | `apps/api/src/worker/supervisor.ts:56/72-125/132-224` | 只有 fence 才重入；桌面 FILE_WRITE 停机证明；子进程 close |
| 后台 tick | `supervisor-main.ts:241-274/278-289`；`background-work-scheduler.ts:60/126-174/169` | 过期 invocation 扫描、PENDING 控制应用、tick 异常收口 |
| HANDOFF 消费 | `control-requests.ts:241-242`；`member-wakeup.ts:151/184` | 载荷只是数据，不是指令或授权 |

## 4. 已验收范围与未闭合项

- 真实 PG 自检：`recovery` 20/20、`run-dispatch` 27/27、`run-recovery-api` 10/10、`background-work-dispatch` 6/6（OVERALL-FIX 行）。
- `CORE-EXECUTION-CONTROL`（验收表第 27 行）：暂停/继续、停止 Run、取消 Task、人工接手正常路径自检；真实 Spark 生成中暂停后恢复原 Run。仅自检。
- `CONTROL-RECOVERY-FOLLOWUP`（第 62 行）：控制/恢复 5xx 丢身份、旧快照写窗口、跨作用域迟到响应等已修；仅自检。
- M06 独立验收曾跑 `recovery` 17/17，但不含后来的 fence 重入、`run-recovery-api` 与 2026-11-06 修复。
- 未闭合：无 fence 孤儿仍需人工/OS 停机证据；**写工具下的停止×完成竞争覆盖缺失**；`UNKNOWN` 完整故障矩阵；HANDOFF 权限边界；`PAUSING` 只有 PENDING（Run 枚举无 PAUSING）；Windows/WebView2、窗口关闭恢复未验。

## 5. 范围与非目标

**范围内**

- 生成中/等待 Review 时暂停与继续；停止 Run；取消 Task；人工接手。
- 过期 Worker、fence 重入、受控恢复路由、BLOCKED 如实返回。
- UNKNOWN 的原动作核对与不盲重试。
- Supervisor/后台 tick 的活性与异常收口。

**范围外**

- 业务正常链（另一份提示词负责）。
- Provider/凭据、聊天工具循环、Windows 安装态。
- 新增 Watchdog/第二调度进程、按租约自动抢占、自动改判 UNKNOWN。
- 新控制类型、新 API/表/迁移（除非先说明并获授权）。

## 6. 实施顺序

1. 真实 PG + 真实 API/worker；先复跑 S1 暂停/继续，确认 PENDING→安全点→APPLIED 的时序。
2. 依次跑 S2 停止、S3 取消 Task、S4 接手、S5 过期 Worker（有/无 fence）、S6 UNKNOWN/受控恢复、S7 后台 tick。
3. 每个失败先定位到「控制请求/安全点/Worker/租约/fence/恢复 Owner」哪一层；只改阻断点。
4. 每次修改重跑同一场景 + `recovery`、`run-dispatch`、`run-recovery-api`、`run-command-order` 定向用例。

## 7. 验收场景

### S1 暂停/继续（P0）

- 生成中发起 PAUSE：先 202/PENDING；安全点后 Run PAUSED、Task 仍归该 Run；Resume 回到原 `resumePhase`，沿用原 Run。
- 等待 Review 时暂停/继续：不得丢原审批身份，不得把 Review 当完成。

### S2 停止 Run（P0）

- CANCEL 意图持久化；Worker 控制轮询中止；Supervisor/宿主确认后 Run CANCELLED、Task 回 READY；不宣称 Provider 已取消。
- 停止与完成竞争：数据库定序，只有一个终态；写工具场景必须覆盖。

### S3 取消 Task（P0）

- AI 持权：只登记 `CANCEL_TASK`，安全点后取消；人工 Task 直接 CANCELLED；DONE 不可直接取消。

### S4 人工接手（P0）

- HANDOFF 后 Run 终态 CANCELLED、Task HUMAN/IN_PROGRESS；只保存步骤/产物引用；新工作需重新 Delegate，不自动转移执行权。

### S5 过期 Worker（P0）

- 有 fence：按 fence 证据重入；无 fence：只写 `RUN_RECOVERY_REQUIRED`，不抢执行权。
- 断言：租约过期本身不触发抢占；旧 claim 不被释放/重领。

### S6 UNKNOWN/受控恢复（P0）

- 外部动作 UNKNOWN：保持原 `operation_id`；核对成功才收口；缺证据返回 BLOCKED + `unresolved_operation_ids`。
- 受控路由：校验 Run/Workspace、滞留 claim、worker 归属、租约过期；`RUN_RECOVERY_NOT_REQUIRED`/`WORKER_MISMATCH`/`CLAIM_NOT_EXPIRED` 如实返回；同一 `command_id` 幂等。

### S7 后台 tick（P1）

- 注入一次 tick 异常：进程不因 unhandled rejection 退出；记 `BACKGROUND_WORK_TICK_CRASHED`；下一 tick 恢复。

## 8. 修复边界

- 旧进程未确认停止前，不释放/不重领旧 claim；租约只挡新业务写入。
- 唯一重入依据是 `run_worker_fences` 持久事实；人工恢复也要先 fence，再按原 `operation_id` 核对。
- UNKNOWN 不盲重试、不换新 ID、不创建新执行权。
- 控制意图先持久化；只有安全点才 APPLIED；每 Run 至多一条 PENDING。
- Resume 必须仍是 PAUSED、AI 仍持权、invocation IDLE、`worker_id=null`、无未决效果。
- HANDOFF 载荷不授予权限、不创建 Task/Run。
- 后台 tick 只调用既有 Application Owner，身份 `api:<pid>`，不内联第二套状态机。
- 不删除/弱化失败测试；不 commit/push。

## 9. 环境与证据

- PG：一次性临时集群；记录迁移版本。
- API/Worker：真实进程；需要强杀/崩溃时用受控子进程与明确 PID，不杀陌生进程。
- 证据目录：`tmp/EXECUTION-RECOVERY-20261109/`；保存控制请求行、Run 状态时序、fence 行、恢复回执、日志。
- 明确区分「202 已受理」「安全点 APPLIED」「宿主确认停止」三种事实。

## 10. 完成定义

1. S1–S6 全部通过真实 PG/HTTP/Worker；S7 至少明确结果。
2. 定向回归：`recovery`、`run-dispatch`、`run-recovery-api`、`run-command-order`、`background-work-dispatch`、`supervisor-topology`；`apps/api` 类型检查通过。
3. 未引入第二 Owner、Watchdog 或按租约抢占。
4. 验收表更新一行；`CODEX_NEXT_STEP` 只写当前状态与剩余限制。
5. 报告区分实现、自检、独立验收、真实宿主证据；未做独立验收明确标注。

## 11. 已知基线与坑

- `run-command-order` 6/7、`m06-stop-proof` 0/5 是长期破损；本轮若修好其中一项，要单独报告，不能宣称其余同时通过。
- 13 条既有单元失败基线；全量 Vitest 并行级联失败先做基线归因。
- Run 枚举没有 `PAUSING`；202 不等于已暂停。
- 无 fence 孤儿按设计等待人工/OS 证据；不要为了“自动恢复”绕过。
- `runtime-context §2.12` 的“无恢复路由/并发闸缺失/handoff 无消费者”描述已过期待修订，以当前源码为准。
