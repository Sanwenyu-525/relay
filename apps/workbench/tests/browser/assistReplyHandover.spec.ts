import { expect, test, type Page, type Route } from "@playwright/test";
import fs from "node:fs";

/**
 * 回复生命周期：草稿 → 最终正文的**视觉交接**（2026-10-25 优化 P0 / P1）。
 *
 * 单测只能证明 DOM 里有什么，量不到「读起来是否连续」。这里在真实 Chromium 里把交接
 * 三个瞬间按几何量一遍，并且真的截图留证（apps/workbench/results/）：
 *   1. 生成中草稿：与最终正文同一个阅读区、同一档字号与行高，没有独立卡片的底与框。
 *   2. 终态已到、正文未读回：草稿仍在原位（不出现空白帧），三点已撤，meta 行写「正在核对」。
 *   3. 交接完成：只出现最终正文一次，一次性淡入（opacity only，motion.panel），
 *      左缘与草稿完全一致——也就是说这个过程里没有横向或纵向的「跳」。
 * 另两条：用户上滚后不得被强行拉回底部；窄窗口下不产生页面级横向溢出；动效关闭/reduced 时静态呈现。
 *
 * API 全部由 page.route 伪造（SSE 端点返回 502，走权威 GET 轮询那条已实现的回退路径），
 * 不连数据库、不调 Provider、不写真实业务事实。
 */

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const sessionId = "66666666-6666-4666-8666-666666666666";
const userMessageId = "c1111111-1111-4111-8111-111111111111";
const assistantMessageId = "c2222222-2222-4222-8222-222222222222";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = "http://127.0.0.1:4173";
const resultsDir = "D:/Develop/Relay-Agent/apps/workbench/results";

const DRAFT = "先把要做的事说清楚：这一段是流式草稿，长度中等，用来量行高、左缘与换行节奏。";
const FINAL = [
  "## 已完成",
  "",
  "最终正文第一段。交接之后这一份才是可引用的结论，草稿不再出现。",
  "",
  "- 要点一：读取了工作目录",
  "- 要点二：把结果写在下面",
  "",
  "```bash",
  "git status --short",
  "```"
].join("\n");

type Phase = "draft" | "settling" | "final" | "history";

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
  created_at: "2026-10-25T09:00:00Z", updated_at: "2026-10-25T09:00:00Z" };

function message(id: string, seq: string, role: "USER" | "ASSISTANT", status: string,
  content: string | null) {
  return { id, session_id: sessionId, seq, role, status, intent: "DISCUSS", content,
    error_code: null, provider_error_kind: null, sources: [], skill: null, cancel_requested: false,
    steer_requested: false, attachments: [], created_at: "2026-10-25T09:00:00Z",
    updated_at: "2026-10-25T09:00:00Z",
    usage: { input_tokens: 1200, output_tokens: 180, cache_read_tokens: null, cache_creation_tokens: null } };
}

/** 交接现场的会话：一条用户消息 + 一条正在生成的助手回复。 */
function liveMessages(phase: Phase) {
  const status = phase === "final" ? "COMPLETED" : "RUNNING";
  return [
    message(userMessageId, "1", "USER", "COMPLETED", "帮我把这次的结论整理一下"),
    message(assistantMessageId, "2", "ASSISTANT", status, phase === "final" ? FINAL : null)
  ];
}

/** 长会话：用来验证「用户上滚时不被拉回底部」。 */
function historyMessages(count: number, phase: Phase) {
  const items = [];
  for (let index = 0; index < count; index += 1) {
    items.push(message(`a0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      String(index * 2 + 1), "USER", "COMPLETED", `第 ${index + 1} 轮的问题：继续。`));
    items.push(message(`b0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      String(index * 2 + 2), "ASSISTANT", "COMPLETED",
      `第 ${index + 1} 轮的回答：\n\n- 一句结论\n- 一句补充\n- 一句下一步`));
  }
  items.push(message(userMessageId, "901", "USER", "COMPLETED", "再看一眼最新那条"));
  items.push(message(assistantMessageId, "902", "ASSISTANT",
    phase === "final" ? "COMPLETED" : "RUNNING", phase === "final" ? FINAL : null));
  return items;
}

