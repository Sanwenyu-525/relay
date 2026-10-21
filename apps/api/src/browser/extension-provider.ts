/**
 * 基于扩展桥接的 BrowserProvider（ADR-025，F26 M4a）。
 *
 * 与 `McpBrowserProvider` 实现同一个接口，但引擎不同：命令经 HTTP 转给 API 进程，
 * 再由 API 经 WebSocket 转给用户 Chrome 里的扩展，扩展用 `chrome.debugger` 驱动
 * **用户自己的标签页**。因此这里没有任何浏览器进程管理代码——那正是两条路线
 * 的分界线。
 *
 * 快照文本与 chrome-devtools-mcp 同构（扩展侧按同一格式生成），所以 Relay 侧的
 * 解析器、风险分类器与工具结果投影无需第二套。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { BrowserBackendError } from './mcp-client.js';
import { BROWSER_ERROR_CODES, type BrowserErrorCode } from './protocol.js';
import {
  MAX_SNAPSHOT_CHARS,
  type BrowserCallOptions, type BrowserHealth, type BrowserPageRef, type BrowserProvider,
  type BrowserScreenshotSummary, type BrowserSnapshot,
} from './provider.js';
import { parseSnapshotText } from './snapshot-parse.js';

export interface ExtensionProviderOptions {
  readonly dataRoot: string;
  readonly requestTimeoutMs?: number;
  /** 测试接缝：注入 fetch。 */
  readonly fetchImpl?: typeof fetch;
}

interface BridgeRegistration {
  readonly port: number;
  readonly token: string;
}

interface BridgeReply {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
  readonly extensionVersion?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MUTATING_OPERATIONS: ReadonlySet<string> = new Set([
  'new_page', 'close_page', 'navigate', 'history', 'click', 'fill', 'press_key',
  'submit_form', 'upload_file',
]);
const DEFINITE_NO_EFFECT_CODES: ReadonlySet<BrowserErrorCode> = new Set([
  'BROWSER_PAGE_NOT_FOUND', 'BROWSER_PAGE_NOT_OWNED', 'BROWSER_ELEMENT_NOT_FOUND',
  'BROWSER_NAVIGATION_BLOCKED', 'BROWSER_INVALID_REQUEST',
]);

export class ExtensionBridgeProvider implements BrowserProvider {
  readonly kind = 'extension-bridge';
  private readonly fetchImpl: typeof fetch;
  private cachedRegistration: BridgeRegistration | null = null;
  private lastHealth: BrowserHealth | null = null;

