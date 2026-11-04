import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { clickPortal, dialogText, flush, mountWorkbench, openUnresolvedDialog, pressEscape } from "./mountApp";

/**
 * 模型切换命令的类型映射与回执恢复（MODEL-SWITCH-RECEIPT-RECOVERY）。
 *
 * 覆盖任务书的 P0 矩阵：默认↔星火连接两个方向的成功、在途不冒充未决、明确拒绝解除保护、
 * 传输/5xx 保留原 command_id、按原 ID 查回执与同 ID 重试、回执不匹配不清 pending、
 * 无任务的普通会话也写 SESSION 恢复记录、离开/重挂载后不重复发送、多条未决互不误伤。
 *
 * 全部使用确定性 fetch 桩；不触碰真实 Provider，也不把编译通过当成行为证据。
 */

const workspaceId = "11111111-1111-4111-8111-111111111111";
const sessionId = "33333333-3333-4333-8333-333333333333";
const otherSessionId = "55555555-5555-4555-8555-555555555555";
const connectionId = "44444444-4444-4444-8444-444444444444";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const recoveryKey = `relay-agent-chat-pending:http://127.0.0.1:8787:${workspaceId}`;
const sparkModel = "spark-x2.6";
const defaultModel = "gpt-4.1-mini";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function session(id = sessionId) {
  return { id, workspace_id: workspaceId, project_id: null, task_id: null,
    title: "普通讨论", status: "ACTIVE", revision: "1",
    created_at: "2026-09-26T00:00:00Z", updated_at: "2026-09-26T00:00:00Z" };
}

function connection() {
  return { id: connectionId, name: "讯飞星火", provider_kind: "openai-compatible",
    base_url: "https://maas-api.cn-huabei-1.xf-yun.com/v2", default_model: sparkModel,
    budget: { timeout_ms: 120_000, max_output_tokens: 4096, max_call_tokens: 65536,
      max_scope_calls: 30, max_scope_tokens: 512_000 },
    credential_version: 1, status: "ACTIVE", revision: "1",
    created_at: "2026-11-02T00:00:00Z", updated_at: "2026-11-02T00:00:00Z" };
}

type PostMode = "success" | "network" | "server" | "reject" | "pending";
type ReceiptMode = "success" | "missing" | "mismatch";

interface Harness {
  selection: "default" | "spark";
  postMode: PostMode;
  receiptMode: ReceiptMode;
  posts: { readonly path: string; readonly body: Record<string, unknown> }[];
  receipts: string[];
  /** 模拟服务端已落库：POST 响应丢了，但会话实际已切到星火。 */
  commitDespiteFailure: boolean;
}

function selectionProjection(harness: Harness): unknown {
  if (harness.selection === "default") return { selection: null };
  return { selection: { kind: "MODEL_SELECTION", session_id: sessionId, connection: "registered",
    connection_id: connectionId, model: sparkModel, free_only: false, revision: "1" } };
}

function modelSelectionResult(connectionChoice: string, model: string): unknown {
  return { kind: "MODEL_SELECTION", session_id: sessionId, connection: "registered",
    connection_id: connectionChoice, model, free_only: false, revision: "1" };
}

function commandReceipt(harness: Harness, commandId: string): Response {
  if (harness.receiptMode === "missing") {
    return response({ code: "COMMAND_NOT_FOUND", detail: "还没有这条命令的回执" }, 404);
  }
  if (harness.receiptMode === "mismatch") {
    return response({ command_id: commandId, command_type: "AcceptAssistProposal",
      committed_at: "2026-11-02T00:00:00Z",
      result: { session_id: sessionId, connection: "registered", connection_id: connectionId,
        model: sparkModel, free_only: false, revision: "1" } });
  }
  return response({ command_id: commandId, command_type: "SelectSessionConnection",
    committed_at: "2026-11-02T00:00:00Z", result: modelSelectionResult(connectionId, sparkModel) });
}

