# Relay 扩展模型：Skill、Blueprint 与 Pack

角色：扩展组合、Skill 定义及蓝图应用的专题设计，沿用原路径避免重复事实源。日期：2026-09-21。状态：用户已确认纳入评审后的首批方向及扩展模型；具体实现设计仍 Proposed，未实现。来源：用户三份扩展建议及后续文档修改指令；与现有总纲、Assist、领域 Owner 和四份契约对照后形成。取舍见 [ADR-008](../decisions/ADR-008-declarative-skills.md)，分期与差异见[范围矩阵](../requirements/v1-scope.md)。

## 1. 定义与最小范围

Relay Skill 是面向特定工作意图、可复用、可版本化、具有明确输入输出契约的 Agent 能力包。它组合 Instructions、Context Profile、Workflow Binding、Capability Requirements、Output Schema、Verification，以及可选 Workbench 模板；不是单独的 Runtime 或新的业务事实层。

| 概念 | 职责 | 不获得的权力 |
|---|---|---|
| Tool / Adapter | 执行具体动作 | 不因被 Skill 引用就跳过 Gateway |
| Workflow | 步骤、等待、修正与恢复 | 不由 Skill 建立另一套 Run 状态机 |
| Workbench | 展示共同事实、提供业务操作 | 不保存第二份 Project State |
| Rule | 约束工作过程 | Skill 中的文字不自动成为已生效 Rule |
| Skill | 复用上述定义与执行方法 | 不授予 Permission，不直接写领域存储 |
| Relay Pack | 按领域组织固定版本的 Blueprint、Skills、流程、Profiles、模板、规则和 Eval | 原称 Skill Pack，统一为同一组合概念；选择不等于批量授权或应用 |
| Plugin | 引入新代码实现 | V1 不提供此类扩展入口 |

V1 展示旗舰为 `goal-to-project-blueprint`，用户名称“从目标创建项目蓝图”（原“从目标创建工作台”，名称调整强调工作台只是蓝图的一部分）。只使用 General / Thesis / Development 的内置模板、注册页面及有类型的数据筛选；不生成 Vue 源码，不增加自定义路由、Block、Query 或 Action。展示入口不等于工程最先实现：先形成任务定义、项目恢复和验收方案能力，再接蓝图入口。

首批范围与后续目录统一见本文第 7 节：任务定义、项目恢复、验收方案与蓝图作为 V1 首批 Skill 目标；修复、交接、确定性状态更新由核心闭环提供，按需增加 Skill 包装；Decision Capture 后续补充。不能以八个名称要求八套独立执行系统。Thesis / Development Pack 先表示内置组合的组织方式，不建设下载器或 Marketplace。

## 2. 定义与版本绑定

SkillDefinition 由应用组合入口管理的第一方只读注册表提供，不新建独立服务。V1 内容随应用发布：Instructions、受限 schema、Context Profile、内置流程/规则/验证配置引用、内置视图模板引用和评测样例。引用必须解析到随包注册对象，不能作为文件路径、远程 schema URL 或动态模块导入执行。

建议定义结构如下，标识符仅为本设计示例，不表示仓库已有这些资源或生产枚举：

```yaml
id: goal-to-project-blueprint
version: 1.0.0
applies_to: [project]
invocation_mode: assist
input_schema_ref: builtin/project-blueprint-input-v1
output_schema_ref: builtin/project-blueprint-output-v1
context_profile_ref: builtin/project-bootstrap-context-v1
workflow_ref: null
required_capabilities: []
optional_capabilities: [READ_KNOWLEDGE]
verification_profile_ref: builtin/blueprint-checks-v1
workbench_template_refs: [general, thesis, development]
permissions:
  grants: []
eval_cases_ref: builtin/project-blueprint-cases-v1
```

没有资料时只用用户输入即可建议，不把 READ_KNOWLEDGE 设为无条件必需。声明的 Capability 标识须由服务端映射到实际注册能力；必需能力不可用则拒绝开始，可选能力不可用则明确缺失并省略对应输入。第一方 Skill 也不能读取用户未授权范围。

