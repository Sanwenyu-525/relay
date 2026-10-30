import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * 左栏会话行的状态图标（2026-10-30）：真 Chromium 里锁 CSS、动效与几何，
 * 判定与轮询节拍归 tests/recentWorkRunState.spec.ts（jsdom）。
 *
 * 这里锁七件事：
 * ① 八种状态各有自己的图形与状态类；只有运行中在动（三个圆点，0/0.14/0.28s 错峰、
 *    1.1s 一轮、无限循环），完成态只播一次（0.12s、iteration-count 1），其余六态静止。
 * ② 动效只发生在图标内部：行、标题、图标盒子在动画期间逐帧不动，行自身没有动画或位移。
 * ③ 状态翻到终态后，那一行不再有运行中的动画（连拍一拍轮询也不重播）。
 * ④ 八行等高、标题可用宽相同、图标恒 12px；悬停时复选框显形、图标让位，几何不跳。
 * ⑤ 关动效（本机设置）与系统「减少动态效果」都只停动画，形状与状态照旧分得开。
 * ⑥ 窄窗（1024px）下图标尺寸、行高与 1280px 一致，不横向溢出。
 * ⑦ 归档段里的行画归档盒，不是完成对勾。
 *
 * API 全部由 page.route 伪造，不连数据库、不调 Provider。
 */

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = `http://127.0.0.1:${process.env.RELAY_RAIL_TEST_PORT ?? "4173"}`;

const runningId = "77777777-7777-4777-8777-777777777771";
const runningTooId = "77777777-7777-4777-8777-77777777777a";
const pendingId = "77777777-7777-4777-8777-777777777772";
const waitingId = "77777777-7777-4777-8777-777777777775";
const completedId = "77777777-7777-4777-8777-777777777773";
const failedId = "77777777-7777-4777-8777-777777777776";
const cancelledId = "77777777-7777-4777-8777-777777777777";
const notStartedId = "77777777-7777-4777-8777-777777777778";
const archivedId = "77777777-7777-4777-8777-777777777779";

type ListState = "RUNNING" | "PENDING" | "WAITING_APPROVAL" | "COMPLETED" | "FAILED"
  | "CANCELLED" | "NOT_STARTED" | "ARCHIVED";

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: "application/json", headers: cors(),
    body: JSON.stringify(body) });
}

/**
 * 会话行投影。标题长度刻意相近——标题可用宽要能横向比较，只有「状态」这一个变量不同。
 * `run_state` 由 `list_state` 推出（服务端本来就把它当在途子集），夹具里不允许自相矛盾。
 */
function session(id: string, title: string, updatedAt: string, state: ListState,
  status: "ACTIVE" | "ARCHIVED" = "ACTIVE", hasMessages = true): Record<string, unknown> {
  return { id, workspace_id: workspaceId, project_id: null, task_id: null, title,
    status, revision: "1", created_at: updatedAt, updated_at: updatedAt,
    last_message_at: hasMessages ? updatedAt : null, has_messages: hasMessages,
    run_state: state === "RUNNING" || state === "PENDING" ? state : null,
    list_state: state, pinned_at: null, unread_at: null, working_resource_id: null,
    context: { project_goals: [], working_directory: null } };
}

/** 可在用例中途翻转的两条：只改这两个对象，路由每次重读同一份。 */
let runningRow: Record<string, unknown>;
let runningTooRow: Record<string, unknown>;

function resetRows(): void {
  runningRow = session(runningId, "梳理左栏状态的一段讨论", "2026-10-28T06:30:00Z", "RUNNING");
  runningTooRow = session(runningTooId, "另一段同时在跑的讨论", "2026-10-28T06:28:00Z", "RUNNING");
}

