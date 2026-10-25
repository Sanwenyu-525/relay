import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProjectStatePanel from "../src/components/ProjectStatePanel";
import ProjectTitleEditor from "../src/components/ProjectTitleEditor";
import { RelayApiClient } from "../src/api/relayClient";
import type { RelayProjectState, RelayTaskSummary } from "../src/api/relayClient";
import { flush, mountReact } from "./mountApp";

/** P1-A：Project State 的类型化写入口（CAS、冻结命令、错配与失权）。 */

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "99999999-9999-4999-8999-999999999999";
const root = `/api/v1/workspaces/${workspaceId}`;

function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function client() {
  return new RelayApiClient({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
}
function state(overrides: Partial<RelayProjectState> = {}): RelayProjectState {
  return { projectId, revision: "3", phaseKey: "PLANNING", nextActionTaskId: null,
    inProgress: [], blockers: [], risks: [], selectedArtifactVersionRefs: [],
    completedHighlightRefs: [], allowedActions: ["SET_PHASE", "SET_NEXT_ACTION"], ...overrides };
}
function task(): RelayTaskSummary {
  return { id: taskId, title: "跑实验", projectId, status: "READY",
    mode: "ME", revision: "1", executor: "HUMAN", executorRunId: null,
    currentCompletionId: null, waitingReason: null, blockingTaskIds: [],
    unresolvedBlockerIds: [], allowedActions: [], updatedAt: null };
}

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; sessionStorage.clear(); vi.unstubAllGlobals(); });

async function mountPanel(overrides: {
  readonly state?: Partial<RelayProjectState>;
  readonly archived?: boolean;
  readonly onChanged?: () => void;
  readonly tasks?: readonly RelayTaskSummary[];
} = {}) {
  const changed = vi.fn();
  const mounted = await mountReact(createElement(ProjectStatePanel, {
    client: client(), projectId, projectType: "GENERAL", state: state(overrides.state),
    tasks: overrides.tasks ?? [task()], goals: [], archived: overrides.archived ?? false,
    onChanged: overrides.onChanged ?? changed,
  }));
  cleanup = mounted.unmount;
  await flush();
  return { ...mounted, changed };
}

