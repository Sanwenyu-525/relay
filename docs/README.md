# 文档入口与维护规范

右侧工具面板与内置网页预览（2026-10-24，已授权规划，推荐方案未实施）：[工作台 §50](frontend/workbench-design.md#50-右侧工具面板与内置网页预览)拥有交互，[路线 §17](requirements/post-v1-roadmap.md#17-右侧工具面板与内置网页预览)拥有范围与分包，[浏览器架构 §15](architecture/browser-automation-v1.md#15-右侧内置网页预览的规划边界)拥有宿主隔离与选型门槛，[测试计划 §45](testing/verification-plan.md#45-右侧工具面板与内置网页预览的目标验收)为未运行规格；沿用现有 Chrome 扩展自动化，不改变当前开发排期。


项目级长期 Agent 团队（2026-10-23，已确认、待实现）：[总纲 §0.18](../Personal_Workflow_OS_Master_Spec.md#018-项目级长期-agent-团队与跨会话协作)拥有产品规则，[路线 §16](requirements/post-v1-roadmap.md#16-项目级长期-agent-团队与跨会话协作)拥有范围与工程待核定项，[领域模型 §23](architecture/domain-model.md#23-长期-agent-成员与跨会话协作的应用边界)拥有责任，[ADR-034](decisions/ADR-034-persistent-project-agent-team.md)记录取舍，[工作台 §47](frontend/workbench-design.md#47-长期-agent-团队私聊群聊与工作概览)拥有交互，[测试计划 §44](testing/verification-plan.md#44-长期-agent-团队与跨会话协作的目标验收)为未运行规格。成员身份、会话与运行分离，项目不额外设置额度上限；本轮仅文档，不改变阶段或验收成绩。

差异化体验规划（2026-10-24 接续）：[产品总纲 §0.17](../Personal_Workflow_OS_Master_Spec.md#017-长期项目协作的差异化体验)记录原六项方向与本轮五个推荐方向的确认和映射，新增围绕成果工作的专用工作台；[后续路线 §14](requirements/post-v1-roadmap.md#14-差异化体验的范围与推荐顺序)记录复用关系、推荐顺序与实施前置，[工作台 §45](frontend/workbench-design.md#45-长期项目协作的差异化体验)拥有推荐交互，[测试计划 §42](testing/verification-plan.md#42-长期项目协作差异化体验的目标验收)拥有未运行场景。仅纳入规划，不改变已有实现成绩、当前开发顺序或执行授权。

2026-10-24 右侧工具面板与内置网页预览导航：用户任务书 [workbench-browser-preview](../prompts/workbench-browser-preview.md) 已执行，[工作台 §50](frontend/workbench-design.md#50-右侧工具面板与内置网页预览)（含 §50.5 实现现状）拥有产品交互，[浏览器架构 §15](architecture/browser-automation-v1.md#15-右侧内置网页预览的规划边界)（含 §15.1 P0 核对结果）拥有宿主与隔离边界，[ADR-035](decisions/ADR-035-in-app-webview-preview.md) 记录容器选型与取舍（不取代 ADR-025 的外部 Chrome 路线），[路线 §17](requirements/post-v1-roadmap.md#17-右侧工具面板与内置网页预览) 拥有范围与顺序，[测试计划 §45](testing/verification-plan.md#45-右侧工具面板与内置网页预览的目标验收) 拥有验证规格。实际成绩与未验边界只归统一验收表，不由导航声明完成。

Agent 执行模式导航：[产品总纲 §0.16](../Personal_Workflow_OS_Master_Spec.md#016-七种-agent-执行模式与产品能力边界)说明 ReAct、Plan and Execute、Reflexion、Workflow、Multi Agent、Agent and Tool、Code as Action 的产品用途与能力边界；[运行架构 §10](architecture/runtime-context.md#10-七种-agent-模式的实现映射)维护源码入口与责任，[§10.1](architecture/runtime-context.md#101-现状分级与证据缺口2026-10-21-差距核对)维护 A/B/C/D 现状分级、缺的证据类与待产品决定项。七种模式可组合，不代表七套引擎或七个 UI 入口；实际成绩只归统一功能验收表。

长短期记忆导航（2026-10-20）：[工程边界](development/memory-module.md)、[ADR-028](decisions/ADR-028-memory-layers.md) 记录长期人工确认与短期窗口的分层，[ADR-030](decisions/ADR-030-zero-click-auto-memory.md) 记录「零点击自动捕获 + 可撤销」的方向（取代 ADR-029 的确认环节，未实施）；[运行架构 §8](architecture/runtime-context.md#8-会话压缩与消息文件恢复)、[HTTP §10.99](api/http-command-contract.md#1099-长短期记忆接口2026-10-19)、[数据库 §105](database/physical-design-postgresql.md#105-01180119-长短期记忆2026-10-19) 定义恢复与协议；[工作台 §40](frontend/workbench-design.md#40-长短期记忆2026-10-20产品行为已确认前端已接实机未验) 拥有产品交互，[测试计划 §40](testing/verification-plan.md#40-完整长短期记忆后端2026-10-20) 拥有验证规格。实际阶段与成绩仍归 CODEX_NEXT_STEP 和统一验收表，不由导航声明完成。

2026-10-18 本地文件免手工配置：用户已确认“选目录＋本目录权限档位＋发消息”，产品规则由[工作台 §18.1.4](frontend/workbench-design.md#1814-本地目录权限设置2026-10-18已确认已实施)拥有；[领域模型 §12.2.1](architecture/domain-model.md#1221-本地目录访问设置的应用责任2026-10-18已实施)与 [ADR-016](decisions/ADR-016-folder-first-conversation.md)记录应用责任和取舍，[测试计划 §17.1.4](testing/verification-plan.md#1714-本地目录免手工配置2026-10-18已确认已实施)定义验收规格，[HTTP 契约 §10.86](api/http-command-contract.md#1086-目录写入档位投影与只读查询2026-10-17-源码实现)与[数据库 §98](database/physical-design-postgresql.md#98-0109-本地目录访问档位元数据2026-10-18-源码实现)记录实现协议。实际运行结果和未验边界归统一功能验收表；实施任务书保留为过程材料。

2026-10-17 内置浏览器自动化导航：用户下达「为 Relay 桌面端增加内置 Chrome 浏览器操控能力」，记为 F26。[浏览器自动化 V1](architecture/browser-automation-v1.md) 拥有选型、模块责任、集成点、打包与测试口径，[ADR-024](decisions/ADR-024-builtin-browser-automation.md) 记录取舍与被拒方案，[范围矩阵 F26](requirements/v1-scope.md#内置浏览器自动化范围补充2026-10-17) 拥有范围边界，[测试计划 §36](testing/verification-plan.md#36-内置浏览器自动化验收规格2026-10-17) 拥有未运行规格，实际让位顺序归 [CODEX_NEXT_STEP](../CODEX_NEXT_STEP.md)。本轮**只做架构审查与选型**：未写源码、未新增迁移、未引入随包资源、未建动作词表，能力未实施未验收。

2026-10-17 内置 GitHub Skill 前移导航：用户否决后置处置，GitHub 内置 Skill 记为 F25 进入 V1 主线。[范围矩阵](requirements/v1-scope.md#内置-github-skill-范围补充)拥有范围边界，[扩展专题第 10 节](architecture/relay-skills.md#10-内置官方-skill-包)拥有官方包的定义落点/分发/按需激活/启用规则，[ADR-023](decisions/ADR-023-builtin-github-skill.md)记录取舍、被拒方案与工程前置，[后续路线第 4 节](requirements/post-v1-roadmap.md#4-后续候选的处置)记录原后置处置的变更，实际让位顺序归 [CODEX_NEXT_STEP](../CODEX_NEXT_STEP.md)，成绩仍只归统一验收表。本轮仅文档：未写源码、未新增随包资源、未建动作词表或迁移，能力未实施未验收，不改变 A–E 既有出口与在途专项。

2026-10-16 免费额度接续更新：[后续路线 §9.1.1](requirements/post-v1-roadmap.md#911-免费额度耗尽自动接续)拥有单模型额度用尽后的有界免费队列规则，[运行架构 §8.6](architecture/runtime-context.md#86-模型目录会话选择与免费调用边界)拥有原契约/独立模型尝试/切换持久身份与恢复，[工作台 §27.5](frontend/workbench-design.md#275-免费模型分组与模型选择)拥有实际切换反馈，[测试计划 §26.3](testing/verification-plan.md#263-免费模型目录与选择验收规格)新增 FM-10–13，[专项任务书](../prompts/free-model-catalog.md)增加验收整改前置。此段记录 2026-10-16 当时仅验收与任务书的授权；2026-10-17 的实际实施授权、分工与下一步只归 [CODEX_NEXT_STEP](../CODEX_NEXT_STEP.md)，实际结果只归统一功能验收表，旧日期门控不能覆盖新的用户授权。

2026-10-16 输入框自动分点与手动润色接入源码：[工作台 §30](frontend/workbench-design.md#30-输入框自动分点与手动润色)拥有交互与首版实施默认（§30.6），[HTTP §10.84](api/http-command-contract.md#1084-输入框草稿辅助自动分点与手动润色2026-10-16-源码实现)拥有端点与协议，[数据库 §89](database/physical-design-postgresql.md#89-0091-输入框草稿辅助的调用证据2026-10-16-源码实现)拥有迁移 `0091` 与记账边界，[提示词设计 §2.1](architecture/agent-prompt-design.md#21-当前运行时提示词路由)拥有两条 `COMPOSER_*` 路由，[测试计划 §31.1](testing/verification-plan.md#31-输入框自动分点与手动润色验收规格)拥有已运行/未运行范围。成绩仍只归统一验收表；三方案视觉未选定，本轮按实现默认 A 交付。

2026-10-15 免费模型分组导航：[后续路线 §9.1](requirements/post-v1-roadmap.md#91-免费模型分组与自动同步)拥有首版范围/免费定义/同步时机，[运行架构 §8.6](architecture/runtime-context.md#86-模型目录会话选择与免费调用边界)拥有目录发布/会话与 Run 冻结/免费调用责任，[工作台 §27.5](frontend/workbench-design.md#275-免费模型分组与模型选择)拥有交互，[测试计划 §26.3](testing/verification-plan.md#263-免费模型目录与选择验收规格)拥有未运行规格，[专项任务书](../prompts/free-model-catalog.md)为后续执行入口，取舍接续 ADR-019。本轮仅更新文档与提示词，未启动本专项代码开发或增加运行验收成绩。

2026-10-15 普通 Agent 主流程设计已确认、待重构：[总纲 §0.5.1](../Personal_Workflow_OS_Master_Spec.md#051-普通-agent-的连续工具主流程2026-10-15已确认待重构)拥有产品规则，[工作台 §18.10](frontend/workbench-design.md#1810-普通-agent-的连续工具主流程)拥有交互，[领域模型 §12.6](architecture/domain-model.md#126-普通-agent-主流程的应用边界)与[ADR-022](decisions/ADR-022-agent-conversation-main-loop.md)拥有责任/取舍，[提示词设计 §2.4](architecture/agent-prompt-design.md#24-普通-agent-主流程与模板选择的区别)区分模板选择和模型分类，[测试计划 §17.2](testing/verification-plan.md#172-普通-agent-连续工具主流程)定义未运行出口。本轮仅文档与任务书，不改已有路由源码或功能成绩；现有模板集中入口不是必须保留三路模型解释的理由。

2026-10-14 任务链执行规格导航：[HTTP §10.78](api/http-command-contract.md#1078-任务链只读执行规格与来源2026-10-14-协议)维护确切资料/原会话只读方法，[§10.79](api/http-command-contract.md#1079-任务链受控修改与检查2026-10-14-协议)维护普通修改/配置检查、范围与原方法行动，[数据库 §86](database/physical-design-postgresql.md#86-0085-任务链执行规格2026-10-14-协议)维护规格与原 Run 授权存储；[领域模型 §21](architecture/domain-model.md#21-基础有限任务链2026-10-14)、[ADR-021](decisions/ADR-021-bounded-task-chain-admission.md)维护 Owner 与资源配置/占有 epoch 区分；[检查范围 §30](testing/verification-plan.md#30-基础有限-markdown-任务链检查范围)限定原权限、实际文件与配置子进程证据，成绩只归统一表。

2026-10-14 基础有限任务链导航：[ADR-021](decisions/ADR-021-bounded-task-chain-admission.md)、[领域模型 §21](architecture/domain-model.md#21-基础有限任务链2026-10-14)维护授权与原 Owner 责任；[HTTP §10.77](api/http-command-contract.md#1077-基础有限-markdown-任务链2026-10-14-协议)、[数据库 §85](database/physical-design-postgresql.md#85-0084-基础有限任务链2026-10-14-协议)维护队列/累计预算/重开协议，[检查范围 §30](testing/verification-plan.md#30-基础有限-markdown-任务链检查范围)限定生产模块与受控模型证据，完整 N06 和 UI 继续后置。

2026-10-14 基础一次性项目提醒导航：[后续路线 N05](requirements/post-v1-roadmap.md#n05-有限触发与提醒控制)、[领域模型 §20](architecture/domain-model.md#20-基础一次性继续项目提醒2026-10-14)维护时间/发生/Owner 边界；[HTTP 契约 §10.76](api/http-command-contract.md#1076-基础一次性继续项目提醒2026-10-14-协议)、[数据库设计 §84](database/physical-design-postgresql.md#84-0083-基础一次性项目提醒2026-10-14-协议)维护协议，[检查范围 §29](testing/verification-plan.md#29-基础一次性项目提醒检查范围)限定真实 API 生命周期与受控通知证据。设置/待处理 UI、真实 Windows 投递继续后置，成绩只归统一验收表。

2026-10-14 基础范围推演导航：[领域模型 §19](architecture/domain-model.md#19-基础固定容量范围推演2026-10-14)维护同一基线和原计划 Owner，[HTTP 契约 §10.75](api/http-command-contract.md#1075-基础固定容量范围推演2026-10-14-协议)、[数据库设计 §83](database/physical-design-postgresql.md#83-0082-基础范围推演2026-10-14-协议)维护三方案与选择协议；[检查映射 §27](testing/verification-plan.md#27-验收证据与投入判断验收规格)限定任务集比较、逐项应用和未知，功能成绩仍只在统一验收表。

2026-10-14 基础下一段计划导航：[后续路线 N04](requirements/post-v1-roadmap.md#n04-周期计划与重排建议)维护产品范围，[领域模型 §18](architecture/domain-model.md#18-基础下一段工作计划2026-10-14)维护 Owner/应用边界，[HTTP 契约 §10.74](api/http-command-contract.md#1074-基础下一段工作计划2026-10-14-协议)与[数据库设计 §82](database/physical-design-postgresql.md#82-0081-基础下一段工作计划2026-10-14-协议)维护数据协议，[检查范围 §28](testing/verification-plan.md#28-基础下一段工作计划检查范围)限定基础测试；当前阶段、实际结果仍归原唯一主文档。UI 后置。

2026-10-11 验收证据与投入判断导航：[总纲 §0.14](../Personal_Workflow_OS_Master_Spec.md#014-验收证据与投入判断)拥有五项已确认产品规则及首个价值试验，[范围补充](requirements/v1-scope.md#验收证据与投入判断补充)拥有 V1 边界，[后续路线 §10](requirements/post-v1-roadmap.md#10-验收证据与投入判断的范围和分期)拥有分期、复用缺口和工程前置，[工作台 §29](frontend/workbench-design.md#29-验收证据与投入判断)拥有交付证据、计时、复审、复盘与推演交互，[测试计划 §27](testing/verification-plan.md#27-验收证据与投入判断验收规格)维护目标规格，[执行映射](../prompts/README.md#产品补充的执行映射)及[分批实施任务书](../prompts/evidence-and-investment.md)接续用户实际下发后的工作。任务书默认第 1 批 A–D，后两批按授权和前置接续。此处保留 2026-10-11 文档确认时点。2026-10-14 已接基础验收数据链、假设/决定前提复审及工作段复盘，协议见 HTTP 契约 §10.67–73、数据库设计 §75–81；当前阶段和实际成绩仍分别归原主文档，UI 待后续重构，实际收益未验证。

2026-10-11 内置方法与命令导航：[总纲 §0.13](../Personal_Workflow_OS_Master_Spec.md#013-内置工作方法与会话控制)拥有已确认产品范围，[扩展专题第 9 节](architecture/relay-skills.md#9-内置工作方法与可定制-skill)拥有三项新增方法、自然语言选择与 `SKILL.md` 定制版本，[运行架构第 8 节](architecture/runtime-context.md#8-会话压缩与消息文件恢复)拥有 DeepSeek 优先压缩、协议/检查点及文件恢复责任，[工作台第 27 节](frontend/workbench-design.md#27-内置-skill-与聊天命令)拥有 `/命令`、会话控制和消息撤回按钮，[ADR-019](decisions/ADR-019-builtin-methods-and-conversation-checkpoints.md)记录取舍，[后续路线第 9 节](requirements/post-v1-roadmap.md#9-内置工作方法命令与会话恢复的范围)拥有实施前置，[测试计划第 26 节](testing/verification-plan.md#26-内置-skill命令压缩与消息文件恢复验收规格)为未运行规格，[完整实施提示词](../prompts/builtin-methods-and-conversation-checkpoints.md)为用户实际下发后的执行入口。本轮仅文档与提示词，新增能力未实施、未验收，不改变当前阶段和成绩。

2026-10-11 学习模式协议冻结：[ADR-020](decisions/ADR-020-learning-mode-record-protocol.md) 冻结独立 `LEARNING` 会话身份、五张记录表与唯一写入 Owner、同轮有限增量信封、事前冻结的结算基线、清除代次与迟到结果、命令幂等与回执形状、Context 选择规则、逐次调用计量与转执行不升权；[领域模型 §13.4](architecture/domain-model.md#134-工程协议2026-10-11-冻结未实施)与[后续路线 §8](requirements/post-v1-roadmap.md#8-学习模式的范围与实施前置)已接续。协议冻结**不等于**实现或验收；本轮未写产品代码，按[完整实施提示词](../prompts/learning-mode.md)工作包 A→D 推进。

2026-10-10 学习模式导航（2026-10-11 提示词接续）：[总纲 §0.12](../Personal_Workflow_OS_Master_Spec.md#012-学习模式)拥有已确认产品规则，[范围补充](requirements/v1-scope.md#学习模式补充)与[后续路线 §8](requirements/post-v1-roadmap.md#8-学习模式的范围与实施前置)拥有范围和实施前置，[工作台 §26](frontend/workbench-design.md#26-学习模式)拥有教学、状态展示与转执行交互，[领域模型 §13](architecture/domain-model.md#13-学习模式的状态与权限边界)拥有个人记录和权限边界，[测试计划 §25](testing/verification-plan.md#25-学习模式验收规格)为未运行规格；[完整实施提示词](../prompts/learning-mode.md)组织后续工作包、当前源码映射与验证。

2026-10-09 自然语言状态维护接续：[总纲 §0.8.1](../Personal_Workflow_OS_Master_Spec.md#081-自然语言维护项目状态)拥有已确认产品规则，[工作台 §18.9](frontend/workbench-design.md#189-自然语言状态维护与接续摘要)拥有对话变更、接续卡与撤回交互，[应用边界 §12.5](architecture/domain-model.md#125-自然语言状态维护的应用边界)拥有 Owner/确认/基线/核对/恢复约束，[范围补充](requirements/v1-scope.md#自然语言状态维护与自动接续补充)与[后续路线 §7](requirements/post-v1-roadmap.md#7-已确认的未来软件协作能力)拥有范围接续，[测试计划 §24](testing/verification-plan.md#24-自然语言状态维护与自动接续验收规格)为未运行规格，[执行映射](../prompts/README.md#产品补充的执行映射)及[完整实施提示词](../prompts/natural-language-state-maintenance.md)同步后续输入。提示词已交付、尚未执行；本轮仅文档，未启动开发或改变 M/N 阶段及成绩。

2026-10-05 有界协作文档接续：[总纲 §0.9](../Personal_Workflow_OS_Master_Spec.md#09-有界多-agent-与自动会话)拥有已确认产品规则，[范围补充](requirements/v1-scope.md#有界多-agent-与自动会话补充)拥有首版边界，[运行架构 §2.5](architecture/runtime-context.md#25-有界子-agent-的委派与会话关联)拥有委派/预算/来源/恢复，[工作台 §23](frontend/workbench-design.md#23-主子会话与有界协作)拥有交互，[ADR-017](decisions/ADR-017-bounded-multi-agent-conversations.md)记录取舍，[测试计划 §21](testing/verification-plan.md#21-有界多-agent-与自动会话验收规格)拥有未运行场景；[专项提示词](../prompts/bounded-multi-agent.md)为另行获授权后的执行入口。本轮仅文档，工程协议待核定，不启动代码开发。

[功能地图](feature-map/README.md)提供模块 → 功能 → 代码/文档/提示词/测试/验收的资料导航，支持本机实时更新与离线快照。它只维护关系目录，不拥有第二份阶段或验收状态；新增文件自动提示待归类，新增功能的语义由对应开发任务同步登记。

2026-10-03 会话执行计划导航：[产品总纲 §0.7](../Personal_Workflow_OS_Master_Spec.md#07-会话内可折叠执行计划2026-10-03推荐设计)拥有推荐范围，[研究 §1.3](research/p00-source-study.md#13-会话执行计划机制对照2026-10-03)记录官方机制与采用差异，[运行架构 §2.4](architecture/runtime-context.md#24-会话执行计划的归属与持久更新推荐设计)拥有工程归属与恢复，[工作台 §22](frontend/workbench-design.md#22-会话内可折叠执行计划推荐设计)拥有交互，[测试计划 §19](testing/verification-plan.md#19-会话执行计划验收规格)拥有未运行规格；[专项提示词](../prompts/conversation-execution-plan.md)为后续执行入口。本轮只维护文档与提示词。

2026-10-01 文件夹与对话入口导航：用户已确认入口与直接执行的产品规则，本轮只修改文档。详细行为归[工作台 §18](frontend/workbench-design.md#18-文件夹入口与对话直接执行)，应用责任归[领域模型 §12](architecture/domain-model.md#12-文件夹入口与对话执行的应用边界)，取舍归[ADR-016](decisions/ADR-016-folder-first-conversation.md)，未运行场景归[测试计划 §17](testing/verification-plan.md#17-文件夹与对话直接执行验收规格)，后续执行入口为[实施提示词](../prompts/folder-first-conversation.md)。当前阶段和授权只在 CODEX_NEXT_STEP 维护。

2026-10-01 整套 UI 重做导航：[Agent UI 研究审查](research/agent-ui-review-2026-10-01.md)记录本轮一手资料、源码和代表页面问题；[工作台第 17 节](frontend/workbench-design.md#17-整套-ui-重做提案2026-10-01)拥有完整页面/状态覆盖与回归路径；[设计系统第 9 节](frontend/design-system.md#9-整套重做的组件与布局提案2026-10-01)拥有共享组件提案。范围已获用户授权，具体视觉方向待选择，尚未实施；源码缓存更新归 P00，功能状态仍只归统一验收表。

2026-09-29 协作体验改造导航：[工作台第 14 节](frontend/workbench-design.md#14-以目标协作为中心的工作台改造)拥有目标流程、入口与兼容关系；[设计系统第 5.1 节](frontend/design-system.md#51-协作工作区的视觉层级)拥有视觉层级；[验收第 16 节](testing/verification-plan.md#16-agent-协作主线验收提案)拥有场景规格，运行结果统一见[功能验收表](testing/overall-acceptance-2026-09-28.md#当前功能验收表)。第 14 节结构已在 `/agent` 落地（开发自检），**真实 Windows 验收未完成**；Git 只读与交互终端因缺协议显式标为未接入。旧图和逐页清单继续用于风格/能力覆盖，不冻结旧管理导航。

2026-09-28 后续规划导航：[V1 后续路线](requirements/post-v1-roadmap.md)拥有推荐范围、顺序与未决项；[领域模型第 11 节](architecture/domain-model.md#11-v1-后续协作的架构演进提案)维护责任与事务，[ADR-013](decisions/ADR-013-bounded-project-continuation.md)记录 Proposed 取舍，[验收第 14 节](testing/verification-plan.md#14-v1-后续长期协作验收提案)维护未运行规格，[N 工作包](../prompts/post-v1-collaboration.md)提供分包提示词。用户选择长期协作优先，具体方案仍为规划，未启动实现、不扩大 V1 goal。

当前改造导航（2026-09-24，2026-10-04 接续总入口）：[ADR-010](decisions/ADR-010-agent-stack-react-desktop.md)记录技术取舍与用户决定；[技术选型](architecture/技术选型.md)维护目标组合；[CODEX_NEXT_STEP](../CODEX_NEXT_STEP.md)独占当前模块状态；[大模块提示词](../prompts/stack-migration.md)维护工作包；[验收门槛](testing/verification-plan.md#10-技术栈改造的大模块验收)维护出口；[整体开发总提示词](../prompts/goal-stack-migration.md)接续 V1 收尾与 Windows 完整交付，goal 只在用户明确要求时使用；[M01 开发记录](development/m01-stack-baseline.md)保存基线和适配证据。原始 [Agent Stack 附件](../Agent_Stack_Integration.md)作为来源保留，已适配项以 ADR-010 为准，不重复维护第二份技术真相。

角色：当前文档地图与维护规则。更新：2026-09-21。

2026-09-26 产品补充接续导航：[执行映射](../prompts/README.md#产品补充的执行映射)将产品总纲第 0.2/0.4 节接入总提示词、模块、分阶段与[逐页提示词](frontend/page-development-prompts.md#后续产品补充与页面映射)。该映射负责分派入口与范围判定，不替代产品定义或当前进度。

本文定义每类内容的主文档、阅读顺序和变更检查，不复制技术选型、业务状态枚举或项目进度。协作约束见 [AGENTS](../AGENTS.md)，当前阶段、缺口与下一步只在 [CODEX_NEXT_STEP](../CODEX_NEXT_STEP.md)维护。新接手者从这三处进入，不从历史提示词判断当前授权或实现状态。

外部 Agent 共享任务协作（2026-10-23，产品规则已确认、待实现）：[总纲专题](../Personal_Workflow_OS_Master_Spec.md#项目事项与外部-agent-共享任务协作)拥有产品规则，[路线 §15](requirements/post-v1-roadmap.md#15-项目事项与外部-agent-共享任务协作)拥有范围与工程待核定项，[领域模型 §22](architecture/domain-model.md#22-外部-agent-共享任务的应用边界)拥有责任，[ADR-033](decisions/ADR-033-external-agent-shared-tasks.md)记录取舍，[工作台 §46](frontend/workbench-design.md#46-项目事项与外部-agent-共享任务)拥有交互，[测试计划 §43](testing/verification-plan.md#43-外部-agent-共享任务协作的目标验收)为未运行规格。本轮仅文档，不承诺标准 A2A 协议、直接调度、禅道迁移或现有功能已通过。

## 1. 唯一事实源

2026-10-24 提示词覆盖接续：[差异化体验任务书](../prompts/differentiated-project-experience.md)、[外部共享任务任务书](../prompts/external-agent-shared-tasks.md)、[长期团队任务书](../prompts/persistent-project-agent-team.md)及[原 N 工作包的 N08 接续](../prompts/post-v1-collaboration.md#n08-周期定时启动任务接续)已补齐，逐项范围见[提示词覆盖表](../prompts/README.md#2026-10-24-产品设计与提示词覆盖核对)。任务书引用所属主文档，不新增产品事实源，也不表示开发已下发或功能已实现。

2026-09-28 产品决策导航：[锁定与手动影响检查](frontend/workbench-design.md#101-已确认的锁定与影响检查规则)、[人工介入提醒](frontend/workbench-design.md#115-已确认的人工介入提醒规则)记录用户已确认行为及工程待定项；[验收规格](testing/verification-plan.md#13-锁定影响检查与提醒的已确认规则验收)尚未运行，[执行映射](../prompts/README.md#产品补充的执行映射)同步后续分派输入。已确认不等于已实现。

“当前”指现在应读取的设计版本，不代表已批准或已实现。下表每一行只指定一个主入口，详细规则在主入口所链接的所属文档维护。

| 内容 | 主文档 | 边界 |
|---|---|---|
| 产品定义与目标 | [Master Spec](../Personal_Workflow_OS_Master_Spec.md) | 不重复维护技术依赖版本和实时进度 |
| V1 最小范围与阶段覆盖 | [范围矩阵](requirements/v1-scope.md) | 对照产品定义，不以第一切片代表完整 V1 |
| V1 之后的推荐范围与依赖 | [后续路线](requirements/post-v1-roadmap.md) | 唯一后续分期主表，Proposed 不是开发授权；不记录当前模块进度 |
| 当前阶段、阻塞、下一步 | [CODEX_NEXT_STEP](../CODEX_NEXT_STEP.md) | 历史研究日志不另写一份当前进度 |
| 业务不变量 | [契约包](../contracts/README.md) | 01–04 分别拥有事实、执行、验证、恢复；其他文档引用 |
| 当前架构与模块职责 | [领域模型](architecture/domain-model.md) | 架构主入口；运行/信息/工具专题补充实现边界 |
| 内置浏览器自动化（F26） | [浏览器自动化 V1](architecture/browser-automation-v1.md) | 拥有选型/能力族/页面所有权/打包/测试口径；不改 `COMPUTER_*` 与执行路由器 |
| 电脑操控（Computer Plugin V1/V2） | [电脑插件 V1](architecture/computer-plugin-v1.md)、[V2 迁移审查](architecture/computer-plugin-v2-migration-audit.md) | 拥有 Windows 桌面运行时、IPC 协议、`computer_*` 工具词表与 `COMPUTER_READ`/`COMPUTER_INPUT` 边界；不拥有会话、Run 生命周期与执行路由 |
| 产品 Agent 提示词与输入协议设计 | [Agent 提示词设计](architecture/agent-prompt-design.md)、[当前运行时路由](architecture/agent-prompt-design.md#21-当前运行时提示词路由)、[运行公共核心](../apps/api/src/workflow/agent-system-prompt.ts)、[统一路由入口](../apps/api/src/workflow/prompts/index.ts) | 路由表记录触发条件、组合、版本与源码入口，不被运行程序加载；模板正文由源码唯一维护，目标剩余增量与已实现入口分开；编码任务入口仍为根目录 prompts |

2026-10-11 运行时提示词路由已落成代码入口：[集中描述但无代码入口]的表述已失效，当前选择由 `apps/api/src/workflow/prompts/` 的统一入口完成（`route-types.ts` 登记表 + `index.ts` 选择入口 + 三个按职责分组的模板模块），原 application 与模型端口调用只保留单一来源的兼容再导出。路由事实仍只维护在[提示词设计 §2.1–2.3](architecture/agent-prompt-design.md#21-当前运行时提示词路由)，本页不复制第二份路由表；实施范围与未闭合项归[CODEX_NEXT_STEP](../CODEX_NEXT_STEP.md)。
| 共享知识来源与长期信息 | [信息与计划](architecture/information-planning.md#11-人和-ai-共用知识来源) | 人与 AI 同源的版本、原件及收录边界；阅读交互归工作台第 12 节，产品定义归 Master Spec 第 33/90 节 |
| 扩展组合、Skill 与蓝图协议 | [Relay 扩展模型](architecture/relay-skills.md) | Pack/Profile/Recipe/Proposal 复用既有模块；原整体设计仍 Proposed，第 9 节产品范围已确认，新增实现待做；API/存储字段和 Eval 规格各归所属文档 |
| 主栈、可选依赖与冻结门槛 | [技术选型](architecture/技术选型.md) | 不在 README、提示词或 UI 文档复制版本表 |
| 决策理由与替代关系 | [ADR 入口](#3-决策与历史) | 保存为什么；不代替当前实现证据 |
| 逻辑数据关系 | [逻辑模型](database/logical-model.md) | 物理类型/索引/锁协议见其对应物理设计 |
| 数据库物理约束 | [物理设计](database/physical-design-postgresql.md) | DDL 片段不是已执行 migration；未来以实际 migration 核验 |
| API 命令与错误 | [HTTP 契约](api/http-command-contract.md) | 模块补充见 [module-api](api/module-api.md)，同一字段只在所属接口定义 |
| 页面结构与业务交互 | [工作台交互](frontend/workbench-design.md) | 路由、命令、状态与权限，不拥有 token 色值 |
| 页面效果图与开发输入 | [方案 2 执行提示词](../prompts/ui-option-2-pages.md)、[本轮效果图](frontend/mockups/2026-10-02/README.md)、[逐页历史输入](frontend/page-development-prompts.md) | 本轮选定聊天图与37张页面/状态图；原批次与知识库补图由逐页入口链接保留。图片和提示词不代表实现、验收或新增路由 |
| UI 视觉、组件与适配 | [设计系统](frontend/design-system.md) | 基于现有图；组件外观与可访问性交互，不重定义业务状态 |
| UI 数值与语义别名 | [design-tokens.json](frontend/design-tokens.json) | 数值唯一来源；图片、提示词和 Markdown 不另维护可冲突数值表 |
| 前端预览实现与验收 | [前端预览记录](development/前端预览实施与验收.md) | 按批次记录已实现交互、自测证据与待验证项；不是桌面验收 |
| 功能验收结果 | [功能验收表](testing/overall-acceptance-2026-09-28.md#当前功能验收表) | 唯一功能状态汇总；记录范围、环境、结论与剩余项，历史成绩不自动覆盖新改动 |
| 验收规格与分层证据要求 | [测试计划](testing/verification-plan.md) | 规格不是结果；研究结果引用原记录 |
| 前后端独立验收证据 | [2026-09-21 验收](testing/frontend-backend-acceptance-2026-09-21.md) | 当前已实现范围的复跑、补充反例与问题；不替代阶段主文档 |
| 独立修复与调整任务 | [验收修复提示词](../prompts/remediation/README.md) | 与原开发提示词分开；以各 R 记录的执行与证据边界为准 |
| 部署、身份与运维 | [本机部署](deployment/本机部署.md) | 当前为设计；实际启动命令在有工程后写根 README |
| 本机禅道登记与接入 | [禅道接入](deployment/禅道接入.md)、[导入映射清单](deployment/zentao-import-2026-10-22.json) | 第三方本机工具，不属于产品部署拓扑；清单只描述 2026-10-22 那次单向导入，不代表双侧同步 |
| 维护/备份边界与协议故障根因 | [M07 开发记录](development/m07-backup-recovery.md) | 保存 Owner、重要取舍及可复现故障；实际成绩和模块状态仍归上述唯一入口 |
| 研究证据 | [P00 研究记录](research/p00-source-study.md) | 固定来源、运行结果、限制；不替代生产能力证明 |
| 开发/文档变更的原因 | [设计交付审计](development/design-audit.md) | 按时间追加记录，不承担最新状态表 |
| 25–27 日产品补充实施证据 | [25 日恢复与成果](development/product-supplement-2026-09-25.md)、[26 日人工待处理与验收](development/product-supplement-2026-09-26.md)、[27 日知识阅读与收录](development/product-supplement-2026-09-27.md) | 条目映射、实际代码、自检与协调复核边界；当前进度仍归 CODEX_NEXT_STEP |
| 实施任务入口 | [prompts](../prompts/README.md) | 引用主文档；提示词只能在当前用户授权范围内执行 |

代码描述实际实现；契约描述目标约束；ADR 描述取舍；测试结果描述已证实范围。冲突时核对这四类证据，不能用“谁更新得晚”自动裁决，也不能因历史图里有某项功能就扩大范围。

## 2. 文档角色、状态与来源

关键当前文档在开头说明角色/范围、状态、更新日期及主依据。已有日期/状态块可直接补充，不要求统一 front matter，也不为格式重写所有历史记录。

| 维度 | 用法 |
|---|---|
| 文档角色 | 当前主文档、专题补充、历史材料、证据记录、生成来源；决定如何阅读，不表达实现程度 |
| Proposed / Draft | 推荐或待讨论，不是默认批准；明确未决条件和验证出口 |
| Accepted | 有明确接受依据的决策；只在注明范围生效，不代表代码完成 |
| Superseded / Deprecated | 链接接续文档并保留历史，不删除取舍依据 |
| 实现/验证状态 | 单独写未实现、已实现待验收、实际证据及限制；不把 Passed 当文档审批状态 |

实现建议、图像采样值、推断和待确认信息必须标明来源性质。资料来源是图片时，不把观察到的像素或生成内容当成 CSS 真值、真实业务数据、源码或测试证据。

日期标记更新发生时间，不自动作状态优先级。历史环境信息写明当时检查，不持续用“当前可用”描述旧检查结果。具体路径优先使用仓库相对链接；仅启动配置和工作区定位需要绝对路径。

## 3. 决策与历史

当前决策集合：[ADR-001](decisions/ADR-001-domain-boundaries.md)、[ADR-004](decisions/ADR-004-user-import-origin.md)、[ADR-005](decisions/ADR-005-reuse-first.md)、[ADR-006](decisions/ADR-006-typescript-first.md)、[ADR-007](decisions/ADR-007-windows-desktop.md)、[ADR-008](decisions/ADR-008-declarative-skills.md)、[ADR-009](decisions/ADR-009-rule-revision-fence.md)、[ADR-010](decisions/ADR-010-agent-stack-react-desktop.md)、[ADR-011](decisions/ADR-011-project-archive-serialization.md)、[ADR-012](decisions/ADR-012-windows-file-io-handle-boundary.md)、[ADR-014](decisions/ADR-014-database-maintenance-admission.md)、[ADR-015](decisions/ADR-015-managed-content-native-publication.md)。分别以各文件状态为准；此列表不统一批准它们。[ADR-002](decisions/ADR-002-postgresql-jdbc.md)保留早期持久化技术提案，[ADR-003](decisions/ADR-003-browser-workbench.md)保留已被 Windows 桌面要求替代的浏览器提案；ADR-013 的 Proposed 后续协作范围见上方专用导航。

2026-09-20 新增 [ADR-008](decisions/ADR-008-declarative-skills.md)：声明式 Skill 与蓝图应用，技术方案状态 Proposed；同日用户确认纳入评审后的首批闭环方向，目录统一见 Skill 专题。V1.5 AI Schema 生成的范围前移仍待确认，详见范围矩阵。

| 历史材料 | 保留目的 | 当前替代入口 |
|---|---|---|
| [原始架构评审](../architecture-review.md) | 问题与取舍来源 | 契约包、领域模型 |
| [早期 V1 架构稿](architecture/V1_ARCHITECTURE.md) | 早期模块和状态语义 | 领域模型及主题设计；不再向旧稿正文同步新栈 |
| [初始设计任务](development/archive/2026-09-18-initial-design-task.md) | 当时的任务范围和停止条件 | CODEX_NEXT_STEP、当前用户指令 |
| [task_plan](../task_plan.md)、[progress](../progress.md)、[findings](../findings.md) | P00 研究过程快照 | 当前进度只看 CODEX_NEXT_STEP，实验事实看 P00 研究记录 |
| [图像生成提示词](frontend/mockups/2026-09-19/prompts.md) | 生成依据与示例文案来源 | 交互规范、设计系统和 tokens |

历史材料不追加当期实现指令；只有必要的角色标记、勘误与接续链接。旧记录中的路径、日期和测试数字按当时范围保留。

## 4. 变更规则与验收

变更先定位主文档，再修改其事实和理由；入口只更新链接或必要摘要。不要靠复制整段设计在多处“同步”。架构取舍改变时更新对应专题和 ADR；技术版本改变时更新选型/锁文件；UI 数值改变时改 token，交互改变时改工作台文档。

**产品讨论留痕（2026-10-16 用户要求）。** 产品讨论形成方案、范围选择或行为变更时，将背景、用户已确认选择、推荐默认、待确认项、取舍与验收条件更新到该功能的既有主文档，不只留在聊天或开发提示词中。用户仅选择某个选项，不代表其余工程细节全部获确认；明确区分「已确认／推荐／待确认／已实现／已验收」。开发提示词引用方案并给出对应验收项；后续实现如需偏离，先列出差异、理由和影响，按既有授权处理，不能先改代码再静默改方案来追认。仅编制方案与提示词不启动开发。当前示例：[会话 diff 方案](frontend/workbench-design.md#34-会话局部与总-diff)。

产品设定或验收要求发生变化时，同时检查执行入口：`prompts/README.md` 的映射与接续块、goal 总提示词、M 模块与交接模板、受影响 P 阶段和逐页提示词。入口给出主文档引用、本次责任、范围判定与证据要求；只增加链接而不更新冲突的执行指令不算同步完成。仍为 Proposed 的内容保留待定项，已授权工作不因未选定探索项一律停止；历史提示词及修复/验收证据只保留接续导航，不改写历史范围或成绩。

结束前执行 Documentation Impact Check：需求、架构、ADR、API、数据库、开发记录、测试、README、路线图、变更记录、已知问题。仅更新受影响项；目前不为清单齐全创建空的 ROADMAP/CHANGELOG/KNOWN_ISSUES。阶段缺口放当前状态，改动经过放既有审计，实验限制放研究记录。

当前文档验收至少包括：唯一主入口、明确状态、历史不冒充当前、相对链接可达、没有新重复数值源；UI 还需 token 引用和对比度检查。语义一致性仍需人工核对，脚本不能证明产品契约已经实现。

## 5. 轻量检查

仓库根目录运行：

```sh
node scripts/check-docs.mjs
```

使用 Node 内置模块，无依赖安装；这是文档工具，不是生产 Node 版本兼容证明。检查主要入口和 docs/contracts/prompts 中的本地 Markdown 链接与标题锚点，以及 token JSON 的别名、类型和指定对比度组合。不会访问网络、读取凭据、运行实验或修改文件。

非零退出时修复错误再交付。远程页面有效性、文案事实、像素还原、实际 CSS 对比度、键盘/辅助技术行为和技术兼容性不在此脚本证明范围。未来确有工程后再把 OpenAPI/migration/token 消费者的对应检查接入工程，不提前建立通用文档平台。

## 6. 验收结果与原始输出保留

2026-09-30 按用户要求收敛验收记录。日常读取顺序为：简短的 [CODEX_NEXT_STEP](../CODEX_NEXT_STEP.md) → [功能验收表](testing/overall-acceptance-2026-09-28.md#当前功能验收表) → 本次任务相关规格/代码。仅在结果冲突或定位故障时读取对应历史小节、日志片段；不要默认扫描整个 evidence 目录、粘贴全量输出或遍历全部源码 hash。Git 文件本身不消耗模型 token，被读入上下文才消耗。

- 功能状态只维护在已有整体验收记录顶部的表格，写功能、通过/未通过/未验收、环境与范围、依据和剩余项。CODEX_NEXT_STEP 只维护阶段、模块与下一步；测试计划拥有规格，不重复维护当前成绩。
- AGENTS、测试计划和所有工作包中的“验收证据”“核验记录”“逐次结果”统一按本节解释：默认是验收表中的简短结果；“保留历史”是保留既有依据，不是每轮复制日志或新建报告。只有重要故障、发布身份或明确的专项评价需要额外材料时，才保留最小必要片段、指标或归档；产品自身的产物、运行账本、审计和恢复凭据不受此文档规则影响。
- 每次验证只追加必要的一行结果：确切命令/退出码、commit 或受影响文件基准、结果与未覆盖项、临时资源清理结果。不为普通复跑新建报告，不用完整文件 hash 清单代替受验版本说明；关键发布包身份和必要故障断点仍保留。
- 完整 stdout/stderr、重复全量日志、逐进程 JSONL、批量源码 hash、构建清单副本及整批页面快照默认输出到忽略的 `output/acceptance-raw/<本次任务>/`；已有 evidence 路径中的同类文件也默认忽略。真实发布清单仍由原构建入口维护，此规则只收敛 testing/evidence 中的过程副本。不对所有过程日志执行 `git add -f`。2026-10-16 按该约定把 `output/acceptance-raw/` 根上 2026-09-28 至 10-01 的 260 个散文件归入 `<模块>-<日期>/` 子目录，被文档或代码按文件名引用的保留原位；同轮把 `output/` 根 9 个未被引用的过程件移入该目录，停止版本保留但本机副本仍在。
- Git 保留自动化测试代码、必要复跑脚本、简短结果 JSON、重要反例摘要和必要截图。难以复现的故障若确需原始输出，先脱敏，再选择关键片段或压缩归档，并从验收表/根因记录链接，不重复存多轮成功输出。
- 本次已跟踪且未修改的历史原始输出集中到[压缩归档](testing/evidence/raw-output-20260930.zip)，另包含最新记录的本机日志和批量清单副本。归档内路径相对仓库根，`_archive-index.json` 保存条目 SHA-256；文档链接的 `#entry=...` 标出原始条目。原文件移至忽略的 `output/acceptance-raw/history-20260930/`，保留相同的仓库相对目录，按需可从本机副本或 ZIP 复查。Git 删除项随后续提交停止原始条目的版本保留；已修改文件不纳入本次整理。历史引用和失败结论保留，不删除测试或改写 Git 历史。
- 长篇阶段经过已移至[历史快照](development/codex-next-step-history-20260930.md)，不会作为日常交接默认输入。归档及旧成绩只证明原运行时点；新源码、真实 Provider、Windows 和安装验收各自需要匹配范围的证据。
