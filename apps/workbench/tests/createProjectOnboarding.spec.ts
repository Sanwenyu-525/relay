import { webcrypto } from "node:crypto";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench, type DomWrapper } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const knowledgeId = "33333333-3333-4333-8333-333333333333";
const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
const created = "2026-09-26T00:00:00.000Z";
let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.(); unmount = null;
  resetRelayConnectionForTest(); sessionStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
function connect() {
  vi.stubGlobal("crypto", webcrypto);
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
}
function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function envelope(commandId: string, result: Record<string, unknown>, commandType?: string) {
  return { command_id: commandId, ...(commandType ? { command_type: commandType } : {}),
    committed_at: created, result, links: { resource: `/api/v1/workspaces/${workspaceId}/projects/${projectId}` } };
}
function projectResult() {
  return { project_id: projectId, revision: "0", phase_key: "PLANNING", state_revision: "1" };
}
function knowledgeResult() {
  return { knowledge_id: knowledgeId, revision: "0", version: "1", status: "ACTIVE" };
}
function commonGet(path: string): Response | null {
  if (path === "/packs" || path === "/skill-definitions") return response(200, { items: [] });
  if (path === `/projects/${projectId}`) return response(200, { id: projectId, title: "初始项目",
    project_type: "GENERAL", revision: "0", state_revision: "1", archived_at: null });
  if (path === `/projects/${projectId}/state`) return response(200, { project_id: projectId,
    phase_key: "PLANNING", revision: "1", next_action_task_id: null,
    selected_artifact_version_refs: [], completed_highlight_refs: [] });
  if (path === `/projects/${projectId}/view-configuration`) return response(200, {
    project_id: projectId, revision: "1", kind: "general", template_version: "1",
    template_sha256: "a".repeat(64), pages: ["state", "tasks", "artifacts", "reviews"]
      .map((page_id, position) => ({ page_id, visible: true, position })), updated_at: created });
  if (path === `/projects/${projectId}/goals` ||
    path === `/projects/${projectId}/blueprint-proposals`) return response(200, { items: [] });
  if (path === `/tasks?project_id=${projectId}`) return response(200, { items: [], next_cursor: null });
  if (path === `/knowledge/${knowledgeId}`) return response(200, { id: knowledgeId,
    project_id: projectId, title: "first.md", status: "ACTIVE", revision: "0",
    current_version: "1", created_at: created, updated_at: created });
  return null;
}
async function fillProject(wrapper: DomWrapper, goal = "") {
  await wrapper.get('input[name="project-title"]').setValue("初始项目");
  if (goal) await wrapper.get('textarea[name="project-goal"]').setValue(goal);
  await wrapper.findAll('input[name="project-type"]')[0].setValue();
}
async function selectFile(wrapper: DomWrapper, file: File) {
  const input = wrapper.get('input[name="project-import"]').element as HTMLInputElement;
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await flush(80);
}

