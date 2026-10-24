// 临时脚本：量近期工作栏行高与行内留白（改前/改后对照）。用完删除。
import { chromium } from "@playwright/test";

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = "http://127.0.0.1:4174";
const projectA = "22222222-2222-4222-8222-222222222222";
const projectB = "22222222-2222-4222-8222-222222222223";

function cors() {
  return { "access-control-allow-origin": origin, "access-control-allow-headers": "Authorization, Content-Type" };
}
async function fulfillJson(route, body) {
  await route.fulfill({ status: 200, contentType: "application/json", headers: cors(), body: JSON.stringify(body) });
}
function task(id, projectId, title, updatedAt) {
  return { id, project_id: projectId, title, status: "READY", mode: "ME", revision: "1",
    executor: { kind: "HUMAN", run_id: null }, current_completion_id: null, waiting_reason: null,
    blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [], dependencies: [], updated_at: updatedAt };
}
function session(id, projectId, title, updatedAt) {
  return { id, workspace_id: workspaceId, project_id: projectId, task_id: null, title, status: "ACTIVE",
    revision: "1", created_at: updatedAt, updated_at: updatedAt, pinned_at: null, unread_at: null,
    working_resource_id: projectId,
    context: { project_goals: [], working_directory: projectId === null ? null
      : { resource_id: projectId, canonical_root: projectId === projectA ? "D:/thesis/docs" : "D:/relay" } } };
}
function projectRow(id, title) {
  return { id, title, project_type: "GENERAL", revision: "1", state_revision: "1", archive_status: "ACTIVE",
    archived_at: null, phase_key: "GENERAL", next_action_task_id: null,
    created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-11T06:59:00Z" };
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.route(`${apiBase}/**`, async (route) => {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
  if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
  if (path === `${prefix}/tasks`) {
    return fulfillJson(route, { items: [
      task("33333333-3333-4333-8333-333333333331", projectA, "关于Relay-Agent", "2026-10-11T06:59:00Z"),
      task("33333333-3333-4333-8333-333333333332", projectB, "Windows桌面验收 2026", "2026-10-07T04:07:00Z")
    ], next_cursor: null });
  }
  if (path === `${prefix}/projects`) return fulfillJson(route, { items: [projectRow(projectA, "Relay-Agent"), projectRow(projectB, "Windows桌面验收 2026…")], next_cursor: null });
  if (path === `${prefix}/projects/${projectA}`) return fulfillJson(route, projectRow(projectA, "Relay-Agent"));
  if (path === `${prefix}/projects/${projectB}`) return fulfillJson(route, projectRow(projectB, "Windows桌面验收 2026…"));
  if (path === `${prefix}/assist-sessions`) {
    const status = new URL(request.url()).searchParams.get("status");
    if (status === "ARCHIVED") return fulfillJson(route, { items: [] });
    return fulfillJson(route, { items: [session("66666666-6666-4666-8666-666666666661", null, "你好", "2026-10-15T12:09:00Z")], next_cursor: null });
  }
  return fulfillJson(route, { items: [], next_cursor: null });
});
await page.goto("http://127.0.0.1:4174/agent");
await page.getByTestId("relay-connection-open").click();
await page.locator('input[name="relay-base-url"]').fill(apiBase);
await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
await page.locator('input[name="relay-bearer-token"]').fill("measure-token");
await page.getByTestId("relay-connect").click();
await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20000 });
await page.keyboard.press("Escape");
await page.getByTestId("recent-work-tasks").waitFor();

const geometry = await page.evaluate(() => {
  const rect = (selector) => {
    const el = document.querySelector(selector);
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    return { top: +r.top.toFixed(2), bottom: +r.bottom.toFixed(2), height: +r.height.toFixed(2) };
  };
  const dirs = document.querySelector('[data-testid="recent-work-directories"]');
  const lastItem = [...dirs.querySelectorAll(".recent-work-item")].pop();
  const lastTitle = lastItem?.querySelector(".recent-work-title") ?? null;
  const tasks = document.querySelector('[data-testid="recent-work-tasks"]');
  const groups = [...tasks.querySelectorAll(":scope > .recent-work-group")];
  const archived = document.querySelector('[data-testid="recent-work-archived"]');
  const r = (el) => { const b = el.getBoundingClientRect(); return { top: +b.top.toFixed(2), bottom: +b.bottom.toFixed(2), height: +b.height.toFixed(2) }; };
  return {
    item: { box: lastItem ? r(lastItem) : null, title: lastTitle ? r(lastTitle) : null },
    sectionSummary: rect('[data-testid="recent-work-tasks"] > summary'),
    groupSummaries: groups.map((g) => r(g.querySelector(":scope > summary"))),
    archivedSummary: rect('[data-testid="recent-work-archived"] > summary'),
    plusButton: (() => { const b = groups[0]?.querySelector(":scope > .recent-work-group-new"); return b ? { width: +b.getBoundingClientRect().width.toFixed(2), height: +b.getBoundingClientRect().height.toFixed(2) } : null; })()
  };
});
console.log(JSON.stringify(geometry, null, 1));
await browser.close();
