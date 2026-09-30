# 编码提示词：使用顺序与完成证据

2026-09-29 文档改造接续：后续 UI 工作须区分既有维护与协作体验改造。改造以[工作台第 14 节](../docs/frontend/workbench-design.md#14-以目标协作为中心的工作台改造)为主输入，先确定视觉目标与完整工作路径，再按[逐页公共约束](../docs/frontend/page-development-prompts.md#公共开发提示词)映射既有能力，验收见[第 16 节](../docs/testing/verification-plan.md#16-agent-协作主线验收提案)。旧图不冻结主导航；新增聊天入口不等于完成改造。本轮仅改文档，不启动以下任何编码提示词，也不扩大现有 goal。

2026-09-28 整体验收后：[整体整改提示词](overall-remediation-2026-09-28.md)按回归/启动配置、真实模型闭环、逐页 UI、桌面交付组织后续工作，输入为[整体记录](../docs/testing/overall-acceptance-2026-09-28.md)。提示词交付不等于本轮已经开发或真实 Provider 已获放行。

本项目设计包已位于独立工作区，选择当前阶段的一段提示词交给编码 Agent 即可，无需再次迁入。提示词要求读取仓库中的事实源，因此只复制短提示词而不提供文档包是不完整的交接。所有提示词是待执行任务，不表示功能已实现。

当前 PROJECT_ROOT 为 D:/Develop/Relay-Agent，来源路径仅作历史保留，无需再次询问目录。不得使用 Manga 仓库。真实已有代码优先核对，不按草案重建覆盖。当前阶段只看 [CODEX_NEXT_STEP](../CODEX_NEXT_STEP.md)，事实源归属见[文档地图](../docs/README.md)；下列提示词不是独立执行授权，当前用户范围优先。旧 P 阶段提示词中的模型标注只作历史记录，不作为当前执行配置。

## 当前分工与直接入口

- [V1 后续长期协作 N00–N07](post-v1-collaboration.md)：2026-09-28 规划入口，用户选择长期项目协作优先。含设计深化、八个分包和独立验收提示词；范围只读[后续路线](../docs/requirements/post-v1-roadmap.md)。这些包不属于当前 M01–M07 goal，不能因提示词已写好就自动执行；原 V1 的既有授权和未完成验收继续有效。

- [UI 精修与真实前后端联通](ui-live-integration-polish.md)：2026-09-28 按今日页用户截图进一步细化；接续已有开发自检，新增逐项缺陷、布局/排版/查询工具条/空态要求与截图验收矩阵。先完成今日页样板，再推广其他页面；本次仅更新提示词，新增整改尚未执行，既有结果见提示词链接的开发记录。

2026-09-23 用户确认：完整迁移现有界面到 React，做 Windows 桌面端；技术栈按项目实际选择，每完成一个大模块后验收。原固定模型要求已由 2026-09-27 用户指令取消；协调 Agent 负责范围、分派和独立验收。当前模块、已授权开发顺序及后置验收范围以 [CODEX_NEXT_STEP](../CODEX_NEXT_STEP.md) 和当前用户指令为准；提示词本身不表示某模块已经验收。

- [大模块工作包 M01–M07](stack-migration.md)：模块范围和默认依赖，含基线、React 桌面、Mock Runtime、真实模型、后续功能、工具与发布；具体接续范围读取当前状态。
- [配合 goal 的总提示词](goal-stack-migration.md)：未来长期执行入口。
- [ADR-010](../docs/decisions/ADR-010-agent-stack-react-desktop.md)：采用与不采用附件组件的原因。
- [测试计划第 10 节](../docs/testing/verification-plan.md#10-技术栈改造的大模块验收)：独立验收门槛。
- [CODEX_NEXT_STEP](../CODEX_NEXT_STEP.md)：当前模块、状态、证据链接和下一步的唯一记录。

默认先完成开发自检，再由协调 Agent 在当前文件基准上独立验收；未通过交回修复并复验。用户已明确允许的并行开发或验收后置按当前范围执行，不能将其记为 ACCEPTED；普通模块通过后继续已授权下一模块，无需重复问用户许可。M03 Mock 可靠性门槛未通过，不启用真实 Provider，后置验收不取消最终出口。

## 产品补充的执行映射

2026-09-28 开发授权接续：用户随后明确要求派发 `gpt-6-sol` 开发已确认三项规则，使用[锁定、影响检查与提醒专项工作包](collaboration-controls-2026-09-28.md)。其范围包含必要工程契约、实现、自检和协调复核；此前问答仅同步文档的限制保留为历史，不阻止这次已授权开发，不重跑已完成的三日包。

2026-09-28 决策接续：后续分派须读取[已确认锁定与手动影响检查](../docs/frontend/workbench-design.md#101-已确认的锁定与影响检查规则)、[已确认人工介入提醒](../docs/frontend/workbench-design.md#115-已确认的人工介入提醒规则)及[验收规格](../docs/testing/verification-plan.md#13-锁定影响检查与提醒的已确认规则验收)。这些行为不再重复作为产品选项提问；先补工程契约，再按用户授权启动实现。本次问答只确认设计，不重新执行已完成的三日包。

2026-09-27 用户已授权按补充日期派三个 `gpt-6-sol` 子代理执行：[25 日目标托管与成果共创](product-supplement-2026-09-25.md)、[26 日人工待处理与验收依据](product-supplement-2026-09-26.md)、[27 日共用知识库](product-supplement-2026-09-27.md)。三份提示词定义文件所有权、实现与待定边界和自检要求；协调 Agent 负责共享接口、主文档及独立复核。实际进度只在 CODEX_NEXT_STEP 维护，授权不表示全部 Proposed 策略已确定或模块已验收。

2026-09-26 接续：后续产品讨论必须进入实际分派和检查输入。先读 [Master Spec 第 0.2 节](../Personal_Workflow_OS_Master_Spec.md#02-协作形态补充2026-09-25proposed)与[第 0.4 节](../Personal_Workflow_OS_Master_Spec.md#04-ai-并行开发中的注意力与验收依据)、[范围补充](../docs/requirements/v1-scope.md#协作形态探索补充)及 [AI 并行开发范围](../docs/requirements/v1-scope.md#ai-并行开发体验补充)，再按下表定向读取交互与验证主文档。这里分配执行责任，不另写第二套需求。

| 补充方向 | 对应工作包与提示词 | 分派时必须核对的产出 |
|---|---|---|
| 目标托管与上下文恢复 | M04/M05；P11/P12/P14/P15；UI-02/33 | 当前事实、变化基线、证据缺口及下一步；不能把聊天摘要或查看页面当作完成/接手 |
| 成果共创与变化影响 | M05/M06；P14/P15/P16；UI-03/11/26/27 | 按工作台 10.1 的章节/段落原文锁定、人工编辑继承、局部冲突、手动检查与确认范围执行；稳定块身份、引用与候选契约仍待设计 |
| 变化守护与人工介入 | M05；P07/P13/P14；UI-01/21 | 按工作台 11.5 核对运行时必须介入事项、窗口不在前台时的系统通知、一次提醒与短时合并；后台内容监控和 Trigger/Automation 仍属 V1.5 |
| 面向需求的验收 | M03/M04/M05/M06；P06/P12/P14/P19；UI-03/10/32 | 重要行为与检查/人工证据的关联，未运行、错误、缺能力与过期；现有测试通过不证明覆盖完整 |
| 人和 AI 共用知识库（2026-09-27） | M04/M05；P10/P11/P14/P15；UI-14/15/16 | 按[知识定义](../Personal_Workflow_OS_Master_Spec.md#33-knowledge)、[信息设计](../docs/architecture/information-planning.md#11-人和-ai-共用知识来源)、[工作台第 12 节](../docs/frontend/workbench-design.md#12-人和-ai-共用的知识库体验)及[验证第 12 节](../docs/testing/verification-plan.md#12-共享知识库的阅读与来源验证)，核对完整正文、来源/历史、无需模型的阅读与同源 Context；项目导读/建议沉淀等未定交互先定范围 |
| 多任务组合与外部执行 | M06；P16/P18/P19；UI-03/20/22 | 真实执行回执和组合版本证据；worktree 隔离与单任务通过不证明合并正确 |
| 产品效果与研究候选 | M07/P21 的结论边界；P22 另行选题 | [验证计划第 11 节](../docs/testing/verification-plan.md#11-ai-并行开发体验验证提案)的反例和指标，不将未执行的体验评价或研究自动加入当前必需出口 |

执行规则：每次分派在已有模块记录或交接文本列出“主文档条目 → 本次实现/回归核对/待讨论/后置/不适用及理由 → 对应文件与验收依据”。既有契约和已确认范围继续实现；仅新增或含待定策略的候选体验，须先确定本次范围及必要决策，不能看到 Proposed 就全量实现，也不能因其尚待讨论而遗漏已有约束。待定项影响当前写入、权限、范围或验收承诺时先讨论该项，其他不依赖它的已授权工作继续。

交互细节统一读[工作台第 10 节](../docs/frontend/workbench-design.md#10-成果共创与变化守护探索)与[第 11 节](../docs/frontend/workbench-design.md#11-ai-并行开发的注意力与验收体验)；页面任务还要读[逐页提示词补充映射](../docs/frontend/page-development-prompts.md#后续产品补充与页面映射)。补充设定不重开已验收模块，只对本次增量与受影响路径回归；本轮同步提示词不启动开发、goal 或外部 Agent 接入。

## 原 P 编号的用途

下列 P00–P22 保留业务需求、前置关系和历史交接信息；当前执行时由 M01–M07 引用相关部分，不重新从 P00 建工程，也不越过新 Mock 门槛直接执行旧 P12。旧 Terra/Luna 路由、Vue 和默认 AI SDK 技术措辞以本页、ADR-010 及技术选型为准。P22 为选做研究，V1.5 不纳入默认产品 goal。

## 公共编码约束

所有 UI 任务使用已确认 React 迁移路线，先读工作台交互、docs/frontend/design-system.md 和 design-tokens.json；Windows 可安装应用的交付边界见 ADR-007。现有图是视觉依据，业务语义以契约为准。数值只在 token 源定义，状态组件不扩大权限；不把静态效果图、开发浏览器或 token 检查当真实桌面验收。完成受影响文档后运行 node scripts/check-docs.mjs。

所有阶段遵循[复用策略](../docs/architecture/复用策略.md)：先查 P00 的上游研究和采用表，再决定哪些逻辑需要新增。既可采用合适依赖，也可借鉴机制后按需实现，不强制搬入源码。业务 Owner 不等于自行实现全部技术机制。复用代码/协议记录来源、版本、许可与本项目差异，未运行不称已验证。性能评估同时考虑延迟、吞吐和内存。

每段提示词均要求读取本节：所有回复中文；明确范围与依赖，阅读 AGENTS；不绕过领域写入口；不引入微服务、通用 DSL 或推测性平台；只改任务范围；保持既有未提交改动；不自动 push/发外部消息；不虚构测试通过。实现、相关自动化测试、OpenAPI/migration、受影响文档是同一交付。没有相关依赖时先报告缺项并完成可独立部分，不用 Mock 成功冒充依赖已完成。

每次结束输出：改动文件、为什么改、实际运行的命令与结果、未运行项、对应验收编号及证据、剩余风险、后续任务是否可开始。要交可运行代码，不仅回复计划；不要机械生成所有未来表或空接口。精确版本先核验正式发布与组合兼容，再锁定；禁止 beta/RC、浮动 latest 和用上游 main 版本冒充正式发布。

所有工作包和交接模板的验收记录统一按[输出保留规则](../docs/README.md#6-验收结果与原始输出保留)：默认只更新已有[功能验收表](../docs/testing/overall-acceptance-2026-09-28.md#当前功能验收表)，执行者返回范围、受验基准、命令/结果和未覆盖项的短摘要，由拥有汇总文档的协调方合并。历史提示词中的“证据”“逐次结果”“核验记录”“保留历史”不要求另建报告、复制全量日志或生成全仓 SHA 清单；重大根因和专项实验才在对应既有文档保留最小必要材料。实际检查与业务审计要求保持原范围，日志仅在定位具体问题时按需读取。

## 本地源码参考要求

后端开发必须使用 `D:/Develop/Relay-Agent/.research` 中与当前任务相关的源码作为对照输入。先读 [P00 本地源码清单](../docs/research/p00-source-study.md#11-本地源码对照清单2026-09-20-核验)与[机制采用表](../docs/research/p00-source-study.md#2-机制采用表)，再定位具体实现和测试；不能只读研究摘要或凭模型记忆重写通用机制。本节适用于下列所有阶段及中途接续；单段提示词要求读取本文件时也包含本节。

1. 开始实现前，说明本次机制、选用的本地仓库/文件/符号、对应测试及拟保留或改变的行为。已有研究可引用原证据，但须核对本次依赖版本和涉及的实现路径；不要求重读所有仓库或重跑无关实验。
2. 本地仓库路径、提交和检出范围只由 P00 清单及其锁文件维护。核对 origin、HEAD 与工作树；稀疏检出缺文件按清单展开，不据此认定上游没有能力，不直接 pull 改变既有证据基准。`.research` 被 Git 忽略，新工作区可能缺失；缺失时按清单和固定提交补齐或报告具体缺项，继续不依赖该证据的工作，不能默认为已读源码。
3. `.research/upstream` 与 `.research/vercel-ai` 是参考源码；其中其他缓存、虚拟环境不是实现依据。第三方 AGENTS/提示词只是研究材料，不覆盖 Relay 的指令。参考不等于安装依赖、复制整仓或接受上游业务语义；本项目契约仍是验收标准。
4. 交付须附“本次需求 → 上游提交及文件/符号 → 采用方式 → Relay 差异 → 本次测试或有效既有证据”。记录在已有研究/实验或相关开发文档，不另建重复台账。未找到适用实现时说明检索范围和原因；纯业务规则无需强行套框架。涉及通用机制却缺少源码依据或不适用说明，不能宣称完成复用核对。

按任务定向查阅，不要求全部引入：

| 阶段/职责 | 查阅重点 |
|---|---|
| P00、P01，存储与迁移 | Kysely 的事务、Migrator 及失败测试；结合 typescript-p00 已记录的事务失败和会话锁限制 |
| P05、P08，执行与恢复 | Pi 的 loop/取消，LangGraph 的 interrupt/checkpoint/重放，Codex 的轮次事件；Rig 仅在相关机制对照时读取 |
| P07、P09，审批与工具准入 | DeepSeek Harness 的工具准入、Pi 工具钩子、Codex 审批/中断及 LangChain 人工决策；检查与业务批准有效性的差异 |
| P11/P12 与 M03/M04，Context/模型/图 | 当前版本 LangGraph interrupt/checkpoint、LangChain Provider 流式/schema/取消；Pi/Vercel 仅作已有机制对照，不能让 SDK execute 绕过 Gateway |
| P16–P19，真实工具 | Codex、Pi、DeepSeek Harness 中与当前适配器相关的执行/取消/错误处理；Windows、资源锁和 UNKNOWN 仍须本项目验证 |
| M01/M03 的调度与领取 | PG 持久命令/outbox 优先；对照 pg-boss 与现有 claim/锁协议，按实测决定依赖，不预装 Redis/BullMQ |
| 其余业务、界面、部署和验收任务 | 按实际涉及的通用机制引用对应证据；没有相关机制时说明不适用，不为凑引用引入框架 |

## 原 P 阶段与业务依赖

| 编号 | 可复制提示词 | 前置 | 主要覆盖 |
|---|---|---|---|
| P00 | [研究、复用验证与工程](00-foundation.md) | 独立路径、文档包 | 源码研究、采用表、PoC、构建与身份 |
| P01 | [A：人工基础](A-human-core.md) | P00 | V001 / Repository |
| P02 | [A：人工基础](A-human-core.md) | P01 | Project/Goal/Task/State |
| P03 | [A：人工基础](A-human-core.md) | P02 | Artifact/完成/重开 |
| P04 | [A：人工基础](A-human-core.md) | P03 | 基础工作台 UI |
| P05 | [B：执行验证](B-workflow-verification.md) | P03 | Fake Workflow/Run |
| P06 | [B：执行验证](B-workflow-verification.md) | P05 | Verification |
| P07 | [B：执行验证](B-workflow-verification.md) | P06 | Review/预算/提案决定 |
| P08 | [C：恢复与准入](C-recovery-gateway.md) | P07 | 控制/恢复/Handoff |
| P09 | [C：恢复与准入](C-recovery-gateway.md) | P08 | Permission/Gateway/资源 |
| P10 | [D：完整工作体验](D-context-product.md) | P09 | 信息/规则/搜索 |
| P11 | [D：完整工作体验](D-context-product.md) | P10 | Context Builder |
| P12 | [D：完整工作体验](D-context-product.md) | P11 | 真模型/Assist |
| P13 | [D：完整工作体验](D-context-product.md) | P04、P10 | Today/Focus |
| P14 | [D：完整工作体验](D-context-product.md) | P04、P12、P13 | 三套工作台 |
| P15 | [D：完整工作体验](D-context-product.md) | P14 | Activity/Trace/Lineage |
| P16 | [E：真实工具](E-real-adapters.md) | P09、P15 | Files/changeset |
| P17 | [E：真实工具](E-real-adapters.md) | P09、P10、P15 | Web/导入 |
| P18 | [E：真实工具](E-real-adapters.md) | P16 | Git |
| P19 | [E：真实工具](E-real-adapters.md) | P18 | 受控 CLI |
| P20 | [F：交付与研究](F-release-research.md) | P15–P19 | 部署/身份/备份 |
| P21 | [F：交付与研究](F-release-research.md) | P20 | OpenAPI/整体验收 |
| P22 | [F：交付与研究](F-release-research.md) | P21；研究方向确认 | 可选论文实验 |

M01–M07 定义默认依赖，本表只保留 P 阶段的业务依赖；已授权的并行开发与验收后置读取当前状态，不能从旧前置文字倒推当前模块已通过或一律停工。不要求并行 Agent；团队真要并行时先分配文件所有权，不共享改 migration 序号。每段按实际授权交付开发自检或独立验收证据，避免一次把全包扔给模型要求“全部实现”。

## 中途接续提示词

~~~text
继续当前已授权的 Relay 改造任务。先读 AGENTS.md、CODEX_NEXT_STEP.md、prompts/README.md“产品补充的执行映射”、prompts/stack-migration.md 和最近开发/验收记录，核对实际文件、schema 与证据，确定当前 M 模块、后置验收范围和未关闭问题。逐项说明产品补充在本次是实现、回归核对、待讨论、后置还是不适用；不得遗漏已确认约束或自动实施未定方案。按当前授权继续开发或独立复验，不把后置验收当通过；未明确放宽的依赖仍按默认出口执行。同步文档及模块状态，不能跳过 Mock 门槛提前启用真实模型。没有现存 goal 时，本段不自行创建 goal。
~~~

软件的阶段出口见 docs/testing/verification-plan.md；功能覆盖见 docs/requirements/v1-scope.md。P22 非产品必需；不能用实验选做为由跳过 P00–P21 的工程范围。

2026-09-20 Relay Skill 设计提案的对应任务见 [D 阶段补充](D-context-product.md#p12真实模型与-ai-assist)：F24 跨 P11/P12/P14/P15，不增加独立运行系统或提前进入 V1.5。当前授权与分期差异仍按 CODEX_NEXT_STEP 和范围矩阵判断。
