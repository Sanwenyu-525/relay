# Computer Plugin V1 设计与实现

角色：Computer Plugin V1（Windows 桌面能力）的**设计与协议**主文档。
状态：V1 已实现并做过真实 Windows 取证；**默认前台执行路径已被 V2 审查判为需迁移**，见[V2 迁移审查](computer-plugin-v2-migration-audit.md)。
日期：2026-10-16（2026-10-19 复核证据与计数）。代码事实：`apps/computer-runtime/`（Rust 运行时）、`apps/api/src/computer/`（客户端与适配器）、`apps/api/src/workflow/tool-catalog.ts`（工具词表）、`apps/api/src/application/gateway-actions.ts`（能力与准入）、`apps/api/migrations/0092_computer_use.sql`。

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
- 协议错误（非法 JSON、版本不匹配、超大行、非法 UTF-8，以及回复 envelope/字段类型不合规）一律杀掉进程，不猜后续行形状。2026-10-21 起回复必须通过完整形状校验：JSON 对象、`version` 严格相等、非空字符串 `request_id`、布尔 `success`；成功分支要求纯对象 `result`，失败分支要求 `error.code`/`error.message` 为字符串且 `retryable` 为布尔；`"false"` 这类字符串布尔、`null`/数组、缺字段均按协议违规失败关闭。
- **进程归属（2026-10-21 修复）**：`error`/`exit`/`close` 与 stdout 回调都绑定其产生时的子进程；旧实例的迟到事件只能结算旧实例的在途请求，不得清空新实例、新缓冲、环境缓存或新 pending。
- **stdout 分帧（2026-10-21 修复）**：按字节缓冲到完整换行再解码，管道分块落在多字节字符内部不得产生替换字符；单行上限按 UTF-8 **字节**逐行检查，不能拿 UTF-16 码元数或整个 chunk（含多条合法行）冒充单行长度。

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

- **两个能力**：`COMPUTER_READ`（截图/窗口枚举，effect READ，`approvalPassthrough: true`）、`COMPUTER_INPUT`（其余九个，effect WRITE，`approvalPassthrough: false`、`resumable: false`）。
- **放行范围**：Gateway 的会话只读来源词表仍含 `COMPUTER_READ`，但 2026-11-01 起会话轮次的工具解析不再声明该工具（见 §11）：观察—操作—再观察属于 Run 的工具循环。`COMPUTER_INPUT` 只在 RUN（Task/Run 工具循环）出现。
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
- **坐标**：虚拟屏绝对坐标（多显示器合并），`validate_point` 按当前虚拟屏边界校验；滚动量按 120 向零取整，不足一格拒绝。
- **滚动结果报实际位移（2026-10-18）**：`MOUSEEVENTF_WHEEL` 的 `mouseData` 只接受整格，此前运行时按 `delta / 120` 截断后仍把**请求值**写回结果——模型发 200 会读到 `delta_y: 200`，而桌面只滚了一格（120）；另一轴不足一格时还会被静默丢掉。现在 `wheel_notches` 统一换算，结果里的 `delta_x`/`delta_y` 是实际滚动量，与请求值不同时另带 `requested_delta_x`/`requested_delta_y`；任一轴非零但不足一格即 `INVALID_REQUEST`（错误里写清一格是 120），不再静默丢弃。mock 与真实路径同形。

## 8. 输入可靠性（实测）

在中文环境的记事本上实测：字符间隔 < 30ms 时接收方会确定性损坏输入（丢首字符、末字符重复；20ms 三轮复现同一损坏模式）；**30ms 与 50ms 各三轮全部干净**。因此 `computer.type` 的 `delay_ms` 缺省 30，可按应用调整（1–100）。这是可靠性参数而非性能参数。

## 9. 已运行证据与未覆盖项

