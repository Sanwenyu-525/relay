/**
 * Computer 能力的 Gateway 派发执行（docs/architecture/computer-plugin-v1.md §派发）。
 *
 * 职责边界与其它适配器一致：把 Operation 冻结的参数翻译成一次运行时请求，
 * 把运行时回复翻译成 Gateway 的 outcome/result。这里不判定权限（准入在
 * prepare/admit），不修改 Task/Run 状态。
 *
 * 截图生命周期：运行时回复里的 base64 图片**不进入本函数的返回值**——
 * 只保留可核对的摘要（尺寸、时戳、字节数、sha256）。截图是高敏感数据，
 * 账本与日志默认不留存图片正文；把图片喂给模型的多模态通路是 V2 范围。
 */

import { createHash } from 'node:crypto';

import type { JsonObject } from '../infrastructure/json.js';
import {
  COMPUTER_PROTOCOL_VERSION,
  isForegroundInputAction,
  type ComputerEnvironment,
  type ComputerMethod,
  type ComputerScreenshotResult,
  type ComputerWindowInfo,
} from './protocol.js';
import { ComputerRuntimeError } from './runtime-client.js';
import { getComputerRuntimeClient } from './client-holder.js';
import { isBlocked, planComputerAction, type RouterPlan } from './execution-router.js';

/** Gateway 逻辑动作 → 运行时方法。 */
const ACTION_TO_METHOD: Readonly<Record<string, ComputerMethod>> = {
  COMPUTER_SCREENSHOT: 'computer.screenshot',
  COMPUTER_GET_WINDOWS: 'computer.get_windows',
  COMPUTER_ACTIVATE_WINDOW: 'computer.activate_window',
  COMPUTER_CLICK: 'computer.click',
  COMPUTER_DOUBLE_CLICK: 'computer.double_click',
  COMPUTER_SCROLL: 'computer.scroll',
  COMPUTER_DRAG: 'computer.drag',
  COMPUTER_TYPE: 'computer.type',
  COMPUTER_KEYPRESS: 'computer.keypress',
  COMPUTER_HOTKEY: 'computer.hotkey',
};

/** 窗口列表上限：超出时显式截断，不把整台电脑的窗口塞进上下文。 */
export const MAX_WINDOWS_IN_RESULT = 64;

export type ComputerExecuteOutcome = 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';

export interface ComputerExecuteResult {
  readonly outcome: ComputerExecuteOutcome;
  readonly result: JsonObject;
}

/**
 * 从 Operation 参数构造运行时请求参数。
 *
 * 逐字段白名单转发：模型多带的字段不会变成运行时参数（与 tool-loop 的
 * gatewayParamsFor 同一纪律）。这里的校验是纵深防御——工具循环落库前已按
 * schema 校验过，Gateway 不因此信任调用方。
 */
export function computerParamsForAction(actionType: string,
  params: JsonObject): Record<string, unknown> {
  switch (actionType) {
    case 'COMPUTER_SCREENSHOT': {
      // V2 §12：目标显式。缺省 user_desktop（独立工作区尚未落地），非法目标在词表决。
      const request: Record<string, unknown> = {};
      const target = optionalString(params, 'target');
      if (target !== undefined) {
        if (!['user_desktop', 'window', 'agent_session', 'browser_page'].includes(target)) {
          throw new ComputerRuntimeError('INVALID_REQUEST',
            `unknown capture target ${JSON.stringify(target)}`, false);
        }
        request.target = target;
      }
      const windowId = optionalString(params, 'window_id');
      if (windowId !== undefined) request.window_id = windowId;
      return request;
    }
    case 'COMPUTER_GET_WINDOWS':
      return {};
    case 'COMPUTER_ACTIVATE_WINDOW':
      return { window_id: requireString(params, 'window_id') };
    case 'COMPUTER_CLICK': {
      const request: Record<string, unknown> = {
        x: requireInteger(params, 'x'),
        y: requireInteger(params, 'y'),
      };
      const button = optionalString(params, 'button');
      if (button !== undefined) {
        if (button !== 'left' && button !== 'right' && button !== 'middle') {
          throw new ComputerRuntimeError('INVALID_REQUEST',
            `unsupported button ${JSON.stringify(button)}; expected left/right/middle`, false);
        }
        request.button = button;
      }
      return request;
    }
    case 'COMPUTER_DOUBLE_CLICK':
      return { x: requireInteger(params, 'x'), y: requireInteger(params, 'y') };
    case 'COMPUTER_SCROLL': {
      const request: Record<string, unknown> = {};
      const dx = optionalInteger(params, 'delta_x');
      const dy = optionalInteger(params, 'delta_y');
      if (dx !== undefined) request.delta_x = dx;
      if (dy !== undefined) request.delta_y = dy;
      return request;
    }
    case 'COMPUTER_DRAG': {
      const start = requirePoint(params, 'start');
      const end = requirePoint(params, 'end');
      const duration = optionalInteger(params, 'duration_ms');
      return { start, end, ...(duration === undefined ? {} : { duration_ms: duration }) };
    }
    case 'COMPUTER_TYPE': {
      const text = requireString(params, 'text');
      if (Buffer.byteLength(text, 'utf8') > 64 * 1024) {
        throw new ComputerRuntimeError('INVALID_REQUEST',
          'computer.type 单次输入超过 64 KiB，请分批', false);
      }
      const delay = optionalInteger(params, 'delay_ms');
      if (delay !== undefined && (delay < 1 || delay > 100)) {
        throw new ComputerRuntimeError('INVALID_REQUEST',
          'delay_ms 必须是 1 到 100 的整数', false);
      }
      return { text, ...(delay === undefined ? {} : { delay_ms: delay }) };
    }
    case 'COMPUTER_KEYPRESS':
      return { key: requireString(params, 'key') };
    case 'COMPUTER_HOTKEY': {
      const keys = params.keys;
      if (!Array.isArray(keys) || keys.length === 0 ||
          !keys.every((key) => typeof key === 'string')) {
        throw new ComputerRuntimeError('INVALID_REQUEST',
          'computer.hotkey 需要非空字符串数组 keys', false);
      }
      return { keys: [...keys] };
    }
    default:
      throw new ComputerRuntimeError('INVALID_REQUEST',
        `unknown computer action ${actionType}`, false);
  }
}

