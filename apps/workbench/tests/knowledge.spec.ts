import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { DomWrapper, flush, mountWorkbench } from "./mountApp";

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
  it("资料类型页签关联同页正文，方向键首尾循环且忽略输入法合成", async () => {
    activate();
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => response(200, [])); vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench("/knowledge"); unmount = mounted.unmount;
    const tabs = mounted.wrapper.get(".knowledge-tabs");
    expect(tabs.attributes("role")).toBe("tablist");
    const current = () => mounted.wrapper.get('.knowledge-tabs [aria-selected="true"]');
    const press = async (key: string, properties: KeyboardEventInit = {}) => {
      await act(async () => current().element?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...properties })));
      await flush();
    };
    await act(async () => (current().element as HTMLButtonElement).focus());
    for (const properties of [{ isComposing: true }, { keyCode: 229 }]) {
      await press("ArrowRight", properties);
      expect(current().attributes("data-testid")).toBe("knowledge-tab-KNOWLEDGE");
    }
    for (const [key, expected] of [["ArrowLeft", "RULE"], ["ArrowRight", "KNOWLEDGE"], ["End", "RULE"], ["Home", "KNOWLEDGE"], ["ArrowRight", "MEMORY"]]) {
      await press(key!);
      const selected = current();
      expect(selected.attributes("data-testid")).toBe(`knowledge-tab-${expected}`);
      expect(document.activeElement).toBe(selected.element);
      expect(selected.attributes("role")).toBe("tab");
      expect(selected.attributes("tabindex")).toBe("0");
      expect(tabs.findAll('[tabindex="0"]')).toHaveLength(1);
      const panel = document.getElementById(selected.attributes("aria-controls")!);
      expect(panel?.getAttribute("role")).toBe("tabpanel");
      expect(panel?.getAttribute("aria-labelledby")).toBe(selected.attributes("id"));
    }
    expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
  });

  it("从资料阅读切换类型后保留选中页签焦点，迟到列表不覆盖新类型", async () => {
    activate();
    let releaseMemory: ((value: Response) => void) | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      if (input === `${base}/knowledge`) return response(200, [knowledge()]);
      if (input === `${base}/knowledge/${knowledgeId}`) return response(200, knowledge());
      if (input === `${base}/knowledge/${knowledgeId}/versions`) return response(200, []);
      if (input === `${base}/memories`) return new Promise<Response>((resolve) => { releaseMemory = resolve; });
      if (input === `${base}/decisions`) return response(200, []);
      throw new Error(`unexpected request ${input}`);
    }));
    const mounted = await mountWorkbench("/knowledge"); unmount = mounted.unmount;
    await act(async () => {
      (mounted.wrapper.get('[data-testid="knowledge-library"]').element as HTMLDetailsElement).open = true;
      const first = mounted.wrapper.get('[data-testid="knowledge-tab-KNOWLEDGE"]').element as HTMLButtonElement;
      first.focus(); first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    });
    await flush();
    const memoryTab = mounted.wrapper.get('[data-testid="knowledge-tab-MEMORY"]');
    expect(memoryTab.attributes("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(memoryTab.element);
    await act(async () => memoryTab.element?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
    await flush();
    expect(mounted.wrapper.get('[data-testid="knowledge-tab-DECISION"]').attributes("aria-selected")).toBe("true");
    expect(releaseMemory).not.toBeNull();
    releaseMemory!(response(200, [memory()])); await flush();
    expect(mounted.wrapper.text()).not.toContain("需要留存的事实");
    expect(mounted.wrapper.get('[data-testid="knowledge-tab-DECISION"]').attributes("aria-selected")).toBe("true");
    await act(async () => (document.activeElement as HTMLButtonElement).dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true })));
    await flush();
    const knowledgeTab = mounted.wrapper.get('[data-testid="knowledge-tab-KNOWLEDGE"]');
    expect(knowledgeTab.attributes("aria-selected")).toBe("true"); expect(document.activeElement).toBe(knowledgeTab.element);
    expect((mounted.wrapper.get('[data-testid="knowledge-library"]').element as HTMLDetailsElement).open).toBe(true);
  });

  it("键盘切换资料类型仍先保护草稿，保留草稿后焦点回到原页签", async () => {
    activate();
    const fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
      if (init?.method === "POST") throw new Error("切换类型不应提交资料");
      return response(200, []);
    }); vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench("/knowledge?kind=MEMORY"); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="knowledge-create"]').trigger("click");
    await mounted.wrapper.get('[data-testid="memory-text"]').setValue("未保存的事实");
    const current = mounted.wrapper.get('[data-testid="knowledge-tab-MEMORY"]').element as HTMLButtonElement;
    await act(async () => { current.focus(); current.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })); });
    const dialog = new DomWrapper(document.querySelector('[role="dialog"]'));
    expect(dialog.text()).toContain("保留未保存的资料");
    expect(current.getAttribute("aria-selected")).toBe("true");
    await dialog.findAll("button").find((button) => button.text() === "保留并继续编辑")!.trigger("click");
    expect(document.activeElement).toBe(current);
    expect((mounted.wrapper.get('[data-testid="memory-text"]').element as HTMLTextAreaElement).value).toBe("未保存的事实");
    await act(async () => current.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
    await new DomWrapper(document.querySelector('[data-testid="knowledge-discard-and-switch"]')).trigger("click"); await flush();
    const next = mounted.wrapper.get('[data-testid="knowledge-tab-DECISION"]');
    expect(next.attributes("aria-selected")).toBe("true"); expect(document.activeElement).toBe(next.element);
    expect(mounted.wrapper.find('[data-testid="knowledge-form"]').exists()).toBe(false);
    expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
  });

  it("切换资料类型和路由前保护未保存正文，明确丢弃后才能切换", async () => {
    activate();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") throw new Error("切换类型不应提交资料");
      return response(200, []);
    }); vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench("/knowledge"); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="knowledge-create"]').trigger("click");
    await mounted.wrapper.get('[data-testid="knowledge-title"]').setValue("尚未保存的资料");
    await mounted.wrapper.get('[data-testid="knowledge-text"]').setValue("需要保留的正文");
    const draft = mounted.wrapper.get('[data-testid="knowledge-text"]').element;
    await mounted.wrapper.get('[data-testid="knowledge-tab-MEMORY"]').trigger("click");
    const dialog = new DomWrapper(document.querySelector('[role="dialog"]'));
    expect(dialog.text()).toContain("保留未保存的资料");
    await dialog.findAll("button").find((button) => button.text() === "保留并继续编辑")!.trigger("click");
    expect(mounted.wrapper.get('[data-testid="knowledge-text"]').element).toBe(draft);
    expect((draft as HTMLTextAreaElement).value).toBe("需要保留的正文");
    await mounted.router.push("/projects"); await flush();
    expect(mounted.router.currentRoute.value.path).toBe("/knowledge");
    const routeDialog = new DomWrapper(document.querySelector('[role="dialog"]'));
    await routeDialog.findAll("button").find((button) => button.text() === "保留并继续编辑")!.trigger("click");
    await mounted.wrapper.get('[data-testid="knowledge-tab-MEMORY"]').trigger("click");
    await new DomWrapper(document.querySelector('[data-testid="knowledge-discard-and-switch"]')).trigger("click"); await flush();
    expect(mounted.wrapper.get('[data-testid="knowledge-tab-MEMORY"]').attributes("aria-selected")).toBe("true");
    expect(mounted.wrapper.find('[data-testid="knowledge-form"]').exists()).toBe(false);
    expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
  });
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
    const originalTab = mounted.wrapper.get('[data-testid="knowledge-tab-KNOWLEDGE"]');
    expect(mounted.wrapper.get('[data-testid="knowledge-tab-MEMORY"]').attributes("disabled")).toBeDefined();
    await act(async () => originalTab.element?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
    expect(originalTab.attributes("aria-selected")).toBe("true");
    expect(postCount).toBe(1);
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

  it("列表显示当前版本与范围，详情范围行区分项目与工作空间", async () => {
    activate();
    const spaceId = "99999999-9999-4999-8999-999999999999";
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = String(input);
      if (url === `${base}/projects/${projectId}`) return response(200, project());
      if (url === `${base}/knowledge`) return response(200, [
        { ...knowledge(), revision: "0", current_version: "5", project_id: projectId },
        { ...knowledge(), id: spaceId, title: "空间资料", revision: "0", current_version: "2", project_id: null }
      ]);
      if (url === `${base}/knowledge/${knowledgeId}`) return response(200, { ...knowledge(), revision: "0", current_version: "5", project_id: projectId });
      if (url === `${base}/knowledge/${knowledgeId}/versions`) return response(200, []);
      throw new Error(`unexpected request ${url}`);
    }));
    const mounted = await mountWorkbench("/knowledge");
    unmount = mounted.unmount;
    await flush();
    const rows = mounted.wrapper.findAll(".knowledge-row");
    expect(rows[0]!.text()).toContain("当前 v5");
    expect(rows[0]!.text()).not.toContain("v0");
    expect(rows[0]!.text()).toContain("项目");
    expect(rows[1]!.text()).toContain("当前 v2");
    expect(rows[1]!.text()).toContain("工作空间");
    expect(mounted.wrapper.get('[data-testid="knowledge-detail-scope"]').text()).toContain(`项目 ${projectId}`);
  });
});
