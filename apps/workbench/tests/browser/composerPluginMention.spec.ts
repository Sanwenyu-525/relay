import { expect, test, type Page, type Route } from "@playwright/test";

// `@` 插件菜单与输入内联芯片（2026-10-25）的真实 Chromium 几何与键盘用例。
//
// jsdom（tests/pluginIcons.spec.tsx）不量几何也不执行按键默认行为，这里守住两条
// 只能真实浏览器验证的判据：
//   ① 菜单行内左对齐（用户指认「菜单要左对齐」）：图标与名称相邻靠左，
//      不被命令菜单的 space-between 顶到行的两端；菜单外壳贴输入框左缘。
//      行内对齐靠 `.chat-mention-option` 压过通用 `span:first-child` 的特异性
//      ((0,4,0) > (0,3,1))——数字接近，一旦有人动这两条规则就会悄悄翻车，必须量测。
//   ② 芯片整体删除（用户指认「作为一个整体，不能删里面的字」；同日第二轮按
//      「为什么有这个状态、要按两次」改为一次删除）：真实键盘退格一次删掉整枚——
//      keydown 里把选区预置到整段 mention 再放行，删除由原生执行（Ctrl+Z 可撤销），
//      全程不出现「@电脑操」这类把芯片拆碎、图标退化成裸 @ 的中间态。
//
// 只连页面内夹具：不连数据库、不调 Provider、不写任何真实业务事实。

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const sessionId = "66666666-6666-4666-8666-666666666666";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = "http://127.0.0.1:4173";

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin, "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(), body: JSON.stringify(body) });
}

