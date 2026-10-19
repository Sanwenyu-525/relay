/**
 * 扩展命令层的定向测试（F26 默认扩展路线）。
 *
 * 受验对象是**真实的** `apps/browser-extension/background.js`：在 VM 里跑起来，
 * 用一个假 `chrome`（tabs + debugger）承接 CDP 调用，用假 WebSocket 收发桥接帧。
 *
 * 覆盖三件改前做不到的事：
 *   1. 导航能等到 load 事件（`chrome.debugger.onEvent` 的监听签名是 (source, method)，
 *      写错时只能等满超时）；
 *   2. 后退/前进/刷新走浏览器自己的历史，而不是拿新 URL 假装后退；
 *   3. 双击真的发出两组 clickCount（只改 clickCount 不补序列，页面收不到 dblclick）；
 *   4. 截图的尺寸与 SHA-256 由扩展从 PNG 字节算出，Relay 侧不必再解图。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const PROTOCOL = 'relay-browser-bridge-v1';
const TOKEN = 'c'.repeat(64);
const SERVER_URL = 'http://127.0.0.1:9';
const TAB_ID = 900;

/** 1×1 透明 PNG：用来核对 IHDR 解析与摘要。 */
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/' +
  'q842iQAAAABJRU5ErkJggg==';

/** 真实 CDP 的形状：扁平 nodes + childIds（不是嵌套 nodes）。 */
const AX_TREE = {
  nodes: [
    { nodeId: 1, role: { value: 'RootWebArea' }, name: { value: 'Fixture' },
      value: 'https://fixture.invalid/', childIds: ['2', '3'] },
    { nodeId: 2, role: { value: 'button' }, name: { value: '提交' },
      backendDOMNodeId: 2, parentId: '1' },
    { nodeId: 3, role: { value: 'textbox' }, name: { value: '邮箱' },
      backendDOMNodeId: 3, parentId: '1' },
  ],
};

/** chrome-devtools-mcp 的形状：嵌套 nodes。两种形状 Relay 侧都要能读。 */
const AX_TREE_NESTED = {
  nodes: [
    { nodeId: 1, role: { value: 'RootWebArea' }, name: { value: 'Fixture' },
      value: 'https://fixture.invalid/', nodes: [
        { nodeId: 2, role: { value: 'button' }, name: { value: '提交' },
          backendDOMNodeId: 2 },
      ] },
  ],
};

interface CdpCall { readonly method: string; readonly params: Record<string, unknown> }

class FakeWebSocket {
  static readonly OPEN = 1;
  readonly sent: Record<string, unknown>[] = [];
  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { queueMicrotask(() => this.onopen?.()); }
  send(data: string): void { this.sent.push(JSON.parse(data) as Record<string, unknown>); }
  close(): void { this.readyState = 3; this.onclose?.(); }
}

