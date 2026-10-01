import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const sessionId = "44444444-4444-4444-8444-444444444444";
const sourceId = "55555555-5555-4555-8555-555555555555";
const prefix = `/api/v1/workspaces/${workspaceId}`;

function response(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}
function skill(id: string, target: "PROJECT" | "TASK", outputKind: string,
  availability: string, missing: string[] = []) {
  return { id, version: "1.0.0", sha256: "a".repeat(64), title: id,
    target, output_kind: outputKind, availability, required_capabilities: [],
    missing_capabilities: missing, call_supported: true, accept_supported: target === "TASK",
    dependencies: [{ kind: "CONTEXT_PROFILE", id: "assist-explicit-sources",
      version: "1.0.0", sha256: "b".repeat(64) }] };
}
function task() {
  return { id: taskId, project_id: projectId, title: "真实任务", status: "READY", mode: "ME",
    revision: "2", executor: { kind: "HUMAN", run_id: null, ownership_epoch: "0" },
    current_completion_id: null, waiting_reason: null, blocking_task_ids: [],
    unresolved_blocker_ids: [], allowed_actions: [],
    acceptance: { acceptance_revision: "1", objective: "旧目标",
      expected_outputs: { kind: "MARKDOWN_DOCUMENT" }, source: "CREATE", criteria: [] },
    dependencies: [] };
}
function session(kind: "PROJECT" | "TASK") {
  return { id: sessionId, workspace_id: workspaceId, project_id: projectId,
    task_id: kind === "TASK" ? taskId : null, title: "会话", status: "ACTIVE", revision: "1",
    updated_at: "2026-09-26T00:00:00Z" };
}
function message(id: string, role: "USER" | "ASSISTANT", content: string | null,
  extra: Record<string, unknown> = {}) {
  return { id, session_id: sessionId, seq: "1", role, status: "COMPLETED", intent: "DISCUSS",
    content, error_code: null, sources: [], usage: { input_tokens: null, output_tokens: null },
    cancel_requested: false, ...extra };
}

afterEach(() => { resetRelayConnectionForTest(); vi.unstubAllGlobals(); });

