import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import ConversationDiffSummary from "../src/components/ConversationDiffSummary";
import type { RelayApiClient, RelayConversationDiff, RelayConversationDiffFile } from "../src/api/relayClient";
import { flush, mountReact } from "./mountApp";

// 会话总 diff 的界面口径（工作台 §34.2 / §34.4，CD-01、CD-12、CD-17、CD-18）。
// 口径固定为 B「本轮对话开始以来的净变化」：数字只来自服务端的基线→当前已落盘投影。
// 这里锁状态可辨（统计中 / 空 / 无目录 / 非 Git 根 / 缺基线 / 失权 / 部分不可统计 / 刷新失败）、
// 展开阅读与总数同修订、迟到响应不覆盖新值，以及「从现在开始统计」由用户主动触发。

const changed: Extract<RelayConversationDiff, { available: true }> = {
  available: true, baselineCapturedAt: "2026-10-16T09:00:00Z", baselineRevision: "3",
  rootPath: "D:\\Work\\Demo", resourceId: "res-1", incomplete: false, coverage: null,
  totalFiles: 3, totalAdded: 145, totalRemoved: 8,
  files: [
    { path: "src/a.ts", action: "MODIFY", added: 100, removed: 8, unavailableReason: null },
    { path: "src/b.ts", action: "CREATE", added: 45, removed: 0, unavailableReason: null },
    { path: "src/c.ts", action: "DELETE", added: 0, removed: 0, unavailableReason: null },
  ],
};

function clientOf(over: Partial<RelayApiClient> = {}): RelayApiClient {
  return { getConversationDiff: vi.fn(async () => changed),
    getConversationDiffFile: vi.fn(async (): Promise<RelayConversationDiffFile> => ({ available: true,
      path: "src/a.ts", action: "MODIFY", added: 100, removed: 8, unavailableReason: null,
      rows: [{ kind: "CONTEXT", oldLine: 1, newLine: 1, text: "keep" },
        { kind: "ADD", oldLine: null, newLine: 2, text: "added line" },
        { kind: "REMOVE", oldLine: 2, newLine: null, text: "gone line" }],
      rowsTruncated: false, rowsUnavailableReason: null })),
    establishConversationDiffBaseline: vi.fn(async () => ({ established: true, reason: "CREATED" })),
    ...over } as unknown as RelayApiClient;
}

function mount(client: RelayApiClient, sessionId = "s-1", directoryBound = true, enabled = true) {
  return mountReact(createElement(ConversationDiffSummary,
    { client, sessionId, enabled, directoryBound }));
}

const toggle = (view: Awaited<ReturnType<typeof mountReact>>) => view.wrapper.get('[data-testid="conversation-diff-toggle"]');

