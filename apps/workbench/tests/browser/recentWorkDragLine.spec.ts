import { expect, test, type Page, type Route } from "@playwright/test";

// 会话行拖拽改序在真实 Chromium 里的几何验收（jsdom 只验证了逻辑，布局是自己造的）。
// 盯六件事：横线画在「松手后条目会落进去」的那道缝里、拖拽期间整列不跳动、手里那一行确实跟着
// 指针走并浮在其余行之上、松手后行的次序确实等于横线承诺的次序、改序只写本机偏好（一个 POST 都不发）、
// 换位这件事在屏幕上真的看得出来（一段位移 + 一档会自己消失的落位强调，减少动效时退化成静态强调）。
// API 全部由 page.route 伪造，不连数据库、不调 Provider。

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = `http://127.0.0.1:${process.env.RELAY_DRAG_TEST_PORT ?? "4173"}`;

const projectA = "22222222-2222-4222-8222-222222222222";
const goalId = "88888888-8888-4888-8888-888888888888";
const sessionIds = ["66666666-6666-4666-8666-666666666661", "66666666-6666-4666-8666-666666666662",
  "66666666-6666-4666-8666-666666666663"];
const titles = ["拖拽探针甲：排在最上", "拖拽探针乙：排在中间", "拖拽探针丙：排在最下"];

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin, "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: "application/json", headers: cors(), body: JSON.stringify(body) });
}

function session(index: number): Record<string, unknown> {
  // 三条时间依次递减：服务端排序键（updated_at 倒序）给出的初序就是甲、乙、丙。
  const at = `2026-10-15T0${2 - index}:00:00Z`;
  return { id: sessionIds[index], workspace_id: workspaceId, project_id: projectA, task_id: null,
    title: titles[index], status: "ACTIVE", revision: "1", created_at: at, updated_at: at,
    working_resource_id: projectA, pinned_at: null,
    context: { project_goals: [{ goal_id: goalId, title: "拖拽探针目标" }],
      working_directory: { resource_id: projectA, canonical_root: "D:/drag/probe" } } };
}

