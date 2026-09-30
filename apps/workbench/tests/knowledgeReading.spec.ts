import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const knowledgeId = "22222222-2222-4222-8222-222222222222";
const projectId = "77777777-7777-4777-8777-777777777777";
const base = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
let unmount: (() => void) | null = null;

function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function knowledge(revision = "0", currentVersion = "2") {
  return { id: knowledgeId, project_id: null, title: "长篇资料", status: "ACTIVE", revision,
    current_version: currentVersion, created_at: "2026-09-27T00:00:00Z", updated_at: "2026-09-27T00:00:00Z" };
}
function version(number: string) {
  return { id: number === "1" ? "33333333-3333-4333-8333-333333333333" : "44444444-4444-4444-8444-444444444444",
    knowledge_id: knowledgeId, version: number, source_kind: "MANAGED_TEXT", media_type: "text/markdown",
    content_sha256: "a".repeat(64), availability: "AVAILABLE", excerpt: "定位摘录",
    source_refs: {}, created_at: "2026-09-27T00:00:00Z" };
}
function content(number: string, body: string) {
  return { ...version(number), title: "长篇资料", project_id: null, current_version: "2", source_uri: null,
    content_status: "FULL", content: body };
}
function activate() {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
}

afterEach(() => {
  unmount?.(); unmount = null; resetRelayConnectionForTest(); vi.unstubAllGlobals();
});

