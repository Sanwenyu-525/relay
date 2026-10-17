import { test, expect, vi, afterEach } from "vitest";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import RouteErrorBoundary from "../src/components/RouteErrorBoundary";
import { mountReact } from "./mountApp";

/** 路由级兜底错误页：任何视图的渲染错误应落到中文兜底页并保留两个恢复出口。 */
function Boom(): never {
  throw new Error("渲染崩溃样例");
}

// React 会把边界捕获的错误打进 console；这里只断言兜底页行为，压掉噪音。
const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
afterEach(() => { consoleError.mockClear(); });

test("渲染错误落到中文兜底页，如实显示错误并给出刷新与返回出口", async () => {
  const router = createMemoryRouter(
    [{ path: "/", element: <Boom />, errorElement: <RouteErrorBoundary /> }],
    { initialEntries: ["/"] });
  const mounted = await mountReact(<RouterProvider router={router} />);

  expect(mounted.wrapper.get('[data-testid="route-error-boundary"]').exists()).toBe(true);
  const text = mounted.wrapper.text();
  expect(text).toContain("界面遇到未处理的错误");
  expect(mounted.wrapper.get('[data-testid="route-error-summary"]').text())
    .toContain("Error: 渲染崩溃样例");
  expect(mounted.wrapper.get('[data-testid="route-error-reload"]').exists()).toBe(true);
  expect(text).toContain("返回工作台");
  mounted.unmount();
});
