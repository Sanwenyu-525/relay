import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Production API/Worker, real PG and real browser. Only the external Provider
// transport is controlled; page.route never manufactures business responses.
const apiBase = process.env.RELAY_M02_API_BASE_URL;
const workspaceId = process.env.RELAY_M02_WORKSPACE_ID;
const bearerToken = process.env.RELAY_M02_BEARER_TOKEN;
const providerBase = process.env.RELAY_FREE_MODEL_FIXTURE_BASE_URL;
const databaseUrl = process.env.RELAY_DB_URL;

async function connect(page: Page) {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase!);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId!);
  await page.locator('input[name="relay-bearer-token"]').fill(bearerToken!);
  await page.getByTestId("relay-connect").click();
  await expect(page.getByTestId("relay-connection-state")).toContainText("已连接");
  await page.getByRole("dialog", { name: "连接本机 API" }).getByRole("button", { name: "关闭", exact: true }).click();
}

interface ProviderEvidence {
  directoryRequests: number; accountRequests: number;
  calls: { model: string; provider: unknown; hasPaidFallback: boolean }[];
}

function messageEvidence(messageId: string): { calls: { id: string; model: string; status: string;
  usage_input_tokens: number | null; usage_output_tokens: number | null }[]; snapshot: Record<string, unknown> } {
  if (!databaseUrl || !/^[a-f\d-]{36}$/u.test(messageId)) throw new Error("isolated message/database missing");
  const database = new URL(databaseUrl);
  if (database.hostname !== "127.0.0.1" || !/^\/relay_m02_[a-f\d]+$/u.test(database.pathname) || database.password) {
    throw new Error("refusing a database outside this browser runner");
  }
  const psql = fileURLToPath(new URL("../../../../.research/runtime-cache/postgresql-18.6-2/pgsql/bin/psql.exe", import.meta.url));
  const query = `select json_build_object('calls', coalesce((select json_agg(c) from
    (select id, model, status, usage_input_tokens, usage_output_tokens from model_calls
      where assist_message_id='${messageId}'::uuid order by started_at, id) c), '[]'::json),
    'snapshot', model_selection_snapshot) from assist_messages where id='${messageId}'::uuid`;
  return JSON.parse(execFileSync(psql, [databaseUrl, "-w", "-At", "-v", "ON_ERROR_STOP=1", "-c", query], { encoding: "utf8" }));
}

