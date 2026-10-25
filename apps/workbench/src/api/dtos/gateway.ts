import type { DecimalRevision } from "../../types";

export interface RelayMockGatewayAction {
  readonly connectionId: string;
  readonly resourceId: string;
  readonly target: string;
  readonly content: string;
}

export interface RelayFileReadAction {
  readonly connectionId: string;
  readonly resourceId: string;
  readonly relativeTarget: string;
}

export interface RelayWebFetchAction {
  readonly connectionId: string;
  readonly url: string;
}

export interface RelayGatewayConnection {
  readonly id: string;
  readonly status: string;
  readonly capabilities: readonly string[];
  readonly allowedHost: string | null;
  /**
   * CLI_RUN 连接上点名的根外可执行入口。null 表示未配置——
   * 此时只有受管目录内的脚本能作为检查入口。
   */
  readonly allowedExecutables: readonly string[] | null;
}

/** 与服务端 `GatewayCapability`（infrastructure/database-schema.ts）同一词表；开放扩展时先加后端。 */
export type RelayGatewayCapability =
  | "FAKE_WRITE" | "FAKE_PUBLIC_READ" | "FILE_READ" | "FILE_QUERY" | "FILE_WRITE" | "WEB_FETCH"
  | "GIT_READ" | "GIT_WRITE" | "CLI_RUN"
  | "COMPUTER_READ" | "COMPUTER_INPUT"
  | "GITHUB_READ"
  | "BROWSER_READ" | "BROWSER_ACTION" | "BROWSER_COMMIT";

export type RelayGatewayDecision = "DENY" | "ASK" | "AUTO";

/** 本目录写入档位。FULL（界面「完全访问」）与 AUTO 在服务端策略行上同为 AUTO，
 *  差别只在目录档位这一列，因此界面必须读投影的 write_tier，不能只看 policyDecision。 */
export type RelayWriteTier = "READ_ONLY" | "ASK" | "AUTO" | "FULL";

/**
 * 某个受管目录的写档位投影（GET …/managed-resources/:id/write-readiness）。
 *
 * 档位与「最严格者优先」的排序都在服务端完成，与准入门禁同源；界面只显示这里的值，
 * 不再自己比较策略。policyId / policyRevision 是调整档位所需的乐观锁坐标。
 */
export interface RelayWriteReadiness {
  readonly status: string;
  readonly detail: string;
  readonly policyDecision: RelayGatewayDecision | null;
  readonly policyId: string | null;
  readonly policyRevision: string | null;
  readonly policyTargetPrefix: string | null;
  readonly writeTier: RelayWriteTier | null;
  readonly accessRevision: DecimalRevision;
}

export interface RelayGatewayConnectionSettings extends RelayGatewayConnection {
  readonly projectId: string;
  readonly version: DecimalRevision;
  readonly createdAt: string;
}

export interface RelayGatewayPolicy {
  readonly id: string;
  readonly projectId: string;
  readonly status: string;
  readonly activeVersion: DecimalRevision | null;
  readonly revision: DecimalRevision;
  readonly createdAt: string;
}

export interface RelayGatewayPolicyVersion {
  readonly version: DecimalRevision;
  readonly capability: string;
  readonly actionType: string;
  readonly targetPrefix: string;
  readonly decision: string;
  readonly maxPayloadBytes: number;
  readonly createdAt: string;
}

export interface RelayManagedResource {
  readonly id: string;
  readonly projectId: string;
  readonly canonicalRoot: string;
  readonly status: string;
  readonly revision: DecimalRevision;
  readonly resourceEpoch: DecimalRevision;
  readonly fileWriteIdentityBound: boolean;
}

export type RelayGitReadAction = "GIT_STATUS" | "GIT_DIFF";

export interface RelayManagedGitReadInput {
  readonly projectId: string;
  readonly resourceId: string;
  readonly connectionId: string;
  readonly commandId: string;
  readonly actionType: RelayGitReadAction;
  readonly relativePath?: string;
  readonly cached?: boolean;
  readonly limit?: number;
}