function stubFetch(harness: Harness) {
  return vi.fn(async (input: string, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? "GET";
    if (path === `${prefix}/assistant-profiles`) return response({ items: [] });
    if (path === `${prefix}/skill-definitions`) return response({ items: [] });
    if (path === `${prefix}/model-port`) return response({ provider: "fake", configured: true,
      model: defaultModel, base_url: null, max_call_tokens: 65536 });
    if (path === `${prefix}/model-port/verification`) return response({ current_config_fingerprint: null,
      last: null, matches_current_config: false, worker_startup_validation: "NOT_CONFIGURED" });
    if (path === `${prefix}/model-catalog`) return response({ configured: true, chat_configured: true,
      last_success_at: null, last_failure_reason: null, cache_stale: false, snapshot_seq: "0",
      free_count: 0, entries: [] });
    if (path === `${prefix}/model-connections`) return response({ items: [connection()] });
    if (path === `${prefix}/default-working-directory`) return response({ resource_id: null,
      canonical_root: null, display_name: null, write_tier: null, default_write_tier: null,
      status: "UNSET", reason: null, revision: "0" });
    if (path === `${prefix}/assist-sessions`) return response({ items: [session(), session(otherSessionId)] });
    if (path === `${prefix}/assist-sessions/${sessionId}`) return response(session());
    if (path === `${prefix}/assist-sessions/${otherSessionId}`) return response(session(otherSessionId));
    if (path === `${prefix}/assist-sessions/${sessionId}/model-selection` && method === "GET")
      return response(selectionProjection(harness));
    if (path === `${prefix}/assist-sessions/${sessionId}/model-selection` && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      harness.posts.push({ path, body });
      if (harness.postMode === "pending") return await new Promise<Response>(() => { /* 一直不落回执 */ });
      if (harness.postMode === "network") {
        if (harness.commitDespiteFailure) harness.selection = "spark";
        throw new TypeError("response lost");
      }
      if (harness.postMode === "server") return response({ code: "TEMPORARY_FAILURE",
        detail: "服务端暂时不可用。", retryable: true,
        retry_action: "CHECK_RECEIPT_THEN_RETRY" }, 500);
      if (harness.postMode === "reject") return response({ code: "CONNECTION_NOT_FOUND",
        detail: "已登记连接不存在。", retryable: false, retry_action: "NONE" }, 422);
      harness.selection = "spark";
      return response({ command_id: body.command_id, committed_at: "2026-11-02T00:00:00Z",
        result: modelSelectionResult(String(body.connection_id), sparkModel) });
    }
    if (path === `${prefix}/assist-sessions/${sessionId}/chat-commands` && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      harness.posts.push({ path, body });
      if (harness.postMode === "network") throw new TypeError("response lost");
      if (harness.postMode === "server") return response({ code: "TEMPORARY_FAILURE",
        detail: "服务端暂时不可用。", retryable: true,
        retry_action: "CHECK_RECEIPT_THEN_RETRY" }, 500);
      harness.selection = "default";
      return response({ command_id: body.command_id, committed_at: "2026-11-02T00:00:00Z",
        result: { kind: "MODEL_SELECTION", session_id: sessionId, connection: "default",
          connection_id: null, model: defaultModel, free_only: false, revision: "1" } });
    }
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return response({ items: [] });
    if (path === `${prefix}/assist-sessions/${sessionId}/context-usage`) return response({
      session_id: sessionId, budget: { tokens: 262_144, revision: "0" }, last_call: null });
    if (path === `${prefix}/assist-sessions/${sessionId}/goal`) return response({ goal: null });
    if (path === `${prefix}/assist-sessions/${sessionId}/plans`) return response({ items: [] });
    if (path === `${prefix}/assist-proposals`) return response({ items: [] });
    if (path === `${prefix}/conversation-state-requests`) return response({ items: [] });
    if (path.startsWith(`${prefix}/conversation-execution-requests`)) return response({ items: [] });
    if (path.startsWith(`${prefix}/search`)) return response({ items: [], next_cursor: null });
    const receipt = /\/commands\/([^/]+)$/u.exec(path);
    if (receipt !== null) {
      harness.receipts.push(receipt[1]!);
      return commandReceipt(harness, receipt[1]!);
    }
    throw new Error(`unexpected request ${method} ${path}`);
  });
}

function harness(over: Partial<Harness> = {}): Harness {
  return { selection: "default", postMode: "success", receiptMode: "success",
    posts: [], receipts: [], commitDespiteFailure: false, ...over };
}

