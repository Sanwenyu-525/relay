import { afterEach, expect, it, vi } from "vitest";
import { flush, mountWorkbench } from "../../tests/mountApp";
import { activateRelayConnection, resetRelayConnectionForTest } from "../../src/lib/relayConnection";

const wid = "11111111-1111-4111-8111-111111111111";
const mid = "33333333-3333-4333-8333-333333333333";
const root = `http://127.0.0.1:8787/api/v1/workspaces/${wid}`;
const originalExpiry = "2026-12-31T00:00:00.000Z";
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; resetRelayConnectionForTest(); vi.unstubAllGlobals(); });
function connect() {
  activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId: wid, bearerToken: "probe-not-a-real-credential-token" });
}
function response(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}
function common(url: string) {
  if (url.endsWith("/attention/interventions")) return response({ items: [] });
  if (url.endsWith("/tasks?scope=all")) return response({ items: [], next_cursor: null });
  if (url.includes("/assist-sessions")) return response({ items: [] });
  if (url.includes("/projects?")) return response({ items: [], next_cursor: null });
  return response([]);
}
function memory() {
  return { id: mid, project_id: null, title: "expiring fact", status: "ACTIVE", revision: "1", current_version: "1",
    text: "original text", confirmed_by: "local-user", confirmed_at: "2026-10-01T00:00:00.000Z",
    expires_at: originalExpiry, effective_status: "ACTIVE", created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z" };
}

it("editing only a memory body must preserve its existing expiry", async () => {
  connect(); const posted: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `${root}/memories`) return response([memory()]);
    if (url === `${root}/memories/${mid}`) return response(memory());
    if (url === `${root}/memories/${mid}/revisions` && init?.method === "POST") {
      const body = JSON.parse(String(init.body)); posted.push(body);
      return response({ command_id: body.command_id, committed_at: "2026-10-22T00:00:00.000Z",
        result: { memory_id: mid, revision: "2", version: "2", status: "ACTIVE" } });
    }
    return common(url);
  }));
  const mounted = await mountWorkbench("/knowledge?kind=MEMORY"); cleanup = mounted.unmount;
  await flush(30);
  await mounted.wrapper.get('[data-testid="knowledge-new-version"]').trigger("click");
  const prefilledExpiry = (mounted.wrapper.get('[data-testid="memory-expires-at"]').element as HTMLInputElement).value;
  await mounted.wrapper.get('[data-testid="memory-text"]').setValue("edited text only");
  await mounted.wrapper.get('[data-testid="memory-confirmed"]').setValue(true);
  await mounted.wrapper.get('[data-testid="knowledge-form"]').trigger("submit"); await flush(30);
  console.log("TRIAGE_MEMORY_EXPIRY", JSON.stringify({ originalExpiry, prefilledExpiry, posted: posted[0] }));
  expect(posted).toHaveLength(1);
  expect(posted[0]?.expires_at, "body-only edit must not remove expiry").toBe(originalExpiry);
});

it("503 CHECK_RECEIPT_THEN_RETRY must preserve the original knowledge command", async () => {
  connect(); const posted: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `${root}/knowledge` && init?.method === "POST") {
      posted.push(JSON.parse(String(init.body)));
      return response({ code: "DATABASE_UNAVAILABLE", detail: "response uncertain", retry_action: "CHECK_RECEIPT_THEN_RETRY" }, 503);
    }
    return common(url);
  }));
  const mounted = await mountWorkbench("/knowledge"); cleanup = mounted.unmount;
  await mounted.wrapper.get('[data-testid="knowledge-create"]').trigger("click");
  await mounted.wrapper.get('[data-testid="knowledge-title"]').setValue("probe knowledge");
  await mounted.wrapper.get('[data-testid="knowledge-text"]').setValue("probe content");
  await mounted.wrapper.get('[data-testid="knowledge-form"]').trigger("submit"); await flush(30);
  const disabledAfter503 = mounted.wrapper.get('[data-testid="knowledge-save"]').attributes("disabled");
  await mounted.wrapper.get('[data-testid="knowledge-form"]').trigger("submit"); await flush(30);
  console.log("TRIAGE_KNOWLEDGE_503", JSON.stringify({ disabledAfter503: disabledAfter503 !== undefined, ids: posted.map(p => p.command_id) }));
  expect(new Set(posted.map(p => p.command_id)).size, "503 cannot authorize a fresh command identity").toBe(1);
});

it("search continuation failure must retain already loaded results and retry cursor", async () => {
  connect(); const paths: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/search?")) {
      paths.push(url);
      if (new URL(url).searchParams.has("cursor")) return response({ code: "DATABASE_UNAVAILABLE", detail: "next page temporary failure" }, 503);
      return response({ items: [{ type: "MEMORY", id: mid, version: "1", title: "loaded result must survive",
        snippet: "confirmed loaded first page", matched_fields: ["title"], source_ref: "memory:probe", status: "ACTIVE", project_id: null }], next_cursor: "page-two-cursor" });
    }
    return common(url);
  }));
  const mounted = await mountWorkbench("/knowledge"); cleanup = mounted.unmount;
  await mounted.wrapper.get('[data-testid="knowledge-search"]').setValue("probe"); await flush(320);
  expect(mounted.wrapper.text()).toContain("loaded result must survive");
  await mounted.wrapper.get('[data-testid="knowledge-more"]').trigger("click"); await flush(30);
  console.log("TRIAGE_SEARCH_PAGE_FAILURE", JSON.stringify({ requests: paths.length, priorResultVisible: mounted.wrapper.text().includes("loaded result must survive"), hasContinuation: mounted.wrapper.find('[data-testid="knowledge-more"]').exists() }));
  expect(mounted.wrapper.text(), "continuation failure cannot erase page one").toContain("loaded result must survive");
  expect(mounted.wrapper.find('[data-testid="knowledge-more"]').exists()).toBe(true);
});

it("uncertain web import must survive route departure or block departure", async () => {
  connect(); const pid = "22222222-2222-4222-8222-222222222222";
  const cid = "44444444-4444-4444-8444-444444444444";
  const path = `/projects/${pid}/knowledge`; let submittedId = "";
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `${root}/projects/${pid}`) return response({ id: pid, title: "import project", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
    if (url === `${root}/projects/${pid}/connections`) return response([{ id: cid, status: "ACTIVE", capabilities: ["WEB_FETCH"], allowed_host: "public.example" }]);
    if (url === `${root}/projects/${pid}/import-jobs` && init?.method === "POST") {
      submittedId = String(JSON.parse(String(init.body)).command_id);
      throw new TypeError("connection lost after import submission");
    }
    return common(url);
  }));
  const mounted = await mountWorkbench(path); cleanup = mounted.unmount;
  await flush(30);
  await mounted.wrapper.get('[data-testid="web-import-url"]').setValue("https://public.example/article");
  await mounted.wrapper.get('[data-testid="web-import-form"]').trigger("submit"); await flush(30);
  expect(mounted.wrapper.get('[data-testid="web-import-pending"]').text()).toContain(submittedId);
  await mounted.router.push("/tasks"); await flush(30);
  const leftWithoutGuard = mounted.router.currentRoute.value.path !== path;
  if (leftWithoutGuard) { await mounted.router.push(path); await flush(30); }
  const pending = mounted.wrapper.find('[data-testid="web-import-pending"]');
  console.log("TRIAGE_WEB_IMPORT_DEPARTURE", JSON.stringify({ leftWithoutGuard, pendingRecovered: pending.exists() && pending.text().includes(submittedId) }));
  expect(pending.exists() && pending.text().includes(submittedId), "original unknown import identity must remain recoverable").toBe(true);
});
