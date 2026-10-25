# 产品总纲：分册 02

角色：所属专题的唯一正文分册；2026-10-25 按原章节迁移，不改变原业务规则、日期、状态与证据范围。

[返回专题路由](../../../Personal_Workflow_OS_Master_Spec.md) · [文档总入口](../../README.md)

按需读取本分册内的相关小节；跨章节约束沿链接核对，不能把本分册或历史措辞单独当作完整实现/验收结论。正文中的源码与命令路径沿用原有口径。

## 0.15 聊天目标与计划模式

2026-10-20，用户逐项选择并最终确认汇总。**产品设计已确认；后续已接入计划版本、目标推进和会话 UI 源码，完整运行出口尚未闭合，实际成绩只归统一功能验收表。** `/goal` 是会话中的持续目标执行模式，不等于第 4 章领域 Goal；`/plan` 是行动前规划模式，不等于 N04 时间安排或单次 Run 的步骤清单。切换模式不自动创建正式业务对象，执行仍沿原领域入口。

| 模式 | 行为与结果 |
|---|---|
| `/plan` | 调查、读取、必要的只读验证、聚焦澄清与方案比较；默认不修改项目。形成有版本、可修改的结构化计划：目标、范围、步骤、验证方式及待定事项，等待执行决定。默认留在会话，需要交接或长期留存再导出文件；需要写入的试验或原型先明确范围并取得用户授权 |
| `/goal` | 明确成功条件后持续实施、验证和修正；能确定的先推进，目标、权限或不可逆操作有关键歧义时先问。简单目标自动整理成功条件，复杂目标与用户确认。依据实际证据核对完成，需要人工验收的结果等待原验收流程；步骤完成、代码写完或模型声明均不替代目标达成 |

**持续执行**：不设应用额外的总时间、总轮次或总调用次数上限，直到目标完成或可用额度耗尽；用户暂停、取消、需要用户决定的事项及真实阻塞仍会停止推进。关闭页面后继续；服务重启后核对现场再恢复。额度耗尽保存进度，额度恢复后点击「继续」接续原目标，不自动重启。不放宽单次请求技术限制或已有权限，额度含义、识别来源和未知情况处理待工程核定，不承诺绕过服务商限额。

**调整与插话**：已有权限允许的操作自行推进，不逐步骤确认；改变目标、扩大范围或增加权限时先问。可自行调整方法和步骤，展示原因与剩余工作；连续尝试无进展时报阻塞。补充要求融入后续执行，询问进度只答状态；与原目标冲突时先暂停受影响行动并澄清。暂停、取消、先讨论改变执行状态；取消保留已发生操作记录，不自动撤销修改或外部效果。

**入口与切换**：命令发送后生效，菜单点击只预填；支持自然语言及输入框旁模式选择，当前模式可见。新会话默认普通模式，恢复旧会话显示保存的模式与状态。「按此计划执行」沿选定计划版本进入 `/goal`，不重复收集已有需求；活动目标要求先讨论时，安全暂停后进入 `/plan`。

