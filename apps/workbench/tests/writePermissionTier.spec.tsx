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
    policyId: "policy-1", policyRevision: "7", policyTargetPrefix: root,
    writeTier: "ASK", accessRevision: "7", ...over };
}

/** 完全访问与自动批准在策略行上同为 AUTO，只有目录档位这一列能把两者分开。 */
function fullAccess(over: Partial<RelayWriteReadiness> = {}): RelayWriteReadiness {
  return readiness({ policyDecision: "AUTO", writeTier: "FULL",
    detail: "本目录已开放完全访问：目录内的新建、修改与删除不再逐次确认。", ...over });
}

function stub(getWriteReadiness: () => Promise<RelayWriteReadiness>, over: Partial<RelayApiClient> = {}) {
  return {
    getWriteReadiness: vi.fn(getWriteReadiness),
    setLocalDirectoryWriteTier: vi.fn(async () => ({ commandId: "c1", committedAt: "2026-10-17T00:00:00Z", result: {} })),
    getCommandReceipt: vi.fn(async () => ({ commandId: "c1", commandType: "SetLocalDirectoryWriteTier",
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

it("丢响应后重读到新 revision，原命令重试仍保留首次提交的完整载荷", async () => {
  let revision = "7";
  const client = stub(async () => readiness({ accessRevision: revision }), {
    setLocalDirectoryWriteTier: vi.fn(async () => { throw new TypeError("response lost"); }),
  });
  const mounted = await mount(client);
  try {
    await click(button("auto"));
    const first = vi.mocked(client.setLocalDirectoryWriteTier).mock.calls[0]?.[0];
    expect(first?.expectedRevision).toBe("7");
    revision = "8";
    await click(document.querySelector('[data-testid="write-permission-recheck"]'));
    await click(document.querySelector('[data-testid="write-permission-retry"]'));
    const calls = vi.mocked(client.setLocalDirectoryWriteTier).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1]?.[0]).toEqual(first);
    expect(calls[1]?.[0]).toMatchObject({ projectId, resourceId,
      commandId: expect.any(String), expectedRevision: "7", tier: "AUTO" });
  } finally { mounted.unmount(); }
});

it("切换目录或客户端后，不把待核对命令发送到新作用域", async () => {
  const oldClient = stub(async () => readiness(), {
    setLocalDirectoryWriteTier: vi.fn(async () => { throw new TypeError("response lost"); }),
  });
  const newClient = stub(async () => readiness());
  const mounted = await mountProps({ client: oldClient, projectId, resourceId, canonicalRoot: root });
  try {
    await click(button("auto"));
    expect(document.querySelector('[data-testid="write-permission-pending"]')).not.toBeNull();
    await mounted.rerender(createElement(MemoryRouter, null, createElement(WritePermissionControl, {
      client: newClient, projectId: "44444444-4444-4444-8444-444444444444",
      resourceId: "55555555-5555-4555-8555-555555555555", canonicalRoot: "D:\\Develop\\Other" })));
    await flush(0);
    expect(document.querySelector('[data-testid="write-permission-pending"]')).toBeNull();
    expect(vi.mocked(newClient.setLocalDirectoryWriteTier)).not.toHaveBeenCalled();
  } finally { mounted.unmount(); }
});

describe("本目录写入档位", () => {
  it("显示服务端投影的档位，四档各有图标，完全访问说清自己只放宽本目录", async () => {
    const client = stub(async () => readiness({ policyDecision: "AUTO" }));
    const mounted = await mount(client);
    try {
      expect(chip()?.textContent).toContain("自动批准");
      expect(button("ask")?.getAttribute("aria-pressed")).toBe("false");
      expect(button("auto")?.getAttribute("aria-pressed")).toBe("true");
      const menu = document.querySelector('[data-testid="write-permission"]')?.textContent ?? "";
      expect(menu).toContain("完全访问仅本目录文件写入");
      expect(menu).toContain("Git 与 CLI 仍逐次确认");
      expect(menu).toContain(`本目录：MyProject`);
      // 用户实机反馈「一大堆字」：菜单是操作面，不是说明文档，正文必须保持短。
      expect(menu.replace(/\s+/gu, "").length).toBeLessThan(220);
    } finally { mounted.unmount(); }
  });

  it("四档图标轮廓互不相同，策略同为 AUTO 时按目录档位读出「完全访问」", async () => {
    const client = stub(async () => fullAccess());
    const mounted = await mount(client);
    try {
      expect(chip()?.textContent).toContain("完全访问");
      expect(chip()?.getAttribute("data-tier")).toBe("full");
      const icons = ["ask", "auto", "full", "none"].map((choice) =>
        button(choice)?.querySelector("svg")?.getAttribute("class") ?? null);
      expect(new Set(icons).size).toBe(4);
      expect(button("full")?.getAttribute("data-tier")).toBe("full");
      expect(button("full")?.getAttribute("aria-pressed")).toBe("true");
      expect(button("auto")?.getAttribute("aria-pressed")).toBe("false");
    } finally { mounted.unmount(); }
  });

  it("没有选择目录时芯片仍常驻，读作权限「未开放写入」，缺什么写在菜单里", async () => {
    const client = stub(async () => readiness());
    const mounted = await mountProps({ client, projectId: null, resourceId: null, canonicalRoot: null });
    try {
      // 2026-10-18 用户指认「这个下拉框功能是调整权限，默认状态不应该显示未选择目录」：
      // 芯片只回答权限是什么；没目录＝什么都写不了，因此读作「未开放写入」。
      expect(chip()?.textContent).toContain("未开放写入");
      expect(chip()?.textContent).not.toContain("未选择目录");
      expect(chip()?.getAttribute("data-tier")).toBe("unbound");
      // 缺的事实与下一步都在菜单里，不在芯片上复述。
      expect(document.querySelector('[data-testid="write-permission"]')?.textContent)
        .toContain("尚未选择工作目录");
      expect(button("ask")?.disabled).toBe(true);
      expect(button("auto")?.disabled).toBe(true);
      expect(button("full")?.disabled).toBe(true);
      expect(button("none")?.disabled).toBe(true);
      expect(document.querySelector('[data-testid="write-permission-hint"]')?.textContent)
        .toContain("先选择目录并归入项目");
      expect(vi.mocked(client.getWriteReadiness)).not.toHaveBeenCalled();
    } finally { mounted.unmount(); }
  });

  it("目录已选但未归入项目时，芯片仍读权限，缺的是项目归属由菜单说明", async () => {
    const client = stub(async () => readiness());
    const mounted = await mountProps({ client, projectId: null, resourceId: null, canonicalRoot: root });
    try {
      expect(chip()?.textContent).toContain("未开放写入");
      expect(document.querySelector('[data-testid="write-permission"]')?.textContent)
        .toContain("这个目录还没有归入项目");
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
      expect(error).toContain("档位暂不可改");
      expect(error).not.toContain("请求的路径");
      expect(document.querySelector('[data-testid="write-permission-hint"]')).toBeNull();
      expect(document.querySelector('[data-testid="write-permission-recheck"]')).not.toBeNull();
    } finally { mounted.unmount(); }
  });

  it("改档用一个带 expected_revision 的目录命令，并以重读后的投影作为生效事实", async () => {
    const views = [readiness(), readiness({ policyDecision: "AUTO", writeTier: "AUTO",
      detail: "本次任务内普通编辑连续执行。" })];
    const client = stub(async () => views.shift() ?? readiness({ policyDecision: "AUTO" }));
    const mounted = await mount(client);
    try {
      await click(button("auto"));
      const update = vi.mocked(client.setLocalDirectoryWriteTier);
      expect(update).toHaveBeenCalledTimes(1);
      expect(update.mock.calls[0]?.[0]).toMatchObject({ projectId, resourceId,
        expectedRevision: "7", tier: "AUTO" });
      // 没有只凭自己发出的命令宣布成功：第二次投影读回 AUTO 才写「已生效」。
      expect(vi.mocked(client.getWriteReadiness)).toHaveBeenCalledTimes(2);
      expect(chip()?.textContent).toContain("自动批准");
      expect(document.querySelector('[data-testid="write-permission-confirmed"]')?.textContent)
        .toContain("已生效：自动批准");
    } finally { mounted.unmount(); }
  });

  it("点完全访问这一行发出 tier=FULL，读回 FULL 后才写「已生效：完全访问」", async () => {
    const views = [readiness(), fullAccess()];
    const client = stub(async () => views.shift() ?? fullAccess());
    const mounted = await mount(client);
    try {
      await click(button("full"));
      expect(vi.mocked(client.setLocalDirectoryWriteTier).mock.calls[0]?.[0])
        .toMatchObject({ projectId, resourceId, expectedRevision: "7", tier: "FULL" });
      expect(chip()?.getAttribute("data-tier")).toBe("full");
      expect(document.querySelector('[data-testid="write-permission-confirmed"]')?.textContent)
        .toContain("已生效：完全访问");
    } finally { mounted.unmount(); }
  });

  it("历史回执明确展示当前投影档位", async () => {
    const views = [readiness(), readiness({ accessRevision: "8", policyDecision: "AUTO", writeTier: "AUTO" })];
    const client = stub(async () => views.shift() ?? readiness({ accessRevision: "8", policyDecision: "AUTO" }), {
      setLocalDirectoryWriteTier: vi.fn(async () => ({ commandId: "c1",
        committedAt: "2026-10-17T00:00:00Z", result: { revision: "7" } })),
    });
    const mounted = await mount(client);
    try {
      await click(button("ask"));
      const confirmation = document.querySelector('[data-testid="write-permission-confirmed"]')?.textContent ?? "";
      expect(confirmation).toContain("历史命令回执已确认");
      expect(confirmation).toContain("当前档位：自动批准");
    } finally { mounted.unmount(); }
  });

  it("命中上层策略时为当前目录写入自己的范围，不改写上层策略", async () => {
    const client = stub(async () => readiness({ policyTargetPrefix: "D:\\Develop" }));
    const mounted = await mount(client);
    try {
      expect(button("auto")?.disabled).toBe(false);
      await click(button("auto"));
      expect(vi.mocked(client.setLocalDirectoryWriteTier)).toHaveBeenCalledWith(expect.objectContaining({
        projectId, resourceId, tier: "AUTO" }));
    } finally { mounted.unmount(); }
  });

  it("缺写入连接时仍可直接设置目录档位，不要求去高级页创建连接", async () => {
    const client = stub(async () => readiness({ status: "NEEDS_CONNECTION", detail: "本项目还没有绑定该目录的文件写入连接。",
      policyDecision: null, policyId: null, policyRevision: null, policyTargetPrefix: null }));
    const mounted = await mount(client);
    try {
      expect(chip()?.textContent).toContain("未开放写入");
      for (const tier of ["ask", "auto", "full", "none"]) expect(button(tier)?.disabled).toBe(false);
      await click(button("ask"));
      expect(vi.mocked(client.setLocalDirectoryWriteTier)).toHaveBeenCalledWith(expect.objectContaining({
        projectId, resourceId, expectedRevision: "7", tier: "ASK" }));
    } finally { mounted.unmount(); }
  });

  it("丢响应后保留原 command_id：查回执成功才清待核对", async () => {
    const views = [readiness({ status: "NEEDS_PERMISSION", detail: "执行时会逐次请求动作批准。",
      policyDecision: null, policyId: null, policyRevision: null, policyTargetPrefix: null }), readiness()];
    const client = stub(async () => views.shift() ?? readiness(), {
      setLocalDirectoryWriteTier: vi.fn(async () => { throw new TypeError("response lost after commit"); }),
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
        .toContain("已生效：请求批准");
    } finally { mounted.unmount(); }
  });
});
