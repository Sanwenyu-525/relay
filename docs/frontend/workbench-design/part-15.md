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

**表格里的标识符不许被劈开**（2026-11-01 全链路测试，用户实机截图）。工具名、状态词与错误码是用户判断这一步成败的唯一凭据，`list_directory` 断成 `list_direct` + `ory` 就等于把结果说错。口径三条：单元格用 `overflow-wrap: break-word` 而不是 `anywhere`（`anywhere` 会把最小可容纳宽度算到单个字符，长标识符因此被允许从中间切开），表格改成「至少铺满阅读列、按需变宽」，多出来的宽度交给表格自己的 `overflow-x` 盒；单元格最小宽度取 12 个正文字符，因为一旦表格需要滚动，每一列都会退到自己的最小宽度，6 字宽的说明列会被压成一条竖排丝带；不降任何字号，也不给整表加 `white-space: nowrap`（中文仍按 `line-break` 自然换行）。**配套的一条祖先约束**：`.assist-reply > *` 必须有 `min-width: 0`——网格项默认 `min-width: auto`，会把内容的最小可容纳宽度一路上抬，一张比阅读列宽的表能直接把消息列撑宽（实测 547px 的列被撑到 649px），滚动就不发生在表内而是把整列推走。验收：`tests/browser/assistReplyTypography.spec.ts` 三条用例量每个 ASCII 词落在几行矩形上（1 行为完整），并锁住窄窗（843）与常规窗（1270）下滚动盒宽度不超过正文列、页面无级联横向溢出；把 CSS 改回旧写法，同一断言立刻报出「3 行 / 2 行」。

**滚动。** `followLatest` 只由真实滚动位置决定：在底部时流式增长继续跟随，用户上滚后不再被拉回；交接、过程自动收起都走同一条判定，不额外驱动滚动。窄窗口与右侧检查器打开时，回复列（含代码块、表格）各自在自己的滚动盒内，不产生页面级横向溢出。

**未验边界。** 真实 Windows/WebView2 实窗、多 DPI、输入法；真实 Provider 的首字延迟与长流（本轮用可控的 GET 轮询与延迟响应构造空档）；右侧检查器打开态的横向溢出只在 860px 窄窗验证，未在 `/agent` 协作页开检查器逐个量；独立验收未做。

## 54. 必读文件体积预警：发送前的上下文风险（2026-10-30，已实施，实机未验）

超大型规则入口文件（`AGENTS.md` 这类）会让 Agent 在第一轮就读掉大半上下文，随后被迫压缩——时间与 Token 都花在「文件本来就太大」上，而不是任务本身。本节规定这件事在输入器旁怎么被说出来。**只提醒，不拦截**：预警不改变任何执行链路，也不自动拆分、截断、移动或删除规则文件。

### 54.1 两条读数不能混用

| 读数 | 位置 | 含义 | 分母 |
|---|---|---|---|
| **预计加载量**（本节） | 输入卡**下方**一行提示 | 这次发送之前，有多少必读内容会进上下文 | 有效输入预算 = `min(Provider 窗口, 单次调用预算) − 预留`；单次调用预算取**本会话档位**（0145），无会话时取工作区默认档位 |
| **实测用量**（既有圆环） | 输入卡工具行右端 | 最近一次真实调用实际占了多少 | 那次调用冻结的预算 |

两者**不共用 state、不共用分母、不互相覆盖**。圆环不会因为「还没发就预计超预算」而变红，提示也不会拿实测用量冒充预计值。提示里只写一句分工（「预计加载量（发送前推算）；右侧圆环显示最近一次真实调用」），不展开统计口径。

### 54.2 形状：默认不占位，有风险才一行

- **正常情况不渲染任何节点**：没有必读文件、或占比低于提醒阈值时，这一列与从前完全一致。不做「一切正常」的常驻徽标。
- 有风险时只出一条**单行文本按钮**：`⚠ 发现 2 个大型必读文件 · 预计占用 43% 上下文 · 查看详情`。
  - 位置在**输入卡之外**、卡下方这一列的**第一项**（档位说明与命令回执之上）。卡片内恒定只有正文、工具行与发送键，出现/消失不改变卡片形状，打字时光标与工具行不跳（§25.1 的同一裁定）。
  - 不是彩色卡片：整行 12px（`font.size.meta`），只有警示字形与文字颜色随档位递进（提醒＝次要文字色，高风险＝`text.warning`，严重＝`status.danger.text`），hover 只加 `bg.subtle` 底色。
  - 整行都是按钮：一行文本的命中区小于 24px 时很难点中，做成整行仍保留「一行」这个视觉形状。
