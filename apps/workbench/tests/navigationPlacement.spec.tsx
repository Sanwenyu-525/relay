import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NAVIGATION_PLACEMENT_STORAGE_KEY, saveNavigationPlacement, useNavigationPlacement } from "../src/lib/navigationPreferences";
import { flush, mountWorkbench } from "./mountApp";

let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; window.localStorage.clear(); vi.restoreAllMocks(); });

async function readHookValue(): Promise<string> {
  let value = "";
  function Probe(): null {
    value = useNavigationPlacement();
    return null;
  }
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(<Probe />); });
  await act(async () => { root.unmount(); });
  container.remove();
  return value;
}

describe("导航栏位置偏好（UI-NAV-01）", () => {
  it("默认左侧导航；保存后立即生效并持久化；非法值回落左侧", async () => {
    expect(await readHookValue()).toBe("sidebar");
    localStorage.setItem(NAVIGATION_PLACEMENT_STORAGE_KEY, "titlebar");
    expect(await readHookValue()).toBe("titlebar");
    // 拼错或被外写坏：不产生第三种布局，回落左侧而不是抛错。
    localStorage.setItem(NAVIGATION_PLACEMENT_STORAGE_KEY, "bottom");
    expect(await readHookValue()).toBe("sidebar");
    localStorage.setItem(NAVIGATION_PLACEMENT_STORAGE_KEY, "not-json");
    expect(await readHookValue()).toBe("sidebar");

    saveNavigationPlacement("titlebar");
    expect(localStorage.getItem(NAVIGATION_PLACEMENT_STORAGE_KEY)).toBe("titlebar");
    expect(await readHookValue()).toBe("titlebar");
  });

  it("保存写失败时向上抛错，存储保持旧值，不伪称已保存", async () => {
    localStorage.setItem(NAVIGATION_PLACEMENT_STORAGE_KEY, "titlebar");
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    expect(() => saveNavigationPlacement("sidebar")).toThrow();
    expect(localStorage.getItem(NAVIGATION_PLACEMENT_STORAGE_KEY)).toBe("titlebar");
    write.mockRestore();
  });
});

describe("壳双导航布局", () => {
  it("默认渲染左侧图标导航且标题栏无横向导航", async () => {
    const mounted = await mountWorkbench("/today"); unmount = mounted.unmount;
    expect(mounted.wrapper.get(".app-frame").attributes("data-navigation-placement")).toBe("sidebar");
    expect(mounted.wrapper.get(".app-navrail").attributes("aria-label")).toBe("应用导航");
    expect(mounted.wrapper.find(".titlebar-navigation").exists()).toBe(false);
    // 近期工作栏在两种布局下都渲染。
    expect(mounted.wrapper.find('[data-testid="app-context-rail"]').exists()).toBe(true);
  });

  it("titlebar 布局：图标栏退位、横向导航进标题栏、近期工作栏与拖拽条保留", async () => {
    localStorage.setItem(NAVIGATION_PLACEMENT_STORAGE_KEY, "titlebar");
    const mounted = await mountWorkbench("/today"); unmount = mounted.unmount;
    expect(mounted.wrapper.get(".app-frame").attributes("data-navigation-placement")).toBe("titlebar");
    expect(mounted.wrapper.find(".app-navrail").exists()).toBe(false);
    const navigation = mounted.wrapper.get(".titlebar-navigation");
    expect(navigation.find('[aria-label="全局导航"]').exists()).toBe(true);
    // 入口与左侧导航同一份数据：常用四条 + 次级五条 + 设置（开发工具属 DEV 构建，jsdom 即 DEV）。
    for (const label of ["工作台", "项目", "待处理", "资料", "今日", "任务", "动态", "收件箱", "定时任务", "设置"]) {
      expect(navigation.text()).toContain(label);
    }
    expect(mounted.wrapper.find('[data-testid="app-context-rail"]').exists()).toBe(true);
    expect(mounted.wrapper.find('[data-testid="sidebar-resize-handle"]').exists()).toBe(true);
    // 当前页唯一高亮：/today 激活「今日」，不激活「工作台」。
    const activeItems = navigation.findAll(".titlebar-navigation__item--active");
    expect(activeItems).toHaveLength(1);
    expect(activeItems[0]!.text()).toContain("今日");
  });

  it("titlebar 布局沿用 /tasks 与 /inbox 的互斥高亮规则", async () => {
    localStorage.setItem(NAVIGATION_PLACEMENT_STORAGE_KEY, "titlebar");
    const mounted = await mountWorkbench("/tasks?tab=inbox"); unmount = mounted.unmount;
    const navigation = mounted.wrapper.get(".titlebar-navigation");
    const active = navigation.findAll(".titlebar-navigation__item--active");
    expect(active).toHaveLength(1);
    expect(active[0]!.text()).toContain("收件箱");
    await mounted.router.push("/tasks");
    const activeTasks = mounted.wrapper.get(".titlebar-navigation").findAll(".titlebar-navigation__item--active");
    expect(activeTasks).toHaveLength(1);
    expect(activeTasks[0]!.text()).toContain("任务");
  });

  it("切换导航布局不重建页面：主内容 DOM 节点与路由原样保留", async () => {
    const mounted = await mountWorkbench("/today"); unmount = mounted.unmount;
    const mainBefore = document.getElementById("main-content");
    expect(mainBefore).not.toBeNull();
    await act(async () => { saveNavigationPlacement("titlebar"); });
    await flush();
    expect(mounted.wrapper.get(".app-frame").attributes("data-navigation-placement")).toBe("titlebar");
    expect(document.getElementById("main-content")).toBe(mainBefore);
    expect(mounted.router.currentRoute.value.path).toBe("/today");
    await act(async () => { saveNavigationPlacement("sidebar"); });
    await flush();
    expect(document.getElementById("main-content")).toBe(mainBefore);
    expect(mounted.wrapper.get(".app-navrail").exists()).toBe(true);
  });
});

