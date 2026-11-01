import { expect, test, type Page, type Route } from "@playwright/test";
import fs from "node:fs";

/**
 * AI 回复区「无阴影、无横向灰带」的浏览器验收（2026-10-31 UI-08）。
 *
 * 单元测试证的是 DOM 里有什么；这里量的是**画出来是什么样**。本轮用户指认的问题：
 * 每条 AI 回复头顶横着一条贯穿阅读列的灰带（`.activity-header` 的 `bg.subtle`），
 * 点开读回零条后那条带子又凭空消失——「有没有展开」决定了带子在不在，读起来像阴影被撤掉。
 *
 * 四条口径不可让步：
 *   1. 过程摘要行在**任何相位、任何开合、任何时刻**都不画底色、渐变、投影或滤镜：
 *      底色 transparent、background-image none、box-shadow none、filter none。
 *      这四条同时成立才叫「没有带子」——只看 background-color 会漏掉渐变与 inset 投影。
 *   2. 展开与收起只改内容，不改这条入口的画法：点击前后四项读数逐字相同。
 *   3. 空读之后入口不消失（V3 P0）：用户点开过的入口读回零条时仍在，并给出一句结论。
 *   4. 聊天滚动容器的上下边缘不再有渐隐遮罩（`::before`/`::after` 的 linear-gradient）：
 *      那是另一种「读成阴影」的横贯装饰，与过程行是同一个问题。
 *
 * API 全部由 page.route 伪造：不连数据库、不调 Provider、不写真实业务事实。
 * 证据落在 tmp/UI-08-reply-no-shadow-polish/screenshots/。
 */

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const sessionId = "66666666-6666-4666-8666-666666666666";
const userMessageId = "c1111111-1111-4111-8111-111111111111";
const assistantMessageId = "c2222222-2222-4222-8222-222222222222";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = `http://127.0.0.1:${process.env.RELAY_E2E_PORT ?? "4173"}`;
const shotsDir = "D:/Develop/Relay-Agent/tmp/UI-08-reply-no-shadow-polish/screenshots";

const FINAL = [
  "## 结论",
  "",
  "这一轮读了配置、跑了检查，并把一处依赖顺序改对。",
  "",
  "- 读取 6 个文件",
  "- 运行 1 次检查"
].join("\n");

const LONG_PATH = "apps/workbench/src/components/activityPresentation/very/deep/path/ActivityRow.tsx";

type Phase = "running" | "settled";
type Variant = "normal" | "empty" | "error";

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(), body: JSON.stringify(body) });
}

const session = { id: sessionId, workspace_id: workspaceId, project_id: projectId, task_id: null,
  title: "关于Relay-Agent", status: "ACTIVE", revision: "1", conversation_mode: "AGENT",
  assistant_profile_id: null, working_resource_id: null,
  context: { project_goals: [], working_directory: null },
  created_at: "2026-10-29T09:00:00Z", updated_at: "2026-10-29T09:00:00Z" };

function message(id: string, seq: string, role: "USER" | "ASSISTANT", status: string,
  content: string | null) {
  return { id, session_id: sessionId, seq, role, status, intent: "DISCUSS", content,
    error_code: null, provider_error_kind: null, sources: [], skill: null, cancel_requested: false,
    steer_requested: false, attachments: [], created_at: "2026-10-29T09:00:00Z",
    updated_at: "2026-10-29T09:00:00Z",
    usage: { input_tokens: 1200, output_tokens: 180, cache_read_tokens: null, cache_creation_tokens: null } };
}

function messages(phase: Phase) {
  return [
    message(userMessageId, "1", "USER", "COMPLETED", "把这次的改动过程说清楚"),
    message(assistantMessageId, "2", "ASSISTANT", phase === "settled" ? "COMPLETED" : "RUNNING",
      phase === "settled" ? FINAL : null)
  ];
}

