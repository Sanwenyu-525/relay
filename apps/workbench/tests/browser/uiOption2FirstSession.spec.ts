import { expect, test, type Page, type Route } from "@playwright/test";

// 2026-10-03 独立验收四项缺陷的真实 Chromium 点击覆盖。
// 「已提交但响应丢失」是明确标注的受控故障（route.abort），不是服务端真实失败。
// 这里的 API 全部由页面内拦截伪造，只验证客户端行为，不连数据库、不调 Provider。

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const sessionId = "66666666-6666-4666-8666-666666666666";
const reviewId = "77777777-7777-4777-8777-777777777777";
const artifactVersionV1 = "v1";
const artifactVersionV2 = "v2";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const root = "D:\\Develop\\MyProject";
// 仓库浏览器套件的 Run SSE 夹具把 CORS 固定在这个端口；本文件用同一来源，不引入第二个服务。
const origin = "http://127.0.0.1:4173";

interface Ctx {
  posts: { path: string; body: Record<string, unknown> }[];
  /** 受控故障：POST 消息在服务端已提交后中断响应。数字表示只中断前 n 次。 */
  loseMessageResponse: number;
  receipts: Map<string, unknown>;
  /** 建会话成功后该会话出现在会话列表里，界面切到正常会话。 */
  sessionCreated: boolean;
  /** 结构对齐用例需要足够长的消息流，才能真正触发滚动容器判定。 */
  messages: unknown[];
  /** 左栏近期工作列表；搜索用例需要真实条目。 */
  tasks: unknown[];
  assistantProfiles?: unknown[];
}

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type",
    "access-route": origin };
}

function readyDirectory(): unknown {
  return { canonical_root: root, display_name: "MyProject", status: "READY", reason: null,
    association: { project_id: projectId, project_title: "MyProject", project_archived: false,
      resource_id: "res-1", resource_status: "ACTIVE", file_write_identity_bound: true },
    created_project: true, created_resource: true, candidates: [],
    write_readiness: { status: "NEEDS_CONNECTION", detail: "本项目还没有绑定该目录的文件写入连接。" } };
}

function project(): unknown {
  return { id: projectId, title: "MyProject", project_type: "GENERAL", revision: "1",
    state_revision: "1", archived_at: null };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(), body: JSON.stringify(body) });
}

async function installRoutes(page: Page, ctx: Ctx): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }

    if (request.method() === "POST") {
      const body = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>;
      ctx.posts.push({ path, body });
      if (path === `${prefix}/working-directories/open`) {
        return fulfillJson(route, { command_id: body.command_id, committed_at: "2026-10-03T00:00:00Z",
          result: readyDirectory(), links: { resource: "" } });
      }

        if (path === `${prefix}/assist-sessions`) {
        ctx.sessionCreated = true;
        return fulfillJson(route, { command_id: body.command_id,
          committed_at: "2026-10-03T00:00:00Z",
          result: { session_id: sessionId, workspace_id: workspaceId, project_id: projectId, task_id: null,
            title: "关于MyProject", status: "ACTIVE", revision: "1",
            created_at: "2026-10-03T00:00:00Z", updated_at: "2026-10-03T00:00:00Z" },
          links: { resource: "" } }, 201);
      }
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`) {
        // 受控故障：服务端已接受，这里直接中断响应，前端拿不到 user_message_id。
        if (ctx.loseMessageResponse > 0) {
          ctx.loseMessageResponse -= 1;
          return route.abort("failed");
        }
        // 真实服务端会提交这条消息；夹具把它记进列表，后续 GET 才能看到同一段对话。
        const index = ctx.messages.length;
        ctx.messages.push({ id: `u-${index}`, session_id: sessionId, seq: String(index * 2), role: "USER",
          status: "COMPLETED", intent: "DISCUSS", content: String(body.content ?? ""), error_code: null,
          sources: [], usage: { input_tokens: 1, output_tokens: 1 }, cancel_requested: false });
        ctx.messages.push({ id: `a-${index}`, session_id: sessionId, seq: String(index * 2 + 1),
          role: "ASSISTANT", status: "COMPLETED", intent: "DISCUSS", content: `第 ${index} 轮回复`.repeat(20),
          error_code: null, sources: [], usage: { input_tokens: 1, output_tokens: 1 }, cancel_requested: false });
        return fulfillJson(route, { command_id: body.command_id, committed_at: "2026-10-03T00:00:00Z",
          result: { session_id: sessionId, user_message_id: `u-${index}`, assistant_message_id: `a-${index}` },
          links: { resource: "" } }, 202);
      }
      if (path === `${prefix}/assist-sessions/${sessionId}/execution-requests`) {
        return fulfillJson(route, { command_id: body.command_id, committed_at: "2026-10-03T00:00:00Z",
          result: { request_id: "abababab-abab-4bab-8bab-abababababab", session_id: sessionId,
            source_message_id: body.source_message_id, resource_id: body.resource_id, root_path: root,
            decision: "PREPARE", status: "READY", candidate_status: "READY", questions: [],
            candidate: { title: "改写 answer.txt", objective: "内容变成 after" },
            task_id: null, run_id: null, revision: "1" }, links: { resource: "" } }, 202);
      }
      return fulfillJson(route, { code: "NOT_FOUND", detail: path }, 404);
    }

    const receipt = /\/commands\/([^/]+)$/u.exec(path);
    if (receipt) {
      const found = ctx.receipts.get(receipt[1]!);
      return found === undefined
        ? fulfillJson(route, { code: "NOT_FOUND", detail: "命令回执不存在" }, 404)
        : fulfillJson(route, found);
    }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/projects/${projectId}`) return fulfillJson(route, project());
    if (path === `${prefix}/projects/${projectId}/state`) {
      return fulfillJson(route, { project_id: projectId, revision: "1", phase_key: "GENERAL",
        next_action_task_id: null, selected_artifact_version_refs: [], completed_highlight_refs: [] });
    }
    if (path === `${prefix}/projects`) {
      return fulfillJson(route, { items: [{ ...project() as Record<string, unknown>, archive_status: "ACTIVE",
        phase_key: "GENERAL", next_action_task_id: null, created_at: "2026-10-03T00:00:00Z",
        updated_at: "2026-10-03T00:00:00Z" }], next_cursor: null });
    }
    if (path === `${prefix}/tasks/${taskId}`) {
      return fulfillJson(route, { id: taskId, project_id: projectId, title: "判断对象任务", status: "IN_PROGRESS",
        mode: "ME", revision: "2", executor: { kind: "HUMAN", run_id: null, ownership_epoch: "0" },
        current_completion_id: null, waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [],
        allowed_actions: [], acceptance: { acceptance_revision: "2", objective: "核对确切版本",
          source: "CREATE", criteria: [] }, dependencies: [] });
    }
    if (path === `${prefix}/tasks/${taskId}/artifacts`) {
      return fulfillJson(route, { current_accepted_version_ids: [], items: [{ id: "artifact", task_id: taskId,
        project_id: projectId, title: "判断对象.md", revision: "2", latest_version_id: artifactVersionV2,
        version_count: 2,
        versions: [artifactVersionV2, artifactVersionV1].map((id) => ({ artifact_version_id: id,
          version_number: id === artifactVersionV1 ? "1" : "2", media_type: "text/markdown",
          sha256: id.repeat(64), size: "10", source_kind: "HUMAN", created_at: "2026-10-03T00:00:00Z" })) }] });
    }
    if (/artifact-versions\/(v1|v2)\/content$/u.test(path)) {
      const version = /artifact-versions\/(v1|v2)\/content$/u.exec(path)![1];
      return route.fulfill({ status: 200, contentType: "text/markdown; charset=utf-8", headers: cors(),
        body: `# 判断对象 v${version === artifactVersionV1 ? "1" : "2"}\n\n这是第 ${version} 版的正文。` });
    }
    if (path === `${prefix}/reviews` && url.searchParams.get("status") === "OPEN") {
      return fulfillJson(route, { items: [review()] });
    }
    if (path === `${prefix}/reviews/${reviewId}`) return fulfillJson(route, review());
    if (path === `${prefix}/assist-sessions`) {
      return fulfillJson(route, { items: ctx.sessionCreated ? [{ id: sessionId, workspace_id: workspaceId,
        project_id: projectId, task_id: null, title: "关于MyProject", status: "ACTIVE", revision: "1",
        created_at: "2026-10-03T00:00:00Z", updated_at: "2026-10-03T00:00:00Z" }] : [] });
    }
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return fulfillJson(route, { items: ctx.messages });
    if (path.startsWith(`${prefix}/conversation-execution-requests`)) return fulfillJson(route, { items: [] });
    if (path === `${prefix}/assist-proposals`) return fulfillJson(route, { items: [] });
    if (path === `${prefix}/assistant-profiles`) return fulfillJson(route, { items: ctx.assistantProfiles ?? [] });
    if (path === `${prefix}/chat-commands`) return fulfillJson(route, { items: [
      { kind: "METHOD", name: "review", aliases: ["代码审查", "审查"], title: "代码审查",
        summary: "阅读当前改动及相关影响，不自动修复。", usage: "/review [目标]", method_id: "code-review" },
      { kind: "METHOD", name: "diagnose", aliases: ["诊断"], title: "故障诊断",
        summary: "默认定位，明确修好才修改。", usage: "/diagnose [目标]", method_id: "fault-diagnosis" },
      { kind: "SYSTEM", name: "clear", aliases: ["清空"], title: "/clear",
        summary: "新建空会话，保留项目与目录绑定。", usage: "/clear", system_id: "clear" },
      { kind: "SYSTEM", name: "compact", aliases: ["压缩"], title: "/compact",
        summary: "整理当前会话上下文。", usage: "/compact", system_id: "compact" }
    ] });
    if (path === `${prefix}/skill-definitions`) return fulfillJson(route, { items: [] });
    if (path === `${prefix}/model-port`) {
      return fulfillJson(route, { provider: "fake", configured: false, model: null, base_url: null,
        max_call_tokens: null });
    }
    if (path === `${prefix}/model-port/verification`) {
      return fulfillJson(route, { current_config_fingerprint: null, last: null,
        matches_current_config: false, worker_startup_validation: "NOT_CONFIGURED" });
    }
    if (path.startsWith(`${prefix}/search`)) return fulfillJson(route, { items: [], next_cursor: null });
    if (path === `${prefix}/tasks`) return fulfillJson(route, { items: ctx.tasks, next_cursor: null });
    return fulfillJson(route, { code: "NOT_FOUND", detail: path }, 404);
  });
}

