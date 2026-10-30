import { expect, test, type Page, type Route } from "@playwright/test";

// 输入器浮层（2026-10-24 用户指令「这两个合成一个芯片就好了」：发送选项说明与资料合成
// 一枚芯片一片浮层）的几何与常驻用例（工作台 §32.16）。
//
// 背景与仍然成立的不变式（原「两枚浮层」的现场按结构已不可能重现，这里换成同等强度判据）：
//   ① 锚定与定宽：details 自建包含块，面板左缘贴芯片（或翻面后右缘贴芯片），
//      宽度 max(内容, 芯片) 且封顶 20rem；**必须待在输入卡内**——中栏 .collab-center 是
//      overflow:hidden，越出即被裁（1000px 视口实测右缘 1035 越界后检索行不可达）。
//   ② 翻面现算（usePopupFlip 写 data-flip）：合并芯片窄窗会随工具行换行到卡片左缘，
//      静态翻面在那时会裁左缘，所以不断言「一定翻/一定不翻」，只断言「两缘必有一缘贴芯片」。
//   ③ 多开防护：合并后每档输入器只有一枚浮层芯片，且它与「+」、模式、档位、模型共用
//      popoverMenu 的独占注册表（src/lib/popoverMenu.ts）——断言改成「输入器内只有一枚
//      details.agent-chat-options」「同一时刻开着的浮层计数为 1」「开别的芯片会收掉这枚」
//      「点浮层外面必收」「开合不改草稿与发送键几何」。一片浮层同时承载说明节与资料节。
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

