import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const sessionId = "44444444-4444-4444-8444-444444444444";
const proposalId = "55555555-5555-4555-8555-555555555555";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const hash = "a".repeat(64);

function response(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}
function task(revision = "2", acceptanceRevision = "1") {
  return { id: taskId, project_id: projectId, title: "真实任务", status: "READY", mode: "ME",
    revision, executor: { kind: "HUMAN", run_id: null, ownership_epoch: "1" },
    current_completion_id: null, waiting_reason: null, blocking_task_ids: [],
    unresolved_blocker_ids: [], allowed_actions: [], dependencies: [],
    acceptance: { acceptance_revision: acceptanceRevision, objective: "旧目标", source: "CREATE",
      expected_outputs: { artifacts: ["MARKDOWN_DOCUMENT"], description: "旧说明" }, criteria: [
        { criterion_id: "old-required", statement: "保留的必需条件", required: true, method: "HUMAN" }] } };
}
function proposal(kind: "TASK_CONTRACT_CHANGE" | "VERIFICATION_PLAN_CHANGE" = "TASK_CONTRACT_CHANGE",
  status = "PENDING", available = true) {
  return { id: proposalId, workspace_id: workspaceId, session_id: sessionId,
    message_id: "66666666-6666-4666-8666-666666666666", kind,
    project_id: projectId, task_id: taskId, target_type: "TASK", target_id: taskId,
    base_revision: "2", base_acceptance_revision: "1", payload_hash: hash,
    payload_available: available, skill_sha256: "b".repeat(64), skill_output_sha256: "c".repeat(64),
    payload: available ? { objective: kind === "TASK_CONTRACT_CHANGE" ? "合并后的目标" : "旧目标",
      required_output_spec: { artifacts: ["MARKDOWN_DOCUMENT"], description: "可复核报告" },
      criteria: [{ criterion_id: "old-required", statement: "保留的必需条件", required: true,
        method: "HUMAN", target_spec: {}, source: "PRESERVED" },
      { criterion_id: "new-check", statement: "服务端追加条件", required: true,
        method: "CITATION_EXISTS", target_spec: {}, source: "SUGGESTED" }],
      added_criterion_ids: ["new-check"], preserved_criterion_ids: ["old-required"], suggested_mode: "DELEGATE" } : {},
    status, decision: null, created_at: "2026-09-26T00:00:00Z", decided_at: null,
    updated_at: "2026-09-26T00:00:00Z" };
}
function session() {
  return { id: sessionId, workspace_id: workspaceId, project_id: projectId, task_id: taskId,
    title: "Task Assist", status: "ACTIVE", revision: "1", updated_at: "2026-09-26T00:00:00Z" };
}
function currentSkill(kind: "TASK_CONTRACT_CHANGE" | "VERIFICATION_PLAN_CHANGE") {
  const definition = kind === "TASK_CONTRACT_CHANGE";
  return { id: definition ? "task-to-execution-contract" : "verification-plan", version: "1.1.0",
    sha256: "b".repeat(64), title: definition ? "任务定义与结果" : "验收方案",
    target: "TASK", output_kind: definition ? "TASK_DEFINITION_SUGGESTION" : "VERIFICATION_PLAN_SUGGESTION",
    availability: "CALLABLE_SUGGESTION_ONLY", call_supported: true, accept_supported: true,
    required_capabilities: [], missing_capabilities: [], dependencies: [] };
}
function sourceMessage(kind: "TASK_CONTRACT_CHANGE" | "VERIFICATION_PLAN_CHANGE") {
  const definition = kind === "TASK_CONTRACT_CHANGE";
  return { id: "66666666-6666-4666-8666-666666666666", session_id: sessionId, seq: "1",
    role: "ASSISTANT", status: "COMPLETED", intent: "DISCUSS", content: "原始正文",
    error_code: null, sources: [], usage: { input_tokens: null, output_tokens: null },
    cancel_requested: false,
    skill: { ...currentSkill(kind), definition_availability: "AVAILABLE",
      output_availability: "HISTORICAL_SNAPSHOT" }, skill_input: {},
    skill_output: { kind: definition ? "TASK_DEFINITION_SUGGESTION" : "VERIFICATION_PLAN_SUGGESTION",
      status: "SUGGESTED", target_kind: "TASK", target_id: taskId, as_of: "2026-09-26T00:00:00Z",
      baseline: { task_id: taskId, project_id: projectId, task_revision: "2", acceptance_revision: "1" },
      basis_sha256: hash, payload_sha256: hash,
      payload: definition ? { summary: "任务建议", objective: "合并后的目标",
        expected_outputs: { kind: "MARKDOWN_DOCUMENT", description: "可复核报告" },
        criteria: [{ statement: "服务端追加条件", required: true, method: "CITATION_EXISTS" }],
        suggested_mode: "DELEGATE" } : { summary: "验收建议", additional_checks: [
        { statement: "服务端追加条件", required: true, method: "CITATION_EXISTS" }],
        effective_check_plan: false } } };
}
function result() {
  return { task_id: taskId, status: "READY", revision: "3",
    previous_acceptance_revision: "1", acceptance_revision: "2", objective: "合并后的目标",
    required_output_spec: { artifacts: ["MARKDOWN_DOCUMENT"], description: "可复核报告" }, criteria: [],
    added_criterion_ids: ["new-check"], proposal_id: proposalId };
}
function connect() { activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" }); }
afterEach(() => { resetRelayConnectionForTest(); vi.unstubAllGlobals(); });

describe("P12 Task Skill 合并提案", () => {
  it.each([503, 403])("迟到的事实读取 %s 隐藏旧内容但保留新消息原命令与载荷", async (status) => {
    connect(); let accepted = false; let acceptedReads = 0;
    let finishFacts!: (value: Response) => void;
    const lateFacts = new Promise<Response>((resolve) => { finishFacts = resolve; });
    let recovering = false;
    let finishReload!: (value: Response) => void;
    const lateReload = new Promise<Response>((resolve) => { finishReload = resolve; });
    const sends: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === `${prefix}/tasks/${taskId}`) {
        if (recovering) return lateReload;
        if (accepted && ++acceptedReads === 2) return lateFacts;
        return response(accepted ? task("3", "2") : task());
      }
      if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "当前项目", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
      if (path === `${prefix}/assist-sessions`) return response({ items: [session()] });
      if (path === `${prefix}/skill-definitions`) return response({ items: [currentSkill("TASK_CONTRACT_CHANGE")] });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages` && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        sends.push(body);
        if (sends.length === 1) throw new Error("response lost");
        return response({ command_id: body.command_id, committed_at: "2026-09-26T00:00:00Z",
          result: { session_id: sessionId, user_message_id: "77777777-7777-4777-8777-777777777777",
            assistant_message_id: "88888888-8888-4888-8888-888888888888", status: "PENDING" } }, 202);
      }
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return response({ items: [sourceMessage("TASK_CONTRACT_CHANGE")] });
      if (path === `${prefix}/assist-proposals`) return response({ items: [proposal("TASK_CONTRACT_CHANGE", accepted ? "ACCEPTED" : "PENDING")] });
      if (path === `${prefix}/assist-proposals/${proposalId}/accept` && init?.method === "POST") {
        accepted = true;
        return response({ command_id: JSON.parse(String(init.body)).command_id,
          committed_at: "2026-09-26T00:00:00Z", result: result() });
      }
      if (path.startsWith(`${prefix}/commands/`)) return response({ code: "RESOURCE_NOT_FOUND", detail: "receipt absent" }, 404);
      throw new Error(`unexpected request ${path}`);
    }));
    const view = await mountWorkbench(`/tasks/${taskId}?skill=definition`);
    try {
      await view.wrapper.get('[data-testid="task-proposal-actions"] button.primary-button').trigger("click");
      await view.wrapper.get('[data-testid="task-skill-accept"]').trigger("click"); await flush();
      expect(acceptedReads).toBeGreaterThanOrEqual(2);
      await view.wrapper.get('[data-testid="assist-draft"]').setValue("继续补充要求");
      await view.wrapper.get("form.agent-chat-message-form").trigger("submit"); await flush();
      expect(view.wrapper.get(".assist-pending").text()).toContain(String(sends[0].command_id));
      finishFacts(response({ code: status === 403 ? "FORBIDDEN" : "SERVICE_UNAVAILABLE", detail: "Task read failed" }, status));
      await flush();
      expect(view.wrapper.find('[data-testid="assist-session"]').exists()).toBe(true);
      expect(view.wrapper.get(".assist-pending").text()).toContain(String(sends[0].command_id));
      expect(view.wrapper.find('[data-testid="live-task-accepted-facts"]').exists()).toBe(false);
      expect(view.wrapper.find('[data-testid="task-skill-proposal"]').exists()).toBe(false);
      expect(view.wrapper.find(".embedded-assist-history").exists()).toBe(false);
      expect(view.wrapper.find(".embedded-assist-sources").exists()).toBe(false);
      expect(view.wrapper.text()).not.toContain("合并后的目标");
      expect(view.wrapper.get('[data-testid="assist-send"]').attributes("disabled")).toBe("");
      await view.wrapper.get(".assist-pending .secondary-button:first-of-type").trigger("click"); await flush();
      expect(view.wrapper.find(".assist-pending").exists()).toBe(true);
      await view.wrapper.get(".assist-pending .secondary-button:last-child").trigger("click"); await flush();
      expect(sends).toHaveLength(2);
      expect(sends[1]).toEqual(sends[0]);
      expect(view.wrapper.find(".assist-pending").exists()).toBe(false);
      await view.wrapper.get('[data-testid="assist-draft"]').setValue("尚未核对的新要求");
      expect(view.wrapper.get('[data-testid="assist-send"]').attributes("disabled")).toBe("");
      await view.wrapper.get('[data-testid="assist-draft"]').setValue("");
      recovering = true;
      await view.wrapper.get('[data-testid="task-skill-refresh"]').trigger("click"); await flush();
      await view.wrapper.get('[data-testid="assist-draft"]').setValue("重读期间的新要求");
      expect(view.wrapper.find('[data-testid="live-task-accepted-facts"]').exists()).toBe(false);
      expect(view.wrapper.find('[data-testid="task-skill-proposal"]').exists()).toBe(false);
      expect(view.wrapper.find(".embedded-assist-sources").exists()).toBe(false);
      expect(view.wrapper.get('[data-testid="assist-send"]').attributes("disabled")).toBe("");
      await view.wrapper.get("form.agent-chat-message-form").trigger("submit"); await flush();
      expect(sends).toHaveLength(2);
      recovering = false; finishReload(response(task("3", "2"))); await flush();
      expect(view.wrapper.get('[data-testid="live-task-accepted-facts"]').text()).toContain("任务 v3");
      expect((view.wrapper.get('[data-testid="assist-draft"]').element as HTMLTextAreaElement).value).toBe("重读期间的新要求");
    } finally { view.unmount(); }
  });

  it("AI 持有执行权时保留提案供核对，禁止接受写入", async () => {
    connect(); let postCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (init?.method === "POST") postCount++;
      if (path === `${prefix}/tasks/${taskId}`) return response({ ...task(), status: "IN_PROGRESS",
        executor: { kind: "AI", run_id: "77777777-7777-4777-8777-777777777777", ownership_epoch: "1" } });
      if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "当前项目", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
      if (path === `${prefix}/assist-sessions`) return response({ items: [session()] });
      if (path === `${prefix}/skill-definitions`) return response({ items: [currentSkill("TASK_CONTRACT_CHANGE")] });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return response({ items: [sourceMessage("TASK_CONTRACT_CHANGE")] });
      if (path === `${prefix}/assist-proposals`) return response({ items: [proposal()] });
      throw new Error(`unexpected request ${path}`);
    }));
    const view = await mountWorkbench(`/tasks/${taskId}?skill=definition`);
    const card = view.wrapper.get('[data-testid="task-skill-proposal"]');
    expect(view.wrapper.get('[data-testid="task-proposal-actions"]').text()).toContain("当前由 AI 持有执行权");
    expect(card.text()).toContain("合并后的目标");
    expect(view.wrapper.get('[data-testid="task-proposal-actions"] button.primary-button').attributes("disabled")).toBe("");
    await view.wrapper.get('[data-testid="task-proposal-actions"] button.primary-button').trigger("click"); await flush();
    expect(view.wrapper.find('[data-testid="task-skill-accept"]').exists()).toBe(false);
    expect(postCount).toBe(0);
    view.unmount();
  });

  it.each(["assist", "definition"])("%s 页展示服务端合并结果；双确认以冻结 CAS/hash 接受，回执不明沿原命令恢复", async (pageKind) => {
    connect(); let accepted = false; const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === `${prefix}/tasks/${taskId}`) return response(accepted ? task("3", "2") : task());
      if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "当前项目", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
      if (path === `${prefix}/assist-sessions`) return response({ items: [session()] });
      if (path === `${prefix}/skill-definitions`) return response({ items: [currentSkill("TASK_CONTRACT_CHANGE")] });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return response({ items: [sourceMessage("TASK_CONTRACT_CHANGE")] });
      if (path === `${prefix}/assist-proposals`) return response({ items: [proposal("TASK_CONTRACT_CHANGE",
        accepted ? "ACCEPTED" : "PENDING")] });
      if (path === `${prefix}/assist-proposals/${proposalId}/accept` && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        bodies.push(body);
        if (bodies.length === 1) throw new Error("response lost");
        accepted = true;
        return response({ command_id: body.command_id, committed_at: "2026-09-26T00:00:00Z", result: result() });
      }
      if (path.startsWith(`${prefix}/commands/`)) return response({ code: "RESOURCE_NOT_FOUND", detail: "receipt absent" }, 404);
      throw new Error(`unexpected request ${path}`);
    }));
    const view = await mountWorkbench(`/tasks/${taskId}?skill=${pageKind}`);
    if (pageKind === "definition") {
      const skillSelect = view.wrapper.get('[data-testid="assist-skill"]').element;
      if (!(skillSelect instanceof HTMLSelectElement)) throw new Error("Skill selector is not a select");
      expect(skillSelect.value).toBe("task-to-execution-contract@1.1.0");
      expect(view.wrapper.findAll("h1")).toHaveLength(1);
      await view.wrapper.get('[data-testid="assist-draft"]').setValue("尚未发送的修改意见");
      const draftElement = view.wrapper.get('[data-testid="assist-draft"]').element;
      await view.wrapper.get(".embedded-assist-history > summary").trigger("click");
      await view.wrapper.get(".embedded-assist-history > summary").trigger("click");
      await view.wrapper.get(".embedded-assist-sources > summary").trigger("click");
      await view.wrapper.get(".embedded-assist-sources > summary").trigger("click");
      expect(view.wrapper.get('[data-testid="assist-draft"]').element).toBe(draftElement);
      expect(view.wrapper.get('[data-testid="task-skill-refresh"]').attributes("disabled")).toBe("");
      await view.wrapper.get('[data-testid="task-skill-refresh"]').trigger("click"); await flush();
      expect((view.wrapper.get('[data-testid="assist-draft"]').element as HTMLTextAreaElement).value).toBe("尚未发送的修改意见");
      await view.wrapper.get('[data-testid="assist-draft"]').setValue("");
    }
    const card = view.wrapper.get('[data-testid="task-skill-proposal"]');
    expect(view.wrapper.findAll('[data-testid="task-proposal-actions"]')).toHaveLength(1);
    if (pageKind === "definition") {
      expect(card.find('[data-testid="task-proposal-actions"]').exists()).toBe(false);
      expect(view.wrapper.get('[data-testid="task-skill-confirmation"]').find('[data-testid="task-proposal-actions"]').exists()).toBe(true);
    }
    expect(card.text()).toContain("当前：旧目标");
    expect(card.text()).toContain("合并后：合并后的目标");
    expect(card.text()).toContain("旧说明 →可复核报告");
    expect(card.text()).toContain("保留 1 条；新增 1 条");
    expect(card.text()).toContain("保留的必需条件");
    expect(card.text()).toContain("服务端追加条件");
    expect(card.text()).toContain("建议模式 DELEGATE；本次接受只变更验收契约");
    expect(view.wrapper.find('[data-testid="task-skill-accept"]').exists()).toBe(false);
    await view.wrapper.get('[data-testid="task-proposal-actions"] button.primary-button').trigger("click");
    await view.wrapper.get('[data-testid="task-skill-accept"]').trigger("click"); await flush();
    expect(view.wrapper.text()).toContain("命令结果待核对");
    expect(bodies).toHaveLength(1);
    if (pageKind === "definition") {
      expect(view.wrapper.get('[data-testid="task-skill-refresh"]').attributes("disabled")).toBe("");
      await view.wrapper.get('[data-testid="task-skill-refresh"]').trigger("click"); await flush();
      expect(view.wrapper.text()).toContain("命令结果待核对");
      expect(bodies).toHaveLength(1);
      expect(view.wrapper.get('[data-testid="assist-session-select"]').attributes("disabled")).toBe("");
      await view.router.push("/settings"); await flush();
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain("命令结果待核对");
      expect(document.querySelector('[data-testid="discard-draft-leave"]')).toBeNull();
      const keep = [...document.querySelectorAll("button")].find((button) => button.textContent === "保留并继续编辑");
      if (!keep) throw new Error("missing keep-current-session action");
      keep.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush();
      expect(view.wrapper.get('.assist-pending').text()).toContain(String(bodies[0].command_id));
    }
    expect(bodies[0]).toMatchObject({ expected_task_revision: "2", expected_acceptance_revision: "1",
      payload_hash: hash });
    await view.wrapper.get(".assist-pending .secondary-button:first-of-type").trigger("click"); await flush();
    expect(view.wrapper.text()).toContain("命令结果待核对");
    await view.wrapper.get(".assist-pending .secondary-button:last-child").trigger("click"); await flush();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(view.wrapper.text()).toContain("提案已接受；Task v3 / 验收 v2");
    expect(view.wrapper.get('[data-testid="task-skill-proposal"]').text()).toContain("ACCEPTED");
    if (pageKind === "definition") expect(view.wrapper.get('[data-testid="live-task-accepted-facts"]').text()).toContain("任务 v3");
    view.unmount();
  });

  it.each(["assist", "verification"])("%s 页 409 后保留原提案与服务端合并内容，禁止旧基线再次确认", async (pageKind) => {
    connect(); let stale = false;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === `${prefix}/tasks/${taskId}`) return response(stale ? task("3", "2") : task());
      if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "当前项目", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
      if (path === `${prefix}/assist-sessions`) return response({ items: [session()] });
      if (path === `${prefix}/skill-definitions`) return response({ items: [currentSkill("VERIFICATION_PLAN_CHANGE")] });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return response({ items: [sourceMessage("VERIFICATION_PLAN_CHANGE")] });
      if (path === `${prefix}/tasks/${taskId}/check-plan-preview`) return response({ task_id: taskId,
        status: "UNAVAILABLE", admission_available: false, reason_codes: ["TASK_NOT_READY_FOR_DELEGATE"],
        sources: { task_revision: "2", acceptance_revision: "1", rule_revision: "1",
          workflow_key: "markdown-deliverable", workflow_version: "1", rule_refs: [] },
        check_plan: null, check_plan_sha256: null, frozen_run_plan: false, executed: false });
      if (path === `${prefix}/assist-proposals`) return response({ items: [proposal("VERIFICATION_PLAN_CHANGE",
        stale ? "EXPIRED" : "PENDING")] });
      if (path === `${prefix}/assist-proposals/${proposalId}/accept` && init?.method === "POST") {
        stale = true;
        return response({ code: "REVISION_CONFLICT", detail: "stale",
          expected_revision: "2", actual_revision: "3" }, 409);
      }
      throw new Error(`unexpected request ${path}`);
    }));
    const view = await mountWorkbench(`/tasks/${taskId}?skill=${pageKind}`);
    if (pageKind === "verification") {
      const skillSelect = view.wrapper.get('[data-testid="assist-skill"]').element;
      if (!(skillSelect instanceof HTMLSelectElement)) throw new Error("Skill selector is not a select");
      expect(skillSelect.value).toBe("verification-plan@1.1.0");
    }
    await view.wrapper.get('[data-testid="task-proposal-actions"] button.primary-button').trigger("click");
    await view.wrapper.get('[data-testid="task-skill-accept"]').trigger("click"); await flush();
    expect(view.wrapper.text()).toContain("原提案仍保留供核对");
    expect(view.wrapper.text()).toContain("请重新生成提案");
    expect(view.wrapper.get('[data-testid="task-skill-proposal"]').text()).toContain("EXPIRED");
    expect(view.wrapper.get('[data-testid="task-skill-proposal"]').text()).toContain("服务端追加条件");
    expect(view.wrapper.find('[data-testid="task-skill-accept"]').exists()).toBe(false);
    view.unmount();
  });

  it("接受响应丢失但原回执存在时只核对同一 command_id，不再次写入", async () => {
    connect(); let postCount = 0; let commandId = "";
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === `${prefix}/tasks/${taskId}`) return response(task());
      if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "当前项目", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
      if (path === `${prefix}/assist-sessions`) return response({ items: [session()] });
      if (path === `${prefix}/skill-definitions`) return response({ items: [currentSkill("TASK_CONTRACT_CHANGE")] });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return response({ items: [sourceMessage("TASK_CONTRACT_CHANGE")] });
      if (path === `${prefix}/assist-proposals`) return response({ items: [proposal()] });
      if (path === `${prefix}/assist-proposals/${proposalId}/accept` && init?.method === "POST") {
        postCount++; commandId = (JSON.parse(String(init.body)) as { command_id: string }).command_id;
        throw new Error("response lost after commit");
      }
      if (path === `${prefix}/commands/${commandId}`) return response({ command_id: commandId,
        command_type: "AcceptAssistProposal", committed_at: "2026-09-26T00:00:00Z", result: result() });
      throw new Error(`unexpected request ${path}`);
    }));
    const view = await mountWorkbench(`/tasks/${taskId}?skill=assist`);
    await view.wrapper.get('[data-testid="task-proposal-actions"] button.primary-button').trigger("click");
    await view.wrapper.get('[data-testid="task-skill-accept"]').trigger("click"); await flush();
    expect(view.wrapper.text()).toContain("命令结果待核对");
    await view.wrapper.get(".assist-pending .secondary-button:first-of-type").trigger("click"); await flush();
    expect(postCount).toBe(1);
    expect(view.wrapper.text()).toContain("原命令回执已核对");
    expect(view.wrapper.find(".assist-pending").exists()).toBe(false);
    view.unmount();
  });

  it("失权 payload 不展示合并内容；旧 Verification v1.0 不能新调用，v1.1 可选", async () => {
    connect();
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const path = new URL(String(input)).pathname;
      if (path === `${prefix}/tasks/${taskId}`) return response(task());
      if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "当前项目", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
      if (path === `${prefix}/assist-sessions`) return response({ items: [session()] });
      if (path === `${prefix}/skill-definitions`) return response({ items: [
        { id: "task-to-execution-contract", version: "1.0.0", sha256: hash, title: "旧任务定义",
          target: "TASK", output_kind: "TASK_DEFINITION_SUGGESTION", availability: "CALLABLE_SUGGESTION_ONLY",
          call_supported: true, accept_supported: true, required_capabilities: [],
          missing_capabilities: [], dependencies: [] },
        { id: "task-to-execution-contract", version: "1.1.0", sha256: hash, title: "任务定义与结果",
          target: "TASK", output_kind: "TASK_DEFINITION_SUGGESTION", availability: "CALLABLE_SUGGESTION_ONLY",
          call_supported: true, accept_supported: true, required_capabilities: [],
          missing_capabilities: [], dependencies: [] },
        { id: "verification-plan", version: "1.0.0", sha256: hash, title: "旧验收方案",
          target: "TASK", output_kind: "VERIFICATION_PLAN_SUGGESTION", availability: "HISTORICAL_ONLY",
          call_supported: false, accept_supported: false, required_capabilities: [],
          missing_capabilities: [], dependencies: [] },
        { id: "verification-plan", version: "1.1.0", sha256: hash, title: "验收方案",
          target: "TASK", output_kind: "VERIFICATION_PLAN_SUGGESTION", availability: "CALLABLE_SUGGESTION_ONLY",
          call_supported: true, accept_supported: true, required_capabilities: [],
          missing_capabilities: [], dependencies: [] }] });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return response({ items: [{
        id: "66666666-6666-4666-8666-666666666666", session_id: sessionId, seq: "1",
        role: "ASSISTANT", status: "COMPLETED", intent: "DISCUSS", content: "原始正文",
        error_code: null, sources: [], provider_request_id: null,
        usage: { input_tokens: null, output_tokens: null }, cancel_requested: false,
        skill: { id: "verification-plan", version: "1.1.0", sha256: hash,
          definition_availability: "AVAILABLE", output_availability: "HISTORICAL_SNAPSHOT" },
        skill_input: {}, skill_output: { kind: "VERIFICATION_PLAN_SUGGESTION", status: "SUGGESTED",
          target_kind: "TASK", target_id: taskId, as_of: "2026-09-26T00:00:00Z",
          baseline: { task_id: taskId, task_revision: "2", acceptance_revision: "1" },
          basis_sha256: hash, payload_sha256: hash,
          payload: { summary: "建议说明", additional_checks: [{ statement: "模型新增检查",
            required: true, method: "CITATION_EXISTS" }], effective_check_plan: false } }
      }] });
      if (path === `${prefix}/tasks/${taskId}/check-plan-preview`) return response({ task_id: taskId,
        status: "UNAVAILABLE", admission_available: false, reason_codes: ["CHECKER_UNAVAILABLE"],
        sources: { task_revision: "2", acceptance_revision: "1", rule_revision: "1",
          workflow_key: "markdown-deliverable", workflow_version: "1", rule_refs: [] },
        check_plan: null, check_plan_sha256: null, frozen_run_plan: false, executed: false });
      if (path === `${prefix}/assist-proposals`) return response({ items: [proposal("VERIFICATION_PLAN_CHANGE", "PENDING", false)] });
      throw new Error(`unexpected request ${path}`);
    }));
    const view = await mountWorkbench(`/tasks/${taskId}?skill=assist`);
    const card = view.wrapper.get('[data-testid="task-skill-proposal"]');
    expect(card.text()).toContain("提案来源当前不可读");
    expect(card.text()).not.toContain("服务端追加条件");
    expect(card.find("button.primary-button").exists()).toBe(false);
    expect(view.wrapper.get('[data-testid="assist-skill-output"]').text()).toContain("模型新增检查");
    expect(view.wrapper.get('[data-testid="assist-skill-output"]').text()).toContain("CHECKER_UNAVAILABLE");
    expect(view.wrapper.get('[data-testid="assist-skill"] option[value="verification-plan@1.0.0"]').attributes("disabled")).toBe("");
    expect(view.wrapper.get('[data-testid="assist-skill"] option[value="verification-plan@1.1.0"]').attributes("disabled")).toBeUndefined();
    expect(view.wrapper.get('[data-testid="assist-skill"]').findAll("option").map((option) =>
      option.attributes("value")).slice(1, 3)).toEqual([
      "task-to-execution-contract@1.1.0", "task-to-execution-contract@1.0.0"]);
    view.unmount();
  });

  it("重读 Task 失权时清除旧合并内容和确认动作", async () => {
    connect(); let readable = true;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const path = new URL(String(input)).pathname;
      if (path === `${prefix}/tasks/${taskId}`) return readable ? response(task()) :
        response({ code: "RESOURCE_NOT_FOUND", detail: "Task unavailable" }, 404);
      if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "当前项目", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
      if (path === `${prefix}/assist-sessions`) return response({ items: [session()] });
      if (path === `${prefix}/skill-definitions`) return response({ items: [currentSkill("TASK_CONTRACT_CHANGE")] });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return response({ items: [] });
      if (path === `${prefix}/assist-proposals`) return response({ items: [proposal()] });
      throw new Error(`unexpected request ${path}`);
    }));
    const view = await mountWorkbench(`/tasks/${taskId}?skill=assist`);
    const card = view.wrapper.get('[data-testid="task-skill-proposal"]');
    expect(card.text()).toContain("服务端追加条件");
    expect(card.find("button.primary-button").exists()).toBe(true);
    readable = false;
    await card.get("button.secondary-button").trigger("click"); await flush();
    expect(card.text()).toContain("合并内容已隐藏");
    expect(card.text()).not.toContain("服务端追加条件");
    expect(card.find("button.primary-button").exists()).toBe(false);
    view.unmount();
  });
});
