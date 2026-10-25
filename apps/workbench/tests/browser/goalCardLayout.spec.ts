import { expect, test, type Page, type Route } from "@playwright/test";

// 目标单行状态条（工作台 §44.2，2026-10-25 收成单行，参照 Codex 的目标行）的版式回归。
// 单行只放「目标图标、状态芯片（文字 + 色点）、目标正文（超长截断）、轮次计数、动作」，
// 细节（成功条件、步骤、轮次历史、说明）全部收进展开区。要锁的不变量：
//   * 状态条紧贴输入卡上方、同宽对齐；收起时恒为单行，正文截断而不是换行；
//   * 展开区内容超过 42vh 时在区内滚动，单行与动作键不被证据挤走；
//   * 成功条件的状态同时有文字与色点（MET/UNMET 用成功/警告文字色）；
//   * 第 0 轮空态不放空壳。
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
  // 点行先换 URL，AssistView 随后按会话 key 重挂载：状态条会短暂卸下再按目标投影挂回。
  // 先等这一轮请求静下来，再等状态条重新可见，避免在重挂载的空窗里量到 null。
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("goal-card")).toBeVisible();
  // 指针停在左栏上会弹出会话摘要浮层，遮住状态条截图和宽度测量。
  await page.mouse.move(900, 700);
}