已运行（2026-10-16 起，本机真实 Windows）：
- `cargo test` 20/20（协议、mock、错误词表、delay 校验、显式模式不回落 mock、授权闸门、截图目标、环境探测）。
- `apps/api` 单测：`computer-plugin` 27/27、`computer-runtime-client` 22/22、`computer-action-labels` 1/1（合计 50/50）；`tsc --noEmit` exit 0。
- 2026-10-21 协议回复校验（DEV-0091）：`null`、数组、原始值、字符串 `"false"` 成功标记、缺失/非字符串 `request_id`、缺失/非对象 `result`、`null`/字段类型错误的 `error` 共 10 种畸形回复，全部按 `IPC_DISCONNECTED` + `effectUncertain=true` 失败关闭并杀掉进程；未知 `request_id` 的合法回复仍静默丢弃，不影响当前请求。
- 2026-10-21 迟到进程事件（DEV-0090）：单测覆盖「旧进程 exit → 新进程 spawn 并写入请求 → 旧进程迟到 `close`/`error`」顺序，新进程不被清空、新请求正常结算且仍受管；复现探针见台账 DEV-0090 证据（受控假进程，未向真实桌面注入故障）。
- 2026-10-21 stdout 分帧修复（DEV-0088）：`output/computer-protocol-probe.mjs` 修前复现「`测试窗口` → `���试窗口`」与 256 字节在 200 字节上限下仍成功；修后中文逐字还原，超限按 `IPC_DISCONNECTED` 失败关闭（已写入请求保持 `effectUncertain=true`）。单测覆盖中文/emoji 每个字节切分、恰好等于上限、跨块多行、非法 UTF-8；`computer-control` 真实临时 PG 集成 10 通过 / 1 按设计跳过，`node scripts/check-docs.mjs` 通过。
- 真实运行时：截图（PNG 可解码，与回复宽高一致；2026-10-16 V1 记录 1536x864，2026-10-18 V2 只读探针 1920x1080）、窗口枚举（pid/进程名/矩形/焦点）、激活（focused=true）、真实点击 + 中文与英文输入 + 回车（记事本未保存标记与 49 码点确认输入到达；**CTRL+A/CTRL+C 剪贴板核对未通过**，该轮 11/12）、崩溃后重连、mock 标记、错误码路径。
- 2026-10-19 从当前源码重建 release（`cargo build --release` exit 0）后只读复验：`computer.describe_environment`（PER_MONITOR_AWARE_V2、2560x1440、foreground=`requires_user_authorization`、UIA provider 未实现）、`computer.get_windows`（8 个窗口）、`computer.screenshot`（2560x1440、56817 字节）均 exit 0；本轮未执行桌面输入（见下方未覆盖项）。
- 2026-10-19 崩溃恢复演示（真实模式只读，不触碰桌面）：首次 `computer.get_windows` 返回 8 个真实窗口后外部 kill 运行时进程，下一次请求透明重建并继续返回 8 个窗口（`reconnected=true`）；在途请求的「效果未知」语义由 `computer-runtime-client` 单测 3/5 覆盖。
- 2026-10-18 真实 Windows 输入（Gateway 范围授权路径）：`computer-control` 集成 4/4；`RELAY_TEST_COMPUTER_WINDOW_ID` 指向协调者自有的空白记事本，`COMPUTER_ACTIVATE_WINDOW` 与 `COMPUTER_TYPE` 经 `run_scope_grants` 派发均 SUCCEEDED（`output/acceptance-raw/computer-browser-github-fix-20261018/coordinator/computer-control-real.log`）。2026-10-19 同套件未设该变量时该项按设计 skip（10 通过 / 1 跳过）。
- V2 Phase 2 真实验收 4/4：环境探测如实、八个输入方法未授权全部被拒（8/8，当时 `computer.move` 尚未加入）、不可用截图目标拒绝不回退、窗口截图不改前台。`computer.move` 加入后由 `cargo test` 的九方法授权闸门用例覆盖，真机 9/9 未复验。

未覆盖：多显示器实测、真实模型驱动的端到端 Computer Use 会话、Windows 安装包内的运行时打包、受控环境下「用户与 Agent 同时使用互不干扰」的归因测试（Phase 10）；2026-10-19 本轮未复验真实键鼠输入与窗口激活（当前桌面在用，避免干扰用户）。

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

## 11. 会话到执行链修复（2026-11-01 COMPUTER-PLUGIN-E2E）

