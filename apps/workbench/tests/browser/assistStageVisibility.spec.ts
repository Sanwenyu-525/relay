import fs from "node:fs";
import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * 执行透明性 P1（2026-11-01 AGENT_STREAM_VISIBILITY）：真实 Chromium 里验证
 * 「只有三个点」的等待被替换成服务端事实驱动的阶段行，并留下可核对的截图。
 *
 * API 全部由 page.route 伪造；不连数据库、不调 Provider、不写业务事实。
 * 截图写入 tmp/AGENT-STREAM-VISIBILITY/，不写进产品结果目录。
 */

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const assistantMessageId = "55555555-5555-4555-8555-555555555555";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = `http://127.0.0.1:${process.env.RELAY_E2E_PORT ?? "4173"}`;
const evidenceDir = "D:/Develop/Relay-Agent/tmp/AGENT-STREAM-VISIBILITY";
const DRAFT = "这是刚刚通过安全投影出现的草稿文字，后面还会继续写。";

type Stage = "WAITING_MODEL" | "MODEL_STREAMING" | "MODEL_OUTPUT" | "PROCESSING";

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

function progress(phase: Stage) {
  return { phase, call_count: 1,
    latest_call: {
      status: phase === "PROCESSING" ? "COMPLETED" : "STARTED",
      started_at: "2026-11-01T08:00:02.000Z",
      first_stream_event_at: phase === "WAITING_MODEL" ? null : "2026-11-01T08:00:03.000Z",
      first_text_delta_at: phase === "MODEL_OUTPUT" ? "2026-11-01T08:00:05.000Z" : null,
      first_preview_persisted_at: null,
      settled_at: phase === "PROCESSING" ? "2026-11-01T08:00:06.000Z" : null,
    } };
}

function message(status: "PENDING" | "RUNNING" | "COMPLETED", phase: Stage | null) {
  return { id: assistantMessageId, session_id: sessionId, seq: "2", role: "ASSISTANT",
    status, intent: "DISCUSS", content: null, error_code: null, provider_error_kind: null,
    sources: [], skill: null, cancel_requested: false, steer_requested: false,
    attachments: [], created_at: "2026-11-01T08:00:00Z", updated_at: "2026-11-01T08:00:06Z",
    usage: { input_tokens: null, output_tokens: null, cache_read_tokens: null,
      cache_creation_tokens: null },
    usage_summary: null,
    generation_progress: status === "RUNNING" && phase !== null ? progress(phase) : null };
}

async function installRoutes(page: Page, state: {
  status: () => "PENDING" | "RUNNING" | "COMPLETED";
  phase: () => Stage | null;
  previewText: () => string | null;
}) {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
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
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) {
      return fulfillJson(route, { items: [
        { id: "c1111111-1111-4111-8111-111111111111", session_id: sessionId, seq: "1",
          role: "USER", status: "COMPLETED", intent: "DISCUSS",
          content: "这次为什么这么久？", error_code: null, provider_error_kind: null,
          sources: [], skill: null, cancel_requested: false, steer_requested: false,
          attachments: [], created_at: "2026-11-01T07:59:00Z",
          updated_at: "2026-11-01T07:59:00Z",
          usage: { input_tokens: null, output_tokens: null, cache_read_tokens: null,
            cache_creation_tokens: null }, usage_summary: null, generation_progress: null },
        message(state.status(), state.phase())] });
    }
    if (path.endsWith("/live-preview/events")) {
      await route.fulfill({ status: 502, headers: cors(), body: "" });
      return;
    }
    if (path.endsWith("/live-preview")) {
      const text = state.previewText();
      const running = state.status() !== "COMPLETED";
      return fulfillJson(route, { session_id: sessionId, message_id: assistantMessageId,
        status: state.status(), preview_revision: text === null ? "0" : "3",
        preview_text: text, preview_truncated: false,
        preview_available: running && text !== null, usage: null });
    }
    if (path.endsWith("/tool-calls")) return fulfillJson(route, { session_id: sessionId,
      message_id: assistantMessageId, message_status: state.status(), rounds: [] });
    if (path === `${prefix}/assist-sessions/${sessionId}/todos`)
      return fulfillJson(route, { snapshot: null });
    // 过程槽位会读执行活动投影；返回合法空快照，避免截图里出现「执行过程读取失败」。
    if (path === `${prefix}/assist-sessions/${sessionId}/activity`) return fulfillJson(route, {
      schema_version: 1, session, generated_at: "2026-11-01T08:00:07Z",
      snapshot_at: "2026-11-01T08:00:07Z", messages: [], next_before_seq: null,
      has_more: false });
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
  await page.locator('input[name="relay-bearer-token"]').fill("stream-visibility-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" })
    .waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