- **严重时把动作词换成「发送前请先确认」**：这是发送前提醒，但按钮仍然可用、发送键不被禁用。预警永远不阻止发送。
- 分母不可算（预留已占满或配置缺失）时，写成「预计占用无法估算」，**不画 0%**：`null` 与「真的 0%」是两件事。

### 54.3 浮层：先给读数，再给原因与建议

点开是一个轻量浮层（`role="dialog"`，向上锚定，沿用模型下拉/用量浮层的弹层语言：popover 层、panel 圆角、floating 阴影），顺序固定：

1. 标题行：`必读文件` + 档位徽标 + 按哪类 Agent 枚举；
2. 一行分工说明（预计 vs 实测）；
3. 文件清单：路径、体积、估算 tokens、占比，按体积降序；每行一枚「查看文件」；
4. 预算四行：必读合计、有效输入预算、Provider 窗口（未知就写「未知（按调用预算估算）」）、调用预算与其来源（本会话档位 / 工作区默认档位 / 应用默认）、预留（输出 / 提示 / 工具）；
5. 原因清单：哪些文件触发了哪一档；
6. `优化建议`（默认收起）与 `未计入的条目`（默认收起，含越界、无权限、声明不可用等原因）；
7. 估算口径一句 + `刷新读数` / `本次忽略`。

放不下的内容在浮层内滚动，浮层自身被视口宽度封顶；窄窗（560px 级）下不越出视口。

### 54.4 三个动作的真实语义

| 动作 | 做什么 | 不做什么 |
|---|---|---|
| 查看文件 | 走**同一条受管读取通道**（同一 `connection_id` + 根内相对路径）读正文开头一段，显式标注「只显示开头一段，文件本身未改动」；等待人工确认时如实说「还在等待确认」 | 不新开一条读取通道、不绕过 Gateway 判定、不缓存正文 |
| 优化建议 | 入口拆成「简短导航 + 按需读取的专题文档」、把参考资料移出入口、去重、把档位调到与模型窗口一致 | 不自动改写/拆分/移动任何文件 |
| 本次忽略 | 只写本机一条 `目录 + 文件集合指纹` 记录 | 不静音永久；文件被改/增/删（指纹变化）后**必须重新评估**并再次出现 |

「文件发生实质变化后重新评估」是硬要求：忽略状态绑的是必读文件集合的指纹，不是目录。

### 54.5 何时检查

| 触发 | 行为 |
|---|---|
| 会话 / 项目切换、目录绑定变化、模型切换、上下文档位变化 | 重新审计（目录遍历走 30s 缓存） |
| 每次发送前 | 强制重扫一次（跳过遍历缓存），**不 await、不阻断发送** |
| 展开浮层点「刷新读数」 | 强制重扫 |
| 每次键入 | **不扫**。每次按键扫盘既无必要，也会让提示随打字闪烁 |

文件体积与修改时间每次都重新 `stat`，所以文件被改写后下一次审计立刻拿到新读数，不会被目录遍历缓存骗成旧读数。

### 54.6 无障碍与窄窗

- 提示行是原生 `<button>`，`aria-expanded` / `aria-controls` / `aria-haspopup="dialog"`；外层 `role="status" aria-live="polite"`，出现时播报一次。
- 打开浮层即把焦点移进浮层（`preventScroll`）；Esc 收起并把焦点还给提示行；点浮层外一次即收。
- `prefers-reduced-motion: reduce` 下取消 hover 过渡；颜色、焦点可见性、文字一个不少。
- 窄窗：文本单行省略，动作词 `nowrap` 紧随正文，不换行、不把动作词推到行尾。

### 54.7 未验边界

真实 Windows/WebView2 实窗与多 DPI 未验；真实 Provider 目录（窗口已知）只由单测覆盖 `min(窗口, 档位)` 的取值，HTTP 面只验到「目录里没有该模型 → 窗口未知」；外部 Agent（如独立 Codex 运行时）内部的规则加载与自动压缩不受本应用控制，本节只在 Relay 实际掌握的入口（选择目录、发送前）预警，不声称已拦截其内部行为；独立验收未做。

