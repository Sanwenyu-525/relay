import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import SafeMarkdown from "../src/components/SafeMarkdown";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { resetSessionArtifactsForTest } from "../src/lib/sessionArtifacts";
import { flush, mountReact, mountWorkbench } from "./mountApp";

const BASE_URL = "http://127.0.0.1:8787";
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const TASK_ID = "33333333-3333-4333-8333-333333333333";
const ARTIFACT_ID = "44444444-4444-4444-8444-444444444444";
const VERSION_ID = "55555555-5555-4555-8555-555555555555";
const VERSION_TWO_ID = "66666666-6666-4666-8666-666666666666";
const OTHER_ARTIFACT_ID = "99999999-9999-4999-8999-999999999999";
const OTHER_VERSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMPLETION_ID = "77777777-7777-4777-8777-777777777777";
const TOKEN = "test-bearer-token-0123456789abcdef";

let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
  resetRelayConnectionForTest();
  resetSessionArtifactsForTest();
  vi.unstubAllGlobals();
});

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
}

type StubHandler = (url: string, method: string, body: Record<string, unknown>) => Promise<Response>;

function stubFetch(handler: StubHandler): { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      const body =
        init === undefined || typeof init.body !== "string"
          ? {}
          : (JSON.parse(init.body) as Record<string, unknown>);
      calls.push({ url, method, body });
      return handler(url, method, body);
    })
  );
  return { calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body))
  } as unknown as Response;
}

function envelope(commandId: string, result: Record<string, unknown>): Record<string, unknown> {
  return {
    command_id: commandId,
    committed_at: "2026-09-21T00:00:00.000Z",
    result,
    links: { resource: `/api/v1/workspaces/${WORKSPACE_ID}/tasks/${TASK_ID}` }
  };
}

/** GET /tasks/{id} 的最小合法投影；覆盖项用于表达 DONE、缺少动作等状态。 */
function taskDetailBody(overrides: {
  readonly status?: string;
  readonly revision?: string;
  readonly acceptanceRevision?: string;
  readonly allowedActions?: readonly string[];
  readonly currentCompletionId?: string | null;
}): Record<string, unknown> {
  return {
    id: TASK_ID,
    project_id: PROJECT_ID,
    title: "真实任务",
    status: overrides.status ?? "IN_PROGRESS",
    mode: "ME",
    revision: overrides.revision ?? "2",
    acceptance_revision: overrides.acceptanceRevision ?? "1",
    executor: { kind: "HUMAN", run_id: null, ownership_epoch: "0" },
    current_completion_id: overrides.currentCompletionId ?? null,
    waiting_reason: null,
    blocking_task_ids: [],
    unresolved_blocker_ids: [],
    allowed_actions: overrides.allowedActions ?? ["EDIT_PRESENTATION", "SAVE_ARTIFACT_VERSION", "COMPLETE", "CANCEL"],
    created_at: "2026-09-21T00:00:00.000Z",
    updated_at: "2026-09-21T00:00:00.000Z",
    acceptance: {
      acceptance_revision: overrides.acceptanceRevision ?? "1",
      objective: "产出可核对的结果",
      expected_outputs: {},
      source: "CREATE",
      created_at: "2026-09-21T00:00:00.000Z",
      criteria: [
        { criterion_id: "c1", statement: "结果可复现", required: true, method: "HUMAN", target_spec: {} },
        { criterion_id: "c2", statement: "记录可追溯", required: true, method: "HUMAN", target_spec: {} }
      ]
    },
    goal_alignment: { mode: "INHERIT", goal_ids: [], effective_goal_ids: [] },
    dependencies: []
  };
}

function projectStateBody(selected: readonly Record<string, unknown>[] = []): Record<string, unknown> {
  return {
    project_id: PROJECT_ID,
    phase_key: "PLANNING",
    next_action_task_id: null,
    revision: "1",
    updated_at: "2026-09-21T00:00:00.000Z",
    in_progress: [],
    blockers: [],
    risks: [],
    completed_highlight_refs: [],
    selected_artifact_version_refs: selected,
    key_decision_refs: [],
    dependency_versions: {
      project: "0",
      state: "1",
      workspace_authority: "0",
      project_goals: [],
      tasks: [],
      completion_refs: [],
      artifact_version_refs: []
    },
    allowed_actions: []
  };
}

