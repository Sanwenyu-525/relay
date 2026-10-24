import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { RelayApiClient } from "../src/api/relayClient";
import SaveMemoryDialog from "../src/components/SaveMemoryDialog";
import { sha256Hex } from "../src/lib/sha256";
import { flush, DomWrapper, mountReact } from "./mountApp";

/**
 * 「保存为长期记忆」确认层（工作台 §40）。
 *
 * 关键约束在这里被固定下来：提交的 hash 是**原消息正文**的摘要（编辑草稿不改变它）、
 * 范围只能是全局或原会话项目、失败与冲突都保留草稿。
 */

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const messageId = "44444444-4444-4444-8444-444444444444";
const memoryId = "55555555-5555-4555-8555-555555555555";
const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
const client = new RelayApiClient({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
const original = "采用 PostgreSQL 作为唯一业务数据库。\n理由：事务与恢复需要。";
let unmount: (() => void) | null = null;

afterEach(() => { unmount?.(); unmount = null; vi.unstubAllGlobals(); document.body.innerHTML = ""; });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function message(overrides: Record<string, unknown> = {}) {
  return { id: messageId, session_id: sessionId, seq: "4", role: "ASSISTANT", status: "COMPLETED",
    intent: "DISCUSS", content: original, error_code: null, sources: [],
    usage: { input_tokens: 10, output_tokens: 20 }, cancel_requested: false, steer_requested: false,
    attachments: [], created_at: "2026-10-20T00:00:00.000Z", ...overrides };
}

function memoryBody(overrides: Record<string, unknown> = {}) {
  return { id: memoryId, project_id: projectId, title: "数据库选型", status: "ACTIVE", revision: "0",
    current_version: "1", text: "采用 PostgreSQL。", confirmed_by: "local-user",
    confirmed_at: "2026-10-20T00:00:00.000Z", expires_at: null,
    created_at: "2026-10-20T00:00:00.000Z", updated_at: "2026-10-20T00:00:00.000Z",
    effective_status: "ACTIVE", ...overrides };
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function stub(handler: Handler) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init ?? {}));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** 消息列表 + 可选创建/详情/来源：默认只提供来源读取。 */
function stubConversation(options: { create?: Handler; message?: Record<string, unknown>;
  memory?: Record<string, unknown> } = {}) {
  return stub((url, init) => {
    if (url.endsWith("/messages?limit=200")) return json({ items: [message(options.message)] });
    if (init.method === "POST" && url.includes("/memories") && options.create) return options.create(url, init);
    if (url.includes(`/memories/${memoryId}/provenance`)) {
      return json({ memory_id: memoryId, sources: [{ memory_version: "1", session_id: sessionId,
        message_id: messageId, content_sha256: sha256Hex(original) }] });
    }
    if (url.endsWith(`/memories/${memoryId}`)) return json(memoryBody(options.memory));
    throw new Error(`unexpected request ${init.method ?? "GET"} ${url}`);
  });
}

async function mount(sessionProjectId: string | null = projectId) {
  const mounted = await mountReact(<MemoryRouter>
    <SaveMemoryDialog client={client} sessionId={sessionId} sessionRevision="7"
      sessionProjectId={sessionProjectId} messageId={messageId} onClose={() => undefined} />
  </MemoryRouter>);
  unmount = mounted.unmount;
  await flush();
  return mounted.wrapper;
}

function dialog(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-testid="save-memory-dialog"]');
  if (element === null) throw new Error("save-memory dialog not mounted");
  return element;
}

