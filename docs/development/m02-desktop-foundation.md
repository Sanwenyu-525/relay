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

## 2026-09-25 B 任务卡片图标接入

用户提供的 `tauri_icons_B_taskcards/` 作为本次图标源素材，原目录保留。将其中 `src-tauri/icons/icon.png` 原字节复制到产品 `apps/desktop/src-tauri/icons/icon.png`，源与目标 SHA-256 均为 `99354e15471f0faebb186993da5e9dca3fa4335ed1c7f538f37cc867c7124699`。ICO 源文件 SHA-256 为 `f2433bb3971e13c057f1f6734b7fb1cfceb62674f205efa3386473cec703fbbb`，产品 ICO SHA-256 为 `6d178129b381e12b9245a73905945c086ef6f8216a6ee196877ef119861037f8`；差异仅是目录项顺序与偏移。源十层顺序为 32、16、20、24、40、48、64、96、128、256px；产品顺序为 256、32、16、20、24、40、48、64、96、128px。逐层解析目录项与图像头，均为 32-bit RGBA；产品十层的尺寸、位深及图像 payload 与源对应层原字节一致，没有重画、缩放或裁切。

重排 256px 首层是因为锁定的 `tauri-codegen 2.6.3` 在 Windows 默认窗口图标生成时只解码 ICO 第一层，而宿主没有运行时覆盖图标。产品 Tauri 配置仍只引用 `icons/icon.ico`；本次没有改 identifier、界面、业务逻辑或安装器。素材包 SHA256SUMS 中列出的 28 个文件已逐一核对匹配，并查看了 `preview/native-sizes.png` 的透明背景与任务卡构图；小尺寸细节有限，Windows 任务栏和快捷方式真实显示仍待验收。既有 `apps/desktop/release` 是此前机器人的冻结试用包，本次不刷新，也不将其既往验收结论移用于新图标。

首次 `tauri build --no-bundle` 虽退出码 0，新 EXE 的唯一 PE 图标组仍是旧七层，图标组及七个 RT_ICON payload 与冻结包逐字节相同。原因是此前 `build.rs` 未声明 ICO 为 Cargo 重跑输入，锁定的 Tauri 构建逻辑也未为该图标路径输出对应声明；只改 ICO 未触发资源重新编译。现于 `build.rs` 的 Tauri 构建调用前声明 `cargo:rerun-if-changed=icons/icon.ico`。第二次使用仓库固定的 Node 24.21.0、pnpm 9.15.9 和 MSVC 环境执行同一 `tauri build --no-bundle`，退出码 0；`target/release/relay-desktop.exe` SHA-256 为 `f12864302d8864551ea2b12813313f41e5dc9459caf611fae9776f7736e29c63`。Windows PE 唯一图标组现为十层，顺序和十个 RT_ICON payload 均与产品 ICO 对应层一致。`node scripts/check-docs.mjs` 退出码 0。冻结包 EXE 与 manifest 的 SHA-256 仍分别为 `ad4a40cd08502c3a5013f081acc08bce0bed4bfb671991f91609979f52086a25`、`867c2cdfa9ff9a0752073bede4088e36131b43e9fc10c83537564f7c071a8538`；未刷新发布目录，亦未进行 Windows 真实显示验收。

## 2026-09-28 用户指定新桌面图标

用户反馈前一版任务栏图标显小，并指定新的 1254×1254 RGB 图接入。原图保存在 `apps/desktop/src-tauri/icons/icon-source-20260928.png`。产品 `icon.png` 从原图保留圆角方块主体，对外侧深蓝背景做抗锯齿透明蒙版，裁切后缩放为 1024×1024；主体 Alpha 边界为 `(35, 37, 989, 981)`，占画布约 93% 高度。产品 `icon.ico` 包含 256、128、96、64、48、40、32、24、20、16px 十层，256px 位于首层，延续 Tauri 默认窗口图标的解码要求。配置及业务逻辑未变。当前构建和 Windows 任务栏实际显示结果以本节后续验证记录为准；此前的发布包证据不能视作新图标验收。

## 2026-09-28 用户替换为透明机器人图标

用户随后提供透明背景的机器人图作为新的桌面图标来源。当前原图保存在 `apps/desktop/src-tauri/icons/icon-source-20260928-v2.png`，尺寸为 1254×1254、RGBA；上一版方角图 `icon-source-20260928.png` 保留为历史素材。产品 `icon.png` 与 `icon.ico` 已按该新来源更新，路径保持不变，ICO 包含 256、128、96、64、48、40、32、24、20、16px 十层，并继续保留 256px 首层以满足 Tauri Windows 默认窗口图标的解码要求。`pnpm --dir apps/desktop exec tauri build --no-bundle` 退出码为 0，生成的 `target/release/relay-desktop.exe` SHA-256 为 `d8b19770a0c24f2d0123f1e5af7f1ed3d111c3f0ab862d30bf5f4224c9d7c6e0`；从该 EXE 的 Windows PE 图标组读取十层 RT_ICON，逐层 payload 与产品 ICO 原始字节一致。当前运行中的开发实例与冻结发布包未替换，Windows 任务栏实际显示仍未验收；上一节及更早发布包证据不自动适用于本图。

