import type { ClientDiagnosticReport } from "../api/core/http";

/**
 * 前端异常的最小化诊断上报（P0-3）。
 *
 * 只上报固定字段：错误类型、消息、栈、组件栈、当前路径、服务端追溯号与 HTTP 状态。
 * 绝不上报聊天内容、用户输入、请求体、草稿或任何存储状态。上报经过受 Bearer 保护的
 * `/client-diagnostics`，失败一律静默——诊断本身不能制造新的异常或重试循环。
 *
 * 限频分两层：这里按 (kind, name, message, status) 每 30 秒最多 5 条，服务端还有第二道
 * 窗口。初始化阶段（连接尚未建立）最多缓存 10 条，连接激活后一次性补交。
 */
type DiagnosticSender = (report: ClientDiagnosticReport) => Promise<void>;

const RATE_WINDOW_MS = 30_000;
const RATE_MAX_PER_KEY = 5;
const RATE_MAP_LIMIT = 64;
const PENDING_LIMIT = 10;
const MESSAGE_LIMIT = 1000;
const STACK_LIMIT = 4000;
const ROUTE_LIMIT = 500;

let sender: DiagnosticSender | null = null;
const pending: ClientDiagnosticReport[] = [];
const recent = new Map<string, { windowStart: number; count: number }>();
let installed = false;
let onWindowError: ((event: ErrorEvent) => void) | null = null;
let onUnhandledRejection: ((event: PromiseRejectionEvent) => void) | null = null;

export function setFrontendDiagnosticSender(next: DiagnosticSender | null): void {
  sender = next;
  if (next === null) return;
  const queued = pending.splice(0, pending.length);
  for (const report of queued) void deliver(report);
}

function deliver(report: ClientDiagnosticReport): void {
  if (sender === null) {
    if (pending.length < PENDING_LIMIT) pending.push(report);
    return;
  }
  void sender(report).catch(() => undefined);
}

function text(value: unknown, limit: number): string | undefined {
  // 截断结果必须仍落在服务端 maxLength 内：否则省略号会让整条诊断被 400 丢弃。
  return typeof value === "string" && value !== ""
    ? value.length > limit ? `${value.slice(0, Math.max(0, limit - 1))}…` : value
    : undefined;
}

function currentRoute(): string | undefined {
  return text(window.location.pathname, ROUTE_LIMIT);
}

function errorParts(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    const name = text(error.name, 200) ?? "Error";
    const message = text(error.message, MESSAGE_LIMIT) ?? "(empty message)";
    const stack = text(error.stack, STACK_LIMIT);
    return stack === undefined ? { name, message } : { name, message, stack };
  }
  if (typeof error === "string") return { name: "NonError", message: text(error, MESSAGE_LIMIT) ?? "unknown" };
  try {
    return { name: "NonError", message: text(String(error), MESSAGE_LIMIT) ?? "unknown" };
  } catch {
    return { name: "NonError", message: "unprintable value" };
  }
}

function shouldReport(report: ClientDiagnosticReport, now: number): boolean {
  const key = [report.kind, report.name ?? "", report.message.slice(0, 200),
    report.status === undefined ? "" : String(report.status)].join("|");
  const entry = recent.get(key);
  if (entry === undefined || now - entry.windowStart >= RATE_WINDOW_MS) {
    if (recent.size >= RATE_MAP_LIMIT) {
      const oldest = recent.keys().next().value;
      if (typeof oldest === "string") recent.delete(oldest);
    }
    recent.set(key, { windowStart: now, count: 1 });
    return true;
  }
  if (entry.count >= RATE_MAX_PER_KEY) return false;
  entry.count += 1;
  return true;
}

export interface FrontendErrorInput {
  readonly kind: ClientDiagnosticReport["kind"];
  readonly error: unknown;
  readonly componentStack?: string | undefined;
  readonly route?: string | undefined;
  readonly requestId?: string | undefined;
  readonly errorCode?: string | undefined;
  readonly status?: number | undefined;
}

export function reportFrontendError(input: FrontendErrorInput): void {
  try {
    const parts = errorParts(input.error);
    const report: ClientDiagnosticReport = {
      kind: input.kind,
      name: parts.name,
      message: parts.message,
      ...(parts.stack === undefined ? {} : { stack: parts.stack }),
      ...(text(input.componentStack, STACK_LIMIT) === undefined
        ? {} : { componentStack: text(input.componentStack, STACK_LIMIT) }),
      ...(text(input.route ?? currentRoute(), ROUTE_LIMIT) === undefined
        ? {} : { route: text(input.route ?? currentRoute(), ROUTE_LIMIT) }),
      ...(text(input.requestId, 128) === undefined ? {} : { requestId: text(input.requestId, 128) }),
      ...(text(input.errorCode, 128) === undefined ? {} : { errorCode: text(input.errorCode, 128) }),
      ...(input.status === undefined ? {} : { status: input.status }),
      clientTs: new Date().toISOString(),
    };
    if (!shouldReport(report, Date.now())) return;
    deliver(report);
  } catch {
    // 诊断路径自身的任何失败都不能冒泡。
  }
}

/**
 * API 层只上报服务端内部错误：4xx 是业务拒绝或校验结果，由界面按契约解释；
 * 传输失败说明服务端不可达，再经同一通道上报只会形成循环。
 */
export function reportFrontendApiError(input: {
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  readonly requestId: string | null;
  readonly method: string;
  readonly path: string;
}): void {
  if (input.status < 500) return;
  const route = `${input.method.toUpperCase()} ${input.path.split("?")[0] ?? input.path}`;
  reportFrontendError({
    kind: "api_5xx",
    error: new Error(`${input.code}: ${input.detail}`),
    route,
    requestId: input.requestId ?? undefined,
    errorCode: input.code,
    status: input.status,
  });
}

/** 全局兜底监听：未捕获异常与未处理的 Promise 拒绝。重复安装是无害的。 */
export function installFrontendDiagnostics(): void {
  if (installed) return;
  installed = true;
  onWindowError = (event) => {
    // 资源加载失败不冒泡到 window 的 ErrorEvent（没有 error），这里只收脚本异常。
    if (event.error === undefined && event.message === "") return;
    reportFrontendError({ kind: "uncaught", error: event.error ?? event.message });
  };
  onUnhandledRejection = (event) => {
    const reason = event.reason as { name?: unknown } | null;
    // 主动取消（路由切换、请求中止）是预期状态变化，不是程序缺陷。
    if (typeof reason === "object" && reason !== null && reason.name === "AbortError") return;
    reportFrontendError({ kind: "unhandled_rejection", error: event.reason });
  };
  window.addEventListener("error", onWindowError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);
}

/** 测试专用：清空发送器、队列、限频窗口并摘除全局监听。 */
export function resetFrontendDiagnosticsForTest(): void {
  if (onWindowError !== null) window.removeEventListener("error", onWindowError);
  if (onUnhandledRejection !== null) window.removeEventListener("unhandledrejection", onUnhandledRejection);
  onWindowError = null;
  onUnhandledRejection = null;
  installed = false;
  sender = null;
  pending.length = 0;
  recent.clear();
}
