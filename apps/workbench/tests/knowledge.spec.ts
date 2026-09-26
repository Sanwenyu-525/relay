import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "77777777-7777-4777-8777-777777777777";
const base = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
const knowledgeId = "22222222-2222-4222-8222-222222222222";
const memoryId = "33333333-3333-4333-8333-333333333333";
const decisionId = "44444444-4444-4444-8444-444444444444";
const replacementId = "55555555-5555-4555-8555-555555555555";
let unmount: (() => void) | null = null;

function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function envelope(commandId: string, result: Record<string, unknown>, commandType?: string) {
  return { command_id: commandId, committed_at: "2026-09-23T00:00:00.000Z", result,
    ...(commandType ? { command_type: commandType } : {}) };
}

function knowledge() {
  return { id: knowledgeId, project_id: null, title: "设计资料", status: "ACTIVE", revision: "0",
    current_version: "1", created_at: "2026-09-23T00:00:00.000Z", updated_at: "2026-09-23T00:00:00.000Z" };
}

function memory() {
  return { id: memoryId, project_id: null, title: "约定", status: "ACTIVE", revision: "0",
    current_version: "1", text: "需要留存的事实", confirmed_by: "local-user",
    confirmed_at: "2026-09-23T00:00:00.000Z", expires_at: null,
    created_at: "2026-09-23T00:00:00.000Z", updated_at: "2026-09-23T00:00:00.000Z" };
}

function project(archivedAt: string | null = null) {
  return { id: projectId, title: "项目", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: archivedAt };
}

function decision(id: string, superseded = false) {
  return { id, project_id: null, title: id === decisionId ? "旧决定" : "新决定",
    status: superseded ? "SUPERSEDED" : "ACTIVE", revision: superseded ? "1" : "0", current_version: "1",
    choice: "采用方案", rationale: "已核对", alternatives: ["另一方案"], costs: ["维护成本"],
    superseded_by_id: superseded ? replacementId : null,
    created_at: "2026-09-23T00:00:00.000Z", updated_at: "2026-09-23T00:00:00.000Z" };
}

function searchItem(title: string) {
  return { type: "KNOWLEDGE", id: knowledgeId, version: "1", title, snippet: title,
    matched_fields: ["title"], source_ref: `knowledge:${knowledgeId}:v1`, status: "ACTIVE", project_id: null };
}

function activate(): void {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
}

afterEach(() => {
  unmount?.(); unmount = null;
  resetRelayConnectionForTest();
  vi.unstubAllGlobals();
});

