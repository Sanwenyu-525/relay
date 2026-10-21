import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import type { Socket } from 'node:net';
import test from 'node:test';

import Fastify from 'fastify';

import type { GatewayOrigin } from '../../src/application/gateway-actions.js';
import type { JsonObject } from '../../src/infrastructure/json.js';
import type { DbExecutor } from '../../src/infrastructure/database.js';
import { browserExecute } from '../../src/browser/browser-adapter.js';
import { registerBrowserBridgeCommandRoutes } from '../../src/api/browser-api.js';
import { bridgeConnected, ensureBridgeRegistration, registerBridgeUpgrade, syncBridgePort }
  from '../../src/browser/bridge.js';
import { replaceBrowserSessionManagerForTest } from '../../src/browser/client-holder.js';
import { ExtensionBridgeProvider } from '../../src/browser/extension-provider.js';
import { BrowserSessionManager } from '../../src/browser/session-manager.js';

const PROTOCOL = 'relay-browser-bridge-v1';
const EXTENSION_VERSION = '0.1.0';
const USER_TAB_ID = 700;

interface TestTab {
  readonly id: number;
  readonly url: string;
  readonly title: string;
  readonly active: boolean;
}

type EventListener = (...args: never[]) => void;

function makeChrome(serverUrl: string, token: string, initialTabs: readonly TestTab[] = []) {
  const owned: Record<string, unknown> = {};
  const tabs = new Map(initialTabs.map((tab) => [tab.id, tab]));
  const removedListeners = new Set<(tabId: number) => void>();
  const id = { next: Math.max(700, ...tabs.keys()) + 1 };
  return {
    tabs,
    chrome: {
      storage: {
        local: { get: async (): Promise<Record<string, unknown>> => ({ serverUrl, token }) },
        session: {
          get: async (key: string): Promise<Record<string, unknown>> => ({ [key]: owned[key] ?? [] }),
          set: async (values: Record<string, unknown>): Promise<void> => { Object.assign(owned, values); },
        },
        onChanged: { addListener: (_listener: EventListener): void => undefined },
      },
      runtime: {
        lastError: undefined as { message: string } | undefined,
        getManifest: (): { version: string } => ({ version: EXTENSION_VERSION }),
        getURL: (path: string): string => `chrome-extension://relay-test/${path}`,
        onStartup: { addListener: (_listener: EventListener): void => undefined },
        onInstalled: { addListener: (_listener: EventListener): void => undefined },
      },
      alarms: {
        create: (_name: string, _info: Record<string, unknown>): void => undefined,
        onAlarm: { addListener: (_listener: EventListener): void => undefined },
      },
      tabs: {
        onRemoved: { addListener: (listener: (tabId: number) => void): void => {
          removedListeners.add(listener);
        } },
        query: async (): Promise<TestTab[]> => [...tabs.values()],
        create: (input: { url: string; active: boolean }, callback: (tab: TestTab) => void): void => {
          const tab = { id: id.next++, url: input.url, title: 'Agent test page', active: input.active };
          tabs.set(tab.id, tab);
          callback(tab);
        },
        get: (tabId: number, callback: (tab: TestTab | undefined) => void): void => {
          callback(tabs.get(tabId));
        },
        remove: (tabId: number, callback: () => void): void => {
          tabs.delete(tabId);
          for (const listener of removedListeners) listener(tabId);
          callback();
        },
      },
      debugger: {
        onDetach: { addListener: (_listener: EventListener): void => undefined },
      },
    },
  };
}

test('桥接 HTTP 等待有上限，发送前取消不派发，发送后超时保留效果未知', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'relay-browser-http-timeout-'));
  await mkdir(join(dataRoot, 'browser'));
  await writeFile(join(dataRoot, 'browser', 'bridge.json'),
    JSON.stringify({ port: 65500, token: 't'.repeat(64) }));
  let calls = 0;
  const provider = new ExtensionBridgeProvider({ dataRoot, requestTimeoutMs: 20,
    fetchImpl: async (_url, init) => {
      calls += 1;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    } });
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(provider.click({ pageId: 1, uid: '1', signal: controller.signal }),
      { code: 'BROWSER_USER_CANCELLED', effectUncertain: false });
    assert.equal(calls, 0);
    await assert.rejects(withTimeout(provider.click({ pageId: 1, uid: '1' }), 1_000,
      'bounded HTTP request'), { code: 'BROWSER_TIMEOUT', effectUncertain: true });
    assert.equal(calls, 1);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

