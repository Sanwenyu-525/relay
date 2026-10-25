import { expect, test, type Page, type Route } from "@playwright/test";

// 2026-10-17 点击后界面定向验收（2026-10-16）整改 CT-02 的真实渲染核对。
// 现场（步骤 04）：输入器点「资料 0」或「普通讨论」弹出同一大片面板，1.75rem 的整页级标题、
// 长说明与检索/已选/结果全部铺开，一屏放不下时整块面板被推走，检索行与关闭入口一起滚出视野。
// 本轮改的是资料面板自己（components/AssistSourcePicker.tsx + migrated-scoped.css）：
// 标题降到面板字号档，内容区限高并在内部滚动，检索行／引用范围／关闭入口留在滚动区之外；
// 生成方式与意图仍属发送选项设置区，不进了资料面板的 DOM。
// 2026-10-24（用户截图「浮层宽度跟输入框一样而且样式不好看」）：浮层从「按输入卡拉满整卡
// 宽」改为锚定芯片（AssistView.css 的 .agent-chat-options：details 建立包含块，面板 left:0 /
// width:max-content / 封顶 20rem）。同日用户指令「这两个合成一个芯片就好了」把「普通讨论说明」
// 与「资料」合成一枚芯片一片浮层（会话输入器 details.agent-chat-options.agent-chat-send-options，
// 上节发送选项、下节 .agent-chat-options-section 里的资料选择器），旧类名
// .agent-chat-source-options 与旧 testid 已从 src 移除，本节的采样与序比较一律锚到这唯一一枚；
// 资料入口的 data-testid 与 aria-expanded 仍留在合并后的 summary 上（AssistView.tsx:4999），
// 因此开面板的点击不换 Owner。浮层是工具行最右一枚，翻面为右缘贴芯片右缘；翻面由 usePopupFlip
// 现算（窄窗芯片换行到左缘时不翻）。本节 3b 与第 4 条的断言按新几何更新（草稿被浮层短暂盖住
// 属芯片菜单既有模式，见该处注释）。
// 只连页面内夹具：不连数据库、不调 Provider、不写任何真实业务事实；全程核对零 POST。

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const sessionId = "66666666-6666-4666-8666-666666666666";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = "http://127.0.0.1:4173";
/** 足够把内容区撑过 30dvh 一档，用来证明「限高 + 内部滚动」而不是整块面板被推高。 */
const resultCount = 12;

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
  created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z" };

function searchResults() {
  return { items: Array.from({ length: resultCount }, (_unused, index) => {
    const id = `bbbbbbbb${index}-0000-4000-8000-000000000000`;
    return { type: "KNOWLEDGE", id, version: "1", title: `基线资料 ${index + 1}`,
      snippet: `第 ${index + 1} 条命中片段，用来把结果区撑高，核对面板是否真的在内容区内部滚动。`,
      matched_fields: ["title"], source_ref: `knowledge:${id}:v1`, status: "ACTIVE", project_id: projectId };
  }), next_cursor: null };
}

async function installRoutes(page: Page, posts: string[]): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (request.method() === "POST") posts.push(path);
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/tasks/${taskId}`) return fulfillJson(route, { id: taskId, project_id: projectId,
      title: "整理实验评价指标", status: "IN_PROGRESS", mode: "ME", revision: "2",
      created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z",
      executor: { kind: "HUMAN", run_id: null, ownership_epoch: "1" },
      current_completion_id: null, waiting_reason: null, blocking_task_ids: [],
      unresolved_blocker_ids: [], allowed_actions: [],
      acceptance: { acceptance_revision: "2", objective: "补齐基线与验收依据。", source: "CREATE",
        created_at: "2026-10-16T00:00:00Z", criteria: [] },
      dependencies: [] });
    if (path === `${prefix}/projects/${projectId}`) return fulfillJson(route, { id: projectId,
      title: "Windows 桌面验收（测试）", project_type: "GENERAL", revision: "1", state_revision: "1",
      archived_at: null });
    if (path === `${prefix}/search`) return fulfillJson(route, searchResults());
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
  await page.locator('input[name="relay-bearer-token"]').fill("ct02-geometry-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

interface Box { left: number; top: number; right: number; bottom: number; width: number; height: number }

/** 几何采样：矩形、字号、内部滚动量、覆盖关系与横向溢出。全部限定在输入器容器内，
 *  因为协作页同时挂了 TaskDelegatePanel 的第二份资料选择器（`#assist-source-query` 是既有共享 id）。 */
