# 协作页 UI 优化设计（结构重塑 + 质感精修）

- 日期：2026-10-10。状态：Proposed（等用户评审 spec 后进入 writing-plans）。
- 依据：用户 2026-10-10 以运行截图发起「优化 UI」，经 brainstorming 逐问收敛；视觉参考为 [2026-10-02 选稿](../frontend/mockups/2026-10-02/conversation-workspace-selected.png) 与 [2026-10-01 工作主线图](../frontend/mockups/2026-10-01/work-first.png)。
- 约束来源：业务交互仍以[工作台交互](workbench-design.md)与契约为准；视觉规则归[设计系统](design-system.md)，数值唯一源为 [design-tokens.json](design-tokens.json)。本 spec 不得反向改变业务状态、权限或命令 Owner。

## 1. 目标与范围

**目标**：协作工作区（`/agent`，无任务的工作区级会话态）首屏不再「上压重引导、中空一大片」；结构贴 2026-10-02 选稿，质感在现有 token 体系内精修。用户明确选择的四项痛点区：③ 近期工作栏、④ 空态引导区、⑤ 对话消息区、⑥ 底部输入栏（① 标题带、② 左导航本轮不动）。

**本轮做**：
- `task === null` 的工作区级会话页（新对话空态 + 有会话态）的结构重塑与质感精修。
- 输入卡一体化、左栏密列表、引导内嵌、文件夹作用域细条化、「接续已有任务」入口迁移。

**本轮不做**（YAGNI）：
- 不动风格基调：仍为暖白/墨绿/Noto Sans SC/现有 token，不做暗色或新风格原型。
- 不动 ① 标题带与 ② 左导航栏；不动有任务态（`task !== null` 分支）的布局。
- 不新增任何色值、字号、圆角、动效数值；预计 token 零新增（若实现发现必需新尺度，先回本 spec 修订）。
- 不做全站推广——协作页定稿并验证后再按同规则推广，另立计划。
- 不改变任何业务规则、命令、状态机、权限与草稿保护逻辑。

## 2. 现状问题（截图与源码定位）

1. **顶部两条大折叠块**（`CollaborationView.tsx` `task === null` 分支）：`folder-scope-bar`（选择文件夹）与 `collab-existing-work`（接续已有任务）以 `details` 大块压在消息区上方；展开后体量大（按钮组 + 长段解释 + 目录路径），折叠时又只露一行摘要——不新不旧。
2. **左栏一栏一任务**（`RecentWorkRail.tsx`）：截图里「近期的任务 · 已加载 1 项」只躺一个任务卡，其余是空白；没有「新对话」入口、没有分组。
3. **首屏空**：无会话时欢迎语与输入卡居中，但引导信息（怎么开始、资料怎么加）散落在折叠块里；有会话无任务时消息区只有一条「你好」。
4. **输入行在卡外**：工具行（模式切换 chips、资料 0、普通通过、缓存未采集、发送键）渲染在输入框下方卡外，视觉上输入框与操作行是两段。

## 3. 目标结构

页壳保持「图标导航 ② + Relay 栏 ③ + 主区 ④⑤ + 输入区 ⑥」三层，外壳不动，只重排中栏。

### 3.1 Relay 栏（RecentWorkRail 重塑）

- **「＋ 新对话」置顶**：`primary-button` 小尺寸（`control.height`），专栏头行右侧；与既有 `agent?new=<key>` 唯一入口复用，不新建路由。
- **搜索框**保留（placeholder 沿用现有「搜索已加载的项目或任务…」，范围声明不变——只覆盖已加载），就地筛选。
- **最近的任务改密列表**：行高 `control.height.comfort`（2.75rem）；组标题按项目分组，`font.size.meta` + `color.text.muted`，带计数；默认展开、折叠状态存本地偏好；超出高度专栏内滚动（既有规则不变）。
- **当前会话高亮**：`color.selection.bg` 底 + 左缘 2px `color.action.primary` 激活线；会话与任务同列呈现，会话行带「未归属项目 / 项目名 · 时间」副行。
- **「↗ 查找更多任务 / 会话」**：专栏底部文字链，点击在专栏内**就地展开**任务/会话选择器（即原 `TargetPicker` 的载体迁移），不再弹对话框；展开态带「收起」，展开区与列表间用 `color.border.separator` 分隔。
- 空态沿用 `EmptyState compact`，首装/搜索无匹配/范围为空三种区分不变。

### 3.2 主区（CollaborationView `task === null` 分支重塑）

- **删除两个顶部 details 大块**；其承载的功能全部保留、换位呈现：
  - 文件夹作用域 → 输入卡上方的**常驻细条**（§3.3）。
  - 「接续已有任务」选择器 → Relay 栏就地展开区（§3.1）。
