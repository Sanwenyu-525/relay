/**
 * 浏览器能力的 Gateway 派发执行（F26）。
 *
 * 与 `computer/computer-adapter.ts` 同一纪律：这里只做三件事——把 Operation 冻结的
 * 参数翻译成一次受管的页面操作、把结果投影成有界的 Gateway 结果、把失败翻译成
 * 类型化原因。**不判定权限**（准入在 prepare/admit），**不修改 Task/Run 状态**。
 *
 * 参数纪律：逐字段白名单转发。模型多带的字段不会变成上游参数；`page_id` 由这里
 * 解析成受管页 id，解析不通过就不执行。
 */

import { isAbsolute, relative, resolve } from 'node:path';

import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import type { GatewayOrigin } from '../application/gateway-actions.js';
import { getBrowserSessionManager, peekBrowserSessionManager } from './client-holder.js';
import { BrowserBackendError } from './mcp-client.js';
import {
  BROWSER_UNKNOWN_TARGET, browserCapabilityFor, browserTargetForOrigin, isAllowedNavigationUrl,
  isBrowserAction, isBrowserReadAction, originOfUrl,
} from './protocol.js';
import type { BrowserOwner } from './session-manager.js';
import { MAX_PAGES, type BrowserHealth, type BrowserSnapshot } from './provider.js';
import { reportBrowserHealth } from './state.js';

export type BrowserExecuteOutcome = 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';

export interface BrowserExecuteResult {
  readonly outcome: BrowserExecuteOutcome;
  readonly result: JsonObject;
}


/** 单次填写上限：与 apply_changeset 的 64 KiB 同一档。 */
const MAX_FILL_BYTES = 64 * 1024;

export function browserOwnerFor(origin: GatewayOrigin): BrowserOwner {
  if (origin.kind === 'RUN') return { kind: 'RUN', id: origin.runId };
  if (origin.kind === 'ASSISTANT_READ' || origin.kind === 'AGENT_SESSION_READ') {
    return { kind: 'SESSION', id: origin.sessionId };
  }
  // 其他来源在 originAllows 阶段已被拒绝；这里再挡一次，避免未来放宽时静默放行。
  throw new BrowserBackendError('BROWSER_INVALID_REQUEST',
    `浏览器动作不接受 ${origin.kind} 来源。`);
}

/**
 * prepare 阶段的目标：`browser://<origin>`。
 *
 * origin 只来自两处可核对的事实——本次导航的目标 URL，或该页最近一次已知的 origin；
 * **不接受模型自报的站点**。两处都拿不到时退到 `browser://unknown`。
 */
export function browserTargetForTool(origin: GatewayOrigin, params: JsonObject): string {
  let owner: BrowserOwner;
  try {
    owner = browserOwnerFor(origin);
  } catch {
    return BROWSER_UNKNOWN_TARGET;
  }
  const url = typeof params.url === 'string' ? params.url : undefined;
  if (url !== undefined) {
    const fromUrl = originOfUrl(url);
    if (fromUrl !== null) return browserTargetForOrigin(fromUrl);
  }
  const manager = peekBrowserSessionManager();
  if (manager === null) return BROWSER_UNKNOWN_TARGET;
  const pageIdInput = typeof params.page_id === 'string' ? params.page_id : undefined;
  const recorded = manager.peekOrigin(owner, pageIdInput);
  return browserTargetForOrigin(recorded);
}

/**
 * 逐字段白名单 + 形状校验。
 *
 * 校验失败抛 `BROWSER_INVALID_REQUEST`：这是「模型给错了参数」，不是「浏览器坏了」，
 * 上游错误码与它分开，便于 UI 与模型分辨该重试还是该改参数。
 */
