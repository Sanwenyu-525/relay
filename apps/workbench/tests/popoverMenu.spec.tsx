import { createElement } from "react";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import WritePermissionControl from "../src/components/WritePermissionControl";
import type { RelayApiClient, RelayWriteReadiness } from "../src/api/relayClient";
import { flush, mountReact } from "./mountApp";

/**
 * 浮层菜单的公共关闭语义（lib/popoverMenu，2026-10-17 用户指认「多菜单重叠、
 * 点菜单外面关不掉」后收口）。
 *
 * 这里锁三条行为：点到浮层外面即收、Esc 收并把焦点还给触发器、打开一个浮层时
 * 其余已注册浮层同时收起。载体用写入档位芯片（此前完全没有外部关闭处理），
 * 挂两棵是为了验证「独占」跨实例成立。
 */

const projectId = "22222222-2222-4222-8222-222222222222";
const resourceId = "33333333-3333-4333-8333-333333333333";
const root = "D:\\Develop\\MyProject";

function readiness(): RelayWriteReadiness {
  return { status: "READY", detail: "本目录写入需要每次批准。", policyDecision: "ASK",
    policyId: "policy-1", policyRevision: "7", policyTargetPrefix: root,
    writeTier: "ASK", accessRevision: "0" };
}

function client(): RelayApiClient {
  return {
    getWriteReadiness: vi.fn(async () => readiness()),
    createGatewayPolicy: vi.fn(), addGatewayPolicyVersion: vi.fn(), revokeGatewayPolicy: vi.fn(),
    getCommandReceipt: vi.fn(),
  } as unknown as RelayApiClient;
}

const chip = (index = 0) => document.querySelectorAll<HTMLElement>('[data-testid="write-permission-chip"]')[index] ?? null;
const menu = (index = 0) => document.querySelectorAll<HTMLDetailsElement>('[data-testid="write-permission"]')[index] ?? null;
async function click(element: Element | null): Promise<void> {
  if (element === null) throw new Error("点击目标不存在");
  await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  await flush(0);
}
async function pointerDownOutside(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
  });
  await flush(0);
}

async function mountControls() {
  return mountReact(createElement(MemoryRouter, null,
    createElement("div", null,
      createElement(WritePermissionControl, { client: client(), projectId, resourceId, canonicalRoot: root }),
      createElement(WritePermissionControl, { client: client(), projectId, resourceId, canonicalRoot: root }),
      createElement("button", { type: "button", "data-testid": "outside" }, "别处"))));
}

afterEach(() => { vi.restoreAllMocks(); });

describe("浮层菜单关闭语义", () => {
  it("打开档位菜单后，点浮层外面即收起", async () => {
    const view = await mountReact(createElement(MemoryRouter, null,
      createElement("div", null,
        createElement(WritePermissionControl, { client: client(), projectId, resourceId, canonicalRoot: root }),
        createElement("button", { type: "button", "data-testid": "outside" }, "别处"))));
    try {
      await click(chip());
      expect(menu()?.open).toBe(true);
      await pointerDownOutside(document.querySelector('[data-testid="outside"]')!);
      expect(menu()?.open).toBe(false);
    } finally { view.unmount(); }
  });

  it("点浮层内部的条目不收起：选择档位的点击不能被外部关闭吃掉", async () => {
    const view = await mountReact(createElement(MemoryRouter, null,
      createElement(WritePermissionControl, { client: client(), projectId, resourceId, canonicalRoot: root })));
    try {
      await click(chip());
      await pointerDownOutside(document.querySelector('[data-testid="write-permission-auto"]')!);
      expect(menu()?.open).toBe(true);
    } finally { view.unmount(); }
  });

  it("Esc 收起菜单并把焦点还给触发器", async () => {
    const view = await mountReact(createElement(MemoryRouter, null,
      createElement(WritePermissionControl, { client: client(), projectId, resourceId, canonicalRoot: root })));
    try {
      await click(chip());
      expect(menu()?.open).toBe(true);
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      });
      await flush(0);
      expect(menu()?.open).toBe(false);
      expect(document.activeElement).toBe(chip());
    } finally { view.unmount(); }
  });

  it("一个浮层打开时，其余已注册浮层同时收起：多菜单不再重叠", async () => {
    const view = await mountControls();
    try {
      await click(chip(0));
      expect(menu(0)?.open).toBe(true);
      await click(chip(1));
      expect(menu(0)?.open).toBe(false);
      expect(menu(1)?.open).toBe(true);
      // 反方向同样成立：再开第一个，第二个收起。
      await click(chip(0));
      expect(menu(1)?.open).toBe(false);
      expect(menu(0)?.open).toBe(true);
    } finally { view.unmount(); }
  });

  it("组词期间的 Esc 归输入法，不收浮层", async () => {
    const view = await mountReact(createElement(MemoryRouter, null,
      createElement(WritePermissionControl, { client: client(), projectId, resourceId, canonicalRoot: root })));
    try {
      await click(chip());
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, isComposing: true }));
      });
      await flush(0);
      expect(menu()?.open).toBe(true);
    } finally { view.unmount(); }
  });
});
