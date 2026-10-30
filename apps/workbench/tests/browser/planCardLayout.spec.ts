import { expect, test, type Page, type Route } from "@playwright/test";

// 计划卡（工作台 §44.1，2026-10-30 改为消息流内的紧凑摘要）的版式与只读边界回归。
// 要锁的不变量：
//   * 卡片只在会话消息流里渲染一次，跟着来源助手消息走；来源消息未加载时才回落到列表末尾；
//   * 摘要先给确切版本、目标、前 3 步与验证，超过 3 步用「查看全部 N 步」，不丢步骤；
//   * 展开才显示全部步骤、范围、验证、待定与版本历史，且不挤压输入框；
//   * 执行绑定这一版的确切 plan_id；只是打开、展开、复制时不发任何写请求；
//   * 390 / 768 / 1280 无横向溢出、动作键不出卡片。
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

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(),
    body: JSON.stringify(body) });
}

const session = { id: sessionId, workspace_id: workspaceId, project_id: null, task_id: null,
  title: "重构登录流程", status: "ACTIVE", revision: "1", conversation_mode: "AGENT",
  chat_mode: "PLAN", working_resource_id: null,
  context: { project_goals: [], working_directory: null },
  created_at: "2026-10-15T00:18:00Z", updated_at: "2026-10-15T00:18:00Z" };

function message(id: string, role: "USER" | "ASSISTANT", content: string, seq: string): unknown {
  return { id, session_id: sessionId, seq, role, status: "COMPLETED", intent: "DISCUSS",
    content, error_code: null, provider_error_kind: null, sources: [], skill: null,
    cancel_requested: false, attachments: [], withdrawn_at: null, withdrawn_by_recall_id: null,
    recall: null, steer_requested: false,
    created_at: "2026-10-15T00:20:00Z", updated_at: "2026-10-15T00:21:00Z",
    usage: { input_tokens: 120, output_tokens: 64, cache_read_tokens: null, cache_creation_tokens: null } };
}

const messages = [
  message("u-1", "USER", "按这个方向把登录流程梳理成计划", "1"),
  message("a-1", "ASSISTANT", "先给出第一版计划。", "2"),
  message("u-2", "USER", "步骤再细一点", "3"),
  message("a-2", "ASSISTANT", "已细化，计划如下。", "4")
];

const planV2 = { plan_id: "plan-2", session_id: sessionId, version: 2, status: "CURRENT",
  goal: "把登录流程拆成可验证的三步：先梳理现状，再收敛接口，最后补回归测试。",
  scope: ["apps/workbench/src/auth", "apps/workbench/tests/auth"],
  steps: [
    { title: "梳理现有登录入口", detail: "列出路由、表单与错误分支，标注重复实现。" },
    { title: "收敛会话与错误处理", detail: "统一 token 读取与过期跳转。" },
    { title: "补齐回归测试", detail: "覆盖登录成功、失败与过期三条路径。" },
    { title: "更新文档", detail: "在认证文档里记录新的入口与行为。" }
  ],
  verification: [
    { statement: "登录成功、失败与过期三条路径的测试通过", method: "AUTOMATED" },
    { statement: "人工走查登录页无重复入口", method: "HUMAN" }
  ],
  open_questions: ["旧登录页是否要保留一个版本的兼容期？"],
  source_message_id: "a-2", created_at: "2026-10-15T00:21:00Z" };
const planV1 = { ...planV2, plan_id: "plan-1", version: 1, status: "SUPERSEDED",
  goal: "先梳理登录现状。", steps: [{ title: "梳理现状", detail: null }],
  source_message_id: "a-1", created_at: "2026-10-15T00:19:00Z" };

type RouteOptions = {
  latest?: Record<string, unknown> | null;
  versions?: readonly Record<string, unknown>[];
  messages?: readonly unknown[];
  onStartGoal?: (body: Record<string, unknown>) => void;
};