/** 三轮调用：一轮读取、一轮命令、一轮写入；含一条超长路径与一条被拒的调用。 */
function toolCalls(phase: Phase) {
  const base = { arguments_sha256: "a".repeat(64), provider_tool_call_id: "call-x",
    operation_id: null, rejection_reason: null, rejection_detail: null, result_digest: null };
  const reads = ["package.json", "pnpm-workspace.yaml", LONG_PATH].map((path, index) => ({
    ...base, id: `d1000000-0000-4000-8000-00000000000${index}`, round: 0, ordinal: index,
    tool_name: "read_file", status: "SETTLED", arguments: { relative_path: path },
    requested_at: `2026-10-29T09:00:0${index}.000Z`, settled_at: "2026-10-29T09:00:01.400Z"
  }));
  const checks = { ...base, id: "d2000000-0000-4000-8000-000000000001", round: 1, ordinal: 0,
    tool_name: "run_check", status: "SETTLED", arguments: { check_id: "typecheck" },
    requested_at: "2026-10-29T09:00:02.000Z", settled_at: "2026-10-29T09:00:03.000Z" };
  const rejected = { ...base, id: "d2000000-0000-4000-8000-000000000002", round: 2, ordinal: 0,
    tool_name: "apply_changeset", status: "REJECTED", arguments: { relative_path: "../../etc/hosts" },
    rejection_reason: "OUTSIDE_SCOPE", rejection_detail: "目标不在本次绑定的目录内。",
    requested_at: "2026-10-29T09:00:04.000Z", settled_at: "2026-10-29T09:00:04.100Z" };
  return { session_id: sessionId, message_id: assistantMessageId,
    message_status: phase === "settled" ? "COMPLETED" : "RUNNING",
    rounds: [
      { round: 0, calls: reads },
      { round: 1, calls: [checks] },
      { round: 2, calls: [rejected] }
    ] };
}