describe("首次创建 live 引导", () => {
  it("目标只随项目进入待预览人工蓝图草稿，刷新后仍可读取", async () => {
    connect();
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push({ path, body });
        if (path === "/projects") return response(201, envelope(String(body.command_id), projectResult()));
      }
      return commonGet(path) ?? response(404, {});
    }));
    let mounted = await mountWorkbench("/projects?view=create"); unmount = mounted.unmount;
    await fillProject(mounted.wrapper, "梳理验收路径");
    await mounted.wrapper.get('[data-testid="project-create-submit"]').trigger("click");
    await flush(100);
    expect(posts).toHaveLength(1);
    expect(posts[0].path).toBe("/projects");
    expect(posts[0].body).toEqual({ command_id: expect.any(String), title: "初始项目",
      project_type: "GENERAL" });
    expect(mounted.wrapper.get('[data-testid="project-created-result"]').text()).toContain("尚未成为 Goal");
    expect(sessionStorage.getItem(`relay:initial-blueprint-intent:${baseUrl}:${workspaceId}:${projectId}`))
      .toBe("梳理验收路径");
    await mounted.wrapper.findAll("button").find((button) =>
      button.text().includes("结束本次引导并新建项目"))!.trigger("click");
    expect(sessionStorage.getItem(`relay:create-project:${baseUrl}:${workspaceId}:${projectId}`)).toBeNull();
    mounted.unmount(); unmount = null;
    mounted = await mountWorkbench(`/projects/${projectId}?skill=blueprint`); unmount = mounted.unmount;
    expect((mounted.wrapper.get('[data-testid="blueprint-intent"]').element as HTMLTextAreaElement).value)
      .toBe("梳理验收路径");
    expect(posts).toHaveLength(1);
  });

  it("资料单独登记为 MANAGED_TEXT，成功后清除暂存正文", async () => {
    connect();
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push({ path, body });
        if (path === "/projects") return response(201, envelope(String(body.command_id), projectResult()));
        if (path === "/knowledge") return response(201, envelope(String(body.command_id), knowledgeResult()));
      }
      return commonGet(path) ?? response(404, {});
    }));
    const mounted = await mountWorkbench("/projects?view=create"); unmount = mounted.unmount;
    await fillProject(mounted.wrapper);
    await selectFile(mounted.wrapper, new File(["初始资料内容"], "first.md", { type: "text/markdown" }));
    expect(mounted.wrapper.text()).toContain("first.md");
    await mounted.wrapper.get('[data-testid="project-create-submit"]').trigger("click");
    await flush(100);
    expect(posts.map((item) => item.path)).toEqual(["/projects", "/knowledge"]);
    expect(posts[1].body).toEqual({ command_id: expect.any(String), project_id: projectId,
      title: "first.md", source_kind: "MANAGED_TEXT", text: "初始资料内容", media_type: "text/markdown" });
    expect(mounted.wrapper.get('[data-testid="project-created-result"]').text()).toContain(knowledgeId);
    expect(sessionStorage.getItem(`relay:create-project:${baseUrl}:${workspaceId}:${projectId}`))
      .not.toContain("初始资料内容");
  });

  it("项目响应不明保留原 ID 与资料，刷新核对成功后才独立导入", async () => {
    connect();
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    let receiptReady = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push({ path, body });
        if (path === "/projects") throw new TypeError("response lost");
        if (path === "/knowledge") return response(201, envelope(String(body.command_id), knowledgeResult()));
      }
      if (path.startsWith("/commands/")) return receiptReady
        ? response(200, envelope(String(posts[0].body.command_id), projectResult(), "CreateProject"))
        : response(404, { code: "COMMAND_NOT_FOUND", status: 404 });
      return commonGet(path) ?? response(404, {});
    }));
    let mounted = await mountWorkbench("/projects?view=create"); unmount = mounted.unmount;
    await fillProject(mounted.wrapper, "项目方向");
    await selectFile(mounted.wrapper, new File(["待恢复资料"], "first.md"));
    await mounted.wrapper.get('[data-testid="project-create-submit"]').trigger("click");
    await flush(100);
    expect(mounted.wrapper.get('[data-testid="project-create-pending"]').text())
      .toContain(String(posts[0].body.command_id));
    mounted.unmount(); unmount = null;
    receiptReady = true;
    mounted = await mountWorkbench("/projects?view=create"); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="project-create-pending"] button').trigger("click");
    await flush(100);
    expect(posts.map((item) => item.path)).toEqual(["/projects", "/knowledge"]);
    expect(mounted.wrapper.get('[data-testid="project-created-result"]').text()).toContain(knowledgeId);
  });

  it("资料响应不明刷新后仅用原 ID、原目标和原内容重试，不重复建项目", async () => {
    connect();
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    let recoverKnowledge = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push({ path, body });
        if (path === "/projects") return response(201, envelope(String(body.command_id), projectResult()));
        if (path === "/knowledge") {
          if (!recoverKnowledge) throw new TypeError("response lost");
          return response(201, envelope(String(body.command_id), knowledgeResult()));
        }
      }
      if (path.startsWith("/commands/")) return response(404, { code: "COMMAND_NOT_FOUND", status: 404 });
      return commonGet(path) ?? response(404, {});
    }));
    let mounted = await mountWorkbench("/projects?view=create"); unmount = mounted.unmount;
    await fillProject(mounted.wrapper);
    await selectFile(mounted.wrapper, new File(["重试内容"], "first.md"));
    await mounted.wrapper.get('[data-testid="project-create-submit"]').trigger("click");
    await flush(100);
    expect(mounted.wrapper.get('[data-testid="project-knowledge-pending"]').text()).toContain("SHA-256");
    const first = posts.find((item) => item.path === "/knowledge")!;
    const pending = sessionStorage.getItem(`relay:create-project:${baseUrl}:${workspaceId}:${projectId}`);
    expect(pending).toContain("重试内容");
    expect(pending).toContain(first.body.command_id as string);
    expect(pending).toMatch(/"sha256":"[a-f0-9]{64}"/u);
    mounted.unmount(); unmount = null;
    recoverKnowledge = true;
    mounted = await mountWorkbench("/projects?view=create"); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="project-knowledge-pending"] button').trigger("click");
    await flush(30);
    const buttons = mounted.wrapper.findAll('[data-testid="project-knowledge-pending"] button');
    expect(buttons).toHaveLength(2);
    await buttons[1].trigger("click");
    await flush(100);
    expect(posts.filter((item) => item.path === "/projects")).toHaveLength(1);
    expect(posts.filter((item) => item.path === "/knowledge").map((item) => item.body)).toEqual([first.body, first.body]);
    expect(sessionStorage.getItem(`relay:create-project:${baseUrl}:${workspaceId}:${projectId}`))
      .not.toContain("重试内容");
  });

  it("取消创建清除尚未提交的资料；会话存储失败时阻止创建", async () => {
    connect();
    const posts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if (init?.method === "POST") posts.push(path);
      return commonGet(path) ?? response(404, {});
    }));
    let mounted = await mountWorkbench("/projects?view=create"); unmount = mounted.unmount;
    await fillProject(mounted.wrapper);
    await selectFile(mounted.wrapper, new File(["待取消内容"], "first.md"));
    expect(sessionStorage.getItem(`relay:create-project:${baseUrl}:${workspaceId}:new`))
      .toContain("待取消内容");
    await mounted.wrapper.findAll("button").find((button) =>
      button.text().includes("取消创建并返回列表"))!.trigger("click");
    expect(sessionStorage.getItem(`relay:create-project:${baseUrl}:${workspaceId}:new`)).toBeNull();
    mounted.unmount(); unmount = null;
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key.startsWith("relay:create-project:")) throw new DOMException("storage denied", "QuotaExceededError");
      original.call(this, key, value);
    });
    mounted = await mountWorkbench("/projects?view=create"); unmount = mounted.unmount;
    await mounted.wrapper.get('input[name="project-title"]').setValue("无法暂存");
    expect(mounted.wrapper.text()).toContain("无法保存创建草稿");
    expect(mounted.wrapper.get('[data-testid="project-create-submit"]').attributes("disabled"))
      .toBeDefined();
    expect(posts).toHaveLength(0);
  });
});
