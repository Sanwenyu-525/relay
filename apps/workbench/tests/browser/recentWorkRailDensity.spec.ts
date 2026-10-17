import { expect, test, type Page, type Route } from "@playwright/test";

// 近期工作栏（协作页左栏）在窄列下的几何回归。
// 起因：列宽 token 的下限是 11rem=176px，内容盒只有 160px，而搜索框一度按全局 .search-field
// 的 min-width:12rem=192px 渲染，被 .recent-work{overflow:hidden} 硬切；行与行也只隔 2px。
// 这里断言四件事：搜索框永远落在栏的内容盒里、placeholder 在最低栏宽下整条放得下、
// 行高与行间距达到可读基线，以及栏头「新对话」的悬停淡底只占中部一条而命中区仍是整块。
// API 全部由 page.route 伪造，不连数据库、不调 Provider。

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = `http://127.0.0.1:${process.env.RELAY_RAIL_TEST_PORT ?? "4173"}`;

const projectA = "22222222-2222-4222-8222-222222222222";
const projectB = "22222222-2222-4222-8222-222222222223";

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: "application/json", headers: cors(), body: JSON.stringify(body) });
}

function task(id: string, projectId: string, title: string, updatedAt: string): unknown {
  return { id, project_id: projectId, title, status: "READY", mode: "ME", revision: "1",
    executor: { kind: "HUMAN", run_id: null }, current_completion_id: null, waiting_reason: null,
    blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
    dependencies: [], updated_at: updatedAt };
}

function session(id: string, projectId: string | null, title: string, updatedAt: string,
  unreadAt: string | null = null): unknown {
  return { id, workspace_id: workspaceId, project_id: projectId, task_id: null, title,
    status: "ACTIVE", revision: "1", created_at: updatedAt, updated_at: updatedAt,
    pinned_at: null, unread_at: unreadAt,
    working_resource_id: projectId,
    context: { project_goals: projectId === null ? [] : [{ goal_id: "88888888-8888-4888-8888-888888888888", title: "完成毕业论文" }],
      working_directory: projectId === null ? null : { resource_id: projectId, canonical_root: projectId === projectA ? "D:/thesis/docs" : "D:/experiment/code" } } };
}

