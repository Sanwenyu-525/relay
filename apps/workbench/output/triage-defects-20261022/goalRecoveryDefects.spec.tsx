import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import CreateGoalView from "../../src/views/CreateGoalView";
import GoalProjectLinkPanel from "../../src/views/GoalProjectLinkPanel";
import { RelayApiClient } from "../../src/api/relayClient";
import { flush, mountReact } from "../../tests/mountApp";
const projectId = "22222222-2222-4222-8222-222222222222";
const goalId = "44444444-4444-4444-8444-444444444444";
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; vi.unstubAllGlobals(); });
function response(status: number, body: unknown): Response { return { ok: status >= 200 && status < 300, status, json: async () => body } as Response; }
const client = () => new RelayApiClient({ baseUrl: "http://127.0.0.1:8787", workspaceId: "11111111-1111-4111-8111-111111111111", bearerToken: "test-token" });
const project = (id: string, title: string) => ({ id, title, project_type: "GENERAL", revision: "2", state_revision: "1", archived_at: null,
  archive_status: "ACTIVE", phase_key: "PLANNING", next_action_task_id: null, created_at: "2026-10-22T00:00:00Z", updated_at: "2026-10-22T00:00:00Z" });

it("创建Goal结果未知且回执未找到时，普通提交不得覆盖原pending身份", async () => {
  const ids: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") { ids.push(JSON.parse(String(init.body)).command_id); throw new TypeError("response lost"); }
    return response(404, { code: "COMMAND_NOT_FOUND", detail: "not found yet" });
  }));
  const mounted = await mountReact(createElement(MemoryRouter, null, createElement(CreateGoalView, { client: client(), onCancel: vi.fn() })));
  unmount = mounted.unmount;
  await mounted.wrapper.get('[data-testid="goal-intent"]').setValue("可恢复的项目目标");
  await mounted.wrapper.get('[data-testid="goal-form"]').trigger("submit"); await flush();
  expect(mounted.wrapper.get('[data-testid="goal-pending"]').text()).toContain(ids[0]);
  expect(mounted.wrapper.get('[data-testid="goal-submit"]').attributes("disabled")).toBeUndefined();
  await mounted.wrapper.get('[data-testid="goal-form"]').trigger("submit"); await flush();
  console.log("TRIAGE_CREATE_GOAL_PENDING", JSON.stringify(ids));
  expect(new Set(ids).size).toBe(1);
});

it("关联Goal结果未知且回执未找到时，普通关联不得覆盖原pending身份", async () => {
  const ids: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") { ids.push(JSON.parse(String(init.body)).command_id); throw new TypeError("response lost"); }
    if (new URL(String(input)).pathname.endsWith("/projects")) return response(200, { items: [project(projectId, "合法项目")], next_cursor: null });
    return response(404, { code: "COMMAND_NOT_FOUND", detail: "not found yet" });
  }));
  const mounted = await mountReact(createElement(MemoryRouter, null, createElement(GoalProjectLinkPanel, { client: client(), goalId, goalTitle: "目标" })));
  unmount = mounted.unmount; await flush();
  await mounted.wrapper.get('[data-testid="goal-link-project"]').setValue(projectId);
  await mounted.wrapper.get('[data-testid="goal-link-submit"]').trigger("click"); await flush();
  expect(mounted.wrapper.get('[data-testid="goal-link-pending"]').text()).toContain(ids[0]);
  expect(mounted.wrapper.get('[data-testid="goal-link-submit"]').attributes("disabled")).toBeUndefined();
  await mounted.wrapper.get('[data-testid="goal-link-submit"]').trigger("click"); await flush();
  console.log("TRIAGE_LINK_GOAL_PENDING", JSON.stringify(ids));
  expect(new Set(ids).size).toBe(1);
});

it("关联项目列表有next_cursor时应提供读取后续项目入口", async () => {
  let nextReads = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.searchParams.has("cursor")) { nextReads++; return response(200, { items: [project("55555555-5555-4555-8555-555555555555", "第二页目标项目")], next_cursor: null }); }
    return response(200, { items: [project(projectId, "第一页项目")], next_cursor: "second-page" });
  }));
  const mounted = await mountReact(createElement(MemoryRouter, null, createElement(GoalProjectLinkPanel, { client: client(), goalId, goalTitle: "目标" })));
  unmount = mounted.unmount; await flush();
  const more = mounted.wrapper.findAll("button").find(button => /更多|下一页|继续加载|后续/.test(button.text()));
  if (more) { await more.trigger("click"); await flush(); }
  console.log("TRIAGE_LINK_GOAL_PAGES", JSON.stringify({ nextReads, hasMore: !!more }));
  expect(mounted.wrapper.get('[data-testid="goal-link-project"]').text()).toContain("第二页目标项目");
});
