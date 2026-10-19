/**
 * 基于 chrome-devtools-mcp 的 BrowserProvider 实现（F26）。
 *
 * 这个文件是**唯一**知道上游工具名与参数名的地方。上游的大版本变化只应该在这里
 * 表现为映射表更新 + 启动自检失败，而不是散落到适配器、Gateway 或 UI。
 *
 * 实测事实（chrome-devtools-mcp 1.11.0，2026-10-17）：
 *   * 所有页面工具都把 `pageId` 列为**必填**，类型是 number；不存在「隐式当前页」，
 *     因此「Agent 误操作当前聚焦标签页」在协议层就不可能发生；
 *   * `click` 的参数字段是 `dblClick`，`fill` 的文本字段是 `value`；
 *   * `new_page` 返回的是**页面列表**而不是新页 id，新 id 必须用前后列表求差得到；
 *   * `navigate_page` 把导航失败写进正文（`Unable to navigate …`）而不是置 isError；
 *   * `take_screenshot` 返回 text + image 两个块，图片是 base64。
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';

import { launchChrome, type ChromeInstance } from './chrome-launcher.js';
import { isAllowedNavigationUrl } from './protocol.js';
import {
  browserMcpEntry, browserMode, browserProfileDir, chromeExecutable,
} from './config.js';
import { BrowserBackendError, McpStdioClient } from './mcp-client.js';
import {
  MAX_SNAPSHOT_CHARS,
  type BrowserCallOptions, type BrowserHealth, type BrowserPageRef, type BrowserProvider,
  type BrowserScreenshotSummary, type BrowserSnapshot,
} from './provider.js';
import { parsePages, parseSnapshotText, pngSize } from './snapshot-parse.js';

/**
 * 冻结映射：Relay 需要的上游工具。
 *
 * 启动时用 `tools/list` 逐项核对；缺任何一个就判 `INCOMPATIBLE` 并拒绝工作，
 * 不做「少一个工具就降级成别的路径」的猜测。
 */
const REQUIRED_UPSTREAM_TOOLS: readonly string[] = [
  'list_pages', 'new_page', 'close_page', 'take_snapshot',
  'navigate_page', 'click', 'fill', 'press_key', 'wait_for',
  'take_screenshot', 'upload_file',
];

/** 上游参数基线：关掉与本功能无关的分类与遥测。 */
const UPSTREAM_ARGS: readonly string[] = [
  '--no-usage-statistics',
  '--performance-crux=false',
  '--category-performance=false',
  '--category-network=false',
  '--category-memory=false',
  '--category-extensions=false',
  '--category-experimental-webmcp=false',
  '--category-experimental-third-party=false',
  '--screenshot-format=png',
  // 让 list_pages/new_page 直接给机器可读的页面列表；缺失时退回文本解析。
  '--experimentalStructuredContent=true',
  // 关掉 file:// 导航：上游默认允许，但那会让「网页操作」变成读本地任意文件。
  // 适配层也拦一次，这里从引擎层再关一次——纵深防御，不靠单点。
  '--file-navigations=false',
];

export interface McpBrowserProviderOptions {
  /** 数据根：profile 落在 `<dataRoot>/browser/profile`。 */
  readonly dataRoot: string;
  /** 跑 MCP 的 Node；缺省用当前进程（随包时就是 node.exe）。 */
  readonly nodeExecutable?: string;
  /** 测试接缝。 */
  readonly launchChrome?: typeof launchChrome;
  readonly createClient?: (options: ConstructorParameters<typeof McpStdioClient>[0])
    => McpStdioClient;
  readonly onDiagnostic?: (line: string) => void;
  readonly headless?: boolean;
}

export class McpBrowserProvider implements BrowserProvider {
  readonly kind = 'chrome-devtools-mcp';
  private chrome: ChromeInstance | null = null;
  private client: McpStdioClient | null = null;
  private healthState: BrowserHealth | null = null;
  private chromeVersion: string | null = null;

  constructor(private readonly options: McpBrowserProviderOptions) {}