`workflow_ref` 在 Delegate Skill 中必须指向固定 WorkflowVersion；Assist Skill 不为满足字段形状而伪造 Workflow Run。所有 schema/profile/template/workflow 引用均解析为精确版本并计入定义摘要；`latest`、外部可变路径或仅保存版本标签不足以固定行为。`id + version` 内容不可变，同标签不同摘要拒绝注册；更改生成新版本。

调用保留 Skill ID、版本、定义摘要和解析后的依赖版本。Assist 请求、ContextManifest、提案及应用记录可追溯它；Run 场景写入冻结的 ExecutionContract。历史定义快照保留供核对，升级不覆盖旧调用、不自动迁移项目。历史定义不可用时明确标记，不能以新版替代重放；被禁用版本不能启动新调用或应用待处理提案，已提交历史仍可查询。

Skill 指令低于产品安全边界、当前 Permission 和适用 HARD Rules。Context Profile 可声明额外必需输入和合法可选上下文，不能删除核心 Mandatory；缺失必需输入时停下而非静默裁剪。资料内的指令始终是数据。检查未知字段、注册 ID、作用域、版本、输出大小/集合上限及引用完整性；上限数值在实施前按真实输入样例冻结。

## 3. 执行入口与唯一 Owner

| 场景 | 使用现有路径 | 证据与输出 |
|---|---|---|
| 初次从目标装配项目 | 正常创建最小 Project → Assist → Context / ModelPort | 绑定 Assist 请求的蓝图提案，不创建 Task/Run 充当技术容器 |
| 已有项目的建议 | 当前项目 Assist，显式选择资料 | 基于确切 revision 的提案，不自动覆盖已有事实 |
| 已有 Task 的自主 Skill 执行 | 用户明确 Delegate → 冻结 Skill/Workflow/执行契约 → 原 Run/Step/Gateway | Artifact 或配置提案；完成仍走既有验证和完成用例 |

V1 蓝图只读取应用查询入口已获准的事实与显式选择的受管资料，不从 Skill 发起文件扫描、URL 获取或 Shell。尚未导入的资料走现有用户导入流程；无 Project 的通用 Assist 仍遵守原范围限制，不因 Skill 获得新 Gateway 来源类型。

Project Owner 保存 `ProjectBlueprintProposal`；Workbench 拥有实际 ViewConfiguration，Task 拥有新任务，Information 拥有 Rule，Workflow 拥有执行配置。Application 解析提案并协调各 Owner 写入口，注册表、Context、模型与前端都没有 Repository 写权。ProposalDTO/Review Inbox 仅投影类型化提案，不再存一份可修改状态。

不改变 [Assist](runtime-context.md) 的生命周期：生成失败、取消和预算耗尽记录在原请求，不新建 SkillRun/SkillJob。Delegate 使用原 Run 恢复位置和动作身份；Skill 升级不能成为重发 UNKNOWN 动作的理由。

## 4. 蓝图输入与输出

输入包含项目名、目标/Project Intent、显式关联或拟关联 Goal、已导入资料版本、现有状态与约束、必要澄清回答。Goal 只是输入之一；例如“拿到 Java 后端实习”不能直接推定为论文或开发项目。存在影响模板选择的歧义时给出简短选项并询问，仍可先手工使用 General 工作台。

V1 按总纲 First Value Moment 先创建最小项目；拒绝蓝图不会删除已经创建的项目，生成失败也不阻塞人工路径。新项目使用当前事实基线；已有项目不得把“初始状态”当清空操作。

输出严格分成两部分：

