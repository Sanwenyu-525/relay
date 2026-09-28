import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { DomWrapper, flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const reviewId = "44444444-4444-4444-8444-444444444444";
const knowledgeId = "55555555-5555-4555-8555-555555555555";
const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.(); unmount = null;
  resetRelayConnectionForTest();
  vi.unstubAllGlobals();
});

function connect() { activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" }); }
function response(body: unknown, status = 200): Response { return { ok: status >= 200 && status < 300, status, json: async () => body } as Response; }
function currentProject() { return { id: projectId, title: "真实项目", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null }; }
function currentTask(allowedActions: string[], runId: string | null = null) {
  return { id: taskId, project_id: projectId, title: "真实任务", status: runId ? "WAITING" : "READY", mode: "ME",
    revision: "2", executor: { kind: runId ? "AI" : "HUMAN", run_id: runId }, current_completion_id: null,
    waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: allowedActions,
    acceptance: { acceptance_revision: "1", objective: "目标", source: "HUMAN", criteria: [] }, dependencies: [] };
}
async function key(keyName: string, options: KeyboardEventInit = {}) {
  await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: keyName, bubbles: true, cancelable: true, ...options })); });
}
function palette(): HTMLElement { const element = document.querySelector<HTMLElement>('[role="dialog"][aria-label="命令面板"]'); if (!element) throw new Error("palette missing"); return element; }