const session = { id: sessionId, workspace_id: workspaceId, project_id: projectId, task_id: taskId,
  title: "插件菜单量测会话", status: "ACTIVE", revision: "1",
  working_resource_id: "99999999-9999-4999-8999-999999999999",
  context: { project_goals: [], working_directory: {
    resource_id: "99999999-9999-4999-8999-999999999999", canonical_root: "D:\\Work\\Research" } },
  created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z" };

async function installRoutes(page: Page): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/tasks/${taskId}`) return fulfillJson(route, { id: taskId, project_id: projectId,
      title: "插件菜单量测任务", status: "IN_PROGRESS", mode: "ME", revision: "2",
      created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z",
      executor: { kind: "HUMAN", run_id: null, ownership_epoch: "1" },
      current_completion_id: null, waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [],
      allowed_actions: [],
      acceptance: { acceptance_revision: "2", objective: "量测。", source: "CREATE",
        created_at: "2026-10-16T00:00:00Z", criteria: [] },
      dependencies: [] });
    if (path === `${prefix}/projects/${projectId}`) return fulfillJson(route, { id: projectId,
      title: "插件菜单量测项目", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
    if (path === `${prefix}/search`) return fulfillJson(route, { items: [], next_cursor: null });
    if (path === `${prefix}/model-port`) return fulfillJson(route, { provider: "fake",
      configured: false, model: null, base_url: null, max_call_tokens: null });
    if (path === `${prefix}/assist-sessions`) return fulfillJson(route, { items: [session] });
    if (path === `${prefix}/assist-sessions/${sessionId}`) return fulfillJson(route, session);
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return fulfillJson(route, { items: [] });
    if (path === `${prefix}/skill-definitions`) return fulfillJson(route, { items: [] });
    return fulfillJson(route, { items: [], next_cursor: null });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("mention-geometry-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

async function openConversation(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1162, height: 782 });
  await installRoutes(page);
  await page.goto(`/agent?work=${taskId}&session=${sessionId}`);
  await connect(page);
  await page.getByTestId("collab-conversation-toolbar").waitFor({ timeout: 20_000 });
}

test("@ 菜单行内左对齐：图标与名称相邻靠左，菜单贴输入框左缘", async ({ page }) => {
  await openConversation(page);
  const draft = page.getByTestId("assist-draft");
  await draft.click();
  await draft.fill("@");
  await page.getByTestId("chat-mention-menu").waitFor({ timeout: 10_000 });

  const layout = await page.evaluate(() => {
    const menu = document.querySelector('[data-testid="chat-mention-menu"]')!;
    const option = menu.querySelector('[role="option"]')!;
    const span = option.querySelector(".chat-mention-option")!;
    const icon = option.querySelector("img.plugin-icon")!;
    const label = option.querySelector("strong")!;
    const textarea = document.querySelector('[data-testid="assist-draft"]') as HTMLTextAreaElement;
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, width: r.width };
    };
    return {
      justifyContent: getComputedStyle(span).justifyContent,
      icon: box(icon), label: box(label), option: box(option),
      menuLeft: box(menu).left, textareaLeft: box(textarea).left,
    };
  });
  const iconToLabelGap = layout.label.left - layout.icon.right;
  const labelToOptionRight = layout.option.right - layout.label.right;
  // 图标与名称相邻（同一行、间距只有既有 gap），名称没有被 space-between 顶到行尾。
  expect(layout.justifyContent, "菜单行内应压过命令菜单的 space-between").toBe("flex-start");
  expect(iconToLabelGap, "图标与名称应相邻").toBeGreaterThan(0);
  expect(iconToLabelGap, "图标与名称的间距应只是既有 gap（约 8px），不是被顶开").toBeLessThan(24);
  expect(labelToOptionRight, "名称右缘应远离选项右缘（不顶到行的另一端）").toBeGreaterThan(200);
  // 菜单外壳与输入框左缘对齐（用户指认「菜单要左对齐」）。
  expect(Math.abs(layout.menuLeft - layout.textareaLeft)).toBeLessThanOrEqual(1);
});

test("真实键盘删除闭环：退格一次删掉整枚芯片，不出现拆碎中间态，Ctrl+Z 可撤销", async ({ page }) => {
  await openConversation(page);
  const draft = page.getByTestId("assist-draft");
  await draft.click();
  await draft.fill("@");
  await page.getByTestId("chat-mention-menu").waitFor({ timeout: 10_000 });
  await page.keyboard.press("Enter");
  await expect(draft).toHaveValue("@电脑操控 ", { timeout: 5_000 });
  await expect(page.locator('[data-plugin-chip="computer"]')).toBeVisible();

  const state = () => page.evaluate(() => {
    const textarea = document.querySelector('[data-testid="assist-draft"]') as HTMLTextAreaElement;
    return { value: textarea.value, from: textarea.selectionStart, to: textarea.selectionEnd,
      chip: document.querySelector("[data-plugin-chip]")?.textContent ?? null };
  });

  // 退格一：删掉尾随空格（原生行为，芯片完整保留）。
  await page.keyboard.press("Backspace");
  let snap = await state();
  expect(snap.value, "第一次退格只删尾随空格").toBe("@电脑操控");
  expect(snap.chip, "芯片不能先碎掉").toBe("电脑操控");

  // 退格二：选区预置到整段 + 原生删除，一次按键删掉整枚（无「@电脑操」中间态）。
  await page.keyboard.press("Backspace");
  snap = await state();
  expect(snap.value, "一次退格删掉整枚，不许逐字拆").toBe("");
  expect(snap.chip).toBeNull();
  expect(snap.from, "光标落回删除点").toBe(0);

  // 删除走原生编辑栈：Ctrl+Z 撤销恢复整枚 mention（程序化删文本会断撤销链，
  // 这是「预置选区+放行」方案的存在理由）。
  await page.keyboard.press("Control+z");
  snap = await state();
  expect(snap.value, "Ctrl+Z 应恢复被删的整枚 mention").toBe("@电脑操控");
  expect(snap.chip, "撤销后芯片同步回来").toBe("电脑操控");

  // 光标点进芯片中间再退格，同样一次删整枚。
  await draft.fill("@电脑操控 帮我截图");
  await page.evaluate(() => {
    const textarea = document.querySelector('[data-testid="assist-draft"]') as HTMLTextAreaElement;
    textarea.setSelectionRange(3, 3);
    textarea.dispatchEvent(new Event("select", { bubbles: true }));
  });
  await page.keyboard.press("Backspace");
  snap = await state();
  expect(snap.value, "点进芯片中间退格同样一次删整枚").toBe(" 帮我截图");
  expect(snap.chip).toBeNull();
  expect(snap.from).toBe(0);
});