async function measure(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-testid="assist-composer"]');
    if (root === null) throw new Error("缺少输入器容器 [data-testid=\"assist-composer\"]");
    const node = (selector: string) => root.querySelector(selector);
    const box = (target: Element | null): Box | null => {
      if (target === null) return null;
      const rect = target.getBoundingClientRect();
      return { left: Math.round(rect.left * 10) / 10, top: Math.round(rect.top * 10) / 10,
        right: Math.round(rect.right * 10) / 10, bottom: Math.round(rect.bottom * 10) / 10,
        width: Math.round(rect.width * 10) / 10, height: Math.round(rect.height * 10) / 10 };
    };
    const overlap = (a: Box | null, b: Box | null): number => {
      if (a === null || b === null) return 0;
      const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      return width > 0 && height > 0 ? Math.round(width * height) : 0;
    };
    const label = (target: Element | null): string => {
      if (target === null) return "none";
      const testId = target.getAttribute("data-testid");
      if (testId !== null && testId !== "") return testId;
      if (typeof target.className === "string" && target.className !== "") return target.className.split(/\s+/u)[0] ?? target.tagName;
      return target.tagName.toLowerCase();
    };
    const hitTest = (target: Element | null): string => {
      if (target === null) return "missing";
      const rect = target.getBoundingClientRect();
      const point = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (point === null) return "no-element";
      return target.contains(point) ? "self" : `covered-by:${label(point)}`;
    };
    const style = (target: Element | null) => target === null ? null : getComputedStyle(target);
    const body = node(".assist-source-body");
    const panel = node(".agent-chat-options");
    // 展开的那片面板与它的入口芯片：2026-10-19 起浮层只包住内容，summary 留在工具行里；
    // 2026-10-24 发送选项与资料合成一枚芯片后，输入器里展开的就是 .agent-chat-send-options 这一枚。
    const openPanel = node(".agent-chat-send-options > .agent-chat-options-panel");
    const openSummary = node(".agent-chat-send-options > summary");
    const options = node('[data-testid="assist-skill"]');
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      rootFontSize: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      panelBox: box(panel),
      // 输入卡自身（root 就是 [data-testid="assist-composer"]）：浮层必须待在它里面，
      // 中栏 .collab-center 是 overflow:hidden，越出即被裁。
      cardBox: box(root),
      toolsBox: box(node(".agent-chat-composer-tools")),
      // 工具行的文档序（类名）：位置换档只有量出来才锁得住，CSS 换行不改文档序。
      toolOrder: Array.from(document.querySelector(".agent-chat-composer-tools")?.children ?? [])
        .map((element) => element.className),
      // 底栏的文档序与右端一组（计量 + 模型，2026-10-20 用户指令「整体移动到发送按钮的左边」）。
      actionsOrder: Array.from(document.querySelector(".agent-chat-composer-actions")?.children ?? [])
        .map((element) => element.className),
      tailOrder: Array.from(document.querySelector(".agent-chat-composer-tail")?.children ?? [])
        .map((element) => element.className),
      openPanelBox: box(openPanel),
      openSummaryBox: box(openSummary),
      // 合并后同一时刻只允许一枚浮层开着（旧的两枚互斥现场按结构已不可能多开）；
      // 一片浮层里发送选项节与资料节必须同时在场。
      openOptions: Array.from(root.querySelectorAll("details.agent-chat-options"))
        .filter((element) => element.hasAttribute("open")).length,
      totalOptions: root.querySelectorAll("details.agent-chat-options").length,
      panelSections: openPanel === null ? null : {
        skill: openPanel.querySelector('[data-testid="assist-skill"]') !== null,
        picker: openPanel.querySelector('[data-testid="assist-source-picker"]') !== null,
        query: openPanel.querySelector("#assist-source-query") !== null,
        sections: openPanel.querySelectorAll(":scope > .agent-chat-options-section").length },
      panelStyle: style(panel) ? { maxHeight: style(panel)!.maxHeight, overflowY: style(panel)!.overflowY } : null,
      title: { box: box(node(".assist-source-title")), fontSize: style(node(".assist-source-title"))?.fontSize ?? null },
      headBox: box(node(".assist-source-head")),
      queryBox: box(node("#assist-source-query")),
      scopeBox: box(node('[data-testid="assist-source-scope"]')),
      summaryBox: box(node(".agent-chat-options > summary")),
      bodyBox: box(body),
      bodyScroll: body === null ? null : { scrollHeight: body.scrollHeight, clientHeight: body.clientHeight },
      bodyStyle: style(body) ? { maxHeight: style(body)!.maxHeight, overflowY: style(body)!.overflowY } : null,
      selectedCount: node('[data-testid="assist-source-count"]')?.textContent ?? null,
      draftBox: box(node('[data-testid="assist-draft"]')),
      sendBox: box(node('[data-testid="assist-send"]')),
      overlaps: {
        panelDraft: overlap(box(panel), box(node('[data-testid="assist-draft"]'))),
        // 压发送键的判据按真正展开的那片浮层量（合并后它是输入器里唯一一枚浮层）。
        panelSend: overlap(box(openPanel), box(node('[data-testid="assist-send"]'))),
        panelQuery: overlap(box(panel), box(node("#assist-source-query")))
      },
      hitTests: { query: hitTest(node("#assist-source-query")), summary: hitTest(node(".agent-chat-options > summary")),
        send: hitTest(node('[data-testid="assist-send"]')), scope: hitTest(node('[data-testid="assist-source-scope"]')),
        // 生成方式属于发送选项设置区，必须还在弹层里、但不在资料面板里。
        skillInPanel: panel !== null && options !== null ? panel.contains(options) : null,
        skillInPicker: node('[data-testid="assist-source-picker"]') !== null
          && options !== null
          && node('[data-testid="assist-source-picker"]')!.contains(options) },
      pickerOverflowX: body === null ? null : (body as HTMLElement).scrollWidth - (body as HTMLElement).clientWidth,
      // 模式芯片与它的当前档文字盒（2026-10-20 用户截图「竖直重心没有在一个高度」；
      // 2026-10-22 DEV-0116 起这一档是自绘浮层，不再是原生 select）：
      modeChip: (() => {
        const chipNode = node(".agent-chat-mode-select-field");
        const valueNode = chipNode?.querySelector(".agent-chat-mode-chip-value") ?? null;
        if (chipNode === null || valueNode === null) return null;
        const chipBox = box(chipNode);
        const valueBox = box(valueNode);
        return chipBox === null || valueBox === null ? null : { chip: chipBox, value: valueBox };
      })(),
      horizontalOverflow: (document.scrollingElement as HTMLElement).scrollWidth - (document.scrollingElement as HTMLElement).clientWidth
    };
  });
}

