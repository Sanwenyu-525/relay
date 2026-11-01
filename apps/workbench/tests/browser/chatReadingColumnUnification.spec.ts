import { expect, test, type Page, type Route } from "@playwright/test";
import fs from "node:fs";
import { resolve } from "node:path";

/**
 * 聊天阅读列统一宽度（2026-10-31 UI 修复）。
 *
 * 口径：**所有属于聊天内容的块都以输入卡的宽度为布局基准**，Canvas 只负责滚动、
 * 定位与浮层，不再决定普通内容卡片的宽度。此前 `.execution-summary`（执行准备面板）
 * 是会话列里唯一铺满 Canvas 的内容块：1440 视口下实测比输入卡宽 124px，左右各溢出 62px。
 *
 * 这里量真实 Chromium 的盒子，不连数据库、不调 Provider：API 全部由 page.route 伪造，
 * 页面只读渲染，不产生任何写请求。截图是给人复核的证据，断言是回归的闸门。
 */

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const sessionId = "66666666-6666-4666-8666-666666666666";
const resourceId = "88888888-8888-4888-8888-888888888888";
const sourceMessageId = "c1111111-1111-4111-8111-111111111111";
const prefix = `/api/v1/workspaces/${workspaceId}`;
// 端口跟着 RELAY_E2E_PORT 走：本机 4173 可能被别的项目的预览服务占着（playwright.config.ts 同一条理由）。
const origin = `http://127.0.0.1:${process.env.RELAY_E2E_PORT ?? "4173"}`;

/** 证据目录：仓库根 tmp/UI-chat-reading-column-unification/screenshots。 */
const shotDir = resolve(import.meta.dirname, "../../../../tmp/UI-chat-reading-column-unification/screenshots");
/** 量到的盒子按行追加落盘，验收报告里的「修复前 / 修复后」数字直接取自这里。 */
const boxDir = resolve(import.meta.dirname, "../../../../tmp/UI-chat-reading-column-unification/test-results");

// 首屏 Vite 冷启动可能超过默认 30s；只放宽编译等待，不放宽任何产品时序断言。
test.setTimeout(120_000);

type ExecutionStatus = "READY" | "FAILED" | "CLARIFY" | "TASK_PREPARED";

interface State {
  status: ExecutionStatus;
  /** 长路径：验证路径换行不把卡片顶出阅读列。 */
  longPath: boolean;
  messages: number;
  /** 计划/目标投影读取失败时的那条告警卡：也是会话列里的普通内容块。 */
  projectionError: boolean;
}

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(), body: JSON.stringify(body) });
}

function sessionRow(): unknown {
  return { id: sessionId, workspace_id: workspaceId, project_id: projectId, task_id: null,
    title: "阅读列宽度验收", status: "ACTIVE", revision: "1", conversation_mode: "AGENT",
    assistant_profile_id: null, working_resource_id: resourceId,
    context: { project_goals: [], working_directory: { resource_id: resourceId,
      canonical_root: "D:\\Work\\Relay\\Projects\\reading-column-verification" } },
    created_at: "2026-10-31T10:00:00Z", updated_at: "2026-10-31T10:00:00Z" };
}

function messageRow(id: string, seq: string, role: "USER" | "ASSISTANT", content: string): unknown {
  return { id, session_id: sessionId, role, status: "COMPLETED", seq, intent: "DISCUSS", content,
    error_code: null, provider_error_kind: null, sources: [], skill: null, cancel_requested: false,
    created_at: "2026-10-31T10:00:00Z", updated_at: "2026-10-31T10:01:00Z",
    usage: { input_tokens: 2186, output_tokens: 71, cache_read_tokens: null, cache_creation_tokens: null } };
}

function messagesBody(state: State): unknown {
  const items = [
    messageRow("u-1", "1", "USER", "把这段布局按输入框那一列收一下，别铺满整个聊天区。"),
    messageRow("x-1", "2", "ASSISTANT",
      "好，我先核对会话列里哪些块用了画布宽度，再统一到同一根阅读列轴线。"),
  ];
  if (state.messages > 2) {
    items.push(messageRow("u-2", "3", "USER", "顺便确认窄窗和执行中不会横向滚动。"));
    items.push(messageRow("x-2", "4", "ASSISTANT",
      "窄窗会按 100% 收缩；长路径只在卡片内部换行，不会产生横向滚动条。"));
  }
  return { items };
}

