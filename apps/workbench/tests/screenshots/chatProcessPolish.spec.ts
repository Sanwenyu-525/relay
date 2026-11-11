import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * UI-CHAT-PROCESS-POLISH-01 取证：真实 Chromium 里重现截图里的同一条消息。
 *
 * API 全部由 page.route 伪造（沿用 assistExecutionTransparency.spec.ts 的同一套路由瘦身版），
 * 只喂一条在途 AI 消息：阶段句 WAITING_MODEL_RESPONSE、3 次模型调用（2 已完 + 1 等待）、
 * 2 次工具调用（find_paths / read_file，均已结算），使截图里被圈出的四处同时出现。
 *
 * 输出：tmp/UI-CHAT-PROCESS-POLISH-01/screenshots/*.png 与 metrics-<phase>-<width>.json。
 * phase 由 POLISH_PHASE 控制（before / after），两轮同名文件不互相覆盖。
 */

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const assistantMessageId = "55555555-5555-4555-8555-555555555555";
const userMessageId = "c1111111-1111-4111-8111-111111111111";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = `http://127.0.0.1:${process.env.RELAY_E2E_PORT ?? "4174"}`;
const phase = process.env.POLISH_PHASE ?? "before";
const outRoot = resolve(process.cwd(), "../../tmp/UI-CHAT-PROCESS-POLISH-01");
const shotDir = resolve(outRoot, "screenshots");

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
  created_at: "2026-11-10T08:33:00Z", updated_at: "2026-11-10T08:33:00Z" };

const at = (secondsBefore: number): string =>
  new Date(Date.now() - secondsBefore * 1000).toISOString();

function userMessage() {
  return { id: userMessageId, session_id: sessionId, seq: "1", role: "USER", status: "COMPLETED",
    intent: "DISCUSS", content: "看一下仓库里的 AGENTS.md，把前端约定读一遍。", error_code: null,
    provider_error_kind: null, sources: [], skill: null, cancel_requested: false,
    steer_requested: false, attachments: [], created_at: at(95), updated_at: at(95),
    usage: { input_tokens: null, output_tokens: null, cache_read_tokens: null,
      cache_creation_tokens: null }, usage_summary: null, generation_progress: null };
}

function assistantMessage() {
  return { id: assistantMessageId, session_id: sessionId, seq: "2", role: "ASSISTANT",
    status: "RUNNING", intent: "DISCUSS",
    content: "我先定位 AGENTS.md，再把里面的前端约定读出来。",
    error_code: null, provider_error_kind: null, sources: [], skill: null,
    cancel_requested: false, steer_requested: false, attachments: [],
    created_at: at(38), updated_at: at(1),
    usage: { input_tokens: null, output_tokens: null, cache_read_tokens: null,
      cache_creation_tokens: null }, usage_summary: null, generation_progress: null };
}

const settled = (ref: string) => ({ disposition: "CONFIRMED_SUCCESS", effective_outcome: "SUCCEEDED",
  operation_ref: ref, operation_status: "SETTLED", invocation_status: "SUCCEEDED",
  effect_state: "SUCCEEDED", reconcile_required: false, reconciled: true,
  resolved_at: "2026-11-10T08:33:45.807Z", provenance: "LIVE", reason: "CONFIRMED_SUCCESS" });

function activityItem(input: { id: string; kind: string; view: string; tone: string;
  terminal: boolean; ref: string; toolName?: string; recovery?: unknown }) {
  return { activity_id: input.id, kind: input.kind,
    state: { raw: input.view, view: input.view, tone: input.tone, terminal: input.terminal },
    started_at: "2026-11-10T08:33:41.000Z",
    ended_at: input.terminal ? "2026-11-10T08:33:45.807Z" : null,
    order: { message_seq: "2", round: 0, ordinal: 0, rank: 0 },
    refs: { model_call_id: input.kind === "MODEL_CALL" ? input.ref : null,
      tool_call_id: input.kind === "TOOL_CALL" ? input.ref : null,
      operation_id: null, invocation_id: input.kind === "TOOL_CALL" ? input.ref : null },
    wait: null, error: null,
    evidence: { result_available: false, result_digest: null, failure_kind: null,
      detail_visibility: "USER" },
    recovery: input.recovery ?? null,
    ...(input.toolName === undefined ? {} : { tool_name: input.toolName }),
    facts: null };
}

