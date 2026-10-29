import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// 仅用于隔离 Chromium 界面验收：fixture / page.route 均不代表真实后端。
const output = resolve(import.meta.dirname, "../../output/ui-acceptance-20261028/projects",
  process.env.RELAY_ACCEPTANCE_PHASE ?? "after");
const projectId = "22222222-2222-4222-8222-222222222222";
const goalId = "44444444-4444-4444-8444-444444444444";
const apiBase = "http://127.0.0.1:18787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const goal = { id: goalId, title: "形成可追溯的界面验收结果", description: "核对页面状态与证据范围",
  status: "ACTIVE", revision: "2", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-28T00:00:00Z" };
test.use({ viewport: { width: 1440, height: 900 } });

async function capture(page: Page, name: string) {
  mkdirSync(output, { recursive: true });
  await page.screenshot({ path: resolve(output, `${name}.png`), fullPage: true });
  const metrics = await page.evaluate(() => ({
    path: location.pathname + location.search,
    viewport: innerWidth,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    headings: [...document.querySelectorAll("main h1, main h2, main h3")].map((el) => ({
      text: el.textContent, size: getComputedStyle(el).fontSize
    }))
  }));
  writeFileSync(resolve(output, `${name}.json`), JSON.stringify(metrics, null, 2));
  expect(metrics.overflow).toBeLessThanOrEqual(1);
}

async function mockLive(page: Page, mode: "normal" | "empty" | "error" = "normal") {
  await page.route(`${apiBase}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = { code: "NOT_STUBBED", detail: path };
    let status = 200;
    if (mode === "error" && path.includes("/goals")) {
      status = 503; body = { type: "about:blank", title: "暂时不可用", status, detail: "隔离接口暂时无法读取目标。" };
    } else if (path === `${prefix}/goals`) body = { items: mode === "empty" ? [] : [goal], next_cursor: null };
    else if (path === `${prefix}/goals/${goalId}`) body = goal;
    else if (path === `${prefix}/goals/${goalId}/projects`) body = { items: [] };
    else if (path === `${prefix}/goals/${goalId}/work-context`) body = { kind: "GOAL", goal, projects: [], sessions: [] };
    else if (path === `${prefix}/projects/${projectId}`) body = { id: projectId, title: "尚未建立任务的项目",
      project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null };
    else if (path === `${prefix}/projects/${projectId}/state`) body = { project_id: projectId,
      phase_key: "PLANNING", revision: "1", next_action_task_id: null,
      selected_artifact_version_refs: [], completed_highlight_refs: [] };
    else if (path === `${prefix}/tasks` || path === `${prefix}/knowledge` || path === `${prefix}/assist-sessions` ||
      path === `${prefix}/projects`) body = { items: [], next_cursor: null };
    else status = 404;
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body),
      headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "Authorization, Content-Type" } });
  });
  await page.evaluate(async ({ apiBase, workspaceId }) => {
    const modulePath = "/src/lib/relayConnection.ts";
    const { activateRelayConnection } = await import(/* @vite-ignore */ modulePath);
    activateRelayConnection({ baseUrl: apiBase, workspaceId, bearerToken: "isolated-ui-test-token-20261028" });
  }, { apiBase, workspaceId });
}

for (const width of [1440, 390]) {
  test.describe(`项目与目标 ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });
    for (const kind of ["general", "thesis", "development"]) {
      test(`工作台 ${kind} 正常与视图切换`, async ({ page }) => {
        await page.goto(`/projects/project-hci/workbench/${kind}`);
        await expect(page.locator("section.project-workbench")).toBeVisible();
        await capture(page, `workbench-${kind}-${width}`);
        await expect(page.locator("section.project-workbench")).toHaveClass(/pv-page/);
        await expect(page.getByTestId("workbench-page-head").locator("h1")).toHaveCSS("font-size", "22px");
        await expect(page.locator(".workbench-scope-note")).toContainText("示例数据预览");
        if (width === 390) {
          await page.getByRole("button", { name: kind === "development" ? "查看运行证据与待审" : "打开 AI 辅助与资料" }).click();
          await expect(page.getByRole("dialog")).toBeVisible();
          await expect(page.getByRole("dialog").locator(".workbench-assist-rail > h2")).toHaveCSS("font-size", "13px");
          await capture(page, `workbench-${kind}-drawer-${width}`);
          await page.keyboard.press("Escape");
          await expect(page.getByRole("dialog")).toHaveCount(0);
        }
        await page.getByTestId("workbench-view-configuration").locator("summary").click();
        await expect(page.locator(".view-configuration-panel > h2")).toHaveCSS("font-size", "13px");
        if (kind === "general" && width === 1440) await capture(page, "workbench-general-configuration-1440");
        const other = kind === "thesis" ? "通用" : "论文";
        await page.getByRole("navigation", { name: "工作台视图" }).getByRole("link", { name: other, exact: true }).click();
        await expect(page.locator(".workbench-scope-note")).toContainText("项目类型：论文 · 当前阶段：文献研究");
      });
    }
    for (const state of ["empty", "load-error"]) {
      test(`工作台 ${state}`, async ({ page }) => {
        await page.goto(`/projects/project-hci/workbench/general?fixture=${state}`);
        const title = state === "empty" ? "没有这个项目" : "暂时无法读取项目工作台";
        await expect(page.getByRole("heading", { name: title })).toBeVisible();
        await capture(page, `workbench-${state}-${width}`);
        await expect(page.locator(".page-state.pv-page")).toBeVisible();
        await expect(page.locator(".page-state h1")).toHaveCSS("font-size", "22px");
        if (state === "load-error") {
          await page.getByRole("button", { name: "重新读取" }).click();
          await expect(page.getByRole("heading", { name: title })).toBeVisible();
        }
      });
    }
  });
}

