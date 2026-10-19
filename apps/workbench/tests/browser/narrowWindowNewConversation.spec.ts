import { expect, test, type Page, type Route } from "@playwright/test";

// 2026-10-08 窄窗/短窗「新对话」入口。
// 真实 Chromium：宽度 < 64rem 时 .app-context-rail 整体 display:none，
// 近期工作栏头部那条全局「新对话」随之消失，窄窗必须由导航抽屉承担同一个入口。
// 这里断言可见性、几何、键盘与焦点，不做「某元素存在」的镜像断言。
// API 全部由 page.route 伪造，不连数据库、不调 Provider、不写任何真实业务事实。

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const sessionId = "66666666-6666-4666-8666-666666666666";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const root = "D:\\Develop\\NarrowWindowProject";
const origin = "http://127.0.0.1:4173";

/** 折叠档与短窗两档：743×782 / 733×591 都落在 width < 48rem，是外壳真正折叠的窗口。
    2026-10-15 折叠点由 64rem 下移到 48rem，843/833 一档改为三列（见本文件末尾用例）。 */
const viewports = [{ width: 743, height: 782 }, { width: 733, height: 591 }];

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}

function readyDirectory(): unknown {
  return { canonical_root: root, display_name: "NarrowWindowProject", status: "READY", reason: null,
    association: { project_id: projectId, project_title: "NarrowWindowProject", project_archived: false,
      resource_id: "res-1", resource_status: "ACTIVE", file_write_identity_bound: true },
    created_project: true, created_resource: false, candidates: [],
    write_readiness: { status: "NEEDS_CONNECTION", detail: "本项目还没有绑定该目录的文件写入连接。" } };
}

function project(): unknown {
  return { id: projectId, title: "NarrowWindowProject", project_type: "GENERAL", revision: "1",
    state_revision: "1", archived_at: null };
}

/** 一条已存在的普通讨论：新对话必须不继承它。 */
const existingSession = { id: sessionId, workspace_id: workspaceId, project_id: null, task_id: null,
  title: "已有的普通讨论", status: "ACTIVE", revision: "1",
  created_at: "2026-10-08T00:00:00Z", updated_at: "2026-10-08T00:00:00Z" };

interface Ctx {
  posts: { path: string; body: Record<string, unknown> }[];
  /** 工作空间普通讨论列表是否返回那条既有会话。 */
  withSession: boolean;
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(), body: JSON.stringify(body) });
}