## 2026-09-28 自定义标题栏与辅助链接修复

动态创建的 main 窗口原先仍启用 Windows decorations；现在仅在该创建入口关闭，React App 顶层在正常页、连接中和失败页显示浅色标题栏。Tauri 2 的拖动、最小化、最大化切换和 `close()` 只向 main capability 补实际所需权限；关闭事件继续进入现有草稿确认，确认后 `destroy()`，Rust 的 `Destroyed → RuntimeState.stop()` 链路未改。侧栏和 sticky 顶栏从标题栏下方开始，侧栏高度扣除标题栏。浏览器模式不渲染窗口控制。原 `skip-link` 使用负的固定 top，链接实测 `y=-40、height=42、bottom=2`，顶部 `(81,1)` 命中链接；现以自身高度的 `translateY(-100%)` 和 `pointer-events: none` 隐藏，保持 Tab 可达，聚焦后完整显示并由 Enter 聚焦 `main-content`。普通字号修复后 `y=-42、bottom=0` 且顶部不命中；根字号 24px 加页面 zoom 1.5 时 `y=-94、bottom=0`，同样不命中。

前端类型检查、生产构建、桌面 `cargo check`、隔离 MSVC `tauri build --no-bundle` 与文档检查退出码均为 0。辅助链接浏览器定向 2/2；`workbench.spec.ts` 首轮全文件 21/22，唯一 R02 草稿返回用例单独复跑 1/1，最终包含桌面标题栏偏移回归的整文件复跑 23/23，记录首轮间歇失败而非静默抹去。Workbench Vitest 全量 300/308；8 项失败均因工作区并行未提交的 InterventionNotifications 新请求使旧列表测试的 fetch 次数/URL 断言失效，本次未改这些测试或业务实现。桌面启动页定向 2/2。以上前端结果不能替代 Windows 宿主验收。

确切 Windows WebView2 自检使用系统临时目录 `relay-titlebar-cargo-20260928/release/relay-desktop.exe`，SHA-256 `bce6661d8457239e20fe55f65bf732a947c4bb0c33d3e28b6ebbe6b7a528bb1e`；未替换 `apps/desktop/release`。一次性 PG 会话补齐该包所需的 0040–0042 migration 与 Graph checkpoint 后启动成功。单屏 Windows 125% 缩放下，普通客户区为 1160×780 CSS px，标题栏 44 CSS px、侧栏从 y=44 延至 780；最大化时视口 1536×816，侧栏延至 816，均无整页横向溢出。WebView2/CDP 点击窗口按钮后，宿主最大化与还原、图标文案同步；双击空白标题栏亦可切换。Windows 原生鼠标输入使窗口左上角从 `(134,37)` 移至 `(334,167)`，边框拖动使宽度从 1174 缩至 1014，拖至左屏边形成约半屏窗口 `(-6,0)–(775,822)`；贴边后的 CSS 视口约 767×815，侧栏底边仍在视口内。最小化由真实主 HWND 的 `IsIconic=true` 确认，Win32 恢复后为 false；进程和页面持续存在。通过拦截本次 WebView2 的 readiness 请求复现连接中与失败页，两页均显示三枚窗口按钮，失败页最大化/还原可用。新建任务草稿下点击标题栏关闭弹出既有确认，取消后草稿与窗口保留；再次确认丢弃后宿主和该测试包的 Node 子进程均退出，一次性 PG 会话已停止并删除。

本节仅证明上述确切 EXE、当前 125% Windows 显示缩放和受控交互；按钮点击与草稿确认由 CDP 驱动，拖动/缩放/贴边由 Windows 输入驱动，未据此宣称人工试用。辅助链接在浏览器回归中验证了键盘焦点和桌面偏移样式，但未在该 EXE 内重演 Tab/Enter；100%/150%/200% Windows DPI、多屏移动、任务栏手动恢复、WebView2 200% 内容缩放及安装包也未验证；M06/M07 总出口不因本修复改变。

## 2026-09-28 操作型标题栏 v2 接续

根据[修正版完整窗口图](../frontend/mockups/2026-09-28/README.md)，标题栏左侧由 `Relay Agent` 文本改为后退、前进、搜索、新建任务。仅记录应用内已访问的路由位置，初始两箭头禁用；搜索与原 Ctrl+K 面板共用状态，桌面应用顶栏不重复显示搜索入口；项目路由进入原任务表单时预填项目 ID，仍允许更改并在提交前按原逻辑核对。中间空白区继续承担拖动/双击，右侧三枚窗口按钮和原关闭链路不变。连接中与失败页禁用左侧业务操作，保留窗口控制；浏览器预览沿用原入口。辅助链接改为直接聚焦主内容，不向浏览器写入仅含 hash 的历史项，避免污染标题栏路由记录。