function executionBody(state: State): unknown {
  const changes = state.longPath
    ? [{ action: "MODIFY", path: "apps/workbench/src/components/ConversationExecutionPreparationSummaryPresentation.tsx" },
      { action: "CREATE", path: "docs/frontend/reading-column-width-verification-notes-2026-10-31.md" }]
    : [{ action: "MODIFY", path: "apps/workbench/src/views/AssistView.css" }];
  const decision = state.status === "CLARIFY" ? "CLARIFY" : "PREPARE";
  return { items: [{ request_id: "e1111111-1111-4111-8111-111111111111",
    session_id: sessionId, source_message_id: sourceMessageId, decision,
    status: state.status === "CLARIFY" ? "CLARIFY" : state.status,
    candidate_status: state.status === "CLARIFY" ? "NOT_READY" : "READY",
    root_path: "D:\\Work\\Relay\\Projects\\reading-column-verification",
    resource_id: resourceId,
    questions: state.status === "CLARIFY" ? ["要收的是哪一列：消息区、输入器，还是两者一起？"]
      : state.status === "FAILED" ? ["缺少可写目录的连接：先在目录细条里完成绑定，再继续原请求。"] : [],
    auto_start: false, revision: "2", task_id: null, run_id: null,
    candidate: decision === "CLARIFY" ? null : {
      title: "统一聊天阅读列宽度",
      objective: "让执行准备面板与输入器同宽同轴，长路径在卡片内部换行，不产生横向溢出。",
      file_changes: changes } }] };
}

