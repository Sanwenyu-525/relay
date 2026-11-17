import { afterEach, describe, expect, it, vi } from "vitest";

import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { mountWorkbench } from "./mountApp";

/**
 * 2026-11-15 任务页专项：状态列必须给可读原因，BLOCKED 分说前置任务与未解除阻塞，
 * 表头/行语义各自成立，项目名一次批量读取。全部走真实 API 投影形状，不写假接口。
 */
const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
const projectA = "22222222-2222-4222-8222-222222222222";
const projectB = "33333333-3333-4333-8333-333333333333";
const created = "2026-11-15T00:00:00.000Z";
let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.(); unmount = null;
  resetRelayConnectionForTest();
  vi.unstubAllGlobals();
});

function connect(): void {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
}
function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function project(id: string, title: string, archived = false) {
  return { id, title, project_type: "GENERAL", archived_at: archived ? created : null,
    archive_status: archived ? "ARCHIVED" : "ACTIVE", revision: "2", state_revision: "3",
    phase_key: "PLANNING", next_action_task_id: null, created_at: created, updated_at: created };
}
function task(id: string, title: string, projectId: string | null, status: string, extra: {
  readonly waitingReason?: string | null;
  readonly blockingTaskIds?: readonly string[];
  readonly unresolvedBlockerIds?: readonly string[];
} = {}) {
  return { id, title, project_id: projectId, status, mode: "ME", revision: "2",
    executor: { kind: "HUMAN", run_id: null }, current_completion_id: null,
    waiting_reason: extra.waitingReason ?? null,
    blocking_task_ids: extra.blockingTaskIds ?? [],
    unresolved_blocker_ids: extra.unresolvedBlockerIds ?? [],
    allowed_actions: [] };
}

/** 工作空间任务页桩：记录每次请求 URL，便于核对「项目名是否只批量读一次」。 */
function stubLive(rows: readonly unknown[], projects: readonly unknown[] = [project(projectA, "甲项目")]) {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/attention/interventions")) return response(200, { items: [] });
    urls.push(url);
    if (url === `${root}/projects?status=active`) return response(200, { items: [], next_cursor: null });
    if (url.startsWith(`${root}/projects?ids=`)) {
      const ids = new Set(new URL(url).searchParams.get("ids")?.split(",") ?? []);
      return response(200, { items: projects.filter((item) => ids.has((item as { id: string }).id)), next_cursor: null });
    }    if (url === `${root}/assist-sessions?include_context=true`) return response(200, { items: [] });
    if (url === `${root}/tasks?scope=all`) return response(200, { items: rows, next_cursor: null });
    throw new Error(`unexpected ${url}`);
  }));
  return urls;
}