  async ensureStarted(options: BrowserCallOptions = {}): Promise<BrowserHealth> {
    if (this.healthState?.status === 'READY' && this.client?.alive === true &&
        this.chrome?.isAlive() === true) {
      return this.healthState;
    }
    if (browserMode() === 'mock') {
      throw new BrowserBackendError('BROWSER_BACKEND_UNAVAILABLE',
        'mock 模式不启动真实浏览器后端；请通过测试替身注入。');
    }
    const entry = browserMcpEntry();
    if (!existsSync(entry)) {
      return this.remember({
        status: 'BACKEND_MISSING', backendVersion: null, chromeVersion: null, tools: [],
        detail: `浏览器后端入口不存在：${entry}`,
        remediation: '安装包可能不完整，请重新安装 Relay；开发态先运行 scripts/fetch-browser-mcp.mjs。',
      });
    }
    const executable = chromeExecutable();
    if (executable === null) {
      return this.remember({
        status: 'CHROME_MISSING', backendVersion: null, chromeVersion: null, tools: [],
        detail: '未找到 Google Chrome。',
        remediation: '安装 Google Chrome 稳定版，或设置 RELAY_BROWSER_CHROME_PATH 指向 chrome.exe。',
      });
    }

    await this.stopChrome();
    const launch = this.options.launchChrome ?? launchChrome;
    try {
      this.chrome = await launch({
        executable,
        profileDir: browserProfileDir(this.options.dataRoot),
        ...(this.options.headless === undefined ? {} : { headless: this.options.headless }),
        ...(this.options.onDiagnostic === undefined
          ? {} : { onStderr: this.options.onDiagnostic }),
      });
    } catch (error) {
      return this.remember({
        status: error instanceof BrowserBackendError && error.code === 'BROWSER_CHROME_MISSING'
          ? 'CHROME_MISSING' : 'DISCONNECTED',
        backendVersion: null, chromeVersion: null, tools: [],
        detail: error instanceof Error ? error.message : String(error),
        remediation: '确认 Chrome 可正常启动；若提示 profile 被占用，请关闭其它 Relay 实例后重试。',
      });
    }
    this.chromeVersion = await readChromeVersion(this.chrome.port);

    const createClient = this.options.createClient
      ?? ((options) => new McpStdioClient(options));
    this.client = createClient({
      nodeExecutable: this.options.nodeExecutable ?? process.execPath,
      entry,
      args: [...UPSTREAM_ARGS, `--browserUrl=http://127.0.0.1:${this.chrome.port}`],
      env: {
        ...process.env,
        // 上游没有 --no-update-checks 这个参数（实测报 Unknown arguments），
        // 关更新检查只能走环境变量。
        CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1',
        CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1',
      },
      ...(this.options.onDiagnostic === undefined ? {} : { onStderr: this.options.onDiagnostic }),
    });

    let tools: readonly string[] = [];
    try {
      await this.client.start();
      tools = (await this.client.listTools()).map((tool) => tool.name);
    } catch (error) {
      await this.stopChrome();
      return this.remember({
        status: 'DISCONNECTED', backendVersion: null, chromeVersion: this.chromeVersion,
        tools: [], detail: error instanceof Error ? error.message : String(error),
        remediation: '浏览器后端启动失败；请查看诊断日志后重试。',
      });
    }
    const missing = REQUIRED_UPSTREAM_TOOLS.filter((name) => !tools.includes(name));
    if (missing.length > 0) {
      const version = this.client.version;
      await this.stopChrome();
      return this.remember({
        status: 'INCOMPATIBLE', backendVersion: version, chromeVersion: this.chromeVersion,
        tools,
        detail: `浏览器后端版本 ${version ?? '未知'} 缺少所需工具：${missing.join('、')}`,
        remediation: '这是版本不兼容；请更新 Relay 安装包，不要手工替换浏览器后端。',
      });
    }
    return this.remember({
      status: 'READY', backendVersion: this.client.version, chromeVersion: this.chromeVersion,
      tools, detail: '浏览器后端就绪。', remediation: null,
    });
  }

  async health(): Promise<BrowserHealth> {
    if (this.healthState === null) {
      return { status: 'DISCONNECTED', backendVersion: null, chromeVersion: null, tools: [],
        detail: '浏览器后端尚未启动。', remediation: '首次使用浏览器能力时自动启动。' };
    }
    if (this.healthState.status === 'READY' &&
        (this.client?.alive !== true || this.chrome?.isAlive() !== true)) {
      return { ...this.healthState, status: 'DISCONNECTED', detail: '浏览器后端已断开。',
        remediation: '重新执行浏览器操作会自动重建浏览器实例。' };
    }
    return this.healthState;
  }

  async listPages(options: BrowserCallOptions = {}): Promise<readonly BrowserPageRef[]> {
    const result = await this.call('list_pages', {}, false, options);
    // 不在 Provider 侧截断：截断与标记统一在适配层做（见 provider.ts 的 MAX_PAGES）。
    return parsePages(result.structured, result.text);
  }