function activitySnapshot() {
  return { message_id: assistantMessageId, seq: "2", role: "ASSISTANT", status: "RUNNING",
    intent: "DISCUSS", created_at: at(38), claimed_at: at(37), settled_at: null,
    updated_at: at(1), cancel_requested: false, source_user_message_id: userMessageId,
    content_fingerprint: "polish-1", process_evidence: "RECORDED",
    phase: { raw: "RUNNING", view: "WAITING_MODEL_RESPONSE", tone: "wait",
      since: at(26), detail: "模型请求已登记，等待响应", wait: null },
    execution_request: null, run_summary: null,
    activities: [
      activityItem({ id: "model-call:m1", kind: "MODEL_CALL", view: "COMPLETED",
        tone: "success", terminal: true, ref: "m1" }),
      activityItem({ id: "model-call:m2", kind: "MODEL_CALL", view: "COMPLETED",
        tone: "success", terminal: true, ref: "m2" }),
      activityItem({ id: "model-call:m3", kind: "MODEL_CALL", view: "WAITING_RESPONSE",
        tone: "active", terminal: false, ref: "m3" }),
      activityItem({ id: "tool-call:t1", kind: "TOOL_CALL", view: "SETTLED",
        tone: "neutral", terminal: true, ref: "t1", toolName: "find_paths",
        recovery: settled("t1") }),
      activityItem({ id: "tool-call:t2", kind: "TOOL_CALL", view: "SETTLED",
        tone: "neutral", terminal: true, ref: "t2", toolName: "read_file",
        recovery: settled("t2") })
    ],
    activity_counts: { model_calls: 3, tool_calls: 2, todo_writes: 0, delegations: 0 },
    gaps: [] };
}

function toolCalls() {
  return { session_id: sessionId, message_id: assistantMessageId, message_status: "RUNNING",
    rounds: [{ round: 0, calls: [
      { id: "t1", round: 0, ordinal: 0, tool_name: "find_paths", status: "SETTLED",
        arguments: { pattern: "agents.md", path: "agents.md" }, rejection_reason: null,
        rejection_detail: null, requested_at: "2026-11-10T08:33:44.796Z",
        settled_at: "2026-11-10T08:33:45.807Z" },
      { id: "t2", round: 0, ordinal: 1, tool_name: "read_file", status: "SETTLED",
        arguments: { path: "AGENTS.md" }, rejection_reason: null, rejection_detail: null,
        requested_at: at(4), settled_at: at(3) }
    ] }] };
}

