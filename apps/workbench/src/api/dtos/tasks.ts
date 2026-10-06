import type { DecimalRevision } from "../../types";
import type { ExecutorKind } from "../../types";
import type { InteractionMode } from "../../types";
import type { TaskStatus } from "../../types";

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

export interface RelayTaskAcceptanceRevisionInput {
  readonly taskId: string;
  readonly commandId: string;
  readonly expectedRevision: DecimalRevision;
  readonly expectedAcceptanceRevision: DecimalRevision;
  readonly criteria: readonly { readonly criterionId?: string; readonly statement: string;
    readonly required: boolean; readonly method: string; readonly targetSpec: Readonly<Record<string, unknown>> }[];
}

export interface RelayTaskAcceptanceRevision extends RelayTaskMutation {
  readonly previousAcceptanceRevision: DecimalRevision;
  readonly acceptanceRevision: DecimalRevision;
}
