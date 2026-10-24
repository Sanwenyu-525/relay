import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import ConversationDiffSummary from "../src/components/ConversationDiffSummary";
import { RelayApiClient, RelayApiError, RelayTransportError,
  type RelayConversationDiff, type RelayConversationDiffFile, type RelayConversationDiffFileRow } from "../src/api/relayClient";
import { flush, mountReact } from "./mountApp";

// 会话总 diff 的界面口径（工作台 §34.2 / §34.4，CD-01、CD-12、CD-17、CD-18）。
// 口径固定为 B「本轮对话开始以来的净变化」：数字只来自服务端的基线→当前已落盘投影。
// 这里锁状态可辨（统计中 / 空 / 无目录 / 非 Git 根 / 缺基线 / 失权 / 部分不可统计 / 刷新失败）、
// 展开阅读与总数同修订、迟到响应不覆盖新值，以及「从现在开始统计」由用户主动触发。
// 2026-10-24 用户指令「没有 git diff 的时候不显示这个红框部分」：完整且空与读取中都不占位，
// 其余状态（不可用成因、失败）仍必须可见。

const changed: Extract<RelayConversationDiff, { available: true }> = {
  available: true, scope: "SESSION", baselineCapturedAt: "2026-10-16T09:00:00Z", baselineRevision: "3",
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
      // 会话口径：只算本会话写入的文件，同目录其他程序/其他会话的同期修改不计入。
      expect(panel.text()).toContain("只统计本会话写入的文件");
      expect(panel.get('[data-testid="conversation-diff-files"]').findAll(".conversation-diff-file")).toHaveLength(3);
      expect(toggle(view).attributes("aria-expanded")).toBe("true");
      // 展开正文按同一路径读取，并显示同一修订下的行。
      await view.wrapper.get('[data-testid="conversation-diff-file-toggle-src/a.ts"]').trigger("click");
      await flush(60);
      expect(view.wrapper.get('[data-testid="conversation-diff-file-src/a.ts"]')
        .find('[role="table"]').text()).toContain("added line");
    } finally { view.unmount(); }
  });

  it("对话入口按会话口径请求：只算本会话落盘的路径", async () => {
    const client = clientOf();
    const view = await mount(client);
    try {
      await flush(40);
      expect(client.getConversationDiff).toHaveBeenCalledWith("s-1", "SESSION");
    } finally { view.unmount(); }
  });

  it("内联形态（工作详情「变更」页签）：直接摊开清单、按目录口径请求，未绑定目录也照常读", async () => {
    const client = clientOf({ getConversationDiff: vi.fn(async (): Promise<RelayConversationDiff> => ({
      ...changed, scope: "DIRECTORY" })) });
    const view = await mountReact(createElement(ConversationDiffSummary, {
      client, sessionId: "s-1", enabled: true, directoryBound: false,
      scope: "DIRECTORY", inline: true }));
    try {
      await flush(40);
      // 目录口径是另一条读法：同一个会话、同一份基线，范围不同。
      expect(client.getConversationDiff).toHaveBeenCalledWith("s-1", "DIRECTORY");
      // 页签里没有「展开／收起」这一层，清单直接摊开。
      expect(view.wrapper.find('[data-testid="conversation-diff-toggle"]').exists()).toBe(false);
      const panel = view.wrapper.get('[data-testid="conversation-diff-panel"]');
      expect(panel.text()).toContain("本次对话期间该目录的变化");
      expect(panel.text()).toContain("包含该目录自基线起的同期修改，不代表全部由 Agent 产生");
      expect(panel.text()).toContain("src/a.ts");
    } finally { view.unmount(); }
  });

  it("完整且空的结果不占位：入口整行不出现，未知仍不显示为 +0 −0", async () => {
    const client = clientOf({ getConversationDiff: vi.fn(async (): Promise<RelayConversationDiff> => ({
      ...changed, totalFiles: 0, totalAdded: 0, totalRemoved: 0, files: [] })) });
    const empty = await mount(client);
    try {
      await flush(40);
      // 2026-10-24 用户指令「没有 git diff 的时候不显示这个红框部分」：空净变化连展开入口都不给，
      // 输入卡上方不再出现「本次对话 · 暂无文件变化」这一行占位。
      expect(empty.wrapper.find('[data-testid="conversation-diff-toggle"]').exists()).toBe(false);
      expect(empty.wrapper.find('[data-testid="conversation-diff-panel"]').exists()).toBe(false);
      // 不出现不等于不查：统计照旧读，写入之后同一入口会自己长出来。
      expect(client.getConversationDiff).toHaveBeenCalledWith("s-1", "SESSION");
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

  it("读取中不占位：读到真实变化后入口才出现，不先闪一句「正在统计」", async () => {
    // 装进对象再赋值：TS 会把「回调里才赋值」的局部量按初始值 null 收窄，调用点就成了 never。
    const pending = { resolve: null as ((value: RelayConversationDiff) => void) | null };
    const client = clientOf({ getConversationDiff: vi.fn(() => new Promise<RelayConversationDiff>(
      (resolve) => { pending.resolve = resolve; })) });
    const view = await mount(client);
    try {
      await flush(30);
      // 首次读取还没回来：先不占位，避免「先出现再消失」把输入卡推上推下。
      expect(view.wrapper.find('[data-testid="conversation-diff-toggle"]').exists()).toBe(false);
      pending.resolve?.(changed);
      await flush(40);
      expect(toggle(view).text()).toMatch(/本次对话 · 3 个文件/);
    } finally { view.unmount(); }
  });

  it("内联形态（变更页签）空态照旧说「暂无文件变化」：那里就是专门来看统计的", async () => {
    const view = await mountReact(createElement(ConversationDiffSummary, {
      client: clientOf({ getConversationDiff: vi.fn(async (): Promise<RelayConversationDiff> => ({
        ...changed, scope: "DIRECTORY", totalFiles: 0, totalAdded: 0, totalRemoved: 0, files: [] })) }),
      sessionId: "s-1", enabled: true, directoryBound: true, scope: "DIRECTORY", inline: true }));
    try {
      await flush(40);
      const panel = view.wrapper.get('[data-testid="conversation-diff-panel"]');
      expect(panel.get('[data-testid="conversation-diff-empty"]').text()).toContain("本次对话暂无文件变化");
    } finally { view.unmount(); }
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

  it("目录口径（scope=DIRECTORY）仍按整段目录说明成因与同期修改", async () => {
    // 目录口径留给「工作详情」那类视图；这条用例锁住它没被会话口径的措辞顶掉。
    const view = await mount(clientOf({ getConversationDiff: vi.fn(async (): Promise<RelayConversationDiff> => ({
      ...changed, scope: "DIRECTORY", incomplete: true,
      coverage: { baseline: { complete: false, reason: "FILE_COUNT_LIMIT", files: 2000, listed: null },
        current: { complete: true, reason: null, files: 12, listed: 12 },
        uncheckedFiles: 0, unverifiedFiles: 0, unverifiableFiles: 0, unscannedFiles: 0 },
    })) }));
    try {
      await flush(40);
      expect(view.wrapper.get('[data-testid="conversation-diff-flag"]').text())
        .toContain("目录只扫描了部分文件");
      await toggle(view).trigger("click");
      expect(view.wrapper.get('[data-testid="conversation-diff-panel"]').text())
        .toContain("包含该目录自基线起的同期修改，不代表全部由 Agent 产生");
    } finally { view.unmount(); }
  });

  it("会话口径下不拿「整目录没扫全」当缺口，改说写入路径未核对", async () => {
    const view = await mount(clientOf({ getConversationDiff: vi.fn(async (): Promise<RelayConversationDiff> => ({
      ...changed, incomplete: true,
      coverage: { baseline: { complete: false, reason: "FILE_COUNT_LIMIT", files: 2000, listed: null },
        current: { complete: false, reason: "FILE_COUNT_LIMIT", files: 2000, listed: 3141 },
        uncheckedFiles: 2, unverifiedFiles: 0, unverifiableFiles: 0, unscannedFiles: 1 },
    })) }));
    try {
      await flush(40);
      const flag = view.wrapper.get('[data-testid="conversation-diff-flag"]').text();
      expect(flag).not.toContain("目录只扫描了部分文件");
      expect(flag).toContain("部分写入路径未核对");
      expect(flag).toContain("1 个写入路径不在扫描范围");
      await toggle(view).trigger("click");
      const box = view.wrapper.get('[data-testid="conversation-diff-incomplete"]').text();
      expect(box).not.toContain("会话起点扫描不完整");
      expect(box).toContain("2 个本会话写入的路径本轮没核对到");
      expect(box).toContain("1 个本会话写过的路径在起点与本轮扫描里都没出现");
    } finally { view.unmount(); }
  });

  it("扫描覆盖不完整：入口行当场给出成因，展开面板逐条说明范围与条数", async () => {
    const view = await mount(clientOf({ getConversationDiff: vi.fn(async (): Promise<RelayConversationDiff> => ({
      ...changed, scope: "DIRECTORY", incomplete: true,
      coverage: { baseline: { complete: false, reason: "FILE_COUNT_LIMIT", files: 2000, listed: null },
        current: { complete: true, reason: null, files: 12, listed: 12 },
        uncheckedFiles: 3, unverifiedFiles: 1, unverifiableFiles: 0, unscannedFiles: 0 },
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

  it("内容读不到且字节数没变的文件：入口报条数，展开说清它们既不进列表也不算未变", async () => {
    const view = await mount(clientOf({ getConversationDiff: vi.fn(async (): Promise<RelayConversationDiff> => ({
      ...changed, incomplete: true, files: [], totalFiles: 0, totalAdded: 0, totalRemoved: 0,
      coverage: { baseline: { complete: false, reason: "FILE_COUNT_LIMIT", files: 2000, listed: null },
        current: { complete: true, reason: null, files: 2000, listed: 3139 },
        uncheckedFiles: 0, unverifiedFiles: 0, unverifiableFiles: 147, unscannedFiles: 0 },
    })) }));
    try {
      await flush(40);
      const flag = view.wrapper.get('[data-testid="conversation-diff-flag"]').text();
      expect(flag).toContain("147 个文件内容未核对");
      // 「无法核对」与「已发现但读不出行数」是两类事实，不能混成一句。
      expect(flag).not.toContain("个文件行数不可统计");
      await toggle(view).trigger("click");
      const box = view.wrapper.get('[data-testid="conversation-diff-incomplete"]').text();
      expect(box).toContain("147 个文件起点与本轮都在、但内容读不到");
      expect(box).toContain("既不算修改，也不算没变");
      // 总数不可统计时不能直接宣称「暂无文件变化」。
      expect(view.wrapper.get('[data-testid="conversation-diff-empty"]').text())
        .toContain("本次统计不完整");
      expect(view.wrapper.find('[data-testid="conversation-diff-files"]').exists()).toBe(false);
    } finally { view.unmount(); }
  });

  it("单文件行数不可统计：说清条数与类别，不冒充扫描覆盖问题", async () => {
    const view = await mount(clientOf({ getConversationDiff: vi.fn(async (): Promise<RelayConversationDiff> => ({
      ...changed, incomplete: true,
      coverage: { baseline: { complete: true, reason: null, files: 5, listed: null },
        current: { complete: true, reason: null, files: 5, listed: 5 },
        uncheckedFiles: 0, unverifiedFiles: 0, unverifiableFiles: 0, unscannedFiles: 0 },
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

  // 禅道 #117：DTO 没有当前侧快照代次字段，起点修订不变不代表当前文件未变——同样行数的
  // 内容替换也不改统计对象。所以每次统计成功刷新都让已展开正文按新读取代次重新核对。
  const addRow = (newLine: number, text: string): RelayConversationDiffFileRow =>
    ({ kind: "ADD", oldLine: null, newLine, text });
  it.each([
    { label: "新增行数变化（+1→+2）", firstAdded: 1, secondAdded: 2, replaced: false },
    { label: "行数相同的内容替换（+2→+2）", firstAdded: 2, secondAdded: 2, replaced: true },
  ])("统计成功刷新后已展开正文按新读取重新核对：$label", async ({ firstAdded, secondAdded, replaced }) => {
    let round = 1;
    const addedNow = () => (round === 1 ? firstAdded : secondAdded);
    const stats = vi.fn(async (): Promise<RelayConversationDiff> => ({
      available: true, scope: "SESSION", baselineCapturedAt: "2026-10-16T09:00:00Z",
      baselineRevision: "3", rootPath: "D:\\Work\\Demo", resourceId: "res-1",
      incomplete: false, coverage: null, totalFiles: 1, totalAdded: addedNow(), totalRemoved: 0,
      files: [{ path: "src/a.ts", action: "MODIFY", added: addedNow(), removed: 0, unavailableReason: null }],
    }));
    const body = vi.fn(async (): Promise<RelayConversationDiffFile> => ({
      available: true, path: "src/a.ts", action: "MODIFY", added: addedNow(), removed: 0, unavailableReason: null,
      rows: round === 1
        ? Array.from({ length: firstAdded }, (_, index) => addRow(index + 1, "CURRENT_BODY_V1_ONLY"))
        : Array.from({ length: secondAdded }, (_, index) =>
          addRow(index + 1, replaced ? "REPLACED_BODY_SAME_LINE_COUNT" : "CURRENT_BODY_V2_ONLY")),
      rowsTruncated: false, rowsUnavailableReason: null,
    }));
    const client = { getConversationDiff: stats, getConversationDiffFile: body } as unknown as RelayApiClient;
    const view = await mountReact(createElement(ConversationDiffSummary,
      { client, sessionId: "s-1", enabled: true, directoryBound: true }));
    try {
      await flush(40);
      await toggle(view).trigger("click");
      await view.wrapper.get('[data-testid="conversation-diff-file-toggle-src/a.ts"]').trigger("click");
      await flush(40);
      expect(view.wrapper.text()).toContain("CURRENT_BODY_V1_ONLY");
      expect(body).toHaveBeenCalledTimes(1);
      round = 2;
      await view.wrapper.get('[data-testid="conversation-diff-refresh"]').trigger("click");
      await flush(60);
      // 统计与正文都跟上当前侧：不是只按行数变化判断，旧正文不能配新统计。
      expect(stats).toHaveBeenCalledTimes(2);
      expect(body).toHaveBeenCalledTimes(2);
      expect(view.wrapper.text()).not.toContain("CURRENT_BODY_V1_ONLY");
      expect(view.wrapper.text())
        .toContain(replaced ? "REPLACED_BODY_SAME_LINE_COUNT" : "CURRENT_BODY_V2_ONLY");
    } finally { view.unmount(); }
  });

  it("统计成功刷新只核对仍展开的正文，收起的文件不读正文", async () => {
    let round = 1;
    const body = vi.fn(async (): Promise<RelayConversationDiffFile> => ({
      available: true, path: "src/a.ts", action: "MODIFY", added: 1, removed: 0, unavailableReason: null,
      rows: [addRow(1, round === 1 ? "BODY_ROUND_1" : "BODY_ROUND_2")],
      rowsTruncated: false, rowsUnavailableReason: null,
    }));
    const client = { getConversationDiff: vi.fn(async (): Promise<RelayConversationDiff> => changed),
      getConversationDiffFile: body } as unknown as RelayApiClient;
    const view = await mount(client);
    try {
      await flush(40);
      await toggle(view).trigger("click");
      await view.wrapper.get('[data-testid="conversation-diff-file-toggle-src/a.ts"]').trigger("click");
      await flush(40);
      expect(body).toHaveBeenCalledTimes(1);
      // 收起正文：此后统计刷新不再读这份正文。
      await view.wrapper.get('[data-testid="conversation-diff-file-toggle-src/a.ts"]').trigger("click");
      await flush(40);
      round = 2;
      await view.wrapper.get('[data-testid="conversation-diff-refresh"]').trigger("click");
      await flush(60);
      expect(body).toHaveBeenCalledTimes(1);
      // 重新展开按当前读取重读，不拿收起前的旧正文续用。
      await view.wrapper.get('[data-testid="conversation-diff-file-toggle-src/a.ts"]').trigger("click");
      await flush(40);
      expect(body).toHaveBeenCalledTimes(2);
      expect(view.wrapper.text()).toContain("BODY_ROUND_2");
      expect(view.wrapper.text()).not.toContain("BODY_ROUND_1");
    } finally { view.unmount(); }
  });

  it("切换会话后已展开正文不复用，重新展开按新会话读取", async () => {
    const body = vi.fn(async (sessionId: string): Promise<RelayConversationDiffFile> => ({
      available: true, path: "src/a.ts", action: "MODIFY", added: 1, removed: 0, unavailableReason: null,
      rows: [addRow(1, sessionId === "s-1" ? "BODY_SESSION_1" : "BODY_SESSION_2")],
      rowsTruncated: false, rowsUnavailableReason: null,
    }));
    const client = { getConversationDiff: vi.fn(async (): Promise<RelayConversationDiff> => changed),
      getConversationDiffFile: body } as unknown as RelayApiClient;
    const view = await mountReact(createElement(ConversationDiffSummary,
      { client, sessionId: "s-1", enabled: true, directoryBound: true }));
    try {
      await flush(40);
      await toggle(view).trigger("click");
      await view.wrapper.get('[data-testid="conversation-diff-file-toggle-src/a.ts"]').trigger("click");
      await flush(40);
      expect(view.wrapper.text()).toContain("BODY_SESSION_1");
      await view.rerender(createElement(ConversationDiffSummary,
        { client, sessionId: "s-2", enabled: true, directoryBound: true }));
      await flush(40);
      // 会话切换把已展开文件收起：旧正文一律不可取用，正文区域不再出现。
      expect(view.wrapper.text()).not.toContain("BODY_SESSION_1");
      expect(view.wrapper.find('[role="table"]').exists()).toBe(false);
      await view.wrapper.get('[data-testid="conversation-diff-file-toggle-src/a.ts"]').trigger("click");
      await flush(40);
      expect(view.wrapper.text()).toContain("BODY_SESSION_2");
    } finally { view.unmount(); }
  });

  // 禅道 #118：明确拒读（401/403/404）撤下旧目录与已展开正文并报拒读状态；
  // 200 RESOURCE_UNAVAILABLE 既有对照必须继续通过；临时故障才按 CD-17 保留标过期。
  const sid = "33333333-3333-4333-8333-333333333333";
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  // 拒读总量 fixture 与具体状态码无关（状态码只在 HTTP 层断言），不收参数避免未用形参。
  const rejectedStats = () => ({
    available: true, scope: "SESSION", baseline_captured_at: "2026-10-23T00:00:00Z",
    baseline_revision: "3", root_path: "D:\\PRIVATE_ROOT_PROBE", resource_id: "resource-probe",
    incomplete: false, coverage: null, total_files: 1, total_added: 1, total_removed: 0,
    files: [{ path: "confidential.txt", action: "MODIFY", added: 1, removed: 0, unavailable_reason: null }],
  });
  it.each([401, 403, 404])("明确拒读 HTTP %s 后撤下旧目录与已展开正文，并报拒读状态", async (status) => {
    let phase: "readable" | "rejected" | "unavailable" = "readable";
    const code = status === 401 ? "AUTH_REQUIRED" : status === 403 ? "PERMISSION_DENIED" : "RESOURCE_NOT_FOUND";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (phase === "rejected") return json({ code, detail: "current source access rejected" }, status);
      if (phase === "unavailable") return json({ available: false, reason: "RESOURCE_UNAVAILABLE" });
      if (new URL(String(input)).pathname.endsWith("/file")) return json({
        available: true, path: "confidential.txt", action: "MODIFY", added: 1, removed: 0,
        unavailable_reason: null,
        rows: [{ kind: "ADD", old_line: null, new_line: 1, text: "PREVIOUSLY_READ_BODY" }],
        rows_truncated: false, rows_unavailable_reason: null });
      return json(rejectedStats());
    }));
    const client = new RelayApiClient({ baseUrl: "http://127.0.0.1:8787",
      workspaceId: "11111111-1111-4111-8111-111111111111", bearerToken: "test-token" });
    const view = await mountReact(createElement(ConversationDiffSummary,
      { client, sessionId: sid, enabled: true, directoryBound: true }));
    try {
      await flush(40);
      await toggle(view).trigger("click");
      await view.wrapper.get('[data-testid="conversation-diff-file-toggle-confidential.txt"]').trigger("click");
      await flush(40);
      expect(view.wrapper.text()).toContain("PREVIOUSLY_READ_BODY");
      phase = "rejected";
      await view.wrapper.get('[data-testid="conversation-diff-refresh"]').trigger("click");
      await flush(60);
      // 旧 root/path/正文一并撤下：拒读不是临时断网，不能继续展示旧快照。
      expect(view.wrapper.text()).not.toContain("PRIVATE_ROOT_PROBE");
      expect(view.wrapper.text()).not.toContain("PREVIOUSLY_READ_BODY");
      expect(view.wrapper.text()).toContain(`HTTP ${status} ${code}`);
      expect(view.wrapper.find('[data-testid="conversation-diff-stale"]').exists()).toBe(false);
      // 200 RESOURCE_UNAVAILABLE 既有对照：不可用 DTO 同样撤下旧值（原契约不回退）。
      phase = "unavailable";
      await view.wrapper.get('[data-testid="conversation-diff-refresh"]').trigger("click");
      await flush(60);
      expect(view.wrapper.get('[data-testid="conversation-diff-hidden-by-permission"]').text())
        .toContain("正文与历史内容一并隐藏");
      expect(view.wrapper.text()).not.toContain("PREVIOUSLY_READ_BODY");
    } finally { view.unmount(); vi.unstubAllGlobals(); }
  });

  it("503 与传输失败按 CD-17 保留可信值标过期；恢复 200 后只显示新数据", async () => {
    let mode: "ok1" | "http503" | "transport" | "ok2" = "ok1";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (mode === "http503") return json({ code: "DATABASE_UNAVAILABLE", detail: "temporary failure" }, 503);
      if (mode === "transport") throw new TypeError("connection lost");
      if (new URL(String(input)).pathname.endsWith("/file")) return json({
        available: true, path: "src/a.ts", action: "MODIFY",
        added: mode === "ok1" ? 1 : 3, removed: 0, unavailable_reason: null,
        rows: [{ kind: "ADD", old_line: null, new_line: 1, text: mode === "ok1" ? "BODY_ROUND_1" : "BODY_ROUND_2" }],
        rows_truncated: false, rows_unavailable_reason: null });
      return json({ available: true, scope: "SESSION", baseline_captured_at: "2026-10-23T00:00:00Z",
        baseline_revision: "3", root_path: "D:\\Work\\Demo", resource_id: "res-1", incomplete: false,
        coverage: null, total_files: 1, total_added: mode === "ok1" ? 1 : 3, total_removed: 0,
        files: [{ path: "src/a.ts", action: "MODIFY", added: mode === "ok1" ? 1 : 3, removed: 0, unavailable_reason: null }] });
    }));
    const client = new RelayApiClient({ baseUrl: "http://127.0.0.1:8787",
      workspaceId: "11111111-1111-4111-8111-111111111111", bearerToken: "test-token" });
    const view = await mountReact(createElement(ConversationDiffSummary,
      { client, sessionId: sid, enabled: true, directoryBound: true }));
    try {
      await flush(40);
      await toggle(view).trigger("click");
      await view.wrapper.get('[data-testid="conversation-diff-file-toggle-src/a.ts"]').trigger("click");
      await flush(40);
      expect(view.wrapper.text()).toContain("BODY_ROUND_1");
      mode = "http503";
      await view.wrapper.get('[data-testid="conversation-diff-refresh"]').trigger("click");
      await flush(60);
      // 临时故障保留上次可信值（含同一份正文），入口标「更新失败 · 截至…」，不称当前。
      expect(view.wrapper.text()).toContain("+1");
      expect(view.wrapper.text()).toContain("BODY_ROUND_1");
      expect(view.wrapper.get('[data-testid="conversation-diff-stale"]').text()).toContain("更新失败 · 截至");
      mode = "transport";
      await view.wrapper.get('[data-testid="conversation-diff-refresh"]').trigger("click");
      await flush(60);
      expect(view.wrapper.get('[data-testid="conversation-diff-stale"]').exists()).toBe(true);
      mode = "ok2";
      await view.wrapper.get('[data-testid="conversation-diff-refresh"]').trigger("click");
      await flush(60);
      // 恢复 200 只显示新数据：过期标记消失，正文按新读取重读。
      expect(view.wrapper.find('[data-testid="conversation-diff-stale"]').exists()).toBe(false);
      expect(view.wrapper.text()).toContain("+3");
      expect(view.wrapper.text()).toContain("BODY_ROUND_2");
      expect(view.wrapper.text()).not.toContain("BODY_ROUND_1");
    } finally { view.unmount(); vi.unstubAllGlobals(); }
  });

  it("单文件正文明确拒读时不残留旧正文并报拒读状态", async () => {
    let fileFails = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (new URL(String(input)).pathname.endsWith("/file")) {
        if (fileFails) return json({ code: "RESOURCE_NOT_FOUND", detail: "path gone" }, 404);
        return json({ available: true, path: "src/a.ts", action: "MODIFY", added: 1, removed: 0,
          unavailable_reason: null,
          rows: [{ kind: "ADD", old_line: null, new_line: 1, text: "BODY_BEFORE_REJECTION" }],
          rows_truncated: false, rows_unavailable_reason: null });
      }
      // 统计 fixture 的文件列表必须与正文用例一致（src/a.ts）：
      // rejectedStats() 是拒读总量的对照 fixture，文件是 confidential.txt，不能混用。
      return json({ ...rejectedStats(),
        files: [{ path: "src/a.ts", action: "MODIFY", added: 1, removed: 0, unavailable_reason: null }] });
    }));
    const client = new RelayApiClient({ baseUrl: "http://127.0.0.1:8787",
      workspaceId: "11111111-1111-4111-8111-111111111111", bearerToken: "test-token" });
    const view = await mountReact(createElement(ConversationDiffSummary,
      { client, sessionId: sid, enabled: true, directoryBound: true }));
    try {
      await flush(40);
      await toggle(view).trigger("click");
      await view.wrapper.get('[data-testid="conversation-diff-file-toggle-src/a.ts"]').trigger("click");
      await flush(40);
      expect(view.wrapper.text()).toContain("BODY_BEFORE_REJECTION");
      fileFails = true;
      await view.wrapper.get('[data-testid="conversation-diff-refresh"]').trigger("click");
      await flush(60);
      expect(view.wrapper.text()).not.toContain("BODY_BEFORE_REJECTION");
      expect(view.wrapper.text()).toContain("正文读取被拒绝（HTTP 404 RESOURCE_NOT_FOUND）");
    } finally { view.unmount(); vi.unstubAllGlobals(); }
  });

  it("API client 保留明确拒绝类型，不把 HTTP 错误抹平成传输失败", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ code: "PERMISSION_DENIED", detail: "denied" }, 403)));
    const client = new RelayApiClient({ baseUrl: "http://127.0.0.1:8787",
      workspaceId: "11111111-1111-4111-8111-111111111111", bearerToken: "test-token" });
    try {
      const rejected = await client.getConversationDiff(sid).then(() => null, (caught: unknown) => caught);
      expect(rejected).toBeInstanceOf(RelayApiError);
      expect((rejected as RelayApiError).problem.status).toBe(403);
      expect((rejected as RelayApiError).problem.code).toBe("PERMISSION_DENIED");
      const fileRejected = await client.getConversationDiffFile(sid, "src/a.ts")
        .then(() => null, (caught: unknown) => caught);
      expect(fileRejected).toBeInstanceOf(RelayApiError);
      vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("connection lost"); }));
      const transport = await client.getConversationDiff(sid).then(() => null, (caught: unknown) => caught);
      expect(transport).toBeInstanceOf(RelayTransportError);
    } finally { vi.unstubAllGlobals(); }
  });
});
