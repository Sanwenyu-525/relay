# Computer Plugin V1 设计与实现

角色：Computer Plugin V1（Windows 桌面能力）的**设计与协议**主文档。
状态：V1 已实现并做过真实 Windows 取证；**默认前台执行路径已被 V2 审查判为需迁移**，见[V2 迁移审查](computer-plugin-v2-migration-audit.md)。
日期：2026-10-16。代码事实：`apps/computer-runtime/`（Rust 运行时）、`apps/api/src/computer/`（客户端与适配器）、`apps/api/src/workflow/tool-catalog.ts`（工具词表）、`apps/api/src/application/gateway-actions.ts`（能力与准入）、`apps/api/migrations/0092_computer_use.sql`。

## 1. 定位与边界

Computer Plugin 让 Agent 具备「观察并操作 Windows 电脑」的能力。V1 的闭环是：

```text
Observe（screenshot / get_windows） → Act（click / type / keypress / …） → Observe → Verify
```

V1 明确 Windows 10/11 单平台，不引入 macOS/Linux；平台 API 全部收敛在运行时内部，Agent 核心不感知 Windows API。

## 2. 进程与 IPC

```text
API 进程（Node）
  └─ ComputerRuntimeClient（进程级单例，src/computer/client-holder.ts）
        ↓ spawn relay-computer-runtime.exe（windowsHide）
        ↓ stdin/stdout JSON-lines，版本标签 relay-computer-v1
     Rust 运行时（apps/computer-runtime）
```

- **懒启动**：第一次工具请求才 spawn；会话内保持；空闲 60s 回收。
- **请求关联**：每行请求带 `request_id`，回复按 `request_id` 归位；写入串行化，避免交错产生半截 JSON。
- **崩溃恢复**：进程退出立即让在途请求失败；下一个请求透明重建。**已写入但回复丢失的请求判「效果未知」**（`effectUncertain`），由 Gateway 结算为 UNKNOWN 而不是 FAILED——输入可能已经到达桌面。
- **超时**：单请求默认 30s 未响应则杀掉整个进程（可能已卡死），由下一请求重建。
- **取消**：abort 只解除本次等待，**不杀进程**（进行中的输入可能已产生外部效果）。
- 协议错误（非法 JSON、版本不匹配、超大行）一律杀掉进程，不猜后续行形状。

### 请求/回复

```json
{"version":"relay-computer-v1","request_id":"<uuid>","method":"computer.click","params":{"x":100,"y":200,"button":"left"}}
{"version":"relay-computer-v1","request_id":"<uuid>","success":true,"result":{"clicked":true,"x":100,"y":200,"button":"left"}}
{"version":"relay-computer-v1","request_id":"<uuid>","success":false,"error":{"code":"WINDOW_NOT_FOUND","message":"…","retryable":true}}
```

错误码词表（冻结）：`INVALID_REQUEST`、`RUNTIME_UNAVAILABLE`、`SCREENSHOT_FAILED`、`WINDOW_NOT_FOUND`、`WINDOW_ACTIVATION_FAILED`、`INVALID_COORDINATE`、`INPUT_FAILED`、`PERMISSION_DENIED`、`USER_CANCELLED`、`TIMEOUT`、`UNKNOWN`。API 侧另有传输层码 `IPC_DISCONNECTED`、`PROTOCOL_VIOLATION` 与 `effectUncertain` 标记。

## 3. 十一个工具

工具名用 snake_case 的 `computer_` 前缀：OpenAI 兼容协议的工具名只接受 `[a-zA-Z0-9_-]`，点号会被 Provider 拒绝；对外稳定性由词表保证。

| 工具 | 能力 | 参数 |
|---|---|---|
| `computer_screenshot` | COMPUTER_READ | 无 |
| `computer_get_windows` | COMPUTER_READ | 无 |
| `computer_activate_window` | COMPUTER_INPUT | `window_id` |
| `computer_move` | COMPUTER_INPUT | `x`、`y` |
| `computer_click` | COMPUTER_INPUT | `x`、`y`、`button?`（left/right/middle） |
| `computer_double_click` | COMPUTER_INPUT | `x`、`y` |
| `computer_scroll` | COMPUTER_INPUT | `delta_x?`、`delta_y?` |
| `computer_drag` | COMPUTER_INPUT | `start{x,y}`、`end{x,y}`、`duration_ms?` |
| `computer_type` | COMPUTER_INPUT | `text`、`delay_ms?`（1–100，缺省 30） |
| `computer_keypress` | COMPUTER_INPUT | `key` |
| `computer_hotkey` | COMPUTER_INPUT | `keys[]` |