interface Harness {
  readonly socket: FakeWebSocket;
  readonly cdpCalls: CdpCall[];
  /** 扩展实际创建的闹钟（名字 + 参数）；保活靠它唤醒被回收的 worker。 */
  readonly alarmsCreated: { readonly name: string; readonly periodInMinutes?: number }[];
  /** 当前建立的桥接连接数：闹钟唤醒后重连会新增一条。 */
  socketCount(): number;
  /** 触发一次闹钟回调，模拟 Chrome 唤醒被回收的 service worker。 */
  fireAlarm(name: string): void;
  command(op: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** 建一个属于 Agent 的页并返回它的 pageId（后续动作只能作用在自有页上）。 */
  createPage(): Promise<number>;
}

async function loadExtension(): Promise<string> {
  const entry = process.env.RELAY_BROWSER_EXTENSION_ENTRY ??
    resolve(process.cwd(), '../browser-extension/background.js');
  return await readFile(entry, 'utf8');
}

/** 把真实扩展脚本跑进 VM，并把 CDP 调用记录在案。 */
async function startHarness(options: {
  readonly history?: { readonly currentIndex: number; readonly entries: readonly { id: number }[] };
  readonly navigate?: Record<string, unknown>;
  readonly axTree?: unknown;
  readonly historyEvent?: string;
} = {}): Promise<Harness> {
  const source = await loadExtension();
  const owned: Record<string, unknown> = {};
  const tabs = new Map<number, { id: number; url: string; title: string; active: boolean }>();
  let nextTabId = TAB_ID;
  const cdpCalls: CdpCall[] = [];
  const eventListeners = new Set<(source: unknown, method: string, params?: unknown) => void>();
  const emit = (tabId: number, method: string, params?: unknown): void => {
    for (const listener of [...eventListeners]) listener({ tabId }, method, params);
  };
  const chrome = {
    storage: {
      local: { get: async (): Promise<Record<string, unknown>> =>
        ({ serverUrl: SERVER_URL, token: TOKEN }) },
      session: {
        get: async (key: string): Promise<Record<string, unknown>> => ({ [key]: owned[key] ?? [] }),
        set: async (values: Record<string, unknown>): Promise<void> => { Object.assign(owned, values); },
      },
      onChanged: { addListener: (): void => undefined },
    },
    runtime: {
      lastError: undefined as { message: string } | undefined,
      getManifest: (): { version: string } => ({ version: '0.2.0' }),
      getURL: (path: string): string => `chrome-extension://relay-test/${path}`,
      onStartup: { addListener: (): void => undefined },
      onInstalled: { addListener: (): void => undefined },
    },
    alarms: {
      created: [] as { name: string; periodInMinutes?: number }[],
      listeners: new Set<(alarm: { name: string }) => void>(),
      create(name: string, info: { periodInMinutes?: number }): void {
        chrome.alarms.created.push({ name, ...(info ?? {}) });
      },
      onAlarm: {
        addListener: (listener: (alarm: { name: string }) => void): void => {
          chrome.alarms.listeners.add(listener);
        },
      },
    },
    tabs: {
      onRemoved: { addListener: (): void => undefined },
      query: async (): Promise<unknown[]> => [...tabs.values()],
      create: (input: { url: string; active: boolean },
        callback: (tab: unknown) => void): void => {
        const tab = { id: (nextTabId += 1), url: input.url, title: 'Agent page',
          active: input.active };
        tabs.set(tab.id, tab);
        callback(tab);
      },
      get: (tabId: number, callback: (tab: unknown) => void): void => {
        callback(tabs.get(tabId));
      },
      remove: (tabId: number, callback: () => void): void => { tabs.delete(tabId); callback(); },
    },
    debugger: {
      attach: (_target: unknown, _version: string, callback: () => void): void => callback(),
      onDetach: { addListener: (): void => undefined },
      onEvent: {
        addListener: (listener: (source: unknown, method: string, params?: unknown) => void): void => {
          eventListeners.add(listener);
        },
        removeListener: (listener: (source: unknown, method: string, params?: unknown) => void): void => {
          eventListeners.delete(listener);
        },
      },
      sendCommand: (target: { tabId?: number }, method: string,
        params: Record<string, unknown>, callback: (result: unknown) => void): void => {
        const tabId = typeof target?.tabId === 'number' ? target.tabId : TAB_ID;
        cdpCalls.push({ method, params: params ?? {} });
        switch (method) {
          case 'Page.enable':
          case 'DOM.enable':
            callback({});
            return;
          case 'Accessibility.getFullAXTree':
            callback(options.axTree ?? AX_TREE);
            return;
          case 'Page.navigate':
            setTimeout(() => emit(tabId, 'Page.loadEventFired'), 0);
            callback(options.navigate ?? { loaderId: 'loader-1' });
            return;
          case 'Page.getNavigationHistory':
            callback(options.history ?? { currentIndex: 1,
              entries: [{ id: 11 }, { id: 12 }, { id: 13 }] });
            return;
          case 'Page.navigateToHistoryEntry':
            setTimeout(() => emit(tabId, options.historyEvent ?? 'Page.loadEventFired'), 0);
            callback({});
            return;
          case 'Page.reload':
            setTimeout(() => emit(tabId, 'Page.loadEventFired'), 0);
            callback({});
            return;
          case 'DOM.resolveNode':
            callback({ object: { objectId: 'object-1' } });
            return;
          case 'Runtime.callFunctionOn': {
            const declaration = String(params.functionDeclaration ?? '');
            callback(declaration.includes('getBoundingClientRect')
              ? { result: { value: JSON.stringify({ x: 30, y: 40, w: 10, h: 10 }) } }
              : {});
            return;
          }
          case 'Runtime.evaluate':
            callback({ result: { value: 'complete' } });
            return;
          case 'Page.captureScreenshot':
            callback({ data: PNG_1X1 });
            return;
          case 'Page.startScreencast':
            emit(tabId, 'Page.screencastFrame', { data: PNG_1X1, sessionId: 1 });
            callback({});
            return;
          default:
            callback({});
        }
      },
    },
  };

  const sockets: FakeWebSocket[] = [];
  const Fake = class extends FakeWebSocket {
    constructor(url: string) { super(url); sockets.push(this); }
  };
  runInNewContext(source, {
    chrome, WebSocket: Fake, URL, crypto: globalThis.crypto, atob,
    navigator: { userAgent: 'Relay ops test' }, setTimeout, clearTimeout,
  }, { filename: 'apps/browser-extension/background.js' });

  // connect() 是异步的：等 hello 真正发出去之后再收命令。
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (sockets[0]?.sent.some((frame) => frame.type === 'hello')) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const socket = sockets[0];
  assert.ok(socket !== undefined, '扩展必须建立桥接连接');
  assert.equal(socket.sent[0]?.protocol, PROTOCOL);

  let nextId = 0;
  const command = async (op: string, params: Record<string, unknown>):
  Promise<Record<string, unknown>> => {
    const id = `cmd-${nextId += 1}`;
    socket.onmessage?.({ data: JSON.stringify({ type: 'cmd', id, op, params }) });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const reply = socket.sent.find((frame) => frame.type === 'result' && frame.id === id);
      if (reply !== undefined) return reply;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`命令 ${op} 没有返回结果`);
  };
  return { socket, cdpCalls,
    alarmsCreated: chrome.alarms.created,
    socketCount: () => sockets.length,
    fireAlarm(name: string): void {
      for (const listener of [...chrome.alarms.listeners]) listener({ name });
    },
    command,
    async createPage(): Promise<number> {
      const reply = await command('new_page', { url: 'https://fixture.invalid/' });
      assert.equal(reply.ok, true, JSON.stringify(reply));
      const pageId = (reply.result as Record<string, unknown>).pageId;
      assert.equal(typeof pageId, 'number');
      return pageId as number;
    } };
}

