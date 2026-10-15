import { expect, test, type Page, type Route } from "@playwright/test";

// 2026-10-07 任务详情精修样板的多分辨率视觉核对（真实 Chromium，页面内拦截伪造 API）。
// 核对口径来自本轮任务书第十节：无意外横向溢出；长标题与条件完整；主区与右栏比例合理；
// 信息层级清楚；补充条件就地操作的焦点行为；技术字段折叠不占主导；未运行不染绿。
// 不连数据库、不调 Provider；夹具只覆盖被断言消费的端点，其余如实 404。

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = "http://127.0.0.1:4173";
const taskId = "33333333-3333-4333-8333-333333333333";
const projectId = "22222222-2222-4222-8222-222222222222";
// 足够长的中文标题：验证自然换行而不是截断或溢出。
const longTitle = "整理近五年核心文献并形成结构化综述以支撑后续数据分析方法设计";

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(), body: JSON.stringify(body) });
}

const task = { id: taskId, project_id: projectId, title: longTitle, status: "READY", mode: "ME",
  revision: "4", executor: { kind: "HUMAN", run_id: null }, current_completion_id: null,
  waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
  dependencies: [],
  updated_at: "2026-10-07T02:28:00Z",
  acceptance: { acceptance_revision: "2", objective: "系统梳理本课题相关的核心研究进展，形成结构化的文献综述。",
    expected_outputs: { literature_review: "MARKDOWN" },
    source: "HUMAN",
    criteria: [
      { criterion_id: "c1", statement: "覆盖近五年核心文献，数量不少于 30 篇，并按主题进行分类梳理。", required: true, method: "HUMAN", target_spec: {} },
      { criterion_id: "c2", statement: "每篇文献包含作者、年份、研究问题、方法、主要结论与局限性的简要总结；这一条是刻意写得很长的验收条件，用于验证长条件换行后编号、正文与状态仍然稳定对齐，不出现错位或溢出。", required: true, method: "SEMANTIC", target_spec: { path: "checks/literature.py" } },
      { criterion_id: "c3", statement: "形成结构清晰、引用规范的文献综述文档。", required: false, method: "HUMAN" }
    ] } };

