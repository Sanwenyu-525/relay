import { expect, test, type Page, type Route } from "@playwright/test";

// 2026-10-17 会话视图顶栏（设计系统 §9.13 / §6.4 红框反馈接续）。
// 用户实机截图四条指令：顶栏高度太宽 → 收成一行；左侧只要会话名 → 去掉切换下拉；
// 「工作详情」键改样式 → 顶栏是 chrome，键不再各自带一圈描边与纸面底；
// 文字滚到顶栏下方时按参考图渐隐 → 遮罩画在转录区上缘，随「是否滚过顶部」出现。
// 回归锁的是这些关系，不是像素值：单行、名字打头、右翼成组贴右缘、渐隐只在滚过时存在、
// 顶栏不再有第二个切换入口（切换只在近期工作栏）。
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

/**
 * 模型调用状态：协作页会为最新助手消息轮询这一路，落进 catch-all 的空清单会被解析契约拒成
 * 「模型调用状态读取失败」的浮层——那是夹具缺路由，不是被测事实，一律按已结算回执伪造。
 */
const modelRuntimePath = /\/assist-messages\/([^/]+)\/model-runtime$/u;
const modelRuntimeBody = (messageId: string): unknown => ({ message_id: messageId, message_status: "COMPLETED",
  snapshot_available: false, preferred_model: null, candidate_models: [], current_candidate_model: null,
  actual_model: null, max_candidates: null, routing_status: null, failure_scope: null, failure_reason: null,
  retry_after_at: null, free_daily_remaining: null, switches: [], calls: [] });

const session = { id: sessionId, workspace_id: workspaceId, project_id: null, task_id: null,
  title: "关于Relay-Agent", status: "ACTIVE", revision: "1",
  working_resource_id: "88888888-8888-4888-8888-888888888888",
  context: { project_goals: [], working_directory: {
    resource_id: "88888888-8888-4888-8888-888888888888", canonical_root: "D:\\Develop\\Relay-Agent" } },
  created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z" };

/** 一问一答共 rounds 轮：回复写到必然截断的长度，转录区才有真实溢出可滚。 */
function conversation(rounds: number): unknown[] {
  const rows: unknown[] = [];
  let seq = 0;
  for (let index = 1; index <= rounds; index += 1) {
    rows.push({ id: `u-${index}`, session_id: sessionId, seq: String(++seq), role: "USER",
      status: "COMPLETED", intent: "DISCUSS", created_at: "2026-10-16T00:00:00Z",
      updated_at: "2026-10-16T00:00:00Z", content: `第 ${index} 个问题：这一轮的验收依据怎么定？`,
      error_code: null, provider_error_kind: null, sources: [], skill: null, cancel_requested: false,
      usage: { input_tokens: 120, output_tokens: 64, cache_read_tokens: null, cache_creation_tokens: null } });
    rows.push({ id: `a-${index}`, session_id: sessionId, seq: String(++seq), role: "ASSISTANT",
      status: "COMPLETED", intent: "DISCUSS", created_at: "2026-10-16T00:00:00Z",
      updated_at: "2026-10-16T00:00:00Z",
      content: `第 ${index} 轮回复：基线按现有实现取。${"补充说明与对照口径。".repeat(index + 6)}`,
      error_code: null, provider_error_kind: null, sources: [], skill: null, cancel_requested: false,
      usage: { input_tokens: 120, output_tokens: 64, cache_read_tokens: null, cache_creation_tokens: null } });
  }
  return rows;
}

async function installRoutes(page: Page, rounds = 0): Promise<void> {
  const items = conversation(rounds);
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/projects/${projectId}`) return fulfillJson(route, { id: projectId,
      title: "Relay-Agent", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
    if (path === `${prefix}/model-port`) return fulfillJson(route, { provider: "fake",
      configured: false, model: null, base_url: null, max_call_tokens: null });
    if (path === `${prefix}/assist-sessions`) return fulfillJson(route, { items: [session] });
    if (path === `${prefix}/assist-sessions/${sessionId}`) return fulfillJson(route, session);
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return fulfillJson(route, { items });
    const runtime = modelRuntimePath.exec(path);
    if (runtime) return fulfillJson(route, modelRuntimeBody(decodeURIComponent(runtime[1])));
    return fulfillJson(route, { items: [], next_cursor: null });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("toolbar-density-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

/** 任务归属的一屏：任务聊天复用同一顶栏，右翼同样不放「新建会话」（2026-10-18 用户指令）。 */
const taskSession = { id: sessionId, workspace_id: workspaceId, project_id: projectId, task_id: taskId,
  title: "关于确定实验评价指标", status: "ACTIVE", revision: "1",
  working_resource_id: "88888888-8888-4888-8888-888888888888",
  context: { project_goals: [], working_directory: {
    resource_id: "88888888-8888-4888-8888-888888888888", canonical_root: "D:\\Work\\Research" } },
  created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z" };

async function installTaskRoutes(page: Page): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/tasks/${taskId}`) return fulfillJson(route, { id: taskId, project_id: projectId,
      title: "确定实验评价指标", status: "IN_PROGRESS", mode: "ME", revision: "2",
      created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z",
      executor: { kind: "HUMAN", run_id: null, ownership_epoch: "1" }, current_completion_id: null,
      waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
      acceptance: { acceptance_revision: "2", objective: "补齐基线与验收依据。", source: "CREATE",
        created_at: "2026-10-16T00:00:00Z", criteria: [] }, dependencies: [] });
    if (path === `${prefix}/projects/${projectId}`) return fulfillJson(route, { id: projectId,
      title: "人机协作工作流研究", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
    if (path === `${prefix}/model-port`) return fulfillJson(route, { provider: "fake",
      configured: false, model: null, base_url: null, max_call_tokens: null });
    if (path === `${prefix}/assist-sessions`) return fulfillJson(route, { items: [taskSession] });
    if (path === `${prefix}/assist-sessions/${sessionId}`) return fulfillJson(route, taskSession);
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return fulfillJson(route, { items: [] });
    const runtime = modelRuntimePath.exec(path);
    if (runtime) return fulfillJson(route, modelRuntimeBody(decodeURIComponent(runtime[1])));
    return fulfillJson(route, { items: [], next_cursor: null });
  });
}

