/**
 * Relay 浏览器桥接扩展（Manifest V3 service worker）。
 *
 * 职责只有三个：
 *   1. 维持一条到 Relay API 的**本机** WebSocket（带令牌认证与指数退避重连）；
 *   2. 把 Relay 的页面操作命令翻译成 chrome.debugger / chrome.tabs 调用；
 *   3. 强制"Agent 专属标签页"：只操作自己创建的页，其余一律拒绝。
 *
 * 不做的事（这是可审计的硬边界，不是运行时检查）：
 *   * 代码里没有 chrome.tabs.update({active:true}) / chrome.windows.update({focused:true})
 *     ——Agent 永远不会把标签页切到前台，也不会碰窗口焦点；
 *   * 代码里没有 system.mouse / system.keyboard —— 全部走 chrome.debugger 的页面级输入；
 *   * 不会把 Cookie、密码或整页 HTML 上报——结果只含任务所需的摘要。
 */

const PROTOCOL_VERSION = 'relay-browser-bridge-v1';

/** Agent 专属标签页登记：service worker 可能被回收，用 session storage 持久化。 */
const OWNED_TABS_KEY = 'relay.ownedTabs';

/** debugger 附着是按标签页的；重连后要重新 attach。 */
const attached = new Map();

let socket = null;
let backoffMs = 1000;
let reconnectTimer = null;
let seq = 0;

function ownedTabs() {
  return chrome.storage.session.get(OWNED_TABS_KEY).then((data) =>
    new Set(Array.isArray(data[OWNED_TABS_KEY]) ? data[OWNED_TABS_KEY] : []));
}

async function addOwnedTab(tabId) {
  const tabs = await ownedTabs();
  tabs.add(tabId);
  await chrome.storage.session.set({ [OWNED_TABS_KEY]: [...tabs] });
}

async function dropOwnedTab(tabId) {
  const tabs = await ownedTabs();
  tabs.delete(tabId);
  await chrome.storage.session.set({ [OWNED_TABS_KEY]: [...tabs] });
}

/** 随包配置（开发/自动化冒烟用）：扩展目录里的 config.json。生产分发不带它。 */
let bundledConfig = null;

async function bundled() {
  if (bundledConfig !== null) return bundledConfig;
  try {
    const response = await fetch(chrome.runtime.getURL('config.json'));
    if (!response.ok) { bundledConfig = {}; return bundledConfig; }
    const parsed = await response.json();
    bundledConfig = {
      serverUrl: typeof parsed.serverUrl === 'string' ? parsed.serverUrl : '',
      token: typeof parsed.token === 'string' ? parsed.token : '',
    };
  } catch { bundledConfig = {}; }
  return bundledConfig;
}

async function config() {
  const data = await chrome.storage.local.get(['serverUrl', 'token']);
  const stored = {
    serverUrl: typeof data.serverUrl === 'string' ? data.serverUrl.replace(/\/+$/, '') : '',
    token: typeof data.token === 'string' ? data.token : '',
  };
  if (stored.serverUrl !== '' && stored.token !== '') return stored;
  const bundled0 = await bundled();
  return {
    serverUrl: stored.serverUrl !== '' ? stored.serverUrl : bundled0.serverUrl,
    token: stored.token !== '' ? stored.token : bundled0.token,
  };
}

function bridgeUrl(serverUrl) {
  const url = new URL(serverUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Relay API 地址必须使用 HTTP 或 HTTPS。');
  }
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/api/v1/browser-bridge';
  url.search = '';
  url.hash = '';
  return url.toString();
}

// ---------------------------------------------------------------------------
// WebSocket 生命周期
// ---------------------------------------------------------------------------

async function connect() {
  if (socket !== null) return;
  const cfg = await config();
  if (cfg.serverUrl === '' || cfg.token === '') {
    scheduleReconnect();
    return;
  }
  try {
    socket = new WebSocket(bridgeUrl(cfg.serverUrl));
  } catch {
    socket = null;
    scheduleReconnect();
    return;
  }
  socket.onopen = () => {
    backoffMs = 1000;
    send({ type: 'hello', protocol: PROTOCOL_VERSION,
      token: cfg.token,
      extensionVersion: chrome.runtime.getManifest().version,
      userAgent: navigator.userAgent });
  };
  socket.onmessage = (event) => {
    void handleFrame(event.data);
  };
  socket.onclose = () => {
    socket = null;
    scheduleReconnect();
  };
  socket.onerror = () => { /* close 会跟着来，交给 onclose */ };
}

