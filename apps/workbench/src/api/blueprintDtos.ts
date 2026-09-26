import type { RelayViewKind } from "./relayClient";

export interface RelayBlueprintTaskDraft {
  readonly local_key: string;
  readonly title: string;
  readonly objective: string;
}
export type RelayBlueprintNextAction =
  | { readonly kind: "NEW_TASK"; readonly local_key: string }
  | { readonly kind: "EXISTING_TASK"; readonly task_id: string }
  | { readonly kind: "CLEAR" };
export interface RelayBlueprintDraft {
  readonly intent: string;
  readonly goal_id: string | null;
  readonly phase_key: string | null;
  readonly tasks: readonly RelayBlueprintTaskDraft[];
  readonly next_action: RelayBlueprintNextAction | null;
  readonly view_kind: RelayViewKind;
  readonly pack_ref: { readonly id: string; readonly version: string } | null;
}
export interface RelayBlueprintTemplate {
  readonly kind: RelayViewKind;
  readonly templateVersion: string;
  readonly templateSha256: string;
  readonly pages: readonly { readonly pageId: string; readonly visible: boolean; readonly position: number }[];
}
export interface RelayBlueprintProposal {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly status: "PENDING" | "ACCEPTED" | "REJECTED" | "SUPERSEDED" | "EXPIRED";
  readonly origin: "USER_DRAFT" | "SKILL";
  readonly contentAvailability: "AVAILABLE" | "SOURCE_UNAVAILABLE";
  readonly skillMessageId: string | null;
  readonly supersedesProposalId: string | null;
  readonly candidateSha256: string;
  readonly candidate: {
    readonly intent: string;
    readonly goalId: string | null;
    readonly phaseKey: string | null;
    readonly tasks: readonly (RelayBlueprintTaskDraft & { readonly mode: string;
      readonly status: string; readonly executorKind: string })[];
    readonly nextAction: RelayBlueprintNextAction | null;
    readonly viewConfiguration: RelayBlueprintTemplate;
  } | null;
  readonly baseline: {
    readonly projectRevision: string; readonly stateRevision: string;
    readonly viewRevision: string; readonly phaseKey: string;
    readonly nextActionTaskId: string | null; readonly goalIds: readonly string[];
    readonly viewConfiguration: RelayBlueprintTemplate;
  } | null;
  readonly source: { readonly origin: string;
    readonly pack: { readonly id: string; readonly version: string;
      readonly sha256: string } | null;
    readonly skill: { readonly id: string; readonly version: string;
      readonly sha256: string } | null;
    readonly skillOutputSha256: string | null;
    readonly basisFactsSha256: string | null };
  readonly stale: boolean;
  readonly diff: {
    readonly goalLink: { readonly beforeGoalIds: readonly string[];
      readonly addGoalId: string | null };
    readonly state: { readonly phase: { readonly before: string | null;
      readonly after: string | null }; readonly nextAction: {
      readonly beforeTaskId: string | null;
      readonly after: RelayBlueprintNextAction | null } };
    readonly newTasks: readonly (RelayBlueprintTaskDraft & { readonly mode: string;
      readonly status: string; readonly executorKind: string })[];
    readonly viewConfiguration: { readonly before: RelayBlueprintTemplate;
      readonly after: RelayBlueprintTemplate; readonly changed: boolean };
  } | null;
  readonly followUpSuggestions: readonly { readonly kind: string; readonly summary: string }[];
  readonly appliedResult: RelayBlueprintApplyResult | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface RelayBlueprintApplyResult {
  readonly proposalId: string; readonly candidateSha256: string;
  readonly projectId: string; readonly projectRevision: string;
  readonly stateRevision: string; readonly viewRevision: string;
  readonly goalIds: readonly string[];
  readonly taskIdMap: readonly { readonly localKey: string; readonly taskId: string;
    readonly status: string; readonly revision: string }[];
  readonly nextActionTaskId: string | null;
  readonly viewConfiguration: RelayBlueprintTemplate;
  readonly appliedEffects: { readonly goalLinked: boolean; readonly tasksCreated: number;
    readonly stateChanged: boolean; readonly viewChanged: boolean };
}
export interface RelayProjectGoal {
  readonly goalId: string; readonly title: string; readonly status: string;
  readonly revision: string;
}
export interface RelayGoal {
  readonly id: string; readonly title: string; readonly status: string;
  readonly revision: string;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} 响应格式无效。`);
  }
  return value as Record<string, unknown>;
}
function string(row: Record<string, unknown>, key: string, name: string): string {
  if (typeof row[key] !== "string") throw new Error(`${name}.${key} 响应格式无效。`);
  return row[key] as string;
}
function nullable(row: Record<string, unknown>, key: string, name: string): string | null {
  if (row[key] === null) return null;
  return string(row, key, name);
}
function decimal(row: Record<string, unknown>, key: string, name: string): string {
  const value = string(row, key, name);
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) throw new Error(`${name}.${key} 不是十进制修订。`);
  return value;
}
function array(row: Record<string, unknown>, key: string, name: string): unknown[] {
  if (!Array.isArray(row[key])) throw new Error(`${name}.${key} 响应格式无效。`);
  return row[key] as unknown[];
}
function strings(row: Record<string, unknown>, key: string, name: string): readonly string[] {
  return array(row, key, name).map((item) => {
    if (typeof item !== "string") throw new Error(`${name}.${key} 响应格式无效。`);
    return item;
  });
}
function boolean(row: Record<string, unknown>, key: string, name: string): boolean {
  if (typeof row[key] !== "boolean") throw new Error(`${name}.${key} 响应格式无效。`);
  return row[key] as boolean;
}
function viewKind(row: Record<string, unknown>, key: string, name: string): RelayViewKind {
  const value = string(row, key, name);
  if (value !== "general" && value !== "thesis" && value !== "development") {
    throw new Error(`${name}.${key} 未知。`);
  }
  return value;
}
export function blueprintTemplateFrom(value: unknown): RelayBlueprintTemplate {
  const row = object(value, "blueprint template");
  return { kind: viewKind(row, "kind", "blueprint template"),
    templateVersion: string(row, "template_version", "blueprint template"),
    templateSha256: string(row, "template_sha256", "blueprint template"),
    pages: array(row, "pages", "blueprint template").map((item) => {
      const page = object(item, "blueprint template page");
      const position = page.position;
      if (typeof position !== "number" || !Number.isSafeInteger(position) || position < 0) {
        throw new Error("blueprint template page.position 响应格式无效。");
      }
      return { pageId: string(page, "page_id", "blueprint template page"),
        visible: boolean(page, "visible", "blueprint template page"), position };
    }) };
}
function nextActionFrom(value: unknown): RelayBlueprintNextAction | null {
  if (value === null) return null;
  const row = object(value, "blueprint next action");
  const kind = string(row, "kind", "blueprint next action");
  if (kind === "NEW_TASK") return { kind, local_key: string(row, "local_key", "blueprint next action") };
  if (kind === "EXISTING_TASK") return { kind, task_id: string(row, "task_id", "blueprint next action") };
  if (kind === "CLEAR") return { kind };
  throw new Error("blueprint next action.kind 未知。");
}
function taskFrom(value: unknown) {
  const row = object(value, "blueprint task");
  return { local_key: string(row, "local_key", "blueprint task"),
    title: string(row, "title", "blueprint task"),
    objective: string(row, "objective", "blueprint task"),
    mode: string(row, "mode", "blueprint task"),
    status: string(row, "status", "blueprint task"),
    executorKind: string(row, "executor_kind", "blueprint task") };
}
export function blueprintProposalFrom(value: unknown): RelayBlueprintProposal {
  const row = object(value, "blueprint proposal");
  const status = string(row, "status", "blueprint proposal");
  const origin = string(row, "origin", "blueprint proposal");
  const availability = string(row, "content_availability", "blueprint proposal");
  if (!["PENDING", "ACCEPTED", "REJECTED", "SUPERSEDED", "EXPIRED"].includes(status) ||
    (origin !== "USER_DRAFT" && origin !== "SKILL") ||
    (availability !== "AVAILABLE" && availability !== "SOURCE_UNAVAILABLE")) {
    throw new Error("blueprint proposal 状态或来源未知。");
  }
  if (availability === "SOURCE_UNAVAILABLE" &&
    (row.candidate !== null || row.baseline !== null || row.diff !== null)) {
    throw new Error("不可用蓝图提案仍返回了正文。");
  }
  const candidate = row.candidate === null ? null : object(row.candidate, "blueprint candidate");
  const baseline = row.baseline === null ? null : object(row.baseline, "blueprint baseline");
  const source = object(row.source, "blueprint source");
  const diff = row.diff === null ? null : object(row.diff, "blueprint diff");
  if (availability === "AVAILABLE" && (!candidate || !baseline || !diff)) {
    throw new Error("可用蓝图提案缺少候选正文或基线。");
  }
  const goalLink = diff && object(diff.goal_link, "blueprint diff.goal_link");
  const state = diff && object(diff.state, "blueprint diff.state");
  const phase = state && object(state.phase, "blueprint diff.state.phase");
  const nextAction = state && object(state.next_action, "blueprint diff.state.next_action");
  const view = diff && object(diff.view_configuration, "blueprint diff.view_configuration");
  const pack = source.pack === null ? null : object(source.pack, "blueprint source.pack");
  const skill = origin === "SKILL" ? object(source.skill, "blueprint source.skill") : null;
  if (source.origin !== origin || (origin === "SKILL" &&
    source.skill_message_id !== row.skill_message_id)) {
    throw new Error("blueprint proposal 来源身份不匹配。");
  }
  return { id: string(row, "id", "blueprint proposal"),
    workspaceId: string(row, "workspace_id", "blueprint proposal"),
    projectId: string(row, "project_id", "blueprint proposal"),
    status: status as RelayBlueprintProposal["status"], origin,
    contentAvailability: availability,
    skillMessageId: nullable(row, "skill_message_id", "blueprint proposal"),
    supersedesProposalId: nullable(row, "supersedes_proposal_id", "blueprint proposal"),
    candidateSha256: string(row, "candidate_sha256", "blueprint proposal"),
    candidate: candidate && { intent: string(candidate, "intent", "blueprint candidate"),
      goalId: nullable(candidate, "goal_id", "blueprint candidate"),
      phaseKey: nullable(candidate, "phase_key", "blueprint candidate"),
      tasks: array(candidate, "tasks", "blueprint candidate").map(taskFrom),
      nextAction: nextActionFrom(candidate.next_action),
      viewConfiguration: blueprintTemplateFrom(candidate.view_configuration) },
    baseline: baseline && { projectRevision: decimal(baseline, "project_revision", "blueprint baseline"),
      stateRevision: decimal(baseline, "state_revision", "blueprint baseline"),
      viewRevision: decimal(baseline, "view_revision", "blueprint baseline"),
      phaseKey: string(baseline, "phase_key", "blueprint baseline"),
      nextActionTaskId: nullable(baseline, "next_action_task_id", "blueprint baseline"),
      goalIds: strings(baseline, "goal_ids", "blueprint baseline"),
      viewConfiguration: blueprintTemplateFrom(baseline.view_configuration) },
    source: { origin: string(source, "origin", "blueprint source"),
      pack: pack === null ? null : { id: string(pack, "id", "blueprint source.pack"),
        version: string(pack, "version", "blueprint source.pack"),
        sha256: string(pack, "sha256", "blueprint source.pack") },
      skill: skill === null ? null : { id: string(skill, "id", "blueprint source.skill"),
        version: string(skill, "version", "blueprint source.skill"),
        sha256: string(skill, "sha256", "blueprint source.skill") },
      skillOutputSha256: skill ? string(source, "skill_output_sha256", "blueprint source") : null,
      basisFactsSha256: skill ? string(source, "basis_facts_sha256", "blueprint source") : null },
    stale: boolean(row, "stale", "blueprint proposal"),
    diff: diff && goalLink && state && phase && nextAction && view && { goalLink: { beforeGoalIds: strings(goalLink, "before_goal_ids", "blueprint diff.goal_link"),
      addGoalId: nullable(goalLink, "add_goal_id", "blueprint diff.goal_link") },
      state: { phase: { before: nullable(phase, "before", "blueprint diff.state.phase"),
        after: nullable(phase, "after", "blueprint diff.state.phase") },
      nextAction: { beforeTaskId: nullable(nextAction, "before_task_id", "blueprint diff.state.next_action"),
        after: nextActionFrom(nextAction.after) } },
      newTasks: array(diff, "new_tasks", "blueprint diff").map(taskFrom),
      viewConfiguration: { before: blueprintTemplateFrom(view.before),
        after: blueprintTemplateFrom(view.after),
        changed: boolean(view, "changed", "blueprint diff.view_configuration") } },
    followUpSuggestions: array(row, "follow_up_suggestions", "blueprint proposal").map((item) => {
      const suggestion = object(item, "blueprint follow-up");
      return { kind: string(suggestion, "kind", "blueprint follow-up"),
        summary: string(suggestion, "summary", "blueprint follow-up") };
    }),
    appliedResult: status === "ACCEPTED" && typeof row.decision === "object" && row.decision !== null &&
      !Array.isArray(row.decision) && (row.decision as Record<string, unknown>).result
      ? blueprintApplyResultFrom((row.decision as Record<string, unknown>).result) : null,
    createdAt: string(row, "created_at", "blueprint proposal"),
    updatedAt: string(row, "updated_at", "blueprint proposal") };
}

export function blueprintApplyResultFrom(value: unknown): RelayBlueprintApplyResult {
  const row = object(value, "blueprint apply result");
  const effects = object(row.applied_effects, "blueprint apply effects");
  return { proposalId: string(row, "proposal_id", "blueprint apply result"),
    candidateSha256: string(row, "candidate_sha256", "blueprint apply result"),
    projectId: string(row, "project_id", "blueprint apply result"),
    projectRevision: decimal(row, "project_revision", "blueprint apply result"),
    stateRevision: decimal(row, "state_revision", "blueprint apply result"),
    viewRevision: decimal(row, "view_revision", "blueprint apply result"),
    goalIds: strings(row, "goal_ids", "blueprint apply result"),
    taskIdMap: array(row, "task_id_map", "blueprint apply result").map((item) => {
      const task = object(item, "blueprint apply task");
      return { localKey: string(task, "local_key", "blueprint apply task"),
        taskId: string(task, "task_id", "blueprint apply task"),
        status: string(task, "status", "blueprint apply task"),
        revision: decimal(task, "revision", "blueprint apply task") };
    }),
    nextActionTaskId: nullable(row, "next_action_task_id", "blueprint apply result"),
    viewConfiguration: blueprintTemplateFrom(row.view_configuration),
    appliedEffects: { goalLinked: boolean(effects, "goal_linked", "blueprint apply effects"),
      tasksCreated: Number(effects.tasks_created),
      stateChanged: boolean(effects, "state_changed", "blueprint apply effects"),
      viewChanged: boolean(effects, "view_changed", "blueprint apply effects") } };
}

export function projectGoalListFrom(value: unknown): readonly RelayProjectGoal[] {
  const row = object(value, "project goals");
  return array(row, "items", "project goals").map((item) => {
    const goal = object(item, "project goal");
    return { goalId: string(goal, "goal_id", "project goal"),
      title: string(goal, "title", "project goal"),
      status: string(goal, "status", "project goal"),
      revision: decimal(goal, "revision", "project goal") };
  });
}
export function goalFrom(value: unknown): RelayGoal {
  const row = object(value, "goal");
  return { id: string(row, "id", "goal"), title: string(row, "title", "goal"),
    status: string(row, "status", "goal"), revision: decimal(row, "revision", "goal") };
}