/**
 * 同一 Task 的第二条讨论（2026-10-17）：近期工作栏只列 `taskId` 为空的会话，
 * 顶栏右翼那颗「切换讨论」是这类作用域里唯一能把人带回旧讨论的入口，所以要按可见行为锁住。
 */
const secondSessionId = "99999999-9999-4999-8999-999999999999";
const secondTaskSession = { ...taskSession, id: secondSessionId, title: "评价方法第二讨论",
  updated_at: "2026-10-16T01:00:00Z" };

async function installTwoTaskSessions(page: Page): Promise<void> {
  // 每条讨论的消息行必须写自己的 session_id：应用会核对返回行的归属，
  // 拿第一条的 id 冒充第二条等于测不到真实读取。
  const rowsFor = (owner: string, content: string): unknown[] => conversation(1).map((row) => {
    const item = row as Record<string, unknown>;
    return { ...item, id: `${owner}-${String(item.id)}`, session_id: owner, content };
  });
  const first = rowsFor(sessionId, "原讨论的第一句：基线按现有实现取。");
  const second = rowsFor(secondSessionId, "第二讨论的第一句：对照口径另起一段。");
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/tasks/${taskId}`) return fulfillJson(route, { id: taskId, project_id: projectId,
      title: "确定实验评价指标", status: "IN_PROGRESS", mode: "ME", revision: "2",
      created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z",
      executor: { kind: "HUMAN", run_id: null, ownership_epoch: "1" }, current_completion_id: null,
      waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
      acceptance: { acceptance_revision: "2", objective: "补齐基线与验收依据。", source: "CREATE",
        created_at: "2026-10-16T00:00:00Z", criteria: [] }, dependencies: [] });
    if (path === `${prefix}/projects/${projectId}`) return fulfillJson(route, { id: projectId,
      title: "人机协作工作流研究", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
    if (path === `${prefix}/model-port`) return fulfillJson(route, { provider: "fake",
      configured: false, model: null, base_url: null, max_call_tokens: null });
    if (path === `${prefix}/assist-sessions`) return fulfillJson(route, { items: [taskSession, secondTaskSession] });
    if (path === `${prefix}/assist-sessions/${sessionId}`) return fulfillJson(route, taskSession);
    if (path === `${prefix}/assist-sessions/${secondSessionId}`) return fulfillJson(route, secondTaskSession);
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return fulfillJson(route, { items: first });
    if (path === `${prefix}/assist-sessions/${secondSessionId}/messages`) return fulfillJson(route, { items: second });
    const runtime = modelRuntimePath.exec(path);
    if (runtime) return fulfillJson(route, modelRuntimeBody(decodeURIComponent(runtime[1])));
    return fulfillJson(route, { items: [], next_cursor: null });
  });
}

/** 顶栏一条盒与内部各节点的几何、样式与状态。 */
function lookAtToolbar() {
  const root = getComputedStyle(document.documentElement);
  const rootPx = Number.parseFloat(root.fontSize);
  const rem = (name: string) => Number.parseFloat(root.getPropertyValue(name)) * rootPx;
  const bar = document.querySelector<HTMLElement>('[data-testid="collab-conversation-toolbar"]')!;
  const title = document.querySelector<HTMLElement>('[data-testid="collab-session-title"]');
  const scope = document.querySelector<HTMLElement>('[data-testid="collab-conversation-scope"]')!;
  const details = document.querySelector<HTMLElement>('[data-testid="collab-conversation-inspector-toggle"]')!;
  const detailsIcon = details.querySelector("svg")?.getBoundingClientRect() ?? null;
  const t = title?.getBoundingClientRect();
  const sc = scope.getBoundingClientRect();
  const d = details.getBoundingClientRect();
  const b = bar.getBoundingClientRect();
  const titleStyle = title === null ? null : getComputedStyle(title);
  const detailsStyle = getComputedStyle(details);
  return {
    toolbarHeight: b.height, toolbarLeft: b.left, toolbarRight: b.right,
    titleText: title?.textContent ?? null, titleFull: title?.getAttribute("title") ?? null,
    titleLeft: t?.left ?? null, titleTop: t?.top ?? null, titleBottom: t?.bottom ?? null,
    titleSize: titleStyle?.fontSize ?? null, titleOverflow: titleStyle?.textOverflow ?? null,
    scopeLeft: sc.left, scopeTop: sc.top, scopeBottom: sc.bottom,
    detailsRight: d.right, detailsHeight: d.height, detailsWidth: d.width,
    detailsText: (details.textContent ?? "").trim(), detailsTitle: details.getAttribute("title"),
    detailsLabel: details.getAttribute("aria-label"), detailsIconWidth: detailsIcon?.width ?? null,
    detailsBackground: detailsStyle.backgroundColor, detailsBorder: detailsStyle.borderLeftColor,
    detailsRadius: detailsStyle.borderRadius,
    compactHeight: rem("--relay-control-height-compact"),
    controlRadius: rem("--relay-radius-control"),
    // 会话名距卡片上缘的呼吸：中栏顶部留白 + 顶栏自己的上缘内边距，都由 token 算出来。
    centerTop: document.querySelector<HTMLElement>('[data-testid="collab-center"]')!.getBoundingClientRect().top,
    topGapBudget: rem("--relay-space-2") + rem("--relay-space-1"),
    selectCount: document.querySelectorAll(".collab-conversation-toolbar [data-testid='assist-session-select']").length,
    switcherCount: document.querySelectorAll(".collab-conversation-toolbar [data-testid='collab-session-switcher']").length,
    newSessionButtons: document.querySelectorAll('[data-testid="assist-new-session"]').length,
    rightButtons: document.querySelectorAll(".collab-toolbar-right button").length
  };
}

test.describe("会话顶栏单行密度", () => {
  test.use({ viewport: { width: 1487, height: 900 } });

  test("两行读完：会话名打头且贴住卡片上缘，作用域在它下面一行左缘对齐，右翼贴列边", async ({ page }) => {
    await installRoutes(page);
    await page.goto(`/agent?session=${sessionId}`);
    await connect(page);
    const toolbar = page.getByTestId("collab-conversation-toolbar");
    await expect(toolbar).toBeVisible({ timeout: 20_000 });
    const look = await page.evaluate(lookAtToolbar);
    // 高度：两行档仍只比 compact 多出不到一档 space.8（2026-10-17 接续指令把作用域挪到第二行，
    // 同时要求整条往上贴；两行的代价封顶在 32px 内，不再回到此前 75px 那种双层壳）。
    expect(look.toolbarHeight).toBeLessThanOrEqual(look.compactHeight + 32);
    expect(look.toolbarHeight).toBeGreaterThanOrEqual(look.compactHeight);
    // 会话名距卡片上缘只剩「中栏 space.2 + 顶栏 space.1」这一档呼吸。
    expect(look.titleTop! - look.centerTop).toBeLessThanOrEqual(look.topGapBudget + 1);
    // 会话身份是纯文字：内容就是会话名，完整标题留在 title；顶栏里没有 select。
    expect(look.titleText).toBe("关于Relay-Agent");
    expect(look.titleFull).toBe("关于Relay-Agent");
    expect(look.selectCount).toBe(0);
    // 本作用域只读出一条讨论：不补第二套切换控件（多几条时的浮层见下面第五个用例）。
    expect(look.switcherCount).toBe(0);
    // 名字在上、作用域在它下面一行，两行左缘对齐成一组。
    expect(look.scopeTop).toBeGreaterThanOrEqual(look.titleBottom!);
    expect(look.scopeLeft).toBeCloseTo(look.titleLeft!, 0);
    // 长标题在名字上截断，不撑高顶栏。
    expect(look.titleOverflow).toBe("ellipsis");
    // 右翼：工作详情贴内容盒右缘，compact 一档；「新建会话」已按用户指令从顶栏删除。
    expect(look.toolbarRight - look.detailsRight).toBeLessThanOrEqual(16);
    expect(look.detailsHeight).toBeCloseTo(look.compactHeight, 0);
    // 2026-10-17 用户指令：工作详情是纯图标键——32×32 命中区、18px 图标、无可见文字；
    // 可访问名称与悬停提示按展开态说清下一次点击做什么。
    expect(look.detailsWidth).toBeCloseTo(look.compactHeight, 0);
    expect(look.detailsIconWidth).toBeCloseTo(18, 0);
    expect(look.detailsText).toBe("");
    expect(look.detailsTitle).toBe("展开工作详情");
    expect(look.detailsLabel).toBe("展开工作详情");
    expect(look.newSessionButtons).toBe(0);
    expect(look.rightButtons).toBe(1);
    await toolbar.screenshot({ path: "results/conversation-toolbar-density.png" });
  });

  // taste 审计（§4.4 卡片只在需要层级时用）：顶栏是 chrome 不是卡片，右翼键也不再各自描边。
  // 2026-10-17 接续指令「删除顶栏下面的分隔线…（顶栏的颜色改变）」：收边从 1px 线换成顶栏自己的底色渐变。
  test("顶栏无描边、由底色渐变收边；右翼键静止透明、展开走选中色族", async ({ page }) => {
    await installRoutes(page);
    await page.goto(`/agent?session=${sessionId}`);
    await connect(page);
    const toolbar = page.getByTestId("collab-conversation-toolbar");
    await expect(toolbar).toBeVisible({ timeout: 20_000 });
    const look = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const asRgb = (value: string): string => {
        const hex = value.trim().replace("#", "");
        const full = hex.length === 3 ? hex.split("").map((part) => `${part}${part}`).join("") : hex;
        const channels = [0, 2, 4].map((offset) => Number.parseInt(full.slice(offset, offset + 2), 16));
        return `rgb(${channels.join(", ")})`;
      };
      const bar = document.querySelector<HTMLElement>('[data-testid="collab-conversation-toolbar"]')!;
      const barStyle = getComputedStyle(bar);
      const goal = document.querySelector<HTMLElement>('[data-testid="collab-current-goal"] .collab-toolbar-scope-value')!;
      const directory = document.querySelector<HTMLElement>('[data-testid="collab-current-directory"]')!;
      const scope = document.querySelector<HTMLElement>('[data-testid="collab-conversation-scope"]')!;
      const toggle = document.querySelector<HTMLElement>('[data-testid="collab-conversation-inspector-toggle"]')!;
      const toggleStyle = getComputedStyle(toggle);
      return {
        background: barStyle.backgroundColor, backgroundGradient: barStyle.backgroundImage,
        borderTop: barStyle.borderTopWidth, borderBottom: barStyle.borderBottomWidth,
        radius: barStyle.borderRadius,
        scopeGap: Number.parseFloat(getComputedStyle(scope).columnGap),
        goalPlaceholder: goal.classList.contains("collab-toolbar-scope-value--placeholder"),
        directoryPlaceholder: directory.classList.contains("collab-toolbar-directory--placeholder"),
        directoryText: (directory.textContent ?? "").trim(),
        directoryTitle: directory.getAttribute("title"), directoryLabel: directory.getAttribute("aria-label"),
        goalColor: getComputedStyle(goal).color, directoryColor: getComputedStyle(directory).color,
        muted: asRgb(root.getPropertyValue("--relay-color-text-muted")),
        secondary: asRgb(root.getPropertyValue("--relay-color-text-secondary")),
        surface: asRgb(root.getPropertyValue("--relay-color-bg-surface")),
        space6: Number.parseFloat(root.getPropertyValue("--relay-space-6")) * Number.parseFloat(root.fontSize),
        toggleBackground: toggleStyle.backgroundColor, toggleBorder: toggleStyle.borderLeftColor,
        toggleRadius: Number.parseFloat(toggleStyle.borderRadius),
        controlRadius: Number.parseFloat(root.getPropertyValue("--relay-radius-control")) * Number.parseFloat(root.fontSize),
        selectionBg: asRgb(root.getPropertyValue("--relay-color-selection-bg")),
        selectionText: asRgb(root.getPropertyValue("--relay-color-selection-text"))
      };
    });
    // chrome 而非卡片：无上缘描边、无圆角，下缘那条 1px 分隔线也按指令删掉了。
    expect(look.borderTop).toBe("0px");
    expect(look.borderBottom).toBe("0px");
    expect(look.radius).toBe("0px");
    // 收边换成顶栏自己的底色渐变：`background` 写成渐变时 backgroundColor 恒为透明，
    // 必须看 backgroundImage——从这一列的纸面实底（bg.surface）走到全透（rgba(0,0,0,0)）。
    expect(look.background).toBe("rgba(0, 0, 0, 0)");
    // Chromium 把缺省方向 `to bottom` 省掉，序列化里看不到方向字样，锁渐变本体与两端色标。
    expect(look.backgroundGradient).toMatch(/^linear-gradient\(/u);
    expect(look.backgroundGradient).toContain(`${look.surface} 0%`);
    expect(look.backgroundGradient).toContain("rgba(0, 0, 0, 0) 100%");
    // 两件作用域事实各自成立：间距停在 space.6，不再黏成一串。
    expect(look.scopeGap).toBeCloseTo(look.space6, 0);
    // 本用例数据：目标未关联（占位 → muted），目录已绑定（取值 → secondary）。
    expect(look.goalPlaceholder).toBe(true);
    expect(look.directoryPlaceholder).toBe(false);
    expect(look.goalColor).toBe(look.muted);
    expect(look.directoryColor).toBe(look.secondary);
    // 会话目录可见的是目录名，完整路径仍在 title 与可访问名称里（图标单独说不出是哪一个目录）。
    expect(look.directoryText).toBe("Relay-Agent");
    expect(look.directoryTitle).toBe("会话目录：D:\\Develop\\Relay-Agent");
    expect(look.directoryLabel).toBe("会话目录：D:\\Develop\\Relay-Agent");
    // 「工作详情」静止时没有底色也没有描边：顶栏不再套一圈卡片边框。
    expect(look.toggleBackground).toBe("rgba(0, 0, 0, 0)");
    expect(look.toggleBorder).toBe("rgba(0, 0, 0, 0)");
    // 键形仍停在 control 圆角这一档（shape lock：本页控件只用一套圆角尺度）。
    expect(look.toggleRadius).toBeCloseTo(look.controlRadius, 0);
    // 展开态：底色与文字走选中色族，不再补一条 action 描边（描边留在透明档才是 chrome）。
    // selection.text 与 action.primary 是同一个 token，所以这里锁的是「无边框」而不是「颜色必须不同」。
    // 底色与文字都带 transition，立刻读会拿到插值中间态，因此轮询到落定值，不靠固定等待猜时长。
    await page.getByTestId("collab-conversation-inspector-toggle").click();
    await expect(page.getByTestId("collab-conversation-inspector-toggle")).toHaveAttribute("aria-expanded", "true");
    // 展开后提示与可访问名称翻到「收起」，图标同态换成 PanelRightClose。
    await expect(page.getByTestId("collab-conversation-inspector-toggle")).toHaveAttribute("title", "收起工作详情");
    await expect(page.getByTestId("collab-conversation-inspector-toggle")).toHaveAttribute("aria-label", "收起工作详情");
    await expect.poll(() => page.evaluate(() => {
      const toggle = document.querySelector<HTMLElement>('[data-testid="collab-conversation-inspector-toggle"]')!;
      const style = getComputedStyle(toggle);
      return { background: style.backgroundColor, color: style.color, border: style.borderLeftColor };
    }), { timeout: 5_000 }).toEqual({ background: look.selectionBg, color: look.selectionText, border: "rgba(0, 0, 0, 0)" });
  });

  // 2026-10-17 用户指令「文字被顶栏遮盖的时候要有渐变效果」+ 接续「被未选择目录这一行遮盖时也要有」：
  // 上下两条边同一套处理，都只在真的有内容被切走时存在；顺带锁住回到最新键是整圆而不是竖胶囊。
  test("正文滚过顶栏下缘时渐隐，停在顶部时不绘制；底缘同一套，回底键是圆", async ({ page }) => {
    await installRoutes(page, 12);
    await page.goto(`/agent?session=${sessionId}`);
    await connect(page);
    const toolbar = page.getByTestId("collab-conversation-toolbar");
    await expect(toolbar).toBeVisible({ timeout: 20_000 });
    const transcript = page.locator(".agent-chat-transcript");
    await expect(transcript).toBeVisible();
    const fadeOpacity = () => page.evaluate(() => {
      const shell = document.querySelector<HTMLElement>(".agent-chat-transcript-shell")!;
      const top = getComputedStyle(shell, "::before");
      const bottom = getComputedStyle(shell, "::after");
      const latest = document.querySelector<HTMLElement>('[data-testid="assist-latest"]');
      const box = latest?.getBoundingClientRect();
      return { opacity: Number.parseFloat(top.opacity), height: top.height,
        pointerEvents: top.pointerEvents, attr: shell.getAttribute("data-top-fade"),
        bottomOpacity: Number.parseFloat(bottom.opacity), bottomHeight: bottom.height,
        bottomPointerEvents: bottom.pointerEvents, bottomAttr: shell.getAttribute("data-bottom-fade"),
        latestWidth: box?.width ?? null, latestHeight: box?.height ?? null,
        latestRadius: latest === null ? null : Number.parseFloat(getComputedStyle(latest).borderTopLeftRadius),
        // 渐隐带不得把中栏变成第二个滚动容器（工作台 §31.1 单一滚动 Owner）。
        centerScrolls: (() => {
          const center = document.querySelector<HTMLElement>(".collab-center")!;
          return center.scrollHeight > center.clientHeight + 1;
        })() };
    });
    // 长会话打开即停在最新消息（应用自动跟随），顶部必然有正文被上缘切走 → 遮罩在。
    await expect.poll(async () => (await fadeOpacity()).opacity, { timeout: 5_000 }).toBe(1);
    expect((await fadeOpacity()).attr).toBe("on");
    // 停在底部时下缘没有内容被切走：底缘遮罩不画，否则最后一条消息永久压着一层渐变。
    const atLatest = await fadeOpacity();
    expect(atLatest.bottomOpacity).toBe(0);
    expect(atLatest.bottomAttr).toBeNull();
    await page.locator(".collab-center").screenshot({ path: "results/conversation-toolbar-fade.png" });
    // 滚回最顶：第一条消息之上没有内容，遮罩撤掉，否则它读起来像渲染坏了。
    await transcript.evaluate((element) => { element.scrollTop = 0; });
    await expect.poll(async () => (await fadeOpacity()).opacity, { timeout: 5_000 }).toBe(0);
    const top = await fadeOpacity();
    expect(top.attr).toBeNull();
    expect(top.height).toBe("32px");
    // 遮罩不吃指针：它盖在滚动视口上缘，不能挡住下面的消息与时间线轨道。
    expect(top.pointerEvents).toBe("none");
    // 中栏自己仍不滚动：渐变不给它添第二个滚动 Owner（工作台 §31.1）。
    expect(top.centerScrolls).toBe(false);
    // 底缘同一档：最顶时正文一定被输入区上方那行目录细条切走 → 遮罩在、高度与上缘同源、同样不吃指针。
    expect(top.bottomAttr).toBe("on");
    expect(top.bottomOpacity).toBe(1);
    expect(top.bottomHeight).toBe(top.height);
    expect(top.bottomPointerEvents).toBe("none");
    // 回到最新键：宽高同源才是整圆（此前只写 min-height，全局 .icon-button 的 40px 高度仍在，读成竖胶囊）。
    expect(top.latestWidth).not.toBeNull();
    expect(top.latestHeight).toBe(top.latestWidth);
    expect(top.latestRadius!).toBeGreaterThanOrEqual(top.latestWidth! / 2);
    await page.locator(".collab-center").screenshot({ path: "results/conversation-toolbar-top.png" });
    await transcript.evaluate((element) => { element.scrollTop = 320; });
    await expect.poll(async () => (await fadeOpacity()).opacity, { timeout: 5_000 }).toBe(1);
  });

  // 2026-10-18 用户指令：顶栏右翼不再有「新建会话」，任务归属也一样。
  // 另开会话只剩左栏「新对话」与目录细条「新对话」两条路径，顶栏只负责身份与开关。
  test("任务归属右翼不含「新建会话」，只剩任务视图与工作详情", async ({ page }) => {
    await installTaskRoutes(page);
    await page.goto(`/agent?work=${taskId}&session=${sessionId}`);
    await connect(page);
    const toolbar = page.getByTestId("collab-conversation-toolbar");
    await expect(toolbar).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("collab-conversation-inspector-toggle")).toHaveText("");
    await expect(page.getByTestId("collab-conversation-inspector-toggle")).toHaveAttribute("title", "展开工作详情");
    await expect(page.getByTestId("collab-conversation-inspector-toggle")).toHaveAttribute("aria-label", "展开工作详情");
    const look = await page.evaluate(() => {
      const right = document.querySelector<HTMLElement>(".collab-toolbar-right")!;
      const title = document.querySelector<HTMLElement>(".collab-toolbar-info .collab-toolbar-session")!;
      const buttons = [...right.querySelectorAll<HTMLElement>("button")].map((node) => node.dataset.testid ?? "");
      const t = title.getBoundingClientRect();
      const d = document.querySelector<HTMLElement>('[data-testid="collab-conversation-inspector-toggle"]')!.getBoundingClientRect();
      const first = right.querySelector<HTMLElement>("button")!.getBoundingClientRect();
      return { buttons, titleLeft: t.left, titleRight: t.right, detailsLeft: d.left, firstLeft: first.left,
        newSessionAnywhere: document.querySelectorAll('[data-testid="assist-new-session"]').length };
    });
    expect(look.newSessionAnywhere).toBe(0);
    expect(look.buttons).toEqual(["collab-open-task-view", "collab-conversation-inspector-toggle"]);
    // 右翼成组键仍整体落在左翼会话名右侧，去掉一颗后不改变其余键的位置契约。
    expect(look.firstLeft).toBeLessThanOrEqual(look.detailsLeft);
    expect(look.detailsLeft).toBeGreaterThanOrEqual(look.titleRight);
    expect(look.titleLeft).toBeLessThan(look.detailsLeft);
  });

  // 2026-10-17 接续：右翼图标键统一成 Codex 式图标工具栏。都不含可见文字，
  // 命中区、图标尺度、间距与悬停底色同档；「工作详情」固定在最后。
  test("右翼三颗图标键同档：32×32、18px、无可见文字，详情固定在最后", async ({ page }) => {
    await installTwoTaskSessions(page);
    await page.goto(`/agent?work=${taskId}&session=${sessionId}`);
    await connect(page);
    await expect(page.getByTestId("collab-conversation-toolbar")).toBeVisible({ timeout: 20_000 });
    const look = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const compact = Number.parseFloat(root.getPropertyValue("--relay-control-height-compact"))
        * Number.parseFloat(root.fontSize);
      const probe = document.createElement("div");
      probe.style.backgroundColor = "var(--relay-color-selection-hover)";
      document.body.append(probe);
      const hoverBg = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const buttons = [...document.querySelectorAll<HTMLElement>(".collab-toolbar-right button")].map((node) => {
        const box = node.getBoundingClientRect();
        const icon = node.querySelector("svg")?.getBoundingClientRect();
        // innerText 排除 display:none 的文字：右翼这一档只应看见图标。
        return { testid: node.dataset.testid ?? "", text: (node.innerText ?? "").trim(),
          title: node.getAttribute("title"), label: node.getAttribute("aria-label"),
          width: box.width, height: box.height, iconWidth: icon?.width ?? null };
      });
      return { buttons, compact, hoverBg };
    });
    // 顺序：切换讨论（多条时）→ 任务视图（任务聊天）→ 工作详情。「新建会话」不在右翼。
    expect(look.buttons.map((button) => button.testid)).toEqual([
      "collab-session-switcher", "collab-open-task-view", "collab-conversation-inspector-toggle"
    ]);
    for (const button of look.buttons) {
      expect(button.text, `${button.testid} 仍有可见文字`).toBe("");
      expect(button.width, `${button.testid} 命中区宽`).toBeCloseTo(look.compact, 0);
      expect(button.height, `${button.testid} 命中区高`).toBeCloseTo(look.compact, 0);
      expect(button.iconWidth, `${button.testid} 图标尺寸`).toBeCloseTo(18, 0);
      expect(button.title).not.toBeNull();
      expect(button.label).toBe(button.title);
    }
    // 悬停右翼每颗键都落到同一档 selection.hover，而不是只有工作详情被单独调过。
    for (const button of look.buttons) {
      await page.getByTestId(button.testid).hover();
      await expect.poll(() => page.evaluate((testid) => {
        const node = document.querySelector<HTMLElement>(`[data-testid="${testid}"]`)!;
        return getComputedStyle(node).backgroundColor;
      }, button.testid), { timeout: 5_000 }).toBe(look.hoverBg);
      await page.mouse.move(0, 0);
    }
    // 键盘焦点仍可见：从任务视图 Tab 到工作详情，焦点环由全局 focus-visible 规则提供。
    await page.evaluate(() => document.querySelector<HTMLElement>('[data-testid="collab-open-task-view"]')!.focus());
    await page.keyboard.press("Tab");
    const focus = await page.evaluate(() => {
      const node = document.activeElement as HTMLElement;
      const style = getComputedStyle(node);
      return { testid: node.dataset.testid ?? "", outlineWidth: style.outlineWidth,
        outlineStyle: style.outlineStyle };
    });
    expect(focus.testid).toBe("collab-conversation-inspector-toggle");
    expect(Number.parseFloat(focus.outlineWidth)).toBeGreaterThan(0);
    expect(focus.outlineStyle).not.toBe("none");
    await page.locator(".collab-center").screenshot({ path: "results/conversation-toolbar-icons-wide.png" });

    // 同一用途的开关在任务视图页头保持同形：纯图标、32×32、18px，名称按展开态切换。
    await page.getByTestId("collab-open-task-view").click();
    const headerToggle = page.getByTestId("collab-inspector-toggle");
    await expect(headerToggle).toBeVisible();
    const header = await headerToggle.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const icon = node.querySelector("svg")?.getBoundingClientRect();
      return { text: (node as HTMLElement).innerText.trim(), width: box.width, height: box.height,
        iconWidth: icon?.width ?? null, title: node.getAttribute("title"), label: node.getAttribute("aria-label"),
        expanded: node.getAttribute("aria-expanded") === "true" };
    });
    expect(header.text).toBe("");
    expect(header.width).toBeCloseTo(look.compact, 0);
    expect(header.height).toBeCloseTo(look.compact, 0);
    expect(header.iconWidth).toBeCloseTo(18, 0);
    expect(header.title).toBe(header.expanded ? "收起工作详情" : "展开工作详情");
    expect(header.label).toBe(header.title);
    await headerToggle.click();
    await expect(headerToggle).toHaveAttribute("aria-expanded", String(!header.expanded));
    await expect(headerToggle).toHaveAttribute("title",
      header.expanded ? "展开工作详情" : "收起工作详情");
    await page.locator(".page-head").screenshot({ path: "results/work-details-icon-task-header.png" });
  });

  // 用户要求宽、窄窗都检查实际渲染：窄窗里右翼图标键同排且不互相交叠、不越出顶栏，
  // 左翼让位后仍给每颗键完整命中区。
  test("窄窗：右翼图标键同排不重叠、不裁切，工作详情仍在最右", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await installTwoTaskSessions(page);
    await page.goto(`/agent?work=${taskId}&session=${sessionId}`);
    await connect(page);
    await expect(page.getByTestId("collab-conversation-toolbar")).toBeVisible({ timeout: 20_000 });
    const look = await page.evaluate(() => {
      const bar = document.querySelector<HTMLElement>('[data-testid="collab-conversation-toolbar"]')!;
      const barBox = bar.getBoundingClientRect();
      const boxes = [...document.querySelectorAll<HTMLElement>(".collab-toolbar-right button")].map((node) => {
        const box = node.getBoundingClientRect();
        const icon = node.querySelector("svg")?.getBoundingClientRect();
        return { testid: node.dataset.testid ?? "", left: box.left, right: box.right,
          top: box.top, bottom: box.bottom, width: box.width, height: box.height,
          iconWidth: icon?.width ?? null };
      });
      const overlaps = boxes.flatMap((a, index) => boxes.slice(index + 1).map((b) =>
        Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
        * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))));
      return { barLeft: barBox.left, barRight: barBox.right, barTop: barBox.top, barBottom: barBox.bottom,
        boxes, overlaps, pageOverflow: document.documentElement.scrollWidth - innerWidth };
    });
    expect(look.pageOverflow).toBeLessThanOrEqual(1);
    expect(look.boxes.at(-1)?.testid).toBe("collab-conversation-inspector-toggle");
    for (const box of look.boxes) {
      expect(box.width, `${box.testid} 命中区宽`).toBeCloseTo(32, 0);
      expect(box.height, `${box.testid} 命中区高`).toBeCloseTo(32, 0);
      expect(box.iconWidth, `${box.testid} 图标尺寸`).toBeCloseTo(18, 0);
      expect(box.left).toBeGreaterThanOrEqual(look.barLeft - 0.5);
      expect(box.right).toBeLessThanOrEqual(look.barRight + 0.5);
      expect(box.top).toBeGreaterThanOrEqual(look.barTop - 0.5);
      expect(box.bottom).toBeLessThanOrEqual(look.barBottom + 0.5);
    }
    for (const area of look.overlaps) expect(area).toBeLessThanOrEqual(0.5);
    await page.locator(".collab-center").screenshot({ path: "results/conversation-toolbar-icons-narrow.png" });
  });

  // 2026-10-17 下拉框去掉后，同作用域多条讨论的切换入口换成右翼这颗浮层键。
  // Task 绑定的会话不进近期工作栏，所以这条路径断了就等于回不到旧讨论：锁可见行为——
  // 键在右翼最前、面板浮在正文之上（不被转录区盖住）、当前讨论有标记、选一条就换掉会话名与正文。
  test("同作用域有两条讨论时，右翼「切换讨论」浮层能把人带回另一条", async ({ page }) => {
    await installTwoTaskSessions(page);
    await page.goto(`/agent?work=${taskId}&session=${sessionId}`);
    await connect(page);
    const toolbar = page.getByTestId("collab-conversation-toolbar");
    await expect(toolbar).toBeVisible({ timeout: 20_000 });
    const look = await page.evaluate(lookAtToolbar);
    expect(look.selectCount).toBe(0);
    expect(look.switcherCount).toBe(1);
    const order = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".collab-toolbar-right button")]
      .map((node) => node.dataset.testid ?? ""));
    expect(order.indexOf("collab-session-switcher")).toBe(0);
    expect(order.indexOf("collab-session-switcher")).toBeLessThan(order.indexOf("collab-conversation-inspector-toggle"));

    const switcher = page.getByTestId("collab-session-switcher");
    const panel = page.getByTestId("collab-session-switcher-panel");
    // 切换讨论也是纯图标键：可见文字退出，名称留在 title / aria-label 上。
    await expect(switcher).toHaveText("");
    await expect(switcher).toHaveAttribute("title", "切换讨论");
    await expect(switcher).toHaveAttribute("aria-label", "切换讨论");
    const trigger = await switcher.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const icon = node.querySelector("svg")?.getBoundingClientRect();
      return { width: box.width, height: box.height, iconWidth: icon?.width ?? null };
    });
    expect(trigger.width).toBeCloseTo(look.compactHeight, 0);
    expect(trigger.height).toBeCloseTo(look.compactHeight, 0);
    expect(trigger.iconWidth).toBeCloseTo(18, 0);
    await expect(switcher).toHaveAttribute("aria-expanded", "false");
    await switcher.click();
    await expect(switcher).toHaveAttribute("aria-expanded", "true");
    await expect(panel).toBeVisible();
    await expect(page.getByTestId(`collab-session-option-${sessionId}`)).toBeVisible();
    await expect(page.getByTestId(`collab-session-option-${secondSessionId}`)).toBeVisible();
    // 当前那条自身不可选：面板要能读出「我在哪儿」，而不是两条一样的行。
    await expect(page.getByTestId(`collab-session-option-${sessionId}`)).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId(`collab-session-option-${sessionId}`)).toBeDisabled();
    // 浮层画在正文之上，不吃指针命中的是面板自己（顶栏 z-index 抬到 sticky 档就是为了这一条）。
    const hit = await page.evaluate(() => {
      const box = document.querySelector<HTMLElement>("#collab-session-switcher-panel")!.getBoundingClientRect();
      const target = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return target?.closest("#collab-session-switcher-panel") !== null;
    });
    expect(hit).toBe(true);
    // 展开态与「工作详情」同一档选中色、仍然没有描边：顶栏里不出现第二种「按下」的颜色。
    // 点完键指针正停在键上，hover 一档要一起收进展开态，否则读回来的是淡底（§9.11 同特异度层叠）。
    // 底色与文字带 transition，轮询到落定值再读。
    await expect.poll(() => page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const asRgb = (value: string): string => {
        const hex = value.trim().replace("#", "");
        const full = hex.length === 3 ? hex.split("").map((part) => `${part}${part}`).join("") : hex;
        return `rgb(${[0, 2, 4].map((offset) => Number.parseInt(full.slice(offset, offset + 2), 16)).join(", ")})`;
      };
      const style = getComputedStyle(document.querySelector<HTMLElement>('[data-testid="collab-session-switcher"]')!);
      return style.backgroundColor === asRgb(root.getPropertyValue("--relay-color-selection-bg"))
        && style.color === asRgb(root.getPropertyValue("--relay-color-selection-text"))
        && style.borderLeftColor === "rgba(0, 0, 0, 0)";
    }), { timeout: 5_000 }).toBe(true);
    await page.locator(".collab-center").screenshot({ path: "results/conversation-session-switcher.png" });

    await page.getByTestId(`collab-session-option-${secondSessionId}`).click();
    await expect(page.getByTestId("collab-session-title")).toHaveText("评价方法第二讨论");
    await expect(page.locator(".agent-chat-transcript")).toContainText("第二讨论的第一句");
    // 选完即收：面板不留着一份已经失效的作用域列表。
    await expect(panel).toHaveCount(0);
    await expect(switcher).toHaveAttribute("aria-expanded", "false");
  });

  // 2026-10-17 用户实机截图指令「输入框左右两侧怎么颜色不一样？左边是背景白色，右边暗一点。顶栏也有」：
  // 根因是外壳卡片 .app-content 曾按 34rem 宽度把纸面横向渐隐回桌面，而这张纸面与窗口右缘齐平，
  // 右边没有桌面可退——渐变只是把正文右半染灰。锁的是「同一行左右两缘同色」这条可见事实，
  // 所以直接取真实像素比对，而不是只读计算样式（计算样式看不出祖先层叠出来的结果）。
  test("聊天列纸面左右同色：卡片两侧留白不是一白一暗", async ({ page }) => {
    await installRoutes(page, 6);
    await page.goto(`/agent?session=${sessionId}`);
    await connect(page);
    const toolbar = page.getByTestId("collab-conversation-toolbar");
    await expect(toolbar).toBeVisible({ timeout: 20_000 });
    const geo = await page.evaluate(() => {
      const rect = (el: Element) => el.getBoundingClientRect();
      const composer = rect(document.querySelector<HTMLElement>(".agent-chat-composer")!);
      const shell = rect(document.querySelector<HTMLElement>(".agent-chat-transcript-shell")!);
      const content = rect(document.querySelector<HTMLElement>(".app-content")!);
      const style = getComputedStyle(document.querySelector<HTMLElement>(".app-content")!);
      // token 字面量与计算样式对不上（#FFFFFF vs rgb(255,255,255)），挂一个探针节点让浏览器换算。
      const probe = document.createElement("div");
      probe.style.backgroundColor = "var(--relay-color-bg-surface)";
      document.body.append(probe);
      const surface = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { innerWidth: window.innerWidth, composerLeft: composer.left, composerRight: composer.right,
        composerY: composer.top + 6, shellLeft: shell.left, shellRight: shell.right, shellY: shell.top + 60,
        contentRight: content.right, backgroundImage: style.backgroundImage, backgroundColor: style.backgroundColor,
        surface };
    });
    // 纸面铺到窗口右缘：这正是右缘渐隐不成立的前提，两者要一起看。
    expect(Math.round(geo.contentRight)).toBe(geo.innerWidth);
    expect(geo.backgroundImage).toBe("none");
    expect(geo.backgroundColor).toBe(geo.surface);

    // 取整窗一行真实像素，在页面里用 canvas 解码后读回左右两缘的留白色。
    const sampleRow = async (y: number, leftX: number, rightX: number) => {
      const shot = await page.screenshot({ clip: { x: 0, y, width: geo.innerWidth, height: 1 } });
      return page.evaluate(async ({ png, a, b }) => {
        const image = new Image();
        await new Promise<void>((resolve, reject) => {
          image.onload = () => resolve();
          image.onerror = () => reject(new Error("截图解码失败"));
          image.src = `data:image/png;base64,${png}`;
        });
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = 1;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(image, 0, 0);
        const at = (x: number) => Array.from(ctx.getImageData(Math.round(x), 0, 1, 1).data.slice(0, 3));
        return { left: at(a), right: at(b) };
      }, { png: shot.toString("base64"), a: leftX, b: rightX });
    };

    // 输入卡两侧留白各取卡外 60px（避开卡片描边与阴影），两色必须逐通道相同。
    const paper = geo.surface.match(/\d+/gu)?.map(Number) ?? [];
    const composerRow = await sampleRow(Math.round(geo.composerY), geo.composerLeft - 60, geo.composerRight + 60);
    expect(composerRow.left).toEqual(composerRow.right);
    expect(composerRow.left).toEqual(paper);
    // 转录区同一件事：消息列两侧的空白左右同色（顶栏那一行被顶栏自己的实底渐变盖住，测不出祖先染色）。
    const shellRow = await sampleRow(Math.round(geo.shellY), geo.shellLeft + 40, geo.shellRight - 40);
    expect(shellRow.left).toEqual(shellRow.right);
    expect(shellRow.left).toEqual(paper);
    await page.locator(".collab-center").screenshot({ path: "results/conversation-paper-symmetry.png" });
  });

  // 2026-10-18 用户指令「更换目录和未选择目录合并成一个按钮」（连同「这两行的功能重复了」）：
  // 输入卡上方的状态行撤掉，目录细条是唯一幸存的那一行，「更换目录」并进目录名本身。
  // 锁的是层级关系而不是像素：静止档就是目录名自己——无底、无框、无圆角、不加下划线，
  // 字号字重与常态目录名逐值相同（它是事实主角，其次才是键）；悬停只补一道下划线说出
  // 「可点」，不铺底不描边；颜色由细条自己的状态承担（告警态随细条换色，不另染一层）。
  test("目录名即更换目录入口：静止无控件外观，悬停只补下划线", async ({ page }) => {
    await installRoutes(page);
    await page.goto(`/agent?session=${sessionId}`);
    await connect(page);
    const nameButton = page.getByTestId("folder-scope-change");
    await expect(nameButton).toBeVisible({ timeout: 20_000 });
    await expect(nameButton).toHaveText("Relay-Agent");
    const read = () => page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const asRgb = (value: string): string => {
        const hex = value.trim().replace("#", "");
        const full = hex.length === 3 ? hex.split("").map((part) => `${part}${part}`).join("") : hex;
        return `rgb(${[0, 2, 4].map((offset) => Number.parseInt(full.slice(offset, offset + 2), 16)).join(", ")})`;
      };
      const token = (name: string) => asRgb(root.getPropertyValue(name));
      const el = document.querySelector<HTMLElement>('[data-testid="folder-scope-change"]')!;
      const strip = document.querySelector<HTMLElement>(".folder-strip")!;
      const style = getComputedStyle(el);
      return { background: style.backgroundColor, borderWidth: style.borderTopWidth, color: style.color,
        radius: style.borderRadius, underline: style.textDecorationLine, cursor: style.cursor,
        fontSize: Number.parseFloat(style.fontSize), fontWeight: style.fontWeight,
        state: strip.dataset.state, transparent: "rgba(0, 0, 0, 0)",
        primary: token("--relay-color-text-primary"), warningText: token("--relay-color-status-warning-text"),
        body: Number.parseFloat(root.getPropertyValue("--relay-font-size-body")) * Number.parseFloat(root.fontSize),
        medium: root.getPropertyValue("--relay-font-weight-medium").trim() };
    });
    const rest = await read();
    // 这一屏细条处告警态（目录未归入项目）：目录名照旧随细条换警示色，键自己不另染一层。
    expect(rest.state).toBe("warning");
    expect(rest.color).toBe(rest.warningText);
    expect(rest.background).toBe(rest.transparent);
    expect(rest.borderWidth).toBe("0px");
    expect(rest.radius).toBe("0px");
    expect(rest.underline).toBe("none");
    expect(rest.cursor).toBe("pointer");
    // 它首先是那个目录名：正文档字号 + medium 字重，与合并前的目录名逐值相同。
    expect(rest.fontSize).toBeCloseTo(rest.body, 1);
    expect(rest.fontWeight).toBe(rest.medium);
    await page.locator(".folder-strip").screenshot({ path: "results/folder-strip-name-action.png" });
    await nameButton.hover();
    // 悬停只补下划线（该键没有 transition，轮询是为读数稳定，不按固定等待猜时长）。
    await expect.poll(async () => (await read()).underline, { timeout: 5_000 }).toBe("underline");
    await page.locator(".folder-strip").screenshot({ path: "results/folder-strip-name-action-hover.png" });
  });
});
