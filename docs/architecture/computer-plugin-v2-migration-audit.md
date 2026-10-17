# Computer Plugin V2 迁移审查（Phase 1）与实施状态

角色：V2「从 Foreground Computer Use 迁移到 Background / Isolated Runtime」的**审查、迁移决策与实施状态**主文档。
状态：Phase 1 审查完成；**Phase 2（执行模式/路由/上下文/坐标空间/截图目标 + 前台授权硬闸门）已实现并真实取证**；Phase 3–5（Browser/CDP、UIA provider、Child Session 连接）未实现。
日期：2026-10-16。依据：本仓库实际源码 + 本机真实能力探测（原始输出在 `output/acceptance-raw/computer-plugin-v1-2026-10-16/`）。
上游事实：V1 审查与实现见[Computer Plugin V1 设计](computer-plugin-v1.md)；本页不复制 V1 的工具词表与协议细节。

---

## 1. V1 实际架构（代码事实）

```text
Relay Agent（会话主流程 / Run 工具循环）
  ↓  workflow/tool-catalog.ts（10 个 computer_* 工具，冻结词表 + JSON Schema）
Gateway（application/gateway-actions.ts）
  ↓  capability：COMPUTER_READ / COMPUTER_INPUT；prepare → 准入 → Review/范围授权 → dispatch
Computer 适配器（src/computer/computer-adapter.ts）
  ↓  参数白名单、结果投影（截图只留摘要，图片正文不进账本）
Runtime 客户端（src/computer/runtime-client.ts + client-holder.ts）
  ↓  常驻子进程：懒启动、request_id 关联、idle 回收、崩溃重建、超时杀进程、回复丢失判 UNKNOWN
IPC：stdin/stdout JSON-lines（版本标签 relay-computer-v1）
  ↓
Windows 运行时（apps/computer-runtime，Rust）
  ↓  screenshot：GDI BitBlt 虚拟屏 → PNG；window：EnumWindows/GetWindowRect/SetForegroundWindow
  ↓  input：SendInput（鼠标绝对坐标 + KEYEVENTF_UNICODE 键盘）
Windows API（用户当前会话的桌面）
```

## 2. V2 十问的逐条回答

| # | 问题 | 事实 |
|---|---|---|
| 1 | 哪些代码可以保留 | Rust 运行时的进程形状与协议层（`protocol.rs`/`main.rs`）、API 侧客户端生命周期（`runtime-client.ts`）、适配器参数白名单与结果投影、Gateway 两个能力与审批/范围授权接线、工具词表 10 个工具与 schema、mock 模式、错误码词表、真实 Windows 验收脚本 |
| 2 | 哪些代码必须迁移 | ① `input.rs` 的 SendInput 从**默认执行器**降级为 `foreground` 专用提供者；② `window.rs` 的 `SetForegroundWindow`/`AllowSetForegroundWindow` 同样降级并加用户确认；③ 截图从「只能截用户桌面」改为 `CaptureTarget` 抽象；④ 坐标从「隐式用户桌面」改为显式 `CoordinateSpace` + `context_id` |
| 3 | 哪些代码与新架构冲突 | `originAllows` 现在把 `COMPUTER_INPUT` 直接放行给 RUN，缺少「模式」维度；`adapter-metadata.ts` 的 `COMPUTER_INPUT` 描述符只表达「需审批」，未表达「默认不得碰用户桌面」；工具 schema 的 `x/y` 无坐标空间；`computer_screenshot` 无 target 参数 |
| 4 | 哪些 Tool Schema 可以继续复用 | 工具名与参数形状整体保留（`computer_click/get_windows/activate_window/scroll/drag/type/keypress/hotkey`），只做**增量**扩展：`coordinate_space`、`context_id`、`capture_target`、`element_id`（UIA 目标） |
| 5 | 哪些 UI 可以继续复用 | 现有全部：会话消息、Run 工具轨迹面板（按 `tool_name` 泛化渲染，新工具/新状态名自动显示）、审批卡片（Review）、状态短语。V2 只需**新增轻量**「工作区/模式」提示，不新建控制台 |
| 6 | 哪些 Permission 可以继续复用 | Gateway 能力 + 策略（AUTO/ASK/DENY）+ 单动作 Review + 本次任务范围授权（`run_scope_grants`）全部复用；V2 把能力细化为 `background_read`/`background_ui_action`/`isolated_input`/`foreground_input` 并给不同默认值 |
| 7 | Runtime 是否已是独立进程 | **是**。由 API 懒启动的常驻子进程，空闲回收，崩溃重建；不是 Tauri 侧进程，也不是每次调用新建 |
| 8 | 当前 IPC 是否可以继续使用 | **可以**。JSON-lines（stdio）已满足相关性、超时、断开检测、重连；V2 新增方法只需扩展方法词表。命名管道不是必需（当前形状与 `relay-file-io-helper` 先例一致） |
| 9 | 当前 Screenshot 如何实现 | GDI：`GetDC(null)` + `CreateCompatibleBitmap` + `BitBlt(SRCCOPY)` 抓**整个虚拟屏** → `GetDIBits` 取 BGRA → 转 RGB → `png` crate 编码 → base64。API 侧剥离图片正文，只留宽高/原点/时戳/sha256/字节数 |
| 10 | 当前 Mouse / Keyboard 如何实现 | 全部 `SendInput`：鼠标 `MOUSEEVENTF_ABSOLUTE` 归一化到虚拟屏 0..65535，按下/抬起分离，滚轮按 120 单位取整，拖拽线性插值；键盘文本用 `KEYEVENTF_UNICODE` 逐 UTF-16 单元（中文不经 IME 模拟），按键/组合键用 VK 码 |

