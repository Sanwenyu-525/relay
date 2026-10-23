import { createElement } from "react";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import WritePermissionControl from "../src/components/WritePermissionControl";
import { RelayApiError } from "../src/api/relayClient";
import type { RelayApiClient, RelayWriteReadiness, RelayWorkspaceDefaultDirectory } from "../src/api/relayClient";
import { flush, mountReact } from "./mountApp";

/**
 * 对话页「本目录写入档位」入口的契约测试（工作台 §18.1，tool-adapters §1.2）。
 *
 * 这里锁的是客户端行为：档位文案来自服务端投影、改档用带 expected_revision 的版本命令、
 * 提交后必须重读投影、丢响应时保留原 command_id。真实准入判定由 API 集成测试证明。
 *
 * 2026-10-22（DEV-0115）加了一半：没有目录时三行不再是死灰——它们写的是**工作区默认档位**
 * （「以后新开的目录按哪一档起步」），芯片只读档位名（同日用户指令去掉「默认 · 」前缀），
 * 上方状态行仍如实保留「未就绪（未绑定目录）」。同日第二轮指令「选择权限后菜单底部不要出现
 * 文字」：改档成功不再回显一句「已保存／已生效」，只有投影与点的那一行不一致时才留一句说明。
 * 同日第三轮两条：「删除只读权限」→ 菜单只留请求批准／自动批准／完全访问三行（服务端返回
 * READ_ONLY 时芯片仍读「只读」）；「切换权限的时候会闪一下」→ 在途与结果不明拆成两个状态，
 * 普通提交不再弹出整块待核对诊断、也不把三行一起压灰（见末尾两条 data-busy 用例）。
 */

const projectId = "22222222-2222-4222-8222-222222222222";
const resourceId = "33333333-3333-4333-8333-333333333333";
const workspaceId = "11111111-1111-4111-8111-111111111111";
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

/** 工作区默认投影：没有目录时 `resourceId`/`canonicalRoot` 都是 null，档位也可以还没选。 */
function workspaceDefault(over: Partial<RelayWorkspaceDefaultDirectory> = {}): RelayWorkspaceDefaultDirectory {
  return { resourceId: null, canonicalRoot: null, displayName: null, writeTier: null,
    defaultWriteTier: null, status: "UNSET", reason: null, revision: "0", ...over };
}

function stub(getWriteReadiness: () => Promise<RelayWriteReadiness>, over: Partial<RelayApiClient> = {}) {
  return {
    workspaceId,
    getWriteReadiness: vi.fn(getWriteReadiness),
    getWorkspaceDefaultDirectory: vi.fn(async () => workspaceDefault()),
    setWorkspaceDefaultWriteTier: vi.fn(async () => ({ workspaceId, defaultWriteTier: "ASK" as const,
      revision: "1" })),
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

/** 样式表里是否存在选择器含指定片段的规则（jsdom 的 getComputedStyle 不解析 var()，只能按规则断言）。 */
function hasCssRule(fragment: string): boolean {
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule && rule.selectorText.includes(fragment)) return true;
    }
  }
  return false;
}

