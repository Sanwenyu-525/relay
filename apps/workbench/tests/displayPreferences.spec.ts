import { createElement } from "react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DISPLAY_PREFERENCES_STORAGE_KEY, saveDisplayPreferences } from "../src/lib/displayPreferences";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import ProjectWorkbenchEntry from "../src/views/ProjectWorkbenchEntry";
import { flush, mountReact, mountWorkbench } from "./mountApp";

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.(); unmount = null;
  resetRelayConnectionForTest();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  localStorage.removeItem(DISPLAY_PREFERENCES_STORAGE_KEY);
  localStorage.removeItem("relay.motion");
  delete document.documentElement.dataset.motion;
});

describe("本设备显示偏好", () => {
  it("草稿不立即生效；保存后顶栏按时区显示，重载保留时区与默认工作台", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T18:30:00Z"));
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    let mounted = await mountWorkbench("/settings"); unmount = mounted.unmount;
    expect(mounted.wrapper.get(".desktop-titlebar__date").text()).toContain("2026-10-01");
    expect(mounted.wrapper.get(".desktop-titlebar__date").text()).toContain("星期四");
    // 外观是只读事实，不是伪装成可用的主题开关。
    expect(mounted.wrapper.get('[data-testid="settings-appearance"]').text()).toContain("浅色");
    expect(mounted.wrapper.get('[data-testid="settings-appearance"]').text()).toContain("当前仅支持浅色主题");
    await mounted.wrapper.get('[data-testid="settings-timezone"]').setValue("UTC");
    // 默认工作台属于「工作台」页签：切组后草稿保留，保存各自提交。
    await mounted.wrapper.get('[data-testid="settings-group-workbench"]').trigger("click");
    await mounted.wrapper.get('[data-testid="settings-default-workbench"]').setValue("development");
    await mounted.wrapper.get('[data-testid="settings-group-basic"]').trigger("click");
    expect((mounted.wrapper.get('[data-testid="settings-timezone"]').element as HTMLSelectElement).value).toBe("UTC");
    expect(mounted.wrapper.get(".desktop-titlebar__date").text()).toContain("2026-10-01");
    expect(localStorage.getItem(DISPLAY_PREFERENCES_STORAGE_KEY)).toBeNull();
    await mounted.wrapper.get(".settings-basic form").trigger("submit");
    expect(mounted.wrapper.get(".desktop-titlebar__date").text()).toContain("2026-09-30");
    expect(mounted.wrapper.get(".desktop-titlebar__date").text()).toContain("星期三");
    expect(mounted.wrapper.get(".desktop-titlebar__date").attributes("title")).toBe("界面时区：UTC");
    expect(mounted.wrapper.get('[data-testid="settings-save-result"]').text())
      .toBe("显示偏好已保存，仅在本设备生效。");
    // 保存显示偏好不应顺手把未选的默认工作台写成 general：它仍是 null。
    expect((JSON.parse(localStorage.getItem(DISPLAY_PREFERENCES_STORAGE_KEY) ?? "{}") as
      { defaultWorkbench: unknown }).defaultWorkbench).toBeNull();
    await mounted.wrapper.get('[data-testid="settings-group-workbench"]').trigger("click");
    expect((mounted.wrapper.get('[data-testid="settings-default-workbench"]').element as HTMLSelectElement).value)
      .toBe("development");
    await mounted.wrapper.get('[data-testid="settings-default-workbench-save"]').trigger("click");
    expect(mounted.wrapper.get('[data-testid="settings-default-workbench-result"]').text())
      .toBe("默认工作台已保存。");
    mounted.unmount(); unmount = null;
    mounted = await mountWorkbench("/settings"); unmount = mounted.unmount;
    expect((mounted.wrapper.get('[data-testid="settings-timezone"]').element as HTMLSelectElement).value).toBe("UTC");
    await mounted.wrapper.get('[data-testid="settings-group-workbench"]').trigger("click");
    expect((mounted.wrapper.get('[data-testid="settings-default-workbench"]').element as HTMLSelectElement).value).toBe("development");
    expect(mounted.wrapper.get(".desktop-titlebar__date").text()).toContain("2026-09-30");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("动效偏好保存在本设备，保存后即时应用到运行期开关", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench("/settings"); unmount = mounted.unmount;
    expect((mounted.wrapper.get('[data-testid="settings-motion"]').element as HTMLSelectElement).value).toBe("system");
    await mounted.wrapper.get('[data-testid="settings-motion"]').setValue("off");
    await mounted.wrapper.get(".settings-basic form").trigger("submit");
    expect(localStorage.getItem("relay.motion")).toBe("off");
    expect(document.documentElement.dataset.motion).toBe("off");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("存储不可写时保留旧值并显示失败，重试成功后清除错误", async () => {
    const mounted = await mountWorkbench("/settings"); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="settings-timezone"]').setValue("UTC");
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    await mounted.wrapper.get(".settings-basic form").trigger("submit");
    expect(mounted.wrapper.get('[role="alert"]').text()).toContain("设置未保存");
    expect(localStorage.getItem(DISPLAY_PREFERENCES_STORAGE_KEY)).toBeNull();
    expect(mounted.wrapper.get(".desktop-titlebar__date").attributes("title")).toBe("界面时区：Asia/Shanghai");
    write.mockRestore();
    await mounted.wrapper.get(".settings-basic form").trigger("submit");
    expect(mounted.wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(mounted.wrapper.get(".desktop-titlebar__date").attributes("title")).toBe("界面时区：UTC");
  });

  it("只拒绝动效写入时如实分项回执：时区已保存、动效只在本窗口生效，重试后恢复完整回执（2026-11-11 验收整改）", async () => {
    const mounted = await mountWorkbench("/settings"); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="settings-motion"]').setValue("off");
    // 只拒 relay.motion：时区那一项写得进去，回执必须逐项说清，不能整单谎报已保存。
    const originalSetItem = Storage.prototype.setItem;
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage, key: string, value: string) {
      if (key === "relay.motion") throw new DOMException("quota", "QuotaExceededError");
      originalSetItem.call(this, key, value);
    });
    await mounted.wrapper.get(".settings-basic form").trigger("submit");
    expect(mounted.wrapper.get('[data-testid="settings-save-result"]').text())
      .toBe("时区偏好已保存，仅在本设备生效。");
    expect(mounted.wrapper.get('[data-testid="settings-motion-save-result"]').text())
      .toContain("动效偏好未能写入本设备存储");
    // 时区确实落了盘；动效没落盘但当次窗口仍按所选档位绘制。
    expect((JSON.parse(localStorage.getItem(DISPLAY_PREFERENCES_STORAGE_KEY) ?? "{}") as
      { timeZone: unknown }).timeZone).toBe("Asia/Shanghai");
    expect(localStorage.getItem("relay.motion")).toBeNull();
    expect(document.documentElement.dataset.motion).toBe("off");
    // 重试：写回成功后旧错误消失，恢复完整回执。
    write.mockRestore();
    await mounted.wrapper.get(".settings-basic form").trigger("submit");
    expect(mounted.wrapper.get('[data-testid="settings-save-result"]').text())
      .toBe("显示偏好已保存，仅在本设备生效。");
    expect(mounted.wrapper.find('[data-testid="settings-motion-save-result"]').exists()).toBe(false);
    expect(localStorage.getItem("relay.motion")).toBe("off");
  });

  it("损坏或无效的本地值回落到安全默认，不能产生无效路由或日期", async () => {
    localStorage.setItem(DISPLAY_PREFERENCES_STORAGE_KEY, JSON.stringify({ version: 1,
      timeZone: "Invalid/Zone", defaultWorkbench: "thesis" }));
    const mounted = await mountWorkbench("/settings"); unmount = mounted.unmount;
    expect((mounted.wrapper.get('[data-testid="settings-timezone"]').element as HTMLSelectElement).value).toBe("Asia/Shanghai");
    await mounted.wrapper.get('[data-testid="settings-group-workbench"]').trigger("click");
    expect((mounted.wrapper.get('[data-testid="settings-default-workbench"]').element as HTMLSelectElement).value).toBe("general");
  });
});

