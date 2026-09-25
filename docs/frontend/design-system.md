# Relay 工作台视觉与组件规范

> 2026-09-24：工作台已以 React 组件复用原 CSS 与唯一 token 源；迁移前 Vue 原件和 15 张旧页面图归档于 [M02 开发记录](../development/m02-react-migration.md)。浏览器逐页对照与真实 Windows 窗口分别记录，前者不代替后者。

状态：Proposed（从现有图提炼的实现基线）。更新：2026-09-24。

本文只拥有视觉、布局、组件外观与可访问性交互规则。用户已确认 Windows 可安装桌面应用，宿主边界见 [ADR-007](../decisions/ADR-007-windows-desktop.md)。页面路由、业务状态、权限和命令仍以[工作台交互](workbench-design.md)及其引用契约为准；技术依赖以[技术选型](../architecture/technology-selection.md)为准。数值唯一来源为 [design-tokens.json](design-tokens.json)，本文用 token 名称引用，不再维护一套色值表。当前 React 工作台保留原页面 class 与布局，真实桌面验收由 M02 整体验收记录确认。

## 1. 视觉依据与提取边界

用户指定现有设计图作为本轮依据。以[原始论文验收页](../../exec-e4781944-a9b1-4906-8cd8-994841a0c21f.png)为视觉锚点，[今日](mockups/2026-09-19/today.png)、[项目总览](mockups/2026-09-19/project-overview.png)、[开发工作台](mockups/2026-09-19/development-workbench.png)证明跨页面共性；[生成提示词](mockups/2026-09-19/prompts.md)只记录来源，不是运行规范。

![原始论文验收页视觉依据](../../exec-e4781944-a9b1-4906-8cd8-994841a0c21f.png)

| 可观察依据 | 规范化处理 |
|---|---|
| 暖白主画布、略深暖灰侧栏、近白文档区域 | 使用 canvas / navigation / surface 三层语义背景；普通内容不逐块套卡片 |
| 墨绿主按钮、细绿色激活线、少量浅绿选中区域 | 一个主操作色；激活同时有文字/位置/线条，不能仅换颜色 |
| 宋体或明朝体大标题、清楚的界面文字、等宽 diff | editorial / ui / code 三类用途；无法从图片确认实际字体名 |
| 细分隔线、近直角小圆角、大块留白 | 默认无阴影；阴影仅用于浮层，不复制生成图的纹理或渐变噪声 |
| 左导航、顶部上下文、中央工作区、右侧判断/上下文 | 统一页壳；右区内容由页面任务决定，不叠加第二条 AI 侧栏 |
| 状态、模式、执行者与版本并列可见 | 它们是独立事实字段，不能压成一枚“AI 处理中”标签 |

提取分三类：**图像依据**是上表的稳定视觉特征；**归一推荐值**是 token 内的颜色和桌面尺度；**补充规则**是图中未展示的 hover/focus、错误、断点、动效和键盘行为。后两类均待真实页面验证，不称为原图测量真值。

采样方法：四张图按原始像素读取 RGB，在侧栏 (120,700)–(180,760)、画布 (800,75)–(1000,90) 的空白区域取通道中位数。原图与生成图的背景略有漂移，因此统一为 tokens 中的平面颜色。大多数图为 1487×1058，项目总览为 1486×1058；这是图像像素尺寸，不是桌面 WebView 的 CSS 缩放/DPR 证据。布局约 203px 侧栏、65px 顶栏仅作归一参考。

图片里的“Workflow OS”、Rust 片段、日期、用户项目和通过结果均为示例。仓库名称 Relay 不意味着本轮已决定改图中品牌标识；最终产品显示名待确认，不影响本规范的样式定义。

