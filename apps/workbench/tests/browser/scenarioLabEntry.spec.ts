import { expect, test, type Page } from "@playwright/test";

/**
 * 开发工具入口与实验室在**真实应用外壳里**的集成验收。
 *
 * 与 `assistScenarioLab.spec.ts` 分工不同：那一份判「场景本身的状态与十条 DOM 性质」，
 * 这一份只判「从工作台点进来、在里面干活、再回去」这条桌面路径，包括：
 * 入口位置与提示、选中态、返回来源、窄窗抽屉、场景切换后的清理、全程不碰真实执行系统。
 */

const LAB = "/__dev/assist-scenarios";
const ENTRY = `a[href="${LAB}"]`;

async function openLabFromNav(page: Page): Promise<void> {
  const aux = page.getByRole("navigation", { name: "辅助导航" });
  await expect(aux.locator(ENTRY)).toHaveCount(1);
  await aux.locator(ENTRY).click();
  await expect(page).toHaveURL(new RegExp(`${LAB}$`, "u"));
  await expect(page.locator(".scenario-lab-page")).toBeVisible();
}

async function snapshotStorage(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const entries: Record<string, string> = {};
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key !== null) entries[key] = window.localStorage.getItem(key) ?? "";
    }
    return entries;
  });
}

test.describe("开发工具入口", () => {
  test("辅助导航里只有一处，悬停提示是实验室全名，未进入时不是当前页", async ({ page }) => {
    await page.goto("/projects");
    const aux = page.getByRole("navigation", { name: "辅助导航" });
    const entry = aux.locator(ENTRY);
    await expect(entry).toHaveCount(1);
    await expect(entry).toContainText("开发工具");
    await expect(entry).toHaveAttribute("title", "AI 回复场景实验室");
    await expect(entry).not.toHaveAttribute("aria-current", "page");
    // 主导航不重复挂同一条；「开发工具」只占辅助导航一格。
    await expect(page.getByRole("navigation", { name: "主导航" }).locator(ENTRY)).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "次级导航" }).locator(ENTRY)).toHaveCount(0);
  });

  test("点击进入实验室：三栏齐备、145 条场景、面包屑与选中态都对", async ({ page }) => {
    await page.goto("/projects");
    await openLabFromNav(page);

    const aux = page.getByRole("navigation", { name: "辅助导航" });
    await expect(aux.locator(ENTRY)).toHaveAttribute("aria-current", "page");

    const breadcrumbs = page.getByRole("navigation", { name: "面包屑" });
    await expect(breadcrumbs).toContainText("开发工具");
    await expect(breadcrumbs).toContainText("AI 回复场景实验室");

    await expect(page.getByRole("navigation", { name: "场景目录" })).toBeVisible();
    await expect(page.locator('[data-testid^="scenario-pick-"]')).toHaveCount(145);
    await expect(page.locator("[data-scenario-preview] [data-scenario-id]")).toHaveCount(1);
    const controls = page.getByRole("complementary", { name: "场景控制器" });
    await expect(controls.getByRole("button", { name: "播放" })).toBeVisible();
    await expect(page.locator('[data-testid="scenario-step"]')).toBeVisible();
    await expect(page.locator('[data-testid="scenario-reset"]')).toBeVisible();

    const manifest = JSON.parse(await page.locator("#scenario-lab-manifest").innerText()) as unknown[];
    expect(manifest).toHaveLength(145);
  });

  test("返回入口回到进入前的页面（含查询串）；在实验室里再点一次入口不会把来源改掉", async ({ page }) => {
    await page.goto("/tasks?tab=inbox");
    await openLabFromNav(page);
    const back = page.locator('[data-testid="scenario-back-to-workbench"]');
    await expect(back).toBeVisible();
    await expect(back).toHaveText(/返回进入前的页面/u);
    await back.click();
    await expect(page).toHaveURL(/\/tasks\?tab=inbox$/u);
    await expect(page.locator(".scenario-lab-page")).toHaveCount(0);

    // 再进去，并在实验室里又点了一次侧栏入口：来源应原样保留，返回仍回 /tasks?tab=inbox。
    await openLabFromNav(page);
    await page.getByRole("navigation", { name: "辅助导航" }).locator(ENTRY).click();
    await expect(page.locator(".scenario-lab-page")).toBeVisible();
    await page.locator('[data-testid="scenario-back-to-workbench"]').click();
    await expect(page).toHaveURL(/\/tasks\?tab=inbox$/u);
  });

  test("从工作台进入时按钮写「返回工作台」，返回 /agent", async ({ page }) => {
    await page.goto("/agent");
    await openLabFromNav(page);
    const back = page.locator('[data-testid="scenario-back-to-workbench"]');
    await expect(back).toHaveText(/返回工作台/u);
    await back.click();
    await expect(page).toHaveURL(/\/agent$/u);
  });

  test("全程不向真实执行系统发请求；返回后存储只动了两个视图偏好", async ({ page }) => {
    const requests: string[] = [];
    page.on("request", (request) => { requests.push(`${request.method()} ${request.url()}`); });

    await page.goto("/agent");
    const before = await snapshotStorage(page);
    const motionBefore = await page.evaluate(() => document.documentElement.dataset.motion ?? "");
    const densityBefore = before["relay.workbench.activityDensity"] ?? "standard";

    await openLabFromNav(page);
    await page.locator('[data-testid="scenario-pick-A04"]').click();
    await page.locator('[data-testid="scenario-play"]').click();
    await page.waitForTimeout(400);
    await page.locator('[data-testid="scenario-pick-B14"]').click();
    await page.locator('[data-testid="scenario-next"]').click();
    await page.locator('[data-testid="scenario-back-to-workbench"]').click();
    await expect(page).toHaveURL(/\/agent$/u);

    const origin = new URL(page.url()).origin;
    const foreign = requests.filter((line) => !line.includes(origin));
    expect(foreign, `实验室发出了跨源请求：${foreign.join(" / ")}`).toEqual([]);
    const mutations = requests.filter((line) => !line.startsWith("GET "));
    expect(mutations, `实验室发出了写请求：${mutations.join(" / ")}`).toEqual([]);

    const after = await snapshotStorage(page);
    const changed = Object.keys({ ...before, ...after }).filter((key) => before[key] !== after[key]);
    expect(changed.filter((key) => key !== "relay.motion" && key !== "relay.workbench.activityDensity"),
      `实验室改动了视图偏好以外的存储：${changed.join(" / ")}`).toEqual([]);
    const motionAfter = await page.evaluate(() => document.documentElement.dataset.motion ?? "");
    expect(motionAfter, "离开实验室后动效偏好没有还原").toBe(motionBefore);
    expect(after["relay.workbench.activityDensity"] ?? "standard", "离开实验室后阅读密度没有还原")
      .toBe(densityBefore);
  });

  test("默认窗口高下入口不用滚动就点得到", async ({ page }) => {
    // 辅助导航整块是 `margin-top: auto` 贴底的：默认窗口高下图标栏内容高过可视区，
    // 这一组的末位会落到折叠线以下，放末位就得先滚动才点得到「开发工具」。
    await page.setViewportSize({ width: 1160, height: 780 });
    await page.goto("/projects");
    const entry = page.getByRole("navigation", { name: "辅助导航" }).locator(ENTRY);
    await expect(entry).toBeVisible();
    const box = await entry.boundingBox();
    const viewport = page.viewportSize();
    expect(box, "入口没有几何盒").not.toBeNull();
    expect(box!.y, "入口被推到视口上方之外").toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height, "入口下半截落在视口之外")
      .toBeLessThanOrEqual(viewport!.height);
  });

  test("近期工作栏收起后入口仍在且可点", async ({ page }) => {
    // /projects 是「页聚焦」布局（整栏让位给项目网格），这里要的是带近期工作栏的常规页。
    await page.goto("/tasks");
    await page.locator('[data-testid="context-rail-collapse"]').click();
    await expect(page.locator(".app-frame")).toHaveAttribute("data-context-collapsed", "true");
    await expect(page.locator('[data-testid="context-rail-collapse"]')).toHaveAttribute("aria-expanded", "false");
    await openLabFromNav(page);
    await expect(page.locator(".scenario-lab-page")).toBeVisible();
  });

  test("窄窗 560：入口在导航抽屉里可达，三栏纵向排布且无页面级横向溢出", async ({ page }) => {
    await page.setViewportSize({ width: 560, height: 760 });
    await page.goto("/projects");
    await expect(page.locator(".app-navrail")).toBeHidden();
    await page.getByRole("button", { name: "打开导航" }).click();
    const drawer = page.getByRole("navigation", { name: "完整导航" });
    const entry = drawer.locator(ENTRY);
    await expect(entry).toHaveCount(1);
    await expect(entry).toHaveAttribute("title", "AI 回复场景实验室");
    await entry.click();
    await expect(page).toHaveURL(new RegExp(`${LAB}$`, "u"));
    await expect(page.locator(".scenario-lab-page")).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth
      - document.documentElement.clientWidth);
    expect(overflow, "560px 宽下出现页面级横向溢出").toBeLessThanOrEqual(0);

    const boxes = await page.evaluate(() => [".scenario-lab-directory", ".scenario-lab-stage", ".scenario-lab-controls"]
      .map((selector) => {
        const node = document.querySelector(selector);
        if (node === null) return null;
        const rect = node.getBoundingClientRect();
        return { top: Math.round(rect.top), left: Math.round(rect.left), width: Math.round(rect.width) };
      }));
    expect(boxes.every((box) => box !== null), "窄窗下三栏有缺失").toBe(true);
    const [directory, stage, controls] = boxes as { top: number; width: number }[];
    expect(stage!.top, "窄窗下预览应排在目录之下").toBeGreaterThan(directory!.top);
    expect(controls!.top, "窄窗下控制器应排在预览之下").toBeGreaterThan(stage!.top);
  });

  test("切换场景后停播、帧归零，上一场景的计时器与动画都不再留下", async ({ page }) => {
    const countPreviewAnimations = (): Promise<number> => page.evaluate(() => {
      const root = document.querySelector("[data-scenario-preview]");
      if (root === null) return -1;
      return document.getAnimations()
        .filter((animation) => animation.playState === "running")
        .filter((animation) => {
          const target = (animation.effect as KeyframeEffect | null)?.target ?? null;
          return target !== null && target !== undefined && root.contains(target);
        }).length;
    });

    await page.goto(`${LAB}?scenario=A04`);
    await expect(page.locator('[data-scenario-id="A04"]')).toHaveCount(1);
    await page.locator('[data-testid="scenario-play"]').click();
    await expect(page.locator('[data-testid="scenario-play"]')).toHaveAttribute("aria-pressed", "true");
    await page.waitForTimeout(500);
    const playingFrame = await countPreviewAnimations();
    expect(playingFrame, "播放中预览区应有受控动画").toBeGreaterThan(0);

    await page.locator('[data-testid="scenario-pick-B01"]').click();
    await expect(page.locator('[data-scenario-id="A04"]')).toHaveCount(0);
    await expect(page.locator('[data-scenario-id="B01"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="scenario-play"]')).toHaveAttribute("aria-pressed", "false");
    const head = page.locator(".scenario-lab-controls-head");
    await expect(head).toContainText("第 1/1 帧");
    await page.waitForTimeout(700);
    await expect(head).toContainText("第 1/1 帧", { timeout: 2_000 });

    // 干净的判据不是「一条动画都没有」：B01 的消息本身仍在进行，标题行的主进度是产品应有的那一个。
    // 判的是「切换后与直接打开这一条完全一样」——多出来的任何动画都说明上一场景没清干净。
    const afterSwitch = await countPreviewAnimations();
    await page.goto(`${LAB}?scenario=B01`);
    await expect(page.locator('[data-scenario-id="B01"]')).toHaveCount(1);
    await page.waitForTimeout(700);
    const fresh = await countPreviewAnimations();
    expect(afterSwitch, "切换场景后残留了上一场景的动画").toBe(fresh);
  });

  test("在真实外壳里播到末帧，静态断言照常出结果", async ({ page }) => {
    await page.goto(LAB);
    await page.locator('[data-testid="scenario-pick-G01"]').click();
    const jumps = page.locator('[data-testid^="scenario-jump-"]');
    const last = await jumps.count();
    expect(last).toBeGreaterThan(1);
    await jumps.nth(last - 1).click();
    const results = page.locator(".scenario-lab-results li[data-status]");
    await expect(results.first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.scenario-lab-results li[data-status="fail"]')).toHaveCount(0);
    await expect(page.locator('[data-testid^="scenario-pick-"]')).toHaveCount(145);
  });
});
