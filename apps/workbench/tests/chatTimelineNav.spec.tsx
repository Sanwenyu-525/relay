import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import ChatTimelineNav, { chatTimelineNodes, chatTimelineTickWidth } from "../src/components/ChatTimelineNav";
import type { RelayAssistMessage } from "../src/api/relayClient";
import { flush, mountReact } from "./mountApp";

/**
 * 聊天消息时间线导航的组件级验证（工作台 §31、测试计划 §32）。
 *
 * jsdom 没有排版引擎，因此这里用可控几何核对**身份与算术**：节点绑哪条消息、
 * 跳转算到哪个偏移、当前刻度随滚动落到谁、悬停联动的刻度长度按距离怎么变。真实浮层位置、
 * 顶栏遮挡、命中区是否重叠、窄档降级与阅读保护由 tests/browser/chatTimelineNavigation.spec.ts
 * 在 Chromium 里核对；真实 Windows 窗口与 DPI 仍未验证。
 */

const SESSION = "66666666-6666-4666-8666-666666666666";
const OWNER_TOP = 100;
const CLIENT_HEIGHT = 400;
/** 与组件同源的读区上沿呼吸位：space.2 = 0.5rem × 16。 */
const INSET = 8;

type Slot = { readonly id: string; readonly top: number; readonly session?: string };

function makeOwner(slots: readonly Slot[], scrollHeight = 4000) {
  const owner = document.createElement("div");
  let scrollTop = 0;
  Object.defineProperty(owner, "scrollTop", { configurable: true,
    get: () => scrollTop,
    set: (value: number) => { scrollTop = Math.max(0, Math.min(value, scrollHeight - CLIENT_HEIGHT)); } });
  Object.defineProperty(owner, "clientHeight", { configurable: true, value: CLIENT_HEIGHT });
  Object.defineProperty(owner, "scrollHeight", { configurable: true, value: scrollHeight });
  owner.getBoundingClientRect = () => rect(OWNER_TOP, CLIENT_HEIGHT);
  for (const slot of slots) {
    const element = document.createElement("li");
    element.className = "agent-message-slot";
    element.setAttribute("data-chat-timeline-slot", "true");
    element.setAttribute("data-timeline-session", slot.session ?? SESSION);
    element.setAttribute("data-message-id", slot.id);
    element.getBoundingClientRect = () => rect(OWNER_TOP + slot.top - scrollTop, 60);
    owner.append(element);
  }
  return owner;
}

function rect(top: number, height: number): DOMRect {
  return { top, bottom: top + height, left: 0, right: 600, width: 600, height,
    x: 0, y: top, toJSON: () => "" } as DOMRect;
}

async function scrollBy(owner: HTMLElement, value: number): Promise<void> {
  await act(async () => {
    owner.scrollTop = value;
    owner.dispatchEvent(new Event("scroll"));
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  });
}

function user(id: string, content: string | null): RelayAssistMessage {
  return { id, sessionId: SESSION, seq: "1", role: "USER", status: "COMPLETED",
    createdAt: "2026-10-16T00:00:00Z", updatedAt: "2026-10-16T00:00:00Z",
    intent: "DISCUSS", content, errorCode: null,
    providerErrorKind: null, sources: [], skill: null, skillInput: null, skillOutput: null,
    usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null,
      cacheCreationTokens: null }, cancelRequested: false, steerRequested: false, attachments: [] };
}
function assistant(id: string, content: string | null, status: RelayAssistMessage["status"] = "COMPLETED"): RelayAssistMessage {
  return { ...user(id, content), role: "ASSISTANT", status };
}

const LONG = "开头问题".repeat(40); // 160 字，超过标题档
const REPLY = "助手回复".repeat(80); // 320 字，超过摘要档

/** 三条提问：第 1、3 条文字完全相同，用来核对重复内容不串位。 */
const messages: readonly RelayAssistMessage[] = [
  user("m-1", "第一段讨论"),
  assistant("a-1", REPLY),
  user("m-2", "第二段讨论"),
  user("m-3", "第一段讨论"),
  assistant("a-2", null, "RUNNING")];

const slots: readonly Slot[] = [{ id: "m-1", top: 0 }, { id: "a-1", top: 120 }, { id: "m-2", top: 900 },
  { id: "m-3", top: 1600 }, { id: "a-2", top: 2200 }];

const mountedViews: { unmount: () => void }[] = [];

afterEach(() => {
  while (mountedViews.length > 0) mountedViews.pop()?.unmount();
  document.body.innerHTML = "";
});

