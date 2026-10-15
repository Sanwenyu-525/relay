import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { hasUnsavedDraft, currentDraftGuard } from "../src/lib/draftGuard";
import { flush, dialogText, mountWorkbench } from "./mountApp";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const taskId = "33333333-3333-4333-8333-333333333333";
const root = `/api/v1/workspaces/${workspaceId}`;
const taskPath = `${root}/tasks/${taskId}`;
const oldCriterion = { criterion_id: "structure", statement: "原始结构条件", required: true,
  method: "MARKDOWN_STRUCTURE", target_spec: { headings: ["结果"], min_length: 120 } };
let unmount: (() => void) | null = null;

afterEach(() => { unmount?.(); unmount = null; resetRelayConnectionForTest(); vi.unstubAllGlobals(); });
function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function taskBody(overrides: Record<string, unknown> = {}) {
  return { id: taskId, project_id: null, title: "待整理任务", status: "INBOX", mode: "ME", revision: "2",
    acceptance_revision: "1", executor: { kind: "HUMAN", run_id: null, ownership_epoch: "0" },
    current_completion_id: null, waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [],
    allowed_actions: [], created_at: "2026-10-05T00:00:00Z", updated_at: "2026-10-05T00:00:00Z",
    acceptance: { acceptance_revision: "1", objective: "完成原始工作", expected_outputs: {}, source: "CREATE",
      created_at: "2026-10-05T00:00:00Z", criteria: [] },
    goal_alignment: { mode: "INHERIT", goal_ids: [], effective_goal_ids: [] }, dependencies: [], ...overrides };
}
function savedResult(body: Record<string, unknown>) {
  return { task_id: taskId, status: "INBOX", revision: "3", previous_acceptance_revision: "1",
    acceptance_revision: "2", objective: "完成原始工作", required_output_spec: {},
    criteria: (body.criteria as Record<string, unknown>[]).map((c, i) => ({ criterion_id: `new-${i}`, ...c })),
    added_criterion_ids: ["new-0"] };
}
interface Call { path: string; method: string; body: Record<string, unknown> }
async function mount(options: { initial?: Record<string, unknown>;
  post?: (body: Record<string, unknown>) => Promise<Response>;
  receipt?: (id: string) => Response } = {}) {
  activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId,
    bearerToken: "test-bearer-token-0123456789abcdef" });
  const calls: Call[] = []; let current = taskBody(options.initial);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname; const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    calls.push({ path, method, body });
    if (method === "POST" && path === `${taskPath}/acceptance`) {
      if (options.post) return options.post(body);
      const result = savedResult(body);
      current = taskBody({ revision: "3", acceptance_revision: "2", acceptance: {
        acceptance_revision: "2", objective: result.objective, expected_outputs: {}, source: "CONTRACT_CHANGE",
        created_at: "2026-10-05T00:00:00Z", criteria: result.criteria } });
      return response(200, { command_id: body.command_id, committed_at: "2026-10-05T00:00:00Z", result });
    }
    if (path.startsWith(`${root}/commands/`)) return options.receipt?.(path.split("/").at(-1)!) ??
      response(404, { code: "COMMAND_NOT_FOUND", detail: "原命令未找到" });
    if (path === taskPath) return response(200, current);
    if (path.endsWith("/artifacts")) return response(200, { items: [], current_accepted_version_ids: [] });
    return response(200, { items: [], next_cursor: null });
  }));
  const view = await mountWorkbench(`/tasks/${taskId}`); unmount = view.unmount;
  return { ...view, calls, setCurrent: (body: Record<string, unknown>) => { current = taskBody(body); } };
}
async function enter(view: Awaited<ReturnType<typeof mount>>, text = "测试结果可复现") {
  await view.wrapper.get('[data-testid="task-acceptance-edit-open"]').trigger("click");
  await view.wrapper.get('[data-testid="task-acceptance-additions"]').setValue(text);
}
const posts = (calls: Call[]) => calls.filter(c => c.method === "POST");

