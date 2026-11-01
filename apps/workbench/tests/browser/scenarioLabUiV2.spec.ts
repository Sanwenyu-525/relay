import { expect, test, type Page } from "@playwright/test";

/**
 * 场景实验室 V2（Preview-first 开发者工作区）的界面结构回归。
 *
 * 与 `assistScenarioLab.spec.ts` 的分工：
 *   * 那一份判「场景内容与十条 DOM 性质」；这一份判新外壳的布局、目录、播放条、
 *     检查面板与 Gallery 入口，避免 UI 重设计把原有功能或窄窗行为悄悄丢掉。
 *   * 断言仍只认现有 testid；新增的抽屉与页签也走用户能点到的入口，不直写内部状态。
 *   * 视觉像素由 `tmp/Scenario-Lab-UI-V2` 的截图批次负责，这里量的是几何与可见性。
 */

const LAB = "/__dev/assist-scenarios";

async function openLab(page: Page, query = ""): Promise<void> {
  await page.goto(`${LAB}${query}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-scenario-lab]")).toBeVisible();
  await expect(page.locator("[data-scenario-preview]")).toBeVisible();
}

async function openInspectorTab(page: Page, tab: "display" | "timeline" | "verification"): Promise<void> {
  const toggle = page.locator("[data-testid='scenario-inspector-toggle']");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.locator(`[data-testid="scenario-inspector-tab-${tab}"]`).click();
  await expect(page.locator(`[data-testid="scenario-inspector-tab-${tab}"]`)).toHaveAttribute("aria-selected", "true");
}

const widthOf = async (page: Page, selector: string): Promise<number> =>
  (await page.locator(selector).boundingBox())?.width ?? 0;

test.describe("Preview-first 布局", () => {
  test("默认桌面：预览拿到主体宽度，目录 220–250px，检查面板不占位", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openLab(page);

    // 实验室是 page-focused：近期工作栏让位，不改普通页的收起偏好。
    await expect(page.locator(".app-context-rail")).toBeHidden();

    const directoryWidth = await widthOf(page, ".scenario-lab-directory");
    expect(directoryWidth, `目录宽度 ${directoryWidth}px 超出 220–250 的导航档`).toBeGreaterThanOrEqual(220);
    expect(directoryWidth).toBeLessThanOrEqual(250);

    const stageWidth = await widthOf(page, ".scenario-lab-stage");
    expect(stageWidth, "预览列没有拿到主体宽度").toBeGreaterThan(1000);
    const listWidth = await widthOf(page, "[data-scenario-preview] .agent-message-list");
    expect(listWidth, "回复阅读列没有拿到稳定的聊天 measure").toBeGreaterThanOrEqual(700);

    const inspector = page.getByRole("complementary", { name: "检查面板" });
    await expect(inspector, "检查面板默认不应占据预览宽度").toBeHidden();

    const playback = page.getByRole("complementary", { name: "场景控制器" });
    await expect(playback).toBeVisible();
    // A05 是单帧：播放条收敛成静态标识，不提供无法推进的播放/进度控件。
    await expect(page.locator("[data-testid='scenario-static-preview']")).toBeVisible();
    await expect(page.locator("[data-testid='scenario-play']")).toHaveCount(0);
    await expect(page.locator("[data-testid='scenario-step']")).toHaveCount(0);
    await expect(page.locator("[data-testid='scenario-seek']")).toHaveCount(0);
    await expect(page.locator("[data-testid='scenario-loop']")).toHaveCount(0);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth
      - document.documentElement.clientWidth);
    expect(overflow, "默认桌面出现页面级横向溢出").toBeLessThanOrEqual(0);
  });

  test("检查面板：打开固定、关闭后预览立即变宽，窄预览只收舞台中央", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openLab(page);
    const stage = page.locator(".scenario-lab-stage");
    const closedWidth = (await stage.boundingBox())?.width ?? 0;

    await openInspectorTab(page, "display");
    const inspector = page.getByRole("complementary", { name: "检查面板" });
    await expect(inspector).toBeVisible();
    await expect(page.locator("[data-testid='scenario-density-standard']")).toBeVisible();
    await expect(page.locator("[data-testid='scenario-motion-on']")).toBeVisible();
    await expect(page.locator("[data-testid='scenario-expand-all']")).toBeVisible();
    const openWidth = (await stage.boundingBox())?.width ?? 0;
    expect(openWidth, "检查面板打开后预览列没有收窄").toBeLessThan(closedWidth);
    expect(openWidth, "检查面板抢走了过多预览宽度").toBeGreaterThan(700);

    // 预览宽度三档只改舞台中央的模拟窗口，不改变实验室列宽。
    await page.locator("[data-testid='scenario-viewport-phone']").click();
    await expect(page.locator(".scenario-shell")).toHaveAttribute("data-viewport", "phone");
    // 2026-10-31 一致性修复：手机档模拟的是 560px 宽的**窗口**，不再把 --chat-measure
    // 改写成 100%（那是给实验室另造一档宽度，和真实 560px 窗口的换行位置不同）。
    // 因此这里量的是窗口宽度，阅读列宽度由产品自己的规则决定。
    const shellWidth = await widthOf(page, ".scenario-shell");
    expect(Math.round(shellWidth), "手机档模拟的是 560px 窗口").toBe(560);
    const phoneListWidth = await widthOf(page, ".scenario-shell .agent-message-list");
    expect(Math.round(phoneListWidth), "560px 窗口里阅读列被可用宽度夹满").toBe(560);
    expect((await stage.boundingBox())?.width ?? 0, "切换预览宽度改变了实验室列宽").toBe(openWidth);

    await page.locator("[data-testid='scenario-inspector-toggle']").click();
    await expect(inspector).toBeHidden();
    expect((await stage.boundingBox())?.width ?? 0, "关闭检查面板后预览宽度没有恢复").toBe(closedWidth);
  });

  test("滚动只发生在预览列：目录与播放条不随回复滚动", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 520 });
    await openLab(page, "?scenario=F13&frame=0");
    const scroll = page.locator(".scenario-lab-preview-scroll");
    const room = await scroll.evaluate((node) => node.scrollHeight - node.clientHeight);
    expect(room, "F13 没有可滚高度，滚动归属测量不成立").toBeGreaterThan(80);

    await scroll.evaluate((node) => { node.scrollTop = 120; });
    const before = await scroll.evaluate((node) => node.scrollTop);
    await page.locator("[data-testid='scenario-step']").click();
    await page.waitForTimeout(400);
    const after = await scroll.evaluate((node) => node.scrollTop);
    expect(after, "推进一帧把用户正在读的滚动位置推走了").toBe(before);
    expect(await page.evaluate(() => window.scrollY), "页面根滚动被预览内容带走了").toBe(0);
  });
});

test.describe("场景目录", () => {
  test("分类折叠、搜索与筛选都从真实场景状态与验收结果产生", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openLab(page);

    // 默认只展开当前场景所属的 A 族；B 族收起，B01 不可见但仍挂在目录里。
    await expect(page.locator("[data-testid='scenario-group-B']")).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("[data-testid='scenario-pick-B01']")).toBeHidden();
    await page.locator("[data-testid='scenario-group-B']").click();
    await expect(page.locator("[data-testid='scenario-group-B']")).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("[data-testid='scenario-pick-B01']")).toBeVisible();
    await page.locator("[data-testid='scenario-group-B']").click();
    await expect(page.locator("[data-testid='scenario-pick-B01']")).toBeHidden();

    // 搜索自动展开命中分类；当前场景不能在筛选后消失，必须留在「当前场景」置顶行。
    await page.locator("[data-testid='scenario-search']").fill("F07");
    await expect(page.locator("[data-testid='scenario-group-F']")).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("[data-testid='scenario-pick-F07']")).toBeVisible();
    await expect(page.locator("[data-testid='scenario-pick-A05']"), "当前场景被搜索藏起来了").toBeVisible();
    expect(await page.locator("[data-testid^='scenario-pick-']").count()).toBeLessThan(145);

    await page.locator("button[aria-label='清空搜索']").click();

    // 异常筛选由 stateKind（失败/未知/取消）或真实验收失败产生，不靠标题猜。
    await page.locator("[data-testid='scenario-filter-error']").click();
    await expect(page.locator("[data-testid='scenario-filter-error']")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("[data-testid='scenario-pick-A14']")).toBeVisible();
    await expect(page.locator("[data-testid='scenario-pick-A05']"), "当前场景在筛选后必须仍可见").toBeVisible();
    const filtered = await page.locator("[data-testid^='scenario-pick-']").count();
    expect(filtered, "异常筛选没有缩小目录").toBeLessThan(145);
    expect(filtered, "异常筛选把全部场景都排除了").toBeGreaterThan(0);

    await page.locator("[data-testid='scenario-filter-all']").click();
    await expect(page.locator("[data-testid='scenario-filter-all']")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("[data-testid='scenario-pick-B01']"), "恢复全部后应回到折叠态").toBeHidden();
  });

  test("检查面板的事件时间线可跳帧，验收页签给真实断言", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openLab(page);
    await openInspectorTab(page, "timeline");
    const jumps = page.locator("[data-testid^='scenario-jump-']");
    expect(await jumps.count(), "事件时间线没有列出帧").toBeGreaterThan(0);
    const last = (await jumps.count()) - 1;
    await jumps.nth(last).click();
    await expect(page.locator(".scenario-lab-controls-head")).toContainText(`第 ${last + 1}`);
    await openInspectorTab(page, "verification");
    const results = page.locator(".scenario-lab-results li[data-status]");
    await expect(results.first(), "末帧没有跑出静态断言").toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".scenario-lab-results li[data-status='fail']")).toHaveCount(0);
    await expect(page.locator(".scenario-lab-data-details")).not.toHaveAttribute("open", "");
  });
});

test.describe("播放控制条", () => {
  test("上一帧 / 下一帧 / 跳转 / 重置 / 速度与循环都由同一个回放器驱动", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openLab(page, "?scenario=A04&frame=0");
    const head = page.locator(".scenario-lab-controls-head");
    await expect(head).toContainText("第 1/3 帧");

    await page.locator("[data-testid='scenario-step']").click();
    await expect(head).toContainText("第 2/3 帧");
    await page.locator("[data-testid='scenario-prev']").click();
    await expect(head).toContainText("第 1/3 帧");

    const seek = page.locator("[data-testid='scenario-seek']");
    await seek.focus();
    await page.keyboard.press("End");
    await expect(head).toContainText("第 3/3 帧");
    await expect(page.locator("[data-testid='scenario-step']")).toBeDisabled();
    await page.keyboard.press("Home");
    await expect(head).toContainText("第 1/3 帧");

    await page.locator("[data-testid='scenario-speed-2']").click();
    await expect(page.locator("[data-testid='scenario-speed-2']")).toHaveAttribute("aria-pressed", "true");
    await page.locator("[data-testid='scenario-loop']").click();
    await expect(page.locator("[data-testid='scenario-loop']")).toHaveAttribute("aria-pressed", "true");

    await page.locator("[data-testid='scenario-play']").click();
    await expect(page.locator("[data-testid='scenario-play']")).toHaveAttribute("aria-pressed", "true");
    await page.waitForTimeout(250);
    await page.locator("[data-testid='scenario-play']").click();
    await expect(page.locator("[data-testid='scenario-play']")).toHaveAttribute("aria-pressed", "false");
    await page.locator("[data-testid='scenario-reset']").click();
    await expect(head).toContainText("第 1/3 帧");
  });
});

test.describe("展示全部状态", () => {
  test("按分类切换网格，卡片用真实组件，点卡片回单场景", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openLab(page);
    await page.locator("[data-testid='scenario-mode-gallery']").click();
    await expect(page.locator("[data-scenario-card]")).toHaveCount(16, { timeout: 20_000 });
    await expect(page.locator("[data-scenario-card='A01'] .scenario-shell")).toHaveCount(1);

    await page.locator("[data-testid='scenario-family-F']").click();
    await expect(page.locator("[data-scenario-card]")).toHaveCount(20, { timeout: 20_000 });
    expect(await page.locator("[data-scenario-card] .scenario-shell").count()).toBe(20);

    await page.locator("[data-scenario-card='F01'] .scenario-lab-card-open").click();
    await expect(page.locator("[data-scenario-preview] [data-scenario-id='F01']")).toHaveCount(1);
    await expect(page.getByRole("complementary", { name: "场景控制器" })).toBeVisible();
  });
});

test.describe("窄窗", () => {
  for (const width of [900, 560]) {
    test(`${width}px：目录与检查面板浮出，预览列宽不变，播放条可触达`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await openLab(page, "?scenario=A04&frame=0");
      const stage = page.locator(".scenario-lab-stage");
      const stageWidth = (await stage.boundingBox())?.width ?? 0;
      expect(stageWidth, `${width}px 下预览没有拿到主体宽度`).toBeGreaterThan(width * 0.8);

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth
        - document.documentElement.clientWidth);
      expect(overflow, `${width}px 下出现页面级横向溢出`).toBeLessThanOrEqual(0);

      await expect(page.locator(".scenario-lab-directory")).toBeHidden();
      await page.locator("[data-testid='scenario-directory-toggle']").click();
      await expect(page.getByRole("navigation", { name: "场景目录" })).toBeVisible();
      expect((await stage.boundingBox())?.width ?? 0, `${width}px 目录把预览挤窄`).toBe(stageWidth);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("navigation", { name: "场景目录" })).toBeHidden();

      await page.locator("[data-testid='scenario-inspector-toggle']").click();
      const inspector = page.getByRole("complementary", { name: "检查面板" });
      await expect(inspector).toBeVisible();
      expect((await stage.boundingBox())?.width ?? 0, `${width}px 检查面板把预览挤窄`).toBe(stageWidth);
      await page.keyboard.press("Escape");
      await expect(inspector).toBeHidden();

      await expect(page.locator("[data-testid='scenario-play']")).toBeVisible();
      await expect(page.locator("[data-testid='scenario-step']")).toBeVisible();
      await expect(page.locator("[data-testid='scenario-seek']")).toBeVisible();
      const controlsHeight = (await page.locator(".scenario-lab-controls").boundingBox())?.height ?? 999;
      expect(controlsHeight, `${width}px 下播放条被撑成三层`).toBeLessThan(100);
    });
  }
});

/**
 * 响应式档位（2026-10-31 一致性修复后的补充）。
 *
 * 与「窄窗」那一组的分工：那一组判抽屉与覆盖式面板，这一组只判「五个档位都不横向溢出、
 * 阅读列宽度仍由产品规则决定、标题区不塌成多行」。五档是用户明确要求覆盖的宽度。
 */
test.describe("响应式档位", () => {
  for (const width of [1440, 1280, 1160, 900, 560]) {
    test(`${width}px：无横向溢出，阅读列与标题区按档位就位`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openLab(page, "?scenario=A07");

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth
        - document.documentElement.clientWidth);
      expect(overflow, `${width}px 下出现页面级横向溢出`).toBeLessThanOrEqual(0);

      // 阅读列：≥900 时 46.5rem（744px）放得下，就应该是 744——实验室不再自己改这一档。
      if (width >= 900) {
        const listWidth = (await page.locator(".agent-message-list").first().boundingBox())?.width ?? 0;
        expect(Math.round(listWidth), `${width}px 下阅读列不是产品的 744px 档`).toBe(744);
      }

      // 标题区：宽窗是一行，窄窗允许换行，但不该占掉半屏。
      // 实测：≥1160 为一行（71px），900/560 折成两行（111px）。上限只防「塌成三行」。
      const headHeight = (await page.locator(".scenario-lab-head").boundingBox())?.height ?? 999;
      expect(headHeight, `${width}px 下标题区高度失控`).toBeLessThan(width >= 1160 ? 80 : 140);

      await expect(page.locator("[data-testid='scenario-inspector-toggle']")).toBeVisible();
      await expect(page.locator("[data-testid='scenario-mode-single']")).toBeVisible();
    });
  }
});
