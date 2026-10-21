import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

/**
 * 日常减负（工作台 §42）：普通笔记、产物收录与规则都不该让用户先学会底层术语。
 *
 * 这里只断言「操作面」的事实：提交体、来源绑定与是否还要求手工搬运标识；
 * 领域约束（版本绑定、HARD 检查、写入守卫）仍由 knowledge*.spec 覆盖。
 */

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "77777777-7777-4777-8777-777777777777";
const knowledgeId = "22222222-2222-4222-8222-222222222222";
const taskId = "55555555-5555-4555-8555-555555555555";
const artifactId = "66666666-6666-4666-8666-666666666666";
const artifactVersionId = "88888888-8888-4888-8888-888888888888";
const base = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
let unmount: (() => void) | null = null;

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function text(body: string): Response {
  return { ok: true, status: 200, text: async () => body } as Response;
}
function project() {
  return { id: projectId, title: "当前项目", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null };
}
function knowledge() {
  return { id: knowledgeId, project_id: projectId, title: "手写笔记", status: "ACTIVE", revision: "1",
    current_version: "1", created_at: "2026-10-20T00:00:00Z", updated_at: "2026-10-20T00:00:00Z" };
}
function task() {
  return { id: taskId, project_id: projectId, title: "整理论文初稿", status: "READY", revision: "1",
    mode: "ME", executor: { kind: "HUMAN", run_id: null }, current_completion_id: null,
    waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
    created_at: "2026-10-20T00:00:00Z", updated_at: "2026-10-20T00:00:00Z" };
}
function artifact() {
  return { id: artifactId, task_id: taskId, title: "实验结果初稿", revision: "2", latest_version_id: artifactVersionId,
    version_count: 1, versions: [{ artifact_version_id: artifactVersionId, version_number: "1",
      media_type: "text/markdown", sha256: "a".repeat(64), size: "12", source_kind: "HUMAN",
      created_at: "2026-10-20T08:00:00Z" }] };
}
function activate() { activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" }); }

afterEach(() => { unmount?.(); unmount = null; resetRelayConnectionForTest(); vi.unstubAllGlobals(); });

describe("日常减负：资料与规则的操作面", () => {
  it("普通笔记只填标题与正文即可保存，不再出现收录仪式", async () => {
    activate();
    const posts: Record<string, unknown>[] = [];
    let committed = false;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === `${base}/projects/${projectId}`) return json(project());
      if (url === `${base}/knowledge?project_id=${projectId}`) return json(committed ? [knowledge()] : []);
      if (url === `${base}/knowledge` && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        committed = true;
        return json({ command_id: (JSON.parse(String(init.body)) as Record<string, unknown>).command_id,
          command_type: "CreateKnowledge", committed_at: "2026-10-20T00:00:00Z",
          result: { knowledge_id: knowledgeId, revision: "1", version: "1", status: "ACTIVE" } }, 201);
      }
      if (url === `${base}/knowledge/${knowledgeId}`) return json(knowledge());
      if (url === `${base}/knowledge/${knowledgeId}/versions`) return json([]);
      throw new Error(`unexpected request ${url}`);
    }));
    const mounted = await mountWorkbench(`/projects/${projectId}/knowledge`); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="knowledge-create"]').trigger("click");
    // 首屏就是标题与正文：没有「人工收录草稿」「保存前核对」「对照来源」这些前置。
    expect(mounted.wrapper.find('[data-testid="knowledge-capture-confirmation"]').exists()).toBe(false);
    expect(mounted.wrapper.find('[data-testid="knowledge-capture-source"]').exists()).toBe(false);
    expect(mounted.wrapper.get('[data-testid="knowledge-form"]').text()).not.toContain("人工收录草稿");
    await mounted.wrapper.get('[data-testid="knowledge-title"]').setValue("手写笔记");
    await mounted.wrapper.get('[data-testid="knowledge-text"]').setValue("今天想清楚的一件事。");
    await mounted.wrapper.get('[data-testid="knowledge-form"]').trigger("submit"); await flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ project_id: projectId, title: "手写笔记", source_kind: "NOTE", text: "今天想清楚的一件事。" });
    // 媒体类型仍按既有默认落在请求里，用户不需要为它做选择。
    expect(posts[0]).toMatchObject({ media_type: "text/plain" });
  });

  it("产物收录从候选列表选中即读取确切版本，不需要先复制版本 ID", async () => {
    activate();
    const posts: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === `${base}/projects/${projectId}`) return json(project());
      if (url === `${base}/knowledge?project_id=${projectId}`) return json([]);
      if (url === `${base}/tasks?project_id=${projectId}`) return json({ items: [task()], next_cursor: null });
      if (url === `${base}/tasks/${taskId}/artifacts`) return json({ items: [artifact()], current_accepted_version_ids: [] });
      if (url === `${base}/artifact-versions/${artifactVersionId}/content`) return text("确切版本正文");
      if (url === `${base}/knowledge` && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return json({ command_id: "00000000-0000-4000-8000-000000000001", command_type: "CreateKnowledge",
          committed_at: "2026-10-20T00:00:00Z",
          result: { knowledge_id: knowledgeId, revision: "1", version: "1", status: "ACTIVE" } }, 201);
      }
      if (url === `${base}/knowledge/${knowledgeId}`) return json(knowledge());
      if (url === `${base}/knowledge/${knowledgeId}/versions`) return json([]);
      throw new Error(`unexpected request ${url}`);
    }));
    const mounted = await mountWorkbench(`/projects/${projectId}/knowledge`); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="knowledge-create"]').trigger("click");
    await mounted.wrapper.get('[data-testid="knowledge-title"]').setValue("收录实验结果");
    await mounted.wrapper.get('[data-testid="knowledge-source-kind"]').setValue("ARTIFACT_VERSION"); await flush();
    const candidate = mounted.wrapper.get(`[data-testid="knowledge-artifact-candidate-${artifactVersionId}"]`);
    expect(candidate.text()).toContain("实验结果初稿");
    expect(candidate.text()).toContain("整理论文初稿");
    await candidate.trigger("click"); await flush();
    // 选中即读：正文出现，且没有额外点一次「核对」。
    expect(mounted.wrapper.get('[data-testid="knowledge-capture-body"]').text()).toContain("确切版本正文");
    await mounted.wrapper.get('[data-testid="knowledge-capture-confirmed"]').setValue(true);
    await mounted.wrapper.get('[data-testid="knowledge-form"]').trigger("submit"); await flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ source_kind: "ARTIFACT_VERSION", artifact_version_id: artifactVersionId });
    expect(posts[0]).not.toHaveProperty("text");
  });

  it("规则只填陈述就能创建：请求里不带 rule_key，键由服务端生成", async () => {
    activate();
    const posts: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === `${base}/rules` && init?.method !== "POST") return json([]);
      if (url === `${base}/rules` && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push(body);
        return json({ command_id: body.command_id, command_type: "CreateRule",
          committed_at: "2026-10-20T00:00:00Z",
          result: { rule_id: knowledgeId, revision: "0", version: "1", status: "ACTIVE" } }, 201);
      }
      if (url === `${base}/rules/${knowledgeId}`) return json({ id: knowledgeId, scope: "WORKSPACE",
        scope_id: workspaceId, project_id: null, task_id: null, status: "ACTIVE", revision: "1",
        current_version: "1", rule_key: `rule-${String(posts[0]?.command_id)}`, statement: "所有引用须核验",
        strength: "PREFERENCE", applicability: "AI_RUN", enforcement: "HUMAN", method: null, target_spec: {},
        created_at: "2026-10-20T00:00:00Z", updated_at: "2026-10-20T00:00:00Z" });
      if (url === `${base}/rules/${knowledgeId}/versions`) return json([]);
      if (url === `${base}/rules?project_id=${projectId}`) return json([]);
      throw new Error(`unexpected request ${url}`);
    }));
    const mounted = await mountWorkbench("/knowledge?kind=RULE"); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="knowledge-create"]').trigger("click");
    const form = mounted.wrapper.get('[data-testid="knowledge-form"]');
    // 规则键只在高级折叠里，且不是必填项。
    expect(form.get('[data-testid="rule-key"]').attributes("placeholder")).toBe("留空由服务端生成");
    await mounted.wrapper.get('[data-testid="rule-statement"]').setValue("所有引用须核验");
    await mounted.wrapper.get('[data-testid="knowledge-form"]').trigger("submit"); await flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ scope: "WORKSPACE", scope_id: workspaceId, statement: "所有引用须核验" });
    expect(posts[0]).not.toHaveProperty("rule_key");
  });

  it("显式填写规则键仍原样提交，既有引用不被改写", async () => {
    activate();
    const posts: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === `${base}/rules` && init?.method !== "POST") return json([]);
      if (url === `${base}/rules` && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push(body);
        return json({ command_id: body.command_id, command_type: "CreateRule",
          committed_at: "2026-10-20T00:00:00Z",
          result: { rule_id: knowledgeId, revision: "0", version: "1", status: "ACTIVE" } }, 201);
      }
      if (url === `${base}/rules/${knowledgeId}`) return json({ id: knowledgeId, scope: "WORKSPACE",
        scope_id: workspaceId, project_id: null, task_id: null, status: "ACTIVE", revision: "1",
        current_version: "1", rule_key: "citation-required", statement: "所有引用须核验",
        strength: "PREFERENCE", applicability: "AI_RUN", enforcement: "HUMAN", method: null, target_spec: {},
        created_at: "2026-10-20T00:00:00Z", updated_at: "2026-10-20T00:00:00Z" });
      if (url === `${base}/rules/${knowledgeId}/versions`) return json([]);
      throw new Error(`unexpected request ${url}`);
    }));
    const mounted = await mountWorkbench("/knowledge?kind=RULE"); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="knowledge-create"]').trigger("click");
    await mounted.wrapper.get('[data-testid="rule-statement"]').setValue("所有引用须核验");
    await mounted.wrapper.get('[data-testid="rule-key"]').setValue("citation-required");
    await mounted.wrapper.get('[data-testid="knowledge-form"]').trigger("submit"); await flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ rule_key: "citation-required", statement: "所有引用须核验" });
  });
});
