import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayApiClient } from "../src/api/relayClient";
import SessionTodoList from "../src/components/SessionTodoList";
import { flush, mountReact, type DomWrapper } from "./mountApp";

/**
 * 会话待办清单的前端行为（ADR-038，2026-10-30）。
 *
 * 断言用户能看见、能操作的事实：没有清单时不留空面板；收起只给数量与当前步骤；
 * 读失败要说清楚并给重试；版本推进时就地更新。
 */

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const client = new RelayApiClient({ baseUrl, workspaceId,
  bearerToken: "test-bearer-token-0123456789abcdef" });
let unmount: (() => void) | null = null;

afterEach(() => { release(); vi.unstubAllGlobals(); });

function release(): void {
  if (unmount !== null) { unmount(); unmount = null; }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status,
    headers: { "content-type": "application/json" } });
}

function snapshot(version: number, items: readonly { content: string; status: string }[]) {
  return {
    snapshot: { sessionId, version, inProgressLimit: 1,
      updatedAt: "2026-10-30T09:00:00.000Z",
      items: items.map((item, index) => ({ id: `item-${index}`, ...item })) },
  };
}

const threeItems = [
  { content: "读取执行契约", status: "completed" },
  { content: "实现 todo_write", status: "in_progress" },
  { content: "跑集成测试", status: "pending" },
];

async function mount(): Promise<DomWrapper> {
  const mounted = await mountReact(
    <SessionTodoList client={client} sessionId={sessionId} />);
  unmount = mounted.unmount;
  await flush();
  return mounted.wrapper;
}

describe("SessionTodoList", () => {
  it("没有清单时不留空面板", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ snapshot: null })));
    const wrapper = await mount();
    expect(wrapper.find('[data-testid="session-todo-list"]').exists()).toBe(false);
  });

  it("默认收起：只给已完成数量与当前步骤", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(snapshot(2, threeItems))));
    const wrapper = await mount();
    expect(wrapper.get('[data-testid="session-todo-list"]').attributes("open")).toBeUndefined();
    expect(wrapper.get('[data-testid="session-todo-count"]').text()).toBe("已完成 1/3");
    expect(wrapper.get('[data-testid="session-todo-current"]').text()).toBe("实现 todo_write");
    expect(wrapper.findAll('[data-testid="session-todo-item"]').length).toBe(3);
  });

  it("展开后列出全部项目与状态，并声明不代表验收结论", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(snapshot(2, threeItems))));
    const wrapper = await mount();
    wrapper.get('[data-testid="session-todo-list"]').element?.setAttribute("open", "");
    expect(wrapper.findAll('[data-testid="session-todo-item"]').map((item) => item.attributes("data-status")))
      .toEqual(["completed", "in_progress", "pending"]);
    expect(wrapper.text()).toContain("不代表执行结果或验收结论");
  });

  it("读取失败显示失败与重试；重试成功后给出清单", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      return calls === 1 ? json({ error: "boom" }, 500) : json(snapshot(2, threeItems));
    }));
    const wrapper = await mount();
    expect(wrapper.get('[data-testid="session-todo-error-label"]').text()).toBe("读取失败");
    await wrapper.get('[data-testid="session-todo-retry"]').trigger("click");
    await flush();
    expect(wrapper.find('[data-testid="session-todo-error-label"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="session-todo-count"]').text()).toBe("已完成 1/3");
  });

  it("版本推进时摘要就地更新", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(snapshot(4, threeItems))));
    const wrapper = await mount();
    expect(wrapper.get('[data-testid="session-todo-list"]').attributes("data-session-todo-version"))
      .toBe("4");
    expect(wrapper.findAll('[data-testid="session-todo-item"]').length).toBe(3);
  });
});