test.describe("目标单行状态条版式", () => {
  test("收起恒为单行：状态/轮次在行上，正文截断，条贴输入卡上方且同宽", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await installRoutes(page);
    await openGoal(page);

    const look = await page.evaluate(() => {
      const strip = document.querySelector<HTMLElement>('[data-testid="goal-card"]')!;
      const line = strip.querySelector<HTMLElement>(".goal-strip-line")!;
      const objective = strip.querySelector<HTMLElement>('[data-testid="goal-card-objective"]')!;
      const badge = strip.querySelector<HTMLElement>('[data-testid="goal-card-status"]')!;
      const badgeDot = getComputedStyle(badge, "::before");
      const rounds = strip.querySelector<HTMLElement>('[data-testid="goal-card-rounds"]')!;
      const toggle = strip.querySelector<HTMLElement>('[data-testid="goal-card-toggle"]')!;
      const composer = document.querySelector<HTMLElement>('[data-testid="assist-composer"]')!;
      const probe = document.createElement("span");
      document.body.append(probe);
      probe.style.background = "var(--relay-color-bg-subtle)";
      const subtle = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const lineBox = line.getBoundingClientRect();
      const composerBox = composer.getBoundingClientRect();
      return {
        statusText: (badge.textContent ?? "").trim(),
        roundsText: (rounds.textContent ?? "").trim(),
        toggleExpanded: toggle.getAttribute("aria-expanded"),
        badgeDotWidth: Number.parseFloat(badgeDot.width),
        badgeDotBackground: badgeDot.backgroundColor,
        badgeColor: getComputedStyle(badge).color,
        // 单行事实：行高紧凑、正文与轮次不换行。
        lineHeight: lineBox.height,
        objectiveWrapped: objective.getBoundingClientRect().height
          > lineBox.height + 1,
        objectiveClipped: objective.scrollWidth > objective.clientWidth,
        // 状态条贴输入卡上方、同一列宽。
        gapToComposer: composerBox.top - lineBox.bottom,
        widthDelta: Math.abs(lineBox.width - composerBox.width),
        roundsColorIsMuted: getComputedStyle(rounds).color !== getComputedStyle(badge).color,
        subtle,
        overflowX: line.scrollWidth - line.clientWidth
      };
    });

    const detail = JSON.stringify(look);
    expect(look.statusText, detail).toBe("正在推进");
    expect(look.roundsText, detail).toBe("第 2 轮 · 成功条件 1/3");
    expect(look.toggleExpanded, detail).toBe("false");
    // 状态是文字 + 色点，颜色不是唯一线索。
    expect(look.badgeDotWidth, detail).toBeGreaterThanOrEqual(4);
    expect(look.badgeDotBackground, detail).toBe(look.badgeColor);
    // 单行不变量：行高紧凑、正文截断而不是换行。
    expect(look.lineHeight, detail).toBeLessThanOrEqual(48);
    expect(look.objectiveWrapped, detail).toBe(false);
    // 状态条紧贴输入卡上方、同宽对齐（同一 chat-measure 列）。
    expect(look.gapToComposer, detail).toBeGreaterThanOrEqual(0);
    expect(look.gapToComposer, detail).toBeLessThanOrEqual(24);
    expect(look.widthDelta, detail).toBeLessThanOrEqual(1);
    // 收起态不渲染展开区。
    expect(await page.locator('[data-testid="goal-card-details"]').count()).toBe(0);
    // 版式调整不能换来横向溢出。
    expect(look.overflowX, detail).toBeLessThanOrEqual(0);

    await page.getByTestId("goal-card").screenshot({ path: "results/goal-strip-line.png" });
  });

  test("展开区锁事实与色彩，超高内容在区内滚动，单行与动作键不被挤走", async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 640 });
    await installRoutes(page);
    await openGoal(page);
    await page.getByTestId("goal-card-toggle").click();
    await expect(page.getByTestId("goal-card-details")).toBeVisible();

    const read = () => page.evaluate(() => {
      const strip = document.querySelector<HTMLElement>('[data-testid="goal-card"]')!;
      const line = strip.querySelector<HTMLElement>(".goal-strip-line")!;
      const details = strip.querySelector<HTMLElement>('[data-testid="goal-card-details"]')!;
      const pause = strip.querySelector<HTMLElement>('[data-testid="goal-card-pause"]')!;
      const cancel = strip.querySelector<HTMLElement>('[data-testid="goal-card-cancel"]')!;
      const met = strip.querySelector<HTMLElement>('[data-testid="goal-criterion-c1"] .goal-card-criterion-status')!;
      const unmet = strip.querySelector<HTMLElement>('[data-testid="goal-criterion-c2"] .goal-card-criterion-status')!;
      const pending = strip.querySelector<HTMLElement>('[data-testid="goal-criterion-c3"] .goal-card-criterion-status')!;
      const probe = document.createElement("span");
      document.body.append(probe);
      probe.style.color = "var(--relay-color-status-success-text)";
      const success = getComputedStyle(probe).color;
      probe.style.color = "var(--relay-color-status-warning-text)";
      const warning = getComputedStyle(probe).color;
      probe.remove();
      const inViewport = (element: Element) => {
        const box = element.getBoundingClientRect();
        return box.top >= 0 && box.bottom <= window.innerHeight;
      };
      return {
        criterionTexts: [met.textContent ?? "", unmet.textContent ?? "", pending.textContent ?? ""],
        metColor: getComputedStyle(met).color, unmetColor: getComputedStyle(unmet).color,
        pendingColor: getComputedStyle(pending).color, success, warning,
        clientHeight: details.clientHeight, scrollHeight: details.scrollHeight,
        scrollTop: details.scrollTop,
        lineVisible: inViewport(line), pauseVisible: inViewport(pause),
        cancelVisible: inViewport(cancel),
        overflowX: details.scrollWidth - details.clientWidth
      };
    });

    const top = await read();
    const detail = JSON.stringify(top);
    // 条件状态文字必须存在，且 MET/UNMET 各自使用成功/警告文字色；色点同色（CSS ::before currentColor）。
    expect(top.criterionTexts, detail).toEqual(["已达成", "未达成", "待验证"]);
    expect(top.metColor, detail).toBe(top.success);
    expect(top.unmetColor, detail).toBe(top.warning);
    expect(top.pendingColor, detail).not.toBe(top.metColor);
    // 这一档确实触发展开区内部滚动，才谈得上「单行不被挤走」。
    expect(top.scrollHeight, detail).toBeGreaterThan(top.clientHeight);
    expect(top.lineVisible, detail).toBe(true);
    expect(top.pauseVisible, detail).toBe(true);
    expect(top.cancelVisible, detail).toBe(true);
    expect(top.overflowX, detail).toBeLessThanOrEqual(0);

    // 滚到展开区中部：单行与动作键仍在视口里，不跟着证据滚走。
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('[data-testid="goal-card-details"]')!.scrollTop = 80;
    });
    const scrolled = await read();
    expect(scrolled.scrollTop, JSON.stringify(scrolled)).toBeGreaterThan(0);
    expect(scrolled.lineVisible, JSON.stringify(scrolled)).toBe(true);
    expect(scrolled.pauseVisible, JSON.stringify(scrolled)).toBe(true);
    expect(scrolled.cancelVisible, JSON.stringify(scrolled)).toBe(true);

    await page.getByTestId("goal-card").screenshot({ path: "results/goal-strip-expanded.png" });
  });

  // 工单截图就是这一档：第 0 轮、没有步骤与成功条件。空态同样是一条单行，
  // 不因为事实少而退回空壳；展开区只放「目标正文 + 说明」，没有成功条件/步骤的占位。
  test("第 0 轮空态不放空壳：单行仍完整，展开区没有成功条件与步骤占位", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await installRoutes(page);
    await page.route(`${apiBase}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() === "GET" && path === `${prefix}/assist-sessions/${sessionId}/goal`)
        return fulfillJson(route, { goal: emptyGoal, rounds: [] });
      return route.fallback();
    });
    await openGoal(page);
    await page.getByTestId("goal-card-toggle").click();
    await expect(page.getByTestId("goal-card-details")).toBeVisible();

    const look = await page.evaluate(() => {
      const strip = document.querySelector<HTMLElement>('[data-testid="goal-card"]')!;
      const line = strip.querySelector<HTMLElement>(".goal-strip-line")!;
      const rounds = strip.querySelector<HTMLElement>('[data-testid="goal-card-rounds"]')!;
      const objective = strip.querySelector<HTMLElement>('[data-testid="goal-card-objective"]')!;
      return {
        roundsText: (rounds.textContent ?? "").trim(),
        objectiveText: (objective.textContent ?? "").trim(),
        objectiveColor: getComputedStyle(objective).color,
        criteriaCount: strip.querySelectorAll('[data-testid="goal-card-criteria"] li').length,
        steps: strip.querySelector('[data-testid="goal-card-steps"]'),
        note: strip.querySelector('[data-testid="goal-card-note"]'),
        lineHeight: line.getBoundingClientRect().height,
        overflowX: line.scrollWidth - line.clientWidth
      };
    });

    const detail = JSON.stringify(look);
    expect(look.roundsText, detail).toBe("第 0 轮");
    expect(look.objectiveText, detail).toBe("用three.js做一个房子");
    // 空态不渲染成功条件与步骤的空壳；说明仍在展开区。
    expect(look.criteriaCount, detail).toBe(0);
    expect(look.steps, detail).toBeNull();
    expect(look.note, detail).not.toBeNull();
    expect(look.lineHeight, detail).toBeLessThanOrEqual(48);
    expect(look.overflowX, detail).toBeLessThanOrEqual(0);

    await page.getByTestId("goal-card").screenshot({ path: "results/goal-strip-empty.png" });
  });
});
