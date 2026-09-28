# M02：React 工作台完整迁移开发记录

日期：2026-09-24。状态：**FRONTEND_READY_FOR_ACCEPTANCE**；这里只交付前端子包，Windows 原生窗口、中文输入、缩放与生命周期由 M02 整体验收确认。范围与出口见 [M02 工作包](../../prompts/stack-migration.md#m02完整-react-工作台与-windows-桌面基础)。

## 原件与旧入口退出

迁移前的 Vue 工作台源码、测试与配置共 80 份原件逐文件保存于[历史归档](archive/m02-vue-workbench-baseline/README.md)，原始 SHA-256 见[清单](archive/m02-vue-workbench-baseline/vue-baseline.sha256)；清单自身 SHA-256 为 `e1e99701a11fc053a4f7ebec7add865d8404464684f0076042dc555f320b430b`。原 README 的字节保存在 `README.original.txt`，SHA-256 为 `c75b594b54bf1bd0419e3462a9a01c9848906deb941a6aef0048f0b11ce938a0`。归档不含依赖、构建物、环境文件或凭据。迁移前 [15 张实际旧页面截图](../../experiments/m01-stack-adapter/results/vue-screenshots/)及[原图哈希](../../experiments/m01-stack-adapter/results/vue-screenshots.sha256)没有被覆盖。

2026-09-24 在原件 SHA 核对、React 全覆盖与回归通过后，旧 `main.ts`、`router.ts`、Vue 导航工具和 30 个 `.vue`（17 个视图、12 个公共组件、`App.vue`）退出活动 `src`。新入口是 [main.tsx](../../apps/workbench/src/main.tsx)、[router.tsx](../../apps/workbench/src/router.tsx)和 [App.tsx](../../apps/workbench/src/App.tsx)；没有 iframe 或仍在加载的 Vue 页壳。原窄 [relayClient.ts](../../apps/workbench/src/api/relayClient.ts)字节未变，SHA-256 为 `336b0565add68ed57e43242517d61e8b6df94445cfd446e191b079a0cdebe183`。

## 路由及旧视图映射

[旧路由](archive/m02-vue-workbench-baseline/src/router.ts)的 11 条记录一一对应到[新路由](../../apps/workbench/src/router.tsx)。路径和 query 语义如下；新路由对 pathname/query 变化滚动到顶部，沿用旧 `scrollBehavior`。

| 旧路径或 query | React 视图及保留交互 |
|---|---|
| `/` | 重定向 `/projects` |
| `/projects`、`?archived=1`、`?view=create` | `ProjectsView` 项目列表/搜索/归档视图；`CreateProjectView` 创建、校验、导入回执 |
| `/projects/:id/tasks` | `ProjectTasksView` 范围、依赖、阻塞与开始 |
| `/projects/:id/knowledge` | `KnowledgeView` 项目资料 |
| `/projects/:id`、`?skill=blueprint`、`?skill=resume` | `ProjectSkillView` 分派 `BlueprintView` 候选/接受和 `ProjectResumeView` 来源摘要 |
| `/tasks`、`?tab=inbox`、`?view=create` | `TasksView` 筛选/收件箱；`CreateTaskView` 创建、暂存、Ready 校验 |
| `/reviews` | `ReviewsView` 待审读取与决定 |
| `/knowledge` | `KnowledgeView` Workspace 资料/搜索 |
| `/runs/:id` | `RunView` 步骤、控制、回执与来源 |
| `/tasks/:id`、`?skill=definition`、`?skill=verification` | `TaskSkillView` 分派 `TaskDetailView` 概览/产物/执行记录、`TaskDefinitionView`、`VerificationPlanView` |
| 其他路径 | `UnsupportedView`，说明未接入而非空白页 |

归档中 17 个旧视图均有同名 `.tsx`：`AssistView`、`BlueprintView`、`CreateProjectView`、`CreateTaskView`、`KnowledgeView`、`ProjectResumeView`、`ProjectSkillView`、`ProjectsView`、`ProjectTasksView`、`ReviewsView`、`RunView`、`TaskDefinitionView`、`TaskDetailView`、`TaskSkillView`、`TasksView`、`UnsupportedView`、`VerificationPlanView`。其中 `AssistView` 原本也没有独立路由，新组件同样未由当前路由挂载；保留目标/来源边界，但没有假装接入真实模型。12 个旧公共组件亦逐一迁为同名 `.tsx`：`AppDialog`、`AppShell`、`ArtifactPanel`、`AssistSourcePicker`、`ProjectNav`、`RelayConnectionDialog`、`ResponsiveRail`、`RunSourcesPanel`、`SafeInline`、`SafeMarkdown`、`SourceDetailDialog`、`StatusChip`。旧 CSS/token 沿用，[migrated-scoped.css](../../apps/workbench/src/migrated-scoped.css)承接原 Vue scoped 规则；`SafeMarkdown` 仍按安全文本渲染。

## 状态和宿主边界

浏览器默认内存 fixture，显式连接前不呈现假 live。连接只通过既有窄 API client 读取或提交领域命令；`/health/ready` 失败维持可见的 fixture 状态。Tauri 仅在实际宿主环境调用 `desktop_bootstrap`，从受信 IPC 接收 `{baseUrl, workspaceId, bearerToken}`；renderer 仅在内存保存，不放在 URL、持久存储或日志。原有业务命令身份、revision、回执查询与 API 语义未改；API Breaking Change：**No**。数据库 migration：**无**。

React 组件局部状态替代 Vue reactive；未加入额外状态框架。每次连接切换递增来源 epoch、清除本会话产物缓存并重挂载当前路由；旧连接的迟到查询和同 ID 产物不再污染新来源。连接 readiness 进行期间关闭面板或断开会使待完成请求失效；异步完成前再次检查草稿保护。路由离开、浏览器刷新及 Tauri 关闭请求保留未保存草稿阻止；Tauri 确认丢弃后销毁窗口，交由宿主按其生命周期停止本机 API。项目/任务创建、版本保存/接受、完成/重开、Review/Run 控制和资料继续复用原领域事实，具体未接入的后端能力见[工作台 README](../../apps/workbench/README.md#与后端的缺口)。

## 版本与选择依据

[package.json](../../apps/workbench/package.json)和 [pnpm-lock.yaml](../../apps/workbench/pnpm-lock.yaml)精确锁定 React/ReactDOM 19.3.0、Vite 8.3.0、`@vitejs/plugin-react` 6.1.1、`@tauri-apps/api` 2.11.1；M01 的稳定发行、peer/engines 与 Windows MSVC 依据见 [M01 记录](m01-stack-baseline.md#技术采用与证据链)。M02 新增 `react-router-dom` 7.18.4（MIT、React/ReactDOM peer ≥18、Node ≥20，[npm 正式包](https://www.npmjs.com/package/react-router-dom/v/7.18.4)）、`lucide-react` 1.47.0（ISC、peer 覆盖 React 19，[npm 正式包](https://www.npmjs.com/package/lucide-react/v/1.47.0)）。测试栈精确锁定 `vitest` 5.0.1（MIT、支持 Vite 8 和 Node 24，[正式发布](https://github.com/vitest-dev/vitest/releases/tag/v5.0.1)）、`jsdom` 30.1.0（MIT、支持 Node 24，[npm 正式包](https://www.npmjs.com/package/jsdom/v/30.1.0)）、`@playwright/test` 1.63.0（Apache-2.0、支持 Node 24，[正式发布](https://github.com/microsoft/playwright/releases/tag/v1.63.0)）。新增路由与图标包分别只承担路由语义和既有图标替换，没有引入第二个业务状态 Owner。Vite 8 的 Rolldown 主版本变化以全部组件、浏览器和旧图对照回归为进入 M02 的条件，不以 peer 成功替代运行证明。

## 可复跑验证和证据

环境：Windows 11 x64，显式使用项目便携 Node 24.21.0、pnpm 9.15.9、测试 PostgreSQL 18.6；没有连接真实 Provider。前端源码/测试/配置/脚本固定输入 [83 文件 SHA-256 清单](../../apps/workbench/artifacts/m02-verification/frontend-source.sha256)，清单自身 SHA-256 为 `36d326a13038dc5347aef9d109691dddc1a967026ea58390652ba776362dff1d`。本次自检及协调 Agent 的独立复跑均绑定此源码基准，源码若再改须重新出清单与复验。

在仓库根目录运行以下命令；`apps/api/dist` 应先由现有 API 构建生成，首次 Playwright 运行需安装 Chromium：

~~~powershell
$repo = 'D:\Develop\Relay-Agent'
$node = Join-Path $repo '.research\runtime-cache\node-v24.21.0-win-x64\node.exe'
$env:PATH = "$(Split-Path -Parent $node);$env:PATH"
Set-Location (Join-Path $repo 'apps\workbench')
& $node node_modules/typescript/bin/tsc --noEmit
& $node node_modules/vitest/vitest.mjs run
& $node node_modules/vite/bin/vite.js build
& $node node_modules/@playwright/test/cli.js test
& $node node_modules/@playwright/test/cli.js test --config playwright.screenshot.config.ts
Set-Location $repo
powershell -NoProfile -ExecutionPolicy Bypass -File apps/workbench/scripts/run-real-api-browser.ps1
& $node scripts/check-docs.mjs
~~~

| 检查 | 自检结果与原始输出 |
|---|---|
| TypeScript、生产构建 | 退出 0；[typecheck](../../apps/workbench/artifacts/m02-verification/typecheck.log)、[build](../../apps/workbench/artifacts/m02-verification/build.log) |
| 组件与交互 | 19 文件、112/112 通过（原 110 断言保留，另加连接切换和 readiness 迟到 2 例），退出 0；[日志](../../apps/workbench/artifacts/m02-verification/components.log) |
| Chromium 路由/业务浏览器 | 20/20 通过（原 19 项保留，新增路由滚动反例），退出 0；[日志](../../apps/workbench/artifacts/m02-verification/browser.log) |
| 1487×1058 页面截图 | 15/15 通过，退出 0；[日志](../../apps/workbench/artifacts/m02-verification/screenshots.log)、[新图哈希](../../apps/workbench/artifacts/m02-verification/react-screenshots.sha256) |
| 旧图逐页对照 | 15 组尺寸一致，最大像素变化 0.483%、最大 RGB MAE 0.3606；[逐图度量](../../apps/workbench/artifacts/m02-verification/vue-react-pixel-metrics.log)。该数值只衡量截图差异，旧/新日期不同，也不证明原生窗口表现 |
| 可控真实 API 浏览器人工链 | 1/1 通过，临时 PG 停止码 0、临时根目录清理 `True`、脚本退出 0；[测试](../../apps/workbench/tests/browser/real-api.spec.ts)、[脚本](../../apps/workbench/scripts/run-real-api-browser.ps1)、[日志](../../apps/workbench/artifacts/m02-verification/real-api-browser.log) |

真实 API 测试用固定 Workspace ID `11111111-1111-4111-8111-111111111111` 和一次性数据库/端口/令牌；执行项目创建、任务创建与开始、产物 v1 保存、接受固定版本到 Project State、人工完成、重开，逐步断言浏览器收到真实 HTTP 命令回执。脚本复用便携 PG、真实 migration/角色隔离与当前 API 构建，只在受控临时目录建库，结束按 API/UI 子进程及 PG 实际停止状态清理；若停止无法确认，保留目录并打印恢复命令。本测试没有独立 SQL 交叉核对业务行，也没有故意杀死桌面窗口或模拟 Provider。

## 文档影响与剩余验收

[工作台 README](../../apps/workbench/README.md)、[工作台交互](../frontend/workbench-design.md)、[设计系统](../frontend/design-system.md)及[技术选型](../architecture/技术选型.md)已经同步 React 当前状态。两个旧验收记录中的 `.vue` 链接指向归档原件，保留历史证据。需求/领域契约、ADR、API、数据库和 migration 未改变；无新 ADR、数据库或 API 文档变更。桌面窗口人工闭环、WebView/IME/DPI/缩放/关闭生命周期须由并行宿主包与 M02 独立验收验证；本前端子包的浏览器或截图结果不替代它们。
