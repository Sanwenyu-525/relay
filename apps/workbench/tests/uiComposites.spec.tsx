import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Card, Combobox, Menu, MenuItem, Popover, Separator, Table, TableBody, TableEmpty, TableHead, TableHeaderCell, TableRow, Tabs } from "../src/ui";
import { Pencil, Trash2 } from "lucide-react";

/**
 * 复合组件的行为契约（UI-UNIFY-02）。
 *
 * 这些组件都在复用既有浮层钩子（lib/popoverMenu），因此测试重点是「钩子的语义仍然成立」：
 * 点外面收起、Esc 收起、选中后关闭、键盘能走到每一项。像素归 Playwright。
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

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  container = null;
  root = null;
  vi.restoreAllMocks();
});

describe("Menu", () => {
  it("渲染 menu 角色、可访问名称，选中后关闭并把焦点还给触发器", () => {
    const onSelect = vi.fn();
    const host = mount(<Menu label="更多操作" trigger={<span>⋯</span>}>
      <MenuItem icon={Pencil} onSelect={onSelect}>重命名</MenuItem>
      <MenuItem icon={Trash2} danger>删除</MenuItem>
    </Menu>);

    const details = host.querySelector("details")!;
    const summary = host.querySelector("summary")!;
    expect(summary.getAttribute("aria-label")).toBe("更多操作");
    expect(host.querySelector("[role=\"menu\"]")?.getAttribute("aria-label")).toBe("更多操作");
    expect(host.querySelectorAll("[role=\"menuitem\"]")).toHaveLength(2);

    details.open = true;
    const first = host.querySelector<HTMLButtonElement>("[role=\"menuitem\"]")!;
    act(() => { first.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    expect(onSelect).toHaveBeenCalledTimes(1);
    // 选中即收起，焦点回到 summary：否则键盘用户关掉菜单后落在文档开头。
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(summary);
    expect(host.querySelector(".ui-menu__item--danger")).not.toBeNull();
  });
});

describe("Menu 键盘路径", () => {
  it("打开后焦点进入首项，方向键/Home/End 移动，Esc 收起并把焦点还给触发器", async () => {
    const host = mount(<Menu label="更多操作" trigger={<span>⋯</span>}>
      <MenuItem>重命名</MenuItem>
      <MenuItem>复制</MenuItem>
      <MenuItem>删除</MenuItem>
    </Menu>);
    const details = host.querySelector("details")!;
    const summary = host.querySelector("summary")!;
    summary.focus();

    details.open = true;
    act(() => { details.dispatchEvent(new Event("toggle")); });
    // 焦点在 requestAnimationFrame 里送进菜单：等一帧再断言。
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });

    const items = Array.from(host.querySelectorAll<HTMLButtonElement>("[role=\"menuitem\"]"));
    expect(document.activeElement).toBe(items[0]);

    press(items[0]!, "ArrowDown");
    expect(document.activeElement).toBe(items[1]);
    press(items[1]!, "End");
    expect(document.activeElement).toBe(items[2]);
    press(items[2]!, "Home");
    expect(document.activeElement).toBe(items[0]);

    press(items[0]!, "Escape");
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(summary);
  });
});

describe("Popover", () => {
  it("关闭时不渲染面板；打开后有 dialog 角色，Esc 触发 onClose", () => {
    const onClose = vi.fn();
    const host = mount(<Popover open={false} onClose={onClose} label="筛选" trigger={<button type="button">筛选</button>}>
      <p>面板内容</p>
    </Popover>);
    expect(host.querySelector("[role=\"dialog\"]")).toBeNull();

    act(() => { root?.render(<Popover open onClose={onClose} label="筛选" trigger={<button type="button">筛选</button>}>
      <p>面板内容</p>
    </Popover>); });
    expect(host.querySelector("[role=\"dialog\"]")?.getAttribute("aria-label")).toBe("筛选");

    press(document, "Escape");
    expect(onClose).toHaveBeenCalled();
  });
});

describe("Tabs", () => {
  it("按钮形态：aria-selected 唯一，方向键移动并激活", () => {
    const onChange = vi.fn();
    const host = mount(<Tabs
      label="范围"
      value="all"
      onChange={onChange}
      items={[{ key: "all", label: "全部" }, { key: "inbox", label: "收件箱" }, { key: "done", label: "已完成" }]}
    />);
    expect(host.querySelector("[role=\"tablist\"]")?.getAttribute("aria-label")).toBe("范围");
    const tabs = Array.from(host.querySelectorAll<HTMLButtonElement>("[role=\"tab\"]"));
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    // 只有当前项可 Tab 进入（roving tabindex）。
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);

    press(tabs[0]!, "ArrowRight");
    expect(onChange).toHaveBeenCalledWith("inbox");
    press(tabs[0]!, "End");
    expect(onChange).toHaveBeenLastCalledWith("done");
  });

  it("链接形态：用 aria-current 表达当前位置，不假扮 tab", () => {
    const host = mount(<MemoryRouter><Tabs
      label="项目范围"
      value="active"
      items={[{ key: "active", label: "进行中", href: "/goals" }, { key: "archived", label: "已归档", href: "/goals?scope=archived" }]}
    /></MemoryRouter>);
    expect(host.querySelector("[role=\"tablist\"]")).toBeNull();
    const links = Array.from(host.querySelectorAll("a"));
    expect(links[0]?.getAttribute("aria-current")).toBe("page");
    expect(links[1]?.getAttribute("aria-current")).toBeNull();
  });
});

describe("Combobox", () => {
  it("聚焦展开、输入筛选、方向键 + Enter 选中，Esc 收起且不冒泡", () => {
    const onChange = vi.fn();
    const host = mount(<Combobox
      label="模型"
      value={null}
      onChange={onChange}
      options={[
        { value: "a", label: "Claude Sonnet", description: "通用" },
        { value: "b", label: "GPT-5", description: "长上下文" }
      ]}
    />);
    const input = host.querySelector<HTMLInputElement>("input")!;
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-expanded")).toBe("false");

    // React 的 onFocus 走 focusin（focus 不冒泡，挂在根上的委托收不到）。
    act(() => { input.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); });
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelectorAll("[role=\"option\"]")).toHaveLength(2);

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "gpt");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.querySelectorAll("[role=\"option\"]")).toHaveLength(1);

    press(input, "Enter");
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("Esc 关列表并阻止冒泡，避免一次按键关掉外层对话框", () => {
    const host = mount(<Combobox label="模型" value={null} onChange={() => undefined} options={[{ value: "a", label: "A" }]} />);
    const input = host.querySelector<HTMLInputElement>("input")!;
    // React 的 onFocus 走 focusin（focus 不冒泡，挂在根上的委托收不到）。
    act(() => { input.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); });
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    press(input, "Escape");
    document.removeEventListener("keydown", outer);
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(outer).not.toHaveBeenCalled();
  });
});

describe("Table / Card / Separator", () => {
  it("表格输出语义化表头与数据格，空态跨列", () => {
    const host = mount(<Table caption="任务" stickyHead dense>
      <TableHead><TableRow><TableHeaderCell>名称</TableHeaderCell><TableHeaderCell align="end">数量</TableHeaderCell></TableRow></TableHead>
      <TableBody><TableEmpty colSpan={2}>还没有任务</TableEmpty></TableBody>
    </Table>);
    expect(host.querySelector("table.ui-table--sticky.ui-table--dense")).not.toBeNull();
    expect(host.querySelector("caption")?.textContent).toBe("任务");
    expect(host.querySelector("th")?.getAttribute("scope")).toBe("col");
    expect(host.querySelector(".ui-table__th.is-end")).not.toBeNull();
    expect(host.querySelector("td")?.getAttribute("colspan")).toBe("2");
  });

  it("卡片按有无标题决定是否渲染页眉，分隔线有 separator 语义", () => {
    const host = mount(<>
      <Card title="上下文" description="只读" actions={<button type="button">设置</button>} footer="v1">正文</Card>
      <Card>只有正文</Card>
      <Separator />
    </>);
    const cards = Array.from(host.querySelectorAll(".ui-card"));
    expect(cards[0]?.querySelector(".ui-card__head")).not.toBeNull();
    expect(cards[0]?.querySelector(".ui-card__footer")?.textContent).toBe("v1");
    expect(cards[1]?.querySelector(".ui-card__head")).toBeNull();
    expect(host.querySelector("hr")?.getAttribute("aria-orientation")).toBe("horizontal");
  });
});