## 3. 迁移决策：Keep / Migrate / Remove-from-default-path

### 3.1 保留（不动）

- 工具词表与 schema 骨架、Gateway 能力/审批/范围授权接线、`session_tool_calls`/`run_tool_calls` 账本、错误码词表、mock 模式、客户端生命周期与 IPC 形状、真实验收脚本骨架。

### 3.2 迁移（改默认执行路径）

| V1 默认行为 | V2 归属 |
|---|---|
| `SendInput` 作为 `computer_click/type/keypress/...` 的默认实现 | 降级为 `foreground` 模式的 `ForegroundInputProvider`，**必须**用户显式确认 |
| `SetForegroundWindow` 作为 `computer_activate_window` 的默认实现 | 同上；后台模式改用 UIA（`SetFocus`/`Invoke`）或 CDP |
| 截图 = 用户当前桌面 | `CaptureTarget` 抽象：`agent_session`（默认）/`window`/`browser_page`/`user_desktop`（需显式） |
| 坐标 = 用户桌面虚拟屏 | 显式 `CoordinateSpace`（`user_desktop`/`window`/`agent_session`/`browser_viewport`）+ `context_id` 校验 |
| 无执行模式概念 | `ComputerExecutionMode`：`background`（默认）→ `isolated` → `foreground`（仅用户授权） |
| 工具直接对应一个 Windows API | `ComputerExecutionRouter` 先判定目标与可用模式，再选提供者 |

### 3.3 从默认路径移除（保留代码，不默认使用）

`SendInput`、`SetCursorPos`（未使用但同族）、`SetForegroundWindow`/`BringWindowToTop`/`SetActiveWindow`、`mouse_event`/`keybd_event`（现为死代码，保留为 legacy）、整屏 `GetDC(null)` 截图。

## 4. V2 目标架构与 V1 的差异（必须新增的组件）

```text
Computer Plugin
  ↓
ComputerExecutionRouter（目标判定 → 模式选择 → 提供者）
  ├─ BrowserAdapter（CDP）        ← 新增
  ├─ UIAutomationProvider          ← 新增（本机已证明可用，见 §6）
  ├─ AgentSessionManager（Child Session） ← 新增（能力探测已做，见 §6）
  └─ ForegroundInputProvider       ← 由 V1 的 SendInput 降级而来
```

配套：`ComputerContext`、`CoordinateSpace`、`CaptureTarget`、`ComputerExecutionMode`、`AgentSessionManager` 生命周期状态机、`handoff_to_user()`/`return_to_agent()` 接口预留。

## 5. 实施计划（对应 V2 任务书 Phase 2–10）与真实前置条件

