import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";
import { contextCompactionWireFixture } from "./contextUsageFixture";

/**
 * 会话导航链路的来源身份（0145 / 0165）。
 *
 * 0165 之后，新会话不再继承「上下文档位」这个用户窗口配置；这里保住的是更基础的恢复语义：
 *   · A → 点「新建会话」→ 首条消息建出的 B 仍带 A 作为来源会话；
 *   · 首条之前不显示上下文圆环，也不发送任何显式窗口/档位；
 *   · B 的上下文浮层按模型真实容量报数，没有三档单选；
 *   · B 上发 `/new` 仍以 B 为来源建出 C。
 */

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const sessionA = "aaaa1111-1111-4111-8111-111111111111";
const sessionB = "bbbb2222-2222-4222-8222-222222222222";
const sessionC = "cccc3333-3333-4333-8333-333333333333";

interface FakeSession { readonly id: string; readonly title: string;
  readonly revision: number }

function response(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function fakeSessionDto(item: FakeSession) {
  return { id: item.id, workspace_id: workspaceId, project_id: projectId, task_id: taskId,
    title: item.title, status: "ACTIVE", revision: String(item.revision),
    pinned_at: null, unread_at: null, last_message_at: null, has_messages: false,
    run_state: null, conversation_mode: "AGENT", chat_mode: "CHAT",
    assistant_profile_id: null, assistant_profile_revision: null, assistant_role: null,
    remember: true, working_resource_id: null, forked_from_session_id: null,
    created_at: "2026-10-30T00:00:00Z", updated_at: "2026-10-30T00:00:00Z" };
}

function fakeServer() {
  const sessions = new Map<string, FakeSession>([
    [sessionA, { id: sessionA, title: "A 会话", revision: 1 }],
  ]);
  const created: { readonly sourceSessionId: string | null;
    readonly explicitTier: number | null }[] = [];
  let nextId = 1;
  const route = async (input: string, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? {} : JSON.parse(String(init.body)) as Record<string, unknown>;
    if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "测试项目",
      project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
    if (path === `${prefix}/tasks/${taskId}`) return response({ id: taskId, project_id: projectId,
      title: "测试任务", status: "IN_PROGRESS", mode: "ME", revision: "1",
      created_at: "2026-10-30T00:00:00Z", updated_at: "2026-10-30T00:00:00Z",
      executor: { kind: "HUMAN", run_id: null, ownership_epoch: "1" },
      current_completion_id: null, waiting_reason: null, blocking_task_ids: [],
      unresolved_blocker_ids: [], allowed_actions: [],
      acceptance: { acceptance_revision: "1", objective: "补齐依据。", source: "CREATE",
        created_at: "2026-10-30T00:00:00Z", criteria: [] }, dependencies: [] });
    if (path === `${prefix}/assist-sessions` && method === "GET") {
      return response({ items: [...sessions.values()].map((item) => fakeSessionDto(item)) });
    }
    if (path === `${prefix}/assist-sessions` && method === "POST") {
      const source = typeof body.source_session_id === "string" ? body.source_session_id : null;
      const explicit = typeof body.context_budget_tokens === "number" ? body.context_budget_tokens : null;
      created.push({ sourceSessionId: source, explicitTier: explicit });
      const id = nextId === 1 ? sessionB : sessionC;
      nextId += 1;
      const row: FakeSession = { id, title: String(body.title ?? "新讨论"), revision: 1 };
      sessions.set(id, row);
      return response({ command_id: body.command_id, committed_at: "2026-10-30T00:00:00Z",
        result: { ...fakeSessionDto(row), session_id: id, id } }, 201);
    }
    const usageMatch = /\/assist-sessions\/([^/]+)\/context-usage$/u.exec(path);
    if (usageMatch !== null) {
      const target = sessions.get(usageMatch[1]!);
      if (target === undefined) return response({ code: "RESOURCE_NOT_FOUND" }, 404);
      return response({ session_id: target.id,
        next_call: { reservation_tokens: 1_000_000, effective_window_tokens: 1_000_000,
          model_window_tokens: 1_000_000, provider_call_cap_tokens: 1_048_576,
          window_source: "MODEL_CATALOG", fallback_applied: false },
        last_call: null, compaction: contextCompactionWireFixture() });
    }
    const sessionMatch = /\/assist-sessions\/([^/]+)$/u.exec(path);
    if (sessionMatch !== null) {
      const target = sessions.get(sessionMatch[1]!);
      if (target === undefined) return response({ code: "RESOURCE_NOT_FOUND" }, 404);
      return response(fakeSessionDto(target));
    }
    if (/\/assist-sessions\/[^/]+\/messages$/u.test(path)) {
      if (method === "POST") {
        return response({ command_id: body.command_id, committed_at: "2026-10-30T00:00:00Z",
          result: { session_id: sessionB, user_message_id: "user-1", assistant_message_id: "reply-1",
            chat_mode: "CHAT", goal_id: null } }, 202);
      }
      return response({ items: [] });
    }
    if (/\/assist-sessions\/[^/]+\/tool-calls$/u.test(path)) return response({ items: [] });
    if (/\/assist-sessions\/[^/]+\/chat-commands$/u.test(path) && method === "POST") {
      const row: FakeSession = { id: sessionC, title: "C 会话", revision: 1 };
      sessions.set(sessionC, row);
      return response({ command_id: body.command_id, committed_at: "2026-10-30T00:00:00Z",
        result: { kind: "NEW_SESSION", system: "new", source_session_id: sessionB,
          session_id: sessionC, project_id: projectId, task_id: taskId, conversation_mode: "AGENT",
          assistant_profile_id: null, assistant_profile_revision: null, revision: "1" } }, 202);
    }
    if (path === `${prefix}/skill-definitions`) return response({ items: [] });
    if (path === `${prefix}/default-working-directory`) return response({ resource_id: null,
      canonical_root: null, display_name: null, write_tier: null, default_write_tier: null,
      context_budget_tokens: null, status: "UNSET", reason: null, revision: "0" });
    if (path === `${prefix}/model-port`) return response({ provider: "openai-compatible",
      configured: true, model: "gpt-4.1-mini", base_url: null, max_call_tokens: 1_000_000 });
    if (path === `${prefix}/projects`) return response({ items: [{ id: projectId, title: "测试项目",
      project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null }] });
    if (path === `${prefix}/search`) return response({ items: [], next_cursor: null });
    if (path === `${prefix}/tasks`) return response({ items: [], next_cursor: null });
    return response({ items: [], next_cursor: null });
  };
  return { route, sessions, created };
}

afterEach(() => { resetRelayConnectionForTest(); vi.unstubAllGlobals(); });

describe("会话导航链路的来源身份", () => {
  it("A → 新建 → 首条建出 B；B 的浮层按实际生效阈值报数，没有档位单选；/new 建出 C", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    const server = fakeServer();
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => server.route(input, init)));

    let view = await mountWorkbench(`/agent?work=${taskId}&session=${sessionA}`);
    await view.wrapper.get('[data-testid="context-new-conversation"]').trigger("click");
    await flush();
    expect(view.router.currentRoute.value.query.source_session).toBe(sessionA);
    expect(view.wrapper.get('[data-testid="assist-first-draft"]').exists()).toBe(true);

    await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("新建一段讨论");
    await view.wrapper.get('[data-testid="assist-first-send"]').trigger("click");
    await flush();

    const create = server.created.at(-1);
    expect(create?.sourceSessionId, "建会话必须带上跳转前所在会话").toBe(sessionA);
    expect(create?.explicitTier, "首条不再发送显式窗口/档位").toBeNull();
    expect(server.sessions.has(sessionB), "B 已建出").toBe(true);

    await view.router.push(`/agent?work=${taskId}&session=${sessionB}`);
    await flush();
    await view.wrapper.get('[data-testid="assist-context-meter"]').trigger("click");
    await flush();
    expect(view.layer.findAll('[data-testid^="context-budget-option-"]')).toHaveLength(0);
    // CONTEXT-USAGE-MINIMAL：窗口/来源行不再占默认面板；核心读数仍按实际生效阈值报数。
    expect(view.layer.get('[data-testid="context-usage-current-threshold"]').text())
      .toContain("350,000");
    expect(view.layer.findAll('[data-testid="context-compaction-window-row"]')).toHaveLength(0);

    // 收起浮层，再从 B 发 `/new`：C 仍以 B 为来源。
    await view.wrapper.get('[data-testid="assist-context-meter"]').trigger("click");
    await flush();
    await view.wrapper.get('[data-testid="assist-draft"]').setValue("/new");
    await view.wrapper.get('[data-testid="assist-send"]').trigger("click");
    await flush();
    expect(server.sessions.has(sessionC), "C 已建出").toBe(true);
    view.unmount();
  }, 15_000);

  it("首条消息之前不显示上下文圆环，也不发送任何显式档位", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    const server = fakeServer();
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => server.route(input, init)));

    const view = await mountWorkbench(`/agent?work=${taskId}&session=${sessionA}`);
    await view.wrapper.get('[data-testid="context-new-conversation"]').trigger("click");
    await flush();
    expect(view.wrapper.find('[data-testid="assist-context-meter"]').exists()).toBe(false);
    expect(view.wrapper.findAll('[data-testid^="context-budget-option-"]')).toHaveLength(0);

    await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("按来源身份跑");
    await view.wrapper.get('[data-testid="assist-first-send"]').trigger("click");
    await flush();
    expect(server.created.at(-1)?.explicitTier).toBeNull();
    expect(server.created.at(-1)?.sourceSessionId).toBe(sessionA);
    view.unmount();
  });
});
