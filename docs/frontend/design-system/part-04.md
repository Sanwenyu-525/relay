# 视觉与组件规范：分册 04

角色：所属专题的唯一正文分册；2026-10-25 按原章节迁移，不改变原业务规则、日期、状态与证据范围。

[返回专题路由](../design-system.md) · [文档总入口](../../README.md)

按需读取本分册内的相关小节；跨章节约束沿链接核对，不能把本分册或历史措辞单独当作完整实现/验收结论。正文中的源码与命令路径沿用原有口径。

### 9.11 近期工作栏窄列：搜索框与行密度（2026-10-16）

用户报告 `/agent` 左栏在窄窗下把搜索框切断、会话行拥挤，并指引用上游同位界面为据。范围只有 `RecentWorkRail` 的搜索框与列表行样式（`styles.css`）加一处 placeholder 文案：**零新增 token、零新增色值**，路由、`data-testid`、命令与会话草稿 Owner 未动，Breaking Change：No。

**根因是同特异度的层叠失效，不是栏宽算错。** 全局 `.search-field` 带 `min-width: 12rem`、`control.height`、`radius.control` 与继承来的 `font.size.body`，且定义在 `styles.css` 靠后位置；栏内的 `.recent-work-search` 写在它之前、特异度相同（0,1,0），于是整块覆盖静默失效——搜索框仍按 192×40、字号 16 渲染，而本列下限是 §9.9 的 `clamp(11rem, 16%, 17rem)` = 176px，扣掉 `space.2` 内边距后内容盒只有 160px，`.recent-work { overflow: hidden }` 把它硬切掉 32px；768–1100 视口全部越界，1280 也还差 3px。修法用**双类选择器** `.search-field.recent-work-search` 抬高特异度，不靠调整声明顺序——顺序会随下一次样式表增删再翻一次。字号写在**容器**上：`.search-field input` 的 `font: inherit` 简体会压掉内层任何 `font-size`，上一版落在 input 上的 meta 声明从未生效。

| 断言项 | 修复前 | 修复后 | 依据 |
|---|---|---|---|
| 搜索框超出内容盒 | 32px（被 overflow 硬切） | 0px | 双类选择器 + `min-width: 0` + `width: 100%` |
| 搜索框高 / 字号 | 40px / 16px | 32px / 14px | `control.height.compact`、`font.size.meta`，与栏内其它控件同档 |
| placeholder | 「搜索已加载的项目或任务…」放不下 | 84px ≤ 114px 文字区（176px 档）；160px 档 84 ≤ 98，留 14px | 文案收为「搜索已加载项」，完整范围声明留在 `visually-hidden` 标签（栏底「查找更多任务 / 会话」作为第二声明处已于同日第四轮随入口删除，见下条） |
| 行高 / 行间距 | 48.48px / **2px** | 47.08px / **4px** | 行内纵向内边距与列表 gap 由 `space.0-5` 提到 `space.1`；纵向占位基本不变，但主副行不再贴着相邻行 |
| 行标题字号与容字 | body 16px → 121px 容 7.6 字 | meta 14px → 121px 容 8.6 字（160px 档 105px 容 7.5 字） | 徽标与时间戳降到 caption，主名独占 meta 档 |

**密度按上游同位界面校准，不自造分级系统。** 三条依据都在 `.research/upstream` 里，本轮逐条复核过：

- opencode 侧栏会话行（`packages/app/src/pages/layout.tsx:2012`、`:2027`）：主名 `text-14-medium … truncate`、副行 `text-12-regular … truncate`，容器 `flex flex-col min-w-0`——14px 主 / 12px 副正是本站 meta / caption 两档，且它同样靠**截断而非换行**处理窄列。它的文件树行（`components/file-tree-v2.tsx:102`）在更窄的列里下探到 `text-12-medium`，这条本站不跟（§4 下限）。
- opencode 可拖拽侧栏的最小宽度是 **244px**（`layout.tsx:1710`、`:2299`），比本站 176px 下限宽 68px。因此取它的**字号与截断做法**，不取它的栏宽——列宽属 §9.9 已定的外壳契约，不为一栏改全局比例。
- codex `tui/src/resume_picker.rs:2139` 的 `toolbar_for_width`：**先量再降级**——完整版式容不下才换紧凑版式，紧凑版式仍容不下就只保留当前聚焦的那一个控件；每个控件同时带全名与 `compact_label`。placeholder 的取舍照此办理：可见文案用短形式，完整语义不丢（由 `visually-hidden` 标签承担），而不是让文字在框里被切。

**两行方案接续（2026-10-16 用户确认，替代上表的列表行留白）**：保留 meta 标题 / caption 副行与单行标题截断；行内上下 padding 从 `space.1` 提到 `space.2`，主副行仍隔 `space.1`，副行至少保留一行 caption/ui 高度，缺少时间时也不塌缩。组间距从 `space.1` 提到 `space.3`；树线左侧缩进从 `space.2` 收到 `space.1`、线右内边距归零，将空间让给标题。副行以 caption 大小、muted 色的 `MessageSquare` 轮廓图标替代文字徽标，不再带底色；时间单行省略防止极窄列溢出，完整值保留在悬停与可访问名称中，日期简写规则归工作台 §28.1。当前项沿用 selection 底色、激活标记与字重。零新增 token、字号与默认栏宽不变，继续兼容 160–320px 拖拽范围。

**目标／目录入口接续（2026-10-16）**：根区块标题按用户层级反馈改为 meta + semibold + primary 与右侧折叠标记（淡底的常驻与否见下条，同日第二轮已收回悬停），三类根区采用同一结构；内层组名使用 caption + medium + secondary，组外与树线各内缩一档，条目使用 meta + regular、当前项 medium。区块之间以 `space.3` 留白与 `space.2` 内边距分隔（根区分隔线同日第三轮去掉，见下条）；Goal 图标使用 `Target`，实际目录才用 `Folder`，未知或未绑定项不伪装成真实目录。区块、Goal 与目录均可折叠，折叠偏好是唯一依据（定位展开的语义变更见下条），原项目任务分组偏好继续有效。列表仍是上段两行结构，同一会话在两种导航维度均可高亮。正文顶栏的关联目标与会话目录分别一行，目录只露末段、提示给完整路径，避免窄列里把目录信息全部挤掉。业务含义与证据缺失规则只归工作台 §28.1，不新增 token。 空态提示通过 `.recent-work .helper-text.recent-work-scope-note` 限定 caption 与 muted，避免被靠后的全局 `.helper-text` 正文档覆盖；短文案仅作空态提示，完整已加载范围仍可读。