describe("创建后人工补验收条件", () => {
  it("零条件任务可补条件，保存完整集合与双修订；不自动 READY 或启动执行", async () => {
    const view = await mount(); expect(posts(view.calls)).toHaveLength(0);
    await enter(view, "测试结果可复现\n保存测试依据");
    expect(hasUnsavedDraft()).toBe(true);
    await view.wrapper.get('[data-testid="task-acceptance-save"]').trigger("click"); await flush();
    expect(posts(view.calls)).toHaveLength(1);
    expect(posts(view.calls)[0]?.body).toEqual({ command_id: expect.any(String), expected_revision: "2",
      expected_acceptance_revision: "1", criteria: [
        { statement: "测试结果可复现", required: true, method: "HUMAN", target_spec: {} },
        { statement: "保存测试依据", required: true, method: "HUMAN", target_spec: {} }] });
    expect(view.wrapper.get('[data-testid="task-acceptance-saved"]').text()).toContain("v2");
    expect(view.wrapper.text()).toContain("保存测试依据");
    expect(hasUnsavedDraft()).toBe(false);
  });

  it("已有必需与可选条件连同 target_spec 原样保留，不改写目标或产物规格", async () => {
    const optional = { criterion_id: "optional", statement: "建议性检查", required: false, method: "HUMAN", target_spec: {} };
    const view = await mount({ initial: { acceptance: { ...taskBody().acceptance, criteria: [oldCriterion, optional] } } });
    await enter(view); await view.wrapper.get('[data-testid="task-acceptance-save"]').trigger("click"); await flush();
    expect((posts(view.calls)[0]?.body.criteria as unknown[]).slice(0, 2)).toEqual([oldCriterion, optional]);
    expect(posts(view.calls)[0]?.body.objective).toBeUndefined();
    expect(posts(view.calls)[0]?.body.required_output_spec).toBeUndefined();
  });

  it.each([{ executor: { kind: "AI", run_id: null, ownership_epoch: "1" } },
    { status: "DONE" }, { status: "WAITING" },
    { executor: { kind: "HUMAN", run_id: "44444444-4444-4444-8444-444444444444", ownership_epoch: "1" } }])
    ("执行权或周期不可编辑时关闭入口，仍可阅读", async initial => {
      const view = await mount({ initial });
      expect(view.wrapper.get('[data-testid="task-acceptance-edit-open"]').attributes("disabled")).toBeDefined();
      await view.wrapper.get('[data-testid="task-acceptance-edit-open"]').trigger("click");
      expect(posts(view.calls)).toHaveLength(0);
    });

  it("空输入和超过集合上限不提交", async () => {
    const view = await mount(); await enter(view, "   \n ");
    await view.wrapper.get('[data-testid="task-acceptance-save"]').trigger("click");
    expect(posts(view.calls)).toHaveLength(0);
    await view.wrapper.get('[data-testid="task-acceptance-additions"]').setValue(Array.from({ length: 31 }, (_, i) => `条件${i}`).join("\n"));
    await view.wrapper.get('[data-testid="task-acceptance-save"]').trigger("click");
    expect(posts(view.calls)).toHaveLength(0);
  });

  it("修订冲突保留输入、重读事实，下一次显式确认才按新修订发新命令", async () => {
    let attempt = 0;
    const view = await mount({ post: async body => {
      if (++attempt === 1) { view.setCurrent({ revision: "5", acceptance_revision: "4",
        acceptance: { ...taskBody().acceptance, acceptance_revision: "4", criteria: [oldCriterion] } });
        return response(409, { code: "REVISION_CONFLICT", detail: "验收版本已变化" }); }
      return response(200, { command_id: body.command_id, committed_at: "2026-10-05T00:00:00Z",
        result: { ...savedResult(body), previous_acceptance_revision: "4", acceptance_revision: "5", revision: "6" } });
    } });
    await enter(view); await view.wrapper.get('[data-testid="task-acceptance-save"]').trigger("click"); await flush();
    expect(posts(view.calls)).toHaveLength(1);
    expect((view.wrapper.get('[data-testid="task-acceptance-additions"]').element as HTMLTextAreaElement).value).toBe("测试结果可复现");
    await view.wrapper.get('[data-testid="task-acceptance-save"]').trigger("click"); await flush();
    const sent = posts(view.calls); expect(sent).toHaveLength(2);
    expect(sent[1]?.body.expected_revision).toBe("5"); expect(sent[1]?.body.expected_acceptance_revision).toBe("4");
    expect(sent[1]?.body.command_id).not.toBe(sent[0]?.body.command_id);
    expect((sent[1]?.body.criteria as unknown[])[0]).toEqual(oldCriterion);
  });

  it("响应丢失核对原回执，未知不发新命令；明确无回执时只开放同身份同载荷重试", async () => {
    const view = await mount({ post: async () => { throw new TypeError("response lost"); } });
    await enter(view); await view.wrapper.get('[data-testid="task-acceptance-save"]').trigger("click"); await flush();
    const first = posts(view.calls)[0]!;
    expect(view.calls.some(c => c.path === `${root}/commands/${first.body.command_id}`)).toBe(true);
    expect(currentDraftGuard()?.pendingCommandId?.()).toBe(first.body.command_id);
    expect(view.wrapper.get('[data-testid="task-acceptance-save"]').attributes("disabled")).toBeDefined();
    await view.wrapper.get('[data-testid="task-acceptance-retry"]').trigger("click"); await flush();
    expect(posts(view.calls)).toHaveLength(2); expect(posts(view.calls)[1]?.body).toEqual(first.body);
  });

  it.each(["command-type", "target"])("回执类型或目标错配保持未决：%s", async mismatch => {
    const view = await mount({ post: async () => { throw new TypeError("response lost"); },
      receipt: id => response(200, { command_id: id,
        command_type: mismatch === "command-type" ? "CreateTask" : "ReviseTaskAcceptance",
        committed_at: "2026-10-05T00:00:00Z", result: { ...savedResult({ criteria: [] }),
          task_id: mismatch === "target" ? "another-task" : taskId } }) });
    await enter(view); await view.wrapper.get('[data-testid="task-acceptance-save"]').trigger("click"); await flush();
    expect(view.wrapper.find('[data-testid="task-acceptance-saved"]').exists()).toBe(false);
    expect(view.wrapper.find('[data-testid="task-acceptance-retry"]').exists()).toBe(false);
    expect(currentDraftGuard()?.pendingCommandId?.()).toBe(posts(view.calls)[0]?.body.command_id);
  });

  it("丢失响应但原回执有效时成功恢复，不重复提交", async () => {
    const view = await mount({ post: async () => { throw new TypeError("response lost"); },
      receipt: id => response(200, { command_id: id, command_type: "ReviseTaskAcceptance",
        committed_at: "2026-10-05T00:00:00Z", result: savedResult(posts(view.calls)[0]!.body) }) });
    await enter(view); await view.wrapper.get('[data-testid="task-acceptance-save"]').trigger("click"); await flush();
    expect(posts(view.calls)).toHaveLength(1);
    expect(view.wrapper.get('[data-testid="task-acceptance-saved"]').text()).toContain("v2");
    expect(currentDraftGuard()?.pendingCommandId?.()).toBeNull(); expect(hasUnsavedDraft()).toBe(false);
  });

  it.each(["acceptance", "task"])("新版本或任务修订错配保持原未决命令：%s", async mismatch => {
    const view = await mount({ post: async () => { throw new TypeError("response lost"); },
      receipt: id => response(200, { command_id: id, command_type: "ReviseTaskAcceptance",
        committed_at: "2026-10-05T00:00:00Z", result: { ...savedResult({ criteria: [] }),
          ...(mismatch === "acceptance" ? { acceptance_revision: "99" } : { revision: "2" }) } }) });
    await enter(view); await view.wrapper.get('[data-testid="task-acceptance-save"]').trigger("click"); await flush();
    expect(view.wrapper.find('[data-testid="task-acceptance-saved"]').exists()).toBe(false);
    expect(currentDraftGuard()?.pendingCommandId?.()).toBe(posts(view.calls)[0]?.body.command_id);
    expect((view.wrapper.get('[data-testid="task-acceptance-additions"]').element as HTMLTextAreaElement).value).toBe("测试结果可复现");
  });

  it("同页签切换保留未保存输入与保护，返回概览还能继续", async () => {
    const view = await mount(); await enter(view);
    await view.wrapper.get('[data-testid="task-detail-tab-runs"]').trigger("click");
    expect(hasUnsavedDraft()).toBe(true);
    await view.wrapper.get('[data-testid="task-detail-tab-overview"]').trigger("click");
    expect((view.wrapper.get('[data-testid="task-acceptance-additions"]').element as HTMLTextAreaElement).value).toBe("测试结果可复现");
    expect(posts(view.calls)).toHaveLength(0);
  });

  it("展开后焦点移入输入区，收起后回到触发按钮", async () => {
    const view = await mount();
    await view.wrapper.get('[data-testid="task-acceptance-edit-open"]').trigger("click");
    expect(view.wrapper.get('[data-testid="task-acceptance-additions"]').element).toBe(document.activeElement);
    await view.wrapper.get('[data-testid="task-acceptance-cancel"]').trigger("click");
    expect(view.wrapper.get('[data-testid="task-acceptance-edit-open"]').element).toBe(document.activeElement);
  });

  it("快速重复点击只有一个命令，在途禁止改内容", async () => {
    let resolve!: (response: Response) => void;
    const view = await mount({ post: body => new Promise<Response>(done => {
      resolve = () => done(response(200, { command_id: body.command_id, committed_at: "2026-10-05T00:00:00Z",
        result: savedResult(body) }));
    }) });
    await enter(view);
    await view.wrapper.get('[data-testid="task-acceptance-save"]').trigger("click");
    await view.wrapper.get('[data-testid="task-acceptance-save"]').trigger("click");
    expect(posts(view.calls)).toHaveLength(1);
    expect(view.wrapper.get('[data-testid="task-acceptance-additions"]').attributes("disabled")).toBeDefined();
    resolve(response(200, {})); await flush();
    expect(view.wrapper.find('[data-testid="task-acceptance-saved"]').exists()).toBe(true);
  });
});

