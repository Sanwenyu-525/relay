# 视觉与组件规范：分册 06

角色：所属专题的唯一正文分册；2026-10-25 按原章节迁移，不改变原业务规则、日期、状态与证据范围。

[返回专题路由](../design-system.md) · [文档总入口](../../README.md)

按需读取本分册内的相关小节；跨章节约束沿链接核对，不能把本分册或历史措辞单独当作完整实现/验收结论。正文中的源码与命令路径沿用原有口径。

### 9.16 模型选择器：触发器显名与清单只显名（2026-10-17）

2026-10-17 用户两轮指令：清单每项只显示一个模型名，细节悬停可见；下拉（触发器）显示具体模型名，不再只是「图标 + 模型」二字；形态是锚定在触发键上方的**下拉**，不是居中弹窗。交互契约归[工作台 §27.5](../workbench-design/part-09.md#275-免费模型分组与模型选择)。**token 零新增**，沿用既有数值与浮层语言。

**触发器**：仍是 `.agent-chat-tool` 几何（透明底、`control.height.compact`、`radius.control`、`font.size.meta` + medium），文字换成当前具体模型名，长名以省略号收在 chip 内（`flex: none` + `max-width: 100%`，名称 span 承担省略），完整名与「首选模型」语义挂 `title`；未选择时显示占位「模型」。不再渲染 Sparkles 图标，模型名本身是主角；原生 `select` 也一并去掉（它无法做「只显名 + 悬停细节」）。

**下拉弹层**（`.model-selector-menu`）：与输入框「+」菜单 `.agent-chat-attach-menu` 同一套浮层语言——`position: absolute` 向上锚定 `bottom: calc(100% + space.2)`、`zIndex.popover`、`radius.panel`、`border.separator`、`shadow.floating`、`space.2` 内边距、`width: max-content` 收缩到内容、上限 `min(22rem, 100vw - space.6)`。弹层内部按「状态行 → 筛选 → 清单 → 同步脚注 → 有界接续说明」纵向排列，行间距 `space.1`；状态行与筛选说明用 `font.size.meta` + `color.text.muted`，底部两段脚注（同步状态、有界接续说明）用 `font.size.caption` + `lineHeight.snug`（与「+」菜单空态同档，见 §9.14）；「立即刷新／重新读取」是同一行右侧的次级小按钮（`radius.control`、`border.separator`、`control.height.compact`），不额外起卡片。**清单本身**（`.model-selector-list` / `.model-selector-option`）：`border.separator` + `radius.control` + `space.1` 内边距，高度上限 `min(24dvh, 18rem)` 内部滚动。条目为 `control.height.compact` 单行、`font.size.body`、`radius.control`，**可见文本只有模型名**；当前选择在行尾（`margin-left` 自动推到右缘）显示 lucide `Check`，行背景为 `color.bg.subtle`（与聊天命令菜单的选中/悬停底同一档），悬停非禁用项同底；禁用项取 `color.text.muted` + `not-allowed`。分组标题（当前选择／已配置模型／免费模型 · OpenRouter）为 `font.size.meta` + `color.text.muted`。参考图里的「倍率」那一列不做——目录单价为零是分组前提，不是每行要并排比较的指标。

**细节不放可见面**：ID、上下文窗口、工具能力与「目录已过期，仅供浏览」「调用凭据未配置」「已不在目录中」等原因写进条目的 `title`（鼠标悬停即原生提示）并重复进 `aria-label`（读屏可名）。这样「只显示名字」不牺牲核对能力；`title` 不做自绘浮层。

**整体压缩（2026-10-19 用户截图「这个模型下拉框太大了」）**：真实窗口 473×887 实测面板高 558px、占视口 62.9%（未配 OpenRouter 调用凭据时约 600px／68%），清单 `40dvh`(355px) 是最大头，底部两段脚注在 meta 档还要再占约 126px。三处收型，事实与交互一条不减：① 清单上限 `min(40dvh, layout.workspace.sideWidth)` → `min(24dvh, 18rem)`，用户窗约 6 行、常规桌面约 8-9 行即开滚（仍内部滚动，搜索框照旧）；② 同步脚注整行改 caption + snug，时间戳整块 `white-space: nowrap`——meta 档下「最近成功同步：<ISO 时间戳>」实测 268px，超出被「立即刷新」挤剩的 252px 列宽会溢到按钮上，caption 档约 230px，凭据／过期告警各占一行；③ 有界接续说明同改 caption 档并压缩文案（默认启用、触发条件、最多 3 个合格型号、绝不转收费、共享额度耗尽即停一条不删）。同窗复测 **386px／43.5%**；同步时间戳不再从连字符处断成「2026-10-／18T…」两截。量测方式：Playwright + 页面内路由夹具（不连数据库与 Provider），前后对照截图留 `apps/workbench/results/`。

**验证出口**：`apps/workbench/tests/modelSelector.spec.tsx` 七条（条目只显名＋细节在 title、失效原首选保留、过期/缺凭据禁用、Esc 回焦、搜索只筛清单、目录故障仍可明确选默认、首条直选）与 `tests/newConversationEntry.spec.ts` 的首条免费模型用例。真实 Windows 窗口与 DPI 下的省略号与悬停提示观感未验收。

### 9.17 会话行拖拽落位横线（2026-10-17）

2026-10-17 用户需求：会话行可以拖拽改位置，拖动时用一条横线表示松手后落在哪。交互与排序语义归[工作台 §28.1](../workbench-design/part-09.md#281-左栏recentworkrail)。**token 零新增**，全部沿用既有档位。

**横线是指示器，不是占位。** `.recent-work-drop-line` 画在被拖那一列（`ul.recent-work-list`，为此新增 `position: relative`）内，`position: absolute` + `inset-inline: 0` + 由落点算出的 `inset-block-start`，因此它不占网格轨道，拖拽期间整列的**布局**与行序保持原样，松手才重排——横线承诺的位置和条目真正落下的位置必须是同一处，列表先跳走就对不上了。被抓那一行的平移同样只写在 `transform` 上：布局一格没动，画面里跟着手动的是那一行的像素。

**数值全部取现有档。** 线粗 `focus.width`(2px)、圆角 `radius.round`、底色 `color.border.control`（与分组竖线、控件边界同档，不引入第三种灰）；`pointer-events: none`，它不承担点击。摆位用 `offsetTop`/`offsetHeight` 与实测 `row-gap` 换算，缝取两行之间的中线。`z-index` 上线（3）压在被拿起来的行（2）之上：这一列自己 `z-index: auto` 且无 `transform`，不成层叠上下文，行与线同属一个上下文，先后就由这两个数决定（真实浏览器按此断言，线本身 `pointer-events: none` 拿不到 hit-test，故断的是层叠规则而不是命中）。

**被抓握的那一行跟着指针走，并浮在列表之上**（2026-10-17 用户接续指认「鼠标要抓着这个 item」）。整行按「指针相对起手点走了多远」平移，位移写成内联 `transform: translateY()`，所以抓握点始终按在行的同一处——不是行在原地等指针去够它。底色仍用 `color.selection.hover`（与悬停同档，不为抓握另发明第四种灰），投影用 `shadow.floating`：这一档按 token 说明只给浮层，而此刻这一行确实是浮在列表之上的一层；它因此抬到 `z-index: 2`，画在其余行前面。光标 `grab` → `grabbing`；整段拖拽期间 `.recent-work--dragging` 关掉文字选区并收起悬停摘要卡——同一时刻这一列只出一个浮层，摘要卡压在横线上会读成两块内容。位移不加过渡：加了就变成拖着尾巴，指针与行的关系反而读不准了。带起来的只有起手那一列的那一份，同一会话在另一列里的副本留在原地，等落位那一拍再滑过去。

**落位动效同样零新增 token。** 换位是一段 FLIP 位移：松手那一拍先记下每张行的顶边——被抓那一行记下的是它此刻在手里的画面位置——提交后用 Web Animations API 把差值播成 `transform: translateY()`，只碰 transform，不碰布局属性，所以整列不会因为动画再跳一次。时长与缓动取 `motion.duration.panel`(180ms) 与 `motion.easing.standard`——这是一次布局变化，与面板过渡同档，比控件悬停的 `motion.fast`(120ms) 长一档才读得清「谁搬去了哪儿」；只有真换了位的行进入动画，未动的行一个都不播。起点因此是「松手那一拍它所在的位置」而不是「它原来占的格子」：手里那一行读起来是从指间放下去的，另一列里的同一份则从旧格子滑进同一格，两处落点相同。落回原来那一格（没有换位）也走这条路，只有手里那一份滑回家，不硬跳。刚落位的那一行再留一档一次性强调：底色 `color.selection.bg`，停留 `motion.duration.emphasis`(1.2s)，与时间线跳转的落点高亮同色同时长；这里用 `bg` 而不是 `hover`，因为松手那一刻指针仍停在同一行上，hover 档会被读成「只是悬停」而不是「这就是刚放下的那条」。

**两条动效门都要走到。** 滑位由 JS 判断：`resolveMotionPreference()` 为假就不发起动画。底色强调由 CSS 判断：系统「减少动态效果」命中上面那条全局 `*` 规则把过渡时长归零，本机显式关动效走 `html[data-motion="off"]`；两条都只去掉过渡，**保留这一档静态高亮**——取消动效不等于取消落点回执（与 `ChatTimelineNav` 的落点强调同一套门）。进出是两档而不是一个数字：`transition` 只声明在标记态规则上，淡入用这里的 `motion.panel`(180ms)；属性撤掉后规则不再命中，退场回到 `.recent-work-item` 基础的 `motion.fast`(120ms)。实测过这一点（浏览器用例在强调撤掉后仍读到起始色，据此把断言改成轮询到淡出结束），文档按实际行为分开写，不合并成「一次淡出」。

**验证出口**：`apps/workbench/tests/browser/recentWorkDragLine.spec.ts` 在真实 Chromium 里量横线的缝位置（与两行之间的缝相差 ≤1.5px）、线宽等于 `focus.width`、左右铺满内容区、拖拽期间行序与**布局**不变（`offsetTop` 一格没动）、松手后行序等于横线承诺的次序；抓握那一条量的是画面：被抓的行偏下来的距离等于指针相对起手点走的距离（±1.5px，含「从第 0 格中线走到缝正中即一行半」），其余行的画面位置一格没动，整份左栏只有一行带内联位移（另一列的副本原地不动），指针那一点 `elementFromPoint` 命中的是被拿起来的这一行，而它自己的投影逐字等于 `shadow.floating`、底色逐字等于 `color.selection_hover` 解析后的值（临时探针节点把自定义属性翻成计算值再比）。动效那两条在同一浏览器里钩住 `Element.prototype.animate`，核对进入动画的只有真换位的行、位移量等于实测行距（手里那份等于「松手那一拍的偏移 − 新格子」）、参数就是 `motion.panel` 与 `motion.easing.standard`，并逐帧采样 computed `transform` 证明屏幕上确实在滑、收尾归 `none` 不留残余，强调画上后按 `motion.emphasis` 自己收掉；落回原格那一拖不写存储、不换位，但仍有且只有手里那一份播一段等于其抓握偏移的回家位移。`reducedMotion: reduce` 一档动画记录为空，但静态强调与 `transition-duration: 0s` 同时成立。参数与「只动画换位的行」另有 `apps/workbench/tests/recentWorkDrag.spec.ts` 六条在 jsdom 里守住（那里几何是自己造的，不能代替上面的实测）。`offsetTop` 在 Chromium 取整，故按缝边界放行 1.5px 而不是断言相等；**连续两拖之间必须先等滑行停住**——动画期间行的 `getBoundingClientRect` 还在半路上，照它算下一道目标缝会算出一个谁都不挨着的位置（落点数学本身不受影响，它读的是布局）。多 DPI 与真实 Windows 窗口的观感未复验。

**技术身份披露的共享档 `.tech-details`（2026-10-17，用户指认「全是文字没有 css 样式」）**：列表与消息正文里的「核对依据」类 details（Skill 来源与定义、生成依据摘要、对照目标、版本来源、已读取版本等七处；原含「模型尝试与用量」，该块已于 2026-10-19 随组件删除）此前直接吃浏览器默认样式——summary 与正文同色同重、marker 是浏览器默认三角、展开后零间距、`ol` 带默认大缩进，读起来就是一块没有样式的纯文字。收口成一档共享类：summary 取 `font.size.meta` + `text.secondary` + pointer，marker 用 `color.action.primary`，展开内容一行距，`ol/ul` 收进 `space.4` 缩进，`small` 落 `text.secondary`，`code` 块级可任意折行。零新增 token、零新增色值；常驻披露（`page-explanation` 一类带 chevron 形态）不并这一类。同轮把三处裸文本换成既有件：完成凭据的目标规格 JSON 与资料搜索的来源串改用 `hash-code`（等宽 + `bg.surface` + 任意折行），项目技能页 `run-list` 行内 meta 补「块级 + `space.2` 上距 + `text.muted`」（与恢复摘要页同档）。验证出口：`tsc --noEmit` exit0，改动触及组件的既有套件（completionRecord、knowledge、taskSkillProposal、connectionsSettings、learningRecords）全绿；视觉观感在真实窗口未复验。2026-10-21 新增一个消费方：协作页 AI 消息下的过程折叠面板 `session-round-trace`（[工作台 §18.10](../workbench-design.md)）直接沿这一档，只在行内补工具名、目标 `hash-code` 与状态文字，状态色取既有 `color.status.warning.text`（未结算／被拒／未知）与 `text.secondary`（已结算），零新增 token、零新增色值。

### 9.18 收件箱页结构（2026-10-18）

用户以 Relay V5.11 原型收件箱页（文件名 `Relay_V5.11_基于V5.10增量_全页面可访问版.html`，位于本机下载目录、不在仓库内，故以文本引用；同原型的通知/回执数据是演示数据，不进入本仓）发起收件箱页改造，选择「跟随原型版式」。本轮只改 `/tasks?tab=inbox`（`/inbox` 别名）的**呈现结构**：收件箱仍只收未归属项目的人工任务，数据来源（fixture 示例 / live `GET /tasks?inbox=true` 游标分页）、筛选口径、范围校验、命令与路由语义全部不变。页面样式全部写进页面私有 [`views/InboxView.css`](../../../apps/workbench/src/views/InboxView.css)，`TasksView.tsx` 只把收件箱范围委托给新的 `InboxView`，`styles.css` 未改动；业务交互归[工作台 §28.9](../workbench-design/part-10.md#289-收件箱页按-v511-原型改版2026-10-18)。

| 区域 | 规则 | 备注 |
|---|---|---|
| 页头 | kicker（`action.text` + `font.size.caption` + 0.08em 字距 + 大写）+ h1（`font.size.compactPage`）+ 说明句（`text.secondary` + `font.size.meta`）；右侧「轻量起步 / 新建任务」两个既有入口 | 不用共享 `PageHeader`（它没有 kicker 位）；h1 字号与项目列表页同档 |
| 范围页签 | 全部 / 收件箱 / 人工待处理，沿用全局 `.subnav` 路由链接与 `aria-current` | 三个范围是路由，不是同页 Tab（§6）；收件箱页保留它，否则从收件箱无法回到另两个范围 |
| 状态统计卡 | 三张等宽卡（`auto-fit minmax(min(100%, 11rem), 1fr)`）：待整理 / 可开始 / 阻塞；`bg.surface` + `separator` 边 + `radius.panel`，数值 `font.size.rowTitle` + `bold` + 等宽数字 | 计数只覆盖**当前显示**的任务，不把已加载或首页称作全量；这三个桶之外的状态只进列表 |
| 筛选工具栏 | 沿用全局 `.list-toolbar--compact`：刷新（live）、状态、执行模式、搜索；fixture 另有一个**停用**的项目筛选，明说「本范围不按项目筛」 | 控件名与既有测试锚点不变 |
| 任务卡片 | `bg.surface` + `separator` 边 + `radius.panel`；卡头「收件箱任务 + N 条」，卡体 `bg.subtle` 底 | 卡体与卡头不同底，是把「行区」与「纸面」分开，不是表格 |
| 任务行 | 整行一个链接（`task-row-<id>` → `/tasks/<id>`）：行首 34px 状态色块（与 `StatusChip` 同一套图标与语气）+ 标题（单行截断）+ 事实行 + 等待/阻塞原因 + 右侧箭头 | 行内不再放「打开」按钮——整行即链接，同目标按钮是重复交互；状态同时以图标、颜色与文字出现，不靠颜色单独承载语义 |
| 待整理行底色 | 仅 `INBOX` 状态行用 `selection.bg` 浅绿底，对应原型「未读」行 | 语义是「还没有人工过目」；其余状态保持纸面 |
| 计数与加载更多 | 卡片下方一行：左 `list-count-note`（已加载/当前筛选/后续页），右「加载更多」 | live 口径与原实现逐字一致 |
| 范围说明 | 卡片与页脚注释之后用共享 `.page-explanation` 折叠块，替代原常驻右栏 | 宽屏不再有右栏（与 §9.7 项目页一致）；页脚「三个独立事实」注释保留 |

三种空态仍分开：范围自身为空（`inbox-empty`）、筛选无匹配（`inbox-no-match` / `inbox-live-no-match`）、live 已加载无匹配（含「后续页可能仍有匹配任务」）。**本轮零新增色值、字号、圆角与动效数值**；`data-testid` 与筛选控件名全部沿用，`liveInbox` / `liveTasks` / `liveWorkspaceLists` / `listViewCopy` / `tasks` 等既有套件全绿。验证出口与未覆盖范围归[功能验收表](../../testing/overall-acceptance-2026-09-28.md#当前功能验收表)；真实 Windows WebView2 的字体、DPI 与辅助技术仍需单独验收。

### 9.19 更换目录浮层：紧凑锚定（2026-10-18）

用户贴出「更换工作目录」大弹窗与一张紧凑参考菜单，指令「弹窗太大了，像这样就好了，一部分是最近的工作区，一部分是打开文件夹」。对象与命令 Owner 未动（归[工作台 §28.3](../workbench-design/part-10.md#283-文件夹作用域细条folderscopebar)），本轮只改呈现。**token 零新增**，外壳与「+」菜单、模型下拉同一套浮层语言（§9.14、§9.16）。

| 项 | 改前（`AppDialog size="lg"`） | 改后（`.folder-scope-pop`） |
|---|---|---|
| 形态 | 40rem（实测 ≈640px）居中模态 + 全屏遮罩 + 标题副标题 | 锚在目录名上方的非模态浮层，无遮罩、无标题带 |
| 宽度 | 640px | `min(15rem, 100%)`＝240px（2026-10-18 首版 18rem，2026-10-24 用户截图指令「宽度要减小一点」再收） |
| 高度 | 由内容撑开，短窗口下超出可视区 | `max-height: min(52vh, 26rem)`，超出在面板内滚动 |
| 条目 | 两列并排按钮 + 候选独立描边框 | 每条一行（`control.height.compact`＝32px），近期目录 → 分隔线 → 动作行 → 手动路径／候选单列排布 |
| 解释文字 | 常驻可见 | 移出可见面，只挂 `title`（与 §9.16「细节不放可见面」同一条规则） |

**高度档不是审美值。** 浮层锚在 `.folder-strip`（为此新增 `position: relative`）内向上弹出，而 `.collab-center { overflow: hidden }` 会裁掉越界的浮层：1280×620 取「+」菜单那档 `60vh` 时，多项目候选态上缘被裁 5px（面板 top 52 < 容器 top 57），收到 `52vh` 后实测 top 101.6、未裁、候选态内部滚动。桌面档（有原生选择器，无手动路径块）实测 251.5px，浏览器档（手动绝对路径块常驻）390.5px，均未触顶。

**面板必须自己声明正文色。** 它是 `.folder-strip[data-state="warning"]` 的子节点，而细条的告警态把 `status.warning.text` 传给整行——不写 `color: color.text.primary` 时浮层里的「新对话」会跟着变琥珀（实机截图抓到）。告警色只属于那一行状态文字，不外铺到浮在它之上的选择面。

**收缩优先级写在一条规则里。** 近期目录行＝图标 + 名称 + 路径/状态提示，此前两项等比收缩，名字先被省略、路径反而占位。改为 `.folder-scope-row-hint { flex: 0 3 auto }`（名称仍是 `flex: 0 1 auto`）：空间不足时先挤路径，目录名尽量留全，完整 `canonicalRoot` 在 `title`。

**关法与焦点沿用既有收口**：点外面、Esc、别的浮层打开时独占都由 [lib/popoverMenu.ts](../../../apps/workbench/src/lib/popoverMenu.ts) 的 `useMenuDismiss` 提供，与「+」菜单、权限芯片一致；打开把焦点交给面板（`role="dialog" tabindex="-1"`），关闭还给触发它的那颗目录名键。因为触发器仍声明 `aria-haspopup="dialog"`，面板继续用 `role="dialog"` + `aria-label="更换工作目录"`，按对话框身份查询的既有断言不需要改写，但它不再是模态框。

**2026-10-24 用户截图指令（已实施）：宽度再收 + 路径提示居中。** 浮层宽度 `18rem → 15rem`——本轮浮层内容只剩目录名与「打开文件夹／新对话」两行动作行，18rem 右侧留着一片空底；15rem 下最长条目（候选行的项目标题）仍单行可读，超长仍走省略号。同轮把 `usePathTooltip` 的浮出位置改为**水平居中于锚点**（此前左缘贴锚点左缘，锚点是窄元素——目录名按钮、24px 用量圆环——时整块提示偏右，读起来不指着谁）；居中后仍夹在视口内，路径宽于视口时限位规则优先，不溢出左右边缘。两处都只动呈现数值与坐标，命令、收齐行为与既有测试锚点未动。

**验证出口**：`tests/folderFirstConversation.spec.ts` 新增三条结构断言（浮层挂在细条内、`.dialog-backdrop` 不存在、Esc 后面板卸载）；`tsc --noEmit` 与目录相关 jsdom 套件 43/43；真实 Chromium 的窄窗流程由 `tests/browser/narrowWindowNewConversation.spec.ts`「从已打开目录」一条覆盖（打开→填手动路径→关闭→重开→读就绪说明→遮罩归零）。**遗留**：`styles.css` 的 `.dialog-panel--lg` 与 `AppDialog` 的 `size="lg"` 本轮后没有消费者，因 `styles.css` 正在被并行编辑而未删。真实 Windows 窗口与 DPI 下的观感未验收。

### 9.20 历史消息内容块：一档可复制文本块与两档标签（2026-10-19）

协作页历史消息里同时出现普通文字、代码 fence、命令/工具回执、文件编辑行与调用统计，此前各自为政（朴素 `pre`、「·」串、纯文字行）。本轮收成**一档共享块 + 两档同族标签**，产品口径归[工作台 §38](../workbench-design/part-13.md#38-历史消息内容块的呈现2026-10-19)。

| 件 | 形态 | 取值 |
|---|---|---|
| `.msg-code`（可复制文本块） | 细线外框 + 顶行 + 滚动正文 | `border.separator` + `bg.subtle` + `radius.control`；顶行 `control.height.compact` 高、caption 档、`text.muted`；正文 `font.family.code` + `font.size.meta` + `lineHeight.code`，`max-height: 18rem` 块内滚动，`pre-wrap` + `overflow-wrap: anywhere` |
| `.msg-code-label` | 顶行左侧等宽来源标签 | `font.family.code`，过长只省略它自己（`ellipsis`），不挤走复制键 |
| `.msg-code-copy` | 顶行右侧图标键 | `.icon-button` 基座 + compact 尺寸；常态 75% 不透明度，hover/focus 满；成功一瞬换 `action.primary` 与对勾图标，**无位移、无放大** |
| `.execution-count`（调用统计标签） | 细线徽牌 | `radius.badge` + caption 档 + 等宽数字 + `text.secondary`；与「预览」标签同族 |
| `.local-file-diff`（文件编辑行） | 行即一条记录 | `radius.control` 内边距、路径与数字等宽、图标用 lucide `FilePen`（不再用手写 `✎` 字符）；行不交互，故无悬停底色 |

三条规则：①**复制反馈只以可读名与图标表达**——消息流里任何位移都会推走正文，因此不做弹出、不做动画位移，2.4s 自行还原；②**顶行恒定在场**——没有来源标签时这一行只剩右端一枚复制键，复制入口不因缺标签消失；③**零新增 token 与色值**——全部取自既有 `--relay-*` 档位，视觉权威仍是本文件与 `design-tokens.json`。

`prefers-reduced-motion: reduce` 下不变量：仅有的过渡（复制键不透明度）置 `transition: none`，状态与图标照常切换。

**第二轮（同日深夜）新增的同族件**：来源条状态徽牌 `.assist-source-state`、候选卡状态徽牌 `.assist-candidate-state` 与调用统计徽牌 `.execution-count` 同一档（细线 + `radius.badge` + caption 档），其中「等待你批准」与候选卡 PENDING 用 `--relay-color-status-warning-text` 琥珀档——这是消息流里仅有的两处状态强调，其余一律中性。来源条展开区改为行式排版（引用主文字、reason muted），「生成中草稿」收进 `.assist-draft` 浅底块（`bg.subtle` + `radius.control`，caption 说明行置顶，正文仍纯文本）；取值见[工作台 §38 第二轮](../workbench-design/part-13.md#38-历史消息内容块的呈现2026-10-19)。

### 9.21 左栏会话行的 ⋯ 虚化底与行宽收口（2026-10-24）

用户两张截图，同一处 ⋯ 的两面：宽栏「会话名称过长时，鼠标悬停的更多菜单按钮会和名称重合」；窄栏「这种宽度就看不到更多菜单按钮了」。两处都是几何本身的结果，不是浮层错位。交互契约不变（仍是[工作台 §28.1](../workbench-design/part-09.md#281-左栏recentworkrail)里那一个触发器与同一个面板）。

**① 重合**：行按钮的左右内边距与 ⋯ 的 `inset-inline-end` 同为 `space.2`，而 ⋯ 是 32px 见方的绝对定位控件——标题盒的右缘就落在行右缘内 8px，⋯ 覆盖的正是标题盒最后 32px；标题一长，尾字必然压在这块区域下面。

**② ⋯ 跑出栏外**：行是 grid 项，`min-width: auto` 让它的最小宽等于整段标题的自然宽（`.recent-work-title` 上的 `min-width: 0` 只管 flex 收缩，拦不住 grid 的自动最小尺寸），于是长标题把行撑得比栏还宽——标题被栏的 overflow 齐头切掉（不出现省略号），⋯ 被推到栏外、悬停也看不见。1280px 视口、栏 205px 下实测一条 40 字标题把整列行宽撑到 566px。修法是给 `.recent-work-row` 补 `min-width: 0`：轨道按栏宽定尺，标题回到设计里的「单行 + 省略号」，⋯ 留在栏内。**不改行高、不改标题字号**；窄档标题可用宽本来就是这个值（栏 176px 下约 110px），因此 160px 拖拽档的可读基线不受影响。

**①的修法：不动几何，只加一层"虚化底"。** 悬停时若收窄标题可用宽，长标题会在指针落下的那一刻重新截断、整列文字跟着跳，所以行宽与行高都不变；改画在触发器的 `::before` 上，两层共用同一条从左透明的渐变：

| 件 | 取值 | 理由 |
|---|---|---|
| `backdrop-filter` | `blur(4px)` | 把压过来的标题糊掉，图标落在柔和的灰雾上而不是字上 |
| 底色 | `linear-gradient(to right, transparent, color-mix(in srgb, color.bg.subtle 78%, transparent) 62%)` | 右半段再压一档对比度；左端全透明，读起来只是「标题在右端淡出」 |
| `mask-image` | 与底色同一条斜坡（`transparent → #000 62%`） | 让 blur 的边界跟着淡出，不在标题中间留「清晰／糊掉」的硬边 |
| 横向范围 | `inset-inline: -space.2 0` | 向左多铺一档，渐变才有地方淡出（覆盖范围 40px） |
| 纵向范围 | `inset-block: space.1` | 触发器 32px 高而行只有 `control.target.minimum`(24px)，不内缩会上下各溢出 4px、糊到相邻行 |

**⋯ 自己仍是透明的**（2026-10-16 用户否掉的是「⋯ 自带色块」）。这层画在「背后」：底色是渐变的、左端透明，不是又一块实心底；`trigger` 的 `background-color` 仍是 `transparent`，浏览器用例逐字守着。图标压在 `::before` 之上靠的是给 `.recent-work-row-trigger > svg` 补的 `position: relative`——非定位的行内内容会被绝对定位的 `::before` 盖住（第一版就这样把 ⋯ 糊没了）。

**数值来源与待验证**：`blur(4px)`、78%、62% 三档不是 token（token 里没有模糊半径与混色比例这一族），按「够糊掉 14px 标题、又不读成一块浅色方片」现场定档；真实 Windows 窗口与多 DPI 下的观感待复核，若后续要做成全站一致的浮层语言，应升级为 `blur.*` 与 `overlay.*` 两个 token 族而不是继续散写。

**两档已知的观感代价**（都来自「不预留 ⋯ 的位置」这个选择，留位会让窄档标题再少 3 个字）：截断的省略号会被虚化底淡掉，读起来是「文字在右端淡出」而不是一个清晰的「…」；标题长度刚好停在 ⋯ 覆盖区时（例如栏 205px 下 14 字标题），最后一个字会被图标压住一部分，只是被虚化压低了对比度、不再抢读。

**验证出口**：`apps/workbench/tests/browser/recentWorkRailDensity.spec.ts` 的「长标题压在 ⋯ 下面时虚化底盖住尾字，栏收窄后 ⋯ 仍留在栏内」一条，在真实 Chromium 里分两段——宽栏段（17rem）量虚化底的 `blur`／渐变／遮罩三条计算值、横向覆盖余量与纵向不越出行盒，并用同一块触发器区域「有／无虚化底」两张截图的亮度标准差下降证明字确实被糊掉；窄栏段（11rem）量行不越出滚动内容盒、`scrollLeft` 为 0、标题真的收成省略号、⋯ 整个落在栏内且看得见的文字右缘仍在它底下。截图 `apps/workbench/results/rail-title-veil.png`（17rem）与 `rail-title-veil-narrow.png`（11rem）。

### 9.22 内置插件图标与输入器插件标识（2026-10-25）

用户提供一张 3×2 薄荷绿图标源图（深色描边 + 圆角几何），要求插件不再只有纯文字标识。本轮只做**图标资源与展示层接入**：插件的业务能力、运行时、Gateway、权限与数据库一律不动。

**资源组织**：六枚图标切自同一张源图，落在 `apps/workbench/src/assets/plugin-icons/`（`computer` / `browser` / `github` / `files` / `knowledge` / `automation`，各一枚 256×256 RGBA PNG，约 29–39KB）。导出口径：按 3×2 等分切格 → 泛洪去除与画布边缘连通的近白（保住书页、屏幕等封闭白）→ 连通域去噪（删孤点、补针孔）→ 高斯柔化 alpha 得到约 1.5px 抗锯齿过渡带 → 六枚共用同一全局缩放系数（源图六格墨迹面积本就一致，单系数即忠实还原其视觉重量配比）居中落布。透明背景、四角与最外圈全透明、16px 下六枚均可辨。经 Vite ESM 导入，开发与生产构建同一条解析链（生产产物为带哈希的独立 PNG）。

**组件**：`components/PluginIcon.tsx` 只做「稳定插件 key → 静态资源」的映射与渲染，**不引入图标库、状态管理或第二套 token**。尺寸经 CSS 变量 `--plugin-icon-size` 下发，默认 `font.size.body`；消费方用既有 token 覆盖（菜单行、输入器芯片与消息标识都落 `font.size.body`，第二轮曾把输入器图标降到 meta，实测与 2026-10-25 那条「14px 太小」的指认冲突，已改回）。图标是装饰：默认 `alt=""` + `aria-hidden`，可访问名称由相邻文字或控件承担（菜单行按钮、徽标标签、mention 原文）。

**三处应用**（交互契约归[工作台 §32.9](../workbench-design/part-11.md#329-连接器与插件二级2026-10-17)与消息展示规则）：

| 位置 | 形态 | 几何 |
|---|---|---|
| 「+ → 连接器与插件」三行内置插件 | 图标 + 名称 + 行尾状态原位替换 | 图标位 16px（`font.size.body`），与相邻 Lucide 同档 |
| 输入器正文原位 | mention 文字画成「小图标 + 短名」，跟在光标所在位置 | 图标 `font.size.body`（16px，2026-10-25 用户指认 14px 太小，与 `@` 菜单行同档）、标签 `font.size.meta`（14px，受原文字宽预算约束），标签 `color: inherit`（正文前景色），**无容器底、无边框、无阴影**（2026-10-29 第四轮 Codex 风格）；图标与名称间距 `space.0.5`（2px），左右无内缩；**宽度恒等于所替代的 `@标签` 字宽**，放不下由标签省略号收口 |
| 输入器 `@` 菜单 | 输入 `@`（可跟查询词）弹出三个内置插件，选中即把 `@query` 换成 `@标签 ` | 复用命令菜单外壳；紧凑浮层（`width: fit-content`、`min-width: 11rem`、`max-width: min(100%, 20rem)`）、无阴影、1px 分隔色边框、行内 `space.1 space.2` 内边距；行内图标 16px + 名称，左对齐 |
| 用户消息展示层 | mention 显示成「小图标 + 短名」，**不带 `@`**（2026-10-25 用户指认「这里不应该显示 @」） | 图标与名称升到 `font.size.body`（16px，与正文同档），容器与颜色与编辑态同一套；inline-flex + nowrap 不拆行，`vertical-align: top` 使行盒不被撑高；原文（含 `@`）仍在 message.content 里供复制 |

**输入器芯片的实现边界（2026-10-25，参考 Codex 输入器工具标识）**：textarea 仍是**唯一文本 Owner**——芯片是镜像层上的视觉件，不改 contenteditable、不改草稿协议：原生光标/选区/IME 组词/粘贴/撤销/发送载荷全部走原路径。做法是在同一盒模型里放一层与 textarea 同源继承字体、逐项相同盒模型（内边距/边框/折行规则）的镜像层，把同一段草稿原样排版；mention 文字在镜像层里**透明占位**（保证折行点与光标对齐），芯片按 mention 的实测矩形绝对定位叠上去。因此：芯片宽度贴近所替代的原文（第二轮起改为**恒等于**原文字宽，见下）、与后续文字之间不留缝；textarea 弹出纵向滚动条时镜像层右侧让出同宽 gutter，两侧折行才一致——补偿是「基础 padding + 当前 gutter」的**绝对值**：每次先清掉上一轮行内补偿再读基础值，滚动、缩放、ResizeObserver 反复触发不叠加，gutter 归零即恢复（2026-10-26 独立验收指认过「把已含补偿的计算值当基础值再叠加」的累积缺陷，jsdom 与真实 Chromium 回归用例守住幂等）；镜像层只在出现已知 mention 时渲染，其余情况输入器与此前逐像素一致。真实 Chromium 量测断言：镜像层与 textarea 计算样式逐项相同、单行正文宽度与同字体 canvas 测量一致（242.73 vs 242.72）、芯片矩形与 mention 矩形左/上/高偏差为 0、长草稿滚动后芯片仍对齐、窄窗 760px 三枚芯片不溢出。

**第二轮精修（2026-10-28，用户指认「像贴在普通文字表面的图标和标签」）**：一条视觉规则只写一处。新增 `components/PluginChip.tsx` + `PluginChip.css` 作为内联插件标识的唯一视觉件（图标 + 名称 + `::before` 容器底），编辑态与只读态共用，`AssistView.css` 里那份重复的 `.assist-plugin-mention` 视觉规则删掉、只留消息侧的钩子类；不引入新组件库、新状态系统或新 token。几何法则明确写进实现：**镜像层必须与 textarea 逐像素同排版，所以芯片画出的宽度必须等于（或被裁到）它所替代的 `@标签` 字宽**。上一轮的固有宽度（图标 + gap + 名称）只是「恰好」比字宽窄 1.7~5.1px，任何一次字体度量变化都会让它压住后面的正文；本轮宽度按 mention **首片段**实测矩形下发 `--chip-width`，配 `overflow: hidden` + 标签 `text-overflow: ellipsis`，「盖住正文」与「光标落进名称里」从靠调参避免变成结构上不可能。真实 Chromium 对照（同一页面按上一轮 CSS 声明复现旧写法，只注入样式）：原文字宽 79.14px，旧画法固有宽 76px（余量 3.14px，靠的是名字短、字体窄，不是结构）；把名称加压一档后旧画法宽 100px、越过原文右缘 20.86px、把后续正文压到芯片底下 17.28px，新画法同一压力下仍是 79.14px、右缘误差 0、后续正文起点仍在芯片外 3.58px、超出部分由省略号收口。字号档位的取舍：两态只差**名称**一号（编辑 meta／只读 body），**图标两态都是 body 16**——本轮一度把编辑态图标降到 meta 去换宽度，与 2026-10-25 那条「14px 太小」的指认冲突；改为取消图标与名称之间的 gap（资源本身带内缩留白，容器另有 `padding-inline`）后，16px 图标在 100/125/150% 三档都装得下三枚内置插件的完整名称（最紧的 `@GitHub` 在 125% 下固有 85px vs 预算 84.8px，正是那 2px 缝挤出来的）。同时收口的三处几何：绝对定位件的包含块是镜像层的 **padding 盒**，原点只加回左/上边框（旧写法按边框盒左上角算，把左 padding 与边框各多算一次，嵌进 `.create-form` 这类有边框内边距的表面就整体右移）；滚动条 gutter 补偿改为 `offsetWidth - clientWidth - 两侧边框`（边框在镜像层同源、已扣）；应用字体是 `font-display: swap` 的可变字体，`document.fonts.ready` 后重量一次，消掉首屏与字体缩放后停在回退字宽上的偏移。只读态另有一处 1px：`inline-flex` 的外部基线取第一个 flex 项，图标是 `<img>`——替换元素的基线就是它的下缘，比正文基线低 1px，整枚芯片被顶高、消息气泡从 42px 变 43px；改 `vertical-align: top`（芯片盒高本就等于行盒高）后逐像素重合，量测确认带标识的单行消息与同样文字的纯文本消息等高。状态保真补两条：禁用/发送中的灰由镜像层与芯片共同承担（`:has(> textarea:disabled)` → `color.disabled.text`，不再出现正文已灰、芯片仍绿）；`forced-colors: active` 下容器底换成系统 `Canvas` 底 + `CanvasText` 描边——工作台当前无暗色主题，这是唯一新增的主题分支。**跨行降级（2026-10-29 第三轮，用户指认「看不见的字符占位」）**：上一轮记为「已知取舍」的那句——mention 跨过行首时芯片只盖首片段、剩余原文仍按 `color: transparent` 排版——按用户的判定不是取舍，是缺陷：一排读不通的空气字符，用户不知道那里有内容。现在的规则是**整枚芯片收起、原文 `@标签` 恢复可见**：`placeChips` 量到 `span.getClientRects().length > 1` 就给芯片写 `data-split="true"`（`.plugin-chip.chat-command-chip[data-split="true"]{display:none}`，(0,3,0) 压过 `.plugin-chip{display:inline-flex}`，行尾不留半枚悬空图标），同时给那段原文写 `data-chip="off"`（`.chat-command-mention[data-chip="off"]{color:inherit}`）。这里用 `inherit` 而不是写死正文色：禁用/发送中的灰仍由镜像层这一层承担，不会降级一段回黑、其余段照灰。**折行规则一个字都不改**——禁止给镜像层加 `white-space: nowrap` 强行不折行，那会让两侧排版分叉，光标与可见文字错位，比不可见占位更糟。降级因此是排版中性的，量法也写进用例：TreeWalker 遍历镜像层文本节点、用 `Range.selectNodeContents().getClientRects()` 拍下「强制降级前／强制降级后／还原后」三份矩形快照比对，实测零矩形位移且还原无残留，所以光标、选区、输入法、撤销的落点与可见文字始终一致。一句话概括这条视觉规则：**放不下就不画，绝不画半枚、也绝不留看不见的字**；名称放不下由省略号收口，原文放不下就整段还给用户读。

**禁用/发送中不重影（2026-10-26 独立验收指认）**：会话输入器的禁用规则（`.agent-chat-composer .field textarea:disabled` 与 `.create-form` 同款，(0,3,1)——2026-10-20 用户指认提交窗口内不画禁用灰的那条）会把 `color` 与 `-webkit-text-fill-color` 重新刷回正文色，压过芯片态的 (0,2,1) 透明：草稿带着 mention 发送时，底层原文与镜像层芯片两层可见文字。修复是在 `ChatCommandInput.css` 增加 `.chat-command-input .chat-command-surface[data-chips="on"] > textarea:disabled`（(0,4,1)，组件根类在场，与两个样式表的导入顺序无关）：芯片态无论是否禁用只露镜像层一层字；纯文本草稿（无 `data-chips`）不受影响，禁用灰与「提交窗口不灰」的既有结论照旧。首条消息输入器（`assist-first-draft`）与会话输入器（`assist-draft`）同组件同类，规则同时覆盖；真实 Chromium 在两条路径的 pending 禁用态各量测过计算样式（`color` 与 `-webkit-text-fill-color` 均为全透明）。

**选中不能盖掉芯片（2026-10-25 用户指认「光标选中图标，图标会变成蓝色 @」）**：textarea 的默认选区是不透明的系统蓝，压在镜像层上会把芯片整个盖住，只剩 `::selection` 强制出来的白字。修法是给芯片态的 textarea 一条 `::selection`：底色取 `color.selection.bg` 的 55% 半透明、选中文字保持 `color: transparent`——芯片与正文从选区底下透出来，选区仍是可读的浅色底。这条只作用于 `data-chips="on"`（有 mention 的草稿），普通草稿的选区仍是系统默认。

**`@` 唤起菜单（2026-10-25 用户指认「输入 @ 没有弹出插件菜单」）**：输入 `@`（可跟 ≤12 字查询词）时在输入卡上方弹出三个内置插件，按名称过滤、↑↓ 选择、Enter 插入、Esc 关闭、点行同样插入；插入把光标前的 `@query` 换成 `@标签 `（query 后紧跟的空格一并吃掉，不留双空格），光标落在插入内容之后。边界与 mention 识别同源：`@` 在开头或前字符不是单词/路径字符才弹——输入邮箱 `user@` 不弹，中文前导无空格（`先用@`）照弹。菜单只编辑草稿、不发送、不授予任何能力；斜杠命令菜单展开时让位给它。

**边界**：芯片与消息图标都是**纯派生展示**——草稿与消息仍以纯文本为唯一事实，芯片不落库、不进发送载荷、不是第二份插件状态；删除或撤销 mention 后同步消失，手动输入与菜单插入得到同一枚。mention 识别只认明确的 `@电脑操控` / `@浏览器操控` / `@GitHub`，邮箱、路径、未知 mention 与更长词的一部分（含紧跟汉字的粘连）都不画芯片。其余通用操作仍用 Lucide；files/knowledge/automation 三枚已进资源与组件，但没有准确业务入口前不强行铺开。**明暗主题**：工作台当前只有浅色一套主题（无 `prefers-color-scheme` 分支），图标按浅色表面（paper/surface/subtle）校准。

**验证出口**：`tests/pluginIcons.spec.tsx`（六 key 资源映射与装饰语义、mention 边界、芯片派生与同步、消息原文保全）与 `tests/composerAttachMenu.spec.tsx` 的图标条（三行不串图、其余操作仍 Lucide）；`tsc --noEmit` 对新增文件零错误；`vite build` 产出六枚 PNG 并被 bundle 引用。输入器芯片的几何对齐由真实 Chromium 量测断言（镜像层与 textarea 计算样式逐项一致、单行宽度同字体基准一致、芯片叠放 mention 矩形偏差为 0、滚动与窄窗不漂移），jsdom 不量几何、不替代。真实 Windows/WebView2 截图与小尺寸、DPI 观感以浏览器用例与统一验收表为准。第二轮的几何与观感出口是 `apps/workbench/tests/browser/pluginChipGeometry.spec.ts`，第三轮扩到**十九条**并改写跨行那条，逐条量镜像层/textarea 计算样式同源、**芯片宽与其所替代的 `@标签` 首段字宽之差 ≤1 CSS px**、芯片右缘不越出原文右缘、标签被裁时省略号在场而后续字不压、滚动每一轮芯片顶位移等于 `scrollTop` 增量、100/125/150% 缩放同基准、390/768/桌面三档不溢出、CDP 真实 IME 组词期间菜单零弹出且芯片恒一枚、禁用态镜像层与芯片标签同灰、只读态带芯片的气泡高与同文纯文本气泡高逐像素相等、`forced-colors` 下容器退化成 1px 描边。同文件第⓪条用**只改样式**的方式复现修复前那组规则（`width:auto` + `overflow:visible` + `line-height:1`）并量出芯片压过后续文字约 17px，作为「不是靠加 margin 或负定位掩盖」的反证。第三轮新增的判据只有两类：**「任何位置都不出现不可见占位与半枚芯片」**——每条用例都跑一遍 `expectNoInvisiblePlaceholder`，逐枚 mention 断言「画了芯片 ⇔ 原文只有一个矩形」与「没画 ⇔ 原文可见且矩形 ≥2 段」，并扫掉 390/768/1162 三档 × 21 档长度的组合分档记录画了多少枚、降级了多少枚；**降级不改排版**——即上面的三份矩形快照比对。另外把「撤回」拆成三个互不替代的状态分别取证：真实发送（`page.route` 代答 `POST …/messages` 得 202 后重读的回显）、重新加载（同一份历史再读一次）、真正的消息撤回（`POST …/recall` 得 200 收据、行状态改「已撤回」、原文折叠进 `<details>`）——撤回后闭环里芯片节点仍在 DOM 里 2 枚但 `checkVisibility()` 全部不可见，因为 Chromium 对折叠的 `<details>` 内容**保留布局盒**（`getBoundingClientRect().width > 0`），只看矩形会把"已收起"误判成"看得见"，这条判据因此不能用量测宽度替代。多行消息、390px 窄窗、真实按键撤销恢复（Ctrl+A→Backspace→Ctrl+Z）、降级态叠加发送 pending 禁用都各有专条。截图落在 `apps/workbench/output/plugin-chip-acceptance-20261028/`（编辑态聚焦/禁用、消息只读态、修复前后与放大字号压力态、真实发送回显与撤回后展开、跨行降级与禁用态各一张特写）。真实 Windows/WebView2 到第三轮仍未取证：桌面壳按 `Local\RelayAgentDesktopSingleInstance` 全局互斥只允许单实例，取不到可驱动的窗口，不能用上面的 Chromium 数字代替。


**V3 轻量化（2026-10-29 第四轮，用户「插件标识要像 Codex 一样简洁、不突兀；插件菜单不要阴影、不要铺满输入器」）**：`PluginChip.css` 重写，去掉 `::before` 容器底、`padding-inline`、`isolation` 与插件绿文字——默认透明背景、`color: inherit`（取所在表面的正文前景色）、无边框、无阴影/光晕，只保留 `inline-flex`、`align-items: center`、`gap: space.0.5`（2px）、16px 图标与名称省略号；编辑态宽度预算不变（`--chip-width` 仍等于 `@标签` 首片段实测字宽，本次只是把内部留白让给名称）。两态量测（⑲）：背景 `rgba(0,0,0,0)`、`box-shadow: none`、`filter: none`、padding 0、gap 2px、图标 16px、文字 `rgb(32,51,41)` 逐项一致，唯一差异是名称字号（编辑 meta／只读 body，编辑态受字宽预算约束）。`forced-colors: active` 下由「容器底 + 描边」改为芯片自身 `outline: 1px solid CanvasText`（容器底已不存在）。`@` 菜单只覆盖 `.chat-command-menu.chat-mention-menu`：`inset-inline: 0 auto` + `width: fit-content`（`min-width: 11rem`、`max-width: min(100%, 20rem)`）不再铺满输入器，`padding: space.1`、`box-shadow: none`、`border-color: border.separator`，行内边距 `space.1 space.2` + `radius.badge`；顶部常驻操作提示从 DOM 移除，键盘说明改挂 `aria-describedby` 指向的 `.visually-hidden` 文本。命令菜单与其它浮层不动。`ChatCommandInput.css` 中「芯片宽度 = 原文测量宽度」的绝对定位规则（`.plugin-chip.chat-command-chip`）原样保留，视觉收窄全部发生在芯片内部排版。前后对照用「只注入上一轮皮肤」的方式取证（同一内容、同一 DOM）：`output/plugin-chip-acceptance-20261028/chip-before-after-before.png` 与 `-after.png`，断言注入态确有 `rgb(237,245,239)` 容器底、本轮 `::before` 与背景均为透明。

### 9.23 会话行的状态图标：八态共用一格（2026-10-28 起，2026-10-30 扩展）

用户先要求「切到别的会话时，从左栏就能看出哪条正在生成回复」，随后（2026-10-30）要求把这一格扩成完整的状态系统：运行、排队之外，完成、失败、取消、未开始、归档、等待确认都要各自可辨。两次都明确否掉整行旋转边框、发光、闪烁与呼吸。落点始终只有**类型图标那一格**（`font.size.caption` = 12px）：与原来的 `MessageSquare` 同处一槽、同尺寸、同基座类（`.recent-work-kind`），换的只是图形与状态修饰类。

| 状态 | 判据（服务端读时派生） | 图形 | 动效 | 前景色 |
|---|---|---|---|---|
| `RUNNING` | `assist_messages` 有 `RUNNING` 行（Worker 已认领） | 三个实心圆点（`r=2.4`，圆心 5.5 / 12 / 18.5） | 三个点按 0 / 140 / 280ms 错峰上下，位移 −3.2 用户单位（12px 下约 1.6px），一轮 1.1s（`motion.loop.thinking`）、`motion.easing.loop`、`infinite` | `color.text.secondary` |
| `PENDING` | 有 `PENDING` 行、没有 `RUNNING` | 钟表（Lucide `Clock`），静止 | 无 | `color.text.muted` |
| `WAITING_APPROVAL` | `assist_proposals` 有 `status='PENDING'` 的提案 | 圆角方框 + 感叹号（`SquareExclamationPoint`），静止 | 无 | `color.status.warning.text`（琥珀 #96622A） |
| `COMPLETED` | 最后一轮 `ASSISTANT` 行 `COMPLETED` | 圆形对勾（`CircleCheck`） | 一次性收敛 120ms（`motion.duration.fast` + `easing.standard`），`iteration-count: 1` | `color.text.muted` |
| `FAILED` | 最后一轮 `FAILED` | 圆形感叹号（`CircleAlert`） | 无 | `color.status.danger.text`（低饱和砖红 #A34F43） |
| `CANCELLED` | 最后一轮 `CANCELLED` | 斜线圆圈（`Ban`） | 无 | `color.text.muted` |
| `NOT_STARTED` | 会话里一条消息都没有 | 空心消息框（`MessageSquare`） | 无 | `color.text.muted` |
| `ARCHIVED` | `assist_sessions.status='ARCHIVED'` | 归档盒（`Archive`） | 无 | `color.text.muted` |
| 无法判定 | 有消息但读不出最后一轮助手行；或旧服务端没有该字段 | 回退类型图标（`MessageSquare`，不带 `data-state`） | 无 | `color.text.muted`（未读行 `color.text.secondary`） |

**优先级只有一条链**（在 `AssistRepository.deriveListState` 一处实现，列表与单条读取共用）：在途（`RUNNING` 压过 `PENDING`）→ 待确认 → 归档 → 未开始 → 最后一轮终态 → `null`。在途压过一切，因为它是此刻正在发生的事；待确认排在归档与终态之前，因为它是这一列里唯一「需要人动手」的事实；「未开始」排在终态之前，因为一条没有任何消息的会话用「还没开始」比用它上一轮的结局更能说明现在。

**`null` 不是完成。** 2026-10-28 的投影只有 `RUNNING`/`PENDING`/`null`，`null` 的含义是「没有在途的一轮」；把它当完成会在空会话与结算会话之间说谎。现在终态是另行读出的**另一条事实**（最后一轮助手行的 `status`），读不出就回退类型图标——宁可不知道，不编一个结局。

**形状 → 颜色 → 动效，三层按可靠性排序。** 关掉动效是本机的合法选择（`html[data-motion="off"]`），系统偏好（`prefers-reduced-motion: reduce`）也要尊重，那时「在动」这件事不再可见；灰度打印与色觉差异同样会拿走颜色。所以八个状态各有自己的轮廓，静止时仍逐一分得开，动效只是第三层信号。颜色只让两档离开中性色：失败借 danger、待确认借 warning——它们真的需要被看见；完成态留在 `text.muted`，因为左栏绝大多数行都是完成态，给「完成」上绿色会把这一列读成装饰，而不是状态。

**运行中的三个点。** 只有圆点自己在动：`transform-box: view-box` + `translateY`，SVG 子元素的位移不参与布局，这一格的盒子尺寸恒定，行的外接矩形因此不随动画变化。起伏占一轮的前 60%，余下时间静止——一列里同时有几条在跑时，不会变成一排持续跳动的灯。动画写在 `circle` 上而不是整枚 `svg` 上，所以「图标盒子有没有变」与「点在不在动」是两件可以分别量的事。

**完成态只播一次。** `recent-work-settle` 是 120ms 的透明度 + `scale(0.92→1)`，`animation-iteration-count: 1` 且 `fill: both`：状态翻到完成那一次起播，之后轮询每分钟重渲染这一列都不会重播。这不是装饰性入场，而是「刚才那一轮结束了」的一次性回执。

**未读不再提亮状态图标。** 旧规则 `.recent-work-item--unread .recent-work-kind` 会把这一格刷成 `text.secondary`——放在八态上会把失败的红、待确认的琥珀一起刷掉。现在限定为 `.recent-work-kind:not([data-state])`：只有「没有状态可陈述」的类型图标才随未读提亮，状态色永远归状态。未读自身的两道信号（加粗标题 + 圆点）不变，两个维度各自成立。

**几何承诺不变。** 行高、行距、标题可用宽、置顶徽标与未读圆点的位置一像素不动：这一格本来就是 12px 且 `flex: none`，换图形不改盒模型；列的 160px 下限与「标题压到 ⋯ 下面」那一套（§9.11、§9.21）都照旧。悬停/聚焦/已勾选时复选框显形并让图标 `visibility: hidden`——八态与原来的类型图标同一条规则，**优先级不变**：那一格显示复选框，图标让位但不卸载（动画不重启，移开指针也不会跳帧）。

**服务端只有一条派生链。** HTTP 投影新增只读字段 `list_state`（见命令契约 §10.116），`run_state` 保留为它的在途子集——轮询与「此刻有没有在跑」要的是这个窄口径，客户端不必从八态里再挑一次。列表读取仍是一条语句：`has_messages`、在途、最后一轮助手行、待确认提案都是相关子查询，左栏有多少行都不额外发请求，也不为任何一行单独发请求。

**减少动态效果**：`html[data-motion="off"]` 与 `@media (prefers-reduced-motion: reduce)` 都把 `animation` 置为 `none`（带 `!important`，压过全局 `* { animation-duration: … !important }`——只把时长压到 0 会让无限动画原地瞬间重放，读起来像坏掉的闪烁）。停的是动画，不是状态：三个点仍停在基线上、其余七个图形原样，可访问名称里的「正在生成 / 排队中 / 已完成 / 生成失败 / 已取消 / 等待确认提案 / 未开始 / 已归档」照读。

**验证出口**：真实 Chromium 侧 `tests/browser/recentWorkRunState.spec.ts` 九例——八态的状态类与图形两两不同、三点动画四要素（`recent-work-dot` / `1.1s` / `0·0.14·0.28s` / `infinite`）与完成态 `iteration-count: 1`、动画期间行与图标盒子逐帧不动、翻到终态后 `getAnimations()` 无运行中动画且再轮询不重播、八行等高与标题可用宽一致、悬停复选框让位、`data-motion=off` 与 `reducedMotion: reduce` 各自全停、1024px 窄窗尺寸不变且不横向溢出、归档段画归档盒；判定、文案与轮询节拍归 `tests/recentWorkRunState.spec.ts`（jsdom，12 例）；派生链本身由 `apps/api/test/unit/session-list-state.test.ts` 逐档钉住。


### 9.23 上下文用量浮层的三段排版与三档横排（2026-10-30）

会话级上下文档位（0145）让浮层正文从两段变三段（摘要／构成／档位），排版随之定三条规则。

- **摘要仍是「一行一读」**：`已用 / 冻结预算 tokens` 与占比同一基线，占比靠右并用 tabular-nums；下面一条 4px 进度线，再下面两列二级信息（预算余量（估算）／本次输出）。数字全部 tabular-nums，位数变化不带着 `tokens` 左右跳。缓存读取／写入／命中率用 `dl` 一行一项，未上报整项不出现，不写「未采集」占位。
- **构成列表用行，不用卡片**：`图标(14px) + 分类名 + 右对齐数值`，行内上下 `space-1`，分隔线只画在相邻行之间（`li + li` 的 1px `border-separator`），首行与末行不留半截线。分类顺序固定，零值项不渲染——`0 tokens` 会被读成「占了一点」。区块标题旁的「估算」是 `selection-bg` 底的小标签，不是标题的一部分。
- **三档横排**：`flex` + `nowrap`，radio 与文字同属一个 `label` 命中区，间距 `space-3`；选中态只改文字颜色与字重（`:has(input:checked)`），不加边框、不改字号，避免一行三枚一起抖。窄容器（`composer-actions` ≤ 34rem）只收紧间距与字号到 caption 档，仍不换行——换行会把「选一个数」读成「两组选项」。
- **选中即改变，因此没有动作行**：档位区**不设**「保存上下文长度 / 重新读取」两枚按钮——点档位即写服务端，写完用一行 `status` 文案回执（`color.text.muted` + caption 档）说明结果。理由是这两枚按钮把「选一个数」拆成三步（选 → 保存 → 等回执），而档位本身是**低风险、可逆**的单值设置，多一步确认只是仪式。回执/冲突/异常因此都以**行内状态行**呈现，不占独立动作区：正常状态一行 `meta` 文案，异常时多一行 `role="alert"`，回执查询入口（`text-link`）只在传输失败待核对时出现。
- **状态行不推动布局**：状态行固定在档位行**下方**、动作行**上方**，高度随内容变化但**不占据输入卡内部空间**——浮层是 `position: fixed` 的独立层，它长高不会推动输入卡与消息列表。

**2026-10-31 精修（三段重排后的排版）**：浮层宽 `max-width: 24rem`（原 21.25rem 读起来过窄，主读数与占比挤在行尾），内距 `space-4`。三段的视觉层级是：段标题 meta(14) 灰字 → 关键读数 rowTitle(20)/reading(18) 深色 → 其余 meta/caption。档位值（20px semibold tabular-nums）是全浮层最强的读数，占比与历史主读数同档 reading(18)，构成行与说明行 caption(12)/meta(14)。状态用一枚 chip（中性底 12px），只有「待核对」与「保存失败」换语义色；不用绿色大回执块，成功反馈降级为一行 caption 状态行，`.context-usage-tier-state:empty` 时不占高度。段间用 1px `border.separator` + `space-3` 留白，段内用 `space-2`；第一段不画顶线（它就是浮层身份）。三档横排与命中区规则不变。

**容器几何另有一处修正（三次实测后的定案）**：浮层最初以圆环组为锚点（`group { position: relative }`），
而圆环在工具行、贴近卡片底缘，浮层只能向上压进正文输入区——782px 高窗口实测底缘落在卡片内部约 60px 处。
改成「让出包含块、锚到整张输入卡」后浮层能落在卡片上方，但它仍是卡片的子元素，
任何祖先的 `overflow` 都会裁它：560×700 实测标题行被中栏裁掉，固定 `max-height: 68vh` 同样越界
（卡片上方只有约 200px，内容却有 477px）。

定案是 **fixed 定位 + 实测几何**：浮层打开时按圆环实测位置落位（锚点与间距见下 2026-11-01 修订）。
落位在 layout effect 里完成（不在 render 里读几何），窗口尺寸变化与内容高度变化
（保存回执、冲突提示、分项刷新）各由 `resize` 事件与 `ResizeObserver` 触发一次重排。
CSS 仍保留 `min(30rem, 68vh)` 作为兜底，fixed 定位后它只影响未量测时的初值。

新样式只加 `.context-usage-*`（构成列表、三档、动作行），摘要段继续沿用 `.agent-chat-context-meter-*`，不复制第二套 token；所有数值、间距、圆角都取既有 `design-tokens.json` 变量。

**2026-11-01 第三轮（读序、停靠区与圆环锚定）**：交互语义与根因记[工作台 §27.4](../workbench-design/part-08.md#274-定制与上下文反馈)，本节只定视觉规则。

- **正文两段容器**：浮层内网格从「三段同层一起滚」改成 `.context-usage-scroll` + `.context-usage-dock` 两行——`grid-template-rows: minmax(0, 1fr) minmax(0, auto)`，滚动区 `overflow-y: auto` + `overscroll-behavior: contain` + `scrollbar-gutter: stable`，停靠区顶部一条 `border.separator`、超高时自身滚动。三档横排落在**停靠区**（浮层最底部），短窗口里档位不会被滚走，停靠区也不压分项、错误提示或键盘焦点。`gutter: stable` 是为这条服务的：滚动条出现与否不该改变正文可用宽度，否则每次读数刷新都把行末数值推向左右。旧的 `@media (max-width: 30rem)` 一档随之下线——三档横排在 420px 视口实测不溢出，[§9.6](part-03.md#96-控件基座与响应式收敛2026-10-08)的语义档守卫也不允许这种补丁断点。
- **锚点从输入卡改成圆环**：`.agent-chat-context-meter-menu` `position: fixed` 且 `createPortal` 到 `document.body`。上一段列的两条祖先限制正是留在卡片内的代价，portal 是唯一同时满足「贴环」「不被中栏裁」「不越视口」的形态，与 `usePathTooltip` 同构。底边贴**圆环顶缘上方 7px**、右缘对齐圆环右缘；上方放不下且下方更空时整块翻到环下方同间距，方向写进 `data-side` 供用例断言；两边都放不下时夹在视口内、上下各留 8px。
- **逐帧比对圆环矩形**：环在工具行里，位置由整页布局决定——模型名到达只改兄弟宽度、消息增多或工具行换行只改卡片高度，**环自身尺寸不变，`ResizeObserver` 看不见「只挪位不变大」**（真实 Chromium 实测：右缘差 120px，窄窗倒扣 73px 压住环本身）。浮层打开期间每帧读一次环的矩形，只有真挪了才重写落位；浮层挂在 body 上且 fixed，重写它的 `top/left` 不会反过来推动环，不构成回环。
- **分项六色**：六类各取一枚 `color.category.*`，**只作用在 14px 图标**（`.context-usage-row[data-category] .context-usage-row-icon`），分类名仍 `color.text.secondary`、数值仍 `color.text.primary`——上色说的是「哪一类」，不是「有多少」。六色取同明度带的低饱和值（azure / violet / amber / teal / leaf / control），亮面对 `bg.surface` 全部 ≥3:1（最低 `other` 3.30），本机唯一暗面（开发场景实验室 `#1b211d`）同样全部 ≥3；取值与实测对比度写进 token 的 `contrastChecks`，样式只写 `var(--relay-color-category-*)`，将来真做暗色主题时自动继承。含义不靠颜色承载：六枚 lucide 图标形状各异 + 固定分类名 + 右对齐数值三重表达，两种红绿色盲下最接近的一对（青绿 ↔ 灰绿，ΔE≈8）因此不构成误读。数字一律 `tabular-nums`。
- **圆环尺寸与读数**：`control.meter.size` 收回 1.5rem（24px 视觉直径），按钮盒仍取 `control.height.compact`（32px），命中区不小于 32×32——辅助读数不该压过同排文字，但点击区不跟着缩。环右侧常驻的独立百分比文字删除（`.agent-chat-context-meter-value` 连同其窄栏 `@container` 收起规则一并移除），同一读数仍在悬停 Tooltip、`aria-label` 与浮层里。悬停/按下只改底色并用 `@media (hover: hover) and (pointer: fine)` 门控；进度弧 `stroke-dasharray` 以 `motion.duration.panel`（180ms）补间一次，`prefers-reduced-motion` 下由全站规则收到 0ms，无循环动画。

**2026-11-01 第五轮（用户指令：删两行＋中线对齐）**：上面两段里的「档位值 20px semibold」与「右缘对齐圆环右缘」**由本轮替代**。①「当前档位 N」标题行（含 20px 档位值与状态 chip）与「下次调用申请 N tokens」行删除，停靠区只留三档横排；当前值由单选态表达，保存中/待核对/失败仍由 `.context-usage-tier-state` 与 `role="alert"` 块说明，不再常驻「已保存」chip。②浮层水平落位由「右缘贴圆环右缘」改为**中线对准圆环中心**（左缘 = 环心 − 浮层宽/2），两侧各留 8px 视口边距；空间不足时夹住，并保证环心仍落在浮层覆盖范围内。垂直落位（贴环 7px / 翻面 / 夹进视口）不变。

### 9.24 开发期场景实验室的预览优先工作区（2026-10-31）

场景实验室（`apps/workbench/src/dev/ScenarioLabView.tsx` + `ScenarioLab.css`）是开发构建里的全屏调试工作区，不套 `pv-page` 原型皮肤，也不建立第二套色板：所有颜色、字号、间距、圆角、阴影都取 `--relay-*` 变量。

**五层结构。** 页面导航（页头）／当前场景（预览头）／播放工具（Playback Bar）／AI 回复预览（舞台）／技术检查（检查面板）各自只表达一件事。层间用 1px `color.border.separator` 与留白分隔，不用卡片包住整条回复，也不叠阴影；唯一浮层是窄窗抽屉，取 `shadow.floating`。

**尺寸与字形。** 目录列宽 `clamp(13.75rem, 16vw, 15.5rem)`；检查面板 `clamp(18rem, 20vw, 20rem)`；控件统一 `control.height.compact`（32px）；页头标题 `font.size.rowTitle`（20px），预览头用 `font.size.body`，说明、时间、计数用 `font.size.caption`；场景 ID、帧时间、命令、路径用 `font.family.code`。预览宽窗保持产品自己的 `--chat-measure`（46.5rem），窄窗／手机宽档为 30rem／24rem。

**状态与验收分开。** 场景执行状态用真实状态词（在途、流式、终态、失败、未知……）；验收结果只用 6px 的 success／danger／warning／neutral 点或一行文字，不把「验收通过」画成产品执行成功，也不堆彩色徽章。目录筛选的「运行中／完成／异常」读场景自身 `stateKind`，「未验收」读本页跑出的验收状态。

**响应式。** ≥1181px 目录常驻、检查面板可固定右列；1180px 以下检查面板改为覆盖抽屉；≤1100px 目录也改为覆盖抽屉，预览保持主体宽度。断点只改结构，不缩放字体，不把目录、预览、控制器竖着堆成一条。抽屉盖住的只是滚动区，页面根不产生横向滚动；宽窗的检查面板收起、窄窗的抽屉关闭分别由预览头开关与面板关闭键承担，不重复同一动作。

**验证出口。** 真实 Chromium 的 `tests/browser/scenarioLabUiV2.spec.ts` 量目录宽度、预览列宽、检查面板开关前后的宽度变化、窄预览档、播放条高度、抽屉与 Esc、Gallery 分类数量；既有十条 DOM 性质与 145 条矩阵继续在 `assistScenarioLab.spec.ts` / `scenarioLabMatrix.spec.tsx` 跑。截图与实测数字存 `tmp/Scenario-Lab-UI-V2/`，不以类型检查代替视觉验收。

### 9.25 场景实验室 V2.1：运行状态、单帧静态与验收摘要（2026-10-31）

**单帧收敛。** 单帧场景不画进度轨道、播放/循环/速度/单步，只显示 10px 的「静态状态预览」徽标、`第 1/1 帧` 与 32px 的「重新检查」；多帧才使用完整 Playback Bar。末帧播放按钮文案改为「重新播放」，仍是同一种 32px 主按钮，不新增第二个主色。静态说明条与预览同宽（`max-width: 60rem`），1px `border.separator`、`bg.subtle`、`radius.control`，文字 12px，不放投影。

**短场景舞台。** 单帧舞台用 `justify-content: safe center` 把真实 UI 与说明条放在舞台中段；内容高于视口时自动退回顶部，仍可滚动。不插入假消息、不给预览加边框或阴影；长任务/长回复仍从顶部开始。

**运行状态。** 快速静态检查与完整场景验收各用一颗 32px 次级按钮，运行中显示 `done/total` 与独立「取消」；按钮不因等待而变主色。Inspector 的两段运行摘要用 10–12px 文字与 1px 分隔线表达状态、耗时与七项计数（全部通过/静态通过/失败/待浏览器/无法验证/无法覆盖/未运行），不堆彩色徽章。`browser-only` 只能是「待浏览器」数字，不能染成成功色。

**状态点。** 目录的 6px 验收点新增 `static`/`unverifiable`（warning）与 `stale`（空心 muted）；`pass` 才是成功色。悬停标题写清「全部通过 / 静态检查通过 / 静态失败 / 无法稳定验证 / 证据已过期」，不把 SETTLED 当成功。

**验证出口。** `scenarioLabRunsV21.spec.ts` 验单帧/多帧/G01 完整回放、取消、重复启动、切场景/视图/离页、稳定超时；`scenarioSettle.spec.ts` 与 `scenarioLabRuns.spec.ts` 固定纯逻辑。截图与实测存 `tmp/Scenario-Lab-UI-V2.1/`。

### 9.26 会话待办清单：与输入卡同轴的轻量进度面板（2026-10-31，两轮）

**宽度跟 owner 走。** 待办块与输入卡、目录细条、目标卡、队列共用 `--chat-measure`（`min(46.5rem, 100%)`，定义在 `.agent-assist` / `.embedded-assist` / `.skill-page`）：`width: 100%` + `max-width: var(--chat-measure, var(--relay-layout-reading-maxWidth))` + `margin-inline: auto`。此前它是这一列里唯一铺满的块，1162px 窗口下比输入卡宽 124px（868 vs 744），读起来像另一个页面的内容。三档窗口实测两块的左右缘逐像素相同（1162：340..1084；900：268..884；720：16..704）。

**面。** 白色面 + 1px `border.separator` + `radius.control`（8px，`radius.composer` 的 16px 留给输入卡），**不加投影**——抬升只声明一次（这里是边框）。此前用 `color.selection.bg`（鼠尾草绿）作常驻底色，而那是 hover / 选中的语义，等于整块永远处于「被选中」态，也是这一列里唯一的常驻色块；现在绿只出现在 `:hover` 上，与「执行过程」带子同一条规则。

**摘要行是一条可点的 header。** `min-height: control.height.compact`（32px）恒定，水平内边距 `space.3` 与输入卡内边距同档（两块左缘对齐），`hover` 染 `selection.bg`，`:focus-visible` 用 `focus.width/offset` + `color.focus.ring`，过渡走 `motion.duration.fast` + `motion.easing.standard`。展开时摘要的下圆角收回（`border-end-*-radius: 0`），hover 底色才不会与正文之间露出弧口。

**左边是「在做什么」，右边是「什么状态」。** 标题 `text.primary` 600；当前步骤 `text.secondary`；计数 `text.muted`；计数与当前步骤之间一道 1px `border.separator` 竖线（没有当前步骤时不留孤线）。停止徽标用 `margin-left: auto` 推到右缘，不再跟在当前步骤后面读成一句话。这句原文是「生成已结束，这一步未收尾」，2026-11-01 全链路测试后改成「本轮停止，这一步未收尾」：生成结束不等于这一轮停止——预算耗尽、审批等待、工具失败都会停在同一枚徽标上，说「生成已结束」把三种成因压成一种。

**完成度条只在展开时出现。** 2px，轨道 `border.separator`、填充 `color.status.success.text`，宽度由 `--session-todos-ratio` 给（已完成/总数）。折叠态不画：那一行字已经有「已完成 1/3」，再压一条线会把 32px 的摘要撑高，而且贴着标题读成下划线。展开后它与标题、列表各留 `space.2`，是这份清单的进度表头；`prefers-reduced-motion` 下不做宽度过渡。

**行靠留白不靠分隔线。** 行距就是 `gap: space.2`，删掉了逐行 `border-top`：一张卡片里套十六条横线会读成表格。正文整块按「箭头 1rem + `space.1`」缩进，清单图标落在标题图标那一列、清单文字落在标题文字那一列；图标统一 1rem，与 `ActivityRow` 的图标列同宽。

**状态色只借语义。** 进行中图标用 `color.status.running.text`（与「执行过程·运行中」同色），且只有 `data-session-todo-running="true"` 时状态词也跟着变蓝——「进行中·已停止」保持 `text.muted`，不冒充在跑；读取失败用 `color.status.danger.text`。完成 = 删除线 + `text.muted`；取消 = 只降级不划线（此前两者都是删除线，取消的步骤看着像做完了）。`--color-text-tertiary` 在本项目**不存在**，原先的 `var(..., rgb(148 150 158))` 兜底一直在生效，一行冷灰跑在暖绿底上；已改回 `text.muted`。

**脚注分三层。** 第一行是元数据 + 免责（`第 N 版 · 服务端快照。只记录进度，不代表执行结果或验收结论。`），第二行只在「本轮停了但清单还没跑完」时出现，说清怎么接着做（`本轮没有把这 N 项跑完。接着做只需再发一条消息……`），第三行是换任务的操作提示，提示里的写法用行内代码呈现（`新任务：` / `/newtask`）——要照抄的东西不该埋在句子里。「没做完」与「怎么继续」必须同屏：只报停滞不给出口，提示本身就成了一条死路（2026-11-01 全链路测试）。第二层在生成中不出现，避免与转圈的状态自相矛盾。行之间 `space.1`，与清单之间 1px 发丝线 + `space.2`，字号 `caption`、行高 `snug`。

**验收。** `tests/browser/sessionTodoList.spec.ts` 9/9（含三档窗口左右缘逐像素对齐、窄窗无横向溢出、16 项内部滚动且输入卡不被顶出、生成结束后最终读取落地）；`tests/sessionTodoList.spec.tsx` 18/18（含完成度条比例与脚注两层的结构断言）。截图与实测在 `tmp/agent-todo-list-ui-polish/`。

### 9.27 聊天用量常显与资料披露交互统一（2026-10-31）

**用量是一行事实，不再按需展开。** AI 回复的 token 读数此前收在消息底部「用量」的 `<details>` 里，读一次成本就要点开一次。现在删掉这层折叠与它的 `summary`，页脚直接常显「上下文 48210 · 输出 913 tokens」；缺值时写「未知」而不是 0，也不隐藏整行。页脚仍是「复制键在左、用量在右」：`.agent-message-usage` 取 `flex: 1 1 auto` + `overflow-wrap: anywhere`，长数字换行而不把复制键挤出。

**资料条改成右向箭头。** 摘要行去掉文件图标与原生三角 marker，改用与执行过程、活动行同一套的 `ChevronRight`：收起时指向右，`[open]` 转 90° 向下。摘要行同时去卡片化——不再画外框、底色与圆角，`hover` 只提文字色，`:focus-visible` 用 `focus.width/offset` + `color.focus.ring`。

**统一范围与边界。** 抽 `.chat-disclosure`（摘要行形态）与 `.chat-disclosure-chevron`（标记列）两个类，**只在显式带类的 `details` 上生效**：不做全局 `<details>` 覆盖，菜单、原生选择器与 `.page-explanation` 的 CSS 箭头各自保留。本轮在聊天区收敛 10 处：资料来源、Skill 详情 ×3、逐文件结果、查看已撤回原文、预览详情、候选卡核对项、工具读取分组。原生 `<summary>` 保留：键盘操作、`aria-expanded`、`[open]` 语义与默认折叠状态都不动。

**marker 要压两层。** `list-style: none` 与 `::-webkit-details-marker` 之后，`.tech-details` 上还有一条同特异性的 `> summary::marker`，而视图 CSS 先于 `styles.css` 注入、会被后者压过；因此补 `.tech-details.chat-disclosure > summary::marker { content: none }` 这条两级类名。

**缩进只有一个来源。** `--chat-disclosure-indent = calc(font.size.caption + space.2)`（实测 12px 标记列 + 8px 间距），资料列表消费它，展开内容才与摘要文字同轴。注意 `.assist-source-list` 的 `padding-left` 与 `migrated-scoped.css` 里同特异性的 `space.4` 规则相撞、后者注入更晚：单类名压不过它，展开内容会停在 16px 而不是标记列之后（4px 错位），必须用 `.assist-source-summary .assist-source-list` 两级类名。

**文案跟真实语义。** 来源状态 `SENT` 显示「已发送」（服务端含义是来源正文已装配并随本次调用发出），不自造「已理解」；原文枚举留在 `title` 里。

**验收出口。** 真实 Chromium 在 375／1024／1440 三档 × 亮暗两主题读挂载后的几何：用量文本、`usage.closest('details') === null`、页脚与文档溢出均为 0；摘要只剩一个 svg（chevron 12×12）、`list-style-type: none`、`transform` 由 `none` 变 `matrix(0, 1, -1, 0, 0, 0)`；展开文字与摘要文字 x 相同（375：32/32，1024：193/193，1440：516/516）。截图与读数在 `tmp/UI-08-usage-source-disclosure/`。`tests/assistantModeSwitch.spec.ts` 50/50（含「消息底栏：复制键在左，用量常显在右侧且没有折叠入口」）；token 数值口径与后端统计逻辑未动。

### 9.28 输入器底栏垂直对齐与窄窗尾部组（2026-11-01）

2026-11-01 UI-COMPOSER-ALIGN：用户截图以水平参考线指出输入器底栏「视觉重心不一致」。真实 Chromium 逐控件量了包围盒、文字 Range、SVG 框与**墨迹加权重心**（非只读 `align-items:center`），把盒模型、文字度量与 SVG 路径分开判定。三处根因都在结构，不在观感微调：

**① 尾部组悬在两行之间（主因）。** `.agent-chat-composer-tools` 自己 `flex-wrap` 后，`.agent-chat-composer-actions` 的 `align-items:center` 会把尾部组（计量环 + 模型）与发送键垂直居中在**整个工具块**上，而不是任何一行。960 宽实测：工具两行中心 790／826，尾部组与发送键落在 808；390 宽五档换行时落在中间行 707，而最后一行是 779。修法是给 `.agent-chat-composer-tail` 与 `.agent-chat-send` 加 `align-self:flex-end`：与最后一行同高（两处都是 `control.height.compact` 32px）。单行时与原居中结果逐像素相同（1280 宽控件中心恒 826），换行后每行组内中心误差 0，960 尾部组改到 826、390 改到 779。

**② chip 折行溢出固定高度。** 工具行被尾部组挤窄后，权限标签在 390 宽被折成两行（文字 Range 高 37.5px），而 chip 的 `height` 固定为 32px，第二行溢出到相邻行。`.agent-chat-permission-chip` 与 `.agent-chat-options > summary` 补 `white-space:nowrap`：chip 是单行键，宽度不足时整枚换到下一行；长模型名仍由 `.model-selector-trigger-name` 的 ellipsis 收尾，不把发送键顶出卡外。缺上下文时出现的「选择任务/项目」chip 不套这条——它的项目名没有 ellipsis 容器，套上去会把长名字撑出卡片，保持旧折行。

**③ 行盒中心与控件中心差 2px（诊断口径）。** 正文与工具行的 4px 间距原先画在 `.agent-chat-composer-actions` 的 `padding-top` 里，行盒高 36px、盒中心 824，控件中心 826——按「底栏盒中心」画参考线会把整排读成偏下。间距改到行外 `margin-top`（flex 列自身 4px gap + 4px margin = 原 4px gap + 4px padding），视觉间距与输入卡高度不变（1280/960/390 分别为 123/159/267px），行盒中心与控件中心自此同线。

**SVG 光学补偿。** 盒模型与 SVG 盒都居中，只有路径重心偏离：完全访问档 `TriangleAlert` 墨迹加权重心 827.69（行中心 826），比同排 14px 标签（825.78）低 1.9px；`ArrowUp` 发送箭头重心 824.65，在实底方键里读成偏上。只对这两条路径各做 1px 反向量补偿（`translate:0 -1px` / `0 1px`），补偿后为 826.69 与 825.65；眼/手掌/圆勾/禁止、chevron、计量环与发送键方框均不动。含下伸部的拉丁标签（`gpt-oss-3.0-flash`、`普通 Agent`）文字墨迹重心比中文标签低约 1px，这是字体度量而非盒模型错位，不做位移。

**验证出口。** 自建浏览器量测矩阵：1280×900（DPR 1／1.25／1.5）、960、390，首条输入器与已有会话各一档；控件盒中心与工具行中心误差 0.00，各行组内中心误差 0，`composerScroll`／`pageScroll` 均为 0；权限/模式/普通讨论/模型/上下文/「+」六片浮层开合前后工具栏几何不变，Esc 均能收起；焦点环 2px 可见；在途停止态与菜单展开态同几何。截图与逐控件读数在 `tmp/UI-COMPOSER-ALIGN/`（亮色全卡、参考线、hover、focus、960/390 修复前后对照、暗色 token 探针）。回归：`defaultWriteTier` 2/2、`modelSelectorDropdown` 6/6、`composerSourcePanel` 5/5。产品当前只有亮色主题，暗色以场景实验室 dark token 档在真实输入器上做兼容探针，不宣称已交付暗色皮肤。未新增 token、未改后端 / API / 权限与排列顺序。

### 9.29 输入器图标键与缓存读数紧凑化（2026-11-01）

2026-11-01 UI-COMPOSER：底栏的两枚读数控件再收一档，目标是「更紧凑、更精细、切换不抖动」，不改任何数据来源与业务状态。

**① 润色键收为纯图标键。** `ComposerPolishButton` 仍是同一键位三态（空闲 / 在途 / 已润色），但不再画「润色」「润色中…」「撤销润色」三套常驻文字；键宽因此不再随状态变化。几何：`control.height.compact`（32×32 命中区）、`radius.control`、透明底；图标取 `font.size.body`（16px），比「+」与发送键的 `control.icon.size`（20px）低一档——辅助动作不与主控件同权。三态字形为 lucide `WandSparkles` / `LoaderCircle` / `Undo2`；在途旋转取 `motion.loop.spin`，`prefers-reduced-motion: reduce` 与 `html[data-motion="off"]` 下停转、字形仍是环。Hover / disabled / focus 全部沿用 `.agent-chat-tool` 与全局 `:focus-visible`，没有新增色值、阴影或彩色胶囊。动作名由 `aria-label`（「润色输入内容」「正在润色」「撤销润色」）承担；悬停提示复用 `usePathTooltip`，挂在**不占几何的槽位**上，因此禁用态（空草稿、在途发送、无连接、草稿超长）也能说明具体原因；已润色态的 `aria-describedby` 仍指向既有后果说明。

**② 缓存命中率收为「小图标 + 数值」。** 常驻文字从 `缓存命中 57%` 收成一枚 12px（`font.size.caption`）的 `Database` 图标 + `font.size.meta` 的 `57%`；数值 `tabular-nums`，读数变化不跳宽。**不用第二枚圆环**：同一行右侧已有 24px 的上下文占用环，再来一枚小环在余光里会被读成同一指标的两种尺寸；数据库图标 + 数值把「缓存命中」与「上下文占用」分开。图标描边取 `control.icon.stroke`（1.5px），比同排 20px 主图标轻一档。`role="img"` + `aria-label="缓存命中率 57%"` 把图标与数值合成一个可访问名称；悬停提示复用同一套 `usePathTooltip`，文案为「缓存命中率：57% · 缓存读取 2,685 / 上下文 4,710 tokens」，**不新建第二份用量来源**。数值仍走 `formatUsagePercent`：99.6% 不显示成 100%，`0%` 是真实读数，Provider 未上报或缓存读取超过输入时整项不渲染（只留圆环，不画成 0%）。

**③ 窄栏让位的是读数，不是布局。** 工具行容器（`@container composer-actions`）窄于 `37.5rem` 时 `.agent-chat-cache-hit` 整项收起：在 860×782 的实测布局里，工具行可用宽度已被「+」、档位、模式、润色、合并芯片与右端一组占满，再塞约 40px 只能让工具行多折一行、输入卡当场增高（DEV-0110 的同一条退回）。信息没有消失——点开右侧上下文圆环，详情浮层仍列出「缓存命中率」；宽回阈值以上自动恢复。命中率与圆环仍是两个独立读数，不合并、不互相顶替。

**验证出口。** jsdom `tests/composerDraftAssist.spec.tsx` **16/16**、`tests/collaborationWorkspace.spec.ts` 的 8 条缓存命中用例 **8/8**（三态无障碍名、禁用原因、悬停/聚焦提示、0% / 57% / 99.6% / 100% / 未上报、`aria-label` 与提示同源；该文件其余 15 条失败来自并行会话刚引入的 messages page `has_more` 与 `/activity` 契约，与本轮节点无关）；真实 Chromium `tests/browser/composerDraftAssist.spec.ts` **3/3**（32×32 命中区、16px 图标、悬停与聚焦提示、在途旋转环、撤销几何不变）、`tests/browser/composerCacheHitStability.spec.ts` **7/7**（860/1162/1280/1600 高度不变、长模型名不挤走发送键、缓存与圆环同中线）、`tests/browser/composerSourcePanel.spec.ts` **5/5**（工具行文档序）。截图在 `tmp/UI-COMPOSER-compact-controls/`（默认、悬停、已润色、窄栏、首条输入器、暗色 token 探针）。产品当前只有亮色主题；暗色仍按 §9.28 的实验室 token 反相做兼容探针，不宣称已交付暗色皮肤。未新增 token、未改后端 / API / Provider 用量口径。

