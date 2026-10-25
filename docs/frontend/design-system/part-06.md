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

**组件**：`components/PluginIcon.tsx` 只做「稳定插件 key → 静态资源」的映射与渲染，**不引入图标库、状态管理或第二套 token**。尺寸经 CSS 变量 `--plugin-icon-size` 下发，默认 `font.size.body`；消费方用既有 token 覆盖（菜单行 `font.size.body`、输入器徽标与消息 mention `font.size.meta`）。图标是装饰：默认 `alt=""` + `aria-hidden`，可访问名称由相邻文字或控件承担（菜单行按钮、徽标标签、mention 原文）。

**三处应用**（交互契约归[工作台 §32.9](../workbench-design/part-11.md#329-连接器与插件二级2026-10-17)与消息展示规则）：

| 位置 | 形态 | 几何 |
|---|---|---|
| 「+ → 连接器与插件」三行内置插件 | 图标 + 名称 + 行尾状态原位替换 | 图标位 16px（`font.size.body`），与相邻 Lucide 同档 |
| 输入器正文原位 | mention 文字画成「小图标 + 短名」芯片，跟在光标所在位置 | 图标 `font.size.body`（16px，2026-10-25 用户指认 14px 太小）、标签 `font.size.meta`，标签取 `color.action.text`，无底色、不占文本流 |
| 输入器 `@` 菜单 | 输入 `@`（可跟查询词）弹出三个内置插件，选中即把 `@query` 换成 `@标签 ` | 复用命令菜单外壳；行内图标 16px + 名称，左对齐 |
| 用户消息展示层 | mention 显示成小图标 + 短名，**不带 `@`**（2026-10-25 用户指认「这里不应该显示 @」） | 图标 `font.size.meta`，inline-flex + nowrap 不拆行；原文（含 `@`）仍在 message.content 里供复制 |

**输入器芯片的实现边界（2026-10-25，参考 Codex 输入器工具标识）**：textarea 仍是**唯一文本 Owner**——芯片是镜像层上的视觉件，不改 contenteditable、不改草稿协议：原生光标/选区/IME 组词/粘贴/撤销/发送载荷全部走原路径。做法是在同一盒模型里放一层与 textarea 同源继承字体、逐项相同盒模型（内边距/边框/折行规则）的镜像层，把同一段草稿原样排版；mention 文字在镜像层里**透明占位**（保证折行点与光标对齐），芯片按 mention 的实测矩形绝对定位叠上去。因此：芯片宽度贴近所替代的原文（实测偏差约 5px，不压后续文字）、与后续文字之间不留缝；textarea 弹出纵向滚动条时镜像层右侧让出同宽 gutter，两侧折行才一致；镜像层只在出现已知 mention 时渲染，其余情况输入器与此前逐像素一致。真实 Chromium 量测断言：镜像层与 textarea 计算样式逐项相同、单行正文宽度与同字体 canvas 测量一致（242.73 vs 242.72）、芯片矩形与 mention 矩形左/上/高偏差为 0、长草稿滚动后芯片仍对齐、窄窗 760px 三枚芯片不溢出。

**选中不能盖掉芯片（2026-10-25 用户指认「光标选中图标，图标会变成蓝色 @」）**：textarea 的默认选区是不透明的系统蓝，压在镜像层上会把芯片整个盖住，只剩 `::selection` 强制出来的白字。修法是给芯片态的 textarea 一条 `::selection`：底色取 `color.selection.bg` 的 55% 半透明、选中文字保持 `color: transparent`——芯片与正文从选区底下透出来，选区仍是可读的浅色底。这条只作用于 `data-chips="on"`（有 mention 的草稿），普通草稿的选区仍是系统默认。

**`@` 唤起菜单（2026-10-25 用户指认「输入 @ 没有弹出插件菜单」）**：输入 `@`（可跟 ≤12 字查询词）时在输入卡上方弹出三个内置插件，按名称过滤、↑↓ 选择、Enter 插入、Esc 关闭、点行同样插入；插入把光标前的 `@query` 换成 `@标签 `（query 后紧跟的空格一并吃掉，不留双空格），光标落在插入内容之后。边界与 mention 识别同源：`@` 在开头或前字符不是单词/路径字符才弹——输入邮箱 `user@` 不弹，中文前导无空格（`先用@`）照弹。菜单只编辑草稿、不发送、不授予任何能力；斜杠命令菜单展开时让位给它。

**边界**：芯片与消息图标都是**纯派生展示**——草稿与消息仍以纯文本为唯一事实，芯片不落库、不进发送载荷、不是第二份插件状态；删除或撤销 mention 后同步消失，手动输入与菜单插入得到同一枚。mention 识别只认明确的 `@电脑操控` / `@浏览器操控` / `@GitHub`，邮箱、路径、未知 mention 与更长词的一部分（含紧跟汉字的粘连）都不画芯片。其余通用操作仍用 Lucide；files/knowledge/automation 三枚已进资源与组件，但没有准确业务入口前不强行铺开。**明暗主题**：工作台当前只有浅色一套主题（无 `prefers-color-scheme` 分支），图标按浅色表面（paper/surface/subtle）校准。

**验证出口**：`tests/pluginIcons.spec.tsx`（六 key 资源映射与装饰语义、mention 边界、芯片派生与同步、消息原文保全）与 `tests/composerAttachMenu.spec.tsx` 的图标条（三行不串图、其余操作仍 Lucide）；`tsc --noEmit` 对新增文件零错误；`vite build` 产出六枚 PNG 并被 bundle 引用。输入器芯片的几何对齐由真实 Chromium 量测断言（镜像层与 textarea 计算样式逐项一致、单行宽度同字体基准一致、芯片叠放 mention 矩形偏差为 0、滚动与窄窗不漂移），jsdom 不量几何、不替代。真实 Windows/WebView2 截图与小尺寸、DPI 观感以浏览器用例与统一验收表为准。

