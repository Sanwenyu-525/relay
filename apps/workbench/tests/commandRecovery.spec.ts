import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RelayApiError, RelayContractError, RelayTransportError } from "../src/api/core/errors";
import type { RelayCommandReceipt } from "../src/api/dtos/projects";
import {
  checkRecoveryNow, configureCommandRecoveryForTest, openRecoveryScope, recoveryStorageKey,
  registerRecoveryOwner, removeRecovery, resetCommandRecoveryForTest, upsertRecovery,
  type ApplyOutcome, type RecoveryFailure, type RecoveryOwner, type RecoveryRecord
} from "../src/lib/commandRecovery";

/**
 * 自动回执恢复协调者的确定性用例（AUTO-RECEIPT-RECOVERY §7）。
 *
 * 这里只验证「谁查询、查几次、失败怎么分类、什么时候收口」：受控的 fetchReceipt、
 * 确定性退避与假时钟；不挂载页面。页面级状态同步由 modelSwitchReceiptRecovery.spec.ts 覆盖。
 */

const scope = "http://127.0.0.1:8787:workspace-a";
const otherScope = "http://127.0.0.1:8787:workspace-b";
const sessionId = "33333333-3333-4333-8333-333333333333";
const commandId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const secondCommandId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function record(id = commandId, extra: Partial<RecoveryRecord> = {}): RecoveryRecord {
  return { commandId: id, commandType: "SelectSessionConnection", sessionId,
    targetKind: "SESSION", targetId: sessionId, ...extra };
}

function receipt(id = commandId, overrides: Partial<RelayCommandReceipt> = {}): RelayCommandReceipt {
  return { commandId: id, commandType: "SelectSessionConnection",
    committedAt: "2026-11-02T00:00:00Z",
    result: { session_id: sessionId, model: "spark-x2.6", connection_id: "4444" }, ...overrides };
}

function apiError(status: number, code: string, detail = "服务端错误"): RelayApiError {
  return new RelayApiError({ status, code, detail, retryable: status >= 500,
    retryAction: null, fieldErrors: [], expectedRevision: null, actualRevision: null });
}

interface FakeOwnerOptions {
  readonly scope?: string;
  readonly claims?: (value: RecoveryRecord) => boolean;
  readonly verify?: (value: RecoveryRecord, value2: RelayCommandReceipt) => RecoveryFailure | null;
  readonly apply?: (value: RecoveryRecord, value2: RelayCommandReceipt,
    context: { readonly trigger: "auto" | "manual" }) => Promise<ApplyOutcome>;
  readonly fetchReceipt: (id: string, signal: AbortSignal) => Promise<RelayCommandReceipt>;
}

function fakeOwner(options: FakeOwnerOptions) {
  const calls: string[] = [];
  const owner: RecoveryOwner = {
    scope: options.scope ?? scope,
    claims: options.claims ?? (() => true),
    verify: options.verify ?? (() => null),
    apply: options.apply ?? (async () => "APPLIED"),
    fetchReceipt: (id, signal) => { calls.push(id); return options.fetchReceipt(id, signal); }
  };
  return { owner, calls };
}

/** 推进假时钟并让查询 Promise 的微任务结算。 */
async function tick(milliseconds = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(milliseconds);
  await Promise.resolve();
}

function stored(scopeValue = scope): readonly RecoveryRecord[] {
  return openRecoveryScope(scopeValue).map((entry) => entry.record);
}

beforeEach(() => {
  window.sessionStorage.clear();
  resetCommandRecoveryForTest();
  vi.useFakeTimers();
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
});

afterEach(() => {
  resetCommandRecoveryForTest();
  vi.useRealTimers();
  window.sessionStorage.clear();
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
});

