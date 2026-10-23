import { expect, test, type Page, type Route } from "@playwright/test";

// 目标卡（工作台 §44.2）的版式回归。DEV-0103（2026-10-22）把「整块同字号」收成
// 标题带 / 目标正文 / 可展开事实三层：目标正文必须达到正文档，状态与轮次是标题带上的
// 两枚轻芯片，成功条件的状态同时有文字与色点，动作行用分隔线收口并把说明推到右端。
// 另外卡片内容超过 42vh 时在卡内滚动，暂停/取消必须 sticky 停在卡底，不能被证据挤出去。
// API 全部由 page.route 伪造，不连数据库、不调 Provider。

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = `http://127.0.0.1:${process.env.RELAY_RAIL_TEST_PORT ?? "4173"}`;
const sessionId = "66666666-6666-4666-8666-666666666662";

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: "application/json", headers: cors(),
    body: JSON.stringify(body) });
}

function session(title: string): unknown {
  return { id: sessionId, workspace_id: workspaceId, project_id: null, task_id: null, title,
    status: "ACTIVE", revision: "1", created_at: "2026-10-15T00:18:00Z",
    updated_at: "2026-10-15T00:18:00Z", pinned_at: null, unread_at: null,
    working_resource_id: null,
    context: { project_goals: [], working_directory: null } };
}

const goal = {
  goal_id: "44444444-4444-4444-8444-444444444444", session_id: sessionId,
  objective: "用three.js做一个房子", status: "ACTIVE", current_step: "搭建场景与相机",
  progress: "已完成地基与墙体，正在加屋顶。", stop_reason: null,
  criteria: [
    { key: "c1", statement: "页面打开能看到一栋房子", status: "MET", evidence: "本地截图", required: true },
    { key: "c2", statement: "屋顶与门窗完整", status: "UNMET", evidence: null, required: true },
    { key: "c3", statement: "支持鼠标旋转视角", status: "PENDING", evidence: null, required: false }
  ],
  steps: [{ title: "搭建场景与相机", status: "DOING" }, { title: "建房子", status: "DONE" }],
  round_count: 2, no_progress_rounds: 0, plan_version_id: null, plan_version: null,
  last_round_at: "2026-10-21T10:00:00Z",
  actions: { pause: true, cancel: true, resume: false, confirm_completion: false },
  revision: "3", created_at: "2026-10-21T08:00:00Z", updated_at: "2026-10-21T10:00:00Z"
};

const emptyGoal = { ...goal, current_step: null, progress: null, criteria: [], steps: [],
  round_count: 0 };

