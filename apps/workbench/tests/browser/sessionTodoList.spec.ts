import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * 会话待办清单的真实 Chromium 渲染证据（ADR-038，2026-10-30）。
 *
 * 只楼页面夹具：不连数据库、不调模型、不写任何真实业务事实。
 * 目的是把折叠/展开、长清单 + 短窗口下输入器仍可用这三种状态落成图片，
 * 供人工验收比对（jsdom 组件测试管行为，这里管视觉与几何）。
 */

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const sessionId = "66666666-6666-4666-8666-666666666666";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = "http://127.0.0.1:4173";
const shotDir = "D:/Develop/Relay-Agent/acceptance-2026-10-30/03-Agent-Todo-List实现";

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(),
    body: JSON.stringify(body) });
}

const session = { id: sessionId, workspace_id: workspaceId, project_id: projectId, task_id: taskId,
  title: "待办清单验收会话", status: "ACTIVE", revision: "1",
  working_resource_id: "99999999-9999-4999-8999-999999999999",
  context: { project_goals: [], working_directory: {
    resource_id: "99999999-9999-4999-8999-999999999999", canonical_root: "D:\\Work\\Research" } },
  created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z" };

const userMessage = { id: "aaaa1111-1111-4111-8111-111111111111", session_id: sessionId,
  role: "USER", status: "COMPLETED", seq: "1", intent: "DISCUSS", content: "帮我把这个改造做完",
  error_code: null, provider_error_kind: null, cancel_requested: false, steer_requested: false,
  usage: { input_tokens: null, output_tokens: null, cache_read_tokens: null,
    cache_creation_tokens: null }, sources: [], skill: null, skill_input: null, skill_output: null,
  attachments: [], created_at: "2026-10-30T00:00:00Z", updated_at: "2026-10-30T00:00:00Z",
  revision: "1" };

const assistantMessage = { ...userMessage, id: "bbbb2222-2222-4222-8222-222222222222",
  role: "ASSISTANT", seq: "2", content: "先列个待办，再逐步推进。" };

const shortItems = [
  { id: "i1", content: "读取执行契约与现有约束", status: "completed" },
  { id: "i2", content: "实现 todo_write 与快照投影", status: "in_progress" },
  { id: "i3", content: "跑集成测试与前端回归", status: "pending" },
];

const longItems = Array.from({ length: 16 }, (_v, index) => ({ id: `i${index}`,
  content: `第 ${index + 1} 步：校验并修复一批边界条件下的行为差异`,
  status: index < 5 ? "completed" : index === 5 ? "in_progress" : "pending" }));

function snapshot(items: readonly { id: string; content: string; status: string }[]) {
  return { snapshot: { sessionId, version: 7, inProgressLimit: 1,
    updatedAt: "2026-10-30T09:00:00.000Z", items } };
}

async function installRoutes(page: Page, state: { items: readonly { id: string; content: string; status: string }[] | null },
  items: readonly { id: string; content: string; status: string }[]): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/tasks/${taskId}`) return fulfillJson(route, { id: taskId,
      project_id: projectId, title: "会话待办验收", status: "IN_PROGRESS", mode: "ME",
      revision: "2", created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z",
      executor: { kind: "HUMAN", run_id: null, ownership_epoch: "1" },
      current_completion_id: null, waiting_reason: null, blocking_task_ids: [],
      unresolved_blocker_ids: [], allowed_actions: [],
      acceptance: { acceptance_revision: "2", objective: "待办清单可用", source: "CREATE",
        created_at: "2026-10-16T00:00:00Z", criteria: [] }, dependencies: [] });
    if (path === `${prefix}/projects/${projectId}`) return fulfillJson(route, { id: projectId,
      title: "验收项目", project_type: "GENERAL", revision: "1", state_revision: "1",
      archived_at: null });
    if (path === `${prefix}/search`) return fulfillJson(route, { items: [], next_cursor: null });
    if (path === `${prefix}/default-working-directory`) return fulfillJson(route,
      { resource_id: null, canonical_root: null, display_name: null, write_tier: null,
        default_write_tier: null, context_budget_tokens: null, status: "UNSET", reason: null,
        revision: "0" });
    if (path === `${prefix}/model-port`) return fulfillJson(route, { provider: "openai-compatible",
      configured: true, model: "gpt-4.1-mini", base_url: null, max_call_tokens: 65_536 });
    if (path === `${prefix}/assist-sessions`) return fulfillJson(route, { items: [session] });
    if (path === `${prefix}/assist-sessions/${sessionId}`) return fulfillJson(route, session);
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return fulfillJson(route,
      { items: [userMessage, assistantMessage] });
    if (path === `${prefix}/assist-sessions/${sessionId}/todos`) {
      return fulfillJson(route, state.items === null ? { snapshot: null } : snapshot(state.items));
    }
    if (path === `${prefix}/skill-definitions`) return fulfillJson(route, { items: [] });
    return fulfillJson(route, { items: [], next_cursor: null });
  });
}

async function openSession(page: Page, expectPanel = true): Promise<void> {
  await page.goto(`/agent?work=${taskId}&session=${sessionId}`);
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("session-todo-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" })
    .waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
  await page.getByTestId("collab-conversation-toolbar").waitFor({ timeout: 20_000 });
  if (expectPanel) await page.getByTestId("session-todo-list").waitFor({ timeout: 20_000 });
  else await page.getByTestId("assist-composer").waitFor({ timeout: 20_000 });
}

test("待办清单：折叠一行、展开全部，长清单短窗口下输入器仍可用", async ({ page }) => {
  await page.setViewportSize({ width: 1162, height: 782 });
  await installRoutes(page, { items: shortItems });
  await openSession(page);

  const list = page.getByTestId("session-todo-list");
  // 默认收起：只给数量与当前步骤，不把整张清单摊开。
  expect(await list.evaluate((node) => node.hasAttribute("open"))).toBe(false);
  await expect(list).toContainText("已完成 1/3");
  await expect(list).toContainText("实现 todo_write 与快照投影");
  await page.screenshot({ path: `${shotDir}/01-todo-collapsed.png` });

  // 展开：三项全列，状态可辨，声明不代表验收结论。
  await list.locator("summary").click();
  await expect(list.locator("[data-testid='session-todo-item']")).toHaveCount(3);
  await expect(list).toContainText("不代表执行结果或验收结论");
  await page.screenshot({ path: `${shotDir}/02-todo-expanded.png` });
});

test("长清单 + 短窗口：清单内部滚动，输入器不被顶出视窗", async ({ page }) => {
  const state: { items: readonly { id: string; content: string; status: string }[] | null } =
    { items: null };
  await page.setViewportSize({ width: 1000, height: 420 });
  await installRoutes(page, state);
  await openSession(page, false);

  const composer = page.getByTestId("assist-composer");
  const baseline = await composer.boundingBox();
  const baselineBottom = Math.round((baseline?.y ?? 0) + (baseline?.height ?? 0));
  console.log(`[todo] 无清单时的输入器底部 = ${baselineBottom}（视窗 420）`);

  // 换成 16 项长清单，重新加载同一个会话。
  state.items = longItems;
  await page.reload();
  await openSession(page);
  const list = page.getByTestId("session-todo-list");
  await list.locator("summary").click();
  await expect(list.locator("[data-testid='session-todo-item']")).toHaveCount(16);

  const expanded = await composer.boundingBox();
  const expandedBottom = Math.round((expanded?.y ?? 0) + (expanded?.height ?? 0));
  const listBox = await list.boundingBox();
  console.log(`[todo] 16 项展开后：清单高 ${Math.round(listBox?.height ?? 0)}，输入器底部 = ${expandedBottom}`);

  // 待办面板不得把输入器向下推：底部不超基线（容差 2px）。
  expect(expandedBottom).toBeLessThanOrEqual(baselineBottom + 2);
  // 清单自身限高：16 项不得整排撑开。
  expect(Math.round(listBox?.height ?? 0)).toBeLessThan(420);
  await page.screenshot({ path: `${shotDir}/03-todo-long-short-window.png` });
});