| 阶段 | 内容 | 本机前置条件（已核） |
|---|---|---|
| Phase 2 | 模式/路由/Context/坐标空间/截图目标 | 无外部依赖；需先让运行时 **per-monitor DPI aware**（见 §6.3），否则各坐标空间不一致 |
| Phase 3 | Browser/CDP 适配器 | **本仓库没有可复用的浏览器自动化**：只有 `web/web-fetch.ts`（HTTP 取页面）与 `USER_IMPORT`，没有 CDP/Playwright/浏览器连接。因此这是**新建**而非复用；需要决定 CDP 连接方式（已有浏览器远程调试端口 vs 由 Relay 启动带 `--remote-debugging-port` 的实例） |
| Phase 4 | UIAutomationProvider（find/inspect/invoke/set_value/get_value） | UIA 客户端在本机**可用**（探测已枚举顶层元素）。实现路线待定：Rust `uiautomation` crate（需评估离线可构建性）或 C# 辅助进程 |
| Phase 5 | AgentSessionManager（Child Session） | **系统级已启用**（`WTSIsChildSessionsEnabled=True`），但**当前无子会话**；OS 为 **Windows 11 家庭中文版 build 22631**。需实测 `WTSEnableChildSessions` 之外的连接路径（`ConnectToChildSession`/RDP ActiveX）在 Home 版是否可用——这是 V2 最大的未知项，不能假设 |
| Phase 6 | click/type/keypress/scroll/drag 全部走 Router | 依赖 Phase 2/4/5 |
| Phase 7 | SendInput 降级 + 强制确认 | 无外部依赖 |
| Phase 8 | 截图统一到 CaptureTarget | 依赖 Phase 5（agent_session 截图需要子会话） |
| Phase 9 | 权限/状态/工具活动接入 | 复用现有 Gateway 与 UI |
| Phase 10 | 真实「不打扰用户」测试 | **本机当前正被另一会话使用**（见 §7），这既是 V2 的动因，也意味着前台测试必须谨慎 |

## 6. 本机能力探测结果（真实，非推测）

原始输出：`output/acceptance-raw/computer-plugin-v1-2026-10-16/probe-capabilities.ps1` 与其运行输出。

### 6.1 Child Session

```text
OS:                         Windows 11 家庭中文版（Home），version 10.0.22631，64-bit
WTSIsChildSessionsEnabled:  ok=True  enabled=True      ← 系统级已启用
WTSGetChildSessionId:       ok=False childSessionId=0xFFFFFFFF  ← 当前无子会话
WTSGetActiveConsoleSessionId: 1
当前进程 SessionId:          1（控制台会话）
```

结论：**Child Session 已启用但未建立**。能否真正连接（创建并连入子会话，且应用能在其中启动）**尚未验证**，Windows 11 家庭版是主要风险点。按 V2 §35 要求：**不以推测或 mock 冒充生产能力**，Phase 5 必须先做连接实测。

### 6.2 UI Automation

```text
UIAutomationClient 程序集: 可加载
RootElement 可访问:        是
顶层元素采样:              ''[Pane], ''[Pane], 'C:\Windows\system32\cmd.exe'[Window],
                          'WorkBuddy'[Window], 'ChatGPT'[Window]
```

结论：UIA 在本机可用，能读到窗口名与控件类型。Phase 4 可行。

### 6.3 DPI（必须处理的既有偏差）

```text
GetSystemMetrics 虚拟屏 = 1536x864（DPI 虚拟化视图）
ShellWindow / 窗口矩形同样来自 DPI-unaware 进程
```

runtime 不是 DPI-aware，因此它看到的是**虚拟化**坐标；而 UIA 与 per-monitor-DPI-aware 应用使用**物理**坐标。同一台机器上两套坐标不一致，是 V2 引入 UIA 后必然踩到的坑。**Phase 2 必须先设定 `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)`**，让截图、窗口矩形、SendInput、UIA 四方共用物理坐标，否则「截图坐标 → UIA 元素坐标 → 点击坐标」会互相错位。

## 7. 环境实证：本机桌面正被多方使用

V1 真实验收期间（2026-10-16 22:5x），脚本读到的剪贴板属于**另一个会话**的内容：

```text
"已用电脑插件真实点击验收 24 条路径，覆盖菜单、抽屉、项目子页和创建表单。结论是：部分通过…"
"已编辑 3 个文件" / "docs/testing/overall-acceptance-2026-09-28.md" / "23:06"
UIA 探测同时看到 'ChatGPT' 与 'WorkBuddy' 窗口
```

即：**验收脚本运行时，这台机器上还有另一个 agent 会话/用户在用同一套鼠标、键盘与剪贴板。** 由此得到两条硬结论：

1. V1 的前台输入在当前环境下**既不可靠也不安全**（输入可能落到他人的窗口，剪贴板被他人覆写，窗口焦点被他人抢走）——这正是 V2 要消除的形态。
2. 前台输入的验收**不得在本机并发使用期间反复重跑**；V2 验收应改为在 isolated session 内进行，或仅在用户明确许可的窗口内、且只跑一次。

V1 在此环境下已取到的可靠证据（不重复跑前台输入）：截图（PNG 可解码、1536x864）、窗口枚举（pid/进程名/矩形/焦点）、激活、真实点击 + 中文输入 + 回车（隔离实验中 30ms 字符间隔 3/3 稳定）、崩溃重连、mock、错误码路径。

## 8. 已知限制（不隐藏）

