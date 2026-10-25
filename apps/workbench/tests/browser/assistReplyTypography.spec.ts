import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * 中文长回复的阅读节奏（2026-10-25 回复生命周期优化的 P1 精修）。
 *
 * 回复正文的块距、标题档位与行内元素此前分散在全局 styles.css 与 AssistView.css 两处：
 * 段落 12px、表格 16px、标题上边距 24px（section 28px 的字号进了 16px 正文的聊天列），
 * 同一份正文里出现三种节奏。这里按真实渲染锁住改后的口径：
 *   * 正文 16px / 27.2px（body · relaxed），块与块之间统一 12px（space.3）；
 *   * 标题在回复里整体降一档（20 / 18 / 16px，600），首块不留上边距；
 *   * 表格自带横向滚动盒，宽度不撑破消息列；
 *   * 引用一条 2px 竖线、行内代码有底色、链接仍可辨认（颜色 + 下划线）；
 *   * 末块贴底（无下边距），页脚紧跟正文，不被额外空白推开。
 */

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const sessionId = "66666666-6666-4666-8666-666666666666";
const userMessageId = "c1111111-1111-4111-8111-111111111111";
const assistantMessageId = "c3333333-3333-4333-8333-333333333333";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = "http://127.0.0.1:4173";

const RICH = [
  "# 这次做了什么",
  "## 结论",
  "这一轮把工作目录读了一遍，下面是逐项事实与可以继续的下一步，正文按中文成段的节奏排。",
  "### 细节",
  "- 读取了两个文件",
  "- 列了一次目录",
  "",
  "1. 先核对来源",
  "2. 再决定是否落盘",
  "",
  "> 引用块说明前提：模型回复完成不等于文件修改成功。",
  "",
  "| 动作 | 结果 |",
  "| --- | --- |",
  "| read_file | 已结算 |",
  "| list_directory | 已结算 |",
  "",
  "行内代码 `apply_changeset` 与一个[外部链接](https://example.com/docs)。",
  "",
  "```bash",
  "git status --short",
  "```",
  "",
  "最后一段：到这里为止都是已核对的事实。"
].join("\n");

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}

const session = { id: sessionId, workspace_id: workspaceId, project_id: projectId, task_id: null,
  title: "关于Relay-Agent", status: "ACTIVE", revision: "1", conversation_mode: "AGENT",
  assistant_profile_id: null, working_resource_id: null,
  context: { project_goals: [], working_directory: null },
  created_at: "2026-10-25T09:00:00Z", updated_at: "2026-10-25T09:00:00Z" };

function message(id: string, seq: string, role: "USER" | "ASSISTANT", content: string) {
  return { id, session_id: sessionId, seq, role, status: "COMPLETED", intent: "DISCUSS", content,
    error_code: null, provider_error_kind: null, sources: [], skill: null, cancel_requested: false,
    steer_requested: false, attachments: [], created_at: "2026-10-25T09:00:00Z",
    updated_at: "2026-10-25T09:00:00Z",
    usage: { input_tokens: 4321, output_tokens: 260, cache_read_tokens: null,
      cache_creation_tokens: null } };
}

