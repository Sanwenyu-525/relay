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
  unreadAt: string | null = null, lastMessageAt: string | null = updatedAt): unknown {
  return { id, workspace_id: workspaceId, project_id: projectId, task_id: null, title,
    status: "ACTIVE", revision: "1", created_at: updatedAt, updated_at: updatedAt,
    // 这些行都是有内容的讨论：活动键与更新时间同值，行上因此不出现「未开始」，
    // 菜单里的「分叉」也照常出现（2026-10-24 起空会话不给分叉）。
    // 传 null 的那一条是「还没说过话」的空会话，专门用来验标记。
    last_message_at: lastMessageAt,
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
    // 目录行「＋」落地时要按种子路径打开目录（左栏只带路径，打开由协作页发命令）。
    if (path === `${prefix}/working-directories/open` && request.method() === "POST") {
      const body = JSON.parse(request.postData() ?? "{}") as { command_id: string; root_path: string };
      return fulfillJson(route, { command_id: body.command_id, committed_at: "2026-10-18T00:00:00Z",
        result: { canonical_root: body.root_path, display_name: body.root_path.split("/").at(-1),
          status: "READY", reason: null,
          association: { project_id: projectA, project_title: "WindowShell 响应式收敛", project_archived: false,
            resource_id: projectA, resource_status: "ACTIVE", file_write_identity_bound: true },
          created_project: false, created_resource: false, candidates: [],
          // detail 必须是字符串：解析器对缺类型直接判「响应格式无效」，整条目录等于没打开。
          write_readiness: { status: "NEEDS_CONNECTION", detail: "本项目还没有绑定该目录的文件写入连接。" } } });
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
    // 完整路径可核对（2026-10-22 起不再用原生 title，改悬停/聚焦浮层 + aria-label）：
    // 可见的只有目录名，完整路径由 lib/pathTooltip 的浮层承担，可访问名称同时保留。
    await expect(page.getByTestId("collab-current-directory"))
      .toHaveAttribute("aria-label", "会话目录：D:/experiment/code");
    await page.getByTestId("collab-current-directory").hover();
    await expect(page.getByTestId("path-tooltip")).toHaveText("D:/experiment/code");
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
    await expect(page.getByTestId("collab-current-directory"))
      .toHaveAttribute("aria-label", "会话目录：D:/experiment/code");
    await expect(page.getByTestId("collab-current-directory")).toHaveText("code");
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

  // 2026-10-18 用户指令「鼠标悬停 item 的时候要显示一个新建会话的按钮，点击自动以该目录新建一个空会话」。
  // 这里盯住悬停这一侧的可视契约：静止不占任何几何、悬停显形时数字徽标让位而行盒逐像素不动、
  // 指针从行移到「＋」上不闪断；点击后的落地（种子目录 → 空白输入）由 folderFirstConversation 的
  // `?dir=` 用例在组件层核对，这里只确认真的导航到了带 new+dir 的那条入口。
  test("目录行悬停显形「＋」：静止不占位，悬停时徽标让位、行盒不变", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await installRoutes(page);
    await page.goto("/agent");
    await connect(page);
    // 两个真实目录各一颗；「未绑定目录」那一组没有路径可打开，不长这颗键。
    await expect(page.locator(".recent-work-group-new")).toHaveCount(2);
    expect(await page.evaluate(() => document.querySelector("summary .recent-work-group-new"))).toBeNull();

    const group = page.locator(`.recent-work-group:has(> [data-testid="recent-work-new-in-${projectA}"])`);
    const button = page.getByTestId(`recent-work-new-in-${projectA}`);
    const read = () => group.evaluate((element) => {
      const root = getComputedStyle(document.documentElement);
      const rem = (name: string) => Number.parseFloat(root.getPropertyValue(name)) * Number.parseFloat(root.fontSize);
      const summary = element.querySelector(":scope > summary")!;
      const trigger = element.querySelector(":scope > .recent-work-group-new") as HTMLElement;
      const count = summary.querySelector(".recent-work-group-count") as HTMLElement;
      const title = summary.querySelector(".recent-work-group-title") as HTMLElement;
      const box = summary.getBoundingClientRect();
      const triggerBox = trigger.getBoundingClientRect();
      return {
        triggerDisplay: getComputedStyle(trigger).display,
        countVisibility: getComputedStyle(count).visibility,
        summaryTop: box.top, summaryHeight: box.height, summaryRight: box.right,
        triggerRight: triggerBox.right, triggerWidth: triggerBox.width,
        titleWidth: title.getBoundingClientRect().width,
        compactHeight: rem("--relay-control-height-compact")
      };
    });

    const rest = await read();
    expect(rest.triggerDisplay).toBe("none");
    expect(rest.countVisibility).toBe("visible");

    await group.locator(":scope > summary").hover();
    const hovered = await read();
    const detail = JSON.stringify({ rest, hovered });
    expect(hovered.triggerDisplay, detail).toBe("flex");
    // 徽标让位但仍占宽：标题可用宽度与行盒都不随悬停变化，只是右端换成了「＋」。
    expect(hovered.countVisibility, detail).toBe("hidden");
    expect(hovered.summaryTop, detail).toBe(rest.summaryTop);
    expect(hovered.summaryHeight, detail).toBe(rest.summaryHeight);
    expect(hovered.titleWidth, detail).toBe(rest.titleWidth);
    // 「＋」落在这一行右端内缘，命中区仍是紧凑控件那一档。
    expect(hovered.triggerRight, detail).toBeLessThanOrEqual(hovered.summaryRight + 0.5);
    expect(hovered.triggerWidth, detail).toBeCloseTo(hovered.compactHeight, 1);
    // 指针从行移到「＋」上：它自己就是悬停目标，不能闪断回徽标。
    await button.hover();
    const onTrigger = await read();
    expect(onTrigger.triggerDisplay, JSON.stringify(onTrigger)).toBe("flex");
    expect(onTrigger.countVisibility, JSON.stringify(onTrigger)).toBe("hidden");

    // 点击进入同一条「新对话」入口，并带上这一行的目录路径；左栏自身不建会话、不发写命令。
    await button.click();
    await expect(page).toHaveURL(/\/agent\?new=[^&]+&dir=D%3A%2Fthesis%2Fdocs$/);
    // 协作页按种子打开目录，落在空白输入上（会话仍在首条发送时建立）。
    await expect(page.getByTestId("folder-scope-strip")).toContainText("docs");
    await expect(page.getByTestId("assist-first-draft")).toBeVisible();
  });

  // 2026-10-18 用户实机指认「这个搜索框里面的光标也太小了吧？而且离搜索这个词太近了」。
  // 根因：Chromium 的 <input> 光标高度跟随行盒——本栏 input 是 14px 字号 + 1.5 行高（21px），
  // 实测光标只有 11px 高、1 设备像素宽（宽度由平台绘制，CSS 没有加粗属性），在 32px 胶囊里
  // 读着极小；图标右缘到文字起点又只有 space.2（8px）。修法两处：行高写到容器上（input 的
  // font:inherit 会压掉内层声明）取 control.height.compact − space.1（28px）→ 光标 18–19px，
  // 图标小一档到 font.size.body，160px 拖拽档下 placeholder 余量实测 96→100px 盒宽、余量 16px。
  // 同日第二轮用户指认「放大镜图标右侧那块放不了内容、宽度该调小」：上一轮顺手把 gap 提到
  // space.3（12px），但根因是 11px 小光标不是间距，光标修大后那 12px 读成死区——调回 space.2。
  // 这里同时锁计算值与像素实测：前者防样式回退，后者防「行高够了但光标没变大」的引擎侧变化。
  test("搜索框光标高度与图标间距：用户指认的两处不再回归", async ({ page }) => {
    await installRoutes(page);
    await page.goto("/agent");
    await connect(page);
    const input = page.getByTestId("recent-work-search");
    await expect(input).toBeVisible();

    const geometry = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const rootPx = Number.parseFloat(root.fontSize);
      const rem = (name: string) => Number.parseFloat(root.getPropertyValue(name)) * rootPx;
      const el = document.querySelector<HTMLInputElement>('[data-testid="recent-work-search"]')!;
      const label = el.closest("label")!;
      const svg = label.querySelector("svg")!;
      return {
        lineHeight: Number.parseFloat(getComputedStyle(el).lineHeight),
        fontSize: Number.parseFloat(getComputedStyle(el).fontSize),
        lineHeightToken: rem("--relay-control-height-compact") - rem("--relay-space-1"),
        iconToInput: el.getBoundingClientRect().left - svg.getBoundingClientRect().right,
        gapToken: rem("--relay-space-2"),
        inputHeight: el.getBoundingClientRect().height,
        labelContentHeight: label.clientHeight,
        dpr: window.devicePixelRatio
      };
    });
    // 行高是光标唯一的 CSS 杠杆（宽度由平台画，没有属性能调）。
    expect(geometry.lineHeight).toBeCloseTo(geometry.lineHeightToken, 1);
    // 图标右缘 → 文字（光标）起点：space.2，2026-10-18 第二轮按用户指认从 space.3 调回。
    expect(geometry.iconToInput).toBeCloseTo(geometry.gapToken, 1);
    // 行盒长高后仍装进标签内容盒：28px 行盒 ≤ 30px（32px 胶囊 − 2×1px 边）。
    expect(geometry.inputHeight).toBeLessThanOrEqual(geometry.labelContentHeight);

    // 像素实测：清空值与 placeholder，聚焦后光标会闪，重试到拍到为止。
    // caret:"initial" 才会把光标画进截图——Playwright 默认 caret:"hide"。
    await input.evaluate((el: HTMLInputElement) => { el.value = ""; el.placeholder = ""; });
    await input.click();
    let caret: { heightCss: number; widthCss: number; topCss: number; lum: number } | null = null;
    for (let attempt = 0; attempt < 10 && caret === null; attempt += 1) {
      await page.waitForTimeout(200);
      const shot = await input.screenshot({ caret: "initial" });
      caret = await page.evaluate(async (dataUrl: string) => {
        const image = new Image();
        await new Promise((resolve, reject) => {
          image.onload = resolve;
          image.onerror = reject;
          image.src = dataUrl;
        });
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(image, 0, 0);
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const lum = (index: number) => 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
        let darkest = { lum: Infinity, x: -1, y: -1 };
        let lightest = -1;
        for (let y = 0; y < canvas.height; y += 1) {
          for (let x = 0; x < canvas.width; x += 1) {
            const value = lum((y * canvas.width + x) * 4);
            if (value < darkest.lum) darkest = { lum: value, x, y };
            if (value > lightest) lightest = value;
          }
        }
        // 没有足够暗的像素＝光标正处于闪烁的熄灭相，下一拍再来。
        if (darkest.x < 0 || darkest.lum > lightest - 40) return null;
        const threshold = darkest.lum + 50;
        let left = darkest.x;
        let right = darkest.x;
        const rowDark = (x: number) => lum((darkest.y * canvas.width + x) * 4) < threshold;
        while (left > 0 && rowDark(left - 1)) left -= 1;
        while (right < canvas.width - 1 && rowDark(right + 1)) right += 1;
        const columnDark = (y: number) => {
          for (let x = left; x <= right; x += 1) {
            if (lum((y * canvas.width + x) * 4) < threshold) return true;
          }
          return false;
        };
        let top = darkest.y;
        let bottom = darkest.y;
        while (top > 0 && columnDark(top - 1)) top -= 1;
        while (bottom < canvas.height - 1 && columnDark(bottom + 1)) bottom += 1;
        const scale = window.devicePixelRatio;
        return { heightCss: (bottom - top + 1) / scale, widthCss: (right - left + 1) / scale,
          topCss: top / scale, lum: Math.round(darkest.lum) };
      }, `data:image/png;base64,${shot.toString("base64")}`);
    }
    const detail = JSON.stringify({ caret });
    expect(caret, detail).not.toBeNull();
    // 下限不写死px：光标高度是引擎按行盒光栅化的，同一份 CSS 在 dpr=1 量到 15px、dpr≥2 量到 19px
    // （修复前同法量到 8px / 11px）。用字号当基准——光标矮于字号就读作「小短线」，
    // 这正是用户截图里看到的样子；上限 24px 防行高继续加码顶满胶囊。
    expect(caret!.heightCss, detail).toBeGreaterThanOrEqual(geometry.fontSize - 1);
    expect(caret!.heightCss, detail).toBeLessThanOrEqual(24);
    // 宽度仍是平台发的 1 设备像素：只存档事实，不是可调量。
    expect(caret!.widthCss, detail).toBeLessThanOrEqual(2);
    // 光标落在输入行盒里，不顶到胶囊缘。
    expect(caret!.topCss, detail).toBeGreaterThanOrEqual(0);
    expect(caret!.topCss + caret!.heightCss, detail).toBeLessThanOrEqual(geometry.inputHeight + 1);
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
      // 2026-10-20 第十轮：根区间距收到 space.0.5(2px)，断言基准用既有 gap（= space.0.5）。
      const gap = Number.parseFloat(root.getPropertyValue("--relay-space-0-5")) * Number.parseFloat(root.fontSize);
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
    // 2026-10-16 第三轮：根区之间撤掉分隔线后，不能既无线也无间距——上边框为 0，相邻段之间至少留一档 space.0.5。
    expect(rest.sectionBorderTops.length, detail).toBeGreaterThanOrEqual(3);
    expect(Math.max(...rest.sectionBorderTops), detail).toBeLessThan(0.5);
    expect(Math.min(...rest.sectionGaps), detail).toBeGreaterThanOrEqual(rest.gap - 0.5);
    // 2026-10-16 第五轮起四个根区的视觉间距对齐同一档；第七轮修掉任务入口收起时塌成 0px 的
    // 相邻断裂；第八轮按用户「间距还是太大」由 space.3(12px) 收到 space.2(8px)；2026-10-20
    // 第九轮按「这四个的间距再减小一点」收到 space.1(4px)，同日第十轮按「减小到2px」收到
    // space.0.5(2px)——分组下外边距随同换档，塌穿才不会把间隙顶回去。四处间隙必须仍是同一档。
    expect(rest.sectionContentGaps.length, detail).toBe(3);
    expect(rest.sectionContentGaps.every((gap) => Math.abs(gap - rest.sectionContentGaps[0]!) < 0.5), detail).toBe(true);
    expect(rest.sectionContentGaps[0], detail).toBeCloseTo(rest.gap, 1);
  });

  // 2026-10-16 第七轮：用户截图指认「四个根区间距没有统一，统一成任务入口和已归档的间距」。
  // 根因是已归档段曾放在 recent-work-list 包装层之外，`.recent-work-section + .recent-work-section`
  // 覆盖不到「任务入口 ↔ 已归档」：任务入口展开时靠末组 margin 塌穿包装层凑数，一旦收起
  // 就塌成 0px（已归档贴着任务入口）。归档段移进包装层后，这里盯住任意折叠组合下四个根区都是
  // 同一档（第八轮收到 space.2、2026-10-20 第九轮随用户「再减小一点」收到 space.1、同日第十轮
  // 按「减小到2px」收到 space.0.5）；同时盯住行距只有一档——分组内与已归档区共用 space.0.5
  // （第五轮把行距收到 34px 后，分组覆盖曾留在 space.1，同一列两档行距，用户指认「而且要统一」）。
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
      return { gaps, space05: rem("--relay-space-0-5"), listGaps };
    });

    const expanded = await read();
    const detail = JSON.stringify(expanded);
    // 全部展开：三处根区间距都是 space.0.5（第十轮起，用户指定 2px），且已归档区的行确实在测量范围内。
    expect(expanded.gaps, detail).toEqual([expanded.space05, expanded.space05, expanded.space05]);
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
      .toEqual([tasksCollapsed.space05, tasksCollapsed.space05, tasksCollapsed.space05]);

    // 其余三段也收起：四处间距仍不变（任务入口保持收起，不再点它）。
    for (const id of ["recent-work-goals", "recent-work-directories", "recent-work-archived"]) {
      await page.locator(`[data-testid="${id}"] > summary`).click();
    }
    await page.waitForTimeout(150);
    const allCollapsed = await read();
    expect(allCollapsed.gaps, JSON.stringify(allCollapsed))
      .toEqual([allCollapsed.space05, allCollapsed.space05, allCollapsed.space05]);
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
        // 2026-10-18 用户指认「菜单竖直方向离三个点太远」：间距实测一档 space.1（4px）。
        // 只写「在下方」量不出这一档，8px 也满足 panelBelowTrigger。
        panelGap: panelBox === null ? null : panelBox.top - triggerBox.bottom,
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
        // 0104 未读圆点：只在这一条未读会话上出现，颜色取 action.primary。
        // 2026-10-19 用户指认「标记为未读之后没有变化、不够明显」：圆点由 space.1(4px) 提到
        // space.1 + space.0.5(6px)，未读行的标题同时加粗——只放大一枚圆点在 12px 标题旁
        // 仍会被读成图标的一部分，字重是第二道、也是不靠颜色的那道。圆点不进可访问名称。
        unreadDot: (() => {
          const dot = row.querySelector<HTMLElement>('[data-testid="recent-work-unread-dot"]');
          if (dot === null) return null;
          const style = getComputedStyle(dot);
          return { width: style.width, height: style.height,
            background: style.backgroundColor, radius: style.borderRadius,
            titleWeight: Number.parseInt(getComputedStyle(row.querySelector(".recent-work-title")!).fontWeight, 10) };
        })(),
        readTitleWeight: Number.parseInt(getComputedStyle(
          document.querySelector('[data-testid="recent-work-66666666-6666-4666-8666-666666666661"] .recent-work-title')!).fontWeight, 10),
        space05: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--relay-space-0-5"))
          * Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
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
    // 0104：未读圆点只长在未读会话上——尺寸取 space.1 + space.0.5、颜色取 action.primary；
    // 旁边那条已读会话（661）不得凭空长点。状态词本身在行按钮的 aria-label 里。
    // 2026-10-19 用户指认「不够明显」：圆点放大到 6px，且未读行标题的字重要高于已读行。
    expect(rest.unreadDot, detail).not.toBeNull();
    expect(Number.parseFloat(rest.unreadDot!.width), detail).toBeCloseTo(rest.space1 + rest.space05, 1);
    expect(rest.unreadDot!.width, detail).toBe(rest.unreadDot!.height);
    expect(rest.unreadDot!.background, detail).toBe(rest.tokenTextPrimary.actionPrimary);
    expect(rest.unreadDot!.titleWeight, detail).toBeGreaterThan(rest.readTitleWeight);
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
    // 2026-10-16 按用户参考菜单重排：置顶／重命名／未读／分叉在前，分组细线之后复制身份、归档与删除收尾；
    // 七条动作各带一枚前缀图标（图标不进 textContent，这里只核对顺序与存在性）。
    // 这条种子会话本身是未读态，所以第三项显示反向动作「取消未读」。
    // 2026-10-19：删除条目由「删除这段讨论」收成「删除」，确认改成就地浮层（见 sessionRowMenu.spec.ts）。
    expect(opened.panelActions, JSON.stringify(opened))
      .toEqual(["置顶", "重命名", "取消未读", "分叉这段讨论", "复制会话 ID", "归档", "删除"]);
    expect(opened.panelSeparators, JSON.stringify(opened)).toBe(1);
    expect(opened.panelActionIcons, JSON.stringify(opened))
      .toEqual([true, true, true, true, true, true, true]);
    // 收尾的归档与删除用状态红色（color.status.danger.text），上面五条常规动作用正文黑
    // （color.text.primary）——2026-10-17 用户指认「文字要黑色、危险操作像归档用红色」。
    // 常规动作绝不能退回共享基座 `.text-button` 的森林绿动作色，那是这轮改掉的读感。
    expect(opened.panelActionColors, JSON.stringify(opened)).toEqual(
      [opened.tokenTextPrimary.primary, opened.tokenTextPrimary.primary,
        opened.tokenTextPrimary.primary, opened.tokenTextPrimary.primary,
        opened.tokenTextPrimary.primary, opened.tokenTextPrimary.danger,
        opened.tokenTextPrimary.danger]);
    expect(opened.panelActionColors![0], JSON.stringify(opened))
      .not.toBe(opened.tokenTextPrimary.action);
    // 七条都左对齐（图标在左、名称跟着）：`.text-button` 基座的 justify-content:center
    // 是同特异度后置声明，曾把这里的 flex-start 静默压成居中（用户指认「文字要左对齐」）。
    expect(opened.panelActionJustify, JSON.stringify(opened))
      .toEqual(["flex-start", "flex-start", "flex-start", "flex-start", "flex-start", "flex-start", "flex-start"]);
    // 菜单宽度跟条目一致（用户指认）：面板宽 - 最宽条目自然宽 = 两侧内间距 + 细边，右侧不留空底。
    expect(opened.panelWidth! - opened.panelItemNaturalWidth!, JSON.stringify(opened))
      .toBeCloseTo(opened.panelInlineInsets!, 0);
    // 展开态 ⋯ 仍不带底色：底色只出现在行本体上。
    expect(opened.triggerBackground, JSON.stringify(opened)).toBe("rgba(0, 0, 0, 0)");
    // 浮层：fixed 定位、开在触发器下方、右缘与触发器对齐。
    expect(opened.panelPosition, JSON.stringify(opened)).toBe("fixed");
    expect(opened.panelBelowTrigger, JSON.stringify(opened)).toBe(true);
    // 间距只剩一档 space.1：⋯ 图标只有 20px 却压在 32px 控件框里，多一档就读成悬在行的下方。
    expect(opened.panelGap!, JSON.stringify(opened)).toBeCloseTo(opened.space1, 1);
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

    // 整行右键（2026-10-18 用户指令）：开的是同一个面板，锚点仍在 ⋯、不跟指针落点走，
    // 原生菜单让位（面板出现即说明 preventDefault 生效），同样一发命令都不发。
    await page.locator(`.recent-work-row:has([data-testid="recent-work-${sessionId}"])`)
      .first().click({ button: "right", position: { x: 12, y: 8 } });
    const rightClicked = await read();
    expect(rightClicked.expanded, JSON.stringify(rightClicked)).toBe("true");
    expect(rightClicked.panelPosition, JSON.stringify(rightClicked)).toBe("fixed");
    expect(rightClicked.panelGap!, JSON.stringify(rightClicked)).toBeCloseTo(rightClicked.space1, 1);
    expect(rightClicked.panelRightAligned, JSON.stringify(rightClicked)).toBe(true);
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

  // 删除确认（2026-10-19 用户指令「这个弹窗改成这样的简单弹窗」）：不再是 AppDialog，而是贴着 ⋯ 的
  // 一张窄卡。这里盯住六件事：没有遮罩与对话框外壳；卡片宽 16rem（`min(16rem, 100vw - space.4)`，
  // 基座那条 max-width 15rem 不得把它压回去）；开在触发器**右侧**（它比 176px 的左栏宽，开在左侧会被
  // 推到窗口左缘、尖角指不回触发器）、与触发器竖直居中、间距一档 space.1；小尖角画在 ::before 上、
  // 8px 见方、贴在卡片左缘探出一档 space.1；初始焦点压在「取消」上。
  test("删除确认是贴着 ⋯ 的窄卡：无遮罩、宽 16rem、带指向触发器的小尖角", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await installRoutes(page);
    const posts: string[] = [];
    page.on("request", (request) => { if (request.method() === "POST") posts.push(request.url()); });
    await page.goto("/agent");
    await connect(page);

    const sessionId = "66666666-6666-4666-8666-666666666662";
    await expect(page.getByTestId(`recent-work-${sessionId}`).first()).toBeVisible();
    // 同一会话在「目标」与「工作区」两段各有一份：按行定位刚悬停的那一份（触发器在目标区恒 display:none）。
    const row = page.locator(`.recent-work-row:has([data-testid="recent-work-${sessionId}"])`).first();
    await row.getByTestId(`recent-work-${sessionId}`).hover();
    await page.waitForTimeout(260);
    await row.getByTestId(`recent-work-menu-${sessionId}`).click();
    await row.getByTestId(`recent-work-panel-${sessionId}`).getByText("删除", { exact: true }).click();

    const look = await page.evaluate((target) => {
      const panel = document.querySelector<HTMLElement>(`[data-testid="recent-work-panel-${target}"]`)!;
      const trigger = panel.parentElement!.querySelector<HTMLElement>(".recent-work-row-trigger")!;
      const box = panel.getBoundingClientRect();
      const triggerBox = trigger.getBoundingClientRect();
      const arrow = getComputedStyle(panel, "::before");
      const root = getComputedStyle(document.documentElement);
      return {
        panelWidth: box.width,
        rightOfTrigger: box.left >= triggerBox.right - 1,
        gap: box.left - triggerBox.right,
        centerDelta: Math.abs((box.top + box.height / 2) - (triggerBox.top + triggerBox.height / 2)),
        arrowContent: arrow.content, arrowWidth: arrow.width, arrowHeight: arrow.height,
        arrowTop: arrow.top, arrowLeft: arrow.left, arrowTransform: arrow.transform,
        dialogs: document.querySelectorAll(".dialog-panel, .dialog-backdrop").length,
        title: panel.querySelector(".recent-work-confirm-title")?.textContent ?? null,
        buttons: [...panel.querySelectorAll("button")].map((button) => (button.textContent ?? "").trim()),
        // 2026-10-19 用户指令「删除和取消的宽度加起来要和菜单一致」：两键各占一半、合计铺满内容宽。
        // 内容宽取 padding box（clientWidth 不含边框），与菜单条目那条左右边界同一档。
        buttonWidths: [...panel.querySelectorAll(".recent-work-confirm-actions > button")]
          .map((button) => button.getBoundingClientRect().width),
        buttonGap: (() => {
          const [first, second] = [...panel.querySelectorAll(".recent-work-confirm-actions > button")]
            .map((button) => button.getBoundingClientRect());
          return second === undefined ? null : second.left - first.right;
        })(),
        contentWidth: panel.clientWidth
          - Number.parseFloat(getComputedStyle(panel).paddingLeft)
          - Number.parseFloat(getComputedStyle(panel).paddingRight),
        focused: document.activeElement?.getAttribute("data-testid") ?? null,
        space1: Number.parseFloat(root.getPropertyValue("--relay-space-1"))
          * Number.parseFloat(root.fontSize),
        space2: Number.parseFloat(root.getPropertyValue("--relay-space-2"))
          * Number.parseFloat(root.fontSize)
      };
    }, sessionId);

    const detail = JSON.stringify(look);
    // 没有第二层弹窗外壳：确认就长在 ⋯ 的那块浮层里，遮罩、关闭叉、第二套标题栏一概没有。
    expect(look.dialogs, detail).toBe(0);
    // 宽 16rem（= 256px）：基座那条 max-width 15rem 是给「跟条目同宽」的菜单兜底的，不能压回这张卡。
    expect(look.panelWidth, detail).toBeCloseTo(256, 0);
    // 开在触发器右侧、竖直居中，横向只隔一档 space.1：尖角因此落在卡片左缘而不是被推到窗口左缘。
    expect(look.rightOfTrigger, detail).toBe(true);
    expect(look.gap, detail).toBeCloseTo(look.space1, 1);
    expect(look.centerDelta, detail).toBeLessThan(1);
    // 小尖角：8px 见方、贴在左缘探出一档 space.1、竖直居中，-45° 让它指向左边的 ⋯。
    expect(look.arrowContent, detail).not.toBe("none");
    expect(Number.parseFloat(look.arrowWidth), detail).toBeCloseTo(8, 1);
    expect(Number.parseFloat(look.arrowHeight), detail).toBeCloseTo(8, 1);
    expect(Number.parseFloat(look.arrowLeft), detail).toBeCloseTo(-look.space1, 1);
    // 同一个角从「朝上」转到「朝左」是 -90°：矩阵取 rotate(-45deg) = (0.707, -0.707, 0.707, 0.707)。
    expect(look.arrowTransform, detail).toMatch(/^matrix\(0\.707107, -0\.707107, 0\.707107, 0\.707107/u);
    expect(look.title, detail).toBe("删除这段讨论？");
    // 删除在左、取消在右；两键等宽、合计 + 中间那档间距正好等于内容宽（与菜单条目同一条边界）。
    expect(look.buttons, detail).toEqual(["删除", "取消"]);
    expect(look.buttonWidths, detail).toHaveLength(2);
    expect(Math.abs(look.buttonWidths[0]! - look.buttonWidths[1]!), detail).toBeLessThan(1);
    expect(look.buttonWidths[0]! + look.buttonWidths[1]! + look.buttonGap!, detail)
      .toBeCloseTo(look.contentWidth, 0);
    expect(look.buttonGap, detail).toBeCloseTo(look.space2, 1);
    // 危险动作不从回车起手：焦点压在「取消」上，且一条命令都没发。
    expect(look.focused, detail).toBe(`session-delete-cancel-${sessionId}`);
    expect(posts, detail).toHaveLength(0);
    await page.screenshot({ path: "results/rail-row-confirm.png" });

    // Esc 收起（面板的既有规矩，确认态不改）。
    await page.keyboard.press("Escape");
    await expect(page.getByTestId(`recent-work-panel-${sessionId}`)).toHaveCount(0);
  });

  // 2026-10-20 第五轮（用户截图）：批量操作栏从主内容区上方居中的浮层挪回**左栏内部**，
  // 落在「工作区（目录）」标题正下方。守六件事：① 无勾选时整块不存在；② 勾第一项后它出现在
  // 左栏里、紧跟「工作区（目录）」段标题；③ 不越出左栏滚动容器的左右缘（不遮挡目录条目）；
  // ④ 在这一段里滚动时停在列顶（sticky），不跟着滚走；⑤ 计数与两键仍是轻量扁平那一档；
  // ⑥ 它只占用这一段的内部空间，不把左栏整体顶高、也不占主工作区。
  test("批量操作栏落在左栏「工作区（目录）」标题下方、sticky 停在列顶且不越出侧栏", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await installRoutes(page);
    // 默认 fixture 只有 3 段会话，900px 高下左栏装得下、根本不滚动，sticky 无从体现。
    // 后注册的 route 先匹配（同文件既有用法），给这一列补足到必须滚动的条数。
    await page.route(`${apiBase}/**`, async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() === "OPTIONS") { await route.fulfill({ status: 204 }); return; }
      if (path === `${prefix}/assist-sessions` && new URL(request.url()).searchParams.get("status") !== "ARCHIVED") {
        const many = Array.from({ length: 16 }, (_unused, index) => session(
          `88888888-8888-4888-8888-${String(index + 1).padStart(12, "0")}`, null, `第 ${index + 1} 段讨论`,
          "2026-10-15T12:09:00Z"));
        return fulfillJson(route, { items: many, next_cursor: null });
      }
      await route.fallback();
    });
    await page.goto("/agent");
    await connect(page);
    const sessionId = "88888888-8888-4888-8888-000000000001";

    // 静止态没有操作栏。
    await expect(page.getByTestId("recent-work-selection")).toHaveCount(0);

    const row = page.locator(`.recent-work-row:has([data-testid="recent-work-${sessionId}"])`).first();
    await row.getByTestId(`recent-work-${sessionId}`).hover();
    await row.getByTestId(`recent-work-select-${sessionId}`).click();
    await expect(page.getByTestId("recent-work-selection")).toBeVisible();

    const look = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const rem = (name: string) => Number.parseFloat(root.getPropertyValue(name))
        * Number.parseFloat(root.fontSize);
      const scroll = document.querySelector<HTMLElement>(".recent-work-scroll")!;
      const section = document.querySelector<HTMLElement>('[data-testid="recent-work-directories"]')!;
      const summary = section.querySelector<HTMLElement>("summary")!;
      const bar = document.querySelector<HTMLElement>('[data-testid="recent-work-selection"]')!;
      const count = bar.querySelector<HTMLElement>('[data-testid="recent-work-selection-count"]')!;
      const buttons = [...bar.querySelectorAll<HTMLElement>(".recent-work-confirm-actions > button")]
        .map((button) => button.getBoundingClientRect());
      const scrollBox = scroll.getBoundingClientRect();
      const barBox = bar.getBoundingClientRect();
      const style = getComputedStyle(bar);
      return {
        // 落在左栏内部：操作栏是滚动容器的后代，不是 body 直属节点。
        inRail: scroll.contains(bar),
        // 紧跟「工作区（目录）」段标题下方，且是它的兄弟（不是别处的浮层）。
        afterSummary: summary.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING,
        // 不越出侧栏滚动容器的左右缘：不遮挡目录条目，也不横向溢出。
        insetLeft: barBox.left - scrollBox.left,
        insetRight: scrollBox.right - barBox.right,
        // 在这一段里滚动时停在列顶：sticky。静止态它在自然位置（段标题下方）。
        position: style.position,
        restTop: barBox.top - scrollBox.top,
        // 轻量扁平：中性底 + 细边 + 适度圆角，不用浮层那一档投影。
        shadow: style.boxShadow,
        radius: style.borderTopLeftRadius,
        borderWidth: style.borderTopWidth,
        countAlign: getComputedStyle(count).textAlign,
        countText: count.textContent?.trim() ?? "",
        buttonWidths: buttons.map((box) => box.width),
        buttonGap: buttons.length < 2 ? null : buttons[1]!.left - buttons[0]!.right,
        space2: rem("--relay-space-2")
      };
    });
    const detail = JSON.stringify(look);
    expect(look.inRail, detail).toBe(true);
    expect(look.afterSummary, detail).toBeTruthy();
    expect(look.insetLeft, detail).toBeGreaterThanOrEqual(-0.5);
    expect(look.insetRight, detail).toBeGreaterThanOrEqual(-0.5);
    expect(look.position, detail).toBe("sticky");
    // 静止态在自然位置：段标题下方、不与标题重叠（> 0 才说明它没有盖住标题）。
    expect(look.restTop, detail).toBeGreaterThan(0);
    expect(look.shadow, detail).toBe("none");
    expect(look.borderWidth, detail).not.toBe("0px");
    expect(look.countAlign, detail).toBe("start");
    expect(look.countText, detail).toContain("已选 1 段讨论");
    expect(look.buttonWidths, detail).toHaveLength(2);
    expect(look.buttonGap, detail).toBeCloseTo(look.space2, 1);
    // 两颗键按内容宽收窄：在 160px 内容盒里也不挤成一团（各占一半会贴边）。
    const barWidth = await page.getByTestId("recent-work-selection")
      .evaluate((element) => element.getBoundingClientRect().width);
    expect(look.buttonWidths[0]! + look.buttonWidths[1]! + look.buttonGap!, detail)
      .toBeLessThan(barWidth);

    // 滚动这一段时操作栏停在列顶，不跟着内容滚走。
    const scrolled = await page.evaluate(() => {
      const scroll = document.querySelector<HTMLElement>(".recent-work-scroll")!;
      const before = scroll.scrollTop;
      scroll.scrollTop = 120;
      return { before, after: scroll.scrollTop, scrollable: scroll.scrollHeight - scroll.clientHeight };
    });
    // 前置条件必须真的成立：这一列此刻能滚动，否则下面的贴顶断言是空转。
    expect(scrolled.after, detail).toBeGreaterThan(scrolled.before);
    expect(scrolled.scrollable, detail).toBeGreaterThan(40);
    const afterScroll = await page.evaluate(() => {
      const scroll = document.querySelector<HTMLElement>(".recent-work-scroll")!;
      const bar = document.querySelector<HTMLElement>('[data-testid="recent-work-selection"]')!;
      const section = document.querySelector<HTMLElement>('[data-testid="recent-work-directories"]')!;
      const summary = section.querySelector<HTMLElement>("summary")!;
      const scrollBox = scroll.getBoundingClientRect();
      const barBox = bar.getBoundingClientRect();
      const summaryBox = summary.getBoundingClientRect();
      return {
        // 贴顶：偏差不超过一档 space.1（4px，来自搜索框与滚动区之间那一档间距进入 sticky 计算）。
        delta: Math.abs(barBox.top - scrollBox.top),
        // 滚动时仍在视口内可见。
        visible: barBox.top < scrollBox.bottom && barBox.bottom > scrollBox.top,
        // 不盖住「工作区（目录）」段标题。
        coversSummary: barBox.top < summaryBox.bottom && barBox.bottom > summaryBox.top
      };
    });
    // 贴顶容差取一档 space.1（4px）：sticky 的参照是滚动容器的内容盒，而 getBoundingClientRect
    // 读的是 border-box，两者差一档间距。容差大于 4px 会让这条断言失去意义。
    expect(afterScroll.delta, detail).toBeLessThanOrEqual(4);
    expect(afterScroll.visible, detail).toBe(true);
    expect(afterScroll.coversSummary, detail).toBe(false);

    await page.screenshot({ path: "results/rail-batch-bar-in-rail.png" });

    // 取消选择：整块收起，勾选清空，一条命令都不发。
    await page.getByTestId("recent-work-selection-clear").click();
    await expect(page.getByTestId("recent-work-selection")).toHaveCount(0);
    await expect(row.getByTestId(`recent-work-select-${sessionId}`)).not.toBeChecked();
  });

  // 2026-10-24 用户两张截图，同一处 ⋯ 的两面：
  // ① 宽栏（17rem 档）「会话名称过长时，悬停的更多菜单按钮会和名称重合」——标题盒的右缘就落在
  //    行右缘内 space.2，而 ⋯ 是 32px 见方的绝对定位控件，覆盖的正是标题盒最后 32px；标题一长，
  //    尾字就压在它下面，图标与字挤在一起读不清。
  // ② 窄栏「这种宽度就看不到更多菜单按钮了」——行是 grid 项，`min-width: auto` 让它的最小宽
  //    等于整段标题的自然宽（`.recent-work-title` 的 `min-width: 0` 只管 flex 收缩），于是长标题
  //    把行撑得比栏还宽：标题被栏的 overflow 齐头切掉，⋯ 直接被推到栏外。
  // 两处修法都不动行高与标题字号：
  // ② 给 `.recent-work-row` 补 `min-width: 0`，轨道按栏宽定尺，标题回到「单行 + 省略号」，⋯ 留在栏内；
  // ① 给触发器背后加一层虚化底（backdrop-filter 把压过来的标题糊掉 + 一层栏纸面同色、左端透明的
  //    渐变，共用同一条 mask 让边界淡出）——不能改成「悬停时收窄标题可用宽」，那样长标题会在指针
  //    落下的那一刻重新截断、整列文字跟着跳。
  // 本用例分两段守：宽栏段守虚化底（⋯ 自身仍不带底色、虚化底真的存在且盖到标题尾字之前、纵向
  // 不越出行盒、以及像素层面标题尾部的对比度确实被压低）；窄栏段守行宽与 ⋯ 的可达（行不越出
  // 滚动内容盒、标题真的收成省略号、⋯ 整个落在栏内且省略号仍在它底下）。
  test("长标题压在 ⋯ 下面时虚化底盖住尾字，栏收窄后 ⋯ 仍留在栏内", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await installRoutes(page);
    const sessionId = "99999999-9999-4999-8999-999999999991";
    // 标题长度是照用户第一张截图那一档挑的：14px meta 档下这段字自然宽约 206px，栏拖到上限
    // 17rem=272px 时（内容盒 254px）行不越界，而文字右端正好落进 ⋯ 覆盖的最后 32px。
    const longTitle = "关于Relay-Agent（1）关于Relay";
    // 只放一条长标题会话，并且不给它关联目标：目标区会再复制一份同样的行（那份触发器恒
    // display:none），两条同 testid 的行走位容易读错，这里刻意只留一份。
    const longSession = { ...(session(sessionId, projectB, longTitle, "2026-10-24T11:00:00Z") as Record<string, unknown>),
      context: { project_goals: [],
        working_directory: { resource_id: projectB, canonical_root: "D:/experiment/code" } } };
    // 后注册的 route 先匹配（同文件既有用法）：只换这一条的清单，其余仍走上面的夹具。
    await page.route(`${apiBase}/**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("status") === "ARCHIVED") return route.fallback();
      if (url.pathname === `${prefix}/assist-sessions`) return fulfillJson(route, { items: [longSession] });
      if (url.pathname === `${prefix}/assist-sessions/${sessionId}`) return fulfillJson(route, longSession);
      return route.fallback();
    });
    await page.goto("/agent");
    await connect(page);
    // 栏拖到 token 上限（用户第一张截图里那一档）。拖拽宽度写在 .app-frame 的
    // --relay-sidebar-user-width 上，与手柄同源。
    const setRailWidth = (width: string) => page.evaluate((value) => {
      document.querySelector<HTMLElement>(".app-frame")!.style.setProperty("--relay-sidebar-user-width", value);
    }, width);
    await setRailWidth("272px");
    await page.waitForTimeout(200);

    const row = page.locator(`.recent-work-row:has([data-testid="recent-work-${sessionId}"])`);
    await expect(row).toHaveCount(1);
    await row.getByTestId(`recent-work-${sessionId}`).hover();
    await page.waitForTimeout(260);

    const read = () => page.evaluate((target) => {
      const item = document.querySelector<HTMLElement>(`[data-testid="recent-work-${target}"]`)!;
      const rowElement = item.closest("li")!;
      const scroll = document.querySelector<HTMLElement>(".recent-work-scroll")!;
      const rail = document.querySelector<HTMLElement>(".app-context-rail")!;
      const trigger = rowElement.querySelector<HTMLElement>(".recent-work-row-trigger")!;
      const title = item.querySelector<HTMLElement>(".recent-work-title")!;
      const veil = getComputedStyle(trigger, "::before");
      const root = getComputedStyle(document.documentElement);
      const rem = (name: string) => Number.parseFloat(root.getPropertyValue(name)) * Number.parseFloat(root.fontSize);
      const rowBox = rowElement.getBoundingClientRect();
      const triggerBox = trigger.getBoundingClientRect();
      const titleBox = title.getBoundingClientRect();
      const scrollBox = scroll.getBoundingClientRect();
      // 文字的**实际绘制右缘**：Range 量文字而不是量盒。注意 Range 不受 overflow 裁剪，
      // 被省略号截断时它读到的仍是整段文字的自然右缘，所以「看得见的右缘」要再和盒右缘取小。
      const textRange = document.createRange();
      textRange.selectNodeContents(title);
      const textRight = textRange.getBoundingClientRect().right;
      const space1 = rem("--relay-space-1");
      const space2 = rem("--relay-space-2");
      // ::before 没有自己的盒模型读数：按触发器盒与规则里的 inset 换算（横向左端 −space.2、
      // 纵向上下各内缩 space.1），断言的正是这两条 inset 有没有把边界放对。
      return {
        triggerBackground: getComputedStyle(trigger).backgroundColor,
        veilBackdrop: veil.backdropFilter,
        veilMask: veil.maskImage,
        veilBackground: veil.backgroundImage,
        veilTop: triggerBox.top + space1,
        veilBottom: triggerBox.bottom - space1,
        veilLeft: triggerBox.left - space2,
        veilRight: triggerBox.right,
        rowTop: rowBox.top, rowBottom: rowBox.bottom, rowRight: rowBox.right,
        titleLeft: titleBox.left, titleRight: titleBox.right, textRight,
        // 看得见的文字右缘：截断时就是盒右缘（省略号画在那里），未截断时就是文字自己的右缘。
        visibleTextRight: Math.min(textRight, titleBox.right),
        triggerLeft: triggerBox.left, triggerRight: triggerBox.right,
        railRight: rail.getBoundingClientRect().right,
        contentRight: scrollBox.left + scroll.clientWidth,
        scrollLeft: scroll.scrollLeft,
        // 标题此刻是否真的收成省略号（被撑宽的行不会截断，这一条是窄栏修法的直接判据）。
        truncated: title.scrollWidth > title.clientWidth + 0.5,
        space2
      };
    }, sessionId);

    const look = await read();
    const detail = JSON.stringify(look);
    // 前置条件必须成立：看得见的标题真的伸到了 ⋯ 底下（否则「重合」无从谈起，虚化也无事可做），
    // 而且 ⋯ 本身还在栏内（行没被标题撑出栏外——那一档在下面第二段守）。
    expect(look.truncated || look.visibleTextRight >= look.triggerLeft + look.space2, detail).toBe(true);
    expect(look.triggerRight, detail).toBeLessThanOrEqual(look.railRight + 0.5);
    // 栏不该被这一行横向滚走：位置读数得是静止态。
    expect(look.scrollLeft, detail).toBeLessThan(look.space2);
    // 2026-10-16 的既有约定不改：⋯ 自己仍是透明的，虚化底画在它的 ::before 上。
    expect(look.triggerBackground, detail).toBe("rgba(0, 0, 0, 0)");
    expect(look.veilBackdrop, detail).toContain("blur(4px)");
    // 渐变与遮罩共用同一条从左透明的斜坡：模糊边界跟着淡出，不在标题中间留硬边。
    expect(look.veilMask, detail).not.toBe("none");
    expect(look.veilMask, detail).toContain("linear-gradient");
    expect(look.veilBackground, detail).toContain("linear-gradient");
    // 虚化底向左多铺一档：起点落在标题尾字之前，尾字是「淡出」而不是被图标齐头切断。
    expect(look.visibleTextRight - look.veilLeft, detail).toBeGreaterThanOrEqual(look.space2 - 0.5);
    // 纵向不越出行：触发器 32px 高而行只有 24px，虚化底必须内缩到行内，否则相邻行也被糊一道。
    expect(look.veilTop, detail).toBeGreaterThanOrEqual(look.rowTop - 0.5);
    expect(look.veilBottom, detail).toBeLessThanOrEqual(look.rowBottom + 0.5);

    // 像素证据：同一块触发器区域，去掉虚化底前后各拍一张，标题尾部（深字压在白底上）的
    // 亮度标准差应明显下降——这正是「字被糊掉、图标读得清」的可测形态。
    const menu = row.getByTestId(`recent-work-menu-${sessionId}`);
    const withVeil = await menu.screenshot();
    const veilOff = await page.addStyleTag({ content: ".recent-work-row-trigger::before{content:none !important}" });
    await page.waitForTimeout(120);
    const withoutVeil = await menu.screenshot();
    await veilOff.evaluate((element: Element) => element.remove());
    const spread = await page.evaluate(async (shots: { withVeil: string; withoutVeil: string }) => {
      const load = async (dataUrl: string) => {
        const image = new Image();
        await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = dataUrl; });
        const canvas = document.createElement("canvas");
        canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(image, 0, 0);
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const luminance: number[] = [];
        for (let index = 0; index < data.length; index += 4) {
          luminance.push(0.2126 * data[index]! + 0.7152 * data[index + 1]! + 0.0722 * data[index + 2]!);
        }
        const mean = luminance.reduce((sum, value) => sum + value, 0) / luminance.length;
        const variance = luminance.reduce((sum, value) => sum + (value - mean) ** 2, 0) / luminance.length;
        return Number(Math.sqrt(variance).toFixed(2));
      };
      return { withVeil: await load(shots.withVeil), withoutVeil: await load(shots.withoutVeil) };
    }, { withVeil: `data:image/png;base64,${withVeil.toString("base64")}`,
      withoutVeil: `data:image/png;base64,${withoutVeil.toString("base64")}` });
    expect(spread.withVeil, JSON.stringify(spread)).toBeLessThan(spread.withoutVeil);

    // 左栏整体留一张，供人工核对观感（虚化底只在悬停时出现，静止态逐像素不变）。
    await page.locator(".app-context-rail").screenshot({ path: "results/rail-title-veil.png" });

    // 第二段：栏收窄到 11rem 下限（用户第二张截图那一档）。此前长标题会把行撑得比栏还宽，
    // 标题被栏右缘齐头切掉、⋯ 被推到栏外，悬停根本看不见按钮。补 `.recent-work-row{min-width:0}`
    // 之后：行不越出滚动内容盒、标题收成省略号、⋯ 整个落在栏内，而省略号仍在它底下（虚化底
    // 在这一档同样生效——两件事一起守，免得只修好一头）。
    await setRailWidth("176px");
    await page.waitForTimeout(200);
    await row.getByTestId(`recent-work-${sessionId}`).hover();
    await page.waitForTimeout(260);
    const narrow = await read();
    const narrowDetail = JSON.stringify(narrow);
    expect(narrow.rowRight, narrowDetail).toBeLessThanOrEqual(narrow.contentRight + 0.5);
    expect(narrow.scrollLeft, narrowDetail).toBe(0);
    expect(narrow.truncated, narrowDetail).toBe(true);
    expect(narrow.triggerRight, narrowDetail).toBeLessThanOrEqual(narrow.railRight + 0.5);
    expect(narrow.visibleTextRight, narrowDetail).toBeGreaterThan(narrow.triggerLeft + narrow.space2);
    expect(narrow.veilBackdrop, narrowDetail).toContain("blur(4px)");
    await page.locator(".app-context-rail").screenshot({ path: "results/rail-title-veil-narrow.png" });
  });
});
