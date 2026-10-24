import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import ChatLocalFileDiff from "../src/components/ChatLocalFileDiff";
import { localFileDiffRows } from "../src/lib/localFileDiffRows";
import type { RelayApiClient, RelayFileWriteFrozenDiff } from "../src/api/relayClient";
import { flush, mountReact } from "./mountApp";

// 局部 diff 的界面口径（工作台 §34.2 / §34.4，设计系统 §9.15，CD-01、CD-11、CD-12、CD-18）。
// 派生规则在 tests/localFileDiffRows.spec.ts；这里锁的是「用户看得见什么」：
// 生成中不写成已修改、待核对不画 +0 −0、同一文件的多条历史并存、展开正文只走既有只读入口，
// 收起或未结算时迟到正文不会复活。

type FakeClient = Partial<RelayApiClient>;

function asClient(over: FakeClient): RelayApiClient {
  return { getFileWriteFrozenDiff: vi.fn(async () => { throw new Error("读不到"); }),
    getFileWriteChangeSets: vi.fn(async () => []), ...over } as unknown as RelayApiClient;
}

const settledRows = () => localFileDiffRows({
  runId: "run-1", runStatus: "COMPLETED", waitReason: null,
  rounds: [{ round: 0, modelCallId: "m-0", calls: [{
    id: "c-1", round: 0, ordinal: 0, toolName: "apply_changeset", status: "SETTLED",
    args: { changes: [{ path: "src/a/computer-adapter.ts", action: "MODIFY" }] },
    argsSha256: "a".repeat(64), providerToolCallId: "p-1", operationId: "op-1",
    adaptationOf: null, adaptedPath: null, resultRef: { outcome: "COMPLETED" },
    createdAt: "2026-10-16T00:00:00Z", updatedAt: "2026-10-16T00:00:01Z",
    fileChanges: [{ path: "src/a/computer-adapter.ts", action: "MODIFY", status: "APPLIED",
      added: 78, removed: 5, unavailableReason: null }] }] }],
}, []);

