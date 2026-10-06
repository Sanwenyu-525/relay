import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, liveClient, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountReact, mountWorkbench } from "./mountApp";
import ProjectKnowledgeGuide from "../src/components/ProjectKnowledgeGuide";
import KnowledgeCurationPanel from "../src/components/KnowledgeCurationPanel";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const scope = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const artifactId = "44444444-4444-4444-8444-444444444444";
const artifactVersionId = "55555555-5555-4555-8555-555555555555";
const decisionId = "66666666-6666-4666-8666-666666666666";
const ruleId = "77777777-7777-4777-8777-777777777777";
const knowledgeId = "88888888-8888-4888-8888-888888888888";
const knowledgeVersionId = "99999999-9999-4999-8999-999999999999";
const candidateId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const orphanDecisionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
let unmount: (() => void) | null = null;

afterEach(() => { unmount?.(); unmount = null; resetRelayConnectionForTest(); vi.unstubAllGlobals(); });

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function envelope(result: Record<string, unknown>): Response {
  return json({ command_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    committed_at: "2026-10-02T00:00:00Z", result, links: { resource: `${scope}/x` } });
}

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ordinal: 0, ref_kind: "KNOWLEDGE", reference_mode: "CURRENT", target_id: knowledgeId,
    label: null, title: "既有资料", resolved_version_id: knowledgeVersionId,
    resolved_version_number: "1", target_status: "ACTIVE", is_current: true,
    resolution: "AVAILABLE", note: "", ...overrides };
}

function guide(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { project_id: projectId, exists: true, revision: "1", entry_count: 1,
    entries: [entry()], gaps: [], ...overrides };
}

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: candidateId, project_id: projectId, source_artifact_version_id: artifactVersionId,
    source_artifact_id: artifactId, source_version_number: "2", source_title: "来源成果",
    suggested_title: "来源成果", suggested_knowledge_id: null, suggested_knowledge_title: null,
    similar: [], status: "PROPOSED", accepted_knowledge_id: null,
    accepted_knowledge_version_id: null, stale_reason: null, rejected_at: null, ...overrides };
}