**根区淡底收回悬停、条目离开树线（2026-10-16 同日第二轮截图反馈）**：三处纯视觉调整，不动结构与 token。① 根区标题的 `color.bg.subtle` 淡底由常驻改为**静止透明、hover 填 subtle、active 填 selection.hover**，并补 `motion.duration.fast` 过渡，与内层组标题同一套交互；三个根区连排时常驻淡底会读成三张卡片，字号档、字重、缩进与分隔线已经足够表达层级（该分隔线同日第三轮也按同一理由去掉，见下条）。② 空态短提示（「暂无关联目标」等）`text-align: center`：这一段没有可点对象，左对齐会读成还有一列没显示出来。③ `.recent-work-group .recent-work-list` 的线右内边距由 `0` 改为 `space.0.5`（2px），条目与画在条目左缘的激活标记一起右移——此前色带紧贴树线画，选中行读成「这根线属于这一行」。2px 是用户给的位移量，正好是 `space.0.5` 一档，不开新值。代价：条目可用宽度每档少 2px，窄列几何回归（176px 与用户拖到 160px 两档）仍达标，标题可容字数不变。折叠语义的变更（当前项所在区不再常驻强制展开，因此「工作区（目录）」收不起来）属交互契约，记在工作台 §28.1。实测（headless Chromium 1280×900，伪造 API）：根区标题静止 `rgba(0,0,0,0)`、悬停 260ms 后 `rgb(248,250,247)`＝`color.bg.subtle`；空态提示文字盒中心与父盒中心同 x；树线右缘到条目左缘 2px＝`space.0.5`，激活标记宽 2px；活动会话在段内时点 summary 该段 `open` 变为 false。真实 WebView2 窗口与多 DPI 仍未复验。

**根区分隔线移除（2026-10-16 同日第三轮截图反馈）**：按用户截图反馈去掉目标／工作区（目录）／任务入口三个根区之间的横线——`.recent-work-section + .recent-work-section` 的 `border-top` 删除，只留 `space.3` 上间距与 `space.2` 上内边距。理由与上条收淡底同源：淡底读成三张卡片，这三条横线同样把一列切成分段；层级由字号档、字重、缩进与留白承担已经足够。栏底「查找更多任务 / 会话」的 `border-top` 保留——它分隔的是列表与栏底动作，不是并列的根区，两者不是同一个视觉构件（该入口连同这条边框已于同日第四轮删除，见下条）。零新增 token、零新增色值，结构、折叠偏好与交互约定未动。实测（headless Chromium 1280×900，伪造 API）：4 个根区（含「已归档」）`border-top-width` 全为 0，相邻根区间距 12px＝`space.3`（下限断言 ≥ `space.2`），树线右缘距条目 2px、激活标记宽 2px、空态提示居中偏差 0px 不回归。`recentWorkRailDensity.spec.ts` 的新增常驻断言已锁住这几项；该文件本轮 5 条 4 绿，唯一红「会话行内触发器静止不占几何」为点击前可见性等待超时，经「还原分隔线→复跑同样红」排除与本轮无关，未代改也未删断言（该红已在同日第四轮定位并修复，见下条）。真实 WebView2 窗口与多 DPI 仍未复验。

