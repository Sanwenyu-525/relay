# 窄窗外壳折叠点下移（48rem–64rem 保留图标导航与近期工作两栏）

- 日期：2026-10-15。状态：Accepted（用户 2026-10-15 选定 D2「折叠点整体下移到 48rem」后进入实施；实施计划见 [2026-10-15-narrow-window-shell-fold.md](../plans/2026-10-15-narrow-window-shell-fold.md)）。
- 触发：用户 2026-10-15 在 150% DPI 的桌面窗口（约 960 CSS px）看到协作页只剩中栏，提问「桌面端好像没接入？」。复核结论是既有窄窗收纳规则生效，不是缺陷；但复核同时发现**契约与实现脱节**（见 §2），以及折叠点本身偏高。
- 约束来源：业务交互仍以[工作台交互](../../frontend/workbench-design.md)与契约为准；视觉与断点规则归[设计系统](../../frontend/design-system.md)，数值唯一源为 [design-tokens.json](../../frontend/design-tokens.json)。本 spec 不改变任何业务状态、权限、命令 Owner、API 与数据库。

## 1. 目标与范围

**目标**：把外壳的折叠点从 `width < 64rem` 下移到 `width < 48rem`，让 48rem–64rem 这一档（1023px 往下，**150% DPI 下正是常见的桌面窗口宽度**）保留完整三列外壳，不再只剩中栏 + 抽屉。

**本轮做**：

- `styles.css` 外壳折叠规则：`width < 64rem` 的两栏收起改为 `width < 48rem`；48rem–64rem 保留三列。
- 同区间保留近期工作栏拖拽手柄**关闭**（拖拽仍只在 ≥64rem 开放），侧栏列宽在该区间取 token 默认值而非用户拖拽宽度。
- 应用顶栏的 `☰` 导航按钮可见区间随之改为 `width < 48rem`；`/agent` 无面包屑时的顶栏整行收起规则同步从 `min-width: 64rem` 改为 `min-width: 48rem`，避免该区间出现空的顶栏带。

**本轮不做**（YAGNI）：

- 不新增/修改任何 token 数值：列宽仍取 `layout.navigation.railWidth`、`layout.shell.sidebarWidth`、`layout.workspace.centerMin`，断点仍取 `breakpoint.medium/large`。
- 不改抽屉内容、导航结构、`RecentWorkRail` 内部形态与数据语义；不引入 JS 侧 `matchMedia` 档位钩子（见 §5 代价 3）。
- 不改任何业务状态、权限、命令、API、数据库与 `data-testid` 命名。
- 不做全站推广；本轮只动外壳这一处。

## 2. 现状事实（2026-10-15 复核）

| 事实 | 证据 |
|---|---|
| `width < 64rem` 时图标导航栏与近期工作栏整体 `display: none`，`.app-frame` 退化为单列 | `styles.css:3208-3221` |
| 近期工作栏拖拽手柄在 `width < 64rem` 隐藏 | `styles.css:3213-3215` |
| `☰` 导航按钮基态隐藏、仅 `width < 64rem` 显示 | `styles.css:953-955`、`styles.css:3257-3259` |
| `/agent` 无面包屑时顶栏整行收起，规则**只挂在** `min-width: 64rem` | `AppShell.tsx:99`、`styles.css:989-992` |
| 两栏始终挂载，窄窗靠 CSS 隐藏而非卸载；抽屉里另挂一个 `RecentWorkRail` | `AppShell.tsx:136-178`、`AppShell.tsx:199-214` |
| 契约与实现脱节：token 写 `initialWidth 1280 / minWidth 960`，桌面壳实际 `inner_size(1160, 780)` 且**未设 `min_inner_size`** | `design-tokens.json`、`apps/desktop/src-tauri/src/lib.rs:984` |

真实 Chromium 复核（同一桌面壳，1440/1023/960/900px 四档）：≥1024 两栏在、顶栏收起；<1024 两栏收起、顶栏出现且 `☰` 可见、抽屉内有完整导航与「新对话」。**行为符合现有规则**，因此这不是 bug 修复，是折叠点与契约的重新定位。

