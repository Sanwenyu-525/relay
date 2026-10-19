/**
 * 浏览器扩展桥接（ADR-025）。
 *
 * 链路：Agent（Worker 进程）→ HTTP → API 进程 → WebSocket → 扩展 → chrome.debugger → 标签页。
 *
 * 认证与边界（任务书 §四 的逐条落实）：
 *   * WebSocket 只接受本机来源（Fastify 已绑 127.0.0.1），升级时校验路径；
 *   * 扩展必须在 hello 里携带**桥接令牌**——它是独立的随机令牌，不是 API 的 bearer token，
 *     泄露的影响面只有"浏览器操作"，且可随时重置（删除令牌文件重启即换新）；
 *   * 令牌与端口写在数据根的 `browser/bridge.json`，与扩展配置页/UI 共享同一事实；
 *   * 命令与结果都做结构与大小校验；单命令超时；同一时刻只允许一个扩展连接
 *     （新连接顶替旧连接，避免断连后的僵尸会话让任务挂死）；
 *   * 桥接层只转发，不解析页面内容，也不把页面文本写进日志。
 *
 * 为什么走 HTTP 而不是让 Worker 自己开 WebSocket：Worker 是无监听端口的 CLI 进程；
 * 让扩展直连 Worker 意味着再加一个本地端口与一套生命周期。复用 API 既有的监听与
 * 边界是成本最低且已经过验收的路径。
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Socket } from 'node:net';

import { BrowserBackendError } from './mcp-client.js';
import { acceptKey, handshakeResponse, WebSocketConnection } from './websocket.js';

export const BRIDGE_PATH = '/api/v1/browser-bridge';
const BRIDGE_DIR = 'browser';
const BRIDGE_FILE = 'bridge.json';
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const HELLO_TIMEOUT_MS = 8_000;

export interface BridgeRegistration {
  readonly port: number;
  readonly token: string;
}

/** 读（必要时生成）桥接令牌，并把端口写进共享文件。API 启动时调用一次。 */
export async function ensureBridgeRegistration(dataRoot: string,
  port: number): Promise<BridgeRegistration> {
  const dir = join(dataRoot, BRIDGE_DIR);
  await mkdir(dir, { recursive: true });
  const file = join(dir, BRIDGE_FILE);
  let token = '';
  if (existsSync(file)) {
    try {
      const previous = JSON.parse(await readFile(file, 'utf8')) as { token?: unknown };
      if (typeof previous.token === 'string' && previous.token.length >= 32) {
        token = previous.token;
      }
    } catch { /* 损坏则重新生成 */ }
  }
  if (token === '') token = randomBytes(32).toString('hex');
  await writeFile(file, `${JSON.stringify({ port, token, protocol: 'relay-browser-bridge-v1' },
    null, 2)}\n`, { encoding: 'utf8' });
  return { port, token };
}

/**
 * listen 之后把**实际绑定端口**写回桥接文件。
 *
 * 端口 0（临时端口）时，listen 之前只能写请求值 0，扩展照着它连 `127.0.0.1:0`
 * 永远连不上。重写沿用原令牌——令牌一换，已连上的扩展会被服务端判为非法。
 */
export async function syncBridgePort(dataRoot: string, requestedPort: number,
  boundPort: number): Promise<number> {
  if (boundPort === requestedPort) return requestedPort;
  await ensureBridgeRegistration(dataRoot, boundPort);
  return boundPort;
}

function tokenFile(dataRoot: string): string {
  return join(dataRoot, BRIDGE_DIR, BRIDGE_FILE);
}

