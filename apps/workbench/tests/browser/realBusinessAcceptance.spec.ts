import { expect, test, type APIRequestContext, type APIResponse, type Page, type Route } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 前端真实 API + 真实 PostgreSQL 业务验收（2026-10-08，本轮主产出）。
 *
 * 覆盖四组，每组都打到 `127.0.0.1:8788` 的真实 API 与真实 PG：
 *  1. 同会话目录/项目归属：同一 session id 被归入目录解析出的项目，历史与归属一致。
 *  2. 归属被拒 / 响应中断 / 结果未知：原历史不消失、未确认归属不冒充成功；
 *     回执核对沿用原 command_id，不换 ID 重发。
 *  3. 未知 Run 控制命令的身份：revision 更新与事件刷新之后仍保留原 command_id、
 *     回执核对入口与「禁止重复提交」。
 *  4. 窄窗（843×600 / 843×782）运行控制抽屉可进入，四类控制状态如实呈现。
 *
 * 纪律：
 * - 不在页面里伪造响应。`page.route` 只用来**制造真实的传输中断**：
 *   「先 route.fetch() 让服务端真的提交，再 route.abort() 让页面拿不到响应」
 *   与「直接 abort，请求根本没到服务端」。所有结果断言都回到真实 API 读回的事实。
 * - 不调用真实 Provider：本环境 `GET /model-port` 为 fake 且 configured=false，
 *   且没有 Worker/PG 分发器在跑，因此发送的消息只会落库为 PENDING、不会被模型回答。
 * - 创建的一切对象都带「验收测试」标记，结束时按产品入口取消 Run/任务并归档项目。
 */

const apiBase = process.env.RELAY_ACC_API_BASE_URL ?? "http://127.0.0.1:8788";
const workspaceId = process.env.RELAY_ACC_WORKSPACE_ID ?? "11111111-1111-4111-8111-11111111ac01";
const databaseUrl = process.env.RELAY_ACC_DATABASE_URL
  ?? "postgresql://relay_app@127.0.0.1:12525/relay_acc_20261008_c";
const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

/** 凭据只进进程内存：既不打印，也不写入任何文件。 */
function readBearerToken(): string {
  const fromEnvironment = process.env.RELAY_ACC_BEARER_TOKEN?.trim();
  if (fromEnvironment) return fromEnvironment;
  const row = readFileSync(join(repoRoot, "apps", "api", ".env"), "utf8").split(/\r?\n/u)
    .find((line) => line.startsWith("RELAY_API_BEARER_TOKEN="));
  const value = row?.slice("RELAY_API_BEARER_TOKEN=".length).trim();
  if (value === undefined || value === "") {
    throw new Error("缺少 Bearer 令牌：请设置 RELAY_ACC_BEARER_TOKEN，或提供 apps/api/.env。");
  }
  return value;
}

const bearerToken = readBearerToken();
const authHeaders = (): Record<string, string> => ({ authorization: `Bearer ${bearerToken}` });

interface JsonResult { readonly status: number; readonly body: Record<string, unknown> }

function apiUrl(path: string): string {
  return `${apiBase}/api/v1/workspaces/${workspaceId}${path}`;
}

async function jsonOf(response: APIResponse): Promise<Record<string, unknown>> {
  try { return await response.json() as Record<string, unknown>; } catch { return {}; }
}

async function apiGet(request: APIRequestContext, path: string): Promise<JsonResult> {
  const response = await request.get(apiUrl(path), { headers: authHeaders() });
  return { status: response.status(), body: await jsonOf(response) };
}

async function apiPost(request: APIRequestContext, path: string, data: unknown): Promise<JsonResult> {
  const response = await request.post(apiUrl(path), { headers: authHeaders(), data });
  return { status: response.status(), body: await jsonOf(response) };
}

function resultOf(body: Record<string, unknown>): Record<string, unknown> {
  const value = body["result"];
  if (typeof value !== "object" || value === null) {
    throw new Error(`响应缺少 result 字段：${JSON.stringify(body).slice(0, 300)}`);
  }
  return value as Record<string, unknown>;
}

function stringOf(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string") throw new Error(`响应缺少字符串字段 ${key}`);
  return value;
}

function itemsOf(body: Record<string, unknown>): Record<string, unknown>[] {
  const value = body["items"];
  if (!Array.isArray(value)) throw new Error(`响应缺少 items 数组：${JSON.stringify(body).slice(0, 300)}`);
  return value as Record<string, unknown>[];
}

/* -------------------------------------------------------------------------- */
/* 连接与目录工具                                                               */
/* -------------------------------------------------------------------------- */

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill(bearerToken);
  await page.getByTestId("relay-connect").click();
  await expect(page.getByTestId("relay-connection-state")).toContainText("已连接");
  await page.getByRole("dialog", { name: "连接本机 API" }).getByRole("button", { name: "关闭", exact: true }).click();
}

const createdFolders: string[] = [];

/** 目录名带 acceptance 标记：它会成为服务端最小项目的标题，便于事后识别。 */
function makeFolder(label: string): string {
  const root = join(tmpdir(), `relay-acceptance-${label}-${Date.now().toString(36)}`);
  mkdirSync(root, { recursive: true });
  createdFolders.push(root);
  return root;
}

async function openFolderInUi(page: Page, root: string): Promise<void> {
  await page.getByTestId("folder-scope-change").click();
  await page.getByTestId("folder-manual-root").fill(root);
  await page.getByTestId("folder-open-manual").click();
}

/* -------------------------------------------------------------------------- */
/* 会话夹具（全部走真实命令入口）                                              */
/* -------------------------------------------------------------------------- */

interface SessionFixture {
  readonly sessionId: string;
  readonly userMessageId: string;
  readonly assistantMessageId: string;
  readonly content: string;
}