describe("FE-05 已满足项的验收反例锁", () => {
  it("P1 界面不提供条件删除、任意检查 DSL、多方法编辑器或自动重跑入口", async () => {
    const view = await mount(); await enter(view, "新增条件");
    const panel = view.wrapper.get('[data-testid="task-acceptance-edit"]');
    const html = panel.element?.outerHTML ?? "";
    expect(html).not.toMatch(/删除|移除|重跑|重新运行|自动运行|DSL/);
    expect(panel.findAll("select")).toHaveLength(0);
    expect(panel.findAll("textarea")).toHaveLength(1);
    expect(view.wrapper.find('[data-testid="task-acceptance-delete"]').exists()).toBe(false);
    expect(view.wrapper.find('[data-testid="task-acceptance-rerun"]').exists()).toBe(false);
  });

  it("P2 修订冲突提示明确说明服务端基准已变化且本次输入不会被覆盖", async () => {
    const view = await mount({ post: async () => response(409, { code: "REVISION_CONFLICT",
      detail: "验收版本已变化", expected_revision: "2", actual_revision: "5" }) });
    await enter(view);
    await view.wrapper.get('[data-testid="task-acceptance-save"]').trigger("click"); await flush();
    const alert = view.wrapper.get('[data-testid="task-acceptance-edit"] [role="alert"]').text();
    expect(alert).toContain("版本");
    expect(alert).toContain("不会");
  });

  it("P3 原命令未核对时拦住离开，不能进入新 Task 让迟到回执落到别处", async () => {
    const otherId = "55555555-5555-4555-8555-555555555555";
    const view = await mount({ post: async () => { throw new TypeError("response lost"); } });
    await enter(view);
    await view.wrapper.get('[data-testid="task-acceptance-save"]').trigger("click"); await flush();
    const pendingCommandId = view.wrapper.get('[data-testid="task-acceptance-pending"] code').text();
    await view.router.push(`/tasks/${otherId}`); await flush();
    expect(view.router.currentRoute.value.path).toBe(`/tasks/${taskId}`);
    const dialog = dialogText();
    expect(dialog).toContain("命令结果待核对");
    expect(dialog).toContain(pendingCommandId);
    expect(dialog).not.toContain("丢弃草稿并离开");
    expect(view.wrapper.find('[data-testid="task-acceptance-edit"]').exists()).toBe(true);
  });

  it("P4 修订冲突重读后按服务端顺序拼装，不静默丢弃别人的条件", async () => {
    const other = { criterion_id: "other", statement: "别人的条件", required: true, method: "HUMAN", target_spec: {} };
    let attempt = 0;
    const view = await mount({ post: async body => {
      if (++attempt === 1) { view.setCurrent({ revision: "5", acceptance_revision: "4",
        acceptance: { ...taskBody().acceptance, acceptance_revision: "4", criteria: [oldCriterion, other] } });
        return response(409, { code: "REVISION_CONFLICT", detail: "验收版本已变化" }); }
      return response(200, { command_id: body.command_id, committed_at: "2026-10-05T00:00:00Z",
        result: { ...savedResult(body), previous_acceptance_revision: "4", acceptance_revision: "5", revision: "6" } });
    } });
    await enter(view, "我的新增条件");
    await view.wrapper.get('[data-testid="task-acceptance-save"]').trigger("click"); await flush();
    await view.wrapper.get('[data-testid="task-acceptance-save"]').trigger("click"); await flush();
    const sent = posts(view.calls); expect(sent).toHaveLength(2);
    const criteria = sent[1]?.body.criteria as Record<string, unknown>[];
    expect(criteria.slice(0, 2)).toEqual([oldCriterion, other]);
    expect(criteria[2]).toEqual({ statement: "我的新增条件", required: true, method: "HUMAN", target_spec: {} });
  });
});
