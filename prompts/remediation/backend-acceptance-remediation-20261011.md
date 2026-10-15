# 当前源码后端验收后的修复与回归收口

编制日期：2026-10-11。用途：交给开发 Agent 直接执行的任务书。**编制本文件只交付提示词，尚未实施修复。** 用户将本任务书下发并要求执行后，在以下范围内持续修复、检查、复验和同步文档；本文件不自动授权其他专项。

## 1. 任务、范围与成功条件

你是 Relay-Agent 的后端修复 Agent，工作区 D:/Develop/Relay-Agent。先修当前已实现后端的真实失败，再收口回归。不要把本任务改成重做架构、只改提示词、重新采访产品需求或扩大新功能。

本次范围：

1. 修复 R1–R8：Skill/方法身份冲突，以及学习记录的失权、取消、删除、纠正、清除、依据与读取边界。
2. 把有效独立反例转为正式测试；修正已核实的迁移断言与 f24 并发测试时序。
3. 在保留维护门的前提下，尽可能完成自有隔离环境的备份/恢复复验；当前环境无法安全完成时，交付确切阻塞与已完成的其余结果。
4. 复验既有 NLS、Skill、助手/学习身份、调用计量、权限、回执、Run/恢复，同步受影响主文档。

成功条件：8个反例逐项红→绿，已有10个通过独立场景保持通过；正式定向及全量出口有真实结果，产品缺陷、测试问题、环境阻塞、跳过分别结算。没有真实 Provider/Windows/安装证据时，不宣称完整交付。

建议由当前 Agent 连续完成共享后端修复，避免拆开同一 runner/结算协议。确有独立审查或互不重叠子任务时，可按 AGENTS 派发：显式 model: "gpt-6.1-sol"，不选无法覆盖其他模型的角色；不可用时如实说明、由当前 Agent 继续可完成工作，不静默换模型。派发须明确所有权，并说明“你不是唯一修改仓库的人，不撤销其他人的改动”。

## 2. 开工前读取与现状核对

先读以下入口，随后只按定位需要阅读对应章节：

