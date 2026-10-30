import { expect, test, type Page, type Route } from "@playwright/test";

// 普通会话右侧工具面板（2026-10-28 版面重整）在真实 Chromium 里的版面契约。
//
// 这一轮改的是「空间分配 + 页签层级 + 空态 + 底部抽屉」，因此判据都是几何与可见性，
// 不是「DOM 里有没有这个节点」：
//   ① 没有关联项目时默认落在真的能用的「网页」，文件/变更给出轻量空态并留一条出口；
//   ② 面板贴窗口右缘（不留意外留白），页签条不与收起键重叠、默认宽度下不横向溢出；
//   ③ 底部抽屉收起只有一行，展开体自己滚动且不压住上方页签；
//   ④ 窄窗沿用抽屉形态，聊天列宽度不因面板打开而变小；
//   ⑤ 六个页签全部可达：主入口是文字页签，辅助入口是图标页签（可访问名称与 title 仍在）。
//
// 只连页面内夹具：不连数据库、不调 Provider、零写请求。

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const sessionId = "66666666-6666-4666-8666-666666666666";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const projectId = "22222222-2222-4222-8222-222222222222";
const origin = "http://127.0.0.1:4173";

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(), body: JSON.stringify(body) });
}

/** 普通会话的会话行：`project` 为空＝未归属，非空＝服务端已确认归入该项目。 */
function sessionRow(project: string | null = null): unknown {
  return { id: sessionId, workspace_id: workspaceId, project_id: project, task_id: null,
    title: "整理实验评价指标", status: "ACTIVE", revision: "1", conversation_mode: "AGENT",
    assistant_profile_id: null, created_at: "2026-10-28T20:00:00Z", updated_at: "2026-10-28T20:10:00Z" };
}

interface RouteOptions {
  /** 会话归属：null＝未归属。工具面板的项目身份只认服务端这一份。 */
  project?: string | null;
  /** 该项目登记的受管目录；空数组＝有项目但没有受管目录。 */
  resources?: readonly unknown[];
}

const managedResource = { id: "res-1", project_id: projectId, canonical_root: "D:/Develop/MyProject",
  display_name: "MyProject", status: "ACTIVE", revision: "1", resource_epoch: "0",
  file_write_identity_bound: true };

