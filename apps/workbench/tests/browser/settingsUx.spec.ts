import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * SETTINGS-UX-01：设置中心五组信息架构、默认目录失效态与窄窗布局。
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

function diagnosticsInventory() {
  return { directory: "D:\\Develop\\Relay-Agent\\.relay-test\\logs", exists: true,
    readable: true, error: null, files: [
      { name: "relay-api.log", process: "api", label: "API 运行日志", rotation: 0,
        exists: true, size_bytes: 4096, modified_at: "2026-11-12T10:00:00.000Z",
        readable: true, error: null },
      { name: "relay-worker.log", process: "worker", label: "Worker 运行日志", rotation: 0,
        exists: true, size_bytes: 2048, modified_at: "2026-11-12T09:59:00.000Z",
        readable: true, error: null },
      { name: "relay-supervisor.log", process: "supervisor", label: "Supervisor 运行日志", rotation: 0,
        exists: false, size_bytes: null, modified_at: null, readable: false, error: null },
      { name: "desktop.log", process: "desktop", label: "桌面宿主日志", rotation: 0,
        exists: false, size_bytes: null, modified_at: null, readable: false, error: null },
      { name: "worker-supervisor.log", process: "supervisor-host", label: "宿主 Supervisor 输出",
        rotation: 0, exists: false, size_bytes: null, modified_at: null, readable: false, error: null }
    ] };
}

function diagnosticsLogPage(query: URLSearchParams) {
  const records = [
    { id: "relay-api.log#2048", file: "relay-api.log", process: "api", offset: 2048,
      ts: "2026-11-12T09:45:00.000Z", level: "error", event: "worker_job_failed",
      raw: null, truncated: false,
      record: { level: "error", event: "worker_job_failed", message: "模型调用失败。",
        request_id: "req-abc", run_id: "run-123",
        stack: "Error: boom\n    at handler (worker.ts:1:1)" } },
    { id: "relay-api.log#1024", file: "relay-api.log", process: "api", offset: 1024,
      ts: "2026-11-12T09:40:00.000Z", level: "info", event: "api_request_completed",
      raw: null, truncated: false,
      record: { level: "info", event: "api_request_completed", message: "GET /health/ready 200" } }
  ];
  const level = query.get("min_level");
  const keyword = query.get("keyword");
  const filtered = records.filter((record) => {
    if (level === "error" && record.level !== "error") return false;
    if (keyword !== null && !JSON.stringify(record.record).includes(keyword)) return false;
    return true;
  });
  return { records: filtered, next_cursor: null, matched_count: filtered.length,
    scanned_bytes: 8192, truncated: false, inventory: diagnosticsInventory() };
}

function diagnosticsRuntime() {
  return { generated_at: "2026-11-12T10:00:00.000Z",
    api: { status: "up", pid: 4321, uptime_seconds: 3672, node: "v24.22.1",
      started_at: "2026-11-12T08:58:48.000Z", log_file: "relay-api.log" },
    database: { status: "up", schema: "up", detail: null },
    worker: { status: "running", detail: "Worker 存活（PID 复核通过）。", pid: 4322,
      derived_from: "log+pid", last_event: { event: "worker_started",
        ts: "2026-11-12T08:59:00.000Z", level: "info", file: "relay-worker.log", offset: 1024 } },
    supervisor: { status: "unknown", detail: "日志里没有得到可核实的 Supervisor 生命周期。",
      pid: null, derived_from: null, last_event: null },
    log_directory: { path: "D:\\Develop\\Relay-Agent\\.relay-test\\logs", exists: true,
      writable: true, file_count: 3 },
    last_error: { id: "relay-api.log#2048", ts: "2026-11-12T09:45:00.000Z", level: "error",
      process: "api", event: "worker_job_failed", message: "模型调用失败。",
      file: "relay-api.log", offset: 2048 } };
}