async function installRoutes(page: Page, state: State): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/projects/${projectId}`) return fulfillJson(route, { id: projectId,
      title: "人机协作工作流研究", project_type: "GENERAL", revision: "1", state_revision: "1",
      archived_at: null });
    if (path === `${prefix}/model-port`) return fulfillJson(route, { provider: "fake",
      configured: false, model: null, base_url: null, max_call_tokens: null });
    if (path === `${prefix}/assist-sessions`) return fulfillJson(route, { items: [sessionRow()] });
    if (path === `${prefix}/assist-sessions/${sessionId}`) return fulfillJson(route, sessionRow());
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return fulfillJson(route, messagesBody(state));
    if (path === `${prefix}/assist-sessions/${sessionId}/plans`) {
      if (state.projectionError) return fulfillJson(route, { code: "INTERNAL", detail: "读取失败" }, 500);
      return fulfillJson(route, { latest: null, versions: [] });
    }
    if (path === `${prefix}/assist-sessions/${sessionId}/goal`) {
      if (state.projectionError) return fulfillJson(route, { code: "INTERNAL", detail: "读取失败" }, 500);
      return fulfillJson(route, { goal: null, rounds: [] });
    }
    if (path === `${prefix}/conversation-execution-requests`) return fulfillJson(route, executionBody(state));
    if (path === `${prefix}/assist-proposals` || path === `${prefix}/skill-definitions`
      || path === `${prefix}/chat-commands`) return fulfillJson(route, { items: [] });
    if (path.startsWith(`${prefix}/learning`)) return fulfillJson(route, { items: [], epoch: "0" });
    if (path === `${prefix}/assist-sessions/${sessionId}/conversation-diff`) {
      return fulfillJson(route, { available: true, scope: "SESSION", baseline_captured_at: "2026-10-31T10:00:00Z",
        baseline_revision: "1", root_path: "D:\\Work\\Relay\\Projects\\reading-column-verification",
        resource_id: resourceId, incomplete: false,
        coverage: { baseline: { complete: true, reason: null, files: 1, listed: 1 },
          current: { complete: true, reason: null, files: 1, listed: 1 }, unchecked_files: 0,
          unverified_files: 0, unverifiable_files: 0, unscanned_files: 0 },
        total_files: 1, total_added: 12, total_removed: 3,
        files: [{ path: "apps/workbench/src/views/AssistView.css", action: "MODIFY", added: 12,
          removed: 3, unavailable_reason: null }] });
    }
    return fulfillJson(route, { items: [], next_cursor: null });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("reading-column-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 30_000 });
  await page.keyboard.press("Escape");
}

type Box = { left: number; right: number; width: number };

async function openChat(page: Page, width: number, state: Partial<State> = {}): Promise<void> {
  const full: State = { status: "READY", longPath: false, messages: 2, projectionError: false, ...state };
  await page.setViewportSize({ width, height: 900 });
  await installRoutes(page, full);
  await page.goto(`/agent?session=${sessionId}&project=${projectId}`);
  await connect(page);
  await page.getByTestId("assist-transcript").waitFor({ timeout: 30_000 });
  await page.locator(".agent-message-list").first().waitFor({ timeout: 30_000 });
  await page.getByTestId("assist-composer").waitFor({ timeout: 30_000 });
}

/** 量一组盒子的左右缘与宽度；找不到的节点（含 display:none）返回 null，由断言决定它该不该在场。 */
async function boxes(page: Page, selectors: readonly string[]): Promise<Record<string, Box | null>> {
  return page.evaluate((list: readonly string[]) => {
    const out: Record<string, { left: number; right: number; width: number } | null> = {};
    for (const selector of list) {
      const node = document.querySelector<HTMLElement>(selector);
      const box = node === null ? null : node.getBoundingClientRect();
      // display:none 的元素盒子全为 0，左缘会是 0 而不是缺省；按「不在场」处理。
      out[selector] = box === null || box.width === 0 ? null : { left: box.left, right: box.right, width: box.width };
    }
    return out;
  }, selectors);
}

/** 把一次测量写进证据文件（JSON Lines），供 acceptance.md 引用真实数字。 */
function record(label: string, measured: Record<string, Box | null>): void {
  fs.mkdirSync(boxDir, { recursive: true });
  const rounded = Object.fromEntries(Object.entries(measured)
    .map(([selector, box]) => [selector, box === null ? null : {
      left: nearest(box.left), right: nearest(box.right), width: nearest(box.width) }]));
  fs.appendFileSync(resolve(boxDir, "boxes.jsonl"), `${JSON.stringify({ label, boxes: rounded })}\n`);
}

const center = (box: Box): number => (box.left + box.right) / 2;
const nearest = (value: number): number => Math.round(value * 100) / 100;

function expectSameColumn(content: Box | null, composer: Box | null, label: string): void {
  expect(content, `${label} 应已渲染`).not.toBeNull();
  expect(composer, "输入卡应已渲染").not.toBeNull();
  expect(Math.abs(center(content as Box) - center(composer as Box)),
    `${label} 与输入卡中心轴偏差`).toBeLessThanOrEqual(1);
  expect(Math.abs((content as Box).left - (composer as Box).left),
    `${label} 左缘与输入卡左缘偏差`).toBeLessThanOrEqual(1);
  expect(Math.abs((content as Box).right - (composer as Box).right),
    `${label} 右缘与输入卡右缘偏差`).toBeLessThanOrEqual(1);
}

function shot(name: string): string {
  fs.mkdirSync(shotDir, { recursive: true });
  return resolve(shotDir, `${name}.png`);
}

test.describe("聊天阅读列统一宽度", () => {
  test("1440：执行准备面板与输入卡左右缘逐像素一致", async ({ page }) => {
    await openChat(page, 1440);
    const box = await boxes(page, [".execution-summary", ".agent-chat-composer", ".agent-message-list", ".collab-center"]);
    record("wide-1440", box);
    // 画布仍然吃满剩余空间：收窄的是内容，不是聊天区本身。
    expect((box[".collab-center"] as Box).width).toBeGreaterThan((box[".agent-chat-composer"] as Box).width + 40);
    expectSameColumn(box[".execution-summary"], box[".agent-chat-composer"], "执行准备面板");
    expectSameColumn(box[".agent-message-list"], box[".agent-chat-composer"], "消息列");
    await page.screenshot({ path: shot("01-wide-1440-ready") });
    // 滚动容器与画布同宽，内容列才在它里面居中；两者不能反过来（画布跟着内容收窄）。
    const shell = await boxes(page, [".agent-chat-transcript-shell", ".agent-chat-transcript"]);
    expect((shell[".agent-chat-transcript-shell"] as Box).width)
      .toBeGreaterThan((box[".agent-message-list"] as Box).width + 8);
  });

  test("1024：中等窗口同样同宽同轴", async ({ page }) => {
    await openChat(page, 1024);
    const box = await boxes(page, [".execution-summary", ".agent-chat-composer"]);
    record("desktop-1024", box);
    expectSameColumn(box[".execution-summary"], box[".agent-chat-composer"], "执行准备面板");
    await page.screenshot({ path: shot("02-desktop-1024-ready") });
  });

  test("420 / 375：窄窗按 100% 收缩，面板不越界也不产生横向滚动", async ({ page }) => {
    for (const width of [420, 375] as const) {
      await openChat(page, width);
      const box = await boxes(page, [".execution-summary", ".agent-chat-composer"]);
      record(`narrow-${width}`, box);
      expectSameColumn(box[".execution-summary"], box[".agent-chat-composer"], `执行准备面板@${width}`);
      const overflow = await page.evaluate(() => ({
        document: document.documentElement.scrollWidth - window.innerWidth,
        summary: (() => {
          const node = document.querySelector<HTMLElement>(".execution-summary");
          return node === null ? 0 : node.scrollWidth - node.clientWidth;
        })(),
      }));
      expect(overflow.document, `${width}px 视口不应出现横向滚动`).toBeLessThanOrEqual(0);
      expect(overflow.summary, `${width}px 面板内部不应横向溢出`).toBeLessThanOrEqual(1);
      // 面板进列之后，消息区必须还读得下去：不能被固定块压成一条缝。
      const transcript = await page.evaluate(() =>
        document.querySelector<HTMLElement>(".agent-chat-transcript")?.getBoundingClientRect().height ?? 0);
      expect(transcript, `${width}px 视口消息区高度`).toBeGreaterThanOrEqual(160);
      await page.screenshot({ path: shot(`03-narrow-${width}-ready`) });
    }
  });

  test("长路径与文件名：卡片内部换行，不顶出阅读列", async ({ page }) => {
    await openChat(page, 1024, { longPath: true });
    const box = await boxes(page, [".execution-summary", ".agent-chat-composer"]);
    record("long-path-1024", box);
    expectSameColumn(box[".execution-summary"], box[".agent-chat-composer"], "长路径执行准备面板");
    const overflow = await page.evaluate(() => {
      const node = document.querySelector<HTMLElement>(".execution-summary");
      return node === null ? null : { scroll: node.scrollWidth - node.clientWidth,
        document: document.documentElement.scrollWidth - window.innerWidth };
    });
    expect(overflow).not.toBeNull();
    expect((overflow as { scroll: number }).scroll).toBeLessThanOrEqual(1);
    expect((overflow as { document: number }).document).toBeLessThanOrEqual(0);
    await page.screenshot({ path: shot("04-long-path-1024") });
  });

  test("FAILED / CLARIFY / TASK_PREPARED 三种状态都守同一条阅读列", async ({ page }) => {
    for (const status of ["FAILED", "CLARIFY", "TASK_PREPARED"] as const) {
      await openChat(page, 1280, { status });
      const box = await boxes(page, [".execution-summary", ".agent-chat-composer"]);
      record(`state-${status.toLowerCase()}-1280`, box);
      expectSameColumn(box[".execution-summary"], box[".agent-chat-composer"], `${status} 执行准备面板`);
      await page.getByTestId("execution-summary").waitFor({ timeout: 10_000 });
      await page.screenshot({ path: shot(`05-state-${status.toLowerCase()}-1280`) });
    }
  });

  test("目标投影读取失败提示：同列，且动作键不被挤成竖排", async ({ page }) => {
    for (const width of [1024, 375] as const) {
      await openChat(page, width, { projectionError: true });
      await page.getByTestId("goal-projection-read-error").waitFor({ timeout: 10_000 });
      const box = await boxes(page, [".warning-callout", ".agent-chat-composer"]);
      record(`projection-error-${width}`, box);
      expectSameColumn(box[".warning-callout"], box[".agent-chat-composer"], `投影失败提示@${width}`);
      const button = await page.getByTestId("goal-projection-retry").boundingBox();
      expect(button).not.toBeNull();
      // 按钮是一整行文字（宽明显大于高），不是被压成竖排汉字：375 修复前实测约 90×190。
      const size = button as { width: number; height: number };
      expect(size.height, `${width}px 下按钮高度`).toBeLessThanOrEqual(56);
      expect(size.width / size.height, `${width}px 下按钮宽高比`).toBeGreaterThan(1.6);
      await page.screenshot({ path: shot(`06-projection-error-${width}`) });
    }
  });

  test("证据图：同一夹具下的修复前后对照", async ({ page }) => {
    await openChat(page, 1440);
    // 「修复前」用等价覆盖样式还原旧规则（内容块按画布宽度铺满），再原样量一次：
    // 差别只来自这一条规则，不是两份夹具。截图供人工比对，断言保证对照真的成立。
    const override = await page.addStyleTag({ content:
      ".agent-chat-conversation > .execution-summary { max-width: none; width: auto; margin-inline: 0; }" });
    const before = await boxes(page, [".execution-summary", ".agent-chat-composer"]);
    record("evidence-before-1440", before);
    expect((before[".execution-summary"] as Box).width)
      .toBeGreaterThan((before[".agent-chat-composer"] as Box).width + 40);
    await page.screenshot({ path: shot("00-before-1440") });
    await override.evaluate((node) => (node as Element).remove());
    const after = await boxes(page, [".execution-summary", ".agent-chat-composer"]);
    record("evidence-after-1440", after);
    expectSameColumn(after[".execution-summary"], after[".agent-chat-composer"], "修复后的执行准备面板");
    await page.screenshot({ path: shot("00-after-1440") });
  });

  test("Tauri 实际窗口 1160×780：同宽同轴", async ({ page }) => {
    await openChat(page, 1160);
    await page.setViewportSize({ width: 1160, height: 780 });
    const box = await boxes(page, [".execution-summary", ".agent-chat-composer"]);
    record("tauri-1160x780", box);
    expectSameColumn(box[".execution-summary"], box[".agent-chat-composer"], "执行准备面板");
    await page.screenshot({ path: shot("07-tauri-1160x780") });
  });

  test("侧栏收起：画布变宽，阅读列宽度不变", async ({ page }) => {
    await openChat(page, 1440);
    const before = await boxes(page, [".execution-summary", ".agent-chat-composer", ".collab-center"]);
    await page.getByTestId("context-rail-collapse").click();
    await expect(page.getByTestId("context-rail-collapse")).toHaveAttribute("aria-expanded", "false");
    const after = await boxes(page, [".execution-summary", ".agent-chat-composer", ".collab-center"]);
    record("rail-collapsed-1440", after);
    // 画布真的变宽了，内容列没有跟着变宽——这正是「Canvas 不决定内容宽度」。
    expect((after[".collab-center"] as Box).width).toBeGreaterThan((before[".collab-center"] as Box).width);
    expect(Math.round((after[".agent-chat-composer"] as Box).width)).toBe(744);
    expectSameColumn(after[".execution-summary"], after[".agent-chat-composer"], "侧栏收起后的执行准备面板");
    await page.screenshot({ path: shot("08-rail-collapsed-1440") });
  });

  test("运行中改变窗口宽度：内容块跟随输入卡重排，不产生横向滚动", async ({ page }) => {
    await openChat(page, 1440);
    await page.setViewportSize({ width: 980, height: 820 });
    await page.waitForTimeout(300);
    const box = await boxes(page, [".execution-summary", ".agent-chat-composer"]);
    record("resize-1440-to-980", box);
    expectSameColumn(box[".execution-summary"], box[".agent-chat-composer"], "缩放后的执行准备面板");
    expect((box[".execution-summary"] as Box).width).toBeLessThanOrEqual((box[".agent-chat-composer"] as Box).width + 1);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, "缩放后不应出现横向滚动").toBeLessThanOrEqual(0);
    await page.screenshot({ path: shot("09-resized-980") });
  });

  test("其他会话列内容块同样落在阅读列内", async ({ page }) => {
    await openChat(page, 1440, { messages: 4 });
    // 目录细条 / 队列 / 输入卡上方那一列：宽度不得超过输入卡，且不越出阅读列左右缘。
    // 这些块按状态条件渲染（空队列、无草稿提示时整块不在场），不在场的跳过、在场的一个都不放过。
    const selectors = [".execution-summary", ".warning-callout", ".agent-chat-prereq-row",
      ".assist-queue", ".composer-status-bar", ".composer-draft-bar", ".agent-chat-composer"] as const;
    const box = await boxes(page, selectors);
    record("siblings-1440", box);
    const composer = box[".agent-chat-composer"] as Box;
    let measured = 0;
    for (const selector of selectors) {
      if (selector === ".agent-chat-composer") continue;
      const value = box[selector];
      if (value === null) continue;
      measured += 1;
      expect(value.width, `${selector} 不应宽于输入卡`).toBeLessThanOrEqual(composer.width + 1);
      expect(value.left, `${selector} 左缘不应越出阅读列`).toBeGreaterThanOrEqual(composer.left - 1);
      expect(value.right, `${selector} 右缘不应越出阅读列`).toBeLessThanOrEqual(composer.right + 1);
    }
    expect(measured, "至少要量到输入卡上方的两块内容，空集合不算通过").toBeGreaterThanOrEqual(2);
  });
});