function field(testId: string): HTMLInputElement | HTMLTextAreaElement {
  const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-testid="${testId}"]`);
  if (element === null) throw new Error(`missing ${testId}`);
  return element;
}

/** 弹层挂在 document.body 的 portal 里：用 body 作为查询根，trigger/setValue 都走 act。 */
function portal(): DomWrapper { return new DomWrapper(document.body); }

function click(testId: string): Promise<void> {
  return portal().get(`[data-testid="${testId}"]`).trigger("click");
}

async function type(testId: string, value: string): Promise<void> {
  await portal().get(`[data-testid="${testId}"]`).setValue(value);
  await flush(10);
}

describe("来源与草稿", () => {
  it("读确切原文：显示原消息身份与正文 SHA256，标题按首行预填、正文等于原文", async () => {
    const fetchMock = stubConversation();
    await mount();
    expect(String((fetchMock.mock.calls[0] as [RequestInfo | URL])[0]))
      .toBe(`${root}/assist-sessions/${sessionId}/messages?limit=200`);
    expect(document.querySelector('[data-testid="save-memory-source-sha256"]')?.textContent)
      .toBe(sha256Hex(original));
    expect(field("save-memory-title").value).toBe("采用 PostgreSQL 作为唯一业务数据库。");
    expect(field("save-memory-text").value).toBe(original);
  });

  it("未完成的消息不能保存，并说明原因", async () => {
    stubConversation({ message: { status: "RUNNING", content: null } });
    await mount();
    expect(document.querySelector('[data-testid="save-memory-source-error"]')?.textContent)
      .toContain("只有已完成的回复或消息才能保存");
    expect(document.querySelector('[data-testid="save-memory-confirm"]')).toBeNull();
  });

  it("没有正文的消息不能保存", async () => {
    stubConversation({ message: { content: "   " } });
    await mount();
    expect(document.querySelector('[data-testid="save-memory-source-error"]')?.textContent)
      .toContain("没有可保存的正文");
  });
});

describe("确认保存", () => {
  it("编辑正文后提交：hash 仍是原文摘要，text 是编辑后的内容，范围按选择提交", async () => {
    const fetchMock = stubConversation({
      create: (_url, init) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(body).toMatchObject({ content_sha256: sha256Hex(original), confirmed: true,
          expected_session_revision: "7", project_id: projectId, text: "采用 PostgreSQL（已编辑）。" });
        return json({ command_id: body.command_id, committed_at: "2026-10-20T00:00:00.000Z",
          result: { memory_id: memoryId, revision: "0", version: "1", status: "ACTIVE" } }, 201);
      }
    });
    await mount();
    await type("save-memory-text", "采用 PostgreSQL（已编辑）。");
    await click("save-memory-confirm");
    await flush();
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(document.querySelector('[data-testid="save-memory-saved"]')).not.toBeNull();
  });

  it("保存成功后展示服务端记忆与来源，而不是本地草稿", async () => {
    stubConversation({
      create: (_url, init) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return json({ command_id: body.command_id, committed_at: "2026-10-20T00:00:00.000Z",
          result: { memory_id: memoryId, revision: "0", version: "1", status: "ACTIVE" } }, 201);
      },
      memory: { title: "服务端标题", text: "服务端正文", project_id: projectId }
    });
    await mount();
    await click("save-memory-confirm");
    await flush();
    expect(document.querySelector('[data-testid="save-memory-saved-title"]')?.textContent).toBe("服务端标题");
    expect(document.querySelector('[data-testid="save-memory-saved-text"]')?.textContent).toBe("服务端正文");
    const sources = document.querySelector('[data-testid="save-memory-saved-sources"]')?.textContent ?? "";
    expect(sources).toContain(messageId);
    expect(sources).toContain(sha256Hex(original));
  });

  it("会话没有项目归属时只能保存为全局，项目选项禁用", async () => {
    const fetchMock = stubConversation({
      create: (_url, init) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(body.project_id).toBeNull();
        return json({ command_id: body.command_id, committed_at: "2026-10-20T00:00:00.000Z",
          result: { memory_id: memoryId, revision: "0", version: "1", status: "ACTIVE" } }, 201);
      }
    });
    await mount(null);
    const project = document.querySelector<HTMLInputElement>('input[value="PROJECT"]');
    expect(project?.disabled).toBe(true);
    expect(document.querySelector<HTMLInputElement>('input[value="GLOBAL"]')?.checked).toBe(true);
    await click("save-memory-confirm");
    await flush();
    expect(fetchMock).toHaveBeenCalled();
  });

  it("409 时保留草稿并给重新读取入口，不换命令重发", async () => {
    const fetchMock = stubConversation({
      create: (_url, init) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return json({ command_id: body.command_id, code: "INVALID_TRANSITION",
          detail: "消息正文与确认时的来源不一致，请重新读取。" }, 409);
      }
    });
    await mount();
    await type("save-memory-title", "我改过的标题");
    await click("save-memory-confirm");
    await flush();
    expect(document.querySelector('[data-testid="save-memory-conflict"]')?.textContent)
      .toContain("草稿保留在这里");
    // 草稿仍在：标题还是用户写的那个，没有被重置。
    expect(field("save-memory-title").value).toBe("我改过的标题");
    const createCalls = fetchMock.mock.calls.filter((call) =>
      (call[1] as RequestInit | undefined)?.method === "POST").length;
    expect(createCalls).toBe(1);
  });

  it("明确失败（非冲突）保留草稿并可再次提交", async () => {
    let attempts = 0;
    stubConversation({
      create: (_url, init) => {
        attempts += 1;
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (attempts === 1) return json({ command_id: body.command_id,
          code: "VALIDATION_FAILED", detail: "标题过长。" }, 422);
        return json({ command_id: body.command_id, committed_at: "2026-10-20T00:00:00.000Z",
          result: { memory_id: memoryId, revision: "0", version: "1", status: "ACTIVE" } }, 201);
      }
    });
    await mount();
    await click("save-memory-confirm");
    await flush();
    expect(document.querySelector('[data-testid="save-memory-error"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="save-memory-confirm"]')).not.toBeNull();
    await click("save-memory-confirm");
    await flush();
    expect(document.querySelector('[data-testid="save-memory-saved"]')).not.toBeNull();
  });
});

describe("范围提示", () => {
  it("弹层写明不能借页面选中的其他项目扩大作用域", async () => {
    stubConversation();
    await mount();
    expect(dialog().textContent).toContain("不能借当前页面选中的其他项目扩大作用域");
  });
});

describe("结果未知", () => {
  it("响应丢失时保留原 command_id 与载荷，重试不换新 ID", async () => {
    const posts: Record<string, unknown>[] = [];
    let failNext = true;
    stub((url, init) => {
      if (url.endsWith("/messages?limit=200")) return json({ items: [message()] });
      if (init.method === "POST" && url.includes("/memories")) {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push(body);
        if (failNext) throw new TypeError("Failed to fetch");
        return json({ command_id: body.command_id, committed_at: "2026-10-20T00:00:00.000Z",
          result: { memory_id: memoryId, revision: "0", version: "1", status: "ACTIVE" } }, 201);
      }
      if (url.includes(`/memories/${memoryId}/provenance`)) {
        return json({ memory_id: memoryId, sources: [] });
      }
      if (url.endsWith(`/memories/${memoryId}`)) return json(memoryBody());
      throw new Error(`unexpected ${url}`);
    });
    await mount();
    await click("save-memory-confirm");
    await flush();
    const pending = document.querySelector('[data-testid="save-memory-pending"]')?.textContent ?? "";
    expect(pending).toContain("未核对");
    expect(pending).toContain(String(posts[0]!.command_id));
    // 结果未核清前不再发第二条新命令。
    expect(document.querySelector<HTMLButtonElement>('[data-testid="save-memory-confirm"]')?.disabled).toBe(true);
    failNext = false;
    await click("save-memory-retry");
    await flush();
    expect(posts).toHaveLength(2);
    expect(posts[1]!.command_id).toBe(posts[0]!.command_id);
    expect(posts[1]!.text).toBe(posts[0]!.text);
    expect(document.querySelector('[data-testid="save-memory-saved"]')).not.toBeNull();
  });

  it("查回执类型不是保存记忆时明确拒绝", async () => {
    stub((url, init) => {
      if (url.endsWith("/messages?limit=200")) return json({ items: [message()] });
      if (init.method === "POST" && url.includes("/memories")) throw new TypeError("Failed to fetch");
      if (/\/commands\/[^/]+$/u.test(url)) {
        return json({ command_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          committed_at: "2026-10-20T00:00:00.000Z", command_type: "SetMemorySettings",
          result: { workspace_id: workspaceId, revision: "1", recall_enabled: true,
            automatic_compaction: true } });
      }
      throw new Error(`unexpected ${url}`);
    });
    await mount();
    await click("save-memory-confirm");
    await flush();
    await click("save-memory-receipt");
    await flush();
    expect(document.querySelector('[data-testid="save-memory-error"]')?.textContent)
      .toContain("不是保存记忆");
  });

  it("创建 201 后读详情失败：持有已创建身份只重读该身份，不开放第二次创建", async () => {
    const posts: Record<string, unknown>[] = [];
    const memoryGets: string[] = [];
    let detailStatus = 503;
    stub((url, init) => {
      if (url.endsWith("/messages?limit=200")) return json({ items: [message()] });
      if (init.method === "POST" && url.includes("/memories")) {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push(body);
        return json({ command_id: body.command_id, committed_at: "2026-10-20T00:00:00.000Z",
          result: { memory_id: memoryId, revision: "0", version: "1", status: "ACTIVE" } }, 201);
      }
      if (url.includes(`/memories/${memoryId}/provenance`)) return json({ memory_id: memoryId, sources: [] });
      if (url.endsWith(`/memories/${memoryId}`)) {
        memoryGets.push(url);
        if (detailStatus >= 400) return json({ code: "DATABASE_UNAVAILABLE", detail: "read unavailable" }, detailStatus);
        return json(memoryBody({ title: "服务端标题" }));
      }
      throw new Error(`unexpected ${init.method ?? "GET"} ${url}`);
    });
    await mount();
    await click("save-memory-confirm");
    await flush();
    // 创建成功与读回失败是两个事实：不是「保存失败」，也不能再点出第二条创建命令。
    expect(posts).toHaveLength(1);
    expect(document.querySelector('[data-testid="save-memory-error"]')?.textContent)
      .toContain("数据库不可达");
    expect(document.querySelector('[data-testid="save-memory-error"]')?.textContent)
      .not.toContain("保存失败");
    expect(document.querySelector<HTMLButtonElement>('[data-testid="save-memory-confirm"]')?.disabled)
      .toBe(true);
    await click("save-memory-confirm");
    await flush();
    expect(posts).toHaveLength(1);
    // 重读只按已创建身份进行，成功后展示确切服务端内容。
    detailStatus = 200;
    await click("save-memory-reread");
    await flush();
    expect(memoryGets.length).toBeGreaterThan(0);
    expect(memoryGets.every((url) => url.endsWith(`/memories/${memoryId}`))).toBe(true);
    expect(document.querySelector('[data-testid="save-memory-saved-title"]')?.textContent)
      .toBe("服务端标题");
  });

  it("创建 201 后读来源失败同样只重读，不能触发第二次创建", async () => {
    const posts: Record<string, unknown>[] = [];
    let provenanceStatus = 503;
    stub((url, init) => {
      if (url.endsWith("/messages?limit=200")) return json({ items: [message()] });
      if (init.method === "POST" && url.includes("/memories")) {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push(body);
        return json({ command_id: body.command_id, committed_at: "2026-10-20T00:00:00.000Z",
          result: { memory_id: memoryId, revision: "0", version: "1", status: "ACTIVE" } }, 201);
      }
      if (url.includes(`/memories/${memoryId}/provenance`)) {
        if (provenanceStatus >= 400) return json({ code: "DATABASE_UNAVAILABLE", detail: "read unavailable" }, provenanceStatus);
        return json({ memory_id: memoryId, sources: [{ memory_version: "1", session_id: sessionId,
          message_id: messageId, content_sha256: sha256Hex(original) }] });
      }
      if (url.endsWith(`/memories/${memoryId}`)) return json(memoryBody());
      throw new Error(`unexpected ${init.method ?? "GET"} ${url}`);
    });
    await mount();
    await click("save-memory-confirm");
    await flush();
    expect(posts).toHaveLength(1);
    expect(document.querySelector('[data-testid="save-memory-saved"]')).toBeNull();
    expect(document.querySelector<HTMLButtonElement>('[data-testid="save-memory-confirm"]')?.disabled)
      .toBe(true);
    provenanceStatus = 200;
    await click("save-memory-reread");
    await flush();
    expect(posts).toHaveLength(1);
    const sources = document.querySelector('[data-testid="save-memory-saved-sources"]')?.textContent ?? "";
    expect(sources).toContain(messageId);
  });

  it("回执确认保存已生效后读回失败：停留在已创建待重读，不回到可再次创建的状态", async () => {
    const posts: Record<string, unknown>[] = [];
    let detailStatus = 503;
    stub((url, init) => {
      if (url.endsWith("/messages?limit=200")) return json({ items: [message()] });
      if (init.method === "POST" && url.includes("/memories")) {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push(body);
        throw new TypeError("Failed to fetch");
      }
      if (/\/commands\/[^/]+$/u.test(url)) {
        const commandId = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
        return json({ command_id: commandId, committed_at: "2026-10-20T00:00:00.000Z",
          command_type: "CreateMemoryFromMessage",
          result: { memory_id: memoryId, revision: "0", version: "1", status: "ACTIVE" } });
      }
      if (url.includes(`/memories/${memoryId}/provenance`)) return json({ memory_id: memoryId, sources: [] });
      if (url.endsWith(`/memories/${memoryId}`)) {
        if (detailStatus >= 400) return json({ code: "DATABASE_UNAVAILABLE", detail: "read unavailable" }, detailStatus);
        return json(memoryBody());
      }
      throw new Error(`unexpected ${init.method ?? "GET"} ${url}`);
    });
    await mount();
    await click("save-memory-confirm");
    await flush();
    await click("save-memory-receipt");
    await flush();
    // 回执确认创建已生效：之后读详情 503 只保留身份重读，pending 收口且不能再次创建。
    expect(posts).toHaveLength(1);
    expect(document.querySelector('[data-testid="save-memory-pending"]')).toBeNull();
    expect(document.querySelector('[data-testid="save-memory-error"]')?.textContent)
      .toContain("数据库不可达");
    expect(document.querySelector<HTMLButtonElement>('[data-testid="save-memory-confirm"]')?.disabled)
      .toBe(true);
    await click("save-memory-confirm");
    await flush();
    expect(posts).toHaveLength(1);
    detailStatus = 200;
    await click("save-memory-reread");
    await flush();
    expect(document.querySelector('[data-testid="save-memory-saved"]')).not.toBeNull();
    expect(posts).toHaveLength(1);
  });
});