async function installRoutes(page: Page, directory: { current: DirectoryState },
  counts: { directoryReads: number; diagnosticsQueries?: string[] }): Promise<void> {
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
    // 「当前使用的模型」读三类作用域；缺这三个桩会把卡片渲染成「响应格式无效」，
    // 截图就不再代表正常的未配置态。
    if (path === `${prefix}/model-connections`) return fulfillJson(route, { items: [] });
    if (path === `${prefix}/model-connections/default`
      || path === `${prefix}/model-connections/chat-default`) {
      return fulfillJson(route, { connection_id: null, revision: null });
    }
    if (path === `${prefix}/memory-settings`) return fulfillJson(route, { workspace_id: workspaceId,
      revision: "2", recall_enabled: true, automatic_compaction: true, auto_capture: true });
    if (path === `${prefix}/packs`) return fulfillJson(route, { items: [
      pack("thesis-minimal", "1.2.0", "AVAILABLE"),
      pack("development-minimal", "1.2.0", "AVAILABLE"),
      pack("thesis-minimal", "1.0.0", "HISTORICAL_ONLY") ] });
    if (path === `${prefix}/diagnostics/runtime`) {
      return fulfillJson(route, diagnosticsRuntime());
    }
    if (path === `${prefix}/diagnostics/logs/export`) {
      return route.fulfill({ status: 200, contentType: "text/plain",
        headers: { ...cors(), "content-disposition": "attachment; filename=relay-diagnostics.log" },
        body: "2026-11-12T09:45:00.000Z\terror\tworker_job_failed\t模型调用失败。\n" });
    }
    if (path === `${prefix}/diagnostics/logs`) {
      const query = new URL(request.url()).searchParams;
      counts.diagnosticsQueries?.push(query.toString());
      return fulfillJson(route, diagnosticsLogPage(query));
    }
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

/**
 * 截图默认写本次运行的输出目录，两轮运行互不覆盖（2026-11-11 验收整改）；
 * 需要把对照图固定导出到验收目录时设 RELAY_ACCEPTANCE_SHOTS_DIR。
 */
function shotPath(name: string): string {
  const override = process.env.RELAY_ACCEPTANCE_SHOTS_DIR;
  return override === undefined ? test.info().outputPath(`${name}.png`) : `${override}/${name}.png`;
}

async function screenshot(page: Page, name: string): Promise<void> {
  // 主滚动容器是 .app-main；左栏设置导航吸顶后，页头始终可见，
  // scrollIntoViewIfNeeded 不再把页面带回顶部——直接复位滚动位置，
  // 保证每张图从同一阅读起点开始。
  await page.evaluate(() => {
    const scroller = document.querySelector(".app-main");
    if (scroller instanceof HTMLElement) scroller.scrollTop = 0;
  });
  await page.screenshot({ path: shotPath(name), fullPage: true });
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const scroller = document.scrollingElement ?? document.documentElement;
    return Math.max(scroller.scrollWidth - scroller.clientWidth,
      document.body.scrollWidth - document.body.clientWidth);
  });
  expect(overflow, "设置页不允许水平溢出").toBeLessThanOrEqual(1);
}