const rows = (): Record<string, unknown>[] => [
  runningRow,
  runningTooRow,
  session(pendingId, "排队等着生成的一段讨论", "2026-10-27T04:30:00Z", "PENDING"),
  session(waitingId, "等你确认提案的一段讨论", "2026-10-27T03:30:00Z", "WAITING_APPROVAL"),
  session(completedId, "已经写完回复的一段讨论", "2026-10-26T04:30:00Z", "COMPLETED"),
  session(failedId, "上一轮生成失败的一段讨论", "2026-10-25T05:30:00Z", "FAILED"),
  session(cancelledId, "上一轮被取消的一段讨论", "2026-10-25T04:30:00Z", "CANCELLED"),
  session(notStartedId, "还没开始说的一段讨论", "2026-10-24T04:30:00Z", "NOT_STARTED",
    "ACTIVE", false)
];

const archivedRow = (): Record<string, unknown> =>
  session(archivedId, "早就归档的一段讨论", "2026-10-20T04:30:00Z", "ARCHIVED", "ARCHIVED");

async function installRoutes(page: Page): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/assist-sessions`) {
      const status = url.searchParams.get("status");
      if (status === "ARCHIVED") return fulfillJson(route, { items: [archivedRow()] });
      return fulfillJson(route, { items: rows() });
    }
    const single = /\/assist-sessions\/([^/]+)$/u.exec(path);
    if (single !== null) {
      const row = [...rows(), archivedRow()].find((item) => item.id === single[1]);
      return row === undefined
        ? route.fulfill({ status: 404, contentType: "application/json", headers: cors(),
          body: JSON.stringify({ code: "RESOURCE_NOT_FOUND" }) })
        : fulfillJson(route, row);
    }
    return fulfillJson(route, { items: [], next_cursor: null });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("rail-state-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

async function open(page: Page): Promise<void> {
  resetRows();
  await installRoutes(page);
  await page.goto("/agent");
  await connect(page);
  await expect(page.locator(rowOf(runningId))).toBeVisible();
}

const rowOf = (id: string) => `.recent-work-row:has([data-testid="recent-work-${id}"])`;

interface DotProbe {
  name: string;
  duration: string;
  delay: string;
  iteration: string;
  transform: string;
}

interface Probe {
  tag: string;
  state: string | null;
  className: string;
  /** 布局尺寸（不是 rect）：动画中的图形 rect 会随外接矩形变化，量到的是位移不是盒宽。 */
  width: number;
  height: number;
  rectWidth: number;
  rectHeight: number;
  left: number;
  top: number;
  animationName: string;
  animationDuration: string;
  animationIteration: string;
  color: string;
  visibility: string;
  dots: DotProbe[];
  shapeHtml: string;
  rowAnimation: string;
  rowTransform: string;
  rowHeight: number;
  rowWidth: number;
  titleWidth: number;
  checkboxVisible: boolean;
}

async function probe(page: Page, id: string): Promise<Probe> {
  return page.evaluate((sessionId) => {
    const row = document.querySelector(`.recent-work-row:has([data-testid="recent-work-${sessionId}"])`)!;
    const icon = row.querySelector<SVGElement>(".recent-work-kind")!;
    const style = getComputedStyle(icon);
    const rowBox = row.getBoundingClientRect();
    const iconBox = icon.getBoundingClientRect();
    const title = row.querySelector<HTMLElement>(".recent-work-title")!;
    const checkbox = row.querySelector<HTMLInputElement>(".recent-work-select");
    const rowStyle = getComputedStyle(row as HTMLElement);
    return {
      tag: icon.tagName.toLowerCase(),
      state: icon.dataset.state ?? null,
      className: icon.getAttribute("class") ?? "",
      width: Number.parseFloat(style.width), height: Number.parseFloat(style.height),
      rectWidth: iconBox.width, rectHeight: iconBox.height,
      left: iconBox.left, top: iconBox.top,
      animationName: style.animationName, animationDuration: style.animationDuration,
      animationIteration: style.animationIterationCount, color: style.color,
      visibility: style.visibility,
      // 只数「状态圆点」：Lucide 的钟、圆勾、斜线圆自己也带 <circle>，
      // 那不是动画载体，混进来会把静止图标误判成「有点在动」。
      dots: [...icon.querySelectorAll("circle.recent-work-state-dot")].map((dot) => {
        const dotStyle = getComputedStyle(dot);
        return { name: dotStyle.animationName, duration: dotStyle.animationDuration,
          delay: dotStyle.animationDelay, iteration: dotStyle.animationIterationCount,
          transform: dotStyle.transform };
      }),
      shapeHtml: icon.innerHTML,
      rowAnimation: rowStyle.animationName, rowTransform: rowStyle.transform,
      rowHeight: rowBox.height, rowWidth: rowBox.width,
      titleWidth: title.getBoundingClientRect().width,
      checkboxVisible: checkbox !== null && getComputedStyle(checkbox).display !== "none"
    };
  }, id) as Promise<Probe>;
}

/** 某一行上没有「还在跑」的动画（已完成的一次性动画即使还在列表里，状态也不是 running）。 */
async function runningAnimations(page: Page, id: string): Promise<number> {
  return page.evaluate((sessionId) => {
    const row = document.querySelector(`.recent-work-row:has([data-testid="recent-work-${sessionId}"])`)!;
    return row.getAnimations({ subtree: true }).filter((animation) => animation.playState === "running").length;
  }, id);
}

test("八种状态各画各的图形：只有运行中在动，完成态只播一次", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page);

  const expected: readonly [string, string, string][] = [
    [runningId, "RUNNING", "recent-work-kind--running"],
    [pendingId, "PENDING", "recent-work-kind--pending"],
    [waitingId, "WAITING_APPROVAL", "recent-work-kind--waiting-approval"],
    [completedId, "COMPLETED", "recent-work-kind--completed"],
    [failedId, "FAILED", "recent-work-kind--failed"],
    [cancelledId, "CANCELLED", "recent-work-kind--cancelled"],
    [notStartedId, "NOT_STARTED", "recent-work-kind--not-started"]
  ];
  for (const [id, state, className] of expected) {
    const row = page.locator(rowOf(id));
    await expect(row.locator(".recent-work-kind")).toHaveAttribute("data-state", state);
    await expect(row.locator(".recent-work-kind")).toHaveClass(new RegExp(className));
  }

  // 运行中：三个圆点、错峰 0 / 0.14 / 0.28s、1.1s 一轮、无限循环、对称缓动。
  const running = await probe(page, runningId);
  expect(running.dots).toHaveLength(3);
  expect(running.dots.map((dot) => dot.name)).toEqual(
    ["recent-work-dot", "recent-work-dot", "recent-work-dot"]);
  expect(running.dots.map((dot) => dot.duration)).toEqual(["1.1s", "1.1s", "1.1s"]);
  expect(running.dots.map((dot) => dot.delay)).toEqual(["0s", "0.14s", "0.28s"]);
  expect(running.dots.map((dot) => dot.iteration)).toEqual(["infinite", "infinite", "infinite"]);
  // 图形本身不转：动画只在三个圆点上。
  expect(running.animationName).toBe("none");

  // 完成：一次性收敛，iteration-count 固定 1，时长 0.12s（motion.duration.fast）。
  const completed = await probe(page, completedId);
  expect(completed.animationName).toBe("recent-work-settle");
  expect(completed.animationDuration).toBe("0.12s");
  expect(completed.animationIteration).toBe("1");

  // 其余五态完全静止（不发光、不呼吸、不旋转）。
  for (const id of [pendingId, waitingId, failedId, cancelledId, notStartedId]) {
    const still = await probe(page, id);
    expect(still.animationName).toBe("none");
    expect(still.dots).toHaveLength(0);
  }

  // 形状两两不同：关掉动效、灰度打印也不会混成同一个状态。
  const shapes = await Promise.all([runningId, pendingId, waitingId, completedId, failedId,
    cancelledId, notStartedId].map(async (id) => (await probe(page, id)).shapeHtml));
  expect(new Set(shapes).size).toBe(shapes.length);

  // 颜色只在两处离开中性色：失败用低饱和砖红，待确认用琥珀；其余留在既有前景色两档。
  expect(running.color).toBe("rgb(66, 82, 72)");
  expect((await probe(page, failedId)).color).toBe("rgb(163, 79, 67)");
  expect((await probe(page, waitingId)).color).toBe("rgb(150, 98, 42)");
  expect(completed.color).toBe("rgb(85, 103, 93)");
  expect((await probe(page, pendingId)).color).toBe("rgb(85, 103, 93)");
});

test("三圆点只在图标内部动：行、标题与图标盒子在动画期间不动", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page);

  const first = await probe(page, runningId);
  expect(first.rowAnimation).toBe("none");
  expect(first.rowTransform === "none" || first.rowTransform === "matrix(1, 0, 0, 1, 0, 0)")
    .toBe(true);

  // 4 个采样点覆盖一整轮 1.1s：盒子的位置与尺寸一个都不许变。
  for (const wait of [180, 180, 180, 180]) {
    await page.waitForTimeout(wait);
    const later = await probe(page, runningId);
    expect(later.left).toBe(first.left);
    expect(later.top).toBe(first.top);
    expect(later.width).toBe(first.width);
    expect(later.height).toBe(first.height);
    expect(later.rectWidth).toBe(first.rectWidth);
    expect(later.rectHeight).toBe(first.rectHeight);
    expect(later.rowHeight).toBe(first.rowHeight);
    expect(later.rowWidth).toBe(first.rowWidth);
    expect(later.titleWidth).toBe(first.titleWidth);
  }

  // 反过来证明动画确实在跑：采样期间至少有一个圆点的位移变了。
  const samples: string[][] = [];
  for (let i = 0; i < 6; i += 1) {
    samples.push((await probe(page, runningId)).dots.map((dot) => dot.transform));
    await page.waitForTimeout(90);
  }
  const moved = samples.some((sample, index) => index > 0
    && sample.some((transform, dot) => transform !== samples[index - 1]![dot]));
  expect(moved).toBe(true);

  // 两条同时在跑的会话各自独立地动，不是共用一个动画时钟。
  const second = await probe(page, runningTooId);
  expect(second.dots).toHaveLength(3);
  expect(second.dots.map((dot) => dot.name)).toEqual(
    ["recent-work-dot", "recent-work-dot", "recent-work-dot"]);
});

test("翻到终态后动画立即停止，再轮询也不重播", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page);
  expect(await runningAnimations(page, runningId)).toBeGreaterThan(0);

  // 服务端结算这一轮：左栏在有在途时按 3s 一拍轮询，下一拍就会读到终态。
  runningRow.list_state = "COMPLETED";
  runningRow.run_state = null;
  await expect(page.locator(rowOf(runningId)).locator(".recent-work-kind"))
    .toHaveAttribute("data-state", "COMPLETED", { timeout: 10_000 });

  // 一次性收敛播完就结束：没有无限动画留在这一行。
  await page.waitForTimeout(400);
  expect(await runningAnimations(page, runningId)).toBe(0);
  const settled = await probe(page, runningId);
  expect(settled.animationIteration).toBe("1");

  // 再等一轮轮询（列表仍会重读这一列），完成态不会因此重播。
  await page.waitForTimeout(3600);
  expect(await runningAnimations(page, runningId)).toBe(0);
  expect((await probe(page, runningId)).state).toBe("COMPLETED");
});

test("密集列表不回归：八行等高、标题可用宽相同、图标恒 12px", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page);

  const ids = [runningId, runningTooId, pendingId, waitingId, completedId, failedId, cancelledId];
  const probes = await Promise.all(ids.map(async (id) => probe(page, id)));
  const baseline = probes[0]!;

  for (const item of probes) {
    expect(item.rowHeight).toBe(baseline.rowHeight);
    expect(item.width).toBe(12);
    expect(item.height).toBe(12);
    // 标题长度刻意相近：差 1px 以内才算没有挤压。
    expect(Math.abs(item.titleWidth - baseline.titleWidth)).toBeLessThanOrEqual(1);
  }

  // 「未开始」那一行带一枚既有 caption 徽标（不是状态图标带来的），标题自然短一截；
  // 它只需要证明行高与图标尺寸仍在同一档。
  const notStarted = await probe(page, notStartedId);
  expect(notStarted.rowHeight).toBe(baseline.rowHeight);
  expect(notStarted.width).toBe(12);
  expect(notStarted.height).toBe(12);
});

test("悬停优先级不变：复选框显形时图标让位，行高与标题宽不跳", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page);

  const before = await probe(page, failedId);
  expect(before.checkboxVisible).toBe(false);
  expect(before.visibility).toBe("visible");

  await page.locator(rowOf(failedId)).hover();
  const hovered = await probe(page, failedId);
  expect(hovered.checkboxVisible).toBe(true);
  expect(hovered.visibility).toBe("hidden");
  expect(hovered.width).toBe(before.width);
  expect(hovered.rowHeight).toBe(before.rowHeight);
  expect(Math.abs(hovered.titleWidth - before.titleWidth)).toBeLessThanOrEqual(1);

  // 移开指针恢复：状态与动画都还在（不是重新挂载）。
  await page.mouse.move(640, 40);
  const after = await probe(page, failedId);
  expect(after.visibility).toBe("visible");
  expect(after.state).toBe("FAILED");
});

test("本机关掉动效：动画全停，八种形状与颜色照旧分得开", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => window.localStorage.setItem("relay.motion", "off"));
  await open(page);
  expect(await page.evaluate(() => document.documentElement.dataset.motion)).toBe("off");

  const running = await probe(page, runningId);
  expect(running.animationName).toBe("none");
  expect(running.dots.map((dot) => dot.name)).toEqual(["none", "none", "none"]);
  expect(running.state).toBe("RUNNING");

  const completed = await probe(page, completedId);
  expect(completed.animationName).toBe("none");
  expect(completed.state).toBe("COMPLETED");

  // 停的是动画，不是状态：形状与颜色都还在。
  expect((await probe(page, failedId)).color).toBe("rgb(163, 79, 67)");
  expect((await probe(page, waitingId)).color).toBe("rgb(150, 98, 42)");
});

test("系统减少动态效果：同样全停，状态照旧", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page);

  const running = await probe(page, runningId);
  expect(running.animationName).toBe("none");
  expect(running.dots.map((dot) => dot.name)).toEqual(["none", "none", "none"]);
  expect(running.state).toBe("RUNNING");
  expect((await probe(page, completedId)).animationName).toBe("none");
});

test("窄窗（1024px）：图标尺寸与行高不变，栏内不横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page);
  const wide = await probe(page, runningId);

  await page.setViewportSize({ width: 1024, height: 800 });
  await page.waitForTimeout(200);
  const narrow = await probe(page, runningId);

  expect(narrow.width).toBe(12);
  expect(narrow.height).toBe(12);
  expect(narrow.rowHeight).toBe(wide.rowHeight);
  expect(narrow.state).toBe("RUNNING");
  const overflow = await page.evaluate(() => {
    const rail = document.querySelector(".recent-work") as HTMLElement;
    return rail.scrollWidth - rail.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
});

test("归档段里的行画归档盒，不是完成对勾", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page);

  const section = page.locator('[data-testid="recent-work-archived"]');
  await expect(section).toBeVisible();
  await section.locator("summary").click();
  const archived = page.locator(rowOf(archivedId));
  await expect(archived.locator(".recent-work-kind")).toHaveAttribute("data-state", "ARCHIVED");
  await expect(archived.locator(".lucide-archive")).toHaveCount(1);
  const shape = await probe(page, archivedId);
  expect(shape.animationName).toBe("none");
  // 与完成态不是同一枚图形。
  expect(shape.shapeHtml).not.toBe((await probe(page, completedId)).shapeHtml);
});