UI 只归[工作台 §44](../../frontend/workbench-design/part-14.md#44-聊天目标与计划模式)，工程边界归[运行架构 §9](../../architecture/runtime-context/part-03.md#9-聊天目标与计划模式的运行边界)，分期归[后续路线 §13](../post-v1-roadmap/part-02.md#13-聊天目标与计划模式)，验收规格归[测试计划 §41](../../testing/verification-plan/part-07.md#41-聊天目标与计划模式验收规格)。2026-10-20 文档补充只校准源码边界，不新增开发授权或运行验收成绩。

## 0.16 七种 Agent 执行模式与产品能力边界

2026-10-20，依据现有产品规则与工作区源码补充。以下术语描述可组合的执行方式，不代表七套独立引擎、七个用户入口或新增功能承诺。Relay 当前以 ReAct 工具循环处理动态行动，以 Workflow 管理正式执行；先规划后执行、反馈纠错和单步工具调用复用这些基础。实现责任与源码导航归[运行架构 §10](../../architecture/runtime-context/part-03.md#10-七种-agent-模式的实现映射)，实际运行成绩及未验范围只归[统一功能验收表](../../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

| 模式 | 面向用户的用途 | 当前能力与边界 |
|---|---|---|
| ReAct（判断与行动交替） | 读取、修改、查询等需要根据现场结果决定下一步的工作 | 已有模型选择工具、工具执行、结果回传和继续判断的循环。无须暴露模型内部思维；用户需要看到真实动作、结果及停止原因。单轮预算、权限和取消继续生效 |
| Plan and Execute（先规划后执行） | 多步骤工作先确认范围、步骤和验证方式，再持续推进 | `/plan` 保存会话内计划版本，按选定版本进入 `/goal`，由服务端组织后续轮次。已有基础接线；不把计划卡或进度步骤视为每步独立执行、独立验证和恢复均已完成的严格计划执行器 |
| Reflexion（反思纠错） | 根据失败和验证反馈修正当前工作 | 已有检查失败后分析、修改、重新检查的局部闭环。尚未形成独立的执行后经验提炼、跨任务持久复用及收益验证机制；长期记忆和用户学习模式不自动等于 Agent 反思学习，不承诺“越用越聪明” |
| Workflow（预设流程） | 正式执行需要稳定的状态转换、审批、恢复与交付约束 | 已有预设运行图，图内可调用动态工具循环。流程拥有等待和推进边界，正式完成仍经原验证与接受入口；没有由此提供通用可视化流程编辑器 |
| Multi Agent（多角色协作） | 主 Agent 实施，子 Agent 独立调查或审查 | §0.9 与 ADR-017 已确认首版产品规则，委派、汇合及父子恢复协议尚未实现。多个普通会话、人设助手或开发工具自身的子代理不构成 Relay 产品的多 Agent 能力 |
| Agent and Tool（单步工具调用） | 一次查询或单个受控动作即可解决的简单工作 | 已有工具准入与执行入口；单次调用可作为现有循环的一条简单路径，不另建引擎。是否可调用取决于当前连接、能力和权限，不因模式名称自动增加工具 |
| Code as Action（以代码执行行动） | 用代码处理计算、批量转换或复杂逻辑 | 已有代码文件修改和受控 CLI/检查入口，可支撑受限场景；尚无通用生成代码、隔离执行、结果回传的完整代码解释器。固定程序、参数数组及工作目录不构成 OS 沙箱，不承诺任意 Python/JS 执行 |

模式组合不改变 Project State、Task、Run、Artifact、Verification、Review 与业务完成的既有 Owner。产生外部效果的行动仍经过原权限和动作账本；模型输出、工具成功、计划步骤完成均不自动代表正式 Task 完成。后续若补多 Agent、跨任务反思或通用代码执行，须另行明确范围、恢复、安全边界及验收条件；本节不调整开发顺序。

## 0.17 长期项目协作的差异化体验

2026-10-22，用户在讨论六项差异化方向后要求更新文档，确认将其纳入产品规划；本次仅文档。下述首版边界为推荐设计，工程协议、效果阈值与实际开工仍待核定，不表示六项完整体验已经实现或验收。已有切片的状态保留，不能因本节新增而退回未实现。范围与推荐顺序归[后续路线 §14](../post-v1-roadmap/part-02.md#14-差异化体验的范围与推荐顺序)，交互归[工作台 §45](../../frontend/workbench-design/part-14.md#45-长期项目协作的差异化体验)，未运行规格归[测试计划 §42](../../testing/verification-plan/part-07.md#42-长期项目协作差异化体验的目标验收)。

产品表达：**Relay 帮用户持续推进长期项目，并在变化发生时，指出什么需要重验、什么需要重想、下一步交给谁。** 差异化效果须经真实项目对比验证，不宣称其他 Agent 都不具备这些能力，也不以记忆长度、运行时长或 Agent 数量替代收益。

2026-10-24，用户确认将本轮推荐的五个方向全部纳入产品规划：**成果有效性守护、项目接手演练、面向用户的成果验收、决定驱动的工作台、围绕成果工作的专用工作台**。其中成果有效性守护对应 §0.17.1，决定驱动的工作台对应 §0.17.6，专用工作台深化 §0.2 并由 §0.17.7 补充；其余沿原同名规则。不替代原六项规划，不将既有能力重新标为未实现。此次确认的是方向，首版细节、工程协议、效果阈值和开工排期仍待核定，未授权代码开发。

### 0.17.1 成果失效提醒

需求、依赖、验收条件或被测产物版本变化后，检查已登记关联上的旧结论是否仍适用于当前对象。例如密码登录改为验证码登录，原密码测试仍是历史证据，但不能证明验证码过期、重复使用和发送频率已通过。

推荐首版只覆盖用户选定项目内明确登记的版本关系；区分「确定受影响」「可能受影响」「尚未核对」，给出变化来源、原证据适用基线和需要补验的条件。模型推断不能成为确定影响；没有关联记录不能得出无影响。只提醒和准备复验建议，不改写历史 PASS、不撤销旧业务完成、不自动重开 Task；新版本不得继承旧批准。正式重验、重开或替代仍走原 Owner。

2026-10-24 用户确认以下产品行为（设计确认，不代表已实现或已验收）：

- **关键节点集中提醒。** 连续修改期间归并关联变化，在准备验收、确认完成或重新接手项目时集中展示受影响结论与待补验项；变化直接影响正在进行的验收时立即提示。归并不抹去变化来源，也不把尚未核对显示为无影响。
- **先核对，再准备补验方案。** 在已有读取权限内核对关联需求、改动与证据，说明需要补验什么、为什么以及仍不确定的部分。用户明确说「开始补验」后才执行验证，额外权限仍走原有审批；只读核对不包含运行测试、修改文件或自动重开任务。读取受限或核对失败须保留可见缺口，不冒充已查清。本轮确认不新增后台扫描或执行授权。

- **一次确认，完成修复和复验。** 补验发现缺陷后，先汇总失败项、原因与修复范围；原因未查清时明确标注。用户明确说「修复这些问题」后，在确认范围内修复并重新验证，不逐轮重复索要同一授权。需要改变需求、扩大范围或额外权限时，暂停相关动作并确认；「开始补验」本身不授予修复权限。执行仍走原 Owner 与现有准入规则。
- **最多自动修复 3 轮。** 每轮包括依据失败结果进行修复并复验；初次补验不是修复轮次。同一问题反复出现、无法继续验证或需要扩大范围时提前停止，不能以换会话或重试重置本次自动修复额度。停止时保留已有成果，说明尝试、剩余问题和建议下一步；未完成的检查不记为通过。达到上限后的继续需要用户明确决定，不能自动开启下一批 3 轮。

- **有证据的自动收尾。** 当前版本与条件下，对应提醒所需的检查全部通过后，将该提醒标为「已复验」，从待处理列表收起，保留变化来源、适用基线与验证记录。仍需人工验收的部分继续待处理，不自动宣布整个功能完成；未核对、未运行、失败或环境缺口不能随其他检查通过而关闭。验证期间基线再次变化时，原结果仅适用于原基线，须重新核对后才能收尾；后续新变化形成新的关联提醒，不覆盖旧记录。已有版本绑定、人工验收与业务完成规则继续有效，复验通过不自动继承旧批准。

### 0.17.2 项目接手演练

在既有接续摘要之外，新增验证交接资料是否足以恢复工作的规划。用户主动发起「检查这个项目能否被接手」，由一个不携带原会话隐含上下文的新会话，基于同一确切项目基线及授权资料，尝试说明下一步与依据、有效决定与已否决方案、验证方法、阻塞和中断恢复位置。

2026-10-24 用户确认首版默认围绕**当前工作主线**演练：检查正在推进的任务及其关联决定、成果、验证方法和恢复位置；需要时由用户扩大范围。结论必须说明本次主线及实际读取范围，不以局部资料齐备推定整个项目可接手。当前主线无法从项目事实明确识别时，先澄清目标，不静默改为全项目扫描。本项为设计确认，新增能力待实现、未验收。

输出逐项引用与无法回答的缺口，例如启动说明缺失、验收证据找不到、关键部署信息只在不可读会话中。资料不存在、无权读取、来源冲突和读取失败分开；找不到不等于不存在。结论绑定所用资料版本和演练基线，不生成笼统的「可接手」保证。**2026-10-24 用户确认首版采用只读接手推演**：新 Agent 根据授权资料逐项说明「下一步做什么、为什么、怎样验证、从哪里恢复」，引用依据并指出缺口；不实际接管执行、不调用项目启动命令、不运行测试、不自动建任务。能够说明验证方法不代表该方法已成功运行；实际启动和运行验证作为后续可选演练另行设计。本次演练不转移执行权，也不要求先实现完整多 Agent 产品。

2026-10-24 用户确认缺口处理采用**整理缺口并准备补齐草案**：按「阻碍当前接手／可稍后补充」说明影响，有依据的内容拟成修改建议；缺失事实、来源冲突保留待确认，不以模型推测补齐。用户明确说「补齐这些资料」后，沿所属主文档与原写入 Owner 应用已确认范围的修改，复核当前版本和权限，不新建重复事实源。只读演练与经授权的资料补齐是两个阶段；后者不授予代码修复、运行测试或接管执行权限。写入成功本身不证明缺口已经消除。

2026-10-24 用户确认**资料补齐后自动复查一次**：由不携带上次演练隐含上下文的新 Agent，基于更新后的资料基线，对同一工作主线重新进行只读推演。新 Agent 的回答须来自项目授权资料，不把上轮答案或补齐者的自报结果当作已知事实；复查后再对照两轮结果，展示已消除、仍存在及新发现的缺口与依据。复查仍有缺口则汇总交给用户，不自动循环补写；读取失败、预算不足、取消或基线再次变化时如实保留未核对范围，不宣称缺口已消除。该复查沿现有调用额度与权限约束，不自动接管实际任务。

### 0.17.3 决策重审提醒

复用[决定复审 §0.14.3](part-01.md#0143-决定复审)，将原决定、明确登记的成立前提、前提变化及待判断事项连接起来。例如从单用户同机转向多人远程协作时，提示重审原部署与权限决策。模型推测的决策关系只作候选，不补造历史理由，不自动废止决定或替换架构。

### 0.17.4 修改前的影响预演

深化[需求驱动的软件协作 §0.10](part-01.md#010-需求驱动的软件协作)的变更守护，与 §0.14.5 固定容量计划推演分开。用户提出需求修改时，在正式应用前展示已登记关系下受影响的承诺、成果、验收条件、任务及在途执行，以及模型推测和未核对范围；基线变化后重新核对。推荐首版准备可审阅的变更草案，不运行模拟执行、不自动改活动契约、不因接受草案获得执行或外部动作授权。

### 0.17.5 面向用户的成果验收

在 §0.14.1 的证据聚合上，增加由用户可操作的业务步骤组成的验收建议。每一步关联需求、确切产物版本、预期现象与已有证据，并标出自动检查已覆盖和必须人工检查的部分；缺环境、账号或资料时显示缺口。步骤生成、用户勾选和自动测试成功均不能冒充实际人工验收，结果仍沿原 Verification、Review 与完成入口登记。

### 0.17.6 围绕待决定事项组织工作

深化 §0.4 的注意力与验收设计：优先告诉用户哪些决定正在阻塞后续工作，决定后哪些任务具备继续条件。排序使用可核对的依赖、截止时间和阻塞记录，缺失依据显示未知，不由模型制造紧迫性或承诺节省时长。同一决定被多项工作引用时合并展示并保留关联；决定、批准、执行授权和实际恢复分别成立，不能因处理待办自动恢复所有相关工作。

### 0.17.7 围绕成果工作的专用工作台

方向已确认，以下首版边界为推荐设计，新增完整体验未实现、未验收。围绕真实业务对象及其关系组织工作：论文可从论点查看证据、关联章节、反例和待验证问题；软件可从需求查看对应实现、确切成果版本、运行证据和验收缺口。聊天承担讨论，选中对象后的查看、局部修改、检查与退回沿原业务入口完成；工作台不维护另一套任务、成果或完成状态。

2026-10-24 接续讨论，用户确认先以 **Relay 自身开发中的软件功能／需求** 为场景，贯通需求、成果、试用、反馈与返工。默认自由试用并保留必要检查提示；多个功能按完整使用流程集中体验，同时保留单项入口。明确缺陷在授权内边试边修，保持当前体验版本稳定，新版由用户选择切换；主观反馈先调查并推荐具体改法，用户确认后执行，明确修改指令按已有授权推进。功能与整条流程的验收结果分别记录，不以浏览、沉默、修复提交或自动检查代替人工接受及正式完成。详细交互和待核定项归[工作台 §45.1](../../frontend/workbench-design/part-14.md#451-软件功能的试用反馈与返工)。这些是已确认产品规则，尚未实施或验收本增量，不授权本轮代码开发。

复用已有 Task、Artifact、Verification 和关系入口贯通最小流程，不同时建设多个行业工作台，不以完整知识图谱、通用页面生成器或长期 Agent 团队为前置。对象关系覆盖、编辑与定位粒度、布局及接线范围仍待核定；已有视图和关联能力须先核查，不预设缺失。来源缺失、读取失败、无权访问及版本已变分别呈现；修改产生新版本，旧证据和批准不自动继承，退回保留原要求、成果版本及检查依据。

## 0.18 项目级长期 Agent 团队与跨会话协作

2026-10-23，用户以 Grok Bot 的长期队友体验为参照，逐项确认并授权落成文档。**产品规则已确认，工程协议待核定；长期团队增量待实现、未验收，本轮仅文档，不启动开发或调整当前阶段。** 本节拥有产品规则；第三方参照不构成 Relay 已有能力、云端运行或相同实现方式的承诺。

### 0.18.1 成员、会话与项目工作

面向需求、设计、开发、测试等全过程分工，支持会话内临时协作和跨会话长期负责。Agent 成员具有稳定身份、职责与工作记录；会话承载一次或一段交流，同一成员可以参与多个会话；事项与 Task 承载工作，Run 承载确切执行，产物、验证和人工判断仍按原 Owner 管理。聊天结束不消除成员职责，成员长期存在也不等于模型持续运行。

| 已确认选择 | 产品规则 |
|---|---|
| 项目级成员 | 按需添加长期成员，提供产品、设计、开发、测试等可复用角色模板；协调者可建议增员，不自动为每个项目建齐团队或自行增加成员。模板可复用，成员身份与项目记录独立，不扩展为跨项目自主路由 |
| 协调与直接交流 | 项目协调成员负责优先级、分派、依赖及汇总；成员可直接交流，用户可私聊任一成员。涉及承诺变化时回到协调者，不能靠私聊绕过当前事实和执行授权 |
| 内置与外部运行 | 内置和外部 Agent 都能作为长期成员，身份与职责持续保留，运行方式单独配置。外部成员沿已确认的本机 API/MCP 主动领取方案参与；离线显示等待连接，不承诺 Relay 直接启动外部工具 |
| 授权内自主 | 用户授权一个明确工作范围，例如推进某模块；范围内可调查、拆任务、分派、执行和返工。新发现可调查、登记并提出计划，新增需求、扩大范围或权限必须由用户决定；协调者不能自行改变有效验收条件 |
| 冲突与判断 | 协调者在授权与有效条件内裁决分工和进度；需求取舍、权限扩大、验收放宽及未解决争议转人工。不能用多数投票或协调者判断抹去真实失败证据，讨论和返工须有结束条件 |
| 共享与私有上下文 | 共享需求、决定、任务、产物及证据等项目事实；各成员保留自己的工作记忆，通过交接或获准查询读取相关会话。交接包含目标、当前结果、依据与下一动作，个人推测不直接成为共享确认事实 |
| 持续推进 | 事件唤醒与定期巡检结合：任务完成、验收退回、依赖解除等事件触发处理；巡检覆盖获准工作及失联/待处理事项，没有可推进工作时等待。同一事实未变化不重复生成工作或催促 |
| 运行条件 | 关闭窗口后本机进程继续工作；明确退出应用或关机后停止。重启先核对授权、执行权、在途动作和现场再恢复，不把关闭窗口等同退出，不承诺关机或退出后的云端/系统服务执行 |
| 额度不上限 | 不额外设置项目、成员或团队累计费用、时长、轮数及调用次数上限，也不以周期额度配给限制本团队；持续记录实际消耗及未知值。服务商/账户限额、单请求技术限制、用户暂停、权限失效、真实阻塞及需人工决定仍会停止或等待 |
| 模型配置 | 成员可单独配置模型，默认继承项目设置；角色、模型和工具权限分开。换模型不换成员身份、不增加权限；不可用如实显示，备用模型必须由用户配置，不静默替换 |
| 私聊、群聊与概览 | 成员私聊用于定向交流，项目群聊支持多人协作，工作概览展示任务、成果及待决定事项；各入口引用同一事实源，不各维护一套计划或完成状态 |
| 群聊响应 | 指定成员接收，未指定由协调者接住并邀请相关成员；成员可以发起有明确接收者的讨论。按对象和职责激活，不默认唤醒全员；每次讨论有要解决的问题和结束条件，避免循环互相回复 |
| 汇报与通知 | 决定请求、真实阻塞、重要风险和成果待批准主动通知，普通过程集中汇总、可展开。相同问题合并通知并保留来源，不以隐藏未决问题降低通知数量 |

### 0.18.2 与既有闭环及停止条件的关系

沿 §0.10 的事项与外部共享任务、§0.9 的临时子委派及原 Task/Run/Verification/Review 完成链复用，不建设第二套执行事实。长期成员可在获准任务内实施；只读子代理及只读人设助手不会因归属团队而取得写权限。长期成员的工作记忆不等于跨项目自动偏好学习，具体复用现有记忆的方式在实施前核定。

独立 worktree、任务与资源排他、失联先核对、版本化需求与验收、开发者不能自验、人工批准确切变更后集成回归、成功后业务完成等规则继续有效。**额度不上限不取消原默认三轮返工后转人工、讨论结束条件、单动作故障重试边界或临时子委派的并发/层级限制**；这些限制不改成项目累计调用或运行时长预算。不因为团队成员发消息就启动无限递归执行，恢复未知结果仍先核对原身份。

额度耗尽保存现场，额度恢复后核对原任务和授权再接续；具体余额识别、唤醒和继续协议待工程核定。外部工具不可观测的成本、运行状态和停止效果明确标未知，不能声称 Relay 已强制控制其进程、费用或暂停。成员更换运行方式时身份可保留，但已有执行不能绕过执行权与现场核对。

原禅道衔接不变：共享任务增量可用并启用后，Relay 自身新事项试运行，旧事项继续在禅道处理；本次不授权迁移、同步关闭或写入外部系统。

责任归[领域模型 §23](../../architecture/domain-model/part-02.md#23-长期-agent-成员与跨会话协作的应用边界)，范围与工程待核定项归[后续路线 §16](../post-v1-roadmap/part-02.md#16-项目级长期-agent-团队与跨会话协作)，交互归[工作台 §47](../../frontend/workbench-design/part-14.md#47-长期-agent-团队私聊群聊与工作概览)，取舍归 [ADR-034](../../decisions/ADR-034-persistent-project-agent-team.md)，未运行场景归[测试计划 §44](../../testing/verification-plan/part-07.md#44-长期-agent-团队与跨会话协作的目标验收)。

# 1. 产品边界

## 1.1 产品不是

明确避免做成：

- AI Todo
- Notion Clone
- Jira Clone
- Codex Clone
- IDE Clone
- Email Client Clone
- Agent Marketplace
- MCP Marketplace
- 通用低代码平台
- 万能 Browser Automation
- 自研通用 Coding Agent
- 大而全企业协作平台

## 1.2 核心价值

产品持续回答五个问题：

1. **我当前真正重要的 Goal 是什么？**
2. **各 Project 现在真实处于什么状态？**
3. **下一步最值得推进什么？**
4. **这一步应该我做、AI 辅助、还是交给 AI？**
5. **AI 做完之后，是否真的满足要求？**

---

# 2. 顶层工作闭环

```text
Goal
 ↓
Project State
 ↓
Next Action
 ↓
Task
 ↓
┌──────────────┬──────────────┬──────────────┐
│              │              │
Me          AI Assist      Delegate AI
│              │              │
│              │         Workflow Run
│              │              ↓
│              │          Artifact
│              │              ↓
│              │          Verification
│              │        ↙      ↓      ↘
│              │      PASS   RETRY   HUMAN
│              │         \      |      /
└──────────────┴──────────── Result
                               ↓
                       Update Project State
                               ↓
                          Next Action
```

长期闭环：

```text
Plan
→ Execute
→ Observe
→ Verify
→ Review
→ Learn
→ Replan
```

---

# 3. Workspace

## 3.1 定义

Workspace 是以下内容的边界：

- Project
- Goal
- Memory
- Knowledge
- Tool Connection
- Permission
- Rules
- Context
- Activity

它不是普通文件夹。

## 3.2 V1

只实现：

```text
Personal Workspace
```

## 3.3 长期

支持：

```text
Personal
Work
Team
```

其中：

- Memory 隔离
- Knowledge 隔离
- Tool / Connection 隔离
- Permission 隔离
- Rules 隔离

## 3.4 Global Today

未来多 Workspace 后，可以存在 Global Today。

注意：

```text
Workspace
→ Summary Projection
→ Global Today
```

Global Today 只读取 Workspace 摘要，不把不同 Workspace 全量 Memory / Knowledge 混合进入同一个 Agent Context。

---

# 4. Goal

## 4.1 定义

Goal 是结果（Outcome），不是活动（Activity）。

正确：

```text
拿到 Java 后端实习
完成毕业论文并答辩
Smart Tasks 达到可部署与简历展示水平
```

错误：

```text
学习 Java
写论文
做项目
```

## 4.2 关系

```text
Workspace
 ├── Goals
 └── Projects
       ↕
Goal / Project Many-to-Many
```

一个 Goal 可以由多个 Project 共同推进。

一个 Project 可以服务多个 Goal。

Goal 不跨 Workspace。

## 4.3 UI

Goal 是一级领域概念，但 V1 **不设 Goal 一级导航页面**。

Goal 主要出现在：

- Project
- Today
- Weekly Review
- Goal Alignment
- Planning

---

# 5. Project

## 5.1 定义

Project 是：

> 拥有目标、状态、上下文和生命周期的一组持续工作。

## 5.2 Project 包含

```text
Project
├── Goal
├── Current State
├── Milestone
├── Task
├── Workbench
├── Knowledge
├── Decision
├── Artifact
├── Workflow
├── Activity
├── Rule
└── Conversation
```

## 5.3 核心原则

Project 的核心不是：

```text
Task Folder
```

而是：

```text
Current State
```

---

# 6. Project State

## 6.1 定义

Project State 是当前项目的**机器可读事实状态**。

它应该回答：

- 当前阶段
- 已完成
- 进行中
- 阻塞
- 风险
- 下一步
- 当前关键 Decision
- 当前关键 Artifact

## 6.2 示例

```text
Project: Personal Workflow OS

Phase:
Product Definition

Completed:
- Goal / Project / Task
- Planning
- Workflow
- Verification
- Proactive
- Integration
- Workbench

In Progress:
- Master Spec

Risk:
- Thesis research cut not frozen

Next Action:
- Domain Model + System Architecture
```

## 6.3 来源

Project State 可以由：

1. User Explicit Update
2. Deterministic Task / Workflow Result
3. AI Suggested Update

AI 推断必须和事实区分。

## 6.4 更新规则

### User Update

直接更新事实。

### Task Completion

Task Verification PASS 后，可以更新确定性状态。

### AI Suggestion

例如：

```text
AI suggests:
Phase Product Definition
→ System Design
```

必须：

```text
Accept / Reject
```

V1 不允许 AI 任意重写整个 Project State。

## 6.5 信息优先级

```text
Live Project State
>
Explicit Decision
>
Validated Memory
>
Knowledge
>
Raw Conversation
```

---

# 7. Milestone

Milestone 存在，但不是产品核心。

用途：

- 表示阶段
- 帮助 Progress
- 帮助 Goal Progress
- 帮助 Project Bootstrap

V1 保持轻量。

---

# 8. Task

## 8.1 定义

Task 是：

> 最小可执行、可产生结果、可被验证的工作单位。

## 8.2 Task 核心信息

```text
Title
What
Why
Project
Goal
Input
Expected Result
Acceptance Criteria
Estimated Effort
Execution Mode
Dependency
Status
Result
```

## 8.3 Task Status

用户可见状态保持简单：

```text
Inbox
Ready
In Progress
Waiting
Blocked
Done
Cancelled
```

不要把：

```text
PLANNING
EXECUTING
VERIFYING
RETRYING
```

直接暴露为 Task Status。

这些属于 Workflow Run State。

## 8.4 Execution Mode

V1 用户心智固定为：

```text
Me
AI Assist
Delegate AI
```

### Me

用户自己完成。

### AI Assist

AI 作为 Copilot，打开 Task Context Chat。

### Delegate AI

系统创建 Workflow Run 并完整执行。

---

# 9. Task Dependency

支持 Task 之间依赖：

```text
Task A
→ blocks
Task B
```

主要用于：

- Next Action
- Risk
- Replanning
- Project State

---

# 10. Work Session

Task != Work Session。

Task 表示工作。

Work Session 表示：

> 某个真实时间段执行该 Task。

一个 Task 可以：

- 跨多天
- 多个 Session
- 被中断后继续

完整 Work Session / Calendar 进入 V1.5。

---

# 11. Today

## 11.1 定义

Today 不是：

> 今天到期的任务。

Today 是：

> 系统根据 Goal、Project State、Task、Deadline、Risk 等形成的当前决策层。

## 11.2 V1 Today

包含：

### Today's Focus

一天一个主结果。

例如：

```text
完成 Personal Workflow OS Master Spec
```

不是：

```text
工作 90 分钟
```

### Next Actions

展示：

- Task
- Project
- Estimated Effort
- Execution Mode

操作：

```text
Start
AI Assist
Delegate AI
Later
```

### AI Working

展示当前 Workflow Run：

```text
Running
Verifying
Waiting Approval
```

### Inbox

快速捕获未分类事项。

### Insights

V1 只做轻量：

- 当前高优先级项目
- 可 Delegate Task
- 简单 Deadline 提示

---

# 12. Planning

完整自动 Planning 在 V1.5。

## 12.1 Planning 输入

```text
Goals
Project State
Tasks
Calendar
Deadlines
Dependencies
Available Time
Preferences
Recent Progress
Actual Duration
```

## 12.2 三层 Planning

### Strategic

周 / 月层：

> 哪些 Goal / Project 应获得时间。

### Tactical

Today 层：

> 今天做哪些 Task。

### Execution

Now 层：

> 现在下一步做什么。

## 12.3 Next Action

全局可用：

```text
What should I do now?
```

输出：

- 当前 Next Action
- 为什么
- 预计时间
- Start

## 12.4 LLM 与 Planner 分工

LLM：

- 语义
- Task 分解
- Soft Constraint
- 解释
- 冲突语义分析

Deterministic Planner：

- 时间
- Deadline
- Duration
- Dependency
- Calendar
- Hard Constraint

## 12.5 Buffer

Planner 不允许填满 100% 可用时间。

必须保留 Buffer。

## 12.6 Duration Learning

记录：

```text
Estimated Duration
vs
Actual Duration
```

未来自动修正 Task Estimate Bias。

## 12.7 Plan Confidence

长期可显示：

```text
Plan Confidence
```

它表示排程的不确定性，而不是 LLM 自信分。

必须提供可解释原因。

---

# 13. Replanning

真正的 Agent Planning 价值在 Replanning。

触发：

- Task 提前完成
- Task 超时
- 新增紧急 Task
- Calendar Change
- Deadline Change
- Blocked
- Workflow Failure
- Project Risk Change
- User Request

## 13.1 Scope

```text
LOCAL
TODAY
WEEK
PROJECT
```

## 13.2 目标

Replanning 默认：

> **Minimal Disruption**

不要每次重排整个一天。

## 13.3 Human Override

用户任何时候可：

```text
Not today
Move
Skip
Pin
```

系统只能重新规划，不能强迫用户。

---

# 14. Focus Mode

后续支持。

进入 Focus 后只显示：

- Current Task
- Goal
- Work Session
- Relevant Knowledge
- AI Chat

Focus 结束：

```text
Completed
Partially Completed
Continue Later
Blocked
```

系统记录 Actual Duration 与 Progress。

---

# 15. Workbench

## 15.1 定义

Workbench 是：

> 为某一类工作组合专属页面、导航、工具、Workflow 和 Rules 的工作界面。

Workbench 回答：

```text
How do I work here?
```

Workflow 回答：

```text
How should this work be executed?
```

二者必须区分。

---

# 16. Workbench 分层

可以同时存在：

## Project Workbench

决定整个 Project 的工作结构。

## Task Workbench

针对某类 Task 提供专属工作界面。

---

# 17. V1 内置 Workbench

## General Workbench

```text
Overview
Tasks
Knowledge
Artifacts
Activity
```

## Research / Thesis Workbench

```text
Overview
Research
Sources
Notes
Synthesis
Writing
Experiments
References
Tasks
Knowledge
Artifacts
Activity
```

## Development Workbench

```text
Overview
Requirements
Development
Changes
Build
Tests
Verification
Release
Tasks
Knowledge
Artifacts
Activity
```

---

# 18. Workbench Routing

```text
Project / Task
↓
Type
↓
Workbench Resolver
↓
Workbench
```

例如：

```text
Research Task
→ Research Workbench

Development Task
→ Development Workbench

General Task
→ Task Detail
```

---

# 19. Workbench Navigation Injection

核心导航不能被破坏。

系统核心：

```text
Overview
Tasks
Knowledge
Artifacts
Activity
```

Workbench 可以动态注入：

```text
Research
Writing
Experiments
```

或：

```text
Requirements
Development
Tests
```

---

# 20. Schema-driven UI

V1.5 开始。

AI / User 不直接生成任意 React/Vue 页面。

而是生成：

```text
Page Schema
+
Blocks
```

Block 可能包括：

- Task List
- Table
- Kanban
- Document
- Artifact List
- Knowledge List
- Timeline
- Metrics
- Workflow Run List
- AI Panel

## 20.1 AI Workbench Modification

未来用户可说：

> 给论文加一个实验管理页。

AI 应：

```text
Modify Workbench Configuration
```

而不是：

```text
Modify Application Source Code
```

## 20.2 Relay Skill 设计补充（2026-09-20，Proposed）

本轮建议将可复用能力组织为 Relay Skill：Instructions、Context Profile、Workflow Binding、Capability Requirements、Output Schema、Verification 与可选 UI Blueprint。Skill Pack 是领域组合；Skill 不授予权限、不新增 Runtime、不直接写事实或注入代码。设计与取舍见 [Skill 专题](../../architecture/relay-skills.md)和 [ADR-008](../../decisions/ADR-008-declarative-skills.md)。

首个候选 `goal-to-project-blueprint`（“从目标创建项目蓝图”）沿用第 97–98 节：先创建最小 Project，再通过 Assist 建议状态、里程碑、任务与内置 Workbench，用户 Preview / Diff / Apply。V1 只配置三种内置模板及注册页面；Rules 与 Workflow 等执行配置分别确认，不因应用工作台而生效。

分期差异显式保留：原第 106 节已有 Custom Schema Workbench，第 107 节将 AI-generated Workbench 放在 V2；本轮“V1.5 由 Skill 生成 Page Schema”为待确认前移提案，尚未替换原里程碑。完整 Project Bootstrap 不因首个蓝图 Skill 自动前移至 V1。分期主表见[范围矩阵](../v1-scope.md)，不是已交付功能。

2026-09-20 后续确认：用户要求纳入评审后的闭环 Skill 方向。V1 首批包含完善任务定义、继续项目、生成验收方案和项目蓝图；蓝图保留展示旗舰定位，工程先落实前三项。修复、交接和确定性状态更新复用核心闭环，Decision Capture 后续补充，完整目录与边界只在 [Skill 专题第 7 节](../../architecture/relay-skills.md#7-首批闭环能力与后续目录)维护。验收在 Delegate 前确定；PASS 后仍需完成事务，交接摘要不转移执行权。具体实现仍为设计，未新增已交付能力。

同日统一扩展模型：Relay Pack 组合 Blueprint 模板、Skills、既有 Workflow Recipe、分属各模块的 Profiles、Rules、Artifact/Workbench 模板及 Eval。原 Skill Pack 是同一概念，统一组合边界见[扩展模型](../../architecture/relay-skills.md#8-可组合扩展模型)。V1 最小第一方 Thesis/Development Pack 随应用发布，选择不等于应用或授权；既有 Proposal 统一审查体验，领域 Owner 负责写入。基础 Eval 与轻量 Sources View 纳入工程，完整 Inspector/Importer/Automation/Project Checkpoint 后置。更新与配置恢复需显式审查，不承诺回滚外部效果，也不自动应用新包。分期细目由范围矩阵维护。

---

# 21. Workflow

## 21.1 定义

Task：

> What

Workflow：

> How

Automation：

> When

## 21.2 V1 Workflow

至少支持：

```text
Plan
Execute
Verify
Retry
Human
Pause
Resume
Cancel
```

默认 Sequential。

后续：

```text
Parallel
Condition
```

---

# 22. Workflow Node 类型

长期：

```text
Action
Agent
Condition
Parallel
Human
Verification
```

原则：

> Deterministic Workflow Skeleton + Agentic Nodes

---

# 23. Workflow Definition / Version / Run

必须概念分离：

```text
Workflow Definition
↓
Version
↓
Workflow Run
```

历史 Run 必须保留对应版本。

---

# 24. Workflow Durability

长期 Agent Workflow 必须支持：

- Pause
- Resume
- Retry
- Cancel
- Recover
- Checkpoint

Workflow 失败不能要求整次重新开始。

---

# 25. Workflow Budget / Stop Condition

后续支持：

```text
Token Budget
Cost Budget
Time Budget
Retry Budget
No-progress Condition
Success Condition
Failure Condition
Human Stop
```

避免无限循环。

---

# 26. Retry Semantics

必须区分：

### Transient Failure

Retry Same。

### Execution Failure

Retry with Failure Feedback。

### Reasoning Failure

Replan。

### Repeated Failure

Switch Agent / Human / Stop。

---

# 27. Automation

完整 Automation V1.5。

Trigger 类型：

```text
Manual
Schedule
Event
State
Agent-detected
```

概念：

```text
Automation
= Trigger + Workflow
```

Proactive Agent 可以被视为：

```text
Smart Trigger + Workflow
```

---

# 28. Verification

## 28.1 核心原则

Worker 只能：

```text
SUBMIT
```

Verifier 决定：

```text
PASS
RETRY
HUMAN
```

## 28.2 三层

### Hard Check

例如：

- File Exists
- Build Pass
- Test Pass
- HTTP Result
- Schema Validation

### Rule Check

依据 Acceptance Criteria / Project Rules。

### Semantic Judge

LLM / Vision 判断质量。

---

# 29. Handoff

## 29.1 定义

Handoff 解决：

> 工作由另一个人 / Agent / Workbench 接管时，如何无损继续。

## 29.2 Handoff Package

```text
Objective
Current State
Completed Work
Decisions
Constraints
Relevant Artifacts
Verification Status
Open Problems
Next Action
Owner
```

## 29.3 支持

```text
Human → Agent
Agent → Human
Agent A → Agent B
Workbench A → Workbench B
Today → Tomorrow
```

---

# 30. Review Inbox

统一处理所有“AI 需要人判断”的事情。

包括：

- Verification HUMAN
- High-risk Tool Approval
- Project State Change
- Workbench Change
- Repeated Agent Failure
- Decision Confirmation
- Permission Request

操作：

```text
Accept
Reject
Modify
Later
```

原则：

> AI 处理可以处理的，真正需要人的判断才进入 Review Inbox。

---

# 31. Artifact

Artifact 是：

> Task / Workflow 的实际产物。

例如：

- Markdown
- PDF
- Code Change
- Test Report
- Research Report
- Image
- Generated Spec

Artifact 不自动等于 Knowledge。

---

# 32. Artifact Lineage

V1 推荐保留基础 Provenance。

```text
Artifact
Produced By
Task
Workflow Run
Agent / Model
Sources
Generated At
Verification
Version
```

版本链：

```text
v1
↓
Verifier Failure
↓
v2
↓
User Modification
↓
v3 PASS
```

---

# 33. Knowledge

## 33.1 定义

Knowledge 是：

> 供人阅读、理解和复用，并供 AI 按授权检索和引用的外部 / 项目知识内容。

2026-09-27 补充：用户明确提出知识库也需要给人使用。本节将原先偏 Agent 的定义补全为人和 AI 共用的知识来源，帮助用户恢复项目理解、查找设计依据和关键要求；有知识页面或可检索内容不代表人的阅读体验已经完成。具体阅读组织仍需按现有能力设计，不改变当前模块进度。

V1：

- File
- Web Link
- Note
- Validated Artifact

按既有 Workspace / Project 作用域组织；项目入口便于理解当前项目，工作空间入口便于查找可复用资料，跨范围使用仍须核对权限。

人的浏览、正文阅读、版本核对和笔记修订不以调用模型为前提。AI 使用同一来源的确切版本及必要片段；Context 快照和检索索引可派生，不另维护一份独立的“AI 知识正文”。仓库中的 README、架构文档、ADR 等优先保留原来源，通过显式引用或有来源的版本快照接入，引用不等于已具备自动同步。

知识库保留重要资料与可复用成果，不自动收录全部聊天和执行日志。AI 整理先形成建议，由用户确认内容及归类后经既有入口保存；收录、读过或认可摘要不等于内容已验证。Knowledge、Memory、Decision、Rule 和 Artifact 仍保留各自语义，知识入口可以聚合导航，不能把它们合并为同一种可任意写入的正文。

目标与分期见[知识库范围补充](../v1-scope.md#人和-ai-共用的知识库补充)，版本与来源责任见[信息设计](../../architecture/information-planning.md#11-人和-ai-共用知识来源)，人的交互见[工作台第 12 节](../../frontend/workbench-design/part-03.md#12-人和-ai-共用的知识库体验)。知识内容支持寻找验收依据，但不替代实际验证，也不保证需求完整性。

V1 不做：

- Knowledge Graph
- Wiki Clone
- Full Document Suite

---

# 34. Memory

Memory ≠ Chat History。

Memory 是：

> 值得跨 Session 保存的长期信息。

可能类型：

```text
FACT
INFERENCE
PREFERENCE
DECISION
SUGGESTION
```

Scope：

```text
Global
Workspace
Project
Task
```

长期支持：

- Create
- Update
- Supersede
- Forget
- Archive

---

# 35. Decision

Decision 独立于 Memory。

包含：

```text
Decision
Rationale
Alternatives
Status
Supersedes
```

Status：

```text
ACTIVE
SUPERSEDED
```

防止旧 Decision 污染当前 Context。

---

# 36. Context

Context 不是存储。

Context 是：

> 单次 Agent Run 动态装配的信息。

Context Builder 输入：

```text
System Policy
Task
Goal
Project State
Decision
Relevant Memory
Relevant Knowledge
Recent Activity
Tool Results
Applicable Rules
```

---

# 37. Context Priority

建议：

### Tier 1 Mandatory

```text
Task
Goal
Project State
Policy
Rules
```

### Tier 2 Relevant

```text
Recent Decision
Relevant Memory
Dependency
```

### Tier 3 On-demand Retrieval

```text
Knowledge
Old Activity
Previous Artifact
```

### Tier 4

Raw Conversation 仅必要时加入。

---

# 38. Context Inspector

建议加入长期产品。

用户 / 开发者可以查看：

- 本次 Run 使用了哪些 Context
- 使用了哪些 Knowledge
- 使用了哪些 Memory
- 哪些 Decision 生效
- 哪些内容被忽略

用途：

- Trust
- Debug
- Eval
- Context Engineering 论文实验

不展示私有 Chain-of-Thought。

---

# 39. Rules / Policy

V1 加基础版。

层级：

```text
Global
↓
Workspace
↓
Project
↓
Workbench
↓
Task Override
```

示例 Development：

```text
新功能必须新建分支
修改后运行测试
禁止自动 push main
优先复用已有代码
```

示例 Research：

```text
重要事实必须有来源
禁止编造引用
优先原始论文
事实与推断分离
```

Context Builder 只注入 Applicable Rules。

---

# 40. AI Panel

2026-09-29 调整：原“Chat 不做一级导航、AI 固定在右侧”的限制不再作为目标体验约束。协作可成为主工作区，右侧按当前工作承载产物、上下文或判断；具体组合见[工作台第 14 节](../../frontend/workbench-design/part-03.md#14-以目标协作为中心的工作台改造)，尚未定稿或实施。已有独立 Agent 聊天入口只是当前能力的一部分，不等于完整目标体验。

对话表达意图，应用命令执行必要操作，产物区承载结果。按第 0.5 节已确认规则，用户明确的执行请求可以直接成为 Delegate 用例的授权来源，无需再用按钮重复表达同一意图；实际执行权仍由应用命令持久化授予，模型判断、引用内容和普通讨论不授予执行权，也不代替动作批准。以下 Scope 和用途为产品能力分类，不表示所有组合均已接入当前接口。

Context Scope：

```text
Current Page
Current Task
Current Project
Workspace
```

AI Panel 用途：

- Explain
- Assist
- Delegate
- Ask Why
- Query State
- Modify Plan
- Explain Verification Failure

---

# 41. GUI + Natural Language

原则：

> 核心操作必须有 GUI，不允许全部依赖聊天。

例如必须有：

```text
Delegate AI
```

不能要求用户只能输入：

```text
“把这个任务交给 AI”
```

---

# 42. Command Bar

`Ctrl + K`

V1：

- Search
- New Task
- New Project
- Open Project
- Start Focus
- Delegate Current Task
- Open Activity

Chat：

```text
Reasoning / Conversation
```

Command Bar：

```text
Navigation / Action
```

---

# 43. Search

V1 搜索：

```text
Project
Task
Knowledge
Artifact
```

可以支持全文 + 基础语义搜索。

不做复杂 AI Search。

---

# 44. Activity / Trace

Activity 回答：

> 人和 AI 最近发生了什么。

事件：

```text
User Created Task
AI Started Run
Knowledge Read
Artifact Generated
Verification Failed
Retry
PASS
Project State Updated
```

筛选：

```text
All
Me
AI
System
```

维度：

```text
Project
Task
Run
```

---

# 45. Run Detail

核心信息：

```text
Run
Task
Status
Workflow Progress
Context Used
Tools
Artifacts
Verification
Retry
Approval
```

操作：

```text
Pause
Resume
Cancel
Retry
Approve
Reject
```

---

# 46. Agent 可观测性

系统应该记录：

- Run
- Step
- Tool Call
- Artifact
- Verification
- Retry
- Approval
- Handoff

不要记录 / 展示私有 CoT。

展示：

- Decision Evidence
- Context Sources
- Tool Results
- Verification Evidence

---

# 47. Tool Gateway

产品绝不依赖大量 MCP。

统一：

```text
Workflow
↓
Capability
↓
Tool Registry
↓
Tool Gateway
↓
Adapter
```

---

# 48. Adapter

允许：

- Native
- Local
- REST / SDK
- MCP
- CLI
- Browser
- Human

Browser 是最后兜底。

---

# 49. Capability

示例：

```text
READ_FILE
WRITE_FILE
SEARCH_WEB
RUN_COMMAND
RUN_TEST
GIT_COMMIT
GIT_PUSH
CREATE_EVENT
SEND_EMAIL
```

Workflow 不关心 Provider。

---

# 50. Tool Metadata

Tool / Capability 必须描述：

```text
Risk
Side Effect
Reversibility
Scope
Permission
Reliability
```

---

# 51. Risk Model

长期：

```text
Risk 0
Read-only

Risk 1
Low-risk reversible

Risk 2
Meaningful but recoverable

Risk 3
External/high-impact

Risk 4
Sensitive/destructive
```

---

# 52. Permission

Task Autonomy != Tool Permission。

V1：

```text
Read Operations      AUTO
Low-risk Write       AUTO
External Action      ASK
Destructive          ASK / DENY
```

长期决策：

```text
Autonomy
+
Risk
+
Tool Policy
+
Reversibility
+
Confidence
→ AUTO / ASK / DENY
```

---

# 53. Resource Scope

Tool 必须限制作用域。

例如：

```text
Project:
Smart Tasks

File Scope:
D:\Develop\smart_tasks/**
```

不能默认访问整个磁盘。

---

# 54. Scoped Tool Access

Agent 不应该看到所有 Tool。

```text
Task
↓
Capability Resolver
↓
Relevant Tools Only
```

例如 Research Agent 不需要 Git Push。

---

# 55. Tool Fallback

同一个 Capability 可以有多个 Provider：

```text
READ_GITHUB_ISSUE

Providers:
REST
MCP
```

系统可根据：

- Reliability
- Latency
- Availability
- Cost

fallback。

---

# 56. Connection Failure

Tool Connection 失效不能只报 Failed。

状态：

```text
WAITING_CONNECTION
```

用户可：

```text
Reconnect
Skip
Use Fallback
```

---

# 57. Human Tool

如果无法自动执行：

```text
Automatic Step
→ Human Step
```

例如：

```text
Please send the document to your advisor.
```

用户确认完成后 Workflow Resume。

---

# 58. Local Runtime

这是产品长期重要差异点。

V1 至少保留概念，并优先支持：

- Files
- Git
- Terminal
- Web

长期：

- Maven
- npm
- Docker
- Local Model
- Local MCP
- ComfyUI
- Coding Agent CLI

---

# 59. MCP

MCP 是 Adapter，不是地基。

长期两种角色：

## Inbound

```text
Workflow OS
→ MCP Client
→ External MCP
```

## Outbound

```text
External Agent
→ Workflow OS MCP Server
```

未来 Workflow OS 可以暴露：

```text
get_today
get_project_state
create_task
run_workflow
search_memory
delegate_task
submit_artifact
```

---

# 60. Proactive Agent

完整能力 V1.5 / V2。

闭环：

```text
Observe
→ Detect
→ Assess
→ Decide
→ Intervene
→ Feedback
→ Learn
```

---

# 61. Risk Detection

首批：

```text
Deadline Risk
Progress Risk
Dependency Risk
Workload Risk
Execution Risk
Goal Alignment Risk
```

风险更多使用：

```text
Deterministic / Rule / Statistical
```

---

# 62. Opportunity Detection

首批：

```text
Delegate Opportunity
Automation Opportunity
Batch Opportunity
Next-step Opportunity
Knowledge Reuse Opportunity
```

机会更多适合：

```text
Agentic / Semantic
```

---

# 63. Intervention Decision

发现风险 != 通知。

至少评估：

```text
Severity
Urgency
Confidence
Actionability
User Cost
Interruption Cost
```

---

# 64. Proactive Level

```text
P0 Silent
P1 Insight
P2 Suggest
P3 Notify
P4 Act
```

P4 必须受 Permission 控制。

---

# 65. Notification Budget

支持：

- Daily Budget
- Cooldown
- Dedup
- Aggregation
- Escalation

例如：

```text
Max interruptive notifications / day
```

同一个 Risk 不重复刷屏。

---

# 66. Risk Lifecycle

```text
Detected
→ Monitoring
→ Escalated
→ Resolved
```

随着 Deadline / Confidence 升高，提高介入等级。

---

# 67. Snooze

支持语义化：

```text
今天不提醒
本周不提醒这个项目
Deadline 剩两天再提醒
只显示在 Today
```

---

# 68. Focus / Attention Model

第一版长期可用简单状态：

```text
FOCUSING
AVAILABLE
BUSY
OFFLINE
```

Focus 时提高通知门槛。

---

# 69. Intervention Feedback

记录：

```text
Accepted
Rejected
Ignored
Snoozed
Modified
```

用于未来调整主动程度。

---

# 70. Intervention Evidence

用户可点：

```text
Why?
```

看到：

- Deadline
- Progress
- Recent Progress
- Estimated Remaining Work
- Available Time
- Confidence

展示证据，不展示 CoT。

---

# 71. Review / Analytics

核心不是日报，而是：

```text
Expected
vs
Actual
```

---

# 72. Review 层级

### Execution Review

单 Task / Run。

### Daily Review

今天计划 vs 实际。

### Weekly Review

Goal / Project Allocation。

### Monthly Review

Goal 是否真正推进。

---

# 73. Gap Analysis

至少：

```text
Time Gap
Completion Gap
Priority Gap
Planning Gap
Agent Gap
```

---

# 74. Goal Alignment

比较：

```text
Declared Priority
vs
Actual Time / Work
```

只陈述偏差，不替用户做价值判断。

---

# 75. Feedback

### Explicit

```text
Accept
Reject
Modify
Too Early
Too Late
Don't Suggest Again
```

### Implicit

```text
Move Task
Delete AI Task
Ignore Suggestion
Actual Duration
Repeated Replan
```

权重：

```text
Explicit
>
Repeated Implicit
>
Single Implicit
```

---

# 76. Learning Evidence

不能：

```text
Observation
→ Preference
```

应：

```text
Observation
→ Evidence
→ Pattern
→ Hypothesis
→ Validated Preference
```

---

# 77. Personalization Review

Weekly Review 可以显示：

```text
What the system learned
```

用户：

```text
Correct
Incorrect
Edit
```

---

# 78. Preference Drift

Preference 应具有：

```text
confidence
evidence_count
last_observed
decay
status
```

长期无证据，Confidence 下降。

---

# 79. Agent Evaluation

系统不仅 Review 用户，也 Review Agent。

例如：

```text
Task Type
Success Rate
First-pass Rate
Retry Rate
Human Reject Rate
Cost
Latency
```

未来可以反哺 Router。

---

# 80. Workflow Evaluation

记录：

```text
Runs
Success
Average Retry
Common Failure
Average Duration
```

未来做 Workflow Learning。

---

# 81. Workflow Learning

例如用户连续多次手动增加同一 Step：

系统建议：

```text
Add this step to default Workflow?
```

属于 V2。

---

# 82. Human Attention Optimization

长期产品目标不是：

```text
More Task Completion
```

而是：

```text
Goal Progress
+
Human Attention
+
Agent Capacity
```

高判断 / 高创造 / 高责任：

```text
Human
```

高重复 / 高检索 / 高结构化：

```text
Agent
```

---

# 83. Review Inbox 与 Proactive 区别

Review Inbox：

> 需要用户决策的事项。

Proactive：

> 系统主动识别值得关注的问题 / 机会。

Proactive 不应直接等于弹通知。

---

# 84. Checkpoint / Time Travel

V1.5。

Checkpoint 管：

```text
Project State
Tasks
Decision
Workbench Config
Workflow Config
Artifact References
```

功能：

```text
View
Compare
Restore
```

Git 管源码。

Project Checkpoint 管工作状态。

---

# 85. Project Bootstrap

V1.5。

导入现有：

```text
Folder
Repo
Documents
```

自动分析：

- README
- Git
- Directory
- pom / package
- Docs
- Recent Commit

建议：

- Project Type
- Workbench
- Initial State
- Knowledge
- Next Action

---

# 86. Information Architecture

2026-09-29 目标调整：一级体验围绕继续工作、新目标、执行进展、产物和人工判断组织。项目承载长期上下文，任务列表、知识阅读与活动追溯仍可直接访问；不要求业务对象与一级菜单一一对应。具体入口与兼容关系只在[工作台第 14 节](../../frontend/workbench-design/part-03.md#14-以目标协作为中心的工作台改造)维护。

原 V1 同级导航基线（历史布局，继续提供兼容入口，不作为改造后的固定菜单顺序）：

```text
Today
Projects
Tasks
Knowledge
Activity
```

底部：

```text
Connections
Settings
```

预留：

```text
Automation (Later/Beta)
```

---

# 87. Today UI

Today 保留日期、Focus/Pin/Later 与候选资格语义，作为每日安排视图；它与目标协作主入口的层级按工作台第 14 节提案评审。不能把 Today 查询投影直接称作全部执行任务，也不通过界面重排改变其排序事实。

```text
Today's Focus
Next Actions
AI Working
Inbox
Insight
```

---

# 88. Project Detail

目标体验先呈现项目接续、当前成果、未决事项和下一步。以下基础 Tabs 保留为对象浏览入口，不要求用户先遍历这些页面才能开始协作：

```text
Overview
Tasks
Knowledge
Artifacts
Activity
```

Workbench 可动态注入。

---

# 89. Task Detail

目标体验将当前目标、协作进展、产物和必要判断组合在一个持续工作空间。以下字段仍须可查看，按当前工作需要逐步展开，不要求默认把所有字段铺成表单；展开方式不隐藏影响批准或验收的必要依据。当前实现与目标结构分别记录，见工作台第 14 节。

显示：

```text
What
Why
Project
Goal
Expected Result
Acceptance Criteria
Estimated Effort
Execution Mode
Dependencies
Result
```

按钮：

```text
Me
AI Assist
Delegate AI
```

---