  constructor(private readonly options: ExtensionProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async ensureStarted(options: BrowserCallOptions = {}): Promise<BrowserHealth> {
    void options;
    // READY 不做长期缓存：扩展断开不会通知本进程，缓存住上一次 READY 会让界面一直显示
    // 「就绪」，直到用户点了操作才发现连不上。每次启动检查都重新探测真实连接。
    const registration = await this.registration();
    if (registration === null) {
      return this.remember({ status: 'BACKEND_MISSING', backendVersion: null,
        chromeVersion: null, tools: [], detail: '尚未建立浏览器桥接（API 未启动或数据根缺失）。',
        remediation: '重启 Relay 桌面端；若仍失败请查看诊断日志。' });
    }
    // 就绪与否由扩展是否连着决定：一次轻量探测（list_pages）既是健康检查也是能力自检。
    try {
      const reply = await this.command('list_pages', {}, 10_000);
      return this.remember({ status: 'READY', backendVersion: reply.extensionVersion ?? 'extension',
        chromeVersion: null,
        tools: ['list_pages', 'new_page', 'close_page', 'read_page', 'navigate', 'click',
          'fill', 'press_key', 'wait_for', 'screenshot', 'submit_form', 'upload_file'],
        detail: '浏览器扩展已连接（用户自己的 Chrome）。', remediation: null });
    } catch (error) {
      return this.remember({
        status: 'DISCONNECTED', backendVersion: null, chromeVersion: null, tools: [],
        detail: error instanceof Error ? error.message : String(error),
        remediation: '重新执行一次浏览器操作会自动重试；若持续失败请检查 API 是否在运行。',
      });
    }
  }

  async health(): Promise<BrowserHealth> {
    if (this.lastHealth === null) {
      return { status: 'DISCONNECTED', backendVersion: null, chromeVersion: null, tools: [],
        detail: '浏览器扩展尚未连接。', remediation: '首次使用浏览器能力时自动尝试连接。' };
    }
    return this.lastHealth;
  }

  async listPages(options: BrowserCallOptions = {}): Promise<readonly BrowserPageRef[]> {
    const reply = await this.command('list_pages', {}, DEFAULT_TIMEOUT_MS, options);
    const pages = (reply.result as { pages?: unknown })?.pages;
    if (!Array.isArray(pages)) {
      throw new BrowserBackendError('BROWSER_PROTOCOL_VIOLATION', '页面列表形状不符。');
    }
    // 不在 Provider 侧截断：截断与标记统一在适配层做（见 provider.ts 的 MAX_PAGES）。
    return pages.map((entry) => {
      const record = entry as Record<string, unknown>;
      return { pageId: Number(record.pageId), url: String(record.url ?? ''),
        title: String(record.title ?? '') };
    });
  }

  async newPage(input: { url?: string } & BrowserCallOptions): Promise<BrowserPageRef> {
    const reply = await this.command('new_page', { url: input.url ?? 'about:blank' },
      DEFAULT_TIMEOUT_MS, input);
    const record = asRecord(reply.result);
    if (record === null || typeof record.pageId !== 'number') {
      throw new BrowserBackendError('BROWSER_PROTOCOL_VIOLATION', '新建页结果缺少 pageId。');
    }
    return { pageId: record.pageId, url: String(record.url ?? ''), title: String(record.title ?? '') };
  }

  async closePage(pageId: number, options: BrowserCallOptions = {}): Promise<void> {
    await this.command('close_page', { pageId }, DEFAULT_TIMEOUT_MS, options);
  }

  async readPage(pageId: number, options: BrowserCallOptions = {}): Promise<BrowserSnapshot> {
    const reply = await this.command('read_page', { pageId }, DEFAULT_TIMEOUT_MS, options);
    return this.toSnapshot(pageId, reply);
  }

  async navigate(input: { pageId: number; url?: string;
    history?: 'back' | 'forward' | 'reload' } & BrowserCallOptions): Promise<BrowserSnapshot> {
    if (input.url !== undefined) {
      const reply = await this.command('navigate', {
        pageId: input.pageId, url: input.url, timeoutMs: DEFAULT_TIMEOUT_MS - 5_000,
      }, DEFAULT_TIMEOUT_MS, input);
      return this.toSnapshot(input.pageId, reply);
    }
    // 后退/前进/刷新走扩展的 history：CDP 的 Page.navigateToHistoryEntry 与 Page.reload，
    // 不是「用新 URL 假装后退」——历史条目由浏览器自己维护。
    if (input.history !== undefined) {
      const reply = await this.command('history', {
        pageId: input.pageId, direction: input.history,
        timeoutMs: DEFAULT_TIMEOUT_MS - 5_000,
      }, DEFAULT_TIMEOUT_MS, input);
      return this.toSnapshot(input.pageId, reply);
    }
    throw new BrowserBackendError('BROWSER_INVALID_REQUEST',
      'browser_navigate 需要 url 或 history 之一。');
  }

  async click(input: { pageId: number; uid: string; double?: boolean } & BrowserCallOptions):
  Promise<BrowserSnapshot> {
    const reply = await this.command('click', {
      pageId: input.pageId, uid: input.uid,
      ...(input.double === true ? { double: true } : {}),
    }, DEFAULT_TIMEOUT_MS, input);
    return this.toSnapshot(input.pageId, reply);
  }

  async fill(input: { pageId: number; uid: string; text: string } & BrowserCallOptions):
  Promise<BrowserSnapshot> {
    const reply = await this.command('fill', {
      pageId: input.pageId, uid: input.uid, text: input.text,
    }, DEFAULT_TIMEOUT_MS, input);
    return this.toSnapshot(input.pageId, reply);
  }

  async pressKey(input: { pageId: number; key: string } & BrowserCallOptions):
  Promise<BrowserSnapshot> {
    const reply = await this.command('press_key', { pageId: input.pageId, key: input.key },
      DEFAULT_TIMEOUT_MS, input);
    return this.toSnapshot(input.pageId, reply);
  }

  async waitFor(input: { pageId: number; text: string; timeoutMs: number } & BrowserCallOptions):
  Promise<BrowserSnapshot> {
    const reply = await this.command('wait_for', {
      pageId: input.pageId, text: input.text, timeoutMs: input.timeoutMs,
    }, input.timeoutMs + 10_000, input);
    return this.toSnapshot(input.pageId, reply);
  }

  async submitForm(input: { pageId: number; uid: string } & BrowserCallOptions):
  Promise<BrowserSnapshot> {
    const reply = await this.command('submit_form', { pageId: input.pageId, uid: input.uid },
      DEFAULT_TIMEOUT_MS, input);
    return this.toSnapshot(input.pageId, reply);
  }

  async uploadFile(input: { pageId: number; uid: string; absolutePath: string }
  & BrowserCallOptions): Promise<BrowserSnapshot> {
    const reply = await this.command('upload_file', {
      pageId: input.pageId, uid: input.uid, filePath: input.absolutePath,
    }, DEFAULT_TIMEOUT_MS, input);
    return this.toSnapshot(input.pageId, reply);
  }

  async screenshot(pageId: number, options: BrowserCallOptions = {}):
  Promise<BrowserScreenshotSummary> {
    const reply = await this.command('screenshot', { pageId }, DEFAULT_TIMEOUT_MS, options);
    const record = asRecord(reply.result);
    if (record === null || typeof record.data !== 'string') {
      throw new BrowserBackendError('BROWSER_PROTOCOL_VIOLATION', '截图结果缺少数据。');
    }
    // 尺寸与摘要在扩展侧从 PNG 字节算出（IHDR + SHA-256）；扩展没给时如实降级，
    // 不拿 base64 长度冒充字节数。
    const bytes = typeof record.bytes === 'number' ? record.bytes
      : Math.floor(record.data.length * 3 / 4);
    return {
      width: typeof record.width === 'number' ? record.width : null,
      height: typeof record.height === 'number' ? record.height : null,
      bytes,
      sha256: typeof record.sha256 === 'string' && record.sha256 !== ''
        ? record.sha256 : 'unavailable',
      mimeType: typeof record.mimeType === 'string' ? record.mimeType : 'image/png',
    };
  }

  async dispose(): Promise<void> {
    this.lastHealth = null;
    // 释放后重新读桥接文件：API 重启会换端口与令牌，缓存住旧值只会让后续命令打到空端口。
    this.cachedRegistration = null;
  }

  private async toSnapshot(pageId: number, reply: BridgeReply): Promise<BrowserSnapshot> {
    const record = asRecord(reply.result);
    if (record === null || typeof record.text !== 'string') {
      throw new BrowserBackendError('BROWSER_PROTOCOL_VIOLATION', '快照结果缺少文本。');
    }
    const parsed = parseSnapshotText(record.text);
    const truncated = record.truncated === true;
    return {
      pageId,
      url: typeof record.url === 'string' ? record.url : parsed.url ?? '',
      title: typeof record.title === 'string' ? record.title : parsed.title ?? '',
      readyState: asReadyState(record.readyState),
      text: truncated ? record.text.slice(0, MAX_SNAPSHOT_CHARS) : record.text,
      truncated,
      elements: parsed.elements,
    };
  }

  private async command(op: string, params: Record<string, unknown>, timeoutMs: number,
    options?: BrowserCallOptions): Promise<BridgeReply> {
    if (wasAborted(options)) {
      throw new BrowserBackendError('BROWSER_USER_CANCELLED', '命令已取消（尚未发送）。', false,
        false);
    }
    const registration = await this.registration();
    if (registration === null) {
      throw new BrowserBackendError('BROWSER_BACKEND_MISSING', '浏览器桥接尚未注册。');
    }
    if (wasAborted(options)) {
      throw new BrowserBackendError('BROWSER_USER_CANCELLED', '命令已取消（尚未发送）。', false,
        false);
    }
    const mutating = MUTATING_OPERATIONS.has(op);
    const timeout = AbortSignal.timeout(this.options.requestTimeoutMs ?? timeoutMs + 1_000);
    const signal = options?.signal === undefined ? timeout
      : AbortSignal.any([options.signal, timeout]);
    let response: Response;
    try {
      response = await this.fetchImpl(
        `http://127.0.0.1:${registration.port}/api/v1/browser-bridge/commands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json',
          'x-bridge-token': registration.token },
        body: JSON.stringify({ op, params, timeout_ms: timeoutMs }),
        signal,
      });
    } catch (error) {
      const cancelled = wasAborted(options) ||
        (error instanceof Error && error.name === 'AbortError');
      throw new BrowserBackendError(cancelled ? 'BROWSER_USER_CANCELLED'
        : timeout.aborted ? 'BROWSER_TIMEOUT'
        : 'BROWSER_BACKEND_DISCONNECTED', cancelled ? '命令发送后已取消；结果需要核对。'
          : '浏览器桥接请求断开；结果需要核对。', !cancelled, mutating);
    }
    if (response.status !== 200) {
      const body = await response.json().catch(() => null) as unknown;
      const problem = asRecord(body);
      const code = browserErrorCode(problem?.code) ?? (response.status === 503
        ? 'BROWSER_EXTENSION_MISSING' : 'BROWSER_BACKEND_UNAVAILABLE');
      const message = typeof problem?.detail === 'string' ? problem.detail
        : `桥接命令失败（HTTP ${response.status}）。`;
      throw new BrowserBackendError(code, message, response.status >= 500,
        mutating && (response.status >= 500 || code === 'BROWSER_TIMEOUT' ||
          code === 'BROWSER_BACKEND_DISCONNECTED'));
    }
    let body: unknown;
    try { body = await response.json(); }
    catch {
      throw new BrowserBackendError('BROWSER_PROTOCOL_VIOLATION',
        '桥接命令响应无法解析；结果需要核对。', false, mutating);
    }
    const record = asRecord(body);
    if (record === null || typeof record.ok !== 'boolean') {
      throw new BrowserBackendError('BROWSER_PROTOCOL_VIOLATION',
        '桥接响应形状不符；结果需要核对。', false, mutating);
    }
    const reply = record as unknown as BridgeReply;
    if (!reply.ok) {
      const code = browserErrorCode(reply.error?.code) ?? 'BROWSER_ACTION_FAILED';
      const message = typeof reply.error?.message === 'string'
        ? reply.error.message : '浏览器扩展动作失败。';
      throw new BrowserBackendError(code, message, undefined,
        mutating && !DEFINITE_NO_EFFECT_CODES.has(code));
    }
    return reply;
  }

  private async registration(): Promise<BridgeRegistration | null> {
    if (this.cachedRegistration !== null) return this.cachedRegistration;
    const registration = await readBridgeRegistration(this.options.dataRoot);
    // 只缓存**成功**结果。桥接文件由 API 在启动时写入，而 Provider 可能先被构造；
    // 把 null 也缓存下来，会把「这一刻还没写」永久固化成「没有桥接」，只能重启进程才恢复。
    if (registration !== null) this.cachedRegistration = registration;
    return registration;
  }

  private remember(health: BrowserHealth): BrowserHealth {
    this.lastHealth = health;
    return health;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/**
 * 取消判定写成函数而不是内联比较：`AbortSignal.aborted` 是 readonly，
 * TS 会把一次比较的结果跨 `await` 保持下去，导致后面的同类判断被当成
 * 「不可能成立」而报错——而它恰恰是 `await` 之后必须重新读的活状态。
 */
/** `document.readyState` 的封闭取值；扩展没给或给了别的值一律当「不知道」。 */
function asReadyState(value: unknown): 'loading' | 'interactive' | 'complete' | null {
  return value === 'loading' || value === 'interactive' || value === 'complete' ? value : null;
}

function wasAborted(options: BrowserCallOptions | undefined): boolean {
  return options?.signal?.aborted === true;
}

function browserErrorCode(value: unknown): BrowserErrorCode | null {
  return typeof value === 'string' &&
    (BROWSER_ERROR_CODES as readonly string[]).includes(value)
    ? value as BrowserErrorCode : null;
}

async function readBridgeRegistration(dataRoot: string): Promise<BridgeRegistration | null> {
  try {
    const parsed = JSON.parse(await readFile(join(dataRoot, 'browser', 'bridge.json'), 'utf8')) as {
      port?: unknown; token?: unknown };
    if (typeof parsed.port !== 'number' || typeof parsed.token !== 'string' ||
        parsed.token.length < 32) return null;
    return { port: parsed.port, token: parsed.token };
  } catch {
    return null;
  }
}
