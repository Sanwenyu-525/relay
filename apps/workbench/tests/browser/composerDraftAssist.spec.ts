import { expect, test, type Page, type Route } from "@playwright/test";

// 2026-10-16 输入框自动分点与手动润色（工作台 §30、测试计划 §31 CO-01/04/05/06/07）。
// 真实 Chromium 里核对布局与焦点相关的行为：提示行是否抢焦点、浮层是否遮挡输入卡与发送键、
// 采用/撤销是否真的改回输入框内容、迟到回包是否被丢弃。
// 切片保真与协议校验在 apps/api/test/unit/composer-draft.test.ts；版本与状态机在
// tests/composerDraftAssist.spec.tsx。API 全部由 page.route 伪造：不连数据库、不调 Provider。

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const origin = "http://127.0.0.1:4173";
const prefix = `/api/v1/workspaces/${workspaceId}`;

const DRAFT = "给登录页加个记住密码，密码输错了要提示原因，还有登录按钮现在太小了改大一点，先不要做短信登录";
const OUTLINE_TEXT = [
  "1. 给登录页加个记住密码，",
  "2. 密码输错了要提示原因，",
  "3. 还有登录按钮现在太小了改大一点，",
  "4. 先不要做短信登录",
].join("\n");
const POLISHED = "给登录页加记住密码；密码错误时提示原因；登录按钮偏小，改大一些；本次不做短信登录。";

/** 停笔延时（产品默认 2 秒）+ 余量。 */
const SETTLE_MS = 2600;

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(),
    body: JSON.stringify(body) });
}

interface AssistLog {
  readonly calls: { operation: string; text: string }[];
  /** 除草稿辅助以外的写请求：辅助调用不得创建消息/Task/Run。 */
  readonly otherWrites: { method: string; path: string }[];
  /** 下一次草稿辅助响应的额外延迟，用来制造「在途编辑」。 */
  holdMs: number;
}

