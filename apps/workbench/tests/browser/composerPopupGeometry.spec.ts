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

for (const withUsage of [false, true]) {
  test(`上下文圆环直接保存档位并刷新预算：${withUsage ? "已有调用" : "首次调用前"}`, async ({ page }) => {
    await installRoutes(page, false, { messages: withUsage ? [usageRow(131_072, 74)] : [], maxCallTokens: 65_536 });
    let tokens: number | null = 262_144;
    let revision = 2;
    const writes: Record<string, unknown>[] = [];
    await page.route(`${apiBase}${prefix}/default-working-directory`, (route) => fulfillJson(route,
      { resource_id: null, canonical_root: null, display_name: null, write_tier: null,
        default_write_tier: null, context_budget_tokens: tokens, status: "UNSET", reason: null, revision: String(revision) }));
    await page.route(`${apiBase}${prefix}/context-budget`, async (route) => {
      const body = JSON.parse(String(route.request().postData())) as Record<string, unknown>;
      writes.push(body); tokens = body.context_budget_tokens as number | null; revision += 1;
      return fulfillJson(route, { command_id: body.command_id, committed_at: "2026-10-30T00:00:00Z",
        result: { workspace_id: workspaceId, context_budget_tokens: tokens, revision: String(revision) } });
    });
    await page.goto(withUsage ? `/agent?work=${taskId}&session=${sessionId}` : `/agent?work=${taskId}&new=1`);
    await connect(page);
    const meter = page.getByTestId("assist-context-meter");
    await meter.click();
    const panel = page.getByTestId("assist-context-meter-panel");
    await expect(panel.getByTestId("context-budget-option-262144")).toBeChecked();
    for (const next of [524_288, 1_048_576]) {
      await panel.getByTestId(`context-budget-option-${next}`).check();
      await panel.getByTestId("context-budget-save").click();
      await expect(panel.getByTestId("context-budget-notice")).toContainText(next.toLocaleString("zh-CN"));
      if (withUsage) await expect(panel.locator(".agent-chat-context-meter-amount")).toContainText(next.toLocaleString());
      else await expect(meter).toHaveAttribute("data-state", "unknown");
    }
    expect(writes.map((body) => [body.expected_revision, body.context_budget_tokens]))
      .toEqual([["2", 524_288], ["3", 1_048_576]]);
    await page.setViewportSize({ width: 560, height: 840 });
    await expect(panel).toBeVisible();
    const box = await panel.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(560);
    await page.screenshot({ path: `output/context-ring-20261030/${withUsage ? "usage" : "empty"}-560.png`, fullPage: true });
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(meter).toBeFocused();
  });
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

test("极窄输入器（560×700）：读数收起但圆环仍在，浮层不越出输入卡", async ({ page }) => {
  // 工具行窄到 34rem 以下时先收起百分比读数（容器查询 composer-actions），
  // 圆环、完整可访问名称与点击详情都保留；浮层右缘仍贴圆环，左缘不越出输入卡。
  await page.setViewportSize({ width: 560, height: 700 });
  await installRoutes(page, false, { messages: [usageRow(2_011, 74)], maxCallTokens: 65_536 });
  await page.goto(`/agent?work=${taskId}&session=${sessionId}`);
  await connect(page);
  const meter = page.getByTestId("assist-composer").getByTestId("assist-context-meter");
  await meter.waitFor({ timeout: 20_000 });
  await expect(meter.locator(".agent-chat-context-meter-value")).toHaveCount(0);
  await expect(meter).toHaveAttribute("aria-label", "上下文 2,011 / 65,536 tokens（3%）");
  await meter.click();
  const panel = page.getByTestId("assist-context-meter-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("3%");
  const geometry = await page.evaluate(() => {
    const box = (selector: string) => {
      const el = document.querySelector<HTMLElement>(selector);
      if (el === null) return null;
      const rect = el.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    };
    return { panel: box('[data-testid="assist-context-meter-panel"]'),
      card: box('[data-testid="assist-composer"]'),
      ring: box('[data-testid="assist-context-meter"]'),
      viewport: { width: window.innerWidth, height: window.innerHeight } };
  });
  if (geometry.panel === null || geometry.card === null || geometry.ring === null) throw new Error("缺少几何采样");
  expect(geometry.panel.right).toBeCloseTo(geometry.ring.right, 0);
  expect(geometry.panel.left).toBeGreaterThanOrEqual(geometry.card.left - 0.5);
  expect(geometry.panel.right).toBeLessThanOrEqual(geometry.card.right + 0.5);
  expect(geometry.panel.left).toBeGreaterThanOrEqual(-0.5);
  expect(geometry.panel.top).toBeGreaterThanOrEqual(-0.5);
  expect(geometry.panel.bottom).toBeLessThanOrEqual(geometry.viewport.height + 0.5);
});

test("上下文圆环浮层（2026-10-25）：点击圆环打开用量详情，待在卡内，与模型下拉互斥，Esc 还焦点", async ({ page }) => {
  // 窄档视口（1000×800）是圆环浮层向左展开的最紧情形；夹具给一次真实读数
  // （input 4710 / max_call_tokens 65536 ≈ 7%，缓存命中 4200/4710 ≈ 89%），
  // 圆环浮层走「最近一次模型调用」完整分支而不是尚无调用的空态。
  await page.setViewportSize({ width: 1000, height: 800 });
  const usageRow = (id: string, seq: number, role: "USER" | "ASSISTANT", content: string): unknown => ({
    id, session_id: sessionId, role, status: "COMPLETED", seq: String(seq), intent: "DISCUSS",
    created_at: "2026-10-25T00:00:00Z", updated_at: "2026-10-25T00:01:00Z", content,
    error_code: null, provider_error_kind: null, sources: [], skill: null, cancel_requested: false,
    steer_requested: false,
    usage: role === "ASSISTANT" ? { input_tokens: 4710, output_tokens: 47,
      cache_read_tokens: 4200, cache_creation_tokens: null }
      : { input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null },
    skill_input: null, skill_output: null, attachments: [], revision: "1" });
  await installRoutes(page, false, {
    messages: [usageRow("u-ctx", 1, "USER", "帮我看看上下文用量"),
      usageRow("x-ctx", 2, "ASSISTANT", "读数如下")],
    maxCallTokens: 65_536 });
  await page.goto(`/agent?work=${taskId}&session=${sessionId}`);
  await connect(page);
  await page.getByTestId("collab-conversation-toolbar").waitFor({ timeout: 20_000 });

  const meter = page.getByTestId("assist-context-meter");
  await meter.click();
  const panel = page.getByTestId("assist-context-meter-panel");
  await panel.waitFor({ state: "visible", timeout: 5_000 });
  await expect(meter).toHaveAttribute("aria-expanded", "true");
  await expect(panel).toContainText("最近一次记录");
  await expect(panel).toContainText("4,710");
  await expect(panel).toContainText("89%");
  // 只上报了缓存读取：读取行在、写入行整项不出现，命中率有可靠分母时才有。
  await expect(panel.getByTestId("assist-context-meter-cache-read")).toHaveCount(1);
  await expect(panel.getByTestId("assist-context-meter-cache-write")).toHaveCount(0);
  await expect(panel.getByTestId("assist-context-meter-cache-hit")).toHaveText("89%");

  // 几何：右缘贴圆环右缘、待在输入卡与视口内（中栏 overflow:hidden，越出即被裁）。
  const geo = await page.evaluate(() => {
    const box = (el: Element | null) => {
      if (el === null) return null;
      const rect = el.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, width: rect.width };
    };
    return {
      ring: box(document.querySelector('[data-testid="assist-composer"] [data-testid="assist-context-meter"]')),
      panel: box(document.querySelector('[data-testid="assist-context-meter-panel"]')),
      card: box(document.querySelector('[data-testid="assist-composer"]')),
      viewport: { width: window.innerWidth, height: window.innerHeight } };
  });
  if (geo.ring === null || geo.panel === null || geo.card === null) throw new Error("圆环浮层缺少几何采样");
  expect(Math.abs(geo.panel.right - geo.ring.right), "圆环浮层右缘应贴圆环右缘").toBeLessThanOrEqual(1);
  expect(geo.panel.left, "圆环浮层左缘越出输入卡").toBeGreaterThanOrEqual(geo.card.left - 0.5);
  expect(geo.panel.right, "圆环浮层右缘越出输入卡").toBeLessThanOrEqual(geo.card.right + 0.5);
  expect(geo.panel.left, "圆环浮层左缘越出视口").toBeGreaterThanOrEqual(-0.5);
  expect(geo.panel.top, "圆环浮层上缘越出视口").toBeGreaterThanOrEqual(-0.5);

  // 互斥（popoverMenu 注册表）：开模型下拉收圆环浮层；反向开圆环也收模型下拉。
  await page.getByTestId("model-selector-open").click();
  await expect(panel).toBeHidden();
  await expect(page.getByTestId("model-selector-menu")).toBeVisible();
  await meter.click();
  await expect(page.getByTestId("model-selector-menu")).toBeHidden();
  await expect(page.getByTestId("assist-context-meter-panel")).toBeVisible();

  // Esc 收起并把焦点还给圆环；点浮层外一次即收。
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("assist-context-meter-panel")).toBeHidden();
  await expect(meter).toBeFocused();
  await meter.click();
  await expect(page.getByTestId("assist-context-meter-panel")).toBeVisible();
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await expect(page.getByTestId("assist-context-meter-panel")).toBeHidden();
});