## 3. 候选与取舍

| 候选 | 做法 | 结论 |
|---|---|---|
| 不改 | 维持 `< 64rem` 折叠，只补文档 | 已在本轮完成（token 描述 + `design-system.md`）。**不解决** 960 CSS px（150% DPI 的最小窗口）只剩中栏的观感 |
| 给窗口加 `min_inner_size(1024)` | 让窗口不能缩进窄窗档 | **否决**。1366×768 @150% DPI 的工作区只有 910 逻辑 px，强制下限会让窗口伸出屏幕；且 `min_inner_size` 是物理约束，解决不了「窗口本来就窄」的设备 |
| **D1：只保近期工作栏** | 48rem–64rem 保留近期工作栏，图标导航栏仍进抽屉 | 次选。近期工作栏是「我在哪」的事实列，图标栏是纯导航（抽屉 + `Ctrl+K` 命令面板 + 标题带搜索三重冗余），取舍成立；但留下一档「一半折叠」的中间态 |
| **D2：折叠点整体下移到 48rem（选定）** | 48rem 之下整体折叠进抽屉，之上保持三列 | **选定**。外壳成为「一步折叠」的整体：要么三列，要么单列 + 抽屉，不存在半折叠中间态；`64rem` 档位回归它本来的语义（大屏增强：拖拽手柄、附加装饰），不再承担外壳收纳 |

## 4. 目标规则

### 4.1 断点与列宽

| 视口宽度 | 外壳 | 近期工作栏列宽 | 拖拽手柄 | `☰` |
|---|---|---|---|---|
| `≥ 64rem` | 三列（导航 + 近期工作 + 内容） | `--relay-sidebar-user-width`（无则 `layout.shell.sidebarWidth`） | 显示 | 隐藏 |
| `48rem – 64rem` | 三列 | **仅** `layout.shell.sidebarWidth`（`clamp(11rem, 16%, 17rem)`），不采用户宽度 | 隐藏 | 隐藏 |
| `< 48rem` | 单列，两栏收起 | — | 隐藏 | 显示 |

- 48rem 处的几何下限：768 − 88（`layout.navigation.railWidth` 5.5rem）− 176（`layout.shell.sidebarWidth` 下限）= **504px**，仍高于 `layout.workspace.centerMin`（26rem = 416px）。900px 处内容列 636px，1023px 处 759px。协作页自己的容器折叠阈值（`container collaboration` 约 52rem）继续按内容列实际宽度自行生效，不新增规则。
- 用户拖拽宽度**不得**泄漏到 48rem–64rem：一台被拖到 20rem 栏宽的窗口缩到 768px 时会把内容列压到 448px 以下的可读边缘。该区间必须用列宽默认值。

### 4.2 顶栏

- `☰` 只在 `width < 48rem` 出现（外壳已折叠、需要抽屉时才出现）。
- `.app-topbar:not(:has(.breadcrumbs))` 的整行收起规则改为 `min-width: 48rem`：`/agent` 这类无面包屑页面在 48rem–64rem 不再留一条只有 `☰`、点开却是屏幕上已有内容的空抽屉。
- 有面包屑的页面（`/projects`、`/tasks`、项目/任务详情等）行为不变。

### 4.3 抽屉

内容与可达性不变：新对话 + 完整导航 + 近期工作。`narrowWindowNewConversation.spec.ts` 里「新对话只有一个 URL 入口意图、两个宿主共用同一 href」的结论继续成立。

## 5. 代价与已知取舍

