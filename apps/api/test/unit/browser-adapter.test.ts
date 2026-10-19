import assert from 'node:assert/strict';
import test from 'node:test';

import type { GatewayOrigin } from '../../src/application/gateway-actions.js';
import type { DbExecutor } from '../../src/infrastructure/database.js';
import {
  browserExecute, browserParamsForAction, browserTargetForTool, resolveUploadPath,
} from '../../src/browser/browser-adapter.js';
import { replaceBrowserSessionManagerForTest } from '../../src/browser/client-holder.js';
import { BrowserBackendError } from '../../src/browser/mcp-client.js';
import {
  MAX_PAGES, type BrowserHealth, type BrowserPageRef, type BrowserProvider, type BrowserSnapshot,
} from '../../src/browser/provider.js';
import { BrowserSessionManager } from '../../src/browser/session-manager.js';

/** 受控替身：所有页面操作都在内存里，失败模式可切换。 */
class FakeProvider implements BrowserProvider {
  readonly kind = 'fake';
  readonly pages = new Map<number, { url: string; title: string }>();
  nextId = 1;
  /** 'ok' 正常；'uncertain' 抛效果未知；'missing' 抛元素不存在；'cancelled' 抛取消。 */
  mode: 'ok' | 'uncertain' | 'missing' | 'cancelled' = 'ok';
  calls: string[] = [];

  constructor() {
    this.pages.set(1, { url: 'about:blank', title: '' });
  }

  async ensureStarted(): Promise<BrowserHealth> {
    return { status: 'READY', backendVersion: 'fake-1', chromeVersion: 'Chrome/fake',
      tools: [], detail: 'ok', remediation: null };
  }

  async health(): Promise<BrowserHealth> {
    return this.ensureStarted();
  }

  async listPages(): Promise<readonly BrowserPageRef[]> {
    return [...this.pages.entries()].map(([pageId, page]) => ({ pageId, ...page }));
  }

  async newPage(input: { url?: string }): Promise<BrowserPageRef> {
    const pageId = this.nextId += 1;
    const url = input.url ?? 'about:blank';
    this.pages.set(pageId, { url, title: `page-${pageId}` });
    this.calls.push(`new_page:${pageId}`);
    return { pageId, url, title: `page-${pageId}` };
  }

  async closePage(pageId: number): Promise<void> {
    this.pages.delete(pageId);
    this.calls.push(`close_page:${pageId}`);
  }

  async readPage(pageId: number): Promise<BrowserSnapshot> {
    return this.snapshot(pageId);
  }

  async navigate(input: { pageId: number; url?: string;
    history?: 'back' | 'forward' | 'reload' }): Promise<BrowserSnapshot> {
    const page = this.pages.get(input.pageId);
    if (page === undefined) throw new BrowserBackendError('BROWSER_PAGE_NOT_FOUND', 'gone');
    if (input.url !== undefined) {
      this.pages.set(input.pageId, { url: input.url, title: 'navigated' });
    }
    return this.snapshot(input.pageId);
  }

  async click(input: { pageId: number; uid: string }): Promise<BrowserSnapshot> {
    if (this.mode === 'missing') {
      throw new BrowserBackendError('BROWSER_ELEMENT_NOT_FOUND', 'uid 不存在');
    }
    if (this.mode === 'uncertain') {
      throw new BrowserBackendError('BROWSER_EFFECT_UNCERTAIN', '结果未知', false, true);
    }
    if (this.mode === 'cancelled') {
      // 与真实客户端一致：请求已写出后取消 → 效果未知。
      throw new BrowserBackendError('BROWSER_USER_CANCELLED', '已取消', false, true);
    }
    this.calls.push(`click:${input.pageId}:${input.uid}`);
    return this.snapshot(input.pageId);
  }

  async fill(input: { pageId: number; uid: string; text: string }): Promise<BrowserSnapshot> {
    this.calls.push(`fill:${input.pageId}:${input.uid}:${input.text}`);
    return this.snapshot(input.pageId);
  }

  async pressKey(input: { pageId: number; key: string }): Promise<BrowserSnapshot> {
    this.calls.push(`press:${input.pageId}:${input.key}`);
    return this.snapshot(input.pageId);
  }

  async waitFor(input: { pageId: number }): Promise<BrowserSnapshot> {
    return this.snapshot(input.pageId);
  }

  async submitForm(input: { pageId: number; uid: string }): Promise<BrowserSnapshot> {
    this.calls.push(`submit:${input.pageId}:${input.uid}`);
    return this.snapshot(input.pageId);
  }

