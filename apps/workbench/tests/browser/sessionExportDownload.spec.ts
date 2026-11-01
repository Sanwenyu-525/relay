import { expect, test, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";

// 会话导出的浏览器回归（2026-11-01）。
//
// 判的是 jsdom 判不到的那一件事：**文件真的落到本机，并且叫对名字。**
// 菜单摆位、只读、键盘与失败说法由 tests/sessionRowMenu.spec.ts 守；这里只补三件只有真浏览器
// 才能证明的事：
// 1. `<a download>` + Blob 这条路在 Chromium 里确实触发下载，建议文件名与界面说出的那个一致；
// 2. 下载下来的字节就是服务端那份文档，解析得开、段落齐全，不是重新拼出来的精简版；
// 3. 失败时一个文件都不落——没有下载事件、没有空 JSON，只有就地告警里的真实原因。
//
// 正文不是手写 fixture：`sample-export.json` 由真实 Fastify 路由在真实 PostgreSQL 上导出
// （集成用例 EX-12），这里逐字节当作响应正文，把「后端产物」和「浏览器落盘」接成一条链。
// 除导出与列表外的接口仍由 page.route 伪造，不连数据库、不调 Provider。

const apiBase = "http://127.0.0.1:8787";
const origin = `http://127.0.0.1:${process.env.RELAY_E2E_PORT ?? "4173"}`;
const evidenceDir = process.env.RELAY_EXPORT_EVIDENCE_DIR
  ?? "D:/Develop/Relay-Agent/tmp/SESSION-EXPORT-01";

const exportText = readFileSync(`${evidenceDir}/sample-export.json`, "utf8");
const document_ = JSON.parse(exportText) as {
  session: { id: string; title: string; status: string; revision: string | number;
    created_at: string; updated_at: string };
  workspace: { id: string };
};

const workspaceId = document_.workspace.id;
const sessionId = document_.session.id;
const prefix = `/api/v1/workspaces/${workspaceId}`;
/** 文件名里的这一天取文档里的 `exported_at`，与界面toast 报的是同一个时刻。 */
const exportedAt = new Date(JSON.parse(exportText).exported_at as string);
const pad = (part: number) => String(part).padStart(2, "0");
const expectedName = `Relay-${document_.session.title}-${exportedAt.getFullYear()
 }${pad(exportedAt.getMonth() + 1)}${pad(exportedAt.getDate())}.json`;

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(),
    body: typeof body === "string" ? body : JSON.stringify(body) });
}

interface FakeState {
  /** 导出之外发出去的写请求：只读承诺的判据是这里点完导出后一条都不多。 */
  readonly writes: string[];
  /** 导出请求本身的方法与请求体：浏览器这一层的只读证据是 GET 且不带任何正文。 */
  readonly exportRequests: { method: string; body: string | null }[];
}

