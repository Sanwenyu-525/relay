import type { DecimalRevision, ExecutorKind, InteractionMode, TaskStatus } from "../types";
import { isRunEventCursor, readRunEventHints } from "./runEvents";
import { blueprintProposalFrom, goalFrom, projectGoalListFrom,
  type RelayBlueprintDraft, type RelayBlueprintProposal, type RelayGoal,
  type RelayProjectGoal } from "./blueprintDtos";

export interface RelayApiConnection {
  readonly baseUrl: string;
  readonly workspaceId: string;
  /** 仅在当前浏览器进程内存中保存，调用方不得记录或展示。 */
  readonly bearerToken: string;
}

export interface RelayFieldError {
  readonly field: string;
  readonly message: string;
}

export interface RelayProblem {
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  readonly retryable: boolean;
  readonly retryAction: string | null;
  /** 422 的字段定位；界面据此把错误放回对应输入项。 */
  readonly fieldErrors: readonly RelayFieldError[];
  /** 409 REVISION_CONFLICT 的版本差异；界面保留差异而不是直接覆盖。 */
  readonly expectedRevision: string | null;
  readonly actualRevision: string | null;
  readonly blockingReasons?: readonly string[];
}

export class RelayApiError extends Error {
  constructor(readonly problem: RelayProblem) {
    super(problem.detail);
    this.name = "RelayApiError";
  }
}

/** 命令响应未能可靠核对时，提交是否已入库无法由浏览器判断。 */
export class RelayTransportError extends Error {
  constructor(message = "网络请求未获得服务端响应。") {
    super(message);
    this.name = "RelayTransportError";
  }
}

export class RelayRunEventHttpError extends Error {
  constructor(readonly status: number) {
    super(`执行事件订阅返回 HTTP ${status}。`);
    this.name = "RelayRunEventHttpError";
  }
}

export interface RelayProject {
  readonly id: string;
  readonly title: string;
  readonly projectType: string;
  readonly revision: DecimalRevision;
  readonly stateRevision: DecimalRevision;
  readonly archivedAt: string | null;
}

