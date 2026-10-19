/**
 * 最小 MCP stdio 客户端（F26）。
 *
 * 只实现本功能用到的协议面：`initialize` / `notifications/initialized` / `tools/list` /
 * `tools/call` / `notifications/cancelled`。resources、prompts、sampling、elicitation、
 * roots 与 HTTP/SSE 传输都不实现——浏览器能力不需要它们，而每多实现一块就多一份
 * 需要跟着上游漂移的协议面。
 *
 * 传输是换行分隔的 JSON-RPC 2.0（MCP stdio 的规定），与既有
 * `computer/runtime-client.ts` 的 JSON-lines 客户端同构，生命周期纪律也照抄：
 *   * 懒启动：第一次调用才 spawn；
 *   * 请求之间保持进程存活；
 *   * 崩溃即断开：进程退出让所有在途请求以 BACKEND_DISCONNECTED 失败；
 *   * 超时即杀进程：单请求超时后整进程终止，由下一次调用重建，绝不把可能卡死的
 *     进程留着继续派发；
 *   * 取消不杀进程：只发 `notifications/cancelled` 并解除本次等待——已发出的动作
 *     可能已经产生外部效果，杀掉进程只会把「结果未知」变成「无法回收」。
 */

import { spawn } from 'node:child_process';

import { BROWSER_REQUEST_TIMEOUT_MS } from './config.js';
import type { BrowserErrorCode } from './protocol.js';

/** 传输类失败可重试（重建进程后再来）；请求类失败重试同样结果，不可重试。 */
const RETRYABLE_CODES: ReadonlySet<BrowserErrorCode> = new Set<BrowserErrorCode>([
  'BROWSER_BACKEND_UNAVAILABLE',
  'BROWSER_BACKEND_DISCONNECTED',
  'BROWSER_TIMEOUT',
]);

export class BrowserBackendError extends Error {
  override readonly name = 'BrowserBackendError';
  constructor(readonly code: BrowserErrorCode, message: string,
    readonly retryable: boolean = RETRYABLE_CODES.has(code),
    /**
     * 请求已写入管道但结果未拿到：外部效果可能已发生。
     *
     * 只有调用方（适配器）能判断这算不算 UNKNOWN——读类动作可以安全重读，
     * 写类动作必须按 UNKNOWN 结算。
     */
    readonly effectUncertain = false) {
    super(message);
  }
}

/** 客户端只依赖的最小进程形状；node ChildProcess 由默认 spawn 适配。 */
export interface McpProcessLike {
  stdin: { write(data: string): unknown; end(): void } | null;
  stdout: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null;
  stderr: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit' | 'close', listener: (code: number | null) => void): unknown;
  kill(): boolean;
}

export type SpawnMcpProcess = (executable: string, args: readonly string[],
  env: Record<string, string | undefined>) => McpProcessLike;

export interface McpToolDescriptor {
  readonly name: string;
  readonly description: string;
  /** 上游 schema 原样保留：映射表只按参数名读取，不重新实现校验。 */
  readonly inputSchema: unknown;
}

export interface McpToolResult {
  /** 文本块拼起来的正文（上游的主要输出形式）。 */
  readonly text: string;
  /** 图片块（base64）与 mime 类型；截图工具会带一块。 */
  readonly images: readonly { readonly mimeType: string; readonly data: string }[];
  /** `--experimentalStructuredContent` 开启时上游附带的机器可读结果。 */
  readonly structured: unknown;
  readonly isError: boolean;
}

export interface McpClientOptions {
  /** 跑 MCP 的 Node 可执行文件（随包 node.exe）。 */
  readonly nodeExecutable: string;
  /** MCP 入口脚本的绝对路径。 */
  readonly entry: string;
  readonly args: readonly string[];
  readonly env: Record<string, string | undefined>;
  readonly requestTimeoutMs?: number;
  /** 单行上限：一张 4K 截图 base64 约 20MB，给 32MB 余量。 */
  readonly maxLineBytes?: number;
  /** 测试接缝：默认 spawn 真实子进程。 */
  readonly spawnProcess?: SpawnMcpProcess;
  /** 诊断：上游 stderr 的行回调（不落账本，只进日志）。 */
  readonly onStderr?: (line: string) => void;
}

interface PendingCall {
  readonly resolve: (result: Record<string, unknown>) => void;
  readonly reject: (error: BrowserBackendError) => void;
  timer: NodeJS.Timeout;
  /** 请求行是否已写入管道：写入后断开意味着效果可能已发生。 */
  written: boolean;
  /** 是否会改外部状态（只有 `tools/call` 里的写类动作会）。 */
  readonly mutating: boolean;
}

