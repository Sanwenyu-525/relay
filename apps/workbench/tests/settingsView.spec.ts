import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
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

describe("设置页模型端口状态", () => {
  it("fixture 模式明确无真实服务实例状态，不发起请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench("/settings"); unmount = mounted.unmount;
    expect(mounted.wrapper.text()).toContain("没有真实服务实例状态");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("live 显示 Mock 端口说明与密钥边界说明", async () => {
    connect();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/attention/interventions")) return response({ items: [] });
      if (url === `${root}/model-port`) return response({ provider: "fake", configured: false, model: null, base_url: null });
      throw new Error(`Unexpected ${url}`);
    }));
    const mounted = await mountWorkbench("/settings"); unmount = mounted.unmount;
    const panel = mounted.wrapper.get('[data-testid="model-port-status"]');
    expect(panel.text()).toContain("Mock 模型端口");
    expect(panel.text()).toContain("不读取、不显示、也不修改任何密钥");
  });

  it("live 显示真实 Provider 的模型与端点，服务端密钥字段即使出现也不渲染", async () => {
    connect();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/attention/interventions")) return response({ items: [] });
      if (url === `${root}/model-port`) return response({ provider: "openai-compatible", configured: true,
        model: "gpt-test", base_url: "https://api.example.com/v1", api_key: "sk-leak-attempt" });
      throw new Error(`Unexpected ${url}`);
    }));
    const mounted = await mountWorkbench("/settings"); unmount = mounted.unmount;
    const panel = mounted.wrapper.get('[data-testid="model-port-status"]');
    expect(panel.text()).toContain("真实 Provider（OpenAI 兼容）");
    expect(panel.text()).toContain("gpt-test");
    expect(panel.text()).toContain("https://api.example.com/v1");
    expect(panel.text()).not.toContain("sk-leak-attempt");
  });

  it("读取失败就地显示错误并可重读，成功后清除错误", async () => {
    connect();
    let healthy = true;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/attention/interventions")) return response({ items: [] });
      if (url === `${root}/model-port`) {
        if (!healthy) return response({ code: "INTERNAL", detail: "读取失败" }, 500);
        return response({ provider: "fake", configured: false, model: null, base_url: null });
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
