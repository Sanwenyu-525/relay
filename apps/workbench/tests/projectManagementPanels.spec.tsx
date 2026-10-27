import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProjectStatePanel from "../src/components/ProjectStatePanel";
import ProjectTitleEditor from "../src/components/ProjectTitleEditor";
import { RelayApiClient } from "../src/api/relayClient";
import type { RelayProjectState, RelayTaskSummary } from "../src/api/relayClient";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { hasUnsavedDraft } from "../src/lib/draftGuard";
import { clickPortal, dialogText, flush, mountReact, mountWorkbench } from "./mountApp";

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
afterEach(() => { cleanup?.(); cleanup = undefined; sessionStorage.clear(); localStorage.clear(); vi.restoreAllMocks(); resetRelayConnectionForTest(); vi.unstubAllGlobals(); });

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
  it("窗口会话结束后恢复 State 原命令，待核对期间仍接入全局守卫", async () => {
    const posts: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>); throw new TypeError("response lost");
    }));
    const first = await mountPanel();
    await first.wrapper.get('[data-testid="state-phase"]').setValue("EXECUTING");
    await first.wrapper.get('[data-testid="state-phase-submit"]').trigger("click"); await flush();
    const commandId = String(posts[0]?.command_id);
    expect(first.wrapper.get('[data-testid="project-state-pending"]').text()).toContain(commandId);
    expect(hasUnsavedDraft()).toBe(true);
    first.unmount(); cleanup = undefined; sessionStorage.clear();
    const reopened = await mountPanel();
    expect(reopened.wrapper.get('[data-testid="project-state-pending"]').text()).toContain(commandId);
    expect(posts).toHaveLength(1);
  });
  it("无法保存 State 命令时不发送请求", async () => {
    const fetcher = vi.fn(async () => response(500, {})); vi.stubGlobal("fetch", fetcher);
    const view = await mountPanel();
    await view.wrapper.get('[data-testid="state-phase"]').setValue("EXECUTING");
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key.startsWith("relay:project-state-pending:")) throw new DOMException("unavailable", "QuotaExceededError");
      return original.call(this, key, value);
    });
    await view.wrapper.get('[data-testid="state-phase-submit"]').trigger("click"); await flush();
    expect(fetcher).not.toHaveBeenCalled();
    expect(view.wrapper.text()).toContain("未发送");
  });
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

  it("2xx State 响应契约无效时保留冻结命令等待核对", async () => {
    const posts: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === "POST" && url.pathname.endsWith("/state-commands")) {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push(body);
        return response(200, { command_id: body.command_id,
          committed_at: "2026-10-24T00:00:00Z", result: null });
      }
      throw new Error(`unexpected ${url}`);
    }));
    const view = await mountPanel();

    await view.wrapper.get('[data-testid="state-phase"]').setValue("EXECUTING");
    await view.wrapper.get('[data-testid="state-phase-submit"]').trigger("click");
    await flush(); await flush();

    expect(view.wrapper.get('[data-testid="project-state-pending"]').exists()).toBe(true);
    expect(view.wrapper.get('[data-testid="project-state-error"]').text()).toContain("结果尚不能确认");
    expect(view.wrapper.find('[data-testid="project-state-receipt"]').exists()).toBe(false);
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

  it("窗口会话结束后恢复原改名命令，不重复发送", async () => {
    const posts: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>); throw new TypeError("response lost");
    }));
    const props = { client: client(), project, archived: false, onChanged: vi.fn() };
    const first = await mountReact(createElement(ProjectTitleEditor, props)); cleanup = first.unmount; await flush();
    await first.wrapper.get('[data-testid="project-rename-open"]').trigger("click");
    await first.wrapper.get('[data-testid="project-title-input"]').setValue("等待核对的标题");
    await first.wrapper.get('[data-testid="project-rename-submit"]').trigger("click"); await flush();
    const commandId = String(posts[0]?.command_id);
    expect(first.wrapper.get('[data-testid="project-rename-pending"]').text()).toContain(commandId);
    first.unmount(); cleanup = undefined; sessionStorage.clear();
    const reopened = await mountReact(createElement(ProjectTitleEditor, props)); cleanup = reopened.unmount; await flush();
    expect(reopened.wrapper.get('[data-testid="project-rename-pending"]').text()).toContain(commandId);
    expect(posts).toHaveLength(1);
  });

  it("无法保存改名命令时不发送请求并保留标题草稿", async () => {
    const fetcher = vi.fn(async () => response(500, {})); vi.stubGlobal("fetch", fetcher);
    const view = await mountReact(createElement(ProjectTitleEditor, { client: client(), project,
      archived: false, onChanged: vi.fn() })); cleanup = view.unmount; await flush();
    await view.wrapper.get('[data-testid="project-rename-open"]').trigger("click");
    await view.wrapper.get('[data-testid="project-title-input"]').setValue("未发送的标题");
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key.startsWith("relay:project-rename:")) throw new DOMException("unavailable", "QuotaExceededError");
      return original.call(this, key, value);
    });
    await view.wrapper.get('[data-testid="project-rename-submit"]').trigger("click"); await flush();
    expect(fetcher).not.toHaveBeenCalled();
    expect((view.wrapper.get('[data-testid="project-title-input"]').element as HTMLInputElement).value).toBe("未发送的标题");
    expect(view.wrapper.text()).toContain("未发送");
  });

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

  it("改名 2xx command_id 错配时保留冻结命令", async () => {
    const posts: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === "PATCH" && url.pathname === `${root}/projects/${projectId}`) {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push(body);
        return response(200, { command_id: "99999999-9999-4999-8999-999999999999",
          committed_at: "2026-10-24T00:00:00Z",
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

    expect(view.wrapper.find('[data-testid="project-rename-receipt"]').exists()).toBe(false);
    expect(view.wrapper.get('[data-testid="project-rename-pending"]').exists()).toBe(true);
    expect(view.wrapper.get('[data-testid="project-rename-error"]').text()).toContain("已保留原 command_id");
    expect(changed).not.toHaveBeenCalled();
    expect(posts).toHaveLength(1);
  });

  it("改名 2xx 回执格式无效时保留冻结命令", async () => {
    const posts: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === "PATCH" && url.pathname === `${root}/projects/${projectId}`) {
        posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return response(200, { command_id: posts[0]?.command_id,
          committed_at: "2026-10-24T00:00:00Z", result: null });
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

    expect(view.wrapper.find('[data-testid="project-rename-receipt"]').exists()).toBe(false);
    expect(view.wrapper.get('[data-testid="project-rename-pending"]').exists()).toBe(true);
    expect(view.wrapper.get('[data-testid="project-rename-error"]').text()).toContain("已保留原 command_id");
    expect(changed).not.toHaveBeenCalled();
    expect(posts).toHaveLength(1);
  });

  it("归档项目不提供改名入口", async () => {
    const view = await mountReact(createElement(ProjectTitleEditor, { client: client(),
      project: { ...project, archivedAt: "2026-10-01T00:00:00Z" }, archived: true,
      onChanged: vi.fn() }));
    cleanup = view.unmount;
    await flush();
    expect(view.wrapper.get('[data-testid="project-rename-open"]').attributes("disabled")).toBeDefined();
  });

  it("改名 2xx 回执标题与冻结命令不一致时不宣布成功，pending 保留", async () => {
    const posts: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === "PATCH" && url.pathname === `${root}/projects/${projectId}`) {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push(body);
        // 身份、Project、修订都对，但回执标题不是冻结命令提交的那份。
        return response(200, { command_id: body.command_id, committed_at: "2026-10-24T00:00:00Z",
          result: { project_id: projectId, title: "他人写入的标题", revision: "3" } });
      }
      throw new Error(`unexpected ${url}`);
    }));
    const changed = vi.fn();
    const view = await mountReact(createElement(ProjectTitleEditor, { client: client(),
      project, archived: false, onChanged: changed }));
    cleanup = view.unmount;
    await flush();

    await view.wrapper.get('[data-testid="project-rename-open"]').trigger("click");
    await view.wrapper.get('[data-testid="project-title-input"]').setValue("冻结的新标题");
    await view.wrapper.get('[data-testid="project-rename-submit"]').trigger("click");
    await flush(); await flush();

    expect(view.wrapper.find('[data-testid="project-rename-receipt"]').exists()).toBe(false);
    expect(view.wrapper.get('[data-testid="project-rename-pending"]').exists()).toBe(true);
    // 该组件把内容错配与传输类错配同归「结果尚不能确认」：pending 保留、按原 ID 查回执。
    expect(view.wrapper.get('[data-testid="project-rename-error"]').text()).toContain("已保留原 command_id");
    expect(changed).not.toHaveBeenCalled();
    expect(posts).toHaveLength(1);
  });

  it("Project 标题草稿接入全局路由守卫，显式丢弃后正常离页", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === `${root}/projects/${projectId}`) return response(200, {
        id: projectId, title: "旧标题", project_type: "GENERAL", revision: "2",
        state_revision: "3", archived_at: null
      });
      if (url.pathname === `${root}/projects/${projectId}/state`) return response(200, {
        project_id: projectId, phase_key: "PLANNING", next_action_task_id: null, revision: "3",
        updated_at: "2026-10-24T00:00:00Z", in_progress: [], blockers: [], risks: [],
        selected_artifact_version_refs: [], completed_highlight_refs: [], key_decision_refs: [],
        dependency_versions: {}, allowed_actions: []
      });
      return response(404, { code: "NOT_FOUND", detail: "该读取不是本次导航测试所需的数据。" });
    }));
    const view = await mountWorkbench(`/projects/${projectId}`);
    cleanup = view.unmount;
    await flush();

    await view.wrapper.get('[data-testid="project-rename-open"]').trigger("click");
    await view.wrapper.get('[data-testid="project-title-input"]').setValue("尚未保存的标题");
    await view.router.attempt(`/projects/${projectId}/planning`);
    expect(dialogText()).toContain("未保存的修改");
    await clickPortal("discard-draft-leave");
    await flush();
    expect(view.router.currentRoute.value.path).toBe(`/projects/${projectId}/planning`);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("Project 刷新时保留标题草稿并显示新修订；归档后只读，可明确丢弃", async () => {
    const onChanged = vi.fn();
    const view = await mountReact(createElement(ProjectTitleEditor, { client: client(),
      project, archived: false, onChanged }));
    cleanup = view.unmount;
    await flush();
    await view.wrapper.get('[data-testid="project-rename-open"]').trigger("click");
    await view.wrapper.get('[data-testid="project-title-input"]').setValue("我的标题草稿");

    await view.rerender(createElement(ProjectTitleEditor, { client: client(),
      project: { ...project, title: "他人更新的标题", revision: "3" }, archived: false, onChanged }));
    await flush();
    expect((view.wrapper.get('[data-testid="project-title-input"]').element as HTMLInputElement).value)
      .toBe("我的标题草稿");
    expect(view.wrapper.get('[data-testid="project-rename-conflict"]').text()).toContain("他人更新的标题");
    expect(view.wrapper.get('[data-testid="project-rename-conflict"]').text()).toContain("v3");
    expect(hasUnsavedDraft()).toBe(true);

    await view.rerender(createElement(ProjectTitleEditor, { client: client(),
      project: { ...project, title: "他人更新的标题", revision: "3", archivedAt: "2026-10-25T00:00:00Z" },
      archived: true, onChanged }));
    await flush();
    expect((view.wrapper.get('[data-testid="project-title-input"]').element as HTMLInputElement).value)
      .toBe("我的标题草稿");
    expect(view.wrapper.get('[data-testid="project-title-input"]').attributes("disabled")).toBeDefined();
    expect(view.wrapper.get('[data-testid="project-rename-archived-draft"]').exists()).toBe(true);
    await view.wrapper.get('[data-testid="project-rename-cancel"]').trigger("click");
    expect(hasUnsavedDraft()).toBe(false);
  });
});
