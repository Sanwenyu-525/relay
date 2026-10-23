import type { DecimalRevision } from "../../types";

export interface RelayArtifactVersionSummary {
  readonly artifactVersionId: string;
  readonly versionNumber: DecimalRevision;
  readonly mediaType: string;
  readonly sha256: string;
  readonly size: DecimalRevision;
  readonly sourceKind: string;
  readonly createdAt: string;
}

export type RelayLineageRelation = "DERIVED_FROM" | "REVISED_FROM" | "GENERATED_BY" | "VERIFIED_BY" | "ACCEPTED_BY";

export type RelayLineageParentKind = "ARTIFACT_VERSION" | "KNOWLEDGE_VERSION" | "RUN_STEP" | "VERIFICATION_SESSION" | "COMPLETION_RECORD";

export interface RelayArtifactLineage {
  readonly artifactVersionId: string;
  readonly artifactId: string;
  readonly versionNumber: DecimalRevision;
  readonly sha256: string;
  readonly sourceKind: string;
  readonly contentAvailability: "AVAILABLE" | "UNAVAILABLE";
  readonly directParents: readonly { readonly id: string; readonly relation: RelayLineageRelation;
    readonly parentKind: RelayLineageParentKind; readonly parentId: string | null;
    readonly availability: "AVAILABLE" | "UNAVAILABLE"; readonly createdAt: string }[];
}

export interface RelayArtifactDirectUses {
  readonly sourceArtifactVersionId: string;
  readonly sourceContentAvailability: "AVAILABLE" | "UNAVAILABLE";
  readonly scope: "RECORDED_DIRECT_ONLY";
  readonly complete: false;
  readonly hasMore: boolean;
  readonly directUses: readonly {
    readonly relation: "DERIVED_FROM" | "REVISED_FROM";
    readonly childArtifactVersionId: string | null;
    readonly childArtifactId: string | null;
    readonly childVersionNumber: DecimalRevision | null;
    readonly availability: "AVAILABLE" | "UNAVAILABLE";
    readonly createdAt: string;
  }[];
}

export interface RelayArtifactTextLock {
  readonly id: string;
  readonly artifactId: string;
  readonly baseVersionId: string;
  readonly blockKind: "PARAGRAPH" | "SECTION";
  readonly blockIndex: number | null;
  readonly text: string;
  readonly status: "MAPPED" | "UNMAPPED";
}

export interface RelayArtifactImpactCheck {
  readonly id: string; readonly artifactId: string;
  readonly sourceBeforeVersionId: string; readonly sourceAfterVersionId: string;
  readonly status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  readonly errorCode: string | null;
  readonly directTargets: readonly { readonly targetVersionId: string;
    readonly targetArtifactId: string; readonly relation: string;
    readonly versionNumber: DecimalRevision;
    readonly availability: "AVAILABLE" | "UNAVAILABLE";
    readonly analysed: boolean }[];
  readonly possiblyRelated: readonly { readonly targetVersionId: string; readonly reason: string }[];
  readonly hasMore: boolean; readonly inputTruncated: boolean;
  readonly unanalysedScope: readonly string[]; readonly stale: boolean;
}

export interface RelayArtifactImpactCandidate {
  readonly id: string; readonly impactCheckId: string;
  readonly targetArtifactId: string; readonly targetVersionId: string;
  readonly status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  readonly errorCode: string | null; readonly markdown: string | null;
  readonly stale: boolean; readonly appliedVersionId: string | null;
}

/** N02：组只旁读既有候选回执，逐项应用仍走 applyArtifactImpactCandidate。 */
export interface RelayImpactCandidateGroupItem {
  readonly ordinal: number;
  readonly targetArtifactId: string; readonly targetVersionId: string;
  readonly relation: string; readonly speculative: boolean;
  readonly availability: string; readonly analysed: boolean;
  readonly targetArtifactRevision: DecimalRevision;
  readonly targetIsCurrentVersion: boolean;
  readonly candidateId: string | null; readonly candidateStatus: string | null;
  readonly candidateErrorCode: string | null; readonly candidateStale: boolean;
  readonly appliedVersionId: string | null;
}

export interface RelayImpactCandidateGroup {
  readonly id: string; readonly impactCheckId: string;
  readonly sourceArtifactId: string;
  readonly sourceBeforeVersionId: string; readonly sourceAfterVersionId: string;
  readonly sourceArtifactRevision: DecimalRevision; readonly createdAt: string;
  readonly stale: boolean;
  readonly items: readonly RelayImpactCandidateGroupItem[];
  readonly summary: { readonly total: number; readonly applied: number;
    readonly withCandidate: number; readonly withoutCandidate: number;
    readonly staleCandidates: number; readonly unavailable: number };
  readonly unanalysedScope: readonly string[];
  readonly combinationCheckIds: readonly string[];
  readonly dependencies?: readonly { readonly targetVersionId: string; readonly dependsOnTargetVersionId: string }[];
}

