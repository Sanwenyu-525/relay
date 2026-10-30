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

test("@ 菜单行内左对齐、紧凑且无阴影：图标与名称相邻，菜单不铺满输入器", async ({ page }) => {
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
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const style = getComputedStyle(menu);
    return {
      justifyContent: getComputedStyle(span).justifyContent,
      icon: box(icon), label: box(label), option: box(option), menu: box(menu), textarea: box(textarea),
      boxShadow: style.boxShadow, filter: style.filter,
      border: `${style.borderTopWidth} ${style.borderTopStyle} ${style.borderTopColor}`,
      padding: style.padding,
      hint: menu.querySelector(".chat-command-hint") !== null
    };
  });
  const iconToLabelGap = layout.label.left - layout.icon.right;
  const labelToOptionRight = layout.option.right - layout.label.right;
  // 图标与名称相邻（同一行、间距只有既有 gap），名称没有被 space-between 顶到行尾。
  expect(layout.justifyContent, "菜单行内应压过命令菜单的 space-between").toBe("flex-start");
  expect(iconToLabelGap, "图标与名称应相邻").toBeGreaterThan(0);
  expect(iconToLabelGap, "图标与名称的间距应只是既有 gap，不是被顶开").toBeLessThan(24);
  expect(layout.icon.left - layout.option.left, "图标靠行首（只有选项内边距，约 8px）").toBeLessThan(16);
  expect(layout.icon.left - layout.option.left).toBeGreaterThanOrEqual(0);
  expect(labelToOptionRight, "名称右缘不顶到行的另一端（行内容靠左）").toBeGreaterThan(24);
  // 紧凑浮层（2026-10-29 用户指认「铺满输入器太重」）：宽度贴内容，远窄于输入器。
  expect(layout.menu.width, `菜单宽度应紧凑（实测 ${layout.menu.width}px）`).toBeLessThanOrEqual(320);
  expect(layout.menu.width, "菜单不铺满输入器").toBeLessThan(layout.textarea.width - 40);
  // 纯净表面 + 轻分隔边框，无阴影、无投影滤镜。
  expect(layout.boxShadow, "插件菜单的 computed box-shadow 必须是 none").toBe("none");
  expect(layout.filter, "插件菜单不得用 drop-shadow 滤镜代替阴影").toBe("none");
  expect(layout.border, "只有一条 1px 分隔色描边").toBe("1px solid rgb(232, 238, 232)");
  // 操作提示不再常驻占位（键盘说明已收进 aria-describedby）。
  expect(layout.hint, "菜单顶部不应再有常驻长篇提示").toBe(false);
  // 菜单外壳与输入框左缘对齐，且与输入器保持既有间距。
  expect(Math.abs(layout.menu.left - layout.textarea.left)).toBeLessThanOrEqual(1);
  expect(layout.textarea.top - layout.menu.bottom, "菜单与输入器之间保留既有 8px 间距").toBeGreaterThanOrEqual(6);
});