const decisions = [{ id: decisionId, project_id: projectId, title: "项目决定", status: "ACTIVE",
  revision: "1", current_version: "1", choice: "A", rationale: "因为", alternatives: [], costs: [],
  superseded_by_id: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" }];
const rules = [{ id: ruleId, rule_key: "project-rule", scope: "PROJECT", scope_id: projectId,
  project_id: projectId, task_id: null, status: "ACTIVE", revision: "1", current_version: "1",
  statement: "应当这样", strength: "HARD", applicability: "本项目全部任务",
  enforcement: "PRE_ACTION", method: null, target_spec: {},
  created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" }];
const knowledge = [{ id: knowledgeId, project_id: projectId, title: "既有资料", status: "ACTIVE",
  revision: "1", current_version: "1", created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z" }];

interface Stub {
  readonly guide?: () => Response;
  readonly candidates?: () => Response;
  readonly save?: (body: Record<string, unknown>) => Response;
  readonly accept?: () => Response;
  readonly reject?: () => Response;
  readonly propose?: () => Response;
  readonly taskProjectId?: string | null;
}

const calls: { url: string; method: string; body: Record<string, unknown> | null }[] = [];

function stubFetch(options: Stub = {}): void {
  calls.length = 0;
  const task = { id: taskId, project_id: options.taskProjectId === undefined ? projectId
    : options.taskProjectId, title: "任务", status: "IN_PROGRESS", mode: "DELEGATE_AI", revision: "1",
    executor: { kind: "AI", run_id: null }, executor_run_id: null, current_completion_id: null,
    waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
    created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" };
  const information = `${scope}/decisions?project_id=${projectId}`;
  const routes: Record<string, () => Response> = {
    [`${scope}/projects/${projectId}/knowledge-guide`]: options.guide ?? (() => json(guide())),
    [`${scope}/projects/${projectId}/knowledge-curation-candidates`]:
      options.candidates ?? (() => json({ items: [candidate()] })),
    [information]: () => json(decisions),
    [`${scope}/rules?project_id=${projectId}`]: () => json(rules),
    [`${scope}/knowledge?project_id=${projectId}`]: () => json(knowledge),
    [`${scope}/tasks?project_id=${projectId}`]: () => json({ items: [{ ...task }], next_cursor: null }),
    [`${scope}/tasks/${taskId}`]: () => json({ ...task,
      acceptance: { acceptance_revision: "1", objective: "目标", source: "CREATE", criteria: [] },
      dependencies: [], children: [] }),
    [`${scope}/tasks/${taskId}/artifacts`]: () => json({ items: [] }),
    [`${scope}/artifacts/${artifactId}`]: () => json({ id: artifactId, task_id: taskId,
      title: "来源成果", revision: "2", latest_version_id: artifactVersionId, version_count: 2,
      versions: [{ artifact_version_id: artifactVersionId, version_number: "2",
        media_type: "text/markdown", sha256: "a".repeat(64), size: "12",
        source_kind: "HUMAN_EDIT", created_at: "2026-10-02T00:00:00Z" }] }),
    [`${scope}/artifact-versions/${artifactVersionId}/lineage`]: () => json({
      artifact_version_id: artifactVersionId, artifact_id: artifactId, version_number: "2",
      sha256: "a".repeat(64), source_kind: "HUMAN_EDIT", content_availability: "AVAILABLE",
      direct_parents: [] }),
    [`${scope}/attention/interventions`]: () => json({ items: [] }),
    [`${scope}/artifacts/${artifactId}/text-locks`]: () => json({ artifact_id: artifactId, locks: [] }),
    [`${scope}/artifact-versions/${artifactVersionId}/content`]: () => json({
      artifact_version_id: artifactVersionId, content_availability: "AVAILABLE",
      media_type: "text/markdown", text: "# 来源成果\n" }) };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
    calls.push({ url, method, body });
    if (method === "PUT" && url === `${scope}/projects/${projectId}/knowledge-guide`)
      return options.save?.(body ?? {}) ?? envelope({ revision: "2", entry_count: 2 });
    if (method === "POST" && url === `${scope}/projects/${projectId}/knowledge-curation-candidates`)
      // 服务端命令回执只回候选 ID，不回整对象；这里必须按真实契约造响应，
      // 否则夹具会掩盖「客户端读 items」这类跨层契约破裂。
      return options.propose?.() ?? envelope({ project_id: projectId, candidate_ids: [candidateId] });
    if (method === "POST" && url.endsWith(`/knowledge-curation-candidates/${candidateId}/accept`))
      return options.accept?.() ?? envelope({ candidate_id: candidateId, knowledge_id: knowledgeId,
        knowledge_version_id: knowledgeVersionId, knowledge_revision: "1", mode: "CREATED" });
    if (method === "POST" && url.endsWith(`/knowledge-curation-candidates/${candidateId}/reject`))
      return options.reject?.() ?? envelope({ candidate_id: candidateId, status: "REJECTED" });
    const route = routes[url];
    if (route) return route();
    return json({ code: "RESOURCE_NOT_FOUND", detail: `not stubbed: ${method} ${url}` }, 404);
  }));
}

async function openGuide(): Promise<Awaited<ReturnType<typeof mountReact>>> {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
  const client = liveClient();
  if (client === null) throw new Error("live client expected");
  const mounted = await mountReact(createElement(MemoryRouter, null,
    createElement(ProjectKnowledgeGuide, { client, projectId, onOpen: () => {} })));
  unmount = mounted.unmount;
  await flush();
  return mounted;
}

async function openCuration(): Promise<Awaited<ReturnType<typeof mountReact>>> {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
  const client = liveClient();
  if (client === null) throw new Error("live client expected");
  const mounted = await mountReact(createElement(KnowledgeCurationPanel,
    { client, artifactId, artifactVersionId, versionNumber: "2" }));
  unmount = mounted.unmount;
  await flush();
  return mounted;
}

describe("N03 项目知识导读", () => {
  it("按服务端顺序显示条目、人工说明与修订，不自行推导顺序", async () => {
    stubFetch({ guide: () => json(guide({ revision: "7", entry_count: 2,
      entries: [entry({ ordinal: 0, label: "先读这份" }),
        entry({ ordinal: 1, ref_kind: "DECISION", target_id: decisionId, title: "项目决定",
          resolved_version_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" })] })) });
    const mounted = await openGuide();
    const view = mounted.wrapper.get('[data-testid="project-knowledge-guide"]');
    expect(view.text()).toContain("修订 v7");
    expect(view.text()).toContain("先读这份（既有资料）");
    expect(view.findAll(".knowledge-guide__entries li")).toHaveLength(2);
    expect(view.findAll(".knowledge-guide__kind").map((node) => node.text()))
      .toEqual(["资料", "决定"]);
    expect(calls.filter((call) => call.url.endsWith("/knowledge-guide") && call.method === "GET"))
      .toHaveLength(1);
  });

  it("钉住版本后才允许切换 PINNED，且提示与当前版本的差别", async () => {
    stubFetch({ guide: () => json(guide({ entries: [entry({ resolution: "STALE",
      is_current: false, resolved_version_number: "1" })] })) });
    const mounted = await openGuide();
    const view = mounted.wrapper.get('[data-testid="project-knowledge-guide"]');
    expect(view.text()).toContain("钉住的版本已不是最新");
    const pin = view.find('input[type="checkbox"]');
    await pin.setValue(true);
    await flush();
    await mounted.wrapper.findAll("button").filter((node) =>
      node.text() === "保存导读")[0]!.trigger("click");
    await flush();
    const put = calls.find((call) => call.method === "PUT");
    expect(put?.body?.entries).toEqual([{ ref_kind: "KNOWLEDGE", reference_mode: "PINNED",
      knowledge_id: knowledgeId, pinned_version_id: knowledgeVersionId }]);
  });

  it("冲突时明确说明未保存并重新读取，不假装成功", async () => {
    stubFetch({ save: () => json({ code: "REVISION_CONFLICT",
      detail: "expected_revision 不符" }, 409) });
    const mounted = await openGuide();
    await mounted.wrapper.findAll("button").filter((node) =>
      node.text() === "全部加入（2）")[0]!.trigger("click");
    await flush();
    await mounted.wrapper.findAll("button").filter((node) =>
      node.text() === "保存导读")[0]!.trigger("click");
    await flush();
    expect(mounted.wrapper.get('[data-testid="project-knowledge-guide"]').text())
      .toContain("导读已被别处改动，本次未保存");
  });

  it("空导读提供一次加入全部目标，且不自动写入", async () => {
    stubFetch({ guide: () => json({ project_id: projectId, exists: false, revision: "0",
      entry_count: 0, entries: [], gaps: ["尚未编排任何条目"] }) });
    const mounted = await openGuide();
    const view = mounted.wrapper.get('[data-testid="project-knowledge-guide"]');
    expect(view.text()).toContain("尚未保存过编排");
    expect(view.text()).toContain("尚未编排任何条目");
    await view.findAll("button").filter((node) => node.text() === "全部加入（3）")[0]!.trigger("click");
    await flush();
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
    expect(mounted.wrapper.findAll(".knowledge-guide__entries li")).toHaveLength(3);
  });

  it("移除条目后整份替换保存，不留下被删对象", async () => {
    stubFetch({ guide: () => json(guide({ entry_count: 2, entries: [entry(),
      entry({ ordinal: 1, ref_kind: "DECISION", target_id: orphanDecisionId, title: "另一决定" })] })) });
    const mounted = await openGuide();
    await mounted.wrapper.findAll("button").filter((node) => node.text() === "移除")[1]!
      .trigger("click");
    await flush();
    await mounted.wrapper.findAll("button").filter((node) =>
      node.text() === "保存导读")[0]!.trigger("click");
    await flush();
    const put = calls.find((call) => call.method === "PUT");
    expect(put?.body?.expected_revision).toBe("1");
    expect(put?.body?.entries).toHaveLength(1);
  });
});

describe("N03 整理候选", () => {
  it("在成果版本处提候选，并说明只提示不合并", async () => {
    stubFetch();
    const mounted = await openCuration();
    const view = mounted.wrapper.get('[data-testid="knowledge-curation"]');
    expect(view.text()).toContain("只生成提示");
    await view.findAll("button").filter((node) =>
      node.text() === "把 v2 提为整理候选")[0]!.trigger("click");
    await flush();
    const post = calls.find((call) => call.method === "POST"
      && call.url.endsWith("/knowledge-curation-candidates"));
    expect(post?.body?.sources).toEqual([{ artifact_version_id: artifactVersionId }]);
    expect(view.text()).toContain("只提示，不会自动合并");
  });

  it("接受与拒绝都写命令并刷新终态，已拒绝不再提供操作", async () => {
    let rejected = false;
    stubFetch({ candidates: () => json({ items: [candidate(rejected
      ? { status: "REJECTED", rejected_at: "2026-10-02T01:00:00Z" } : {})] }),
      reject: () => { rejected = true;
        return envelope({ candidate_id: candidateId, status: "REJECTED" }); } });
    const mounted = await openCuration();
    const view = mounted.wrapper.get('[data-testid="knowledge-curation"]');
    await view.findAll("button").filter((node) => node.text() === "拒绝")[0]!.trigger("click");
    await flush();
    expect(calls.some((call) => call.url.endsWith(`/${candidateId}/reject`))).toBe(true);
    expect(mounted.wrapper.get('[data-testid="curation-candidate-REJECTED"]').text())
      .toContain("已拒绝，不会再询问");
    expect(mounted.wrapper.findAll("button").filter((node) => node.text() === "接受为知识"))
      .toHaveLength(0);
  });

  it("状态已被别处改变时说明并刷新，不静默失败", async () => {
    stubFetch({ accept: () => json({ code: "INVALID_TRANSITION", detail: "已接受" }, 409) });
    const mounted = await openCuration();
    await mounted.wrapper.findAll("button").filter((node) =>
      node.text() === "接受为知识")[0]!.trigger("click");
    await flush();
    expect(mounted.wrapper.get('[data-testid="knowledge-curation"]').text())
      .toContain("这个候选的状态已经变了");
  });

  it("任务未关联项目时不生成候选，也不静默跳过", async () => {
    stubFetch({ taskProjectId: null });
    const mounted = await openCuration();
    expect(mounted.wrapper.get('[data-testid="knowledge-curation"]').text())
      .toContain("还没关联项目");
    expect(calls.some((call) => call.url.includes("knowledge-curation-candidates"))).toBe(false);
  });

  it("谱系页挂载整理面板", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    stubFetch();
    const mounted = await mountWorkbench(`/artifact-versions/${artifactVersionId}/lineage`);
    unmount = mounted.unmount;
    for (let attempt = 0; attempt < 20
      && !mounted.wrapper.find('[data-testid="knowledge-curation"]').exists(); attempt += 1) {
      await flush(40);
    }
    expect(mounted.wrapper.find('[data-testid="knowledge-curation"]').exists()).toBe(true);
  });
});