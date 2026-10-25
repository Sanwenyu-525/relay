# 2xx 命令响应无法核对时保留 pending

## 现象

Project 改名收到 2xx，但 `command_id`、Project 或 revision 与冻结命令不一致时，组件把校验异常当成明确业务拒绝并清除 pending。Project State 与 Goal 命令遇到 2xx 响应契约解析错误时也会清除 pending。服务端可能已经提交，这会让用户再生成新 `command_id` 提交同一事实。

## 根因

命令结果分类只覆盖传输错误、5xx 和 `COMMAND_ID_REUSED`。Project 改名校验抛普通 `Error`；State/Goal API 客户端抛出的 `RelayContractError` 未包含在“结果不明”分支。前端因此无法区分“明确拒绝”和“已收到 2xx 但响应不可核对”。

## 修复方案

- 将 Project 改名的身份、Project、revision 错配表示为专用响应错配类型。
- Project 改名、Project State 与 Goal 编辑把 `RelayContractError` 归类为结果不明。
- 保留原 pending、`command_id` 与载荷；用户必须先查询原回执，只有服务端明确返回 `COMMAND_NOT_FOUND` 后才可按原 ID/载荷重试。

## 修改文件

- `apps/workbench/src/components/ProjectTitleEditor.tsx`
- `apps/workbench/src/components/ProjectStatePanel.tsx`
- `apps/workbench/src/views/GoalDetailView.tsx`
- `apps/workbench/tests/projectManagementPanels.spec.tsx`
- `apps/workbench/tests/goalManagementLive.spec.tsx`

## 测试方式

- 四条回归用例在修复前复现 pending 消失；修复后定向 Workbench 六文件 50/50。
- Workbench `tsc --noEmit` 与 Vite production build exit 0。
- 独立只读代码复查确认修复分支保留冻结命令，且未发现其他 P0/P1。

## 遗留风险

真实 Windows/WebView2 窗口、Goal 详情/State 面板与多 DPI 仍待验收；浏览器和组件证据不能替代桌面验收。

## 防止再次发生

所有写命令必须区分明确业务拒绝与响应无法核对。收到 2xx 后解析失败或回执身份/版本错配时，不能清除 pending 或换 ID 重发；针对每种新增写命令保留“错配不宣布成功且冻结命令仍在”的回归用例。