| 部分 | 可包含内容 | 应用语义 |
|---|---|---|
| 本次蓝图变更 | 已有 Goal 关联、State 类型化补丁、Next Action、待创建任务、内置 ViewConfiguration | 显示逐项差异后，一次明确接受；全部选定的本地业务变化同一短事务 |
| 后续配置建议 | Project Type/Phase Model 建议、轻量 Milestones、Rule 模板、Workflow/执行配置绑定、Verification Profile、缺失能力说明 | 支持的配置分别打开对应入口确认；未有正式写契约的内容只保留建议。不属于“应用蓝图”效果，不创建权限、不启动 Run |

Phase Model 只引用内置 Project Type 的版本化词汇，阶段值必须属于当前类型词汇；粘贴示例的 `RESEARCH_THESIS` 和自由阶段列表仅是说明，实际映射到本项目 `THESIS`，不能直接新增持久枚举。现有 API 仅定义创建项目时选择类型，尚无类型变更命令：已有项目只展示类型建议，不在 Skill 内增设旁路；需要另一类型的新项目时，用户在正常创建入口选择后重新生成蓝图，不自动迁移当前项目。

State 不复制 Task 状态。现有总纲要求 Milestone 建议，但当前字段/API 未完整定义其写契约，故蓝图先保留为建议；不能把未完成里程碑写进 completed_highlight_refs，正式落库需先补齐 Project 内的字段/命令设计。新任务按现有 CreateTask 规则创建为 `INBOX` / `ME`（`executor_kind=HUMAN`），不自动 Ready 或 Delegate；用户确认的阶段目标可表达为明确的普通任务，但不伪装成独立 Milestone 实体。提案内新任务使用局部键；事务内映射真实 ID，再校验 Next Action 和任务引用。Goal 关联只引用同作用域有效 Goal，创建新 Goal 走独立命令；“把一句目标写成已确认 Goal”不隐式发生。

Workbench 部分只提供 kind、注册页面的显隐/排序和已注册查询的有类型筛选参数。基础导航与恢复/Review 入口不可隐藏；服务端继续校验项目作用域。禁止脚本、SQL、表达式、Vue/React 源码、动态导入与作为执行目标的任意网络地址。未知页面或筛选字段不能静默丢弃后显示“成功”。

## 5. Preview / Diff / Apply

1. 生成：固定目标、事实/资料版本、Skill 依赖版本与候选 payload；schema、注册引用、Scope 和规则兼容检查通过后才展示可接受提案。保存可复核检查结果，结构合法不等于事实正确或 Task Verification PASS。
2. 预览：使用生产同一套注册模板，以只读数据投影展示；不调用动作、不写事实、不自动加载候选网络地址。Diff 明确新增任务、State/Goal 变化和导航变化，并将后续配置建议分区显示。
3. 修改：每次改动或改变选中项都生成新的不可变候选与 payload_hash，标明替代关系；重新检查和预览，不能复用旧确认。V1 不提供任意 JSON Patch 编辑器。
4. 接受：`ApplyProjectBlueprint` 通过通用提案接受入口分发。核对身份、目标、候选 hash、依赖版本、当前权限和所有待修改对象 revision，再调用领域入口。新任务/State/Goal 关联/视图、提案 ACCEPTED、来源关联、审计及命令回执同事务提交；模型、文件导入、工具执行和人工等待均在事务外。
5. 冲突或失败：任何必要基线、来源、有效规则或注册定义变化，都拒绝本次写入并要求重新生成/预览。事务中任一写入失败整体回滚；同命令重放返回原回执。不同命令竞争接受同一提案最多产生一组业务效果；提交后响应丢失查原回执，不重新生成蓝图。
6. 拒绝或过期：按既有 PENDING/ACCEPTED/REJECTED/EXPIRED 语义处理，保存来源但不改项目。用户修改 Goal 或升级 Pack 只产生新建议，不自动改导航。已应用结果的后续调整形成新命令与新 revision，不删除历史或提供假“事务回滚”。

首次接受时锁序和 Authority 协议沿用[物理设计](../database/physical-design-postgresql.md)；提案终态 CAS 与所有效果同事务。涉及的 Project/Goal/View/Proposal 锁落点及基线集合查询需在 D 阶段 migration 前补齐并通过真实 PG 竞争测试，不凭文档声称已经具备原子能力。