/**
 * 建一条工作空间级会话并发一条真实普通讨论消息。
 *
 * 模型端口未配置且没有 Worker，ASSISTANT 行只会停在 PENDING：
 * `cancelAssistant=false` 时会话处于「有消息在途」，这正是服务端拒绝归属的真实条件；
 * `cancelAssistant=true` 时用产品自带的取消入口把它收口，归属才允许进行。
 */
async function createSessionFixture(request: APIRequestContext, options: {
  readonly label: string; readonly cancelAssistant: boolean;
}): Promise<SessionFixture> {
  const created = await apiPost(request, "/assist-sessions", {
    command_id: randomUUID(), project_id: null, task_id: null,
    title: `验收测试 20261008 · ${options.label}`
  });
  expect(created.status, "创建工作空间级会话").toBe(201);
  const sessionId = stringOf(resultOf(created.body), "session_id");
  const content = `验收测试 ${options.label}：这段中文历史必须在归属前后逐字保留。`;
  const sent = await apiPost(request, `/assist-sessions/${sessionId}/messages`, {
    command_id: randomUUID(), content, intent: "DISCUSS"
  });
  expect(sent.status, "发送普通讨论消息").toBe(202);
  const sentResult = resultOf(sent.body);
  const assistantMessageId = stringOf(sentResult, "assistant_message_id");
  if (options.cancelAssistant) {
    const cancelled = await apiPost(request, `/assist-messages/${assistantMessageId}/cancel`,
      { command_id: randomUUID() });
    expect(cancelled.status, "取消在途助手消息").toBe(200);
  }
  createdSessions.push(sessionId);
  return { sessionId, userMessageId: stringOf(sentResult, "user_message_id"),
    assistantMessageId, content };
}

const createdSessions: string[] = [];

async function readSession(request: APIRequestContext, sessionId: string): Promise<Record<string, unknown>> {
  const response = await apiGet(request, `/assist-sessions/${sessionId}`);
  expect(response.status, `读取会话 ${sessionId}`).toBe(200);
  return response.body;
}

async function readMessages(request: APIRequestContext, sessionId: string): Promise<Record<string, unknown>[]> {
  const response = await apiGet(request, `/assist-sessions/${sessionId}/messages`);
  expect(response.status, `读取会话消息 ${sessionId}`).toBe(200);
  return itemsOf(response.body);
}

/* -------------------------------------------------------------------------- */
/* Run 夹具（Delegate → 真实 Run，不启动任何 Worker）                            */
/* -------------------------------------------------------------------------- */

interface RunFixture {
  readonly label: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly runRevision: string;
  readonly taskRevision: string;
}

const createdRuns: RunFixture[] = [];

async function createRunFixture(request: APIRequestContext, label: string): Promise<RunFixture> {
  const title = `验收测试 20261008 · Run 控制 ${label}`;
  const project = await apiPost(request, "/projects",
    { command_id: randomUUID(), title, project_type: "GENERAL" });
  expect(project.status, "创建测试项目").toBe(201);
  const projectId = stringOf(resultOf(project.body), "project_id");
  const task = await apiPost(request, "/tasks", {
    command_id: randomUUID(), project_id: projectId, title: `${title} · 任务`,
    objective: "受控验收夹具：验证控制命令身份、状态呈现与回执核对，不调用真实 Provider。",
    mode: "AI_ASSIST", criteria: [{ statement: "产物包含自检结论", required: true }]
  });
  expect(task.status, "创建测试任务").toBe(201);
  const taskResult = resultOf(task.body);
  const taskId = stringOf(taskResult, "task_id");
  const ready = await apiPost(request, `/tasks/${taskId}/ready`,
    { command_id: randomUUID(), expected_revision: stringOf(taskResult, "revision") });
  expect(ready.status, "任务置为 READY").toBe(200);
  const delegation = await apiPost(request, `/tasks/${taskId}/delegations`, {
    command_id: randomUUID(), expected_task_revision: stringOf(resultOf(ready.body), "revision")
  });
  expect(delegation.status, "委派生成 Run").toBe(202);
  const delegated = resultOf(delegation.body);
  const fixture: RunFixture = {
    label, projectId, taskId, runId: stringOf(delegated, "run_id"),
    runRevision: stringOf(delegated, "run_revision"), taskRevision: stringOf(delegated, "task_revision")
  };
  createdRuns.push(fixture);
  return fixture;
}

async function readRun(request: APIRequestContext, runId: string): Promise<Record<string, unknown>> {
  const response = await apiGet(request, `/runs/${runId}`);
  expect(response.status, `读取 Run ${runId}`).toBe(200);
  return response.body;
}

/** 同一夹具只创建一次：控制请求提交后 Run 已不再 CREATED，不能重复造。 */
const runFixtures = new Map<string, Promise<RunFixture>>();
function runFixture(request: APIRequestContext, label: string): Promise<RunFixture> {
  const existing = runFixtures.get(label);
  if (existing) return existing;
  const created = createRunFixture(request, label);
  runFixtures.set(label, created);
  return created;
}

const psqlExe = join(repoRoot, ".research", "runtime-cache", "postgresql-18.6-2", "pgsql", "bin", "psql.exe");

/**
 * 只为「暂停中」这一种真实状态准备前置条件：把 Run 标成一个已被 Worker 领取但
 * 还没有安全点的执行权（worker_id + 租约）。之后**控制命令仍由真实 HTTP 提交**，
 * 服务端因为没有安全点而如实把它留在 PENDING；面板读到的每个字段都来自真实 API。
 * 不写任何断言字段，不伪造任何响应。
 */