/** 执行一次 Computer 动作；所有失败都以 FAILED/UNKNOWN + 类型化 reason 返回，不抛出。 */
export async function computerExecute(input: {
  readonly actionType: string;
  readonly params: JsonObject;
  readonly signal?: AbortSignal;
  /**
   * 是否已获得「在用户桌面产生输入」的显式授权。
   *
   * 只有 Gateway 能给出 true：dispatch 只会发生在单动作 Review 已批准、
   * 或本次任务范围授权覆盖之后。模型参数无法影响它。
   */
  readonly foregroundAuthorized?: boolean;
}): Promise<ComputerExecuteResult> {
  const method = ACTION_TO_METHOD[input.actionType];
  if (method === undefined) {
    return { outcome: 'FAILED', result: { reason: 'COMPUTER_ACTION_UNKNOWN',
      error: `未知的 Computer 动作 ${input.actionType}` } };
  }
  const client = getComputerRuntimeClient();
  // V2 执行路由：工具不自己决定走哪条路径。探测失败按「后台不可用」处理。
  const environment = await safeEnvironment(client);
  const plan = planComputerAction({ actionType: input.actionType,
    environment,
    foregroundAuthorized: input.foregroundAuthorized === true &&
      isForegroundInputAction(input.actionType),
    captureTarget: typeof input.params.target === 'string' ? input.params.target : undefined,
    coordinateSpace: typeof input.params.coordinate_space === 'string'
      ? input.params.coordinate_space as never : undefined });
  if (isBlocked(plan)) {
    return { outcome: 'FAILED', result: { reason: plan.refusal!.code,
      error: plan.refusal!.message, retryable: false,
      requires_user_action: plan.refusal!.requiresUserAction, mode: plan.mode } };
  }
  if (isForegroundInputAction(input.actionType) && input.foregroundAuthorized !== true) {
    // 防御性分支：正常流程不会走到（dispatch 前必须已授权）。
    return { outcome: 'FAILED', result: { reason: 'FOREGROUND_REQUIRES_AUTHORIZATION',
      error: plan.explanation, retryable: false, requires_user_action: true,
      mode: plan.mode } };
  }
  let request: Record<string, unknown>;
  try {
    request = computerParamsForAction(input.actionType, input.params);
  } catch (error) {
    return { outcome: 'FAILED', result: { reason: 'INVALID_REQUEST',
      error: error instanceof Error ? error.message : String(error) } };
  }
  if (isForegroundInputAction(input.actionType)) {
    // 运行时侧硬闸门：没有这一项它会拒绝执行，避免任何误接线静默抢桌面。
    request.allow_foreground = true;
  }
  try {
    const reply = await client.request(method, request,
      input.signal === undefined ? {} : { signal: input.signal });
    return { outcome: 'SUCCEEDED', result: projectComputerResult(input.actionType, reply) };
  } catch (error) {
    if (error instanceof ComputerRuntimeError) {
      // 效果未知（已写入、回复丢失、超时中、取消中）按 UNKNOWN 结算：
      // 契约 02 要求先核对，不把可能已发生的桌面输入算成失败。
      if (error.effectUncertain) {
        return { outcome: 'UNKNOWN', result: { reason: 'COMPUTER_EFFECT_UNCERTAIN',
          error: error.message, retryable: error.retryable } };
      }
      return { outcome: 'FAILED', result: { reason: error.code, error: error.message,
        retryable: error.retryable } };
    }
    return { outcome: 'FAILED', result: { reason: 'UNKNOWN',
      error: error instanceof Error ? error.message : String(error), retryable: false } };
  }
}

