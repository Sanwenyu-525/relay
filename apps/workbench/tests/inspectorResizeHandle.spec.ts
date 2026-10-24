import { act, createElement, useState, type CSSProperties } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import InspectorResizeHandle from "../src/components/InspectorResizeHandle";
import { clampInspectorWidth, INSPECTOR_WIDTH_MAX_PX, INSPECTOR_WIDTH_MIN_PX,
  INSPECTOR_WIDTH_STORAGE_KEY, readStoredInspectorWidth, saveInspectorWidth } from "../src/lib/inspectorWidthPreferences";
import { mountReact } from "./mountApp";

afterEach(() => { vi.restoreAllMocks(); window.localStorage.removeItem(INSPECTOR_WIDTH_STORAGE_KEY); });

describe("工作详情宽度偏好", () => {
  it("只保存本设备的宽度，越界值被钳制，null 恢复默认", () => {
    saveInspectorWidth(500);
    expect(readStoredInspectorWidth()).toBe(500);
    saveInspectorWidth(10);
    expect(readStoredInspectorWidth()).toBe(INSPECTOR_WIDTH_MIN_PX);
    saveInspectorWidth(9999);
    expect(readStoredInspectorWidth()).toBe(INSPECTOR_WIDTH_MAX_PX);
    saveInspectorWidth(null);
    expect(readStoredInspectorWidth()).toBeNull();
    expect(clampInspectorWidth(320.4)).toBe(320);
  });

  it("无效存储与读写失败都回退默认，不阻止其他偏好", () => {
    window.localStorage.setItem(INSPECTOR_WIDTH_STORAGE_KEY, "not-a-number");
    expect(readStoredInspectorWidth()).toBeNull();
    const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("disabled"); });
    expect(readStoredInspectorWidth()).toBeNull();
    read.mockRestore();
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("full"); });
    expect(() => saveInspectorWidth(400)).not.toThrow();
    write.mockRestore();
  });
});

describe("工作详情左边界拖拽", () => {
  const panelStyle: CSSProperties = { width: 352 };

  function Harness({ onChange, initial = null }: {
    onChange: (width: number | null, commit: boolean) => void;
    initial?: number | null;
  }) {
    const [width, setWidth] = useState<number | null>(initial);
    return createElement("div", null,
      createElement("div", { className: "task-inspector", style: width === null ? panelStyle : { width } }),
      createElement(InspectorResizeHandle, { width,
        onWidthChange: (next, commit) => { setWidth(next); onChange(next, commit); } }));
  }

  async function pointer(element: HTMLElement, type: string, x: number, pointerId = 1) {
    const event = new MouseEvent(type, { button: 0, clientX: x, bubbles: true, cancelable: true });
    Object.defineProperty(event, "pointerId", { value: pointerId });
    await act(async () => { element.dispatchEvent(event); });
  }

  it("向左拖放宽、向右拖收窄，并在原指针抬手时提交", async () => {
    const changed = vi.fn();
    const view = await mountReact(createElement(Harness, { onChange: changed, initial: 352 }));
    try {
      const handle = view.wrapper.get('[data-testid="inspector-resize-handle"]').element as HTMLElement;
      expect(handle.getAttribute("role")).toBe("separator");
      expect(handle.getAttribute("aria-valuemin")).toBe(String(INSPECTOR_WIDTH_MIN_PX));
      expect(handle.getAttribute("aria-valuemax")).toBe(String(INSPECTOR_WIDTH_MAX_PX));
      await pointer(handle, "pointerdown", 500);
      await pointer(handle, "pointermove", 420, 2);
      expect(changed).not.toHaveBeenCalled();
      await pointer(handle, "pointermove", 420);
      expect(handle.getAttribute("aria-valuenow")).toBe("432");
      await pointer(handle, "pointerup", 420);
      expect(changed).toHaveBeenLastCalledWith(432, true);
      await pointer(handle, "pointerdown", 400);
      await pointer(handle, "pointermove", 460);
      await pointer(handle, "pointerup", 460);
      expect(changed).toHaveBeenLastCalledWith(372, true);
    } finally { view.unmount(); }
  });

  it("首次拖拽从实际面板宽度起步；越界被钳制", async () => {
    const changed = vi.fn();
    const view = await mountReact(createElement(Harness, { onChange: changed }));
    try {
      const handle = view.wrapper.get('[data-testid="inspector-resize-handle"]').element as HTMLElement;
      const panel = handle.parentElement!.querySelector<HTMLElement>(".task-inspector")!;
      vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({ width: 320 } as DOMRect);
      await pointer(handle, "pointerdown", 500);
      await pointer(handle, "pointermove", 0);
      await pointer(handle, "pointerup", 0);
      expect(changed).toHaveBeenLastCalledWith(INSPECTOR_WIDTH_MAX_PX, true);
      await pointer(handle, "pointerdown", 0);
      await pointer(handle, "pointermove", 900);
      await pointer(handle, "pointerup", 900);
      expect(changed).toHaveBeenLastCalledWith(INSPECTOR_WIDTH_MIN_PX, true);
    } finally { view.unmount(); }
  });

  it("左右方向键各调一档，双击恢复默认", async () => {
    const changed = vi.fn();
    const view = await mountReact(createElement(Harness, { onChange: changed, initial: 400 }));
    try {
      const handle = view.wrapper.get('[data-testid="inspector-resize-handle"]').element as HTMLElement;
      await act(async () => { handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", isComposing: true, bubbles: true })); });
      expect(changed).not.toHaveBeenCalled();
      await act(async () => { handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); });
      expect(changed).toHaveBeenLastCalledWith(416, true);
      await act(async () => { handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
      expect(changed).toHaveBeenLastCalledWith(400, true);
      await act(async () => { handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
      expect(changed).toHaveBeenLastCalledWith(null, true);
    } finally { view.unmount(); }
  });
});