export function browserParamsForAction(actionType: string, params: JsonObject): JsonObject {
  if (!isBrowserAction(actionType)) {
    throw new BrowserBackendError('BROWSER_INVALID_REQUEST',
      `未知的浏览器动作 ${actionType}`);
  }
  const result: Record<string, unknown> = {};
  const pageId = optionalString(params, 'page_id');
  if (pageId !== undefined) result.page_id = pageId;
  switch (actionType) {
    case 'BROWSER_LIST_PAGES':
    case 'BROWSER_SCREENSHOT':
    case 'BROWSER_NEW_PAGE': {
      const url = optionalString(params, 'url');
      if (url !== undefined) {
        if (!isAllowedNavigationUrl(url)) {
          throw new BrowserBackendError('BROWSER_NAVIGATION_BLOCKED',
            '只允许 http/https 地址；本地文件与脚本协议不通过浏览器工具打开。');
        }
        result.url = url;
      }
      return result as JsonObject;
    }
    case 'BROWSER_READ_PAGE':
      return result as JsonObject;
    case 'BROWSER_WAIT_FOR': {
      result.text = requireString(params, 'text', 4096);
      const timeout = optionalInteger(params, 'timeout_ms');
      if (timeout !== undefined) {
        if (timeout < 100 || timeout > 60_000) {
          throw new BrowserBackendError('BROWSER_INVALID_REQUEST',
            'timeout_ms 必须在 100 到 60000 之间。');
        }
        result.timeout_ms = timeout;
      }
      return result as JsonObject;
    }
    case 'BROWSER_NAVIGATE': {
      const url = optionalString(params, 'url');
      const history = optionalString(params, 'history');
      if (url === undefined && history === undefined) {
        throw new BrowserBackendError('BROWSER_INVALID_REQUEST',
          'browser_navigate 需要 url 或 history 之一。');
      }
      if (url !== undefined && history !== undefined) {
        throw new BrowserBackendError('BROWSER_INVALID_REQUEST',
          'browser_navigate 的 url 与 history 只能二选一。');
      }
      if (url !== undefined) {
        if (!isAllowedNavigationUrl(url)) {
          throw new BrowserBackendError('BROWSER_NAVIGATION_BLOCKED',
            '只允许 http/https 地址；本地文件与脚本协议不通过浏览器工具打开。');
        }
        result.url = url;
      }
      if (history !== undefined) {
        if (history !== 'back' && history !== 'forward' && history !== 'reload') {
          throw new BrowserBackendError('BROWSER_INVALID_REQUEST',
            `history 只能是 back/forward/reload（收到 ${JSON.stringify(history)}）。`);
        }
        result.history = history;
      }
      return result as JsonObject;
    }
    case 'BROWSER_CLICK':
    case 'BROWSER_SUBMIT_FORM': {
      result.uid = requireString(params, 'uid', 256);
      if (actionType === 'BROWSER_CLICK' && params.double !== undefined) {
        result.double = params.double === true;
      }
      return result as JsonObject;
    }
    case 'BROWSER_FILL': {
      result.uid = requireString(params, 'uid', 256);
      result.text = requireString(params, 'text', MAX_FILL_BYTES);
      return result as JsonObject;
    }
    case 'BROWSER_PRESS_KEY':
      result.key = requireString(params, 'key', 128);
      return result as JsonObject;
    case 'BROWSER_CLOSE_PAGE':
      if (pageId === undefined || pageId === '') {
        throw new BrowserBackendError('BROWSER_INVALID_REQUEST',
          'browser_close_page 必须显式给出 page_id。');
      }
      return result as JsonObject;
    case 'BROWSER_UPLOAD_FILE': {
      result.uid = requireString(params, 'uid', 256);
      result.relative_path = requireString(params, 'relative_path', 1024);
      return result as JsonObject;
    }
    default:
      throw new BrowserBackendError('BROWSER_INVALID_REQUEST',
        `未知的浏览器动作 ${actionType}`);
  }
}

/** 是否会产生外部效果（决定取消/未知时是否按 UNKNOWN 结算）。 */
export function isBrowserMutatingAction(actionType: string): boolean {
  return !isBrowserReadAction(actionType);
}

/**
 * 执行一次浏览器动作。
 *
 * 失败一律以 FAILED/UNKNOWN + 类型化 reason 返回，不抛异常——与 computer 适配器一致，
 * 让工具循环把原因原样交回模型，而不是变成一次 Worker 崩溃。
 */