type Snapshot = Awaited<ReturnType<typeof measure>>;

function require(where: string, name: string, value: Box | null): Box {
  if (value === null) throw new Error(`${where} · 缺少 ${name}`);
  return value;
}

function insideViewport(snapshot: Snapshot, where: string, name: string, box: Box): void {
  expect(box.top, `${where} · ${name} 上缘越出视口`).toBeGreaterThanOrEqual(-0.5);
  expect(box.bottom, `${where} · ${name} 下缘越出视口`).toBeLessThanOrEqual(snapshot.viewport.height + 0.5);
  expect(box.left, `${where} · ${name} 左缘越出视口`).toBeGreaterThanOrEqual(-0.5);
  expect(box.right, `${where} · ${name} 右缘越出视口`).toBeLessThanOrEqual(snapshot.viewport.width + 0.5);
}

/** 输入器容器：页面同时挂了 TaskDelegatePanel 的第二份资料选择器，所有定位都从输入器往下走。 */
function composer(page: Page) { return page.getByTestId("assist-composer"); }

async function openSourcePanel(page: Page, viewport: { width: number; height: number }) {
  const posts: string[] = [];
  await page.setViewportSize(viewport);
  await installRoutes(page, posts);
  await page.goto(`/agent?work=${taskId}&session=${sessionId}`);
  await connect(page);
  await page.getByTestId("collab-conversation-toolbar").waitFor({ timeout: 20_000 });
  // 合并后这唯一一枚芯片就是资料入口：testid 仍挂在它的 summary 上（AssistView.tsx:4999）。
  await page.getByTestId("assist-open-sources").click();
  await composer(page).locator("#assist-source-query").waitFor({ state: "visible", timeout: 20_000 });
  await composer(page).locator("#assist-source-query").fill("基线");
  await composer(page).getByRole("button", { name: "查找来源" }).click();
  await expect(composer(page).getByTestId("assist-source-body").locator('[data-region="results"] li')).toHaveCount(resultCount, { timeout: 20_000 });
  return { snapshot: await measure(page), posts };
}