function storedRecoveries(): Record<string, unknown>[] {
  const raw = window.sessionStorage.getItem(recoveryKey);
  return raw === null ? [] : JSON.parse(raw) as Record<string, unknown>[];
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  document.documentElement.dataset.motion = "on";
});
afterEach(() => { resetRelayConnectionForTest(); vi.unstubAllGlobals(); window.localStorage.clear(); window.sessionStorage.clear(); });

async function mount(harnessValue: Harness) {
  vi.stubGlobal("fetch", stubFetch(harnessValue));
  activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
  const view = await mountWorkbench(`/agent?session=${sessionId}`);
  await flush(120);
  return view;
}

async function chooseSpark(view: Awaited<ReturnType<typeof mount>>): Promise<void> {
  await view.wrapper.get('[data-testid="model-selector-open"]').trigger("click");
  await flush(120);
  const option = document.querySelector<HTMLButtonElement>(
    `[data-testid="model-selector-option-${connectionId}"]`);
  if (option === null) throw new Error("已登记连接条目没有渲染");
  await option.click();
  await flush(120);
}

describe("模型切换命令与回执恢复", () => {
  it("默认 → 星火连接：提交 connection_id，成功后芯片就是服务端回执的型号", async () => {
    const h = harness();
    const view = await mount(h);
    try {
      await chooseSpark(view);
      expect(h.posts).toHaveLength(1);
      expect(h.posts[0]!.path).toBe(`${prefix}/assist-sessions/${sessionId}/model-selection`);
      expect(h.posts[0]!.body).toMatchObject({ connection_id: connectionId });
      expect(h.posts[0]!.body).not.toHaveProperty("model");
      expect(view.wrapper.get('[data-testid="model-selector-open"]').text()).toContain(sparkModel);
      expect(document.body.textContent).toContain("已登记连接「讯飞星火」");
      // 成功即在服务端确认，本地不残留未决、也不写恢复区。
      expect(view.wrapper.find('[data-testid="assist-pending"]').exists()).toBe(false);
      expect(storedRecoveries()).toEqual([]);
      // 成功后导航不设阻：保护只属于未决命令。
      await view.router.attempt("/settings");
      expect(view.router.currentRoute.value.path).toBe("/settings");
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    } finally { view.unmount(); }
  });

  it("星火 → 默认模型：已登记连接切换回型号选择仍走原 /model 命令", async () => {
    const h = harness({ selection: "spark" });
    const view = await mount(h);
    try {
      await view.wrapper.get('[data-testid="model-selector-open"]').trigger("click");
      await flush(120);
      const option = document.querySelector<HTMLButtonElement>(
        `[data-testid="model-selector-option-${defaultModel}"]`);
      if (option === null) throw new Error("应用默认型号条目没有渲染");
      await option.click();
      await flush(120);
      expect(h.posts).toHaveLength(1);
      expect(h.posts[0]!.path).toBe(`${prefix}/assist-sessions/${sessionId}/chat-commands`);
      expect(h.posts[0]!.body.text).toBe(`/model ${defaultModel}`);
      expect(view.wrapper.get('[data-testid="model-selector-open"]').text()).toContain(defaultModel);
      expect(document.body.textContent).toContain(`后续新消息首选 ${defaultModel}`);
      expect(view.wrapper.find('[data-testid="assist-pending"]').exists()).toBe(false);
    } finally { view.unmount(); }
  });

  it("命令在途：标题是「命令正在提交」，不冒充待核对、也不提供安全离开", async () => {
    const h = harness({ postMode: "pending" });
    const view = await mount(h);
    try {
      await chooseSpark(view);
      // 在途只换触发器指示，不弹全屏阻断。
      const trigger = view.wrapper.get('[data-testid="model-selector-open"]');
      expect(trigger.attributes("aria-busy")).toBe("true");
      expect(trigger.attributes("aria-label")).toBe("模型切换中");
      expect(view.wrapper.find('.model-selector-switch-dot').exists()).toBe(true);
      expect(view.wrapper.find('[data-testid="assist-pending"]').exists()).toBe(false);
      expect(storedRecoveries()).toEqual([]);

      await view.router.attempt("/settings");
      expect(view.router.currentRoute.value.path).toBe("/agent");
      const text = dialogText();
      expect(text).toContain("命令正在提交");
      expect(text).not.toContain("命令结果待核对");
      expect(document.querySelector('[data-testid="pending-keep-and-leave"]')).toBeNull();
      expect(document.querySelector('.collab-recovery')).toBeNull();
      await clickPortal("keep-editing"); await flush();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(view.router.currentRoute.value.path).toBe("/agent");
    } finally { view.unmount(); }
  });

  it("4xx 明确拒绝：清空未决、给出具体原因与重选入口，导航恢复自由", async () => {
    const h = harness({ postMode: "reject" });
    const view = await mount(h);
    try {
      await chooseSpark(view);
      expect(view.wrapper.find('[data-testid="assist-pending"]').exists()).toBe(false);
      expect(storedRecoveries()).toEqual([]);
      const notice = document.querySelector('[data-testid="assist-action-error"]');
      expect(notice?.textContent).toContain("已登记连接不存在。");
      expect(notice?.textContent).toContain("重新选择");
      await view.router.attempt("/settings");
      expect(view.router.currentRoute.value.path).toBe("/settings");
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    } finally { view.unmount(); }
  });

  it("5xx/网络中断：保留原 command_id，普通无任务会话写入 SESSION 恢复记录并允许安全离开", async () => {
    const h = harness({ postMode: "network", commitDespiteFailure: true });
    const view = await mount(h);
    try {
      await chooseSpark(view);
      const commandId = String(h.posts[0]!.body.command_id);
      expect(view.wrapper.find('[data-testid="assist-pending"]').exists()).toBe(true);
      expect(view.wrapper.get('[data-testid="assist-pending"]').text()).toContain("模型切换结果未确认");
      const records = storedRecoveries();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ commandId, commandType: "SelectSessionConnection",
        sessionId, targetKind: "SESSION", targetId: sessionId });

      await view.router.attempt("/settings");
      expect(view.router.currentRoute.value.path).toBe("/agent");
      const text = dialogText();
      expect(text).toContain("命令结果待核对");
      expect(text).toContain(commandId);
      const leave = document.querySelector('[data-testid="pending-keep-and-leave"]');
      expect(leave).not.toBeNull();
      await clickPortal("pending-keep-and-leave"); await flush();
      expect(view.router.currentRoute.value.path).toBe("/settings");
      expect(storedRecoveries()[0]).toMatchObject({ commandId });

      // 重新进入原会话：未决身份还在，芯片由服务端读回的真实选择恢复，期间不再发命令。
      await view.router.push(`/agent?session=${sessionId}`); await flush(120);
      expect(view.wrapper.find(`[data-testid="collab-recovery-${commandId}"]`).exists()).toBe(true);
      expect(view.wrapper.get('[data-testid="model-selector-open"]').text()).toContain(sparkModel);
      expect(h.posts).toHaveLength(1);
    } finally { view.unmount(); }
  });

  it("查询回执成功：按原 ID 核对，更新实际模型并清理恢复记录与阻断", async () => {
    const h = harness({ postMode: "network", commitDespiteFailure: true });
    const view = await mount(h);
    try {
      await chooseSpark(view);
      const commandId = String(h.posts[0]!.body.command_id);
      expect(view.wrapper.get('[data-testid="model-selector-open"]').text()).not.toContain(sparkModel);
      await openUnresolvedDialog("assist-pending");
      expect(dialogText()).toContain("模型切换结果未确认");
      expect(dialogText()).toContain("不代表已有回复失败");
      await clickPortal("assist-pending-receipt"); await flush(120);
      expect(h.receipts).toEqual([commandId]);
      expect(view.wrapper.get('[data-testid="model-selector-open"]').text()).toContain(sparkModel);
      expect(view.wrapper.find('[data-testid="assist-pending"]').exists()).toBe(false);
      expect(storedRecoveries()).toEqual([]);
      expect(document.body.textContent).toContain("原命令回执已核对");
    } finally { view.unmount(); }
  });

  it("回执不存在：只能同 command_id 同载荷重试，绝不换新 ID", async () => {
    const h = harness({ postMode: "network", receiptMode: "missing" });
    const view = await mount(h);
    try {
      await chooseSpark(view);
      const commandId = String(h.posts[0]!.body.command_id);
      await openUnresolvedDialog("assist-pending");
      await clickPortal("assist-pending-receipt"); await flush(80);
      expect(h.receipts).toEqual([commandId]);
      expect(view.wrapper.find('[data-testid="assist-pending"]').exists()).toBe(true);

      h.postMode = "success";
      await clickPortal("assist-pending-retry"); await flush(120);
      expect(h.posts).toHaveLength(2);
      expect(h.posts[1]!.body).toEqual(h.posts[0]!.body);
      expect(h.posts[1]!.body.command_id).toBe(commandId);
      expect(view.wrapper.find('[data-testid="assist-pending"]').exists()).toBe(false);
      expect(view.wrapper.get('[data-testid="model-selector-open"]').text()).toContain(sparkModel);
      expect(h.posts[0]!.body).not.toHaveProperty("model");
    } finally { view.unmount(); }
  });

  it("回执不匹配：不清 pending，也不把别的命令当成这次成功", async () => {
    const h = harness({ postMode: "network", receiptMode: "mismatch" });
    const view = await mount(h);
    try {
      await chooseSpark(view);
      const commandId = String(h.posts[0]!.body.command_id);
      await openUnresolvedDialog("assist-pending");
      await clickPortal("assist-pending-receipt"); await flush(80);
      expect(view.wrapper.find('[data-testid="assist-pending"]').exists()).toBe(true);
      expect(document.body.textContent).toContain("回执与本次 Assist 命令不匹配。");
      expect(view.wrapper.get('[data-testid="model-selector-open"]').text()).not.toContain(sparkModel);
      expect(storedRecoveries()[0]).toMatchObject({ commandId });
    } finally { view.unmount(); }
  });

  it("核对弹窗的键盘与焦点：焦点进入弹层，Escape 关闭但不清除未决事实", async () => {
    const h = harness({ postMode: "network" });
    const view = await mount(h);
    try {
      await chooseSpark(view);
      const commandId = String(h.posts[0]!.body.command_id);
      await openUnresolvedDialog("assist-pending");
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
      expect(dialog).not.toBeNull();
      expect(dialog!.contains(document.activeElement)).toBe(true);
      pressEscape();
      await flush(80);
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(view.wrapper.find('[data-testid="assist-pending"]').exists()).toBe(true);
      expect(storedRecoveries()[0]).toMatchObject({ commandId });
      // 关闭弹窗不等于取消命令：芯片仍可再次打开核对。
      await openUnresolvedDialog("assist-pending");
      expect(dialogText()).toContain("模型切换结果未确认");
      expect(dialogText()).toContain(commandId);
    } finally { view.unmount(); }
  });

  it("多条未决并存：核对一条只清它自己的恢复记录", async () => {
    const firstCommandId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const secondCommandId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    window.sessionStorage.setItem(recoveryKey, JSON.stringify([
      { commandId: firstCommandId, commandType: "SelectSessionConnection", sessionId,
        targetKind: "SESSION", targetId: sessionId },
      { commandId: secondCommandId, commandType: "SelectSessionConnection", sessionId: otherSessionId,
        targetKind: "SESSION", targetId: otherSessionId },
    ]));
    const h = harness({ selection: "spark" });
    const view = await mount(h);
    try {
      expect(view.wrapper.find(`[data-testid="collab-recovery-${firstCommandId}"]`).exists()).toBe(true);
      expect(view.wrapper.find(`[data-testid="collab-recovery-${secondCommandId}"]`).exists()).toBe(true);
      await view.wrapper.get(`[data-testid="collab-recovery-${firstCommandId}"]`).trigger("click");
      await flush(120);
      expect(h.receipts).toEqual([firstCommandId]);
      const records = storedRecoveries();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ commandId: secondCommandId });
      expect(view.wrapper.find(`[data-testid="collab-recovery-${secondCommandId}"]`).exists()).toBe(true);
    } finally { view.unmount(); }
  });
});
