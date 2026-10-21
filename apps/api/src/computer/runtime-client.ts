/**
 * Computer Runtime 客户端：一个长生命周期的 JSON-lines 子进程的管理者。
 *
 * 生命周期契约（docs/architecture/computer-plugin-v1.md §运行时）：
 *   * 懒启动——第一次工具请求才 spawn，不随 API 启动常驻；
 *   * 会话内保持——请求之间不退出， idle 超过 idleReapMs 才回收；
 *   * 崩溃即断开——进程退出立即让在途请求失败：已写入请求的外部效果可能已发生，
 *     按「效果未知」结算；未写入的按 RUNTIME_UNAVAILABLE 安全失败。下一次请求
 *     重新 spawn（运行时每请求无状态，重连不继承任何半应用动作）；
 *   * 启动失败即未派发——进程根本没起来（可执行文件不存在等）时，在途请求一律
 *     RUNTIME_UNAVAILABLE：没有派发就没有外部副作用，不该让用户去核对一次
 *     没发生过的桌面动作；
 *   * 超时即杀掉——单请求超时后整个进程终止并由下一个请求重建，绝不留着
 *     一个可能已卡死的进程继续派发；
 *   * 取消不杀进程——abort 只解除本次等待；进行中的输入动作可能已产生外部
 *     效果，杀掉进程只会把「结果未知」变成「结果未知且无法回收」。
 *
 * 测试通过 spawnProcess 接缝注入受控假进程，不依赖真实二进制。
 */

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { TextDecoder } from 'node:util';

import {
  COMPUTER_PROTOCOL_VERSION,
  isComputerErrorCode,
  type ComputerEnvironment,
  type ComputerMethod,
} from './protocol.js';
import { computerRuntimeExecutable, computerRuntimeMode, computerRuntimeUnavailableReason }
  from './config.js';

/** 客户端自身的失败码：IPC_DISCONNECTED 是 API 侧概念，运行时词表里没有。 */
export type ComputerClientCode =
  | 'INVALID_REQUEST'
  | 'RUNTIME_UNAVAILABLE'
  | 'IPC_DISCONNECTED'
  | 'TIMEOUT'
  | 'USER_CANCELLED'
  | 'PROTOCOL_VIOLATION'
  | 'FOREGROUND_NOT_AUTHORIZED'
  | 'ISOLATED_SESSION_UNAVAILABLE'
  | 'CAPTURE_TARGET_UNAVAILABLE';

/** 传输类失败可重试（重建进程后再来）；请求类失败重试同样结果，不可重试。 */
const RETRYABLE_CODES: ReadonlySet<ComputerClientCode> = new Set([
  'RUNTIME_UNAVAILABLE', 'IPC_DISCONNECTED', 'TIMEOUT',
]);

export class ComputerRuntimeError extends Error {
  override readonly name = 'ComputerRuntimeError';
  constructor(readonly code: ComputerClientCode, message: string,
    readonly retryable = RETRYABLE_CODES.has(code),
    /** 请求已写入管道但回复丢失：外部效果可能已发生，调用方必须按 UNKNOWN 核对。 */
    readonly effectUncertain = false) {
    super(message);
  }
}

