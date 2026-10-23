import { expect, test, type Page, type Route } from "@playwright/test";
import fs from "node:fs";

// DEV-0116（2026-10-22）「优化一下下拉框ui」——会话模式档从原生 `<select>` 换成应用自绘浮层。
// 用户截图里那条浮层的毛病是**几何**的：它悬在芯片右上方、比芯片还宽，压住了上面那行字，
// 而 `appearance: base-select` 只能改颜色与圆角，改不了锚定与宽度。因此这里量的就是那三件事：
// 浮层左缘与芯片左缘同一条线、宽度不小于芯片、底边在芯片之上不压住任何一行；
// 外加键盘（方向键落在目标档、Enter 才提交）与「当前档只标一行」。
// API 全部由 page.route 伪造：不连数据库、不写真实事实。

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = "http://127.0.0.1:4173";
const OUT = "D:/Develop/Relay-Agent/output/dev-0116-screenshots";

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}
async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(), body: JSON.stringify(body) });
}

async function installRoutes(page: Page): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/model-port`) return fulfillJson(route, { provider: "fake",
      configured: false, model: null, base_url: null, max_call_tokens: null });
    if (path === `${prefix}/model-port/verification`) return fulfillJson(route,
      { current_config_fingerprint: null, last: null, matches_current_config: false,
        worker_startup_validation: "NOT_CONFIGURED" });
    if (path === `${prefix}/default-working-directory`) return fulfillJson(route,
      { resource_id: null, canonical_root: null, display_name: null, write_tier: null,
        default_write_tier: null, status: "UNSET", reason: null, revision: "0" });
    return fulfillJson(route, { items: [], next_cursor: null });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("dev-0116-fake-token");
  await page.getByTestId("relay-connect").click();
  await page.locator('[data-testid="relay-connection-state"]').filter({ hasText: "已连接" })
    .waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

/** 芯片与浮层的盒：一次 evaluate 取全，避免两次读之间布局又动了。 */
async function boxes(page: Page) {
  return page.evaluate(() => {
    const rect = (selector: string) => {
      const node = document.querySelector<HTMLElement>(selector);
      if (node === null) return null;
      const box = node.getBoundingClientRect();
      return { left: Math.round(box.left * 10) / 10, right: Math.round(box.right * 10) / 10,
        top: Math.round(box.top * 10) / 10, bottom: Math.round(box.bottom * 10) / 10,
        width: Math.round(box.width * 10) / 10, height: Math.round(box.height * 10) / 10 };
    };
    // 闭合的 details 里，Chromium 仍给内容盒留一个「上次记住的尺寸」，getBoundingClientRect
    // 照样返回一个盒。所以「收没收起」只能读 details 自己的 open，不能靠有没有盒。
    const details = document.querySelector<HTMLDetailsElement>('[data-testid="conversation-mode-menu"]');
    const open = details?.open === true;
    return { open, chip: rect(".agent-chat-mode-select-field"),
      menu: open ? rect(".agent-chat-mode-options") : null, strip: rect(".agent-chat-composer") };
  });
}

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  await page.locator(".agent-chat-composer").first().screenshot({ path: `${OUT}/${name}.png` });
  await page.screenshot({ path: `${OUT}/${name}-page.png` });
}

test.beforeEach(async ({ page }) => {
  fs.mkdirSync(OUT, { recursive: true });
  await page.setViewportSize({ width: 1162, height: 782 });
  await installRoutes(page);
  await page.goto("/agent?new=", { waitUntil: "domcontentloaded" });
  await connect(page);
  await expect(page.getByTestId("assist-first-draft")).toBeVisible({ timeout: 20_000 });
});

test("芯片收起时只读当前档；展开后浮层与芯片对齐、盖住上面那行的事不再发生", async ({ page }) => {
  const chip = page.getByTestId("conversation-mode-select");
  await expect(chip).toContainText("普通 Agent");
  expect(await chip.getAttribute("data-mode")).toBe("AGENT");
  // 收起：候选不在界面上占任何一行（模式盒只有芯片）。
  expect((await boxes(page)).menu).toBeNull();
  await shot(page, "01-chip-closed");

  await chip.click();
  const look = await boxes(page);
  expect(look.menu, "浮层没渲染").not.toBeNull();
  const menu = look.menu!;
  // 用户截图里的两个毛病：没对齐、比芯片宽还往右跑。
  expect(Math.abs(menu.left - look.chip!.left), "浮层左缘没贴芯片左缘").toBeLessThanOrEqual(1);
  expect(menu.width, "浮层窄于芯片").toBeGreaterThanOrEqual(look.chip!.width - 1);
  // 向上弹出：底边在芯片顶边之上，且不压住输入卡（卡顶就是那一行「未归入项目」的下方）。
  expect(menu.bottom).toBeLessThanOrEqual(look.chip!.top + 1);
  expect(menu.top).toBeGreaterThanOrEqual(look.strip!.top - menu.height - 40);
  await expect(page.locator('[data-testid="conversation-mode-option-AGENT"]')).toHaveAttribute("data-current", "true");
  for (const mode of ["ASSISTANT", "LEARNING"]) {
    await expect(page.locator(`[data-testid="conversation-mode-option-${mode}"]`))
      .toHaveAttribute("data-current", "false");
  }
  // 勾号只画在当前那一行上，另外两行留同宽的占位：三行标签因此左对齐。
  expect(await page.locator(".agent-chat-mode-menu-mark svg").count()).toBe(1);
  await shot(page, "02-menu-open");
});

test("点一行即换档并收起；当前档在浮层里跟着换", async ({ page }) => {
  await page.getByTestId("conversation-mode-select").click();
  await page.getByTestId("conversation-mode-option-ASSISTANT").click();
  const chip = page.getByTestId("conversation-mode-select");
  await expect(chip).toHaveAttribute("data-mode", "ASSISTANT");
  expect((await boxes(page)).menu, "选定后浮层没收起").toBeNull();
  // 助手档的配套入口跟着出现（空清单时「新建助手」就地摆在旁边）。
  await expect(page.getByTestId("assist-assistant-create-entry")).toBeVisible();
  await shot(page, "03-assistant-mode");

  await chip.click();
  await expect(page.locator('[data-testid="conversation-mode-option-ASSISTANT"]'))
    .toHaveAttribute("data-current", "true");
  await shot(page, "04-menu-current-assistant");
});

test("键盘：方向键一次走到目标档并落在该行，Enter 才提交，Esc 只收起", async ({ page }) => {
  const chip = page.getByTestId("conversation-mode-select");
  await chip.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("conversation-mode-option-ASSISTANT")).toBeFocused();
  expect(await chip.getAttribute("data-mode")).toBe("AGENT");   // 移动焦点不是选择
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("conversation-mode-option-LEARNING")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("conversation-mode-option-AGENT")).toBeFocused();   // 末档回绕
  await page.keyboard.press("Escape");
  expect((await boxes(page)).menu, "Esc 没收起浮层").toBeNull();
  await expect(chip).toBeFocused();
  expect(await chip.getAttribute("data-mode")).toBe("AGENT");   // 收起不是选择

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(chip).toHaveAttribute("data-mode", "ASSISTANT");
});