- **欢迎卡（空态）**：`collab-center` 中央，标题「这次想聊些什么？」`font.size.compactPage` + `font.family.ui` semibold；副说明 `body`；下方引导卡（`color.bg.subtle` 底 + `color.border.separator` 边 + `radius.control`）内嵌编号步骤：
  1. 选择或上传资料——输入区点「资料」添加文档、代码或日志；
  2. 直接粘贴内容——内容较少时直接粘到对话中；
  结尾一行 `meta`：添加资料后先确认读取范围再继续分析。
- **消息区**：已有会话时日期分隔、我（右、`bg.subtle` 气泡）/AI（左、无底色，既有规则不动）；生成中三点占位、取消、失败标签不变；「回到最新」悬浮 pill（`radius.round` + `shadow.floating` + `zIndex.popover`），仅离开底部时出现。
- **binding 区块**（归属 PENDING/CONFIRMED/UNKNOWN/FAILED）保留现有位置语义——紧贴细条下方，不折叠；UNKNOWN 的原命令回执核对按钮原位保留。

### 3.3 文件夹作用域细条

- 常态一行：📁 图标（`control.icon.size`）+ 目录名（`body` medium）+「已归入项目：X」或「未归属」（`meta`/`text.muted`）+ 右侧［更换目录］chip；底色 `color.bg.canvas`，上缘 `color.border.separator`。
- 未就绪（`folder.status === "NOT_READY"`）或未归属且用户将发起执行时：整条升为 `color.status.warning.bg` + `status.warning.text` 文字，说明「普通讨论可继续；执行写操作前需先选择目录」，原文案与 `disabled-reason` 语义不改写。
- 原 `folder-scope-bar` 内的 `FolderScope` 控件（打开原生目录选择/新对话）迁至［更换目录］chip 的 popover 内（`AppDialog`/浮层规则照旧），不新开路由。

### 3.4 输入卡一体化（⑥）

- 单个 `.agent-chat-composer` 卡（`radius.composer` = 1rem，`color.bg.surface` 底 + `color.border.control` 边）包住：textarea（无边框融入）+ 工具行 + 发送键；卡内不再可见「输入框/操作行」两段式断口。
- 工具行（行高沿用 `radius.composer` 既有契约：底栏行高与发送键一致 = `control.height.compact`）：
  1. **模式切换 chips 置首**：普通 Agent / 人设助手两枚 `radius.round` 胶囊，选中态 `selection.bg` + `selection.text`，未选透明底；保留既有 radio 语义与 `aria`（视觉改胶囊、语义不改）；人设助手新建/切换下拉入口收在 chip 的 popover 内。
  2. 资料 chip（`资料 N` + chevron）：禁用态（无项目/首条前）保留 tooltip 说明，不删。
  3. 「普通通过」`details` 下拉：文案与准入说明原位保留。
  4. ContextMeter 圆环 + 「缓存未采集/命中率」绝对文字：发送键左侧，照既有 `role="img"` + `aria-label` + `title` 规则。
  5. 发送键：右下，`control.height.compact`，在途时字形切换与「正在停止生成」禁用逻辑不变。