/* —— 2026-10-29 第四轮 P0：`@` 菜单只认「这一次键入」—— */
test("P0 选完插件删掉尾随空格：菜单绝不重开；整枚删除、撤销、点末尾、后接正文都不重开", async ({ page }) => {
  await openConversation(page);
  const draft = page.getByTestId("assist-draft");
  const menu = page.getByTestId("chat-mention-menu");
  await draft.click();
  // 真实键入查询 → 过滤到一枚 → Enter 选中，菜单立即关闭。
  await page.keyboard.type("@电");
  await expect(menu).toBeVisible({ timeout: 5_000 });
  await expect(menu.locator('[role="option"]')).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(draft).toHaveValue("@电脑操控 ", { timeout: 5_000 });
  await expect(menu).toHaveCount(0);
  await expect(page.locator('[data-plugin-chip="computer"]')).toBeVisible();

  // ① 本次 P0 的验收点：删除尾随空格后，菜单不得重新弹出来。
  await page.keyboard.press("Backspace");
  await expect(draft).toHaveValue("@电脑操控");
  await expect(page.locator('[data-plugin-chip="computer"]')).toBeVisible();
  // 留出重算/延迟的机会：仍然关闭（不是靠「删完立刻关」掩盖）。
  await page.waitForTimeout(300);
  await expect(menu).toHaveCount(0);

  // ② 继续退格：一次删掉整枚，菜单依旧不弹。
  await page.keyboard.press("Backspace");
  await expect(draft).toHaveValue("", { timeout: 5_000 });
  await expect(page.locator("[data-plugin-chip]")).toHaveCount(0);
  await page.waitForTimeout(150);
  await expect(menu).toHaveCount(0);

  // ③ Ctrl+Z 撤销恢复原文与芯片，也不重开。
  await page.keyboard.press("Control+z");
  await expect(draft).toHaveValue("@电脑操控", { timeout: 5_000 });
  await expect(page.locator('[data-plugin-chip="computer"]')).toBeVisible();
  await expect(menu).toHaveCount(0);

  // ④ 鼠标点击已选插件的末尾：不弹。
  const chipBox = (await page.locator('[data-plugin-chip="computer"]').boundingBox())!;
  await page.mouse.click(chipBox.x + chipBox.width - 1, chipBox.y + chipBox.height / 2);
  await page.keyboard.press("End");
  expect(await draft.evaluate((el) => (el as HTMLTextAreaElement).selectionStart)).toBe(5);
  await page.waitForTimeout(150);
  await expect(menu).toHaveCount(0);

  // ⑤ 在已有插件之后输入普通文字：不弹。
  await page.keyboard.type(" 帮我截图");
  await expect(draft).toHaveValue("@电脑操控 帮我截图", { timeout: 5_000 });
  await page.waitForTimeout(200);
  await expect(menu).toHaveCount(0);

  // ⑥ 只有在别处主动输入新的 `@` 才弹（触发状态与这一次键入、光标区间绑定）。
  await page.keyboard.press("End");
  await page.keyboard.type(" @Gi");
  await expect(menu).toBeVisible({ timeout: 5_000 });
  await expect(menu.locator('[role="option"]')).toHaveCount(1);
  await page.screenshot({ path: "output/plugin-mention-menu-20261029/trigger-final.png" });
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});

test("P0 粘贴已完成的插件文本不弹菜单；IME 组词期间同样不弹", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  await openConversation(page);
  const draft = page.getByTestId("assist-draft");
  const menu = page.getByTestId("chat-mention-menu");
  await page.evaluate(() => navigator.clipboard.writeText("@GitHub "));
  await draft.click();
  await page.keyboard.press("Control+v");
  await expect(draft).toHaveValue("@GitHub ", { timeout: 5_000 });
  await expect(page.locator('[data-plugin-chip="github"]')).toBeVisible();
  await page.waitForTimeout(300);
  await expect(menu).toHaveCount(0);

  // 中文输入法：组词串进 textarea（候选未提交）期间与提交之后都不得弹菜单。
  const cdp = await page.context().newCDPSession(page);
  await page.evaluate(() => {
    const textarea = document.querySelector('[data-testid="assist-draft"]') as HTMLTextAreaElement;
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  });
  await cdp.send("Input.imeSetComposition", { text: "@dian", selectionStart: 5, selectionEnd: 5 });
  await page.waitForTimeout(200);
  await expect(menu).toHaveCount(0);
  await cdp.send("Input.insertText", { text: "@" });
  await expect(draft).toHaveValue("@GitHub @", { timeout: 5_000 });
  await page.waitForTimeout(200);
  await expect(menu, "IME 提交的 @ 不是键入查询，不弹菜单").toHaveCount(0);
  await cdp.detach();
});