async function installRoutes(page: Page, ctx: Ctx): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }

    if (request.method() === "POST") {
      const body = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>;
      ctx.posts.push({ path, body });
      if (path === `${prefix}/working-directories/open`) {
        return fulfillJson(route, { command_id: body.command_id, committed_at: "2026-10-08T00:00:00Z",
          result: readyDirectory(), links: { resource: "" } });
      }
      return fulfillJson(route, { code: "NOT_FOUND", detail: path }, 404);
    }

    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/projects/${projectId}`) return fulfillJson(route, project());
    if (path === `${prefix}/model-port`) {
      return fulfillJson(route, { provider: "fake", configured: false, model: null, base_url: null,
        max_call_tokens: null });
    }
    if (path === `${prefix}/assist-sessions`) {
      return fulfillJson(route, { items: ctx.withSession ? [existingSession] : [] });
    }
    if (path === `${prefix}/assist-sessions/${sessionId}`) return fulfillJson(route, existingSession);
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) {
      return fulfillJson(route, { items: [
        { id: "u-1", session_id: sessionId, seq: "0", role: "USER", status: "COMPLETED", intent: "DISCUSS",
          content: "旧讨论的第一句", error_code: null, sources: [], cancel_requested: false,
          usage: { input_tokens: 1, output_tokens: 1 } },
        { id: "a-1", session_id: sessionId, seq: "1", role: "ASSISTANT", status: "COMPLETED", intent: "DISCUSS",
          content: "旧讨论的第一句回复", error_code: null, sources: [], cancel_requested: false,
          usage: { input_tokens: 1, output_tokens: 1 } }] });
    }
    // 其余读取一律给空集合：未知端点不是本文件的断言对象，也不该变成错误噪音。
    return fulfillJson(route, { items: [], next_cursor: null });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("narrow-window-browser-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

/** 非桌面宿主没有原生选择器：走既有手动绝对目录入口建立目录作用域。 */
async function openDirectory(page: Page): Promise<void> {
  // 2026-10-10 协作页 §3.3：目录控件收进细条上的「更换目录」浮层（2026-10-18 从居中弹窗改成
  // 锚在目录名上方的紧凑面板）。浮层不是模态框，但控件仍按 body 定位，选择器写法不变。
  await page.getByTestId("folder-scope-change").click();
  await page.locator('[data-testid="folder-manual-root"]').fill(root);
  await page.locator('[data-testid="folder-open-manual"]').click();
  // 目录定下来后浮层自行收起（留着会挡住刚更新的细条）；写入就绪说明仍在浮层内，重开一次核对。
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 20_000 });
  await page.getByTestId("folder-scope-change").click();
  await expect(page.getByTestId("folder-write-readiness")).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

const action = (page: Page) => page.getByTestId("mobile-new-conversation");
const menuButton = (page: Page) => page.getByRole("button", { name: "打开导航" });

async function activeElementLabel(page: Page): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null);
}

test.describe("窄窗与短窗的新对话入口", () => {
  test("上下文栏隐藏后，抽屉里的入口真实可见、尺寸与反馈来自 token，Enter 可触发", async ({ page }) => {
    await page.goto("/agent");
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      // 前提事实：折叠档整体收起两列外壳，导航只走 ☰ 抽屉，栏内入口确实不在页面上。
      await expect(page.locator(".app-navrail")).toBeHidden();
      await expect(page.locator(".app-context-rail")).toBeHidden();
      await expect(page.getByTestId("context-new-conversation")).toBeHidden();
      await expect(menuButton(page)).toBeVisible();

      await menuButton(page).click();
      const entry = action(page);
      await expect(entry).toBeVisible();
      // 动作名是可见文字，不靠 aria-label 猜图标。
      await expect(entry).toHaveText(/新对话/u);
      await expect(entry).toHaveAttribute("href", /^\/agent\?new=/u);

      const look = await entry.evaluate((node) => {
        const root = getComputedStyle(document.documentElement);
        const rootPx = Number.parseFloat(root.fontSize);
        const rem = (name: string) => Number.parseFloat(root.getPropertyValue(name)) * rootPx;
        const style = getComputedStyle(node);
        const box = node.getBoundingClientRect();
        const icon = node.querySelector("svg")!.getBoundingClientRect();
        const label = node.querySelector("span")!.getBoundingClientRect();
        return {
          navHeight: rem("--relay-control-nav-height"),
          bodySize: rem("--relay-font-size-body"),
          focusWidth: rem("--relay-focus-width"),
          hover: root.getPropertyValue("--relay-color-selection-hover").trim(),
          pressed: root.getPropertyValue("--relay-color-selection-bg").trim(),
          height: box.height, width: box.width,
          top: box.top, bottom: box.bottom, left: box.left, right: box.right,
          fontSize: Number.parseFloat(style.fontSize),
          iconSize: icon.width,
          iconCentreDelta: Math.abs((icon.top + icon.height / 2) - (label.top + label.height / 2)),
          background: style.backgroundColor,
          pageWidth: document.documentElement.scrollWidth,
          viewportWidth: document.documentElement.clientWidth,
          viewportHeight: document.documentElement.clientHeight
        };
      });
      // 点击区域不低于 control.nav.height，不能为了塞进抽屉压成细条。
      expect(look.height).toBeGreaterThanOrEqual(look.navHeight - 0.5);
      // 中文标签用正文字号，不靠缩字号把入口塞进去。
      expect(look.fontSize).toBeCloseTo(look.bodySize, 1);
      expect(look.iconSize).toBeGreaterThanOrEqual(16);
      // 图标与文字同一行对齐。
      expect(look.iconCentreDelta).toBeLessThanOrEqual(1);
      // 入口完整落在视口内：短窗也不会被抽屉头部或视口下缘切掉。
      expect(look.top).toBeGreaterThanOrEqual(0);
      expect(look.bottom).toBeLessThanOrEqual(look.viewportHeight + 0.5);
      expect(look.left).toBeGreaterThanOrEqual(0);
      expect(look.right).toBeLessThanOrEqual(look.viewportWidth + 0.5);
      // 不靠扩大横向滚动来腾地方。
      expect(look.pageWidth).toBeLessThanOrEqual(look.viewportWidth + 1);

      // 悬停与按下反馈：颜色直接来自 token，不是随手写的灰。
      // 基座带 120ms transition，因此断言「过渡完成后落到 token 色」，而不是过渡中的中间值。
      const asRgb = (hex: string): string => {
        const value = hex.replace("#", "");
        const full = value.length === 3
          ? value.split("").map((part) => `${part}${part}`).join("")
          : value;
        const channels = [0, 2, 4].map((offset) => Number.parseInt(full.slice(offset, offset + 2), 16));
        return `rgb(${channels.join(", ")})`;
      };
      const backgroundOf = async () => entry.evaluate((node) => getComputedStyle(node).backgroundColor);
      expect(await backgroundOf()).toBe("rgba(0, 0, 0, 0)");
      await entry.hover();
      await expect.poll(backgroundOf, { timeout: 5000 }).toBe(asRgb(look.hover));
      await page.mouse.down();
      await page.mouse.move(look.left + 6, look.top + 6);
      await expect.poll(backgroundOf, { timeout: 5000 }).toBe(asRgb(look.pressed));
      await page.mouse.up();

      // 键盘路径：重新用键盘打开抽屉后，Tab 能到达入口，焦点环可见，Enter 直接进入新讨论。
      // 指针动作会移动焦点，所以键盘段从打开按钮重新起步，不复用指针留下的落点。
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await menuButton(page).focus();
      await page.keyboard.press("Enter");
      await expect(entry).toBeVisible();
      // 抽屉打开后焦点被收进浮层（下一帧交给关闭按钮）；下一次 Tab 必须正好停在「新对话」，
      // 不能隔着别的控件，也不能落在抽屉之外。
      await expect.poll(() => activeElementLabel(page)).not.toBe("打开导航");
      expect(await activeElementLabel(page)).toBe("关闭面板");
      await page.keyboard.press("Tab");
      expect(await entry.evaluate((node) => document.activeElement === node)).toBe(true);
      const ring = await entry.evaluate((node) => {
        const style = getComputedStyle(node);
        return { width: Number.parseFloat(style.outlineWidth), style: style.outlineStyle };
      });
      expect(ring.style).toBe("solid");
      expect(ring.width).toBeCloseTo(look.focusWidth, 1);

      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/agent\?new=/u);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      // 导航层收起后焦点回到打开它的按钮，用户不必从头 Tab 一遍。
      expect(await activeElementLabel(page)).toBe("打开导航");

      await page.goto("/agent");
    }
  });

  test("Escape 关闭抽屉并把焦点还给打开按钮", async ({ page }) => {
    await page.setViewportSize(viewports[1]!);
    await page.goto("/agent");
    await menuButton(page).click();
    await expect(action(page)).toBeVisible();
    await action(page).focus();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await activeElementLabel(page)).toBe("打开导航");
    // 关闭后抽屉里的入口不再占位，重开仍在同一个位置。
    await expect(action(page)).toHaveCount(0);
    await menuButton(page).click();
    await expect(action(page)).toBeVisible();
  });

  test("从已打开目录的空白讨论进入新对话：目录作用域与任务都不继承", async ({ page }) => {
    const ctx: Ctx = { posts: [], withSession: false };
    await installRoutes(page, ctx);
    await page.setViewportSize(viewports[0]!);
    await page.goto("/agent?new=seed");
    await connect(page);
    await openDirectory(page);
    await expect(page.getByTestId("assist-first-draft")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("folder-scope-change")).toContainText("NarrowWindowProject");

    await menuButton(page).click();
    await action(page).click();

    await expect(page).toHaveURL(/\/agent\?new=(?!seed$)/u);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // 目录作用域不继承：范围条回到那颗「选择工作目录」键，写准入说明一并消失。
    await expect(page.getByTestId("folder-scope-change")).toContainText("选择工作目录");
    await expect(page.getByTestId("folder-write-readiness")).toHaveCount(0);
    // 任务上下文不继承。
    await expect(page.getByTestId("collab-goal")).toHaveCount(0);
    // 仍是空白输入主区，没有选中会话。
    await expect(page.getByTestId("assist-first-draft")).toBeVisible();
    await expect(page.getByTestId("assist-session")).toHaveCount(0);
    // 进入新讨论本身不新建会话，也不重复写目录。
    expect(ctx.posts.filter((post) => post.path === `${prefix}/assist-sessions`)).toHaveLength(0);
    expect(ctx.posts.filter((post) => post.path === `${prefix}/working-directories/open`)).toHaveLength(1);
  });

  test("从既有会话进入新讨论：旧会话与任务上下文都不继承", async ({ page }) => {
    const ctx: Ctx = { posts: [], withSession: true };
    await installRoutes(page, ctx);
    await page.setViewportSize(viewports[0]!);
    await page.goto("/agent");
    await connect(page);
    // 普通 /agent 续上最近会话：前态确实带着一条旧讨论。
    await expect(page.getByTestId("assist-session")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("collab-session-title")).toHaveText("已有的普通讨论");
    await expect(page.getByTestId("assist-transcript")).toContainText("旧讨论的第一句");

    await menuButton(page).click();
    await action(page).click();

    await expect(page).toHaveURL(/\/agent\?new=/u);
    // 旧会话不继承：只剩空白输入主区，旧正文不在读区里。
    await expect(page.getByTestId("assist-first-draft")).toBeVisible();
    await expect(page.getByTestId("assist-session")).toHaveCount(0);
    // 顶栏左翼只剩会话名：没有选中会话时那一格也不出现（切换入口本来就在近期工作栏）。
    await expect(page.getByTestId("collab-session-title")).toHaveCount(0);
    await expect(page.getByTestId("assist-transcript")).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText("旧讨论的第一句");
    await expect(page.getByTestId("collab-goal")).toHaveCount(0);
    expect(ctx.posts).toHaveLength(0);
  });

  test("短窗里有草稿时：留在当前工作区保留正文与目录，确认丢弃才切到新讨论", async ({ page }) => {
    const ctx: Ctx = { posts: [], withSession: false };
    await installRoutes(page, ctx);
    await page.setViewportSize(viewports[1]!);
    await page.goto("/agent?new=seed");
    await connect(page);
    await openDirectory(page);
    await expect(page.getByTestId("assist-first-draft")).toBeVisible({ timeout: 20_000 });

    await page.getByTestId("assist-first-draft").fill("短窗里还没发送的草稿");
    const before = page.url();

    // 第一次：守卫拦住，留在当前工作区。
    await menuButton(page).click();
    await action(page).click();
    const guard = page.getByRole("dialog", { name: "保留未保存的修改" });
    await expect(guard).toBeVisible();
    // 抽屉让位给守卫，不叠成两层浮层。
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await guard.getByRole("button", { name: "保留并继续编辑" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByTestId("assist-first-draft")).toHaveValue("短窗里还没发送的草稿");
    await expect(page.getByTestId("folder-scope-change")).toContainText("NarrowWindowProject");
    expect(page.url()).toBe(before);
    // 留在原工作区不产生任何写命令。
    expect(ctx.posts.filter((post) => post.path === `${prefix}/assist-sessions`)).toHaveLength(0);
    expect(ctx.posts.filter((post) => post.path.endsWith("/messages"))).toHaveLength(0);

    // 第二次：明确丢弃才切。
    await menuButton(page).click();
    await action(page).click();
    await page.getByRole("dialog", { name: "保留未保存的修改" })
      .getByRole("button", { name: "丢弃草稿并离开" }).click();
    await expect(page).toHaveURL(/\/agent\?new=(?!seed$)/u);
    await expect(page.getByTestId("assist-first-draft")).toBeVisible();
    await expect(page.getByTestId("folder-scope-change")).toContainText("选择工作目录");
    await expect(page.getByTestId("assist-session")).toHaveCount(0);
    expect(ctx.posts.filter((post) => post.path === `${prefix}/assist-sessions`)).toHaveLength(0);
    expect(ctx.posts.filter((post) => post.path.endsWith("/messages"))).toHaveLength(0);
  });

  // 2026-10-08「保留并继续编辑」的编辑焦点恢复：焦点必须回到触发保护的草稿编辑器并
  // 保留原光标位置，弹层关闭后的默认回焦（「打开导航」按钮）不得覆盖它。真实 Chromium
  // 里核对 document.activeElement 与 selectionStart，组件级时序由 vitest 侧保证。
  test("窄窗首条输入器：保留并继续编辑后焦点与光标回到原位，Tab 从编辑区继续", async ({ page }) => {
    const ctx: Ctx = { posts: [], withSession: false };
    await installRoutes(page, ctx);
    await page.setViewportSize(viewports[0]!);
    await page.goto("/agent?new=seed");
    await connect(page);
    await expect(page.getByTestId("assist-first-draft")).toBeVisible({ timeout: 20_000 });

    const draft = page.getByTestId("assist-first-draft");
    await draft.click();
    await draft.fill("窄窗里还没发送的草稿");
    // 光标放在正文中间：Home 后右移两格。
    await draft.press("Home");
    await draft.press("ArrowRight");
    await draft.press("ArrowRight");
    const caret = await draft.evaluate((node) => (node as HTMLTextAreaElement).selectionStart);
    expect(caret).toBe(2);

    await menuButton(page).click();
    await action(page).click();
    const guard = page.getByRole("dialog", { name: "保留未保存的修改" });
    await expect(guard).toBeVisible();
    await guard.getByRole("button", { name: "保留并继续编辑" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // 焦点直接回到输入器：用户不用重新点击定位就能续写，没有被默认回焦带回「打开导航」。
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null))
      .toBe("assist-first-draft");
    expect(await draft.evaluate((node) => (node as HTMLTextAreaElement).selectionStart)).toBe(caret);
    // 从编辑区继续 Tab 的下一站仍在输入器所在区域，不跳回顶栏或抽屉按钮。
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() =>
      document.activeElement?.closest('[data-testid="assist-first-message"]') !== null)).toBe(true);
  });

  test("窄窗已有会话输入器：保留并继续编辑后焦点与光标回到输入器", async ({ page }) => {
    const ctx: Ctx = { posts: [], withSession: true };
    await installRoutes(page, ctx);
    await page.setViewportSize(viewports[0]!);
    await page.goto("/agent");
    await connect(page);
    await expect(page.getByTestId("assist-session")).toBeVisible({ timeout: 20_000 });

    const draft = page.getByTestId("assist-draft");
    await draft.click();
    await draft.fill("会话里还没发送的草稿");
    await draft.press("Home");
    await draft.press("ArrowRight");
    await draft.press("ArrowRight");
    await draft.press("ArrowRight");
    await draft.press("ArrowRight");
    const caret = await draft.evaluate((node) => (node as HTMLTextAreaElement).selectionStart);
    expect(caret).toBe(4);

    await menuButton(page).click();
    await action(page).click();
    const guard = page.getByRole("dialog", { name: "保留未保存的修改" });
    await expect(guard).toBeVisible();
    await guard.getByRole("button", { name: "保留并继续编辑" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null))
      .toBe("assist-draft");
    expect(await draft.evaluate((node) => (node as HTMLTextAreaElement).value)).toBe("会话里还没发送的草稿");
    expect(await draft.evaluate((node) => (node as HTMLTextAreaElement).selectionStart)).toBe(caret);
    // 会话输入器的 Tab 下一站同样留在会话区域内。
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() =>
      document.activeElement?.closest('[data-testid="assist-session"]') !== null)).toBe(true);
  });

  test("宽窗从近期工作栏入口被拦后，保留并继续编辑同样回到首条输入器", async ({ page }) => {
    const ctx: Ctx = { posts: [], withSession: false };
    await installRoutes(page, ctx);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/agent?new=seed");
    await connect(page);
    await expect(page.getByTestId("assist-first-draft")).toBeVisible({ timeout: 20_000 });

    const draft = page.getByTestId("assist-first-draft");
    await draft.click();
    await draft.fill("宽窗里还没发送的草稿");
    await draft.press("Home");
    await draft.press("ArrowRight");
    await draft.press("ArrowRight");
    const caret = await draft.evaluate((node) => (node as HTMLTextAreaElement).selectionStart);

    // 宽窗没有抽屉：入口是近期工作栏头部的「新对话」，走同一条守卫。
    await page.getByTestId("context-new-conversation").click();
    const guard = page.getByRole("dialog", { name: "保留未保存的修改" });
    await expect(guard).toBeVisible();
    await guard.getByRole("button", { name: "保留并继续编辑" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // 宽窗与窄窗语义一致：焦点与光标回到输入器。
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null))
      .toBe("assist-first-draft");
    expect(await draft.evaluate((node) => (node as HTMLTextAreaElement).selectionStart)).toBe(caret);
  });

  // 2026-10-15 折叠点下移到 48rem：折叠档之上外壳仍是三列，「新对话」留在栏内，
  // ☰ 不再出现——点开只会重复屏幕上已经有的东西。这条断言守住新契约，不是把红改成绿。
  test("折叠点之上保留三列外壳，新对话留在栏内且不出现抽屉入口", async ({ page }) => {
    await installRoutes(page, { posts: [], withSession: false });
    await page.setViewportSize({ width: 843, height: 782 });
    await page.goto("/agent?new=seed");
    await connect(page);
    await expect(page.getByTestId("assist-first-draft")).toBeVisible({ timeout: 20_000 });

    await expect(page.locator(".app-navrail")).toBeVisible();
    await expect(page.locator(".app-context-rail")).toBeVisible();
    await expect(page.getByTestId("context-new-conversation")).toBeVisible();
    await expect(menuButton(page)).toBeHidden();
    // 栏内入口与抽屉入口共用同一条 href，不产生第二个「新对话」意图。
    await expect(page.getByTestId("context-new-conversation"))
      .toHaveAttribute("href", /^\/agent\?new=/u);
  });
});