test('导航等到 load 事件才返回：监听签名必须是 (source, method)', async () => {
  const harness = await startHarness();
  const pageId = await harness.createPage();
  const started = Date.now();
  const reply = await harness.command('navigate', { pageId, url: 'https://fixture.invalid/next',
    timeoutMs: 5_000 });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.ok(Date.now() - started < 3_000, '不能等到超时才算完成');
  const result = reply.result as Record<string, unknown>;
  assert.equal(result.title, 'Agent page');
  assert.match(String(result.text), /uid=1 RootWebArea/u);
  assert.match(String(result.text), /uid=2 button "提交"/u, '扁平 AX 树的子节点必须出现在快照里');
});

test('嵌套形状的 AX 树同样能读（换后端不会只剩根节点）', async () => {
  const harness = await startHarness({ axTree: AX_TREE_NESTED });
  const pageId = await harness.createPage();
  const reply = await harness.command('read_page', { pageId });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  const text = String((reply.result as Record<string, unknown>).text);
  assert.match(text, /uid=1 RootWebArea/u);
  assert.match(text, /uid=2 button "提交"/u);
});

test('同文档历史导航等待 navigatedWithinDocument，不空等 loadEventFired', async () => {
  const harness = await startHarness({ historyEvent: 'Page.navigatedWithinDocument' });
  const pageId = await harness.createPage();
  for (const direction of ['back', 'forward']) {
    const reply = await harness.command('history', { pageId, direction, timeoutMs: 200 });
    assert.equal(reply.ok, true, JSON.stringify(reply));
  }
});