async function installRoutes(page: Page): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/assist-sessions`)
      return fulfillJson(route, { items: [session("用 three.js 做一栋房子")] });
    if (path === `${prefix}/assist-sessions/${sessionId}`)
      return fulfillJson(route, session("用 three.js 做一栋房子"));
    if (path === `${prefix}/assist-sessions/${sessionId}/goal`)
      return fulfillJson(route, { goal, rounds: [
        { round_index: 1, outcome: "CONTINUE", note: "已立墙", created_at: "2026-10-21T09:00:00Z" },
        { round_index: 2, outcome: "CONTINUE", note: "正在加屋顶", created_at: "2026-10-21T10:00:00Z" }
      ] });
    if (path === `${prefix}/assist-sessions/${sessionId}/plans`)
      return fulfillJson(route, { latest: null, versions: [] });
    return fulfillJson(route, { items: [], next_cursor: null });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("goal-card-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

async function openGoal(page: Page): Promise<void> {
  await page.goto("/agent");
  await connect(page);
  await page.getByTestId(`recent-work-${sessionId}`).first().click();
  // 点行先换 URL，AssistView 随后按会话 key 重挂载：卡片会短暂卸下再按目标投影挂回。
  // 先等这一轮请求静下来，再等卡片重新可见，避免在重挂载的空窗里量到 null。
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("goal-card")).toBeVisible();
  // 指针停在左栏上会弹出会话摘要浮层，遮住卡片截图和宽度测量。
  await page.mouse.move(900, 700);
}

test.describe("目标卡版式", () => {
  test("目标正文升为正文档，状态/轮次是标题带芯片，动作行收口且说明右对齐", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await installRoutes(page);
    await openGoal(page);

    const look = await page.evaluate(() => {
      const card = document.querySelector<HTMLElement>('[data-testid="goal-card"]')!;
      const objective = card.querySelector<HTMLElement>('[data-testid="goal-card-objective"]')!;
      const badge = card.querySelector<HTMLElement>('[data-testid="goal-card-status"]')!;
      const badgeDot = getComputedStyle(badge, "::before");
      const rounds = card.querySelector<HTMLElement>('[data-testid="goal-card-rounds"]')!;
      const actions = card.querySelector<HTMLElement>(".goal-plan-actions")!;
      const note = card.querySelector<HTMLElement>('[data-testid="goal-card-note"]')!;
      const met = card.querySelector<HTMLElement>('[data-testid="goal-criterion-c1"] .goal-card-criterion-status')!;
      const unmet = card.querySelector<HTMLElement>('[data-testid="goal-criterion-c2"] .goal-card-criterion-status')!;
      const pending = card.querySelector<HTMLElement>('[data-testid="goal-criterion-c3"] .goal-card-criterion-status')!;
      const probe = document.createElement("span");
      document.body.append(probe);
      probe.style.background = "var(--relay-color-bg-subtle)";
      const subtle = getComputedStyle(probe).backgroundColor;
      probe.style.color = "var(--relay-color-status-success-text)";
      const success = getComputedStyle(probe).color;
      probe.style.color = "var(--relay-color-status-warning-text)";
      const warning = getComputedStyle(probe).color;
      probe.remove();
      const cardBox = card.getBoundingClientRect();
      const noteBox = note.getBoundingClientRect();
      const inlinePadding = Number.parseFloat(getComputedStyle(card).paddingRight);
      return {
        objectiveFont: Number.parseFloat(getComputedStyle(objective).fontSize),
        objectiveWeight: Number.parseInt(getComputedStyle(objective).fontWeight, 10),
        bodyFont: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
        badgeDotWidth: Number.parseFloat(badgeDot.width),
        badgeDotBackground: badgeDot.backgroundColor,
        badgeColor: getComputedStyle(badge).color,
        roundsBackground: getComputedStyle(rounds).backgroundColor,
        subtle,
        actionsBorderTop: Number.parseFloat(getComputedStyle(actions).borderTopWidth),
        noteRightInset: cardBox.right - inlinePadding - noteBox.right,
        noteTextAlign: getComputedStyle(note).textAlign,
        // 成功条件的状态既有文字也有同色圆点；三种状态分别取成功/警告/静默三档。
        criterionTexts: [met.textContent ?? "", unmet.textContent ?? "", pending.textContent ?? ""],
        metColor: getComputedStyle(met).color, unmetColor: getComputedStyle(unmet).color,
        pendingColor: getComputedStyle(pending).color, success, warning,
        overflowX: card.scrollWidth - card.clientWidth
      };
    });

    const detail = JSON.stringify(look);
    // 目标是这张卡的主信息：16px（body）且中等字重，不再和辅助行同为 14px 常规。
    expect(look.objectiveFont, detail).toBeCloseTo(look.bodyFont, 1);
    expect(look.objectiveWeight, detail).toBeGreaterThanOrEqual(500);
    // 状态是文字 + 色点，颜色不是唯一线索。
    expect(look.badgeDotWidth, detail).toBeGreaterThanOrEqual(4);
    expect(look.badgeDotBackground, detail).toBe(look.badgeColor);
    expect(look.roundsBackground, detail).toBe(look.subtle);
    // 动作行与事实之间有一条分隔线，说明压到内容盒右缘。
    expect(look.actionsBorderTop, detail).toBeGreaterThanOrEqual(1);
    expect(look.noteRightInset, detail).toBeLessThan(2);
    expect(look.noteTextAlign, detail).toBe("end");
    // 条件状态文字必须存在，且 MET/UNMET 各自使用成功/警告文字色。
    expect(look.criterionTexts, detail).toEqual(["已达成", "未达成", "待验证"]);
    expect(look.metColor, detail).toBe(look.success);
    expect(look.unmetColor, detail).toBe(look.warning);
    expect(look.pendingColor, detail).not.toBe(look.metColor);
    // 版式调整不能换来横向溢出。
    expect(look.overflowX, detail).toBeLessThanOrEqual(0);

    await page.getByTestId("goal-card").screenshot({ path: "results/goal-card-layout.png" });
  });

  test("窄窗卡内滚动时暂停/取消 sticky 停在卡底，不被证据挤出视口", async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 900 });
    await installRoutes(page);
    await openGoal(page);

    const read = () => page.evaluate(() => {
      const card = document.querySelector<HTMLElement>('[data-testid="goal-card"]')!;
      const actions = card.querySelector<HTMLElement>(".goal-plan-actions")!;
      const pause = card.querySelector<HTMLElement>('[data-testid="goal-card-pause"]')!;
      const cancel = card.querySelector<HTMLElement>('[data-testid="goal-card-cancel"]')!;
      const cardBox = card.getBoundingClientRect();
      const actionBox = actions.getBoundingClientRect();
      const within = (element: Element) => {
        const box = element.getBoundingClientRect();
        return box.top >= cardBox.top - 1 && box.bottom <= cardBox.bottom + 1;
      };
      return {
        clientHeight: card.clientHeight, scrollHeight: card.scrollHeight,
        scrollTop: card.scrollTop,
        position: getComputedStyle(actions).position,
        actionsVisible: actionBox.top >= cardBox.top - 1 && actionBox.bottom <= cardBox.bottom + 1,
        pauseVisible: within(pause), cancelVisible: within(cancel),
        overflowX: card.scrollWidth - card.clientWidth
      };
    });

    const top = await read();
    const detail = JSON.stringify(top);
    // 这一档确实触发卡内滚动，才谈得上 sticky。
    expect(top.scrollHeight, detail).toBeGreaterThan(top.clientHeight);
    expect(top.position, detail).toBe("sticky");
    expect(top.actionsVisible, detail).toBe(true);
    expect(top.pauseVisible, detail).toBe(true);
    expect(top.cancelVisible, detail).toBe(true);
    expect(top.overflowX, detail).toBeLessThanOrEqual(0);

    // 滚到卡内中部：控制键仍贴着卡底，不跟着证据滚走。
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('[data-testid="goal-card"]')!.scrollTop = 120;
    });
    const scrolled = await read();
    expect(scrolled.scrollTop, JSON.stringify(scrolled)).toBeGreaterThan(0);
    expect(scrolled.actionsVisible, JSON.stringify(scrolled)).toBe(true);
    expect(scrolled.pauseVisible, JSON.stringify(scrolled)).toBe(true);
    expect(scrolled.cancelVisible, JSON.stringify(scrolled)).toBe(true);

    await page.getByTestId("goal-card").screenshot({ path: "results/goal-card-layout-narrow.png" });
  });

  // 工单截图就是这一档：第 0 轮、没有步骤与成功条件。空态同样按三层排，
  // 不因为事实少而退回一整块同字号；轮次与动作说明仍分别落在标题带右端与动作行右端。
  test("第 0 轮空态不放空壳：目标正文仍为主信息，轮次与动作说明各在右端", async ({ page }) => {
    await page.setViewportSize({ width: 2000, height: 900 });
    await installRoutes(page);
    await page.route(`${apiBase}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() === "GET" && path === `${prefix}/assist-sessions/${sessionId}/goal`)
        return fulfillJson(route, { goal: emptyGoal, rounds: [] });
      return route.fallback();
    });
    await openGoal(page);

    const look = await page.evaluate(() => {
      const card = document.querySelector<HTMLElement>('[data-testid="goal-card"]')!;
      const objective = card.querySelector<HTMLElement>('[data-testid="goal-card-objective"]')!;
      const rounds = card.querySelector<HTMLElement>('[data-testid="goal-card-rounds"]')!;
      const note = card.querySelector<HTMLElement>('[data-testid="goal-card-note"]')!;
      const cardBox = card.getBoundingClientRect();
      const noteBox = note.getBoundingClientRect();
      const inlinePadding = Number.parseFloat(getComputedStyle(card).paddingRight);
      return {
        objectiveFont: Number.parseFloat(getComputedStyle(objective).fontSize),
        objectiveWeight: Number.parseInt(getComputedStyle(objective).fontWeight, 10),
        roundsText: (rounds.textContent ?? "").trim(),
        criteriaCount: card.querySelectorAll('[data-testid="goal-card-criteria"] li').length,
        steps: card.querySelector('[data-testid="goal-card-steps"]'),
        noteRightInset: cardBox.right - inlinePadding - noteBox.right,
        actionsVisible: card.querySelector<HTMLElement>(".goal-plan-actions")!
          .getBoundingClientRect().height > 0,
        objectiveColor: getComputedStyle(objective).color,
        overflowX: card.scrollWidth - card.clientWidth
      };
    });

    const detail = JSON.stringify(look);
    expect(look.objectiveFont, detail).toBeGreaterThanOrEqual(16);
    expect(look.objectiveWeight, detail).toBeGreaterThanOrEqual(500);
    expect(look.roundsText, detail).toBe("第 0 轮");
    // 空态不渲染成功条件与步骤的空壳。
    expect(look.criteriaCount, detail).toBe(0);
    expect(look.steps, detail).toBeNull();
    expect(look.actionsVisible, detail).toBe(true);
    expect(look.noteRightInset, detail).toBeLessThan(2);
    expect(look.overflowX, detail).toBeLessThanOrEqual(0);

    await page.getByTestId("goal-card").screenshot({ path: "results/goal-card-layout-empty.png" });
  });
});