const DEFAULT_MAX_LINE_BYTES = 32 * 1024 * 1024;

/** MCP 协议版本：与实测的上游握手结果一致（1.11.0 返回 2025-06-18）。 */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

export class McpStdioClient {
  private child: McpProcessLike | null = null;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private readonly timeoutMs: number;
  private readonly maxLineBytes: number;
  private serverInfo: { name: string; version: string } | null = null;

  constructor(private readonly options: McpClientOptions) {
    this.timeoutMs = options.requestTimeoutMs ?? BROWSER_REQUEST_TIMEOUT_MS;
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  }

  get alive(): boolean {
    return this.child !== null;
  }

  get version(): string | null {
    return this.serverInfo?.version ?? null;
  }

  /** 启动进程并完成 MCP 握手；重复调用幂等。 */
  async start(): Promise<{ name: string; version: string }> {
    if (this.child !== null && this.serverInfo !== null) return this.serverInfo;
    const spawnProcess: SpawnMcpProcess = this.options.spawnProcess ?? defaultSpawn;
    let child: McpProcessLike;
    try {
      child = spawnProcess(this.options.nodeExecutable,
        [this.options.entry, ...this.options.args], this.options.env);
    } catch (error) {
      throw new BrowserBackendError('BROWSER_BACKEND_UNAVAILABLE',
        `无法启动浏览器后端：${error instanceof Error ? error.message : String(error)}`);
    }
    this.child = child;
    this.buffer = '';
    this.attach(child);
    const init = await this.send('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'relay-agent', version: '0.1.0' },
    }, false);
    const info = asRecord(init.serverInfo) ?? {};
    this.serverInfo = {
      name: typeof info.name === 'string' ? info.name : 'unknown',
      version: typeof info.version === 'string' ? info.version : 'unknown',
    };
    this.notify('notifications/initialized', {});
    return this.serverInfo;
  }

  async listTools(): Promise<readonly McpToolDescriptor[]> {
    const result = await this.send('tools/list', {}, false);
    const tools = Array.isArray(result.tools) ? result.tools : [];
    return tools.map((tool) => {
      const record = asRecord(tool) ?? {};
      return {
        name: typeof record.name === 'string' ? record.name : '',
        description: typeof record.description === 'string' ? record.description : '',
        inputSchema: record.inputSchema,
      };
    }).filter((tool) => tool.name !== '');
  }

  /**
   * 调用一个上游工具。
   *
   * `mutating` 只影响「取消/断开时是否标记效果未知」，不影响协议本身。
   */
  async callTool(name: string, args: Record<string, unknown>,
    input: { readonly signal?: AbortSignal; readonly mutating: boolean } = { mutating: false },
  ): Promise<McpToolResult> {
    if (this.child === null) {
      throw new BrowserBackendError('BROWSER_BACKEND_UNAVAILABLE', '浏览器后端尚未启动。');
    }
    const raw = await this.send('tools/call', { name, arguments: args }, input.mutating,
      input.signal);
    return toToolResult(raw);
  }

  /** 主动结束：用于超时、崩溃恢复与进程退出。 */
  dispose(): void {
    const child = this.child;
    this.child = null;
    this.serverInfo = null;
    this.buffer = '';
    this.failAll(new BrowserBackendError('BROWSER_BACKEND_DISCONNECTED',
      '浏览器后端已关闭。', true, false));
    if (child !== null) {
      try { child.stdin?.end(); } catch { /* 已关闭 */ }
      try { child.kill(); } catch { /* 已退出 */ }
    }
  }

  private attach(child: McpProcessLike): void {
    child.stdout?.on('data', (chunk: Buffer) => { this.consume(chunk); });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (this.options.onStderr === undefined) return;
      for (const line of chunk.toString('utf8').split('\n')) {
        const text = line.trim();
        if (text !== '') this.options.onStderr(text.slice(0, 500));
      }
    });
    child.on('error', (error: Error) => {
      if (this.child !== child) return;
      this.failAll(new BrowserBackendError('BROWSER_BACKEND_UNAVAILABLE',
        `浏览器后端进程错误：${error.message}`, true, false));
    });
    const onExit = (): void => {
      if (this.child !== child) return;
      this.child = null;
      this.serverInfo = null;
      this.failAll(new BrowserBackendError('BROWSER_BACKEND_DISCONNECTED',
        '浏览器后端进程已退出。', true, true));
    };
    child.on('exit', onExit);
    child.on('close', onExit);
  }

  private consume(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    if (!this.buffer.includes('\n') && Buffer.byteLength(this.buffer, 'utf8') > this.maxLineBytes) {
      // 单行超限：多半是截图正文。断开而不是继续吞内存——下一次调用会重建进程。
      this.failAll(new BrowserBackendError('BROWSER_PROTOCOL_VIOLATION',
        `浏览器后端单行响应超过 ${this.maxLineBytes} 字节。`, false, true));
      this.dispose();
      return;
    }
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.trim() !== '') this.dispatch(line);
      index = this.buffer.indexOf('\n');
    }
  }

  private dispatch(line: string): void {
    let message: Record<string, unknown> | null;
    try {
      message = asRecord(JSON.parse(line));
    } catch {
      // 非 JSON 行：上游偶尔会在 stdout 打诊断文本，忽略而不是当成协议错误。
      this.options.onStderr?.(`non-json stdout: ${line.slice(0, 200)}`);
      return;
    }
    if (message === null) return;
    const id = typeof message.id === 'number' ? message.id : null;
    if (id === null) return; // 通知与上游请求都不影响在途调用
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    const error = asRecord(message.error);
    if (error !== null) {
      pending.reject(new BrowserBackendError('BROWSER_ACTION_FAILED',
        typeof error.message === 'string' ? error.message : JSON.stringify(error),
        false, pending.mutating));
      return;
    }
    pending.resolve(asRecord(message.result) ?? {});
  }

  private notify(method: string, params: Record<string, unknown>): void {
    const child = this.child;
    if (child === null) return;
    try {
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    } catch { /* 进程已退出：调用方会在下一次请求时看到断开 */ }
  }

  private send(method: string, params: Record<string, unknown>, mutating: boolean,
    signal?: AbortSignal): Promise<Record<string, unknown>> {
    const child = this.child;
    if (child === null) {
      return Promise.reject(new BrowserBackendError('BROWSER_BACKEND_UNAVAILABLE',
        '浏览器后端尚未启动。'));
    }
    if (signal?.aborted === true) {
      return Promise.reject(new BrowserBackendError('BROWSER_USER_CANCELLED',
        '动作在派发前已被取消。', false, false));
    }
    const id = this.nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BrowserBackendError('BROWSER_TIMEOUT',
          `浏览器后端在 ${this.timeoutMs} ms 内没有响应 ${method}。`, true, mutating));
        // 超时即杀掉整个进程：留着可能卡死的进程继续派发比重建更危险。
        this.dispose();
      }, this.timeoutMs);
      const entry: PendingCall = { resolve, reject, timer, written: false, mutating };
      this.pending.set(id, entry);
      signal?.addEventListener('abort', () => {
        const live = this.pending.get(id);
        if (live === undefined) return;
        this.pending.delete(id);
        clearTimeout(live.timer);
        // 协议原生取消：让上游停止处理，而不是靠杀进程。
        this.notify('notifications/cancelled', { requestId: id, reason: 'user cancelled' });
        reject(new BrowserBackendError('BROWSER_USER_CANCELLED',
          '动作已被取消；已发出的请求效果未知，需重新观察页面。', false, live.written));
      }, { once: true });
      // 先记"已写出"再写：管道写入后立即失败（进程已死、对端同步报错）同样意味着
      // 请求可能已被处理，不能因为异常发生在 write 内部就把它当成"没发出去"。
      entry.written = true;
      try {
        child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new BrowserBackendError('BROWSER_BACKEND_DISCONNECTED',
          `写入浏览器后端失败：${error instanceof Error ? error.message : String(error)}`,
          true, false));
      }
    });
  }

  private failAll(error: BrowserBackendError): void {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new BrowserBackendError(error.code, error.message, error.retryable,
        entry.written && entry.mutating));
    }
  }
}

function defaultSpawn(executable: string, args: readonly string[],
  env: Record<string, string | undefined>): McpProcessLike {
  return spawn(executable, [...args], { stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function toToolResult(result: Record<string, unknown>): McpToolResult {
  const content = Array.isArray(result.content) ? result.content : [];
  const texts: string[] = [];
  const images: { mimeType: string; data: string }[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record === null) continue;
    if (record.type === 'text' && typeof record.text === 'string') texts.push(record.text);
    if (record.type === 'image' && typeof record.data === 'string') {
      images.push({ mimeType: typeof record.mimeType === 'string' ? record.mimeType : 'image/png',
        data: record.data });
    }
  }
  return {
    text: texts.join('\n'),
    images,
    structured: result.structuredContent,
    isError: result.isError === true,
  };
}
