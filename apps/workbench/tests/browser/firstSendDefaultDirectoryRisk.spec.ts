import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * 首条消息的风险预检必须包含「服务端会继承的默认工作目录」（P0-1，2026-10-31）。
 *
 * 每一条都只核对用户能看见的事实：确认条出现之前有没有建会话/提交消息、取消后原文与附件
 * 还在不在、确认后是不是只提交一次、默认目录不可用或实际落点不同的时候有没有冒充安全。
 * 全部走页面内夹具：不连数据库、不调 Provider、不写任何真实业务事实。
 */

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const sessionId = "66666666-6666-4666-8666-666666666666";
const resourceId = "99999999-9999-4999-8999-999999999999";
const otherResourceId = "77777777-7777-4777-8777-777777777777";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = `http://127.0.0.1:${process.env.RELAY_E2E_PORT ?? "4173"}`;

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(),
    body: JSON.stringify(body) });
}

/** 180K tokens 的 AGENTS.md：与真实体积同量级（540 KB ÷ 3）。 */
function auditBody(): unknown {
  return {
    state: "OK", detail: "1 份必读文件已计入预计加载量。",
    agent: { id: "relay", label: "Relay 内置 Agent" }, root: "D:\\Work\\Big",
    scanned_at: "2026-10-31T04:00:00.000Z", fingerprint: "fp-default-dir-severe", severity: "SEVERE",
    files: [{ path: "AGENTS.md", category: "TASK_REQUIRED", scope: "ROOT",
      reason: "项目规则入口：会话按项目约定在首轮完整读取。", bytes: 540_000,
      estimated_tokens: 180_000, modified_at: "2026-10-31T03:59:00.000Z", share: 0.78,
      severity: "SEVERE" }],
    budget: { provider_window_tokens: 256_000, provider_window_known: true,
      call_budget_tokens: 256_000, call_budget_source: "WORKSPACE_TIER",
      effective_input_tokens: 231_000, effective_basis: "PROVIDER_WINDOW",
      reserves: { output_tokens: 8_192, system_prompt_tokens: 2_000,
        tool_definition_tokens: 4_096, history_tokens: 0 },
      estimated_total_input_tokens: 189_688, required_total_tokens: 180_000,
      required_total_share: 0.78, confidence: "EXACT_WINDOW",
      estimate: { method: "ESTIMATED_UTF8_BYTES_DIV_3", bytes_per_token: 3,
        note: "按 UTF-8 字节数 ÷ 3 估算，与上下文构建、模型端口的预算口径一致。" } },
    reasons: [{ code: "SINGLE_FILE_SEVERE", text: "AGENTS.md 预计占有效输入预算的 78%",
      ratio: 0.78, path: "AGENTS.md" }],
    suggestions: [{ code: "SPLIT_ENTRY", text: "把大型入口文件拆成两段。" }],
    skipped: [], access: null,
    thresholds: { single_file: { notice: 0.15, high: 0.30, severe: 0.50 },
      total_files: { notice: 0.30, high: 0.50, severe: 0.75 } },
  };
}

function session(boundDirectoryId: string | null): Record<string, unknown> {
  return { id: sessionId, workspace_id: workspaceId, project_id: null, task_id: null,
    title: "整理实验评价指标", status: "ACTIVE", revision: "1",
    conversation_mode: "AGENT", chat_mode: "PLAN", assistant_profile_id: null,
    assistant_profile_revision: null, remember: false,
    working_resource_id: boundDirectoryId,
    context: { project_goals: [], working_directory: boundDirectoryId === null ? null
      : { resource_id: boundDirectoryId, canonical_root: "D:\\Work\\Big",
        source: "WORKSPACE_DEFAULT" } },
    has_messages: false, run_state: null, list_state: "NOT_STARTED",
    created_at: "2026-10-31T04:00:00Z", updated_at: "2026-10-31T04:00:00Z" };
}

interface State {
  sessionPosts: number; messagePosts: number;
  lastSession: Record<string, unknown> | null;
  lastMessage: Record<string, unknown> | null;
  auditRequests: number;
}

type DefaultDirectory = "ready" | "unavailable" | "unset";
type BoundDirectory = "checks-scanned" | "different" | "none";