async function install(page: Page): Promise<void> {
  await page.route(`${apiBase}/**`, async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", headers: cors(), body: JSON.stringify(body) });
    if (path === "/health/ready") return json({ status: "ready" });
    if (path === `${prefix}/projects/${projectId}`) return json({ id: projectId, title: "Relay-Agent",
      project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
    if (path === `${prefix}/projects/${projectId}/state`) return json({ project_id: projectId,
      revision: "1", phase_key: "GENERAL", next_action_task_id: null,
      selected_artifact_version_refs: [], completed_highlight_refs: [] });
    if (path === `${prefix}/model-port`) return json({ provider: "fake", configured: false, model: null,
      base_url: null, max_call_tokens: 200000 });
    if (path === `${prefix}/default-working-directory`) return json({ resource_id: null,
      canonical_root: null, display_name: null, write_tier: null, default_write_tier: null,
      status: "UNSET", reason: null, revision: "0" });
    if (path === `${prefix}/assist-sessions`) return json({ items: [session] });
    if (path === `${prefix}/assist-sessions/${sessionId}`) return json(session);
    if (path === `${prefix}/assist-sessions/${sessionId}/plans`) return json({ latest: null, versions: [] });
    if (path === `${prefix}/assist-sessions/${sessionId}/goal`) return json({ goal: null, rounds: [] });
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return json({ items: [
      message(userMessageId, "1", "USER", "整理一下这次做了什么"),
      message(assistantMessageId, "2", "ASSISTANT", RICH)] });
    if (path.endsWith("/tool-calls")) return json({ session_id: sessionId,
      message_id: assistantMessageId, message_status: "COMPLETED", rounds: [] });
    if (path.endsWith("/live-preview/events")) return route.fulfill({ status: 502, headers: cors(), body: "" });
    if (path.includes("conversation-diff")) return json({ session_id: sessionId, files: [],
      unavailable_files: 0, unverifiable_files: 0, baseline: null, incomplete: false });
    if (/\/assist-messages\/[^/]+\/model-runtime$/u.test(path)) return json({ message_id: assistantMessageId,
      message_status: "COMPLETED", snapshot_available: false, preferred_model: null, candidate_models: [],
      current_candidate_model: null, actual_model: null, max_candidates: null, routing_status: null,
      failure_scope: null, failure_reason: null, retry_after_at: null, free_daily_remaining: null,
      switches: [], calls: [] });
    return json({ items: [], next_cursor: null });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("reply-typography-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

test("长中文回复：标题降档、块距统一、表格与代码块各自收敛在列内", async ({ page }) => {
  await page.setViewportSize({ width: 1270, height: 1000 });
  await install(page);
  await page.goto(`/projects/${projectId}?skill=assist`);
  await connect(page);
  await page.locator(`[data-testid="assist-copy-${assistantMessageId}"]`).waitFor({ timeout: 30_000 });
  const article = page.locator(`article.agent-message[data-role="ASSISTANT"]`).first();

  const read = (selector: string, index = 0) => article.locator(selector).nth(index).evaluate((node) => {
    const style = getComputedStyle(node);
    const box = node.getBoundingClientRect();
    return { fontSize: style.fontSize, lineHeight: style.lineHeight, fontWeight: style.fontWeight,
      marginTop: style.marginTop, marginBottom: style.marginBottom,
      color: style.color, decoration: style.textDecorationLine,
      borderLeftWidth: style.borderLeftWidth, paddingLeft: style.paddingLeft,
      background: style.backgroundColor, width: Math.round(box.width),
      scrollWidth: node.scrollWidth, clientWidth: node.clientWidth };
  });

  const body = await read(".assist-message-markdown .markdown-preview");
  expect(body.fontSize).toBe("16px");
  expect(body.lineHeight).toBe("27.2px");

  // 标题：回复里降一档（20 / 18 / 16），字重 600，首块不留上边距。
  const h1 = await read(".markdown-preview__heading", 0);
  expect(h1.fontSize).toBe("20px");
  expect(h1.fontWeight).toBe("600");
  expect(h1.marginTop).toBe("0px");
  const h2 = await read(".markdown-preview__heading", 1);
  expect(h2.fontSize).toBe("18px");
  expect(h2.marginTop).toBe("16px");
  expect(h2.marginBottom).toBe("8px");
  const h3 = await read(".markdown-preview__subheading", 0);
  expect(h3.fontSize).toBe("16px");
  expect(h3.fontWeight).toBe("600");

  // 块距统一 12px：段落、列表、引用、表格、代码块同一档。
  expect((await read(".markdown-preview__paragraph")).marginBottom).toBe("12px");
  expect((await read("ul.markdown-preview__list")).marginBottom).toBe("12px");
  expect((await read("blockquote.markdown-preview__quote")).marginBottom).toBe("12px");
  expect((await read(".markdown-preview__table-scroll")).marginBottom).toBe("12px");
  expect((await read(".msg-code")).marginBottom).toBe("12px");

  // 引用与行内代码：竖线 2px + 12px 缩进；行内代码有底色，颜色仍是正文色。
  const quote = await read("blockquote.markdown-preview__quote");
  expect(quote.borderLeftWidth).toBe("2px");
  expect(quote.paddingLeft).toBe("12px");
  const inline = await read("p.markdown-preview__paragraph code");
  expect(inline.background).not.toBe("rgba(0, 0, 0, 0)");

  // 表格在自己的滚动盒里，宽度不超过消息列；页面没有级联横向溢出。
  const tableBox = await read(".markdown-preview__table-scroll");
  expect(tableBox.width).toBeLessThanOrEqual(body.width);
  expect(tableBox.scrollWidth).toBeGreaterThanOrEqual(tableBox.clientWidth);

  // 链接仍然可辨认：颜色不同于正文，且有下划线。
  const link = await read(".markdown-preview__paragraph a");
  expect(link.color).not.toBe((await read(".markdown-preview__paragraph")).color);
  expect(link.decoration).toContain("underline");

  // 末块贴底：最后一段没有下边距，页脚紧跟其后。
  const last = await read(".markdown-preview > :last-child");
  expect(last.marginBottom).toBe("0px");

  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);

  await article.screenshot({ path: "D:/Develop/Relay-Agent/apps/workbench/results/assist-reply-06-long-chinese.png" });
});
