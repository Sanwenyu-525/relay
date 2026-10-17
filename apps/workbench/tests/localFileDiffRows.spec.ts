import { describe, expect, it } from "vitest";
import { localFileDiffRows } from "../src/lib/localFileDiffRows";
import type {
  RelayRunToolCall,
  RelayRunToolCallFileChange,
  RelayRunToolCallPreview,
  RelayRunToolCalls,
} from "../src/api/dtos/assist";

// 会话局部 diff 的派生不变量（工作台 §34.2 / §34.4，CD-01、CD-11、CD-12、CD-13）。
// 这里只锁「同源投影 → 展示行」的口径：预览不写成已修改、待核对不画 0、同一文件多次编辑
// 各留一条、被拒与重放不加数、迟到片段不覆盖新值。真实流时序（CD-09/10）在 API 侧取证。

const call = (over: Partial<RelayRunToolCall> & { id: string }): RelayRunToolCall => ({
  toolName: "apply_changeset", status: "SETTLED", round: 0, ordinal: 0,
  args: {}, argsSha256: "a".repeat(64), providerToolCallId: `p-${over.id}`, operationId: null,
  adaptationOf: null, adaptedPath: null, resultRef: { outcome: "COMPLETED" }, fileChanges: [],
  createdAt: "2026-10-16T00:00:00Z", updatedAt: "2026-10-16T00:00:01Z", ...over });

const file = (over: Partial<RelayRunToolCallFileChange> & { path: string }): RelayRunToolCallFileChange => ({
  action: "MODIFY", status: "APPLIED", added: 10, removed: 3, unavailableReason: null, ...over });

const preview = (over: Partial<RelayRunToolCallPreview> & { modelCallId: string }): RelayRunToolCallPreview => ({
  ordinal: 0, toolName: "apply_changeset", revision: "1", truncated: false,
  updatedAt: "2026-10-16T00:00:02Z", files: [], ...over });

const projection = (rounds: RelayRunToolCalls["rounds"], runStatus = "RUNNING"): RelayRunToolCalls => ({
  runId: "run-1", runStatus, waitReason: null, rounds });