/**
 * 圆环读数（2026-10-28 用户指令「圆环 + 简短百分比」）：
 * 3% 这类小比例在 32px 环上只剩两三个像素的弧，既读不出进度又像一枚「正在加载」的绿点。
 * 这里逐档核对环旁的读数、状态语义与弧的有无，而不是只看 DOM 里有没有元素：
 *   * 0% 与「未知」必须分开——0% 有读数、轨道是实线；未知没有读数、轨道改虚线、不画弧；
 *   * 上限不可用时同样不画弧，浮层里如实写「上限不可用」，不拿别的数凑分母；
 *   * 高占用沿用 0.8 阈值换警示色，且**不**出现任何循环动画（它不是运行状态指示器）。
 */
const usageRow = (inputTokens: number | null, outputTokens: number | null,
  cacheReadTokens: number | null = null, cacheCreationTokens: number | null = null) => ({
  id: "x-reading", session_id: sessionId, role: "ASSISTANT", status: "COMPLETED", seq: "2",
  intent: "DISCUSS", content: "读数如下", error_code: null, provider_error_kind: null,
  created_at: "2026-10-28T00:00:00Z", updated_at: "2026-10-28T00:01:00Z", sources: [], skill: null,
  cancel_requested: false, steer_requested: false,
  usage: { input_tokens: inputTokens, output_tokens: outputTokens,
    cache_read_tokens: cacheReadTokens, cache_creation_tokens: cacheCreationTokens },
  skill_input: null, skill_output: null, attachments: [], revision: "1" });

