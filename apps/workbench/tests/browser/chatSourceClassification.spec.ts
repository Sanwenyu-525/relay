import { expect, test, type Page, type Route } from "@playwright/test";
import fs from "node:fs";
import { resolve } from "node:path";

/**
 * 来源条按真实来源分类（BUG-CHAT-CONTEXT-CROSS-TALK，2026-11-01）。
 *
 * 旧实现把服务端冻结的 `selection=AUTO_MEMORY` 丢掉，所有来源统一显示「已读取 N 份资料」；
 * 用户只发「你好」时，一条自动召回的记忆因此被读成「你选中了一条资料」。
 * 这里用真实 Chromium 渲染同一条回复（一份手选资料 + 一条自动召回记忆），锁三件事：
 *   * 摘要分别计数：已读取 1 份资料 / 已参考 1 条长期记忆；
 *   * 自动召回行有独立徽牌（含判定依据），手选资料行没有；
 *   * 展开后能读到确切来源引用，不是一句无法核实的统计。
 * API 全部由 page.route 伪造；页面只读，不产生写请求。
 */

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const sessionId = "66666666-6666-4666-8666-666666666666";
const memoryId = "12121212-1212-4212-8212-121212121212";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = `http://127.0.0.1:${process.env.RELAY_E2E_PORT ?? "4173"}`;

/** 证据目录：仓库根 tmp/BUG-CHAT-CONTEXT-CROSS-TALK/screenshots。 */
const shotDir = resolve(import.meta.dirname, "../../../../tmp/BUG-CHAT-CONTEXT-CROSS-TALK/screenshots");

test.setTimeout(120_000);

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(), body: JSON.stringify(body) });
}

function sessionRow(): unknown {
  return { id: sessionId, workspace_id: workspaceId, project_id: projectId, task_id: null,
    title: "来源分类验收", status: "ACTIVE", revision: "1", conversation_mode: "AGENT",
    assistant_profile_id: null, working_resource_id: null,
    created_at: "2026-11-01T10:00:00Z", updated_at: "2026-11-01T10:00:00Z" };
}

function messagesBody(): unknown {
  return { items: [
    { id: "u-1", session_id: sessionId, seq: "1", role: "USER", status: "COMPLETED",
      intent: "DISCUSS", content: "你好", error_code: null, provider_error_kind: null,
      sources: [], skill: null, skill_input: null, skill_output: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: null,
        cache_creation_tokens: null }, cancel_requested: false, attachments: [],
      created_at: "2026-11-01T10:00:00Z", updated_at: "2026-11-01T10:00:00Z" },
    { id: "x-1", session_id: sessionId, seq: "2", role: "ASSISTANT", status: "COMPLETED",
      intent: "DISCUSS", content: "你好。有什么想先聊的？", error_code: null,
      provider_error_kind: null,
      sources: [
        { kind: "KNOWLEDGE", root_id: "k1", version: "1", source_ref: "研究问题清单 v1",
          status: "SENT", reason: null },
        { kind: "MEMORY", root_id: memoryId, version: "1", source_ref: `memory:${memoryId}:v1`,
          status: "SENT", reason: null, origin: "AUTO_CAPTURE",
          selection: "AUTO_MEMORY", selection_basis: "LITERAL_MATCH" }
      ],
      skill: null, skill_input: null, skill_output: null,
      usage: { input_tokens: 1, output_tokens: 2, cache_read_tokens: null,
        cache_creation_tokens: null }, cancel_requested: false, attachments: [],
      created_at: "2026-11-01T10:00:00Z", updated_at: "2026-11-01T10:01:00Z" }] };
}

async function installRoutes(page: Page): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/projects/${projectId}`) return fulfillJson(route, { id: projectId,
      title: "人机协作工作流研究", project_type: "GENERAL", revision: "1", state_revision: "1",
      archived_at: null });
    if (path === `${prefix}/model-port`) return fulfillJson(route, { provider: "fake",
      configured: false, model: null, base_url: null, max_call_tokens: null });
    if (path === `${prefix}/assist-sessions`) return fulfillJson(route, { items: [sessionRow()] });
    if (path === `${prefix}/assist-sessions/${sessionId}`) return fulfillJson(route, sessionRow());
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return fulfillJson(route, messagesBody());
    if (path === `${prefix}/assist-sessions/${sessionId}/plans`) {
      return fulfillJson(route, { latest: null, versions: [] });
    }
    if (path === `${prefix}/assist-sessions/${sessionId}/goal`) {
      return fulfillJson(route, { goal: null, rounds: [] });
    }
    if (path === `${prefix}/conversation-execution-requests`) return fulfillJson(route, { items: [] });
    if (path === `${prefix}/assist-proposals` || path === `${prefix}/skill-definitions`
      || path === `${prefix}/chat-commands`) return fulfillJson(route, { items: [] });
    if (path.startsWith(`${prefix}/learning`)) return fulfillJson(route, { items: [], epoch: "0" });
    if (path === `${prefix}/assist-sessions/${sessionId}/context-usage`) {
      return fulfillJson(route, { session_id: sessionId, budget: { tokens: 262_144, revision: "0" },
        last_call: null });
    }
    return fulfillJson(route, { items: [], next_cursor: null });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("source-classification-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 30_000 });
  await page.keyboard.press("Escape");
}

test("自动召回的记忆与手选资料分别计数并标出依据", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installRoutes(page);
  await page.goto(`/agent?session=${sessionId}&project=${projectId}`);
  await connect(page);
  await page.getByTestId("assist-transcript").waitFor({ timeout: 30_000 });

  const summary = page.locator(".assist-source-summary").first();
  await expect(summary).toBeVisible({ timeout: 30_000 });
  await expect(summary.locator("summary")).toContainText("已读取 1 份资料");
  await expect(summary.locator("summary")).toContainText("已参考 1 条长期记忆");
  await expect(summary).not.toContainText("已读取 2 份资料");

  await summary.locator("summary").click();
  const rows = summary.locator(".assist-source-row");
  await expect(rows).toHaveCount(2);
  const auto = rows.filter({ hasText: `memory:${memoryId}:v1` });
  await expect(auto.locator(".assist-source-selection")).toContainText("自动召回");
  await expect(auto.locator(".assist-source-selection")).toContainText("按字面匹配");
  const manual = rows.filter({ hasText: "研究问题清单 v1" });
  await expect(manual.locator(".assist-source-selection")).toHaveCount(0);

  fs.mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: resolve(shotDir, "source-classification.png"), fullPage: false });
});
