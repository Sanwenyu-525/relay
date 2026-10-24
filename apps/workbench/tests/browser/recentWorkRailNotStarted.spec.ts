import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * 「未开始」标记与空会话不给分叉（2026-10-24 用户截图指认「已有会话为什么是新建会话的欢迎页」）。
 *
 * 起点是数据事实而不是观感：那条会话在库里一条消息都没有（建会话与绑目录两条命令落库、
 * `RequestAssistMessage` 从未落地），随后又被「⋯ → 分叉」复制成第二条同样空的会话，
 * 点开只剩欢迎空态。左栏因此必须让「这一行还没有内容」在**不点开**的时候就读得出来，
 * 并且不再提供一条必然被服务端拒绝的分叉入口。
 *
 * 这里在真实 Chromium 里锁三件事（jsdom 侧由 `sessionRowMenu.spec.ts` 守行为）：
 * ① 标记只出现在空会话那一行，颜色等于 `color.text.muted`（不是强调色）；
 * ② 它不换行、不把行撑高——与同组普通行等高；
 * ③ 空会话的 ⋯ 菜单里没有「分叉这段讨论」，说过话的那一条照旧有。
 *
 * API 全部由 page.route 伪造，不连数据库、不调 Provider。
 */

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = `http://127.0.0.1:${process.env.RELAY_RAIL_TEST_PORT ?? "4173"}`;

const emptyId = "66666666-6666-4666-8666-666666666671";
const spokenId = "66666666-6666-4666-8666-666666666672";

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: "application/json", headers: cors(),
    body: JSON.stringify(body) });
}

/** 会话行投影：除 `last_message_at` 外两条完全同形——这正是它难分辨的地方。 */
function session(id: string, title: string, updatedAt: string, lastMessageAt: string | null): unknown {
  return { id, workspace_id: workspaceId, project_id: null, task_id: null, title,
    status: "ACTIVE", revision: "1", created_at: updatedAt, updated_at: updatedAt,
    last_message_at: lastMessageAt, pinned_at: null, unread_at: null,
    working_resource_id: null,
    context: { project_goals: [], working_directory: null } };
}

const emptySession = session(emptyId, "关于Relay-Agent（1）", "2026-10-24T04:30:00Z", null);
const spokenSession = session(spokenId, "关于Relay-Agent", "2026-10-15T00:18:00Z",
  "2026-10-15T00:18:00Z");

