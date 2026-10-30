import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { RelaySessionToolCall } from "../src/api/dtos/assist";
import ActivityRow from "../src/components/ActivityRow";
import { sessionActivityItem, type ActivityOwner } from "../src/lib/activityPresentation";
import { mountReact } from "./mountApp";

/**
 * 统一活动行（2026-10-29 阶段 B）。
 *
 * 这一层只验「一行里有什么、没有什么」：
 *   * 五个位置固定：图标 · 动作 · 对象 · 状态/耗时 · 展开。
 *   * 状态词永远在文字里，颜色只是辅助——灰度与关动效下信息不丢。
 *   * 没有详情就不摆展开控件（不留点开是空的按钮）。
 *   * 拒绝原因不需要展开就能读到。
 */

const owner: ActivityOwner = {
  kind: "SESSION_MESSAGE", sessionId: "s-1", messageId: "m-1",
};

function call(overrides: Partial<RelaySessionToolCall> = {}): RelaySessionToolCall {
  return {
    id: "c-1", round: 0, ordinal: 0, toolName: "read_file", status: "SETTLED",
    args: { relative_path: "src/components/ActivityRow.tsx" }, rejectionReason: null,
    rejectionDetail: null, requestedAt: "2026-10-29T00:00:00.000Z",
    settledAt: "2026-10-29T00:00:01.250Z", ...overrides,
  };
}

let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; });

async function mount(element: React.ReactElement) {
  const view = await mountReact(element);
  unmount = view.unmount;
  return view;
}

describe("活动行的结构与状态", () => {
  it("图标 · 动作 · 对象 · 状态 · 耗时按固定顺序出现，路径拆成目录与文件名", async () => {
    const { wrapper } = await mount(createElement(ActivityRow, {
      item: sessionActivityItem(call(), owner), testId: "row",
    }));
    const row = wrapper.get('[data-testid="row"]');
    expect(row.attributes("data-category")).toBe("READ");
    expect(row.attributes("data-tone")).toBe("neutral");
    expect(row.find(".activity-item-status").exists()).toBe(true);
    expect(row.find(".activity-item-verb").text()).toBe("读取文件");
    expect(row.find(".activity-item-dir").text()).toBe("src/components/");
    expect(row.find(".activity-item-name").text()).toBe("ActivityRow.tsx");
    expect(row.find(".activity-item-state").text()).toBe("已结算");
    expect(row.find(".activity-item-elapsed").text()).toBe("1.3s");
  });

  it("未结算的行不报耗时，也不给完成样式", async () => {
    const { wrapper } = await mount(createElement(ActivityRow, {
      item: sessionActivityItem(call({ status: "REQUESTED", settledAt: null }), owner), testId: "row",
    }));
    const row = wrapper.get('[data-testid="row"]');
    expect(row.attributes("data-tone")).toBe("active");
    expect(row.find(".activity-item-state").text()).toBe("已请求，尚未结算");
    // 在途没有结算时刻，因此没有耗时——不拿「到现在多久」冒充「花了多久」。
    expect(row.find(".activity-item-elapsed").exists()).toBe(false);
  });

  it("结果未知用例外档，文案里不出现任何成功词", async () => {
    const { wrapper } = await mount(createElement(ActivityRow, {
      item: sessionActivityItem(call({ status: "UNKNOWN", settledAt: null }), owner), testId: "row",
    }));
    const row = wrapper.get('[data-testid="row"]');
    expect(row.attributes("data-tone")).toBe("negative");
    const text = row.text();
    expect(text).toContain("结果未知，需核对");
    expect(text).not.toContain("已结算");
    expect(text).not.toContain("完成");
  });

  it("拒绝原因不需要展开就能读到", async () => {
    const { wrapper } = await mount(createElement(ActivityRow, {
      item: sessionActivityItem(call({ status: "REJECTED", rejectionReason: "OUTSIDE_SCOPE",
        rejectionDetail: "目标不在本次绑定的目录内。" }), owner),
      note: "OUTSIDE_SCOPE · 目标不在本次绑定的目录内。",
      testId: "row",
    }));
    const row = wrapper.get('[data-testid="row"]');
    expect(row.find(".activity-item-note").text()).toContain("目标不在本次绑定的目录内。");
    expect(row.text()).toContain("被拒绝，没有执行");
  });
});

describe("活动行的展开", () => {
  it("没有第三层内容就不摆展开控件", async () => {
    const { wrapper } = await mount(createElement(ActivityRow, {
      item: sessionActivityItem(call(), owner), testId: "row",
    }));
    expect(wrapper.find('[data-testid="row-toggle"]').exists()).toBe(false);
  });

  it("受控展开：开合由调用方决定，组件自己不记住状态", async () => {
    const collapsed = await mount(createElement(ActivityRow, {
      item: sessionActivityItem(call(), owner), detail: createElement("p", null, "参数内容"),
      expanded: false, onToggle: () => undefined, testId: "row",
    }));
    expect(collapsed.wrapper.find('[data-testid="row-detail"]').exists()).toBe(false);
    expect(collapsed.wrapper.get('[data-testid="row-toggle"]').attributes("aria-expanded")).toBe("false");
    collapsed.unmount();
    unmount = null;

    const expanded = await mount(createElement(ActivityRow, {
      item: sessionActivityItem(call(), owner), detail: createElement("p", null, "参数内容"),
      expanded: true, onToggle: () => undefined, testId: "row",
    }));
    expect(expanded.wrapper.get('[data-testid="row-detail"]').text()).toBe("参数内容");
    expect(expanded.wrapper.get('[data-testid="row-toggle"]').attributes("aria-expanded")).toBe("true");
  });

  it("只有 data-current 那一行承担主进度动效", async () => {
    const idle = await mount(createElement(ActivityRow, {
      item: sessionActivityItem(call({ status: "REQUESTED", settledAt: null }), owner), testId: "row",
    }));
    expect(idle.wrapper.get('[data-testid="row"]').attributes("data-current")).toBeUndefined();
    idle.unmount();
    unmount = null;

    const live = await mount(createElement(ActivityRow, {
      item: sessionActivityItem(call({ status: "REQUESTED", settledAt: null }), owner),
      current: true, testId: "row",
    }));
    expect(live.wrapper.get('[data-testid="row"]').attributes("data-current")).toBe("true");
  });
});