export interface RelayProjectListItem extends RelayProject {
  readonly archiveStatus: "ACTIVE" | "ARCHIVED";
  readonly phaseKey: string;
  readonly nextActionTaskId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RelayProjectPage {
  readonly items: readonly RelayProjectListItem[];
  readonly nextCursor: string | null;
}
export interface RelayProjectArchiveResult {
  readonly projectId: string;
  readonly revision: DecimalRevision;
  readonly archivedAt: string;
  readonly archiveStatus: "ARCHIVED";
}

export type RelayViewKind = "general" | "thesis" | "development";
export interface RelayViewConfiguration {
  readonly projectId: string;
  readonly revision: DecimalRevision;
  readonly kind: RelayViewKind;
  readonly templateVersion: string;
  readonly templateSha256: string;
  readonly pages: readonly { readonly pageId: string; readonly visible: boolean; readonly position: number }[];
  readonly updatedAt: string;
}

export type RelayContinuationRefKind = "TASK" | "ARTIFACT_VERSION";
export type RelayContinuationRefChange =
  | "UNCHANGED" | "REVISED" | "CLOSED" | "MISSING" | "CURRENT" | "SUPERSEDED";

export interface RelayContinuationRef {
  readonly refKind: RelayContinuationRefKind;
  readonly refId: string;
  readonly capturedRevision: DecimalRevision;
}

export interface RelayContinuationPointSummary {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly note: string | null;
  readonly capturedAt: string;
  readonly capturedState: { readonly phaseKey: string; readonly revision: DecimalRevision;
    readonly nextActionTaskId: string | null };
  readonly refCount: number;
}

export interface RelayContinuationComparison {
  readonly continuationPoint: RelayContinuationPointSummary;
  readonly currentState: { readonly phaseKey: string; readonly revision: DecimalRevision;
    readonly nextActionTaskId: string | null };
  readonly facts: {
    readonly stateRevisionChanged: boolean;
    readonly phaseChanged: boolean;
    readonly nextActionChanged: boolean;
    readonly taskAdded: readonly { readonly taskId: string; readonly title: string;
      readonly status: TaskStatus }[];
    readonly artifactVersionAdded: readonly { readonly artifactVersionId: string;
      readonly artifactId: string; readonly versionNumber: DecimalRevision }[];
  };
  readonly refChanges: readonly (RelayContinuationRef & { readonly change: RelayContinuationRefChange;
    readonly currentRevision: DecimalRevision | null; readonly note: string | null })[];
  /** 首片不生成解读；UI 不能用摘要顶替事实差异。 */
  readonly interpretation: null;
}

export interface RelayTaskDependency {
  readonly taskId: string;
  readonly dependencyKind: string;
  readonly status: TaskStatus;
  readonly title: string;
}

export interface RelayTaskSummary {
  readonly id: string;
  readonly projectId: string | null;
  readonly title: string;
  readonly status: TaskStatus;
  readonly mode: InteractionMode;
  readonly revision: DecimalRevision;
  readonly executor: ExecutorKind;
  readonly executorRunId: string | null;
  /** 当前完成周期的指针；重开后清空，历史凭据仍保留在服务端。 */
  readonly currentCompletionId: string | null;
  readonly waitingReason: string | null;
  readonly blockingTaskIds: readonly string[];
  readonly unresolvedBlockerIds: readonly string[];
  /** 服务端投影出的 UI 提示，不是客户端授权判断。 */
  readonly allowedActions: readonly string[];
  /** 服务端维护的最近变更时间；null 表示本次响应没有该字段，排序时不会伪造时间。 */
  readonly updatedAt: string | null;
}

export interface RelayTaskPage {
  readonly items: readonly RelayTaskSummary[];
  readonly nextCursor: string | null;
}

export type RelayTodayPriority = "LOW" | "NORMAL" | "HIGH";
export interface RelayTodayItem {
  readonly taskId: string;
  readonly taskRevision: DecimalRevision;
  readonly projectId: string | null;
  readonly title: string;
  readonly status: TaskStatus;
  readonly priority: RelayTodayPriority | null;
  readonly dueLocalDate: string | null;
  readonly timezone: string | null;
  readonly pin: boolean;
  readonly laterLocalDate: string | null;
  readonly laterTimezone: string | null;
  readonly reasonCodes: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly allowedActions: readonly string[];
}

export interface RelayToday {
  readonly date: string;
  readonly timezone: string;
  readonly selectionRevision: DecimalRevision;
  readonly focus: {
    readonly date: string;
    readonly timezone: string;
    readonly targetKind: "GOAL" | "PROJECT" | "TASK";
    readonly targetId: string;
    readonly selectionRevision: DecimalRevision;
    readonly activeInQuery: boolean;
  } | null;
  readonly focusHasEligibleCandidate: boolean;
  readonly eligibleItems: readonly RelayTodayItem[];
  readonly waitingItems: readonly RelayTodayItem[];
  /** 服务端定义为 waitingItems 的子集。 */
  readonly blockedPinnedItems: readonly RelayTodayItem[];
}

export type RelayActivityRefKind = "PROJECT" | "TASK" | "RUN" | "GOAL" | "ARTIFACT_VERSION" |
  "REVIEW" | "COMPLETION" | "VERIFICATION_SESSION";
export interface RelayActivityItem {
  readonly id: string;
  readonly createdAt: string;
  readonly actorKind: "HUMAN" | "AI" | "SYSTEM";
  readonly commandId: string | null;
  readonly eventType: string;
  readonly summary: string;
  readonly projectId: string | null;
  readonly taskId: string | null;
  readonly runId: string | null;
  readonly entityRefs: readonly { readonly kind: RelayActivityRefKind; readonly id: string }[];
}
export interface RelayActivityPage {
  readonly items: readonly RelayActivityItem[];
  readonly nextCursor: string | null;
}
export interface RelayActivityFilter {
  readonly projectId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface RelayTaskDetail extends RelayTaskSummary {
  readonly acceptance: RelayTaskAcceptance;
  readonly dependencies: readonly RelayTaskDependency[];
}

/** 当前 Task/规则的准入预览，不是 Run 冻结计划或已执行结果。 */
export interface RelayTaskCheckPlanPreview {
  readonly taskId: string;
  readonly status: "AVAILABLE" | "UNAVAILABLE";
  readonly admissionAvailable: boolean;
  readonly reasonCodes: readonly string[];
  readonly sources: { readonly taskRevision: DecimalRevision;
    readonly acceptanceRevision: DecimalRevision; readonly ruleRevision: DecimalRevision | null;
    readonly workflowKey: string; readonly workflowVersion: string;
    readonly ruleRefs: readonly { readonly ruleId: string; readonly version: DecimalRevision }[] };
  readonly checkPlan: { readonly policyVersion: string; readonly workflowKey: string;
    readonly workflowVersion: string; readonly entries: readonly { readonly criterionId: string;
      readonly statement: string; readonly required: boolean; readonly method: string;
      readonly severity: string; readonly checkerId: string; readonly checkerVersion: string }[] } | null;
  readonly checkPlanSha256: string | null;
  readonly frozenRunPlan: false;
  readonly executed: false;
}

/** GET /tasks/{id} 的验收投影：完成命令要按这份 criteria 的 id 提交接受集合。 */
export interface RelayTaskAcceptance {
  readonly acceptanceRevision: DecimalRevision;
  readonly objective: string;
  /** 当前验收配置的 expected_outputs；旧版响应缺字段时为 null。 */
  readonly expectedOutputs: Readonly<Record<string, unknown>> | null;
  readonly source: string;
  readonly criteria: readonly RelayAcceptanceCriterion[];
}

export interface RelayAcceptanceCriterion {
  readonly criterionId: string;
  readonly statement: string;
  readonly required: boolean;
  readonly method: string;
  /** null 表示响应未提供目标说明，不等于没有受验对象。 */
  readonly targetSpec: Readonly<Record<string, unknown>> | null;
}

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

export interface RelayInterventionItem {
  readonly itemKey: string; readonly changeKey: string;
  readonly kind: "REVIEW" | "LOCK_CONFLICT" | "RUN_FAILED" | "UNKNOWN";
  readonly title: string; readonly reason: string; readonly targetUrl: string;
}

/** 只读模型端口状态：密钥永不出现在此结构中。 */
export interface RelayModelPortStatus {
  readonly provider: "fake" | "openai-compatible" | "invalid";
  readonly configured: boolean;
  readonly model: string | null;
  readonly baseUrl: string | null;
}

/** 验证错误分类：与设置页指引一一对应。 */
export type RelayModelVerifyErrorCategory =
  | "AUTH" | "RATE_LIMIT" | "TIMEOUT" | "STREAM_BROKEN" | "PROTOCOL" | "NETWORK";

/** 一次验证结果：永不包含密钥。 */
export interface RelayModelVerifyResult {
  readonly ok: boolean;
  readonly latencyMs: number | null;
  readonly provider: string;
  readonly model: string;
  readonly configFingerprint: string;
  readonly errorCategory: RelayModelVerifyErrorCategory | null;
  readonly verifiedAt: string;
}

/** 最近一次验证 + 当前配置指纹匹配情况。 */
export interface RelayModelVerificationState {
  readonly currentConfigFingerprint: string | null;
  readonly last: RelayModelVerifyResult | null;
  readonly matchesCurrentConfig: boolean;
  /** API 进程环境的启动校验；不代表 Worker 进程已被探测。 */
  readonly workerStartupValidation: "NOT_CONFIGURED" | "OK" | "FAILED";
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

export interface RelayCompletion {
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly revision: DecimalRevision;
  readonly acceptanceRevision: DecimalRevision;
  readonly completionId: string;
  readonly humanAcceptanceId: string;
  readonly artifactVersionIds: readonly string[];
  readonly stateRevision: DecimalRevision | null;
}

export interface RelayCompletionEvidence {
  readonly completionId: string;
  readonly taskId: string;
  readonly basisKind: "HUMAN" | "AUTO";
  readonly acceptanceRevision: DecimalRevision;
  readonly isCurrent: boolean;
  readonly committedAt: string;
  readonly acceptance: { readonly availability: "AVAILABLE" | "UNAVAILABLE";
    readonly objective: string | null; readonly expectedOutputs: Readonly<Record<string, unknown>> | null;
    readonly source: string | null; readonly createdAt: string | null;
    readonly criteria: readonly { readonly criterionId: string; readonly statement: string;
      readonly required: boolean; readonly method: string;
      readonly targetSpec: Readonly<Record<string, unknown>> }[] };
  readonly humanAcceptance: null | { readonly availability: "AVAILABLE" | "UNAVAILABLE";
    readonly id: string | null; readonly actorKind: string | null; readonly statement: string | null;
    readonly acceptedCriterionIds: readonly string[]; readonly reason: string | null;
    readonly createdAt: string | null };
  readonly verificationSession: null | { readonly availability: "AVAILABLE" | "UNAVAILABLE";
    readonly id: string | null; readonly runId: string | null; readonly status: string | null;
    readonly verdict: string | null; readonly checkPlanHash: string | null;
    readonly applicable: boolean | null };
  readonly artifactVersions: readonly { readonly availability: "AVAILABLE" | "UNAVAILABLE";
    readonly artifactVersionId: string | null; readonly artifactId: string | null;
    readonly versionNumber: DecimalRevision | null; readonly sha256: string | null }[];
}

export interface RelayReopen {
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly revision: DecimalRevision;
  readonly acceptanceRevision: DecimalRevision;
  readonly previousAcceptanceRevision: DecimalRevision;
  readonly previousCompletionId: string | null;
}

/** Project State 的只读投影中与本轮相关的部分（“当前选用”来自服务端，不来自本地记忆）。 */
export interface RelayProjectState {
  readonly projectId: string;
  readonly revision: DecimalRevision;
  readonly phaseKey: string;
  readonly nextActionTaskId: string | null;
  readonly selectedArtifactVersionRefs: readonly RelayStateArtifactRef[];
  readonly completedHighlightRefs: readonly {
    readonly completionId: string;
    readonly taskId: string;
    readonly acceptanceRevision: DecimalRevision;
  }[];
}

export interface RelayStateArtifactRef {
  readonly artifactVersionId: string;
  readonly artifactId: string;
  readonly versionNumber: DecimalRevision;
  readonly sourceRef: string;
}

export interface RelayStateMutation {
  readonly projectId: string;
  readonly action: string;
  readonly revision: DecimalRevision;
}

export interface RelayCommandEnvelope {
  readonly commandId: string;
  readonly committedAt: string;
  readonly result: Readonly<Record<string, unknown>>;
}

export interface RelayCommandReceipt extends RelayCommandEnvelope {
  readonly commandType: string;
}

export type RelayInformationKind = "KNOWLEDGE" | "MEMORY" | "DECISION" | "RULE";
export type RelayKnowledgeSource = "NOTE" | "MANAGED_TEXT" | "ARTIFACT_VERSION" | "WEB_PAGE";
export type RelayRuleStrength = "HARD" | "PREFERENCE";
export type RelayRuleEnforcement = "PRE_ACTION" | "POST_CHECK" | "SEMANTIC" | "HUMAN";

export interface RelayKnowledge {
  readonly id: string;
  readonly projectId: string | null;
  readonly title: string;
  readonly status: string;
  readonly revision: DecimalRevision;
  readonly currentVersion: DecimalRevision;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RelayKnowledgeVersion {
  readonly id: string;
  readonly knowledgeId: string;
  readonly version: DecimalRevision;
  readonly sourceKind: RelayKnowledgeSource;
  readonly mediaType: string;
  readonly contentSha256: string;
  readonly availability: string;
  readonly excerpt: string | null;
  readonly sourceRefs: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface RelayKnowledgeVersionContent extends Omit<RelayKnowledgeVersion, "excerpt"> {
  readonly title: string;
  readonly projectId: string | null;
  readonly currentVersion: DecimalRevision;
  readonly sourceUri: string | null;
  readonly contentStatus: "FULL" | "PARTIAL" | "UNAVAILABLE" | "UNSUPPORTED" | "READ_FAILED";
  readonly content: string | null;
}

export interface RelayMemory {
  readonly id: string;
  readonly projectId: string | null;
  readonly title: string;
  readonly status: string;
  readonly revision: DecimalRevision;
  readonly currentVersion: DecimalRevision;
  readonly text: string;
  readonly confirmedBy: string;
  readonly confirmedAt: string;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RelayMemoryRevision {
  readonly id: string;
  readonly memoryId: string;
  readonly version: DecimalRevision;
  readonly title: string;
  readonly text: string;
  readonly confirmedBy: string;
  readonly confirmedAt: string;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

export interface RelayDecision {
  readonly id: string;
  readonly projectId: string | null;
  readonly title: string;
  readonly status: string;
  readonly revision: DecimalRevision;
  readonly currentVersion: DecimalRevision;
  readonly choice: string;
  readonly rationale: string;
  readonly alternatives: readonly string[];
  readonly costs: readonly string[];
  readonly supersededById: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RelayRule {
  readonly id: string;
  readonly scope: "WORKSPACE" | "PROJECT" | "TASK";
  readonly scopeId: string;
  readonly projectId: string | null;
  readonly taskId: string | null;
  readonly status: string;
  readonly revision: DecimalRevision;
  readonly currentVersion: DecimalRevision;
  readonly ruleKey: string;
  readonly statement: string;
  readonly strength: RelayRuleStrength;
  readonly applicability: string;
  readonly enforcement: RelayRuleEnforcement;
  readonly method: string | null;
  readonly targetSpec: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RelayRuleVersion {
  readonly ruleId: string;
  readonly version: DecimalRevision;
  readonly ruleKey: string;
  readonly statement: string;
  readonly strength: RelayRuleStrength;
  readonly applicability: string;
  readonly enforcement: RelayRuleEnforcement;
  readonly method: string | null;
  readonly targetSpec: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface RelaySearchItem {
  readonly type: RelayInformationKind;
  readonly id: string;
  readonly version: DecimalRevision;
  readonly title: string;
  readonly snippet: string;
  readonly matchedFields: readonly string[];
  readonly sourceRef: string;
  readonly status: string;
  readonly projectId: string | null;
}

export interface RelaySearchPage {
  readonly items: readonly RelaySearchItem[];
  readonly nextCursor: string | null;
}

export interface RelayAssistSourceRef {
  readonly kind: "KNOWLEDGE" | "MEMORY" | "DECISION";
  readonly rootId: string;
  readonly version: DecimalRevision;
}

export interface RelayAssistSession {
  readonly id: string;
  readonly projectId: string | null;
  readonly taskId: string | null;
  readonly title: string;
  readonly status: string;
  readonly revision: DecimalRevision;
  readonly updatedAt: string;
}

export interface RelaySkillDefinition {
  readonly id: string;
  readonly version: string;
  readonly sha256: string;
  readonly title: string;
  readonly target: "PROJECT" | "TASK";
  readonly outputKind: "TASK_DEFINITION_SUGGESTION" | "PROJECT_RESUME" | "VERIFICATION_PLAN_SUGGESTION" |
    "PROJECT_BLUEPRINT_SUGGESTION";
  readonly availability: "CALLABLE_SUGGESTION_ONLY" | "CALLABLE_READ_ONLY" | "HISTORICAL_ONLY";
  readonly callSupported: boolean;
  readonly requiredCapabilities: readonly string[];
  readonly missingCapabilities: readonly string[];
  readonly acceptSupported: boolean;
  readonly dependencies: readonly { readonly kind: string; readonly id: string;
    readonly version: string; readonly sha256: string }[];
}

export interface RelayPackDefinition {
  readonly id: string;
  readonly version: string;
  readonly sha256: string;
  readonly title: string;
  readonly hostContract: string;
  readonly availability: string;
  readonly members: readonly { readonly kind: "SKILL"; readonly id: string;
    readonly version: string; readonly sha256: string; readonly target: "PROJECT" | "TASK";
    readonly availability: string; readonly requiredCapabilities: readonly string[];
    readonly missingCapabilities: readonly string[]; readonly acceptSupported: boolean }[];
}

export type RelaySkillInput = { readonly desired_result?: string } |
  { readonly focus?: string } | { readonly risk_focus?: string } |
  { readonly desired_outcome?: string; readonly goal_id?: string | null;
    readonly pack_ref?: { readonly id: string; readonly version: string } | null };

export interface RelayAssistSkillOutput {
  readonly kind: RelaySkillDefinition["outputKind"];
  readonly status: "SUGGESTED" | "READ_ONLY";
  readonly targetKind: "PROJECT" | "TASK";
  readonly targetId: string;
  readonly asOf: string;
  readonly baseline: Readonly<Record<string, unknown>>;
  readonly basisSha256: string;
  readonly payloadSha256: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface RelayAssistMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly seq: DecimalRevision;
  readonly role: "USER" | "ASSISTANT";
  readonly status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  /** 服务端既有字段，用于对话流的日期分隔线与消息时间；缺失只影响展示，不影响消息内容。 */
  readonly createdAt: string | null;
  readonly intent: string;
  readonly content: string | null;
  readonly errorCode: string | null;
  readonly providerErrorKind: RelayModelVerifyErrorCategory | null;
  readonly sources: readonly { readonly sourceRef: string | null; readonly kind: string | null;
    readonly rootId: string | null; readonly version: string | null;
    readonly status: string; readonly reason: string | null }[];
  readonly skill: ({ readonly id: string; readonly version: string; readonly sha256: string | null;
    readonly definitionAvailability: "AVAILABLE" | "HISTORICAL_ONLY" | "UNAVAILABLE";
    readonly outputAvailability: "PENDING" | "HISTORICAL_SNAPSHOT" | "NO_OUTPUT" | "UNAVAILABLE";
    readonly target: "PROJECT" | "TASK" | null; readonly availability: string | null;
    readonly missingCapabilities: readonly string[] }) | null;
  readonly skillInput: Readonly<Record<string, unknown>> | null;
  readonly skillOutput: RelayAssistSkillOutput | null;
  readonly usage: { readonly inputTokens: number | null; readonly outputTokens: number | null };
  readonly cancelRequested: boolean;
}

export interface RelayAssistLivePreview {
  readonly sessionId: string;
  readonly messageId: string;
  readonly status: RelayAssistMessage["status"];
  readonly previewRevision: DecimalRevision;
  readonly previewText: string | null;
  readonly previewTruncated: boolean;
  readonly previewAvailable: boolean;
}

interface RelayAssistProposalBase {
  readonly id: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly targetId: string;
  readonly baseRevision: DecimalRevision;
  readonly payloadHash: string;
  readonly payloadAvailable: boolean;
  readonly status: "PENDING" | "ACCEPTED" | "REJECTED" | "EXPIRED";
}
export type RelayTaskSkillProposal = RelayAssistProposalBase &
  { readonly kind: "TASK_CONTRACT_CHANGE" | "VERIFICATION_PLAN_CHANGE";
    readonly targetType: "TASK"; readonly baseAcceptanceRevision: DecimalRevision;
    readonly skillSha256: string; readonly skillOutputSha256: string;
    readonly payload: { readonly objective: string;
      readonly requiredOutputSpec: Readonly<Record<string, unknown>>;
      readonly criteria: readonly { readonly criterionId: string; readonly statement: string;
        readonly required: boolean; readonly method: string;
        readonly targetSpec: Readonly<Record<string, unknown>>;
        readonly source: "PRESERVED" | "SUGGESTED" }[];
      readonly addedCriterionIds: readonly string[];
      readonly preservedCriterionIds: readonly string[];
      readonly suggestedMode: string | null } | null };
export type RelayAssistProposal = RelayAssistProposalBase & (
  { readonly kind: "CANDIDATE_MARKDOWN"; readonly targetType: "TASK";
    readonly payload: { readonly title: string; readonly mediaType: string; readonly markdown: string } } |
  { readonly kind: "TASK_DEFINITION"; readonly targetType: "PROJECT";
    readonly payload: { readonly title: string; readonly objective: string;
      readonly criteria: readonly { readonly statement: string; readonly required: boolean;
        readonly method: string }[]; readonly expectedOutputs: Readonly<Record<string, unknown>> } }
) | RelayTaskSkillProposal;

export interface RelayReadiness {
  readonly status: "ready";
}

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
}

export type RelayGatewayCapability = "FAKE_WRITE" | "FAKE_PUBLIC_READ" | "FILE_READ" | "WEB_FETCH";
export type RelayGatewayDecision = "DENY" | "ASK" | "AUTO";
export interface RelayGatewayConnectionSettings extends RelayGatewayConnection {
  readonly projectId: string;
  readonly version: DecimalRevision;
  readonly createdAt: string;
}
function gatewayConnectionSettingsFrom(value: unknown): RelayGatewayConnectionSettings {
  const row = object(value, "connection settings");
  return { id: string(row, "id", "connection settings"),
    projectId: string(row, "project_id", "connection settings"),
    status: string(row, "status", "connection settings"),
    version: decimal(row, "version", "connection settings"),
    capabilities: stringArray(row, "capabilities", "connection settings"),
    allowedHost: nullableString(row, "allowed_host", "connection settings"),
    createdAt: string(row, "created_at", "connection settings") };
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
function managedResourceFrom(value: unknown): RelayManagedResource {
  const row = object(value, "managed resource");
  return { id: string(row, "id", "managed resource"),
    projectId: string(row, "project_id", "managed resource"),
    canonicalRoot: string(row, "canonical_root", "managed resource"),
    status: string(row, "status", "managed resource"),
    revision: decimal(row, "revision", "managed resource"),
    resourceEpoch: decimal(row, "resource_epoch", "managed resource"),
    fileWriteIdentityBound: row.file_write_identity_bound === true };
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

function commandOutputFrom(value: unknown, invocationId: string | null, operationId: string | null): RelayCommandOutput | null {
  if (!isRecord(value)) return null;
  // 只有服务端真的回传了 stdout/stderr 才是命令输出；没有该字段的调用一律视为无输出。
  if (typeof value.stdout !== "string" && typeof value.stderr !== "string") return null;
  return {
    stdout: typeof value.stdout === "string" ? value.stdout : "",
    stderr: typeof value.stderr === "string" ? value.stderr : "",
    exitCode: typeof value.exit_code === "number" ? value.exit_code : null,
    outcome: typeof value.outcome === "string" ? value.outcome : null,
    truncated: value.truncated === true,
    durationMs: typeof value.duration_ms === "number" ? value.duration_ms : null,
    invocationId,
    operationId
  };
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

/** CreateProject 的 201 结果（docs/api/http-command-contract.md 第 3 节）。 */
export interface RelayProjectCreation {
  readonly projectId: string;
  readonly revision: DecimalRevision;
  readonly phaseKey: string;
  readonly stateRevision: DecimalRevision;
}

/** CreateTask 的 201 结果：新任务一律 INBOX + HUMAN，验收版本从 v1 开始。 */
export interface RelayTaskCreation {
  readonly taskId: string;
  readonly projectId: string | null;
  readonly status: TaskStatus;
  readonly mode: InteractionMode;
  readonly revision: DecimalRevision;
  readonly acceptanceRevision: DecimalRevision;
}

/** Task 状态迁移命令的 200 结果。 */
export interface RelayTaskMutation {
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly revision: DecimalRevision;
}

/**
 * 工作台客户端只覆盖已经有服务端契约的读取、命令与回执查询。
 * 不与 fixtureAdapter 混用，也不缓存任何业务事实或凭据。
 * 未实现的端点不在这里建占位方法，调用方必须继续显示“未接入”。
 */
export class RelayApiClient {
  readonly #baseUrl: string;
  readonly #workspaceId: string;
  readonly #bearerToken: string;

  constructor(connection: RelayApiConnection) {
    this.#baseUrl = normalizeBaseUrl(connection.baseUrl);
    this.#workspaceId = requiredText(connection.workspaceId, "workspace ID");
    this.#bearerToken = requiredText(connection.bearerToken, "Bearer 令牌");
  }

  get workspaceId(): string {
    return this.#workspaceId;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  async getHealthReady(): Promise<RelayReadiness> {
    const body = await this.request("/health/ready");
    const record = object(body, "readiness");
    if (string(record, "status", "readiness") !== "ready") {
      throw new Error("服务端返回了无法识别的 readiness 状态。");
    }
    return { status: "ready" };
  }

  async getProject(projectId: string): Promise<RelayProject> {
    return projectFrom(await this.request(this.workspacePath(`/projects/${encodeURIComponent(projectId)}`)));
  }

  async getProjectsPage(status: "active" | "archived" | "all", cursor: string | null = null): Promise<RelayProjectPage> {
    const query = new URLSearchParams({ status });
    if (cursor !== null) query.set("cursor", cursor);
    const record = object(await this.request(`${this.workspacePath("/projects")}?${query.toString()}`), "project list");
    return { items: array(record, "items", "project list").map(projectListItemFrom),
      nextCursor: nullableString(record, "next_cursor", "project list") };
  }

  async archiveProject(input: { readonly projectId: string; readonly commandId: string;
    readonly expectedRevision: DecimalRevision }): Promise<RelayCommandEnvelope> {
    const body = await this.request(this.workspacePath(
      `/projects/${encodeURIComponent(input.projectId)}/archive`), {
      method: "POST", body: JSON.stringify({ command_id: input.commandId,
        expected_revision: input.expectedRevision })
    }, 200);
    try { return commandEnvelopeFrom(body); }
    catch { throw new RelayTransportError("归档命令响应内容无法核对，请查询原 command ID 回执。"); }
  }

  async getViewConfiguration(projectId: string): Promise<RelayViewConfiguration> {
    return viewConfigurationFrom(await this.request(this.workspacePath(
      `/projects/${encodeURIComponent(projectId)}/view-configuration`)));
  }

  async setViewConfiguration(input: { readonly projectId: string; readonly commandId: string;
    readonly expectedRevision: DecimalRevision; readonly kind: RelayViewKind }): Promise<RelayCommandEnvelope> {
    return commandEnvelopeFrom(await this.request(this.workspacePath(
      `/projects/${encodeURIComponent(input.projectId)}/view-configuration`), {
      method: "POST", body: JSON.stringify({ command_id: input.commandId,
        expected_revision: input.expectedRevision, kind: input.kind })
    }, 200));
  }

  async getContinuationPoints(projectId: string): Promise<readonly RelayContinuationPointSummary[]> {
    return array(object(await this.request(this.workspacePath(
      `/projects/${encodeURIComponent(projectId)}/continuation-points`)),
    "continuation points"), "items", "continuation points").map(continuationPointSummaryFrom);
  }

  async captureContinuationPoint(input: { readonly projectId: string; readonly commandId: string;
    readonly name: string; readonly note: string | null }): Promise<RelayCommandEnvelope> {
    return commandEnvelopeFrom(await this.request(this.workspacePath(
      `/projects/${encodeURIComponent(input.projectId)}/continuation-points`), {
      method: "POST", body: JSON.stringify({ command_id: input.commandId,
        name: input.name, note: input.note })
    }, 201));
  }

  async compareContinuationPoint(projectId: string, pointId: string): Promise<RelayContinuationComparison> {
    return continuationComparisonFrom(await this.request(this.workspacePath(
      `/projects/${encodeURIComponent(projectId)}/continuation-points/${encodeURIComponent(pointId)}` +
      "/comparison")));
  }

  async getProjectGoals(projectId: string): Promise<readonly RelayProjectGoal[]> {
    return projectGoalListFrom(await this.request(this.workspacePath(
      `/projects/${encodeURIComponent(projectId)}/goals`)));
  }

  async getGoal(goalId: string): Promise<RelayGoal> {
    return goalFrom(await this.request(this.workspacePath(`/goals/${encodeURIComponent(goalId)}`)));
  }

  async getBlueprintProposals(projectId: string): Promise<readonly RelayBlueprintProposal[]> {
    const body = object(await this.request(this.workspacePath(
      `/projects/${encodeURIComponent(projectId)}/blueprint-proposals`)), "blueprint proposals");
    return array(body, "items", "blueprint proposals").map(blueprintProposalFrom);
  }

  async getBlueprintProposal(projectId: string, proposalId: string): Promise<RelayBlueprintProposal> {
    return blueprintProposalFrom(await this.request(this.workspacePath(
      `/projects/${encodeURIComponent(projectId)}/blueprint-proposals/${encodeURIComponent(proposalId)}`)));
  }

  async createBlueprintProposal(input: { readonly projectId: string; readonly commandId: string;
    readonly expectedProjectRevision: DecimalRevision; readonly expectedStateRevision: DecimalRevision;
    readonly expectedViewRevision: DecimalRevision; readonly draft: RelayBlueprintDraft;
    readonly supersedesProposalId: string | null }): Promise<RelayCommandEnvelope> {
    return commandEnvelopeFrom(await this.request(this.workspacePath(
      `/projects/${encodeURIComponent(input.projectId)}/blueprint-proposals`), {
      method: "POST", body: JSON.stringify({ command_id: input.commandId,
        expected_project_revision: input.expectedProjectRevision,
        expected_state_revision: input.expectedStateRevision,
        expected_view_revision: input.expectedViewRevision, draft: input.draft,
        ...(input.supersedesProposalId ? { supersedes_proposal_id: input.supersedesProposalId } : {}) })
    }, 201));
  }

  async applyBlueprintProposal(input: { readonly projectId: string; readonly proposalId: string;
    readonly commandId: string; readonly candidateSha256: string;
    readonly expectedProjectRevision: DecimalRevision; readonly expectedStateRevision: DecimalRevision;
    readonly expectedViewRevision: DecimalRevision }): Promise<RelayCommandEnvelope> {
    return commandEnvelopeFrom(await this.request(this.workspacePath(
      `/projects/${encodeURIComponent(input.projectId)}/blueprint-proposals/${encodeURIComponent(input.proposalId)}/apply`), {
      method: "POST", body: JSON.stringify({ command_id: input.commandId,
        candidate_sha256: input.candidateSha256,
        expected_project_revision: input.expectedProjectRevision,
        expected_state_revision: input.expectedStateRevision,
        expected_view_revision: input.expectedViewRevision })
    }, 200));
  }

  async rejectBlueprintProposal(input: { readonly projectId: string; readonly proposalId: string;
    readonly commandId: string; readonly candidateSha256: string }): Promise<RelayCommandEnvelope> {
    return commandEnvelopeFrom(await this.request(this.workspacePath(
      `/projects/${encodeURIComponent(input.projectId)}/blueprint-proposals/${encodeURIComponent(input.proposalId)}/reject`), {
      method: "POST", body: JSON.stringify({ command_id: input.commandId,
        candidate_sha256: input.candidateSha256 })
    }, 200));
  }

  /** 逻辑上的“项目任务读取”映射为当前契约的 GET /tasks?project_id=。 */
  async getProjectTasks(projectId: string): Promise<readonly RelayTaskSummary[]> {
    return (await this.getProjectTasksPage(projectId)).items;
  }

  async getProjectTasksPage(projectId: string, cursor: string | null = null): Promise<RelayTaskPage> {
    const query = new URLSearchParams({ project_id: projectId });
    if (cursor !== null) query.set("cursor", cursor);
    const body = await this.request(`${this.workspacePath("/tasks")}?${query.toString()}`);
    const record = object(body, "task list");
    return {
      items: array(record, "items", "task list").map((item) => taskFrom(item)),
      nextCursor: nullableString(record, "next_cursor", "task list")
    };
  }

  async getInboxTasksPage(cursor: string | null = null): Promise<RelayTaskPage> {
    const query = new URLSearchParams({ inbox: "true" });
    if (cursor !== null) query.set("cursor", cursor);
    const record = object(await this.request(`${this.workspacePath("/tasks")}?${query.toString()}`), "inbox task list");
    return { items: array(record, "items", "inbox task list").map((item) => taskFrom(item)),
      nextCursor: nullableString(record, "next_cursor", "inbox task list") };
  }

  async getWorkspaceTasksPage(cursor: string | null = null): Promise<RelayTaskPage> {
    const query = new URLSearchParams({ scope: "all" });
    if (cursor !== null) query.set("cursor", cursor);
    const record = object(await this.request(`${this.workspacePath("/tasks")}?${query.toString()}`), "workspace task list");
    return { items: array(record, "items", "workspace task list").map(taskFrom),
      nextCursor: nullableString(record, "next_cursor", "workspace task list") };
  }

  async getTask(taskId: string): Promise<RelayTaskDetail> {
    const body = await this.request(this.workspacePath(`/tasks/${encodeURIComponent(taskId)}`));
    const task = taskFrom(body);
    const record = object(body, "task");
    return {
      ...task,
      acceptance: acceptanceFrom(object(record.acceptance, "task.acceptance")),
      dependencies: array(record, "dependencies", "task").map((item) => dependencyFrom(item))
    };
  }

  async getCompletionEvidence(completionId: string): Promise<RelayCompletionEvidence> {
    return completionEvidenceFrom(await this.request(this.workspacePath(
      `/completion-records/${encodeURIComponent(completionId)}`)));
  }

  async getTaskCheckPlanPreview(taskId: string): Promise<RelayTaskCheckPlanPreview> {
    return taskCheckPlanPreviewFrom(await this.request(this.workspacePath(
      `/tasks/${encodeURIComponent(taskId)}/check-plan-preview`)), taskId);
  }

  async getToday(date: string, timezone: string): Promise<RelayToday> {
    const query = new URLSearchParams({ date, timezone });
    return todayFrom(await this.request(`${this.workspacePath("/today")}?${query.toString()}`));
  }

  async getActivities(filter: RelayActivityFilter = {}): Promise<RelayActivityPage> {
    const query = new URLSearchParams();
    if (filter.projectId) query.set("project_id", filter.projectId);
    if (filter.taskId) query.set("task_id", filter.taskId);
    if (filter.runId) query.set("run_id", filter.runId);
    if (filter.from) query.set("from", filter.from);
    if (filter.to) query.set("to", filter.to);
    if (filter.cursor) query.set("cursor", filter.cursor);
    if (filter.limit) query.set("limit", String(filter.limit));
    const suffix = query.size ? `?${query.toString()}` : "";
    return activityPageFrom(await this.request(`${this.workspacePath("/activities")}${suffix}`));
  }

  async setTaskSelection(input: { taskId: string; commandId: string; expectedRevision: DecimalRevision;
    pin: boolean; laterLocalDate: string | null; timezone: string | null }): Promise<RelayCommandEnvelope> {
    return commandEnvelopeFrom(await this.request(this.workspacePath(`/task-selections/${encodeURIComponent(input.taskId)}`), {
      method: "POST", body: JSON.stringify({ command_id: input.commandId, expected_revision: input.expectedRevision,
        pin: input.pin, later_local_date: input.laterLocalDate, timezone: input.timezone })
    }, 200));
  }

  async setFocusSelection(input: { commandId: string; expectedRevision: DecimalRevision; date: string;
    timezone: string; targetKind: "GOAL" | "PROJECT" | "TASK" | null; targetId: string | null }): Promise<RelayCommandEnvelope> {
    return commandEnvelopeFrom(await this.request(this.workspacePath("/focus-selections"), {
      method: "POST", body: JSON.stringify({ command_id: input.commandId, expected_revision: input.expectedRevision,
        date: input.date, timezone: input.timezone, target_kind: input.targetKind, target_id: input.targetId })
    }, 200));
  }

  async setTaskPlanningMetadata(input: { taskId: string; commandId: string; expectedRevision: DecimalRevision;
    priority: RelayTodayPriority | null; dueLocalDate: string | null; timezone: string | null }): Promise<RelayCommandEnvelope> {
    return commandEnvelopeFrom(await this.request(this.workspacePath(`/tasks/${encodeURIComponent(input.taskId)}/planning-metadata`), {
      method: "POST", body: JSON.stringify({ command_id: input.commandId, expected_revision: input.expectedRevision,
        priority: input.priority, due_local_date: input.dueLocalDate, timezone: input.timezone })
    }, 200));
  }

  async createProject(input: {
    readonly commandId: string;
    readonly title: string;
    readonly projectType: string;
  }): Promise<RelayProjectCreation> {
    const body = await this.request(this.workspacePath("/projects"), {
      method: "POST",
      body: JSON.stringify({
        command_id: input.commandId,
        title: input.title,
        project_type: input.projectType
      })
    });
    return projectCreationFrom(commandEnvelopeFrom(body).result);
  }

  async createTask(input: {
    readonly commandId: string;
    readonly projectId: string | null;
    readonly title: string;
    readonly objective: string;
    readonly mode: InteractionMode;
    /** 每行一条验收标准；criterion_id 与 method 由服务端补齐。 */
    readonly criteria: readonly string[];
  }): Promise<RelayTaskCreation> {
    const body = await this.request(this.workspacePath("/tasks"), {
      method: "POST",
      body: JSON.stringify({
        command_id: input.commandId,
        ...(input.projectId === null ? {} : { project_id: input.projectId }),
        title: input.title,
        objective: input.objective,
        mode: input.mode,
        criteria: input.criteria.map((statement) => ({ statement }))
      })
    });
    return taskCreationFrom(commandEnvelopeFrom(body).result);
  }

  async markTaskReady(input: {
    readonly taskId: string;
    readonly commandId: string;
    readonly expectedRevision: DecimalRevision;
  }): Promise<RelayTaskMutation> {
    const body = await this.request(this.workspacePath(`/tasks/${encodeURIComponent(input.taskId)}/ready`), {
      method: "POST",
      body: JSON.stringify({ command_id: input.commandId, expected_revision: input.expectedRevision })
    });
    return taskMutationFrom(commandEnvelopeFrom(body).result);
  }

  /**
   * POST /tasks/{id}/dependency-links：新增一条任务依赖。
   * expected_revision 必须是上一步返回的 revision；BLOCKS 表示前置未完成会阻塞本任务。
   */
  async addTaskDependency(input: {
    readonly taskId: string;
    readonly commandId: string;
    readonly expectedRevision: DecimalRevision;
    readonly dependsOnTaskId: string;
    readonly dependencyKind: "BLOCKS" | "INFORMS";
  }): Promise<RelayTaskMutation> {
    const body = await this.request(
      this.workspacePath(`/tasks/${encodeURIComponent(input.taskId)}/dependency-links`),
      {
        method: "POST",
        body: JSON.stringify({
          command_id: input.commandId,
          expected_revision: input.expectedRevision,
          depends_on_task_id: input.dependsOnTaskId,
          dependency_kind: input.dependencyKind
        })
      }
    );
    return taskMutationFrom(commandEnvelopeFrom(body).result);
  }

  async startHumanTask(input: {
    readonly taskId: string;
    readonly commandId: string;
    readonly expectedRevision: DecimalRevision;
  }): Promise<RelayTaskMutation> {
    const body = await this.request(this.workspacePath(`/tasks/${encodeURIComponent(input.taskId)}/start`), {
      method: "POST",
      body: JSON.stringify({ command_id: input.commandId, expected_revision: input.expectedRevision })
    });
    return taskMutationFrom(commandEnvelopeFrom(body).result);
  }

  async getCommandReceipt(commandId: string): Promise<RelayCommandReceipt> {
    const body = await this.request(this.workspacePath(`/commands/${encodeURIComponent(commandId)}`));
    const envelope = commandEnvelopeFrom(body);
    const record = object(body, "command receipt");
    return { ...envelope, commandType: string(record, "command_type", "command receipt") };
  }

  async getKnowledge(projectId: string | null = null): Promise<readonly RelayKnowledge[]> {
    return directList(await this.request(this.informationListPath("knowledge", projectId)), "knowledge list", knowledgeFrom);
  }

  async getKnowledgeDetail(id: string): Promise<RelayKnowledge> {
    return knowledgeFrom(await this.request(this.workspacePath(`/knowledge/${encodeURIComponent(id)}`)));
  }

  async getKnowledgeVersions(id: string): Promise<readonly RelayKnowledgeVersion[]> {
    return directList(await this.request(this.workspacePath(`/knowledge/${encodeURIComponent(id)}/versions`)),
      "knowledge versions", knowledgeVersionFrom);
  }

  async getKnowledgeVersionContent(id: string, version: DecimalRevision): Promise<RelayKnowledgeVersionContent> {
    const result = knowledgeVersionContentFrom(await this.request(this.workspacePath(
      `/knowledge/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/content`)));
    if (result.knowledgeId !== id || result.version !== version) {
      throw new Error("知识正文响应与所选资料版本不一致。");
    }
    return result;
  }

  async createKnowledge(input: { commandId: string; projectId: string | null; title: string;
    sourceKind: Exclude<RelayKnowledgeSource, "WEB_PAGE">; text?: string; mediaType?: string; artifactVersionId?: string }): Promise<RelayCommandEnvelope> {
    return this.informationCommand("/knowledge", {
      command_id: input.commandId, project_id: input.projectId, title: input.title,
      source_kind: input.sourceKind,
      ...(input.text === undefined ? {} : { text: input.text }),
      ...(input.mediaType === undefined ? {} : { media_type: input.mediaType }),
      ...(input.artifactVersionId === undefined ? {} : { artifact_version_id: input.artifactVersionId })
    }, 201);
  }

  async addKnowledgeVersion(input: { id: string; commandId: string; expectedRevision: DecimalRevision;
    sourceKind: Exclude<RelayKnowledgeSource, "WEB_PAGE">; text?: string; mediaType?: string; artifactVersionId?: string }): Promise<RelayCommandEnvelope> {
    return this.informationCommand(`/knowledge/${encodeURIComponent(input.id)}/versions`, {
      command_id: input.commandId, expected_revision: input.expectedRevision, source_kind: input.sourceKind,
      ...(input.text === undefined ? {} : { text: input.text }),
      ...(input.mediaType === undefined ? {} : { media_type: input.mediaType }),
      ...(input.artifactVersionId === undefined ? {} : { artifact_version_id: input.artifactVersionId })
    }, 200);
  }

  async archiveKnowledge(id: string, commandId: string, expectedRevision: DecimalRevision): Promise<RelayCommandEnvelope> {
    return this.informationCommand(`/knowledge/${encodeURIComponent(id)}/archive`,
      { command_id: commandId, expected_revision: expectedRevision }, 200);
  }

  async getMemories(projectId: string | null = null): Promise<readonly RelayMemory[]> {
    return directList(await this.request(this.informationListPath("memories", projectId)), "memory list", memoryFrom);
  }

  async getMemory(id: string): Promise<RelayMemory> {
    return memoryFrom(await this.request(this.workspacePath(`/memories/${encodeURIComponent(id)}`)));
  }

  async getMemoryRevisions(id: string): Promise<readonly RelayMemoryRevision[]> {
    return directList(await this.request(this.workspacePath(`/memories/${encodeURIComponent(id)}/revisions`)),
      "memory revisions", memoryRevisionFrom);
  }

  async createMemory(input: { commandId: string; projectId: string | null; title: string; text: string;
    confirmed: true; expiresAt?: string | null }): Promise<RelayCommandEnvelope> {
    return this.informationCommand("/memories", {
      command_id: input.commandId, project_id: input.projectId, title: input.title,
      text: input.text, confirmed: input.confirmed,
      ...(input.expiresAt === undefined ? {} : { expires_at: input.expiresAt })
    }, 201);
  }

  async addMemoryRevision(input: { id: string; commandId: string; expectedRevision: DecimalRevision;
    title: string; text: string; confirmed: true; expiresAt?: string | null }): Promise<RelayCommandEnvelope> {
    return this.informationCommand(`/memories/${encodeURIComponent(input.id)}/revisions`, {
      command_id: input.commandId, expected_revision: input.expectedRevision, title: input.title,
      text: input.text, confirmed: input.confirmed,
      ...(input.expiresAt === undefined ? {} : { expires_at: input.expiresAt })
    }, 200);
  }

  async retireMemory(id: string, commandId: string, expectedRevision: DecimalRevision): Promise<RelayCommandEnvelope> {
    return this.informationCommand(`/memories/${encodeURIComponent(id)}/retire`,
      { command_id: commandId, expected_revision: expectedRevision }, 200);
  }

  async getDecisions(projectId: string | null = null): Promise<readonly RelayDecision[]> {
    return directList(await this.request(this.informationListPath("decisions", projectId)), "decision list", decisionFrom);
  }

  async getDecision(id: string): Promise<RelayDecision> {
    return decisionFrom(await this.request(this.workspacePath(`/decisions/${encodeURIComponent(id)}`)));
  }

  async createDecision(input: { commandId: string; projectId: string | null; title: string; choice: string;
    rationale: string; alternatives: readonly string[]; costs: readonly string[] }): Promise<RelayCommandEnvelope> {
    return this.informationCommand("/decisions", {
      command_id: input.commandId, project_id: input.projectId, title: input.title,
      choice: input.choice, rationale: input.rationale,
      alternatives: [...input.alternatives], costs: [...input.costs]
    }, 201);
  }

  async supersedeDecision(input: { id: string; commandId: string; expectedRevision: DecimalRevision;
    replacementDecisionId: string }): Promise<RelayCommandEnvelope> {
    return this.informationCommand(`/decisions/${encodeURIComponent(input.id)}/supersessions`, {
      command_id: input.commandId, expected_revision: input.expectedRevision,
      replacement_decision_id: input.replacementDecisionId
    }, 200);
  }

  async getRules(projectId: string | null = null): Promise<readonly RelayRule[]> {
    return directList(await this.request(this.informationListPath("rules", projectId)), "rule list", ruleFrom);
  }

  async getRule(id: string): Promise<RelayRule> {
    return ruleFrom(await this.request(this.workspacePath(`/rules/${encodeURIComponent(id)}`)));
  }

  async getRuleVersions(id: string): Promise<readonly RelayRuleVersion[]> {
    return directList(await this.request(this.workspacePath(`/rules/${encodeURIComponent(id)}/versions`)),
      "rule versions", ruleVersionFrom);
  }

  async createRule(input: { commandId: string; scope: "WORKSPACE" | "PROJECT" | "TASK"; scopeId: string;
    ruleKey: string; statement: string; strength: RelayRuleStrength; enforcement: RelayRuleEnforcement;
    method?: string; targetSpec?: Readonly<Record<string, unknown>> }): Promise<RelayCommandEnvelope> {
    return this.informationCommand("/rules", {
      command_id: input.commandId, scope: input.scope, scope_id: input.scopeId,
      rule_key: input.ruleKey, statement: input.statement, strength: input.strength,
      applicability: "AI_RUN", enforcement: input.enforcement,
      ...(input.method === undefined ? {} : { method: input.method }),
      ...(input.targetSpec === undefined ? {} : { target_spec: input.targetSpec })
    }, 201);
  }

  async addRuleVersion(input: { id: string; commandId: string; expectedRevision: DecimalRevision;
    ruleKey: string; statement: string; strength: RelayRuleStrength; enforcement: RelayRuleEnforcement;
    method?: string; targetSpec?: Readonly<Record<string, unknown>> }): Promise<RelayCommandEnvelope> {
    return this.informationCommand(`/rules/${encodeURIComponent(input.id)}/versions`, {
      command_id: input.commandId, expected_revision: input.expectedRevision,
      rule_key: input.ruleKey, statement: input.statement, strength: input.strength,
      applicability: "AI_RUN", enforcement: input.enforcement,
      ...(input.method === undefined ? {} : { method: input.method }),
      ...(input.targetSpec === undefined ? {} : { target_spec: input.targetSpec })
    }, 200);
  }

  async retireRule(id: string, commandId: string, expectedRevision: DecimalRevision): Promise<RelayCommandEnvelope> {
    return this.informationCommand(`/rules/${encodeURIComponent(id)}/retire`,
      { command_id: commandId, expected_revision: expectedRevision }, 200);
  }

  async searchInformation(input: { q: string; projectId: string | null; types: readonly RelayInformationKind[];
    limit?: number; cursor?: string }): Promise<RelaySearchPage> {
    const query = new URLSearchParams({ q: input.q, types: input.types.join(","), limit: String(input.limit ?? 20) });
    if (input.projectId !== null) query.set("project_id", input.projectId);
    if (input.cursor !== undefined) query.set("cursor", input.cursor);
    const record = object(await this.request(`${this.workspacePath("/search")}?${query.toString()}`), "search");
    return {
      items: array(record, "items", "search").map(searchItemFrom),
      nextCursor: nullableString(record, "next_cursor", "search")
    };
  }

  async getAssistSessions(target: { projectId?: string; taskId?: string }): Promise<readonly RelayAssistSession[]> {
    const query = new URLSearchParams();
    if (target.projectId) query.set("project_id", target.projectId);
    if (target.taskId) query.set("task_id", target.taskId);
    const body = object(await this.request(`${this.workspacePath("/assist-sessions")}?${query}`), "assist sessions");
    return array(body, "items", "assist sessions").map(assistSessionFrom);
  }

  async getAssistSession(sessionId: string): Promise<RelayAssistSession> {
    return assistSessionFrom(await this.request(this.workspacePath(
      `/assist-sessions/${encodeURIComponent(sessionId)}`)));
  }

  async getFirstPartySkills(): Promise<readonly RelaySkillDefinition[]> {
    const body = object(await this.request(this.workspacePath("/skill-definitions")), "skill definitions");
    return array(body, "items", "skill definitions").map(skillDefinitionFrom);
  }

  async getFirstPartyPacks(): Promise<readonly RelayPackDefinition[]> {
    const body = object(await this.request(this.workspacePath("/packs")), "packs");
    return array(body, "items", "packs").map(packDefinitionFrom);
  }

  async createAssistSession(input: { commandId: string; projectId: string | null; taskId: string | null;
    title: string }): Promise<RelayAssistSession> {
    const body = await this.request(this.workspacePath("/assist-sessions"), { method: "POST",
      body: JSON.stringify({ command_id: input.commandId, project_id: input.projectId,
        task_id: input.taskId, title: input.title }) }, 201);
    try {
      const envelope = commandEnvelopeFrom(body);
      if (envelope.commandId !== input.commandId) throw new Error("command mismatch");
      return assistSessionFrom({ ...envelope.result, id: envelope.result.session_id });
    } catch { throw new RelayTransportError("Assist 会话回执无法核对，请查询原 command_id。"); }
  }

  async getAssistMessages(sessionId: string): Promise<readonly RelayAssistMessage[]> {
    const body = object(await this.request(this.workspacePath(`/assist-sessions/${encodeURIComponent(sessionId)}/messages?limit=200`)), "assist messages");
    return array(body, "items", "assist messages").map(assistMessageFrom);
  }

  async getAssistLivePreview(sessionId: string, messageId: string): Promise<RelayAssistLivePreview> {
    const row = object(await this.request(this.workspacePath(
      `/assist-sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/live-preview`)),
    "assist live preview");
    const status = string(row, "status", "assist live preview");
    if (!["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"].includes(status) ||
      string(row, "session_id", "assist live preview") !== sessionId ||
      string(row, "message_id", "assist live preview") !== messageId) {
      throw new RelayTransportError("Assist 草稿预览与当前消息不匹配。");
    }
    return { sessionId, messageId, status: status as RelayAssistMessage["status"],
      previewRevision: decimal(row, "preview_revision", "assist live preview"),
      previewText: nullableString(row, "preview_text", "assist live preview"),
      previewTruncated: boolean(row, "preview_truncated", "assist live preview"),
      previewAvailable: boolean(row, "preview_available", "assist live preview") };
  }

  async requestAssistMessage(input: { sessionId: string; commandId: string; content: string;
    sourceRefs: readonly RelayAssistSourceRef[] } & (
      { intent: "DISCUSS" | "PROPOSE_CANDIDATE" | "PROPOSE_TASK"; skillRef?: never; skillInput?: never } |
      { intent?: never; skillRef: { id: string; version: string }; skillInput: RelaySkillInput }
    )): Promise<{ userMessageId: string; assistantMessageId: string }> {
    const body = await this.request(this.workspacePath(`/assist-sessions/${encodeURIComponent(input.sessionId)}/messages`), {
      method: "POST", body: JSON.stringify({ command_id: input.commandId, content: input.content,
        source_refs: input.sourceRefs.map(assistSourceBody),
        ...(input.skillRef ? { skill_ref: input.skillRef, skill_input: input.skillInput } : { intent: input.intent }) }) }, 202);
    try {
      const envelope = commandEnvelopeFrom(body);
      if (envelope.commandId !== input.commandId || envelope.result.session_id !== input.sessionId) throw new Error("command mismatch");
      return { userMessageId: string(envelope.result, "user_message_id", "assist result"),
        assistantMessageId: string(envelope.result, "assistant_message_id", "assist result") };
    } catch { throw new RelayTransportError("Assist 消息回执无法核对，请查询原 command_id。"); }
  }

  async cancelAssistMessage(messageId: string, commandId: string): Promise<string> {
    const body = await this.request(this.workspacePath(`/assist-messages/${encodeURIComponent(messageId)}/cancel`), {
      method: "POST", body: JSON.stringify({ command_id: commandId }) }, 200);
    try {
      const envelope = commandEnvelopeFrom(body);
      if (envelope.commandId !== commandId || envelope.result.message_id !== messageId) throw new Error("command mismatch");
      return string(envelope.result, "status", "assist cancel result");
    } catch { throw new RelayTransportError("Assist 取消回执无法核对，请查询原 command_id。"); }
  }

  async getAssistProposals(sessionId: string): Promise<readonly RelayAssistProposal[]> {
    const query = new URLSearchParams({ session_id: sessionId });
    const body = object(await this.request(`${this.workspacePath("/assist-proposals")}?${query}`), "assist proposals");
    return array(body, "items", "assist proposals").map(assistProposalFrom);
  }

  async acceptAssistProposal(proposalId: string, commandId: string, taskContract?: {
    expectedTaskRevision: DecimalRevision; expectedAcceptanceRevision: DecimalRevision;
    payloadHash: string }): Promise<RelayCommandEnvelope> {
    const body = await this.request(this.workspacePath(`/assist-proposals/${encodeURIComponent(proposalId)}/accept`), {
      method: "POST", body: JSON.stringify({ command_id: commandId,
        ...(taskContract ? { expected_task_revision: taskContract.expectedTaskRevision,
          expected_acceptance_revision: taskContract.expectedAcceptanceRevision,
          payload_hash: taskContract.payloadHash } : {}) }) }, 200);
    try {
      const envelope = commandEnvelopeFrom(body);
      if (envelope.commandId !== commandId) throw new Error("command mismatch");
      return envelope;
    } catch { throw new RelayTransportError("提案接受回执无法核对，请查询原 command_id。"); }
  }

  private informationListPath(resource: string, projectId: string | null): string {
    const path = this.workspacePath(`/${resource}`);
    return projectId === null ? path : `${path}?${new URLSearchParams({ project_id: projectId })}`;
  }

  private async informationCommand(path: string, payload: Record<string, unknown>, status: number): Promise<RelayCommandEnvelope> {
    const body = await this.request(this.workspacePath(path), { method: "POST", body: JSON.stringify(payload) }, status);
    try {
      const envelope = commandEnvelopeFrom(body);
      if (envelope.commandId !== payload.command_id) throw new Error("command ID mismatch");
      return envelope;
    } catch {
      throw new RelayTransportError("命令回执无法核对，请查询原 command_id。");
    }
  }

  async getReviews(): Promise<readonly RelayReview[]> {
    const body = await this.request(`${this.workspacePath("/reviews")}?status=OPEN`);
    const record = object(body, "review list");
    return array(record, "items", "review list").map(reviewFrom);
  }

  async getReview(reviewId: string): Promise<RelayReview> {
    return reviewFrom(await this.request(this.workspacePath(`/reviews/${encodeURIComponent(reviewId)}`)));
  }

  async delegateTask(input: {
    readonly taskId: string;
    readonly commandId: string;
    readonly expectedTaskRevision: DecimalRevision;
    readonly mockGatewayAction?: RelayMockGatewayAction;
    readonly fileReadAction?: RelayFileReadAction;
    readonly webFetchAction?: RelayWebFetchAction;
    readonly contextSources?: readonly RelayAssistSourceRef[];
  }): Promise<RelayDelegateSubmission> {
    const body = await this.request(this.workspacePath(`/tasks/${encodeURIComponent(input.taskId)}/delegations`), {
      method: "POST",
      body: JSON.stringify({ command_id: input.commandId, expected_task_revision: input.expectedTaskRevision,
        ...(input.contextSources?.length ? { context_sources: input.contextSources.map(assistSourceBody) } : {}),
        ...(input.mockGatewayAction === undefined ? {} : { mock_gateway_action: {
          connection_id: input.mockGatewayAction.connectionId,
          resource_id: input.mockGatewayAction.resourceId,
          target: input.mockGatewayAction.target,
          content: input.mockGatewayAction.content
        } }),
        ...(input.fileReadAction === undefined ? {} : { file_read_action: {
          connection_id: input.fileReadAction.connectionId,
          resource_id: input.fileReadAction.resourceId,
          relative_target: input.fileReadAction.relativeTarget
        } }),
        ...(input.webFetchAction === undefined ? {} : { web_fetch_action: {
          connection_id: input.webFetchAction.connectionId,
          url: input.webFetchAction.url
        } }) })
    }, 202);
    try {
      const envelope = commandEnvelopeFrom(body);
      const result = delegateSubmissionFrom(envelope.result);
      if (envelope.commandId !== input.commandId || result.taskId !== input.taskId) throw new Error("Delegate 回执与命令不匹配。");
      return result;
    } catch {
      throw new RelayTransportError("Delegate 回执无法核对，请查询原 command_id。");
    }
  }

  async getGatewayConnections(projectId: string): Promise<readonly RelayGatewayConnection[]> {
    const body = await this.request(this.workspacePath(`/projects/${encodeURIComponent(projectId)}/connections`));
    return directList(body, "connection list", (item) => {
      const row = object(item, "connection");
      return { id: string(row, "id", "connection"), status: string(row, "status", "connection"),
        capabilities: stringArray(row, "capabilities", "connection"),
        allowedHost: nullableString(row, "allowed_host", "connection") };
    });
  }

  async getGatewayConnectionSettings(projectId: string): Promise<readonly RelayGatewayConnectionSettings[]> {
    const body = await this.request(this.workspacePath(`/projects/${encodeURIComponent(projectId)}/connections`));
    return directList(body, "connection settings", gatewayConnectionSettingsFrom);
  }

  async getGatewayConnectionSetting(projectId: string, connectionId: string): Promise<RelayGatewayConnectionSettings> {
    return gatewayConnectionSettingsFrom(await this.request(this.workspacePath(`/projects/${encodeURIComponent(projectId)}/connections/${encodeURIComponent(connectionId)}`)));
  }

  async createGatewayConnection(input: { projectId: string; commandId: string;
    capability: RelayGatewayCapability; rootPath?: string; allowedHost?: string }): Promise<RelayCommandEnvelope> {
    return commandEnvelopeFrom(await this.request(this.workspacePath(`/projects/${encodeURIComponent(input.projectId)}/connections`), {
      method: "POST", body: JSON.stringify({ command_id: input.commandId, capabilities: [input.capability],
        ...(input.rootPath === undefined ? {} : { root_path: input.rootPath }),
        ...(input.allowedHost === undefined ? {} : { allowed_host: input.allowedHost }) })
    }, 201));
  }

  async disableGatewayConnection(input: { projectId: string; connectionId: string;
    commandId: string; expectedVersion: DecimalRevision }): Promise<RelayCommandEnvelope> {
    return commandEnvelopeFrom(await this.request(this.workspacePath(`/projects/${encodeURIComponent(input.projectId)}/connections/${encodeURIComponent(input.connectionId)}/disable`), {
      method: "POST", body: JSON.stringify({ command_id: input.commandId, expected_version: input.expectedVersion })
    }, 200));
  }

  async getGatewayPolicies(projectId: string): Promise<readonly RelayGatewayPolicy[]> {
    const body = await this.request(this.workspacePath(`/projects/${encodeURIComponent(projectId)}/permission-policies`));
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

  async getGatewayPolicyVersions(projectId: string, policyId: string): Promise<readonly RelayGatewayPolicyVersion[]> {
    const body = await this.request(this.workspacePath(`/projects/${encodeURIComponent(projectId)}/permission-policies/${encodeURIComponent(policyId)}/versions`));
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

  async createGatewayPolicy(input: { projectId: string; commandId: string;
    capability: RelayGatewayCapability; resourceId: string | null; decision: RelayGatewayDecision;
    maxPayloadBytes: number; host?: string }): Promise<RelayCommandEnvelope> {
    return commandEnvelopeFrom(await this.request(this.workspacePath(`/projects/${encodeURIComponent(input.projectId)}/permission-policies`), {
      method: "POST", body: JSON.stringify({ command_id: input.commandId, capability: input.capability,
        resource_id: input.resourceId, decision: input.decision, max_payload_bytes: input.maxPayloadBytes,
        ...(input.host === undefined ? {} : { host: input.host }) })
    }, 201));
  }

  async addGatewayPolicyVersion(input: { projectId: string; policyId: string; commandId: string;
    expectedRevision: DecimalRevision; capability: RelayGatewayCapability; resourceId: string | null;
    decision: RelayGatewayDecision; maxPayloadBytes: number; host?: string }): Promise<RelayCommandEnvelope> {
    return commandEnvelopeFrom(await this.request(this.workspacePath(`/projects/${encodeURIComponent(input.projectId)}/permission-policies/${encodeURIComponent(input.policyId)}/versions`), {
      method: "POST", body: JSON.stringify({ command_id: input.commandId, expected_revision: input.expectedRevision,
        capability: input.capability, resource_id: input.resourceId, decision: input.decision,
        max_payload_bytes: input.maxPayloadBytes, ...(input.host === undefined ? {} : { host: input.host }) })
    }, 200));
  }

  async revokeGatewayPolicy(input: { projectId: string; policyId: string; commandId: string;
    expectedRevision: DecimalRevision }): Promise<RelayCommandEnvelope> {
    return commandEnvelopeFrom(await this.request(this.workspacePath(`/projects/${encodeURIComponent(input.projectId)}/permission-policies/${encodeURIComponent(input.policyId)}/revoke`), {
      method: "POST", body: JSON.stringify({ command_id: input.commandId, expected_revision: input.expectedRevision })
    }, 200));
  }

  async getManagedResources(projectId: string): Promise<readonly RelayManagedResource[]> {
    const body = await this.request(this.workspacePath(`/projects/${encodeURIComponent(projectId)}/managed-resources`));
    return directList(body, "managed resources", managedResourceFrom);
  }

  async getManagedResource(projectId: string, resourceId: string): Promise<RelayManagedResource> {
    return managedResourceFrom(await this.request(this.workspacePath(`/projects/${encodeURIComponent(projectId)}/managed-resources/${encodeURIComponent(resourceId)}`)));
  }

  async createManagedResource(input: { projectId: string; commandId: string;
    rootPath: string }): Promise<RelayCommandEnvelope> {
    return commandEnvelopeFrom(await this.request(this.workspacePath(`/projects/${encodeURIComponent(input.projectId)}/managed-resources`), {
      method: "POST", body: JSON.stringify({ command_id: input.commandId, root_path: input.rootPath })
    }, 201));
  }

  async disableManagedResource(input: { projectId: string; resourceId: string; commandId: string;
    expectedRevision: DecimalRevision }): Promise<RelayCommandEnvelope> {
    return commandEnvelopeFrom(await this.request(this.workspacePath(`/projects/${encodeURIComponent(input.projectId)}/managed-resources/${encodeURIComponent(input.resourceId)}/disable`), {
      method: "POST", body: JSON.stringify({ command_id: input.commandId, expected_revision: input.expectedRevision })
    }, 200));
  }

  async getMockGatewayConnections(projectId: string): Promise<readonly RelayMockGatewayConnection[]> {
    return this.getGatewayConnections(projectId);
  }

  async createWebImportJob(input: { readonly projectId: string; readonly commandId: string;
    readonly url: string; readonly connectionId: string }): Promise<RelayWebImportSubmission> {
    const body = await this.request(this.workspacePath(`/projects/${encodeURIComponent(input.projectId)}/import-jobs`), {
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

  async getWebImportJob(importJobId: string): Promise<RelayWebImportJob> {
    return webImportJobFrom(await this.request(this.workspacePath(`/import-jobs/${encodeURIComponent(importJobId)}`)));
  }

  async getWebImportOperations(importJobId: string): Promise<readonly RelayWebImportOperation[]> {
    const body = await this.request(this.workspacePath(`/import-jobs/${encodeURIComponent(importJobId)}/operations`));
    return directList(body, "import operation list", (item) => webImportOperationFrom(item, importJobId));
  }

  async getMockManagedResources(projectId: string): Promise<readonly RelayMockManagedResource[]> {
    const body = await this.request(this.workspacePath(`/projects/${encodeURIComponent(projectId)}/managed-resources`));
    return directList(body, "Mock resource list", (item) => {
      const row = object(item, "Mock resource");
      return { id: string(row, "id", "Mock resource"),
        canonicalRoot: string(row, "canonical_root", "Mock resource"),
        status: string(row, "status", "Mock resource") };
    });
  }

  async getRun(runId: string): Promise<RelayRun> {
    return runFrom(await this.request(this.workspacePath(`/runs/${encodeURIComponent(runId)}`)));
  }

  async getRunDraftPreview(runId: string): Promise<RelayRunDraftPreview> {
    const row = object(await this.request(this.workspacePath(`/runs/${encodeURIComponent(runId)}/draft-preview`)),
      "Run DRAFT preview");
    if (string(row, "run_id", "Run DRAFT preview") !== runId) {
      throw new RelayTransportError("Run 草稿预览与当前执行记录不匹配。");
    }
    const epoch = nullableString(row, "attempt_claim_epoch", "Run DRAFT preview");
    if (epoch !== null && !/^\d+$/u.test(epoch)) throw new RelayTransportError("Run 草稿轮次序号无效。");
    const available = boolean(row, "preview_available", "Run DRAFT preview");
    const stepAttemptId = nullableString(row, "step_attempt_id", "Run DRAFT preview");
    const modelCallId = nullableString(row, "model_call_id", "Run DRAFT preview");
    const previewText = nullableString(row, "preview_text", "Run DRAFT preview");
    if (available && (stepAttemptId === null || epoch === null) || previewText !== null && modelCallId === null) {
      throw new RelayTransportError("Run 草稿预览缺少当前轮次身份。");
    }
    return { runId, runStatus: string(row, "run_status", "Run DRAFT preview"),
      stepAttemptId, attemptClaimEpoch: epoch, modelCallId,
      previewRevision: decimal(row, "preview_revision", "Run DRAFT preview"),
      previewText, previewTruncated: boolean(row, "preview_truncated", "Run DRAFT preview"),
      previewAvailable: available };
  }

  async getRunTrace(runId: string): Promise<RelayRunTrace> {
    return runTraceFrom(await this.request(this.workspacePath(`/runs/${encodeURIComponent(runId)}/trace`)));
  }

  async getRunGatewayOperations(runId: string): Promise<readonly RelayRunGatewayOperation[]> {
    const body = await this.request(this.workspacePath(`/runs/${encodeURIComponent(runId)}/operations`));
    return directList(body, "Run operation list", (item) => {
      const row = object(item, "Run operation");
      const operationId = string(row, "id", "Run operation");
      const invocations = array(row, "invocations", "Run operation").map((invocation) => {
        const record = object(invocation, "Run invocation");
        const invocationId = optionalString(record, "id");
        return { id: invocationId, status: string(record, "status", "Run invocation"),
          createdAt: optionalString(record, "created_at"),
          resolvedAt: record.resolved_at === undefined || record.resolved_at === null
            ? null : string(record, "resolved_at", "Run invocation"),
          commandOutput: commandOutputFrom(record.result_ref, invocationId, operationId) };
      });
      return { id: operationId, status: string(row, "status", "Run operation"),
        actionType: string(row, "action_type", "Run operation"),
        normalizedTarget: string(row, "normalized_target", "Run operation"),
        invocationStatuses: invocations.map((invocation) => invocation.status),
        invocations };
    });
  }

  async getFileWriteChangeSets(operationId: string): Promise<readonly RelayFileWriteChangeSet[]> {
    const body = await this.request(this.workspacePath(`/operations/${encodeURIComponent(operationId)}/change-sets`));
    const row = object(body, "FILE_WRITE ledger response");
    if (string(row, "operation_id", "FILE_WRITE ledger response") !== operationId) throw new Error("逐文件账本与原动作不匹配。");
    return array(row, "change_sets", "FILE_WRITE ledger response").map((item) => {
      const ledger = object(item, "FILE_WRITE ledger");
      return { id: string(ledger, "id", "FILE_WRITE ledger"),
        invocationId: string(ledger, "invocation_id", "FILE_WRITE ledger"),
        status: string(ledger, "status", "FILE_WRITE ledger"),
        files: array(ledger, "files", "FILE_WRITE ledger").map((entry) => {
          const file = object(entry, "FILE_WRITE ledger file");
          return { relativePath: string(file, "relative_path", "FILE_WRITE ledger file"),
            action: string(file, "action", "FILE_WRITE ledger file"),
            status: string(file, "status", "FILE_WRITE ledger file"),
            error: nullableString(file, "error", "FILE_WRITE ledger file") };
        }) };
    });
  }

  async getFileWriteFrozenDiff(operationId: string): Promise<RelayFileWriteFrozenDiff> {
    const row = object(await this.request(this.workspacePath(`/operations/${encodeURIComponent(operationId)}/file-write-diff`)),
      "FILE_WRITE frozen diff");
    if (string(row, "operation_id", "FILE_WRITE frozen diff") !== operationId ||
        string(row, "basis", "FILE_WRITE frozen diff") !== "FROZEN_INTENT") {
      throw new Error("冻结文本差异与原动作不匹配。");
    }
    return { operationId, basis: "FROZEN_INTENT",
      files: array(row, "files", "FILE_WRITE frozen diff").map((entry) => {
        const file = object(entry, "FILE_WRITE frozen diff file");
        const action = string(file, "action", "FILE_WRITE frozen diff file");
        const availability = string(file, "availability", "FILE_WRITE frozen diff file");
        if (!["CREATE", "MODIFY", "DELETE"].includes(action) ||
            !["AVAILABLE", "UNAVAILABLE"].includes(availability)) {
          throw new Error("冻结文本差异状态无效。");
        }
        const beforeText = nullableString(file, "before_text", "FILE_WRITE frozen diff file");
        const afterText = nullableString(file, "after_text", "FILE_WRITE frozen diff file");
        if (availability === "AVAILABLE" && (beforeText === null || afterText === null)) {
          throw new Error("可用的冻结文本差异缺少正文。");
        }
        return { relativePath: string(file, "relative_path", "FILE_WRITE frozen diff file"),
          action: action as "CREATE" | "MODIFY" | "DELETE",
          baselineSha256: nullableString(file, "baseline_sha256", "FILE_WRITE frozen diff file"),
          targetSha256: nullableString(file, "target_sha256", "FILE_WRITE frozen diff file"),
          availability: availability as "AVAILABLE" | "UNAVAILABLE",
          unavailableReason: nullableString(file, "unavailable_reason", "FILE_WRITE frozen diff file"),
          beforeText, afterText };
      }) };
  }

  async getFileWriteDispositionPreview(operationId: string): Promise<RelayFileWriteDispositionPreview> {
    const row = object(await this.request(this.workspacePath(`/operations/${encodeURIComponent(operationId)}/file-write-disposition`)),
      "FILE_WRITE disposition");
    const parseMode = (value: unknown): "PARTIAL_LEDGER" | "NO_RECEIPT" | null => {
      if (value === null || value === undefined) return null;
      if (value !== "PARTIAL_LEDGER" && value !== "NO_RECEIPT") throw new Error("文件处置观察类型无效。");
      return value;
    };
    const parseCandidates = (file: Record<string, unknown>, mode: string | null) =>
      mode === "NO_RECEIPT" ? array(file, "residual_candidates", "FILE_WRITE residuals").map((item) => {
        const candidate = object(item, "FILE_WRITE residual candidate");
        return { path: string(candidate, "path", "FILE_WRITE residual candidate"),
          id: nullableString(candidate, "id", "FILE_WRITE residual candidate"),
          sha256: nullableString(candidate, "sha256", "FILE_WRITE residual candidate"),
          status: string(candidate, "status", "FILE_WRITE residual candidate"),
          error: nullableString(candidate, "error", "FILE_WRITE residual candidate") };
      }) : [];
    const dispositionValue = row.disposition;
    const disposition = dispositionValue === null ? null : (() => {
      const record = object(dispositionValue, "FILE_WRITE disposition decision");
      const observation = object(record.observation, "FILE_WRITE disposition observation");
      const observationMode = parseMode(observation.observation_mode);
      return { id: string(record, "id", "FILE_WRITE disposition decision"),
        decision: string(record, "decision", "FILE_WRITE disposition decision"),
        createdAt: string(record, "created_at", "FILE_WRITE disposition decision"),
        observationSha256: string(record, "observation_sha256", "FILE_WRITE disposition decision"),
        observationMode,
        observationFiles: array(observation, "files", "FILE_WRITE disposition observation").map((item) => {
          const file = object(item, "FILE_WRITE disposition observed file");
          return { path: string(file, "path", "FILE_WRITE disposition observed file"),
            currentSha256: nullableString(file, "current_sha256", "FILE_WRITE disposition observed file"),
            ledgerStatus: string(file, "ledger_status", "FILE_WRITE disposition observed file"),
            ledgerActualSha256: observationMode === "NO_RECEIPT" ? null
              : nullableString(file, "ledger_actual_sha256", "FILE_WRITE disposition observed file"),
            currentTargetId: observationMode === "NO_RECEIPT"
              ? nullableString(file, "current_target_id", "FILE_WRITE disposition observed file") : null,
            residualCandidates: parseCandidates(file, observationMode) };
        }) };
    })();
    const observationMode = parseMode(row.observation_mode);
    const preview: RelayFileWriteDispositionPreview = {
      operationId: string(row, "operation_id", "FILE_WRITE disposition"),
      invocationId: nullableString(row, "invocation_id", "FILE_WRITE disposition"),
      changeSetId: nullableString(row, "change_set_id", "FILE_WRITE disposition"),
      runId: string(row, "run_id", "FILE_WRITE disposition"),
      runRevision: decimal(row, "run_revision", "FILE_WRITE disposition"),
      taskRevision: decimal(row, "task_revision", "FILE_WRITE disposition"),
      operationStatus: string(row, "operation_status", "FILE_WRITE disposition"),
      stopProofRecorded: boolean(row, "stop_proof_recorded", "FILE_WRITE disposition"),
      canDispose: boolean(row, "can_dispose", "FILE_WRITE disposition"),
      blockingReasons: array(row, "blocking_reasons", "FILE_WRITE disposition").map((reason) => {
        if (typeof reason !== "string") throw new Error("阻断原因响应格式无效。");
        return reason;
      }),
      observationSha256: nullableString(row, "observation_sha256", "FILE_WRITE disposition"),
      observationMode,
      files: array(row, "files", "FILE_WRITE disposition").map((entry) => {
        const file = object(entry, "FILE_WRITE current file");
        return { relativePath: string(file, "relative_path", "FILE_WRITE current file"),
          ledgerStatus: string(file, "ledger_status", "FILE_WRITE current file"),
          ledgerActualSha256: nullableString(file, "ledger_actual_sha256", "FILE_WRITE current file"),
          currentSha256: nullableString(file, "current_sha256", "FILE_WRITE current file"),
          readable: boolean(file, "readable", "FILE_WRITE current file"),
          currentTargetId: observationMode === "NO_RECEIPT"
            ? nullableString(file, "current_target_id", "FILE_WRITE current file") : null,
          residualCandidates: parseCandidates(file, observationMode) };
      }), disposition
    };
    if (preview.operationId !== operationId) throw new Error("处置预览与原动作不匹配。");
    return preview;
  }

  async closePartialFileWrite(input: RelayClosePartialFileWriteInput): Promise<void> {
    const body = await this.request(this.workspacePath(`/operations/${encodeURIComponent(input.operationId)}/file-write-disposition`), {
      method: "POST", body: JSON.stringify({ command_id: input.commandId, invocation_id: input.invocationId,
        decision: "KEEP_CURRENT_AND_FAIL_RUN", expected_run_revision: input.expectedRunRevision,
        expected_task_revision: input.expectedTaskRevision,
        expected_observation_sha256: input.expectedObservationSha256 })
    }, 200);
    try {
      const receipt = commandEnvelopeFrom(body);
      if (receipt.commandId !== input.commandId ||
          string(receipt.result, "operation_id", "FILE_WRITE disposition result") !== input.operationId ||
          string(receipt.result, "invocation_id", "FILE_WRITE disposition result") !== input.invocationId ||
          string(receipt.result, "run_id", "FILE_WRITE disposition result") !== input.runId ||
          string(receipt.result, "run_status", "FILE_WRITE disposition result") !== "FAILED" ||
          string(receipt.result, "decision", "FILE_WRITE disposition result") !== "KEEP_CURRENT_AND_FAIL_RUN") {
        throw new Error("处置回执与原动作不匹配。");
      }
    } catch { throw new RelayTransportError("处置回执无法核对，请查询原 command_id。"); }
  }

  /** One authenticated SSE connection. The caller owns reconnects and authoritative GET refreshes. */
  async readRunEvents(
    runId: string, after: string, signal: AbortSignal,
    onEvent: (seq: string) => void, onOpen: () => void
  ): Promise<void> {
    if (!isRunEventCursor(after)) throw new Error("执行事件游标无效。");
    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}${this.workspacePath(`/runs/${encodeURIComponent(runId)}/events`)}?after=${after}`, {
        headers: { Accept: "text/event-stream", Authorization: `Bearer ${this.#bearerToken}` },
        cache: "no-store",
        signal
      });
    } catch {
      if (signal.aborted) return;
      throw new RelayTransportError("执行事件连接中断。");
    }
    if (signal.aborted) return;
    if (!response.ok) throw new RelayRunEventHttpError(response.status);
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream") || !response.body) {
      throw new RelayTransportError("服务端没有返回执行事件流。");
    }
    onOpen();
    await readRunEventHints(response.body, after, signal, onEvent);
  }

  async getRunContextManifests(runId: string): Promise<RelayContextManifestList> {
    const record = object(await this.request(this.workspacePath(`/runs/${encodeURIComponent(runId)}/context-manifests`)), "context manifest list");
    return {
      items: array(record, "items", "context manifest list").map((item) => contextManifestSummaryFrom(item, runId)),
      build: contextBuildFrom(record.build)
    };
  }

  async getRunContextManifest(runId: string, manifestId: string): Promise<RelayContextManifestDetail> {
    const body = await this.request(this.workspacePath(`/runs/${encodeURIComponent(runId)}/context-manifests/${encodeURIComponent(manifestId)}`));
    return contextManifestDetailFrom(body, runId, manifestId);
  }

  async getRunReviews(runId: string): Promise<readonly RelayReview[]> {
    const body = await this.request(this.workspacePath(`/runs/${encodeURIComponent(runId)}/reviews`));
    return array(object(body, "run reviews"), "items", "run reviews").map(reviewFrom);
  }

  async getControlRequest(runId: string, requestId: string): Promise<RelayControlRequest> {
    const body = await this.request(this.workspacePath(`/runs/${encodeURIComponent(runId)}/control-requests/${encodeURIComponent(requestId)}`));
    return controlRequestFrom(body);
  }

  async requestRunControl(input: {
    readonly runId: string;
    readonly commandId: string;
    readonly expectedTaskRevision: DecimalRevision;
    readonly expectedRunRevision: DecimalRevision;
    readonly type: RelayControlType;
  }): Promise<RelayControlSubmission> {
    const body = await this.request(this.workspacePath(`/runs/${encodeURIComponent(input.runId)}/control-requests`), {
      method: "POST",
      body: JSON.stringify({
        command_id: input.commandId,
        expected_task_revision: input.expectedTaskRevision,
        expected_run_revision: input.expectedRunRevision,
        type: input.type
      })
    }, 202);
    try {
      const envelope = commandEnvelopeFrom(body);
      const result = controlSubmissionFrom(envelope.result);
      if (envelope.commandId !== input.commandId || result.runId !== input.runId || result.type !== input.type) {
        throw new Error("控制回执与提交的命令不匹配。");
      }
      return result;
    } catch {
      throw new RelayTransportError("控制回执无法核对，请查询原 command_id。");
    }
  }

  async resumeRun(input: {
    readonly runId: string;
    readonly commandId: string;
    readonly expectedTaskRevision: DecimalRevision;
    readonly expectedRunRevision: DecimalRevision;
  }): Promise<RelayResumeSubmission> {
    const body = await this.request(this.workspacePath(`/runs/${encodeURIComponent(input.runId)}/resume`), {
      method: "POST",
      body: JSON.stringify({
        command_id: input.commandId,
        expected_task_revision: input.expectedTaskRevision,
        expected_run_revision: input.expectedRunRevision
      })
    }, 202);
    try {
      const envelope = commandEnvelopeFrom(body);
      const result = {
        runId: string(envelope.result, "run_id", "resume result"),
        status: string(envelope.result, "status", "resume result"),
        runRevision: decimal(envelope.result, "run_revision", "resume result")
      };
      if (envelope.commandId !== input.commandId || result.runId !== input.runId) {
        throw new Error("恢复回执与提交的命令不匹配。");
      }
      return result;
    } catch {
      throw new RelayTransportError("恢复回执无法核对，请查询原 command_id。");
    }
  }

  async decideReview(input: {
    readonly reviewId: string;
    readonly commandId: string;
    readonly expectedRevision: DecimalRevision;
    readonly targetHash: string;
    readonly decision: RelayReviewDecision;
    readonly feedback?: string;
    readonly retryBudget?: number;
  }): Promise<RelayCommandEnvelope> {
    const body = await this.request(this.workspacePath(`/reviews/${encodeURIComponent(input.reviewId)}/decisions`), {
      method: "POST",
      body: JSON.stringify({
        command_id: input.commandId,
        expected_revision: input.expectedRevision,
        target_hash: input.targetHash,
        decision: input.decision,
        ...(input.feedback === undefined ? {} : { feedback: input.feedback }),
        ...(input.retryBudget === undefined ? {} : { retry_budget: input.retryBudget })
      })
    });
    try {
      const envelope = commandEnvelopeFrom(body);
      const result = envelope.result;
      if (envelope.commandId !== input.commandId || result.review_id !== input.reviewId ||
          result.decision !== input.decision || typeof result.decision_id !== "string" ||
          typeof result.revision !== "string" || !/^\d+$/.test(result.revision)) throw new Error("Review 回执与决定不匹配。");
      return envelope;
    } catch {
      throw new RelayTransportError("Review 决定回执无法核对，请查询原 command_id。");
    }
  }

  async createArtifactWithVersion(input: {
    readonly taskId: string;
    readonly commandId: string;
    readonly expectedTaskRevision: DecimalRevision;
    readonly title: string;
    readonly mediaType: string;
    readonly content: string;
  }): Promise<RelayArtifactVersionResult> {
    const body = await this.request(this.workspacePath(`/tasks/${encodeURIComponent(input.taskId)}/artifacts`), {
      method: "POST",
      body: JSON.stringify({
        command_id: input.commandId,
        expected_task_revision: input.expectedTaskRevision,
        title: input.title,
        media_type: input.mediaType,
        content: input.content
      })
    });
    return artifactVersionResultFrom(commandEnvelopeFrom(body).result);
  }

  async submitArtifactVersion(input: {
    readonly artifactId: string;
    readonly commandId: string;
    readonly expectedArtifactRevision: DecimalRevision;
    readonly expectedTaskRevision: DecimalRevision;
    readonly mediaType: string;
    readonly content: string;
  }): Promise<RelayArtifactVersionResult> {
    const body = await this.request(
      this.workspacePath(`/artifacts/${encodeURIComponent(input.artifactId)}/versions`),
      {
        method: "POST",
        body: JSON.stringify({
          command_id: input.commandId,
          expected_artifact_revision: input.expectedArtifactRevision,
          expected_task_revision: input.expectedTaskRevision,
          media_type: input.mediaType,
          content: input.content
        })
      }
    );
    return artifactVersionResultFrom(commandEnvelopeFrom(body).result);
  }

  async getArtifact(artifactId: string): Promise<RelayArtifact> {
    return artifactFrom(await this.request(this.workspacePath(`/artifacts/${encodeURIComponent(artifactId)}`)));
  }

  async getTaskArtifacts(taskId: string): Promise<RelayTaskArtifacts> {
    const record = object(await this.request(this.workspacePath(`/tasks/${encodeURIComponent(taskId)}/artifacts`)), "task artifacts");
    return {
      items: array(record, "items", "task artifacts").map(artifactFrom),
      currentAcceptedVersionIds: stringArray(record, "current_accepted_version_ids", "task artifacts")
    };
  }

  /** 正文接口返回 text/markdown 本身而不是 JSON，因此单独走文本读取。 */
  async getArtifactVersionContent(artifactVersionId: string): Promise<string> {
    return this.requestText(
      this.workspacePath(`/artifact-versions/${encodeURIComponent(artifactVersionId)}/content`)
    );
  }

  async getArtifactLineage(artifactVersionId: string): Promise<RelayArtifactLineage> {
    return artifactLineageFrom(await this.request(this.workspacePath(`/artifact-versions/${encodeURIComponent(artifactVersionId)}/lineage`)));
  }

  async getArtifactDirectUses(artifactVersionId: string): Promise<RelayArtifactDirectUses> {
    return artifactDirectUsesFrom(await this.request(this.workspacePath(`/artifact-versions/${encodeURIComponent(artifactVersionId)}/direct-uses`)));
  }

  async getArtifactTextLocks(artifactId: string): Promise<readonly RelayArtifactTextLock[]> {
    const row = object(await this.request(this.workspacePath(`/artifacts/${encodeURIComponent(artifactId)}/text-locks`)), "artifact text locks");
    if (string(row, "artifact_id", "artifact text locks") !== artifactId) throw new Error("锁定列表目标不匹配。");
    return array(row, "locks", "artifact text locks").map(artifactTextLockFrom);
  }

  async lockArtifactText(input: { readonly artifactId: string; readonly commandId: string;
    readonly expectedArtifactRevision: DecimalRevision; readonly expectedVersionId: string;
    readonly blockKind: "PARAGRAPH" | "SECTION"; readonly blockIndex: number }):
    Promise<{ readonly artifactRevision: DecimalRevision; readonly lock: RelayArtifactTextLock }> {
    const row = object(commandEnvelopeFrom(await this.request(this.workspacePath(`/artifacts/${encodeURIComponent(input.artifactId)}/text-locks`), {
      method: "POST", body: JSON.stringify({ command_id: input.commandId,
        expected_artifact_revision: input.expectedArtifactRevision,
        expected_version_id: input.expectedVersionId, block_kind: input.blockKind,
        block_index: input.blockIndex }) })).result, "lock artifact text");
    if (string(row, "artifact_id", "lock artifact text") !== input.artifactId) throw new Error("锁定回执目标不匹配。");
    return { artifactRevision: decimal(row, "artifact_revision", "lock artifact text"),
      lock: artifactTextLockFrom(row.lock) };
  }

  async unlockArtifactText(input: { readonly artifactId: string; readonly lockId: string;
    readonly commandId: string; readonly expectedArtifactRevision: DecimalRevision }): Promise<DecimalRevision> {
    const row = object(commandEnvelopeFrom(await this.request(this.workspacePath(`/artifacts/${encodeURIComponent(input.artifactId)}/text-locks/${encodeURIComponent(input.lockId)}/unlock`), {
      method: "POST", body: JSON.stringify({ command_id: input.commandId,
        expected_artifact_revision: input.expectedArtifactRevision }) })).result, "unlock artifact text");
    if (string(row, "artifact_id", "unlock artifact text") !== input.artifactId ||
        string(row, "unlocked_lock_id", "unlock artifact text") !== input.lockId)
      throw new Error("解锁回执目标不匹配。");
    return decimal(row, "artifact_revision", "unlock artifact text");
  }

  async startArtifactImpactCheck(input: { readonly beforeVersionId: string;
    readonly afterVersionId: string; readonly expectedArtifactRevision: DecimalRevision;
    readonly analysisTargetVersionIds: readonly string[]; readonly commandId: string }): Promise<string> {
    const row = object(commandEnvelopeFrom(await this.request(this.workspacePath(`/artifact-versions/${encodeURIComponent(input.beforeVersionId)}/impact-checks`), {
      method: "POST", body: JSON.stringify({ command_id: input.commandId,
        source_after_version_id: input.afterVersionId,
        expected_artifact_revision: input.expectedArtifactRevision,
        analysis_target_version_ids: input.analysisTargetVersionIds }) })).result, "impact check request");
    return string(row, "impact_check_id", "impact check request");
  }

  async getArtifactImpactCheck(id: string): Promise<RelayArtifactImpactCheck> {
    return impactCheckFrom(await this.request(this.workspacePath(`/impact-checks/${encodeURIComponent(id)}`)));
  }

  async startArtifactImpactCandidate(input: { readonly checkId: string;
    readonly targetVersionId: string; readonly expectedTargetRevision: DecimalRevision;
    readonly confirmedPossible: boolean; readonly commandId: string }): Promise<string> {
    const row = object(commandEnvelopeFrom(await this.request(this.workspacePath(`/impact-checks/${encodeURIComponent(input.checkId)}/candidates`), {
      method: "POST", body: JSON.stringify({ command_id: input.commandId,
        target_version_id: input.targetVersionId,
        expected_target_revision: input.expectedTargetRevision,
        confirmed_possible: input.confirmedPossible }) })).result, "impact candidate request");
    return string(row, "candidate_id", "impact candidate request");
  }

  async getArtifactImpactCandidate(id: string): Promise<RelayArtifactImpactCandidate> {
    return impactCandidateFrom(await this.request(this.workspacePath(`/impact-candidates/${encodeURIComponent(id)}`)));
  }

  async getInterventions(): Promise<readonly RelayInterventionItem[]> {
    const row = object(await this.request(this.workspacePath('/attention/interventions')), "interventions");
    return array(row, "items", "interventions").map(interventionFrom);
  }

  /** 模型端口只读状态：服务端保证不含密钥。 */
  async getModelPortStatus(): Promise<RelayModelPortStatus> {
    const row = object(await this.request(this.workspacePath('/model-port')), "model-port");
    const provider = string(row, "provider", "model-port");
    if (provider !== "fake" && provider !== "openai-compatible" && provider !== "invalid") {
      throw new Error("服务端返回了无法识别的模型端口状态。");
    }
    return { provider,
      configured: row.configured === true,
      model: row.model === null ? null : string(row, "model", "model-port"),
      baseUrl: row.base_url === null ? null : string(row, "base_url", "model-port") };
  }

  /** 最近一次模型验证与当前配置指纹匹配情况。 */
  async getModelPortVerification(): Promise<RelayModelVerificationState> {
    const row = object(await this.request(this.workspacePath("/model-port/verification")),
      "model-port verification");
    const fingerprint = row.current_config_fingerprint === null
      ? null : string(row, "current_config_fingerprint", "model-port verification");
    const last = row.last === null ? null : modelVerifyResultFrom(
      object(row.last, "model-port verification.last"));
    const worker = string(row, "worker_startup_validation", "model-port verification");
    if (worker !== "NOT_CONFIGURED" && worker !== "OK" && worker !== "FAILED") {
      throw new Error("服务端返回了无法识别的 Worker 启动校验状态。");
    }
    return { currentConfigFingerprint: fingerprint, last,
      matchesCurrentConfig: row.matches_current_config === true,
      workerStartupValidation: worker };
  }

  /** 触发一次连接/模型验证；结果由服务端写入 model_calls，不含密钥。 */
  async verifyModelPort(): Promise<RelayModelVerifyResult> {
    return modelVerifyResultFrom(object(await this.request(
      this.workspacePath("/model-port/verify"), { method: "POST" }), "model-port verify"));
  }

  async claimInterventionNotifications(): Promise<readonly RelayInterventionItem[]> {
    const row = object(await this.request(this.workspacePath('/attention/notifications/claim'),
      { method: 'POST' }), "claimed interventions");
    return array(row, "items", "claimed interventions").map(interventionFrom);
  }

  async settleInterventionNotification(item: RelayInterventionItem,
    status: "DISPATCHED" | "DENIED" | "FAILED"): Promise<void> {
    await this.request(this.workspacePath('/attention/notifications/settle'), { method: 'POST',
      body: JSON.stringify({ item_key: item.itemKey, change_key: item.changeKey, status }) });
  }

  async applyArtifactImpactCandidate(input: { readonly candidateId: string;
    readonly expectedTargetRevision: DecimalRevision; readonly commandId: string }): Promise<string> {
    const row = object(commandEnvelopeFrom(await this.request(this.workspacePath(`/impact-candidates/${encodeURIComponent(input.candidateId)}/apply`), {
      method: "POST", body: JSON.stringify({ command_id: input.commandId,
        expected_target_revision: input.expectedTargetRevision }) })).result, "apply impact candidate");
    return string(row, "version_id", "apply impact candidate");
  }

  async completeHumanTask(input: {
    readonly taskId: string;
    readonly commandId: string;
    readonly expectedRevision: DecimalRevision;
    readonly acceptanceRevision: DecimalRevision;
    readonly artifactVersionIds: readonly string[];
    readonly statement: string;
    readonly acceptedCriterionIds: readonly string[];
    readonly reason: string | null;
  }): Promise<RelayCompletion> {
    const body = await this.request(this.workspacePath(`/tasks/${encodeURIComponent(input.taskId)}/complete`), {
      method: "POST",
      body: JSON.stringify({
        command_id: input.commandId,
        expected_revision: input.expectedRevision,
        acceptance_revision: input.acceptanceRevision,
        ...(input.artifactVersionIds.length === 0 ? {} : { artifact_version_ids: [...input.artifactVersionIds] }),
        acceptance: {
          statement: input.statement,
          accepted_criterion_ids: [...input.acceptedCriterionIds],
          ...(input.reason === null ? {} : { reason: input.reason })
        }
      })
    });
    return completionFrom(commandEnvelopeFrom(body).result);
  }

  async reopenTask(input: {
    readonly taskId: string;
    readonly commandId: string;
    readonly expectedRevision: DecimalRevision;
    readonly reason: string;
  }): Promise<RelayReopen> {
    const body = await this.request(this.workspacePath(`/tasks/${encodeURIComponent(input.taskId)}/reopen`), {
      method: "POST",
      body: JSON.stringify({
        command_id: input.commandId,
        expected_revision: input.expectedRevision,
        reason: input.reason
      })
    });
    return reopenFrom(commandEnvelopeFrom(body).result);
  }

  async getProjectState(projectId: string): Promise<RelayProjectState> {
    return projectStateFrom(
      await this.request(this.workspacePath(`/projects/${encodeURIComponent(projectId)}/state`))
    );
  }

  /**
   * “选择要接受的版本”是 Project State 的类型化命令，不是 Task 字段。
   * 该 action 要求 source_ref（选择依据的来源引用），不能省略：服务端按 REQUIRED_INPUT_MISSING 拒绝。
   */
  async selectArtifactVersion(input: {
    readonly projectId: string;
    readonly commandId: string;
    readonly expectedRevision: DecimalRevision;
    readonly artifactVersionId: string;
    readonly sourceRef: string;
  }): Promise<RelayStateMutation> {
    const body = await this.request(
      this.workspacePath(`/projects/${encodeURIComponent(input.projectId)}/state-commands`),
      {
        method: "POST",
        body: JSON.stringify({
          command_id: input.commandId,
          expected_revision: input.expectedRevision,
          action: "SELECT_ARTIFACT_VERSION",
          artifact_version_id: input.artifactVersionId,
          source_ref: input.sourceRef
        })
      }
    );
    return stateMutationFrom(commandEnvelopeFrom(body).result);
  }

  private workspacePath(path: string): string {
    return `/api/v1/workspaces/${encodeURIComponent(this.#workspaceId)}${path}`;
  }

  private async request(path: string, init: RequestInit = {}, expectedStatus?: number): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.#bearerToken}`,
          ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...init.headers
        }
      });
    } catch (caught) {
      throw new RelayTransportError(caught instanceof Error ? caught.message : undefined);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      if (response.ok && init.method === "POST") {
        throw new RelayTransportError("命令响应内容未能读取，请查询原 command_id。");
      }
      body = null;
    }
    if (!response.ok) {
      const record = isRecord(body) ? body : {};
      const conflict = isRecord(record.conflict) ? record.conflict : {};
      throw new RelayApiError({
        status: response.status,
        code: optionalString(record, "code") ?? "HTTP_ERROR",
        detail: optionalString(record, "detail") ?? `服务端返回 HTTP ${response.status}。`,
        retryable: record.retryable === true,
        retryAction: optionalString(record, "retry_action"),
        fieldErrors: fieldErrorsFrom(record),
        expectedRevision: optionalString(conflict, "expected_revision"),
        actualRevision: optionalString(conflict, "actual_revision"),
        blockingReasons: Array.isArray(conflict.blocking_reasons)
          ? conflict.blocking_reasons.filter((reason): reason is string => typeof reason === "string") : []
      });
    }
    if (expectedStatus !== undefined && response.status !== expectedStatus) {
      throw new RelayTransportError(`命令响应为 HTTP ${response.status}，无法按预期核对回执。`);
    }
    return body;
  }

  /** 受授权下载返回正文本身；错误仍然是 application/problem+json。 */
  private async requestText(path: string): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}${path}`, {
        headers: { Accept: "text/markdown, text/plain", Authorization: `Bearer ${this.#bearerToken}` }
      });
    } catch (caught) {
      throw new RelayTransportError(caught instanceof Error ? caught.message : undefined);
    }

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const record = isRecord(body) ? body : {};
      throw new RelayApiError({
        status: response.status,
        code: optionalString(record, "code") ?? "HTTP_ERROR",
        detail: optionalString(record, "detail") ?? `服务端返回 HTTP ${response.status}。`,
        retryable: record.retryable === true,
        retryAction: optionalString(record, "retry_action"),
        fieldErrors: fieldErrorsFrom(record),
        expectedRevision: null,
        actualRevision: null
      });
    }

    return response.text();
  }
}

function fieldErrorsFrom(record: Record<string, unknown>): readonly RelayFieldError[] {
  const value = record.field_errors;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.field !== "string" || typeof item.message !== "string") {
      return [];
    }
    return [{ field: item.field, message: item.message }];
  });
}

