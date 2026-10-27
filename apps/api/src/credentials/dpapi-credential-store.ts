import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { CredentialStoreError, CredentialStoreUnavailableError, requireCredentialReference,
  type CredentialStore } from './credential-store.js';

/**
 * Windows DPAPI 凭据存储（P2 前置设施，ADR-036）。
 *
 * 进程边界：秘密只在**这一次**子进程调用的 stdin/stdout 管道里出现，不落盘明文、不进日志、
 * 不进错误消息。落盘的是 helper 用 DPAPI（当前用户作用域 + 域分隔熵）加密后的 blob。
 *
 * 失败语义：
 *   * helper 缺失 / 平台不是 Windows / 输出越界 / 超时 → `CredentialStoreUnavailableError`，
 *     调用方必须停止，**不得**退回明文或环境变量以外的来源；
 *   * 引用不存在 → `resolve` 返回 undefined（这是「未配置」，不是故障）；
 *   * helper 报错 → `CredentialStoreError(code)`，消息里只有 helper 的短消息。
 */

const PROTOCOL = 'relay-credential-v1';
const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface DpapiCredentialStoreOptions {
  /** 加密 blob 的存放目录（绝对路径）。 */
  readonly root: string;
  /** helper 可执行文件；缺省读 `RELAY_CREDENTIAL_HELPER`，再缺省按进程目录推断。 */
  readonly executable?: string | undefined;
  /** 传给 helper 的参数（生产为空；测试用 node 跑假 helper 时需要脚本路径）。 */
  readonly args?: readonly string[] | undefined;
  readonly timeoutMs?: number | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

interface HelperReply {
  readonly version?: unknown;
  readonly ok?: unknown;
  readonly exists?: unknown;
  readonly secret?: unknown;
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

export function resolveCredentialHelperExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.RELAY_CREDENTIAL_HELPER?.trim();
  if (configured !== undefined && configured !== '') return configured;
  return join(dirname(process.execPath), 'relay-credential-helper.exe');
}

export function resolveCredentialRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env.RELAY_CREDENTIAL_ROOT?.trim();
  if (configured === undefined || configured === '') return undefined;
  return isAbsolute(configured) ? resolve(configured) : undefined;
}

/**
 * 存放根的唯一解析规则：`RELAY_CREDENTIAL_ROOT` 优先，缺省 `<RELAY_DATA_ROOT>/credentials`。
 *
 * 两者都没有、或给了相对路径 → 直接抛错。凭据落进「当前工作目录」这类不确定位置不可接受：
 * 换个启动目录就会「凭据消失」，而消失的表现是「未配置」而不是故障。
 */
export function resolveCredentialRootOrThrow(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = resolveCredentialRoot(env);
  if (explicit !== undefined) return explicit;
  const configured = env.RELAY_CREDENTIAL_ROOT?.trim();
  if (configured !== undefined && configured !== '') {
    throw new CredentialStoreError('INVALID_ROOT', 'RELAY_CREDENTIAL_ROOT must be an absolute path');
  }
  const dataRoot = env.RELAY_DATA_ROOT?.trim();
  if (dataRoot === undefined || dataRoot === '') {
    throw new CredentialStoreError('INVALID_ROOT',
      'RELAY_CREDENTIAL_ROOT (or RELAY_DATA_ROOT) is required to locate stored credentials');
  }
  if (!isAbsolute(dataRoot)) {
    throw new CredentialStoreError('INVALID_ROOT', 'RELAY_DATA_ROOT must be an absolute path');
  }
  return join(resolve(dataRoot), 'credentials');
}

export function createDpapiCredentialStore(options: DpapiCredentialStoreOptions): CredentialStore {
  const root = isAbsolute(options.root)
    ? resolve(options.root)
    : (() => { throw new CredentialStoreError('INVALID_ROOT',
      'credential root must be an absolute path'); })();
  const executable = options.executable ?? resolveCredentialHelperExecutable(options.env);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function invoke(request: Record<string, unknown>): Promise<HelperReply> {
    if (process.platform !== 'win32') {
      throw new CredentialStoreUnavailableError('PLATFORM_UNSUPPORTED',
        'credential storage requires Windows DPAPI');
    }
    return new Promise<HelperReply>((resolvePromise, rejectPromise) => {
      let settled = false;
      const finish = (error?: Error, reply?: HelperReply): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error !== undefined) rejectPromise(error);
        else resolvePromise(reply!);
      };
      let child;
      try {
        child = spawn(executable, [...(options.args ?? [])],
          { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch (error) {
        rejectPromise(new CredentialStoreUnavailableError('HELPER_UNAVAILABLE',
          `credential helper could not start: ${(error as Error).message}`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        finish(new CredentialStoreUnavailableError('HELPER_TIMEOUT', 'credential helper timed out'));
      }, timeoutMs);
      child.on('error', () => finish(new CredentialStoreUnavailableError('HELPER_UNAVAILABLE',
        'credential helper is not available')));
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_OUTPUT_BYTES) {
          child.kill();
          finish(new CredentialStoreUnavailableError('HELPER_OUTPUT_TOO_LARGE',
            'credential helper output exceeded the limit'));
          return;
        }
        chunks.push(chunk);
      });
      // stderr 只用来判断「为什么起不来」，从不回传给调用方（可能含路径信息）。
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < 512) stderr += chunk.toString('utf8').slice(0, 512 - stderr.length);
      });
      child.on('close', (code) => {
        if (settled) return;
        if (code !== 0) {
          finish(new CredentialStoreUnavailableError('HELPER_EXIT',
            `credential helper exited with ${code}`));
          return;
        }
        let parsed: HelperReply;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as HelperReply;
        } catch {
          finish(new CredentialStoreUnavailableError('HELPER_PROTOCOL',
            'credential helper returned malformed output'));
          return;
        }
        if (parsed.version !== PROTOCOL) {
          finish(new CredentialStoreUnavailableError('HELPER_PROTOCOL',
            'credential helper protocol mismatch'));
          return;
        }
        finish(undefined, parsed);
      });
      child.stdin.on('error', () => finish(new CredentialStoreUnavailableError('HELPER_IO',
        'credential helper stdin failed')));
      child.stdin.end(JSON.stringify({ version: PROTOCOL, root, ...request }) + '\n');
    });
  }

  function failure(reply: HelperReply): CredentialStoreError {
    const code = typeof reply.error?.code === 'string' ? reply.error.code : 'HELPER_FAILED';
    const message = typeof reply.error?.message === 'string'
      ? reply.error.message : 'credential helper failed';
    return new CredentialStoreError(code, message);
  }

  return {
    async put(reference, secret) {
      requireCredentialReference(reference);
      if (secret.trim() === '') {
        throw new CredentialStoreError('EMPTY_SECRET', 'credential must not be empty');
      }
      const reply = await invoke({ op: 'protect', reference, secret });
      if (reply.ok !== true) throw failure(reply);
    },
    async resolve(reference) {
      requireCredentialReference(reference);
      const reply = await invoke({ op: 'resolve', reference });
      if (reply.ok === true) {
        return typeof reply.secret === 'string' ? reply.secret : undefined;
      }
      if (reply.error?.code === 'NOT_FOUND') return undefined;
      throw failure(reply);
    },
    async delete(reference) {
      requireCredentialReference(reference);
      const reply = await invoke({ op: 'delete', reference });
      if (reply.ok !== true) throw failure(reply);
    },
    async status(reference) {
      requireCredentialReference(reference);
      const reply = await invoke({ op: 'status', reference });
      if (reply.ok !== true) throw failure(reply);
      return reply.exists === true;
    },
  };
}
