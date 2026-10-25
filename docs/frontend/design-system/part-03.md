# 视觉与组件规范：分册 03

角色：所属专题的唯一正文分册；2026-10-25 按原章节迁移，不改变原业务规则、日期、状态与证据范围。

[返回专题路由](../design-system.md) · [文档总入口](../../README.md)

按需读取本分册内的相关小节；跨章节约束沿链接核对，不能把本分册或历史措辞单独当作完整实现/验收结论。正文中的源码与命令路径沿用原有口径。

### 9.5 任务详情样板与全站枚举呈现（2026-10-07）

任务详情页精修样板的视觉规则，交互出口归[工作台 §17.14](../workbench-design/part-06.md#1714-任务详情精修样板与全站视觉收口2026-10-07)。全部数值继续消费唯一 `design-tokens.json`，本轮未新增 token：主区为纸面阅读流（区块间 `space-6`/`space-8`、「标题+内容+分隔线」，不逐块套 surface-panel 卡片），右栏为紧凑事实列（`font.size.meta`，不为填满高度堆卡片）；区块标题 `rowTitle` + 顶部大间距、底部小间距；主区与右栏以左边框与背景区分。新增页面样式一律写页面私有 CSS（类前缀 `.task-detail-` 等），`styles.css` 只由协调者收口。


**同名行类必须按结构区分，不按子节点数量隐式推断（2026-10-08 补充）**：任务详情有两份条件列表复用 .task-detail-criteria-list / .task-detail-criterion——「验收条件」是有编号 <ol>（含 .task-detail-criterion-index），「验收依据」是无编号 <ul>（行内只有正文一个子节点）。两者结构不同，网格列数也不同：有编号的保持「编号列 + 正文列」；无编号的由修饰类显式声明单列 minmax(0, 1fr)，差异写在结构上。**不得**把两列网格无条件套在共用行类上——那会让唯一的正文子节点自动落进编号列宽度（实测 2048px 下正文仅 32px，中文被挤成每行约两字的竖条）；也**不得**为修它全局取消 grid，那会让原验收条件列表失去编号对齐。

**页头元信息按分组换行，不是一整句「·」串（2026-10-08 补充）**：长项目名会让「修订 vN」被顶到单独一行、甚至在「修订」与「v4」之间断开。页头 meta 用 flex 分组（所属项目 / 任务编号 / 修订各成一组），换行只发生在组之间；标签 + 数字 这类同一个事实的组内不允许断行。完整 36 字符任务 ID 不再直出普通 meta 长句：按上条基线降为 code 小字缩略（hash-code），完整值由同一页头内一个默认收起的 <details> 给出，可展开、可选中复制，信息不隐藏。只有 UUID / 长哈希形状才缩略，本身是可读短标识的原样显示。
**枚举与技术值的呈现基线**（全站生效，各页枚举中文化时遵循）：

- 用户可见文案不直接输出原始枚举、`JSON.stringify` 结果或完整技术 ID；中文映射 + 原枚举降级（`small`/`title`/`code`）是默认形态，映射缺失的开放扩展值回退原文且只显示一次。
- 「尚未加载（loading）」「确认没有」「字段缺失」三种状态用不同文案区分，不互相冒充；未运行、未确认、UNKNOWN、失效结果不得使用 `status-chip--success` 或勾选样式。绿色只表达服务端确认的确定事实（如 Run COMPLETED）。
- 就地辅助操作用文字按钮（下划线 + `color.action.text`），与主/次按钮三级分层；空态一行紧凑文字或共享 EmptyState，不用大标题大留白撑空间。
- 时间一律走本设备显示时区的可读格式（ISO 原串保留在 `time.dateTime`）；长 UUID/哈希保留可核对性但降为 `code` 小字或折叠 `<details>`。

本轮新增中文映射：`criterionMethodLabel` 补 `CITATION_EXISTS`/`SEMANTIC`；`acceptanceSourceLabels`（CREATE/CONTRACT_CHANGE/HUMAN）；连接页能力/决定/状态局部映射；Run 页 Gateway 动作与调用状态局部映射；各页其余映射以页面局部常量先行，后续统一收编进 `labels.ts` 由协调者执行。

### 9.6 控件基座与响应式收敛（2026-10-08）

用户要求对所有按钮、表单控件、导航元素、状态提示做控件级精修。本轮全部数值仍消费唯一 tokens（新增 `space.0.5 = 0.125rem` 微间距档；contrastChecks 补 `muted on selection.hover ≥4.5` 与 `onAction on danger ≥4.5` 两道门槛），styles.css 改造 +198/−22 行，交互出口归[工作台 §17.15](../workbench-design/part-06.md#1715-控件交互基线与响应式收敛2026-10-08)。规则：

- **按钮**：`[aria-busy="true"]` 全局降饱和（opacity .7 + `cursor: progress`），五类按钮通用；`.primary-button--compact`/`.secondary-button--compact` 修饰符（min-height=control.height + meta 字号）收编页面私改的 2.5rem 主按钮，页面不得再压回全局按钮高度；danger 仅用于不可逆/终止操作，可恢复操作（暂停、取消会话）用 secondary——分级注释固化在 danger-button 规则处。复合开关控件（如委托开关：主按钮+内嵌说明文字的 flex-wrap 结构）保留自有规则，但其 hover/active/focus 必须与全局 primary 等值。
- **表单**：输入基座 `:focus-visible` 主色边框（focus 视觉 ≥ hover）；`.field` 基类排除 checkbox/radio（回归原生 + accent-color，删除历史补丁）；label 布局收敛为全局 `.field--row`（横向，label `flex:none; min-width:7rem`）与 `.field--grid`（两列 grid）两个变体，页面私有横排/两列实现应替换为变体；结构不同的页面实现允许保留但须注释收编路径。
- **状态提示**：补全局 `.success-callout`（warning 同族骨架）；receipt-message/action-error 补 3px 左色条形成同族呼应；`.loading-text` 统一裸 loading 文案（meta 字号 + muted），「还在跑」的持续信号（inflight-dots、composer 光条）不属于此类不动；`warning-callout > button` margin 全局化，页面不得手写。
- **断点收敛**：目标为三档语义——`width < 48rem`（折行/降级）、`width < 64rem`（大屏增强）、`width < 80rem`（rail 出现），写法统一 range 语法并与整数 min-width 档配对，禁止新增 `.9375rem` 补丁与 min/max 双触发。本轮处理的 700px、60rem、45rem 规则已并入对应语义档（逐处注释）；既有页面仍有遗留断点，不能描述为全站已收敛，具体剩余范围归[功能验收表](../../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。PageHeader 接管页面标题后，确认不再匹配的页面 `> h1`/`.page-lede` 直选规则可清理。

  2026-10-15 外壳折叠点下移（spec/计划见 `docs/superpowers/`）：外壳收纳（`.app-frame` 单列、两栏 `display: none`、图标栏退化为纯图标、`☰` 出现）由 `width < 64rem` 迁到 `width < 48rem`，因此 64rem 档回归它本来的「大屏增强」语义（拖拽手柄、页面密度），不再兼做外壳收纳；同区间新增一条 `@media (48rem <= width < 64rem)` 只覆盖 `--relay-shell-sidebar-width`，让用户拖拽宽度不泄漏到该档。页面密度（主区内边距、标题降 `compactPage`）与拖拽手柄仍留在 `< 64rem`。`.app-topbar:not(:has(.breadcrumbs))` 的整行收起区间同步改为 `min-width: 48rem`，避免该区间出现「点开只是重复屏幕上内容」的空抽屉顶栏。

  2026-10-10 收敛回写：剩余遗留断点已按四档语义值（`breakpoint.medium/large/rail/wide` = 48/64/80/90rem）收口——Reviews 的 60rem 标题档因与全局 `<64rem` 重复而删除，Knowledge/Run/TaskDetail/ArtifactPanel/LiveTaskSkillFacts/TaskCheckPlanPreview/styles 的 40rem 兜底档并入 `<48rem`，各处 `.9375rem` 与 min/max 双触发改写为 range 语法（逐处注释）。`tests/responsiveTiers.spec.ts` 把档位集合、禁补丁、禁双触发与禁旧式 max-width 写成可执行守卫；`tests/browser/responsiveFoldGeometry.spec.ts` 在真实 Chromium 复核 700/767/768/900/1023/1024px 的折行边界与无横向溢出。**未收敛**：`views/AssistView.css` 的 `max-width: 64rem` 属自然语言状态维护任务在途文件，本轮只做守卫豁免（语义档位合规、写法待其 Owner 归一），不覆盖他人未提交改动。
- **对比度**：token 组合新增两道 contrastChecks 门槛；各页新增背景/文字组合时必须能映射到 contrastChecks 已有条目或补充条目。

### 9.7 项目列表页结构（2026-10-11）

用户以静态原型 [projects-redesign.html](../mockups/2026-10-11/projects-redesign.html)（含同目录渲染截图 [projects-redesign.png](../mockups/2026-10-11/projects-redesign.png)）发起项目页改造，并选择「整体重做 / 跟随原型」。本轮只改 `/projects` 的呈现结构，**不改业务规则、命令 Owner、API、数据库与路由语义**；设计取舍见[项目页重设计 spec](../../superpowers/specs/2026-10-11-projects-page-redesign-design.md)。页面样式全部写进页面私有 [`views/ProjectsView.css`](../../../apps/workbench/src/views/ProjectsView.css)，`styles.css` 只删除了已失效的 `.projects-page .rail-trigger` 两条规则。

| 区域 | 规则 | 备注 |
|---|---|---|
| 推进摘要条 | `bg.subtle` 底 + `separator` 边 + `radius.panel`；左侧 `selection.bg` 图标框 + 「N 个项目正在推进」+ 说明；右侧未明确下一步用 `status.warning.text` 文字，已明确用 `status.success.text` | 常驻区块，不整块套警示底；「去完善」是文字按钮，打开首个缺下一步的项目详情 |
| 计数口径 | fixture 为全量精确值；live 只统计**已加载**项，有后续页时说明「按已加载项目统计，仍有后续页」 | 不把部分计数冒充全量 |
| 页签 | 全部项目 / 进行中 / 已归档，是**路由链接**（`aria-current`），不用 `role=tablist`（§6 规则）；计数沿用既有「进行中 (3)」写法 | live 一次只加载一个范围，只有当前范围显示计数 |
| 默认范围 | `/projects` 不带参数即「全部项目」；进行中 `?scope=active`、已归档 `?scope=archived`，历史深链接 `?archived=1` 继续可用 | 与原型首屏一致；是**可逆取舍**，改回默认 `active` 只需改 `scopeFromQuery` |
| 卡片网格 | `auto-fill minmax(min(100%, 23rem), 1fr)`，`space.6` 间距；卡片 `bg.surface` + `separator` 边 + `radius.panel`，顶缘一条 `action.primary → selection.bg → transparent` 细色条 | 网格/列表切换只换容器类（`.projects-grid.is-list`），卡片标记不变；细色条高度用 `space.0.5` |
| 卡片内容 | 活跃/归档标记、图标框、名称（键盘可达的打开按钮）、类型说明、状态胶囊、当前阶段与下一步两个内嵌信息格、页脚范围说明与「查看项目」 | 下一步为「尚未明确」时用 `status.warning.text` 文字色，不套警示底 |
| 新建卡 | 虚线边 + `bg.subtle`，悬停换 `action.primary` 边与 `selection.hover` 底；无顶缘色条 | 只在「全部/进行中」范围且无搜索词时出现，避免把入口读成已存在的项目 |
| 详情抽屉 | `AppDialog variant="drawer"`，标题「项目详情」；对象名、阶段、修订、下一步、归档入口与确切 ID 都在这里 | **宽屏不再有常驻右栏**；`.desktop-rail` / `.rail-trigger` 在项目页不再渲染 |
| 就地反馈 | 归档阻断原因、待核对原命令、成功回执与失权错误仍留在主列，不随抽屉关闭而消失 | 抽屉不是唯一证据载体 |

空态三种区分（首装为空 / 搜索无匹配 / 归档范围为空）与各 `data-testid` 命名保持不变。本轮**未新增任何色值、字号、圆角或动效数值**；验证出口与未覆盖范围归[功能验收表](../../testing/overall-acceptance-2026-09-28.md#当前功能验收表)，真实 Windows WebView2 的字体、DPI、输入法与辅助技术仍需单独验收。

### 9.8 V4.2 页面原型对齐（2026-10-14）

用户以 Relay V4.2 页面原型（`GPT页面原型/Relay_V4.2_工作详情与成果预览.html`；仓库里该文件名带 URL 编码字符，故此处以文本引用而不是链接，避免文档检查器解码后找不到目标）发起整站视觉对齐，并选择「全站统一视觉 / 接入现有 token 体系」。因此**不新建第二套色值表**：原型那套冷绿语言全部收敛进 `design-tokens.json` 的基础色，再由语义别名与既有组件消费，配色/圆角/阴影一次改动即传播到全部页面。

| 原型值 | 处理 | 理由 |
|---|---|---|
| `--bg #fbfcfa` / `--rail #f8faf7` / `--dark #203329` / `--text #425248` | 直接收敛为 `color.palette.paper / sidebar / ink / secondary` | 画布—导航—文字三层关系与原型一致，画布上分别为 13.0:1 与 8.1:1 |
| `--line #e8eee8` / `--tint #edf5ef` / `--green #205d47` | 收敛为 `line / sage / forest`，hover、pressed、sageHover 由原型的 `#164735` 等值接续 | 主操作色与选中底是原型的识别特征 |
| `--muted #88998d` | **同色系加深**为 `#55675d` | 原型值在画布上只有 2.92:1，低于 §3 的 4.5 门槛；加深后画布 5.86:1、选中悬停底 4.99:1，色相不变 |
| `--warn #a76e30` | **同色系加深**为 `#96622a` | 原型值在 `--warnbg` 上只有 4.02:1；加深后 4.84:1 |
| `--red #a34f43` / `--redbg #fff2ee` | 直接收敛为 `red / redSoft` | 5.11:1，无需调整 |
| 卡片 12px 圆角、6px 徽标圆角 | `radius.panel` 0.5→0.75rem，`radius.badge` 0.1875→0.375rem | 原型的卡片与状态标签比旧值更圆；`radius.composer` 保持 1rem，因为发送键按 `2 × radius` 同心推导，缩到 12px 会容不下 32px 的键 |
| 卡片投影 `0 10px 32px rgba(30,57,37,.055)` | 新增 `shadow.card` | 只给「浮在画布上的内容块」（面板、纸面）；列表、侧栏与页壳仍无阴影（§1 的既有约束不变） |

新增的其它 token：`color.palette.lineStrong`（`meter.track` 需要与纸面拉开 ≥1.2:1，`line` 只有 1.18:1）、`layout.inspector.width / wideWidth`（工作详情面板 322 / 610px）。同时**补定义**了三个早已被 `TaskInspectorPanel.css`、`TaskViewDashboard.css` 消费却从未存在的 token：`font.weight.bold`、`font.lineHeight.snug`、`font.lineHeight.relaxed`——此前浏览器按无效值回退，面板小标题与说明段落拿不到声明过的层级。

组件规则的同步变化：

- 回执与错误提示（`.receipt-message` / `.action-error`）由「左侧 3px 色条」改为「整圈 1px 边框 + 圆角」，对齐原型的 `error-box` / `attention-strip`：长句换行后，整圈边框才读得出「这是一块独立状态区」。
- 应用顶栏与近期工作栏底色由 `bg.canvas` 改为 `bg.surface`，与原型「白工具条 + 白侧栏、画布色留给主内容」的分层一致。
- 图标导航顶端曾新增品牌方块（主色圆角方块，`aria-hidden`，纯装饰；短窗口 `max-height: 50rem` 隐藏，把高度让给十个常驻入口）。**该方块已于 2026-10-16 整体移除**，图标栏顶端不再放任何标识，理由与「按原型改造时不得加回」的声明见 §9.10。
- 右侧面板重构为原型的「工作详情」三页签（进展 / 成果 / 记录）+ 成果深预览（预览 / 版本与来源）。**未实现原型的「变更」页签**：面板没有真实 diff 数据源，按 §2 的「不伪造」原则只呈现真实读到的字段。面板在 `<80rem` 改为覆盖在成果区之上的浮层，宽度仍取同一 token。

本轮没有改动业务规则、命令 Owner、API、路由语义与任何写入路径；色值变更只落在 JSON，验证出口与未覆盖范围归[功能验收表](../../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

2026-10-15 接续：工作详情开关与成果按钮明确可操作；成果按钮采用左对齐、尾部箭头、hover 与键盘焦点环，无版本条目仍为静态信息。聊天＋详情默认采用两块内容区，独立成果/判断栏按需展开且保持挂载；任务视图和用户明确选择的布局仍保留。双视图引入的 `.collab-chat-view-container` 也必须把剩余高度交给 `.agent-assist`，否则旧的直接子选择器漏匹配，输入卡会停在消息后而非窗口底部。工作台任务标题降为既有 `font.size.rowTitle`，不改共享 PageHeader 或新增 token。业务交互归[工作台 §28.8](../workbench-design/part-10.md#288-v42-工作详情与成果预览接续2026-10-15)，检查结果只归统一验收表。

深预览只保留一层纸面边框与留白，内层 SafeMarkdown 不重复套卡片，正文标题使用既有 `font.size.rowTitle`，不继承全页 section 标题的体量；Markdown 解析与其他页面的样式保持原有实现。

原生 Windows 窗口复查发现窄容器与短窗口的旧规则又将任务标题覆写为 `section`，造成窄窗标题反而变大；已删除两处覆写，所有尺寸沿用上述 `rowTitle`。

2026-10-15 第二轮（本轮只增不改，零新增色值）：预览栏在多版本时新增「确切版本」切换组——`.inspector-preview-version` 用 `radius.badge` 圆角与 `border.control` 描边，选中态同时给 `selection.bg` 底色、`action.primary` 描边与字重三重表达（不靠颜色单独区分），`aria-pressed` 为准；attention 条目内的去处 `.inspector-attention-action` 沿正文同色同字重，仅用下划线与 `space.2` 缩进表达可点。三者全部消费既有 token。

### 9.9 横向尺寸改为「百分比 + 上下限」（2026-10-15）

原型对齐后暴露一个问题：固定 rem 列宽会让同一界面在不同分辨率下比例不一致——侧栏固定 14rem 时，1920 宽窗里它只占 10.6%，中栏被不成比例地拉大；右栏固定 25.5rem 时同样越宽占比越小。用户据此要求「尺寸做百分比和上下限」，本轮把**所有横向列宽**改成 `clamp(下限, 百分比, 上限)`：

| 列 | token | 值 | 边界 |
|---|---|---|---|
| 图标导航 | `layout.navigation.railWidth` | 4.75rem **固定** | 有意不参与缩放：它是窗口外壳常量，竖排标签在宽窗下会被拉散（2026-10-15 由 5.5rem 收到 4.75rem） |
| 近期工作栏 | `layout.shell.sidebarWidth` | `clamp(11rem, 16%, 17rem)` | 176–272px |
| 页面右栏 | `layout.rail.width` | `clamp(20rem, 26%, 26rem)` | 320–416px |
| 窄右栏 | `layout.rail.narrowWidth` | `clamp(18rem, 24%, 24rem)` | 288–384px |
| 工作详情面板 | `layout.inspector.width` | `clamp(18rem, 20%, 22rem)` | 288–352px |
| 成果深预览 | `layout.inspector.wideWidth` | `clamp(30rem, 34%, 40rem)` | 480–640px |

百分比基准是**各自所在的容器**而不是视口：侧栏比 `.app-frame`，面板比 `.collab-columns`。这样窗口出现滚动条、或面板收成浮层时，各栏仍按同一比例分配。`layout.sidebar.width`（14rem）保留，但语义收窄为**拖拽起点默认值**——`SidebarResizeHandle` 仍按它推导 px 上下限，用户手拖后由 `--relay-sidebar-user-width` 覆写。

实测（工作详情打开；对话/成果两栏在所有宽度恒定 52/48）：

| 视口 | 侧栏 | 中栏 | 成果栏 | 面板 | 面板占比 |
|---|---|---|---|---|---|
| 1280 | 205 (16%) | 359 | 332 | 288（下限） | 29.2% |
| 1440 | 230 (16%) | 429 | 396 | 288（下限） | 25.7% |
| 1920 | 272（上限） | 645 | 595 | 312 | 20.0% |
| 2560 | 272（上限） | 957 | 883 | 352（上限） | 16.0% |

占比只在被上下限截断时才偏离百分比——这正是上下限的用途：窄窗保住可读宽度，宽窗限制上限避免侧栏吃掉中栏。

实现过程中踩到两个 CSS 陷阱，都已写进注释：

1. **clamp 的 `%` 在网格里会拿轨道宽当基准。** 面板自身 `width: clamp(18rem, 20%, 22rem)` 时，网格项的包含块是它所在的轨道，于是 20% 恒小于下限、永远取 18rem，还会在轨道与面板之间留一道空隙。修法是把宽度交给 track（`.collab-columns:has(.task-inspector) > .task-inspector { width: 100% }`），clamp 只出现在 `grid-template-columns` 里。
2. **拖拽手柄必须与列宽同源。** `.app-frame` 上解析一次 `--relay-shell-sidebar-width`（内含「用户覆写优先、否则回退 clamp」），分隔条 `left` 复用同一变量，否则列宽变了、分隔条还停在旧位置。实测手柄中心与侧栏右缘偏差 0px（含 localStorage 预设 260px 的场景）。

### 9.10 V4.3 左侧两栏对齐（2026-10-15）

用户给出新原型 [Relay_V4_3_项目接续与人工判断](../../../GPT页面原型/Relay_V4_3_项目接续与人工判断.html)，要求据此复刻左侧导航视觉。范围只有外壳两列（`.app-navrail` 图标栏 + `.app-context-rail` 近期工作栏）的标记与样式：路由、`data-testid`、命令 Owner、会话草稿 Owner 一律不动，**零新增 token、零新增色值**，Breaking Change：No。

| 落地规则 | 取值与取舍 |
|---|---|
| 近期工作栏头部拆两行 | 第一行品牌「Relay」+ 标签「工作空间」（`font.size.caption` + `text.muted`）+ 折叠把手；第二行「新对话」提升为独占一行、左起的紧凑入口（**无底色、meta 字号、`control.height.compact` 高、横向仍占满栏宽**，见下条）。原型把两者挤在同一行、按钮高 37px，本站高度此前由 `control.height.prominent`（48px）决定，2026-10-16 第四轮按用户要求收到全站默认的 `control.height`（40px）、第六轮再收到 `control.height.compact`（32px），仍不跟原型 37px 取一个自定义值 |
| 项目分组摘要加目录图标 | `Folder` 只给真实项目，「未归入项目」不加：给它同一个图标会读成「还有一个项目叫这个名字」。chevron 的旋转规则同时收窄为 `svg:first-of-type`，目录图标不参与旋转 |
| 图标栏左右内边距 `space.1` → `space.3`：选中块收成方块 | 2026-10-16 第二轮。用户对照原型截图指出「选中阴影面积不一样」，把两边逐像素量出来后根因很清楚：原型的色块**就是按钮本身**（44×44 放进 49px 内容盒，两侧各空约 2.5px），栏宽 59px 里靠自身 padding 又留出 5px，所以它读成一块方形瓷砖；本站栏宽 4.75rem 而 padding 只有 4px，色块被撑成 67×53 的整行高亮，面积 3551px² 接近原型 1936px² 的两倍，选中态换了语义。改 `.app-navrail` 的左右 padding 而不是给色块另建伪元素：单格实测 51×50，面积 2550px²，与原型同为方块，且不需要 `isolation` + 负 z-index 那套层叠把戏。栏宽本身未动（`layout.navigation.railWidth` 仍是 4.75rem，见下方「不照搬的项」） |
| 竖排标签 `font.size.meta` → `font.size.caption` | 用户指出「原型标签字号小一点」。原型实测 9px／weight 400，低于 §4 可读下限，不跟；本站由 14px 收到 12px（§4 辅助档下限，与 §9.11 的「辅助信息走 caption」同源）。连带修掉一处旧毛病：标签盒由 59px 收到 43px，「连接与同步」从「连接与同／步」的单字孤行变成「连接与／同步」两行等长，且三字名称（36px）不再溢出 51px 的色块 |
| 选中激活条压在色块左缘 | `.navigation-item--active::before` 取 `left: 0`、定高 `space.6`（24px）、宽 `layout.navigation.markerWidth`（3px）、竖向居中于单格。四项与原型 `.marker` 逐条同值（实测原型 3×24、`left` 在色块左缘、`0 3px 3px 0`、居中于 44px 单格），颜色本就同一个 `action.primary`（rgb(32,93,71)）。右侧圆角写 `radius.badge`（6px）而非 3px：CSS 对超出盒宽的圆角按比例整体收敛，3px 宽 × 上下各 6px 的 f = min(3/6, 24/12) = 0.5，**实际用值正好是 3px**，与原型 `0 3px 3px 0` 同形且不另开一档。3px 宽度本轮新增 token（见 §9.9 与 tokens 的 `layout.navigation.markerWidth`）：此前借用 `focus.width`（2px），一是偏细，二是把焦点环专用档挪去当选中记号，两种语义混用。**这一条接续并推翻了本轮前两次的写法**：先「贴栏边」（离图标 22px，读不出哪格被选中）、再「挂到图标左侧并上对齐图标顶」（2px 胶囊浮在色块内部）——两者都是在 67×53 的整行高亮上找位置，怎么放都不对；色块收成方块后，块左缘本身离图标左缘仅 13px（原型 10px），贴块与近图标不再是二选一 |
| 图标栏悬停与选中同层淡底 | 原型 `.rail button:hover, .rail button.active` 共用一个 `#eaf3ec`；本站全局 `color.selection.hover`(#E0EDE4) 比 `color.selection.bg`(#EDF5EF) **更深**，直接沿用会让鼠标扫过任一未选中格子时，它的淡底比当前选中项还重一档——层级读起来是倒的。全局那档在任务行等密集列表里是对的（悬停必须比静止显眼），故只在 `.app-navrail` 内把 hover 覆写成 `selection.bg`，**两个全局 token 一字未动**；窄屏抽屉走 `.mobile-navigation-item`，本就不受该覆写影响。真实 Chromium 悬停实测：非选中项 hover 与选中项 rest 同为 rgb(237,245,239)，移开后回 `rgba(0,0,0,0)` |
| 选中块与原型仍有两处数值差，不追 | 填充 `#EDF5EF` vs 原型 `#EAF3EC`（差 R+3 G+2 B+3，肉眼不可分）：token 表的 metadata 写明原型色值是「归一推荐」，且 `color.selection.bg` 是全局档，任务行与 chip 共用，为三个灰阶改它属不值当。圆角 `radius.control` 8px vs 原型 9px：表里没有 9px 档，不为 1px 开一档。两边 `box-shadow` 均为 `none`——所谓「选中阴影」一直是淡绿填充块，没有阴影可对齐 |
| 图标栏入口间距 `space.1` → `space.2` | `.navigation-list` 的 `gap` 提到 8px（原型同为 8px）。4px 时十个竖排格子贴成一片，色块的边界被吃掉。单格收成 50px 高后三档实测均无纵向滚动，不需要再为短窗口退回 4px（曾加过一条退回规则，8px 在 53px 单格下会把 720 高档顶成 `scrollHeight` 647 > `clientHeight` 635；单格变矮后该覆写已删除） |

**栏头「新对话」收成无底左对齐小入口（2026-10-16 用户六轮决定）**：用户先对照实机截图要求这条入口不要背景色，随后要求收小字号与图标并左对齐，再要求把悬停淡底收矮、收掉按钮自身的上下留白；第五轮我把「还是有点宽」误读成横向宽度（整条撤回，见本节末），第六轮才收到用户真正指的那件事——上下间距。落地为**无底左起动作**：`background: transparent` + `color.action.text`（#205D47，实测对栏底 `bg.surface` 白 7.73:1）+ `font.weight.semibold`；字号 `font.size.meta`（14px，与栏内行标题同档，不再比列表项更重）；图标 16px（取 `font.size.body`——本文件已有「图标跟随字号」的写法，`control.icon.size` 20px 是列表行图标在用的值，不为此新增 token）；`justify-content: flex-start` + 横向内边距 `space.2`，实测图标左缘距栏 17px、与下方搜索框的放大镜同一条竖线，文字左缘 41px。**淡底不顶满命中区**：hover/active 的底色画在 `::before` 色带上（`position: absolute` + `inset: space.1 0` + `z-index: -1`，元素自身用 `isolation: isolate` 建 stacking context，把色带压在图标与文字之下），实测色带 22px 高（32 − 2×`space.1` − 2×`border.width`）、每侧内缩 5px、圆角 `radius.control` 8px——上下内缩这条与同栏 `.recent-work-item` 激活标记的写法同源（`styles.css:747`）。两档淡底用的是 `selection.hover` / `selection.bg`——这正是窄窗抽屉里同一条 href 的 `.mobile-navigation-action` 早已在用的语言（`AppShell.css:18`）：此前宽窗是居中实心绿块、抽屉是无底左对齐绿字，同一件事长两种样子，现已归一。**整块高度 48px → 40px → 32px**：第四轮由 `control.height.prominent` 收到全站默认 `control.height`(40px)，第六轮再收到 `control.height.compact`(32px)，**这两条一起推翻本节开头与 §9.10 表格行此前记的「高度仍取 prominent、不为贴原型 37px 缩命中区」**——48px 是给实心主按钮用的高，无底小入口留着只会让 14px 标签上下各空 17px（实测）；32px 仍是 token 表里的紧凑控件档，`control.target.minimum`(24px) 之上有 8px 余量，指针与键盘目标不缩水，也没跟原型 37px 那个自定义值。**这一档的语义要如实写明**：`control.height.compact` 的 `$description` 原用途是「紧凑图标按钮（如对话输入器的发送键）的高度与最小宽度」，这里借给一条图标＋标签的文字入口，属同档尺寸复用而非该档本义，后续若觉得偏挤应退回 `control.height`(40px) 而不是开新档。实测标签上下各空 7.25px（第四轮 11.25px、第三轮及以前 17px）。**「上下间距」是整条竖向节奏，不只按钮自己的高**：`.context-rail-new` 的 `margin-bottom` 与栏头 `.context-rail-head` 的 `margin-bottom` 各由 `space.2` → `space.1`，实测品牌行→按钮、按钮→下方搜索框两段间隙各 4px；只缩 `min-height` 不动这两条 margin，用户看到的间距一寸没变。`primary-button` 类仍保留，它负责共享的 focus/disabled/loading 机制；覆盖 `min-height` 与底色、字重、内边距、`justify-content` 一样必须写进双类块，否则被靠后的 `.primary-button` 反压回 prominent。四处连带踩点，都记下来免得再踩：① 覆盖必须写成双类 `.primary-button.context-rail-new`——共享按钮基座与 `.primary-button` 都在 `styles.css` 靠后位置，单类覆盖会被同特异度反压，实测字重退回 medium、内边距退回 `space.4`、`justify-content` 退回 center（与 §9.11 同一课）。② 全局 `:where(.primary-button):focus-visible` 把焦点环换成 `text.onAction` 白，是为实心绿底准备的；去掉底色后白环落在白色栏上等于没有焦点，因此该元素显式回到默认 `focus.ring`（同为 #205D47，实测 2px 内描边可见）。③ 淡底反馈有 `motion.duration.fast` 过渡，脚本在 hover 后立刻读 `getComputedStyle` 会拿到过渡首帧的 `rgba(0,0,0,0)`，误判成规则没生效——等一帧以上再读，实测 260ms 后为 `rgb(224,237,228)`。④ 淡底改画到 `::before` 之后，元素自身底色必须显式再压一次：共享基座 `.primary-button:hover:not(:disabled)` 特异度 0,3,0，高于本条 `background: transparent` 的 0,2,0，不压住 hover 会把实心 `action.hover` 绿底整块填回来、绿字落在绿底上不可读（把淡底移上色带的第一版实测正是这个结果）。备选写法 `background-clip: content-box` 已否：它按「外圈 − padding − border」内收圆角，8px 内边距配 `radius.control` 8px 会把色带压成直角，要保住圆角就得再写一条三 token 相加的同心算式，还会连带改掉焦点环的圆角。

**第五轮「横向收成贴着内容的小块」当日整条撤回（对指令的误读，留此防再犯）**：那一轮把 `width` 由 `100%` 改成 `fit-content`（配 `max-width: 100%` 兜极端窄栏），实测整块 84×40px、色带 82×30px、左右各留 `space.2`，代价是指针命中区由整行（栏内容宽 144–189px）缩成 84px 宽——「整行可点」这个便利属于功能回退。用户随后说明「我是指上下间距不是悬停阴影」，第六轮把 `width` 改回 `100%`，命中区横向恢复满行（1280 宽实测整块 186.8px 对栏内容宽 188.8px），色带随之回到满行。这条撤回留在文档里是因为它记的是流程教训：**用户指着一条入口说「还是有点宽」时，先确认是横向还是竖向**，涉及命中区缩小的改动不该在维度未定时落地。常驻断言同时补了一条横向的（`ownWidth ≥ 栏内容宽 − 2`），防止这条误读再次悄悄留在样式里。

**图标栏顶端不放 logo（2026-10-16 用户决定；后续按页面原型改造不得加回）**：V4.2 在图标栏顶端加过品牌方块 `.navrail-brand`，V4.3 对齐时改名放大为 `.navrail-logo`，本轮按用户要求整体删除——`AppShell.tsx` 的 `.app-navrail` 内不再有品牌节点，`styles.css` 原位置只留一条说明注释。理由不是尺寸或配色：图标栏只承担定位，本站的品牌标识已由第二列头部的「Relay」品牌行持有，同一屏不需要第二个标识位，短窗口还得为它让位。原型 `.rail` 顶部那块 34px 绿色方块属图片自身设定，**不作为实现依据**；今后任何原型再出现同类 logo 位，默认同样不加，除非用户明确要求并连带说明标识 Owner 归谁。

**不照搬的项**：原型的 9–10px 字号（低于 §4 可读下限，本站止于 caption 12px）、栏内只放 6 个入口（本站 10 条常驻，见 §9.3）、59px 栏宽（`layout.navigation.railWidth` 4.75rem 不动，本轮改的是栏内 padding 而非列宽：五字中文名称要留得下）、18px 图标（本站 `control.icon.size` 20px）、每行前缀图标（与会话类型徽标重复）、`sidebar { width: 0 }` 式折叠（本站保留常驻把手列，收起后仍能一键展开），以及上条单列的图标栏 logo。

**剩余视觉差逐项对得上，不是漏改**：选中态、标签字号、色块面积、激活条粗细这四项经本轮量产后已对平原型的读法（方块 + 压在块缘上的 3px 短竖线）。仍能看出的差别只剩：顶端没有品牌方块（用户 2026-10-16 要求移除，见上条）、10 条入口而非 7 条（§9.3 常驻要求，故栏内更密）、标签 12px 而非 9px（§4 下限）、图标 20px 而非 18px、栏宽 76px 而非 59px。要再靠拢只能放宽这几条之一，属产品决定，不由视觉复刻轮次自行推翻。

**数据来源声明不迁入侧栏**：原型把在线状态与说明文字放在侧栏页脚，本站的 `.demo-notice` 仍留在正文列末。近期工作栏可折叠、`< 48rem` 整体隐藏，「这是示例数据」这件事不能跟着一起消失——这是 §3 的既有约束，不是视觉偏好。

验证出口：真实 Chromium 1280 宽三档（900 / 800 / 720 高）实测图标栏内品牌节点数为 0、10 条入口全部常驻、导航自身无纵向滚动（`scrollHeight` = `clientHeight` = 815 / 715 / 635），末项底边 803 / 707 / 627（相对栏顶）均在可视区内。本轮另把原型本身用真实 Chromium 打开逐像素量出基准（`.rail` 59 / 按钮 44×44 / radius 9px / `.marker` 3×24 且 `left` 在按钮左缘 / 标签 9px·weight 400 / 图标 18px / gap 8px / 7 个入口 / 激活色 rgb(32,93,71) 与本站 `action.primary` 同值），本站改后实测：单格 51×50、标签 12px、激活条 3×24 贴色块左缘（右侧圆角声明 6px、CSS 夹到实际 3px）、块左缘距图标左缘 13px（原型 10px）、入口间距 8px。宽窗目视核对方块色块、块缘短竖线、三字名称不出块、「连接与同步」两行等长。外壳与导航的既有浏览器断言未改写；运行成绩与未覆盖范围归[功能验收表](../../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

2026-10-16 页面收纳接续：项目列表、待处理、动态及其别名只保留图标导航与内容列，近期工作栏和调宽把手不占轨；返回工作台恢复原折叠及宽度偏好。该例外只覆盖工作台交互 §17.12.1 所列路由，未推广到项目详情等页面。待处理页的请求卡片占满首行，正文与判断仅在宽窗并排；类别筛选采用既有文字按钮与激活下边线，完整事件身份收进依据，字号、颜色、留白均复用现有 token。