export function createCommandId(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizeBaseUrl(value: string): string {
  const raw = requiredText(value, "API base URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("API base URL 必须是完整的 http 或 https 地址。");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("API base URL 只允许 http 或 https。");
  }
  if (url.search || url.hash) {
    throw new Error("API base URL 不应包含查询参数或片段。");
  }
  return url.toString().replace(/\/$/u, "");
}

function requiredText(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized === "") {
    throw new Error(`${name} 不能为空。`);
  }
  return normalized;
}

function reviewFrom(value: unknown): RelayReview {
  const record = object(value, "review");
  const kind = string(record, "kind", "review");
  const kinds: readonly RelayReviewKind[] = ["CRITERION", "RETRY_BUDGET", "CHECKER_RETRY", "ACTION_APPROVAL", "STATE_PROPOSAL"];
  if (!kinds.includes(kind as RelayReviewKind)) {
    throw new Error("review.kind 包含未知类型。");
  }
  const decisions: readonly RelayReviewDecision[] = ["ACCEPT", "REQUEST_CHANGES", "SET_RETRY_BUDGET", "RETRY_CHECKS", "APPROVE", "DENY"];
  const allowedDecisions = stringArray(record, "allowed_decisions", "review");
  if (allowedDecisions.some((decision) => !decisions.includes(decision as RelayReviewDecision))) {
    throw new Error("review.allowed_decisions 包含未知决定。");
  }
  return {
    id: string(record, "id", "review"),
    kind: kind as RelayReviewKind,
    status: string(record, "status", "review"),
    revision: decimal(record, "revision", "review"),
    projectId: nullableString(record, "project_id", "review"),
    taskId: nullableString(record, "task_id", "review"),
    runId: nullableString(record, "run_id", "review"),
    reason: string(record, "reason", "review"),
    targetHash: string(record, "target_hash", "review"),
    target: object(record.target, "review.target"),
    evidence: object(record.evidence, "review.evidence"),
    effect: object(record.effect, "review.effect"),
    allowedDecisions: allowedDecisions as readonly RelayReviewDecision[],
    expiresAt: nullableString(record, "expires_at", "review"),
    createdAt: string(record, "created_at", "review"),
    decidedAt: nullableString(record, "decided_at", "review")
  };
}