async function installRoutes(page: Page, options: RouteOptions = {}): Promise<void> {
  const latest = options.latest === undefined ? planV2 : options.latest;
  const versions = options.versions ?? [planV1, planV2];
  const items = options.messages ?? messages;
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/assist-sessions`) return fulfillJson(route, { items: [session] });
    if (path === `${prefix}/assist-sessions/${sessionId}`) return fulfillJson(route, session);
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`)
      return fulfillJson(route, { items });
    if (path === `${prefix}/assist-sessions/${sessionId}/plans`)
      return fulfillJson(route, { latest, versions });
    if (path === `${prefix}/assist-sessions/${sessionId}/goal`)
      return fulfillJson(route, { goal: null, rounds: [] });
    if (request.method() === "POST" && path === `${prefix}/assist-sessions/${sessionId}/goals`) {
      const body = request.postDataJSON() as Record<string, unknown>;
      options.onStartGoal?.(body);
      return fulfillJson(route, { command_id: String(body.command_id),
        committed_at: "2026-10-30T00:00:00Z", result: { goal: null } });
    }
    return fulfillJson(route, { items: [], next_cursor: null });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("plan-card-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

async function openPlan(page: Page): Promise<void> {
  await page.goto("/agent");
  await connect(page);
  await page.getByTestId(`recent-work-${sessionId}`).first().click();
  await page.waitForLoadState("networkidle");
  // 计划与消息是两条投影：先可能落在末尾回落位，消息读回后移进来源消息的槽。
  await expect(page.getByTestId("plan-card-in-flow")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("plan-card")).toHaveCount(1);
  await expect(page.getByTestId("plan-card-fallback")).toHaveCount(0);
  const box = page.viewportSize() ?? { width: 1280, height: 900 };
  await page.mouse.move(box.width - 8, box.height - 8);
}

test.describe("计划卡消息流版式", () => {
  test("只在来源助手消息下渲染一次：摘要给出版本、目标、前 3 步与验证", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await installRoutes(page);
    await openPlan(page);

    const card = page.getByTestId("plan-card");
    await expect(card).toHaveCount(1);
    // 卡片就是 a-2 这条助手消息槽里的一部分，不是转录区外的独立块。
    await expect(page.locator('li[data-message-id="a-2"] [data-testid="plan-card-in-flow"]'))
      .toHaveCount(1);
    await expect(page.getByTestId("plan-card-title")).toContainText("计划 · 第 2 版");
    await expect(page.getByTestId("plan-card-version-status")).toHaveText("当前版本");
    await expect(page.getByTestId("plan-card-goal"))
      .toContainText("把登录流程拆成可验证的三步");
    const summarySteps = page.getByTestId("plan-card-steps").locator("li");
    await expect(summarySteps).toHaveCount(3);
    await expect(summarySteps.nth(0)).toContainText("梳理现有登录入口");
    await expect(summarySteps.nth(2)).toContainText("补齐回归测试");
    await expect(page.getByTestId("plan-card-steps")).not.toContainText("更新文档");
    await expect(page.getByTestId("plan-card-more-steps")).toHaveText("查看全部 4 步");
    await expect(page.getByTestId("plan-card-verification"))
      .toContainText("登录成功、失败与过期三条路径的测试通过 等 2 项");
    await expect(page.getByTestId("plan-card-copy")).toHaveText("复制计划");
    await expect(page.getByTestId("plan-card-copy"))
      .toHaveAttribute("title", /剪贴板/);
    // 三个动作都有可读名称，焦点可落到按钮上；展开键自带 aria-expanded/controls。
    await expect(page.getByRole("button", { name: "按此计划执行" })).toBeVisible();
    await expect(page.getByRole("button", { name: "展开详情" })).toBeVisible();
    await expect(page.getByRole("button", { name: "复制计划" })).toBeVisible();
    await page.getByTestId("plan-card-toggle").focus();
    await expect(page.getByTestId("plan-card-toggle")).toBeFocused();
    // 摘要默认不展示详情面板与全部步骤。
    await expect(page.getByTestId("plan-card-details")).toHaveCount(0);
    await expect(page.getByTestId("plan-card-all-steps")).toHaveCount(0);

    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "output/plan-goal-v2/after-plan-summary.png" });
    await card.screenshot({ path: "output/plan-goal-v2/after-plan-card.png" });
  });

  test("展开后在消息流里给出全部步骤、范围、验证、待定与版本历史，且不挤压输入框", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await installRoutes(page);
    await openPlan(page);

    const before = await page.evaluate(() => {
      const composer = document.querySelector<HTMLElement>('[data-testid="assist-composer"]')!;
      const transcript = document.querySelector<HTMLElement>('[data-testid="assist-transcript"]')!;
      return { height: composer.getBoundingClientRect().height,
        bottom: composer.getBoundingClientRect().bottom,
        transcriptWidth: transcript.getBoundingClientRect().width };
    });

    const toggle = page.getByTestId("plan-card-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await page.getByTestId("plan-card-more-steps").click();
    await expect(page.getByTestId("plan-card-details")).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("plan-card-more-steps")).toHaveCount(0);

    const card = page.getByTestId("plan-card");
    await expect(card).toHaveCount(1);
    await expect(page.getByTestId("plan-card-all-steps").locator("li")).toHaveCount(4);
    await expect(page.getByTestId("plan-card-all-steps")).toContainText("更新文档");
    await expect(page.getByTestId("plan-card-scope")).toContainText("apps/workbench/src/auth");
    await expect(page.getByTestId("plan-card-verification-list").locator("li")).toHaveCount(2);
    await expect(page.getByTestId("plan-card-verification-list")).toContainText("人工走查");
    await expect(page.getByTestId("plan-card-questions"))
      .toContainText("旧登录页是否要保留一个版本的兼容期？");
    await expect(page.getByTestId("plan-card-details")).toContainText("共 2 版");
    await expect(page.getByTestId("plan-version-1")).toContainText("已被取代");
    await expect(page.getByTestId("plan-version-2")).toContainText("当前有效");

    const after = await page.evaluate(() => {
      const composer = document.querySelector<HTMLElement>('[data-testid="assist-composer"]')!;
      const transcript = document.querySelector<HTMLElement>('[data-testid="assist-transcript"]')!;
      const list = document.querySelector<HTMLElement>(".agent-message-list")!;
      const cardBox = document.querySelector<HTMLElement>('[data-testid="plan-card"]')!.getBoundingClientRect();
      return {
        height: composer.getBoundingClientRect().height,
        bottom: composer.getBoundingClientRect().bottom,
        transcriptWidth: transcript.getBoundingClientRect().width,
        listOverflowX: list.scrollWidth - list.clientWidth,
        cardOverflowX: document.querySelector<HTMLElement>('[data-testid="plan-card"]')!.scrollWidth
          - document.querySelector<HTMLElement>('[data-testid="plan-card"]')!.clientWidth,
        cardInsideTranscript: cardBox.left >= transcript.getBoundingClientRect().left - 0.5
          && cardBox.right <= transcript.getBoundingClientRect().right + 0.5,
        pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth
      };
    });
    const detail = JSON.stringify({ before, after });
    // 展开只让转录区内部变长/滚动，输入框高度与底边不动。
    expect(Math.abs(after.height - before.height), detail).toBeLessThanOrEqual(1);
    expect(Math.abs(after.bottom - before.bottom), detail).toBeLessThanOrEqual(1);
    expect(after.transcriptWidth, detail).toBe(before.transcriptWidth);
    expect(after.listOverflowX, detail).toBeLessThanOrEqual(0);
    expect(after.cardOverflowX, detail).toBeLessThanOrEqual(0);
    expect(after.cardInsideTranscript, detail).toBe(true);
    expect(after.pageOverflowX, detail).toBeLessThanOrEqual(0);

    // 滚动没有被卡片锁死：回到顶部仍能看到第一条消息。
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('[data-testid="assist-transcript"]')!.scrollTop = 0;
    });
    const firstVisible = await page.evaluate(() => {
      const transcript = document.querySelector<HTMLElement>('[data-testid="assist-transcript"]')!;
      const first = document.querySelector<HTMLElement>('li[data-message-id="u-1"]')!;
      const region = transcript.getBoundingClientRect();
      const slot = first.getBoundingClientRect();
      return { topGap: slot.top - region.top, inRegion: slot.top >= region.top - 1
        && slot.bottom <= region.bottom + 1 };
    });
    expect(firstVisible.topGap, JSON.stringify(firstVisible)).toBeLessThanOrEqual(40);
    expect(firstVisible.inRegion, JSON.stringify(firstVisible)).toBe(true);

    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "output/plan-goal-v2/after-plan-details.png" });
    await page.getByTestId("plan-card-toggle").click();
    await expect(page.getByTestId("plan-card-details")).toHaveCount(0);
  });

  test("390 / 768 / 853 / 1024 / 1280：卡片与动作键不出阅读列，页面无横向溢出", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await installRoutes(page);
    await openPlan(page);
    await page.getByTestId("plan-card-toggle").click();
    await expect(page.getByTestId("plan-card-details")).toBeVisible();

    // 853/1024 对应 1280 宽窗口在 150%/125% 浏览器缩放下的 CSS 视口。
    for (const width of [390, 768, 853, 1024, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(120);
      const look = await page.evaluate(() => {
        const transcript = document.querySelector<HTMLElement>('[data-testid="assist-transcript"]')!;
        const card = document.querySelector<HTMLElement>('[data-testid="plan-card"]')!;
        const actions = card.querySelector<HTMLElement>(".goal-plan-actions")!;
        const cardBox = card.getBoundingClientRect();
        const transcriptBox = transcript.getBoundingClientRect();
        const actionBoxes = [...actions.querySelectorAll<HTMLElement>("button")]
          .map((button) => button.getBoundingClientRect());
        return {
          pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          transcriptOverflowX: transcript.scrollWidth - transcript.clientWidth,
          cardOverflowX: card.scrollWidth - card.clientWidth,
          cardInside: cardBox.left >= transcriptBox.left - 0.5
            && cardBox.right <= transcriptBox.right + 0.5,
          actionsInside: actionBoxes.every((box) => box.width > 0
            && box.left >= cardBox.left - 0.5 && box.right <= cardBox.right + 0.5),
          actionCount: actionBoxes.length
        };
      });
      const detail = `${width}: ${JSON.stringify(look)}`;
      expect(look.pageOverflowX, detail).toBeLessThanOrEqual(0);
      expect(look.transcriptOverflowX, detail).toBeLessThanOrEqual(0);
      expect(look.cardOverflowX, detail).toBeLessThanOrEqual(0);
      expect(look.cardInside, detail).toBe(true);
      expect(look.actionsInside, detail).toBe(true);
      expect(look.actionCount, detail).toBe(3);
      if (width === 390) {
        // 窄窗截图从卡片顶部开始：卡比视口高，后续内容靠转录区滚动，不横向溢出。
        await page.evaluate(() => {
          const transcript = document.querySelector<HTMLElement>('[data-testid="assist-transcript"]')!;
          const card = document.querySelector<HTMLElement>('[data-testid="plan-card"]')!;
          transcript.scrollTop += card.getBoundingClientRect().top
            - transcript.getBoundingClientRect().top;
        });
        await page.screenshot({ path: "output/plan-goal-v2/after-plan-narrow.png" });
      }
    }
  });

  test("超长计划目标与步骤说明在摘要内收口，展开后也不横向溢出", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const longText = "把登录流程拆成可验证的多个步骤，先梳理现有入口与会话来源，再统一 token 读取、"
      + "过期跳转和错误文案，随后补齐成功、失败、过期与并发刷新四条回归路径，最后把入口、行为变化"
      + "和回滚办法写进认证文档，并在评审里逐条核对验收依据";
    const longPlan = { ...planV2, goal: longText, steps: planV2.steps.map((step) => ({
      title: `${step.title}（包含现有入口、边界条件与依赖说明）`,
      detail: `${step.detail ?? ""} 同时记录验证方式、失败分支和需要人工确认的取舍。` })) };
    await installRoutes(page, { latest: longPlan, versions: [planV1, longPlan] });
    await openPlan(page);
    await page.setViewportSize({ width: 390, height: 900 });
    await page.waitForTimeout(120);

    const summary = await page.evaluate(() => {
      const card = document.querySelector<HTMLElement>('[data-testid="plan-card"]')!;
      const goal = document.querySelector<HTMLElement>('[data-testid="plan-card-goal"]')!;
      const stepText = card.querySelector<HTMLElement>(".goal-plan-steps .goal-plan-step-text")!;
      const goalStyle = getComputedStyle(goal);
      const stepStyle = getComputedStyle(stepText);
      return {
        goalHeight: goal.getBoundingClientRect().height,
        goalLineHeight: Number.parseFloat(goalStyle.lineHeight),
        stepHeight: stepText.getBoundingClientRect().height,
        stepLineHeight: Number.parseFloat(stepStyle.lineHeight),
        cardOverflowX: card.scrollWidth - card.clientWidth,
        pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth
      };
    });
    const summaryDetail = JSON.stringify(summary);
    expect(summary.goalHeight, summaryDetail).toBeLessThanOrEqual(summary.goalLineHeight * 2 + 1);
    expect(summary.stepHeight, summaryDetail).toBeLessThanOrEqual(summary.stepLineHeight * 2 + 1);
    expect(summary.cardOverflowX, summaryDetail).toBeLessThanOrEqual(0);
    expect(summary.pageOverflowX, summaryDetail).toBeLessThanOrEqual(0);

    await page.getByTestId("plan-card-toggle").click();
    await expect(page.getByTestId("plan-card-details")).toBeVisible();
    const expanded = await page.evaluate(() => {
      const card = document.querySelector<HTMLElement>('[data-testid="plan-card"]')!;
      return { cardOverflowX: card.scrollWidth - card.clientWidth,
        pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    expect(expanded.cardOverflowX, JSON.stringify(expanded)).toBeLessThanOrEqual(0);
    expect(expanded.pageOverflowX, JSON.stringify(expanded)).toBeLessThanOrEqual(0);
  });

  test("没有结构化步骤时明确说明，不生成虚假清单", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const emptyPlan = { ...planV2, steps: [], scope: [], verification: [], open_questions: [] };
    await installRoutes(page, { latest: emptyPlan, versions: [emptyPlan] });
    await openPlan(page);

    await expect(page.getByTestId("plan-card-no-steps"))
      .toHaveText("计划里还没有结构化步骤，先继续讨论要让 Agent 做哪几步。");
    await expect(page.getByTestId("plan-card-steps")).toHaveCount(0);
    await expect(page.getByTestId("plan-card-more-steps")).toHaveCount(0);
    await expect(page.getByTestId("plan-card-verification")).toContainText("尚未指定验证标准");

    await page.getByTestId("plan-card-toggle").click();
    await expect(page.getByTestId("plan-card-all-steps-empty")).toBeVisible();
    await expect(page.getByTestId("plan-card-all-steps")).toHaveCount(0);
    await expect(page.getByTestId("plan-card-details")).toContainText("未指定工作范围");
    await expect(page.getByTestId("plan-card-details")).toContainText("未指定验证方式");
    await expect(page.getByTestId("plan-card-questions")).toHaveCount(0);
    await expect(page.getByTestId("plan-card-details")).toContainText("没有待定事项");
    await expect(page.getByTestId("plan-card")).toHaveCount(1);
  });

  test("来源消息不在已读回的窗口里时，卡片只回落到转录区末尾一次", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const orphan = { ...planV2, source_message_id: "a-not-loaded" };
    await installRoutes(page, { latest: orphan, versions: [planV1, orphan] });
    await page.goto("/agent");
    await connect(page);
    await page.getByTestId(`recent-work-${sessionId}`).first().click();
    await page.waitForLoadState("networkidle");

    await expect(page.getByTestId("plan-card-fallback")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("plan-card")).toHaveCount(1);
    await expect(page.getByTestId("plan-card-in-flow")).toHaveCount(0);
    const placement = await page.evaluate(() => {
      const fallback = document.querySelector<HTMLElement>('[data-testid="plan-card-fallback"]')!;
      const transcript = document.querySelector<HTMLElement>('[data-testid="assist-transcript"]')!;
      return { inTranscript: transcript.contains(fallback),
        afterList: fallback.previousElementSibling?.classList.contains("agent-message-list") ?? false };
    });
    expect(placement.inTranscript).toBe(true);
    expect(placement.afterList).toBe(true);
  });

  test("打开、展开、复制都不写库；执行只提交这一版的确切 plan_id", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const starts: Record<string, unknown>[] = [];
    await installRoutes(page, { onStartGoal: (body) => starts.push(body) });
    const writes: { method: string; path: string; body: string | null }[] = [];
    page.on("request", (request) => {
      if (!request.url().startsWith(apiBase)) return;
      if (["GET", "HEAD", "OPTIONS"].includes(request.method())) return;
      writes.push({ method: request.method(), path: new URL(request.url()).pathname,
        body: request.postData() });
    });

    await openPlan(page);
    await page.getByTestId("plan-card-toggle").click();
    await expect(page.getByTestId("plan-card-details")).toBeVisible();
    await page.getByTestId("plan-card-toggle").click();
    await expect(page.getByTestId("plan-card-details")).toHaveCount(0);
    expect(writes, JSON.stringify(writes)).toEqual([]);

    const response = page.waitForResponse((item) =>
      item.url() === `${apiBase}${prefix}/assist-sessions/${sessionId}/goals`
      && item.request().method() === "POST");
    await page.getByTestId("plan-card-execute").click();
    await response;
    await expect.poll(() => starts.length).toBe(1);
    expect(starts[0]?.plan_id).toBe("plan-2");
    expect(typeof starts[0]?.command_id).toBe("string");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe(`${prefix}/assist-sessions/${sessionId}/goals`);
    await expect(page.getByTestId("plan-card-error")).toHaveCount(0);
  });
});
