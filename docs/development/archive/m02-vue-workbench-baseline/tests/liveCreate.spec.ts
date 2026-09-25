import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

const BASE_URL = "http://127.0.0.1:8787";
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const TASK_ID = "33333333-3333-4333-8333-333333333333";
const TOKEN = "test-bearer-token-0123456789abcdef";

let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
  resetRelayConnectionForTest();
  vi.unstubAllGlobals();
});

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
}

type StubHandler = (
  url: string,
  method: string,
  body: Record<string, unknown>
) => Promise<Response>;

/** 打桩 fetch：记录每次调用的 URL/方法与 JSON body，再交给 handler 决定响应。 */
function stubFetch(handler: StubHandler): { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      const method = init?.method ?? "GET";
      const body = bodyOf(init);
      calls.push({ url, method, body });
      return handler(url, method, body);
    })
  );
  return { calls };
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  if (init === undefined || typeof init.body !== "string") {
    return {};
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body)
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

function activate(): void {
  activateRelayConnection({ baseUrl: BASE_URL, workspaceId: WORKSPACE_ID, bearerToken: TOKEN });
}

const projectUrl = `${BASE_URL}/api/v1/workspaces/${WORKSPACE_ID}/projects`;
const tasksUrl = `${BASE_URL}/api/v1/workspaces/${WORKSPACE_ID}/tasks`;