function projectRow(): unknown {
  return { id: projectA, title: "DragProbe 项目", project_type: "GENERAL", revision: "1", state_revision: "1",
    archive_status: "ACTIVE", archived_at: null, phase_key: "GENERAL", next_action_task_id: null,
    created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-11T06:59:00Z" };
}

async function installRoutes(page: Page): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/assist-sessions`) {
      // 三条会话同属一个目录与一个目标：目录分组与目标分组都是整列次序的子序列，
      // 拖一处两处一起动，正好用来核对「顺序只有一个全局事实」。
      if (new URL(request.url()).searchParams.get("status") === "ARCHIVED") {
        // 归档区放两条，才有 ul 可查：它不参与手动排序，结构上就不该有拖拽把手。
        return fulfillJson(route, { items: [
          { ...session(1), id: "77777777-7777-4777-8777-777777777771", title: "归档探针甲" },
          { ...session(0), id: "77777777-7777-4777-8777-777777777772", title: "归档探针乙" }
        ] });
      }
      return fulfillJson(route, { items: [session(0), session(1), session(2)], next_cursor: null });
    }
    if (path === `${prefix}/assist-sessions/${sessionIds[0]}`) return fulfillJson(route, session(0));
    if (path === `${prefix}/projects`) return fulfillJson(route, { items: [projectRow()], next_cursor: null });
    if (path === `${prefix}/projects/${projectA}`) return fulfillJson(route, projectRow());
    return fulfillJson(route, { items: [], next_cursor: null });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("drag-probe-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

/** 拖一次：抓住 fromIndex 那一行，指针落到 toY（视口坐标），松手。 */
async function dragRow(page: Page, ul: string, fromIndex: number, toY: number): Promise<void> {
  const row = page.locator(`${ul} [data-recent-row]`).nth(fromIndex).locator(".recent-work-item");
  const box = (await row.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, toY, { steps: 8 });
  await page.mouse.up();
}

/** 量一列：行标题次序、行盒、分组几何，以及落在两道缝里的横线（拖拽中才有）。 */
function measure(page: Page, listKey: string) {
  return page.evaluate((key) => {
    const ul = document.querySelector<HTMLElement>(`ul[data-recent-list="${key}"]`)!;
    const ulBox = ul.getBoundingClientRect();
    const style = getComputedStyle(ul);
    const line = document.querySelector<HTMLElement>('[data-testid="recent-work-drop-line"]');
    const lineBox = line?.getBoundingClientRect() ?? null;
    return {
      order: [...ul.querySelectorAll<HTMLElement>(".recent-work-title")].map((node) => node.textContent!),
      rows: [...ul.querySelectorAll<HTMLElement>("[data-recent-row]")].map((node) => {
        const box = node.getBoundingClientRect();
        // rect 会把手里那一行的平移算进去，offsetTop 只认布局：两者分开量，才说得出
        // 「带着走只动画面、不动布局」这句承诺到底成没成立。
        return { top: box.top, bottom: box.bottom, height: box.height,
          layoutTop: node.offsetTop, held: node.classList.contains("recent-work-row--dragging") };
      }),
      gap: Number.parseFloat(style.rowGap),
      // 横线绝对定位在 ul 的 padding box 上： inset-inline:0 的左右边界就是内容区。
      lineLeft: lineBox?.left ?? null,
      lineRight: lineBox?.right ?? null,
      lineTop: lineBox?.top ?? null,
      lineHeight: lineBox?.height ?? null,
      contentLeft: ulBox.left + Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.paddingLeft),
      contentRight: ulBox.right - Number.parseFloat(style.borderRightWidth) - Number.parseFloat(style.paddingRight),
      focusWidth: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--relay-focus-width"))
        * Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
    };
  }, listKey);
}

const directoryList = `directory:${projectA}`;

/**
 * 把「落位动画」这件事变成可断言的记录。
 *
 * 为什么要在页面里钩 `Element.prototype.animate`：jsdom 那一半只证明了代码算出了这段位移，
 * 而「有没有交换成功」是屏幕上的一帧一帧——所以这里同时记下每次调用的参数（用的到底是哪一档
 * token、位移量等于第几行高）以及播放期间元素真实算出来的 transform（证明行确实在滑动，
 * 而不是参数写了却压根没跑）。
 */
interface SlideRecord {
  readonly key: string;
  /** 同一条会话在「目标」与「工作区（目录）」各有一份副本：只有起手那一列的那份带着走。 */
  readonly listKey: string;
  readonly from: string;
  readonly duration: number | string;
  readonly easing: string | undefined;
  readonly during: string[];
}
type SlidesWindow = Window & { __slides: SlideRecord[] };
const slides = () => (window as unknown as SlidesWindow).__slides;

async function watchSlides(page: Page): Promise<void> {
  await page.evaluate(() => {
    const host = window as unknown as SlidesWindow;
    host.__slides = [];
    const proto = Element.prototype;
    // 原方法按「真正的那个元素」调用：bind 到原型上会在 V8 里 Illegal invocation，
    // 记录器自己先把组件的动画循环打断了（先踩到的是这条，不是产品）。
    const play = proto.animate;
    proto.animate = function (this: Element, frames: Keyframe[], options?: KeyframeAnimationOptions) {
      const element = this as HTMLElement;
      const record: SlideRecord = {
        key: element.dataset.recentRow ?? "",
        listKey: element.closest("ul")?.dataset.recentList ?? "",
        from: String(frames[0]?.transform ?? ""),
        // WAAPI 的 duration 允许 CSS 数值表达式，这里只取实际传进来的那一档。
        duration: typeof options?.duration === "number" ? options.duration : String(options?.duration ?? ""),
        easing: options?.easing, during: []
      };
      host.__slides.push(record);
      const animation = play.call(this, frames, options);
      const tick = () => {
        record.during.push(getComputedStyle(element).transform);
        if (animation.playState === "running") requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return animation;
    };
  });
}

const slidesOf = (page: Page) => page.evaluate(slides);

/** 落位强调的真实回执：哪些行被标记、底色有没有画上、过渡是哪一档。 */
function droppedState(page: Page) {
  return page.evaluate(() => {
    const marked = [...document.querySelectorAll<HTMLElement>("[data-recent-dropped]")];
    const tintOf = (row: Element) => getComputedStyle(row.querySelector<HTMLElement>(".recent-work-item")!).backgroundColor;
    return {
      keys: [...new Set(marked.map((row) => row.dataset.recentRow ?? ""))],
      tints: [...new Set(marked.map(tintOf))],
      others: [...document.querySelectorAll<HTMLElement>("[data-recent-row]:not([data-recent-dropped]) .recent-work-item")]
        .map((item) => getComputedStyle(item).backgroundColor),
      transition: marked.length === 0 ? null : getComputedStyle(marked[0]!.querySelector<HTMLElement>(".recent-work-item")!).transitionDuration
    };
  });
}

/** `translateY(-34px)` → -34；`matrix(1, 0, 0, 1, 0, 34)` → 34；`none` → 0。 */
const offsetOf = (raw: string) => Number.parseFloat(raw.slice(raw.indexOf("(") + 1));
const tyOf = (raw: string) => (raw === "none" ? 0 : Number.parseFloat(raw.slice(raw.lastIndexOf(", ") + 1)));

/**
 * 等落位滑行动画停住：滑过的行此刻的 rect 还在半路上，拿它算下一道缝会算出一个「谁都不挨着」的
 * 位置（第二拖就是这么被判给最后一格的）。落点数学本身不受影响——它读的是 offsetTop（布局），
 * transform 不改布局；受影响的是测试自己那些按画面位置推出来的期望值。
 */
async function settleSlides(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-recent-row]")]
      .some((node) => getComputedStyle(node).transform !== "none")))
    .toBe(false);
}

/** 抓第一行，拖到「乙 ↔ 丙」那道缝里松手（第一拖用的都是这一处）。 */
async function dragFirstIntoBottomSeam(page: Page) {
  const before = await measure(page, directoryList);
  const seam = (before.rows[1]!.bottom + before.rows[2]!.top) / 2;
  const grab = (await page.locator(`ul[data-recent-list="${directoryList}"] [data-recent-row]`)
    .nth(0).locator(".recent-work-item").boundingBox())!;
  await page.mouse.move(grab.x + grab.width / 2, grab.y + grab.height / 2);
  await page.mouse.down();
  await page.mouse.move(grab.x + grab.width / 2, seam, { steps: 8 });
  // 松手前一拍：手里那一行已经跟着指针偏下来了，落位动画的起点就是这个偏移，不是原来的格子。
  const held = await measure(page, directoryList);
  const carry = held.rows[0]!.top - before.rows[0]!.top;
  await page.mouse.up();
  return { before, seam, carry };
}

test.describe("会话行拖拽改序", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await installRoutes(page);
    await page.goto("/agent");
    await connect(page);
    await expect(page.locator(`ul[data-recent-list="${directoryList}"] [data-recent-row]`)).toHaveCount(3);
  });

  test("横线落在两道行之间的缝里，松手后条目就落进那道缝", async ({ page }) => {
    const posts: string[] = [];
    page.on("request", (request) => { if (request.method() === "POST") posts.push(request.url()); });

    const before = await measure(page, directoryList);
    expect(before.order).toEqual(titles);
    expect(before.gap).toBeGreaterThan(0);

    // 把第一行拖到「乙 ↔ 丙」之间：指针落在那道缝的中心，横线应落在缝正中。
    const seam = (before.rows[1]!.bottom + before.rows[2]!.top) / 2;
    const rowBox = page.locator(`ul[data-recent-list="${directoryList}"] [data-recent-row]`).nth(0);
    const grab = (await rowBox.locator(".recent-work-item").boundingBox())!;
    const grabCenter = grab.y + grab.height / 2;
    await page.mouse.move(grab.x + grab.width / 2, grabCenter);
    await page.mouse.down();
    await page.mouse.move(grab.x + grab.width / 2, seam, { steps: 8 });

    const dragging = await measure(page, directoryList);
    const detail = JSON.stringify({ before, dragging });
    // 横线出现，且落在乙的底与丙的顶之间——也就是松手后条目会落进去的那道缝。
    // 落点数学用的是 offsetTop/offsetHeight（Chromium 取整），所以按缝的边界各放行 1.5px。
    expect(dragging.lineTop, detail).not.toBeNull();
    expect(dragging.lineTop!, detail).toBeGreaterThanOrEqual(before.rows[1]!.bottom - 1.5);
    expect(dragging.lineTop!, detail).toBeLessThanOrEqual(before.rows[2]!.top + 1.5);
    expect(Math.abs(dragging.lineTop! - seam), detail).toBeLessThanOrEqual(1.5);
    // 线粗取 focus.width token，左右铺满内容区（用户要的是「落在哪个位置」，不是「半个位置」）。
    expect(dragging.lineHeight!, detail).toBeCloseTo(dragging.focusWidth, 1);
    expect(dragging.lineLeft!, detail).toBeLessThanOrEqual(dragging.contentLeft + 0.5);
    expect(dragging.lineRight!, detail).toBeGreaterThanOrEqual(dragging.contentRight - 0.5);
    await page.screenshot({ path: "results/drag-drop-line.png" });
    // 带着走：只有手里那一行动了，动的量正好等于指针相对起手点走的那段——
    // 抓握点因此始终按在行的同一处，读起来是「我拿着它」，不是「它在原地等我」。
    expect(dragging.rows.filter((row) => row.held), detail).toHaveLength(1);
    expect(Math.abs((dragging.rows[0]!.top - before.rows[0]!.top) - (seam - grabCenter)), detail)
      .toBeLessThanOrEqual(1.5);
    // 整列不跳：横线不占网格轨道，平移只写在 transform 上。所以布局一格没动，
    // 其余行的画面位置也一格没动——次序与行顶都是松手那一拍才改的。
    expect(dragging.order, detail).toEqual(before.order);
    expect(dragging.rows.map((row) => Math.round(row.layoutTop)), detail)
      .toEqual(before.rows.map((row) => Math.round(row.layoutTop)));
    expect(dragging.rows.slice(1).map((row) => Math.round(row.top)), detail)
      .toEqual(before.rows.slice(1).map((row) => Math.round(row.top)));

    await page.mouse.up();
    const after = await measure(page, directoryList);
    expect(after.order, detail).toEqual([titles[1], titles[0], titles[2]]);
    // 松手即收抓握态：手里那一行的位移不留残余，落位动画的起点才是干净的。
    expect(after.rows.filter((row) => row.held), detail).toHaveLength(0);
    expect(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-recent-row]")]
      .filter((node) => node.style.transform !== "")), detail).toHaveLength(0);
    // 松手后横线撤掉，且整行点击不能被浏览器补发的那一击触发（否则只是被搬走却顺带打开了）。
    expect(page.locator('[data-testid="recent-work-drop-line"]')).toHaveCount(0);
    await expect(page).not.toHaveURL(/session=/);

    // 第二拖：把最下面那条拖到「甲 ↔ 乙」之间，落点方向相反。
    await settleSlides(page);
    const mid = await measure(page, directoryList);
    const seam2 = (mid.rows[0]!.bottom + mid.rows[1]!.top) / 2;
    await dragRow(page, `ul[data-recent-list="${directoryList}"]`, 2, seam2);
    const after2 = await measure(page, directoryList);
    expect(after2.order).toEqual([titles[1], titles[2], titles[0]]);

    // 目标分组读的是同一个全局次序：两处必须同步，不能各拖各的。
    const goals = await page.evaluate(() => [...document
      .querySelectorAll<HTMLElement>('ul[data-recent-list^="goal:"] .recent-work-title')].map((node) => node.textContent!));
    expect(goals).toEqual([titles[1], titles[2], titles[0]]);

    // 改序是本机导航偏好：不发任何写请求。
    expect(posts).toEqual([]);
    await expect.poll(() => page.evaluate(() => window.localStorage.getItem("relay.workbench.recentWorkSessionOrder")))
      .toContain(JSON.stringify([sessionIds[1], sessionIds[2], sessionIds[0]]).slice(1, -1));

    // 刷新后仍然记得这个次序（重新连接后读取同一份偏好）。
    await page.reload();
    await connect(page);
    await expect(page.locator(`ul[data-recent-list="${directoryList}"] .recent-work-title`))
      .toHaveText([titles[1], titles[2], titles[0]]);
  });

  test("带着走的那一行浮在列表之上，另一列里的同一会话留在原地", async ({ page }) => {
    const before = await measure(page, directoryList);
    const seam = (before.rows[1]!.bottom + before.rows[2]!.top) / 2;
    const grab = (await page.locator(`ul[data-recent-list="${directoryList}"] [data-recent-row]`)
      .nth(0).locator(".recent-work-item").boundingBox())!;
    await page.mouse.move(grab.x + grab.width / 2, grab.y + grab.height / 2);
    await page.mouse.down();
    await page.mouse.move(grab.x + grab.width / 2, seam, { steps: 8 });

    const held = await page.evaluate((at) => {
      const rows = [...document.querySelectorAll<HTMLElement>("[data-recent-row]")];
      const picked = rows.filter((row) => row.classList.contains("recent-work-row--dragging"));
      const item = picked[0]!.querySelector<HTMLElement>(".recent-work-item")!;
      const ul = document.querySelector<HTMLElement>(`ul[data-recent-list="${at.listKey}"]`)!;
      const line = document.querySelector<HTMLElement>('[data-testid="recent-work-drop-line"]')!;
      // 自定义属性读到的是字面量、计算样式读到的是解析后的值：挂个临时节点把 token 翻成可比的形式。
      const probe = document.createElement("div");
      probe.style.boxShadow = "var(--relay-shadow-floating)";
      probe.style.color = "var(--relay-color-selection-hover)";
      document.body.append(probe);
      const resolved = { floating: getComputedStyle(probe).boxShadow, hover: getComputedStyle(probe).color };
      probe.remove();
      return {
        picked: picked.map((row) => row.dataset.recentRow),
        // 整份左栏只有一行带着位移：目标组里的同一会话不跟着走，它只在落位那一拍滑过去。
        transforms: rows.filter((row) => row.style.transform !== "").length,
        // 指针压着的那一点命中的是被拿起来的这一行，而不是它扫过去的任何一行。
        hit: document.elementFromPoint(at.x, at.y)?.closest<HTMLElement>("[data-recent-row]")?.dataset.recentRow ?? null,
        // 落位线 `pointer-events: none`，hit-test 永远取不到它，所以这里的先后只能按层叠规则断：
        // 这一列自己 z-index:auto 且无 transform（不成层），行与线同属一个上下文，各自的 z-index 说了算。
        sharedContext: getComputedStyle(ul).zIndex === "auto" && getComputedStyle(ul).transform === "none",
        line: Number.parseInt(getComputedStyle(line).zIndex, 10),
        lifted: Number.parseInt(getComputedStyle(picked[0]!).zIndex, 10),
        shadow: getComputedStyle(item).boxShadow, floating: resolved.floating,
        tint: getComputedStyle(item).backgroundColor, hover: resolved.hover
      };
    }, { x: grab.x + grab.width / 2, y: seam, listKey: directoryList });
    const detail = JSON.stringify(held);
    expect(held.picked, detail).toEqual([`session:${sessionIds[0]}`]);
    expect(held.transforms, detail).toBe(1);
    expect(held.hit, detail).toBe(`session:${sessionIds[0]}`);
    expect(held.sharedContext, detail).toBe(true);
    expect(held.line > held.lifted, detail).toBe(true);
    // 浮起用的就是浮层那一档投影与悬停那一档底色：抓握态不引入第三种灰、也不新造一档阴影。
    expect(held.shadow, detail).toBe(held.floating);
    expect(held.tint, detail).toBe(held.hover);
    await page.screenshot({ path: "results/drag-carry.png" });
    // 近拍一张：投影与「横线压在手里的这一行之上」在两列宽的截图里看不出来，只能放大到这一列。
    await page.screenshot({ path: "results/drag-carry-zoom.png", clip: {
      x: grab.x - 12, y: before.rows[0]!.top - 14, width: grab.width + 24,
      height: before.rows[2]!.bottom - before.rows[0]!.top + 56 } });
    await page.mouse.up();
  });

  test("不足阈值的位移仍算点击，落回原格不改顺序", async ({ page }) => {
    const before = await measure(page, directoryList);
    const grab = (await page.locator(`ul[data-recent-list="${directoryList}"] [data-recent-row]`)
      .nth(0).locator(".recent-work-item").boundingBox())!;

    // 2px：还没到起手阈值，仍是「点开这条会话」。
    await page.mouse.move(grab.x + grab.width / 2, grab.y + grab.height / 2);
    await page.mouse.down();
    await page.mouse.move(grab.x + grab.width / 2, grab.y + grab.height / 2 + 2, { steps: 2 });
    await page.mouse.up();
    await expect(page).toHaveURL(/session=66666666-6666-4666-8666-666666666661/);
    expect(await page.evaluate(() => window.localStorage.getItem("relay.workbench.recentWorkSessionOrder"))).toBeNull();

    // 拖出去再落回原来那道缝：顺序不变，也不该写存储——但手里那一行仍要从指针处滑回家，不硬跳。
    await page.goto("/agent");
    await connect(page);
    await expect(page.locator(`ul[data-recent-list="${directoryList}"] [data-recent-row]`)).toHaveCount(3);
    await watchSlides(page);
    const base = await measure(page, directoryList);
    const seam = (base.rows[0]!.bottom + base.rows[1]!.top) / 2;
    const back = (await page.locator(`ul[data-recent-list="${directoryList}"] [data-recent-row]`)
      .nth(0).locator(".recent-work-item").boundingBox())!;
    await page.mouse.move(back.x + back.width / 2, back.y + back.height / 2);
    await page.mouse.down();
    await page.mouse.move(back.x + back.width / 2, seam, { steps: 6 });
    const carry = (await measure(page, directoryList)).rows[0]!.top - base.rows[0]!.top;
    expect(carry, JSON.stringify({ base, seam })).toBeGreaterThan(1);
    await page.mouse.up();
    const after = await measure(page, directoryList);
    expect(after.order).toEqual(before.order);
    expect(await page.evaluate(() => window.localStorage.getItem("relay.workbench.recentWorkSessionOrder"))).toBeNull();
    await page.waitForTimeout(300);
    const slides = await slidesOf(page);
    // 只有被拿着的那一份要滑回家：另一列里的同一会话从没离开过格子，没有位移需要归位。
    // 起点等于手里那一段偏移（松手那一拍量到的），不是「零位移」，也不是整行行距。
    expect(slides.map((slide) => slide.listKey), JSON.stringify({ carry, slides })).toEqual([directoryList]);
    expect(offsetOf(slides[0]!.from), JSON.stringify({ carry, slides })).toBeCloseTo(carry, 0);
  });

  test("任务行与归档区不带拖拽把手", async ({ page }) => {
    // 只有未归档会话所在的列声明 data-reorder-list；任务入口与已归档区起手应落空。
    const lists = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("ul[data-recent-list]")]
      .map((node) => ({ key: node.dataset.recentList!, reorder: node.dataset.reorderList ?? null,
        rows: node.querySelectorAll("[data-recent-row]").length })));
    expect(lists.filter((list) => list.key.startsWith("goal:") || list.key.startsWith("directory:"))
      .every((list) => list.reorder === "session")).toBe(true);
    expect(lists.filter((list) => !list.key.startsWith("goal:") && !list.key.startsWith("directory:"))
      .every((list) => list.reorder === null)).toBe(true);

    await page.getByTestId("recent-work-archived").locator("summary").click();
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll<HTMLElement>("ul[data-recent-list]")]
      .filter((node) => node.dataset.recentList === "archived")
      .map((node) => node.dataset.reorderList ?? null))).toEqual([null]);

    // 真的拖一次归档行：不落横线、不写偏好（拖拽把手只属于未归档会话那一列）。
    const rows = page.locator('ul[data-recent-list="archived"] [data-recent-row]');
    await rows.nth(0).scrollIntoViewIfNeeded();
    const first = (await rows.nth(0).locator(".recent-work-item").boundingBox())!;
    await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
    await page.mouse.down();
    // 归档区在整列下方，指针只往下走 40px（留在视口内，CDP 拒绝视口外坐标）。
    await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2 + 40, { steps: 6 });
    await expect(page.locator('[data-testid="recent-work-drop-line"]')).toHaveCount(0);
    await page.mouse.up();
    expect(await page.evaluate(() => window.localStorage.getItem("relay.workbench.recentWorkSessionOrder"))).toBeNull();
  });

  test("交换在屏幕上看得出来：一段真实位移加一档会自己消失的落位强调", async ({ page }) => {
    await watchSlides(page);
    const { before, seam, carry } = await dragFirstIntoBottomSeam(page);
    // 行距（含 space.0.5 那道缝）是这一列自己量出来的，位移量必须等于它，不能是估的。
    const pitch = before.rows[1]!.top - before.rows[0]!.top;
    expect(pitch).toBeGreaterThan(0);
    // 手里那一行走到的位置：从第 0 格中线到「乙 ↔ 丙」那道缝正中，正好是一行半（1.5 × 34 = 51px）。
    expect(Math.abs(carry - pitch * 1.5), JSON.stringify({ pitch, carry, seam })).toBeLessThanOrEqual(1.5);
    // 等动画跑完再读：滑过的每一帧都记在案，收尾后的 transform 也应归位。
    await page.waitForTimeout(300);
    const slides = await slidesOf(page);
    const detail = JSON.stringify({ pitch, seam, carry, slides });

    // 只有真换位的两条会话滑（目标组与目录组各一份），整列不跟着重播一遍。
    expect([...new Set(slides.map((slide) => slide.key))].sort(), detail)
      .toEqual([`session:${sessionIds[0]}`, `session:${sessionIds[1]}`].sort());
    expect(slides.length, detail).toBeGreaterThanOrEqual(4);
    for (const slide of slides) {
      // 起点是「松手那一拍它所在的位置」，不是「它原来占的格子」：
      // 乙 两处都从上一格起（+pitch）；甲 在另一列里从原格起（−pitch），在被抓着那一列里
      // 从手里起（carry − pitch = +半格）——所以两处都滑进同一格，而手里那一份读起来是「从指间放下去」。
      const expected = slide.key === `session:${sessionIds[1]}` ? pitch
        : slide.listKey === directoryList ? carry - pitch : -pitch;
      expect(offsetOf(slide.from), detail).toBeCloseTo(expected, 0);
      expect(slide.duration, detail).toBe(180);
      expect(slide.easing, detail).toBe("cubic-bezier(0.2, 0, 0, 1)");
      // 播放期间 computed transform 确实在半路上：这证明人眼看到的是滑动，不是瞬间换位。
      const offsets = slide.during.map(tyOf);
      expect(Math.max(...offsets.map(Math.abs)), detail).toBeGreaterThan(Math.abs(expected) * 0.3);
    }
    // 收尾不留在 transform 上：否则整列看着偏了半格，下次测量也不可信。
    expect(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-recent-row]")]
      .map((node) => getComputedStyle(node).transform).filter((value) => value !== "none")), detail).toEqual([]);

    // 落位强调画在刚松手那一条上（两处列表各一份，指向同一条会话），且真的改变了底色。
    const marked = await droppedState(page);
    expect(marked.keys, detail).toEqual([`session:${sessionIds[0]}`]);
    expect(marked.tints.length, detail).toBe(1);
    expect(marked.others, detail).not.toContain(marked.tints[0]);
    // 停留取时间线跳转同一档 motion.emphasis：读完「谁换了位」之前不消失，之后自己收掉。
    await expect
      .poll(() => page.evaluate(() => document.querySelectorAll("[data-recent-dropped]").length), { timeout: 4_000 })
      .toBe(0);
    // 强调收掉后不留残余底色。属性撤掉后仍有 `.recent-work-item` 自己那一档 motion.fast 淡出，
    // 这里等它跑完再读，而不是抢在淡出的第一帧上把「还在收」当成「收不掉」。
    const emphasis = marked.tints[0]!;
    await expect
      .poll(() => page.evaluate((tint) => [...document.querySelectorAll<HTMLElement>(".recent-work-item")]
        .filter((item) => getComputedStyle(item).backgroundColor === tint).length, emphasis),
      { timeout: 4_000, message: detail }).toBe(0);
    const after = await measure(page, directoryList);
    expect(after.order, detail).toEqual([titles[1], titles[0], titles[2]]);
  });

  test.describe("系统要求减少动态效果", () => {
    test.use({ reducedMotion: "reduce" });

    test("不滑行，但落位强调换成静态的一档，不是直接没有回执", async ({ page }) => {
      // 运行期动效开关在启动时按系统解析，减少动态效果就该是 off。
      expect(await page.evaluate(() => document.documentElement.dataset.motion)).toBe("off");
      await watchSlides(page);
      const { before } = await dragFirstIntoBottomSeam(page);
      await page.waitForTimeout(300);

      // 一行都不滑：装饰层整段撤掉。
      expect(await slidesOf(page), JSON.stringify(before)).toEqual([]);
      // 但刚放下的这条仍有底色可指认，且过渡时长被归零（静态高亮，不是渐入渐出）。
      const marked = await droppedState(page);
      expect(marked.keys).toEqual([`session:${sessionIds[0]}`]);
      expect(marked.tints.length).toBe(1);
      expect(marked.others).not.toContain(marked.tints[0]);
      expect(marked.transition).toBe("0s");
      // 回执照旧会收掉，也不会因为少了动画就把次序弄错。
      await expect
        .poll(() => page.evaluate(() => document.querySelectorAll("[data-recent-dropped]").length), { timeout: 4_000 })
        .toBe(0);
      const after = await measure(page, directoryList);
      expect(after.order).toEqual([titles[1], titles[0], titles[2]]);
    });
  });
});
