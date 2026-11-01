import fs from "node:fs";
import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * ENG-OBS-02 P0-C：真实 Chromium 里的执行透明性验收。
 *
 * API 全部由 page.route 伪造（不连数据库、不调 Provider）；服务端事实由后端
 * PostgreSQL/HTTP 集成测试证明。本用例只证明界面消费同一份活动快照：
 *   * 默认是一条由服务端 phase 决定的状态句，不按时间自动切换；
 *   * 展开后能看到真实工具/模型/待办/子 Agent 记录；
 *   * 在途有界轮询，终态停止；长会话可补读更早消息；
 *   * 结果未知不使用成功色；窄窗口下过程区不撑破阅读列。
 */

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const assistantMessageId = "55555555-5555-4555-8555-555555555555";
const userMessageId = "c1111111-1111-4111-8111-111111111111";
const earlierUserMessageId = "c2222222-2222-4222-8222-222222222222";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = `http://127.0.0.1:${process.env.RELAY_E2E_PORT ?? "4173"}`;
const evidenceDir = "D:/Develop/Relay-Agent/tmp/ENG-OBS-02-execution-transparency/browser";

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}
async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(),
    body: JSON.stringify(body) });
}

const session = { id: sessionId, workspace_id: workspaceId, project_id: projectId, task_id: null,
  title: "关于Relay-Agent", status: "ACTIVE", revision: "1", conversation_mode: "AGENT",
  assistant_profile_id: null, working_resource_id: null,
  context: { project_goals: [], working_directory: null },
  created_at: "2026-11-01T08:00:00Z", updated_at: "2026-11-01T08:00:00Z" };

function userMessage(id: string, seq: string, content: string) {
  return { id, session_id: sessionId, seq, role: "USER", status: "COMPLETED",
    intent: "DISCUSS", content, error_code: null, provider_error_kind: null,
    sources: [], skill: null, cancel_requested: false, steer_requested: false,
    attachments: [], created_at: "2026-11-01T07:59:00Z", updated_at: "2026-11-01T07:59:00Z",
    usage: { input_tokens: null, output_tokens: null, cache_read_tokens: null,
      cache_creation_tokens: null }, usage_summary: null, generation_progress: null };
}

function assistantMessage(status: "PENDING" | "RUNNING" | "COMPLETED") {
  return { id: assistantMessageId, session_id: sessionId, seq: "2", role: "ASSISTANT",
    status, intent: "DISCUSS", content: status === "COMPLETED" ? "已完成这次读取。" : null,
    error_code: null, provider_error_kind: null, sources: [], skill: null,
    cancel_requested: false, steer_requested: false, attachments: [],
    created_at: "2026-11-01T08:00:00Z", updated_at: "2026-11-01T08:00:06Z",
    usage: { input_tokens: null, output_tokens: null, cache_read_tokens: null,
      cache_creation_tokens: null }, usage_summary: null, generation_progress: null };
}

function recovery(disposition: string, overrides: Record<string, unknown> = {}) {
  return { disposition, effective_outcome: null, operation_ref: null,
    operation_status: "PREPARED", invocation_status: null, effect_state: "NOT_APPLICABLE",
    reconcile_required: disposition === "UNRESOLVED_OPEN" ||
      disposition === "UNRESOLVED_UNKNOWN", reconciled: false, resolved_at: null,
    provenance: "LIVE", reason: disposition, ...overrides };
}

function activity(input: { id: string; kind: string; view: string; tone: string;
  terminal: boolean; toolName?: string; recovery?: Record<string, unknown> | null;
  delegationRole?: string }) {
  return { activity_id: input.id, kind: input.kind,
    state: { raw: input.view, view: input.view, tone: input.tone, terminal: input.terminal },
    started_at: "2026-11-01T08:00:02.000Z",
    ended_at: input.terminal ? "2026-11-01T08:00:05.000Z" : null,
    order: { message_seq: "2", round: 0, ordinal: 0, rank: 0 },
    refs: { model_call_id: null, tool_call_id: "t1", operation_id: null, invocation_id: null },
    wait: null, error: null,
    evidence: { result_available: false, result_digest: null, failure_kind: null,
      detail_visibility: "USER" },
    recovery: input.recovery ?? null,
    ...(input.toolName === undefined ? {} : { tool_name: input.toolName }),
    ...(input.delegationRole === undefined ? {} : { delegation_role: input.delegationRole }),
    facts: null };
}

