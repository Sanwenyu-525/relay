import { expect, test, type Page, type Route } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";

// 一次性验收探针（2026-10-21，output/triage/ui.md）：不新增产品断言，只量三个「jsdom 看不见」的事实——
// ① 提交窗口内输入正文/发送键是否被全局禁用配色染色（诉求「发送的时候输入框这部分会变色」）；
// ② 输入框底栏一行的竖直重心是否落在同一中轴（诉求「调整输入框底部竖直重心高度」）；
// ③ 空队列占位是否真的不占高（诉求「消息发出去后聊天区域有问题」里被挤掉的转录区）。
// API 全部由 page.route 伪造，不连数据库、不调 Provider。测量结果写 output/triage/probe-ui-geometry.json。

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const sessionId = "66666666-6666-4666-8666-666666666666";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = "http://127.0.0.1:4173";
const outDir = "../../output";

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin, "access-control-allow-headers": "Authorization, Content-Type" };
}
async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: "application/json", headers: cors(), body: JSON.stringify(body) });
}
const session = { id: sessionId, workspace_id: workspaceId, project_id: projectId, task_id: null,
  title: "验收探针", status: "ACTIVE", revision: "1", working_resource_id: null, context: {},
  created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z" };

async function installRoutes(page: Page): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/model-port`) return fulfillJson(route, { provider: "fake", configured: false,
      model: null, base_url: null, max_call_tokens: null });
    if (path === `${prefix}/assist-sessions/${sessionId}`) return fulfillJson(route, session);
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return fulfillJson(route, { items: [] });
    if (path === `${prefix}/assist-sessions`) return fulfillJson(route, { items: [session] });
    return fulfillJson(route, { items: [], next_cursor: null });
  });
}
async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("triage-probe-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

test.describe("UI 验收探针", () => {
  test.use({ viewport: { width: 1487, height: 1058 } });

  test("提交窗口配色 / 底栏竖直重心 / 空队列占位高度", async ({ page }) => {
    const results: Record<string, unknown> = {};
    await installRoutes(page);
    await page.goto("/agent?new=triage");
    await connect(page);
    const composer = page.locator(".agent-chat-composer");
    await expect(composer).toBeVisible({ timeout: 20_000 });
    const area = await composer.boundingBox();
    if (area) await page.screenshot({ path: `${outDir}/playwright/triage-composer-idle.png`,
      clip: { x: Math.max(0, area.x - 8), y: Math.max(0, area.y - 56), width: area.width + 16, height: area.height + 64 } });

    const read = (sel: string) => page.locator(sel).first().evaluate((el) => {
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, color: cs.color, opacity: cs.opacity, fill: cs.webkitTextFillColor };
    });
    const textarea = composer.locator(".field textarea").first();
    results.beforeDisabled = await textarea.evaluate((el) => {
      const cs = getComputedStyle(el as HTMLElement);
      return { bg: cs.backgroundColor, color: cs.color, disabled: (el as HTMLTextAreaElement).disabled };
    });
    // 复刻提交窗口：busy/pending 会把正文与发送键置 disabled。这里直接强制 disabled，
    // 让真实的 CSS 特异度对决在 Chromium 里跑一遍（jsdom 不加载应用样式表，看不见这条）。
    await textarea.evaluate((el) => { (el as HTMLTextAreaElement).disabled = true; });
    await page.locator(".agent-chat-composer .agent-chat-send").evaluate((el) => {
      (el as HTMLButtonElement).disabled = true; el.setAttribute("data-busy", "true"); });
    await page.waitForTimeout(300);            // 跨过 motion.fast（120ms）的过渡
    results.afterDisabled = await read(".agent-chat-composer .field textarea");
    results.sendAfterDisabled = await read(".agent-chat-composer .agent-chat-send");
    results.sendBeforeDisabled = null;
    results.globalDisabledReference = await page.evaluate(() => {
      // 参照物：不在 composer / create-form 里的 textarea 被禁用时，全局档会染成什么。
      const probe = document.createElement("textarea");
      probe.disabled = true; probe.className = "field-textarea-reference";
      document.body.appendChild(probe);
      const bg = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return bg;
    });
    await textarea.evaluate((el) => { (el as HTMLTextAreaElement).disabled = false; });
    await page.locator(".agent-chat-composer .agent-chat-send").evaluate((el) => {
      (el as HTMLButtonElement).disabled = false; el.removeAttribute("data-busy"); });

    results.toolsRow = await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".agent-chat-composer-tools, .agent-chat-composer-tail")];
      const items = rows.flatMap((row) => [...row.children]).filter((el) => {
        const b = (el as HTMLElement).getBoundingClientRect();
        return b.width > 0 && b.height > 0;
      });
      const boxes = items.map((el) => {
        const b = (el as HTMLElement).getBoundingClientRect();
        return { cls: el.className.split(" ")[0] ?? el.tagName, top: b.top, bottom: b.bottom,
          height: b.height, centerY: b.top + b.height / 2 };
      });
      const send = document.querySelector(".agent-chat-composer .agent-chat-send");
      const sb = send ? (send as HTMLElement).getBoundingClientRect() : null;
      return { boxes, send: sb ? { top: sb.top, bottom: sb.bottom, height: sb.height,
        centerY: sb.top + sb.height / 2 } : null,
        spreadPx: boxes.length ? Math.max(...boxes.map((x) => x.centerY)) - Math.min(...boxes.map((x) => x.centerY)) : null };
    });
    const second = await composer.boundingBox();
    if (second) await page.screenshot({ path: `${outDir}/playwright/triage-composer-tools-row.png`,
      clip: { x: Math.max(0, second.x - 8), y: Math.max(0, second.y + second.height - 90),
        width: second.width + 16, height: 96 } });

    // 空队列占位：注入与产品同类的节点，量它在真实样式表下占不占高度。
    results.emptyQueuePlaceholder = await page.evaluate(() => {
      const host = document.querySelector(".agent-chat-transcript") ?? document.body;
      const el = document.createElement("div");
      el.className = "assist-queue"; el.setAttribute("data-empty", "true");
      host.appendChild(el);
      const b = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const transcript = document.querySelector(".agent-chat-transcript");
      const tb = transcript ? (transcript as HTMLElement).getBoundingClientRect() : null;
      el.remove();
      return { display: cs.display, height: b.height,
        transcriptHeight: tb ? tb.height : null };
    });
    results.firstComposerQueueCount = await page.locator(".assist-queue").count();

    mkdirSync(`${outDir}/triage`, { recursive: true });
    writeFileSync(`${outDir}/triage/probe-ui-geometry.json`, JSON.stringify(results, null, 2));
    expect(results.toolsRow).toBeTruthy();
  });
});
