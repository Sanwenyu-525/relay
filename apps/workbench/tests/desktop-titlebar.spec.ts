import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import DesktopTitleBar from "../src/components/DesktopTitleBar";

const startDragging = vi.fn(async () => undefined);
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onResized: async () => () => undefined,
    onFocusChanged: async () => () => undefined,
    isMaximized: async () => false,
    startDragging,
    toggleMaximize: async () => undefined,
    minimize: async () => undefined,
    close: async () => undefined
  })
}));

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; startDragging.mockClear(); });

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
