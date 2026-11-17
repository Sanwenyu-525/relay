import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 2026-11-15 任务页专项（UI + 后端）浏览器验收：受控 Chromium，API 响应由本文件拦截。
 * 覆盖 7 个视口：状态列原因可读、BLOCKED 分说前置任务与阻塞、归档后缀、
 * 窄窗行卡片不丢列信息、范围入口与页签同行、刷新失败保留旧内容。
 * 证据写进仓库 tmp/tasks-ui-backend-20261115/（截图 + 几何与对比度 JSON）。
 */
const origin = `http://127.0.0.1:${process.env.RELAY_E2E_PORT ?? "4173"}`;
const out = resolve(import.meta.dirname, "../../../../tmp/tasks-ui-backend-20261115");
const api = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const projectA = "22222222-2222-4222-8222-222222222222";
const projectB = "33333333-3333-4333-8333-333333333333";
const created = "2026-11-15T00:00:00.000Z";
const viewports = [
  { width: 2048, height: 1104 },
  { width: 1660, height: 895 },
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
  { width: 900, height: 640 },
  { width: 390, height: 844 },
] as const;

const longReasonTask = { id: "task-long-reason",
  title: "整理近五年核心文献并形成结构化综述以支撑后续数据分析方法设计与跨阶段验收依据核对",
  project_id: projectA, status: "WAITING", mode: "DELEGATE_AI", revision: "4",
  executor: { kind: "AI", run_id: "run-1" }, current_completion_id: null,
  waiting_reason: "ACTION_APPROVAL_REQUIRED", blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: ["CANCEL"] };
const humanToolTask = { ...longReasonTask, id: "task-human-tool", title: "工具适配待处理", mode: "AI_ASSIST",
  waiting_reason: "HUMAN_TOOL" };
const pausedTask = { ...longReasonTask, id: "task-paused", title: "暂停在第三步", project_id: projectB,
  executor: { kind: "AI", run_id: "run-3" }, waiting_reason: "PAUSED_BY_USER" };
const unknownReasonTask = { ...longReasonTask, id: "task-unknown", title: "服务端新增的等待原因",
  waiting_reason: "SOME_NEW_REASON" };
const blockedTask = { ...longReasonTask, id: "task-blocked", title: "两样都卡住的复核任务", status: "BLOCKED",
  mode: "ME", executor: { kind: "HUMAN", run_id: null }, waiting_reason: null,
  blocking_task_ids: ["dep-1", "dep-2"], unresolved_blocker_ids: ["blocker-1"], allowed_actions: [] };
const readyTask = { ...longReasonTask, id: "task-ready", title: "可以开始的任务", status: "READY", mode: "ME",
  executor: { kind: "HUMAN", run_id: null }, waiting_reason: null, allowed_actions: ["EDIT_PRESENTATION", "START"] };
const rows = [longReasonTask, humanToolTask, pausedTask, unknownReasonTask, blockedTask, readyTask];
const projects = [
  { id: projectA, title: "文献综述项目", project_type: "THESIS", archived_at: null, archive_status: "ACTIVE",
    revision: "2", state_revision: "3", phase_key: "WRITING", next_action_task_id: null,
    created_at: created, updated_at: created },
  { id: projectB, title: "工具链改造", project_type: "DEVELOPMENT", archived_at: created, archive_status: "ARCHIVED",
    revision: "2", state_revision: "3", phase_key: "PLANNING", next_action_task_id: null,
    created_at: created, updated_at: created }
];

async function shot(page: Page, name: string) {
  mkdirSync(out, { recursive: true });
  await page.screenshot({ path: resolve(out, `${name}.png`), fullPage: true });
}