/** psql 会额外打印 "UPDATE 1" 之类的状态行，这里只取回真正的数据行。 */
function psqlRows(sql: string): string[] {
  if (!existsSync(psqlExe)) throw new Error(`缺少 psql 可执行文件：${psqlExe}`);
  return execFileSync(psqlExe, [databaseUrl, "-w", "-t", "-A", "-c", sql], { encoding: "utf8" })
    .split(/\r?\n/u).map((row) => row.trim())
    .filter((row) => row !== "" && !/^(UPDATE|INSERT|SELECT)\s+\d+$/u.test(row));
}

function claimRunWorker(runId: string): void {
  const updated = psqlRows(`update runs set worker_id = 'acceptance-test-claimed-worker',
    worker_lease_until = now() + interval '10 minutes' where id = '${runId}' returning id;`);
  if (updated[0] !== runId) throw new Error(`未能把 Run ${runId} 标记为已领取执行权（psql 返回 ${updated.join("|")}）。`);
}

function releaseRunWorker(runId: string): void {
  psqlRows(`update runs set worker_id = null, worker_lease_until = null where id = '${runId}';`);
}

/* -------------------------------------------------------------------------- */
/* 传输中断装置：只制造中断，不伪造响应                                         */
/* -------------------------------------------------------------------------- */

interface BindingRouteOptions {
  /** true：先让服务端真的提交，再让页面拿不到响应（结果未知＝已提交）。 */
  readonly commitBeforeLosing: boolean;
}

interface BindingRouteRecorder {
  readonly commandIds: string[];
  unregister(): Promise<void>;
}

/** 让「在途」窗口可被观察到：真实提交后短暂停顿，再让页面拿不到响应。 */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

async function breakBindingResponse(page: Page, sessionId: string,
  options: BindingRouteOptions): Promise<BindingRouteRecorder> {
  const commandIds: string[] = [];
  const pattern = new RegExp(`/api/v1/workspaces/[^/]+/assist-sessions/${sessionId}/binding$`, "u");
  const handler = async (route: Route): Promise<void> => {
    const request = route.request();
    if (request.method() !== "POST") { await route.fallback(); return; }
    const payload = JSON.parse(request.postData() ?? "{}") as { command_id?: string };
    commandIds.push(String(payload.command_id));
    // 真实提交：请求确实到达 8788 与 PG，命令真的入库。
    if (options.commitBeforeLosing) await route.fetch();
    await delay(600);
    // 页面收不到响应：这才是「结果未知」，不是伪造成功。
    await route.abort();
  };
  await page.route(pattern, handler);
  return {
    commandIds,
    unregister: async () => { await page.unroute(pattern, handler); }
  };
}

interface ControlRouteRecorder {
  readonly commandIds: string[];
  readonly receiptQueries: string[];
  unregister(): Promise<void>;
}

async function loseControlResponse(page: Page, runId: string): Promise<ControlRouteRecorder> {
  const commandIds: string[] = [];
  const receiptQueries: string[] = [];
  const pattern = new RegExp(`/api/v1/workspaces/[^/]+/runs/${runId}/control-requests$`, "u");
  // 只观察真实网络请求，不改写任何响应：用来证明回执核对沿用原 command_id。
  const observe = (request: { method(): string; url(): string }): void => {
    if (request.method() === "GET" && /\/commands\/[0-9a-f-]{36}$/u.test(request.url())) receiptQueries.push(request.url());
  };
  page.on("request", observe);
  const handler = async (route: Route): Promise<void> => {
    const request = route.request();
    if (request.method() !== "POST") { await route.fallback(); return; }
    const payload = JSON.parse(request.postData() ?? "{}") as { command_id?: string };
    commandIds.push(String(payload.command_id));
    await route.fetch();
    await delay(600);
    await route.abort();
  };
  await page.route(pattern, handler);
  return {
    commandIds, receiptQueries,
    unregister: async () => { await page.off("request", observe); await page.unroute(pattern, handler); }
  };
}

/* -------------------------------------------------------------------------- */
/* 1. 同会话目录/项目归属                                                       */
/* -------------------------------------------------------------------------- */

test("组 1：普通讨论归入目录项目——同一 session id、历史逐字保留、两侧可读回", async ({ page }) => {
  const folderRoot = makeFolder("binding-confirmed");
  const fixture = await createSessionFixture(page.request, { label: "同会话归属", cancelAssistant: true });

  const before = await readSession(page.request, fixture.sessionId);
  expect(before["project_id"], "绑定前不得冒充已归属").toBeNull();
  expect(before["status"]).toBe("ACTIVE");
  const messagesBefore = await readMessages(page.request, fixture.sessionId);
  expect(messagesBefore.map((row) => row["id"])).toEqual([fixture.userMessageId, fixture.assistantMessageId]);

  await page.goto("/agent");
  await connect(page);
  await expect(page.getByTestId("assist-transcript")).toContainText(fixture.content);
  await expect(page.getByTestId("collab-unassigned-execution-hint")).toContainText("不能进入执行");
  await expect(page.getByTestId("collab-binding"), "绑定前不得出现已归属提示").toHaveCount(0);

  await openFolderInUi(page, folderRoot);
  await expect(page.getByTestId("collab-binding")).toHaveAttribute("data-status", "CONFIRMED", { timeout: 30_000 });
  await expect(page.getByTestId("collab-binding")).toHaveAttribute("data-session", fixture.sessionId);
  await expect(page.getByTestId("folder-scope-project")).toContainText("项目：");

  // 服务端事实：同一个会话被归入目录解析出的项目，没有新建第二个会话。
  const after = await readSession(page.request, fixture.sessionId);
  expect(after["id"]).toBe(fixture.sessionId);
  const boundProjectId = after["project_id"];
  expect(typeof boundProjectId, "绑定后必须能读回 project_id").toBe("string");
  expect(boundProjectId as string).toMatch(/^[0-9a-f-]{36}$/u);
  expect(Number(after["revision"])).toBeGreaterThan(Number(before["revision"]));

  const messagesAfter = await readMessages(page.request, fixture.sessionId);
  expect(messagesAfter.map((row) => row["id"])).toEqual([fixture.userMessageId, fixture.assistantMessageId]);
  expect(messagesAfter.find((row) => row["id"] === fixture.userMessageId)?.["content"]).toBe(fixture.content);

  const workspaceList = itemsOf((await apiGet(page.request, "/assist-sessions")).body);
  expect(workspaceList.filter((row) => row["project_id"] === null && row["task_id"] === null)
    .map((row) => row["id"])).not.toContain(fixture.sessionId);
  const projectList = itemsOf((await apiGet(page.request,
    `/assist-sessions?project_id=${boundProjectId as string}`)).body);
  expect(projectList.map((row) => row["id"])).toEqual([fixture.sessionId]);

  // 界面仍按同一个会话读历史，归属不是授权：没有因此产生执行请求。
  await expect(page.getByTestId("assist-transcript")).toContainText(fixture.content);
  await expect(page.getByTestId("collab-unassigned-execution-hint")).toHaveCount(0);
  const executions = itemsOf((await apiGet(page.request,
    `/conversation-execution-requests?session_id=${fixture.sessionId}`)).body);
  expect(executions).toHaveLength(0);

  console.log(`[组 1] session=${fixture.sessionId} project=${boundProjectId as string} `
    + `messages=${messagesAfter.length} folder=${folderRoot}`);
});

