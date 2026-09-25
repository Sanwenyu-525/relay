# M02 Windows 桌面基础开发记录

日期：2026-09-24。状态：开发自检；M02 独立验收由协调 Agent 单独记录。范围仅为 Tauri 宿主、随包 Node/Fastify API、React 发布资源连接和本机生命周期；真实 Provider、Worker 恢复调度与 Windows 安装/升级/卸载不在此记录的完成范围。

## 实现边界

- `apps/desktop/src-tauri` 固定 Tauri 2.11.6、tauri-build 2.6.3；CLI 2.11.5 及 Node 24.21.0 随构建脚本固定。发布目录携带 Node、`apps/api` 的生产依赖、编译后真实 Fastify API 和不可变 migrations，UI 嵌在 Tauri 可执行文件中，来源为 `apps/workbench/dist`。桌面壳不另建业务 API。
- 启动先持有单实例 Windows mutex，再验证 `desktop.env`、Node/API 文件和独立 PostgreSQL。Node 子进程被放入设置 `KILL_ON_JOB_CLOSE` 的 Job Object；宿主异常结束时内核回收其进程树。正常关窗在窗口实际 Destroyed 后关闭私有 stdin，API 关闭 Fastify 和 PG pool，再等待并回收子进程。
- 宿主每次启动生成 nonce 与 64 位十六进制 Bearer，仅通过匿名 stdin 管道发给 API。API 只在真实 PG 连通、随包 migration SHA 与库中受限视图完全兼容、指定 Workspace 存在，以及真实 loopback `/health/ready` 的正确令牌/错误 Host/Origin/无令牌边界探针通过后，在 stdout 输出带本次 nonce 的 `desktop_ready`、动态端口、workspace ID 和 Node 版本；不输出令牌或 DB URL。桌面模式关闭 Fastify stdout logger，Rust 只解析与 nonce 匹配的类型化事件。浏览器启动模式保持原有固定端口/Origin/显式令牌配置。
- `desktop_bootstrap` 只返回 `{baseUrl, workspaceId, bearerToken}`，且每次调用先检查真实 Node 子进程是否仍存活；进程退出后撤销宿主中的 API 状态并拒绝旧凭据。主窗口以 `about:blank` 建立，安装 WebView2 `FrameCreated` 监听后再导航到 `http://tauri.localhost`；原生子 frame 导航被取消，任何 child frame 创建均撤销本次启动的 bootstrap。IPC 同时检查 main 标签和完整 origin（允许 `/projects`、`/tasks/:id` 等路径），禁用新窗口及远程导航。HTML 响应保留 Tauri 生成的 CSP（包括脚本 hash/nonce），只给现有 `connect-src` 增加实际 `127.0.0.1:<本次端口>`；静态策略精确放行 Tauri 在 Windows 上使用的 `http://ipc.localhost`。Wry 在调用资源回调前将浏览器可见的 `http://tauri.localhost` 还原为 `tauri://localhost`，因此回调只接受该精确内部资源源。`frame-src`、`child-src` 和 `object-src` 为 `none`。Tauri capability 仅授予 main 窗口监听/取消监听关闭事件及销毁窗口；React 草稿确认取消时保留窗口和 API，确认后销毁窗口。客户端仅在内存持有凭据，页面重载可再次调用 bootstrap；引导或 readiness 失败时显示阻断页，不渲染可操作的示例工作台。
- Windows 主窗口显式启用 Tauri 的 `zoom_hotkeys_enabled(true)`，交由 WebView2 原生处理 `Ctrl++`、`Ctrl+-`、`Ctrl+0` 与 `Ctrl+鼠标滚轮`；不增加自制缩放控件、存储或 IPC 权限。此项是内容缩放，与 Windows 显示 DPI 分开验收。WebView2 用户缩放在导航时会重置，重载前后应分别记录，不能把 `Ctrl+R` 后相同尺寸当作未重载的证据。
- 缺 PG、schema 或 Workspace 时拒绝打开工作台并给出具体诊断。不会安装、启动或停止用户的独立 PostgreSQL 服务，也不会自动执行 migration。

## 构建与资源隔离

`apps/desktop/scripts/build-release.ps1` 使用现有便携 Node、pnpm 和本机 VS Build Tools/MSVC，仅在当前进程设置 Rust MSVC toolchain 与 PATH。先构建真实 API 和完整 React，再用 API package `files` 白名单部署生产资源，执行 `tauri build --no-bundle`，最后仅把可执行文件、Node 与 API 复制到 `apps/desktop/release`，排除 Cargo 编译缓存。`apps/api/package.json` 只允许 `dist/src` 与 `migrations` 进入 deploy；发布时资源根必须恰为 `dist`、`migrations`、`node_modules`、`package.json`。脚本递归拒绝 `.env*`、PEM 与 KEY，最终 manifest 记录源码/锁/脚本、可执行文件和全部发布资源 SHA-256。最初试用未限制的 `pnpm deploy` 曾将忽略的 API `.env` 复制到本任务新建的临时 staging；没有读取内容，已删除临时副本、重建白名单 staging，原 `apps/api/.env` 未改动。只有最终资源审计通过才保留发布物。