async function installRoutes(page: Page, options: {
  exportStatus?: number; exportBody?: string; archived?: boolean;
} = {}): Promise<FakeState> {
  const state: FakeState = { writes: [], exportRequests: [] };
  const row = { id: sessionId, workspace_id: workspaceId, project_id: null, task_id: null,
    title: document_.session.title, status: options.archived === true ? "ARCHIVED" : "ACTIVE",
    revision: document_.session.revision, created_at: document_.session.created_at,
    updated_at: document_.session.updated_at, last_message_at: document_.session.updated_at,
    pinned_at: null, unread_at: null, has_messages: true };

  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // OPTIONS 是跨域预检，不是业务写请求：只有真发了命令才算。
    if (request.method() !== "GET" && request.method() !== "OPTIONS") {
      state.writes.push(`${request.method()} ${path}`);
    }
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: cors() }); return;
    }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/tasks` || path === `${prefix}/projects`) {
      return fulfillJson(route, { items: [], next_cursor: null });
    }
    if (path === `${prefix}/assist-sessions`) {
      const status = new URL(request.url()).searchParams.get("status");
      if (options.archived === true) {
        return fulfillJson(route, { items: status === "ARCHIVED" ? [row] : [] });
      }
      return fulfillJson(route, { items: status === "ARCHIVED" ? [] : [row] });
    }
    const exportPath = new RegExp(`^/api/v1/workspaces/[^/]+/assist-sessions/${sessionId}/export$`, "u");
    if (exportPath.test(path)) {
      // 浏览器这一层能证的是「前端只要这一份、且不改任何东西」：GET、无正文、一次一发。
      // 服务端修订与账本前后一致由集成用例 EX-11 在真实 PostgreSQL 上判。
      state.exportRequests.push({ method: request.method(), body: request.postData() });
      if (options.exportStatus !== undefined) {
        return fulfillJson(route, { code: "INTERNAL_ERROR",
          detail: "导出所需的工具账本读取失败：connection refused",
          request_id: "req-browser-500" }, options.exportStatus);
      }
      return fulfillJson(route, options.exportBody ?? exportText);
    }
    const single = new RegExp(`^/api/v1/workspaces/[^/]+/assist-sessions/${sessionId}$`, "u");
    if (single.test(path)) return fulfillJson(route, row);
    return fulfillJson(route, { items: [], next_cursor: null });
  });
  return state;
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("session-export-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" })
    .waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

async function openMenu(page: Page): Promise<void> {
  await page.getByTestId(`recent-work-${sessionId}`).hover();
  await page.getByTestId(`recent-work-menu-${sessionId}`).click();
}

test.describe("会话导出落盘", () => {
  test("点「导出会话」真的下载本机文件：名字对、内容就是服务端那份文档", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const server = await installRoutes(page);
    await page.goto("/agent");
    await connect(page);
    await openMenu(page);

    // 菜单证据：导出条目排在「复制会话 ID」之后、「归档」之前，图标与字号与其他条目同一档。
    const order = await page.locator(`[data-testid="recent-work-panel-${sessionId}"] button`)
      .allTextContents();
    expect(order.map((text) => text.trim())).toEqual(["置顶", "重命名", "标记为未读",
      "分叉这段讨论", "复制会话 ID", "导出会话", "归档", "删除"]);
    await page.screenshot({ path: `${evidenceDir}/screenshot-01-row-menu.png` });

    const writesBefore = server.writes.length;
    const downloadPromise = page.waitForEvent("download", { timeout: 15_000 });
    await page.getByTestId(`recent-work-export-${sessionId}`).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toBe(expectedName);
    const saved = await download.path();
    expect(saved).not.toBeNull();
    const savedText = readFileSync(String(saved), "utf8");
    // 落盘字节与后端正文一致：客户端不裁字段、不重新拼一份「精简版」。
    expect(savedText).toBe(exportText);
    const parsed = JSON.parse(savedText) as { format: string; schema_version: string;
      messages: unknown[]; tool_calls: unknown[]; privacy: Record<string, string> };
    expect(parsed.format).toBe("relay-session-export");
    expect(parsed.schema_version).toBe("1.0");
    expect(parsed.messages.length).toBeGreaterThan(0);
    expect(parsed.tool_calls.length).toBeGreaterThan(0);
    expect(parsed.privacy.structured_fields).toContain("[REDACTED:*]");
    // 存档一份到证据目录：这份文件是「浏览器落盘」与「后端产物」相接的凭据。
    const { copyFileSync } = await import("node:fs");
    copyFileSync(String(saved), `${evidenceDir}/screenshot-02-downloaded.json`);

    await expect(page.getByTestId(`session-export-done-${sessionId}`))
      .toContainText(`已导出「${expectedName}」`);
    await page.screenshot({ path: `${evidenceDir}/screenshot-03-export-done.png` });

    // 只读：这一次点击没有带出任何命令请求，服务端那行修订也没被推进。
    // 开机阶段的读写与本轮判据无关，因此只比起手之后有没有多出写请求。
    expect(server.writes.slice(writesBefore)).toEqual([]);
    expect(server.exportRequests).toEqual([{ method: "GET", body: null }]);
    // 行还在、⋯ 仍可点：导出这一次没有把这一行动没。
    await expect(page.getByTestId(`recent-work-${sessionId}`)).toBeVisible();
    await expect(page.getByTestId(`recent-work-menu-${sessionId}`)).toBeEnabled();
    // 条目回到可再点的名字，面板不因成功而收起：同一段讨论可以连续导第二次。
    await expect(page.getByTestId(`recent-work-export-${sessionId}`)).toContainText("已导出会话");
  });

  test("同名再导出不覆盖：第二次拿到 -2，两次都落盘", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await installRoutes(page);
    await page.goto("/agent");
    await connect(page);
    await openMenu(page);

    const first = page.waitForEvent("download", { timeout: 15_000 });
    await page.getByTestId(`recent-work-export-${sessionId}`).click();
    expect((await first).suggestedFilename()).toBe(expectedName);

    const second = page.waitForEvent("download", { timeout: 15_000 });
    await page.getByTestId(`recent-work-export-${sessionId}`).click();
    expect((await second).suggestedFilename())
      .toBe(expectedName.replace(/\.json$/u, "-2.json"));
  });

  test("导出失败：不落任何文件，告警里是服务端原话与追溯号", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await installRoutes(page, { exportStatus: 500 });
    await page.goto("/agent");
    await connect(page);
    await openMenu(page);

    let downloads = 0;
    page.on("download", () => { downloads += 1; });
    await page.getByTestId(`recent-work-export-${sessionId}`).click();

    const alert = page.locator(`[data-testid="recent-work-panel-${sessionId}"] >> role=alert`);
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("req-browser-500");
    await expect(alert).toContainText("connection refused");
    await expect(alert).toContainText("没有产生任何改动");
    await expect(alert).not.toContainText("command ID");
    // 空文件冒充成功是最坏的一种失败：这里连一次下载事件都不该有。
    await page.waitForTimeout(1_500);
    expect(downloads).toBe(0);
    await expect(page.getByTestId(`session-export-done-${sessionId}`)).toHaveCount(0);
    await page.screenshot({ path: `${evidenceDir}/screenshot-04-export-failure.png` });
  });

  test("服务端声明部分导出时，这句话跟着文件名一起说", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const partialBody = JSON.stringify({ ...JSON.parse(exportText),
      completeness: { ...JSON.parse(exportText).completeness,
        messages: { total: 2, exported: 1, limit: 1, truncated: true, reason: "超过单次上限" } } });
    await installRoutes(page, { exportBody: partialBody });
    await page.goto("/agent");
    await connect(page);
    await openMenu(page);

    const download = page.waitForEvent("download", { timeout: 15_000 });
    await page.getByTestId(`recent-work-export-${sessionId}`).click();
    expect((await download).suggestedFilename()).toBe(expectedName);
    await expect(page.getByTestId(`session-export-done-${sessionId}`))
      .toContainText("部分导出");
    await page.screenshot({ path: `${evidenceDir}/screenshot-05-partial-export.png` });
  });

  test("归档段同样可导出，且不因为导出改状态", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const server = await installRoutes(page, { archived: true });
    await page.goto("/agent");
    await connect(page);

    const section = page.getByTestId("recent-work-archived");
    await section.locator("summary").click();
    await page.getByTestId(`recent-work-${sessionId}`).hover();
    await page.getByTestId(`recent-work-menu-${sessionId}`).click();
    await expect(page.getByTestId(`recent-work-export-${sessionId}`)).toBeVisible();
    await page.screenshot({ path: `${evidenceDir}/screenshot-06-archived-menu.png` });

    const writesBefore = server.writes.length;
    const download = page.waitForEvent("download", { timeout: 15_000 });
    await page.getByTestId(`recent-work-export-${sessionId}`).click();
    expect((await download).suggestedFilename()).toBe(expectedName);
    expect(server.writes.slice(writesBefore)).toEqual([]);
    expect(server.exportRequests).toEqual([{ method: "GET", body: null }]);
  });

  test("键盘可达：Tab 走进条目、回车落盘，Esc 关面板后焦点回到 ⋯", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await installRoutes(page);
    await page.goto("/agent");
    await connect(page);

    // ⋯ 默认 `display: none`，只在行悬停或行内获得焦点时显形（styles.css 的 :focus-within 规则）：
    // 隐藏元素不可聚焦，所以键盘路径从这一行本身起步，用 Tab 走到 ⋯，全程不碰鼠标。
    await page.getByTestId(`recent-work-${sessionId}`).focus();
    const focusOf = () => page
      .evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null);
    let focused: string | null = null;
    for (let step = 0; step < 8 && focused !== `recent-work-menu-${sessionId}`; step += 1) {
      await page.keyboard.press("Tab");
      focused = await focusOf();
    }
    expect(focused).toBe(`recent-work-menu-${sessionId}`);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId(`recent-work-panel-${sessionId}`)).toBeVisible();
    await expect(page.getByTestId(`recent-work-menu-${sessionId}`))
      .toHaveAttribute("aria-expanded", "true");

    // 面板里的条目都是真按钮，靠 Tab 逐条走（这一支没有实现方向键，判据就不写方向键）。
    for (let step = 0; step < 10 && focused !== `recent-work-export-${sessionId}`; step += 1) {
      await page.keyboard.press("Tab");
      focused = await focusOf();
    }
    expect(focused).toBe(`recent-work-export-${sessionId}`);
    await page.screenshot({ path: `${evidenceDir}/screenshot-07-keyboard-focus-item.png` });

    const download = page.waitForEvent("download", { timeout: 15_000 });
    await page.keyboard.press("Enter");
    expect((await download).suggestedFilename()).toBe(expectedName);

    await page.keyboard.press("Escape");
    await expect(page.getByTestId(`recent-work-panel-${sessionId}`)).toHaveCount(0);
    expect(await focusOf()).toBe(`recent-work-menu-${sessionId}`);
  });
});