function controlType(record: Record<string, unknown>, name: string): RelayControlType {
  const value = string(record, "type", name);
  if (value !== "PAUSE" && value !== "CANCEL" && value !== "HANDOFF" && value !== "CANCEL_TASK") {
    throw new Error(`${name}.type 包含未知控制类型。`);
  }
  return value;
}

function controlSubmissionFrom(result: Readonly<Record<string, unknown>>): RelayControlSubmission {
  const status = string(result, "status", "control result");
  if (status !== "PENDING") {
    throw new Error("控制请求的提交回执不是 PENDING，请重新读取 Run 核对。");
  }
  return {
    controlRequestId: string(result, "control_request_id", "control result"),
    runId: string(result, "run_id", "control result"),
    taskId: string(result, "task_id", "control result"),
    type: controlType(result, "control result"),
    status,
    runRevision: decimal(result, "run_revision", "control result")
  };
}

export function delegateSubmissionFrom(result: Readonly<Record<string, unknown>>): RelayDelegateSubmission {
  const status = string(result, "status", "delegate result");
  if (status !== "CREATED") throw new Error("Delegate 回执状态无法识别。");
  return {
    runId: string(result, "run_id", "delegate result"),
    taskId: string(result, "task_id", "delegate result"),
    taskRevision: decimal(result, "task_revision", "delegate result"),
    runRevision: decimal(result, "run_revision", "delegate result"),
    status,
    retryOfRunId: nullableString(result, "retry_of_run_id", "delegate result")
  };
}

