import { expect, test, type Page, type Route } from "@playwright/test";

// 回退按钮 Tooltip 一体化轮廓的真实渲染验收（2026-10-25 重画尾巴）。
// 用真实 Chromium 量轮廓几何：尾巴尖必须落在气泡自身水平正中（气泡被视口夹住时也不挪尾巴），
// 翻转到下方时轮廓方向正确，文本折行后轮廓按新尺寸重算；并按 DPI 档截图，
// 供人工放大核对尾巴根部、轮廓连续性与抗锯齿。
// API 全部由 page.route 伪造，不连数据库、不调 Provider、不产生任何写请求。

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const sessionId = "66666666-6666-4666-8666-666666666666";
const userMessageId = "44444444-4444-4444-8444-444444444444";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = "http://127.0.0.1:4173";
const tooltipId = "assist-recall-tooltip";
const buttonId = `assist-recall-action-${userMessageId}`;
/** 与 pathTooltip.tsx 的 OUTLINE_PAD_PX 同值：SVG 盒 = 卡片盒四周外扩这么多。 */
const OUTLINE_PAD = 10;

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: "application/json", headers: cors(), body: JSON.stringify(body) });
}

function sessionRow(): unknown {
  return { id: sessionId, workspace_id: workspaceId, project_id: null, task_id: null,
    title: "回退提示尾巴", status: "ACTIVE", revision: "1", conversation_mode: "AGENT",
    assistant_profile_id: null, created_at: "2026-10-25T10:00:00Z", updated_at: "2026-10-25T10:00:00Z" };
}

/** 一条完成态用户消息 + 一条助手回复：回退键出现（完成、未撤回、无回执）。 */
function row(id: string, seq: number, role: "USER" | "ASSISTANT", content: string): unknown {
  return { id, session_id: sessionId, seq: String(seq), role, status: "COMPLETED", intent: "DISCUSS",
    created_at: "2026-10-25T10:01:00Z", updated_at: "2026-10-25T10:02:00Z", content,
    error_code: null, provider_error_kind: null, sources: [], skill: null, skill_input: null,
    skill_output: null, attachments: [],
    usage: { input_tokens: 118, output_tokens: 24, cache_read_tokens: null, cache_creation_tokens: null },
    cancel_requested: false, withdrawn_at: null, withdrawn_by_recall_id: null, recall: null };
}

const messages = [
  row(userMessageId, 1, "USER", "请修改 notes/a.md，然后我试试回退这条消息"),
  row("55555555-5555-4555-8555-555555555555", 2, "ASSISTANT", "已修改 notes/a.md。")
];

