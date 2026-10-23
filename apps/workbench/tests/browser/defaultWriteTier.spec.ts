import { expect, test, type Page, type Route } from "@playwright/test";
import fs from "node:fs";

// DEV-0115（2026-10-22）「未选择目录时这个权限选择不了，我需要什么时候都能选择」。
// 这里只用真实 Chromium 核对界面事实：没有目录时三行仍可选、说的是「以后新开的目录」、
// 点一行发出的是工作区默认档位命令（带 expected_revision），芯片读回那一档的档位名，
// 而此刻的权限结论仍是「不可写入」（data-tier=unbound，上方状态行同刻读「未就绪」）。
// 同日第二轮用户指令收进这里：芯片不带「默认」前缀，改档成功后菜单底部不再出现一句文字。
// 同日第三轮再收两条：菜单只剩三行（删除只读）、在途窗口不弹待核对块
// 也不改菜单高度（「切换权限的时候会闪一下」）。
// 「菜单以下拉框居中」同日先实施后按用户指令回滚，菜单仍从芯片左缘起排，这里不留居中断言。
// API 全部由 page.route 伪造：不连数据库、不写真实事实。

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = "http://127.0.0.1:4173";
const OUT = "D:/Develop/Relay-Agent/output/dev-0115-screenshots";

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}
async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(), body: JSON.stringify(body) });
}

function defaultProjection(tier: string | null, revision: string): unknown {
  return { resource_id: null, canonical_root: null, display_name: null, write_tier: null,
    default_write_tier: tier, status: "UNSET", reason: null, revision };
}

type Write = { path: string; body: Record<string, unknown> };

