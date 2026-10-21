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

/** 服务端没有这条命令的回执：自动核对会走到「还没查到结果」这一档。 */
function notFound(): RelayApiError {
  return new RelayApiError({ status: 404, code: "COMMAND_NOT_FOUND", detail: "命令回执不存在。",
    retryable: false, retryAction: null, fieldErrors: [], expectedRevision: null, actualRevision: null });
}

afterEach(() => { vi.restoreAllMocks(); });

it("丢响应后原命令重试仍保留首次提交的完整载荷", async () => {
  let revision = "7";
  const client = stub(async () => readiness({ accessRevision: revision }), {
    setLocalDirectoryWriteTier: vi.fn(async () => { throw new TypeError("response lost"); }),
    getCommandReceipt: vi.fn(async () => { throw notFound(); }),
  });
  const mounted = await mount(client);
  try {
    await click(button("auto"));
    const first = vi.mocked(client.setLocalDirectoryWriteTier).mock.calls[0]?.[0];
    expect(first?.expectedRevision).toBe("7");
    // 结果不明时先由程序核对一次回执（有界，不轮询）；查不到才把重试交给用户。
    expect(vi.mocked(client.getCommandReceipt)).toHaveBeenCalledTimes(1);
    revision = "8";
    await click(document.querySelector('[data-testid="write-permission-retry"]'));
    const calls = vi.mocked(client.setLocalDirectoryWriteTier).mock.calls;
    expect(calls).toHaveLength(2);
    // 重试发的是待核对里冻住的那一份请求对象，不按当前投影重建 expected_revision。
    expect(calls[1]?.[0]).toBe(first);
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
  it("菜单只有四档，档位文案来自服务端投影，每档一行短说明", async () => {
    const client = stub(async () => readiness({ policyDecision: "AUTO" }));
    const mounted = await mount(client);
    try {
      expect(chip()?.textContent).toContain("自动批准");
      expect(button("ask")?.getAttribute("aria-pressed")).toBe("false");
      expect(button("auto")?.getAttribute("aria-pressed")).toBe("true");
      const menu = document.querySelector('[data-testid="write-permission"]')?.textContent ?? "";
      expect(menu).toContain("本目录内新建、修改与删除免确认");
      expect(menu).toContain("任务内普通编辑自动，删除仍确认");
      // 2026-10-19 用户指令「删除尚未选择工作目录…选择目录并归入项目这几个」：
      // 菜单里除四档外不再有任何整行文字，目录与缺的前置条件只写在芯片悬停说明里。
      expect(menu).not.toContain("MyProject");
      expect(menu).not.toContain("先选择");
      expect(document.querySelector(".agent-chat-permission-head")).toBeNull();
      expect(document.querySelector(".agent-chat-permission-hint")).toBeNull();
      expect(chip()?.getAttribute("title")).toContain(root);
      // 2026-10-19 用户指令「删除底部的文字」：菜单不再挂整宽脚注，Git／CLI 的边界只留在文档里。
      expect(menu).not.toContain("Git 与 CLI");
      expect(document.querySelector(".agent-chat-permission-footnote")).toBeNull();
      // 用户实机反馈「一大堆字」：菜单是操作面，不是说明文档，正文必须保持短。
      expect(menu.replace(/\s+/gu, "").length).toBeLessThan(80);
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
      // 伸手问／自动放行／只能看按能力选；完全访问按 2026-10-19 用户指令用危险符号。
      expect(icons).toEqual([expect.stringContaining("lucide-hand"), expect.stringContaining("lucide-circle-check"),
        expect.stringContaining("lucide-triangle-alert"), expect.stringContaining("lucide-eye")]);
      expect(button("full")?.getAttribute("data-tier")).toBe("full");
      expect(button("full")?.getAttribute("aria-pressed")).toBe("true");
      expect(button("auto")?.getAttribute("aria-pressed")).toBe("false");
    } finally { mounted.unmount(); }
  });

  it("没有选择目录时芯片仍常驻，读作权限「不可写入」，缺什么写在悬停说明", async () => {
    const client = stub(async () => readiness());
    const mounted = await mountProps({ client, projectId: null, resourceId: null, canonicalRoot: null });
    try {
      // 2026-10-18 用户指认「这个下拉框功能是调整权限，默认状态不应该显示未选择目录」：
      // 芯片只回答权限是什么；没目录＝什么都写不了，因此读作「不可写入」。
      // 2026-10-21 措辞修正：原「未开放写入」会被读成「未开发写入」（＝功能没做），
      // 而且不像任何档位——服务端可存的档位只有 READ_ONLY/ASK/AUTO/FULL 四档。
      expect(chip()?.textContent).toContain("不可写入");
      expect(chip()?.textContent).not.toContain("未选择目录");
      expect(chip()?.getAttribute("data-tier")).toBe("unbound");
      expect(chip()?.getAttribute("title")).toContain("先选择目录并归入项目");
      // 缺的事实在悬停说明里，不占菜单一行。
      expect(document.querySelector('[data-testid="write-permission"]')?.textContent)
        .not.toContain("尚未选择工作目录");
      // 菜单里能选的只有服务端那四档（`RelayWriteTier`）；芯片读出的「不可写入」是一个状态，
      // 不会作为第五行档位出现（2026-10-21 用户指认「未开放写入这个权限是从哪来的」）。
      const offeredTiers = Array.from(document.querySelectorAll(".agent-chat-permission-row-title"))
        .map((node) => node.textContent ?? "");
      expect(offeredTiers).toEqual(["请求批准", "自动批准", "完全访问", "只读"]);
      expect(offeredTiers).not.toContain("不可写入");
      expect(button("ask")?.disabled).toBe(true);
      expect(button("auto")?.disabled).toBe(true);
      expect(button("full")?.disabled).toBe(true);
      expect(button("none")?.disabled).toBe(true);
      expect(vi.mocked(client.getWriteReadiness)).not.toHaveBeenCalled();
    } finally { mounted.unmount(); }
  });

  it("目录已选但未归入项目时，芯片仍读权限，缺的是项目归属由悬停说明", async () => {
    const client = stub(async () => readiness());
    const mounted = await mountProps({ client, projectId: null, resourceId: null, canonicalRoot: root });
    try {
      expect(chip()?.textContent).toContain("不可写入");
      expect(chip()?.getAttribute("title")).toContain("先把这个目录归入项目");
      expect(document.querySelector('[data-testid="write-permission"]')?.textContent)
        .not.toContain("这个目录还没有归入项目");
      expect(vi.mocked(client.getWriteReadiness)).not.toHaveBeenCalled();
    } finally { mounted.unmount(); }
  });

  it("四行因服务端状态全禁用时，菜单里读出一句原因和一个下一步", async () => {
    // 2026-10-21 用户指认「权限选择下拉框选项是禁用状态」：变灰本身是对的（闸门不放宽），
    // 错在什么都不说。这条锁的是「禁用必须可读」，不是「禁用必须可点」。
    const client = stub(async () => readiness({ status: "RESOURCE_BUSY",
      detail: "该实际工作目录正被其他动作占用或隔离。", policyDecision: null, policyId: null,
      policyRevision: null, policyTargetPrefix: null }));
    const mounted = await mount(client);
    try {
      for (const tier of ["ask", "auto", "full", "none"]) expect(button(tier)?.disabled).toBe(true);
      const reason = document.querySelector('[data-testid="write-permission-reason"]');
      // 原因直接引用服务端那句结论，前端不再写第二套说法。
      expect(reason?.textContent).toContain("该实际工作目录正被其他动作占用或隔离");
      // 这类状态点不动，能做的下一步只有重新读一次投影。
      expect(reason?.textContent).toContain("重新核对");
      const recheck = document.querySelector<HTMLButtonElement>('[data-testid="write-permission-recheck-tier"]');
      expect(recheck?.disabled).toBe(false);
      await click(recheck ?? null);
      expect(vi.mocked(client.getWriteReadiness)).toHaveBeenCalledTimes(2);
    } finally { mounted.unmount(); }
  });

  it("没有目录时禁用原因同样出现在菜单里，但不给可点的核对键（没有作用域可查）", async () => {
    const client = stub(async () => readiness());
    const mounted = await mountProps({ client, projectId: null, resourceId: null, canonicalRoot: null });
    try {
      expect(document.querySelector('[data-testid="write-permission-reason"]')?.textContent)
        .toContain("先选择目录并归入项目");
      expect(document.querySelector('[data-testid="write-permission-recheck-tier"]')).toBeNull();
    } finally { mounted.unmount(); }
  });

  it("旧版 API 没有只读查询时只留一行错误说明，不额外挂提示行", async () => {
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
      expect(document.querySelector('[data-testid="write-permission-recheck"]')).toBeNull();
      // 唯一的错误行仍在菜单里，重开菜单即重新核对（菜单头按钮已按用户指令删除）。
      expect(chip()?.getAttribute("title")).toContain("当前 API 未更新");
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
      expect(chip()?.textContent).toContain("不可写入");
      for (const tier of ["ask", "auto", "full", "none"]) expect(button(tier)?.disabled).toBe(false);
      await click(button("ask"));
      expect(vi.mocked(client.setLocalDirectoryWriteTier)).toHaveBeenCalledWith(expect.objectContaining({
        projectId, resourceId, expectedRevision: "7", tier: "ASK" }));
    } finally { mounted.unmount(); }
  });

  it("响应丢失但服务端已保存：程序自动核对到回执，直接显示已生效", async () => {
    const views = [readiness({ status: "NEEDS_PERMISSION", detail: "执行时会逐次请求动作批准。",
      policyDecision: null, policyId: null, policyRevision: null, policyTargetPrefix: null }), readiness()];
    const client = stub(async () => views.shift() ?? readiness(), {
      setLocalDirectoryWriteTier: vi.fn(async () => { throw new TypeError("response lost after commit"); }),
      // 服务端其实已经提交：回执按同一 command_id 读得到。
      getCommandReceipt: vi.fn(async (id: string) => ({ commandId: id, commandType: "SetLocalDirectoryWriteTier",
        committedAt: "2026-10-17T00:00:00Z", result: {} })),
    });
    const mounted = await mount(client);
    try {
      await click(button("ask"));
      const commandId = vi.mocked(client.setLocalDirectoryWriteTier).mock.calls[0]?.[0].commandId;
      // 用户不需要点任何「查询回执」：程序已经核对过一次。
      expect(vi.mocked(client.getCommandReceipt)).toHaveBeenCalledWith(commandId);
      expect(document.querySelector('[data-testid="write-permission-pending"]')).toBeNull();
      expect(document.querySelector('[data-testid="write-permission-confirmed"]')?.textContent)
        .toContain("已生效：请求批准");
    } finally { mounted.unmount(); }
  });

  it("自动核对查不到回执时只说结果，原标识收在可展开诊断里", async () => {
    const client = stub(async () => readiness({ status: "NEEDS_PERMISSION", detail: "执行时会逐次请求动作批准。",
      policyDecision: null, policyId: null, policyRevision: null, policyTargetPrefix: null }), {
      setLocalDirectoryWriteTier: vi.fn(async () => { throw new TypeError("response lost"); }),
      getCommandReceipt: vi.fn(async () => { throw notFound(); }),
    });
    const mounted = await mount(client);
    try {
      await click(button("ask"));
      const pending = document.querySelector('[data-testid="write-permission-pending"]');
      expect(pending).not.toBeNull();
      const text = pending?.textContent ?? "";
      // 主行读的是结果，不是命令协议。
      expect(text).toContain("保存结果还没确认");
      expect(text).not.toContain("command_id");
      expect(text).toContain("重新核对");
      expect(text).toContain("重试保存");
      // 原标识仍然保留（可核对），但只在诊断里。
      const diagnostics = document.querySelector('[data-testid="write-permission-diagnostics"]');
      expect(diagnostics?.textContent).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u);
      expect(document.querySelector('[data-testid="write-permission-error"]')?.textContent)
        .toContain("还没查到这次保存的结果");
    } finally { mounted.unmount(); }
  });

  // 2026-10-21 第三轮 R3-05：实机 reported「权限不能点击」经核对是 UIA 索引点击与鼠标坐标点击的
  // 自动化方式差异，不是人工失败；闸门（canChoose）一行不改，这里只补齐任务书列出的状态覆盖，
  // 证明「能点时能点、不能点时说清为什么＋下一步」。
  it("服务端投影为只读时芯片读「只读」，四档仍可选且不追加原因行", async () => {
    const client = stub(async () => readiness({ status: "READ_ONLY", writeTier: "READ_ONLY",
      policyDecision: null, policyId: null, policyRevision: null, policyTargetPrefix: null,
      detail: "本目录当前为只读；请求写入会逐次询问。" }));
    const mounted = await mount(client);
    try {
      expect(chip()?.textContent).toContain("只读");
      expect(chip()?.getAttribute("data-tier")).toBe("none");
      // 只读是一条可调整的档位，不是「写不了」的结论，因此不能读成禁用态。
      for (const tier of ["ask", "auto", "full", "none"]) expect(button(tier)?.disabled).toBe(false);
      expect(button("none")?.getAttribute("data-current")).toBe("true");
      expect(document.querySelector('[data-testid="write-permission-reason"]')).toBeNull();
      await click(button("ask"));
      expect(vi.mocked(client.setLocalDirectoryWriteTier)).toHaveBeenCalledWith(expect.objectContaining({
        projectId, resourceId, expectedRevision: "7", tier: "ASK" }));
    } finally { mounted.unmount(); }
  });

  it("上层拒绝仍然生效时不假装档位已改，重读后照读「已拒绝写入」并带上服务端结论", async () => {
    const views = [readiness(), readiness({ policyDecision: "DENY", writeTier: null,
      detail: "上层策略已拒绝这一处的写入。" })];
    const client = stub(async () => views.shift() ?? readiness({ policyDecision: "DENY" }));
    const mounted = await mount(client);
    try {
      await click(button("ask"));
      expect(vi.mocked(client.setLocalDirectoryWriteTier)).toHaveBeenCalledTimes(1);
      // 生效与否只认重读后的投影：目录档位命令改的是自己那一层，不能把「已提交」写成「已生效」。
      expect(chip()?.getAttribute("data-tier")).toBe("denied");
      const confirmation = document.querySelector('[data-testid="write-permission-confirmed"]')?.textContent ?? "";
      expect(confirmation).toContain("已拒绝写入");
      expect(confirmation).toContain("上层策略已拒绝这一处的写入");
      expect(confirmation).not.toContain("已生效");
    } finally { mounted.unmount(); }
  });

  it("提交中档位行禁用时，菜单里读出「提交中，稍后再改」而不是静默变灰", async () => {
    const client = stub(async () => readiness());
    const mounted = await mount(client, true);
    try {
      for (const tier of ["ask", "auto", "full", "none"]) expect(button(tier)?.disabled).toBe(true);
      expect(document.querySelector('[data-testid="write-permission-reason"]')?.textContent)
        .toContain("提交中，稍后再改");
      // READY 状态本身可调整，这一步不需要的「重新核对」键不应冒充下一步。
      expect(document.querySelector('[data-testid="write-permission-recheck-tier"]')).toBeNull();
    } finally { mounted.unmount(); }
  });
});