Windows 桌面宿主当前图标来自用户提供的 [B 任务卡片素材包](../../tauri_icons_B_taskcards/src-tauri/icons/icon.png)。产品 [PNG](../../apps/desktop/src-tauri/icons/icon.png)与素材包原文件一致；[ICO](../../apps/desktop/src-tauri/icons/icon.ico)保留素材包十层各自的原始图像，只将 256px 层移到首层，以供锁定的 Tauri Windows 默认窗口图标解码。ICO 仍由 Tauri bundle 配置引用，图形只作为品牌视觉，不额外定义业务状态或交互语义。此前机器人母版、中央裁切和透明圆角的处理属于 [2026-09-24 图标历史](../development/m02-desktop-foundation.md#2026-09-24-windows-图标小尺寸修复)，不再描述当前图标来源。

## 2. Token 规则

token 文件使用本项目简单扁平结构：metadata 保存版本/状态/来源，tokens 保存命名值，contrastChecks 保存需要验证的前景/背景组合。不声明遵循某一外部 token 交换标准，也不引入主题构建工具。

- 基础值：color.palette.*、space.*、font.* 等。
- 语义值：color.bg.*、color.text.*、color.action.*、color.status.* 等，只能引用基础色或明确的语义别名。
- 可复用尺度：layout.*、control.*、radius.*、focus.*、zIndex.*、motion.*。
- 组件消费语义 token，不在页面上复制色值。文字链接用 action.text，不能因主按钮同色就把链接和按钮行为合并。
- 别名写作 {color.palette.forest}；检查器必须发现悬空、循环及类型不匹配。
- 未来 CSS 映射使用 --relay-color-bg-canvas 这类名称，按点转短横线；当前不生成或宣称已有 CSS/Tailwind 接入。

本轮只定义 light。没有暗色参考，不自动创建深色主题或主题切换按钮；保留语义命名使未来可以扩展。色值变更只改 JSON；用途和组件规则改变才改本文。token 改名/删除时查所有消费者并记录迁移，不维护多个“最终版”文件。

## 3. 色彩与状态

| 用途 | token | 使用限制 |
|---|---|---|
| 应用画布 / 导航 / 文档内容 | color.bg.canvas / navigation / surface | 右区与主画布同底，不做独立深色 IDE |
| 标题 / 正文 / 辅助信息 | color.text.primary / secondary / muted | 版本、错误解释和证据不因“次要”变为不可读 |
| 主操作及 hover / pressed | color.action.primary / hover / pressed | 文本固定 onAction；避免 hover 放大或跳位 |
| 当前导航/版本/行 | color.selection.bg / text | 配合激活线、勾选或当前标记；hover 与 selected 分开 |
| 装饰分隔线 / 表单边界 | color.border.separator / control | 浅分隔线不能承担唯一控件边界；输入框使用 control |
| 成功 / 警告 / 危险 / 中性 | color.status.*.text / bg | 同时有文字和图标；警告与危险为原图未覆盖的补充 |
| 增行 / 删行 | color.diff.add.* / remove.* | 保留 + / − 和行号，正文用 primary；不单靠红绿辨认 |
| 焦点 | color.focus.ring + focus.width / offset | 与 selected 边框不同，不能仅靠背景变化 |

成功色表达“这一条检查通过”，不推导 Task 完成。待审批用中性状态配明确动作，UNKNOWN 使用警告和核对说明；失败用危险色。暂停/正在停止/待核对的文案及允许操作由工作台契约决定，视觉组件不能自行映射业务状态机。

禁用状态使用 disabled.bg / text 并提供可见原因；本规范仍对禁用说明保持可读性，不通过整块 opacity 让文字和边框一起淡掉。

## 4. 字体与排版

| 角色 | 尺寸 / 行高 token | 字体 / 字重 | 用法 |
|---|---|---|---|
| 今日主标题 | font.size.display / font.lineHeight.heading | editorial / semibold | 仅一个顶级主标题，允许换行 |
| 普通页面标题 | font.size.page / heading | editorial / semibold | 项目名、验收标题、变更审查标题 |
| 窄屏页面标题 | font.size.compactPage / heading | editorial / semibold | 不把整页缩放来容纳桌面标题 |
| 区域标题 | font.size.section / heading | editorial / semibold | 今日焦点、项目状态、等待判断 |
| 行标题 | font.size.rowTitle / ui | editorial 或 ui / medium | 任务/产物名称，长名换行 |
| 控件与业务正文 | font.size.body / ui | ui / regular 或 medium | 按钮、导航、状态、字段 |
| 辅助信息 | font.size.meta / ui | ui / regular | 时间、来源、版本；不能承担长正文 |
| 长文阅读 | font.size.reading / reading | editorial / regular | 论文/Markdown 阅读内容；编辑输入保持清晰 |
| 代码与 diff | font.size.meta / code | code / regular | 保留等宽与可复制文本；不使用图片充当代码 |

字体栈是推荐回退，图中字体不可反推出精确 font-family。优先本机可用字体；若要随应用分发字体，先核验许可和实际字符覆盖。无衬线用于交互，宋体用于阅读与标题；不要把宋体扩散到全部小字号元数据。不得假定所有回退字体都具备 semibold，实装需检查字重、行高及中文标点。

尺寸采用 rem，默认字号变化时同步缩放。中文正文不加夸张字间距；时间/计数可用等宽数字。主体文字禁止固定高度裁切；面包屑可截断中间层，但当前任务名必须有可见完整入口。阅读宽度受 layout.reading.maxWidth 限制，超宽显示器不拉长整行文章。

## 5. 间距、页壳与桌面窗口适配

现有图定义应用客户区，不包含 Windows 原生标题栏。首版推荐保留系统标题栏及最小化/最大化/关闭按钮；图中的应用顶栏继续承载面包屑等内容，不与系统按钮混排，不把操作区设为拖动区。窗口启动/关闭交互按[部署设计](../deployment/local-deployment.md)，不新增托盘或多窗口。

window.content.initialWidth/initialHeight 与 minWidth/minHeight 为客户区逻辑 DIP 推荐值；不按截图像素设置窗口。首次打开和恢复窗口位置时，依据当前显示器工作区扣除系统边框/标题栏后限制尺寸和位置；工作区小于推荐最小值时允许继续收缩，避免窗口伸出屏幕。DIP 与 CSS px/rem 分开处理，不手工重复乘 Windows 缩放倍数。

沿用图中的疏朗密度，以 space.* 形成 4px 基础、8px 主节奏。文字与图标用小间距；字段内关系、列表行和区域之间按层级增大；不为每一个偏移增加 token。

| 区域 | 尺度引用 | 规则 |
|---|---|---|
| 左导航 | layout.sidebar.width / control.nav.height | 暖灰背景、底部连接与设置；长页面可滚动，不挤压底部项 |
| 顶栏 | layout.header.height | 面包屑、视图切换、日期按可用宽度排列；日期不阻塞主要操作 |
| 中央工作区 | layout.main.padding / layout.section.gap | 对齐统一左边线；区块用留白和细线分组 |
| 右判断区 | layout.rail.width / narrowWidth | 左侧细分隔线；有独立标题、证据、范围及操作；内容滚动可达 |
| 内容上限 | layout.content.maxWidth | 超宽屏限制工作区总宽度，避免按钮远离对象 |
| 阅读区域 | layout.reading.maxWidth | 文档内可有自己的标题节奏，不套多层卡片 |

| 桌面客户区的 CSS 视口范围 | 页壳行为 |
|---|---|
| ≥ breakpoint.wide | 完整侧栏 + 中央内容 +标准右区；接近原图比例 |
| breakpoint.rail 至 wide | 完整侧栏 + 中央内容 +窄右区 |
| breakpoint.large 至 rail | 完整侧栏；右区由明确“查看待审/上下文”按钮打开，不挤窄正文 |
| breakpoint.medium 至 large | 导航收为 compactWidth；必须可展开文字并提供可访问名称；右区按需打开 |
| < breakpoint.medium | 左导航抽屉；内容单列；右区按需全宽面板/对话框，保留目标与返回入口 |

抽屉不互相叠开；打开时按组件规则管理焦点。原图右区底部操作不得用绝对定位压住内容；采用正常流或带内容留白的 sticky 区，窗口缩小或字号放大时仍能滚到操作。正文不产生全页横向滚动，diff/宽表允许局部横向滚动并保留键盘访问。窄窗口内边距使用 layout.main.smallPadding。

断点是桌面窄窗口、文字缩放和高 DPI 下的补充适配规则，不代表手机端交付。验收覆盖推荐初始/最小客户区、最大化/还原、较小显示器工作区、100%/125%/150%/200% Windows 缩放与跨不同 DPI 显示器移动。另在 200% 内容缩放下检查重排；记录实际 DIP、CSS 视口与 DPR，不只记录截图分辨率。

## 6. 可复用组件规则

只规范已有图和首条工作流需要的组件，不创建通用页面编辑器或整套组件代码。

| 组件/组合 | 外观及 token | 状态与交互 |
|---|---|---|
| AppShell / NavigationItem | navigation 底、ui 字体、control.nav.height；当前项有色块/竖线 | 路由链接使用 aria-current；hover、focus、current 分开；待审计数来自真实查询 |
| Breadcrumb / ViewTabs | 细字与绿色底线，无大块 pill | 导航使用链接；同页 Tab 才使用 tablist/tab/tabpanel 及方向键，不给路由伪装 Tab 语义 |
| Button / TextAction | height 或 prominent，control 圆角；主要实心、次要描边或文字 | 默认/hover/pressed/focus/disabled/loading 全部定义；文字动作保留可辨认链接样式 |
| TextField / Textarea | surface 底、control 边界、ui 字体 | 可见 label；required/错误说明与字段关联；不以 placeholder 代替标签；保留用户草稿 |
| StatusLabel / MetadataRow | 轻量文字+图标，badge 圆角；不把普通标签做成按钮 | Task 状态、执行模式、执行者分别渲染；状态代码不由颜色决定 |
| VersionSelector | 当前版本细绿边框/浅绿底，其余低强调 | “当前选用”“最新”“本轮接受”分别呈现；点击查看不等于接受 |
| TaskRow / ArtifactRow | 行式布局、separator、row.minHeight | 主名称可打开，独立动作有独立焦点；不嵌套可点击按钮；长名称换行 |
| EvidenceItem / CheckResult | 来源卡仅一层轻边框；检查行用图标+文字+证据链接 | 真实绑定版本可见；结果不确定时不显示绿勾；来源失效明确说明 |
| ReviewPanel | rail + prominent 主按钮；前置展示版本、证据、范围 | “接受产物”“批准动作”“接手编辑”分开；过期或无权限不能继续提交 |
| DiffView | surface、code 字体、行号和增删背景 | 文件树与 diff 分区；局部滚动；仅接受隔离变化集不能表述成已写回/commit |
| Dialog / Drawer / Menu | panel 圆角、floating 阴影仅浮层、相应 zIndex | 有标题/关闭按钮；模态焦点限制与返回触发点；Esc 不丢弃未保存输入 |
| FeedbackRegion | 就地描述错误、空态、加载和待核对 | 保存/恢复重要反馈持续存在；toast 仅辅助，不能承载唯一证据或审批结果 |

主操作在一个任务决策区内保持一个；次要动作低强调，危险动作用明确动词与目标。不得因为原图只有一个绿色按钮，就把所有决定复用成“继续”。loading 保持按钮宽度，说明“保存中”或“正在核对”；长后台 Run 不将整个页面锁死。提交禁止重复触发，但重试/回执行为仍按应用契约。

### 组件状态补充

- 空态：说明没有什么、为什么以及下一步；无模型连接仍可人工工作。
- 错误：就近提供原因与可行操作；权限/过期冲突不是通用“网络错误”。
- 版本冲突：保留草稿，展示当前版本和差异入口，不用 toast 后自动覆盖。
- 待核对：持续展示不确定范围，禁用可能重复副作用的动作。
- 加载：首次读取可用静态 skeleton 或文字；刷新保留已知内容并标识更新，禁止假进度。
- 浮层：使用单一层级表，focus ring 不被 overflow 裁掉；popover 不盖过 modal。

## 7. 可访问性与动效

按本项目验收目标，普通文字组合至少 4.5:1；关键非文本控件边界和焦点相对相邻背景至少 3:1。装饰分隔线不承担控件识别职责；选中色块仍保留文字/图标/激活线。当前 JSON 检查只验证预设纯色组合，不等于页面符合 WCAG。[文字对比度](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)、[非文本对比度](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)。

独立交互目标最低使用 control.target.minimum；需要更宽松点击区的桌面控件使用 control.height.comfort 或更大。正文内链接可以保留文本布局，其他小图标扩展实际点击区。较大的点击区是产品选择，不将 44px 误写成 WCAG 2.2 AA 的通用强制值。[目标尺寸说明](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)。

Tab 顺序遵循视觉/文档顺序，提供跳到主内容入口；图标按钮有可访问名称。只有真正的同页 Tab 使用相应键盘模式，导航仍为链接。[Tabs 模式](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/)。

hover/focus 的颜色过渡用 motion.duration.fast；抽屉/面板用 panel；不使用弹簧、循环装饰动画或大位移。prefers-reduced-motion 时使用 reduced，进度仍可用静态文本表达。流式输出不逐 token 触发 aria-live 播报；只播报开始、需要处理、结束等有意义节点。

## 8. 验证与交付边界

现在可验证：token JSON 可解析、引用无环、定义的纯色组合达到其阈值、文档链接有效。命令见[文档入口](../README.md#5-轻量检查)。

后续 UI 必验：

1. 原图桌面比例和三页共享样式一致；不复制示例通过状态、日期或 Rust 代码作为真实事实。
2. 上述桌面窗口及系统/内容缩放下，标题/长中文/版本说明不遮挡，关键操作与焦点可达；跨屏恢复不出现屏外窗口，原生标题栏可操作。
3. 按钮、表单、Tab、弹窗、加载、冲突、UNKNOWN 和审批过期具备可测试状态。
4. 实际桌面 WebView 字体、背景、hover/focus、透明层和 disabled 的对比度重新检查；中文输入法组合输入、键盘与 Windows 辅助技术实测，快捷键不截断输入法输入或系统操作。
5. 所有颜色通过语义 token 引用，布局尺度无无依据硬编码；必要局部值写明用途，避免无限扩张 token。

未完成项：桌面 WebView 排版与字体字重校验、组件实现、窗口/DPI 验证、页面截图对照及完整可访问性检查。技术栈冻结、API/DB 与业务验收状态不因本文完成而变化。