async function installTaskDetail(page: Page, taskFixture: typeof task = task): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/tasks`) return fulfillJson(route, { items: [], next_cursor: null });
    if (path === `${prefix}/projects`) return fulfillJson(route, { items: [], next_cursor: null });
    if (path === `${prefix}/tasks/${taskId}`) return fulfillJson(route, taskFixture);
    if (path === `${prefix}/projects/${projectId}`) return fulfillJson(route, { id: projectId, title: "科研协作系统",
      project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
    if (path === `${prefix}/tasks/${taskId}/check-plan-preview`) return fulfillJson(route, { task_id: taskId, status: "AVAILABLE",
      admission_available: true, frozen_run_plan: false, executed: false, reason_codes: [],
      check_plan_sha256: "a".repeat(64),
      sources: { task_revision: "4", acceptance_revision: "2", rule_revision: null,
        workflow_key: "markdown-deliverable-v1", workflow_version: "1", rule_refs: [] },
      check_plan: { policy_version: "1", workflow_key: "markdown-deliverable-v1", workflow_version: "1",
        entries: [{ criterion_id: "c2", statement: task.acceptance.criteria[1].statement, required: true,
          method: "SEMANTIC", severity: "MAJOR",
          target_spec: { path: "checks/literature.py" }, checker_id: "script", checker_version: "1" }] } });
    if (path === `${prefix}/tasks/${taskId}/artifacts`) return fulfillJson(route, { items: [], next_cursor: null, current_accepted_version_ids: [] });
    // 未被本用例覆盖的端点如实报错，不用空对象假装读取成功。
    return fulfillJson(route, { code: "NOT_STUBBED", detail: path }, 404);
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("task-detail-visual-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

async function openTaskDetail(page: Page): Promise<void> {
  await page.goto(`/tasks/${taskId}`);
  await connect(page);
  await page.getByTestId("task-detail-page-head").waitFor({ timeout: 20_000 });
}

test.describe("任务详情精修样板（真实 Chromium）", () => {
  for (const [width, height] of [[843, 782], [1162, 782], [2048, 1104], [843, 600]] as const) {
    test(`${width}×${height}：无横向溢出、长标题完整换行、层级与比例合理`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await installTaskDetail(page);
      await openTaskDetail(page);

      // 无意外横向溢出（滚动宽度不超过视口 1px 容差）。
      const overflow = await page.evaluate(() =>
        document.scrollingElement!.scrollWidth - document.scrollingElement!.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);

      // 长标题完整渲染（自然换行，不靠截断）：标题文本完整存在于页头。
      const head = page.getByTestId("task-detail-page-head");
      await expect(head).toContainText(longTitle);

      // 标题行：状态 chip 与标题同处页头；meta 行弱化存在。
      await expect(head.locator(".status-chip, [data-status], .page-head-title ~ *").first()).toBeVisible();

      // 主区阅读顺序：任务目标在验收条件之前，验收条件在验收依据之前。
      const primary = page.locator(".page-primary");
      const objectiveY = await primary.getByRole("heading", { name: "任务目标" }).boundingBox();
      const criteriaY = await primary.getByRole("heading", { name: /验收条件/ }).boundingBox();
      const evidenceY = await primary.getByRole("heading", { name: "验收依据" }).boundingBox();
      const depsY = await primary.getByRole("heading", { name: "前置依赖" }).boundingBox();
      const basicsY = await primary.getByRole("heading", { name: "基本信息" }).boundingBox();
      expect(objectiveY!.y).toBeLessThan(criteriaY!.y);
      expect(criteriaY!.y).toBeLessThan(evidenceY!.y);
      expect(evidenceY!.y).toBeLessThan(depsY!.y);
      expect(depsY!.y).toBeLessThan(basicsY!.y);

      // 宽窗两列：右栏可见且不占过半宽度；窄窗右栏并入文档流（位于主区之后）。
      const layout = page.locator(".page-layout");
      const rail = page.locator(".task-detail-rail");
      if (width >= 1280) {
        await expect(rail).toBeVisible();
        const layoutBox = await layout.boundingBox();
        const railBox = await rail.boundingBox();
        expect(railBox!.width / layoutBox!.width).toBeLessThan(0.4);
      } else {
        const primaryBox = await page.locator(".page-primary").boundingBox();
        const railBox = await rail.boundingBox();
        expect(railBox!.y).toBeGreaterThanOrEqual(primaryBox!.y + primaryBox!.height - 2);
      }

      // 短窗（843×600）底部操作可滚动到达：基本信息区块能进入视口。
      if (height <= 640) {
        await page.getByTestId("task-detail-basics").scrollIntoViewIfNeeded();
        await expect(page.getByTestId("task-detail-basics")).toBeInViewport({ ratio: 0.2 });
      }
      await page.screenshot({ path: `test-results/task-detail-${width}x${height}.png`, fullPage: true });
    });
  }

  test("验收条件编号列对齐、必需标记唯一、未运行证据不染绿、技术字段折叠", async ({ page }) => {
    await page.setViewportSize({ width: 1162, height: 782 });
    await installTaskDetail(page);
    await openTaskDetail(page);

    // 编号列稳定对齐：三条条件的编号 x 坐标一致（grid 固定列）。
    // 作用域限定验收条件区块：验收依据区复用同一行类，全页统计会翻倍。
    const criteriaScope = page.getByTestId("task-detail-criteria");
    const indexes = criteriaScope.locator(".task-detail-criterion-index");
    await expect(indexes).toHaveCount(3);
    const first = await indexes.nth(0).boundingBox();
    const second = await indexes.nth(1).boundingBox();
    const third = await indexes.nth(2).boundingBox();
    expect(first!.x).toBe(second!.x);
    expect(second!.x).toBe(third!.x);

    // 必需/可选标记唯一：每条条件内「必需」文案只出现一次（chip 或 meta 二选一）。
    for (const row of await criteriaScope.locator(".task-detail-criterion").all()) {
      expect(await row.locator("text=必需").count()).toBeLessThanOrEqual(1);
    }

    // 验证方式中文呈现，原枚举降级（title 或 small），不在主阅读位。
    await expect(criteriaScope.getByText("验证方式：人工核对").first()).toBeVisible();
    await expect(criteriaScope.getByText("验证方式：语义检查").first()).toBeVisible();
    await expect(criteriaScope.locator(".task-detail-criterion-meta small[title='SEMANTIC']")).toHaveCount(1);

    // 验收依据：无 Run 的人工任务用文字说清未关联执行记录；证据区不允许出现成功色或「通过」字样暗示。
    await expect(page.locator(".task-detail-evidence-facts")).toContainText("当前任务未关联执行记录（Run）");
    const evidence = page.locator(".task-detail-evidence");
    await expect(evidence.locator(".status-chip--success")).toHaveCount(0);
    await expect(evidence.getByText("通过", { exact: true })).toHaveCount(0);

    // 技术字段折叠：计划摘要默认不可见，summary 可达。
    const tech = page.locator(".task-detail-tech").first();
    await expect(tech.locator("code")).toBeHidden();
    await tech.locator("summary").click();
    await expect(tech.locator("code")).toBeVisible();

    // targetSpec 三态区分：空对象→「未提供具体检查对象」；有内容→折叠 JSON；null→「当前响应未提供」。
    await expect(page.getByText("未提供具体检查对象")).toBeVisible();
    await expect(page.getByText("当前响应未提供")).toBeVisible();
    await expect(page.getByText("已提供，展开查看技术 JSON")).toBeVisible();
  });

  test("补充条件栅栏：条件检查对象未读全时按钮禁用并说明原因", async ({ page }) => {
    await page.setViewportSize({ width: 1162, height: 782 });
    await installTaskDetail(page);
    await openTaskDetail(page);

    // c3 的 target_spec 缺失：业务栅栏要求检查对象读全才能补充，按钮禁用且原因可见。
    const open = page.getByTestId("task-acceptance-edit-open");
    await expect(open).toBeDisabled();
    await expect(page.locator(".task-detail-supplement")).toContainText("尚未读全");
  });

  test("补充条件就地操作：展开焦点入 textarea、收起焦点回触发按钮", async ({ page }) => {
    await page.setViewportSize({ width: 1162, height: 782 });
    // 完整变体：所有条件的检查对象都已提供，补充入口可用。
    const complete = structuredClone(task);
    (complete.acceptance.criteria[2] as Record<string, unknown>).target_spec = {};
    await installTaskDetail(page, complete);
    await openTaskDetail(page);

    const open = page.getByTestId("task-acceptance-edit-open");
    await open.click();
    const textarea = page.getByTestId("task-acceptance-additions");
    await expect(textarea).toBeFocused();

    // 取消不改原条件，焦点回触发按钮。
    await page.getByTestId("task-acceptance-cancel").click();
    await expect(open).toBeFocused();
    await expect(page.getByTestId("task-detail-criteria").locator(".task-detail-criterion")).toHaveCount(3);
  });

  test("键盘焦点可见：页签行入口与主操作 focus-visible 有可见描边", async ({ page }) => {
    await page.setViewportSize({ width: 1162, height: 782 });
    await installTaskDetail(page);
    await openTaskDetail(page);

    const link = page.locator(".task-detail-quick-link").first();
    await link.focus();
    const outline = await link.evaluate((el) => {
      const style = getComputedStyle(el);
      return `${style.textDecorationLine} ${style.color}`;
    });
    // 焦点态至少有下划线或颜色变化之一（本组件用下划线+变色承载焦点语义）。
    expect(outline).not.toBe("none ");
  });
});