Rules、执行配置及验证计划分别接受时，依旧执行原有 Authority/失效协议。工作台显示变化不改活动 Run 的 contract hash；Rule 接受若影响活动 Run，必须按原契约持久化控制意图并安全处理，不能以蓝图已批准作为继续执行的依据。Review 表达用户判断，只有成功回执表示相应业务变化已应用。

## 6. 分期、验证与实施出口

V1 第一方注册定义与首批 Skill 在 P11/P12/P14/P15 对应职责中接入，不提前占用 P00/A 的工程范围。修复、交接和完成更新先由 P05–P08 的核心机制验证，D 阶段才组合其 Skill 表达。先研究现有定义、结构化输出与版本机制的可复用点，按 ADR-005 留来源证据；本设计未声称研究过某个第三方 Skill 实现。

V1.5 声明式自定义 Skill、Page Schema/Block Registry 是后续候选；AI 生成 Schema 从原 V2 前移至 V1.5 尚待确认。注册 Page Schema 仅引用允许的 Block/Query/Action，Preview/Diff/Apply 原则保留；具体 schema、存储与迁移另设计，不能将本节理解为 V1 通用页面引擎。V2+ 再评估第三方 Pack、代码组件和 Plugin SDK 的来源信任、隔离与兼容，不提前建设市场。