async function installRoutes(page: Page): Promise<void> {
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
    if (path === `${prefix}/assist-sessions/${sessionId}/activity`)
      return fulfillJson(route, { schema_version: 1, session,
        generated_at: at(0), snapshot_at: at(0), messages: [activitySnapshot()],
        next_before_seq: null, has_more: false });
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`)
      return fulfillJson(route, { items: [userMessage(), assistantMessage()],
        has_more: false, next_before_seq: null });
    if (path.endsWith("/live-preview/events")) {
      await route.fulfill({ status: 502, headers: cors(), body: "" });
      return;
    }
    if (path.endsWith("/live-preview")) return fulfillJson(route, { session_id: sessionId,
      message_id: assistantMessageId, status: "RUNNING", preview_revision: "0",
      preview_text: null, preview_truncated: false, preview_available: false, usage: null });
    if (path.endsWith("/tool-calls")) return fulfillJson(route, toolCalls());
    if (path === `${prefix}/assist-sessions/${sessionId}/todos`)
      return fulfillJson(route, { snapshot: null });
    if (path.includes("conversation-diff")) return fulfillJson(route, { session_id: sessionId,
      files: [], unavailable_files: 0, unverifiable_files: 0, baseline: null,
      incomplete: false });
    if (/\/assist-messages\/[^/]+\/model-runtime$/u.test(path)) return fulfillJson(route, {
      message_id: assistantMessageId, message_status: "RUNNING", snapshot_available: false,
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
  await page.locator('input[name="relay-bearer-token"]').fill("polish-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" })
    .waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

interface Box { x: number; y: number; w: number; h: number }
interface Probe { sel: string; found: boolean; bg: string; color: string; pad: string;
  radius: string; fontSize: string; lineHeight: string; box: Box | null }

async function probe(page: Page, selectors: readonly string[]): Promise<Probe[]> {
  return page.evaluate((list: readonly string[]) => list.map((sel: string) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (el === null) return { sel, found: false, bg: "", color: "", pad: "", radius: "",
      fontSize: "", lineHeight: "", box: null };
    const cs = window.getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { sel, found: true, bg: cs.backgroundColor, color: cs.color,
      pad: `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`,
      radius: cs.borderRadius, fontSize: cs.fontSize, lineHeight: cs.lineHeight,
      box: { x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10,
        w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 } };
  }), selectors);
}

/** 箭头与同行文字的实测关系：水平间隙、垂直中心差、是否落在同一条右缘列。 */
async function alignment(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const row = document.querySelector(".activity-item") as HTMLElement | null;
    if (row === null) return { ok: "no-row" };
    const toggle = row.querySelector(".activity-item-toggle") as HTMLElement | null;
    const elapsed = row.querySelector(".activity-item-elapsed") as HTMLElement | null;
    const verb = row.querySelector(".activity-item-verb") as HTMLElement | null;
    const target = row.querySelector(".activity-item-target") as HTMLElement | null;
    const svg = toggle === null ? null : toggle.querySelector("svg");
    const rect = (el: Element | null) => el === null ? null : el.getBoundingClientRect();
    const t = rect(toggle); const e = rect(elapsed); const v = rect(verb);
    const s = rect(svg); const g = rect(target);
    const head = row.querySelector(".activity-item-head") as HTMLElement | null;
    const hr = rect(head);
    return {
      ok: "measured",
      headRight: hr === null ? null : Math.round(hr.right * 10) / 10,
      toggleLeft: t === null ? null : Math.round(t.left * 10) / 10,
      toggleWidth: t === null ? null : Math.round(t.width * 10) / 10,
      toggleRight: t === null ? null : Math.round(t.right * 10) / 10,
      elapsedRight: e === null ? null : Math.round(e.right * 10) / 10,
      gapElapsedToToggle: t === null || e === null ? null : Math.round((t.left - e.right) * 10) / 10,
      svgCenterY: s === null ? null : Math.round((s.top + s.height / 2) * 10) / 10,
      verbCenterY: v === null ? null : Math.round((v.top + v.height / 2) * 10) / 10,
      baselineDelta: s === null || v === null ? null
        : Math.round(((s.top + s.height / 2) - (v.top + v.height / 2)) * 10) / 10,
      verbLeft: v === null ? null : Math.round(v.left * 10) / 10,
      targetLeft: g === null ? null : Math.round(g.left * 10) / 10
    };
  });
}

const SELECTORS = [
  ".agent-message[data-role=\"ASSISTANT\"]",
  ".assist-reply",
  ".agent-message-process",
  ".activity-panel",
  ".activity-header",
  ".activity-item-head",
  ".activity-item-detail",
  ".activity-item-detail pre",
  ".activity-panel-toolbar",
  ".activity-panel-density-option[aria-pressed=\"true\"]"
] as const;

for (const width of [1440, 1024, 375]) {
  test(`UI-CHAT-PROCESS-POLISH-01 ${width}px`, async ({ page }) => {
    mkdirSync(shotDir, { recursive: true });
    test.setTimeout(90_000);
    // 375 窄屏下侧栏是抽屉，先在宽口完成建连与开会话，再收窄截取响应式重排。
    await page.setViewportSize({ width: width === 375 ? 1440 : width, height: 900 });
    await installRoutes(page);
    await page.goto(`/projects/${projectId}?skill=assist`);
    await connect(page);

    // 连接后不一定自动打开会话：侧栏里点一下同名会话，再等工具账本落位。
    // 2026-11-10：这条在途消息有真实工具记录，过程区由 SessionRoundTrace 独占；
    // 消息级状态块只在审批/待核对等例外出现，因此这里不再等它。
    if (await page.locator(".activity-item").count() === 0) {
      const row = page.getByText("关于Relay-Agent").first();
      if (await row.count() > 0) await row.click();
    }
    await expect(page.locator(".activity-item").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("message-execution-status")).toHaveCount(0);
    if (width === 375) {
      await page.setViewportSize({ width: 375, height: 900 });
      await page.waitForTimeout(600);
    }
    await page.waitForTimeout(400);

    const collapsed = await probe(page, SELECTORS);
    await page.locator('.agent-message[data-role="ASSISTANT"]').first().screenshot({
      path: resolve(shotDir, `${phase}-${width}-01-collapsed.png`) });
    await page.screenshot({ path: resolve(shotDir, `${phase}-${width}-00-full.png`),
      fullPage: true });

    const rowToggle = page.locator('[data-testid="session-round-call-t1-toggle"]');
    // 窄窗时右侧时间线轨道可能盖住行尾按钮；这只用于展开截图，不验证命中区域。
    if (await rowToggle.count() > 0) await rowToggle.first().click({ force: true });
    await page.waitForTimeout(300);

    const expanded = await probe(page, SELECTORS);
    const align = await alignment(page);
    await page.locator('.agent-message[data-role="ASSISTANT"]').first().screenshot({
      path: resolve(shotDir, `${phase}-${width}-02-expanded.png`) });

    let tabIndex = -1;
    let outline = "";
    for (let i = 0; i < 80; i += 1) {
      await page.keyboard.press("Tab");
      const hit = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (el === null) return null;
        const cs = window.getComputedStyle(el);
        return { testid: el.getAttribute("data-testid") ?? "", cls: el.className,
          outline: `${cs.outlineWidth} ${cs.outlineStyle} ${cs.outlineColor}` };
      });
      if (hit !== null && (hit.cls.includes("activity-item-toggle")
        || hit.cls.includes("activity-header"))) {
        tabIndex = i + 1;
        outline = hit.outline;
        await page.locator('.agent-message[data-role="ASSISTANT"]').first().screenshot({
          path: resolve(shotDir, `${phase}-${width}-03-focus.png`) });
        break;
      }
    }

    await page.emulateMedia({ reducedMotion: "reduce" });
    const reduced = await page.evaluate(() => {
      const headerSpin = document.querySelector(".activity-header-spin") as HTMLElement | null;
      const spin = document.querySelector(".activity-item-spin") as HTMLElement | null;
      return { headerAnimation: headerSpin === null ? null
        : window.getComputedStyle(headerSpin).animationName,
        spinAnimation: spin === null ? null : window.getComputedStyle(spin).animationName };
    });

    writeFileSync(resolve(outRoot, `metrics-${phase}-${width}.json`), JSON.stringify({
      phase, width, collapsed, expanded, align, keyboard: { tabIndex, outline }, reduced
    }, null, 2), "utf8");
  });
}
