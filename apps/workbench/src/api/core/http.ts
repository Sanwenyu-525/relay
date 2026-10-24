import { RelayApiError, RelayContractError, RelayTransportError } from "./errors";
import { isRecord, optionalString } from "./primitives";
import type { RelayFieldError } from "./errors";

/**
 * 客户端默认时限。它不是服务端执行预算，只是「不让界面无限停在加载中」的上界，
 * 因此必须长于服务端最长的单次请求（模型连接验证为 15 秒），否则客户端会先于服务端放弃。
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 60000;

export class RelayHttp {
  readonly #baseUrl: string;
  readonly #workspaceId: string;
  readonly #bearerToken: string;
  readonly #timeoutMs: number;

  constructor(connection: RelayApiConnection) {
    this.#baseUrl = normalizeBaseUrl(connection.baseUrl);
    this.#workspaceId = requiredText(connection.workspaceId, "workspace ID");
    this.#bearerToken = requiredText(connection.bearerToken, "Bearer 令牌");
    this.#timeoutMs = connection.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  get workspaceId(): string {
    return this.#workspaceId;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  get authHeader(): string {
    return `Bearer ${this.#bearerToken}`;
  }

  async request(path: string, init: RequestInit = {}, expectedStatus?: number): Promise<unknown> {
    const signal = boundedSignal(init.signal, this.#timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}${path}`, {
        ...init,
        signal,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.#bearerToken}`,
          ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...init.headers
        }
      });
    } catch (caught) {
      throw new RelayTransportError(transportDetail(caught, signal));
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      // 正文读不出 JSON 时不得回落到 null：成功状态也拿不到可核对的事实，必须显式失败。
      if (response.ok && init.method === "POST") {
        throw new RelayTransportError("命令响应内容未能读取，请查询原 command_id。");
      }
      if (response.ok) {
        throw new RelayContractError("响应正文不是可读取的 JSON，无法按契约核对。");
      }
      body = null;
    }
    if (!response.ok) {
      const record = isRecord(body) ? body : {};
      const conflict = isRecord(record.conflict) ? record.conflict : {};
      throw new RelayApiError({
        status: response.status,
        code: optionalString(record, "code") ?? "HTTP_ERROR",
        detail: optionalString(record, "detail") ?? `服务端返回 HTTP ${response.status}。`,
        retryable: record.retryable === true,
        retryAction: optionalString(record, "retry_action"),
        fieldErrors: fieldErrorsFrom(record),
        expectedRevision: optionalString(conflict, "expected_revision"),
        actualRevision: optionalString(conflict, "actual_revision"),
        blockingReasons: Array.isArray(conflict.blocking_reasons)
          ? conflict.blocking_reasons.filter((reason): reason is string => typeof reason === "string") : [],
        recallPaths: Array.isArray(conflict.recall_paths)
          ? conflict.recall_paths.filter((path): path is string => typeof path === "string") : []
      });
    }
    if (expectedStatus !== undefined && response.status !== expectedStatus) {
      throw new RelayTransportError(`命令响应为 HTTP ${response.status}，无法按预期核对回执。`);
    }
    return body;
  }

  /** 受授权下载返回正文本身；错误仍然是 application/problem+json。 */
  async requestText(path: string, callerSignal?: AbortSignal): Promise<string> {
    const signal = boundedSignal(callerSignal, this.#timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}${path}`, {
        headers: { Accept: "text/markdown, text/plain", Authorization: `Bearer ${this.#bearerToken}` },
        signal
      });
    } catch (caught) {
      throw new RelayTransportError(transportDetail(caught, signal));
    }

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const record = isRecord(body) ? body : {};
      throw new RelayApiError({
        status: response.status,
        code: optionalString(record, "code") ?? "HTTP_ERROR",
        detail: optionalString(record, "detail") ?? `服务端返回 HTTP ${response.status}。`,
        retryable: record.retryable === true,
        retryAction: optionalString(record, "retry_action"),
        fieldErrors: fieldErrorsFrom(record),
        expectedRevision: null,
        actualRevision: null
      });
    }

    try {
      return await response.text();
    } catch (caught) {
      // 2xx 但正文读取中断：不能让裸 TypeError 逃逸，须归入传输错误。
      throw new RelayTransportError(transportDetail(caught, signal));
    }
  }

  workspacePath(path: string): string {
    return `/api/v1/workspaces/${encodeURIComponent(this.#workspaceId)}${path}`;
  }
}

export interface RelayApiConnection {
  readonly baseUrl: string;
  readonly workspaceId: string;
  /** 仅在当前浏览器进程内存中保存，调用方不得记录或展示。 */
  readonly bearerToken: string;
  /** 缺省 60000 毫秒；调低不得短于服务端单次请求预算，否则客户端会先放弃。 */
  readonly requestTimeoutMs?: number;
}

/** 把客户端时限与调用方取消合成一个信号：调用方先取消时不等到时限，反之亦然。 */
function boundedSignal(callerSignal: AbortSignal | null | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return callerSignal === undefined || callerSignal === null
    ? timeout
    : AbortSignal.any([callerSignal, timeout]);
}

/** 超时与调用方取消都属「未拿到响应」，但原因不同，保留可诊断的区分。 */
function transportDetail(caught: unknown, signal: AbortSignal): string | undefined {
  if (signal.aborted && signal.reason?.name === "TimeoutError") {
    return "请求超时：未在客户端时限内取得完整响应。";
  }
  return caught instanceof Error ? caught.message : undefined;
}

export function fieldErrorsFrom(record: Record<string, unknown>): readonly RelayFieldError[] {
  const value = record.field_errors;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.field !== "string" || typeof item.message !== "string") {
      return [];
    }
    return [{ field: item.field, message: item.message }];
  });
}

export function normalizeBaseUrl(value: string): string {
  const raw = requiredText(value, "API base URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("API base URL 必须是完整的 http 或 https 地址。");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("API base URL 只允许 http 或 https。");
  }
  if (url.search || url.hash) {
    throw new Error("API base URL 不应包含查询参数或片段。");
  }
  return url.toString().replace(/\/$/u, "");
}

export function requiredText(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized === "") {
    throw new Error(`${name} 不能为空。`);
  }
  return normalized;
}
