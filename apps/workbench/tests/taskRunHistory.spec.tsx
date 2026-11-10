import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import TaskRunHistory from "../src/components/TaskRunHistory";
import { RelayApiClient } from "../src/api/relayClient";
import { flush, mountReact } from "./mountApp";

const taskId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const oldId = "44444444-4444-4444-8444-444444444444";
const otherTaskId = "55555555-5555-4555-8555-555555555555";
const client = new RelayApiClient({ baseUrl: "http://127.0.0.1:8787", workspaceId: "11111111-1111-4111-8111-111111111111", bearerToken: "fixture-token" });
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
const row = (id: string, target = taskId) => ({ id, task_id: target, status: "CANCELLED", revision: "2", retry_of_run_id: null,
  created_at: "2026-11-06T00:00:00Z", terminal_at: "2026-11-06T00:01:00Z" });
const view = (id = taskId, currentRunId: string | null = runId) => createElement(MemoryRouter, null,
  createElement(TaskRunHistory, { key: id, client, taskId: id, currentRunId }));
let unmount: (() => void) | undefined;
afterEach(() => { unmount?.(); unmount = undefined; vi.unstubAllGlobals(); });

it("首批有界读取，显式加载更早记录，历史不变成当前执行权", async () => {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.method ?? "GET").toBe("GET");
    const url = new URL(String(input)); calls.push(url.search);
    expect(url.pathname).toContain(`/tasks/${taskId}/runs`);
    return response(url.searchParams.has("cursor") ? { items: [row(oldId)], next_cursor: null }
      : { items: [row(runId)], next_cursor: runId });
  }));
  const mounted = await mountReact(view()); unmount = mounted.unmount;
  expect(calls).toEqual(["?limit=20"]);
  expect(mounted.wrapper.text()).toContain("当前 Task 绑定");
  expect(mounted.wrapper.text()).toContain("还有更早记录");
  await mounted.wrapper.findAll("button").find((b) => b.text() === "加载更早的执行记录")!.trigger("click"); await flush();
  expect(calls).toEqual(["?limit=20", `?limit=20&cursor=${runId}`]);
  expect(mounted.wrapper.findAll('a[href^="/runs/"]')).toHaveLength(2);
  expect(mounted.wrapper.text()).toContain("已加载 2 条");
  expect(mounted.wrapper.findAll("button").some((b) => b.text() === "加载更早的执行记录")).toBe(false);
});

it("后续页失败保留已加载记录，按原游标重试，不当作完整结果", async () => {
  let attempts = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (!String(input).includes("cursor=")) return response({ items: [row(runId)], next_cursor: runId });
    return ++attempts === 1 ? response({ code: "UNAVAILABLE", detail: "测试失败" }, 503)
      : response({ items: [row(oldId)], next_cursor: null });
  }));
  const mounted = await mountReact(view()); unmount = mounted.unmount;
  await mounted.wrapper.findAll("button").find((b) => b.text() === "加载更早的执行记录")!.trigger("click");
  expect(mounted.wrapper.get('[role="alert"]').text()).toContain("测试失败");
  expect(mounted.wrapper.find(`a[href="/runs/${runId}"]`).exists()).toBe(true);
  expect(mounted.wrapper.text()).toContain("还有更早记录");
  await mounted.wrapper.findAll("button").find((b) => b.text() === "重试读取执行历史")!.trigger("click");
  expect(attempts).toBe(2); expect(mounted.wrapper.text()).toContain("已加载 2 条");
});

it("无当前 Run 也能阅读历史，空页明确显示无记录", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => response({ items: [row(oldId)], next_cursor: null })));
  const mounted = await mountReact(view(taskId, null)); unmount = mounted.unmount;
  expect(mounted.wrapper.text()).not.toContain("当前 Task 绑定");
  expect(mounted.wrapper.find(`a[href="/runs/${oldId}"]`).exists()).toBe(true);
  vi.stubGlobal("fetch", vi.fn(async () => response({ items: [], next_cursor: null })));
  await mounted.wrapper.findAll("button")[0].trigger("click");
  expect(mounted.wrapper.text()).toContain("该任务尚无 AI 执行记录");
});

it("错误任务的历史响应被拒绝，不能展示串读记录", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => response({ items: [row(oldId, otherTaskId)], next_cursor: null })));
  const mounted = await mountReact(view()); unmount = mounted.unmount;
  expect(mounted.wrapper.get('[role="alert"]').text()).toContain("任务归属不匹配");
  expect(mounted.wrapper.find(`a[href="/runs/${oldId}"]`).exists()).toBe(false);
});

it("切换任务清除旧历史，旧页迟到不覆盖新任务", async () => {
  let release: ((r: Response) => void) | undefined;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).includes(taskId)
    ? new Promise<Response>((resolve) => { release = resolve; }) : response({ items: [], next_cursor: null })));
  const mounted = await mountReact(view()); unmount = mounted.unmount;
  expect(mounted.wrapper.get('[role="status"]').text()).toContain("正在读取");
  await mounted.rerender(view(otherTaskId));
  release!(response({ items: [row(oldId)], next_cursor: null })); await flush();
  expect(mounted.wrapper.text()).toContain("该任务尚无 AI 执行记录");
  expect(mounted.wrapper.find(`a[href="/runs/${oldId}"]`).exists()).toBe(false);
});

it("403 撤下先前列表，重试回首批而不沿旧页继续", async () => {
  let denied = true; const cursors: (string | null)[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const cursor = new URL(String(input)).searchParams.get("cursor"); cursors.push(cursor);
    if (cursor && denied) return response({ code: "FORBIDDEN", detail: "访问撤销" }, 403);
    return response({ items: [row(runId)], next_cursor: runId });
  }));
  const mounted = await mountReact(view()); unmount = mounted.unmount;
  await mounted.wrapper.findAll("button").find((b) => b.text() === "加载更早的执行记录")!.trigger("click");
  expect(mounted.wrapper.find(`a[href="/runs/${runId}"]`).exists()).toBe(false);
  denied = false;
  await mounted.wrapper.findAll("button").find((b) => b.text() === "重试读取执行历史")!.trigger("click");
  expect(cursors).toEqual([null, runId, null]);
});