/* -------------------------------------------------------------------------- */
/* 2a. 归属被服务端拒绝                                                          */
/* -------------------------------------------------------------------------- */

test("组 2a：归属被服务端拒绝（409 有消息在途）——原历史不消失、未确认归属不冒充成功", async ({ page }) => {
  const folderRoot = makeFolder("binding-rejected");
  // 不取消助手消息：会话真实处于「有消息在途」，服务端据此拒绝改归属。
  const fixture = await createSessionFixture(page.request, { label: "归属被拒", cancelAssistant: false });
  const before = await readSession(page.request, fixture.sessionId);
  expect(before["project_id"]).toBeNull();
  const messagesBefore = await readMessages(page.request, fixture.sessionId);

  await page.goto("/agent");
  await connect(page);
  await expect(page.getByTestId("assist-transcript")).toContainText(fixture.content);
  await openFolderInUi(page, folderRoot);

  const binding = page.getByTestId("collab-binding");
  await expect(binding).toHaveAttribute("data-status", "FAILED", { timeout: 30_000 });
  await expect(binding).toHaveAttribute("data-session", fixture.sessionId);
  await expect(binding).toContainText("409");
  await expect(binding).toContainText("未归入项目");
  await expect(binding).toContainText("消息在途");
  // 拒绝不改写会话：原历史、会话面板与讨论输入都还在。
  await expect(page.getByTestId("assist-transcript")).toContainText(fixture.content);
  await expect(page.getByTestId("collab-unassigned-execution-hint")).toContainText("不能进入执行");
  await expect(page.getByTestId("assist-draft")).toBeVisible();

  const after = await readSession(page.request, fixture.sessionId);
  expect(after["project_id"], "被拒后仍不得归属").toBeNull();
  expect(after["revision"], "被拒不改写会话修订").toBe(before["revision"]);
  const messagesAfter = await readMessages(page.request, fixture.sessionId);
  expect(messagesAfter.map((row) => row["id"])).toEqual(messagesBefore.map((row) => row["id"]));

  // 没有为「归属」另建第二个会话：新项目下没有任何会话。
  const projectScoped = itemsOf((await apiGet(page.request,
    `/assist-sessions?project_id=${await resolveProjectOfFolder(page, folderRoot)}`)).body);
  expect(projectScoped).toHaveLength(0);

  // 收口在途消息后，同一段讨论仍能经产品入口归入项目（没有被拒状态卡死）。
  const cancelled = await apiPost(page.request, `/assist-messages/${fixture.assistantMessageId}/cancel`,
    { command_id: randomUUID() });
  expect(cancelled.status).toBe(200);
  await page.getByTestId("folder-open-manual").click();
  await expect(page.getByTestId("collab-binding")).toHaveAttribute("data-status", "CONFIRMED", { timeout: 30_000 });
  const rebound = await readSession(page.request, fixture.sessionId);
  expect(rebound["id"]).toBe(fixture.sessionId);
  expect(rebound["project_id"]).toMatch(/^[0-9a-f-]{36}$/u);
  const messagesRebound = await readMessages(page.request, fixture.sessionId);
  expect(messagesRebound.map((row) => row["id"])).toEqual(messagesBefore.map((row) => row["id"]));

  console.log(`[组 2a] session=${fixture.sessionId} rejected=409 revision=${String(before["revision"])} `
    + `messages=${messagesRebound.length}`);
});

/** 目录被打开后由服务端解析出的项目：这里从项目列表按目录名读回，避免前端自述。 */
async function resolveProjectOfFolder(page: Page, folderRoot: string): Promise<string> {
  const rows = itemsOf((await apiGet(page.request, "/projects?status=all&limit=100")).body);
  const matched = rows.find((row) => typeof row["title"] === "string"
    && row["title"].includes(folderRoot.split(/[\\/]/u).pop() ?? ""));
  if (matched === undefined) throw new Error(`项目列表里找不到目录 ${folderRoot} 解析出的项目。`);
  return String(matched["id"]);
}

/* -------------------------------------------------------------------------- */
/* 2b. 归属响应中断：服务端已提交                                              */
/* -------------------------------------------------------------------------- */