/** 客户端只依赖的最小进程形状；node ChildProcess 由默认 spawn 适配。 */
export interface ComputerRuntimeProcessLike {
  stdin: { write(data: string): unknown; end(): void } | null;
  stdout: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null;
  stderr: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null;
  /** 进程确实起来了：Node 只在 spawn 成功时发这个事件，失败时只有 'error'。 */
  on(event: 'spawn', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit' | 'close', listener: (code: number | null) => void): unknown;
  kill(): boolean;
}

export type SpawnProcess = (executable: string,
  env: Record<string, string | undefined>) => ComputerRuntimeProcessLike;

export interface ComputerRuntimeClientOptions {
  readonly executable?: string;
  readonly mode?: 'real' | 'mock';
  /** 测试接缝：默认 spawn 真实的 node 子进程。 */
  readonly spawnProcess?: SpawnProcess;
  /** 空闲回收阈值；默认 60s。 */
  readonly idleReapMs?: number;
  /** 单请求超时；默认 30s。 */
  readonly requestTimeoutMs?: number;
  /** 单行上限：一张 4K 截图的 base64 约 20MB，给 32MB 余量。 */
  readonly maxLineBytes?: number;
}

interface PendingRequest {
  readonly resolve: (result: Record<string, unknown>) => void;
  readonly reject: (error: ComputerRuntimeError) => void;
  timer: NodeJS.Timeout;
  /** 请求行是否已写入管道：写入后进程死亡意味着效果可能已发生。 */
  written: boolean;
}

const DEFAULT_IDLE_REAP_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_LINE_BYTES = 32 * 1024 * 1024;
const MAX_STDERR_CHARS = 4096;
/** 严格解码：坏字节不能被替换成 U+FFFD 后当作合法回复交给调用方。 */
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 默认 spawn：把 node 的 ChildProcess 收敛到最小进程形状。 */
const defaultSpawn: SpawnProcess = (executable, env) => {
  const child = spawn(executable, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ...env },
  });
  return {
    stdin: child.stdin === null ? null : {
      write: (data: string) => child.stdin!.write(data),
      end: () => child.stdin!.end(),
    },
    stdout: child.stdout === null ? null : {
      on: (event, listener) => child.stdout!.on(event, listener as never),
    },
    stderr: child.stderr === null ? null : {
      on: (event, listener) => child.stderr!.on(event, listener as never),
    },
    on: (event, listener) => child.on(event, listener as never),
    kill: () => child.kill(),
  };
};

export class ComputerRuntimeClient {
  private readonly executable: string;
  private readonly mode: 'real' | 'mock';
  private readonly spawnProcess: SpawnProcess;
  private readonly idleReapMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxLineBytes: number;

  private process: ComputerRuntimeProcessLike | null = null;
  /**
   * 确实起来过的进程（Node 只在 spawn 成功时发 'spawn'）。
   *
   * 它区分两件事：**进程死了**（可能已产生外部副作用）与**进程从没起来**
   * （可执行文件不存在等，请求从未派发）。后者不该按「效果未知」要求人工核对。
   */
  private readonly spawnedChildren = new WeakSet<ComputerRuntimeProcessLike>();
  private starting: Promise<ComputerRuntimeProcessLike> | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private stdoutBuffer: Buffer = Buffer.alloc(0);
  private idleTimer: NodeJS.Timeout | null = null;
  private stderrTail = '';
  private writeChain: Promise<void> = Promise.resolve();
  private disposed = false;
  private environmentCache: { readonly at: number; readonly value: ComputerEnvironment } | null = null;

  constructor(options: ComputerRuntimeClientOptions = {}) {
    this.executable = options.executable ?? computerRuntimeExecutable();
    this.mode = options.mode ?? computerRuntimeMode();
    this.spawnProcess = options.spawnProcess ?? defaultSpawn;
    this.idleReapMs = options.idleReapMs ?? DEFAULT_IDLE_REAP_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  }

  /** 运行时当前是否活着（用于只读状态查询，不触发启动）。 */
  get alive(): boolean {
    return this.process !== null;
  }

