import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

/**
 * 会话级上下文档位的**导航链路**继承（0145 / 2026-10-30 复审整改）。
 *
 * 这一组用例刻意不直接调后端用例：它从界面出发——
 *   A=512K → 点「新建会话」→ 空白输入器 → 发首条 → 建出来的 B 必须是 512K；
 *   B 改成 1024K → A 不受影响；
 *   B 上发 `/new` → 建出来的 C 必须是 1024K；
 *   A、B、C 各自重新打开后仍读自己的档位。
 *
 * 夹具是一台**有状态**的假服务器：它按真实规则继承档位（显式值 > 来源会话 > 256K），
 * 因此断言的是「界面走完导航后，服务端事实是什么」，而不是「界面把某个参数传对了」。
 */

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const sessionA = "aaaa1111-1111-4111-8111-111111111111";
const sessionB = "bbbb2222-2222-4222-8222-222222222222";
const sessionC = "cccc3333-3333-4333-8333-333333333333";

interface FakeSession {
  readonly id: string;
  readonly title: string;
  readonly tier: number;
  readonly revision: number;
  readonly budgetRevision: number;
}

function response(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

/** 一台按真实规则工作的假服务器：档位继承、档位 CAS、创建回执都在这里。 */
function fakeServer() {
  const sessions = new Map<string, FakeSession>([
    [sessionA, { id: sessionA, title: "A 会话", tier: 524_288, revision: 1, budgetRevision: 1 }],
  ]);
  const created: { readonly sourceSessionId: string | null;
    readonly explicitTier: number | null }[] = [];
  const budgetWrites: { readonly sessionId: string; readonly tier: number }[] = [];
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
      // 真实继承规则：显式档位 > 来源会话 > 256K。
      const source = typeof body.source_session_id === "string" ? body.source_session_id : null;
      const explicit = typeof body.context_budget_tokens === "number" ? body.context_budget_tokens : null;
      created.push({ sourceSessionId: source, explicitTier: explicit });
      const tier = explicit ?? (source === null ? 262_144 : sessions.get(source)?.tier ?? 262_144);
      const id = nextId === 1 ? sessionB : sessionC;
      nextId += 1;
      const created0: FakeSession = { id, title: String(body.title ?? "新讨论"), tier,
        revision: 1, budgetRevision: 1 };
      sessions.set(id, created0);
      return response({ command_id: body.command_id, committed_at: "2026-10-30T00:00:00Z",
        result: { ...fakeSessionDto(created0), session_id: id, id } }, 201);
    }
    const budgetMatch = /\/assist-sessions\/([^/]+)\/context-budget$/u.exec(path);
    if (budgetMatch !== null && method === "POST") {
      const id = budgetMatch[1]!;
      const target = sessions.get(id);
      if (target === undefined) return response({ code: "RESOURCE_NOT_FOUND" }, 404);
      if (String(body.expected_revision) !== String(target.budgetRevision)) {
        return response({ code: "REVISION_CONFLICT", detail: "档位已变化。",
          conflict: { expected_revision: String(body.expected_revision),
            actual_revision: String(target.budgetRevision) } }, 409);
      }
      const tier = Number(body.context_budget_tokens);
      sessions.set(id, { ...target, tier, budgetRevision: target.budgetRevision + 1 });
      budgetWrites.push({ sessionId: id, tier });
      return response({ command_id: body.command_id, committed_at: "2026-10-30T00:00:00Z",
        result: { session_id: id, context_budget_tokens: tier,
          revision: String(target.budgetRevision + 1) } });
    }
    const usageMatch = /\/assist-sessions\/([^/]+)\/context-usage$/u.exec(path);
    if (usageMatch !== null) {
      const target = sessions.get(usageMatch[1]!);
      if (target === undefined) return response({ code: "RESOURCE_NOT_FOUND" }, 404);
      return response({ session_id: target.id,
        budget: { tokens: target.tier, revision: String(target.budgetRevision) },
        last_call: null });
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
      // `/new`：以当前会话为来源建一条新会话，档位随之继承。
      const source = sessions.get(sessionB);
      const id = sessionC;
      const created0: FakeSession = { id, title: "C 会话", tier: source?.tier ?? 262_144,
        revision: 1, budgetRevision: 1 };
      sessions.set(id, created0);
      return response({ command_id: body.command_id, committed_at: "2026-10-30T00:00:00Z",
        result: { kind: "NEW_SESSION", system: "new", source_session_id: sessionB,
          session_id: id, project_id: projectId, task_id: taskId, conversation_mode: "AGENT",
          assistant_profile_id: null, assistant_profile_revision: null, revision: "1" } }, 202);
    }
    if (path === `${prefix}/skill-definitions`) return response({ items: [] });
    if (path === `${prefix}/default-working-directory`) return response({ resource_id: null,
      canonical_root: null, display_name: null, write_tier: null, default_write_tier: null,
      context_budget_tokens: null, status: "UNSET", reason: null, revision: "0" });
    if (path === `${prefix}/model-port`) return response({ provider: "openai-compatible",
      configured: true, model: "gpt-4.1-mini", base_url: null, max_call_tokens: 262_144 });
    if (path === `${prefix}/projects`) return response({ items: [{ id: projectId, title: "测试项目",
      project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null }] });
    if (path === `${prefix}/search`) return response({ items: [], next_cursor: null });
    if (path === `${prefix}/tasks`) return response({ items: [], next_cursor: null });
    if (path.startsWith(`${prefix}/assist-sessions/`) && path.endsWith("/messages")) {
      return response({ items: [] });
    }
    return response({ items: [], next_cursor: null });
  };
  return { route, sessions, created, budgetWrites };
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

