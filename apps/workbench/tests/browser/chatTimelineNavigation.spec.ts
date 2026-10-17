import { expect, test, type Locator, type Page, type Route } from "@playwright/test";

// 2026-10-16 聊天消息时间线导航（工作台 §31、设计系统 §9.12、测试计划 §32）。
// 真实 Chromium 里核对布局相关的行为：落点是否真的可读、顶栏与输入器是否被挡、
// 手动滚动是否更新当前刻度、跳到历史后新消息是否强拉到底、导航轨局部滚动是否带动正文、
// 窄容器是否降级、切会话是否隔离。身份绑定与截断算术在 tests/chatTimelineNav.spec.tsx。
// API 全部由 page.route 伪造：不连数据库、不调 Provider、导航与预览不产生任何写请求。

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const sessionA = "66666666-6666-4666-8666-666666666666";
const sessionB = "77777777-7777-4777-8777-777777777777";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = "http://127.0.0.1:4173";

type Mode = "ready" | "empty" | "loading" | "fail";

let messagesBySession: Record<string, unknown[]> = {};
/** 会话末尾那条 RUNNING 回复「写完之后」的清单：应用每 1.5s 轮询刷新时才会读到它。 */
let grownMessages: Record<string, unknown[]> = {};
let grown = false;
let sessionIds: string[] = [sessionA];
/** 会话是否挂在任务下：任务作用域的会话不进近期工作栏（RecentWorkRail 只列 taskId 为空的会话），
    需要靠工作栏行切换会话的用例必须把它们放进工作空间级。 */
let taskBoundSessions = true;
let mode: Mode = "ready";
let writeRequests: { method: string; path: string }[] = [];

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(), body: JSON.stringify(body) });
}