function send(message) {
  if (socket === null || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function scheduleReconnect() {
  if (reconnectTimer !== null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, backoffMs);
  backoffMs = Math.min(backoffMs * 2, 30_000);
}

async function handleFrame(raw) {
  let frame;
  try { frame = JSON.parse(String(raw)); } catch { return; }
  if (frame === null || typeof frame !== 'object') return;
  if (frame.type !== 'cmd' || typeof frame.id !== 'string' || typeof frame.op !== 'string') return;
  const params = typeof frame.params === 'object' && frame.params !== null ? frame.params : {};
  let reply;
  try {
    const result = await runOp(frame.op, params);
    reply = { type: 'result', id: frame.id, ok: true, result };
  } catch (error) {
    reply = {
      type: 'result', id: frame.id, ok: false,
      error: {
        code: error instanceof BridgeError ? error.code : 'BROWSER_ACTION_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
  send(reply);
}

class BridgeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// ---------------------------------------------------------------------------
// 标签页所有权：这是扩展侧的第二道闸（第一道在 Relay 的会话管理器里）
// ---------------------------------------------------------------------------

async function ownedTab(tabIdNumber) {
  const tabId = Number(tabIdNumber);
  if (!Number.isInteger(tabId) || tabId <= 0) {
    throw new BridgeError('BROWSER_PAGE_NOT_FOUND', `page_id 非法：${String(tabIdNumber)}`);
  }
  const tabs = await ownedTabs();
  if (!tabs.has(tabId)) {
    throw new BridgeError('BROWSER_PAGE_NOT_OWNED',
      `标签页 ${tabId} 不属于 Agent（可能是用户自己打开的页），不会对它执行操作。`);
  }
  const exists = await new Promise((resolve) => {
    chrome.tabs.get(tabId, () => resolve(chrome.runtime.lastError === undefined));
  });
  if (!exists) {
    await dropOwnedTab(tabId);
    throw new BridgeError('BROWSER_PAGE_NOT_FOUND',
      `标签页 ${tabId} 已不存在（可能被关闭）；请重新建页。`);
  }
  return tabId;
}

async function toPageRef(tab) {
  return { pageId: tab.id, url: tab.url ?? '', title: tab.title ?? '',
    active: tab.active === true };
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void dropOwnedTab(tabId);
  const target = attached.get(tabId);
  if (target !== undefined) attached.delete(tabId);
});

// ---------------------------------------------------------------------------
// chrome.debugger 附着与 CDP 调用
// ---------------------------------------------------------------------------

async function attach(tabId) {
  const known = attached.get(tabId);
  if (known === true) return tabId;
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      const error = chrome.runtime.lastError;
      if (error === undefined) resolve();
      else reject(new BridgeError('BROWSER_BACKEND_UNAVAILABLE',
        `无法附着调试器：${error.message}`));
    });
  });
  attached.set(tabId, true);
  await cdp(tabId, 'Page.enable', {});
  await cdp(tabId, 'DOM.enable', {});
  return tabId;
}

function cdp(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params ?? {}, (result) => {
      const error = chrome.runtime.lastError;
      if (error === undefined) resolve(result ?? {});
      else reject(new BridgeError('BROWSER_ACTION_FAILED', `${method}: ${error.message}`));
    });
  });
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) attached.delete(source.tabId);
});

// ---------------------------------------------------------------------------
// 快照：输出与 chrome-devtools-mcp 同构的文本，Relay 侧解析器无需两套
// ---------------------------------------------------------------------------

function axName(node) {
  return typeof node.name?.value === 'string' ? node.name.value : '';
}

function axRole(node) {
  return typeof node.role?.value === 'string' ? node.role.value : 'generic';
}

/**
 * AX 树拍平。
 *
 * 真实 CDP 的 `Accessibility.getFullAXTree` 返回**扁平**数组，层级靠 `childIds`；
 * 而 chrome-devtools-mcp 的快照是嵌套 `nodes`。两种都要吃，否则换后端就只剩根节点。
 */
