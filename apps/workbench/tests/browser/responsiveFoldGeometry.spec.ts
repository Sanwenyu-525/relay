import { expect, test, type Page, type Route } from "@playwright/test";

// 2026-10-10 响应式收敛的几何核对（真实 Chromium，页面内拦截伪造 API）。
// 覆盖本轮两处档位合并的边界行为：40rem 兜底档并入 48rem 折行档、 styles.css 顶栏兜底同样并入 48rem。
// 断言口径：档位边界两侧行为正确（767 折行 / 768 不折行）、任何边界宽度都不产生横向溢出。
// 只连页面内夹具，不连数据库、不调 Provider。

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = "http://127.0.0.1:4173";
const taskId = "33333333-3333-4333-8333-333333333333";
const projectId = "22222222-2222-4222-8222-222222222222";

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(), body: JSON.stringify(body) });
}

const task = { id: taskId, project_id: projectId, title: "整理资料并补充完成条件", status: "READY", mode: "ME",
  revision: "4", executor: { kind: "HUMAN", run_id: null }, current_completion_id: null,
  waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
  dependencies: [], updated_at: "2026-10-10T02:28:00Z",
  acceptance: { acceptance_revision: "2", objective: "形成结构化综述。",
    expected_outputs: { literature_review: "MARKDOWN" }, source: "HUMAN",
    criteria: [{ criterion_id: "c1", statement: "覆盖近五年核心文献。", required: true, method: "HUMAN", target_spec: {} }] } };