async function installRoutes(page: Page): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    const path = new URL(request.url()).pathname;
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/assist-sessions`) {
      const status = new URL(request.url()).searchParams.get("status");
      if (status === "ARCHIVED") return fulfillJson(route, { items: [] });
      return fulfillJson(route, { items: [emptySession, spokenSession] });
    }
    if (path === `${prefix}/assist-sessions/${emptyId}`) return fulfillJson(route, emptySession);
    if (path === `${prefix}/assist-sessions/${spokenId}`) return fulfillJson(route, spokenSession);
    return fulfillJson(route, { items: [], next_cursor: null });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("rail-not-started-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

test("还没有消息的会话：行上标「未开始」，菜单里没有分叉", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await installRoutes(page);
  await page.goto("/agent");
  await connect(page);

  const emptyRow = page.locator(`.recent-work-row:has([data-testid="recent-work-${emptyId}"])`);
  const spokenRow = page.locator(`.recent-work-row:has([data-testid="recent-work-${spokenId}"])`);
  await expect(emptyRow.getByTestId(`recent-work-${emptyId}`)).toBeVisible();

  const chip = emptyRow.getByTestId("recent-work-not-started");
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveText("未开始");
  // 说过话的那一行不长这枚标记：标记的判据是活动键，不是「这一列里有没有空会话」。
  await expect(spokenRow.getByTestId("recent-work-not-started")).toHaveCount(0);
  // 状态同时进可访问名称：不靠颜色、也不只靠视觉标记。
  await expect(emptyRow.getByTestId(`recent-work-${emptyId}`)).toHaveAttribute("aria-label", /· 未开始/u);

  const measured = await page.evaluate((targets) => {
    const rowOf = (id: string) =>
      document.querySelector<HTMLElement>(`[data-testid="recent-work-${id}"]`)!;
    const chipOf = (id: string) =>
      document.querySelector<HTMLElement>(`[data-testid="recent-work-${id}"]`)
        ?.closest(".recent-work-row")?.querySelector<HTMLElement>('[data-testid="recent-work-not-started"]');
    const root = getComputedStyle(document.documentElement);
    const probe = document.createElement("span");
    probe.style.color = "var(--relay-color-text-muted)";
    document.body.append(probe);
    const muted = getComputedStyle(probe).color;
    probe.remove();
    const empty = rowOf(targets.empty);
    const spoken = rowOf(targets.spoken);
    const target = chipOf(targets.empty)!;
    const chipBox = target.getBoundingClientRect();
    const titleBox = empty.querySelector<HTMLElement>(".recent-work-title")!.getBoundingClientRect();
    return {
      emptyHeight: empty.getBoundingClientRect().height,
      spokenHeight: spoken.getBoundingClientRect().height,
      // 标记与标题在同一行：纵向中心差不足 1px 才不会读成第二行。
      centerDelta: Math.abs((chipBox.top + chipBox.height / 2) - (titleBox.top + titleBox.height / 2)),
      chipColor: getComputedStyle(target).color,
      muted,
      caption: Number.parseFloat(root.getPropertyValue("--relay-font-size-caption")) * Number.parseFloat(root.fontSize),
      chipFontSize: Number.parseFloat(getComputedStyle(target).fontSize)
    };
  }, { empty: emptyId, spoken: spokenId });

  const detail = JSON.stringify(measured);
  // 行盒等高：标记只占标题右侧那一段横向空间，行高与行距一像素都不动。
  expect(Math.abs(measured.emptyHeight - measured.spokenHeight), detail).toBeLessThanOrEqual(0.5);
  expect(measured.centerDelta, detail).toBeLessThan(1);
  // 字号取 caption 档、颜色取 muted：它说的是「这一行还没有内容」这一事实，不是导航强调。
  expect(measured.chipFontSize, detail).toBeCloseTo(measured.caption, 1);
  expect(measured.chipColor, `标记色 ${measured.chipColor} 应等于 muted ${measured.muted}`).toBe(measured.muted);

  // 没有可搬的历史，服务端只会按 INVALID_TRANSITION 拒绝：这一项干脆不出现。
  // 这里用 dispatchEvent 而不是真实指针序列：⋯ 在静止态 display:none，先 hover 行体会先开摘要卡，
  // 两次浮层切换在同一拍里互相收（本文件实测），而指针开合本身已由 `recentWorkRailDensity.spec.ts`
  // 的「会话行内触发器」一例守；这一例要验的是**面板里有哪些项**。
  await emptyRow.getByTestId(`recent-work-${emptyId}`).hover();
  await emptyRow.getByTestId(`recent-work-menu-${emptyId}`).dispatchEvent("click");
  const emptyPanel = page.locator(`[data-testid="recent-work-panel-${emptyId}"]`);
  await expect(emptyPanel).toBeVisible();
  await expect(emptyPanel.getByText("重命名", { exact: true })).toBeVisible();
  // 面板里没有分叉这一项：不是禁用带原因，而是根本不出现（与归档态只留「重开」同一先例）。
  await expect(emptyPanel.getByText("分叉这段讨论", { exact: true })).toHaveCount(0);

  // 说过话的那一条照旧能分叉：判据是活动键，不是「这一列里有没有空会话」。
  // 打开第二个面板时第一个按浮层独占收掉（`useMenuExclusive`），不必先按 Esc。
  await spokenRow.getByTestId(`recent-work-${spokenId}`).hover();
  await spokenRow.getByTestId(`recent-work-menu-${spokenId}`).dispatchEvent("click");
  const spokenPanel = page.locator(`[data-testid="recent-work-panel-${spokenId}"]`);
  await expect(spokenPanel.getByText("分叉这段讨论", { exact: true })).toBeVisible();

  await page.screenshot({ path: "results/rail-not-started.png" });
});