test("组 2b：归属响应中断但服务端已提交——按原 command_id 核对，不换 ID 重发", async ({ page }) => {
  const folderRoot = makeFolder("binding-unknown-committed");
  const fixture = await createSessionFixture(page.request, { label: "归属结果未知", cancelAssistant: true });
  await page.goto("/agent");
  await connect(page);
  await expect(page.getByTestId("assist-transcript")).toContainText(fixture.content);

  const breaker = await breakBindingResponse(page, fixture.sessionId, { commitBeforeLosing: true });
  await openFolderInUi(page, folderRoot);

  const binding = page.getByTestId("collab-binding");
  await expect(binding).toHaveAttribute("data-status", "UNKNOWN", { timeout: 30_000 });
  expect(breaker.commandIds, "归属命令只发一次").toHaveLength(1);
  const commandId = breaker.commandIds[0]!;
  expect(commandId).toMatch(/^[0-9a-f-]{36}$/u);
  await expect(binding).toContainText(commandId);
  await expect(page.getByTestId("collab-binding-receipt")).toBeVisible();
  // 结果未知期间不切作用域：原历史保持可读，也没有冒充已归属。
  await expect(page.getByTestId("assist-transcript")).toContainText(fixture.content);
  await expect(page.getByTestId("collab-unassigned-execution-hint")).toContainText("不能进入执行");

  // 服务端事实：命令真的入库了（这正是「结果未知」而不是「未执行」）。
  const receipt = await apiGet(page.request, `/commands/${commandId}`);
  expect(receipt.status, "原 command_id 的回执必须可查").toBe(200);
  expect(receipt.body["command_type"]).toBe("BindAssistSessionProject");
  const committed = await readSession(page.request, fixture.sessionId);
  expect(committed["project_id"], "服务端确实已改归属").toMatch(/^[0-9a-f-]{36}$/u);

  await page.getByTestId("collab-binding-receipt").click();
  await expect(page.getByTestId("collab-binding")).toHaveAttribute("data-status", "CONFIRMED", { timeout: 30_000 });
  await expect(page.getByTestId("collab-binding")).toHaveAttribute("data-session", fixture.sessionId);
  // 核对只按原 command_id 查询，没有换 ID 重发第二条归属命令。
  expect(breaker.commandIds).toEqual([commandId]);
  await expect(page.getByTestId("assist-transcript")).toContainText(fixture.content);
  await breaker.unregister();

  console.log(`[组 2b] session=${fixture.sessionId} command_id=${commandId} `
    + `project=${String(committed["project_id"])} posts=${breaker.commandIds.length}`);
});

/* -------------------------------------------------------------------------- */
/* 2c. 归属响应中断：服务端未提交                                               */
/* -------------------------------------------------------------------------- */

test("组 2c：归属响应在提交前中断——回执核对沿用原 command_id，不冒充成功也不换 ID 重发", async ({ page }) => {
  const folderRoot = makeFolder("binding-unknown-uncommitted");
  const fixture = await createSessionFixture(page.request, { label: "归属未提交", cancelAssistant: true });
  await page.goto("/agent");
  await connect(page);
  await expect(page.getByTestId("assist-transcript")).toContainText(fixture.content);

  // 请求根本没到服务端：只有这一种中断能让「未执行」与「已提交」区分开。
  const breaker = await breakBindingResponse(page, fixture.sessionId, { commitBeforeLosing: false });
  await openFolderInUi(page, folderRoot);
  const binding = page.getByTestId("collab-binding");
  await expect(binding).toHaveAttribute("data-status", "UNKNOWN", { timeout: 30_000 });
  expect(breaker.commandIds).toHaveLength(1);
  const commandId = breaker.commandIds[0]!;
  await expect(binding).toContainText(commandId);

  const stillUnassigned = await readSession(page.request, fixture.sessionId);
  expect(stillUnassigned["project_id"], "服务端未收到命令，归属不得变化").toBeNull();
  const missing = await apiGet(page.request, `/commands/${commandId}`);
  expect(missing.status).toBe(404);
  expect(missing.body["code"]).toBe("COMMAND_NOT_FOUND");

  await page.getByTestId("collab-binding-receipt").click();
  // 查不到原回执时必须继续停在「结果未知」，不能把待核对显示成成功。
  await expect(page.getByTestId("collab-binding")).toHaveAttribute("data-status", "UNKNOWN");
  await expect(page.getByTestId("collab-binding")).toContainText("不能另发命令重试");
  await expect(page.getByTestId("assist-transcript")).toContainText(fixture.content);
  expect(breaker.commandIds, "核对回执不得触发第二条归属命令").toEqual([commandId]);

  // 未确认归属期间归属闸保持锁住：重开目录也不会 Blind 重发原命令。
  await page.getByTestId("folder-open-manual").click();
  await delay(1_500);
  expect(breaker.commandIds, "结果未知期间不得换 ID 或重组载荷重发").toEqual([commandId]);
  expect((await readSession(page.request, fixture.sessionId))["project_id"]).toBeNull();

  // 人工重读页面后闸随本次页面状态重新开始：新的目录命令可以正常归属。
  await breaker.unregister();
  await page.reload();
  await connect(page);
  await openFolderInUi(page, folderRoot);
  await expect(page.getByTestId("collab-binding")).toHaveAttribute("data-status", "CONFIRMED", { timeout: 30_000 });
  const rebound = await readSession(page.request, fixture.sessionId);
  expect(rebound["id"]).toBe(fixture.sessionId);
  expect(rebound["project_id"]).toMatch(/^[0-9a-f-]{36}$/u);
  const messages = await readMessages(page.request, fixture.sessionId);
  expect(messages.find((row) => row["id"] === fixture.userMessageId)?.["content"]).toBe(fixture.content);

  console.log(`[组 2c] session=${fixture.sessionId} command_id=${commandId} receipt=COMMAND_NOT_FOUND `
    + `posts=${breaker.commandIds.length}`);
});

