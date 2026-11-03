import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";

import { ModelConnectionsCard } from "../src/components/ModelConnectionsCard";
import type { RelayApiClient } from "../src/api/relayClient";
import type { RelayModelConnection } from "../src/api/dtos/information";
import { flush, mountReact } from "./mountApp";

/**
 * 模型连接登记卡片（ADR-036）。
 *
 * 三条必须钉住的界面纪律：
 *   1. 折叠时不发请求——设置页其他卡片不该为一张未展开的表付代价；
 *   2. 作用域写清楚（只影响新 Run），且登记成功不冒充「已验证」；
 *   3. Key 只在密码框里出现一次：提交后 DOM 里不再有它，界面只剩凭据代数。
 */

function connection(overrides: Partial<RelayModelConnection> = {}): RelayModelConnection {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "primary",
    providerKind: "openai-compatible",
    baseUrl: null,
    defaultModel: "synthetic/model-a",
    budget: { timeoutMs: 30000, maxOutputTokens: 8192, maxCallTokens: 65536,
      maxScopeCalls: 32, maxScopeTokens: 262144 },
    credentialVersion: 1,
    status: "ACTIVE",
    revision: "1",
    createdAt: "2026-10-27T00:00:00.000Z",
    updatedAt: "2026-10-27T00:00:00.000Z",
    ...overrides
  };
}

interface StubCalls {
  list: number;
  setDefault: string[];
  chatDefault: (string | null)[];
  verify: { connection: string; connectionId?: string }[];
  update: { id: string; expectedRevision: string; name?: string; baseUrl?: string | null;
    defaultModel?: string }[];
  setStatus: { id: string; status: string }[];
  rotate: { id: string; apiKey: string }[];
  create: { name: string; apiKey: string }[];
}

function stubClient(input: {
  readonly items?: readonly RelayModelConnection[];
  readonly defaultId?: string | null;
  readonly chatDefaultId?: string | null;
  readonly failList?: boolean;
}): { client: RelayApiClient; calls: StubCalls } {
  const calls: StubCalls = { list: 0, setDefault: [], chatDefault: [], verify: [], update: [],
    setStatus: [], rotate: [], create: [] };
  let verificationState: string = "UNVERIFIED";
  let verificationLast: Record<string, unknown> | null = null;
  const client = {
    async listModelConnections() {
      calls.list += 1;
      if (input.failList === true) throw new Error("模型连接读取失败");
      return input.items ?? [];
    },
    async getDefaultModelConnection() {
      return { connectionId: input.defaultId ?? null, revision: "1" };
    },
    async getChatDefaultModelConnection() {
      return { connectionId: input.chatDefaultId ?? null, revision: "1" };
    },
    async setChatDefaultModelConnection(id: string | null) {
      calls.chatDefault.push(id);
      return { connectionId: id, revision: "2" };
    },
    async getModelConnectionCredentialPresence() {
      return true;
    },
    /** 每条连接的目标级验证态；夹具只提供「已配置未验证」，让界面按服务端事实显示。 */
    async getModelPortVerification(target?: { readonly connection?: string;
      readonly connectionId?: string }) {
      const connectionId = target?.connectionId ?? "";
      return { target: `registered:${connectionId}`, connection: "registered", connectionId,
        model: "synthetic/model-a", currentConfigFingerprint: null, last: verificationLast,
        targetLast: verificationLast, matchesCurrentConfig: verificationLast !== null,
        credentialIdentity: "UNKNOWN", state: verificationState,
        workerStartupValidation: "OK" };
    },
    async verifyModelPort(target?: { readonly connection?: string; readonly connectionId?: string }) {
      calls.verify.push({ connection: target?.connection ?? "default",
        connectionId: target?.connectionId });
      verificationState = "VERIFIED";
      verificationLast = { ok: true, latencyMs: 12, provider: "openai-compatible",
        model: "synthetic/model-a", configFingerprint: "f".repeat(64), errorCategory: null,
        verifiedAt: "2026-11-02T00:00:00.000Z" };
      return { ok: true, latencyMs: 12, provider: "openai-compatible",
        model: "synthetic/model-a", configFingerprint: "f".repeat(64),
        errorCategory: null, verifiedAt: "2026-11-02T00:00:00.000Z" };
    },
    async setDefaultModelConnection(id: string) {
      calls.setDefault.push(id);
      return { connectionId: id, revision: "2" };
    },
    async updateModelConnection(id: string, args: { expectedRevision: string;
      name?: string; baseUrl?: string | null; defaultModel?: string }) {
      calls.update.push({ id, expectedRevision: args.expectedRevision,
        name: args.name, baseUrl: args.baseUrl, defaultModel: args.defaultModel });
      return connection({ name: args.name ?? "primary",
        baseUrl: args.baseUrl === undefined ? null : args.baseUrl,
        defaultModel: args.defaultModel ?? "synthetic/model-a", revision: "2" });
    },
    async setModelConnectionStatus(id: string, args: { status: string }) {
      calls.setStatus.push({ id, status: args.status });
      return connection();
    },
    async rotateModelConnectionCredential(id: string, args: { apiKey: string }) {
      calls.rotate.push({ id, apiKey: args.apiKey });
      return connection({ credentialVersion: 2, revision: "2" });
    },
    async createModelConnection(args: { name: string; apiKey: string }) {
      calls.create.push({ name: args.name, apiKey: args.apiKey });
      return connection({ id: "22222222-2222-4222-8222-222222222222", name: args.name });
    }
  } as unknown as RelayApiClient;
  return { client, calls };
}

