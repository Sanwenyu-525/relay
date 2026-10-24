import { expect, test, type Page, type Route } from "@playwright/test";

// 输入器两枚浮层（普通讨论＝发送选项、资料）的几何与互斥常驻用例（工作台 §32.16，2026-10-24）。
//
// 背景：用户截图「浮层宽度跟输入框一样而且样式不好看」+「两个弹窗同时开着」。
// 本轮三组改动各有一条不变式在这里锁：
//   ① 锚定与定宽：details 自建包含块，面板左缘贴芯片（或翻面后右缘贴芯片），
//      宽度 max(内容, 芯片) 且封顶 20rem；**必须待在输入卡内**——中栏 .collab-center 是
//      overflow:hidden，越出即被裁（1000px 视口实测右缘 1035 越界后检索行不可达）。
//   ② 翻面现算（usePopupFlip 写 data-flip）：资料芯片窄窗会随工具行换行到卡片左缘，
//      静态翻面在那时会裁左缘，所以不断言「一定翻/一定不翻」，只断言「两缘必有一缘贴芯片」。
//   ③ 多开互斥：首条资料浮层补注册 useDetailsMenu 前，它能和「普通讨论」说明浮层同时开着
//      （用户截图现场）；点外面也曾不收。
//   ④ 在途不裁：输入卡 data-inflight 不再 overflow:hidden（收边移到 .agent-chat-composer-spark-clip），
//      在途态开资料浮层，检索行必须可达。
//
// 只连页面内夹具：不连数据库、不调 Provider、不写任何真实业务事实。

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const sessionId = "66666666-6666-4666-8666-666666666666";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = "http://127.0.0.1:4173";

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin, "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(), body: JSON.stringify(body) });
}