class FakeWebSocket {
  static readonly OPEN = 1;
  readonly sent: Record<string, unknown>[] = [];
  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    queueMicrotask(() => this.onopen?.());
  }

  send(data: string): void { this.sent.push(JSON.parse(data) as Record<string, unknown>); }
  close(): void { this.readyState = 3; this.onclose?.(); }
}

async function loadExtensionSource(): Promise<string> {
  const entry = process.env.RELAY_BROWSER_EXTENSION_ENTRY ??
    resolve(process.cwd(), '../browser-extension/background.js');
  return await readFile(entry, 'utf8');
}

function runWithFakeWebSocket(source: string, serverUrl: string, token: string): FakeWebSocket[] {
  const sockets: FakeWebSocket[] = [];
  const Fake = class extends FakeWebSocket {
    constructor(url: string) { super(url); sockets.push(this); }
  };
  const { chrome } = makeChrome(serverUrl, token);
  runInNewContext(source, { chrome, WebSocket: Fake, URL,
    navigator: { userAgent: 'Relay test' }, setTimeout, clearTimeout }, {
    filename: 'apps/browser-extension/background.js',
  });
  return sockets;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)),
        timeoutMs);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitFor<T>(read: () => Promise<T | null>, timeoutMs: number,
  label: string): Promise<T> {
  const started = Date.now();
  for (;;) {
    const result = await read();
    if (result !== null) return result;
    if (Date.now() - started >= timeoutMs) throw new Error(`${label} timed out after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function sendHello(socket: InstanceType<typeof WebSocket>, hello: Record<string, unknown>):
Promise<void> {
  await withTimeout(new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('WebSocket failed before open')),
      { once: true });
  }), 2_000, 'WebSocket open');
  socket.send(JSON.stringify(hello));
}

test('扩展从 HTTP API 地址生成匹配服务端的 WS URL，并在 hello 里携带配对令牌', async () => {
  const source = await loadExtensionSource();
  const token = 'a'.repeat(64);
  const failures: string[] = [];
  for (const [serverUrl, expected] of [
    ['http://127.0.0.1:8787', 'ws://127.0.0.1:8787/api/v1/browser-bridge'],
    ['https://localhost:8787', 'wss://localhost:8787/api/v1/browser-bridge'],
  ] as const) {
    const sockets = runWithFakeWebSocket(source, serverUrl, token);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const socket = sockets[0];
    if (socket?.url !== expected) failures.push(`WS URL ${socket?.url ?? '(missing)'} != ${expected}`);
    const hello = socket?.sent[0];
    if (hello?.type !== 'hello' || hello.protocol !== PROTOCOL) {
      failures.push('hello type/protocol 与服务端契约不匹配。');
    }
    if (hello?.token !== token) failures.push('hello 缺少有效配对令牌。');
  }
  assert.deepEqual(failures, []);
});

test('真实本机 API/WebSocket + 实际扩展脚本 + Provider：配对、命令结果、页面隔离与重连',
  async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'relay-browser-extension-e2e-'));
    const sockets: InstanceType<typeof WebSocket>[] = [];
    const serverSockets = new Set<Socket>();
    const vmTimers = new Set<ReturnType<typeof setTimeout>>();
    let vmStopped = false;
    const tabs = [{ id: USER_TAB_ID, url: 'http://user-tab.invalid/',
      title: 'User tab', active: true } satisfies TestTab];
    const api = Fastify({ logger: false });
    let port = 0;
    let token = '';
    const trackedWebSocket = new Proxy(WebSocket, {
      construct(target, args, newTarget) {
        const socket = Reflect.construct(target, args, newTarget) as InstanceType<typeof WebSocket>;
        sockets.push(socket);
        return socket;
      },
    });

    try {
      const registration = await ensureBridgeRegistration(dataRoot, 0);
      token = registration.token;
      api.register(async (scope) => {
        registerBrowserBridgeCommandRoutes(scope, { database: {} as never, bridgeToken: token });
      }, { prefix: '/api/v1' });
      api.server.on('connection', (socket: Socket) => {
        serverSockets.add(socket);
        socket.on('close', () => serverSockets.delete(socket));
      });
      registerBridgeUpgrade(api.server, { dataRoot, token });
      await withTimeout(api.listen({ host: '127.0.0.1', port: 0 }), 3_000, 'Fastify listen');
      const address = api.server.address();
      assert.ok(address !== null && typeof address === 'object');
      port = address.port;
      await ensureBridgeRegistration(dataRoot, port);

      const extensionSource = await loadExtensionSource();
      const { chrome, tabs: tabMap } = makeChrome(`http://127.0.0.1:${port}`, token, tabs);
      const vmSetTimeout = (callback: (...args: unknown[]) => void, delay?: number,
        ...args: unknown[]): ReturnType<typeof setTimeout> => {
        const handle = setTimeout(() => {
          vmTimers.delete(handle);
          if (!vmStopped) callback(...args);
        }, delay);
        vmTimers.add(handle);
        if (vmStopped) handle.unref();
        return handle;
      };
      const vmClearTimeout = (handle: ReturnType<typeof setTimeout>): void => {
        clearTimeout(handle);
        vmTimers.delete(handle);
      };
      runInNewContext(extensionSource, {
        chrome, WebSocket: trackedWebSocket, URL,
        navigator: { userAgent: 'Relay integration test' },
        setTimeout: vmSetTimeout, clearTimeout: vmClearTimeout,
      }, { filename: 'apps/browser-extension/background.js' });

      await withTimeout((async () => {
        while (!bridgeConnected()) await new Promise((resolve) => setTimeout(resolve, 10));
      })(), 3_000, 'extension hello');
      const provider = new ExtensionBridgeProvider({ dataRoot });
      const health = await withTimeout(provider.ensureStarted(), 3_000, 'Provider health');
      assert.equal(health.status, 'READY');
      const pages = await withTimeout(provider.listPages(), 3_000, 'list_pages command/result');
      assert.deepEqual(pages.map((page) => page.pageId), [USER_TAB_ID]);
      const extensionSocket = sockets.find((socket) => socket.readyState === WebSocket.OPEN);
      assert.ok(extensionSocket);
      await withTimeout(new Promise<void>((resolve) => {
        extensionSocket.addEventListener('message', (event) => {
          const frame = JSON.parse(String(event.data)) as { type?: unknown };
          if (frame.type === 'keepalive') resolve();
        });
      }), 23_000, 'authenticated bridge idle keepalive');

      const unauthorized = await fetch(`http://127.0.0.1:${port}/api/v1/browser-bridge/commands`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'list_pages', params: {} }),
      });
      assert.equal(unauthorized.status, 401, 'bridge HTTP command must require pairing token');

      const badTokenSocket = new trackedWebSocket(`ws://127.0.0.1:${port}/api/v1/browser-bridge`);
      const badTokenClosed = withTimeout(new Promise<number>((resolve) => {
        badTokenSocket.addEventListener('close', (event) => resolve(event.code), { once: true });
      }), 2_000, 'bad token rejection');
      await sendHello(badTokenSocket, { type: 'hello', protocol: PROTOCOL,
        extensionVersion: 'negative-test', token: 'wrong-token' });
      assert.equal(await badTokenClosed, 1008, 'invalid WebSocket pairing token must be rejected');

      const created = await withTimeout(provider.newPage({ url: 'http://relay-test.invalid/' }),
        3_000, 'new_page command/result');
      assert.equal(created.pageId, USER_TAB_ID + 1);
      assert.equal(tabMap.get(USER_TAB_ID)?.active, true, 'existing user tab stays active');
      assert.equal(tabMap.get(created.pageId)?.active, false, 'Agent tab is created in background');

      let deniedClose: unknown;
      try { await withTimeout(provider.closePage(USER_TAB_ID), 3_000, 'user close denial'); }
      catch (error) { deniedClose = error; }
      assert.ok(deniedClose instanceof Error && 'code' in deniedClose &&
        deniedClose.code === 'BROWSER_PAGE_NOT_OWNED',
      'extension refusal must reach Provider as a typed ownership error');
      assert.equal(tabMap.has(USER_TAB_ID), true, 'user tab remains open');
      await withTimeout(provider.closePage(created.pageId), 3_000, 'owned close command/result');
      assert.equal(tabMap.has(created.pageId), false, 'Agent tab can be closed');

      const active = sockets.find((socket) => socket.readyState === WebSocket.OPEN);
      assert.ok(active, 'extension WebSocket remains connected');
      active.close();
      await withTimeout(waitFor(async () => {
        try { return await provider.listPages(); } catch { return null; }
      }, 5_000, 'extension reconnect command'), 6_000, 'extension reconnect');
      assert.deepEqual((await withTimeout(provider.listPages(), 3_000, 'post-reconnect command'))
        .map((page) => page.pageId), [USER_TAB_ID]);
    } finally {
      vmStopped = true;
      for (const socket of serverSockets) socket.destroy();
      for (const handle of vmTimers) clearTimeout(handle);
      vmTimers.clear();
      await api.close().catch(() => undefined);
      const resolvedDataRoot = resolve(dataRoot);
      const tempPrefix = resolve(tmpdir()) + '\\';
      assert.ok(resolvedDataRoot.startsWith(tempPrefix), 'cleanup remains under OS temp root');
      await rm(resolvedDataRoot, { recursive: true, force: true });
      void sockets;
      void port;
    }
  });

