import type { DecimalRevision } from "../../types";
import type { RelayModelVerifyErrorCategory } from "./information";

export type RelayReviewKind = "CRITERION" | "RETRY_BUDGET" | "CHECKER_RETRY" | "ACTION_APPROVAL" | "STATE_PROPOSAL";

export type RelayReviewDecision = "ACCEPT" | "REQUEST_CHANGES" | "SET_RETRY_BUDGET" | "RETRY_CHECKS" | "APPROVE" | "DENY";

export interface RelayReview {
  readonly id: string;
  readonly kind: RelayReviewKind;
  readonly status: string;
  readonly revision: DecimalRevision;
  readonly projectId: string | null;
  readonly taskId: string | null;
  readonly runId: string | null;
  /** ACTION_APPROVAL 绑定的动作身份；工具轨迹按它把审批挂到对应那次调用，不另造引用。 */
  readonly operationId: string | null;
  readonly reason: string;
  readonly targetHash: string;
  readonly target: Readonly<Record<string, unknown>>;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly effect: Readonly<Record<string, unknown>>;
  readonly allowedDecisions: readonly RelayReviewDecision[];
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
}

export type RelayControlType = "PAUSE" | "CANCEL" | "HANDOFF" | "CANCEL_TASK";

export interface RelayControlRequest {
  readonly id: string;
  readonly runId: string;
  readonly taskId: string;
  readonly type: RelayControlType;
  readonly status: string;
  readonly revision: DecimalRevision;
  readonly requestedAt: string;
  readonly decidedAt: string | null;
  readonly resultRef: Readonly<Record<string, unknown>> | null;
}

export interface RelayRun {
  readonly id: string;
  readonly taskId: string;
  readonly status: string;
  readonly revision: DecimalRevision;
  readonly waitReason: string | null;
  readonly currentStepId: string | null;
  readonly steps: readonly {
    readonly id: string;
    readonly index: number;
    readonly kind: string;
    readonly status: string;
    readonly startedAt: string | null;
    readonly finishedAt: string | null;
    /** 服务端 result_ref 里的失败原因（如 MODEL_BUDGET_EXHAUSTED）；没有则 null */
    readonly reason: string | null;
  }[];
  readonly recentAttempts: readonly {
    readonly id: string;
    readonly stepKind: string;
    readonly number: DecimalRevision;
    readonly status: string;
  }[];
  readonly blockingReviewIds: readonly string[];
  readonly pendingControlRequest: { readonly id: string; readonly type: RelayControlType; readonly status: string; readonly requestedAt: string } | null;
  readonly unresolvedOperationIds: readonly string[];
}

export interface RelayRunDraftPreview {
  readonly runId: string;
  readonly runStatus: string;
  readonly stepAttemptId: string | null;
  readonly attemptClaimEpoch: DecimalRevision | null;
  readonly modelCallId: string | null;
  readonly previewRevision: DecimalRevision;
  readonly previewText: string | null;
  readonly previewTruncated: boolean;
  readonly previewAvailable: boolean;
}

export interface RelayRunTrace {
  readonly runId: string;
  readonly taskId: string;
  readonly projectId: string | null;
  readonly status: string;
  readonly steps: readonly { readonly id: string; readonly index: number; readonly kind: string;
    readonly status: string; readonly revision: DecimalRevision; readonly resultAvailable: boolean;
    readonly startedAt: string | null; readonly finishedAt: string | null }[];
  readonly attempts: readonly { readonly id: string; readonly stepId: string; readonly number: DecimalRevision;
    readonly status: string; readonly claimEpoch: DecimalRevision; readonly resultAvailable: boolean;
    readonly startedAt: string | null; readonly finishedAt: string | null }[];
  readonly modelCalls: readonly { readonly id: string; readonly stepAttemptId: string | null;
    readonly manifestId: string | null; readonly status: string; readonly provider: string; readonly model: string;
    readonly kind: string | null; readonly criterionId: string | null; readonly checkAttempt: number | null;
    readonly providerErrorKind: RelayModelVerifyErrorCategory | null; readonly providerRequestId: string | null;
    readonly inputSha256: string | null; readonly readOperationId: string | null;
    readonly readInvocationId: string | null; readonly inputTokens: number | null; readonly outputTokens: number | null;
    readonly startedAt: string; readonly settledAt: string | null;
    readonly firstTextDeltaAt: string | null; readonly firstPreviewPersistedAt: string | null }[];
  readonly manifests: readonly { readonly id: string; readonly stepId: string | null;
    readonly builderVersion: string; readonly sha256: string; readonly createdAt: string;
    readonly sources: readonly { readonly kind: string; readonly sourceRef: string | null;
      readonly version: string | null; readonly sha256: string | null; readonly sourceSha256: string | null;
      readonly role: string; readonly trust: string; readonly availability: "AVAILABLE" | "UNAVAILABLE" }[] }[];
  readonly verifications: readonly { readonly id: string; readonly status: string; readonly verdict: string | null;
    readonly acceptanceRevision: DecimalRevision; readonly checkPlanHash: string; readonly parentSessionId: string | null;
    readonly targets: readonly { readonly artifactVersionId: string; readonly contentSha256: string }[];
    readonly checks: readonly { readonly id: string; readonly criterionId: string; readonly result: string;
      readonly severity: string; readonly required: boolean; readonly createdAt: string }[];
    readonly createdAt: string; readonly finalizedAt: string | null }[];
  readonly reviews: readonly { readonly id: string; readonly kind: string; readonly status: string;
    readonly operationId: string | null; readonly verificationSessionId: string | null;
    readonly targetHash: string; readonly decision: { readonly id: string; readonly value: string;
      readonly decidedAt: string } | null; readonly createdAt: string; readonly decidedAt: string | null }[];
  readonly operations: readonly { readonly id: string; readonly stepId: string | null;
    readonly capability: string; readonly actionType: string; readonly status: string;
    readonly paramsSha256: string; readonly resultAvailable: boolean;
    readonly invocations: readonly { readonly id: string; readonly number: DecimalRevision;
      readonly status: string; readonly resultAvailable: boolean; readonly createdAt: string;
      readonly resolvedAt: string | null }[]; readonly createdAt: string; readonly updatedAt: string }[];
  readonly effects: readonly { readonly id: string; readonly stepId: string; readonly status: string;
    readonly paramsSha256: string; readonly resultAvailable: boolean; readonly createdAt: string;
    readonly resolvedAt: string | null }[];
}

