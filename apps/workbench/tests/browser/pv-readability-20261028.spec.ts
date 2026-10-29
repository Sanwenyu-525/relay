import { expect, test, type Locator } from "@playwright/test";

// 示例模式只验证真实 Chromium 渲染，不证明真实 API 或 Windows DPI。
async function contrast(locator: Locator): Promise<number> {
  return locator.evaluate((element) => {
    function rgba(value: string): number[] {
      const parts = value.match(/[\d.]+/gu)?.map(Number) ?? [];
      return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
    }
    function over(front: number[], back: number[]): number[] {
      const alpha = front[3] + back[3] * (1 - front[3]);
      if (alpha === 0) return [0, 0, 0, 0];
      return [0, 1, 2].map((i) => (front[i] * front[3] + back[i] * back[3] * (1 - front[3])) / alpha).concat(alpha);
    }
    function luminance(color: number[]): number {
      const channels = color.slice(0, 3).map((value) => {
        const normalized = value / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    }
    let background = [255, 255, 255, 1];
    const layers: number[][] = [];
    let opacity = 1;
    for (let current: Element | null = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      layers.push(rgba(style.backgroundColor));
      opacity *= Number(style.opacity);
    }
    for (let i = layers.length - 1; i >= 0; i--) background = over(layers[i], background);
    const foreground = rgba(getComputedStyle(element).color);
    foreground[3] *= opacity;
    const first = luminance(over(foreground, background));
    const second = luminance(background);
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
  });
}

test("任务页共用辅助文字和状态可读：实际前景与背景对比至少 4.5:1", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tasks");
  const selectors = [
    ".pv-page .page-head-overline",
    ".pv-page .data-row--head .data-cell",
    ".pv-page .data-cell small",
    ".pv-page .data-cell--meta",
    ".pv-page .status-chip--neutral",
    ".pv-page .status-chip--warning",
    ".pv-page .list-footer-note"
  ];
  for (const selector of selectors) {
    const target = page.locator(selector).first();
    await expect(target, selector).toBeVisible();
    expect(await contrast(target), selector).toBeGreaterThanOrEqual(4.5);
  }
  await page.goto("/tasks?view=create");
  const hint = page.locator(".pv-page .helper-text").first();
  await expect(hint).toBeVisible();
  expect(await contrast(hint)).toBeGreaterThanOrEqual(4.5);
});

test("项目页主操作保留明显的主按钮样式", async ({ page }) => {
  await page.goto("/projects");
  const primary = page.getByTestId("project-create-open");
  await expect(primary).toBeVisible();
  const colors = await primary.evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, foreground: style.color };
  });
  expect(colors.background).not.toBe("rgb(255, 255, 255)");
  expect(await contrast(primary)).toBeGreaterThanOrEqual(4.5);
});

test("任务创建页在 200% 内容缩放和窄窗口下保持可操作", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/tasks?view=create");
  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  const title = page.locator(".pv-page h1").first();
  await expect(title).toBeVisible();
  expect((await title.boundingBox())?.width ?? 0, "缩放后标题不能被右侧栏挤成竖排").toBeGreaterThanOrEqual(200);
  await expect(page.locator(".pv-page input").first()).toBeVisible();
  const zoomOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(zoomOverflow).toBeLessThanOrEqual(1);

  await page.evaluate(() => { document.documentElement.style.zoom = ""; });
  await page.setViewportSize({ width: 390, height: 720 });
  const narrowOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(narrowOverflow).toBeLessThanOrEqual(1);
  await page.locator(".pv-page input").first().focus();
  await expect(page.locator(".pv-page input").first()).toBeFocused();
});
