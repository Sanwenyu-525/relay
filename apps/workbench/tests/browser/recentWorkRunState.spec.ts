import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * 左栏会话行的运行指示（2026-10-28 用户指令）：真 Chromium 里锁 CSS 与几何，
 * 判定与轮询节拍归 tests/recentWorkRunState.spec.ts（jsdom）。
 *
 * 这里锁六件事：
 * ① 运行中＝一段弧，绕自身中心匀速转（animation-name/duration/timing/iteration 逐项核对）；
 *    排队中＝同样大小的点线环，**静止**；两者形状不同，不靠颜色也不靠「有没有在转」区分。
 * ② 旋转只发生在这枚 12px 图形上：行、标题、边框都不动，也没有整行流光。
 * ③ 悬停优先级不变：这一格的复选框显形时，环（和原来的类型图标一样）让位隐藏，
 *    行高与标题宽一像素都不变。
 * ④ 关动效（本机设置）与系统「减少动态效果」都只停旋转，环的形状与颜色照旧——
 *    状态不依赖动效单独表达。
 * ⑤ 密集列表不回归：有运行指示的行与普通行等高，标题可用宽相同。
 * ⑥ 终态那一行没有运行指示，只有原来的类型图标。
 *
 * API 全部由 page.route 伪造，不连数据库、不调 Provider。
 */

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = `http://127.0.0.1:${process.env.RELAY_RAIL_TEST_PORT ?? "4173"}`;

const runningId = "77777777-7777-4777-8777-777777777771";
const pendingId = "77777777-7777-4777-8777-777777777772";
const idleId = "77777777-7777-4777-8777-777777777773";
const secondIdleId = "77777777-7777-4777-8777-777777777774";

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: "application/json", headers: cors(),
    body: JSON.stringify(body) });
}

/**
 * 会话行投影：四条只差 `run_state`。标题长度刻意相近——标题可用宽要能横向比较，
 * 只有「有没有运行指示」这一个变量不同。
 */
function session(id: string, title: string, updatedAt: string,
  runState: "RUNNING" | "PENDING" | null): unknown {
  return { id, workspace_id: workspaceId, project_id: null, task_id: null, title,
    status: "ACTIVE", revision: "1", created_at: updatedAt, updated_at: updatedAt,
    last_message_at: updatedAt, has_messages: true, run_state: runState,
    pinned_at: null, unread_at: null, working_resource_id: null,
    context: { project_goals: [], working_directory: null } };
}

const running = session(runningId, "梳理左栏运行态的一段讨论", "2026-10-27T04:30:00Z", "RUNNING");
const pending = session(pendingId, "排队等着生成的一段讨论", "2026-10-26T04:30:00Z", "PENDING");
const idle = session(idleId, "已经写完回复的一段讨论", "2026-10-25T04:30:00Z", null);
const secondIdle = session(secondIdleId, "另一段已经写完的讨论", "2026-10-24T04:30:00Z", null);

