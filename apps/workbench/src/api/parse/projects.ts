import type { DecimalRevision } from "../../types";
import { array, boolean, decimal, integer, nullableString, object, string, taskStatus } from "../core/primitives";
import type { RelayActivityItem, RelayActivityPage, RelayActivityRefKind, RelayCommandEnvelope, RelayContinuationComparison, RelayContinuationPointSummary, RelayContinuationRefChange, RelayContinuationRefKind, RelayGoalCreation, RelayProject, RelayProjectArchiveResult, RelayProjectCreation, RelayProjectGoalLink, RelayProjectListItem, RelayProjectState, RelayStateMutation, RelayViewConfiguration } from "../dtos/projects";

export function projectFrom(value: unknown): RelayProject {
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

export function projectListItemFrom(value: unknown): RelayProjectListItem {
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

export function continuationStateFrom(value: unknown, name: string): { readonly phaseKey: string;
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

export function continuationComparisonFrom(value: unknown): RelayContinuationComparison {
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
          status: taskStatus(task, "status", "continuation comparison.facts.task_added") };
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
      const refKind = string(ref, "ref_kind", "continuation comparison.ref_changes");
      const change = string(ref, "change", "continuation comparison.ref_changes");
      if (!(["TASK", "ARTIFACT_VERSION"] as const).includes(refKind as RelayContinuationRefKind)) {
        throw new Error("continuation comparison.ref_changes.ref_kind 包含未知引用类型。");
      }
      if (!(["UNCHANGED", "REVISED", "CLOSED", "MISSING", "CURRENT",
        "SUPERSEDED"] as const).includes(change as RelayContinuationRefChange)) {
        throw new Error("continuation comparison.ref_changes.change 包含未知变化类型。");
      }
      return { refKind: refKind as RelayContinuationRefKind,
        refId: string(ref, "ref_id", "continuation comparison.ref_changes"),
        capturedRevision: decimal(ref, "captured_revision", "continuation comparison.ref_changes"),
        change: change as RelayContinuationRefChange,
        currentRevision: ref["current_revision"] === null ? null
          : decimal(ref, "current_revision", "continuation comparison.ref_changes"),
        note: nullableString(ref, "note", "continuation comparison.ref_changes") };
    }),
    interpretation: null
  };
}

export function activityPageFrom(value: unknown): RelayActivityPage {
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

export function commandEnvelopeFrom(value: unknown): RelayCommandEnvelope {
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

/**
 * CreateGoal 的回执 result 与首次响应共用解析：传输失败后按同一 command_id 查回执，
 * 才能判断这条 Goal 是否已提交，避免换 ID 重建出第二个 Goal。
 */
export function goalCreationFrom(result: Readonly<Record<string, unknown>>): RelayGoalCreation {
  return {
    goalId: string(result, "goal_id", "command result"),
    status: string(result, "status", "command result"),
    revision: decimal(result, "revision", "command result"),
    // 服务端回执刻意不含标题（Goal 单读才有）；这里留空串，由调用方按原输入补上，
    // 避免为了显示而多发一次读取或把标题写进回执解析。
    title: ""
  };
}

export function projectGoalLinkFrom(result: Readonly<Record<string, unknown>>): RelayProjectGoalLink {
  const goalIds = result.goal_ids;
  if (!Array.isArray(goalIds) || goalIds.some((id) => typeof id !== "string")) {
    throw new Error("command result.goal_ids 响应格式无效。");
  }
  return { projectId: string(result, "project_id", "command result"),
    revision: decimal(result, "revision", "command result"), goalIds: goalIds as string[] };
}

export function stateMutationFrom(result: Readonly<Record<string, unknown>>): RelayStateMutation {
  return {
    projectId: string(result, "project_id", "command result"),
    action: string(result, "action", "command result"),
    revision: decimal(result, "revision", "command result")
  };
}

export function projectStateFrom(value: unknown): RelayProjectState {
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