function flattenAx(nodes) {
  const flat = [];
  const visit = (node) => {
    if (node === null || typeof node !== 'object') return;
    flat.push(node);
    if (Array.isArray(node.nodes)) for (const child of node.nodes) visit(child);
  };
  for (const node of Array.isArray(nodes) ? nodes : []) visit(node);
  return flat;
}

function childrenOf(node, byId) {
  if (Array.isArray(node.nodes)) return node.nodes;
  if (Array.isArray(node.childIds)) {
    return node.childIds.map((id) => byId.get(String(id))).filter((child) => child !== undefined);
  }
  return [];
}

/** 无障碍树 → 快照行。只保留有意义的节点：Ignored 与空名叶子不产生噪音。 */
function walk(node, depth, out, byId) {
  const role = axRole(node);
  if (node.ignored === true || role === 'Ignored' || role === 'none') {
    for (const child of childrenOf(node, byId)) walk(child, depth, out, byId);
    return;
  }
  const name = axName(node);
  const childNodes = childrenOf(node, byId);
  const isRoot = role === 'RootWebArea';
  const meaningful = isRoot || name !== '' || childNodes.some((child) => axRole(child) !== 'Ignored');
  const structural = ['form', 'textbox', 'button', 'link', 'heading', 'combobox', 'listbox',
    'checkbox', 'radio', 'menuitem', 'tab', 'searchbox', 'slider'].includes(role);
  if (isRoot) {
    const url = typeof node.value === 'string' ? node.value : '';
    out.push(`${'  '.repeat(depth)}uid=${node.nodeId} ${role}${name === '' ? '' : ` "${name}"`} url="${url}"`);
  } else if (structural || name !== '') {
    out.push(`${'  '.repeat(depth)}uid=${node.nodeId} ${role}${name === '' ? '' : ` "${name}"`}`);
  } else if (meaningful && childNodes.length === 0) {
    out.push(`${'  '.repeat(depth)}uid=${node.nodeId} "${name}"`);
  }
  for (const child of childNodes) walk(child, depth + 1, out, byId);
}

async function snapshot(tabId) {
  await attach(tabId);
  const tree = await cdp(tabId, 'Accessibility.getFullAXTree', {});
  const nodes = Array.isArray(tree.nodes) ? tree.nodes : [];
  const flat = flattenAx(nodes);
  const byId = new Map(flat.map((node) => [String(node.nodeId), node]));
  const root = flat.find((node) => axRole(node) === 'RootWebArea') ?? flat[0];
  const lines = [];
  if (root !== undefined) walk(root, 0, lines, byId);
  const text = lines.join('\n');
  return { text: text.length > 12000 ? text.slice(0, 12000) : text, truncated: text.length > 12000 };
}

async function backendNode(tabId, uid) {
  const tree = await cdp(tabId, 'Accessibility.getFullAXTree', {});
  const node = flattenAx(tree.nodes).find((candidate) => String(candidate.nodeId) === String(uid));
  if (node === undefined) {
    throw new BridgeError('BROWSER_ELEMENT_NOT_FOUND',
      `元素 ${uid} 不在当前快照里（页面可能已变化）；请重新读取。`);
  }
  const domId = typeof node.backendDOMNodeId === 'number' ? node.backendDOMNodeId : null;
  if (domId === null) {
    throw new BridgeError('BROWSER_ELEMENT_NOT_FOUND', `元素 ${uid} 没有对应的 DOM 节点。`);
  }
  return domId;
}

async function resolveObject(tabId, domNodeId) {
  const resolved = await cdp(tabId, 'DOM.resolveNode', { backendNodeId: domNodeId });
  if (typeof resolved.object?.objectId !== 'string') {
    throw new BridgeError('BROWSER_ELEMENT_NOT_FOUND', '元素无法解析为 DOM 对象。');
  }
  return resolved.object.objectId;
}

