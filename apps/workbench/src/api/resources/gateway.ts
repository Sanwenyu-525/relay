import type { DecimalRevision } from "../../types";
import { RelayTransportError } from "../core/errors";
import { RelayHttp } from "../core/http";
import { decimal, directList, integer, nullableString, nullableStringArray, object, string, stringArray } from "../core/primitives";
import { gatewayConnectionSettingsFrom, managedGitReadOutcomeFrom, managedResourceFrom, webImportJobFrom, webImportOperationFrom, webImportSubmissionFrom } from "../parse/gateway";
import { commandEnvelopeFrom } from "../parse/projects";
import type { RelayGatewayCapability, RelayGatewayConnection, RelayGatewayConnectionSettings, RelayGatewayDecision, RelayGatewayPolicy, RelayGatewayPolicyVersion, RelayManagedGitReadInput, RelayManagedGitReadResponse, RelayManagedResource, RelayMockGatewayConnection, RelayMockManagedResource, RelayWebImportJob, RelayWebImportOperation, RelayWebImportSubmission } from "../dtos/gateway";
import type { RelayCommandEnvelope } from "../dtos/projects";

export async function getGatewayConnections(http: RelayHttp, projectId: string): Promise<readonly RelayGatewayConnection[]> {
  const body = await http.request(http.workspacePath(`/projects/${encodeURIComponent(projectId)}/connections`));
  return directList(body, "connection list", (item) => {
    const row = object(item, "connection");
    return { id: string(row, "id", "connection"), status: string(row, "status", "connection"),
      capabilities: stringArray(row, "capabilities", "connection"),
      allowedHost: nullableString(row, "allowed_host", "connection"),
      allowedExecutables: nullableStringArray(row, "allowed_executables", "connection") };
  });
}

export async function getGatewayConnectionSettings(http: RelayHttp, projectId: string): Promise<readonly RelayGatewayConnectionSettings[]> {
  const body = await http.request(http.workspacePath(`/projects/${encodeURIComponent(projectId)}/connections`));
  return directList(body, "connection settings", gatewayConnectionSettingsFrom);
}

export async function getGatewayConnectionSetting(http: RelayHttp, projectId: string, connectionId: string): Promise<RelayGatewayConnectionSettings> {
  return gatewayConnectionSettingsFrom(await http.request(http.workspacePath(`/projects/${encodeURIComponent(projectId)}/connections/${encodeURIComponent(connectionId)}`)));
}

export async function createGatewayConnection(http: RelayHttp, input: { projectId: string; commandId: string; capability: RelayGatewayCapability; rootPath?: string; allowedHost?: string; allowedExecutables?: readonly string[] }): Promise<RelayCommandEnvelope> {
  return commandEnvelopeFrom(await http.request(http.workspacePath(`/projects/${encodeURIComponent(input.projectId)}/connections`), {
    method: "POST", body: JSON.stringify({ command_id: input.commandId, capabilities: [input.capability],
      ...(input.rootPath === undefined ? {} : { root_path: input.rootPath }),
      ...(input.allowedHost === undefined ? {} : { allowed_host: input.allowedHost }),
      ...(input.allowedExecutables === undefined || input.allowedExecutables.length === 0 ? {} :
        { allowed_executables: input.allowedExecutables }) })
  }, 201));
}

export async function disableGatewayConnection(http: RelayHttp, input: { projectId: string; connectionId: string; commandId: string; expectedVersion: DecimalRevision }): Promise<RelayCommandEnvelope> {
  return commandEnvelopeFrom(await http.request(http.workspacePath(`/projects/${encodeURIComponent(input.projectId)}/connections/${encodeURIComponent(input.connectionId)}/disable`), {
    method: "POST", body: JSON.stringify({ command_id: input.commandId, expected_version: input.expectedVersion })
  }, 200));
}

