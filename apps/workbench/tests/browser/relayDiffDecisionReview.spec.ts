import { expect, test, type APIRequestContext, type APIResponse, type Page } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const apiBase = "http://127.0.0.1:18788";
const workspaceId = "736ee34c-f47e-4c79-8a48-e7c1cbc51447";
const bearerToken = "c62502fa366d0ab863335ba9d269077ece4612c4468fdfc9";
const seed = JSON.parse(readFileSync(join(process.cwd(), "..", "..", "tmp", "relay-differentiation", "e2e", "seed.json"), "utf8")) as {
  projectId: string; knowledgeId: string; decisionId: string;
};
const shotDir = process.env.RELAY_SHOT_DIR ?? join(process.cwd(), "..", "..", "tmp", "relay-differentiation", "screenshots");
mkdirSync(shotDir, { recursive: true });

const auth = { authorization: `Bearer ${bearerToken}` };

async function jsonOf(response: APIResponse): Promise<Record<string, unknown>> {
  try { return await response.json() as Record<string, unknown>; } catch { return {}; }
}

async function apiGet(request: APIRequestContext, path: string): Promise<Record<string, unknown>> {
  const response = await request.get(`${apiBase}/api/v1/workspaces/${workspaceId}${path}`, { headers: auth });
  expect(response.status(), `GET ${path}`).toBe(200);
  return await jsonOf(response);
}

async function apiPost(request: APIRequestContext, path: string, data: unknown): Promise<Record<string, unknown>> {
  const response = await request.post(`${apiBase}/api/v1/workspaces/${workspaceId}${path}`, { headers: auth, data });
  const body = await jsonOf(response);
  expect(response.status(), `POST ${path}: ${JSON.stringify(body).slice(0, 400)}`).toBeLessThan(300);
  return body;
}

/** 预期失败命令的原始响应：断言具体错误契约，不只断言 HTTP 409。 */
async function apiTryPost(request: APIRequestContext, path: string, data: unknown):
  Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const response = await request.post(`${apiBase}/api/v1/workspaces/${workspaceId}${path}`, { headers: auth, data });
  return { status: response.status(), body: await jsonOf(response) };
}

function reviewOf(reviews: readonly Record<string, unknown>[], id: string): Record<string, unknown> {
  const review = reviews.find((item) => item["id"] === id);
  expect(review, `候选 ${id} 应当存在`).toBeDefined();
  return review!;
}

/** 决定正文与修订：复核处理只能改候选，不能顺带改写决定。 */
function decisionCore(body: Record<string, unknown>): Record<string, unknown> {
  const core = (body["result"] as Record<string, unknown> | undefined) ?? body;
  return { revision: core["revision"], status: core["status"], title: core["title"],
    choice: core["choice"], rationale: core["rationale"] };
}

function itemsOf(body: Record<string, unknown>): Record<string, unknown>[] {
  const value = body["items"];
  return Array.isArray(value) ? value as Record<string, unknown>[] : [];
}

async function connect(page: Page): Promise<void> {
  if (page.url() === "about:blank") await page.goto("/");
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill(bearerToken);
  await page.getByTestId("relay-connect").click();
  await expect(page.getByTestId("relay-connection-state")).toContainText("已连接");
  await page.getByRole("dialog", { name: "连接本机 API" }).getByRole("button", { name: "关闭", exact: true }).click();
}

async function shotPanel(page: Page, name: string): Promise<void> {
  const panel = page.getByTestId("decision-review-panel");
  await panel.scrollIntoViewIfNeeded();
  await panel.screenshot({ path: join(shotDir, name) });
}

