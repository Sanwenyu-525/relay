/**
 * BrowserSessionManager：浏览器连接生命周期与页面所有权（F26）。
 *
 * 它是 **Worker 进程内的进程级单例**：模型工具循环（Run 与会话轮次）都在 Worker 里跑，
 * 与 `getComputerRuntimeClient()` 同一形态。API 进程与桌面壳读到的浏览器任务状态必须
 * 走数据库投影，不能读这里的内存。
 *
 * 三条硬规则：
 *   1. **缺省页只可能是本任务自己新建的页**。没有「缺省 = 用户当前聚焦标签页」这条分支，
 *      上游所有页面工具也都把 pageId 列为必填——协议层就不给"猜"的机会。
 *   2. **未登记的页一律不动**。用户自己开的页、别的任务建的页，导航/点击/关闭全部拒绝。
 *   3. **状态不明时先重读**。取消或结果未知后页面被标记 STALE，下一次写动作必须先读取。
 */

import { browserMcpEntry, browserMode } from './config.js';
import type { BrowserSessionOwnerKind } from './owner.js';

/** 浏览器任务的所属身份：`RUN`（Task/Run 工具循环）或 `SESSION`（会话只读轮次）。 */
export type BrowserOwnerKind = BrowserSessionOwnerKind;
import { BrowserBackendError } from './mcp-client.js';
import { browserProviderKind } from './config.js';
import { ExtensionBridgeProvider } from './extension-provider.js';
import { McpBrowserProvider } from './mcp-browser-provider.js';
import { originOfUrl } from './protocol.js';
import type {
  BrowserElement, BrowserHealth, BrowserPageRef, BrowserProvider, BrowserSnapshot,
} from './provider.js';

/** 错误码 → 展示态：让 0106 的投影与真实失败原因保持一致。 */
function healthStatusFor(code: string): BrowserHealth['status'] {
  if (code === 'BROWSER_CHROME_MISSING') return 'CHROME_MISSING';
  if (code === 'BROWSER_BACKEND_MISSING') return 'BACKEND_MISSING';
  if (code === 'BROWSER_BACKEND_INCOMPATIBLE') return 'INCOMPATIBLE';
  return 'DISCONNECTED';
}

function remediationFor(code: string): string | null {
  if (code === 'BROWSER_CHROME_MISSING') {
    return '安装 Google Chrome 稳定版，或设置 RELAY_BROWSER_CHROME_PATH 指向 chrome.exe。';
  }
  if (code === 'BROWSER_BACKEND_MISSING') {
    return '安装包可能不完整，请重新安装 Relay；开发态先运行 scripts/fetch-browser-mcp.mjs。';
  }
  if (code === 'BROWSER_BACKEND_INCOMPATIBLE') {
    return '这是版本不兼容；请更新 Relay 安装包，不要手工替换浏览器后端。';
  }
  return '重新执行一次浏览器操作会尝试重建浏览器实例。';
}

export interface BrowserOwner {
  readonly kind: BrowserOwnerKind;
  readonly id: string;
}

export interface OwnedPage extends BrowserPageRef {
  readonly owned: boolean;
  readonly stale: boolean;
  readonly isDefault: boolean;
}

interface OwnerState {
  defaultPageId: number | null;
  readonly pages: Set<number>;
}

export interface BrowserSessionManagerOptions {
  readonly dataRoot: string;
  /** 测试接缝：直接注入 provider，跳过真实 Chrome 与 MCP。 */
  readonly provider?: BrowserProvider;
  readonly onDiagnostic?: (line: string) => void;
}

export class BrowserSessionManager {
  private provider: BrowserProvider | null;
  private readonly owners = new Map<string, OwnerState>();
  private readonly stalePages = new Set<number>();
  private readonly pageLocks = new Map<number, Promise<unknown>>();
  /** 每个自有页最后已知的 origin：prepare 计算目标用，dispatch 用它核对页面没被改走。 */
  private readonly origins = new Map<number, string>();

  constructor(private readonly options: BrowserSessionManagerOptions) {
    this.provider = options.provider ?? null;
  }

  /** 测试与显式关闭使用。 */
  async dispose(): Promise<void> {
    const provider = this.provider;
    this.provider = null;
    this.owners.clear();
    this.stalePages.clear();
    if (provider !== null) await provider.dispose();
  }

