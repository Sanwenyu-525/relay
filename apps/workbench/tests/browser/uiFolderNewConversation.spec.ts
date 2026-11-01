import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * UI-FOLDER-01 的浏览器验收：只连页面内夹具（`page.route` mock 8787），不连数据库、不调 Provider。
 *
 * 现场刻意造成「项目 P 里已经有一条历史会话、工作区里还有一条未归属会话」：
 * 这正是「欢迎页选目录会不会顺手恢复历史会话」能被看出来的唯一布局。
 *
 * 截图落在 `tmp/UI-FOLDER-01-new-conversation/screenshots/`（由调用方的 RELAY_SHOT_DIR 指定）。
 */

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const projectSessionId = "77777777-7777-4777-8777-777777777777";
const createdSessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const rootA = "D:\\Develop\\ProjectA";
const shots = process.env.RELAY_SHOT_DIR ?? "tmp/UI-FOLDER-01-new-conversation/screenshots";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "Authorization, Content-Type",
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS"
};

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors, body: JSON.stringify(body) });
}

function projectSession(over: Record<string, unknown> = {}) {
  return { id: projectSessionId, workspace_id: workspaceId, project_id: projectId, task_id: null,
    title: "项目里的历史会话", status: "ACTIVE", revision: "1", conversation_mode: "AGENT",
    chat_mode: "CHAT", remember: true, working_resource_id: "res-1",
    created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", ...over };
}

function readyDirectory() {
  return { canonical_root: rootA, display_name: "ProjectA", status: "READY", reason: null,
    association: { project_id: projectId, project_title: "ProjectA", project_archived: false,
      resource_id: "res-1", resource_status: "ACTIVE", file_write_identity_bound: true },
    created_project: false, created_resource: false, candidates: [],
    write_readiness: { status: "NEEDS_CONNECTION", detail: "本项目还没有绑定该目录的文件写入连接。" } };
}

function audit() {
  return { state: "OK", detail: "", agent: { id: "relay", label: "Relay" }, root: rootA,
    scanned_at: "2026-10-31T00:00:00Z", fingerprint: "fp-1", severity: "NONE", files: [],
    budget: { provider_window_tokens: null, provider_window_known: false, call_budget_tokens: 256000,
      call_budget_source: "APPLICATION_DEFAULT", effective_input_tokens: null,
      effective_basis: "CALL_BUDGET",
      reserves: { output_tokens: 0, system_prompt_tokens: 0, tool_definition_tokens: 0, history_tokens: 0 },
      estimated_total_input_tokens: null, required_total_tokens: 0, required_total_share: 0,
      confidence: "WINDOW_UNKNOWN", estimate: { method: "BYTES", bytes_per_token: 4, note: "" } },
    reasons: [], suggestions: [], skipped: [], access: null,
    thresholds: { single_file: { notice: 0.1, high: 0.3, severe: 0.6 },
      total_files: { notice: 0.1, high: 0.3, severe: 0.6 } } };
}

interface Recorded { readonly posts: { path: string; body: Record<string, unknown> }[] }

async function installRoutes(page: Page, recorded: { posts: { path: string; body: Record<string, unknown> }[] },
  options: { withProjectSession?: boolean } = {}): Promise<void> {
  /**
   * 创建成功后项目列表必须包含这条新会话——真实服务端就是这样。
   * 夹具若仍只返回那条历史会话，界面会按「所选会话不属于当前工作对象」退化，
   * 截图里看到的就不是这次操作的结果。
   */
  let created = false;
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors }); return; }
    if (path === "/health/ready") return json(route, { status: "ready" });
    if (request.method() === "POST") {
      const body = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>;
      recorded.posts.push({ path, body });
      if (path === `${prefix}/working-directories/open`) return json(route, {
        command_id: body.command_id, committed_at: "2026-10-31T00:00:00Z", links: { resource: "" },
        result: readyDirectory() });
      if (path.endsWith("/binding")) return json(route, { command_id: body.command_id,
        committed_at: "2026-10-31T00:00:00Z",
        result: { session_id: path.split("/").at(-2), project_id: body.project_id, revision: "2" } });
      if (path.endsWith("/working-directory")) return json(route, { command_id: body.command_id,
        committed_at: "2026-10-31T00:00:00Z",
        result: { session_id: path.split("/").at(-2), working_resource_id: body.resource_id, revision: "2" } });
      if (path === `${prefix}/assist-sessions`) {
        created = true;
        return json(route, { command_id: body.command_id,
          committed_at: "2026-10-31T00:00:00Z",
          result: { session_id: createdSessionId,
            ...projectSession({ id: createdSessionId, title: "从这个目录开始", working_resource_id: "res-1" }) } }, 201);
      }
      if (path.endsWith("/messages")) return json(route, { command_id: body.command_id,
        committed_at: "2026-10-31T00:00:00Z",
        result: { session_id: path.split("/").at(-2), user_message_id: "msg-new",
          assistant_message_id: "msg-reply" } }, 202);
      return json(route, {});
    }
    if (path === `${prefix}/default-working-directory`) return json(route, { resource_id: null,
      canonical_root: null, display_name: null, write_tier: null, default_write_tier: null,
      status: "UNSET", reason: null, revision: "0" });
    if (path.includes("/required-context-audit")) return json(route, audit());
    if (path === `${prefix}/assist-sessions`) {
      const scoped = url.searchParams.get("project_id");
      const items = scoped === null ? []
        : options.withProjectSession === false && !created ? []
          : [...(options.withProjectSession === false ? [] : [projectSession()]),
            ...(created ? [projectSession({ id: createdSessionId, title: "从这个目录开始",
              working_resource_id: "res-1" })] : [])];
      return json(route, { items });
    }
    if (path === `${prefix}/assist-sessions/${createdSessionId}/messages`
      || path === `${prefix}/assist-sessions/${projectSessionId}/messages`) {
      return json(route, { items: path.includes(createdSessionId) ? [{
        id: "msg-new", session_id: createdSessionId, seq: "1", role: "USER", status: "COMPLETED",
        intent: "DISCUSS", content: "从这个目录开始", sources: [], cancel_requested: false,
        error_code: null, provider_error_kind: null, created_at: "2026-10-31T00:00:00Z",
        updated_at: "2026-10-31T00:00:00Z",
        usage: { input_tokens: null, output_tokens: null }, skill: null }] : [{
        id: "msg-old", session_id: projectSessionId, seq: "1", role: "USER", status: "COMPLETED",
        intent: "DISCUSS", content: "这是项目里那条历史会话的原文", sources: [], cancel_requested: false,
        error_code: null, provider_error_kind: null, created_at: "2026-10-01T00:00:00Z",
        updated_at: "2026-10-01T00:00:00Z",
        usage: { input_tokens: null, output_tokens: null }, skill: null }] });
    }
    if (path.startsWith(`${prefix}/assist-sessions/`)) {
      const rest = path.slice(`${prefix}/assist-sessions/`.length);
      if (rest === createdSessionId) return json(route, projectSession({ id: createdSessionId,
        title: "从这个目录开始", working_resource_id: "res-1",
        context: { project_goals: [], working_directory: { resource_id: "res-1",
          canonical_root: rootA, display_name: "ProjectA", source: "USER_PICKED" } } }));
      if (rest === projectSessionId) return json(route, projectSession({
        context: { project_goals: [], working_directory: { resource_id: "res-1",
          canonical_root: rootA, display_name: "ProjectA", source: "USER_PICKED" } } }));
    }
    if (path === `${prefix}/projects/${projectId}`) return json(route, { id: projectId, title: "ProjectA",
      project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
    if (path === `${prefix}/projects`) return json(route, { items: [{ id: projectId, title: "ProjectA",
      project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null,
      archive_status: "ACTIVE", phase_key: "GENERAL", next_action_task_id: null,
      created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" }], next_cursor: null });
    if (path.endsWith("/plans")) return json(route, { latest: null, versions: [] });
    if (path.endsWith("/goal")) return json(route, { goal: null, rounds: [] });
    if (path.endsWith("/model-catalog")) return json(route, { configured: false, chat_configured: false,
      snapshot_seq: "0", last_success_at: null, last_failure_reason: null, cache_stale: false,
      free_count: 0, entries: [] });
    if (path.endsWith("/model-port")) return json(route, { provider: "fake", configured: false,
      model: null, base_url: null, max_call_tokens: null });
    if (path.endsWith("/model-selection")) return json(route, { selection: null });
    return json(route, { items: [], next_cursor: null });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("ui-folder-01-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

/** 在细条浮层里填本机绝对路径并打开（非桌面宿主没有原生选择器）。 */
async function openDirectory(page: Page, path: string): Promise<void> {
  await page.getByTestId("folder-scope-change").click();
  await page.getByTestId("folder-manual-root").fill(path);
  await page.getByTestId("folder-open-manual").click();
  await expect(page.getByTestId("folder-scope-strip")).toContainText("ProjectA", { timeout: 20_000 });
}

test("欢迎页选目录：项目里有历史会话时仍落在空白新会话", async ({ page }) => {
  const recorded: Recorded = { posts: [] };
  await page.setViewportSize({ width: 1280, height: 820 });
  await installRoutes(page, recorded);
  await page.goto("/agent");
  await connect(page);
  await expect(page.getByTestId("assist-first-draft")).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: `${shots}/01-welcome-blank.png`, fullPage: false });

  await openDirectory(page, rootA);
  // 目录已就绪并归入项目，但讨论仍是空白新会话：没有会话面板、没有历史原文。
  await expect(page.getByTestId("folder-scope-association")).toContainText("已归入项目");
  await expect(page.getByTestId("assist-first-draft")).toBeVisible();
  await expect(page.getByTestId("assist-session")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("这是项目里那条历史会话的原文");
  await page.screenshot({ path: `${shots}/02-folder-selected-new-conversation.png` });

  // 首条发送：建会话 → 绑目录 → 发消息，全程只碰这一条新会话。
  await page.getByTestId("assist-first-draft").fill("从这个目录开始");
  await page.getByTestId("assist-first-send").click();
  await expect.poll(() => recorded.posts.filter((post) => post.path === `${prefix}/assist-sessions`).length,
    { timeout: 20_000 }).toBe(1);
  await expect.poll(() => recorded.posts.filter((post) => post.path.endsWith("/working-directory"))
    .map((post) => post.path), { timeout: 20_000 })
    .toEqual([`${prefix}/assist-sessions/${createdSessionId}/working-directory`]);
  await expect(page.getByTestId("assist-draft")).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: `${shots}/03-first-message-persisted.png` });
});

test("从已有会话新建：新对话继承那条会话服务端确认的目录", async ({ page }) => {
  const recorded: Recorded = { posts: [] };
  await page.setViewportSize({ width: 1280, height: 820 });
  await installRoutes(page, recorded);
  // 本机最近目录留空：继承必须来自来源会话的服务端上下文，不能来自本机偏好。
  await page.goto(`/agent?new=inherit&source_session=${projectSessionId}`);
  await connect(page);
  await expect(page.getByTestId("folder-scope-strip")).toContainText("ProjectA", { timeout: 20_000 });
  await expect(page.getByTestId("assist-first-draft")).toBeVisible();
  await expect.poll(() => recorded.posts.filter((post) => post.path === `${prefix}/working-directories/open`)
    .map((post) => post.body.root_path), { timeout: 20_000 }).toEqual([rootA]);
  await page.screenshot({ path: `${shots}/04-inherit-directory-from-session.png` });
});

test("窄屏（420×820）下欢迎页与新对话输入器没有横向溢出", async ({ page }) => {
  const recorded: Recorded = { posts: [] };
  await page.setViewportSize({ width: 420, height: 820 });
  await installRoutes(page, recorded);
  await page.goto("/agent");
  await connect(page);
  await expect(page.getByTestId("assist-first-draft")).toBeVisible({ timeout: 20_000 });
  const overflow = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
  expect(overflow.page).toBeLessThanOrEqual(1);
  await page.screenshot({ path: `${shots}/05-narrow-420-welcome.png` });

  await openDirectory(page, rootA);
  await expect(page.getByTestId("assist-first-draft")).toBeVisible();
  const overflowAfter = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
  expect(overflowAfter.page).toBeLessThanOrEqual(1);
  await page.screenshot({ path: `${shots}/06-narrow-420-folder-new-conversation.png` });
});
