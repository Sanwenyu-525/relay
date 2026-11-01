import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RelayApiClient } from "../src/api/relayClient";
import type { RelayExecutionActivityMessage,
  RelayExecutionActivitySnapshot } from "../src/api/dtos/assist";
import { useSessionActivity } from "../src/lib/useSessionActivity";
import { flush, mountReact } from "./mountApp";

/**
 * ENG-OBS-02 P0-C：会话活动轮询的唯一 Owner。
 *
 * 只依赖服务端快照，因此这里用可控客户端钉住五条边界：
 *   * 初始读 full；在途才读 summary；指纹变化才补读 full；
 *   * 同一时刻只有一条在途请求（单飞）；
 *   * 切会话后迟到的旧响应不能覆盖新会话；
 *   * 终态停止轮询；
 *   * 读失败保留上一份权威事实，只标记可能过期。
 */

let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; vi.useRealTimers(); });

function activityMessage(fingerprint: string): RelayExecutionActivityMessage {
  return { messageId: "m1", seq: "2", role: "ASSISTANT", status: "RUNNING",
    intent: "DISCUSS", createdAt: "2026-11-01T00:00:00.000Z", claimedAt: null,
    settledAt: null, updatedAt: "2026-11-01T00:00:01.000Z", cancelRequested: false,
    sourceUserMessageId: null, contentFingerprint: fingerprint, processEvidence: "UNKNOWN",
    phase: { raw: "RUNNING", view: "PROCESSING", tone: "active",
      since: null, detail: "正在处理", waitCode: null, waitDetail: null },
    executionRequest: null, runSummary: null, activities: undefined,
    activityCounts: { modelCalls: 0, toolCalls: 0, todoWrites: 0, delegations: 0 },
    gaps: [] };
}

function snapshot(sessionId: string, fingerprint = "a"): RelayExecutionActivitySnapshot {
  return { schemaVersion: 1, sessionId, workspaceId: "ws", generatedAt: "now",
    snapshotAt: "now", messages: [activityMessage(fingerprint)],
    nextBeforeSeq: null, hasMore: false };
}

function Probe({ client, sessionId, active }: { client: RelayApiClient;
  sessionId: string; active: boolean }) {
  const state = useSessionActivity({ client, sessionId, active });
  return <div data-testid="probe" data-session={state.snapshot?.sessionId ?? ""}
    data-count={state.snapshot?.messages.length ?? 0}
    data-error={state.error ?? ""}>
    {(state.snapshot?.messages ?? []).map((message) =>
      <span key={message.messageId} data-fingerprint={message.contentFingerprint} />)}
  </div>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

describe("会话活动轮询", () => {
  it("初始读 full；指纹不变不补读，指纹变化才补读 full", async () => {
    let fingerprint = "a";
    const calls: string[] = [];
    const client = { async getAssistExecutionActivity(input: { sessionId: string;
      detail?: "summary" | "full" }) {
      calls.push(input.detail ?? "full");
      return snapshot(input.sessionId, fingerprint);
    } } as unknown as RelayApiClient;
    const mounted = await mountReact(<Probe client={client} sessionId="session-a" active />);
    unmount = mounted.unmount;
    await flush(20);
    expect(calls).toEqual(["full"]);
    await flush(950);
    expect(calls).toEqual(["full", "summary"]);
    expect(mounted.wrapper.get('[data-testid="probe"]').attributes("data-session"))
      .toBe("session-a");

    fingerprint = "b";
    await flush(950);
    await flush(100);
    expect(calls).toEqual(["full", "summary", "summary", "full"]);
    expect(mounted.wrapper.get('[data-testid="probe"]')
      .find('span[data-fingerprint="b"]').exists()).toBe(true);
  });

  it("切会话后迟到的旧响应不能覆盖新会话", async () => {
    const first = deferred<RelayExecutionActivitySnapshot>();
    const second = deferred<RelayExecutionActivitySnapshot>();
    const client = { getAssistExecutionActivity(input: { sessionId: string }) {
      return input.sessionId === "session-a" ? first.promise : second.promise;
    } } as unknown as RelayApiClient;
    const mounted = await mountReact(<Probe client={client} sessionId="session-a" active={false} />);
    unmount = mounted.unmount;
    await flush(10);
    await mounted.rerender(<Probe client={client} sessionId="session-b" active={false} />);
    await flush(10);
    await act(async () => { second.resolve(snapshot("session-b", "b")); });
    await flush(20);
    expect(mounted.wrapper.get('[data-testid="probe"]').attributes("data-session"))
      .toBe("session-b");
    await act(async () => { first.resolve(snapshot("session-a", "a")); });
    await flush(20);
    expect(mounted.wrapper.get('[data-testid="probe"]').attributes("data-session"),
      "迟到响应必须按请求代次丢弃").toBe("session-b");
  });

  it("终态不轮询；读失败保留上一份快照并标记可能过期", async () => {
    let fail = false;
    let calls = 0;
    const client = { async getAssistExecutionActivity(input: { sessionId: string;
      detail?: "summary" | "full" }) {
      calls += 1;
      if (fail) throw new Error("network down");
      return snapshot(input.sessionId, "a");
    } } as unknown as RelayApiClient;
    const mounted = await mountReact(<Probe client={client} sessionId="session-a" active={false} />);
    unmount = mounted.unmount;
    await flush(20);
    expect(calls).toBe(1);
    await flush(1_000);
    expect(calls, "终态消息不再有意义的周期读取").toBe(1);

    await mounted.rerender(<Probe client={client} sessionId="session-a" active />);
    await flush(20);
    const afterActive = calls;
    fail = true;
    await flush(950);
    expect(calls).toBeGreaterThan(afterActive);
    const probe = mounted.wrapper.get('[data-testid="probe"]');
    expect(probe.attributes("data-count"), "读失败不能清空已确认事实").toBe("1");
    expect(probe.attributes("data-error")).toContain("network down");
  });
});
