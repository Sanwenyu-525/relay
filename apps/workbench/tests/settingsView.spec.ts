import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { resolveVerificationState, type ModelVerificationStateKind }
  from "../src/views/SettingsView";
import { DomWrapper, flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
let unmount: (() => void) | null = null;

afterEach(() => { unmount?.(); unmount = null; resetRelayConnectionForTest(); vi.unstubAllGlobals(); });
function connect() { activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" }); }
function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const fingerprint = "a".repeat(64);
function verificationBody(overrides: Record<string, unknown> = {}) {
  return {
    current_config_fingerprint: fingerprint,
    last: null,
    matches_current_config: false,
    worker_startup_validation: "OK",
    ...overrides
  };
}
function lastBody(overrides: Record<string, unknown> = {}) {
  return {
    ok: true, latency_ms: 42, provider: "openai-compatible", model: "gpt-test",
    config_fingerprint: fingerprint, error_category: null,
    verified_at: "2026-09-28T10:00:00.000Z", ...overrides
  };
}

describe("设置页模型端口状态", () => {
  it("fixture 模式明确无真实服务实例状态，不发起请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench("/settings"); unmount = mounted.unmount;
    expect(mounted.wrapper.text()).toContain("没有真实服务实例状态");
    expect(mounted.wrapper.text()).toContain("偏好与暂不可用项");
    expect(mounted.wrapper.text()).toContain("暂不可用");
    expect(mounted.wrapper.text()).toContain("深色主题");
    expect(mounted.wrapper.text()).toContain("不改变 Later 的存储语义");
    expect(mounted.wrapper.findAll("button").some((button) => /深色|主题切换|切换主题/.test(button.text()))).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("live 显示 Mock 端口：验证态为「未配置」，不写死尚未验证", async () => {
    connect();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/attention/interventions")) return response({ items: [] });
      if (url === `${root}/model-port`) return response({ provider: "fake", configured: false, model: null, base_url: null });
      if (url === `${root}/model-port/verification`) return response(verificationBody({
        current_config_fingerprint: null, worker_startup_validation: "NOT_CONFIGURED" }));
      throw new Error(`Unexpected ${url}`);
    }));
    const mounted = await mountWorkbench("/settings"); unmount = mounted.unmount;
    const panel = mounted.wrapper.get('[data-testid="model-port-status"]');
    expect(panel.text()).toContain("Mock 模型端口");
    expect(panel.text()).toContain("不读取、不显示、也不修改任何密钥");
    const states = mounted.wrapper.get('[data-testid="service-state"]');
    expect(states.text()).toContain("本机服务已连接");
    expect(states.text()).toContain("模型已配置");
    expect(states.text()).toContain("模型验证成功");
    expect(states.text()).toContain("Worker 可执行");
    expect(states.text()).toContain("未配置");
    expect(states.text()).not.toContain("尚未验证");
    expect(states.text()).toContain("Worker 可执行性未探测");
    expect(states.text()).not.toContain("同一配置文件");
    expect(states.text()).toContain("连接验证通过");
    expect(states.text()).toContain("不等于真实任务执行成功");
  });

  it("live 显示真实 Provider：已配置未验证 → 点击验证 → 验证通过", async () => {
    connect();
    let verifyCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/attention/interventions")) return response({ items: [] });
      if (url === `${root}/model-port`) return response({ provider: "openai-compatible", configured: true,
        model: "gpt-test", base_url: "https://api.example.com/v1", api_key: "sk-leak-attempt" });
      if (url === `${root}/model-port/verification`) return response(verificationBody());
      if (url === `${root}/model-port/verify` && init?.method === "POST") {
        verifyCalls += 1;
        return response(lastBody());
      }
      throw new Error(`Unexpected ${url}`);
    }));
    const mounted = await mountWorkbench("/settings"); unmount = mounted.unmount;
    const panel = mounted.wrapper.get('[data-testid="model-port-status"]');
    expect(panel.text()).toContain("真实 Provider（OpenAI 兼容）");
    expect(panel.text()).toContain("gpt-test");
    expect(panel.text()).toContain("https://api.example.com/v1");
    expect(panel.text()).not.toContain("sk-leak-attempt");
    const states = mounted.wrapper.get('[data-testid="service-state"]');
    expect(states.text()).toContain("已配置未验证");
    expect(states.text()).toContain("配置格式通过不等于网络调用成功");
    expect(states.text()).not.toContain("sk-leak-attempt");

    const button = mounted.wrapper.get('[data-testid="verify-model-port"]');
    await button.trigger("click");
    await flush();
    expect(verifyCalls).toBe(1);
    expect(mounted.wrapper.get('[data-testid="service-state"]').text()).toContain("验证通过");
    const detail = mounted.wrapper.get('[data-testid="verification-detail"]');
    expect(detail.text()).toContain("与当前配置一致");
    expect(detail.text()).toContain("真实任务执行成功");
    expect(detail.text()).toContain("连接验证通过");
    expect(mounted.wrapper.text()).not.toContain("sk-leak-attempt");
  });

  it("验证失败显示错误分类指引；指纹不匹配回落为已配置未验证", async () => {
    connect();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/attention/interventions")) return response({ items: [] });
      if (url === `${root}/model-port`) return response({ provider: "openai-compatible", configured: true,
        model: "gpt-test", base_url: "https://api.example.com/v1" });
      if (url === `${root}/model-port/verification`) return response(verificationBody({
        last: lastBody({ ok: false, error_category: "AUTH" }),
        matches_current_config: true
      }));
      throw new Error(`Unexpected ${url}`);
    }));
    const mounted = await mountWorkbench("/settings"); unmount = mounted.unmount;
    const states = mounted.wrapper.get('[data-testid="service-state"]');
    expect(states.text()).toContain("验证失败");
    expect(mounted.wrapper.get('[data-testid="verify-error-guide"]').text())
      .toContain("核对 API Key");
  });

  it("配置指纹不匹配时显示已配置未验证，不沿用旧通过结果", async () => {
    connect();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/attention/interventions")) return response({ items: [] });
      if (url === `${root}/model-port`) return response({ provider: "openai-compatible", configured: true,
        model: "gpt-rotated", base_url: null });
      if (url === `${root}/model-port/verification`) return response(verificationBody({
        current_config_fingerprint: "b".repeat(64),
        last: lastBody(),
        matches_current_config: false
      }));
      throw new Error(`Unexpected ${url}`);
    }));
    const mounted = await mountWorkbench("/settings"); unmount = mounted.unmount;
    const states = mounted.wrapper.get('[data-testid="service-state"]');
    expect(states.text()).toContain("已配置未验证");
    expect(states.text()).toContain("配置变更后旧验证结果自动失效");
    expect(mounted.wrapper.get('[data-testid="verification-detail"]').text())
      .toContain("旧结果不再算已验证");
  });

  it("配置残缺显示当前不可用", async () => {
    connect();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/attention/interventions")) return response({ items: [] });
      if (url === `${root}/model-port`) return response({ provider: "invalid", configured: false,
        model: null, base_url: null });
      if (url === `${root}/model-port/verification`) return response(verificationBody({
        current_config_fingerprint: null, worker_startup_validation: "FAILED" }));
      throw new Error(`Unexpected ${url}`);
    }));
    const mounted = await mountWorkbench("/settings"); unmount = mounted.unmount;
    expect(mounted.wrapper.get('[data-testid="service-state"]').text()).toContain("当前不可用");
  });

  it("通知偏好文案与已确认规则一致，不再写策略尚未冻结", async () => {
    connect();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/attention/interventions")) return response({ items: [] });
      if (url === `${root}/model-port`) return response({ provider: "fake", configured: false, model: null, base_url: null });
      if (url === `${root}/model-port/verification`) return response(verificationBody({
        current_config_fingerprint: null }));
      throw new Error(`Unexpected ${url}`);
    }));
    const mounted = await mountWorkbench("/settings"); unmount = mounted.unmount;
    const text = mounted.wrapper.text();
    expect(text).not.toContain("策略与调度尚未冻结");
    expect(text).toContain("仅提醒必须由用户介入的事项");
    expect(text).toContain("同一事项只提醒一次");
    expect(text).toContain("合并为一条通知");
  });

  it("live 显示真实 Provider 的模型与端点，服务端密钥字段即使出现也不渲染", async () => {
    connect();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/attention/interventions")) return response({ items: [] });
      if (url === `${root}/model-port`) return response({ provider: "openai-compatible", configured: true,
        model: "gpt-test", base_url: "https://api.example.com/v1", api_key: "sk-leak-attempt" });
      if (url === `${root}/model-port/verification`) return response(verificationBody());
      throw new Error(`Unexpected ${url}`);
    }));
    const mounted = await mountWorkbench("/settings"); unmount = mounted.unmount;
    const panel = mounted.wrapper.get('[data-testid="model-port-status"]');
    expect(panel.text()).toContain("真实 Provider（OpenAI 兼容）");
    expect(panel.text()).toContain("gpt-test");
    expect(panel.text()).toContain("https://api.example.com/v1");
    expect(panel.text()).not.toContain("sk-leak-attempt");
    const states = mounted.wrapper.get('[data-testid="service-state"]');
    expect(states.text()).toContain("服务端已读到模型配置：gpt-test");
    expect(states.text()).not.toContain("sk-leak-attempt");
  });

  it("读取失败就地显示错误并可重读，成功后清除错误", async () => {
    connect();
    let healthy = true;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/attention/interventions")) return response({ items: [] });
      if (url === `${root}/model-port` || url === `${root}/model-port/verification`) {
        if (!healthy) return response({ code: "INTERNAL", detail: "读取失败" }, 500);
        return url.endsWith("/verification")
          ? response(verificationBody())
          : response({ provider: "fake", configured: false, model: null, base_url: null });
      }
      throw new Error(`Unexpected ${url}`);
    }));
    const first = await mountWorkbench("/settings"); first.unmount();
    healthy = false;
    const mounted = await mountWorkbench("/settings"); unmount = mounted.unmount;
    expect(mounted.wrapper.text()).toContain("读取失败");
    expect(mounted.wrapper.find('[data-testid="model-port-status"]').exists()).toBe(false);
    healthy = true;
    const retry = Array.from(mounted.wrapper.element!.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("重新读取"))!;
    await new DomWrapper(retry).trigger("click");
    await flush();
    expect(mounted.wrapper.get('[data-testid="model-port-status"]').exists()).toBe(true);
    expect(mounted.wrapper.text()).not.toContain("读取失败：");
  });
});

