import { webcrypto } from "node:crypto";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../../src/lib/relayConnection";
import { flush, mountWorkbench } from "../../tests/mountApp";
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; resetRelayConnectionForTest(); sessionStorage.clear(); vi.unstubAllGlobals(); });

it("取消创建时仍在读取的资料不能在离页后重建已清草稿", async () => {
  const baseUrl = "http://127.0.0.1:8787";
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
  vi.stubGlobal("crypto", webcrypto);
  let release: () => void = () => { throw new Error("read not started"); };
  class DeferredFileReader {
    result: ArrayBuffer | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readAsArrayBuffer() {
      release = () => { this.result = new TextEncoder().encode("discarded-import-sentinel").buffer; this.onload?.(); };
    }
  }
  vi.stubGlobal("FileReader", DeferredFileReader);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ items: [], next_cursor: null }) }) as Response));
  const mounted = await mountWorkbench("/projects?view=create"); unmount = mounted.unmount; await flush();
  const input = mounted.wrapper.get('input[name="project-import"]').element as HTMLInputElement;
  Object.defineProperty(input, "files", { configurable: true, value: [new File(["content"], "discarded.md")] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  const cancel = mounted.wrapper.findAll("button").find(button => button.text().includes("取消创建并返回列表"))!;
  expect(cancel.attributes("disabled")).toBeUndefined();
  await cancel.trigger("click"); await flush();
  expect(mounted.wrapper.find('input[name="project-import"]').exists()).toBe(false);
  await act(async () => { release(); }); await flush(80);
  const key = `relay:create-project:${baseUrl}:${workspaceId}:new`;
  console.log("TRIAGE_CANCELLED_IMPORT", JSON.stringify({ draft: sessionStorage.getItem(key) }));
  expect(sessionStorage.getItem(key)).toBeNull();
});