/* -------------------------------------------------------------------------- */
/* 3. 未知 Run 控制命令的身份保留                                               */
/* -------------------------------------------------------------------------- */

test("组 3：控制命令响应中断后，Run 修订更新与事件刷新都不清掉原 command_id 与核对入口", async ({ page }) => {
  test.setTimeout(180_000);
  const fixture = await runFixture(page.request, "unknown-control");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/runs/${fixture.runId}`);
  await connect(page);
  const rail = page.locator('aside[aria-label="运行信息与控制"]');
  await expect(rail.getByTestId("run-control")).toBeVisible();
  await expect(rail.getByTestId("run-control-PAUSE")).toBeEnabled();

  const breaker = await loseControlResponse(page, fixture.runId);
  const panel = rail.getByTestId("run-control");
  await rail.getByTestId("run-control-PAUSE").click();
  // 在途窗口先按「尚未暂停」呈现，不改写成已暂停。
  await expect(rail.getByTestId("run-control-inflight")).toContainText("Run 尚未暂停");
  await expect(panel.locator("p.action-error")).toContainText("请查询原 command_id 回执");
  await expect(panel.locator("p.action-error")).toContainText("不能换 ID 再提交");
  expect(breaker.commandIds).toHaveLength(1);
  const commandId = breaker.commandIds[0]!;

  // 服务端事实：命令真的入库并被安全点处理（Run 已暂停、修订 +2）。
  const receipt = await apiGet(page.request, `/commands/${commandId}`);
  expect(receipt.status, "控制命令回执必须可按原 ID 查到").toBe(200);
  expect(receipt.body["command_type"]).toBe("RequestRunControl");
  const controlRequestId = stringOf(resultOf(receipt.body), "control_request_id");
  const runAfterControl = await readRun(page.request, fixture.runId);
  expect(runAfterControl["status"], "服务端事实：安全点已处理暂停").toBe("PAUSED");
  expect(Number(runAfterControl["revision"])).toBeGreaterThan(Number(fixture.runRevision));

  // 事件流/轮询把新修订读回页面后，未知命令身份与核对入口必须还在。
  await expect(page.getByTestId("run-page-head")).toContainText(
    `Run 修订 v${String(runAfterControl["revision"])}`, { timeout: 40_000 });
  await expect(rail.getByTestId("run-control")).toContainText(`原 command_id：${commandId}`);
  await expect(rail.getByTestId("run-check-receipt")).toBeVisible();
  // 未核对前不得出现「已受理」的本地记录。
  await expect(rail.getByTestId("run-control-accepted")).toHaveCount(0);
  // 服务端已暂停是真实事实，与「我这条命令是否受理」分开呈现。
  await expect(page.getByTestId("run-paused-summary")).toContainText("已暂停");

  await rail.getByTestId("run-check-receipt").click();
  // 核对后交回服务端事实：控制记录变成权威来源，待核对状态与本地身份一起收口。
  await expect(rail.getByTestId("run-control-status")).toContainText(controlRequestId);
  await expect(rail.getByTestId("run-control-status")).toContainText("APPLIED");
  await expect(rail.getByTestId("run-check-receipt")).toHaveCount(0);
  await expect(rail.getByTestId("run-control")).not.toContainText(`原 command_id：${commandId}`);
  expect(breaker.commandIds, "核对回执不得重发控制命令").toEqual([commandId]);
  expect(breaker.receiptQueries, "回执只按原 command_id 查询一次").toEqual([`${apiUrl(`/commands/${commandId}`)}`]);
  await breaker.unregister();

  console.log(`[组 3] run=${fixture.runId} command_id=${commandId} control_request_id=${controlRequestId} `
    + `run_revision=${fixture.runRevision}->${String(runAfterControl["revision"])}`);
});

test("组 3b：控制命令响应中断后整页重读，原 command_id 与回执核对入口仍须可查", async ({ page }) => {
  test.setTimeout(180_000);
  const fixture = await runFixture(page.request, "unknown-control-reload");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/runs/${fixture.runId}`);
  await connect(page);
  const rail = page.locator('aside[aria-label="运行信息与控制"]');
  await expect(rail.getByTestId("run-control")).toBeVisible();

  const breaker = await loseControlResponse(page, fixture.runId);
  await rail.getByTestId("run-control-PAUSE").click();
  await expect(rail.getByTestId("run-control").locator("p.action-error")).toContainText("请查询原 command_id 回执");
  expect(breaker.commandIds).toHaveLength(1);
  const commandId = breaker.commandIds[0]!;
  // 服务端事实：原命令真的入库（响应丢失，不等于未执行）。
  const receipt = await apiGet(page.request, `/commands/${commandId}`);
  expect(receipt.status, "控制命令回执必须可按原 ID 查到").toBe(200);
  expect(receipt.body["command_type"]).toBe("RequestRunControl");

  await page.reload();
  await connect(page);
  const railAfterReload = page.locator('aside[aria-label="运行信息与控制"]');
  await expect(railAfterReload.getByTestId("run-control")).toBeVisible();
  // 整页重读之后，结果未知的原命令身份仍必须能取回并继续核对。
  await expect(railAfterReload.getByTestId("run-control")).toContainText(`原 command_id：${commandId}`);
  await expect(railAfterReload.getByTestId("run-control-recheck")).toContainText("仍在等原命令回执");
  await expect(railAfterReload.getByTestId("run-check-receipt")).toBeVisible();
  // 核对前仍禁止重复提交：四个控制入口不回来。
  for (const control of ["run-control-PAUSE", "run-control-CANCEL", "run-control-HANDOFF",
    "run-control-CANCEL_TASK"]) {
    await expect(railAfterReload.getByTestId(control)).toHaveCount(0);
  }
  const controlRequestId = stringOf(resultOf(receipt.body), "control_request_id");
  await railAfterReload.getByTestId("run-check-receipt").click();
  await expect(railAfterReload.getByTestId("run-control-status")).toContainText(controlRequestId);
  expect(breaker.commandIds).toEqual([commandId]);
  expect(breaker.receiptQueries).toEqual([`${apiUrl(`/commands/${commandId}`)}`]);
  await breaker.unregister();

  console.log(`[组 3b] run=${fixture.runId} command_id=${commandId} control_request_id=${controlRequestId} `
    + `survived_reload=true`);
});

