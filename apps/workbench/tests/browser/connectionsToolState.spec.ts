import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * 「可以用的工具」状态准确性（PLUGIN-P0-01，2026-11-01）。
 *
 * 这一轮修的是**状态语义**，所以浏览器里要看的是：同一份插件配置下，界面显示的状态
 * 与服务端结论一致，且「只有读取权限」不会被读成「整个插件都能做动作」。
 *
 * 只连页面内夹具：不连数据库、不调 Provider、不写任何真实业务事实。夹具里的
 * `tool-availability` 响应是服务端真实口径（由 API 单测与集成测试各自锁定），
 * 这里验证的是界面呈现与色调，不是重新判一遍权限。
 */

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const resourceId = "44444444-4444-4444-8444-444444444444";
const connectionId = "33333333-3333-4333-8333-333333333333";
const policyId = "55555555-5555-4555-8555-555555555555";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = `http://127.0.0.1:${process.env.RELAY_E2E_PORT ?? "4173"}`;
const shots = "D:/Develop/Relay-Agent/tmp/PLUGIN-P0-consistency";

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(),
    body: JSON.stringify(body) });
}

const created = "2026-11-01T00:00:00Z";

function counts(partial: Partial<Record<"total" | "auto" | "needs_approval" | "site_scoped"
  | "not_authorized" | "denied" | "unavailable", number>>) {
  return { total: 7, auto: 0, needs_approval: 0, site_scoped: 0, not_authorized: 0,
    denied: 0, unavailable: 0, ...partial };
}

/** 场景一：只授权 read_file + 电脑只授权截图 + gh 没装。 */
function readOnlyScenario() {
  return [
    { tool: "files", state: "READ_ONLY",
      detail: "只有读取类动作已授权，操作类动作未授权（1/7 个动作已授权）。",
      counts: counts({ auto: 1, not_authorized: 6 }) },
    { tool: "git", state: "NOT_AUTHORIZED",
      detail: "连接有效，但没有任何匹配当前目标的生效策略；默认拒绝仍然生效。",
      counts: counts({ not_authorized: 3 }) },
    { tool: "web", state: "NOT_CONFIGURED", detail: "本项目还没有登记这项能力的连接。",
      counts: counts({ unavailable: 1 }) },
    { tool: "cli", state: "NOT_CONFIGURED", detail: "本项目还没有登记这项能力的连接。",
      counts: counts({ unavailable: 3 }) },
    { tool: "computer", state: "READ_ONLY",
      detail: "只有读取类动作已授权，操作类动作未授权（2/11 个动作已授权）。",
      counts: { total: 11, auto: 2, needs_approval: 0, site_scoped: 0, not_authorized: 9,
        denied: 0, unavailable: 0 } },
    { tool: "browser", state: "NOT_CONFIGURED", detail: "本项目还没有登记这项能力的连接。",
      counts: counts({ total: 12, unavailable: 12 }) },
    { tool: "github", state: "RUNTIME_UNAVAILABLE",
      detail: "本机运行时不可用：没有找到可执行的 GitHub CLI（gh）。",
      counts: counts({ total: 5, auto: 5 }) },
  ];
}

/** 场景二：连接停用、策略拒绝、动作需审批同时出现。 */
function mixedScenario() {
  return [
    { tool: "files", state: "DISABLED", detail: "连接已停用；重新启用或重新授权前不会执行。",
      counts: counts({ unavailable: 7 }) },
    { tool: "git", state: "DENIED",
      detail: "命中的生效策略为拒绝；拒绝不会被批准或范围授权覆盖。",
      counts: counts({ total: 3, denied: 3 }) },
    { tool: "web", state: "SITE_SCOPED",
      detail: "授权只覆盖部分站点，未覆盖全部站点（1/1 个动作已授权）。",
      counts: counts({ total: 1, site_scoped: 1 }) },
    { tool: "cli", state: "NEEDS_APPROVAL",
      detail: "动作已授权，但每次执行前需要批准（3/3 个动作已授权）。",
      counts: counts({ total: 3, needs_approval: 3 }) },
    { tool: "computer", state: "NEEDS_APPROVAL",
      detail: "动作已授权，但每次执行前需要批准（11/11 个动作已授权）。",
      counts: { total: 11, auto: 2, needs_approval: 9, site_scoped: 0, not_authorized: 0,
        denied: 0, unavailable: 0 } },
    { tool: "browser", state: "PARTIAL",
      detail: "部分动作已授权，其余未授权或已拒绝（5/12 个动作已授权）。",
      counts: counts({ total: 12, auto: 4, needs_approval: 1, not_authorized: 7 }) },
    { tool: "github", state: "UNKNOWN",
      detail: "策略版本或连接状态无法完整读取，不推断可用。",
      counts: counts({ total: 5 }) },
  ];
}

