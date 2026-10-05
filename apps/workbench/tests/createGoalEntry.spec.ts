import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

/**
 * 工作台 §18.7、总纲 §0.8 与 LC-01/LC-02 的前端反例：轻量 Goal 创建入口。
 *
 * 断言的是客户端行为与命令身份，不替代真实 API/PG 与真实 Windows 取证：
 * - 用户先表达结果，标题只是可修订摘要，不要求整套表单；
 * - 保存走既有 CreateGoal 用例（Goal 的唯一 Owner），不隐式关联任何 Project；
 * - 响应丢失按原 command_id 核对，不换 ID 重建第二个 Goal。
 */

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const goalId = "44444444-4444-4444-8444-444444444444";
/** 只含路径：URL 的 pathname 不带 host，比对时不能拼 baseUrl。 */
const root = `/api/v1/workspaces/${workspaceId}`;
const intent = "把毕业论文的实验部分跑通并整理成可提交的初稿";

function connect() {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
}
function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

interface Routes {
  /** 首次 POST /goals 是否丢响应（服务端已提交，传输结果未知）。 */
  loseCreateResponse?: boolean;
  /** GET /commands/:id 的回执内容。 */
  receipt?: (commandId: string) => Response;
}

function router(routes: Routes, posts: { path: string; body: Record<string, unknown> }[]) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    // pathname 不含查询串：项目列表的 status 参数要连 url.search 一起比对。
    const path = url.pathname;
    if (init?.method === "POST" && path === `${root}/goals`) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push({ path, body });
      if (routes.loseCreateResponse === true) throw new TypeError("response lost after commit");
      return response(201, { command_id: body.command_id, committed_at: "2026-10-04T00:00:00Z",
        result: { goal_id: goalId, status: "ACTIVE", revision: "1" } });
    }
    const receipt = /\/commands\/([^/]+)$/u.exec(path);
    if (receipt) return routes.receipt?.(receipt[1]!) ??
      response(404, { code: "COMMAND_NOT_FOUND", detail: "命令回执不存在" });
    // 进入轻量入口前的项目列表读取。
    if (init?.method !== "POST" && path === `${root}/projects`) {
      return response(200, { items: [], next_cursor: null });
    }
    // 应用外壳的后台读取（提醒、待处理任务）不是本用例的断言对象，
    // 但必须给出合法空结果，否则它们的失败会掩盖 Goal 命令本身。
    if (path.endsWith("/attention/interventions")) return response(200, { items: [] });
    if (path === `${root}/tasks`) return response(200, { items: [], next_cursor: null });
    throw new Error(`Unexpected request ${path}${url.search}`);
  });
}

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.(); unmount = null;
  resetRelayConnectionForTest(); vi.unstubAllGlobals();
});