/** 真实工具账本：过程区读的就是这一份，摘要行据此说人话。 */
function toolCalls(settled: boolean) {
  const base = { arguments_sha256: "a".repeat(64), provider_tool_call_id: "call-1",
    operation_id: null, rejection_reason: null, rejection_detail: null, result_digest: null };
  const calls = [
    { ...base, id: "d1111111-1111-4111-8111-111111111111", round: 0, ordinal: 0,
      tool_name: "read_file", status: "SETTLED", arguments: { relative_path: "README.md" },
      requested_at: "2026-10-25T09:00:01.000Z", settled_at: "2026-10-25T09:00:01.400Z" },
    { ...base, id: "d2222222-2222-4222-8222-222222222222", round: 0, ordinal: 1,
      tool_name: "list_directory", status: settled ? "SETTLED" : "REQUESTED",
      arguments: { relative_path: "apps/workbench" },
      requested_at: "2026-10-25T09:00:02.000Z",
      settled_at: settled ? "2026-10-25T09:00:02.300Z" : null }
  ];
  return { session_id: sessionId, message_id: assistantMessageId,
    message_status: settled ? "COMPLETED" : "RUNNING", rounds: [{ round: 0, calls }] };
}

async function installRoutes(page: Page, state: {
  phase: () => Phase;
  messages: () => unknown[];
  holdMessages?: () => boolean;
}) {
  // 「终态已到、正文未读回」那一段可能同时有两条读取在飞（SSE 终态帧触发的那次 + 1.5s 轮询），
  // 全部挂住再一起放行：只放行其中一条的话，后发的那次会以更高版本号把交接结果丢掉。
  const pending: Array<() => void> = [];
  const tap = () => ({
    release: () => { for (const resolve of pending.splice(0)) resolve(); }
  });
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
    // 计划与目标投影：这两个读取失败会在会话顶部留一条黄色告警，截图会被它带偏。
    if (path === `${prefix}/assist-sessions/${sessionId}/plans`)
      return fulfillJson(route, { latest: null, versions: [] });
    if (path === `${prefix}/assist-sessions/${sessionId}/goal`)
      return fulfillJson(route, { goal: null, rounds: [] });
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) {
      if (state.holdMessages?.() === true) {
        await new Promise<void>((resolve) => { pending.push(resolve); });
      }
      return fulfillJson(route, { items: state.messages() });
    }
    if (path.endsWith("/live-preview/events")) {
      // SSE 端点不可用（502）：走已实现的有界 GET 轮询回退，画面行为与生产一致。
      await route.fulfill({ status: 502, headers: cors(), body: "" });
      return;
    }
    if (path.endsWith("/live-preview")) {
      const phase = state.phase();
      const running = phase === "draft" || phase === "history";
      return fulfillJson(route, { session_id: sessionId, message_id: assistantMessageId,
        status: running ? "RUNNING" : "COMPLETED", preview_revision: running ? "3" : "0",
        preview_text: running ? DRAFT : null, preview_truncated: false, preview_available: running });
    }
    if (path.includes("conversation-diff")) return fulfillJson(route, { session_id: sessionId, files: [],
      unavailable_files: 0, unverifiable_files: 0, baseline: null, incomplete: false });
    if (path.endsWith("/tool-calls"))
      return fulfillJson(route, toolCalls(state.phase() === "final"));
    if (/\/assist-messages\/[^/]+\/model-runtime$/u.test(path)) return fulfillJson(route, {
      message_id: assistantMessageId, message_status: "COMPLETED", snapshot_available: false,
      preferred_model: null, candidate_models: [], current_candidate_model: null, actual_model: null,
      max_candidates: null, routing_status: null, failure_scope: null, failure_reason: null,
      retry_after_at: null, free_daily_remaining: null, switches: [], calls: [] });
    return fulfillJson(route, { items: [], next_cursor: null });
  });
  return tap;
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("reply-handover-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

function save(name: string): { path: string } { return { path: `${resultsDir}/${name}.png` }; }

test.describe("草稿与最终正文的交接", () => {
  test("同一阅读区、无空白帧、只出现一次正文、一次性淡入", async ({ page }) => {
    fs.mkdirSync(resultsDir, { recursive: true });
    await page.setViewportSize({ width: 1270, height: 900 });
    let phase: Phase = "draft";
    const tap = await installRoutes(page, {
      phase: () => phase,
      messages: () => liveMessages(phase),
      holdMessages: () => phase === "settling"
    });
    await page.goto(`/projects/${projectId}?skill=assist`);
    await connect(page);

    const reply = page.locator(`[data-testid="assist-live-preview-${assistantMessageId}"]`);
    await reply.waitFor({ timeout: 30_000 });
    const draftGeo = await reply.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const text = node.querySelector(".assist-reply-draft");
      const computed = text === null ? null : getComputedStyle(text);
      const self = getComputedStyle(node);
      const host = node.closest(".agent-message-body");
      return { left: Math.round(box.left), width: Math.round(box.width),
        fontSize: computed?.fontSize ?? "", lineHeight: computed?.lineHeight ?? "",
        padding: self.padding, background: self.backgroundColor, borderWidth: self.borderTopWidth,
        hostLeft: host === null ? null : Math.round(host.getBoundingClientRect().left) };
    });
    // 草稿不是卡片：无内边距、无底色、无边框（此前是浅底 + 细框的大卡片）。
    expect(draftGeo.padding).toBe("0px");
    expect(draftGeo.background).toBe("rgba(0, 0, 0, 0)");
    expect(draftGeo.borderWidth).toBe("0px");
    // 与正文档一致：16px / relaxed(1.7 → 27.2px)，交接时高度差只剩块距。
    expect(draftGeo.fontSize).toBe("16px");
    expect(draftGeo.lineHeight).toBe("27.2px");
    expect(draftGeo.left).toBe(draftGeo.hostLeft);
    await page.screenshot(save("assist-reply-01-draft"));

    // 终态帧到达，正文那次读取故意挂住：草稿必须还在（不出现空白帧），三点已经撤掉。
    phase = "settling";
    const verifying = page.locator(`[data-testid="assist-reply-verify-${assistantMessageId}"]`);
    await verifying.waitFor({ timeout: 10_000 });
    await expect(verifying).toContainText("正在核对最终正文");
    await expect(verifying).toContainText(DRAFT);
    await expect(page.locator(".assist-inflight-dots")).toHaveCount(0);
    await expect(page.locator(".agent-message-status")).toContainText("正在核对最终回复");
    const verifyGeo = await verifying.evaluate((node) => {
      const box = node.getBoundingClientRect();
      return { left: Math.round(box.left), width: Math.round(box.width),
        text: node.querySelector(".assist-reply-draft")?.textContent?.length ?? 0 };
    });
    // 草稿还在同一列、同一宽度：宽度不变说明没有被塞进另一层盒子。
    expect(verifyGeo.left).toBe(draftGeo.left);
    expect(verifyGeo.width).toBe(draftGeo.width);
    expect(verifyGeo.text).toBeGreaterThan(0);
    await page.screenshot(save("assist-reply-02-verifying"));

    // 正文读回：交接成立，只出现一次，且只在一次淡入里出现。
    phase = "final";
    tap().release();
    const final = page.locator(`[data-testid="assist-reply-final-${assistantMessageId}"]`);
    await final.waitFor({ timeout: 10_000 });
    await expect(page.locator(`[data-testid="assist-reply-verify-${assistantMessageId}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-testid="assist-live-preview-${assistantMessageId}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-testid="assist-reply-final-${assistantMessageId}"]`)).toHaveCount(1);
    await expect(final).toContainText("最终正文第一段");
    await expect(page.locator(`article.agent-message[data-role="ASSISTANT"] .agent-message-body`))
      .not.toContainText(DRAFT);
    const finalGeo = await final.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const computed = getComputedStyle(node);
      return { left: Math.round(box.left), width: Math.round(box.width),
        handover: node.getAttribute("data-handover"),
        animationName: computed.animationName, animationDuration: computed.animationDuration,
        timeline: computed.animationTimingFunction };
    });
    // 左缘与宽度与草稿完全一致：交接没有横向位移，也没有换列。
    expect(finalGeo.left).toBe(draftGeo.left);
    expect(finalGeo.width).toBe(draftGeo.width);
    expect(finalGeo.handover).toBe("true");
    // 只做一次 opacity 淡入：motion.panel(180ms) + 标准缓动，没有位移/缩放。
    expect(finalGeo.animationName).toBe("assist-reply-handover");
    expect(finalGeo.animationDuration).toBe("0.18s");
    expect(finalGeo.timeline).toBe("cubic-bezier(0.2, 0, 0, 1)");
    // 页脚（复制/用量）只在完成后出现一次，不在交接中途先出现再消失。
    await expect(page.locator(`[data-testid="assist-copy-${assistantMessageId}"]`)).toHaveCount(1);
    await page.screenshot(save("assist-reply-03-final"));
  });

  test("用户已上滚时不被拉回底部：完成不会抢走阅读位置", async ({ page }) => {
    await page.setViewportSize({ width: 1270, height: 760 });
    let phase: Phase = "history";
    const tap = await installRoutes(page, { phase: () => phase,
      messages: () => historyMessages(9, phase), holdMessages: () => phase === "settling" });
    await page.goto(`/projects/${projectId}?skill=assist`);
    await connect(page);
    const transcript = page.getByTestId("assist-transcript");
    await transcript.waitFor({ timeout: 30_000 });
    await page.locator(`[data-testid="assist-live-preview-${assistantMessageId}"]`).waitFor({ timeout: 30_000 });

    // 主动上滚：离开底部之后 followLatest 必须变成 false。
    await transcript.evaluate((node) => { node.scrollTop = 0; node.dispatchEvent(new Event("scroll")); });
    await page.waitForTimeout(120);
    const before = await transcript.evaluate((node) => node.scrollTop);
    await expect(page.getByTestId("assist-latest")).toBeVisible();

    phase = "settling";
    await page.locator(`[data-testid="assist-reply-verify-${assistantMessageId}"]`).waitFor({ timeout: 10_000 });
    phase = "final";
    tap().release();
    await page.locator(`[data-testid="assist-reply-final-${assistantMessageId}"]`).waitFor({ timeout: 10_000 });
    await page.waitForTimeout(200);
    const after = await transcript.evaluate((node) => node.scrollTop);
    // 允许滚动锚定带来的 1px 级别修正，但不允许被拉到底部。
    expect(Math.abs(after - before)).toBeLessThanOrEqual(2);
    await expect(page.getByTestId("assist-latest")).toBeVisible();
    await page.screenshot(save("assist-reply-04-scrolled-up"));
  });

  test("窄窗口下草稿与最终正文都不产生页面级横向溢出", async ({ page }) => {
    await page.setViewportSize({ width: 860, height: 800 });
    let phase: Phase = "draft";
    const tap = await installRoutes(page, { phase: () => phase,
      messages: () => liveMessages(phase), holdMessages: () => phase === "settling" });
    await page.goto(`/projects/${projectId}?skill=assist`);
    await connect(page);
    await page.locator(`[data-testid="assist-live-preview-${assistantMessageId}"]`).waitFor({ timeout: 30_000 });

    const read = () => page.evaluate(() => {
      const root = document.documentElement;
      const reply = document.querySelector(".assist-reply");
      const box = reply?.getBoundingClientRect() ?? null;
      return { pageOverflow: root.scrollWidth - root.clientWidth,
        replyOverflow: reply === null ? 0 : reply.scrollWidth - reply.clientWidth,
        replyWidth: box === null ? 0 : Math.round(box.width),
        viewport: window.innerWidth };
    });
    const draft = await read();
    expect(draft.pageOverflow).toBeLessThanOrEqual(1);
    expect(draft.replyOverflow).toBeLessThanOrEqual(1);
    expect(draft.replyWidth).toBeLessThanOrEqual(draft.viewport);

    phase = "settling";
    await page.locator(`[data-testid="assist-reply-verify-${assistantMessageId}"]`).waitFor({ timeout: 10_000 });
    expect((await read()).pageOverflow).toBeLessThanOrEqual(1);

    phase = "final";
    tap().release();
    await page.locator(`[data-testid="assist-reply-final-${assistantMessageId}"]`).waitFor({ timeout: 10_000 });
    // 最终正文里有一张代码块（fence）：它必须在自己的滚动盒里，不能把整页撑宽。
    const settled = await read();
    expect(settled.pageOverflow).toBeLessThanOrEqual(1);
    expect(settled.replyOverflow).toBeLessThanOrEqual(1);
    await page.screenshot(save("assist-reply-05-narrow"));
  });

  test("reduced-motion：交接立即呈现静态终态，内容与操作一样都不缺", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1270, height: 900 });
    let phase: Phase = "draft";
    const tap = await installRoutes(page, { phase: () => phase,
      messages: () => liveMessages(phase), holdMessages: () => phase === "settling" });
    await page.goto(`/projects/${projectId}?skill=assist`);
    await connect(page);
    await page.locator(`[data-testid="assist-live-preview-${assistantMessageId}"]`).waitFor({ timeout: 30_000 });
    phase = "settling";
    await page.locator(`[data-testid="assist-reply-verify-${assistantMessageId}"]`).waitFor({ timeout: 10_000 });
    phase = "final";
    tap().release();
    const final = page.locator(`[data-testid="assist-reply-final-${assistantMessageId}"]`);
    await final.waitFor({ timeout: 10_000 });
    const duration = await final.evaluate((node) => getComputedStyle(node).animationDuration);
    // 全局 reduced-motion 规则把过渡时长归零：不留一个 180ms 的动效。
    expect(duration).toBe("0s");
    await expect(final).toBeVisible();
    await expect(final).toContainText("最终正文第一段");
    const opacity = await final.evaluate((node) => getComputedStyle(node).opacity);
    expect(opacity).toBe("1");
  });

  test("本机关闭动效（html[data-motion=off]）：不加那一下淡入，文字与复制键照旧", async ({ page }) => {
    await page.addInitScript(() => { window.localStorage.setItem("relay.motion", "off"); });
    await page.setViewportSize({ width: 1270, height: 900 });
    let phase: Phase = "draft";
    const tap = await installRoutes(page, { phase: () => phase,
      messages: () => liveMessages(phase), holdMessages: () => phase === "settling" });
    await page.goto(`/projects/${projectId}?skill=assist`);
    await connect(page);
    await page.locator(`[data-testid="assist-live-preview-${assistantMessageId}"]`).waitFor({ timeout: 30_000 });
    phase = "settling";
    await page.locator(`[data-testid="assist-reply-verify-${assistantMessageId}"]`).waitFor({ timeout: 10_000 });
    phase = "final";
    tap().release();
    const final = page.locator(`[data-testid="assist-reply-final-${assistantMessageId}"]`);
    await final.waitFor({ timeout: 10_000 });
    await expect(page.locator("html")).toHaveAttribute("data-motion", "off");
    const name = await final.evaluate((node) => getComputedStyle(node).animationName);
    expect(name).toBe("none");
    await expect(page.locator(`[data-testid="assist-copy-${assistantMessageId}"]`)).toHaveCount(1);
  });
});