test("P0 首条消息输入器与已有会话输入器同一触发语义", async ({ page }) => {
  await installRoutes(page);
  await page.route("**/assist-sessions?*", (route) => route.fulfill({ status: 200, contentType: "application/json",
    headers: cors(), body: JSON.stringify({ items: [] }) }));
  await page.goto(`/agent?work=${taskId}`, { waitUntil: "domcontentloaded" });
  await connect(page);
  const firstDraft = page.getByTestId("assist-first-draft");
  await firstDraft.waitFor({ timeout: 20_000 });
  const menu = page.getByTestId("chat-mention-menu");
  await firstDraft.click();
  await page.keyboard.type("@电");
  await expect(menu).toBeVisible({ timeout: 5_000 });
  await page.keyboard.press("Enter");
  await expect(firstDraft).toHaveValue("@电脑操控 ", { timeout: 5_000 });
  await expect(menu).toHaveCount(0);
  await page.keyboard.press("Backspace");
  await expect(firstDraft).toHaveValue("@电脑操控");
  await page.waitForTimeout(300);
  await expect(menu, "首条消息输入器同样不得因删除空格重开菜单").toHaveCount(0);
  await expect(page.locator('[data-plugin-chip="computer"]')).toBeVisible();
});

test("菜单在 390 / 768 / 桌面与 125% / 150% 字号下不裁切、不铺满输入器", async ({ page }) => {
  await openConversation(page);
  const draft = page.getByTestId("assist-draft");
  const probe = () => page.evaluate(() => {
    const menu = document.querySelector('[data-testid="chat-mention-menu"]')!;
    const ul = menu.querySelector("ul")!;
    const textarea = document.querySelector('[data-testid="assist-draft"]') as HTMLTextAreaElement;
    const rect = menu.getBoundingClientRect(), ta = textarea.getBoundingClientRect();
    const rows = Array.from(menu.querySelectorAll('[role="option"]')).map((row) => {
      const r = row.getBoundingClientRect();
      return { width: Math.round(r.width * 100) / 100, height: Math.round(r.height * 100) / 100,
        visible: r.width > 0 && r.height > 0 };
    });
    return { width: Math.round(rect.width * 100) / 100, left: Math.round(rect.left * 100) / 100,
      right: Math.round(rect.right * 100) / 100, top: Math.round(rect.top * 100) / 100,
      bottom: Math.round(rect.bottom * 100) / 100, viewport: { w: window.innerWidth, h: window.innerHeight },
      textareaWidth: Math.round(ta.width * 100) / 100, rows,
      overflowY: getComputedStyle(ul).overflowY, maxHeight: getComputedStyle(ul).maxHeight };
  });
  const openMenu = async () => {
    await draft.click();
    await draft.fill("");
    await draft.fill("@");
    await page.getByTestId("chat-mention-menu").waitFor({ timeout: 5_000 });
  };

  for (const width of [390, 768, 1162]) {
    await page.setViewportSize({ width, height: 782 });
    await page.waitForTimeout(200);
    await openMenu();
    const m = await probe();
    expect(m.left, `${width}px 菜单左缘不出视口`).toBeGreaterThanOrEqual(0);
    expect(m.right, `${width}px 菜单右缘不出视口`).toBeLessThanOrEqual(m.viewport.w + 0.5);
    expect(m.top, `${width}px 菜单整体在视口内`).toBeGreaterThanOrEqual(0);
    expect(m.bottom, `${width}px 菜单整体在视口内`).toBeLessThanOrEqual(m.viewport.h);
    expect(m.width, `${width}px 菜单不铺满输入器`).toBeLessThan(m.textareaWidth - 24);
    expect(m.rows.every((row) => row.visible), `${width}px 三行都排得下`).toBe(true);
    expect(m.rows.every((row) => row.height <= 40), `${width}px 行高紧凑（${m.rows[0]!.height}px）`).toBe(true);
    expect(m.overflowY, "内容超高时在菜单内部滚动").toBe("auto");
    await page.screenshot({ path: `output/plugin-mention-menu-20261029/menu-${width}.png` });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("chat-mention-menu")).toHaveCount(0);
  }

  for (const scale of [125, 150]) {
    await page.setViewportSize({ width: 1162, height: 782 });
    await page.evaluate((percent) => { document.documentElement.style.fontSize = `${16 * percent / 100}px`; }, scale);
    await page.waitForTimeout(200);
    await openMenu();
    const m = await probe();
    expect(m.left).toBeGreaterThanOrEqual(0);
    expect(m.right, `${scale}% 字号下菜单右缘不出视口`).toBeLessThanOrEqual(m.viewport.w + 0.5);
    expect(m.width, `${scale}% 字号下仍不铺满输入器`).toBeLessThan(m.textareaWidth - 24);
    expect(m.rows.every((row) => row.visible), `${scale}% 字号下三行都排得下`).toBe(true);
    await page.screenshot({ path: `output/plugin-mention-menu-20261029/menu-zoom-${scale}.png` });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("chat-mention-menu")).toHaveCount(0);
  }
  await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
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