describe("知识版本阅读", () => {
  it("正文独立于资料导航和管理信息，展开导航保留编辑草稿与确切阅读标题", async () => {
    activate();
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = String(input);
      if (url === `${base}/knowledge`) return response(200, [knowledge()]);
      if (url === `${base}/knowledge/${knowledgeId}`) return response(200, knowledge());
      if (url === `${base}/knowledge/${knowledgeId}/versions`) return response(200, [version("2"), version("1")]);
      if (url === `${base}/knowledge/${knowledgeId}/versions/1/content`) return response(200,
        { ...content("1", "# 第一节\n所选历史版本的完整正文\n## 第二节\n继续阅读"), title: "所选历史版本标题" });
      throw new Error(`unexpected request ${url}`);
    }));
    const mounted = await mountWorkbench(`/knowledge?kind=KNOWLEDGE&item=${knowledgeId}&version=1`);
    unmount = mounted.unmount;
    await flush();
    const reader = mounted.wrapper.get('[data-testid="knowledge-reader"]');
    expect(reader.get("h1").text()).toBe("所选历史版本标题");
    expect(reader.get(".knowledge-reader__main").find('[aria-label="本文目录"]').exists()).toBe(false);
    expect(reader.get(".knowledge-reader__outline").text()).toContain("第一节");
    expect(reader.get('[aria-label="来源与版本"]').text()).toContain("v1 · 历史");
    expect((mounted.wrapper.get('[data-testid="knowledge-library"]').element as HTMLDetailsElement).open).toBe(false);
    expect((mounted.wrapper.get(".knowledge-search").element as HTMLDetailsElement).open).toBe(false);
    expect((mounted.wrapper.get(".knowledge-management").element as HTMLDetailsElement).open).toBe(false);
    const directory = reader.get('[aria-label="本文目录"]').findAll("button");
    await directory[1].trigger("click");
    expect(directory[1].attributes("aria-current")).toBe("location");
    expect(document.activeElement?.textContent).toBe("第二节");

    await mounted.wrapper.get('[data-testid="knowledge-new-version"]').trigger("click");
    await mounted.wrapper.get('[data-testid="knowledge-text"]').setValue("尚未保存的正文草稿");
    const draft = mounted.wrapper.get('[data-testid="knowledge-text"]').element;
    await mounted.wrapper.get(".knowledge-library > summary").trigger("click");
    expect((mounted.wrapper.get('[data-testid="knowledge-library"]').element as HTMLDetailsElement).open).toBe(true);
    await mounted.wrapper.get(".knowledge-library > summary").trigger("click");
    await mounted.wrapper.get(".knowledge-search > summary").trigger("click");
    await mounted.wrapper.get(".knowledge-management > summary").trigger("click");
    await flush();
    expect(mounted.wrapper.get('[data-testid="knowledge-text"]').element).toBe(draft);
    expect((draft as HTMLTextAreaElement).value).toBe("尚未保存的正文草稿");
    expect(reader.get("h1").text()).toBe("所选历史版本标题");
  });

  it("搜索命中 v1 后仍打开确切 v1，不跟随当前 v2", async () => {
    activate();
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = String(input);
      if (url === `${base}/knowledge`) return response(200, [knowledge()]);
      if (url === `${base}/knowledge/${knowledgeId}`) return response(200, knowledge());
      if (url === `${base}/knowledge/${knowledgeId}/versions`) return response(200, [version("2"), version("1")]);
      if (url === `${base}/knowledge/${knowledgeId}/versions/2/content`) return response(200, content("2", "新版正文"));
      if (url === `${base}/knowledge/${knowledgeId}/versions/1/content`) return response(200, content("1", "搜索命中的旧版正文"));
      if (url.startsWith(`${base}/search?`)) return response(200, { items: [{ type: "KNOWLEDGE", id: knowledgeId,
        version: "1", title: "历史命中", snippet: "旧版正文", matched_fields: ["text"],
        source_ref: `knowledge:${knowledgeId}:v1`, status: "ACTIVE", project_id: null }], next_cursor: null });
      throw new Error(`unexpected request ${url}`);
    }));
    const mounted = await mountWorkbench("/knowledge"); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="knowledge-search"]').setValue("旧版");
    await flush(300);
    await mounted.wrapper.get(".knowledge-result").trigger("click");
    await flush();
    expect(mounted.wrapper.get('[data-testid="knowledge-reader-version"]').element)
      .toMatchObject({ value: "1" });
    expect(mounted.wrapper.get('[data-testid="knowledge-reader-body"]').text()).toContain("搜索命中的旧版正文");
    expect(mounted.wrapper.get('[data-testid="knowledge-reader-body"]').text()).not.toContain("新版正文");
  });

  it("确切 v1 不回退当前 v2，切换时丢弃迟到正文；阅读不调用模型或外网", async () => {
    activate();
    let resolveOld: ((value: Response) => void) | null = null;
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = String(input); calls.push(url);
      if (url === `${base}/knowledge`) return response(200, [knowledge()]);
      if (url === `${base}/knowledge/${knowledgeId}`) return response(200, knowledge());
      if (url === `${base}/knowledge/${knowledgeId}/versions`) return response(200, [version("2"), version("1")]);
      if (url === `${base}/knowledge/${knowledgeId}/versions/1/content`)
        return new Promise<Response>((resolve) => { resolveOld = resolve; });
      if (url === `${base}/knowledge/${knowledgeId}/versions/2/content`)
        return response(200, content("2", "# 新标题\n" + "新版中文正文".repeat(100)));
      throw new Error(`unexpected request ${url}`);
    }));
    const mounted = await mountWorkbench(`/knowledge?kind=KNOWLEDGE&item=${knowledgeId}&version=1`);
    unmount = mounted.unmount;
    await flush();
    expect(resolveOld).not.toBeNull();
    await mounted.wrapper.get('[data-testid="knowledge-reader-version"]').setValue("2");
    await flush();
    expect(mounted.wrapper.get('[data-testid="knowledge-reader-body"]').text()).toContain("新版中文正文");
    resolveOld!(response(200, content("1", "旧版正文")));
    await flush();
    expect(mounted.wrapper.get('[data-testid="knowledge-reader-body"]').text()).not.toContain("旧版正文");
    expect(mounted.wrapper.get('[aria-label="本文目录"]').text()).toContain("新标题");
    expect(calls.every((url) => url.startsWith(base))).toBe(true);
  });

  it("不在版本列表中的显式历史引用显示读取错误，不偷换当前版本", async () => {
    activate();
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = String(input); calls.push(url);
      if (url === `${base}/knowledge`) return response(200, [knowledge()]);
      if (url === `${base}/knowledge/${knowledgeId}`) return response(200, knowledge());
      if (url === `${base}/knowledge/${knowledgeId}/versions`) return response(200, [version("2")]);
      if (url === `${base}/knowledge/${knowledgeId}/versions/1/content`) return response(404,
        { code: "RESOURCE_NOT_FOUND", detail: "version missing" });
      throw new Error(`unexpected request ${url}`);
    }));
    const mounted = await mountWorkbench(`/knowledge?kind=KNOWLEDGE&item=${knowledgeId}&version=1`);
    unmount = mounted.unmount;
    await flush();
    expect(mounted.wrapper.text()).toContain("v1 正文读取失败");
    expect(calls).toContain(`${base}/knowledge/${knowledgeId}/versions/1/content`);
    expect(calls).not.toContain(`${base}/knowledge/${knowledgeId}/versions/2/content`);
  });

  it("Markdown 恶意 HTML 只作为文字，危险协议不生成链接", async () => {
    activate();
    const dangerous = "# 安全标题\n<script>window.pwned=1</script>\n[恶意](javascript:alert(1))";
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = String(input);
      if (url === `${base}/knowledge`) return response(200, [knowledge()]);
      if (url === `${base}/knowledge/${knowledgeId}`) return response(200, knowledge());
      if (url === `${base}/knowledge/${knowledgeId}/versions`) return response(200, [version("2")]);
      if (url === `${base}/knowledge/${knowledgeId}/versions/2/content`) return response(200, content("2", dangerous));
      throw new Error(`unexpected request ${url}`);
    }));
    const mounted = await mountWorkbench("/knowledge"); unmount = mounted.unmount;
    await flush();
    expect(mounted.wrapper.find("script").exists()).toBe(false);
    expect(mounted.wrapper.get('[data-testid="knowledge-reader-body"]').text()).toContain("<script>");
    expect(mounted.wrapper.find('a[href^="javascript:"]').exists()).toBe(false);
    expect(mounted.wrapper.get('[aria-label="本文目录"]').text()).toContain("安全标题");
  });

  it("长纯文本完整显示且不制造目录", async () => {
    activate();
    const plain = "第一行中文\n" + "持续阅读的正文。".repeat(100);
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = String(input);
      if (url === `${base}/knowledge`) return response(200, [knowledge()]);
      if (url === `${base}/knowledge/${knowledgeId}`) return response(200, knowledge());
      if (url === `${base}/knowledge/${knowledgeId}/versions`) return response(200,
        [{ ...version("2"), media_type: "text/plain" }]);
      if (url === `${base}/knowledge/${knowledgeId}/versions/2/content`) return response(200,
        { ...content("2", plain), media_type: "text/plain" });
      throw new Error(`unexpected request ${url}`);
    }));
    const mounted = await mountWorkbench("/knowledge"); unmount = mounted.unmount;
    await flush();
    expect(mounted.wrapper.get('[data-testid="knowledge-reader-body"]').text()).toContain(plain.slice(-30));
    expect(mounted.wrapper.find('[aria-label="本文目录"]').exists()).toBe(false);
  });

  it("修订起草后即使详情变成 v2，提交仍带原 revision 并在冲突时保稿", async () => {
    activate();
    let listCount = 0;
    let resolveRefresh: ((value: Response) => void) | null = null;
    let submitted: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === `${base}/knowledge` && init?.method !== "POST") {
        listCount++;
        return response(200, [knowledge(listCount === 1 ? "0" : "1", listCount === 1 ? "1" : "2")]);
      }
      if (url === `${base}/knowledge/${knowledgeId}`) {
        if (listCount === 1) return response(200, knowledge("0", "1"));
        return new Promise<Response>((resolve) => { resolveRefresh = resolve; });
      }
      if (url === `${base}/knowledge/${knowledgeId}/versions` && init?.method === "POST") {
        submitted = JSON.parse(String(init.body)) as Record<string, unknown>;
        return response(409, { code: "REVISION_CONFLICT", detail: "revision changed" });
      }
      if (url === `${base}/knowledge/${knowledgeId}/versions`) return response(200, [version("1")]);
      if (url === `${base}/knowledge/${knowledgeId}/versions/1/content`) return response(200,
        { ...content("1", "原版"), current_version: "1" });
      throw new Error(`unexpected request ${url}`);
    }));
    const mounted = await mountWorkbench("/knowledge"); unmount = mounted.unmount;
    await flush();
    await mounted.wrapper.get(".knowledge-row").trigger("click");
    await mounted.wrapper.get('[data-testid="knowledge-new-version"]').trigger("click");
    await mounted.wrapper.get('[data-testid="knowledge-text"]').setValue("我的未保存草稿");
    expect(resolveRefresh).not.toBeNull();
    resolveRefresh!(response(200, knowledge("1", "2")));
    await flush();
    expect(mounted.wrapper.text()).toContain("基于起草时修订 v0");
    await mounted.wrapper.get('[data-testid="knowledge-form"]').trigger("submit");
    await flush();
    expect(submitted).toMatchObject({ expected_revision: "0", text: "我的未保存草稿" });
    expect((mounted.wrapper.get('[data-testid="knowledge-text"]').element as HTMLTextAreaElement).value)
      .toBe("我的未保存草稿");
  });

  it("项目导读只显示现有事实，没有资料时列出缺口", async () => {
    activate();
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = String(input);
      if (url === `${base}/projects/${projectId}`) return response(200,
        { id: projectId, title: "项目甲", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
      if (url === `${base}/knowledge?project_id=${projectId}` ||
          url === `${base}/decisions?project_id=${projectId}` ||
          url === `${base}/rules?project_id=${projectId}`) return response(200, []);
      if (url === `${base}/projects/${projectId}/goals`) return response(200, { items: [] });
      throw new Error(`unexpected request ${url}`);
    }));
    const mounted = await mountWorkbench(`/projects/${projectId}/knowledge`); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="knowledge-guide-toggle"]').trigger("click");
    await flush();
    const guide = mounted.wrapper.get('[data-testid="project-knowledge-guide"]').text();
    expect(guide).toContain("尚无已关联的有效目标");
    expect(guide).toContain("尚无项目决定");
    expect(guide).toContain("尚无项目资料");
    expect(guide).not.toContain("验收通过");
  });

  it("收录须核对确切产物版本；旧预览迟到不能进入新的来源草稿", async () => {
    activate();
    const oldId = "88888888-8888-4888-8888-888888888888";
    const newId = "99999999-9999-4999-8999-999999999999";
    let resolveOld: ((value: Response) => void) | null = null;
    let posts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === `${base}/projects/${projectId}`) return response(200,
        { id: projectId, title: "项目甲", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
      if (url === `${base}/knowledge?project_id=${projectId}`) return response(200, []);
      if (url === `${base}/artifact-versions/${oldId}/content`)
        return new Promise<Response>((resolve) => { resolveOld = resolve; });
      if (url === `${base}/artifact-versions/${newId}/content`)
        return { ok: true, status: 200, text: async () => "# 新产物" } as Response;
      if (url === `${base}/knowledge` && init?.method === "POST") {
        posts++;
        throw new Error("此例只核对提交门槛");
      }
      throw new Error(`unexpected request ${url}`);
    }));
    const mounted = await mountWorkbench(`/projects/${projectId}/knowledge`); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="knowledge-create"]').trigger("click");
    await mounted.wrapper.get('[data-testid="knowledge-title"]').setValue("收录产物");
    await mounted.wrapper.get('.knowledge-form select').setValue("ARTIFACT_VERSION");
    await mounted.wrapper.get('[data-testid="knowledge-artifact-id"]').setValue(oldId);
    await mounted.wrapper.get('[data-testid="knowledge-form"]').find("button.secondary-button").trigger("click");
    await flush();
    expect(resolveOld).not.toBeNull();
    await mounted.wrapper.get('[data-testid="knowledge-artifact-id"]').setValue(newId);
    resolveOld!({ ok: true, status: 200, text: async () => "# 旧产物" } as Response);
    await flush();
    expect(mounted.wrapper.text()).not.toContain("# 旧产物");
    await mounted.wrapper.get('[data-testid="knowledge-form"]').trigger("submit");
    await flush();
    expect(posts).toBe(0);
    await mounted.wrapper.get('[data-testid="knowledge-form"]').find("button.secondary-button").trigger("click");
    await flush();
    expect(mounted.wrapper.text()).toContain("# 新产物");
    expect(mounted.wrapper.text()).toContain(`目标范围：项目 ${projectId}`);
    expect(posts).toBe(0);
  });
});