首次窗口验收启动在最终包运行 migration 时出现 `ERR_MODULE_NOT_FOUND: pg`：pnpm 默认 deploy 的 139 个依赖 junction 在 Tauri 资源复制后丢失，先前 3998 个实体文件 hash 全匹配仍不能证明 Node 模块入口完整。修复后脚本先在冻结锁安装基础上执行标准 deploy 作为依赖版本基准，再用 pnpm hoisted 模式形成无 junction 的实体依赖目录；逐项比较两个目录的包名/版本集合，不一致即拒绝发布。只在依赖链接数为 0、直接生产依赖实体文件齐全后重新构建。Windows PowerShell 5.1 对已核实的 pnpm 自链接调用 `Remove-Item` 曾抛出 `NullReferenceException`，脚本改为非递归删除该精确 junction，不触及其源目录。失败启动的隔离 PostgreSQL 已由脚本停止并移除；没有改动用户数据库。

M02 只要求可重复的 release 目录包。开始菜单、签名、WebView2 干净机前置检测、安装/升级/卸载和保留数据证明属于 M07。

真实窗口与进程验收使用 `start-acceptance-session.ps1` 在临时目录创建独立 PostgreSQL、真实迁移角色/应用角色与 Workspace，仅供本次测试；发布运行仍要求用户已配置的独立 PG。`check-acceptance-processes.ps1` 把会话标记、release 可执行文件摘要、宿主与随包 Node 的 PID/创建时间绑定：`Snapshot` 保存基线，`SecondInstance` 检查退出码 23、原 Node 未变与第二实例退出后无随包 Node 子进程，`AssertStopped` 检查关闭后的原进程消失，另起会话的 `KillHostAndAssertJob` 只强杀本次宿主、不带进程树参数，检查 Job Object 自行回收 Node。单实例锁在 `run()` 中先于 Tauri setup 的 `start_api()` 取得，第二实例命中锁即退出；进程快照不能追踪已经结束的瞬时子进程，不能单凭该快照声称其从未创建。检查脚本不代替窗口操作；`stop-acceptance-session.ps1` 只在窗口已退出后停止并删除该临时 PG。CDP 测试会话中通过已授权的窗口 `destroy` 命令检查正常进程退出，但这不等于用户原生点击关闭按钮或草稿确认。

## 自检与独立验收交接

已执行 `cargo test --locked --target x86_64-pc-windows-msvc`（4/4）及 capability 收窄后的 `cargo check --locked --target x86_64-pc-windows-msvc`，均退出码 0。Rust 单测覆盖正确 nonce/固定 Node/非零端口的正向握手、错误 nonce/Node/端口、提前 EOF 与超时、CSP 仅追加本次 API 端口并保留已有脚本来源，以及资源回调只接受 `tauri://localhost`；这些只是函数层证据。定向真实 PG 集成测试位于 `apps/api/test/integration/desktop-child.integration.test.ts`，覆盖随机端口、nonce、正确/错误 Host 与 Origin、无令牌、私有 EOF 后进程退出码 0 与端口释放、再次启动后旧令牌 401、新令牌 200，以及缺 Workspace/schema 与过早关管道的拒绝路径。主 Agent 带构建独立复验 desktop-child 2/2、原 API 4/4，PG stop 退出码 0 且临时集群移除；最新 Rust 4/4、React typecheck、组件 114/114 与 Chromium 浏览器 20/20 也已独立复验。证据在 `docs/testing/evidence/m02/independent-*`；开发自检命令日志在 `apps/desktop/results/`，不代替真实窗口验收。

J 后目录发布重建已通过（`apps/desktop/results/build-release-j-fix.txt`），发布 exe SHA-256 为 `3e56ff5efd4fd321593f10fe8e016796db9c288dd5c2b1077b7f926c30187ebb`；7862 个资源文件计入 manifest，禁配文件 0。旧包 `ffa3cf49c7e7588f7a88e3e2411b132db7b285f01a9b2805f05da59448e2c2bf` 的最终目录曾用随包 Node 在独立临时 PG 上实际执行 10 条 migration、创建 Workspace、经私有 nonce/readiness 启动发布 API，并检查正确 `/health/ready` 200、错误令牌 401、EOF 退出码 0、PG 停止与临时目录移除；命令 exit0，日志 `apps/desktop/results/release-api-smoke-final.txt`。新包 API/锁/其余产品源码与旧包的构建输入摘要一致，仅 `TasksView.tsx` 和 `lib.rs` 改动；新包仍需独立真窗口复验。