describe("M04 第一方 Skill 与 Pack", () => {
  it("注册表不可读时普通 Assist 仍按原意图发送", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    let sent: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "真实项目",
        project_type: "GENERAL", revision: "2", state_revision: "1", archived_at: null });
      if (path === `${prefix}/assist-sessions`) return response({ items: [session("PROJECT")] });
      if (path === `${prefix}/skill-definitions`) return response({ code: "SERVICE_UNAVAILABLE", detail: "暂不可读" }, 503);
      if (path === `${prefix}/assist-sessions/${sessionId}/messages` && init?.method !== "POST") return response({ items: [] });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages` && init?.method === "POST") {
        sent = JSON.parse(String(init.body)) as Record<string, unknown>;
        return response({ command_id: sent.command_id, committed_at: "2026-09-26T00:00:00Z",
          result: { session_id: sessionId, user_message_id: "66666666-6666-4666-8666-666666666666",
            assistant_message_id: "77777777-7777-4777-8777-777777777777" } }, 202);
      }
      if (path === `${prefix}/assist-proposals`) return response({ items: [] });
      throw new Error(`unexpected request ${path}`);
    }));
    const view = await mountWorkbench(`/projects/${projectId}?skill=assist`);
    expect(view.wrapper.text()).toContain("普通 Assist 仍可用");
    await view.wrapper.get('[data-testid="assist-draft"]').setValue("照常讨论");
    await view.wrapper.get('[data-testid="assist-send"]').trigger("click"); await flush();
    expect(sent).toMatchObject({ content: "照常讨论", intent: "DISCUSS" });
    expect(sent).not.toHaveProperty("skill_ref");
    view.unmount();
  });

  it("任务显式选择 Skill，原命令重试保持 skill_ref/skill_input，输出只读且无 Apply", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    const attempts: Record<string, unknown>[] = [];
    let messages: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === `${prefix}/tasks/${taskId}`) return response(task());
      if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "当前项目", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
      if (path === `${prefix}/assist-sessions`) return response({ items: [session("TASK")] });
      if (path === `${prefix}/skill-definitions`) return response({ items: [
        skill("task-to-execution-contract", "TASK", "TASK_DEFINITION_SUGGESTION", "CALLABLE_SUGGESTION_ONLY"),
        skill("verification-plan", "TASK", "VERIFICATION_PLAN_SUGGESTION", "CALLABLE_SUGGESTION_ONLY", ["MISSING"]),
        skill("project-resume", "PROJECT", "PROJECT_RESUME", "CALLABLE_READ_ONLY")
      ] });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages` && init?.method !== "POST") return response({ items: messages });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages` && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        attempts.push(body);
        if (attempts.length === 1) throw new Error("response lost");
        messages = [message("66666666-6666-4666-8666-666666666666", "USER", "请建议任务定义"),
          message("77777777-7777-4777-8777-777777777777", "ASSISTANT", "原始 JSON 不应直接显示", {
            skill: { ...skill("task-to-execution-contract", "TASK", "TASK_DEFINITION_SUGGESTION", "CALLABLE_SUGGESTION_ONLY"),
              definition_availability: "AVAILABLE", output_availability: "HISTORICAL_SNAPSHOT" },
            skill_input: { desired_result: "完成说明" },
            skill_output: { kind: "TASK_DEFINITION_SUGGESTION", status: "SUGGESTED",
              target_kind: "TASK", target_id: taskId, as_of: "2026-09-26T00:00:00Z",
              baseline: { task_id: taskId, task_revision: "2", acceptance_revision: "1", project_id: projectId },
              basis_sha256: "c".repeat(64), payload_sha256: "d".repeat(64), payload: {
                summary: "建议摘要", objective: "建议目标", expected_outputs: { kind: "MARKDOWN_DOCUMENT" },
                criteria: [{ statement: "可复核", required: true, method: "HUMAN" }], suggested_mode: "ME" } }
          })];
        return response({ command_id: body.command_id, committed_at: "2026-09-26T00:00:00Z",
          result: { session_id: sessionId, user_message_id: "66666666-6666-4666-8666-666666666666",
            assistant_message_id: "77777777-7777-4777-8777-777777777777" } }, 202);
      }
      if (path === `${prefix}/assist-proposals`) return response({ items: [] });
      throw new Error(`unexpected request ${path}`);
    }));
    const view = await mountWorkbench(`/tasks/${taskId}?skill=assist`);
    expect(view.wrapper.get('[data-testid="assist-skill"]').text()).not.toContain("project-resume");
    expect(view.wrapper.get('[data-testid="assist-skill"] option[value="verification-plan@1.0.0"]').attributes("disabled")).toBe("");
    await view.wrapper.get('[data-testid="assist-skill"]').setValue("task-to-execution-contract@1.0.0");
    await view.wrapper.get('[data-testid="assist-skill-input"]').setValue("完成说明");
    await view.wrapper.get('[data-testid="assist-draft"]').setValue("请建议任务定义");
    expect(view.wrapper.get('[data-testid="assist-send"]').text()).toBe("运行 task-to-execution-contract");
    await view.wrapper.get('[data-testid="assist-send"]').trigger("click");
    await flush();
    expect(view.wrapper.text()).toContain("命令结果待核对");
    expect(view.wrapper.get('[data-testid="assist-send"]').text()).toBe("运行 task-to-execution-contract");
    await view.wrapper.get(".assist-pending .secondary-button:last-child").trigger("click");
    await flush();
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(attempts[0]).toMatchObject({ content: "请建议任务定义",
      skill_ref: { id: "task-to-execution-contract", version: "1.0.0" },
      skill_input: { desired_result: "完成说明" } });
    expect(attempts[0]).not.toHaveProperty("intent");
    expect(view.wrapper.get('[data-testid="assist-skill-output"]').text()).toContain("建议目标");
    expect(view.wrapper.get(".assist-skill-summary > p").text()).toContain("建议");
    expect(view.wrapper.get(".assist-skill-details").attributes("open")).toBeUndefined();
    expect(view.wrapper.get('[data-testid="assist-task-diff-status"]').text()).toContain("基线与当前 Task/验收版本一致");
    expect(view.wrapper.get('[data-testid="assist-skill-output"]').text()).toContain("当前验收：旧目标");
    expect(view.wrapper.get('[data-testid="assist-skill-output"]').text()).toContain("当前验收：MARKDOWN_DOCUMENT");
    expect(view.wrapper.text()).not.toContain("原始 JSON 不应直接显示");
    expect(view.wrapper.text()).not.toContain("接受此提案");
    view.unmount();
  });

  it("任务建议只对确切基线做字段 Diff，revision 变化标过期，404 清除旧事实", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    let readMode: "current" | "stale" | "notFound" = "current";
    let baselineTaskId = taskId;
    let taskReads = 0;
    const currentTask = { ...task(), acceptance: { ...task().acceptance,
      criteria: [{ criterion_id: "old-required", statement: "保留条件", required: true, method: "HUMAN" }] } };
    const staleTask = { ...currentTask, revision: "3", mode: "DELEGATE_AI",
      acceptance: { ...currentTask.acceptance, acceptance_revision: "2", objective: "已修改目标" } };
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const path = new URL(String(input)).pathname;
      if (path === `${prefix}/tasks/${taskId}`) { taskReads++; return readMode === "notFound"
        ? response({ code: "RESOURCE_NOT_FOUND", detail: "Task unavailable" }, 404)
        : response(readMode === "stale" ? staleTask : currentTask); }
      if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "当前项目", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
      if (path === `${prefix}/assist-sessions`) return response({ items: [session("TASK")] });
      if (path === `${prefix}/skill-definitions`) return response({ items: [] });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return response({ items: [
        message("77777777-7777-4777-8777-777777777777", "ASSISTANT", "原始正文", {
          skill: { ...skill("task-to-execution-contract", "TASK", "TASK_DEFINITION_SUGGESTION", "CALLABLE_SUGGESTION_ONLY"),
            definition_availability: "AVAILABLE", output_availability: "HISTORICAL_SNAPSHOT" },
          skill_input: {}, skill_output: { kind: "TASK_DEFINITION_SUGGESTION", status: "SUGGESTED",
            target_kind: "TASK", target_id: taskId, as_of: "2026-09-26T00:00:00Z",
            baseline: { task_id: baselineTaskId, project_id: projectId, task_revision: "2", acceptance_revision: "1" },
            basis_sha256: "c".repeat(64), payload_sha256: "d".repeat(64),
            payload: { summary: "字段建议", objective: "建议目标",
              expected_outputs: { kind: "MARKDOWN_DOCUMENT" }, suggested_mode: "ME",
              criteria: [{ statement: "建议条件", required: true, method: "HUMAN" }] } }
        })] });
      if (path === `${prefix}/assist-proposals`) return response({ items: [] });
      throw new Error(`unexpected request ${path}`);
    }));
    const view = await mountWorkbench(`/tasks/${taskId}?skill=assist`);
    const diff = view.wrapper.get('[data-testid="assist-skill-output"]');
    expect(diff.text()).toContain("当前条件中未被建议逐字重复");
    expect(diff.text()).toContain("保留条件");
    expect(diff.text()).toContain("建议条件中未与当前字段完全相同");
    expect(diff.text()).toContain("实际合并结果须以后端 Task Owner 的预览为准");
    readMode = "stale";
    await diff.get("button").trigger("click"); await flush();
    expect(diff.get('[data-testid="assist-task-diff-status"]').text()).toContain("基线已过期");
    expect(diff.text()).toContain("已修改目标");
    readMode = "notFound";
    await diff.get("button").trigger("click"); await flush();
    expect(diff.text()).toContain("当前 Task 不可读取");
    expect(diff.text()).not.toContain("已修改目标");
    expect(diff.text()).not.toContain("建议目标");
    const readsBeforeInvalidBaseline = taskReads;
    baselineTaskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await view.wrapper.get('[data-testid="assist-refresh"]').trigger("click"); await flush();
    expect(diff.text()).toContain("基线与当前会话不一致");
    expect(taskReads).toBe(readsBeforeInvalidBaseline);
    view.unmount();
  });

  it("项目只读速览来源可跳转，失效来源与旧普通消息保持事实边界", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    let messages: unknown[] = [message("66666666-6666-4666-8666-666666666666", "ASSISTANT", "旧普通回复")];
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const path = new URL(String(input)).pathname;
      if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "真实项目",
        project_type: "GENERAL", revision: "2", state_revision: "1", archived_at: null });
      if (path === `${prefix}/assist-sessions`) return response({ items: [session("PROJECT")] });
      if (path === `${prefix}/skill-definitions`) return response({ items: [
        skill("project-resume", "PROJECT", "PROJECT_RESUME", "CALLABLE_READ_ONLY") ] });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return response({ items: messages });
      if (path === `${prefix}/assist-proposals`) return response({ items: [] });
      throw new Error(`unexpected request ${path}`);
    }));
    const view = await mountWorkbench(`/projects/${projectId}?skill=assist`);
    expect(view.wrapper.text()).toContain("旧普通回复");
    messages = [message("77777777-7777-4777-8777-777777777777", "ASSISTANT", "隐藏正文", {
      skill: { id: "project-resume", version: "1.0.0", sha256: "a".repeat(64),
        definition_availability: "AVAILABLE", output_availability: "HISTORICAL_SNAPSHOT" },
      skill_input: { focus: "任务" }, sources: [{ kind: "KNOWLEDGE", root_id: sourceId,
        version: "1", source_ref: `knowledge:${sourceId}:v1`, status: "AVAILABLE" }],
      skill_output: { kind: "PROJECT_RESUME", status: "READ_ONLY", target_kind: "PROJECT",
        target_id: projectId, as_of: "2026-09-26T00:00:00Z", baseline: { project_id: projectId,
          project_revision: "2" }, basis_sha256: "c".repeat(64), payload_sha256: "d".repeat(64),
        payload: { summary: "当前速览", highlights: [{ statement: "当前任务", ref_kind: "TASK", ref_id: taskId }],
          next_steps: ["人工核对"], comparison_baseline: null, read_only: true } }
    })];
    await view.wrapper.get('[data-testid="assist-refresh"]').trigger("click"); await flush();
    expect(view.wrapper.get('[data-testid="assist-skill-output"]').text()).toContain("当前速览");
    expect(view.wrapper.get('[data-testid="assist-skill-output"] .assist-skill-details').attributes("open")).toBeUndefined();
    expect(view.wrapper.get('[data-testid="assist-skill-output"]').text()).toContain("不是 Today 判定的合格 Task");
    expect(view.wrapper.find(`a[href="/tasks/${taskId}"]`).exists()).toBe(true);
    expect(view.wrapper.find(`a[href="/knowledge?kind=KNOWLEDGE&item=${sourceId}"]`).exists()).toBe(true);
    messages = [message("77777777-7777-4777-8777-777777777777", "ASSISTANT", null, {
      skill: { id: "project-resume", version: "1.0.0", sha256: "a".repeat(64),
        definition_availability: "AVAILABLE", output_availability: "UNAVAILABLE" },
      skill_input: { focus: "任务" }, skill_output: null,
      sources: [{ kind: "KNOWLEDGE", status: "UNAVAILABLE" }] })];
    await view.wrapper.get('[data-testid="assist-refresh"]').trigger("click"); await flush();
    expect(view.wrapper.text()).toContain("Skill 输出当前不可读取");
    expect(view.wrapper.text()).toContain("来源不可用");
    expect(view.wrapper.text()).not.toContain(sourceId);
    expect(view.wrapper.find('[data-testid="assist-skill-output"]').exists()).toBe(false);
    view.unmount();
  });

  it("冻结旧 Skill 定义仅作历史读取，不混入当前可调用版本", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    const current = skill("project-resume", "PROJECT", "PROJECT_RESUME", "CALLABLE_READ_ONLY");
    const historical = { ...current, version: "0.9.0", sha256: "f".repeat(64),
      definition_availability: "HISTORICAL_ONLY", output_availability: "HISTORICAL_SNAPSHOT" };
    const pending = { ...current, definition_availability: "AVAILABLE", output_availability: "PENDING" };
    const noOutput = { ...current, definition_availability: "AVAILABLE", output_availability: "NO_OUTPUT" };
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const path = new URL(String(input)).pathname;
      if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "真实项目",
        project_type: "GENERAL", revision: "2", state_revision: "1", archived_at: null });
      if (path === `${prefix}/assist-sessions`) return response({ items: [session("PROJECT")] });
      if (path === `${prefix}/skill-definitions`) return response({ items: [current] });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return response({ items: [
        message("77777777-7777-4777-8777-777777777777", "ASSISTANT", "冻结 JSON 正文", {
          skill: historical, skill_input: { focus: "旧问题" },
          skill_output: { kind: "PROJECT_RESUME", status: "READ_ONLY", target_kind: "PROJECT",
            target_id: projectId, as_of: "2026-09-25T00:00:00Z", baseline: { project_id: projectId,
              project_revision: "1" }, basis_sha256: "c".repeat(64), payload_sha256: "d".repeat(64),
            payload: { summary: "旧版冻结摘要", highlights: [], next_steps: ["核对当前事实"],
              comparison_baseline: null, read_only: true } }
        }),
        { ...message("88888888-8888-4888-8888-888888888888", "ASSISTANT", null,
          { skill: pending, skill_input: {}, skill_output: null }), status: "PENDING" },
        { ...message("99999999-9999-4999-8999-999999999999", "ASSISTANT", null,
          { skill: noOutput, skill_input: {}, skill_output: null, error_code: "SKILL_DEFINITION_UNAVAILABLE" }),
          status: "FAILED" }
      ] });
      if (path === `${prefix}/assist-proposals`) return response({ items: [] });
      throw new Error(`unexpected request ${path}`);
    }));
    const view = await mountWorkbench(`/projects/${projectId}?skill=assist`);
    expect(view.wrapper.text()).toContain("冻结历史定义仅可查阅");
    expect(view.wrapper.text()).toContain("不会以新版替换历史来源");
    expect(view.wrapper.text()).toContain("旧版冻结摘要");
    expect(view.wrapper.text()).toContain("f".repeat(64));
    expect(view.wrapper.text()).not.toContain("冻结 JSON 正文");
    expect(view.wrapper.get('[data-testid="assist-skill"]').find('option[value="project-resume@0.9.0"]').exists()).toBe(false);
    expect(view.wrapper.get('[data-testid="assist-skill"]').find('option[value="project-resume@1.0.0"]').exists()).toBe(true);
    expect(view.wrapper.findAll('[data-testid="assist-skill-output"]')).toHaveLength(1);
    expect(view.wrapper.text()).toContain("等待生成");
    expect(view.wrapper.text()).toContain("SKILL_DEFINITION_UNAVAILABLE");
    expect(view.wrapper.text()).not.toContain("接受此提案");
    view.unmount();
  });

  it("验收方案 Skill 只展示服务端检查映射与未生效状态", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const path = new URL(String(input)).pathname;
      if (path === `${prefix}/tasks/${taskId}`) return response(task());
      if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "当前项目", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
      if (path === `${prefix}/assist-sessions`) return response({ items: [session("TASK")] });
      if (path === `${prefix}/skill-definitions`) return response({ items: [
        skill("verification-plan", "TASK", "VERIFICATION_PLAN_SUGGESTION", "CALLABLE_SUGGESTION_ONLY") ] });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return response({ items: [
        message("77777777-7777-4777-8777-777777777777", "ASSISTANT", "原始输出", {
          skill: { ...skill("verification-plan", "TASK", "VERIFICATION_PLAN_SUGGESTION", "CALLABLE_SUGGESTION_ONLY"),
            definition_availability: "AVAILABLE", output_availability: "HISTORICAL_SNAPSHOT" },
          skill_input: { risk_focus: "引用" },
          skill_output: { kind: "VERIFICATION_PLAN_SUGGESTION", status: "SUGGESTED",
            target_kind: "TASK", target_id: taskId, as_of: "2026-09-26T00:00:00Z",
            baseline: { task_id: taskId, task_revision: "2", acceptance_revision: "1", project_id: projectId },
            basis_sha256: "c".repeat(64), payload_sha256: "d".repeat(64),
            payload: { summary: "检查建议", checks: [{ criterion_id: "c1", checker_id: "human-review",
              checker_version: "1.0.0", required: true }], effective_check_plan: false } }
        })] });
      if (path === `${prefix}/assist-proposals`) return response({ items: [] });
      if (path === `${prefix}/tasks/${taskId}/check-plan-preview`) return response({ task_id: taskId,
        status: "UNAVAILABLE", admission_available: false, reason_codes: ["TASK_NOT_READY_FOR_DELEGATE"],
        sources: { task_revision: "2", acceptance_revision: "1", rule_revision: "1",
          workflow_key: "markdown-deliverable", workflow_version: "1", rule_refs: [] },
        check_plan: null, check_plan_sha256: null, frozen_run_plan: false, executed: false });
      throw new Error(`unexpected request ${path}`);
    }));
    const view = await mountWorkbench(`/tasks/${taskId}?skill=assist`);
    expect(view.wrapper.get('[data-testid="assist-skill-output"]').text()).toContain("human-review v1.0.0");
    expect(view.wrapper.get('[data-testid="assist-skill-output"]').text()).toContain("历史输出只读");
    expect(view.wrapper.get('[data-testid="assist-skill-output"]').text()).toContain("建议本身不是有效计划或验证结果");
    expect(view.wrapper.text()).not.toContain("接受此提案");
    view.unmount();
  });

  it("设置和创建引导优先显示当前 Pack，历史版本只读且不写入或声明授权", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    const calls: string[] = [];
    const pack = (id: string, version: string, availability: string) => ({ id, version, sha256: "e".repeat(64),
      title: id, host_contract: "relay-v1", availability,
      members: [{ kind: "SKILL", id: "project-resume", version: "1.0.0",
        sha256: "a".repeat(64), target: "PROJECT", availability: "CALLABLE_READ_ONLY",
        required_capabilities: [], missing_capabilities: [], accept_supported: false }] });
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path === `${prefix}/packs`) return response({ items: [
        pack("thesis-minimal", "1.0.0", "HISTORICAL_ONLY"),
        pack("development-minimal", "1.0.0", "HISTORICAL_ONLY"),
        pack("thesis-minimal", "1.2.0", "AVAILABLE"),
        pack("development-minimal", "1.2.0", "AVAILABLE") ] });
      throw new Error(`unexpected request ${path}`);
    }));
    const view = await mountWorkbench("/settings");
    await view.wrapper.get('[data-testid="settings-group-workbench"]').trigger("click");
    expect(view.wrapper.get('[data-testid="pack-catalog"]').text()).toContain("thesis-minimal");
    expect(view.wrapper.get('[data-testid="pack-catalog"]').text()).toContain("development-minimal");
    expect(view.wrapper.get('[data-testid="pack-catalog"]').findAll("article")[0]?.text()).toContain("v1.2.0");
    expect(view.wrapper.get('[data-testid="pack-catalog"]').text()).toContain("不可新调用或接受");
    expect(view.wrapper.get('[data-testid="pack-catalog"]').text()).toContain("不会授权工具");
    expect(view.wrapper.get('[data-testid="pack-catalog"]').findAll("button")).toHaveLength(0);
    await view.router.push("/projects?view=create"); await flush();
    expect(view.wrapper.get('[data-testid="pack-catalog"]').text()).toContain("thesis-minimal");
    expect(calls.every((call) => call.startsWith("GET "))).toBe(true);
    view.unmount();
  });
});