describe("任务状态列的可读原因", () => {
  it("WAITING 按服务端 wait_reason 说清在等什么，不再笼统写「待人工验收」", async () => {
    connect();
    stubLive([
      task("t-approval", "等待批准写文件", projectA, "WAITING", { waitingReason: "ACTION_APPROVAL_REQUIRED" }),
      task("t-human-tool", "等待工具适配", projectA, "WAITING", { waitingReason: "HUMAN_TOOL" }),
      task("t-budget", "等待预算决定", projectA, "WAITING", { waitingReason: "REPEATED_FAILURE" }),
      task("t-paused", "被你暂停的任务", null, "WAITING", { waitingReason: "PAUSED_BY_USER" })
    ]);
    const mounted = await mountWorkbench("/tasks"); unmount = mounted.unmount;

    expect(mounted.wrapper.text()).toContain("等待中");
    expect(mounted.wrapper.text()).not.toContain("待人工验收");
    expect(mounted.wrapper.get('[data-testid="task-row-t-approval"]').text()).toContain("等待你批准动作");
    expect(mounted.wrapper.get('[data-testid="task-row-t-human-tool"]').text()).toContain("工具需人工处理");
    expect(mounted.wrapper.get('[data-testid="task-row-t-budget"]').text()).toContain("工具循环预算用尽");
    expect(mounted.wrapper.get('[data-testid="task-row-t-paused"]').text()).toContain("你已暂停执行");
    // 完整句子进入 title：列表内截断时悬停仍可读。
    const reason = mounted.wrapper.get('[data-testid="task-row-t-budget"] .data-cell-reason');
    expect(reason.attributes("title")).toContain("工具调用预算或轮次已用尽");
  });

  it("BLOCKED 分说前置任务与未解除阻塞，不只写「任务依赖未完成」", async () => {
    connect();
    stubLive([
      task("t-both", "两样都卡住", projectA, "BLOCKED", { blockingTaskIds: ["a", "b"], unresolvedBlockerIds: ["c"] }),
      task("t-blockers", "只有阻塞记录", projectA, "BLOCKED", { unresolvedBlockerIds: ["c", "d"] }),
      task("t-none", "没有登记依据", projectA, "BLOCKED")
    ]);
    const mounted = await mountWorkbench("/tasks"); unmount = mounted.unmount;

    expect(mounted.wrapper.get('[data-testid="task-row-t-both"]').text())
      .toContain("2 个前置任务未完成 · 1 个阻塞未解除");
    expect(mounted.wrapper.get('[data-testid="task-row-t-blockers"]').text()).toContain("2 个阻塞未解除");
    expect(mounted.wrapper.get('[data-testid="task-row-t-none"]').text()).toContain("服务端未登记阻塞依据");
    expect(mounted.wrapper.text()).not.toContain("任务依赖未完成");
  });

  it("未知原因与缺失原因都如实说明，不静默留白", async () => {
    connect();
    stubLive([
      task("t-unknown", "新原因代码", projectA, "WAITING", { waitingReason: "SOME_NEW_REASON" }),
      task("t-empty", "没有原因", projectA, "WAITING")
    ]);
    const mounted = await mountWorkbench("/tasks"); unmount = mounted.unmount;

    expect(mounted.wrapper.get('[data-testid="task-row-t-unknown"]').text()).toContain("等待原因未识别（SOME_NEW_REASON）");
    expect(mounted.wrapper.get('[data-testid="task-row-t-empty"]').text()).toContain("等待原因尚未登记");
  });

  it("只有 WAITING / BLOCKED 带原因，其它状态不占这一格", async () => {
    connect();
    stubLive([task("t-ready", "可以开始", projectA, "READY")]);
    const mounted = await mountWorkbench("/tasks"); unmount = mounted.unmount;

    const row = mounted.wrapper.get('[data-testid="task-row-t-ready"]');
    expect(row.find(".data-cell-reason").exists()).toBe(false);
    expect(row.text()).not.toContain("等待原因");
  });
});