未插桩 A2 真窗口首次渲染曾落入可操作示例数据：真实原因是 Wry 回调内部请求为 `tauri://localhost`，旧判断误按浏览器可见的 `tauri.localhost`，导致 HTML CSP 未加入本次 API 地址；浏览器 bootstrap 成功但 readiness 请求被 CSP 阻断。独立 PG 中与 A2 同旧包 hash 的 CDP B 记录了这三个分层状态。修复后新包的 CDP C 实测 bootstrap 成功、浏览器 `/health/ready` 返回 200、HTML `connect-src` 恰为 `'self'`、`http://ipc.localhost` 和本次 API loopback；边界检查覆盖重载 bootstrap、未授权 core IPC、远程导航、子 frame IPC 与创建 frame 后主 IPC 拒绝。C 的授权 `destroy` 命令使宿主和 Node 均退出。新隔离 CDP D 在 Node 原进程被定向终止后，重载实际页面得到阻断页、宿主拒绝失效 bootstrap、示例操作入口缺席；D 也已关闭窗口并清理临时 PG。C/D 是同一发布 exe 的受控 CDP 测试，日志在 `apps/desktop/results/webview-{c,d}-*.txt`；不是未插桩原生交互验收。

新隔离 CDP G 使用完整发布 WebView 与真实临时 PG，从页面控件创建项目、任务，开始任务，保存并选用 Markdown 版本，完成再重开，脚本 `apps/desktop/tests/check-webview-human-chain.mjs` 返回通过。只读 SQL 对本次成功的 task ID 核对为 `READY`、revision 5、acceptance revision 2、当前完成引用为空；历史 human acceptance 和 completion record 保留在 revision 1，产物 43 字节的 SHA-256 与输入正文一致。第一次自检曾因 1160 宽桌面窗口隐藏右区而无法点击开始按钮；测试脚本改经可见「查看任务判断」抽屉操作，没有强制点击隐藏控件。首次部分写入与随后成功路径在 G 数据库中按各自 ID 区分，临时 PG 在核对后已停止并移除。日志为 `apps/desktop/results/webview-g-human-chain-round3.txt` 与 `webview-g-pg-facts.txt`；本测试使用 Playwright 合成输入，不构成中文 IME 证据。

`apps/desktop/tests/check-credential-rotation.mjs` 在同一测试进程内顺序启动两个完整发布会话，首轮关闭并清理后才启动次轮；旧令牌只在测试进程内存保存，不进入日志、文件或 URL。脚本先占用首轮已释放端口，使第二轮必须报告新 API 地址，并通过本次会话进程快照核对两个不同的宿主与随包 Node。自检中首轮 API `6310`、次轮 `5700`，旧令牌请求**次轮** `/health/ready` 返回 401，新令牌返回 200；两个令牌不同，两个临时 PG 与会话目录均已清理，日志 `apps/desktop/results/credential-rotation-selfcheck-round5.txt` 不含凭据。初版测试助手从 Node 启动 Windows PowerShell 时继承了优先加载同名兼容模块的 `PSModulePath`，使 `Get-FileHash` 缺失；只在测试子进程环境移除此变量后通过，未修改机器或发布程序。失败轮次日志保留，不计作轮换通过。

原生 J 会话在真实 API 创建项目与任务后，点创建回执的「返回任务入口」于 `/tasks` 显示了 6 条示例任务，虽然页壳仍指示已连接本机 API。根因是 React `TasksView` 无条件读取 `fixtureAdapter.listTasks/loadTaskOptions`；`GET /tasks` 必须带 `project_id` 或 `inbox=true`，且 API 尚无全空间任务及项目列表端点。当前源码与新发布包修正为 live 的「全部/收件箱」均明确显示列表未接入，同时保留真实项目 ID 与任务 ID 导航；fixture 预览仍使用原列表。定向组件回归覆盖 live 无示例读取、两种导航和真实创建回执返回入口，连同原任务页测试共 15/15、TypeScript 检查退出码 0。此处仍是源码与目录包自检，旧包 J 的观察不能记作修复验收；新包需真窗口复验。

仍需在未插桩真实 Windows WebView2 与真实独立 PG 中独立检查：窗口页面实际渲染、`/projects` 与任务深链接重载、完整人工业务闭环、原生关闭/取消关闭草稿、中文 IME、键盘、长文本、不同 DPI/200% 缩放。最新发布 hash 的宿主强杀与 Job 回收已经协调 Agent 在 I 会话独立复验通过，证据见 `docs/testing/evidence/m02/windows-session-i-job.txt`，但该次原生截屏为纯黑且 UIA 只有窗口框架，不证明页面正常显示或交互。截图需绑定实际 release 可执行文件 hash、Windows 缩放与输入法状态。JS 设置输入值或 Chromium 浏览器测试不能代替真实 IME。M02 自检与独立验收结论分开记录。

