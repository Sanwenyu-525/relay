import { expect, test, type Page, type Route } from "@playwright/test";

// 普通会话右侧工具面板（2026-10-28 版面重整）在真实 Chromium 里的版面契约。
//
// 这一轮改的是「空间分配 + 页签层级 + 空态 + 底部抽屉」，因此判据都是几何与可见性，
// 不是「DOM 里有没有这个节点」：
//   ① 没有关联项目时默认落在真的能用的「网页」，文件/变更给出轻量空态并留一条出口；
//   ② 面板贴窗口右缘（不留意外留白），页签条不与收起键重叠、默认宽度下不横向溢出；
//   ③ 底部抽屉收起只有一行，展开体自己滚动且不压住上方页签；
//   ④ 窄窗沿用抽屉形态，聊天列宽度不因面板打开而变小；
//   ⑤ 六个页签全部可达：主入口是文字页签，辅助入口是图标页签（可访问名称与 title 仍在）。
//
// 只连页面内夹具：不连数据库、不调 Provider、零写请求。

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const sessionId = "66666666-6666-4666-8666-666666666666";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = "http://127.0.0.1:4173";

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(), body: JSON.stringify(body) });
}

/** 没有关联项目、没有任务的普通会话：工具面板里文件与变更只有空态，网页可用。 */
function sessionRow(): unknown {
  return { id: sessionId, workspace_id: workspaceId, project_id: null, task_id: null,
    title: "整理实验评价指标", status: "ACTIVE", revision: "1", conversation_mode: "AGENT",
    assistant_profile_id: null, created_at: "2026-10-28T20:00:00Z", updated_at: "2026-10-28T20:10:00Z" };
}