describe("P10 information workbench", () => {
  it("示例模式只说明未接入，不伪造资料或写入按钮", async () => {
    const mounted = await mountWorkbench("/knowledge");
    unmount = mounted.unmount;
    expect(mounted.wrapper.get('[data-testid="knowledge-fixture-gap"]').text()).toContain("不生成虚构");
    expect(mounted.wrapper.find('[data-testid="knowledge-create"]').exists()).toBe(false);
  });

  it("中文短搜索的迟到响应不能覆盖较新的结果", async () => {
    activate();
    let resolveFirst: ((value: Response) => void) | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = String(input);
      if (url === `${base}/knowledge`) return response(200, []);
      if (url.includes("/search?")) {
        const q = new URL(url).searchParams.get("q");
        if (q === "知") return new Promise<Response>((resolve) => { resolveFirst = resolve; });
        if (q === "知识") return response(200, { items: [searchItem("知识新结果")], next_cursor: null });
      }
      throw new Error(`unexpected request ${url}`);
    }));
    const mounted = await mountWorkbench("/knowledge");
    unmount = mounted.unmount;
    const input = mounted.wrapper.get('[data-testid="knowledge-search"]');
    await input.setValue("知");
    await flush(300);
    await input.setValue("知识");
    await flush(300);
    expect(mounted.wrapper.text()).toContain("知识新结果");
    expect(resolveFirst).not.toBeNull();
    resolveFirst!(response(200, { items: [searchItem("过期结果")], next_cursor: null }));
    await flush(30);
    expect(mounted.wrapper.text()).not.toContain("过期结果");
  });

  it("Memory 必须明确确认才能提交，提交体绑定 confirmed:true", async () => {
    activate();
    let saved = false;
    let posted: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === `${base}/projects/${projectId}`) return response(200, project());
      if (url === `${base}/knowledge?project_id=${projectId}`) return response(200, []);
      if (url === `${base}/memories?project_id=${projectId}` && init?.method !== "POST") return response(200, saved ? [{ ...memory(), project_id: projectId }] : []);
      if (url === `${base}/memories` && init?.method === "POST") {
        posted = JSON.parse(String(init.body)) as Record<string, unknown>;
        saved = true;
        return response(201, envelope(String(posted.command_id), { memory_id: memoryId, revision: "0", version: "1", status: "ACTIVE" }));
      }
      if (url === `${base}/memories/${memoryId}`) return response(200, { ...memory(), project_id: projectId });
      if (url === `${base}/memories/${memoryId}/revisions`) return response(200, []);
      throw new Error(`unexpected request ${url}`);
    }));
    const mounted = await mountWorkbench(`/projects/${projectId}/knowledge`);
    unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="knowledge-tab-MEMORY"]').trigger("click");
    await flush();
    await mounted.wrapper.get('[data-testid="knowledge-create"]').trigger("click");
    await mounted.wrapper.get('[data-testid="knowledge-title"]').setValue("约定");
    await mounted.wrapper.get('[data-testid="memory-text"]').setValue("需要留存的事实");
    expect(mounted.wrapper.get('[data-testid="knowledge-save"]').attributes("disabled")).toBeDefined();
    await mounted.wrapper.get('[data-testid="memory-confirmed"]').setValue(true);
    await mounted.wrapper.get('[data-testid="knowledge-save"]').trigger("submit");
    await flush(60);
    expect(posted).toMatchObject({ project_id: projectId, title: "约定", text: "需要留存的事实", confirmed: true });
    expect(mounted.wrapper.text()).toContain("明确确认：local-user");
  });

  it("归档项目资料可读但新建、追加和归档命令不可发；Workspace 规则仍独立可写", async () => {
    activate();
    let posts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") { posts++; throw new Error("archived project write sent"); }
      if (url === `${base}/projects/${projectId}`) return response(200, project("2026-09-26T00:00:00.000Z"));
      if (url === `${base}/knowledge?project_id=${projectId}`) return response(200, [{ ...knowledge(), project_id: projectId }]);
      if (url === `${base}/knowledge/${knowledgeId}`) return response(200, { ...knowledge(), project_id: projectId });
      if (url === `${base}/knowledge/${knowledgeId}/versions`) return response(200, []);
      if (url === `${base}/rules?project_id=${projectId}`) return response(200, []);
      throw new Error(`unexpected request ${url}`);
    }));
    const mounted = await mountWorkbench(`/projects/${projectId}/knowledge`);
    unmount = mounted.unmount;
    await flush();
    expect(mounted.wrapper.text()).toContain("设计资料");
    expect(mounted.wrapper.get('[data-testid="knowledge-new-version"]').attributes("disabled")).toBeDefined();
    expect(mounted.wrapper.text()).toContain("关联项目已归档");
    await mounted.wrapper.get('[data-testid="knowledge-tab-RULE"]').trigger("click");
    await flush();
    await mounted.wrapper.get('[data-testid="knowledge-create"]').trigger("click");
    await flush();
    expect(mounted.wrapper.get('[data-testid="knowledge-save"]').attributes("disabled")).toBeDefined();
    expect(posts).toBe(0);
  });

  it("写入响应丢失后只用原 command_id 查回执", async () => {
    activate();
    let commandId = "";
    let postCount = 0;
    let receiptCount = 0;
    let committed = false;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === `${base}/knowledge` && init?.method !== "POST") return response(200, committed ? [knowledge()] : []);
      if (url === `${base}/knowledge` && init?.method === "POST") {
        postCount += 1;
        commandId = String((JSON.parse(String(init.body)) as Record<string, unknown>).command_id);
        throw new TypeError("connection lost");
      }
      if (url === `${base}/commands/${commandId}`) {
        receiptCount += 1;
        committed = true;
        return response(200, envelope(commandId,
          { knowledge_id: knowledgeId, revision: "0", version: "1", status: "ACTIVE" }, "CreateKnowledge"));
      }
      if (url === `${base}/knowledge/${knowledgeId}`) return response(200, knowledge());
      if (url === `${base}/knowledge/${knowledgeId}/versions`) return response(200, []);
      throw new Error(`unexpected request ${url}`);
    }));
    const mounted = await mountWorkbench("/knowledge");
    unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="knowledge-create"]').trigger("click");
    await mounted.wrapper.get('[data-testid="knowledge-title"]').setValue("设计资料");
    await mounted.wrapper.get('[data-testid="knowledge-text"]').setValue("正文");
    await mounted.wrapper.get('[data-testid="knowledge-save"]').trigger("submit");
    await flush();
    expect(mounted.wrapper.get('[data-testid="knowledge-pending-receipt"]').text()).toContain(commandId);
    await mounted.wrapper.get('[data-testid="knowledge-check-receipt"]').trigger("click");
    await flush(60);
    expect(postCount).toBe(1);
    expect(receiptCount).toBe(1);
    expect(mounted.wrapper.text()).toContain("设计资料");
  });

  it("Knowledge 产物引用无摘录可读，追加 NOTE 版本使用 200 与当前修订", async () => {
    activate();
    let posted: Record<string, unknown> | null = null;
    let revision = "0";
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === `${base}/knowledge`) return response(200, [{ ...knowledge(), revision }]);
      if (url === `${base}/knowledge/${knowledgeId}`) return response(200, { ...knowledge(), revision });
      if (url === `${base}/knowledge/${knowledgeId}/versions` && init?.method === "POST") {
        posted = JSON.parse(String(init.body)) as Record<string, unknown>;
        revision = "1";
        return response(200, envelope(String(posted.command_id), {
          knowledge_id: knowledgeId, revision: "1", version: "2", status: "ACTIVE"
        }));
      }
      if (url === `${base}/knowledge/${knowledgeId}/versions`) return response(200, [{
        id: "66666666-6666-4666-8666-666666666666", knowledge_id: knowledgeId, version: "1",
        source_kind: "ARTIFACT_VERSION", media_type: "text/markdown", content_sha256: "a".repeat(64),
        availability: "AVAILABLE", excerpt: null, source_refs: { artifact_version_id: "source-version" },
        created_at: "2026-09-23T00:00:00.000Z"
      }]);
      throw new Error(`unexpected request ${url}`);
    }));
    const mounted = await mountWorkbench("/knowledge");
    unmount = mounted.unmount;
    expect(mounted.wrapper.text()).toContain("该版本引用受管产物，无内联摘录");
    await mounted.wrapper.get('[data-testid="knowledge-new-version"]').trigger("click");
    await mounted.wrapper.get('[data-testid="knowledge-text"]').setValue("新笔记内容");
    await mounted.wrapper.get('[data-testid="knowledge-form"]').trigger("submit");
    await flush(60);
    expect(posted).toMatchObject({ expected_revision: "0", source_kind: "NOTE",
      text: "新笔记内容", media_type: "text/plain" });
  });

  it("Decision 替代后保留旧决定和替代指向", async () => {
    activate();
    let superseded = false;
    let posted: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === `${base}/knowledge`) return response(200, []);
      if (url === `${base}/decisions`) return response(200, [decision(decisionId, superseded), decision(replacementId)]);
      if (url === `${base}/decisions/${decisionId}`) return response(200, decision(decisionId, superseded));
      if (url === `${base}/decisions/${decisionId}/supersessions` && init?.method === "POST") {
        posted = JSON.parse(String(init.body)) as Record<string, unknown>;
        superseded = true;
        return response(200, envelope(String(posted.command_id), { decision_id: decisionId,
          replacement_decision_id: replacementId, revision: "1", status: "SUPERSEDED" }));
      }
      throw new Error(`unexpected request ${url}`);
    }));
    const mounted = await mountWorkbench("/knowledge");
    unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="knowledge-tab-DECISION"]').trigger("click");
    await flush();
    await mounted.wrapper.get('[data-testid="decision-replacement"]').setValue(replacementId);
    await mounted.wrapper.get('[data-testid="decision-supersede"]').trigger("click");
    await flush(60);
    expect(posted).toMatchObject({ expected_revision: "0", replacement_decision_id: replacementId });
    expect(mounted.wrapper.get('[data-testid="decision-supersession"]').text()).toContain(replacementId);
    expect(mounted.wrapper.text()).toContain("旧决定");
  });

  it("HARD 规则检查路径不可用时保留输入并显示原因", async () => {
    activate();
    let posted: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === `${base}/knowledge` || url === `${base}/rules` && init?.method !== "POST") return response(200, []);
      if (url === `${base}/rules` && init?.method === "POST") {
        posted = JSON.parse(String(init.body)) as Record<string, unknown>;
        return response(409, { code: "RULE_ENFORCEMENT_UNAVAILABLE", detail: "checker unavailable" });
      }
      throw new Error(`unexpected request ${url}`);
    }));
    const mounted = await mountWorkbench("/knowledge");
    unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="knowledge-tab-RULE"]').trigger("click");
    await flush();
    await mounted.wrapper.get('[data-testid="knowledge-create"]').trigger("click");
    const inputs = mounted.wrapper.get('[data-testid="knowledge-form"]').findAll("input");
    await inputs[0]!.setValue("citation-required");
    await mounted.wrapper.get('[data-testid="knowledge-form"]').find("textarea").setValue("所有引用须核验");
    await mounted.wrapper.get('[data-testid="rule-strength"]').setValue("HARD");
    await mounted.wrapper.get('[data-testid="rule-enforcement"]').setValue("POST_CHECK");
    await mounted.wrapper.get('[data-testid="knowledge-save"]').trigger("submit");
    await flush();
    expect(posted).toMatchObject({ scope: "WORKSPACE", scope_id: workspaceId, strength: "HARD" });
    expect(mounted.wrapper.text()).toContain("检查路径不可用");
    expect((mounted.wrapper.get('[data-testid="knowledge-form"]').find("textarea").element as HTMLTextAreaElement).value).toBe("所有引用须核验");
  });
});