上述“仍需”是执行者交接时的未验项，不是当前阶段状态。协调 Agent 随后完成 J/K/L 未插桩原生会话、真实 PG 事实核对、两项修复的最新包复验与 DPI/内容缩放检查；M02 独立结论及其限制只看 [M02 独立验收记录](../testing/m02-independent-acceptance.md)和 [当前阶段](../../CODEX_NEXT_STEP.md)。

## 2026-09-24 Windows 图标小尺寸修复

桌面快捷方式与运行中任务栏的图标观感不同。产品 [Tauri 配置](../../apps/desktop/src-tauri/tauri.conf.json)只引用 `icons/icon.ico`，主窗口由 [Rust 宿主](../../apps/desktop/src-tauri/src/lib.rs)动态创建且没有单独设置窗口图标；产品代码中也没有 `setIcon`、`set_icon` 或其他运行时覆盖。锁定的 `tauri-codegen 2.6.3` 在 Windows 生成默认窗口图标时只解码 ICO 第一层，`tauri 2.11.6` 将此默认图标用于未单独指定图标的窗口。旧 ICO 虽有七层，但第一层为 16×16；EXE/快捷方式资源保留多层，因而任务栏取得的小图层与快捷方式选择的图层不同。七层原本均来自同一母版缩放，未发现旧图案混层；未先归因于系统缓存。

保留用户提供的 1254×1254 [原始母版](../../2f831075-1288-4657-9a9c-447e1f439d78.png)，从坐标 `(202, 202)` 至 `(1052, 1052)` 裁出 850×850 [RGBA 派生图](../../apps/desktop/src-tauri/icons/icon.png)。[ICO](../../apps/desktop/src-tauri/icons/icon.ico)的全部七层统一由此图缩放，顺序改为 256、128、64、48、32、24、16px，使 Tauri 默认窗口图标取高分辨率层；小层只做轻度锐化，未重画机器人。没有改应用 identifier、业务逻辑或 Tauri 图标引用配置。后续重新生成 ICO 时须保留 256px 首层，否则会重现此问题。

使用现有 pnpm 执行 `pnpm --dir apps/desktop exec tauri build --no-bundle`，退出码 0，首次产物的七个 PE 图标资源与新 ICO 各层逐字节一致。同期另一个 `build-release.ps1` 进程覆盖了共享 `target/release` 和 `apps/desktop/release`；其结束后的 release manifest 记录 ICO SHA-256 `2c136070eef618265295833e343156b5ccd81ef3599201eca44090c5c6dde454`、EXE SHA-256 `521b65e08c5dbdaaaf8aa3962bad6cf8d2fbd1e548efd85c3a6b00635c0adbca`，与当前文件一致，最终 EXE 的七层 PE 资源再次逐字节匹配。原冻结包已被并行构建替换，旧包验收证据不能自动用于新包。Windows 桌面快捷方式与任务栏实际显示效果仍待人工验证；没有清理全局图标缓存。

同日任务栏方角反馈确认：上述派生 PNG 虽为 RGBA，之前所有像素的 Alpha 均为 255，因此显示为完整方形深蓝底。用户选择保留深蓝背景，只将外侧四角做透明圆角。当前派生 PNG 使用约画布宽度 18% 的抗锯齿圆角 Alpha 蒙版，850×850 区域的 RGB 与原始母版裁切逐像素一致；七层 ICO 均由此图生成，保持 256px 首层及其余 128、64、48、32、24、16px。该改动只影响桌面图标外形，不改变机器人图案、图标引用路径或运行时窗口行为。静态预览不能代替 Windows 桌面快捷方式和任务栏的实际显示验收。

发布脚本第一次尝试因并行前端源码编辑触发构建输入指纹门禁，第二次尝试因并行编译占用 API `dist` 遇到 `TS5033 EBUSY`，均未发布。随后同一 `build-release.ps1 -SkipInstall` 的并行进程成功生成当前目录包：manifest 的 ICO SHA-256 为 `a7a9c091902444d6d16418f3181c8e0f1174188f398178cd30e148c21adf4dc0`，EXE SHA-256 为 `ad4a40cd08502c3a5013f081acc08bce0bed4bfb671991f91609979f52086a25`，与磁盘文件一致；重算构建输入指纹也与 manifest 一致。最终 EXE 的七层 PE 图标资源原始字节与当前 ICO 对应层一致，四角 Alpha 均为 0。资源与构建核对通过，Windows 桌面快捷方式及任务栏的真实观感仍待人工验证；没有清理全局图标缓存。
