# 工作台交互规范：分册 15

角色：所属专题的唯一正文分册；2026-10-25 按原章节迁移，不改变原业务规则、日期、状态与证据范围。

[返回专题路由](../workbench-design.md) · [文档总入口](../../README.md)

按需读取本分册内的相关小节；跨章节约束沿链接核对，不能把本分册或历史措辞单独当作完整实现/验收结论。正文中的源码与命令路径沿用原有口径。

## 52. 界面术语约定：目标、项目与工作对象（2026-10-21 裁定，2026-10-25 补实施）

**背景与裁定。** 2026-10-21 用户就项目页提问「这个项目是不是换成目标更好」。核对[总纲 §4 Goal](../../requirements/product-spec/part-02.md#4-goal)、[§5 Project](../../requirements/product-spec/part-02.md#5-project)、[§4.3](../../requirements/product-spec/part-02.md#43-ui)与[契约 01 §5](../../../contracts/01-facts-and-ownership.md#5-projectgoal-与-inbox)后裁定：**一级导航与页名继续用「项目」；「目标」一词收归给 Goal 实体，其余泛指改用「工作对象」「目标版本」「计划候选」。**

裁定理由三条：(1) Goal 是结果、Project 是拥有目标与生命周期的一组持续工作，两者多对多且 Goal 可脱离 Project 存在；`/projects` 列的是 Project（阶段、下一步、类型、归档），改名后名称与内容不符。(2) 该页已有「记录目标」入口指向 Goal 实体，改名会让同一屏内一个词指两个对象。(3) 总纲 §4.3 已定 V1 不设 Goal 一级导航页面；要改是改产品定义，须另立 ADR，不是改文案。

**术语表（界面唯一口径）**

| 词 | 只指 | 出现位置 |
|---|---|---|
| 目标 | Goal 实体 | 「记录目标」入口、Goal 创建/关联页、活动类型「创建目标/关联目标」、会话顶栏「关联目标」、待处理列表「目标：」 |
| 项目 | Project | 一级导航、页头、卡片、面包屑 |
| 任务 | Task | 任务页、任务列表 |
| 任务目标 / 验收目标 | Task 的 `acceptance.objective` | 任务页、协作页验收区 |
| 工作对象 | Task 或 Project 的会话作用域 | AssistView、协作页、Skill 输出等泛指 target 的文案 |
| 目标版本 | 被引用或被修改的产物版本 | 产物影响检查、产物版本相关文案 |
| 计划候选 | 执行摘要里待确认的就绪候选 | `execution-summary` |

**改动口径。** 两批都只改中文文案与随之失效的断言，**不动 API、数据库、迁移、命令 Owner、权限与 `data-testid` 命名**。逐处对照按「文件 → 现文案 → 新文案」记录，不钉行号（行号随代码演进必然腐烂）。

P0（裁定必须改）：

| 文件 | 现文案 | 新文案 |
|---|---|---|
| `views/ProjectsView.tsx` | `明确目标`（读 `project.goal`） | `项目目标` |
| `components/ExecutionSummary.tsx` | `原执行目标已保存` | `原执行请求已保存` |
| `components/ExecutionSummary.tsx` | `按这个目标执行` | `按这份计划执行` |
| `components/ExecutionSummary.tsx` | `现在确认的是目标与范围：…` | `现在确认的是计划与范围：…` |
| `views/AssistView.tsx` | `所选会话不属于当前目标，…` | `所选会话不属于当前工作对象，…` |
| `views/AssistView.tsx` | `暂时无法读取对话目标` | `暂时无法读取对话作用域` |
| `views/AssistView.tsx` | `正在核对对话目标与会话` | `正在核对对话作用域与会话` |
| `views/AssistView.tsx` | `先在工具行指定目标` | `先在工具行指定任务或项目` |
| `views/AssistView.tsx` | `选完后在工具行指定目标` | `选完后在工具行指定任务或项目` |
| `views/AssistView.tsx` | `从对应目标进入对话后可用` / `回到对应目标开始对话` | `从对应任务或项目进入对话后可用` / `回到对应任务或项目开始对话` |
| `views/AssistView.tsx` | `可以直接讨论或描述目标。` | `可以直接讨论或描述要推进的事。` |
| `views/AssistView.tsx` | `当前目标修订 v{revision}` | `当前工作对象修订 v{revision}` |
| `views/AssistView.tsx` | `切换目标后重新读取` | `切换工作对象后重新读取` |
| `views/AssistView.tsx` | `正在刷新目标与会话…` | `正在刷新工作对象与会话…` |
| `views/AssistView.tsx` | `目标已选。…` / `当前目标还没有会话…` | `工作对象已选。…` / `当前工作对象还没有会话…` |
| `views/AssistView.tsx` | `当前目标下可调用的 Skill` | `当前工作对象下可调用的 Skill` |
| `views/AssistView.tsx` | `以刷新后的目标与提案状态为准` | `以刷新后的工作对象与提案状态为准` |
| `views/AssistView.tsx` | `或描述新的目标与要求。` | `或描述新的要求。` |
| `views/AssistView.tsx` | `核对目标与内容摘要` / `目标 {type} · {id}` | `核对工作对象与内容摘要` / `工作对象 {type} · {id}` |
| `components/ArtifactImpactCheckPanel.tsx` | `目标已出现新版本` | `目标版本已更新` |
| `components/ArtifactImpactCheckPanel.tsx` | `请核对目标后再重试。` | `请核对目标版本后再重试。` |
| `components/ArtifactImpactCheckPanel.tsx` | `请进入目标产物核对` | `请进入目标版本核对` |
| `components/ArtifactImpactCheckPanel.tsx` | `所选目标` / `勾选目标` / `未列出的目标` / `为此目标生成修改候选` / `直接引用目标` / `目标：{id}` | 逐处补成 `目标版本` |

P1（同类歧义，同批改）：

| 文件 | 现文案 | 新文案 |
|---|---|---|
| `components/AssistSkillOutput.tsx` | `消息目标与当前会话不一致，…` | `消息所属工作对象与当前会话不一致，…` |
| `components/AssistSkillOutput.tsx` | `目标 {targetKind} · {id}` | `工作对象 {targetKind} · {id}` |
| `views/CompletionRecordView.tsx` | `完成凭据与当前目标不匹配。` | `完成凭据与当前工作对象不匹配。` |
| `views/ActivityView.tsx` | `筛选目标当前不可见或无权读取；…` | `筛选对象当前不可见或无权读取；…` |
| `components/CommandPalette.tsx` | `委托与审批仍在目标页确认。` | `委托与审批仍在对应项目或任务页确认。` |
| `views/CollaborationView.tsx` | `恢复近期工作、讨论目标、…` | `恢复近期工作、讨论要推进的事、…` |
| `views/ProjectSkillView.tsx` | `当前目标`（读 `summary.goal`） | `项目目标` |
| `views/LiveCreateProjectFlow.tsx` | `填写的目标` / `目标和资料仍保留` / `目标暂存失败` / `重试暂存目标` / `暂存目标后打开蓝图` | 统一读作 `项目目标` |
| `components/ArtifactPanel.tsx` | `保存结果与原请求目标不符，…` | `保存结果与原请求的产物版本不符，…` |
| `components/ArtifactTextLocksPanel.tsx` | `锁定事实与产物目标不匹配。` | `锁定事实与产物目标版本不匹配。` |
| `views/BlueprintSkillGenerator.tsx` | `当前服务端未提供目标版本的项目蓝图 Skill。` | `当前服务端未提供产物目标版本的项目蓝图 Skill。` |

**明确不改（附理由）**：Goal 实体相关全部保留——`labels.ts` 的 `新建目标/关联目标/目标`、`CreateGoalView.tsx` 全部文案、项目页「记录目标」入口与会话顶栏「关联目标：」、`usePendingWork.ts` 的「目标：」、`ProjectResumeView.tsx` 与 `ProjectSkillView.tsx` 的 Goal 列表段。Task 目标相关保留——协作页「验收目标」、`LiveTaskSkillFactsView.tsx` 的「任务目标/验收目标」、`CreateProjectView.tsx` 已是「项目目标」。技术语义的 target 保留——`FileWriteFrozenDiffPanel`「冻结目标」、`FileWriteDispositionPanel`「目标 File ID」、`ConnectionsView`「目标前缀/目标边界」、`KnowledgeView`「目标约束」、`DevToolsPanel`「目标 {normalizedTarget}」、`ExecutionTrajectorySummary`「调用目标」，以及 DOM/滚动/编辑器类注释里的 target。

**残留（下一轮裁定）**：蓝图页标题、Review 原因文案、项目下一步兜底、模型提示词正文四处仍泛指「目标」，不在本次范围。

**实施状态（2026-10-25）**：P0/P1 文案已在工作台源码与随之失效的断言中落地（`AssistView`、`CollaborationView`、`ArtifactImpactCheckPanel`、`ExecutionSummary`、`ProjectsView`、`ProjectSkillView`、`LiveCreateProjectFlow`、`ActivityView`、`CompletionRecordView`、`AssistSkillOutput`、`CommandPalette`、`BlueprintSkillGenerator`、`ArtifactPanel`、`ArtifactTextLocksPanel`、`AppShell`、`ComposerTargetPicker` 及 `assist-target` / `collaborationWorkspace` / `folderFirstConversation` / `composerAttachMenu` / `emptyConversationWelcome` / `impactCandidateGroup` / `composerTargetPicker` / `newConversationLayout` 断言）。真实 Windows/WebView2 窗口、IME/DPI 与安装态未复验。

## 53. 回复生命周期：草稿、过程与最终正文的交接（2026-10-25，已实施，实机未验）

**背景。** 2026-10-25 用户要求对模型回复的整段生命周期做一次综合优化（提交 → 等待 → 真实工具过程 → 实时草稿 → 终态交接 → 完成收尾 → 失败/取消/读取恢复），目标体验是「过程轻量可读、结果突出、状态转换连续、动效克制」。逐帧核对后发现三处真实缺陷：①终态预览帧一到就把草稿整块删掉，而正文要等下一次 `GET messages`，中间露出三秒两点与一块空白；②「这一轮做了什么」的摘要行只写「N 步」，技术细节（工具名、路径、轮次）全挤在折叠行上，用户读不出「它在做什么」；③`<details>` 的程序化 `open` 也会触发原生 `toggle`，那次回声被记成人工开合，「完成时自动收起」因此只生效一次。

**权威状态不变。** 本轮只改呈现层，**不新造业务状态、不动后端完成语义、审批语义与任务执行结果**。消息行仍是唯一权威：`PENDING / RUNNING / COMPLETED / FAILED / CANCELLED` 只从 `GET messages` 读。界面里新增的两个词是**本机过渡读数**，不进任何契约：

| 词 | 含义 | 生命周期 |
|---|---|---|
| `SETTLING` | 预览流已报告终态，最终正文那次 `GET messages` 还在飞 | 读回终态消息行即清除 |
| `UNVERIFIED` | 上述重读失败，状态待核对 | 只在显式重读成功或失权时改变 |

**一个阅读区。** 助手回复的正文位置恒为同一个 `.assist-reply`，三态互斥（`data-state`）：

| 状态 | 内容 | 标记 |
|---|---|---|
| `final` | 安全 Markdown 渲染的正文 | 无（`data-handover="true"` 时一次性淡入） |
| `verifying` | 最后一次草稿纯文本 | 「以下仍是草稿 · 正在核对最终正文」 |
| `draft` | 草稿纯文本 | 「生成中草稿 · 仅当前预览 vN，不是完整消息或已接受产物」 |

草稿**不是卡片**：无底色、无边框、无内边距，字号/行高与最终正文同档（16px / 1.7）。理由有二：它本来就该读成「同一段话的草稿版」，不是等着被替换的容器；交接瞬间的高度差因此只剩 Markdown 块距，用户上滚时读不到一次明显跳动。

**交接规则（按优先级）。** ①预览帧报 `COMPLETED` 且手里有草稿 → 把草稿交接给 `verifying`，同时发起权威重读；②重读带回「终态 + 非空正文」→ 交接成立，进 `final` 并淡入一次；③预览帧报 `FAILED / CANCELLED` → **不交接**，草稿立即清掉（失效内容不能借动画多留一帧）；④重读失败但列表还在 → 保留草稿，状态词改「状态待核对」，行内给「重读最终回复」，页面级说明「下面显示的是上次成功读取的内容，可能已过期」；⑤403/404 或写权限被撤 → 消息、提案、草稿、交接标记一并清空；⑥`COMPLETED` 但正文确实为空 → 明说「这条回复已结束，没有可显示的正文」，不留一块无法解释的空白。

**交接动效。** 一次性 `opacity: 0.6 → 1`，时长 `motion.duration.panel`（180ms），缓动 `motion.easing.standard`；不位移、不缩放、不打字机。`prefers-reduced-motion: reduce` 由全局规则把时长归零，`html[data-motion="off"]` 显式 `animation: none`——两种情况都立即呈现静态终态，文字、复制键、焦点可见性一样不少。中途不重复渲染同一份内容（有 `content` 就不再渲染草稿），页脚（复制 + 用量）只在 `COMPLETED` 出现一次。

**屏幕阅读器。** 只播粗粒度状态：交接中「回复已结束，正在核对最终正文」、失败待核对「回复已结束，最终正文状态待核对」、完成「回复已完成」。草稿修订号逐帧变化，不进 live region。

**过程区（`SessionRoundTrace`）。** 摘要行先说人话，再把技术细节留在展开内容里：

| 位置 | 内容 | 口径 |
|---|---|---|
| 摘要行 | 「这一轮做了什么 · 正在列目录 · 2 步」/「读取文件 1 次、列目录 1 次 · 2 步」 | 活动词由工具名映射（取不到就原样显示工具名），次数与步数是账本实数 |
| 摘要行例外 | 「N 项待核对」（UNKNOWN/ABANDONED）、「N 项未执行」（REJECTED） | 警示色，仍只是文字，不是徽牌 |
| 展开内容 | 轮次序号、工具名、路径、逐项状态、耗时、拒绝原因 | 逐字来自 `session_tool_calls`，不推断、不补结论 |

在途默认展开；完成时默认收成一行，但**用户手动展开过就尊重**（`touched` 只由真实 DOM 状态差触发，程序化回声被忽略）；终态首次展开才补读一次，确认没有轮次时连摘要行一起收起，不留点开是空的壳；完整模型回复不等于文件写入成功或任务完成，过程区不给成功样式。

**正文排版收敛。** 块距统一 `space.3`(12px，含此前的表格 16px)；标题在回复里整体降一档（20 / 18 / 16px，600，上边距 `space.4`），首块不留上边距；表格自带横向滚动盒；行内代码有底色、颜色仍是正文色；末块贴底。规则归本节，数值仍取 tokens。

**滚动。** `followLatest` 只由真实滚动位置决定：在底部时流式增长继续跟随，用户上滚后不再被拉回；交接、过程自动收起都走同一条判定，不额外驱动滚动。窄窗口与右侧检查器打开时，回复列（含代码块、表格）各自在自己的滚动盒内，不产生页面级横向溢出。

**未验边界。** 真实 Windows/WebView2 实窗、多 DPI、输入法；真实 Provider 的首字延迟与长流（本轮用可控的 GET 轮询与延迟响应构造空档）；右侧检查器打开态的横向溢出只在 860px 窄窗验证，未在 `/agent` 协作页开检查器逐个量；独立验收未做。