  async newPage(input: { url?: string } & BrowserCallOptions): Promise<BrowserPageRef> {
    if (input.url !== undefined && !isAllowedNavigationUrl(input.url)) {
      throw new BrowserBackendError('BROWSER_NAVIGATION_BLOCKED',
        '只允许 http/https 地址。');
    }
    const before = await this.listPages(input);
    const result = await this.call('new_page', { url: input.url ?? 'about:blank' }, true, input);
    const after = parsePages(result.structured, result.text);
    const fresh = after.filter((page) => !before.some((old) => old.pageId === page.pageId));
    const created = fresh[fresh.length - 1];
    if (created === undefined) {
      throw new BrowserBackendError('BROWSER_PROTOCOL_VIOLATION',
        '新建页面后未能在页面列表里识别出新页，已停止以避免操作到错误的页。');
    }
    return created;
  }

  async closePage(pageId: number, options: BrowserCallOptions = {}): Promise<void> {
    const result = await this.call('close_page', { pageId }, true, options);
    if (result.isError) throw actionFailure(result.text, 'close_page');
  }

  async readPage(pageId: number, options: BrowserCallOptions = {}): Promise<BrowserSnapshot> {
    const result = await this.call('take_snapshot', { pageId }, false, options);
    if (result.isError) throw actionFailure(result.text, 'take_snapshot');
    return this.toSnapshot(pageId, result.text);
  }

  async navigate(input: { pageId: number; url?: string;
    history?: 'back' | 'forward' | 'reload' } & BrowserCallOptions): Promise<BrowserSnapshot> {
    if (input.url !== undefined && !isAllowedNavigationUrl(input.url)) {
      throw new BrowserBackendError('BROWSER_NAVIGATION_BLOCKED',
        '只允许 http/https 地址。');
    }
    const type = input.url !== undefined ? 'url' : (input.history ?? 'reload');
    const args: Record<string, unknown> = { pageId: input.pageId, type };
    if (input.url !== undefined) args.url = input.url;
    const result = await this.call('navigate_page', args, true, input);
    // 上游把导航失败写进正文而不置 isError：必须按正文判定，否则会把失败当成功。
    if (result.isError || /unable to navigate/i.test(result.text)) {
      throw actionFailure(result.text, 'navigate_page');
    }
    return this.readPage(input.pageId, input);
  }

  async click(input: { pageId: number; uid: string; double?: boolean } & BrowserCallOptions):
  Promise<BrowserSnapshot> {
    const args: Record<string, unknown> = { pageId: input.pageId, uid: input.uid };
    if (input.double === true) args.dblClick = true;
    const result = await this.call('click', args, true, input);
    if (result.isError) throw actionFailure(result.text, 'click');
    // 不用上游的 includeSnapshot：它在导航发生之前取样，点完提交按钮拿到的仍是旧页面。
    // 动作之后重新读取，并等页面稳定（见 settledSnapshot）。
    return this.settledSnapshot(input.pageId, input);
  }

  async fill(input: { pageId: number; uid: string; text: string } & BrowserCallOptions):
  Promise<BrowserSnapshot> {
    const result = await this.call('fill', {
      pageId: input.pageId, uid: input.uid, value: input.text,
    }, true, input);
    if (result.isError) throw actionFailure(result.text, 'fill');
    return this.settledSnapshot(input.pageId, input);
  }

  async pressKey(input: { pageId: number; key: string } & BrowserCallOptions):
  Promise<BrowserSnapshot> {
    const result = await this.call('press_key', {
      pageId: input.pageId, key: input.key,
    }, true, input);
    if (result.isError) throw actionFailure(result.text, 'press_key');
    return this.settledSnapshot(input.pageId, input);
  }

  async waitFor(input: { pageId: number; text: string; timeoutMs: number } & BrowserCallOptions):
  Promise<BrowserSnapshot> {
    const result = await this.call('wait_for', {
      pageId: input.pageId, text: input.text, timeout: input.timeoutMs,
    }, false, input);
    if (result.isError) throw actionFailure(result.text, 'wait_for');
    return this.readPage(input.pageId, input);
  }

  async submitForm(input: { pageId: number; uid: string } & BrowserCallOptions):
  Promise<BrowserSnapshot> {
    // 上游没有独立的 submit 工具：提交就是点提交控件。Relay 侧仍是独立工具与独立能力，
    // 因为它必须走单动作审批（不进范围授权）。
    const result = await this.call('click', { pageId: input.pageId, uid: input.uid },
      true, input);
    if (result.isError) throw actionFailure(result.text, 'click');
    return this.settledSnapshot(input.pageId, input);
  }

