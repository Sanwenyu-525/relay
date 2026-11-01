import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayApiClient } from "../src/api/relayClient";
import SessionTodoList, { shouldAccept } from "../src/components/SessionTodoList";
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
describe("SessionTodoList 停止态与迟到响应", () => {
  it("本轮停止时进行中项不再转圈，并给出「怎么接着跑」而不是一条死路", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(snapshot(3, threeItems))));
    const mounted = await mountReact(
      <SessionTodoList client={client} sessionId={sessionId} active={false} />);
    unmount = mounted.unmount;
    await flush();
    const wrapper = mounted.wrapper;
    expect(wrapper.find(".session-todos-icon-active").exists()).toBe(false);
    expect(wrapper.get('[data-testid="session-todo-stalled"]').text())
      .toContain("本轮停止，这一步未收尾");
    wrapper.get('[data-testid="session-todo-list"]').element?.setAttribute("open", "");
    const statuses = wrapper.findAll("[data-testid='session-todo-item']")
      .map((item) => item.get(".session-todos-status").text());
    expect(statuses).toContain("进行中·已停止");
    // 「没做完」必须和「怎么继续」同屏出现（2026-11-01 E2E-ALL-01）：只报未收尾，
    // 用户读到的是失败；说清清单会延续、已完成的步骤不重做，才是可执行的事实。
    const resume = wrapper.get('[data-testid="session-todo-resume-hint"]').text();
    expect(resume).toContain("这 2 项");
    expect(resume).toContain("延续");
    expect(resume).toContain("不会重做");
  });

  it("仍在生成时不出现「接着跑」那条提示：这一轮还没结束，不提前下结论", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(snapshot(3, threeItems))));
    const mounted = await mountReact(
      <SessionTodoList client={client} sessionId={sessionId} active />);
    unmount = mounted.unmount;
    await flush();
    const wrapper = mounted.wrapper;
    wrapper.get('[data-testid="session-todo-list"]').element?.setAttribute("open", "");
    expect(wrapper.find('[data-testid="session-todo-resume-hint"]').exists()).toBe(false);
  });

  it("迟到的旧版本不回退视图，换轮次时接受重置后的版本", () => {
    const older = { sessionId, scopeKey: "turn:a", version: 2, items: [], inProgressLimit: 1,
      updatedAt: "2026-10-30T09:00:00.000Z" };
    const newer = { ...older, version: 4 };
    expect(shouldAccept(newer, older)).toBe(false);
    expect(shouldAccept(older, newer)).toBe(true);
    expect(shouldAccept(older, { ...older, scopeKey: "turn:b", version: 1 })).toBe(true);
    expect(shouldAccept(null, older)).toBe(true);
  });
});
describe("SessionTodoList 请求身份的生命周期（2026-10-31 P0）", () => {
  /**
   * 复现并钉住 P0 缺陷：`applied` 是组件级 ref，而 `issued` 曾经是 Effect 内的局部变量。
   * Effect 因 active / refreshKey 重建后 `issued` 从 1 重新数，`applied` 却停在上一轮的
   * 较大值，重建后的响应因此全部被挡掉——生成结束那一刻的最终读取永远落不了地。
   * 这些用例只在轮询间隔被压到 5ms 时成立，不改变生产时序。
   */
  const fastPoll = { pollIntervalMs: 5 } as const;

  it("三次成功轮询后生成结束：最后一次读取仍然更新视图", async () => {
    let call = 0;
    // 版本随调用递增：每次读取都比上一次新，视图必须一路跟到最新一版。
    vi.stubGlobal("fetch", vi.fn(async () => {
      call += 1;
      return json(snapshot(call, [{ content: `第 ${call} 版步骤`, status: "in_progress" }]));
    }));
    const mounted = await mountReact(
      <SessionTodoList client={client} sessionId={sessionId} active {...fastPoll} />);
    unmount = mounted.unmount;
    await flush(60);
    expect(call).toBeGreaterThanOrEqual(3);
    const polled = mounted.wrapper.get('[data-testid="session-todo-list"]')
      .attributes("data-session-todo-version");
    expect(Number(polled)).toBe(call);

    // 生成结束：Effect 重建并做最后一次读取。此时序号必须继续递增，
    // 否则（修复前）这一次响应会被先前发出的序号挡掉，界面停在停止前那一版。
    await mounted.rerender(
      <SessionTodoList client={client} sessionId={sessionId} active={false} {...fastPoll} />);
    await flush(30);
    const finalVersion = mounted.wrapper.get('[data-testid="session-todo-list"]')
      .attributes("data-session-todo-version");
    expect(Number(finalVersion)).toBe(call);
    expect(Number(finalVersion)).toBeGreaterThan(Number(polled) - 1);
    expect(mounted.wrapper.text()).toContain(`第 ${call} 版步骤`);
  });

  it("轮询已经发出多次后 refreshKey 改变：新结果仍然更新视图", async () => {
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      call += 1;
      return json(snapshot(call, [{ content: `第 ${call} 版步骤`, status: "pending" }]));
    }));
    const mounted = await mountReact(
      <SessionTodoList client={client} sessionId={sessionId} active refreshKey="1" {...fastPoll} />);
    unmount = mounted.unmount;
    await flush(60);
    expect(call).toBeGreaterThanOrEqual(3);

    await mounted.rerender(
      <SessionTodoList client={client} sessionId={sessionId} active={false} refreshKey="2" {...fastPoll} />);
    await flush(30);
    expect(mounted.wrapper.get('[data-testid="session-todo-list"]')
      .attributes("data-session-todo-version")).toBe(String(call));
  });

  it("上一轮读取迟到：旧快照不覆盖已经落地的新快照", async () => {
    const slow: { resolve?: (value: Response) => void } = {};
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(() => {
      call += 1;
      if (call === 1) return new Promise<Response>((resolve) => { slow.resolve = resolve; });
      return Promise.resolve(json(snapshot(9, [{ content: "新快照的步骤", status: "in_progress" }])));
    }));
    const mounted = await mountReact(
      <SessionTodoList client={client} sessionId={sessionId} active refreshKey="1" {...fastPoll} />);
    unmount = mounted.unmount;
    // 第一次读取还没回来，外部事实变化触发重读：第二次直接拿到 v9。
    await mounted.rerender(
      <SessionTodoList client={client} sessionId={sessionId} active refreshKey="2" {...fastPoll} />);
    await flush(30);
    expect(mounted.wrapper.get('[data-testid="session-todo-list"]')
      .attributes("data-session-todo-version")).toBe("9");

    // 上一轮那次读取此刻才到（v7）：序号更早、版本更旧，两条闸门都不得放它进来。
    slow.resolve?.(json(snapshot(7, [{ content: "旧快照的步骤", status: "pending" }])));
    await flush(30);
    expect(mounted.wrapper.get('[data-testid="session-todo-list"]')
      .attributes("data-session-todo-version")).toBe("9");
    expect(mounted.wrapper.text()).toContain("新快照的步骤");
    expect(mounted.wrapper.text()).not.toContain("旧快照的步骤");
  });

  it("卸载后到达的响应不再改视图", async () => {
    const slow: { resolve?: (value: Response) => void } = {};
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { slow.resolve = resolve; })));
    const mounted = await mountReact(
      <SessionTodoList client={client} sessionId={sessionId} active {...fastPoll} />);
    await flush(20);
    mounted.unmount();
    slow.resolve?.(json(snapshot(3, threeItems)));
    // 卸载后不得再有渲染；能走到这里说明没有未捕获异常。
    expect(mounted.wrapper.find('[data-testid="session-todo-list"]').exists()).toBe(false);
  });
});