/* -------------------------------------------------------------------------- */
/* 4. 窄窗运行控制抽屉                                                          */
/* -------------------------------------------------------------------------- */

const narrowSizes = [{ width: 843, height: 600 }, { width: 843, height: 782 }] as const;

type ControlState = "未运行" | "暂停中" | "已暂停" | "结果待核对";

const stateFixtures = new Map<string, Promise<RunFixture>>();

/**
 * 每个 (窗口, 状态) 用自己的 Run：「结果待核对」那条命令一旦提交就会真的被安全点处理，
 * 复用同一个 Run 会让下一条用例看到的是已暂停的 Run，而不是它要验的状态。
 */
function controlStateFixture(request: APIRequestContext, size: { width: number; height: number },
  state: ControlState): Promise<RunFixture> {
  const key = `${size.width}x${size.height}|${state}`;
  const existing = stateFixtures.get(key);
  if (existing) return existing;
  const label = `narrow-${size.width}x${size.height}-${state}`;
  const created = (async () => {
    if (state === "未运行" || state === "结果待核对") return runFixture(request, label);
    if (state === "已暂停") {
      const fixture = await runFixture(request, label);
      const paused = await apiPost(request, `/runs/${fixture.runId}/control-requests`, {
        command_id: randomUUID(), expected_task_revision: fixture.taskRevision,
        expected_run_revision: fixture.runRevision, type: "PAUSE"
      });
      expect(paused.status, "暂停夹具").toBe(202);
      return fixture;
    }
    const fixture = await runFixture(request, label);
    // 前置条件：Run 已被领取执行权但没有安全点，服务端会如实把暂停留在 PENDING。
    claimRunWorker(fixture.runId);
    const pending = await apiPost(request, `/runs/${fixture.runId}/control-requests`, {
      command_id: randomUUID(), expected_task_revision: fixture.taskRevision,
      expected_run_revision: fixture.runRevision, type: "PAUSE"
    });
    expect(pending.status, "暂停中夹具").toBe(202);
    const controlRequestId = stringOf(resultOf(pending.body), "control_request_id");
    const record = await apiGet(request, `/runs/${fixture.runId}/control-requests/${controlRequestId}`);
    expect(record.status).toBe(200);
    expect(record.body["status"], "有在途执行权时暂停必须停在 PENDING").toBe("PENDING");
    return fixture;
  })();
  stateFixtures.set(key, created);
  return created;
}

for (const size of narrowSizes) {
  for (const state of ["未运行", "暂停中", "已暂停", "结果待核对"] as const) {
    test(`组 4：${size.width}×${size.height} 抽屉可进入，${state}如实呈现`, async ({ page }) => {
      test.setTimeout(120_000);
      const fixture = await controlStateFixture(page.request, size, state);
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.goto(`/runs/${fixture.runId}`);
      await connect(page);

      // 窄窗下右栏收起，控制入口必须仍能进入。
      const trigger = page.getByTestId("rail-trigger");
      await expect(trigger).toBeVisible();
      await trigger.click();
      const drawer = page.getByRole("dialog", { name: "运行信息与控制" });
      await expect(drawer).toBeVisible();
      await expect(drawer.getByTestId("run-control")).toBeVisible();
      // 抽屉不得把窄窗撑出横向滚动。
      const overflow = await page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, "窄窗不得出现横向溢出").toBeLessThanOrEqual(1);

      if (state === "结果待核对") {
        const breaker = await loseControlResponse(page, fixture.runId);
        const panel = drawer.getByTestId("run-control");
        await panel.getByTestId("run-control-PAUSE").click();
        await expect(panel.locator("p.action-error")).toContainText("请查询原 command_id 回执");
        const commandId = breaker.commandIds[0]!;
        await expect(panel).toContainText(`原 command_id：${commandId}`);
        // 待核对期间四个控制入口收起：不允许在结果未知时再发第二条。
        await expect(drawer.getByTestId("run-check-receipt")).toBeVisible();
        await expect(drawer.getByTestId("run-control-PAUSE")).toHaveCount(0);
        await expect(drawer.getByTestId("run-control-accepted")).toHaveCount(0);
        await breaker.unregister();
        console.log(`[组 4] ${size.width}x${size.height} 结果待核对 run=${fixture.runId} command_id=${commandId}`);
        return;
      }

      const expectedRunLabel = state === "未运行" ? "待启动" : state === "暂停中" ? "待启动" : "已暂停";
      await expect(drawer.getByTestId("run-info")).toContainText(expectedRunLabel);
      // 已暂停时暂停入口换成恢复入口，其余三个控制入口不变。
      const controls = state === "已暂停"
        ? ["run-resume", "run-control-CANCEL", "run-control-HANDOFF", "run-control-CANCEL_TASK"]
        : ["run-control-PAUSE", "run-control-CANCEL", "run-control-HANDOFF", "run-control-CANCEL_TASK"];
      for (const control of controls) {
        await expect(drawer.getByTestId(control)).toBeVisible();
      }
      if (state === "已暂停") await expect(drawer.getByTestId("run-control-PAUSE")).toHaveCount(0);
      if (state === "未运行") {
        await expect(drawer.getByTestId("run-control-PAUSE")).toBeEnabled();
        await expect(drawer.getByTestId("run-control-pending")).toHaveCount(0);
        // 已暂停摘要在主列（不在抽屉里），因此按整页断言。
        await expect(page.getByTestId("run-paused-summary")).toHaveCount(0);
      }
      if (state === "暂停中") {
        const pending = drawer.getByTestId("run-control-pending");
        await expect(pending).toContainText("Run 尚未暂停");
        await expect(pending).toContainText("等待安全点处理");
        // 请求在途不等于已暂停：暂停摘要与恢复入口都不得出现。
        await expect(page.getByTestId("run-paused-summary")).toHaveCount(0);
        await expect(drawer.getByTestId("run-resume")).toHaveCount(0);
        await expect(drawer.getByTestId("run-control-PAUSE")).toBeDisabled();
      }
      if (state === "已暂停") {
        await expect(page.getByTestId("run-paused-summary")).toContainText("服务端事实：Run 已在安全边界内暂停");
      }
      // 面板呈现的每个状态都要能在真实 API 读回同一份事实。
      const runFact = await readRun(page.request, fixture.runId);
      if (state === "暂停中") {
        expect(runFact["status"], "请求在途不等于已暂停").toBe("CREATED");
        const pending = (runFact["pending_control_request"] ?? {}) as Record<string, unknown>;
        expect(pending["type"]).toBe("PAUSE");
        expect(pending["status"]).toBe("PENDING");
      }
      if (state === "已暂停") expect(runFact["status"]).toBe("PAUSED");
      if (state === "未运行") expect(runFact["status"]).toBe("CREATED");
      console.log(`[组 4] ${size.width}x${size.height} ${state} run=${fixture.runId} `
        + `status=${String(runFact["status"])}`);
    });
  }
}

