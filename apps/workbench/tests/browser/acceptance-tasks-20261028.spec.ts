import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// B 组受控 Chromium UI 验收；API 响应由本文件拦截，不连接真实服务或 Provider。
const origin = "http://127.0.0.1:4188";
const out = resolve(import.meta.dirname, "../../output/ui-acceptance-20261028/tasks");
const phase = process.env.RELAY_TASKS_CAPTURE_PHASE ?? "after";
const api = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const taskId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const longTitle = "整理近五年核心文献并形成结构化综述以支撑后续数据分析方法设计以及跨阶段验收依据核对";
const task = { id: taskId, project_id: null, title: longTitle, status: "READY", mode: "ME", revision: "4",
  executor: { kind: "HUMAN", run_id: null }, current_completion_id: null, waiting_reason: null,
  blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [], dependencies: [],
  acceptance: { acceptance_revision: "2", objective: "系统梳理核心研究进展，形成可以独立核对的文献综述。", source: "HUMAN",
    criteria: [{ criterion_id: "c1", statement: "每篇文献包含作者、年份、研究问题、方法、主要结论与局限性，并按主题分类，保留可核对的来源和确切文件版本。", required: true, method: "HUMAN", target_spec: {} }] } };

async function shot(page: Page, name: string) {
  mkdirSync(out, { recursive: true });
  await page.screenshot({ path: resolve(out, `${phase}-${name}.png`), fullPage: true });
}
async function measure(page: Page) {
  return page.evaluate(() => ({ overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    headings: [...document.querySelectorAll("main h1, main h2, main h3, .app-main h1, .app-main h2, .app-main h3")]
      .filter((el) => (el as HTMLElement).offsetWidth > 0).map((el) => ({ text: el.textContent?.slice(0, 90),
        size: getComputedStyle(el).fontSize, width: el.getBoundingClientRect().width })),
    offenders: [...document.querySelectorAll(".app-main *")].filter((el) => {
      const r = el.getBoundingClientRect(); return r.width > 0 && r.right > innerWidth + 1;
    }).slice(0, 12).map((el) => ({ tag: el.tagName, class: el.className, right: el.getBoundingClientRect().right })) }));
}
async function textContrast(page: Page, selector: string) {
  return page.locator(selector).evaluateAll((elements) => {
    const rgb = (value: string) => value.match(/[\d.]+/g)!.slice(0, 3).map(Number);
    const luminance = (value: number[]) => value.map((v) => v / 255).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
      .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i]!, 0);
    return elements.map((el) => {
      let parent: Element | null = el;
      let background = "rgb(255, 255, 255)";
      while (parent) { const color = getComputedStyle(parent).backgroundColor;
        if (color !== "rgba(0, 0, 0, 0)" && color !== "transparent") { background = color; break; } parent = parent.parentElement; }
      const foreground = luminance(rgb(getComputedStyle(el).color)); const back = luminance(rgb(background));
      return { text: el.textContent, ratio: (Math.max(foreground, back) + .05) / (Math.min(foreground, back) + .05) };
    });
  });
}
async function connect(page: Page) {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(api);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("ui-tasks-fixture-token");
  await page.getByTestId("relay-connect").click();
  await expect(page.getByTestId("relay-connection-state").filter({ hasText: "已连接" })).toBeVisible();
  await page.keyboard.press("Escape");
}
async function installApi(page: Page, options: { empty?: boolean; error?: boolean; delay?: number; runStatus?: string; unknown?: boolean } = {}) {
  await page.route(`${api}/**`, async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const headers = { "access-control-allow-origin": origin, "access-control-allow-headers": "Authorization, Content-Type",
      "access-control-allow-methods": "GET, POST, OPTIONS" };
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(body) });
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (path === "/health/ready") return json({ status: "ready" });
    if (path === `${prefix}/projects`) return json({ items: [], next_cursor: null });
    if (path === `${prefix}/tasks`) return json({ items: options.empty ? [] : [task], next_cursor: null });
    if (path === `${prefix}/tasks/${taskId}`) return json(task);
    if (path === `${prefix}/tasks/${taskId}/artifacts`) return json({ items: [], next_cursor: null, current_accepted_version_ids: [] });
    if (path === `${prefix}/tasks/${taskId}/check-plan-preview`) return json({ task_id: taskId, status: "AVAILABLE",
      admission_available: true, frozen_run_plan: false, executed: false, reason_codes: [], check_plan_sha256: "a".repeat(64),
      sources: { task_revision: "4", acceptance_revision: "2", rule_revision: null, workflow_key: "markdown-deliverable-v1", workflow_version: "1", rule_refs: [] },
      check_plan: { policy_version: "1", workflow_key: "markdown-deliverable-v1", workflow_version: "1", entries: [] } });
    if (path === `${prefix}/reviews`) return json({ items: [] });
    if (path.startsWith(`${prefix}/today`)) {
      if (options.delay) await new Promise((resolve) => setTimeout(resolve, options.delay));
      if (options.error) return json({ code: "SERVICE_UNAVAILABLE", detail: "今日计划暂时不可读取" }, 503);
      return json({ date: new URL(route.request().url()).searchParams.get("date") ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date()), timezone: "Asia/Shanghai", selection_revision: "5", focus: null,
        focus_has_eligible_candidate: !options.empty, eligible_items: options.empty ? [] : [{ task_id: taskId, task_revision: "4",
          project_id: null, status: "READY", title: longTitle, priority: "HIGH", due_local_date: null, due_timezone: null,
          later_local_date: null, later_timezone: null, timezone: null, pin: false, reason_codes: ["READY"], evidence_refs: [],
          allowed_actions: ["PIN", "SET_FOCUS", "SET_LATER", "START"] }], waiting_items: [], blocked_pinned_items: [] });
    }
    if (path === `${prefix}/runs/${runId}`) return json({ id: runId, task_id: taskId,
      status: options.runStatus ?? "FAILED", revision: "4", ownership_epoch: "1", retry_of_run_id: null,
      current_step_id: "step-1", wait_reason: null, created_at: "2026-10-28T00:00:00Z", updated_at: "2026-10-28T00:01:00Z", terminal_at: "2026-10-28T00:01:00Z",
      contract: { workflow_key: "markdown-deliverable-v1", workflow_version: "1", execution_config_version: "1", acceptance_revision: "2", contract_hash: "a".repeat(64) },
      current_step: null, steps: [{ step_id: "step-1", step_index: 0, step_kind: "DRAFT", status: "FAILED", started_at: "2026-10-28T00:00:00Z", finished_at: "2026-10-28T00:01:00Z" }],
      recent_attempts: [], result_refs: [], blocking_review_ids: [], pending_control_request: null,
      unresolved_operation_ids: options.unknown ? ["operation-result-unknown"] : [] });
    if (path === `${prefix}/runs/${runId}/reviews`) return json({ items: [] });
    if (path === `${prefix}/runs/${runId}/context-manifests`) return json({ items: [], build: { status: "NOT_STARTED", reason_code: null, message: null } });
    if (path === `${prefix}/runs/${runId}/gateway-operations`) return json({ items: [] });
    if (path === `${prefix}/runs/${runId}/events`) return route.fulfill({ status: 200, contentType: "text/event-stream", headers, body: ": keepalive\n\n" });
    return json({ code: "NOT_STUBBED", detail: path }, 404);
  });
}