function controlRequestFrom(value: unknown): RelayControlRequest {
  const record = object(value, "control request");
  return {
    id: string(record, "id", "control request"),
    runId: string(record, "run_id", "control request"),
    taskId: string(record, "task_id", "control request"),
    type: controlType(record, "control request"),
    status: string(record, "status", "control request"),
    revision: decimal(record, "revision", "control request"),
    requestedAt: string(record, "requested_at", "control request"),
    decidedAt: nullableString(record, "decided_at", "control request"),
    resultRef: record.result_ref === null ? null : object(record.result_ref, "control request.result_ref")
  };
}

function runFrom(value: unknown): RelayRun {
  const record = object(value, "run");
  const pending = record.pending_control_request === null
    ? null
    : object(record.pending_control_request, "run.pending_control_request");
  return {
    id: string(record, "id", "run"),
    taskId: string(record, "task_id", "run"),
    status: string(record, "status", "run"),
    revision: decimal(record, "revision", "run"),
    waitReason: nullableString(record, "wait_reason", "run"),
    currentStepId: nullableString(record, "current_step_id", "run"),
    steps: array(record, "steps", "run").map((item) => {
      const step = object(item, "run.steps item");
      return {
        id: string(step, "step_id", "run.steps item"),
        index: integer(step, "step_index", "run.steps item"),
        kind: string(step, "step_kind", "run.steps item"),
        status: string(step, "status", "run.steps item"),
        startedAt: nullableString(step, "started_at", "run.steps item"),
        finishedAt: nullableString(step, "finished_at", "run.steps item"),
        reason: stepReasonByKind(record, string(step, "step_kind", "run.steps item"))
      };
    }),
    recentAttempts: array(record, "recent_attempts", "run").map((item) => {
      const attempt = object(item, "run.recent_attempts item");
      return {
        id: string(attempt, "attempt_id", "run.recent_attempts item"),
        stepKind: string(attempt, "step_kind", "run.recent_attempts item"),
        number: decimal(attempt, "attempt_number", "run.recent_attempts item"),
        status: string(attempt, "status", "run.recent_attempts item")
      };
    }),
    blockingReviewIds: stringArray(record, "blocking_review_ids", "run"),
    pendingControlRequest: pending === null ? null : {
      id: string(pending, "id", "run.pending_control_request"),
      type: controlType(pending, "run.pending_control_request"),
      status: string(pending, "status", "run.pending_control_request"),
      requestedAt: string(pending, "requested_at", "run.pending_control_request")
    },
    unresolvedOperationIds: stringArray(record, "unresolved_operation_ids", "run")
  };
}

/**
 * 步骤失败原因：服务端 result_refs 按 step_kind 带出 result_ref.reason
 * （MODEL_BUDGET_EXHAUSTED、CONTEXT_REQUIRED_OVER_BUDGET 等）。同一步骤可能有多次
 * 尝试，取最后一条；服务端未给出 reason 时返回 null，不猜测。
 */
function stepReasonByKind(record: Record<string, unknown>, stepKind: string): string | null {
  const refs = record.result_refs;
  if (!Array.isArray(refs)) return null;
  let reason: string | null = null;
  for (const item of refs) {
    if (typeof item !== "object" || item === null) continue;
    const ref = item as { step_kind?: unknown; result_ref?: unknown };
    if (ref.step_kind !== stepKind) continue;
    if (typeof ref.result_ref !== "object" || ref.result_ref === null) continue;
    const value = (ref.result_ref as { reason?: unknown }).reason;
    if (typeof value === "string" && value !== "") reason = value;
  }
  return reason;
}

function availability(record: Record<string, unknown>, key: string, name: string): "AVAILABLE" | "UNAVAILABLE" {
  const value = string(record, key, name);
  if (value !== "AVAILABLE" && value !== "UNAVAILABLE") throw new Error(`${name}.${key} 响应格式无效。`);
  return value;
}

