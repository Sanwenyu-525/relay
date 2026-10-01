import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import AppShell from "../src/components/AppShell";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush } from "./mountApp";

vi.mock("../src/components/RecentWorkRail", () => ({ default: () => null }));
vi.mock("../src/components/InterventionNotifications", () => ({ default: () => null }));
let cleanup: (() => void) | null = null;
afterEach(() => { cleanup?.(); cleanup = null; resetRelayConnectionForTest(); vi.unstubAllGlobals(); });

const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";
const c = "33333333-3333-4333-8333-333333333333";
const response = (id: string, title: string) => new Response(JSON.stringify({
  id, project_id: null, title, status: "READY", mode: "ME", revision: "1",
  executor: { kind: "HUMAN", run_id: null, ownership_epoch: "0" },
  current_completion_id: null, waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [],
  allowed_actions: [], acceptance: { acceptance_revision: "1", objective: "阅读", source: "CREATE", criteria: [] }, dependencies: []
}), { status: 200 });

it("工作标题绑定当前目标，慢读和旧目标迟到响应不能冒充新工作", async () => {
  let resolveB: (value: Response) => void = () => undefined;
  const pendingB = new Promise<Response>((resolve) => { resolveB = resolve; });
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const id = new URL(String(input)).pathname.split("/").at(-1);
    if (id === a) return response(a, "原工作 A");
    if (id === b) return pendingB;
    if (id === c) return response(c, "当前工作 C");
    throw new Error("unexpected request");
  }));
  activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId: a, bearerToken: "test-token" });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const router = createMemoryRouter([{ path: "*", element: createElement(AppShell, {
    desktopStatus: "idle", commandOpen: false, onCommandOpen: () => undefined, onCommandClose: () => undefined,
    children: createElement("div", null, "工作正文")
  }) }], { initialEntries: [`/agent?work=${a}`] });
  cleanup = () => { act(() => root.unmount()); router.dispose(); host.remove(); };
  await act(async () => root.render(createElement(RouterProvider, { router })));
  await flush();
  const trail = () => host.querySelector('nav[aria-label="面包屑"]')?.textContent;
  expect(trail()).toContain("原工作 A");
  await act(async () => { await router.navigate(`/agent?work=${b}`); });
  expect(trail()).not.toContain("原工作 A");
  await act(async () => { await router.navigate(`/agent?work=${c}`); });
  await flush();
  expect(trail()).toContain("当前工作 C");
  resolveB(response(b, "迟到工作 B")); await flush();
  expect(trail()).toContain("当前工作 C");
  expect(trail()).not.toContain("迟到工作 B");
});
