# 后端接续整改：批准失效后的状态收口与真实复验

日期：2026-10-09。状态：**提示词已交付，尚未执行本次整改。** 接续后端实施后的独立复验；实际成绩与剩余项归[统一功能验收表](../../docs/testing/overall-acceptance-2026-09-28.md#当前功能验收表)，当前进度归[CODEX_NEXT_STEP](../../CODEX_NEXT_STEP.md)。本次只交付提示词，用户实际下发后才启动所述修复。

## 可直接使用的提示词

在 `D:/Develop/Relay-Agent` 接续当前后端实现。**不派子代理，由当前 Agent 单独执行。** 使用中文沟通，先读事实与失败证据，给出简短计划，再完成最小修复、正式回归、真实 PG 复验与必要文档同步。不要停在分析、单条绿色测试或重复旧成绩。

### 1. 范围与事实输入

读取 [AGENTS](../../AGENTS.md)、[当前进度](../../CODEX_NEXT_STEP.md)、[文档地图](../../docs/README.md)、[当前验收表](../../docs/testing/overall-acceptance-2026-09-28.md#当前功能验收表)，以及[执行契约](../../contracts/02-state-and-execution.md)、[验证与批准契约](../../contracts/03-verification-and-approval.md)、[恢复与提交契约](../../contracts/04-recovery-and-commit.md)。专题规则归[工具适配器 §1.6](../../docs/architecture/tool-adapters.md#16-写差异与检查工具2026-10-04-实施)与[测试计划 §20.10](../../docs/testing/verification-plan.md#2010-检查入口的信任摘要与检查证据适用性2026-10-07-实施)。

本机原始证据：`output/acceptance-raw/backend-reacceptance-20261009-01a11be3/`。优先读 `summary.json`、`graph-observations.json`、`graph-probe.log`、`approval-observations.json`、`approval-probe-r3.log`；全量失败再定向查 `integration-full.log` 和失败摘录。首个私有探针因 PowerShell 字符编码导致未匹配测试，属于验收脚本错误，不算产品缺陷；r2/r3 与完整图探针才是本次业务证据。

保留已实现的批准材料绑定：Review target 绑定服务端实测材料，批准提交与最终准入都复核，旧脚本/环境文件不得凭旧批准执行。保留逐套件独占数据库、迁移清单与 ledger 核对、完成验证两个门、检查参数解析、权限、原动作身份和 UNKNOWN 保护。旧材料绑定整改任务已经实施，不从头重做。

本次范围只补拒绝后的状态闭环、同一任务的合法接续、相关正式测试和全量回归剩余项。不开发其他 M/N、前端或产品多 Agent；不自动调用真实 Provider、不做 Windows 界面与安装验收，不提升这些出口。工作区有大量未提交修改，先记录基准，不能 reset/stash/clean、覆盖他人改动、自动 commit/push 或外发材料。

### 2. 必须先复现的产品缺陷

完整生产图链 `runOneCommand → LangGraph → executeToolLoopStep` 已在真实临时 PG 上复现：

1. 冻结脚本 A，改成 B，让原 Task/Run 创建 ACTION_APPROVAL，Review 绑定 B。
2. 使用真正 `resolveReview(APPROVE)` 保存的决定及其 RESUME 命令。
3. 派发前改成 C，当前材料门正确拒绝，Invocation 为 0，C 没有执行。
4. 但工具请求变成 `SETTLED`，其原因是 `GATEWAY_APPROVAL_STALE`；Operation 仍 `WAITING_APPROVAL`，Review 已 `DECIDED`，Run 仍 `WAITING_APPROVAL`，Task 仍 `WAITING`。
5. START 与 RESUME outbox 均 DONE，再调度没有下一命令；`advanceRunStep` 返回 `ACTION_UNKNOWN`，尽管这次动作已被证明没有 Invocation/外部执行。

这不是旧批准仍能执行新材料的漏洞，而是**已知派发前拒绝未收口，原任务悬空并被当作未知动作**。禁止只隐藏错误、改前端文案、重写为 SUCCEEDED、让轮询重试或创建另一个 Task 来代替修复。

重点读：

- `apps/api/src/worker/tool-loop-action.ts`：恢复领取拒绝与派发准入拒绝的 catch、`repository.settle`、Worker 释放及安全控制。
- `apps/api/src/application/gateway-actions.ts`：`claimGatewayWorker`、准入、`denyGraphActionBeforeInvocation` 与其他已存在的确定未执行收口入口。
- `apps/api/src/application/run-steps.ts`：pending 工具、未决 Operation 与 `ACTION_UNKNOWN` 判断。
- `apps/api/src/worker/run-graph.ts`、`run-command.ts`、`application/run-dispatch.ts`：图终止、outbox 结算、恢复与 Worker epoch。
- `apps/api/src/run/run-tool-call-repository.ts`、批准材料模块、Review 决定和控制用例。

先把本机反例转成正式源码测试，保留真实 PG、真实磁盘和实际图投递，取得 RED。随后复用现有领域入口与短事务做最小修复：让原 Operation、工具行、Run、Task、Review/决定、审计与命令结算形成一致、可恢复的结果。可以复用已有的“派发前确定未执行”处理机制，但先核对适用条件和既有业务语义，不预设新的状态枚举或另建授权/恢复 Owner。

必须明确区别：没有 Invocation/派发的确定拒绝；已 PREPARED 但可以证明未执行；DISPATCHING/UNKNOWN 或效果尚未核对。真实 UNKNOWN 仍使用原 Operation/Invocation 与隔离保护，不能因为工具行某个错误码就强行判未执行、释放资源或创建新动作。

拒绝后的合法接续必须在**原 Task 和原受管资源**上证明。若既有契约要求先把原 Run 安全收口，再由用户按原任务重新委托，则验证该路径；若支持同 Run 重建确认，则按其正式领域入口与审批历史验证。两种路径均不能通过复制一个新工作区/目录/Task 来冒充原任务恢复。未提交或已决定的旧 Review 与其材料依据须保持可追溯。

### 3. 收紧测试，避免无效绿色

`check-trust-gate.integration.test.ts` 当前“材料变更后重新确认”测试建了两个完全独立的 fixture；它只证明新 Task 能执行，不能证明原 Task/Run 的接续。

当前“撤销授权”测试还使用随机 `commandId`，未绑定真实批准排出的 RESUME，且允许成功与失败两种结果。改为明确区分并分别验证：

- **范围授权撤销**不自动追溯撤销确切单动作批准（已有 SC-13 契约）；材料与当前 Permission 都有效时，用真正 RESUME 验证原单动作仍可执行其确切材料。
- **Permission 撤销**必须拒绝未执行动作，旧批准不能覆盖撤销；用真正 RESUME 严格断言零 Invocation、类型化拒绝及拒绝后完整状态收口。

不得以“不成功即可”、宽泛 `assert.rejects`、两种结果均接受或不匹配的命令作为核心证明。新增测试至少覆盖：

| 场景 | 验收出口 |
|---|---|
| 完整图 START→等待批准→真实 RESUME→脚本/环境材料漂移 | 未批准材料零执行；拒绝后的 Operation/工具/Run/Task/命令一致，确定未执行不投影成 ACTION_UNKNOWN |
| 批准前材料漂移、旧批准被拒 | 原 Task 通过正式入口获得合法接续；旧 Review/摘要历史保留 |
| 批准后 Permission 撤销 | 零 Invocation，不能悬空或绕过已撤销权限 |
| 未漂移材料与合法新确认 | 正常执行预期 stdout，同一请求不会重复执行 |
| 拒绝收口与 CANCEL/PAUSE、旧 Worker 或重复 RESUME 竞争 | 原身份/CAS/审计正确，不误报接手完成，不再派发副作用 |
| 真实 DISPATCHING/UNKNOWN 对照 | 保持核对与隔离门，不走“确定未执行”捷径 |

### 4. 后端全量与环境剩余项

按当前验收表的本轮失败名单处理，不照抄实施轮“全部都是桌面占用”的归因。备份/恢复的 `MAINTENANCE_SESSION_BUSY` 与 `restore-postgres` 的连接栅栏问题分别验证；其他新失败也按其实际堆栈定位。单套件复跑通过只记为独跑，不替换全量失败。

非本次自有 Relay 桌面实例可能占用维护测试的原生命名互斥量。记录确切实例与测试守卫的关系；没有授权时不停止用户实例，不换互斥量、停用维护门、删 marker 或使用测试后门制造通过。如现有独占验收入口可提供合乎契约的环境就复用；否则明确需要用户正常关闭占用实例后才能补跑相关出口，其他不依赖它的修复与检查继续。

连接栅栏失败需调查套件连接的创建、关闭、prepared transaction 与维护会话收尾，用有限 barrier/超时稳定复现，不仅增大等待或忽略异常。运行器若有未校验请求文件/清理 exit code 的缺口，做与实际失败对应的最小修正，不能静默漏跑选定套件。

使用现有 Node v24.21.0、便携 PG 18.6、真实 `relay_app`/`relay_migrator` 角色与当前 native helper；不升级依赖、不连接用户数据库、不改用户 `.env`。测试进程不继承真实模型 opt-in，避免凭据进入日志。共享编译输出与 helper 构建独占进行，测试只枚举当前源码，私有编译探针不进正式全量。

复验顺序：类型与构建 → 新增正式图反例/CT-11 与相关权限、控制、UNKNOWN 回归 → 原失败的定向与组合检查 → 同一稳定源码基准的后端单元和真实 PG 全量。必要时先做定向，再进行一次最终全量，避免反复长跑。每次区分 pass/fail/skip/cancel，核心出口未跑不能算通过；本机日志留忽略目录，准确收尾自有数据库/连接/进程/目录。

### 5. 文档与完成标准

同步[工具适配器](../../docs/architecture/tool-adapters.md)与[测试计划](../../docs/testing/verification-plan.md)的真实拒绝和接续边界。实际结果只维护[统一验收表](../../docs/testing/overall-acceptance-2026-09-28.md#当前功能验收表)，阶段只维护[CODEX_NEXT_STEP](../../CODEX_NEXT_STEP.md)；不要把新 fixture 成功等同原任务恢复。更新本任务状态与导航。

完成 Documentation Impact Check：API/数据库真有变化才更新对应事实源，并写 Breaking Change、兼容与 migration 风险；没有变化就不制造 migration/ADR。重大拒绝根因在已有适当归属保留必要说明，不新建逐轮重复报告。运行 `node scripts/check-docs.mjs` 并人工核对事实与链接。

交付必须包含最小修复与根因、正式 RED/GREEN 及完整图证据、原 Task/资源的接续路径、真实全量命令与 exit/计数、源码稳定性、清理与剩余阻塞。拒绝状态悬空未闭合或全量仍有未处理失败时，不能宣布后端整体通过；不得继承真实 Provider、Windows 业务或安装结论。