function projectRow(id: string, title: string): unknown {
  return { id, title, project_type: "GENERAL", revision: "1", state_revision: "1",
    archive_status: "ACTIVE", archived_at: null, phase_key: "GENERAL", next_action_task_id: null,
    created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-11T06:59:00Z" };
}

const titles = [
  "截图种子：核对协作页左栏在窄窗下的截断",
  "验收任务：整理本轮响应式收敛的几何证据",
  "把工作台的外壳折叠点从 64rem 下移到 48rem"
];

async function installRoutes(page: Page): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/tasks`) {
      return fulfillJson(route, { items: [
        task("33333333-3333-4333-8333-333333333331", projectA, titles[0], "2026-10-11T06:59:00Z"),
        task("33333333-3333-4333-8333-333333333332", projectA, titles[1], "2026-10-11T04:59:00Z"),
        task("33333333-3333-4333-8333-333333333333", projectB, titles[2], "2026-10-07T04:07:00Z")
      ], next_cursor: null });
    }
    if (path === `${prefix}/projects`) {
      return fulfillJson(route, { items: [
        projectRow(projectA, "WindowShell 响应式收敛"),
        projectRow(projectB, "Relay-Agent 工作台")
      ], next_cursor: null });
    }
    if (path === `${prefix}/projects/${projectA}`) return fulfillJson(route, projectRow(projectA, "WindowShell 响应式收敛"));
    if (path === `${prefix}/projects/${projectB}`) return fulfillJson(route, projectRow(projectB, "Relay-Agent 工作台"));
    if (path === `${prefix}/assist-sessions`) {
      // 归档列表按 status 查询参数走另一批数据：左栏展开「已归档」时才读它（0090）。
      const status = new URL(request.url()).searchParams.get("status");
      if (status === "ARCHIVED") {
        return fulfillJson(route, { items: [
          session("77777777-7777-4777-8777-777777777771", null, "归档会话甲", "2026-10-10T00:18:00Z"),
          session("77777777-7777-4777-8777-777777777772", null, "归档会话乙", "2026-10-09T00:18:00Z")
        ] });
      }
      return fulfillJson(route, { items: [
        session("66666666-6666-4666-8666-666666666661", null, "你好", "2026-10-15T12:09:00Z"),
        session("66666666-6666-4666-8666-666666666662", projectB, "接续上次工作", "2026-10-15T00:18:00Z",
          "2026-10-17T02:30:00.000Z"),
        session("66666666-6666-4666-8666-666666666663", projectA, "整理论文资料", "2026-10-15T00:20:00Z")
      ] });
    }
    if (path === `${prefix}/assist-sessions/66666666-6666-4666-8666-666666666662`)
      return fulfillJson(route, session("66666666-6666-4666-8666-666666666662", projectB, "接续上次工作", "2026-10-15T00:18:00Z",
        "2026-10-17T02:30:00.000Z"));
    if (path === `${prefix}/assist-sessions/66666666-6666-4666-8666-666666666661`)
      return fulfillJson(route, session("66666666-6666-4666-8666-666666666661", null, "你好", "2026-10-15T12:09:00Z"));
    return fulfillJson(route, { items: [], next_cursor: null });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("rail-density-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

/** 栏宽由 clamp(11rem,16%,17rem) 决定：768–1100 视口都贴 176px 下限，正是最容易切字的一档。
    最后一档模拟用户把栏拖到 SidebarResizeHandle 允许的 160px 下限——比 token 下限还窄 16px，
    是这一列的真实最坏情况；该档只要求容下 7 字，因为 160px 里栏内留白已占掉 34%。 */
const viewports = [{ width: 768, height: 900, minTitleChars: 8 }, { width: 1000, height: 900, minTitleChars: 8 },
  { width: 1280, height: 900, minTitleChars: 8 }, { width: 1920, height: 900, userWidth: "160px", minTitleChars: 7 }];

function measure(page: Page) {
  return page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const rootPx = Number.parseFloat(root.fontSize);
    const rem = (name: string) => Number.parseFloat(root.getPropertyValue(name)) * rootPx;
    const rail = document.querySelector<HTMLElement>(".app-context-rail")!;
    const search = document.querySelector<HTMLElement>(".recent-work-search")!;
    const input = search.querySelector<HTMLInputElement>("input")!;
    const railBox = rail.getBoundingClientRect();
    const searchBox = search.getBoundingClientRect();
    const padLeft = Number.parseFloat(getComputedStyle(rail).paddingLeft);
    const padRight = Number.parseFloat(getComputedStyle(rail).paddingRight);
    const rows = [...document.querySelectorAll<HTMLElement>(".recent-work-item")];
    const pitches: number[] = [];
    for (let i = 1; i < rows.length; i += 1) {
      const previous = rows[i - 1].getBoundingClientRect();
      pitches.push(rows[i].getBoundingClientRect().top - previous.bottom);
    }
    const cv = document.createElement("canvas").getContext("2d")!;
    cv.font = getComputedStyle(input).font;
    return {
      railWidth: railBox.width,
      contentLeft: railBox.left + padLeft,
      contentRight: railBox.right - padRight,
      searchOverflow: Math.max(searchBox.right - (railBox.right - padRight), (railBox.left + padLeft) - searchBox.left),
      searchMinWidth: getComputedStyle(search).minWidth,
      searchHeight: searchBox.height,
      inputFont: Number.parseFloat(getComputedStyle(input).fontSize),
      placeholderWidth: cv.measureText(input.placeholder).width,
      // Chromium 不用 scrollWidth 暴露 placeholder 溢出，所以直接量文字区：placeholder 必须放得下。
      inputTextRoom: input.clientWidth,
      rowHeight: Math.min(...rows.map((row) => row.getBoundingClientRect().height)),
      rowPitch: pitches.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...pitches),
      titleFont: Number.parseFloat(getComputedStyle(rows[0].querySelector<HTMLElement>(".recent-work-title")!).fontSize),
      titleRoom: rows[0].querySelector<HTMLElement>(".recent-work-title")!.getBoundingClientRect().width,
      compactHeight: rem("--relay-control-height-compact"),
      metaSize: rem("--relay-font-size-meta"),
      space05: rem("--relay-space-0-5"),
      space1: rem("--relay-space-1"),
      space3: rem("--relay-space-3")
    };
  });
}

test.describe("近期工作栏窄列几何", () => {
  test("目标跨两个目录，目标与目录入口恢复同一会话并显示真实作用域", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await installRoutes(page);
    const posts: string[] = [];
    page.on("request", (request) => { if (request.method() === "POST") posts.push(request.url()); });
    await page.goto("/agent");
    await connect(page);
    const goals = page.getByTestId("recent-work-goals");
    await expect(goals.locator(".recent-work-group")).toHaveCount(1);
    await expect(goals.locator(".recent-work-item")).toHaveCount(2);
    await expect(page.getByTestId("recent-work-directories").locator(".recent-work-group")).toHaveCount(3);
    await goals.getByTestId("recent-work-goal-88888888-8888-4888-8888-888888888888-66666666-6666-4666-8666-666666666662").click();
    await expect(page.getByTestId("collab-current-goal")).toContainText("完成毕业论文");
    await expect(page.getByTestId("collab-current-directory")).toHaveAttribute("title", "会话目录：D:/experiment/code");
    await expect(page).toHaveURL(/session=66666666-6666-4666-8666-666666666662&goal=/);
    const restored = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === `${prefix}/assist-sessions` && url.searchParams.get("project_id") === projectB;
    });
    await page.getByTestId("recent-work-66666666-6666-4666-8666-666666666662").click();
    await restored;
    await expect(page.getByTestId("collab-conversation-toolbar")).toBeVisible();
    await expect(page).toHaveURL(/session=66666666-6666-4666-8666-666666666662$/);
    await expect(page.getByTestId("collab-current-goal")).toContainText("完成毕业论文");
    await expect(page.getByTestId("collab-current-directory")).toHaveAttribute("title", "会话目录：D:/experiment/code");
    await expect(page.getByTestId("collab-current-directory")).toHaveText("");
    expect(posts).toHaveLength(0);
    await page.screenshot({ path: "results/rail-goals-and-directories.png" });
    // 同一浏览器中核对用户反馈的「目标为空＋未绑定目录」层级，截图只取实际侧栏。
    const freeSessions = ["66666666-6666-4666-8666-666666666661", "66666666-6666-4666-8666-666666666662",
      "66666666-6666-4666-8666-666666666663"].map((id) => session(id, null, "你好", "2026-10-15T00:18:00Z"));
    await page.route(`${apiBase}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() === "GET" && path === `${prefix}/assist-sessions`)
        return fulfillJson(route, { items: freeSessions });
      if (route.request().method() === "GET" && path === `${prefix}/assist-sessions/66666666-6666-4666-8666-666666666662`)
        return fulfillJson(route, freeSessions[1]);
      return route.fallback();
    });
    await page.reload();
    await connect(page);
    await expect(page.getByTestId("recent-work-goals")).toContainText("暂无关联目标");
    await expect(page.getByTestId("recent-work-directories").locator(".recent-work-item")).toHaveCount(3);
    console.log("rail hierarchy", await page.evaluate(() => {
      const section = document.querySelector('[data-testid="recent-work-directories"] > summary')!;
      const group = document.querySelector('[data-testid="recent-work-directories"] .recent-work-group > summary')!;
      const note = document.querySelector(".recent-work-scope-note")!;
      const item = document.querySelector(".recent-work-title")!;
      const style = (element: Element) => { const css = getComputedStyle(element);
        return `${css.fontSize}/${css.fontWeight}`; };
      return { section: style(section), group: style(group), item: style(item), note: style(note) };
    }));
    await page.locator(".app-context-rail").screenshot({ path: "results/rail-hierarchy-empty.png" });
  });
  test("各档栏宽下搜索框不越界、placeholder 放得下、行距达到基线", async ({ page }) => {
    await installRoutes(page);
    await page.goto("/agent");
    await connect(page);
    await expect(page.getByTestId("recent-work-search")).toBeVisible();
    await expect(page.getByTestId("recent-work-list")).toBeVisible();

    const looks: { label: string; look: Awaited<ReturnType<typeof measure>> }[] = [];
    const titleChars: number[] = [];
    for (const viewport of viewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      // 拖拽宽度写在 .app-frame 的 --relay-sidebar-user-width 上，与手柄同源。
      await page.evaluate((width) => {
        const frame = document.querySelector<HTMLElement>(".app-frame")!;
        if (width === null) frame.style.removeProperty("--relay-sidebar-user-width");
        else frame.style.setProperty("--relay-sidebar-user-width", width);
      }, "userWidth" in viewport ? viewport.userWidth! : null);
      looks.push({ label: `${viewport.width}px / 栏 ${"userWidth" in viewport ? viewport.userWidth : "默认"}`,
        look: await measure(page) });
      titleChars.push(viewport.minTitleChars);
    }

    for (const [index, { label, look }] of looks.entries()) {
      const detail = `${label} ${JSON.stringify(look)}`;
      // 搜索框完整落在栏的内容盒里：越界 0px 才算没被 overflow:hidden 切。
      expect(look.searchOverflow, detail).toBeLessThanOrEqual(0.5);
      // placeholder 必须整条放得下，还要留出余量：字体回退时度量会变。
      expect(look.placeholderWidth, detail).toBeLessThanOrEqual(look.inputTextRoom - 8);
      // 行高不低于 control.height.compact，行与行至少隔开一档 space.0.5（2026-10-16 第七轮
      // 统一行距后分组内与已归档区都是这一档；此前下限写的是 space.1，对应分组覆盖遗留的 4px）。
      expect(look.rowHeight, detail).toBeGreaterThanOrEqual(look.compactHeight - 0.5);
      expect(look.rowPitch, detail).toBeGreaterThanOrEqual(look.space05 - 0.5);
      // 窄栏里的行标题用 meta 档，不用正文档去挤 160px 的内容盒。
      expect(look.titleFont, detail).toBeCloseTo(look.metaSize, 1);
      // 标题至少还能容下这一档承诺的汉字数，否则整列都是省略号。
      expect(look.titleRoom / look.titleFont, detail)
        .toBeGreaterThanOrEqual(titleChars[index]! - 0.5);
    }
  });

  // 2026-10-16 用户截图反馈：三个根区标题常驻淡底，连排把左栏读成灰白条纹；条目贴着分组竖线画激活标记，
  // 竖线与色带叠成一条；同日第三轮再撤掉根区之间的分隔线。这里盯住三件事——根区淡底只在悬停出现
  // （静止必须透明）、条目左缘（激活标记就画在它的 inset-inline-start:0）与竖线之间留出 space.0.5 的缝，
  // 以及根区之间没有上边框而只有留白（线撤掉后仍要能读成三段）。
  test("根区标题静止无底、悬停才淡底，激活标记与分组竖线留出缝", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await installRoutes(page);
    await page.goto("/agent");
    await connect(page);
    await page.getByTestId("recent-work-66666666-6666-4666-8666-666666666662").click();
    await expect(page.locator(".recent-work-item--active").first()).toBeVisible();
    // 这一列的空态提示在数据到位前拿不到真实盒子（rect 读成 0×0 会得出「中心差半栏宽」的假失败，
    // 本文件实测遇到过一次）：先等它占位，再开始量。
    await expect.poll(() => page.locator(".recent-work-scope-note").first()
      .evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(0);

    const read = () => page.evaluate(() => {
      const probe = document.createElement("span");
      document.body.append(probe);
      const token = (name: string) => { probe.style.color = `var(--relay-${name})`; return getComputedStyle(probe).color; };
      const subtle = token("color-bg-subtle");
      probe.remove();
      const root = getComputedStyle(document.documentElement);
      const gap = Number.parseFloat(root.getPropertyValue("--relay-space-0-5")) * Number.parseFloat(root.fontSize);
      const rootPx = Number.parseFloat(root.fontSize);
      const space2 = Number.parseFloat(root.getPropertyValue("--relay-space-2")) * rootPx;
      const section = document.querySelector<HTMLElement>('[data-testid="recent-work-directories"] > summary')!;
      // 第三轮的断言只量根区自身的样式与相邻两段的间距：map 出来的数组对「还没渲染」是安全的，
      // 不再为新增检查引入第二个会抛空引用的取值点。
      const sections = [...document.querySelectorAll<HTMLElement>(".recent-work-section")];
      const sectionBoxes = sections.map((element) => element.getBoundingClientRect());
      const list = document.querySelector<HTMLElement>(".recent-work-group .recent-work-list")!;
      const active = document.querySelector<HTMLElement>(".recent-work-item--active")!;
      const note = document.querySelector<HTMLElement>(".recent-work-scope-note")!;
      const noteBox = note.getBoundingClientRect();
      const parentBox = note.parentElement!.getBoundingClientRect();
      return {
        sectionBackground: getComputedStyle(section).backgroundColor,
        subtle,
        gap,
        space2,
        // 根区之间不再画分隔线：上边框必须为 0，分隔只能由相邻两段之间的留白承担。
        sectionBorderTops: sections.map((element) => Number.parseFloat(getComputedStyle(element).borderTopWidth)),
        sectionGaps: sectionBoxes.slice(1).map((box, index) => box.top - sectionBoxes[index]!.bottom),
        // 相邻根区的真实视觉间距：上一区最后一个可见条目的底 → 下一区 summary 的顶。
        // 用户截图里「任务入口 ↔ 已归档」合适、「目标/工作区/任务入口」偏大，故四区必须落在同一档。
        sectionContentGaps: sections.slice(1).map((section, index) => {
          const rows = sections[index]!.querySelectorAll<HTMLElement>(".recent-work-item, .recent-work-group > summary");
          const last = rows[rows.length - 1];
          if (last === undefined) return Number.NaN;
          return section.querySelector("summary")!.getBoundingClientRect().top - last.getBoundingClientRect().bottom;
        }),
        // 竖线画在 ul 的 border-left 上，它的右缘就是条目允许贴到的最左位置。
        lineToItem: active.getBoundingClientRect().left - (list.getBoundingClientRect().left
          + Number.parseFloat(getComputedStyle(list).borderLeftWidth)),
        barWidth: Number.parseFloat(getComputedStyle(active, "::before").width),
        // 激活标记相对条目左缘的偏移：2026-10-16 第五轮按用户指认右移 3px（原为 0）。
        barOffset: Number.parseFloat(getComputedStyle(active, "::before").left),
        noteAlign: getComputedStyle(note).textAlign,
        noteOffCenter: Math.abs((noteBox.left + noteBox.right) / 2 - (parentBox.left + parentBox.right) / 2)
      };
    });

    const rest = await read();
    await page.locator('[data-testid="recent-work-directories"] > summary').hover();
    // 过渡首帧会读成上一态，等过 motion.duration.fast 再取。
    await page.waitForTimeout(260);
    const hovered = await read();
    const detail = `${JSON.stringify({ rest, hovered })}`;
    expect(rest.sectionBackground, detail).toBe("rgba(0, 0, 0, 0)");
    expect(hovered.sectionBackground, detail).toBe(hovered.subtle);
    // 条目整体右移一档 space.0.5（2px），激活标记随条目一起走，不再压在竖线上。
    expect(rest.lineToItem - rest.gap, detail).toBeLessThan(0.5);
    expect(rest.barWidth, detail).toBeGreaterThan(0);
    // 2026-10-16 第五轮：激活标记再右移 3px（用户指认），与条目左缘拉开一小段。
    expect(rest.barOffset, detail).toBeCloseTo(3, 1);
    // 空态短提示水平居中：这一段没有可点对象，左对齐会读成还有一列没显示出来。
    expect(rest.noteAlign, detail).toBe("center");
    expect(rest.noteOffCenter, detail).toBeLessThan(0.5);
    // 2026-10-16 第三轮：根区之间撤掉分隔线后，不能既无线也无间距——上边框为 0，相邻段之间至少留一档 space.2。
    expect(rest.sectionBorderTops.length, detail).toBeGreaterThanOrEqual(3);
    expect(Math.max(...rest.sectionBorderTops), detail).toBeLessThan(0.5);
    expect(Math.min(...rest.sectionGaps), detail).toBeGreaterThanOrEqual(rest.space2 - 0.5);
    // 2026-10-16 第五轮起四个根区的视觉间距对齐同一档；第七轮修掉任务入口收起时塌成 0px 的
    // 相邻断裂；第八轮按用户「间距还是太大」由 space.3(12px) 收到 space.2(8px)（条目行距已触
    // 紧凑 token 下限，块间距是唯一还能收的一档）。四处间隙必须仍是同一档。
    expect(rest.sectionContentGaps.length, detail).toBe(3);
    expect(rest.sectionContentGaps.every((gap) => Math.abs(gap - rest.sectionContentGaps[0]!) < 0.5), detail).toBe(true);
    expect(rest.sectionContentGaps[0], detail).toBeCloseTo(rest.space2, 1);
  });

  // 2026-10-16 第七轮：用户截图指认「四个根区间距没有统一，统一成任务入口和已归档的间距」。
  // 根因是已归档段曾放在 recent-work-list 包装层之外，`.recent-work-section + .recent-work-section`
  // 覆盖不到「任务入口 ↔ 已归档」：任务入口展开时靠末组 margin 塌穿包装层凑到 12px，一旦收起
  // 就塌成 0px（已归档贴着任务入口）。归档段移进包装层后，这里盯住任意折叠组合下四个根区都是
  // 同一档 space.3；同时盯住行距只有一档——分组内与已归档区共用 space.0.5（第五轮把行距收到
  // 34px 后，分组覆盖曾留在 space.1，同一列两档行距，用户指认「而且要统一」）。
  test("任意折叠组合下四个根区间距同一档，分组与已归档行距同一档", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await installRoutes(page);
    await page.goto("/agent");
    await connect(page);
    await expect(page.getByTestId("recent-work-list")).toBeVisible();
    // 展开已归档段，让它的行距也进入测量（这一段默认收起，且不预读）。
    await page.locator('[data-testid="recent-work-archived"] > summary').click();
    await expect(page.locator('[data-testid="recent-work-archived"] .recent-work-item').first()).toBeVisible();

    const read = () => page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const rootPx = Number.parseFloat(root.fontSize);
      const rem = (name: string) => Number.parseFloat(root.getPropertyValue(name)) * rootPx;
      const sections = [...document.querySelectorAll<HTMLElement>(".recent-work-section")];
      const boxes = sections.map((element) => element.getBoundingClientRect());
      const gaps = boxes.slice(1).map((box, index) => box.top - boxes[index]!.bottom);
      const listGaps = [...document.querySelectorAll<HTMLElement>(".recent-work-list")].map((list) => {
        const rows = [...list.querySelectorAll<HTMLElement>(".recent-work-item")];
        const rowGaps: number[] = [];
        for (let i = 1; i < rows.length; i += 1) {
          rowGaps.push(rows[i]!.getBoundingClientRect().top - rows[i - 1]!.getBoundingClientRect().bottom);
        }
        return { inGroup: list.closest(".recent-work-group") !== null, rows: rows.length, rowGaps };
      });
      return { gaps, space2: rem("--relay-space-2"), space05: rem("--relay-space-0-5"), listGaps };
    });

    const expanded = await read();
    const detail = JSON.stringify(expanded);
    // 全部展开：三处根区间距都是 space.2，且已归档区的行确实在测量范围内。
    expect(expanded.gaps, detail).toEqual([expanded.space2, expanded.space2, expanded.space2]);
    expect(expanded.listGaps.some((list) => !list.inGroup && list.rows >= 2), detail).toBe(true);
    // 行距只有一档：凡是有多行的列表（分组内与已归档区）行距都是 space.0.5。
    for (const list of expanded.listGaps) {
      if (list.rows < 2) continue;
      expect(list.rowGaps.every((gap) => Math.abs(gap - expanded.space05) < 0.5),
        `${detail} ${JSON.stringify(list)}`).toBe(true);
    }

    // 收起任务入口：此前这里塌成 0px（已归档贴着任务入口）。
    await page.locator('[data-testid="recent-work-tasks"] > summary').click();
    await page.waitForTimeout(150);
    const tasksCollapsed = await read();
    expect(tasksCollapsed.gaps, JSON.stringify(tasksCollapsed))
      .toEqual([tasksCollapsed.space2, tasksCollapsed.space2, tasksCollapsed.space2]);

    // 其余三段也收起：四处间距仍不变（任务入口保持收起，不再点它）。
    for (const id of ["recent-work-goals", "recent-work-directories", "recent-work-archived"]) {
      await page.locator(`[data-testid="${id}"] > summary`).click();
    }
    await page.waitForTimeout(150);
    const allCollapsed = await read();
    expect(allCollapsed.gaps, JSON.stringify(allCollapsed))
      .toEqual([allCollapsed.space2, allCollapsed.space2, allCollapsed.space2]);
  });

  // 栏头「新对话」：2026-10-16 第三轮把悬停淡底收成中部一条，第四轮收到 control.height，第五轮误把「上下间距」
  // 读成横向宽度收成小块、当日撤回，第六轮按用户真正指的把整块高收到 control.height.compact 并把上下 margin
  // 各收到 space.1。这条同时盯住同特异度层叠：共享基座 `.primary-button:hover:not(:disabled)`（0,3,0）会压掉
  // 元素上 `background: transparent`（0,2,0），一旦淡底改画到 `::before` 而忘了再压一次，
  // hover 就整块填回实心绿、绿字落在绿底上不可读。见设计系统 §9.10。
  test("栏头新对话整块高停在 compact 一档，淡底只占中部、横向仍是满行", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await installRoutes(page);
    await page.goto("/agent");
    await connect(page);
    const button = page.getByTestId("context-new-conversation");
    await expect(button).toBeVisible();

    const read = () => page.evaluate(() => {
      const probe = document.createElement("span");
      document.body.append(probe);
      probe.style.color = "var(--relay-color-selection-hover)";
      const hoverToken = getComputedStyle(probe).color;
      probe.remove();
      const root = getComputedStyle(document.documentElement);
      const rootPx = Number.parseFloat(root.fontSize);
      const rem = (name: string) => Number.parseFloat(root.getPropertyValue(name)) * rootPx;
      const el = document.querySelector<HTMLElement>(".context-rail-new")!;
      const rail = document.querySelector<HTMLElement>(".app-context-rail")!;
      const band = getComputedStyle(el, "::before");
      const box = el.getBoundingClientRect();
      const railPad = Number.parseFloat(getComputedStyle(rail).paddingLeft)
        + Number.parseFloat(getComputedStyle(rail).paddingRight);
      return {
        ownHeight: box.height,
        ownWidth: box.width,
        railContentWidth: rail.getBoundingClientRect().width - railPad,
        ownBackground: getComputedStyle(el).backgroundColor,
        bandBackground: band.backgroundColor,
        bandHeight: Number.parseFloat(band.height),
        bandRadius: band.borderRadius,
        hoverToken,
        compactHeight: rem("--relay-control-height-compact"),
        metaSize: rem("--relay-font-size-meta"),
        space1: rem("--relay-space-1"),
        radiusControl: rem("--relay-radius-control")
      };
    });

    const rest = await read();
    await button.hover();
    // 过渡首帧会读成上一态，等过 motion.duration.fast 再取。
    await page.waitForTimeout(260);
    const hovered = await read();

    const detail = `${JSON.stringify({ rest, hovered })}`;
    // 整块高停在 control.height.compact 这一档：上下留白不许再涨回 40/48px，也不许跌破该 token 的紧凑下限。
    expect(rest.ownHeight, detail).toBeGreaterThanOrEqual(rest.compactHeight - 0.5);
    expect(rest.ownHeight, detail).toBeLessThanOrEqual(rest.compactHeight + 0.5);
    // 横向仍是满行：第五轮的 fit-content 已撤回，命中区要覆盖整条栏宽（容 2px 边框与取整）。
    expect(rest.ownWidth, detail).toBeGreaterThanOrEqual(rest.railContentWidth - 2);
    // 色带上下各内缩至少一档 space.1（不顶满命中区），且至少与标签同高，圆角取 radius.control。
    expect((rest.ownHeight - rest.bandHeight) / 2, detail).toBeGreaterThanOrEqual(rest.space1 - 0.5);
    expect(rest.bandHeight, detail).toBeGreaterThanOrEqual(rest.metaSize);
    expect(Number.parseFloat(rest.bandRadius), detail).toBeCloseTo(rest.radiusControl, 1);
    // 静止态两层都无底；hover 只填色带，元素自身必须仍是透明的。
    expect(rest.bandBackground, detail).toBe("rgba(0, 0, 0, 0)");
    expect(rest.ownBackground, detail).toBe("rgba(0, 0, 0, 0)");
    expect(hovered.bandBackground, detail).toBe(hovered.hoverToken);
    expect(hovered.ownBackground, detail).toBe("rgba(0, 0, 0, 0)");
  });

  // 行内 ⋯（工作台 §28.9、设计系统 §9.14）：2026-10-16 第五轮按用户指认，面板从
  // 「行下方就地展开」改成浮层下拉。就地展开会把这一行以下整列推下去，而 ⋯ 的
  // `inset-block-start: 50%` 相对的是被撑高的 `<li>`，于是跳到「行 + 面板」的中线——
  // 这正是用户说的「点击三个点位置会改变」。这里盯住四件事：静止态触发器完全不占几何
  // （绝对定位 + display:none，行盒逐像素不变）；展开后触发器逐像素不动；
  // 滚动容器高度不变（面板不推挤列表）；面板是 fixed 浮层、开在触发器下方并与其右缘对齐。
  test("会话行内触发器静止不占几何，展开面板是浮层且不推挤列表", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await installRoutes(page);
    const posts: string[] = [];
    page.on("request", (request) => { if (request.method() === "POST") posts.push(request.url()); });
    await page.goto("/agent");
    await connect(page);

    const sessionId = "66666666-6666-4666-8666-666666666662";
    // 行未渲染就读会取到 null（本文件实测遇到过一次）：先等这一行出现再量。
    await expect(page.getByTestId(`recent-work-${sessionId}`).first()).toBeVisible();
    const read = () => page.evaluate((target) => {
      const item = document.querySelector<HTMLElement>(`[data-testid="recent-work-${target}"]`)!;
      const row = item.closest("li")!;
      const trigger = row.querySelector<HTMLElement>(".recent-work-row-trigger")!;
      const panel = document.querySelector<HTMLElement>(`[data-testid="recent-work-panel-${target}"]`);
      const scroller = document.querySelector<HTMLElement>(".recent-work-scroll")!;
      const box = item.getBoundingClientRect();
      const triggerBox = trigger.getBoundingClientRect();
      const panelBox = panel?.getBoundingClientRect() ?? null;
      return {
        triggerDisplay: getComputedStyle(trigger).display,
        // 2026-10-16：用户指认 ⋯ 不要自带底色/悬停阴影——三层状态（静止、悬停、展开）都必须是全透明。
        triggerBackground: getComputedStyle(trigger).backgroundColor,
        expanded: trigger.getAttribute("aria-expanded"),
        controls: trigger.getAttribute("aria-controls"),
        rowTop: box.top, rowBottom: box.bottom, rowWidth: box.width,
        triggerTop: triggerBox.top, triggerLeft: triggerBox.left,
        scrollHeight: scroller.scrollHeight,
        // 浮层：fixed 定位、顶边不低于触发器底边、右缘与触发器右缘对齐。
        panelPosition: panel === null ? null : getComputedStyle(panel).position,
        panelBelowTrigger: panelBox === null ? null : panelBox.top >= triggerBox.bottom - 1,
        panelRightAligned: panelBox === null ? null : Math.abs(panelBox.right - triggerBox.right) < 2,
        // 2026-10-16：菜单宽度跟条目一致——面板宽 = 最宽条目「自然宽度」+ 两侧各一档内间距，
        // 右侧不留空底；此前 min-width 10rem 会让面板明显宽于条目。
        // 自然宽度用 Range 量按钮内容盒（图标 + 名称）再加按钮自身横向内边距：
        // 条目是 width:100%，只量条目盒量不出面板有没有多留空底，必须量内容。
        panelWidth: panelBox === null ? null : panelBox.width,
        panelInlineInsets: panel === null ? null
          : 2 * (Number.parseFloat(getComputedStyle(panel).paddingLeft)
            + Number.parseFloat(getComputedStyle(panel).borderLeftWidth)),
        panelItemNaturalWidth: panel == null ? null
          : Math.max(...[...panel.querySelectorAll("button")].map((button) => {
            const range = document.createRange();
            range.selectNodeContents(button);
            const style = getComputedStyle(button);
            // 按钮自身的内边距与细边都要算进「条目自然宽」：共享基座 .text-button 带 1px 透明边，
            // 漏掉它面板就会看起来多出 2px 空底。
            return range.getBoundingClientRect().width
              + Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight)
              + Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.borderRightWidth);
          })),
        panelActions: panel == null ? null
          : [...panel.querySelectorAll("button")].map((button) => (button.textContent ?? "").trim()),
        // 2026-10-16 第八轮：动作按参考菜单排成「图标 + 名称」两组，中间一根分组细线。
        panelSeparators: panel === null ? null : panel.querySelectorAll('[role="separator"]').length,
        panelActionIcons: panel == null ? null
          : [...panel.querySelectorAll("button")].map((button) => button.querySelector("svg") !== null),
        panelActionColors: panel == null ? null
          : [...panel.querySelectorAll("button")].map((button) => getComputedStyle(button).color),
        // 2026-10-17 用户指认「菜单里的选项文字要左对齐、要黑色、归档用红色」：
        // 三条动作的计算色与前缀对齐方式一起量，token 期望值用探针节点在同一拍解析。
        panelActionJustify: panel == null ? null
          : [...panel.querySelectorAll("button")].map((button) => getComputedStyle(button).justifyContent),
        // 0104 未读圆点：只在这一条未读会话上出现，尺寸取 space.1、颜色取 action.primary。
        // 圆点不进可访问名称，状态词由行按钮的 aria-label 承载。
        unreadDot: (() => {
          const dot = row.querySelector<HTMLElement>('[data-testid="recent-work-unread-dot"]');
          if (dot === null) return null;
          const style = getComputedStyle(dot);
          return { width: style.width, height: style.height,
            background: style.backgroundColor, radius: style.borderRadius };
        })(),
        space1: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--relay-space-1"))
          * Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
        tokenTextPrimary: (() => {
          const probe = document.createElement("span");
          probe.style.color = "var(--relay-color-text-primary)";
          document.body.append(probe);
          const primary = getComputedStyle(probe).color;
          probe.style.color = "var(--relay-color-status-danger-text)";
          const danger = getComputedStyle(probe).color;
          probe.style.color = "var(--relay-color-action-text)";
          const action = getComputedStyle(probe).color;
          probe.style.color = "var(--relay-color-action-primary)";
          const actionPrimary = getComputedStyle(probe).color;
          probe.remove();
          return { primary, danger, action, actionPrimary };
        })()
      };
    }, sessionId);

    const rest = await read();
    const look = await measure(page);
    const detail = JSON.stringify({ rest, look });
    expect(rest.triggerDisplay, detail).toBe("none");
    // ⋯ 自身透明：静止态不带底色（用户指认「三个点不要有悬停阴影」）。
    expect(rest.triggerBackground, detail).toBe("rgba(0, 0, 0, 0)");
    expect(rest.expanded, detail).toBe("false");
    // 按钮里不能套按钮：触发器必须是行按钮的兄弟节点，否则点击会落进行本体。
    expect(await page.evaluate(() => document.querySelector(".recent-work-item .recent-work-row-trigger")), detail).toBeNull();
    expect(rest.controls, detail).toBe(`recent-work-row-panel-${sessionId}`);
    // 0104：未读圆点只长在未读会话上——尺寸取 space.1、颜色取 action.primary；
    // 旁边那条已读会话（661）不得凭空长点。状态词本身在行按钮的 aria-label 里。
    expect(rest.unreadDot, detail).not.toBeNull();
    expect(Number.parseFloat(rest.unreadDot!.width), detail).toBeCloseTo(rest.space1, 1);
    expect(rest.unreadDot!.width, detail).toBe(rest.unreadDot!.height);
    expect(rest.unreadDot!.background, detail).toBe(rest.tokenTextPrimary.actionPrimary);
    expect(await page.locator('[data-testid="recent-work-66666666-6666-4666-8666-666666666661"] [data-testid="recent-work-unread-dot"]').count(), detail).toBe(0);
    // 静止态这一列的几何仍达基线：藏起来的触发器不该改变行高或行距。
    expect(look.rowHeight, detail).toBeGreaterThanOrEqual(look.compactHeight - 0.5);
    expect(look.rowPitch, detail).toBeGreaterThanOrEqual(look.space05 - 0.5);

    await page.getByTestId(`recent-work-${sessionId}`).first().hover();
    // 过渡首帧会读成上一态，等过 motion.duration.fast 再取。
    await page.waitForTimeout(260);
    const hovered = await read();
    expect(hovered.triggerDisplay, JSON.stringify(hovered)).not.toBe("none");
    // 悬停显形也不补底色：⋯ 只是图标出现，不叠出第二层色块。
    expect(hovered.triggerBackground, JSON.stringify(hovered)).toBe("rgba(0, 0, 0, 0)");
    // 显形不得推动行盒：绝对定位的触发器不参与布局。
    expect(hovered.rowTop, JSON.stringify({ rest, hovered })).toBe(rest.rowTop);
    expect(hovered.rowBottom, JSON.stringify({ rest, hovered })).toBe(rest.rowBottom);

    // 同一会话会同时落在「目标」与「工作区（目录）」两段（目标区条目 testid 带 goal 前缀，
    // 行内操作按钮的 testid 不带、两份相同），.first() 命中的是从未悬停的目标区副本，
    // 它的触发器永远 display:none；点击必须按行落到刚悬停的那一份。
    await page.locator(`.recent-work-row:has([data-testid="recent-work-${sessionId}"])`)
      .getByTestId(`recent-work-menu-${sessionId}`).click();
    const opened = await read();
    expect(opened.expanded, JSON.stringify(opened)).toBe("true");
    // 2026-10-16 按用户参考菜单重排：置顶／重命名／未读在前，分组细线之后复制身份与归档收尾；
    // 五条动作各带一枚前缀图标（图标不进 textContent，这里只核对顺序与存在性）。
    // 这条种子会话本身是未读态，所以第三项显示反向动作「取消未读」。
    expect(opened.panelActions, JSON.stringify(opened))
      .toEqual(["置顶", "重命名", "取消未读", "复制会话 ID", "归档"]);
    expect(opened.panelSeparators, JSON.stringify(opened)).toBe(1);
    expect(opened.panelActionIcons, JSON.stringify(opened)).toEqual([true, true, true, true, true]);
    // 收尾的归档用状态红色（color.status.danger.text），上面四条常规动作用正文黑
    // （color.text.primary）——2026-10-17 用户指认「文字要黑色、危险操作像归档用红色」。
    // 常规动作绝不能退回共享基座 `.text-button` 的森林绿动作色，那是这轮改掉的读感。
    expect(opened.panelActionColors, JSON.stringify(opened)).toEqual(
      [opened.tokenTextPrimary.primary, opened.tokenTextPrimary.primary,
        opened.tokenTextPrimary.primary, opened.tokenTextPrimary.primary,
        opened.tokenTextPrimary.danger]);
    expect(opened.panelActionColors![0], JSON.stringify(opened))
      .not.toBe(opened.tokenTextPrimary.action);
    // 五条都左对齐（图标在左、名称跟着）：`.text-button` 基座的 justify-content:center
    // 是同特异度后置声明，曾把这里的 flex-start 静默压成居中（用户指认「文字要左对齐」）。
    expect(opened.panelActionJustify, JSON.stringify(opened))
      .toEqual(["flex-start", "flex-start", "flex-start", "flex-start", "flex-start"]);
    // 菜单宽度跟条目一致（用户指认）：面板宽 - 最宽条目自然宽 = 两侧内间距 + 细边，右侧不留空底。
    expect(opened.panelWidth! - opened.panelItemNaturalWidth!, JSON.stringify(opened))
      .toBeCloseTo(opened.panelInlineInsets!, 0);
    // 展开态 ⋯ 仍不带底色：底色只出现在行本体上。
    expect(opened.triggerBackground, JSON.stringify(opened)).toBe("rgba(0, 0, 0, 0)");
    // 浮层：fixed 定位、开在触发器下方、右缘与触发器对齐。
    expect(opened.panelPosition, JSON.stringify(opened)).toBe("fixed");
    expect(opened.panelBelowTrigger, JSON.stringify(opened)).toBe(true);
    expect(opened.panelRightAligned, JSON.stringify(opened)).toBe(true);
    // 用户指认的两处：展开后 ⋯ 一动不动，这一列也不被推挤（滚动高度不变）。
    expect(opened.triggerTop, JSON.stringify({ hovered, opened })).toBe(hovered.triggerTop);
    expect(opened.triggerLeft, JSON.stringify({ hovered, opened })).toBe(hovered.triggerLeft);
    expect(opened.rowTop, JSON.stringify({ rest, opened })).toBe(rest.rowTop);
    expect(opened.scrollHeight, JSON.stringify({ rest, opened })).toBe(rest.scrollHeight);
    // 浮层落在栏右缘之外，只截左栏会把它裁掉：整视口截，面板才看得见（在收起之前截）。
    await page.screenshot({ path: "results/rail-row-menu.png" });

    // 改名态（用户指认「菜单宽度要跟里面的 item 一致」的另一半）：输入框不能反过来把浮层撑宽。
    // 面板按内容定宽后，输入框的自然宽（size=20 ≈ 177px）曾把面板顶到 15rem 上限、比动作态宽一倍多；
    // 现在改名表单与失败说明都锁在原 10rem 那一档，改名态面板宽不超过 10rem（160px）+ 1px 取整。
    await page.locator(`.recent-work-row:has([data-testid="recent-work-${sessionId}"])`)
      .getByTestId(`recent-work-panel-${sessionId}`).getByText("重命名").click();
    const renaming = await page.evaluate((target) => {
      const panel = document.querySelector<HTMLElement>(`[data-testid="recent-work-panel-${target}"]`)!;
      const input = panel.querySelector("input");
      return { panel: panel.getBoundingClientRect().width, input: input?.getBoundingClientRect().width ?? null };
    }, sessionId);
    expect(renaming.panel, JSON.stringify(renaming)).toBeLessThanOrEqual(161);
    // 输入框仍占满面板内容宽（两侧留出内间距），不是缩在面板里的一小块。
    expect(renaming.panel - (renaming.input ?? 0), JSON.stringify(renaming))
      .toBeCloseTo(opened.panelInlineInsets!, 0);

    await page.keyboard.press("Escape");
    const closed = await read();
    expect(closed.expanded, JSON.stringify(closed)).toBe("false");
    expect(closed.panelActions, JSON.stringify(closed)).toBeNull();
    // 收起后这一列回到静止几何：就地展开没有留下位移。
    const after = await measure(page);
    expect(after.rowPitch, JSON.stringify({ look, after })).toBe(look.rowPitch);
    expect(after.rowHeight, JSON.stringify({ look, after })).toBe(look.rowHeight);
    // 只是看看面板，不该发任何命令。
    expect(posts, JSON.stringify(posts)).toHaveLength(0);
  });

  // 悬停摘要卡（工作台 §28.9、设计系统 §9.14，2026-10-16 第五轮）：行内不再常驻时间，
  // 时间与归属改由悬停/聚焦时出现的摘要卡呈现。这里核对卡片确实落在行旁（不压行、不遮列表）、
  // 内容取服务端事实、行内已无时间，且它是纯展示层（不接收指针，指针移到卡片上不闪断悬停态）。
  test("悬停显示摘要卡：标题、更新时刻与归属，行内不再常驻时间", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await installRoutes(page);
    await page.goto("/agent");
    await connect(page);

    const sessionId = "66666666-6666-4666-8666-666666666662";
    const row = page.getByTestId(`recent-work-${sessionId}`).first();
    await expect(row).toBeVisible();
    // 行内不再有常驻时间：时间只在摘要卡里出现。
    await expect(row.locator(".recent-work-time")).toHaveCount(0);
    await expect(page.getByTestId("recent-work-summary")).toHaveCount(0);

    await row.hover();
    const card = page.getByTestId("recent-work-summary");
    await expect(card).toBeVisible();
    const facts = await card.evaluate((element, target) => {
      const box = element.getBoundingClientRect();
      const rowBox = document.querySelector<HTMLElement>(`[data-testid="recent-work-${target}"]`)!
        .getBoundingClientRect();
      return {
        position: getComputedStyle(element).position,
        pointerEvents: getComputedStyle(element).pointerEvents,
        title: element.querySelector('[data-testid="recent-work-summary-title"]')?.textContent ?? "",
        time: element.querySelector('[data-testid="recent-work-summary-time"]')?.textContent ?? "",
        timeValue: element.querySelector("time")?.getAttribute("datetime") ?? "",
        scope: element.querySelector('[data-testid="recent-work-summary-scope"]')?.textContent ?? "",
        // 卡片贴在这一行的右缘外，且与行同一横带——是「贴在行旁」，不是压在行上或落到别处。
        rightOfRow: box.left >= rowBox.right - 1,
        besideRow: box.top < rowBox.bottom && box.bottom > rowBox.top
      };
    }, sessionId);
    expect(facts.position).toBe("fixed");
    expect(facts.pointerEvents).toBe("none");
    expect(facts.title.length).toBeGreaterThan(0);
    expect(facts.time.length).toBeGreaterThan(0);
    expect(facts.timeValue).not.toBe("");
    expect(facts.scope.length).toBeGreaterThan(0);
    expect(facts.rightOfRow, JSON.stringify(facts)).toBe(true);
    expect(facts.besideRow, JSON.stringify(facts)).toBe(true);
    // 浮层落在栏右缘之外，只截左栏会把它裁掉：整视口截，卡片才看得见（在收起之前截）。
    await page.screenshot({ path: "results/rail-row-summary.png" });

    // 移开指针后收起，不留浮层。
    await page.mouse.move(700, 420);
    await expect(page.getByTestId("recent-work-summary")).toHaveCount(0);
  });
});
