import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import ModelConnectionStrip from "../src/components/ModelConnectionStrip";
import type { RelayApiClient, RelayModelPortStatus, RelayModelVerificationState } from "../src/api/relayClient";
import { flush, mountReact } from "./mountApp";

function client(input: {
  readonly status: RelayModelPortStatus;
  readonly verification: RelayModelVerificationState | null;
  readonly fail?: boolean;
}): RelayApiClient {
  return {
    getModelPortStatus: async () => {
      if (input.fail === true) throw new Error("model port unreachable");
      return input.status;
    },
    getModelPortVerification: async () => {
      if (input.fail === true) throw new Error("model port unreachable");
      return input.verification;
    }
  } as unknown as RelayApiClient;
}

async function render(api: RelayApiClient) {
  return mountReact(createElement(MemoryRouter, null,
    createElement(ModelConnectionStrip, { client: api })));
}

afterEach(() => { vi.restoreAllMocks(); });

describe("模型连接只读条", () => {
  it("紧凑摘要原生开合并跳转设置，只读状态不触发连接验证或业务命令", async () => {
    const getStatus = vi.fn().mockResolvedValue({ provider: "openai-compatible", configured: true,
      model: "fixture-model", baseUrl: "https://models.vendor.example/v1" });
    const getVerification = vi.fn().mockResolvedValue(null);
    const writes = vi.fn();
    const api = { getModelPortStatus: getStatus, getModelPortVerification: getVerification,
      verifyModelPort: writes, createAssistSession: writes, requestRunControl: writes } as unknown as RelayApiClient;
    function RouteLocation() {
      return createElement("p", { "data-testid": "route-location" }, useLocation().pathname);
    }
    const view = await mountReact(createElement(MemoryRouter, { initialEntries: ["/agent"] },
      createElement(ModelConnectionStrip, { client: api, compact: true }), createElement(RouteLocation)));
    try {
      await flush();
      const details = view.wrapper.get("details").element as HTMLDetailsElement;
      const summary = view.wrapper.get("details > summary");
      expect(summary.text()).toBe("已配置，尚未验证连接");
      expect(details.open).toBe(false);
      await summary.trigger("click");
      expect(details.open).toBe(true);
      expect(view.wrapper.get("details > p").text()).toContain("fixture-model");
      await summary.trigger("click");
      expect(details.open).toBe(false);
      await summary.trigger("click");
      await view.wrapper.get('details a[href="/settings"]').trigger("click");
      expect(view.wrapper.get('[data-testid="route-location"]').text()).toBe("/settings");
      expect(getStatus).toHaveBeenCalledTimes(1);
      expect(getVerification).toHaveBeenCalledTimes(1);
      expect(writes).not.toHaveBeenCalled();
    } finally {
      view.unmount();
    }
  });

  it("未配置真实模型时明确说走 Mock、不外发内容", async () => {
    const view = await render(client({ status: { provider: "fake", configured: false,
      model: null, baseUrl: null, maxCallTokens: null }, verification: null }));
    await flush();
    const text = view.wrapper.get('[data-testid="collab-model-connection"]').text();
    expect(text).toContain("未配置真实模型");
    expect(text).toContain("走 Mock，不会外发任何内容");
    expect(text).toContain("模型连接设置");
    view.unmount();
  });

  it("验证通过也要说明不等于真实任务执行成功", async () => {
    const view = await render(client({
      status: { provider: "openai-compatible", configured: true, model: "fixture-model",
        baseUrl: "https://models.vendor.example/v1", maxCallTokens: null },
      verification: { currentConfigFingerprint: "fp-1", last: { ok: true, latencyMs: 700,
        provider: "openai-compatible", model: "fixture-model", configFingerprint: "fp-1",
        errorCategory: null, verifiedAt: "2026-09-29T05:00:00Z" },
        matchesCurrentConfig: true, workerStartupValidation: "OK" }
    }));
    await flush();
    const text = view.wrapper.get('[data-testid="collab-model-connection"]').text();
    expect(text).toContain("连接已验证");
    expect(text).toContain("fixture-model");
    expect(text).toContain("不等于真实任务执行成功");
    view.unmount();
  });

  it("配置残缺按不可读处理，不显示成已配置", async () => {
    const view = await render(client({ status: { provider: "invalid", configured: false,
      model: null, baseUrl: null, maxCallTokens: null }, verification: null }));
    await flush();
    expect(view.wrapper.get('[data-testid="collab-model-connection"]').text())
      .toContain("模型端口状态不可读");
    view.unmount();
  });

  it("读取失败如实报错，不静默显示成未配置", async () => {
    const view = await render(client({ status: { provider: "fake", configured: false,
      model: null, baseUrl: null, maxCallTokens: null }, verification: null, fail: true }));
    await flush();
    const text = view.wrapper.get('[data-testid="collab-model-connection"]').text();
    expect(text).toContain("模型端口状态读取失败");
    expect(text).not.toContain("走 Mock");
    view.unmount();
  });
});
