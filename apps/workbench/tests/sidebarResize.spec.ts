import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { flush, mountWorkbench } from "./mountApp";

let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; window.localStorage.clear(); });

async function pressKey(element: Element, key: string): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

function frameStyleVar(): string {
  return (document.querySelector(".app-frame") as HTMLElement | null)?.style.getPropertyValue("--relay-sidebar-user-width") ?? "";
}

describe("侧边栏拖拽调宽", () => {
  it("键盘方向键调整宽度并持久化；双击复位恢复默认", async () => {
    const mounted = await mountWorkbench("/today"); unmount = mounted.unmount;
    const handle = mounted.wrapper.get('[data-testid="sidebar-resize-handle"]');
    expect(handle.attributes("role")).toBe("separator");
    expect(handle.attributes("aria-valuenow")).toBe("216");
    expect(frameStyleVar()).toBe("");

    await pressKey(handle.element!, "ArrowRight"); await flush();
    expect(handle.attributes("aria-valuenow")).toBe("232");
    expect(frameStyleVar()).toBe("232px");
    expect(window.localStorage.getItem("relay.workbench.sidebarWidthPx")).toBe("232");

    await pressKey(handle.element!, "ArrowLeft"); await pressKey(handle.element!, "ArrowLeft"); await flush();
    expect(handle.attributes("aria-valuenow")).toBe("200");
    expect(window.localStorage.getItem("relay.workbench.sidebarWidthPx")).toBe("200");

    handle.element!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })); await flush();
    expect(handle.attributes("aria-valuenow")).toBe("216");
    expect(frameStyleVar()).toBe("");
    expect(window.localStorage.getItem("relay.workbench.sidebarWidthPx")).toBeNull();
  });

  it("恢复持久化宽度并钳制到上下限", async () => {
    window.localStorage.setItem("relay.workbench.sidebarWidthPx", "3000");
    const mounted = await mountWorkbench("/today"); unmount = mounted.unmount;
    const handle = mounted.wrapper.get('[data-testid="sidebar-resize-handle"]');
    expect(handle.attributes("aria-valuenow")).toBe("320");
    expect(frameStyleVar()).toBe("320px");

    await pressKey(handle.element!, "ArrowRight"); await flush();
    expect(handle.attributes("aria-valuenow")).toBe("320");
    expect(window.localStorage.getItem("relay.workbench.sidebarWidthPx")).toBe("320");
  });
});