模型多带的字段不会变成动作参数（`gatewayParamsFor` 白名单转发 + `validateToolArguments` 拒绝未知字段）。

## 4. 能力、权限与审批

- **两个能力**：`COMPUTER_READ`（截图/窗口枚举，effect READ，`approvalPassthrough: true`）、`COMPUTER_INPUT`（其余八个，effect WRITE，`approvalPassthrough: false`、`resumable: false`）。
- **放行范围**：会话只读轮次（`ASSISTANT_READ`/`AGENT_SESSION_READ`）只放行 `COMPUTER_READ`；`COMPUTER_INPUT` 只在 RUN（Task/Run 工具循环）出现。
- **放行手段**：默认策略可 AUTO 的只有读取；输入类即便策略为 AUTO 也会降级 ASK（非穿透适配器），因此必须有单动作批准（Review，Allow once）或**本次任务范围授权**（`run_scope_grants` 的动作类 `COMPUTER_INPUT`，Allow for task）。**V1 不提供「始终允许」**：与 CLI_RUN 同纪律，无人审批的桌面输入不开放。
- **目标**：Computer 动作没有受管根，`normalized_target` 用合成值 `computer://desktop`，策略按全等匹配；动作仍绑定 Project 的受管资源（来源身份与账本归属）。

## 5. 结果形状与截图生命周期

- 截图：运行时回复 base64 PNG；**适配器只把摘要写进账本**（`width`、`height`、`origin_x`、`origin_y`、`timestamp`、`image_bytes`、`image_sha256`），图片正文不落账本、不长期保存。V1 不把图片喂给模型（多模态通路未接）。
- 窗口列表：最多 64 条，超出显式 `truncated`。
- 其余动作回显参数作为确认；`mock` 标记原样透传，mock 数据不得冒充真实桌面状态。

## 6. Mock 模式

`COMPUTER_RUNTIME_MODE=mock` 由**同一个二进制**处理（`src/mock.rs`），返回确定性数据（1280x720 渐变 PNG、两个固定窗口），并在每个结果里带 `mock: true`。用于 UI、Agent 流程、权限、错误与任务状态的开发测试；生产默认真实运行时。显式模式（`handle_request_with_mode`）不受环境变量影响。

## 7. 契约与验证要点

- **不通过 shell 绕行**：不使用 cmd/PowerShell 完成鼠标键盘输入；输入只走 `SendInput`，文本走 `KEYEVENTF_UNICODE`。
- **失败关闭**：非 Windows 且真实模式在启动前即 `RUNTIME_UNAVAILABLE`；未知方法/版本/按键名/坐标越界均类型化拒绝。
- **坐标**：虚拟屏绝对坐标（多显示器合并），`validate_point` 按当前虚拟屏边界校验；滚动量按 120 单位取整，不足一格拒绝。
- **滚动结果报实际位移（2026-10-18）**：`MOUSEEVENTF_WHEEL` 的 `mouseData` 只接受整格，此前运行时按 `delta / 120` 截断后仍把**请求值**写回结果——模型发 200 会读到 `delta_y: 200`，而桌面只滚了一格（120）；另一轴不足一格时还会被静默丢掉。现在 `wheel_notches` 统一换算，结果里的 `delta_x`/`delta_y` 是实际滚动量，与请求值不同时另带 `requested_delta_x`/`requested_delta_y`；任一轴非零但不足一格即 `INVALID_REQUEST`（错误里写清一格是 120），不再静默丢弃。mock 与真实路径同形。

## 8. 输入可靠性（实测）

