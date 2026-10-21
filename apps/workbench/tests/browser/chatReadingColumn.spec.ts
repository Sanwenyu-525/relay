import { expect, test, type Page, type Route } from "@playwright/test";

// 阅读列轴线（2026-10-19 用户截图指令「左边跟输入框的左边对齐就好了」）。
// 消息列在滚动容器里居中，自绘滚动条（12px）占 content box 的 inline-end，输入器不在滚动容器里，
// 两边因此差半个滚动条。这条用例量真实盒子，锁住「中线重合」；API 全部由 page.route 伪造，
// 不连数据库、不调 Provider、不产生任何写请求。

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const sessionId = "66666666-6666-4666-8666-666666666666";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = "http://127.0.0.1:4173";

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(), body: JSON.stringify(body) });
}

function sessionRow(): unknown {
  return { id: sessionId, workspace_id: workspaceId, project_id: null, task_id: null,
    title: "阅读列轴线", status: "ACTIVE", revision: "1", conversation_mode: "AGENT",
    assistant_profile_id: null, created_at: "2026-10-19T14:00:00Z", updated_at: "2026-10-19T14:00:00Z" };
}

/** 一条消息行；回复写成两段，滚动容器必然可滚（scrollbar-gutter 因此真实生效）。 */
function row(id: string, seq: number, role: "USER" | "ASSISTANT", content: string): unknown {
  return { id, session_id: sessionId, seq: String(seq), role, status: "COMPLETED", intent: "DISCUSS",
    created_at: "2026-10-19T14:33:00Z", updated_at: "2026-10-19T14:34:00Z", content,
    error_code: null, provider_error_kind: null, sources: [], skill: null, cancel_requested: false,
    usage: { input_tokens: 2186, output_tokens: 71, cache_read_tokens: null, cache_creation_tokens: null } };
}

const messages = [
  row("u-1", 1, "USER", "那我可以直接复制 Markdown 保存吗？"),
  row("x-1", 2, "ASSISTANT", "还是不能直接保存。目录也必须通过应用里的执行入口。"),
  row("u-2", 3, "USER", "好，那就按你说的来。"),
  row("x-2", 4, "ASSISTANT", "收到，等这一轮写完再一起核对。")
];

async function installRoutes(page: Page): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/model-port`) return fulfillJson(route, { provider: "fake",
      configured: false, model: null, base_url: null, max_call_tokens: null });
    if (path === `${prefix}/assist-sessions`) return fulfillJson(route, { items: [sessionRow()] });
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return fulfillJson(route, { items: messages });
    if (path === `${prefix}/assist-sessions/${sessionId}`) return fulfillJson(route, sessionRow());
    if (path === `${prefix}/assist-proposals`) return fulfillJson(route, { items: [] });
    if (path === `${prefix}/skill-definitions`) return fulfillJson(route, { items: [] });
    if (path === `${prefix}/chat-commands`) return fulfillJson(route, { items: [] });
    if (path.startsWith(`${prefix}/conversation-execution-requests`)) return fulfillJson(route, { items: [] });
    if (path.startsWith(`${prefix}/learning`)) return fulfillJson(route, { items: [], epoch: "0" });
    return fulfillJson(route, { items: [], next_cursor: null });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("reading-column-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

type Box = { left: number; right: number; width: number };

async function openAt(page: Page, width: number): Promise<{ list: Box; composer: Box }> {
  await page.setViewportSize({ width, height: 800 });
  await installRoutes(page);
  await page.goto(`/agent?session=${sessionId}`);
  await connect(page);
  await page.getByTestId("assist-transcript").waitFor({ timeout: 20_000 });
  await page.locator(".agent-message-list").first().waitFor({ timeout: 20_000 });
  return page.evaluate(() => {
    const rect = (selector: string) => {
      const node = document.querySelector<HTMLElement>(selector);
      if (node === null) throw new Error(`找不到 ${selector}`);
      const box = node.getBoundingClientRect();
      return { left: box.left, right: box.right, width: box.width };
    };
    return { list: rect(".agent-message-list"), composer: rect(".agent-chat-composer") };
  });
}

const center = (box: Box): number => (box.left + box.right) / 2;

test.describe("阅读列轴线", () => {
  test("宽档：消息列与输入器左右缘重合", async ({ page }) => {
    const { list, composer } = await openAt(page, 1440);
    // 阅读列放得下 measure：两者都按 measure 居中，四条边必须逐像素一致。
    expect(Math.abs(center(list) - center(composer))).toBeLessThanOrEqual(1);
    expect(Math.abs(list.left - composer.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(list.right - composer.right)).toBeLessThanOrEqual(1);
  });

  test("窄档：两列都贴左缘，不因滚动条让位而被推右", async ({ page }) => {
    const { list, composer } = await openAt(page, 420);
    // 窄档消息列满宽（flush），左缘必须与输入卡同一条线；宽度差属于「卡按 measure 居中」那条规则。
    expect(Math.abs(list.left - composer.left)).toBeLessThanOrEqual(1);
  });
});