describe("Project State 写入口", () => {
  it("阶段选项按项目类型限制，命令携带原 revision 并核对回执", async () => {
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === "POST" && url.pathname === `${root}/projects/${projectId}/state-commands`) {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push({ path: url.pathname, body });
        return response(200, { command_id: body.command_id, committed_at: "2026-10-24T00:00:00Z",
          result: { project_id: projectId, action: body.action, revision: "4" } });
      }
      throw new Error(`unexpected ${url}`);
    }));
    const view = await mountPanel();

    const options = Array.from((view.wrapper.get('[data-testid="state-phase"]').element as HTMLSelectElement)
      .querySelectorAll("option")).map((option) => option.value);
    expect(options).toEqual(["PLANNING", "EXECUTING", "REVIEW"]);

    await view.wrapper.get('[data-testid="state-phase"]').setValue("EXECUTING");
    await view.wrapper.get('[data-testid="state-phase-submit"]').trigger("click");
    await flush(); await flush();

    expect(posts).toHaveLength(1);
    expect(posts[0]?.body.action).toBe("SET_PHASE");
    expect(posts[0]?.body.phase_key).toBe("EXECUTING");
    expect(posts[0]?.body.expected_revision).toBe("3");
    expect(posts[0]?.body.command_id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(view.changed).toHaveBeenCalledTimes(1);
    expect(view.wrapper.get('[data-testid="project-state-receipt"]').text()).toContain("v4");
  });

  it("登记阻塞使用类型化参数，不提交整份 State JSON", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === "POST" && url.pathname.endsWith("/state-commands")) {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        bodies.push(body);
        return response(200, { command_id: body.command_id, committed_at: "2026-10-24T00:00:00Z",
          result: { project_id: projectId, action: body.action, revision: "4" } });
      }
      throw new Error(`unexpected ${url}`);
    }));
    const view = await mountPanel();

    await view.wrapper.get('[data-testid="state-blocker-open"]').trigger("click");
    await flush();
    await view.wrapper.get('[data-testid="state-blocker-kind"]').setValue("TASK");
    await flush();
    await view.wrapper.get('[data-testid="state-blocker-reason"]').setValue("实验设备未就绪");
    await view.wrapper.get('[data-testid="state-blocker-submit"]').trigger("click");
    await flush(); await flush();

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ action: "ADD_BLOCKER", target_kind: "TASK",
      target_id: taskId, reason: "实验设备未就绪", expected_revision: "3",
      source_ref: `human:workbench:project/${projectId}` });
    expect(Object.keys(bodies[0]!).sort()).toEqual(["action", "command_id", "expected_revision",
      "reason", "source_ref", "target_id", "target_kind"]);
    expect(view.changed).toHaveBeenCalledTimes(1);
  });

  it("响应修订错配时不宣布成功，保留 pending 且不重发", async () => {
    const posts: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === "POST" && url.pathname.endsWith("/state-commands")) {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push(body);
        return response(200, { command_id: body.command_id, committed_at: "2026-10-24T00:00:00Z",
          result: { project_id: projectId, action: body.action, revision: "9" } });
      }
      throw new Error(`unexpected ${url}`);
    }));
    const view = await mountPanel();

    await view.wrapper.get('[data-testid="state-phase"]').setValue("EXECUTING");
    await view.wrapper.get('[data-testid="state-phase-submit"]').trigger("click");
    await flush(); await flush();

    expect(view.wrapper.find('[data-testid="project-state-receipt"]').exists()).toBe(false);
    expect(view.wrapper.get('[data-testid="project-state-pending"]').exists()).toBe(true);
    expect(view.wrapper.get('[data-testid="project-state-error"]').text()).toContain("不匹配");
    expect(view.changed).not.toHaveBeenCalled();
    expect(posts).toHaveLength(1);
  });

  it("revision 冲突是明确拒绝：清 pending 并重读，不伪造成功", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === "POST" && url.pathname.endsWith("/state-commands")) {
        return response(409, { code: "REVISION_CONFLICT", detail: "State 已变化",
          conflict: { expected_revision: "3", actual_revision: "5" } });
      }
      throw new Error(`unexpected ${url}`);
    }));
    const view = await mountPanel();

    await view.wrapper.get('[data-testid="state-phase"]').setValue("EXECUTING");
    await view.wrapper.get('[data-testid="state-phase-submit"]').trigger("click");
    await flush(); await flush();

    expect(view.wrapper.find('[data-testid="project-state-pending"]').exists()).toBe(false);
    expect(view.wrapper.get('[data-testid="project-state-error"]').text()).toContain("v5");
    expect(view.changed).toHaveBeenCalledTimes(1);
  });

  it("归档项目只读：State 写入入口不可用", async () => {
    const view = await mountPanel({ archived: true });
    expect(view.wrapper.get('[data-testid="state-phase-submit"]').attributes("disabled")).toBeDefined();
    expect(view.wrapper.get('[data-testid="state-risk-open"]').attributes("disabled")).toBeDefined();
    expect(view.wrapper.get('[data-testid="state-blocker-open"]').attributes("disabled")).toBeDefined();
  });
});

describe("Project 标题编辑", () => {
  const project = { id: projectId, title: "旧标题", projectType: "GENERAL",
    revision: "2", stateRevision: "3", archivedAt: null };

  it("只提交标题与 Project revision，成功后回执绑定原命令", async () => {
    const posts: { method: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === "PATCH" && url.pathname === `${root}/projects/${projectId}`) {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push({ method: "PATCH", body });
        return response(200, { command_id: body.command_id, committed_at: "2026-10-24T00:00:00Z",
          result: { project_id: projectId, title: body.title, revision: "3" } });
      }
      throw new Error(`unexpected ${url}`);
    }));
    const changed = vi.fn();
    const view = await mountReact(createElement(ProjectTitleEditor, { client: client(),
      project, archived: false, onChanged: changed }));
    cleanup = view.unmount;
    await flush();

    await view.wrapper.get('[data-testid="project-rename-open"]').trigger("click");
    await view.wrapper.get('[data-testid="project-title-input"]').setValue("新标题");
    await view.wrapper.get('[data-testid="project-rename-submit"]').trigger("click");
    await flush(); await flush();

    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toMatchObject({ title: "新标题", expected_revision: "2" });
    expect(Object.keys(posts[0]!.body).sort()).toEqual(["command_id", "expected_revision", "title"]);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(view.wrapper.get('[data-testid="project-rename-receipt"]').text()).toContain("新标题");
  });

  it("归档项目不提供改名入口", async () => {
    const view = await mountReact(createElement(ProjectTitleEditor, { client: client(),
      project: { ...project, archivedAt: "2026-10-01T00:00:00Z" }, archived: true,
      onChanged: vi.fn() }));
    cleanup = view.unmount;
    await flush();
    expect(view.wrapper.get('[data-testid="project-rename-open"]').attributes("disabled")).toBeDefined();
  });
});