describe("任务表语义与项目名读取", () => {
  it("原生表格：五列 th scope=col，标题是真实链接，行内事实齐全", async () => {
    connect();
    stubLive([task("t-a11y", "核对表头语义", projectA, "WAITING", { waitingReason: "CHECKER_UNAVAILABLE" })]);
    const mounted = await mountWorkbench("/tasks"); unmount = mounted.unmount;

    // 原生 table：表头是 th scope="col"（不是 div/span 假表头），数据行是 tr/td。
    const table = mounted.wrapper.get("table.data-table.task-table");
    expect(table.find("thead").exists()).toBe(true);
    const headers = table.findAll("thead th");
    expect(headers.map((header) => header.text())).toEqual(["任务", "项目", "工作状态", "执行模式", "当前执行者"]);
    expect(headers.every((header) => header.attributes("scope") === "col")).toBe(true);
    const row = mounted.wrapper.get('[data-testid="task-row-t-a11y"]');
    expect(row.element?.tagName).toBe("TR");
    expect(row.findAll("td")).toHaveLength(5);
    // 标题是单元格里的真实 Link；其余四列是文本格，不在 tr 内嵌套第二个交互元素。
    const link = row.get('[data-testid="task-row-link-t-a11y"]');
    expect(link.element?.tagName).toBe("A");
    expect(link.attributes("href")).toBe("/tasks/t-a11y");
    expect(link.attributes("aria-label")).toBe("打开任务：核对表头语义");
    expect(row.findAll("a")).toHaveLength(1);
    // 五列事实仍可在同一行读到；原因短句与完整 title 都在。
    expect(row.text()).toContain("甲项目");
    expect(row.text()).toContain("等待中");
    expect(row.text()).toContain("检查器不可用");
    expect(row.text()).toContain("人工执行");
    expect(row.text()).toContain("我");
  });

  it("项目名按当前页 Project ID 集合批量读取，不为每条任务单读 Project；归档项目带归档标记", async () => {
    connect();
    const urls = stubLive([
      task("t-1", "任务一", projectA, "READY"),
      task("t-2", "任务二", projectB, "READY"),
      task("t-3", "任务三", projectA, "WAITING", { waitingReason: "PAUSED_BY_USER" })
    ], [project(projectA, "甲项目"), project(projectB, "乙项目", true)]);
    const mounted = await mountWorkbench("/tasks"); unmount = mounted.unmount;

    const batch = urls.filter((url) => url.startsWith(`${root}/projects?ids=`));
    expect(batch).toHaveLength(1);
    expect(new URL(batch[0]!).searchParams.get("ids")?.split(",").sort())
      .toEqual([projectA, projectB].sort());
    // 不再依赖「项目列表第一页 100 条」，也没有逐 Project 单读。
    expect(urls.some((url) => url.includes("status=all"))).toBe(false);
    expect(urls.some((url) => url.startsWith(`${root}/projects/${projectA}`) || url.startsWith(`${root}/projects/${projectB}`))).toBe(false);
    expect(mounted.wrapper.get('[data-testid="task-row-t-1"]').text()).toContain("甲项目");
    expect(mounted.wrapper.get('[data-testid="task-row-t-2"]').text()).toContain("乙项目（已归档）");
    expect(mounted.wrapper.text()).not.toContain(projectA);
  });

  it("工作空间超过 100 个项目时，早期项目仍按 ID 取回名称而不是退回 UUID", async () => {
    connect();
    const earlier = "44444444-4444-4444-8444-444444444444";
    const projects = Array.from({ length: 100 }, (_, index) =>
      project(`55555555-5555-4555-8555-${String(index).padStart(12, "0")}`, `新项目 ${index + 1}`));
    const urls = stubLive([
      task("t-old", "早期项目里的任务", earlier, "READY"),
      task("t-new", "新项目里的任务", projects[0]!.id, "READY")
    ], [project(earlier, "早期立项项目"), ...projects]);
    const mounted = await mountWorkbench("/tasks"); unmount = mounted.unmount;

    // 101 个项目不会挤进列表首页：只按本页引用的两个 ID 批量取。
    const batch = urls.filter((url) => url.startsWith(`${root}/projects?ids=`));
    expect(batch).toHaveLength(1);
    expect(new URL(batch[0]!).searchParams.get("ids")?.split(",").sort())
      .toEqual([earlier, projects[0]!.id].sort());
    expect(mounted.wrapper.get('[data-testid="task-row-t-old"]').text()).toContain("早期立项项目");
    expect(mounted.wrapper.text()).not.toContain(earlier);
  });

  it("项目名读取失败时回退到项目 ID，但整页列表仍然可用", async () => {
    connect();
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/attention/interventions")) return response(200, { items: [] });
      urls.push(url);
      if (url === `${root}/projects?status=active`) return response(200, { items: [], next_cursor: null });
      if (url.startsWith(`${root}/projects?ids=`)) return response(403, { code: "FORBIDDEN", detail: "项目不可读" });
      if (url === `${root}/assist-sessions?include_context=true`) return response(200, { items: [] });
      if (url === `${root}/tasks?scope=all`) return response(200, { items: [task("t-x", "任务甲", projectA, "READY")], next_cursor: null });
      throw new Error(`unexpected ${url}`);
    }));
    const mounted = await mountWorkbench("/tasks"); unmount = mounted.unmount;

    expect(mounted.wrapper.get('[data-testid="task-row-t-x"]').text()).toContain(projectA);
    // 项目名读不到只影响这一列：计数照常渲染，页面没有变成读取失败态。
    expect(mounted.wrapper.get('[data-testid="tasks-live-count"]').text()).toContain("已加载 1 项");
    expect(mounted.wrapper.text()).not.toContain("重新读取");
  });
});