// —— 2026-10-26 独立验收三项 P1 修复的真实 Chromium 回归 ——

test("选区并集：全选含 mention 的整行一次删除得空串，Ctrl+Z 恢复全文与芯片", async ({ page }) => {
  await openConversation(page);
  const draft = page.getByTestId("assist-draft");
  await draft.click();
  await draft.fill("前文 @GitHub 后文");
  await page.locator('[data-plugin-chip="github"]').waitFor({ timeout: 5_000 });

  await page.keyboard.press("Control+a");
  await page.keyboard.press("Backspace");
  await expect(draft).toHaveValue("", { timeout: 5_000 });
  expect(page.locator("[data-plugin-chip]")).toHaveCount(0);

  // 一次原生删除 = 一个撤销条目：Ctrl+Z 恢复整行原文与芯片，而不是逐字复活。
  await page.keyboard.press("Control+z");
  await expect(draft).toHaveValue("前文 @GitHub 后文", { timeout: 5_000 });
  await expect(page.locator('[data-plugin-chip="github"]')).toBeVisible();
});

test("选区并集：跨两枚 mention 的部分选择按 Backspace，删除范围不缩小", async ({ page }) => {
  await openConversation(page);
  const draft = page.getByTestId("assist-draft");
  await draft.click();
  const full = "@GitHub 和 @浏览器操控 尾部";
  await draft.fill(full);
  await page.locator('[data-plugin-chip="browser"]').waitFor({ timeout: 5_000 });
  // 选 [2,12)：GitHub 尾部 + 「和 @浏览器」前半——旧实现会缩成第一枚整段。
  await page.evaluate(() => {
    const textarea = document.querySelector('[data-testid="assist-draft"]') as HTMLTextAreaElement;
    textarea.setSelectionRange(2, 12);
    textarea.dispatchEvent(new Event("select", { bubbles: true }));
  });
  await page.keyboard.press("Backspace");
  await expect(draft).toHaveValue(full.slice(16), { timeout: 5_000 });
  await page.keyboard.press("Control+z");
  await expect(draft).toHaveValue(full, { timeout: 5_000 });
});