async function installRoutes(page: Page, options: RouteOptions = {}): Promise<void> {
  const project = options.project ?? null;
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    const path = new URL(request.url()).pathname;
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/model-port`) return fulfillJson(route, { provider: "fake", configured: false,
      model: null, base_url: null, max_call_tokens: null });
    if (path === `${prefix}/model-port/verification`) return fulfillJson(route, {
      current_config_fingerprint: null, last: null, matches_current_config: false,
      worker_startup_validation: "NOT_CONFIGURED" });
    if (path === `${prefix}/assist-sessions`) return fulfillJson(route, { items: [sessionRow(project)] });
    if (path === `${prefix}/assist-sessions/${sessionId}`) return fulfillJson(route, sessionRow(project));
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return fulfillJson(route, { items: [] });
    if (path === `${prefix}/assist-sessions/${sessionId}/model-selection`) return fulfillJson(route, { model: null, revision: "0" });
    if (path === `${prefix}/assist-sessions/${sessionId}/goal`) return fulfillJson(route, { goal: null, rounds: [] });
    if (path === `${prefix}/assist-sessions/${sessionId}/plans`) return fulfillJson(route, { latest: null, versions: [] });
    if (path === `${prefix}/assist-proposals`) return fulfillJson(route, { items: [] });
    if (path === `${prefix}/skill-definitions`) return fulfillJson(route, { items: [] });
    if (path === `${prefix}/chat-commands`) return fulfillJson(route, { items: [] });
    if (path.startsWith(`${prefix}/conversation-execution-requests`)) return fulfillJson(route, { items: [] });
    if (path.startsWith(`${prefix}/learning`)) return fulfillJson(route, { items: [], epoch: "0" });
    if (path === `${prefix}/projects/${projectId}`) return fulfillJson(route, { id: projectId,
      title: "人机协作工作流研究", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
    if (path === `${prefix}/projects/${projectId}/state`) return fulfillJson(route, { project_id: projectId,
      revision: "1", phase_key: "GENERAL", next_action_task_id: null,
      selected_artifact_version_refs: [], completed_highlight_refs: [] });
    if (path === `${prefix}/projects/${projectId}/managed-resources`) {
      return fulfillJson(route, options.resources ?? [managedResource]);
    }
    if (path.startsWith(`${prefix}/projects/${projectId}/connections`)) return fulfillJson(route, []);
    return fulfillJson(route, { items: [], next_cursor: null });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("tools-panel-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

async function openSession(page: Page, width = 1440, height = 900, options: RouteOptions = {}): Promise<void> {
  await page.setViewportSize({ width, height });
  await installRoutes(page, options);
  await page.goto(`/agent?session=${sessionId}`);
  await connect(page);
  await page.getByTestId("assist-draft").waitFor({ timeout: 20_000 });
  await page.waitForLoadState("networkidle");
}

async function openTools(page: Page): Promise<void> {
  await page.getByTestId("collab-conversation-tools-toggle").click();
  await page.getByTestId("devtools-panel").waitFor({ timeout: 10_000 });
}

test.describe("普通会话的右侧工具面板（2026-10-28）", () => {
  test("没有关联项目时默认落在网页页签；文件与变更是轻量空态，并留一条出口", async ({ page }) => {
    await openSession(page);
    await openTools(page);
    const root = page.getByTestId("devtools-panel");
    // 开局不能是一屏「不可用」说明：默认给当前真的能用的网页。
    await expect(root).toHaveAttribute("data-tab", "WEB");
    await expect(page.getByTestId("devtools-tab-WEB")).toHaveAttribute("aria-selected", "true");

    await page.getByTestId("devtools-tab-FILES").click();
    const files = page.getByTestId("devtools-files-unavailable");
    await expect(files).toBeVisible();
    await expect(files).toContainText("尚未关联项目");
    await expect(files).toContainText("关联项目后，可查看其受管文件与 Git 变更。");
    // 安全边界只写一次，收在辅助说明里，不反复解释同一个概念。
    await expect(files.locator(".devtools-empty-note")).toHaveCount(1);
    // 空态不是死路：一键切到网页。
    await files.getByTestId("devtools-empty-open-web").click();
    await expect(root).toHaveAttribute("data-tab", "WEB");

    await page.getByTestId("devtools-tab-GIT").click();
    const git = page.getByTestId("devtools-git-unavailable");
    await expect(git).toContainText("尚未关联项目");
    await expect(git).toContainText("没有可核对的目录基线");
    await expect(git).toContainText("工作目录干净");
    // 空态不占满侧栏：说明块高度远小于面板可用高度，不铺成一张大卡片。
    const emptyBox = await git.boundingBox();
    const panelBox = await page.getByTestId("collab-conversation-tools").boundingBox();
    if (emptyBox === null || panelBox === null) throw new Error("缺少空态或面板几何");
    expect(emptyBox.height).toBeLessThan(panelBox.height / 2);
  });

  test("面板贴右缘、页签条不与收起键重叠、默认宽度下页签不横向溢出", async ({ page }) => {
    await openSession(page);
    await openTools(page);
    const geometry = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('[data-testid="collab-conversation-tools"]')!;
      const tabs = document.querySelector<HTMLElement>(".devtools-tabs")!;
      const close = document.querySelector<HTMLElement>(".devtools-close")!;
      const panelRect = panel.getBoundingClientRect();
      const tabsRect = tabs.getBoundingClientRect();
      const closeRect = close.getBoundingClientRect();
      return { panelRight: panelRect.right, panelLeft: panelRect.left, panelWidth: panelRect.width,
        tabsRight: tabsRect.right, closeLeft: closeRect.left, closeRight: closeRect.right,
        tabsScroll: tabs.scrollWidth, tabsClient: tabs.clientWidth,
        viewport: window.innerWidth,
        overflowX: document.scrollingElement!.scrollWidth - document.scrollingElement!.clientWidth };
    });
    // 贴窗口右缘：不留意外留白，也不出现双重边距。
    expect(geometry.panelRight).toBeCloseTo(geometry.viewport, 0);
    // 页签条右端在收起键左缘之前：页签永远不会钻到收起键底下。
    expect(geometry.tabsRight).toBeLessThanOrEqual(geometry.closeLeft + 0.5);
    // 收起键仍在面板内。
    expect(geometry.closeRight).toBeLessThanOrEqual(geometry.viewport + 0.5);
    // 默认宽度（288px）下六个页签一屏放得下，不靠横向滚动兜底。
    expect(geometry.tabsScroll - geometry.tabsClient).toBe(0);
    expect(geometry.overflowX).toBe(0);
    expect(geometry.panelWidth).toBeLessThanOrEqual(352);
  });

  test("底部执行输出收起只有一行；展开后自己滚动，且不压住上方页签", async ({ page }) => {
    await openSession(page);
    await openTools(page);
    const toggle = page.getByTestId("devtools-tab-OUTPUT");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    const collapsed = await page.evaluate(() => {
      const drawer = document.querySelector<HTMLElement>(".devtools-drawer")!;
      const tabs = document.querySelector<HTMLElement>(".devtools-header")!;
      return { drawer: Math.round(drawer.getBoundingClientRect().height),
        tabsBottom: Math.round(tabs.getBoundingClientRect().bottom) };
    });
    // 收起时只是一行（compact 控件高一档），不再是两条边框夹一条 44px 的条。
    expect(collapsed.drawer).toBeLessThanOrEqual(44);

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const expanded = await page.evaluate(() => {
      const body = document.querySelector<HTMLElement>(".devtools-drawer-body")!;
      const tabs = document.querySelector<HTMLElement>(".devtools-header")!;
      const style = getComputedStyle(body);
      return { display: getComputedStyle(body).display, overflowY: style.overflowY, maxHeight: style.maxHeight,
        tabsBottom: Math.round(tabs.getBoundingClientRect().bottom),
        bodyTop: Math.round(body.getBoundingClientRect().top) };
    });
    await expect(page.getByTestId("devtools-output")).toBeVisible();
    // 展开体自己滚动，且有高度上限：短窗口里不会把页签条顶出可视区。
    expect(expanded.overflowY).toBe("auto");
    expect(expanded.maxHeight).not.toBe("none");
    // 抽屉在页签条下方，不覆盖主体内容。
    expect(expanded.bodyTop).toBeGreaterThanOrEqual(collapsed.tabsBottom);
    // 没有 Run 时给出精简空态，不编造执行能力。
    await expect(page.getByTestId("devtools-output-empty")).toContainText("没有 AI Run");
  });

  test("窄窗切抽屉：面板浮在聊天之上，聊天列不被压窄", async ({ page }) => {
    await openSession(page, 900, 700);
    const before = await page.getByTestId("collab-center").boundingBox();
    await openTools(page);
    const after = await page.getByTestId("collab-center").boundingBox();
    if (before === null || after === null) throw new Error("缺少中栏几何");
    expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(1);
    const panel = await page.evaluate(() => {
      const node = document.querySelector<HTMLElement>('[data-testid="collab-conversation-tools"]')!;
      const rect = node.getBoundingClientRect();
      return { position: getComputedStyle(node).position, right: rect.right, viewport: window.innerWidth };
    });
    // 抽屉形态：绝对定位、贴右缘，不是把聊天列挤窄的分栏。
    expect(panel.position).toBe("absolute");
    expect(panel.right).toBeCloseTo(panel.viewport, 0);
  });

  test("六个页签全部可达：主入口文字页签、辅助入口图标页签，键盘可遍历", async ({ page }) => {
    await openSession(page);
    await openTools(page);
    const tabs = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll<HTMLElement>(".devtools-tab")];
      return nodes.map((node) => {
        const label = node.querySelector<HTMLElement>(".devtools-tab-label");
        return { testid: node.dataset.testid, role: node.getAttribute("role"),
          aria: node.getAttribute("aria-label"), text: (node.textContent ?? "").trim(),
          labelShown: label !== null && getComputedStyle(label).display !== "none",
          title: node.getAttribute("title") };
      });
    });
    expect(tabs.map((tab) => tab.testid)).toEqual([
      "devtools-tab-FILES", "devtools-tab-GIT", "devtools-tab-WEB",
      "devtools-tab-TERMINAL", "devtools-tab-RUNS", "devtools-tab-TRACE"
    ]);
    expect(tabs.every((tab) => tab.role === "tab")).toBe(true);
    // 主入口始终显示文字；默认 288px 宽下辅助入口只留图标，但可访问名称与 title 都在。
    for (const tab of tabs.slice(0, 3)) expect(tab.labelShown, `${tab.testid} 应显示文字`).toBe(true);
    for (const tab of tabs.slice(3)) {
      expect(tab.labelShown, `${tab.testid} 在默认宽度应只留图标`).toBe(false);
      expect(tab.aria, `${tab.testid} 缺可访问名称`).not.toBeNull();
      expect(tab.title).toBe(tab.aria);
    }
    // 键盘遍历六项：Home/End 与左右方向键都能走到最后一枚，且激活跟随焦点。
    await page.getByTestId("devtools-tab-FILES").focus();
    await page.keyboard.press("End");
    await expect(page.getByTestId("devtools-tab-TRACE")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("devtools-tab-TRACE")).toBeFocused();
    await page.keyboard.press("Home");
    await expect(page.getByTestId("devtools-tab-FILES")).toHaveAttribute("aria-selected", "true");
    // 拖宽面板后辅助入口补回文字，六项仍是同一批键。
    const handle = page.getByTestId("inspector-resize-handle");
    const handleBox = await handle.boundingBox();
    if (handleBox === null) throw new Error("缺少拖拽手柄");
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox.x - 240, handleBox.y + handleBox.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => page.evaluate(() => {
      const label = document.querySelector<HTMLElement>('[data-testid="devtools-tab-RUNS"] .devtools-tab-label');
      return label === null ? null : getComputedStyle(label).display;
    }), { timeout: 5_000 }).not.toBe("none");
  });

  /**
   * 已归入项目的普通会话（2026-10-30 P0 退回项）。
   *
   * 上一轮工具面板的 projectId 固定为 null，于是「已归入项目」的会话也一直显示
   * 「尚未关联项目」。这条用例走真实协作页：会话行给出 project_id，页面读回它，
   * 面板据此显示受管目录与 Git 读取入口——不是只给组件传一个 projectId。
   */
  test("已归入项目：文件列出受管目录、变更是读取面板，五个页签各有清晰状态", async ({ page }) => {
    await openSession(page, 1440, 900, { project: projectId });
    await openTools(page);
    const host = page.getByTestId("collab-conversation-tools");
    await expect(host).toHaveAttribute("data-project", projectId);
    const root = page.getByTestId("devtools-panel");
    // 有项目时默认落在「文件」，并真的列出服务端登记的受管目录。
    await expect(root).toHaveAttribute("data-tab", "FILES");
    const files = page.getByTestId("devtools-files");
    await expect(files).toContainText("受管目录");
    await expect(files).toContainText("MyProject");
    await expect(files).toContainText("资源修订 v1");
    await expect(page.getByTestId("devtools-files-unavailable")).toHaveCount(0);

    // 变更：是真正的 Git 读取面板（待显式点击），不是「尚未关联项目」空态。
    await page.getByTestId("devtools-tab-GIT").click();
    await expect(page.getByTestId("devtools-git-unavailable")).toHaveCount(0);
    await expect(page.getByTestId("git-read-idle")).toContainText("尚未读取所选目录");

    // 终端：轻量说明，不再是一整块抢眼的警告。
    await page.getByTestId("devtools-tab-TERMINAL").click();
    const terminal = page.getByTestId("devtools-terminal");
    await expect(terminal).toContainText("不提供可执行提示符");
    expect(await terminal.locator(".warning-callout").count()).toBe(0);
    expect(await page.getByTestId("devtools-terminal-gap").evaluate(
      (node) => getComputedStyle(node).backgroundColor)).toBe("rgba(0, 0, 0, 0)");

    // 运行记录：没有 Run 时只有一句空态，不重复「不是启动按钮」这类免责声明。
    await page.getByTestId("devtools-tab-RUNS").click();
    await expect(page.getByTestId("devtools-runs-empty")).toHaveText("当前任务还没有 AI Run。");
    await expect(page.getByTestId("devtools-runs")).not.toContainText("不是启动按钮");

    // 轨迹：没有 Run 就不给「刷新」这种按了没用的操作，也不复述只读说明。
    await page.getByTestId("devtools-tab-TRACE").click();
    await expect(page.getByTestId("trajectory-no-run")).toContainText("没有工具调用轨迹");
    await expect(page.getByTestId("trajectory-refresh")).toHaveCount(0);
    await expect(page.getByTestId("run-tool-trajectory")).not.toContainText("只读");
  });

  test("已归入项目但受管目录为空：如实说明，不读成「工作目录干净」", async ({ page }) => {
    await openSession(page, 1440, 900, { project: projectId, resources: [] });
    await openTools(page);
    const files = page.getByTestId("devtools-files");
    await expect(files).toContainText("当前项目没有登记受管目录");
    await expect(files).toContainText("工作目录干净");
  });

  test("终端未接入是轻量说明，不再是一整块警告", async ({ page }) => {
    await openSession(page);
    await openTools(page);
    await page.getByTestId("devtools-tab-TERMINAL").click();
    const terminal = page.getByTestId("devtools-terminal");
    await expect(terminal).toContainText("不提供可执行提示符");
    // 不是 warning-callout 那种整块警示：说明文字直接落在纸面上。
    expect(await terminal.locator(".warning-callout").count()).toBe(0);
    expect(await page.getByTestId("devtools-terminal-gap").evaluate(
      (node) => getComputedStyle(node).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
    // 与「文件/变更」的空态同一档：说明文字用辅助色，不用状态底色。
    expect(await page.getByTestId("devtools-terminal-gap").evaluate(
      (node) => getComputedStyle(node).color)).toBe("rgb(66, 82, 72)");
  });
});