test('忽略的结构节点仍遍历子节点，正文与输入框不会随包装节点消失', async () => {
  const harness = await startHarness({ axTree: { nodes: [
    { nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2'] },
    { nodeId: '2', ignored: true, role: { value: 'none' }, childIds: ['3'] },
    { nodeId: '3', role: { value: 'textbox' }, name: { value: 'Acceptance marker' } },
  ] } });
  const pageId = await harness.createPage();
  const reply = await harness.command('read_page', { pageId });
  assert.match(String((reply.result as Record<string, unknown>).text),
    /uid=3 textbox "Acceptance marker"/u);
});

test('导航失败写在 errorText 里时要变成类型化拒绝，而不是等超时', async () => {
  const harness = await startHarness({ navigate: { errorText: 'net::ERR_NAME_NOT_RESOLVED' } });
  const pageId = await harness.createPage();
  const reply = await harness.command('navigate', { pageId, url: 'https://nope.invalid/',
    timeoutMs: 5_000 });
  assert.equal(reply.ok, false);
  assert.equal((reply.error as Record<string, unknown>).code, 'BROWSER_NAVIGATION_BLOCKED');
});

test('后退/前进走 Page.navigateToHistoryEntry，边界给出类型化拒绝', async () => {
  const harness = await startHarness();
  const pageId = await harness.createPage();
  const back = await harness.command('history', { pageId, direction: 'back',
    timeoutMs: 5_000 });
  assert.equal(back.ok, true, JSON.stringify(back));
  const jump = harness.cdpCalls.find((call) => call.method === 'Page.navigateToHistoryEntry');
  assert.equal(jump?.params.entryId, 11, 'currentIndex=1 的后一条是 entries[0]');

  const reload = await harness.command('history', { pageId, direction: 'reload',
    timeoutMs: 5_000 });
  assert.equal(reload.ok, true, JSON.stringify(reload));
  assert.ok(harness.cdpCalls.some((call) => call.method === 'Page.reload'));

  // 已经在最新一页时前进必须拒绝，不能悄悄跳去别处。
  const edge = await startHarness({ history: { currentIndex: 2,
    entries: [{ id: 11 }, { id: 12 }, { id: 13 }] } });
  const edgePage = await edge.createPage();
  const forward = await edge.command('history', { pageId: edgePage, direction: 'forward',
    timeoutMs: 5_000 });
  assert.equal(forward.ok, false);
  assert.equal((forward.error as Record<string, unknown>).code, 'BROWSER_INVALID_REQUEST');
  assert.equal(edge.cdpCalls.some((call) => call.method === 'Page.navigateToHistoryEntry'), false);

  const unknown = await harness.command('history', { pageId, direction: 'sideways' });
  assert.equal(unknown.ok, false);
  assert.equal((unknown.error as Record<string, unknown>).code, 'BROWSER_INVALID_REQUEST');
});

test('双击发出两组 clickCount，单击仍只有一组', async () => {
  const harness = await startHarness();
  const pageId = await harness.createPage();
  const double = await harness.command('click', { pageId, uid: '2', double: true });
  assert.equal(double.ok, true, JSON.stringify(double));
  const focusIndex = harness.cdpCalls.findIndex((call) =>
    call.method === 'Emulation.setFocusEmulationEnabled' && call.params.enabled === true);
  const mouseIndex = harness.cdpCalls.findIndex((call) => call.method === 'Input.dispatchMouseEvent');
  assert.ok(focusIndex >= 0 && focusIndex < mouseIndex,
    '后台页须在派发鼠标事件前启用页面焦点模拟，不能激活用户标签页');
  const restoreIndex = harness.cdpCalls.findIndex((call) =>
    call.method === 'Emulation.setFocusEmulationEnabled' && call.params.enabled === false);
  const lastMouseIndex = harness.cdpCalls.findLastIndex((call) => call.method === 'Input.dispatchMouseEvent');
  assert.ok(restoreIndex > lastMouseIndex, '点击结束后必须恢复文档焦点模拟');
  const events = harness.cdpCalls.filter((call) => call.method === 'Input.dispatchMouseEvent')
    .map((call) => `${String(call.params.type)}:${String(call.params.clickCount)}`);
  assert.deepEqual(events, ['mousePressed:1', 'mouseReleased:1', 'mousePressed:2', 'mouseReleased:2']);

  const single = await startHarness();
  const singlePage = await single.createPage();
  await single.command('click', { pageId: singlePage, uid: '2' });
  const singeEvents = single.cdpCalls.filter((call) => call.method === 'Input.dispatchMouseEvent')
    .map((call) => `${String(call.params.type)}:${String(call.params.clickCount)}`);
  assert.deepEqual(singeEvents, ['mousePressed:1', 'mouseReleased:1']);
});

test('截图的宽高与摘要由扩展从 PNG 字节算出', async () => {
  const harness = await startHarness();
  const pageId = await harness.createPage();
  const reply = await harness.command('screenshot', { pageId });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  const result = reply.result as Record<string, unknown>;
  assert.equal(result.width, 1);
  assert.equal(result.height, 1);
  const expected = createHash('sha256').update(Buffer.from(PNG_1X1, 'base64')).digest('hex');
  assert.equal(result.sha256, expected);
  assert.equal(result.bytes, Buffer.from(PNG_1X1, 'base64').length);
  assert.equal(result.mimeType, 'image/png');
  assert.deepEqual(harness.cdpCalls.filter((call) => call.method.includes('Screencast'))
    .map((call) => call.method),
  ['Page.startScreencast', 'Page.stopScreencast']);
  assert.ok(harness.cdpCalls.some((call) => call.method === 'Page.screencastFrameAck' &&
    call.params.sessionId === 1), '单帧收到后须确认并停止捕获');
});

test('旧 uid 在页面变化后是类型化失败，不会重复点击', async () => {
  const harness = await startHarness();
  const pageId = await harness.createPage();
  const reply = await harness.command('click', { pageId, uid: '9999' });
  assert.equal(reply.ok, false);
  assert.equal((reply.error as Record<string, unknown>).code, 'BROWSER_ELEMENT_NOT_FOUND');
  assert.equal(harness.cdpCalls.some((call) => call.method === 'Input.dispatchMouseEvent'), false);
});

test('页面所有权闸门仍在：不属于 Agent 的页一律拒绝', async () => {
  const harness = await startHarness();
  const reply = await harness.command('read_page', { pageId: TAB_ID });
  assert.equal(reply.ok, false);
  assert.equal((reply.error as Record<string, unknown>).code, 'BROWSER_PAGE_NOT_OWNED');
});

/* —— 空闲保活：MV3 的 worker 不会自己醒来 ————————————————————— */

test('manifest 声明 alarms 权限：保活是唯一不依赖用户动作的唤醒源', async () => {
  const manifest = JSON.parse(await readFile(
    resolve(process.cwd(), '../browser-extension/manifest.json'), 'utf8')) as
    { permissions?: string[]; background?: { service_worker?: string } };
  assert.ok(Array.isArray(manifest.permissions));
  assert.ok(manifest.permissions.includes('alarms'),
    '没有 alarms 权限时 chrome.alarms 不可用，空闲后桥接无法自行恢复');
  assert.equal(manifest.background?.service_worker, 'background.js',
    '权限与保活代码必须落在同一个随包 worker 上');
});

test('扩展注册周期闹钟并挂上唤醒回调', async () => {
  const harness = await startHarness();
  const keepalive = harness.alarmsCreated.find((alarm) => alarm.name === 'relay.keepalive');
  assert.ok(keepalive !== undefined, `必须注册保活闹钟，实际：${JSON.stringify(harness.alarmsCreated)}`);
  assert.equal(typeof keepalive.periodInMinutes, 'number');
  assert.ok((keepalive.periodInMinutes ?? 0) > 0 && (keepalive.periodInMinutes ?? 1) <= 1,
    '周期必须是有界正值（Chrome 120+ 最小 0.5 分钟，更早版本钳到 1 分钟）');
});

test('worker 被回收后由闹钟重建桥接，而不是等用户碰 Chrome', async () => {
  const harness = await startHarness();
  assert.equal(harness.socketCount(), 1);
  // 模拟 worker 被终止：连接连同退避定时器一起消失，onclose 里的重连不会执行。
  harness.socket.close();
  harness.fireAlarm('relay.keepalive');
  // 退避重连要等 1000ms 才触发；这里在它之前就必须已经连上，否则证明走的是闹钟。
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (harness.socketCount() > 1) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(harness.socketCount(), 2, '闹钟必须立刻重建一条连接');
});

test('连接正常时闹钟不重建连接：唤醒不等于重连', async () => {
  const harness = await startHarness();
  assert.equal(harness.socketCount(), 1);
  harness.fireAlarm('relay.keepalive');
  harness.fireAlarm('relay.keepalive');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(harness.socketCount(), 1, '握手期间的重复闹钟不得再建一条连接');
});

test('读页面带加载状态：readyState 由扩展从 document.readyState 取', async () => {
  const harness = await startHarness();
  const pageId = await harness.createPage();
  const reply = await harness.command('read_page', { pageId });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.equal((reply.result as Record<string, unknown>).readyState, 'complete',
    '只读快照正文分不出「页面就这些」和「还没渲染完」，加载状态必须一并返回');
  assert.ok(harness.cdpCalls.some((call) => call.method === 'Runtime.evaluate' &&
    call.params.expression === 'document.readyState'));
});