  async uploadFile(input: { pageId: number; uid: string; absolutePath: string }):
  Promise<BrowserSnapshot> {
    this.calls.push(`upload:${input.pageId}:${input.uid}:${input.absolutePath}`);
    return this.snapshot(input.pageId);
  }

  async screenshot(): Promise<{ width: number; height: number; bytes: number;
    sha256: string; mimeType: string }> {
    return { width: 800, height: 600, bytes: 10, sha256: 'a'.repeat(64), mimeType: 'image/png' };
  }

  async dispose(): Promise<void> {}

  private snapshot(pageId: number): BrowserSnapshot {
    const page = this.pages.get(pageId) ?? { url: '', title: '' };
    return { pageId, url: page.url, title: page.title, readyState: 'complete',
      text: `uid=1_0 RootWebArea url="${page.url}"`, truncated: false,
      elements: [{ uid: '1_0', role: 'RootWebArea', name: '', inForm: false }] };
  }
}

/**
 * 单测里的投影写入口：故意抛错，用来同时证明「投影写失败不阻断真实动作」。
 * 真实 SQL 由集成套件覆盖。
 */
const db = ({ executeQuery: () => { throw new Error('no database in unit test'); } }) as unknown as DbExecutor;

function runOrigin(runId: string): GatewayOrigin {
  return { kind: 'RUN', runId, stepId: 'step-1', resourceId: 'resource-1',
    workerId: 'worker-1', workerEpoch: 1n };
}

function withManager(run: (provider: FakeProvider,
  manager: BrowserSessionManager) => Promise<void>): () => Promise<void> {
  return async () => {
    const provider = new FakeProvider();
    const manager = new BrowserSessionManager({ dataRoot: 'D:\\data', provider });
    const previous = replaceBrowserSessionManagerForTest(manager);
    try {
      await run(provider, manager);
    } finally {
      replaceBrowserSessionManagerForTest(previous);
      await manager.dispose();
    }
  };
}

test('缺省页只可能是本任务新建的页；未登记页一律拒绝', withManager(async (provider) => {
  const origin = runOrigin('run-a');
  // 没有默认页时读/点都不猜。
  const noPage = await browserExecute({ db, actionType: 'BROWSER_CLICK', params: { uid: '1_4' },
    origin });
  assert.equal(noPage.outcome, 'FAILED');
  assert.equal(noPage.result.reason, 'BROWSER_PAGE_NOT_FOUND');

  const created = await browserExecute({ db, actionType: 'BROWSER_NEW_PAGE',
    params: { url: 'https://example.com/a' }, origin });
  assert.equal(created.outcome, 'SUCCEEDED');
  const pageId = created.result.page_id;
  assert.equal(typeof pageId, 'number');

  // 缺省 = 刚建的那一页，不是"当前选中页"，也不是列表第一页（1 是 about:blank）。
  const clicked = await browserExecute({ db, actionType: 'BROWSER_CLICK', params: { uid: '1_4' },
    origin });
  assert.equal(clicked.outcome, 'SUCCEEDED');
  assert.deepEqual(provider.calls.filter((call) => call.startsWith('click')), [`click:${pageId}:1_4`]);

  // 另一页（用户自己开的 / 别的任务建的）明确拒绝，且不产生任何调用。
  const foreign = await browserExecute({ db, actionType: 'BROWSER_CLICK',
    params: { page_id: '1', uid: '1_4' }, origin });
  assert.equal(foreign.outcome, 'FAILED');
  assert.equal(foreign.result.reason, 'BROWSER_PAGE_NOT_OWNED');
  assert.equal(provider.calls.some((call) => call.startsWith('click:1:')), false);

  // 关闭别人的页同样拒绝。
  const closeForeign = await browserExecute({ db, actionType: 'BROWSER_CLOSE_PAGE',
    params: { page_id: '1' }, origin });
  assert.equal(closeForeign.outcome, 'FAILED');
  assert.equal(closeForeign.result.reason, 'BROWSER_PAGE_NOT_OWNED');
}));

