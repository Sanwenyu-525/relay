import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { resolveVerificationState, type ModelVerificationStateKind }
  from "../src/views/SettingsView";
import { DomWrapper, flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
let unmount: (() => void) | null = null;

afterEach(() => { unmount?.(); unmount = null; resetRelayConnectionForTest(); vi.unstubAllGlobals();
  localStorage.removeItem("relay.workbench.planExecution"); });
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
      // 设置页现在还会读 Workspace 记忆设置：桩必须像真服务一样回答，否则页面会多出一处
      // 「记忆设置读取失败」，把这条用例的「模型端口读取失败」断言搅成页面级噪音。
      if (url === `${root}/memory-settings`) return response({ workspace_id: workspaceId,
        revision: "0", recall_enabled: true, automatic_compaction: true });
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
      // 设置页现在还会读 Workspace 记忆设置：桩必须像真服务一样回答，否则页面会多出一处
      // 「记忆设置读取失败」，把这条用例的「模型端口读取失败」断言搅成页面级噪音。
      if (url === `${root}/memory-settings`) return response({ workspace_id: workspaceId,
        revision: "0", recall_enabled: true, automatic_compaction: true });
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
      // 设置页现在还会读 Workspace 记忆设置：桩必须像真服务一样回答，否则页面会多出一处
      // 「记忆设置读取失败」，把这条用例的「模型端口读取失败」断言搅成页面级噪音。
      if (url === `${root}/memory-settings`) return response({ workspace_id: workspaceId,
        revision: "0", recall_enabled: true, automatic_compaction: true });
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
      // 设置页现在还会读 Workspace 记忆设置：桩必须像真服务一样回答，否则页面会多出一处
      // 「记忆设置读取失败」，把这条用例的「模型端口读取失败」断言搅成页面级噪音。
      if (url === `${root}/memory-settings`) return response({ workspace_id: workspaceId,
        revision: "0", recall_enabled: true, automatic_compaction: true });
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
      // 设置页现在还会读 Workspace 记忆设置：桩必须像真服务一样回答，否则页面会多出一处
      // 「记忆设置读取失败」，把这条用例的「模型端口读取失败」断言搅成页面级噪音。
      if (url === `${root}/memory-settings`) return response({ workspace_id: workspaceId,
        revision: "0", recall_enabled: true, automatic_compaction: true });
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
      // 设置页现在还会读 Workspace 记忆设置：桩必须像真服务一样回答，否则页面会多出一处
      // 「记忆设置读取失败」，把这条用例的「模型端口读取失败」断言搅成页面级噪音。
      if (url === `${root}/memory-settings`) return response({ workspace_id: workspaceId,
        revision: "0", recall_enabled: true, automatic_compaction: true });
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
      // 设置页现在还会读 Workspace 记忆设置：桩必须像真服务一样回答，否则页面会多出一处
      // 「记忆设置读取失败」，把这条用例的「模型端口读取失败」断言搅成页面级噪音。
      if (url === `${root}/memory-settings`) return response({ workspace_id: workspaceId,
        revision: "0", recall_enabled: true, automatic_compaction: true });
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
    // 不提供假开关：尚无写接口的语言与通知仍只有只读说明。
    // 2026-10-20 第二轮撤掉了「计划执行方式」：它只是把同一件事再确认一次，
    // 而推进已由服务端负责。执行策略面板里因此不再有任何 select。
    expect(mounted.wrapper.get("#settings-panel-execution").findAll("select")).toHaveLength(0);
    expect(mounted.wrapper.find('[data-testid="plan-execution"]').exists()).toBe(false);
  });

  it("不再有本设备的「计划执行方式」偏好：推进由服务端负责", async () => {
    // 撤掉这个开关的理由不是「少一个设置」，而是它此前是**唯一的第二个推进 Owner**：
    // 选「需要人工确认」时前端必须自己发 applications，页面关掉就会把一条已授权的
    // 请求留在 READY。撤掉之后前端不再持有推进责任（工作台 §43）。
    localStorage.setItem("relay.workbench.planExecution", "CONFIRM");
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench("/settings"); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="settings-group-execution"]').trigger("click");
    expect(mounted.wrapper.find('[data-testid="plan-execution"]').exists()).toBe(false);
    expect(mounted.wrapper.find('[data-testid="settings-plan-execution-mode"]').exists()).toBe(false);
    expect(mounted.wrapper.text()).not.toContain("计划执行方式");
    // 遗留的本地键不会被读取，也不会被清理：那是用户的浏览器存储，不是本页的事实。
    expect(localStorage.getItem("relay.workbench.planExecution")).toBe("CONFIRM");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("live 显示真实 Provider 的模型与端点，服务端密钥字段即使出现也不渲染", async () => {
    connect();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/attention/interventions")) return response({ items: [] });
      if (url === `${root}/model-port`) return response({ provider: "openai-compatible", configured: true,
        model: "gpt-test", base_url: "https://api.example.com/v1", api_key: "sk-leak-attempt" });
      if (url === `${root}/model-port/verification`) return response(verificationBody());
      // 设置页现在还会读 Workspace 记忆设置：桩必须像真服务一样回答，否则页面会多出一处
      // 「记忆设置读取失败」，把这条用例的「模型端口读取失败」断言搅成页面级噪音。
      if (url === `${root}/memory-settings`) return response({ workspace_id: workspaceId,
        revision: "0", recall_enabled: true, automatic_compaction: true });
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

  it("live 可声明图片输入能力：保存后重读，结论来源变成「你的声明」", async () => {
    connect();
    let imageInput = "MODEL_NOT_IN_CATALOG";
    const writes: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/attention/interventions")) return response({ items: [] });
      if (url === `${root}/model-port`) return response({ provider: "openai-compatible",
        configured: true, model: "agnes-3.0-flash", base_url: "https://api.example.com/v1",
        image_input: imageInput,
        image_input_source: imageInput === "DECLARED" ? "DECLARED" : "NONE" });
      if (url === `${root}/model-port/verification`) return response(verificationBody());
      if (url === `${root}/model-capabilities/openai-compatible/agnes-3.0-flash`
        && init?.method === "PUT") {
        writes.push(String(init.body));
        imageInput = "DECLARED";
        return response({ provider: "openai-compatible", source_model_id: "agnes-3.0-flash",
          image_input: true, note: "官方文档写明原生多模态",
          declared_at: "2026-10-20T00:00:00Z", updated_at: "2026-10-20T00:00:00Z" });
      }
      if (url === `${root}/memory-settings`) return response({ workspace_id: workspaceId,
        revision: "0", recall_enabled: true, automatic_compaction: true });
      throw new Error(`Unexpected ${url} ${init?.method ?? "GET"}`);
    }));
    const mounted = await mountModelSettings(); unmount = mounted.unmount;
    // 声明前：目录里没有这个自建模型，界面如实说「未确认」而不是「不支持」。
    expect(mounted.wrapper.get('[data-testid="model-port-image-input"]').text()).toContain("未确认");
    await mounted.wrapper.get('[data-testid="model-image-input-note"]')
      .setValue("官方文档写明原生多模态");
    await mounted.wrapper.get('[data-testid="model-image-input-support"]').trigger("click");
    await flush();
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!)).toEqual({ image_input: true, note: "官方文档写明原生多模态" });
    expect(mounted.wrapper.get('[data-testid="model-image-input-saved"]').text())
      .toContain("已声明支持图片输入");
    // 保存后按同一入口重读：结论与来源都必须变，不能只更新本地文案。
    expect(mounted.wrapper.get('[data-testid="model-port-image-input"]').text())
      .toContain("支持（你的声明）");
  });

  it("读取失败就地显示错误并可重读，成功后清除错误", async () => {    connect();
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
      // 设置页现在还会读 Workspace 记忆设置：桩必须像真服务一样回答，否则页面会多出一处
      // 「记忆设置读取失败」，把这条用例的「模型端口读取失败」断言搅成页面级噪音。
      if (url === `${root}/memory-settings`) return response({ workspace_id: workspaceId,
        revision: "0", recall_enabled: true, automatic_compaction: true });
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
    // 只断言模型端口那一处错误已清除：整页还有默认目录与记忆设置各自的读取结果，
    // 页面级否定断言会把它们的真实状态一起读成「模型端口失败」。
    expect(mounted.wrapper.find('[data-testid="verify-error"]').exists()).toBe(false);
    expect(mounted.wrapper.text()).not.toContain("模型端口读取失败");
  });
});

describe("验证六态解析", () => {
  const configured = { provider: "openai-compatible", configured: true,
    model: "gpt-test", baseUrl: null, maxCallTokens: null, imageInput: "UNKNOWN", imageInputSource: "NONE" } as const;
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
        maxCallTokens: null, imageInput: "UNKNOWN", imageInputSource: "NONE" }, verification: null, verifying: false },
        expected: "UNCONFIGURED" },
      { input: { status: { provider: "invalid", configured: false, model: null, baseUrl: null,
        maxCallTokens: null, imageInput: "UNKNOWN", imageInputSource: "NONE" }, verification: null, verifying: false },
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