describe("局部 diff 行的派生口径", () => {
  it("同一文件被改两次留下两条局部历史，后来的编辑不重写旧行", () => {
    const rows = localFileDiffRows(projection([
      { round: 0, modelCallId: "m-0", calls: [call({ id: "c-1", operationId: "op-1",
        fileChanges: [file({ path: "src/a/computer-adapter.ts", added: 4, removed: 1 })] })], },
      { round: 1, modelCallId: "m-1", calls: [call({ id: "c-2", ordinal: 0, round: 1, operationId: "op-2",
        fileChanges: [file({ path: "src/a/computer-adapter.ts", added: 78, removed: 5 })] })], },
    ]), []);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.phase)).toEqual(["applied", "applied"]);
    expect(rows.map((row) => row.added)).toEqual([4, 78]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
    expect(rows.every((row) => row.preview === false)).toBe(true);
  });

  it("重复的调用行只算一次，不把一次结算显示成两次编辑", () => {
    const repeated = call({ id: "c-1", fileChanges: [file({ path: "a.ts" })] });
    const rows = localFileDiffRows(projection([
      { round: 0, modelCallId: "m-0", calls: [repeated, repeated] }]), []);
    expect(rows).toHaveLength(1);
  });

  it("生成中的预览行标 preview，绝不显示成已修改，也不带 operation 正文入口", () => {
    const rows = localFileDiffRows(projection([
      { round: 0, modelCallId: "m-0", calls: [] }]),
    [preview({ modelCallId: "m-0", ordinal: 0, files: [
      { path: "src/a/computer-adapter.ts", action: "CREATE", added: 66, removed: 2, targetComplete: false }] })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].phase).toBe("generating");
    expect(rows[0].preview).toBe(true);
    expect(rows[0].added).toBe(66);
    expect(rows[0].fileName).toBe("computer-adapter.ts");
  });

  it("目标未收全时不承诺删除行数；待核对不是 0", () => {
    const rows = localFileDiffRows(projection([
      { round: 0, modelCallId: "m-0", calls: [call({ id: "c-1", status: "PREPARED",
        args: { changes: [{ path: "a.ts", action: "MODIFY" }] } })] }]),
    [preview({ modelCallId: "m-0", ordinal: 0, files: [
      { path: "a.ts", action: "MODIFY", added: 12, removed: -1, targetComplete: false }] })]);
    expect(rows[0].removed).toBeNull();
    expect(rows[0].added).toBe(12);
    // 已结算但行数不可核对：两侧都不给数字。
    const pending = localFileDiffRows(projection([
      { round: 0, modelCallId: "m-0", calls: [call({ id: "c-2",
        fileChanges: [file({ path: "b.ts", added: -1, removed: -1 })] })] }]), []);
    expect(pending[0].phase).toBe("pendingVerify");
    expect(pending[0].added).toBeNull();
    expect(pending[0].removed).toBeNull();
  });

  it("缺基线的 MODIFY 预览不给删除数并说明原因", () => {
    const rows = localFileDiffRows(projection([
      { round: 0, modelCallId: "m-0", calls: [] }]),
    [preview({ modelCallId: "m-0", files: [
      { path: "c.ts", action: "UNKNOWN", added: -1, removed: -1, targetComplete: true }] })]);
    expect(rows[0].added).toBeNull();
    expect(rows[0].removed).toBeNull();
    expect(rows[0].unavailableReason).toBe("MODIFY_BASELINE_UNAVAILABLE");
  });

  it("待应用、失败、冲突与 UNKNOWN 各归其位，都不写成已修改", () => {
    const waiting = localFileDiffRows(projection([
      { round: 0, modelCallId: "m-0", calls: [call({ id: "c-w", status: "WAITING_APPROVAL",
        operationId: "op-w", args: { changes: [{ path: "w.ts", action: "MODIFY" }] }, resultRef: null })] }]), []);
    expect(waiting[0].phase).toBe("waitingApproval");
    expect(waiting[0].added).toBeNull();
    const outcomes = localFileDiffRows(projection([
      { round: 0, modelCallId: "m-0", calls: [call({ id: "c-f", fileChanges: [
        file({ path: "ok.ts", status: "APPLIED" }),
        file({ path: "bad.ts", status: "FAILED", added: 0, removed: 0 }),
        file({ path: "clash.ts", status: "CONFLICT", added: 0, removed: 0 }),
        file({ path: "maybe.ts", status: "UNKNOWN", added: 0, removed: 0 })] })] }]), []);
    expect(outcomes.map((row) => row.phase)).toEqual(["applied", "failed", "failed", "pendingVerify"]);
    // 部分应用：逐文件区分，不把整个 changeset 标成功。
    expect(outcomes.filter((row) => row.phase === "applied")).toHaveLength(1);
    expect(outcomes.find((row) => row.path === "bad.ts")?.added).toBeNull();
  });

  it("拒绝与中止不产生局部行，也不保留生成中残留", () => {
    const rows = localFileDiffRows(projection([
      { round: 0, modelCallId: "m-0", calls: [
        call({ id: "c-r", status: "REJECTED", resultRef: null,
          args: { changes: [{ path: "r.ts", action: "CREATE" }] } }),
        call({ id: "c-a", status: "ABANDONED", resultRef: null, ordinal: 1,
          args: { changes: [{ path: "a.ts", action: "CREATE" }] } })] }]),
    [preview({ modelCallId: "m-0", ordinal: 0, files: [{ path: "r.ts", action: "CREATE",
      added: 9, removed: 0, targetComplete: true }] }),
      preview({ modelCallId: "m-0", ordinal: 1, files: [{ path: "a.ts", action: "CREATE",
        added: 9, removed: 0, targetComplete: true }] })]);
    expect(rows).toEqual([]);
  });

  it("已结算但没有逐文件账本时不编造局部行", () => {
    const rows = localFileDiffRows(projection([
      { round: 0, modelCallId: "m-0", calls: [call({ id: "c-1", resultRef: null })] }]), []);
    expect(rows).toEqual([]);
  });

  it("迟到片段不覆盖新值：同一身份只取更高 revision", () => {
    const rows = localFileDiffRows(projection([
      { round: 0, modelCallId: "m-0", calls: [] }]),
    [preview({ modelCallId: "m-0", revision: "9", files: [{ path: "x.ts", action: "CREATE",
      added: 90, removed: 0, targetComplete: true }] }),
      // 后到但 revision 更旧：不得把 90 改成 10。
      preview({ modelCallId: "m-0", revision: "3", files: [{ path: "x.ts", action: "CREATE",
        added: 10, removed: 0, targetComplete: true }] })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].added).toBe(90);
  });

  it("读类工具不产生局部行；未落账的预览仍按生成中显示", () => {
    const rows = localFileDiffRows(projection([
      { round: 0, modelCallId: "m-0", calls: [call({ id: "c-read", toolName: "read_file",
        fileChanges: [file({ path: "leak.ts" })] })] }]),
    [preview({ modelCallId: "m-0", ordinal: 4, files: [{ path: "late.ts", action: "CREATE",
      added: 3, removed: 0, targetComplete: false }] })]);
    expect(rows.map((row) => row.path)).toEqual(["late.ts"]);
    expect(rows[0].phase).toBe("generating");
  });

  it("没有投影时不显示任何局部行（切会话的第一帧）", () => {
    expect(localFileDiffRows(null, [preview({ modelCallId: "m-0",
      files: [{ path: "a.ts", action: "CREATE", added: 1, removed: 0, targetComplete: true }] })])).toEqual([]);
  });
});
