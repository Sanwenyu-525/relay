/**
 * Computer Runtime 线协议（relay-computer-v1）的 API 侧镜像。
 *
 * 协议事实由 `apps/computer-runtime/src/protocol.rs` 唯一维护；本文件只做同一份
 * 冻结词表的 TypeScript 投影，供客户端、Gateway 派发与测试共用。任何一侧新增
 * 方法或错误码都必须先改 Rust 侧，再同步这里——不允许两侧各留一份可漂移的清单。
 */

/** 冻结的协议版本标签；不匹配的运行时一律拒绝，不静默降级。 */
export const COMPUTER_PROTOCOL_VERSION = 'relay-computer-v1';

/** V1 冻结的十个方法名 + V2 的环境探测（与 Rust `protocol::METHODS` 逐字一致）。 */
export const COMPUTER_METHODS = [
  'computer.screenshot',
  'computer.get_windows',
  'computer.activate_window',
  'computer.click',
  'computer.double_click',
  'computer.scroll',
  'computer.drag',
  'computer.type',
  'computer.keypress',
  'computer.hotkey',
  'computer.describe_environment',
] as const;

export type ComputerMethod = (typeof COMPUTER_METHODS)[number];

/** 冻结的错误码词表（与 Rust `protocol::codes` 逐字一致）。 */
export const COMPUTER_ERROR_CODES = [
  'INVALID_REQUEST',
  'RUNTIME_UNAVAILABLE',
  'SCREENSHOT_FAILED',
  'WINDOW_NOT_FOUND',
  'WINDOW_ACTIVATION_FAILED',
  'INVALID_COORDINATE',
  'INPUT_FAILED',
  'PERMISSION_DENIED',
  'USER_CANCELLED',
  'TIMEOUT',
  'FOREGROUND_NOT_AUTHORIZED',
  'ISOLATED_SESSION_UNAVAILABLE',
  'CAPTURE_TARGET_UNAVAILABLE',
  'UNKNOWN',
] as const;

/**
 * V2：在用户当前桌面产生输入的八个动作。
 *
 * 它们的执行**必须**由 Gateway 的显式授权（单动作 Review 批准 = 仅此一次，
 * 或本次任务范围授权 = 本任务内允许）驱动；适配器在派发时注入 `allow_foreground`，
 * 模型参数里不存在这一项，模型无法自我授权。
 */
export const COMPUTER_FOREGROUND_INPUT_ACTIONS: readonly string[] = [
  'COMPUTER_ACTIVATE_WINDOW', 'COMPUTER_CLICK', 'COMPUTER_DOUBLE_CLICK', 'COMPUTER_SCROLL',
  'COMPUTER_DRAG', 'COMPUTER_TYPE', 'COMPUTER_KEYPRESS', 'COMPUTER_HOTKEY',
];

export function isForegroundInputAction(actionType: string): boolean {
  return COMPUTER_FOREGROUND_INPUT_ACTIONS.includes(actionType);
}

/** V2 §12/§31：截图目标。默认只应是 Agent 自己的工作区；用户桌面需要显式指定。 */
export type CaptureTarget = 'user_desktop' | 'window' | 'agent_session' | 'browser_page';

/** V2 §20：坐标空间。禁止混淆——动作必须声明它的坐标属于哪一层。 */
export type CoordinateSpace = 'user_desktop' | 'window' | 'agent_session' | 'browser_viewport';

/** V2 §5：执行模式。默认 background；foreground 必须用户授权。 */
export type ComputerExecutionMode = 'background' | 'isolated' | 'foreground';

/** V2 §22：一次连续 Computer 操作的上下文。 */
export interface ComputerContext {
  readonly context_id: string;
  readonly mode: ComputerExecutionMode;
  readonly session_id: string | null;
  readonly window_id: string | null;
  readonly application: string | null;
  readonly coordinate_space: CoordinateSpace;
  readonly created_at: string;
  readonly last_observed_at: string;
}

/** 运行时环境探测结果（`computer.describe_environment`）。 */
export interface ComputerEnvironment {
  readonly platform: string;
  readonly dpi_awareness: string;
  readonly virtual_screen: { readonly x: number; readonly y: number;
    readonly width: number; readonly height: number } | null;
  readonly monitors: readonly { readonly x: number; readonly y: number;
    readonly width: number; readonly height: number; readonly primary: boolean }[] | null;
  readonly child_session: { readonly enabled: boolean; readonly enabled_query_ok: boolean;
    readonly available: boolean; readonly session_id: number | null };
  readonly ui_automation: { readonly client_library_loadable: boolean;
    readonly provider_implemented: boolean; readonly already_loaded: boolean };
  readonly mode_availability: {
    readonly background: { readonly status: string; readonly browser_cdp: string;
      readonly ui_automation: string };
    readonly isolated: { readonly status: string; readonly reason: unknown };
    readonly foreground: { readonly status: string };
  };
  readonly mock?: boolean;
}

export type ComputerErrorCode = (typeof COMPUTER_ERROR_CODES)[number];

export function isComputerMethod(value: string): value is ComputerMethod {
  return (COMPUTER_METHODS as readonly string[]).includes(value);
}

export function isComputerErrorCode(value: string): value is ComputerErrorCode {
  return (COMPUTER_ERROR_CODES as readonly string[]).includes(value);
}

export interface ComputerRequest {
  readonly version: string;
  readonly request_id: string;
  readonly method: ComputerMethod;
  readonly params: Record<string, unknown>;
}

export interface ComputerErrorBody {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface ComputerReply {
  readonly version: string;
  readonly request_id: string;
  readonly success: boolean;
  readonly result?: Record<string, unknown>;
  readonly error?: ComputerErrorBody;
}

/** 截图回复的稳定形状（Rust `computer.screenshot` 的 result）。 */
export interface ComputerScreenshotResult {
  readonly type: 'computer_screenshot';
  readonly image: string;
  readonly width: number;
  readonly height: number;
  readonly origin_x: number;
  readonly origin_y: number;
  readonly timestamp: number;
  readonly mock?: boolean;
}

/** 窗口条目（Rust `window::WindowInfo` 的 JSON 投影）。 */
export interface ComputerWindowInfo {
  readonly id: string;
  readonly title: string;
  readonly process_name: string | null;
  readonly process_id: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly visible: boolean;
  readonly focused: boolean;
}

export interface ComputerWindowsResult {
  readonly windows: readonly ComputerWindowInfo[];
  readonly mock?: boolean;
}

/**
 * 桌面级合成目标。
 *
 * Computer 动作没有受管根：它的"目标"是整台电脑，因此 Gateway 的 normalized_target
 * 用这个固定值。Permission 的 target_prefix 对它按全等匹配（见 gateway-actions 的
 * targetMatches），不复用文件路径前缀语义。
 */
export const COMPUTER_DESKTOP_TARGET = 'computer://desktop';