test("发送 pending（禁用态）底层 mention 原文保持透明，无重影", async ({ page }) => {
  await openConversation(page);
  const draft = page.getByTestId("assist-draft");
  await draft.click();
  await draft.fill("@电脑操控 帮我截图");
  await page.locator('[data-plugin-chip="computer"]').waitFor({ timeout: 5_000 });
  // 正常态（芯片开）textarea 正文透明是基线。
  const colors = () => page.evaluate(() => {
    const textarea = document.querySelector('[data-testid="assist-draft"]') as HTMLTextAreaElement;
    const style = getComputedStyle(textarea);
    return { color: style.color, fill: (style as CSSStyleDeclaration & { webkitTextFillColor: string }).webkitTextFillColor,
      disabled: textarea.disabled, chips: document.querySelector(".chat-command-surface")?.getAttribute("data-chips") };
  });
  const normal = await colors();
  expect(normal.color, "芯片态正文透明").toBe("rgba(0, 0, 0, 0)");

  // 挂起消息 POST：pending 期间 textarea disabled 且草稿仍含 mention。
  await page.route("**/api/v1/workspaces/*/assist-sessions/*/messages", () => new Promise(() => {}));
  await page.getByTestId("assist-send").click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="assist-draft"]') as HTMLTextAreaElement).disabled,
    undefined, { timeout: 10_000 });
  const pendingState = await colors();
  expect(pendingState.chips, "pending 期间草稿未清空，芯片仍开").toBe("on");
  expect(pendingState.disabled).toBe(true);
  // 缺陷形态：禁用规则 (0,3,1) 把正文刷回实色，芯片底下透出「@电脑操控」原文重影。
  expect(pendingState.color, "禁用态仍透明（无重影）").toBe("rgba(0, 0, 0, 0)");
  expect(pendingState.fill, "-webkit-text-fill-color 同步透明").toBe("rgba(0, 0, 0, 0)");
  await page.screenshot({ path: "output/plugin-icons-acceptance-20261025/pending-disabled-no-ghost.png" });
});

test("gutter 补偿幂等：滚动、缩放反复触发 padding 稳定，芯片与 mention 对齐", async ({ page }) => {
  await openConversation(page);
  await page.setViewportSize({ width: 800, height: 600 });
  const draft = page.getByTestId("assist-draft");
  await draft.click();
  // 长草稿：超出 textarea max-height(40dvh) 出纵向滚动条。
  const sentence = "帮我逐段核对这份安排的优先级、依赖与验收条件，";
  await draft.fill(`@电脑操控 ${sentence.repeat(12)}`);
  await page.locator('[data-plugin-chip="computer"]').waitFor({ timeout: 5_000 });
  const hasGutter = await page.evaluate(() => {
    const textarea = document.querySelector('[data-testid="assist-draft"]') as HTMLTextAreaElement;
    return textarea.offsetHeight < textarea.scrollHeight;
  });
  expect(hasGutter, "夹具应产生框内滚动").toBe(true);

  const padding = () => page.evaluate(() => {
    const mirror = document.querySelector(".chat-command-mirror")!;
    return { inline: (mirror as HTMLElement).style.paddingRight, computed: getComputedStyle(mirror).paddingRight };
  });
  const first = await padding();
  expect(first.computed, "有 gutter 时补偿生效").not.toBe("");

  // 反复触发重算：滚动 ×3 + 视口缩放（ResizeObserver 路径）×2，padding 必须是同一绝对值。
  for (let round = 0; round < 3; round += 1) {
    await page.evaluate(() => {
      const textarea = document.querySelector('[data-testid="assist-draft"]') as HTMLTextAreaElement;
      textarea.scrollTop += 24;
      textarea.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
  }
  const afterScrolls = await padding();
  expect(afterScrolls.computed, "滚动重算不叠加").toBe(first.computed);
  await page.setViewportSize({ width: 700, height: 600 });
  await page.waitForTimeout(120);
  const afterResize = await padding();
  expect(afterResize.computed, "ResizeObserver 重算不叠加").toBe(afterScrolls.computed);
  await page.setViewportSize({ width: 800, height: 600 });
  await page.waitForTimeout(120);
  expect((await padding()).computed, "宽度恢复后补偿回到同宽档").toBe(first.computed);

  // 芯片矩形仍与 mention 矩形对齐（滚动后镜像层同步）。
  const align = await page.evaluate(() => {
    const box = (el: Element) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, h: r.height }; };
    const span = document.querySelector('[data-mention-start="0"]')!;
    const chip = document.querySelector("[data-plugin-chip]")!;
    return { span: box(span), chip: box(chip) };
  });
  expect(Math.abs(align.chip.l - align.span.l), "芯片左缘对齐 mention").toBeLessThanOrEqual(1);
  expect(Math.abs(align.chip.t - align.span.t), "芯片顶对齐 mention").toBeLessThanOrEqual(1);
  await page.screenshot({ path: "output/plugin-icons-acceptance-20261025/gutter-chips-scrolled.png" });

  // gutter 消失（清空草稿）后补偿恢复：padding 回到无补偿基础值。
  await draft.fill("普通草稿，没有插件");
  await page.waitForFunction(() => document.querySelector(".chat-command-mirror") === null, undefined, { timeout: 5_000 });
  await draft.fill(`@GitHub ${sentence}`);
  await page.locator('[data-plugin-chip="github"]').waitFor({ timeout: 5_000 });
  const restored = await page.evaluate(() => {
    const textarea = document.querySelector('[data-testid="assist-draft"]') as HTMLTextAreaElement;
    const mirror = document.querySelector(".chat-command-mirror")!;
    const gutter = textarea.offsetWidth - textarea.clientWidth;
    return { gutter, computed: getComputedStyle(mirror).paddingRight };
  });
  if (restored.gutter === 0) {
    const inline = await page.evaluate(() => (document.querySelector(".chat-command-mirror") as HTMLElement).style.paddingRight);
    expect(inline, "无 gutter 时不得残留补偿").toBe("");
  } else {
    expect(restored.computed, "重新出滚动条后按当前 gutter 绝对补偿").not.toBe("");
  }
});