describe("验证六态解析", () => {
  const configured = { provider: "openai-compatible", configured: true,
    model: "gpt-test", baseUrl: null } as const;
  it("覆盖六态且互斥", () => {
    const cases: readonly { input: Parameters<typeof resolveVerificationState>[0];
      expected: ModelVerificationStateKind }[] = [
      { input: { status: configured, verification: null, verifying: false },
        expected: "UNVERIFIED" },
      { input: { status: configured, verification: null, verifying: true },
        expected: "VERIFYING" },
      { input: { status: configured,
        verification: { currentConfigFingerprint: fingerprint,
          last: { ok: true, latencyMs: 1, provider: "openai-compatible", model: "gpt-test",
            configFingerprint: fingerprint, errorCategory: null,
            verifiedAt: "2026-09-28T10:00:00.000Z" },
          matchesCurrentConfig: true, workerStartupValidation: "OK" },
        verifying: false },
        expected: "VERIFIED" },
      { input: { status: configured,
        verification: { currentConfigFingerprint: fingerprint,
          last: { ok: false, latencyMs: 1, provider: "openai-compatible", model: "gpt-test",
            configFingerprint: fingerprint, errorCategory: "AUTH",
            verifiedAt: "2026-09-28T10:00:00.000Z" },
          matchesCurrentConfig: true, workerStartupValidation: "OK" },
        verifying: false },
        expected: "VERIFY_FAILED" },
      { input: { status: { provider: "fake", configured: false, model: null, baseUrl: null },
        verification: null, verifying: false },
        expected: "UNCONFIGURED" },
      { input: { status: { provider: "invalid", configured: false, model: null, baseUrl: null },
        verification: null, verifying: false },
        expected: "UNAVAILABLE" },
    ];
    for (const entry of cases) {
      expect(resolveVerificationState(entry.input)).toBe(entry.expected);
    }
    // 指纹不匹配：即使 last.ok 也不显示验证通过
    expect(resolveVerificationState({ status: configured,
      verification: { currentConfigFingerprint: "b".repeat(64),
        last: { ok: true, latencyMs: 1, provider: "openai-compatible", model: "gpt-test",
          configFingerprint: fingerprint, errorCategory: null,
          verifiedAt: "2026-09-28T10:00:00.000Z" },
        matchesCurrentConfig: false, workerStartupValidation: "OK" },
      verifying: false })).toBe("UNVERIFIED");
  });
});