async function safeEnvironment(
  client: ReturnType<typeof getComputerRuntimeClient>,
): Promise<ComputerEnvironment | null> {
  try {
    return await client.describeEnvironment();
  } catch {
    // 探测不到环境不构成「有后台路径」：路由会按最保守假设处理。
    return null;
  }
}

/**
 * prepare 阶段的路由结论（V2 §18/§30）。
 *
 * prepare 时还没有授权，因此输入类动作会得到 `FOREGROUND_REQUIRES_AUTHORIZATION`——
 * 这不是错误，而是「需要用户确认接管」的信号，上游据此写出可读的审批文案，
 * 让用户看到的是「要不要接管电脑」而不是一句抽象的「需要批准」。
 * 探测失败返回 null，调用方退回通用文案。
 */
export async function planComputerActionForPrepare(actionType: string,
  params: JsonObject): Promise<RouterPlan | null> {
  try {
    const environment = await getComputerRuntimeClient().describeEnvironment();
    return planComputerAction({ actionType, environment, foregroundAuthorized: false,
      captureTarget: typeof params.target === 'string' ? params.target : undefined,
      coordinateSpace: typeof params.coordinate_space === 'string'
        ? params.coordinate_space as never : undefined });
  } catch {
    return null;
  }
}

/**
 * 运行时回复 → 有界的 Gateway 结果。
 *
 * 截图只保留摘要（图片正文不落账本）；窗口列表有界；其余动作回显参数作为确认。
 * 所有分支都带 `mock` 标记的透传——mock 数据不得在账本里冒充真实电脑状态。
 */
export function projectComputerResult(actionType: string,
  reply: Record<string, unknown>): JsonObject {
  if (actionType === 'COMPUTER_SCREENSHOT') {
    const shot = reply as unknown as ComputerScreenshotResult;
    const image = typeof shot.image === 'string' ? shot.image : '';
    const padding = image.endsWith('==') ? 2 : image.endsWith('=') ? 1 : 0;
    const bytes = image === '' ? 0 : Math.floor((image.length - padding) * 3 / 4);
    return {
      type: 'computer_screenshot',
      target: typeof (reply as Record<string, unknown>).target === 'string'
        ? (reply as Record<string, unknown>).target as string : 'user_desktop',
      width: shot.width,
      height: shot.height,
      origin_x: shot.origin_x,
      origin_y: shot.origin_y,
      timestamp: shot.timestamp,
      image_bytes: bytes,
      image_sha256: image === '' ? null : createHash('sha256').update(image, 'utf8').digest('hex'),
      ...(shot.mock === true ? { mock: true } : {}),
      note: '截图正文不进入账本；V1 仅保留可核对摘要',
    };
  }
  if (actionType === 'COMPUTER_GET_WINDOWS') {
    const windows = Array.isArray(reply.windows) ? reply.windows as ComputerWindowInfo[] : [];
    const kept = windows.slice(0, MAX_WINDOWS_IN_RESULT);
    return {
      windows: kept as unknown as JsonObject[],
      count: windows.length,
      ...(windows.length > kept.length ? { truncated: true } : {}),
      ...(reply.mock === true ? { mock: true } : {}),
    };
  }
  return { ...reply } as JsonObject;
}

function requireString(params: JsonObject, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || value === '') {
    throw new ComputerRuntimeError('INVALID_REQUEST', `${key} 必须是非空字符串`, false);
  }
  return value;
}

function optionalString(params: JsonObject, key: string): string | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new ComputerRuntimeError('INVALID_REQUEST', `${key} 必须是字符串`, false);
  }
  return value;
}

function requireInteger(params: JsonObject, key: string): number {
  const value = params[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ComputerRuntimeError('INVALID_REQUEST', `${key} 必须是整数`, false);
  }
  return value;
}

function optionalInteger(params: JsonObject, key: string): number | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ComputerRuntimeError('INVALID_REQUEST', `${key} 必须是整数`, false);
  }
  return value;
}

function requirePoint(params: JsonObject, key: string): Record<string, number> {
  const value = params[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ComputerRuntimeError('INVALID_REQUEST', `${key} 必须是 {x,y} 对象`, false);
  }
  const point = value as Record<string, unknown>;
  const x = point.x;
  const y = point.y;
  if (typeof x !== 'number' || !Number.isInteger(x) ||
      typeof y !== 'number' || !Number.isInteger(y)) {
    throw new ComputerRuntimeError('INVALID_REQUEST', `${key}.x 与 ${key}.y 必须是整数`, false);
  }
  return { x, y };
}

/** 协议版本再导出：测试与日志需要同一份常量。 */
export { COMPUTER_PROTOCOL_VERSION };