- **Browser/CDP：无既有实现可复用**。任务书假设「Relay 已有 Browser Tool/CDP 连接」，实际仓库只有 HTTP 取页面（web-fetch）与公共导入，没有浏览器自动化。Phase 3 是新建。
- **Child Session 连接未验证**，且 OS 为家庭版；可能不可用。若不可用，按 V2 §17 返回 `ISOLATED_SESSION_UNAVAILABLE` 并进入等待用户，**不允许回退 SendInput**。
- **UIA 覆盖范围有限**：自绘 UI、游戏、部分 Electron/Java 应用不暴露 UIA 树，这些场景只能走 isolated 或 foreground。
- **并发使用**（§7）：在用户仍使用电脑时，任何前台路径都会互相干扰。
- **字符间隔**：`computer.type` 需要 ≥30ms/字符才在本机（中文环境）稳定，长文本会慢；已作为 `delay_ms` 参数（1..100，默认 30）暴露。

## 9. Phase 2 实施状态（2026-10-16）

已实现并取证（`apps/computer-runtime`、`apps/api/src/computer/`）：

1. **DPI 感知修复**：运行时启动即设 `PER_MONITOR_AWARE_V2`，实测虚拟屏从虚拟化 1536x864 变为**物理 1920x1080**，显示器枚举同源。截图、窗口矩形、SendInput、（未来的）UIA 四方坐标自此一致。
2. **`computer.describe_environment`**：真实探测 DPI 感知级别、虚拟屏、显示器列表、Child Session 状态（`WTSIsChildSessionsEnabled`/`WTSGetChildSessionId`，本机 enabled=true 但无子会话）、UIA 客户端库可加载性（provider 未实现，如实标注）、以及三模式的可用性摘要。API 侧带 30s TTL 缓存，进程重建即失效。
3. **`CaptureTarget`**：`computer.screenshot` 增加 `target`（`user_desktop`/`window`+`window_id`/`agent_session`/`browser_page`）。后两者**不可用即类型化拒绝**（`ISOLATED_SESSION_UNAVAILABLE`/`CAPTURE_TARGET_UNAVAILABLE`），绝不退回整屏桌面截图；`window` 目标按窗口矩形区域截图。
4. **前台授权硬闸门（核心）**：八个桌面输入方法（activate/click/double_click/scroll/drag/type/keypress/hotkey）在运行时**必须**带 `allow_foreground: true` 才执行，否则 `FOREGROUND_NOT_AUTHORIZED`。该参数不在工具 schema 里——模型无法自我授权；由适配器在 **Gateway 派发时**注入（派发前必有单动作 Review 批准或本次任务范围授权）。mock 模式同样执行这条闸门。
5. **执行路由**（`src/computer/execution-router.ts`，纯决策）：只读按目标路由（用户桌面/窗口/独立工作区/浏览器页）；输入按优先级 Browser/CDP → UIA → isolated → foreground，**后台不可用时结论是「需要用户授权」而不是静默执行**。prepare 阶段把「需要接管电脑」写进审批文案（`⚠️ 此操作需要接管你的电脑…`），用户看到的是接管确认而不是抽象的「需要批准」。
6. **类型与词表**：`ComputerExecutionMode`/`CoordinateSpace`/`ComputerContext`/`ComputerEnvironment` 落地 `protocol.ts`；错误词表 +3（`FOREGROUND_NOT_AUTHORIZED`/`ISOLATED_SESSION_UNAVAILABLE`/`CAPTURE_TARGET_UNAVAILABLE`）并与 Rust 侧逐字一致。

已运行证据（真实 Windows，本机）：
- `cargo test` 18/18（新增：授权闸门、只读不需授权、截图目标拒绝、环境探测形状、真实探测不谎报）。
- `apps/api` 定向单测 58/58（`computer-plugin` 25 项含执行路由优先级/授权语义/派发注入、`computer-runtime-client`、`tool-loop` 词表封闭性）；`tsc --noEmit` 全绿。
- 真实验收 `v2-phase2-acceptance.mjs` **4/4**：环境探测如实（不谎报）；**八个输入方法未授权全部被拒（8/8），零输入产生**；不可用截图目标拒绝不回退；窗口截图可用且不改前台。
- 观察记录：本机验收期间正被另一会话并发使用（鼠标持续移动、前台在其窗口间切换）——只读/被拒路径在代码上不产生任何输入，观察到的桌面变化只能来自并发方；受控环境的归因测试属 Phase 10。

未实现（后续阶段）：Browser/CDP 适配器（Phase 3）、UIA provider（Phase 4）、Child Session 创建与连接（Phase 5）、五个输入工具的完整 Router 迁移与 UI 状态呈现（Phase 6/9）、受控环境的「用户不被打扰」归因测试（Phase 10）。