function taskArtifactsBody(
  versions: readonly { id: string; number: string; hash: string; size: string }[] = [],
  revision = "0",
  accepted: readonly string[] = []
): Record<string, unknown> {
  return {
    items: versions.length ? [{
      id: ARTIFACT_ID, task_id: TASK_ID, project_id: PROJECT_ID,
      artifact_kind: "MARKDOWN_DOCUMENT", title: "任务产物", revision,
      latest_version_id: versions.at(-1)?.id ?? null, version_count: versions.length,
      created_at: "2026-09-21T00:00:00.000Z", updated_at: "2026-09-21T00:00:00.000Z",
      versions: versions.map((version) => ({
        artifact_version_id: version.id, version_number: version.number,
        media_type: "text/markdown", sha256: version.hash, size: version.size,
        source_kind: "HUMAN", created_at: "2026-09-21T00:00:00.000Z"
      }))
    }] : [],
    current_accepted_version_ids: accepted
  };
}

const taskUrl = `${BASE_URL}/api/v1/workspaces/${WORKSPACE_ID}/tasks/${TASK_ID}`;
const artifactsUrl = `${BASE_URL}/api/v1/workspaces/${WORKSPACE_ID}/artifacts`;
const stateUrl = `${BASE_URL}/api/v1/workspaces/${WORKSPACE_ID}/projects/${PROJECT_ID}/state`;
const stateCommandsUrl = `${stateUrl}-commands`;

function activate(): void {
  activateRelayConnection({ baseUrl: BASE_URL, workspaceId: WORKSPACE_ID, bearerToken: TOKEN });
}

describe("任务详情（UI-10）", () => {
  it("fixture：展示三个独立事实与示例验收条件，产物页签不提供写入", async () => {
    const mounted = await mountWorkbench("/tasks/task-evaluation-metrics");
    unmount = mounted.unmount;

    const text = mounted.wrapper.text();
    expect(text).toContain("三个独立事实");
    expect(text).toContain("验收版本");
    expect(mounted.wrapper.find('[data-testid="task-detail"]').exists()).toBe(true);

    await mounted.wrapper.get('[data-testid="task-detail-tab-artifacts"]').trigger("click");
    await flush();

    expect(mounted.wrapper.get('[data-testid="artifact-fixture-gap"]').text()).toContain("示例数据没有产物事实");
    expect(mounted.wrapper.find('[data-testid="artifact-save"]').exists()).toBe(false);
  });

  it("fixture：没有示例事实的任务不显示别人的内容", async () => {
    const mounted = await mountWorkbench("/tasks/task-unknown");
    unmount = mounted.unmount;

    expect(mounted.wrapper.text()).toContain("示例数据没有这个任务");
  });

  it("skill 查询参数仍然进入 Skill 页签壳，不被任务详情取代", async () => {
    const mounted = await mountWorkbench("/tasks/task-evaluation-metrics?skill=definition");
    unmount = mounted.unmount;

    expect(mounted.wrapper.find('[data-testid="task-detail"]').exists()).toBe(false);
    expect(mounted.wrapper.text()).toContain("完善定义");
  });
});