describe("SessionTodoList 轮次切换与迟到响应", () => {
  it("切到新任务、服务端返回空快照时，上一轮清单从视图消失", async () => {
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      call += 1;
      return call === 1 ? json(snapshot(7, threeItems)) : json({ snapshot: null });
    }));
    const mounted = await mountReact(
      <SessionTodoList client={client} sessionId={sessionId} refreshKey="1" />);
    unmount = mounted.unmount;
    await flush();
    expect(mounted.wrapper.find('[data-testid="session-todo-list"]').exists()).toBe(true);

    await mounted.rerender(
      <SessionTodoList client={client} sessionId={sessionId} refreshKey="2" />);
    await flush();
    expect(call).toBe(2);
    expect(mounted.wrapper.find('[data-testid="session-todo-list"]').exists()).toBe(false);
  });

  it("读失败保留已有清单，不把读失败渲染成没有待办", async () => {
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      call += 1;
      if (call === 1) return json(snapshot(7, threeItems));
      throw new Error("network down");
    }));
    const mounted = await mountReact(
      <SessionTodoList client={client} sessionId={sessionId} refreshKey="1" />);
    unmount = mounted.unmount;
    await flush();
    await mounted.rerender(
      <SessionTodoList client={client} sessionId={sessionId} refreshKey="2" />);
    await flush();
    const list = mounted.wrapper.find('[data-testid="session-todo-list"]');
    expect(list.exists()).toBe(true);
    expect(list.text()).toContain("实现 todo_write");
  });

  it("迟到的旧响应不把已经清掉的清单拉回来", async () => {
    const slow: { resolve?: (value: Response) => void } = {};
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(() => {
      call += 1;
      if (call === 1) {
        return new Promise<Response>((resolve) => { slow.resolve = resolve; });
      }
      return Promise.resolve(json({ snapshot: null }));
    }));
    const mounted = await mountReact(
      <SessionTodoList client={client} sessionId={sessionId} refreshKey="1" />);
    unmount = mounted.unmount;
    await mounted.rerender(
      <SessionTodoList client={client} sessionId={sessionId} refreshKey="2" />);
    await flush();
    expect(mounted.wrapper.find('[data-testid="session-todo-list"]').exists()).toBe(false);
    slow.resolve?.(json(snapshot(7, threeItems)));
    await flush();
    expect(mounted.wrapper.find('[data-testid="session-todo-list"]').exists()).toBe(false);
  });
});
describe("SessionTodoList 完成度条与脚注层级（2026-10-31 UI 收口）", () => {
  it("完成度条按已完成比例给宽度，并随快照更新", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(snapshot(2, threeItems))));
    const wrapper = await mount();
    const bar = wrapper.get(".session-todos-progress");
    // threeItems：1 完成 / 3 项 → 33%。它只描述进度，所以不带文字与图例。
    expect((bar.element as HTMLElement).style.getPropertyValue("--session-todos-ratio"))
      .toBe("33%");
    expect(bar.text()).toBe("");
    expect(bar.attributes("aria-hidden")).toBe("true");
  });

  it("全部完成时条满格；没有快照时整块不渲染，也不留空条", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(snapshot(3, [
      { content: "第一步", status: "completed" },
      { content: "第二步", status: "completed" },
    ]))));
    const wrapper = await mount();
    expect((wrapper.get(".session-todos-progress").element as HTMLElement)
      .style.getPropertyValue("--session-todos-ratio")).toBe("100%");
  });

  it("没有清单时既不留面板也不留完成度条", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ snapshot: null })));
    const wrapper = await mount();
    expect(wrapper.find(".session-todos-progress").exists()).toBe(false);
  });

  it("脚注分两层：版本与免责一行、换任务写法一行，写法用行内代码", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(snapshot(7, threeItems))));
    const wrapper = await mount();
    const version = wrapper.get('[data-testid="session-todo-version-note"]');
    expect(version.text()).toContain("第 7 版");
    expect(version.text()).toContain("不代表执行结果或验收结论");
    const hint = wrapper.get('[data-testid="session-todo-new-task-hint"]');
    expect(hint.text()).toContain("换新任务时");
    // 要照抄的写法必须能一眼认出来：两枚行内代码，而不是埋在句子里。
    const codes = hint.findAll("code");
    expect(codes.map((code) => code.text())).toEqual(["新任务：", "/newtask"]);
  });
});
