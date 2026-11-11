import { expect, test, type Page, type Route } from "@playwright/test";

// 会话删除的浏览器回归（2026-10-31）。
//
// 这里守五件用户当场指认过的事：
// 1. **只有一次确认。** 勾选 → 删除 → 「删除这 N 段讨论？」 → 点删除就执行；
//    确认之后不再出现第二张带「删除」的卡片。
// 2. **结果分层。** 已删、未删除、待核实各是各的：被引用阻断时给出真正能做的动作，
//    服务端 500 且查不到回执时停在「待核实」，既不宣称成功也不宣称失败。
// 3. **侧栏不被文字撑开。** 结果区限高并内部滚动；窄栏下一段红字不会把这一列铺成长页面。
// 4. **技术细节按需展开。** 原始 request_id 只在「技术详情」里，不进主提示句。
// 5. **核对到已删就当已删。** 按原 command_id 核对到已提交之后，那一行必须真的从列表里收掉，
//    刷新后与服务端一致；仍核对不到的那条一行都不动，也不重发删除命令。
//
// API 全部由 page.route 伪造，不连数据库、不调 Provider。

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = `http://127.0.0.1:${process.env.RELAY_E2E_PORT ?? "4173"}`;
/** 证据截图目录：这一轮的删除流程前后状态留在这里（仓库里的 tmp/ 按任务分目录）。 */
const evidenceDir = process.env.RELAY_DELETE_EVIDENCE_DIR
  ?? "D:/Develop/Relay-Agent/tmp/session-delete-simplification";

const deletable = "66666666-6666-4666-8666-666666666661";
const blocked = "66666666-6666-4666-8666-666666666662";
const unknown = "66666666-6666-4666-8666-666666666663";
/**
 * 服务端其实已经删成功（行没了、回执在同一事务里写了），但响应丢了；而且删除时那一次自动
 * 核对撞上「回执还没对外可见」，只有用户点「核对回执」的第二次查才拿到（2026-11-01 独立
 * 验收发现的 P1 用的正是这条路）。
 */
const lateConfirmed = "66666666-6666-4666-8666-666666666664";

/** 假服务端里可观察的三件事实：谁被删了、删除命令发过几发、回执被查了几次。 */
interface FakeState {
  readonly deleted: Set<string>;
  readonly deleteCalls: string[];
  readonly receiptReads: number;
}

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(),
    body: JSON.stringify(body) });
}

function session(id: string, title: string): unknown {
  return { id, workspace_id: workspaceId, project_id: null, task_id: null, title,
    status: "ACTIVE", revision: "1", created_at: "2026-10-31T10:00:00Z",
    updated_at: "2026-10-31T10:00:00Z", last_message_at: "2026-10-31T10:00:00Z",
    pinned_at: null, unread_at: null, has_messages: true };
}

