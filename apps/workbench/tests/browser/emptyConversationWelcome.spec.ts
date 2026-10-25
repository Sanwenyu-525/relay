import { expect, test, type Locator, type Page, type Route } from "@playwright/test";

// 2026-10-16 不同入口新建会话首屏一致。
// 全局「新对话」（?new=）走延迟建会话的首条输入区，任务作用域「新建会话」先建会话再进面板；
// 两条路径的空态此前一个是欢迎页、一个是「还没有消息。」。这里在真实 Chromium 里核对：
// 两处渲染同一个欢迎块（同一标题、同一组快捷卡），且欢迎在消息区可视高度内居中。
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

/** 任务作用域里的一条刚建好、还没有消息的会话。 */
const emptySession = { id: sessionId, workspace_id: workspaceId, project_id: projectId, task_id: taskId,
  title: "关于确定实验评价指标", status: "ACTIVE", revision: "1",
  working_resource_id: "88888888-8888-4888-8888-888888888888",
  context: { project_goals: [], working_directory: {
    resource_id: "88888888-8888-4888-8888-888888888888", canonical_root: "D:\\Work\\Research" } },
  created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z" };

/** 「待你处理」要有真实来源才渲染得出：一条待人工判断的 Review（GLOBAL 作用域只按状态筛）。 */
const openReview = { id: "44444444-4444-4444-8444-444444444444", kind: "CRITERION", status: "OPEN",
  revision: "3", project_id: projectId, task_id: taskId, run_id: null,
  reason: "AWAITING_HUMAN_EVIDENCE", target_hash: "b".repeat(64),
  target: { artifact_version_id: "55555555-5555-4555-8555-555555555555", acceptance_revision: "2", criterion_id: "c1" },
  evidence: { check_result: "自动检查不能代替人工判断" }, effect: { on_accept: "重新核对完成条件" },
  allowed_decisions: ["ACCEPT", "REQUEST_CHANGES"], expires_at: null,
  created_at: "2026-10-18T00:00:00Z", decided_at: null };

function task(): unknown {
  return { id: taskId, project_id: projectId, title: "确定实验评价指标", status: "IN_PROGRESS", mode: "ME",
    revision: "2", created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z",
    // 契约要求 executor 是对象（kind 只接受 HUMAN/AI）；HUMAN + run_id null 不触发 Run 读取。
    executor: { kind: "HUMAN", run_id: null, ownership_epoch: "1" },
    current_completion_id: null, waiting_reason: null, blocking_task_ids: [],
    unresolved_blocker_ids: [], allowed_actions: [],
    acceptance: { acceptance_revision: "2", objective: "补齐基线与验收依据。", source: "CREATE",
      created_at: "2026-10-16T00:00:00Z", criteria: [] },
    dependencies: [] };
}

async function installRoutes(page: Page): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/tasks/${taskId}`) return fulfillJson(route, task());
    if (path === `${prefix}/projects/${projectId}`) return fulfillJson(route, { id: projectId,
      title: "人机协作工作流研究", project_type: "GENERAL", revision: "1", state_revision: "1",
      archived_at: null });
    if (path === `${prefix}/model-port`) {
      return fulfillJson(route, { provider: "fake", configured: false, model: null, base_url: null,
        max_call_tokens: null });
    }
    if (path === `${prefix}/assist-sessions`) return fulfillJson(route, { items: [emptySession] });
    if (path === `${prefix}/assist-sessions/${sessionId}`) return fulfillJson(route, emptySession);
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return fulfillJson(route, { items: [] });
    return fulfillJson(route, { items: [], next_cursor: null });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("empty-welcome-browser-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

/** 欢迎块必须落在消息区可视高度内垂直居中：上沿与下沿的空白大致相当。 */
async function expectCenteredInTranscript(page: Page, welcome: Locator): Promise<void> {
  const shell = await page.getByTestId("assist-transcript").boundingBox();
  const box = await welcome.boundingBox();
  expect(box).not.toBeNull();
  expect(shell).not.toBeNull();
  const above = box!.y - shell!.y;
  const below = shell!.y + shell!.height - (box!.y + box!.height);
  expect(above).toBeGreaterThan(0);
  expect(Math.abs(above - below)).toBeLessThan(shell!.height * 0.25);
}

test.describe("新建会话空态一致", () => {
  test.use({ viewport: { width: 1487, height: 1058 } });

  test("全局新对话：首条输入区渲染欢迎块", async ({ page }) => {
    await installRoutes(page);
    // 连接只活在内存里：先落到目标地址再连接，连接后不再整页跳转。
    await page.goto("/agent?new=browser");
    await connect(page);
    const welcome = page.getByTestId("assist-first-welcome");
    await expect(welcome).toBeVisible({ timeout: 20_000 });
    await expect(welcome.locator("h1")).toHaveText("有什么想一起完成的？");
    await expect(welcome.locator(".agent-chat-suggestion")).toHaveCount(11);
    // 2026-10-18 用户指令「快捷语改成两行」：11 张卡在此视口必须摊成 6+5 两行。
    // 锁行数与「最后一行的卡数」这一关系，不锁像素；卡片左右内边距被放宽回去就会多出一行。
    const rows = await welcome.locator(".agent-chat-suggestion").evaluateAll((els) => {
      const counts: number[] = [];
      let top = Number.NaN;
      for (const el of els) {
        const b = el.getBoundingClientRect().top;
        if (Number.isNaN(top) || Math.abs(b - top) > 6) { top = b; counts.push(1); }
        else counts[counts.length - 1] += 1;
      }
      return counts;
    });
    expect(rows).toEqual([6, 5]);
    // 分隔板只有功能族边界那 2 道（规划→核心交付→实施质量接续，2026-10-23 收敛为三族），逐卡加箭头会读成强制顺序。
    await expect(welcome.locator(".agent-chat-suggestion-sep")).toHaveCount(2);
    await page.screenshot({ path: "results/empty-welcome-first-composer.png" });
  });

  // 2026-10-18 用户指令「这两行的功能重复了」：输入卡上方的状态行与目录细条合并，
  // 细条是唯一幸存的那一行——同宽同轴与「无原生控件外观」都由它承担；目录名本身
  // 就是「更换目录」入口（点它打开选择框），不再有第二颗键，也不再有第二行。
  // 同日第三轮两条指认：「不要放在最右边」→ 待处理紧跟细条内容；「这个待你处理为什么跟
  // 左边没有在同一个高度上」「未选择目录的话用户不一定知道这是一个按钮」→ 同一行两条文字
  // 落在同一根水平轴上，缺目录那一档的文案写成动作并常驻一道虚线下划线。
  test("首条输入区上方的发送前提一行与输入卡同宽同轴，未选目录写成动作键并与「待你处理」同高", async ({ page }) => {
    await installRoutes(page);
    // 「待你处理」要有真实内容才能核对它与细条的同行关系。Playwright 后注册的 route 先匹配，
    // 且 glob 要带查询串（客户端请求的是 `/reviews?status=OPEN`）并写全 API Origin（catch-all 用的是
    // `apiBase` 那一档，相对 pattern 会解析到前端 4173 而不是 8787）。其余用例仍走空列表，整条不渲染。
    await page.route(`${apiBase}${prefix}/reviews**`, (route) => fulfillJson(route, { items: [openReview] }));
    await page.goto("/agent?new=browser");
    await connect(page);
    const strip = page.getByTestId("folder-scope-strip");
    await expect(strip).toBeVisible({ timeout: 20_000 });
    const bar = await strip.locator(".folder-strip-line").boundingBox();
    const row = await page.locator(".agent-chat-prereq-row").boundingBox();
    const composer = page.locator(".agent-chat-composer");
    const composerBox = await composer.boundingBox();
    expect(bar).not.toBeNull();
    expect(row).not.toBeNull();
    expect(composerBox).not.toBeNull();
    // 这一列的居中规则（--chat-measure + margin-inline:auto）由输入卡持有，细条必须跟着它：
    // 2026-10-18 用户实机截图里状态行按整列宽铺开，文字落到输入卡左侧很远处，读成没有样式。
    // 同日第二轮把「待你处理」并到这一行、紧跟细条之后（用户指令「不要放在最右边」）：
    // 细条改成按内容收，同宽同轴因此由整行容器承担——细条左缘仍对齐，行的左右缘对齐输入卡。
    expect(bar!.x).toBeCloseTo(composerBox!.x, 0);
    expect(row!.x).toBeCloseTo(composerBox!.x, 0);
    expect(row!.width).toBeCloseTo(composerBox!.width, 0);
    // 全局 `button` 只继承字体与颜色，不重置外框；这颗目录名键必须自己剥掉原生边框、底与内边距，
    const chrome = await strip.locator(".folder-strip-name").evaluate((el) => {
      const cs = getComputedStyle(el);
      return { borderStyle: cs.borderStyle, borderWidth: cs.borderTopWidth,
        background: cs.backgroundColor, padding: cs.paddingTop, textAlign: cs.textAlign };
    });
    expect(chrome).toEqual({ borderStyle: "none", borderWidth: "0px",
      background: "rgba(0, 0, 0, 0)", padding: "0px", textAlign: "start" });
    // 缺目录那一档不再读成状态提示：文案就是动作，静止再加一道虚线下划线说出「点它去补」。
    // 虚线走 text-decoration 而不是描边或铺底，正是为了上面那组「不落回原生控件外观」的读数不变。
    const name = strip.locator(".folder-strip-name");
    await expect(name).toHaveText("选择工作目录");
    const affordance = await name.evaluate((el) => {
      const cs = getComputedStyle(el);
      // 计算样式写着 dashed 不等于看得见：这颗键为了省略号带 `overflow: hidden`，行盒只有 20px，
      // 下划线偏移一大就整条掉到盒子外被裁掉（2026-10-18 用户实机指认「常驻下划线没生效」，
      // 当时量到基线在 17px、`0.2em` 偏移＋1px 线宽要画到 20.2px）。这里按字体度量算出下划线
      // 真正落下的位置，要求它没有被盒子裁掉——只锁计算样式会重犯同一个错。
      const ctx = document.createElement("canvas").getContext("2d")!;
      ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const metrics = ctx.measureText(el.textContent!.trim());
      const lineHeight = Number.parseFloat(cs.lineHeight);
      const baseline = (lineHeight - (metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent)) / 2
        + metrics.fontBoundingBoxAscent;
      const thickness = Number.parseFloat(cs.textDecorationThickness);
      const underlineBottom = baseline + Number.parseFloat(cs.textUnderlineOffset)
        + (Number.isFinite(thickness) ? thickness : 1);
      return { line: cs.textDecorationLine, style: cs.textDecorationStyle,
        clipped: cs.overflow === "hidden" && underlineBottom > el.getBoundingClientRect().height };
    });
    expect(affordance).toEqual({ line: "underline", style: "dashed", clipped: false });
    // 同一行、同一根水平轴：原先那 4px 上内边距留在细条自己的盒子里，`align-items: center`
    // 居中的是盒子不是文字，细条文字因此比「待你处理」低 2px（用户实机指认）。现在呼吸挪到行上。
    const pending = page.getByTestId("pending-work");
    await expect(pending).toBeVisible({ timeout: 20_000 });
    const nameLabel = await name.boundingBox();
    const pendingLabel = await pending.locator(".pending-work-label").boundingBox();
    expect(nameLabel).not.toBeNull();
    expect(pendingLabel).not.toBeNull();
    const center = (box: { y: number; height: number }): number => box.y + box.height / 2;
    expect(Math.abs(center(nameLabel!) - center(pendingLabel!))).toBeLessThan(1);
    // 左右分居两端（2026-10-20 第五轮「左侧工作目录信息 / 右侧待处理事项」）：细条按内容收在
    // 左端，「待你处理」用 auto 外边距推到剩余空间的右端，两类语义各占一端、中间留一档间隔。
    // 上一版「紧跟细条内容右端」在目录名后连缀归属、Git 标记与执行约束之后，会把待处理挤到
    // 细条中间或折行，读成目录信息的一部分（用户截图指认「信息拥挤、语义混杂」）。
    const pendingBox = await pending.boundingBox();
    expect(pendingBox).not.toBeNull();
    expect(pendingBox!.x).toBeGreaterThanOrEqual(bar!.x + bar!.width);
    expect(pendingBox!.x + pendingBox!.width).toBeCloseTo(row!.x + row!.width, 1);
    expect(pendingBox!.x - (bar!.x + bar!.width)).toBeGreaterThan(8);
    // 合并后输入卡上方只剩这一行：不再渲染第二行状态摘要。
    await expect(page.getByTestId("composer-status")).toHaveCount(0);
    await page.locator(".agent-chat-prereq-row").screenshot({ path: "results/prereq-row-aligned.png" });
  });

  test("任务作用域空会话：同一欢迎块，说明句按归属收敛", async ({ page }) => {
    await installRoutes(page);
    await page.goto(`/agent?work=${taskId}`);
    await connect(page);
    await expect(page.getByTestId("collab-conversation-toolbar")).toBeVisible();
    await expect(page.getByTestId("folder-scope-strip")).toBeVisible();
    await expect(page.getByTestId("folder-scope-change")).toHaveText("Research");
    await expect(page.getByTestId("collab-goal")).toBeHidden();
    await expect(page.getByTestId("collab-inspector")).toHaveCount(0);
    await page.getByTestId("collab-conversation-inspector-toggle").click();
    await expect(page.getByTestId("collab-inspector")).toBeVisible();
    await expect(page.getByRole("tablist", { name: "工作详情分类" }).getByRole("tab")).toHaveText(["进展", "成果", "记录"]);
    await page.getByTestId("collab-inspector-close").click();
    const welcome = page.getByTestId("assist-empty-welcome");
    await expect(welcome).toBeVisible({ timeout: 20_000 });
    await expect(welcome.locator("h1")).toHaveText("有什么想一起完成的？");
    await expect(welcome.locator(".agent-chat-suggestion")).toHaveCount(11);
    await expect(welcome.locator(".agent-chat-empty-lede"))
      .toHaveText("围绕当前任务直接讨论，或描述新的要求。");
    await expect(page.getByTestId("assist-transcript")).not.toContainText("还没有消息");
    await expectCenteredInTranscript(page, welcome);
    // 快捷卡把完整提示词预填进面板输入框，两个入口只差一个已存在的会话身份。
    await page.getByTestId("assist-empty-suggest-requirement").click();
    await expect(page.getByTestId("assist-draft")).toHaveValue(/没有具体需求时先问我，不自行挑选。/u);
    await page.screenshot({ path: "results/empty-welcome-task-session.png" });
  });

  for (const entry of [`/tasks/${taskId}?skill=assist&session=${sessionId}`, `/agent?session=${sessionId}`]) {
    test(`任务会话旧入口归一且恢复目录：${entry}`, async ({ page }) => {
      await installRoutes(page); await page.goto(entry); await connect(page);
      await expect(page).toHaveURL(new RegExp(`/agent\\?.*work=${taskId}`));
      await expect(page.getByTestId("collab-conversation-toolbar")).toBeVisible();
      await expect(page.getByTestId("folder-scope-change")).toHaveText("Research");
      await expect(page.getByTestId("assist-empty-welcome")).toBeVisible();
    });
  }

  test("发送只读消息只提交一次，完成后读取同一消息结果，不发起解释或执行", async ({ page }) => {
    await installRoutes(page);
    let sent = false;
    let completed = false;
    const posts: string[] = [];
    await page.route(`${apiBase}${prefix}/assist-sessions/${sessionId}/messages*`, async (route) => {
      if (route.request().method() === "POST") {
        posts.push(new URL(route.request().url()).pathname);
        const body = route.request().postDataJSON() as { command_id: string };
        sent = true;
        return fulfillJson(route, { command_id: body.command_id, committed_at: "2026-10-16T00:00:00Z",
          result: { session_id: sessionId, user_message_id: "msg-user", assistant_message_id: "msg-assistant" }, links: {} }, 202);
      }
      const base = { session_id: sessionId, intent: "DISCUSS", sources: [], error_code: null,
        usage: { input_tokens: null, output_tokens: null }, cancel_requested: false };
      return fulfillJson(route, { items: sent ? [
        { ...base, id: "msg-user", seq: "1", role: "USER", status: "COMPLETED", content: "读取目录" },
        { ...base, id: "msg-assistant", seq: "2", role: "ASSISTANT", status: completed ? "COMPLETED" : "PENDING",
          content: completed ? "实际读取结果：README.md" : null }
      ] : [] });
    });
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().startsWith(apiBase) && !request.url().endsWith("/messages")) {
        posts.push(new URL(request.url()).pathname);
      }
    });
    await page.goto(`/agent?work=${taskId}`); await connect(page);
    await page.getByTestId("assist-draft").fill("读取目录");
    await page.getByTestId("assist-send").click();
    // 「等待生成」字样已删除（2026-10-21 用户指令）：已提交、Worker 尚未领取由正文前的三点表达。
    await expect(page.getByTestId("assist-transcript")).not.toContainText("等待生成");
    await expect(page.getByTestId("assist-inflight-msg-assistant")).toBeVisible();
    completed = true;
    await expect(page.getByTestId("assist-transcript")).toContainText("实际读取结果：README.md");
    expect(posts).toEqual([`${prefix}/assist-sessions/${sessionId}/messages`]);
    await expect(page.getByTestId("execution-summary")).toHaveCount(0);
  });

  test("项目 Assist 旧入口进入相同聊天外壳", async ({ page }) => {
    await installRoutes(page); await page.goto(`/projects/${projectId}?skill=assist`); await connect(page);
    await expect(page).toHaveURL(new RegExp(`/agent\\?.*project=${projectId}`));
    await expect(page.getByTestId("collab-conversation-toolbar")).toBeVisible();
    await expect(page.getByTestId("folder-scope-strip")).toBeVisible();
    await page.getByTestId("collab-conversation-inspector-toggle").click();
    await expect(page.getByTestId("collab-conversation-inspector")).toHaveClass("task-inspector");
    // 会话工作详情比任务多一页「变更」（2026-10-20）：那里统计整段目录净变化。
    await expect(page.getByRole("tablist", { name: "工作详情分类" }).getByRole("tab"))
      .toHaveText(["进展", "成果", "变更", "记录"]);
    await page.getByTestId("collab-conversation-inspector-tab-CHANGES").click();
    await expect(page.getByTestId("collab-conversation-inspector")).toContainText("本次对话期间该目录的变化");
  });
});