async function centerOf(tabId, objectId) {
  await cdp(tabId, 'Runtime.callFunctionOn', { objectId,
    functionDeclaration: 'function(){ this.scrollIntoView({block:"center", inline:"center"}); }',
    awaitPromise: false });
  await new Promise((resolve) => setTimeout(resolve, 120));
  const box = await cdp(tabId, 'Runtime.callFunctionOn', { objectId,
    functionDeclaration: `function(){
      const rect = this.getBoundingClientRect();
      return JSON.stringify({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
        w: rect.width, h: rect.height });
    }`, returnByValue: true });
  const rect = JSON.parse(box.result?.value ?? '{}');
  if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y) ||
      !(rect.w > 0) || !(rect.h > 0)) {
    throw new BridgeError('BROWSER_ELEMENT_NOT_FOUND', '元素不可见（宽高为 0）。');
  }
  return { x: Math.round(rect.x), y: Math.round(rect.y) };
}

const KEY_CODES = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46,
  ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35,
  PageUp: 33, PageDown: 34, Space: 32 };

/**
 * 等一次页面加载结束。
 *
 * `chrome.debugger.onEvent` 的监听签名是 `(source, method, params)`——不是
 * `(message, sender)`。这里用 `source.tabId` 认页，返回可取消的等待句柄：
 * 同文档导航（#hash、pushState）不会触发 `Page.loadEventFired`，调用方据此
 * 主动 cancel，而不是让一次普通的锚点跳转挂满超时。
 */
function createLoadWaiter(tabId, timeoutMs, allowWithinDocument = false) {
  let settled = false;
  let resolvePromise = () => {};
  let rejectPromise = () => {};
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  // 提前挂一个空 catch：取消后没有任何人 await 它时，不应变成 unhandled rejection。
  promise.catch(() => {});
  const finish = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    chrome.debugger.onEvent.removeListener(listener);
    if (error === undefined) resolvePromise();
    else rejectPromise(error);
  };
  const listener = (source, method) => {
    if (source?.tabId !== tabId || (method !== 'Page.loadEventFired' &&
      !(allowWithinDocument && method === 'Page.navigatedWithinDocument'))) return;
    finish();
  };
  const timer = setTimeout(() => finish(new BridgeError('BROWSER_TIMEOUT',
    `页面加载超过 ${timeoutMs} ms`)), timeoutMs);
  chrome.debugger.onEvent.addListener(listener);
  return { promise, cancel: () => finish() };
}

/**
 * 页面加载状态（`document.readyState`）。
 *
 * 快照正文回答不了「页面是不是还在加载」——读到的可能只是还没渲染完的骨架。
 * 取不到时给 null，不猜成 complete。
 */
async function readyStateOf(tabId) {
  try {
    const evaluated = await cdp(tabId, 'Runtime.evaluate', {
      expression: 'document.readyState', returnByValue: true,
    });
    const value = evaluated?.result?.value;
    return value === 'loading' || value === 'interactive' || value === 'complete' ? value : null;
  } catch { return null; }
}

async function snapshotOf(tabId) {
  const snap = await snapshot(tabId);
  const tab = await new Promise((resolve) => chrome.tabs.get(tabId, resolve));
  return { text: snap.text, truncated: snap.truncated, url: tab?.url ?? '', title: tab?.title ?? '',
    readyState: await readyStateOf(tabId) };
}

async function pressKey(tabId, spec) {
  const parts = String(spec).split('+').map((part) => part.trim());
  const key = parts.pop() ?? 'Enter';
  const modifiers = { Control: false, Alt: false, Shift: false, Meta: false };
  for (const part of parts) {
    if (!(part in modifiers)) throw new BridgeError('BROWSER_INVALID_REQUEST', `未知修饰键 ${part}`);
    modifiers[part] = true;
  }
  const code = KEY_CODES[key];
  if (code === undefined) {
    throw new BridgeError('BROWSER_INVALID_REQUEST',
      `不支持的按键 ${key}；支持 Enter/Tab/Escape/Backspace/Delete/方向键/Home/End/PageUp/PageDown/Space。`);
  }
  const flags = (modifiers.Control ? 2 : 0) | (modifiers.Alt ? 1 : 0) |
    (modifiers.Shift ? 8 : 0) | (modifiers.Meta ? 4 : 0);
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key, code: key,
    windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers: flags });
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key, code: key,
    windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers: flags });
}