  async health(): Promise<BrowserHealth> {
    if (this.provider === null) {
      return {
        status: browserMode() === 'mock' ? 'READY' : 'DISCONNECTED',
        backendVersion: null, chromeVersion: null, tools: [],
        detail: '浏览器后端尚未启动。', remediation: '首次使用浏览器能力时自动启动。',
      };
    }
    return this.provider.health();
  }

  /**
   * 懒启动 + 自检，**不抛异常**：把健康结论原样交回调用方。
   *
   * 适配器需要这个结论去写 0106 的健康投影（UI 读的那一行），因此"失败"也是
   * 一个要带回去的结果，而不是只能抛出来的异常。
   */
  async ensureWithHealth(): Promise<BrowserHealth> {
    try {
      return await this.ensure();
    } catch (error) {
      if (error instanceof BrowserBackendError) {
        return {
          status: healthStatusFor(error.code),
          backendVersion: null, chromeVersion: null, tools: [],
          detail: error.message,
          remediation: remediationFor(error.code),
        };
      }
      throw error;
    }
  }

  /** 懒启动 + 自检；READY 之外的状态直接抛出，让调用方拿到可操作诊断。 */
  async ensure(): Promise<BrowserHealth> {
    if (this.provider === null) {
      if (browserMode() === 'mock') {
        throw new BrowserBackendError('BROWSER_BACKEND_UNAVAILABLE',
          'mock 模式未注入浏览器测试替身。');
      }
      if (browserMcpEntry() === '') {
        throw new BrowserBackendError('BROWSER_BACKEND_MISSING', '浏览器后端入口未配置。');
      }
      // ADR-025：默认走「用户现有 Chrome + 扩展桥接」；cdp（自有 Chrome）保留为
      // 离线开发与对照测试的后端，需显式 RELAY_BROWSER_PROVIDER=cdp。
      this.provider = browserProviderKind() === 'cdp'
        ? new McpBrowserProvider({
          dataRoot: this.options.dataRoot,
          ...(this.options.onDiagnostic === undefined
            ? {} : { onDiagnostic: this.options.onDiagnostic }),
        })
        : new ExtensionBridgeProvider({ dataRoot: this.options.dataRoot });
    }
    const health = await this.provider.ensureStarted();
    if (health.status !== 'READY') {
      throw new BrowserBackendError(
        health.status === 'CHROME_MISSING' ? 'BROWSER_CHROME_MISSING'
          : health.status === 'BACKEND_MISSING' ? 'BROWSER_BACKEND_MISSING'
            : health.status === 'INCOMPATIBLE' ? 'BROWSER_BACKEND_INCOMPATIBLE'
              : 'BROWSER_BACKEND_UNAVAILABLE',
        `${health.detail}${health.remediation === null ? '' : ` ${health.remediation}`}`);
    }
    return health;
  }

  /** 列出页面，并标注哪些属于本任务。未登记的页 owned=false（只读可见，不可操作）。 */
  async listPages(owner: BrowserOwner): Promise<readonly OwnedPage[]> {
    await this.ensure();
    const pages = await this.requireProvider().listPages();
    const state = this.ownerState(owner);
    return pages.map((page) => ({
      ...page,
      owned: state.pages.has(page.pageId),
      stale: this.stalePages.has(page.pageId),
      isDefault: state.defaultPageId === page.pageId,
    }));
  }

  /** 新建自有页并设为该 owner 的默认页。 */
  async newPage(owner: BrowserOwner, url?: string): Promise<OwnedPage> {
    await this.ensure();
    const page = await this.requireProvider().newPage(url === undefined ? {} : { url });
    const state = this.ownerState(owner);
    state.pages.add(page.pageId);
    state.defaultPageId = page.pageId;
    this.stalePages.delete(page.pageId);
    this.noteOrigin(page.pageId, page.url);
    return { ...page, owned: true, stale: false, isDefault: true };
  }

  async closePage(owner: BrowserOwner, pageId: number): Promise<void> {
    await this.ensure();
    const state = this.assertOwned(owner, pageId);
    await this.withPageLock(pageId, () => this.requireProvider().closePage(pageId));
    state.pages.delete(pageId);
    this.stalePages.delete(pageId);
    if (state.defaultPageId === pageId) state.defaultPageId = null;
  }

