import { expect, test, type Page } from "@playwright/test";

// 2026-10-21 第三轮 R3-04 的实机几何与键盘核对（真实 Chromium，页面内拦截伪造 API，不连数据库、不连 Provider）。
// 复现口径来自用户实机窗口约 1162×782：单列时判断详情排在整篇正文之后，首屏看不到决定区。
// 这里锁三件事：页内定位在首屏可达、键盘 Tab/Enter 能走到同一落点、判断依据默认读用户语言而原 JSON 收在技术详情。
// 全程不点任何决定按钮：页内定位只是移动视图，不提交、不批准。

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const reviewId = "44444444-4444-4444-8444-444444444444";
const targetVersionId = "55555555-5555-4555-8555-555555555555";
const otherVersionId = "66666666-6666-4666-8666-666666666666";
const prefix = `/api/v1/workspaces/${workspaceId}`;

const review = {
  id: reviewId, kind: "CRITERION", status: "OPEN", revision: "3", project_id: projectId,
  task_id: taskId, run_id: null, operation_id: null,
  reason: "AWAITING_HUMAN_EVIDENCE", target_hash: "a".repeat(64),
  target: { artifact_version_id: targetVersionId, acceptance_revision: "2", criterion_id: "c1" },
  evidence: { check_result: "FAIL", required: true, summary: "第 3 章的三条论断没有来源。" },
  effect: { on_accept: "记录这次验收结果", external_effect_executed: false },
  allowed_decisions: ["ACCEPT", "REQUEST_CHANGES"], expires_at: null,
  created_at: "2026-10-21T00:00:00Z", decided_at: null
};
const artifact = {
  id: "77777777-7777-4777-8777-777777777777", task_id: taskId, title: "第 3 章草稿",
  revision: "4", latest_version_id: otherVersionId, version_count: 2,
  versions: [
    { artifact_version_id: otherVersionId, version_number: "2", media_type: "text/markdown",
      sha256: "b".repeat(64), size: "2048", source_kind: "AGENT", created_at: "2026-10-20T00:00:00Z" },
    { artifact_version_id: targetVersionId, version_number: "1", media_type: "text/markdown",
      sha256: "c".repeat(64), size: "2048", source_kind: "HUMAN", created_at: "2026-10-19T00:00:00Z" }]
};
// 正文足够长，才能测出「读完才见到决定区」这一段距离。
const paragraph = "这一段用来把判断区推离首屏。每一段都保留完整句子，避免用空白撑高度，测到的才是真实阅读距离。";
const draftBody = ["# 第 3 章 方法与材料",
  ...Array.from({ length: 26 }, (_, index) => `## 小节 ${index + 1}\n\n${paragraph}`)].join("\n\n");

async function connect(page: Page): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const headers = { "access-control-allow-origin": "http://127.0.0.1:4173",
      "access-control-allow-headers": "Authorization, Content-Type" };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    // 其余路径统一按空集合回答：连接校验会探测多个只读入口，404 会让整次连接判定失败。
    let payload: unknown = { items: [], next_cursor: null };
    if (path === "/health/ready") payload = { status: "ready" };
    if (path === `${prefix}/reviews`) payload = { items: [review] };
    if (path === `${prefix}/reviews/${reviewId}`) payload = review;
    if (path === `${prefix}/tasks/${taskId}`) payload = {
      id: taskId, project_id: projectId, title: "把第 3 章改到可提交", status: "IN_PROGRESS", mode: "ME",
      revision: "9", executor: { kind: "HUMAN", run_id: null }, current_completion_id: null,
      waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
      dependencies: [], updated_at: "2026-10-21T00:00:00Z",
      acceptance: { acceptance_revision: "2", objective: "第 3 章每条论断都有来源。", source: "HUMAN",
        expected_outputs: { draft: "MARKDOWN" },
        criteria: [{ criterion_id: "c1", statement: "三条论断都有可核对来源。", required: true,
          method: "HUMAN", target_spec: {} }] } };
    if (path === `${prefix}/projects/${projectId}`) payload = { id: projectId,
      title: "论文：协作工作系统与恢复", project_type: "THESIS", revision: "1", state_revision: "1",
      archived_at: null };
    if (path === `${prefix}/tasks/${taskId}/artifacts`) payload = { items: [artifact],
      next_cursor: null, current_accepted_version_ids: [] };
    if (path === `${prefix}/artifact-versions/${targetVersionId}/content`) {
      return route.fulfill({ status: 200, headers: { ...headers, "content-type": "text/markdown" }, body: draftBody });
    }
    return route.fulfill({ status: 200, headers, contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("r3-decision-jump-fixture");
  await page.getByTestId("relay-connect").click();
  await expect(page.getByTestId("relay-connection-state")).toContainText("已连接");
  await page.keyboard.press("Escape");
}

/** 首屏之内看得见 = 顶边落在视口里；决定区在折叠线以下才是本轮要修的观感。 */
async function geometry(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const box = (selector: string) => {
      const element = document.querySelector(selector);
      if (element === null) throw new Error(`缺少 ${selector}`);
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: rect.height };
    };
    const scroller = document.querySelector<HTMLElement>(".app-main")!;
    return { viewport: innerHeight, jump: box(".review-jump").top, decisionTop: box("[data-testid=\"review-decision-actions\"]").top,
      decisionHeight: box("[data-testid=\"review-decision-actions\"]").height,
      summaryTop: box("[data-testid=\"review-bound-summary\"]").top,
      scrolled: scroller.scrollTop, scrollHeight: scroller.scrollHeight };
  });
}

