/**
 * BrowserProvider：浏览器操作的唯一抽象（F26）。
 *
 * 上层（session-manager / adapter / Gateway）只认这个接口，不认 MCP，也不认
 * chrome-devtools-mcp 的工具名。换后端（例如将来接 chrome-use 或自建 CDP 客户端）
 * 只需要新增一个实现类，工具词表、权限模型与 UI 都不动。
 *
 * 页面身份用数字 `pageId`：上游的 `pageId` 就是数字，模型面对的工具参数是字符串，
 * 转换只发生在适配层一处——不要让两个层各自解释同一个标识。
 */

export type BrowserHealthStatus =
  | 'READY'
  | 'CHROME_MISSING'
  | 'BACKEND_MISSING'
  | 'INCOMPATIBLE'
  | 'DISCONNECTED';

export interface BrowserHealth {
  readonly status: BrowserHealthStatus;
  /** 上游后端版本（例如 1.11.0）；不可用时为 null。 */
  readonly backendVersion: string | null;
  /** Chrome 实际版本；尚未启动或不可用时为 null。 */
  readonly chromeVersion: string | null;
  /** 上游实际暴露的工具名（自检用）。 */
  readonly tools: readonly string[];
  /** 人类可读的状态说明。 */
  readonly detail: string;
  /** 可操作的修复建议；READY 时为 null。 */
  readonly remediation: string | null;
}

export interface BrowserPageRef {
  readonly pageId: number;
  readonly url: string;
  readonly title: string;
}

/** 快照里的一个元素。`inForm` 由祖先链推导，供风险分类使用。 */
export interface BrowserElement {
  readonly uid: string;
  readonly role: string;
  readonly name: string;
  readonly inForm: boolean;
}

export interface BrowserSnapshot {
  readonly pageId: number;
  readonly url: string;
  readonly title: string;
  /**
   * 页面的 `document.readyState`：`loading` / `interactive` / `complete`。
   *
   * 读页面要能回答「还在加载吗」——只看快照正文分不出「页面就这些内容」和
   * 「内容还没渲染出来」。后端不提供时为 `null`（不猜成 `complete`）。
   */
  readonly readyState: 'loading' | 'interactive' | 'complete' | null;
  /** 有界快照正文（已按 MAX_SNAPSHOT_CHARS 截断）。 */
  readonly text: string;
  readonly truncated: boolean;
  readonly elements: readonly BrowserElement[];
}

export interface BrowserScreenshotSummary {
  readonly width: number | null;
  readonly height: number | null;
  readonly bytes: number;
  readonly sha256: string;
  readonly mimeType: string;
}

export interface BrowserCallOptions {
  readonly signal?: AbortSignal;
}

export interface BrowserProvider {
  readonly kind: string;
  /** 启动并完成自检；幂等。 */
  ensureStarted(options?: BrowserCallOptions): Promise<BrowserHealth>;
  health(): Promise<BrowserHealth>;
  listPages(options?: BrowserCallOptions): Promise<readonly BrowserPageRef[]>;
  /** 新建页并返回它；`url` 缺省用 about:blank。 */
  newPage(input: { url?: string } & BrowserCallOptions): Promise<BrowserPageRef>;
  closePage(pageId: number, options?: BrowserCallOptions): Promise<void>;
  readPage(pageId: number, options?: BrowserCallOptions): Promise<BrowserSnapshot>;
  navigate(input: { pageId: number; url?: string; history?: 'back' | 'forward' | 'reload' }
    & BrowserCallOptions): Promise<BrowserSnapshot>;
  click(input: { pageId: number; uid: string; double?: boolean } & BrowserCallOptions):
    Promise<BrowserSnapshot>;
  fill(input: { pageId: number; uid: string; text: string } & BrowserCallOptions):
    Promise<BrowserSnapshot>;
  pressKey(input: { pageId: number; key: string } & BrowserCallOptions): Promise<BrowserSnapshot>;
  waitFor(input: { pageId: number; text: string; timeoutMs: number } & BrowserCallOptions):
    Promise<BrowserSnapshot>;
  /** 提交表单：上游就是点提交控件，但它是独立工具与独立能力（永不进范围授权）。 */
  submitForm(input: { pageId: number; uid: string } & BrowserCallOptions): Promise<BrowserSnapshot>;
  uploadFile(input: { pageId: number; uid: string; absolutePath: string } & BrowserCallOptions):
    Promise<BrowserSnapshot>;
  screenshot(pageId: number, options?: BrowserCallOptions): Promise<BrowserScreenshotSummary>;
  dispose(): Promise<void>;
}

/** 快照正文上限：超过就截断并显式标记，不把整棵 a11y 树塞进上下文。 */
export const MAX_SNAPSHOT_CHARS = 12_000;

/**
 * 页面列表的**回显**上限：正常任务不会开几十个页，超出说明状态异常。
 *
 * 截断只在适配层做一次（同时置 `truncated`）：Provider 若先自行 slice，适配层看到的
 * 长度永远不超过上限，「截断已发生」这个事实就再也表达不出来——工具描述承诺的
 * 「页面很多时会截断并显式标记」会静默失效。
 */
export const MAX_PAGES = 32;
