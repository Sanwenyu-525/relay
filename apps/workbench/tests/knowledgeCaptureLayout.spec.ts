import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "77777777-7777-4777-8777-777777777777";
const knowledgeId = "22222222-2222-4222-8222-222222222222";
const artifactVersionId = "88888888-8888-4888-8888-888888888888";
const base = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
let unmount: (() => void) | null = null;

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function artifactBody(text: string): Response {
  return { ok: true, status: 200, text: async () => text } as Response;
}
function project() {
  return { id: projectId, title: "当前项目", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null };
}
function knowledge() {
  return { id: knowledgeId, project_id: projectId, title: "原资料", status: "ACTIVE", revision: "4",
    current_version: "2", created_at: "2026-09-27T00:00:00Z", updated_at: "2026-09-27T00:00:00Z" };
}
function version(number: string) {
  return { id: number === "1" ? "33333333-3333-4333-8333-333333333333" : "44444444-4444-4444-8444-444444444444",
    knowledge_id: knowledgeId, version: number, source_kind: "NOTE", media_type: "text/plain",
    content_sha256: "a".repeat(64), availability: "AVAILABLE", excerpt: "保存的原文",
    source_refs: {}, created_at: "2026-09-27T00:00:00Z" };
}
function activate() { activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" }); }

afterEach(() => { unmount?.(); unmount = null; resetRelayConnectionForTest(); vi.unstubAllGlobals(); });

describe("知识收录纸面与确认区", () => {
  it("右栏确认与回执使用同一表单和原 command_id，读取正文不提交收录", async () => {
    activate(); const posts: Record<string, unknown>[] = []; const receipts: string[] = []; let committed = false;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === `${base}/projects/${projectId}`) return json(project());
      if (url === `${base}/knowledge?project_id=${projectId}`) return json(committed ? [knowledge()] : []);
      if (url === `${base}/artifact-versions/${artifactVersionId}/content`) return artifactBody("确切版本的完整正文");
      if (url === `${base}/knowledge` && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)) as Record<string, unknown>); throw new TypeError("response lost");
      }
      if (url.startsWith(`${base}/commands/`)) {
        receipts.push(url.slice(url.lastIndexOf("/") + 1));
        if (receipts.length === 1) return json({ code: "RESOURCE_NOT_FOUND", detail: "receipt not found" }, 404);
        committed = true;
        return json({ command_id: posts[0].command_id, command_type: "CreateKnowledge",
          committed_at: "2026-10-01T00:00:00Z", result: { knowledge_id: knowledgeId, revision: "4", version: "2", status: "ACTIVE" } });
      }
      if (url === `${base}/knowledge/${knowledgeId}`) return json(knowledge());
      if (url === `${base}/knowledge/${knowledgeId}/versions`) return json([]);
      throw new Error(`unexpected request ${url}`);
    }));
    const mounted = await mountWorkbench(`/projects/${projectId}/knowledge`); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="knowledge-create"]').trigger("click");
    await mounted.wrapper.get('[data-testid="knowledge-title"]').setValue("收录原版本");
    await mounted.wrapper.get('[data-testid="knowledge-source-kind"]').setValue("ARTIFACT_VERSION");
    await mounted.wrapper.get('[data-testid="knowledge-artifact-id"]').setValue(artifactVersionId);
    await mounted.wrapper.get('[data-testid="knowledge-read-artifact"]').trigger("click"); await flush();
    expect(mounted.wrapper.get('[data-testid="knowledge-save"]').attributes("disabled")).toBeDefined();
    const form = mounted.wrapper.get('[data-testid="knowledge-form"]').element;
    const confirmation = mounted.wrapper.get('[data-testid="knowledge-capture-confirmation"]');
    expect(mounted.wrapper.get('[data-testid="knowledge-capture-body"] pre').text()).toBe("确切版本的完整正文");
    expect(mounted.wrapper.get('[data-testid="knowledge-capture-body"] .markdown-preview').text()).toBe("确切版本的完整正文");
    expect(confirmation.text()).toContain(`目标范围：项目 ${projectId}`);
    expect(posts).toHaveLength(0);
    expect(mounted.wrapper.findAll('[data-testid="knowledge-form"]')).toHaveLength(1);
    expect(mounted.wrapper.findAll('[data-testid="knowledge-save"]')).toHaveLength(1);
    expect(confirmation.get('[data-testid="knowledge-save"]').element?.closest("form")).toBe(form);
    await mounted.wrapper.get('[data-testid="knowledge-capture-confirmed"]').setValue(true);
    expect(mounted.wrapper.get('[data-testid="knowledge-save"]').attributes("disabled")).toBeUndefined();
    await mounted.wrapper.get('[data-testid="knowledge-form"]').trigger("submit"); await flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ project_id: projectId, title: "收录原版本", source_kind: "ARTIFACT_VERSION", artifact_version_id: artifactVersionId });
    expect(posts[0]).not.toHaveProperty("text");
    expect(confirmation.get('[data-testid="knowledge-pending-receipt"]').text()).toContain(String(posts[0].command_id));
    expect(mounted.wrapper.findAll('[data-testid="knowledge-pending-receipt"]')).toHaveLength(1);
    expect(mounted.wrapper.get('[data-testid="knowledge-capture-confirmed"]').attributes("disabled")).toBeDefined();
    await mounted.wrapper.get('[data-testid="knowledge-capture-cancel"]').trigger("click");
    expect(mounted.wrapper.get('[data-testid="knowledge-form"]').element).toBe(form);
    await mounted.wrapper.get('[data-testid="knowledge-check-receipt"]').trigger("click"); await flush();
    expect(mounted.wrapper.get('[data-testid="knowledge-form"]').element).toBe(form);
    expect(mounted.wrapper.get('[data-testid="knowledge-save"]').attributes("disabled")).toBeDefined();
    await mounted.wrapper.get('[data-testid="knowledge-check-receipt"]').trigger("click"); await flush();
    expect(receipts).toEqual([posts[0].command_id, posts[0].command_id]);
    expect(posts).toHaveLength(1);
    expect(mounted.wrapper.find('[data-testid="knowledge-form"]').exists()).toBe(false);
  });

  it("确切来源重读失权后清除正文和确认，不提交已失效的来源", async () => {
    activate(); let readable = true; let posts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === `${base}/projects/${projectId}`) return json(project());
      if (url === `${base}/knowledge?project_id=${projectId}`) return json([]);
      if (url === `${base}/artifact-versions/${artifactVersionId}/content`) return readable
        ? artifactBody("仅授权时可见的来源正文") : json({ code: "FORBIDDEN", detail: "source permission revoked" }, 403);
      if (init?.method === "POST") { posts++; throw new Error("must not write"); }
      throw new Error(`unexpected request ${url}`);
    }));
    const mounted = await mountWorkbench(`/projects/${projectId}/knowledge`); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="knowledge-create"]').trigger("click");
    await mounted.wrapper.get('[data-testid="knowledge-title"]').setValue("我的收录标题");
    await mounted.wrapper.get('[data-testid="knowledge-source-kind"]').setValue("ARTIFACT_VERSION");
    await mounted.wrapper.get('[data-testid="knowledge-artifact-id"]').setValue(artifactVersionId);
    await mounted.wrapper.get('[data-testid="knowledge-read-artifact"]').trigger("click"); await flush();
    await mounted.wrapper.get('[data-testid="knowledge-capture-confirmed"]').setValue(true);
    readable = false;
    await mounted.wrapper.get('[data-testid="knowledge-read-artifact"]').trigger("click"); await flush();
    expect(mounted.wrapper.find('[data-testid="knowledge-capture-body"]').exists()).toBe(false);
    expect(mounted.wrapper.find('[data-testid="knowledge-capture-confirmed"]').exists()).toBe(false);
    expect(mounted.wrapper.text()).not.toContain("仅授权时可见的来源正文");
    expect(mounted.wrapper.get('[data-testid="knowledge-title"]').element).toHaveProperty("value", "我的收录标题");
    expect(mounted.wrapper.get('[data-testid="knowledge-capture-source"] [role="alert"]').text()).toContain("source permission revoked");
    await mounted.wrapper.get('[data-testid="knowledge-form"]').trigger("submit"); await flush();
    expect(mounted.wrapper.get('[data-testid="knowledge-capture-confirmation"] [role="alert"]').text()).toContain("请先读取确切产物版本");
    expect(posts).toBe(0);
  });

  it("取消追加收录恢复原阅读组件与历史版本，不将当前版本替换旧选择", async () => {
    activate(); let posts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") { posts++; throw new Error("must not write"); }
      if (url === `${base}/projects/${projectId}`) return json(project());
      if (url === `${base}/knowledge?project_id=${projectId}`) return json([knowledge()]);
      if (url === `${base}/knowledge/${knowledgeId}`) return json(knowledge());
      if (url === `${base}/knowledge/${knowledgeId}/versions`) return json([version("2"), version("1")]);
      const number = url.endsWith("/1/content") ? "1" : "2";
      if (url === `${base}/knowledge/${knowledgeId}/versions/${number}/content`) return json({ ...version(number),
        title: "原资料", project_id: projectId, current_version: "2", source_uri: null, content_status: "FULL", content: `保存的第 ${number} 版正文` });
      throw new Error(`unexpected request ${url}`);
    }));
    const mounted = await mountWorkbench(`/projects/${projectId}/knowledge`); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="knowledge-reader-version"]').setValue("1"); await flush();
    const reader = mounted.wrapper.get('[data-testid="knowledge-reader"]').element;
    await mounted.wrapper.get('[data-testid="knowledge-new-version"]').trigger("click");
    await mounted.wrapper.get('[data-testid="knowledge-text"]').setValue("尚未提交的追加内容");
    expect(mounted.wrapper.get('[data-testid="knowledge-reader"]').element).toBe(reader);
    expect(reader?.closest("[hidden]")).not.toBeNull();
    expect(mounted.wrapper.get('[data-testid="knowledge-capture-confirmation"]').text()).toContain("基于起草修订 v4");
    await mounted.wrapper.get('[data-testid="knowledge-capture-cancel"]').trigger("click");
    expect(mounted.wrapper.get('[data-testid="knowledge-reader"]').element).toBe(reader);
    expect(reader?.closest("[hidden]")).toBeNull();
    expect(mounted.wrapper.get('[data-testid="knowledge-reader-version"]').element).toHaveProperty("value", "1");
    expect(mounted.wrapper.get('[data-testid="knowledge-reader-body"]').text()).toBe("保存的第 1 版正文");
    expect(posts).toBe(0);
  });
});