let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; vi.restoreAllMocks(); });

describe("模型连接登记卡片", () => {
  it("折叠时不发任何请求，只给登记入口", async () => {
    const { client, calls } = stubClient({ items: [connection()] });
    const mounted = await mountReact(createElement(ModelConnectionsCard, { client }));
    unmount = mounted.unmount;
    await flush();
    expect(calls.list).toBe(0);
    const card = mounted.wrapper.get('[data-testid="model-connections"]');
    expect(card.text()).toContain("模型连接");
    expect(card.text()).toContain("凭据存系统凭据库");
    expect(card.text()).not.toContain("验证通过");
    expect(card.find('[data-testid="model-connections-open"]').exists()).toBe(true);
  });

  it("展开后列出连接、默认徽标与凭据代数", async () => {
    const { client } = stubClient({ items: [connection(),
      connection({ id: "33333333-3333-4333-8333-333333333333", name: "备用",
        status: "DISABLED", credentialVersion: 3 })],
    defaultId: "11111111-1111-4111-8111-111111111111" });
    const mounted = await mountReact(createElement(ModelConnectionsCard, { client }));
    unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="model-connections-open"]').trigger("click");
    await flush();

    const primary = mounted.wrapper.get(
      '[data-testid="model-connection-11111111-1111-4111-8111-111111111111"]');
    expect(primary.text()).toContain("primary");
    expect(primary.text()).toContain("synthetic/model-a");
    expect(primary.text()).toContain("内置默认端点");
    expect(primary.text()).toContain("凭据第 1 代");
    expect(primary.text()).toContain("已启用");
    expect(primary.find('[data-testid="model-connection-default-badge"]').exists()).toBe(true);
    // 已经是默认的连接不再提供「设为默认」。
    expect(primary.find('[data-testid="model-connection-default-11111111-1111-4111-8111-111111111111"]')
      .exists()).toBe(false);

    const secondary = mounted.wrapper.get(
      '[data-testid="model-connection-33333333-3333-4333-8333-333333333333"]');
    expect(secondary.text()).toContain("已停用");
    expect(secondary.text()).toContain("凭据第 3 代");
    // 停用的连接不能被设为默认：默认必须是一条能用的连接。
    const setDefault = secondary.get(
      '[data-testid="model-connection-default-33333333-3333-4333-8333-333333333333"]');
    expect(setDefault.attributes("disabled")).toBeDefined();
  });

  it("设为默认后刷新列表并给出确认", async () => {
    const { client, calls } = stubClient({ items: [connection()] });
    const mounted = await mountReact(createElement(ModelConnectionsCard, { client }));
    unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="model-connections-open"]').trigger("click");
    await flush();
    await mounted.wrapper.get(
      '[data-testid="model-connection-default-11111111-1111-4111-8111-111111111111"]')
      .trigger("click");
    await flush();
    expect(calls.setDefault).toEqual(["11111111-1111-4111-8111-111111111111"]);
    expect(calls.list).toBe(2);
    expect(mounted.wrapper.get('[data-testid="model-connections-notice"]').text())
      .toContain("设为 Run 默认连接");
  });

  it("停用连接时说明「已冻结的 Run 会停止」", async () => {
    const { client, calls } = stubClient({ items: [connection()] });
    const mounted = await mountReact(createElement(ModelConnectionsCard, { client }));
    unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="model-connections-open"]').trigger("click");
    await flush();
    await mounted.wrapper.get(
      '[data-testid="model-connection-status-11111111-1111-4111-8111-111111111111"]')
      .trigger("click");
    await flush();
    expect(calls.setStatus).toEqual([
      { id: "11111111-1111-4111-8111-111111111111", status: "DISABLED" }]);
    expect(mounted.wrapper.get('[data-testid="model-connections-notice"]').text())
      .toContain("已冻结在它上面的 Run 会停止");
  });

  it("轮换凭据：Key 提交后不再留在界面上，只留代数", async () => {
    const { client, calls } = stubClient({ items: [connection()] });
    const mounted = await mountReact(createElement(ModelConnectionsCard, { client }));
    unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="model-connections-open"]').trigger("click");
    await flush();
    await mounted.wrapper.get(
      '[data-testid="model-connection-rotate-11111111-1111-4111-8111-111111111111"]')
      .trigger("click");
    await flush();

    const secret = "synthetic-rotated-key-0123456789";
    const input = mounted.wrapper.get('[data-testid="model-connection-rotate-form"] input');
    await input.setValue(secret);
    await mounted.wrapper.get('[data-testid="model-connection-rotate-submit"]').trigger("click");
    await flush();

    expect(calls.rotate).toEqual([
      { id: "11111111-1111-4111-8111-111111111111", apiKey: secret }]);
    // 提交后表单关闭、Key 不在 DOM 里（既不回显也不留在内存输入框里）。
    expect(mounted.wrapper.find('[data-testid="model-connection-rotate-form"]').exists()).toBe(false);
    expect(document.body.textContent ?? "").not.toContain(secret);
    expect(mounted.wrapper.get('[data-testid="model-connections-notice"]').text())
      .toContain("凭据代数 +1");
  });

  it("新增连接：校验必填项，创建时把 Key 交给服务端且不在界面保留", async () => {
    const { client, calls } = stubClient({ items: [] });
    const mounted = await mountReact(createElement(ModelConnectionsCard, { client }));
    unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="model-connections-open"]').trigger("click");
    await flush();
    expect(mounted.wrapper.get('[data-testid="model-connections-empty"]').text())
      .toContain("跟随进程默认");

    await mounted.wrapper.get('[data-testid="model-connection-add"]').trigger("click");
    await flush();
    // 什么都没填就提交：本地拦下，不发请求。
    await mounted.wrapper.get('[data-testid="model-connection-create-submit"]').trigger("click");
    await flush();
    expect(calls.create).toEqual([]);

    const form = mounted.wrapper.get('[data-testid="model-connection-create-form"]');
    await form.get('input[aria-label="连接名称"]').setValue("second");
    await form.get('input[aria-label="确切型号"]').setValue("synthetic/model-b");
    await form.get('input[aria-label="API Key"]').setValue("synthetic-new-key-abcdef");
    await mounted.wrapper.get('[data-testid="model-connection-create-submit"]').trigger("click");
    await flush();
    expect(calls.create).toEqual([{ name: "second", apiKey: "synthetic-new-key-abcdef" }]);
    expect(mounted.wrapper.get('[data-testid="model-connections-notice"]').text())
      .toContain("还不是默认连接");
    expect(document.body.textContent ?? "").not.toContain("synthetic-new-key-abcdef");
  });

  it("换工作区后清空旧连接，不把旧列表与默认标记带进新范围", async () => {
    const first = stubClient({ items: [connection({ name: "旧连接" })] });
    const second = stubClient({ items: [] });
    const mounted = await mountReact(createElement(ModelConnectionsCard, { client: first.client }));
    unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="model-connections-open"]').trigger("click");
    await flush();
    expect(mounted.wrapper.get('[data-testid="model-connections"]').text()).toContain("旧连接");

    await mounted.rerender(createElement(ModelConnectionsCard, { client: second.client }));
    await flush();
    // 已展开状态下换范围：清空旧列表并只重读新范围的一份事实。
    expect(second.calls.list).toBe(1);
    expect(mounted.wrapper.get('[data-testid="model-connections"]').text()).not.toContain("旧连接");
    expect(mounted.wrapper.get('[data-testid="model-connections-empty"]').text())
      .toContain("还没有登记任何连接");
  });

  it("读取失败显示错误但页面不崩，可重试", async () => {
    const { client, calls } = stubClient({ failList: true });
    const mounted = await mountReact(createElement(ModelConnectionsCard, { client }));
    unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="model-connections-open"]').trigger("click");
    await flush();
    // 非 RelayApiError（例如网络层异常）走通用文案：不把内部错误原文抛给用户。
    expect(mounted.wrapper.get('[data-testid="model-connections-error"]').text())
      .toContain("读取模型连接失败");
    const before = calls.list;
    await mounted.wrapper.get('[data-testid="model-connections-error"] button').trigger("click");
    await flush();
    expect(calls.list).toBe(before + 1);
  });

  it("聊天默认可独立设置与取消", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const { client, calls } = stubClient({ items: [connection()], chatDefaultId: id });
    const mounted = await mountReact(createElement(ModelConnectionsCard, { client }));
    unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="model-connections-open"]').trigger("click");
    await flush();
    const row = mounted.wrapper.get(`[data-testid="model-connection-${id}"]`);
    expect(row.find('[data-testid="model-connection-chat-default-badge"]').exists()).toBe(true);
    // 已经是聊天默认：不再提供「设为聊天默认」，只提供取消。
    expect(row.find(`[data-testid="model-connection-chat-default-${id}"]`).exists()).toBe(false);
    await mounted.wrapper.get(`[data-testid="model-connection-chat-default-clear-${id}"]`)
      .trigger("click");
    await flush();
    expect(calls.chatDefault).toEqual([null]);
    expect(mounted.wrapper.get('[data-testid="model-connections-notice"]').text())
      .toContain("已取消工作区聊天默认");
  });

  it("按稳定连接 id 独立验证，结论来自重读到的目标级状态", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const { client, calls } = stubClient({ items: [connection()] });
    const mounted = await mountReact(createElement(ModelConnectionsCard, { client }));
    unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="model-connections-open"]').trigger("click");
    await flush();
    const row = mounted.wrapper.get(`[data-testid="model-connection-${id}"]`);
    // 初始验证态来自服务端；不是把「登记成功」当成「验证通过」。
    expect(row.get(`[data-testid="model-connection-verification-${id}"]`).text())
      .toBe("已配置未验证");
    await mounted.wrapper.get(`[data-testid="model-connection-verify-${id}"]`).trigger("click");
    await flush();
    expect(calls.verify).toEqual([{ connection: "registered", connectionId: id }]);
    expect(mounted.wrapper.get(`[data-testid="model-connection-verification-${id}"]`).text())
      .toBe("验证通过");
    expect(mounted.wrapper.get('[data-testid="model-connections-notice"]').text())
      .toContain("验证通过");
  });

  it("编辑连接走 revision CAS，保留凭据并声明旧验证失效", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const { client, calls } = stubClient({ items: [connection()] });
    const mounted = await mountReact(createElement(ModelConnectionsCard, { client }));
    unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="model-connections-open"]').trigger("click");
    await flush();
    await mounted.wrapper.get(`[data-testid="model-connection-edit-${id}"]`).trigger("click");
    await flush();
    const form = mounted.wrapper.get('[data-testid="model-connection-edit-form"]');
    // 编辑不碰凭据：表单里没有 API Key 输入框。
    expect(form.findAll('input[type="password"]')).toHaveLength(0);
    await form.get('input[aria-label="连接名称"]').setValue("primary-renamed");
    await mounted.wrapper.get('[data-testid="model-connection-edit-submit"]').trigger("click");
    await flush();
    expect(calls.update).toEqual([{ id, expectedRevision: "1", name: "primary-renamed",
      baseUrl: null, defaultModel: "synthetic/model-a" }]);
    expect(mounted.wrapper.get('[data-testid="model-connections-notice"]').text())
      .toContain("旧验证结果失效");
  });

  it("新增连接预设只填端点，确切型号仍由用户确认", async () => {
    const { client } = stubClient({ items: [] });
    const mounted = await mountReact(createElement(ModelConnectionsCard, { client }));
    unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="model-connections-open"]').trigger("click");
    await flush();
    await mounted.wrapper.get('[data-testid="model-connection-add"]').trigger("click");
    await flush();
    const form = mounted.wrapper.get('[data-testid="model-connection-create-form"]');
    await form.get('select[aria-label="服务预设"]').setValue("openrouter");
    expect((form.get('input[aria-label="服务端点"]').element as HTMLInputElement).value)
      .toBe("https://openrouter.ai/api/v1");
    // 预设不代填型号：用户必须自己确认确切型号。
    expect((form.get('input[aria-label="确切型号"]').element as HTMLInputElement).value).toBe("");
  });

  it("星火预设预填 MaaS 端点，但不写死型号", async () => {
    const { client } = stubClient({ items: [] });
    const mounted = await mountReact(createElement(ModelConnectionsCard, { client }));
    unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="model-connections-open"]').trigger("click");
    await flush();
    await mounted.wrapper.get('[data-testid="model-connection-add"]').trigger("click");
    await flush();
    const form = mounted.wrapper.get('[data-testid="model-connection-create-form"]');
    const preset = form.get('select[aria-label="服务预设"]');
    expect(preset.findAll("option").map((option) => option.text()))
      .toContain("讯飞星火（MaaS）");
    await preset.setValue("spark");
    expect((form.get('input[aria-label="服务端点"]').element as HTMLInputElement).value)
      .toBe("https://maas-api.cn-huabei-1.xf-yun.com/v2");
    // 星火不是枚举，也不是写死清单：型号仍由用户按账号订阅填写。
    expect((form.get('input[aria-label="确切型号"]').element as HTMLInputElement).value).toBe("");
    expect((form.get('input[aria-label="确切型号"]').attributes("placeholder")) ?? "")
      .toContain("spark-x2.6");
  });
});
