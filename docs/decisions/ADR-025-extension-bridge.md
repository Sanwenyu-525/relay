# ADR-025：浏览器自动化改为「用户现有 Chrome + 扩展桥接」

状态：**Accepted**（用户 2026-10-17 下达新任务书，明确技术路线）。取代 [ADR-024](ADR-024-builtin-browser-automation.md) 的第 2、3 条决策（连接模式与能力族划分**部分**维持，见下）。主设计：[浏览器自动化 V1](../architecture/browser-automation-v1.md)。

## 背景与变更原因

ADR-024 选定「Relay 拉起**自有** Chrome（独立 profile）→ chrome-devtools-mcp 经 `--browserUrl` 附着」。用户随后下达的任务书把目标改为：**直接使用用户平时打开的 Chrome、复用其 profile 与登录状态、在非激活标签页中操作、不抢前台**。

两条路在工程上互斥，且 Chrome 自身已经封死了折中方案：

| 路线 | 能否复用用户登录态 | 关键限制 |
|---|---|---|
| 自有 Chrome + CDP（ADR-024，已实现 M1–M2） | **否**——独立 profile | 与新目标直接冲突；且不再是"用户平时打开的 Chrome" |
| 接管用户默认 profile + 远程调试端口 | 是 | **Chrome 136 起禁止**对默认 profile 使用 `--remote-debugging-port`（须配非默认 `--user-data-dir`，等于又回到独立 profile）；且用户 profile 已被日常实例占用时第二个实例起不来 |
| **Chrome 扩展 + `chrome.debugger`** | **是**——就在用户自己的 Chrome 里 | 需要安装扩展（用户可见、需确认）；`chrome.debugger` 附着会显示调试提示条 |

结论：扩展桥接是唯一同时满足"用户现有 Chrome + 登录态 + 不抢前台 + 合规"的路径。`chrome.debugger` 是按标签页附着 CDP 的**官方 API**，不需要远程调试端口，因此不受 Chrome 136 的端口限制。

## 决策

1. **浏览器自动化引擎 = 用户现有 Chrome 中的扩展**（`apps/browser-extension/`，Manifest V3，`debugger` + `tabs` + `nativeMessaging` 不需要），扩展通过 `chrome.debugger` 按标签页附着 CDP，用官方调试协议驱动页面。
2. **通信桥 = 受认证的本地 WebSocket**（不用 Native Messaging）：扩展的 service worker 直连 Relay API 已有的 loopback 监听（`ws://127.0.0.1:<port>/…`），携带配对令牌。选择理由：零注册表写入、零原生主机 exe、打包与卸载即"删文件"，且复用 API 既有的鉴权与边界（Native Messaging 需要注册表 + 独立宿主进程 + Chrome 拉起的生命周期，成本更高且同样需要一条到 Relay 的通道）。
3. **Provider 可替换的既定设计兑现**：`BrowserProvider` 接口不变，新增 `ExtensionBridgeBrowserProvider`；`chrome-launcher.ts` + `McpBrowserProvider`（CDP 自有 Chrome）**降级为非默认后端**，保留用于离线开发与对照测试，通过 `RELAY_BROWSER_PROVIDER=extension|cdp` 显式选择，默认 `extension`。
4. **非激活标签页**：扩展用 `chrome.tabs.create({ active: false })` 建页，**从不**调用 `chrome.tabs.update({ active: true })` 或 `chrome.windows.update({ focused: true })`——这两个调用在扩展代码里不存在，是可审计的硬事实，不是运行时检查。
5. 页面所有权、缺省页语义、STALE、UNKNOWN 结算、`BROWSER_COMMIT` 永不免批——**全部沿用**，这些是任务无关的。

## 后果

正向：登录态/登录复用成为可能；不再产生第二个 Chrome 窗口与第二份 profile；不再需要 `--remote-debugging-port` 与 `DevToolsActivePort`；打包只需随包携带扩展目录（用户一次性加载）。

代价与限制（如实）：

- **需要一次性安装扩展**：开发态用"加载已解压的扩展程序"，正式包再定分发方式（CRX/Web Store）。扩展未装时一切浏览器工具返回 `BROWSER_EXTENSION_MISSING` + 安装引导，不静默降级。
- `chrome.debugger` 附着会在 Chrome 顶部显示"正在调试此浏览器"提示条，这是 Chrome 的硬性行为，无法隐藏，须在 UI 里如实说明。
- 扩展 service worker 可能被 Chrome 回收：靠 WS 重连 + 命令幂等恢复；扩展重启/断连期间的动作按 UNKNOWN 结算（与既有取消语义一致）。
- 非激活标签页的 `setTimeout`/`setInterval` 被 Chrome 节流：等待类能力不得依赖页面定时器，统一用扩展侧轮询 CDP；这条必须实测（任务书 §7 明确要求）。
- `chrome.debugger` 的 CDP 子集与 puppeteer 有差异（无 `waitForEventsAfterAction` 之类的封装），等待与稳定化逻辑要自己写。
- MCP stdio 客户端与 chrome-devtools-mcp 随包资源**不再被默认路径使用**；`scripts/fetch-browser-mcp.mjs` 保留给 cdp 后端。

## 与既有决策的关系

- 取代 [ADR-024](ADR-024-builtin-browser-automation.md) 决策 2（连接模式）与 3（"自有实例"）的一半：能力族三划分、页面所有权、权限模型、`BROWSER_COMMIT` 永不免批**全部维持**。
- [ADR-005](ADR-005-reuse-first.md) 不变：引擎是 Chrome 官方 `chrome.debugger`（成熟的"浏览器原生自动化接口"），自研部分只剩协议转换与桥接。
- [ADR-007](ADR-007-windows-desktop.md) 不变：扩展与桥接由 API 进程承载，前端不直接管理外部进程。

**2026-10-18 增量**：桌面模式给 API 的端口由「临时（0）」改为固定 `43117`（占用时回退 0）。原因是扩展只认用户手动填的 `serverUrl`，端口每次变就等于每次重启都要重新配对；本决策（用户自己的 Chrome + MV3 扩展 + 配对令牌）不变。同一轮还修了 `bridge.json` 记录**请求**端口（0）而非实际绑定端口、导致 Worker 侧命令路径永久失败的问题。