1. **48rem–64rem 的内容列比现状窄 88px**（图标导航栏占位）。以 900px 为例：内容列 636px（D2）vs 724px（D1）。协作页在该宽度下会走自己的容器折叠（讨论/成果两页签），这是既有行为。
2. **该区间没有「只显示近期工作栏」的形态**：想要最小内容列的用户仍应把窗口拉宽到 64rem 以上，或缩到 48rem 以下用抽屉。
3. **抽屉打开时会多挂载一个 `RecentWorkRail`**（同一端点的重复只读）。两处都是同一个只读投影的读，不产生第二套业务状态、也没有写入；但两次挂载可能读到不同时刻的快照。本轮**接受**该重复，不为此引入 `matchMedia` 档位钩子——项目目前没有 JS 侧视口档位设施（仅 `motionPreference.ts` 用 `matchMedia`），为一个可接受的重复读取新建全局设施不划算。若实测出现可见不一致，单独立项。

## 6. 涉及文件

- `apps/workbench/src/styles.css`：`width < 64rem` 外壳收纳块迁到 `width < 48rem`；`☰` 可见区间；`:not(:has(.breadcrumbs))` 收起区间改为 `min-width: 48rem`。
- `apps/workbench/tests/browser/responsiveFoldGeometry.spec.ts:100-102`：`app-frame` 列数期望由 `width < 1024` 改为 `width < 768`，并在 768–1023px 增加「图标导航栏隐藏 / 近期工作栏可见 / 无横向溢出」。
- `apps/workbench/tests/browser/narrowWindowNewConversation.spec.ts`：843/833 两档的前提（两栏都收起、「新对话」只在抽屉）失效，改为按 §4.1 的三档矩阵重写；抽屉可达性用例保留。
- `apps/workbench/tests/browser/workbench.spec.ts:112-130`（390px）：两栏收起，**不受影响**，不改。
- `apps/workbench/tests/responsiveTiers.spec.ts`：只守卫断点取值与 range 语法，`48rem` 合规，**不改**。
- 文档：`docs/frontend/design-system.md`（§6 断点收敛语义、窗口尺寸段）、`docs/frontend/workbench-design.md`（§2 信息架构的外壳描述）。

## 7. 验证清单

1. `tsc --noEmit`、`vitest run`、`vite build` exit 0。
2. 浏览器（真实 Chromium）覆盖 700 / 767 / 768 / 900 / 1023 / 1024 六档，每档断言：外壳列数、图标导航栏与近期工作栏可见性、顶栏与 `☰`、无横向溢出、内容列 ≥ `layout.workspace.centerMin`；48rem–64rem 档额外断言近期工作栏可用其搜索与「新对话」。
3. 短窗（833×591）：近期工作栏内部滚动，不把内容列挤没。
4. 抽屉：<48rem 打开抽屉仍有新对话与完整导航，Esc 关闭并把焦点交还触发钮。
5. 真实 Windows 窗口（150% DPI）：拖动窗口跨越 1024px 时两栏与抽屉入口的切换符合 §4.1，无闪烁、无空顶栏带。
6. `node scripts/check-docs.mjs` exit 0。

## 8. 文档同步（实施后）

- `design-system.md`：§6「断点收敛」的语义映射补一句外壳折叠点已下移到 48rem；窗口尺寸段把「窄窗档由 ☰ 抽屉承担」的区间从「< 64rem」更正为「< 48rem」。
- `workbench-design.md` §2：外壳栏位与收纳规则同步。
- `design-tokens.json`：**预期零变更**（列宽与断点均为既有 token）。若实施中确需新尺度，先回本 spec 修订。
- `CODEX_NEXT_STEP.md`：完成后记一行范围、验证结果与剩余限制；成绩归[功能验收表](../../testing/overall-acceptance-2026-09-28.md)。

## 9. 待确认

- **D2 是否就是想要的形态**：48rem–64rem 保留三列（含图标导航栏）。若更想要该区间只保留近期工作栏（D1），改动点相同、断言矩阵不同。
- 150% DPI 下 768–1023px 的实际观感：48rem 折叠点是否偏低，需要真实窗口拖动确认（§7 第 5 项）。
- 抽屉与常驻栏的重复读取是否接受（§5 代价 3）。
