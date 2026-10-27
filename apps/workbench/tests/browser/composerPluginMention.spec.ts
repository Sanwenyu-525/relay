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