**栏底「查找更多任务 / 会话」入口删除（2026-10-16 同日第四轮，用户确认）**：搜索框与栏底入口的职责重叠经取证确认——面板只读与本列相同的两个端点（任务仅第一页、无搜索翻页；会话集与本列一致且不含归档），能显示的这里都能显示，是更弱的重复入口，用户选定删除。`.recent-work-more`、`.recent-work-more-trigger` 与 `.rail-picker` 样式块随组件一并移除，栏底不再有任何常驻动作；这一列（搜索＋「更早的任务」）成为任务与会话的唯一导航入口，窄档换行遗留（见下）随之关闭。同轮把第三轮那条既有红定位修复：`recentWorkRailDensity.spec.ts` 的 ⋯ 菜单用例原用 `.first()` 点击行内操作按钮，而同一会话会同时渲染在「目标」与「工作区（目录）」两段、两份按钮的 `data-testid` 相同（目标区条目 testid 带 goal 前缀、按钮不带），命中的是从未悬停的目标区副本、触发器恒 `display:none`，改为按行定位被悬停的那一份后 **5/5 全绿**。零新增 token；路由、折叠偏好与几何基线未动。检查与运行成绩归[功能验收表](../../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

**不照搬的项**：§9.10 已判定原型的 9–10px 低于 §4 可读下限，本轮同样不下探——标题止于 meta（14px），辅助信息走 §4 已有的 caption（12px）。也不引入容器查询按栏宽切换字号：实际只有两档字号、一个断点，为它加一套分级属过度建设。

**160px 拖拽下限保持不动。** `SidebarResizeHandle` 的 `SIDEBAR_MIN_WIDTH_PX = 160` 比 token 下限 176px 还窄 16px，看着像两处不一致，但 160–320px 是 `relay.workbench.sidebarWidthPx` 的既有承诺（§5 与[工作台交互](../workbench-design.md)：旧值对新单栏仍然成立，不迁移、不清空）。本轮因此**没有**抬高下限，而是让这一档也自洽：它只要求容下 7 字（内容盒 105px），placeholder 留 14px 余量。

验证出口：新增常驻用例 `tests/browser/recentWorkRailDensity.spec.ts`，在 768 / 1000 / 1280 与「1920 视口 + 用户拖到 160px」四档实测上表数值（API 全部 `page.route` 伪造，不连数据库、不调 Provider），断言搜索框越界 ≤ 0.5px、placeholder ≤ 文字区 −8px、行高 ≥ `control.height.compact`、行间距 ≥ `space.1`、标题字号 = meta、容字 ≥ 该档下限，四档全绿。踩到一处度量陷阱：Chromium **不**通过 `scrollWidth` 暴露 `<input>` 的 placeholder 溢出（192px 文字放进 144px 盒里仍报不溢出），原先那条断言恒为假、等于没断言，改用 canvas 直接量文字宽。768 / 1280 / 1920 三档截图留本机 `test-results/rail-density/final-*.png`；运行成绩归[功能验收表](../../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

**遗留（本轮未改）**：176px 档栏底「查找更多任务 / 会话」会换行且切在词中（「…会 / 话」）。属既有实现，改法要么动文案、要么给它单独的窄档排版，是另一轮决定；几何用例只覆盖搜索框与列表行，不含该按钮。该入口已于同日第四轮删除，此遗留随之关闭。

**搜索框光标高度与图标间距（2026-10-18，用户两轮截图指认）**：第一轮用户说「这个搜索框里面的光标也太小了吧？而且离搜索这个词太近了」，第二轮补「光标能往左一点吗？那个放大镜图标右侧一部分好像是不能有内容的，这个区域宽度应该是能调小的」。**一句话结论：光标是行盒的产物，不是字号或控件高度；图标右侧那块「放不了内容」的区域就是 flex `gap`，本轮缩回 `space.2`。** ① 光标高度跟随**行盒**：本栏 input 沿用全局继承的 `font.lineHeight` 1.5（14px → 21px 行盒），实测光标 **11px 高、1 设备像素宽**（宽由平台绘制，CSS 没有加粗属性，也没有 `caret-width` 这类属性），落在 32px 胶囊里就是一根小短线。② 行高写到**容器**上（`.search-field input` 的 `font: inherit` 会压掉内层任何声明，理由与上一版字号相同）取 `control.height.compact − space.1` = **28px**，光标 18–19px；再往上没有收益：≥30px 会顶满标签 30px 内容盒，且光标在 28px 时已触到字体内容高约 20px 的天花板（实测行高 21 / 28 / 32 / 40 → 光标 11 / 18.2 / 19.4 / 19.4）。③ **间距的两次纠偏**：第一轮把「离搜索太近」归因成间距，把 `gap` 从 `space.2` 提到 `space.3`(12px)；但真正的根因是 11px 小光标，光标修大之后那 12px 就读成一块空着放不了内容的死区（第二轮用户指认），**现调回 `space.2`(8px)**——`gap` 说明里留痕，避免下次又被「看着挨着」骗着再放大。图标同时从 `control.icon.size`(20px) 收到 `font.size.body`(16px，本文件「图标跟随字号」的既有写法，栏头「新对话」已这么做)，16px 图形配 14px 文字的比例更合理。**净结果与初版比**：图标 −4px、`gap` 不变，160px 拖拽档 input 96 → **100px**、placeholder 余量 12 → **16px**（密度用例的 −8px 断言留有 2 倍余量）。验证出口：`recentWorkRailDensity.spec.ts` 常驻用例「搜索框光标高度与图标间距」，同时锁**计算值**（行高 = `control.height.compact − space.1`、图标右缘→input 左缘 = `space.2`、行盒 ≤ 标签内容盒）与**像素实测**（截图取 `caret: "initial"`——Playwright 默认 `caret: "hide"` 会把光标抹掉、进而误判「测不到」，实测踩过一次；再扫最暗像素的连通列算光标高宽）。下限**不写死 px**：同一份 CSS 在 `dpr=1` 量到 15px、`dpr≥2` 量到 19px（修复前同法 8px / 11px），因此基准取「不低于字号 −1px」——光标矮于字号就读作小短线，正是用户截图里的样子，写死 19 或 16 会在另一档 DPI 上假红。该文件 **8/8** 通过。真实 WebView2 窗口与多 DPI 仍未复验。

**单行行与浮层菜单（2026-10-16 同日第五轮，用户截图与口述反馈）**：用户指出「去掉会话列表项里面的 item 的时间，像图片一样鼠标悬停显示 item 信息摘要；现在点击三个点位置会改变，而且弹出的垂直菜单样式不行」。四处一起改，**零新增 token、零新增色值**，范围覆盖会话行、任务行与归档区（用户选定「所有行统一」）：

| 项 | 修复前 | 修复后 | 依据 |
|---|---|---|---|
| 行高 | 两行（标题 + 图标与时间），行内 `space.1` 间距 | **一行**（可选图标 + 标题 + 置顶徽标同行） | 时间移出常驻几何；`min-height` 仍 `control.height.comfort` |
| 时间与归属 | 常驻在行内第二行 | 悬停／聚焦摘要卡：标题 + 右对齐时间 + 目录末段／项目名 | 用户要求「像图片一样」；行内不再重复写 |
| ⋯ 位置 | 展开后跳到「行 + 面板」的中线 | 展开前后逐像素不动 | `inset-block-start: 50%` 原先相对被撑高的 `<li>`，现锚在 `.recent-work-row-head` |
| 菜单形态 | 行下方就地展开，把以下整列推下去 | `position: fixed` 浮层下拉，不占这一列的布局 | 就地展开读不成下拉，也推挤列表 |

摘要卡与操作面板共用同一套浮层规矩：`position: fixed` + 组件按锚点实测位置写内联坐标（优先开在下方、放不下向上翻、横向拉回视口内），沿用 `zIndex.popover`、`shadow.floating`、`radius.control`／`radius.panel`、`border.separator`。这一列在 `.recent-work-scroll`（`overflow-y: auto`）里，绝对定位会被裁掉；而祖先链上没有 `transform`／`filter`／`contain`，所以 `fixed` 不引入 portal、DOM 仍留在这一行内。摘要卡 `pointer-events: none`（纯展示层，指针从行移到卡片上不闪断悬停态），滚动或点到别处即收起，固定坐标不会停在旧位置。实测（headless Chromium 1280×900，伪造 API）：静止态触发器 `display: none` 且行盒逐像素不变；展开后触发器 `top`／`left` 与悬停态一致、滚动容器 `scrollHeight` 不变、面板 `position: fixed` 且顶边不低于触发器底边、右缘与触发器对齐；摘要卡落在行右缘外并与行同一横带。运行成绩归[功能验收表](../../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

**同日第五轮收尾的三条微调（用户逐条指认）**，零新增 token、零新增色值：

| 项 | 改动 | 取值 |
|---|---|---|
| item 间距 | 行高压到紧凑档、竖直内边距与行间距同步收，行距由 48px 降到 **34px** | `min-height` `control.height.comfort`(44) → `control.height.compact`(32)；行内竖直内边距 `space.2`(8) → `space.1`(4) → `space.0-5`(2)（用户要求「再减小一点」）；行间距 `space.1`(4) → `space.0-5`(2)。命中区仍是整行宽，不缩窄 |
| 激活条位置 | 相对条目左缘右移 **3px** | `inset-inline-start` 0 → 3px。token 无 3px 档（`space.0.5`=2px、`space.1`=4px），按用户给定值写，标为待真实窗口复核 |
| 摘要卡时间 | **沿用原有口径，不加相对时长** | 用户明确「不用改」：今天时分／昨天／月日、跨年补年份，同组同名项补时分。参考图里的「6 小时」式相对时长会用掉「同名项靠时分区分」的依据，需要时单独一轮 |

**根区间距拉齐（同日，用户截图指认）**：目标↔工作区↔任务入口原来是 `margin-top space.3`(12px) + `padding-top space.2`(8px) = **20px**，而任务入口↔已归档只有一档 `space.3` = **12px**（组的下外边距）。用户以「任务入口和已归档的间距就很合适」为准，要求把前三处也改成同样式样 → 撤掉那条在分隔线删除后已属重复留白的 `padding-top`，四区视觉间距统一为 **12px**。判断依据是实测而非目测：`sectionContentGaps` 量的是「上一区最后一个可见条目的底 → 下一区 summary 的顶」，此前 `[20, 20, 12]`，改后 `[12, 12, 12]`。

实测（headless Chromium 1280×900）：行高 32px、行距 34px（下限断言仍为 `control.height.compact − 0.5`）；激活标记 `left` = 3px，`barWidth` 仍 `focus.width`，与分组竖线的距离不变；聊天消息正文字号 `font.size.body`(16px)、元信息 `meta`(14px)、输入器 `body`(16px)。`recentWorkRailDensity.spec.ts` 6/6，`tsc --noEmit` exit0。

**根区间距与行距收口（2026-10-16 第七轮，用户再次截图指认）**：用户拿三张实机截图复提同一列的三件事——「这四个根区间距没有统一，统一成任务入口和已归档的间距」「item 的间距再减小，而且要统一」「这两个之间也要减小间距」，另问「有些会话前面加了一个消息图标，有些没有」。取证（headless Chromium 1280×900，伪造 API，一次性探针量 `getBoundingClientRect`）发现第五轮那条「拉齐到 12px」只在任务入口展开时成立，行距也只落在一半列表上：

| 项 | 取证结果 | 修法 |
|---|---|---|
| 任务入口 ↔ 已归档 | 展开 12px、**收起 0px**（已归档贴着任务入口）；四区实测 `[12, 12, 0]` | 已归档段从 `recent-work-list` 包装层外移进层内，与三个根区成为相邻兄弟，`.recent-work-section + .recent-work-section` 覆盖全部三处间隙；仍挂在 `loadedCount` 之外，唯一一条会话归档后重开入口不消失 |
| 分组内行距 | 36px（`space.1` 4px），已归档区 34px（`space.0-5` 2px）——同一列两档 | 撤掉 `.recent-work-group .recent-work-list` 的 `gap` 覆盖，一列只有一档行距 34px（= 32px 行高 + 2px）；密度用例行距下限断言随同从 `space.1` 收到 `space.0-5` |

根因与 §9.11 开头同源：**相邻兄弟选择器管不到隔了一层包装的兄弟**——第五轮只撤了 padding，没注意到包装层让「任务入口 ↔ 已归档」的 12px 历来靠末组 margin 塌穿包装层凑数，展开时侥幸对齐、收起即塌方。消息图标不是缺陷：`MessageSquare` 只画在会话行（`kind === "session"`），任务行没有，是用一枚图标区分两种行类型，可访问名称另带「会话 · 」前缀；第五轮起它改在标题同行，不再占副行。验证出口：`recentWorkRailDensity.spec.ts` 新增常驻用例「任意折叠组合下四个根区间距同一档，分组与已归档行距同一档」（含归档段展开后行距同档、任务入口收起回归、全部收起回归），该文件 **7/7**；`sessionRowMenu.spec.ts` 的 `rowInActiveList` 辅助同步排除归档段副本（jsdom 折叠不摘子节点，全局 testid 会假通过）**7/7**；`liveTasks.spec.ts` 的 `sessionsUrl` 期望补上 `include_context=true`（此前未提交改动留下的存量偏差）后四文件 **30/30**；`tsc --noEmit` exit0。真实 WebView2 窗口与多 DPI 仍未复验。

**块间距再收一档（2026-10-16 第八轮，用户「间距还是太大」）**：条目行距已触紧凑 token 下限（32px 行高 + 2px = 34px，再降要么破 `control.height.compact`、要么行距归零），唯一还能收的是块间距。根区 margin 与分组下外边距同步由 `space.3`(12px) 收到 `space.2`(8px)——两者必须同步：分组下外边距原为 12px，会塌穿包装层把「末组 → 下一根区」的间隙顶回 12px，只改根区 margin 没有效果。收完后层级留白成为 8px（根区↔根区、分组↔分组）→ 4px（段标题→分组）→ 2px（条目）的整档缩放，零新增数值。段标题→分组的 4px 与条目内的 2px 本轮未动。实测（headless Chromium 1280×900，伪造 API）：三处根区间距 `[8, 8, 8]`、分组 margin `4px/8px`、条目行距 `[2, 2]`、段标题→分组 4px；`recentWorkRailDensity.spec.ts` 的同一档断言随同从 `space.3` 改指 `space.2`，该文件 **7/7**。真实 WebView2 窗口与多 DPI 仍未复验。

**根区间距再收一档（2026-10-20 第九轮，用户截图「这四个的间距再减小一点」）**：四个根区（目标／工作区（目录）／任务入口／已归档）之间的留白由 `space.2`(8px) 收到 `space.1`(4px)，分组下外边距随同从 `space.2` 收到 `space.1`——第八轮已证实的塌穿机制（分组下外边距会穿过 `<details>` 与相邻根区 margin 合并取大，不同步收则实测间隙被顶回 8px）。条目行距 34px、段标题→分组 4px、条目内 2px 均未动；层级留白成为 4px（根区↔根区、分组↔分组、段标题→分组）→ 2px（条目），仍零新增数值。实测（headless Chromium 1280×900，伪造 API）：三处根区间距 `[4, 4, 4]`，展开／收起任务入口／全部收起三种折叠组合下同档；`recentWorkRailDensity.spec.ts` 的同一档断言随同从 `space.2` 改指 `space.1`（`sectionGaps` 下限与 `sectionContentGaps` 精确值两条），该文件全绿。真实 WebView2 窗口与多 DPI 仍未复验。

**根区间距收到 2px（2026-10-20 同日第十轮，用户「减小到2px」）**：四个根区之间的留白由 `space.1`(4px) 收到 `space.0.5`(2px，用户给定值，恰为既有最小档，与条目行距同档)，分组下外边距随同收到 `space.0.5`——塌穿理由同第八、九轮，不同步收则「末组 → 下一根区」的间隙被顶回 4px。分组↔分组与段标题→分组的 4px 不变（分组上外边距主导塌穿取大），条目行距 2px 不变；根区↔根区与条目行距自此同档。实测（headless Chromium 1280×900，伪造 API）：三处根区间距 `[2, 2, 2]`，展开／收起任务入口／全部收起三种折叠组合下同档；`recentWorkRailDensity.spec.ts` 的同一档断言随同从 `space.1` 改指 `space.0.5`（该用例读取函数里第九轮引入的 `space1` 基准与 `space2` 一并清出，断言复用既有 `space05`），本轮改到的两条根区用例绿。同文件里批量删除浮层改造是并行会话的同日在途工作（用户另一指令），其用例状态不归本轮。真实 WebView2 窗口与多 DPI 仍未复验。

**分组上外边距收到 2px（2026-10-24 第十一轮，用户截图圈出「任务入口」下两条分组行「上下间距有点大，缩小一点」）**：第十轮只收了根区↔根区与分组**下**外边距，分组**上**外边距（`space.1` 4px，同时决定段标题→分组与分组↔分组两档）有意留在 4px。本轮由 `space.1` 收到 `space.0.5`(2px)——红框两条分组行上方（「任务入口」段标题→第一组）与相互之间的间隙随同降到 2px，与条目行距、根区↔根区、末组→下一根区同档，整列竖向节奏自此统一为 2px，仍零新增数值。分组下外边距本就是 `space.0.5`，无需再动；塌穿机制不变（末组下外边距仍穿 `<details>` 与相邻根区 margin 合并取大，三种折叠组合下根区间距仍是 `[2, 2, 2]`）。实测（headless Chromium 1280×900，伪造 API，元素盒 `getBoundingClientRect`）：段标题→分组 2px（原 4px）、分组↔分组 2px（原 4px）、末组→下一根区 2px、根区↔根区 2px、条目行距 2px；`recentWorkRailDensity.spec.ts` **11/11** 与 `recentWorkDragLine.spec.ts` **6/6** 全绿（两条用例量的是 section 盒间距与行距，不钉分组 margin，断言无需改动）；`recentWorkPagination.spec.ts`／`sessionRowMenu.spec.ts`／`folderFirstConversation.spec.ts` 共 **69/69**（其中两例在 5s 默认超时下因本机负载超时，`--testTimeout=30000` 复跑通过，与本次改动无关）。真实 WebView2 窗口与多 DPI 仍未复验。

**⋯ 菜单条目左对齐与文字色（2026-10-17，用户指认「选项的文字要左对齐，文字颜色用黑色，危险操作像是归档用红色」）**：三条动作（置顶／重命名／归档）在浮层里**左缘对齐、图标在前**，常规条目文字取 `color.text.primary`（墨绿黑），归档取 `color.status.danger.text`（红），命令提交中的禁用态回到 `color.disabled.text`。**零新增 token、零新增色值**，条目几何（高度、内边距、字号、图标档）一字未动。根因是 §9.11 反复踩到的同特异度层叠：共享基座 `.text-button` 把 `justify-content: center` 与 `color: color.action.text`（森林绿）声明在本列规则**之后**、同为 (0,1,0)，所以 `.recent-work-row-action` 里那条 `flex-start` 从未生效、常规条目一直读成居中绿字——这与第五轮记录的「danger 状态色从未生效」是同一处机制的另一半。修法沿用本文件既有惯例：把需要覆盖的两条属性抬到 `.text-button.recent-work-row-action` (0,2,0)、danger 抬到 (0,3,0)，与声明顺序无关；只覆盖这两条属性，不整块搬高条目规则（那会连带把 `min-height` 从基座的 `control.target.minimum` 顶成 `control.height.compact`，属未请求的几何变更）。图标靠 `currentColor` 自动跟随新文字色，无需单独改。验证出口：`tests/browser/recentWorkRailDensity.spec.ts` 的 ⋯ 菜单用例把原先「归档色 ≠ 常规色」的弱断言换成三条 computed `color` 逐一等于 token 解析值（探针节点解 `var(--relay-*)`）、且常规条目**不等于**基座动作色，并新增三条 `justify-content` 全为 `flex-start`，该文件 **7/7**；`sessionRowMenu.spec.ts` **8/8** 未回归；`tsc --noEmit` exit0。归档态那一条「重开这段讨论」与三条动作共用同一类，本轮未单独取证。真实 WebView2 窗口与多 DPI 仍未复验。

**未读圆点与两项行内动作（2026-10-17）**：未读会话在**类型图标与标题之间**画一枚圆点——`space.1`(4px) 见方、`radius.round`、`color.action.primary`，**零新增 token、零新增色值**；状态同时追加进行可访问名称（「· 未读」），不只靠颜色。行内菜单同日增加「标记为未读／取消未读」（`Mail`／`MailOpen`）与「复制会话 ID」（`Copy`）：前者与置顶同属常规条目色，后者不承载服务端事实、复制成功时同一行文案换成「已复制会话 ID」并在 1.6s 后复原；归档仍是唯一状态色条目。条目几何、分组细线与浮层外壳（§9.14）未动。验证出口：`recentWorkRailDensity.spec.ts` 的未读用例断言圆点存在性（另一条未读标记为 null 的会话不画）、边长 = `space.1`、正方形、颜色 = `action.primary` 解析值，⋯ 菜单用例断言五项顺序与五枚图标，该文件 **7/7**；`sessionRowMenu.spec.ts` **10/10**（含复制零命令、零重读、修订不变）。真实 WebView2 窗口与多 DPI 仍未复验。
**未读行的强调与删除确认浮层（2026-10-19，用户指认「标记为未读之后会话 item 没有 ui 上的变化、不够明显」）**：上一条 0104 的「只画一枚 `space.1` 圆点」由本条接替，两处同时改。① **未读不再只靠一枚点**：圆点边长由 `space.1`(4px) 提到 `space.1 + space.0.5`(6px)，未读行的标题字重升到 `font.weight.semibold`，类型图标由 `text.muted` 提到 `text.secondary`。字重是第二道、也是不靠颜色的那道——12px 的 meta 标题旁一枚 4px 的点会被读成图标的一部分；底色不参与，`selection.bg` 已被选中态占用，未读不能借同一档灰绿。当前行本来就是 `medium`，未读再加到 `semibold`，因此「既选中又未读」仍读得出未读。② **删除确认改成贴着 ⋯ 的就地浮层**（用户指令「这个弹窗改成这样的简单弹窗」）：外壳复用 `.recent-work-row-panel` 的 `fixed` 定位与「越界拉回视口」的规矩，但方向与动作面板相反——这张卡比 176px 的左栏还宽，开在 ⋯ 左侧会被推到窗口左缘、尖角指不回触发器，所以它与触发器**竖直居中、开在右侧**，右边放不下才翻回左侧。尺寸：`min(16rem, 100vw - space.4)`（并显式 `max-width: none`，基座那条 15rem 是给「跟条目同宽」的菜单兜底的）、`space.3` 内边距、`space.2` 条目间距；标题 `font.size.body` + `font.weight.semibold`，后果句 `font.size.meta` + `text.secondary`，两键取 `control.height.compact` 一档（窄卡里用 `control.height.prominent` 会把它撑成一条对话框），并各取 `flex: 1 1 0` 等分铺满内容宽——菜单条目本来就是满行宽，两键沿用同一条左右边界，卡片左右各一档 `space.3` 的内边距就是外间距、两键之间一档 `space.2`（2026-10-19 用户指令「删除放左边」「删除和取消的宽度加起来要和菜单一致」）。小尖角 8px、转 45° 贴在卡片左缘（`rotate(-45deg)`）指回 ⋯，翻到左侧时改贴上沿；尖角只用 `border.separator` 与 `bg.surface` 画，零新增 token、零新增色值。失败说明在这一层不吃动作面板那条 10rem 窄档（`max-width: none`），否则阻止项会折成碎行。验证出口：`tests/browser/recentWorkRailDensity.spec.ts` 的未读断言改为「边长 = `space.1 + space.0.5`、未读行字重 > 已读行字重」，⋯ 菜单用例的动作列表随之补到七项（末项「删除」）；jsdom 侧归 `tests/sessionRowMenu.spec.ts`（**19/19**）。真实 WebView2 窗口、多 DPI 与小尖角的亚像素对齐仍未复验。

**目录行悬停「＋」（2026-10-18，用户指令「鼠标悬停 item 的时候要显示一个新建会话的按钮」）**：有真实路径的目录组 summary 在悬停或键盘聚焦（`:focus-visible`）时，右端显形一枚「＋」——`control.height.compact` 见方、透明底、无边框（悬停也不铺底），图标取 `font.size.caption`、`color.text.secondary`，指针落在按钮上转 `color.text.primary`。静止 `display: none` 不占任何几何；显形时绝对定位压在数字徽标那一格，徽标以 `visibility: hidden` 让位但**仍占宽**，因此行盒高度、顶边与标题可用宽度三者在两态下逐像素相等。按钮必须是 `<summary>` 的兄弟节点：summary 的后代不得是交互内容。**零新增 token、零新增色值**。验证出口：`recentWorkRailDensity.spec.ts` 新增用例实测静止/悬停两态的 `display`、徽标 `visibility`、summary 顶/高与标题宽度逐像素相等，指针从行移到「＋」上仍保持显形，该文件 **9/9**；`recentWorkPagination.spec.ts` 与 `folderFirstConversation.spec.ts` 共 **33/33**（含入口只导航零命令、`?dir=` 种子只发一条 `openFolder`、首条发送才建会话并先绑目录）；`tsc` 无本改动错误（并行实例另有 3 条与本次无关的既有错误：`scheduledTasks.ts` 未使用符号、`conversationDiffLayout.spec.ts` 两条 TS2451，未触碰）。真实 WebView2 窗口与多 DPI 仍未复验。

**会话行的批量选择复选框与批量删除条（2026-10-20，用户指令「给会话 item 加一个复选框，方便删除记录」）**：复选框与类型图标**同一格**——绝对定位、`inset-inline-start: space.2`、竖直居中，尺寸取 `font.size.meta`(14px)，比 12px 的 `.recent-work-kind` 大一号才压得住；显形时图标以 `visibility: hidden` 让位（仍占宽）。**零新增 token、零新增色值**。显形规则与同栏 ⋯ 完全一致，只有三种时机：本行 `:hover`、本行 `:focus-within`、本行 `[data-selected="true"]`；**不做整列常显**（2026-10-20 用户指令「复选框不要常显」——勾了第一条就让整列冒出方框，这一栏会被读成一排勾选框而不是会话列表，12px 的类型图标也会整列消失），静止 `display: none` 既不占位也不进 Tab 序。**行内几何一像素不动**：复选框是行按钮的兄弟节点（`<button>` 里不能套可交互控件），只叠在图标那一格，因此 160px 拖拽下限下的行高 32px、行距 34px 与标题可用宽都与改造前相等（实测 1280×900、伪造 API：复选框 `112–126`、原图标 `112–124`、标题左缘 138、行高悬停前后同为 32px；勾选后指针移开，只有 `[data-selected]` 那两处副本 `display: block`，其余行全为 `none`）。已勾选的行在 `<li>` 上铺一档 `color.selection.hover`——画在 `<li>` 而不是行按钮上，激活行自己那档 `selection.bg` 才不会被抢走，两者可同时成立。批量删除条是这一栏里唯一的固定带（搜索框与列表之间），`bg.subtle` 底 + `border.separator` 边 + `radius.control`，`space.2` 内边距与一档 `space.1` 行距；计数行取 `font.size.meta` + `medium`，后果句取 `font.size.caption` + `text.muted`。**取消态与确认态都是两个等宽键**：两键直接复用 ⋯ 面板删除确认的 `.recent-work-confirm-actions`（`flex: 1 1 0`、`control.height.compact`、键间 `space.2`），左右边界与上面两行文字同一条——实测内容宽 169px 上「删除」`94–174`、「取消」`182–263`，各 80px，左键左缘与右键右缘正好落在批量条内容盒两端（2026-10-20 用户指令「确认删除的弹窗要左右对齐，对称」）。验证出口：`sessionRowMenu.spec.ts` 新增四例（**23/23**）、`recentWorkRailDensity.spec.ts` **10/10**（行高与行距基线未回归）。真实 WebView2 窗口与多 DPI 仍未复验。

**同日第二轮：计数行居中、右键收成「取消」、两键收窄、阻断说明按原因合并（2026-10-20 用户截图指令「已选多少讨论要居中，取消选择改成取消」「删除和取消可以离近一点」）。** ① 计数行与后果句由左对齐改 `text-align: center`——批量条只有一列内容，文字靠左、两键居中会读成两条对齐轴。② 取消态右键文案由「取消选择」收成「取消」，与确认态同名；两态不同时出现，不产生歧义。③ 两键不再各占一半铺满内容宽：`flex: 0 1 auto` + `min-width: 3.5rem` + `justify-content: center`，按内容宽收窄、成对居中，与上面已居中的计数行同一条中线。早先那条「左右对齐、对称」约束的是两键自身等宽对称，不是必须铺满；⋯ 面板那张删除确认卡仍走基座 `.recent-work-confirm-actions`（各占一半），本次未动。④ 被引用阻止的多段不再逐条重复整句：`describeLiveError` 为 `SESSION_DELETE_BLOCKED` 增补结构化 `blockedReasons`，批量条按原因聚合——原因写一次、标题并列（同名去重后写成「「×」等 3 段」），「先改为归档，或在原对象解除引用后再删除」那句只出现一次；单条删除仍读 `message` 整句。零新增 token、零新增色值。验证出口：`sessionRowMenu.spec.ts` 新增一例「同因被阻止的多段合并成一句」（**24/24**）。真实 WebView2 窗口与多 DPI 仍未复验。

**同日第三轮：从固定带改成浮层（2026-10-20 用户「这不就是改变了竖直方向的位置吗？不是一样的吗？你可以做成弹窗什么的」）。** 前两轮只改竖直位置，整条仍参与 `.recent-work` 的 flex 流，勾选一样占掉列表高度。本轮改为绝对定位浮层：脱离 flex 流之后，列表的可视高度、顶边、首行位置与滚动范围在勾选前后逐像素不变（浏览器用例实测三项全等）。浮层自己取 `color.bg.surface` + `shadow.floating` + `radius.panel`：栏底是 `bg.subtle`，同色读不出层次，只靠阴影不够。**不做全屏遮罩**——2026-10-19 那条「删除确认改成贴着 ⋯ 的简单弹窗」已经否掉过一层遮罩，这里沿用同一读法。贴底那一版还补过 `padding-block-end = 浮层高 + 8px`，后续居中化时一并撤掉（居中后滚到顶或滚到底被盖住的行都会露出来，补了只会在滚动末端留一段填不满的空白）。

**同日第四轮：浮层挪到主内容区上方居中（2026-10-20 用户截图「应该大致放在红框部分」）。** 第三轮把它放在左栏内（先贴底、后居中），仍压着左栏列表，而用户圈的是主内容区上方的空白带。本轮改 `position: fixed`：不受任何滚动容器影响，既不占左栏列表高度、也不压左栏列表、还不跟聊天区一起滚。横向中心与顶边由组件量 `.app-main` 后以内联 `left/top/width` 写入（左栏宽度可拖、可折叠，写死一个 `left` 一定在某个栏宽下偏掉），宽度取 `min(320px, 主区宽 - 32)`；`transform: translateX(-50%)` 让 `left` 读作中心点，CSS 里另留一组「视口居中、距顶 5rem」的兜底值给量不到尺寸的环境（jsdom 的 rect 全 0）。浮层 `max-height: calc(100dvh - space.16)` + 内部滚动，红字再多也不越出视口。零新增 token、零新增色值。验证出口：`recentWorkRailDensity.spec.ts` 第 11 例「浮层浮在主内容区上方居中、不占左栏列表高度」——勾选前后左栏列表 `top`/`height`/首行 `top` 逐像素相同、`padding-block-end` 保持 0、浮层中心与 `.app-main` 中心偏差 **0.008px**、顶距 **72px**、宽 **320px**、两侧都在主区内、两键 56/56 gap 8 居中偏差 0，**11/11**；`sessionRowMenu.spec.ts` **24/24**（按 `data-testid` 定位，与坐标无关）。真实 WebView2 窗口与多 DPI 仍未复验。

### 9.12 聊天消息时间线导航（设计补充）

2026-10-16 补充设计，同日实施首版并通过组件与真实 Chromium 伪造 API 自检；真实 Windows 窗口与 DPI 未验收。业务与阅读行为以[工作台 §31](../workbench-design/part-10.md#31-聊天消息时间线导航)为唯一来源；本节记录实际采用的呈现规则。

- 导航轨贴在聊天消息区左缘的预留留白内，节点是横向短刻度：默认 `space.2` 长、`focus.width` 粗、控件边框色；当前阅读节点加长到 `space.4` 并取主操作色，同时用 `aria-current` 表达，不仅依赖颜色。留白 = `control.target.minimum + space.2`，由 `:has(.agent-chat-timeline)` 只给消息流加 `padding-inline-start`，空会话没有轨道时不留白。轨道不占用近期工作栏，也不新增第二个消息流滚动容器——长会话由轨道自身滚动，正文滚动 Owner 仍是消息流。
- 可见刻度与命中区分开：刻度线很短，命中区始终是 `control.target.minimum` 见方（24px），窄档降级也不缩小。悬停/聚焦预览是紧凑浮层，标题走 meta、正文走 body、截断说明走 caption，沿用既有浮层背景/边框/圆角与 `shadow.floating`、`zIndex.popover`；宽度用新 token `layout.chatTimeline.previewWidth`（18rem），高度上限沿用本列两处浮层的 `min(60dvh, layout.workspace.sideWidth)`。浮层内容一律按纯文本片段呈现（含代码与用户贴入的标记），不解析成节点。浮层锚在刻度旁并按可视高度回拉，不越出消息区、不压输入器与发送按钮；跳转时主动收起，避免浮层停在刚定位到的正文上。
- 键盘：Tab 聚焦刻度、Enter/Space 跳转、Esc 关闭预览；预览打开时这一次 Esc 由时间线消费并停止冒泡，不落到面板的 Esc Esc 停止序列。焦点不因浮层出现漂移，浮层不抢输入焦点。
- 落点强调复用 selection 语义（`color.selection.bg` 一次性铺在目标消息上），时长取新 token `motion.duration.emphasis`（1.2s），不用持续闪烁表达当前位置。减少动态效果时跳转改为直接定位、强调去掉过渡：样式同时写 `@media (prefers-reduced-motion: reduce)` 与 `html[data-motion="off"]`，行为按 `resolveMotionPreference()` 实时判定。
- 窄档按**聊天列实际宽度**判定（`.agent-chat-transcript-shell` 容器查询，条件里不能用 `var()`，故按仓内既有写法写字面 `48rem`，与 `breakpoint.medium` 同源，改断点须两处同看）：收起常驻轨与留白，降为左缘紧凑展开入口；展开后轨道是浮层，不回头压缩正文。

本轮只在 `design-tokens.json` 单点新增两个确有缺项的值：`layout.chatTimeline.previewWidth`（现有浮层类宽度 token 都不面向这一列）与 `motion.duration.emphasis`（现有三档时长分别是控件过渡、面板过渡与循环，没有「一次性强调」档）。其余尺度全部复用既有 token，未复制第二套数值；刻度间距与 18rem / 1.2s 仍是本轮实测默认值，真实窗口验收后再冻结。

**同日第二轮：刻度组居中与悬停长度联动**。用户同日指认「时间线要在垂直方向上居中，鼠标在上面悬停移动时每一条横线以及相邻长度的横线长度要变化」。两处都只动刻度的呈现，节点身份、命中区（仍 `control.target.minimum` 见方）、跳转目标与全部 API 未动，Breaking Change：No。

| 项 | 规则 | 取值 |
|---|---|---|
| 刻度组位置 | 轨道可视高度内垂直居中；放不下时退回从顶排列 | 首/尾节点各 `margin-block: auto`，溢出时 `auto` 归零，第一条刻度仍可达 |
| 刻度三档长度 | 默认 / 当前阅读 / 悬停峰值 | `space.2`（8px）/ `space.4`（16px）/ `control.target.minimum − space.1`（20px） |
| 联动衰减 | 按「指针到刻度中心的距离」二次衰减，超出半径回默认档 | `base + (peak − base) × (1 − d/R)²`，R = 3 × `control.target.minimum`（72px，约上下各三条） |
| 联动方向 | 只加长、不压短 | 与当前位置那档取较大值，`aria-current` 刻度不会被压到 16px 以下 |
| 过渡 | 轨道内跟手、移出后复位 | 轨道带 `data-tracking="true"` 时该刻度 `transition: none`；移出后清变量与属性，按 `motion.duration.fast` 复位 |

**零新增 token**：三档长度与影响半径全部是既有 token 的组合（`space.1` / `space.2` / `space.4` / `control.target.minimum`），没有第二套数值。实现上长度写在节点内联自定义属性 `--chat-timeline-tick-width`（`::before` 宽度取 `var(--chat-timeline-tick-width, space.2)`），由轨道 `pointermove` 经 rAF 节流写入，不触发 React 重渲染；只认非 `touch` 指针（触屏点按没有悬停语义，避免抬起后残留一帧波形），切换会话与卸载一并清空，旧长度不留在新会话的轨道上。8 / 16 / 20px 与 72px 半径是实测默认值，真实窗口验收后再冻结。

