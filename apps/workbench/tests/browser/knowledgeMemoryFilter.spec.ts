import { expect, test, type Page } from "@playwright/test";

// DEV-0093：1162×782 时资料页左列只有 208px，共享 .segmented 四枚 flex:1 按钮各约 40px，
// 「已过期」「已停用」被拆成三行并越出按钮。这里锁窄列的几何与键盘切换，数据全部来自页面内伪造 GET。
const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const prefix = `/api/v1/workspaces/${workspaceId}`;

const memory = (index: number) => ({
  id: `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
  project_id: null,
  title: `记忆条目 ${index}`,
  body: "用于验证筛选按钮几何，不承载业务事实。",
  media_type: "text/plain",
  effective_status: "ACTIVE",
  persistent_status: "ACTIVE",
  confirmed_by: "HUMAN",
  confirmed_at: "2026-10-20T00:00:00Z",
  expires_at: null,
  revision: "1",
  created_at: "2026-10-20T00:00:00Z",
  updated_at: "2026-10-20T00:00:00Z",
});

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("dev-0093-fixture-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor();
  await page.keyboard.press("Escape");
}

test("1162×782 记忆筛选四枚按钮不拆行、不越出列表，键盘仍可切换", async ({ page }) => {
  await page.setViewportSize({ width: 1162, height: 782 });
  const memoryQueries: string[] = [];
  await page.route(`${apiBase}/**`, async (route) => {
    const url = new URL(route.request().url());
    const headers = { "access-control-allow-origin": "http://127.0.0.1:4173",
      "access-control-allow-headers": "Authorization, Content-Type" };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    let payload: unknown = { items: [], next_cursor: null };
    if (url.pathname === "/health/ready") payload = { status: "ready" };
    if (url.pathname === `${prefix}/memories`) {
      memoryQueries.push(url.search);
      payload = { items: [memory(1), memory(2)], next_cursor: null };
    }
    return route.fulfill({ status: 200, headers, contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.goto("/knowledge?kind=MEMORY");
  await connect(page);
  await expect(page.getByTestId("knowledge-memory-filter-ALL")).toBeVisible();

  const geometry = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>(".knowledge-list")!;
    const buttons = [...document.querySelectorAll<HTMLElement>(".knowledge-memory-filter .segmented-option")];
    const panelBox = panel.getBoundingClientRect();
    const panelContentRight = panelBox.right - parseFloat(getComputedStyle(panel).paddingRight) - parseFloat(getComputedStyle(panel).borderRightWidth);
    return buttons.map((button) => {
      const range = document.createRange();
      range.selectNodeContents(button);
      const box = button.getBoundingClientRect();
      return {
        label: button.textContent,
        textLines: range.getClientRects().length,
        clientWidth: button.clientWidth,
        clientHeight: button.clientHeight,
        scrollWidth: button.scrollWidth,
        scrollHeight: button.scrollHeight,
        right: box.right,
        top: box.top,
        panelContentRight,
      };
    });
  });

  expect(geometry.map((button) => button.label)).toEqual(["全部", "有效", "已过期", "已停用"]);
  for (const button of geometry) {
    expect(button.textLines, `${button.label} 只占一行`).toBe(1);
    expect(button.scrollWidth, `${button.label} 不横向溢出`).toBeLessThanOrEqual(button.clientWidth);
    expect(button.scrollHeight, `${button.label} 不纵向溢出`).toBeLessThanOrEqual(button.clientHeight);
    expect(button.right, `${button.label} 不越过列表内容右缘`).toBeLessThanOrEqual(button.panelContentRight + 0.5);
  }
  expect(new Set(geometry.map((button) => button.top)).size).toBe(2);

  const all = page.getByTestId("knowledge-memory-filter-ALL");
  await all.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("knowledge-memory-filter-EXPIRED")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("knowledge-memory-filter-EXPIRED")).toHaveAttribute("aria-pressed", "true");
  expect(memoryQueries.some((query) => query.includes("effective_status=EXPIRED")), "键盘切换后按服务端筛选重读").toBe(true);
});
