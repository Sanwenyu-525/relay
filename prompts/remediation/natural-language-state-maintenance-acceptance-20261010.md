# 自然语言状态维护与自动接续：复验后整改提示词

更新：2026-10-10。当前输入为[统一验收表](../../docs/testing/overall-acceptance-2026-09-28.md#当前功能验收表)的「自然语言状态维护整改独立复验」行；阶段以[CODEX_NEXT_STEP](../../CODEX_NEXT_STEP.md)为准。本文件更新原整改任务书，不新增第二份同范围提示词。本次交付为提示词；实际成绩只在统一验收表维护。

```text
在 D:/Develop/Relay-Agent 接续“自然语言状态维护与简化接续流程”的整改和剩余实施。由当前 Agent 单独完成实施、测试、真实场景复验和文档同步，不派子代理、不创建其他聊天、不向其他任务发送材料、不自动创建 Codex goal。不指定或切换模型。

所有说明使用中文。你收到的是可执行任务书，先简短说明当前基准、范围、顺序和成功条件，然后实际推进。已确认的产品选择从现有文档继承。不要以另一份计划代替执行，也不要因为局部验证环境受限省略可独立完成的工作。

一、当前事实与执行边界

1. 先读 AGENTS.md、CODEX_NEXT_STEP、统一验收表最新的独立复验行，再按范围读：
   - Personal_Workflow_OS_Master_Spec.md §0.8.1。
   - docs/requirements/v1-scope.md 与 post-v1-roadmap.md。
   - docs/frontend/workbench-design.md §18.9。
   - docs/architecture/domain-model.md §12.5。
   - docs/testing/verification-plan.md §24。
   - docs/api/http-command-contract.md §10.61/10.62。
   - docs/database/physical-design-postgresql.md §63–§67。
   - contracts/README.md 所指的相关状态、事务、幂等、完成和恢复契约。
   prompts/natural-language-state-maintenance.md 用于核对原实施范围，其历史并行要求由本次“不派子代理”覆盖。

2. 先核对 Git 与未提交改动。受验基准曾为 HEAD 216a41b＋未提交源码；执行时重新核对，不盲用旧行号、旧 PID 或旧 dist。保留他人改动，不 reset/stash/clean，不顺手重构，不自动 commit/push/部署。

3. 产品目标：用户用一句明确指令维护既有项目事实，应用沿原 Owner 写入，页面立即展示变化、结果及下一步，需要决定的连带影响明确提出。简化操作仍保留确切目标/版本、权限、原命令身份、短事务、完成条件和 UNKNOWN 核对。模型输出、页面成功提示和按钮确认不能替代领域提交或执行权。

4. 当前独立验收：正式后端定向 84/84、相关单元15/15通过；有效独立 PG/HTTP 9项中3通过、6失败。前端全量首轮857/858，SSE时序失败隔离复跑及整轮复跑通过，最终858/858；首轮输出保留。不能用这些绿色结果宣称整体完成。

5. 原始输入位于本机忽略目录 output/acceptance-raw/nls-reacceptance-20261010/：
   - independent.log、nls-observations.json、nls-probe.integration.test.mjs：有效9项场景。
   - plugin-decline-facts.json、plugin-final-facts.json、decision-decline-applied.jpg、task-undo-false-conflict.jpg：真实Chrome页面和数据库事实。
   - targeted.log、unit-targeted.log、frontend-r2.log、summary.json、cleanup-summary.json。
   independent-r2.log 的两个新增故障测试没有处理预期注入异常，属于早期探针错误；主 independent.log 已修正并重跑。私有浏览器初始脚本导入错误、前端定向首次cwd错误也排除于产品缺陷。不要把这些脚本错误当成新的产品反例，不合并重复运行的计数。

6. 上轮10个失败反例已进入正式回归；批准材料绑定、确定拒绝收口、原Task接续、严格撤权已有通过证据。它们属于必须保持的回归，不重新建设。原0062–0066迁移保留；需要持久化变化时追加migration，不改已应用迁移。旧数据缺少可信基线时保守澄清/拒绝，不能读最新版本冒充原基线。

二、执行顺序与工作方式

先修三项会违背用户决定或覆盖事实的缺陷，再修任务撤回、决定回执、展示绑定；六项及相关恢复回归通过后，接续第五节未完成的产品流程，最后完成浏览器和可用的Windows验证。

每项按“正式测试复现红灯→最小修复→原场景绿灯→必要回归”推进。不要为红灯回退整个工作区，不删失败检查，不把错误改成exit0。测试必须调用生产Owner和实际HTTP/PG，读取落库事实、原命令回执和审计，不只断言自建状态机或返回对象。

实现与复验由同一个Agent分开执行：修完后从正式入口重新构造场景，独立读取事实，不把自己的组件Mock当实际完成证据。每组修复完成给出简短结论与剩余项。

重点文件以实际调用链为准：
- apps/api/src/application/conversation-state.ts：interpret/apply/reply/withdraw及基线。
- apps/api/src/assist/conversation-state-repository.ts：持久身份与CAS。
- apps/api/src/application/task-commands.ts：原SetTaskPlanningMetadata Owner。
- apps/api/src/application/project-daily-continuation.ts。
- apps/api/src/project/project-daily-view-repository.ts。
- apps/api/src/api/state-maintenance-api.ts、project-daily-continuation-api.ts及schema。
- apps/workbench/src/views/AssistView.tsx、components/DailyContinuationCard.tsx及对应api/dtos/parse。
- 对应正式integration/unit/component tests及现有Gateway、Verification、Review、完成、控制与恢复入口。
不要为了此次整改拆工程、改编排器、新增通用DSL或维护第二套业务状态。

三、六项已确认缺陷与必须通过的反例

R1（P1）：DECLINE被当成接受，用户“不调整”后仍自动生效

复现：创建需要决定的SET_PHASE请求，读取原请求及展示revision，用resolution=DECLINE和“不调整，保持原发布承诺”提交decision-replies，再进入原applications。当前结果是READY→APPLIED。Chrome页面点击“不调整”同样显示“全部生效”，真实DB进入RELEASE。

修复要求：
- 接受、拒绝和重新澄清具有不同语义。拒绝不能仅清空decision_required然后将原候选重新设为READY。
- 拒绝只结算受这项决定约束的变更；此前独立且合法生效的修改保留，不擅自补偿或撤销整组。
- 被拒绝的变更不由自动应用effect、重复applications、刷新或重启再次执行。
- 保留原问题、受影响范围、答案、resolution、展示版本、命令身份和审计，决定提交在短事务里完成。
- 页面明确表达哪些已生效、哪些按用户决定未执行；拒绝不能显示“全部生效”或“已存在”。
- “同意/按推荐来”绑定原请求与实际展示内容；自由文字与选择不一致或仍有歧义时澄清，不能把任意非空回答当成接受。

正式测试：全部受阻时DECLINE零业务写入；部分独立修改已生效时拒绝只阻止剩余项；ACCEPT正向；重复提交；刷新/重启；旧展示版本；两个不同command同时回答同一版本只允许一个合法提交。expected_revision必须在实际写事务/CAS中核对，不能只有事务前读取检查。

R2（P1）：既有Task计划变更未冻结revision，旧候选覆盖后续人工修改

复现：解释既有任务priority=HIGH，应用前经原Owner把同一任务改为LOW；再应用原候选。当前读取最新Task revision写入HIGH，并宣称APPLIED。

修复要求：
- 冻结确切Task身份与适用revision，应用沿原Owner携带原期望版本；不以标题重新绑定替代对象，不取最新revision覆盖冲突。
- 只修改指令明确给出的字段，其他优先级/日期/时区保持原值；不要因为提到任务就重复创建Task。
- 原请求同一对象连续多条合法变更可以按自己的已提交回执推进版本；这条链不能吸收请求外的人工修改。
- 明确区分不存在、重名、归属变化、归档、版本冲突及本组后创建的对象；缺失可信旧基线不猜测。

正式测试：旧priority/due候选与后续人工修改冲突时保留当前值；同值修订仍识别冲突；目标替换拒绝；多条自有写入不误报冲突；模型未给出的字段不清空；Task数量不增加；同命令重放无第二次更新。

R3（P1）：模型在途时的新State修改被解释结算的最新revision吸收

复现：原用户消息要求IMPLEMENTATION，模型调用挂起；从原state-command把项目改为RELEASE；释放模型再应用原请求。当前结算时取最新revision当原基线，最终覆盖成IMPLEMENTATION。

修复要求：
- 在异步解释之前，经应用入口持久冻结该意图所依据的对象身份/适用版本；解释结果与这一基准关联。
- 不能把模型返回时间当成用户再次确认，更不能在结算时将并发新修改绑定成原指令的授权基线。
- State和相关目标基线应有一致的读取/持久化关系，模型/网络等待不进入长事务；选最小协议，不复制完整领域正文形成第二事实源。
- 解释失败、响应丢失、进程重启仍沿原请求和原基线恢复；UNKNOWN不盲重发调用、不换命令绕过。
- 对未能在原基准确定的对象保持明确的澄清/适用性规则，同组新建对象可按确切原创建回执关联。

正式测试：模型在途人工SET_PHASE、同值revision推进、下一步或Task变化、目标重名/替换；原命令重放；故障和并发时不会把新事实吸收进原基线。记录模型调用次数及真实revision，不能靠普通顺序测试替代这一在途场景。

R4（P2）：Task after_ref保存生效前版本，正常撤回必然误报冲突

复现：Task v0，经状态维护设HIGH后真实Task v1，after_ref.task_revision仍为0；没有任何后续修改，undo-plan却返回TARGET_VERSION_CONFLICT，页面没有可选撤回项。

修复要求：
- after_ref绑定原Owner此次提交返回的确切新revision和事实，不能保存生效前版本，也不能提交后再读最新版本吸收别人的写入。
- before_ref可恢复并正确保存；回执重放仍还原这一原命令的before/after关系。
- 无后续修改可以撤回；有后续合法修改先展示具体冲突与影响、一个补偿都不擅自执行。
- 预检到补偿提交之间也必须核对版本；补偿Owner不能读取最新revision强行恢复旧priority/日期。
- 同组多条Task变更按原逆序与已提交补偿回执恢复，不误认自己的补偿是外部冲突。部分范围与plan_digest绑定，不能偷换确认范围。

正式测试：priority、日期/时区、混合字段正常撤回；后续人工修改阻止撤回；预检后再修改；同组多项逆序；重复撤回；Owner提交后变更回执保存前中断；补偿提交后COMPENSATED保存前中断。已有State这两个提交后恢复正向场景必须继续通过。

R5（P2）：决定已经提交，原command重放先撞当前状态校验而返回409

复现：对原DECISION_REQUIRED用command C提交ACCEPT，第一次200；模拟响应丢失，携带完全相同载荷重发C。当前因decision_required已清空返回409 INVALID_TRANSITION。

修复要求：
- 原command的回执与载荷核对先于“当前还在等决定”的可变状态前置条件；同命令相同内容按原提交结果重放。
- 同command换答案、resolution、request或展示revision，严格COMMAND_ID_REUSED；不能用“已经不等决定”掩盖载荷复用。
- 归属、Workspace与可见性仍成立；回执重放不构成新的授权，不接受别的请求或工作空间的身份。
- 决定已提交但后续applications尚未完成时，沿原请求读取/恢复，不能重造决定或重复执行业务效果。
- 前端响应丢失重试沿用原command_id，不能每次点击都换ID；读到已决定事实后正确恢复UI。

正式测试：相同命令200重放；同命令不同载荷409；真实响应丢失；同时重复；决定提交后应用前重启；应用后再次重放；旧版本新命令拒绝；跨Workspace拒绝；审计与业务写入均恰一次。

R6（P2）：查看序号只校验上限，未绑定真实展示身份和事实

复现：GET取得合法presentation_seq；POST换一个未签发UUID、viewed_state_revision=999999和虚构事实。当前200并写入基线，真实后续查看因revision更小无法推进。仅断言seq大于上限被拒绝不能证明展示绑定。

修复要求：
- 确认绑定Workspace/Project、实际签发的presentation_id与seq、当次State版本及确切已展示事实摘要/引用。
- 序号位于已签发上限内不等于这份身份/内容实际签发过。拒绝身份替换、seq嫁接、跨项目复用和事实/版本篡改，不写基线。
- 保留合法多次展示及并发首插、同展示重放、同State revision的Task变化推进、迟到旧确认不覆盖等既有语义；不能只保存最后一次展示而拒绝其他合法在途确认。
- 展示顺序与事实快照要一致，覆盖两次GET重叠、Task在读取期间变化的场景；不要用请求开始顺序冒充事实快照的新旧。
- 只保存必要元数据/事实摘要和原身份，不复制第二套业务状态，不新增通用历史系统。保留命名接续点N01语义。
- 历史旧基线/新协议的兼容和数据处理明确记录；原已污染基线不能永远挡住正常查看，应给出可追溯的识别与恢复办法。

正式测试：随机未签发ID配合法seq；错误ID/seq配对；伪造未来/不存在revision；替换phase/task refs；跨Project/Workspace；合法旧展示迟到；新展示先确认；旧展示先确认；Task-only变化；并发读取与确认；首插竞态；200以上任务截断/未知；污染旧基线恢复。拒绝必须保持基线、回执和审计一致。

四、六项修复必须保持的正向与恢复出口

- 任务新增而State revision不变：查看确认后再返回，不反复报告“新增1项”。
- 应用领域提交后、APPLIED保存前中断：原请求/命令恢复为真实APPLIED，效果恰一次。
- 补偿领域提交后、COMPENSATED保存前中断：原undo_command_id恢复UNDONE，补偿恰一次。
- 原10个反例的正式回归保持，不重做已修复内容。
- 材料绑定、批准后漂移拒绝、真实RESUME Permission撤销、SC-13范围授权语义、确定拒绝生命周期与原Task接续保持。
- 整组事前不能撤回时一个补偿都不执行；选定范围之前不给出已撤回结论。
- INVALID模型输出整单澄清；同原消息并发不重复解释；跨Workspace不产生写入。

故障点覆盖“调用前、领域提交后、逐条回执保存前后、请求结算前后、HTTP响应丢失”。分别证明业务事实、原回执、状态和审计；不能把执行失败、确认缺失、响应未知混成同一失败状态。

五、修复后继续原任务书尚未完成的产品流程

六项依赖出口通过后继续以下范围，不在修六项后直接宣称原任务全部完成。先核对当前V1、已确认设计和原Owner，提出最小对象/用例映射；仅对确实影响承诺且仍未确认的分支提出具体决定。

1. 自然语言纠正与撤回
   “撤回刚才那次调整”绑定同会话实际展示的原请求及原undo_command_id，复用按钮撤回的同一应用用例、undo-plan与范围决定。不存在、重名、多个候选或已被后续修改时展示具体问题，不猜原对象。完整不可撤回时先给出每项影响，由用户决定范围；后续一句“只撤回阶段”仍绑定该方案，不重新生成另一组修改。按钮与自然语言结果同源，刷新/重启可恢复，模糊措辞不执行。

2. 既有对象与必要决定续答
   “导出下周再做，本周优先搜索”沿原Task/State入口，不重复建Task。“不是导出，是搜索，时间保持原样”只修正相关对象/字段；“同意/按推荐来”对应原展示决定；“不调整”阻止对应承诺变化。刷新项目/任务/详情后事实一致，失败和连带影响在摘要可见。
   对需求、计划、Goal内容调整，明确哪些属于当前已确认范围、哪些是后续设计。已有领域Owner则复用；当前范围明确要求而缺Owner则提出并落实最小契约；超出当前范围不建设整套需求/计划系统。不能将创建/关联白名单称为完整对象维护。

3. 外部成果核对（原Slice B）
   在自有隔离目录真正产生/修改成果，再从原项目对话发“其他工具已经做好，请核对并同步”。检查必须沿现有Permission/Gateway/Verification，合法完成经原完成Owner，绑定确切Artifact版本、条件与人工接受；自报做好不等于业务完成。
   覆盖不存在、错误分支、成果或条件改变、旧PASS不适用、FAIL/ERROR、人工体验未接受、已满足原条件、重复同步、响应丢失、UNKNOWN。无权限零调用，UNKNOWN先按原身份核对。成果核对、人工接受和业务完成分别表达。不要增加任意Shell入口、绕过批准或替代原Run/Operation身份。

4. 返回轻量检查（完整Slice C）
   基线查询/顶部卡不是检查运行。返回时比较实际已查看的差异，无变化且证据适用时复用，有变化只核对相关授权范围。触发有持久身份，重复打开不重复外呼，真实账本证明做过什么。
   实施已有授权与预算内的必要轻量核对，不擅自开启修复、新Task或持续监控。范围/预算缺具体决定时展示推荐方案、影响与已完成工作；不要让用户重复回答已确认产品选择。
   覆盖权限/材料撤销、资源占用、预算不足、待批准、取消、进程重启、证据版本变化与UNKNOWN恢复。不为卡片伪造Run，不由UI直接启动进程，不新增通用编排器。

六、验证入口、浏览器与环境

固定仓库Node v24.21.0、便携PG18.6和当前debug file helper，不升级依赖。测试子进程清除RELAY_MODEL_*和RELAY_REAL_*真实Provider opt-in，不读/改用户.env，不输出凭据。API编译独占共享dist，不与另一编译/测试在途改同一产物。正式PG套件各用独占测试库。

PowerShell参考命令；先核对路径/运行器存在，每个原生命令单独记录LASTEXITCODE。

    Set-Location D:\Develop\Relay-Agent
    $relayNode = (Resolve-Path .research\runtime-cache\node-v24.21.0-win-x64\node.exe).Path
    Push-Location apps\api
    & $relayNode node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
    & $relayNode node_modules/typescript/bin/tsc -p tsconfig.json
    Pop-Location

编译成功后：

    powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1 -SkipBuild -UseCLocale -TestFile conversation-state,project-daily-continuation,check-trust-gate,check-trust-refusal-lifecycle,api-state,cli,migration

新增正式套件纳入列表。先运行六项红→绿与相关恢复，再运行正式定向；通过后按最终源码跑一次必要全量单元/PG，不把历史dist临时探针混入正式名单。单元从当前test/unit的源码文件映射dist，按--test-concurrency=1的稳定基线运行。完整PG：

    powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1 -SkipBuild -UseCLocale

前端命令在apps/workbench工作目录执行（仅加--root不能修正使用cwd的源码断言）：

    Push-Location apps\workbench
    & $relayNode node_modules/typescript/bin/tsc --noEmit
    & $relayNode node_modules/vitest/vitest.mjs run tests/conversationStateMaintenance.spec.ts tests/dailyContinuationCard.spec.ts tests/collaborationWorkspace.spec.ts tests/run-events.spec.ts
    & $relayNode node_modules/vitest/vitest.mjs run
    & $relayNode node_modules/vite/bin/vite.js build
    Pop-Location

首轮SSE时序失败已有真实记录，不删除或增宽断言消红。新变更/失败/未闭合风险才追加复跑；报告首轮与复跑各自事实，不只挑最后一份绿色输出。

真实浏览器必须实际操作：
- 有浏览器插件时使用自有真实API/PG页面，操作后读取新状态；复用已有运行器，必要私有适配仅放本机忽略目录。
- 组合验证“明确指令→独立修改/连带决定→接受/拒绝→已有Task调整→自然语言纠正/撤回→查看差异→外部成果核对→返回轻量检查→刷新/自有进程重启”。
- 至少独立复验“不调整不执行”和“无后续修改可撤回Task”，同时读取DB/原回执；不能只看toast或组件Mock。
- 对真实检查读取Invocation/Verification/完成记录，证明零调用、恰一次或UNKNOWN核对。
- 可控模型仅证明确定性业务链，私有回环凭据适配器不证明产品认证；真实Provider解释质量只在既有有效授权与配置内补验。
- 保存必要截图并在交付引用，不导出敏感DOM/会话/令牌。

Windows使用匹配最终源码的应用与自有实例，检查独立窗口、中文IME、窄短窗、焦点/键盘/滚动/草稿与重启接续。工具仅支持浏览器时先完成浏览器范围，再明确独立窗口未验；不伪造桌面证据。安装/升级/卸载只在已有明确授权的隔离范围操作，否则保留未验。

维护占用边界：前轮实施full-pg.log实际为73源码套件825条：796通过、15失败、14跳过、exit1；15条是backup7＋restore8 MAINTENANCE_SESSION_BUSY。不要再沿用“约74/790”的误计数。用户桌面最近核对PID34280、2026-10-08启动；每次重新核对实际归属，不按旧PID停进程，不关闭维护门、连接栅栏或用户库换绿色。能独立执行的工作先完成，维护族仅在不占用用户实例的合适环境补验，未跑的15条不计通过。

七、文档同步、清理与验收出口

文档维护随实现完成：优先原Owner文档，需求/架构/API/DB变更才更新对应事实源；新增migration说明兼容/数据处理/回滚风险，API注明Breaking Change。测试计划维护场景规格，成绩只写统一验收表，阶段只写CODEX_NEXT_STEP；不每轮新建重复验收报告、不导出全仓SHA清单。

    & $relayNode scripts/check-docs.mjs

同时人工核对事实、当前/历史边界和链接。不要因仅写提示词把功能改为已完成。

自有PG/API/UI/Worker/浏览器标签均清理，Windows递归删除前核对绝对目标与允许目录；不动用户进程或他人Temp。分别核对测试、migration、graph、PG启停、清理退出码；清理成功不代表测试通过。

出口分别结算：
A. 六项整改：每项正式红→绿，独立原场景通过，已有3项正向和原正式回归不退化；拒绝、版本、幂等、展示、并发与提交后恢复均有真实事实。
B. 产品入口：既有对象调整、原决定接受/拒绝、自然语言纠正/撤回能从页面完成，刷新/重启同源。
C. 原B/完整C：外部成果核对与轻量检查有真实准入、持久身份、适用证据、预算和恢复；满足原条件才合法完成。
D. 组合交付：真实浏览器完成，Windows/Provider/安装各自有证据或明确未验/环境限制。
局部通过不能提升为完整A/C或原任务全部完成。必要授权/环境/产品承诺决定确实缺失时，完成可独立部分后列具体缺口、推荐方案和最短补验路径；不能因上下文或时间压力自行缩成只做一部分后宣布完成。

最终交付：
1. 从产品入口能实际完成什么、仍不能完成什么，分清已实现/自检/场景复验/未接入/未验。
2. 六项原反例、正式测试位置、红→绿、实际对象值/revision/原回执与UI结果。
3. 代码/文档、API/DB变化与兼容策略，不新建无意义文档。
4. 本轮实际命令和通过/失败/跳过/退出码，区分产品缺陷、测试断言、探针错误与环境阻塞；按真实源码名单和原输出计数。
5. 自有资源清理、保留的用户实例、必要截图和本机原始输出路径。
6. 各出口完成情况、剩余项及推荐下一步。完整出口未闭合明确写部分完成，不写“任务全部完成”。
```