async function installRoutes(page: Page): Promise<FakeState> {
  // 服务端事实：删掉的行不再出现在列表里；回执按原 command_id 存，客户端核对时从这里取。
  const deleted = new Set<string>();
  const deleteCalls: string[] = [];
  const receipts = new Map<string, unknown>();
  // 哪些命令属于「当场查不到、第二次核对才查到」那一类，以及每枚回执被查的次数。
  const blindOnFirstRead = new Set<string>();
  const readsPerCommand = new Map<string, number>();
  let receiptReads = 0;
  const catalog = new Map<string, string>([
    [deletable, "可以删掉的讨论"], [blocked, "被引用着的讨论"],
    [unknown, "结果未知的讨论"], [lateConfirmed, "响应丢了但其实已删除的讨论"]]);

  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/tasks`) return fulfillJson(route, { items: [], next_cursor: null });
    if (path === `${prefix}/projects`) return fulfillJson(route, { items: [], next_cursor: null });
    if (path === `${prefix}/assist-sessions`) {
      const status = new URL(request.url()).searchParams.get("status");
      if (status === "ARCHIVED") return fulfillJson(route, { items: [] });
      return fulfillJson(route, { items: [...catalog]
        .filter(([id]) => !deleted.has(id))
        .map(([id, title]) => session(id, title)) });
    }
    const deletion = /\/assist-sessions\/([^/]+)\/delete$/u.exec(path);
    if (deletion !== null && request.method() === "POST") {
      const body = JSON.parse(request.postData() ?? "{}") as { command_id: string };
      const target = String(deletion[1]);
      deleteCalls.push(target);
      if (target === blocked) {
        // 业务阻断：行还在，原因逐条可读。
        return fulfillJson(route, { code: "SESSION_DELETE_BLOCKED", detail: "referenced",
          conflict: { blocking_reasons: ["LEARNING_RECORDS"] } }, 409);
      }
      if (target === unknown) {
        // 服务端内部错误：命令有没有落库无法从这一条判断，回执也查不到。
        return fulfillJson(route, { code: "INTERNAL_ERROR",
          detail: "请求未能完成，请通过 request_id 在本机日志中核对。",
          request_id: "req-delete-unknown" }, 500);
      }
      const result = { session_id: target, revision: "1", deleted_messages: 2,
        deleted_attachments: 0, deleted_at: "2026-10-31T10:05:00.000Z" };
      deleted.add(target);
      receipts.set(body.command_id, result);
      if (target === lateConfirmed) {
        blindOnFirstRead.add(body.command_id);
        return fulfillJson(route, { code: "INTERNAL_ERROR",
          detail: "请求未能完成，请通过 request_id 在本机日志中核对。",
          request_id: "req-delete-lost" }, 500);
      }
      return fulfillJson(route, { command_id: body.command_id, committed_at: "2026-10-31T10:05:00Z",
        result });
    }
    const receipt = /\/commands\/([^/]+)$/u.exec(path);
    if (receipt !== null) {
      receiptReads += 1;
      const key = String(receipt[1]);
      const seen = (readsPerCommand.get(key) ?? 0) + 1;
      readsPerCommand.set(key, seen);
      const result = receipts.get(key);
      // 当场那一次核对（删除时自动发的）撞上事务尚未对外可见；用户点「核对回执」的第二次才查到。
      if (result !== undefined && blindOnFirstRead.has(key) && seen === 1) {
        return fulfillJson(route, { code: "COMMAND_NOT_FOUND", detail: "没有这条回执" }, 404);
      }
      if (result === undefined) {
        // 回执查不到：这次删除是否生效仍未知，界面必须留在「待核实」。
        return fulfillJson(route, { code: "COMMAND_NOT_FOUND", detail: "没有这条回执" }, 404);
      }
      return fulfillJson(route, { command_id: key, command_type: "DeleteAssistSession",
        committed_at: "2026-10-31T10:05:00Z", result });
    }
    return fulfillJson(route, { items: [], next_cursor: null });
  });
  return { deleted, deleteCalls, get receiptReads() { return receiptReads; } };
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("session-delete-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

test.describe("会话删除流程", () => {
  test("批量删除：一次确认，结果分层，侧栏不被结果文字撑开", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await installRoutes(page);
    await page.goto("/agent");
    await connect(page);

    // 勾选框与 ⋯ 都只在行悬停/聚焦时显形（工作台 §28.1）：先悬停那一行再操作。
    await page.getByTestId(`recent-work-${deletable}`).hover();
    await page.getByTestId(`recent-work-select-${deletable}`).check();
    await page.getByTestId(`recent-work-${blocked}`).hover();
    await page.getByTestId(`recent-work-select-${blocked}`).check();

    // 第一步：勾选只是勾选，批量条里只出现一个「删除」。
    const bar = page.getByTestId("recent-work-selection");
    await expect(bar).toContainText("已选 2 段讨论");
    await page.screenshot({ path: `${evidenceDir}/01-batch-selected.png` });
    await page.getByTestId("recent-work-batch-delete").click();

    // 第二步（唯一一次确认）：卡片说清后果，没有第三步。
    await expect(bar).toContainText("删除这 2 段讨论？");
    await expect(bar).toContainText("永久移除");
    await page.screenshot({ path: `${evidenceDir}/02-batch-confirm.png` });
    await page.getByTestId("recent-work-batch-delete-confirm").click();

    // 结果：非阻塞提示里一行结论，原因只写一次，并给出真正能做的动作。
    const notice = page.getByTestId("recent-work-batch-notice");
    await expect(notice).toContainText("已删除 1 段");
    await expect(notice).toContainText("1 段未删除");
    await expect(notice).toContainText("有学习记录");
    await expect(notice).toContainText("先在学习页清空这段讨论的评估记录");
    // 原因只出现一次（动作句里不再重复同一组词，避免读成两遍红字）。
    expect((await notice.textContent())!.split("有学习记录").length - 1).toBe(1);

    // 勾选清空、批量条收起；没有第二张带「删除」的卡片。
    await expect(page.getByTestId("recent-work-selection")).toHaveCount(0);
    await expect(page.getByTestId("recent-work-batch-delete")).toHaveCount(0);
    await expect(page.getByTestId("recent-work-batch-delete-confirm")).toHaveCount(0);
    await page.screenshot({ path: `${evidenceDir}/03-batch-result.png` });

    // 结果不再进左栏文档流：提示是 portal 到 body 的反馈卡，侧栏不被这段文字撑开。
    expect(await page.locator(".app-context-rail").getByTestId("recent-work-batch-notice").count())
      .toBe(0);
    expect(await page.locator(".recent-work-batch-report").count()).toBe(0);
    const railHeight = await page.evaluate(() =>
      document.querySelector<HTMLElement>(".app-context-rail")?.getBoundingClientRect().height ?? 0);
    expect(railHeight).toBeLessThanOrEqual(page.viewportSize()!.height);
  });

  test("单条删除被引用阻断：给出可执行动作，且不再摆第二颗删除键", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await installRoutes(page);
    await page.goto("/agent");
    await connect(page);

    await page.getByTestId(`recent-work-${blocked}`).hover();
    await page.getByTestId(`recent-work-menu-${blocked}`).click();
    await page.getByTestId(`recent-work-delete-${blocked}`).click();
    await expect(page.getByTestId(`session-delete-confirm-${blocked}`)).toBeVisible();
    await page.getByTestId(`session-delete-confirm-${blocked}`).click();

    const panel = page.locator(`[data-testid="recent-work-panel-${blocked}"]`);
    await expect(panel).toContainText("这段讨论还不能删除");
    await expect(panel).toContainText("有学习记录");
    await expect(panel).toContainText("先在学习页清空这段讨论的评估记录");
    // 终态：没有删除键，只有关闭。
    await expect(page.getByTestId(`session-delete-confirm-${blocked}`)).toHaveCount(0);
    await expect(page.getByTestId(`session-delete-close-${blocked}`)).toBeVisible();
    await page.screenshot({ path: `${evidenceDir}/04-single-blocked.png` });
    // 行还在。
    await expect(page.getByTestId(`recent-work-${blocked}`)).toBeVisible();
  });

  test("单条删除结果未知：停在待核实，只留核对回执", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await installRoutes(page);
    await page.goto("/agent");
    await connect(page);

    await page.getByTestId(`recent-work-${unknown}`).hover();
    await page.getByTestId(`recent-work-menu-${unknown}`).click();
    await page.getByTestId(`recent-work-delete-${unknown}`).click();
    await page.getByTestId(`session-delete-confirm-${unknown}`).click();

    const panel = page.locator(`[data-testid="recent-work-panel-${unknown}"]`);
    await expect(panel).toContainText("删除结果待核实");
    await expect(panel).toContainText("还没有确定");
    await expect(page.getByTestId(`session-delete-confirm-${unknown}`)).toHaveCount(0);
    await expect(page.getByTestId(`session-delete-recheck-${unknown}`)).toBeVisible();
    // 追溯号只在技术详情里，不进主提示句。
    await expect(panel.locator(".recent-work-delete-detail summary")).toContainText("技术详情");
    await expect(panel.locator(".recent-work-delete-result > .recent-work-confirm-text"))
      .not.toContainText("req-delete-unknown");
    await expect(panel.locator(".recent-work-delete-detail")).toContainText("req-delete-unknown");
    await page.screenshot({ path: `${evidenceDir}/05-single-unresolved.png` });
  });

  test("批量删除后核对回执：确认已删的那条当场从列表收掉，刷新后与服务端一致", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const server = await installRoutes(page);
    await page.goto("/agent");
    await connect(page);

    await page.getByTestId(`recent-work-${lateConfirmed}`).hover();
    await page.getByTestId(`recent-work-select-${lateConfirmed}`).check();
    await page.getByTestId(`recent-work-${unknown}`).hover();
    await page.getByTestId(`recent-work-select-${unknown}`).check();
    await page.getByTestId("recent-work-batch-delete").click();
    await page.getByTestId("recent-work-batch-delete-confirm").click();

    // 两条都停在待核实（其中一条在服务端其实已经删成功）：结果未定时界面一行都不收。
    const notice = page.getByTestId("recent-work-batch-notice");
    await expect(notice).toContainText("2 段待核实");
    await expect(page.getByTestId(`recent-work-${lateConfirmed}`)).toBeVisible();
    await expect(page.getByTestId(`recent-work-${unknown}`)).toBeVisible();
    expect(server.deleted.has(lateConfirmed)).toBe(true);
    // 选择已清空：待核实的行仍在，但不再以「已选」的身份留在批量条里。
    await expect(page.getByTestId("recent-work-selection")).toHaveCount(0);
    await page.screenshot({ path: `${evidenceDir}/06-recheck-before.png` });

    const readsBefore = server.receiptReads;
    await notice.getByRole("button", { name: "核对回执" }).click();
    // 按原 command_id 核对到已提交：行一起收掉，不是只改统计。
    await expect(page.getByTestId(`recent-work-${lateConfirmed}`)).toHaveCount(0);
    await expect(page.getByTestId(`recent-work-select-${lateConfirmed}`)).toHaveCount(0);
    // 仍查不到回执的那条原样留着：不改成成功，也不改成失败。
    await expect(page.getByTestId(`recent-work-${unknown}`)).toBeVisible();
    await expect(page.getByTestId(`recent-work-select-${unknown}`)).not.toBeChecked();
    await expect(notice).toContainText("已删除 1 段");
    await expect(notice).toContainText("1 段待核实");
    // 核对只读回执：两条各一发删除命令，没有第三发；核对按钮也只在原命令上查了一次。
    expect(server.deleteCalls).toEqual([lateConfirmed, unknown]);
    expect(server.receiptReads).toBe(readsBefore + 2);
    await page.screenshot({ path: `${evidenceDir}/07-recheck-after.png` });

    // 刷新一次：界面回到服务端事实，确认已删的那条不会借着重读回来。
    await page.reload();
    await connect(page);
    await expect(page.getByTestId(`recent-work-${lateConfirmed}`)).toHaveCount(0);
    await expect(page.getByTestId(`recent-work-${unknown}`)).toBeVisible();
    await expect(page.getByTestId(`recent-work-${blocked}`)).toBeVisible();
    await page.screenshot({ path: `${evidenceDir}/08-after-refresh.png` });
  });
});