在中文环境的记事本上实测：字符间隔 < 30ms 时接收方会确定性损坏输入（丢首字符、末字符重复；20ms 三轮复现同一损坏模式）；**30ms 与 50ms 各三轮全部干净**。因此 `computer.type` 的 `delay_ms` 缺省 30，可按应用调整（1–100）。这是可靠性参数而非性能参数。

## 9. 已运行证据与未覆盖项

已运行（2026-10-16，本机真实 Windows）：
- `cargo test` 18/18（协议、mock、错误词表、delay 校验、显式模式不回落 mock；V2 起新增授权闸门/截图目标/环境探测用例）。
- `apps/api` 单测：`computer-plugin`（25 项，含执行路由与授权语义）/ `computer-runtime-client` / `tool-loop` 定向全绿；`tsc --noEmit` 全绿。
- 真实运行时：截图（PNG 可解码，物理 1920x1080，与回复宽高一致）、窗口枚举（pid/进程名/矩形/焦点）、激活（focused=true）、真实点击 + 中文与英文输入 + 回车（剪贴板核对文本完整）、崩溃后重连、mock 标记、错误码路径。
- V2 Phase 2 真实验收 4/4：环境探测如实、八个输入方法未授权全部被拒（8/8）、不可用截图目标拒绝不回退、窗口截图不改前台。

未覆盖：多显示器实测、真实模型驱动的端到端 Computer Use 会话、Windows 安装包内的运行时打包、受控环境下「用户与 Agent 同时使用互不干扰」的归因测试（Phase 10）。

## 10. V2 增量（2026-10-16 起）

V1 的「默认前台执行」路径已被[V2 迁移审查](computer-plugin-v2-migration-audit.md)判定为需迁移，Phase 2 已落地：

**2026-10-18 已确认、正在实施的会话独占约束**：不同受管目录的 Run 共用同一物理桌面；仅按目录的资源 claim 不能防止它们交替切换窗口与输入。用户选择整个操控会话独占，而非只在单个输入动作期间互斥；第一次 COMPUTER_INPUT 准入后，同 Run 连续动作可以继续，其他 Run 输入需等待。独占只能在应用确认安全停止或执行结束后释放，UNKNOWN、过期 Worker 或租约超时保持隔离。必须覆盖暂停/取消/交接/完成/失败/恢复，不能让普通同 Run 文件动作被自己的桌面独占误挡；`computer_control_state` 仍是展示投影，不作为桌面执行权。具体持久化接线待最小实现核对，未据此声称已验收。

- 运行时启动即 **per-monitor DPI aware V2**（坐标空间一致性的前提，实测虚拟屏 1536x864 → 物理 1920x1080）；
- 新增 `computer.describe_environment`（DPI/显示器/Child Session/UIA 库/三模式可用性，API 侧 30s TTL 缓存）；
- `computer.screenshot` 增加 `target`（`user_desktop`/`window`/`agent_session`/`browser_page`），后两者不可用即类型化拒绝；
- **九个桌面输入方法必须带 `allow_foreground: true` 才执行**（`FOREGROUND_NOT_AUTHORIZED`）；该参数不在工具 schema 里，由适配器在 Gateway 派发时注入——派发前必有单动作批准或本次任务范围授权，模型无法自我授权；
- 错误词表 +3：`FOREGROUND_NOT_AUTHORIZED`、`ISOLATED_SESSION_UNAVAILABLE`、`CAPTURE_TARGET_UNAVAILABLE`；方法词表 +1：`computer.describe_environment`；
- **2026-10-18 追加 `computer.move`（`COMPUTER_MOVE`）**：只移动指针、不点击。加它的原因是滚动与拖拽都作用在指针当前位置上，而此前没有「把指针放到目标区域」的手段——`computer_scroll` 的描述要求「先移动鼠标到目标区域再滚动」，词表里却没有这个动作。移动同样改变用户桌面，因此计入前台输入（需授权、不进会话只读词表），`computer_params` 只接受 `x`、`y`；
- 执行路由（`src/computer/execution-router.ts`）：后台不可用时输入类动作的结论是「需要用户授权」，prepare 的审批文案写明「⚠️ 此操作需要接管你的电脑」。

V1 的 SendInput/SetForegroundWindow 实现保留为 foreground 路径的实现体，不再是无条件默认。