async function installTaskDetail(page: Page): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/tasks`) return fulfillJson(route, { items: [], next_cursor: null });
    if (path === `${prefix}/projects`) return fulfillJson(route, { items: [], next_cursor: null });
    if (path === `${prefix}/tasks/${taskId}`) return fulfillJson(route, task);
    if (path === `${prefix}/projects/${projectId}`) return fulfillJson(route, { id: projectId, title: "科研协作系统",
      project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
    if (path === `${prefix}/tasks/${taskId}/check-plan-preview`) return fulfillJson(route, { task_id: taskId, status: "AVAILABLE",
      admission_available: true, frozen_run_plan: false, executed: false, reason_codes: [],
      check_plan_sha256: "a".repeat(64),
      sources: { task_revision: "4", acceptance_revision: "2", rule_revision: null,
        workflow_key: "markdown-deliverable-v1", workflow_version: "1", rule_refs: [] },
      check_plan: { policy_version: "1", workflow_key: "markdown-deliverable-v1", workflow_version: "1", entries: [] } });
    if (path === `${prefix}/tasks/${taskId}/artifacts`) return fulfillJson(route, { items: [], next_cursor: null, current_accepted_version_ids: [] });
    return fulfillJson(route, { code: "NOT_STUBBED", detail: path }, 404);
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("responsive-fold-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

/** 按子元素实际横向位置数列：单列返回 1，多列按不同 x 的数量返回（对串行化格式不敏感）。 */
async function columnCount(page: Page, selector: string): Promise<number> {
  return page.evaluate((css) => {
    const element = document.querySelector(css);
    if (element === null) return -1;
    const positions = new Set(Array.from(element.children)
      .map((child) => Math.round(child.getBoundingClientRect().x)));
    return positions.size;
  }, selector);
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const root = document.scrollingElement!;
    return root.scrollWidth - root.clientWidth;
  });
}

/**
 * grid 轨数：量容器真实解出的列轨。
 * 不能用 `columnCount`（数子节点 x）—— 拖拽手柄是绝对定位的子节点，
 * 它的 x 与列边界不重合，会把三列数成四列。
 */
async function gridTracks(page: Page, selector: string): Promise<number> {
  return page.evaluate((css) => {
    const element = document.querySelector(css);
    if (element === null) return -1;
    const tracks = getComputedStyle(element).gridTemplateColumns;
    return tracks === "none" ? 0 : tracks.trim().split(/\s+/u).length;
  }, selector);
}

/**
 * 一栏的可见性：CSS 隐藏、零尺寸与「不在 DOM」是三种不同结果，必须分开报，
 * 否则 display:none 与「渲染失败」会得到同一个绿色。
 */
async function shellVisibility(page: Page, selector: string):
Promise<"visible" | "hidden" | "zero-size" | "missing"> {
  return page.evaluate((css) => {
    const element = document.querySelector(css) as HTMLElement | null;
    if (element === null) return "missing";
    if (getComputedStyle(element).display === "none") return "hidden";
    const box = element.getBoundingClientRect();
    return box.width === 0 || box.height === 0 ? "zero-size" : "visible";
  }, selector);
}

test.describe("48rem 折行档与外壳折叠点的边界行为（2026-10-10 收敛回写 / 2026-10-15 折叠点下移）", () => {
  for (const width of [700, 767, 768, 900, 1023, 1024]) {
    test(`${width}px：无横向溢出，折行与外壳折叠都只在 <48rem 生效`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await installTaskDetail(page);
      await page.goto(`/tasks/${taskId}`);
      await connect(page);
      await page.getByTestId("task-detail-page-head").waitFor({ timeout: 20_000 });

      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);

      const folded = width < 768;
      // 基础信息列表：原 40rem 兜底档写得是 dl 自身，而 dl 并不是 grid 容器（行级两列由
      // .definition-list > div 承担），因此该规则历来无实际效果。并入 48rem 后仍保持同样语义：
      // 每行「标签 | 值」两列、行间单列堆叠，任何宽度都不变成两列堆叠。
      expect(await columnCount(page, ".task-detail-basic-list")).toBe(1);
      // 应用外壳：<48rem 由窄窗收纳（导航进抽屉）保持单列；48rem–64rem 仍是三列；
      // ≥64rem 三列并放开用户拖拽宽度。本断言守住两档互不打破。
      const frameTracks = await gridTracks(page, ".app-frame");
      expect(frameTracks, `app-frame 列轨 ${frameTracks}`).toBe(width >= 768 ? 3 : 1);
      // 两栏与抽屉入口：外壳没折叠时图标导航与近期工作都常驻，☰ 不该再出现
      //（点开只会重复屏幕上已有的内容）；折叠档三样都收进抽屉。
      const tier = width >= 768 ? "visible" : "hidden";
      expect(await shellVisibility(page, ".app-navrail")).toBe(tier);
      expect(await shellVisibility(page, ".app-context-rail")).toBe(tier);
      await expect(page.locator(".app-topbar .mobile-menu-button"))
        .toBeVisible({ visible: width < 768 });
      // 内容列不得被两栏挤到阅读下限以下（layout.workspace.centerMin = 26rem）。
      if (width >= 768) {
        const rootRem = await page.evaluate(() =>
          Number.parseFloat(getComputedStyle(document.documentElement).fontSize));
        const centre = await page.locator(".app-content").boundingBox();
        expect(centre!.width).toBeGreaterThanOrEqual(26 * rootRem - 1);
      }
      // 顶栏兜底（原 40rem）：<48rem 收起面包屑中端，只保留当前层级；≥48rem 完整可见。
      await expect(page.locator(".app-topbar .breadcrumb-item:not(:last-child)").first())
        .toBeVisible({ visible: !folded });
      await expect(page.locator(".app-topbar .breadcrumb-item:last-child")).toBeVisible();
    });
  }

  // 2026-10-15：用户拖拽出来的列宽只在 ≥64rem 生效。夹具无法真的拖拽，
  // 这里直接写与拖拽手柄同源的变量，再看列宽实际落到哪里——只看变量不看列宽，
  // 变量生效但模板没用上时会漏过去。
  test("两列外壳之间有间隙：底色分野才有边界，激活条不顶到右缘", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await installTaskDetail(page);
    await page.goto(`/tasks/${taskId}`);
    await connect(page);
    await page.getByTestId("task-detail-page-head").waitFor({ timeout: 20_000 });

    const shell = await page.evaluate(() => {
      const navrail = document.querySelector(".app-navrail")!;
      const rail = document.querySelector(".app-context-rail")!;
      const navrailBox = navrail.getBoundingClientRect();
      const railBox = rail.getBoundingClientRect();
      const navrailStyle = getComputedStyle(navrail);
      const railStyle = getComputedStyle(rail);
      // 两栏底色不同（navigation 浅绿白 vs surface 纯白）时，必须靠间隙分隔，
      // 否则两栏读成一整块、激活条直接顶到边界。
      const active = navrail.querySelector(".navigation-item--active");
      return {
        gap: Math.round(railBox.left - navrailBox.right),
        activeToEdge: active === null ? null
          : Math.round(navrailBox.right - active.getBoundingClientRect().right),
        navrailBg: navrailStyle.backgroundColor,
        railBg: railStyle.backgroundColor,
        columnGap: getComputedStyle(document.querySelector(".app-frame")!).columnGap
      };
    });
    // 间隙来自 token：0 意味着两栏底色直接相邻；小于 4px 在 Windows 缩放下看不出来。
    expect(shell.gap).toBeGreaterThanOrEqual(8);
    expect(shell.columnGap).not.toBe("normal");
    // 不同底色才有区分可言；同底色时这条断言要重写，不能拿它证明间隙存在。
    expect(shell.navrailBg).not.toBe(shell.railBg);
    // 激活条与右缘之间至少留出间隙本身，不贴边。
    if (shell.activeToEdge !== null) expect(shell.activeToEdge).toBeGreaterThan(0);
  });

  test("侧栏列宽：用户拖拽宽度不进 48rem–64rem，只在 ≥64rem 生效", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await installTaskDetail(page);
    await page.goto(`/tasks/${taskId}`);
    await connect(page);
    await page.getByTestId("task-detail-page-head").waitFor({ timeout: 20_000 });

    const rootRem = await page.evaluate(() =>
      Number.parseFloat(getComputedStyle(document.documentElement).fontSize));
    await page.evaluate(() => document.querySelector<HTMLElement>(".app-frame")!
      .style.setProperty("--relay-sidebar-user-width", "20rem"));

    const readColumn = async () => page.evaluate(() => ({
      resolved: getComputedStyle(document.querySelector(".app-frame")!)
        .getPropertyValue("--relay-shell-sidebar-width").trim(),
      rail: document.querySelector(".app-context-rail")!.getBoundingClientRect().width
    }));

    const narrow = await readColumn();
    expect(narrow.resolved).not.toBe("20rem");
    // 实际列宽必须落在 clamp 的上限之内，否则 768px 窗口下内容列会被拖拽宽度压穿。
    expect(narrow.rail).toBeLessThanOrEqual(17 * rootRem + 1);

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(200);
    const wide = await readColumn();
    expect(wide.resolved).toBe("20rem");
    expect(Math.round(wide.rail)).toBe(Math.round(20 * rootRem));
  });
});