export async function getGatewayPolicies(http: RelayHttp, projectId: string): Promise<readonly RelayGatewayPolicy[]> {
  const body = await http.request(http.workspacePath(`/projects/${encodeURIComponent(projectId)}/permission-policies`));
  return directList(body, "permission policies", (item) => {
    const row = object(item, "permission policy");
    return { id: string(row, "id", "permission policy"),
      projectId: string(row, "project_id", "permission policy"),
      status: string(row, "status", "permission policy"),
      activeVersion: nullableString(row, "active_version", "permission policy"),
      revision: decimal(row, "revision", "permission policy"),
      createdAt: string(row, "created_at", "permission policy") };
  });
}

export async function getGatewayPolicyVersions(http: RelayHttp, projectId: string, policyId: string): Promise<readonly RelayGatewayPolicyVersion[]> {
  const body = await http.request(http.workspacePath(`/projects/${encodeURIComponent(projectId)}/permission-policies/${encodeURIComponent(policyId)}/versions`));
  return directList(body, "permission policy versions", (item) => {
    const row = object(item, "permission policy version");
    return { version: decimal(row, "version", "permission policy version"),
      capability: string(row, "capability", "permission policy version"),
      actionType: string(row, "action_type", "permission policy version"),
      targetPrefix: string(row, "target_prefix", "permission policy version"),
      decision: string(row, "decision", "permission policy version"),
      maxPayloadBytes: integer(row, "max_payload_bytes", "permission policy version"),
      createdAt: string(row, "created_at", "permission policy version") };
  });
}

export async function createGatewayPolicy(http: RelayHttp, input: { projectId: string; commandId: string; capability: RelayGatewayCapability; resourceId: string | null; decision: RelayGatewayDecision; maxPayloadBytes: number; host?: string; actionType?: string }): Promise<RelayCommandEnvelope> {
  return commandEnvelopeFrom(await http.request(http.workspacePath(`/projects/${encodeURIComponent(input.projectId)}/permission-policies`), {
    method: "POST", body: JSON.stringify({ command_id: input.commandId, capability: input.capability,
      resource_id: input.resourceId, decision: input.decision, max_payload_bytes: input.maxPayloadBytes,
      ...(input.host === undefined ? {} : { host: input.host }),
      ...(input.actionType === undefined ? {} : { action_type: input.actionType }) })
  }, 201));
}

export async function addGatewayPolicyVersion(http: RelayHttp, input: { projectId: string; policyId: string; commandId: string; expectedRevision: DecimalRevision; capability: RelayGatewayCapability; resourceId: string | null; decision: RelayGatewayDecision; maxPayloadBytes: number; host?: string; actionType?: string }): Promise<RelayCommandEnvelope> {
  return commandEnvelopeFrom(await http.request(http.workspacePath(`/projects/${encodeURIComponent(input.projectId)}/permission-policies/${encodeURIComponent(input.policyId)}/versions`), {
    method: "POST", body: JSON.stringify({ command_id: input.commandId, expected_revision: input.expectedRevision,
      capability: input.capability, resource_id: input.resourceId, decision: input.decision,
      max_payload_bytes: input.maxPayloadBytes, ...(input.host === undefined ? {} : { host: input.host }),
      ...(input.actionType === undefined ? {} : { action_type: input.actionType }) })
  }, 200));
}

export async function revokeGatewayPolicy(http: RelayHttp, input: { projectId: string; policyId: string; commandId: string; expectedRevision: DecimalRevision }): Promise<RelayCommandEnvelope> {
  return commandEnvelopeFrom(await http.request(http.workspacePath(`/projects/${encodeURIComponent(input.projectId)}/permission-policies/${encodeURIComponent(input.policyId)}/revoke`), {
    method: "POST", body: JSON.stringify({ command_id: input.commandId, expected_revision: input.expectedRevision })
  }, 200));
}

export async function getManagedResources(http: RelayHttp, projectId: string): Promise<readonly RelayManagedResource[]> {
  const body = await http.request(http.workspacePath(`/projects/${encodeURIComponent(projectId)}/managed-resources`));
  return directList(body, "managed resources", managedResourceFrom);
}

export async function getManagedResource(http: RelayHttp, projectId: string, resourceId: string): Promise<RelayManagedResource> {
  return managedResourceFrom(await http.request(http.workspacePath(`/projects/${encodeURIComponent(projectId)}/managed-resources/${encodeURIComponent(resourceId)}`)));
}

