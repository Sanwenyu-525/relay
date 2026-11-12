import { useSyncExternalStore } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { RelayApiClient, type RelayApiConnection } from "../api/relayClient";
import { setFrontendDiagnosticSender } from "./frontendDiagnostics";
import { clearSessionArtifacts } from "./sessionArtifacts";
import { clearSessionTranscriptCache } from "./sessionTranscriptCache";

export type RelayDataMode = "fixture" | "live";

export interface RelayConnectionState {
  readonly mode: RelayDataMode;
  readonly client: RelayApiClient | null;
  /** 仅用于界面显示数据来源，不含凭据。 */
  readonly baseUrl: string | null;
  readonly epoch: number;
}

const listeners = new Set<() => void>();
export let relayConnection: RelayConnectionState = { mode: "fixture", client: null, baseUrl: null, epoch: 0 };

function publish(next: Omit<RelayConnectionState, "epoch">): void {
  clearSessionArtifacts();
  // 会话转录缓存按连接代次失效：换工作区/重连后不能把上一个连接的列表先画出来。
  clearSessionTranscriptCache();
  relayConnection = { ...next, epoch: relayConnection.epoch + 1 };
  // 诊断上报跟随当前连接：live 才有可信持久化通道，fixture/断开时清空发送器。
  const diagnostics = next.client;
  setFrontendDiagnosticSender(diagnostics === null
    ? null
    : (report) => diagnostics.reportClientDiagnostic(report));
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useRelayConnection(): RelayConnectionState {
  return useSyncExternalStore(subscribe, () => relayConnection);
}

/** 只有明确的人工连接或受信桌面 bootstrap 成功后才进入 live；凭据仅留内存。 */
export function activateRelayConnection(input: RelayApiConnection): void {
  publish({ mode: "live", client: new RelayApiClient(input), baseUrl: input.baseUrl });
}

/**
 * 桌面版的数据来源只由宿主 `desktop_bootstrap` 决定：已经拿到 live 之后，任何调用方都不能
 * 把它降回示例数据，否则用户会在真实工作空间和假数据之间无声切换。
 * 浏览器开发预览不受此限制，仍可靠此退回 fixture。
 */
export function useFixtureData(): void {
  if (isTauri() && relayConnection.mode === "live") return;
  publish({ mode: "fixture", client: null, baseUrl: null });
}

export function liveClient(): RelayApiClient | null {
  return relayConnection.mode === "live" ? relayConnection.client : null;
}

/** 测试夹具用的强制重置：它要能清掉桌面用例留下的 live，因此不走上面的宿主限制。 */
export function resetRelayConnectionForTest(): void {
  publish({ mode: "fixture", client: null, baseUrl: null });
}
