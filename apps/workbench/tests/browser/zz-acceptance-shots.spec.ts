import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * 0145 P0 验收截图（2026-10-30）。
 * 只连页面内夹具：一台有状态的假服务端，按真实继承规则算档位。
 */

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const sessionA = "aaaa0000-0000-4000-8000-00000000000a";
const sessionB = "bbbb0000-0000-4000-8000-00000000000b";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = "http://127.0.0.1:4173";
const out = "output/p0-acceptance";

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}
async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(),
    body: JSON.stringify(body) });
}

interface FakeSession { readonly id: string; readonly title: string; tokens: number;
  revision: number; hasMessages: boolean }

function sessionDto(item: FakeSession): Record<string, unknown> {
  return { id: item.id, workspace_id: workspaceId, project_id: projectId, task_id: taskId,
    title: item.title, status: "ACTIVE", revision: String(item.revision), pinned_at: null,
    unread_at: null, last_message_at: item.hasMessages ? "2026-10-30T00:00:00Z" : null,
    has_messages: item.hasMessages, run_state: null, conversation_mode: "AGENT",
    chat_mode: "CHAT", assistant_profile_id: null, assistant_profile_revision: null,
    assistant_role: null, remember: true, working_resource_id: null,
    forked_from_session_id: null, created_at: "2026-10-30T00:00:00Z",
    updated_at: "2026-10-30T00:00:00Z" };
}

function messageDto(id: string, role: string, seq: string, content: string): unknown {
  return { id, session_id: sessionA, role, status: "COMPLETED", seq, intent: "DISCUSS",
    content, error_code: null, provider_error_kind: null, cancel_requested: false,
    steer_requested: false, usage: { input_tokens: 10_607, output_tokens: 646,
      cache_read_tokens: null, cache_creation_tokens: null }, sources: [], skill: null,
    skill_input: null, skill_output: null, attachments: [],
    created_at: "2026-10-30T00:00:00Z", updated_at: "2026-10-30T00:00:00Z", revision: "1" };
}

