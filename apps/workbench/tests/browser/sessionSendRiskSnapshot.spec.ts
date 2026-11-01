import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * 预检期间改动待发内容，不能用旧读数发送（P0-2，2026-10-31）。
 *
 * 已有会话这一侧只核对一件事：审计还在途中时改了正文，最终提交的必须是**被核验过的那一份**
 * （改后的正文），而不是点击发送那一刻的旧正文；旧读数作废后要重新取一次审计。
 */

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const sessionId = "66666666-6666-4666-8666-666666666666";
const resourceId = "99999999-9999-4999-8999-999999999999";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = `http://127.0.0.1:${process.env.RELAY_E2E_PORT ?? "4173"}`;

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(),
    body: JSON.stringify(body) });
}

function auditBody(): unknown {
  return { state: "OK", detail: "没有发现会进上下文的必读文件。",
    agent: { id: "relay", label: "Relay 内置 Agent" }, root: "D:\\Work\\Research",
    scanned_at: "2026-10-31T04:00:00.000Z", fingerprint: "fp-low", severity: "NONE",
    files: [],
    budget: { provider_window_tokens: 256_000, provider_window_known: true,
      call_budget_tokens: 256_000, call_budget_source: "SESSION",
      effective_input_tokens: 241_000, effective_basis: "PROVIDER_WINDOW",
      reserves: { output_tokens: 8_192, system_prompt_tokens: 2_000,
        tool_definition_tokens: 4_096, history_tokens: 0 },
      estimated_total_input_tokens: 14_288, required_total_tokens: 0,
      required_total_share: 0, confidence: "EXACT_WINDOW",
      estimate: { method: "ESTIMATED_UTF8_BYTES_DIV_3", bytes_per_token: 3, note: "估算" } },
    reasons: [], suggestions: [], skipped: [], access: null,
    thresholds: { single_file: { notice: 0.15, high: 0.30, severe: 0.50 },
      total_files: { notice: 0.30, high: 0.50, severe: 0.75 } } };
}

const session = { id: sessionId, workspace_id: workspaceId, project_id: projectId, task_id: taskId,
  title: "关于确定实验评价指标", status: "ACTIVE", revision: "1", conversation_mode: "AGENT",
  chat_mode: "CHAT", assistant_profile_id: null, assistant_profile_revision: null,
  remember: false, working_resource_id: resourceId, has_messages: true, run_state: null,
  list_state: "COMPLETED",
  context: { project_goals: [], working_directory: { resource_id: resourceId,
    canonical_root: "D:\\Work\\Research", source: "USER_PICKED" } },
  created_at: "2026-10-30T00:00:00Z", updated_at: "2026-10-30T00:00:00Z" };

async function install(page: Page, options: {
  readonly auditDelayMs: number }): Promise<{ messagePosts: number; lastContent: string | null;
    audits: number }> {
  const state = { messagePosts: 0, lastContent: null as string | null, audits: 0 };
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/default-working-directory`) return fulfillJson(route,
      { resource_id: null, canonical_root: null, display_name: null, write_tier: null,
        default_write_tier: null, context_budget_tokens: 262_144, status: "UNSET", reason: null,
        revision: "1" });
    if (path === `${prefix}/model-port`) return fulfillJson(route, { provider: "fake",
      configured: false, model: null, base_url: null, max_call_tokens: 262_144 });
    if (path === `${prefix}/model-port/verification`) return fulfillJson(route,
      { current_config_fingerprint: null, last: null, matches_current_config: false,
        worker_startup_validation: "NOT_CONFIGURED" });
    if (path === `${prefix}/memory-settings`) return fulfillJson(route, { workspace_id: workspaceId,
      revision: "0", recall_enabled: true, automatic_compaction: true, auto_capture: true });
    if (path === `${prefix}/tasks/${taskId}`) return fulfillJson(route, { id: taskId,
      project_id: projectId, title: "整理实验评价指标", status: "IN_PROGRESS", mode: "ME",
      revision: "2", created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z",
      executor: { kind: "HUMAN", run_id: null, ownership_epoch: "1" },
      current_completion_id: null, waiting_reason: null, blocking_task_ids: [],
      unresolved_blocker_ids: [], allowed_actions: [],
      acceptance: { acceptance_revision: "2", objective: "补齐基线与验收依据。", source: "CREATE",
        created_at: "2026-10-16T00:00:00Z", criteria: [] }, dependencies: [] });
    if (path === `${prefix}/projects/${projectId}`) return fulfillJson(route, { id: projectId,
      title: "Windows 桌面验收（测试）", project_type: "GENERAL", revision: "1",
      state_revision: "1", archived_at: null });
    if (path === `${prefix}/working-directories/${resourceId}/required-context-audit`) {
      state.audits += 1;
      // 审计慢到足以让用户在这段时间里改完正文。
      await new Promise((resolve) => setTimeout(resolve, options.auditDelayMs));
      return fulfillJson(route, auditBody());
    }
    if (path === `${prefix}/assist-sessions`) return fulfillJson(route, { items: [session] });
    if (path === `${prefix}/assist-sessions/${sessionId}`) return fulfillJson(route, session);
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) {
      if (request.method() !== "POST") return fulfillJson(route, { items: [] });
      state.messagePosts += 1;
      const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
      state.lastContent = typeof body.content === "string" ? body.content : null;
      return fulfillJson(route, { command_id: body.command_id, command_type: "RequestAssistMessage",
        replayed: false, committed_at: "2026-10-31T04:00:00Z",
        result: { session_id: sessionId, user_message_id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
          assistant_message_id: "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb",
          chat_mode: "CHAT", goal_id: null } }, 202);
    }
    return fulfillJson(route, { items: [], next_cursor: null });
  });
  return state;
}

test("审计途中改了正文：旧读数作废，提交的是被核验过的新正文", async ({ page }) => {
  const state = await install(page, { auditDelayMs: 900 });
  await page.goto(`/agent?work=${taskId}&session=${sessionId}`);
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("risk-snapshot-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" })
    .waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
  const draft = page.getByTestId("assist-draft");
  await draft.waitFor({ timeout: 20_000 });

  await draft.fill("第一版：整理评价指标");
  await page.getByTestId("assist-send").click();
  // 审计还在途中：这时改正文，旧读数就不再代表这一次发送。
  await draft.fill("第二版：整理评价指标并补一列基线");
  await expect.poll(() => state.messagePosts, { timeout: 20_000 }).toBe(1);
  expect(state.lastContent).toBe("第二版：整理评价指标并补一列基线");
  // 两次审计：第一次的读数被丢弃，第二次按改后的正文重新取。
  expect(state.audits).toBeGreaterThanOrEqual(2);
  await page.waitForTimeout(400);
  expect(state.messagePosts).toBe(1);
});
