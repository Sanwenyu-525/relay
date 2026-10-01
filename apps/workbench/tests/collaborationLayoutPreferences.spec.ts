import { act, createElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CollaborationSplitter from "../src/components/CollaborationSplitter";
import { COLLABORATION_LAYOUT_STORAGE_KEY, DEFAULT_COLLABORATION_LAYOUT,
  readCollaborationLayoutPreferences, saveCollaborationLayoutPreferences } from "../src/lib/collaborationLayoutPreferences";
import { mountReact } from "./mountApp";

afterEach(() => { vi.restoreAllMocks(); window.localStorage.removeItem(COLLABORATION_LAYOUT_STORAGE_KEY); });

describe("协作布局仅保存在本设备", () => {
  it.each(["{", "null", JSON.stringify({ version: 2, mode: "split", chatRatio: 0.52 }),
    JSON.stringify({ version: 1, mode: "other", chatRatio: 0.52 }),
    JSON.stringify({ version: 1, mode: "chat", chatRatio: "0.52" }),
    JSON.stringify({ version: 1, mode: "result", chatRatio: 1 })])("无效偏好回退默认：%s", (raw) => {
    window.localStorage.setItem(COLLABORATION_LAYOUT_STORAGE_KEY, raw);
    expect(readCollaborationLayoutPreferences()).toEqual(DEFAULT_COLLABORATION_LAYOUT);
  });

  it("读写失败回退默认；不影响其他显示偏好", () => {
    const existingKey = "relay.workbench.displayPreferences";
    window.localStorage.setItem(existingKey, "existing-display-preferences");
    const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("disabled"); });
    expect(readCollaborationLayoutPreferences()).toEqual(DEFAULT_COLLABORATION_LAYOUT);
    read.mockRestore();
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("full"); });
    expect(saveCollaborationLayoutPreferences({ mode: "result", chatRatio: 0.6 })).toEqual(DEFAULT_COLLABORATION_LAYOUT);
    write.mockRestore();
    expect(window.localStorage.getItem(existingKey)).toBe("existing-display-preferences");
    window.localStorage.removeItem(existingKey);
  });

  it("有效模式和比例可恢复，保存中没有业务身份", () => {
    expect(saveCollaborationLayoutPreferences({ mode: "chat", chatRatio: 0.6 })).toEqual({ mode: "chat", chatRatio: 0.6 });
    expect(readCollaborationLayoutPreferences()).toEqual({ mode: "chat", chatRatio: 0.6 });
    expect(JSON.parse(window.localStorage.getItem(COLLABORATION_LAYOUT_STORAGE_KEY)!)).toEqual({ version: 1, mode: "chat", chatRatio: 0.6 });
    expect(saveCollaborationLayoutPreferences({ mode: "split", chatRatio: Number.NaN })).toEqual(DEFAULT_COLLABORATION_LAYOUT);
  });
});

describe("协作分隔条", () => {
  function Harness({ onChange }: { onChange: (ratio: number, commit: boolean) => void }) {
    const [ratio, setRatio] = useState(0.52);
    return createElement("div", null, createElement(CollaborationSplitter, { ratio, hidden: false,
      onRatioChange: (next, commit) => { setRatio(next); onChange(next, commit); } }));
  }

  async function pointer(element: HTMLElement, type: string, x: number, pointerId = 1) {
    const event = new MouseEvent(type, { button: 0, clientX: x, bubbles: true, cancelable: true });
    Object.defineProperty(event, "pointerId", { value: pointerId });
    await act(async () => { element.dispatchEvent(event); });
  }

  it("左右方向键调整，边界钳制，双击恢复默认", async () => {
    const changed = vi.fn(); const view = await mountReact(createElement(Harness, { onChange: changed }));
    try {
      const handle = view.wrapper.get('[data-testid="collab-splitter"]');
      expect(handle.attributes("role")).toBe("separator");
      expect(handle.attributes("aria-valuenow")).toBe("52");
      await act(async () => { handle.element!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", isComposing: true, bubbles: true })); });
      await act(async () => { handle.element!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", keyCode: 229, bubbles: true })); });
      expect(handle.attributes("aria-valuenow")).toBe("52");
      expect(changed).not.toHaveBeenCalled();
      for (let index = 0; index < 20; index++) {
        await act(async () => { handle.element!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
      }
      expect(handle.attributes("aria-valuenow")).toBe("68");
      await act(async () => { handle.element!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); });
      expect(handle.attributes("aria-valuenow")).toBe("66");
      await act(async () => { handle.element!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
      expect(handle.attributes("aria-valuenow")).toBe("52");
      expect(changed).toHaveBeenLastCalledWith(0.52, true);
    } finally { view.unmount(); }
  });

  it("拖动预览并在原指针结束时保存最后比例；忽略其他指针", async () => {
    const changed = vi.fn(); const view = await mountReact(createElement(Harness, { onChange: changed }));
    try {
      const handle = view.wrapper.get('[data-testid="collab-splitter"]').element as HTMLElement;
      vi.spyOn(handle.parentElement!, "getBoundingClientRect").mockReturnValue({ width: 1000 } as DOMRect);
      await pointer(handle, "pointerdown", 500);
      await pointer(handle, "pointermove", 600, 2);
      expect(changed).not.toHaveBeenCalled();
      await pointer(handle, "pointermove", 600);
      expect(handle.getAttribute("aria-valuenow")).toBe("62");
      expect(changed).toHaveBeenLastCalledWith(0.62, false);
      await pointer(handle, "pointermove", 0);
      expect(handle.getAttribute("aria-valuenow")).toBe("32");
      await pointer(handle, "pointerup", 0);
      expect(changed).toHaveBeenLastCalledWith(0.32, true);
      await pointer(handle, "pointermove", 900);
      expect(handle.getAttribute("aria-valuenow")).toBe("32");
    } finally { view.unmount(); }
  });
});