afterEach(() => { resetRelayConnectionForTest(); vi.unstubAllGlobals(); });

describe("会话上下文档位的导航链路继承", () => {
  it("A=512K → 点新建 → 建出的 B=512K；改 B 不动 A；/new 建出的 C 继承 B", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    const server = fakeServer();
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => server.route(input, init));
    vi.stubGlobal("fetch", fetchMock);

    let view = await mountWorkbench(`/agent?work=${taskId}&session=${sessionA}`);
    // A 的档位是 512K（夹具事实）。
    expect(server.sessions.get(sessionA)?.tier).toBe(524_288);

    // 点左栏「新对话」：界面进入空白首条输入器（URL 带 source_session=来源会话）。
    await view.wrapper.get('[data-testid="context-new-conversation"]').trigger("click");
    await flush();
    expect(view.router.currentRoute.value.query.source_session).toBe(sessionA);
    expect(view.wrapper.get('[data-testid="assist-first-draft"]').exists()).toBe(true);

    // 发送首条：建会话命令必须带上跳转前的来源会话 A。
    await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("新建一段讨论");
    await view.wrapper.get('[data-testid="assist-first-send"]').trigger("click");
    await flush();

    const create = server.created.at(-1);
    expect(create?.sourceSessionId, "建会话必须带上跳转前所在会话").toBe(sessionA);
    expect(server.sessions.get(sessionB)?.tier, "B 继承 A 的 512K").toBe(524_288);

    // 切到 B，把 B 改成 1024K：走界面上的「选档 → 保存档位」（0145 复审恢复的交互）。
    await view.router.push(`/agent?work=${taskId}&session=${sessionB}`);
    await flush();
    await view.wrapper.get('[data-testid="assist-context-meter"]').trigger("click");
    await flush();
    await view.wrapper.get('[data-testid="context-budget-option-1048576"]').setValue(true);
    await flush();
    expect(server.budgetWrites, "只选不保存：不写服务端").toHaveLength(0);
    await view.wrapper.get('[data-testid="context-budget-save"]').trigger("click");
    await flush();
    expect(server.budgetWrites.at(-1)).toEqual({ sessionId: sessionB, tier: 1_048_576 });
    expect(server.sessions.get(sessionA)?.tier, "改 B 不能改 A").toBe(524_288);
    expect(server.sessions.get(sessionB)?.tier).toBe(1_048_576);

    // B 上发 /new：新建的 C 继承 B 的 1024K。
    await view.router.push(`/agent?work=${taskId}&session=${sessionB}`);
    await flush();
    // Close the usage popover first: it keeps focus inside itself.
    await view.wrapper.get('[data-testid="assist-context-meter"]').trigger("click");
    await flush();
    await view.wrapper.get('[data-testid="assist-draft"]').setValue("/new");
    await view.wrapper.get('[data-testid="assist-send"]').trigger("click");
    await flush();
    expect(server.sessions.get(sessionC)?.tier, "C 继承 B 的 1024K").toBe(1_048_576);
    expect(server.sessions.get(sessionA)?.tier, "A 仍是自己那一档").toBe(524_288);

    // C 自己改档：改 C 不影响 A、B（三条会话各存各的）。
    view.unmount();
    view = await mountWorkbench(`/agent?session=${sessionC}`);
    await view.wrapper.get('[data-testid="assist-context-meter"]').trigger("click");
    await flush();
    await view.wrapper.get('[data-testid="context-budget-option-262144"]').setValue(true);
    await flush();
    await view.wrapper.get('[data-testid="context-budget-save"]').trigger("click");
    await flush();
    expect(server.budgetWrites.at(-1)).toEqual({ sessionId: sessionC, tier: 262_144 });
    expect(server.sessions.get(sessionC)?.tier, "C 改成 256K").toBe(262_144);
    expect(server.sessions.get(sessionB)?.tier, "B 不受 C 影响").toBe(1_048_576);
    expect(server.sessions.get(sessionA)?.tier, "A 不受 C 影响").toBe(524_288);

    // 重新打开 A、B、C：各自读回自己的档位（界面读的是服务端投影，不是界面里的缓存）。
    for (const [id, expected] of [[sessionA, 524_288], [sessionB, 1_048_576],
      [sessionC, 262_144]] as const) {
      // Reopen means a fresh mount of the workspace (the ?session= deep link is a
      // one-shot seed, so a remount is what "reopen this session" looks like).
      view.unmount();
      const reopened = await mountWorkbench(`/agent?session=${id}`);
      await reopened.wrapper.get('[data-testid="assist-context-meter"]').trigger("click");
      await flush();
      const checked = reopened.wrapper.findAll('[data-testid^="context-budget-option-"]')
        .filter((item) => (item.element as HTMLInputElement).checked)
        .map((item) => item.attributes("data-testid"));
      expect(checked, `重新打开 ${id} 应读回自己的档位`).toEqual([
        `context-budget-option-${expected}`]);
      reopened.unmount();
    }
    view = await mountWorkbench(`/agent?work=${taskId}&session=${sessionA}`);
    view.unmount();
  }, 15_000);

  it("首条消息之前可选档位：选择随建会话命令落库，A 的档位不被改写", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    const server = fakeServer();
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => server.route(input, init));
    vi.stubGlobal("fetch", fetchMock);

    const view = await mountWorkbench(`/agent?work=${taskId}&session=${sessionA}`);
    await view.wrapper.get('[data-testid="context-new-conversation"]').trigger("click");
    await flush();
    // 空白新会话的浮层里也有三档：选 1024K 不发任何写请求，只落草稿作用域。
    await view.wrapper.get('[data-testid="assist-context-meter"]').trigger("click");
    await flush();
    const options = view.wrapper.findAll('[data-testid^="context-budget-option-"]');
    expect(options.length).toBeGreaterThanOrEqual(3);
    await view.wrapper.get('[data-testid="context-budget-option-1048576"]').setValue(true);
    await flush();
    expect(server.budgetWrites, "还没有会话时不得写档位").toHaveLength(0);

    await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("按 1024K 跑");
    await view.wrapper.get('[data-testid="assist-first-send"]').trigger("click");
    await flush();
    expect(server.created.at(-1)?.explicitTier, "显式档位随建会话命令落库").toBe(1_048_576);
    expect(server.sessions.get(sessionB)?.tier).toBe(1_048_576);
    expect(server.sessions.get(sessionA)?.tier, "来源会话不被改写").toBe(524_288);
    view.unmount();
  });

  it("B 未发送就改成 1024K：从 A 新建的 C 不捡这档，刷新同一空白会话也读得回", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    const server = fakeServer();
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => server.route(input, init));
    vi.stubGlobal("fetch", fetchMock);

    const view = await mountWorkbench(`/agent?work=${taskId}&session=${sessionA}`);
    await view.wrapper.get('[data-testid="context-new-conversation"]').trigger("click");
    await flush();
    const blankQuery = view.router.currentRoute.value.query as Record<string, string>;
    const firstBlank = `/agent?new=${encodeURIComponent(blankQuery.new ?? "-")}&work=${taskId}`;
    await view.wrapper.get('[data-testid="assist-context-meter"]').trigger("click");
    await flush();
    // P0-A：来源会话 A=512K，空白输入器直接显示 512K。
    expect((view.wrapper.get('[data-testid="context-budget-option-524288"]').element as HTMLInputElement).checked,
      "空白输入器要显示来源会话的 512K").toBe(true);
    // 在 B 的空白里选 1024K，但不发送。
    await view.wrapper.get('[data-testid="context-budget-option-1048576"]').setValue(true);
    await flush();
    expect(server.budgetWrites, "空白会话不写服务端").toHaveLength(0);

    // P0-B：刷新同一个空白会话，草稿按这个会话键读得回来。
    view.unmount();
    const reopened = await mountWorkbench(firstBlank);
    await reopened.wrapper.get('[data-testid="assist-context-meter"]').trigger("click");
    await flush();
    expect((reopened.wrapper.get('[data-testid="context-budget-option-1048576"]')
      .element as HTMLInputElement).checked, "同一个空白会话刷新后应读回草稿").toBe(true);
    reopened.unmount();

    // 再从 A 起另一条空白会话：不能捡到上面那份 1024K。
    const second = await mountWorkbench(`/agent?work=${taskId}&session=${sessionA}`);
    await second.wrapper.get('[data-testid="context-new-conversation"]').trigger("click");
    await flush();
    await second.wrapper.get('[data-testid="assist-context-meter"]').trigger("click");
    await flush();
    expect((second.wrapper.get('[data-testid="context-budget-option-524288"]')
      .element as HTMLInputElement).checked, "另一条空白会话回到来源会话的 512K").toBe(true);
    expect((second.wrapper.get('[data-testid="context-budget-option-1048576"]')
      .element as HTMLInputElement).checked, "不得串到上一条空白会话的选择").toBe(false);
    await second.wrapper.get('[data-testid="assist-first-draft"]').setValue("C 的首条");
    await second.wrapper.get('[data-testid="assist-first-send"]').trigger("click");
    await flush();
    expect(server.created.at(-1)?.explicitTier, "C 不带 B 没发出去的 1024K").toBe(524_288);
    second.unmount();
  });
});