const session = { id: sessionId, workspace_id: workspaceId, project_id: projectId, task_id: taskId,
  title: "关于确定实验评价指标", status: "ACTIVE", revision: "1",
  working_resource_id: "99999999-9999-4999-8999-999999999999",
  context: { project_goals: [], working_directory: {
    resource_id: "99999999-9999-4999-8999-999999999999", canonical_root: "D:\\Work\\Research" } },
  created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z" };

/** 在途态：一条 RUNNING 助手回复，输入卡带 data-inflight。 */
const runningMessage = { id: "77777777-7777-4777-8777-777777777777", session_id: sessionId,
  role: "ASSISTANT", status: "RUNNING", seq: "1", intent: "DISCUSS", content: "正在生成中的回复",
  error_code: null, provider_error_kind: null, cancel_requested: false, steer_requested: false,
  usage: { input_tokens: 0, output_tokens: 0 }, sources: [], skill: null, skill_input: null, skill_output: null,
  attachments: [], created_at: "2026-10-24T00:00:00Z", updated_at: "2026-10-24T00:00:00Z", revision: "1" };

async function installRoutes(page: Page, inflight = false): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/tasks/${taskId}`) return fulfillJson(route, { id: taskId, project_id: projectId,
      title: "整理实验评价指标", status: "IN_PROGRESS", mode: "ME", revision: "2",
      created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z",
      executor: { kind: "HUMAN", run_id: null, ownership_epoch: "1" },
      current_completion_id: null, waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [],
      allowed_actions: [],
      acceptance: { acceptance_revision: "2", objective: "补齐基线与验收依据。", source: "CREATE",
        created_at: "2026-10-16T00:00:00Z", criteria: [] },
      dependencies: [] });
    if (path === `${prefix}/projects/${projectId}`) return fulfillJson(route, { id: projectId,
      title: "Windows 桌面验收（测试）", project_type: "GENERAL", revision: "1", state_revision: "1",
      archived_at: null });
    if (path === `${prefix}/search`) return fulfillJson(route, { items: [], next_cursor: null });
    if (path === `${prefix}/model-port`) return fulfillJson(route, { provider: "fake",
      configured: false, model: null, base_url: null, max_call_tokens: null });
    if (path === `${prefix}/assist-sessions`) return fulfillJson(route, { items: [session] });
    if (path === `${prefix}/assist-sessions/${sessionId}`) return fulfillJson(route, session);
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) {
      return fulfillJson(route, { items: inflight ? [runningMessage] : [] });
    }
    if (path === `${prefix}/skill-definitions`) return fulfillJson(route, { items: [] });
    return fulfillJson(route, { items: [], next_cursor: null });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("popup-geometry-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

interface Box { left: number; top: number; right: number; bottom: number; width: number; height: number }

interface PopupShot {
  chip: Box | null; panel: Box | null; card: Box | null; draft: Box | null; send: Box | null;
  pageOverflowX: number; viewport: { width: number; height: number };
}

/** 几何采样：入口芯片（summary）、展开面板、输入卡、草稿、发送键。全部限定在会话输入器内。 */
async function measurePopup(page: Page, detailsSelector: string): Promise<PopupShot> {
  return page.evaluate((selector) => {
    const root = document.querySelector('[data-testid="assist-composer"]');
    if (root === null) throw new Error("缺少输入器容器");
    const details = root.querySelector(selector);
    if (details === null) throw new Error(`缺少浮层 ${selector}`);
    const summary = details.querySelector("summary");
    const panel = details.querySelector(".agent-chat-options-panel");
    const box = (target: Element | null) => {
      if (target === null) return null;
      const rect = target.getBoundingClientRect();
      return { left: Math.round(rect.left * 10) / 10, width: Math.round(rect.width * 10) / 10,
        right: Math.round(rect.right * 10) / 10, top: Math.round(rect.top * 10) / 10,
        bottom: Math.round(rect.bottom * 10) / 10, height: Math.round(rect.height * 10) / 10 };
    };
    return {
      chip: box(summary), panel: box(panel), card: box(root),
      draft: box(root.querySelector('[data-testid="assist-draft"]')),
      send: box(root.querySelector('[data-testid="assist-send"]')),
      pageOverflowX: (document.scrollingElement as HTMLElement).scrollWidth - (document.scrollingElement as HTMLElement).clientWidth,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  }, detailsSelector);
}

for (const viewport of [{ width: 1162, height: 782 }, { width: 1000, height: 800 }, { width: 860, height: 800 }] as const) {
  test(`${viewport.width}×${viewport.height}：资料/普通讨论浮层锚定芯片、紧凑宽、待在卡内、不压发送键`, async ({ page }) => {
    const label = `${viewport.width}×${viewport.height}`;
    await page.setViewportSize(viewport);
    await installRoutes(page);
    await page.goto(`/agent?work=${taskId}&session=${sessionId}`);
    await connect(page);
    const composer = page.getByTestId("assist-composer");
    await page.getByTestId("collab-conversation-toolbar").waitFor({ timeout: 20_000 });

    // 资料浮层：开 → 量 → 关（点 summary 即关）。
    await page.getByTestId("assist-open-sources").click();
    await composer.locator("#assist-source-query").waitFor({ state: "visible", timeout: 20_000 });
    const sources = await measurePopup(page, ".agent-chat-source-options");
    await page.getByTestId("assist-open-sources").click();

    // 普通讨论（发送选项）浮层：互斥注册保证上一枚已收，这里直接量。
    const sendSummary = page.locator(".agent-chat-send-options > summary");
    await sendSummary.click();
    await expect(page.locator(".agent-chat-send-options > .agent-chat-options-panel")).toBeVisible();
    const send = await measurePopup(page, ".agent-chat-send-options");

    // 原始几何留在日志里作为证据（数值只反映夹具布局，不连真实 API）。
    console.log(JSON.stringify({ label, sources, send }));

    for (const [name, shot] of [["资料", sources], ["普通讨论", send]] as const) {
      const { chip, panel, card, draft, send: sendBox, pageOverflowX, viewport: vp } = shot;
      if (chip === null || panel === null || card === null) throw new Error(`${label} · ${name} 缺少采样`);
      // 1. 贴芯片：左缘或右缘必有一缘与芯片对齐（翻面由 usePopupFlip 现算，哪个视口翻不一定）。
      const leftAligned = Math.abs(panel.left - chip.left) <= 1;
      const rightAligned = Math.abs(panel.right - chip.right) <= 1;
      expect(leftAligned || rightAligned, `${label} · ${name} 浮层两缘都不贴芯片`).toBe(true);
      // 2. 宽度：不小于芯片、不超过 20rem 封顶。
      expect(panel.width, `${label} · ${name} 浮层窄于芯片`).toBeGreaterThanOrEqual(chip.width - 0.5);
      expect(panel.width, `${label} · ${name} 浮层超过 20rem 封顶`).toBeLessThanOrEqual(320.5);
      // 3. 待在输入卡内（中栏 overflow:hidden，越出即被裁）、不越视口、页面不横向溢出。
      expect(panel.left, `${label} · ${name} 浮层左缘越出输入卡`).toBeGreaterThanOrEqual(card.left - 0.5);
      expect(panel.right, `${label} · ${name} 浮层右缘越出输入卡`).toBeLessThanOrEqual(card.right + 0.5);
      expect(panel.left, `${label} · ${name} 浮层左缘越出视口`).toBeGreaterThanOrEqual(-0.5);
      expect(panel.right, `${label} · ${name} 浮层右缘越出视口`).toBeLessThanOrEqual(vp.width + 0.5);
      expect(pageOverflowX, `${label} · ${name} 页面横向溢出`).toBe(0);
      // 4. 草稿仍在视口内（浮层开着时短暂盖住草稿，与档位菜单同一模式，DEV-0116 起接受）；
      //    发送键不被浮层压住。
      if (draft !== null) {
        expect(draft.top, `${label} · ${name} 草稿上缘越出视口`).toBeGreaterThanOrEqual(-0.5);
        expect(draft.bottom, `${label} · ${name} 草稿下缘越出视口`).toBeLessThanOrEqual(vp.height + 0.5);
      }
      const overlap = (a: Box, b: Box | null) => b === null ? 0 :
        Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      expect(overlap(panel, sendBox), `${label} · ${name} 浮层压住发送键`).toBeLessThanOrEqual(0.5);
    }
  });
}

test("在途态（data-inflight）：资料浮层不被输入卡裁掉，检索行可达", async ({ page }) => {
  await page.setViewportSize({ width: 1162, height: 782 });
  await installRoutes(page, true);
  await page.goto(`/agent?work=${taskId}&session=${sessionId}`);
  await connect(page);
  const composer = page.getByTestId("assist-composer");
  await page.getByTestId("collab-conversation-toolbar").waitFor({ timeout: 20_000 });
  await expect(composer).toHaveAttribute("data-inflight", "true", { timeout: 20_000 });
  await page.getByTestId("assist-open-sources").click();
  await composer.locator("#assist-source-query").waitFor({ state: "visible", timeout: 20_000 });
  // 检索行必须真的可命中：输入卡在途不再 overflow:hidden（收边移到光点裁剪壳）。
  const hit = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="assist-composer"]');
    const query = root?.querySelector("#assist-source-query") ?? null;
    if (query === null) return "missing";
    const rect = query.getBoundingClientRect();
    const point = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (point === null) return "no-element";
    return query.contains(point) ? "self" : (point as Element).className || (point as Element).tagName;
  });
  expect(hit, "在途态检索行应可达（不被输入卡裁掉）").toBe("self");
});

test("多开防护：首条输入器两枚浮层互斥且点外面可收，会话内同样互斥", async ({ page }) => {
  await page.setViewportSize({ width: 1162, height: 782 });
  await installRoutes(page);
  // 首条输入器（带项目作用域，资料入口才在场）：用户截图「两个弹窗同时开着」的现场。
  // ?new= 强制新对话（不带它 work= 会恢复该任务最近会话，渲染的就是会话输入器）；
  // task 深链给 firstScope.projectId，资料入口因此在场。
  await page.goto(`/agent?work=${taskId}&new=1`);
  await connect(page);
  const first = page.getByTestId("assist-first-send-options");
  const firstSources = page.getByTestId("assist-first-source-options");
  await first.locator("> summary").waitFor({ state: "visible", timeout: 20_000 });
  await firstSources.locator("> summary").waitFor({ state: "visible", timeout: 20_000 });

  const openState = () => page.evaluate(() => {
    const root = document.querySelector('[data-testid="assist-first-source-options"]')?.closest(".agent-chat-composer")
      ?? document.querySelector(".agent-chat-composer");
    if (root === null || root === undefined) return { options: -1, firstOptions: false, firstSources: false };
    return {
      options: root.querySelectorAll("details.agent-chat-options[open]:not(.assist-options-expanded)").length,
      firstOptions: root.querySelector("details.agent-chat-options:not(.agent-chat-source-options)")?.hasAttribute("open") ?? false,
      firstSources: root.querySelector("details.agent-chat-source-options")?.hasAttribute("open") ?? false,
    };
  });

  // 1. 先开「普通讨论」说明浮层，再点「资料」：只剩资料开着。
  await first.locator("> summary").click();
  expect((await openState()).firstOptions).toBe(true);
  await firstSources.locator("> summary").click();
  const afterSources = await openState();
  expect(afterSources.firstSources, "点资料后资料浮层应打开").toBe(true);
  expect(afterSources.firstOptions, "资料浮层打开后普通讨论浮层应被收起（互斥）").toBe(false);
  expect(afterSources.options, "同一时刻只应有一枚输入器浮层开着").toBe(1);

  // 2. 反序：先开资料，再点「普通讨论」——只剩普通讨论开着。
  await firstSources.locator("> summary").click();
  await first.locator("> summary").click();
  const afterOptions = await openState();
  expect(afterOptions.firstOptions).toBe(true);
  expect(afterOptions.firstSources, "普通讨论浮层打开后资料浮层应被收起（互斥）").toBe(false);
  expect(afterOptions.options).toBe(1);

  // 3. 点浮层外面要收（此前首条资料浮层没接外部关闭，点哪儿都不收）。
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await expect.poll(async () => (await openState()).options, { timeout: 5_000 }).toBe(0);

  // 4. 会话内两枚同样互斥（回归：它们本就注册过，修复不能破坏）。
  await page.goto(`/agent?work=${taskId}&session=${sessionId}`);
  await connect(page);
  await page.getByTestId("collab-conversation-toolbar").waitFor({ timeout: 20_000 });
  const sendSummary = page.locator(".agent-chat-send-options > summary");
  await page.getByTestId("assist-open-sources").click();
  await sendSummary.click();
  const sessionState = await page.evaluate(() => ({
    send: document.querySelector("details.agent-chat-send-options")?.hasAttribute("open") ?? false,
    sources: document.querySelector("details.agent-chat-source-options")?.hasAttribute("open") ?? false,
    total: document.querySelectorAll("details.agent-chat-options[open]").length,
  }));
  expect(sessionState.send, "会话内点普通讨论后应打开").toBe(true);
  expect(sessionState.sources, "会话内资料浮层应被收起").toBe(false);
  expect(sessionState.total).toBe(1);
});