describe("轻量 Goal 创建入口", () => {
  it("从项目页进入，先表达结果即可保存；标题是可修订摘要而非整套表单", async () => {
    connect();
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", router({}, posts));
    const view = await mountWorkbench("/projects"); unmount = view.unmount;

    // 主入口可达，且不要求先建项目。
    expect(view.wrapper.get('[data-testid="goal-create-open"]').exists()).toBe(true);
    await view.router.push("/projects?view=goal");
    expect(view.router.currentRoute.value.path).toBe("/projects");
    expect(view.router.currentRoute.value.query).toEqual({ view: "goal" });
    expect(view.wrapper.get('[data-testid="goal-create-view"]').exists()).toBe(true);

    // 空输入时不得发出任何业务命令。
    expect(view.wrapper.get('[data-testid="goal-submit"]').attributes("disabled")).toBeDefined();
    await view.wrapper.get('[data-testid="goal-intent"]').setValue(intent);
    await flush();
    expect(view.wrapper.get('[data-testid="goal-title"]').attributes("value")).toBe(intent);
    expect(view.wrapper.get('[data-testid="goal-submit"]').attributes("disabled")).toBeUndefined();

    await view.wrapper.get('[data-testid="goal-form"]').trigger("submit");
    await flush(); await flush();

    expect(posts).toHaveLength(1);
    expect(posts[0]?.path).toBe(`${root}/goals`);
    expect(posts[0]?.body.title).toBe(intent);
    expect(posts[0]?.body.description).toBe(intent);
    expect(posts[0]?.body.command_id).toMatch(/^[0-9a-f-]{36}$/u);
    // 轻量入口不代填项目，也不代建任务：载荷里没有这些字段。
    expect(Object.keys(posts[0]!.body).sort()).toEqual(["command_id", "description", "title"]);
    expect(view.wrapper.get('[data-testid="goal-created"]').text()).toContain(goalId);
  });

  it("标题可改写，改写后不被输入覆盖；说明保存用户原话", async () => {
    connect();
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", router({}, posts));
    const view = await mountWorkbench("/projects?view=goal"); unmount = view.unmount;

    await view.wrapper.get('[data-testid="goal-intent"]').setValue(`${intent}\n先跑通实验，再整理初稿`);
    await flush();
    // 首行作标题，多行补充不被丢掉。
    expect(view.wrapper.get('[data-testid="goal-title"]').attributes("value")).toBe(intent);

    await view.wrapper.get('[data-testid="goal-title"]').setValue("论文实验与初稿");
    await flush();
    await view.wrapper.get('[data-testid="goal-intent"]').setValue("改写输入");
    await flush();
    expect(view.wrapper.get('[data-testid="goal-title"]').attributes("value")).toBe("论文实验与初稿");

    await view.wrapper.get('[data-testid="goal-form"]').trigger("submit");
    await flush(); await flush();
    expect(posts[0]?.body.title).toBe("论文实验与初稿");
    expect(posts[0]?.body.description).toBe("改写输入");
  });

  it("创建响应丢失后按原 command_id 核对，不换 ID 重建第二个 Goal", async () => {
    connect();
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    // 回执夹具按被核对的 command_id 返回，但必须先确认它就是本次创建实际发出的那条命令：
// 否则「拿另一个 ID 去核对」也会让 goal-created 出现，这条身份约束形同虚设。
    const checkedIds: string[] = [];
    vi.stubGlobal("fetch", router({
      loseCreateResponse: true,
      receipt: (commandId) => {
        checkedIds.push(commandId);
        if (posts[0]?.body.command_id !== commandId) {
          throw new Error(`回执被用错误的 command_id 核对：${commandId}`);
        }
        return response(200, { command_id: commandId, command_type: "CreateGoal",
          committed_at: "2026-10-04T00:00:05Z", result: { goal_id: goalId, status: "ACTIVE", revision: "1" } });
      },
    }, posts));
    const view = await mountWorkbench("/projects?view=goal"); unmount = view.unmount;

    await view.wrapper.get('[data-testid="goal-intent"]').setValue(intent);
    await flush();
    await view.wrapper.get('[data-testid="goal-form"]').trigger("submit");
    await flush(); await flush();

    const commandId = posts[0]?.body.command_id as string;
    expect(commandId).toMatch(/^[0-9a-f-]{36}$/u);
    // 传输失败不推断成业务失败：入口立即按原 command_id 核对，不换 ID 重建。
    // 核对成功后只承认这一条 Goal，绝不再发第二条创建命令。
    expect(posts.filter((post) => post.path === `${root}/goals`)).toHaveLength(1);
    // 自动核对确实发生了，且核对的正是本次发出的 command_id。
    expect(checkedIds).toEqual([commandId]);
    expect(view.wrapper.get('[data-testid="goal-created"]').text()).toContain(goalId);
    expect(view.wrapper.find('[data-testid="goal-pending"]').exists()).toBe(false);
  });

  it("服务端明确未找到原命令时，只允许用原 ID 与原载荷重试", async () => {
    connect();
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", router({ loseCreateResponse: true }, posts));
    const view = await mountWorkbench("/projects?view=goal"); unmount = view.unmount;

    await view.wrapper.get('[data-testid="goal-intent"]').setValue(intent);
    await flush();
    await view.wrapper.get('[data-testid="goal-form"]').trigger("submit");
    await flush(); await flush();
    const commandId = posts[0]?.body.command_id as string;

    // 先回执核对（返回 404），才开放原样重试。
    await view.wrapper.get('[data-testid="goal-receipt"]').trigger("click");
    await flush(); await flush();
    expect(view.wrapper.get('[data-testid="goal-error"]').text()).toContain("只能用原 command ID 与原载荷重试");
    expect(view.wrapper.get('[data-testid="goal-retry"]').exists()).toBe(true);

    await view.wrapper.get('[data-testid="goal-retry"]').trigger("click");
    await flush(); await flush();

    const attempts = posts.filter((post) => post.path === `${root}/goals`);
    expect(attempts).toHaveLength(2);
    // 同 ID、同载荷：重试不是新建。
    expect(attempts[1]?.body.command_id).toBe(commandId);
    expect(attempts[1]?.body.title).toBe(attempts[0]?.body.title);
    expect(attempts[1]?.body.description).toBe(attempts[0]?.body.description);
  });

  it("双击提交只发出一条创建命令", async () => {
    connect();
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", router({}, posts));
    const view = await mountWorkbench("/projects?view=goal"); unmount = view.unmount;

    await view.wrapper.get('[data-testid="goal-intent"]').setValue(intent);
    await flush();
    const form = view.wrapper.get('[data-testid="goal-form"]');
    await form.trigger("submit");
    await form.trigger("submit");
    await flush(); await flush();

    expect(posts.filter((post) => post.path === `${root}/goals`)).toHaveLength(1);
  });

  it("示例模式如实说明不能保存目标，不生成假 Goal", async () => {
    resetRelayConnectionForTest();
    const view = await mountWorkbench("/projects?view=goal"); unmount = view.unmount;
    expect(view.wrapper.get('[data-testid="goal-fixture-gap"]').exists()).toBe(true);
    expect(view.wrapper.find('[data-testid="goal-form"]').exists()).toBe(false);
    expect(view.wrapper.find('[data-testid="goal-submit"]').exists()).toBe(false);
  });
});