test("工作台 loading 与无效视图", async ({ page }) => {
  await page.goto("/projects/project-hci/workbench/general?fixtureLatency=3000");
  await expect(page.getByRole("heading", { name: "正在读取项目工作台" })).toBeVisible();
  await capture(page, "workbench-loading");
  await page.goto("/projects/project-hci/workbench/unknown");
  await expect(page.getByRole("heading", { name: "没有这个工作台" })).toBeVisible();
  await capture(page, "workbench-invalid-kind");
});

test("工作台 live 接口模拟：零任务保留真实空态", async ({ page }) => {
  await page.goto(`/projects/${projectId}/workbench/general`);
  await mockLive(page);
  await expect(page.locator("section.project-workbench")).toBeVisible();
  await expect(page.getByText("当前项目没有可供阅读的任务，可到项目任务页创建或选择。")).toBeVisible();
  await capture(page, "workbench-mocked-live-no-tasks");
  await expect(page.locator("section.project-workbench")).toHaveClass(/pv-page/);
  await page.getByText("选择项目任务 · 0", { exact: true }).click();
  await expect(page.getByText("当前项目没有任务。", { exact: true })).toBeVisible();
});

for (const state of ["normal", "empty", "load-error"]) {
  test(`项目列表 fixture ${state}`, async ({ page }) => {
    await page.goto(`/projects?fixture=${state}`);
    if (state === "normal") await expect(page.locator(".pv-pcard").first()).toBeVisible();
    else if (state === "load-error") await expect(page.getByRole("heading", { name: "暂时无法显示项目" })).toBeVisible();
    else await expect(page.getByRole("button", { name: "新建项目", exact: true }).first()).toBeVisible();
    await capture(page, `projects-${state}`);
    await page.setViewportSize({ width: 390, height: 900 });
    await capture(page, `projects-${state}-390`);
  });
}

for (const path of ["/goals", "/goals/goal-example"]) {
  test(`目标 fixture 真实能力边界 ${path}`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: /示例模式没有正式 Goal/ })).toBeVisible();
    await capture(page, path === "/goals" ? "goals-fixture-gap" : "goal-detail-fixture-gap");
  });
}

for (const state of ["normal", "empty", "error"] as const) {
  test(`目标列表 live 接口模拟 ${state}`, async ({ page }) => {
    await page.goto("/goals");
    await mockLive(page, state);
    if (state === "normal") await expect(page.locator('[data-testid^="goal-open-"]')).toBeVisible();
    else if (state === "empty") await expect(page.getByRole("heading", { name: /没有.*目标/ })).toBeVisible();
    else await expect(page.getByRole("alert")).toContainText("读取失败");
    await capture(page, `goals-mocked-live-${state}`);
    await page.setViewportSize({ width: 390, height: 900 });
    await capture(page, `goals-mocked-live-${state}-390`);
  });
}

for (const state of ["normal", "error"] as const) {
  test(`目标详情 live 接口模拟 ${state}`, async ({ page }) => {
    await page.goto(`/goals/${goalId}`);
    await mockLive(page, state);
    if (state === "normal") await expect(page.getByTestId("goal-detail-live")).toBeVisible();
    else await expect(page.getByRole("heading", { name: /无法读取/ })).toBeVisible();
    await capture(page, `goal-detail-mocked-live-${state}`);
    await page.setViewportSize({ width: 390, height: 900 });
    await capture(page, `goal-detail-mocked-live-${state}-390`);
  });
}
