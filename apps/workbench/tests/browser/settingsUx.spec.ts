import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * SETTINGS-UX-01：设置中心四组信息架构、默认目录失效态与窄窗布局。
 *
 * API 全部由 page.route 伪造；这里核对界面事实、发出的只读请求与真实渲染的截图，
 * 不把浏览器证据当作服务端 CAS 或真实 Provider 证据。
 */

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = `http://127.0.0.1:${process.env.RELAY_E2E_PORT ?? "4173"}`;
const fingerprint = "a".repeat(64);
const missingRoot = "C:\\Users\\ASUS\\AppData\\Local\\Temp\\relay-agent-file-crud-20261017-093012";

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(),
    body: JSON.stringify(body) });
}

type DirectoryState = {
  resource_id: string | null;
  canonical_root: string | null;
  display_name: string | null;
  write_tier: string | null;
  default_write_tier: string | null;
  context_budget_tokens: number | null;
  status: "UNSET" | "READY" | "UNAVAILABLE";
  reason: string | null;
  revision: string;
};

function unavailableDirectory(): DirectoryState {
  return { resource_id: "870f8eeb-091f-4083-b775-ff2f32836a81",
    canonical_root: missingRoot, display_name: "relay-agent-file-crud-20261017-093012",
    write_tier: "READ_ONLY", default_write_tier: null, context_budget_tokens: 1048576,
    status: "UNAVAILABLE", reason: "DIRECTORY_UNAVAILABLE", revision: "4" };
}

function readyDirectory(): DirectoryState {
  return { resource_id: "8e752911-ec84-41b9-95cf-173028665b66",
    canonical_root: "D:\\Develop\\Relay-Agent", display_name: "Relay-Agent",
    write_tier: "READ_ONLY", default_write_tier: null, context_budget_tokens: 1048576,
    status: "READY", reason: null, revision: "5" };
}

function verification() {
  const last = { ok: true, latency_ms: 42, provider: "openai-compatible", model: "gpt-test",
    config_fingerprint: fingerprint, error_category: null,
    verified_at: "2026-10-31T10:00:00.000Z" };
  return { target: "default", connection: "default", model: "gpt-test",
    current_config_fingerprint: fingerprint, last, target_last: last,
    matches_current_config: true, credential_identity: "MATCH", state: "VERIFIED",
    worker_startup_validation: "OK" };
}

function pack(id: string, version: string, availability: string) {
  return { id, version, sha256: "e".repeat(64), title: id, host_contract: "relay-v1",
    availability, members: [{ kind: "SKILL", id: "project-resume", version: "1.0.0",
      sha256: "a".repeat(64), target: "PROJECT", availability: "CALLABLE_READ_ONLY",
      required_capabilities: [], missing_capabilities: [], accept_supported: false }] };
}

