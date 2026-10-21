import { expect, test, type Locator, type Page, type Route } from "@playwright/test";

// 2026-10-18 会话局部与总 diff 的真实布局与状态可辨（工作台 §34.2 / §34.4 / §34.5，
// 设计系统 §9.15，测试计划 §34 的 CD-01、CD-11、CD-12、CD-13、CD-17、CD-18、CD-19）。
// 这里只核对「真实 Chromium 里看得见的东西」：
//   * 局部行紧邻那次编辑的摘要：生成中只有「预览」，落账后才换成实际数，说法跟着账本动作走
//     （新增/修改/删除各有各的动词）；同一文件被改两次留下两行，后来者不重写旧行；
//     生成中的预览不进会话总数。
//   * 总数在输入卡**外**上方居中：一行文字按钮就是展开入口，路径变长、数字进位都不撑高输入卡，
//     也不遮发送/停止键与附件、草稿助手入口；窄视口与宽视口都成立。
//   * 键盘能开、能 Esc 收起并回到入口；各状态文案彼此可辨，未知与失权绝不画成 +0 −0。
// API 全部由 page.route 伪造：不连数据库、不调 Provider；除 CD-05「从现在开始统计」那一次
// 显式 POST 之外不产生任何写请求（每条用例都断言这一点）。
// 派生算术与竞态守卫在 tests/localFileDiffRows.spec.ts、tests/chatLocalFileDiff.spec.tsx、
// tests/conversationDiffSummary.spec.tsx；这里不重复算术，只看真实渲染结果。

const apiBase = "http://127.0.0.1:8787";
const origin = "http://127.0.0.1:4173";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const sessionId = "66666666-6666-4666-8666-666666666666";
const resourceId = "88888888-8888-4888-8888-888888888888";
const runId = "99999999-9999-4999-8999-999999999999";
const operationOne = "a1111111-1111-4111-8111-111111111111";
const operationTwo = "a2222222-2222-4222-8222-222222222222";
const modelCallOne = "b1111111-1111-4111-8111-111111111111";
const modelCallTwo = "b2222222-2222-4222-8222-222222222222";
const userMessageId = "c1111111-1111-4111-8111-111111111111";
const runningMessageId = "c2222222-2222-4222-8222-222222222222";
const prefix = `/api/v1/workspaces/${workspaceId}`;

const adapterPath = "src/a/computer-adapter.ts";
const notesPath = "docs/notes/long_term_review_notes.md";
const binaryPath = "assets/sample.bin";
const longPath = "src/very/long/nested/path/for/layout/check/conversationLiveDiffRenderer.ts";
const rootPath = "D:\\Work\\Relay\\Projects\\conversation-live-diff-verification\\repo";
const baselineAt = "2026-10-16T09:00:00Z";

/** 总数只反映已落盘内容：可核对的两份文件 +98 −6，第三份二进制不可统计。
 * 覆盖投影按本仓真实情形给：起点扫描撞到文件数上限（2000），当前侧扫全了。 */
const changedDiff = {
  available: true,
  scope: "SESSION",
  baseline_captured_at: baselineAt,
  baseline_revision: "3",
  root_path: rootPath,
  resource_id: resourceId,
  incomplete: true,
  coverage: {
    baseline: { complete: false, reason: "FILE_COUNT_LIMIT", files: 2000, listed: null },
    current: { complete: true, reason: null, files: 3, listed: 3 },
    unchecked_files: 0,
    unverified_files: 0,
    unverifiable_files: 0,
    unscanned_files: 0,
  },
  total_files: 3,
  total_added: 98,
  total_removed: 6,
  files: [
    { path: adapterPath, action: "MODIFY", added: 78, removed: 5, unavailable_reason: null },
    { path: notesPath, action: "CREATE", added: 20, removed: 0, unavailable_reason: null },
    { path: binaryPath, action: "MODIFY", added: -1, removed: -1, unavailable_reason: "BINARY" },
  ],
};

/** 第二次编辑落账后的总数：多出的 1450/820 全部来自已结算账本，与预览无关。 */
const settledDiff = {
  ...changedDiff,
  total_files: 4,
  total_added: 1548,
  total_removed: 826,
  files: [...changedDiff.files,
    { path: longPath, action: "CREATE", added: 1450, removed: 820, unavailable_reason: null }],
};

type DiffMode = "changed" | "noBaseline" | "notGit" | "empty" | "permission" | "refreshFail";