async function open(owner: HTMLElement, rows: readonly RelayAssistMessage[] = messages,
  sessionId = SESSION) {
  const view = await mountReact(<ChatTimelineNav sessionId={sessionId} messages={rows}
    getScrollOwner={() => owner} />);
  mountedViews.push(view);
  await flush();
  return view;
}

function nodeButton(testId: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (element === null) throw new Error(`timeline node not found: ${testId}\n${document.body.innerHTML.slice(0, 800)}`);
  return element;
}

describe("时间线节点身份", () => {
  it("只为用户消息建节点，正文不可读时不伪造", () => {
    expect(chatTimelineNodes(messages).map((node) => node.messageId)).toEqual(["m-1", "m-2", "m-3"]);
    expect(chatTimelineNodes([user("m-x", null), user("m-y", "   ")])).toEqual([]);
  });

  it("节点按消息 ID 绑定，重复文本与 RUNNING 回复不改变身份", async () => {
    const owner = makeOwner(slots);
    await open(owner);
    expect(document.querySelectorAll(".agent-chat-timeline-node")).toHaveLength(3);
    expect(document.querySelector('[data-testid="chat-timeline-node-m-1"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="chat-timeline-node-m-3"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="chat-timeline-node-a-1"]')).toBeNull();
    // 两条同文字提问的序号不同，标签也不同，但定位只认 ID。
    expect(nodeButton("chat-timeline-node-m-1").getAttribute("aria-label")).toContain("第 1 条提问：第一段讨论");
    expect(nodeButton("chat-timeline-node-m-3").getAttribute("aria-label")).toContain("第 3 条提问：第一段讨论");
    // a-2 还在 RUNNING 且没有正文：这一轮只显示已有内容。
    expect(chatTimelineNodes(messages)[2]?.reply).toBeNull();
    owner.remove();
  });

  it("流式更新只改原节点摘要，不另建身份", async () => {
    const owner = makeOwner(slots);
    const view = await open(owner);
    expect(document.querySelectorAll(".agent-chat-timeline-node")).toHaveLength(3);
    const streamed = [...messages.slice(0, 4), assistant("a-2", "生成中的前半句")];
    await act(async () => { view.rerender(<ChatTimelineNav sessionId={SESSION} messages={streamed}
      getScrollOwner={() => owner} />); });
    await flush();
    expect(document.querySelectorAll(".agent-chat-timeline-node")).toHaveLength(3);
    await act(async () => { nodeButton("chat-timeline-node-m-3").dispatchEvent(new PointerEvent("pointerover", { bubbles: true })); });
    expect(document.querySelector('[data-testid="chat-timeline-preview-body"]')?.textContent)
      .toContain("生成中的前半句");
    owner.remove();
  });

  it("空会话与未加载完不渲染轨道", async () => {
    const owner = makeOwner([]);
    const view = await open(owner, []);
    expect(document.querySelector('[data-testid="chat-timeline"]')).toBeNull();
    await act(async () => { view.rerender(<ChatTimelineNav sessionId={SESSION} messages={[]}
      getScrollOwner={() => owner} />); });
    expect(document.querySelector('[data-testid="chat-timeline-rail"]')).toBeNull();
    owner.remove();
  });
});

describe("点击定位", () => {
  it("首/中/末节点各自滚到该消息开头并避开读区上沿", async () => {
    const owner = makeOwner(slots);
    await open(owner);
    for (const [id, top] of [["m-1", 0], ["m-2", 900], ["m-3", 1600]] as const) {
      await act(async () => { nodeButton(`chat-timeline-node-${id}`).click(); });
      expect(owner.scrollTop).toBe(Math.max(0, top - INSET));
      // 强调只落在被点的那条，重复文本不串位。
      const marked = Array.from(owner.querySelectorAll("[data-chat-timeline-target]"));
      expect(marked).toHaveLength(1);
      expect(marked[0]?.getAttribute("data-message-id")).toBe(id);
      await scrollBy(owner, top);
    }
    owner.remove();
  });

  it("连续点击以最后一次有效目标为准", async () => {
    const owner = makeOwner(slots);
    await open(owner);
    await act(async () => { nodeButton("chat-timeline-node-m-1").click(); });
    await act(async () => { nodeButton("chat-timeline-node-m-3").click(); });
    expect(owner.scrollTop).toBe(1600 - INSET);
    await act(async () => { nodeButton("chat-timeline-node-m-2").click(); });
    expect(owner.scrollTop).toBe(900 - INSET);
    owner.remove();
  });

  it("目标不在已加载消息流里时就地提示，不跳到相邻消息", async () => {
    const owner = makeOwner(slots.filter((slot) => slot.id !== "m-2"));
    await open(owner);
    await scrollBy(owner, 500);
    await act(async () => { nodeButton("chat-timeline-node-m-2").click(); });
    expect(owner.scrollTop).toBe(500);
    const notice = document.querySelector('[data-testid="chat-timeline-notice"]');
    expect(notice?.textContent).toContain("不");
    expect(notice?.getAttribute("role")).toBe("alert");
    expect(owner.querySelector("[data-chat-timeline-target]")).toBeNull();
    owner.remove();
  });

  it("迟到的另一会话槽位不能被当成目标：身份核对包含会话", async () => {
    const owner = makeOwner([{ id: "m-1", top: 0, session: "other-session" }]);
    await open(owner);
    await act(async () => { nodeButton("chat-timeline-node-m-1").click(); });
    expect(owner.scrollTop).toBe(0);
    expect(document.querySelector('[data-testid="chat-timeline-notice"]')).not.toBeNull();
    owner.remove();
  });
});

