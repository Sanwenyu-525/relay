import { expect, test, type Page, type Route } from "@playwright/test";
import { MARKDOWN_RICH } from "../../src/dev/scenarioFixtures";

/**
 * 正式会话 ↔ 场景实验室：同一回复场景的双环境一致性对照。
 *
 * 为什么需要这一份：实验室的断言只能证明「实验室里长这样」，证明不了「和用户看到的一样」。
 * 两处都挂着 `AssistMessageRow`，但父容器不同（`agent-chat-transcript → agent-chat-content
 * → agent-message-list` vs `scenario-lab-preview-scroll → scenario-shell → agent-message-list`），
 * 父容器的宽度约束、`--chat-measure` 覆盖和实验室专属 CSS 都可能把同一份组件改样。
 * 所以这里让两边渲染**同一份内容、同一状态、同一窗口宽度**，再逐项比对几何与计算样式。
 *
 * 两边内容同源：真实会话那一侧的消息正文直接取实验室场景 A07 用的那份夹具
 * （`MARKDOWN_RICH`），不另写一份「差不多」的字符串——两份文案一旦分叉，对照就没有意义。
 *
 * 只比回复内容及其必要上下文。实验室的目录、播放条、检查面板是调试外壳，不参与比较；
 * 单帧场景在舞台里垂直居中也是刻意保留的开发工具行为，因此纵向只比「相对位置」与间距，
 * 不比绝对 Y。
 */

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const sessionId = "66666666-6666-4666-8666-666666666666";
const resourceId = "88888888-8888-4888-8888-888888888888";
const userMessageId = "c1111111-1111-4111-8111-111111111111";
const assistantMessageId = "c2222222-2222-4222-8222-222222222222";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = `http://127.0.0.1:${process.env.RELAY_RAIL_TEST_PORT ?? "4173"}`;

/** 实验室 A07 用的就是这份正文（`scenarios/lifecycle.ts`），两边因此逐字同源。 */
const REPLY = MARKDOWN_RICH;
/** `pair()` 的默认用户话术，A07 也用这一句。 */
const USER_TEXT = "把这次的改动过程说清楚";
/** A07：单帧、浅色、终态正文（Markdown 标题 / 有序列表 / 引用 / 表格 / 代码块）。 */
const SCENARIO = "A07";

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
  message(userMessageId, "1", "USER", USER_TEXT),
  message(assistantMessageId, "2", "ASSISTANT", REPLY)
];

const modelRuntimePath = /\/assist-messages\/([^/]+)\/model-runtime$/u;
const modelRuntimeBody = (messageId: string): unknown => ({ message_id: messageId,
  message_status: "COMPLETED", snapshot_available: false, preferred_model: null, candidate_models: [],
  current_candidate_model: null, actual_model: null, max_candidates: null, routing_status: null,
  failure_scope: null, failure_reason: null, retry_after_at: null, free_daily_remaining: null,
  switches: [], calls: [] });

