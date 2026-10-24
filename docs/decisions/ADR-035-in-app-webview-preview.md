# ADR-035：右侧内置网页预览使用 Tauri 原生子 WebView

状态：**Accepted**（2026-10-24，用户执行 `prompts/workbench-browser-preview.md` 授权落地）。产品交互归[工作台 §50](../frontend/workbench-design.md#50-右侧工具面板与内置网页预览)，宿主边界归[浏览器架构 §15](../architecture/browser-automation-v1.md#15-右侧内置网页预览的规划边界)，范围与顺序归[路线 §17](../requirements/post-v1-roadmap.md#17-右侧工具面板与内置网页预览)。本 ADR 只记录容器选型与隔离取舍；它**不**改变 [ADR-025](ADR-025-extension-bridge.md) 的外部 Chrome 自动化决策。

## 背景

用户需要在同一协作窗口里「查看结果 → 对照验收条件 → 反馈」。当前工作台右侧只有只读工具（文件、变更、终端占位、运行与轨迹），要检查一个网页成果必须切到外部浏览器，回来时上下文与判断线索都断了。

约束来自三条既有事实：

1. 桌面固定 `tauri = 2.11.6`，主窗口已有 `on_navigation` 守卫、frame guard、拒绝新窗口、只有 `main` 一份 capability。
2. 工作台 capability 带 `remote.urls = ["http://127.0.0.1:5173"]`（tauri dev 的 Vite 来源）。
3. 浏览器自动化默认路线是「用户现有 Chrome + 扩展」（ADR-025），内置预览**不得**变成第二条自动化通道。

## 候选与被拒理由

| 候选 | 能否嵌入右栏 | 隔离是否可证 | 结论 |
|---|---|---|---|
| 任意站点 `<iframe>` | 是 | **否**——同源策略只挡 DOM 读取，页面仍与工作台同进程、同存储、同 CSP 家族；`X-Frame-Options`/`frame-ancestors` 会让多数站点直接不可用 | 拒。它还会让「地址栏显示的是 iframe 内部跳转」变成无法如实呈现的假象 |
| 主窗口直接 `navigate` 到外页 | 是 | 否——等于把工作台自己导航走，主窗口守卫会拦，放宽它就把整个 IPC 面暴露给外页 | 拒 |
| 另开一个独立 `WebviewWindow` | 是（浮窗） | 是 | 拒为**首版**方案：它是「另开窗口」，用户仍要切换窗口，且与「不新增第四列、不叠遮挡层」的布局约束冲突。保留为将来多屏场景的候选 |
| **主窗口内的原生子 WebView** | 是 | 是（见下） | **采用** |
| 随包再带一套浏览器内核 | 是 | 是 | 拒：体积与升级成本远超本需求，且与 ADR-025 的「不恢复自有 Chrome」方向相反 |

## 决策

1. **容器 = Tauri 原生子 WebView**（`Window::add_child` + `WebviewBuilder`）。该 API 在 2.11.6 由 `unstable` feature 门控；实测 `tauri-runtime-wry` 的同名 feature 是**空列表**，启用它不引入任何新 crate，`Cargo.lock` 不变。这是「按锁定版本启用实验 API」，不是升级依赖。
2. **profile 隔离 = 独立 WebView2 用户数据目录 + InPrivate**。子 WebView 用 `<data-root>/preview-webview` 作为 `data_directory`，wry 因此为它创建**另一套** `ICoreWebView2Environment`（不同 user data folder → 不同 Cookie / LocalStorage / Service Worker 存储），再叠 `incognito(true)` 让登录态不落盘。选 InPrivate 而不是「独立持久 profile」的原因是：**登录态保留周期与清理入口必须先定义才能承诺**，首版直接选择「不保留」，把这个待定项彻底消掉，而不是先留一份可被忽略的持久 Cookie。
3. **隔离的真正边界是导航策略，不是 webview 标签**。这一条必须写进文档，否则后续维护者会以为「给子 WebView 起个别的标签就安全了」：Tauri 的能力解析按 `(窗口标签, 当前 URL 来源)` 匹配 capability（`RuntimeAuthority::resolve_access`），而匹配条件是 `webviews.any(...) || windows.any(...)`。capability `main-window` 只约束窗口标签 `main`，因此**位于 main 窗口内的子 WebView 依然命中窗口级 capability**。真正挡住外页的是 `remote.urls` 白名单——而开发前端来源 `http://127.0.0.1:5173` 正躺在里面。所以地址策略必须**无条件**拒绝该来源（dev 与 packaged 一致，避免两套行为漂移），并同时拒绝 `tauri.localhost`、`ipc.localhost`、本机 Relay API 端口以及非 http/https 协议。
4. **校验用解析器，不用字符串前缀**，且在**创建时**与**每一次导航**（含服务端重定向、脚本跳转）各判一次。回环判断交给 `std::net` 的 `is_loopback`/`is_unspecified`（IPv6 先剥方括号），端口比较前先确认主机确实是本机，避免把公网同号端口误伤。
5. **新窗口、下载、原生权限默认拒绝**。`on_new_window → Deny`、`on_download → false`；`PermissionRequested` 只对主窗口的打包来源放行通知，子 WebView 不授予摄像头/麦克风/定位/通知。证书错误不绕过。需要这些能力的站点由用户显式「在系统浏览器打开」（`ShellExecuteW`，只传 URL，不拼命令行）。
6. **不注入、不 eval、不暴露给模型**。子 WebView 不加载任何授权桥，宿主侧只用 `with_webview` 调用 `GoBack/GoForward/Stop/CanGoBack/CanGoForward` 与 `add_ProcessFailed`；工作台通过命令面驱动，页面无法反向驱动工作台。首版不向模型提供任何内置页面工具，`BrowserProvider` 权限不变。
7. **恢复数据只存来源**。`relay.workbench.previewRestore.v1` 保存 `scheme://host[:port]`、标签顺序与选中项；path / query / fragment / 标题 / 正文 / 浏览器存储一律不落盘，带凭据或带 path 的值在写入与读取两侧都被丢弃。重启后只显示待恢复提示，点一下填进地址栏，按「打开」才加载。

## 后果

正向：

- 页面与工作台在**同一窗口同一右栏**，不需要切换应用即可对照验收条件。
- 隔离可逐条复验：URL 策略有 Rust 单元测试；profile 独立、IPC 不可用、无授权桥可在真实打包态用攻击夹具验证。
- 零新增依赖、零迁移、零 API 变化；`unstable` 只影响桌面 crate 的编译开关。

代价与限制（如实）：

- **`unstable` 是实验 API**：Tauri 明确标注它可能在小版本内改变形状。升级 Tauri 时必须重跑本 ADR 的 P0 门槛，不能假定仍然可用。
- **两套 WebView2 环境**：多一套 browser 进程组与内存占用。实例上限设为 12 个标签，超出拒绝创建并给出原因。
- **原生子窗口不参与 DOM 合成**：它永远盖在父窗口客户区之上，DOM 弹层挡不住它。因此面板监听 `[role="dialog"]` 出现时把容器 `hide()`，并在面板不可见/切走页签时同样隐藏——这是「遮挡」问题的唯一正确解法，不能用 `z-index` 解决。
- **几何要手动同步**：`ResizeObserver` + `resize`/`scroll`（捕获阶段）在 rAF 里量 `getBoundingClientRect()` 再 `set_bounds`。窗口跨屏 DPI 变化时逻辑坐标仍然正确，但依赖一次新的量测。
- **加载失败不可精确判定**：WebView2 的 `on_page_load` 只有 Started/Finished，网络失败会渲染它自己的错误页。因此工作台**不伪造**「加载失败」状态，只如实显示实际地址与「重新加载 / 在系统浏览器打开」；进程崩溃则通过 `add_ProcessFailed` 单独订阅，与慢加载区分开。
- **隐藏 ≠ 停止**：`hide()` 只是把容器移出视野，页面后台请求继续。UI 文案与文档都必须说清「停止加载不等于撤销请求，关闭标签也不能证明外部操作没发生」。
- **非 Windows 无实现**：命令返回明确错误，不静默降级成外部窗口或 iframe。

## 与既有决策的关系

- 不取代、不修改 [ADR-025](ADR-025-extension-bridge.md)：外部 Chrome 扩展仍是 Agent 自动化的默认路线；内置预览是**人工**浏览容器。
- 接续 [ADR-007](ADR-007-windows-desktop.md) 的宿主边界：新模块只服务当前桌面容器，不预建通用插件框架。
- 业务 Owner 不变：页面查看不生成 Verification PASS、Review 批准或 Task 完成；动态网页不是不可变 Artifact。