  /**
   * 把模型给的 `page_id`（字符串，可缺省）解析成受管的数字页 id。
   *
   * 缺省时用该 owner 的默认页；默认页不存在就明确要求先 `browser_new_page`，
   * **不会**退到「列表里的第一个页」或「当前选中页」。
   */
  async resolvePage(owner: BrowserOwner, pageIdInput: string | undefined): Promise<number> {
    await this.ensure();
    const state = this.ownerState(owner);
    if (pageIdInput === undefined || pageIdInput === '') {
      const pageId = state.defaultPageId;
      if (pageId === null) {
        throw new BrowserBackendError('BROWSER_PAGE_NOT_FOUND',
          '本任务还没有自己的浏览器页面；请先调用 browser_new_page 新建一个。');
      }
      if (!(await this.pageExists(pageId))) {
        state.pages.delete(pageId);
        state.defaultPageId = null;
        throw new BrowserBackendError('BROWSER_PAGE_NOT_FOUND',
          `默认页 ${pageId} 已不存在（可能被关闭）；请重新调用 browser_new_page。`);
      }
      return pageId;
    }
    const pageId = Number(pageIdInput);
    if (!Number.isInteger(pageId) || pageId <= 0) {
      throw new BrowserBackendError('BROWSER_PAGE_NOT_FOUND',
        `page_id 必须是正整数（收到 ${JSON.stringify(pageIdInput)}）。`);
    }
    if (!state.pages.has(pageId)) {
      throw new BrowserBackendError('BROWSER_PAGE_NOT_OWNED',
        `页面 ${pageId} 不属于本任务（可能是用户自己打开的页或别的任务的页），` +
        '不会对它导航、点击或关闭。');
    }
    if (!(await this.pageExists(pageId))) {
      state.pages.delete(pageId);
      if (state.defaultPageId === pageId) state.defaultPageId = null;
      throw new BrowserBackendError('BROWSER_PAGE_NOT_FOUND',
        `页面 ${pageId} 已不存在（可能被关闭）；请重新调用 browser_new_page。`);
    }
    return pageId;
  }

  /** 读页面：同时清掉该页的 STALE 标记（读取是恢复"状态已知"的唯一途径）。 */
  async readPage(owner: BrowserOwner, pageId: number): Promise<BrowserSnapshot> {
    this.assertOwned(owner, pageId);
    return this.withPageLock(pageId, async () => {
      const snapshot = await this.requireProvider().readPage(pageId);
      this.stalePages.delete(pageId);
      this.noteOrigin(pageId, snapshot.url);
      return snapshot;
    });
  }

  /**
   * 执行一次页面动作。
   *
   * `mutating=true` 的动作在页面处于 STALE 时直接拒绝：状态不明时不允许再写。
   * 动作失败且结果可能已发生时（effectUncertain），把页面重新标记 STALE。
   */
  async act(owner: BrowserOwner, pageId: number, mutating: boolean,
    run: (provider: BrowserProvider) => Promise<BrowserSnapshot>): Promise<BrowserSnapshot> {
    this.assertOwned(owner, pageId);
    if (mutating && this.stalePages.has(pageId)) {
      throw new BrowserBackendError('BROWSER_PAGE_STALE',
        `页面 ${pageId} 的状态在上一次操作后未确认（结果未知或被取消）；` +
        '请先调用 browser_read_page 重新读取再继续。');
    }
    return this.withPageLock(pageId, async () => {
      try {
        const snapshot = await run(this.requireProvider());
        this.stalePages.delete(pageId);
        this.noteOrigin(pageId, snapshot.url);
        return snapshot;
      } catch (error) {
        if (error instanceof BrowserBackendError && mutating &&
            (error.effectUncertain || error.code === 'BROWSER_TIMEOUT' ||
              error.code === 'BROWSER_USER_CANCELLED')) {
          this.stalePages.add(pageId);
        }
        throw error;
      }
    });
  }