describe("会话总 diff 入口", () => {
  it("未绑定目录时这一行整块不出现，也不发任何统计请求", async () => {
    const client = clientOf();
    const view = await mount(client, "s-1", false);
    try {
      await flush(40);
      // 2026-10-17 用户指令「不要有这个提示」：目录事实已经由输入区上方那条细条常驻说出，
      // 这一行不再复述一遍「暂不统计」。不出现不等于偷偷读了磁盘——请求一条都不发。
      expect(view.wrapper.find('[data-testid="conversation-diff-toggle"]').exists()).toBe(false);
      expect(client.getConversationDiff).not.toHaveBeenCalled();
    } finally { view.unmount(); }
  });

  it("一行文字按钮就是展开入口：数字与文件数同修订，展开含基线时间、目录、逐文件与同期修改说明", async () => {
    const view = await mount(clientOf());
    try {
      await flush(40);
      const line = toggle(view).text();
      expect(line).toMatch(/本次对话 · 3 个文件\s*\+145\s*−8/);
      expect(toggle(view).attributes("aria-expanded")).toBe("false");
      await toggle(view).trigger("click");
      const panel = view.wrapper.get('[data-testid="conversation-diff-panel"]');
      expect(panel.text()).toContain("本次对话的文件变化");
      expect(panel.text()).toContain("包含该目录自基线起的同期修改，不代表全部由 Agent 产生");
      expect(panel.get('[data-testid="conversation-diff-files"]').findAll(".conversation-diff-file")).toHaveLength(3);
      expect(toggle(view).attributes("aria-expanded")).toBe("true");
      // 展开正文按同一路径读取，并显示同一修订下的行。
      await view.wrapper.get('[data-testid="conversation-diff-file-toggle-src/a.ts"]').trigger("click");
      await flush(60);
      expect(view.wrapper.get('[data-testid="conversation-diff-file-src/a.ts"]')
        .find('[role="table"]').text()).toContain("added line");
    } finally { view.unmount(); }
  });

  it("完整且空的结果显示「暂无文件变化」，未知不显示为 +0 −0", async () => {
    const empty = await mount(clientOf({ getConversationDiff: vi.fn(async (): Promise<RelayConversationDiff> => ({
      ...changed, totalFiles: 0, totalAdded: 0, totalRemoved: 0, files: [] })) }));
    try {
      await flush(40);
      expect(toggle(empty).text()).toContain("本次对话 · 暂无文件变化");
      expect(toggle(empty).attributes("data-state")).toBe("empty");
    } finally { empty.unmount(); }

    const unknown = await mount(clientOf({ getConversationDiff: vi.fn(async (): Promise<RelayConversationDiff> => ({
      available: false, reason: "ROOT_NOT_GIT" })) }));
    try {
      await flush(40);
      const text = toggle(unknown).text();
      expect(text).toContain("不是 Git 根");
      expect(text).not.toContain("+0");
      expect(unknown.wrapper.find('[data-testid="conversation-diff-files"]').exists()).toBe(false);
    } finally { unknown.unmount(); }
  });

  it("缺基线不给行数；「从现在开始统计」由用户触发并显示新起点", async () => {
    let baselineEstablished = false;
    const client = clientOf({ getConversationDiff: vi.fn(async (): Promise<RelayConversationDiff> =>
      baselineEstablished ? changed : { available: false, reason: "NO_BASELINE" }) });
    const view = await mount(client);
    try {
      await flush(40);
      expect(toggle(view).text()).toContain("缺少会话起点");
      await toggle(view).trigger("click");
      const establish = view.wrapper.get('[data-testid="conversation-diff-establish"]');
      expect(establish.text()).toContain("从现在开始统计");
      baselineEstablished = true;
      await establish.trigger("click");
      await flush(60);
      expect(client.establishConversationDiffBaseline).toHaveBeenCalledWith("s-1");
      expect(view.wrapper.get('[data-testid="conversation-diff-establish-notice"]').text())
        .toContain("统计起点已从现在开始建立");
      // 新起点之后总数才出现，不倒造过去。
      expect(toggle(view).text()).toContain("3 个文件");
    } finally { view.unmount(); }
  });

  it("部分不可统计显式标注；失权与目录不可读时隐藏正文", async () => {
    const partial = await mount(clientOf({ getConversationDiff: vi.fn(async (): Promise<RelayConversationDiff> => ({
      ...changed, incomplete: true,
      files: [{ path: "big.bin", action: "MODIFY", added: -1, removed: -1, unavailableReason: "BINARY" }] })) }));
    try {
      await flush(40);
      expect(toggle(partial).text()).toContain("部分不可统计");
      await toggle(partial).trigger("click");
      const fileRow = partial.wrapper.get('[data-testid="conversation-diff-file-big.bin"]');
      expect(fileRow.text()).toContain("二进制内容，不统计行数");
      expect(fileRow.text()).not.toContain("+0");
      expect(partial.wrapper.get('[data-testid="conversation-diff-incomplete"]').exists()).toBe(true);
    } finally { partial.unmount(); }

    const lost = await mount(clientOf({ getConversationDiff: vi.fn(async (): Promise<RelayConversationDiff> =>
      ({ available: false, reason: "RESOURCE_UNAVAILABLE" })) }));
    try {
      await flush(40);
      expect(toggle(lost).text()).toContain("目录当前不可读");
      await toggle(lost).trigger("click");
      expect(lost.wrapper.get('[data-testid="conversation-diff-hidden-by-permission"]').text())
        .toContain("正文与历史内容一并隐藏");
      expect(lost.wrapper.find('[data-testid="conversation-diff-files"]').exists()).toBe(false);
    } finally { lost.unmount(); }
  });

  it("摘要数字拆成可独立着色的节点，并保留「新增/删除 N 行」的可访问名", async () => {
    const view = await mount(clientOf());
    try {
      await flush(40);
      expect(toggle(view).get('[data-metric="added"]').text()).toBe("+145");
      expect(toggle(view).get('[data-metric="removed"]').text()).toBe("−8");
      expect(toggle(view).get('[data-metric="added"]').attributes("class"))
        .toContain("conversation-diff-add");
      expect(toggle(view).get('[data-metric="removed"]').attributes("class"))
        .toContain("conversation-diff-remove");
      expect(toggle(view).text()).toContain("新增 145 行，删除 8 行");
    } finally { view.unmount(); }
  });

  it("扫描覆盖不完整：入口行当场给出成因，展开面板逐条说明范围与条数", async () => {
    const view = await mount(clientOf({ getConversationDiff: vi.fn(async (): Promise<RelayConversationDiff> => ({
      ...changed, incomplete: true,
      coverage: { baseline: { complete: false, reason: "FILE_COUNT_LIMIT", files: 2000, listed: null },
        current: { complete: true, reason: null, files: 12, listed: 12 },
        uncheckedFiles: 3, unverifiedFiles: 1 },
    })) }));
    try {
      await flush(40);
      const flag = view.wrapper.get('[data-testid="conversation-diff-flag"]').text();
      expect(flag).toContain("目录只扫描了部分文件");
      expect(flag).toContain("部分文件未核对");
      await toggle(view).trigger("click");
      const box = view.wrapper.get('[data-testid="conversation-diff-incomplete"]').text();
      // 起点侧没有清单（listed=null）：只报已核对数，不编造「共多少个」。
      expect(box).toContain("会话起点扫描不完整：已核对 2000 个文件，原因：文件数达到统计上限");
      expect(box).not.toContain("起点扫描不完整：已核对 2000/");
      expect(box).toContain("3 个文件在起点里有、本轮扫描没核对到：不计删除，也不计零变化");
      expect(box).toContain("1 个文件本轮有、起点没覆盖且已被 Git 跟踪");
      // 这一轮没有「已发现但读不出行数」的文件，两类事实不能混成一句。
      expect(box).not.toContain("行数不可统计（二进制、超限或读不到）");
    } finally { view.unmount(); }
  });

  it("单文件行数不可统计：说清条数与类别，不冒充扫描覆盖问题", async () => {
    const view = await mount(clientOf({ getConversationDiff: vi.fn(async (): Promise<RelayConversationDiff> => ({
      ...changed, incomplete: true,
      coverage: { baseline: { complete: true, reason: null, files: 5, listed: null },
        current: { complete: true, reason: null, files: 5, listed: 5 },
        uncheckedFiles: 0, unverifiedFiles: 0 },
      files: [{ path: "big.bin", action: "MODIFY", added: -1, removed: -1, unavailableReason: "BINARY" }],
    })) }));
    try {
      await flush(40);
      expect(view.wrapper.get('[data-testid="conversation-diff-flag"]').text())
        .toContain("1 个文件行数不可统计");
      await toggle(view).trigger("click");
      const box = view.wrapper.get('[data-testid="conversation-diff-incomplete"]').text();
      expect(box).toContain("1 个已发现文件的行数不可统计（二进制、超限或读不到）");
      expect(box).not.toContain("扫描不完整");
    } finally { view.unmount(); }
  });

  it("服务端没给覆盖信息时直说成因未知，不退回含糊提示", async () => {
    const view = await mount(clientOf({ getConversationDiff: vi.fn(async (): Promise<RelayConversationDiff> => ({
      ...changed, incomplete: true, coverage: null })) }));
    try {
      await flush(40);
      expect(view.wrapper.get('[data-testid="conversation-diff-flag"]').text())
        .toContain("服务端未给出成因");
      await toggle(view).trigger("click");
      expect(view.wrapper.get('[data-testid="conversation-diff-incomplete"]').text())
        .toContain("没有携带覆盖信息");
    } finally { view.unmount(); }
  });

  it("刷新失败保留上次可信值并标「截至…」，读取中不反复归零", async () => {
    let shouldFail = false;
    const view = await mount(clientOf({ getConversationDiff: vi.fn(async () => {
      if (shouldFail) throw new Error("连接断了");
      return changed;
    }) }));
    try {
      await flush(40);
      expect(toggle(view).text()).toContain("+145");
      shouldFail = true;
      await view.wrapper.get('[data-testid="conversation-diff-toggle"]').trigger("click"); // 展开
      await view.wrapper.get('[data-testid="conversation-diff-refresh"]').trigger("click");
      await flush(60);
      expect(toggle(view).text()).toContain("+145"); // 保留可信值
      expect(view.wrapper.get('[data-testid="conversation-diff-stale"]').text()).toContain("更新失败 · 截至");
      shouldFail = false;
      await view.wrapper.get('[data-testid="conversation-diff-refresh"]').trigger("click");
      await flush(60);
      expect(view.wrapper.find('[data-testid="conversation-diff-stale"]').exists()).toBe(false);
    } finally { view.unmount(); }
  });

  it("切换会话后旧响应立即不可见，也不会覆盖新会话的数", async () => {
    // 装进对象再赋值：TS 会把「回调里才赋值」的局部量按初始值 null 收窄，调用点就成了 never。
    const late = { resolve: null as ((value: RelayConversationDiff) => void) | null };
    const client = clientOf({ getConversationDiff: vi.fn((sessionId: string) => {
      if (sessionId === "s-old") return new Promise<RelayConversationDiff>((resolve) => { late.resolve = resolve; });
      return Promise.resolve({ ...changed, totalFiles: 1, totalAdded: 2, totalRemoved: 1,
        files: [changed.files[0]] });
    }) });
    const view = await mount(client, "s-old");
    try {
      await flush(30);
      // 旧会话仍在途：先切到另一条会话。
      await view.rerender(createElement(ConversationDiffSummary,
        { client, sessionId: "s-new", enabled: true, directoryBound: true }));
      await flush(40);
      expect(toggle(view).text()).toMatch(/1 个文件\s*\+2\s*−1/);
      late.resolve?.(changed); // 迟到响应：不得把新会话的数改回旧会话
      await flush(40);
      expect(toggle(view).text()).toMatch(/1 个文件\s*\+2\s*−1/);
    } finally { view.unmount(); }
  });

  it("外部读取被挡时整块不出现；键盘 Esc 收起并把焦点交回入口", async () => {
    const hidden = await mount(clientOf(), "s-1", true, false);
    try {
      await flush(30);
      expect(hidden.wrapper.find('[data-testid="conversation-diff-toggle"]').exists()).toBe(false);
    } finally { hidden.unmount(); }

    const view = await mount(clientOf());
    try {
      await flush(40);
      // 入口是原生 button：键盘 Enter/Space 由浏览器直接激活（真实按键在浏览器规格里取证）。
      expect(view.wrapper.get('[data-testid="conversation-diff-toggle"]').element?.tagName).toBe("BUTTON");
      await toggle(view).trigger("click");
      expect(view.wrapper.find('[data-testid="conversation-diff-panel"]').exists()).toBe(true);
      await view.wrapper.get('[data-testid="conversation-diff-panel"]').trigger("keydown", { key: "Escape" });
      expect(view.wrapper.find('[data-testid="conversation-diff-panel"]').exists()).toBe(false);
      expect(view.wrapper.get('[data-testid="conversation-diff-toggle"]').exists()).toBe(true);
      expect(view.wrapper.element?.ownerDocument.activeElement?.getAttribute("data-testid"))
        .toBe("conversation-diff-toggle");
    } finally { view.unmount(); }
  });
});
