import type { DecimalRevision } from "../../types";
import { array, boolean, decimal, integer, nullableString, object, string, taskStatus } from "../core/primitives";
import type { RelayActivityItem, RelayActivityPage, RelayActivityRefKind, RelayCommandEnvelope, RelayContinuationComparison, RelayContinuationPointSummary, RelayContinuationRefChange, RelayContinuationRefKind, RelayDirectoryWorkContext, RelayGoalArchiveResult, RelayGoalCreation, RelayGoalEditResult, RelayGoalPage, RelayGoalProject, RelayGoalRecord, RelayGoalWorkContext, RelayProject, RelayProjectArchiveResult, RelayProjectCreation, RelayProjectGoalLink, RelayProjectGoalLinkDetail, RelayProjectGoalUnlinkResult, RelayProjectListItem, RelayProjectRenameResult, RelayProjectState, RelayStateMutation, RelayViewConfiguration, RelayWorkContextProject, RelayWorkContextSession } from "../dtos/projects";

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

/* ── 正式 Goal 管理 ─────────────────────────────────────────────────────────── */

export function goalRecordFrom(value: unknown): RelayGoalRecord {
  const record = object(value, "goal");
  return { id: string(record, "id", "goal"), title: string(record, "title", "goal"),
    description: string(record, "description", "goal"), status: string(record, "status", "goal"),
    revision: decimal(record, "revision", "goal"),
    createdAt: string(record, "created_at", "goal"), updatedAt: string(record, "updated_at", "goal") };
}

export function goalPageFrom(value: unknown): RelayGoalPage {
  const record = object(value, "goal list");
  return { items: array(record, "items", "goal list").map(goalRecordFrom),
    nextCursor: nullableString(record, "next_cursor", "goal list") };
}

export function goalProjectFrom(value: unknown): RelayGoalProject {
  const record = object(value, "goal project");
  const archiveStatus = string(record, "archive_status", "goal project");
  const archivedAt = nullableString(record, "archived_at", "goal project");
  if (archiveStatus !== "ACTIVE" && archiveStatus !== "ARCHIVED" ||
    (archiveStatus === "ACTIVE") !== (archivedAt === null)) {
    throw new Error("goal project.archive_status 响应格式无效。");
  }
  return { projectId: string(record, "project_id", "goal project"),
    title: string(record, "title", "goal project"),
    projectType: string(record, "project_type", "goal project"),
    archivedAt, archiveStatus,
    projectRevision: decimal(record, "project_revision", "goal project"),
    linkedAt: string(record, "linked_at", "goal project") };
}

export function goalProjectListFrom(value: unknown): readonly RelayGoalProject[] {
  return array(object(value, "goal projects"), "items", "goal projects").map(goalProjectFrom);
}

export function projectGoalLinkDetailFrom(value: unknown): RelayProjectGoalLinkDetail {
  const record = object(value, "project goal");
  return { goalId: string(record, "goal_id", "project goal"),
    title: string(record, "title", "project goal"),
    status: string(record, "status", "project goal"),
    revision: decimal(record, "revision", "project goal"),
    explicitTaskIds: array(record, "explicit_task_ids", "project goal")
      .map((id) => {
        if (typeof id !== "string") throw new Error("project goal.explicit_task_ids 响应格式无效。");
        return id;
      }) };
}

export function projectGoalLinkDetailListFrom(value: unknown): readonly RelayProjectGoalLinkDetail[] {
  return array(object(value, "project goals"), "items", "project goals").map(projectGoalLinkDetailFrom);
}

export function goalEditResultFrom(result: Readonly<Record<string, unknown>>): RelayGoalEditResult {
  return { goalId: string(result, "goal_id", "goal revision result"),
    title: string(result, "title", "goal revision result"),
    description: string(result, "description", "goal revision result"),
    status: string(result, "status", "goal revision result"),
    revision: decimal(result, "revision", "goal revision result") };
}

export function goalArchiveResultFrom(result: Readonly<Record<string, unknown>>): RelayGoalArchiveResult {
  if (string(result, "status", "goal archive result") !== "ARCHIVED") {
    throw new Error("goal archive result.status 响应格式无效。");
  }
  return { goalId: string(result, "goal_id", "goal archive result"),
    status: "ARCHIVED", revision: decimal(result, "revision", "goal archive result") };
}

export function projectRenameResultFrom(result: Readonly<Record<string, unknown>>): RelayProjectRenameResult {
  return { projectId: string(result, "project_id", "project rename result"),
    title: string(result, "title", "project rename result"),
    revision: decimal(result, "revision", "project rename result") };
}

export function projectGoalUnlinkResultFrom(result: Readonly<Record<string, unknown>>): RelayProjectGoalUnlinkResult {
  return { projectId: string(result, "project_id", "goal unlink result"),
    revision: decimal(result, "revision", "goal unlink result"),
    impactedTasks: array(result, "impacted_tasks", "goal unlink result").map((value) => {
      const task = object(value, "goal unlink result.impacted_tasks");
      return { taskId: string(task, "task_id", "goal unlink result.impacted_tasks"),
        revision: decimal(task, "revision", "goal unlink result.impacted_tasks") };
    }) };
}

function workContextSessionFrom(value: unknown): RelayWorkContextSession {
  const record = object(value, "work context session");
  return { id: string(record, "id", "work context session"),
    projectId: string(record, "project_id", "work context session"),
    title: string(record, "title", "work context session"),
    status: string(record, "status", "work context session"),
    revision: decimal(record, "revision", "work context session"),
    workingResourceId: nullableString(record, "working_resource_id", "work context session") };
}