function save(name: string): { path: string } { return { path: `${evidenceDir}/${name}.png` }; }

test.describe("执行阶段行", () => {
  test("等待处理 → 等待模型响应 → 模型已响应等待正文 → 草稿接管", async ({ page }) => {
    fs.mkdirSync(evidenceDir, { recursive: true });
    await page.setViewportSize({ width: 1270, height: 900 });
    let status: "PENDING" | "RUNNING" | "COMPLETED" = "PENDING";
    let phase: Stage | null = null;
    let previewText: string | null = null;
    await installRoutes(page, { status: () => status, phase: () => phase,
      previewText: () => previewText });
    await page.goto(`/projects/${projectId}?skill=assist`);
    await connect(page);

    const stage = page.getByTestId(`assist-stage-${assistantMessageId}`);
    await expect(stage).toHaveText("等待处理", { timeout: 30_000 });
    await page.screenshot(save("01-awaiting-worker"));

    status = "RUNNING"; phase = "WAITING_MODEL";
    await expect(stage).toHaveText("等待模型响应", { timeout: 10_000 });
    // 2026-11-10：聊天流只有一行阶段，逐段耗时不再就地展开。
    await expect(page.getByText("延迟诊断")).toHaveCount(0);
    await page.screenshot(save("02-waiting-model"));

    phase = "MODEL_STREAMING";
    await expect(stage).toHaveText("模型已响应，等待正文", { timeout: 10_000 });
    await page.screenshot(save("03-model-streaming"));

    phase = "MODEL_OUTPUT";
    await expect(stage).toHaveText("已收到模型输出，正在整理为回复", { timeout: 10_000 });
    await page.screenshot(save("04-model-output"));

    previewText = DRAFT;
    await expect(stage).toBeHidden({ timeout: 10_000 });
    await expect(page.locator(`[data-testid="assist-live-preview-${assistantMessageId}"]`))
      .toContainText(DRAFT);
    await expect(page.locator(".assist-inflight-dots")).toHaveCount(1);
    await page.screenshot(save("05-draft-takes-over"));
  });

  test("窄窗口无横向溢出；减少动效时三点静止", async ({ page }) => {
    fs.mkdirSync(evidenceDir, { recursive: true });
    await page.setViewportSize({ width: 560, height: 820 });
    const status: "RUNNING" | "COMPLETED" = "RUNNING";
    const phase: Stage | null = "WAITING_MODEL";
    await installRoutes(page, { status: () => status, phase: () => phase,
      previewText: () => null });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`/projects/${projectId}?skill=assist`);
    await connect(page);
    const stage = page.getByTestId(`assist-stage-${assistantMessageId}`);
    await expect(stage).toHaveText("等待模型响应", { timeout: 30_000 });

    const geometry = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.innerWidth);
    const animation = await page.locator(".assist-stage .assist-inflight-dots > i").first()
      .evaluate((node) => getComputedStyle(node).animationName);
    expect(animation).toBe("none");
    await page.screenshot(save("06-narrow-reduced-motion"));
  });
});