async function installStatefulServer(page: Page): Promise<void> {
  const sessions = new Map<string, FakeSession>([
    [sessionA, { id: sessionA, title: "实验评价指标体系", tokens: 524_288, revision: 1,
      hasMessages: true }],
  ]);
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    const body = request.postData() === null ? {} :
      JSON.parse(String(request.postData())) as Record<string, unknown>;
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/tasks/${taskId}`) return fulfillJson(route, { id: taskId,
      project_id: projectId, title: "整理实验评价指标", status: "IN_PROGRESS", mode: "ME",
      revision: "2", created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z",
      executor: { kind: "HUMAN", run_id: null, ownership_epoch: "1" },
      current_completion_id: null, waiting_reason: null, blocking_task_ids: [],
      unresolved_blocker_ids: [], allowed_actions: [],
      acceptance: { acceptance_revision: "2", objective: "补齐基线。", source: "CREATE",
        created_at: "2026-10-16T00:00:00Z", criteria: [] }, dependencies: [] });
    if (path === `${prefix}/projects/${projectId}`) return fulfillJson(route, { id: projectId,
      title: "上下文档位验收", project_type: "GENERAL", revision: "1", state_revision: "1",
      archived_at: null });
    if (path === `${prefix}/default-working-directory`) return fulfillJson(route,
      { resource_id: null, canonical_root: null, display_name: null, write_tier: null,
        default_write_tier: null, context_budget_tokens: null, status: "UNSET", reason: null,
        revision: "0" });
    if (path === `${prefix}/model-port`) return fulfillJson(route, { provider: "openai-compatible",
      configured: true, model: "gpt-4.1-mini", base_url: null, max_call_tokens: 65_536 });
    if (path === `${prefix}/skill-definitions`) return fulfillJson(route, { items: [] });
    if (path === `${prefix}/assist-sessions` && method === "GET") {
      return fulfillJson(route, { items: [...sessions.values()].map(sessionDto) });
    }
    if (path === `${prefix}/assist-sessions` && method === "POST") {
      const source = typeof body.source_session_id === "string" ? body.source_session_id : null;
      const explicit = typeof body.context_budget_tokens === "number" ? body.context_budget_tokens : null;
      const tokens = explicit ?? (source === null ? 262_144 : sessions.get(source)?.tokens ?? 262_144);
      const created: FakeSession = { id: sessionB, title: String(body.title ?? "新建讨论"),
        tokens, revision: 1, hasMessages: false };
      sessions.set(sessionB, created);
      return fulfillJson(route, { command_id: body.command_id,
        committed_at: "2026-10-30T00:00:00Z",
        result: { ...sessionDto(created), session_id: created.id } }, 201);
    }
    const budgetMatch = /\/assist-sessions\/([^/]+)\/context-budget$/u.exec(path);
    if (budgetMatch !== null && method === "POST") {
      const target = sessions.get(budgetMatch[1]!);
      if (target === undefined) return fulfillJson(route, { code: "RESOURCE_NOT_FOUND" }, 404);
      target.tokens = Number(body.context_budget_tokens);
      target.revision += 1;
      return fulfillJson(route, { command_id: body.command_id,
        committed_at: "2026-10-30T00:00:00Z", result: { session_id: target.id,
          context_budget_tokens: target.tokens, revision: String(target.revision) } });
    }
    const usageMatch = /\/assist-sessions\/([^/]+)\/context-usage$/u.exec(path);
    if (usageMatch !== null) {
      const target = sessions.get(usageMatch[1]!);
      if (target === undefined) return fulfillJson(route, { code: "RESOURCE_NOT_FOUND" }, 404);
      return fulfillJson(route, { session_id: target.id,
        budget: { tokens: target.tokens, revision: String(target.revision) },
        last_call: target.hasMessages ? { source: "MODEL_CALL",
          call_id: "cccc3333-3333-4333-8333-333333333333",
          message_id: "dddd0000-0000-4000-8000-00000000000d", provider: "openai-compatible",
          model: "gpt-4.1-mini", status: "COMPLETED", input_tokens: 10_607, output_tokens: 646,
          cache_read_tokens: null, cache_creation_tokens: null, reserved_tokens: 524_288,
          settled_at: "2026-10-30T00:00:00Z", breakdown: null } : null });
    }
    const messagesMatch = /\/assist-sessions\/([^/]+)\/messages$/u.exec(path);
    if (messagesMatch !== null) {
      if (method === "POST") return fulfillJson(route, { command_id: body.command_id,
        committed_at: "2026-10-30T00:00:00Z", result: { session_id: messagesMatch[1]!,
          user_message_id: "eeee0000-0000-4000-8000-00000000000e", assistant_message_id: null,
          chat_mode: "CHAT", goal_id: null } }, 202);
      return fulfillJson(route, { items: messagesMatch[1] === sessionA ? [
        messageDto("11110000-0000-4000-8000-000000000001", "USER", "1", "帮我看一下上下文用量"),
        messageDto("11110000-0000-4000-8000-000000000002", "ASSISTANT", "2", "读数如下")] : [] });
    }
    const oneMatch = /\/assist-sessions\/([^/]+)$/u.exec(path);
    if (oneMatch !== null) {
      const target = sessions.get(oneMatch[1]!);
      if (target === undefined) return fulfillJson(route, { code: "RESOURCE_NOT_FOUND" }, 404);
      return fulfillJson(route, sessionDto(target));
    }
    return fulfillJson(route, { items: [], next_cursor: null });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("acceptance-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" })
    .waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

async function openFromA(page: Page, width = 1162, height = 782): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto(`/agent?work=${taskId}&session=${sessionA}`);
  await connect(page);
  await page.getByTestId("collab-conversation-toolbar").waitFor({ timeout: 20_000 });
}

async function openBlankMeter(page: Page): Promise<void> {
  await page.getByTestId("assist-context-meter").first().click();
  await expect(page.getByTestId("assist-context-meter-panel")).toBeVisible();
}

test("截图 1：从 A（512K）新建，空白会话就显示 512K", async ({ page }) => {
  await installStatefulServer(page);
  await openFromA(page);
  await page.getByTestId("context-new-conversation").click();
  await page.getByTestId("assist-first-draft").waitFor({ timeout: 20_000 });
  await openBlankMeter(page);
  const panel = page.getByTestId("assist-context-meter-panel");
  await expect(panel.getByTestId("context-budget-option-524288")).toBeChecked();
  await expect(panel.getByTestId("context-usage-tier-state")).toContainText("继承来源会话：512K");
  await page.screenshot({ path: `${out}/01-A512K-new-blank-inherits-512K.png`, fullPage: true });
});

test("截图 2：B 建出来后当前生效就是 512K", async ({ page }) => {
  await installStatefulServer(page);
  await openFromA(page);
  await page.getByTestId("context-new-conversation").click();
  await page.getByTestId("assist-first-draft").waitFor({ timeout: 20_000 });
  page.on("console", (m) => console.log("CONSOLE " + m.type() + " " + m.text()));
  page.on("response", (res) => { if (res.url().includes("/assist-sessions")) console.log("RESP " + res.status() + " " + res.request().method() + " " + res.url()); });
  await page.getByTestId("assist-first-draft").fill("新建一段讨论");
  await page.getByTestId("assist-first-send").click();
  // 建会话后界面把 B 当成当前会话，但地址行不跟着改（本轮不改这块）；
  // 直接以 B 的深链接重新打开，断言的是服务端那一行档位。
  await page.goto(`/agent?work=${taskId}&session=${sessionB}`);
  await connect(page);
  await page.getByTestId("assist-composer").waitFor({ timeout: 20_000 });
  await page.getByTestId("assist-composer").getByTestId("assist-context-meter").click();
  const panel = page.getByTestId("assist-context-meter-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("context-budget-option-524288")).toBeChecked();
  await expect(panel.getByTestId("context-usage-tier-state")).toContainText("当前生效：512K");
  await page.screenshot({ path: `${out}/02-B-created-512K.png`, fullPage: true });
});

test("截图 3：B 未发送改成 1024K 后从 A 新建 C，C 仍是 512K", async ({ page }) => {
  await installStatefulServer(page);
  await openFromA(page);
  await page.getByTestId("context-new-conversation").click();
  await page.getByTestId("assist-first-draft").waitFor({ timeout: 20_000 });
  await openBlankMeter(page);
  const panel = page.getByTestId("assist-context-meter-panel");
  await panel.getByTestId("context-budget-option-1048576").check();
  await expect(panel.getByTestId("context-usage-tier-state")).toContainText("已选 1024K");
  await page.screenshot({ path: `${out}/03a-B-blank-unsaved-1024K.png`, fullPage: true });
  // 不回发、不保存：直接回 A 再新建一条（C）。
  await page.goBack();
  await page.getByTestId("collab-conversation-toolbar").waitFor({ timeout: 20_000 });
  await page.getByTestId("context-new-conversation").click();
  await page.getByTestId("assist-first-draft").waitFor({ timeout: 20_000 });
  await openBlankMeter(page);
  const cPanel = page.getByTestId("assist-context-meter-panel");
  await expect(cPanel.getByTestId("context-budget-option-524288")).toBeChecked();
  await expect(cPanel.getByTestId("context-budget-option-1048576")).not.toBeChecked();
  await expect(cPanel.getByTestId("context-usage-tier-state")).toContainText("继承来源会话：512K");
  await page.screenshot({ path: `${out}/03b-C-after-B-unsaved-1024K-still-512K.png`, fullPage: true });
});

test("截图 4：560px 窄窗三档仍在一行、浮层不压输入卡", async ({ page }) => {
  await installStatefulServer(page);
  await openFromA(page, 560, 700);
  await page.getByTestId("assist-composer").getByTestId("assist-context-meter").click();
  const panel = page.getByTestId("assist-context-meter-panel");
  await expect(panel).toBeVisible();
  const tops = await panel.getByTestId("context-usage-tiers").locator("label").evaluateAll((nodes) =>
    nodes.map((node) => Math.round(node.getBoundingClientRect().top)));
  expect(new Set(tops).size, "三档必须横排").toBe(1);
  await page.screenshot({ path: `${out}/04-narrow-560-tiers-in-one-row.png`, fullPage: true });
});