async function installRoutes(page: Page, directory: { current: DirectoryState },
  counts: { directoryReads: number }): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/model-port`) return fulfillJson(route, { provider: "openai-compatible",
      configured: true, model: "gpt-test", base_url: "https://api.example.com/v1",
      max_call_tokens: 1_048_576, image_input: "SUPPORTED", image_input_source: "CATALOG" });
    if (path === `${prefix}/model-port/verification`) return fulfillJson(route, verification());
    if (path === `${prefix}/memory-settings`) return fulfillJson(route, { workspace_id: workspaceId,
      revision: "2", recall_enabled: true, automatic_compaction: true, auto_capture: true });
    if (path === `${prefix}/packs`) return fulfillJson(route, { items: [
      pack("thesis-minimal", "1.2.0", "AVAILABLE"),
      pack("development-minimal", "1.2.0", "AVAILABLE"),
      pack("thesis-minimal", "1.0.0", "HISTORICAL_ONLY") ] });
    if (path === `${prefix}/default-working-directory` && method === "GET") {
      counts.directoryReads += 1;
      return fulfillJson(route, directory.current);
    }
    if (path.endsWith("/attention/interventions")) return fulfillJson(route, { items: [] });
    return fulfillJson(route, { items: [], next_cursor: null });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("settings-ux-fake-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

async function screenshot(page: Page, name: string): Promise<void> {
  // 页壳自己滚动；展开诊断后滚动位置会改变，截图前先回到页头，保证每张图从同一阅读起点开始。
  await page.getByTestId("settings-page-head").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `../../tmp/SETTINGS-UX-01/screenshots/${name}.png`, fullPage: true });
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const scroller = document.scrollingElement ?? document.documentElement;
    return Math.max(scroller.scrollWidth - scroller.clientWidth,
      document.body.scrollWidth - document.body.clientWidth);
  });
  expect(overflow, "设置页不允许水平溢出").toBeLessThanOrEqual(1);
}

test("四组设置、失效默认目录、恢复与窄窗截图", async ({ page }) => {
  const directory = { current: unavailableDirectory() };
  const counts = { directoryReads: 0 };
  await installRoutes(page, directory, counts);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings", { waitUntil: "domcontentloaded" });
  await connect(page);

  await expect(page.getByTestId("settings-page")).toBeVisible();
  const tabs = page.getByRole("tab");
  await expect(tabs).toHaveCount(4);
  await expect(page.getByTestId("settings-group-basic")).toHaveText("通用设置");
  await expect(page.getByTestId("settings-group-model")).toHaveText("AI 与模型");
  await expect(page.getByTestId("settings-group-execution")).toHaveText("权限与执行");
  await expect(page.getByTestId("settings-group-workbench")).toHaveText("工作台");

  // 通用设置：失效目录的主状态只给结论，技术字段收在折叠诊断里。
  await expect(page.getByTestId("settings-default-directory-value")).toContainText("默认目录不可用");
  await expect(page.getByTestId("settings-default-directory-value")).not.toContainText("DIRECTORY_UNAVAILABLE");
  await expect(page.getByTestId("settings-default-directory-unavailable"))
    .toContainText("新会话不会继续使用该目录");
  await expect(page.getByTestId("settings-default-directory-choose")).toHaveText(/更换目录/u);
  // 失效态的主操作必须比次操作更显眼；不是四颗同权按钮。
  await expect(page.getByTestId("settings-default-directory-choose")).toHaveClass(/primary-button/u);
  await expect(page.getByTestId("settings-default-directory-clear")).toHaveText(/清除默认目录/u);
  await expect(page.getByTestId("settings-default-directory-recheck")).toHaveText(/重新检查/u);
  const diagnostics = page.getByTestId("settings-default-directory-diagnostics");
  expect(await diagnostics.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false);
  await diagnostics.locator("summary").click();
  await expect(diagnostics).toContainText("DIRECTORY_UNAVAILABLE");
  await expect(diagnostics).toContainText(missingRoot);
  await diagnostics.locator("summary").click();
  await screenshot(page, "general-unavailable-1440");

  // 重新检查只重读服务端投影；目录恢复后主状态立即回到「有效」。
  directory.current = readyDirectory();
  const before = counts.directoryReads;
  await page.getByTestId("settings-default-directory-recheck").click();
  await expect.poll(() => counts.directoryReads).toBe(before + 1);
  await expect(page.getByTestId("settings-default-directory-value")).toContainText("有效");
  await screenshot(page, "general-recovered-1440");

  // AI 与模型：当前状态 → 模型连接 → 上下文 → 记忆 → 高级诊断。
  await page.getByTestId("settings-group-model").click();
  await expect(page.getByTestId("settings-ai-scope")).toContainText("会话聊天使用的模型在对话输入器里选择");
  await expect(page.getByTestId("service-state")).toBeVisible();
  await expect(page.getByTestId("model-connections")).toBeVisible();
  await expect(page.getByTestId("model-connections")).not.toContainText("验证通过");
  const advanced = page.getByTestId("settings-model-advanced");
  expect(await advanced.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false);
  await expect(advanced.locator("summary")).toHaveText("高级诊断与能力声明");
  const order = await page.locator('[role="tabpanel"]:not([hidden]) > section.settings-card > h2')
    .allTextContents();
  expect(order).toEqual(["连接与模型状态", "模型连接", "上下文长度", "长期与短期记忆"]);
  await screenshot(page, "ai-1440");

  // 权限与执行：只读真实状态与入口，不提供无作用域全局开关。
  await page.getByTestId("settings-group-execution").click();
  await expect(page.getByTestId("execution-permissions")).toContainText("当前执行权限");
  await expect(page.getByTestId("execution-current-write-tier")).toContainText("只读");
  await expect(page.getByTestId("execution-default-write-tier")).toContainText("未设置");
  await expect(page.getByTestId("execution-permissions")).toContainText("打开连接与权限");
  await expect(page.getByTestId("execution-permissions").getByRole("link", { name: "打开连接与权限" }))
    .toHaveAttribute("href", "/connections");
  await expect(page.getByTestId("settings-pending-preferences")).toContainText("暂不可修改");
  await screenshot(page, "permissions-1440");

  // 工作台：默认视图与只读 Pack 清单；协议与 hash 默认折叠。
  await page.getByTestId("settings-group-workbench").click();
  await expect(page.getByTestId("settings-workbench-preferences")).toBeVisible();
  await expect(page.getByTestId("pack-catalog")).toContainText("thesis-minimal");
  expect(await page.getByTestId("pack-catalog-advanced")
    .evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false);
  await expect(page.getByTestId("pack-catalog")).toContainText("不会授权工具");
  await screenshot(page, "workbench-1440");

  // 键盘导航：方向键与 Home/End 移动选中与焦点。
  await page.getByTestId("settings-group-workbench").focus();
  await page.keyboard.press("Home");
  await expect(page.getByTestId("settings-group-basic")).toHaveAttribute("aria-selected", "true");
  expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")))
    .toBe("settings-group-basic");
  await page.keyboard.press("End");
  await expect(page.getByTestId("settings-group-workbench")).toHaveAttribute("aria-selected", "true");

  // 窄窗：单列/两列折叠，无水平溢出；四个页签都能到达。
  await page.setViewportSize({ width: 760, height: 900 });
  for (const [group, name] of [["basic", "general-narrow-760"], ["model", "ai-narrow-760"],
    ["execution", "permissions-narrow-760"], ["workbench", "workbench-narrow-760"]] as const) {
    await page.getByTestId(`settings-group-${group}`).click();
    await expectNoHorizontalOverflow(page);
    await screenshot(page, name);
  }
  await page.getByTestId("settings-group-basic").click();
  await expectNoHorizontalOverflow(page);
  expect(await page.evaluate(() => {
    const details = document.querySelector('[data-testid="settings-default-directory-diagnostics"]');
    return (details as HTMLDetailsElement | null)?.open ?? false;
  })).toBe(false);
});