export interface RelayContextManifestSummary {
  readonly id: string;
  readonly runId: string;
  readonly stepId: string | null;
  readonly createdAt: string;
  readonly builderVersion: string;
  readonly templateVersion: string;
  readonly manifestHash: string;
}

export interface RelayContextBuild {
  readonly status: "NOT_STARTED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  readonly reasonCode: string | null;
  readonly message: string | null;
}

export interface RelayContextManifestList {
  readonly items: readonly RelayContextManifestSummary[];
  readonly build: RelayContextBuild;
}

export interface RelayContextManifestDetail extends RelayContextManifestSummary {
  readonly budget: {
    readonly limitTokens: number;
    readonly reservedTokens: number;
    readonly requiredTokens: number | null;
    readonly selectedTokens: number | null;
    readonly estimation: string;
  } | null;
  readonly dependencies: {
    readonly contractHash: string | null;
    readonly workflowVersion: string | null;
    readonly executionConfigVersion: string | null;
    readonly profile: { readonly id: string; readonly version: string; readonly digest: string } | null;
    readonly skill: { readonly id: string; readonly version: string; readonly digest: string } | null;
  };
  readonly sources: readonly {
    readonly kind: string;
    readonly sourceRef: string;
    readonly version: string;
    readonly sha256: string;
    readonly sourceSha256: string;
    readonly range: { readonly start: number; readonly end: number; readonly unit: "UTF8_BYTE" };
    readonly content: string;
    readonly role: "MANDATORY" | "RELEVANT" | "STEP_SPECIFIC";
    readonly trust: "CANONICAL" | "UNTRUSTED_DATA";
    readonly selectionReason: "TITLE_MATCH" | "RECENT_SCOPE_FALLBACK" | null;
  }[];
  readonly exclusions: readonly { readonly sourceRef: string; readonly reason: "BUDGET_TRIMMED" | "SOURCE_UNAVAILABLE" }[];
}

export interface RelayControlSubmission {
  readonly controlRequestId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly type: RelayControlType;
  readonly status: "PENDING";
  readonly runRevision: DecimalRevision;
}

export interface RelayResumeSubmission {
  readonly runId: string;
  readonly status: string;
  readonly runRevision: DecimalRevision;
}

export interface RelayDelegateSubmission {
  readonly runId: string;
  readonly taskId: string;
  readonly taskRevision: DecimalRevision;
  readonly runRevision: DecimalRevision;
  readonly status: "CREATED";
  readonly retryOfRunId: string | null;
}

export interface RelayRunGatewayOperation {
  readonly id: string;
  readonly status: string;
  readonly actionType: string;
  readonly normalizedTarget: string;
  readonly invocationStatuses: readonly string[];
  /** 服务端已保存的原 Invocation 结果；stdout/stderr 只在这里出现，不由客户端推断。 */
  readonly invocations: readonly RelayGatewayInvocationResult[];
}

export interface RelayGatewayInvocationResult {
  /** 服务端未回传该字段时为 null；界面据此说明身份不可核对，而不是补一个假 ID。 */
  readonly id: string | null;
  readonly status: string;
  readonly createdAt: string | null;
  readonly resolvedAt: string | null;
  /** 仅当服务端结果里确有该字段时存在；缺失表示这次调用没有命令输出。 */
  readonly commandOutput: RelayCommandOutput | null;
}

export interface RelayCommandOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly outcome: string | null;
  readonly truncated: boolean;
  readonly durationMs: number | null;
  /** 原 Invocation 身份，用于把输出绑定到确切一次调用，不换身份重试。 */
  readonly invocationId: string | null;
  readonly operationId: string | null;
}