/** Worker 侧读取桥接端点；文件不存在表示 API 尚未启动过浏览器桥接。 */
export async function readBridgeRegistration(dataRoot: string): Promise<BridgeRegistration | null> {
  if (!existsSync(tokenFile(dataRoot))) return null;
  try {
    const parsed = JSON.parse(await readFile(tokenFile(dataRoot), 'utf8')) as {
      port?: unknown; token?: unknown };
    if (typeof parsed.port !== 'number' || typeof parsed.token !== 'string' ||
        parsed.token.length < 32) return null;
    return { port: parsed.port, token: parsed.token };
  } catch {
    return null;
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// 扩展连接注册表（API 进程内）
// ---------------------------------------------------------------------------

interface ExtensionConnection {
  readonly socket: WebSocketConnection;
  readonly extensionVersion: string;
  readonly connectedAt: number;
}

let current: ExtensionConnection | null = null;
let pendingToken = '';

export interface BridgeUpgradeOptions {
  readonly dataRoot: string;
  /** 桥接令牌；与 `ensureBridgeRegistration` 写入文件的是同一个值。 */
  readonly token: string;
}

/**
 * 挂接 HTTP 服务器的 upgrade 事件。
 *
 * 只认 `BRIDGE_PATH`：其它路径一律不处理（交给既有 404 语义），避免把普通 HTTP
 * 请求误升级成 WebSocket。
 */
export function registerBridgeUpgrade(httpServer: { on(event: 'upgrade',
  listener: (request: unknown, socket: unknown, head: Buffer) => void): unknown },
  options: BridgeUpgradeOptions): void {
  pendingToken = options.token;
  httpServer.on('upgrade', (request, socket, head) => {
    const raw = request as { url?: unknown; headers?: Record<string, unknown> };
    const url = typeof raw.url === 'string' ? raw.url.split('?')[0] : '';
    if (url !== BRIDGE_PATH) return;
    const key = raw.headers?.['sec-websocket-key'];
    if (typeof key !== 'string' || key === '') {
        if (socket instanceof Socket) socket.destroy();
      return;
    }
    if (socket instanceof Socket) socket.write(handshakeResponse(acceptKey(key)));
    handleConnection(new WebSocketConnection(socket as Socket));
  });
}

function handleConnection(connection: WebSocketConnection): void {
  let helloed = false;
  let keepaliveTimer: ReturnType<typeof setInterval> | undefined;
  const fail = (message: string): void => {
    connection.close(1008);
    void message;
  };
  const helloTimer = setTimeout(() => {
    if (!helloed) fail('hello timeout');
  }, HELLO_TIMEOUT_MS);
  connection.on('message', (raw) => {
    if (helloed) return;
    let frame: { type?: unknown; protocol?: unknown; token?: unknown;
      extensionVersion?: unknown };
    try { frame = JSON.parse(String(raw)); } catch { return fail('bad json'); }
    if (frame.type !== 'hello' || frame.protocol !== 'relay-browser-bridge-v1') {
      return fail('bad hello');
    }
    const provided = typeof frame.token === 'string' ? frame.token : '';
    if (provided.length < 32 || digest(provided) !== digest(pendingToken)) {
      return fail('bad token');
    }
    helloed = true;
    clearTimeout(helloTimer);
    // 顶替旧连接：断连后的僵尸会话不能让任务挂死。
    if (current !== null) current.socket.close(1000);
    current = { socket: connection,
      extensionVersion: typeof frame.extensionVersion === 'string'
        ? frame.extensionVersion : 'unknown', connectedAt: Date.now() };
    connection.sendText(JSON.stringify({ type: 'ready', bridgeId: randomId() }));
    // Chrome 116+ 通过实际 WebSocket 消息延长 MV3 worker 的 30 秒空闲窗口。
    // 由本机 API 发消息，不依赖已可能休眠的扩展定时器；旧扩展可忽略此帧。
    keepaliveTimer = setInterval(() => {
      connection.sendText(JSON.stringify({ type: 'keepalive' }));
    }, 20_000);
    keepaliveTimer.unref();
  });
  connection.on('close', () => {
    clearTimeout(helloTimer);
    if (keepaliveTimer !== undefined) clearInterval(keepaliveTimer);
    if (current?.socket === connection) current = null;
  });
}

function randomId(): string {
  return randomBytes(8).toString('hex');
}

export interface BridgeCommandResult {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
  readonly extensionVersion: string;
}

/** 桥接是否就绪（扩展已连接）。 */
export function bridgeConnected(): boolean {
  return current !== null;
}

export function bridgeExtensionVersion(): string | null {
  return current?.extensionVersion ?? null;
}

/**
 * 把一条命令转给扩展并等待结果。
 *
 * 没有扩展连接 = `BROWSER_EXTENSION_MISSING`（这是 UI 安装引导的触发点，
 * 不是"后端坏了"）；超时不杀扩展进程（那是 Chrome 的子组件，杀不得），
 * 只把本次等待判为失败——扩展侧重试/恢复由它自己的重连语义负责。
 */
export async function dispatchBridgeCommand(op: string, params: Record<string, unknown>,
  timeoutMs: number, signal?: AbortSignal): Promise<BridgeCommandResult> {
  const connection = current;
  if (connection === null) {
    throw new BrowserBackendError('BROWSER_EXTENSION_MISSING',
      '浏览器扩展未连接；请在 Chrome 里安装并启用 Relay 浏览器桥接扩展，' +
      '并在扩展设置里填入本机 API 地址与配对令牌。');
  }
  const id = randomId();
  const payload = JSON.stringify({ type: 'cmd', id, op, params });
  if (payload.length > MAX_FRAME_BYTES) {
    throw new BrowserBackendError('BROWSER_INVALID_REQUEST', '命令超过桥接单帧上限。');
  }
  return new Promise<BridgeCommandResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new BrowserBackendError('BROWSER_TIMEOUT',
        `桥接命令 ${op} 在 ${timeoutMs} ms 内没有返回。`, true, true));
    }, timeoutMs);
    const onAbort = (): void => {
      cleanup();
      reject(new BrowserBackendError('BROWSER_USER_CANCELLED', '命令已取消。', false, true));
    };
    const onMessage = (value: unknown): void => {
      const raw = value as string;
      let frame: { type?: unknown; id?: unknown; ok?: unknown; result?: unknown;
        error?: unknown };
      try { frame = JSON.parse(String(raw)); } catch { return; }
      if (frame.type !== 'result' || frame.id !== id) return;
      cleanup();
      if (frame.ok !== true) {
        const error = (typeof frame.error === 'object' && frame.error !== null
          ? frame.error : {}) as { code?: unknown; message?: unknown };
        resolve({ ok: false, extensionVersion: connection.extensionVersion,
          error: { code: typeof error.code === 'string' ? error.code : 'BROWSER_ACTION_FAILED',
            message: typeof error.message === 'string' ? error.message : '未知错误' } });
        return;
      }
      resolve({ ok: true, result: frame.result, extensionVersion: connection.extensionVersion });
    };
    const onClose = (): void => {
      cleanup();
      reject(new BrowserBackendError('BROWSER_BACKEND_DISCONNECTED',
        '浏览器扩展在命令执行中断开。', true, true));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      connection.socket.off('message', onMessage as never);
      connection.socket.off('close', onClose as never);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    connection.socket.on('message', onMessage as never);
    connection.socket.on('close', onClose as never);
    if (!connection.socket.sendText(JSON.stringify({ type: 'cmd', id, op, params }))) {
      cleanup();
      reject(new BrowserBackendError('BROWSER_BACKEND_DISCONNECTED',
        '浏览器扩展连接不可写。', true, false));
    }
  });
}