function review(): unknown {
  return { id: reviewId, kind: "CRITERION", status: "OPEN", revision: "1", project_id: projectId,
    task_id: taskId, run_id: null, reason: "NEEDS_HUMAN_JUDGEMENT", target_hash: "a".repeat(64),
    target: { artifact_version_id: artifactVersionV1, acceptance_revision: "2", criterion_id: "human-1" },
    evidence: { check_result: "自动检查不能代替人工判断" },
    effect: { on_accept: "保存人工判断", on_request_changes: "按原验收契约继续修正" },
    allowed_decisions: ["ACCEPT", "REQUEST_CHANGES"], expires_at: null,
    created_at: "2026-10-03T00:00:00Z", decided_at: null };
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("ui-option2-browser-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

async function openFolder(page: Page, ctx: Ctx): Promise<void> {
  await installRoutes(page, ctx);
  await page.goto("/agent");
  await connect(page);
  await page.getByTestId("folder-scope-change").click();
  await page.locator('[data-testid="folder-manual-root"]').fill(root);
  await page.locator('[data-testid="folder-open-manual"]').click();
  // 目录定下来后更换目录框自行关闭（协作页 §3.3），这里不需要再手动收起。
  await page.locator('[data-testid="assist-first-draft"]').waitFor({ timeout: 20_000 });
}

test.describe("方案 2 独立验收四项整改（真实 Chromium）", () => {
  test("聊天命令菜单在窄窗口可读，选择仅插入；首条发送后已有会话沿用菜单", async ({ page }) => {
    const ctx: Ctx = { posts: [], loseMessageResponse: 0, receipts: new Map(), sessionCreated: false, messages: [], tasks: [] };
    await page.setViewportSize({ width: 843, height: 600 });
    await openFolder(page, ctx);
    const first = page.getByTestId("assist-first-draft");
    await first.click();
    await first.fill("/");
    await expect(first).toBeFocused();
    const menu = page.getByTestId("chat-command-menu");
    await expect(menu.getByRole("option")).toHaveCount(4);
    await expect(page.getByTestId("chat-command-clear")).toContainText("需已有会话");
    await expect(page.getByTestId("chat-command-compact")).toContainText("待接入");
    const geometry = await menu.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const textarea = document.querySelector<HTMLTextAreaElement>('[data-testid="assist-first-draft"]')!.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom,
        inputBottom: textarea.bottom, viewport: { width: innerWidth, height: innerHeight },
        pageWidth: document.documentElement.scrollWidth };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewport.width);
    expect(geometry.top).toBeGreaterThanOrEqual(0);
    expect(geometry.inputBottom).toBeLessThanOrEqual(geometry.viewport.height);
    expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.viewport.width);
    await page.screenshot({ path: "../../output/playwright/chat-command-menu-narrow.png" });
    await first.press("ArrowDown");
    await first.press("Enter");
    await expect(first).toHaveValue("/diagnose ");
    await expect(first).toBeFocused();
    expect(ctx.posts.filter((item) => !item.path.endsWith("/working-directories/open"))).toHaveLength(0);
    await first.fill("/审查");
    await page.getByTestId("chat-command-review").click();
    await expect(first).toHaveValue("/review ");
    await first.fill("/review 检查当前改动");
    await page.getByTestId("assist-first-send").click();
    const existing = page.getByTestId("assist-draft");
    await expect(existing).toBeVisible();
    expect(ctx.posts.filter((item) => item.path.endsWith("/messages"))).toHaveLength(1);
    expect(ctx.posts.find((item) => item.path.endsWith("/messages"))?.body.content).toBe("/review 检查当前改动");
    await existing.fill("/清空");
    await expect(page.getByTestId("chat-command-clear")).toContainText("可用");
    await existing.press("Escape");
    await expect(menu).toBeHidden();
    await expect(existing).toHaveValue("/清空");
    expect(ctx.posts.filter((item) => item.path.endsWith("/chat-commands"))).toHaveLength(0);
  });

  test("首条助手档没有有效助手时不显示普通讨论且不能创建；切回普通档保留草稿并发送", async ({ page }) => {
    const ctx: Ctx = { posts: [], loseMessageResponse: 0, receipts: new Map(), sessionCreated: false,
      messages: [], tasks: [], assistantProfiles: [] };
    await openFolder(page, ctx);
    const draft = page.getByTestId("assist-first-draft");
    await draft.fill("切换模式仍保留的草稿");
    await page.getByTestId("assist-conversation-mode-assistant").check();
    await expect(page.locator("details.agent-chat-options")).toHaveCount(0);
    await expect(page.getByTestId("assist-first-blocked")).toContainText("当前没有可用助手");
    await expect(page.getByTestId("assist-first-send")).toBeDisabled();
    await expect(draft).toHaveValue("切换模式仍保留的草稿");

    await draft.press("Enter");
    await page.locator('[data-testid="assist-first-message"] form.agent-chat-message-form').evaluate((form) =>
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(ctx.posts.filter((post) => post.path === `${prefix}/assist-sessions`)).toHaveLength(0);
    expect(ctx.posts.filter((post) => post.path.endsWith("/messages"))).toHaveLength(0);

    await page.getByTestId("assist-conversation-mode-agent").check();
    await expect(page.locator("details.agent-chat-options")).toBeVisible();
    await expect(draft).toHaveValue("切换模式仍保留的草稿");
    await page.getByTestId("assist-first-send").click();
    await expect.poll(() => ctx.posts.filter((post) => post.path.endsWith("/messages")).length,
      { timeout: 20_000 }).toBe(1);
    const created = ctx.posts.find((post) => post.path === `${prefix}/assist-sessions`);
    const sent = ctx.posts.find((post) => post.path.endsWith("/messages"));
    expect(created?.body).toMatchObject({ conversation_mode: "AGENT" });
    expect(sent?.body).toMatchObject({ content: "切换模式仍保留的草稿", intent: "DISCUSS" });
  });

  test("新建与已有会话的模式 chip 在四种窗口尺寸下保持单行、无重叠且助手说明可读", async ({ page }) => {
    const ctx: Ctx = { posts: [], loseMessageResponse: 0, receipts: new Map(), sessionCreated: false,
      messages: [], tasks: [], assistantProfiles: [] };
    const viewports = [
      { width: 843, height: 782 }, { width: 1162, height: 782 },
      { width: 2048, height: 1104 }, { width: 843, height: 600 }
    ];
    await openFolder(page, ctx);
    const draft = page.getByTestId("assist-first-draft");
    await draft.fill("跨视口切换时保留的草稿");

    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      // 断点切换可能先显示目标/会话读取态；等输入器回到真实草稿后再量几何。
      await expect(draft).toHaveValue("跨视口切换时保留的草稿");
      const look = await page.evaluate(() => {
        const chip = document.querySelector<HTMLElement>(".agent-chat-mode-picker > .agent-chat-mode-option")!;
        const tools = document.querySelector<HTMLElement>(".agent-chat-composer-tools")!;
        const key = document.querySelector<HTMLElement>(".agent-chat-send")!;
        const composer = document.querySelector<HTMLElement>(".agent-chat-composer")!;
        const box = (node: HTMLElement) => {
          const rect = node.getBoundingClientRect();
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
            width: rect.width, height: rect.height };
        };
        return { chip: box(chip), tools: box(tools), key: box(key), composer: box(composer),
          viewportWidth: document.documentElement.clientWidth, pageWidth: document.documentElement.scrollWidth };
      });
      expect(Math.abs(look.chip.height - look.key.height)).toBeLessThanOrEqual(1);
      expect(look.chip.left).toBeGreaterThanOrEqual(look.composer.left - 1);
      expect(look.chip.right).toBeLessThanOrEqual(look.composer.right + 1);
      expect(look.key.left).toBeGreaterThanOrEqual(look.composer.left - 1);
      expect(look.key.right).toBeLessThanOrEqual(look.composer.right + 1);
      expect(look.tools.bottom).toBeLessThanOrEqual(look.composer.bottom + 1);
      expect(look.pageWidth).toBeLessThanOrEqual(look.viewportWidth + 1);

      const agent = page.getByTestId("assist-conversation-mode-agent");
      const before = await page.evaluate(() => ({
        composer: document.querySelector<HTMLElement>(".agent-chat-composer")!.getBoundingClientRect().height,
        tools: document.querySelector<HTMLElement>(".agent-chat-composer-tools")!.getBoundingClientRect().height
      }));
      await agent.focus();
      await page.keyboard.press("ArrowRight");
      await expect(page.getByTestId("assist-conversation-mode-assistant")).toBeChecked();
      await expect(page.getByTestId("assist-assistant-config-toggle")).toBeVisible();
      // 空清单时「新建助手」就地摆在 chip 旁：模式盒里只有图例、三个模式标签、chip 与该入口，
      // 整段可见文字逐字钉住，多出来的裸字符（例如误留在 JSX 里的分号）会在这里现形。
      await expect(page.getByTestId("assist-assistant-create-entry")).toBeVisible();
      expect(await page.getByTestId("conversation-mode").innerText())
        .toBe("会话模式\n普通 Agent\n人设助手\n学习\n选择助手\n新建助手");
      await expect(page.getByTestId("assist-readonly-note")).toBeVisible();
      await expect(page.getByTestId("assist-first-blocked")).toBeVisible();
      await expect(page.getByTestId("assist-first-send")).toBeDisabled();
      await expect(draft).toHaveValue("跨视口切换时保留的草稿");
      // 撑高的东西一件都不许留在输入框里：下拉、空清单提示与新建表单都收在弹窗内；
      // 就地新建入口是唯一例外（已在上面的模式盒文字里钉住），它不新增行。
      await expect(page.getByTestId("assist-assistant-picker")).toHaveCount(0);
      await expect(page.getByTestId("assist-assistant-list-empty")).toHaveCount(0);
      await expect(page.getByTestId("assist-assistant-create-toggle")).toHaveCount(0);
      const expanded = await page.evaluate(() => {
        const composer = document.querySelector<HTMLElement>(".agent-chat-composer")!;
        const tools = document.querySelector<HTMLElement>(".agent-chat-composer-tools")!;
        const note = document.querySelector<HTMLElement>('[data-testid="assist-readonly-note"]')!;
        const blocked = document.querySelector<HTMLElement>('[data-testid="assist-first-blocked"]')!;
        const chip = document.querySelector<HTMLElement>('[data-testid="assist-assistant-config-toggle"]')!;
        return { composerHeight: composer.getBoundingClientRect().height,
          noteHeight: note.getBoundingClientRect().height, chipHeight: chip.getBoundingClientRect().height,
          blockedHeight: blocked.getBoundingClientRect().height,
          toolsHeight: tools.getBoundingClientRect().height, toolsScrollHeight: tools.scrollHeight,
          blockedBottom: blocked.getBoundingClientRect().bottom, toolsBottom: tools.getBoundingClientRect().bottom,
          pageWidth: document.documentElement.clientWidth, pageScrollWidth: document.documentElement.scrollWidth };
      });
      // 助手档只该多出常驻的两行文字：只读说明 + 不能发送的原因。第三项是这两行把底栏
      // 挤到另起一行控件的代价（窄栏实测 843px 会多一行 32px 的计量环）。
      expect(expanded.composerHeight - before.composer).toBeLessThanOrEqual(
        expanded.noteHeight + expanded.blockedHeight + expanded.chipHeight + 12);
      expect(expanded.noteHeight).toBeGreaterThan(0);
      expect(expanded.toolsScrollHeight).toBeLessThanOrEqual(expanded.toolsHeight + 1);
      expect(expanded.blockedBottom).toBeLessThanOrEqual(expanded.toolsBottom + 1);
      expect(expanded.pageScrollWidth).toBeLessThanOrEqual(expanded.pageWidth + 1);

      // 配置弹窗：点开才有一件件控件，Esc 关掉后焦点回到 chip。
      const chip = page.getByTestId("assist-assistant-config-toggle");
      await chip.click();
      const config = page.getByRole("dialog", { name: "人设助手" });
      await expect(config).toBeVisible();
      await expect(config.getByTestId("assist-assistant-list-empty")).toBeVisible();
      await expect(config.getByTestId("assist-assistant-create-toggle")).toBeVisible();
      await expect(config.getByTestId("assist-remember-toggle")).toBeVisible();
      // 只读说明不跟着进弹窗——它必须不点开也看得见。
      await expect(config.getByTestId("assist-readonly-note")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(config).toHaveCount(0);
      await expect(chip).toBeFocused();

      await page.getByTestId("assist-conversation-mode-assistant").focus();
      await page.keyboard.press("ArrowLeft");
      await expect(agent).toBeChecked();
      await expect(draft).toHaveValue("跨视口切换时保留的草稿");
      await expect(page.locator("details.agent-chat-options")).toBeVisible();
    }

    await page.getByTestId("assist-first-send").click();
    await expect(page.getByTestId("assist-draft")).toBeVisible({ timeout: 20_000 });
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      // 首条发出后正在换到已有会话视图：先等模式盒就位，否则量到过渡态骨架。
      await expect(page.locator(".agent-chat-mode-picker > .agent-chat-mode-option").first()).toBeVisible();
      const look = await page.evaluate(() => {
        const chip = document.querySelector<HTMLElement>(".agent-chat-mode-picker > .agent-chat-mode-option")!;
        const key = document.querySelector<HTMLElement>(".agent-chat-send")!;
        const composer = document.querySelector<HTMLElement>(".agent-chat-composer")!;
        const chipRect = chip.getBoundingClientRect();
        const keyRect = key.getBoundingClientRect();
        const composerRect = composer.getBoundingClientRect();
        return { chipHeight: chipRect.height, keyHeight: keyRect.height,
          chipInside: chipRect.left >= composerRect.left - 1 && chipRect.right <= composerRect.right + 1,
          keyInside: keyRect.left >= composerRect.left - 1 && keyRect.right <= composerRect.right + 1,
          pageWidth: document.documentElement.scrollWidth, viewportWidth: document.documentElement.clientWidth };
      });
      expect(Math.abs(look.chipHeight - look.keyHeight)).toBeLessThanOrEqual(1);
      expect(look.chipInside).toBe(true);
      expect(look.keyInside).toBe(true);
      expect(look.pageWidth).toBeLessThanOrEqual(look.viewportWidth + 1);
    }
  });

  test("P2：首条草稿未发送时离页被拦截，保留后原文仍在，显式放弃才清除", async ({ page }) => {
    const ctx: Ctx = { posts: [], loseMessageResponse: 0, receipts: new Map(), sessionCreated: false, messages: [], tasks: [] };
    await openFolder(page, ctx);
    await page.locator('[data-testid="assist-first-draft"]').fill("还没发送的首条草稿");
    await page.locator('.app-navrail').getByRole("link", { name: "项目" }).click();

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toHaveAttribute("aria-label", "保留未保存的修改");
    await dialog.getByRole("button", { name: "保留并继续编辑" }).click();
    await expect(page).toHaveURL(/\/agent$/u);
    await expect(page.locator('[data-testid="assist-first-draft"]')).toHaveValue("还没发送的首条草稿");
    // 草稿保护不发任何业务命令，也不能用自动发送代替。
    expect(ctx.posts.filter((post) => post.path.endsWith("/messages"))).toHaveLength(0);
    expect(ctx.posts.filter((post) => post.path === `${prefix}/assist-sessions`)).toHaveLength(0);

    await page.locator('.app-navrail').getByRole("link", { name: "项目" }).click();
    await page.locator('[role="dialog"]').getByRole("button", { name: "丢弃草稿并离开" }).click();
    await expect(page).toHaveURL(/\/projects$/u);
    expect(ctx.posts.filter((post) => post.path === `${prefix}/assist-sessions`)).toHaveLength(0);
  });

  test("P1：建会话成功但首条消息响应丢失时按原命令重试恢复，不重建会话也不改载荷", async ({ page }) => {
    const ctx: Ctx = { posts: [], loseMessageResponse: 1, receipts: new Map(), sessionCreated: false, messages: [], tasks: [] };
    await openFolder(page, ctx);
    await page.locator('[data-testid="assist-first-draft"]').fill("帮我把这个文件的内容改成 after");
    await page.locator('[data-testid="assist-first-send"]').click();

    const pending = page.locator('[data-testid="assist-first-pending"]');
    await expect(pending).toBeVisible({ timeout: 20_000 });
    const messagePost = ctx.posts.find((post) => post.path.endsWith("/messages"));
    const commandId = messagePost?.body.command_id as string;
    expect(commandId).toMatch(/^[0-9a-f-]{36}$/u);
    await expect(pending).toContainText(commandId);
    await expect(pending).toContainText("会话已创建");
    await expect(pending).toContainText("消息结果待核对");
    // 传输失败不能被说成业务失败，也不能宣称已完成：真实传输原因与部分成功事实分别可见。
    await expect(page.locator('[data-testid="assist-first-error"]')).toBeVisible();
    await expect(page.locator('[data-testid="assist-first-pending"]')).toContainText("核对前这条消息不算已送达");
    await expect(page.locator("main")).not.toContainText("已完成本轮");

    // 服务端确实已经接受这条消息，回执按原 command_id 可查。
    ctx.receipts.set(commandId, { command_id: commandId, command_type: "RequestAssistMessage",
      committed_at: "2026-10-03T00:00:05Z",
      result: { session_id: sessionId, user_message_id: "msg-1", assistant_message_id: "msg-2" } });
    // 用户在正常会话里继续改写输入；同 ID 重试仍按首条消息的原载荷与原 ID 走。
    await page.locator('[data-testid="assist-draft"]').fill("后来改写的别的内容");
    await page.locator('[data-testid="assist-first-retry"]').click();
    await expect(page.locator('[data-testid="assist-first-pending"]')).toHaveCount(0, { timeout: 20_000 });

    // 重试与后续不得再次建会话，也不得更换消息命令身份或混入后来修改的文本。
    expect(ctx.posts.filter((post) => post.path === `${prefix}/assist-sessions`)).toHaveLength(1);
    const messagePosts = ctx.posts.filter((post) => post.path.endsWith("/messages"));
    expect(messagePosts).toHaveLength(2);
    expect(messagePosts.every((post) => post.body.command_id === commandId)).toBe(true);
    expect((messagePosts[messagePosts.length - 1]?.body as { content?: string }).content)
      .toBe("帮我把这个文件的内容改成 after");
    // 重试成功后按回执里的真实 user message id 解释，且不重复产生效果。
    expect(ctx.posts.filter((post) => post.path.endsWith("/execution-requests"))).toHaveLength(1);
  });

  test("P3：首条明确执行输入按真实回执进入执行解释，且不自动建立任务", async ({ page }) => {
    const ctx: Ctx = { posts: [], loseMessageResponse: 0, receipts: new Map(), sessionCreated: false, messages: [], tasks: [] };
    await openFolder(page, ctx);
    await page.locator('[data-testid="assist-first-draft"]').fill("帮我把这个文件的内容改成 after");
    await page.locator('[data-testid="assist-first-send"]').click();

    await expect.poll(() => ctx.posts.filter((post) => post.path.endsWith("/execution-requests")).length,
      { timeout: 20_000 }).toBe(1);
    const requested = ctx.posts.find((post) => post.path.endsWith("/execution-requests"))!.body;
    // 解释依据是回执里的真实 user message id 与确切目录资源，不是前端关键词判断。
    expect(requested.source_message_id).toBe("u-0");
    expect(requested.resource_id).toBe("res-1");
    // 候选就绪也只是等待人工确认，不因首条发送自动建立 Task。
    expect(ctx.posts.some((post) => post.path.includes("/applications"))).toBe(false);
  });

  test("P4：完整待审页阅读其他版本时给出错配提醒，返回入口只重读绑定版本", async ({ page }) => {
    const ctx: Ctx = { posts: [], loseMessageResponse: 0, receipts: new Map(), sessionCreated: false, messages: [], tasks: [] };
    await installRoutes(page, ctx);
    await page.goto(`/reviews?id=${reviewId}`);
    await connect(page);
    await page.locator('[data-testid="review-bound-reader"]').waitFor({ timeout: 20_000 });
    await expect(page.locator('[data-testid="collab-review-version-mismatch"]')).toHaveCount(0);

    // 版本与比较默认收起；先展开再切换阅读版本。
    await page.locator('.review-reading .collab-version-details > summary').click();
    await page.locator('[data-testid="collab-read-v2"]').click();
    const warning = page.locator('[data-testid="collab-review-version-mismatch"]');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("正在阅读 v2");
    await expect(warning).toContainText("当前判断仍绑定「判断对象.md」v1");

    // 阅读切换不改 Review 绑定，也不发任何写命令。
    expect(ctx.posts).toHaveLength(0);
    await warning.getByRole("button", { name: "返回判断版本" }).click();
    await expect(page.locator('[data-testid="collab-review-version-mismatch"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="collab-reading"]')).toContainText("这是第 v1 版的正文");
    expect(ctx.posts).toHaveLength(0);
  });
});

