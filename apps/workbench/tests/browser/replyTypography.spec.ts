import { expect, test, type Page, type Route } from "@playwright/test";
import fs from "node:fs";

// 2026-10-20 用户「我想做好看的回复」：回复正文的排版锁。
// 用户在同一张截图里先要求把那条 AI 回复「复现一下」，再要求把回复做好看。这里把改后
// 的口径按**真实渲染**锁住——正文档位、行高、块间距、列表记号与强调字重都会在样式表
// 增删时静默漂移，单测（jsdom）量不到计算样式。
// API 全部由 page.route 伪造，不连数据库、不调 Provider、不写任何真实业务事实。
// 2026-10-22 接续 DEV-0109（用户「ai回复怎么都是一个颜色？」）：第三条用例钉住行内代码这一处
// ——它有底色、但文字颜色仍是正文色，且代码块内部不叠第二层底。

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const sessionId = "66666666-6666-4666-8666-666666666666";
const resourceId = "88888888-8888-4888-8888-888888888888";
const userMessageId = "c1111111-1111-4111-8111-111111111111";
const assistantMessageId = "c2222222-2222-4222-8222-222222222222";
const richMessageId = "c4444444-4444-4444-8444-444444444444";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = "http://127.0.0.1:4173";

/** 截图里那条回复的原文：一句结论 + 粗体引子 + 四条列表 + 一句收尾。 */
const REPLY = [
  "已在受管根目录创建 aa.md。内容是一个简单的占位文档，记录了当前 Git 状态摘要。",
  "",
  "**当前状态：**",
  "- 分支：main",
  "- HEAD：119f51dc",
  "- 未暂存改动文件很多（未提交工作量大）",
  "- 未跟踪文件也有不少（新功能模块：memory、plugins 等）",
  "",
  "文件已提交为执行候选，待系统执行阶段写入磁盘。"
].join("\n");

/** 覆盖其余块型：标题、行内代码、fence、有序列表、引用。 */
const RICH = [
  "### 接下来可以这样做",
  "把 `aa.md` 打开核对一遍，再决定要不要补一段摘要。",
  "",
  "```bash",
  "git status --short",
  "```",
  "",
  "1. 打开 `aa.md` 核对正文",
  "2. 需要我补一段摘要时直接说",
  "",
  "> 引用块在回复里也会出现，样式同样要能读。"
].join("\n");

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(), body: JSON.stringify(body) });
}

const session = { id: sessionId, workspace_id: workspaceId, project_id: projectId, task_id: null,
  title: "关于Relay-Agent", status: "ACTIVE", revision: "1", conversation_mode: "AGENT",
  assistant_profile_id: null, working_resource_id: resourceId,
  context: { project_goals: [], working_directory: { resource_id: resourceId,
    canonical_root: "D:\\Develop\\Relay-Agent" } },
  created_at: "2026-10-20T13:00:00Z", updated_at: "2026-10-20T13:00:00Z" };

function message(id: string, seq: string, role: "USER" | "ASSISTANT", content: string) {
  return { id, session_id: sessionId, seq, role, status: "COMPLETED", intent: "DISCUSS", content,
    error_code: null, provider_error_kind: null, sources: [], skill: null, cancel_requested: false,
    steer_requested: false, attachments: [], created_at: "2026-10-20T13:36:00Z",
    updated_at: "2026-10-20T13:36:00Z",
    usage: { input_tokens: 44544, output_tokens: 365, cache_read_tokens: null,
      cache_creation_tokens: null } };
}

const messages = [
  message(userMessageId, "1", "USER", "你在根目录写一个 aa.md内容不限"),
  message(assistantMessageId, "2", "ASSISTANT", REPLY),
  message(richMessageId, "4", "ASSISTANT", RICH)
];

const modelRuntimePath = /\/assist-messages\/([^/]+)\/model-runtime$/u;
const modelRuntimeBody = (messageId: string): unknown => ({ message_id: messageId,
  message_status: "COMPLETED", snapshot_available: false, preferred_model: null, candidate_models: [],
  current_candidate_model: null, actual_model: null, max_candidates: null, routing_status: null,
  failure_scope: null, failure_reason: null, retry_after_at: null, free_daily_remaining: null,
  switches: [], calls: [] });

