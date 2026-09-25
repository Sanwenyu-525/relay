# desktop-p00：Windows Tauri 宿主边界实验

这是 P00 的隔离验证，不是生产 `apps`、V001、安装交付或 ADR-007 冻结。它固定 Tauri 2、一个随包 Vue 静态页，以及一个随包 Node 24 sidecar。sidecar 只启动受控 `fake-worker.mjs`，不连接 PostgreSQL、不提供业务 API、不调用 Provider，也没有文件或通用 shell 能力。

`src-tauri/target/release/relay-desktop-p00.exe` 是 `tauri build --no-bundle` 产生的 release **可执行目录包**：同目录含 `node.exe`、`sidecar.mjs`、`fake-worker.mjs`。它不是 MSI 或 NSIS 安装包。

## 已固定的输入

| 输入 | 固定版本或来源 | 追溯位置 |
| --- | --- | --- |
| Node | `v24.21.0` Windows x64 ZIP；SHA-256 `158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541` | [官方发布目录](https://nodejs.org/dist/v24.21.0/)；`scripts/prepare-resources.ps1` 先校验 ZIP，再校验复制的 `node.exe` |
| Node 包 | `pnpm@9.15.9` | `packageManager` 与 `pnpm-lock.yaml` |
| Tauri Rust / CLI / API | `2.11.5` / `2.11.4` / `2.11.1` | [Tauri 官方发布页](https://tauri.app/release/)；`Cargo.toml`、`Cargo.lock`、`pnpm-lock.yaml` |
| Windows 宿主 API | `webview2-com 0.38.2`、`windows 0.61.3` | `Cargo.toml`、`Cargo.lock`；仅用于 P00 的 WebView2 frame 导航取消、命名 mutex 和 Job Object 验证 |
| Vue / Vite / TypeScript / vue-tsc | `3.5.43` / `8.3.0` / `5.9.3` / `3.3.11` | `package.json`、`pnpm-lock.yaml` |

直接依赖采用上游各自的许可证：Tauri 为 MIT 或 Apache-2.0，Vue、Vite、TypeScript 与 Node 的许可证以各自锁定包和上游发布物为准。本实验不复制上游源码；锁文件保留完整解析版本、来源与完整性信息。

## 准备和复验

以下 PowerShell 命令只把 Node ZIP 解压到本工作区的 `.research/runtime-cache`，不安装或修改系统 Node、Rust、Docker、服务或其他数据库。需预先具备 Windows WebView2 Runtime、VS 2022 Build Tools 和 Rust `stable-x86_64-pc-windows-msvc`；脚本会在自身进程中调用 `VsDevCmd.bat`，不改变默认 GNU 工具链。

```powershell
Set-Location D:\Develop\Relay-Agent
$nodeVersion = 'v24.21.0'
$cache = ".research\runtime-cache\node-$nodeVersion-win-x64"
$zip = "$cache.zip"
New-Item -ItemType Directory -Force -Path .research\runtime-cache | Out-Null
Invoke-WebRequest "https://nodejs.org/dist/$nodeVersion/node-$nodeVersion-win-x64.zip" -OutFile $zip
if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541') { throw 'Unexpected Node ZIP SHA-256' }
Expand-Archive -LiteralPath $zip -DestinationPath .research\runtime-cache -Force

Set-Location experiments\desktop-p00
.\scripts\build-release.ps1
.\scripts\run-release.ps1
Get-Content .\results\latest.json -Raw
```

`build-release.ps1` 使用便携 `node.exe` + Corepack 运行 `pnpm@9.15.9 install --frozen-lockfile`，然后依次运行真正的 `vue-tsc --noEmit`、Vite 静态构建和 Tauri release 构建。它在 frontend/Tauri 构建前快照实际构建输入，构建后要求每个输入哈希未变，才在 release 目录发布 `p00-build-manifest.json`（源码、随包资源和 EXE 的 SHA-256）。`run-release.ps1` 在启动任何 release 进程前核对该清单；源码或随包资源改变但未重新构建会被拒绝。`-TestBuildManifestMismatch` 使用内存清单 fixture 将 `src/App.vue` 哈希伪造为不同值，验证拒绝发生在进程启动前。

运行器为每个完整批次创建随机 `run_id` 和独立 `results/<run_id>.json`，先写入 `RUNNING`，只在正常自动路径、CSP frame probe 正向对照、FakeWorker 伪造 readiness、单实例和 Job Object 强杀检查均通过时写 `PASSED`；失败回执保留具体 `host_checks`，不会复用旧结果或用概括性异常覆盖子检查。`results/latest.json` 仅为本次最终结果的副本。

结果不写 token、端口、PID 以外的进程信息、URL 中的凭据或任意持久认证配置。它固定列出 package/lock、Vue、Rust、sidecar、FakeWorker、构建与运行脚本、图标和随包 Node 等参与输入的 SHA-256，并额外记录 release EXE 与实际随包资源的 SHA-256。

## 本实验的边界

启动时 Rust 宿主通过 `BaseDirectory::Resource` 解析它自己 release 目录中的 `node.exe` 与 `sidecar.mjs`，随后仅把每实例随机 token 通过子进程 stdin 私有管道传给它自己 spawn 的 sidecar。sidecar 在 `127.0.0.1:0` 绑定动态端口，先等待受控 FakeWorker readiness 并验证其自身请求，再通过私有 stdout 管道把端口和不含 token 的 readiness 传给宿主；端口不写入公开运行结果。FakeWorker 必须回显 sidecar 刚生成的 instance nonce；`wrong-nonce` 和 `exit-before-ready` 是只在运行器中设置的受控模式，release 宿主必须在任何可用窗口/连接信息之前退出。页面从 `http://tauri.localhost` 通过两个窄 Tauri command 获得当前内存连接信息；页面 `fetch` 的 `Authorization` 预检由 sidecar 只对精确 Origin、`GET` 和 `authorization` 显式放行。

Windows 宿主在进程启动即持有 `Local\\RelayDesktopP00SingleInstance` 命名 mutex。第二个进程发现该 mutex 后尝试将已有标题窗口前置，随后以固定码 `23` 退出，发生在 sidecar 启动之前。首个实例把它自己 spawn 的随包 Node sidecar 放入带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 Job Object；FakeWorker 是 sidecar 的子进程，故正常关闭和宿主被直接强杀时都会随该 Job 结束。运行器只追踪当前本次 release PID 的后代，且仅在可执行文件绝对路径等于本实验 release `node.exe` 时才作为兜底清理对象。

### 主 frame 与 frame probe 的当前范围

`window.url()` 只能看到 WebView 窗口 URL，不能区分同源 child frame；不能把它当成主 frame 授权证据。锁定的 Wry/Windows 组合还会把初始化脚本注入 child frame，因此仅有 remote loopback frame 被 capability 拒绝不能说明 bundled 同源 frame 已经被拒绝。

正常 P00 launch 使用实际 Tauri WebView2 控制器的 `FrameCreated` + `ICoreWebView2Frame2::NavigationStarting`。它取消每个 child-frame 导航；只有事件 URI 精确匹配 bundled `frame-probe.html` 时才增加 `same_origin_frame_probe_navigation_blocked`。该 probe 是 `script-src 'self'` 允许的外部 `frame-probe.js`，不是 inline script。自动路径同时要求该特定计数为真、probe 没有执行、真实 WebView reload 握手成功。

运行器另以显式 `--p00-frame-probe-control` 关闭这一**仅限自动实验**的拦截器，验证该同源外部脚本本身可以执行。回执把 `probe_executed`、`bridge_reported`、`bridge_available`、`bootstrap_invocation_attempted`、`bootstrap_succeeded` 和 `completion_reported` 分开保存；该对照不把脚本执行等同于 frame IPC 授权。本环境在最终回执中的这些字段应作为当前锁定版本的实测事实读取，不能推广到 `srcdoc`、`about:blank`、跨平台 WebView 或未来 Tauri 版本。

握手端点只接受下列组合：

| 检查 | 预期结果 |
| --- | --- |
| 缺少 Bearer token | `401` |
| Host 不是精确 `127.0.0.1:<本实例端口>` | `421` |
| Origin 不是精确 `http://tauri.localhost` | `403` |
| 合法 Origin 的授权 `OPTIONS` 预检 | `204`，仅允许 `GET` 与 `authorization` |
| 合法 Bearer `GET /p00/handshake` | `200` |

自动模式会先完成一次真实 WebView 授权 fetch，以 `sessionStorage` 中不含凭据的单次标记重载 WebView，再由重载后的页面完成第二次握手。随后宿主关闭 sidecar；sidecar 命令 FakeWorker 正常退出并关闭 loopback listener。若两秒内未正常退出，实验代码仅对自己 spawn 的 child 强制回收，并把它记录为非正常退出，绝不把它计为正常退出通过。

## 已运行证据

`results/latest.json` 是脱敏原始运行回执。当前自动批次包含：release EXE、随包 Node `v24.21.0`、动态 loopback、真实 Tauri WebView 重载后的握手回执、`401`/`421`/`403` 负向探针、nonce 绑定的 FakeWorker readiness、正常退出和随包 Node 子进程残留数 `0`。运行脚本还轮询并记录本机原生窗口的非零 `MainWindowHandle` 与标题 `Relay P00 Desktop — Tauri WebView`；这证明该 release EXE 创建了原生 Tauri 窗口。

同一批次还包含：(1) 两个错误 FakeWorker 模式由实际 release 宿主拒绝，且在运行器兜底清理前没有本次随包 Node 后代；(2) 第二个 release 实例以 `23` 退出，已有实例的两项 Node PID 未变化；(3) 正常实例被只调用 `.Kill()`（没有 tree flag）强杀后，记录的 sidecar/FakeWorker PID 在 Job 等待内自行消失，运行器随后才结束该检查；(4) frame probe 对照和正常阻断的分别回执。隐藏窗口运行无法目视断言已有窗口确实获得前景，结果只记录宿主调用 `SetForegroundWindow`。

本机为 Windows 11 Home 10.0.22631 x64，运行脚本读取到的 WebView2 Runtime 版本会写入每次结果。上述 Job Object 证据覆盖 P00 自己启动的 Node/FakeWorker 终止，不是业务 Run/Task 的恢复正确性证据。

## 未运行或不宣称的项目

- 未生成、安装或在干净机器验证 MSI/NSIS；没有独立安装、卸载或升级测试。
- 未目视验证错误窗口或第二实例的前景切换，也不覆盖任意外部/恶意本机进程情形。
- 本轮不能声明 `srcdoc`、`about:blank` 或任意同源 frame 的 IPC 授权已完成。P00 的最小实测保护是 Windows WebView2 对每个 child frame 的导航取消；对照运行只证明 frame probe 外部脚本能执行，具体 bridge/IPC 字段必须以该 run 的回执为准。
- 未验证强杀后的业务恢复；Job Object 只证明 P00 Node/FakeWorker 自行停止，不能代替恢复状态机验证。
- 未进行多 DPI、中文 IME、可访问性、完整 CSP 审计、性能对照或浏览器以外的系统兼容性验证。
- 未获得原生窗口截图或人工目视 UI 验收：本次环境的 `computer-use` 原生管道不可用。自动回执来自真实 Tauri WebView 执行，不是浏览器截图，也不代替目视验收。
- 不覆盖完整桌面产品、业务 API、数据库、Provider、恢复引擎或正式 ADR-007 冻结。