  /**
   * 动作前的元素预览（风险分类用）。
   *
   * 只在**策略已经覆盖为 AUTO** 时才调用：别为一次注定被拒的动作启动浏览器。
   * 返回 null 表示"读不到快照"——调用方按 LOW 处理，把决定权交回动作本身
   * （读不到页面时点击会失败，那比误判成高风险更有信息量）。
   */
  async previewElements(owner: BrowserOwner, pageIdInput: string | undefined):
  Promise<readonly BrowserElement[] | null> {
    if (this.provider === null) return null;
    try {
      const pageId = await this.resolvePage(owner, pageIdInput);
      const snapshot = await this.readPage(owner, pageId);
      return snapshot.elements;
    } catch {
      return null;
    }
  }

  /** 结果未知或取消后由适配器显式标记（例如上游报错但可能已执行）。 */
  markStale(pageId: number): void {
    this.stalePages.add(pageId);
  }

  /** 最近一次已知的 origin（prepare 计算目标用；拿不到时返回 null）。 */
  recordedOrigin(pageId: number): string | null {
    return this.origins.get(pageId) ?? null;
  }

  /**
   * 同步窥视：prepare 阶段要算目标，不能为此启动浏览器或发起任何 IO。
   *
   * 只读内存里的所有权与 origin 记录；任何不确定都返回 null（目标退化为
   * `browser://unknown`，只能被空前缀策略放行），绝不猜。
   */
  peekOrigin(owner: BrowserOwner, pageIdInput: string | undefined): string | null {
    const state = this.owners.get(`${owner.kind}:${owner.id}`);
    if (state === undefined) return null;
    if (pageIdInput === undefined || pageIdInput === '') {
      return state.defaultPageId === null ? null : this.origins.get(state.defaultPageId) ?? null;
    }
    const pageId = Number(pageIdInput);
    if (!Number.isInteger(pageId) || !state.pages.has(pageId)) return null;
    return this.origins.get(pageId) ?? null;
  }

  /**
   * 页面的实时 origin。
   *
   * 只读一次页面列表（不取快照），用来核对「prepare 时冻结的目标」与「派发时的真实页面」
   * 是否仍是同一个站点——用户可能在两次调用之间自己把地址改走了。
   */
  async liveOrigin(pageId: number): Promise<string | null> {
    if (this.provider === null) return null;
    try {
      const pages = await this.provider.listPages();
      const page = pages.find((entry) => entry.pageId === pageId);
      return page === undefined ? null : originOfUrl(page.url);
    } catch {
      return null;
    }
  }

  private noteOrigin(pageId: number, url: string): void {
    const origin = originOfUrl(url);
    if (origin !== null) this.origins.set(pageId, origin);
  }

  async screenshot(owner: BrowserOwner, pageId: number) {
    this.assertOwned(owner, pageId);
    return this.withPageLock(pageId, () => this.requireProvider().screenshot(pageId));
  }

  private ownerState(owner: BrowserOwner): OwnerState {
    const key = `${owner.kind}:${owner.id}`;
    const existing = this.owners.get(key);
    if (existing !== undefined) return existing;
    const created: OwnerState = { defaultPageId: null, pages: new Set<number>() };
    this.owners.set(key, created);
    return created;
  }

  private assertOwned(owner: BrowserOwner, pageId: number): OwnerState {
    const state = this.ownerState(owner);
    if (!state.pages.has(pageId)) {
      throw new BrowserBackendError('BROWSER_PAGE_NOT_OWNED',
        `页面 ${pageId} 不属于本任务，不会对它执行操作。`);
    }
    return state;
  }

  private async pageExists(pageId: number): Promise<boolean> {
    const pages = await this.requireProvider().listPages();
    return pages.some((page) => page.pageId === pageId);
  }

  private requireProvider(): BrowserProvider {
    if (this.provider === null) {
      throw new BrowserBackendError('BROWSER_BACKEND_UNAVAILABLE', '浏览器后端尚未启动。');
    }
    return this.provider;
  }

  /** 页级互斥：同一页上的操作串行，不同页可并行。 */
  private withPageLock<T>(pageId: number, run: () => Promise<T>): Promise<T> {
    const previous = this.pageLocks.get(pageId) ?? Promise.resolve();
    const next = previous.then(run, run);
    this.pageLocks.set(pageId, next.then(() => undefined, () => undefined));
    return next;
  }
}