async function installRoutes(page: Page): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/projects/${projectId}`) return fulfillJson(route, { id: projectId,
      title: "Relay-Agent", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
    if (path === `${prefix}/projects/${projectId}/state`) return fulfillJson(route, { project_id: projectId,
      revision: "1", phase_key: "GENERAL", next_action_task_id: null,
      selected_artifact_version_refs: [], completed_highlight_refs: [] });
    if (path === `${prefix}/model-port`) return fulfillJson(route, { provider: "fake",
      configured: false, model: null, base_url: null, max_call_tokens: null });
    if (path === `${prefix}/default-working-directory`) return fulfillJson(route, { resource_id: null,
      canonical_root: null, display_name: null, write_tier: null, default_write_tier: null,
      status: "UNSET", reason: null,
      revision: "0" });
    if (path === `${prefix}/assist-sessions`) return fulfillJson(route, { items: [session] });
    if (path === `${prefix}/assist-sessions/${sessionId}`) return fulfillJson(route, session);
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return fulfillJson(route, { items: messages });
    if (path.includes("conversation-diff")) return fulfillJson(route, { session_id: sessionId, files: [],
      unavailable_files: 0, unverifiable_files: 0, baseline: null, incomplete: false });
    const runtime = modelRuntimePath.exec(path);
    if (runtime) return fulfillJson(route, modelRuntimeBody(decodeURIComponent(runtime[1])));
    return fulfillJson(route, { items: [], next_cursor: null });
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

test("回复正文的排版：16px/1.7、实心记号、统一块距", async ({ page }) => {
  await page.setViewportSize({ width: 1270, height: 900 });
  await installRoutes(page);
  await page.goto(`/projects/${projectId}?skill=assist`);
  await connect(page);
  await page.locator(`[data-testid="assist-copy-${assistantMessageId}"]`).waitFor({ timeout: 30_000 });

  const article = page.locator(`article.agent-message[data-role="ASSISTANT"]`).first();
  const style = (selector: string) => article.locator(selector).first().evaluate((node) => {
    const computed = getComputedStyle(node);
    return { fontSize: computed.fontSize, lineHeight: computed.lineHeight,
      marginBottom: computed.marginBottom, marginTop: computed.marginTop,
      listStyleType: computed.listStyleType, fontWeight: computed.fontWeight,
      paddingLeft: computed.paddingLeft };
  });

  const body = await style(".assist-message-markdown .markdown-preview");
  // 16px = font.size.body；行高 27.2 = 16 × 1.7（lineHeight.relaxed）。
  expect(body.fontSize).toBe("16px");
  expect(body.lineHeight).toBe("27.2px");

  const paragraph = await style(".markdown-preview__paragraph");
  expect(paragraph.marginBottom).toBe("12px"); // space.3

  const list = await style("ul.markdown-preview__list");
  expect(list.listStyleType).toBe("disc");
  expect(list.paddingLeft).toBe("16px"); // space.4

  const item = await article.locator("ul.markdown-preview__list li").nth(1).evaluate((node) => {
    const computed = getComputedStyle(node);
    return { marginTop: computed.marginTop };
  });
  expect(item.marginTop).toBe("4px"); // space.1

  const strong = await style(".markdown-preview__paragraph strong");
  expect(strong.fontWeight).toBe("600"); // semibold，不是 UA 的 700

  // 用户消息与 AI 回复同一档正文档：16px。
  const userBubble = await page.locator(`article.agent-message[data-role="USER"] .assist-message-content`)
    .first().evaluate((node) => getComputedStyle(node).fontSize);
  expect(userBubble).toBe("16px");
});

test("引用块与有序列表：`>` 不再原样显示，序号与文字各归其位", async ({ page }) => {
  await page.setViewportSize({ width: 1270, height: 900 });
  await installRoutes(page);
  await page.goto(`/projects/${projectId}?skill=assist`);
  await connect(page);
  await page.locator(`[data-testid="assist-copy-${richMessageId}"]`).waitFor({ timeout: 30_000 });

  const rich = page.locator(`article.agent-message[data-role="ASSISTANT"]`).last();
  const quote = rich.locator("blockquote.markdown-preview__quote");
  await expect(quote).toHaveCount(1);
  await expect(quote).toHaveText("引用块在回复里也会出现，样式同样要能读。");
  await expect(rich.locator(".markdown-preview")).not.toContainText("> 引用块");
  const quoteStyle = await quote.evaluate((node) => {
    const computed = getComputedStyle(node);
    return { borderLeftWidth: computed.borderLeftWidth, paddingLeft: computed.paddingLeft,
      color: computed.color };
  });
  expect(quoteStyle.borderLeftWidth).toBe("2px");
  expect(quoteStyle.paddingLeft).toBe("12px"); // space.3

  const ordered = rich.locator("ol.markdown-preview__list");
  await expect(ordered).toHaveCount(1);
  const orderedStyle = await ordered.evaluate((node) => {
    const computed = getComputedStyle(node);
    return { paddingLeft: computed.paddingLeft, listStyleType: computed.listStyleType };
  });
  expect(orderedStyle.listStyleType).toBe("decimal");
  expect(orderedStyle.paddingLeft).toBe("24px"); // space.6
});

/**
 * DEV-0109（2026-10-22 用户「ai回复怎么都是一个颜色？是因为其他情况还没有出现吗？」）。
 * 这条不是一套新配色，而是把「回复正文里唯一一处只靠字形区分的东西」钉住：行内代码此前与正文
 * 同色同底。断言按**计算样式**读，颜色仍等于正文色（层级由底色说出，不新增第五种文字色），
 * 底色与代码块同一档 token，代码块内部的 `<code>` 不再叠第二层底。
 */
test("行内代码有自己的底色，但颜色仍是正文色；代码块内部不叠第二层底", async ({ page }) => {
  await page.setViewportSize({ width: 1270, height: 900 });
  await installRoutes(page);
  await page.goto(`/projects/${projectId}?skill=assist`);
  await connect(page);
  await page.locator(`[data-testid="assist-copy-${richMessageId}"]`).waitFor({ timeout: 30_000 });

  const rich = page.locator(`article.agent-message[data-role="ASSISTANT"]`).last();
  const inline = rich.locator("p.markdown-preview__paragraph code");
  await expect(inline).toHaveText("aa.md");
  const read = (locator: typeof inline) => locator.evaluate((node) => {
    const computed = getComputedStyle(node);
    return { backgroundColor: computed.backgroundColor, color: computed.color,
      paddingInline: computed.paddingInlineStart, borderRadius: computed.borderRadius };
  });
  const inlineStyle = await read(inline);
  const paragraph = await rich.locator("p.markdown-preview__paragraph").first()
    .evaluate((node) => getComputedStyle(node).color);
  // 参照物取用户气泡：它的底色就是 bg.subtle（本文件第一条用例同档），不用硬编码色值。
  const userBubble = await page.locator(`article.agent-message[data-role="USER"] .assist-message-content`)
    .first().evaluate((node) => getComputedStyle(node).backgroundColor);

  // 行内代码：有底、有圆角、左右各 space.1；正文色不变。
  expect(inlineStyle.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(inlineStyle.backgroundColor).toBe(userBubble); // 同一档 bg.subtle，不另取一色
  expect(inlineStyle.color).toBe(paragraph);
  expect(inlineStyle.paddingInline).toBe("4px");
  expect(inlineStyle.borderRadius).toBe("8px");
  // 有序列表里的行内代码同样吃到这一档（`li > code`）。
  expect(await rich.locator("ol.markdown-preview__list code").first()
    .evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(userBubble);
  // 代码块内部的 `<code>` 不叠第二层底：消息里的 fence 是可复制块（.msg-code），
  // 它的底色由外层说，选择器 `:not(pre) > code` 必须把它排除掉。
  const codeInBlock = await rich.locator(".msg-code-body code")
    .evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(codeInBlock).toBe("rgba(0, 0, 0, 0)");
  // 留一张整条回复的图，供工单对照（与断言同源，不另开一次会话）。
  fs.mkdirSync("D:/Develop/Relay-Agent/output/dev-0109-screenshots", { recursive: true });
  await rich.screenshot({ path: "D:/Develop/Relay-Agent/output/dev-0109-screenshots/assistant-reply.png" });
});