describe("聊天局部 diff 行", () => {
  it("生成中显示「正在生成 · 预览 +66 −2」，不写成已修改", async () => {
    const rows = localFileDiffRows({ runId: "run-1", runStatus: "RUNNING", waitReason: null,
      rounds: [{ round: 0, modelCallId: "m-0", calls: [] }] },
    [{ modelCallId: "m-0", ordinal: 0, toolName: "apply_changeset", revision: "4", truncated: false,
      updatedAt: "2026-10-16T00:00:02Z", files: [{ path: "src/a/computer-adapter.ts", action: "CREATE",
        added: 66, removed: 2, targetComplete: true }] }]);
    const view = await mountReact(createElement(ChatLocalFileDiff, { client: asClient({}), rows }));
    try {
      const line = view.wrapper.get('[data-testid^="local-file-diff-"]').text();
      expect(line).toContain("正在生成");
      expect(line).toContain("computer-adapter.ts");
      expect(line).toContain("预览");
      expect(line).toContain("+66");
      expect(line).toContain("−2");
      expect(line).not.toContain("已修改");
      expect(view.wrapper.get(".local-file-diff").attributes("data-preview")).toBe("true");
    } finally { view.unmount(); }
  });

  it("目标未收全时删除侧不给数字，只说行数待核对", async () => {
    const rows = localFileDiffRows({ runId: "run-1", runStatus: "RUNNING", waitReason: null,
      rounds: [{ round: 0, modelCallId: "m-0", calls: [] }] },
    [{ modelCallId: "m-0", ordinal: 0, toolName: "apply_changeset", revision: "1", truncated: false,
      updatedAt: "2026-10-16T00:00:02Z", files: [{ path: "src/a/computer-adapter.ts", action: "MODIFY",
        added: 66, removed: 2, targetComplete: false }] }]);
    const view = await mountReact(createElement(ChatLocalFileDiff, { client: asClient({}), rows }));
    try {
      const line = view.wrapper.get('[data-testid^="local-file-diff-"]').text();
      expect(line).toContain("+66");
      expect(line).not.toContain("−2"); // 未收全的尾部不能算成已删除（§34.4）
      expect(line).toContain("目标未收全");
      expect(line).toContain("删除行数待核对");
    } finally { view.unmount(); }
  });

  it("落账后换成实际数并写「已修改」，同时给出可访问名", async () => {
    const view = await mountReact(createElement(ChatLocalFileDiff, { client: asClient({}), rows: settledRows() }));
    try {
      const line = view.wrapper.get('[data-testid^="local-file-diff-"]').text();
      expect(line).toContain("已修改");
      expect(line).toContain("computer-adapter.ts");
      expect(line).toContain("+78");
      expect(line).toContain("−5");
      expect(line).not.toContain("预览");
      const hidden = view.wrapper.get(".local-file-diff-metrics .visually-hidden").text();
      expect(hidden).toContain("新增 78 行");
      expect(hidden).toContain("删除 5 行");
      // 路径可截断但完整路径可查看：可见文本只到文件名，title 保留原路径。
      expect(view.wrapper.get(".local-file-diff-path").attributes("title")).toBe("src/a/computer-adapter.ts");
      expect(view.wrapper.get(".local-file-diff-path").text()).toBe("computer-adapter.ts");
    } finally { view.unmount(); }
  });

  it("待核对与不统计都不画 +0 −0，并说明原因", async () => {
    const rows = localFileDiffRows({ runId: "run-1", runStatus: "COMPLETED", waitReason: null,
      rounds: [{ round: 0, modelCallId: "m-0", calls: [{
        id: "c-9", round: 0, ordinal: 0, toolName: "apply_changeset", status: "SETTLED",
        args: {}, argsSha256: "b".repeat(64), providerToolCallId: "p-9", operationId: null,
        adaptationOf: null, adaptedPath: null, resultRef: { outcome: "COMPLETED" },
        createdAt: "2026-10-16T00:00:00Z", updatedAt: "2026-10-16T00:00:01Z",
        fileChanges: [
          { path: "a.ts", action: "MODIFY", status: "UNKNOWN", added: 0, removed: 0, unavailableReason: null },
          { path: "big.bin", action: "MODIFY", status: "APPLIED", added: -1, removed: -1,
            unavailableReason: "BINARY" }] }] }] }, []);
    const view = await mountReact(createElement(ChatLocalFileDiff, { client: asClient({}), rows }));
    try {
      const text = view.wrapper.text();
      expect(text).not.toContain("+0");
      expect(text).not.toContain("−0");
      expect(text).toContain("结果待核对");
      expect(text).toContain("二进制内容，不统计行数");
      // 只数行本身（行 <li> 用 .local-file-diff，展开按钮/正文的 testid 也带同一前缀）。
      const lines = view.wrapper.findAll(".local-file-diff");
      expect(lines).toHaveLength(2);
      // 两条都是待核对：UNKNOWN 与「APPLIED 但 -1/二进制」都不能升级成「已修改」。
      expect(lines.map((line) => line.attributes("data-phase")))
        .toEqual(["pendingVerify", "pendingVerify"]);
      expect(lines.every((line) => /[+−]\s*\d/u.test(line.text()) === false)).toBe(true);
      // operationId 为空时没有正文入口：没有 operation_id 就没有可展开的同源事实。
      expect(view.wrapper.findAll('[data-testid^="local-file-diff-toggle-"]')).toHaveLength(0);
    } finally { view.unmount(); }
  });

  it("同一文件两次编辑各留一行，后来者不重写旧记录", async () => {
    const view = await mountReact(createElement(ChatLocalFileDiff, { client: asClient({}),
      rows: [...settledRows(), ...localFileDiffRows({ runId: "run-1", runStatus: "COMPLETED", waitReason: null,
        rounds: [{ round: 1, modelCallId: "m-1", calls: [{
          id: "c-2", round: 1, ordinal: 0, toolName: "apply_changeset", status: "SETTLED",
          args: {}, argsSha256: "c".repeat(64), providerToolCallId: "p-2", operationId: "op-2",
          adaptationOf: null, adaptedPath: null, resultRef: { outcome: "COMPLETED" },
          createdAt: "2026-10-16T00:00:05Z", updatedAt: "2026-10-16T00:00:06Z",
          fileChanges: [{ path: "src/a/computer-adapter.ts", action: "MODIFY", status: "APPLIED",
            added: 3, removed: 9, unavailableReason: null }] }] }] }, [])] }));
    try {
      const lines = view.wrapper.findAll(".local-file-diff");
      expect(lines).toHaveLength(2);
      expect(lines[0].text()).toContain("+78");
      expect(lines[1].text()).toContain("+3");
      expect(lines[1].text()).toContain("−9");
    } finally { view.unmount(); }
  });

  it("展开正文走既有只读入口；读不到时只有说明，没有正文", async () => {
    const frozen = { operationId: "op-1", basis: "FROZEN_INTENT" as const,
      files: [{ relativePath: "src/a/computer-adapter.ts",
        action: "MODIFY" as const, baselineSha256: "b".repeat(64), targetSha256: "c".repeat(64),
        availability: "AVAILABLE" as const, unavailableReason: null,
        beforeText: "one\n", afterText: "one\ntwo\n" }] };
    const client = asClient({ getFileWriteFrozenDiff: vi.fn(async () => frozen),
      getFileWriteChangeSets: vi.fn(async () => []) });
    const view = await mountReact(createElement(ChatLocalFileDiff, { client, rows: settledRows() }));
    try {
      expect(view.wrapper.find('[data-testid^="local-file-diff-body-"]').exists()).toBe(false);
      await view.wrapper.get('[data-testid^="local-file-diff-toggle-"]').trigger("click");
      await flush(80);
      expect(view.wrapper.find('[data-testid="file-write-frozen-diff"]').exists()).toBe(true);
      expect(client.getFileWriteFrozenDiff).toHaveBeenCalledWith("op-1");
    } finally { view.unmount(); }

    const failing = asClient({ getFileWriteFrozenDiff: vi.fn(async () => { throw new Error("403"); }) });
    const second = await mountReact(createElement(ChatLocalFileDiff, { client: failing, rows: settledRows() }));
    try {
      await second.wrapper.get('[data-testid^="local-file-diff-toggle-"]').trigger("click");
      await flush(80);
      expect(second.wrapper.text()).toContain("读不到");
      expect(second.wrapper.find('[data-testid="file-write-frozen-diff"]').exists()).toBe(false);
    } finally { second.unmount(); }
  });

  it("收起后到达的迟到正文不复活；生成中的行没有正文入口", async () => {
    // 装进对象再赋值：TS 会把「回调里才赋值」的局部量按初始值 null 收窄，调用点就成了 never。
    const late = { release: null as ((value: RelayFileWriteFrozenDiff) => void) | null };
    const client = asClient({
      getFileWriteFrozenDiff: vi.fn(() => new Promise<RelayFileWriteFrozenDiff>((resolve) => { late.release = resolve; })),
      getFileWriteChangeSets: vi.fn(async () => []),
    });
    const view = await mountReact(createElement(ChatLocalFileDiff, { client, rows: settledRows() }));
    try {
      await view.wrapper.get('[data-testid^="local-file-diff-toggle-"]').trigger("click");
      await flush(20);
      await view.wrapper.get('[data-testid^="local-file-diff-toggle-"]').trigger("click"); // 收起
      const payload = { operationId: "op-1", basis: "FROZEN_INTENT" as const, files: [] };
      late.release?.(payload);
      await flush(60);
      expect(view.wrapper.find('[data-testid="file-write-frozen-diff"]').exists()).toBe(false);
    } finally { view.unmount(); }

    const generating = localFileDiffRows({ runId: "run-1", runStatus: "RUNNING", waitReason: null,
      rounds: [{ round: 0, modelCallId: "m-0", calls: [] }] },
    [{ modelCallId: "m-0", ordinal: 0, toolName: "apply_changeset", revision: "1", truncated: false,
      updatedAt: "2026-10-16T00:00:02Z", files: [{ path: "g.ts", action: "CREATE", added: 1,
        removed: 0, targetComplete: false }] }]);
    const previewView = await mountReact(createElement(ChatLocalFileDiff, { client: asClient({}), rows: generating }));
    try {
      expect(previewView.wrapper.findAll('[data-testid^="local-file-diff-toggle-"]')).toHaveLength(0);
    } finally { previewView.unmount(); }
  });
});

