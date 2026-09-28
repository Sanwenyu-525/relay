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

it("标题栏只回退应用内路由，搜索复用入口，新建任务保留当前项目", async () => {
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

  expect(container.querySelector(".desktop-titlebar__actions")?.textContent).not.toContain("Relay Agent");
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

it("服务未就绪时业务操作禁用，窗口拖动仍可用", async () => {
  const router = createMemoryRouter([{ path: "*", element: createElement(DesktopTitleBar, { available: false, onSearch: vi.fn() }) }], { initialEntries: ["/today"] });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = () => { act(() => root.unmount()); container.remove(); };
  await act(async () => { root.render(createElement(RouterProvider, { router })); });
  for (const name of ["back", "forward", "search", "create-task"]) {
    expect(container.querySelector<HTMLButtonElement>(`[data-testid="titlebar-${name}"]`)?.disabled).toBe(true);
  }
  await act(async () => {
    container.querySelector(".desktop-titlebar__drag")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  });
  expect(startDragging).toHaveBeenCalledOnce();
});