function runTraceFrom(value: unknown): RelayRunTrace {
  const row = object(value, "run trace");
  return { runId: string(row, "run_id", "run trace"), taskId: string(row, "task_id", "run trace"),
    projectId: nullableString(row, "project_id", "run trace"), status: string(row, "status", "run trace"),
    steps: array(row, "steps", "run trace").map((value) => { const step = object(value, "trace step");
      return { id: string(step, "id", "trace step"), index: integer(step, "step_index", "trace step"),
        kind: string(step, "kind", "trace step"), status: string(step, "status", "trace step"),
        revision: decimal(step, "revision", "trace step"), resultAvailable: boolean(step, "result_available", "trace step"),
        startedAt: nullableString(step, "started_at", "trace step"), finishedAt: nullableString(step, "finished_at", "trace step") }; }),
    attempts: array(row, "attempts", "run trace").map((value) => { const attempt = object(value, "trace attempt");
      return { id: string(attempt, "id", "trace attempt"), stepId: string(attempt, "step_id", "trace attempt"),
        number: decimal(attempt, "attempt_number", "trace attempt"), status: string(attempt, "status", "trace attempt"),
        claimEpoch: decimal(attempt, "claim_epoch", "trace attempt"), resultAvailable: boolean(attempt, "result_available", "trace attempt"),
        startedAt: nullableString(attempt, "started_at", "trace attempt"), finishedAt: nullableString(attempt, "finished_at", "trace attempt") }; }),
    modelCalls: array(row, "model_calls", "run trace").map((value) => { const call = object(value, "trace model call");
      const status = string(call, "status", "trace model call");
      const providerErrorKind = call.provider_error_kind ?? null;
      if (providerErrorKind !== null && (status !== "FAILED" ||
          providerErrorKind !== "AUTH" && providerErrorKind !== "RATE_LIMIT" &&
          providerErrorKind !== "TIMEOUT" && providerErrorKind !== "STREAM_BROKEN" &&
          providerErrorKind !== "PROTOCOL" && providerErrorKind !== "NETWORK")) {
        throw new Error("Trace 模型调用 Provider 失败类别无效。");
      }
      return { id: string(call, "id", "trace model call"), stepAttemptId: nullableString(call, "step_attempt_id", "trace model call"),
        manifestId: nullableString(call, "manifest_id", "trace model call"), status,
        kind: optionalString(call, "kind"), criterionId: optionalString(call, "criterion_id"),
        checkAttempt: call.check_attempt === undefined ? null : nullableInteger(call, "check_attempt", "trace model call"),
        providerErrorKind, providerRequestId: optionalString(call, "provider_request_id"),
        provider: string(call, "provider", "trace model call"), model: string(call, "model", "trace model call"),
        inputSha256: nullableString(call, "input_sha256", "trace model call"),
        readOperationId: nullableString(call, "read_operation_id", "trace model call"),
        readInvocationId: nullableString(call, "read_invocation_id", "trace model call"),
        inputTokens: nullableInteger(call, "usage_input_tokens", "trace model call"),
        outputTokens: nullableInteger(call, "usage_output_tokens", "trace model call"),
        startedAt: string(call, "started_at", "trace model call"), settledAt: nullableString(call, "settled_at", "trace model call"),
        firstTextDeltaAt: optionalString(call, "first_text_delta_at"),
        firstPreviewPersistedAt: optionalString(call, "first_preview_persisted_at") }; }),
    manifests: array(row, "manifests", "run trace").map((value) => { const manifest = object(value, "trace manifest");
      return { id: string(manifest, "id", "trace manifest"), stepId: nullableString(manifest, "step_id", "trace manifest"),
        builderVersion: string(manifest, "builder_version", "trace manifest"), sha256: string(manifest, "sha256", "trace manifest"),
        createdAt: string(manifest, "created_at", "trace manifest"),
        sources: array(manifest, "sources", "trace manifest").map((value) => { const source = object(value, "trace source");
          return { kind: string(source, "kind", "trace source"), sourceRef: nullableString(source, "source_ref", "trace source"),
            version: nullableString(source, "version", "trace source"), sha256: nullableString(source, "sha256", "trace source"),
            sourceSha256: nullableString(source, "source_sha256", "trace source"), role: string(source, "role", "trace source"),
            trust: string(source, "trust", "trace source"), availability: availability(source, "availability", "trace source") }; }) }; }),
    verifications: array(row, "verifications", "run trace").map((value) => { const session = object(value, "trace verification");
      return { id: string(session, "id", "trace verification"), status: string(session, "status", "trace verification"),
        verdict: nullableString(session, "verdict", "trace verification"),
        acceptanceRevision: decimal(session, "acceptance_revision", "trace verification"),
        checkPlanHash: string(session, "check_plan_hash", "trace verification"),
        parentSessionId: nullableString(session, "parent_session_id", "trace verification"),
        targets: array(session, "targets", "trace verification").map((value) => { const target = object(value, "trace verification target");
          return { artifactVersionId: string(target, "artifact_version_id", "trace verification target"),
            contentSha256: string(target, "content_sha256", "trace verification target") }; }),
        checks: array(session, "checks", "trace verification").map((value) => { const check = object(value, "trace check");
          return { id: string(check, "id", "trace check"), criterionId: string(check, "criterion_id", "trace check"),
            result: string(check, "result", "trace check"), severity: string(check, "severity", "trace check"),
            required: boolean(check, "required", "trace check"), createdAt: string(check, "created_at", "trace check") }; }),
        createdAt: string(session, "created_at", "trace verification"),
        finalizedAt: nullableString(session, "finalized_at", "trace verification") }; }),
    reviews: array(row, "reviews", "run trace").map((value) => { const review = object(value, "trace review");
      const decision = review.decision === null ? null : object(review.decision, "trace review decision");
      return { id: string(review, "id", "trace review"), kind: string(review, "kind", "trace review"),
        status: string(review, "status", "trace review"), operationId: nullableString(review, "operation_id", "trace review"),
        verificationSessionId: nullableString(review, "verification_session_id", "trace review"),
        targetHash: string(review, "target_hash", "trace review"), createdAt: string(review, "created_at", "trace review"),
        decidedAt: nullableString(review, "decided_at", "trace review"),
        decision: decision === null ? null : { id: string(decision, "id", "trace review decision"),
          value: string(decision, "value", "trace review decision"), decidedAt: string(decision, "decided_at", "trace review decision") } }; }),
    operations: array(row, "operations", "run trace").map((value) => { const operation = object(value, "trace operation");
      return { id: string(operation, "id", "trace operation"), stepId: nullableString(operation, "step_id", "trace operation"),
        capability: string(operation, "capability", "trace operation"), actionType: string(operation, "action_type", "trace operation"),
        status: string(operation, "status", "trace operation"), paramsSha256: string(operation, "params_sha256", "trace operation"),
        resultAvailable: boolean(operation, "result_available", "trace operation"),
        createdAt: string(operation, "created_at", "trace operation"), updatedAt: string(operation, "updated_at", "trace operation"),
        invocations: array(operation, "invocations", "trace operation").map((value) => { const invocation = object(value, "trace invocation");
          return { id: string(invocation, "id", "trace invocation"), number: decimal(invocation, "attempt_number", "trace invocation"),
            status: string(invocation, "status", "trace invocation"), resultAvailable: boolean(invocation, "result_available", "trace invocation"),
            createdAt: string(invocation, "created_at", "trace invocation"), resolvedAt: nullableString(invocation, "resolved_at", "trace invocation") }; }) }; }),
    effects: array(row, "effects", "run trace").map((value) => { const effect = object(value, "trace effect");
      return { id: string(effect, "id", "trace effect"), stepId: string(effect, "step_id", "trace effect"),
        status: string(effect, "status", "trace effect"), paramsSha256: string(effect, "params_sha256", "trace effect"),
        resultAvailable: boolean(effect, "result_available", "trace effect"),
        createdAt: string(effect, "created_at", "trace effect"), resolvedAt: nullableString(effect, "resolved_at", "trace effect") }; }) };
}

function contextManifestSummaryFrom(value: unknown, runId: string): RelayContextManifestSummary {
  const row = object(value, "context manifest");
  const actualRunId = string(row, "run_id", "context manifest");
  if (actualRunId !== runId) throw new Error("Context Manifest 与当前 Run 不匹配。");
  return {
    id: string(row, "id", "context manifest"), runId: actualRunId,
    stepId: nullableString(row, "step_id", "context manifest"),
    createdAt: string(row, "created_at", "context manifest"),
    builderVersion: string(row, "builder_version", "context manifest"),
    templateVersion: string(row, "template_version", "context manifest"),
    manifestHash: string(row, "manifest_hash", "context manifest")
  };
}

function contextBuildFrom(value: unknown): RelayContextBuild {
  const row = object(value, "context build");
  const status = string(row, "status", "context build");
  if (!["NOT_STARTED", "RUNNING", "SUCCEEDED", "FAILED"].includes(status)) {
    throw new Error("context build.status 响应格式无效。");
  }
  return {
    status: status as RelayContextBuild["status"],
    reasonCode: nullableString(row, "reason_code", "context build"),
    message: nullableString(row, "message", "context build")
  };
}

function contextManifestDetailFrom(value: unknown, runId: string, manifestId: string): RelayContextManifestDetail {
  const row = object(value, "context manifest detail");
  const summary = contextManifestSummaryFrom(row, runId);
  if (summary.id !== manifestId) throw new Error("Context Manifest 详情与所选记录不匹配。");
  const rawBudget = row.budget === null ? null : object(row.budget, "context manifest budget");
  const dependencies = object(row.dependencies, "context manifest dependencies");
  const parseDefinition = (value: unknown, name: string) => {
    if (value === undefined || value === null) return null;
    const definition = object(value, name);
    return { id: string(definition, "id", name), version: string(definition, "version", name),
      digest: string(definition, "digest", name) };
  };
  return {
    ...summary,
    budget: rawBudget === null ? null : {
      limitTokens: integer(rawBudget, "limit_tokens", "context manifest budget"),
      reservedTokens: integer(rawBudget, "reserved_tokens", "context manifest budget"),
      requiredTokens: nullableInteger(rawBudget, "required_tokens", "context manifest budget"),
      selectedTokens: nullableInteger(rawBudget, "selected_tokens", "context manifest budget"),
      estimation: string(rawBudget, "estimation", "context manifest budget")
    },
    dependencies: {
      contractHash: optionalString(dependencies, "contract_hash"),
      workflowVersion: optionalString(dependencies, "workflow_version"),
      executionConfigVersion: optionalString(dependencies, "execution_config_version"),
      profile: parseDefinition(dependencies.profile, "context manifest profile"),
      skill: parseDefinition(dependencies.skill, "context manifest skill")
    },
    sources: array(row, "sources", "context manifest detail").map((item) => {
      const source = object(item, "context source");
      const range = object(source.range, "context source range");
      const role = string(source, "role", "context source");
      const trust = string(source, "trust", "context source");
      const selectionReason = optionalString(source, "selection_reason");
      if (!["MANDATORY", "RELEVANT", "STEP_SPECIFIC"].includes(role) ||
        !["CANONICAL", "UNTRUSTED_DATA"].includes(trust) || range.unit !== "UTF8_BYTE" ||
        (selectionReason !== null && !["TITLE_MATCH", "RECENT_SCOPE_FALLBACK"].includes(selectionReason))) {
        throw new Error("Context 来源类别或范围单位无效。");
      }
      return {
        kind: string(source, "kind", "context source"),
        sourceRef: string(source, "source_ref", "context source"),
        version: string(source, "version", "context source"),
        sha256: string(source, "sha256", "context source"),
        sourceSha256: string(source, "source_sha256", "context source"),
        range: { start: integer(range, "start", "context source range"),
          end: integer(range, "end", "context source range"), unit: "UTF8_BYTE" as const },
        content: string(source, "content", "context source"),
        role: role as RelayContextManifestDetail["sources"][number]["role"],
        trust: trust as RelayContextManifestDetail["sources"][number]["trust"],
        selectionReason: selectionReason as RelayContextManifestDetail["sources"][number]["selectionReason"]
      };
    }),
    exclusions: array(row, "exclusions", "context manifest detail").map((item) => {
      const exclusion = object(item, "context exclusion");
      const reason = string(exclusion, "reason", "context exclusion");
      if (reason !== "BUDGET_TRIMMED" && reason !== "SOURCE_UNAVAILABLE") {
        throw new Error("Context 排除原因无效。");
      }
      return { sourceRef: string(exclusion, "source_ref", "context exclusion"), reason };
    })
  };
}

function projectFrom(value: unknown): RelayProject {
  const record = object(value, "project");
  return {
    id: string(record, "id", "project"),
    title: string(record, "title", "project"),
    projectType: string(record, "project_type", "project"),
    revision: decimal(record, "revision", "project"),
    stateRevision: decimal(record, "state_revision", "project"),
    archivedAt: nullableString(record, "archived_at", "project")
  };
}

function projectListItemFrom(value: unknown): RelayProjectListItem {
  const record = object(value, "project list item");
  const archiveStatus = string(record, "archive_status", "project list item");
  const archivedAt = nullableString(record, "archived_at", "project list item");
  if (archiveStatus !== "ACTIVE" && archiveStatus !== "ARCHIVED" ||
    (archiveStatus === "ACTIVE") !== (archivedAt === null)) {
    throw new Error("项目归档状态响应格式无效。");
  }
  return { ...projectFrom(record), archiveStatus, archivedAt,
    phaseKey: string(record, "phase_key", "project list item"),
    nextActionTaskId: nullableString(record, "next_action_task_id", "project list item"),
    createdAt: string(record, "created_at", "project list item"),
    updatedAt: string(record, "updated_at", "project list item") };
}

export function projectArchiveResultFrom(value: unknown): RelayProjectArchiveResult {
  const record = object(value, "archive project result");
  if (string(record, "archive_status", "archive project result") !== "ARCHIVED") {
    throw new Error("项目归档回执状态无效。");
  }
  return { projectId: string(record, "project_id", "archive project result"),
    revision: decimal(record, "revision", "archive project result"),
    archivedAt: string(record, "archived_at", "archive project result"),
    archiveStatus: "ARCHIVED" };
}

export function viewConfigurationFrom(value: unknown): RelayViewConfiguration {
  const record = object(value, "view configuration");
  const kind = string(record, "kind", "view configuration");
  if (kind !== "general" && kind !== "thesis" && kind !== "development") {
    throw new Error("view configuration.kind 响应格式无效。");
  }
  return {
    projectId: string(record, "project_id", "view configuration"),
    revision: decimal(record, "revision", "view configuration"), kind,
    templateVersion: string(record, "template_version", "view configuration"),
    templateSha256: string(record, "template_sha256", "view configuration"),
    pages: array(record, "pages", "view configuration").map((value) => {
      const page = object(value, "view configuration.page");
      const position = integer(page, "position", "view configuration.page");
      if (position < 0) throw new Error("view configuration.page.position 响应格式无效。");
      return { pageId: string(page, "page_id", "view configuration.page"),
        visible: boolean(page, "visible", "view configuration.page"), position };
    }),
    updatedAt: string(record, "updated_at", "view configuration")
  };
}

function continuationStateFrom(value: unknown, name: string): { readonly phaseKey: string;
  readonly revision: DecimalRevision; readonly nextActionTaskId: string | null } {
  const record = object(value, name);
  return { phaseKey: string(record, "phase_key", name),
    revision: decimal(record, "revision", name),
    nextActionTaskId: nullableString(record, "next_action_task_id", name) };
}

export function continuationPointSummaryFrom(value: unknown): RelayContinuationPointSummary {
  const record = object(value, "continuation point");
  return { id: string(record, "id", "continuation point"),
    projectId: string(record, "project_id", "continuation point"),
    name: string(record, "name", "continuation point"),
    note: nullableString(record, "note", "continuation point"),
    capturedAt: string(record, "captured_at", "continuation point"),
    capturedState: continuationStateFrom(record["captured_state"], "continuation point.captured_state"),
    refCount: integer(record, "ref_count", "continuation point") };
}

function continuationComparisonFrom(value: unknown): RelayContinuationComparison {
  const record = object(value, "continuation comparison");
  const facts = object(record["facts"], "continuation comparison.facts");
  return {
    continuationPoint: continuationPointSummaryFrom(record["continuation_point"]),
    currentState: continuationStateFrom(record["current_state"], "continuation comparison.current_state"),
    facts: {
      stateRevisionChanged: boolean(facts, "state_revision_changed", "continuation comparison.facts"),
      phaseChanged: boolean(facts, "phase_changed", "continuation comparison.facts"),
      nextActionChanged: boolean(facts, "next_action_changed", "continuation comparison.facts"),
      taskAdded: array(facts, "task_added", "continuation comparison.facts").map((item) => {
        const task = object(item, "continuation comparison.facts.task_added");
        return { taskId: string(task, "task_id", "continuation comparison.facts.task_added"),
          title: string(task, "title", "continuation comparison.facts.task_added"),
          status: string(task, "status", "continuation comparison.facts.task_added") as TaskStatus };
      }),
      artifactVersionAdded: array(facts, "artifact_version_added", "continuation comparison.facts")
        .map((item) => {
          const ref = object(item, "continuation comparison.facts.artifact_version_added");
          return { artifactVersionId: string(ref, "artifact_version_id",
              "continuation comparison.facts.artifact_version_added"),
            artifactId: string(ref, "artifact_id", "continuation comparison.facts.artifact_version_added"),
            versionNumber: decimal(ref, "version_number",
              "continuation comparison.facts.artifact_version_added") };
        })
    },
    refChanges: array(record, "ref_changes", "continuation comparison").map((item) => {
      const ref = object(item, "continuation comparison.ref_changes");
      return { refKind: string(ref, "ref_kind", "continuation comparison.ref_changes") as
          RelayContinuationRefKind,
        refId: string(ref, "ref_id", "continuation comparison.ref_changes"),
        capturedRevision: decimal(ref, "captured_revision", "continuation comparison.ref_changes"),
        change: string(ref, "change", "continuation comparison.ref_changes") as RelayContinuationRefChange,
        currentRevision: ref["current_revision"] === null ? null
          : decimal(ref, "current_revision", "continuation comparison.ref_changes"),
        note: nullableString(ref, "note", "continuation comparison.ref_changes") };
    }),
    interpretation: null
  };
}

function taskFrom(value: unknown): RelayTaskSummary {
  const record = object(value, "task");
  const executor = object(record.executor, "task.executor");
  return {
    id: string(record, "id", "task"),
    projectId: nullableString(record, "project_id", "task"),
    title: string(record, "title", "task"),
    status: taskStatus(record, "status", "task"),
    mode: interactionMode(record, "mode", "task"),
    revision: decimal(record, "revision", "task"),
    executor: executorKind(executor, "kind", "task.executor"),
    executorRunId: nullableString(executor, "run_id", "task.executor"),
    currentCompletionId: nullableString(record, "current_completion_id", "task"),
    waitingReason: nullableString(record, "waiting_reason", "task"),
    blockingTaskIds: stringArray(record, "blocking_task_ids", "task"),
    unresolvedBlockerIds: stringArray(record, "unresolved_blocker_ids", "task"),
    allowedActions: stringArray(record, "allowed_actions", "task"),
    updatedAt: optionalString(record, "updated_at")
  };
}

function acceptanceFrom(record: Record<string, unknown>): RelayTaskAcceptance {
  const expectedOutputs = record.expected_outputs === undefined ? null :
    object(record.expected_outputs, "task.acceptance.expected_outputs");
  return {
    acceptanceRevision: decimal(record, "acceptance_revision", "task.acceptance"),
    objective: string(record, "objective", "task.acceptance"),
    expectedOutputs,
    source: string(record, "source", "task.acceptance"),
    criteria: array(record, "criteria", "task.acceptance").map((item) => {
      const criterion = object(item, "task.acceptance.criteria");
      return {
        criterionId: string(criterion, "criterion_id", "criterion"),
        statement: string(criterion, "statement", "criterion"),
        required: criterion.required === true,
        method: string(criterion, "method", "criterion"),
        targetSpec: criterion.target_spec === undefined ? null
          : object(criterion.target_spec, "task.acceptance.criteria.target_spec")
      };
    })
  };
}

function taskCheckPlanPreviewFrom(value: unknown, taskId: string): RelayTaskCheckPlanPreview {
  const row = object(value, "check plan preview");
  const status = string(row, "status", "check plan preview");
  if (string(row, "task_id", "check plan preview") !== taskId ||
    (status !== "AVAILABLE" && status !== "UNAVAILABLE") ||
    typeof row.admission_available !== "boolean" || row.frozen_run_plan !== false ||
    row.executed !== false) throw new Error("CheckPlan 当前预览响应格式无效。");
  const sources = object(row.sources, "check plan sources");
  const rawPlan = row.check_plan === null ? null : object(row.check_plan, "check plan");
  const checkPlan = rawPlan === null ? null : {
    policyVersion: string(rawPlan, "policy_version", "check plan"),
    workflowKey: string(rawPlan, "workflow_key", "check plan"),
    workflowVersion: string(rawPlan, "workflow_version", "check plan"),
    entries: array(rawPlan, "entries", "check plan").map((value) => {
      const entry = object(value, "check plan entry");
      object(entry.target_spec, "check plan target spec");
      if (typeof entry.required !== "boolean") throw new Error("CheckPlan 条件格式无效。");
      return { criterionId: string(entry, "criterion_id", "check plan entry"),
        statement: string(entry, "statement", "check plan entry"), required: entry.required,
        method: string(entry, "method", "check plan entry"),
        severity: string(entry, "severity", "check plan entry"),
        checkerId: string(entry, "checker_id", "check plan entry"),
        checkerVersion: string(entry, "checker_version", "check plan entry") };
    }) };
  if ((status === "UNAVAILABLE" && (checkPlan !== null || row.check_plan_sha256 !== null)) ||
    (status === "AVAILABLE" && (checkPlan === null || typeof row.check_plan_sha256 !== "string"))) {
    throw new Error("CheckPlan 当前预览状态与内容不一致。");
  }
  return { taskId, status, admissionAvailable: row.admission_available,
    reasonCodes: stringList(row, "reason_codes", "check plan preview"),
    sources: { taskRevision: decimal(sources, "task_revision", "check plan sources"),
      acceptanceRevision: decimal(sources, "acceptance_revision", "check plan sources"),
      ruleRevision: sources.rule_revision === null ? null : decimal(sources, "rule_revision", "check plan sources"),
      workflowKey: string(sources, "workflow_key", "check plan sources"),
      workflowVersion: string(sources, "workflow_version", "check plan sources"),
      ruleRefs: array(sources, "rule_refs", "check plan sources").map((value) => {
        const ref = object(value, "check plan rule ref");
        return { ruleId: string(ref, "rule_id", "check plan rule ref"),
          version: decimal(ref, "version", "check plan rule ref") };
      }) }, checkPlan, checkPlanSha256: row.check_plan_sha256 === null ? null :
      string(row, "check_plan_sha256", "check plan preview"), frozenRunPlan: false, executed: false };
}

function dependencyFrom(value: unknown): RelayTaskDependency {
  const record = object(value, "task dependency");
  return {
    taskId: string(record, "task_id", "task dependency"),
    dependencyKind: string(record, "dependency_kind", "task dependency"),
    status: taskStatus(record, "status", "task dependency"),
    title: string(record, "title", "task dependency")
  };
}

function todayPriority(record: Record<string, unknown>, key: string, name: string): RelayTodayPriority | null {
  if (record[key] === null) return null;
  const value = string(record, key, name);
  if (value !== "LOW" && value !== "NORMAL" && value !== "HIGH") throw new Error(`${name}.${key} 响应格式无效。`);
  return value;
}

function todayItemFrom(value: unknown): RelayTodayItem {
  const row = object(value, "today item");
  return { taskId: string(row, "task_id", "today item"), taskRevision: decimal(row, "task_revision", "today item"),
    projectId: nullableString(row, "project_id", "today item"), title: string(row, "title", "today item"),
    status: taskStatus(row, "status", "today item"), priority: todayPriority(row, "priority", "today item"),
    dueLocalDate: nullableString(row, "due_local_date", "today item"), timezone: nullableString(row, "timezone", "today item"),
    pin: boolean(row, "pin", "today item"), laterLocalDate: nullableString(row, "later_local_date", "today item"),
    laterTimezone: nullableString(row, "later_timezone", "today item"),
    reasonCodes: stringArray(row, "reason_codes", "today item"), evidenceRefs: stringArray(row, "evidence_refs", "today item"),
    allowedActions: stringArray(row, "allowed_actions", "today item") };
}

function todayFrom(value: unknown): RelayToday {
  const row = object(value, "today");
  const focus = row.focus === null ? null : object(row.focus, "today.focus");
  const targetKind = focus === null ? null : string(focus, "target_kind", "today.focus");
  if (targetKind !== null && targetKind !== "GOAL" && targetKind !== "PROJECT" && targetKind !== "TASK") {
    throw new Error("today.focus.target_kind 响应格式无效。");
  }
  return { date: string(row, "date", "today"), timezone: string(row, "timezone", "today"),
    selectionRevision: decimal(row, "selection_revision", "today"),
    focus: focus === null ? null : { date: string(focus, "date", "today.focus"),
      timezone: string(focus, "timezone", "today.focus"), targetKind: targetKind!,
      targetId: string(focus, "target_id", "today.focus"),
      selectionRevision: decimal(focus, "selection_revision", "today.focus"),
      activeInQuery: boolean(focus, "active_in_query", "today.focus") },
    focusHasEligibleCandidate: boolean(row, "focus_has_eligible_candidate", "today"),
    eligibleItems: array(row, "eligible_items", "today").map(todayItemFrom),
    waitingItems: array(row, "waiting_items", "today").map(todayItemFrom),
    blockedPinnedItems: array(row, "blocked_pinned_items", "today").map(todayItemFrom) };
}