async function installRoutes(page: Page): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    const path = new URL(request.url()).pathname;
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/assist-sessions`) {
      const status = new URL(request.url()).searchParams.get("status");
      if (status === "ARCHIVED") return fulfillJson(route, { items: [] });
      return fulfillJson(route, { items: [running, pending, idle, secondIdle] });
    }
    if (path === `${prefix}/assist-sessions/${runningId}`) return fulfillJson(route, running);
    if (path === `${prefix}/assist-sessions/${pendingId}`) return fulfillJson(route, pending);
    if (path === `${prefix}/assist-sessions/${idleId}`) return fulfillJson(route, idle);
    if (path === `${prefix}/assist-sessions/${secondIdleId}`) return fulfillJson(route, secondIdle);
    return fulfillJson(route, { items: [], next_cursor: null });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("rail-run-state-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

const rowOf = (id: string) => `.recent-work-row:has([data-testid="recent-work-${id}"])`;

/** 这个格里读到的东西：图形、动画、几何。一次 evaluate 取全，避免多次往返拿到中间态。 */
interface Probe {
  tag: string;
  state: string | null;
  width: number;
  height: number;
  animationName: string;
  animationDuration: string;
  animationTiming: string;
  animationIteration: string;
  strokeDasharray: string | null;
  color: string;
  visibility: string;
  /** 行本身（不是那枚图形）有没有动效或位移。 */
  rowAnimation: string;
  rowTransform: string;
  rowHeight: number;
  titleWidth: number;
  checkboxVisible: boolean;
}

async function probe(page: Page, id: string): Promise<Probe> {
  return page.evaluate((sessionId) => {
    const row = document.querySelector(`.recent-work-row:has([data-testid="recent-work-${sessionId}"])`)!;
    const cell = row.querySelector<SVGElement>(".recent-work-kind")!;
    const style = getComputedStyle(cell);
    const rowBox = row.getBoundingClientRect();
    const title = row.querySelector<HTMLElement>(".recent-work-title")!;
    const checkbox = row.querySelector<HTMLInputElement>(".recent-work-select");
    const rowStyle = getComputedStyle(row as HTMLElement);
    return {
      tag: cell.tagName.toLowerCase(),
      state: cell.dataset.runState ?? null,
      // 用**布局尺寸**而不是 rect：旋转中的图形，rect 是外接矩形（12px 的方框转到 45° 会量成 17px），
      // 拿它比「这一格有没有变宽」只会量到转速。
      width: Number.parseFloat(style.width), height: Number.parseFloat(style.height),
      animationName: style.animationName, animationDuration: style.animationDuration,
      animationTiming: style.animationTimingFunction, animationIteration: style.animationIterationCount,
      strokeDasharray: cell.querySelector("circle")?.getAttribute("stroke-dasharray") ?? null,
      color: style.color, visibility: style.visibility,
      rowAnimation: rowStyle.animationName, rowTransform: rowStyle.transform,
      rowHeight: rowBox.height, titleWidth: title.getBoundingClientRect().width,
      checkboxVisible: checkbox !== null && getComputedStyle(checkbox).display !== "none"
    };
    // 泛型参数由调用方按 Probe 声明，这里只返回同形对象。
  }, id) as Promise<Probe>;
}

test("运行中是一段匀速旋转的环，排队中是同尺寸的静止点线环，行本身不转", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await installRoutes(page);
  await page.goto("/agent");
  await connect(page);

  const runningRow = page.locator(rowOf(runningId));
  const runMark = runningRow.locator('[data-testid="recent-work-run-state"]');
  await expect(runMark).toHaveAttribute("data-run-state", "RUNNING");

  const runningProbe = await probe(page, runningId);
  // 匀速：linear + infinite + 1s（token motion.loop.spin）。不加减速、不呼吸。
  expect(runningProbe.animationName).toBe("recent-work-spin");
  expect(runningProbe.animationDuration).toBe("1s");
  expect(runningProbe.animationTiming).toBe("linear");
  expect(runningProbe.animationIteration).toBe("infinite");
  // 只转这枚图形：行没有动画、没有位移。
  expect(runningProbe.rowAnimation).toBe("none");
  expect(runningProbe.rowTransform === "none" || runningProbe.rowTransform === "matrix(1, 0, 0, 1, 0, 0)")
    .toBe(true);

  // 排队中：同尺寸，静止，形状不同（点线 vs 弧）。
  const pendingProbe = await probe(page, pendingId);
  expect(pendingProbe.state).toBe("PENDING");
  expect(pendingProbe.animationName).toBe("none");
  expect(pendingProbe.width).toBe(runningProbe.width);
  expect(pendingProbe.height).toBe(runningProbe.height);
  expect(pendingProbe.strokeDasharray).not.toBe(runningProbe.strokeDasharray);

  // 停住的环仍在原处：尺寸等于 caption 那一档（12px），不是 0（那会让这一格塌掉）。
  expect(runningProbe.width).toBeGreaterThanOrEqual(11);
  expect(runningProbe.width).toBeLessThanOrEqual(13);

  // 终态那一行没有运行指示，只有原来的类型图标。
  const idleRow = page.locator(rowOf(idleId));
  await expect(idleRow.locator('[data-testid="recent-work-run-state"]')).toHaveCount(0);
  await expect(idleRow.locator(".lucide-message-square")).toHaveCount(1);
});

test("密集列表不回归：带运行指示的行与普通行等高、标题可用宽相同", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await installRoutes(page);
  await page.goto("/agent");
  await connect(page);
  await expect(page.locator(rowOf(runningId))).toBeVisible();

  const runningProbe = await probe(page, runningId);
  const pendingProbe = await probe(page, pendingId);
  const idleProbe = await probe(page, idleId);
  const secondIdleProbe = await probe(page, secondIdleId);

  // 行高：四行同一档（标题、未开始、置顶都不参与，运行指示也不参与）。
  expect(runningProbe.rowHeight).toBe(idleProbe.rowHeight);
  expect(pendingProbe.rowHeight).toBe(idleProbe.rowHeight);
  // 标题可用宽：换图形不换列宽。四条标题长度接近，差 1px 以内才算没有挤压。
  expect(Math.abs(runningProbe.titleWidth - secondIdleProbe.titleWidth)).toBeLessThanOrEqual(1);
  expect(Math.abs(pendingProbe.titleWidth - idleProbe.titleWidth)).toBeLessThanOrEqual(1);
  // 图形宽度仍与类型图标同档（12px）：没有为了塞下环而加宽这一格。
  expect(pendingProbe.width).toBe(runningProbe.width);
  expect(runningProbe.width).toBeLessThanOrEqual(13);
});

test("悬停优先级不变：复选框显形时环让位隐藏，行高与标题宽不跳", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await installRoutes(page);
  await page.goto("/agent");
  await connect(page);

  const before = await probe(page, runningId);
  expect(before.checkboxVisible).toBe(false);
  expect(before.visibility).toBe("visible");

  await page.locator(rowOf(runningId)).hover();
  const hovered = await probe(page, runningId);
  // 复选框在悬停时显形；同一格里 12px 图形让位（visibility: hidden，位置与宽度都还在）。
  expect(hovered.checkboxVisible).toBe(true);
  expect(hovered.visibility).toBe("hidden");
  expect(hovered.width).toBe(before.width);
  expect(hovered.rowHeight).toBe(before.rowHeight);
  expect(Math.abs(hovered.titleWidth - before.titleWidth)).toBeLessThanOrEqual(1);

  // 移开指针恢复：环还在转（不是重新挂载，只是可见性回到 visible）。
  await page.mouse.move(640, 40);
  await expect(page.locator(rowOf(runningId)).locator('[data-testid="recent-work-run-state"]'))
    .toHaveAttribute("data-run-state", "RUNNING");
  const after = await probe(page, runningId);
  expect(after.visibility).toBe("visible");
  expect(after.animationName).toBe("recent-work-spin");
});

test("本机关掉动效：环停在原处，形状与颜色不变", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => window.localStorage.setItem("relay.motion", "off"));
  await installRoutes(page);
  await page.goto("/agent");
  await connect(page);

  expect(await page.evaluate(() => document.documentElement.dataset.motion)).toBe("off");
  const stopped = await probe(page, runningId);
  // 只停旋转：图形、尺寸、颜色、形状都还在——「运行中」这件事没有因为关动效而消失。
  expect(stopped.animationName).toBe("none");
  expect(stopped.state).toBe("RUNNING");
  expect(stopped.strokeDasharray).toBeTruthy();
  expect(stopped.width).toBeGreaterThanOrEqual(11);
  // 排队中与运行中仍然分得开：形状不同。
  const pendingStopped = await probe(page, pendingId);
  expect(pendingStopped.strokeDasharray).not.toBe(stopped.strokeDasharray);
});

test("系统减少动态效果：环同样不转，状态照旧", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installRoutes(page);
  await page.goto("/agent");
  await connect(page);

  const stopped = await probe(page, runningId);
  expect(stopped.animationName).toBe("none");
  expect(stopped.state).toBe("RUNNING");
  expect(stopped.strokeDasharray).toBeTruthy();
});
