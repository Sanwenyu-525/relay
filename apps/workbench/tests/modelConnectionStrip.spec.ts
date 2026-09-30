import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
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
  it("未配置真实模型时明确说走 Mock、不外发内容", async () => {
    const view = await render(client({ status: { provider: "fake", configured: false,
      model: null, baseUrl: null }, verification: null }));
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
        baseUrl: "https://models.vendor.example/v1" },
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
      model: null, baseUrl: null }, verification: null }));
    await flush();
    expect(view.wrapper.get('[data-testid="collab-model-connection"]').text())
      .toContain("模型端口状态不可读");
    view.unmount();
  });

  it("读取失败如实报错，不静默显示成未配置", async () => {
    const view = await render(client({ status: { provider: "fake", configured: false,
      model: null, baseUrl: null }, verification: null, fail: true }));
    await flush();
    const text = view.wrapper.get('[data-testid="collab-model-connection"]').text();
    expect(text).toContain("模型端口状态读取失败");
    expect(text).not.toContain("走 Mock");
    view.unmount();
  });
});