describe("产物与完成闭环（UI-11，live）", () => {
  it("保存版本用任务 revision 与 text/markdown，选择版本走 Project State，完成带上必需条件与版本", async () => {
    activate();
    let taskRevision = "2";
    let versions: { id: string; number: string; hash: string; size: string }[] = [];
    const { calls } = stubFetch(async (url, method, body) => {
      if (method === "GET" && url === taskUrl) {
        return jsonResponse(200, taskDetailBody({ revision: taskRevision }));
      }
      if (method === "GET" && url === `${taskUrl}/artifacts`) {
        return jsonResponse(200, taskArtifactsBody(versions, versions.length ? String(versions.length - 1) : "0"));
      }
      if (method === "GET" && url === stateUrl) {
        return jsonResponse(200, projectStateBody());
      }
      if (method === "POST" && url === `${taskUrl}/artifacts`) {
        versions = [{ id: VERSION_ID, number: "1", hash: "a".repeat(64), size: "12" }];
        taskRevision = "3";
        return jsonResponse(
          201,
          envelope(String(body.command_id), {
            task_id: TASK_ID,
            artifact_id: ARTIFACT_ID,
            artifact_revision: "0",
            version_id: VERSION_ID,
            version_number: "1",
            media_type: "text/markdown",
            sha256: "a".repeat(64),
            size: "12",
            task_revision: "3"
          })
        );
      }
      if (method === "POST" && url === `${artifactsUrl}/${ARTIFACT_ID}/versions`) {
        versions = [...versions, { id: VERSION_TWO_ID, number: "2", hash: "b".repeat(64), size: "20" }];
        taskRevision = "4";
        return jsonResponse(
          201,
          envelope(String(body.command_id), {
            task_id: TASK_ID,
            artifact_id: ARTIFACT_ID,
            artifact_revision: "1",
            version_id: VERSION_TWO_ID,
            version_number: "2",
            media_type: "text/markdown",
            sha256: "b".repeat(64),
            size: "20",
            task_revision: "4"
          })
        );
      }
      if (method === "POST" && url === stateCommandsUrl) {
        return jsonResponse(
          200,
          envelope(String(body.command_id), { project_id: PROJECT_ID, action: "SELECT_ARTIFACT_VERSION", revision: "2" })
        );
      }
      if (method === "POST" && url === `${taskUrl}/complete`) {
        return jsonResponse(
          200,
          envelope(String(body.command_id), {
            task_id: TASK_ID,
            status: "DONE",
            revision: "3",
            acceptance_revision: "1",
            completion_id: COMPLETION_ID,
            human_acceptance_id: "88888888-8888-4888-8888-888888888888",
            artifact_version_ids: [VERSION_TWO_ID],
            state_revision: "3"
          })
        );
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });

    const mounted = await mountWorkbench(`/tasks/${TASK_ID}`);
    unmount = mounted.unmount;
    await flush(60);

    await mounted.wrapper.get('[data-testid="task-detail-tab-artifacts"]').trigger("click");
    await flush();

    await mounted.wrapper.get('textarea[name="artifact-content"]').setValue("# 第一版\n\n- 结果可复现");
    await mounted.wrapper.get('[data-testid="artifact-save"]').trigger("click");
    await flush(80);

    const createCall = calls.find((call) => call.method === "POST" && call.url === `${taskUrl}/artifacts`);
    expect(createCall?.body.media_type).toBe("text/markdown");
    expect(createCall?.body.expected_task_revision).toBe("2");
    expect(typeof createCall?.body.command_id).toBe("string");
    expect(mounted.wrapper.get('[data-testid="artifact-save-receipt"]').text()).toContain("已创建产物");

    // 第二次保存续写同一个产物：expected_artifact_revision 用上次返回的 revision。
    await mounted.wrapper.get('textarea[name="artifact-content"]').setValue("# 第二版\n\n- 记录可追溯");
    await mounted.wrapper.get('[data-testid="artifact-save"]').trigger("click");
    await flush(80);

    const versionCall = calls.find((call) => call.url === `${artifactsUrl}/${ARTIFACT_ID}/versions`);
    expect(versionCall?.body.expected_artifact_revision).toBe("0");
    expect(versionCall?.body.expected_task_revision).toBe("3");
    expect(mounted.wrapper.text()).toContain("v2");

    await mounted.wrapper.get('[data-testid="artifact-select-version"]').trigger("click");
    await flush(80);

    const selectCall = calls.find((call) => call.url === stateCommandsUrl);
    expect(selectCall?.body.action).toBe("SELECT_ARTIFACT_VERSION");
    expect(selectCall?.body.expected_revision).toBe("1");
    expect(selectCall?.body.artifact_version_id).toBe(VERSION_TWO_ID);
    // source_ref 是服务端必需输入：省略会被 REQUIRED_INPUT_MISSING 拒绝。
    expect(String(selectCall?.body.source_ref)).toContain(TASK_ID);

    await mounted.wrapper.get('[data-testid="criterion-c1"]').setValue(true);
    await mounted.wrapper.get('[data-testid="criterion-c2"]').setValue(true);
    await mounted.wrapper.get('[data-testid="task-complete"]').trigger("click");
    await flush(80);

    const completeCall = calls.find((call) => call.url === `${taskUrl}/complete`);
    expect(completeCall?.body.expected_revision).toBe("4");
    expect(completeCall?.body.acceptance_revision).toBe("1");
    expect(completeCall?.body.artifact_version_ids).toEqual([VERSION_TWO_ID]);
    expect(completeCall?.body.acceptance).toMatchObject({ accepted_criterion_ids: ["c1", "c2"] });
    expect(mounted.wrapper.get('[data-testid="task-complete-receipt"]').text()).toContain(COMPLETION_ID);
  });

  it.each(["网络响应丢失", "HTTP 503"])("保存 A 遇到%s后编辑 B，原回执只确认 A，B 使用新 ID 和 revision 续写", async (failure) => {
    activate();
    let commandId = "";
    let receiptConfirmed = false;
    let wrongTargetReceipt = true;
    let appended = false;
    let taskRevision = "2";
    const { calls } = stubFetch(async (url, method, body) => {
      if (method === "GET" && url === taskUrl) {
        return jsonResponse(200, taskDetailBody({ revision: taskRevision }));
      }
      if (method === "GET" && url === `${taskUrl}/artifacts`) {
        const versions = receiptConfirmed ? [{ id: VERSION_ID, number: "1", hash: "c".repeat(64), size: "1" }] : [];
        if (appended) versions.push({ id: VERSION_TWO_ID, number: "2", hash: "d".repeat(64), size: "1" });
        return jsonResponse(200, taskArtifactsBody(versions, appended ? "1" : "0"));
      }
      if (method === "GET" && url === stateUrl) {
        return jsonResponse(200, projectStateBody());
      }
      if (method === "POST" && url === `${taskUrl}/artifacts`) {
        commandId = String(body.command_id);
        if (failure === "HTTP 503") return jsonResponse(503, { code: "DATABASE_UNAVAILABLE", detail: "temporary outage" });
        throw new TypeError("network down");
      }
      if (method === "GET" && url === `${BASE_URL}/api/v1/workspaces/${WORKSPACE_ID}/commands/${commandId}`) {
        if (!wrongTargetReceipt) {
          receiptConfirmed = true;
          taskRevision = "3";
        }
        return jsonResponse(200, {
          command_id: commandId,
          command_type: "CreateArtifactWithVersion",
          committed_at: "2026-09-21T00:00:00.000Z",
          result: {
            task_id: wrongTargetReceipt ? OTHER_ARTIFACT_ID : TASK_ID,
            artifact_id: ARTIFACT_ID,
            artifact_revision: "0",
            version_id: VERSION_ID,
            version_number: "1",
            media_type: "text/markdown",
            sha256: "c".repeat(64),
            size: "1",
            task_revision: "3"
          },
          links: { resource: `${artifactsUrl}/${ARTIFACT_ID}` }
        });
      }
      if (method === "POST" && url === `${artifactsUrl}/${ARTIFACT_ID}/versions`) {
        appended = true;
        taskRevision = "4";
        return jsonResponse(201, envelope(String(body.command_id), {
          task_id: TASK_ID, artifact_id: ARTIFACT_ID, artifact_revision: "1",
          version_id: VERSION_TWO_ID, version_number: "2", media_type: "text/markdown",
          sha256: "d".repeat(64), size: "1", task_revision: "4"
        }));
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });

    const mounted = await mountWorkbench(`/tasks/${TASK_ID}`);
    unmount = mounted.unmount;
    await flush(60);
    await mounted.wrapper.get('[data-testid="task-detail-tab-artifacts"]').trigger("click");
    await flush();

    await mounted.wrapper.get('textarea[name="artifact-content"]').setValue("A");
    await mounted.wrapper.get('[data-testid="artifact-save"]').trigger("click");
    await flush(80);

    expect(commandId).not.toBe("");
    if (failure === "网络响应丢失") expect(mounted.wrapper.text()).toContain("尚未确定");
    await mounted.wrapper.get('textarea[name="artifact-content"]').setValue("B");
    expect(mounted.wrapper.get('[data-testid="artifact-save"]').attributes("disabled")).toBeDefined();
    expect(mounted.wrapper.get('[data-testid="artifact-save-pending"]').text()).toContain(commandId);
    expect(calls.filter((call) => call.method === "POST" && call.url === `${taskUrl}/artifacts`)).toHaveLength(1);
    await mounted.wrapper.get('[data-testid="artifact-save-receipt-query"]').trigger("click");
    await flush(80);
    expect(mounted.wrapper.get('[data-testid="artifact-save-pending"]').text()).toContain(commandId);
    expect(mounted.wrapper.get('[data-testid="artifact-save"]').attributes("disabled")).toBeDefined();
    expect(mounted.wrapper.find('[data-testid="artifact-save-receipt"]').exists()).toBe(false);
    wrongTargetReceipt = false;
    await mounted.wrapper.get('[data-testid="artifact-save-receipt-query"]').trigger("click");
    await flush(80);

    expect(
      calls.some(
        (call) =>
          call.method === "GET" &&
          call.url === `${BASE_URL}/api/v1/workspaces/${WORKSPACE_ID}/commands/${commandId}`
      )
    ).toBe(true);
    expect(mounted.wrapper.get('[data-testid="artifact-save-receipt"]').text()).toContain("回执确认已提交");
    expect(mounted.wrapper.get('[data-testid="artifact-save-receipt"]').text()).toContain("当前草稿仍未保存");
    expect(mounted.wrapper.get('textarea[name="artifact-content"]').element).toHaveProperty("value", "B");
    expect((mounted.wrapper.get(`[data-testid="artifact-version-${VERSION_ID}"]`).element as HTMLInputElement).checked).toBe(false);
    expect(mounted.wrapper.get('[data-testid="artifact-save"]').attributes("disabled")).toBeUndefined();

    await mounted.wrapper.get('[data-testid="artifact-save"]').trigger("click");
    await flush(80);
    const original = calls.find((call) => call.method === "POST" && call.url === `${taskUrl}/artifacts`)!;
    const next = calls.find((call) => call.method === "POST" && call.url === `${artifactsUrl}/${ARTIFACT_ID}/versions`)!;
    expect(original.body).toMatchObject({ command_id: commandId, content: "A", expected_task_revision: "2" });
    expect(next.body).toMatchObject({ content: "B", expected_task_revision: "3", expected_artifact_revision: "0" });
    expect(next.body.command_id).not.toBe(commandId);
  });

  it("保存请求在途时继续编辑 B，迟到的 A 成功响应不会把 B 标为已保存", async () => {
    activate();
    let resolveSave: ((response: Response) => void) | undefined;
    let created = false;
    let saveCommandId = "";
    stubFetch(async (url, method, body) => {
      if (method === "GET" && url === taskUrl) return jsonResponse(200, taskDetailBody({ revision: created ? "3" : "2" }));
      if (method === "GET" && url === `${taskUrl}/artifacts`) return jsonResponse(200, taskArtifactsBody(
        created ? [{ id: VERSION_ID, number: "1", hash: "a".repeat(64), size: "1" }] : [], "0"
      ));
      if (method === "GET" && url === stateUrl) return jsonResponse(200, projectStateBody());
      if (method === "POST" && url === `${taskUrl}/artifacts`) {
        saveCommandId = String(body.command_id);
        return new Promise<Response>((resolve) => {
          resolveSave = (response) => { created = true; resolve(response); };
        });
      }
      throw new Error(`unexpected request: ${method} ${url} ${String(body.command_id ?? "")}`);
    });
    const mounted = await mountWorkbench(`/tasks/${TASK_ID}`);
    unmount = mounted.unmount;
    await flush(60);
    await mounted.wrapper.get('[data-testid="task-detail-tab-artifacts"]').trigger("click");
    await flush();
    await mounted.wrapper.get('textarea[name="artifact-content"]').setValue("A");
    await mounted.wrapper.get('[data-testid="artifact-save"]').trigger("click");
    expect(resolveSave).toBeDefined();
    await mounted.wrapper.get('textarea[name="artifact-content"]').setValue("B");
    expect(mounted.wrapper.get('[data-testid="artifact-save"]').attributes("disabled")).toBeDefined();
    resolveSave!(jsonResponse(201, envelope(saveCommandId, {
      task_id: TASK_ID, artifact_id: ARTIFACT_ID, artifact_revision: "0",
      version_id: VERSION_ID, version_number: "1", media_type: "text/markdown",
      sha256: "a".repeat(64), size: "1", task_revision: "3"
    })));
    await flush(80);
    expect(mounted.wrapper.get('textarea[name="artifact-content"]').element).toHaveProperty("value", "B");
    expect(mounted.wrapper.get('[data-testid="artifact-save-receipt"]').text()).toContain("当前草稿仍未保存");
    expect((mounted.wrapper.get(`[data-testid="artifact-version-${VERSION_ID}"]`).element as HTMLInputElement).checked).toBe(false);
  });

  it("产物列表读取失败时保留草稿并禁止把未知列表当空列表创建", async () => {
    activate();
    let listReady = false;
    const { calls } = stubFetch(async (url, method, body) => {
      if (method === "GET" && url === taskUrl) return jsonResponse(200, taskDetailBody({}));
      if (method === "GET" && url === stateUrl) return jsonResponse(200, projectStateBody());
      if (method === "GET" && url === `${taskUrl}/artifacts`) {
        return listReady ? jsonResponse(200, taskArtifactsBody())
          : jsonResponse(503, { code: "DATABASE_UNAVAILABLE", detail: "list temporarily unavailable" });
      }
      if (method === "POST" && url === `${taskUrl}/artifacts`) {
        return jsonResponse(201, envelope(String(body.command_id), {
          task_id: TASK_ID, artifact_id: ARTIFACT_ID, artifact_revision: "0",
          version_id: VERSION_ID, version_number: "1", media_type: "text/markdown",
          sha256: "a".repeat(64), size: "10", task_revision: "3"
        }));
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    const mounted = await mountWorkbench(`/tasks/${TASK_ID}`);
    unmount = mounted.unmount;
    await flush(60);
    await mounted.wrapper.get('[data-testid="task-detail-tab-artifacts"]').trigger("click");
    await flush();
    await mounted.wrapper.get('textarea[name="artifact-content"]').setValue("未保存的草稿");
    expect(mounted.wrapper.get('[data-testid="artifact-save"]').attributes("disabled")).toBeDefined();
    expect(mounted.wrapper.get('[data-testid="task-complete"]').attributes("disabled")).toBeDefined();
    expect(calls.filter((call) => call.method === "POST" && call.url === `${taskUrl}/artifacts`)).toHaveLength(0);
    listReady = true;
    await mounted.wrapper.get('[data-testid="artifact-versions"] button').trigger("click");
    await flush();
    expect(mounted.wrapper.get('textarea[name="artifact-content"]').element).toHaveProperty("value", "未保存的草稿");
    expect(mounted.wrapper.get('[data-testid="artifact-save"]').attributes("disabled")).toBeUndefined();
    await mounted.wrapper.get('[data-testid="artifact-save"]').trigger("click");
    await flush();
    expect(calls.filter((call) => call.method === "POST" && call.url === `${taskUrl}/artifacts`)).toHaveLength(1);
  });

  it("两个 Artifact 各有 v1 时按 version ID 区分选择、当前选用与本轮接受", async () => {
    activate();
    const original = taskArtifactsBody([{ id: VERSION_ID, number: "1", hash: "a".repeat(64), size: "10" }], "0", [VERSION_ID]) as {
      items: { id: string; title: string; latest_version_id: string; versions: { artifact_version_id: string }[] }[];
      current_accepted_version_ids: string[];
    };
    const second = {
      ...original.items[0]!, id: OTHER_ARTIFACT_ID, title: "AI 候选产物",
      latest_version_id: OTHER_VERSION_ID,
      versions: [{ ...original.items[0]!.versions[0]!, artifact_version_id: OTHER_VERSION_ID, source_kind: "AGENT" }]
    };
    stubFetch(async (url, method) => {
      if (method === "GET" && url === taskUrl) {
        return jsonResponse(200, taskDetailBody({ status: "DONE", revision: "3", allowedActions: ["REOPEN"], currentCompletionId: COMPLETION_ID }));
      }
      if (method === "GET" && url === `${taskUrl}/artifacts`) {
        return jsonResponse(200, { items: [original.items[0], second], current_accepted_version_ids: [VERSION_ID] });
      }
      if (method === "GET" && url === stateUrl) {
        return jsonResponse(200, projectStateBody([{
          artifact_version_id: OTHER_VERSION_ID, artifact_id: OTHER_ARTIFACT_ID,
          version_number: "1", source_ref: "human:test"
        }]));
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    const mounted = await mountWorkbench(`/tasks/${TASK_ID}`);
    unmount = mounted.unmount;
    await flush(60);
    await mounted.wrapper.get('[data-testid="task-detail-tab-artifacts"]').trigger("click");
    await flush();
    const firstChoice = mounted.wrapper.get(`[data-testid="artifact-version-${VERSION_ID}"]`);
    const secondChoice = mounted.wrapper.get(`[data-testid="artifact-version-${OTHER_VERSION_ID}"]`);
    expect(firstChoice.element!.closest("li")?.textContent).toContain("本轮接受");
    expect(firstChoice.element!.closest("li")?.textContent).not.toContain("当前选用");
    expect(secondChoice.element!.closest("li")?.textContent).toContain("当前选用");
    expect(secondChoice.element!.closest("li")?.textContent).not.toContain("本轮接受");
    expect((firstChoice.element as HTMLInputElement).checked).toBe(false);
    expect((secondChoice.element as HTMLInputElement).checked).toBe(false);
    await firstChoice.setValue(true);
    expect((firstChoice.element as HTMLInputElement).checked).toBe(true);
    expect((secondChoice.element as HTMLInputElement).checked).toBe(false);
  });

  it("已完成的任务关闭编辑与完成，只提供重开", async () => {
    activate();
    const { calls } = stubFetch(async (url, method, body) => {
      if (method === "GET" && url === taskUrl) {
        return jsonResponse(
          200,
          taskDetailBody({ status: "DONE", revision: "3", allowedActions: ["REOPEN"], currentCompletionId: COMPLETION_ID })
        );
      }
      if (method === "GET" && url === stateUrl) {
        return jsonResponse(200, projectStateBody());
      }
      if (method === "GET" && url === `${taskUrl}/artifacts`) {
        return jsonResponse(200, taskArtifactsBody());
      }
      if (method === "POST" && url === `${taskUrl}/reopen`) {
        return jsonResponse(
          200,
          envelope(String(body.command_id), {
            task_id: TASK_ID,
            status: "READY",
            revision: "4",
            acceptance_revision: "2",
            previous_acceptance_revision: "1",
            previous_completion_id: COMPLETION_ID
          })
        );
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });

    const mounted = await mountWorkbench(`/tasks/${TASK_ID}`);
    unmount = mounted.unmount;
    await flush(60);
    await mounted.wrapper.get('[data-testid="task-detail-tab-artifacts"]').trigger("click");
    await flush();

    expect(mounted.wrapper.find('[data-testid="artifact-editor-locked"]').exists()).toBe(true);
    expect(mounted.wrapper.get('[data-testid="artifact-save"]').attributes("disabled")).toBeDefined();
    expect(mounted.wrapper.get('[data-testid="task-complete"]').attributes("disabled")).toBeDefined();
    expect(mounted.wrapper.find('[data-testid="task-complete-done"]').exists()).toBe(true);

    await mounted.wrapper.get('input[name="reopen-reason"]').setValue("验收标准需要补充");
    await mounted.wrapper.get('[data-testid="task-reopen-submit"]').trigger("click");
    await flush(80);

    const reopenCall = calls.find((call) => call.url === `${taskUrl}/reopen`);
    expect(reopenCall?.body.reason).toBe("验收标准需要补充");
    expect(mounted.wrapper.get('[data-testid="task-reopen-receipt"]').text()).toContain("新验收版本 v2");
  });

  it.each(["直接成功", "原回执确认"])("同页重开（%s）清空旧轮选版和条件，历史版仍可手选", async (outcome) => {
    activate();
    let status = "IN_PROGRESS";
    let revision = "2";
    let acceptanceRevision = "1";
    let currentCompletionId: string | null = null;
    let reopenCommandId = "";
    const reopenResult = {
      task_id: TASK_ID, status: "READY", revision: "4", acceptance_revision: "2",
      previous_acceptance_revision: "1", previous_completion_id: COMPLETION_ID
    };
    const confirmReopen = () => {
      status = "READY";
      revision = "4";
      acceptanceRevision = "2";
      currentCompletionId = null;
    };
    stubFetch(async (url, method, body) => {
      if (method === "GET" && url === taskUrl) {
        return jsonResponse(200, taskDetailBody({
          status, revision, acceptanceRevision, currentCompletionId,
          allowedActions: status === "DONE" ? ["REOPEN"] : status === "READY" ? ["START_HUMAN"] : ["SAVE_ARTIFACT_VERSION", "COMPLETE"]
        }));
      }
      if (method === "GET" && url === `${taskUrl}/artifacts`) {
        return jsonResponse(200, taskArtifactsBody(
          [{ id: VERSION_ID, number: "1", hash: "a".repeat(64), size: "1" }], "0",
          status === "DONE" ? [VERSION_ID] : []
        ));
      }
      if (method === "GET" && url === stateUrl) return jsonResponse(200, projectStateBody());
      if (method === "POST" && url === `${taskUrl}/complete`) {
        status = "DONE";
        revision = "3";
        currentCompletionId = COMPLETION_ID;
        return jsonResponse(200, envelope(String(body.command_id), {
          task_id: TASK_ID, status, revision, acceptance_revision: "1",
          completion_id: COMPLETION_ID, human_acceptance_id: "88888888-8888-4888-8888-888888888888",
          artifact_version_ids: [VERSION_ID], state_revision: null
        }));
      }
      if (method === "POST" && url === `${taskUrl}/reopen`) {
        reopenCommandId = String(body.command_id);
        if (outcome === "原回执确认") throw new TypeError("response lost");
        confirmReopen();
        return jsonResponse(200, envelope(reopenCommandId, reopenResult));
      }
      if (method === "GET" && url === `${BASE_URL}/api/v1/workspaces/${WORKSPACE_ID}/commands/${reopenCommandId}`) {
        confirmReopen();
        return jsonResponse(200, { ...envelope(reopenCommandId, reopenResult), command_type: "ReopenTask" });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });

    const mounted = await mountWorkbench(`/tasks/${TASK_ID}`);
    unmount = mounted.unmount;
    await flush(60);
    await mounted.wrapper.get('[data-testid="task-detail-tab-artifacts"]').trigger("click");
    await flush();
    const editorElement = mounted.wrapper.get('[data-testid="artifact-editor"]').element;
    const versionChoice = () => mounted.wrapper.get(`[data-testid="artifact-version-${VERSION_ID}"]`);
    await versionChoice().setValue(true);
    await mounted.wrapper.get('[data-testid="criterion-c1"]').setValue(true);
    await mounted.wrapper.get('[data-testid="criterion-c2"]').setValue(true);
    await mounted.wrapper.get('[data-testid="task-complete"]').trigger("click");
    await flush(80);
    expect((versionChoice().element as HTMLInputElement).checked).toBe(true);
    expect((mounted.wrapper.get('[data-testid="criterion-c1"]').element as HTMLInputElement).checked).toBe(true);

    await mounted.wrapper.get('input[name="reopen-reason"]').setValue("新一轮验收");
    await mounted.wrapper.get('[data-testid="task-reopen-submit"]').trigger("click");
    await flush(80);
    if (outcome === "原回执确认") {
      expect((versionChoice().element as HTMLInputElement).checked).toBe(true);
      await mounted.wrapper.get('[data-testid="task-reopen-receipt-query"]').trigger("click");
      await flush(80);
    }

    expect(mounted.wrapper.get('[data-testid="artifact-editor"]').element).toBe(editorElement);
    expect(mounted.wrapper.get('[data-testid="task-reopen-receipt"]').text()).toContain("新验收版本 v2");
    expect((versionChoice().element as HTMLInputElement).checked).toBe(false);
    expect((mounted.wrapper.get('[data-testid="criterion-c1"]').element as HTMLInputElement).checked).toBe(false);
    expect((mounted.wrapper.get('[data-testid="criterion-c2"]').element as HTMLInputElement).checked).toBe(false);
    expect(mounted.wrapper.get('[data-testid="task-completion"]').text()).toContain("将随完成提交的产物版本：无");
    await versionChoice().setValue(true);
    expect((versionChoice().element as HTMLInputElement).checked).toBe(true);
  });

  it("live 读取失败时给出可操作说明，不回退到示例事实", async () => {
    activate();
    stubFetch(async (url, method) => {
      if (method === "GET" && url === taskUrl) {
        return jsonResponse(503, { code: "DATABASE_UNAVAILABLE", detail: "database is down", retryable: true });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });

    const mounted = await mountWorkbench(`/tasks/${TASK_ID}`);
    unmount = mounted.unmount;
    await flush(80);

    expect(mounted.wrapper.text()).toContain("数据库不可达");
    expect(mounted.wrapper.find('[data-testid="task-detail"]').exists()).toBe(false);
  });
});

describe("安全 Markdown 预览", () => {
  it("不执行原始 HTML 与危险链接，只渲染受支持的语法", async () => {
    const { wrapper, unmount } = await mountReact(createElement(SafeMarkdown, {
      source: "# 标题\n\n<script>window.__relayXss = true</script>\n\n- **加粗** 与 `code`\n- [危险](javascript:alert(1))\n- [安全](https://example.com/doc)"
    }));

    expect(wrapper.find("script").exists()).toBe(false);
    expect((window as unknown as { __relayXss?: boolean }).__relayXss).toBeUndefined();
    expect(wrapper.text()).toContain("window.__relayXss = true");
    expect(wrapper.text()).toContain("链接协议不受支持，未渲染");

    const anchors = wrapper.findAll("a");
    expect(anchors).toHaveLength(1);
    expect(anchors[0].attributes("href")).toBe("https://example.com/doc");
    expect(anchors[0].attributes("rel")).toContain("noreferrer");
    expect(wrapper.find("strong").text()).toBe("加粗");
    expect(wrapper.find("code").text()).toBe("code");
    unmount();
  });
});
