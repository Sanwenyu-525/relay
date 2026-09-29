# 整改 2026-09-28 · UI 证据（第三包）

对应提示词：`prompts/overall-remediation-2026-09-28.md` 第三包优先项 1–4、6–7（页面布局、文案、状态与 Pack 摘要）。

## 测量（fixture 模式，Playwright 计算样式）

见 [layout-measures.json](layout-measures.json)。

| 检查点 | 结果 |
|---|---|
| 任务 960×640 首行 y | **312**（整改前约 533/557） |
| 任务 1280×800 首行 y | 380 |
| 搜索框内层 input | border 0 / padding 0 / min-height 0（无双层边框） |
| 任务/知识/待审/今日/连接 h1 | 32px（compactPage） |
| 任务页 | `list-header--compact` + `list-toolbar--compact` |

## 知识页 live（真实 API）

见 `remediation-knowledge-live-1280-viewport.png`。

- 「新建」按钮：文本「新建」，`white-space: nowrap`，宽 66px × 高 48px，不再上下换行。
- 页签标签：资料 / 记忆 / 决定 / 规则（纯中文，枚举仍在 `data-testid`）。
- 空态文案：「当前范围还没有资料。点击右上角「新建」添加第一条资料。」

## 截图清单

| 文件 | 视口 | 路由 |
|---|---|---|
| remediation-tasks-960-viewport.png / -full.png | 960×640 | /tasks |
| remediation-tasks-1280-viewport.png / -full.png | 1280×800 | /tasks |
| remediation-knowledge-1280-viewport.png / -full.png | 1280×800 | /knowledge（fixture） |
| remediation-knowledge-live-1280-viewport.png / -full.png | 1280×800 | /knowledge（live） |
| remediation-reviews-1280-viewport.png / -full.png | 1280×800 | /reviews |

## 自动化

- `tests/uiRemediation20260928.spec.ts`：紧凑筛选类、搜索框无行内双框补丁、知识页中文标签与「新建」按钮。
- 全量 `npx vitest run`（apps/workbench）：346/346 通过（含本文件 2 项）。
- `npx tsc --noEmit`：通过。

## 未覆盖

- 真实 Windows 125%/150% DPI、33 页面/状态全量登记仍缺（见总验收 A05）。
- 连接「只读健康核对」仍不探测目录/主机可达性（A06 边界，未扩功能）。
