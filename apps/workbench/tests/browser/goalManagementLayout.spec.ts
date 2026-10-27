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

async function installRoutes(page: Page): Promise<{
  setGoal(next: typeof goal): void;
  setProject(next: typeof project): void;
  setState(next: typeof projectState): void;
  setGoalProjects(next: readonly typeof projectLink[]): void;
  setProjectList(next: readonly Record<string, unknown>[]): void;
}> {
  let liveGoal = goal;
  let liveProject = project;
  let liveState = projectState;
  let liveGoalProjects: readonly typeof projectLink[] = [projectLink];
  let liveProjectList: readonly Record<string, unknown>[] = [];
  let goalEditCount = 0;
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/goals` && request.method() === "GET") return fulfillJson(route, { items: [liveGoal], next_cursor: null });
    if (path === `${prefix}/goals/${goalId}` && request.method() === "GET") return fulfillJson(route, liveGoal);
    if (path === `${prefix}/goals/${goalId}/revisions` && request.method() === "POST") {
      const body = request.postDataJSON() as { command_id: string; title: string; description: string };
      goalEditCount++;
      if (goalEditCount === 1) {
        liveGoal = { ...liveGoal, title: "服务端新标题", description: "服务端新说明", revision: "3" };
        return fulfillJson(route, { code: "REVISION_CONFLICT", detail: "修订已变化",
          conflict: { expected_revision: "2", actual_revision: "3" } }, 409);
      }
      liveGoal = { ...liveGoal, title: body.title, description: body.description,
        revision: String(BigInt(liveGoal.revision) + 1n) };
      return fulfillJson(route, { command_id: body.command_id,
        committed_at: "2026-10-26T00:00:00Z", result: { goal_id: goalId,
          title: body.title, description: body.description, status: "ACTIVE", revision: liveGoal.revision } });
    }
    if (path === `${prefix}/goals/${goalId}/projects`) return fulfillJson(route, { items: liveGoalProjects });
    if (path === `${prefix}/goals/${goalId}/work-context`) return fulfillJson(route, workContext);
    if (path === `${prefix}/projects/${projectId}` && request.method() === "GET") return fulfillJson(route, liveProject);
    if (path === `${prefix}/projects/${projectId}` && request.method() === "PATCH") {
      const body = request.postDataJSON() as { command_id: string; title: string };
      liveProject = { ...liveProject, title: body.title, revision: String(BigInt(liveProject.revision) + 1n) };
      return fulfillJson(route, { command_id: body.command_id, committed_at: "2026-10-26T00:00:00Z",
        result: { project_id: projectId, title: body.title, revision: liveProject.revision } });
    }
    if (path === `${prefix}/projects/${projectId}/state`) return fulfillJson(route, liveState);
    if (path === `${prefix}/projects/${projectId}/goals`) return fulfillJson(route, { items: [
      { goal_id: goalId, title: "完成毕业论文", status: "ACTIVE", revision: "2",
        explicit_task_ids: [] }] });
    if (path === `${prefix}/projects`) return fulfillJson(route, { items: liveProjectList, next_cursor: null });
    if (path === `${prefix}/tasks`) return fulfillJson(route, { items: [], next_cursor: null });
    if (path === `${prefix}/assist-sessions`) return fulfillJson(route, { items: [] });
    if (path === `${prefix}/attention/interventions`) return fulfillJson(route, { items: [] });
    if (path === `${prefix}/activities`) return fulfillJson(route, { items: [], next_cursor: null });
    return fulfillJson(route, { code: "NOT_STUBBED", detail: path }, 404);
  });
  return { setGoal: (next) => { liveGoal = next; }, setProject: (next) => { liveProject = next; },
    setState: (next) => { liveState = next; }, setGoalProjects: (next) => { liveGoalProjects = next; },
    setProjectList: (next) => { liveProjectList = next; } };
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

  test("Goal 409 后浏览器返回仍受守卫保护，取消刷新保留草稿，明确丢弃后可离开", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installRoutes(page);
    await page.goto("/goals");
    await connect(page);
    await page.getByTestId(`goal-open-${goalId}`).click();

    const title = page.getByTestId("goal-edit-title");
    await title.fill("我的未提交目标");
    await page.getByTestId("goal-edit-submit").click();
    await expect(page.getByTestId("goal-edit-conflict-facts")).toContainText("服务端新标题");
    await expect(title).toHaveValue("我的未提交目标");

    await page.goBack();
    const navigationGuard = page.getByRole("dialog");
    await expect(navigationGuard).toContainText("未保存的修改");
    await navigationGuard.getByTestId("keep-editing").click();
    await expect(page.getByTestId("goal-detail-live")).toBeVisible();
    await expect(title).toBeFocused();
    await expect(title).toHaveValue("我的未提交目标");

    let beforeUnloadShown = false;
    page.once("dialog", async (dialog) => {
      beforeUnloadShown = dialog.type() === "beforeunload";
      await dialog.dismiss();
    });
    // beforeunload 取消刷新时不会有新页面 load；短暂等待浏览器处理对话框后检查原文档仍在。
    await page.reload({ timeout: 2_000 }).catch(() => undefined);
    expect(beforeUnloadShown).toBe(true);
    await expect(page.getByTestId("goal-detail-live")).toBeVisible();
    await expect(page.getByTestId("goal-edit-title")).toHaveValue("我的未提交目标");

    await page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "项目" }).click();
    const discardGuard = page.getByRole("dialog");
    await expect(discardGuard).toBeVisible();
    await discardGuard.getByTestId("discard-draft-leave").click();
    await expect(page).toHaveURL(/\/projects$/u);
  });

  test("Project 改名草稿在服务端 revision 刷新后保留，继续编辑可恢复焦点", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const routes = await installRoutes(page);
    await page.goto(`/projects/${projectId}`);
    await connect(page);
    await expect(page.getByTestId("project-overview-live")).toBeVisible();

    await page.getByTestId("project-rename-open").click();
    const title = page.getByTestId("project-title-input");
    await title.fill("我的项目标题草稿");
    routes.setProject({ ...project, title: "服务端更新的项目名", revision: "3" });
    await page.getByTestId("project-overview-page-head").getByRole("button", { name: "刷新" }).click();
    await expect(page.getByTestId("project-rename-conflict")).toContainText("服务端更新的项目名");
    await expect(title).toHaveValue("我的项目标题草稿");

    await page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "项目" }).click();
    const navigationGuard = page.getByRole("dialog");
    await expect(navigationGuard).toBeVisible();
    await navigationGuard.getByTestId("keep-editing").click();
    await expect(title).toBeFocused();
    await expect(title).toHaveValue("我的项目标题草稿");

    await page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "项目" }).click();
    await page.getByRole("dialog").getByTestId("discard-draft-leave").click();
    await expect(page).toHaveURL(/\/projects$/u);
  });

  test("Goal 响应丢失后以持久存储重开，核对后沿原 ID 和载荷重试", async ({ page, browser }) => {
    await installRoutes(page);
    let original: Record<string, unknown> | null = null;
    await page.route(`${apiBase}${prefix}/goals/${goalId}/revisions`, async (route) => {
      original = route.request().postDataJSON() as Record<string, unknown>;
      await route.abort("failed");
    });
    await page.goto(`/goals/${goalId}`); await connect(page);
    await page.getByTestId("goal-edit-title").fill("跨窗口恢复的目标");
    await page.getByTestId("goal-edit-submit").click();
    await expect(page.getByTestId("goal-detail-pending")).toBeVisible();
    expect(original).not.toBeNull();
    const frozen = original as unknown as Record<string, unknown>;
    await expect(page.getByTestId("goal-detail-pending")).toContainText(String(frozen.command_id));

    // 新上下文只继承本机持久存储，模拟原窗口的 sessionStorage 已消失。
    const reopenedContext = await browser.newContext({ storageState: await page.context().storageState() });
    try {
      const reopened = await reopenedContext.newPage();
      await installRoutes(reopened);
      await reopened.route(`${apiBase}${prefix}/commands/**`, (route) =>
        fulfillJson(route, { code: "COMMAND_NOT_FOUND", detail: "not found" }, 404));
      let retried: Record<string, unknown> | null = null;
      await reopened.route(`${apiBase}${prefix}/goals/${goalId}/revisions`, async (route) => {
        retried = route.request().postDataJSON() as Record<string, unknown>;
        await fulfillJson(route, { command_id: retried.command_id, committed_at: "2026-10-27T00:00:00Z",
          result: { goal_id: goalId, title: retried.title, description: retried.description,
            status: "ACTIVE", revision: "3" } });
      });
      await reopened.goto(`${origin}/goals/${goalId}`); await connect(reopened);
      await expect(reopened.getByTestId("goal-detail-pending")).toContainText(String(frozen.command_id));
      await reopened.getByTestId("goal-detail-check-receipt").click();
      await reopened.getByTestId("goal-detail-retry").click();
      await expect(reopened.getByTestId("goal-detail-receipt")).toBeVisible();
      expect(retried).toEqual(frozen);
    } finally { await reopenedContext.close(); }
  });

  test("Project State 按当前修订提交合法阶段并读取新事实", async ({ page }) => {
    const routes = await installRoutes(page);
    const writes: Record<string, unknown>[] = [];
    await page.route(`${apiBase}${prefix}/projects/${projectId}/state-commands`, async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>; writes.push(body);
      routes.setState({ ...projectState, phase_key: "REVIEW", revision: "4" });
      await fulfillJson(route, { command_id: body.command_id, committed_at: "2026-10-27T00:00:00Z",
        result: { project_id: projectId, action: "SET_PHASE", revision: "4" } });
    });
    await page.goto(`/projects/${projectId}`); await connect(page);
    await expect(page.getByTestId("project-state-panel")).toBeVisible();
    await page.getByTestId("state-phase").selectOption("REVIEW");
    await page.getByTestId("state-phase-submit").click();
    await expect(page.getByTestId("project-state-receipt")).toContainText("v4");
    await expect(page.getByTestId("state-phase")).toHaveValue("REVIEW");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ action: "SET_PHASE", phase_key: "REVIEW", expected_revision: "3" });
  });

  test("Goal 关联项目并在解除前展示受影响 Task", async ({ page }) => {
    const secondId = "33333333-3333-4333-8333-333333333333";
    const taskId = "99999999-9999-4999-8999-999999999999";
    const routes = await installRoutes(page);
    routes.setProjectList([{ id: secondId, title: "新增关联项目", project_type: "GENERAL", revision: "0",
      state_revision: "0", archived_at: null, archive_status: "ACTIVE", phase_key: "PLANNING",
      next_action_task_id: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" }]);
    const secondLink = { ...projectLink, project_id: secondId, title: "新增关联项目", project_revision: "1" };
    const writes: Record<string, unknown>[] = [];
    await page.route(`${apiBase}${prefix}/projects/${secondId}/goal-links`, async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>; writes.push(body);
      routes.setGoalProjects([projectLink, secondLink]);
      await fulfillJson(route, { command_id: body.command_id, committed_at: "2026-10-27T00:00:00Z",
        result: { project_id: secondId, revision: "1", goal_ids: [goalId] } });
    });
    await page.route(`${apiBase}${prefix}/projects/${projectId}/goals`, (route) => fulfillJson(route, { items: [
      { goal_id: goalId, title: goal.title, status: "ACTIVE", revision: "2", explicit_task_ids: [taskId] }] }));
    await page.route(`${apiBase}${prefix}/projects/${projectId}/goal-unlinks`, async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>; writes.push(body);
      routes.setGoalProjects([secondLink]);
      await fulfillJson(route, { command_id: body.command_id, committed_at: "2026-10-27T00:00:01Z",
        result: { project_id: projectId, revision: "3", impacted_tasks: [{ task_id: taskId, revision: "2" }] } });
    });
    await page.goto(`/goals/${goalId}`); await connect(page);
    await page.getByTestId("goal-link-project").selectOption(secondId);
    await page.getByTestId("goal-link-submit").click();
    await expect(page.getByTestId(`goal-project-${secondId}`)).toBeVisible();
    await page.getByTestId(`goal-unlink-open-${projectId}`).click();
    await expect(page.getByTestId(`goal-unlink-confirm-${projectId}`)).toContainText(taskId);
    await page.getByTestId(`goal-unlink-submit-${projectId}`).click();
    await expect(page.getByTestId(`goal-project-${projectId}`)).toHaveCount(0);
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({ goal_id: goalId, expected_revision: "0" });
    expect(writes[1]).toMatchObject({ goal_id: goalId, expected_revision: "2", expected_impacted_task_ids: [taskId] });
  });
});