export async function browserExecute(input: {
  /** 用于写 0106 的健康投影：UI 读的那一行必须由真正执行动作的进程写入。 */
  readonly db: DbExecutor;
  readonly actionType: string;
  readonly params: JsonObject;
  readonly origin: GatewayOrigin;
  /** 上传文件时用于把相对路径解析到受管根；其他动作不使用。 */
  readonly canonicalRoot?: string | null;
  readonly signal?: AbortSignal;
}): Promise<BrowserExecuteResult> {
  if (!isBrowserAction(input.actionType)) {
    return failed('BROWSER_INVALID_REQUEST', `未知的浏览器动作 ${input.actionType}`);
  }
  let params: JsonObject;
  try {
    params = browserParamsForAction(input.actionType, input.params);
  } catch (error) {
    return failureFrom(error);
  }
  const owner = browserOwnerFor(input.origin);
  const manager = getBrowserSessionManager();
  const mutating = isBrowserMutatingAction(input.actionType);
  // 健康投影先写：无论这一次成功还是失败，UI 看到的都应该是刚测出来的真实结论。
  // 写失败不阻断执行——展示事实不能拖住真实动作（与 0096 同一纪律）。
  const health = await manager.ensureWithHealth();
  try {
    await reportBrowserHealth(input.db, health);
  } catch { /* 投影写不进去不影响本次动作 */ }
  if (health.status !== 'READY') {
    return failed(backendCodeFor(health), backendMessageFor(health));
  }
  try {
    switch (input.actionType) {
      case 'BROWSER_LIST_PAGES': {
        const pages = await manager.listPages(owner);
        return succeeded({
          type: 'browser_pages',
          count: pages.length,
          pages: pages.slice(0, MAX_PAGES).map((page) => ({
            page_id: page.pageId, url: page.url, title: page.title,
            owned: page.owned, stale: page.stale, is_default: page.isDefault,
          })),
          ...(pages.length > MAX_PAGES ? { truncated: true } : {}),
        });
      }
      case 'BROWSER_NEW_PAGE': {
        const url = typeof params.url === 'string' ? params.url : undefined;
        const page = await manager.newPage(owner, url);
        return succeeded(pageResult('browser_new_page', page));
      }
      case 'BROWSER_CLOSE_PAGE': {
        const pageId = await manager.resolvePage(owner, String(params.page_id ?? ''));
        await manager.closePage(owner, pageId);
        return succeeded({ type: 'browser_closed_page', page_id: pageId });
      }
      case 'BROWSER_READ_PAGE': {
        const pageId = await manager.resolvePage(owner, asOptional(params.page_id));
        const snapshot = await manager.readPage(owner, pageId);
        return succeeded(snapshotResult('browser_read_page', snapshot));
      }
      case 'BROWSER_SCREENSHOT': {
        const pageId = await manager.resolvePage(owner, asOptional(params.page_id));
        const shot = await manager.screenshot(owner, pageId);
        return succeeded({
          type: 'browser_screenshot', page_id: pageId,
          width: shot.width, height: shot.height, bytes: shot.bytes,
          sha256: shot.sha256, mime_type: shot.mimeType,
          note: '截图正文不进入账本；需要定位元素请用 browser_read_page 的结构化快照。',
        });
      }
      case 'BROWSER_WAIT_FOR': {
        const pageId = await manager.resolvePage(owner, asOptional(params.page_id));
        const snapshot = await manager.act(owner, pageId, false, (provider) => provider.waitFor({
          pageId, text: String(params.text ?? ''),
          timeoutMs: typeof params.timeout_ms === 'number' ? params.timeout_ms : 10_000,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        }));
        return succeeded(snapshotResult('browser_wait_for', snapshot));
      }
      case 'BROWSER_NAVIGATE': {
        const pageId = await manager.resolvePage(owner, asOptional(params.page_id));
        const url = typeof params.url === 'string' ? params.url : undefined;
        const history = typeof params.history === 'string'
          ? params.history as 'back' | 'forward' | 'reload' : undefined;
        const mismatch = await originMismatch(manager, pageId);
        if (mismatch !== null) return failed('BROWSER_PAGE_STATE_CHANGED', mismatch);
        const snapshot = await manager.act(owner, pageId, true, (provider) => provider.navigate({
          pageId,
          ...(url === undefined ? {} : { url }),
          ...(history === undefined ? {} : { history }),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        }));
        return succeeded(snapshotResult('browser_navigate', snapshot));
      }
      case 'BROWSER_CLICK':
      case 'BROWSER_SUBMIT_FORM': {
        const pageId = await manager.resolvePage(owner, asOptional(params.page_id));
        const mismatch = await originMismatch(manager, pageId);
        if (mismatch !== null) return failed('BROWSER_PAGE_STATE_CHANGED', mismatch);
        const uid = String(params.uid ?? '');
        const double = params.double === true;
        const snapshot = await manager.act(owner, pageId, true, (provider) =>
          input.actionType === 'BROWSER_SUBMIT_FORM'
            ? provider.submitForm({ pageId, uid,
              ...(input.signal === undefined ? {} : { signal: input.signal }) })
            : provider.click({ pageId, uid, ...(double ? { double: true } : {}),
              ...(input.signal === undefined ? {} : { signal: input.signal }) }));
        return succeeded(snapshotResult(input.actionType === 'BROWSER_SUBMIT_FORM'
          ? 'browser_submit_form' : 'browser_click', snapshot));
      }
      case 'BROWSER_FILL': {
        const pageId = await manager.resolvePage(owner, asOptional(params.page_id));
        const mismatch = await originMismatch(manager, pageId);
        if (mismatch !== null) return failed('BROWSER_PAGE_STATE_CHANGED', mismatch);
        const snapshot = await manager.act(owner, pageId, true, (provider) => provider.fill({
          pageId, uid: String(params.uid ?? ''), text: String(params.text ?? ''),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        }));
        return succeeded(snapshotResult('browser_fill', snapshot));
      }
      case 'BROWSER_PRESS_KEY': {
        const pageId = await manager.resolvePage(owner, asOptional(params.page_id));
        const mismatch = await originMismatch(manager, pageId);
        if (mismatch !== null) return failed('BROWSER_PAGE_STATE_CHANGED', mismatch);
        const snapshot = await manager.act(owner, pageId, true, (provider) => provider.pressKey({
          pageId, key: String(params.key ?? ''),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        }));
        return succeeded(snapshotResult('browser_press_key', snapshot));
      }
      case 'BROWSER_UPLOAD_FILE': {
        const pageId = await manager.resolvePage(owner, asOptional(params.page_id));
        const absolute = resolveUploadPath(input.canonicalRoot ?? null,
          String(params.relative_path ?? ''));
        const snapshot = await manager.act(owner, pageId, true, (provider) => provider.uploadFile({
          pageId, uid: String(params.uid ?? ''), absolutePath: absolute,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        }));
        return succeeded(snapshotResult('browser_upload_file', snapshot));
      }
      default:
        return failed('BROWSER_INVALID_REQUEST', `未知的浏览器动作 ${input.actionType}`);
    }
  } catch (error) {
    if (error instanceof BrowserBackendError) {
      // 写类动作且结果可能已发生 → UNKNOWN：契约要求先核对，不算失败。
      if (mutating && error.effectUncertain) {
        return { outcome: 'UNKNOWN', result: {
          reason: 'BROWSER_EFFECT_UNCERTAIN', error: error.message,
          retryable: false, requires_user_action: false,
        } };
      }
      return failed(error.code, error.message, error.retryable);
    }
    return failed('BROWSER_ACTION_FAILED',
      error instanceof Error ? error.message : String(error));
  }
}