- 运行光点（在途提示）继续按[设计系统 §7.1](../frontend/design-system.md#71-输入区运行光点2026-10-05-选定局部光点)挂卡片上边，不因一体化改动位移或加倍。

## 4. 视觉精修规格（全部引用现有 token）

| 对象 | 规格 |
|---|---|
| 输入卡 | `radius.composer`、`bg.surface`、`border.control`；工具行两端的 `space.3` 内边距 |
| chips（模式/资料/动作） | `radius.round`、`border.control`、`bg.surface`；选中 `selection.bg/text`；hover `selection.hover`，时长 `motion.duration.fast` |
| 左栏任务行 | 高 `control.height.comfort`；主名 `rowTitle` 内降为 `body` medium（密排），副行 `meta`/`text.muted`；激活行 `selection.bg` + 2px `action.primary` 左线；分隔 `border.separator` |
| 组标题 | `meta` + `text.muted` + `font.weight.medium` |
| 欢迎卡 | `bg.subtle` + `separator` 边 + `radius.control`；标题 `compactPage`/ui/semibold；步骤 `body`；结尾提示 `meta` |
| 文件夹细条 | 常态 `bg.canvas` + `separator` 上缘；告警 `status.warning.bg/text` |
| 消息 | AI 无底色；用户气泡 `bg.subtle` + `radius.composer`；头像 `control.avatar.size`（既有）；时间 `meta` |
| 「回到最新」 | `radius.round` + `shadow.floating` + `zIndex.popover`；出现/消失 `motion.duration.fast` |
| 焦点 | 全局 `focus.ring`/`focus.width`/`focus.offset`，沿控件边界向内，不新增外圈 |

不新增 token；行高、间距、圆角、字重一律取上表既有值。对比度继续满足 `contrastChecks`（chips 选中态 = `selection.text` on `selection.bg` 已覆盖）。

## 5. 状态与边界

- **窄窗**（< `breakpoint.medium`）：左栏进抽屉（既有规则）；文件夹细条与输入卡保持；工具行 chips 允许换行但不溢出，发送键不掉出卡外。
- **中宽窗**（`breakpoint.medium`–`rail`）：沿用第 5 节既有断点行为，不发明新状态；「查找更多任务」在窄/中宽窗从抽屉或浮层进入，语义不变。
- **短窗**：消息区滚动、输入卡不遮末段；空态欢迎卡按内容高度排列，不垂直铺满（延续 §5.1 既有规则）。
- **空态三分**：首装（无任务/会话）/ 搜索无匹配 / 范围为空，文案区分不变，不用同一句覆盖。
- **在途/取消/失败/UNKNOWN**：消息行标签、停止入口（仅输入卡主按钮）、Esc Esc、回执核对——全部原位保留，只随输入卡一体化换容器。
- **草稿与离开保护**：首条草稿、已选资料、判断说明的 `DraftGuard` 与切会话/新建确认流程不变。
- **禁用与原因**：模式切换在途锁定（「正在生成，停止后才能切换会话模式。」）、资料禁用的 tooltip、归档禁写——文案与禁用条件不动，只换呈现。

## 6. 可访问性与键盘

- 模式 chips 保留 radio 语义与方向键行为（`ConversationModeSwitch` 现有实现），不得降级为纯 `div`。
- 「查找更多任务」展开区是 `aria-expanded` 按钮 + 就地面板，焦点移入、Esc 收起并返回触发点。
- 细条［更换目录］popover 焦点封闭、Esc 关闭、焦点返回。
- 「回到最新」是真实 `button`，非装饰。
- 新结构不引入仅靠颜色表达的状态；激活行同时有底色 + 左线。

## 7. 涉及文件（预期，实施时核对）

- `apps/workbench/src/views/CollaborationView.tsx` —— `task === null` 分支重排、删除两个 details 大块、binding 位置衔接、细条挂载。
- `apps/workbench/src/components/RecentWorkRail.tsx` —— 密列表、分组、新对话入口、就地展开选择器。
- `apps/workbench/src/views/CollaborationView.css` / `AssistView.css` / `styles.css` —— 输入卡一体化、chips、细条、欢迎卡、回到最新。
- `apps/workbench/src/views/AssistView.tsx` —— 工具行 DOM 收进输入卡；first-message 欢迎卡内容。
- 既有组件 `ConversationModeSwitch`、`ContextMeter`、`FolderScope`、`TargetPicker`、`EmptyState`、`AppDialog` 复用，不改其业务契约。
- 测试：`apps/workbench` 下相关 vitest 组件 spec 与 Playwright 布局 spec（实施时定位具体文件）。

## 8. 验证清单

1. `tsc --noEmit`、全量 vitest、`vite build` exit 0（工作台目录）。
2. 组件/浏览器：两个状态（空态/有会话）结构断言；窄窗 chips 换行不溢出、抽屉可用；「查找更多任务」就地展开与收起；模式切换 radio 语义与在途锁定；细条三态（有目录/未归属/未就绪）；「回到最新」显隐。
3. 真实 Windows 窗口：桌面控制实操两种状态（数据状态允许时），含中文 IME 组词不误发、DPI 100%/150% 下输入卡不破版。
4. `scripts/check-docs.mjs` exit 0；文档同步见 §9。

## 9. 文档同步（实施后）

- [workbench-design.md](../frontend/workbench-design.md)：新增「协作页结构重塑（2026-10-10）」小节，记录左栏迁移（TargetPicker 入口）、细条契约、输入卡一体化与状态绑定保留点；§14/§17 既有交互规则不改语义。
- [design-system.md](../frontend/design-system.md)：「可复用组件规则」补充 chips/细条/欢迎卡/回到最新四条外观规则（引用 token 名，不复制数值）。
- [design-tokens.json](../frontend/design-tokens.json)：预期零变更；若有新尺度先修订本 spec 再改 token。
- [CODEX_NEXT_STEP.md](../../CODEX_NEXT_STEP.md)：完成后记一行范围、验证结果与剩余限制；成绩归[功能验收表](../testing/overall-acceptance-2026-09-28.md)。

## 10. 待确认（已在本轮澄清，留档）

- 模式切换 chip 置输入行首：用户确认（2026-10-10）。
- 「查找更多任务 / 会话」就地展开，不弹对话框：用户确认（2026-10-10）。
- 工具行整体包进输入卡：用户确认（2026-10-10）。
- 欢迎卡标题用 `compactPage`（1.75rem）而非 `page`（2.5rem）：用户确认（2026-10-10）。
- 左栏行高 `control.height.comfort`（2.75rem）、项目分组默认展开：用户确认（2026-10-10）。