test.describe("CT-02 资料面板的职责、高度与可达性", () => {
  for (const viewport of [{ width: 1162, height: 782 }, { width: 1000, height: 800 }, { width: 860, height: 800 }] as const) {
    test(`${viewport.width}×${viewport.height}：结果区限高内部滚动，检索行与关闭入口留在视口内，输入器不被压住`, async ({ page }) => {
      const label = `${viewport.width}×${viewport.height}`;
      const { snapshot, posts } = await openSourcePanel(page, viewport);
      // 原始几何留在日志里作为证据（数值只反映夹具布局，不连真实 API）。
      console.log(JSON.stringify({ label, snapshot }));
      const where = `${label} · 资料面板`;
      // 1. 内容区限高且真的在内部滚动（滚动条长在结果区，不是整块面板被推高）。
      const body = require(where, ".assist-source-body", snapshot.bodyBox);
      const scroll = snapshot.bodyScroll;
      if (scroll === null) throw new Error(`${where} · 缺少内容区`);
      expect(snapshot.bodyStyle?.overflowY, `${where} · 内容区必须纵向滚动`).toBe("auto");
      expect(scroll.scrollHeight, `${where} · 内容区应当溢出`).toBeGreaterThan(scroll.clientHeight);
      expect(body.height, `${where} · 内容区高度不得超过上限`).toBeLessThanOrEqual(scroll.clientHeight + 0.5);
      const cap = snapshot.bodyStyle?.maxHeight ?? "";
      expect(["none", ""].includes(cap), `${where} · 内容区缺少 max-height 上限`).toBe(false);
      expect(body.height, `${where} · 内容区越过 max-height`).toBeLessThanOrEqual(
        cap.endsWith("px") ? Number.parseFloat(cap) + 0.5 : snapshot.viewport.height * 0.3 + 0.5);
      // 内容区横向不产生第二条滚动条（长 ID 就地断行）。
      expect(snapshot.pickerOverflowX ?? 0, `${where} · 内容区横向溢出`).toBe(0);
      // 2. 标题走面板字号档（1rem），不是整页 hero 的 1.75rem。
      const titlePx = Number.parseFloat(snapshot.title.fontSize ?? "0");
      expect(titlePx, `${where} · 标题应为 body 档（1rem）`).toBeCloseTo(snapshot.rootFontSize, 1);
      expect(titlePx, `${where} · 标题仍是整页级字号`).toBeLessThan(snapshot.rootFontSize * 1.5);
      // 3. 关闭入口（chip/summary）、检索行与引用范围留在滚动区之外且可命中。
      insideViewport(snapshot, where, "关闭入口", require(where, "summary", snapshot.summaryBox));
      insideViewport(snapshot, where, "检索行", require(where, "query", snapshot.queryBox));
      expect(snapshot.hitTests.summary, `${where} · 关闭入口不可达`).toBe("self");
      expect(snapshot.hitTests.query, `${where} · 检索行不可达`).toBe("self");
      // 3b. 展开只浮出内容，入口芯片不离开工具行（2026-10-19 用户指认「点击之后 ui 还会消失，
      //     关闭菜单之后 ui 又出来了」：原先整个 details 连 summary 一起绝对定位，点开时芯片
      //     从行里跳走、其余芯片左移）。面板必须仍在行的上方，且明显宽于芯片。
      //     2026-10-24（用户截图「宽度跟输入框一样而且样式不好看」）：浮层改锚在芯片上，
      //     宽度 max(内容, 芯片) 且封顶 20rem（模式菜单同款）。左缘起排在芯片靠近卡片右缘
      //     时会越界（1000px 视口实测右缘 1035，卡片右缘 971，中栏 overflow:hidden 会裁掉它），
      //     因此由 usePopupFlip 现算翻面：越界就右缘贴芯片，窄窗芯片随工具行换行到左缘时不翻。
      const tools = require(where, "工具行", snapshot.toolsBox);
      const chip = require(where, "展开中的入口芯片", snapshot.openSummaryBox);
      const floating = require(where, "展开中的面板", snapshot.openPanelBox);
      expect(chip.top, `${where} · 入口芯片上沿跳出工具行`).toBeGreaterThanOrEqual(tools.top - 0.5);
      expect(chip.bottom, `${where} · 入口芯片下沿跳出工具行`).toBeLessThanOrEqual(tools.bottom + 0.5);
      // 面板必须浮在自己的入口芯片之上。参照物取芯片所在的这一行，而不是整块工具行的外框：
      // 窄窗（860×800 实测）工具行会换行成两行、合并芯片落在第二行（行框 706–774，芯片 742），
      // 面板按 bottom: calc(100% + gap) 锚在芯片上（实测 bottom 734 = 芯片上沿 − 8），
      // 与换行后第一行的其他芯片重叠——那与「浮层短暂盖住草稿」是同一既有芯片菜单模式（见第 4 条），
      // 而「不压自己的入口、不铺回行里」这条不变量仍按芯片上沿逐像素锁住；发送键是否被压在第 4 条单测。
      expect(floating.bottom, `${where} · 面板没有浮在自己的入口芯片之上`).toBeLessThanOrEqual(chip.top - 0.5);
      expect(floating.bottom, `${where} · 面板下沿压进入口芯片所在的行`).toBeLessThanOrEqual(tools.bottom - 0.5);
      expect(floating.width, `${where} · 面板宽度没有铺过输入卡`).toBeGreaterThan(chip.width);
      expect(floating.width, `${where} · 面板宽度超过 20rem 封顶`).toBeLessThanOrEqual(snapshot.rootFontSize * 20 + 0.5);
      // 贴芯片与不越界二选一断言：芯片靠近卡片右缘时翻面（右缘贴芯片），否则左缘贴芯片；
      // 翻面由 usePopupFlip 现算——合并芯片在窄窗会随工具行换行跑到卡片左缘，静态翻面
      // 那时会把面板裁出卡片左缘（860px 视口实测）。两种形态都必须待在输入卡内。
      const leftAligned = Math.abs(floating.left - chip.left) <= 1;
      const rightAligned = Math.abs(floating.right - chip.right) <= 1;
      expect(leftAligned || rightAligned, `${where} · 浮层两缘都不贴芯片`).toBe(true);
      const card = require(where, "输入卡", snapshot.cardBox);
      expect(floating.left, `${where} · 资料浮层左缘越出输入卡（会被中栏裁掉）`).toBeGreaterThanOrEqual(card.left - 0.5);
      expect(floating.right, `${where} · 资料浮层右缘越出输入卡（会被中栏裁掉）`).toBeLessThanOrEqual(card.right + 0.5);
      expect(floating.left, `${where} · 资料浮层左缘越出视口`).toBeGreaterThanOrEqual(-0.5);
      expect(floating.right, `${where} · 资料浮层右缘越出视口`).toBeLessThanOrEqual(snapshot.viewport.width + 0.5);
      expect(floating.top, `${where} · 资料浮层上缘越出视口`).toBeGreaterThanOrEqual(-0.5);
      // 2026-10-24 合并后输入器只有一枚浮层芯片：展开时同一时刻开着的也必须只有一枚，
      // 且这一片浮层里发送选项节（生成方式）与资料节（选择器 + 检索行）同时在场。
      expect(snapshot.totalOptions, `${where} · 输入器里的浮层芯片不止一枚`).toBe(1);
      expect(snapshot.openOptions, `${where} · 展开的浮层不止一枚`).toBe(1);
      if (snapshot.panelSections === null) throw new Error(`${where} · 缺少面板分节采样`);
      expect(snapshot.panelSections.skill, `${where} · 发送选项节不在合并浮层里`).toBe(true);
      expect(snapshot.panelSections.picker, `${where} · 资料节不在合并浮层里`).toBe(true);
      expect(snapshot.panelSections.query, `${where} · 检索行不在合并浮层里`).toBe(true);
      expect(snapshot.panelSections.sections, `${where} · 资料节不是面板的直接子节`).toBe(1);
      // 3c. 行右端一组（2026-10-20 用户指令「上下文和模型下拉按钮整体移动到发送按钮的左边」）：
      //     计量环与模型下拉收在发送键左边，工具行左端改由「+」起头。
      //     2026-10-24 合并后「普通讨论在左、资料在右」的两端比较失去对象（只剩一枚芯片），
      //     改锁当前真实文档序：合并芯片是工具行最右一枚，且仍在模式芯片右侧——原断言要锁的
      //     相对顺序（资料入口排在模式/说明之后、行尾之前）由这两条等值断言继续锁住。
      expect(snapshot.toolOrder[0], `${where} · 工具行左端不是「+」`).toBe("agent-chat-attach");
      expect(snapshot.actionsOrder, `${where} · 底栏不是「工具行 → 右端一组 → 发送键」`).toEqual([
        "agent-chat-composer-tools", "agent-chat-composer-tail", "primary-button agent-chat-send"]);
      expect(snapshot.tailOrder, `${where} · 右端一组不是「计量环 → 模型」`).toEqual(
        ["agent-chat-usage", "model-selector"]);
      // 工具行的完整文档序（合并后一枚芯片在行尾，模式芯片仍在它左侧）。
      expect(snapshot.toolOrder, `${where} · 工具行文档序变了`).toEqual([
        "agent-chat-attach", "agent-chat-permission", "agent-chat-mode",
        "agent-chat-tool composer-draft-polish", "agent-chat-options agent-chat-send-options"]);
      expect(snapshot.toolOrder.indexOf("agent-chat-options agent-chat-send-options"),
        `${where} · 合并芯片不是工具行最右一枚`).toBe(snapshot.toolOrder.length - 1);
      expect(snapshot.toolOrder.indexOf("agent-chat-options agent-chat-send-options"),
        `${where} · 合并芯片应在模式芯片右侧`).toBeGreaterThan(snapshot.toolOrder.indexOf("agent-chat-mode"));
      // 3d. 模式芯片里的当前档文字必须与芯片同中线（2026-10-20 用户截图「竖直重心没有在一个高度」）：
      //     那一轮的成因是 Chromium 把原生 select 的内部文字按内容盒贴顶排，height 撑满 chip 时
      //     文字整体上浮 7-8px（像素实测）。2026-10-22 DEV-0116 起这一档改成自绘浮层，
      //     文字盒由 summary 的 flex 居中，但这条不变量仍然要量：换了载体不等于可以不再验。
      if (snapshot.modeChip === null) throw new Error(`${where} · 缺少模式芯片采样`);
      const chipCenter = (snapshot.modeChip.chip.top + snapshot.modeChip.chip.bottom) / 2;
      const valueCenter = (snapshot.modeChip.value.top + snapshot.modeChip.value.bottom) / 2;
      expect(Math.abs(chipCenter - valueCenter), `${where} · 模式芯片文字竖直重心偏了`)
        .toBeLessThanOrEqual(1);
      // 检索行本来就在弹层内，这里只核对它没被挤出滚动区（可命中即说明留在视野里）。
      // 4. 输入器不被面板压走：面板是浮层不进文档流，草稿与发送键的几何不随开合变化；
      //    发送键不被压住。草稿在浮层开着时被短暂盖住属芯片菜单既有模式——DEV-0116 的
      //    档位菜单（普通 Agent）同样盖草稿，2026-10-24 发送选项与资料合并成一枚锚定芯片的
      //    浮层后与它一致；页面不横向溢出。
      insideViewport(snapshot, where, "发送键", require(where, "发送键", snapshot.sendBox));
      expect(snapshot.overlaps.panelSend, `${where} · 弹层压住发送键`).toBeLessThanOrEqual(0.5);
      expect(snapshot.hitTests.send, `${where} · 发送键被面板遮挡`).toBe("self");
      expect(snapshot.horizontalOverflow, `${where} · 页面横向溢出`).toBe(0);
      // 5. 职责分离：生成方式仍在发送选项里，但不在资料面板的 DOM 里。
      expect(snapshot.hitTests.skillInPanel, `${where} · 生成方式应留在发送选项`).toBe(true);
      expect(snapshot.hitTests.skillInPicker, `${where} · 生成方式不应进资料面板`).toBe(false);
      // 6. 开面板、检索、读结果全程零 POST：不创建执行、不发模型消息。
      expect(posts, `${where} · 面板内动作产生了写命令`).toEqual([]);
    });
  }

  test("1162×782：勾选资料只改本次候选输入，依据块 Esc 先收自己再交还面板", async ({ page }) => {
    const posts: string[] = [];
    await page.setViewportSize({ width: 1162, height: 782 });
    await installRoutes(page, posts);
    await page.goto(`/agent?work=${taskId}&session=${sessionId}`);
    await connect(page);
    await page.getByTestId("collab-conversation-toolbar").waitFor({ timeout: 20_000 });
    await page.getByTestId("assist-open-sources").click();
    await composer(page).locator("#assist-source-query").waitFor({ state: "visible", timeout: 20_000 });
    await composer(page).locator("#assist-source-query").fill("基线");
    await composer(page).getByRole("button", { name: "查找来源" }).click();
    const rows = composer(page).getByTestId("assist-source-body").locator('[data-region="results"] input[type="checkbox"]');
    await expect(rows).toHaveCount(resultCount, { timeout: 20_000 });
    await rows.first().check();
    await rows.nth(1).check();
    await rows.nth(1).uncheck();
    await expect(composer(page).getByTestId("assist-source-count")).toContainText("已选 1 / 10");
    await expect(composer(page).getByText("已选资料", { exact: true })).toBeVisible();
    expect(posts, "勾选资料不能创建执行或发送模型消息").toEqual([]);
    // 依据展开后 Esc 先收依据，面板与草稿保留；再按一次才收整个面板。
    const basis = composer(page).getByTestId("assist-source-basis");
    await basis.locator("summary").click();
    await expect(basis.locator("li").first()).toBeVisible();
    await basis.locator("summary").focus();
    await page.keyboard.press("Escape");
    await expect(basis.locator("li").first()).toBeHidden();
    await expect(composer(page).getByTestId("assist-source-picker")).toBeVisible();
    await expect(page.getByTestId("assist-open-sources")).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(composer(page).getByTestId("assist-source-picker")).toBeHidden();
    await expect(page.getByTestId("assist-open-sources")).toHaveAttribute("aria-expanded", "false");
    expect(posts, "开关依据与收起面板同样不能产生写命令").toEqual([]);
  });

  test("1162×782：四类读取状态各说各话，失败给重试且不显示成没有资料", async ({ page }) => {
    await page.setViewportSize({ width: 1162, height: 782 });
    const posts: string[] = [];
    let failNext = true;
    await page.route(`${apiBase}/**`, async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() === "POST") posts.push(path);
      if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
      if (path === `${prefix}/search`) {
        if (failNext) { await route.fulfill({ status: 503, contentType: "application/json",
          headers: cors(), body: JSON.stringify({ code: "INTERNAL", detail: "search unavailable" }) }); return; }
        await route.fulfill({ status: 200, contentType: "application/json", headers: cors(),
          body: JSON.stringify({ items: [], next_cursor: null }) });
        return;
      }
      await installOne(route, path);
    });
    await page.goto(`/agent?work=${taskId}&session=${sessionId}`);
    await connect(page);
    await page.getByTestId("assist-open-sources").click();
    await composer(page).locator("#assist-source-query").waitFor({ state: "visible", timeout: 20_000 });
    // 空态：还没检索时不谎称「没有匹配」。
    await expect(composer(page).getByTestId("assist-source-empty")).toBeVisible();
    await expect(composer(page).getByTestId("assist-source-none")).toHaveCount(0);
    await composer(page).locator("#assist-source-query").fill("基线");
    await composer(page).getByRole("button", { name: "查找来源" }).click();
    await expect(composer(page).getByTestId("assist-source-picker").locator(".action-error")).toBeVisible({ timeout: 20_000 });
    await expect(composer(page).getByTestId("assist-source-retry")).toBeVisible();
    await expect(composer(page).getByTestId("assist-source-none")).toHaveCount(0);
    await expect(composer(page).getByTestId("assist-source-empty")).toHaveCount(0);
    // 重试走同一检索词：这次成功但查无结果，空态与错误都退出画面。
    failNext = false;
    await composer(page).getByTestId("assist-source-retry").click();
    await expect(composer(page).getByTestId("assist-source-none")).toBeVisible({ timeout: 20_000 });
    await expect(composer(page).getByTestId("assist-source-retry")).toHaveCount(0);
    await expect(composer(page).getByTestId("assist-source-empty")).toHaveCount(0);
    expect(posts, "检索与重试都只读，不产生写命令").toEqual([]);
  });
});