const projectId = "22222222-2222-4222-8222-222222222222";
async function mountEntry() {
  const router = createMemoryRouter([
    { path: "/projects/:id/workbench", element: createElement(ProjectWorkbenchEntry) },
    { path: "/projects/:id/workbench/:kind", element: createElement("p", null, "工作台目标") }
  ], { initialEntries: [`/projects/${projectId}/workbench?from=project`] });
  const mounted = await mountReact(createElement(RouterProvider, { router }));
  unmount = mounted.unmount;
  await flush();
  return { ...mounted, router };
}

function connect(revision: string, kind: "general" | "thesis" | "development") {
  activateRelayConnection({ baseUrl: "http://127.0.0.1:8787",
    workspaceId: "11111111-1111-4111-8111-111111111111", bearerToken: "test-bearer-token-0123456789abcdef" });
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.method ?? "GET").toBe("GET");
    return { ok: true, status: 200, json: async () => ({ project_id: projectId,
      revision, kind, template_version: "1", template_sha256: "a".repeat(64),
      pages: [], updated_at: "2026-09-30T00:00:00Z" }) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("默认工作台入口优先级", () => {
  it("没有本设备选择时保留项目类型生成的初始视图", async () => {
    connect("0", "thesis");
    const { router } = await mountEntry();
    expect(router.state.location.pathname).toBe(`/projects/${projectId}/workbench/thesis`);
  });

  it("已保存的本设备选择替代项目初始配置，保留查询参数且只读", async () => {
    saveDisplayPreferences({ timeZone: "Asia/Shanghai", defaultWorkbench: "development" });
    const fetchMock = connect("0", "thesis");
    const { router } = await mountEntry();
    expect(router.state.location.pathname).toBe(`/projects/${projectId}/workbench/development`);
    expect(router.state.location.search).toBe("?from=project");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("项目人工保存的配置始终优先，即使是通用且revision超出安全整数", async () => {
    saveDisplayPreferences({ timeZone: "Asia/Shanghai", defaultWorkbench: "development" });
    connect("9007199254740993", "general");
    const { router } = await mountEntry();
    expect(router.state.location.pathname).toBe(`/projects/${projectId}/workbench/general`);
  });

  it("示例入口也使用已保存的本设备选择", async () => {
    saveDisplayPreferences({ timeZone: "UTC", defaultWorkbench: "thesis" });
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const { router } = await mountEntry();
    expect(router.state.location.pathname).toBe(`/projects/${projectId}/workbench/thesis`);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