export async function readManagedGitState(http: RelayHttp, input: RelayManagedGitReadInput): Promise<RelayManagedGitReadResponse> {
  const body = await http.request(http.workspacePath(`/projects/${encodeURIComponent(input.projectId)}/managed-resources/${encodeURIComponent(input.resourceId)}/git-read`), {
    method: "POST", body: JSON.stringify({ command_id: input.commandId, connection_id: input.connectionId,
      action_type: input.actionType, ...(input.relativePath === undefined ? {} : { path: input.relativePath }),
      ...(input.cached === undefined ? {} : { cached: input.cached }),
      ...(input.limit === undefined ? {} : { limit: input.limit }) })
  }, 200);
  try {
    const envelope = commandEnvelopeFrom(body);
    if (envelope.commandId !== input.commandId) throw new Error("Git 读取回执与原 command_id 不符。");
    return { commandId: envelope.commandId, committedAt: envelope.committedAt,
      outcome: managedGitReadOutcomeFrom(envelope.result, input.actionType) };
  } catch { throw new RelayTransportError("Git 读取响应无法核对，请查询原 command_id 回执。"); }
}

export async function createManagedResource(http: RelayHttp, input: { projectId: string; commandId: string; rootPath: string }): Promise<RelayCommandEnvelope> {
  return commandEnvelopeFrom(await http.request(http.workspacePath(`/projects/${encodeURIComponent(input.projectId)}/managed-resources`), {
    method: "POST", body: JSON.stringify({ command_id: input.commandId, root_path: input.rootPath })
  }, 201));
}

export async function disableManagedResource(http: RelayHttp, input: { projectId: string; resourceId: string; commandId: string; expectedRevision: DecimalRevision }): Promise<RelayCommandEnvelope> {
  return commandEnvelopeFrom(await http.request(http.workspacePath(`/projects/${encodeURIComponent(input.projectId)}/managed-resources/${encodeURIComponent(input.resourceId)}/disable`), {
    method: "POST", body: JSON.stringify({ command_id: input.commandId, expected_revision: input.expectedRevision })
  }, 200));
}

export async function getMockGatewayConnections(http: RelayHttp, projectId: string): Promise<readonly RelayMockGatewayConnection[]> {
  return getGatewayConnections(http, projectId);
}

export async function createWebImportJob(http: RelayHttp, input: { readonly projectId: string; readonly commandId: string; readonly url: string; readonly connectionId: string }): Promise<RelayWebImportSubmission> {
  const body = await http.request(http.workspacePath(`/projects/${encodeURIComponent(input.projectId)}/import-jobs`), {
    method: "POST", body: JSON.stringify({ command_id: input.commandId,
      url: input.url, connection_id: input.connectionId })
  }, 201);
  try {
    const envelope = commandEnvelopeFrom(body);
    if (envelope.commandId !== input.commandId) throw new Error("command ID mismatch");
    return webImportSubmissionFrom(envelope.result, input.projectId, input.connectionId);
  } catch {
    throw new RelayTransportError("网页导入回执无法核对，请查询原 command_id。");
  }
}

export async function getWebImportJob(http: RelayHttp, importJobId: string): Promise<RelayWebImportJob> {
  return webImportJobFrom(await http.request(http.workspacePath(`/import-jobs/${encodeURIComponent(importJobId)}`)));
}

export async function getWebImportOperations(http: RelayHttp, importJobId: string): Promise<readonly RelayWebImportOperation[]> {
  const body = await http.request(http.workspacePath(`/import-jobs/${encodeURIComponent(importJobId)}/operations`));
  return directList(body, "import operation list", (item) => webImportOperationFrom(item, importJobId));
}

export async function getMockManagedResources(http: RelayHttp, projectId: string): Promise<readonly RelayMockManagedResource[]> {
  const body = await http.request(http.workspacePath(`/projects/${encodeURIComponent(projectId)}/managed-resources`));
  return directList(body, "Mock resource list", (item) => {
    const row = object(item, "Mock resource");
    return { id: string(row, "id", "Mock resource"),
      canonicalRoot: string(row, "canonical_root", "Mock resource"),
      status: string(row, "status", "Mock resource") };
  });
}
