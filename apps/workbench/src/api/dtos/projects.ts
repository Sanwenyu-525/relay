import type { DecimalRevision } from "../../types";
import type { TaskStatus } from "../../types";

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

/** CreateProject 的 201 结果（docs/api/http-command-contract.md 第 3 节）。 */
export interface RelayProjectCreation {
  readonly projectId: string;
  readonly revision: DecimalRevision;
  readonly phaseKey: string;
  readonly stateRevision: DecimalRevision;
}

/** LinkProjectGoal 的 200 结果：goal_ids 是关联后的完整集合，revision 是新的 Project 修订。 */
export interface RelayProjectGoalLink {
  readonly projectId: string;
  readonly revision: DecimalRevision;
  readonly goalIds: readonly string[];
}

/** CreateGoal 的 201 结果：Goal 是 Workspace 级事实，创建时状态为 ACTIVE。 */
export interface RelayGoalCreation {
  readonly goalId: string;
  readonly status: string;
  readonly revision: DecimalRevision;
  /** 回执本身不带标题；成功页用它显示关联对象，仍以原输入为准。 */
  readonly title: string;
}