function workContextDirectoryFrom(value: unknown): { readonly id: string;
  readonly canonicalRoot: string; readonly status: string; readonly revision: DecimalRevision } {
  const record = object(value, "work context directory");
  return { id: string(record, "id", "work context directory"),
    canonicalRoot: string(record, "canonical_root", "work context directory"),
    status: string(record, "status", "work context directory"),
    revision: decimal(record, "revision", "work context directory") };
}

function workContextProjectFrom(value: unknown): RelayWorkContextProject {
  const record = object(value, "work context project");
  const archiveStatus = string(record, "archive_status", "work context project");
  const archivedAt = nullableString(record, "archived_at", "work context project");
  if (archiveStatus !== "ACTIVE" && archiveStatus !== "ARCHIVED" ||
    (archiveStatus === "ACTIVE") !== (archivedAt === null)) {
    throw new Error("work context project.archive_status 响应格式无效。");
  }
  return { id: string(record, "id", "work context project"),
    title: string(record, "title", "work context project"),
    projectType: string(record, "project_type", "work context project"),
    archiveStatus, archivedAt,
    revision: decimal(record, "revision", "work context project"),
    // 目录工作上下文的 project 不带 directories；Goal 上下文才投影目录清单。
    directories: Array.isArray(record["directories"])
      ? record["directories"].map(workContextDirectoryFrom) : [] };
}

export function goalWorkContextFrom(value: unknown): RelayGoalWorkContext {
  const record = object(value, "goal work context");
  if (string(record, "kind", "goal work context") !== "GOAL") {
    throw new Error("goal work context.kind 响应格式无效。");
  }
  const goal = object(record["goal"], "goal work context.goal");
  return { kind: "GOAL",
    goal: { id: string(goal, "id", "goal work context.goal"),
      title: string(goal, "title", "goal work context.goal"),
      description: string(goal, "description", "goal work context.goal"),
      status: string(goal, "status", "goal work context.goal"),
      revision: decimal(goal, "revision", "goal work context.goal") },
    projects: array(record, "projects", "goal work context").map(workContextProjectFrom),
    sessions: array(record, "sessions", "goal work context").map(workContextSessionFrom) };
}

export function directoryWorkContextFrom(value: unknown): RelayDirectoryWorkContext {
  const record = object(value, "directory work context");
  if (string(record, "kind", "directory work context") !== "DIRECTORY") {
    throw new Error("directory work context.kind 响应格式无效。");
  }
  const directory = object(record["directory"], "directory work context.directory");
  return { kind: "DIRECTORY",
    directory: { ...workContextDirectoryFrom(directory),
      project: workContextProjectFrom(object(directory["project"],
        "directory work context.directory.project")) },
    linkedGoals: array(record, "linked_goals", "directory work context").map((value) => {
      const goal = object(value, "directory work context.linked_goals");
      return { id: string(goal, "id", "directory work context.linked_goals"),
        title: string(goal, "title", "directory work context.linked_goals"),
        status: string(goal, "status", "directory work context.linked_goals"),
        revision: decimal(goal, "revision", "directory work context.linked_goals") };
    }),
    sessions: array(record, "sessions", "directory work context").map(workContextSessionFrom) };
}

function optionalArray(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

export function projectStateFrom(value: unknown): RelayProjectState {
  const record = object(value, "project state");
  return {
    projectId: string(record, "project_id", "project state"),
    revision: decimal(record, "revision", "project state"),
    phaseKey: string(record, "phase_key", "project state"),
    nextActionTaskId: nullableString(record, "next_action_task_id", "project state"),
    inProgress: optionalArray(record, "in_progress").map((item) => {
      const task = object(item, "project state.in_progress");
      return { taskId: string(task, "task_id", "project state.in_progress"),
        title: string(task, "title", "project state.in_progress"),
        status: string(task, "status", "project state.in_progress"),
        mode: string(task, "mode", "project state.in_progress"),
        revision: decimal(task, "revision", "project state.in_progress") };
    }),
    blockers: optionalArray(record, "blockers").map((item) => {
      const blocker = object(item, "project state.blockers");
      const targetKind = string(blocker, "target_kind", "project state.blockers");
      if (targetKind !== "PROJECT" && targetKind !== "TASK" && targetKind !== "GOAL") {
        throw new Error("project state.blockers.target_kind 响应格式无效。");
      }
      return { blockerId: string(blocker, "blocker_id", "project state.blockers"),
        targetKind, targetId: string(blocker, "target_id", "project state.blockers"),
        reason: string(blocker, "reason", "project state.blockers"),
        sourceRef: string(blocker, "source_ref", "project state.blockers"),
        resolvedAt: nullableString(blocker, "resolved_at", "project state.blockers"),
        createdAt: string(blocker, "created_at", "project state.blockers") };
    }),
    risks: optionalArray(record, "risks").map((item) => {
      const risk = object(item, "project state.risks");
      return { riskId: string(risk, "risk_id", "project state.risks"),
        statement: string(risk, "statement", "project state.risks"),
        sourceRef: string(risk, "source_ref", "project state.risks"),
        confirmationRef: string(risk, "confirmation_ref", "project state.risks"),
        resolvedAt: nullableString(risk, "resolved_at", "project state.risks"),
        createdAt: string(risk, "created_at", "project state.risks") };
    }),
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
        acceptanceRevision: decimal(ref, "acceptance_revision", "completion ref"),
        committedAt: typeof ref["committed_at"] === "string" ? ref["committed_at"] : null
      };
    }),
    allowedActions: optionalArray(record, "allowed_actions")
      .filter((action): action is string => typeof action === "string")
  };
}
