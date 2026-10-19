import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { resolveVerificationState, type ModelVerificationStateKind }
  from "../src/views/SettingsView";
import { PLAN_EXECUTION_STORAGE_KEY } from "../src/lib/planExecutionPreference";
import { DomWrapper, flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
let unmount: (() => void) | null = null;

afterEach(() => { unmount?.(); unmount = null; resetRelayConnectionForTest(); vi.unstubAllGlobals();
  localStorage.removeItem(PLAN_EXECUTION_STORAGE_KEY); });
function connect() { activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" }); }
function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const fingerprint = "a".repeat(64);
type VerificationBody = {
  current_config_fingerprint: string | null;
  last: ReturnType<typeof lastBody> | null;
  matches_current_config: boolean;
  worker_startup_validation: string;
};
function verificationBody(overrides: Partial<VerificationBody> = {}): VerificationBody {
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

async function mountModelSettings() {
  const mounted = await mountWorkbench("/settings");
  await mounted.wrapper.get('[data-testid="settings-group-model"]').trigger("click");
  return mounted;
}

describe("设置页模型端口状态", () => {
  it("方向键和 Home 切换页签时保留未保存的基本设置", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench("/settings"); unmount = mounted.unmount;
    const field = mounted.wrapper.get('[data-testid="settings-timezone"]');
    await field.setValue("UTC");
    const basic = mounted.wrapper.get('[data-testid="settings-group-basic"]');
    const model = mounted.wrapper.get('[data-testid="settings-group-model"]');
    (basic.element as HTMLButtonElement).focus();
    await act(async () => { basic.element!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
    expect(model.attributes("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(model.element);
    await act(async () => { model.element!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })); });
    expect(basic.attributes("aria-selected")).toBe("true");
    expect(mounted.wrapper.get('[data-testid="settings-timezone"]').element).toBe(field.element);
    expect((field.element as HTMLSelectElement).value).toBe("UTC");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("fixture 模式明确无真实服务实例状态，不发起请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountModelSettings(); unmount = mounted.unmount;
    expect(mounted.wrapper.text()).toContain("没有真实服务实例状态");
    await mounted.wrapper.get('[data-testid="settings-group-basic"]').trigger("click");
    expect(mounted.wrapper.text()).toContain("当前仅支持浅色主题");
    expect(mounted.wrapper.get("#settings-appearance").attributes("disabled")).toBeDefined();
    expect(mounted.wrapper.text()).toContain("不改变已保存的稍后处理日期");
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
    const mounted = await mountModelSettings(); unmount = mounted.unmount;
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
    // 假服务必须像真服务一样记住验证结果：POST /verify 之后 GET /verification 要读得到 last 与
    // matches_current_config。此前夹具恒返回 last=null，只因客户端在本地拼装状态才「通过」——
    // 那正是把归一化结论交给前端推导的缺陷。
    let stored: VerificationBody | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/attention/interventions")) return response({ items: [] });
      if (url === `${root}/model-port`) return response({ provider: "openai-compatible", configured: true,
        model: "gpt-test", base_url: "https://api.example.com/v1", api_key: "sk-leak-attempt" });
      if (url === `${root}/model-port/verification`) return response(stored ?? verificationBody());
      if (url === `${root}/model-port/verify` && init?.method === "POST") {
        verifyCalls += 1;
        const last = lastBody();
        stored = verificationBody({ last, matches_current_config: true });
        return response(last);
      }
      throw new Error(`Unexpected ${url}`);
    }));
    const mounted = await mountModelSettings(); unmount = mounted.unmount;
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
    // 通过状态必须来自重读的服务端事实，不是 POST 成功就算通过：服务端仍说 last=null 时
    // 即使命令成功也不得显示「验证通过」。
    expect(mounted.wrapper.get('[data-testid="service-state"]').text()).toContain("验证通过");
    const detail = mounted.wrapper.get('[data-testid="verification-detail"]');
    expect(detail.text()).toContain("与当前配置一致");
    expect(detail.text()).toContain("真实任务执行成功");
    expect(detail.text()).toContain("连接验证通过");
    // 验证时间用本设备可读格式显示，原始 ISO 串只保留在 time.dateTime 属性里。
    expect(detail.text()).not.toContain("2026-09-28T10:00:00.000Z");
    expect(detail.text()).toContain("2026-09-28 18:00:00");
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
    const mounted = await mountModelSettings(); unmount = mounted.unmount;
    const states = mounted.wrapper.get('[data-testid="service-state"]');
    expect(states.text()).toContain("验证失败");
    expect(mounted.wrapper.get('[data-testid="verify-error-guide"]').text())
      .toContain("核对 API Key");
    // 错误分类 chip 用中文短名，原枚举 AUTH 只保留在 title 供核对。
    expect(mounted.wrapper.get('[data-testid="verification-detail"]').text()).toContain("认证失败");
    expect(mounted.wrapper.text()).not.toContain("AUTH");
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
    const mounted = await mountModelSettings(); unmount = mounted.unmount;
    const states = mounted.wrapper.get('[data-testid="service-state"]');
    expect(states.text()).toContain("已配置未验证");
    expect(states.text()).toContain("配置变更后旧验证结果自动失效");
    expect(mounted.wrapper.get('[data-testid="verification-detail"]').text())
      .toContain("旧结果不再算已验证");
  });

  // 守住「验证通过」只能来自服务端读取：POST /verify 返回成功也不够，若 GET /verification
  // 仍说没有匹配的验证记录，界面必须停在「已配置未验证」。
  it("验证命令成功但服务端未记录匹配结果时，不得显示验证通过", async () => {
    connect();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/attention/interventions")) return response({ items: [] });
      if (url === `${root}/model-port`) return response({ provider: "openai-compatible", configured: true,
        model: "gpt-test", base_url: "https://api.example.com/v1" });
      if (url === `${root}/model-port/verification`) return response(verificationBody({ last: null, matches_current_config: false }));
      if (url === `${root}/model-port/verify` && init?.method === "POST") return response(lastBody());
      throw new Error(`Unexpected ${url}`);
    }));
    const mounted = await mountModelSettings(); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="verify-model-port"]').trigger("click");
    await flush();
    // 断言精确到状态 chip：行标题「模型验证成功」是固定 dt 文案，不随状态变化；
    // 服务端未记录匹配结果时 chip 必须停在「已配置未验证」，不得显示「验证通过/验证成功」。
    const row = mounted.wrapper.get('[data-testid="service-state-verified"]');
    expect(row.text()).toContain("已配置未验证");
    expect(row.get(".status-chip").text()).toBe("已配置未验证");
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
    const mounted = await mountModelSettings(); unmount = mounted.unmount;
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
    await mounted.wrapper.get('[data-testid="settings-group-execution"]').trigger("click");
    const text = mounted.wrapper.text();
    expect(text).not.toContain("策略与调度尚未冻结");
    // 界面只保留用户语言的摘要；规格全文降级为悬浮 title，不再整段直出。
    expect(text).toContain("仅提醒必须由用户介入的事项");
    expect(text).toContain("同一事项只提醒一次");
    expect(text).not.toContain("合并为一条通知");
    expect(text).toContain("暂不可修改");
    // 不提供假开关：尚无写接口的语言与通知仍只有只读说明；唯一真正接线的控件是
    // 「计划执行方式」（本设备偏好），它必须出现在执行策略面板里。
    const controls = mounted.wrapper.get("#settings-panel-execution").findAll("select");
    expect(controls).toHaveLength(1);
    expect(controls[0]?.attributes("data-testid")).toBe("settings-plan-execution-mode");
  });

  it("计划执行方式：草稿不立即生效，保存后仅本设备保留，损坏值回落自动执行", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench("/settings"); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="settings-group-execution"]').trigger("click");
    const mode = mounted.wrapper.get('[data-testid="settings-plan-execution-mode"]');
    expect((mode.element as HTMLSelectElement).value).toBe("AUTO");
    await mode.setValue("CONFIRM");
    expect(localStorage.getItem(PLAN_EXECUTION_STORAGE_KEY)).toBeNull();
    await mounted.wrapper.get('[data-testid="plan-execution"] form').trigger("submit");
    expect(localStorage.getItem(PLAN_EXECUTION_STORAGE_KEY)).toBe("CONFIRM");
    expect(mounted.wrapper.get('[data-testid="plan-execution"]').text()).toContain("仅在本设备生效");
    // 不向服务端打听偏好：这个设置只写本设备存储。
    expect(fetchMock).not.toHaveBeenCalled();
    mounted.unmount(); unmount = null;
    const reloaded = await mountWorkbench("/settings"); unmount = reloaded.unmount;
    await reloaded.wrapper.get('[data-testid="settings-group-execution"]').trigger("click");
    expect((reloaded.wrapper.get('[data-testid="settings-plan-execution-mode"]').element as HTMLSelectElement).value).toBe("CONFIRM");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("计划执行方式：本地值无法识别时回落自动执行，不猜成某一种方式", async () => {
    localStorage.setItem(PLAN_EXECUTION_STORAGE_KEY, "MAYBE");
    const mounted = await mountWorkbench("/settings"); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="settings-group-execution"]').trigger("click");
    expect((mounted.wrapper.get('[data-testid="settings-plan-execution-mode"]').element as HTMLSelectElement).value).toBe("AUTO");
  });

  it("计划执行方式：存储不可写时保留旧值并显示失败", async () => {
    localStorage.setItem(PLAN_EXECUTION_STORAGE_KEY, "AUTO");
    const mounted = await mountWorkbench("/settings"); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="settings-group-execution"]').trigger("click");
    await mounted.wrapper.get('[data-testid="settings-plan-execution-mode"]').setValue("CONFIRM");
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    await mounted.wrapper.get('[data-testid="plan-execution"] form').trigger("submit");
    expect(mounted.wrapper.get('[role="alert"]').text()).toContain("设置未保存");
    expect(localStorage.getItem(PLAN_EXECUTION_STORAGE_KEY)).toBe("AUTO");
    write.mockRestore();
    await mounted.wrapper.get('[data-testid="plan-execution"] form').trigger("submit");
    expect(mounted.wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(localStorage.getItem(PLAN_EXECUTION_STORAGE_KEY)).toBe("CONFIRM");
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
    const mounted = await mountModelSettings(); unmount = mounted.unmount;
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
    const first = await mountModelSettings(); first.unmount();
    healthy = false;
    const mounted = await mountModelSettings(); unmount = mounted.unmount;
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
    model: "gpt-test", baseUrl: null, maxCallTokens: null } as const;
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
      { input: { status: { provider: "fake", configured: false, model: null, baseUrl: null,
        maxCallTokens: null }, verification: null, verifying: false },
        expected: "UNCONFIGURED" },
      { input: { status: { provider: "invalid", configured: false, model: null, baseUrl: null,
        maxCallTokens: null }, verification: null, verifying: false },
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
