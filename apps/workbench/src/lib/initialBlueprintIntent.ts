import type { RelayApiClient } from "../api/relayClient";

function key(client: RelayApiClient, projectId: string) {
  return `relay:initial-blueprint-intent:${client.baseUrl}:${client.workspaceId}:${projectId}`;
}

export function saveInitialBlueprintIntent(client: RelayApiClient, projectId: string,
  intent: string): boolean {
  try {
    sessionStorage.setItem(key(client, projectId), intent);
    return true;
  } catch { return false; }
}

export function readInitialBlueprintIntent(client: RelayApiClient, projectId: string): string | null {
  try { return sessionStorage.getItem(key(client, projectId)); }
  catch { return null; }
}

export function clearInitialBlueprintIntent(client: RelayApiClient, projectId: string) {
  try { sessionStorage.removeItem(key(client, projectId)); }
  catch { /* The persisted candidate is already authoritative. */ }
}