async function installRoutes(page: Page): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/model-port`) return fulfillJson(route, { provider: "fake",
      configured: false, model: null, base_url: null, max_call_tokens: null });
    if (path === `${prefix}/assist-sessions`) return fulfillJson(route, { items: [sessionRow()] });
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return fulfillJson(route, { items: messages });
    if (path === `${prefix}/assist-sessions/${sessionId}`) return fulfillJson(route, sessionRow());
    if (path === `${prefix}/assist-sessions/${sessionId}/model-selection`) {
      return fulfillJson(route, { model: null, revision: "0" });
    }
    if (path === `${prefix}/default-working-directory`) {
      return fulfillJson(route, { resource_id: null, canonical_root: null, display_name: null,
        write_tier: null, default_write_tier: null, status: "UNSET", reason: null, revision: "0" });
    }
    if (path === `${prefix}/assist-proposals`) return fulfillJson(route, { items: [] });
    if (path === `${prefix}/skill-definitions`) return fulfillJson(route, { items: [] });
    if (path === `${prefix}/chat-commands`) return fulfillJson(route, { items: [] });
    if (path.startsWith(`${prefix}/conversation-execution-requests`)) return fulfillJson(route, { items: [] });
    if (path.startsWith(`${prefix}/learning`)) return fulfillJson(route, { items: [], epoch: "0" });
    return fulfillJson(route, { items: [], next_cursor: null });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("tooltip-tail-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

async function openRecallButton(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await installRoutes(page);
  await page.goto(`/agent?session=${sessionId}`);
  await connect(page);
  const button = page.locator(`[data-testid="${buttonId}"]`);
  await button.waitFor({ state: "attached", timeout: 20_000 });
  // 页脚随行悬停出现：先把鼠标移到用户消息行上，再移到回退键上（Tooltip 随之浮出）。
  await page.locator(".agent-message[data-role='USER']").first().hover();
  await button.hover();
}

interface TailGeometry {
  side: string;
  pathCount: number;
  cardBorderTopWidth: string;
  centerX: number;
  cardLeft: number; cardTop: number; cardWidth: number; cardHeight: number;
  tipX: number; tipBeyond: number;
  tailMinX: number; tailMaxX: number;
  anchorTop: number; anchorBottom: number; anchorCenterX: number;
  bboxWidth: number; bboxHeight: number;
}

/** 沿轮廓采样：尖端 = 越过气泡边缘最远的点；尾巴区域 = 越过边缘 1px 以上的点。 */
async function readGeometry(page: Page): Promise<TailGeometry> {
  return page.evaluate(([anchorTestId, pad]: [string, number]) => {
    const card = document.querySelector<HTMLElement>(`[data-testid="assist-recall-tooltip"]`);
    if (card === null) throw new Error("tooltip 未渲染");
    const path = card.querySelector<SVGPathElement>(".path-tooltip-outline-path");
    if (path === null) throw new Error("轮廓 path 未渲染");
    const anchor = document.querySelector<HTMLElement>(`[data-testid="${anchorTestId}"]`);
    if (anchor === null) throw new Error("锚点按钮不在");
    const box = card.getBoundingClientRect();
    const anchorBox = anchor.getBoundingClientRect();
    const side = card.dataset.side ?? "above";
    const centerX = box.left + box.width / 2;
    const total = path.getTotalLength();
    let tipX = Number.NaN; let tipBeyond = Number.NEGATIVE_INFINITY;
    let tailMin = Number.POSITIVE_INFINITY; let tailMax = Number.NEGATIVE_INFINITY;
    const samples = 800;
    for (let i = 0; i <= samples; i += 1) {
      const p = path.getPointAtLength((total * i) / samples);
      // 无 viewBox：用户坐标就是 SVG 盒的 px 坐标，SVG 盒 = 卡片盒四周外扩 pad。
      const x = box.left - pad + p.x;
      const y = box.top - pad + p.y;
      const beyond = side === "above" ? y - box.bottom : box.top - y;
      if (beyond > tipBeyond) { tipBeyond = beyond; tipX = x; }
      if (beyond > 1) { tailMin = Math.min(tailMin, x); tailMax = Math.max(tailMax, x); }
    }
    if (!Number.isFinite(tipX)) throw new Error("轮廓采样为空");
    const bbox = path.getBBox();
    return {
      side,
      pathCount: card.querySelectorAll(".path-tooltip-outline-path").length,
      cardBorderTopWidth: getComputedStyle(card).borderTopWidth,
      centerX,
      cardLeft: box.left, cardTop: box.top, cardWidth: box.width, cardHeight: box.height,
      tipX, tipBeyond, tailMinX: tailMin, tailMaxX: tailMax,
      anchorTop: anchorBox.top, anchorBottom: anchorBox.bottom,
      anchorCenterX: anchorBox.left + anchorBox.width / 2,
      bboxWidth: bbox.width, bboxHeight: bbox.height
    };
  }, [buttonId, OUTLINE_PAD] as [string, number]);
}

/** 几何契约：单条 path、CSS 不再画边框、尾巴尖与尾巴区域都居中于气泡自身、尖端贴锚点边缘。 */
async function expectTailCentered(page: Page): Promise<TailGeometry> {
  const g = await readGeometry(page);
  expect(g.pathCount).toBe(1);
  expect(g.cardBorderTopWidth).toBe("0px");
  expect(g.tailMaxX - g.tailMinX).toBeGreaterThan(6); // 尾巴区域确实采到
  expect(Math.abs(g.tipX - g.centerX)).toBeLessThanOrEqual(0.6);
  expect(Math.abs((g.tailMinX + g.tailMaxX) / 2 - g.centerX)).toBeLessThanOrEqual(0.6);
  const tipPageY = g.side === "above" ? g.cardTop + g.cardHeight + g.tipBeyond : g.cardTop - g.tipBeyond;
  const anchorEdge = g.side === "above" ? g.anchorTop : g.anchorBottom;
  expect(Math.abs(tipPageY - anchorEdge)).toBeLessThanOrEqual(1.5);
  return g;
}

async function screenshotTooltip(page: Page, name: string): Promise<void> {
  const box = await page.locator(`[data-testid="${tooltipId}"]`).boundingBox();
  if (box === null) throw new Error("tooltip 无盒");
  const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
  await page.screenshot({ path: `results/tooltip-tail/${name}.png`, caret: "hide",
    clip: {
      x: Math.max(0, box.x - 28),
      y: Math.max(0, box.y - 28),
      width: Math.min(box.width + 56, viewport.width - Math.max(0, box.x - 28)),
      height: Math.min(box.height + 56, viewport.height - Math.max(0, box.y - 28))
    } });
}

/** 把挂 handlers 的外层 span 钉到指定位置并悬停按钮：页脚按 hover 保持出现，
 *  Tooltip 经 mouseenter 打开（提示挂在外层 span 上，按钮 disabled 也不影响），
 *  用于构造翻转 / 贴边这些真实布局摆不出的场景。 */
async function pinAnchor(page: Page, top: number, left: number): Promise<void> {
  await page.evaluate(([id, topValue, leftValue]: [string, number, number]) => {
    const button = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    const wrap = button?.closest("span") ?? null;
    if (button === null || wrap === null) throw new Error("锚点不在");
    wrap.style.position = "fixed";
    wrap.style.top = `${topValue}px`;
    wrap.style.left = `${leftValue}px`;
    wrap.style.transform = "none";
    wrap.style.zIndex = "60";
  }, [buttonId, top, left] as [string, number, number]);
  // 真实鼠标移到钉住后的按钮上：mouseleave 收掉旧提示，mouseenter 在新坐标重开。
  // 不能用 button.focus()——回退键在默认工作目录未设置时是 disabled，focus 无效。
  await page.locator(`[data-testid="${buttonId}"]`).hover();
}

test.describe("回退 Tooltip 一体化轮廓（真实 Chromium）", () => {
  test("气泡在上方：尾巴尖落在气泡正中并轻触锚点上沿", async ({ page }) => {
    await openRecallButton(page);
    await expect(page.getByTestId(tooltipId)).toBeVisible();
    const g = await expectTailCentered(page);
    expect(g.side).toBe("above");
    // 未被视口夹住时，气泡整体也对齐锚点中心。
    expect(Math.abs(g.centerX - g.anchorCenterX)).toBeLessThanOrEqual(1);
    await screenshotTooltip(page, "above-centered-1x");
  });

  test("翻转：气泡在下方时尾巴在顶边正中", async ({ page }) => {
    await openRecallButton(page);
    await pinAnchor(page, 36, 640);
    await expect(page.getByTestId(tooltipId)).toBeVisible();
    const g = await expectTailCentered(page);
    expect(g.side).toBe("below");
    expect(Math.abs(g.centerX - g.anchorCenterX)).toBeLessThanOrEqual(1);
    await screenshotTooltip(page, "below-flipped-1x");
  });

  test("气泡被视口左缘夹住：整体偏移、尾巴仍在气泡正中", async ({ page }) => {
    await openRecallButton(page);
    await pinAnchor(page, 300, 20);
    await expect(page.getByTestId(tooltipId)).toBeVisible();
    const g = await expectTailCentered(page);
    // 前提确实发生：气泡被夹到视口边，气泡中心被推到锚点中心右侧。
    expect(g.cardLeft).toBeGreaterThanOrEqual(8);
    expect(g.centerX - g.anchorCenterX).toBeGreaterThan(4);
    await screenshotTooltip(page, "clamped-left-1x");
  });

  test("文本折行后轮廓按新尺寸重算，尾巴仍居中", async ({ page }) => {
    await openRecallButton(page);
    await expect(page.getByTestId(tooltipId)).toBeVisible();
    const before = await readGeometry(page);
    await page.evaluate((id) => {
      const card = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
      if (card === null) throw new Error("tooltip 不在");
      card.style.maxWidth = "150px";
    }, tooltipId);
    // ResizeObserver 驱动重算：等轮廓 bbox 收窄到新尺寸。
    await expect.poll(async () => (await readGeometry(page)).bboxWidth,
      { timeout: 5_000 }).toBeLessThan(before.bboxWidth - 40);
    const g = await expectTailCentered(page);
    expect(g.cardWidth).toBeLessThanOrEqual(152);
    await screenshotTooltip(page, "wrapped-1x");
  });

  test("连续显示与隐藏：重开后的几何一致", async ({ page }) => {
    await openRecallButton(page);
    await expect(page.getByTestId(tooltipId)).toBeVisible();
    const first = await readGeometry(page);
    await page.mouse.move(12, 560);
    await expect(page.getByTestId(tooltipId)).toBeHidden();
    await page.locator(`[data-testid="${buttonId}"]`).hover();
    await expect(page.getByTestId(tooltipId)).toBeVisible();
    const second = await readGeometry(page);
    expect(second.side).toBe(first.side);
    expect(Math.abs(second.centerX - first.centerX)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(second.tipX - second.centerX)).toBeLessThanOrEqual(0.6);
  });
});

test.describe("回退 Tooltip 轮廓在高 DPI 下", () => {
  for (const scale of [1.25, 1.5]) {
    test.describe(`缩放 ${Math.round(scale * 100)}%`, () => {
      // deviceScaleFactor 必须在上下文创建前声明，只能经 test.use 进配置。
      test.use({ deviceScaleFactor: scale });
      test(`Windows ${Math.round(scale * 100)}% 显示缩放：居中与几何不变`, async ({ page }) => {
        await openRecallButton(page);
        await expect(page.getByTestId(tooltipId)).toBeVisible();
        const g = await expectTailCentered(page);
        expect(g.side).toBe("above");
        await screenshotTooltip(page, `above-centered-${Math.round(scale * 100)}dpi`);
      });
    });
  }
});

test.describe("尾巴根部放大证据", () => {
  // 4 倍像素密度直截尾巴根部：人工核对根部无拼缝、描边连续、尖端圆润、抗锯齿表现。
  test.use({ deviceScaleFactor: 4 });
  for (const scenario of ["above", "below"] as const) {
    test(`${scenario === "above" ? "上方尾巴" : "翻转尾巴"}根部 4x 特写`, async ({ page }) => {
      await openRecallButton(page);
      await expect(page.getByTestId(tooltipId)).toBeVisible();
      if (scenario === "below") {
        await pinAnchor(page, 36, 640);
        await expect(page.getByTestId(tooltipId)).toBeVisible();
      }
      const g = await readGeometry(page);
      const box = await page.locator(`[data-testid="${tooltipId}"]`).boundingBox();
      if (box === null) throw new Error("tooltip 无盒");
      const edgeY = g.side === "above" ? box.y + box.height : box.y;
      // 以尾巴尖横坐标为中心，上下各留一段：覆盖根部两侧的底边、整条尾巴与尖端。
      await page.screenshot({ path: `results/tooltip-tail/tail-root-${scenario}-4x.png`, caret: "hide",
        clip: { x: g.tipX - 45, y: g.side === "above" ? edgeY - 20 : edgeY - 26,
          width: 90, height: 46 } });
    });
  }
});