/**
 * 上传路径解析：只接受受管根内的相对路径。
 *
 * 解析后必须仍在根内（`..` 不能逃逸）；根未知时直接拒绝，不退到「当前工作目录」。
 */
export function resolveUploadPath(canonicalRoot: string | null, relativePath: string): string {
  if (canonicalRoot === null || canonicalRoot === '') {
    throw new BrowserBackendError('BROWSER_INVALID_REQUEST',
      '上传文件需要先绑定受管目录；当前动作没有可用的受管根。');
  }
  if (isAbsolute(relativePath)) {
    throw new BrowserBackendError('BROWSER_INVALID_REQUEST',
      'relative_path 必须是受管根内的相对路径，不接受绝对路径。');
  }
  const absolute = resolve(canonicalRoot, relativePath);
  const rel = relative(canonicalRoot, absolute);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new BrowserBackendError('BROWSER_INVALID_REQUEST',
      'relative_path 越出了受管根。');
  }
  return absolute;
}

/** 健康状态 → 类型化错误码（模型与 UI 看到的是同一套）。 */
function backendCodeFor(health: BrowserHealth): string {
  if (health.status === 'CHROME_MISSING') return 'BROWSER_CHROME_MISSING';
  if (health.status === 'BACKEND_MISSING') return 'BROWSER_BACKEND_MISSING';
  if (health.status === 'INCOMPATIBLE') return 'BROWSER_BACKEND_INCOMPATIBLE';
  return 'BROWSER_BACKEND_UNAVAILABLE';
}