async function installRoutes(page: Page, options: {
  readonly directory?: DefaultDirectory;
  readonly bound?: BoundDirectory;
} = {}): Promise<State> {
  const state: State = { sessionPosts: 0, messagePosts: 0, lastSession: null,
    lastMessage: null, auditRequests: 0 };
  const directory = options.directory ?? "ready";
  const bound = options.bound ?? "checks-scanned";
  const boundDirectoryId = bound === "none" ? null
    : bound === "checks-scanned" ? resourceId : otherResourceId;
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/default-working-directory`) {
      return fulfillJson(route, directory === "unset"
        ? { resource_id: null, canonical_root: null, display_name: null, write_tier: null,
          default_write_tier: null, context_budget_tokens: 262_144, status: "UNSET",
          reason: null, revision: "1" }
        : { resource_id: resourceId, canonical_root: "D:\\Work\\Big",
          display_name: "Big", write_tier: "READ_ONLY", default_write_tier: null,
          context_budget_tokens: 262_144,
          status: directory === "ready" ? "READY" : "UNAVAILABLE",
          reason: directory === "ready" ? null : "DIRECTORY_UNAVAILABLE", revision: "2" });
    }
    if (path === `${prefix}/model-port`) return fulfillJson(route, { provider: "fake",
      configured: false, model: null, base_url: null, max_call_tokens: 262_144 });
    if (path === `${prefix}/model-port/verification`) return fulfillJson(route,
      { current_config_fingerprint: null, last: null, matches_current_config: false,
        worker_startup_validation: "NOT_CONFIGURED" });
    if (path === `${prefix}/memory-settings`) return fulfillJson(route, { workspace_id: workspaceId,
      revision: "0", recall_enabled: true, automatic_compaction: true, auto_capture: true });
    if (path === `${prefix}/working-directories/${resourceId}/required-context-audit`) {
      state.auditRequests += 1;
      return fulfillJson(route, auditBody());
    }
    if (path === `${prefix}/working-directories/${otherResourceId}/required-context-audit`) {
      state.auditRequests += 1;
      return fulfillJson(route, { ...(auditBody() as Record<string, unknown>),
        severity: "NONE", files: [], reasons: [],
        budget: { ...((auditBody() as Record<string, unknown>).budget as Record<string, unknown>),
          required_total_tokens: 0, required_total_share: 0,
          estimated_total_input_tokens: 10_288 } });
    }
    if (path === `${prefix}/assist-sessions`) {
      if (request.method() !== "POST") return fulfillJson(route, { items: [] });
      state.sessionPosts += 1;
      state.lastSession = (request.postDataJSON() ?? {}) as Record<string, unknown>;
      return fulfillJson(route, { command_id: state.lastSession.command_id ?? "cmd",
        command_type: "CreateAssistSession", replayed: false, committed_at: "2026-10-31T04:00:00Z",
        result: { session_id: sessionId, workspace_id: workspaceId, project_id: null, task_id: null,
          title: "整理实验评价指标", status: "ACTIVE", revision: "1",
          conversation_mode: "AGENT", assistant_profile_id: null,
          assistant_profile_revision: null, remember: false,
          created_at: "2026-10-31T04:00:00Z", updated_at: "2026-10-31T04:00:00Z" } }, 201);
    }
    if (path === `${prefix}/assist-sessions/${sessionId}`) {
      return fulfillJson(route, session(boundDirectoryId));
    }
    if (path === `${prefix}/assist-sessions/${sessionId}/message-attachments`) {
      const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
      return fulfillJson(route, { attachment_id: "cccccccc-1111-4111-8111-cccccccccccc",
        byte_length: String(body.data_base64 ?? "").length, content_hash: "d".repeat(64) }, 201);
    }
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) {
      if (request.method() !== "POST") return fulfillJson(route, { items: [] });
      state.messagePosts += 1;
      state.lastMessage = (request.postDataJSON() ?? {}) as Record<string, unknown>;
      return fulfillJson(route, { command_id: state.lastMessage.command_id ?? "cmd",
        command_type: "RequestAssistMessage", replayed: false,
        committed_at: "2026-10-31T04:00:00Z",
        result: { session_id: sessionId, user_message_id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
          assistant_message_id: "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb",
          chat_mode: "PLAN", goal_id: null } }, 202);
    }
    return fulfillJson(route, { items: [], next_cursor: null });
  });
  return state;
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("default-directory-risk-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" })
    .waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
  await page.getByTestId("assist-first-draft").waitFor({ timeout: 20_000 });
}

/** 从欢迎页（工作区级、延迟建会话）直接发第一条消息。 */
async function openWelcome(page: Page): Promise<void> {
  await page.goto("/agent?new=browser");
  await connect(page);
}

test.describe("首条消息的默认目录风险预检", () => {
  test.use({ viewport: { width: 1487, height: 1058 } });

  test("默认目录有 180K 必读文件：确认前不建会话不提交，取消保留原文与附件，确认只提交一次", async ({ page }) => {
    const state = await installRoutes(page);
    await openWelcome(page);
    // 预检扫的必须是服务端会继承的默认目录，不是「没有绑定目录」。
    await expect.poll(() => state.auditRequests, { timeout: 20_000 }).toBeGreaterThan(0);
    await expect(page.getByTestId("context-risk-notice")).toBeVisible({ timeout: 20_000 });

    const draft = page.getByTestId("assist-first-draft");
    await draft.fill("/plan 帮我把实验评价指标整理成表格");
    await page.setInputFiles('[data-testid="assist-attach-upload-input"]', {
      name: "baseline.png", mimeType: "image/png",
      buffer: Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex") });
    await expect(page.getByTestId("composer-attachments")).toContainText("baseline.png");

    await page.getByTestId("assist-first-send").click();
    const gate = page.getByTestId("context-risk-gate");
    await gate.waitFor({ timeout: 20_000 });
    await expect(gate).toHaveAttribute("data-severity", "SEVERE");
    // 关键：确认之前既没有建会话，也没有提交消息。
    await page.waitForTimeout(600);
    expect(state.sessionPosts).toBe(0);
    expect(state.messagePosts).toBe(0);

    await page.getByTestId("context-risk-gate-cancel").click();
    await expect(gate).toHaveCount(0);
    expect(state.sessionPosts).toBe(0);
    expect(state.messagePosts).toBe(0);
    // 取消 = 真取消：原文、模式（/plan 仍在正文里）与附件都还在。
    await expect(draft).toHaveValue("/plan 帮我把实验评价指标整理成表格");
    await expect(page.getByTestId("composer-attachments")).toContainText("baseline.png");

    await page.getByTestId("assist-first-send").click();
    await gate.waitFor({ timeout: 20_000 });
    await page.getByTestId("context-risk-gate-continue").click();
    await expect.poll(() => state.messagePosts, { timeout: 20_000 }).toBe(1);
    // 只建一次会话、只提交一次：确认之后的按钮不会被第二次点击穿过。
    expect(state.sessionPosts).toBe(1);
    await page.waitForTimeout(600);
    expect(state.sessionPosts).toBe(1);
    expect(state.messagePosts).toBe(1);
    // 提交的是被检查过的那一份：模式随命令走，正文里不再带 /plan 前缀。
    expect(state.lastSession?.chat_mode).toBe("PLAN");
    expect(state.lastMessage?.content).toBe("帮我把实验评价指标整理成表格");
    expect(state.lastMessage?.chat_mode).toBe("PLAN");
  });

  test("默认目录不可用：不冒充安全，停在风险未知且不建会话", async ({ page }) => {
    const state = await installRoutes(page, { directory: "unavailable" });
    await openWelcome(page);
    const draft = page.getByTestId("assist-first-draft");
    await draft.fill("先读必读文件再回复");
    await page.getByTestId("assist-first-send").click();
    const gate = page.getByTestId("context-risk-gate");
    await gate.waitFor({ timeout: 20_000 });
    await expect(gate).toHaveAttribute("data-mode", "unknown");
    await expect(gate).toHaveAttribute("data-reason", "SCOPE_UNKNOWN");
    await expect(page.getByTestId("context-risk-gate-unknown")).toContainText("默认工作目录");
    await page.waitForTimeout(600);
    expect(state.sessionPosts).toBe(0);
    expect(state.messagePosts).toBe(0);
    await page.getByTestId("context-risk-gate-cancel").click();
    await expect(draft).toHaveValue("先读必读文件再回复");
  });

  test("实际绑定的目录与检查时不同：不提交这条消息，明说风险未知", async ({ page }) => {
    // 检查时认定默认目录 A 且没有风险；创建后读回来的却是另一个目录。
    const state = await installRoutes(page, { bound: "different" });
    // 让 A 的审计无风险：这个用例关心的是目录落点，不是阈值。带 `**` 才能匹配查询串。
    await page.route(`${apiBase}${prefix}/working-directories/${resourceId}/required-context-audit**`,
      (route) => fulfillJson(route, { ...(auditBody() as Record<string, unknown>), severity: "NONE",
        files: [], reasons: [] }));
    await openWelcome(page);
    await page.getByTestId("assist-first-draft").fill("看一下这个目录");
    await page.getByTestId("assist-first-send").click();
    await expect.poll(() => state.sessionPosts, { timeout: 20_000 }).toBe(1);
    await page.waitForTimeout(800);
    expect(state.messagePosts).toBe(0);
    await expect(page.getByText(/风险未知：会话已创建/u)).toBeVisible({ timeout: 20_000 });
  });

  test("连续两次提交（同一拍）：只建一次会话、只提交一次", async ({ page }) => {
    // 没有默认目录：预检不扫盘，两次提交都直达建会话——这里核对的是第二道同步闸。
    const state = await installRoutes(page, { directory: "unset", bound: "none" });
    await openWelcome(page);
    await page.getByTestId("assist-first-draft").fill("看一眼就发");
    // 同一个任务里连发两次 submit：React 还来不及重渲染，只有同步闸能挡住第二次。
    // 用 dispatchEvent 而不是 requestSubmit()：后者在没有可用默认按钮时会按规范直接不提交。
    await page.evaluate(() => {
      const form = document.querySelector('[data-testid="assist-first-message"] form');
      if (!(form instanceof HTMLFormElement)) throw new Error("first composer form not found");
      const fire = (): void => {
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      };
      fire(); fire();
    });
    await expect.poll(() => state.messagePosts, { timeout: 20_000 }).toBe(1);
    await page.waitForTimeout(800);
    expect(state.sessionPosts).toBe(1);
    expect(state.messagePosts).toBe(1);
  });
});