function sessionRow(id: string, title: string): unknown {
  return { id, workspace_id: workspaceId, project_id: projectId,
    task_id: taskBoundSessions ? taskId : null, title,
    status: "ACTIVE", revision: "1", conversation_mode: "AGENT", assistant_profile_id: null,
    created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z" };
}

function row(id: string, session: string, seq: number, role: "USER" | "ASSISTANT",
  content: string | null, status = "COMPLETED"): unknown {
  return { id, session_id: session, seq: String(seq), role, status, intent: "DISCUSS",
    created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z", content,
    error_code: null, provider_error_kind: null, sources: [], skill: null,
    cancel_requested: false, usage: { input_tokens: 120, output_tokens: 64,
      cache_read_tokens: null, cache_creation_tokens: null } };
}

/** 一问一答共 rounds 轮；u-3 与 u-7 故意用完全相同的提问文字。
    回复写成 200 字以上，预览摘要必然截断，窄屏下也让每条消息有实际高度。
    tail=true 时末尾多一条「还在生成中」的回复：应用会为它继续轮询刷新，
    测试中途把清单换成 grown 版本就等于「历史阅读期间新消息到了」。
    两个会话用不同前缀（u / v），和真实后端一样不跨会话重复消息 ID。 */
function conversation(session: string, rounds: number, tag = "u", tail = false): unknown[] {
  const rows: unknown[] = [];
  let seq = 1;
  for (let index = 1; index <= rounds; index += 1) {
    const same = index === 3 || index === 7;
    const question = same ? "这个基线要怎么定？" : `第 ${index} 个问题：请说明这一轮的验收依据与基线口径。`;
    rows.push(row(`${tag}-${index}`, session, seq += 1, "USER", question));
    rows.push(row(`${tag}x-${index}`, session, seq += 1, "ASSISTANT",
      `第 ${index} 轮回复：基线按现有实现取，验收依据写在契约包里。${"补充说明与对照口径。".repeat(index + 20)}`));
  }
  if (!tail) return rows;
  rows.push(row(`${tag}-${rounds + 1}`, session, seq += 1, "USER", "新到的提问：这一轮还要补什么？"));
  rows.push(row(`${tag}x-${rounds + 1}`, session, seq += 1, "ASSISTANT", null, "RUNNING"));
  return rows;
}

/** 把末尾那条 RUNNING 回复写完，再追加一轮已完成的问答（第 nextIndex 轮）。 */
function grownAfter(base: readonly unknown[], nextIndex: number): unknown[] {
  const completed = base.at(-1) as Record<string, unknown>;
  return [...base.slice(0, -1), { ...completed, status: "COMPLETED", content: "补验收依据即可。" },
    row(`u-${nextIndex}`, String(completed.session_id), 900, "USER", "再补一条：这一轮还要改什么？"),
    row(`ux-${nextIndex}`, String(completed.session_id), 901, "ASSISTANT", "不用改，等下一轮。")];
}

async function installRoutes(page: Page): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (method !== "GET") writeRequests.push({ method, path });
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/tasks/${taskId}`) return fulfillJson(route, { id: taskId,
      project_id: projectId, title: "时间线导航验证", status: "IN_PROGRESS", mode: "ME",
      revision: "2", created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z",
      executor: { kind: "HUMAN", run_id: null, ownership_epoch: "1" },
      current_completion_id: null, waiting_reason: null, blocking_task_ids: [],
      unresolved_blocker_ids: [], allowed_actions: [],
      acceptance: { acceptance_revision: "2", objective: "只读验证。", source: "CREATE",
        created_at: "2026-10-16T00:00:00Z", criteria: [] }, dependencies: [] });
    if (path === `${prefix}/projects/${projectId}`) return fulfillJson(route, { id: projectId,
      title: "人机协作工作流研究", project_type: "GENERAL", revision: "1", state_revision: "1",
      archived_at: null });
    if (path === `${prefix}/model-port`) return fulfillJson(route, { provider: "fake",
      configured: false, model: null, base_url: null, max_call_tokens: null });
    if (path === `${prefix}/assist-sessions`) return fulfillJson(route, { items: sessionIds.map((id) =>
      sessionRow(id, id === sessionA ? "时间线会话" : "另一个会话")) });
    const messages = path.match(/^\/api\/v1\/workspaces\/[0-9a-f-]+\/assist-sessions\/([0-9a-f-]+)\/messages$/u);
    if (messages) {
      const session = messages[1]!;
      if (mode === "fail") return fulfillJson(route, { code: "INTERNAL", detail: "消息读取失败" }, 500);
      if (mode === "empty") return fulfillJson(route, { items: [] });
      if (mode === "loading") await new Promise((resolve) => setTimeout(resolve, 1_200));
      const list = grown ? grownMessages[session] ?? messagesBySession[session] : messagesBySession[session];
      return fulfillJson(route, { items: list ?? [] });
    }
    const preview = path.match(/\/assist-sessions\/([0-9a-f-]+)\/messages\/([0-9a-f-]+)\/live-preview$/u);
    if (preview) return fulfillJson(route, { session_id: preview[1], message_id: preview[2],
      status: grown ? "COMPLETED" : "RUNNING", preview_revision: "1", preview_text: null,
      preview_truncated: false, preview_available: false });
    const detail = path.match(/^\/api\/v1\/workspaces\/[0-9a-f-]+\/assist-sessions\/([0-9a-f-]+)$/u);
    if (detail) return fulfillJson(route, sessionRow(detail[1]!, "时间线会话"));
    if (path === `${prefix}/assist-proposals`) return fulfillJson(route, { items: [] });
    if (path === `${prefix}/skill-definitions`) return fulfillJson(route, { items: [] });
    if (path === `${prefix}/chat-commands`) return fulfillJson(route, { items: [] });
    if (path.startsWith(`${prefix}/conversation-execution-requests`)) return fulfillJson(route, { items: [] });
    if (path.startsWith(`${prefix}/learning`)) return fulfillJson(route, { items: [], epoch: "0" });
    return fulfillJson(route, { items: [], next_cursor: null });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("timeline-browser-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

/** 打开任务作用域的聊天视图：与协作页真实入口一致，聊天列就是时间线所在的容器。 */
async function openChat(page: Page, options: {
  rounds?: number; mode?: Mode; sessions?: string[]; pendingTail?: boolean; standalone?: boolean } = {}) {
  mode = options.mode ?? "ready";
  sessionIds = options.sessions ?? [sessionA];
  taskBoundSessions = options.standalone !== true;
  const rounds = options.rounds ?? 12;
  grown = false;
  const base = conversation(sessionA, rounds, "u", options.pendingTail === true);
  messagesBySession = { [sessionA]: base, [sessionB]: conversation(sessionB, 4, "v") };
  grownMessages = options.pendingTail === true ? { [sessionA]: grownAfter(base, rounds + 2) } : {};
  writeRequests = [];
  await installRoutes(page);
  await page.goto(options.standalone === true ? `/agent?session=${sessionIds[0]}` : `/agent?work=${taskId}`);
  await connect(page);
  // 协作页的任务表头在聊天视图下整块 `hidden`（CollaborationView 的 `collab-goal`），
  // 视图页签也落在那个表头里、此刻不可见；而聊天视图本来就是默认视图
  // （`useState<"chat" | "task">("chat")`），所以这里不再点页签，直接等聊天列渲染。
  await expect(page.getByTestId("assist-transcript")).toBeVisible({ timeout: 20_000 });
}

function timeline(page: Page): Locator { return page.getByTestId("chat-timeline"); }
function rail(page: Page): Locator { return page.getByTestId("chat-timeline-rail"); }
function node(page: Page, messageId: string): Locator {
  return page.getByTestId(`chat-timeline-node-${messageId}`);
}
function slot(page: Page, messageId: string): Locator {
  return page.locator(`[data-chat-timeline-slot][data-message-id="${messageId}"]`);
}
function transcript(page: Page): Locator { return page.getByTestId("assist-transcript"); }

/** 跳转后目标开头与可读区上沿之间的呼吸位；与组件同源取 space.2（0.5rem = 8px）。 */
const READ_INSET = 8;

/** 跳转后目标开头相对消息流可视区上沿的偏移，以及是否已贴到消息流的顶/底。 */
async function landing(page: Page, messageId: string): Promise<{ delta: number; clamped: boolean }> {
  return transcript(page).evaluate((element, id) => {
    const slot = element.querySelector<HTMLElement>(`[data-chat-timeline-slot][data-message-id="${id}"]`);
    return { delta: slot === null ? Number.NaN : slot.getBoundingClientRect().top - element.getBoundingClientRect().top,
      clamped: element.scrollTop === 0 || element.scrollHeight - element.scrollTop - element.clientHeight <= 1 };
  }, messageId);
}

/**
 * 平滑滚动是异步的：不能一看读数落进「上沿以上」就判定到位，那样动画还在中途。
 * 先等滚动停下（连续两次 scrollTop 读数一致），再核对落点几何：
 * 目标开头进入可读区并停在呼吸位内；首/末条则停在消息流真实的顶或底——
 * 最后一条提问下面只剩它自己的回复，物理上不可能再滚到上沿。
 */
async function expectLanded(page: Page, messageId: string): Promise<void> {
  let previous = -1;
  await expect.poll(async () => {
    const scrollTop = await transcript(page).evaluate((element) => element.scrollTop);
    const stable = scrollTop === previous;
    previous = scrollTop;
    if (!stable) return false;
    const { delta, clamped } = await landing(page, messageId);
    return !Number.isNaN(delta) && delta >= 0 && (delta <= READ_INSET + 2 || clamped);
  }, { timeout: 8_000, message: `目标 ${messageId} 的开头没有停进可读区上沿` }).toBe(true);
}

/** 每条刻度此刻的可见长度：长度只写在 ::before 上，节点自身恒为命中区尺寸（24px 见方）。 */
async function tickWidths(page: Page): Promise<number[]> {
  return page.locator(".agent-chat-timeline-node").evaluateAll((elements) =>
    elements.map((element) => Number.parseFloat(window.getComputedStyle(element, "::before").width)));
}

/** 刻度的「长度 / 与指针的垂直距离 / 是否当前位置」，按与指针的距离升序——联动的形状。 */
async function tickProfile(page: Page, pointerY: number): Promise<
  { id: string; distance: number; width: number; current: boolean }[]> {
  const rows = await rail(page).evaluate((element) => Array.from(
    element.querySelectorAll<HTMLElement>(".agent-chat-timeline-node")).map((node) => {
    const box = node.getBoundingClientRect();
    return { id: node.dataset.testid ?? "", center: box.top + box.height / 2,
      width: Number.parseFloat(window.getComputedStyle(node, "::before").width),
      current: node.getAttribute("aria-current") === "true" };
  }));
  return rows.map((row) => ({ id: row.id, distance: Math.abs(row.center - pointerY),
    width: row.width, current: row.current }))
    .sort((left, right) => left.distance - right.distance);
}

/**
 * 当前刻度是否正好落在「已越过读区上沿的最后一条提问」上：自己已越过，下一条提问还没越过
 * （已贴底时除外）。助手消息不建节点，因此不参与上沿比对。
 * 返回 null 表示此刻轨道上没有唯一的当前刻度。
 */
async function readLineState(page: Page): Promise<{ activeId: string; ok: boolean } | null> {
  const active = page.locator('.agent-chat-timeline-node[aria-current="true"]');
  if (await active.count() !== 1) return null;
  const activeId = (await active.getAttribute("data-testid"))!.replace("chat-timeline-node-", "");
  const check = await transcript(page).evaluate((element, id) => {
    const asked = Array.from(element.querySelectorAll<HTMLElement>(
      '[data-chat-timeline-slot][data-message-id^="u-"]'));
    const top = element.getBoundingClientRect().top;
    const delta = (slot: HTMLElement | undefined) =>
      (slot === undefined ? null : slot.getBoundingClientRect().top - top);
    const mine = asked.findIndex((slot) => slot.dataset.messageId === id);
    return { found: mine >= 0, self: delta(asked[mine]), next: delta(asked[mine + 1]),
      atBottom: element.scrollHeight - element.scrollTop - element.clientHeight <= 1 };
  }, activeId);
  if (!check.found || check.self === null) return { activeId, ok: false };
  const entered = check.self <= READ_INSET + 1;
  const ahead = check.next === null || check.next > READ_INSET + 1;
  return { activeId, ok: entered && (check.atBottom || ahead) };
}

test.describe("聊天消息时间线导航", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("首/中/末节点定位到该条提问，重复文本不串位", async ({ page }) => {
    await openChat(page);
    await expect(timeline(page)).toBeVisible();
    await expect(node(page, "u-1")).toBeVisible();
    await expect(node(page, "u-12")).toBeVisible();
    // 只为提问建节点：助手消息（ux-*）不出现在轨道上。
    await expect(node(page, "ux-1")).toHaveCount(0);
    for (const id of ["u-1", "u-7", "u-3", "u-12"]) {
      await node(page, id).click();
      await expectLanded(page, id);
      await expect(node(page, id)).toHaveAttribute("aria-current", "true");
      // 指针还停在刻度上，但跳转后预览必须收起：不然浮层压住刚定位到的正文。
      await expect(page.getByTestId("chat-timeline-preview")).toHaveCount(0);
      const box = await slot(page, id).boundingBox();
      const area = await transcript(page).boundingBox();
      expect(box).not.toBeNull();
      expect(area).not.toBeNull();
      // 落点确实进了消息区可视高度，没有停在滚动容器上沿之外。宽屏档的应用顶栏行
      // 本身按 :not(:has(.breadcrumbs)) 收起，真正会遮落点的边界就是这个 Owner 的上沿。
      expect(box!.y).toBeGreaterThanOrEqual(area!.y - 1);
      expect(box!.y).toBeLessThan(area!.y + area!.height - 40);
    }
    await page.screenshot({ path: "results/chat-timeline-jump.png" });
  });

  test("悬停与键盘聚焦显示原文片段，Esc 关闭且不抢输入焦点", async ({ page }) => {
    await openChat(page);
    const draft = page.getByTestId("assist-draft");
    await draft.focus();
    const before = await transcript(page).evaluate((element) => element.scrollTop);
    await node(page, "u-3").hover();
    const preview = page.getByTestId("chat-timeline-preview");
    await expect(preview).toBeVisible();
    await expect(page.getByTestId("chat-timeline-preview-title"))
      .toHaveText("这个基线要怎么定？");
    const body = await page.getByTestId("chat-timeline-preview-body").textContent();
    expect(body).toContain("第 3 轮回复");
    expect(body!.endsWith("…")).toBe(true); // 摘要截断可辨
    // 预览不滚动正文、不抢输入焦点
    expect(await transcript(page).evaluate((element) => element.scrollTop)).toBe(before);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe("assist-draft");
    // 浮层不越过消息区左缘到屏幕外，也不压住输入器与发送键
    const previewBox = await preview.boundingBox();
    const composer = await page.getByTestId("assist-composer").boundingBox();
    const shell = await page.locator(".agent-chat-transcript-shell").boundingBox();
    expect(previewBox!.x).toBeGreaterThanOrEqual(shell!.x);
    expect(previewBox!.x + previewBox!.width).toBeLessThanOrEqual(shell!.x + shell!.width + 1);
    expect(previewBox!.y + previewBox!.height).toBeLessThanOrEqual(composer!.y + 1);
    await page.screenshot({ path: "results/chat-timeline-preview.png" });

    await node(page, "u-3").focus();
    await expect(preview).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(preview).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe("chat-timeline-node-u-3");
  });

  test("导航与预览零业务写入、零模型调用，未发送草稿保留", async ({ page }) => {
    await openChat(page);
    const draft = page.getByTestId("assist-draft");
    await draft.fill("这段还没打算发出去");
    await node(page, "u-5").hover();
    await expect(page.getByTestId("chat-timeline-preview")).toBeVisible();
    await node(page, "u-5").click();
    await expectLanded(page, "u-5");
    await expect(draft).toHaveValue("这段还没打算发出去");
    await expect(page.getByTestId("assist-send")).toBeEnabled();
    // 输入器自带的草稿助手（`POST /composer/draft-assist`，并行会话在途功能）会在打字后
    // 自己发请求，与时间线无关，也不受导航影响；这里核对的是「导航与预览零写请求」，
    // 故只把那一个端点排除在断言外，其余任何非 GET 请求仍必须为空。
    expect(writeRequests.filter((request) => !request.path.endsWith("/composer/draft-assist"))).toEqual([]);
  });

  test("手动滚动更新当前刻度；跳到历史后新消息不强拉到底部", async ({ page }) => {
    test.setTimeout(60_000);
    await openChat(page, { pendingTail: true });
    await node(page, "u-9").click();
    await expectLanded(page, "u-9");
    // 手动滚回中段：当前刻度跟着实际阅读位置，不是最后点击的那一条。
    await transcript(page).evaluate((element) => { element.scrollTop = 600; });
    await expect.poll(async () => (await readLineState(page))?.ok, { timeout: 5_000 }).toBe(true);
    const trackedId = (await readLineState(page))!.activeId;
    expect(trackedId).not.toBe("u-9");

    await node(page, "u-2").click();
    await expectLanded(page, "u-2");
    const historyTop = await transcript(page).evaluate((element) => element.scrollTop);
    // 历史阅读期间：末尾那条 RUNNING 回复写完、又新到一轮问答（应用按 1.5s 轮询重读）。
    // 正文不能被打回底部，「回到最新」继续承担跟随。
    grown = true;
    await expect(slot(page, "u-14")).toBeVisible({ timeout: 12_000 });
    expect(await transcript(page).evaluate((element) => element.scrollTop)).toBe(historyTop);
    await expect(page.getByTestId("assist-latest")).toBeVisible();
    await expect(node(page, "u-14")).toBeVisible();
    await page.screenshot({ path: "results/chat-timeline-reading-guard.png" });

    await page.getByTestId("assist-latest").click();
    await expect.poll(async () => transcript(page).evaluate((element) =>
      element.scrollHeight - element.scrollTop - element.clientHeight), { timeout: 5_000 }).toBeLessThan(40);
  });

  test("导航轨局部滚动不带动正文，刻度命中区不重叠", async ({ page }) => {
    await openChat(page, { rounds: 30 });
    const railBox = await rail(page).boundingBox();
    expect(railBox).not.toBeNull();
    const hits = await page.locator(".agent-chat-timeline-node").evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, width: box.width, height: box.height };
      }));
    expect(hits.length).toBe(30);
    expect(hits.every((hit) => hit.width >= 24 && hit.height >= 24)).toBe(true);
    expect(hits.every((hit, index) => index === 0 || hit.top >= hits[index - 1]!.bottom - 0.5)).toBe(true);

    const bodyTop = await transcript(page).evaluate((element) => element.scrollTop);
    // 常驻档在左缘预留 gutter：轨道只占留白，不压正文、不遮消息。
    const firstSlotBox = await slot(page, "u-1").boundingBox();
    expect(firstSlotBox!.x).toBeGreaterThanOrEqual(railBox!.x + railBox!.width - 1);
    await page.mouse.move(railBox!.x + railBox!.width / 2, railBox!.y + railBox!.height / 2);
    await page.mouse.wheel(0, 240);
    await expect.poll(async () => rail(page).evaluate((element) => element.scrollTop), { timeout: 3_000 })
      .toBeGreaterThan(0);
    expect(await transcript(page).evaluate((element) => element.scrollTop)).toBe(bodyTop);
  });

  test("切换会话后旧节点、旧预览与旧跳转都不作用于新消息流", async ({ page }) => {
    // 切换入口只剩近期工作栏，而工作栏只列工作空间级会话（taskId 为空），所以这条用例用不挂任务的会话。
    await openChat(page, { sessions: [sessionA, sessionB], standalone: true });
    await node(page, "u-4").hover();
    await expect(page.getByTestId("chat-timeline-preview")).toBeVisible();
    await node(page, "u-4").click();
    await expectLanded(page, "u-4");

    // 先把指针移出轨道：否则切完会话后新轨道正好落在同一位置下，hover 会合法地重开一条预览。
    await page.mouse.move(4, 4);
    await expect(page.getByTestId("chat-timeline-preview")).toHaveCount(0);
    // 顶栏不再有切换下拉（2026-10-17 用户指令），切换会话的唯一入口是近期工作栏的行。
    // 这里用键盘 Enter 而不是鼠标 .click()：RecentWorkRail.beginDrag 在 pointerdown 上
    // setPointerCapture(行 li)，浏览器把随后的 click 重定向到 li，行按钮的 onClick 收不到——
    // 鼠标点行目前打不开讨论（2026-10-17 发现，拖拽改序那一支的回归，已由 recentWorkRailDensity
    // 自己的用例红着）。键盘激活走按钮自己，不受影响；等那支修好这里也照旧通过。
    await page.getByTestId(`recent-work-${sessionB}`).press("Enter");
    await expect(page.getByTestId("assist-session")).toBeVisible();
    // 两个会话的提问文字有完全相同的那几条，但消息 ID 前缀不同：旧会话的节点与预览都不该留下。
    await expect(node(page, "u-4")).toHaveCount(0);
    await expect(page.getByTestId("chat-timeline-preview")).toHaveCount(0);
    await expect(page.getByTestId("chat-timeline-notice")).toHaveCount(0);
    // 先等新会话的消息真的读出来（换行是导航，正文要再打一趟 messages）。
    await expect(node(page, "v-1")).toHaveCount(1);
    // 新会话的槽位只带新会话身份：迟到的旧跳转不可能再命中它。
    expect(await page.locator("[data-chat-timeline-slot]").evaluateAll((elements) =>
      Array.from(new Set(elements.map((element) => element.getAttribute("data-timeline-session"))))))
      .toEqual([sessionB]);
    await node(page, "v-2").click();
    await expectLanded(page, "v-2");
  });

  test("空会话隐藏时间线；读取中与读取失败不伪造节点", async ({ page }) => {
    await openChat(page, { mode: "empty" });
    await expect(page.getByTestId("assist-empty-welcome")).toBeVisible();
    await expect(timeline(page)).toHaveCount(0);

    await openChat(page, { mode: "loading" });
    await expect(page.getByText("正在读取会话消息…")).toBeVisible();
    await expect(timeline(page)).toHaveCount(0);

    await openChat(page, { mode: "fail" });
    // 失败只呈现原有错误行与「重读」入口，时间线不因读不到消息而伪造节点。
    await expect(page.getByRole("button", { name: "重读" })).toBeVisible();
    await expect(timeline(page)).toHaveCount(0);
  });

  test("窄短窗降为左缘紧凑入口，展开后仍可跳转且不遮输入器", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 700 });
    await openChat(page, { rounds: 12 });
    await expect(timeline(page)).toBeVisible();
    await expect(rail(page)).not.toBeVisible();
    const toggle = page.getByTestId("chat-timeline-toggle");
    await expect(toggle).toBeVisible();
    // 紧凑档不预留 gutter：正文列宽度不因轨道而缩。
    const padding = await transcript(page).evaluate((element) =>
      Number.parseFloat(window.getComputedStyle(element).paddingLeft));
    expect(padding).toBeLessThan(1);

    await toggle.click();
    await expect(rail(page)).toBeVisible();
    await expect(rail(page)).toHaveAttribute("data-expanded", "true");
    // 展开是浮层，不回头压缩正文：gutter 仍然是 0。
    expect(await transcript(page).evaluate((element) =>
      Number.parseFloat(window.getComputedStyle(element).paddingLeft))).toBeLessThan(1);
    const railBox = await rail(page).boundingBox();
    const composer = await page.getByTestId("assist-composer").boundingBox();
    expect(railBox!.y + railBox!.height).toBeLessThanOrEqual(composer!.y + 1);
    await page.screenshot({ path: "results/chat-timeline-narrow-expanded.png" });
    await node(page, "u-6").click();
    await expectLanded(page, "u-6");
    await page.screenshot({ path: "results/chat-timeline-narrow.png" });

    await toggle.click();
    await expect(rail(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(rail(page)).not.toBeVisible();
  });

  test("减少动态效果偏好下落点仍然准确", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openChat(page);
    await node(page, "u-8").click();
    await expectLanded(page, "u-8");
    await expect(slot(page, "u-8")).toHaveAttribute("data-chat-timeline-target", "true");
    expect(await page.evaluate(() =>
      window.matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  });

  /**
   * 悬停联动的真机几何：刻度间距 24px、影响半径 72px（3 格）、基准 8px、峰值 20px。
   * 这里只钉「形状」不钉每一步的绝对值：当前位置那档有 16px 的下限，逐条比较会把它当成反例。
   */
  test("指针在轨道内时刻度按距离递减，移出后复位", async ({ page }) => {
    await openChat(page, { rounds: 12 });
    const railBox = await rail(page).boundingBox();
    const target = await node(page, "u-6").boundingBox();
    expect(railBox).not.toBeNull();
    expect(target).not.toBeNull();
    const pointerY = target!.y + target!.height / 2;

    await page.mouse.move(railBox!.x + railBox!.width / 2, pointerY);
    await expect(rail(page)).toHaveAttribute("data-tracking", "true");
    // 联动写长度走 rAF，轨道内又关掉了宽度过渡：等峰值落到「轨道宽 − 呼吸位」= 20px。
    await expect.poll(async () => (await tickProfile(page, pointerY))[0]!.width,
      { timeout: 5_000 }).toBeGreaterThan(19);

    const profile = await tickProfile(page, pointerY);
    // 峰值就在指针下那一条，且严格长于轨道上其余任何一条。
    expect(profile[0]!.id).toBe("chat-timeline-node-u-6");
    expect(profile[0]!.width).toBeCloseTo(20, 1);
    expect(profile[0]!.width).toBeGreaterThan(Math.max(...profile.slice(1).map((row) => row.width)));
    // 衰减连续可辨：按距离排开的「非当前刻度」长度单调不增。
    // 当前位置那档有 16px 下限，混进来会读成「离得远的反而更长」，故单列出来看。
    const plain = profile.filter((row) => !row.current);
    expect(plain.length).toBeGreaterThan(4);
    for (let index = 1; index < plain.length; index += 1) {
      expect(plain[index]!.width).toBeLessThanOrEqual(plain[index - 1]!.width + 0.01);
    }
    // 相邻一档仍高于基准、又明显低于峰值：不是一离开指针就掉回默认，也不是整条轨道一起加长。
    expect(plain[1]!.width).toBeGreaterThan(8);
    expect(plain[1]!.width).toBeLessThan(20);
    // 超出影响半径（3 × control.target.minimum = 72px）回到基准档。
    expect(plain.at(-1)!.width).toBeCloseTo(8, 1);
    // 当前位置刻度不被联动压短：联动只加长，调用方与它自己的档取较大值。
    expect(profile.filter((row) => row.current).every((row) => Math.abs(row.width - 16) < 0.5)).toBe(true);
    await page.screenshot({ path: "results/chat-timeline-tick-falloff.png" });

    // 指针移出轨道：跟踪态与内联长度都清掉，长度按默认档复位（过渡恢复，等它走完）。
    await page.mouse.move(railBox!.x - 60, railBox!.y + railBox!.height / 2);
    await expect(rail(page)).not.toHaveAttribute("data-tracking", "true");
    await expect.poll(async () => Math.max(...await tickWidths(page)), { timeout: 3_000 })
      .toBeLessThanOrEqual(16.1);
    const rested = await tickWidths(page);
    expect(rested.every((width) => Math.abs(width - 8) < 0.5 || Math.abs(width - 16) < 0.5)).toBe(true);
    expect(await page.locator(".agent-chat-timeline-node[aria-current=\"true\"]")
      .evaluateAll((elements) => elements.map((element) =>
        Number.parseFloat(window.getComputedStyle(element, "::before").width))))
      .toEqual([16]); // 当前位置那档不被联动压短，指针移走后回到 16
  });

  /** 刻度组居中：短会话留白均分在首尾，长会话放不下时 auto 边距归零、第一条仍可达。 */
  test("刻度组在轨道内垂直居中，长会话退回从顶排列且首刻度可达", async ({ page }) => {
    await openChat(page, { rounds: 3 });
    const railBox = await rail(page).boundingBox();
    const first = await node(page, "u-1").boundingBox();
    const last = await node(page, "u-3").boundingBox();
    expect(railBox).not.toBeNull();
    expect(first).not.toBeNull();
    expect(last).not.toBeNull();
    const gapTop = first!.y - railBox!.y;
    const gapBottom = railBox!.y + railBox!.height - (last!.y + last!.height);
    // 确实是居中而不是从顶排列：上方留出了实打实的空间，且首尾留白等量。
    expect(gapTop).toBeGreaterThan(40);
    expect(Math.abs(gapTop - gapBottom)).toBeLessThanOrEqual(2);
    await page.screenshot({ path: "results/chat-timeline-centered.png" });

    await openChat(page, { rounds: 30 });
    const metrics = await rail(page).evaluate((element) => {
      const firstNode = element.firstElementChild!.getBoundingClientRect();
      const railRect = element.getBoundingClientRect();
      return { scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
        scrollTop: element.scrollTop, offset: firstNode.top - railRect.top };
    });
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight + 1);
    expect(metrics.scrollTop).toBe(0);
    // 放不下时只剩轨道自身的内边距（space.4 = 16px）：居中留白归零，第一条不会被顶出可视区。
    expect(metrics.offset).toBeLessThan(24);
    const railBox2 = await rail(page).boundingBox();
    const reachable = await node(page, "u-1").boundingBox();
    expect(reachable!.y).toBeGreaterThanOrEqual(railBox2!.y - 0.5);
    expect(reachable!.y + reachable!.height).toBeLessThanOrEqual(railBox2!.y + railBox2!.height + 0.5);
  });
});