describe("设置页「导航栏位置」开关", () => {
  it("点击立即切换并持久化，重新进入设置回显当前选择", async () => {
    const mounted = await mountWorkbench("/settings"); unmount = mounted.unmount;
    const radios = mounted.wrapper.findAll('input[name="settings-navigation-placement"]');
    expect(radios).toHaveLength(2);
    expect((radios[0]!.element as HTMLInputElement).checked).toBe(true);

    await mounted.wrapper.findAll('input[name="settings-navigation-placement"]')[1]!.setValue(true);
    expect(localStorage.getItem(NAVIGATION_PLACEMENT_STORAGE_KEY)).toBe("titlebar");
    // 即时生效：同一挂载里的壳布局同步切换，无需重载或重新进入设置。
    expect(mounted.wrapper.get(".app-frame").attributes("data-navigation-placement")).toBe("titlebar");
    expect((mounted.wrapper.findAll('input[name="settings-navigation-placement"]')[1]!.element as HTMLInputElement).checked).toBe(true);

    mounted.unmount(); unmount = null;
    const remounted = await mountWorkbench("/settings"); unmount = remounted.unmount;
    expect((remounted.wrapper.findAll('input[name="settings-navigation-placement"]')[1]!.element as HTMLInputElement).checked).toBe(true);
    // 与时区/默认工作台的存储互不覆盖。
    expect(localStorage.getItem("relay.workbench.displayPreferences")).toBeNull();
  });

  it("存储不可写时显示失败反馈，选择回弹到已保存值", async () => {
    const mounted = await mountWorkbench("/settings"); unmount = mounted.unmount;
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    await mounted.wrapper.findAll('input[name="settings-navigation-placement"]')[1]!.setValue(true);
    expect(mounted.wrapper.get('[data-testid="settings-navigation-placement-error"]').text()).toContain("导航栏位置未保存");
    expect(localStorage.getItem(NAVIGATION_PLACEMENT_STORAGE_KEY)).toBeNull();
    // 存储没变，受控单选框回弹到左侧导航，不停留在未保存的选择上。
    expect((mounted.wrapper.findAll('input[name="settings-navigation-placement"]')[0]!.element as HTMLInputElement).checked).toBe(true);
    expect(mounted.wrapper.get(".app-frame").attributes("data-navigation-placement")).toBe("sidebar");
    write.mockRestore();
  });
});
