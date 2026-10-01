# Relay React 工作台

本目录是 React 19 + TypeScript + Vite 8 工作台：项目和任务、人工产物闭环、资料、待审、Run 查询与控制、四项 Skill 预览沿用原工作台路由和视觉。浏览器默认使用内存 fixture；只有显式连接本机 API 后才写真实 PostgreSQL。Vue 原件及逐页迁移关系见 [M02 开发记录](../../docs/development/m02-react-migration.md)。

默认首页为 `/projects`；左栏「协作」或窄屏导航抽屉可进入 `/agent`。真实任务详情的「进入协作工作区」携带当前任务 ID，直接恢复对应工作；打开入口不自动创建会话、任务、运行或调用模型。

浏览器页壳右上「数据来源」可输入 API 地址、Workspace ID 与 Bearer 令牌，`/health/ready` 返回 200 后进入 live；凭据仅存于本页内存，刷新回到 fixture。切换连接会重新读取当前路由，未保存草稿会阻止切换。Tauri 窗口通过受信 `desktop_bootstrap` 取同样三字段，失败时显示阻断页，不把示例数据冒充 live。M02 的真实 Windows 基础见[独立验收](../../docs/testing/m02-independent-acceptance.md)；M03 Mock 完整闭环和 M07 安装交付仍按各自出口验收。

## 依赖与命令

使用项目便携 Node 24.21.0 与 pnpm 9.15.9；直接依赖和间接版本由 `package.json` 与 `pnpm-lock.yaml` 精确锁定。本目录在根 workspace 之外独立安装，安装需显式 `--ignore-workspace`。

```powershell
pnpm install --ignore-workspace
pnpm dev             # 开发服务器，仅绑定 127.0.0.1
pnpm typecheck       # tsc --noEmit
pnpm build           # 类型检查 + 生产构建（dist/）
pnpm test            # Vitest 组件与交互测试
pnpm test:browser    # Playwright 浏览器交互与视口测试
pnpm screenshots     # 1487×1058、DPR 1 的 15 页截图 → artifacts/screenshots/
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-real-api-browser.ps1
```

首次运行 Playwright 需要安装 Chromium。真实 API 短跑入口使用独立临时 PostgreSQL、迁移角色和 Workspace，执行浏览器人工闭环后停止 API/PG 并删除临时目录；不读取 `apps/api/.env`，运行前需构建 `apps/api/dist`。复跑输入、退出码及文件哈希见 [M02 开发记录](../../docs/development/m02-react-migration.md)。

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
| Workspace / 项目资料 | `/knowledge`、`/projects/:id/knowledge` |
| UI-31 完善任务定义 | `/tasks/task-evaluation-metrics?skill=definition` |
| UI-32 生成验收方案 | `/tasks/task-evaluation-metrics?skill=verification` |

根路径重定向到 `/projects`。页壳保持全局导航（今日/项目/任务/知识/动态、待审快捷入口、底部连接与设置）。全局页使用“工作空间”面包屑；项目页使用真实项目名。尚未接入的入口进入“此入口尚未接入交互预览”，不产生空白页或假功能。

## fixture 与开发/测试入口

`src/fixtures/seed.ts` 保存示例事实，`src/fixtures/fixtureAdapter.ts` 仅提供 fixture 数据；live 使用窄 `src/api/relayClient.ts` 读取和提交真实事实。内存状态在刷新后重置；不使用 localStorage 保存业务事实或凭据。

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
- 数据来源与连接：右上「数据来源」显示当前是示例数据还是已连接 API；连接后重读当前页面，断开则回到示例数据。未通过 `/health/ready` 不进入 live，并区分数据库不可达与 schema 不兼容；旧连接的迟到响应不能覆盖新连接。
- 任务详情与产物：`/tasks/:id` 的概览页签展示三个独立事实、验收条件（必需/可选、验证方式）与前置依赖；产物页签提供 Markdown 编辑/安全预览、保存不可变版本、选择要接受的版本（Project State）、按必需条件完成与重开，并从服务端恢复历史版本。完成后编辑入口关闭并引导重开；「执行记录」页签对有 Project、READY/HUMAN 且服务端提示可开始的真实任务提供单独 Delegate，202 后进入新 Run。创建任务的执行模式选择不会直接启动 Run。
- 待审与 Run：`/reviews` 在 live 模式读取和决定真实 Review，提交或查询原命令回执须匹配命令类型、Review ID 和决定；`/runs/:id` 读取步骤、最近尝试、未决 Review、待处理控制、未决动作 ID 与可见来源。Delegate 和控制的 202 只表示已受理，响应丢失后只查原命令回执；示例模式不伪造 Run。
- 资料：`/knowledge` 与项目资料页在 live 模式区分 Knowledge、Memory、Decision、Rule，支持搜索、版本/修订、可用命令及不确定回执核对；fixture 模式明确显示缺口。

## 与后端的缺口

以下需要真实后端与契约支持。`CreateProject`、`CreateTask`、`MarkTaskReady`、`StartHumanTask`、`DelegateTask`、`dependency-links`、`CreateArtifactWithVersion`、`SubmitHumanArtifactVersion`、`CompleteHumanTask`、`ReopenTask`、`SELECT_ARTIFACT_VERSION` 与项目/任务/项目 State 读取已在 live 模式接入真实 API（见上）；其余仍未接入、也没有伪造：

- 命令与回执：`archive`、`ApplyProjectBlueprint`、任务定义接受、CheckPlan 保存、Verification 应用、Project Resume 查询；前端只呈现“本次演示”或“待接入”。
- 项目列表与资料导入：真实 API 只有 `GET /projects/{id}` 与 `POST /projects`，没有列表、归档与导入端点，因此 live 模式下项目列表页改为“用项目 ID 打开”，不展示示例项目。
- 修改验收标准：没有专用命令入口，任务详情只读展示验收条件。
- Rules / 验证配置 / Pack 等“后续配置建议”的单独确认入口，目前只做未接入说明。
- Run 来源只显示服务端可见的 ContextManifest 和版本片段；完整来源 Inspector 与跨来源比较尚未实现。
- 权限配置工作台入口、完整动作核对详情与 AI 辅助对话仍未接入；真实 Task 详情可 Delegate，Run 页已接持久 SSE 与独立 Mock Worker，完整 G01–G08 仍待 M03 验收。
- 尚未接入的独立页面入口：项目总览、收件箱、动态、连接、设置。项目资料和 Workspace 知识已接入原有路由。

## 已知限制

- live 产物历史通过 `GET /tasks/{id}/artifacts` 恢复，刷新后不会把最新版自动勾为本轮待接受版本；当前组件实例之外的响应不明保存身份持久化仍未验证。
- 浏览器与截图检查不等于桌面 WebView 验收；M02 已在真实 Windows 窗口验证视觉、DPI/内容缩放与中文输入，系统辅助技术及 M07 安装交付仍待验证。
- 浅色 token 是实现基线，深色主题未定义；品牌显示名“Workflow OS”沿用图片示例，最终名称待确认。
- 桌面缩放与窗口交互以 [M02 独立验收](../../docs/testing/m02-independent-acceptance.md)的实测范围为准；浏览器截图覆盖 1487×1058，另在 960×720、390×720 做了溢出与可达性检查。
- fixture 创建项目后落在项目列表并用一次性交接数据保留回执；live 创建后进入项目任务页。`/projects/:id` 仍按原有 Skill 查询语义提供预览，不冒充项目总览。
