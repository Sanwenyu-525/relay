import { readFile } from "node:fs/promises";

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
const origin = `http://127.0.0.1:${process.env.RELAY_RAIL_TEST_PORT ?? "4173"}`;

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

async function install(page: Page, content = RICH): Promise<void> {
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
      message(assistantMessageId, "2", "ASSISTANT", content)] });
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

  // 表格在自己的滚动盒里，宽度不超过消息列；窄内容时铺满阅读列、不需要横向滚动。
  const tableBox = await read(".markdown-preview__table-scroll");
  expect(tableBox.width).toBeLessThanOrEqual(body.width);
  expect(tableBox.scrollWidth).toBe(tableBox.clientWidth);

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

/**
 * 表格里的标识符不许被劈开（2026-11-01 E2E-ALL-01 用户实机截图）。
 *
 * 上一轮之前，单元格吃 `overflow-wrap: anywhere` + 表格 `width: 100%`：长标识符被算成
 * 「一个字符也放得下」，于是 `list_directory` 显示成 `list_direct` + `ory`，
 * `SESSION_TOOL_BUDGET_EXHAUSTED` 更是断成三行——工具名是用户判断成败的唯一凭据，
 * 被切开就等于把结果说错了。这里不测 CSS 声明值，直接量文本矩形：
 * 一个标识符落在一行 = 只有一个矩形；断成两半就会给出两个矩形。
 *
 * 同时锁住另外三条边界：中文说明仍要自然换行（不能为了保标识符把整张表变成 nowrap）、
 * 字号不许为了宽度被调小、宽出来的部分只在表格自己的盒子里横向滚动，不外溢到页面。
 */
const IDENTIFIER_TABLE = [
  "这一轮的工具调用结果如下：",
  "",
  "| 工具 | 状态 | 额度 | 说明 |",
  "| --- | --- | --- | --- |",
  "| `SESSION_TOOL_BUDGET_EXHAUSTED` | 未执行 | `maxToolCalls=12` | 本轮读取额度已经用完，这一条没有发给网关，所以什么都没读到。 |",
  "| `list_directory` | 已结算 | `usedCalls=12` | 目录已绑定，返回四十二个条目。 |",
  "| apply_changeset | BLOCKED | `rejection_reason` | 没有可用的写入连接，动作被拒绝。 |"
].join("\n");

function measureTable(table: HTMLTableElement) {
  // 逐个 ASCII 词（≥6 字符，含工具名、状态词、错误码）用 Range 量它落在几行上。
  const walker = document.createTreeWalker(table, NodeFilter.SHOW_TEXT);
  const tokens: { text: string; lines: number }[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9_.]{5,}/gu)) {
      const start = match.index ?? 0;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + match[0].length);
      tokens.push({ text: match[0], lines: range.getClientRects().length });
    }
  }
  const cells = [...table.querySelectorAll("td")];
  return {
    tokens,
    // 中文说明格的行数：窄窗口里必须 > 1，否则说明我们把换行一起关掉了。
    proseLines: cells.map((cell) => {
      const range = document.createRange();
      range.selectNodeContents(cell);
      return range.getClientRects().length;
    }),
    fontSize: getComputedStyle(cells[0] ?? table).fontSize,
    tableWidth: Math.round(table.getBoundingClientRect().width),
    wrapWidth: Math.round(table.closest(".markdown-preview__table-scroll")?.clientWidth ?? 0)
  };
}

async function openIdentifierTable(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await install(page, IDENTIFIER_TABLE);
  await page.goto(`/projects/${projectId}?skill=assist`);
  await connect(page);
  await page.locator(`[data-testid="assist-copy-${assistantMessageId}"]`).waitFor({ timeout: 30_000 });
  const article = page.locator(`article.agent-message[data-role="ASSISTANT"]`).first();
  const body = article.locator(".assist-message-markdown .markdown-preview");
  const measured = await article.locator(".markdown-preview__table").first().evaluate(measureTable);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  return { article, body, measured, overflow };
}

test("表格窄窗口：标识符保持完整，中文照常换行，横向滚动只发生在表内", async ({ page }) => {
  const { article, body, measured, overflow } = await openIdentifierTable(page, 843);
  expect(measured.tokens.length).toBeGreaterThanOrEqual(4);
  for (const token of measured.tokens) expect(token.lines, token.text).toBe(1);
  // 字号仍是正文 body 档：宽度问题不用缩字解决。
  expect(measured.fontSize).toBe("16px");
  // 表格按内容变宽并超出滚动盒 → 多出来的宽度交给表自己的横向滚动条。
  expect(measured.tableWidth).toBeGreaterThan(measured.wrapWidth);
  expect(Math.round((await body.boundingBox())?.width ?? 0)).toBeGreaterThanOrEqual(measured.wrapWidth);
  // 中文说明格确实还在换行（没有整表 nowrap）。
  expect(Math.max(...measured.proseLines)).toBeGreaterThan(1);
  expect(overflow).toBeLessThanOrEqual(1);
  await article.screenshot({ path: "D:/Develop/Relay-Agent/tmp/E2E-ALL-01-remediation/markdown-table-narrow.png" });
});

test("表格常规窗口：标识符不被劈开，滚动盒也不把消息列撑宽", async ({ page }) => {
  const { article, body, measured, overflow } = await openIdentifierTable(page, 1270);
  for (const token of measured.tokens) expect(token.lines, token.text).toBe(1);
  // 撑宽的是表格自己，不是这一列：滚动盒始终等于正文宽度，页面不出级联横向滚动条。
  expect(measured.wrapWidth).toBeLessThanOrEqual(Math.round((await body.boundingBox())?.width ?? 0));
  expect(overflow).toBeLessThanOrEqual(1);
  await article.screenshot({ path: "D:/Develop/Relay-Agent/tmp/E2E-ALL-01-remediation/markdown-table-normal.png" });
});

/**
 * 主题口径（2026-11-01 全链路整改补）。
 *
 * 产品当前只有一套（浅色）主题令牌：`SafeMarkdown.css` 里没有 `color-scheme`，工作台也没有
 * 深色开关，只有场景实验室的外壳有 `data-theme="dark"`。所以「明暗主题都正确」这一项在真实
 * 应用里无法逐项量色——能钉住的是它**不依赖**某个主题：配色一律走令牌，将来令牌换深色，
 * 正文与表格不会留下写死的颜色。这条静态断言就是那件可验证的事。
 */
test("正文与表格的配色只走令牌：没有写死的颜色等着被主题出卖", async () => {
  const css = await readFile(new URL("../../src/components/SafeMarkdown.css", import.meta.url), "utf8");
  expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/u);
  expect(css).not.toMatch(/\brgba?\(/u);
  expect(css).not.toMatch(/\bhsla?\(/u);
  // 表格本次改的那一段（表身 + 单元格）必须留在令牌上，否则主题一换就会出现两套对比度。
  expect(css).toMatch(
    /\.markdown-preview__table th,\s*\.markdown-preview__table td \{[\s\S]*?border-bottom:\s*var\(--relay-border-width\) solid var\(--relay-color-border-separator\)/u,
  );
});

