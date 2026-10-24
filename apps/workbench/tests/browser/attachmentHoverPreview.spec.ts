import { expect, test, type Locator, type Page, type Route } from "@playwright/test";

// 2026-10-19 图片的悬停预览（工作台 §33.2 输入框芯片 / §33.3 历史消息附件）。
// 用户指令：「粘贴进去的图片鼠标悬停需要能够展示图片内容」，随后追加「历史消息也要」。
// 两处共用 `components/attachmentPreview.tsx`，这里在真实 Chromium 里核对：
// 悬停真的浮出可解码的原图、浮层没有被输入卡/滚动列裁掉、离开即收回。
// 行为断言（鼠标进出、聚焦、Esc）在 tests/composerImageAttachments.spec.tsx；本文件只管真实几何。
// API 全部由 page.route 伪造：不连数据库、不调 Provider。

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const attachmentId = "44444444-4444-4444-8444-444444444444";
const origin = "http://127.0.0.1:4173";
const prefix = `/api/v1/workspaces/${workspaceId}`;

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}
async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(),
    body: JSON.stringify(body) });
}

/** 页面里画一张 320×200 的 PNG，返回 base64——预览要能读出这张图的尺寸。 */
async function samplePngBase64(page: Page): Promise<string> {
  await page.goto("about:blank");
  return page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 200;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#0f766e"; context.fillRect(0, 0, 320, 200);
    context.fillStyle = "#ffffff"; context.font = "28px sans-serif";
    context.fillText("PREVIEW", 24, 112);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("attachment-preview-browser-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" })
    .waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