test("首条消息输入器：pending 禁用态同样无重影（与已有会话输入器分别检查）", async ({ page }) => {
  await installRoutes(page);
  // 后注册的路由优先：把会话清单清空，页面才会走 deferSessionCreation 的首条消息输入器。
  await page.route("**/assist-sessions?*", (route) => route.fulfill({ status: 200, contentType: "application/json", headers: cors(), body: JSON.stringify({ items: [] }) }));
  await page.goto(`/agent?work=${taskId}`, { waitUntil: "domcontentloaded" });
  await connect(page);
  // 无既有会话时展示首条消息输入器（assist-first-draft）。
  const firstDraft = page.getByTestId("assist-first-draft");
  await firstDraft.waitFor({ timeout: 20_000 });
  await firstDraft.click();
  await firstDraft.fill("@电脑操控 帮我截图");
  await page.locator('[data-plugin-chip="computer"]').waitFor({ timeout: 5_000 });
  // 挂起建会话 POST：creating/pendingFirst 期间输入器 disabled、草稿保留 mention。
  await page.route("**/api/v1/workspaces/*/assist-sessions", () => new Promise(() => {}));
  await page.getByTestId("assist-first-send").click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="assist-first-draft"]') as HTMLTextAreaElement).disabled,
    undefined, { timeout: 10_000 });
  const state = await page.evaluate(() => {
    const textarea = document.querySelector('[data-testid="assist-first-draft"]') as HTMLTextAreaElement;
    const style = getComputedStyle(textarea);
    return { color: style.color, fill: (style as CSSStyleDeclaration & { webkitTextFillColor: string }).webkitTextFillColor,
      chips: document.querySelector(".chat-command-surface")?.getAttribute("data-chips"),
      chip: document.querySelector("[data-plugin-chip]")?.textContent ?? null };
  });
  expect(state.chips).toBe("on");
  expect(state.color, "首条消息输入器禁用态仍透明").toBe("rgba(0, 0, 0, 0)");
  expect(state.fill).toBe("rgba(0, 0, 0, 0)");
  expect(state.chip).toBe("电脑操控");
  await page.screenshot({ path: "output/plugin-icons-acceptance-20261025/first-composer-pending-no-ghost.png" });
});