test("B 组 fixture 路由：桌面、窄窗和手机布局", async ({ page }) => {
  const reports: unknown[] = [];
  const routes = [["tasks", "/tasks"], ["inbox", "/tasks?tab=inbox"], ["task-detail", "/tasks/task-evaluation-metrics"],
    ["create", "/tasks?view=create"], ["create-light", "/tasks?view=create&light=1"], ["attention-offline", "/tasks?tab=attention"], ["today-offline", "/today"], ["run-offline", "/runs/test-run"]];
  for (const width of [1440, 960, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [name, path] of routes) {
      await page.goto(`${origin}${path}`);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      await page.waitForTimeout(300);
      await shot(page, `${name}-${width}`);
      reports.push({ name, width, ...await measure(page) });
      if (name === "task-detail") {
        expect(await page.getByRole("heading", { name: "任务目标", exact: true }).evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeLessThanOrEqual(14);
        expect(await page.getByRole("tab", { name: "概览" }).evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeLessThanOrEqual(13);
      }
      if (name === "inbox") {
        const contrasts = await textContrast(page, ".inbox-stat-label, .inbox-stat-hint, .inbox-row-facts");
        expect(contrasts.length).toBeGreaterThan(0);
        expect(contrasts.filter((item) => item.ratio < 4.5)).toEqual([]);
      }
    }
  }
  writeFileSync(resolve(out, `${phase}-fixture-layout.json`), JSON.stringify(reports, null, 2));
  expect(reports.filter((r: any) => r.overflow > 1)).toEqual([]);
});

test("B 组 fixture 空态、错误、加载与创建字段校验", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 720 });
  for (const [name, path] of [["tasks-empty", "/tasks?fixture=empty"], ["tasks-error", "/tasks?fixture=load-error"],
    ["inbox-empty", "/tasks?tab=inbox&fixture=empty"], ["inbox-error", "/tasks?tab=inbox&fixture=load-error"],
    ["task-empty", "/tasks/empty"], ["task-error", "/tasks/task-evaluation-metrics?fixture=load-error"]]) {
    await page.goto(`${origin}${path}`);
    await page.waitForTimeout(350);
    await shot(page, name);
    expect((await measure(page)).overflow).toBeLessThanOrEqual(1);
  }
  await page.goto(`${origin}/tasks?fixtureLatency=2500`);
  await expect(page.getByRole("heading", { name: "正在读取任务列表" })).toBeVisible();
  await shot(page, "tasks-loading");
  await page.goto(`${origin}/tasks?view=create`);
  await page.waitForTimeout(300);
  await page.getByTestId("task-create-save").click();
  await expect(page.locator('[aria-invalid="true"]').first()).toBeFocused();
  await shot(page, "create-validation");
  await page.locator('[name="task-title"]').fill("复查本轮页面与交互");
  await page.locator('[name="task-expected-result"]').fill("形成可以核对的验收记录");
  await page.locator('[name="task-acceptance"]').fill("覆盖任务、今日和收件箱\n记录确切截图与未验边界");
  await page.getByTestId("task-create-save").click();
  await expect(page.getByTestId("task-created-result")).toBeVisible();
  await shot(page, "create-success");
});