  async uploadFile(input: { pageId: number; uid: string; absolutePath: string }
  & BrowserCallOptions): Promise<BrowserSnapshot> {
    const result = await this.call('upload_file', {
      pageId: input.pageId, uid: input.uid, filePaths: [input.absolutePath],
    }, true, input);
    if (result.isError) throw actionFailure(result.text, 'upload_file');
    return this.settledSnapshot(input.pageId, input);
  }

  async screenshot(pageId: number, options: BrowserCallOptions = {}):
  Promise<BrowserScreenshotSummary> {
    const result = await this.call('take_screenshot', { pageId, format: 'png' }, false, options);
    if (result.isError) throw actionFailure(result.text, 'take_screenshot');
    const image = result.images[0];
    if (image === undefined) {
      throw new BrowserBackendError('BROWSER_PROTOCOL_VIOLATION',
        '截图工具没有返回图片块。');
    }
    const size = pngSize(image.data);
    return {
      width: size?.width ?? null,
      height: size?.height ?? null,
      bytes: Buffer.from(image.data, 'base64').length,
      sha256: createHash('sha256').update(image.data, 'utf8').digest('hex'),
      mimeType: image.mimeType,
    };
  }

  async dispose(): Promise<void> {
    await this.stopChrome();
    this.healthState = null;
  }

  /**
   * 动作之后的稳定读取。
   *
   * 点击提交按钮会触发导航，而上游的 includeSnapshot 在导航提交之前取样——拿到的
   * 是「新 URL + 旧 DOM」。这里连读两次，只有当 URL 与正文都不再变化时才返回，
   * 最多多读两次（约 240ms）。读不到稳定状态时返回最后一次，并保留 truncated/元素
   * 供模型判断——不假装已经稳定。
   */
  private async settledSnapshot(pageId: number,
    options: BrowserCallOptions): Promise<BrowserSnapshot> {
    let current = await this.readPage(pageId, options);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      const next = await this.readPage(pageId, options);
      if (next.url === current.url && next.text === current.text) return next;
      current = next;
    }
    return current;
  }

  private toSnapshot(pageId: number, text: string): BrowserSnapshot {
    const parsed = parseSnapshotText(text);
    const truncated = text.length > MAX_SNAPSHOT_CHARS;
    return {
      pageId,
      url: parsed.url ?? '',
      title: parsed.title ?? '',
      // 上游 MCP 快照里没有 readyState：如实给 null，不拿「快照读到了」冒充「加载完了」。
      readyState: null,
      text: truncated ? text.slice(0, MAX_SNAPSHOT_CHARS) : text,
      truncated,
      elements: parsed.elements,
    };
  }

  private async call(name: string, args: Record<string, unknown>, mutating: boolean,
    options: BrowserCallOptions) {
    const client = this.client;
    if (client === null || !client.alive) {
      throw new BrowserBackendError('BROWSER_BACKEND_DISCONNECTED',
        '浏览器后端未就绪；请先执行一次需要浏览器的动作以重新建立连接。');
    }
    return client.callTool(name, args, {
      mutating,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  private async stopChrome(): Promise<void> {
    this.client?.dispose();
    this.client = null;
    const chrome = this.chrome;
    this.chrome = null;
    if (chrome !== null) await chrome.close();
  }

  private remember(health: BrowserHealth): BrowserHealth {
    this.healthState = health;
    return health;
  }
}

/** 上游的错误文本 → 类型化错误码。只有「元素找不到」需要单独归类，其余都是动作失败。 */
function actionFailure(text: string, tool: string): BrowserBackendError {
  const trimmed = text.trim();
  if (/uid .*not found/i.test(trimmed)) {
    return new BrowserBackendError('BROWSER_ELEMENT_NOT_FOUND',
      `${trimmed}（元素引用已失效，请重新读取页面）`);
  }
  if (/timeout|timed out/i.test(trimmed)) {
    return new BrowserBackendError('BROWSER_TIMEOUT', `${tool} 超时：${trimmed}`);
  }
  return new BrowserBackendError('BROWSER_ACTION_FAILED',
    trimmed === '' ? `${tool} 失败（上游没有给出原因）` : `${tool} 失败：${trimmed}`);
}

/** 从 CDP 的 `/json/version` 读浏览器版本；失败不影响可用性，只是少一条诊断。 */
async function readChromeVersion(port: number): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`,
      { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return null;
    const body = await response.json() as { Browser?: unknown };
    return typeof body.Browser === 'string' ? body.Browser : null;
  } catch {
    return null;
  }
}
