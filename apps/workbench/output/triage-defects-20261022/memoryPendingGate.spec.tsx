import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { RelayTransportError, type RelayApiClient } from "../../src/api/relayClient";
import MemorySettingsCard from "../../src/components/MemorySettingsCard";
import SessionMemoryPanel from "../../src/components/SessionMemoryPanel";
import { flush, mountReact } from "../../tests/mountApp";
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; });
it("记忆设置结果未核对时普通保存不得创建新命令覆盖原身份", async () => {
  const ids: string[] = [];
  const client = {
    getMemorySettings: vi.fn(async () => ({ workspaceId: "workspace", revision: "3", recallEnabled: true, automaticCompaction: true, autoCapture: true })),
    saveMemorySettings: vi.fn(async (input: { commandId: string }) => { ids.push(input.commandId); throw new RelayTransportError("response lost"); })
  } as unknown as RelayApiClient;
  const mounted = await mountReact(createElement(MemorySettingsCard, { client })); unmount = mounted.unmount; await flush();
  await mounted.wrapper.get('[data-testid="memory-settings-compaction"]').setValue(false);
  await mounted.wrapper.get('[data-testid="memory-settings-save"]').trigger("click"); await flush();
  expect(mounted.wrapper.get('[data-testid="memory-settings-pending"]').text()).toContain(ids[0]!);
  const disabled = mounted.wrapper.get('[data-testid="memory-settings-save"]').attributes("disabled") !== undefined;
  if (!disabled) { await mounted.wrapper.get('[data-testid="memory-settings-save"]').trigger("click"); await flush(); }
  const pendingText = mounted.wrapper.get('[data-testid="memory-settings-pending"]').text();
  console.log("TRIAGE_MEMORY_SETTINGS_PENDING_GATE", JSON.stringify({ disabled, ids, originalStillVisible: pendingText.includes(ids[0]!) }));
  expect(new Set(ids).size).toBe(1);
});
it("会话整理结果未核对时普通整理不得创建新命令覆盖原身份", async () => {
  const ids: string[] = [];
  const client = {
    getSessionMemory: vi.fn(async () => ({ revision: "2", sessionRevision: "3", remember: true, clearedThroughSeq: "0", checkpoint: null, requests: [] })),
    requestSessionMemoryCompaction: vi.fn(async (input: { commandId: string }) => { ids.push(input.commandId); throw new RelayTransportError("response lost"); })
  } as unknown as RelayApiClient;
  const mounted = await mountReact(createElement(SessionMemoryPanel, { client, sessionId: "session", sessionRevision: "3", inflight: false, writeBlocked: false, writeBlockedReason: null }));
  unmount = mounted.unmount; await flush();
  await mounted.wrapper.get('[data-testid="session-memory-compact"]').trigger("click"); await flush();
  expect(mounted.wrapper.get('[data-testid="session-memory-unresolved"]').text()).toContain(ids[0]!);
  const disabled = mounted.wrapper.get('[data-testid="session-memory-compact"]').attributes("disabled") !== undefined;
  if (!disabled) { await mounted.wrapper.get('[data-testid="session-memory-compact"]').trigger("click"); await flush(); }
  const pendingText = mounted.wrapper.get('[data-testid="session-memory-unresolved"]').text();
  console.log("TRIAGE_SESSION_MEMORY_PENDING_GATE", JSON.stringify({ disabled, ids, originalStillVisible: pendingText.includes(ids[0]!) }));
  expect(new Set(ids).size).toBe(1);
});