async function installRoutes(page: Page): Promise<AssistLog> {
  const log: AssistLog = { calls: [], otherWrites: [], holdMs: 0 };
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/model-port`) {
      return fulfillJson(route, { provider: "fake", configured: false, model: null,
        base_url: null, max_call_tokens: null });
    }
    if (path === `${prefix}/composer/draft-assist`) {
      const body = JSON.parse(request.postData() ?? "{}") as { operation: string; text: string };
      log.calls.push({ operation: body.operation, text: body.text });
      if (log.holdMs > 0) await new Promise((resolve) => setTimeout(resolve, log.holdMs));
      if (body.operation === "OUTLINE") {
        return fulfillJson(route, { operation: "OUTLINE", status: "OUTLINE",
          item_count: 4, text: OUTLINE_TEXT });
      }
      return fulfillJson(route, { operation: "POLISH", status: "POLISH", item_count: null,
        text: POLISHED });
    }
    if (method !== "GET") log.otherWrites.push({ method, path });
    return fulfillJson(route, { items: [], next_cursor: null });
  });
  return log;
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("composer-assist-browser-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" })
    .waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

test.describe("输入框自动分点与手动润色", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("停笔后给建议：查看不抢焦点、采用替换草稿、撤销恢复采用前原文", async ({ page }) => {
    const log = await installRoutes(page);
    await page.goto("/agent?new=browser");
    await connect(page);

    const draft = page.getByTestId("assist-first-draft");
    await draft.fill(DRAFT);
    // 停笔前不发请求。
    expect(log.calls).toHaveLength(0);

    const bar = page.getByTestId("composer-draft-assist");
    await expect(bar).toBeVisible({ timeout: SETTLE_MS + 4000 });
    await expect(bar).toContainText("已整理为 4 个要点");
    // 提示不抢焦点：焦点仍在输入框。
    await expect(draft).toBeFocused();

    // 润色键在输入卡工具行内，与「资料 / 模式」同一行（原型 #polishBtn 的位置）。
    const polish = page.getByTestId("composer-draft-polish");
    await expect(polish).toBeVisible();
    const toolsBox = (await page.locator(".agent-chat-composer-tools").first().boundingBox())!;
    const polishBox = (await polish.boundingBox())!;
    expect(polishBox.y).toBeGreaterThanOrEqual(toolsBox.y - 1);
    expect(polishBox.y + polishBox.height).toBeLessThanOrEqual(toolsBox.y + toolsBox.height + 1);
    expect(polishBox.x).toBeGreaterThan(toolsBox.x - 1);
    expect(polishBox.x + polishBox.width).toBeLessThanOrEqual(toolsBox.x + toolsBox.width + 1);
    // 提示行 + 输入卡工具行：润色键与「资料 / 模式」同一行，不另起一行、不把输入卡往下推。
    await page.screenshot({ path: "results/composer-draft-toolrow.png" });

    await page.getByTestId("composer-draft-view").click();
    const panel = page.getByTestId("composer-draft-panel");
    await expect(panel).toBeVisible();
    await expect(page.getByTestId("composer-draft-original")).toHaveText(DRAFT);
    await expect(page.getByTestId("composer-draft-suggested")).toHaveText(OUTLINE_TEXT);
    // 浮层锚在提示行上方、绝对定位：不推动布局，也不遮住输入卡与发送键。
    const panelBox = (await panel.boundingBox())!;
    const barBox = (await bar.boundingBox())!;
    const composerBox = (await page.locator(".agent-chat-composer").first().boundingBox())!;
    expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(barBox.y + 1);
    expect(composerBox.y).toBeGreaterThanOrEqual(barBox.y + barBox.height - 1);
    await page.screenshot({ path: "results/composer-draft-panel.png" });

    await page.getByTestId("composer-draft-adopt").click();
    await expect(draft).toHaveValue(OUTLINE_TEXT);
    await page.getByTestId("composer-draft-undo-outline").click();
    await expect(draft).toHaveValue(DRAFT);
    await expect(page.getByTestId("composer-draft-undo-outline")).toHaveCount(0);
    // 辅助操作不创建消息/Task/Run。
    expect(log.otherWrites).toEqual([]);
  });

  test("润色：同一按钮变撤销，撤销精确恢复润色前原文并丢弃手动修改", async ({ page }) => {
    const log = await installRoutes(page);
    await page.goto("/agent?new=browser");
    await connect(page);

    const draft = page.getByTestId("assist-first-draft");
    const bar = page.getByTestId("composer-draft-assist");
    await draft.fill(DRAFT);
    await expect(bar).toBeVisible({ timeout: SETTLE_MS + 4000 });
    await page.getByTestId("composer-draft-view").click();
    await page.getByTestId("composer-draft-adopt").click();
    await expect(draft).toHaveValue(OUTLINE_TEXT);

    await page.getByTestId("composer-draft-polish").click();
    await expect(page.getByTestId("composer-draft-undo-polish")).toBeVisible();
    await expect(draft).toHaveValue(POLISHED);
    // 开始润色结束了分点撤销入口。
    await expect(page.getByTestId("composer-draft-undo-outline")).toHaveCount(0);

    // 润色成功后手动编辑：撤销入口与快照都保留，后果提示可见且被撤销键引用。
    await draft.fill(`${POLISHED} 再加一条日志`);
    // 后果提示可见，并且撤销键用 aria-describedby 指向一段可读屏的文字。
    const note = page.getByTestId("composer-draft-polish-note");
    await expect(note).toBeVisible();
    await expect(note).toContainText("撤销将恢复润色前原话");
    const undo = page.getByTestId("composer-draft-undo-polish");
    const describedBy = await undo.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(await page.locator(`#${describedBy}`).textContent())
      .toContain("撤销将恢复润色前原话");
    const outlineCalls = log.calls.filter((call) => call.operation === "OUTLINE").length;
    await page.waitForTimeout(SETTLE_MS + 400);
    // 润色成功后的编辑不触发自动分点。
    expect(log.calls.filter((call) => call.operation === "OUTLINE").length).toBe(outlineCalls);

    await undo.click();
    await expect(draft).toHaveValue(OUTLINE_TEXT);
    await expect(page.getByTestId("composer-draft-polish")).toBeVisible();
    expect(log.otherWrites).toEqual([]);
  });

  test("迟到隔离：在途编辑后旧回包不覆盖草稿", async ({ page }) => {
    const log = await installRoutes(page);
    await page.goto("/agent?new=browser");
    await connect(page);

    const draft = page.getByTestId("assist-first-draft");
    const bar = page.getByTestId("composer-draft-assist");
    // 让分点响应迟到 1.5 秒，留出在途编辑的窗口。
    log.holdMs = 1500;
    await draft.fill(DRAFT);
    await page.waitForFunction(() => true);
    // 等请求确实发出（停笔延时 2 秒之后）。
    await expect.poll(() => log.calls.length, { timeout: SETTLE_MS + 4000 }).toBe(1);
    // 请求在途时继续编辑。
    await draft.fill(`${DRAFT}，另外按钮也大一点`);
    // 旧回包到达：不得覆盖当前草稿，也不得弹出建议。
    await page.waitForTimeout(1800);
    await expect(draft).toHaveValue(`${DRAFT}，另外按钮也大一点`);
    await expect(bar).toHaveCount(0);
    expect(log.otherWrites).toEqual([]);
  });
});
