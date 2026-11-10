# Agent 基础工具循环跑通任务书

日期：2026-11-09。状态：**待执行**。本文件是执行提示词，不是已实施记录；成绩只写[统一功能验收表](../docs/testing/overall-acceptance-2026-09-28.md#当前功能验收表)。授权：允许为跑通本链路做**最小产品代码修复**；不 commit/push，不扩展功能，不重做已验收链路。

## 1. 目标与「跑通」定义

在真实运行环境里，让普通 Agent 会话完成一次**同一逻辑轮次内的多轮工具循环**：

> 用户消息 → 服务端领取 → 上下文装配 → 真实模型请求（声明工具）→ 模型请求工具 → 服务端校验/准入/执行 → 工具结果回灌 → 模型继续推理 → 最终正文落库 → 刷新后消息与工具事实仍可读。

「跑通」必须同时满足：

1. 使用真实 Provider（不是 Fake、受控 HTTP 或模型自述），模型身份可在 `model_calls` 核对；
2. 同一条助手消息内至少 3 次 `purpose='PRIMARY'` 模型调用（至少 2 次工具结果回灌）；
3. 至少一次真实目录读取和一次真实写入；写入经 Gateway 基线/准入，回读字节与摘要一致；
4. 每个 assistant tool call 恰好一条结果（成功或类型化失败），账本无孤儿、无重复派发；
5. 最终正文不把工具失败写成成功，也不用「我没有文件访问能力」代替真实执行；
6. 刷新或重开页面后，消息、工具账本、最终正文一致；
7. 取消或失败路径如实收口：取消后不再发起新的模型调用或新的工具派发；已派发的副作用按真实结果记录。

## 2. 开工检查与必读事实源

1. 读根 `AGENTS.md`、[CODEX_NEXT_STEP](../CODEX_NEXT_STEP.md)，在验收表搜索 `CORE-HAPPY-PATH-20261105`、`AGENT-CORE-RELIABILITY`、`AGENT-FILE-CONTEXT-V3` 相关行；详细依据只按链接读取。
2. 本链相关规格：[提示词设计](../docs/architecture/agent-prompt-design.md)、[生成生命周期](../docs/development/agent-generation-lifecycle.md)、[工具适配](../docs/architecture/tool-adapters.md)、[HTTP §10.107](../docs/api/http-command-contract/part-07.md)、[工作台 §18.6](../docs/frontend/workbench-design/part-06.md#186-页面原型结构对齐2026-10-03)。代码是当前实现事实；文档与代码冲突先核对，不为迎合文档改正确代码。
3. `git status` 会有大量未提交改动，其中本链相关文件包括 `assist-runner.ts`、`assistant-readonly-round.ts`、`assist-read-tools.ts`、`conversation-state.ts`、`run-graph.ts`、`tool-loop-action.ts`、`workflow/prompts/*`、`AssistView.tsx` 及相关测试。**逐文件读 diff 后再改**；不覆盖、不回退、不 `reset`、不 `clean`、不 `stash`。
4. 高开销操作前查目标盘剩余空间与已有产物；D 盘低于 15 GiB 或低于分区容量 10% 先报告，不盲目堆积构建/测试产物。
5. 上游只读参照：OpenCode `97178e54b8c0`、Codex `1031a7b9aa74`、Pi `2a32a605a9f1`，位于 `.research/upstream/`。不安装依赖、不构建、不运行上游测试，不把上游代码改名纳入产品。

## 3. 当前实现地图（先核对再改）

| 环节 | 当前入口 | 关键事实 |
|---|---|---|
| 主流程分流 | `apps/api/src/application/assist-runner.ts:270-347` | 普通 Agent 有工具、可维护待办、计划/目标轮次都进主流程；能力事实块只说明缺项，不授权 |
| 本轮生成 | `assist-runner.ts:1028-1167` | 冻结模型路由、逐次写 `model_calls`、预览/用量节流、取消信号 |
| 工具循环 | `apps/api/src/application/assistant-readonly-round.ts:541-850` | 默认 6 轮 / 12 次工具调用；16 KiB 单工具结果；80% 上下文压力强制收尾；超 `inputByteLimit` 直接 `MEMORY_CONTEXT_TOO_LARGE` |
| 工具词表 | `apps/api/src/application/assist-read-tools.ts:42-86` | 会话放行 `FILE_READ/FILE_QUERY/GIT_READ/FILE_WRITE`；`COMPUTER_READ`、`BROWSER_READ` 被显式排除；**聊天词表没有 `CLI_RUN`/`run_check`** |
| 写资格 | `assist-read-tools.ts:42-49` | 只认目录档位 `AUTO`/`FULL`；`apply_changeset` 的 MODIFY/DELETE 必须带 `baselineSha256` |
| 工具执行 | `assistant-readonly-round.ts:996-1185` | 登记 → 参数校验 → 来源/准入 → Gateway 派发 → 结算；被拒也占一次调用额度 |
| 收尾 | `assistant-readonly-round.ts:409-500, 631-700` | 最后一轮或预算用尽时不再声明工具，追加预算说明；空正文有一次强制收尾机会 |
| 取消 | `assistant-readonly-round.ts:631-635, 766-768, 793-795, 836-839` | 轮次与每次工具派发前检查 `signal` 与 `cancel_requested` |
| 崩溃收口 | `apps/api/src/application/session-tool-reconcile.ts:24`，由 `assist-runner.ts:138` 的 tick 调用 | 已终止且从未提交 Operation 的会话工具行收口为 `ABANDONED`，不重派发 |
| 结算 | `assist-runner.ts:1411-1438` | 正文与消息终态同事务；自动记忆/标题是结算后的附带收益，失败不改写回复 |
| Provider 截断 | `apps/api/src/workflow/openai-compatible-model-port.ts:384-387` | `finish_reason='length'` 直接抛 `ModelOutputBudgetError`，工具参数不会被解析执行 |

## 4. 上游对照与取舍（只读结论）

| 机制 | 上游事实 | Relay 现状 | 本轮取舍 |
|---|---|---|---|
| 同一轮多步循环 | OpenCode `packages/core/src/session/runner/llm.ts:212-220`；Codex `codex-rs/core/src/session/turn.rs:542-720`；Pi `packages/agent/src/agent-loop.ts:188-330` | `assistant-readonly-round.ts:631-850` 已是同一形态 | 保留架构，不改循环；只验证多轮真实发生 |
| 工具调用与结果一一对应 | OpenCode `runner/step.ts:95-135`；Pi `agent-loop.ts:516-590` | `settleSessionReadonlyToolCall` + `toolTurns`，每个调用都回一条结果 | 作为硬验收，不新增协议 |
| 最大步数收尾 | OpenCode 注入 `MAX_STEPS_PROMPT` 并把 `toolChoice` 设为 `none`，仍保留工具定义以复用前缀缓存（`llm.ts:252-271`） | Relay 收尾轮直接 `tools: []` + 预算说明（`assistant-readonly-round.ts:646-690`） | 语义等价；不要求保留工具定义 |
| 输出被截断 | OpenCode 最多续写 2 次（`llm.ts:339-369`）；Pi 把该消息所有工具调用判失败、绝不执行半截参数（`agent-loop.ts:267-283`） | Relay 直接 `ModelOutputBudgetError`，工具不执行 | 本轮不实现自动续写；只要求「截断即类型化失败、绝不执行半截工具参数」。若真实场景因此阻断，再做最小续写 |
| 瞬时 Provider 失败 | OpenCode `runner/retry.ts` 与 `llm.ts:200-215`；Codex 同一 turn 复用 client session | 聊天循环无 in-loop retry，异常直接 `FAILED`（`assistant-readonly-round.ts:702-714`） | 不新建重试框架；先验证失败分类、消息可重发、无重复副作用。只有 P0 被真实瞬时失败阻断时才加**一次**有界重试，且仅限未发生副作用的错误 |
| 上下文压缩 | OpenCode 请求前 auto compact、overflow 恢复（`llm.ts:244-251, 307-313`）；Codex mid/post turn compaction（`turn.rs:662-700`） | Relay 80% 强制收尾，超限直接 `MEMORY_CONTEXT_TOO_LARGE` | 本轮不实现压缩；只验证收尾轮能给出正文，且不截断工具协议 |
| 插话/steer | OpenCode inbox 在 step 边界提升（`llm.ts:94-205`）；Pi `pendingMessages`（`agent-loop.ts:184-330`） | `drainSteers` 在轮次/工具边界消费（`assistant-readonly-round.ts:605-617, 742-746`） | 已有能力；只做回归，不扩展 UI |
| 崩溃后的在途工具 | OpenCode 每 turn 开始 `settleStaleToolCalls`（`llm.ts:412-435`） | tick 上 `reconcileTerminatedGenerationToolCalls` | P1 可选：杀 worker 后验证收口；不要求本轮完成 |
| 任意 shell / 全盘文件 | OpenCode/Codex 有 unrestricted shell 或沙箱命令 | Relay 明确没有任意 shell；`run_check` 只按 `check_id` 跑已配置命令，且不在聊天词表 | **拒绝照搬**；本轮不得新增 shell、任意命令或绕过 Gateway |

## 5. 范围与非目标

**范围内**

- 普通 Agent 会话（`conversation_mode='AGENT'`、根会话、绑定一个 `ACTIVE` 受管目录）。
- 目录需要 `AUTO`/`FULL` 写档位才能验写入；只读场景可用只读档。
- 文件读/查、Git 读、`apply_changeset`/`read_change_set`、`todo_write`。
- 取消、刷新、工具类型化失败、预算收尾。

**范围外**

- Task/Run/Verification/Review/Completion 全业务链；已有 `CORE-*` 行，不重做。
- `run_check`/CLI、computer/browser 输入、GitHub 写、任意 shell。
- 压缩重设计、重试框架、多 Agent 编排、上游依赖、桌面/安装态、真实 Windows/WebView2。
- 新表或新迁移；除非证明当前实现无法记录必要事实。如必须，先停下说明影响，不静默加表。

## 6. 实施顺序

1. **复现回路**：一次性 PG（`apps/api/scripts/run-integration.ps1` 或同样隔离的临时集群）+ 真实 API/worker + 真实 Provider + 真实目录 + 真实 Chromium。先跑 S1、S2 记录基线，失败点必须落到「上下文/词表/准入/派发/回灌/结算」哪一层。
2. **逐场景推进**：S1 → S2 → S3 → S4 → S5 → S6；S7/S8 按剩余时间与风险决定。每个失败先复现、再定位、再改。
3. **最小修复**：只改阻断点；每次修改后重跑同一场景 + 受影响定向测试，不顺手重构。
4. **证据与文档**：汇总证据，更新受影响文档与验收表；不做全量重跑凑热闹。

## 7. 验收场景

### S1 只读调查（P0）

- 目录放 3 个文件，其中 `a.txt` 含随机 marker（如 `RELAY_BASIC_<uuid>`）。
- 消息：「读取 a.txt，找出 marker；再确认 b.txt 是否存在，并说明 c.txt 的大小。」
- 期望：≥2 次 PRIMARY；至少出现 `read_file` 与 `list_directory`/`find_paths`/`search_text` 中的 1 类；正文包含真实 marker 与真实大小；目录没有新增/修改文件。

### S2 写入并回读（P0）

- `a.txt` 初始内容含随机 marker。
- 消息：「先读 a.txt，把 marker 追加到文件末尾后写回，再读回确认；不要改其他文件。」
- 期望：`read_file`（拿 `sha256`）→ `apply_changeset`（MODIFY + `baselineSha256`）→ `read_file` 回读；回读字节与摘要和写入结果一致；没有多余文件；`a.txt` 只多出预期的一行。
- 追加子场景 S2b：`apply_changeset` 用错误 baseline 写入 → 期望类型化失败回灌，模型重新读取后再写或如实报告；不得执行第二次错误写入。

### S3 多轮 + 待办（P0）

- 消息：「先列出 3 步计划，然后第一步读取 a.txt，第二步把内容写入 out/copy.txt，第三步读回确认，最后汇总。」
- 期望：`todo_write` 出现且最终状态与真实执行一致；≥3 次 PRIMARY；`out/copy.txt` 内容与 `a.txt` 一致；正文同时说明已完成与确实未做的步骤。

### S4 工具失败（P0）

- 请求读不存在的 `missing.txt`，或对只读档目录请求写入。
- 期望：工具返回类型化失败（不是 500、不是静默空结果）；模型据此修正或如实说明；正文不得出现「已成功」；失败请求同样占一次额度。

### S5 取消（P0）

- 在工具轮执行中触发取消（UI 停止或等价命令）。
- 期望：取消后没有新的 PRIMARY 调用、没有新的工具派发；消息终态 `CANCELLED`；取消前已派发的动作按真实状态收口；已完成的写入不得伪称未发生。

### S6 刷新/重开（P0）

- 完成态刷新一次；运行态刷新一次。
- 期望：消息、正文、工具账本一致；无重复消息；刷新不产生新派发；运行态刷新后仍能看到真实阶段，不要求它自动恢复成新的生成。

### S7 预算收尾（P1）

- 用可控参数把轮次压到 wrap-up（不改产品默认值）。
- 期望：最后一轮不声明读取/写入工具；正文明确说明预算用尽、哪些步骤没执行；不得把没做过的步骤写成完成。

### S8 瞬时失败（P1，受控端口）

- 受控 Provider 注入一次可重试错误。
- 期望：错误分类正确、消息可重发、无重复副作用；只有实现了最小重试时才要求自动恢复。该场景不替代真实 Provider 证据。

每个场景记录：`session_id`、`message_id`、PRIMARY call ids、工具行 id/状态、最终正文、页面截图、HTTP/page errors。

## 8. 修复边界

- 只修阻断；优先复用现有入口与既有账本，不新增第二 Owner。
- 不绕过 Gateway、审批、撤权、写档位、预算与取消语义。
- 写操作必须带真实基线；工具失败不得自动重试副作用；`UNKNOWN` 不盲重试、不换动作 ID。
- 不删除或弱化失败测试，不为通过改断言；新增测试只锁本次行为。
- UI 只修真实阻断（如工具执行状态不显示），不改 `AssistView` 的业务语义、路由或选择器契约。
- 不 commit/push；不 `reset`/`clean`/`stash`；保留共享工作区他人改动。
- 如需 API/DB 变化：先给差异、理由与影响；migration、契约文档与兼容说明缺一不可，否则不做。

## 9. 环境与证据

- **PG**：一次性临时集群，不碰用户真实库；记录版本、库名与迁移版本。
- **API/Worker**：真实进程；记录端口、PID、构建来源（当前 HEAD + 未提交 diff 摘要）。
- **Provider**：使用本地已登记的真实连接（最近验证为 Spark `spark-x2.6`）；没有有效凭据就报 `BLOCKED`，不用 Fake 冒充真实证据。注意 `RATE_LIMIT` 与 `retry_after_at`，不盲重试。
- **原生 helper**：文件 I/O 用例按需设置 `RELAY_FILE_IO_HELPER`、`RELAY_CREDENTIAL_HELPER`；`node --test` 不自动设 `NODE_ENV`，测试放行门要显式传。
- **浏览器**：真实 Chromium；4173 被其他项目占用时用 `RELAY_E2E_PORT`。
- **证据目录**：`tmp/AGENT-BASIC-TOOL-LOOP-20261109/`。保存 JSON checks、截图、原始命令与必要日志；不要在文档里粘全量日志。
- 自动记忆提取、会话标题等辅助调用超时单独标注，不算主链失败。

## 10. 完成定义

1. S1–S6 全部通过真实栈验证；S7/S8 至少给出明确结果（通过或带因未覆盖）。
2. 每次修复都有同一场景的复跑证据与受影响定向测试结果；`apps/api` 类型检查通过，Workbench 相关检查按改动范围通过。
3. 改动文件清单与理由可逐条解释；没有无关重构、没有为新功能预先建抽象。
4. 文档只更新受影响项；统一验收表新增/更新一行；`CODEX_NEXT_STEP` 只写当前状态与剩余限制。
5. 报告必须区分：实现、自检、独立验收、真实 Provider、浏览器、Windows/安装态。未做独立验收就明确标注。
6. 结束报告：改了什么、实际验证、文档同步、剩余限制；未清理的产物与原因如实列出。

## 11. 已知基线与坑

- 13 条既有单元失败基线；`run-command-order` 6/7、`m06-stop-proof` 0/5 是长期破损，不得算作本轮回归。
- 全量 Vitest 在并行负载下会出现级联失败；先用干净 HEAD/工作树基线归因，再判断是否本轮引入。
- `collaborationWorkspace` 默认 5s 超时会级联，单跑 30s 通过；不要据此改产品代码。
- 自动记忆提取超时是辅助调用失败，不改变主回复与工具结果。
- 撤销、任务重开、长历史读回、Task/Run 交接不在本轮范围；不要顺手扩展。