export interface RelayGitStatusResult {
  readonly kind: "STATUS";
  readonly branch: string;
  readonly headCommit: string | null;
  readonly staged: readonly string[];
  readonly unstaged: readonly string[];
  readonly untracked: readonly string[];
  readonly limit: number;
  readonly truncated: boolean;
  readonly totals: { readonly staged: number; readonly unstaged: number; readonly untracked: number };
}

export interface RelayGitDiffResult {
  readonly kind: "DIFF";
  readonly diff: string;
  readonly limitBytes: number;
  readonly truncated: boolean;
  readonly returnedBytes: number;
  readonly omittedBytes: number;
}

export type RelayManagedGitReadOutcome = {
  readonly state: "WAITING_APPROVAL" | "UNRESOLVED";
  readonly actionType: RelayGitReadAction;
  readonly operationId: string;
  readonly reviewId: string | null;
  readonly reason: string;
} | {
  readonly state: "SUCCEEDED" | "FAILED";
  readonly actionType: RelayGitReadAction;
  readonly operationId: string;
  readonly invocationId: string | null;
  readonly result: RelayGitStatusResult | RelayGitDiffResult |
    { readonly kind: "FAILURE"; readonly reason: string; readonly detail: string | null };
};

export interface RelayManagedGitReadResponse {
  readonly commandId: string;
  readonly committedAt: string;
  readonly outcome: RelayManagedGitReadOutcome;
}

/** 人工受管目录浏览与文件读取（HTTP §10.112，迁移 0134）。 */
export type RelayFileBrowseAction = "LIST_DIRECTORY" | "READ_FILE";

export interface RelayManagedFileReadInput {
  readonly projectId: string;
  readonly resourceId: string;
  readonly connectionId: string;
  readonly commandId: string;
  readonly actionType: RelayFileBrowseAction;
  /** 受管根内相对路径：LIST_DIRECTORY 缺省＝根自身；READ_FILE 必填。 */
  readonly relativePath?: string;
  readonly limit?: number;
}

export interface RelayDirectoryEntry {
  readonly path: string;
  readonly kind: "directory" | "file" | "other";
  readonly size: number | null;
}

export interface RelayDirectoryListingResult {
  readonly kind: "LISTING";
  readonly entries: readonly RelayDirectoryEntry[];
  readonly count: number;
  readonly limit: number;
  readonly truncated: boolean;
  readonly skipped: number;
}

export interface RelayFileContentResult {
  readonly kind: "CONTENT";
  readonly content: string;
  readonly size: number;
  readonly sha256: string;
  readonly truncated: boolean;
}

export type RelayManagedFileReadOutcome = {
  readonly state: "WAITING_APPROVAL" | "UNRESOLVED";
  readonly actionType: RelayFileBrowseAction;
  readonly operationId: string;
  readonly reviewId: string | null;
  readonly reason: string;
} | {
  readonly state: "SUCCEEDED" | "FAILED";
  readonly actionType: RelayFileBrowseAction;
  readonly operationId: string;
  readonly invocationId: string | null;
  readonly result: RelayDirectoryListingResult | RelayFileContentResult |
    { readonly kind: "FAILURE"; readonly reason: string; readonly detail: string | null };
};

export interface RelayManagedFileReadResponse {
  readonly commandId: string;
  readonly committedAt: string;
  readonly outcome: RelayManagedFileReadOutcome;
}

export type RelayMockGatewayConnection = RelayGatewayConnection;

export interface RelayWebImportSubmission {
  readonly importJobId: string;
  readonly projectId: string;
  readonly connectionId: string;
  readonly status: "QUEUED";
}

export interface RelayWebImportJob {
  readonly id: string;
  readonly projectId: string;
  readonly sourceUri: string;
  readonly status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  readonly revision: DecimalRevision;
  readonly error: string | null;
  readonly knowledgeVersionId: string | null;
  readonly requestCommandId: string;
  readonly createdAt: string;
}

export interface RelayWebImportOperation {
  readonly id: string;
  readonly importJobId: string;
  readonly status: string;
  readonly actionType: string;
  readonly normalizedTarget: string;
  readonly invocationStatuses: readonly string[];
}

export interface RelayMockManagedResource {
  readonly id: string;
  readonly canonicalRoot: string;
  readonly status: string;
}
