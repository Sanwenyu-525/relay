import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import ResizableHandle from "../src/ui/ResizableHandle";
import ContextMenu from "../src/ui/ContextMenu";
import Tooltip from "../src/ui/Tooltip";

/**
 * 浮层与拖拽基础件的行为契约（UI-UNIFY-02）。
 *
 * 这里断言的是键盘/焦点/提交语义，不测像素；像素与定位归 Playwright。
 */

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(node: React.ReactNode): HTMLDivElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => { root?.render(node); });
  return container;
}

function press(element: Element | Document, key: string) {
  act(() => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

function pointer(element: HTMLElement, type: string, clientX: number, pointerId = 1) {
  const event = new MouseEvent(type, { button: 0, clientX, bubbles: true, cancelable: true });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  act(() => { element.dispatchEvent(event); });
}

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  container = null;
  root = null;
  document.querySelectorAll(".ui-menu__panel, .ui-tooltip").forEach((node) => node.remove());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ContextMenu", () => {
  it("右键打开菜单并把焦点送到第一项；方向键移动，Enter 选择后关闭并归还焦点", () => {
    const onSelect = vi.fn();
    const host = mount(<div>
      <button type="button" data-testid="outside">外部</button>
      <ContextMenu
        label="会话操作"
        items={[
          { key: "rename", label: "重命名", onSelect },
          { separator: true },
          { key: "delete", label: "删除", danger: true }
        ]}
      >
        <span data-testid="row">会话行</span>
      </ContextMenu>
    </div>);

    const outside = host.querySelector<HTMLButtonElement>('[data-testid="outside"]')!;
    const row = host.querySelector<HTMLElement>('[data-testid="row"]')!;
    outside.focus();

    act(() => {
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }));
    });
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu).not.toBeNull();
    expect(menu.getAttribute("aria-label")).toBe("会话操作");
    expect(menu.querySelectorAll('[role="menuitem"]')).toHaveLength(2);
    expect(menu.querySelector('[role="separator"]')).not.toBeNull();

    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    expect(document.activeElement).toBe(items[0]);

    press(items[0]!, "ArrowDown");
    expect(document.activeElement).toBe(items[1]);
    press(items[1]!, "ArrowUp");
    expect(document.activeElement).toBe(items[0]);

    press(items[0]!, "Enter");
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    // 右键目标不可聚焦；收起后必须回到打开前的活动元素，否则键盘用户落在文档开头。
    expect(document.activeElement).toBe(outside);
  });

  it("Esc 收起；禁用项不可聚焦；点外面关闭且不抢焦点", () => {
    const host = mount(<ContextMenu
      label="更多操作"
      items={[{ key: "a", label: "可用", onSelect: () => undefined }, { key: "b", label: "不可用", disabled: true }]}
    >
      <span data-testid="row">行</span>
    </ContextMenu>);
    const row = host.querySelector<HTMLElement>('[data-testid="row"]')!;

    act(() => { row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu.querySelectorAll('[role="menuitem"]:not(:disabled)')).toHaveLength(1);
    press(menu, "Escape");
    expect(document.querySelector('[role="menu"]')).toBeNull();

    act(() => { row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    act(() => { document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("disabled 时保留浏览器原生菜单，不打开自定义菜单", () => {
    const host = mount(<ContextMenu label="只读" disabled items={[{ key: "a", label: "动作" }]}>
      <span data-testid="row">只读行</span>
    </ContextMenu>);
    const row = host.querySelector<HTMLElement>('[data-testid="row"]')!;
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    act(() => { row.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(false);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});

describe("Tooltip", () => {
  it("键盘聚焦立即显示、Esc 收起、失焦收起，并挂上 aria-describedby", () => {
    vi.useFakeTimers();
    const host = mount(<Tooltip label="保存到本机"><button type="button">保存</button></Tooltip>);
    const trigger = host.querySelector<HTMLButtonElement>("button")!;

    act(() => { trigger.focus(); });
    const bubble = document.querySelector<HTMLElement>('[role="tooltip"]')!;
    expect(bubble).not.toBeNull();
    expect(bubble.textContent).toBe("保存到本机");
    expect(trigger.getAttribute("aria-describedby")).toBe(bubble.id);

    press(document, "Escape");
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(trigger.hasAttribute("aria-describedby")).toBe(false);

    // Esc 只收起气泡、不移走焦点；再次聚焦前先失焦，模拟用户真的离开再回来。
    act(() => { trigger.blur(); });
    act(() => { trigger.focus(); });
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    act(() => { trigger.blur(); });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it("鼠标悬停按延迟显示，移出立即收起", () => {
    vi.useFakeTimers();
    const host = mount(<Tooltip label="提示" delay={200}><button type="button">触发</button></Tooltip>);
    const trigger = host.querySelector<HTMLButtonElement>("button")!;

    act(() => { trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    act(() => { vi.advanceTimersByTime(200); });
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();

    act(() => { trigger.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })); });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });
});

describe("ResizableHandle", () => {
  it("direction=1 向右变宽；抬手提交拖动后的宽度，即使父级没有回写 value", () => {
    const onChange = vi.fn();
    const host = mount(<ResizableHandle
      label="调整侧栏宽度"
      testId="handle"
      value={200}
      min={160}
      max={320}
      step={16}
      direction={1}
      onChange={onChange}
    />);
    const handle = host.querySelector<HTMLButtonElement>('[data-testid="handle"]')!;
    expect(handle.getAttribute("role")).toBe("separator");
    expect(handle.getAttribute("aria-valuenow")).toBe("200");

    pointer(handle, "pointerdown", 500);
    pointer(handle, "pointermove", 560);
    expect(onChange).toHaveBeenLastCalledWith(260, false);
    // 父级没有重渲染（value 仍是 200）：抬手必须提交 260，而不是渲染期的 200。
    pointer(handle, "pointerup", 560);
    expect(onChange).toHaveBeenLastCalledWith(260, true);
  });

  it("direction=-1 向左变宽并钳制；方向键步进忽略 IME；双击复位", () => {
    const onChange = vi.fn();
    const host = mount(<ResizableHandle
      label="调整工作详情宽度"
      testId="handle"
      value={400}
      min={320}
      max={640}
      step={16}
      direction={-1}
      onChange={onChange}
    />);
    const handle = host.querySelector<HTMLButtonElement>('[data-testid="handle"]')!;

    pointer(handle, "pointerdown", 500);
    pointer(handle, "pointermove", 400);
    pointer(handle, "pointerup", 400);
    expect(onChange).toHaveBeenLastCalledWith(500, true);

    pointer(handle, "pointerdown", 500);
    pointer(handle, "pointermove", 5000);
    pointer(handle, "pointerup", 5000);
    expect(onChange).toHaveBeenLastCalledWith(320, true);

    act(() => { handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", isComposing: true, bubbles: true })); });
    expect(onChange).toHaveBeenCalledTimes(4);
    press(handle, "ArrowLeft");
    expect(onChange).toHaveBeenLastCalledWith(416, true);
    press(handle, "ArrowRight");
    expect(onChange).toHaveBeenLastCalledWith(384, true);

    act(() => { handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(onChange).toHaveBeenLastCalledWith(null, true);
  });
});