定向 Vitest 6/6、`workbench.spec.ts` 浏览器回归 23/23、Workbench 类型检查与生产构建、文档检查均通过。Workbench Vitest 全量两次分别为 304/312、303/312；共同的 8 项失败均由工作区并行的人工介入提醒新增请求使旧测试的 fetch 次数或 URL 断言失效，本轮未改该业务模块及其旧测试。第二次多出的 Run SSE 时序断言失败在该文件单独复跑 5/5 后未复现，保留首轮结果，不据此认定全量通过。

首轮隔离 Windows WebView2 自检 EXE SHA-256 `cd7b9afeed38f1737f584b7ca465f8910369eed57635a68a36108199e0361382`。一次性 PostgreSQL、Graph 会话启动后，真实 WebView2 截图确认左侧按钮顺序、原侧栏品牌、右侧窗口按钮及应用顶栏无重复搜索图标。CDP 实测初始后退/前进禁用；搜索打开原面板；新建任务进入原表单；草稿下后退弹出原确认，取消保留草稿，确认丢弃后可前进返回空表单；关闭按钮同样先询问，取消保留窗口和草稿，确认后宿主退出。最大化/还原按钮文案随状态切换。125% 显示缩放下，缩至 520 物理像素宽时客户区约 402 CSS px，操作文字和快捷键提示隐藏，三枚窗口按钮仍在视口内，整页无横向溢出，中间拖动区约 30 CSS px。

补上辅助链接的无 hash 历史跳转后重建的最终 EXE 位于系统临时目录 `relay-titlebar-ui-check-20260928/relay-desktop.exe`，SHA-256 `86bbcdad91f654ae9b2bb7308f7e6da31d4e5212bfbf7b20279f95b0555fd480`；未替换 `apps/desktop/release`。最终 EXE 的真实 WebView2 中，辅助链接 Enter 后 `main-content` 获得焦点、URL 与浏览器历史长度不变；搜索仍打开原面板，新建任务可进入原表单，有草稿时标题栏后退与关闭仍走原确认，确认关闭后宿主退出。两次一次性 PostgreSQL 会话及宿主进程均已清理。

该测试包复用此前冻结的 API 侧车，缺少当前并行增量的人工介入提醒读取路径，因此项目页显示该读取失败提示；本轮只据此验收标题栏和导航，不把它作为完整业务包验收。最终 EXE 未重演原生鼠标拖动、贴边和最小化恢复，也未测其他 DPI、多屏及安装包；这些旧构建的验证证据不能自动移用于 v2。M06/M07 总出口不变。

## 2026-09-29 透明桌面图标的小尺寸观感调整

用户提供的 Windows 任务栏截图显示 Relay 图标比相邻应用显小，并确认继续保留透明背景。上一版透明图的可见内容已接近画布左右边缘，直接等比放大容易切掉外圈箭头或橙色徽章。因此以原透明机器人为依据生成[优化来源](../../apps/desktop/src-tauri/icons/icon-source-20260929.png)，让机器人浅色主体和橙色徽章在小尺寸下更醒目，同时保留完整外圈与透明背景。上一版来源保留，便于对照。新图会改变局部绘制细节，并非原图的纯缩放。

产品 `icon.png` 由该 1254×1254 RGBA 来源缩放为 1024×1024；`icon.ico` 从同一母版生成 256、128、96、64、48、40、32、24、20、16px 十层，256px 保持首层。静态检查确认每层为 32 位 RGBA、透明角和尺寸顺序正确。32px 下，完全不透明或半透明的主体占用像素数与上一版接近，但橙色区域由 42 增至 59 像素、浅色区域由 127 增至 136 像素（固定颜色阈值，仅用于小尺寸对照，不代表 Windows 任务栏观感已通过）。此次没有改变 Tauri 配置、业务逻辑或窗口行为。

`pnpm --dir apps/desktop exec tauri build --no-bundle` 最终退出码为 0，生成的 `target/release/relay-desktop.exe` SHA-256 为 `5bc973d47661548fa466f94853cb2f0acd6fa5aa70325885a877dff3f815c8fd`。其唯一 Windows PE 图标组含十层 RT_ICON，顺序及各层 payload 均与新 ICO（SHA-256 `43c1df2ea46da1369f04aa8a43e69901b8acce67dcb143a1f4003cc36d4e9e60`）逐字节一致。前两次构建分别撞上并行编辑中的 `RuntimeState` 字段不匹配与测试语法错误；该文件随后由并行工作修正，本次未修改其代码。最终构建证明新资源进入 EXE，不代替任务栏观感验收。

`test-release` 在此次调整前已包含 2026-09-28 透明图（manifest 中 ICO SHA-256 为 `fd4ff5af…`）；`apps/desktop/release` 仍包含更早的 B 任务卡图（`6d178129…`），两者都不能作为新图的运行验收。新图的真实 Windows 任务栏显示与发布包更新仍需单独验证。
