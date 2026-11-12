import { afterEach, expect, test, vi } from "vitest";
import { RelayHttp } from "../src/api/core/http";

afterEach(() => { vi.unstubAllGlobals(); });

test("诊断上报使用固定蛇形字段与 Bearer 令牌，且不带请求体以外的自由字段", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(null, { status: 204 });
  });
  const http = new RelayHttp({ baseUrl: "http://127.0.0.1:8787", workspaceId: "ws-1", bearerToken: "secret" });
  await http.postClientDiagnostic({
    kind: "render", name: "Error", message: "boom", stack: "at x",
    componentStack: "in View", route: "/projects", requestId: "req-1",
    errorCode: "INTERNAL_ERROR", status: 500, clientTs: "2026-11-12T00:00:00.000Z",
  });

  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe("http://127.0.0.1:8787/api/v1/workspaces/ws-1/client-diagnostics");
  expect(calls[0]?.init.method).toBe("POST");
  expect(calls[0]?.init.keepalive).toBe(true);
  expect(new Headers(calls[0]?.init.headers).get("Authorization")).toBe("Bearer secret");
  const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
  expect(body).toMatchObject({
    kind: "render", name: "Error", message: "boom", stack: "at x",
    component_stack: "in View", route: "/projects", request_id: "req-1",
    error_code: "INTERNAL_ERROR", status: 500, client_ts: "2026-11-12T00:00:00.000Z",
  });
  expect(body).not.toHaveProperty("componentStack");
  expect(body).not.toHaveProperty("requestId");
});

test("诊断通道离线时静默返回，不抛传输错误", async () => {
  vi.stubGlobal("fetch", async () => { throw new Error("offline"); });
  const http = new RelayHttp({ baseUrl: "http://127.0.0.1:8787", workspaceId: "ws-1", bearerToken: "secret" });
  await expect(http.postClientDiagnostic({ kind: "init", message: "x" })).resolves.toBeUndefined();
});
