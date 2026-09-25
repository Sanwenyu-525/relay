# M02 独立验收记录

日期：2026-09-24。范围：完整 React 迁移与 Windows 桌面基础。最终独立验收结论：**ACCEPTED**。当前模块与下一步状态只维护在 [CODEX_NEXT_STEP](../../CODEX_NEXT_STEP.md)；各批次问题、修复和证据见后文。

## 前置与证据基线

[M01 独立验收](m01-independent-acceptance.md)已通过。Vue 原件保存在[迁移归档](../development/archive/m02-vue-workbench-baseline/README.md)，视觉基线为 [15 张 Vue 截图](../../experiments/m01-stack-adapter/results/vue-screenshots/)。组件 110 项、Chromium 19 项和截图 15 项是迁移前基线，不是 React 成绩。

实现、自检与修复分别由实际调用的两个 `gpt-6-sol / ultra` 执行者承担前端和桌面/API 启动边界；协调 Agent 独立验收。完整入口条件见 [M02 工作包](../../prompts/stack-migration.md#m02完整-react-工作台与-windows-桌面基础)及[测试计划第 10 节](verification-plan.md#10-技术栈改造的大模块验收)。

## 待交付后的独立检查

| 范围 | 必须核对的证据 |
|---|---|
| 输入与覆盖 | READY 时点的源码、锁文件、构建脚本和产物 SHA；旧路由、query 子页及组件的逐项对应，包含独立 Assist 组件 |
| React 回归 | 类型/构建、原组件和浏览器反例；草稿离页、迟到响应隔离、命令回执、无损 revision、安全 Markdown；逐页截图对照 |
| 实际 API | 真实 PG 上创建项目/任务、开始、保存不可变产物版本、接受、完成和重开；UI 与持久事实交叉核对 |
| 桌面边界 | 私有引导、精确 Host/Origin/CSP、schema/workspace 与实例 nonce 就绪、重载及凭据轮换、单实例、正常停止和强杀后子进程回收 |
| Windows 交互 | 实际 React release 窗口中的人工闭环、中文 IME、键盘/焦点、长文本、DPI/内容缩放；不能用浏览器或 JS 设值替代 |
| 文档 | 当前/历史与事实源一致，文档检查通过；安装升级/卸载保留为 M07 出口 |

## 初期准备证据及限制

初期准备时，协调 Agent 通过 computer-use 技能的 `node_repl` + `@oai/sky` 初始化并成功调用 `sky.list_windows()`。这仅证明当时窗口枚举可用，当时尚未操作本模块产品窗口，也不证明 IME、DPI 或业务交互通过。后续真实窗口观察及激活失败见本记录末尾；早期 P00 关于原生管道不可用的记录保留为当时历史。

为避免抢焦点，桌面执行者先做构建及不占焦点的进程/HTTP 自检，release 就绪后由协调 Agent 操作窗口。最终验收仍需记录确切输入、命令/退出码、原始证据、修复复验和未验证项；当前不能将本检查表当作测试成绩。真实 Provider 尚未启用。

## 实施中预审

协调 Agent 读取桌面 API 启动初稿时发现：默认 Fastify logger 可能将错误日志写入私有 stdout 协议；同一次 stdin EOF 的 `end`/`close` 事件可能触发第二次退出并截断清理。执行者已报告改为桌面模式禁用该 logger、重复停止事件直接返回。两项仍待最终源码核对及真实子进程自检/独立复验，不按修改自述记为通过。

继续读取 Rust 宿主初稿发现：bootstrap 对完整 URL 的根路径比较会拒绝 React BrowserRouter 的 `/projects` 等合法路径；`CloseRequested` 即停止 API 可能破坏取消关窗后的继续编辑。执行者已报告改用严格 origin 加主窗口/frame 限制，以及窗口 `Destroyed` 后停止；深链接重载和草稿取消关窗仍需实际验证。

桌面执行者报告默认 `pnpm deploy` 将 API `.env` 复制进临时 staging，已暂停发布，正在收窄 package files 并清理自己生成的副本；报告未读取或输出该配置内容。最终必须检查重建资源清单，确认不含运行配置、凭据、数据或日志，不能把“已调整配置”作为包内无泄漏的证明。原 API 配置不得修改。

## 桌面 API 子范围首次独立复跑

协调 Agent 在执行者完成该子范围自检后运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1 -TestFile desktop-child
```

运行环境为便携 Node 24.21.0、PostgreSQL 18.6，使用独立临时集群及真实迁移/应用角色。结果：1/1，无跳过，进程退出 0；TypeScript 构建、PG 启动、PG 停止均为 0，临时集群删除成功。[独立记录](evidence/m02/independent-desktop-api.txt)保存工具会话 `73937` 的实际输出提取。该次 `Start-Transcript` 未捕获子 PowerShell 原生输出，只有头尾；已明确标记采集缺口并补入实际工具返回的测试与清理结果，不冒称完整原始日志。后续复验须直接重定向子进程输出。

运行前保存并在结束后逐项复核 [145 个输入摘要](evidence/m02/desktop-api-inputs.sha256)，全部一致；清单 SHA-256 为 `52811affe9d1280db084240e23785b897c124f6690c50a1851f9723f5f086168`。这是该次测试的冻结快照，后续修改需另行复验。

测试实际通过子进程私有 stdin 提交 nonce/token，核对真实 schema/workspace readiness、动态端口、缺 Bearer 401、错误 Host 400、错误 Origin 403、旧 token 在新实例被拒绝，以及两次 EOF 正常退出和端口释放。Host 400 沿用当前业务 API 契约，不使用 P00 实验的 421。日志未含本次 token/数据库连接串的断言也通过。

本次只运行 Node API 子进程；没有运行 Rust 宿主、Job Object、React 窗口或安装程序。错 nonce、缺 schema/workspace、启动超时/早退等负向入口仍需补证；API 正向测试不能替代这些反例或整个 M02 放行。

## 桌面 API 第二轮独立复验

执行者扩展启动负例并修复失败退出码被正常关闭覆盖的问题后，协调 Agent 冻结当前输入，依次运行：

| 命令 | 结果 | 完整重定向输出 |
|---|---|---|
| `powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1 -TestFile desktop-child` | 2/2；构建及进程退出 0 | [桌面 API 第二轮](evidence/m02/independent-desktop-api-round2.txt) |
| `powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1 -SkipBuild -TestFile api` | 4/4；进程退出 0，使用上一条同基准构建 | [原 API 回归](evidence/m02/independent-legacy-api.txt) |

两组测试各使用独立临时 PG，启动/停止均为 0、目录删除成功，无跳过。[第二轮 145 项输入清单](evidence/m02/desktop-api-round2-inputs.sha256)在运行前后全部匹配，清单 SHA-256：`a385f3e40b61f3c02bab838e800b58a616d6ad5ca7f764351aecb2008e0d537a`。此次使用原生输出重定向，日志包含实际测试和清理结果，未使用 Transcript 作为采集入口。

新增反例实际覆盖不存在的 Workspace、schema 不兼容的空数据库，以及启动帧尚未送入便关闭管道。各自返回预期类型化错误、无 readiness，退出码按失败保留，不因随后的 EOF 清理变为成功。原 API 回归覆盖非桌面配置缺失/非法、真实 PG loopback 鉴权边界与正常停止，以及 DB 不可用时 liveness/readiness 的区分。执行者另有原配置单测 7/7 自检，未冒充本次独立复跑。

本轮结论仍仅限 API 子范围：Rust 对错误 nonce/启动超时的拒绝、最终资源清单、真实窗口/深链接/关闭、进程树及 UI 出口尚未完成，M02 不因此获得放行。

## Rust 启动帧解析独立复验

协调 Agent 读取测试内容，确认有效消息的正向对照与负例均调用实际 `read_startup` 解析入口；超时用同一实现的可缩短时限参数。随后在 `apps/desktop/src-tauri`，使用 `stable-x86_64-pc-windows-msvc`、VS Build Tools 的 x64 环境执行 `cargo test --locked --target x86_64-pc-windows-msvc`。

结果：退出 0，2/2，无忽略用例。测试覆盖有效 nonce/Node 24.21.0/非零端口的接受，以及错误 nonce、错误 Node 版本、零端口、提前 EOF、无事件超时的拒绝。[完整原始输出](evidence/m02/independent-rust-startup.txt)已重定向保存；[8 个相关源码/配置输入](evidence/m02/desktop-rust-inputs.sha256)前后全部匹配，清单 SHA-256：`2bda1caf5bf0b94664459e127498e0e264913f962abca782f61a2c2662f92bb1`。

这里只验证 Rust 解析函数与超时分支，输入为可控内存流/慢流。没有启动 WebView2，也没有验证最终 React 资源、IPC 调用、frame guard、关窗、Job Object 或安装。关闭权限等后续改动不回写此历史快照；最终 release 另行绑定完整输入与资源清单。

## React 截图预审

协调 Agent 已逐对打开并目视核对原 Vue 与执行者采集的 15 张 React 截图，覆盖项目列表/创建、工作区/项目任务列表、任务创建、任务详情三个子页、蓝图、任务定义、验证方案、项目继续、待审及工作区/项目资料页。两组均为 1487×1058 视口；主要布局、字体层级、颜色、控件位置与提示内容保持一致，未见缺失页面区域或明显视觉回退。日期从 2026-09-23 变为 2026-09-24，部分内联图标后的空白与换行略有差异；本次不是逐像素相等结论。

本次已查看的 React 图片保存在[预审快照](evidence/m02/react-visual-pre-freeze/)，[两组逐图 SHA-256](evidence/m02/visual-pre-freeze-hashes.json)清单摘要为 `d4fb12f3013a46c3f579518868d9a7b5363bd857ebac82d53ef27a80a18107d7`。这些是冻结前的 fixture 截图；只证明对应可见状态，不能替代最终源码绑定、实时数据交互、滚动区域、Windows DPI/IME 或桌面验收。

连接替换预审另发现 Reviews、ProjectTasks、TaskDetail 与 ArtifactPanel 的部分数据加载仍依赖 live 布尔值或对象 ID，可能无法隔离 live→live 客户端替换。旧 Vue 也存在类似依赖；已要求执行者核查可达性、统一重挂载/缓存清理及迟到响应，并在可达时最小修复与补充回归。该项尚未按修复通过处理。

旧 Vue 活跃文件退出后，协调 Agent 依归档清单逐项计算 SHA-256：80/80 匹配，当前 `apps/workbench/src` 中 `.vue` 文件为 0。历史证据链接已指向归档原件；文档检查退出 0，74 个 Markdown、908 个链接、881 个标题锚点、126 个设计令牌及 29 条对比度检查通过。

## React 冻结源码独立回归

执行者修复连接替换及迟到 readiness 后，协调 Agent 阅读新增反例并独立执行以下命令。使用便携 Node 24.21.0，并将其目录前置到本次进程 PATH；工作目录为 `apps/workbench`。

| 实际命令 | 结果 | 原始重定向输出 |
|---|---|---|
| `node node_modules/typescript/bin/tsc --noEmit` | 退出 0 | [类型检查](evidence/m02/independent-react-typecheck.txt)（成功时无输出） |
| `node node_modules/vitest/vitest.mjs run` | 19 文件、112/112，退出 0 | [组件回归](evidence/m02/independent-react-components.txt) |
| `node node_modules/@playwright/test/cli.js test --config playwright.config.ts` | 19/19，退出 0 | [Chromium 回归](evidence/m02/independent-react-browser.txt) |

[82 项相关源码/测试/配置输入](evidence/m02/frontend-regression-inputs.sha256)运行前后全部匹配，清单 SHA-256 为 `f6fde52f5a975f28ac4f895317e83fe57775d4c14df8b00693763ced83cb0266`。正在单独修正清理保护的真实 PG 浏览器启动脚本不参与这组三项检查，也未纳入本清单。

新增两项反例验证：同一 Task ID 换到新客户端后重新读取、旧响应不能覆盖新任务且旧产物记忆清空；关闭连接面板后的迟到 readiness 不能激活 live 或覆盖新草稿，已有草稿也阻止再次连接。原 110 项组件及 19 项浏览器用例保留。Chromium 的窄视口、200% 内容缩放及键盘结果仅属于浏览器层，不代替 Windows WebView、系统 DPI 或真实 IME。

## CSP 修复独立复验

预审发现宿主直接覆盖 HTML CSP 会丢失 Tauri 生成的脚本 hash/nonce 与 IPC 规则。执行者对照本机 Tauri 2.11.6 源码后改为保留原始 CSP，仅向 `connect-src` 添加本实例 loopback API 地址，并精确配置 Windows IPC 源。协调 Agent 再次运行 `cargo test --locked --target x86_64-pc-windows-msvc`，3/3、退出 0，无忽略项，[完整输出](evidence/m02/independent-rust-csp.txt)已保存。

[8 项 Rust/CSP 相关输入](evidence/m02/desktop-rust-csp-inputs.sha256)前后全部匹配，清单 SHA-256 为 `79fbb0f097672547aa2d692d07e5d9a1c9bc81196e6891195157123ac907c662`。新增单测检查原有 nonce/hash、IPC 和 frame 限制保留，指定 API 端口加入且非指定端口未加入，以及缺可信 IPC 源时不生成放宽策略。这仍是函数级复验；实际打包 HTML 响应、IPC 和子 frame 拒绝需在产品 WebView 会话验证。

## 滚动修复与真实 API 独立复验

逐路由对照发现旧 Vue 的导航后回到页面顶部行为尚未显式迁移。执行者补齐 pathname/query 变化后的滚动，并新增浏览器回归。协调 Agent 在新冻结基准重复执行上一节前端命令：类型检查退出 0、组件 112/112、Chromium 20/20，均退出 0；输出分别为[类型检查第二轮](evidence/m02/independent-react-typecheck-round2.txt)、[组件第二轮](evidence/m02/independent-react-components-round2.txt)、[浏览器第二轮](evidence/m02/independent-react-browser-round2.txt)。

此外从仓库根目录实际执行 `powershell -NoProfile -ExecutionPolicy Bypass -File apps/workbench/scripts/run-real-api-browser.ps1`，使用独立临时 PG18.6、真实 10 份 migration、应用角色及 Fastify API，Playwright 人工链路 1/1、退出 0；PG 停止 0，临时目录删除成功。[完整输出](evidence/m02/independent-real-api-browser.txt)包含初始化、迁移、浏览器结果和清理结果。断言通过 UI 创建项目/任务、开始任务、保存产物 v1、Project State 当前选用、完成与重开及对应 HTTP 回执；本次未增加直接 SQL 行核对，不宣称覆盖 Windows 窗口。

[83 项前端输入](evidence/m02/frontend-round2-inputs.sha256)及[实际运行 API 编译物、migration 与角色 SQL 输入](evidence/m02/real-browser-api-inputs.sha256)前后全部匹配，清单 SHA-256 分别为 `36d326a13038dc5347aef9d109691dddc1a967026ea58390652ba776362dff1d`、`848d931815173e9b6c671fad816f25f30a698c1f0a3bd16e70d913cb2fafe922`。短跑脚本已改为仅在 API/UI 与 PG 确认停止后删除自己创建的临时目录，停止或状态检查异常则保留恢复信息。

## 首次目录包实际启动失败

协调 Agent 先核对专用 `apps/desktop/release`：184 个源文件摘要与 3998 个资源摘要全部匹配，顶层仅 API、Node、EXE 和 manifest，禁配置文件 0；[审计输出](evidence/m02/independent-release-audit.json)及[当次 manifest](evidence/m02/desktop-build-manifest.json)已保存。EXE SHA-256 为 `e3efc520e7c641ae9c7d1a146c9bc0ae3e4160a59d8bf893b4a81ff16bd268c6`。这些摘要证明输入/资源一致性，不证明模块解析或产品可运行。

随后实际执行 `powershell -NoProfile -ExecutionPolicy Bypass -File apps/desktop/scripts/start-acceptance-session.ps1`，退出 1。[完整启动输出](evidence/m02/windows-session-a-start.txt)显示：临时 PG 已启动并创建角色/库，但随包 Node 执行最终目录内的 migration CLI 时返回 `ERR_MODULE_NOT_FOUND`，无法解析 `pg`。此时尚未启动产品窗口。只读检查发现最终 `api/node_modules` 顶层仅 `.pnpm` 和 `.modules.yaml`，没有入口包目录；已退回桌面执行者修复打包链，并要求最终目录的真实依赖解析与启动验证。

协调 Agent 另核对本次 `relay-m02-acceptance-d89a0f0f4af649f5b5f8f0bfe3be23e1`：临时目录已不存在，没有命令行匹配该集群的 PostgreSQL 进程。该失败包不能用于 M02 放行；修复后需另存新 manifest、重新核对并重新开展窗口验收，不覆盖本次失败证据。

## 修复目录包与第二次真实窗口观察

执行者将 pnpm 部署改为实体 hoisted 目录，并与标准部署的锁定包版本集合比较；最终目录依赖解析及独立临时 PG/API 子检由执行者完成。协调 Agent 对修复候选另存 [manifest](evidence/m02/desktop-build-manifest-round2.json)，独立核对 186 个源输入、7862 个资源摘要全部匹配，资源实际数量一致，reparse point 与禁配置文件均为 0，见[审计记录](evidence/m02/independent-release-audit-round2.json)。最初将 `workspace_manifest` 错映射到 `package.json` 是审计脚本错误，已按构建脚本核对实际 `pnpm-workspace.yaml`，不属于产品缺陷。

候选 EXE SHA-256：`2cd9d885703dd37997c3eafb71650e846446d411860f241f424cdf512480dd67`。再次执行 `powershell -NoProfile -ExecutionPolicy Bypass -File apps/desktop/scripts/start-acceptance-session.ps1`，退出 0，随包 Node 完成 10 条迁移并启动真实窗口；[启动输出](evidence/m02/windows-session-a2-start.txt)对应独立会话 `7ad7b41e88944806929d4224cc4bc7c6`。

真实窗口 UIA 文本显示 URL 为 `http://tauri.localhost/projects`，但初次启动即提示“桌面本机服务未就绪。当前仍为示例数据”，并展示可操作的示例项目。此时宿主与随包 Node 均存活；尚未判断是 bootstrap 还是 HTTP 就绪请求失败，不能用 API 子检替代该问题。窗口截图为黑屏；刷新窗口选择后重试激活仍返回 `failed to activate captured window`，两次失败后停止原生输入。已保存[非敏感原生观察](evidence/m02/windows-session-a2-native.json)。这不证明视觉、真实 IME、键盘或 DPI 通过，也不能仅凭该错误断言用户桌面锁定。

静态独立审查同时确认：API 在 readiness 后退出时，宿主仍以 `api.is_some()` 返回失效 bootstrap；React 连接失败会切为可操作 fixture。已交回执行者修复存活判断、运行状态失效与桌面失败阻断页，并要求真实进程退出和重载反例。初始连接失败须单独定位，不能仅隐藏 fixture 掩盖故障。

该候选会话随后仅强杀宿主，未按进程树直接杀 Node。`check-acceptance-processes.ps1 -Mode KillHostAndAssertJob` 退出 0，原宿主 PID 13880 与 Node PID 5248 均消失，见[Job Object 独立结果](evidence/m02/windows-session-a2-job.txt)。随后 `stop-acceptance-session.ps1` 退出 0，PG 正常停止、临时目录删除成功，见[清理输出](evidence/m02/windows-session-a2-cleanup.txt)。这是该候选的异常宿主退出证据，不是正常关窗、服务重启或修复后新包的完整验收。

本批结论：CHANGES_REQUESTED。新候选仍须修复初始连接及服务退出后的失败处理；Windows 必需交互出口保持未验证，M02 尚未通过。

### 初始连接失败的 WebView 定位

执行者在同一 `2cd9d885…` EXE 的另一独立临时 PG 会话中，仅为测试进程启用 loopback CDP，实际连接打包 WebView 诊断。其[脱敏诊断输出](evidence/m02/worker-webview-b-diagnose.txt)显示：`desktop_bootstrap` 成功，浏览器 `/health/ready` 请求被 transport 拒绝；HTML 响应中的 `connect-src` 只有 `'self'` 与 `http://ipc.localhost`，缺失当前实例 API 地址。协调 Agent 已读取此输出并核对当前 CSP hook；这属于执行者定位证据，不是协调 Agent 独立复跑或修复通过。

因此先前 `csp_with_api` 函数 3/3 单测只证明字符串处理，不能证明真实资源请求进入 hook 的预期分支。修复须保留 Tauri 的脚本 hash/nonce 与 frame 限制，随后以实际 WebView 响应 CSP、受保护 HTTP 请求和初始桌面 live 状态复验，不放宽到任意连接源。

协调 Agent 对照实际锁定的本机 Tauri 2.11.6 源码：`src/protocol/tauri.rs::get_response` 按 `tauri://localhost` 解析资源路径，在设置原 CSP 后调用资源回调；`src/webview/mod.rs` 的官方示例也判断 `scheme_str() == Some("tauri")`。原宿主回调却只匹配 `request.uri().host() == Some("tauri.localhost")`，混淆了可见页面 origin 与内部协议 URI。执行者已开始按可信 `tauri://localhost` 修正回调入口；仍需新包的真实响应证明修复生效。

## CSP 入口与桌面失败页修复的独立回归

执行者修正内部协议 URI 匹配；bootstrap 用 `try_wait` 拒绝已退出的 sidecar；React 初始 bootstrap 或 readiness 失败时显示阻断页，未进入示例工作台。协调 Agent 在前端暂时冻结后独立运行原有三条命令：类型检查退出 0，组件 114/114、Chromium 20/20，均退出 0。完整输出见[类型第三轮](evidence/m02/independent-react-typecheck-round3.txt)、[组件第三轮](evidence/m02/independent-react-components-round3.txt)、[浏览器第三轮](evidence/m02/independent-react-browser-round3.txt)。新增两个前端反例分别覆盖宿主 bootstrap 拒绝和浏览器 readiness 失败；按钮负断言已按真实 `project-create-open` 标识修正，并检查示例文案不出现。

[84 项前端输入](evidence/m02/frontend-round3-inputs.sha256)运行前后全部匹配，清单 SHA-256：`5a505c9dac7d5bb4fcce4d385c92414d268b5ee06caf05f0eef8a8d63ac54341`。这些成绩没有扩展到原生 IME、DPI 或桌面人工闭环。

协调 Agent 设置 `RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-msvc` 后再次独立运行 `cargo test --locked --target x86_64-pc-windows-msvc`，4/4、退出 0，见[Rust 第二轮](evidence/m02/independent-rust-csp-round2.txt)。前置尝试调用 `VsDevCmd.bat` 的包装命令因引号解析失败，未应用该脚本环境；实际 Cargo 命令仍成功运行上述 MSVC 目标测试，不能把该结果写成新的完整 release 编译验证。[8 项输入](evidence/m02/desktop-rust-csp-round2-inputs.sha256)前后全部匹配。新增检查覆盖可信内部协议 URI 及错误 scheme/authority，不仅检查 CSP 字符串。

## 新目录包真实 WebView 与进程独立复验

新候选 EXE SHA-256 为 `ffa3cf49c7e7588f7a88e3e2411b132db7b285f01a9b2805f05da59448e2c2bf`。协调 Agent 独立核对 186 个源码输入、7862 个资源摘要，全部匹配；实际资源数一致，reparse point 与禁配置文件均为 0，见[第三轮目录审计](evidence/m02/independent-release-audit-round3.json)与[对应 manifest](evidence/m02/desktop-build-manifest-round3.json)。

协调 Agent 随后自行启动 E、F 两个顺序隔离会话，均用最终目录随包 Node 执行 10 条迁移、独立临时 PG 和同一 EXE。仅测试进程设置 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<动态端口>`，Playwright 通过 loopback CDP 操作真实打包 WebView；没有修改产品 IPC 权限或读取/输出 token。这些属于带测试插桩的真实 WebView 证据，不能替代 Windows 原生输入、系统 DPI 或未插桩窗口验收。

| 独立操作 | 实际结果与输出 |
|---|---|
| `start-acceptance-session.ps1`，E 会话 `56b76f571ab143db90a2b1894b54db1a` | 退出 0，[启动输出](evidence/m02/windows-session-e-start.txt) |
| 随包 Node 执行 `diagnose-webview-bootstrap.mjs <E> 2694` | 退出 0，bootstrap 成功、浏览器 health 200、body ready；实际 CSP 精确加入本实例 API `127.0.0.1:2700`，[诊断](evidence/m02/windows-session-e-diagnose.txt) |
| 随包 Node 执行 `check-webview-boundary.mjs <E> 2694` | 退出 0，重载引导成功、CSP 正确、未知 IPC 与未授权核心命令拒绝、远程导航拒绝、子 frame 引导拒绝且随后主 frame 引导撤销，[边界输出](evidence/m02/windows-session-e-boundary.txt) |
| `check-acceptance-processes.ps1 -Mode SecondInstance -SessionRoot <E>` | 退出 0，竞争实例 exit 23、原 Node PID 30876 不变，竞争实例退出后无遗留 Node，[单实例输出](evidence/m02/windows-session-e-second-instance.txt)。进程快照不单独证明没有短暂子进程；源码 mutex 在启动 sidecar 前获取 |
| 随包 Node 执行 `close-session-window.mjs <E> 2694`，再 `-Mode AssertStopped` | 均退出 0，[窗口销毁命令](evidence/m02/windows-session-e-close.txt)后原宿主/Node 均退出，[进程结果](evidence/m02/windows-session-e-stopped.txt)。这是程序调用允许的 destroy 命令，不是原生点击 X、草稿确认或用户关闭交互 |
| F 会话 `61921b702870476896b34ba8d1cec6ea` 启动并执行诊断 | 退出 0，[启动](evidence/m02/windows-session-f-start.txt)及[故障前 health 200](evidence/m02/windows-session-f-prehealth.txt)；F 未运行创建子 frame 的 probe，避免 frame 撤销混淆死亡反例 |
| `kill-session-sidecar.ps1 -SessionRoot <F>`，再随包 Node 执行 `check-sidecar-exit.mjs <F> 9806` | 均退出 0，精确核对路径/父 PID/创建时间后终止原 Node 27440，宿主仍存活；[注入结果](evidence/m02/windows-session-f-sidecar-kill.txt)。重载后 bootstrap 明确返回 `no longer running`，阻断页出现且无 fixture 文案/创建/连接入口，[反例结果](evidence/m02/windows-session-f-sidecar-exit.txt) |
| F 调用窗口销毁并 `-Mode AssertStopped`；E/F 执行 `stop-acceptance-session.ps1` | 均退出 0，F [原宿主与 Node 已退出](evidence/m02/windows-session-f-stopped.txt)，两组 PG 均 stop 0、临时根删除成功：[E 清理](evidence/m02/windows-session-e-cleanup.txt)、[F 清理](evidence/m02/windows-session-f-cleanup.txt) |

[8 项复验脚本输入](evidence/m02/webview-ef-test-inputs.sha256)前后全部匹配。上述结果关闭了初始 CSP 连接失败和 sidecar 退出后重载误入 fixture 这两个具体缺陷；不代表 M02 整体通过。真实 WebView 人工业务链与 SQL 核对、草稿关闭交互、原生键盘/IME/长文本/DPI 仍须补齐。

## 真实 WebView 人工链与数据库交叉核对

执行者自检时发现 1160 宽的桌面视口将任务判断栏收进抽屉；测试脚本改为通过可见 `rail-trigger` 打开后点击开始，并在每轮开头导航到受信 `/projects`。这是适配已有响应式交互的测试修正，没有修改产品或强制点击隐藏的开始按钮。执行者 G 会话已自检成功后，协调 Agent 在全新临时数据库另开 H 会话 `11b8a552500d483db755ce5c38d5ca8d`，仍使用同一 `ffa3cf49…` EXE。

独立执行 `node.exe apps/desktop/tests/check-webview-human-chain.mjs <H> 11316`，退出 0，真实打包 WebView 自动引导后，经可见控件完成项目创建、任务创建、开始、保存产物 v1、当前选用、人工完成及重开，见[完整链路结果](evidence/m02/windows-session-h-human-chain.txt)。此处 Node 为最终目录随包版本，输入由 Playwright 合成，不算真实 IME。

随后独立执行 `inspect-acceptance-facts.ps1 -SessionRoot <H>`，在只读 repeatable-read 事务中查询实际 PG 行，退出 0，见[数据库事实](evidence/m02/windows-session-h-pg-facts.txt)。全新数据库只包含本次一个项目和一个任务，已人工交叉核对：

- 任务 `a762d56d-87db-4275-b073-4138a7ceb3e4` 属于 UI 返回的项目；重开后为 `READY`、revision 5、acceptance_revision 2，current_completion_id 为空。
- 验收版本 1、2 均保留；产物仅 v1，43 字节，SHA-256 `ee28bbe497e8e3db238bca99ddc9a7f9fcb6be4ae8d0216097ded5dc9fe278a4`。协调 Agent 另对已知测试文本的 UTF-8 字节计算长度/hash，与数据库一致。
- human_acceptance 保留版本 1，指向该产物版本；completion_record 保留版本 1 并指向同一 human_acceptance，没有将重开后的当前完成指针错误保留。

[人工链与 SQL 脚本输入](evidence/m02/webview-h-chain-inputs.sha256)前后匹配。协调 Agent 另保存并目视检查[重开结果的 WebView 渲染截图](evidence/m02/windows-session-h-reopened-webview.png)：可见真实连接标记、历史完成回执与重开为 READY/v2 的回执；这是 CDP renderer 截图，不是原生窗口捕获或系统 DPI 检查。H 随后程序销毁窗口，原宿主/Node [均退出](evidence/m02/windows-session-h-stopped.txt)，PG stop 0、[临时根删除成功](evidence/m02/windows-session-h-cleanup.txt)。

## 未插桩启动观察与新包 Job Object 回收

协调 Agent 清空本次启动进程的 WebView 调试参数后另开 I 会话 `38ea6b1e2fa54c29824bf2401cc645d7`，同一最终 EXE、独立 PG，启动脚本退出 0，见[启动记录](evidence/m02/windows-session-i-start.txt)。原生工具能枚举并读取 Relay 窗口框架，但截图仍为黑屏，刷新只读状态后没有取得页面 RootWebArea/文本，见[观察记录](evidence/m02/windows-session-i-native.json)。未发送原生输入；不能据此判定未插桩页面显示、中文 IME、键盘或 DPI 通过，也未推断用户已经锁屏。

随后先记录精确进程基准，再仅强杀宿主，没有调用进程树强杀；`KillHostAndAssertJob` 退出 0，最终包的宿主 PID 29836 与原 Node PID 13120 均消失，[Job 回收结果](evidence/m02/windows-session-i-job.txt)。PG stop 0、[临时根删除成功](evidence/m02/windows-session-i-cleanup.txt)。该结果将强杀回收证据绑定到新 EXE，不再仅依赖前一候选。

## 跨实际启动的凭据轮换独立复验

执行者先完成两个顺序真实实例的自检后，协调 Agent 独立执行 `apps/desktop/release/node.exe apps/desktop/tests/check-credential-rotation.mjs`，退出 0，见[完整结果](evidence/m02/independent-credential-rotation.txt)。该脚本在同一测试进程内存中保留第一实例凭据，不写入文件、日志、URL 或命令行；关闭并清理第一实例后占用其已释放 API 端口，再启动第二实例，保证检查请求确实发给新地址。

独立结果：首轮宿主/Node 为 30696/40316、API 为 `127.0.0.1:13385`，第二轮为 8460/25424、API 为 `127.0.0.1:7818`；令牌不同。旧令牌请求第二实例的受保护 `/health/ready` 返回 401，新令牌返回 200 且 body ready。两组会话均完成进程退出检查、PG 停止与临时目录删除。

[轮换脚本输入](evidence/m02/credential-rotation-input.sha256) SHA-256 为 `1b1205246c116f45c48887ef9a477e3b73d17ec61b1143d0b773f9ce0a01a3c2`，运行后仍匹配；最终 EXE 未变。[独立收尾核对](evidence/m02/credential-rotation-postcheck.json)显示本发布目录宿主/Node 进程 0，匹配测试前缀的临时会话目录 0。

执行者的前四次尝试属于测试助手失败，不是产品轮换通过：Node 启动 Windows PowerShell 时继承了不适用的模块搜索路径，导致标准 `Get-FileHash` 不可用。当前测试只在其子进程环境移除 `PSModulePath`，让 PowerShell 重建正常模块路径，不改机器环境或产品；未知清理结果不再输出成功标记。历史失败日志保留在 `apps/desktop/results/credential-rotation-selfcheck*.txt`，独立通过只对应上述冻结脚本。

## 本轮出口审计与阻塞交接（I 时点历史记录）

迁移覆盖与视觉对照、React/Rust 回归、最终目录完整性、真实 WebView 人工链及 PG 事实、Host/Origin/Bearer、CSP/IPC/frame、单实例、程序销毁/强杀回收、服务死亡重载阻断及跨启动凭据轮换均已有本记录限定范围的独立证据。尚无 M02 整体通过结论。

剩余必要出口必须在可可靠观察和操作的 Windows 桌面上验证：

- 未插桩窗口正常显示、原生标题栏/最小化还原、页面和深链接重载后的真实状态。
- 中文 IME 的组合输入、候选选择、编辑与保存；键盘焦点/Tab/对话框操作及长文本编辑滚动。
- 实际系统 DPI 与 200% 内容缩放下的可达性，记录并恢复原有显示设置。
- 原生关闭触发草稿确认：取消后窗口与 API 仍可用，保留编辑内容；显式处理草稿后关闭，宿主/Node 退出。

同一原生操作障碍已跨多个目标续接回合持续存在：A2 截图黑屏且刷新选择后仍两次 `failed to activate captured window`；后续 I 新包未插桩观察仍黑屏、UIA 仅有窗口框架。用户关于 Windows 是否处于可交互会话的询问尚未回复。不能据此直接断言系统锁定，也不能用 CDP 合成输入将上述出口降格为通过。

I 时点已完成不依赖原生操作的剩余轮换检查，当时没有继续修改产品代码的已证实缺陷；M03 仍依赖 M02 验收，不能绕过此门槛。当时下一步是恢复可交互 Windows 会话/原生工具条件，再完成上述出口。该批测试窗口和临时 PG 已清理；原有用户数据未参与测试。后续 J/K/L 结果及最终结论见本记录下文。

## 原生会话恢复与 J 批次验收

2026-09-24 07:30 起，协调 Agent 在目标恢复后重新观察同一最终 EXE 的未插桩 J 会话 `67aac318e82d4f03a8c6a56bec5d3d42`。本批没有 CDP 参数，使用 computer-use 的原生截图、鼠标和键盘操作；页面正常显示并标为已连接本机 API。此前黑屏/激活失败仅保留为历史阻塞，不继续推定当前会话不可操作。

- 项目名称输入框内逐键 `n`、`i` 出现真实拼音组合与候选，空格选择“你”，再追加文字形成“你好，原生验收 J”。[组合候选截图](evidence/m02/windows-session-j-ime-composition.png)证明使用了输入法候选；追加文字使用原生文字注入，不另称为 IME 组合证据。
- Tab 从名称移至目标文本框；Alt-F4 触发[草稿关闭确认](evidence/m02/windows-session-j-dirty-close.png)，Tab 将焦点移至“保留并继续编辑”，Enter 取消关闭，项目名称仍在。之后通过 UI 创建项目与任务并开始任务，证明取消后窗口及 API 继续可用。
- 任务 `60df3c96-3c31-4ec1-a0d6-3b8159112ef7`、项目 `b30a7997-2dff-4536-9b1d-bc6d556225ba` 均由本批 UI 创建。在产物编辑器输入 6319 字符，使用 Ctrl-Home/Ctrl-End 查看首尾、滚轮在编辑器内滚动，再追加“ 编辑追加已验证。”并保存 v1。[末尾截图](evidence/m02/windows-session-j-long-text-tail.png)、[保存回执](evidence/m02/windows-session-j-long-text-saved.png)及[输入原文](evidence/m02/windows-session-j-long-text.md)保留。
- [只读 PG 核对](evidence/m02/windows-session-j-pg-facts.txt)显示版本 v1 为 15334 字节、SHA-256 `10d286826873b7f45030861b508b3416e3ad39ccfef2e289715f7ffb2350e153`，与独立计算的输入文件摘要一致。当前任务 IN_PROGRESS/revision 3；本批没有执行人工接受/完成/重开，不与 H 批次混写。
- 原生标题栏从最大化还原至截图逻辑尺寸 1162×811，[还原截图](evidence/m02/windows-session-j-restored-window.png)显示编辑内容保留。点击最小化后工具明确返回 `window is minimized`；激活恢复后仍是相同任务产物。尝试拖动右边框没有观察到尺寸变化，因此不据此宣称更小宽度已验证。
- 保存后点击原生标题栏关闭按钮，窗口消失；[进程检查](evidence/m02/windows-session-j-stopped.txt)退出 0，宿主 23944 与 Node 34772 均退出。此前[进程快照](evidence/m02/windows-session-j-processes.txt)绑定确切路径/创建时间；[清理](evidence/m02/windows-session-j-cleanup.txt)显示 PG stop 0、临时目录删除成功。本批启动脚本最终退出 0。

本批发现两项须修复或补齐的出口：

1. 真实任务创建后“返回任务入口”进入 `/tasks`，仍展示固定示例任务且右上显示真实 API，见[缺陷截图](evidence/m02/windows-session-j-tasks-fixture.png)。执行者只读确认 TasksView 无条件调用 fixtureAdapter；已交最小修复：live 全部/收件箱入口明确列表尚未接入并提供真实 ID 导航，不新增本轮外的列表接口。
2. Ctrl-plus 及 Ctrl-Shift-plus 没有观察到内容缩放。执行者核对锁定 Wry/Tauri 默认关闭 zoom hotkeys，当前产品未显式开启；已交使用原生 `zoom_hotkeys_enabled(true)` 的最小修复。Ctrl-R 后仅观察到相同详情，未取得重新引导证据，不能将按键本身记为重载通过。

系统设置启动返回 `launched app did not expose a targetable window`，刷新枚举仍无设置窗口；已请用户打开“系统 → 显示”以继续实际 DPI 验收，没有修改系统显示设置。200% 内容缩放及实际 DPI 仍待后续证据，M02 尚未放行。

## J 缺陷修复与新发布包独立复验

执行者仅修改 `apps/workbench/src/views/TasksView.tsx` 与 `apps/desktop/src-tauri/src/lib.rs` 两个产品源码：前者在真实连接下停止读取示例任务，以明确的未接入说明和项目/任务 ID 导航替代伪列表；后者启用 WebView2 原生缩放快捷键。原 fixture 模式及 API 契约未变。执行者自检后，协调 Agent 在当前文件基准独立复跑 [定向 15/15](evidence/m02/independent-j-fix-vitest.txt)、[类型检查](evidence/m02/independent-j-fix-typecheck.txt)、[完整组件 116/116](evidence/m02/independent-k-full-vitest.txt)、[Chromium 20/20](evidence/m02/independent-k-browser.txt) 与 [Rust 4/4](evidence/m02/independent-k-rust-tests.txt)，命令均退出 0。构建脚本 `build-release.ps1 -SkipInstall` 退出 0，生成 EXE SHA-256 `3e56ff5efd4fd321593f10fe8e016796db9c288dd5c2b1077b7f926c30187ebb`；[manifest](evidence/m02/desktop-build-manifest-k.json) SHA-256 `91527a667ecdc5e0d0de839f23f367afadeb48a44a741b063fcd6db1cf1d85a9`。

[独立发布目录审计](evidence/m02/independent-release-audit-k.json)复核 186 个源码输入与 7862 个资源文件，数量和摘要匹配，reparse point、禁配置文件和不匹配项均为 0。与旧包 manifest 逐项比较，只有上述两项产品输入变化；API、锁和其他产品输入未变。J 修复源码的[冻结清单](evidence/m02/independent-j-fix-source-freeze.sha256)在构建及 K/L 会话后仍与产品/测试文件匹配，清单中两份开发文档随后按事实同步，不能把文档 hash 变化记为产品漂移。

协调 Agent 用新包在独立临时 PostgreSQL 中启动未插桩 K 会话 `7b26c07588584083b2ed037a0f6b7d12`，[启动记录](evidence/m02/windows-session-k-start.txt)绑定 EXE 摘要。真实 `/tasks` 的[“全部”截图](evidence/m02/windows-session-k-live-tasks.png)与原生切换后的“收件箱”均没有 J 批次误入的六条示例任务，真实 ID 导航和新建入口可见。四次 `Ctrl++` 已使页面明显放大，但截图尺寸复核表明该档位约为 175%，故**没有**把 K 的四次输入计作 200% 通过。随后原生 `Ctrl+R` 出现“正在连接本机服务”引导页，并恢复已连接真实 API 的任务页与正常内容比例，[重载后截图](evidence/m02/windows-session-k-reload-restored.png)；这次可观察到实际重载，不再仅凭按键推断。原生关闭后，[进程检查](evidence/m02/windows-session-k-stopped.txt)证明宿主 26592 与 Node 32624 退出，[临时 PG 清理](evidence/m02/windows-session-k-cleanup.txt)退出 0。

系统“设置 → 系统 → 屏幕”随后可定位，当前活动显示器 2 原始比例为 **125%**、分辨率 2560×1440。协调 Agent 用系统下拉框切到 **150%**，在同一新包窗口中观察真实任务入口、点击“新建任务”并核对输入表单均可见且可操作，保存[任务页](evidence/m02/windows-session-k-dpi-150-tasks.png)与[创建页](evidence/m02/windows-session-k-dpi-150-create.png)截图；随后将系统比例恢复到原始 **125%** 并再次从设置窗口确认。设置截图含个人账户信息，未保存到仓库；系统比例观察与应用截图分别记录，不能将应用截图单独解释为系统比例读数。未移动到另一块显示器，跨屏测试留在 M07 安装总验收。

为补足准确的 200% 内容缩放，协调 Agent 又启动未插桩 L 会话 `34801c00a1f24f2f9d72eb5e1694141a`，仍为同一 EXE 和全新临时 PG。[100% 基准](evidence/m02/windows-session-l-zoom-100.png)后连续五次原生 `Ctrl++`，到达[放大截图](evidence/m02/windows-session-l-zoom-200.png)；同尺寸 1162×811 截图中，同一“新建任务”按钮纯色内部宽度约由 121 变为 246 像素，接近 2 倍，[测量记录](evidence/m02/windows-session-l-zoom-measurement.txt)。在该比例下纵向滚动可到达[项目 ID 与任务 ID 输入、打开按钮](evidence/m02/windows-session-l-zoom-200-ids.png)，抽屉导航可展开；`Ctrl+0` 恢复原始布局。此结论基于原生输入和可见尺寸，没有宣称读取到 WebView2 内部的数值 ZoomFactor。[关闭后进程检查](evidence/m02/windows-session-l-stopped.txt)为宿主 35236、Node 5896 均退出，[PG 清理](evidence/m02/windows-session-l-cleanup.txt)退出 0。

**M02 独立验收：ACCEPTED。** 完整 React 路由/视觉覆盖、真实 API 人工链及 PG 交叉核对、原生 IME/键盘/草稿/长文本、两项发现缺陷的修复复验、DPI/约 200% 内容缩放、私有引导/CSP/IPC/单实例/进程回收与文档检查共同满足 M02 出口。项目/全空间任务列表的真实 API 尚不存在，当前界面已如实标记并提供已有 ID 路径；这不被称为列表功能交付。安装、升级/卸载、另一显示器上的运行以及干净机交付属 M07；真实 Provider 仍关闭，M03 可开始 Mock 可靠性开发。
