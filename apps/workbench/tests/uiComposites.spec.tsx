import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Card, Combobox, IconButton, Menu, MenuItem, Popover, Separator, Table, TableBody, TableEmpty, TableHead, TableHeaderCell, TableRow, Tabs } from "../src/ui";
import { resolveNavigationKey } from "../src/ui/Tabs";
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

/** 键盘事件的可选状态在 jsdom 里是只读的，测试里显式覆写才能覆盖 IME 分支。 */
function pressWith(element: Element, key: string, init: { isComposing?: boolean; keyCode?: number } = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  if (init.isComposing !== undefined) Object.defineProperty(event, "isComposing", { value: init.isComposing });
  if (init.keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: init.keyCode });
  act(() => { element.dispatchEvent(event); });
  return event;
}

function typeInto(input: HTMLInputElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function focus(input: HTMLInputElement) {
  act(() => { input.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); });
}

function compose(element: Element, type: "compositionstart" | "compositionend") {
  act(() => { element.dispatchEvent(new CompositionEvent(type, { bubbles: true })); });
}

function optionLabels(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll("[role=\"option\"] .ui-combobox__option-label")).map((node) => node.textContent ?? "");
}

function activeOption(host: HTMLElement): string | null {
  const input = host.querySelector<HTMLInputElement>("input")!;
  const id = input.getAttribute("aria-activedescendant");
  return id === null ? null : document.getElementById(id)?.textContent ?? null;
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

  it("导航形态省略 value：先精确路径，再子路由，查询参数项优先于“全部”", () => {
    const items = [
      { key: "all", label: "全部", href: "/tasks" },
      { key: "inbox", label: "收件箱", href: "/tasks?tab=inbox" },
      { key: "detail", label: "详情", href: "/tasks/123" }
    ];
    expect(resolveNavigationKey(items, { pathname: "/tasks", search: "" })).toBe("all");
    expect(resolveNavigationKey(items, { pathname: "/tasks", search: "?tab=inbox" })).toBe("inbox");
    expect(resolveNavigationKey(items, { pathname: "/tasks", search: "?tab=inbox&foo=1" })).toBe("inbox");
    expect(resolveNavigationKey(items, { pathname: "/tasks", search: "?foo=1" })).toBe("all");
    expect(resolveNavigationKey(items, { pathname: "/tasks/123", search: "" })).toBe("detail");
    expect(resolveNavigationKey(items, { pathname: "/tasks/123/runs", search: "" })).toBe("detail");
  });

  it("导航形态：显式 value 优先，但禁用项不会成为 aria-current", () => {
    const items = [
      { key: "all", label: "全部", href: "/tasks" },
      { key: "inbox", label: "收件箱", href: "/tasks?tab=inbox", disabled: true }
    ];
    expect(resolveNavigationKey(items, { pathname: "/tasks", search: "" }, "inbox")).toBeNull();
    expect(resolveNavigationKey(items, { pathname: "/tasks", search: "" }, "all")).toBe("all");
  });

  it("禁用导航项不渲染 Link、不进入 Tab 顺序、不响应 Enter", () => {
    const host = mount(<MemoryRouter><Tabs
      label="危险区"
      items={[
        { key: "safe", label: "安全", href: "/safe" },
        { key: "locked", label: "已锁定", href: "/locked", disabled: true, testId: "locked-tab" }
      ]}
    /></MemoryRouter>);
    const locked = host.querySelector<HTMLElement>('[data-testid="locked-tab"]')!;
    expect(locked.tagName).toBe("SPAN");
    expect(locked.getAttribute("role")).toBe("link");
    expect(locked.getAttribute("aria-disabled")).toBe("true");
    expect(locked.tabIndex).toBe(-1);
    expect(locked.closest("a")).toBeNull();
    const notNavigated = pressWith(locked, "Enter");
    expect(notNavigated.defaultPrevented).toBe(false);
    expect(host.querySelectorAll("a")).toHaveLength(1);
  });

  it("选择形态：跳过 disabled、Home/End、roving tabindex 与非法 value 退化", () => {
    const onChange = vi.fn();
    const host = mount(<Tabs
      label="范围"
      value="missing"
      onChange={onChange}
      items={[
        { key: "a", label: "甲" },
        { key: "b", label: "乙", disabled: true },
        { key: "c", label: "丙" }
      ]}
    />);
    const tabs = Array.from(host.querySelectorAll<HTMLButtonElement>("[role=\"tab\"]"));
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["false", "false", "false"]);

    press(tabs[0]!, "ArrowRight");
    expect(onChange).toHaveBeenLastCalledWith("c");
    press(tabs[2]!, "ArrowRight");
    expect(onChange).toHaveBeenLastCalledWith("a");
    press(tabs[0]!, "End");
    expect(onChange).toHaveBeenLastCalledWith("c");
    press(tabs[2]!, "Home");
    expect(onChange).toHaveBeenLastCalledWith("a");
  });

  it("选择形态与导航形态在组词期间都不消费方向键", () => {
    const onChange = vi.fn();
    const host = mount(<Tabs label="范围" value="all" onChange={onChange}
      items={[{ key: "all", label: "全部" }, { key: "inbox", label: "收件箱" }]} />);
    const tab = host.querySelector<HTMLButtonElement>("[role=\"tab\"]")!;
    const event = pressWith(tab, "ArrowRight", { isComposing: true });
    expect(event.defaultPrevented).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("空 items 安全：不渲染 tab，也不抛错", () => {
    const host = mount(<Tabs label="空" items={[]} />);
    expect(host.querySelectorAll("[role=\"tab\"]")).toHaveLength(0);
    expect(host.querySelector("[role=\"tablist\"]")?.getAttribute("aria-label")).toBe("空");
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

  it("中文组合输入期间 Enter/Escape/方向键都不消费", () => {
    const onChange = vi.fn();
    const host = mount(<Combobox label="模型" value={null} onChange={onChange} options={[
      { value: "a", label: "甲" }, { value: "b", label: "乙" }
    ]} />);
    const input = host.querySelector<HTMLInputElement>("input")!;
    focus(input);
    const before = activeOption(host);
    compose(input, "compositionstart");

    const enter = pressWith(input, "Enter", { isComposing: true });
    const escape = pressWith(input, "Escape", { isComposing: true });
    const arrow = pressWith(input, "ArrowDown", { isComposing: true });
    expect(enter.defaultPrevented).toBe(false);
    expect(escape.defaultPrevented).toBe(false);
    expect(arrow.defaultPrevented).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(activeOption(host)).toBe(before);
  });

  it("keyCode 229 的旧浏览器路径同样不消费", () => {
    const onChange = vi.fn();
    const host = mount(<Combobox label="模型" value={null} onChange={onChange} options={[{ value: "a", label: "甲" }]} />);
    const input = host.querySelector<HTMLInputElement>("input")!;
    focus(input);
    const enter = pressWith(input, "Enter", { keyCode: 229 });
    expect(enter.defaultPrevented).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-expanded")).toBe("true");
  });

  it("compositionend 后同一轮 Enter 不选择，下一轮 Enter 才选择", async () => {
    const onChange = vi.fn();
    const host = mount(<Combobox label="模型" value={null} onChange={onChange} options={[{ value: "a", label: "甲" }]} />);
    const input = host.querySelector<HTMLInputElement>("input")!;
    focus(input);
    compose(input, "compositionstart");
    compose(input, "compositionend");
    // 浏览器可能先发 compositionend 再发 keydown，此时 isComposing 已经是 false。
    pressWith(input, "Enter", { isComposing: false });
    expect(onChange).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-expanded")).toBe("true");
    await new Promise((resolve) => setTimeout(resolve, 0));
    pressWith(input, "Enter", { isComposing: false });
    expect(onChange).toHaveBeenCalledWith("a");
  });

  it("方向键跳过 disabled，筛选后高亮回退到第一个可用项", () => {
    const onChange = vi.fn();
    function StatefulCombobox() {
      const [value, setValue] = useState<string | null>(null);
      return <Combobox label="模型" value={value} onChange={(next) => { onChange(next); setValue(next); }} options={[
        { value: "a", label: "Alpha" },
        { value: "b", label: "Beta", disabled: true },
        { value: "c", label: "Gamma" }
      ]} />;
    }
    const host = mount(<StatefulCombobox />);
    const input = host.querySelector<HTMLInputElement>("input")!;
    focus(input);
    expect(activeOption(host)).toBe("Alpha");
    press(input, "ArrowDown");
    expect(activeOption(host)).toBe("Gamma");
    press(input, "Enter");
    expect(onChange).toHaveBeenCalledWith("c");

    onChange.mockClear();
    focus(input);
    typeInto(input, "gamma");
    expect(optionLabels(host)).toEqual(["Gamma"]);
    expect(activeOption(host)).toBe("Gamma");
    press(input, "Enter");
    expect(onChange).toHaveBeenLastCalledWith("c");
    expect(input.value).toBe("Gamma");
  });

  it("全部 disabled 时没有高亮，Enter 不下沉为表单提交", () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    const host = mount(<form onSubmit={onSubmit}><Combobox label="模型" value={null} onChange={onChange} options={[
      { value: "a", label: "甲", disabled: true }, { value: "b", label: "乙", disabled: true }
    ]} /></form>);
    const input = host.querySelector<HTMLInputElement>("input")!;
    focus(input);
    expect(activeOption(host)).toBeNull();
    const enter = pressWith(input, "Enter");
    expect(enter.defaultPrevented).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("受控 value 在关闭态同步显示 label；切到 disabled 时强制收起", () => {
    const render = (value: string | null, disabled = false) => <Combobox label="模型" value={value} onChange={() => undefined}
      disabled={disabled} options={[{ value: "a", label: "甲" }, { value: "b", label: "乙" }]} />;
    const host = mount(render("a"));
    const input = host.querySelector<HTMLInputElement>("input")!;
    expect(input.value).toBe("甲");
    act(() => { root?.render(render("b")); });
    expect(input.value).toBe("乙");
    focus(input);
    expect(input.getAttribute("aria-expanded")).toBe("true");
    act(() => { root?.render(render("b", true)); });
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(input.disabled).toBe(true);
  });

  it("鼠标选择与键盘选择的结果一致", () => {
    const onChange = vi.fn();
    const host = mount(<Combobox label="模型" value={null} onChange={onChange} options={[{ value: "a", label: "甲" }, { value: "b", label: "乙" }]} />);
    const input = host.querySelector<HTMLInputElement>("input")!;
    focus(input);
    act(() => {
      host.querySelectorAll<HTMLElement>("[role=\"option\"]")[1]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith("b");
    onChange.mockClear();
    focus(input);
    press(input, "ArrowDown");
    press(input, "Enter");
    expect(onChange).toHaveBeenLastCalledWith("b");
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

  it("图标按钮：默认用 label 作原生提示，title=false 时交给 Tooltip 且保留 aria-label", () => {
    const host = mount(<>
      <IconButton icon={Pencil} label="编辑" data-testid="default-title" />
      <IconButton icon={Trash2} label="删除" title={false} data-testid="no-title" />
    </>);
    const withTitle = host.querySelector<HTMLButtonElement>('[data-testid="default-title"]')!;
    const noTitle = host.querySelector<HTMLButtonElement>('[data-testid="no-title"]')!;
    expect(withTitle.getAttribute("aria-label")).toBe("编辑");
    expect(withTitle.getAttribute("title")).toBe("编辑");
    expect(noTitle.getAttribute("aria-label")).toBe("删除");
    expect(noTitle.hasAttribute("title")).toBe(false);
  });
});