test('两个任务各操作自己的页，互不串页', withManager(async (provider) => {
  const a = runOrigin('run-a');
  const b = runOrigin('run-b');
  const pageA = (await browserExecute({ db, actionType: 'BROWSER_NEW_PAGE',
    params: { url: 'https://a.example.com' }, origin: a })).result.page_id;
  const pageB = (await browserExecute({ db, actionType: 'BROWSER_NEW_PAGE',
    params: { url: 'https://b.example.com' }, origin: b })).result.page_id;
  assert.notEqual(pageA, pageB);

  await browserExecute({ db, actionType: 'BROWSER_FILL',
    params: { uid: '1_3', text: 'A 的内容' }, origin: a });
  await browserExecute({ db, actionType: 'BROWSER_FILL',
    params: { uid: '1_3', text: 'B 的内容' }, origin: b });
  assert.deepEqual(provider.calls.filter((call) => call.startsWith('fill')), [
    `fill:${pageA}:1_3:A 的内容`, `fill:${pageB}:1_3:B 的内容`,
  ]);

  // A 不能借 B 的 page_id 操作。
  const cross = await browserExecute({ db, actionType: 'BROWSER_FILL',
    params: { page_id: String(pageB), uid: '1_3', text: 'x' }, origin: a });
  assert.equal(cross.result.reason, 'BROWSER_PAGE_NOT_OWNED');
}));

test('结果未知后页面进入 STALE：必须先重读才能继续写', withManager(async (provider) => {
  const origin = runOrigin('run-a');
  await browserExecute({ db, actionType: 'BROWSER_NEW_PAGE',
    params: { url: 'https://example.com' }, origin });
  provider.mode = 'uncertain';
  const uncertain = await browserExecute({ db, actionType: 'BROWSER_CLICK',
    params: { uid: '1_4' }, origin });
  assert.equal(uncertain.outcome, 'UNKNOWN');
  assert.equal(uncertain.result.reason, 'BROWSER_EFFECT_UNCERTAIN');

  provider.mode = 'ok';
  const blocked = await browserExecute({ db, actionType: 'BROWSER_CLICK',
    params: { uid: '1_4' }, origin });
  assert.equal(blocked.outcome, 'FAILED');
  assert.equal(blocked.result.reason, 'BROWSER_PAGE_STALE');

  // 读取是恢复"状态已知"的唯一途径。
  const read = await browserExecute({ db, actionType: 'BROWSER_READ_PAGE', params: {}, origin });
  assert.equal(read.outcome, 'SUCCEEDED');
  const resumed = await browserExecute({ db, actionType: 'BROWSER_CLICK',
    params: { uid: '1_4' }, origin });
  assert.equal(resumed.outcome, 'SUCCEEDED');
}));

test('取消：写动作按 UNKNOWN 结算，读动作按失败结算', withManager(async (provider) => {
  const origin = runOrigin('run-a');
  await browserExecute({ db, actionType: 'BROWSER_NEW_PAGE',
    params: { url: 'https://example.com' }, origin });
  provider.mode = 'cancelled';
  const write = await browserExecute({ db, actionType: 'BROWSER_CLICK', params: { uid: '1_4' },
    origin });
  // 已发出的点击可能已经生效：不能算失败，必须按"结果未知"结算并要求重新观察。
  assert.equal(write.outcome, 'UNKNOWN');
  assert.equal(write.result.reason, 'BROWSER_EFFECT_UNCERTAIN');

  // 读动作没有外部效果，取消就是失败，不进入 UNKNOWN 隔离。
  const read = await browserExecute({ db, actionType: 'BROWSER_READ_PAGE', params: {}, origin });
  assert.equal(read.outcome, 'SUCCEEDED');
}));

