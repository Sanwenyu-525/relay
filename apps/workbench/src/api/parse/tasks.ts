import { array, availability, boolean, decimal, executorKind, interactionMode, nullableString, object, optionalString, string, stringArray, stringList, taskStatus } from "../core/primitives";
import type { RelayCompletion, RelayCompletionEvidence, RelayReopen, RelayTaskAcceptance, RelayTaskAcceptanceRevision, RelayTaskCheckPlanPreview, RelayTaskCreation, RelayTaskDependency, RelayTaskMutation, RelayTaskSummary, RelayToday, RelayTodayItem, RelayTodayPriority } from "../dtos/tasks";

export function taskFrom(value: unknown): RelayTaskSummary {
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

export function acceptanceFrom(record: Record<string, unknown>): RelayTaskAcceptance {
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
        required: boolean(criterion, "required", "criterion"),
        method: string(criterion, "method", "criterion"),
        targetSpec: criterion.target_spec === undefined ? null
          : object(criterion.target_spec, "task.acceptance.criteria.target_spec")
      };
    })
  };
}

export function taskCheckPlanPreviewFrom(value: unknown, taskId: string): RelayTaskCheckPlanPreview {
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

export function dependencyFrom(value: unknown): RelayTaskDependency {
  const record = object(value, "task dependency");
  return {
    taskId: string(record, "task_id", "task dependency"),
    dependencyKind: string(record, "dependency_kind", "task dependency"),
    status: taskStatus(record, "status", "task dependency"),
    title: string(record, "title", "task dependency")
  };
}

export function todayPriority(record: Record<string, unknown>, key: string, name: string): RelayTodayPriority | null {
  if (record[key] === null) return null;
  const value = string(record, key, name);
  if (value !== "LOW" && value !== "NORMAL" && value !== "HIGH") throw new Error(`${name}.${key} 响应格式无效。`);
  return value;
}

export function todayItemFrom(value: unknown): RelayTodayItem {
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

export function todayFrom(value: unknown): RelayToday {
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

export function completionEvidenceFrom(value: unknown): RelayCompletionEvidence {
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

export function taskAcceptanceRevisionFrom(result: Readonly<Record<string, unknown>>): RelayTaskAcceptanceRevision {
  return { taskId: string(result, "task_id", "acceptance revision"),
    status: taskStatus(result, "status", "acceptance revision"),
    revision: decimal(result, "revision", "acceptance revision"),
    previousAcceptanceRevision: decimal(result, "previous_acceptance_revision", "acceptance revision"),
    acceptanceRevision: decimal(result, "acceptance_revision", "acceptance revision") };
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
