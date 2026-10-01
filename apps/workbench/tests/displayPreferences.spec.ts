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
});

describe("本设备显示偏好", () => {
  it("草稿不立即生效；保存后顶栏按时区显示，重载保留时区与默认工作台", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T18:30:00Z"));
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    let mounted = await mountWorkbench("/settings"); unmount = mounted.unmount;
    expect(mounted.wrapper.get(".topbar-date").text()).toContain("2026-10-01");
    expect(mounted.wrapper.get(".topbar-date").text()).toContain("星期四");
    expect(mounted.wrapper.get("#settings-appearance").attributes("disabled")).toBeDefined();
    await mounted.wrapper.get('[data-testid="settings-timezone"]').setValue("UTC");
    await mounted.wrapper.get('[data-testid="settings-default-workbench"]').setValue("development");
    await mounted.wrapper.get('[data-testid="settings-group-model"]').trigger("click");
    await mounted.wrapper.get('[data-testid="settings-group-basic"]').trigger("click");
    expect((mounted.wrapper.get('[data-testid="settings-timezone"]').element as HTMLSelectElement).value).toBe("UTC");
    expect(mounted.wrapper.get(".topbar-date").text()).toContain("2026-10-01");
    expect(localStorage.getItem(DISPLAY_PREFERENCES_STORAGE_KEY)).toBeNull();
    await mounted.wrapper.get(".settings-basic form").trigger("submit");
    expect(mounted.wrapper.get(".topbar-date").text()).toContain("2026-09-30");
    expect(mounted.wrapper.get(".topbar-date").text()).toContain("星期三");
    expect(mounted.wrapper.get(".topbar-date").attributes("title")).toBe("界面时区：UTC");
    expect(mounted.wrapper.get('[role="status"]').text()).toBe("设置已保存，仅在本设备生效。");
    mounted.unmount(); unmount = null;
    mounted = await mountWorkbench("/settings"); unmount = mounted.unmount;
    expect((mounted.wrapper.get('[data-testid="settings-timezone"]').element as HTMLSelectElement).value).toBe("UTC");
    expect((mounted.wrapper.get('[data-testid="settings-default-workbench"]').element as HTMLSelectElement).value).toBe("development");
    expect(mounted.wrapper.get(".topbar-date").text()).toContain("2026-09-30");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("存储不可写时保留旧值并显示失败，重试成功后清除错误", async () => {
    const mounted = await mountWorkbench("/settings"); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="settings-timezone"]').setValue("UTC");
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    await mounted.wrapper.get(".settings-basic form").trigger("submit");
    expect(mounted.wrapper.get('[role="alert"]').text()).toContain("设置未保存");
    expect(localStorage.getItem(DISPLAY_PREFERENCES_STORAGE_KEY)).toBeNull();
    expect(mounted.wrapper.get(".topbar-date").attributes("title")).toBe("界面时区：Asia/Shanghai");
    write.mockRestore();
    await mounted.wrapper.get(".settings-basic form").trigger("submit");
    expect(mounted.wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(mounted.wrapper.get(".topbar-date").attributes("title")).toBe("界面时区：UTC");
  });

  it("损坏或无效的本地值回落到安全默认，不能产生无效路由或日期", async () => {
    localStorage.setItem(DISPLAY_PREFERENCES_STORAGE_KEY, JSON.stringify({ version: 1,
      timeZone: "Invalid/Zone", defaultWorkbench: "thesis" }));
    const mounted = await mountWorkbench("/settings"); unmount = mounted.unmount;
    expect((mounted.wrapper.get('[data-testid="settings-timezone"]').element as HTMLSelectElement).value).toBe("Asia/Shanghai");
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