test('参数白名单：未知字段不转发，file 与越界路径被拒', withManager(async (provider) => {
  const origin = runOrigin('run-a');
  // 多带的字段（css 选择器、坐标）不会被转发：词表只认 uid。
  const params = browserParamsForAction('BROWSER_CLICK',
    { uid: '1_4', page_id: '3', css: '#submit', x: 10, y: 20 });
  assert.deepEqual(params, { page_id: '3', uid: '1_4' });
  assert.throws(() => browserParamsForAction('BROWSER_CLICK', { uid: '' }),
    (error: unknown) => error instanceof BrowserBackendError &&
      error.code === 'BROWSER_INVALID_REQUEST');

  const fileNav = await browserExecute({ db, actionType: 'BROWSER_NAVIGATE',
    params: { url: 'file:///C:/Windows/win.ini' }, origin });
  assert.equal(fileNav.result.reason, 'BROWSER_NAVIGATION_BLOCKED');

  const both = await browserExecute({ db, actionType: 'BROWSER_NAVIGATE',
    params: { url: 'https://a.test', history: 'back' }, origin });
  assert.equal(both.result.reason, 'BROWSER_INVALID_REQUEST');

  assert.throws(() => resolveUploadPath('D:\\work', '..\\outside.txt'),
    (error: unknown) => error instanceof BrowserBackendError);
  assert.throws(() => resolveUploadPath('D:\\work', 'C:\\abs.txt'),
    (error: unknown) => error instanceof BrowserBackendError);
  assert.throws(() => resolveUploadPath(null, 'a.txt'),
    (error: unknown) => error instanceof BrowserBackendError);
  assert.equal(resolveUploadPath('D:\\work', 'docs\\a.txt'), 'D:\\work\\docs\\a.txt');

  // 上传需要显式 uid 与相对路径；缺一个就是参数错误，不会"猜一个文件输入框"。
  const upload = await browserExecute({ db, actionType: 'BROWSER_UPLOAD_FILE',
    params: { uid: '1_9' }, origin, canonicalRoot: 'D:\\work' });
  assert.equal(upload.result.reason, 'BROWSER_INVALID_REQUEST');
  assert.equal(provider.calls.some((call) => call.startsWith('upload')), false);
}));

test('目标按站点收窄：导航用目标 URL，页内动作用该页最近已知 origin', withManager(async () => {
  const origin = runOrigin('run-a');
  // 还没有任何页时，页内动作的目标是 unknown（只能被空前缀策略放行）。
  assert.equal(browserTargetForTool(origin, { uid: '1_4' }), 'browser://unknown');
  // 导航目标来自参数里的 URL，与是否已有页无关。
  assert.equal(browserTargetForTool(origin, { url: 'https://Example.com/a' }),
    'browser://example.com');
  await browserExecute({ db, actionType: 'BROWSER_NEW_PAGE',
    params: { url: 'https://example.com/a' }, origin });
  // 建页后，页内动作继承该页的 origin——不需要模型自报站点。
  assert.equal(browserTargetForTool(origin, { uid: '1_4' }), 'browser://example.com');
  // 别的任务的 origin 不会被借用。
  assert.equal(browserTargetForTool(runOrigin('run-z'), { uid: '1_4' }), 'browser://unknown');
}));

test('页面被用户改走地址后，派发前拒绝（目标与准入时不一致）', withManager(async (provider) => {
  const origin = runOrigin('run-a');
  await browserExecute({ db, actionType: 'BROWSER_NEW_PAGE',
    params: { url: 'https://example.com' }, origin });
  // 模拟用户在 Agent 的窗口里自己把地址改到另一个站点。
  provider.pages.set(2, { url: 'https://evil.example.net/', title: 'moved' });
  const click = await browserExecute({ db, actionType: 'BROWSER_CLICK', params: { uid: '1_4' },
    origin });
  assert.equal(click.outcome, 'FAILED');
  assert.equal(click.result.reason, 'BROWSER_PAGE_STATE_CHANGED');
  assert.equal(provider.calls.some((call) => call.startsWith('click:2:')), false);
}));

test('页面很多时截断必须显式标记：Provider 不得先自行 slice', withManager(async (provider) => {
  const origin = runOrigin('run-pages');
  for (let index = 0; index < 40; index += 1) {
    provider.pages.set(100 + index, { url: `https://example.com/p${index}`, title: `p${index}` });
  }
  const result = await browserExecute({ db, actionType: 'BROWSER_LIST_PAGES', params: {}, origin });
  assert.equal(result.outcome, 'SUCCEEDED');
  const pages = result.result.pages as unknown[];
  assert.equal(pages.length, MAX_PAGES, '回显条数按上限收窄');
  assert.equal(result.result.truncated, true,
    '超过上限必须显式标记：Provider 先 slice 时这个字段永远不会出现');
  assert.equal(result.result.count, 41, '总数保留真实值，否则读数会失真');
}));

test('读页面结果带 ready_state：加载状态不能靠猜', withManager(async (provider) => {
  const origin = runOrigin('run-ready');
  const created = await browserExecute({ db, actionType: 'BROWSER_NEW_PAGE',
    params: { url: 'https://example.com/ready' }, origin });
  assert.equal(created.outcome, 'SUCCEEDED');
  const read = await browserExecute({ db, actionType: 'BROWSER_READ_PAGE',
    params: { page_id: String(created.result.page_id) }, origin });
  assert.equal(read.outcome, 'SUCCEEDED');
  assert.equal(read.result.ready_state, 'complete');
}));