async function installRoutes(page: Page, inflight = false,
  override: { messages?: unknown[]; maxCallTokens?: number | null } = {}): Promise<void> {
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
    if (path === `${prefix}/default-working-directory`) return fulfillJson(route,
      { resource_id: null, canonical_root: null, display_name: null, write_tier: null,
        default_write_tier: null, context_budget_tokens: null, status: "UNSET", reason: null, revision: "0" });
    if (path === `${prefix}/model-port`) return fulfillJson(route, { provider: "fake",
      configured: false, model: null, base_url: null,
      max_call_tokens: override.maxCallTokens ?? null });
    if (path === `${prefix}/assist-sessions`) return fulfillJson(route, { items: [session] });
    if (path === `${prefix}/assist-sessions/${sessionId}`) return fulfillJson(route, session);
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) {
      return fulfillJson(route, { items: override.messages ?? (inflight ? [runningMessage] : []) });
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

/** 浮层里的分节：合并后一片浮层同时承载发送选项（说明/生成方式）与资料选择器。 */
async function panelSections(page: Page, panelSelector: string): Promise<{
  skill: boolean; intent: boolean; picker: boolean; query: boolean; sections: number } | null> {
  return page.evaluate((selector) => {
    const panel = document.querySelector(selector);
    if (panel === null) return null;
    return {
      skill: panel.querySelector('[data-testid="assist-skill"]') !== null,
      intent: panel.querySelector('[data-testid="assist-intent"]') !== null,
      picker: panel.querySelector('[data-testid="assist-source-picker"]') !== null,
      query: panel.querySelector("#assist-source-query") !== null,
      sections: panel.querySelectorAll(":scope > .agent-chat-options-section").length };
  }, panelSelector);
}

for (const viewport of [{ width: 1162, height: 782 }, { width: 1000, height: 800 }, { width: 860, height: 800 }] as const) {
  test(`${viewport.width}×${viewport.height}：合体浮层锚定芯片、紧凑宽、待在卡内、不压发送键`, async ({ page }) => {
    const label = `${viewport.width}×${viewport.height}`;
    await page.setViewportSize(viewport);
    await installRoutes(page);
    await page.goto(`/agent?work=${taskId}&session=${sessionId}`);
    await connect(page);
    const composer = page.getByTestId("assist-composer");
    await page.getByTestId("collab-conversation-toolbar").waitFor({ timeout: 20_000 });

    // 会话输入器只有这一枚浮层芯片，资料入口的 testid 仍挂在它的 summary 上（AssistView.tsx:4999）。
    await page.getByTestId("assist-open-sources").click();
    await composer.locator("#assist-source-query").waitFor({ state: "visible", timeout: 20_000 });
    const merged = await measurePopup(page, ".agent-chat-send-options");
    const sections = await panelSections(page,
      '[data-testid="assist-composer"] .agent-chat-send-options > .agent-chat-options-panel');
    await page.getByTestId("assist-open-sources").click();
    await expect(composer.locator(".agent-chat-send-options > .agent-chat-options-panel")).toBeHidden();

    // 原始几何留在日志里作为证据（数值只反映夹具布局，不连真实 API）。
    console.log(JSON.stringify({ label, merged, sections }));

    // 1. 一片浮层两节同场：发送选项（生成方式/意图）与资料节（选择器 + 检索行）。
    if (sections === null) throw new Error(`${label} · 缺少合体浮层的分节采样`);
    expect(sections.skill || sections.intent, `${label} · 发送选项节不在合体浮层里`).toBe(true);
    expect(sections.picker, `${label} · 资料节不在合体浮层里`).toBe(true);
    expect(sections.query, `${label} · 检索行不在合体浮层里`).toBe(true);
    expect(sections.sections, `${label} · 资料节不是面板的直接子节`).toBe(1);

    // 2. 几何：贴芯片、紧凑宽、待在输入卡内、不越视口、页面不横向溢出、不压发送键。
    const { chip, panel, card, draft, send: sendBox, pageOverflowX, viewport: vp } = merged;
    if (chip === null || panel === null || card === null) throw new Error(`${label} · 合体浮层缺少采样`);
    // 左缘或右缘必有一缘与芯片对齐（翻面由 usePopupFlip 现算，哪个视口翻不一定）。
    const leftAligned = Math.abs(panel.left - chip.left) <= 1;
    const rightAligned = Math.abs(panel.right - chip.right) <= 1;
    expect(leftAligned || rightAligned, `${label} · 合体浮层两缘都不贴芯片`).toBe(true);
    expect(panel.width, `${label} · 合体浮层窄于芯片`).toBeGreaterThanOrEqual(chip.width - 0.5);
    expect(panel.width, `${label} · 合体浮层超过 20rem 封顶`).toBeLessThanOrEqual(320.5);
    expect(panel.left, `${label} · 合体浮层左缘越出输入卡`).toBeGreaterThanOrEqual(card.left - 0.5);
    expect(panel.right, `${label} · 合体浮层右缘越出输入卡`).toBeLessThanOrEqual(card.right + 0.5);
    expect(panel.left, `${label} · 合体浮层左缘越出视口`).toBeGreaterThanOrEqual(-0.5);
    expect(panel.right, `${label} · 合体浮层右缘越出视口`).toBeLessThanOrEqual(vp.width + 0.5);
    expect(panel.top, `${label} · 合体浮层上缘越出视口`).toBeGreaterThanOrEqual(-0.5);
    expect(pageOverflowX, `${label} · 合体浮层造成页面横向溢出`).toBe(0);
    // 草稿仍在视口内（浮层开着时短暂盖住草稿，与档位菜单同一模式，DEV-0116 起接受）；
    // 发送键不被浮层压住。
    if (draft !== null) {
      expect(draft.top, `${label} · 合体浮层开着时草稿上缘越出视口`).toBeGreaterThanOrEqual(-0.5);
      expect(draft.bottom, `${label} · 合体浮层开着时草稿下缘越出视口`).toBeLessThanOrEqual(vp.height + 0.5);
    }
    const overlap = (a: Box, b: Box | null) => b === null ? 0 :
      Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    expect(overlap(panel, sendBox), `${label} · 合体浮层压住发送键`).toBeLessThanOrEqual(0.5);
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

test("单枚浮层：合体芯片与模式/「+」互斥、点外面可收、开合不改几何（首条与会话内两档输入器）", async ({ page }) => {
  await page.setViewportSize({ width: 1162, height: 782 });
  await installRoutes(page);
  // 首条输入器（带项目作用域，资料节才在场）：用户截图「两个弹窗同时开着」的现场。
  // ?new= 强制新对话（不带它 work= 会恢复该任务最近会话，渲染的就是会话输入器）；
  // task 深链给 firstScope.projectId，资料节因此在场。
  await page.goto(`/agent?work=${taskId}&new=1`);
  await connect(page);
  const first = page.getByTestId("assist-first-send-options");
  await first.locator("> summary").waitFor({ state: "visible", timeout: 20_000 });

  /** 输入器内的浮层计数与草稿/发送键几何：合并后每档只有一枚 details.agent-chat-options，
   *  「两枚里哪枚开着」改为锁「芯片总数 1 且开着的计数 1」，互斥对象换成同排的模式与「+」。 */
  const openState = (scope: "first" | "session") => page.evaluate((which) => {
    const root = which === "first"
      ? document.querySelector('[data-testid="assist-first-send-options"]')?.closest(".agent-chat-composer")
      : document.querySelector('[data-testid="assist-composer"]');
    if (!(root instanceof Element)) return { chips: -1, options: -1, mode: false, attach: false, draft: null, send: null };
    const box = (selector: string) => {
      const element = root.querySelector(selector);
      if (element === null) return null;
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    };
    return {
      chips: root.querySelectorAll("details.agent-chat-options").length,
      options: root.querySelectorAll("details.agent-chat-options[open]:not(.assist-options-expanded)").length,
      mode: root.querySelector("details.agent-chat-mode-select-field")?.hasAttribute("open") ?? false,
      attach: root.querySelector("details.agent-chat-attach")?.hasAttribute("open") ?? false,
      draft: box(which === "first" ? '[data-testid="assist-first-draft"]' : '[data-testid="assist-draft"]'),
      send: box(which === "first" ? '[data-testid="assist-first-send"]' : '[data-testid="assist-send"]'),
    };
  }, scope);

  // 1. 构造上不可能多开：首条输入器只有一枚浮层芯片，展开时开着的也只有这一枚。
  const before = await openState("first");
  expect(before.chips, "合并后首条输入器只应有一枚浮层芯片").toBe(1);
  expect(before.options, "未点击时不该有浮层开着").toBe(0);
  await first.locator("> summary").click();
  const opened = await openState("first");
  expect(opened.options, "同一时刻只应有一枚输入器浮层开着").toBe(1);
  // 一片浮层里说明节与资料节同时在场（原来的两枚浮层现在是一段面板里的两节）。
  const firstSections = await panelSections(page,
    '[data-testid="assist-first-send-options"] > .agent-chat-options-panel');
  if (firstSections === null) throw new Error("缺少首条输入器合体浮层的分节采样");
  expect(firstSections.query, "首条合体浮层应含资料节（检索行）").toBe(true);
  expect(firstSections.picker, "首条合体浮层应含资料选择器").toBe(true);
  expect(firstSections.sections, "首条合体浮层的资料节应是面板的直接子节").toBe(1);
  // 2. 开合不改几何：浮层是浮层，草稿与发送键的矩形不因展开而移动。
  expect(opened.draft, "展开浮层后草稿几何变了").toEqual(before.draft);
  expect(opened.send, "展开浮层后发送键几何变了").toEqual(before.send);

  // 3. 互斥仍在：接着开模式浮层，合体浮层必须被独占注册表收起（原「点另一枚资料芯片」现场）。
  await page.locator("details.agent-chat-mode-select-field > summary").click();
  const afterMode = await openState("first");
  expect(afterMode.mode, "模式浮层应打开").toBe(true);
  expect(afterMode.options, "模式浮层打开后合体浮层应被收起（互斥）").toBe(0);

  // 4. 「+」菜单同样互斥，且开合体浮层要反过来收「+」。
  //    先把自己刚开的模式浮层收掉，否则它的浮层可能盖住待点的「+」芯片。
  await page.locator("details.agent-chat-mode-select-field > summary").click();
  expect((await openState("first")).mode, "再点一次模式芯片应收起自己的浮层").toBe(false);
  await page.locator("details.agent-chat-attach > summary").click();
  expect((await openState("first")).attach, "「+」菜单应打开").toBe(true);
  await first.locator("> summary").click();
  const afterAttach = await openState("first");
  expect(afterAttach.options, "点合体芯片后合体浮层应打开").toBe(1);
  expect(afterAttach.attach, "合体浮层打开后「+」菜单应被收起（互斥）").toBe(false);

  // 5. 点浮层外面要收（此前首条资料浮层没接外部关闭，点哪儿都不收）。
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await expect.poll(async () => (await openState("first")).options, { timeout: 5_000 }).toBe(0);

  // 6. 会话内输入器同样：只有一枚芯片、开着一枚、开模式即收、点外面收、几何不动。
  await page.goto(`/agent?work=${taskId}&session=${sessionId}`);
  await connect(page);
  await page.getByTestId("collab-conversation-toolbar").waitFor({ timeout: 20_000 });
  const sessionBefore = await openState("session");
  expect(sessionBefore.chips, "合并后会话输入器只应有一枚浮层芯片").toBe(1);
  await page.getByTestId("assist-open-sources").click();
  await page.getByTestId("assist-composer").locator("#assist-source-query").waitFor({ state: "visible", timeout: 20_000 });
  const sessionOpen = await openState("session");
  expect(sessionOpen.options, "会话内同一时刻只应有一枚输入器浮层开着").toBe(1);
  expect(sessionOpen.draft, "会话内展开浮层后草稿几何变了").toEqual(sessionBefore.draft);
  expect(sessionOpen.send, "会话内展开浮层后发送键几何变了").toEqual(sessionBefore.send);
  await page.locator("details.agent-chat-mode-select-field > summary").click();
  const sessionAfterMode = await openState("session");
  expect(sessionAfterMode.mode, "会话内模式浮层应打开").toBe(true);
  expect(sessionAfterMode.options, "会话内模式浮层打开后合体浮层应被收起（互斥）").toBe(0);
  // 先收掉刚开的模式浮层，免得它的浮层盖住待重开的合体芯片。
  await page.locator("details.agent-chat-mode-select-field > summary").click();
  expect((await openState("session")).mode, "会话内再点模式芯片应收起自己的浮层").toBe(false);
  await page.getByTestId("assist-open-sources").click();
  expect((await openState("session")).options, "会话内重新点芯片应重新展开").toBe(1);  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await expect.poll(async () => (await openState("session")).options, { timeout: 5_000 }).toBe(0);
});

/* 上下文圆环与其用量浮层（0145 / 2026-10-30）的几何与状态用例已移到
   `tests/browser/contextUsagePanel.spec.ts`：浮层正文换成会话档位 + 真实分项之后，
   原来那组用例里的「工作区档位」「预算未配置」「消息行用量」判据都不再成立，
   按新口径重写在专用文件中，避免同一份几何断言维护两处。
   本文件只保留输入器浮层（发送选项 / 资料 / 模式）的用例。 */