test('扩展桥接丢失响应、JSON 截断与发送后取消均按 UNKNOWN 隔离页面，重读后恢复',
  async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'relay-browser-uncertain-'));
    const token = 'b'.repeat(64);
    await mkdir(join(dataRoot, 'browser'), { recursive: true });
    await writeFile(join(dataRoot, 'browser', 'bridge.json'),
      JSON.stringify({ port: 65500, token }), { encoding: 'utf8' });
    const origin: GatewayOrigin = { kind: 'RUN', runId: 'run-uncertain', stepId: 'step-1',
      resourceId: 'resource-1', workerId: 'worker-1', workerEpoch: 1n };
    const db = { executeQuery: () => { throw new Error('no database in unit test'); } } as
      unknown as DbExecutor;
    let mode: 'network' | 'truncated' | 'cancel' | 'ok' = 'ok';
    let clickCalls = 0;
    let effectMayHaveOccurred = false;
    let pageExists = false;
    const response = (body: unknown): Response => new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
    const provider = new ExtensionBridgeProvider({ dataRoot, fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { op: string };
      if (body.op === 'list_pages') {
        return response({ ok: true, result: { pages: pageExists ? [{ pageId: 41,
          url: 'https://fixture.invalid/', title: 'Fixture' }] : [] }, extensionVersion: 'test' });
      }
      if (body.op === 'new_page') {
        pageExists = true;
        return response({ ok: true, result: { pageId: 41,
          url: 'https://fixture.invalid/', title: 'Fixture' }, extensionVersion: 'test' });
      }
      if (body.op === 'read_page') {
        return response({ ok: true, result: { text:
          'uid=1_0 RootWebArea url="https://fixture.invalid/"',
        url: 'https://fixture.invalid/', title: 'Fixture' }, extensionVersion: 'test' });
      }
      if (body.op === 'click') {
        clickCalls += 1;
        if (mode === 'network') {
          effectMayHaveOccurred = true;
          throw new TypeError('socket reset after API accepted command');
        }
        if (mode === 'truncated') {
          effectMayHaveOccurred = true;
          return { status: 200, json: async () => { throw new SyntaxError('truncated JSON'); } } as
            unknown as Response;
        }
        if (mode === 'cancel') {
          effectMayHaveOccurred = true;
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted after API accepted command', 'AbortError')),
            { once: true });
          });
        }
        return response({ ok: true, result: { text:
          'uid=1_0 RootWebArea url="https://fixture.invalid/"',
        url: 'https://fixture.invalid/', title: 'Fixture' }, extensionVersion: 'test' });
      }
      throw new Error(`unexpected operation ${body.op}`);
    } });
    const manager = new BrowserSessionManager({ dataRoot, provider });
    const previous = replaceBrowserSessionManagerForTest(manager);
    const run = (actionType: string, params: JsonObject, signal?: AbortSignal) =>
      browserExecute({ db, actionType, params, origin,
        ...(signal === undefined ? {} : { signal }) });

    try {
      const created = await run('BROWSER_NEW_PAGE', { url: 'https://fixture.invalid/' });
      assert.equal(created.outcome, 'SUCCEEDED');
      const pageId = String(created.result.page_id);

      mode = 'network';
      const disconnected = await run('BROWSER_CLICK', { page_id: pageId, uid: '1_4' });
      assert.equal(disconnected.outcome, 'UNKNOWN');
      assert.equal(disconnected.result.reason, 'BROWSER_EFFECT_UNCERTAIN');
      assert.equal(effectMayHaveOccurred, true);
      assert.equal((await run('BROWSER_CLICK', { page_id: pageId, uid: '1_4' })).result.reason,
        'BROWSER_PAGE_STALE');
      assert.equal(clickCalls, 1, 'STALE must prevent a blind second click');
      assert.equal((await run('BROWSER_READ_PAGE', { page_id: pageId })).outcome, 'SUCCEEDED');

      mode = 'truncated';
      const malformed = await run('BROWSER_CLICK', { page_id: pageId, uid: '1_4' });
      assert.equal(malformed.outcome, 'UNKNOWN');
      assert.equal(malformed.result.reason, 'BROWSER_EFFECT_UNCERTAIN');
      assert.equal((await run('BROWSER_CLICK', { page_id: pageId, uid: '1_4' })).result.reason,
        'BROWSER_PAGE_STALE');
      assert.equal(clickCalls, 2, 'malformed response must also prevent a blind retry');
      assert.equal((await run('BROWSER_READ_PAGE', { page_id: pageId })).outcome, 'SUCCEEDED');

      mode = 'cancel';
      const controller = new AbortController();
      const pending = run('BROWSER_CLICK', { page_id: pageId, uid: '1_4' }, controller.signal);
      setTimeout(() => controller.abort(), 0);
      const cancelled = await pending;
      assert.equal(cancelled.outcome, 'UNKNOWN');
      assert.equal(cancelled.result.reason, 'BROWSER_EFFECT_UNCERTAIN');
      assert.equal(effectMayHaveOccurred, true);
      assert.equal((await run('BROWSER_CLICK', { page_id: pageId, uid: '1_4' })).result.reason,
        'BROWSER_PAGE_STALE');
      assert.equal(clickCalls, 3, 'in-flight cancellation must prevent a blind retry');
      assert.equal((await run('BROWSER_READ_PAGE', { page_id: pageId })).outcome, 'SUCCEEDED');

      mode = 'ok';
      assert.equal((await run('BROWSER_CLICK', { page_id: pageId, uid: '1_4' })).outcome,
        'SUCCEEDED', 'fresh read restores writes after state reconciliation');
    } finally {
      replaceBrowserSessionManagerForTest(previous);
      await manager.dispose();
      const resolvedDataRoot = resolve(dataRoot);
      const tempPrefix = resolve(tmpdir()) + '\\';
      assert.ok(resolvedDataRoot.startsWith(tempPrefix), 'cleanup remains under OS temp root');
      await rm(resolvedDataRoot, { recursive: true, force: true });
    }
  });