- [AGENTS](../../AGENTS.md)、[当前状态](../../CODEX_NEXT_STEP.md)、[文档地图](../../docs/README.md)。
- [功能验收表](../../docs/testing/overall-acceptance-2026-09-28.md#当前功能验收表)：2026-10-11“当前源码后端独立验收”行是本任务依据。
- [契约包](../../contracts/README.md)中事实、执行、验证、恢复相关约束。
- [领域模型](../../docs/architecture/domain-model.md)、[复用策略](../../docs/architecture/复用策略.md)、[ADR-005](../../docs/decisions/ADR-005-reuse-first.md)。
- [ADR-019](../../docs/decisions/ADR-019-builtin-methods-and-conversation-checkpoints.md)、[ADR-020](../../docs/decisions/ADR-020-learning-mode-record-protocol.md)。
- [Skill专题](../../docs/architecture/relay-skills.md)、[HTTP契约](../../docs/api/http-command-contract.md)、[物理设计](../../docs/database/physical-design-postgresql.md)、[测试计划](../../docs/testing/verification-plan.md)对应方法/学习章节。
- [学习实施任务书](../learning-mode.md)只用于核对已确认边界；[方法实施任务书](../builtin-methods-and-conversation-checkpoints.md)只用于理解既有实现。不要据此自动进入未授权阶段。

先核对 git status、HEAD、未提交改动和真实调用链。验收基准为 c61323d1d76777a89e6aaefd47eced280c0c1276 加当时共享工作区修改，不是纯净提交；后端 src/test/migrations 492文件在本轮验收中未漂移。新的并行修改可能改变现状，重新复现再下结论，保留他人所有改动。

当前源码已有学习工作包 B 的 learning-round、Context 与逐次调用接线，不要把较早“工作包 A、B 未实施、runner fail closed”的快照当作当前真相。代码存在与正式顺序测试通过不代表恢复/并发验收完成。

开工时给出简短计划：反例复现与协议核对 → 最小修复与正式测试 → 真实PG/HTTP独立复验 → 全量回归与文档。每一步注明验证方式。

## 3. 证据与失败分类

完整结果由验收表拥有，这里只说明如何使用证据。

本机忽略目录：D:/Develop/Relay-Agent/output/acceptance-raw/backend-acceptance-20261011/。

| 输入 | 用途 |
|---|---|
| integration-full.log | 全量77源套件868项：823通过、31失败、14跳过，exit1；migration/graph/start/stop exit0，临时集群已删 |
| unit-full.log、unit-restore-isolation-recheck.log | 全量541项：539通过、1失败、1跳过；唯一启动超时定向7/7，不覆盖首轮结果 |
| independent-probe.test.mjs、independent-base-final.log、nls-observations.json | 11个有效场景：前轮9个NLS反例与已提交蓝图命令重放通过，Skill身份失败 |
| learning-late-result.test.mjs、learning-late-observations.json | 失权Worker、取消先提交后CONTENT返回，两项失败 |
| learning-generation.test.mjs、learning-generation-observations.json | 最近20之外删除复活、已解除GAP仍进入未决项，两项失败 |
| learning-races.test.mjs、independent-races.log、learning-races-observations.json | 清除竞态、纠正与旧结算竞态、无可信依据写入，三项失败 |

独立有效场景共18：10通过、8失败。初轮探针曾有共享队列领取错误、BigInt观察JSON序列化错误，已修正并在逐文件独占库复验；不要把这些早期脚本错误当产品缺陷，不累加重复日志。

旧 run-independent.ps1 是当时运行辅助，解析已经停止并删除的临时PG集群地址，**现在不能直接复用其连接**。将有效探针适配进正式测试，或重新创建一次性集群与逐文件独占库；不得连接用户数据库或其他测试轮次的活动库。

正式31失败不能一律认定为产品缺陷：

- 11项为Skill/方法双快照：assist 8项，f24-proposal-idempotency 3项，归R1。
- 15项为backup 7项、restore 8项被 MAINTENANCE_SESSION_BUSY 阻断；用户非自有桌面当时PID34280仍运行，业务断言未走到，不是已证明数据损坏。
- 4项为cli 1项、migration 3项仍按70迁移断言，实际0071/0072追加后为72；全量已fresh build，不能归咎旧dist。
- 1项为f24并发测试未保证有效请求先获锁，归测试时序；先提交成功后同command异baseline重放已独立验证为409 COMMAND_ID_REUSED。

14个集成跳过中13个是Provider opt-in，1个是Windows helper场景。精确跳过条件以实际输出为准，不能伪造Provider调用或把跳过算通过。

## 4. 不得破坏的约束

- 单一Owner、Task/Run/Project State分离、原完成路径、权限/批准、原动作与command身份、UNKNOWN先核对保持有效。
- 保留 ck_assist_message_method_exclusive；保留数据库维护准入；不删除或倒改既有迁移，不降低约束来迎合测试。
- 不停用户桌面/数据库，不修改用户.env，不输出凭据，不盲目清理或强杀非自有进程。
- 模型、网络、工具与人工等待在事务外；屏障只在测试中用于明确提交顺序，产品事务只持有必要短锁。
- 学习记录由原Application Owner写入，学习会话对项目只读；不赋予Delegate、项目修改、文件写入或自动完成权限。
- 不新增常规评分/复盘模型调用；缺usage记未知；不复制全量学习档案到Context来掩盖版本漏洞。
- 不删除失败检查、不降低有效断言、不改测试成“只要没异常”；保留红灯并据真实输出修正。

## 5. R1：显式Skill与自然语言方法身份冲突（P1）

复现：AGENT会话发送显式 skill_ref project-resume@1.0.0，正文“请审查这个项目的当前状态”。requestAssistMessage仍执行自然语言方法识别，同一消息写 skill_snapshot 和 method_snapshot，触发数据库CHECK，HTTP500且消息全部回滚。

定位：apps/api/src/application/assist-commands.ts 的 resolveMethodRequest 与消息快照写入，迁移0071的互斥约束。

要求：

1. 显式Skill身份决定这条消息的处理入口；正文被当作Skill输入，不再自动绑定方法。保留显式同时传skill_ref/method_ref的既有422验证拒绝。
2. 没有显式Skill时，原自然语言方法、显式方法与聊天命令解析继续有效；不能全局关掉方法识别。
3. 身份决定进入原command幂等摘要和冻结快照；同命令重放仍返回原结果，异载荷仍COMMAND_ID_REUSED，不新建重复消息。

验收：真实HTTP返回原202契约，DB中skill_snapshot非空且method三列全空；推进tick确认走原Skill路由。正式assist、f24关联11项转绿；无Skill方法、显式双身份422、同/异载荷重放保留回归。

## 6. R2/R3：失权Worker和持久取消的迟到结算（P1）

R2复现：阻塞LEARNING模型返回，经真实failExpiredLeases把对应消息置FAILED/LEASE_LOST；放行CONTENT后tick返回DISCARDED，但learning_round SETTLED、证据新增1条。

R3复现：模型在途时真实cancelAssistMessage先持久化cancel_requested；放行CONTENT，消息仍COMPLETED且round SETTLED、证据新增1条。

定位：assist-runner.ts 的学习CONTENT分支、settleInTransaction/settleLearningIncrements，以及 learning-round.ts 的模型结果接收。

要求：

1. 学习证据提交必须校验当前消息/轮次、确切worker执行身份、取消与记录控制；正文CAS失败的旧worker无权结算增量。
2. 校验与实际写入处于一致短事务/锁边界，不能只在模型返回时或另一事务里查一次资格。
3. 取消先提交，未结算增量零新增并如实收口；结算先提交，再取消时保留先前合法提交，不倒删成功事实。迟到回答可按既有协议展示，但不得冒充保存成功。
4. 失效轮次不长期留PENDING；明确CANCELLED/REJECTED等现有协议结果。故障/重启沿原身份查询与恢复，不重新评价旧聊天。

验收：用可控模型屏障和真实Owner固定两个反例的提交顺序，断言目标messageId匹配领取结果；查消息、轮次、证据及调用账本。另验证“正文提交到学习结算之间取消/失权”的窗口，以及结算先提交的正向场景；失败结算不影响新worker合法工作。

## 7. R4/R7：知识点基线覆盖与generation竞态（P1）

R4复现：知识点A有证据，再插入其他知识点至少24条更近证据；旧round的最近20基线不包含A。删除A证据使generation推进，旧round仍写入A，已删记录复活。

R7复现：旧round完成generation校验后、insertEvidence之前暂停；人工correctLearningRecord先提交推进generation；放行旧写入，旧round仍新增OLD_ROUND_EVIDENCE。

定位：learning-records.ts 的 beginLearningRoundInTransaction、applySettlement；learning/learning-repository.ts 的知识点查询、锁与写入。

要求：

1. 调用前冻结的适用基线必须覆盖允许修改的既有目标；“未出现在最近20”不能被解释为无限制写入。对未冻结既有目标保守拒绝；合法新知识点须有独立可核验的创建规则，不能通过新建绕过删除代次。
2. 不在结算时读最新generation并吸收成旧轮基线，不为省事把全部证据正文塞进Context。
3. generation核对和证据写入必须与人工纠正/删除有真实CAS或同一行锁序列；校验后发生人工提交，旧轮不得越过校验继续写。统一必要锁顺序，避免与epoch/消息锁死锁。
4. 原纠正的自述、历史证据、命令回执保持；无关知识点的合法轮次不会全部失效。明确同一轮内部CORRECT的后续增量语义。

验收：两个反例分别红→绿；数据库确认旧证据未复活、人工generation保持、旧结算类型化失败且无部分写入。补当前有效基线、新概念合法创建、同轮多增量、无关概念并发、删除/纠正同command重放与异载荷拒绝。

## 8. R6：全清与并发begin/settle的epoch边界（P1）

复现：clear已完成取消/删除扫描，在bumpEpoch前暂停；此时新round冻结epoch0并结算；放行clear成功返回epoch1，查询仍可见epoch0证据。

定位：clearLearningRecords中的清除顺序、epoch仓储、begin/applySettlement及记录查询。

要求：

1. 清除、开始轮次、提交增量建立一致workspace epoch序列。clear提交后旧epoch证据不得残留为当前内容，也不得被旧回执/Context恢复。
2. 单纯调整语句顺序或查询隐藏不足以证明删除协议；核对持久证据、概念、相关缓存与最小控制元数据的清除范围，既保留防复活控制，又不保留可复原评估正文副本。
3. 新epoch下用户重新开始的合法教学仍可保存。不得把所有并发新交互都禁止或删除。
4. 清除回执重放不重复推进epoch；响应丢失查询原身份；事务失败整体回滚。

验收：固定清除扫描到epoch推进的原反例；同时测试清除先提交/结算先提交两种顺序，以及epoch1合法新round。查当前GET/continuation/Context和真实DB行，不能只断言返回epoch变大。

## 9. R8：缺乏本轮可信依据仍写“实际表现”（P1）

复现：本轮用户只有“跳过”；经学习Owner提交无可信依据引用的OBSERVE候选，detail声称“用户已经完整回答并解释了幂等性”，应用仍保存OBSERVED。

这是应用Owner负向注入，证明保存前校验缺失；不是已运行真实Provider并观察到幻觉。

要求：

1. 按ADR-020冻结并落实有限增量的依据绑定：依据存在、属于本轮、性质匹配；不要无条件把每条候选的source_message_id写为模型消息就当通过。
2. 应用检查本轮真实用户输入/表现与可允许的证据性质；仅跳过或无实质回答不产生OBSERVED/GAP升级降级。EXPOSURE、SELF_REPORT、OBSERVED、GAP分别保留语义。
3. 缺依据、跨轮引用、助手伪造用户发言、引用失效或性质不符时拒绝相应增量；合法教学正文仍可读，并有可核对的未保存原因。
4. 不靠system prompt一句“不要编造”修复，不新增常规评估调用；可信绑定所需类型/schema/Fake/Provider解析同步，旧AGENT/ASSISTANT协议保持兼容。
5. 若扩展输入/输出形状，明确兼容与Breaking Change，不用可选字段兼容为由让旧无依据候选继续写入。

验收：原Owner直接负向注入必须拒绝且零新增；补缺引用、跨消息/跨会话、跳过与无回答、讲解被冒充表现、自述被冒充验证，以及具备本轮真实回答和合法引用的正向候选。Fake只验证协议与控制，真实教学质量保持未验证。

## 10. R5：已解除GAP仍进入未决接续（P2）

复现：GAP后RESOLVE_REVIEW已把disposition置SUPERSEDED，continuation与教学Context仍因kind===GAP将其列入open_items。

要求：两个读取入口使用与当前处置状态一致的规则；SUPERSEDED/WITHDRAWN不再作为当前未决缺口，仍保留可追溯历史；真正待复核项继续可见。不要只改某个界面或删除历史行。

验收：GET continuation与实际模型Context均不包含已解除GAP的open_items；待复核GAP和其他真正未决项保留，历史查询可核对原证据和解除结果。

## 11. 修正测试与隔离环境，保持产品约束

### 11.1 迁移与CLI断言

核对源码迁移清单、实际manifest/hash和upgrade路径，同步CLI及migration测试。migration测试的ALL_MIGRATIONS当前止于0070，另有旧schema升级applied清单需逐项核对，不能只把一个70机械改72。

保留完整迁移名、hash、重复执行零新增、旧schema升级、0071方法互斥及0072学习表/会话约束的实质断言。若执行时并行工作又追加迁移，以真实新基准为准；不能删0071/0072、倒改旧迁移或放松hash校验。

### 11.2 f24并发时序

现测试同时发送同command的baseline0有效请求和baseline7无效请求，只确认二者在锁后等待，不保证有效请求先取得候选锁。无效请求先取得锁、尚无成功receipt时返回INVALID_TRANSITION是合法路径；随后有效请求200，不足以证明幂等损坏。

优先用既有holdReceiptInsert等屏障保证有效请求先持候选锁且提交，再让异载荷请求核对原receipt；或先成功提交后验证重放。保留同载荷并发收敛、异载荷409 COMMAND_ID_REUSED实质检查。不要为迎合此测试给尚未成功提交的command添加全新身份预占协议。

### 11.3 backup/restore与启动时序

先核对维护身份和非自有实例占用原因，使用自有隔离dataRoot/数据库/明确进程边界。只可停止本任务创建且身份已确认的进程；现有用户桌面PID只是历史定位线索，不能硬编码停它。

若合法维护门必须整机无活动桌面而当前无法满足，保留MAINTENANCE_SESSION_BUSY并标环境阻塞，不改成通过、不放宽准入、不把before hook波及当备份数据损坏。执行独立可完成场景，留下确切补验命令与前置条件。

单元restore-isolation首轮8秒API启动超时、单独7/7已通过；先查可控负载/启动输出与ready事实。没有稳定产品复现时，不盲改运行时或一律拉长超时。完整复跑与定向复跑分别记录。

## 12. 复验顺序与实际命令

先把有效探针转为源码正式测试，确保修复前有红灯；修复后由当前Agent独立操作一次关键反例，直接读PG/HTTP事实，不只读测试汇总。可控屏障不省略真实Owner、角色、事务与唯一约束。

R8若新增严格依据协议，R2–R7和正向场景的fixture必须同步提供本轮真实且合法的输入/引用，并断言已经到达目标模型返回、generation校验、清除或提交屏障。不能让旧fixture因缺新字段提前被schema拒绝，就宣称取消、失权、epoch或generation漏洞已修复。先核对每个场景的确切触发点，再读取最终事实。

从工作区根目录执行前核对runtime路径与脚本参数；以下是本轮已用入口：

~~~powershell
$taskNode = 'D:\Develop\Relay-Agent\.research\runtime-cache\node-v24.21.0-win-x64\node.exe'
& $taskNode apps/api/node_modules/typescript/bin/tsc --noEmit -p apps/api/tsconfig.json
& $taskNode apps/api/node_modules/typescript/bin/tsc -p apps/api/tsconfig.json
cargo build --locked --target x86_64-pc-windows-msvc --manifest-path apps/file-io-helper/Cargo.toml
$env:RELAY_FILE_IO_HELPER = 'D:\Develop\Relay-Agent\apps\file-io-helper\target\x86_64-pc-windows-msvc\debug\relay-file-io-helper.exe'
powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1 -UseCLocale -TestFile assist,f24-proposal-idempotency,chat-commands,learning-records,learning-round,conversation-state,project-daily-continuation,project-return-review
~~~

检查每条实际退出码；不要让后续成功命令覆盖前一条失败。新增正式测试文件须加进定向清单。runner可逐源码枚举套件、每套独占库，不复用旧dist残留；SkipBuild只在本轮当前基准已成功构建后使用。

复验层次：

1. R1–R8定向红→绿，10个先前通过独立场景回归。
2. 定向assist/Skill/方法、learning-records/round、NLS与回执/投影故障。学习调用/重试核对recordModelInvocation及未知usage，不用消息usage汇总代替逐次账本。
3. 权限与旧身份、Project State零非法写入、控制/恢复、UNKNOWN、审批失效、Task/资源排他和完成竞争的受影响回归。
4. 后端全量单元：fresh build后按当前 apps/api/test/unit 的源码文件映射到dist运行，排除陈旧编译文件但不删除源码检查。保存所有失败与跳过。
5. 后端全量真实PG/HTTP：

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1 -UseCLocale
~~~

6. 文档检查：

~~~powershell
& $taskNode scripts/check-docs.mjs
~~~

若触及共享DTO/parser或会话枚举，再运行必要前端类型/相关回归；不实施新UI。没有新增问题或源码变化时，不无理由反复重跑全量。

检查临时集群、探针库、dataRoot和自有进程清理。Windows递归清理先核实绝对路径在本任务范围，使用LiteralPath，不删除不明路径。只保留本机忽略目录里的完整输出与必要受控测试代码，不提交凭据或日志堆。

## 13. 继续开发与停止边界

本次可以继续补齐**R1–R8修复所必需**的学习后端协议、Owner校验、恢复与读取接线；这些属于已冻结规则的实现，不需要再次征求例行读取/测试/可逆修复许可。

8项未闭合之前，不进入依赖其可信结果的新能力。完成本轮后，给出剩余学习B/C/D、方法后续阶段或调用版本审计的事实与推荐下一步，**不自动启动**学习前端、转执行新流程、DeepSeek协议/压缩/检查点、消息文件撤回、外部成果新功能、真实Provider成本或Windows/安装专项。

遇到共享文件发生并行变化：暂停冲突部分、核对最新事实并继续不受影响工作，不reset/stash/clean他人改动。只有缺少用户决定/实际权限、不可规避的环境门或确切协议冲突时请求必需信息，说明来源和已完成工作；不要用“全量没全绿”当作停止修复其余明确问题的理由。

不自动commit/push、合并或发布。禁止用exit0伪造、删除断言、fixture或模型文字替代业务完成与验收。

## 14. 文档与最终交付

文档维护属于本任务。当前结果只更新[功能验收表](../../docs/testing/overall-acceptance-2026-09-28.md#当前功能验收表)，当前阶段/下一步只更新[CODEX_NEXT_STEP](../../CODEX_NEXT_STEP.md)；本任务书只维护执行范围，不叠加测试流水账。

按实际影响同步HTTP契约（注明Breaking Change与兼容）、物理设计（若新增迁移，注明迁移/兼容/回滚）、测试计划及对应架构/ADR。R1–R8若已有ADR约束，只补实现落点与必要取舍，不为每条Bug新建ADR或报告。历史红灯按时点保留，新成绩绑定新基准。

完成Documentation Impact Check：需求、架构、ADR、API、数据库、开发记录、测试、README、路线图、变更与已知问题；只更新真正受影响项。运行check-docs，并人工核对当前/历史、链接和Owner描述。

最终用中文交付：

- 每项R1–R8的状态、根因与最小修改、实际红→绿结果。
- 正式测试问题与环境阻塞分别列出，不计算混合“总成功率”。
- 精确命令、退出码、受验版本、全量通过/失败/跳过，独立复验的DB/HTTP事实。
- 已同步文档、未运行Provider/Windows/安装及其边界、临时资源清理结果。
- 剩余限制与推荐下一步。未闭合项明确写失败/阻塞/未验证，不宣称后端整体或学习模式全部完成。
