import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { clearActiveConversation, publishActiveConversation } from "../src/lib/activeConversation";
import { flush, mountWorkbench } from "./mountApp";

/**
 * 新会话上下文档位继承的**负向反例**（2026-10-31 收口整改的 P2 项）。
 *
 * 正向继承（A→B→C、显式选档、改 B 不动 A）由 `contextBudgetInheritance.spec.tsx` 守着；
 * 这一组专钉「来源身份本身不可信」的六类边界：
 *   A  没有当前会话——不得出现任何来源，按默认 256K 建；
 *   B  空白会话上重复新建——URL 与创建命令都不出现字面 `"null"`，也不继承已经离开的会话；
 *   C  登记器出现未定义身份——URL 与创建命令都不得出现字符串 `"undefined"`；
 *   D  无效来源身份——畸形 UUID 原样上交、由服务端按契约明确拒绝；字面 null/undefined 在
 *      界面一侧就地当作「没有来源」；来源不存在时按契约回退默认档；
 *   F  创建响应丢失后按原命令重试——command_id、冻结的来源与显式档位不变，不建第二条会话，
 *      界面切到别的会话也不改写冻结载荷。
 * （场景 E 跨 Workspace 来源是服务端职责，由 `session-context-budget` 集成测试 SB-10 守着，
 *  界面只负责原样上交来源、不猜不藏——D-1 钉的就是这份诚实。）
 *
 * 夹具是一台按真实规则工作的假服务器：UUID 校验按 HTTP 边界（TypeBox）的契约回 400，
 * 继承规则「显式档位 > 来源会话 > 256K」、命令幂等（同 command_id 回放原回执）都对齐实现。
 */

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const sessionA = "aaaa1111-1111-4111-8111-111111111111";
const sessionC = "cccc3333-3333-4333-8333-333333333333";
const missingSession = "eeee1111-1111-4111-8111-111111111111";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

interface FakeSession {
  readonly id: string;
  readonly title: string;
  readonly tier: number;
}

