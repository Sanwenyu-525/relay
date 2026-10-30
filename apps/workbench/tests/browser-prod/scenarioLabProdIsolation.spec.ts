import { expect, test, type Page } from "@playwright/test";

/**
 * 生产产物的浏览器级隔离复验（`playwright.prod.config.ts` 专用）。
 *
 * `scripts/check-scenario-lab-isolation.mjs` 用逐串搜产物证明「实验室代码不在生产包里」，
 * 这里补的是另一半：**在真产物、真路由下走一遍**。只搜字符串证明不了路由表里没有那条路，
 * 只在开发服务器上点也证明不了生产点不进去——开发服务器里 DEV 恒为真。
 *
 * 每条测试都同时抓两类证据：界面里没有入口/实验室，网络里没有实验室 chunk。
 * 再加一条产品自身的串做反向对照，避免把「页面根本没起来」读成「隔离成功」。
 */
const LAB = "/__dev/assist-scenarios";
const ENTRY = `a[href="${LAB}"]`;
/** 与 `playwright.prod.config.ts` 的 baseURL 同源：请求全部落在预览服务上。 */
const ORIGIN = "http://127.0.0.1:4180";

/** 记录本次页面发出的所有请求，用来证明实验室 chunk 确实没被下载。 */
function trackRequests(page: Page): { pathname: string; method: string; origin: string; kind: string }[] {
  const seen: { pathname: string; method: string; origin: string; kind: string }[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    seen.push({ pathname: url.pathname, method: request.method(), origin: url.origin,
      kind: request.resourceType() });
  });
  return seen;
}

/**
 * 只认「脚本请求」里的实验室：直连那条 URL 时文档请求自己就叫 `assist-scenarios`，
 * 把它算进来会把「页面正确落到 404」读成「实验室被加载」。
 */
const labRequests = (seen: { pathname: string; kind: string }[]): string[] =>
  seen.filter((item) => item.kind === "script")
    .map((item) => item.pathname)
    .filter((pathname) => /scenario/iu.test(pathname));

test.describe("生产构建没有开发工具入口", () => {
  test("辅助导航里没有「开发工具」，也没有指向实验室的链接或提示", async ({ page }) => {
    const seen = trackRequests(page);
    await page.goto("/projects", { waitUntil: "domcontentloaded" });

    // 反向对照：壳真起来了、产品代码真的在跑，下面的「没有」才有意义。
    await expect(page.locator(".app-navrail")).toBeVisible();
    const productAlive = await page.evaluate(() => {
      const keys: string[] = [];
      for (let index = 0; index < window.localStorage.length; index += 1) {
        keys.push(window.localStorage.key(index) ?? "");
      }
      return keys.some((key) => key.startsWith("relay."))
        || document.body.textContent?.includes("项目") === true;
    });
    expect(productAlive).toBe(true);

    await expect(page.getByRole("navigation", { name: "辅助导航" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "辅助导航" })).not.toContainText("开发工具");
    await expect(page.locator('[title="AI 回复场景实验室"]')).toHaveCount(0);
    await expect(page.locator(ENTRY)).toHaveCount(0);
    await expect(page.locator('a[href*="__dev"]')).toHaveCount(0);

    // 界面没入口还不算完：懒加载的实验室 chunk 也不能被顺手拉下来。
    expect(labRequests(seen)).toEqual([]);
    expect(seen.every((item) => item.origin === ORIGIN)).toBe(true);
    expect(seen.every((item) => item.method === "GET")).toBe(true);
  });

  test("手动访问 /__dev/assist-scenarios 落到未开放入口，不加载实验室", async ({ page }) => {
    const seen = trackRequests(page);
    await page.goto(LAB, { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "该入口不存在或未开放" })).toBeVisible();
    await expect(page.locator(".scenario-lab-page")).toHaveCount(0);
    await expect(page.locator("#scenario-lab-manifest")).toHaveCount(0);
    await expect(page.locator("[data-scenario-preview]")).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "场景目录" })).toHaveCount(0);
    await expect(page.getByText("AI 回复场景实验室")).toHaveCount(0);

    expect(labRequests(seen)).toEqual([]);
    expect(seen.every((item) => item.origin === ORIGIN)).toBe(true);
    expect(seen.every((item) => item.method === "GET")).toBe(true);

    // 兜底页本身可点回产品：说明这一页是产品的 404，不是白屏或开发服务器回退到实验室。
    await page.getByRole("link", { name: /返回项目列表/u }).click();
    await expect(page).toHaveURL(/\/projects$/u);
    await expect(page.locator(".scenario-lab-page")).toHaveCount(0);
  });
});