/* -------------------------------------------------------------------------- */
/* 清理：按产品入口收口，不删库、不删事实                                        */
/* -------------------------------------------------------------------------- */

test.afterAll(async ({ request }) => {
  const problem = (body: Record<string, unknown>): string =>
    `${body["code"] ?? "?"} ${String(body["detail"] ?? "").slice(0, 60)}`;
  for (const fixture of createdRuns) {
    try {
      releaseRunWorker(fixture.runId);
      const run = await apiGet(request, `/runs/${fixture.runId}`);
      if (!["COMPLETED", "FAILED", "CANCELLED"].includes(String(run.body["status"]))) {
        // 用当前修订提交；若该 Run 还有未决控制请求，必须显式取代它（否则服务端按 CONTROL_CONFLICT 拒绝）。
        const task = await apiGet(request, `/tasks/${fixture.taskId}`);
        const pending = (run.body["pending_control_request"] ?? {}) as Record<string, unknown>;
        const supersedes = typeof pending["id"] === "string" ? pending["id"] : undefined;
        const cancelled = await apiPost(request, `/runs/${fixture.runId}/control-requests`, {
          command_id: randomUUID(), expected_task_revision: stringOf(task.body, "revision"),
          expected_run_revision: stringOf(run.body, "revision"), type: "CANCEL",
          ...(supersedes === undefined ? {} : { supersedes_request_id: supersedes })
        });
        console.log(`[清理] 取消 Run ${fixture.runId} → HTTP ${cancelled.status}`
          + `${cancelled.status >= 400 ? ` ${problem(cancelled.body)}` : ""}`);
      }
      const task = await apiGet(request, `/tasks/${fixture.taskId}`);
      if (!["CANCELLED", "COMPLETED"].includes(String(task.body["status"]))) {
        const cancelled = await apiPost(request, `/tasks/${fixture.taskId}/cancel`, {
          command_id: randomUUID(), expected_task_revision: stringOf(task.body, "revision")
        });
        console.log(`[清理] 取消任务 ${fixture.taskId} → HTTP ${cancelled.status}`
          + `${cancelled.status >= 400 ? ` ${problem(cancelled.body)}` : ""}`);
      }
      const project = await apiGet(request, `/projects/${fixture.projectId}`);
      if (project.status === 200 && project.body["archived_at"] === null) {
        const archived = await apiPost(request, `/projects/${fixture.projectId}/archive`, {
          command_id: randomUUID(), expected_revision: stringOf(project.body, "revision")
        });
        console.log(`[清理] 归档项目 ${fixture.projectId} → HTTP ${archived.status}`
          + `${archived.status >= 400 ? ` ${problem(archived.body)}` : ""}`);
      }
    } catch (error) {
      console.log(`[清理] ${fixture.runId} 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const root of createdFolders) rmSync(root, { recursive: true, force: true });
  console.log(`[清理] 目录 ${createdFolders.length} 个已删除；会话 ${createdSessions.length} 条保留为验收证据`
    + `（HTTP 面没有归档/删除会话的命令入口）`);
  console.log("[清理] 项目归档若返回 409 PROJECT_ARCHIVE_BLOCKED 属预期栅栏：夹具任务的执行者仍是 AI，"
    + "产品不允许在遗留 AI 执行权时归档项目；这些项目保留在隔离库里并带「验收测试」标题，不删事实。");
  console.log(`[清单] projects=${createdRuns.map((item) => item.projectId).join(",") || "无"}`);
  console.log(`[清单] tasks=${createdRuns.map((item) => item.taskId).join(",") || "无"}`);
  console.log(`[清单] runs=${createdRuns.map((item) => item.runId).join(",") || "无"}`);
  console.log(`[清单] sessions=${createdSessions.join(",") || "无"}`);
});