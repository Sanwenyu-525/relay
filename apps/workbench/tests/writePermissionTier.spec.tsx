import { createElement } from "react";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import WritePermissionControl from "../src/components/WritePermissionControl";
import { RelayApiError } from "../src/api/relayClient";
import type { RelayApiClient, RelayWriteReadiness } from "../src/api/relayClient";
import { flush, mountReact } from "./mountApp";

/**
 * 对话页「本目录写入档位」入口的契约测试（工作台 §18.1，tool-adapters §1.2）。
 *
 * 这里锁的是客户端行为：档位文案来自服务端投影、改档用带 expected_revision 的版本命令、
 * 提交后必须重读投影、丢响应时保留原 command_id。真实准入判定由 API 集成测试证明。
 */

const projectId = "22222222-2222-4222-8222-222222222222";
const resourceId = "33333333-3333-4333-8333-333333333333";
const root = "D:\\Develop\\MyProject";

function readiness(over: Partial<RelayWriteReadiness> = {}): RelayWriteReadiness {
  return { status: "READY", detail: "本目录写入需要每次批准。", policyDecision: "ASK",
    policyId: "policy-1", policyRevision: "7", policyTargetPrefix: root, ...over };
}

function stub(getWriteReadiness: () => Promise<RelayWriteReadiness>, over: Partial<RelayApiClient> = {}) {
  return {
    getWriteReadiness: vi.fn(getWriteReadiness),
    createGatewayPolicy: vi.fn(async () => ({ commandId: "c1", committedAt: "2026-10-17T00:00:00Z", result: {} })),
    addGatewayPolicyVersion: vi.fn(async () => ({ commandId: "c2", committedAt: "2026-10-17T00:00:00Z", result: {} })),
    revokeGatewayPolicy: vi.fn(async () => ({ commandId: "c3", committedAt: "2026-10-17T00:00:00Z", result: {} })),
    getCommandReceipt: vi.fn(async () => ({ commandId: "c1", commandType: "CreateGatewayPolicy",
      committedAt: "2026-10-17T00:00:00Z", result: {} })),
    ...over,
  } as unknown as RelayApiClient;
}

async function mount(client: RelayApiClient, disabled = false) {
  return mountProps({ client, projectId, resourceId, canonicalRoot: root, disabled });
}

async function mountProps(props: { readonly client: RelayApiClient; readonly projectId: string | null;
  readonly resourceId: string | null; readonly canonicalRoot: string | null; readonly disabled?: boolean }) {
  const mounted = await mountReact(createElement(MemoryRouter, null,
    createElement(WritePermissionControl, props)));
  await flush(0);
  return mounted;
}

const chip = () => document.querySelector<HTMLElement>('[data-testid="write-permission-chip"]');
const button = (tier: string) => document.querySelector<HTMLButtonElement>(`[data-testid="write-permission-${tier}"]`);
async function click(element: HTMLElement | null): Promise<void> {
  if (element === null) throw new Error("点击目标不存在");
  await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  await flush(0);
}

afterEach(() => { vi.restoreAllMocks(); });

