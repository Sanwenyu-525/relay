import { expect, test, type Page, type Route } from "@playwright/test";
import fs from "node:fs";

/**
 * Agent 回复实时 Token 读数的浏览器验收（AGENT_LIVE_TOKEN_USAGE，2026-11-01）。
 *
 * 这里量的是**画出来是什么样**：生成中数字随预览帧变化、状态符号正确、次级信息的
 * 字色/字号/等宽数字成立、没有底框与投影、窄窗不溢出；完成态改读账本汇总。
 * API 全部由 page.route 伪造（不连数据库、不调 Provider、不写业务事实）；真实后端
 * 链路与账本去重由 `apps/api` 的真实 PG 集成套件取证，两者分别报告。
 *
 * 证据落在 tmp/AGENT-LIVE-TOKEN-USAGE/screenshots/。
 */

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const sessionId = "66666666-6666-4666-8666-666666666666";
const userMessageId = "c1111111-1111-4111-8111-111111111111";
const assistantMessageId = "c2222222-2222-4222-8222-222222222222";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = `http://127.0.0.1:${process.env.RELAY_E2E_PORT ?? "4173"}`;
const shotsDir = "D:/Develop/Relay-Agent/tmp/AGENT-LIVE-TOKEN-USAGE/screenshots";

type UsageState = "ESTIMATED" | "PARTIAL" | "CONFIRMED" | "UNKNOWN";
type Phase = "running" | "settled";

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(),
    body: JSON.stringify(body) });
}

function usage(state: UsageState, input: number | null, output: number | null,
  patch: { settled?: number; pending?: number; missing?: number } = {}) {
  return { state, input_tokens: input, output_tokens: output,
    cache_read_tokens: null, cache_creation_tokens: null,
    settled_calls: patch.settled ?? 0, pending_calls: patch.pending ?? 0,
    missing_usage_calls: patch.missing ?? 0 };
}

const session = { id: sessionId, workspace_id: workspaceId, project_id: projectId, task_id: null,
  title: "Token 用量", status: "ACTIVE", revision: "1", conversation_mode: "AGENT",
  assistant_profile_id: null, working_resource_id: null,
  context: { project_goals: [], working_directory: null },
  created_at: "2026-11-01T09:00:00Z", updated_at: "2026-11-01T09:00:00Z" };

function message(phase: Phase) {
  return { id: assistantMessageId, session_id: sessionId, seq: "2", role: "ASSISTANT",
    status: phase === "settled" ? "COMPLETED" : "RUNNING", intent: "DISCUSS",
    content: phase === "settled" ? "## 结论\n\n这一轮已经完成，读数来自模型调用账本。" : null,
    error_code: null, provider_error_kind: null, sources: [], skill: null,
    steer_requested: false, attachments: [], withdrawn_at: null, withdrawn_by_recall_id: null,
    recall: null, created_at: "2026-11-01T09:00:00Z", updated_at: "2026-11-01T09:00:05Z",
    // 完成态故意让旧 usage 与账本汇总不同：界面必须读 usage_summary。
    usage: { input_tokens: 1_000, output_tokens: 1,
      cache_read_tokens: null, cache_creation_tokens: null },
    usage_summary: usage("CONFIRMED", 12_000, 345, { settled: 2 }) };
}

function userMessage() {
  return { id: userMessageId, session_id: sessionId, seq: "1", role: "USER",
    status: "COMPLETED", intent: "DISCUSS", content: "这一轮花了多少 token？",
    error_code: null, provider_error_kind: null, sources: [], skill: null,
    usage: { input_tokens: null, output_tokens: null,
      cache_read_tokens: null, cache_creation_tokens: null },
    cancel_requested: false, steer_requested: false, attachments: [],
    created_at: "2026-11-01T09:00:00Z", updated_at: "2026-11-01T09:00:00Z" };
}