describe("长任务的逐文件行限高滚动", () => {
  /** n 个文件的已落账行：一次 apply_changeset 带多个 fileChanges，行数＝文件数。 */
  function rowsWithFiles(countOf: number) {
    const paths = Array.from({ length: countOf }, (_, index) => `src/a/file-${index}.ts`);
    return localFileDiffRows({ runId: "run-1", runStatus: "COMPLETED", waitReason: null,
      rounds: [{ round: 0, modelCallId: "m-0", calls: [{
        id: "c-1", round: 0, ordinal: 0, toolName: "apply_changeset", status: "SETTLED",
        args: { changes: paths.map((path) => ({ path, action: "MODIFY" })) },
        argsSha256: "a".repeat(64), providerToolCallId: "p-1", operationId: "op-1",
        adaptationOf: null, adaptedPath: null, resultRef: { outcome: "COMPLETED" },
        createdAt: "2026-10-16T00:00:00Z", updatedAt: "2026-10-16T00:00:01Z",
        fileChanges: paths.map((path) => ({ path, action: "MODIFY" as const, status: "APPLIED" as const,
          added: 3, removed: 1, unavailableReason: null })) }] }],
    }, []);
  }

  it("超过 10 行时限高、框内滚动并说明总数，滚动区可被键盘聚焦", async () => {
    const view = await mountReact(createElement(ChatLocalFileDiff,
      { client: asClient({}), rows: rowsWithFiles(11) }));
    try {
      const list = view.wrapper.get('[data-testid="local-file-diff-list"]');
      expect(list.attributes("data-capped")).toBe("true");
      expect(list.attributes("tabindex")).toBe("0");
      expect(view.wrapper.get('[data-testid="local-file-diff-capped-note"]').text())
        .toContain("共 11 条编辑记录");
      expect(view.wrapper.findAll(".local-file-diff").length).toBe(11);
    } finally { view.unmount(); }
  });

  it("10 行以内不加限高标记与说明", async () => {
    const view = await mountReact(createElement(ChatLocalFileDiff,
      { client: asClient({}), rows: rowsWithFiles(3) }));
    try {
      const list = view.wrapper.get('[data-testid="local-file-diff-list"]');
      expect(list.attributes("data-capped")).toBeUndefined();
      expect(view.wrapper.find('[data-testid="local-file-diff-capped-note"]').exists()).toBe(false);
    } finally { view.unmount(); }
  });
});