/** 空壳路由：只保证「没有多余请求失败」，其余端点一律空清单。
/** 空壳路由：只保证「没有多余请求失败」，其余端点一律空清单。 */
async function installShellRoutes(page: Page): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/model-port`) {
      return fulfillJson(route, { provider: "fake", configured: false, model: null, base_url: null,
        max_call_tokens: null });
    }
    if (path === `${prefix}/projects/${projectId}`) {
      return fulfillJson(route, { id: projectId, title: "悬停预览验证", project_type: "GENERAL",
        revision: "1", state_revision: "1", archived_at: null });
    }
    return fulfillJson(route, { items: [], next_cursor: null });
  });
}

/** 在页面里画一张 PNG 并当作剪贴板图片粘贴进去；尺寸可指定（默认 320×200）。 */
async function pasteImage(page: Page, target: string, width = 320, height = 200): Promise<void> {
  await page.evaluate(async ({ selector, width, height }) => {
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#0f766e"; context.fillRect(0, 0, width, height);
    context.fillStyle = "#ffffff"; context.font = "28px sans-serif";
    context.fillText("PREVIEW", 24, Math.round(height / 2) + 12);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    const file = new File([blob!], "截图.png", { type: "image/png" });
    const data = new DataTransfer();
    data.items.add(file);
    const textarea = document.querySelector(selector)!;
    textarea.dispatchEvent(new ClipboardEvent("paste",
      { clipboardData: data, bubbles: true, cancelable: true }));
  }, { selector: target, width, height });
}

/** 浮层「没被裁、真的是放大、不压住锚点」这三条几何事实。 */
async function expectPreviewGeometry(page: Page, anchor: Locator, smallerThan: Locator): Promise<void> {
  const preview = page.getByTestId("attachment-preview");
  await expect(preview).toBeVisible();
  const anchorBox = (await anchor.boundingBox())!;
  const previewBox = (await preview.boundingBox())!;
  const smallBox = (await smallerThan.boundingBox())!;
  // 真的「放大」了，不只是把原图换个位置。
  expect(previewBox.width).toBeGreaterThan(smallBox.width);
  expect(previewBox.height).toBeGreaterThan(smallBox.height);
  // 贴在上方或翻到下方都可以（取决于视口余量），但必须整块在视口内且不压住锚点：
  // 被裁剪时最先失守的就是这两条。
  const above = previewBox.y + previewBox.height <= anchorBox.y + 1;
  const below = previewBox.y >= anchorBox.y + anchorBox.height - 1;
  expect(above || below).toBe(true);
  expect(previewBox.y).toBeGreaterThanOrEqual(0);
  expect(previewBox.x).toBeGreaterThanOrEqual(0);
  expect(previewBox.y + previewBox.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  expect(previewBox.x + previewBox.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  // 浮层不接管指针：它挡在光标下也不会把自己触发成 mouseout（否则会闪烁）。
  expect(await preview.evaluate((node) => getComputedStyle(node).pointerEvents)).toBe("none");
}

test.describe("图片悬停预览", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("输入框芯片：悬停浮出原图、不被输入卡裁掉、离开即收回", async ({ page }) => {
    await installShellRoutes(page);
    await page.goto("/agent?new=browser");
    await connect(page);

    const draft = page.getByTestId("assist-first-draft");
    await draft.click();
    await pasteImage(page, '[data-testid="assist-first-draft"]');

    const chip = page.locator(".composer-attachment").first();
    await expect(chip).toBeVisible();
    const preview = page.getByTestId("attachment-preview");
    // 预览不是常驻装饰：没悬停就没有浮层。
    await expect(preview).toHaveCount(0);

    await chip.hover();
    // 原图真的解码出来了（320×200），不是一张裂图或空框。
    await expect.poll(async () =>
      preview.locator("img").evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(320);
    // 浮层在 document.body 上：输入卡发送中 overflow: hidden、对话列本身也是滚动容器，
    // 留在芯片子树里会被裁掉。
    expect(await preview.evaluate((node) => node.parentElement === document.body)).toBe(true);
    await expectPreviewGeometry(page, chip, chip.locator(".composer-attachment-thumb"));
    await page.screenshot({ path: "results/composer-attachment-hover-preview.png" });

    await page.mouse.move(4, 4);
    await expect(preview).toHaveCount(0);
  });

  test("历史消息附件：气泡里的图被压到 12rem，悬停同样能放大", async ({ page }) => {    const base64 = await samplePngBase64(page);
    const session = { id: sessionId, workspace_id: workspaceId, project_id: projectId,
      task_id: null, title: "带图的历史消息", status: "ACTIVE", revision: "1",
      conversation_mode: "AGENT", assistant_profile_id: null,
      created_at: "2026-10-19T00:00:00Z", updated_at: "2026-10-19T00:00:00Z" };
    await page.route(`${apiBase}/**`, async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
      if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
      if (path === `${prefix}/model-port`) {
        return fulfillJson(route, { provider: "fake", configured: false, model: null,
          base_url: null, max_call_tokens: null });
      }
      if (path === `${prefix}/projects/${projectId}`) {
        return fulfillJson(route, { id: projectId, title: "悬停预览验证", project_type: "GENERAL",
          revision: "1", state_revision: "1", archived_at: null });
      }
      if (path === `${prefix}/assist-sessions`) return fulfillJson(route, { items: [session] });
      if (path === `${prefix}/assist-sessions/${sessionId}`) return fulfillJson(route, session);
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`) {
        return fulfillJson(route, { items: [{ id: "55555555-5555-4555-8555-555555555555",
          session_id: sessionId, seq: "1", role: "USER", status: "COMPLETED", intent: "DISCUSS",
          content: "", error_code: null, provider_error_kind: null, sources: [], skill: null,
          skill_input: null, skill_output: null, method: null, method_argument: null,
          provider_request_id: null, usage: { input_tokens: 0, output_tokens: 0 },
          cancel_requested: false,
          attachments: [{ id: attachmentId, name: "历史截图.png", media_type: "image/png",
            byte_length: 3 }],
          created_at: "2026-10-19T00:00:00Z", updated_at: "2026-10-19T00:00:00Z" }] });
      }
      if (path === `${prefix}/assist-sessions/${sessionId}/message-attachments/${attachmentId}`) {
        return fulfillJson(route, { attachment_id: attachmentId, name: "历史截图.png",
          media_type: "image/png", byte_length: 3, data_base64: base64 });
      }
      return fulfillJson(route, { items: [], next_cursor: null });
    });
    await page.goto(`/agent?session=${sessionId}`);
    await connect(page);
    await expect(page.getByTestId("assist-transcript")).toBeVisible({ timeout: 20_000 });

    const figure = page.locator(".message-attachment").first();
    const image = figure.locator(".message-attachment-image");
    await expect.poll(async () =>
      image.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(320);
    const preview = page.getByTestId("attachment-preview");
    await expect(preview).toHaveCount(0);

    await image.hover();
    await expect.poll(async () =>
      preview.locator("img").evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(320);
    // 气泡里的图被 `max-height: 12rem` 压着：预览必须比它大，否则等于没放大。
    await expectPreviewGeometry(page, figure, image);
    await page.screenshot({ path: "results/message-attachment-hover-preview.png" });

    await page.mouse.move(4, 4);
    await expect(preview).toHaveCount(0);
  });

  test("点击芯片打开原图查看层；悬停预览上限是视口六成（2026-10-24 方案 1+2）", async ({ page }) => {
    await installShellRoutes(page);
    await page.goto("/agent?new=browser");
    await connect(page);

    const draft = page.getByTestId("assist-first-draft");
    await draft.click();
    // 1000×400 的宽图：旧上限 480px 会压到读不清，新上限 60%×1280=768px 才放得下。
    await pasteImage(page, '[data-testid="assist-first-draft"]', 1000, 400);

    const chip = page.locator(".composer-attachment").first();
    await expect(chip).toBeVisible();
    await chip.hover();
    const preview = page.getByTestId("attachment-preview");
    await expect(preview).toBeVisible();
    await expectPreviewGeometry(page, chip, chip.locator(".composer-attachment-thumb"));
    const previewBox = (await preview.boundingBox())!;
    // 方案 2 的断言：宽图浮出后明显越过旧 480px 上限（768 + 浮层内边距）。
    expect(previewBox.width).toBeGreaterThan(700);
    await page.mouse.move(4, 4);
    await expect(preview).toHaveCount(0);

    // 方案 1：点击打开整层，原图（1000×400）可解码；Esc 收回。
    await chip.click();
    const lightbox = page.getByTestId("attachment-lightbox");
    await expect(lightbox).toBeVisible();
    await expect.poll(async () => page.getByTestId("attachment-lightbox-image")
      .evaluate((node) => (node as HTMLImageElement).naturalWidth), { timeout: 15_000 })
      .toBe(1000);
    // 分步放大：100%→200%→4×→100%；2× 时图片实际渲染宽度翻倍（1000→2000），
    // 且 max 约束解除——否则 zoom 坐标系里的百分比会把倍数吃掉，看起来「没变化」。
    await page.getByTestId("attachment-lightbox-zoom").click();
    await expect(lightbox).toHaveAttribute("data-zoom", "2");
    const zoomedBox = (await page.getByTestId("attachment-lightbox-image").boundingBox())!;
    expect(zoomedBox.width).toBeGreaterThan(1500);
    await page.screenshot({ path: "results/composer-attachment-lightbox.png" });
    await page.getByTestId("attachment-lightbox-zoom").click();
    await expect(lightbox).toHaveAttribute("data-zoom", "4");
    await page.getByTestId("attachment-lightbox-zoom").click();
    await expect(lightbox).toHaveAttribute("data-zoom", "1");
    await page.keyboard.press("Escape");
    await expect(lightbox).toHaveCount(0);
    // 查看层关掉后悬停预览照常工作：两条入口互不挤占。
    await chip.hover();
    await expect(preview).toBeVisible();
  });
});