test("免费模型真实界面闭环：首条选 A、上游限流后同消息接 B、逐次零价、修改首选不改历史快照", async ({ page, request }) => {
  if (!apiBase || !workspaceId || !bearerToken || !providerBase) throw new Error("Run scripts/run-real-api-browser.ps1 -Scenario FreeModels");
  const evidence = async (): Promise<ProviderEvidence> => (await request.get(`${providerBase}/evidence`)).json();
  await page.setViewportSize({ width: 480, height: 800 });
  await page.goto("/agent?new=entry");
  await connect(page);
  await page.getByTestId("model-selector-open").click();
  // 2026-10-17 用户指令：模型选择是一个锚定下拉，不是居中弹窗。
  const menu = page.getByTestId("model-selector-menu");
  await expect(menu.getByText("最近成功同步：", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await menu.screenshot({ path: test.info().outputPath("free-model-menu.png") });
  await expect.poll(async () => (await evidence()).directoryRequests).toBeGreaterThan(0);
  expect((await evidence()).calls).toHaveLength(0);
  await menu.getByRole("button", { name: "立即刷新", exact: true }).click();
  await expect(menu.getByRole("button", { name: "立即刷新", exact: true })).toBeEnabled();
  expect((await evidence()).calls).toHaveLength(0);
  await expect(menu.getByRole("option", { name: "Controlled free A · fixture/a:free", exact: true })).toBeVisible();
  await menu.getByRole("option", { name: "Controlled free A · fixture/a:free", exact: true }).click();
  await expect(page.getByTestId("model-selector-open")).toContainText("Controlled free A");
  await expect(menu).toHaveCount(0);
  expect((await evidence()).calls).toHaveLength(0);
  await page.getByTestId("assist-first-draft").fill("Controlled acceptance. Reply with the synthetic success marker.");
  const accepted = page.waitForResponse((response) => response.request().method() === "POST" &&
    /\/assist-sessions\/[^/]+\/messages$/u.test(new URL(response.url()).pathname) && response.status() === 202);
  await page.getByTestId("assist-first-send").click();
  const acceptedResponse = await accepted;
  const receipt = await acceptedResponse.json();
  expect(acceptedResponse.request().postDataJSON().expected_model_selection_revision).toMatch(/^[1-9]\d*$/u);
  const sessionId = receipt.result.session_id as string;
  const messageId = receipt.result.assistant_message_id as string;
  await expect(page.getByTestId("assist-transcript")).toContainText("RELAY_CONTROLLED_OK", { timeout: 30_000 });
  const wire = await evidence();
  expect(wire.calls.map((call) => call.model)).toEqual(["fixture/a:free", "fixture/b:free"]);
  expect(wire.accountRequests).toBeGreaterThan(0);
  for (const call of wire.calls) {
    expect(call.provider).toMatchObject({ max_price: { prompt: 0, completion: 0, request: 0, image: 0 },
      allow_fallbacks: false, require_parameters: true });
    expect(call.hasPaidFallback).toBe(false);
  }
  const before = messageEvidence(messageId);
  expect(before.calls.map((call) => [call.model, call.status])).toEqual([
    ["fixture/a:free", "FAILED"], ["fixture/b:free", "COMPLETED"]]);
  expect(new Set(before.calls.map((call) => call.id)).size).toBe(2);
  expect(before.calls[0]?.usage_input_tokens).toBeNull();
  expect(before.calls[1]?.usage_input_tokens).toBe(11);
  expect(before.calls[1]?.usage_output_tokens).toBe(7);
  const runtimeResponse = await request.get(`${apiBase}/api/v1/workspaces/${workspaceId}/assist-messages/${messageId}/model-runtime`,
    { headers: { authorization: `Bearer ${bearerToken}` } });
  expect(runtimeResponse.status()).toBe(200);
  const runtime = await runtimeResponse.json();
  expect(runtime).toMatchObject({ snapshot_available: true, preferred_model: "fixture/a:free",
    actual_model: "fixture/b:free", candidate_models: ["fixture/a:free", "fixture/b:free", "fixture/c:free"] });
  expect(runtime.calls).toHaveLength(2);
  expect(runtime.switches).toMatchObject([{ from_model: "fixture/a:free", to_model: "fixture/b:free" }]);
  expect(runtimeResponse.headers()["content-type"]).toContain("application/json");
  expect(JSON.stringify(runtime)).not.toMatch(/synthetic-free-model-browser|config_fingerprint|authorization|system_prompt/u);
  // 消息行不再展示「本条首选 / 实际调用 / 模型尝试与用量」块（2026-10-19 用户指令删除），
  // 调用事实只经上面的 model-runtime 投影核对。
  await expect(page.getByTestId("assist-model-runtime")).toHaveCount(0);
  await page.getByTestId("model-selector-open").click();
  await expect(menu).toContainText("当前首选：fixture/a:free");
  await menu.getByRole("option", { name: "Controlled free B · fixture/b:free", exact: true }).click();
  await expect(page.getByTestId("model-selector-open")).toContainText("Controlled free B");
  // 会话内点条目即按既有模型选择命令应用并收起：不再有「应用到后续消息」第二步（§27.5）。
  await expect(menu).toHaveCount(0);
  await expect.poll(async () => {
    const response = await request.get(`${apiBase}/api/v1/workspaces/${workspaceId}/assist-sessions/${sessionId}/model-selection`,
      { headers: { authorization: `Bearer ${bearerToken}` } });
    return (await response.json()).selection?.model;
  }).toBe("fixture/b:free");
  expect(messageEvidence(messageId).snapshot).toEqual(before.snapshot);
  expect((await evidence()).calls).toHaveLength(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("free-model-controlled.png"), fullPage: true });
});