function response(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function fakeSessionDto(item: FakeSession) {
  return { id: item.id, workspace_id: workspaceId, project_id: projectId, task_id: taskId,
    title: item.title, status: "ACTIVE", revision: "1",
    pinned_at: null, unread_at: null, last_message_at: null, has_messages: false,
    run_state: null, conversation_mode: "AGENT", chat_mode: "CHAT",
    assistant_profile_id: null, assistant_profile_revision: null, assistant_role: null,
    remember: true, working_resource_id: null, forked_from_session_id: null,
    created_at: "2026-10-31T00:00:00Z", updated_at: "2026-10-31T00:00:00Z" };
}

/**
 * 一台有状态、有记账的假服务器。
 *
 * `calls` 记录每一次建会话请求的**原始载荷**（含失败与重试）；
 * `receipts` 按 command_id 记账：同 id 重放原回执、不新建——对齐服务端 `runIdempotentCommand`；
 * `failNextCreate` 模拟「服务端已落库但响应丢失」：回执记账后让 fetch 抛传输错误。
 */
function fakeServer(options: { readonly sessions?: readonly FakeSession[] } = {}) {
  // 不传 sessions 时给两条既有会话（A=512K、C=256K）；显式传 [] 就是真正的空白工作台。
  const defaultSessions: readonly FakeSession[] = [
    { id: sessionA, title: "A 会话", tier: 524_288 },
    { id: sessionC, title: "C 会话", tier: 262_144 }];
  const sessions = new Map<string, FakeSession>(
    (options.sessions ?? defaultSessions).map((item) => [item.id, item]));
  const createdSessions: string[] = [];
  const calls: Record<string, unknown>[] = [];
  const receipts = new Map<string, unknown>();
  const messages: string[] = [];
  let nextId = 1;
  let failNextCreate = false;
  const route = async (input: string, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? "GET";
    const body = init?.body === undefined || init.body === null
      ? {} : JSON.parse(String(init.body)) as Record<string, unknown>;
    if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "测试项目",
      project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
    if (path === `${prefix}/tasks/${taskId}`) return response({ id: taskId, project_id: projectId,
      title: "测试任务", status: "IN_PROGRESS", mode: "ME", revision: "1",
      created_at: "2026-10-31T00:00:00Z", updated_at: "2026-10-31T00:00:00Z",
      executor: { kind: "HUMAN", run_id: null, ownership_epoch: "1" },
      current_completion_id: null, waiting_reason: null, blocking_task_ids: [],
      unresolved_blocker_ids: [], allowed_actions: [],
      acceptance: { acceptance_revision: "1", objective: "补齐依据。", source: "CREATE",
        created_at: "2026-10-31T00:00:00Z", criteria: [] }, dependencies: [] });
    if (path === `${prefix}/assist-sessions` && method === "GET") {
      return response({ items: [...sessions.values()].map((item) => fakeSessionDto(item)) });
    }
    if (path === `${prefix}/assist-sessions` && method === "POST") {
      calls.push(JSON.parse(JSON.stringify(body)));
      const commandId = String(body.command_id ?? "");
      // 命令幂等：同一 command_id 重放原回执，不建第二条会话。
      const replay = receipts.get(commandId);
      if (replay !== undefined) return response(replay, 201);
      // HTTP 边界的 UUID 契约（TypeBox）：source_session_id 给了就必须是 UUID。
      const source = typeof body.source_session_id === "string" ? body.source_session_id : null;
      if (source !== null && !UUID_RE.test(source)) {
        return response({ code: "VALIDATION_FAILED", detail: "source_session_id 必须是 UUID。" }, 400);
      }
      // 真实继承规则：显式档位 > 来源会话 > 默认 256K；来源读不到回默认。
      const explicit = typeof body.context_budget_tokens === "number"
        ? body.context_budget_tokens : null;
      const tier = explicit ?? (source !== null ? sessions.get(source)?.tier ?? 262_144 : 262_144);
      const id = `dddd${String(nextId).padStart(4, "0")}-1111-4111-8111-111111111111`;
      nextId += 1;
      const created: FakeSession = { id, title: String(body.title ?? "新讨论"), tier };
      sessions.set(id, created);
      createdSessions.push(id);
      const receipt = { command_id: commandId, committed_at: "2026-10-31T00:00:00Z",
        result: { ...fakeSessionDto(created), session_id: id, id } };
      receipts.set(commandId, receipt);
      if (failNextCreate) {
        failNextCreate = false;
        throw new TypeError("模拟网络中断：创建已落库但响应丢失");
      }
      return response(receipt, 201);
    }
    const budgetMatch = /\/assist-sessions\/([^/]+)\/context-budget$/u.exec(path);
    if (budgetMatch !== null && method === "POST") {
      const target = sessions.get(budgetMatch[1]!);
      if (target === undefined) return response({ code: "RESOURCE_NOT_FOUND" }, 404);
      return response({ command_id: body.command_id, committed_at: "2026-10-31T00:00:00Z",
        result: { session_id: target.id, context_budget_tokens: Number(body.context_budget_tokens),
          revision: "2" } });
    }
    const usageMatch = /\/assist-sessions\/([^/]+)\/context-usage$/u.exec(path);
    if (usageMatch !== null) {
      const target = sessions.get(usageMatch[1]!);
      if (target === undefined) return response({ code: "RESOURCE_NOT_FOUND" }, 404);
      return response({ session_id: target.id,
        budget: { tokens: target.tier, revision: "1" }, last_call: null });
    }
    const sessionMatch = /\/assist-sessions\/([^/]+)$/u.exec(path);
    if (sessionMatch !== null) {
      const target = sessions.get(sessionMatch[1]!);
      if (target === undefined) return response({ code: "RESOURCE_NOT_FOUND" }, 404);
      return response(fakeSessionDto(target));
    }
    if (/\/assist-sessions\/[^/]+\/messages$/u.test(path)) {
      if (method === "POST") {
        const sid = /\/assist-sessions\/([^/]+)\/messages$/u.exec(path)![1]!;
        messages.push(decodeURIComponent(sid));
        return response({ command_id: body.command_id, committed_at: "2026-10-31T00:00:00Z",
          result: { session_id: decodeURIComponent(sid), user_message_id: "user-1",
            assistant_message_id: "reply-1", chat_mode: "CHAT", goal_id: null } }, 202);
      }
      return response({ items: [] });
    }
    if (/\/assist-sessions\/[^/]+\/tool-calls$/u.test(path)) return response({ items: [] });
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
    return response({ items: [], next_cursor: null });
  };
  return { route, sessions, calls, receipts, createdSessions, messages,
    get failNextCreate() { return failNextCreate; }, set failNextCreate(value: boolean) { failNextCreate = value; } };
}

async function click(element: HTMLElement | null, what: string): Promise<void> {
  if (element === null) throw new Error(`点击目标不存在：${what}`);
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush(0);
}

/** 发送首条消息并等创建流程跑完（成功或失败都要等这一轮落定）。 */
async function sendFirst(view: Awaited<ReturnType<typeof mountWorkbench>>, content: string): Promise<void> {
  await view.wrapper.get('[data-testid="assist-first-draft"]').setValue(content);
  await view.wrapper.get('[data-testid="assist-first-send"]').trigger("click");
  await flush();
}

afterEach(() => {
  resetRelayConnectionForTest();
  clearActiveConversation();
  vi.unstubAllGlobals();
});

describe("新会话档位继承的来源身份反例", () => {
  it("场景 A：空白工作台新对话不带任何来源，按默认 256K 建会话", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    const server = fakeServer({ sessions: [] });
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => server.route(input, init)));
    clearActiveConversation();

    const view = await mountWorkbench(`/agent?work=${taskId}`);
    await view.wrapper.get('[data-testid="context-new-conversation"]').trigger("click");
    await flush();
    expect(view.router.currentRoute.value.query.source_session,
      "没有当前会话时 URL 不得带 source_session").toBeUndefined();

    await sendFirst(view, "空白起步");
    const create = server.calls.at(-1);
    expect(create, "创建命令已发出").toBeTruthy();
    expect(create, "创建命令不得携带 source_session_id").not.toHaveProperty("source_session_id");
    expect(server.createdSessions, "恰好建出一条会话").toHaveLength(1);
    expect(server.sessions.get(server.createdSessions[0]!)?.tier, "无来源按默认 256K 建").toBe(262_144);
    view.unmount();
  });

  it("场景 B：sessionId 为 null 时重复新建，URL 与创建命令都没有 null 来源，也不继承已离开的会话", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    const server = fakeServer();
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => server.route(input, init)));

    // 先打开 A（登记器= A），再离开：协作页卸载即把登记器清空（sessionId 回到 null）。
    const previous = await mountWorkbench(`/agent?work=${taskId}&session=${sessionA}`);
    previous.unmount();

    // 直接进入一条空白会话，并在它上面**重复**点「新对话」。
    const view = await mountWorkbench(`/agent?new=${crypto.randomUUID()}`);
    await view.wrapper.get('[data-testid="context-new-conversation"]').trigger("click");
    await flush();
    await view.wrapper.get('[data-testid="context-new-conversation"]').trigger("click");
    await flush();
    const query = view.router.currentRoute.value.query as Record<string, string | undefined>;
    expect(query.source_session, "URL 不得包含 source_session（更不许是字面 null）").toBeUndefined();
    expect(Object.values(query).join("&"), "URL 查询串不得出现字面 null").not.toContain("null");

    await sendFirst(view, "空白重复新建");
    const create = server.calls.at(-1);
    expect(create, "创建接口不得收到字符串 \"null\"").not.toHaveProperty("source_session_id");
    expect(server.sessions.get(server.createdSessions[0]!)?.tier,
      "已经离开的 A（512K）不得被错误继承，按默认 256K 建").toBe(262_144);
    view.unmount();
  });

  it("场景 C：登记器出现未定义身份时，重复进入新建流程也不出现字符串 \"undefined\"", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    const server = fakeServer();
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => server.route(input, init)));

    const view = await mountWorkbench(`/agent?work=${taskId}`);
    await flush();
    // 模拟异常调用方把 undefined 递进登记器：壳层的来源守卫必须把它当「没有会话」。
    publishActiveConversation({ taskId: null, sessionId: undefined as unknown as string });
    await flush();

    await view.wrapper.get('[data-testid="context-new-conversation"]').trigger("click");
    await flush();
    let query = view.router.currentRoute.value.query as Record<string, string | undefined>;
    expect(query.source_session, "未定义身份不得写进 URL").toBeUndefined();
    expect(JSON.stringify(query), "URL 查询串不得出现字面 undefined").not.toContain("undefined");

    // 重复进入新建流程：第二次同样干净。
    await view.wrapper.get('[data-testid="context-new-conversation"]').trigger("click");
    await flush();
    query = view.router.currentRoute.value.query as Record<string, string | undefined>;
    expect(query.source_session).toBeUndefined();

    await sendFirst(view, "未定义身份反例");
    expect(server.calls.at(-1), "创建命令不得携带字符串 \"undefined\" 或错误 UUID")
      .not.toHaveProperty("source_session_id");
    expect(server.sessions.get(server.createdSessions[0]!)?.tier).toBe(262_144);
    view.unmount();
  });

  it("场景 D-1：畸形来源 UUID 原样上交，由服务端按契约明确拒绝，界面不伪造成功", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    const server = fakeServer();
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => server.route(input, init)));

    const view = await mountWorkbench(`/agent?new=${crypto.randomUUID()}&source_session=not-a-uuid`);
    await sendFirst(view, "畸形来源反例");
    await flush();

    expect(server.calls.at(-1)?.source_session_id, "界面不得替服务端改写或静默丢弃畸形输入")
      .toBe("not-a-uuid");
    expect(server.createdSessions, "被拒绝的创建不得建出会话").toEqual([]);
    expect(document.querySelector('[data-testid="assist-create-error"]'),
      "明确拒绝必须让用户看见").not.toBeNull();
    view.unmount();
  });

  it("场景 D-2：URL 里的字面 null/undefined 来源就地当作没有来源，创建命令不收到这些字符串", async () => {
    for (const bogus of ["null", "undefined", ""]) {
      activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
      const server = fakeServer();
      vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => server.route(input, init)));

      const view = await mountWorkbench(`/agent?new=${crypto.randomUUID()}&source_session=${bogus}`);
      await sendFirst(view, `字面来源反例：${bogus}`);
      await flush();
      expect(server.calls.at(-1), `source_session=${bogus || "(空)"} 不得进创建命令`)
        .not.toHaveProperty("source_session_id");
      expect(server.sessions.get(server.createdSessions[0]!)?.tier,
        "没有可信来源就按默认 256K 建").toBe(262_144);
      view.unmount();
      vi.unstubAllGlobals();
    }
  });

  it("场景 D-3：来源不存在（合法 UUID、无此行）——按契约回退默认档建会话，不崩溃", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    const server = fakeServer();
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => server.route(input, init)));

    const view = await mountWorkbench(`/agent?new=${crypto.randomUUID()}&source_session=${missingSession}`);
    await sendFirst(view, "来源已被删除");
    await flush();

    expect(server.calls.at(-1)?.source_session_id, "来源身份原样上交").toBe(missingSession);
    expect(server.createdSessions, "来源不存在不是错误：按默认档建出来").toHaveLength(1);
    expect(server.sessions.get(server.createdSessions[0]!)?.tier, "回退默认 256K").toBe(262_144);
    expect(document.querySelector('[data-testid="assist-create-error"]'), "不得把回退当失败报错")
      .toBeNull();
    view.unmount();
  });

  it("场景 F：创建响应丢失后按原命令重试——命令、来源、档位冻结，不建第二条会话", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    const server = fakeServer();
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => server.route(input, init)));

    const view = await mountWorkbench(`/agent?work=${taskId}&session=${sessionA}`);
    await view.wrapper.get('[data-testid="context-new-conversation"]').trigger("click");
    await flush();
    expect(view.router.currentRoute.value.query.source_session).toBe(sessionA);
    // 显式选 1024K（随建会话命令冻结），再把首条发出去——第一次创建「已落库但响应丢失」。
    await view.wrapper.get('[data-testid="assist-context-meter"]').trigger("click");
    await flush();
    await view.wrapper.get('[data-testid="context-budget-option-1048576"]').setValue(true);
    await flush();
    server.failNextCreate = true;
    await sendFirst(view, "响应丢失后的重试");
    await flush();
    expect(server.calls, "第一次创建已到达服务端并记账").toHaveLength(1);
    expect(view.wrapper.get('[data-testid="assist-first-create-pending"]').exists(),
      "响应丢失后必须出现「创建结果待核对」的未决条").toBe(true);

    // 在途未决时把界面切到另一条会话：冻结的载荷不得跟着界面换来源。
    await view.router.push(`/agent?work=${taskId}&session=${sessionC}`);
    await flush();
    // 未决条的点击目标在内部「查看核对」按钮上；弹窗本体经 AppDialog portal 到 body。
    await click(document.querySelector('[data-testid="assist-first-create-pending"] button'),
      "未决条上的「查看核对」按钮");
    await flush();
    await click(document.querySelector('[data-testid="assist-first-create-retry"]'), "重试按钮");
    await flush(120);

    expect(server.calls, "重试恰好再发一次创建调用").toHaveLength(2);
    const [first, retry] = server.calls as [Record<string, unknown>, Record<string, unknown>];
    expect(retry.command_id, "command_id 不变").toBe(first.command_id);
    expect(retry.source_session_id, "冻结的来源身份不变（不读界面当前那条 C）").toBe(sessionA);
    expect(retry.context_budget_tokens, "冻结的显式档位不变").toBe(1_048_576);
    expect(retry).toEqual(first);
    // 服务端按同一 command_id 幂等回放：没有建出第二条会话。
    expect(server.createdSessions, "不重复创建第二条会话").toHaveLength(1);
    const createdId = server.createdSessions[0]!;
    expect(server.sessions.get(createdId)?.tier).toBe(1_048_576);
    // 首条消息随后按原计划送达，且属于建出来的那条会话。
    expect(server.messages, "重试成功后首条消息送达").toEqual([createdId]);
    view.unmount();
  });
});
