import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { createWorkbenchRouter } from "../src/router";

/** Keep the archived assertions intact while replacing the Vue Test Utils mount surface with DOM events. */
export class DomWrapper {
  constructor(readonly element: Element | null) {}
  exists(): boolean { return this.element !== null; }
  text(): string { return this.element?.textContent?.replace(/\s+/g, " ").trim() ?? ""; }
  attributes(name: string): string | undefined { return this.element?.getAttribute(name) ?? undefined; }
  find(selector: string): DomWrapper { return new DomWrapper(this.element?.querySelector(selector) ?? null); }
  get(selector: string): DomWrapper {
    const found = this.find(selector);
    if (!found.exists()) throw new Error(`DOM test selector not found: ${selector}\n${this.element?.outerHTML.slice(0, 1200) ?? ""}`);
    return found;
  }
  findAll(selector: string): DomWrapper[] { return Array.from(this.element?.querySelectorAll(selector) ?? []).map((element) => new DomWrapper(element)); }
  async trigger(eventName: string): Promise<void> {
    if (!this.element) throw new Error("Cannot trigger missing DOM element");
    const target = this.element;
    await act(async () => {
      if (eventName === "click") target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      else if (eventName === "submit") target.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      else target.dispatchEvent(new Event(eventName, { bubbles: true, cancelable: true }));
    });
  }
  async setValue(value?: string | number | boolean): Promise<void> {
    if (!this.element) throw new Error("Cannot set value on missing DOM element");
    const target = this.element;
    await act(async () => {
      if (target instanceof HTMLInputElement && (target.type === "radio" || target.type === "checkbox")) {
        const checked = value === undefined ? true : Boolean(value);
        if (target.checked !== checked) target.click();
      } else if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
        const prototype = target instanceof HTMLInputElement ? HTMLInputElement.prototype : target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLSelectElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(target, String(value ?? ""));
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
      } else throw new Error(`Cannot set value on ${target.tagName}`);
    });
  }
}

export async function flush(milliseconds = 40): Promise<void> {
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds)); });
  // React commits effects after an act boundary; route remounts can begin one more async fixture read there.
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 10)); });
}

export async function mountWorkbench(path: string) {
  const router = createWorkbenchRouter([path]);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(<RouterProvider router={router} />); });
  await flush();
  return {
    wrapper: new DomWrapper(container),
    router: {
      push: async (target: string) => { await act(async () => { await router.navigate(target); }); },
      back: async () => { await act(async () => { await router.navigate(-1); }); },
      currentRoute: { get value() { const location = router.state.location; return { path: location.pathname, query: Object.fromEntries(new URLSearchParams(location.search)) }; } }
    },
    unmount: () => { act(() => root.unmount()); container.remove(); }
  };
}

export async function mountReact(element: ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  return { wrapper: new DomWrapper(container), rerender: async (next: ReactElement) => { await act(async () => { root.render(next); }); }, unmount: () => { act(() => root.unmount()); container.remove(); } };
}

export function dialogText(): string { return Array.from(document.querySelectorAll('[role="dialog"]')).map((dialog) => dialog.textContent ?? "").join("\n"); }
export function dialogLabels(): string[] { return Array.from(document.querySelectorAll('[role="dialog"]')).map((dialog) => dialog.getAttribute("aria-label") ?? ""); }
export function pressEscape(): void { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); }
