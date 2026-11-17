import { afterEach, describe, expect, it, vi } from "vitest";

import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

/**
 * 2026-11-17 R3：Project 名称批量读取的并发时序。
 *
 * 每个 `/projects?ids=` 请求都由测试显式持有并手动 resolve，完成顺序完全由用例控制，
 * 不用固定 sleep 猜测网络快慢。首屏与续页、刷新与首读、Workspace 切换都必须在
 * 同一个作用域 epoch 内留下可核对的最终名称，不能因后发请求先到而永久显示 UUID。
 */
const baseUrl = "http://127.0.0.1:8787";
const workspaceA = "11111111-1111-4111-8111-111111111111";
const workspaceB = "99999999-9999-4999-8999-999999999999";
const created = "2026-11-17T00:00:00.000Z";
const projectA = "22222222-2222-4222-8222-222222222222";
const projectB = "33333333-3333-4333-8333-333333333333";
const projectC = "44444444-4444-4444-8444-444444444444";
const taskA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const taskB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const taskC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.(); unmount = null;
  resetRelayConnectionForTest();
  vi.unstubAllGlobals();
});

type Resolved<T> = { readonly promise: Promise<T>; resolve: (value: T) => void };
type ProjectRequest = { readonly root: string; readonly ids: readonly string[]; readonly deferred: Resolved<Response> };
type WorkspaceFixture = {
  readonly first: readonly unknown[];
  readonly second?: readonly unknown[];
  readonly projects: readonly unknown[];
};

function deferred<T>(): Resolved<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function project(id: string, title: string, archived = false) {
  return { id, title, project_type: "GENERAL", archived_at: archived ? created : null,
    archive_status: archived ? "ARCHIVED" : "ACTIVE", revision: "2", state_revision: "3",
    phase_key: "PLANNING", next_action_task_id: null, created_at: created, updated_at: created };
}
function task(id: string, title: string, projectId: string | null) {
  return { id, title, project_id: projectId, status: "READY", mode: "ME", revision: "2",
    executor: { kind: "HUMAN", run_id: null }, current_completion_id: null, waiting_reason: null,
    blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [] };
}
function workspaceRoot(workspaceId: string): string {
  return `${baseUrl}/api/v1/workspaces/${workspaceId}`;
}
function connect(workspaceId: string): void {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
}

/**
 * 受控 API：任务列表没有 cursor 的读取返回首屏，`cursor=page2` 返回第二页。
 * 所有按 ID 批量读都保留为 deferred，用例可以精确决定「哪一批先返回」。
 */
function installFetch(fixtures: Record<string, WorkspaceFixture>) {
  const projectRequests: ProjectRequest[] = [];
  const taskRequests: { root: string; cursor: string | null }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/attention/interventions")) return response(200, { items: [] });
    if (parsed.pathname.endsWith("/assist-sessions")) return response(200, { items: [] });

    const match = parsed.pathname.match(/^\/api\/v1\/workspaces\/([^/]+)\/(.*)$/);
    if (match === null) throw new Error(`unexpected ${url}`);
    const [, workspaceId, resource] = match;
    const fixture = fixtures[workspaceId!];
    if (fixture === undefined) throw new Error(`unexpected workspace ${workspaceId}: ${url}`);
    const root = workspaceRoot(workspaceId!);

    if (resource === "projects") {
      const ids = parsed.searchParams.get("ids");
      if (ids !== null) {
        const deferredRequest = deferred<Response>();
        projectRequests.push({ root, ids: ids.split(","), deferred: deferredRequest });
        return deferredRequest.promise;
      }
      if (parsed.searchParams.get("status") === "active") {
        return response(200, { items: [], next_cursor: null });
      }
      throw new Error(`unexpected project page ${url}`);
    }
    if (resource === "tasks") {
      const cursor = parsed.searchParams.get("cursor");
      taskRequests.push({ root, cursor });
      if (cursor === "page2") {
        return response(200, { items: fixture.second ?? [], next_cursor: null });
      }
      return response(200, { items: fixture.first, next_cursor: fixture.second === undefined ? null : "page2" });
    }
    throw new Error(`unexpected ${url}`);
  }));
  return { projectRequests, taskRequests };
}

const fixtureA: WorkspaceFixture = {
  first: [task(taskA, "任务甲", projectA), task(taskB, "任务乙", projectB)],
  second: [task(taskC, "任务丙", projectC)],
  projects: [project(projectA, "甲项目"), project(projectB, "乙项目"), project(projectC, "丙项目")]
};

async function mountTasks(): Promise<ReturnType<typeof mountWorkbench>> {
  const mounted = await mountWorkbench("/tasks");
  unmount = mounted.unmount;
  return mounted;
}

function rowText(mounted: ReturnType<typeof mountWorkbench>, taskId: string): string {
  return mounted.wrapper.get(`[data-testid="task-row-${taskId}"]`).text();
}