async function measure(page: Page) {
  return page.evaluate(() => {
    const rect = (el: Element) => el.getBoundingClientRect();
    const rows = [...document.querySelectorAll<HTMLElement>(".data-row--tasks:not(.data-row--head)")];
    const reasons = [...document.querySelectorAll<HTMLElement>(".data-cell-reason")];
    const header = document.querySelector<HTMLElement>(".task-table thead");
    return { overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      rows: rows.length,
      // 窄窗 thead 用 clip 隐藏（保留辅助技术语义），所以按「有可读面积」判断视觉是否展示。
      headerVisible: header !== null && rect(header).height > 20 && rect(header).width > 100,
      reasons: reasons.map((el) => {
        const style = getComputedStyle(el);
        return { text: el.textContent ?? "", width: Math.round(rect(el).width),
          lines: Math.round((rect(el).height + 0.5) / parseFloat(style.lineHeight)),
          // 两行上限生效时 scrollHeight 会大于可见高度；超出说明被截断，需有 title 兜底。
          clamped: el.scrollHeight > el.clientHeight + 1, full: el.scrollHeight <= el.clientHeight + 1,
          hasTitle: (el.getAttribute("title") ?? "").length > (el.textContent ?? "").length };
      }),
      statusCellWidth: Math.round(rect(document.querySelector(".task-table .task-cell-state")!).width),
      cellCounts: rows.map((row) => row.querySelectorAll("td.data-cell").length),
      revisionVisible: rows.map((row) => (row.querySelector(".task-cell-main small")?.textContent ?? "").includes("任务修订 v")),
      chipTexts: [...document.querySelectorAll(".data-row--tasks .status-chip")].map((el) => el.textContent?.trim()),
      scopeTrigger: (() => { const el = document.querySelector(".task-scope-row .rail-trigger");
        return el === null ? null : { width: Math.round(rect(el).width), height: Math.round(rect(el).height),
          top: Math.round(rect(el).top), right: Math.round(rect(el).right) }; })(),
      reasonColors: reasons.map((el) => ({ color: getComputedStyle(el).color,
        background: getComputedStyle(el.parentElement!.closest(".task-table-card") ?? el).backgroundColor })) };
  });
}

/** Chromium accessibility tree：原生表格角色、五列标题、行与单元格。 */
async function accessibilityRoles(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");
  return nodes.map((node) => ({ role: node.role?.value ?? "", name: node.name?.value ?? "" }));
}

function contrast(foreground: string, background: string): number {
  const rgb = (value: string) => value.match(/[\d.]+/g)!.slice(0, 3).map(Number);
  const lum = (value: string) => rgb(value).map((v) => v / 255)
    .map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    .reduce((sum, v, index) => sum + v * [0.2126, 0.7152, 0.0722][index]!, 0);
  const a = lum(foreground); const b = lum(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

async function connect(page: Page) {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(api);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("tasks-ui-backend-fixture");
  await page.getByTestId("relay-connect").click();
  await expect(page.getByTestId("relay-connection-state").filter({ hasText: "已连接" })).toBeVisible();
  await page.keyboard.press("Escape");
}

/** 受控 API：`tasks` 决定任务列表每次读取的响应，`projectsFails` 模拟项目名不可读。 */
async function installApi(page: Page, options: {
  tasks?: () => { status: number; body: unknown };
  projectsFails?: boolean;
} = {}) {
  const counters = { projectBatchReads: 0, projectPages: 0, projectReads: 0, taskReads: 0 };
  await page.route(`${api}/**`, async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const headers = { "access-control-allow-origin": origin, "access-control-allow-headers": "Authorization, Content-Type",
      "access-control-allow-methods": "GET, POST, OPTIONS" };
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(body) });
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (path === "/health/ready") return json({ status: "ready" });
    if (path === `${prefix}/projects`) {
      const idsParam = url.searchParams.get("ids");
      if (idsParam !== null) {
        counters.projectBatchReads += 1;
        const ids = new Set(idsParam.split(","));
        return json({ items: options.projectsFails ? [] : projects.filter((item) => ids.has(item.id)), next_cursor: null });
      }
      if (url.searchParams.get("status") === "all") counters.projectPages += 1;
      const status = url.searchParams.get("status") ?? "active";
      const visible = options.projectsFails ? []
        : status === "all" ? projects : projects.filter((item) => item.archived_at === null);
      return json({ items: visible, next_cursor: null });
    }
    if (path.startsWith(`${prefix}/projects/`)) counters.projectReads += 1;
    if (path === `${prefix}/assist-sessions`) return json({ items: [] });
    if (path === `${prefix}/tasks`) {
      counters.taskReads += 1;
      const result = options.tasks?.() ?? { status: 200, body: { items: rows, next_cursor: null } };
      return json(result.body, result.status);
    }
    if (path === `${prefix}/attention/interventions`) return route.fulfill({ status: 200,
      contentType: "text/event-stream", headers, body: ": keepalive\n\n" });
    return json({ code: "NOT_STUBBED", detail: path }, 404);
  });
  return counters;
}