function activityMessage(input: { status: "PENDING" | "RUNNING" | "COMPLETED";
  view: string; tone: string; detail: string; fingerprint: string;
  since: string | null; activities?: readonly unknown[]; gaps?: readonly unknown[] }) {
  const recorded = input.activities !== undefined && input.activities.length > 0;
  return { message_id: assistantMessageId, seq: "2", role: "ASSISTANT",
    status: input.status, intent: "DISCUSS", created_at: "2026-11-01T08:00:00Z",
    claimed_at: input.status === "PENDING" ? null : "2026-11-01T08:00:01Z",
    settled_at: input.status === "COMPLETED" ? "2026-11-01T08:00:06Z" : null,
    updated_at: "2026-11-01T08:00:06Z", cancel_requested: false,
    source_user_message_id: userMessageId, content_fingerprint: input.fingerprint,
    process_evidence: recorded ? "RECORDED" : "UNKNOWN",
    phase: { raw: input.status, view: input.view, tone: input.tone, since: input.since,
      detail: input.detail, wait: null },
    execution_request: null, run_summary: null, activities: input.activities,
    activity_counts: { model_calls: recorded ? 1 : 0,
      tool_calls: recorded ? (input.activities ?? []).length : 0,
      todo_writes: 0, delegations: recorded ? 1 : 0 },
    gaps: input.gaps ?? [] };
}

