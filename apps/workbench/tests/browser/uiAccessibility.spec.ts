import { expect, test, type Page } from "@playwright/test";

/**
 * 共享组件的真实 Chromium 键盘/焦点验收（UI-UNIFY-02）。
 *
 * jsdom 单测（uiPrimitives/uiComposites/uiLayers）守 DOM 语义；这里补浏览器独占行为：
 * details 的 toggle、原生 focus 顺序、dialog 的 Tab 循环、Esc 与焦点归还。
 * Playwright 的 Chromium 不等于 Windows WebView2，后者按人工矩阵单独验收。
 */

async function openLab(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/__dev/ui");
  await expect(page.getByTestId("ui-lab")).toBeVisible();
}

const inside = (page: Page, selector: string) =>
  page.evaluate((sel) => {
    const panel = document.querySelector(sel);
    return panel !== null && panel.contains(document.activeElement);
  }, selector);

test("Dialog：焦点进入面板、Tab 在内部循环、Esc 关闭并把焦点还给触发器", async ({ page }) => {
  await openLab(page);
  const trigger = page.getByRole("button", { name: "打开对话框" });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "确认删除" });
  await expect(dialog).toBeVisible();
  await expect.poll(() => inside(page, ".dialog-panel")).toBe(true);

  // Tab 走一圈：焦点必须始终留在面板内（AppDialog 的焦点陷阱）。
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press("Tab");
    expect(await inside(page, ".dialog-panel"), `第 ${index + 1} 次 Tab 后焦点离开了对话框`).toBe(true);
  }

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("DropdownMenu：键盘打开后焦点进入首项，方向键移动，Esc 收起并归还焦点", async ({ page }) => {
  await openLab(page);
  await page.locator("#lab-interactive").scrollIntoViewIfNeeded();
  const summary = page.locator("#lab-interactive summary[aria-label='更多操作']");
  await summary.focus();
  await page.keyboard.press("Enter");
  const items = page.locator("#lab-interactive [role='menuitem']");
  await expect(items.first()).toBeFocused();

  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("End");
  await expect(items.last()).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(page.locator("#lab-interactive [role='menu']")).toBeHidden();
  await expect(summary).toBeFocused();
});

test("Tabs：roving tabindex，方向键切换选中项并移动焦点，Home/End 到两端", async ({ page }) => {
  await openLab(page);
  await page.locator("#lab-interactive").scrollIntoViewIfNeeded();
  const tabs = page.getByRole("tablist", { name: "任务范围" }).getByRole("tab");
  await tabs.first().focus();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(tabs.nth(1)).toBeFocused();
  await page.keyboard.press("End");
  const lastEnabled = page.getByRole("tab", { name: "人工待处理" });
  await expect(lastEnabled).toHaveAttribute("aria-selected", "true");
  await expect(lastEnabled).toBeFocused();
  await expect(tabs.last()).toHaveAttribute("tabindex", "-1");
  await page.keyboard.press("Home");
  await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
});

test("Tabs：disabled 项不可聚焦、点击不改变选中项", async ({ page }) => {
  await openLab(page);
  await page.locator("#lab-interactive").scrollIntoViewIfNeeded();
  const disabled = page.getByRole("tab", { name: "已停用" });
  await expect(disabled).toBeDisabled();
  await expect(disabled).toHaveAttribute("tabindex", "-1");
  await disabled.click({ force: true });
  const all = page.getByRole("tab", { name: /全部/ });
  await expect(all).toHaveAttribute("aria-selected", "true");
});

test("Combobox：输入筛选、方向键 + Enter 选择、Esc 只关列表", async ({ page }) => {
  await openLab(page);
  await page.locator("#lab-interactive").scrollIntoViewIfNeeded();
  const input = page.getByRole("combobox", { name: "模型" });
  await input.click();
  await input.fill("gp");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("listbox")).toBeHidden();
  await expect(page.getByText("当前值：gpt5")).toBeVisible();
  await expect(input).toBeFocused();
});