/** 伪造新对话首屏所需的最小读集合，并把发出的写命令记下来供断言。 */
async function installRoutes(page: Page, writes: Write[], state: { tier: string | null; revision: string })
  : Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/model-port`) return fulfillJson(route, { provider: "fake",
      configured: false, model: null, base_url: null, max_call_tokens: null });
    if (path === `${prefix}/model-port/verification`) return fulfillJson(route,
      { current_config_fingerprint: null, last: null, matches_current_config: false,
        worker_startup_validation: "NOT_CONFIGURED" });
    if (path === `${prefix}/default-write-tier` && method === "POST") {
      const body = JSON.parse(String(request.postData())) as Record<string, unknown>;
      writes.push({ path, body });
      state.tier = String(body.default_write_tier);
      state.revision = String(Number(state.revision) + 1);
      // 在途窗口拉长到肉眼可见，才能断言「请求还在路上」那一刻菜单没有弹块、没有改高度（闪烁契约）。
      await new Promise((resolve) => setTimeout(resolve, 300));
      return fulfillJson(route, { command_id: body.command_id, committed_at: "2026-10-22T00:00:00Z",
        result: { workspace_id: workspaceId, default_write_tier: state.tier, revision: state.revision } });
    }
    if (path === `${prefix}/default-working-directory` && method === "GET") {
      return fulfillJson(route, defaultProjection(state.tier, state.revision));
    }
    return fulfillJson(route, { items: [], next_cursor: null });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("dev-0115-fake-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  const target = page.locator('[data-testid="write-permission"]').first();
  await (await target.isVisible() ? target : page.locator(".agent-chat-composer").first())
    .screenshot({ path: `${OUT}/${name}.png` });
  await page.screenshot({ path: `${OUT}/${name}-page.png` });
}

test("没有目录时三行仍可选，写的是工作区默认档位", async ({ page }) => {
  fs.mkdirSync(OUT, { recursive: true });
  const writes: Write[] = [];
  const state = { tier: null as string | null, revision: "0" };
  await installRoutes(page, writes, state);
  await page.goto("/agent?new=", { waitUntil: "domcontentloaded" });
  await connect(page);
  await expect(page.getByTestId("assist-first-draft")).toBeVisible({ timeout: 20_000 });

  const chip = page.locator('[data-testid="write-permission-chip"]');
  await expect(chip).toContainText("不可写入");
  expect(await chip.getAttribute("data-tier")).toBe("unbound");
  await shot(page, "01-chip-unbound");

  await chip.click();
  const menu = page.locator('[data-testid="write-permission"]');
  await expect(menu).toBeVisible();
  // 2026-10-22 用户指令「删除只读权限」：菜单只剩三行。
  await expect(menu.locator(".agent-chat-permission-row")).toHaveCount(3);
  for (const tier of ["ask", "auto", "full"]) {
    await expect(menu.locator(`.agent-chat-permission-row[data-tier="${tier}"]`)).toBeEnabled();
  }
  await expect(menu).toContainText("新开的目录");
  const menuBox = page.locator(".agent-chat-permission-menu");
  await shot(page, "02-menu-open-no-directory");

  // 闪烁契约（同日用户指认）：点击后到回执前，菜单里不弹待核对块、不改高度；
  // 三行的排版配色不退成灰字，只有刚点那一行按设计变淡。
  const rowOpacity = () => menu.locator(".agent-chat-permission-row").evaluateAll(
    (nodes) => nodes.map((node) => getComputedStyle(node).opacity));
  const rowsBefore = await rowOpacity();
  const heightBefore = (await menuBox.boundingBox())?.height ?? 0;
  await menu.locator('.agent-chat-permission-row[data-tier="ask"]').click();
  await expect(menuBox).toHaveAttribute("data-busy", "true");
  await expect(page.locator('[data-testid="write-permission-pending"]')).toHaveCount(0);
  await expect(menuBox).toHaveCSS("height", `${heightBefore}px`);
  await expect(page.locator('[data-testid="write-permission-ask"]')).toHaveAttribute("data-pending", "true");
  expect(await rowOpacity()).toEqual(["0.55", rowsBefore[1]!, rowsBefore[2]!]);
  await expect(chip).toContainText("请求批准", { timeout: 20_000 });
  await expect(chip).not.toContainText("默认");
  // data-tier 仍是 unbound：此刻仍然没有目录可写，芯片读的是「以后新开的目录」的档位。
  expect(await chip.getAttribute("data-tier")).toBe("unbound");
  expect(await chip.getAttribute("data-default-tier")).toBe("ask");
  // 2026-10-22 用户指令：选择权限后菜单底部不出现文字。
  await expect(page.locator('[data-testid="write-permission-confirmed"]')).toHaveCount(0);
  expect(writes.map((write) => write.body)).toEqual([
    { command_id: writes[0]!.body.command_id, expected_revision: "0", default_write_tier: "ASK" }]);
  await shot(page, "03-default-ask-saved");
});

test("默认已是完全访问时，芯片带上危险色且行内说明仍说新开的目录", async ({ page }) => {
  const writes: Write[] = [];
  const state = { tier: "FULL", revision: "1" };
  await installRoutes(page, writes, state);
  await page.goto("/agent?new=", { waitUntil: "domcontentloaded" });
  await connect(page);
  await expect(page.getByTestId("assist-first-draft")).toBeVisible({ timeout: 20_000 });

  const chip = page.locator('[data-testid="write-permission-chip"]');
  await expect(chip).toContainText("完全访问");
  await expect(chip).not.toContainText("默认");
  expect(await chip.getAttribute("data-tier")).toBe("unbound");
  expect(await chip.getAttribute("data-default-tier")).toBe("full");
  await chip.click();
  const menu = page.locator('[data-testid="write-permission"]').first();
  await expect(menu.locator('.agent-chat-permission-row[data-tier="full"]'))
    .toHaveAttribute("data-current", "true");
  await expect(menu).toContainText("新开的目录");
  await shot(page, "04-default-full-danger");
  // 只是读到默认档位，不该发命令。
  expect(writes).toHaveLength(0);
});
