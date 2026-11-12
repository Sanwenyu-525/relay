import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Alert, Badge, Button, buttonClassName, Checkbox, FormField, IconButton, Input, Skeleton, Spinner, Switch } from "../src/ui";
import { Plus, Trash2 } from "lucide-react";

/**
 * 组件层的行为契约。
 *
 * 这里不测像素（像素归 Playwright 的 uiDesignTokens.spec），只锁三件会悄悄退化的东西：
 * 1. 变体 → 类名映射（页面靠它拿到既有 CSS，映射错了就等于换了一套视觉）；
 * 2. 无障碍接线（label 关联、aria-invalid、role="switch" 的 aria-checked）；
 * 3. 状态与禁用的耦合（busy 必须同时禁用，否则能重复提交）。
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

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  container = null;
  root = null;
  vi.restoreAllMocks();
});

describe("Button", () => {
  it("四档变体各自落到既有按钮类，默认不提交表单", () => {
    const host = mount(<>
      <Button variant="primary">确认</Button>
      <Button variant="secondary">取消</Button>
      <Button variant="danger" size="sm">删除</Button>
      <Button variant="text">更多</Button>
    </>);
    const buttons = Array.from(host.querySelectorAll("button"));
    expect(buttons.map((b) => b.className)).toEqual([
      "primary-button",
      "secondary-button",
      "danger-button ui-button--sm",
      "text-button"
    ]);
    expect(buttons.every((b) => b.type === "button")).toBe(true);
  });

  it("busy 同时禁用并标 aria-busy，图标对读屏隐藏", () => {
    const host = mount(<Button variant="primary" busy icon={Plus}>保存中</Button>);
    const button = host.querySelector("button");
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute("aria-busy")).toBe("true");
    expect(button?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(button?.textContent).toBe("保存中");
  });

  it("buttonClassName 供链接类入口复用同一套类名", () => {
    expect(buttonClassName({ variant: "primary", block: true })).toBe("primary-button ui-button--block");
    expect(buttonClassName()).toBe("secondary-button");
  });
});

describe("IconButton", () => {
  it("label 落到 aria-label 与原生 title", () => {
    const host = mount(<IconButton label="删除任务" icon={Trash2} tone="danger" size="sm" />);
    const button = host.querySelector("button");
    expect(button?.getAttribute("aria-label")).toBe("删除任务");
    expect(button?.title).toBe("删除任务");
    expect(button?.className).toContain("icon-button");
    expect(button?.className).toContain("ui-icon-button--danger");
    expect(button?.className).toContain("ui-icon-button--sm");
  });
});

describe("FormField", () => {
  it("label 与控件靠 htmlFor 关联，必填有读屏文案", () => {
    const host = mount(<FormField label="项目名称" htmlFor="project-name" required hint="用于列表显示">
      <Input id="project-name" />
    </FormField>);
    const label = host.querySelector("label");
    expect(label?.getAttribute("for")).toBe("project-name");
    expect(label?.textContent).toContain("项目名称");
    expect(label?.querySelector(".visually-hidden")?.textContent).toBe("（必填）");
    // 有提示时不该同时出现错误播报。
    expect(host.querySelector(".field-error")).toBeNull();
  });

  it("错误态同时落到 .field--invalid、role=alert 与 aria-invalid", () => {
    const host = mount(<FormField label="名称" htmlFor="n" error="不能为空">
      <Input id="n" invalid />
    </FormField>);
    expect(host.querySelector(".field")?.className).toContain("field--invalid");
    expect(host.querySelector("[role=\"alert\"]")?.textContent).toBe("不能为空");
    expect(host.querySelector("input")?.getAttribute("aria-invalid")).toBe("true");
  });
});

describe("Switch", () => {
  it("是 role=switch 的按钮，点击切换 aria-checked，名称来自可见标签", () => {
    const onChange = vi.fn();
    const host = mount(<Switch checked={false} onChange={onChange} label="启用记忆" description="仅本机保存" />);
    const button = host.querySelector("[role=\"switch\"]");
    expect(button?.getAttribute("aria-checked")).toBe("false");
    const labelId = button?.getAttribute("aria-labelledby");
    expect(labelId).not.toBeNull();
    expect(document.getElementById(labelId ?? "")?.textContent).toBe("启用记忆");

    act(() => { button?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(onChange).toHaveBeenCalledWith(true);
    // 勾选状态由调用方回填，受控组件不自行改状态。
    expect(button?.getAttribute("aria-checked")).toBe("false");
  });

  it("禁用时不触发变更", () => {
    const onChange = vi.fn();
    const host = mount(<Switch checked={false} onChange={onChange} label="启用" disabled />);
    const button = host.querySelector<HTMLButtonElement>("[role=\"switch\"]");
    expect(button?.disabled).toBe(true);
    act(() => { button?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("Checkbox", () => {
  it("保持原生 input，标签点击可聚焦", () => {
    const host = mount(<Checkbox label="记住这次选择" description="下次不再询问" />);
    const input = host.querySelector("input");
    expect(input?.type).toBe("checkbox");
    expect(host.querySelector("label")?.getAttribute("for")).toBe(input?.id);
    expect(host.textContent).toContain("下次不再询问");
  });
});

describe("Badge / Alert / Loading", () => {
  it("Badge 复用状态芯片的四档语气", () => {
    const host = mount(<Badge tone="warning" title="待确认">2 项待确认</Badge>);
    const badge = host.querySelector(".status-chip");
    expect(badge?.className).toContain("status-chip--warning");
    expect(badge?.getAttribute("title")).toBe("待确认");
  });

  it("Alert 的危险档用 alert，其余用 status", () => {
    const host = mount(<>
      <Alert tone="danger" title="保存失败">网络不可用</Alert>
      <Alert tone="warning" title="需要确认" />
    </>);
    const alerts = Array.from(host.querySelectorAll(".ui-alert"));
    expect(alerts[0]?.getAttribute("role")).toBe("alert");
    expect(alerts[1]?.getAttribute("role")).toBe("status");
    expect(alerts[0]?.className).toContain("ui-alert--danger");
  });

  it("Spinner 有 status 语义，Skeleton 对读屏隐藏", () => {
    const host = mount(<><Spinner label="正在载入任务" /><Skeleton lines={3} /></>);
    expect(host.querySelector(".ui-spinner")?.getAttribute("role")).toBe("status");
    expect(host.querySelector(".ui-spinner")?.getAttribute("aria-label")).toBe("正在载入任务");
    expect(host.querySelector(".ui-skeleton-stack")?.getAttribute("aria-hidden")).toBe("true");
    expect(host.querySelectorAll(".ui-skeleton")).toHaveLength(3);
  });
});
