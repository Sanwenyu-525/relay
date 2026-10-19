import { array, boolean, decimal, integer, nullableString, nullableStringArray, object, optionalString, string, stringArray } from "../core/primitives";
import type { RelayGatewayDecision, RelayGatewayConnectionSettings, RelayGitReadAction, RelayManagedGitReadOutcome, RelayManagedResource, RelayWebImportJob, RelayWebImportOperation, RelayWebImportSubmission, RelayWriteReadiness } from "../dtos/gateway";

/** 写档位投影：缺档位当作「未核对」，无法识别的档位显式失败，不当成空值蒙混。 */
export function writeReadinessFrom(value: unknown): RelayWriteReadiness {
  const row = object(value, "write readiness");
  const decision = optionalString(row, "policy_decision");
  if (decision !== null && decision !== "DENY" && decision !== "ASK" && decision !== "AUTO") {
    throw new Error("write readiness.policy_decision 无法识别");
  }
  const writeTier = optionalString(row, "write_tier");
  if (writeTier !== null && writeTier !== "READ_ONLY" && writeTier !== "ASK" &&
      writeTier !== "AUTO" && writeTier !== "FULL") {
    throw new Error("write readiness.write_tier 无法识别");
  }
  const accessRevision = optionalString(row, "access_revision") ?? "0";
  if (!/^(0|[1-9][0-9]*)$/u.test(accessRevision)) throw new Error("write readiness.access_revision 无法识别");
  return { status: string(row, "status", "write readiness"),
    detail: string(row, "detail", "write readiness"),
    policyDecision: decision === null ? null : decision as RelayGatewayDecision,
    policyId: optionalString(row, "policy_id"),
    policyRevision: optionalString(row, "policy_revision"),
    policyTargetPrefix: optionalString(row, "policy_target_prefix"),
    writeTier, accessRevision };
}

export function gatewayConnectionSettingsFrom(value: unknown): RelayGatewayConnectionSettings {
  const row = object(value, "connection settings");
  return { id: string(row, "id", "connection settings"),
    projectId: string(row, "project_id", "connection settings"),
    status: string(row, "status", "connection settings"),
    version: decimal(row, "version", "connection settings"),
    capabilities: stringArray(row, "capabilities", "connection settings"),
    allowedHost: nullableString(row, "allowed_host", "connection settings"),
    allowedExecutables: nullableStringArray(row, "allowed_executables", "connection settings"),
    createdAt: string(row, "created_at", "connection settings") };
}

export function managedResourceFrom(value: unknown): RelayManagedResource {
  const row = object(value, "managed resource");
  return { id: string(row, "id", "managed resource"),
    projectId: string(row, "project_id", "managed resource"),
    canonicalRoot: string(row, "canonical_root", "managed resource"),
    status: string(row, "status", "managed resource"),
    revision: decimal(row, "revision", "managed resource"),
    resourceEpoch: decimal(row, "resource_epoch", "managed resource"),
    // file_write_identity_bound 是受管资源投影的必有布尔字段（gateway-queries.ts、
    // working-directory-api.ts）。这里仍用 === true：收紧为 boolean() 会让 tests/ 的旧夹具
    // （connectionsSettings.spec.ts 的 resources 未带该字段）失败，故登记在审查报告里。
    fileWriteIdentityBound: row.file_write_identity_bound === true };
}