test("ContextMenu：右键打开后焦点进首项，Esc 收起并归还给打开前的活动元素", async ({ page }) => {
  await openLab(page);
  await page.locator("#lab-interactive").scrollIntoViewIfNeeded();
  // 用同一小节里的按钮作为「打开前焦点」：右键目标不可聚焦，归还点必须是真实焦点元素。
  const previous = page.getByRole("button", { name: "悬停或 Tab 到我" });
  await previous.focus();
  await page.getByText("在这个区域点右键").click({ button: "right" });
  const menu = page.getByRole("menu", { name: "示例行操作" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem").nth(1)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(previous).toBeFocused();
});

test("Tooltip：键盘聚焦即显示，Esc 收起且不阻塞焦点", async ({ page }) => {
  await openLab(page);
  await page.locator("#lab-interactive").scrollIntoViewIfNeeded();
  const trigger = page.getByRole("button", { name: "悬停或 Tab 到我" });
  await trigger.focus();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("Toast：反馈进入 live region，可被读屏播报", async ({ page }) => {
  await openLab(page);
  await page.getByRole("button", { name: "触发 Toast" }).click();
  const toast = page.getByTestId("ui-lab-toast");
  await expect(toast).toBeVisible();
  const live = await toast.evaluate((element) => {
    const region = element.closest("[aria-live], [role='status'], [role='alert']");
    return region === null ? null : { live: region.getAttribute("aria-live"), role: region.getAttribute("role") };
  });
  expect(live, "Toast 必须挂在 aria-live/status/alert 容器里").not.toBeNull();
});

test("嵌套浮层：Dialog 内 Popover + Combobox，Esc 逐层关闭且不连带外层", async ({ page }) => {
  await openLab(page);
  await page.getByRole("button", { name: "打开对话框" }).click();
  const dialog = page.getByRole("dialog", { name: "确认删除" });
  await expect(dialog).toBeVisible();

  await page.getByTestId("lab-dialog-popover-trigger").click();
  const popover = page.getByRole("dialog", { name: "对话框内筛选" });
  await expect(popover).toBeVisible();
  const combo = page.getByTestId("lab-dialog-combobox").getByRole("combobox");
  await combo.click();
  await expect(combo).toHaveAttribute("aria-expanded", "true");

  // 第一次 Esc：只关 Combobox 列表，Popover 与 Dialog 都在。
  await page.keyboard.press("Escape");
  await expect(combo).toHaveAttribute("aria-expanded", "false");
  await expect(popover).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(combo).toBeFocused();

  // 第二次 Esc：只关 Popover，Dialog 仍在。
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("lab-dialog-popover-trigger")).toBeFocused();

  // 第三次 Esc：才关闭 Dialog。
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("嵌套浮层：Dialog 内 Tooltip，Esc 先收提醒再关对话框", async ({ page }) => {
  await openLab(page);
  await page.getByRole("button", { name: "打开对话框" }).click();
  const dialog = page.getByRole("dialog", { name: "确认删除" });
  await page.getByTestId("lab-dialog-tooltip").focus();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toBeHidden();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("多层 Dialog：Esc 只关栈顶，内层关闭后外层仍可操作", async ({ page }) => {
  await openLab(page);
  await page.getByRole("button", { name: "打开对话框" }).click();
  const outer = page.getByRole("dialog", { name: "确认删除" });
  await expect(outer).toBeVisible();
  await page.getByTestId("lab-dialog-open-nested").click();
  const inner = page.getByRole("dialog", { name: "第二层确认" });
  await expect(inner).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(inner).toBeHidden();
  await expect(outer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(outer).toBeHidden();
});

test("真实 Chromium IME：组合输入期间 Enter/Escape 不选择、不关列表", async ({ page }) => {
  await openLab(page);
  await page.locator("#lab-interactive").scrollIntoViewIfNeeded();
  const input = page.getByRole("combobox", { name: "模型" });
  await input.click();
  await input.fill("g");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "g", selectionStart: 1, selectionEnd: 1 });
  await page.keyboard.press("Enter");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toBeVisible();
  await cdp.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
  // CDP 的 composition 事件仍不等价于 Windows 输入法；这里证明 Chromium 的 isComposing 路径，
  // 真实微软拼音/搜狗仍按人工矩阵验收。
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toBeHidden();
});

test("生产工具条：Tooltip 接管提示，不叠加原生 title", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/tasks");
  const create = page.getByTestId("titlebar-create-task");
  await expect(create).toBeVisible();
  await expect(create).not.toHaveAttribute("title");
  await create.hover();
  await expect(page.getByRole("tooltip")).toBeVisible();
});
