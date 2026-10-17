import { expect, test, type Page, type Route } from "@playwright/test";

// 2026-10-17 用户指令：模型选择改成锚定在触发键上方的下拉清单，不要居中弹窗；
// 清单只显示模型名（参考图里的「倍率」那一列不做）。这条 spec 核对真实渲染：
// 弹层语言与输入框「+」菜单一致、向上锚定、限高内部滚动、点条目即应用并收起、
// 全程除模型选择命令外零写操作。只连页面内夹具：不连数据库、不调 Provider。

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const sessionId = "66666666-6666-4666-8666-666666666666";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = "http://127.0.0.1:4173";
const defaultModel = "fixture/default:free";
const modelCount = 12;

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin, "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(), body: JSON.stringify(body) });
}

const session = { id: sessionId, workspace_id: workspaceId, project_id: projectId, task_id: taskId,
  title: "关于确定实验评价指标", status: "ACTIVE", revision: "1",
  working_resource_id: "99999999-9999-4999-8999-999999999999",
  context: { project_goals: [], working_directory: {
    resource_id: "99999999-9999-4999-8999-999999999999", canonical_root: "D:\\Work\\Research" } },
  created_at: "2026-10-17T00:00:00Z", updated_at: "2026-10-17T00:00:00Z" };

/** 会话首选：夹具里就是应用默认，所以「当前选择」段不会因失效而多出一条。 */
function selection(model: string, revision: string) {
  return { selection: { session_id: sessionId, connection: "openrouter", model, free_only: true, revision } };
}

function catalog() {
  return { configured: true, chat_configured: true, last_success_at: "2026-10-17T00:00:00Z",
    last_failure_reason: null, cache_stale: false, snapshot_seq: "9", free_count: modelCount,
    entries: Array.from({ length: modelCount }, (_unused, index) => ({
      source_model_id: `fixture/m${index + 1}:free`, is_free: true,
      display_name: `Controlled free ${index + 1}`, context_window: 65536,
      capabilities: { tools: true, text_input: true, text_output: true }
    })) };
}

