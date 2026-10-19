# ADR-024：内置浏览器自动化后端与能力边界

状态：**Proposed**（架构审查完成，未实施）。日期：2026-10-17。
主设计：[内置浏览器自动化（F26）架构审查与实施方案](../architecture/browser-automation-v1.md)。范围：[范围矩阵 F26](../requirements/v1-scope.md#内置浏览器自动化范围补充2026-10-17)。

## 背景

Relay 桌面端需要"Agent 能操作网页"的能力，且明确要求：不与用户争抢 Windows 鼠标键盘、Agent 与用户可并行、不得默认操作用户正在使用的标签页、支持导航/定位/点击/输入/读取/截图/等待/标签页管理、与既有任务状态和权限体系集成、可在 Windows 安装包中交付、后端可替换。

审查事实（详见主设计 §1–§2）：桌面为 Tauri 2.11.6 + React 19.3；模型工具循环全部在 Worker 进程；工具是 `tool-catalog.ts` 里的冻结词表；权限走"能力 → 连接 → 策略 → 单动作 Review / 本次任务范围授权"；**仓库内没有任何 MCP 运行时**；既有 `COMPUTER_*` 是 SendInput/GDI 的桌面 GUI 自动化，与浏览器 DOM 自动化是两件事；`execution-router` 里的 `browser_cdp` 只是占位优先级位（Rust 侧上报 `not_configured`）。

## 决策

1. **后端采用 `chrome-devtools-mcp` 1.11.0**（Apache-2.0，Google 维护，随包 Node v24.21.0 满足其 `>=23`，发布物自包含无运行时依赖，14 MB / 370 文件），通过**新建的最小 MCP stdio 客户端**接入，不引入官方 SDK。
2. **由 Relay 拉起自有 Chrome 实例**（独立 `--user-data-dir` + `--remote-debugging-port=0`，读 `DevToolsActivePort` 得端口），MCP 以 `--browserUrl` 附着。不使用 MCP 默认的"自己拉浏览器"模式，也不使用 `--autoConnect`。
3. **浏览器是独立能力族**：`BROWSER_READ` / `BROWSER_ACTION` / `BROWSER_COMMIT` 三个能力 + 12 个 `browser_*` 工具，**不并入 `COMPUTER_READ`/`COMPUTER_INPUT`**。
4. **页面身份显式化**：所有页面工具接受可选 `page_id`，缺省为本次 Run/会话自建的默认页；未登记页（用户页、别的 Run 的页）一律拒绝。不调用上游 `select_page`，不依赖"当前聚焦标签页"。
5. **`BROWSER_ACTION` 可被"本次任务允许"范围授权覆盖；`BROWSER_COMMIT`（提交表单、上传文件）永不免批**；提交类点击由启发式风险分类器升级为单动作 ASK，并明确声明它不是安全边界。
6. **V1 不接入 `chrome-use`**，但 `BrowserProvider` 接口不泄漏 MCP 概念，保留后续替换位。

## 候选与取舍

| 候选 | 结论 | 主要理由 |
|---|---|---|
| `chrome-devtools-mcp` | **采纳** | 官方维护、a11y 快照 + uid 定位（符合"结构化优先"）、`pageId` 路由默认开启、默认不碰用户 profile、可离线自包含打包 |
| `chrome-use`（扩展 + native messaging） | V1 不采纳，保留位 | 需安装扩展并注册 native host（改用户浏览器）；驱动的就是用户真实标签页，其"每 session 一个标签组"正是需求点名不能当隔离的东西；带反检测取向；单维护者、无 npm 包、Windows 需自带 exe |
| 自研 CDP 客户端 | 否决 | 等于从零造自动化引擎（定位/等待/快照/重试全部要重写），与"禁止从零开发"直接冲突 |
| 直接用 Playwright | 未采纳（作为对照） | 是"库"不是"协议端点"：需自己设计工具面、元素引用与页面路由，等于自研上层；且与既有词表/权限的接缝要重做一遍 |
| `COMPUTER_*` 后台化（V2 Phase 3 原计划） | 否决 | 权限语义（读/交互/提交 vs 桌面接管）、结果形状、恢复语义都不同；合并会让"允许操作电脑"与"允许点网页"变成同一条授权 |

## 后果

正向：

- 复用既有四段权限与审批，不新建第二套执行身份；工具调用自动进入既有轨迹与聊天工具区。
- 安装包零系统改动（无扩展、无注册表、无 PATH、无服务），卸载即删目录。
- 后端可替换：换引擎只换 `BrowserProvider` 实现与映射表，词表/权限/UI 不动。

代价与限制：

- 新增约 14 MB 随包资源与一条 `pnpm`/Tauri 之外的资源暂存路径（`fetch-browser-mcp.mjs`），打包脚本需新增校验项。
- 自有 Chrome 是**第二个浏览器实例**，不复用用户登录态；"复用登录态"仍是未决策项（主设计 D2）。
- 同 profile 内页级隔离**不是安全隔离**（同 cookie）；"每 Run 独立 profile"未进 V1（D3）。
- 会话（chat）内仍只能读浏览器，动作必须走 Run（D1）；这是既有执行身份边界的延续，不是本 ADR 新引入的限制。
- 风险分类器是启发式，可能漏判有外部影响的点击；护栏是结构性三条（提交/上传工具永不免批、范围授权按 Run 且可见、origin 级策略可收窄），不承诺全覆盖。
- 上游大版本升级需显式动作（改固定版本 + 跑映射自检 + 复跑并行/隔离场景），不做运行时自更新。

## 与既有决策的关系

- 接续 [ADR-005](ADR-005-reuse-first.md)：复用成熟开源实现而非自研。
- 接续 [ADR-007](ADR-007-windows-desktop.md)：外部进程由 Tauri 宿主/API 管理，前端不直接拉进程。
- 接续 [ADR-022](ADR-022-agent-conversation-main-loop.md) 的执行身份边界：不新增会话写身份。
- 改变 [Computer Plugin V2 审计](../architecture/computer-plugin-v2-migration-audit.md) Phase 3 的接入形态：浏览器不再是 `COMPUTER_*` 的后台 provider，而是独立能力族；该审计的 `browser_cdp` 优先级位保持占位不动。

## 后续（待用户拍板后开工）

1. D1 会话内是否允许浏览器动作（建议保持只读）。
2. D2 是否提供"复用用户已登录 Chrome"（建议 V1 不做）。
3. D3 是否提供"每 Run 独立 profile"（建议不进 V1）。
4. 迁移序号：本片使用 `0105`（`0104` 已被"会话未读标记"占用）。