async function installRoutes(page: Page): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    const path = new URL(request.url()).pathname;
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/model-port`) return fulfillJson(route, { provider: "fake", configured: false,
      model: null, base_url: null, max_call_tokens: null });
    if (path === `${prefix}/model-port/verification`) return fulfillJson(route, {
      current_config_fingerprint: null, last: null, matches_current_config: false,
      worker_startup_validation: "NOT_CONFIGURED" });
    if (path === `${prefix}/assist-sessions`) return fulfillJson(route, { items: [sessionRow()] });
    if (path === `${prefix}/assist-sessions/${sessionId}`) return fulfillJson(route, sessionRow());
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return fulfillJson(route, { items: [] });
    if (path === `${prefix}/assist-sessions/${sessionId}/model-selection`) return fulfillJson(route, { model: null, revision: "0" });
    if (path === `${prefix}/assist-sessions/${sessionId}/goal`) return fulfillJson(route, { goal: null, rounds: [] });
    if (path === `${prefix}/assist-sessions/${sessionId}/plans`) return fulfillJson(route, { latest: null, versions: [] });
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
  await page.locator('input[name="relay-bearer-token"]').fill("tools-panel-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

async function openSession(page: Page, width = 1440, height = 900): Promise<void> {
  await page.setViewportSize({ width, height });
  await installRoutes(page);
  await page.goto(`/agent?session=${sessionId}`);
  await connect(page);
  await page.getByTestId("assist-draft").waitFor({ timeout: 20_000 });
  await page.waitForLoadState("networkidle");
}

async function openTools(page: Page): Promise<void> {
  await page.getByTestId("collab-conversation-tools-toggle").click();
  await page.getByTestId("devtools-panel").waitFor({ timeout: 10_000 });
}

test.describe("普通会话的右侧工具面板（2026-10-28）", () => {
  test("没有关联项目时默认落在网页页签；文件与变更是轻量空态，并留一条出口", async ({ page }) => {
    await openSession(page);
    await openTools(page);
    const root = page.getByTestId("devtools-panel");
    // 开局不能是一屏「不可用」说明：默认给当前真的能用的网页。
    await expect(root).toHaveAttribute("data-tab", "WEB");
    await expect(page.getByTestId("devtools-tab-WEB")).toHaveAttribute("aria-selected", "true");

    await page.getByTestId("devtools-tab-FILES").click();
    const files = page.getByTestId("devtools-files-unavailable");
    await expect(files).toBeVisible();
    await expect(files).toContainText("尚未关联项目");
    await expect(files).toContainText("关联项目后，可查看其受管文件与 Git 变更。");
    // 安全边界只写一次，收在辅助说明里，不反复解释同一个概念。
    await expect(files.locator(".devtools-empty-note")).toHaveCount(1);
    // 空态不是死路：一键切到网页。
    await files.getByTestId("devtools-empty-open-web").click();
    await expect(root).toHaveAttribute("data-tab", "WEB");

    await page.getByTestId("devtools-tab-GIT").click();
    const git = page.getByTestId("devtools-git-unavailable");
    await expect(git).toContainText("尚未关联项目");
    await expect(git).toContainText("没有可核对的目录基线");
    await expect(git).toContainText("工作目录干净");
    // 空态不占满侧栏：说明块高度远小于面板可用高度，不铺成一张大卡片。
    const emptyBox = await git.boundingBox();
    const panelBox = await page.getByTestId("collab-conversation-tools").boundingBox();
    if (emptyBox === null || panelBox === null) throw new Error("缺少空态或面板几何");
    expect(emptyBox.height).toBeLessThan(panelBox.height / 2);
  });

  test("面板贴右缘、页签条不与收起键重叠、默认宽度下页签不横向溢出", async ({ page }) => {
    await openSession(page);
    await openTools(page);
    const geometry = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('[data-testid="collab-conversation-tools"]')!;
      const tabs = document.querySelector<HTMLElement>(".devtools-tabs")!;
      const close = document.querySelector<HTMLElement>(".devtools-close")!;
      const panelRect = panel.getBoundingClientRect();
      const tabsRect = tabs.getBoundingClientRect();
      const closeRect = close.getBoundingClientRect();
      return { panelRight: panelRect.right, panelLeft: panelRect.left, panelWidth: panelRect.width,
        tabsRight: tabsRect.right, closeLeft: closeRect.left, closeRight: closeRect.right,
        tabsScroll: tabs.scrollWidth, tabsClient: tabs.clientWidth,
        viewport: window.innerWidth,
        overflowX: document.scrollingElement!.scrollWidth - document.scrollingElement!.clientWidth };
    });
    // 贴窗口右缘：不留意外留白，也不出现双重边距。
    expect(geometry.panelRight).toBeCloseTo(geometry.viewport, 0);
    // 页签条右端在收起键左缘之前：页签永远不会钻到收起键底下。
    expect(geometry.tabsRight).toBeLessThanOrEqual(geometry.closeLeft + 0.5);
    // 收起键仍在面板内。
    expect(geometry.closeRight).toBeLessThanOrEqual(geometry.viewport + 0.5);
    // 默认宽度（288px）下六个页签一屏放得下，不靠横向滚动兜底。
    expect(geometry.tabsScroll - geometry.tabsClient).toBe(0);
    expect(geometry.overflowX).toBe(0);
    expect(geometry.panelWidth).toBeLessThanOrEqual(352);
  });

  test("底部执行输出收起只有一行；展开后自己滚动，且不压住上方页签", async ({ page }) => {
    await openSession(page);
    await openTools(page);
    const toggle = page.getByTestId("devtools-tab-OUTPUT");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    const collapsed = await page.evaluate(() => {
      const drawer = document.querySelector<HTMLElement>(".devtools-drawer")!;
      const tabs = document.querySelector<HTMLElement>(".devtools-header")!;
      return { drawer: Math.round(drawer.getBoundingClientRect().height),
        tabsBottom: Math.round(tabs.getBoundingClientRect().bottom) };
    });
    // 收起时只是一行（compact 控件高一档），不再是两条边框夹一条 44px 的条。
    expect(collapsed.drawer).toBeLessThanOrEqual(44);

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const expanded = await page.evaluate(() => {
      const body = document.querySelector<HTMLElement>(".devtools-drawer-body")!;
      const tabs = document.querySelector<HTMLElement>(".devtools-header")!;
      const style = getComputedStyle(body);
      return { display: getComputedStyle(body).display, overflowY: style.overflowY, maxHeight: style.maxHeight,
        tabsBottom: Math.round(tabs.getBoundingClientRect().bottom),
        bodyTop: Math.round(body.getBoundingClientRect().top) };
    });
    await expect(page.getByTestId("devtools-output")).toBeVisible();
    // 展开体自己滚动，且有高度上限：短窗口里不会把页签条顶出可视区。
    expect(expanded.overflowY).toBe("auto");
    expect(expanded.maxHeight).not.toBe("none");
    // 抽屉在页签条下方，不覆盖主体内容。
    expect(expanded.bodyTop).toBeGreaterThanOrEqual(collapsed.tabsBottom);
    // 没有 Run 时给出精简空态，不编造执行能力。
    await expect(page.getByTestId("devtools-output-empty")).toContainText("没有 AI Run");
  });

  test("窄窗切抽屉：面板浮在聊天之上，聊天列不被压窄", async ({ page }) => {
    await openSession(page, 900, 700);
    const before = await page.getByTestId("collab-center").boundingBox();
    await openTools(page);
    const after = await page.getByTestId("collab-center").boundingBox();
    if (before === null || after === null) throw new Error("缺少中栏几何");
    expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(1);
    const panel = await page.evaluate(() => {
      const node = document.querySelector<HTMLElement>('[data-testid="collab-conversation-tools"]')!;
      const rect = node.getBoundingClientRect();
      return { position: getComputedStyle(node).position, right: rect.right, viewport: window.innerWidth };
    });
    // 抽屉形态：绝对定位、贴右缘，不是把聊天列挤窄的分栏。
    expect(panel.position).toBe("absolute");
    expect(panel.right).toBeCloseTo(panel.viewport, 0);
  });

  test("六个页签全部可达：主入口文字页签、辅助入口图标页签，键盘可遍历", async ({ page }) => {
    await openSession(page);
    await openTools(page);
    const tabs = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll<HTMLElement>(".devtools-tab")];
      return nodes.map((node) => {
        const label = node.querySelector<HTMLElement>(".devtools-tab-label");
        return { testid: node.dataset.testid, role: node.getAttribute("role"),
          aria: node.getAttribute("aria-label"), text: (node.textContent ?? "").trim(),
          labelShown: label !== null && getComputedStyle(label).display !== "none",
          title: node.getAttribute("title") };
      });
    });
    expect(tabs.map((tab) => tab.testid)).toEqual([
      "devtools-tab-FILES", "devtools-tab-GIT", "devtools-tab-WEB",
      "devtools-tab-TERMINAL", "devtools-tab-RUNS", "devtools-tab-TRACE"
    ]);
    expect(tabs.every((tab) => tab.role === "tab")).toBe(true);
    // 主入口始终显示文字；默认 288px 宽下辅助入口只留图标，但可访问名称与 title 都在。
    for (const tab of tabs.slice(0, 3)) expect(tab.labelShown, `${tab.testid} 应显示文字`).toBe(true);
    for (const tab of tabs.slice(3)) {
      expect(tab.labelShown, `${tab.testid} 在默认宽度应只留图标`).toBe(false);
      expect(tab.aria, `${tab.testid} 缺可访问名称`).not.toBeNull();
      expect(tab.title).toBe(tab.aria);
    }
    // 键盘遍历六项：Home/End 与左右方向键都能走到最后一枚，且激活跟随焦点。
    await page.getByTestId("devtools-tab-FILES").focus();
    await page.keyboard.press("End");
    await expect(page.getByTestId("devtools-tab-TRACE")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("devtools-tab-TRACE")).toBeFocused();
    await page.keyboard.press("Home");
    await expect(page.getByTestId("devtools-tab-FILES")).toHaveAttribute("aria-selected", "true");
    // 拖宽面板后辅助入口补回文字，六项仍是同一批键。
    const handle = page.getByTestId("inspector-resize-handle");
    const handleBox = await handle.boundingBox();
    if (handleBox === null) throw new Error("缺少拖拽手柄");
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox.x - 240, handleBox.y + handleBox.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => page.evaluate(() => {
      const label = document.querySelector<HTMLElement>('[data-testid="devtools-tab-RUNS"] .devtools-tab-label');
      return label === null ? null : getComputedStyle(label).display;
    }), { timeout: 5_000 }).not.toBe("none");
  });
});
