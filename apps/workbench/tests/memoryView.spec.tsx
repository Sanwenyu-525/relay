import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const memoryId = "33333333-3333-4333-8333-333333333333";
const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
const created = "2026-11-01T00:00:00.000Z";
let unmount: (() => void) | null = null;

function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function memory(overrides: Record<string, unknown> = {}) {
  return { id: memoryId, project_id: projectId, title: "包管理器约定", status: "ACTIVE",
    revision: "1", current_version: "1", text: "这个项目统一使用 pnpm。", origin: "HUMAN_CONFIRMED",
    source_kind: "MANUAL", confirmed_by: "local-user", confirmed_at: created,
    expires_at: null, effective_status: "ACTIVE", created_at: created, updated_at: created,
    memory_type: "PROJECT_FACT", scope: "PROJECT", task_id: null, memory_key: "package-manager",
    importance: 4, confidence: 90, verification: "VERIFIED", verified_at: created,
    last_accessed_at: null, stale_at: null, pinned: false, supersedes_id: null,
    superseded_by_id: null, retired_reason: null, ...overrides };
}

function stats() {
  return { total: 3, active: 2, superseded: 0, retired: 1, expired: 0, stale: 0,
    unverified: 1, failed: 0, instruction_risk: 0, pinned: 1,
    storage_bytes: 2048, index_health: { fts_index_present: true, unindexed: 0 },
    recall: { last_24h: 7, avg_latency_ms: 4, last_at: created },
    capture: { pending: 1, failed: 0, last_24h: 2 },
    maintenance: { last_at: created, runs: [] },
    types: [{ memory_type: "PROJECT_FACT", count: 1 }] };
}

function activate(): void {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
}

afterEach(() => {
  unmount?.(); unmount = null;
  resetRelayConnectionForTest(); vi.unstubAllGlobals();
});

describe("记忆管理页", () => {
  it("加载真实列表与统计，展示类型、作用域、验证状态与来源", async () => {
    activate();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).slice(root.length);
      if (path.startsWith("/memory/items")) return response(200,
        { items: [memory()], next_cursor: null, page_size: 50, sort: "updated" });
      if (path.startsWith("/memory/stats")) return response(200, stats());
      if (path.startsWith("/memory/capture-tasks")) return response(200, { items: [] });
      if (path.startsWith("/memory-settings")) return response(200, { workspace_id: workspaceId,
        recall_enabled: true, automatic_compaction: true, auto_capture: true, revision: "0" });
      if (path.startsWith("/projects")) return response(200, { items: [], next_cursor: null });
      if (path.endsWith("/revisions")) return response(200, []);
      if (path.endsWith("/provenance")) return response(200, { memory_id: memoryId, sources: [] });
      throw new Error(`Unexpected request ${path}`);
    }));
    const mounted = await mountWorkbench("/memory"); unmount = mounted.unmount;
    await flush();
    const text = mounted.wrapper.text();
    expect(text).toContain("包管理器约定");
    expect(text).toContain("项目事实");
    expect(text).toContain("已验证");
    expect(text).toContain("24h 召回");
    expect(text).toContain("7");
  });

  it("筛选与新建都提交真实查询/命令，不在前端本地伪造", async () => {
    activate();
    const calls: { method: string; path: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      calls.push({ method: init?.method ?? "GET", path, body: init?.body ?? null });
      if (path === "/memories" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return response(201, { command_id: body.command_id, committed_at: created,
          result: { memory_id: memoryId, revision: "0", version: "1", status: "ACTIVE" } });
      }
      if (path.startsWith("/memory/items")) return response(200,
        { items: [memory()], next_cursor: null, page_size: 50, sort: "updated" });
      if (path === "/memories") return response(200, [memory()]);
      if (path.startsWith("/memory/stats")) return response(200, stats());
      if (path.startsWith("/memory/capture-tasks")) return response(200, { items: [] });
      if (path.startsWith("/projects")) return response(200, { items: [], next_cursor: null });
      if (path.endsWith("/revisions")) return response(200, []);
      if (path.endsWith("/provenance")) return response(200, { memory_id: memoryId, sources: [] });
      throw new Error(`Unexpected request ${path}`);
    }));
    const mounted = await mountWorkbench("/memory"); unmount = mounted.unmount;
    await flush();
    const selects = mounted.wrapper.findAll("select");
    const typeSelect = selects.find((item) => item.findAll("option").some((option) => option.text() === "项目事实"));
    expect(typeSelect).toBeDefined();
    await typeSelect!.setValue("EXPERIENCE");
    await flush();
    expect(calls.some((call) => call.method === "GET" && call.path.includes("memory_type=EXPERIENCE"))).toBe(true);

    await mounted.wrapper.findAll("button").find((item) => item.text().includes("新建记忆"))!.trigger("click");
    await flush();
    const dialog = mounted.layer.get('[role="dialog"]');
    await dialog.findAll("input")[0]!.setValue("新的项目约定");
    await dialog.findAll("textarea")[0]!.setValue("这个项目统一使用 pnpm。");
    await dialog.findAll("button").find((item) => item.text() === "创建")!.trigger("click");
    await flush();
    const post = calls.find((call) => call.method === "POST" && call.path === "/memories");
    expect(post).toBeDefined();
    const body = JSON.parse(String(post!.body)) as Record<string, unknown>;
    expect(body.title).toBe("新的项目约定");
    expect(body.text).toBe("这个项目统一使用 pnpm。");
    expect(body.project_id).toBeNull();
    expect(body.confirmed).toBe(true);
  });
});