function activityPageFrom(value: unknown): RelayActivityPage {
  const row = object(value, "activity page");
  const kinds: readonly RelayActivityRefKind[] = ["PROJECT", "TASK", "RUN", "GOAL", "ARTIFACT_VERSION", "REVIEW", "COMPLETION", "VERIFICATION_SESSION"];
  return { items: array(row, "items", "activity page").map((value): RelayActivityItem => {
    const item = object(value, "activity item");
    const actorKind = string(item, "actor_kind", "activity item");
    if (actorKind !== "HUMAN" && actorKind !== "AI" && actorKind !== "SYSTEM") throw new Error("activity item.actor_kind 响应格式无效。");
    return { id: string(item, "id", "activity item"), createdAt: string(item, "created_at", "activity item"),
      actorKind, commandId: nullableString(item, "command_id", "activity item"),
      eventType: string(item, "event_type", "activity item"), summary: string(item, "summary", "activity item"),
      projectId: nullableString(item, "project_id", "activity item"), taskId: nullableString(item, "task_id", "activity item"),
      runId: nullableString(item, "run_id", "activity item"),
      entityRefs: array(item, "entity_refs", "activity item").map((value) => {
        const ref = object(value, "activity ref");
        const kind = string(ref, "kind", "activity ref");
        if (!kinds.includes(kind as RelayActivityRefKind)) throw new Error("activity ref.kind 响应格式无效。");
        return { kind: kind as RelayActivityRefKind, id: string(ref, "id", "activity ref") };
      }) };
  }), nextCursor: nullableString(row, "next_cursor", "activity page") };
}

export function selectionRevisionFrom(result: Readonly<Record<string, unknown>>): DecimalRevision {
  return decimal(result, "selection_revision", "command result");
}

function commandEnvelopeFrom(value: unknown): RelayCommandEnvelope {
  const record = object(value, "command response");
  return {
    commandId: string(record, "command_id", "command response"),
    committedAt: string(record, "committed_at", "command response"),
    result: object(record.result, "command response.result")
  };
}

/**
 * 回执里的 result 与首次响应的 result 是同一份事实，因此共用解析函数：
 * 传输错误后按同一 command_id 查询回执，才能判断命令是否已提交。
 */
export function projectCreationFrom(result: Readonly<Record<string, unknown>>): RelayProjectCreation {
  return {
    projectId: string(result, "project_id", "command result"),
    revision: decimal(result, "revision", "command result"),
    phaseKey: string(result, "phase_key", "command result"),
    stateRevision: decimal(result, "state_revision", "command result")
  };
}

export function taskCreationFrom(result: Readonly<Record<string, unknown>>): RelayTaskCreation {
  return {
    taskId: string(result, "task_id", "command result"),
    projectId: nullableString(result, "project_id", "command result"),
    status: taskStatus(result, "status", "command result"),
    mode: interactionMode(result, "mode", "command result"),
    revision: decimal(result, "revision", "command result"),
    acceptanceRevision: decimal(result, "acceptance_revision", "command result")
  };
}

export function taskMutationFrom(result: Readonly<Record<string, unknown>>): RelayTaskMutation {
  return {
    taskId: string(result, "task_id", "command result"),
    status: taskStatus(result, "status", "command result"),
    revision: decimal(result, "revision", "command result")
  };
}

export function artifactVersionResultFrom(
  result: Readonly<Record<string, unknown>>
): RelayArtifactVersionResult {
  return {
    taskId: string(result, "task_id", "command result"),
    artifactId: string(result, "artifact_id", "command result"),
    artifactRevision: decimal(result, "artifact_revision", "command result"),
    versionId: string(result, "version_id", "command result"),
    versionNumber: decimal(result, "version_number", "command result"),
    mediaType: string(result, "media_type", "command result"),
    sha256: string(result, "sha256", "command result"),
    size: decimal(result, "size", "command result"),
    taskRevision: decimal(result, "task_revision", "command result")
  };
}

export function completionFrom(result: Readonly<Record<string, unknown>>): RelayCompletion {
  return {
    taskId: string(result, "task_id", "command result"),
    status: taskStatus(result, "status", "command result"),
    revision: decimal(result, "revision", "command result"),
    acceptanceRevision: decimal(result, "acceptance_revision", "command result"),
    completionId: string(result, "completion_id", "command result"),
    humanAcceptanceId: string(result, "human_acceptance_id", "command result"),
    artifactVersionIds: stringArray(result, "artifact_version_ids", "command result"),
    stateRevision: optionalString(result, "state_revision")
  };
}

function completionEvidenceFrom(value: unknown): RelayCompletionEvidence {
  const row = object(value, "completion evidence");
  const kind = string(row, "basis_kind", "completion evidence");
  if (kind !== "HUMAN" && kind !== "AUTO") throw new Error("completion evidence.basis_kind 响应格式无效。");
  const acceptance = object(row.acceptance, "completion acceptance");
  const acceptanceAvailability = availability(acceptance, "availability", "completion acceptance");
  const human = row.human_acceptance === null ? null : object(row.human_acceptance, "human acceptance");
  const humanAvailability = human === null ? null : availability(human, "availability", "human acceptance");
  const verification = row.verification_session === null ? null : object(row.verification_session, "verification session");
  const verificationAvailability = verification === null ? null : availability(verification, "availability", "verification session");
  return {
    completionId: string(row, "completion_id", "completion evidence"),
    taskId: string(row, "task_id", "completion evidence"), basisKind: kind,
    acceptanceRevision: decimal(row, "acceptance_revision", "completion evidence"),
    isCurrent: boolean(row, "is_current", "completion evidence"),
    committedAt: string(row, "committed_at", "completion evidence"),
    acceptance: acceptanceAvailability === "UNAVAILABLE" ? {
      availability: "UNAVAILABLE", objective: null, expectedOutputs: null, source: null,
      createdAt: null, criteria: []
    } : {
      availability: "AVAILABLE", objective: nullableString(acceptance, "objective", "completion acceptance"),
      expectedOutputs: acceptance.expected_outputs === null ? null : object(acceptance.expected_outputs, "completion acceptance.expected_outputs"),
      source: nullableString(acceptance, "source", "completion acceptance"),
      createdAt: nullableString(acceptance, "created_at", "completion acceptance"),
      criteria: array(acceptance, "criteria", "completion acceptance").map((item) => {
        const criterion = object(item, "completion criterion");
        return { criterionId: string(criterion, "criterion_id", "completion criterion"),
          statement: string(criterion, "statement", "completion criterion"),
          required: boolean(criterion, "required", "completion criterion"),
          method: string(criterion, "method", "completion criterion"),
          targetSpec: object(criterion.target_spec, "completion criterion.target_spec") };
      })
    },
    humanAcceptance: human === null ? null : humanAvailability === "UNAVAILABLE" ? {
      availability: "UNAVAILABLE", id: null, actorKind: null, statement: null,
      acceptedCriterionIds: [], reason: null, createdAt: null
    } : {
      availability: "AVAILABLE", id: nullableString(human, "id", "human acceptance"),
      actorKind: nullableString(human, "actor_kind", "human acceptance"),
      statement: nullableString(human, "statement", "human acceptance"),
      acceptedCriterionIds: stringArray(human, "accepted_criterion_ids", "human acceptance"),
      reason: nullableString(human, "reason", "human acceptance"),
      createdAt: nullableString(human, "created_at", "human acceptance")
    },
    verificationSession: verification === null ? null : verificationAvailability === "UNAVAILABLE" ? {
      availability: "UNAVAILABLE", id: null, runId: null, status: null, verdict: null,
      checkPlanHash: null, applicable: null
    } : {
      availability: "AVAILABLE", id: nullableString(verification, "id", "verification session"),
      runId: nullableString(verification, "run_id", "verification session"),
      status: nullableString(verification, "status", "verification session"),
      verdict: nullableString(verification, "verdict", "verification session"),
      checkPlanHash: nullableString(verification, "check_plan_hash", "verification session"),
      applicable: verification.applicable === null ? null : boolean(verification, "applicable", "verification session")
    },
    artifactVersions: array(row, "artifact_versions", "completion evidence").map((item) => {
      const version = object(item, "completion artifact version");
      return availability(version, "availability", "completion artifact version") === "UNAVAILABLE"
        ? { availability: "UNAVAILABLE" as const, artifactVersionId: null, artifactId: null,
          versionNumber: null, sha256: null }
        : { availability: "AVAILABLE" as const,
          artifactVersionId: nullableString(version, "artifact_version_id", "completion artifact version"),
          artifactId: nullableString(version, "artifact_id", "completion artifact version"),
          versionNumber: version.version_number === null ? null : decimal(version, "version_number", "completion artifact version"),
          sha256: nullableString(version, "sha256", "completion artifact version") };
    })
  };
}

export function reopenFrom(result: Readonly<Record<string, unknown>>): RelayReopen {
  return {
    taskId: string(result, "task_id", "command result"),
    status: taskStatus(result, "status", "command result"),
    revision: decimal(result, "revision", "command result"),
    acceptanceRevision: decimal(result, "acceptance_revision", "command result"),
    previousAcceptanceRevision: decimal(result, "previous_acceptance_revision", "command result"),
    previousCompletionId: nullableString(result, "previous_completion_id", "command result")
  };
}

export function stateMutationFrom(result: Readonly<Record<string, unknown>>): RelayStateMutation {
  return {
    projectId: string(result, "project_id", "command result"),
    action: string(result, "action", "command result"),
    revision: decimal(result, "revision", "command result")
  };
}

function interventionFrom(value: unknown): RelayInterventionItem {
  const row = object(value, "intervention");
  const kind = string(row, "kind", "intervention");
  if (!["REVIEW", "LOCK_CONFLICT", "RUN_FAILED", "UNKNOWN"].includes(kind))
    throw new Error("人工介入事项类型无效。");
  const targetUrl = string(row, "target_url", "intervention");
  if (!/^\/(?:runs\/[^/]+|reviews\?id=[^/]+|tasks\?tab=attention)$/u.test(targetUrl))
    throw new Error("人工介入事项入口无效。");
  return { itemKey: string(row, "item_key", "intervention"),
    changeKey: string(row, "change_key", "intervention"),
    kind: kind as RelayInterventionItem["kind"],
    title: string(row, "title", "intervention"),
    reason: string(row, "reason", "intervention"), targetUrl };
}

function impactCheckFrom(value: unknown): RelayArtifactImpactCheck {
  const row = object(value, "impact check");
  const status = string(row, "status", "impact check");
  if (!["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"].includes(status))
    throw new Error("影响检查状态无效。");
  return { id: string(row, "id", "impact check"), artifactId: string(row, "artifact_id", "impact check"),
    sourceBeforeVersionId: string(row, "source_before_version_id", "impact check"),
    sourceAfterVersionId: string(row, "source_after_version_id", "impact check"),
    status: status as RelayArtifactImpactCheck["status"],
    errorCode: row.error_code === null ? null : string(row, "error_code", "impact check"),
    directTargets: array(row, "direct_targets", "impact check").map((value) => {
      const item = object(value, "direct target");
      const availability = string(item, "availability", "direct target");
      if (availability !== "AVAILABLE" && availability !== "UNAVAILABLE") throw new Error("直接引用可用性无效。");
      return { targetVersionId: string(item, "target_version_id", "direct target"),
        targetArtifactId: string(item, "target_artifact_id", "direct target"),
        relation: string(item, "relation", "direct target"),
        versionNumber: decimal(item, "version_number", "direct target"), availability,
        analysed: boolean(item, "analysed", "direct target") };
    }),
    possiblyRelated: array(row, "possibly_related", "impact check").map((value) => {
      const item = object(value, "possibly related");
      return { targetVersionId: string(item, "target_version_id", "possibly related"),
        reason: string(item, "reason", "possibly related") };
    }),
    hasMore: boolean(row, "has_more", "impact check"),
    inputTruncated: boolean(row, "input_truncated", "impact check"),
    unanalysedScope: stringArray(row, "unanalysed_scope", "impact check"),
    stale: boolean(row, "stale", "impact check") };
}

function impactCandidateFrom(value: unknown): RelayArtifactImpactCandidate {
  const row = object(value, "impact candidate");
  const status = string(row, "status", "impact candidate");
  if (!["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"].includes(status))
    throw new Error("修改候选状态无效。");
  return { id: string(row, "id", "impact candidate"),
    impactCheckId: string(row, "impact_check_id", "impact candidate"),
    targetArtifactId: string(row, "target_artifact_id", "impact candidate"),
    targetVersionId: string(row, "target_version_id", "impact candidate"),
    status: status as RelayArtifactImpactCandidate["status"],
    errorCode: row.error_code === null ? null : string(row, "error_code", "impact candidate"),
    markdown: row.markdown === null ? null : string(row, "markdown", "impact candidate"),
    stale: boolean(row, "stale", "impact candidate"),
    appliedVersionId: row.applied_version_id === null ? null : string(row, "applied_version_id", "impact candidate") };
}

function artifactTextLockFrom(value: unknown): RelayArtifactTextLock {
  const row = object(value, "artifact text lock");
  const kind = string(row, "block_kind", "artifact text lock");
  const status = string(row, "status", "artifact text lock");
  const index = row.block_index === null ? null : integer(row, "block_index", "artifact text lock");
  if ((kind !== "PARAGRAPH" && kind !== "SECTION") ||
      (status !== "MAPPED" && status !== "UNMAPPED") ||
      (status === "MAPPED" && index === null) || (status === "UNMAPPED" && index !== null))
    throw new Error("锁定块状态无效。");
  return { id: string(row, "id", "artifact text lock"),
    artifactId: string(row, "artifact_id", "artifact text lock"),
    baseVersionId: string(row, "base_version_id", "artifact text lock"),
    blockKind: kind, blockIndex: index, text: string(row, "text", "artifact text lock"),
    status };
}

function artifactFrom(value: unknown): RelayArtifact {
  const record = object(value, "artifact");
  return {
    id: string(record, "id", "artifact"),
    taskId: string(record, "task_id", "artifact"),
    title: string(record, "title", "artifact"),
    revision: decimal(record, "revision", "artifact"),
    latestVersionId: nullableString(record, "latest_version_id", "artifact"),
    versionCount: integer(record, "version_count", "artifact"),
    versions: array(record, "versions", "artifact").map((item) => {
      const version = object(item, "artifact version");
      return {
        artifactVersionId: string(version, "artifact_version_id", "artifact version"),
        versionNumber: decimal(version, "version_number", "artifact version"),
        mediaType: string(version, "media_type", "artifact version"),
        sha256: string(version, "sha256", "artifact version"),
        size: decimal(version, "size", "artifact version"),
        sourceKind: string(version, "source_kind", "artifact version"),
        createdAt: string(version, "created_at", "artifact version")
      };
    })
  };
}

function artifactDirectUsesFrom(value: unknown): RelayArtifactDirectUses {
  const row = object(value, "artifact direct uses");
  if (row.scope !== "RECORDED_DIRECT_ONLY" || row.complete !== false) {
    throw new Error("直接引用查询的分析范围无效。");
  }
  return {
    sourceArtifactVersionId: string(row, "source_artifact_version_id", "artifact direct uses"),
    sourceContentAvailability: availability(row, "source_content_availability", "artifact direct uses"),
    scope: "RECORDED_DIRECT_ONLY", complete: false,
    hasMore: boolean(row, "has_more", "artifact direct uses"),
    directUses: array(row, "direct_uses", "artifact direct uses").map((value) => {
      const use = object(value, "artifact direct use");
      const relation = string(use, "relation", "artifact direct use");
      if (relation !== "DERIVED_FROM" && relation !== "REVISED_FROM") {
        throw new Error("直接引用的关系类型无效。");
      }
      const state = availability(use, "availability", "artifact direct use");
      const childArtifactVersionId = nullableString(use, "child_artifact_version_id", "artifact direct use");
      const childArtifactId = nullableString(use, "child_artifact_id", "artifact direct use");
      const childVersionNumber = use.child_version_number === null ? null
        : decimal(use, "child_version_number", "artifact direct use");
      if (state === "AVAILABLE" ? !childArtifactVersionId || !childArtifactId || childVersionNumber === null
        : childArtifactVersionId !== null || childArtifactId !== null || childVersionNumber !== null) {
        throw new Error("直接引用的可用性与版本身份不一致。");
      }
      return { relation, childArtifactVersionId, childArtifactId, childVersionNumber,
        availability: state, createdAt: string(use, "created_at", "artifact direct use") };
    }),
  };
}

function artifactLineageFrom(value: unknown): RelayArtifactLineage {
  const row = object(value, "artifact lineage");
  const relations: readonly RelayLineageRelation[] = ["DERIVED_FROM", "REVISED_FROM", "GENERATED_BY", "VERIFIED_BY", "ACCEPTED_BY"];
  const parentKinds: readonly RelayLineageParentKind[] = ["ARTIFACT_VERSION", "KNOWLEDGE_VERSION", "RUN_STEP", "VERIFICATION_SESSION", "COMPLETION_RECORD"];
  return { artifactVersionId: string(row, "artifact_version_id", "artifact lineage"),
    artifactId: string(row, "artifact_id", "artifact lineage"), versionNumber: decimal(row, "version_number", "artifact lineage"),
    sha256: string(row, "sha256", "artifact lineage"), sourceKind: string(row, "source_kind", "artifact lineage"),
    contentAvailability: availability(row, "content_availability", "artifact lineage"),
    directParents: array(row, "direct_parents", "artifact lineage").map((value) => {
      const edge = object(value, "lineage edge");
      const relation = string(edge, "relation", "lineage edge");
      const parentKind = string(edge, "parent_kind", "lineage edge");
      if (!relations.includes(relation as RelayLineageRelation) || !parentKinds.includes(parentKind as RelayLineageParentKind)) {
        throw new Error("lineage edge 的关系或父来源类型无效。");
      }
      return { id: string(edge, "id", "lineage edge"), relation: relation as RelayLineageRelation,
        parentKind: parentKind as RelayLineageParentKind, parentId: nullableString(edge, "parent_id", "lineage edge"),
        availability: availability(edge, "availability", "lineage edge"), createdAt: string(edge, "created_at", "lineage edge") };
    }) };
}

function projectStateFrom(value: unknown): RelayProjectState {
  const record = object(value, "project state");
  return {
    projectId: string(record, "project_id", "project state"),
    revision: decimal(record, "revision", "project state"),
    phaseKey: string(record, "phase_key", "project state"),
    nextActionTaskId: nullableString(record, "next_action_task_id", "project state"),
    selectedArtifactVersionRefs: array(record, "selected_artifact_version_refs", "project state").map(
      (item) => {
        const ref = object(item, "project state.selected_artifact_version_refs");
        return {
          artifactVersionId: string(ref, "artifact_version_id", "artifact version ref"),
          artifactId: string(ref, "artifact_id", "artifact version ref"),
          versionNumber: decimal(ref, "version_number", "artifact version ref"),
          sourceRef: string(ref, "source_ref", "artifact version ref")
        };
      }
    ),
    completedHighlightRefs: array(record, "completed_highlight_refs", "project state").map((item) => {
      const ref = object(item, "project state.completed_highlight_refs");
      return {
        completionId: string(ref, "completion_id", "completion ref"),
        taskId: string(ref, "task_id", "completion ref"),
        acceptanceRevision: decimal(ref, "acceptance_revision", "completion ref")
      };
    })
  };
}

function directList<T>(value: unknown, name: string, parse: (item: unknown) => T): readonly T[] {
  if (!Array.isArray(value)) throw new Error(`${name} 响应格式无效。`);
  return value.map(parse);
}

function assistSourceBody(source: RelayAssistSourceRef) {
  return { kind: source.kind, root_id: source.rootId, version: source.version };
}

function stringList(row: Record<string, unknown>, key: string, name: string): readonly string[] {
  return array(row, key, name).map((value) => {
    if (typeof value !== "string") throw new Error(`${name}.${key} 响应格式无效。`);
    return value;
  });
}

function skillDefinitionFrom(value: unknown): RelaySkillDefinition {
  const row = object(value, "skill definition");
  const target = string(row, "target", "skill definition");
  const outputKind = string(row, "output_kind", "skill definition");
  const availability = string(row, "availability", "skill definition");
  if ((target !== "PROJECT" && target !== "TASK") ||
    !["TASK_DEFINITION_SUGGESTION", "PROJECT_RESUME", "VERIFICATION_PLAN_SUGGESTION",
      "PROJECT_BLUEPRINT_SUGGESTION"].includes(outputKind) ||
    !["CALLABLE_SUGGESTION_ONLY", "CALLABLE_READ_ONLY", "HISTORICAL_ONLY"].includes(availability) ||
    typeof row.call_supported !== "boolean" || typeof row.accept_supported !== "boolean") {
    throw new Error("Skill 定义响应格式无效。");
  }
  return { id: string(row, "id", "skill definition"), version: string(row, "version", "skill definition"),
    sha256: string(row, "sha256", "skill definition"), title: string(row, "title", "skill definition"),
    target, outputKind: outputKind as RelaySkillDefinition["outputKind"],
    availability: availability as RelaySkillDefinition["availability"],
    callSupported: row.call_supported,
    requiredCapabilities: stringList(row, "required_capabilities", "skill definition"),
    missingCapabilities: stringList(row, "missing_capabilities", "skill definition"),
    acceptSupported: row.accept_supported,
    dependencies: array(row, "dependencies", "skill definition").map((value) => {
      const dep = object(value, "skill dependency");
      return { kind: string(dep, "kind", "skill dependency"), id: string(dep, "id", "skill dependency"),
        version: string(dep, "version", "skill dependency"), sha256: string(dep, "sha256", "skill dependency") };
    }) };
}

function packDefinitionFrom(value: unknown): RelayPackDefinition {
  const row = object(value, "pack");
  return { id: string(row, "id", "pack"), version: string(row, "version", "pack"),
    sha256: string(row, "sha256", "pack"), title: string(row, "title", "pack"),
    hostContract: string(row, "host_contract", "pack"), availability: string(row, "availability", "pack"),
    members: array(row, "members", "pack").map((value) => {
      const member = object(value, "pack member");
      const target = string(member, "target", "pack member");
      if (member.kind !== "SKILL" || (target !== "PROJECT" && target !== "TASK") ||
        typeof member.accept_supported !== "boolean") throw new Error("Pack 成员响应格式无效。");
      return { kind: "SKILL" as const, id: string(member, "id", "pack member"),
        version: string(member, "version", "pack member"),
        sha256: string(member, "sha256", "pack member"), target,
        availability: string(member, "availability", "pack member"),
        requiredCapabilities: stringList(member, "required_capabilities", "pack member"),
        missingCapabilities: stringList(member, "missing_capabilities", "pack member"),
        acceptSupported: member.accept_supported };
    }) };
}