真实账本复现：绑定目录的普通 Agent 会话里发送 `@电脑操控 打开记事本`，助手回复整段是
模型的工具分析（「让我看看本轮可用的工具」），`conversation_execution_requests` 一行也
没有。根因不是单一解析失败，而是四个事实缺口叠加：

1. **能力事实块漏报插件**：机器插件两行只在「会话没有工作目录」时输出；绑定目录的
   普通会话只看到文件工具，模型没有「执行阶段可用电脑操控」这一条事实。
2. **`@电脑操控` 只是展示**：输入器芯片不进入服务端语义，服务端无法把用户明确选择的
   插件作为一条事实交给模型。
3. **会话轮次错误地暴露机器读取工具**：启用电脑插件后，`resolveSessionReadTools` 把
   `COMPUTER_READ` 也放进会话词表；真实模型因此在聊天轮次调用 `computer_get_windows`，
   拿到 `RESOURCE_NOT_FOUND` 后放弃执行候选。观察—操作—再观察属于 Run 的工具循环，
   会话轮次只负责把明确操作整理成候选。
4. **没有协议恢复**：模型输出纯文本时 `readMainLoopOutcome` 按普通回复结算，内部分析
   被当作用户可见回答，且没有执行请求。

修复（全部沿用原 Owner，不新建第二套状态或通道）：

- `assist-capability-notice` 始终报告机器插件事实；已绑定目录的会话只认本项目连接，
  「别的项目有登记」如实说成本项目不可用，不承诺跨项目执行。
- `plugin-mentions` 在服务端识别 `@电脑操控`/`@浏览器操控`，作为「本条消息的插件选择」
  事实拼进 system；它**不是授权**，候选仍走原确定性校验、连接准入与 Gateway 审批。
  同一事实明确区分命令式请求与能力询问；能力询问由服务端保守降级为 CLARIFY，不启动
  桌面操作。
- `resolveSessionReadTools` 不再把 `COMPUTER_READ`/`BROWSER_READ` 放进会话词表。
- 主流程纯文本回复触发一次**无工具信封修复**（`responseFormat=json_object`）：只在
  CHAT、没有有副作用的工具调用，且满足以下之一时发生：
  1. 用户显式选择了 `@电脑操控` / `@浏览器操控`；
  2. 工作区登记了可用的机器插件，且消息包含明确的机器操作意图（动作词 + 桌面/浏览器
     对象，或截图/点击/拖拽等只可能发生在机器上的动作；能力询问与讨论措辞不算）。

  2026-11-10 收紧理由：旧条件只看「工作区登记了机器插件」，插件工作区里的任何纯文本
  回复（包括「你好」）都会重发整份 system；实测一条问候因此多花 3,708 输入 token
  和 6 秒。环境能力不是用户意图。判定在 `plugin-mentions.ts` 的
  `detectMachineActionIntent`，只用于决定是否多跑一次修复，不产生授权。自然语言里
  未被规则命中的机器请求不会修复，按普通回复结算——这是保守判定的已知边界。
  修复结果仍走 `readMainLoopOutcome` 与既有候选校验。修复失败时，明确插件请求显示
  「没有登记执行请求、没有执行任何操作」，不把分析正文当成功结算。
- Run 的工具循环新增 `DRAFT_OPERATION_TOOLS` 路由：工具清单含 COMPUTER_INPUT/
  BROWSER_ACTION/BROWSER_COMMIT 时，提示词声明这些工具会真实改变本机状态，要求
  「先观察、再操作、操作后再观察」，等待人工批准时不重复提交；候选正文必须逐项写出
  实际回执与核对结果。
- 聊天界面只呈现服务端事实：操作类候选显示「操作范围：电脑桌面/浏览器」，不再写
  「当前目录」；执行轨迹摘要增加 Run 状态行（等待批准/执行中/验证中/已结束/失败/
  已取消），`COMPLETED` 明确「不代表任务验收完成」；失败原因提到阶段行下方，
  小窗口首屏可见。

安全边界不变：`COMPUTER_READ` 与 `COMPUTER_INPUT` 仍分离；输入类动作仍逐次人工
批准或由本次任务范围授权覆盖；UNKNOWN 不盲重试；桌面独占与 Worker fencing 不变。