/** 单条 503 之外的路由仍回夹具，避免失败态用例落到默认空响应以外的分支。 */
async function installOne(route: Route, path: string): Promise<void> {
  if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
  if (path === `${prefix}/tasks/${taskId}`) return fulfillJson(route, { id: taskId, project_id: projectId,
    title: "整理实验评价指标", status: "IN_PROGRESS", mode: "ME", revision: "2",
    created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z",
    executor: { kind: "HUMAN", run_id: null, ownership_epoch: "1" }, current_completion_id: null,
    waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
    acceptance: { acceptance_revision: "2", objective: "补齐基线与验收依据。", source: "CREATE",
      created_at: "2026-10-16T00:00:00Z", criteria: [] }, dependencies: [] });
  if (path === `${prefix}/projects/${projectId}`) return fulfillJson(route, { id: projectId,
    title: "Windows 桌面验收（测试）", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
  if (path === `${prefix}/assist-sessions`) return fulfillJson(route, { items: [session] });
  if (path === `${prefix}/assist-sessions/${sessionId}`) return fulfillJson(route, session);
  if (path === `${prefix}/model-port`) return fulfillJson(route, { provider: "fake", configured: false,
    model: null, base_url: null, max_call_tokens: null });
  return fulfillJson(route, { items: [], next_cursor: null });
}
