# Relay 工作台前端预览

本目录是**前端交互预览**：项目列表与创建、全部任务与新建任务、项目任务、任务详情（含产物与完成/重开）、待审与真实 Run 查询/控制，以及项目蓝图预览、完善任务定义、生成验收方案、继续这个项目。使用 Vue 3 + TypeScript + Vite，默认数据来自内存 fixture adapter。

默认不是生产前端，也不是桌面交付：没有完整生产 API 覆盖、没有真实 AI、没有 Windows 安装包。页面上的示例成功提示会说明“本次演示”，右下角常驻“交互预览 · 示例数据，刷新后重置”。2026-09-21 起可以显式连接本机 `apps/api`：页壳右上「数据来源」打开连接面板，填入 API 地址、Workspace ID 与 `RELAY_API_BEARER_TOKEN`，`/health/ready` 返回 200 才进入 live；凭据只存在当前页面内存，刷新即回到示例数据。live 已覆盖完整人工路径，并支持读取待审 Review；已有 AI Run 时，可从任务详情进入 Run 页查询与发起 P08 控制。工作台尚无 Delegate 入口。实现与验收状态见[前端预览记录](../../docs/development/ui-preview-acceptance.md)。

## 依赖与命令

需要 Node ≥ 22（本项目在 Node 24.21.0 上验证）。依赖版本由 `pnpm-lock.yaml` 固定。本目录在根 workspace 之外独立安装，因此 `npm install` 与脚本需显式 `--ignore-workspace`（根 `dev-stack.ps1` 已代劳）。

```powershell
pnpm install --ignore-workspace   # 或 npm install --ignore-workspace
npm run dev             # 开发服务器，仅绑定 127.0.0.1
npm run typecheck       # vue-tsc --noEmit
npm run build           # 类型检查 + 生产构建（dist/）
npm run test            # Vitest 组件与交互测试
npm run test:browser    # Playwright 浏览器交互与视口测试（19 项）
npm run screenshots     # 1487×1058、DPR 1 的九页截图 → artifacts/screenshots/
```

首次运行 Playwright 需要 `npx playwright install chromium`。

## 页面与路由

| 页面 | 路由 |
|---|---|
| UI-05 项目列表 | `/projects`（已归档用 `?archived=1`） |
| UI-06 创建项目 | `/projects?view=create` |
| UI-09 项目任务 | `/projects/:id/tasks` |
| UI-30 项目蓝图预览 | `/projects/project-hci?skill=blueprint` |
| UI-33 继续这个项目 | `/projects/project-hci?skill=resume` |
| UI-07 全部任务 | `/tasks`（收件箱用 `?tab=inbox`） |
| UI-29 新建任务与执行准备 | `/tasks?view=create` |
| UI-10 任务详情（概览/产物/执行记录） | `/tasks/:id`（无 `skill` 查询参数） |
| UI-11 人工编辑与保存版本 | `/tasks/:id` 的「产物」页签内 |
| 待审请求 | `/reviews` |
| 真实 Run 步骤与控制 | `/runs/:id`（需连接本机 API） |
| UI-31 完善任务定义 | `/tasks/task-evaluation-metrics?skill=definition` |
| UI-32 生成验收方案 | `/tasks/task-evaluation-metrics?skill=verification` |

根路径重定向到 `/projects`。页壳保持全局导航（今日/项目/任务/知识/动态、待审快捷入口、底部连接与设置）。全局页使用“工作空间”面包屑；项目页使用真实项目名。尚未接入的入口进入“此入口尚未接入交互预览”，不产生空白页或假功能。

## fixture 与开发/测试入口

`src/fixtures/seed.ts` 保存示例事实，`src/fixtures/fixtureAdapter.ts` 是唯一数据来源。全部为示例数据，模块内存状态在刷新后重置；不使用 localStorage 保存业务事实。

失败与边界状态只在开发/测试入口注入，不出现在用户流程里：

- `?fixture=empty` 空列表；`load-error` 读取失败；`conflict` 提交冲突；`expired` 候选过期；`timeout` 提交超时（需查回执）；`source-unavailable` 来源不可读；`checkers-registered` 假设检查器已登记；`import-failed` 项目已创建但初始资料导入失败。
- `?fixtureLatency=<ms>`（0–5000）注入异步延迟，用于验证迟到响应不污染新目标。

`resetFixture()`、`setFixtureLatency()`、`getCallCount()` 供测试使用。

## 已实现的交互边界