/** PNG IHDR 里的宽高：签名 8 字节 + 长度 4 字节 + "IHDR" 4 字节，随后是大端宽高。 */
function pngSize(bytes) {
  if (bytes.length < 24) return null;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[index] !== signature[index]) return null;
  }
  const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (chunk !== 'IHDR') return null;
  const read = (offset) => ((bytes[offset] << 24) | (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
  return { width: read(16), height: read(20) };
}

function hexOf(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 截图的尺寸与摘要由扩展算：Relay 侧不需要再解一次图片。 */
async function screenshotSummary(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const size = pngSize(bytes);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return { bytes: bytes.length, width: size?.width ?? null, height: size?.height ?? null,
    sha256: hexOf(digest) };
}

/** 单帧捕获：后台页不一定持续产出供 captureScreenshot 等待的新 surface。 */
async function capturePageFrame(tabId) {
  let timeout;
  let onFrame;
  const frame = new Promise((resolve, reject) => {
    onFrame = (source, method, params) => {
      if (source.tabId !== tabId || method !== 'Page.screencastFrame' ||
          typeof params?.data !== 'string') return;
      void cdp(tabId, 'Page.screencastFrameAck', { sessionId: params.sessionId })
        .then(() => resolve(params.data), reject);
    };
    timeout = setTimeout(() => reject(new BridgeError('BROWSER_TIMEOUT',
      '后台页面未能在 10 秒内提供截图帧。')), 10_000);
  });
  chrome.debugger.onEvent.addListener(onFrame);
  try {
    const started = cdp(tabId, 'Page.startScreencast', { format: 'png', everyNthFrame: 1 });
    // 首帧事件可能早于 start 的回复，超时也须覆盖 start 自身。
    await Promise.race([started, frame.then(() => undefined)]);
    return await frame;
  } finally {
    clearTimeout(timeout);
    chrome.debugger.onEvent.removeListener(onFrame);
    await cdp(tabId, 'Page.stopScreencast', {});
  }
}

// ---------------------------------------------------------------------------
// 命令实现
// ---------------------------------------------------------------------------

async function runOp(op, params) {
  switch (op) {
    case 'list_pages': {
      const tabs = await chrome.tabs.query({});
      const owned = await ownedTabs();
      return { pages: (await Promise.all(tabs.map(toPageRef))).map((page) => ({
        ...page, owned: owned.has(page.pageId) })) };
    }
    case 'new_page': {
      const tab = await new Promise((resolve, reject) => {
        chrome.tabs.create({ url: params.url || 'about:blank', active: false }, (created) => {
          const error = chrome.runtime.lastError;
          if (error === undefined) resolve(created);
          else reject(new BridgeError('BROWSER_ACTION_FAILED', `无法创建标签页：${error.message}`));
        });
      });
      await addOwnedTab(tab.id);
      // active:false 也要防一手：绝不把 Agent 页带到前台。
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { pageId: tab.id, url: tab.url ?? params.url ?? 'about:blank', title: tab.title ?? '' };
    }
    case 'close_page': {
      const tabId = await ownedTab(params.pageId);
      await dropOwnedTab(tabId);
      await new Promise((resolve, reject) => {
        chrome.tabs.remove(tabId, () => {
          const error = chrome.runtime.lastError;
          if (error === undefined) resolve();
          else reject(new BridgeError('BROWSER_ACTION_FAILED', error.message));
        });
      });
      return { pageId: tabId };
    }
    case 'read_page': {
      const tabId = await ownedTab(params.pageId);
      const snap = await snapshot(tabId);
      const tab = await new Promise((resolve) => chrome.tabs.get(tabId, resolve));
      return { text: snap.text, truncated: snap.truncated, url: tab.url ?? '', title: tab.title ?? '',
        readyState: await readyStateOf(tabId) };
    }
    case 'navigate': {
      const tabId = await ownedTab(params.pageId);
      await attach(tabId);
      const timeoutMs = params.timeoutMs ?? 30000;
      const waiter = createLoadWaiter(tabId, timeoutMs);
      const navigation = await cdp(tabId, 'Page.navigate', { url: String(params.url ?? '') });
      // 导航失败不写进异常，而是写在 errorText 里（实测过）；把它变成类型化失败，
      // 否则调用方只能等到超时，看不出「根本没有跳过去」。
      if (typeof navigation.errorText === 'string' && navigation.errorText !== '') {
        waiter.cancel();
        throw new BridgeError('BROWSER_NAVIGATION_BLOCKED', navigation.errorText);
      }
      // 同文档导航没有新的 loaderId，也不会有 loadEventFired：不等待。
      if (typeof navigation.loaderId === 'string' && navigation.loaderId !== '') {
        await waiter.promise;
      } else {
        waiter.cancel();
      }
      return await snapshotOf(tabId);
    }
    case 'history': {
      const tabId = await ownedTab(params.pageId);
      await attach(tabId);
      const direction = String(params.direction ?? '');
      const timeoutMs = params.timeoutMs ?? 30000;
      if (direction === 'reload') {
        const waiter = createLoadWaiter(tabId, timeoutMs);
        await cdp(tabId, 'Page.reload', {});
        await waiter.promise;
        return await snapshotOf(tabId);
      }
      if (direction !== 'back' && direction !== 'forward') {
        throw new BridgeError('BROWSER_INVALID_REQUEST',
          `未知的导航方向 ${direction}；只支持 back/forward/reload。`);
      }
      const history = await cdp(tabId, 'Page.getNavigationHistory', {});
      const entries = Array.isArray(history.entries) ? history.entries : [];
      const index = Number(history.currentIndex);
      const target = entries[index + (direction === 'back' ? -1 : 1)];
      if (target === undefined || target === null) {
        throw new BridgeError('BROWSER_INVALID_REQUEST',
          direction === 'back' ? '已经到最早一页，没有可后退的历史。'
            : '已经到最新一页，没有可前进的历史。');
      }
      const waiter = createLoadWaiter(tabId, timeoutMs, true);
      try { await cdp(tabId, 'Page.navigateToHistoryEntry', { entryId: target.id }); }
      catch (error) { waiter.cancel(); throw error; }
      await waiter.promise;
      return await snapshotOf(tabId);
    }
    case 'click':
    case 'submit_form': {
      const tabId = await ownedTab(params.pageId);
      const domId = await backendNode(tabId, params.uid);
      const objectId = await resolveObject(tabId, domId);
      // 只模拟本自有页的文档焦点，不切换 Chrome 当前标签页或窗口。
      // 有界面 Chrome 的后台页可能丢弃鼠标事件；文本插入成功不代表点击可用。
      await cdp(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true });
      try {
        const point = await centerOf(tabId, objectId);
        // 双击按 CDP 的语义连发两组 pressed/released，第二组 clickCount=2；
        // 只改 clickCount 而不补按键序列，页面上的 dblclick 监听不会触发。
        const clicks = params.double === true ? 2 : 1;
        for (let count = 1; count <= clicks; count += 1) {
          await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...point,
            button: 'left', clickCount: count });
          await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...point,
            button: 'left', clickCount: count });
        }
      } finally {
        await cdp(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: false });
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      return await snapshotOf(tabId);
    }
    case 'fill': {
      const tabId = await ownedTab(params.pageId);
      const domId = await backendNode(tabId, params.uid);
      const objectId = await resolveObject(tabId, domId);
      const tag = await cdp(tabId, 'Runtime.callFunctionOn', { objectId,
        functionDeclaration: `function(){
          const tag = this.tagName;
          if (tag === 'SELECT') {
            for (const option of this.options) {
              if (option.value === %VALUE% || option.text === %VALUE%) {
                this.value = option.value; this.dispatchEvent(new Event('change', {bubbles:true}));
                return 'select';
              }
            }
            return 'select-miss';
          }
          this.focus();
          if ('value' in this) this.value = '';
          return tag;
        }`.replace(/%VALUE%/g, JSON.stringify(String(params.text))),
        returnByValue: true });
      if (tag.result?.value === 'select') {
        const snap = await snapshot(tabId);
        const tab = await new Promise((resolve) => chrome.tabs.get(tabId, resolve));
        return { text: snap.text, url: tab.url ?? '', title: tab.title ?? '' };
      }
      await centerOf(tabId, objectId);
      await cdp(tabId, 'Input.insertText', { text: String(params.text ?? '') });
      await new Promise((resolve) => setTimeout(resolve, 120));
      const snap = await snapshot(tabId);
      const tab = await new Promise((resolve) => chrome.tabs.get(tabId, resolve));
      return { text: snap.text, url: tab.url ?? '', title: tab.title ?? '' };
    }
    case 'press_key': {
      const tabId = await ownedTab(params.pageId);
      await pressKey(tabId, params.key);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const snap = await snapshot(tabId);
      const tab = await new Promise((resolve) => chrome.tabs.get(tabId, resolve));
      return { text: snap.text, url: tab.url ?? '', title: tab.title ?? '' };
    }
    case 'wait_for': {
      const tabId = await ownedTab(params.pageId);
      const deadline = Date.now() + (params.timeoutMs ?? 10000);
      for (;;) {
        const snap = await snapshot(tabId);
        if (snap.text.includes(String(params.text ?? ''))) {
          const tab = await new Promise((resolve) => chrome.tabs.get(tabId, resolve));
          return { text: snap.text, url: tab.url ?? '', title: tab.title ?? '' };
        }
        if (Date.now() > deadline) {
          throw new BridgeError('BROWSER_TIMEOUT', `等待文本超时（${params.timeoutMs ?? 10000} ms）`);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    case 'upload_file': {
      const tabId = await ownedTab(params.pageId);
      const domId = await backendNode(tabId, params.uid);
      await attach(tabId);
      // chrome.debugger 的 DOM.setFileInputFiles 是设置文件输入的唯一受支持方式：
      // 不注入 JS 伪造事件，也不碰系统文件选择器。
      await cdp(tabId, 'DOM.setFileInputFiles', { files: [String(params.filePath)],
        backendNodeId: domId });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const snap = await snapshot(tabId);
      const tab = await new Promise((resolve) => chrome.tabs.get(tabId, resolve));
      return { text: snap.text, url: tab.url ?? '', title: tab.title ?? '' };
    }
    case 'screenshot': {
      const tabId = await ownedTab(params.pageId);
      await attach(tabId);
      const data = await capturePageFrame(tabId);
      const summary = await screenshotSummary(data);
      return { data, bytes: summary.bytes, mimeType: 'image/png',
        width: summary.width, height: summary.height, sha256: summary.sha256 };
    }
    default:
      throw new BridgeError('BROWSER_INVALID_REQUEST', `未知的命令 ${op}`);
  }
}

// ---------------------------------------------------------------------------
// 保活：被回收的 service worker 不会自己醒来
// ---------------------------------------------------------------------------
//
// 事实（MV3）：service worker 在约 30 秒无事件后被 Chrome 终止；被终止的 worker
// **不会**因为「WebSocket 断了」而重启——`onclose` 里的退避重连只在这个 worker 还
// 活着时有效，进程一旦回收，连定时器一起消失。于是空闲一段时间后桥接会静默失联，
// 直到用户碰巧触发了某个能唤醒 worker 的 Chrome 事件。
//
// 不依赖用户动作的唤醒源只有 `chrome.alarms`：系统闹钟会重新启动 worker 并投递
// `onAlarm`。这里用 30 秒周期（Chrome 120+ 的最小粒度；更早的版本会钳到 1 分钟）
// 做两件事——把「空闲后失联」的窗口压到一个闹钟周期内，并在醒来时立刻补上连接。
// 闹钟只负责唤醒，不承担心跳语义：连接是否健康仍由 WS 的 open/close 判定。
const KEEPALIVE_ALARM = 'relay.keepalive';
const KEEPALIVE_PERIOD_MINUTES = 0.5;

/** 同名闹钟是覆盖语义，重复调用不会堆出多个。 */
function ensureKeepalive() {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_PERIOD_MINUTES });
}

/**
 * 桥接没连上就重连。
 *
 * `CONNECTING` 也算「在连」：否则每次闹钟都会在握手期间再建一条，服务端看到的是
 * 同一扩展的多条重复连接。半开连接（readyState 已关闭）直接丢弃重建。
 */
function reconnectIfDown() {
  if (socket !== null) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) return;
    socket = null;
  }
  void connect();
}

void connect();
ensureKeepalive();
chrome.runtime.onStartup.addListener(() => { ensureKeepalive(); reconnectIfDown(); });
chrome.runtime.onInstalled.addListener(() => { ensureKeepalive(); reconnectIfDown(); });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === KEEPALIVE_ALARM) reconnectIfDown();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.serverUrl !== undefined || changes.token !== undefined) {
    if (socket !== null) { socket.close(); socket = null; }
    void connect();
  }
});
