import { expect, test, type Page, type Route } from "@playwright/test";

// 删除会话时「正在看的那一条」的浏览器回归（2026-11-01，UI-SESSION-DELETE-ACTIVE）。
//
// 守的是用户指认的两件事，而且都在聊天页那一侧观察：
// 1. **删别的讨论，当前这条一动不动。** sessionId、URL、转录内容、侧栏 aria-current 与
//    active class 全部原样——同名不同 id 的两条尤其不能靠标题认错。
// 2. **删的就是当前这条，界面不留在孤儿页。** 服务端确认删除之后，聊天区不再显示那段
//    已经不存在的转录，也不再朝着它发送；收尾沿既有的「新对话」路由意图交给协作页这个
//    Owner，刷新后与服务端一致。
// 3. **结果未知不动当前会话。** 核对不到回执时停在待核实，当前讨论一行都不清。
//
// API 全部由 page.route 伪造，不连数据库、不调 Provider、不写任何真实业务事实。

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = `http://127.0.0.1:${process.env.RELAY_E2E_PORT ?? "4173"}`;
/** 本轮验收的前后截图目录（任务书指定的 tmp 子目录，只留必要证据）。 */
const evidenceDir = process.env.RELAY_DELETE_ACTIVE_EVIDENCE_DIR
  ?? "D:/Develop/Relay-Agent/tmp/UI-SESSION-DELETE-ACTIVE/screenshots";

/** 两段标题完全相同、只有 id 不同的讨论：正在看的那一条与另一条。 */
const currentId = "70000000-0000-4000-8000-000000000001";
const otherId = "70000000-0000-4000-8000-000000000002";
/** 第三条只在「结果未知」那一例里出现：删除命令发了但回执查不到。 */
const unknownId = "70000000-0000-4000-8000-000000000003";
const sameTitle = "关于上下文压缩";

const modelRuntimePath = /\/assist-messages\/([^/]+)\/model-runtime$/u;
const modelRuntimeBody = (messageId: string): unknown => ({ message_id: messageId, message_status: "COMPLETED",
  snapshot_available: false, preferred_model: null, candidate_models: [], current_candidate_model: null,
  actual_model: null, max_candidates: null, routing_status: null, failure_scope: null, failure_reason: null,
  retry_after_at: null, free_daily_remaining: null, switches: [], calls: [] });

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(),
    body: JSON.stringify(body) });
}

function session(id: string): unknown {
  return { id, workspace_id: workspaceId, project_id: null, task_id: null, title: sameTitle,
    status: "ACTIVE", revision: "1", created_at: "2026-11-01T08:00:00Z",
    updated_at: "2026-11-01T08:00:00Z", last_message_at: "2026-11-01T08:00:00Z",
    pinned_at: null, unread_at: null, has_messages: true };
}

/** 每条讨论各一句可分辨的内容：转录里读到哪句，就是在看哪条。 */
function messagesOf(id: string): unknown[] {
  return [{ id: `u-${id}`, session_id: id, seq: "1", role: "USER", status: "COMPLETED",
    intent: "DISCUSS", created_at: "2026-11-01T08:00:00Z", updated_at: "2026-11-01T08:00:00Z",
    content: `${id} 的第一句`, error_code: null, provider_error_kind: null, sources: [],
    skill: null, cancel_requested: false,
    usage: { input_tokens: 8, output_tokens: 0, cache_read_tokens: null, cache_creation_tokens: null } }];
}

/** 假服务端的三件可观察事实：谁真被删了、删除命令按哪个 id 发过、回执被查了几次。 */
interface FakeState {
  readonly deleted: Set<string>;
  readonly deleteCalls: string[];
}

