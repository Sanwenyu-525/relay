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

/**
 * 目录按分类折叠：只有当前场景所属的组默认展开。
 * 点一条别的族的场景前先展开它所在的组——这条步骤替代旧界面「145 条全铺开」的隐含前提，
 * 之后仍然点的是同一颗 `scenario-pick-<id>` 入口，不另开选择路径。
 */
async function pickScenario(page: Page, id: string): Promise<void> {
  const group = page.locator(`[data-testid="scenario-group-${id.charAt(0)}"]`);
  await expect(group).toBeVisible();
  const item = page.locator(`[data-testid="scenario-pick-${id}"]`);
  if (!(await item.isVisible())) await group.click();
  await expect(item).toBeVisible();
  await item.click();
  await expect(page.locator(`[data-scenario-preview] [data-scenario-id="${id}"]`)).toHaveCount(1);
}

/** 检查面板默认关闭；展示设置与事件时间线都在里面，先打开再切到目标页签。 */
async function openInspectorTab(page: Page, tab: "display" | "timeline" | "verification"): Promise<void> {
  const toggle = page.locator('[data-testid="scenario-inspector-toggle"]');
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.locator(`[data-testid="scenario-inspector-tab-${tab}"]`).click();
  await expect(page.locator(`[data-testid="scenario-inspector-tab-${tab}"]`)).toHaveAttribute("aria-selected", "true");
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
    // A05 是单帧场景：不显示无意义的播放/进度控件，只给静态状态标识与「重新检查」。
    const controls = page.getByRole("complementary", { name: "场景控制器" });
    await expect(page.locator('[data-testid="scenario-static-preview"]')).toBeVisible();
    await expect(page.locator('[data-testid="scenario-check-again"]')).toBeVisible();
    await expect(page.locator('[data-testid="scenario-play"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="scenario-step"]')).toHaveCount(0);
    await expect(page.getByTestId("scenario-static-strip")).toBeVisible();
    await expect(controls).toBeVisible();

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

  test("刷新后仍返回进入前的页面，且只记录站内路径", async ({ page }) => {
    await page.goto("/tasks?tab=inbox");
    await openLabFromNav(page);
    // 回退来源只保存 path+search，不夹带任何业务载荷。
    const stored = await page.evaluate(() => window.sessionStorage.getItem("relay.scenario-lab.from"));
    expect(stored).toBe("/tasks?tab=inbox");

    await page.reload();
    await expect(page.locator(".scenario-lab-page")).toBeVisible();
    const back = page.locator('[data-testid="scenario-back-to-workbench"]');
    await expect(back).toHaveText(/返回进入前的页面/u);
    await back.click();
    await expect(page).toHaveURL(/\/tasks\?tab=inbox$/u);
  });

  test("直接打开实验室时不沿用上次来源，仍回 /agent", async ({ page }) => {
    // 先正常进入一次，让 sessionStorage 留下旧来源；再离开并从地址栏直接打开实验室。
    await page.goto("/tasks?tab=inbox");
    await openLabFromNav(page);
    await page.goto("/agent");
    await page.goto(LAB);
    const back = page.locator('[data-testid="scenario-back-to-workbench"]');
    await expect(back).toHaveText(/返回工作台/u);
    // 直接打开时旧记录应被清掉：随后刷新也不能把旧来源借回来。
    expect(await page.evaluate(() => window.sessionStorage.getItem("relay.scenario-lab.from"))).toBeNull();
    await page.reload();
    await expect(back).toHaveText(/返回工作台/u);
    await back.click();
    await expect(page).toHaveURL(/\/agent$/u);
  });

  test("来源不是站内路径时不跳转外站，回 /agent", async ({ page }) => {
    await page.goto(LAB);
    const back = page.locator('[data-testid="scenario-back-to-workbench"]');
    // 正向对照：合法来源能经 history state 生效，证明下面不是「注入没生效」而误判。
    await page.evaluate(() => {
      window.history.pushState({ usr: { from: "/tasks?tab=inbox" }, key: "safe", idx: 0 },
        "", "/__dev/assist-scenarios");
      window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
    });
    await page.reload();
    await expect(back).toHaveText(/返回进入前的页面/u);

    // 反向：协议相对地址与实验室自身都不能成为返回目标。
    for (const unsafe of ["//evil.example/phish", "/__dev/assist-scenarios?scenario=A03"]) {
      await page.evaluate((from) => {
        window.history.pushState({ usr: { from }, key: `unsafe-${from}`, idx: 0 },
          "", "/__dev/assist-scenarios");
        window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
      }, unsafe);
      await expect(back, `来源 ${unsafe} 不应被当作返回目标`).toHaveText(/返回工作台/u);
      expect(await back.getAttribute("href"), `来源 ${unsafe} 产生了越站链接`).toBe("/agent");
    }
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
    await pickScenario(page, "A04");
    await page.locator('[data-testid="scenario-play"]').click();
    await page.waitForTimeout(400);
    await pickScenario(page, "B14");
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

  test("窄窗 560：入口在导航抽屉里可达，预览仍是主内容，目录与检查面板按需浮出", async ({ page }) => {
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

    // 预览第一：目录默认收进抽屉，播放条仍在预览上方，不把页面先铺成一列场景目录。
    await expect(page.locator(".scenario-lab-directory")).toBeHidden();
    const stage = page.locator(".scenario-lab-stage");
    await expect(stage).toBeVisible();
    await expect(page.locator('[data-scenario-preview]')).toBeVisible();
    await expect(page.locator('[data-testid="scenario-static-preview"]')).toBeVisible();
    await expect(page.locator('[data-testid="scenario-check-again"]')).toBeVisible();
    await expect(page.locator('[data-testid="scenario-play"]')).toHaveCount(0);
    const stageWidth = (await stage.boundingBox())?.width ?? 0;
    expect(stageWidth, "560px 下预览没有拿到主体宽度").toBeGreaterThan(480);

    // 目录是覆盖抽屉：打开后仍不抢预览的列宽，浮层宽度受视口约束。
    await page.locator('[data-testid="scenario-directory-toggle"]').click();
    const directory = page.getByRole("navigation", { name: "场景目录" });
    await expect(directory).toBeVisible();
    await expect(page.locator('[data-testid="scenario-directory-toggle"]')).toHaveAttribute("aria-expanded", "true");
    const overlayWidth = (await directory.boundingBox())?.width ?? 0;
    expect(overlayWidth, "窄窗目录越出视口").toBeLessThanOrEqual(560 * 0.94 + 1);
    expect((await stage.boundingBox())?.width ?? 0, "目录抽屉把预览列挤窄了").toBe(stageWidth);
    await page.locator('[data-testid="scenario-directory-close"]').click();
    await expect(directory).toBeHidden();

    // 检查面板同样按需浮出，Esc 可关；预览列宽在打开与关闭之间不变。
    await page.locator('[data-testid="scenario-inspector-toggle"]').click();
    const inspector = page.getByRole("complementary", { name: "检查面板" });
    await expect(inspector).toBeVisible();
    expect((await stage.boundingBox())?.width ?? 0, "检查面板抽屉把预览列挤窄了").toBe(stageWidth);
    await page.keyboard.press("Escape");
    await expect(inspector).toBeHidden();
    expect((await stage.boundingBox())?.width ?? 0, "关闭检查面板后预览列宽没有恢复").toBe(stageWidth);
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

    await pickScenario(page, "B01");
    await expect(page.locator('[data-scenario-id="A04"]')).toHaveCount(0);
    await expect(page.locator('[data-scenario-id="B01"]')).toHaveCount(1);
    // B01 也是单帧：切换后进入静态状态预览，不残留上一条场景的播放条。
    await expect(page.locator('[data-testid="scenario-play"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="scenario-static-preview"]')).toBeVisible();
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
    await pickScenario(page, "G01");
    await openInspectorTab(page, "timeline");
    const jumps = page.locator('[data-testid^="scenario-jump-"]');
    const last = await jumps.count();
    expect(last).toBeGreaterThan(1);
    await jumps.nth(last - 1).click();
    await openInspectorTab(page, "verification");
    const results = page.locator(".scenario-lab-results li[data-status]");
    await expect(results.first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.scenario-lab-results li[data-status="fail"]')).toHaveCount(0);
    await expect(page.locator('[data-testid^="scenario-pick-"]')).toHaveCount(145);
  });
});