async function installRoutes(page: Page, posts: string[], state: { model: string; revision: string }): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (request.method() === "POST") {
      posts.push(path);
      if (path === `${prefix}/assist-sessions/${sessionId}/chat-commands`) {
        const model = String(JSON.parse(request.postData() ?? "{}").text ?? "").replace(/^\/\S+\s*/u, "").trim();
        state.model = model; state.revision = "2";
        return fulfillJson(route, { command_id: JSON.parse(request.postData() ?? "{}").command_id,
          committed_at: "2026-10-17T00:00:01Z",
          result: { kind: "MODEL_SELECTION", ...selection(model, "2").selection } });
      }
      return fulfillJson(route, { items: [] });
    }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/model-catalog`) return fulfillJson(route, catalog());
    if (path === `${prefix}/model-port`) return fulfillJson(route, { provider: "openai-compatible",
      configured: true, model: defaultModel, base_url: "https://fixture.invalid/v1", max_call_tokens: 65536 });
    if (path === `${prefix}/assist-sessions/${sessionId}/model-selection`) return fulfillJson(route, selection(state.model, state.revision));
    if (path === `${prefix}/assist-sessions`) return fulfillJson(route, { items: [session] });
    if (path === `${prefix}/assist-sessions/${sessionId}`) return fulfillJson(route, session);
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return fulfillJson(route, { items: [] });
    if (path === `${prefix}/tasks/${taskId}`) return fulfillJson(route, { id: taskId, project_id: projectId,
      title: "整理实验评价指标", status: "IN_PROGRESS", mode: "ME", revision: "2",
      created_at: "2026-10-17T00:00:00Z", updated_at: "2026-10-17T00:00:00Z",
      executor: { kind: "HUMAN", run_id: null, ownership_epoch: "1" }, current_completion_id: null,
      waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
      acceptance: { acceptance_revision: "2", objective: "补齐基线与验收依据。", source: "CREATE",
        created_at: "2026-10-17T00:00:00Z", criteria: [] }, dependencies: [] });
    if (path === `${prefix}/projects/${projectId}`) return fulfillJson(route, { id: projectId,
      title: "Windows 桌面验收（测试）", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
    return fulfillJson(route, { items: [], next_cursor: null });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("model-dropdown-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

async function openSession(page: Page, posts: string[], state: { model: string; revision: string }) {
  await page.setViewportSize({ width: 1162, height: 782 });
  await installRoutes(page, posts, state);
  await page.goto(`/agent?work=${taskId}&session=${sessionId}`);
  await connect(page);
  await page.getByTestId("model-selector-open").waitFor({ timeout: 20_000 });
  await page.getByTestId("assist-composer").getByTestId("model-selector-open").waitFor({ timeout: 20_000 });
}

/** 弹层几何：向上锚定在触发键之上、不越出视口、清单限高内部滚动。 */
async function menuGeometry(page: Page) {
  return page.evaluate(() => {
    const trigger = document.querySelector('[data-testid="model-selector-open"]');
    const menu = document.querySelector('[data-testid="model-selector-menu"]');
    const list = document.querySelector(".model-selector-menu .model-selector-list");
    if (trigger === null || menu === null || list === null) throw new Error("缺少触发键、下拉层或清单");
    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const listElement = list as HTMLElement;
    const style = getComputedStyle(listElement);
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      menu: { top: Math.round(menuRect.top * 10) / 10, bottom: Math.round(menuRect.bottom * 10) / 10,
        left: Math.round(menuRect.left * 10) / 10, right: Math.round(menuRect.right * 10) / 10 },
      trigger: { top: Math.round(triggerRect.top * 10) / 10, left: Math.round(triggerRect.left * 10) / 10 },
      // 下拉层自身可命中：中心点必须落在这一层里，而不是被别的浮层盖住。
      hitSelf: (() => { const point = document.elementFromPoint(menuRect.left + menuRect.width / 2,
        menuRect.top + menuRect.height / 2); return menu.contains(point) ? "self" : "covered"; })(),
      listScroll: { scrollHeight: listElement.scrollHeight, clientHeight: listElement.clientHeight,
        scrollWidth: listElement.scrollWidth, clientWidth: listElement.clientWidth },
      listStyle: { maxHeight: style.maxHeight, overflowY: style.overflowY },
      dialogCount: document.querySelectorAll('[role="dialog"]').length,
      horizontalOverflow: (document.scrollingElement as HTMLElement).scrollWidth - (document.scrollingElement as HTMLElement).clientWidth
    };
  });
}

test.describe("模型选择下拉（2026-10-17 指令）", () => {
  test("下拉而非弹窗：向上锚定在触发键上方、限高内部滚动、页面无横向溢出", async ({ page }) => {
    const posts: string[] = [];
    await openSession(page, posts, { model: defaultModel, revision: "1" });
    await page.getByTestId("assist-composer").getByTestId("model-selector-open").click();
    const menu = page.getByTestId("model-selector-menu");
    await expect(menu).toBeVisible();
    const geometry = await menuGeometry(page);
    expect(geometry.dialogCount, "模型选择不再打开居中对话框").toBe(0);
    expect(geometry.menu.bottom, "下拉层必须锚定在触发键上方").toBeLessThanOrEqual(geometry.trigger.top + 0.5);
    expect(geometry.menu.left, "下拉层左缘越出视口").toBeGreaterThanOrEqual(-0.5);
    expect(geometry.menu.right, "下拉层右缘越出视口").toBeLessThanOrEqual(geometry.viewport.width + 0.5);
    expect(geometry.menu.top, "下拉层上缘越出视口").toBeGreaterThanOrEqual(-0.5);
    expect(geometry.hitSelf, "下拉层被别的浮层遮挡").toBe("self");
    expect(geometry.listStyle.overflowY, "清单必须纵向滚动").toBe("auto");
    expect(geometry.listStyle.maxHeight, "清单缺少 max-height").not.toBe("none");
    expect(geometry.listScroll.scrollHeight, "12 条模型应当溢出清单").toBeGreaterThan(geometry.listScroll.clientHeight);
    expect(geometry.listScroll.scrollWidth - geometry.listScroll.clientWidth, "清单横向溢出").toBe(0);
    expect(geometry.horizontalOverflow, "页面横向溢出").toBe(0);
    expect(posts, "打开下拉只读，不产生写命令").toEqual([]);
    await page.screenshot({ path: test.info().outputPath("model-selector-menu.png") });
  });

  test("清单只显示模型名：没有模型 ID 与倍率那一列", async ({ page }) => {
    const posts: string[] = [];
    await openSession(page, posts, { model: defaultModel, revision: "1" });
    await page.getByTestId("assist-composer").getByTestId("model-selector-open").click();
    const options = page.getByTestId("assist-composer").locator('.model-selector-menu [role="option"]');
    await expect(options).toHaveCount(modelCount + 1);
    const entries = await options.evaluateAll((items) => items.map((item) => ({
      text: item.textContent ?? "", title: item.getAttribute("title") ?? "",
      aria: item.getAttribute("aria-label") ?? "" })));
    // 「已配置模型」那一条按 ID 显示（夹具里它不在免费目录中）；其余每条只显示模型名。
    expect(entries.filter((entry) => entry.text === defaultModel)).toHaveLength(1);
    const free = entries.filter((entry) => entry.text !== defaultModel);
    expect(free).toHaveLength(modelCount);
    for (const entry of free) {
      expect(entry.text, "条目可见面只允许一个模型名").toMatch(/^Controlled free \d+$/u);
      expect(entry.text, "条目不显示模型 ID").not.toContain("fixture/");
      expect(entry.text, "条目不显示倍率").not.toMatch(/\d+(\.\d+)?\s*[xX×倍]/u);
      expect(entry.aria).toContain("·");
    }
    // ID、上下文与工具能力留在 hover title 上，不占可见列。
    const first = free.find((entry) => entry.text === "Controlled free 1");
    expect(first?.title).toContain("fixture/m1:free");
    expect(first?.title).toContain("上下文：65,536");
    expect(posts, "展开与 hover 只读").toEqual([]);
  });

  test("点条目即应用并收起：一条模型选择命令，触发键换成所选名字", async ({ page }) => {
    const posts: string[] = [];
    const state = { model: defaultModel, revision: "1" };
    await openSession(page, posts, state);
    const trigger = page.getByTestId("assist-composer").getByTestId("model-selector-open");
    await trigger.click();
    await page.getByTestId("assist-composer").getByRole("option", { name: "Controlled free 3 · fixture/m3:free", exact: true }).click();
    await expect(page.getByTestId("model-selector-menu")).toHaveCount(0);
    await expect(trigger).toContainText("Controlled free 3");
    expect(posts, "点条目只发模型选择命令").toEqual([`${prefix}/assist-sessions/${sessionId}/chat-commands`]);
    // 再开一次：当前首选已是刚选的那条，勾选标记留在它身上。
    state.revision = "2";
    await trigger.click();
    await expect(page.getByTestId("model-selector-menu")).toContainText("当前首选：fixture/m3:free");
    await expect(page.locator('.model-selector-menu [role="option"][aria-selected="true"] .model-selector-option-name'))
      .toHaveText("Controlled free 3");
  });

  test("点下拉之外一次即收起，Esc 收起并把焦点还给触发键，两者都零写命令", async ({ page }) => {
    const posts: string[] = [];
    await openSession(page, posts, { model: defaultModel, revision: "1" });
    const trigger = page.getByTestId("assist-composer").getByTestId("model-selector-open");
    await trigger.click();
    await expect(page.getByTestId("model-selector-menu")).toBeVisible();
    await page.mouse.click(20, 20);
    await expect(page.getByTestId("model-selector-menu")).toHaveCount(0);
    await trigger.click();
    await expect(page.getByTestId("model-selector-menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("model-selector-menu")).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(posts, "收起下拉不产生写命令").toEqual([]);
  });

  test("筛选只改清单：无匹配单独说明，不改动当前选择", async ({ page }) => {
    const posts: string[] = [];
    await openSession(page, posts, { model: defaultModel, revision: "1" });
    await page.getByTestId("assist-composer").getByTestId("model-selector-open").click();
    await page.getByTestId("assist-composer").getByRole("searchbox", { name: "筛选模型" }).fill("no-such-model");
    await expect(page.getByTestId("model-selector-menu")).toContainText("没有匹配的免费模型");
    await expect(page.locator('.model-selector-menu [role="option"]')).toHaveCount(1);
    await expect(page.locator('.model-selector-menu [role="option"][aria-selected="true"] .model-selector-option-name'))
      .toHaveText(defaultModel);
    expect(posts, "筛选只读").toEqual([]);
  });

  test("首条消息场景：点条目只写本地草稿，零命令", async ({ page }) => {
    const posts: string[] = [];
    await page.setViewportSize({ width: 1162, height: 782 });
    await installRoutes(page, posts, { model: defaultModel, revision: "1" });
    await page.goto("/agent?new=entry");
    await connect(page);
    const trigger = page.getByTestId("model-selector-open");
    await trigger.click();
    await expect(page.getByTestId("model-selector-menu")).toBeVisible();
    await page.getByRole("option", { name: "Controlled free 2 · fixture/m2:free", exact: true }).click();
    await expect(page.getByTestId("model-selector-menu")).toHaveCount(0);
    await expect(trigger).toContainText("Controlled free 2");
    expect(posts, "首条还没发送，选模型不能建会话或发消息").toEqual([]);
  });
});