验收场景维护于[测试计划](../testing/verification-plan.md#8-relay-skill-与蓝图应用验收)，存储落点维护于[逻辑模型](../database/logical-model.md#10-skill-与蓝图的持久化补充)，API 扩展维护于[模块接口](../api/module-api.md#5-skill-与蓝图提案)。尚需实施冻结：输出大小预算、正式 schema、注册 ID 集合、定义保留方式、锁协议和 migration；它们是实现前置项，不是已运行能力。

## 7. 首批闭环能力与后续目录

2026-09-20 用户确认纳入评审后的方向。以下区分产品能力、Skill 输出和核心执行责任；优先级不改变 P00–P22 的阶段依赖，也不是完成状态。

| 优先顺序 / 定位 | Skill / 用户名称 | 输入与输出 | 应用责任与边界 |
|---|---|---|---|
| 首批基础 | `task-to-execution-contract` / 完善任务定义 | 任务意图、已选资料、规则 → Objective、Expected Result、验收条件、输入绑定、建议模式的类型化提案 | Task Owner 接受提案；Workflow 在 Delegate 时冻结 ExecutionContract，Skill 不直接签发有效执行契约 |
| 首批基础 | `project-resume` / 继续这个项目 | State、当前任务、有效 Decision、产物/验证、待处理 Review、Activity → 带版本来源的现状、变化、风险与下一步摘要 | 只读，不从聊天推定当前状态；区分已验证与已业务完成，不自动解除风险、恢复 Run 或开始任务 |
| 首批基础，与任务定义配套 | `verification-plan` / 生成验收方案 | 结果定义、验收条件、适用规则、可用检查器/工具 → 可审查的 Hard/Rule/Semantic/Human 检查建议 | Verification 拥有有效 CheckPlan；只组合注册检查器及其合法参数，不能生成执行代码、删必需检查或把缺失能力标为通过 |
| 首批展示入口 | `goal-to-project-blueprint` / 从目标创建项目蓝图 | 目标、资料、约束 → 项目与内置工作台提案 | 沿用第 4–5 节，不自动启动任务 |
| 核心闭环，按需包装 | `verification-repair` / 根据检查结果修正 | 确切产物版本、失败 criterion/证据、原验收、用户改动 → Repair Contract 与新候选版本 | 原 Workflow 的修正预算、Step/Attempt、Gateway 和 Artifact Owner 生效；无第二修复 Runtime |
| 核心闭环，按需包装 | `handoff-package` / 整理交接资料 | 当前执行/控制状态、版本化产物、验证、决定、未决动作 → 可继续工作的交接包 | 核心 Handoff 协议转移执行权；生成文本不代表完成交接 |
| 核心提交，推断部分可包装 | `verified-state-delta` / 更新项目进展建议 | 有效验证、Task 结果、State 基线 → 可解释来源与推断性 State 提案 | 确定性 delta 由 CompleteTask 程序规则产生并提交；LLM 不能声明某字段“确定性”后直接写入 |
| 后续补充候选 | `decision-capture` / 记录为项目决定 | 用户明确结论与来源 → Decision 提案及可能的替代关系 | 用户确认后由 Information 写入；理由/候选/代价缺失标待补充，不凭空补齐，不自动替代旧决定 |

### 7.1 契约准备先于执行

任务定义与验收方案在 Delegate 前审查并接受；建议模式不是授权。Verification 根据已接受验收、适用规则与注册能力确定检查计划，Delegate 冻结相关版本。Workbench 仅为选取展示或建议模板的线索，不能因切换工作台改变检查义务。

“确认并委托”可以是组合交互，但必须依次完成明确版本的提案接受和合法 Delegate；接受成功而 Delegate 失败时展示真实结果，并按原命令身份重试，不能隐藏半完成状态。验收不足、规则冲突、必需检查不可用时不能 Delegate。活动 Run 期间实质改变验收走既有版本失效、安全停止及重新 Delegate 协议，不能事后降低通过标准。引用可解析仅证明标识可解析，不证明论断有来源支持。

### 7.2 定向修复与安全交接

Repair Contract 至少绑定 ArtifactVersion/hash、失败 criterion 与 Evidence、允许修改范围、应保留内容、验收版本和剩余修正预算。只能对可修正 FAIL 启动修正；Checker ERROR/NOT_RUN 先处理检查本身，UNCERTAIN/预算耗尽按原 Review 路径处理。新产物形成新版本与验证记录，不能把旧 PASS 原样绑定到新版本；适用性和必要回归由 Verification 决定，Worker 无权删改基准。人工编辑或基线改变后先重新核对，不用旧补丁覆盖用户内容。

交接包包含目标、当前事实、已完成工作及证据、约束、产物版本、验证状态、未决问题/动作、下一步和当前执行者。决定 Owner/UNKNOWN/完成状态的字段由核心查询提供，模型只组织说明；生成失败不能阻塞安全停止，应能展示确定性的最小交接资料。包在安全点固定引用，等待中的预览不得显示“已接手”。仅作人工判断属于 Review；编辑需完整 Handoff。Handoff 完成后再交给 AI 创建新 Run，引用人工修改与交接证据，不承诺原 Run 自动续跑。

### 7.3 状态更新与项目恢复

自动执行的确定性 State delta 仅在合法完成事务中，由程序根据当前有效验证、执行权、完成周期和事实映射计算，必要时为空。PASS 后崩溃只恢复完成提交；重复命令不重复追加 delta。阶段推进、风险解除等推断进入独立 State 提案，接受时重查 revision 和来源；模型建议失败不撤销合法完成，也不能重写整份 State。

Project Resume 读取当前权威事实与明确版本引用；旧摘要只能作带日期的历史输入。重开任务、已替代 Decision、撤销验证不再被描述为当前完成或有效。没有上次访问/比较基线时只展示当前状态，不编造“自上次以来”的变化；来源不可用明确标注，未知耗时/进度不估成确定数字。建议下一步复用 Today 的合格候选与 reason_codes，不越过依赖、Later、阻塞或执行权。

### 7.4 后续候选与领域组合

| 批次 | 候选 | 限制 |
|---|---|---|
| 首批之后 | `decision-capture`、`next-action-advisor` | 分别复用 Decision 确认与确定性 Today；不补造理由或“预计 30 分钟”，不自动改排序/计划 |
| V1.5 候选 | `repo-to-project-bootstrap`、`artifact-to-knowledge`、`workbench-compose`、`rule-pack-generator`、`risk-opportunity-review` | 仓库读取需受控 Files/Git；规则先审查且不授权；风险审查不隐式创建调度/通知；Schema 生成前移仍待确认 |
| V2 候选 | `workflow-improvement`、`skill-recommender`、`agent-evaluation-report`、`workflow-evaluation-report`、`memory-review`、`preference-hypothesis`、`agent-routing` | 依赖真实样本和既定产品分期；不提前引入自动画像或多 Agent Router |

后置的是智能建议或专门包装：V1 已有显式 Artifact → Knowledge 提升、Memory 确认、内置视图选择与规则管理，不因上述目录而推迟这些基础能力。`workbench-compose` 负责视图提案，Blueprint 负责项目装配；通用 Renderer 仍是应用代码，不要求每次显示都调用模型。

Thesis Pack 候选：thesis-bootstrap、research-question-refinement、literature-matrix、source-validation、chapter-outline、chapter-verification、experiment-design、result-analysis、citation-audit、defense-preparation。优先利用资料版本、来源证据和独立验证，不宣称标识解析等于学术正确。

Development Pack 候选：repo-bootstrap、requirement-to-tasks、change-impact-analysis、implementation-contract、test-repair-loop、release-readiness、architecture-decision-capture、project-to-resume。其中 `project-to-resume` 指基于项目证据撰写简历描述，与 `project-resume` 的继续项目不同；只能引用真实完成/测试/发布证据。Pack 复用首批机制，不创建同义的第二执行流程；以上名称不构成全部 V1 必交功能。

演示链：目标 → 蓝图预览与应用 → 明确任务与验收方案 → Delegate → 执行/验证 → 必要时定向修复并复验 → 完成事务与确定性 State 更新 → 可选确认 Decision/推断提案；中途可安全 Handoff，下次由 Project Resume 恢复工作上下文。Run 状态机、权限、Gateway、Context 核心装配、产物版本、Review 消费及执行权始终属于核心模块。

## 8. 可组合扩展模型

本节定义组合协议，不要求每个名词对应新模块、表或服务。V1 用实际内置能力验证组合，后续才考虑外部分发。

| 概念 | 复用关系 / 唯一责任 | V1 边界 |
|---|---|---|
| Blueprint | 内置蓝图模板 + 目标相关的候选输出；应用交 Project/各领域 Owner | 模板可复用，生成实例始终需预览与确认 |
| Skill | 组合输入、上下文、执行方法和输出契约 | 第 7 节首批能力，无独立运行状态机 |
| Workflow Recipe | WorkflowDefinition/Version 的复用称谓，由 Workflow 管理 | 内置固定步骤，不新增 YAML 执行 DSL；固定步骤不保证模型/外部结果确定 |
| Profile | 各模块拥有的版本化配置，详见下表 | 内置配置/模板，不建设万能策略解释器 |
| Adapter | Model/Tool/外部执行端/存储的实际端口实现 | 按现有研究与实际调用实现，不按候选名单批量创建 |
| Proposal | 领域提案 + 统一查询/预览/命令分发 | 没有独立万能写入 Owner，不执行包内回调 |
| Relay Pack | 应用组合入口管理的只读领域组合清单 | 第一方 Thesis/Development 组合，随应用发布 |
| Eval | 版本发布前的工程回归证据 | 与单次任务 Verification 分开，覆盖实际交付成员 |
| Trigger | 何时请求一次执行 | 手动调用；自动调度/事件触发后置 |

### 8.1 Pack 定义与应用

Pack 的最低定义包含身份/版本、内容摘要、支持的定义格式与宿主契约版本、成员的类型/ID/精确版本/摘要、依赖、Eval 集引用。成员可以引用 Blueprint 模板、Skill、固定 Workflow、Profiles、Rule/Artifact/Workbench 模板；未实现成员不列为可用能力。V1 Thesis/Development Pack 只组合已经落地的内容，不要求第 7 节所有领域候选同时交付，也不要求用户使用 Pack 才能手工建项目。

V1 定义随应用发布并由只读注册表解析；manifest.yaml 和目录形状只是可选文件组织，不是已实现协议。引用是有类型注册 ID，禁止脚本、动态模块、任意路径或远程 schema。解析得到固定成员清单，拒绝未知成员、循环依赖、同类型同 ID 的冲突版本以及不兼容 schema/宿主契约；同 ID/version 不同摘要拒绝加载。数量/深度/大小预算实施前冻结；不构建通用联网依赖求解器。

四个问题分开表达：定义是否可用；本次提案选择了哪个版本；哪些配置已应用到项目；当前动作是否获准执行。它们不是四份冗余可变状态表。选择 Pack 只为提案解析固定来源，不激活 Rules、Permission 或 Workflow，也不启动 Run。真正应用后的绑定/来源由各配置与应用记录表达，项目可以显示混合来源和手工修订，不能仅靠 `pack_version` 声称全部配置一致。

第一方包升级随应用交付新定义。旧提案/配置/Run 固定原引用；历史快照保持可核对性。应用更新时比较旧应用结果、当前用户修改和新模板，保留用户改动，冲突要求重新选择/预览，不能用新模板覆盖 current。规则/权限/执行配置依旧分别确认；V1 不提供一键原子升级整包的承诺。可自动发现版本变化，不自动应用；签名、来源信任、隔离和外部下载在第三方分发前另立决策，签名也不能代替安全准入。

卸载/禁用未来包时不得级联删除已创建 Task、Artifact、Rule 或历史证据。历史引用保留；新调用、待处理提案和活动执行的安全处理按所属配置/控制协议执行，不能加载新版替代旧引用或因禁用包跳过 UNKNOWN 核对。

### 8.2 四类 Profile 的边界

| Profile | 负责模块 | 允许声明 | 不得覆盖 |
|---|---|---|---|
| Context | Context Builder | 已授权的额外必需输入、检索范围/偏好与预算内的选择规则 | 核心 Mandatory、当前权限、作用域；额外必需内容超预算也必须报错 |
| Verification | Verification | 已注册检查器、合法参数、适用对象与人工检查建议 | 已确认验收、适用 HARD、Worker 无权弱化的基准；不可自动生成可执行检查代码 |
| Permission | Permission | 供用户审查的策略模板，作用域、动作、AUTO/ASK/DENY 建议 | Pack 选择不授权；显式形成 PermissionPolicy 后仍由 Gateway 按当前策略准入 |
| Projection | Workbench 查询/展示；Agent 表达由 Context Builder 消费 | 已授权同一事实的排序展示、字段组织、内置文案/组件选择 | 不改 Today 资格与业务排序、不隐藏必需 Review/风险、不替 Context 决定资料访问或删除 Mandatory |

Profile 不是业务事实副本，也不引入新 Owner；多个 Profile 的冲突按既有规则合并协议处理，不能用“最后加载的包获胜”覆盖 HARD/DENY。执行配置引用的 Profile 版本随契约冻结，展示配置单独修订；展示切换不改活动执行契约。Permission 模板中的文件写入/测试 AUTO 不能成为默认安全保证，仍须满足既有受信项目、脚本基线、资源与审批条件。

### 8.3 Proposal 的统一体验与受控恢复

统一流程为 Validate → Preview/Diff → 明确接受/修改/拒绝 → 固定领域命令 → 查询成功回执。State、View、Rule、Workflow、Memory、Decision 等提案仍归各 Owner；只注册当前确有写入口的类型，V1 不预建 SKILL_INSTALL/PACK_UPDATE 等无调用方枚举、端点或通用 JSON Patch 引擎。

预览按实际目标版本计算影响，包括受影响的活动 Task/Run、检查与审批失效、尚未生效的依赖。添加 HARD Rule 不能预先承诺“不影响当前任务”；包更新也不能借 Workbench 提案携带执行配置写入。跨领域组合只有显式定义同事务协议时才能报告原子成功；多个独立命令分别展示结果和重放回执，失败不伪装整包已应用。

未应用的提案可以拒绝；已应用后的修正是基于当前 revision 的新提案/新命令。配置旧版只能作为候选来源，不能恢复旧审批、PASS、执行权或删除历史。对文件/Git/网络等外部效果不能承诺数据库回滚；需要受控补偿时重新走 Gateway、权限与核对。名称使用“查看差异/恢复配置建议”，不笼统宣称“撤销所有效果”。

### 8.4 Adapter、来源视图与恢复

ModelPort、Tool Adapter、外部执行端适配及 Artifact Storage 各保留本职端口。外部 harness 的 session/turn/Handoff/Trace 显式关联产品 Run，不能直接替换产品语义；必须实现 Gateway 准入或已验证的等效边界。Human 是业务参与者，必要人工步骤可走已有 Human Tool/Review/Handoff，不能为统一适配器签名伪造模型 Run。V1 存储沿用受管本地内容与 PostgreSQL 元数据，不预建远程存储适配。

V1 Run Detail/Assist 来源视图读取实际 ContextManifest，展示已采用来源版本/片段、注册定义与 Profile 版本、合法范围内的排除理由及裁剪证据。已撤销读取权的历史正文不得因快照留存而继续展示；其他项目的无权对象不泄露名称、ID 或数量，只给不泄露存在性的范围说明。来源被纳入 Context 不证明它因果决定了答案，不能据此编造模型思考。完整 Inspector 的搜索/比较交互后置。

Run Checkpoint 复用已持久 Step/Attempt、Manifest、产物/工具结果、等待与恢复位置；恢复不重发成功或 UNKNOWN 动作。Replay 分清输入重建、隔离评测和业务续跑，不能以“重放”名义对真实外部系统重复写入。Project Checkpoint 后续先支持一致的版本引用集合和查看/比较，恢复需生成新提案、检查活动 Run 与依赖；不是整库倒退或外部效果回滚，V1 不要求每次蓝图应用先生成完整项目快照。

### 8.5 Eval 与后续 Trigger / Importer

Contract Eval 检查 schema/引用与输出完整性；Behavior Eval 检查规则、作用域、权限、提案及恢复边界；Outcome Eval 评估结果质量、错误接受/拒绝、完成率与成本。Verification 判一次 Task 的具体版本，Eval 比较固定定义版本在样本集上的表现，二者不能共享一个可被 Skill 修改的最终判定标准。V1 每个实际交付 Skill 附必要用例，Pack 再验证成员组合；升级基于固定基准回归，程序性安全失败阻止启用受影响定义，语义质量变化需报告而非仅看内部 PASS 数。

具体发布证据与场景归[测试计划](../testing/verification-plan.md#9-扩展组合与版本评测)，论文研究仍按[实验协议](../research/evaluation-protocol.md)另行确认；工程 Eval 不依赖选做 P22，也不能据此声称论文结论。

V1.5 Trigger/Automation 是经过授权的请求入口，须定义稳定事件/计划身份、重复触发去重、作用域、预算、并发排他、取消和审计，不能绕过 Delegate/Gateway。Agent-detected 结果先作触发建议；验证通过也不自动提升 Knowledge、解除风险或授予权限，除非后续已有明确可审计的授权策略。正文中的周日/事件触发只是产品设计例子，不创建实际定时任务。

Importer 后续通过受控 Files/Git 读取已选择根的资料和状态，生成有基线与来源的 Blueprint 提案。仓库文档、脚本及历史提交是不可信输入，识别测试配置不等于获准运行测试；导入不自动执行安装脚本、不将 README 声明当测试通过、不把整个磁盘变为资料范围。先确认导入/提案再写领域事实，保留既有手工建项目与受管资料导入路径。