## 55. 开发期出口：侧栏「开发工具」与 AI 回复场景实验室（2026-10-30，已实施，实机已验）

**背景。** [测试计划 §49](../../testing/verification-plan/part-07.md#49-ai-回复场景实验室全状态回放与批量截图的开发期出口2026-10-30) 的实验室原本只有一条开发构建里的路由，开发者要手敲 `http://127.0.0.1:5173/__dev/assist-scenarios` 才能进去。这条路径在真实桌面壳里更不成立：壳的前端由 Tauri 宿主提供，用户看不到也不能手敲开发服务器地址。本节规定这个出口在产品导航里的形态。

### 55.1 入口放在哪、长什么样

- 位置：侧栏**底部辅助导航**（`nav[aria-label="辅助导航"]`）；不挤进「工作台／项目／待处理／资料」那条主导航。
- 位置细节：辅助导航整块以 `margin-top: auto` 贴底，默认窗口高（780px）下图标栏内容高过可视区，**这一组的第一条**才不用滚动就点得到——开发工具排在「设置」「连接与同步」之前，其余两条仍在同组内、滚动可及。
- 形态：一条普通导航项，图标 `FlaskConical`，入口名「开发工具」，悬停提示（`title`）写全名「AI 回复场景实验室」。入口名与提示可以不同：入口名要短，提示说清点进去是什么。
- 选中态：进入实验室后这一条标为当前页（`aria-current="page"`），与其它导航项同一套判定，不另立一套。
- 不重复：辅助导航、窄窗导航抽屉各渲染同一份条目数据，同一条路由只有一个入口定义；抽屉里是同一入口的窄窗形态，不是第二个入口。
- 只在开发构建里存在：入口项、路由与面包屑分支都写在 `import.meta.env.DEV` 折叠掉的分支里。生产产物里侧栏没有这条、路由没有注册、面包屑不会提到实验室。

### 55.2 返回工作台：回到进入前那一页

- 实验室页头右侧常驻「返回工作台」。它不是浏览器后退：进入实验室前的 `path+search` 由外壳放进 `location.state.from`，实验室按它回原页；没有来源时回默认的 `/agent`。
- `location.state` 不跨刷新。刷新后来源丢失，返回落到默认工作台——这是既定行为，不为此另存一份来源到 `localStorage`。
- 已经在实验室里再点一次侧栏入口时保留现有来源：传空 `state` 会把来源清掉，返回就只剩默认页，回原页会原地打转。
- 返回后实验室组件必须真的卸载（不是 URL 变了、组件还挂着）。判据是 DOM 上 `.scenario-lab-page` 归零。
- 返回不写业务事实：模拟会话不落库、不进 Task／Run／Review／Completion，不改真实会话的正文或状态。

### 55.3 状态与环境污染边界

- 实验室只操作 `ScenarioRunner` 的世界快照：播放、审批、审批按钮改的都是模拟世界。
- 设备偏好（动效开关、阅读密度）离开页面时按进入前的值还原；其余会话存储项不得被实验室改动。
- 场景切换要清掉上一条场景的异步事件与动画：预览外壳按场景 id 作 `key` 重挂（上一条的 DOM 连同其 CSS 动画一起销毁），播放定时器随回放器实例重建而清掉，断言用的等待令牌在卸载时置为取消。定时器、动画帧、`setTimeout` 一类残留不得跨场景继续跑，否则会出现「切到下一条还在动」的错觉。

### 55.4 窄窗

- 侧栏在窄窗档收起，实验室入口出现在导航抽屉里（`nav[aria-label="完整导航"]`），点它能进实验室。
- 实验室三栏（目录／预览／控制器）在窄窗下纵向重排，不产生页面级横向溢出（`scrollWidth - clientWidth` 不为正）。

### 55.5 未验边界

真实 Windows/WebView2 实窗已验（见[测试计划 §50](../../testing/verification-plan/part-07.md#50-ai-回复场景实验室的桌面入口与集成验收2026-10-30)）；多 DPI、跨显示器与键盘全流程未验。独立验收未做。

## 56. 场景实验室 UI V2：预览优先的开发者工作区（2026-10-31，已实施，浏览器已验）

**背景。** §55 的实验室功能齐全，但外壳仍是「三栏等权 + 右侧长表单」：145 条场景全部铺开、控制器比预览更抢眼、1100px 以下直接把三栏竖向堆叠，预览列在常用窗口里只剩约 420px。本轮只重做实验室的使用体验与视觉结构，不改 145 条场景、`ScenarioRunner` 的帧语义或 `scenarioClient` 的只读边界。

### 56.1 页面定位与页壳

- 实验室进入 page-focused 布局：`AppShell` 对 `/__dev/assist-scenarios`（仅开发构建）不再渲染近期工作栏，`app-frame--page-focused` 把宽度交给页面；普通页的侧栏收起状态、列宽偏好和返回来源不受影响。
- 页面自身拿满可用高度，不在根上滚动：目录、预览、检查面板各自持有滚动 Owner。`App.tsx` 的 keyed Outlet 包装层与 `.app-main` 一起成为 flex 列，否则页面会按内容高度伸出视口、目录底部滚不到。
- 顶部只保留一层导航：返回入口、标题、场景总数、「仅开发构建」、轻量信息入口，以及模式切换（逐条播放／全部状态）、运行全部、导出报告。开发隔离说明收进 `title` 与 `aria-label`，不在页头铺一段说明文字。

### 56.2 场景目录

- 宽度 `clamp(13.75rem, 16vw, 15.5rem)`（220–250px），独立滚动；宽窗可收起成整列隐藏，窄窗改为覆盖抽屉。
- 分组按 A/B/C/D/E/F/G/X 折叠，组头显示真实条数；当前场景所属分类自动展开，其他组默认收起。145 条仍全部挂在 DOM 里（折叠只 `hidden`，不卸载），批量验收与清单比对不受影响。
- 搜索匹配 ID、标题、组件位置与状态类型；搜索时自动展开命中分组。筛选「全部／运行中／完成／异常／未验收」只读两处真实事实：`stateKind`（在途/流式、终态、失败/未知/取消），以及本页跑出的验收结果（失败、未覆盖、未跑）。
- 筛选后当前场景若不在结果集，目录顶部保留一条「当前场景」置顶行；选中项不会因为筛选凭空消失。
- 状态只用一个 6px 验收点：通过／失败／未覆盖／未跑分别取 success/danger/warning/neutral token；悬停 `title` 与 `aria-label` 给出验收结论或失败原因。场景标题单行截断，完整标题在 `title`。

### 56.3 播放控制

- 高频播放操作移到预览上方，成为一条紧凑 Playback Bar：上一帧、播放/暂停、下一帧、重置、按帧进度轨道、`第 x/y 帧 · z ms`、0.5×/1×/2×、循环。
- 进度轨道是原生 `input[type=range]`，键盘 `Home/End/方向键` 按帧跳转；跳转、单步、重置都直接调用同一个 `ScenarioRunner`，不创建第二套播放状态。
- 切换场景仍按场景 id 重挂预览外壳、停播、帧归零；旧场景的计时器与动画不残留。`scenario-play` 的 `aria-pressed` 仍是播放状态的唯一界面事实。

### 56.4 检查面板（Inspector）

- 默认关闭，不占预览宽度。打开后在宽窗固定为右列（`clamp(18rem, 20vw, 20rem)`），关闭立即把宽度还给预览；1180px 以下改为右侧覆盖抽屉，检测不到预览列宽变化。
- 三个页签：**展示设置**（阅读密度、窗口宽度、动效、预览底色、展开所有／收起所有）、**事件时间线**（逐帧列表，点击即 seek）、**验收结果**（断言逐条结果、失败原因、未覆盖说明、浏览器批次提示）。
- 原始状态 JSON 收进「验收结果」里的 `<details>`，默认不展开；不再常驻占据画面。
- 宽窗的关闭入口只有预览头的「收起检查」；窄窗抽屉盖住该按钮时才保留面板自己的关闭键，避免同一动作出现两枚重复按钮。
- 阅读密度与动效仍走产品自己的视图偏好，离开实验室按进入前的值还原。

### 56.5 展示全部状态（Gallery）

- 先选分类，再只渲染该分类的场景（每类最多 22 条）；卡片用真实组件停在末帧，不另造回复 UI。
- 卡片语言是轻量纸面：1px 分隔线、`radius.panel`、无投影；卡片头给 ID、标题、状态类型、组件位置与验收点，点击卡片头回到单场景。预览区有最大高度，长任务默认折叠，必要时在卡片内部滚动。
- 离屏卡片用 `content-visibility: auto` 跳过布局与绘制，但节点仍挂载；分类切换不改变 `ScenarioRunner` 或验收口径。

### 56.6 视觉层级与控件

- 五层只表达五件事：页面导航（页头）／当前场景（预览头）／播放工具（Playback Bar）／AI 回复预览（舞台）／技术检查（Inspector）。层与层之间用 1px `border.separator` 和留白分隔，不再用多层卡片与阴影。
- 控件统一到 `control.height.compact`（32px）；字号取 caption/meta/body token；ID、时间、命令、路径用 `font.family.code`。状态色只取 `color.status.*`，验收通过不代表产品执行成功。
- 预览舞台用 `bg.canvas` 纸面；宽窗的回复列保持 `--chat-measure`（744px），不再套厚边框；窄窗／手机宽在舞台中央显示 30rem／24rem 的模拟窗口，外壳列宽不变。视觉规则归[设计系统 §9.24](../design-system/part-06.md#924-开发期场景实验室的预览优先工作区2026-10-31)。

### 56.7 响应式

- ≥1181px：目录常驻列；检查面板打开时为固定右列。
- 1101–1180px：目录仍常驻；检查面板改为覆盖抽屉。
- ≤1100px：目录收为覆盖抽屉，预览占满主体宽度；播放条保持一条（560px 实测 71px 高，不再堆成三层）。
- 900px / 560px：页头按需换行；所有控件留在可点区域，不产生页面级横向溢出；目录与检查面板用 Esc 关闭。
- 断点只改变结构（常驻列／抽屉／换行），不用流体字号，也不把三块内容竖向堆叠成一条。

### 56.8 保留能力与边界

145 条场景、场景清单 JSON、目录搜索与选择、播放/暂停/单步/重置、速度与循环、展开/收起过程、阅读密度、动效开关、预览尺寸、Gallery、原始事件与结果、一键运行全部、验收结果、导出报告、开发版入口、返回来源与生产构建隔离全部保留。实验室仍只读内存模拟世界：不写业务库、不调 Provider、不执行命令、不产生真实审批；验收结果不写入业务验收账本。

### 56.9 验证与未验边界

- 真实 Chromium：新增 `tests/browser/scenarioLabUiV2.spec.ts` 覆盖预览优先布局、目录折叠/搜索/筛选、检查面板开关与预览宽度稳定、播放条、Gallery、900/560 窄窗、滚动 Owner；既有 `scenarioLabEntry.spec.ts`、`assistScenarioLab.spec.ts`（十条 DOM 性质）、`assistScenarioLabShots.spec.ts` 按新入口同步操作步骤，断言未删除。jsdom `tests/scenarioLabMatrix.spec.tsx` 继续逐条跑 145 条呈现断言。
- 生产隔离继续由 `tests/browser-prod/scenarioLabProdIsolation.spec.ts` 与 `scripts/check-scenario-lab-isolation.mjs` 复验。
- 截图与验收材料存 `tmp/Scenario-Lab-UI-V2/`；真实 Windows／WebView2 实窗截图与 `accept-scenario-lab-tauri.mjs` 复跑结论在同目录 `acceptance.md` 记录。
- 未验：多 DPI、跨显示器、安装包内实验室（生产构建不注册该路由，按隔离预期不可达）、键盘全组合。独立验收未做。

## 57. 场景实验室 UI V2.1：批次生命周期、验收口径与完整回放（2026-10-31，已实施，浏览器已验）

**背景。** V2 的外壳已经预览优先，但独立验收发现三类实质问题：批量只有「cancelled 对象」没有批次身份，取消/切场景/离开页面后旧异步仍可能写回；验收把 `browser-only` 静默算进通过，目录与 Inspector 只显示「通过/失败」；`settlePreview` 超时后仍返回当前 DOM，没停稳也会留下通过记录。本轮只修这些事实与交互，不重建场景，不改产品状态机。

### 57.1 批次身份与取消

- 每次运行创建 `run id + mode + scope + cancel token`，既存在 React state 也保存在 `activeRunRef`；`commit/finish` 同时核对「token 未取消 + active id 仍是自己」。
- 运行中可点「取消」：只置取消标记并写 `cancelled` 状态，不再继续切场景、不再增加 done、不把 `done/total` 写成满额。未处理场景保持 `unchecked/未运行`。
- 点击目录场景、切换 Gallery/单场景、离开页面都会取消进行中的批次；离开页面只置标记，不再 setState。
- 重复启动由 `activeRunRef` 同步拒绝，运行中两个启动按钮禁用；取消后可启动新批次，旧 run id 的迟到 promise 因身份不符被丢弃。
- **根因记录：** `App.tsx` 的 keyed Outlet 以 `pathname+search` 为 key。旧实验室在切场景时 `setQuery`，会整页重挂并清空批次状态；V2.1 不再在切换场景时改 URL，query 只作为打开时的深链与 `labSettleMs` 入口。

### 57.2 验收口径

- 新增 `LabAcceptance`：未运行、完整通过、静态通过、静态失败、无法覆盖、无法稳定验证、证据已过期。
- `browser-only` 不计入静态通过；快速静态检查最多到「静态检查通过 · N 待浏览器」，完整场景验收执行完交互且无待浏览器项才写「全部通过」。
- 快速静态检查与完整场景验收各自保存 `run` 记录（含 run id、scope、开始时间、耗时、done/total、verdicts、逐条 check results、取消原因），Inspector 两行独立展示耗时与通过/静态通过/失败/待浏览器/无法验证/无法覆盖/未运行；不把两者合成一份计数。
- 目录只读「最近一次尝试」；当前场景没有批次结果时，手动静态检查可作为当前行的结果，但摘要明确写「当前场景」，不冒充全量批次。完整验收当前场景的记录 scope 为 `current`，目录摘要明确写「其余 144 条未运行（本次只验当前场景）」。
- 场景定义指纹（steps/checks/interactions/conditions/note）随结果保存；指纹变化后旧记录标「证据已过期」，不再计入通过。`judgeScenario`/`countRun` 是纯函数，单测覆盖。
- 导出报告分「快速静态检查 / 完整场景验收」两段摘要与逐场景两列结果；`browser-only` 单独列。

### 57.3 预览停稳

- 停稳算法独立在 `scenarioSettle.ts`：只返回 `ok`、`timeout`（unmounted/identity/unstable）、`cancelled`。超时不再返回当前 DOM，身份不符不拿上一条残留。
- 调用方只有 `ok` 才跑断言；超时记「无法稳定验证」并带原因；取消不产生结果。等待与时钟可注入，单测覆盖迟到响应、反复更新、持续加载、身份不符、取消与超时区分。
- `?labSettleMs=1` 是验收用的显式超时入口（1–10000ms）；浏览器用例用它验证「全部无法验证、静态通过为 0」。

### 57.4 快速静态检查与完整场景验收

- **快速静态检查**（`scenario-run-all`）：第 0 帧挂稳 → 末帧挂稳 → 执行末帧静态断言；不执行场景交互脚本，不实现 Playwright 的浏览器专属检查。
- **完整场景验收**（`scenario-run-full` / 「完整验收当前场景」）：逐个帧顺序 seek 并停稳，再从第 0 帧执行 `click/inspect/advance` 交互脚本，最后落末帧跑静态断言；`scrollUp` 的几何/滚动稳定性明确交给 Playwright，本页只记待浏览器，不重复实现。
- 交互目标不存在记失败；交互执行数写进结果；完整通过要求交互脚本与全部必要检查完成。G01 用例验证 6 帧 + 7 条交互的真实重放。

### 57.5 单帧播放器与短场景

- 单帧场景（如 A05）不显示进度轨道、播放/循环/速度/单步；只显示「静态状态预览」、`第 1/1 帧` 与「重新检查」。多帧场景才显示完整 Playback Bar；末帧播放按钮文案变为「重新播放」，点击明确从第 0 帧重播。
- 单帧预览增加「静态状态预览」说明条：场景说明 + 「查看检查结果」入口；舞台只在内容短时居中（`safe center`），内容超出仍从顶部开始并可滚动。不伪造 AI 消息填充空白，也不改长任务/长回复的滚动。

### 57.6 验证与未验边界

- 新增 `tests/scenarioSettle.spec.ts`（停稳边界）、`tests/scenarioLabRuns.spec.ts`（验收口径与计数）、`tests/browser/scenarioLabRunsV21.spec.ts`（A05/A04/G01、取消、重复启动、切场景/切 Gallery、离开页面、settle 超时）。
- 既有 entry/UI V2/十条 DOM 性质/截图批次按新入口同步；`scenarioLabUiV2` 默认桌面改为断言单帧静态条，窄窗播放检查改用 A04。
- 未验：Tauri 实机批次取消/完整回放仍需 CDP 脚本复跑；多 DPI、安装态、键盘全组合未验。独立验收未做。

## 58. 聊天阅读列统一宽度：三层布局与执行准备面板收口（2026-10-31，已实施，浏览器已验）

**背景。** 用户截图指认：独立聊天页里「正在准备执行」面板横跨整个聊天区，而输入框只有约 744px。根因不是某一条样式写错，而是宽度归属缺一层规定——消息列、输入卡、队列、待办、目标条、目录细条各自写了 `--chat-measure`，后来新增的块（执行准备摘要、目标投影失败条、必读文件预警、子任务委派记录）没有这条约束，就按中栏画布铺满。1440 视口实测：面板 1101.61px（322.39–1424），输入卡 744px（501.19–1245.19），左右各溢出 178.8px。

### 58.1 三层宽度模型

- **① Canvas**：`.agent-chat-transcript-shell` 铺满中栏、自己滚动（`scrollbar-gutter: stable`），滚动条贴中栏右缘。时间线轨道、回到最新按钮、浮层都按它定位。它决定「聊天区多宽」，**不决定内容多宽**。
- **② Reading Column**：`--chat-measure`（`.agent-assist` / `.embedded-assist` / `.skill-page` 上定义，`min(46.5rem, 100%)`），唯一宽度 owner，与输入卡同一条中心线。不再新增第二套宽度常量。
- **③ Content**：会话列的直接子块统一取第②层。实现写在 `AssistView.css` 顶部：`.agent-chat-conversation > *:not(.agent-chat-transcript-shell) { width: 100%; max-width: var(--chat-measure); margin-inline: auto; }`。
- 排除滚动容器是刻意的：收窄它会让自绘滚动条跟着缩到内容中间，等于把 Canvas 和内容列合成一层。`width: 100%` 也不能省——横向 `auto` 外边距会让 flex 子项退出 stretch，只写 `max-width` 会得到 fit-content 宽度的卡片。
- 弹层、Toast/Notice（portal 到 body）与回到最新按钮都不在这个层级，不受该规则影响；时间线轨道在滚动容器内部按容器宽度工作。

### 58.2 修复清单

**原本按画布宽度铺开（本次收进阅读列）**

- `.execution-summary`（执行准备面板，P0）：`READY`／`TASK_PREPARED`／`FAILED`／`CLARIFY` 共用同一容器，四种状态一起收口。
- `.warning-callout`（目标/计划投影读取失败条）。
- `.context-risk`（必读文件体积预警与发送前风险条）。
- `.session-delegations`／`.subagent-supplements`（子任务委派记录与补充入口）、只读子任务那行 `helper-text`。
- `.agent-chat-conversation-heading`（协作页外壳里 `display: none`，其他宿主可见时同样进列）。

**已符合规范、本次未改**

- 消息列 `.agent-message-list`（正文、代码块、表格、附件都在它内部，长代码与表格各自在组件内横向滚动）。
- 输入卡 `.agent-chat-composer`、等待队列 `.assist-queue`、会话待办 `.session-todos`、目标条 `.goal-strip` 与计划卡 fallback、学习记录 `.learning-records-panel`、发送前状态行 `.composer-status-bar`、输入卡上方那一行 `.agent-chat-prereq-row`、目录细条 `.folder-scope-bar`、欢迎页最近动态 `.recent-activity-summary`——这些早已是 `max-width: var(--chat-measure)` + `margin-inline: auto`，本次不动。
- 全局 `.execution-summary`（`FolderScope.css`）未改：它在执行轨迹摘要里还以 `.execution-trajectory` 的形式被复用，收口只放在聊天列的层级上，其他页面的用法保持原样。

### 58.3 长内容与窄窗

- 执行准备面板加 `overflow-wrap: anywhere`：目录与文件路径没有断点时也在卡片内换行；`anywhere` 同时收窄 min-content，单靠 `break-word` 在 flex 子项上仍会被最长 token 撑开。
- 收窄后 `.warning-callout` 里的动作键会被挤成竖排汉字（1024 折两行、375 折八行）。作用域内补 `flex-wrap: wrap` + 按钮 `flex: none`：放不下时按钮整体落到下一行，其他页面上的同名组件不受影响。
- 窄窗（< 744px + 中栏内边距）时整列按 `100%` 收缩，面板、输入卡、消息列三者仍是同一条轴线：375 实测 16–359，420 实测 16–404。
- 面板保持既有内部滚动（`overflow: auto`）与压缩权：竖向空间极紧时先让出高度的是面板，不是消息区；375 视口消息区仍保留 ≥160px。

### 58.4 验证

- 新增 `tests/browser/chatReadingColumnUnification.spec.ts`（11 条，真实 Chromium，API 全部 `page.route` 伪造）：1440／1024／1160×780（Tauri 窗口尺寸）／1280／420／375；`READY`、`FAILED`、`CLARIFY`、`TASK_PREPARED`；长路径；投影失败提示；侧栏收起（画布 1133.61→1320，内容仍 744）；运行中缩放（1440→980，内容随输入卡变 696）；修复前后对照（同一夹具加等价覆盖样式还原旧布局，1101.61→744）。
- 左右缘与中心轴一律按 ≤1px 断言；同时断言 375/420 的 `documentElement` 无横向溢出、面板 `scrollWidth` 不超 `clientWidth`。
- 回归：`chatReadingColumn.spec.ts` 2/2、`sessionTodoList.spec.ts` 9/9（其自带三档同宽断言）、`tsc --noEmit` 通过、与聊天列相关的 jsdom 用例 64/64。
- 证据与数字：`tmp/UI-chat-reading-column-unification/`（`acceptance.md`、`test-results/boxes.jsonl`、`screenshots/`）。

### 58.5 未验边界

- 未在真实 Windows/WebView2 窗口里截图：1160×780 是 `src-tauri/src/lib.rs` 的 `inner_size`，用例按同尺寸视口量几何。
- 产品侧只有亮色一套主题（`data-theme` 仅存在于场景实验室预览宿主）；本次改动只涉及宽度与换行，不含颜色，未另做暗色比对。
- 极窄 + 投影失败提示同时出现时，执行准备面板会被压到内部滚动，底边可能截断半行；这是「面板先让高、消息区保可读」的既有取舍，本次未改压缩规则。
- 32 个浏览器用例把 CORS origin 硬编码为 `127.0.0.1:4173`，本机该端口被另一个项目的预览服务占用（`Task Dock`），这些用例无法在本机启动，未纳入本次回归。

### 59. 电脑操作执行的聊天反馈（2026-11-01 COMPUTER-PLUGIN-E2E）

### 59.1 状态来源

- 执行请求的「准备/等待/执行/结束」只读服务端事实：`conversation_execution_requests.status` 与 `getRunToolCalls` 投影里的 `runStatus` / `waitReason`；界面不新增业务状态词，也不把工具回执推断成完成。
- Run 状态行沿用既有词表：`CREATED`「正在准备执行」、`RUNNING`「正在执行」、`WAITING_APPROVAL`「等待你批准」、`PAUSED`「已暂停」、`VERIFYING`「正在验证结果」、`COMPLETED`「执行已结束（不代表任务验收完成）」、`FAILED`「执行失败」、`CANCELLED`「已取消」；未知值原样透出。
- `ACTION_APPROVAL_REQUIRED` 等等待原因走 `waitReasonText` 的人话映射，内部枚举不直接出现在界面上。

### 59.2 操作范围与失败原因

- 候选带 `interaction=COMPUTER|BROWSER` 时，执行摘要的「当前目录」改为「操作范围：电脑桌面/浏览器」；这是展示语义，不是权限或授权。
- 失败原因（缺哪个 `COMPUTER_READ`/`COMPUTER_INPUT` 连接等）提到阶段行下方，早于标题、目标与操作范围：摘要本身是可收缩滚动容器，放在卡片底部时小窗口首屏看不到。
- 日常界面不显示 `interaction`、`writes_files`、`file_changes` 或 JSON 协议字段。

### 59.3 验证

- jsdom：`executionSummary` 9/9、`executionTrajectorySummary` 14/14、`conversationExecutionClient` 5/5。
- 真实 API + 真实 Chromium：`tests/browser/computerPluginE2E.spec.ts` 2/2（一次性 PG + API + Vite；等待批准显示 Run 状态与审批入口；缺少连接显示失败原因且首屏可见），截图在 `tmp/COMPUTER-PLUGIN-E2E/screenshots/`。
- 未验：真实 Windows/WebView2 窗口；多 DPI；产品无暗色主题。

