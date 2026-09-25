import { expect, test } from "@playwright/test";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const prefix = `/api/v1/workspaces/${workspaceId}`;

test("真实 Run 的 Bearer SSE 提示触发权威快照，离页不发取消命令", async ({ page }) => {
  let revision = "3";
  let runReads = 0;
  let postCount = 0;
  const eventRequests: { url: string; authorization: string | undefined }[] = [];
  const cors = {
    "access-control-allow-origin": "http://127.0.0.1:4173",
    "access-control-allow-headers": "Authorization, Content-Type",
    "access-control-allow-methods": "GET, OPTIONS"
  };
  await page.route(`${baseUrl}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors }); return; }
    if (request.method() === "POST") postCount++;
    const json = async (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify(body) });
    if (url.pathname === "/health/ready") { await json({ status: "ready" }); return; }
    if (url.pathname === `${prefix}/runs/${runId}/events`) {
      eventRequests.push({ url: request.url(), authorization: request.headers().authorization });
      revision = "4";
      await route.fulfill({ status: 200, contentType: "text/event-stream", headers: cors,
        body: 'id: 1\ndata: {"changed":true}\n\n' });
      return;
    }
    if (url.pathname === `${prefix}/runs/${runId}`) {
      runReads++;
      await json({
        id: runId, task_id: taskId, status: "RUNNING", revision, ownership_epoch: "1", retry_of_run_id: null,
        current_step_id: null, wait_reason: null, created_at: "2026-09-24T00:00:00.000Z",
        updated_at: "2026-09-24T00:01:00.000Z", terminal_at: null,
        contract: { workflow_key: "markdown-deliverable-v1", workflow_version: "1", execution_config_version: "1", acceptance_revision: "1", contract_hash: "a".repeat(64) },
        current_step: null, steps: [], recent_attempts: [], result_refs: [], blocking_review_ids: [],
        pending_control_request: null, unresolved_operation_ids: []
      });
      return;
    }
    if (url.pathname === `${prefix}/tasks/${taskId}`) {
      await json({
        id: taskId, project_id: null, title: "浏览器事件任务", status: "IN_PROGRESS", mode: "DELEGATE_AI",
        revision: "4", executor: { kind: "AI", run_id: runId, ownership_epoch: "1" },
        current_completion_id: null, waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
        acceptance: { acceptance_revision: "1", objective: "可核对结果", source: "CREATE", criteria: [] }, dependencies: []
      });
      return;
    }
    if (url.pathname === `${prefix}/runs/${runId}/reviews`) { await json({ items: [] }); return; }
    if (url.pathname === `${prefix}/runs/${runId}/context-manifests`) {
      await json({ items: [], build: { status: "NOT_STARTED", reason_code: null, message: null } });
      return;
    }
    await route.fulfill({ status: 404, contentType: "application/json", headers: cors, body: '{"code":"NOT_FOUND"}' });
  });

  await page.goto(`/runs/${runId}`);
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("browser-test-token");
  await page.getByTestId("relay-connect").click();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.getByTestId("run-detail")).toContainText("Run 修订 v4");
  expect(runReads).toBeGreaterThanOrEqual(2);
  expect(eventRequests[0]?.url).toBe(`${baseUrl}${prefix}/runs/${runId}/events?after=0`);
  expect(eventRequests[0]?.url).not.toContain("browser-test-token");
  expect(eventRequests[0]?.authorization).toBe("Bearer browser-test-token");
  await page.getByRole("link", { name: "返回关联任务" }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${taskId}$`));
  expect(postCount).toBe(0);
});