describe("命令回执自动恢复协调者", () => {
  it("成功一次即收口：只查原 command_id，清记录不代表替代身份校验", async () => {
    const { owner, calls } = fakeOwner({ fetchReceipt: async (id) => receipt(id) });
    registerRecoveryOwner(owner);
    upsertRecovery(scope, record());
    await tick();
    expect(calls).toEqual([commandId]);
    expect(stored()).toEqual([]);
  });

  it("正常成功没有未决记录时不启动任何查询", async () => {
    const { owner, calls } = fakeOwner({ fetchReceipt: async (id) => receipt(id) });
    registerRecoveryOwner(owner);
    await tick();
    expect(calls).toEqual([]);
  });

  it("同一命令重复上报只保留一条记录，重复触发不产生第二条款查询", async () => {
    const deferred: { release?: (value: RelayCommandReceipt) => void } = {};
    const { owner, calls } = fakeOwner({ fetchReceipt: () => new Promise((resolve) => { deferred.release = resolve; }) });
    registerRecoveryOwner(owner);
    upsertRecovery(scope, record());
    upsertRecovery(scope, record());
    await tick();
    expect(calls).toEqual([commandId]);
    expect(stored()).toHaveLength(1);
    deferred.release?.(receipt());
    await tick();
    expect(stored()).toEqual([]);
  });

  it("同命令并发手动核对共用同一条在途查询", async () => {
    const deferred: { release?: (value: RelayCommandReceipt) => void } = {};
    const { owner, calls } = fakeOwner({ fetchReceipt: () => new Promise((resolve) => { deferred.release = resolve; }) });
    registerRecoveryOwner(owner);
    upsertRecovery(scope, record());
    await tick();
    const first = checkRecoveryNow(scope, commandId);
    const second = checkRecoveryNow(scope, commandId);
    expect(calls).toEqual([commandId]);
    deferred.release?.(receipt());
    const outcomes = await Promise.all([first, second]);
    expect(outcomes).toEqual([
      { kind: "RESOLVED", record: record() },
      { kind: "RESOLVED", record: record() }
    ]);
    expect(stored()).toEqual([]);
  });

  it("首次失败后按退避重试并最终收口", async () => {
    configureCommandRecoveryForTest({ delaysMs: [0, 5, 5], maxAttempts: 3, jitterRatio: 0 });
    let attempt = 0;
    const { owner, calls } = fakeOwner({
      fetchReceipt: async (id) => { attempt += 1; if (attempt === 1) throw new RelayTransportError(); return receipt(id); }
    });
    registerRecoveryOwner(owner);
    upsertRecovery(scope, record());
    await tick();
    expect(calls).toEqual([commandId]);
    await tick(5);
    expect(calls).toEqual([commandId, commandId]);
    expect(stored()).toEqual([]);
  });

  it("持续失败到上限后停止自动查询，记录保留", async () => {
    configureCommandRecoveryForTest({ delaysMs: [0, 5, 5], maxAttempts: 3, jitterRatio: 0 });
    const { owner, calls } = fakeOwner({ fetchReceipt: async () => { throw new RelayTransportError(); } });
    registerRecoveryOwner(owner);
    upsertRecovery(scope, record());
    await tick();
    await tick(5);
    await tick(5);
    expect(calls).toHaveLength(3);
    const [entry] = openRecoveryScope(scope);
    expect(entry?.phase).toBe("EXHAUSTED");
    expect(entry?.failure).toBe("UNAVAILABLE");
    // 到上限后不再自行产生高频请求。
    await tick(60_000);
    expect(calls).toHaveLength(3);
    expect(stored()).toHaveLength(1);
  });

  it("404 COMMAND_NOT_FOUND 当作回执尚不存在，不当作明确失败", async () => {
    configureCommandRecoveryForTest({ delaysMs: [0], maxAttempts: 1, jitterRatio: 0 });
    const { owner, calls } = fakeOwner({
      fetchReceipt: async () => { throw apiError(404, "COMMAND_NOT_FOUND", "还没有这条命令的回执"); }
    });
    registerRecoveryOwner(owner);
    upsertRecovery(scope, record());
    await tick();
    expect(calls).toHaveLength(1);
    const [entry] = openRecoveryScope(scope);
    expect(entry?.failure).toBe("RECEIPT_MISSING");
    expect(entry?.httpStatus).toBe(404);
    expect(stored()).toHaveLength(1);
  });

  it("服务端明确拒绝查询：分类为 DENIED，保留身份但不继续自动重试", async () => {
    configureCommandRecoveryForTest({ delaysMs: [0, 5], maxAttempts: 3, jitterRatio: 0 });
    const { owner, calls } = fakeOwner({
      fetchReceipt: async () => { throw apiError(403, "FORBIDDEN", "没有查询回执的权限"); }
    });
    registerRecoveryOwner(owner);
    upsertRecovery(scope, record());
    await tick();
    await tick(10);
    expect(calls).toHaveLength(1);
    const [entry] = openRecoveryScope(scope);
    expect(entry?.failure).toBe("DENIED");
    expect(entry?.phase).toBe("EXHAUSTED");
    expect(stored()).toHaveLength(1);
  });

  it("回执格式异常分类为 MALFORMED，可按上限重试", async () => {
    configureCommandRecoveryForTest({ delaysMs: [0, 5], maxAttempts: 2, jitterRatio: 0 });
    const { owner, calls } = fakeOwner({
      fetchReceipt: async () => { throw new RelayContractError("回执正文不符合契约"); }
    });
    registerRecoveryOwner(owner);
    upsertRecovery(scope, record());
    await tick();
    await tick(5);
    expect(calls).toHaveLength(2);
    const [entry] = openRecoveryScope(scope);
    expect(entry?.failure).toBe("MALFORMED");
    expect(stored()).toHaveLength(1);
  });

  it("回执身份不匹配：保持未决，且不误清其他命令", async () => {
    const { owner, calls } = fakeOwner({
      claims: (value) => value.commandId === commandId || value.commandId === secondCommandId,
      verify: (value) => value.commandId === commandId ? "IDENTITY_MISMATCH" : null,
      fetchReceipt: async (id) => receipt(id)
    });
    registerRecoveryOwner(owner);
    upsertRecovery(scope, record(commandId));
    upsertRecovery(scope, record(secondCommandId));
    await tick();
    expect(calls.sort()).toEqual([commandId, secondCommandId].sort());
    const remaining = stored();
    expect(remaining.map((item) => item.commandId)).toEqual([commandId]);
    const [entry] = openRecoveryScope(scope);
    expect(entry?.failure).toBe("IDENTITY_MISMATCH");
    expect(entry?.phase).toBe("EXHAUSTED");
  });

  it("删除一条记录只作用于这条命令", async () => {
    const { owner } = fakeOwner({ fetchReceipt: async () => { throw new RelayTransportError(); } });
    registerRecoveryOwner(owner);
    upsertRecovery(scope, record(commandId));
    upsertRecovery(scope, record(secondCommandId));
    await tick();
    removeRecovery(scope, commandId);
    expect(stored().map((item) => item.commandId)).toEqual([secondCommandId]);
  });

  it("离线时暂停，网络恢复后自动接续", async () => {
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: false });
    const { owner, calls } = fakeOwner({ fetchReceipt: async (id) => receipt(id) });
    registerRecoveryOwner(owner);
    upsertRecovery(scope, record());
    await tick();
    expect(calls).toEqual([]);
    expect(openRecoveryScope(scope)[0]?.phase).toBe("PAUSED");

    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
    window.dispatchEvent(new Event("online"));
    await tick();
    expect(calls).toEqual([commandId]);
    expect(stored()).toEqual([]);
  });

  it("窗口重新获得焦点：到上限的命令再获得一次核对机会", async () => {
    configureCommandRecoveryForTest({ delaysMs: [0, 0], maxAttempts: 2, jitterRatio: 0 });
    const { owner, calls } = fakeOwner({ fetchReceipt: async () => { throw new RelayTransportError(); } });
    registerRecoveryOwner(owner);
    upsertRecovery(scope, record());
    await tick();
    // 第二次退避是 delays[index=1]=0，jitter 至少保留 1ms，不能用 0ms 推进。
    await tick(1);
    expect(calls).toHaveLength(2);
    expect(openRecoveryScope(scope)[0]?.phase).toBe("EXHAUSTED");

    window.dispatchEvent(new Event("focus"));
    await tick();
    expect(calls).toHaveLength(3);
    // 只给一次机会，不恢复永久轮询。
    await tick(60_000);
    expect(calls).toHaveLength(3);
  });

  it("页面重新进入：加载 sessionStorage 既有未决并自动核对", async () => {
    window.sessionStorage.setItem(recoveryStorageKey(scope), JSON.stringify([record()]));
    expect(openRecoveryScope(scope)).toHaveLength(1);
    const { owner, calls } = fakeOwner({ fetchReceipt: async (id) => receipt(id) });
    registerRecoveryOwner(owner);
    await tick();
    expect(calls).toEqual([commandId]);
    expect(stored()).toEqual([]);
  });

  it("卸载 Owner 中断在途查询：不写失效状态，重新挂载后继续", async () => {
    const deferred: { reject?: (reason: unknown) => void } = {};
    let attempt = 0;
    const { owner, calls } = fakeOwner({
      fetchReceipt: (_id, signal) => {
        attempt += 1;
        if (attempt === 1) {
          return new Promise((_resolve, reject) => {
            deferred.reject = reject;
            signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          });
        }
        return Promise.resolve(receipt());
      }
    });
    const dispose = registerRecoveryOwner(owner);
    upsertRecovery(scope, record());
    await tick();
    expect(calls).toHaveLength(1);
    dispose();
    expect(openRecoveryScope(scope)[0]?.phase).toBe("PAUSED");
    // 中止后的迟到拒绝不得把记录改成失败或清除。
    deferred.reject?.(new DOMException("aborted", "AbortError"));
    await tick();
    expect(stored()).toHaveLength(1);
    expect(openRecoveryScope(scope)[0]?.phase).toBe("PAUSED");

    const next = fakeOwner({ fetchReceipt: async (id) => receipt(id) });
    registerRecoveryOwner(next.owner);
    await tick();
    expect(next.calls).toEqual([commandId]);
    expect(stored()).toEqual([]);
  });

  it("迟到响应不覆盖已删除的状态：中途清记录后不再被视为成功", async () => {
    const deferred: { resolve?: (value: ApplyOutcome) => void } = {};
    const { owner, calls } = fakeOwner({
      fetchReceipt: async (id) => receipt(id),
      apply: () => new Promise<ApplyOutcome>((resolve) => { deferred.resolve = resolve; })
    });
    registerRecoveryOwner(owner);
    upsertRecovery(scope, record());
    await tick();
    expect(calls).toEqual([commandId]);
    removeRecovery(scope, commandId);
    expect(stored()).toEqual([]);
    deferred.resolve?.("APPLIED");
    await tick();
    expect(stored()).toEqual([]);
  });

  it("不同 Workspace 不混淆：同一 command_id 各自独立", async () => {
    const { owner } = fakeOwner({ fetchReceipt: async () => { throw new RelayTransportError(); } });
    const first = fakeOwner({ scope: otherScope, fetchReceipt: async () => { throw new RelayTransportError(); } });
    window.sessionStorage.setItem(recoveryStorageKey(scope), JSON.stringify([record()]));
    window.sessionStorage.setItem(recoveryStorageKey(otherScope), JSON.stringify([record()]));
    registerRecoveryOwner(owner);
    registerRecoveryOwner(first.owner);
    await tick();
    removeRecovery(scope, commandId);
    expect(stored(scope)).toEqual([]);
    expect(stored(otherScope)).toHaveLength(1);
  });

  it("已解决的记录不复发：重新打开作用域不会重放查询", async () => {
    const { owner } = fakeOwner({ fetchReceipt: async (id) => receipt(id) });
    registerRecoveryOwner(owner);
    upsertRecovery(scope, record());
    await tick();
    expect(stored()).toEqual([]);
    const next = fakeOwner({ fetchReceipt: async (id) => receipt(id) });
    registerRecoveryOwner(next.owner);
    await tick();
    expect(next.calls).toEqual([]);
  });
});
