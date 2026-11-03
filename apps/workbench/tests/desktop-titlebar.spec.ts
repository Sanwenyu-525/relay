import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import DesktopTitleBar from "../src/components/DesktopTitleBar";

const startDragging = vi.fn(async () => undefined);
const toggleMaximize = vi.fn(async () => undefined);
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onResized: async () => () => undefined,
    onFocusChanged: async () => () => undefined,
    isMaximized: async () => false,
    startDragging,
    toggleMaximize,
    minimize: async () => undefined,
    close: async () => undefined
  })
}));

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; startDragging.mockClear(); toggleMaximize.mockClear(); });

it("工作区操作只回退应用内路由，搜索复用入口，新建任务保留当前项目", async () => {
  const onSearch = vi.fn();
  const router = createMemoryRouter([{
    path: "/",
    element: createElement(Fragment, null, createElement(DesktopTitleBar, { available: true, onSearch }), createElement(Outlet)),
    children: [
      { path: "today", element: createElement("p", null, "今日") },
      { path: "projects/:id", element: createElement("p", null, "项目") },
      { path: "tasks", element: createElement("p", null, "任务") }
    ]
  }], { initialEntries: ["/today"] });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = () => { act(() => root.unmount()); container.remove(); };
  await act(async () => { root.render(createElement(RouterProvider, { router })); });
  const button = (name: string) => container.querySelector<HTMLButtonElement>(`[data-testid="titlebar-${name}"]`)!;

  // 常用操作与窗口控制同处一条标题带：搜索在标题栏左侧，应用顶栏不再重复承载。
  expect(container.querySelector('.desktop-titlebar [data-testid="titlebar-search"]')).not.toBeNull();
  expect(container.querySelector('.app-topbar')).toBeNull();
  expect(button("back").disabled).toBe(true);
  expect(button("forward").disabled).toBe(true);
  await act(async () => { await router.navigate("/projects/project-hci"); });
  expect(button("back").disabled).toBe(false);
  await act(async () => { button("back").click(); });
  expect(router.state.location.pathname).toBe("/today");
  expect(button("forward").disabled).toBe(false);
  await act(async () => { button("forward").click(); });
  expect(router.state.location.pathname).toBe("/projects/project-hci");
  await act(async () => { button("search").click(); });
  expect(onSearch).toHaveBeenCalledOnce();
  await act(async () => { button("create-task").click(); });
  expect(`${router.state.location.pathname}${router.state.location.search}`).toBe("/tasks?view=create&project=project-hci");
});

it("桌面标题栏不提供手动 API 连接入口：数据来源由宿主 bootstrap 决定", async () => {
  const router = createMemoryRouter([{ path: "*", element: createElement(DesktopTitleBar, { available: true, onSearch: vi.fn() }) }], { initialEntries: ["/today"] });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = () => { act(() => root.unmount()); container.remove(); };
  await act(async () => { root.render(createElement(RouterProvider, { router })); });

  // 入口整颗键不存在：没有按钮就没有 hover、focus 与 tooltip，相邻的收件箱与窗口控制照常渲染。
  expect(container.querySelector('[data-testid="relay-connection-open"]')).toBeNull();
  expect(container.textContent).not.toContain("打开连接设置");
  expect(container.querySelector('[data-testid="inbox-open"]')).not.toBeNull();
  expect(container.querySelectorAll(".desktop-titlebar__controls .desktop-titlebar__button")).toHaveLength(3);
});

it("服务未就绪时不挂载业务操作，窗口拖动仍可用", async () => {
  const router = createMemoryRouter([{ path: "*", element: createElement(DesktopTitleBar, { available: false, onSearch: vi.fn() }) }], { initialEntries: ["/today"] });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = () => { act(() => root.unmount()); container.remove(); };
  await act(async () => { root.render(createElement(RouterProvider, { router })); });
  for (const name of ["back", "forward", "search", "create-task"]) {
    expect(container.querySelector<HTMLButtonElement>(`[data-testid="titlebar-${name}"]`)).toBeNull();
  }
  await act(async () => {
    container.querySelector(".desktop-titlebar__drag")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  });
  expect(startDragging).toHaveBeenCalledOnce();
});

it("UI-NAV-01 titlebar 布局：导航条目之间的空白承担窗口拖拽，条目本身不触发", async () => {
  localStorage.setItem("relay.workbench.navigationPlacement", "titlebar");
  const router = createMemoryRouter([{ path: "*", element: createElement(DesktopTitleBar, { available: true, onSearch: vi.fn() }) }], { initialEntries: ["/today"] });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = () => {
    act(() => root.unmount()); container.remove();
    localStorage.removeItem("relay.workbench.navigationPlacement");
  };
  await act(async () => { root.render(createElement(RouterProvider, { router })); });

  // 导航进标题带中部，与左侧图标栏共存于同一窗口外壳，但不在同一布局里。
  const navigation = container.querySelector(".titlebar-navigation");
  expect(navigation).not.toBeNull();
  // 空白单击：与 .desktop-titlebar__drag 同一条拖动处理。
  await act(async () => {
    navigation!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, detail: 1 }));
  });
  expect(startDragging).toHaveBeenCalledOnce();
  // 空白双击：沿用标题带的双击最大化/还原。
  await act(async () => {
    navigation!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, detail: 2 }));
  });
  expect(toggleMaximize).toHaveBeenCalledOnce();
  // 链接与「更多」触发器是交互元素，不触发宿主拖动。
  await act(async () => {
    navigation!.querySelector("a")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, detail: 1 }));
  });
  expect(startDragging).toHaveBeenCalledTimes(1);
  await act(async () => {
    navigation!.querySelector("summary")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, detail: 1 }));
  });
  expect(startDragging).toHaveBeenCalledTimes(1);
});