async function openDecision(page: Page): Promise<void> {
  const target = `/projects/${seed.projectId}/knowledge?kind=DECISION&item=${seed.decisionId}`;
  if (!page.url().includes(`item=${seed.decisionId}`)) {
    // 连接状态只保存在内存；页面内跳转必须走 SPA 路由，不能整页刷新。
    await page.evaluate((path) => {
      window.history.pushState({}, "", path);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, target);
  }
  await expect(page.getByTestId("decision-review-panel")).toBeVisible();
}

async function updateKnowledge(request: APIRequestContext, revision: number, text: string): Promise<Record<string, unknown>> {
  return await apiPost(request, `/knowledge/${seed.knowledgeId}/versions`, {
    command_id: crypto.randomUUID(), expected_revision: String(revision), source_kind: "NOTE", text,
  });
}

async function reviewsOf(request: APIRequestContext): Promise<Record<string, unknown>[]> {
  return itemsOf(await apiGet(request, `/projects/${seed.projectId}/decision-reviews`));
}

test("真实 API + PostgreSQL：前提登记 → 来源变化 → 候选 → 过期候选类型化拒绝 → KEEP/DISMISS", async ({ page, request }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 960 });
  await connect(page);
  await openDecision(page);
  await page.screenshot({ path: join(shotDir, "decision-review-empty-light.png"), fullPage: true });

  await page.getByTestId("decision-premise-open").click();
  await expect(page.getByTestId("decision-premise-form")).toBeVisible();
  await page.getByTestId("decision-premise-knowledge").selectOption(seed.knowledgeId);
  await expect(page.getByTestId("decision-premise-version")).toContainText("已读取确切版本");
  await expect(page.getByTestId("decision-premise-version")).toContainText("v1");
  await page.getByTestId("decision-premise-statement").fill("E2E：以资料版本一作为决定前提。");
  await page.getByTestId("decision-premise-confirmed").check();

  // 模拟网络中断：浏览器未拿到响应，属于「结果未知」，不能直接换新 command_id 重发。
  let interrupted = false;
  await page.route(
    (url) => url.pathname.endsWith(`/decisions/${seed.decisionId}/premises`),
    async (route) => {
      if (route.request().method() === "POST" && !interrupted) {
        interrupted = true;
        await route.abort("failed");
        return;
      }
      await route.fallback();
    },
  );
  await page.getByTestId("decision-premise-submit").click();
  await expect(page.getByTestId("decision-review-pending")).toBeVisible();
  await expect(page.getByTestId("decision-review-receipt-note")).toContainText("不证明");
  await shotPanel(page, "decision-review-unknown-receipt-light.png");

  // 等待期间改表单只影响新请求；按原命令重试必须发送冻结载荷。
  await page.getByTestId("decision-premise-statement").fill("这段修改不应进入原命令重试。");
  await page.unroute((url) => url.pathname.endsWith(`/decisions/${seed.decisionId}/premises`));
  await page.getByTestId("decision-review-retry").click();
  await expect(page.getByTestId("decision-review-notice")).toContainText("已登记依据");
  await expect(page.locator('[data-testid^="decision-premise-"]').filter({ hasText: "E2E：以资料版本一作为决定前提。" })).toBeVisible();
  await expect(page.locator('[data-testid^="decision-premise-"]').filter({ hasText: "这段修改不应进入原命令重试。" })).toHaveCount(0);
  await shotPanel(page, "decision-review-premise-registered-light.png");

  await updateKnowledge(request, 0, "版本二：约束变化，需复核。");
  await page.reload();
  await connect(page);
  await openDecision(page);
  const applicable = page.locator('[data-testid^="decision-review-"][data-applicable="true"]').first();
  await expect(applicable).toBeVisible();
  await expect(applicable).toContainText("登记时");
  await shotPanel(page, "decision-review-candidate-light.png");

  const candidateId = (await applicable.getAttribute("data-testid"))!.replace("decision-review-", "");

  // 不处理 v2 候选，先让来源再次变化：旧候选应变为不可行动，并出现指向最新来源的新候选。
  await updateKnowledge(request, 1, "版本三：再次变化。");
  await page.reload();
  await connect(page);
  await openDecision(page);
  await expect(page.locator(`[data-testid="decision-review-stale-${candidateId}"]`)).toBeVisible();
  const newest = page.locator('[data-testid^="decision-review-"][data-applicable="true"]').first();
  await expect(newest).toBeVisible();
  await shotPanel(page, "decision-review-stale-and-new-candidate-light.png");
  const newestId = (await newest.getAttribute("data-testid"))!.replace("decision-review-", "");

  // 旧候选的拒绝必须用服务端当前 revision 才会走到候选适用性检查；
  // 固定 "0" 只会在修订校验处先失败，无法证明业务拒绝真的生效。
  const staleBefore = reviewOf(await reviewsOf(request), candidateId);
  const staleRevision = staleBefore["revision"] as string;
  expect(staleBefore["status"], "旧候选此时仍应为待判断").toBe("PENDING");
  expect(staleBefore["applicable"], "旧候选应已不可行动").toBe(false);

  const staleAttempt = await apiTryPost(request, `/decision-reviews/${candidateId}/resolutions`, {
    command_id: crypto.randomUUID(), expected_revision: staleRevision,
    action: "KEEP_DECISION", reason: "E2E：过期候选应被业务拒绝。"
  });
  expect(staleAttempt.status, "过期候选处理必须被拒绝").toBe(409);
  expect(staleAttempt.body["code"], "正确 revision 下应命中候选适用性拒绝，而不是修订冲突").toBe("INVALID_TRANSITION");
  expect(staleAttempt.body["type"]).toBe("/problems/invalid-transition");

  let reviews = await reviewsOf(request);
  const staleAfterBusinessReject = reviewOf(reviews, candidateId);
  expect(staleAfterBusinessReject["revision"], "业务拒绝不改变候选 revision").toBe(staleRevision);
  expect(staleAfterBusinessReject["status"]).toBe("PENDING");
  expect(staleAfterBusinessReject["applicable"]).toBe(false);

  // 错误 revision 反例：同一候选、同一动作，仅 revision 错，必须在候选适用性检查之前
  // 被修订冲突拒绝。两类拒绝的错误码不同，可据此证明上一条不是假阳性。
  const wrongRevision = staleRevision === "0" ? "1" : "0";
  const wrongRevisionAttempt = await apiTryPost(request, `/decision-reviews/${candidateId}/resolutions`, {
    command_id: crypto.randomUUID(), expected_revision: wrongRevision,
    action: "KEEP_DECISION", reason: "E2E：错误 revision 应被拒绝。"
  });
  expect(wrongRevisionAttempt.status).toBe(409);
  expect(wrongRevisionAttempt.body["code"], "错误 revision 必须命中修订冲突").toBe("REVISION_CONFLICT");
  expect(wrongRevisionAttempt.body["type"]).toBe("/problems/revision-conflict");
  const conflict = wrongRevisionAttempt.body["conflict"] as Record<string, unknown> | undefined;
  expect(conflict?.["entity_type"]).toBe("DECISION_REVIEW");
  expect(conflict?.["expected_revision"]).toBe(wrongRevision);
  expect(conflict?.["actual_revision"]).toBe(staleRevision);

  reviews = await reviewsOf(request);
  const staleAfterWrongRevision = reviewOf(reviews, candidateId);
  expect(staleAfterWrongRevision["revision"], "修订冲突不改变候选 revision").toBe(staleRevision);
  expect(staleAfterWrongRevision["status"]).toBe("PENDING");
  expect(staleAfterWrongRevision["applicable"]).toBe(false);

  const decisionBeforeResolutions = await apiGet(request, `/decisions/${seed.decisionId}`);

  await page.locator(`[data-testid="decision-review-reason-${newestId}"]`).fill("E2E：版本三仍支持原决定。");
  await page.locator(`[data-testid="decision-review-keep-${newestId}"]`).click();
  await expect(page.getByTestId("decision-review-notice")).toContainText("核对基线推进");

  reviews = await reviewsOf(request);
  const kept = reviews.find((item) => item["id"] === newestId)!;
  expect(kept["status"]).toBe("KEPT");
  const stillPending = reviews.find((item) => item["id"] === candidateId)!;
  expect(stillPending["status"]).toBe("PENDING");
  expect(stillPending["applicable"]).toBe(false);
  const premises = itemsOf(await apiGet(request, `/decisions/${seed.decisionId}/premises`));
  expect(premises.length).toBe(1);

  await updateKnowledge(request, 2, "版本四：忽略本次变化。");
  await page.reload();
  await connect(page);
  await openDecision(page);
  const dismissCandidate = page.locator('[data-testid^="decision-review-"][data-applicable="true"]').first();
  await expect(dismissCandidate).toBeVisible();
  const dismissId = (await dismissCandidate.getAttribute("data-testid"))!.replace("decision-review-", "");
  await page.locator(`[data-testid="decision-review-reason-${dismissId}"]`).fill("E2E：版本四变化不影响决定。");
  await page.locator(`[data-testid="decision-review-dismiss-${dismissId}"]`).click();
  await expect(page.getByTestId("decision-review-notice")).toContainText("决定本身未被修改");
  await shotPanel(page, "decision-review-history-light.png");

  reviews = await reviewsOf(request);
  const dismissed = reviews.find((item) => item["id"] === dismissId)!;
  expect(dismissed["status"]).toBe("DISMISSED");

  const decisionAfter = await apiGet(request, `/decisions/${seed.decisionId}`);
  // KEEP/DISMISS 只处理候选与核对基线，不改决定正文、状态和 revision。
  expect(decisionCore(decisionAfter)).toEqual(decisionCore(decisionBeforeResolutions));
  expect(decisionCore(decisionAfter)["status"]).toBe("ACTIVE");

  // 当前产品只有浅色主题（dark 仅存在于 dev ScenarioLab），暗色不适用；
  // 不用 emulateMedia 伪造一套未实现的暗色状态。
  await page.setViewportSize({ width: 860, height: 620 });
  await page.getByTestId("decision-review-panel").scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shotDir, "decision-review-narrow-860x620.png") });
  await page.setViewportSize({ width: 720, height: 900 });
  await page.getByTestId("decision-review-panel").scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shotDir, "decision-review-narrow-720x900.png") });

  // 加载态：暂扣 GET 候选请求，确认加载提示可见后再放行。
  await page.setViewportSize({ width: 1440, height: 960 });
  let releaseLoad!: () => void;
  const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
  const reviewsRequest = (url: URL) => url.pathname.endsWith("/decision-reviews");
  await page.route(reviewsRequest, async (route) => {
    await loadGate;
    await route.continue();
  });
  await page.reload();
  await connect(page);
  await expect(page.getByText("正在读取决定依据与复核候选…")).toBeVisible();
  await shotPanel(page, "decision-review-loading-light.png");
  releaseLoad();
  await page.unroute(reviewsRequest);

  // 错误态：候选读取失败时必须显示可重试的错误，而不是空状态。
  await page.route(reviewsRequest, (route) => route.abort("failed"));
  await page.reload();
  await connect(page);
  await expect(page.getByTestId("decision-review-read-error")).toBeVisible();
  await shotPanel(page, "decision-review-error-light.png");
  await page.unroute(reviewsRequest);
});