function assistSkillOutputFrom(value: unknown): RelayAssistSkillOutput {
  const row = object(value, "assist skill output");
  const kind = string(row, "kind", "assist skill output");
  const status = string(row, "status", "assist skill output");
  const targetKind = string(row, "target_kind", "assist skill output");
  if (!["TASK_DEFINITION_SUGGESTION", "PROJECT_RESUME", "VERIFICATION_PLAN_SUGGESTION",
    "PROJECT_BLUEPRINT_SUGGESTION"].includes(kind) ||
    (status !== "SUGGESTED" && status !== "READ_ONLY") ||
    (targetKind !== "PROJECT" && targetKind !== "TASK") ||
    (kind === "PROJECT_RESUME") !== (status === "READ_ONLY" && targetKind === "PROJECT") ||
    (kind === "PROJECT_BLUEPRINT_SUGGESTION" ?
      (status !== "SUGGESTED" || targetKind !== "PROJECT") :
      (kind !== "PROJECT_RESUME" && targetKind !== "TASK"))) {
    throw new Error("Assist Skill 输出类型无效。");
  }
  const payload = object(row.payload, "assist skill payload");
  if (typeof payload.summary !== "string" ||
    (kind === "PROJECT_RESUME" && (!Array.isArray(payload.highlights) ||
      !Array.isArray(payload.next_steps) || payload.comparison_baseline !== null || payload.read_only !== true)) ||
    (kind === "TASK_DEFINITION_SUGGESTION" && (typeof payload.objective !== "string" ||
      !Array.isArray(payload.criteria) || !isRecord(payload.expected_outputs))) ||
    (kind === "VERIFICATION_PLAN_SUGGESTION" &&
      (!Array.isArray(payload.checks) && !Array.isArray(payload.additional_checks) ||
      payload.effective_check_plan !== false)) ||
    (kind === "PROJECT_BLUEPRINT_SUGGESTION" &&
      (!isRecord(payload.draft) || payload.effective_blueprint !== false))) {
    throw new Error("Assist Skill 输出内容无效。");
  }
  return { kind: kind as RelayAssistSkillOutput["kind"], status, targetKind,
    targetId: string(row, "target_id", "assist skill output"),
    asOf: string(row, "as_of", "assist skill output"),
    baseline: object(row.baseline, "assist skill baseline"),
    basisSha256: string(row, "basis_sha256", "assist skill output"),
    payloadSha256: string(row, "payload_sha256", "assist skill output"),
    payload };
}

function assistSessionFrom(value: unknown): RelayAssistSession {
  const row = object(value, "assist session");
  return { id: string(row, "id", "assist session"),
    projectId: nullableString(row, "project_id", "assist session"),
    taskId: nullableString(row, "task_id", "assist session"),
    title: string(row, "title", "assist session"), status: string(row, "status", "assist session"),
    revision: decimal(row, "revision", "assist session"),
    updatedAt: string(row, "updated_at", "assist session") };
}

function assistMessageFrom(value: unknown): RelayAssistMessage {
  const row = object(value, "assist message");
  const role = string(row, "role", "assist message");
  const status = string(row, "status", "assist message");
  if (role !== "USER" && role !== "ASSISTANT") throw new Error("Assist 消息角色无法识别。");
  if (status !== "PENDING" && status !== "RUNNING" && status !== "COMPLETED" && status !== "FAILED" && status !== "CANCELLED") {
    throw new Error("Assist 消息状态无法识别。");
  }
  const usage = object(row.usage, "assist message.usage");
  const providerErrorKind = row.provider_error_kind ?? null;
  if (providerErrorKind !== null && (status !== "FAILED" ||
      providerErrorKind !== "AUTH" && providerErrorKind !== "RATE_LIMIT" &&
      providerErrorKind !== "TIMEOUT" && providerErrorKind !== "STREAM_BROKEN" &&
      providerErrorKind !== "PROTOCOL" && providerErrorKind !== "NETWORK")) {
    throw new Error("Assist 消息 Provider 失败类别无效。");
  }
  const skillRow = row.skill === null || row.skill === undefined ? null : object(row.skill, "assist skill");
  const skillTarget = skillRow?.target;
  const target: "PROJECT" | "TASK" | null = skillTarget === "PROJECT" || skillTarget === "TASK"
    ? skillTarget : null;
  const definitionAvailability = skillRow === null ? null : string(skillRow, "definition_availability", "assist skill");
  const outputAvailability = skillRow === null ? null : string(skillRow, "output_availability", "assist skill");
  if (definitionAvailability !== null && !["AVAILABLE", "HISTORICAL_ONLY", "UNAVAILABLE"].includes(definitionAvailability) ||
    outputAvailability !== null && !["PENDING", "HISTORICAL_SNAPSHOT", "NO_OUTPUT", "UNAVAILABLE"].includes(outputAvailability)) {
    throw new Error("Assist Skill 历史可用性无效。");
  }
  const skill = skillRow === null ? null : {
    id: string(skillRow, "id", "assist skill"), version: string(skillRow, "version", "assist skill"),
    sha256: optionalString(skillRow, "sha256"),
    definitionAvailability: definitionAvailability as NonNullable<RelayAssistMessage["skill"]>["definitionAvailability"],
    outputAvailability: outputAvailability as NonNullable<RelayAssistMessage["skill"]>["outputAvailability"],
    target,
    availability: optionalString(skillRow, "availability"),
    missingCapabilities: Array.isArray(skillRow.missing_capabilities)
      ? stringList(skillRow, "missing_capabilities", "assist skill") : []
  };
  return { id: string(row, "id", "assist message"),
    sessionId: string(row, "session_id", "assist message"),
    seq: decimal(row, "seq", "assist message"), role, status,
    createdAt: optionalString(row, "created_at"),
    intent: string(row, "intent", "assist message"),
    content: nullableString(row, "content", "assist message"),
    errorCode: nullableString(row, "error_code", "assist message"),
    providerErrorKind,
    sources: array(row, "sources", "assist message").map((value) => {
      const source = object(value, "assist source");
      return { sourceRef: optionalString(source, "source_ref"),
        kind: optionalString(source, "kind"), rootId: optionalString(source, "root_id"),
        version: optionalString(source, "version"),
        status: string(source, "status", "assist source"),
        reason: optionalString(source, "reason") };
    }),
    skill, skillInput: row.skill_input === null || row.skill_input === undefined
      ? null : object(row.skill_input, "assist skill input"),
    skillOutput: row.skill_output === null || row.skill_output === undefined
      ? null : assistSkillOutputFrom(row.skill_output),
    usage: { inputTokens: nullableInteger(usage, "input_tokens", "assist usage"),
      outputTokens: nullableInteger(usage, "output_tokens", "assist usage") },
    cancelRequested: row.cancel_requested === true };
}

function assistProposalFrom(value: unknown): RelayAssistProposal {
  const row = object(value, "assist proposal");
  const kind = string(row, "kind", "assist proposal");
  const targetType = string(row, "target_type", "assist proposal");
  const status = string(row, "status", "assist proposal");
  if (status !== "PENDING" && status !== "ACCEPTED" && status !== "REJECTED" && status !== "EXPIRED") {
    throw new Error("Assist 提案类型或状态无法识别。");
  }
  const common: RelayAssistProposalBase = { id: string(row, "id", "assist proposal"),
    sessionId: string(row, "session_id", "assist proposal"),
    messageId: string(row, "message_id", "assist proposal"),
    targetId: string(row, "target_id", "assist proposal"),
    baseRevision: decimal(row, "base_revision", "assist proposal"),
    payloadHash: string(row, "payload_hash", "assist proposal"),
    payloadAvailable: row.payload_available === undefined ? true : row.payload_available === true,
    status };
  const payload = object(row.payload, "assist proposal.payload");
  if ((kind === "TASK_CONTRACT_CHANGE" || kind === "VERIFICATION_PLAN_CHANGE") && targetType === "TASK") {
    const acceptanceRevision = decimal(row, "base_acceptance_revision", "task skill proposal");
    const skillSha256 = string(row, "skill_sha256", "task skill proposal");
    const skillOutputSha256 = string(row, "skill_output_sha256", "task skill proposal");
    if (!/^[0-9a-f]{64}$/.test(common.payloadHash) ||
      !/^[0-9a-f]{64}$/.test(skillSha256) || !/^[0-9a-f]{64}$/.test(skillOutputSha256) ||
      typeof row.payload_available !== "boolean") throw new Error("Task Skill 提案来源格式无效。");
    if (!common.payloadAvailable) return { ...common, kind, targetType,
      baseAcceptanceRevision: acceptanceRevision, skillSha256, skillOutputSha256, payload: null };
    const rawMode = payload.suggested_mode;
    if (rawMode !== null && typeof rawMode !== "string") throw new Error("建议模式格式无效。");
    return { ...common, kind, targetType, baseAcceptanceRevision: acceptanceRevision,
      skillSha256, skillOutputSha256,
      payload: { objective: string(payload, "objective", "task skill proposal"),
        requiredOutputSpec: object(payload.required_output_spec, "task skill outputs"),
        criteria: array(payload, "criteria", "task skill proposal").map((value) => {
          const criterion = object(value, "task skill criterion");
          const source = string(criterion, "source", "task skill criterion");
          if (typeof criterion.required !== "boolean" ||
            (source !== "PRESERVED" && source !== "SUGGESTED")) {
            throw new Error("Task Skill 合并条件格式无效。");
          }
          return { criterionId: string(criterion, "criterion_id", "task skill criterion"),
            statement: string(criterion, "statement", "task skill criterion"),
            required: criterion.required, method: string(criterion, "method", "task skill criterion"),
            targetSpec: object(criterion.target_spec, "task skill target spec"), source };
        }), addedCriterionIds: stringList(payload, "added_criterion_ids", "task skill proposal"),
        preservedCriterionIds: stringList(payload, "preserved_criterion_ids", "task skill proposal"),
        suggestedMode: rawMode } };
  }
  if (kind === "CANDIDATE_MARKDOWN" && targetType === "TASK") {
    return { ...common, kind, targetType, payload: {
      title: string(payload, "title", "candidate payload"),
      mediaType: string(payload, "media_type", "candidate payload"),
      markdown: string(payload, "markdown", "candidate payload") } };
  }
  if (kind === "TASK_DEFINITION" && targetType === "PROJECT") {
    return { ...common, kind, targetType, payload: {
      title: string(payload, "title", "task proposal payload"),
      objective: string(payload, "objective", "task proposal payload"),
      criteria: array(payload, "criteria", "task proposal payload").map((value) => {
        const criterion = object(value, "task proposal criterion");
        if (typeof criterion.required !== "boolean") throw new Error("提案验收条件格式无效。");
        return { statement: string(criterion, "statement", "task proposal criterion"),
          required: criterion.required, method: string(criterion, "method", "task proposal criterion") };
      }), expectedOutputs: object(payload.expected_outputs, "task proposal expected_outputs") } };
  }
  throw new Error("Assist 提案类型或目标无法识别。");
}

function knowledgeFrom(value: unknown): RelayKnowledge {
  const row = object(value, "knowledge");
  return {
    id: string(row, "id", "knowledge"), projectId: nullableString(row, "project_id", "knowledge"),
    title: string(row, "title", "knowledge"), status: string(row, "status", "knowledge"),
    revision: decimal(row, "revision", "knowledge"), currentVersion: decimal(row, "current_version", "knowledge"),
    createdAt: string(row, "created_at", "knowledge"), updatedAt: string(row, "updated_at", "knowledge")
  };
}

function webImportSubmissionFrom(value: unknown, projectId: string, connectionId: string): RelayWebImportSubmission {
  const row = object(value, "web import submission");
  if (string(row, "project_id", "web import submission") !== projectId ||
      string(row, "connection_id", "web import submission") !== connectionId ||
      string(row, "status", "web import submission") !== "QUEUED") {
    throw new Error("web import submission 与目标不匹配。");
  }
  return { importJobId: string(row, "import_job_id", "web import submission"),
    projectId, connectionId, status: "QUEUED" };
}

function webImportJobFrom(value: unknown): RelayWebImportJob {
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

function webImportOperationFrom(value: unknown, importJobId: string): RelayWebImportOperation {
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

function knowledgeVersionContentFrom(value: unknown): RelayKnowledgeVersionContent {
  const row = object(value, "knowledge content");
  const metadata = knowledgeVersionFrom({ ...row, excerpt: null });
  const status = string(row, "content_status", "knowledge content");
  if (status !== "FULL" && status !== "PARTIAL" && status !== "UNAVAILABLE" &&
    status !== "UNSUPPORTED" && status !== "READ_FAILED") throw new Error("知识正文状态无效。");
  const content = nullableString(row, "content", "knowledge content");
  if ((status === "FULL" || status === "PARTIAL") ? content === null : content !== null) {
    throw new Error("知识正文状态与可读内容不一致。");
  }
  if ((status === "FULL" || status === "PARTIAL") && metadata.availability !== "AVAILABLE") {
    throw new Error("知识正文状态与来源可用性不一致。");
  }
  return { id: metadata.id, knowledgeId: metadata.knowledgeId, version: metadata.version,
    sourceKind: metadata.sourceKind, mediaType: metadata.mediaType, contentSha256: metadata.contentSha256,
    availability: metadata.availability, sourceRefs: metadata.sourceRefs, createdAt: metadata.createdAt,
    title: string(row, "title", "knowledge content"), projectId: nullableString(row, "project_id", "knowledge content"),
    currentVersion: decimal(row, "current_version", "knowledge content"),
    sourceUri: nullableString(row, "source_uri", "knowledge content"), contentStatus: status, content };
}

function knowledgeVersionFrom(value: unknown): RelayKnowledgeVersion {
  const row = object(value, "knowledge version");
  const sourceKind = string(row, "source_kind", "knowledge version");
  if (sourceKind !== "NOTE" && sourceKind !== "MANAGED_TEXT" && sourceKind !== "ARTIFACT_VERSION" && sourceKind !== "WEB_PAGE") {
    throw new Error("knowledge version.source_kind 响应格式无效。");
  }
  return {
    id: string(row, "id", "knowledge version"), knowledgeId: string(row, "knowledge_id", "knowledge version"),
    version: decimal(row, "version", "knowledge version"), sourceKind,
    mediaType: string(row, "media_type", "knowledge version"),
    contentSha256: string(row, "content_sha256", "knowledge version"),
    availability: string(row, "availability", "knowledge version"),
    excerpt: nullableString(row, "excerpt", "knowledge version"),
    sourceRefs: object(row.source_refs, "knowledge version.source_refs"),
    createdAt: string(row, "created_at", "knowledge version")
  };
}

function memoryFrom(value: unknown): RelayMemory {
  const row = object(value, "memory");
  return {
    id: string(row, "id", "memory"), projectId: nullableString(row, "project_id", "memory"),
    title: string(row, "title", "memory"), status: string(row, "status", "memory"),
    revision: decimal(row, "revision", "memory"), currentVersion: decimal(row, "current_version", "memory"),
    text: string(row, "text", "memory"), confirmedBy: string(row, "confirmed_by", "memory"),
    confirmedAt: string(row, "confirmed_at", "memory"), expiresAt: nullableString(row, "expires_at", "memory"),
    createdAt: string(row, "created_at", "memory"), updatedAt: string(row, "updated_at", "memory")
  };
}

function memoryRevisionFrom(value: unknown): RelayMemoryRevision {
  const row = object(value, "memory revision");
  return {
    id: string(row, "id", "memory revision"), memoryId: string(row, "memory_id", "memory revision"),
    version: decimal(row, "version", "memory revision"), title: string(row, "title", "memory revision"),
    text: string(row, "text", "memory revision"), confirmedBy: string(row, "confirmed_by", "memory revision"),
    confirmedAt: string(row, "confirmed_at", "memory revision"),
    expiresAt: nullableString(row, "expires_at", "memory revision"),
    createdAt: string(row, "created_at", "memory revision")
  };
}

function decisionFrom(value: unknown): RelayDecision {
  const row = object(value, "decision");
  return {
    id: string(row, "id", "decision"), projectId: nullableString(row, "project_id", "decision"),
    title: string(row, "title", "decision"), status: string(row, "status", "decision"),
    revision: decimal(row, "revision", "decision"), currentVersion: decimal(row, "current_version", "decision"),
    choice: string(row, "choice", "decision"), rationale: string(row, "rationale", "decision"),
    alternatives: stringArray(row, "alternatives", "decision"), costs: stringArray(row, "costs", "decision"),
    supersededById: nullableString(row, "superseded_by_id", "decision"),
    createdAt: string(row, "created_at", "decision"), updatedAt: string(row, "updated_at", "decision")
  };
}

function ruleFields(row: Record<string, unknown>, name: string) {
  const strength = string(row, "strength", name);
  const enforcement = string(row, "enforcement", name);
  if (strength !== "HARD" && strength !== "PREFERENCE") throw new Error(`${name}.strength 响应格式无效。`);
  if (!["PRE_ACTION", "POST_CHECK", "SEMANTIC", "HUMAN"].includes(enforcement)) {
    throw new Error(`${name}.enforcement 响应格式无效。`);
  }
  return {
    ruleKey: string(row, "rule_key", name), statement: string(row, "statement", name), strength: strength as RelayRuleStrength,
    applicability: string(row, "applicability", name), enforcement: enforcement as RelayRuleEnforcement,
    method: nullableString(row, "method", name), targetSpec: object(row.target_spec, `${name}.target_spec`)
  };
}

function ruleFrom(value: unknown): RelayRule {
  const row = object(value, "rule");
  const scope = string(row, "scope", "rule");
  if (scope !== "WORKSPACE" && scope !== "PROJECT" && scope !== "TASK") throw new Error("rule.scope 响应格式无效。");
  return {
    id: string(row, "id", "rule"), scope, scopeId: string(row, "scope_id", "rule"),
    projectId: nullableString(row, "project_id", "rule"), taskId: nullableString(row, "task_id", "rule"),
    status: string(row, "status", "rule"), revision: decimal(row, "revision", "rule"),
    currentVersion: decimal(row, "current_version", "rule"), ...ruleFields(row, "rule"),
    createdAt: string(row, "created_at", "rule"), updatedAt: string(row, "updated_at", "rule")
  };
}

function ruleVersionFrom(value: unknown): RelayRuleVersion {
  const row = object(value, "rule version");
  return {
    ruleId: string(row, "rule_id", "rule version"), version: decimal(row, "version", "rule version"),
    ...ruleFields(row, "rule version"), createdAt: string(row, "created_at", "rule version")
  };
}

function searchItemFrom(value: unknown): RelaySearchItem {
  const row = object(value, "search item");
  const type = string(row, "type", "search item");
  if (!["KNOWLEDGE", "MEMORY", "DECISION", "RULE"].includes(type)) throw new Error("search item.type 响应格式无效。");
  return {
    type: type as RelayInformationKind, id: string(row, "id", "search item"),
    version: decimal(row, "version", "search item"), title: string(row, "title", "search item"),
    snippet: string(row, "snippet", "search item"), matchedFields: stringArray(row, "matched_fields", "search item"),
    sourceRef: string(row, "source_ref", "search item"), status: string(row, "status", "search item"),
    projectId: nullableString(row, "project_id", "search item")
  };
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${name} 响应格式无效。`);
  }
  return value;
}

function modelVerifyResultFrom(row: Record<string, unknown>): RelayModelVerifyResult {
  const category = row.error_category;
  if (category !== null && category !== "AUTH" && category !== "RATE_LIMIT" &&
      category !== "TIMEOUT" && category !== "STREAM_BROKEN" && category !== "PROTOCOL" &&
      category !== "NETWORK") {
    throw new Error("model-port verify.error_category 响应格式无效。");
  }
  return {
    ok: row.ok === true,
    latencyMs: typeof row.latency_ms === "number" ? row.latency_ms : null,
    provider: string(row, "provider", "model-port verify"),
    model: string(row, "model", "model-port verify"),
    configFingerprint: string(row, "config_fingerprint", "model-port verify"),
    errorCategory: category,
    verifiedAt: string(row, "verified_at", "model-port verify")
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function array(record: Record<string, unknown>, key: string, name: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new Error(`${name}.${key} 响应格式无效。`);
  }
  return value;
}

function string(record: Record<string, unknown>, key: string, name: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`${name}.${key} 响应格式无效。`);
  }
  return value;
}

function boolean(record: Record<string, unknown>, key: string, name: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw new Error(`${name}.${key} 响应格式无效。`);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function nullableString(record: Record<string, unknown>, key: string, name: string): string | null {
  const value = record[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${name}.${key} 响应格式无效。`);
  }
  return value;
}

function decimal(record: Record<string, unknown>, key: string, name: string): DecimalRevision {
  const value = string(record, key, name);
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${name}.${key} 必须是十进制字符串。`);
  }
  return value;
}

function integer(record: Record<string, unknown>, key: string, name: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${name}.${key} 响应格式无效。`);
  }
  return value;
}

function nullableInteger(record: Record<string, unknown>, key: string, name: string): number | null {
  return record[key] === null ? null : integer(record, key, name);
}

function stringArray(record: Record<string, unknown>, key: string, name: string): readonly string[] {
  return array(record, key, name).map((value) => {
    if (typeof value !== "string") {
      throw new Error(`${name}.${key} 响应格式无效。`);
    }
    return value;
  });
}

function taskStatus(record: Record<string, unknown>, key: string, name: string): TaskStatus {
  const value = string(record, key, name);
  const values: readonly TaskStatus[] = ["INBOX", "READY", "IN_PROGRESS", "WAITING", "BLOCKED", "DONE", "CANCELLED"];
  if (!values.includes(value as TaskStatus)) {
    throw new Error(`${name}.${key} 包含未知任务状态。`);
  }
  return value as TaskStatus;
}

function interactionMode(record: Record<string, unknown>, key: string, name: string): InteractionMode {
  const value = string(record, key, name);
  const values: readonly InteractionMode[] = ["ME", "AI_ASSIST", "DELEGATE_AI"];
  if (!values.includes(value as InteractionMode)) {
    throw new Error(`${name}.${key} 包含未知执行模式。`);
  }
  return value as InteractionMode;
}

function executorKind(record: Record<string, unknown>, key: string, name: string): ExecutorKind {
  const value = string(record, key, name);
  if (value !== "HUMAN" && value !== "AI") {
    throw new Error(`${name}.${key} 包含未知执行者。`);
  }
  return value;
}
