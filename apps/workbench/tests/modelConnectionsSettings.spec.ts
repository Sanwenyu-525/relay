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
  setStatus: { id: string; status: string }[];
  rotate: { id: string; apiKey: string }[];
  create: { name: string; apiKey: string }[];
}

function stubClient(input: {
  readonly items?: readonly RelayModelConnection[];
  readonly defaultId?: string | null;
  readonly failList?: boolean;
}): { client: RelayApiClient; calls: StubCalls } {
  const calls: StubCalls = { list: 0, setDefault: [], setStatus: [], rotate: [], create: [] };
  const client = {
    async listModelConnections() {
      calls.list += 1;
      if (input.failList === true) throw new Error("模型连接读取失败");
      return input.items ?? [];
    },
    async getDefaultModelConnection() {
      return { connectionId: input.defaultId ?? null, revision: "1" };
    },
    async setDefaultModelConnection(id: string) {
      calls.setDefault.push(id);
      return { connectionId: id, revision: "2" };
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
  it("折叠时不发任何请求，并写明作用域是「新的任务执行」", async () => {
    const { client, calls } = stubClient({ items: [connection()] });
    const mounted = await mountReact(createElement(ModelConnectionsCard, { client }));
    unmount = mounted.unmount;
    await flush();
    expect(calls.list).toBe(0);
    const card = mounted.wrapper.get('[data-testid="model-connections"]');
    expect(card.text()).toContain("默认连接只影响");
    expect(card.text()).toContain("会话聊天仍按会话选择或进程默认");
    expect(card.text()).not.toContain("验证通过");
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

  it("设为默认后刷新列表并给出「已创建的 Run 不受影响」的说明", async () => {
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
    expect(mounted.wrapper.get('[data-testid="model-connections-notice"]').text())
      .toContain("已创建的 Run 不受影响");
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
      .toContain("进程默认模型");

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
});