test("1162×782 单列：首屏给出页内定位，点击与键盘都能把焦点落到决定区且不提交", async ({ page }) => {
  const posts: string[] = [];
  page.on("request", (request) => { if (request.method() !== "GET") posts.push(`${request.method()} ${new URL(request.url()).pathname}`); });
  await page.setViewportSize({ width: 1162, height: 782 });
  await page.goto("/reviews");
  await connect(page);
  await expect(page.getByTestId("review-inbox")).toBeVisible();
  await page.waitForTimeout(300);

  const before = await geometry(page);
  // 复现：决定区排在整篇正文之后，首屏（782px）里看不到它。
  expect(before.decisionTop).toBeGreaterThan(before.viewport);
  expect(before.jump).toBeGreaterThanOrEqual(0);
  expect(before.jump).toBeLessThan(before.viewport);

  await page.getByTestId("review-jump-decision").click();
  const after = await geometry(page);
  expect(after.decisionTop).toBeGreaterThanOrEqual(0);
  expect(after.decisionTop).toBeLessThan(after.viewport);
  expect(after.scrolled).toBeGreaterThan(before.scrolled);
  expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? "")).toBe("review-decision-actions");
  // 焦点环确实画出来了（不是只移动了 scrollTop）：全局 :focus 规则用 --relay-focus-width。
  expect(await page.evaluate(() => {
    const style = getComputedStyle(document.querySelector<HTMLElement>('[data-testid="review-decision-actions"]')!);
    return `${style.outlineStyle} ${style.outlineWidth}`;
  })).toContain("solid");
  expect(posts).toEqual([]);

  // 「查看判断条件」同样只移动视图；决定按钮一个都没点。
  await page.getByTestId("review-jump-conditions").click();
  const summary = await geometry(page);
  expect(summary.summaryTop).toBeGreaterThanOrEqual(0);
  expect(summary.summaryTop).toBeLessThan(summary.viewport);
  expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? "")).toBe("review-bound-summary");
  expect(posts).toEqual([]);
});

test("页内定位可用键盘走到：Tab 到定位键，Enter 移动焦点，Escape 不误提交", async ({ page }) => {
  const posts: string[] = [];
  page.on("request", (request) => { if (request.method() !== "GET") posts.push(request.url()); });
  await page.setViewportSize({ width: 1162, height: 782 });
  await page.goto("/reviews");
  await connect(page);
  await expect(page.getByTestId("review-jump-decision")).toBeVisible();
  await page.waitForTimeout(300);

  // 从文档开头逐次 Tab，量出走到定位键需要的按键次数（真实焦点顺序，不是程序 focus()）。
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  let steps = 0;
  while (steps < 40) {
    await page.keyboard.press("Tab");
    steps += 1;
    if (await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? "") === "review-jump-decision") break;
  }
  expect(steps).toBeLessThan(40);
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? "")).toBe("review-decision-actions");
  const after = await geometry(page);
  expect(after.decisionTop).toBeLessThan(after.viewport);
  await page.keyboard.press("Escape");
  // Escape 不触发任何写入，也不改变待判断状态；决定按钮本身没有被页内定位动过。
  expect(posts).toEqual([]);
  await expect(page.getByTestId("review-decision-ACCEPT")).toBeEnabled();
});

test("判断依据默认读用户语言，原始键名与 JSON 只在展开的技术详情里", async ({ page }) => {
  await page.setViewportSize({ width: 1162, height: 782 });
  await page.goto("/reviews");
  await connect(page);
  await page.getByTestId("review-jump-conditions").click();
  // 可见文本走真实渲染：折叠的 <details> 内容不进 innerText，所以这里读到的就是用户看到的。
  const panel = page.getByTestId("review-decision");
  await expect(panel).toContainText("自动检查结果");
  await expect(panel).toContainText("第 3 章的三条论断没有来源");
  await expect(panel).toContainText("接受后");
  expect(await panel.innerText()).not.toContain("check_result");
  expect(await panel.innerText()).not.toContain("on_accept");

  await page.getByTestId("review-jump-decision").click();
  await page.locator(".review-raw-data > summary").click();
  const raw = await page.getByTestId("review-raw-json").innerText();
  expect(raw).toContain("check_result");
  expect(raw).toContain("on_accept");
  // 展开后仍在同一列里，不撑破 1162 宽度（长哈希与 JSON 都要换行）。
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
});