- 项目列表：进行中/已归档分区与计数、按名称搜索、选择项目后显示目标与状态；存在活动 Run 与未确认动作时归档禁用并说明原因，归档只改状态并保留历史；已归档项目只读。
- 创建项目：必填校验就地报错并与字段关联；未连接模型也能创建；导入失败不回滚项目，导入状态独立显示；超时先查回执；成功后进入项目列表并选中新项目。
- 全部任务：跨项目列表，项目/状态/执行模式筛选保持作用域；工作状态、执行模式与当前执行者分别渲染；全局页不使用项目面包屑或工作台切换。
- 新建任务：CreateTask 固定创建为 INBOX/HUMAN；“保存任务”再按 ready 校验目标、验收与前置依赖，通过才转可开始且不自动执行；“暂存待整理”只创建；AI 委托只记录意图。
- 项目任务：固定在项目范围内；默认选中被阻塞的任务并展示阻塞原因、前置依赖与后续影响；依赖未完成时禁用开始并说明；开始只对 READY 且无 AI 占有者的任务可用。
- 蓝图/定义/验收/恢复：沿用批次一行为（新候选预览、拒绝保留项目、接受不开始或委托、缺少必需检查器时阻止应用、恢复摘要只读且来源可打开）。
- 草稿与浮层：局部页签切换与路由离开共用“保留/丢弃”处理；对话框 Esc 关闭且焦点回落；右区抽屉上再开对话框时先关闭抽屉，不叠加浮层。
- 数据来源与连接：右上「数据来源」显示当前是示例数据还是已连接 API，并打开连接面板；连接后当前页面会重新读取真实数据，断开则回到示例数据。未通过 `/health/ready` 时不会进入 live，并区分数据库不可达与 schema 不兼容。
- 任务详情与产物：`/tasks/:id` 的概览页签展示三个独立事实、验收条件（必需/可选、验证方式）与前置依赖；产物页签提供 Markdown 编辑/安全预览、保存不可变版本、选择要接受的版本（Project State）、按必需条件完成与重开。完成后编辑入口关闭并引导重开；当前 AI Run 的入口位于「执行记录」页签。
- 待审与 Run：`/reviews` 在 live 模式读取和决定真实 Review；`/runs/:id` 读取步骤、最近尝试、未决 Review、待处理控制与未决动作 ID。控制 202 仅表示 PENDING，响应丢失后只查原命令回执；示例模式不伪造 Run。完整动作核对详情和桌面验收尚未实现。

## 与后端的缺口

以下需要真实后端与契约支持。`CreateProject`、`CreateTask`、`MarkTaskReady`、`StartHumanTask`、`dependency-links`、`CreateArtifactWithVersion`、`SubmitHumanArtifactVersion`、`CompleteHumanTask`、`ReopenTask`、`SELECT_ARTIFACT_VERSION` 与项目/任务/项目 State 读取已在 live 模式接入真实 API（见上）；其余仍未接入、也没有伪造：

- 命令与回执：`archive`、`ApplyProjectBlueprint`、任务定义接受、CheckPlan 保存、Verification 应用、Project Resume 查询；前端只呈现“本次演示”或“待接入”。
- 项目列表与资料导入：真实 API 只有 `GET /projects/{id}` 与 `POST /projects`，没有列表、归档与导入端点，因此 live 模式下项目列表页改为“用项目 ID 打开”，不展示示例项目。
- 产物列表：没有“列出某个任务的产物/版本”的读取端点，因此 live 下版本列表只列本会话保存过的版本，界面明确写出刷新后为空；跨会话列出已有版本待接入。
- 修改验收标准：没有专用命令入口，任务详情只读展示验收条件。
- Rules / 验证配置 / Pack 等“后续配置建议”的单独确认入口，目前只做未接入说明。
- 来源详情来自示例摘要；真实实现应读取 ContextManifest/来源版本并按权限过滤。
- 权限与 delegation 的工作台入口、完整动作核对详情仍未接入；AI 辅助与委托保持禁用。
- 尚未接入的页面入口：项目总览、项目资料、收件箱、知识/动态/连接/设置。

## 已知限制

- 浏览器与截图检查不等于桌面 WebView 验收：字体实装、DPI/内容缩放、中文输入法与系统辅助技术均未验证。
- 浅色 token 是实现基线，深色主题未定义；品牌显示名“Workflow OS”沿用图片示例，最终名称待确认。
- 未做真实桌面窗口与 100%–200% 系统缩放的对照；截图覆盖 1487×1058，另在 960×720、390×720 做了溢出与可达性检查。
- 创建项目成功后落在项目列表：项目总览页尚未实现，直接进入 `/projects/:id` 会渲染另一项目的事实，因此用一次性交接数据把回执与导入状态带到列表页。