describe("本目录写入档位", () => {
  it("显示服务端投影的档位，明确没有「完全访问」且删除不在范围授权里", async () => {
    const client = stub(async () => readiness({ policyDecision: "AUTO" }));
    const mounted = await mount(client);
    try {
      expect(chip()?.textContent).toContain("本次任务自动");
      expect(button("ask")?.getAttribute("aria-pressed")).toBe("false");
      expect(button("auto")?.getAttribute("aria-pressed")).toBe("true");
      const menu = document.querySelector('[data-testid="write-permission"]')?.textContent ?? "";
      expect(menu).toContain("无「完全访问」档");
      expect(menu).toContain("删除与 Git 始终确认");
      expect(menu).toContain(`本目录：MyProject`);
      // 用户实机反馈「一大堆字」：菜单是操作面，不是说明文档，正文必须保持短。
      expect(menu.replace(/\s+/gu, "").length).toBeLessThan(220);
    } finally { mounted.unmount(); }
  });

  it("没有选择目录时芯片仍常驻，三档禁用并说明先选目录归项目", async () => {
    const client = stub(async () => readiness());
    const mounted = await mountProps({ client, projectId: null, resourceId: null, canonicalRoot: null });
    try {
      // 用户实机截图里输入器处于「未选择目录」：入口不能因此消失，否则看起来像功能不存在。
      expect(chip()?.textContent).toContain("未选择目录");
      expect(chip()?.getAttribute("data-tier")).toBe("unbound");
      expect(button("ask")?.disabled).toBe(true);
      expect(button("auto")?.disabled).toBe(true);
      expect(button("none")?.disabled).toBe(true);
      expect(document.querySelector('[data-testid="write-permission-hint"]')?.textContent)
        .toContain("先选择目录并归入项目");
      expect(vi.mocked(client.getWriteReadiness)).not.toHaveBeenCalled();
    } finally { mounted.unmount(); }
  });

  it("目录已选但未归入项目时，芯片说明缺的是项目归属而不是权限", async () => {
    const client = stub(async () => readiness());
    const mounted = await mountProps({ client, projectId: null, resourceId: null, canonicalRoot: root });
    try {
      expect(chip()?.textContent).toContain("未归入项目");
      expect(document.querySelector('[data-testid="write-permission-hint"]')?.textContent)
        .toContain("先把这个目录归入项目");
      expect(vi.mocked(client.getWriteReadiness)).not.toHaveBeenCalled();
    } finally { mounted.unmount(); }
  });

  it("旧版 API 没有只读查询时只留一行说明，并保留重新核对", async () => {
    const client = stub(async () => { throw new RelayApiError({ status: 404, code: "NOT_FOUND",
      detail: "请求的路径在当前服务上不存在。", retryable: false, retryAction: null, fieldErrors: [],
      expectedRevision: null, actualRevision: null }); });
    const mounted = await mount(client);
    try {
      expect(chip()?.textContent).toContain("写入档位待核对");
      const error = document.querySelector('[data-testid="write-permission-error"]')?.textContent ?? "";
      expect(error).toContain("当前 API 未更新");
      expect(error).toContain("三档暂不可改");
      expect(error).not.toContain("请求的路径");
      expect(document.querySelector('[data-testid="write-permission-hint"]')).toBeNull();
      expect(document.querySelector('[data-testid="write-permission-recheck"]')).not.toBeNull();
    } finally { mounted.unmount(); }
  });

  it("改档用带 expected_revision 的版本命令，并以重读后的投影作为生效事实", async () => {
    const views = [readiness(), readiness({ policyDecision: "AUTO", detail: "本次任务内普通编辑连续执行。" })];
    const client = stub(async () => views.shift() ?? readiness({ policyDecision: "AUTO" }));
    const mounted = await mount(client);
    try {
      await click(button("auto"));
      const version = vi.mocked(client.addGatewayPolicyVersion);
      expect(version).toHaveBeenCalledTimes(1);
      expect(version.mock.calls[0]?.[0]).toMatchObject({ projectId, policyId: "policy-1",
        expectedRevision: "7", resourceId, capability: "FILE_WRITE", actionType: "APPLY_CHANGESET",
        decision: "AUTO", maxPayloadBytes: 262144 });
      // 没有只凭自己发出的命令宣布成功：第二次投影读回 AUTO 才写「已生效」。
      expect(vi.mocked(client.getWriteReadiness)).toHaveBeenCalledTimes(2);
      expect(chip()?.textContent).toContain("本次任务自动");
      expect(document.querySelector('[data-testid="write-permission-confirmed"]')?.textContent)
        .toContain("已生效：本次任务自动");
      expect(vi.mocked(client.createGatewayPolicy)).not.toHaveBeenCalled();
    } finally { mounted.unmount(); }
  });

  it("命中上层受管根时只读显示，不在这里改别人的档位", async () => {
    const client = stub(async () => readiness({ policyTargetPrefix: "D:\\Develop" }));
    const mounted = await mount(client);
    try {
      expect(button("auto")?.disabled).toBe(true);
      expect(button("none")?.disabled).toBe(true);
      expect(document.querySelector('[data-testid="write-permission-hint"]')?.textContent)
        .toContain("上层目录");
      expect(vi.mocked(client.addGatewayPolicyVersion)).not.toHaveBeenCalled();
    } finally { mounted.unmount(); }
  });

  it("缺写入连接时禁用三档，并指向「连接与权限」而不是让人猜", async () => {
    const client = stub(async () => readiness({ status: "NEEDS_CONNECTION", detail: "本项目还没有绑定该目录的文件写入连接。",
      policyDecision: null, policyId: null, policyRevision: null, policyTargetPrefix: null }));
    const mounted = await mount(client);
    try {
      expect(chip()?.textContent).toContain("未开放写入");
      for (const tier of ["ask", "auto", "none"]) expect(button(tier)?.disabled).toBe(true);
      expect(document.querySelector('[data-testid="write-permission-hint"]')?.textContent)
        .toContain("本项目还没有绑定该目录的文件写入连接");
      const link = document.querySelector<HTMLAnchorElement>('[data-testid="write-permission"] a');
      expect(link?.getAttribute("href")).toBe(`/projects/${projectId}/connections`);
    } finally { mounted.unmount(); }
  });

  it("丢响应后保留原 command_id：查回执成功才清待核对", async () => {
    const views = [readiness({ status: "NEEDS_PERMISSION", detail: "执行时会逐次请求动作批准。",
      policyDecision: null, policyId: null, policyRevision: null, policyTargetPrefix: null }), readiness()];
    const client = stub(async () => views.shift() ?? readiness(), {
      createGatewayPolicy: vi.fn(async () => { throw new TypeError("response lost after commit"); }),
    });
    const mounted = await mount(client);
    try {
      await click(button("ask"));
      expect(document.querySelector('[data-testid="write-permission-pending"]')).not.toBeNull();
      const pendingText = document.querySelector('[data-testid="write-permission-pending"]')?.textContent ?? "";
      const commandId = /原 command_id：([0-9a-f-]{36})/u.exec(pendingText)?.[1];
      expect(commandId).toBeTruthy();
      await click(document.querySelector('[data-testid="write-permission-receipt"]'));
      const receipt = vi.mocked(client.getCommandReceipt);
      expect(receipt).toHaveBeenCalledWith(commandId);
      expect(document.querySelector('[data-testid="write-permission-pending"]')).toBeNull();
      expect(document.querySelector('[data-testid="write-permission-confirmed"]')?.textContent)
        .toContain("已生效：每次确认");
    } finally { mounted.unmount(); }
  });
});