async function installRoutes(page: Page, options: { unknownId?: string } = {}): Promise<FakeState> {
  const deleted = new Set<string>();
  const deleteCalls: string[] = [];
  const catalog = [currentId, otherId, ...(options.unknownId === undefined ? [] : [options.unknownId])];
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/model-port`) return fulfillJson(route, { provider: "fake",
      configured: false, model: null, base_url: null, max_call_tokens: null });
    if (path === `${prefix}/assist-sessions`) {
      const status = new URL(request.url()).searchParams.get("status");
      if (status === "ARCHIVED") return fulfillJson(route, { items: [] });
      return fulfillJson(route, { items: catalog.filter((id) => !deleted.has(id)).map(session) });
    }
    const single = /\/assist-sessions\/([^/]+)$/u.exec(path);
    if (single !== null) {
      const id = String(single[1]);
      // 已删的会话按 404 返回：任何重读都不该把它带回来，这既是契约也是竞态探针。
      if (deleted.has(id)) return fulfillJson(route, { code: "RESOURCE_NOT_FOUND", detail: "gone" }, 404);
      if (!catalog.includes(id)) return fulfillJson(route, { code: "RESOURCE_NOT_FOUND", detail: "gone" }, 404);
      return fulfillJson(route, session(id));
    }
    const messages = /\/assist-sessions\/([^/]+)\/messages$/u.exec(path);
    if (messages !== null) {
      const id = String(messages[1]);
      if (deleted.has(id)) return fulfillJson(route, { code: "RESOURCE_NOT_FOUND", detail: "gone" }, 404);
      return fulfillJson(route, { items: catalog.includes(id) ? messagesOf(id) : [] });
    }
    const deletion = /\/assist-sessions\/([^/]+)\/delete$/u.exec(path);
    if (deletion !== null && request.method() === "POST") {
      const target = String(deletion[1]);
      const body = JSON.parse(request.postData() ?? "{}") as { command_id: string };
      deleteCalls.push(target);
      if (target === options.unknownId) {
        // 服务端内部错误且查不到回执：这一条到底删没删尚未确定，界面不许替用户猜。
        return fulfillJson(route, { code: "INTERNAL_ERROR", detail: "请求未能完成，请通过 request_id 核对。",
          request_id: "req-delete-unknown" }, 500);
      }
      deleted.add(target);
      return fulfillJson(route, { command_id: body.command_id, committed_at: "2026-11-01T08:05:00Z",
        result: { session_id: target, revision: "1", deleted_messages: 1, deleted_attachments: 0,
          deleted_at: "2026-11-01T08:05:00.000Z" } });
    }
    const receipt = /\/commands\/([^/]+)$/u.exec(path);
    if (receipt !== null) {
      return fulfillJson(route, { code: "COMMAND_NOT_FOUND", detail: "没有这条回执" }, 404);
    }
    const projection = /\/assist-sessions\/([^/]+)\/(plans|goal)$/u.exec(path);
    if (projection !== null) {
      return fulfillJson(route, projection[2] === "plans" ? { latest: null, versions: [] }
        : { goal: null, rounds: [] });
    }
    const runtime = modelRuntimePath.exec(path);
    if (runtime !== null) return fulfillJson(route, modelRuntimeBody(decodeURIComponent(runtime[1])));
    return fulfillJson(route, { items: [], next_cursor: null });
  });
  return { deleted, deleteCalls };
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("session-delete-active-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

/** 侧栏高亮的两路信号一起读：无障碍属性与视觉 class 必须落在同一行上。 */
async function highlight(page: Page, id: string): Promise<{ current: string | null, active: boolean }> {
  const row = page.getByTestId(`recent-work-${id}`);
  if (await row.count() === 0) return { current: null, active: false };
  return { current: await row.getAttribute("aria-current"),
    active: await row.evaluate((element) => element.classList.contains("recent-work-item--active")) };
}

/** 转录此刻属于谁：槽位上的 session 身份集合，空即聊天区已不显示任何一段讨论。 */
async function transcriptOwners(page: Page): Promise<string[]> {
  return [...new Set(await page.locator("[data-chat-timeline-slot]").evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-timeline-session") ?? "")))];
}

async function deleteFromRowMenu(page: Page, id: string): Promise<void> {
  await page.getByTestId(`recent-work-${id}`).hover();
  await page.getByTestId(`recent-work-menu-${id}`).click();
  await page.getByTestId(`recent-work-delete-${id}`).click();
  await page.getByTestId(`session-delete-confirm-${id}`).click();
}

test.describe("删除会话与当前讨论", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test("删另一段同名讨论：当前会话的转录、路由与侧栏高亮一律不动", async ({ page }) => {
    const server = await installRoutes(page);
    await page.goto(`/agent?session=${currentId}`);
    await connect(page);
    await expect(page.locator(`[data-chat-timeline-slot][data-timeline-session="${currentId}"]`)).toBeVisible();
    await expect(page.getByTestId(`recent-work-${currentId}`)).toHaveAttribute("aria-current", "true");
    await page.screenshot({ path: `${evidenceDir}/01-before-delete-other.png` });

    await deleteFromRowMenu(page, otherId);

    await expect(page.getByTestId(`recent-work-${otherId}`)).toHaveCount(0);
    // 认错行只剩一条路可走：按标题。两条标题逐字相同，所以这里必须仍看得见当前那一句。
    expect(server.deleteCalls).toEqual([otherId]);
    await expect(page).toHaveURL(new RegExp(`/agent\\?session=${currentId}$`, "u"));
    await expect(page.locator("[data-chat-timeline-slot]")).toHaveCount(1);
    expect(await transcriptOwners(page)).toEqual([currentId]);
    expect(await highlight(page, currentId)).toEqual({ current: "true", active: true });
    await page.screenshot({ path: `${evidenceDir}/02-after-delete-other.png` });
  });

  test("删的正是当前讨论：服务端确认之后离开孤儿页，落到空白新对话", async ({ page }) => {
    const server = await installRoutes(page);
    await page.goto(`/agent?session=${currentId}`);
    await connect(page);
    await expect(page.locator(`[data-chat-timeline-slot][data-timeline-session="${currentId}"]`)).toBeVisible();

    await deleteFromRowMenu(page, currentId);

    // 已删除的转录不再留在聊天区，也不再是发送目标：聊天区交回协作页的空白首条输入器。
    await expect(page.locator("[data-chat-timeline-slot]")).toHaveCount(0);
    expect(await transcriptOwners(page)).toEqual([]);
    await expect(page.getByTestId("assist-first-message")).toBeVisible();
    await expect(page.getByTestId("assist-first-draft")).toBeVisible();
    await expect(page.getByTestId(`recent-work-${currentId}`)).toHaveCount(0);
    expect(server.deleteCalls).toEqual([currentId]);
    await expect(page).toHaveURL(/\/agent\?new=/u);
    await page.screenshot({ path: `${evidenceDir}/03-after-delete-current.png` });

    // 刷新一次：界面回到服务端事实，那一行不会借着重读回来，也不留一个空高亮。
    await page.reload();
    await connect(page);
    await expect(page.getByTestId(`recent-work-${currentId}`)).toHaveCount(0);
    await expect(page.getByTestId(`recent-work-${otherId}`)).toHaveCount(1);
    expect(await highlight(page, currentId)).toEqual({ current: null, active: false });
    await page.screenshot({ path: `${evidenceDir}/04-current-after-refresh.png` });
  });

  test("删除结果未知时不清当前讨论：停在待核实，转录与高亮原样保留", async ({ page }) => {
    const server = await installRoutes(page, { unknownId });
    await page.goto(`/agent?session=${currentId}`);
    await connect(page);
    await expect(page.locator(`[data-chat-timeline-slot][data-timeline-session="${currentId}"]`)).toBeVisible();

    // 先删一条结果未知的（不是当前这条）：当前讨论一行都不受影响。
    await deleteFromRowMenu(page, unknownId);
    const panel = page.locator(`[data-testid="recent-work-panel-${unknownId}"]`);
    await expect(panel).toContainText("删除结果待核实");
    expect(await highlight(page, currentId)).toEqual({ current: "true", active: true });
    expect(await transcriptOwners(page)).toEqual([currentId]);
    await page.screenshot({ path: `${evidenceDir}/05-unresolved-keeps-current.png` });

    // 核对回执仍查不到：既不清当前会话，也不换 command_id 重发删除命令。
    await page.getByTestId(`session-delete-recheck-${unknownId}`).click();
    await expect(page.getByTestId(`recent-work-${unknownId}`)).toHaveCount(1);
    expect(server.deleteCalls).toEqual([unknownId]);
    expect(await transcriptOwners(page)).toEqual([currentId]);
    expect(await highlight(page, currentId)).toEqual({ current: "true", active: true });
  });
});