interface State {
  settled: boolean;
  diffMode: DiffMode;
  unbound: boolean;
  stopTail: boolean;
  established: boolean;
  diffReads: number;
  diffFileReads: number;
  writes: string[];
}

let state: State;

function resetState(over: Partial<State> = {}): void {
  state = { settled: false, diffMode: "changed", unbound: false, stopTail: false, established: false,
    diffReads: 0, diffFileReads: 0, writes: [], ...over };
}

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(),
    body: JSON.stringify(body) });
}

function sessionRow(): unknown {
  return { id: sessionId, workspace_id: workspaceId, project_id: projectId, task_id: taskId,
    title: "会话 diff 布局验证", status: "ACTIVE", revision: "1", conversation_mode: "AGENT",
    assistant_profile_id: null, remember: true,
    // 未绑定工作目录的那条用例必须整块不给数字，也不发统计请求（§34.3 纯聊天不做全盘扫描）。
    working_resource_id: state.unbound ? null : resourceId,
    context: state.unbound ? { project_goals: [], working_directory: null }
      : { project_goals: [], working_directory: { resource_id: resourceId, canonical_root: rootPath } },
    created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z" };
}

function messageRow(id: string, seq: string, role: "USER" | "ASSISTANT", content: string | null,
  status = "COMPLETED"): unknown {
  return { id, session_id: sessionId, seq, role, status, intent: "DISCUSS", content,
    error_code: null, provider_error_kind: null, sources: [], skill: null, cancel_requested: false,
    created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z",
    usage: { input_tokens: 120, output_tokens: 64, cache_read_tokens: null,
      cache_creation_tokens: null } };
}

function messagesBody(): unknown {
  const items = [
    messageRow(userMessageId, "1", "USER", "把 computer-adapter 补上重试，并写清边界。"),
    messageRow("d1111111-1111-4111-8111-111111111111", "2", "ASSISTANT",
      `已按目标准备执行：先读取原文件，再落${adapterPath}。${"补充说明。".repeat(30)}`),
  ];
  if (state.stopTail === true) {
    items.push(messageRow("d2222222-2222-4222-8222-222222222222", "3", "USER", "再补一轮：把长路径那个渲染器也改上。"));
    items.push(messageRow(runningMessageId, "4", "ASSISTANT", null, "RUNNING"));
  }
  return { items };
}

/** 已结算的写入调用：逐文件账本是「已修改」的唯一来源。 */
function changesetCall(id: string, round: number, ordinal: number, path: string,
  action: "CREATE" | "MODIFY", added: number, removed: number, operationId: string): unknown {
  return { id, round, ordinal, tool_name: "apply_changeset", status: "SETTLED",
    arguments: { changes: [{ path, action }] }, arguments_sha256: "e".repeat(64),
    provider_tool_call_id: `p-${id}`, operation_id: operationId, adaptation_of: null,
    adapted_path: null, result_ref: { outcome: "COMPLETED" },
    created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:05Z",
    file_changes: [{ path, action, status: "APPLIED", added, removed, unavailable_reason: null }] };
}

function toolCallsBody(): unknown {
  const roundTwo = state.settled
    ? { round: 1, model_call_id: modelCallTwo, calls: [changesetCall(
        "f2222222-2222-4222-8222-222222222222", 1, 0, longPath, "CREATE", 1450, 820, operationTwo)] }
    : { round: 1, model_call_id: modelCallTwo, calls: [] };
  return { run_id: runId, run_status: state.settled ? "COMPLETED" : "RUNNING", wait_reason: null,
    rounds: [{ round: 0, model_call_id: modelCallOne, calls: [changesetCall(
      "f1111111-1111-4111-8111-111111111111", 0, 0, adapterPath, "MODIFY", 78, 5, operationOne)] },
    roundTwo] };
}

/** 生成中的预览只在「还没有调用行」时存在——与服务端口径一致（Run 终态与已结算身份都返回空）。 */
function previewsBody(): unknown {
  if (state.settled) return { run_id: runId, previews: [] };
  return { run_id: runId, previews: [{ model_call_id: modelCallTwo, ordinal: 0,
    tool_name: "apply_changeset", revision: "4", truncated: false,
    updated_at: "2026-10-16T00:00:06Z", files: [{ path: longPath, action: "CREATE",
      added: 66, removed: 2, target_complete: true }] }] };
}

function diffBody(): unknown {
  state.diffReads += 1;
  if (state.diffMode === "noBaseline" && !state.established) return { available: false, reason: "NO_BASELINE" };
  if (state.diffMode === "notGit") return { available: false, reason: "ROOT_NOT_GIT" };
  if (state.diffMode === "permission") return { available: false, reason: "RESOURCE_UNAVAILABLE" };
  if (state.diffMode === "empty") {
    return { ...changedDiff, incomplete: false, total_files: 0, total_added: 0, total_removed: 0, files: [] };
  }
  // 刷新失败：第一次可信读取成功后，后续读取全部失败——界面必须保留上次可信值并标「截至…」。
  if (state.diffMode === "refreshFail" && state.diffReads > 1) return null;
  return state.settled ? settledDiff : changedDiff;
}

async function installRoutes(page: Page): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (method !== "GET") state.writes.push(path);
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/tasks/${taskId}`) return fulfillJson(route, { id: taskId,
      project_id: projectId, title: "会话局部与总 diff", status: "IN_PROGRESS", mode: "ME",
      revision: "2", created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z",
      executor: { kind: "HUMAN", run_id: null, ownership_epoch: "1" }, current_completion_id: null,
      waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
      acceptance: { acceptance_revision: "2", objective: "只读验证布局。", source: "CREATE",
        created_at: "2026-10-16T00:00:00Z", criteria: [] }, dependencies: [] });
    if (path === `${prefix}/projects/${projectId}`) return fulfillJson(route, { id: projectId,
      title: "人机协作工作流研究", project_type: "GENERAL", revision: "1", state_revision: "1",
      archived_at: null });
    if (path === `${prefix}/model-port`) return fulfillJson(route, { provider: "fake",
      configured: false, model: null, base_url: null, max_call_tokens: null });
    if (path === `${prefix}/assist-sessions`) return fulfillJson(route, { items: [sessionRow()] });
    const detail = path.match(/^\/api\/v1\/workspaces\/[0-9a-f-]+\/assist-sessions\/([0-9a-f-]+)$/u);
    if (detail) return fulfillJson(route, sessionRow());
    const messages = path.match(/^\/api\/v1\/workspaces\/[0-9a-f-]+\/assist-sessions\/[0-9a-f-]+\/messages$/u);
    if (messages) return fulfillJson(route, messagesBody());
    const livePreview = path.match(/\/assist-sessions\/[0-9a-f-]+\/messages\/([0-9a-f-]+)\/live-preview(\/events)?$/u);
    if (livePreview) return fulfillJson(route, { session_id: sessionId, message_id: livePreview[1],
      status: "RUNNING", preview_revision: "1", preview_text: null, preview_truncated: false,
      preview_available: false });
    const executionRequests = path.match(/\/assist-sessions\/[0-9a-f-]+\/execution-requests$/u);
    if (executionRequests) return fulfillJson(route, { items: [] });
    if (path.startsWith(`${prefix}/conversation-execution-requests`)) {
      return fulfillJson(route, { items: [{ request_id: "e1111111-1111-4111-8111-111111111111",
        session_id: sessionId, source_message_id: userMessageId, decision: "PREPARE",
        status: "APPLIED", candidate_status: "COMPLETED", root_path: rootPath,
        resource_id: resourceId, questions: [], auto_start: false, revision: "2", task_id: taskId,
        run_id: runId, title: "补齐重试与边界", objective: "改 computer-adapter" }] });
    }
    const toolCalls = path.match(/\/runs\/[0-9a-f-]+\/tool-calls$/u);
    if (toolCalls) return fulfillJson(route, toolCallsBody());
    const previews = path.match(/\/runs\/[0-9a-f-]+\/tool-call-previews$/u);
    if (previews) return fulfillJson(route, previewsBody());
    // 单次事件的 SSE：每次重连给一个新序号，驱动投影重读——与真实事件提示只触发一次读取一致。
    const events = path.match(/\/runs\/[0-9a-f-]+\/events$/u);
    if (events) {
      const seq = BigInt(new URL(request.url()).searchParams.get("after") ?? "0") + 1n;
      return route.fulfill({ status: 200, contentType: "text/event-stream", headers: cors(),
        body: `id: ${seq}\ndata: {"run_id":"${runId}","seq":"${seq}"}\n\n` });
    }
    const frozen = path.match(/\/operations\/([0-9a-f-]+)\/file-write-diff$/u);
    if (frozen) {
      const operationId = frozen[1]!;
      return fulfillJson(route, { operation_id: operationId, basis: "FROZEN_INTENT", files: [
        { relative_path: operationId === operationTwo ? longPath : adapterPath, action: "MODIFY",
          baseline_sha256: "b".repeat(64), target_sha256: "c".repeat(64), availability: "AVAILABLE",
          unavailable_reason: null, before_text: "旧的一行\n", afterText: null,
          after_text: "旧的一行\n新增的一行\n" }] });
    }
    const changeSets = path.match(/\/operations\/([0-9a-f-]+)\/change-sets$/u);
    if (changeSets) return fulfillJson(route, { operation_id: changeSets[1]!, change_sets: [] });
    if (path === `${prefix}/assist-sessions/${sessionId}/conversation-diff`) {
      const body = diffBody();
      if (body === null) return fulfillJson(route, { code: "INTERNAL", detail: "统计读取失败" }, 500);
      return fulfillJson(route, body);
    }
    if (path === `${prefix}/assist-sessions/${sessionId}/conversation-diff/file`) {
      state.diffFileReads += 1;
      const target = new URL(request.url()).searchParams.get("path") ?? "";
      if (target === binaryPath) return fulfillJson(route, { available: false, reason: "PATH_NOT_FOUND" });
      return fulfillJson(route, { available: true, path: target, action: "MODIFY", added: 78,
        removed: 5, unavailable_reason: null, rows_truncated: false, rows_unavailable_reason: null,
        rows: [{ kind: "CONTEXT", old_line: 1, new_line: 1, text: "旧的一行" },
          { kind: "REMOVE", old_line: 2, new_line: null, text: "删除的一行" },
          { kind: "ADD", old_line: null, new_line: 2, text: "新增的一行" }] });
    }
    if (path === `${prefix}/assist-sessions/${sessionId}/conversation-diff/baseline`) {
      state.established = true; // 建立起点之后同一次读取就给出真实统计（服务端只从现在开始算）。
      return fulfillJson(route, { established: true, reason: "CREATED" });
    }
    if (path === `${prefix}/assist-proposals` || path === `${prefix}/skill-definitions`
      || path === `${prefix}/chat-commands`) return fulfillJson(route, { items: [] });
    if (path.startsWith(`${prefix}/learning`)) return fulfillJson(route, { items: [], epoch: "0" });
    return fulfillJson(route, { items: [], next_cursor: null });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("conversation-diff-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" })
    .waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

async function openChat(page: Page, over: Partial<State> = {},
  viewport: { width: number; height: number } | null = null): Promise<void> {
  resetState(over);
  await installRoutes(page);
  await page.goto(`/agent?work=${taskId}`);
  if (viewport !== null) await page.setViewportSize(viewport);
  await connect(page);
  await expect(page.getByTestId("assist-composer")).toBeVisible({ timeout: 20_000 });
  // 未绑定目录时这一行整块不出现（2026-10-17 用户指令「不要有这个提示」）：入口等它等于永远等不到，
  // 因此按状态分岔。输入卡已经出现＝会话渲染完，此时断「没有这一行」才是有内容的断言。
  if (state.unbound) await expect(page.getByTestId("conversation-diff-toggle")).toHaveCount(0);
  else await expect(page.getByTestId("conversation-diff-toggle")).toBeVisible({ timeout: 20_000 });
}

function diffEntry(page: Page): Locator { return page.getByTestId("conversation-diff-toggle"); }
function diffFlag(page: Page): Locator { return page.getByTestId("conversation-diff-flag"); }
function folderStrip(page: Page): Locator { return page.locator(".folder-strip"); }
function diffPanel(page: Page): Locator { return page.getByTestId("conversation-diff-panel"); }
function composer(page: Page): Locator { return page.getByTestId("assist-composer"); }
function rows(page: Page): Locator {
  return page.locator('[data-testid="execution-summary"] .local-file-diff');
}

interface Box { x: number; y: number; width: number; height: number }

async function box(locator: Locator): Promise<Box> {
  const value = await locator.boundingBox();
  expect(value, "元素没有真实盒：布局断言无法成立").not.toBeNull();
  return value!;
}

function intersects(left: Box, right: Box): boolean {
  return left.x < right.x + right.width && right.x < left.x + left.width
    && left.y < right.y + right.height && right.y < left.y + left.height;
}

/** 这一行的列间距：居中断言要按实际间距算剩余空间，不把 16px 写死在用例里。 */
async function rowColumnGap(page: Page): Promise<number> {
  const value = await page.locator(".agent-chat-prereq-row")
    .evaluate((element) => getComputedStyle(element).columnGap);
  return Number.parseFloat(value) || 0;
}

/** 取同一 CSS 变量的探针色与元素实测 computed color：颜色断言不靠类名自证。 */
async function colorVsToken(page: Page, selector: string,
  variable: string): Promise<{ actual: string; expected: string }> {
  return page.evaluate(([target, name]) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const expected = getComputedStyle(probe).color;
    probe.remove();
    const element = document.querySelector(target);
    return { actual: element === null ? "MISSING" : getComputedStyle(element).color, expected };
  }, [selector, variable] as [string, string]);
}

test.describe("会话局部与总 diff 的真实布局", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("局部行紧邻编辑记录：生成中只给预览，落账后换成实际数且保留多条历史", async ({ page }) => {
    test.setTimeout(60_000);
    await openChat(page);
    // 两次编辑＝两行：第一行已落账（已修改 +78 −5），第二行还在生成（预览 +66 −2）。
    await expect(rows(page)).toHaveCount(2, { timeout: 20_000 });
    const first = await box(rows(page).first());
    const second = await box(rows(page).nth(1));
    expect(second.y).toBeGreaterThan(first.y); // 后来的编辑排在后面，不重写旧行
    await expect(rows(page).first()).toContainText("已修改");
    await expect(rows(page).first()).toContainText("+78");
    await expect(rows(page).first()).toContainText("−5");
    await expect(rows(page).nth(1)).toContainText("正在生成");
    await expect(rows(page).nth(1)).toContainText("预览");
    await expect(rows(page).nth(1)).toContainText("+66");
    await expect(rows(page).nth(1)).not.toContainText("已修改");
    // 长路径只显示文件名、完整路径留在 title：数字与状态文字不会被路径挤掉。
    await expect(page.locator(".local-file-diff-path").nth(1))
      .toHaveAttribute("title", longPath);
    expect((await page.locator(".local-file-diff-path").nth(1).innerText()).trim())
      .toBe("conversationLiveDiffRenderer.ts");
    // 生成中的预览不进总数：此刻总数仍是落盘的 +98 −6。
    // 数字已拆成独立着色节点，节点之间没有空白文本，因此按 \s* 匹配整句。
    await expect(page.getByTestId("conversation-diff-toggle"))
      .toContainText(/本次对话 · 3 个文件\s*\+98\s*−6/);

    // 第二行落账：预览清空、账本给出实际数，界面上的「正在生成」整行换成实际动作的说法。
    // 这一次账本动作是 CREATE，所以写「已新增」而不是「已修改」——文案跟着动作走（§34.4 / CD-12）。
    state.settled = true;
    await expect.poll(async () => (await rows(page).nth(1).innerText()).includes("已新增"),
      { timeout: 20_000, message: "落账后局部行没有换成实际数" }).toBe(true);
    await expect(rows(page)).toHaveCount(2);
    await expect(rows(page).nth(1)).toContainText("+1450");
    await expect(rows(page).nth(1)).toContainText("−820");
    await expect(rows(page).nth(1)).not.toContainText("预览");
    await expect(rows(page).first()).toContainText("+78"); // 旧记录不被重写
    await expect(page.getByTestId("conversation-diff-toggle"))
      .toContainText(/本次对话 · 4 个文件\s*\+1548\s*−826/);

    // CD-18：局部展开正文沿用既有只读入口（按原 operation_id 读冻结前后文本）。
    await rows(page).first().getByRole("button", { name: "查看这次编辑前后" }).click();
    const body = page.getByTestId("file-write-frozen-diff");
    await expect(body).toBeVisible();
    await expect(body).toContainText("旧的一行");
    await expect(body).toContainText("新增的一行");
    // 数字与主按钮互不遮挡：卡片高度不因局部行变多或数字进位而改变。
    const composerBox = await box(composer(page));
    expect(composerBox.height).toBeGreaterThan(40);
    expect(state.writes).toEqual([]);
    await page.screenshot({ path: "results/conversation-diff-local-rows.png" });
  });

  test("目录信息与总数入口同一行：目录左对齐、入口在剩余空间居中，展开不撑高输入卡", async ({ page }) => {
    await openChat(page);
    const card = await box(composer(page));
    const column = await box(page.locator(".agent-chat-composer").first());
    const strip = await box(folderStrip(page));
    const entry = await box(diffEntry(page));
    const send = await box(page.getByTestId("assist-send"));
    // 位置：输入卡**外**（不是卡的后代），且在卡上方。
    await expect(composer(page).locator(".conversation-diff")).toHaveCount(0);
    expect(entry.y + entry.height).toBeLessThanOrEqual(card.y + 1);
    // 同行（2026-10-18 用户指令「diff 摘要把左侧目录信息顶到上一行」）：入口与目录细条的垂直区间
    // 重叠、水平盒互不相交——目录没被顶到上一行，入口也没压在上面。
    expect(entry.y < strip.y + strip.height && strip.y < entry.y + entry.height).toBe(true);
    expect(intersects(entry, strip)).toBe(false);
    // 目录保持左对齐在这一列的左边缘；目录名仍可读（没被入口挤成省略号碎片）。
    expect(Math.abs(strip.x - column.x)).toBeLessThanOrEqual(1);
    const name = await box(page.locator(".folder-strip-name"));
    expect(name.width).toBeGreaterThan(40);
    // 居中：入口中线落在「细条右缘 + 列间距 … 列右缘」这一段的中点——auto 边距自然给出的位置，
    // 不是把宽度写死的坐标硬压。
    const expectedCenter = (strip.x + strip.width + await rowColumnGap(page) + column.x + column.width) / 2;
    expect(Math.abs(entry.x + entry.width / 2 - expectedCenter)).toBeLessThan(4);
    // 着色走 computed style 实测：新增用 diff 绿、删除用 diff 红，且符号与可访问名都在。
    const addedColor = await colorVsToken(page,
      '[data-testid="conversation-diff-toggle"] [data-metric="added"]', "--relay-color-diff-add-marker");
    const removedColor = await colorVsToken(page,
      '[data-testid="conversation-diff-toggle"] [data-metric="removed"]', "--relay-color-diff-remove-marker");
    expect(addedColor.actual).toBe(addedColor.expected);
    expect(removedColor.actual).toBe(removedColor.expected);
    expect(addedColor.actual).not.toBe(removedColor.actual);
    await expect(diffEntry(page)).toContainText("新增 98 行，删除 6 行");
    // 发送键仍在卡内、可见可用，位置未被总数行挤走。
    await expect(page.getByTestId("assist-send")).toBeVisible();
    expect(send.x! >= card.x && send.x + send.width <= card.x + card.width).toBe(true);

    await page.getByTestId("conversation-diff-toggle").click();
    const panel = await box(diffPanel(page));
    await expect(diffPanel(page)).toBeVisible();
    await expect(page.getByTestId("conversation-diff-panel-title")).toHaveText("本次对话的文件变化");
    // 基线时刻、目录、免责句与逐文件行数都在展开态里。
    await expect(diffPanel(page).locator("time")).toHaveAttribute("datetime", baselineAt);
    await expect(diffPanel(page)).toContainText(rootPath);
    await expect(diffPanel(page))
      .toContainText("只统计本会话写入的文件；同一目录里其他程序或其他会话的同期修改不计入。");
    await expect(page.getByTestId(`conversation-diff-file-${adapterPath}`)).toContainText("+78");
    await expect(page.getByTestId(`conversation-diff-file-${notesPath}`)).toContainText("+20");
    // 不可统计的那一份说原因，不画 +0 −0。
    const binary = page.getByTestId(`conversation-diff-file-${binaryPath}`);
    await expect(binary).toContainText("二进制内容，不统计行数");
    expect(await binary.innerText()).not.toMatch(/[+−]\s*0(\s|$)/u);
    // 「部分不可统计」当场说清是哪一类不完整：入口行上是可见的成因短语，不是隐藏提示。
    // 会话口径的统计范围只有本会话写过的路径，所以「整个目录没扫全」不出现在这里。
    await expect(diffFlag(page)).toBeVisible();
    await expect(diffFlag(page)).toContainText("统计不完整：1 个文件行数不可统计");
    await expect(diffFlag(page)).not.toContainText("目录只扫描了部分文件");
    expect(await diffFlag(page).getAttribute("title")).toBeNull();
    // 展开面板逐条给出范围与条数；起点侧没有清单，不能编造「共多少个」。
    const incomplete = page.getByTestId("conversation-diff-incomplete");
    await expect(incomplete).toBeVisible();
    await expect(incomplete)
      .toContainText("1 个已发现文件的行数不可统计（二进制、超限或读不到）");
    await expect(incomplete).not.toContainText("会话起点扫描不完整");
    expect(await incomplete.innerText()).not.toContain("2000/");
    expect((await box(diffEntry(page))).height).toBeCloseTo(entry.height, 0); // 展开不改变入口那一行的高度

    // CD-18：完整正文走同一份修订的只读端点。
    await page.getByTestId(`conversation-diff-file-toggle-${adapterPath}`).click();
    const table = page.getByTestId(`conversation-diff-file-${adapterPath}`)
      .locator('[role="table"]');
    await expect(table).toBeVisible();
    await expect(table).toContainText("新增的一行");
    expect(state.diffFileReads).toBe(1);

    // 展开后：面板在卡上方、不压发送键/附件入口，卡片自身高度一分不变。
    const afterCard = await box(composer(page));
    expect(afterCard.height).toBeCloseTo(card.height, 0);
    const afterSend = await box(page.getByTestId("assist-send"));
    expect(intersects(panel, afterSend)).toBe(false);
    expect(intersects(panel, await box(page.getByTestId("assist-attach")))).toBe(false);
    const expandedColumn = await box(page.locator(".agent-chat-composer").first());
    expect(panel.x).toBeGreaterThanOrEqual(expandedColumn.x - 1);
    expect(panel.x + panel.width).toBeLessThanOrEqual(expandedColumn.x + expandedColumn.width + 1);
    await page.screenshot({ path: "results/conversation-diff-total-expanded.png" });
    expect(state.writes).toEqual([]);
  });

  test("窄视口 + 数字进位：长路径与多位数不遮发送/停止，卡片高度不变", async ({ page }) => {
    await openChat(page, { settled: true, stopTail: true }, { width: 900, height: 700 });
    const card = await box(composer(page));
    const stop = await box(page.getByTestId("assist-stop"));
    await expect(page.getByTestId("conversation-diff-toggle"))
      .toContainText(/本次对话 · 4 个文件\s*\+1548\s*−826/);
    await page.getByTestId("conversation-diff-toggle").click();
    await page.getByTestId(`conversation-diff-file-toggle-${longPath}`).click();
    const panel = await box(diffPanel(page));
    // 面板仍在输入卡上方、仍在视口内横向不溢出，且不压住停止键。
    expect(panel.y + panel.height).toBeLessThanOrEqual((await box(composer(page))).y + 1);
    expect(intersects(panel, await box(page.getByTestId("assist-stop")))).toBe(false);
    expect(intersects(panel, stop)).toBe(false);
    expect(panel.x).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(900 + 1);
    expect((await box(composer(page))).height).toBeCloseTo(card.height, 0);
    // 长路径在窄视口下靠截断让位，不会把数字挤出容器。
    const longRow = page.getByTestId(`conversation-diff-file-${longPath}`);
    await expect(longRow).toBeVisible();
    expect((await box(longRow)).x + (await box(longRow)).width)
      .toBeLessThanOrEqual(panel.x + panel.width + 1);
    await page.screenshot({ path: "results/conversation-diff-narrow-viewport.png" });
  });

  test("键盘能开能收并回到入口，Tab 不被困在总数块里", async ({ page }) => {
    await openChat(page);
    const toggle = page.getByTestId("conversation-diff-toggle");
    expect(await toggle.evaluate((element) => element.tagName)).toBe("BUTTON");
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(diffPanel(page)).toBeVisible();
    // 正文与入口同一 aria-controls：键盘收起后焦点回到入口本身。
    expect(await toggle.getAttribute("aria-controls"))
      .toBe(await diffPanel(page).evaluate((element) => element.id));
    await page.keyboard.press("Escape");
    await expect(diffPanel(page)).toHaveCount(0);
    expect(await page.evaluate(() =>
      document.activeElement instanceof HTMLElement ? document.activeElement.dataset.testid ?? "" : ""))
      .toBe("conversation-diff-toggle");
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() =>
      document.activeElement instanceof HTMLElement
        && document.activeElement.closest(".conversation-diff") === null)).toBe(true);
  });

  test("CD-05：缺起点时能主动「从现在开始统计」，并显示新的起算时刻", async ({ page }) => {
    await openChat(page, { diffMode: "noBaseline" });
    await expect(page.getByTestId("conversation-diff-toggle"))
      .toContainText("本次对话 · 缺少会话起点");
    expect(await page.getByTestId("conversation-diff-toggle").innerText()).not.toContain("+0");
    await page.getByTestId("conversation-diff-toggle").click();
    await page.getByTestId("conversation-diff-establish").click();
    await expect(page.getByTestId("conversation-diff-establish-notice"))
      .toContainText("统计起点已从现在开始建立。");
    await expect(page.getByTestId("conversation-diff-establish-notice")).toContainText("现起点：");
    await expect(page.getByTestId("conversation-diff-toggle"))
      .toContainText(/本次对话 · 3 个文件\s*\+98\s*−6/);
    // 唯一的写请求就是建立起点那一次；统计与展开正文都不写业务事实。
    expect(state.writes).toEqual([`${prefix}/assist-sessions/${sessionId}/conversation-diff/baseline`]);
  });

  test("状态彼此可辨：非 Git 根 / 空净变化 / 目录不可读都不画成 +0 −0", async ({ page }) => {
    await openChat(page, { diffMode: "notGit" });
    await expect(page.getByTestId("conversation-diff-toggle"))
      .toContainText("该目录不是 Git 根，首版不统计");
    expect(await page.getByTestId("conversation-diff-toggle").innerText()).not.toMatch(/[+−]\s*0/u);
  });

  test("空净变化与非 Git 根文案不同，也不同于统计中", async ({ page }) => {
    await openChat(page, { diffMode: "empty" });
    await expect(page.getByTestId("conversation-diff-toggle")).toContainText("本次对话 · 暂无文件变化");
    await page.getByTestId("conversation-diff-toggle").click();
    await expect(page.getByTestId("conversation-diff-empty")).toBeVisible();
    expect(await diffPanel(page).innerText()).not.toMatch(/[+−]\s*0/u);
  });

  test("目录不可读时正文与历史一并隐藏，只说明原因", async ({ page }) => {
    await openChat(page, { diffMode: "permission" });
    await expect(page.getByTestId("conversation-diff-toggle"))
      .toContainText("目录当前不可读（权限或位置变化）");
    await page.getByTestId("conversation-diff-toggle").click();
    await expect(page.getByTestId("conversation-diff-hidden-by-permission")).toBeVisible();
    await expect(diffPanel(page).locator(".conversation-diff-file")).toHaveCount(0);
    expect(state.diffFileReads).toBe(0); // 失权后不再读任何正文
  });

  test("未绑定工作目录：这一行整块不出现，且不发起任何统计读取", async ({ page }) => {
    await openChat(page, { unbound: true });
    // 2026-10-17 用户指令「不要有这个提示」：同一屏里目录细条已经常驻写着「选择工作目录／执行前需先归入项目」，
    // 统计入口不再复述一遍「暂不统计」；这一行连同展开面板一起不存在，但一次请求都不发。
    await expect(page.getByTestId("conversation-diff-toggle")).toHaveCount(0);
    expect(state.diffReads).toBe(0);
    // 局部行不受影响：它来自同源工具账本。
    await expect(rows(page).first()).toContainText("+78");
    await page.locator(".collab-center").screenshot({ path: "results/conversation-diff-unbound.png" });
  });

  test("刷新失败保留上次可信值并标「截至…」，下一次成功读取后恢复", async ({ page }) => {
    test.setTimeout(60_000);
    await openChat(page, { diffMode: "refreshFail" });
    await expect(page.getByTestId("conversation-diff-toggle")).toContainText(/\+98\s*−6/);
    await expect(page.getByTestId("conversation-diff-stale"))
      .toContainText("更新失败 · 截至", { timeout: 15_000 });
    // 可信值不清零：数字仍是上一次读到的那份，不退回 +0 也不消失。
    await expect(page.getByTestId("conversation-diff-toggle")).toContainText(/\+98\s*−6/);
    await page.getByTestId("conversation-diff-toggle").click();
    // 保留可信值＝展开面板照常是上一次那份逐文件清单；失败只在入口那一行说一次，
    // 不在面板里再画一条红色错误，也不把清单换成「读不到」。
    await expect(diffPanel(page)).toContainText("+78");
    await expect(page.getByTestId("conversation-diff-error")).toHaveCount(0);
    state.diffMode = "changed";
    await page.getByTestId("conversation-diff-refresh").click();
    await expect(page.getByTestId("conversation-diff-stale")).toHaveCount(0, { timeout: 15_000 });
    expect(state.writes).toEqual([]);
  });
});