export interface RelayImpactGroupSelection {
  readonly id: string; readonly groupId: string; readonly createdAt: string;
  readonly appliedCount: number; readonly overallResult: 'NONE';
  readonly items: readonly { readonly candidateId: string; readonly targetArtifactId: string;
    readonly targetVersionId: string; readonly expectedTargetRevision: string;
    readonly dependencyCandidateIds: readonly string[]; readonly candidateStatus: string;
    readonly appliedVersionId: string | null; readonly appliedIsCurrent: boolean;
    readonly canApply: boolean; readonly reason: string | null }[];
}

/** 组合检查是覆盖快照：没有整体结论，单项事实不相加。 */
export interface RelayCombinationCheck {
  readonly id: string; readonly groupId: string; readonly taskId: string;
  readonly acceptanceRevision: DecimalRevision; readonly createdAt: string;
  readonly overallResult: "NONE"; readonly overallNote: string;
  readonly stale: boolean; readonly gaps: readonly string[];
  readonly items: readonly { readonly ordinal: number; readonly artifactId: string;
    readonly artifactVersionId: string; readonly isCurrentVersion: boolean;
    readonly readable: boolean; readonly verificationSessionId: string | null;
    readonly verificationStatus: string | null }[];
}

export interface RelayArtifact {
  readonly id: string;
  readonly taskId: string;
  readonly title: string;
  readonly revision: DecimalRevision;
  readonly latestVersionId: string | null;
  readonly versionCount: number;
  readonly versions: readonly RelayArtifactVersionSummary[];
}

export interface RelayTaskArtifacts {
  readonly items: readonly RelayArtifact[];
  /** Versions in the Task's current CompletionRecord; empty after reopen. */
  readonly currentAcceptedVersionIds: readonly string[];
}

/** 两个保存入口的 201 结果形状相同。 */
export interface RelayArtifactVersionResult {
  readonly taskId: string;
  readonly artifactId: string;
  readonly artifactRevision: DecimalRevision;
  readonly versionId: string;
  readonly versionNumber: DecimalRevision;
  readonly mediaType: string;
  readonly sha256: string;
  readonly size: DecimalRevision;
  readonly taskRevision: DecimalRevision;
}

export interface RelayFileWriteChangeSet {
  readonly id: string;
  readonly invocationId: string;
  readonly status: string;
  readonly files: readonly { readonly relativePath: string; readonly action: string;
    readonly status: string; readonly error: string | null }[];
}

export interface RelayFileWriteFrozenDiff {
  readonly operationId: string;
  readonly basis: "FROZEN_INTENT";
  readonly files: readonly {
    readonly relativePath: string;
    readonly action: "CREATE" | "MODIFY" | "DELETE";
    readonly baselineSha256: string | null;
    readonly targetSha256: string | null;
    readonly availability: "AVAILABLE" | "UNAVAILABLE";
    readonly unavailableReason: string | null;
    readonly beforeText: string | null;
    readonly afterText: string | null;
  }[];
}

export interface RelayFileWriteResidualCandidate {
  readonly path: string; readonly id: string | null; readonly sha256: string | null;
  readonly status: string; readonly error: string | null;
}

export interface RelayFileWriteDispositionPreview {
  readonly operationId: string;
  readonly invocationId: string | null;
  readonly changeSetId: string | null;
  readonly runId: string;
  readonly runRevision: DecimalRevision;
  readonly taskRevision: DecimalRevision;
  readonly operationStatus: string;
  readonly stopProofRecorded: boolean;
  readonly canDispose: boolean;
  readonly blockingReasons: readonly string[];
  readonly observationSha256: string | null;
  readonly observationMode: "PARTIAL_LEDGER" | "NO_RECEIPT" | null;
  readonly files: readonly { readonly relativePath: string; readonly ledgerStatus: string;
    readonly ledgerActualSha256: string | null; readonly currentSha256: string | null;
    readonly readable: boolean; readonly currentTargetId: string | null;
    readonly residualCandidates: readonly RelayFileWriteResidualCandidate[] }[];
  readonly disposition: { readonly id: string; readonly decision: string;
    readonly createdAt: string; readonly observationSha256: string;
    readonly observationMode: "PARTIAL_LEDGER" | "NO_RECEIPT" | null;
    readonly observationFiles: readonly { readonly path: string; readonly currentSha256: string | null;
      readonly ledgerStatus: string; readonly ledgerActualSha256: string | null;
      readonly currentTargetId: string | null;
      readonly residualCandidates: readonly RelayFileWriteResidualCandidate[] }[] } | null;
}

export interface RelayClosePartialFileWriteInput {
  readonly operationId: string;
  readonly invocationId: string;
  readonly runId: string;
  readonly commandId: string;
  readonly expectedRunRevision: DecimalRevision;
  readonly expectedTaskRevision: DecimalRevision;
  readonly expectedObservationSha256: string;
}

/** DEV-0054：未决只读动作手动核对的回执。status 是服务端重读结论，NOT_EXECUTED
 * 表示调用未开始（PREPARED），FAILED 是明确的读取失败，都不是「成功」。 */
export interface RelayGatewayReconcileResult {
  readonly operationId: string;
  readonly status: "SUCCEEDED" | "NOT_EXECUTED" | "FAILED";
  readonly reconciliation: string;
  readonly capabilityKey: string;
}