/** 停在在途窗口的写命令：测试自己决定它何时返回，用来观察提交那几百毫秒里的菜单。 */
function gate<T>(value: T) {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, release: async (): Promise<void> => {
    await act(async () => {
      resolve(value);
      await new Promise<void>((done) => window.setTimeout(done, 30));
    });
  } };
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
  it("菜单只有三档，档位文案来自服务端投影，每档一行短说明", async () => {
    const client = stub(async () => readiness({ policyDecision: "AUTO" }));
    const mounted = await mount(client);
    try {
      expect(chip()?.textContent).toContain("自动批准");
      expect(button("ask")?.getAttribute("aria-pressed")).toBe("false");
      expect(button("auto")?.getAttribute("aria-pressed")).toBe("true");
      const menu = document.querySelector('[data-testid="write-permission"]')?.textContent ?? "";
      expect(menu).toContain("本目录新建、修改与删除免确认");
      expect(menu).toContain("任务内编辑自动，删除仍确认");
      // 2026-10-19 用户指令「删除尚未选择工作目录…选择目录并归入项目这几个」：
      // 菜单里除三档外不再有任何整行文字，目录与缺的前置条件只写在芯片悬停说明里。
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
      // 2026-10-22 用户指令「删除只读权限」：只读这一行不再出现在菜单里。
      expect(button("none")).toBeNull();
      expect(menu).not.toContain("只读");
    } finally { mounted.unmount(); }
  });

  it("三行图标轮廓互不相同，策略同为 AUTO 时按目录档位读出「完全访问」", async () => {
    const client = stub(async () => fullAccess());
    const mounted = await mount(client);
    try {
      expect(chip()?.textContent).toContain("完全访问");
      expect(chip()?.getAttribute("data-tier")).toBe("full");
      const icons = ["ask", "auto", "full"].map((choice) =>
        button(choice)?.querySelector("svg")?.getAttribute("class") ?? null);
      expect(new Set(icons).size).toBe(3);
      // 伸手问／自动放行按能力选；完全访问按 2026-10-19 用户指令用危险符号。
      expect(icons).toEqual([expect.stringContaining("lucide-hand"), expect.stringContaining("lucide-circle-check"),
        expect.stringContaining("lucide-triangle-alert")]);
      expect(button("full")?.getAttribute("data-tier")).toBe("full");
      expect(button("full")?.getAttribute("aria-pressed")).toBe("true");
      expect(button("auto")?.getAttribute("aria-pressed")).toBe("false");
    } finally { mounted.unmount(); }
  });

  it("没有选择目录时三行仍可选，选的是工作区默认档位而不是此刻的权限", async () => {
    // 2026-10-22 用户指令「未选择目录时这个权限选择不了，我需要什么时候都能选择」：
    // 之前这里四行全灰、只有悬停一句「先选择目录并归入项目」。现在三行写的是**默认档位**
    // ——服务端在新建那个目录的管理指针时套用；此刻仍然写不了，所以芯片带「默认」前缀、
    // data-tier 仍是 unbound（输入卡上方的摘要行据此继续读「未就绪（未绑定目录）」）。
    const client = stub(async () => readiness());
    const mounted = await mountProps({ client, projectId: null, resourceId: null, canonicalRoot: null });
    try {
      expect(chip()?.textContent).toContain("不可写入");
      expect(chip()?.textContent).not.toContain("未选择目录");
      expect(chip()?.getAttribute("data-tier")).toBe("unbound");
      expect(chip()?.getAttribute("title")).toContain("还没有目录");
      expect(chip()?.getAttribute("title")).toContain("以后新开的目录按它起步");
      const menu = document.querySelector('[data-testid="write-permission"]')?.textContent ?? "";
      const offeredTiers = Array.from(document.querySelectorAll(".agent-chat-permission-row-title"))
        .map((node) => node.textContent ?? "");
      expect(offeredTiers).toEqual(["请求批准", "自动批准", "完全访问"]);
      expect(offeredTiers).not.toContain("不可写入");
      // 说的是「新开的目录」，不假装这一档现在就作用在某个目录上。
      expect(menu).toContain("新开的目录");
      for (const tier of ["ask", "auto", "full"]) expect(button(tier)?.disabled).toBe(false);
      // 没有目录就不查目录投影；查的是工作区默认这一条。
      expect(vi.mocked(client.getWriteReadiness)).not.toHaveBeenCalled();
      expect(vi.mocked(client.getWorkspaceDefaultDirectory)).toHaveBeenCalledTimes(1);
    } finally { mounted.unmount(); }
  });

  it("目录已选但未归入项目时同样可选，悬停说明带上这个目录", async () => {
    const client = stub(async () => readiness());
    const mounted = await mountProps({ client, projectId: null, resourceId: null, canonicalRoot: root });
    try {
      expect(chip()?.getAttribute("data-tier")).toBe("unbound");
      expect(chip()?.getAttribute("title")).toContain(root);
      for (const tier of ["ask", "auto", "full"]) expect(button(tier)?.disabled).toBe(false);
      expect(vi.mocked(client.getWriteReadiness)).not.toHaveBeenCalled();
    } finally { mounted.unmount(); }
  });

  it("绑定目录后不读工作区默认档位：默认只服务还没有目录的那一处", async () => {
    const client = stub(async () => readiness());
    const mounted = await mount(client);
    try {
      expect(vi.mocked(client.getWorkspaceDefaultDirectory)).not.toHaveBeenCalled();
      expect(chip()?.textContent).toContain("请求批准");
      expect(chip()?.textContent).not.toContain("默认");
    } finally { mounted.unmount(); }
  });

  it("默认档位设置发一条带 expected_revision 的工作区命令，重读投影后才换芯片档位", async () => {
    const views = [workspaceDefault({ revision: "0" }),
      workspaceDefault({ defaultWriteTier: "ASK", revision: "1" })];
    const client = stub(async () => readiness(), {
      getWorkspaceDefaultDirectory: vi.fn(async () => views.shift() ?? workspaceDefault({ defaultWriteTier: "ASK", revision: "1" })),
    });
    const mounted = await mountProps({ client, projectId: null, resourceId: null, canonicalRoot: null });
    try {
      await click(button("ask"));
      const update = vi.mocked(client.setWorkspaceDefaultWriteTier);
      expect(update).toHaveBeenCalledTimes(1);
      expect(update.mock.calls[0]?.[0]).toMatchObject({ expectedRevision: "0", tier: "ASK" });
      // 没有只凭自己发出的命令宣布成功：第二次投影读回 ASK 才把芯片换成那一档。
      expect(vi.mocked(client.getWorkspaceDefaultDirectory)).toHaveBeenCalledTimes(2);
      expect(chip()?.textContent).toContain("请求批准");
      expect(chip()?.textContent).not.toContain("默认");
      // 此刻仍没有目录可写：芯片文字与档位名相同，data-tier 仍是 unbound。
      expect(chip()?.getAttribute("data-tier")).toBe("unbound");
      expect(chip()?.getAttribute("data-default-tier")).toBe("ask");
      // 2026-10-22 用户指令：设置成功时菜单底部不再出现一句「已保存」。
      expect(document.querySelector('[data-testid="write-permission-confirmed"]')).toBeNull();
    } finally { mounted.unmount(); }
  });

  it("默认完全访问把危险色带上芯片，行内说明仍说新开的目录", async () => {
    const views = [workspaceDefault({ revision: "0" }), workspaceDefault({ defaultWriteTier: "FULL", revision: "1" })];
    const client = stub(async () => readiness(), {
      getWorkspaceDefaultDirectory: vi.fn(async () => views.shift() ??
        workspaceDefault({ defaultWriteTier: "FULL", revision: "1" })),
    });
    const mounted = await mountProps({ client, projectId: null, resourceId: null, canonicalRoot: null });
    try {
      await click(button("full"));
      expect(vi.mocked(client.setWorkspaceDefaultWriteTier).mock.calls[0]?.[0])
        .toMatchObject({ expectedRevision: "0", tier: "FULL" });
      expect(chip()?.textContent).toContain("完全访问");
      expect(chip()?.getAttribute("data-default-tier")).toBe("full");
      expect(document.querySelector(".agent-chat-permission-row[data-tier=\"full\"]")
        ?.getAttribute("data-current")).toBe("true");
    } finally { mounted.unmount(); }
  });

  it("默认档位丢响应后先核对一次回执，查不到时重试仍发同一份载荷", async () => {
    let revision = "0";
    const client = stub(async () => readiness(), {
      getWorkspaceDefaultDirectory: vi.fn(async () => workspaceDefault({ revision })),
      setWorkspaceDefaultWriteTier: vi.fn(async () => { throw new TypeError("response lost"); }),
      getCommandReceipt: vi.fn(async () => { throw notFound(); }),
    });
    const mounted = await mountProps({ client, projectId: null, resourceId: null, canonicalRoot: null });
    try {
      await click(button("auto"));
      const first = vi.mocked(client.setWorkspaceDefaultWriteTier).mock.calls[0]?.[0];
      expect(first?.expectedRevision).toBe("0");
      expect(vi.mocked(client.getCommandReceipt)).toHaveBeenCalledTimes(1);
      revision = "5";
      await click(document.querySelector('[data-testid="write-permission-retry"]'));
      const calls = vi.mocked(client.setWorkspaceDefaultWriteTier).mock.calls;
      expect(calls).toHaveLength(2);
      // 重试发的是待核对里冻住的那一份，不按当前投影重建 expected_revision。
      expect(calls[1]?.[0]).toBe(first);
      expect(document.querySelector('[data-testid="write-permission-diagnostics"]')?.textContent)
        .toContain("SetWorkspaceDefaultWriteTier");
    } finally { mounted.unmount(); }
  });

  it("旧版 API 没有默认档位这条查询时说清暂不可设，四行不发命令", async () => {
    const client = stub(async () => readiness(), {
      getWorkspaceDefaultDirectory: vi.fn(async () => { throw new RelayApiError({ status: 404,
        code: "NOT_FOUND", detail: "请求的路径在当前服务上不存在。", retryable: false, retryAction: null,
        fieldErrors: [], expectedRevision: null, actualRevision: null }); }),
    });
    const mounted = await mountProps({ client, projectId: null, resourceId: null, canonicalRoot: null });
    try {
      const error = document.querySelector('[data-testid="write-permission-error"]')?.textContent ?? "";
      expect(error).toContain("当前 API 未更新");
      expect(error).toContain("默认档位暂不可设");
      for (const tier of ["ask", "auto", "full"]) expect(button(tier)?.disabled).toBe(true);
      await click(button("ask"));
      expect(vi.mocked(client.setWorkspaceDefaultWriteTier)).not.toHaveBeenCalled();
    } finally { mounted.unmount(); }
  });

  it("三行因服务端状态全禁用时，菜单里读出一句原因和一个下一步", async () => {
    // 2026-10-21 用户指认「权限选择下拉框选项是禁用状态」：变灰本身是对的（闸门不放宽），
    // 错在什么都不说。这条锁的是「禁用必须可读」，不是「禁用必须可点」。
    const client = stub(async () => readiness({ status: "RESOURCE_BUSY",
      detail: "该实际工作目录正被其他动作占用或隔离。", policyDecision: null, policyId: null,
      policyRevision: null, policyTargetPrefix: null }));
    const mounted = await mount(client);
    try {
      for (const tier of ["ask", "auto", "full"]) expect(button(tier)?.disabled).toBe(true);
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

  it("没有目录时菜单里不再出现禁用原因这一行，也不给点了没用的核对键", async () => {
    // 三行已可选，禁用说明就失去了存在前提；目录档位的「重新核对」键更没有作用域可查。
    const client = stub(async () => readiness());
    const mounted = await mountProps({ client, projectId: null, resourceId: null, canonicalRoot: null });
    try {
      expect(document.querySelector('[data-testid="write-permission-reason"]')).toBeNull();
      expect(document.querySelector('[data-testid="write-permission-recheck-tier"]')).toBeNull();
      for (const tier of ["ask", "auto", "full"]) expect(button(tier)?.disabled).toBe(false);
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
      // 没有只凭自己发出的命令宣布成功：第二次投影读回 AUTO 才把芯片换成那一档。
      expect(vi.mocked(client.getWriteReadiness)).toHaveBeenCalledTimes(2);
      expect(chip()?.textContent).toContain("自动批准");
      // 2026-10-22 用户指令：芯片读回的档位就是确认，菜单底部不再补一句「已生效」。
      expect(document.querySelector('[data-testid="write-permission-confirmed"]')).toBeNull();
    } finally { mounted.unmount(); }
  });

  it("点完全访问这一行发出 tier=FULL，读回 FULL 后芯片才换成完全访问", async () => {
    const views = [readiness(), fullAccess()];
    const client = stub(async () => views.shift() ?? fullAccess());
    const mounted = await mount(client);
    try {
      await click(button("full"));
      expect(vi.mocked(client.setLocalDirectoryWriteTier).mock.calls[0]?.[0])
        .toMatchObject({ projectId, resourceId, expectedRevision: "7", tier: "FULL" });
      expect(chip()?.getAttribute("data-tier")).toBe("full");
      expect(chip()?.textContent).toContain("完全访问");
      expect(document.querySelector('[data-testid="write-permission-confirmed"]')).toBeNull();
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
      for (const tier of ["ask", "auto", "full"]) expect(button(tier)?.disabled).toBe(false);
      await click(button("ask"));
      expect(vi.mocked(client.setLocalDirectoryWriteTier)).toHaveBeenCalledWith(expect.objectContaining({
        projectId, resourceId, expectedRevision: "7", tier: "ASK" }));
    } finally { mounted.unmount(); }
  });

  it("响应丢失但服务端已保存：程序自动核对到回执，芯片直接读回已生效的档位", async () => {
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
      // 核对到的事实写在芯片上（重读投影为 ASK），不再在菜单底部复述一句。
      expect(chip()?.getAttribute("data-tier")).toBe("ask");
      expect(document.querySelector('[data-testid="write-permission-confirmed"]')).toBeNull();
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
  it("服务端投影为只读时芯片读「只读」，三行仍可选但没有一行高亮", async () => {
    const client = stub(async () => readiness({ status: "READ_ONLY", writeTier: "READ_ONLY",
      policyDecision: null, policyId: null, policyRevision: null, policyTargetPrefix: null,
      detail: "本目录当前为只读；请求写入会逐次询问。" }));
    const mounted = await mount(client);
    try {
      expect(chip()?.textContent).toContain("只读");
      expect(chip()?.getAttribute("data-tier")).toBe("none");
      // 只读是一条可调整的档位，不是「写不了」的结论，因此不能读成禁用态。
      for (const tier of ["ask", "auto", "full"]) expect(button(tier)?.disabled).toBe(false);
      expect(document.querySelector('[data-testid="write-permission-reason"]')).toBeNull();
      // 2026-10-22 用户指令「删除只读权限」的代价：菜单里不再有的那一行，芯片如实读回档位，
      // 因此当前档位落在菜单之外——这里不假装某一档仍指向这一处。
      expect(button("none")).toBeNull();
      for (const tier of ["ask", "auto", "full"]) {
        expect(button(tier)?.getAttribute("data-current")).toBe("false");
        expect(button(tier)?.getAttribute("aria-pressed")).toBe("false");
      }
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
      for (const tier of ["ask", "auto", "full"]) expect(button(tier)?.disabled).toBe(true);
      expect(document.querySelector('[data-testid="write-permission-reason"]')?.textContent)
        .toContain("提交中，稍后再改");
      // READY 状态本身可调整，这一步不需要的「重新核对」键不应冒充下一步。
      expect(document.querySelector('[data-testid="write-permission-recheck-tier"]')).toBeNull();
    } finally { mounted.unmount(); }
  });

  it("普通改档的在途窗口不弹待核对块、不压灰菜单，只让刚点那一行变淡", async () => {
    // 2026-10-22 用户指认「切换权限的时候会闪一下」。真实 Chromium 逐帧量到的闪源（未绑定目录那一处）：
    // 请求发出的那一刻就把整块「保存结果还没确认／重新核对／诊断信息」弹出来，菜单 278→426px、
    // 顶边上跳 148px，三行 opacity 一起 1→0.85，约 500ms 后随回执一起塌回。
    // 契约：在途 ≠ 结果不明。这里断言的是那一刻菜单里**没有**诊断块、**没有**多出的文字。
    const held = gate({ commandId: "c1", committedAt: "2026-10-22T00:00:00Z", result: {} });
    const views = [readiness(), readiness({ policyDecision: "AUTO", writeTier: "AUTO",
      detail: "本次任务内普通编辑连续执行。" })];
    const client = stub(async () => views.shift() ?? readiness({ policyDecision: "AUTO" }), {
      setLocalDirectoryWriteTier: vi.fn(() => held.promise),
    });
    const mounted = await mount(client);
    try {
      await click(button("auto"));
      const menu = document.querySelector(".agent-chat-permission-menu");
      expect(menu?.getAttribute("data-busy")).toBe("true");
      expect(document.querySelector('[data-testid="write-permission-pending"]')).toBeNull();
      expect(document.querySelector('[data-testid="write-permission-error"]')).toBeNull();
      expect(document.querySelector('[data-testid="write-permission-reason"]')).toBeNull();
      expect(document.querySelector('[data-testid="write-permission-confirmed"]')).toBeNull();
      expect(menu?.textContent).not.toContain("还没核对");
      // 三行仍禁用（防重复提交），但禁用配色由 data-busy 覆盖，不退成灰字。
      for (const tier of ["ask", "auto", "full"]) expect(button(tier)?.disabled).toBe(true);
      expect(hasCssRule('.agent-chat-permission-menu[data-busy="true"] .agent-chat-permission-row:disabled')).toBe(true);
      // 在途标记只落在刚点那一行，别的行不跟着变。
      expect(button("auto")?.getAttribute("data-pending")).toBe("true");
      expect(button("ask")?.hasAttribute("data-pending")).toBe(false);
      expect(button("full")?.hasAttribute("data-pending")).toBe(false);
      await held.release();
      expect(menu?.hasAttribute("data-busy")).toBe(false);
      expect(document.querySelector('[data-testid="write-permission-pending"]')).toBeNull();
      // 重读回来的档位就是确认：芯片换成自动批准，菜单底部不补一句话。
      expect(chip()?.getAttribute("data-tier")).toBe("auto");
      expect(document.querySelector('[data-testid="write-permission-confirmed"]')).toBeNull();
    } finally { mounted.unmount(); }
  });

  it("没有目录时设置默认档位同样不在途窗口弹块，也不多说一句「还没核对完」", async () => {
    // 同一件事在工作区默认这一条上也成立：DEV-0115 之后这条路径是用户最常点的那一条。
    // 真正结果不明时才弹出这一块，见「自动核对查不到回执时只说结果」。
    const held = gate({ workspaceId, defaultWriteTier: "ASK" as const, revision: "1" });
    const client = stub(async () => readiness(), {
      getWorkspaceDefaultDirectory: vi.fn(async () => workspaceDefault({ defaultWriteTier: "ASK", revision: "1" })),
      setWorkspaceDefaultWriteTier: vi.fn(() => held.promise),
    });
    const mounted = await mountProps({ client, projectId: null, resourceId: null, canonicalRoot: null });
    try {
      await click(button("ask"));
      expect(document.querySelector(".agent-chat-permission-menu")?.getAttribute("data-busy")).toBe("true");
      expect(document.querySelector('[data-testid="write-permission-pending"]')).toBeNull();
      expect(document.querySelector('[data-testid="write-permission-reason"]')).toBeNull();
      await held.release();
      expect(chip()?.textContent).toContain("请求批准");
      expect(chip()?.getAttribute("data-default-tier")).toBe("ask");
      expect(document.querySelector('[data-testid="write-permission-pending"]')).toBeNull();
    } finally { mounted.unmount(); }
  });
});
