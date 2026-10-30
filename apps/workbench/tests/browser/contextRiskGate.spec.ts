import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * 发送前风险确认（P0-B，2026-10-30）在真实 Chromium 里真的挡住了发送。
 *
 * 只连页面内夹具：不连数据库、不调 Provider、不写任何真实业务事实。核对的是行为事实：
 *   · 命中新风险时出现卡外确认条，且**命令还没产生**（没有任何 POST 到 messages）；
 *   · 取消 = 真取消：草稿还在、仍然没有 POST；
 *   · 再次发送仍会拦（没确认过就不能脑着发）；确认后才真的发出去。
 */

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const sessionId = "66666666-6666-4666-8666-666666666666";
const resourceId = "99999999-9999-4999-8999-999999999999";
const connectionId = "88888888-8888-4888-8888-888888888888";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = "http://127.0.0.1:4173";

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(),
    body: JSON.stringify(body) });
}

const session = { id: sessionId, workspace_id: workspaceId, project_id: projectId, task_id: taskId,
  title: "关于确定实验评价指标", status: "ACTIVE", revision: "1",
  working_resource_id: resourceId,
  context: { project_goals: [], working_directory: {
    resource_id: resourceId, canonical_root: "D:\\Work\\Research" } },
  created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z" };

function auditBody(): unknown {
  return {
    state: "OK",
    detail: "1 份必读文件已计入预计加载量。",
    agent: { id: "relay", label: "Relay 内置 Agent" },
    root: "D:\\Work\\Research",
    scanned_at: "2026-10-30T04:00:00.000Z",
    fingerprint: "fp-severe-gate",
    severity: "SEVERE",
    files: [{ path: "AGENTS.md", category: "TASK_REQUIRED", scope: "ROOT",
      reason: "项目规则入口：会话按项目约定在首轮完整读取。", bytes: 540_000,
      estimated_tokens: 180_000, modified_at: "2026-10-30T03:59:00.000Z",
      share: 0.78, severity: "SEVERE" }],
    budget: { provider_window_tokens: 256_000, provider_window_known: true,
      call_budget_tokens: 256_000, call_budget_source: "WORKSPACE_TIER",
      effective_input_tokens: 231_000, effective_basis: "PROVIDER_WINDOW",
      reserves: { output_tokens: 8_192, system_prompt_tokens: 2_000,
        tool_definition_tokens: 4_096, history_tokens: 0 },
      estimated_total_input_tokens: 189_688, required_total_tokens: 180_000,
      required_total_share: 0.78, confidence: "EXACT_WINDOW",
      estimate: { method: "ESTIMATED_UTF8_BYTES_DIV_3", bytes_per_token: 3,
        note: "按 UTF-8 字节数 ÷ 3 估算，与上下文构建、模型端口的预算口径一致。" } },
    reasons: [{ code: "SINGLE_FILE_SEVERE", text: "AGENTS.md 预计占有效输入预算的 78%",
      ratio: 0.78, path: "AGENTS.md" }],
    suggestions: [{ code: "SPLIT_ENTRY", text: "把大型入口文件拆成两段：入口只留导航与硬约束。" }],
    skipped: [],
    access: { project_id: projectId, connection_id: connectionId },
    thresholds: { single_file: { notice: 0.15, high: 0.30, severe: 0.50 },
      total_files: { notice: 0.30, high: 0.50, severe: 0.75 } },
  };
}

interface GateState { posts: number }

async function installRoutes(page: Page): Promise<GateState> {
  const state: GateState = { posts: 0 };
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/default-working-directory`) return fulfillJson(route,
      { resource_id: null, canonical_root: null, display_name: null, write_tier: null,
        default_write_tier: null, context_budget_tokens: 262_144, status: "UNSET", reason: null,
        revision: "2" });
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
    if (path === `${prefix}/working-directories/${resourceId}/work-context`) return fulfillJson(route,
      { kind: "DIRECTORY", directory: { id: resourceId, canonical_root: "D:////Work////Research",
        status: "ACTIVE", revision: "1", project: { id: projectId, title: "Windows 桌面验收（测试）",
          project_type: "GENERAL", archive_status: "ACTIVE", archived_at: null, revision: "1" } },
        linked_goals: [], sessions: [] });
    if (path === `${prefix}/working-directories/${resourceId}/required-context-audit`) {
      return fulfillJson(route, auditBody());
    }
    if (path === `${prefix}/search`) return fulfillJson(route, { items: [], next_cursor: null });
    if (path === `${prefix}/skill-definitions`) return fulfillJson(route, { items: [] });
    if (path === `${prefix}/assist-sessions`) {
      return fulfillJson(route, request.method() === "POST" ? session : { items: [session] });
    }
    if (path === `${prefix}/assist-sessions/${sessionId}`) return fulfillJson(route, session);
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) {
      if (request.method() === "POST") { state.posts += 1; return fulfillJson(route, { id: sessionId,
        session_id: sessionId, seq: 1, role: "USER", status: "PENDING", revision: "1",
        content: request.postDataJSON()?.content ?? "", created_at: "2026-10-30T04:00:00Z" }, 202); }
      return fulfillJson(route, { items: [] });
    }
    return fulfillJson(route, { items: [], next_cursor: null });
  });
  return state;
}

async function openSession(page: Page): Promise<void> {
  await page.goto(`/agent?work=${taskId}&session=${sessionId}`);
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("required-context-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" })
    .waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
  await page.getByTestId("assist-composer").waitFor({ timeout: 20_000 });
}

test("高风险：确认条先拦住，取消不发送、确认才发送", async ({ page }) => {
  await page.setViewportSize({ width: 1162, height: 782 });
  const state = await installRoutes(page);
  await openSession(page);
  const input = page.locator('[data-testid="assist-composer"] textarea').first();
  await input.fill("帮我把实验评价指标整理成表格");

  await page.getByTestId("assist-send").click();
  const gate = page.getByTestId("context-risk-gate");
  await gate.waitFor({ timeout: 20_000 });
  await expect(gate).toHaveAttribute("data-severity", "SEVERE");
  // 关键：确认之前命令与正文都没有发出去。
  await page.waitForTimeout(600);
  expect(state.posts).toBe(0);
  // 提示在卡外：不能被塞进输入卡里。
  expect(await page.evaluate(() => {
    const card = document.querySelector('[data-testid="assist-composer"]');
    const gateEl = document.querySelector('[data-testid="context-risk-gate"]');
    if (card === null || gateEl === null) return false;
    return !card.contains(gateEl);
  })).toBe(true);

  await page.getByTestId("context-risk-gate-cancel").click();
  await expect(gate).toHaveCount(0);
  await page.waitForTimeout(400);
  expect(state.posts).toBe(0);
  expect(await input.inputValue()).toBe("帮我把实验评价指标整理成表格");

  // 没确认过就要再拦一次：不能靠一点就永久放行。
  await page.getByTestId("assist-send").click();
  await gate.waitFor({ timeout: 20_000 });
  await page.getByTestId("context-risk-gate-continue").click();
  await expect.poll(() => state.posts, { timeout: 20_000 }).toBeGreaterThan(0);
});