test("五组设置、失效默认目录、恢复与窄窗截图", async ({ page }) => {
  const directory = { current: unavailableDirectory() };
  const counts = { directoryReads: 0 };
  await installRoutes(page, directory, counts);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings", { waitUntil: "domcontentloaded" });
  await connect(page);

  await expect(page.getByTestId("settings-page")).toBeVisible();
  const tabs = page.getByRole("tab");
  await expect(tabs).toHaveCount(5);
  await expect(page.getByTestId("settings-group-basic")).toHaveText("通用设置");
  await expect(page.getByTestId("settings-group-model")).toHaveText("AI 与模型");
  await expect(page.getByTestId("settings-group-execution")).toHaveText("权限与执行");
  await expect(page.getByTestId("settings-group-workbench")).toHaveText("工作台");
  await expect(page.getByTestId("settings-group-diagnostics")).toHaveText("开发者诊断");

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

  // AI 与模型：当前使用的模型 → 当前状态 → 模型连接 → 上下文 → 记忆 → 高级诊断。
  await page.getByTestId("settings-group-model").click();
  const scope = page.getByTestId("settings-ai-scope");
  await expect(scope).toContainText("聊天默认只影响没有显式会话选择的新消息");
  await expect(scope).toContainText("Run 默认只决定新任务冻结哪条连接");
  await expect(scope).toContainText("已冻结的执行保持原连接");
  await expect(page.getByTestId("current-model-usage")).toBeVisible();
  await expect(page.getByTestId("service-state")).toBeVisible();
  await expect(page.getByTestId("model-connections")).toBeVisible();
  await expect(page.getByTestId("model-connections")).not.toContainText("验证通过");
  const advanced = page.getByTestId("settings-model-advanced");
  expect(await advanced.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false);
  await expect(advanced.locator("summary")).toHaveText("高级诊断与能力声明");
  const order = await page.locator('[role="tabpanel"]:not([hidden]) > section.settings-card > h2')
    .allTextContents();
  expect(order).toEqual(["当前使用的模型", "连接与模型状态", "模型连接", "上下文长度", "长期与短期记忆"]);
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
  await expect(page.getByTestId("settings-group-diagnostics")).toHaveAttribute("aria-selected", "true");

  // 窄窗：单列/两列折叠，无水平溢出；五个页签都能到达。
  await page.setViewportSize({ width: 760, height: 900 });
  for (const [group, name] of [["basic", "general-narrow-760"], ["model", "ai-narrow-760"],
    ["execution", "permissions-narrow-760"], ["workbench", "workbench-narrow-760"],
    ["diagnostics", "diagnostics-narrow-760"]] as const) {
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

test("开发者诊断：直接路由、筛选、详情、导出与运行状态", async ({ page }) => {
  const counts: { directoryReads: number; diagnosticsQueries: string[] } = {
    directoryReads: 0, diagnosticsQueries: [] };
  await installRoutes(page, { current: readyDirectory() }, counts);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings/diagnostics", { waitUntil: "domcontentloaded" });
  await connect(page);

  // /settings/diagnostics 直接进入第五组；只读接口全部由桩响应。
  await expect(page.getByTestId("settings-group-diagnostics"))
    .toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#settings-panel-diagnostics")).toBeVisible();
  await expect(page.getByTestId("diagnostics-log-row")).toHaveCount(2);
  await expect(page.getByTestId("diagnostics-count")).toContainText("匹配 2 条");
  await expect(page.getByTestId("diagnostics-detail")).toContainText("从左侧选择一条日志");

  // 详情：安全纯文本堆栈；原始记录默认折叠。
  await page.getByTestId("diagnostics-log-row").first().click();
  const detail = page.getByTestId("diagnostics-detail");
  await expect(detail).toContainText("worker_job_failed");
  await expect(detail).toContainText("模型调用失败。");
  await expect(page.getByTestId("diagnostics-stack")).toContainText("Error: boom");
  expect(await page.getByTestId("diagnostics-raw")
    .evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false);
  await page.getByTestId("diagnostics-copy-summary").click();
  // 剪贴板不可用时也必须给出可执行的回退说明，而不是静默失败。
  await expect(page.getByTestId("diagnostics-copy-result")).toBeVisible();

  // 筛选：请求带上 min_level=error，列表收缩为 1 条。
  await page.getByTestId("diagnostics-min-level").selectOption("error");
  await page.getByTestId("diagnostics-query").click();
  await expect(page.getByTestId("diagnostics-log-row")).toHaveCount(1);
  await expect.poll(() => counts.diagnosticsQueries
    .some((query) => query.includes("min_level=error"))).toBe(true);
  await expect(page.getByTestId("diagnostics-count")).toContainText("匹配 1 条");

  // 运行状态：能核实的给结论，核实不了的显示「未知」，不冒充运行中。
  await expect(page.getByTestId("diagnostics-worker")).toContainText("运行中");
  await expect(page.getByTestId("diagnostics-supervisor")).toContainText("未知");
  await expect(page.getByTestId("diagnostics-database")).toContainText("可用");
  await expect(page.getByTestId("diagnostics-last-error")).toContainText("worker_job_failed");

  // 诊断文件：白名单清单、目录路径与导出（浏览器模式直接下载）。
  await expect(page.getByTestId("diagnostics-file-row")).toHaveCount(5);
  await expect(page.getByTestId("diagnostics-directory-path")).toContainText(".relay-test");
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("diagnostics-export").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^relay-diagnostics-.*\.log$/u);
  await expect(page.getByTestId("diagnostics-file-notice")).toContainText("已下载");
  await screenshot(page, "diagnostics-1440");
});

test("动效写失败时显示偏好回执逐项如实，重试成功后恢复完整回执（2026-11-11 验收整改）", async ({ browser }) => {
  // 全新浏览器上下文：只拒 relay.motion 这一个键的写入，其余键照常——
  // 与验收抽查相同的注入方式（Storage.prototype.setItem 包装，不用 route 伪造）。
  const context = await browser.newContext();
  const page = await context.newPage();
  await installRoutes(page, { current: readyDirectory() }, { directoryReads: 0 });
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    (window as unknown as { __relayOriginalSetItem: typeof original }).__relayOriginalSetItem = original;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === "relay.motion") throw new DOMException("quota", "QuotaExceededError");
      return original.call(this, key, value);
    };
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/settings", { waitUntil: "domcontentloaded" });
  await connect(page);

  // 原值：时区 Asia/Shanghai、动效「跟随系统」、导航位置「左侧导航」。
  const motionSelect = page.getByTestId("settings-motion");
  await expect(motionSelect).toHaveValue("system");
  expect(await page.getByTestId("settings-navigation-placement").locator("input").first().inputValue())
    .toBe("sidebar");
  expect(await page.evaluate(() => localStorage.getItem("relay.motion"))).toBeNull();

  // 切换动效为「关闭」并保存：存储拒绝 relay.motion，时区那项照常落盘。
  await motionSelect.selectOption("off");
  await page.getByTestId("settings-save").click();
  // 回执逐项如实：不再整单谎报「显示偏好已保存」。
  await expect(page.getByTestId("settings-save-result")).toHaveText("时区偏好已保存，仅在本设备生效。");
  await expect(page.getByTestId("settings-motion-save-result"))
    .toContainText("动效偏好未能写入本设备存储");
  // 当次窗口保留所选档位（html[data-motion]），不因写失败回弹。
  expect(await page.evaluate(() => document.documentElement.dataset.motion)).toBe("off");

  // 用新的页面实例读存储，避免只断言 React state：时区落了盘，动效没有。
  const reader = await context.newPage();
  await reader.goto(page.url(), { waitUntil: "domcontentloaded" });
  const stored = await reader.evaluate(() => ({
    display: localStorage.getItem("relay.workbench.displayPreferences"),
    motion: localStorage.getItem("relay.motion")
  }));
  expect(JSON.parse(stored.display ?? "{}") as { timeZone?: unknown }).toEqual(
    expect.objectContaining({ timeZone: "Asia/Shanghai" }));
  expect(stored.motion).toBeNull();
  await reader.close();

  // 刷新：动效回到「跟随系统」（未持久化），时区保留——回执与持久化结果一致。
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("settings-motion")).toHaveValue("system");

  // 重试：恢复 setItem，重新选回「关闭」（reload 后表单回到默认，重试应带着用户的选择），
  // 再保存一次——旧错误消失、完整回执回来、存储真正落盘。
  await page.getByTestId("settings-motion").selectOption("off");
  await page.evaluate(() => {
    const w = window as unknown as { __relayOriginalSetItem: Storage["setItem"] };
    Storage.prototype.setItem = w.__relayOriginalSetItem;
  });
  await page.getByTestId("settings-save").click();
  await expect(page.getByTestId("settings-save-result")).toHaveText("显示偏好已保存，仅在本设备生效。");
  await expect(page.getByTestId("settings-motion-save-result")).toHaveCount(0);
  const storedAfter = await page.evaluate(() => localStorage.getItem("relay.motion"));
  expect(storedAfter).toBe("off");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("settings-motion")).toHaveValue("off");
  await context.close();
});