async function installRoutes(page: Page, state: {
  phase: () => Phase; usage: () => ReturnType<typeof usage> | null;
}): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/projects/${projectId}`) return fulfillJson(route, { id: projectId,
      title: "Relay-Agent", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
    if (path === `${prefix}/projects/${projectId}/state`) return fulfillJson(route, { project_id: projectId,
      revision: "1", phase_key: "GENERAL", next_action_task_id: null,
      selected_artifact_version_refs: [], completed_highlight_refs: [] });
    if (path === `${prefix}/model-port`) return fulfillJson(route, { provider: "fake",
      configured: false, model: null, base_url: null, max_call_tokens: 200_000 });
    if (path === `${prefix}/default-working-directory`) return fulfillJson(route, { resource_id: null,
      canonical_root: null, display_name: null, write_tier: null, default_write_tier: null,
      status: "UNSET", reason: null, revision: "0" });
    if (path === `${prefix}/assist-sessions`) return fulfillJson(route, { items: [session] });
    if (path === `${prefix}/assist-sessions/${sessionId}`) return fulfillJson(route, session);
    if (path === `${prefix}/assist-sessions/${sessionId}/plans`)
      return fulfillJson(route, { latest: null, versions: [] });
    if (path === `${prefix}/assist-sessions/${sessionId}/goal`)
      return fulfillJson(route, { goal: null, rounds: [] });
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`)
      return fulfillJson(route, { items: [userMessage(), message(state.phase())] });
    if (path.endsWith("/live-preview/events")) {
      await route.fulfill({ status: 502, headers: cors(), body: "" });
      return;
    }
    if (path.endsWith("/live-preview")) {
      const running = state.phase() === "running";
      return fulfillJson(route, { session_id: sessionId, message_id: assistantMessageId,
        status: running ? "RUNNING" : "COMPLETED",
        preview_revision: running ? "7" : "0",
        preview_text: running ? "正在读取配置并核对依赖。" : null,
        preview_truncated: false, preview_available: running,
        usage: running ? state.usage() : null });
    }
    if (path.endsWith("/model-runtime")) return fulfillJson(route, { message_id: assistantMessageId,
      message_status: "COMPLETED", snapshot_available: false, preferred_model: null,
      candidate_models: [], current_candidate_model: null, actual_model: null,
      max_candidates: null, routing_status: null, failure_scope: null, failure_reason: null,
      retry_after_at: null, free_daily_remaining: null, switches: [], calls: [] });
    if (path.endsWith("/tool-calls")) return fulfillJson(route, { session_id: sessionId,
      message_id: assistantMessageId, message_status: state.phase() === "settled" ? "COMPLETED" : "RUNNING",
      rounds: [] });
    return fulfillJson(route, { items: [], next_cursor: null });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("token-usage");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" })
    .waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

test("生成中估算 → 部分确认 → 完成读账本：数字、符号、次级视觉与窄窗都不越界", async ({ page }) => {
  fs.mkdirSync(shotsDir, { recursive: true });
  const state: { phase: () => Phase; usage: () => ReturnType<typeof usage> | null } = {
    phase: () => "running", usage: () => usage("ESTIMATED", 5_000, 400, { pending: 1 }) };
  await installRoutes(page, state);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/projects/${projectId}?skill=assist`);
  await connect(page);

  const live = page.getByTestId(`assist-token-live-${assistantMessageId}`);
  await expect(live).toBeVisible({ timeout: 20_000 });
  await expect(live).toHaveText("本轮 ≈ 5.4k tokens");
  await expect(live).toHaveAttribute("data-state", "ESTIMATED");
  await expect(live).toHaveAttribute("data-total", "5400");

  const title = await live.getAttribute("title");
  expect(title).toContain("输入 5,000（含估算）");
  expect(title).toContain("输出 400（含估算）");
  expect(title).toContain("1 次调用进行中");

  // 次级信息：弱色、meta 字号、等宽数字；没有底框、投影或滤镜。
  const paint = await live.evaluate((node) => {
    const s = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return { color: s.color, fontSize: s.fontSize, numeric: s.fontVariantNumeric,
      bg: s.backgroundColor, shadow: s.boxShadow, filter: s.filter,
      width: rect.width, left: rect.left, right: rect.right };
  });
  expect(paint.numeric).toBe("tabular-nums");
  expect(paint.bg).toBe("rgba(0, 0, 0, 0)");
  expect(paint.shadow).toBe("none");
  expect(paint.filter).toBe("none");
  const metaSize = await page.locator(".agent-message-meta").first()
    .evaluate((node) => getComputedStyle(node).fontSize);
  expect(paint.fontSize).toBe(metaSize);
  expect(paint.left).toBeGreaterThan(0);
  await page.screenshot({ path: `${shotsDir}/01-running-estimated.png`, fullPage: false });

  // 第一次调用结算、第二次仍在途：数字变成下界并明确说部分未知；宽度仍在阅读列内。
  state.usage = () => usage("PARTIAL", 5_000, 400, { settled: 1, pending: 1, missing: 1 });
  await page.waitForTimeout(600);
  await expect(live).toHaveText("本轮 ≥ 5.4k tokens · 部分用量未知");
  await expect(live).toHaveAttribute("data-state", "PARTIAL");
  await page.screenshot({ path: `${shotsDir}/02-running-partial.png`, fullPage: false });

  // 完成：页脚读数来自 usage_summary（12,345 → 12.3k），不是旧 usage（1,001 → 1k）。
  state.phase = () => "settled";
  await page.waitForTimeout(800);
  const footer = page.getByTestId(`assist-usage-${assistantMessageId}`);
  await expect(footer).toBeVisible({ timeout: 20_000 });
  await expect(footer).toHaveText("本轮 12.3k tokens");
  await expect(footer).toHaveAttribute("data-state", "CONFIRMED");
  await expect(footer).toHaveAttribute("data-total", "12345");
  await expect(page.getByTestId(`assist-token-live-${assistantMessageId}`)).toHaveCount(0);
  await page.screenshot({ path: `${shotsDir}/03-settled-confirmed.png`, fullPage: false });

  // 560px 窄窗：读数折行不把页面撑宽。
  await page.setViewportSize({ width: 560, height: 900 });
  await page.waitForTimeout(150);
  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth, inner: window.innerWidth }) as {
    scroll: number; inner: number });
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.inner);
  await page.screenshot({ path: `${shotsDir}/04-settled-narrow-560.png`, fullPage: false });
});