test("任务列表：7 个视口的状态原因、阻塞摘要与范围入口", async ({ page }) => {
  const reports: unknown[] = [];
  for (const { width, height } of viewports) {
    await page.setViewportSize({ width, height });
    await page.goto(`${origin}/tasks`);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await page.waitForTimeout(250);
    await shot(page, `fixture-tasks-${width}`);
    const ax = await accessibilityRoles(page);
    reports.push({ width, height, ...await measure(page), ax: {
      tables: ax.filter((node) => node.role === "table").length,
      headers: ax.filter((node) => node.role === "columnheader").map((node) => node.name),
      rows: ax.filter((node) => node.role === "row").length,
      cells: ax.filter((node) => node.role === "cell").length,
    } });
  }
  writeFileSync(resolve(out, "fixture-layout.json"), JSON.stringify(reports, null, 2));

  // 先取齐 7 张截图与几何，再统一断言：某一档不合格时证据仍然齐全。
  for (const report of reports as any[]) {
    expect(report.rows, `${report.width}px 行数`).toBe(6);
    expect(report.overflow, `${report.width}px 横向溢出`).toBeLessThanOrEqual(1);
    expect(report.chipTexts).toContain("等待中");
    // 五项信息在每一档都齐全：五格 + 修订号，不因窄窗隐藏执行模式或执行者。
    expect(report.cellCounts.every((count: number) => count === 5), `${report.width}px 五列信息`).toBe(true);
    expect(report.revisionVisible.every((visible: boolean) => visible), `${report.width}px 任务修订号`).toBe(true);
    expect(report.scopeTrigger, `${report.width}px 范围入口`).not.toBeNull();
    // Chromium accessibility tree：原生表格角色、五个列标题、表头+6 行、30 个数据格。
    expect(report.ax.tables, `${report.width}px 表格角色`).toBe(1);
    expect(report.ax.headers.slice().sort(), `${report.width}px 五个列标题`)
      .toEqual(["任务", "项目", "工作状态", "执行模式", "当前执行者"].sort());
    expect(report.ax.rows, `${report.width}px 表格行`).toBe(7);
    expect(report.ax.cells, `${report.width}px 数据格`).toBe(30);
    // 原因句最多两行；被截断时必须带完整 title，不能只剩半句。
    expect(report.reasons.every((reason: any) => reason.lines <= 2), `${report.width}px 原因行数`).toBe(true);
    expect(report.reasons.every((reason: any) => reason.full || reason.hasTitle),
      `${report.width}px 截断须有完整句兜底`).toBe(true);
    if (report.width >= 1024) {
      expect(report.headerVisible).toBe(true);
      // 状态列能同时放下 chip 与原因：1024 下约 170px 起，宽屏约 260px。
      expect(report.statusCellWidth).toBeGreaterThan(150);
    } else {
      // 窄窗表头只用 clip 视觉隐藏：读屏仍拿到 5 个 columnheader（上面已断言），不是 display:none。
      expect(report.headerVisible).toBe(false);
    }
  }
  const colors = (reports[0] as any).reasonColors as { color: string; background: string }[];
  const ratios = colors.map((item) => contrast(item.color, item.background === "rgba(0, 0, 0, 0)"
    ? "rgb(255, 255, 255)" : item.background));
  expect(Math.min(...ratios)).toBeGreaterThanOrEqual(4.5);
});

test("768px 窄窗：转行卡片后五列信息与修订号仍然齐全", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto(`${origin}/tasks`);
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
  await page.waitForTimeout(250);
  await shot(page, "fixture-tasks-768");
  const report = await measure(page);
  const ax = await accessibilityRoles(page);
  expect(report.rows).toBe(6);
  expect(report.overflow).toBeLessThanOrEqual(1);
  expect(report.headerVisible).toBe(false);
  expect(ax.filter((node) => node.role === "table")).toHaveLength(1);
  expect(ax.filter((node) => node.role === "columnheader").map((node) => node.name).sort())
    .toEqual(["任务", "项目", "工作状态", "执行模式", "当前执行者"].sort());
  expect(ax.filter((node) => node.role === "row")).toHaveLength(7);
  expect(ax.filter((node) => node.role === "cell")).toHaveLength(30);
  expect(report.chipTexts).toContain("等待中");
  expect(report.cellCounts.every((count) => count === 5)).toBe(true);
  expect(report.revisionVisible.every((visible) => visible)).toBe(true);
  expect(report.reasons.every((reason) => reason.lines <= 2 && (reason.full || reason.hasTitle))).toBe(true);
});

