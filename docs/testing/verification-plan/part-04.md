# 测试规格与发布出口：分册 04

角色：所属专题的唯一正文分册；2026-10-25 按原章节迁移，不改变原业务规则、日期、状态与证据范围。

[返回专题路由](../verification-plan.md) · [文档总入口](../../README.md)

按需读取本分册内的相关小节；跨章节约束沿链接核对，不能把本分册或历史措辞单独当作完整实现/验收结论。正文中的源码与命令路径沿用原有口径。

### 20.6 写路径的停止、预算与重启复核（2026-10-05 实施）

[专项提示词](../../../prompts/bounded-multi-agent.md)的单 Agent 依赖门要求先复核「停止、预算耗尽与重启读取」在**写路径**上是否成立：既有证据全部来自只读工具或固定动作链，写入的控制与恢复路径此前无出口。规格归[运行架构 §2.3](../../architecture/runtime-context.md)，实际结果只归[功能验收表](../overall-acceptance-2026-09-28.md#当前功能验收表)。出口是 `apps/api/test/integration/tool-loop.integration.test.ts`，跑真实 PostgreSQL 与真实磁盘。

| 编号 | 场景及必须成立的反例 | 判定 | 出口 |
|---|---|---|---|
| SW-01 | 待处理暂停意图期间派发写请求 | 类型化结果 `STOPPED`（不是未分类异常、不是 DENIED）；磁盘逐字节未动；无任何 Operation；请求行保持 `REQUESTED` 且 `operation_id` 为 null，恢复后仍是同一动作身份 | 用例 `a pending user pause blocks a requested write before it reaches the disk` |
| SW-02 | 同一轮内第二个写请求越过调用预算 | 该行 `REJECTED` + `TOOL_LOOP_BUDGET_EXHAUSTED` + `operation_id` 为 null；预算内的第一次照常落盘，预算外的目标文件逐字节未变；变化集账本只记一条 | 用例 `a write request past the call budget is rejected without an Operation or a disk byte` |
| SW-03 | 写入结算后重启再推进 | 脚本不再提供那一次写入，循环仍从已落库行接续并落定 DRAFT；`run_tool_calls` 只有第 0 轮一行（同 id、同 `operation_id`）；Run 只有 1 个 Operation、变化集账本仍 1 条；磁盘逐字节未变；重启后读取投影仍如实呈现 `SETTLED` 与该 `operation_id` | 用例 `a settled write is not re-executed after a restart and the loop resumes from the row` |
| SW-04 | 写请求暂停后在同一动作身份下恢复 | 恢复后仍走同一 `run_tool_calls` 行与同一 `operation_id`，磁盘只被写一次（目标内容与基线核对一致），不产生第二个 Operation | 用例 `a write paused before dispatch resumes under the same identity and writes exactly once`（2026-10-07） |
| SW-05 | 取消（而非暂停）后遗留的 `REQUESTED` 写请求 | 旧 Worker 拿着尚未派发的请求走到派发前被 `GATEWAY_RUN_NOT_READY` 挡住且 Run 已终态时，该行落 `REJECTED`（reason `RUN_TERMINAL` + 类型化 detail、`operation_id` 为 null），不留在 `REQUESTED` 悬空；磁盘逐字节未动、无任何 Operation；暂停（非终态）路径仍保持 `REQUESTED` | 用例 `a cancelled Run abandons the leftover write request instead of leaving it dispatchable`（2026-10-07） |

SW-03 的判据是行数与轮次：若历史没有从已落库行重建，Fake 模型会从第 0 轮再要一次写入，`run_tool_calls` 就会多出第 1 轮的一行。这同时把规格表 `TL-09`（断点恢复从已落库行重建模型消息）从「只存在于文件头注释」变成有集成出口的项。SW-05 用 `REJECTED` 而不是 `ABANDONED`：约束 `ck_run_tool_calls_operation_binding` 只允许未连 Operation 的行取 `REQUESTED`/`REJECTED`。

尚未覆盖、不得据此声称通过：停止与**完成**竞争下的写冲突（§20.2/§20.3 各自列出的那一项）、并发 Delegate 与过期 Worker 在写工具上的冲突覆盖、检查输出截断与取消的可辨性、Windows 自启动进程树停机证据、真实 Windows 窗口内由用户发起的人工路径。**本机 native helper 现对所有写路径返回 `DELETE_FAILED`，SW-01–SW-04 与一切落盘用例在本机无法复跑**（SW-05 不落盘，已单独跑过）；这是环境阻塞，不是产品缺陷。

### 20.7 人工触发的受管 Git 只读（2026-10-05 实施）

补 M06 的动作触发协议缺口：`prepareGatewayAction` 此前只接受 `RUN`/`USER_IMPORT` 两种 origin，人工触发的 Git 状态/diff 没有公开入口。规则归[工具适配器 §1](../../architecture/tool-adapters.md)，契约归[命令契约 §10.57](../../api/http-command-contract/part-04.md#1057-人工触发的受管-git-只读2026-10-05-源码实现)，物理设计归[第 61 节](../../database/physical-design-postgresql.md)。出口是 `apps/api/test/integration/git-user-action.integration.test.ts`，跑真实 PostgreSQL、真实 `git` 与真实 HTTP。

| 编号 | 场景及必须成立的反例 | 判定 |
|---|---|---|
| GU-01 | 受管根内读取 | 真实 `git init` 仓库读到 `branch`、`head_commit`、`untracked`；`GIT_DIFF` 读到真实差异正文 |
| GU-02 | 根外与路径穿越 | `../`、反斜杠穿越、绝对路径 → `GATEWAY_TARGET_DENIED`；未知 `resource_id` → `RESOURCE_NOT_FOUND`；同用例末尾用合法相对路径证明不是「一律拒绝」 |
| GU-03 | 缺 `GIT_READ` 连接 | 只有 `FILE_READ` 连接的 Project → `GATEWAY_CONNECTION_DENIED`，且 `USER_ACTION` 行数前后不变（拒绝不留假事实） |
| GU-04 | 策略 AUTO / ASK / DENY | AUTO 直通并结算；ASK 建 `ACTION_APPROVAL`、确认前 `Invocation` 数为 0 且响应无 `result` 字段，`ResolveReview` 后**同一 `command_id`** 再次投递才读取且只读一次；DENY → `GATEWAY_PERMISSION_DENIED` |
| GU-05 | 重复投递只读一次 | 同 `command_id` 两次 → `replayed=true`、同一 `operation_id`、`invocation_attempts` 恰好 1 行；「回执未写下即崩溃」后重投返回同一次落库结果 |
| GU-06 | 非 Git 目录不得显示为干净 | 结算 `FAILED`、`failure_kind = GIT_REPOSITORY_UNAVAILABLE`，响应中**不含** `staged`/`unstaged`/`untracked` 任何一项 |
| GU-07 | 三条 CHECK 的行级守卫 | 直写 `logical_operations` / `invocation_attempts`：挂 `task_id`/`run_id` → `23514`；`GIT_WRITE`/`CLI_RUN`/`FILE_WRITE` → `23514`；`resource_id IS NULL` → `23514`；Invocation 带 `worker_id` 或 claim → `23514`；合法形态写入成功 |

尚未覆盖、不得据此声称通过：`USER_ACTION` 的**崩溃后自动恢复驱动**（`reconcileGatewayInvocation` 分支已就位但无调度器调用，停在 `DISPATCHING`/`UNKNOWN` 的调用永久未决、须人工核对、不盲重试）；并发双投递的**真实 HTTP 竞争**用例（代码路径与集成断言存在，但未写专门的并发 HTTP 用例）；Windows junction/hardlink 根替换竞争（与 `FILE_READ`/`FILE_QUERY` 同一未闭合限制）；真实 Windows 窗口、中文 IME、DPI；前端接入；安装、升级、卸载。独立验收未做。GU-01–GU-07 通过不改变 M06 模块状态，也不放行 Git 写侧、目录浏览或受控 CLI。

### 20.7.1 人工触发的受管目录浏览与文件读取（2026-10-24 实施，迁移 0134）

补 0058 遗留的人工只读缺口：`USER_ACTION` 词表新增 `FILE_QUERY`×`LIST_DIRECTORY` 与 `FILE_READ`×`READ_FILE`，服务右侧工具面板「文件」页签（前端未接线）。规则归[工具适配器 2026-10-24 段](../../architecture/tool-adapters.md)，契约归[命令契约 §10.112](../../api/http-command-contract/part-08.md#10112-人工受管目录浏览与文件读取2026-10-24-源码实现迁移-0134)，物理设计归[第 113 节](../../database/physical-design-postgresql/part-05.md#113-0134-人工受管目录浏览与文件读取2026-10-24)。出口是 `apps/api/test/integration/file-user-action.integration.test.ts`，跑真实 PostgreSQL、真实目录与真实 HTTP。

| 编号 | 场景及必须成立的反例 | 判定 |
|---|---|---|
| FU-01 | 受管根内浏览与读取 | 真实目录一层条目（排序稳定、`kind` 区分目录/文件）、相对子目录、`limit` 截断显式；`READ_FILE` 读到正文与 SHA-256；审计 `MANAGED_FILE_READ_REQUESTED` 与动作同事务落账 |
| FU-02 | 参数与路径反例 | `READ_FILE` 缺 path / 带 limit、绝对路径、`..` 段 → `VALIDATION_FAILED` 且不留 Operation；不存在路径 → `GATEWAY_TARGET_DENIED`；`FIND_PATHS`/`SEARCH_TEXT`/写动作 → `GATEWAY_ORIGIN_DENIED` |
| FU-03 | 能力×动作双维词表 | 单测锁定错位组合（借 `FILE_QUERY` 读文件、借 `FILE_READ` 列目录）不放行；DB CHECK 直写证明 FILE_READ/FILE_QUERY×USER_ACTION 可入、写能力与脱资源形态仍 `23514` |
| FU-04 | 类型化失败不折叠 | 二进制 → `FILE_BINARY_UNSUPPORTED`、超大 → `FILE_TOO_LARGE`，结算 FAILED、无 `content` 字段、Invocation 状态如实 |
| FU-05 | 策略与连接 | AUTO 直通；ASK 先等待（无结果字段、无 Invocation）→ 确认后同命令读取一次；DENY/缺策略 → `GATEWAY_PERMISSION_DENIED`；连接缺能力或不存在 → `GATEWAY_CONNECTION_DENIED` |
| FU-06 | 幂等与刷新分界 | 同 `command_id` 重放原回执且恰一次 Invocation；**新 `command_id` 读到目录新变化**（与 GU-05 的冻结语义分界）；崩溃重投返回同一次落库结果 |

### 20.8 创建后人工补验收条件（2026-10-05 实施）

补「轻量起步建的 Task 无公开入口补验收条件」的服务端缺口：此前只能靠 AI 提案接受或 Skill 提案补齐。契约归[命令契约 §10.58](../../api/http-command-contract/part-04.md#1058-创建后人工补验收条件2026-10-05-源码实现)。出口是 `apps/api/test/integration/task-acceptance-command.integration.test.ts`（真实 PG + 真实 HTTP）与 `apps/api/test/unit/task-acceptance-command.test.ts`。

| 编号 | 场景及必须成立的反例 | 判定 |
|---|---|---|
| TA-01 | 幂等 | 同 `command_id` 同载荷 → 原回执 + `Command-Replayed: true`；异载荷 → 409 `COMMAND_ID_REUSED` |
| TA-02 | 双 revision CAS | 旧 Task revision 与旧验收版本分别 `REVISION_CONFLICT`，`conflict.entity_type` 为 `TASK` / `TASK_ACCEPTANCE`；并发一胜一败且败者为 `REVISION_CONFLICT` |
| TA-03 | 历史版本不可改写 | 写入新不可变版本，旧 `acceptance_criteria` 行逐字节不变 |
| TA-04 | 旧周期证据失效 | 同短事务内验证适用性写 `ACCEPTANCE_CONTRACT_CHANGED` + `source_ref = task_acceptance_revision:<新版本>`、该 Task 的 `OPEN` Review 置 `EXPIRED`、旧 session 行保留 |
| TA-05 | 只收紧规则 | 删除/改写/降级既有 required criterion → 409 `INVALID_TRANSITION` + `conflict.criterion_ids`；新版本无任何 required → 422 `VALIDATION_FAILED`；可选 criterion 可改写或丢弃 |
| TA-06 | 执行权与终态闸门 | AI 占有执行权、有活动 Run、有未结算或 UNKNOWN 动作、状态已是终态 → `EXECUTOR_CONFLICT`（终态须先 `ReopenTask`） |
| TA-07 | 短事务单写 | 验收版本、criteria、Task 指针、验证撤销、Review 过期、审计、回执全在同一 `withTransaction` 内；无模型/网络/CLI/人工等待进入事务 |

尚未覆盖、不得据此声称通过：**前端入口**（用户在界面上仍点不到，产品缺口未闭合）；`hasChecker` 守卫分支无反例（四个 `CriterionMethod` 全部映射到已注册 checker，今天无法从公开请求触发，该分支未被覆盖）；本入口不做 Rule 准入检查（有意与 Task Skill 路径不同），带不可执行 HARD Rule 的 Project 会到 Delegate 时才被拒；真实 Windows 窗口、IME、DPI、安装升级卸载。独立验收未做。

「轻量起步」切片另有一项**与本节相邻但独立**的发现：`taskLightweightEntry.spec.ts` 的响应丢失用例曾是 `if/else` 条件式断言、两条分支都过，「Task 轻量入口走手动核对」这一事实当时无回归保护。2026-10-05 按用户决定保持现状差异化并补紧断言（锁住「未发生自动核对」与「保留原 `command_id`、`pendingStep` 未清」两组可观察事实），该口径是否统一仍待用户决定。

### 20.9 传统 Agent 检查失败后的自主修正（2026-10-05）

复用原 DRAFT、Gateway、范围授权、LangGraph 与人工完成门。规则归[运行架构 §2.3](../../architecture/runtime-context/part-01.md#23-内部工具循环的对象身份与恢复2026-10-03-实施设计)，实际成绩只归功能验收表。

| 编号 | 必须成立的场景 | 出口 |
|---|---|---|
| CR-01 | 正常非零检查不带 reason，仍回传 `isError: true` 与逐字实际输出；成功复检为 false | `tool-loop.test.ts` 普通失败回放反例 |
| CR-02 | 真实子进程首次退出 1 → 读真实文件 → 按真实基线修改 → 同一冻结检查退出 0；用户无关文件、检查脚本不变；重放无新增效果；最终仍等待 HUMAN | `tool-loop.integration.test.ts` 真实检查修正用例 |
| CR-03 | 生产图收到失败检查后保存 `TOOL_CHECK_FAILED`，实际返回 advance 完成修正，持久化 Artifact、保留 OPEN HUMAN Review；原失败 claim RELEASED | `agent-check-graph.integration.test.ts`，真实 PG 与官方 Saver |
| CR-04 | 检查 ID 来自同 Run 冻结清单，任务不提供 ID 或修复值；生产 `runOneCommand` 领取目标 Run，真实 Provider 据失败输出中的随机值读取、修改、复检；官方 Saver 保存失败后继与 HUMAN 门，基线/实际 SHA、request id/用量、重放计数可核对 | `real-model-tool-loop.integration.test.ts` opt-in 修复探针；默认未配置时跳过 |
| CR-05 | 失权后的真实检查结果为 UNKNOWN，工具行保持 PREPARED，不进入模型历史；旧 SETTLED＋UNKNOWN 同样被权威 Operation 阻挡 | `tool-loop.integration.test.ts` 未知结果与旧数据反例 |
| CR-06 | 超时结算后重放仍是 FAILED，原 claim QUARANTINED，不新增 Invocation、不因 SETTLED 走成功路由 | 同上超时回放反例 |

2026-10-13 顺序接续：`run-prompts.test.ts` 约束工具 DRAFT 不用固定的读取顺序覆盖冻结任务的检查优先要求，并保持读写能力和外部数据边界；两条工具路由模板版本为 `1.0.1`。CR-04 的原顺序、真实退出码/输出、磁盘保留、HUMAN、Saver 与重放断言不降低；检查清单预期在委托前独立实测入口程序/脚本，校验其实际 SHA 后纳入完整 `trust_basis` 比较，以匹配当前检查信任协议。基础复跑只取正常功能与失败修正路径，不增加压力或复杂竞态用例。

CR-02 使用可控 Fake 工具序列验证机制，CR-03 使用生产 LangGraph＋Fake 模型，CR-04 使用真实 Provider＋生产调度图；三者分别报告，已配置检查的合成目录样本不代表真实 Windows 会话或任意用户项目通过。真实 Provider 只使用已授权配置及合成材料，不重试 RETRYABLE、不提高预算；是否实际通过只见功能验收表。Windows Job 管理、检查证据对受验产物的通用版本绑定、真实窗口/IME/DPI 与安装仍待覆盖；**脚本正文信任摘要已由 §20.10 覆盖**。

### 20.10 检查入口的信任摘要与检查证据适用性（2026-10-07 实施）

复用原范围授权、Gateway 准入与检查清单，不新建第二套授权系统。规则归[工具适配器 §1.5/§1.6](../../architecture/tool-adapters.md#16-写差异与检查工具2026-10-04-实施)，实际成绩只归功能验收表。

| 编号 | 必须成立的场景 | 出口 |
|---|---|---|
| CT-01 | 冻结期把入口可执行程序、**第一个位置脚本参数**与受管根顶层构建/测试配置算成信任依据，随授权一并落库；被检查的源文件不进材料 | `check-trust-gate.integration.test.ts`；`check-trust-basis.test.ts` 反例 1/2/3/4 |
| CT-02 | 同路径、同命令名，入口脚本正文被改成固定成功：`check_id` 不变也不再 AUTO，退回人工确认，Review 的 `evidence.scope_decision_reason = SCOPE_GRANT_CHECK_CHANGED` | 同上「入口脚本被改」用例 |
| CT-03 | 只改被检查的源文件：原信任依据不变，检查仍按原授权自动执行（不得把工作集当程序） | 同上「只改被检查输入」用例；`check-trust-basis.test.ts` 反例 4/11 |
| CT-04 | 参数引用的脚本正文变化、构建配置变化分别让摘要变化；大小写、含空格路径、根外入口按同一规范身份参与 | `check-trust-basis.test.ts` 反例 2/3/7 |
| CT-05 | 材料读不到（缺文件、目录、摘要错误）报 `CHECK_TRUST_MATERIAL_UNREADABLE`；解释器内联求值（`-e`/`-c`/`--eval`）、shell 组合（`&&`/`|`/`;`/反引号/`$()`）与通配符报 `CHECK_TRUST_DYNAMIC_EXECUTION_UNSUPPORTED`，都在冻结期拒绝，不落授权 | `check-trust-basis.test.ts` 反例 5/6；`check-trust-gate.integration.test.ts` 内联求值用例 |
| CT-06 | 历史授权行只有入口摘要、没有材料依据：仍可解析，但按「依据不一致」退回人工，不得当成摘要相同放行 | `check-trust-basis.test.ts` 反例 9；`check-trust-gate.integration.test.ts` 历史行用例 |
| CT-07 | 同一组输入重复计算得到同一摘要；不涉及宿主执行的只读工具、写动作与普通助手不被新机制误挡 | `check-trust-basis.test.ts` 反例 8/10 |
| CT-08 | **选项结束标记 -- 之后的执行入口必须计入材料**（2026-10-08 补）：`node -- --entry.mjs src/value.txt` 中 `--entry.mjs` 是真正被执行的入口（Node 24 实测；去掉终止符时同一参数是 bad option），不得继续按 FLAG 跳过。须区分终止符之前的开关、开关值、选项结束后的执行入口（第一个位置参数）与受验输入（其后位置参数）。冻结后修改该入口必须使摘要变化并退回人工（SCOPE_GRANT_CHECK_CHANGED）；冻结时入口缺失必须报 CHECK_TRUST_MATERIAL_UNREADABLE 而非落一份漏算入口的授权 | check-trust-basis.test.ts「terminator after the option terminator」等 4 条；check-trust-gate.integration.test.ts 两条真实 PG 用例（正常 Delegate/Gateway/工具执行链） |
| CT-09 | 终止符只在**入口之前**有「选项结束」含义：解释器选项解析在第一个位置参数处停止，入口之后的参数（含 -- 自身）全部是脚本 argv。`node check.mjs -- --verbose` 必须与 `node check.mjs` 同摘要，不得误判为无法证明；`node --test -- a b` 的全部显式入口仍进材料；`node -- --` 等不可证明形态仍明确拒绝 | check-trust-basis.test.ts「terminator after the entry」「the option terminator after --test」「terminator forms whose execution range cannot be proven」 |
| CT-10 | **选项值的位置与身份（2026-10-08 补）**：等号右侧是**值**，不是选项，不得再按选项解析。`node --env-file=-- check.mjs` 实测真实读取受管根内名为 -- 的文件并注入环境，因此该文件**必须进冻结与执行前核对材料**；改其内容必须使摘要变化并退回人工（SCOPE_GRANT_CHECK_CHANGED）。缺失/是目录必须 CHECK_TRUST_MATERIAL_UNREADABLE，不得静默通过。分离形态 `node --env-file -- check.mjs` 实测报 --env-file requires an argument、一个脚本都不执行 → 执行范围无法证明，明确拒绝。`--import=--` 等「值为 --」按**开关身份**命中动态加载而一致拒绝，不因值看起来可读而放行 | check-trust-basis.test.ts 值形状相关用例；check-trust-gate.integration.test.ts 环境文件四条真实 PG 用例（正常 Delegate/Gateway/工具执行链） |

`check-trust-v1` 的材料集合是**有限、明确、可枚举**的：入口可执行程序 + 第一个位置脚本参数 + 受管根顶层构建/测试配置名单。后续位置参数是这次检查的**输入**（工作集），不进材料——把它算进材料会让「检查失败 → 修正 → 再跑同一检查」这条主链直接不可用。检查程序自己 import 的兄弟模块同样不在材料内，这是本版明确的**范围限制**，不用静默少算材料维持 AUTO。`computeCheckTrustBasis` 不放宽连接允许清单与用户授予的动作权限。

CT-11（2026-10-09 实施，正式回归在 `check-trust-gate.integration.test.ts`）：范围授权因材料变化退回 ASK 后，Review 必须绑定**创建时**观察到的检查材料依据，批准提交与最终派发准入各自核对一次。核对输入只来自已持久化的 Operation 事实（`op.params` 的 executable/args ＋ 受管资源 canonical root），不信任调用方自报摘要。场景与断言：

| 场景 | 必须验证的结果 |
|---|---|
| 冻结后改脚本、创建 Review，材料此后保持不变 | Review target 的 `check_trust_basis` 等于**创建时实测**摘要（不等于最初授权冻结摘要）；批准后真实执行该材料，stdout 与账本可核对，且只有一次 Invocation |
| Review 创建后、批准前再次改脚本 | `resolveReview` 拒绝保存 APPROVE；`invocation_attempts` 为 0，无任何未批准执行痕迹 |
| 批准后、派发前再次改脚本 | 恢复领取 Worker 与派发准入都拒绝；Operation 身份保留、不派生第二个动作，工具行落下可核对的类型化原因 |
| 材料变更后按原任务的领域入口重新确认 | 原 Task/受管资源在安全收口后能够合法接续，新 Review 绑定当前材料且旧历史保留；**不得**用两个独立 fixture 的新 Task/新目录替代（那样只证明新任务能跑） |
| 已批准后撤销范围授权 | 按 SC-13，范围授权撤销不追溯撤销确切单动作批准；必须用真实批准产生的 RESUME，严格断言它**执行**并只执行原 Review 的材料（不接受「成功或失败都行」） |
| 已批准后撤销 Permission | 用真实批准产生的 RESUME 严格断言零 Invocation、类型化原因 `GATEWAY_PERMISSION_DENIED`，以及拒绝后 Operation→`DENIED`、工具行→`SETTLED`、Run→`FAILED`、Task→`READY` 的完整收口 |
| 批准后材料失效的拒绝收口 | 完整 START→图中等待→真实 RESUME 链中，确定未执行的拒绝不能让原 Operation/Run/Task/命令悬空：Operation→`DENIED`、Run→`FAILED`、Task→`READY`、两条 outbox 均 `DONE`、无待投递命令，`advanceRunStep` 返回 `RUN_TERMINAL` 而**不是** `ACTION_UNKNOWN` |
| 拒绝收口后的重复投递与继续推进 | 再次投递无可领取命令，工具行仍 `SETTLED`、Invocation 仍为 0，不产生第二次副作用 |
| 真实 DISPATCHING/UNKNOWN 对照 | 在途调用必须落 `UNKNOWN`（工具行仍 `PREPARED`、Run 仍 `RUNNING`、待处理控制停在 `PENDING`），不得被收口捷径当成「确定未执行」 |
| 审批记录缺少材料依据（升级前形状） | 保守拒绝，不猜摘要、不把旧批准自动升级为有效，且不产生任何真实调用 |

CT-12 的完整图反例单独成文件（`check-trust-refusal-lifecycle.integration.test.ts`）：`claimNextRunCommand` 按整库选取待投递命令是生产语义本身，不带 workspace 过滤，因此任何用 `runOneCommand` 驱动真实图的用例都必须独占一个数据库，否则一次投递可能领取到别的用例留下的命令。运行器为每个测试文件克隆独占库（见下「集成套件的数据隔离」），该文件因此自带最小 fixture，不与 `check-trust-gate` 共用。

测试用真实 PG、受管临时目录与真实 Node 脚本，核对真实账本、调用是否发生、状态与 stdout，不以某个抛错文本或范围授权降级代替派发边界断言。最终核对与外部进程真正读取之间仍是同机文件系统上的时间差，因此这些用例**不**宣称操作系统级隔离或任意动态依赖安全。

**集成套件的数据隔离（2026-10-09）**：`run-integration.ps1` 为**每个**测试文件用 `CREATE DATABASE ... TEMPLATE ... OWNER relay_migrator` 克隆出独占数据库，跑完即删，文件之间仍串行。原因是生产语义本身按整库选取——Assist 领取 `claimNextPendingMessage`、Run 命令队列与维护准入都不带 workspace 过滤，`--test-concurrency=1` 只保证文件不并发执行、不提供任何数据隔离。共享一个库时，先跑的套件遗留的 PENDING 消息会被下一个套件启动的真实 API 进程领走，形成「单跑全绿、串行全量失败」的不可归因组合。生产 claim 逻辑、维护门与连接安全门都不因此放宽，也没有测试专用绕过。`owner relay_migrator` 必须显式指定：`CREATE DATABASE ... TEMPLATE` 默认把新库交给执行者（管理员），而 `public` schema 归 `pg_database_owner`，owner 变了迁移角色就失去建表权限。

同一文件内的用例共享一个库，因此**驱动真实图投递的用例不能与其它用例同文件**：`claimNextRunCommand` 会按整库顺序领取任意 Run 的待投递命令，一次投递可能拿到别的用例留下的命令（2026-10-09 实测：完整图反例首次 `deliver()` 领取到的是前一个用例的 START）。这类反例必须独占一个测试文件。

运行器另有两条不得放宽的要求：`-TestFile` 指定的每个文件都必须解析到真实存在的源文件（少匹配任何一个都要报错，不能静默少跑）；收尾的 `pg_ctl stop` 与临时目录删除必须成功才记 PASS。

完成门的反例须分别覆盖「验证目标与当前候选版本不一致」和「版本一致但产物种类不满足冻结 expected outputs」。后一 fixture 必须保留正确的当前候选绑定，使其真正到达输出覆盖检查；不能只因两种反例都返回 BLOCKED 就把原输出覆盖断言换成版本陈旧而丢失该门的验证。2026-10-09 据此把 `verification.integration.test.ts` 拆成两条：第一条删空 `verification_targets`，断言 `VERIFICATION_TARGET_STALE`（绑定门）；第二条保留 target 不变、只把冻结 `expected_outputs` 换成产物集合覆盖不了的形态，断言 `DECLARED_OUTPUTS_UNSATISFIED`（输出覆盖门）。两条都核对未写完成事实、Run 仍停在 `VERIFYING`。

迁移完整性断言不得写死条数：备份/恢复类测试改为用**仓库当前迁移清单**（名称 + 内容摘要）与数据库里的 `relay_schema_migrations` ledger **逐条双向核对**（缺行、多行、摘要不符都失败，ledger 用迁移角色连接读取，因为应用角色对它没有 SELECT）。只比条数会把「61 条里换掉一条」读成通过，因此不采用；已有 migration 不回写。

**桌面停机与租约恢复用例的一条断言边界（2026-10-09 修正）**：`run-dispatch` 的「desktop EOF during Assist generation」原先断言租约清扫后 `model_calls` **恰好一行**。`recordModelInvocation` 的保证是「begin 行在调用 Provider 之前提交」，**不是**「消息一旦被领取就一定留下调用行」；EOF 与 Worker 领取之间存在调度窗口，Worker 在跨过该边界前被杀是合法结果。断言已改为「恢复后不得出现**第二次**模型调用」（`0n` 或 `1n`）——这才是该用例真正要锁的安全性质，也与用例名声明的两项行为（不伪造用户取消、claim 以 `LEASE_LOST` 收敛）一致。原断言在当前机器负载下会间歇失败（实测同一次执行 1 通过 1 失败），它把调度时序当成了产品契约。

**桌面维护会话的环境前置**：`backup` 与 `restore` 需要 `createBackup` 打开真实桌面维护会话。原生侧 `acquire_single_instance_named` 用 `CreateMutexW` + `ERROR_ALREADY_EXISTS` 判定，已有 Relay 桌面实例在运行时必然返回 `MAINTENANCE_SESSION_BUSY`（`maintenance_session.rs` → `lib.rs`）。这是单实例守卫按设计工作，不是产品缺陷，也不是套件隔离问题；2026-10-08 基线日志中 `restore` 已出现同一错误。这类用例只有在没有桌面实例占用该命名互斥量时才能取得通过结果，不得为此停用维护门或连接安全门。

`observedExecutableSha256` 与信任摘要在 prepare 与 admit 两处由同一个 `evaluateScopeGrant` 判定；`run_check` 的可信 exit0 只表示这一次检查对其受验输入正常结束，不代表业务验收 PASS、人工接受或 Task 完成。

## 21. 有界多 Agent 与自动会话验收规格

2026-10-30 最小会话链接续：`agent-conversation-main-loop.integration.test.ts` 的 `MA-session` 场景覆盖两子并行真实文件读取与主汇总、活动/已完成消息恢复、重试模型身份与尝试关闭、停止后不重试、主汇总预算预留、HTTP 主子关系及跨工作区隐藏；前端 `sessionDelegations.spec.tsx` 覆盖确切导航、晚到响应、失败重读、空投影、轮询清理与非法 DTO。浏览器定向检查另覆盖 Task→子会话→主会话导航及只读输入边界。这些不等于下方全部 MA 规格完成，实际结果仅归[条目 248](../acceptance-details/part-14.md#条目-248)。

2026-10-05，**已确认产品规则 / 待核定工程设计 / 未运行规格**。本轮只补文档和实施提示词。范围归[总纲 §0.9](../../requirements/product-spec/part-01.md#09-有界多-agent-与自动会话)，Owner/恢复归[运行架构 §2.5](../../architecture/runtime-context/part-01.md#25-有界子-agent-的委派与会话关联)，交互归[工作台 §23](../../frontend/workbench-design/part-07.md#23-主子会话与有界协作)。本表不表示测试已写或已通过。

| 编号 | 场景及必须成立的反例 | 必要证据 |
|---|---|---|
| MA-01 | 明确独立新需求创建主会话，同需求补充留原会话，模糊输入先澄清；纯建会话不创建 Task/Run，不调用 Apply/Delegate | 严格解释/命令反例＋真实 PG/HTTP；保留真实用户消息来源 |
| MA-02 | 同原消息/命令同载荷并发或响应丢失只建一次主/子会话、委派及实际 Task/Run；异载荷拒绝，重开查询原回执不生成新身份 | 真实 PG 并发/唯一性＋创建保存后回执前故障点 |
| MA-03 | 子会话关联确切项目、主会话、主 Run 和原委派；跨 Workspace/项目/执行、伪造父身份、孤立子关系被拒；旧普通会话保持可读且不虚构父子 | 真实 PG/HTTP 归属、权限、旧数据与旧深链兼容反例 |
| MA-04 | 角色配置可复用，每次委派冻结配置/来源版本和独立上下文；后续配置/历史修改不污染在途输入，不复用上一委派记忆 | 真实持久快照及模型收到的输入，来源失效另作反例 |
| MA-05 | 主模型实际派发调查、收到反馈、实施、再派独立审查并汇总；子不另占 Task 执行权或直接完成业务 | 可控模型＋真实 PG/工具；核对调用、反馈和父推进关联，预填结果不算执行 |
| MA-06 | 两个独立子任务真正同时在途，第三个不得启动；子再次委派被拒；父等待不占满子槽，子结算与父等待竞态能唤醒一次 | barrier 控制的真实 PG/Worker 并发，槽/claim/唤醒依据可核对 |
| MA-07 | 主子调用共享原 Run 总预算，主汇总额度保留；并发预留不可超发，已知用量据实，STARTED/未知用量保守占用，超额不外呼 | 真实 PG 预算竞争＋模型调用次数/实际用量账本，不能仅检查串行计数 |
| MA-08 | 子文件写、CLI、Git 写、改权限和递归委派均拒绝；父写权限不传为子能力，撤权/隔离在实际只读调用前有效 | 严格 schema＋真实 Gateway 准入反例；无实际文件/进程副作用 |
| MA-09 | 原 Run、委派、Attempt、claim/epoch 与 revision 共同限制结算；过期 Worker/终态迟到结果不能覆盖当前汇总或唤醒父执行 | 真实 PG 的重复 claim/迟到结果/CAS；已发生调用用量仍留账 |
| MA-10 | 用户直接补充子会话持久保存并一次同步主来源；重复投递不复制或形成消息循环，主/子文本不伪装为 USER 授权 | 真实 PG/HTTP 投递/消费回执＋组件来源；结果不含虚假执行授权 |
| MA-11 | 在途补充仅在安全点用于后续尝试；已结束会话收新消息不复活旧 Run；超范围重派仍检查原授权，影响必要审查基线的补充使旧反馈待复核 | 可控模型输入快照＋真实 PG/HTTP；准确排队/已消费/待决定呈现 |
| MA-12 | 审查等待相关改动形成并绑定确切未提交内容/版本；读取期间漂移、修复或验收条件变化时旧意见不能覆盖新基线 | 真实磁盘/PG 的摘要与适用性反例＋复审关系，不仅核对 Git HEAD |
| MA-13 | 已确认失败最多一次修正重试，原委派和失败关系保留且计总预算；调查继续失败由主接续，必要审查继续失败暂停交付 | 失败注入＋调用次数/输入修正/必要性冻结，主自审不能填独立依据 |
| MA-14 | 未知调用先按原身份核对，外部 UNKNOWN 不换 Adapter/ID 绕过；模型 STARTED 不被补成 FAILED、零用量或无成本成功 | 调用启动后结果落库前故障点＋持久账本/核对出口 |
| MA-15 | 父暂停/取消/交接立即阻止新委派及新子调用；在途安全处理前仍显示停止中；子完成/汇总/正式完成竞争不能穿过控制 | 真实 PG＋可控挂起调用/barrier＋停止证据与原完成 Gate 回归 |
| MA-16 | 单个子任务取消不取消父需求，也不触发自动修正重试；必要子审查取消仍保留交付缺口，失效父授权拒绝新补充执行 | 真实 PG 控制/授权反例＋组件状态 |
| MA-17 | 子结果保存未投递、投递未消费、主汇总保存回执丢失各处崩溃后沿原关系接续一次；重读不自动 Resume，不重复已完成模型/工具效果 | 新进程＋真实 PG/Fake Adapter 故障点，核对原身份、调用计数及结果 |
| MA-18 | 子声明完成或主汇总成功，但验证缺失/FAIL/ERROR、Review 未接受、版本不适用或完成 Gate 拒绝时，Task/Run 不成功；即使其他 Gate 满足，已冻结必要审查仍缺失/失败/取消/过期/归属不符或阻塞未解时，Application 拒绝完成提交，主模型不能删改必要标记绕过 | 原业务完成事务/验证回归＋确切 Artifact/条件/约束/委派/反馈基线关系；处理或豁免核对原授权与决定来源 |
| MA-19 | 项目→主→子投影默认折叠但待人工提示可见；Task 管理/旧 URL/分页可达，切会话晚到结果不串联，失权不泄露内容/名称/数量 | 真实关联查询＋受控组件/浏览器状态与范围反例 |
| MA-20 | 首次读取/订阅窗口内唯一更新、重复 hint、断线/seq 缺口与重连仍读到当前 revision；旧快照不倒退，展开/阅读不发写命令 | 真实 HTTP/SSE＋受控更新窗口，保持原消息/Run Owner |
| MA-21 | 创建/发送未决命令、草稿、目录切换守卫与恢复来源保留；Loading/失败/预算/必要审查/停止中/UNKNOWN 均可达 | 组件/浏览器故障反例＋确切 Windows 包下真实 API/PG 人工路径 |
| MA-22 | 实际两个只读子执行、直接补充、停止/重启与审查回主可操作；中文 IME、键盘、短窄窗和 DPI 不遮挡输入/风险；Provider 实际调用和用量另验 | 匹配源码的 Windows 包；真实 Provider 仅已授权配置＋合成材料定向，分层列限制 |

实施顺序归[专项提示词](../../../prompts/bounded-multi-agent.md)：先核对单 Agent 相关依赖，再按 A 持久协议、B 真实子执行/预算/控制恢复、C 会话 UI 与真实窗口出口推进；每片自检、独立验收、修复复验后才进入依赖片。旧单 Agent、工具循环、审批/UNKNOWN、业务完成和旧 checkpoint 的受影响回归必须保留。各层实际结果只更新[功能验收表](../overall-acceptance-2026-09-28.md#当前功能验收表)，不以文档检查或 A 片数据库通过宣称子执行能力已交付。

效果评价：实施时冻结代表性软件需求、单 Agent/人工转述基线、相同验收要求与协调动作计数规则，记录用户实际转述、分派和催办次数，以及必要澄清、失败处置、耗时、调用用量/成本和审查遗漏。主要比较人工协调动作，不能用子会话数替代；报告任务差异、样本量和未测项，未冻结阈值不宣称整体效果通过。效果测量与工程 Gate 分开，不自动启动论文实验或外发用户项目材料。

## 22. 未来需求驱动软件协作验收规格

2026-10-06。来源为用户已确认的[产品规则](../../requirements/product-spec/part-01.md#010-需求驱动的软件协作)、[未来路线](../../requirements/post-v1-roadmap/part-01.md#7-已确认的未来软件协作能力)和[交互流程](../../frontend/workbench-design/part-07.md#24-需求驱动的软件协作)。**以下均为未运行规格，工程协议和效果阈值待核定；文档检查不证明这些能力可运行。** 不自动加入现有 M/N 首片或已经通过的出口。

| 场景 | 未来必须验证的行为 |
|---|---|
| FSC-01 需求与同源文档 | 复用已有资料和有效决定，按功能组织需求；需求项和文档视图指向同一有效版本，导出能追溯；待讨论想法不被描述为已确认要求，纯讨论不制造执行 Task；§24 的明确修改指令可表达确认，不普遍要求重复接受点击 |
| FSC-02 文档修改与候选 | 仓库修改产生有原基线、来源和差异的候选，不静默覆盖产品有效要求；重复同一变化不反复生成待处理，人工修改保留，过期候选不复用旧接受 |
| FSC-03 语义冲突 | 对话、文档和原型反馈发生矛盾时，提供原要求、各来源修改、分歧与影响；用户选定方向后能看清有效内容和仍待处理部分，模型建议不自行升级为事实 |
| FSC-04 分层影响调查 | 已登记关系、调查推测及未检查范围能区分并追到依据；用有已知关联与刻意缺口的样板检查遗漏表达，不把单次调查当作完整依赖图 |
| FSC-05 当前计划草案 | 重要事实变化合并到项目当前草案，新增必要工作能关联有效需求及缺口依据；产品扩展想法留待讨论，接受计划不 Delegate，新增候选不进入旧任务链授权 |
| FSC-06 审阅版本与部分确认 | 审阅版本固定，新事实提示更新；可先确认需求再处理计划/知识，必要前置和受影响工作可见，不按过时要求继续，独立事项不因视图分组获得新的执行权 |
| FSC-07 原型反馈与覆盖 | 按需交互原型的使用流程和页面整体反馈可关联确切需求；成功/失败/取消等路径的已确认与未讨论范围可辨认，反馈形成需求候选，原型认可不替代正式功能验收 |
| FSC-08 经验候选 | 从已完成成果及证据中提炼有复用价值经验，普通日志不默认进入知识；来源、适用条件、未知和相似条目可核对，用户确认后才进入既有导读；明确收录命令的确认路径按 §24 验证，自动提炼仍为候选，不自动改写 Rule/Decision |
| FSC-09 知识适用性 | 项目做法变化提出复核候选，用户可保留、修订或转历史；后续引用显示复核状态和原适用条件，历史来源不被改写，不把模型推测直接作为失效事实 |
| FSC-10 集中审阅 | 同一需求汇集相关种类候选，项目级计划仍为同一草案；每项有自己的来源、决定和处理结果，候选依赖与延后事项可见，不把一次页面确认等同所有动作授权 |
| FSC-11 拒绝与持续排除 | 相同依据和条件下不重提，实质变化时说明新依据；持续排除只能由用户明确解除，换措辞或标识不能绕过，项目内理由不自动成为跨项目偏好 |
| FSC-12 接续与控制回归 | 重启或返回时重读有效事实及候选状态，有明确基线才生成期间差异；§24 的日常查看基线与命名点分开，失败不覆盖有效基线，返回可信检查须独立准入；不自动 Resume/放行新增任务，保留原审批、停止中、UNKNOWN 核对和版本绑定的完成约束 |

工程冻结后分别覆盖真实持久化/幂等/并发、受管文件变化与可控模型、真实 API/Windows 用户路径；自动生成还须验证启用来源、预算、重复/退出/重启的协议。各项结果只在实际运行后进入[功能验收表](../overall-acceptance-2026-09-28.md#当前功能验收表)，不先写“通过”。

使用效果样板串联“仓库需求变化 → 原型反馈 → 计划调整 → 有证据的成果 → 知识候选 → 隔日接续”，并保留延后、拒绝、过期和部分确认的路径。主要观察人工转述、分派、衔接和催办动作是否减少，同时记录需求误解/返工和恢复理解成本；沿 N00 的基线规则在对比运行前核定计数、样本及阈值，不以候选数、自动调用量或单次演示宣称收益。

## 23. 会话模式与人设助手验收规格

2026-10-05 为 [ADR-018](../../decisions/ADR-018-assistant-conversations.md) 落盘。**本节是未运行规格**：写在这里不等于已验证，实际成绩只看[统一功能验收表](../overall-acceptance-2026-09-28.md#当前功能验收表)。后端子项（AR-PB）的运行结果已在验收表对应行，本节记录尚未跑的前端与人工路径。

### 23.1 已实现并有真实 PostgreSQL 证据的后端子项

| 编号 | 场景 | 期望 |
|---|---|---|
| AR-PB-01 | 建会话时冻结身份 | 助手模式会话把名字、角色、口吻、只读范围与当时修订冻结进会话；改写助手不改变既有会话显示的人设 |
| AR-PB-02 | 快照不含授权 | 冻结快照只含四个文本字段；CHECK 挡住 capabilities / connections / permissions |
| AR-PB-03 | 只读范围只能缩小 | 绝对路径、`..`、空串、其他键、超过上限项数全部被字段错误拒绝 |
| AR-PB-04 | 同名与跨作用域 | 活跃名在 workspace 内唯一，重名不改已有助手；跨 workspace 的助手建不出会话 |
| AR-PB-05 | 既有会话兼容 | 迁移前插入的会话按普通模式读出，四个助手列为空 |
| AR-PB-06 | 重放 | 同 `command_id` 同载荷返回原会话；换模式重放按异载荷拒绝 |
| AR-PB-07 | 真实只读轮次 | 模型发出「搜索 → 读文件」序列，回传给模型的读取结果是磁盘真实正文，磁盘逐字节未变 |
| AR-PB-08 | 词表按当前连接裁剪 | 给了目录浏览与读取连接时词表恰为四个只读工具，Git 与写工具不在列；连接停用后词表当场收窄 |
| AR-PB-09 | 执行链未被创建 | 一轮结束后该 Project 的 Task、Run、范围授权、Run 工具调用计数全为 0 |
| AR-PB-10 | 只读动作有账本 | 产生的逻辑动作来源为助手来源，capability 只在只读集内 |
| AR-PB-11 | 写请求被拒 | 模型请求写工具时该行被拒、不连任何 Operation、不落一个字节、目录里没有新文件；模型随后改用只读回答 |
| AR-PB-12 | 同轮同序号唯一 | 重复插入同一 `(session, message, round, ordinal)` 被唯一约束拒绝 |
| AR-PB-13 | 跨身份冒用被拒 | 把助手行指向一个不存在或非助手来源的 Operation 都不成功 |
| AR-PB-14 | 不排队 | 上一条在途时再发被拒且文案不含「排队」，被拒的那条不留下消息行 |
| AR-PB-15 | 助手档拒绝 Skill 与提案 | 两条都被拒，文案说明原因 |
| AR-PB-16 | 归档冻结 | 助手归档后既有会话发消息被拒并带下一步指引，历史仍可读 |
| AR-PB-17 | 停止通道唯一 | 取消助手档消息直接收敛为已取消，不产生第二个停止资源 |
| AR-PB-18 | 普通档未受影响 | 普通会话的提案意图与 Skill 判定逐字未变 |

### 23.2 前端单选框与呈现

以下 AR-PB-19 至 AR-PB-22、AR-PB-24、AR-PB-25 的主体已由 jsdom + fetch 打桩覆盖（`apps/workbench/tests/assistantModeSwitch.spec.ts`），真实浏览器几何与窗口行为仍未跑；AR-PB-23、AR-PB-26、AR-PB-27 未运行。

| 编号 | 场景 | 期望 | 本轮状态 |
|---|---|---|---|
| AR-PB-19 | 两档渲染 | 单选框两档可选；助手档隐藏发送选项并显示只读说明 | 已覆盖（jsdom） |
| AR-PB-20 | 标签文案 | 普通档标签不含「子 Agent」等未实现承诺 | 已覆盖（jsdom） |
| AR-PB-21 | 切换等于换会话 | 切档触发导航到另一条会话，且不重复建会话 | 已覆盖（jsdom）：切档只改目标身份与会话选择，不发建会话命令 |
| AR-PB-22 | 在途禁用切换 | 有在途回复时两档都禁用并给出原因 | 已覆盖（jsdom）：禁用落在 fieldset，文案说明「停止后才能切换」 |
| AR-PB-23 | 草稿守卫 | 未发送草稿留在原会话，离页守卫照旧 | 未运行 |
| AR-PB-24 | 助手行标签 | 显示助手名与人设修订，不用「AI」 | 已覆盖（jsdom） |
| AR-PB-25 | 不渲染执行摘要 | 助手档不出现「按这个执行」；工具卡片标注只读且无审批四态 | 部分覆盖：摘要与提案入口已覆盖；只读工具卡片与审批四态需真实会话，未运行 |
| AR-PB-26 | 键盘与中文 | 单选组方向键可达；中文输入法合成中回车不发送；窄窗不溢出 | 未运行 |
| AR-PB-27 | 撤销后的呈现 | 助手归档后输入区给出「换一个助手」指引；连接撤销按类型化原因呈现 | 部分覆盖：助手清单读取失败会给出原因；归档冻结与连接撤销后的呈现未运行 |

新增两条本轮实测暴露的边界：

| 编号 | 场景 | 期望 | 本轮状态 |
|---|---|---|---|
| AR-PB-31 | 深链承载身份 | `?mode=` 深链在协作页保得住工作目录 | 已确认**不成立**：路由出口按 `pathname + search` 重挂载，工作目录是组件状态。身份改由协作页持有，见[工作台 §25.4](../../frontend/workbench-design/part-08.md#254-导航与深链)；深链未做 |
| AR-PB-32 | 助手会话发送载荷 | 助手档消息不带 `intent` 也不带 `skill_ref` | 已覆盖（jsdom 打桩断言载荷字段） |

### 23.3 未运行：真实窗口与真实 Provider

| 编号 | 场景 | 期望 |
|---|---|---|
| AR-PB-28 | 真实 Windows 人工路径 | 用匹配最终源码的确切包走一遍「建助手 → 新建助手会话 → 只读提问 → 停止 → 归档 → 冻结」 |
| AR-PB-29 | 真实 Provider 助手会话 | 只读工具调用真实发生，回复质量与边界遵守如实记录；缺授权配置时明确写未运行 |
| AR-PB-30 | 安装升级卸载 | 迁移 0059/0060 在真实安装路径上可应用且可回滚 |

### 23.4 与既有套件的回归要求

助手档的任何改动都必须保持 `tool-loop`、`folder-first-conversation`、`conversation-execution` 三套既有用例全绿——它们分别覆盖 Run 侧工具循环、普通档的文件夹入口与解释链路。共享代码（模型端口的 `TOOL_CALLS` 变体、Gateway 来源分派）被本专项改动时，这三套是回归闸门。