/** 首次响应与原命令回执共用；缺结果、失败、未决都不能补成空列表。 */
export function managedGitReadOutcomeFrom(value: unknown, expectedAction: RelayGitReadAction): RelayManagedGitReadOutcome {
  const row = object(value, "git-read");
  const actionType = string(row, "action_type", "git-read");
  if (actionType !== expectedAction) throw new Error("Git 读取结果与原动作不符。");
  const operationId = string(row, "operation_id", "git-read");
  if (row.state === "WAITING_APPROVAL" || row.state === "UNRESOLVED") {
    if (row.result !== undefined) throw new Error("未决 Git 读取不能携带已结算结果。");
    return { state: row.state, actionType, operationId,
      reviewId: nullableString(row, "review_id", "git-read"), reason: string(row, "reason", "git-read") };
  }
  if (row.state !== "SUCCEEDED" && row.state !== "FAILED") throw new Error("Git 读取状态无效。");
  const result = object(row.result, "git-read.result");
  const settled = { state: row.state, actionType, operationId,
    invocationId: nullableString(row, "invocation_id", "git-read") } as const;
  if (result.reason !== undefined) return { ...settled,
    result: { kind: "FAILURE", reason: string(result, "reason", "git-read.result"),
      detail: result.detail === undefined ? null : string(result, "detail", "git-read.result") } };
  if (row.state === "FAILED") throw new Error("失败的 Git 读取缺少失败原因。");
  const count = (source: Record<string, unknown>, key: string): number => {
    const value = integer(source, key, "git-read.result");
    if (value < 0) throw new Error("Git 读取计数不能为负数。");
    return value;
  };
  if (actionType === "GIT_STATUS") {
    const totals = object(result.totals, "git-read.result.totals");
    return { ...settled, result: { kind: "STATUS", branch: string(result, "branch", "git-read.result"),
      headCommit: nullableString(result, "head_commit", "git-read.result"),
      staged: stringArray(result, "staged", "git-read.result"), unstaged: stringArray(result, "unstaged", "git-read.result"),
      untracked: stringArray(result, "untracked", "git-read.result"), limit: count(result, "limit"),
      truncated: boolean(result, "truncated", "git-read.result"),
      totals: { staged: count(totals, "staged"), unstaged: count(totals, "unstaged"), untracked: count(totals, "untracked") } } };
  }
  return { ...settled, result: { kind: "DIFF", diff: string(result, "diff", "git-read.result"),
    limitBytes: count(result, "limit_bytes"), truncated: boolean(result, "truncated", "git-read.result"),
    returnedBytes: count(result, "returned_bytes"), omittedBytes: count(result, "omitted_bytes") } };
}

export function webImportSubmissionFrom(value: unknown, projectId: string, connectionId: string): RelayWebImportSubmission {
  const row = object(value, "web import submission");
  if (string(row, "project_id", "web import submission") !== projectId ||
      string(row, "connection_id", "web import submission") !== connectionId ||
      string(row, "status", "web import submission") !== "QUEUED") {
    throw new Error("web import submission 与目标不匹配。");
  }
  return { importJobId: string(row, "import_job_id", "web import submission"),
    projectId, connectionId, status: "QUEUED" };
}

export function webImportJobFrom(value: unknown): RelayWebImportJob {
  const row = object(value, "web import job");
  const status = string(row, "status", "web import job");
  if (status !== "QUEUED" && status !== "RUNNING" && status !== "SUCCEEDED" && status !== "FAILED") {
    throw new Error("web import job.status 响应格式无效。");
  }
  return { id: string(row, "id", "web import job"), projectId: string(row, "project_id", "web import job"),
    sourceUri: string(row, "source_uri", "web import job"), status,
    revision: decimal(row, "revision", "web import job"),
    error: nullableString(row, "error", "web import job"),
    knowledgeVersionId: nullableString(row, "knowledge_version_id", "web import job"),
    requestCommandId: string(row, "request_command_id", "web import job"),
    createdAt: string(row, "created_at", "web import job") };
}

export function webImportOperationFrom(value: unknown, importJobId: string): RelayWebImportOperation {
  const row = object(value, "web import operation");
  if (string(row, "origin", "web import operation") !== "USER_IMPORT" ||
      string(row, "import_job_id", "web import operation") !== importJobId) {
    throw new Error("web import operation 与 Job 不匹配。");
  }
  return { id: string(row, "id", "web import operation"), importJobId,
    status: string(row, "status", "web import operation"),
    actionType: string(row, "action_type", "web import operation"),
    normalizedTarget: string(row, "normalized_target", "web import operation"),
    invocationStatuses: array(row, "invocations", "web import operation").map((invocation) =>
      string(object(invocation, "web import invocation"), "status", "web import invocation")) };
}