// 2026-10-03 页面原型结构对齐。原型是静态图，只用来定结构与层级，不用来抄像素：
// 宽度必须来自 token（rem），所以这里断言的是「相对关系」而不是某个绝对距离。
test.describe("方案 2 页面结构对齐（真实 Chromium）", () => {
  /** 走已验证的文件夹入口：建会话、发消息、进入真实对话区。 */
  async function openSessionWith(page: Page, ctx: Ctx, rounds: number): Promise<void> {
    await openFolder(page, ctx);
    for (let index = 0; index < rounds; index += 1) {
      const composer = index === 0 ? page.locator('[data-testid="assist-first-draft"]')
        : page.locator('[data-testid="assist-draft"]');
      await composer.fill(`第 ${index} 轮提问`);
      await composer.press("Enter");
      await expect(page.locator('[data-testid="assist-copy-a-0"]')).toBeVisible({ timeout: 20_000 });
    }
    await page.locator(".agent-chat-transcript").waitFor({ timeout: 20_000 });
  }



  test("消息列与输入器同宽，且上限由同一个 rem token 决定", async ({ page }) => {
    const ctx: Ctx = { posts: [], loseMessageResponse: 0, receipts: new Map(), sessionCreated: false, messages: [], tasks: [] };
    await openSessionWith(page, ctx, 1);

    const widths = await page.evaluate(() => {
      const read = (selector: string) => {
        const node = document.querySelector(selector);
        return node === null ? null : getComputedStyle(node).maxWidth;
      };
      return { composer: read(".agent-chat-composer"), list: read(".agent-message-list"),
        token: getComputedStyle(document.documentElement).getPropertyValue("--relay-layout-reading-maxWidth").trim() };
    });
    // 上限是 rem，不是抄来的 px。
    expect(widths.token).toMatch(/^\d+(\.\d+)?rem$/u);
    // 同宽：两者必须一致，否则滚动条会贴着其中一侧。
    expect(widths.list).toBe(widths.composer);
  });

  test("工作台页没有面包屑，也没有常驻的委托阻塞原因", async ({ page }) => {
    const ctx: Ctx = { posts: [], loseMessageResponse: 0, receipts: new Map(), sessionCreated: false, messages: [], tasks: [] };
    await installRoutes(page, ctx);
    // 任务上下文才有协作页头；文件夹入口走的是另一套页头。
    await page.goto(`/agent?work=${taskId}`);
    await connect(page);

    await expect(page.locator(".breadcrumbs")).toHaveCount(0);
    await expect(page.locator('[data-testid="collab-delegate-blocked"]')).toHaveCount(0);
    // 项目归属仍在页头那行，不因去掉面包屑而丢失。
    await expect(page.locator('[data-testid="collab-current-need"]')).toContainText("项目：MyProject");
  });

  // 2026-10-04：原「命令回执留在输入器这一列内」用例已删除。
  // 发送路径不再产生任何 notice（「消息已排队」按用户判断去掉），该用例的前置动作
  // 不再能触发提示，保留就只剩空断言。其余 notice（取消、提案回执、原命令回执）
  // 仍渲染在输入器列内，但当前浏览器夹具无法可靠触发，属已知覆盖缺口。

  test("左栏搜索只筛已加载范围：未命中项隐藏、空态说明范围", async ({ page }) => {
    const ctx: Ctx = { posts: [], loseMessageResponse: 0, receipts: new Map(), sessionCreated: false, messages: [], tasks: [] };
    ctx.tasks = [
      { id: "task-a", project_id: projectId, title: "人机协作工作流研究", status: "READY", mode: "ME",
        revision: "1", executor: { kind: "HUMAN", run_id: null }, current_completion_id: null,
        waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [], updated_at: "2026-10-03T00:00:00Z" },
      { id: "task-b", project_id: projectId, title: "资料整理", status: "READY", mode: "ME",
        revision: "1", executor: { kind: "HUMAN", run_id: null }, current_completion_id: null,
        waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [], updated_at: "2026-10-02T00:00:00Z" }
    ];
    await openSessionWith(page, ctx, 1);

    await page.locator('[data-testid="recent-work-search"]').fill("协作");
    await expect(page.locator('[data-testid="recent-work-task-a"]')).toBeVisible();
    await expect(page.locator('[data-testid="recent-work-task-b"]')).toHaveCount(0);
    // 搜索范围不夸大：占位文案就写明「只覆盖已加载」，计数已按需求移除。
    await expect(page.locator('[data-testid="recent-work-search"]')).toHaveAttribute("placeholder", /已加载/);

    await page.locator('[data-testid="recent-work-search"]').fill("不存在的东西");
    await expect(page.locator('[data-testid="recent-work-no-match"]')).toContainText("只覆盖已加载范围");
  });

  test("复制是纯客户端剪贴板动作，不发任何写命令", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const ctx: Ctx = { posts: [], loseMessageResponse: 0, receipts: new Map(), sessionCreated: false, messages: [], tasks: [] };
    await openSessionWith(page, ctx, 1);

    const copy = page.locator('[data-testid="assist-copy-a-0"]');
    await expect(copy).toBeVisible();
    // 只有图标，可读名称与完成状态都在 aria-label 上。
    await expect(copy).toHaveAttribute("aria-label", "复制这条回复");
    expect((await copy.textContent())?.trim()).toBe("");
    const before = ctx.posts.length;
    await copy.click();
    await expect(copy).toHaveAttribute("aria-label", "已复制这条回复");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("第 0 轮回复");
    // 只读动作：点击复制不发任何命令。
    expect(ctx.posts).toHaveLength(before);
  });

  test("输入区不画分隔线、不允许拖拽调高；发送键圆心与卡片圆角圆心重合", async ({ page }) => {
    const ctx: Ctx = { posts: [], loseMessageResponse: 0, receipts: new Map(), sessionCreated: false, messages: [], tasks: [] };
    await openSessionWith(page, ctx, 1);

    const composer = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const rootPx = Number.parseFloat(root.fontSize);
      const rem = (name: string) => Number.parseFloat(root.getPropertyValue(name)) * rootPx;
      // 键与卡片圆角同心，比的是输入器自己的圆角，不是通用控件圆角。
      const radiusPx = rem("--relay-radius-composer");
      const card = document.querySelector(".agent-chat-composer")!;
      const actions = card.querySelector(".agent-chat-composer-actions")!;
      const textarea = card.querySelector("textarea")!;
      const send = card.querySelector(".agent-chat-send")!;
      const cardBox = card.getBoundingClientRect();
      const sendBox = send.getBoundingClientRect();
      return { border: getComputedStyle(actions).borderTopWidth, resize: getComputedStyle(textarea).resize,
        painted: sendBox.width, radiusPx, sendRadius: getComputedStyle(send).borderRadius,
        toolsHeight: card.querySelector(".agent-chat-composer-tools")!.getBoundingClientRect().height,
        toolsCentre: (() => { const b = card.querySelector(".agent-chat-composer-tools")!.getBoundingClientRect(); return b.top + b.height / 2; })(),
        sendCentre: sendBox.top + sendBox.height / 2,
        centreDelta: Math.max(
          Math.abs((sendBox.left + sendBox.width / 2) - (cardBox.right - radiusPx)),
          Math.abs((sendBox.top + sendBox.height / 2) - (cardBox.bottom - radiusPx))),
        target: rem("--relay-control-target-minimum") };
    });
    expect(composer.border).toBe("0px");
    // 拖拽改高度已去掉：高度只随内容增长。
    expect(composer.resize).toBe("none");
    // 边长等于圆角直径，圆心因此落在圆角圆心上（偏差 ≤1px）。
    expect(composer.painted).toBeCloseTo(composer.radiusPx * 2, 1);
    expect(composer.centreDelta).toBeLessThanOrEqual(1);
    // 圆形：直径的一半等于圆角半径时与卡片两边内切。
    expect(Number.parseFloat(composer.sendRadius)).toBeGreaterThanOrEqual(composer.painted / 2 - 1);
    // 键已加大到可直接满足可点击目标下限，不再依赖 ::after 扩展。
    expect(composer.painted).toBeGreaterThanOrEqual(composer.target);
    // 底栏左侧那一行与键同高。
    expect(composer.toolsHeight).toBeCloseTo(composer.painted, 1);
    // 底边对齐：底栏那一行与键的竖直中心必须重合，不能一个高一个低。
    expect(Math.abs(composer.toolsCentre - composer.sendCentre)).toBeLessThanOrEqual(1);
  });

  test("消息行没有左右头像，且发送后不再提示「消息已排队」", async ({ page }) => {
    const ctx: Ctx = { posts: [], loseMessageResponse: 0, receipts: new Map(), sessionCreated: false, messages: [], tasks: [] };
    await openSessionWith(page, ctx, 1);

    // 头像已删除：角色只由「我 / AI」标签与气泡位置区分。
    await expect(page.locator(".agent-message-avatar")).toHaveCount(0);
    await expect(page.locator(".agent-message").first()).toContainText("我");

    // 「消息已排队」只复述已提交的 202 回执，不携带新事实，已去掉。
    await expect(page.locator('[data-testid="assist-receipt-notice"]')).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("回复状态以服务端消息为准");
  });

  test("资料与讨论是胶囊 chip：radius.round + 控件边框，两者之间不再有竖分隔线", async ({ page }) => {
    const ctx: Ctx = { posts: [], loseMessageResponse: 0, receipts: new Map(), sessionCreated: false, messages: [], tasks: [] };
    await openSessionWith(page, ctx, 1);

    for (const selector of [".agent-chat-tool", ".agent-chat-options > summary"]) {
      const chip = await page.locator(selector).evaluate((node) => {
        const style = getComputedStyle(node);
        const box = node.getBoundingClientRect();
        const radius = Number.parseFloat(style.borderTopLeftRadius);
        return { border: style.borderTopWidth, background: style.backgroundColor,
          // 胶囊：圆角不小于半高，整条边都是弧。
          pill: radius >= box.height / 2,
          chevrons: node.querySelectorAll(".agent-chat-chip-chevron").length };
      });
      // 2026-10-10 协作页 §4：chips 统一为 radius.round + border.control + bg.surface。
      expect(chip.border).not.toBe("0px");
      expect(chip.pill).toBe(true);
      expect(chip.background).not.toBe("rgba(0, 0, 0, 0)");
      // chevron 在文字之后的同一行里，不是前缀符号。
      expect(chip.chevrons).toBe(1);
    }
    // 同一排的 chip 不再插竖分隔线：那会把同类控件切成两组。
    const divider = await page.locator(".agent-chat-composer-tools > .agent-chat-options").evaluate(
      (node) => getComputedStyle(node).borderLeftWidth);
    expect(divider).toBe("0px");
  });

  test("回到最新是胶囊悬浮键：有底色、边框与阴影，水平居中", async ({ page }) => {
    const ctx: Ctx = { posts: [], loseMessageResponse: 0, receipts: new Map(), sessionCreated: false, messages: [], tasks: [] };
    await openSessionWith(page, ctx, 8);
    // 滚上去让按钮出现。
    await page.locator(".agent-chat-transcript").evaluate((node) => { node.scrollTop = 0; });
    const latest = page.locator('[data-testid="assist-latest"]');
    await expect(latest).toBeVisible();

    const look = await latest.evaluate((node) => {
      const style = getComputedStyle(node);
      const box = node.getBoundingClientRect();
      const host = node.parentElement!.getBoundingClientRect();
      const radius = Number.parseFloat(style.borderTopLeftRadius);
      return { background: style.backgroundColor, border: style.borderTopWidth, shadow: style.boxShadow,
        pill: radius >= box.height / 2, text: (node.textContent ?? "").trim(),
        centerDelta: Math.abs((box.left + box.width / 2) - (host.left + host.width / 2)),
        aria: node.getAttribute("aria-label") };
    });
    // 没有可见文字，可读名称在 aria-label 上。
    expect(look.text).toBe("");
    expect(look.aria).toBe("回到最新消息");
    // 2026-10-10 协作页 §4：radius.round + border.control + bg.surface + shadow.floating。
    expect(["rgba(0, 0, 0, 0)", "transparent"]).not.toContain(look.background);
    expect(look.border).not.toBe("0px");
    expect(look.shadow).not.toBe("none");
    expect(look.pill).toBe(true);
    // 水平居中：中心与宿主中线的偏差不超过 1px。
    expect(look.centerDelta).toBeLessThanOrEqual(1);
  });

  test("消息列与输入器同宽，且滚动容器铺满中栏（滚动条不压消息列）", async ({ page }) => {
    const ctx: Ctx = { posts: [], loseMessageResponse: 0, receipts: new Map(), sessionCreated: false, messages: [], tasks: [] };
    await openSessionWith(page, ctx, 2);

    const widths = await page.evaluate(() => {
      const node = document.querySelector(".agent-chat-transcript")!;
      const scroller = node.getBoundingClientRect();
      const centre = document.querySelector(".collab-center")!;
      const centreBox = centre.getBoundingClientRect();
      const style = getComputedStyle(centre);
      const padRight = Number.parseFloat(style.paddingRight);
      const list = document.querySelector(".agent-message-list")!.getBoundingClientRect();
      return { scrollerRight: scroller.right, contentRight: centreBox.right - padRight,
        scrollerWidth: scroller.width, contentWidth: centreBox.width - padRight
          - Number.parseFloat(style.paddingLeft),
        listCentre: list.left + list.width / 2,
        // 用 clientWidth：scrollbar-gutter 让内容盒比边框盒窄，居中基准是内容盒。
        contentBoxCentre: scroller.left + node.clientWidth / 2 };
    });
    // 滚动容器铺满中栏的内容盒，滚动条因此贴着中栏右缘而不是消息列旁边。
    expect(widths.scrollerRight).toBeCloseTo(widths.contentRight, 0);
    expect(widths.scrollerWidth).toBeCloseTo(widths.contentWidth, 0);
    // 阅读列在滚动容器的内容盒内居中（扣掉 scrollbar-gutter）。
    expect(Math.abs(widths.listCentre - widths.contentBoxCentre)).toBeLessThanOrEqual(1);
  });

  // 「对话区」指消息流本身。目录范围条是同列上方的上下文入口，
  // 用户主动展开时它自己滚动（max-height:40%），否则 485px 的内容会把
  // 消息区挤到只剩 124px——那正是本轮修的挤压缺陷。
  // 因此这里排除上下文面板，只断言消息流内部没有第二个滚动 Owner。
  test("对话区只有一个纵向滚动容器", async ({ page }) => {
    const ctx: Ctx = { posts: [], loseMessageResponse: 0, receipts: new Map(), sessionCreated: false, messages: [], tasks: [] };
    await openSessionWith(page, ctx, 12);

    const scrollers = await page.evaluate(() => {
      const out: string[] = [];
      for (const node of document.querySelectorAll<HTMLElement>(".collab-center *")) {
        // 目录范围条与近期工作是上下文面板，不是对话区的一部分。
        if (node.closest(".folder-scope-strip") !== null) continue;
        // 时间线导航的轨道与预览浮层是阅读辅助层，不是正文滚动 Owner：轨道
        // `scrollbar-width:none` 不出滚动条，长会话由它自己滚动（工作台 §31.1），
        // 正文唯一的滚动容器仍是下面的消息流。
        if (node.closest(".agent-chat-timeline") !== null) continue;
        const style = getComputedStyle(node);
        if (!/(auto|scroll)/u.test(style.overflowY)) continue;
        if (node.scrollHeight <= node.clientHeight) continue;
        out.push(`${node.tagName.toLowerCase()}.${node.className}`);
      }
      return out;
    });
    // 真的溢出时也只应有一个滚动 Owner；出现第二个就是双滚动条。
    expect(scrollers).toEqual(["div.agent-chat-transcript"]);
  });


  // 缺陷：队列空态用一块 4.5rem 的不可见占位「防跳」，于是每一条会话都在输入器上方
  // 永久留出一条 72px 空白带；同时同列的目录范围条与执行摘要都不肯压缩，
  // 转录区被挤到只剩十几像素——最新回复读不到，看上去就是输入器上方遮住了一块文字。
  test("空队列占位不占高度，消息区不被输入器上方的空白挤掉", async ({ page }) => {
    const ctx: Ctx = { posts: [], loseMessageResponse: 0, receipts: new Map(), sessionCreated: false, messages: [], tasks: [] };
    await openSessionWith(page, ctx, 1);

    const look = await page.evaluate(() => {
      const transcript = document.querySelector<HTMLElement>(".agent-chat-transcript")!;
      const queue = document.querySelector<HTMLElement>('.assist-queue[data-empty="true"]')!;
      const composer = document.querySelector<HTMLElement>(".agent-chat-composer")!;
      const slots = Array.from(document.querySelectorAll<HTMLElement>(".agent-message-slot"));
      const lastBox = slots[slots.length - 1]!.getBoundingClientRect();
      const box = transcript.getBoundingClientRect();
      const visible = Math.min(lastBox.bottom, box.bottom) - Math.max(lastBox.top, box.top);
      const centreHeight = document.querySelector<HTMLElement>(".collab-center")!.getBoundingClientRect().height;
      // 消息区与输入器之间只允许出现真正有内容的区块（执行摘要等）。
      // 出现 height>0 且不可见的元素，就说明那里有一条遮住文字的空白带。
      const blankBand = Array.from(composer.parentElement!.children)
        .filter((node): node is HTMLElement => node instanceof HTMLElement)
        .filter((node) => {
          const r = node.getBoundingClientRect();
          if (r.bottom <= box.top || r.top >= composer.getBoundingClientRect().top) return false;
          return getComputedStyle(node).visibility === "hidden" || r.height === 0;
        })
        .map((node) => `${node.tagName.toLowerCase()}.${node.className}`);
      return { queueHeight: queue.getBoundingClientRect().height,
        transcriptHeight: transcript.clientHeight, contentHeight: transcript.scrollHeight,
        centreHeight: Math.round(centreHeight),
        // 到底：滚动位置已到可滚动范围末端（留 2px 容差）。
        scrolledToLatest: transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop <= 2,
        visibleLastMessage: Math.round(visible), lastMessageHeight: Math.round(lastBox.height),
        blankBand };
    });

    // 空队列占位必须零高度：否则它就是那条永久空白带。
    expect(look.queueHeight).toBe(0);
    // 消息区与输入器之间不得残留任何不可见的占位高度。
    expect(look.blankBand).toEqual([]);
    // 消息区必须真的能读。缺陷状态下实测只有 16px——正好一行文字的高度，
    // 看起来就像输入器上方盖住了一块、什么字都读不到。
    // 720px 高窗口、中栏 672px 的当前布局实测 124px，因此下限取 96px：
    // 它离缺陷态有 6 倍余量，又不与同列区块的正常内容量绑死。
    expect(look.transcriptHeight).toBeGreaterThanOrEqual(96);
    // 消息区必须是同列里拿得到高度的那一项，而不是被其他区块压没。
    expect(look.transcriptHeight / look.centreHeight).toBeGreaterThan(0.15);
    // 最新一条回复必须已经滚到视野内（滚动 Owner 跟随最新），
    // 而不是停在消息中部、让人看不到刚生成的那一段。
    expect(look.visibleLastMessage).toBeGreaterThan(0);
    expect(look.scrolledToLatest).toBe(true);
  });

  test("用户消息的「我 / 时间」贴整行右缘，不挂在气泡内侧", async ({ page }) => {
    const ctx: Ctx = { posts: [], loseMessageResponse: 0, receipts: new Map(), sessionCreated: false, messages: [], tasks: [] };
    await openSessionWith(page, ctx, 2);

    const look = await page.evaluate(() => {
      const slot = Array.from(document.querySelectorAll<HTMLElement>(".agent-message-slot"))
        .find((item) => item.querySelector('.agent-message[data-role="USER"]') !== null)!;
      const message = slot.querySelector<HTMLElement>('.agent-message[data-role="USER"]')!;
      const body = message.querySelector<HTMLElement>(".agent-message-body")!;
      const meta = message.querySelector<HTMLElement>(".agent-message-meta")!;
      const right = (node: HTMLElement) => node.getBoundingClientRect().right;
      const metaBox = meta.getBoundingClientRect();
      const content = message.querySelector<HTMLElement>(".assist-message-content")!;
      const contentBox = content.getBoundingClientRect();
      // 「贴右缘」说的是 meta 里最后一个可见子元素（通常是时间，其次是状态标签），
      // 不是「我」那一个字——夹具消息可能没有 created_at，断言不能绑死在 time 上。
      const last = meta.lastElementChild as HTMLElement | null;
      return { slotRight: right(slot), bodyRight: right(body), metaRight: right(meta),
        lastRight: last === null ? null : right(last),
        lastText: last === null ? null : (last.textContent ?? "").trim(),
        metaHeight: metaBox.height,
        // 正文起点必须落在 meta 盒底之下，否则两者会叠在一起。
        gap: contentBox.top - metaBox.bottom,
        listRight: right(document.querySelector<HTMLElement>(".agent-message-list")!) };
    });
    // meta 右缘必须贴住行右缘：用户消息是 row-reverse 的右对齐气泡，
    // meta 原本落在气泡内侧，窄消息时那几个字会停在离右缘很远的位置。
    expect(Math.abs(look.metaRight - look.slotRight)).toBeLessThanOrEqual(1);
    // meta 里最后一个子元素才是真正贴右缘的那个（「我」在左端，不是它）。
    expect(look.lastRight).not.toBeNull();
    expect(Math.abs(look.lastRight! - look.slotRight)).toBeLessThanOrEqual(1);
    // 行右缘就是消息列右缘（消息列居中于滚动容器）。
    expect(Math.abs(look.slotRight - look.listRight)).toBeLessThanOrEqual(1);
    // meta 与正文不得重叠：meta 若脱离文档流而没在正文上方留出它那一行，
    // 正文会整体上移填补空位，「我 / 时间」就压在第一行正文上。
    expect(look.gap).toBeGreaterThanOrEqual(0);
    // 气泡仍然右对齐（行右缘就是气泡外侧），没有被这次定位改动带偏。
    expect(Math.abs(look.bodyRight - look.slotRight)).toBeLessThanOrEqual(1);
  });

});