describe("live 创建闭环", () => {
  it("创建项目：请求体含 command_id 与 project_type，成功后导航到 /projects/<新 id>/tasks", async () => {
    activate();
    const { calls } = stubFetch(async (url, method, body) => {
      if (method === "POST" && url === projectUrl) {
        return jsonResponse(
          201,
          envelope(String(body.command_id), {
            project_id: PROJECT_ID,
            revision: "0",
            phase_key: "PLANNING",
            state_revision: "1"
          })
        );
      }
      // 创建后进入项目任务页：该页会真实读取项目与项目任务，这里返回最小合法投影。
      if (method === "GET" && url === `${projectUrl}/${PROJECT_ID}`) {
        return jsonResponse(200, {
          id: PROJECT_ID,
          title: "真实项目",
          project_type: "GENERAL",
          archived_at: null,
          revision: "0",
          state_revision: "1",
          created_at: "2026-09-21T00:00:00.000Z",
          updated_at: "2026-09-21T00:00:00.000Z"
        });
      }
      if (method === "GET" && url.startsWith(`${tasksUrl}?`)) {
        return jsonResponse(200, { items: [], next_cursor: null });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });

    const mounted = await mountWorkbench("/projects?view=create");
    unmount = mounted.unmount;

    await mounted.wrapper.get('input[name="project-title"]').setValue("真实项目");
    await mounted.wrapper.findAll('input[name="project-type"]')[0].setValue();
    await mounted.wrapper.get('[data-testid="project-create-submit"]').trigger("click");
    await flush(80);

    const posted = calls.find((call) => call.method === "POST");
    expect(posted?.url).toBe(projectUrl);
    expect(typeof posted?.body.command_id).toBe("string");
    expect(posted?.body.project_type).toBe("GENERAL");
    expect(posted?.body.title).toBe("真实项目");
    // 目标不参与 CreateProject：请求体里不应出现 goal。
    expect(posted?.body).not.toHaveProperty("goal");

    expect(mounted.router.currentRoute.value.path).toBe(`/projects/${PROJECT_ID}/tasks`);
  });

  it("创建任务：先 POST /tasks 再 POST /tasks/{id}/ready，两步 command_id 不同且 ready 用创建返回的 revision", async () => {
    activate();
    const { calls } = stubFetch(async (url, method, body) => {
      if (method === "GET" && url.startsWith(`${tasksUrl}?`)) {
        // 依赖候选读取：返回空列表即可。
        return jsonResponse(200, { items: [], next_cursor: null });
      }
      if (method === "POST" && url === tasksUrl) {
        return jsonResponse(
          201,
          envelope(String(body.command_id), {
            task_id: TASK_ID,
            project_id: PROJECT_ID,
            status: "INBOX",
            mode: "ME",
            revision: "0",
            acceptance_revision: "1"
          })
        );
      }
      if (method === "POST" && url === `${tasksUrl}/${TASK_ID}/ready`) {
        return jsonResponse(
          200,
          envelope(String(body.command_id), { task_id: TASK_ID, status: "READY", revision: "1" })
        );
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });

    const mounted = await mountWorkbench(`/tasks?view=create&project=${PROJECT_ID}`);
    unmount = mounted.unmount;

    await mounted.wrapper.get('input[name="task-title"]').setValue("真实任务");
    await mounted.wrapper.get('input[name="task-expected-result"]').setValue("一份真实结果。");
    await mounted.wrapper.get('textarea[name="task-acceptance"]').setValue("可核对");
    await mounted.wrapper.get('[data-testid="task-create-save"]').trigger("click");
    await flush(80);

    const posts = calls.filter((call) => call.method === "POST");
    expect(posts.map((call) => call.url)).toEqual([tasksUrl, `${tasksUrl}/${TASK_ID}/ready`]);

    const createBody = posts[0].body;
    const readyBody = posts[1].body;
    expect(typeof createBody.command_id).toBe("string");
    expect(readyBody.command_id).not.toBe(createBody.command_id);
    // ready 的 expected_revision 必须等于创建返回的 revision（此处为 "0"）。
    expect(readyBody.expected_revision).toBe("0");

    expect(mounted.wrapper.get('[data-testid="task-created-result"]').text()).toContain(TASK_ID);
  });

  it("传输错误：显示查询回执按钮，点击后用同一 command ID 发 GET /commands/<id> 并解析出已提交结果", async () => {
    activate();
    let commandId = "";
    const { calls } = stubFetch(async (url, method, body) => {
      if (method === "POST" && url === tasksUrl) {
        commandId = String(body.command_id);
        throw new TypeError("network down");
      }
      if (method === "GET" && url === `${BASE_URL}/api/v1/workspaces/${WORKSPACE_ID}/commands/${commandId}`) {
        return jsonResponse(200, {
          command_id: commandId,
          command_type: "CreateTask",
          committed_at: "2026-09-21T00:00:00.000Z",
          result: {
            task_id: TASK_ID,
            project_id: null,
            status: "INBOX",
            mode: "ME",
            revision: "0",
            acceptance_revision: "1"
          },
          links: { resource: `/api/v1/workspaces/${WORKSPACE_ID}/tasks/${TASK_ID}` }
        });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });

    const mounted = await mountWorkbench("/tasks?view=create");
    unmount = mounted.unmount;

    await mounted.wrapper.get('input[name="task-title"]').setValue("结果未知的任务");
    await mounted.wrapper.get('input[name="task-expected-result"]').setValue("一份结果。");
    await mounted.wrapper.get('textarea[name="task-acceptance"]').setValue("可核对");
    await mounted.wrapper.get('[data-testid="task-create-save"]').trigger("click");
    await flush(80);

    expect(commandId).not.toBe("");
    expect(mounted.wrapper.find('[data-testid="task-create-receipt"]').exists()).toBe(true);

    await mounted.wrapper.get('[data-testid="task-create-receipt"]').trigger("click");
    await flush(80);

    expect(
      calls.some(
        (call) =>
          call.method === "GET" &&
          call.url === `${BASE_URL}/api/v1/workspaces/${WORKSPACE_ID}/commands/${commandId}`
      )
    ).toBe(true);
    expect(mounted.wrapper.get('[data-testid="task-created-result"]').text()).toContain(TASK_ID);
  });

  it("fixture 模式不发起任何 fetch", async () => {
    resetRelayConnectionForTest();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const project = await mountWorkbench("/projects?view=create");
    await project.wrapper.get('input[name="project-title"]').setValue("示例项目");
    await project.wrapper.get('textarea[name="project-goal"]').setValue("示例目标。");
    await project.wrapper.findAll('input[name="project-type"]')[0].setValue();
    await project.wrapper.get('[data-testid="project-create-submit"]').trigger("click");
    await flush(120);
    project.unmount();

    const task = await mountWorkbench("/tasks?view=create");
    unmount = task.unmount;
    await task.wrapper.get('input[name="task-title"]').setValue("示例任务");
    await task.wrapper.get('input[name="task-expected-result"]').setValue("一份结果。");
    await task.wrapper.get('textarea[name="task-acceptance"]').setValue("可核对");
    await task.wrapper.get('[data-testid="task-create-save"]').trigger("click");
    await flush(120);

    expect(fetchMock.mock.calls.length).toBe(0);
  });
});