describe("Project 名称批量读取并发", () => {
  it("场景 A：首屏 P1/P2 名称请求落后于续页 P3，最终三者都正确且不残留 UUID", async () => {
    connect(workspaceA);
    const harness = installFetch({ [workspaceA]: fixtureA });
    const mounted = await mountTasks();

    expect(harness.projectRequests).toHaveLength(1);
    expect(harness.projectRequests[0]!.ids).toEqual([projectA, projectB]);
    expect(rowText(mounted, taskA)).toContain("项目名称读取中");
    expect(rowText(mounted, taskB)).toContain("项目名称读取中");

    await mounted.wrapper.get('[data-testid="tasks-live-load-more"]').trigger("click");
    await flush(20);
    expect(harness.projectRequests).toHaveLength(2);
    expect(harness.projectRequests[1]!.ids).toEqual([projectC]);

    // 续页的 P3 先返回；此时 P1/P2 仍在读取，不能提前退回 UUID，也不能影响 P3。
    harness.projectRequests[1]!.deferred.resolve(response(200, {
      items: [project(projectC, "丙项目")], next_cursor: null
    }));
    await flush(20);
    expect(rowText(mounted, taskC)).toContain("丙项目");
    expect(rowText(mounted, taskA)).toContain("项目名称读取中");
    expect(rowText(mounted, taskA)).not.toContain(projectA);

    harness.projectRequests[0]!.deferred.resolve(response(200, {
      items: [project(projectA, "甲项目"), project(projectB, "乙项目")], next_cursor: null
    }));
    await flush(20);
    expect(rowText(mounted, taskA)).toContain("甲项目");
    expect(rowText(mounted, taskB)).toContain("乙项目");
    expect(rowText(mounted, taskC)).toContain("丙项目");
    expect(mounted.wrapper.text()).not.toContain(projectA);
    expect(mounted.wrapper.text()).not.toContain(projectB);
    expect(mounted.wrapper.text()).not.toContain(projectC);
    expect(mounted.wrapper.text()).not.toContain("项目名称读取中");
  });

  it("场景 B：返回顺序反转，P1/P2 先返回、P3 后返回，最终结果不变", async () => {
    connect(workspaceA);
    const harness = installFetch({ [workspaceA]: fixtureA });
    const mounted = await mountTasks();

    await mounted.wrapper.get('[data-testid="tasks-live-load-more"]').trigger("click");
    await flush(20);
    expect(harness.projectRequests).toHaveLength(2);

    harness.projectRequests[0]!.deferred.resolve(response(200, {
      items: [project(projectA, "甲项目"), project(projectB, "乙项目")], next_cursor: null
    }));
    await flush(20);
    expect(rowText(mounted, taskA)).toContain("甲项目");
    expect(rowText(mounted, taskB)).toContain("乙项目");
    expect(rowText(mounted, taskC)).toContain("项目名称读取中");

    harness.projectRequests[1]!.deferred.resolve(response(200, {
      items: [project(projectC, "丙项目")], next_cursor: null
    }));
    await flush(20);
    expect(rowText(mounted, taskA)).toContain("甲项目");
    expect(rowText(mounted, taskB)).toContain("乙项目");
    expect(rowText(mounted, taskC)).toContain("丙项目");
    expect(mounted.wrapper.text()).not.toContain("项目名称读取中");
  });

  it("场景 C：跨页重复 Project 只补一次，不重复读取也不闪烁", async () => {
    connect(workspaceA);
    const harness = installFetch({
      [workspaceA]: {
        first: [task(taskA, "任务甲", projectA), task(taskB, "任务乙", projectB)],
        second: [task(taskC, "任务丙", projectC), { ...task("task-a2", "重复项目任务", projectA) }],
        projects: [project(projectA, "甲项目"), project(projectB, "乙项目"), project(projectC, "丙项目")]
      }
    });
    const mounted = await mountTasks();

    await mounted.wrapper.get('[data-testid="tasks-live-load-more"]').trigger("click");
    await flush(20);
    expect(harness.projectRequests).toHaveLength(2);
    expect(harness.projectRequests[1]!.ids).toEqual([projectC]);

    harness.projectRequests[1]!.deferred.resolve(response(200, {
      items: [project(projectC, "丙项目")], next_cursor: null
    }));
    await flush(20);
    expect(rowText(mounted, "task-a2")).toContain("项目名称读取中");

    harness.projectRequests[0]!.deferred.resolve(response(200, {
      items: [project(projectA, "甲项目"), project(projectB, "乙项目")], next_cursor: null
    }));
    await flush(20);
    expect(rowText(mounted, taskA)).toContain("甲项目");
    expect(rowText(mounted, "task-a2")).toContain("甲项目");
    expect(rowText(mounted, taskB)).toContain("乙项目");
    expect(rowText(mounted, taskC)).toContain("丙项目");
  });

  it("场景 D：首屏项目读取失败，续页 P3 成功；刷新重试后恢复 P1/P2 名称且列表不丢", async () => {
    connect(workspaceA);
    const harness = installFetch({ [workspaceA]: fixtureA });
    const mounted = await mountTasks();
    expect(mounted.wrapper.get('[data-testid="tasks-live-count"]').text()).toContain("已加载 2 项");

    harness.projectRequests[0]!.deferred.resolve(response(403, { code: "FORBIDDEN", detail: "项目不可读" }));
    await flush(20);
    expect(rowText(mounted, taskA)).toContain(`项目 ${projectA}`);
    expect(rowText(mounted, taskB)).toContain(`项目 ${projectB}`);
    expect(rowText(mounted, taskA)).not.toContain("甲项目");
    expect(mounted.wrapper.text()).toContain("已加载 2 项");

    await mounted.wrapper.get('[data-testid="tasks-live-load-more"]').trigger("click");
    await flush(20);
    expect(harness.projectRequests).toHaveLength(2);
    expect(harness.projectRequests[1]!.ids).toEqual([projectC]);
    harness.projectRequests[1]!.deferred.resolve(response(200, {
      items: [project(projectC, "丙项目")], next_cursor: null
    }));
    await flush(20);
    expect(rowText(mounted, taskC)).toContain("丙项目");
    expect(rowText(mounted, taskA)).toContain(`项目 ${projectA}`);
    expect(rowText(mounted, taskB)).toContain(`项目 ${projectB}`);

    // 手动刷新回到首屏两条任务，重新读取 P1/P2；失败状态必须能被下一次成功覆盖。
    await mounted.wrapper.get('[data-testid="tasks-live-refresh"]').trigger("click");
    await flush(20);
    expect(harness.projectRequests).toHaveLength(3);
    expect(harness.projectRequests[2]!.ids).toEqual([projectA, projectB]);
    harness.projectRequests[2]!.deferred.resolve(response(200, {
      items: [project(projectA, "甲项目"), project(projectB, "乙项目")], next_cursor: null
    }));
    await flush(20);
    expect(rowText(mounted, taskA)).toContain("甲项目");
    expect(rowText(mounted, taskB)).toContain("乙项目");
    expect(mounted.wrapper.find(`[data-testid="task-row-${taskC}"]`).exists()).toBe(false);
  });

  it("场景 E：首屏名称请求未完成时手动刷新，新结果先返回、旧结果不能覆盖", async () => {
    connect(workspaceA);
    const harness = installFetch({ [workspaceA]: fixtureA });
    const mounted = await mountTasks();
    expect(harness.projectRequests).toHaveLength(1);

    await mounted.wrapper.get('[data-testid="tasks-live-refresh"]').trigger("click");
    await flush(20);
    expect(harness.projectRequests).toHaveLength(2);
    expect(harness.projectRequests[1]!.ids).toEqual([projectA, projectB]);

    harness.projectRequests[1]!.deferred.resolve(response(200, {
      items: [project(projectA, "刷新后甲项目"), project(projectB, "刷新后乙项目")], next_cursor: null
    }));
    await flush(20);
    expect(rowText(mounted, taskA)).toContain("刷新后甲项目");
    expect(rowText(mounted, taskB)).toContain("刷新后乙项目");

    // 旧的首屏请求迟到，不能把刚刷新的名称改回旧值。
    harness.projectRequests[0]!.deferred.resolve(response(200, {
      items: [project(projectA, "旧甲项目"), project(projectB, "旧乙项目")], next_cursor: null
    }));
    await flush(20);
    expect(rowText(mounted, taskA)).toContain("刷新后甲项目");
    expect(rowText(mounted, taskB)).toContain("刷新后乙项目");
    expect(rowText(mounted, taskA)).not.toContain("旧甲项目");
    expect(mounted.wrapper.text()).not.toContain("项目名称读取中");
  });

  it("场景 F：切换 Workspace 后旧 Project 请求迟到，只保留新 Workspace 的事实", async () => {
    connect(workspaceA);
    const remaining: WorkspaceFixture = {
      first: [task("task-b1", "B 空间任务", "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb")],
      projects: [project("bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb", "B 空间项目")]
    };
    const harness = installFetch({
      [workspaceA]: fixtureA,
      [workspaceB]: remaining
    });
    const mounted = await mountTasks();
    expect(harness.projectRequests).toHaveLength(1);

    connect(workspaceB);
    await flush(20);
    expect(mounted.wrapper.find(`[data-testid="task-row-${taskA}"]`).exists()).toBe(false);
    expect(harness.projectRequests).toHaveLength(2);
    const requestB = harness.projectRequests[1]!;
    expect(requestB.root).toBe(workspaceRoot(workspaceB));
    expect(requestB.ids).toEqual(["bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb"]);
    requestB.deferred.resolve(response(200, { items: remaining.projects, next_cursor: null }));
    await flush(20);
    expect(rowText(mounted, "task-b1")).toContain("B 空间项目");

    // A 空间的旧请求最后才返回：作用域 epoch 必须使它失效。
    harness.projectRequests[0]!.deferred.resolve(response(200, {
      items: [project(projectA, "甲项目"), project(projectB, "乙项目")], next_cursor: null
    }));
    await flush(20);
    expect(rowText(mounted, "task-b1")).toContain("B 空间项目");
    expect(mounted.wrapper.text()).not.toContain("甲项目");
    expect(mounted.wrapper.text()).not.toContain("乙项目");
    expect(mounted.wrapper.find(`[data-testid="task-row-${taskA}"]`).exists()).toBe(false);
  });
});
