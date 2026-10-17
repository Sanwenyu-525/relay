import { expect, test, type Locator, type Page, type Route } from "@playwright/test";

// 2026-10-16 不同入口新建会话首屏一致。
// 全局「新对话」（?new=）走延迟建会话的首条输入区，任务作用域「新建会话」先建会话再进面板；
// 两条路径的空态此前一个是欢迎页、一个是「还没有消息。」。这里在真实 Chromium 里核对：
// 两处渲染同一个欢迎块（同一标题、同一组快捷卡），且欢迎在消息区可视高度内居中。
// API 全部由 page.route 伪造，不连数据库、不调 Provider、不写任何真实业务事实。

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const sessionId = "66666666-6666-4666-8666-666666666666";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = "http://127.0.0.1:4173";

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(), body: JSON.stringify(body) });
}

/** 任务作用域里的一条刚建好、还没有消息的会话。 */
const emptySession = { id: sessionId, workspace_id: workspaceId, project_id: projectId, task_id: taskId,
  title: "关于确定实验评价指标", status: "ACTIVE", revision: "1",
  working_resource_id: "88888888-8888-4888-8888-888888888888",
  context: { project_goals: [], working_directory: {
    resource_id: "88888888-8888-4888-8888-888888888888", canonical_root: "D:\\Work\\Research" } },
  created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z" };

function task(): unknown {
  return { id: taskId, project_id: projectId, title: "确定实验评价指标", status: "IN_PROGRESS", mode: "ME",
    revision: "2", created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z",
    // 契约要求 executor 是对象（kind 只接受 HUMAN/AI）；HUMAN + run_id null 不触发 Run 读取。
    executor: { kind: "HUMAN", run_id: null, ownership_epoch: "1" },
    current_completion_id: null, waiting_reason: null, blocking_task_ids: [],
    unresolved_blocker_ids: [], allowed_actions: [],
    acceptance: { acceptance_revision: "2", objective: "补齐基线与验收依据。", source: "CREATE",
      created_at: "2026-10-16T00:00:00Z", criteria: [] },
    dependencies: [] };
}

async function installRoutes(page: Page): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/tasks/${taskId}`) return fulfillJson(route, task());
    if (path === `${prefix}/projects/${projectId}`) return fulfillJson(route, { id: projectId,
      title: "人机协作工作流研究", project_type: "GENERAL", revision: "1", state_revision: "1",
      archived_at: null });
    if (path === `${prefix}/model-port`) {
      return fulfillJson(route, { provider: "fake", configured: false, model: null, base_url: null,
        max_call_tokens: null });
    }
    if (path === `${prefix}/assist-sessions`) return fulfillJson(route, { items: [emptySession] });
    if (path === `${prefix}/assist-sessions/${sessionId}`) return fulfillJson(route, emptySession);
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return fulfillJson(route, { items: [] });
    return fulfillJson(route, { items: [], next_cursor: null });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("empty-welcome-browser-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

/** 欢迎块必须落在消息区可视高度内垂直居中：上沿与下沿的空白大致相当。 */
async function expectCenteredInTranscript(page: Page, welcome: Locator): Promise<void> {
  const shell = await page.getByTestId("assist-transcript").boundingBox();
  const box = await welcome.boundingBox();
  expect(box).not.toBeNull();
  expect(shell).not.toBeNull();
  const above = box!.y - shell!.y;
  const below = shell!.y + shell!.height - (box!.y + box!.height);
  expect(above).toBeGreaterThan(0);
  expect(Math.abs(above - below)).toBeLessThan(shell!.height * 0.25);
}

test.describe("新建会话空态一致", () => {
  test.use({ viewport: { width: 1487, height: 1058 } });

  test("全局新对话：首条输入区渲染欢迎块", async ({ page }) => {
    await installRoutes(page);
    // 连接只活在内存里：先落到目标地址再连接，连接后不再整页跳转。
    await page.goto("/agent?new=browser");
    await connect(page);
    const welcome = page.getByTestId("assist-first-welcome");
    await expect(welcome).toBeVisible({ timeout: 20_000 });
    await expect(welcome.locator("h1")).toHaveText("有什么想一起完成的？");
    await expect(welcome.locator(".agent-chat-suggestion")).toHaveCount(11);
    await page.screenshot({ path: "results/empty-welcome-first-composer.png" });
  });

  test("任务作用域空会话：同一欢迎块，说明句按归属收敛", async ({ page }) => {
    await installRoutes(page);
    await page.goto(`/agent?work=${taskId}`);
    await connect(page);
    await expect(page.getByTestId("collab-conversation-toolbar")).toBeVisible();
    await expect(page.getByTestId("folder-scope-strip")).toBeVisible();
    await expect(page.getByTestId("folder-scope-options")).toHaveText("Research");
    await expect(page.getByTestId("collab-goal")).toBeHidden();
    await expect(page.getByTestId("collab-inspector")).toHaveCount(0);
    await page.getByTestId("collab-conversation-inspector-toggle").click();
    await expect(page.getByTestId("collab-inspector")).toBeVisible();
    await expect(page.getByRole("tablist", { name: "工作详情分类" }).getByRole("tab")).toHaveText(["进展", "成果", "记录"]);
    await page.getByTestId("collab-inspector-close").click();
    const welcome = page.getByTestId("assist-empty-welcome");
    await expect(welcome).toBeVisible({ timeout: 20_000 });
    await expect(welcome.locator("h1")).toHaveText("有什么想一起完成的？");
    await expect(welcome.locator(".agent-chat-suggestion")).toHaveCount(11);
    await expect(welcome.locator(".agent-chat-empty-lede"))
      .toHaveText("围绕当前任务直接讨论，或描述新的目标与要求。");
    await expect(page.getByTestId("assist-transcript")).not.toContainText("还没有消息");
    await expectCenteredInTranscript(page, welcome);
    // 快捷卡把脚手架预填进面板输入框，两个入口只差一个已存在的会话身份。
    await page.getByTestId("assist-empty-suggest-requirement").click();
    await expect(page.getByTestId("assist-draft")).toHaveValue(/帮我梳理这个需求：/u);
    await page.screenshot({ path: "results/empty-welcome-task-session.png" });
  });

  for (const entry of [`/tasks/${taskId}?skill=assist&session=${sessionId}`, `/agent?session=${sessionId}`]) {
    test(`任务会话旧入口归一且恢复目录：${entry}`, async ({ page }) => {
      await installRoutes(page); await page.goto(entry); await connect(page);
      await expect(page).toHaveURL(new RegExp(`/agent\\?.*work=${taskId}`));
      await expect(page.getByTestId("collab-conversation-toolbar")).toBeVisible();
      await expect(page.getByTestId("folder-scope-options")).toHaveText("Research");
      await expect(page.getByTestId("assist-empty-welcome")).toBeVisible();
    });
  }

  test("发送只读消息只提交一次，完成后读取同一消息结果，不发起解释或执行", async ({ page }) => {
    await installRoutes(page);
    let sent = false;
    let completed = false;
    const posts: string[] = [];
    await page.route(`${apiBase}${prefix}/assist-sessions/${sessionId}/messages*`, async (route) => {
      if (route.request().method() === "POST") {
        posts.push(new URL(route.request().url()).pathname);
        const body = route.request().postDataJSON() as { command_id: string };
        sent = true;
        return fulfillJson(route, { command_id: body.command_id, committed_at: "2026-10-16T00:00:00Z",
          result: { session_id: sessionId, user_message_id: "msg-user", assistant_message_id: "msg-assistant" }, links: {} }, 202);
      }
      const base = { session_id: sessionId, intent: "DISCUSS", sources: [], error_code: null,
        usage: { input_tokens: null, output_tokens: null }, cancel_requested: false };
      return fulfillJson(route, { items: sent ? [
        { ...base, id: "msg-user", seq: "1", role: "USER", status: "COMPLETED", content: "读取目录" },
        { ...base, id: "msg-assistant", seq: "2", role: "ASSISTANT", status: completed ? "COMPLETED" : "PENDING",
          content: completed ? "实际读取结果：README.md" : null }
      ] : [] });
    });
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().startsWith(apiBase) && !request.url().endsWith("/messages")) {
        posts.push(new URL(request.url()).pathname);
      }
    });
    await page.goto(`/agent?work=${taskId}`); await connect(page);
    await page.getByTestId("assist-draft").fill("读取目录");
    await page.getByTestId("assist-send").click();
    await expect(page.getByTestId("assist-transcript")).toContainText("等待生成");
    completed = true;
    await expect(page.getByTestId("assist-transcript")).toContainText("实际读取结果：README.md");
    expect(posts).toEqual([`${prefix}/assist-sessions/${sessionId}/messages`]);
    await expect(page.getByTestId("execution-summary")).toHaveCount(0);
  });

  test("项目 Assist 旧入口进入相同聊天外壳", async ({ page }) => {
    await installRoutes(page); await page.goto(`/projects/${projectId}?skill=assist`); await connect(page);
    await expect(page).toHaveURL(new RegExp(`/agent\\?.*project=${projectId}`));
    await expect(page.getByTestId("collab-conversation-toolbar")).toBeVisible();
    await expect(page.getByTestId("folder-scope-strip")).toBeVisible();
    await page.getByTestId("collab-conversation-inspector-toggle").click();
    await expect(page.getByTestId("collab-conversation-inspector")).toHaveClass("task-inspector");
    await expect(page.getByRole("tablist", { name: "工作详情分类" }).getByRole("tab")).toHaveText(["进展", "成果", "记录"]);
  });
});