async function installRoutes(page: Page, state: { phase: () => Phase; variant?: () => Variant }): Promise<void> {
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
      configured: false, model: null, base_url: null, max_call_tokens: 200000 });
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
      return fulfillJson(route, { items: messages(state.phase()) });
    if (path.endsWith("/live-preview/events")) {
      await route.fulfill({ status: 502, headers: cors(), body: "" });
      return;
    }
    if (path.endsWith("/live-preview")) {
      const running = state.phase() === "running";
      return fulfillJson(route, { session_id: sessionId, message_id: assistantMessageId,
        status: running ? "RUNNING" : "COMPLETED", preview_revision: running ? "2" : "0",
        preview_text: running ? "正在按顺序读取配置并核对依赖。" : null,
        preview_truncated: false, preview_available: running });
    }
    if (path.endsWith("/model-runtime")) return fulfillJson(route, { message_id: assistantMessageId,
      message_status: "COMPLETED", snapshot_available: false, preferred_model: null,
      candidate_models: [], current_candidate_model: null, actual_model: null,
      max_candidates: null, routing_status: null, failure_scope: null, failure_reason: null,
      retry_after_at: null, free_daily_remaining: null, switches: [], calls: [] });
    if (path.endsWith("/tool-calls")) {
      const variant = state.variant?.() ?? "normal";
      // 空态与读取失败是两个必须区分的缺口：前者是事实（没有调用工具），后者是读不到。
      if (variant === "empty") return fulfillJson(route, { session_id: sessionId,
        message_id: assistantMessageId, message_status: "COMPLETED", rounds: [] });
      if (variant === "error") return fulfillJson(route, { error: "trace unavailable" }, 500);
      return fulfillJson(route, toolCalls(state.phase()));
    }
    return fulfillJson(route, { items: [], next_cursor: null });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("no-shadow-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

/**
 * 过程摘要行与它所在面板的「画法」读数。
 *
 * 四项一起看：底色、背景图（渐变）、投影、滤镜。只看底色会漏掉渐变带与 inset 投影，
 * 只看投影会漏掉「一整行灰底」这种不带阴影的横向装饰——这一轮的问题恰恰是后者。
 */
async function paintOf(page: Page, selector: string): Promise<{
  bg: string; image: string; shadow: string; filter: string;
}> {
  return page.locator(selector).first().evaluate((node) => {
    const s = getComputedStyle(node);
    return { bg: s.backgroundColor, image: s.backgroundImage, shadow: s.boxShadow, filter: s.filter };
  });
}

function expectNoBand(paint: { bg: string; image: string; shadow: string; filter: string }, where: string): void {
  expect(paint.bg, `${where}：摘要行画了底色（横向灰带就是它）`).toBe("rgba(0, 0, 0, 0)");
  expect(paint.image, `${where}：摘要行画了背景图/渐变`).toBe("none");
  expect(paint.shadow, `${where}：摘要行画了投影`).toBe("none");
  expect(paint.filter, `${where}：摘要行带了滤镜`).toBe("none");
}

test.beforeAll(() => { fs.mkdirSync(shotsDir, { recursive: true }); });

test.describe("AI 回复区：无阴影、无横向灰带", () => {
  test("① 终态有工具：摘要行与面板都不画底色、渐变、投影或滤镜", async ({ page }) => {
    await page.setViewportSize({ width: 1270, height: 900 });
    await installRoutes(page, { phase: () => "settled" });
    await page.goto(`/projects/${projectId}?skill=assist`);
    await connect(page);

    const trace = page.getByTestId(`session-round-trace-${assistantMessageId}`);
    await expect(trace).toBeVisible({ timeout: 20_000 });
    // 终态历史消息默认不预读：此刻是 IDLE（只说「展开查看」），读过一次才是 SETTLED。
    await expect(trace).toHaveAttribute("data-phase", "IDLE");
    expectNoBand(await paintOf(page, ".activity-header"), "终态·未读取");
    expectNoBand(await paintOf(page, ".activity-panel"), "终态·未读取·面板");

    await page.getByTestId("session-round-trace-toggle").click();
    // 这份夹具里有一条被准入拒绝的调用，因此终态相位是 REJECTED（例外压过「已结束」）。
    // 顺带钉住这条口径：拒绝不会被并进「已结束」，也不会被显示成完成。
    await expect(trace).toHaveAttribute("data-phase", "REJECTED", { timeout: 5_000 });
    expectNoBand(await paintOf(page, ".activity-header"), "终态·有工具");
    expectNoBand(await paintOf(page, ".activity-panel"), "终态·有工具·面板");
    await page.screenshot({ path: `${shotsDir}/after-assistant-settled.png`, fullPage: false });
  });

  test("② 展开与收起只改内容，不改这条入口的画法", async ({ page }) => {
    await page.setViewportSize({ width: 1270, height: 900 });
    await installRoutes(page, { phase: () => "settled" });
    await page.goto(`/projects/${projectId}?skill=assist`);
    await connect(page);

    const trace = page.getByTestId(`session-round-trace-${assistantMessageId}`);
    await expect(trace).toBeVisible({ timeout: 20_000 });
    const toggle = page.getByTestId("session-round-trace-toggle");
    const before = await paintOf(page, ".activity-header");

    await toggle.click();
    await expect(trace).toHaveAttribute("open", "", { timeout: 3_000 });
    const expanded = await paintOf(page, ".activity-header");
    expect(expanded, "展开之后摘要行的画法变了").toEqual(before);

    await toggle.click();
    await expect(trace).not.toHaveAttribute("open", "", { timeout: 3_000 });
    const collapsed = await paintOf(page, ".activity-header");
    expect(collapsed, "收起之后摘要行的画法变了").toEqual(before);
    expectNoBand(collapsed, "收起后");
  });

  test("③ 在途有工具：运行中同样不铺底色（状态由图标与状态词表达）", async ({ page }) => {
    await page.setViewportSize({ width: 1270, height: 900 });
    await installRoutes(page, { phase: () => "running" });
    await page.goto(`/projects/${projectId}?skill=assist`);
    await connect(page);

    const trace = page.getByTestId(`session-round-trace-${assistantMessageId}`);
    await expect(trace).toHaveAttribute("data-state", "active", { timeout: 20_000 });
    expectNoBand(await paintOf(page, ".activity-header"), "在途");
    expectNoBand(await paintOf(page, ".activity-panel"), "在途·面板");
    await page.screenshot({ path: `${shotsDir}/after-assistant-running.png`, fullPage: false });
  });

  test("④ 历史消息未读取：入口在，且同样不铺底色", async ({ page }) => {
    await page.setViewportSize({ width: 1270, height: 900 });
    await installRoutes(page, { phase: () => "settled" });
    await page.goto(`/projects/${projectId}?skill=assist`);
    await connect(page);

    const trace = page.getByTestId(`session-round-trace-${assistantMessageId}`);
    await expect(trace).toBeVisible({ timeout: 20_000 });
    // 未读取时是 IDLE：只说「展开查看」，不预判有没有工具。
    await expect(trace).toHaveAttribute("data-phase", "IDLE");
    expectNoBand(await paintOf(page, ".activity-header"), "未读取");
  });

  test("⑤ 读回零条：入口不消失，空状态是一行结论，画法仍不变", async ({ page }) => {
    await page.setViewportSize({ width: 1270, height: 900 });
    await installRoutes(page, { phase: () => "settled", variant: () => "empty" });
    await page.goto(`/projects/${projectId}?skill=assist`);
    await connect(page);

    const trace = page.getByTestId(`session-round-trace-${assistantMessageId}`);
    await expect(trace).toBeVisible({ timeout: 20_000 });
    const toggle = page.getByTestId("session-round-trace-toggle");
    await toggle.click();
    await expect(trace).toHaveAttribute("data-phase", "EMPTY", { timeout: 5_000 });

    // 入口必须还在（V3 P0）：用户点开的就是它，读完零条也要有一句确定的结论。
    await expect(trace).toBeVisible();
    await expect(page.getByTestId(`session-round-trace-empty-${assistantMessageId}`)).toBeVisible();
    expectNoBand(await paintOf(page, ".activity-header"), "读回零条后");
    await page.screenshot({ path: `${shotsDir}/after-assistant-empty-read.png`, fullPage: false });
  });

  test("⑥ 读取失败：入口带原因与重读，画法不变", async ({ page }) => {
    await page.setViewportSize({ width: 1270, height: 900 });
    await installRoutes(page, { phase: () => "settled", variant: () => "error" });
    await page.goto(`/projects/${projectId}?skill=assist`);
    await connect(page);

    const trace = page.getByTestId(`session-round-trace-${assistantMessageId}`);
    await expect(trace).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("session-round-trace-toggle").click();
    await expect(trace).toHaveAttribute("data-phase", "ERROR", { timeout: 5_000 });
    await expect(page.getByTestId(`session-round-trace-error-${assistantMessageId}`)).toBeVisible();
    expectNoBand(await paintOf(page, ".activity-header"), "读取失败");
  });

  test("⑦ 聊天滚动容器上下边缘没有渐隐遮罩", async ({ page }) => {
    await page.setViewportSize({ width: 1270, height: 900 });
    await installRoutes(page, { phase: () => "settled" });
    await page.goto(`/projects/${projectId}?skill=assist`);
    await connect(page);

    // 聊天区是异步挂载的：先等滚动容器在场，再读它的伪元素——
    // 否则量到的是「还没挂上」，把空跑当成通过（或当成遮罩存在）。
    await expect(page.locator(".agent-chat-transcript-shell")).toBeAttached({ timeout: 20_000 });
    const overlays = await page.evaluate(() => {
      const shell = document.querySelector(".agent-chat-transcript-shell");
      if (shell === null) return null;
      const before = getComputedStyle(shell, "::before");
      const after = getComputedStyle(shell, "::after");
      return { before: before.backgroundImage, after: after.backgroundImage,
        beforeContent: before.content, afterContent: after.content };
    });
    expect(overlays, "聊天区没有滚动容器，这条测量是空跑").not.toBeNull();
    expect(overlays?.before, "滚动容器上缘仍在画渐隐带").toBe("none");
    expect(overlays?.after, "滚动容器下缘仍在画渐隐带").toBe("none");
  });

  test("⑧ 键盘可展开，焦点轮廓用 outline 而不是阴影光晕", async ({ page }) => {
    await page.setViewportSize({ width: 1270, height: 900 });
    await installRoutes(page, { phase: () => "settled" });
    await page.goto(`/projects/${projectId}?skill=assist`);
    await connect(page);

    const trace = page.getByTestId(`session-round-trace-${assistantMessageId}`);
    await expect(trace).toBeVisible({ timeout: 20_000 });
    // 用 Tab 走到摘要行：程序化 focus() 不保证命中 :focus-visible 启发式。
    let hit = false;
    for (let index = 0; index < 60 && !hit; index += 1) {
      await page.keyboard.press("Tab");
      hit = await page.evaluate(() => document.activeElement instanceof HTMLElement
        && document.activeElement.matches(".activity-header"));
    }
    expect(hit, "键盘 Tab 走不到过程摘要行").toBe(true);

    const focus = await page.locator(".activity-header").first().evaluate((node) => {
      const s = getComputedStyle(node);
      return { visible: node.matches(":focus-visible"), outlineStyle: s.outlineStyle,
        outlineWidth: s.outlineWidth, shadow: s.boxShadow };
    });
    expect(focus.visible, "键盘聚焦时没有命中 :focus-visible").toBe(true);
    expect(focus.outlineStyle, "焦点没有用 outline 表达").not.toBe("none");
    expect(focus.shadow, "焦点用 box-shadow 光晕表达，读成一层阴影").toBe("none");

    // 键盘也能展开/收起：Enter 与 Space 是原生 disclosure 的语义。
    const opened = await trace.evaluate((node) => (node as HTMLDetailsElement).open);
    await page.keyboard.press("Enter");
    await expect.poll(async () => trace.evaluate((node) => (node as HTMLDetailsElement).open),
      { timeout: 3_000 }).toBe(!opened);
  });

  test("⑨ 窄窗与长路径：过程区不产生页面级横向滚动", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await installRoutes(page, { phase: () => "settled" });
    await page.goto(`/projects/${projectId}?skill=assist`);
    await connect(page);

    const trace = page.getByTestId(`session-round-trace-${assistantMessageId}`);
    await expect(trace).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("session-round-trace-toggle").click();
    await expect(trace).toHaveAttribute("open", "", { timeout: 3_000 });

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth
      - document.documentElement.clientWidth);
    expect(overflow, `390px 下把页面撑出横向滚动（多出 ${overflow}px）`).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `${shotsDir}/after-assistant-narrow.png`, fullPage: false });
  });
});