for (const scenario of [
  { name: "还没有调用：未知态不写读数、不画弧", input: null as number | null, max: 65_536 as number | null,
    reading: null as string | null, state: "unknown", arc: false, unbounded: false },
  { name: "真实 0%：有读数、无弧、轨道仍是实线", input: 0, max: 65_536,
    reading: "0%", state: "normal", arc: false, unbounded: false },
  { name: "小比例 3%：环旁读数一眼可读", input: 2_011, max: 65_536,
    reading: "3%", state: "normal", arc: true, unbounded: false },
  { name: "正常 50%", input: 32_768, max: 65_536,
    reading: "50%", state: "normal", arc: true, unbounded: false },
  { name: "高占用 80%：换警示色，不闪烁", input: 52_429, max: 65_536,
    reading: "80%", state: "high", arc: true, unbounded: false },
  { name: "满额 100%", input: 65_536, max: 65_536,
    reading: "100%", state: "high", arc: true, unbounded: false },
  { name: "预算不可用：不画弧，浮层写预算未配置", input: 2_011, max: null,
    reading: null, state: "unknown", arc: false, unbounded: true },
  // 超预算不压成 100%：真实占比与「超出预算（估算）」都要保留；
  // 进度线只画满，不画负剩余。
  { name: "超预算：保留真实比例，不把超额藏成 100%", input: 70_000, max: 65_536,
    reading: "106.8%", state: "high", arc: true, unbounded: false }
]) {
  test(`上下文圆环读数：${scenario.name}`, async ({ page }) => {
    await page.setViewportSize({ width: 1162, height: 782 });
    await installRoutes(page, false, {
      messages: scenario.input === null ? [] : [usageRow(scenario.input, 74)],
      maxCallTokens: scenario.max });
    await page.goto(`/agent?work=${taskId}&session=${sessionId}`);
    await connect(page);
    await page.getByTestId("collab-conversation-toolbar").waitFor({ timeout: 20_000 });

    const meter = page.getByTestId("assist-composer").getByTestId("assist-context-meter");
    await expect(meter).toHaveAttribute("data-state", scenario.state);
    const reading = meter.locator(".agent-chat-context-meter-value");
    if (scenario.reading === null) await expect(reading).toHaveCount(0);
    else await expect(reading).toHaveText(scenario.reading);
    // 弧的有无是「能不能算出比例」的直接表达：算不出就不画，0% 也不画点。
    await expect(meter.locator(".agent-chat-context-meter-fill")).toHaveCount(scenario.arc ? 1 : 0);
    // 用量指示器不是运行状态指示器：没有任何循环动画。
    expect(await meter.evaluate((node) => getComputedStyle(node).animationName)).toBe("none");
    // 高占用换成警示色；正常态用主色。颜色只是叠加表达，读数与状态属性才是判据。
    if (scenario.arc) {
      const stroke = await meter.locator(".agent-chat-context-meter-fill")
        .evaluate((node) => getComputedStyle(node).stroke);
      expect(stroke).toBe(scenario.state === "high" ? "rgb(150, 98, 42)" : "rgb(32, 93, 71)");
    }
    // 完整可访问名称始终在：窄到收起读数时，屏幕阅读器与悬停提示仍读得到同一句话。
    await expect(meter).toHaveAttribute("aria-label",
      scenario.input === null ? "尚无模型调用" : /^上下文 /u);

    await meter.click();
    const panel = page.getByTestId("assist-context-meter-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("上下文用量");
    if (scenario.input === null) {
      await expect(panel).toContainText("尚无模型调用");
    } else {
      await expect(panel.locator(".agent-chat-context-meter-amount")).toContainText(
        scenario.input.toLocaleString("en-US"));
      if (scenario.reading !== null) {
        await expect(panel.locator(".agent-chat-context-meter-percent")).toHaveText(scenario.reading);
      }
      if (scenario.unbounded) {
        await expect(panel.getByTestId("assist-context-meter-unbounded")).toHaveText("预算未配置");
        await expect(panel.locator(".agent-chat-context-meter-bar")).toHaveCount(0);
      }
      if (scenario.input !== null && scenario.max !== null && scenario.input > scenario.max) {
        await expect(panel.locator(".agent-chat-context-meter-stat-label").first())
          .toHaveText("超出预算（估算）");
        await expect(panel.getByTestId("assist-context-meter-remaining")).toHaveText("4,464 tokens");
        // 超额也是高占用警示态，读数不被钳到 100%。
        await expect(panel.locator(".agent-chat-context-meter-percent")).toHaveCSS("color", "rgb(150, 98, 42)");
      }
    }
    // 浮层不越出输入卡与视口：宽度在 300–340px 之间自适应，边界判据必须同时成立。
    const geometry = await page.evaluate(() => {
      const box = (selector: string) => {
        const el = document.querySelector<HTMLElement>(selector);
        if (el === null) return null;
        const rect = el.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      };
      return { panel: box('[data-testid="assist-context-meter-panel"]'),
        card: box('[data-testid="assist-composer"]'),
        viewport: { width: window.innerWidth, height: window.innerHeight } };
    });
    if (geometry.panel === null || geometry.card === null) throw new Error("缺少浮层几何采样");
    expect(geometry.panel.left).toBeGreaterThanOrEqual(geometry.card.left - 0.5);
    expect(geometry.panel.right).toBeLessThanOrEqual(geometry.card.right + 0.5);
    expect(geometry.panel.left).toBeGreaterThanOrEqual(-0.5);
    expect(geometry.panel.top).toBeGreaterThanOrEqual(-0.5);
    expect(geometry.panel.bottom).toBeLessThanOrEqual(geometry.viewport.height + 0.5);
  });
}

// —— 2026-10-29 上下文用量浮层第二轮整改 ——
// 用户验收口径：点开圆环先看到清楚的用量数据，而不是一屏统计说明；浮层明显更紧凑，
// 与输入器其余弹层同一套语言。以下用真实 Chromium 核对八类状态与几何，不只看 DOM 存在。

test("用量浮层第二轮：2,101 / 65,536 · 输出 74，缓存未上报不占位，标题行与读数对齐", async ({ page }) => {
  await page.setViewportSize({ width: 1162, height: 782 });
  await installRoutes(page, false, { messages: [usageRow(2_101, 74)], maxCallTokens: 65_536 });
  await page.goto(`/agent?work=${taskId}&session=${sessionId}`);
  await connect(page);
  await page.getByTestId("collab-conversation-toolbar").waitFor({ timeout: 20_000 });

  const meter = page.getByTestId("assist-composer").getByTestId("assist-context-meter");
  await meter.click();
  const panel = page.getByTestId("assist-context-meter-panel");
  await expect(panel).toBeVisible();

  // 主读数：一次读完「已用 / 预算 tokens」与真实占比；二级信息只有余量与输出。
  await expect(panel.locator(".agent-chat-context-meter-amount")).toHaveText("2,101 / 65,536 tokens");
  await expect(panel.getByTestId("assist-context-meter-percent")).toHaveText("3%");
  await expect(panel.getByTestId("assist-context-meter-remaining")).toHaveText("63,435 tokens");
  await expect(panel.getByTestId("assist-context-meter-output")).toHaveText("74 tokens");

  // 缓存未上报：读取、写入、命中率整项都不出现，也没有「未采集 / 未提供」式占位。
  await expect(panel.getByTestId("assist-context-meter-cache-read")).toHaveCount(0);
  await expect(panel.getByTestId("assist-context-meter-cache-write")).toHaveCount(0);
  await expect(panel.getByTestId("assist-context-meter-cache-hit")).toHaveCount(0);
  const text = await panel.innerText();
  expect(text).not.toContain("缓存");
  for (const removed of ["统计来源", "统计口径", "未采集", "未提供", "未知", "物理上下文窗口", "压缩阈值"]) {
    expect(text, `浮层不应再出现「${removed}」`).not.toContain(removed);
  }
  expect(text.match(/上下文用量/g) ?? []).toHaveLength(1);
  expect(text.match(/最近一次记录/g) ?? []).toHaveLength(1);

  // 低占用进度线是真实的一小段：填充 ≈ 轨道 3%，颜色与圆环填充一致，不设最小宽度。
  const bar = await panel.evaluate((node) => {
    const track = node.querySelector<HTMLElement>(".agent-chat-context-meter-bar");
    const fill = track?.firstElementChild as HTMLElement | null;
    const ring = document.querySelector('[data-testid="assist-context-meter"] .agent-chat-context-meter-fill');
    return { trackWidth: track?.getBoundingClientRect().width ?? 0,
      fillWidth: fill?.getBoundingClientRect().width ?? 0,
      fillColor: fill === null ? "" : getComputedStyle(fill).backgroundColor,
      ringStroke: ring === null ? "" : getComputedStyle(ring).stroke };
  });
  expect(bar.trackWidth).toBeGreaterThan(200);
  expect(bar.fillWidth / bar.trackWidth).toBeGreaterThan(0.02);
  expect(bar.fillWidth / bar.trackWidth).toBeLessThan(0.04);
  expect(bar.fillColor).toBe(bar.ringStroke);

  // 尺寸与对齐：300–340px 宽、紧凑高度；标题左、来源与信息图标右，主读数与占比同排。
  const layout = await panel.evaluate((node) => {
    const rect = (selector: string) => {
      const el = node.querySelector<HTMLElement>(selector);
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const panelRect = node.getBoundingClientRect();
    return { heading: rect(".agent-chat-context-meter-heading"),
      tiers: rect('[data-testid="context-budget-inline"]'),
      source: rect(".agent-chat-context-meter-source"),
      info: rect('[data-testid="assist-context-meter-info"]'),
      amount: rect(".agent-chat-context-meter-amount"),
      percent: rect('[data-testid="assist-context-meter-percent"]'),
      panel: { top: panelRect.top, left: panelRect.left, right: panelRect.right, width: panelRect.width, height: panelRect.height,
        scrollWidth: node.scrollWidth, clientWidth: node.clientWidth } };
  });
  if (layout.heading === null || layout.source === null || layout.info === null
    || layout.amount === null || layout.percent === null) throw new Error("缺少浮层布局采样");
  expect(layout.panel.width).toBeGreaterThanOrEqual(300);
  expect(layout.panel.width).toBeLessThanOrEqual(340);
  expect(layout.tiers).not.toBeNull();
  expect(layout.tiers!.top - layout.panel.top).toBeLessThan(180); // The original usage area remains compact.
  expect(layout.panel.height).toBeLessThanOrEqual(384); // Includes the new tier controls.
  expect(layout.panel.scrollWidth).toBeLessThanOrEqual(layout.panel.clientWidth);
  expect(layout.heading.left).toBeLessThan(layout.source.left);
  const middle = (box: { top: number; bottom: number }) => (box.top + box.bottom) / 2;
  expect(Math.abs(middle(layout.heading) - middle(layout.source))).toBeLessThanOrEqual(1);
  expect(layout.info.right).toBeLessThanOrEqual(layout.panel.right - 8);
  expect(layout.amount.right).toBeLessThanOrEqual(layout.percent.left);
  expect(layout.percent.right).toBeLessThanOrEqual(layout.panel.right - 8);

  // 信息图标可键盘到达：Tab 从浮层进入图标，提示恰好是任务书指定的那句。
  await expect(panel).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(panel.getByTestId("assist-context-meter-info")).toBeFocused();
  const infoTip = page.getByTestId("context-meter-info-tooltip");
  await expect(infoTip).toBeVisible();
  await expect(infoTip).toHaveText("上下文用量按最近一次有记录的模型调用统计，占用比例相对于工作区配置预算计算。");
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(meter).toBeFocused();
});

test("用量浮层第二轮：缓存读取与写入分列，命中率单独一行", async ({ page }) => {
  await page.setViewportSize({ width: 1162, height: 782 });
  await installRoutes(page, false, {
    messages: [usageRow(3_000, 500, 1_500, 300)], maxCallTokens: 65_536 });
  await page.goto(`/agent?work=${taskId}&session=${sessionId}`);
  await connect(page);
  await page.getByTestId("collab-conversation-toolbar").waitFor({ timeout: 20_000 });

  await page.getByTestId("assist-composer").getByTestId("assist-context-meter").click();
  const panel = page.getByTestId("assist-context-meter-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("assist-context-meter-cache-read")).toHaveText("1,500 tokens");
  await expect(panel.getByTestId("assist-context-meter-cache-write")).toHaveText("300 tokens");
  await expect(panel.getByTestId("assist-context-meter-cache-hit")).toHaveText("50%");
  await expect(panel.locator(".agent-chat-context-meter-cache-row")).toHaveCount(3);
  // 读取与写入是两行两值，不能合成一个总数。
  const rows = await panel.locator(".agent-chat-context-meter-cache-row").allInnerTexts();
  expect(rows[0]).toContain("缓存读取");
  expect(rows[0]).toContain("1,500");
  expect(rows[1]).toContain("缓存写入");
  expect(rows[1]).toContain("300");
  await expect(panel.getByTestId("assist-context-meter-remaining")).toHaveText("62,536 tokens");
});

test("用量浮层第二轮：超长读数在 340px 内折行，不撑出浮层与输入卡", async ({ page }) => {
  await page.setViewportSize({ width: 560, height: 800 });
  await installRoutes(page, false, {
    messages: [usageRow(123_456_789, 1_234_567, 100_000_000, 23_456_789)],
    maxCallTokens: 200_000_000 });
  await page.goto(`/agent?work=${taskId}&session=${sessionId}`);
  await connect(page);
  await page.getByTestId("collab-conversation-toolbar").waitFor({ timeout: 20_000 });

  const meter = page.getByTestId("assist-composer").getByTestId("assist-context-meter");
  await meter.click();
  const panel = page.getByTestId("assist-context-meter-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".agent-chat-context-meter-amount")).toContainText("123,456,789");
  await expect(panel.getByTestId("assist-context-meter-remaining")).toHaveText("76,543,211 tokens");
  await expect(panel.getByTestId("assist-context-meter-cache-hit")).toHaveText("81%");

  const geometry = await panel.evaluate((node) => {
    const panelRect = node.getBoundingClientRect();
    const rect = (selector: string) => {
      const el = node.querySelector<HTMLElement>(selector);
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    };
    const card = document.querySelector('[data-testid="assist-composer"]')?.getBoundingClientRect() ?? null;
    return { panel: { left: panelRect.left, right: panelRect.right, top: panelRect.top, bottom: panelRect.bottom,
        width: panelRect.width, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth },
      card: card === null ? null : { left: card.left, right: card.right },
      amount: rect(".agent-chat-context-meter-amount"),
      percent: rect('[data-testid="assist-context-meter-percent"]'),
      viewport: { width: window.innerWidth, height: window.innerHeight } };
  });
  if (geometry.card === null || geometry.amount === null || geometry.percent === null) {
    throw new Error("缺少长读数几何采样");
  }
  expect(geometry.panel.width).toBeLessThanOrEqual(340);
  expect(geometry.panel.scrollWidth).toBeLessThanOrEqual(geometry.panel.clientWidth);
  expect(geometry.panel.left).toBeGreaterThanOrEqual(geometry.card.left - 0.5);
  expect(geometry.panel.right).toBeLessThanOrEqual(geometry.card.right + 0.5);
  expect(geometry.panel.top).toBeGreaterThanOrEqual(-0.5);
  expect(geometry.panel.bottom).toBeLessThanOrEqual(geometry.viewport.height + 0.5);
  expect(geometry.amount.right).toBeLessThanOrEqual(geometry.panel.right + 0.5);
  expect(geometry.percent.right).toBeLessThanOrEqual(geometry.panel.right + 0.5);
  await expect(panel.getByTestId("assist-context-meter-output")).toHaveText("1,234,567 tokens");
});

test("用量浮层第二轮：窄窗 + 1.5× 缩放模拟，浮层仍在卡内且二级信息不重叠", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 620, height: 640 }, deviceScaleFactor: 1.5 });
  const page = await context.newPage();
  try {
    await installRoutes(page, false, { messages: [usageRow(2_101, 74, 1_200, 300)], maxCallTokens: 65_536 });
    await page.goto(`/agent?work=${taskId}&session=${sessionId}`);
    await connect(page);
    await page.getByTestId("collab-conversation-toolbar").waitFor({ timeout: 20_000 });

    const meter = page.getByTestId("assist-composer").getByTestId("assist-context-meter");
    await meter.click();
    const panel = page.getByTestId("assist-context-meter-panel");
    await expect(panel).toBeVisible();

    const geometry = await page.evaluate(() => {
      const box = (selector: string) => {
        const el = document.querySelector<HTMLElement>(selector);
        if (el === null) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
      };
      const stats = Array.from(document.querySelectorAll<HTMLElement>(".agent-chat-context-meter-stat"))
        .map((el) => { const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; });
      return { panel: box('[data-testid="assist-context-meter-panel"]'),
        card: box('[data-testid="assist-composer"]'), stats,
        overflowX: (document.scrollingElement as HTMLElement).scrollWidth
          - (document.scrollingElement as HTMLElement).clientWidth,
        viewport: { width: window.innerWidth, height: window.innerHeight } };
    });
    if (geometry.panel === null || geometry.card === null) throw new Error("缺少窄窗浮层几何采样");
    expect(geometry.panel.left).toBeGreaterThanOrEqual(geometry.card.left - 0.5);
    expect(geometry.panel.right).toBeLessThanOrEqual(geometry.card.right + 0.5);
    expect(geometry.panel.left).toBeGreaterThanOrEqual(-0.5);
    expect(geometry.panel.right).toBeLessThanOrEqual(geometry.viewport.width + 0.5);
    expect(geometry.panel.bottom).toBeLessThanOrEqual(geometry.viewport.height + 0.5);
    expect(geometry.overflowX).toBe(0);
    expect(geometry.stats).toHaveLength(2);
    for (const stat of geometry.stats) {
      expect(stat.left).toBeGreaterThanOrEqual(geometry.panel.left - 0.5);
      expect(stat.right).toBeLessThanOrEqual(geometry.panel.right + 0.5);
    }
    const [left, right] = geometry.stats;
    const overlaps = left.left < right.right - 0.5 && right.left < left.right - 0.5
      && left.top < right.bottom - 0.5 && right.top < left.bottom - 0.5;
    expect(overlaps, "预算余量与本次输出不得互相压字").toBe(false);

    await page.keyboard.press("Tab");
    const infoTip = page.getByTestId("context-meter-info-tooltip");
    await expect(infoTip).toBeVisible();
    const tipBox = await infoTip.boundingBox();
    if (tipBox === null) throw new Error("缺少信息提示几何");
    expect(tipBox.x).toBeGreaterThanOrEqual(-0.5);
    expect(tipBox.x + tipBox.width).toBeLessThanOrEqual(geometry.viewport.width + 0.5);
  } finally {
    await context.close();
  }
});