test("live 任务列表：原因来自服务端 wait_reason，项目名批量读取并标注归档", async ({ page }) => {
  const counters = await installApi(page, {});
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/tasks`);
  await connect(page);
  await expect(page.getByTestId("tasks-live-count")).toContainText("已加载 6 项");
  const table = page.locator(".task-table-card");
  await expect(table.getByText("文献综述项目", { exact: false }).first()).toBeVisible();
  await expect(table.getByText("工具链改造（已归档）", { exact: false }).first()).toBeVisible();
  await expect(table.getByText("等待原因未识别（SOME_NEW_REASON）", { exact: false }).first()).toBeVisible();
  await expect(table.getByText("工具需人工处理", { exact: false }).first()).toBeVisible();
  // 完整句子在 title 里：两行截断后悬停仍可读。
  await expect(table.locator('[data-testid="task-row-task-long-reason"] .data-cell-reason'))
    .toHaveAttribute("title", /AI 请求了一次需要你批准的动作/u);
  // 最长的一行状态原因是 BLOCKED 摘要：必须完整可见、不超过两行。
  const blockedReason = await table.locator('[data-testid="task-row-task-blocked"] .data-cell-reason')
    .evaluate((el) => ({ text: el.textContent, lines: Math.round((el.getBoundingClientRect().height + 0.5)
      / parseFloat(getComputedStyle(el).lineHeight)), full: el.scrollHeight <= el.clientHeight + 1 }));
  expect(blockedReason.text).toBe("2 个前置任务未完成 · 1 个阻塞未解除");
  expect(blockedReason.lines).toBeLessThanOrEqual(2);
  expect(blockedReason.full).toBe(true);
  await shot(page, "live-tasks-1440");
  // 项目名只走一次按 ID 集合批量读：不按 Project 单读，也不按任务逐条读，更不依赖列表首页。
  expect(counters.projectBatchReads).toBe(1);
  expect(counters.projectPages).toBe(0);
  expect(counters.projectReads).toBe(0);
});

test("live 任务列表：刷新失败保留上次内容，恢复后计时更新", async ({ page }) => {
  let reads = 0;
  await installApi(page, { tasks: () => {
    reads += 1;
    // 左栏「近期工作」与主列表各读一次；之后的读取才是手工刷新。
    return reads <= 2
      ? { status: 200, body: { items: rows, next_cursor: null } }
      : reads === 3
        ? { status: 503, body: { code: "DATABASE_UNAVAILABLE", detail: "数据库不可达" } }
        : { status: 200, body: { items: rows.slice(0, 2), next_cursor: null } };
  } });
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.goto(`${origin}/tasks`);
  await connect(page);
  await expect(page.getByTestId("tasks-live-count")).toContainText("已加载 6 项");
  await page.getByTestId("tasks-live-refresh").click();
  const error = page.getByTestId("tasks-live-refresh-error");
  await expect(error).toContainText("本次刷新没有成功");
  await expect(error).toContainText("读取的结果");
  await expect(page.getByTestId("tasks-live-count")).toContainText("已加载 6 项");
  await expect(page.getByText("等待你批准动作", { exact: false }).first()).toBeVisible();
  await shot(page, "live-refresh-failure-1100");
  await page.getByTestId("tasks-live-refresh").click();
  await expect(error).toBeHidden();
  await expect(page.getByTestId("tasks-live-count")).toContainText("已加载 2 项");
  await expect(page.getByTestId("tasks-live-count")).toContainText("上次成功读取");
  await shot(page, "live-refresh-recovered-1100");
});

test("任务标题是真实链接：五列由表头关联，Tab 聚焦后 Enter 进入详情", async ({ page }) => {
  await installApi(page, {});
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/tasks`);
  await connect(page);
  await expect(page.getByTestId("tasks-live-count")).toContainText("已加载 6 项");

  // 原生结构：table > thead > tr > th[scope=col] 五列；每行 tr 内 5 个 td，标题是唯一交互链接。
  const structure = await page.locator("table.task-table").evaluate((table) => ({
    tag: table.tagName,
    headers: [...table.querySelectorAll("thead th")].map((th) => ({
      text: th.textContent?.trim(), scope: th.getAttribute("scope") })),
    rowCells: [...table.querySelectorAll("tbody tr")].map((row) => row.querySelectorAll("td").length),
    linksPerRow: [...table.querySelectorAll("tbody tr")].map((row) => row.querySelectorAll("a").length),
  }));
  expect(structure.tag).toBe("TABLE");
  expect(structure.headers).toEqual([
    { text: "任务", scope: "col" }, { text: "项目", scope: "col" }, { text: "工作状态", scope: "col" },
    { text: "执行模式", scope: "col" }, { text: "当前执行者", scope: "col" },
  ]);
  expect(structure.rowCells).toEqual([5, 5, 5, 5, 5, 5]);
  expect(structure.linksPerRow).toEqual([1, 1, 1, 1, 1, 1]);

  // 行内标题链接：可访问名称只说明动作，其余事实由表格列关联读取。
  const link = page.getByTestId("task-row-link-task-blocked");
  await expect(link).toHaveAttribute("aria-label", "打开任务：两样都卡住的复核任务");
  await link.focus();
  await expect(link).toBeFocused();
  expect(await page.getByTestId("task-row-task-blocked").evaluate((row) => row.matches(":focus-within"))).toBe(true);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/tasks/task-blocked$`, "u"));
});
