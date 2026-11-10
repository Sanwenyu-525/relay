# 正式任务执行闭环跑通任务书

日期：2026-11-09。状态：**待执行**。本文件是执行提示词，不是已实施记录；成绩只写[统一功能验收表](../docs/testing/overall-acceptance-2026-09-28.md#当前功能验收表)。授权：允许为跑通本链路做**最小产品代码修复**；不 commit/push，不扩展功能，不重做已验收部分。

## 1. 目标与「跑通」定义

让一条真实任务从创建走到可追溯的业务完成：

> Task 创建 → READY → Delegate 唯一 Run → DRAFT（含工具轮次）→ PERSIST 受管成果 → VERIFY → Review 人工验收 → Completion → Project State 回写 → 原聊天精确读回。

「跑通」必须同时满足：

1. 真实 PG + 真实 HTTP + 真实 Provider + 真实浏览器，不是 Fake/受控端口自述；
2. 同一请求只产生一个 Task、一个在途 Run，执行权归属与 `ownership_epoch` 可核对；
3. Artifact 版本不可变，Verification 绑定确切版本、验收条件与当前 `acceptance_revision`；
4. Review 的 ACCEPT/REQUEST_CHANGES 不被当成业务完成，完成必须走同一 Gate；
5. Completion 与 Project State 在同一业务事务边界内可追溯，刷新后仍可读；
6. 旧 Run、旧验收、旧凭据在重开/修正后只读保留，不被改写。

## 2. 开工检查与必读事实源

1. 读根 `AGENTS.md`、[CODEX_NEXT_STEP](../CODEX_NEXT_STEP.md)，在验收表搜索 `CORE-HAPPY-PATH-20261105`、`CORE-REOPEN-CYCLE-20261105`、`CORE-REVIEW-CORRECTION`、`CORE-EXECUTION-CONTROL`、`N04`、`N06`。
2. 读契约 02（状态与执行）、03（验证与批准）、04（恢复与提交）、01（事实 Owner）；读 [运行架构 §2.3/§2.10](../docs/architecture/runtime-context.md)、[M03 开发记录](../docs/development/m03-run-dispatch-slice.md)。
3. `git status` 有大量未提交改动；本链相关文件包括 `delegate-task.ts`、`run-steps.ts`、`run-graph.ts`、`verify-run.ts`、`review-decisions.ts`、`complete-run.ts`、`completion-commands.ts`、`state-commands.ts` 及相关测试。逐文件读 diff，不覆盖、不回退、不 reset/clean/stash。
4. 高开销前查磁盘；D 盘低于 15 GiB 或分区 10% 先报告。
5. 行号可能随并行改动移动；下表入口先 `rg` 复核，再修改。

## 3. 当前实现地图

| 环节 | 当前入口 | 关键事实 |
|---|---|---|
| Task/READY | `apps/api/src/application/create-task.ts:198`；`apps/api/src/task/task-repository.ts:195-215` | Delegate 只接受 READY；创建后默认 INBOX |
| Delegate | `apps/api/src/application/delegate-task.ts:149` | 冻结契约 `:560-590`；执行权 CAS `:620`；START 同事务 `:634-639`；并发三重保护 `:62-64` |
| 工作流步骤 | `apps/api/src/workflow/markdown-deliverable.ts:28-34` | BUILD_CONTEXT → DRAFT → PERSIST_CANDIDATE → VERIFY → COMPLETE |
| Run 派发 | `apps/api/src/application/run-dispatch.ts:20`（claim）、`:85`（settle）；`apps/api/src/worker/run-command.ts:23` | Worker 领取、心跳、控制轮询 |
| Run 图 | `apps/api/src/worker/run-graph.ts:71`；节点 `:90-203`；边 `:205-235` | LangGraph 唯一通用图；Review/审批中断恢复有身份校验 |
| 步骤推进 | `apps/api/src/application/run-steps.ts:274`；DRAFT `:861-1050`；PERSIST `:1052`；VERIFY `:1087`；COMPLETE `:1111` | 每步 Attempt 领取/结算；完成 Gate `:1406-1415` |
| 工具循环 | `apps/api/src/application/tool-loop.ts:42/360`；`apps/api/src/worker/tool-loop-action.ts:53` | 冻结信封、请求行持久化、单动作派发 |
| Verification | `apps/api/src/application/verify-run.ts:95/270-281`；`apps/api/src/workflow/verdict.ts:63`；`check-plan.ts:82` | session/target/check_results；HUMAN 形成 Review |
| Review | `apps/api/src/application/review-decisions.ts:42/312/329/336/348` | RESUME 唯一插入 `:148-156`；多条件组最后 ACCEPT 唤醒 `run-graph.ts:366-401` |
| Completion | `apps/api/src/application/complete-run.ts:62/141`；`completion-commands.ts:85` | 自动/人工完成同 Gate；Project State 回写 `complete-run.ts:205-270` |
| 重开 | `apps/api/src/application/completion-commands.ts:323/344-430` | 只允许 DONE；递增 acceptance_revision；旧凭据不可改写 |
| Project State | `apps/api/src/api/state-api.ts:47`；`state-commands.ts:47/133` | typed/incremental 更新；锁序 Task→ProjectState |

## 4. 已验收范围与未闭合项

- **CORE-HAPPY-PATH-20261105**（验收表第 30 行）：实施者自检 PASS，整体仍 PARTIAL；证据 `tmp/BASIC-CHAIN-20261105/strict-core-verdict.json` 22 项。未独立验收。
- **CORE-REOPEN-CYCLE-20261105**（第 29 行）：同一 Task 重开→新 Run/新成果/新凭据，旧历史保留；`reopen-cycle-chain.json` 16 项。仅自检。
- **CORE-REVIEW-CORRECTION**（第 28 行）：REQUEST_CHANGES→v2→重新验收，v1 摘要不变；`browser-correction-chain.json` 19 项。仅自检。
- **N04/N06**（第 73/76 行）：部分独立验收通过，最新联合复核仍 `PARTIALLY_ACCEPTED`；真实 Provider/Windows 未验。
- **破损基线**：`run-command-order` 6/7（失败例 `apps/api/test/integration/run-command-order.integration.test.ts:185`）、`m06-stop-proof` 0/5（`:110-177`）长期红，不得算本轮回归。
- **未覆盖**：真实 Provider 稳定性/额度、Windows/WebView2、安装态、宿主强杀与完整 UNKNOWN 矩阵、撤销 RUNNING 自动接续、Review Inbox 分页/SLO。

## 5. 范围与非目标

**范围内**

- 正常链、DONE 重开、REQUEST_CHANGES 修正、多条件 Review 逐条验收。
- 同 Task 只能有一个在途 Run、执行权 CAS、完成 Gate、Project State 回写。
- 与聊天结果的精确读回（原消息绑定 Task/Run/Completion 链接）。

**范围外**

- 聊天内基础工具循环（已有单独任务书）。
- 暂停/继续/停止/接手/UNKNOWN/孤儿恢复（另一份提示词负责）。
- Provider 连接与凭据（另一份提示词负责）。
- Windows/WebView2/安装态、多 DPI。
- 新 Review 类型、新 API、新表/迁移、TaskChain/N04/N06 完整出口。
- UI 像素级重构；只修阻断读回或状态显示的缺陷。

## 6. 实施顺序

1. 建真实 PG + 真实 API/worker + 真实 Provider + 真实目录 + 浏览器，先复跑 CORE-HAPPY-PATH 的 S1 正常链，确认基线。
2. 依次跑 S2 重开、S3 退回修正、S4 多条件 Review、S5 聊天读回；每个失败先定位到「Delegate/图/Attempt/Verification/Review/Completion/State」哪一层。
3. 只改阻断点；每次修改后重跑同一场景 + 受影响定向测试（`agent-main-loop-execution`、`run-graph`、`verification`、`review`、`migration`）。
4. 汇总证据，更新受影响文档与验收表；不顺手重构。

## 7. 验收场景

### S1 正常链（P0）

- 新目录自然语言建任务 → 唯一 Task/READY → Delegate → Run DRAFT + 至少一次工具调用 → 受管 Markdown → 人工验收 → 有效 PASS → DONE/Completion → Project State → 刷新原聊天读回。
- 断言：唯一 Task/Run；产物摘要与页面一致；PASS 绑定确切版本与 acceptance_revision；Project State 有 completion 引用；原聊天链接精确。

### S2 重开（P0）

- DONE Task 重开 → acceptance_revision+1 → 新 Run/新成果 → 新验收 PASS → 新 Completion。
- 断言：旧 Run/旧验收/旧凭据只读保留；旧聊天历史入口仍指向原 Run；新周期不误用旧完成身份。

### S3 退回修正（P0）

- 原 Task/Run 内 REQUEST_CHANGES → 修正预算消耗 → v2 → 重新验收 PASS 只绑 v2 → 完成。
- 断言：v1 字节不变；修正轮不误用累计 Attempt 的旧成功；预算耗尽走 `RETRY_BUDGET` Review。

### S4 多条件 Review（P0）

- 多条 CRITERION 逐条 ACCEPT；非最后一条不投 RESUME；最后一条形成组级 PASS 才唤醒图。
- 断言：错误/过期/错绑/错产物的 Review 必须拒绝；同一批准只对应一条 RESUME。

### S5 聊天读回（P0）

- 完成/重开/修正后刷新原聊天；断言结果链接、历史/当前凭据、确定的 Run 身份都可读，不把历史 `is_current` 当成当前事实。

## 8. 修复边界

- 事实 Owner 不变：Task/Run/Verification/Review/Completion/Project State 只能经各自入口写。
- Run 终态不复活；手动重试新建 Run；同一 Task 至多一个 AI 执行者。
- Review 决定不等于业务完成；人工 ACCEPT 不能覆盖 FAIL/ERROR/PREFERENCE；修正预算默认 2、上限 6。
- Verification 必须绑定确切 artifact version、当前 acceptance_revision、适用 session、冻结 required criteria；真实 Run 拒绝 Fake semantic checker。
- Completion 必须走同一 Gate；Project State 只能 typed/incremental 更新；重开只允许 DONE。
- 外部动作身份稳定；UNKNOWN 不盲重试、不换新 ID。
- 不删除/弱化失败测试；不为通过改断言；不 commit/push。

## 9. 环境与证据

- PG：一次性临时集群；记录版本、库名、迁移版本。
- API/Worker：真实进程；记录端口、PID、构建来源（HEAD + 未提交 diff 摘要）。
- Provider：本地已登记真实连接；无有效凭据就报 BLOCKED，不用 Fake 冒充。
- 浏览器：真实 Chromium；4173 被占用时用 `RELAY_E2E_PORT`。
- 证据目录：`tmp/TASK-RUN-CHAIN-20261109/`；保存 JSON checks、截图、原始命令与必要日志。
- 辅助调用（记忆/标题）失败单独标注，不算主链失败。

## 10. 完成定义

1. S1–S5 全部通过真实栈；每项有 JSON checks 与页面证据。
2. 定向回归通过：`agent-main-loop-execution`、`run-graph`、`verification`、Review/Completion 相关套件、`migration`；`apps/api` 类型检查通过。
3. 改动可逐条解释；没有无关重构、没有新 API/DB（除非先说明并获授权）。
4. 验收表更新一行；`CODEX_NEXT_STEP` 只写当前状态与剩余限制。
5. 报告区分实现、自检、独立验收、真实 Provider、浏览器、Windows/安装态；未做独立验收明确标注。

## 11. 已知基线与坑

- `run-command-order` 6/7、`m06-stop-proof` 0/5 是长期破损，不得算本轮回归；13 条既有单元失败同样不是本轮引入。
- 全量 Vitest 在并行负载下会级联失败；先做基线归因。
- Spark 可能 `RATE_LIMIT`；按 `retry_after_at` 等，不盲重试。
- 自动记忆/标题超时是辅助失败，不改主回复与业务结论。
- 真实 Windows/WebView2、安装态、宿主强杀不在本轮范围；不要用浏览器证据替代。
