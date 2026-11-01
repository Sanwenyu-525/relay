import { expect, test, type Page, type Route } from "@playwright/test";

// 会话标题的系统命名（0157，2026-11-01 SESSION_AUTO_TITLE）。
//
// 真实 Chromium 里核对四件事：
// 1. **自动命名落回左栏。** 服务端把标题请求落定后，这一行不用点开就显示新标题；
//    等待期间没有第二套本地状态。
// 2. **手动命名先确认。** USER_DEFINED 的会话点「重新生成标题」先出现替换说明，
//    取消是初始焦点；受理后显示在途，不显示成功。
// 3. **终态才换标题。** 读回新标题后才更新这一行并给成功提示；模型不可用时保留原标题，
//    以停留提示说清真实原因。
// 4. **长标题省略且可查看完整名。** 行内单行省略，悬停摘要给出完整标题。
//
// API 全部由 page.route 伪造，不连数据库、不调 Provider；模型语义质量归后端集成用例。

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = `http://127.0.0.1:${process.env.RELAY_E2E_PORT ?? "4173"}`;
/** 验收证据：按任务书统一放在 tmp/SESSION-AUTO-TITLE/，不做全量截图归档。 */
const evidenceDir = "D:/Develop/Relay-Agent/tmp/SESSION-AUTO-TITLE";

const auto = "77777777-7777-4777-8777-777777777771";
const manual = "77777777-7777-4777-8777-777777777772";
const failing = "77777777-7777-4777-8777-777777777773";
const longTitle = "77777777-7777-4777-8777-777777777774";

const AUTO_PENDING = "UI-聊天消息布局整理中";
const AUTO_DONE = "UI-聊天消息布局优化";

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(),
    body: JSON.stringify(body) });
}

interface SessionRow {
  id: string; workspace_id: string; project_id: null; task_id: null;
  title: string; status: string; revision: string;
  created_at: string; updated_at: string; last_message_at: string;
  pinned_at: null; unread_at: null; has_messages: true;
  title_source: string;
  title_generation: Record<string, unknown> | null;
}

function session(id: string, title: string, titleSource: string,
  generation: Record<string, unknown> | null = null): SessionRow {
  return { id, workspace_id: workspaceId, project_id: null, task_id: null, title,
    status: "ACTIVE", revision: "1", created_at: "2026-11-01T10:00:00Z",
    updated_at: "2026-11-01T10:00:00Z", last_message_at: "2026-11-01T10:00:00Z",
    pinned_at: null, unread_at: null, has_messages: true,
    title_source: titleSource, title_generation: generation };
}

function pendingGeneration(kind: "AUTO" | "REGENERATE"): Record<string, unknown> {
  return { status: "PENDING", request_kind: kind, generator: null, error_code: null,
    requested_at: "2026-11-01T12:00:00.000Z", settled_at: null };
}

interface FakeState {
  readonly rows: Map<string, SessionRow>;
  /** 手动会话：命令受理之后，第一次重读这条会话时落定标题。 */
  pendingManual: boolean;
  manualReads: number;
  listReads: number;
  /** 自动会话在列表第几拍落定：证明确实由左栏轮询带回，而不是初次读取。 */
  autoSettlesAtRead: number;
  readonly writes: string[];
}

