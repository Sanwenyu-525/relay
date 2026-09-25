import { useSyncExternalStore } from "react";
import { RelayApiClient, type RelayApiConnection } from "../api/relayClient";
import { clearSessionArtifacts } from "./sessionArtifacts";

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
  relayConnection = { ...next, epoch: relayConnection.epoch + 1 };
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

export function useFixtureData(): void {
  publish({ mode: "fixture", client: null, baseUrl: null });
}

export function liveClient(): RelayApiClient | null {
  return relayConnection.mode === "live" ? relayConnection.client : null;
}

export function resetRelayConnectionForTest(): void {
  useFixtureData();
}