function backendMessageFor(health: BrowserHealth): string {
  return health.remediation === null
    ? health.detail : `${health.detail} ${health.remediation}`;
}

/** 派发前的目标核对：页面实际 origin 必须仍是 prepare 时冻结的那个。 */
async function originMismatch(
  manager: ReturnType<typeof getBrowserSessionManager>, pageId: number,
): Promise<string | null> {
  const recorded = manager.recordedOrigin(pageId);
  if (recorded === null) return null; // 从未记录过（about:blank）：没有可核对的对象
  const live = await manager.liveOrigin(pageId);
  if (live === null) return null; // 读不到列表时交给动作本身报错，不在这里误判
  if (live === recorded) return null;
  return `页面已从 ${recorded} 变到 ${live}（可能被用户改走）；` +
    '本次动作的目标与准入时不一致，请先重新读取页面。';
}

function snapshotResult(action: string, snapshot: BrowserSnapshot): JsonObject {
  return {
    type: 'browser_action',
    action,
    page_id: snapshot.pageId,
    url: snapshot.url,
    title: snapshot.title,
    ready_state: snapshot.readyState,
    truncated: snapshot.truncated,
    elements: snapshot.elements.length,
    snapshot: snapshot.text,
  };
}

function pageResult(action: string, page: { pageId: number; url: string; title: string;
  owned: boolean }): JsonObject {
  return {
    type: 'browser_page', action, page_id: page.pageId, url: page.url, title: page.title,
    owned: page.owned,
  };
}

function succeeded(result: JsonObject): BrowserExecuteResult {
  return { outcome: 'SUCCEEDED', result };
}

function failed(reason: string, error: string, retryable = false): BrowserExecuteResult {
  return { outcome: 'FAILED', result: { reason, error, retryable } };
}

function failureFrom(error: unknown): BrowserExecuteResult {
  if (error instanceof BrowserBackendError) return failed(error.code, error.message);
  return failed('BROWSER_INVALID_REQUEST', error instanceof Error ? error.message : String(error));
}

function asOptional(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function optionalString(params: JsonObject, key: string): string | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new BrowserBackendError('BROWSER_INVALID_REQUEST', `${key} 必须是字符串。`);
  }
  return value === '' ? undefined : value;
}

function optionalInteger(params: JsonObject, key: string): number | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new BrowserBackendError('BROWSER_INVALID_REQUEST', `${key} 必须是整数。`);
  }
  return value;
}

function requireString(params: JsonObject, key: string, maxBytes: number): string {
  const value = params[key];
  if (typeof value !== 'string' || value === '') {
    throw new BrowserBackendError('BROWSER_INVALID_REQUEST', `${key} 必须是非空字符串。`);
  }
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new BrowserBackendError('BROWSER_INVALID_REQUEST',
      `${key} 超过 ${maxBytes} 字节上限。`);
  }
  return value;
}

/** 供 tool-loop 计算目标时复用：能力 → 是否浏览器。 */
export function isBrowserCapability(capability: string): boolean {
  return browserCapabilityFor(capability) !== null || capability.startsWith('BROWSER_');
}