async function installRoutes(page: Page, options: { readonly items: readonly unknown[];
  readonly connectionStatus: "ACTIVE" | "DISABLED";
  readonly githubRuntime: Record<string, unknown> }): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/projects/${projectId}`) return fulfillJson(route, { id: projectId,
      title: "插件状态验收", project_type: "GENERAL", revision: "1", state_revision: "1",
      archived_at: null });
    if (path === `${prefix}/projects/${projectId}/view-configuration`) return fulfillJson(route,
      { project_id: projectId, revision: "1", kind: "general", template_version: "1",
        template_sha256: "a".repeat(64),
        pages: ["state", "tasks", "artifacts", "reviews"].map((page_id, position) =>
          ({ page_id, visible: true, position })), updated_at: created });
    if (path === `${prefix}/projects/${projectId}/connections`) return fulfillJson(route, [
      { id: connectionId, project_id: projectId, status: options.connectionStatus, version: "1",
        capabilities: ["FILE_READ", "FILE_QUERY", "COMPUTER_READ", "COMPUTER_INPUT", "GITHUB_READ"],
        allowed_host: null, created_at: created }]);
    if (path === `${prefix}/projects/${projectId}/permission-policies`) return fulfillJson(route, [
      { id: policyId, project_id: projectId, status: "ACTIVE", active_version: "1",
        revision: "1", created_at: created }]);
    if (path === `${prefix}/projects/${projectId}/permission-policies/${policyId}/versions`) {
      return fulfillJson(route, [{ version: "1", capability: "FILE_READ", action_type: "READ_FILE",
        target_prefix: "D:\\Work\\Relay", decision: "AUTO", max_payload_bytes: 262144,
        created_at: created }]);
    }
    if (path === `${prefix}/projects/${projectId}/managed-resources`) return fulfillJson(route, [
      { id: resourceId, project_id: projectId, canonical_root: "D:\\Work\\Relay",
        status: "ACTIVE", file_write_root_id: null, resource_epoch: "1", revision: "1",
        file_write_identity_bound: false, created_at: created }]);
    if (path === `${prefix}/projects/${projectId}/tool-availability`) return fulfillJson(route,
      { project_id: projectId, items: options.items });
    // 插件运行时状态挂在 Workspace 作用域下（客户端走 workspacePath），不是根路径。
    if (path === `${prefix}/plugins/status`) return fulfillJson(route, { items: [
      { plugin: "computer", state: "READY", detail: "电脑运行时已就位，可执行截图与输入。",
        remediation: null },
      { plugin: "browser", state: "READY", detail: "浏览器桥接扩展已配对。", remediation: null },
      options.githubRuntime] });
    return fulfillJson(route, { items: [], next_cursor: null });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("plugin-p0-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" })
    .waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

async function openConnections(page: Page): Promise<void> {
  await page.goto(`/projects/${projectId}/connections`);
  await connect(page);
  await page.getByTestId("connections-tools").waitFor({ timeout: 20_000 });
}

function rowText(page: Page, tool: string) {
  return page.getByTestId(`connections-tool-${tool}`).innerText();
}

test("只授权读取时整行是「只读可用」，运行时缺失单独说明，不冒充可用", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await installRoutes(page, { items: readOnlyScenario(), connectionStatus: "ACTIVE",
    githubRuntime: { plugin: "github", state: "NOT_INSTALLED",
      detail: "没有找到可执行的 GitHub CLI（gh）。", remediation: "安装 gh 后重试。" } });
  await openConnections(page);

  // 文件行：只有读取被授权，写入没有——这正是旧实现会错写成「可用」的那一格。
  expect(await rowText(page, "files")).toContain("只读可用");
  expect(await rowText(page, "files")).toContain("只有读取类动作已授权");
  expect(await rowText(page, "files")).not.toContain("可用（");
  // 电脑行同理：只授权截图，不代表能用鼠标键盘。
  expect(await rowText(page, "computer")).toContain("只读可用");
  expect(await rowText(page, "computer")).toContain("操作类动作未授权");
  // GitHub：连接与授权都在，但本机没有 gh。
  expect(await rowText(page, "github")).toContain("本机不可用");
  expect(await rowText(page, "github")).toContain("没有找到可执行的 GitHub CLI");
  expect(await page.getByTestId("connections-tool-runtime-github").innerText()).toContain("未安装");
  // 未配置的一行要给出下一步，而不是只写「未配置」。
  expect(await rowText(page, "web")).toContain("未配置");

  // 色调是可读的第二载体：可用/需审批/拒绝/未知不能同色。
  const tone = (tool: string) => page.getByTestId(`connections-tool-${tool}`)
    .locator(".status-chip").getAttribute("class");
  expect(await tone("files")).toContain("status-chip--warning");
  expect(await tone("github")).toContain("status-chip--danger");
  expect(await tone("web")).toContain("status-chip--neutral");

  await page.getByTestId("connections-tools").screenshot({ path: `${shots}/01-read-only.png` });
  await page.screenshot({ path: `${shots}/01-read-only-page.png`, fullPage: true });
});

test("停用、拒绝、需审批、仅部分站点与无法确认各有自己的状态", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await installRoutes(page, { items: mixedScenario(), connectionStatus: "DISABLED",
    githubRuntime: { plugin: "github", state: "NOT_AUTHENTICATED",
      detail: "GitHub CLI 已安装，但当前没有登录。", remediation: "执行 gh auth login。" } });
  await openConnections(page);

  expect(await rowText(page, "files")).toContain("已停用");
  expect(await rowText(page, "git")).toContain("已拒绝");
  expect(await rowText(page, "web")).toContain("部分站点可用");
  expect(await rowText(page, "cli")).toContain("可用 · 需审批");
  expect(await rowText(page, "computer")).toContain("可用 · 需审批");
  expect(await rowText(page, "browser")).toContain("部分可用");
  // 事实读不全时不能回落成可用。
  expect(await rowText(page, "github")).toContain("状态无法确认");

  const tone = (tool: string) => page.getByTestId(`connections-tool-${tool}`)
    .locator(".status-chip").getAttribute("class");
  expect(await tone("git")).toContain("status-chip--danger");
  expect(await tone("cli")).toContain("status-chip--warning");
  expect(await tone("github")).toContain("status-chip--neutral");

  await page.getByTestId("connections-tools").screenshot({ path: `${shots}/02-mixed-states.png` });
});
