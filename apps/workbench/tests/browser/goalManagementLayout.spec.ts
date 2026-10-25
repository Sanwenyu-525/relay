import { expect, test, type Page, type Route } from "@playwright/test";

// 2026-10-24 正式 Goal 管理页的真实 Chromium 覆盖（API 全部由 page.route 伪造，不连数据库、不调 Provider）：
// 宽窗的列表/详情可达性、键盘焦点与语义标签；390px 窄窗无横向溢出、主操作与右侧入口仍可达。
// 不代替真实 Windows/WebView2，也不把伪造 API 的通过当成业务验收。

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = `http://127.0.0.1:${process.env.RELAY_RAIL_TEST_PORT ?? "4173"}`;
const goalId = "44444444-4444-4444-8444-444444444444";
const projectId = "22222222-2222-4222-8222-222222222222";
const directoryId = "55555555-5555-4555-8555-555555555555";
const sessionId = "66666666-6666-4666-8666-666666666666";

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}
async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(),
    body: JSON.stringify(body) });
}
const goal = { id: goalId, title: "完成毕业论文", description: "完成实验并整理结论",
  status: "ACTIVE", revision: "2", created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-02T00:00:00Z" };
const projectLink = { project_id: projectId, title: "论文实验", project_type: "GENERAL",
  archived_at: null, archive_status: "ACTIVE", project_revision: "2",
  linked_at: "2026-10-02T00:00:00Z" };
const project = { id: projectId, title: "论文实验", project_type: "GENERAL", revision: "2",
  state_revision: "3", archived_at: null };
const projectState = { project_id: projectId, phase_key: "EXECUTING", next_action_task_id: null,
  revision: "3", updated_at: "2026-10-03T00:00:00Z", in_progress: [], blockers: [],
  risks: [], completed_highlight_refs: [], selected_artifact_version_refs: [],
  key_decision_refs: [], dependency_versions: {}, allowed_actions: [] };
const workContext = { kind: "GOAL",
  goal: { id: goalId, title: "完成毕业论文", description: "完成实验并整理结论",
    status: "ACTIVE", revision: "2" },
  projects: [{ id: projectId, title: "论文实验", project_type: "GENERAL",
    archive_status: "ACTIVE", archived_at: null, revision: "2",
    directories: [{ id: directoryId, canonical_root: "D:/work/thesis", status: "ACTIVE",
      revision: "1" }] }],
  sessions: [{ id: sessionId, project_id: projectId, title: "实验讨论", status: "ACTIVE",
    revision: "1", working_resource_id: directoryId }] };

async function installRoutes(page: Page): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/goals`) return fulfillJson(route, { items: [goal], next_cursor: null });
    if (path === `${prefix}/goals/${goalId}`) return fulfillJson(route, goal);
    if (path === `${prefix}/goals/${goalId}/projects`) return fulfillJson(route, { items: [projectLink] });
    if (path === `${prefix}/goals/${goalId}/work-context`) return fulfillJson(route, workContext);
    if (path === `${prefix}/projects/${projectId}`) return fulfillJson(route, project);
    if (path === `${prefix}/projects/${projectId}/state`) return fulfillJson(route, projectState);
    if (path === `${prefix}/projects/${projectId}/goals`) return fulfillJson(route, { items: [
      { goal_id: goalId, title: "完成毕业论文", status: "ACTIVE", revision: "2",
        explicit_task_ids: [] }] });
    if (path === `${prefix}/projects`) return fulfillJson(route, { items: [], next_cursor: null });
    if (path === `${prefix}/tasks`) return fulfillJson(route, { items: [], next_cursor: null });
    if (path === `${prefix}/assist-sessions`) return fulfillJson(route, { items: [] });
    if (path === `${prefix}/attention/interventions`) return fulfillJson(route, { items: [] });
    if (path === `${prefix}/activities`) return fulfillJson(route, { items: [], next_cursor: null });
    return fulfillJson(route, { code: "NOT_STUBBED", detail: path }, 404);
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("goal-management-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

test.describe("正式 Goal 管理页（真实 Chromium）", () => {
  test("宽窗列表与详情可达，键盘焦点和语义标签有效", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installRoutes(page);
    await page.goto("/goals");
    await connect(page);

    await expect(page.getByTestId("goal-list-live")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "目标" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "目标范围" })).toBeVisible();
    await expect(page.getByTestId("goal-list-items")).toContainText("完成毕业论文");

    const open = page.getByTestId(`goal-open-${goalId}`);
    await open.focus();
    await expect(open).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("goal-detail-live")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "完成毕业论文" })).toBeVisible();
    await expect(page.getByTestId("goal-projects-section")
      .getByRole("heading", { level: 2, name: "关联项目" })).toBeVisible();

    const title = page.getByTestId("goal-edit-title");
    await title.focus();
    await expect(title).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("goal-edit-description")).toBeFocused();

    // 会话链接保留原 Session ID 与 Project 绑定。
    const sessionLink = page.getByTestId(`goal-context-session-${sessionId}`);
    await expect(sessionLink).toHaveAttribute("href", new RegExp(`session=${sessionId}`));
    await expect(sessionLink).toHaveAttribute("href", new RegExp(`project=${projectId}`));
  });

  test("390px 窄窗无横向溢出，主操作与右侧入口仍可达", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installRoutes(page);
    await page.goto("/goals");
    await connect(page);

    const overflow = await page.evaluate(() =>
      Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await expect(page.getByTestId("goal-list-create")).toBeVisible();

    await page.getByTestId(`goal-open-${goalId}`).click();
    await expect(page.getByTestId("goal-detail-live")).toBeVisible();
    const detailOverflow = await page.evaluate(() =>
      Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
    expect(detailOverflow).toBeLessThanOrEqual(1);
    await expect(page.getByTestId("goal-edit-submit")).toBeVisible();
    await expect(page.getByRole("button", { name: "归档这个目标" })).toBeVisible();

    // 桌面右栏在窄窗收成抽屉入口；打开后标题可见，Esc 收起。
    const railTrigger = page.getByTestId("rail-trigger");
    await expect(railTrigger).toBeVisible();
    await railTrigger.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("目标入口", { exact: true }).first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });
});
