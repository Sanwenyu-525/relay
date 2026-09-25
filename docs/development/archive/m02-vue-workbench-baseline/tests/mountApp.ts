import { mount, type VueWrapper } from "@vue/test-utils";
import { createMemoryHistory, type Router } from "vue-router";
import App from "../src/App.vue";
import { createWorkbenchRouter } from "../src/router";

export function flush(milliseconds = 40): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

export async function mountWorkbench(
  path: string
): Promise<{ wrapper: VueWrapper; router: Router; unmount: () => void }> {
  const router = createWorkbenchRouter(createMemoryHistory());
  await router.push(path);
  await router.isReady();
  const wrapper = mount(App, { global: { plugins: [router] }, attachTo: document.body });
  await flush();
  return {
    wrapper,
    router,
    unmount: () => {
      wrapper.unmount();
    }
  };
}

export function dialogText(): string {
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
  return dialogs.map((dialog) => dialog.textContent ?? "").join("\n");
}

export function dialogLabels(): string[] {
  return Array.from(document.querySelectorAll('[role="dialog"]')).map(
    (dialog) => dialog.getAttribute("aria-label") ?? ""
  );
}

export function pressEscape(): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}