describe("预览与键盘", () => {
  it("悬停显示原文片段并明确截断，内容按文本呈现", async () => {
    const owner = makeOwner(slots);
    await open(owner, [user("m-1", LONG), assistant("a-1", REPLY)]);
    await act(async () => { nodeButton("chat-timeline-node-m-1").dispatchEvent(new PointerEvent("pointerover", { bubbles: true })); });
    const preview = document.querySelector('[data-testid="chat-timeline-preview"]');
    expect(preview?.getAttribute("role")).toBe("tooltip");
    const title = document.querySelector('[data-testid="chat-timeline-preview-title"]')?.textContent ?? "";
    const body = document.querySelector('[data-testid="chat-timeline-preview-body"]')?.textContent ?? "";
    expect(title.length).toBe(49); // 48 字 + 省略号
    expect(title.endsWith("…")).toBe(true);
    expect(body.length).toBe(161);
    expect(preview?.querySelector("img")).toBeNull();
    expect(document.querySelector('[data-testid="chat-timeline-notice"]')).toBeNull();
    // 预览不自动跳转、不滚正文
    expect(owner.scrollTop).toBe(0);
    owner.remove();
  });

  it("尖括号与脚本按文本渲染，不成为节点", async () => {
    const owner = makeOwner(slots);
    await open(owner, [user("m-1", '<img src=x onerror="alert(1)"> 这段要原样显示')]);
    await act(async () => { nodeButton("chat-timeline-node-m-1").focus(); });
    expect(document.querySelector('[data-testid="chat-timeline-preview"] img')).toBeNull();
    expect(document.querySelector('[data-testid="chat-timeline-preview-title"]')?.textContent)
      .toContain("<img src=x onerror=\"alert(1)\">");
    owner.remove();
  });

  it("键盘聚焦显示预览、Enter/Space 跳转，Esc 只关预览不落到面板停止序列", async () => {
    const owner = makeOwner(slots);
    const panelEscapes = { value: 0 };
    const view = await mountReact(<section onKeyDown={() => { panelEscapes.value += 1; }}>
      <ChatTimelineNav sessionId={SESSION} messages={messages} getScrollOwner={() => owner} />
    </section>);
    mountedViews.push(view);
    await flush();
    const node = nodeButton("chat-timeline-node-m-2");
    await act(async () => { node.focus(); });
    expect(document.querySelector('[data-testid="chat-timeline-preview"]')).not.toBeNull();
    expect(owner.scrollTop).toBe(0); // 聚焦只预览，不跳转
    // Chromium 里 Enter/Space 由 button 原生激活为 click；jsdom 不代跑这一步，因此显式点击。
    await act(async () => { node.click(); });
    expect(owner.scrollTop).toBe(900 - INSET);
    // 跳转本身收起浮层：指针/焦点都还在同一条刻度上，不重开就没有 Esc 可关的东西。
    expect(document.querySelector('[data-testid="chat-timeline-preview"]')).toBeNull();
    await act(async () => { node.blur(); });
    await act(async () => { node.focus(); });
    expect(document.querySelector('[data-testid="chat-timeline-preview"]')).not.toBeNull();
    await act(async () => {
      node.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(document.querySelector('[data-testid="chat-timeline-preview"]')).toBeNull();
    expect(panelEscapes.value).toBe(0);
    // 预览已关：同样按 Esc 不再由时间线消费，面板的 Esc Esc 停止序列照旧收得到。
    await act(async () => {
      node.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(panelEscapes.value).toBe(1);
    owner.remove();
  });

  it("方向键与 Home/End 在刻度间移动焦点：只带上预览，不代劳跳转", async () => {
    const owner = makeOwner(slots);
    await open(owner);
    const first = nodeButton("chat-timeline-node-m-1");
    await act(async () => { first.focus(); });
    await act(async () => {
      first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    });
    // 焦点落到下一条，其 focus 行为自带预览：与悬停、Tab 聚焦同一份呈现
    expect(document.activeElement).toBe(nodeButton("chat-timeline-node-m-2"));
    expect(document.querySelector('[data-testid="chat-timeline-preview-title"]')?.textContent)
      .toContain("第二段讨论");
    expect(owner.scrollTop).toBe(0); // 漫移只预览，不跳转
    // Home/End 直达两端；末条再向下回绕到首条，与横向页签的两端循环一致
    await act(async () => {
      nodeButton("chat-timeline-node-m-2").dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(nodeButton("chat-timeline-node-m-3"));
    await act(async () => {
      nodeButton("chat-timeline-node-m-3").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(first);
    await act(async () => {
      first.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(first);
    // 焦点不在任何刻度上时方向键静默不动：Tab 进入列表的既有语义不变
    await act(async () => { first.blur(); });
    await act(async () => {
      document.querySelector('[data-testid="chat-timeline-rail"]')!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(document.body);
    owner.remove();
  });

  it("焦点离开或指针移出轨道后预览关闭", async () => {
    const owner = makeOwner(slots);
    await open(owner);
    const node = nodeButton("chat-timeline-node-m-1");
    await act(async () => { node.focus(); });
    expect(document.querySelector('[data-testid="chat-timeline-preview"]')).not.toBeNull();
    await act(async () => { node.dispatchEvent(new Event("focusout", { bubbles: true })); });
    expect(document.querySelector('[data-testid="chat-timeline-preview"]')).toBeNull();
    owner.remove();
  });
});

describe("当前刻度跟随阅读位置", () => {
  it("手动滚动更新 aria-current，而不是只记住最后点击的节点", async () => {
    const owner = makeOwner(slots);
    await open(owner);
    await act(async () => { nodeButton("chat-timeline-node-m-2").click(); });
    expect(nodeButton("chat-timeline-node-m-2").getAttribute("aria-current")).toBe("true");
    await scrollBy(owner, 100); // 手动滚回 m-1 与 m-2 之间
    expect(nodeButton("chat-timeline-node-m-1").getAttribute("aria-current")).toBe("true");
    expect(nodeButton("chat-timeline-node-m-2").hasAttribute("aria-current")).toBe(false);
    await scrollBy(owner, 3600); // 贴底：最后一条提问就是当前位置
    expect(nodeButton("chat-timeline-node-m-3").getAttribute("aria-current")).toBe("true");
    owner.remove();
  });

  it("内容撑高后重新核对当前位置，但不反向推动正文", async () => {
    const owner = makeOwner(slots);
    await open(owner);
    await scrollBy(owner, 1000);
    const before = owner.scrollTop;
    await act(async () => { owner.dispatchEvent(new Event("scroll")); });
    expect(owner.scrollTop).toBe(before);
    expect(nodeButton("chat-timeline-node-m-2").getAttribute("aria-current")).toBe("true");
    owner.remove();
  });

  it("连续点击只强调最后一条，提前卸载不留下落点强调", async () => {
    const owner = makeOwner(slots);
    const view = await open(owner);
    await act(async () => { nodeButton("chat-timeline-node-m-1").click(); });
    await act(async () => { nodeButton("chat-timeline-node-m-3").click(); });
    expect(owner.querySelectorAll("[data-chat-timeline-target]")).toHaveLength(1);
    expect(nodeButton("chat-timeline-node-m-3").getAttribute("aria-current")).toBe("true");
    act(() => { view.unmount(); });
    mountedViews.splice(mountedViews.indexOf(view), 1);
    expect(owner.querySelector("[data-chat-timeline-target]")).toBeNull();
    owner.remove();
  });
});

/** jsdom 没有排版：给刻度装上可控几何，一格间距 = 24px（control.target.minimum）。 */
function stubNodeGeometry(rail: HTMLElement): readonly HTMLElement[] {
  const nodes = Array.from(rail.querySelectorAll<HTMLElement>(".agent-chat-timeline-node"));
  nodes.forEach((node, index) => { node.getBoundingClientRect = () => rect(index * 24, 24); });
  return nodes;
}

/** 指针移进轨道并等联动帧结算：写长度走 rAF 节流，不能只看 dispatch 是否同步生效。 */
async function hoverRail(rail: HTMLElement, clientY: number, pointerType = "mouse"): Promise<void> {
  await act(async () => {
    rail.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType, clientY }));
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  });
}

function tickWidth(node: HTMLElement): string {
  return node.style.getPropertyValue("--chat-timeline-tick-width");
}

describe("悬停联动：刻度长度随指针距离变化", () => {
  // 与组件同源的 token 组合：space.2 = 8、space.4 = 16、control.target.minimum = 24、space.1 = 4。
  const BASE = 8;
  const PEAK = 20;
  const RADIUS = 72;

  it("峰值在指针处、向外二次衰减，超出半径与非法距离回到基准", () => {
    expect(chatTimelineTickWidth(0)).toBeCloseTo(PEAK, 5);
    expect(chatTimelineTickWidth(RADIUS)).toBeCloseTo(BASE, 5);
    expect(chatTimelineTickWidth(RADIUS * 4)).toBeCloseTo(BASE, 5);
    expect(chatTimelineTickWidth(Number.NaN)).toBeCloseTo(BASE, 5);
    expect(chatTimelineTickWidth(-1)).toBeCloseTo(PEAK, 5);
    let previous = PEAK;
    for (const distance of [0, 12, 24, 36, 48, 60, 72]) {
      const width = chatTimelineTickWidth(distance);
      expect(width).toBeLessThanOrEqual(previous + 1e-9);
      expect(width).toBeGreaterThanOrEqual(BASE - 1e-9);
      previous = width;
    }
    // 衰减到半程仍高于基准：相邻刻度分得出档次，不是一离开指针就掉回默认。
    expect(chatTimelineTickWidth(RADIUS / 2)).toBeGreaterThan(BASE + 2);
  });

  it("指针在轨道内按距离写长度：峰值随指针移动，当前位置不短于默认档", async () => {
    const owner = makeOwner(slots);
    await open(owner);
    const railElement = document.querySelector<HTMLElement>('[data-testid="chat-timeline-rail"]');
    if (railElement === null) throw new Error("timeline rail not found");
    const nodes = stubNodeGeometry(railElement);
    await scrollBy(owner, 900); // m-2 成为当前刻度：默认档 16px，比普通刻度长。
    expect(nodeButton("chat-timeline-node-m-2").getAttribute("aria-current")).toBe("true");

    await hoverRail(railElement, 60); // 对准第三条刻度中心（2 × 24 + 12）
    expect(railElement.getAttribute("data-tracking")).toBe("true");
    expect(tickWidth(nodes[2]!)).toBe(`${PEAK}px`);
    expect(tickWidth(nodes[1]!)).toBe("16px"); // 联动值 13.33 低于当前位置档，取 16 不压短
    expect(tickWidth(nodes[0]!)).toBe("9.33px"); // 距离 48px：8 + 12 × (1/3)²
    expect(Number.parseFloat(tickWidth(nodes[2]!)))
      .toBeGreaterThan(Number.parseFloat(tickWidth(nodes[1]!)));
    expect(Number.parseFloat(tickWidth(nodes[1]!)))
      .toBeGreaterThan(Number.parseFloat(tickWidth(nodes[0]!)));

    await hoverRail(railElement, 12); // 指针上移一格，峰值跟着走
    expect(tickWidth(nodes[0]!)).toBe(`${PEAK}px`);
    expect(tickWidth(nodes[1]!)).toBe("16px");
    expect(tickWidth(nodes[2]!)).toBe("9.33px");
    owner.remove();
  });

  it("指针移出轨道后清空内联长度，回落各自默认档", async () => {
    const owner = makeOwner(slots);
    await open(owner);
    const railElement = document.querySelector<HTMLElement>('[data-testid="chat-timeline-rail"]');
    if (railElement === null) throw new Error("timeline rail not found");
    const nodes = stubNodeGeometry(railElement);
    await hoverRail(railElement, 60);
    expect(railElement.getAttribute("data-tracking")).toBe("true");
    await act(async () => {
      railElement.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse" }));
    });
    expect(railElement.hasAttribute("data-tracking")).toBe(false);
    expect(nodes.map((node) => tickWidth(node))).toEqual(["", "", ""]);
    owner.remove();
  });

  it("触屏点按不进入联动，避免抬起后残留波形", async () => {
    const owner = makeOwner(slots);
    await open(owner);
    const railElement = document.querySelector<HTMLElement>('[data-testid="chat-timeline-rail"]');
    if (railElement === null) throw new Error("timeline rail not found");
    const nodes = stubNodeGeometry(railElement);
    await hoverRail(railElement, 60, "touch");
    expect(railElement.hasAttribute("data-tracking")).toBe(false);
    expect(nodes.map((node) => tickWidth(node))).toEqual(["", "", ""]);
    owner.remove();
  });
});