test('桥接文件晚于 Provider 构造落盘时仍能连上：不缓存「没有桥接」', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'relay-browser-registration-'));
  const token = 'd'.repeat(64);
  const provider = new ExtensionBridgeProvider({ dataRoot, fetchImpl: async () => new Response(
    JSON.stringify({ ok: true, result: { pages: [] }, extensionVersion: 'test' }),
    { status: 200, headers: { 'content-type': 'application/json' } }) });
  try {
    const before = await provider.ensureStarted();
    assert.equal(before.status, 'BACKEND_MISSING', '文件还没写时如实报告缺桥接');
    // API 稍后写入 bridge.json（启动顺序或重新注册）：下一次探测必须能读到它。
    await mkdir(join(dataRoot, 'browser'), { recursive: true });
    await writeFile(join(dataRoot, 'browser', 'bridge.json'),
      JSON.stringify({ port: 65500, token }), { encoding: 'utf8' });
    const after = await provider.ensureStarted();
    assert.equal(after.status, 'READY',
      '把 null 也缓存下来会让「当时还没写」变成「永远没有桥接」，只能重启进程才恢复');
  } finally {
    await provider.dispose();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('扩展断开后下一次探测立即降级，不沿用缓存的 READY', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'relay-browser-health-cache-'));
  let reachable = true;
  const provider = new ExtensionBridgeProvider({ dataRoot, fetchImpl: async () => reachable
    ? new Response(JSON.stringify({ ok: true, result: { pages: [] }, extensionVersion: 'test' }),
      { status: 200, headers: { 'content-type': 'application/json' } })
    : new Response(JSON.stringify({ code: 'BROWSER_EXTENSION_MISSING',
      detail: '浏览器扩展未连接。' }),
    { status: 503, headers: { 'content-type': 'application/json' } }) });
  try {
    await mkdir(join(dataRoot, 'browser'), { recursive: true });
    await writeFile(join(dataRoot, 'browser', 'bridge.json'),
      JSON.stringify({ port: 65500, token: 'b'.repeat(64) }));
    assert.equal((await provider.ensureStarted()).status, 'READY');
    reachable = false;
    assert.equal((await provider.ensureStarted()).status, 'DISCONNECTED',
      '扩展断开后不能继续沿用上一次的 READY');
    reachable = true;
    assert.equal((await provider.ensureStarted()).status, 'READY');
  } finally {
    await provider.dispose();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('桥接单帧上限按 UTF-8 字节而非 JS 码元：多字节参数超限即拒绝', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'relay-bridge-frame-limit-'));
  const api = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });
  const token = 'e'.repeat(64);
  const sockets: WebSocket[] = [];
  try {
    registerBridgeUpgrade(api.server, { dataRoot, token });
    api.register(async (scope) => {
      registerBrowserBridgeCommandRoutes(scope, { database: {} as never, bridgeToken: token });
    }, { prefix: '/api/v1' });
    await withTimeout(api.listen({ host: '127.0.0.1', port: 0 }), 3_000, 'Fastify listen');
    const address = api.server.address();
    assert.ok(address !== null && typeof address === 'object');
    const port = address.port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/browser-bridge`);
    sockets.push(socket);
    await withTimeout(new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('WebSocket failed before open')),
        { once: true });
    }), 2_000, 'WebSocket open');
    const ready = new Promise<void>((resolve) => {
      socket.addEventListener('message', (event) => {
        const frame = JSON.parse(String(event.data)) as { type?: unknown };
        if (frame.type === 'ready') resolve();
      });
    });
    socket.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL, token,
      extensionVersion: 'frame-limit-test' }));
    await withTimeout(ready, 2_000, 'bridge ready');
    let commands = 0;
    socket.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data)) as { type?: unknown };
      if (frame.type === 'cmd') commands += 1;
    });
    // 1.4M 个中文字符 = 1.4M 码元（低于 4MiB 上限）但 UTF-8 为 4.2MB（超过上限）。
    const response = await fetch(
      `http://127.0.0.1:${port}/api/v1/browser-bridge/commands`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-token': token },
        body: JSON.stringify({ op: 'fill', params: { text: '中'.repeat(1_400_000) } }),
      });
    assert.equal(response.status, 502);
    assert.equal((await response.json() as { code?: string }).code, 'BROWSER_INVALID_REQUEST');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(commands, 0, '超限帧不应发给扩展');
  } finally {
    for (const socket of sockets) socket.close();
    await api.close().catch(() => undefined);
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('桥接文件写实际绑定端口，且重写不换令牌', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'relay-bridge-port-'));
  const file = join(dataRoot, 'browser', 'bridge.json');
  try {
    // listen 之前只能写请求端口：桌面端用临时端口，这里就是 0。
    const requested = await ensureBridgeRegistration(dataRoot, 0);
    assert.equal(requested.port, 0);

    const bound = await syncBridgePort(dataRoot, 0, 5157);
    assert.equal(bound, 5157);
    const written = JSON.parse(await readFile(file, 'utf8')) as
      { port?: number; token?: string; protocol?: string };
    assert.equal(written.port, 5157, '扩展照着这个端口连；写 0 会让它永远连不上');
    assert.equal(written.token, requested.token,
      '重写必须沿用原令牌：换掉会让已连上的扩展被服务端判为非法');
    assert.equal(written.protocol, 'relay-browser-bridge-v1');

    // 端口没变就不必再写一遍。
    const again = await syncBridgePort(dataRoot, 5157, 5157);
    assert.equal(again, 5157);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), written);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});
