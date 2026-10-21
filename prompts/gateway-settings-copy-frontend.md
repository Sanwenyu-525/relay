# 前端开发提示词：连接与权限「沿用其他项目配置」

后端已实现并验证（真实临时 PG 集成通过后本提示词才有效）。本提示词授权实施**前端入口**；后端不再改动。

## 已实现的后端接口

`POST /projects/:project_id/gateway-settings/copy`（目标项目 = 路径参数 `project_id`），命令 `CopyGatewaySettings`，HTTP 201，Body `{ command_id, source_project_id }`（均 UUID，`additionalProperties: false`）。契约全文见 [HTTP 契约 §10.101](../docs/api/http-command-contract.md#10101-连接与权限沿用复制2026-10-19-后端实现)。

- Result（全字符串）：`project_id` / `source_project_id` / `resources_created` / `connections_copied` / `policies_copied` / `skipped`。
- 语义：把来源项目的 ACTIVE 受管资源、连接（含边界 config）与 ACTIVE 策略的**当前生效版本**复制进目标项目；同 identity 资源、同 capability+action+target 策略、同 config+能力连接跳过并计入 `skipped`。判重只防连点类重复，语义幂等由 `command_id` 回执承担（重放返回原 result 与原 201）。
- 错误：来源=目标 → 422 `VALIDATION_FAILED`（field=`source_project_id`）；来源项目不存在/跨 Workspace → 404 `RESOURCE_NOT_FOUND`；项目已归档 → 既有归档守卫（`connections-archive-reason` 同一条文案来源）。

## 前端改动范围（只动这些文件）

- `apps/workbench/src/api/resources/information.ts` 或既有 gateway 资源模块：新增 `copyGatewaySettings({ targetProjectId, sourceProjectId, commandId })`，走既有命令信封解析（与 `createGatewayConnection` 同一条 `RelayApiError`/回执核对路径，不新造第二套）。
- `apps/workbench/src/views/ConnectionsView.tsx` 的 `ProjectConnectionsView`：在「项目身份与配置范围」`<details>` 附近新增一个 `<details>`「沿用其他项目的连接与权限」，内含：来源项目下拉（复用 `loadProjects` 同一条分页读取；或让用户从 `/connections` 项目列表点进来时预填）、一个提交按钮。**不做批量进度条**：一次命令、一个回执，成功后走既有 `refresh(client)` 重读列表并把 counts 写进既有 `message`（success-callout）。
- 提交走**既有** `sendCommand`/`resolveSuccess` 管道（`PendingCommand` 增加 type `CopyGatewaySettings`、`resultKey: null`、`targetId: null`），核对口径：`result.project_id === projectId && result.source_project_id === sourceProjectId`，成功消息形如「已复制 1 个连接、2 条策略、1 个受管资源；跳过 0 项」。422 时把 field=`source_project_id` 的错误显示为「来源与目标不能是同一个项目」。
- 禁用态：`writeBlockedReason !== null` 时按钮禁用并沿用同一条归档文案；`submitting` 期间禁用。

## 交互与异常处理要求

- Loading：读取来源项目清单失败时在该 `<details>` 内显示错误（复用 `describeLiveError`），不遮挡页面其它区块。
- 命令在途：沿用既有 `connections-pending` 提示条（原 command_id + 查询回执 + 原样重试），不新增第二套在途 UI。
- 不缓存来源配置内容；界面只显示 counts，不复述来源项目的连接细节（root path 等敏感值不由本接口返回）。

## 验证要求

- 组件测试（vitest + jsdom，挂 `mountWorkbench`）：① 下拉与提交发出 `POST /projects/:id/gateway-settings/copy` 且 body 含新 `command_id` 与选定 `source_project_id`；② 成功后重读列表并显示 counts 文案；③ 422 field=`source_project_id` 显示指定文案；④ 归档项目按钮禁用。
- `tsc --noEmit` 干净；`node scripts/check-docs.mjs` 通过。
- 未验边界如实记录：真实 Windows 窗口、Playwright 浏览器侧、双项目真实数据的端到端（由后端集成测试覆盖到服务层为止）。
