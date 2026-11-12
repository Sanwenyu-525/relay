import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ClientDiagnosticReport } from "../src/api/core/http";
import {
  installFrontendDiagnostics, reportFrontendApiError, reportFrontendError,
  resetFrontendDiagnosticsForTest, setFrontendDiagnosticSender,
} from "../src/lib/frontendDiagnostics";

let delivered: ClientDiagnosticReport[] = [];

function collect(): (report: ClientDiagnosticReport) => Promise<void> {
  return async (report) => { delivered.push(report); };
}

function dispatchErrorEvent(error: unknown, message: string): void {
  const event = new Event("error") as Event & { error: unknown; message: string };
  event.error = error;
  event.message = message;
  window.dispatchEvent(event);
}

function dispatchRejection(reason: unknown): void {
  const event = new Event("unhandledrejection") as Event & { reason: unknown };
  event.reason = reason;
  window.dispatchEvent(event);
}

beforeEach(() => {
  delivered = [];
  vi.useFakeTimers();
  resetFrontendDiagnosticsForTest();
});

afterEach(() => {
  resetFrontendDiagnosticsForTest();
  vi.useRealTimers();
});

test("4xx 业务拒绝不上报，服务端 5xx 才进入诊断通道", () => {
  setFrontendDiagnosticSender(collect());

  reportFrontendApiError({
    status: 409, code: "REVISION_CONFLICT", detail: "版本冲突", requestId: null,
    method: "POST", path: "/api/v1/workspaces/w/tasks?stale=1",
  });
  expect(delivered).toHaveLength(0);

  reportFrontendApiError({
    status: 500, code: "INTERNAL_ERROR", detail: "内部错误", requestId: "req-1",
    method: "POST", path: "/api/v1/workspaces/w/tasks?stale=1",
  });
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toMatchObject({
    kind: "api_5xx", requestId: "req-1", errorCode: "INTERNAL_ERROR", status: 500,
    route: "POST /api/v1/workspaces/w/tasks",
  });
  expect(delivered[0]?.message).toContain("INTERNAL_ERROR");
});

test("无连接时最多缓存 10 条，连接就绪后一次性补交", () => {
  for (let index = 0; index < 15; index += 1) {
    reportFrontendError({ kind: "init", error: new Error(`boom-${index}`) });
  }
  setFrontendDiagnosticSender(collect());
  expect(delivered).toHaveLength(10);
  expect(delivered[0]?.message).toBe("boom-0");
});

test("同一错误 30 秒最多 5 条，窗口过后恢复", () => {
  setFrontendDiagnosticSender(collect());
  for (let index = 0; index < 10; index += 1) {
    reportFrontendError({ kind: "uncaught", error: new Error("repeat") });
  }
  expect(delivered).toHaveLength(5);

  vi.advanceTimersByTime(30_001);
  reportFrontendError({ kind: "uncaught", error: new Error("repeat") });
  expect(delivered).toHaveLength(6);
});

test("上报字段截断后仍落在服务端 maxLength 内", () => {
  setFrontendDiagnosticSender(collect());
  const error = new Error("m".repeat(5000));
  error.name = "N".repeat(300);
  reportFrontendError({
    kind: "render", error, componentStack: "c".repeat(6000),
    route: `/${"r".repeat(2000)}`, requestId: "i".repeat(200),
    errorCode: "e".repeat(300), status: 500,
  });
  expect(delivered).toHaveLength(1);
  const report = delivered[0];
  expect(report?.name?.length ?? 0).toBeLessThanOrEqual(200);
  expect(report?.message.length ?? 0).toBeLessThanOrEqual(1000);
  expect(report?.stack?.length ?? 0).toBeLessThanOrEqual(4000);
  expect(report?.componentStack?.length ?? 0).toBeLessThanOrEqual(4000);
  expect(report?.route?.length ?? 0).toBeLessThanOrEqual(500);
  expect(report?.requestId?.length ?? 0).toBeLessThanOrEqual(128);
  expect(report?.errorCode?.length ?? 0).toBeLessThanOrEqual(128);
});

test("上报发送失败不影响业务，也不产生新的异常", async () => {
  setFrontendDiagnosticSender(async () => { throw new Error("offline"); });
  expect(() => reportFrontendError({ kind: "uncaught", error: new Error("x") })).not.toThrow();
  await Promise.resolve();
  expect(true).toBe(true);
});

test("全局监听收未捕获异常与未处理拒绝，忽略主动取消", () => {
  installFrontendDiagnostics();
  setFrontendDiagnosticSender(collect());

  dispatchErrorEvent(new Error("boom"), "boom");
  dispatchRejection(Object.assign(new Error("stop"), { name: "AbortError" }));
  dispatchRejection(new Error("rejected"));

  expect(delivered.map((report) => report.kind)).toEqual(["uncaught", "unhandled_rejection"]);
});

test("重复安装不会重复上报", () => {
  installFrontendDiagnostics();
  installFrontendDiagnostics();
  setFrontendDiagnosticSender(collect());
  dispatchErrorEvent(new Error("once"), "once");
  expect(delivered).toHaveLength(1);
});