describe("Ctrl+K 全局命令面板", () => {
  it("fixture 模式有键盘焦点、Tab 循环和 Escape 焦点返回，不发真实请求", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench("/projects"); unmount = mounted.unmount;
    const trigger = mounted.wrapper.get('[data-testid="command-open"]').element as HTMLElement;
    trigger.focus(); await key("k", { ctrlKey: true }); await flush();
    expect(palette().textContent).toContain("当前为示例数据");
    expect(document.activeElement).toBe(palette().querySelector('[data-testid="command-search"]'));
    const focusable = Array.from(palette().querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])'));
    const last = focusable.at(-1)!; last.focus(); await key("Tab");
    expect(document.activeElement).toBe(focusable[0]);
    await key("Tab", { shiftKey: true }); expect(document.activeElement).toBe(last);
    await key("Escape"); await flush();
    expect(document.querySelector('[role="dialog"][aria-label="命令面板"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("收件箱快捷命令复用 /inbox 别名，动态说明与已接入的 Activity 一致", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench("/today"); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="command-open"]').trigger("click");
    expect(palette().textContent).toContain("查看示例动态");
    const inbox = Array.from(palette().querySelectorAll<HTMLButtonElement>(".command-palette-actions button"))
      .find((button) => button.textContent?.includes("打开收件箱"));
    await new DomWrapper(inbox!).trigger("click"); await flush();
    expect(mounted.router.currentRoute.value.path).toBe("/tasks");
    expect(mounted.router.currentRoute.value.query.tab).toBe("inbox");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("真实搜索只查四类资料，展示来源与范围，结果打开确切资料项", async () => {
    connect(); const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length); requests.push(`${init?.method ?? "GET"} ${path}`);
      if (path.startsWith("/search?")) return response({ items: [{ type: "KNOWLEDGE", id: knowledgeId, version: "3", title: "研究资料", snippet: "可信摘录",
        matched_fields: ["title"], source_ref: "knowledge:source-3", status: "ACTIVE", project_id: projectId }], next_cursor: null });
      if (path === `/projects/${projectId}`) return response(currentProject());
      if (path === `/knowledge?project_id=${projectId}`) return response([]);
      if (path === `/knowledge/${knowledgeId}`) return response({ id: knowledgeId, project_id: projectId, title: "研究资料", status: "ACTIVE", revision: "3", current_version: "3", created_at: "2026-09-26T00:00:00Z", updated_at: "2026-09-26T00:00:00Z" });
      if (path === `/knowledge/${knowledgeId}/versions`) return response([]);
      throw new Error(`Unexpected ${path}`);
    }));
    const mounted = await mountWorkbench("/projects"); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="command-open"]').trigger("click");
    await new DomWrapper(palette().querySelector('[data-testid="command-search"]')).setValue("研究"); await flush(350);
    expect(palette().textContent).toContain("研究资料");
    expect(palette().textContent).toContain("来源：knowledge:source-3");
    expect(requests.some((item) => item.includes("types=KNOWLEDGE%2CMEMORY%2CDECISION%2CRULE") && item.includes("q=%E7%A0%94%E7%A9%B6"))).toBe(true);
    expect(requests.every((item) => item.startsWith("GET "))).toBe(true);
    await new DomWrapper(palette().querySelector(".command-palette-results button")).trigger("click"); await flush();
    expect(mounted.router.currentRoute.value.path).toBe(`/projects/${projectId}/knowledge`);
    expect(mounted.router.currentRoute.value.query.item).toBe(knowledgeId);
    expect(mounted.router.currentRoute.value.query.kind).toBe("KNOWLEDGE");
    expect(mounted.wrapper.text()).toContain("研究资料");
  });

  it("明确 Project ID 先经 GET 单读核对；创建入口复用真实表单的待预览意图", async () => {
    connect(); const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if (path === `/projects/${projectId}`) return response(currentProject());
      if (path === `/projects/${projectId}/state`) return response({ project_id: projectId, revision: "1", phase_key: "PLANNING", next_action_task_id: null, selected_artifact_version_refs: [], completed_highlight_refs: [] });
      if (path === `/tasks?project_id=${projectId}`) return response({ items: [], next_cursor: null });
      throw new Error(`Unexpected ${path}`);
    }); vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench("/projects"); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="command-open"]').trigger("click");
    await new DomWrapper(palette().querySelector('[data-testid="command-project-id"]')).setValue(projectId);
    await new DomWrapper(palette().querySelector(".command-palette-project")).trigger("submit"); await flush();
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith(`/projects/${projectId}`))).toBe(true);
    expect(mounted.router.currentRoute.value.path).toBe(`/projects/${projectId}`);
    expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
    await mounted.wrapper.get('[data-testid="command-open"]').trigger("click");
    await new DomWrapper(Array.from(palette().querySelectorAll(".command-palette-actions button")).find((item) => item.textContent?.includes("新建项目"))!).trigger("click"); await flush();
    expect(mounted.router.currentRoute.value.path).toBe("/projects");
    expect(mounted.router.currentRoute.value.query.view).toBe("create");
    expect(mounted.wrapper.text()).toContain("待预览的人工蓝图意图");
    expect(mounted.wrapper.get('textarea[name="project-goal"]').attributes("disabled")).toBeUndefined();
  });

  it("当前任务只在 START 提示和人工 READY 条件满足时导航委托；待审链接精确定位", async () => {
    connect(); const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length); calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path === `/tasks/${taskId}`) return response(currentTask(["START"]));
      if (path === `/projects/${projectId}`) return response(currentProject());
      if (path === "/reviews?status=OPEN") return response({ items: [{ id: reviewId, kind: "CRITERION", status: "OPEN", revision: "1", project_id: projectId,
        task_id: taskId, run_id: null, reason: "等待判断", target_hash: "hash", target: {}, evidence: {}, effect: {},
        allowed_decisions: ["ACCEPT"], expires_at: null, created_at: "2026-09-26T00:00:00Z", decided_at: null }] });
      if (path.startsWith("/search?")) return response({ items: [], next_cursor: null });
      if (path === `/knowledge?project_id=${projectId}`) return response([]);
      throw new Error(`Unexpected ${path}`);
    }));
    const mounted = await mountWorkbench(`/tasks/${taskId}`); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="command-open"]').trigger("click"); await flush();
    const buttons = Array.from(palette().querySelectorAll<HTMLButtonElement>(".command-palette-actions button"));
    expect(palette().textContent).toContain("真实任务");
    expect(buttons.find((item) => item.textContent?.includes("委托当前任务"))?.disabled).toBe(false);
    expect(buttons.find((item) => item.textContent?.includes("查看当前任务待审"))?.textContent).toContain(reviewId);
    expect((palette().querySelector(".command-palette-scope input") as HTMLInputElement).checked).toBe(true);
    await new DomWrapper(palette().querySelector('[data-testid="command-search"]')).setValue("证据"); await flush(350);
    expect(calls.some((item) => item.includes("/search?") && item.includes(`project_id=${projectId}`))).toBe(true);
    await new DomWrapper(buttons.find((item) => item.textContent?.includes("委托当前任务"))!).trigger("click"); await flush();
    expect(mounted.router.currentRoute.value.path).toBe(`/tasks/${taskId}`);
    expect(mounted.router.currentRoute.value.query.tab).toBe("runs");
    expect(mounted.wrapper.find('[data-testid="task-delegate-panel"]').exists()).toBe(true);
    expect(calls.every((item) => item.startsWith("GET "))).toBe(true);
  });

  it("无 START 提示时禁用委托；Today 与 Activity 只读真实空投影", async () => {
    connect();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).slice(root.length);
      if (path === `/tasks/${taskId}`) return response(currentTask([]));
      if (path === `/projects/${projectId}`) return response(currentProject());
      if (path === "/reviews?status=OPEN") return response({ items: [] });
      if (path.startsWith("/today?")) { const query = new URL(path, baseUrl).searchParams;
        return response({ date: query.get("date"), timezone: query.get("timezone"), selection_revision: "0", focus: null,
          focus_has_eligible_candidate: false, eligible_items: [], waiting_items: [], blocked_pinned_items: [] }); }
      if (path === "/activities") return response({ items: [], next_cursor: null });
      throw new Error(`Unexpected ${path}`);
    }));
    const mounted = await mountWorkbench(`/tasks/${taskId}`); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="command-open"]').trigger("click"); await flush();
    const delegate = Array.from(palette().querySelectorAll<HTMLButtonElement>(".command-palette-actions button")).find((item) => item.textContent?.includes("委托当前任务"))!;
    expect(delegate.disabled).toBe(true);
    await key("Escape");
    await mounted.router.push("/today"); await flush(); expect(mounted.wrapper.text()).toContain("当前日期下没有可安排的任务");
    await mounted.router.push("/activity"); await flush(); expect(mounted.wrapper.text()).toContain("当前筛选范围没有返回 Activity");
  });
});