test("B 组 live UI：今日计划与失败执行", async ({ page }) => {
  const reports: unknown[] = [];
  await installApi(page);
  await page.goto(`${origin}/today`);
  await connect(page);
  await expect(page.getByTestId("today-query")).toBeVisible();
  await expect(page.locator(".today-task").first()).toBeVisible();
  for (const width of [1440, 960, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await shot(page, `today-live-${width}`);
    reports.push({ name: "today", width, ...await measure(page) });
    if (width === 1440) {
      await expect(page.getByTestId("today-rail")).toBeVisible();
      await expect(page.getByTestId("today-review-entry")).toBeHidden();
      expect(await page.getByTestId("today-rail").locator("h2").evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeLessThanOrEqual(14);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  await expect(page.getByTestId("today-rail")).toBeHidden();
  await expect(page.getByTestId("today-review-entry")).toBeVisible();
  await shot(page, "today-css-zoom-200");
  await page.evaluate(() => { document.documentElement.style.zoom = "1"; });
  // 连接仅存于内存；执行页另起文档后重新连接。
  await page.goto(`${origin}/runs/${runId}`);
  await connect(page);
  await expect(page.getByTestId("run-detail")).toBeVisible();
  for (const width of [1440, 960, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await shot(page, `run-failed-${width}`);
    reports.push({ name: "run", width, ...await measure(page) });
    await page.locator(".run-step").first().scrollIntoViewIfNeeded();
    await shot(page, `run-step-${width}`);
    expect(await page.locator(".run-step-title strong").first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeLessThanOrEqual(14);
  }
  writeFileSync(resolve(out, `${phase}-live-layout.json`), JSON.stringify(reports, null, 2));
  expect(reports.filter((r: any) => r.overflow > 1)).toEqual([]);
});

test("B 组 live UI：今日加载、空态、错误和时区校验", async ({ page }) => {
  const options = { empty: true, error: false, delay: 1200 };
  await installApi(page, options);
  await page.goto(`${origin}/today`);
  await connect(page);
  await expect(page.locator(".today-loading")).toBeVisible();
  await shot(page, "today-loading");
  await expect(page.locator(".today-empty")).toBeVisible();
  await shot(page, "today-empty");
  options.error = true; options.delay = 0;
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "读取失败" })).toBeVisible();
  await shot(page, "today-error");
  await page.getByRole("button", { name: "调整时区" }).click();
  await page.getByRole("textbox", { name: "时区名称" }).fill("invalid/timezone");
  await page.getByRole("button", { name: "应用", exact: true }).click();
  await expect(page.locator(".today-query__editor [role=alert]")).toBeVisible();
  await shot(page, "today-timezone-validation");
});

test("B 组 live UI：长任务详情与就地编辑焦点", async ({ page }) => {
  await installApi(page);
  await page.goto(`${origin}/tasks/${taskId}`);
  await connect(page);
  await expect(page.getByTestId("task-detail-page-head")).toContainText(longTitle);
  const open = page.getByTestId("task-acceptance-edit-open");
  await open.click();
  await expect(page.getByTestId("task-acceptance-additions")).toBeFocused();
  await page.getByTestId("task-acceptance-additions").fill("新增人工核对页面长内容与保存反馈");
  await shot(page, "task-detail-edit");
  await page.getByTestId("task-acceptance-cancel").click();
  await expect(open).toBeFocused();
  await page.getByRole("tab", { name: "概览" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "产物", exact: true })).toBeFocused();
  await shot(page, "task-artifacts-empty");
});

test("B 组创建页：200% CSS 内容缩放保持阅读宽度与字段操作", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/tasks?view=create`);
  await expect(page.getByTestId("task-create-save")).toBeVisible();
  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  const dimensions = await page.evaluate(() => {
    const available = document.querySelector(".app-content")!.getBoundingClientRect().width;
    const primary = document.querySelector(".create-task-page > .page-primary")!.getBoundingClientRect().width;
    const input = document.querySelector('[name="task-title"]')!.getBoundingClientRect().width;
    const heading = document.querySelector(".create-task-page h1")!.getBoundingClientRect();
    return { available, primary, input, headingWidth: heading.width, headingHeight: heading.height };
  });
  writeFileSync(resolve(out, `${phase}-create-zoom-dimensions.json`), JSON.stringify(dimensions, null, 2));
  await shot(page, "create-css-zoom-200");
  expect(dimensions.primary).toBeGreaterThan(dimensions.available * .65);
  expect(dimensions.input).toBeGreaterThan(dimensions.primary * .65);
  expect(dimensions.headingWidth).toBeGreaterThan(300);
  await page.locator('[name="task-title"]').fill("缩放后仍可填写任务");
  await expect(page.locator('[name="task-title"]')).toHaveValue("缩放后仍可填写任务");
  await page.getByTestId("task-create-save").scrollIntoViewIfNeeded();
  await expect(page.getByTestId("task-create-save")).toBeInViewport();
});

for (const state of ["PAUSED", "WAITING_APPROVAL", "UNKNOWN"] as const) {
  test(`B 组 live UI：执行 ${state} 可读且不误报成功`, async ({ page }) => {
    await installApi(page, { runStatus: state === "UNKNOWN" ? "PAUSED" : state, unknown: state === "UNKNOWN" });
    await page.goto(`${origin}/runs/${runId}`);
    await connect(page);
    await expect(page.getByTestId("run-detail")).toBeVisible();
    if (state === "UNKNOWN") await expect(page.getByTestId("run-unknown")).toContainText("先按原 operation_id 核对");
    if (state === "PAUSED") await expect(page.getByTestId("run-paused-summary")).toBeVisible();
    await page.setViewportSize({ width: 960, height: 720 });
    await shot(page, `run-${state.toLowerCase()}`);
    expect((await measure(page)).overflow).toBeLessThanOrEqual(1);
  });
}