async function installRoutes(page: Page): Promise<FakeState> {
  const rows = new Map<string, SessionRow>([
    [auto, session(auto, AUTO_PENDING, "PROVISIONAL", pendingGeneration("AUTO"))],
    [manual, session(manual, "我手动起的名字", "USER_DEFINED")],
    [failing, session(failing, "模型调不通的讨论", "PROVISIONAL")],
    [longTitle, session(longTitle,
      "UI-聊天消息宽度与布局统一整理以及输入器间距与字号层级全面优化方案", "AI_GENERATED")],
  ]);
  const state: FakeState = { rows, pendingManual: false, manualReads: 0, listReads: 0,
    autoSettlesAtRead: 2, writes: [] };

  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/tasks`) return fulfillJson(route, { items: [], next_cursor: null });
    if (path === `${prefix}/projects`) return fulfillJson(route, { items: [], next_cursor: null });
    if (path === `${prefix}/assist-sessions`) {
      state.listReads += 1;
      // 左栏的既有轮询：初次读取仍是在途标题，第二拍才换成服务端已落定的标题。
      const pending = state.rows.get(auto);
      if (pending !== undefined && state.listReads >= state.autoSettlesAtRead &&
        (pending.title_generation as { status?: string } | null)?.status === "PENDING") {
        pending.title = AUTO_DONE;
        pending.title_source = "AI_GENERATED";
        pending.title_generation = { status: "COMPLETED", request_kind: "AUTO",
          generator: "MODEL", error_code: null,
          requested_at: "2026-11-01T12:00:00.000Z", settled_at: "2026-11-01T12:00:02.000Z" };
        pending.revision = "2";
      }
      const status = new URL(request.url()).searchParams.get("status");
      if (status === "ARCHIVED") return fulfillJson(route, { items: [] });
      return fulfillJson(route, { items: [...state.rows.values()] });
    }
    const command = /\/assist-sessions\/([^/]+)\/title\/generate$/u.exec(path);
    if (command !== null && request.method() === "POST") {
      const target = String(command[1]);
      state.writes.push(`generate:${target}`);
      const row = state.rows.get(target);
      if (row === undefined) return fulfillJson(route, { code: "RESOURCE_NOT_FOUND" }, 404);
      const commandBody = JSON.parse(request.postData() ?? "{}") as { command_id?: string };
      // 受理回执之后，会话行上先是一条 PENDING 投影：界面据此进入等待，而不是立刻判失败。
      row.title_generation = pendingGeneration("REGENERATE");
      // 手动会话：第一次重读这条会话开始算一拍，第二拍落定（界面每 1s 读一次）。
      if (target === manual) state.pendingManual = true;
      return fulfillJson(route, { command_id: commandBody.command_id,
        committed_at: "2026-11-01T12:00:00Z",
        result: { session_id: target, request_id: "99999999-9999-4999-8999-999999999999",
          status: "PENDING", revision: row.revision,
          requested_at: "2026-11-01T12:00:00.000Z" } });
    }
    const single = /\/assist-sessions\/([^/]+)$/u.exec(path);
    if (single !== null) {
      const target = String(single[1]);
      const row = state.rows.get(target);
      if (row === undefined) return fulfillJson(route, { code: "RESOURCE_NOT_FOUND" }, 404);
      if (target === manual && state.pendingManual) {
        state.manualReads += 1;
        if (state.manualReads >= 2) {
          row.title = "UI-聊天消息布局优化";
          row.title_source = "AI_GENERATED";
          row.title_generation = { status: "COMPLETED", request_kind: "REGENERATE",
            generator: "MODEL", error_code: null,
            requested_at: "2026-11-01T12:00:00.000Z", settled_at: "2026-11-01T12:00:02.000Z" };
          row.revision = "2";
          state.pendingManual = false;
        }
      }
      if (target === failing) {
        // 模型不可用：如实失败并保留原标题。
        row.title_generation = { status: "FAILED", request_kind: "REGENERATE",
          generator: null, error_code: "TITLE_MODEL_UNAVAILABLE",
          requested_at: "2026-11-01T12:00:00.000Z", settled_at: "2026-11-01T12:00:02.000Z" };
      }
      return fulfillJson(route, row);
    }
    if (path === `${prefix}/model-port`) {
      return fulfillJson(route, { provider: "fake", configured: false, model: null,
        base_url: null, max_call_tokens: null });
    }
    return fulfillJson(route, { items: [], next_cursor: null });
  });
  return state;
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("session-title-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

test.describe("会话标题系统命名", () => {
  test("自动标题落回左栏；手动命名先确认，终态才换标题", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const state = await installRoutes(page);
    await page.goto("/agent");
    await connect(page);
    await page.getByTestId(`recent-work-${auto}`).waitFor();

    // 自动命名的标题由左栏既有轮询带回：服务端的在途投影在初次读取里是 PENDING，
    // 落定后被列表读取换成新标题，这一行不需要点开或手动刷新。
    await expect(page.getByTestId(`recent-work-${auto}`)).toContainText(AUTO_DONE, { timeout: 12_000 });
    expect(state.listReads).toBeGreaterThanOrEqual(2);

    // 手动命名：先看到替换说明，初始焦点在取消。
    await page.getByTestId(`recent-work-${manual}`).hover();
    await page.getByTestId(`recent-work-menu-${manual}`).click();
    await page.getByTestId(`recent-work-regenerate-title-${manual}`).click();
    const panel = page.getByTestId(`recent-work-panel-${manual}`);
    await expect(panel).toContainText("你当前手动设置的标题会被替换");
    await expect(page.getByTestId(`session-title-regenerate-cancel-${manual}`)).toBeFocused();
    await page.getByTestId(`session-title-regenerate-confirm-${manual}`).click();
    await expect(page.getByTestId(`recent-work-title-generating-${manual}`)).toContainText("正在根据当前对话生成标题");
    await expect(page.getByTestId(`recent-work-${manual}`)).toContainText("我手动起的名字");
    await expect(page.getByTestId(`recent-work-${manual}`)).toContainText("UI-聊天消息布局优化", { timeout: 10_000 });
    await expect(page.getByTestId(`session-title-regenerated-${manual}`)).toContainText("已重新生成标题");
    expect(await page.getByTestId(`recent-work-${manual}`).getAttribute("aria-label"))
      .toContain("UI-聊天消息布局优化");
    await page.screenshot({ path: `${evidenceDir}/01-auto-and-regenerated-title.png` });
  });

  test("模型不可用时保留原标题，并在停留提示里说清原因", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const state = await installRoutes(page);
    await page.goto("/agent");
    await connect(page);
    await page.getByTestId(`recent-work-${failing}`).waitFor();
    await page.getByTestId(`recent-work-${failing}`).hover();
    await page.getByTestId(`recent-work-menu-${failing}`).click();
    await page.getByTestId(`recent-work-regenerate-title-${failing}`).click();
    await expect(page.getByTestId(`recent-work-title-generating-${failing}`)).toBeVisible();
    await expect(page.getByTestId(`recent-work-${failing}`)).toContainText("模型调不通的讨论");
    await expect(page.getByTestId(`recent-work-title-generate-failed-${failing}`))
      .toContainText("没有可用的模型配置", { timeout: 10_000 });
    expect(state.writes.filter((item) => item === `generate:${failing}`)).toHaveLength(1);
    expect((await page.getByTestId(`recent-work-${failing}`).textContent()) ?? "")
      .toContain("模型调不通的讨论");
    await page.screenshot({ path: `${evidenceDir}/02-title-generation-failed.png` });
  });

  test("长标题在行内省略，悬停摘要给出完整名称；窄窗口下菜单不越出视口", async ({ page }) => {
    // 800px 宽已是产品里较窄的桌面窗口；560px 会收起左栏，就测不到这一列。
    await page.setViewportSize({ width: 800, height: 720 });
    await installRoutes(page);
    await page.goto("/agent");
    await connect(page);
    const row = page.getByTestId(`recent-work-${longTitle}`);
    await row.waitFor();
    // 行内单行省略：可见文本仍完整，但排版是按 ellipsis 收口；完整名称在悬停摘要与 aria-label 上。
    const copy = row.locator(".recent-work-title");
    expect(await copy.evaluate((element) =>
      getComputedStyle(element).textOverflow)).toBe("ellipsis");
    await row.hover();
    await expect(page.getByTestId("recent-work-summary-title"))
      .toContainText("UI-聊天消息宽度与布局统一整理");
    await page.getByTestId(`recent-work-menu-${longTitle}`).click();
    const panelBox = await page.getByTestId(`recent-work-panel-${longTitle}`).boundingBox();
    expect(panelBox).not.toBeNull();
    const viewport = page.viewportSize()!;
    expect(panelBox!.x).toBeGreaterThanOrEqual(0);
    expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(viewport.width);
    expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(viewport.height);
    await page.screenshot({ path: `${evidenceDir}/03-long-title-and-narrow-menu.png` });
  });
});