async function installRoutes(page: Page, state: {
  status: () => "PENDING" | "RUNNING" | "COMPLETED";
  activity: (detail: "summary" | "full") => Record<string, unknown>;
  historyHasMore: () => boolean;
  activityCalls: { count: number };
}) {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const query = new URL(request.url()).searchParams;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/projects/${projectId}`) return fulfillJson(route, { id: projectId,
      title: "Relay-Agent", project_type: "GENERAL", revision: "1", state_revision: "1",
      archived_at: null });
    if (path === `${prefix}/projects/${projectId}/state`) return fulfillJson(route, {
      project_id: projectId, revision: "1", phase_key: "GENERAL", next_action_task_id: null,
      selected_artifact_version_refs: [], completed_highlight_refs: [] });
    if (path === `${prefix}/model-port`) return fulfillJson(route, { provider: "fake",
      configured: false, model: null, base_url: null, max_call_tokens: 200000 });
    if (path === `${prefix}/default-working-directory`) return fulfillJson(route, {
      resource_id: null, canonical_root: null, display_name: null, write_tier: null,
      default_write_tier: null, status: "UNSET", reason: null, revision: "0" });
    if (path === `${prefix}/assist-sessions`) return fulfillJson(route, { items: [session] });
    if (path === `${prefix}/assist-sessions/${sessionId}`) return fulfillJson(route, session);
    if (path === `${prefix}/assist-sessions/${sessionId}/plans`)
      return fulfillJson(route, { latest: null, versions: [] });
    if (path === `${prefix}/assist-sessions/${sessionId}/goal`)
      return fulfillJson(route, { goal: null, rounds: [] });
    if (path === `${prefix}/assist-sessions/${sessionId}/activity`) {
      state.activityCalls.count += 1;
      const detail = query.get("detail") === "summary" ? "summary" : "full";
      const snapshot = state.activity(detail);
      return fulfillJson(route, { schema_version: 1, session,
        generated_at: "2026-11-01T08:00:07Z", snapshot_at: "2026-11-01T08:00:07Z",
        messages: [snapshot], next_before_seq: null, has_more: false });
    }
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) {
      const before = query.get("before_seq");
      const items = before === null
        ? [userMessage(userMessageId, "1", "这次为什么这么久？"),
          assistantMessage(state.status())]
        : [userMessage(earlierUserMessageId, "0", "更早的一条问题")];
      return fulfillJson(route, { items, has_more: state.historyHasMore(),
        next_before_seq: before === null && state.historyHasMore() ? "1" : null });
    }
    if (path.endsWith("/live-preview/events")) {
      await route.fulfill({ status: 502, headers: cors(), body: "" });
      return;
    }
    if (path.endsWith("/live-preview")) {
      return fulfillJson(route, { session_id: sessionId, message_id: assistantMessageId,
        status: state.status(), preview_revision: "0", preview_text: null,
        preview_truncated: false, preview_available: false, usage: null });
    }
    if (path.endsWith("/tool-calls")) return fulfillJson(route, { session_id: sessionId,
      message_id: assistantMessageId, message_status: state.status(), rounds: [] });
    if (path === `${prefix}/assist-sessions/${sessionId}/todos`)
      return fulfillJson(route, { snapshot: null });
    if (path.includes("conversation-diff")) return fulfillJson(route, { session_id: sessionId,
      files: [], unavailable_files: 0, unverifiable_files: 0, baseline: null,
      incomplete: false });
    if (/\/assist-messages\/[^/]+\/model-runtime$/u.test(path)) return fulfillJson(route, {
      message_id: assistantMessageId, message_status: "COMPLETED", snapshot_available: false,
      preferred_model: null, candidate_models: [], current_candidate_model: null,
      actual_model: null, max_candidates: null, routing_status: null, failure_scope: null,
      failure_reason: null, retry_after_at: null, free_daily_remaining: null, switches: [],
      calls: [] });
    return fulfillJson(route, { items: [], next_cursor: null });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("execution-activity-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" })
    .waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

function save(name: string): { path: string } {
  return { path: `${evidenceDir}/${name}.png` };
}

test.describe("执行透明性", () => {
  test("排队 → 执行工具 → 结果待核对：阶段由服务端快照推进，终态停止轮询", async ({ page }) => {
    fs.mkdirSync(evidenceDir, { recursive: true });
    await page.setViewportSize({ width: 1270, height: 900 });
    let status: "PENDING" | "RUNNING" | "COMPLETED" = "PENDING";
    const activityCalls = { count: 0 };
    let stage: "QUEUE" | "TOOL" | "UNKNOWN" | "DONE" = "QUEUE";
    await installRoutes(page, {
      status: () => status,
      activityCalls,
      historyHasMore: () => false,
      activity: (detail) => {
        if (stage === "QUEUE") return activityMessage({ status: "PENDING",
          view: "WAITING_WORKER", tone: "wait", detail: "已排队，等待执行",
          fingerprint: "f0", since: "2026-11-01T08:00:00Z" });
        if (stage === "TOOL") return activityMessage({ status: "RUNNING",
          view: "RUNNING_TOOL", tone: "active", detail: "正在执行工具",
          fingerprint: "f1", since: "2026-11-01T08:00:02Z",
          activities: detail === "summary" ? undefined : [
            activity({ id: "model-call:c1", kind: "MODEL_CALL", view: "RECEIVING_TEXT",
              tone: "active", terminal: false }),
            activity({ id: "tool-call:t1", kind: "TOOL_CALL", view: "PENDING",
              tone: "wait", terminal: false, toolName: "read_file",
              recovery: recovery("UNRESOLVED_OPEN") }),
            activity({ id: "delegation:d1", kind: "DELEGATION", view: "RUNNING",
              tone: "active", terminal: false, delegationRole: "INVESTIGATE" }),
          ] });
        if (stage === "UNKNOWN") return activityMessage({ status: "RUNNING",
          view: "WAITING_CONFIRMATION", tone: "wait", detail: "工具有结果待核对",
          fingerprint: "f2", since: "2026-11-01T08:00:05Z",
          gaps: [{ code: "UNRESOLVED_UNKNOWN" }],
          activities: detail === "summary" ? undefined : [
            activity({ id: "tool-call:t1", kind: "TOOL_CALL", view: "UNKNOWN",
              tone: "wait", terminal: true, toolName: "read_file",
              recovery: recovery("UNRESOLVED_UNKNOWN", { resolved_at: null }) }),
          ] });
        return activityMessage({ status: "COMPLETED", view: "COMPLETED", tone: "success",
          detail: "回复已完成", fingerprint: "f3", since: "2026-11-01T08:00:06Z",
          activities: detail === "summary" ? undefined : [
            activity({ id: "tool-call:t1", kind: "TOOL_CALL", view: "FAILED",
              tone: "error", terminal: true, toolName: "read_file",
              recovery: recovery("CONFIRMED_FAILURE", { effective_outcome: "FAILED",
                operation_status: "FAILED", reconcile_required: false }) }),
          ] });
      },
    });
    await page.goto(`/projects/${projectId}?skill=assist`);
    await connect(page);

    const statusLine = page.getByTestId("message-execution-status");
    await expect(statusLine).toHaveCount(1, { timeout: 30_000 });
    await expect(statusLine).toHaveAttribute("data-view", "WAITING_WORKER");
    await expect(statusLine).toContainText("已排队，等待执行");
    await page.screenshot(save("01-queued"));

    status = "RUNNING"; stage = "TOOL";
    await expect(statusLine).toHaveAttribute("data-view", "RUNNING_TOOL", { timeout: 10_000 });
    await expect(statusLine).toContainText("正在执行工具");
    await page.screenshot(save("02-tool-running"));
    await statusLine.locator("summary").click();
    const list = page.locator(".message-execution-status__list");
    await expect(list).toContainText("模型调用 · 正在接收回复");
    await expect(list).toContainText("read_file · 正在执行");
    await expect(list).toContainText("子 Agent · 调查 · 运行中");
    expect(await page.locator('[data-testid="message-execution-status"] .message-execution-status__elapsed').count())
      .toBe(1);
    await page.screenshot(save("03-expanded-process"));

    stage = "UNKNOWN";
    await expect(statusLine).toHaveAttribute("data-view", "WAITING_CONFIRMATION",
      { timeout: 10_000 });
    await expect(statusLine).toContainText("工具有结果待核对");
    await expect(statusLine).toContainText("1 项待核对");
    const toolRow = page.locator('.message-execution-status__list li[data-kind="TOOL_CALL"]');
    await expect(toolRow).toContainText("read_file · 结果待核对");
    await expect(toolRow).toHaveAttribute("data-tone", "wait");
    await page.screenshot(save("04-result-unknown"));

    status = "COMPLETED"; stage = "DONE";
    await expect(statusLine).toHaveAttribute("data-view", "COMPLETED", { timeout: 10_000 });
    await expect(statusLine).toContainText("回复已完成");
    const settledCount = activityCalls.count;
    await page.waitForTimeout(1_500);
    expect(activityCalls.count, "终态消息不应继续轮询活动").toBe(settledCount);
    await page.screenshot(save("05-completed"));

    // 窄窗口下过程区不撑破阅读列；长文本按 anywhere 折行。
    await page.setViewportSize({ width: 720, height: 900 });
    await page.waitForTimeout(200);
    const width = await page.locator(".message-execution-status").evaluate(
      (element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
    expect(width.scroll).toBeLessThanOrEqual(width.client + 1);
    await page.screenshot(save("06-narrow"));
  });

  test("长会话最新消息优先，可补读更早历史", async ({ page }) => {
    fs.mkdirSync(evidenceDir, { recursive: true });
    await page.setViewportSize({ width: 1270, height: 900 });
    const activityCalls = { count: 0 };
    await installRoutes(page, {
      status: () => "COMPLETED",
      activityCalls,
      historyHasMore: () => true,
      activity: () => activityMessage({ status: "COMPLETED", view: "COMPLETED",
        tone: "success", detail: "回复已完成", fingerprint: "f4",
        since: "2026-11-01T08:00:06Z", activities: [] }),
    });
    await page.goto(`/projects/${projectId}?skill=assist`);
    await connect(page);
    await expect(page.getByText("这次为什么这么久？")).toBeVisible({ timeout: 30_000 });
    const more = page.getByTestId("assist-history-more");
    await expect(more).toHaveCount(1);
    await more.click();
    await expect(page.getByText("更早的一条问题")).toBeVisible();
    await page.screenshot(save("07-history-page"));
  });
});
