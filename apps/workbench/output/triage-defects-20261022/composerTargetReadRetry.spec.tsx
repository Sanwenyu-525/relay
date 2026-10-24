import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import ComposerTargetPicker from "../../src/components/ComposerTargetPicker";
import type { RelayApiClient } from "../../src/api/relayClient";
import { flush, mountReact } from "../../tests/mountApp";
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; });
it("Skill目标项目读取临时失败后重新展开应可恢复，不应永久缓存错误", async () => {
  const reads = vi.fn(async () => {
    if (reads.mock.calls.length === 1) throw new TypeError("temporary offline");
    return { items: [{ id: "project-recovered", title: "恢复后可选项目" }], nextCursor: null };
  });
  const client = { getProjectsPage: reads } as unknown as RelayApiClient;
  const mounted = await mountReact(createElement(ComposerTargetPicker, { client, need: "PROJECT", onPick: vi.fn() }));
  unmount = mounted.unmount;
  await mounted.wrapper.get('[data-testid="composer-target"]').trigger("click"); await flush();
  expect(mounted.wrapper.text()).toContain("清单读取失败"); expect(reads).toHaveBeenCalledTimes(1);
  await mounted.wrapper.get('[data-testid="composer-target"]').trigger("click"); await flush();
  await mounted.wrapper.get('[data-testid="composer-target"]').trigger("click"); await flush();
  const retryButton = mounted.wrapper.findAll("button").find(button => /重试|重新读取/.test(button.text()));
  if (retryButton) { await retryButton.trigger("click"); await flush(); }
  const recovered = mounted.wrapper.find('[data-testid="composer-target-project-project-recovered"]').exists();
  console.log("TRIAGE_COMPOSER_TARGET_READ_RETRY", JSON.stringify({ readCount: reads.mock.calls.length, retryOffered: Boolean(retryButton), open: (mounted.wrapper.get('details').element as HTMLDetailsElement).open, recovered, errorStillVisible: mounted.wrapper.text().includes("清单读取失败") }));
  expect(recovered).toBe(true);
});