/** API 全部由 page.route 伪造：不连数据库、不调 Provider、不写任何真实业务事实。 */
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
      status: "UNSET", reason: null, revision: "0" });
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
  await page.locator('input[name="relay-bearer-token"]').fill("scenario-lab-parity-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

/** 真实会话：走用户真实入口（项目页的 assist 视图），等正文读回。 */
async function openProduct(page: Page): Promise<void> {
  await installRoutes(page);
  await page.goto(`/projects/${projectId}?skill=assist`);
  await connect(page);
  await page.locator(`[data-testid="assist-copy-${assistantMessageId}"]`).waitFor({ timeout: 30_000 });
}

/** 实验室：深链直达同一条场景，等预览挂上产品组件。 */
async function openLab(page: Page, query = `?scenario=${SCENARIO}`): Promise<void> {
  await page.goto(`/__dev/assist-scenarios${query}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-scenario-lab]")).toBeVisible();
  await expect(page.locator("[data-scenario-preview]")).toBeVisible();
  await expect(page.locator(".agent-message-list article.agent-message[data-role='ASSISTANT']").first())
    .toBeVisible();
}

type Metrics = {
  readonly list: { readonly x: number; readonly width: number; readonly gap: string; readonly maxWidth: string };
  readonly assistant: { readonly x: number; readonly width: number; readonly height: number };
  readonly user: { readonly x: number; readonly width: number };
  readonly markdown: {
    readonly fontSize: string; readonly lineHeight: string; readonly color: string;
    readonly maxWidth: string; readonly width: number;
  };
  readonly paragraph: { readonly marginTop: string; readonly marginBottom: string };
  readonly heading: { readonly fontSize: string; readonly fontWeight: string; readonly color: string };
  readonly quote: { readonly borderLeftColor: string; readonly borderLeftWidth: string; readonly color: string };
  readonly meta: { readonly fontSize: string; readonly color: string; readonly gap: string };
  readonly replyState: string | null;
  readonly chatMeasure: string;
  readonly openTrajectoryEntries: number;
};

/**
 * 量同一组事实：阅读列几何、正文排版、块间距、状态标记。
 *
 * `root` 让两边各用自己那条路径的容器（真实会话是消息列表，实验室是预览外壳），
 * 但量的选择器是产品自己的类名——实验室没有另一套。
 */
async function measure(page: Page, root: string): Promise<Metrics> {
  return page.evaluate((scope) => {
    const host = document.querySelector(scope);
    if (host === null) throw new Error(`找不到容器：${scope}`);
    const list = host.querySelector(".agent-message-list");
    const assistant = host.querySelector("article.agent-message[data-role='ASSISTANT']");
    const user = host.querySelector("article.agent-message[data-role='USER']");
    if (list === null || assistant === null || user === null) {
      throw new Error(`容器 ${scope} 里没有完整的消息列表`);
    }
    const markdown = assistant.querySelector(".assist-message-markdown");
    const paragraph = assistant.querySelector(".markdown-preview__paragraph");
    const heading = assistant.querySelector("[data-heading-level]");
    const quote = assistant.querySelector("blockquote.markdown-preview__quote");
    const meta = assistant.querySelector(".agent-message-meta");
    const reply = assistant.querySelector(".assist-reply");
    if (markdown === null || paragraph === null || heading === null || quote === null || meta === null) {
      throw new Error("助手正文缺少 Markdown 结构");
    }
    const box = (node: Element) => node.getBoundingClientRect();
    const style = (node: Element) => getComputedStyle(node);
    const listStyle = style(list);
    const markdownStyle = style(markdown);
    const paragraphStyle = style(paragraph);
    const headingStyle = style(heading);
    const quoteStyle = style(quote);
    const metaStyle = style(meta);
    return {
      list: { x: box(list).x, width: box(list).width, gap: listStyle.rowGap,
        maxWidth: listStyle.maxWidth },
      assistant: { x: box(assistant).x, width: box(assistant).width, height: box(assistant).height },
      user: { x: box(user).x, width: box(user).width },
      markdown: { fontSize: markdownStyle.fontSize, lineHeight: markdownStyle.lineHeight,
        color: markdownStyle.color, maxWidth: markdownStyle.maxWidth, width: box(markdown).width },
      paragraph: { marginTop: paragraphStyle.marginTop, marginBottom: paragraphStyle.marginBottom },
      heading: { fontSize: headingStyle.fontSize, fontWeight: headingStyle.fontWeight,
        color: headingStyle.color },
      quote: { borderLeftColor: quoteStyle.borderLeftColor,
        borderLeftWidth: quoteStyle.borderLeftWidth, color: quoteStyle.color },
      meta: { fontSize: metaStyle.fontSize, color: metaStyle.color, gap: metaStyle.columnGap },
      replyState: reply === null ? null : reply.getAttribute("data-state"),
      // 阅读列宽度那一档只认产品定义在 `.embedded-assist` / `.agent-assist` 上的值：
      // 实验室若自己覆盖 `--chat-measure`，这里立刻不等。
      chatMeasure: getComputedStyle(host).getPropertyValue("--chat-measure").trim(),
      openTrajectoryEntries: host.querySelectorAll("[data-testid='execution-summary-open']").length
    };
  }, root);
}

/** 像素级几何允许的抖动：两边同宽同字体，只允许子像素取整差异。 */
const EPSILON = 1;

test.describe("正式会话 ↔ 场景实验室 一致性", () => {
  test("同一回复场景：阅读列、正文排版、块距与状态标记逐项一致", async ({ page }) => {
    // 1600 宽：两边都拿得到完整 46.5rem 阅读列，比较的是「同一档宽度」而不是「各自被挤到多宽」。
    await page.setViewportSize({ width: 1600, height: 900 });

    await openProduct(page);
    const product = await measure(page, ".agent-chat-transcript");

    await openLab(page);
    const lab = await measure(page, "[data-scenario-preview]");

    // ① 阅读列：宽度、列间距、max-width 同一档。
    expect(Math.abs(product.list.width - lab.list.width),
      `阅读列宽度必须一致：产品 ${product.list.width} / 实验室 ${lab.list.width}`).toBeLessThanOrEqual(EPSILON);
    expect(lab.list.gap, "消息之间的间距必须同源").toBe(product.list.gap);
    expect(lab.list.maxWidth, "阅读列上限必须同源").toBe(product.list.maxWidth);

    // ② 消息几何：助手行占满阅读列，用户行右对齐且同宽。
    expect(Math.abs(product.assistant.width - lab.assistant.width),
      `助手消息宽度：产品 ${product.assistant.width} / 实验室 ${lab.assistant.width}`).toBeLessThanOrEqual(EPSILON);
    expect(Math.abs((product.assistant.x - product.list.x) - (lab.assistant.x - lab.list.x)),
      "助手消息相对阅读列的左缘必须一致").toBeLessThanOrEqual(EPSILON);
    expect(Math.abs(product.user.width - lab.user.width),
      `用户消息宽度：产品 ${product.user.width} / 实验室 ${lab.user.width}`).toBeLessThanOrEqual(EPSILON);

    // ③ 正文排版：字号、行高、颜色、正文块宽。
    expect(lab.markdown.fontSize, "正文字号必须一致").toBe(product.markdown.fontSize);
    expect(lab.markdown.lineHeight, "正文行高必须一致").toBe(product.markdown.lineHeight);
    expect(lab.markdown.color, "正文颜色必须一致").toBe(product.markdown.color);
    expect(Math.abs(product.markdown.width - lab.markdown.width),
      `正文块宽度：产品 ${product.markdown.width} / 实验室 ${lab.markdown.width}`).toBeLessThanOrEqual(EPSILON);

    // ④ Markdown 块：段落间距、标题档位、引用块描边。
    expect(lab.paragraph.marginTop, "段落上边距必须一致").toBe(product.paragraph.marginTop);
    expect(lab.paragraph.marginBottom, "段落下边距必须一致").toBe(product.paragraph.marginBottom);
    expect(lab.heading.fontSize, "标题字号必须一致").toBe(product.heading.fontSize);
    expect(lab.heading.fontWeight, "标题字重必须一致").toBe(product.heading.fontWeight);
    expect(lab.quote.borderLeftColor, "引用块描边颜色必须一致").toBe(product.quote.borderLeftColor);
    expect(lab.quote.borderLeftWidth, "引用块描边宽度必须一致").toBe(product.quote.borderLeftWidth);

    // ⑤ 状态行与状态标记：同一状态不能在两处写成两档。
    expect(lab.meta.fontSize, "meta 行字号必须一致").toBe(product.meta.fontSize);
    expect(lab.meta.color, "meta 行颜色必须一致").toBe(product.meta.color);
    expect(lab.meta.gap, "meta 行间距必须一致").toBe(product.meta.gap);
    expect(lab.replyState, "回复状态档必须一致").toBe(product.replyState);
    expect(product.replyState, "对照前提：两边都在「最终正文」这一档").toBe("final");

    // ⑥ 阅读列宽度 token 只有一处定义：实验室不得自己改一档。
    expect(lab.chatMeasure, `实验室不得覆盖 --chat-measure（产品 ${product.chatMeasure}）`)
      .toBe(product.chatMeasure);

    // ⑦ 正式会话没传 `onOpenTrajectory`，两边都不该有那颗入口。
    expect(product.openTrajectoryEntries, "正式会话本来就没有「查看逐步轨迹」入口").toBe(0);
    expect(lab.openTrajectoryEntries, "实验室不得为空回调造一颗假入口").toBe(0);
  });

  test("窄窗档只模拟窗口宽度，不改产品的阅读列规则", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await openLab(page);
    const wide = await measure(page, "[data-scenario-preview]");

    const inspector = page.locator("[data-testid='scenario-inspector-toggle']");
    if ((await inspector.getAttribute("aria-expanded")) !== "true") await inspector.click();
    await page.locator("[data-testid='scenario-inspector-tab-display']").click();
    await page.locator("[data-testid='scenario-viewport-narrow']").click();
    await expect(page.locator("[data-scenario-preview]")).toHaveAttribute("data-viewport", "narrow");

    const narrow = await measure(page, "[data-scenario-preview]");
    // 900px 窗口下 46.5rem（744px）仍放得下，因此阅读列宽度不变——这正是产品在真实 900px
    // 窗口里的行为。旧实现把 measure 改成 30rem，等于给实验室另造了一档更窄的列。
    expect(narrow.chatMeasure, "窄窗档不得改写 --chat-measure").toBe(wide.chatMeasure);
    expect(Math.abs(narrow.list.width - wide.list.width),
      `900px 窗口下阅读列仍应是 744px：${narrow.list.width}`).toBeLessThanOrEqual(EPSILON);
    // 模拟窗口本身确实变窄了（否则这一档什么也没验）。窗口宽度按「舞台可用宽度」夹住，
    // 宽屏下应恰好等于 900px；屏幕不够宽时等于可用宽度，此时列宽也随产品规则一起收窄。
    const box = await page.evaluate(() => {
      const canvas = document.querySelector(".scenario-lab-preview-canvas");
      const shell = document.querySelector("[data-scenario-preview]");
      const canvasStyle = canvas === null ? null : getComputedStyle(canvas);
      const available = canvas === null ? 0
        : canvas.getBoundingClientRect().width
          - Number.parseFloat(canvasStyle?.paddingLeft ?? "0")
          - Number.parseFloat(canvasStyle?.paddingRight ?? "0");
      return { shell: shell?.getBoundingClientRect().width ?? 0, available };
    });
    expect(Math.round(box.shell), `窄窗档模拟的是 ${String(Math.min(900, box.available))}px 窗口`)
      .toBe(Math.round(Math.min(900, box.available)));

    await page.locator("[data-testid='scenario-viewport-phone']").click();
    await expect(page.locator("[data-scenario-preview]")).toHaveAttribute("data-viewport", "phone");
    const phone = await measure(page, "[data-scenario-preview]");
    const phoneShell = await page.locator("[data-scenario-preview]").evaluate((node) => node.getBoundingClientRect().width);
    expect(Math.round(phoneShell), "手机宽档模拟的是 560px 窗口").toBe(560);
    // 560px 窗口里阅读列被可用宽度夹住：列宽 = 窗口宽，不再是 744。
    expect(Math.abs(phone.list.width - 560), `560px 窗口里阅读列应等于窗口宽：${phone.list.width}`)
      .toBeLessThanOrEqual(EPSILON);
    expect(phone.chatMeasure, "手机宽档同样不得改写 --chat-measure").toBe(wide.chatMeasure);
  });

  test("执行摘要：产品不传 onOpenTrajectory 时，实验室也不出现那颗入口", async ({ page }) => {
    // 产品侧（`AssistView.tsx` 里挂 `ExecutionTrajectorySummary` 的那一处）只传 client / runId /
    // revision，从不传 `onOpenTrajectory`，所以摘要里没有「查看逐步轨迹」。真实会话要复现
    // 「一条用户消息带 Run 摘要」需要伪造执行摘要投影，代价高且会引入第二套事实来源，
    // 因此这一条只在实验室侧断言「同一条件下也不该有这颗入口」，产品侧以源码条件为准。
    await page.setViewportSize({ width: 1600, height: 900 });
    await openLab(page, "?scenario=D16");
    const summary = page.locator("[data-testid='execution-summary']");
    await expect(summary, "D16 的 Run 摘要必须在场，否则这条断言是空的").toBeVisible();
    await expect(summary.locator("[data-testid='execution-summary-open']"),
      "产品没有这个回调，实验室不能凭空补一颗点不动的入口").toHaveCount(0);
  });

  test("回退文件这类真实副作用：实验室明说不执行，不伪造成功", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await openLab(page, "?scenario=A01");

    // 产品在「用户消息已完成、尚未撤回」时给出回退入口；实验室照同一条件渲染。
    const recall = page.locator("article.agent-message[data-role='USER'] [data-testid^='assist-recall-action-']").first();
    await expect(recall, "回退入口按产品的条件出现，不是实验室额外加的").toHaveCount(1);
    await recall.click({ force: true });

    const notice = page.locator("[data-testid='scenario-lab-notice']");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("不执行真实文件回退");
    // 提示不是成功回执：不能出现「已回退」这种产品在真实执行后才会说的话。
    await expect(notice).not.toContainText("已回退");
  });
});