  /**
   * 发起一次运行时请求。
   *
   * 运行时reply的 success=false 也走 resolve 之外的路径：它转换为
   * ComputerRuntimeError（保留运行时的 code/message/retryable），由调用方
   * 决定如何投影给模型——协议失败与传输失败在这一层之后形状一致。
   */
  async request(method: ComputerMethod, params: Record<string, unknown>,
    options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Record<string, unknown>> {
    if (this.disposed) {
      throw new ComputerRuntimeError('RUNTIME_UNAVAILABLE', 'Computer Runtime 已关闭');
    }
    if (options.signal?.aborted === true) {
      throw new ComputerRuntimeError('USER_CANCELLED', '请求在派发前被取消');
    }
    const child = await this.ensureProcess();
    // 启动等待期间进程可能已死（spawn 后立刻崩溃、dispose、超时杀死）：
    // 此时必须放弃这次请求，绝不能把请求写进一个已经断开的管道。
    if (this.process !== child) {
      throw new ComputerRuntimeError('RUNTIME_UNAVAILABLE',
        'Computer Runtime 在启动期间断开；本次请求未派发，请重试', true);
    }
    const requestId = randomUUID();
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        // 超时杀掉整个进程：一个超时的请求意味着进程可能已卡死，留着它会
        // 污染后续所有请求。运行时无状态，下一个请求自然重启一个新进程。
        // 已写入的请求超时按「效果未知」拒绝：输入可能已经到达桌面。
        const entry = this.pending.get(requestId);
        const written = entry?.written === true;
        this.pending.delete(requestId);
        this.killProcess('request timeout');
        reject(new ComputerRuntimeError('TIMEOUT',
          `Computer Runtime 请求 ${method} 超过 ${timeoutMs}ms 未响应`, true, written));
      }, timeoutMs);
      const entry: PendingRequest = { resolve, reject, timer, written: false };
      this.pending.set(requestId, entry);
      const onAbort = () => {
        if (!this.pending.delete(requestId)) return;
        clearTimeout(timer);
        // 取消不承诺「没有效果」：写入后取消的输入可能已到达桌面，标记待核对。
        reject(new ComputerRuntimeError('USER_CANCELLED', '请求被取消', false, entry.written));
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      const line = JSON.stringify({ version: COMPUTER_PROTOCOL_VERSION, request_id: requestId,
        method, params }) + '\n';
      // 串行化写入：并发请求共享同一根管道，交错写入会产生半截 JSON 行。
      this.writeChain = this.writeChain.then(async () => {
        if (!this.pending.has(requestId)) return;
        try {
          child.stdin?.write(line);
          entry.written = true;
        } catch (error) {
          this.pending.delete(requestId);
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
          reject(new ComputerRuntimeError('IPC_DISCONNECTED',
            `写入 Computer Runtime 失败：${error instanceof Error ? error.message : String(error)}`, true));
        }
      });
    });
  }

  /**
   * 立即终止运行时进程（Esc 退出电脑操控用）。
   *
   * 与 abort 的差别：abort 只解除本次等待，在途输入会继续跑完；interrupt 直接杀掉
   * 进程——运行时进程内没有尚未派发的输入队列（每请求按 stdin 行处理），进程死亡
   * 即保证后续输入一个都不再产生。在途动作的外部效果可能已发生，按既有契约以
   * 「效果未知」结算，由调用方核对。
   */
  interrupt(): void {
    this.killProcess('interrupted by user');
  }

  /** 关闭客户端并终止进程（优雅停机用；正常运行靠 idle 回收）。 */
  dispose(): void {
    this.disposed = true;
    this.environmentCache = null;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new ComputerRuntimeError('RUNTIME_UNAVAILABLE', 'Computer Runtime 已关闭'));
      this.pending.delete(id);
    }
    this.killProcess('dispose');
  }

  /**
   * 环境与执行能力探测（V2 Phase 2）。
   *
   * 结果在客户端内做短 TTL 缓存：执行路由在 prepare 与 dispatch 两处都要读它，
   * 每次都起一次探测会把「环境事实」变成重复开销；但也不能永久缓存——
   * 子会话、DPI、显示器都可能变化。进程重建（崩溃/回收）后缓存自动失效。
   */
  async describeEnvironment(options: { signal?: AbortSignal; maxAgeMs?: number } = {}):
  Promise<ComputerEnvironment> {
    const maxAgeMs = options.maxAgeMs ?? 30_000;
    const cached = this.environmentCache;
    if (cached !== null && Date.now() - cached.at <= maxAgeMs) return cached.value;
    const reply = await this.request('computer.describe_environment', {},
      options.signal === undefined ? {} : { signal: options.signal });
    const value = reply as unknown as ComputerEnvironment;
    this.environmentCache = { at: Date.now(), value };
    return value;
  }

  private ensureProcess(): Promise<ComputerRuntimeProcessLike> {
    if (this.process !== null) return Promise.resolve(this.process);
    if (this.starting !== null) return this.starting;
    if (this.mode === 'real' && process.platform !== 'win32') {
      return Promise.reject(new ComputerRuntimeError('RUNTIME_UNAVAILABLE',
        computerRuntimeUnavailableReason()));
    }
    // spawn 同步返回进程句柄；错误经 'error' 事件异步到达（attach 后统一收口）。
    // 同步抛出（如可执行文件路径非法）也在这里收敛成 RUNTIME_UNAVAILABLE。
    let child: ComputerRuntimeProcessLike;
    try {
      child = this.spawnProcess(this.executable,
        this.mode === 'mock' ? { COMPUTER_RUNTIME_MODE: 'mock' } : {});
    } catch (error) {
      return Promise.reject(new ComputerRuntimeError('RUNTIME_UNAVAILABLE',
        `Computer Runtime 启动失败：${error instanceof Error ? error.message : String(error)}`));
    }
    this.starting = new Promise<ComputerRuntimeProcessLike>((resolve) => {
      this.attach(child);
      resolve(child);
    });
    return this.starting;
  }

  private attach(child: ComputerRuntimeProcessLike): void {
    this.process = child;
    this.starting = null;
    this.stdoutBuffer = Buffer.alloc(0);
    this.stderrTail = '';
    // spawn 成功才有 'spawn'：可执行文件不存在等启动失败只会来 'error'。
    child.on('spawn', () => { this.spawnedChildren.add(child); });
    child.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      if (this.stderrTail.length < MAX_STDERR_CHARS) {
        this.stderrTail += chunk.toString('utf8').slice(0, MAX_STDERR_CHARS - this.stderrTail.length);
      }
    });
    child.on('error', (error: Error) => {
      // spawn 失败（ENOENT 等）与运行中崩溃同 path：进程没了，在途请求全部失败。
      this.onProcessGone(child, error instanceof Error ? error.message : String(error));
    });
    child.on('exit', () => this.onProcessGone(child, 'process exited'));
    child.on('close', () => this.onProcessGone(child, 'process closed'));
  }

  private onStdout(chunk: Buffer): void {
    // 按字节缓冲到完整行再解码：管道分块可能落在多字节字符内部，
    // 逐 chunk toString 会把合法中文/emoji 变成 U+FFFD。
    this.stdoutBuffer = this.stdoutBuffer.length === 0
      ? chunk
      : Buffer.concat([this.stdoutBuffer, chunk]);
    let index = this.stdoutBuffer.indexOf(0x0a);
    while (index >= 0) {
      if (index > this.maxLineBytes) {
        this.killProcess('oversized output line');
        return;
      }
      const lineBytes = this.stdoutBuffer.subarray(0, index);
      this.stdoutBuffer = this.stdoutBuffer.subarray(index + 1);
      if (lineBytes.length > 0) {
        let line: string;
        try {
          line = STRICT_UTF8.decode(lineBytes).trim();
        } catch {
          // 非法 UTF-8 与坏 JSON 同等处理：协议已不可信，杀掉进程，
          // 在途请求按既有失联/UNKNOWN 路径结算。
          this.killProcess('reply line is not valid UTF-8');
          return;
        }
        if (line !== '') this.onLine(line);
      }
      index = this.stdoutBuffer.indexOf(0x0a);
    }
    // 没有换行的尾段也受同一字节上限约束；完整行已逐行检查并移出缓冲，
    // 不能把同一 chunk 里多条合法行的总字节数误判为单行超限。
    if (this.stdoutBuffer.length > this.maxLineBytes) {
      this.killProcess('oversized output line');
    }
  }

  private onLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // 一行无法解析的 JSON 说明协议已漂移：杀掉进程，不猜后续行的形状。
      this.killProcess('unparseable reply line');
      return;
    }
    if (!isPlainRecord(parsed)) {
      this.killProcess('reply line is not a JSON object');
      return;
    }
    const version = parsed.version;
    if (typeof version !== 'string' || version !== COMPUTER_PROTOCOL_VERSION) {
      this.killProcess(`unexpected protocol version ${String(version)}`);
      return;
    }
    const requestId = parsed.request_id;
    if (typeof requestId !== 'string' || requestId.length === 0) {
      this.killProcess('reply is missing a string request_id');
      return;
    }
    const success = parsed.success;
    if (typeof success !== 'boolean') {
      this.killProcess('reply success flag is not a boolean');
      return;
    }
    let body:
      | { ok: true; result: Record<string, unknown> }
      | { ok: false; error: { code: string; message: string; retryable: boolean } };
    if (success) {
      if (!isPlainRecord(parsed.result)) {
        this.killProcess('successful reply has a non-object result');
        return;
      }
      body = { ok: true, result: parsed.result };
    } else {
      const errorBody = parsed.error;
      if (
        !isPlainRecord(errorBody) ||
        typeof errorBody.code !== 'string' ||
        typeof errorBody.message !== 'string' ||
        typeof errorBody.retryable !== 'boolean'
      ) {
        this.killProcess('error reply has an incomplete error body');
        return;
      }
      body = { ok: false, error: {
        code: errorBody.code, message: errorBody.message, retryable: errorBody.retryable,
      } };
    }

    const entry = this.pending.get(requestId);
    if (entry === undefined) return; // 迟到或重复的回复：没有等待者，静默丢弃。
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    this.scheduleIdleReap();
    if (body.ok) {
      entry.resolve(body.result);
      return;
    }
    const error = body.error;
    const code = error.code;
    entry.reject(new ComputerRuntimeError(
      isComputerErrorCode(code) ? code as ComputerClientCode : 'RUNTIME_UNAVAILABLE',
      `${code}: ${error.message}`,
      error.retryable));
  }

  private onProcessGone(child: ComputerRuntimeProcessLike, reason: string): void {
    // 旧进程的 error/exit/close 可能晚于新进程启动：只结算事件对应的当前进程，
    // 否则迟到的 close 会清掉新进程和在途请求。
    if (this.process !== child) return;
    const detail = this.stderrTail === '' ? reason : `${reason}: ${this.stderrTail}`;
    this.process = null;
    this.starting = null;
    this.stdoutBuffer = Buffer.alloc(0);
    // 进程换了，环境事实必须重新探测（DPI/子会话/显示器都可能已变）。
    this.environmentCache = null;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      // 进程从没起来（可执行文件不存在、启动即失败）：请求确实没有派发，
      // 不能按「效果未知」要求用户去核对一次没发生过的桌面副作用。
      const neverSpawned = !this.spawnedChildren.has(child);
      // 已写入且进程确实起来过：外部效果可能已发生，按「效果未知」交给调用方核对；
      // 未写入或进程从未起来：确实没有派发，可以安全失败。
      const uncertain = entry.written && !neverSpawned;
      entry.reject(uncertain
        ? new ComputerRuntimeError('IPC_DISCONNECTED',
          `Computer Runtime 已断开（${detail}）；本次请求的效果未知，需人工核对`, true, true)
        : new ComputerRuntimeError('RUNTIME_UNAVAILABLE',
          neverSpawned
            ? `Computer Runtime 未能启动（${detail}）；本次请求未派发`
            : `Computer Runtime 已断开（${detail}）；下一次请求将重新启动`, true));
      this.pending.delete(id);
    }
  }

  private killProcess(reason: string): void {
    const child = this.process;
    if (child === null) return;
    try {
      child.kill();
    } catch {
      // kill 失败不改变「进程已不可信」的结论，在途请求照样失败。
    }
    this.onProcessGone(child, `killed (${reason})`);
  }

  private scheduleIdleReap(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    if (this.pending.size > 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.pending.size === 0) this.killProcess('idle');
    }, this.idleReapMs);
    // 不 unref：测试与 API 关闭路径都需要定时器可预测地触发或取消。
  }
}
