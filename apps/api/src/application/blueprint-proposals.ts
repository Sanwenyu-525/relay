import { randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import type { ProjectBlueprintProposalRow } from '../infrastructure/database-schema.js';
import type { JsonObject, JsonValue } from '../infrastructure/json.js';
import { canonicalizeJson } from '../receipt/payload-hash.js';
import { toDecimalString } from '../shared/decimal.js';
import { FIRST_PARTY_REGISTRY, availableFrozenSkill } from '../skills/first-party-registry.js';
import type { FrozenSkill } from '../skills/first-party-registry.js';
import { loadSkillBasisInSnapshot, SkillBasisUnavailable,
  type SkillBasis } from '../skills/skill-basis.js';
import { skillOutputHash } from '../skills/skill-proposal.js';
import { blueprintHash, buildBlueprintCandidate, normalizeBlueprintDraft,
  resolveBlueprintPack, type BlueprintDraft } from '../blueprint/blueprint-candidate.js';
import { resolveViewTemplate } from '../view/builtin-view.js';
import { LOCAL_ACTOR_REF, httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand, type CommandOutcome } from './command.js';
import { invalidTransition, resourceNotFound, revisionConflict } from './domain-error.js';
import { lockProjectInWorkspace, readProjectInWorkspace } from './guards.js';
import { requireRevision } from './revisions.js';
import { createRepositories, type Repositories } from './unit-of-work.js';

function object(value: JsonValue | undefined): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject : null;
}

export interface CreateBlueprintProposalInput {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly commandId: string;
  readonly expectedProjectRevision: string;
  readonly expectedStateRevision: string;
  readonly expectedViewRevision: string;
  readonly draft: BlueprintDraft;
  readonly supersedesProposalId?: string | null;
}

export async function prepareSkillBlueprintProposal(db: DbExecutor,
  r: Repositories, input: { workspaceId: string; projectId: string;
    messageId: string; skill: FrozenSkill; skillInput: JsonObject | null;
    basis: SkillBasis; output: JsonObject }): Promise<{
      id: string; candidate: JsonObject; baseline: JsonObject;
      source: JsonObject; candidateSha256: string }> {
  const authority = await r.workspaces.lockAuthority(input.workspaceId, 'share');
  if (authority === undefined) throw new SkillBasisUnavailable('SKILL_SCOPE_UNAVAILABLE');
  const project = await r.projects.lockProjectExclusive(input.projectId);
  if (project?.workspace_id !== input.workspaceId || project.archived_at !== null) {
    throw new SkillBasisUnavailable('SKILL_SCOPE_UNAVAILABLE');
  }
  const outputPayload = object(input.output.payload);
  const draftRaw = object(outputPayload?.draft);
  if (draftRaw === null) throw new SkillBasisUnavailable('SKILL_SCOPE_UNAVAILABLE');
  const draft = normalizeBlueprintDraft(draftRaw as unknown as BlueprintDraft,
    project.project_type);
  const pack = resolveBlueprintPack(draft.pack_ref);
  const goal = draft.goal_id === null ? null :
    await r.projects.lockGoal(draft.goal_id) ?? null;
  if (draft.goal_id !== null &&
      (goal === null || goal.workspace_id !== input.workspaceId ||
       goal.status !== 'ACTIVE')) {
    throw new SkillBasisUnavailable('SKILL_BASELINE_STALE');
  }
  const currentTasks = await r.tasks.listProjectTasksByStatus(project.id,
    ['INBOX', 'READY', 'IN_PROGRESS', 'WAITING', 'BLOCKED', 'DONE', 'CANCELLED']);
  for (const taskId of currentTasks.map((task) => task.id).sort()) {
    await r.tasks.lockTask(taskId);
  }
  const existingTask = draft.next_action?.kind === 'EXISTING_TASK'
    ? await r.tasks.lockTask(draft.next_action.task_id) ?? null : null;
  if (draft.next_action?.kind === 'EXISTING_TASK' &&
      existingTask?.project_id !== project.id) {
    throw new SkillBasisUnavailable('SKILL_BASELINE_STALE');
  }
  const state = await r.projects.lockProjectState(project.id);
  const view = await r.views.read(project.id, true);
  if (state === undefined || view?.workspace_id !== input.workspaceId) {
    throw new SkillBasisUnavailable('SKILL_SCOPE_UNAVAILABLE');
  }
  const fresh = await loadSkillBasisInSnapshot(db, input.workspaceId,
    project.id, null, input.skill, input.skillInput);
  if (fresh.factsSha256 !== input.basis.factsSha256 ||
      canonicalizeJson(fresh.baseline) !== canonicalizeJson(input.basis.baseline)) {
    throw new SkillBasisUnavailable('SKILL_BASELINE_STALE');
  }
  const goalLinks = await r.projects.listProjectGoalLinks(project.id);
  const baseline: JsonObject = {
    project_revision: project.revision.toString(),
    state_revision: state.revision.toString(),
    view_revision: view.revision.toString(),
    phase_key: state.phase_key, next_action_task_id: state.next_action_task_id,
    goal_ids: goalLinks.map((link) => link.goal_id),
    goal_ref: goal === null ? null : { id: goal.id,
      revision: goal.revision.toString(), status: goal.status },
    next_action_task_ref: existingTask === null ? null : { id: existingTask.id,
      revision: existingTask.revision.toString() },
    view_configuration: resolveViewTemplate(view.kind),
    read_dependencies: input.basis.baseline,
  };
  const candidate = buildBlueprintCandidate(draft);
  const source: JsonObject = { origin: 'SKILL',
    skill_message_id: input.messageId,
    skill: { id: input.skill.id, version: input.skill.version,
      sha256: input.skill.sha256 },
    skill_output_sha256: skillOutputHash(input.output),
    basis_facts_sha256: input.basis.factsSha256,
    pack };
  return { id: randomUUID(), candidate, baseline, source,
    candidateSha256: blueprintHash(candidate, baseline, source) };
}

export async function createBlueprintProposal(db: DbExecutor,
  input: CreateBlueprintProposalInput): Promise<CommandOutcome<JsonObject>> {
  const projectRevision = requireRevision(input.expectedProjectRevision,
    'expected_project_revision');
  const stateRevision = requireRevision(input.expectedStateRevision,
    'expected_state_revision');
  const viewRevision = requireRevision(input.expectedViewRevision,
    'expected_view_revision');
  return runIdempotentCommand<JsonObject>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId,
    commandType: 'CreateProjectBlueprintProposal',
    target: { project_id: input.projectId },
    body: { expected_project_revision: toDecimalString(projectRevision),
      expected_state_revision: toDecimalString(stateRevision),
      expected_view_revision: toDecimalString(viewRevision),
      draft: input.draft as unknown as JsonObject,
      supersedes_proposal_id: input.supersedesProposalId ?? null },
    execute: async (r) => {
      let old: ProjectBlueprintProposalRow | undefined;
      if (input.supersedesProposalId !== undefined &&
          input.supersedesProposalId !== null) {
        old = await r.blueprints.read(input.supersedesProposalId, true);
        if (old?.workspace_id !== input.workspaceId ||
            old.project_id !== input.projectId) throw resourceNotFound('Blueprint proposal');
        if (old.status !== 'PENDING') {
          throw invalidTransition('只能替换待确认的蓝图候选。');
        }
      }
      const project = await lockProjectInWorkspace(r,
        input.workspaceId, input.projectId);
      if (project.archived_at !== null) throw invalidTransition('已归档 Project 不可应用蓝图。');
      if (project.revision !== projectRevision) {
        throw revisionConflict({ entityType: 'PROJECT',
          expectedRevision: toDecimalString(projectRevision),
          actualRevision: toDecimalString(project.revision) });
      }
      const draft = normalizeBlueprintDraft(input.draft, project.project_type);
      const pack = resolveBlueprintPack(draft.pack_ref);
      const goal = draft.goal_id === null ? null :
        await r.projects.lockGoal(draft.goal_id) ?? null;
      if (draft.goal_id !== null &&
          (goal === null || goal.workspace_id !== input.workspaceId || goal.status !== 'ACTIVE')) {
        throw resourceNotFound('Goal');
      }
      const nextTask = draft.next_action?.kind === 'EXISTING_TASK'
        ? await r.tasks.lockTask(draft.next_action.task_id) ?? null : null;
      if (draft.next_action?.kind === 'EXISTING_TASK' &&
          (nextTask === null || nextTask.project_id !== project.id)) throw resourceNotFound('Task');
      const state = await r.projects.lockProjectState(project.id);
      const view = await r.views.read(project.id, true);
      if (state === undefined || view?.workspace_id !== input.workspaceId) {
        throw resourceNotFound('Project configuration');
      }
      if (state.revision !== stateRevision || view.revision !== viewRevision) {
        throw revisionConflict({ entityType: state.revision !== stateRevision
          ? 'PROJECT_STATE' : 'VIEW_CONFIGURATION',
          expectedRevision: toDecimalString(state.revision !== stateRevision
            ? stateRevision : viewRevision),
          actualRevision: toDecimalString(state.revision !== stateRevision
            ? state.revision : view.revision) });
      }
      const goalLinks = await r.projects.listProjectGoalLinks(project.id);
      const nextActionChanges = draft.next_action === null ? false :
        draft.next_action.kind === 'NEW_TASK' ? true :
        draft.next_action.kind === 'CLEAR' ? state.next_action_task_id !== null :
        draft.next_action.task_id !== state.next_action_task_id;
      if (draft.tasks.length === 0 &&
          (draft.goal_id === null || goalLinks.some((link) => link.goal_id === draft.goal_id)) &&
          (draft.phase_key === null || draft.phase_key === state.phase_key) &&
          !nextActionChanges && draft.view_kind === view.kind) {
        throw invalidTransition('蓝图没有可应用的业务或展示变化。');
      }
      const baseline: JsonObject = {
        project_revision: toDecimalString(project.revision),
        state_revision: toDecimalString(state.revision),
        view_revision: toDecimalString(view.revision),
        phase_key: state.phase_key,
        next_action_task_id: state.next_action_task_id,
        goal_ids: goalLinks.map((link) => link.goal_id),
        goal_ref: goal === null ? null : { id: goal.id,
          revision: toDecimalString(goal.revision), status: goal.status },
        next_action_task_ref: nextTask === null ? null : { id: nextTask.id,
          revision: toDecimalString(nextTask.revision) },
        view_configuration: resolveViewTemplate(view.kind),
      };
      const candidate = buildBlueprintCandidate(draft);
      const source: JsonObject = { origin: 'USER_DRAFT', pack };
      const candidateSha256 = blueprintHash(candidate, baseline, source);
      const id = randomUUID();
      const inserted = await r.blueprints.insert({ id, workspaceId: input.workspaceId,
        projectId: project.id, origin: 'USER_DRAFT',
        supersedesProposalId: old?.id ?? null,
        candidate, baseline, source, candidateSha256 });
      if (old !== undefined) {
        await r.blueprints.settle(old.id, 'PENDING', 'SUPERSEDED',
          { superseded_by: id });
      }
      await r.activities.insertActivityRecord({ id: randomUUID(),
        workspaceId: input.workspaceId, actorKind: 'HUMAN',
        actorRef: LOCAL_ACTOR_REF, commandId: input.commandId,
        projectId: project.id, taskId: null,
        eventType: 'PROJECT_BLUEPRINT_PROPOSED', factRefs: {
          proposal_id: id, candidate_sha256: candidateSha256,
          pack_id: pack?.id ?? null, pack_version: pack?.version ?? null,
        } });
      return projectBlueprintDto(inserted, false);
    },
  });
}

export async function readBlueprintProposal(db: DbExecutor, input: {
  readonly workspaceId: string; readonly projectId: string;
  readonly proposalId: string;
}): Promise<JsonObject> {
  return db.transaction().setIsolationLevel('repeatable read').execute(async (snapshot) => {
    const r = createRepositories(snapshot);
    if (await r.workspaces.lockAuthority(input.workspaceId, 'share') === undefined) {
      throw resourceNotFound('Workspace authority');
    }
    await readProjectInWorkspace(r, input.workspaceId, input.projectId);
    const row = await r.blueprints.read(input.proposalId);
    if (row?.workspace_id !== input.workspaceId || row.project_id !== input.projectId) {
      throw resourceNotFound('Blueprint proposal');
    }
    const sourceAvailable = await blueprintSourceAvailable(r, row);
    return projectBlueprintDto(row,
      !sourceAvailable || await blueprintIsStale(r, row), sourceAvailable);
  });
}

export async function listBlueprintProposals(db: DbExecutor, input: {
  readonly workspaceId: string; readonly projectId: string;
}): Promise<JsonObject> {
  return db.transaction().setIsolationLevel('repeatable read').execute(async (snapshot) => {
    const r = createRepositories(snapshot);
    if (await r.workspaces.lockAuthority(input.workspaceId, 'share') === undefined) {
      throw resourceNotFound('Workspace authority');
    }
    await readProjectInWorkspace(r, input.workspaceId, input.projectId);
    const rows = await r.blueprints.list(input.workspaceId, input.projectId);
    return { items: await Promise.all(rows.map(async (row) => {
      const sourceAvailable = await blueprintSourceAvailable(r, row);
      return projectBlueprintDto(row,
        !sourceAvailable || await blueprintIsStale(r, row), sourceAvailable);
    })) };
  });
}

async function blueprintSourceAvailable(r: Repositories,
  proposal: ProjectBlueprintProposalRow): Promise<boolean> {
  if (proposal.origin !== 'SKILL') return true;
  const message = proposal.skill_message_id === null ? undefined :
    await r.assist.readMessage(proposal.skill_message_id);
  const session = message === undefined ? undefined :
    await r.assist.readSession(message.session_id);
  if (message?.status !== 'COMPLETED' ||
      session?.workspace_id !== proposal.workspace_id ||
      session.project_id !== proposal.project_id ||
      message.skill_output === null) return false;
  for (const raw of Array.isArray(message.sources) ? message.sources : []) {
    const ref = object(raw);
    if (ref === null ||
        (ref.kind !== 'KNOWLEDGE' && ref.kind !== 'MEMORY' &&
         ref.kind !== 'DECISION') || typeof ref.root_id !== 'string') return false;
    const root = await r.information.readRoot(ref.kind.toLowerCase() as
      'knowledge' | 'memory' | 'decision', ref.root_id);
    if (root?.workspace_id !== proposal.workspace_id ||
        root.status !== 'ACTIVE' ||
        root.project_id !== null && root.project_id !== proposal.project_id) return false;
  }
  return true;
}

export async function blueprintIsStale(r: Repositories,
  proposal: ProjectBlueprintProposalRow): Promise<boolean> {
  if (proposal.status !== 'PENDING') return false;
  const project = await r.projects.readProject(proposal.project_id);
  const state = await r.projects.readProjectState(proposal.project_id);
  const view = await r.views.read(proposal.project_id);
  const baseline = proposal.baseline;
  if (project?.workspace_id !== proposal.workspace_id ||
      project.archived_at !== null || state === undefined || view === undefined ||
      project.revision.toString() !== baseline.project_revision ||
      state.revision.toString() !== baseline.state_revision ||
      view.revision.toString() !== baseline.view_revision ||
      canonicalizeJson(resolveViewTemplate(view.kind)) !==
        canonicalizeJson(baseline.view_configuration ?? null)) return true;
  const goalRef = object(baseline.goal_ref);
  if (baseline.goal_ref !== null && baseline.goal_ref !== undefined) {
    if (goalRef === null) return true;
    const goal = await r.projects.readGoal(String(goalRef.id));
    if (goal?.workspace_id !== proposal.workspace_id || goal.status !== 'ACTIVE' ||
        goal.revision.toString() !== goalRef.revision) return true;
  }
  const taskRef = object(baseline.next_action_task_ref);
  if (baseline.next_action_task_ref !== null && baseline.next_action_task_ref !== undefined) {
    if (taskRef === null) return true;
    const task = await r.tasks.readTask(String(taskRef.id));
    if (task?.project_id !== proposal.project_id ||
        task.revision.toString() !== taskRef.revision) return true;
  }
  const pack = object(proposal.source.pack);
  if (proposal.source.pack !== null && proposal.source.pack !== undefined) {
    if (pack === null) return true;
    const current = FIRST_PARTY_REGISTRY.pack(String(pack.id), String(pack.version));
    if (current === undefined || current.sha256 !== pack.sha256 ||
        current.availability !== 'AVAILABLE') return true;
  }
  if (proposal.origin === 'SKILL') {
    const message = proposal.skill_message_id === null ? undefined :
      await r.assist.readMessage(proposal.skill_message_id);
    const session = message === undefined ? undefined :
      await r.assist.readSession(message.session_id);
    const sourceSkill = message?.skill_snapshot === null ||
      message?.skill_snapshot === undefined ? null :
      availableFrozenSkill(message.skill_snapshot);
    const frozenRef = object(proposal.source.skill);
    if (message?.status !== 'COMPLETED' ||
        session?.workspace_id !== proposal.workspace_id ||
        session.project_id !== proposal.project_id ||
        sourceSkill === null || frozenRef?.sha256 !== sourceSkill.sha256 ||
        message.skill_output === null ||
        proposal.source.skill_output_sha256 !== skillOutputHash(message.skill_output)) {
      return true;
    }
    for (const raw of Array.isArray(message.sources) ? message.sources : []) {
      const ref = object(raw);
      if (ref === null ||
          (ref.kind !== 'KNOWLEDGE' && ref.kind !== 'MEMORY' &&
           ref.kind !== 'DECISION') || typeof ref.root_id !== 'string') return true;
      const root = await r.information.readRoot(ref.kind.toLowerCase() as
        'knowledge' | 'memory' | 'decision', ref.root_id);
      if (root?.workspace_id !== proposal.workspace_id ||
          root.status !== 'ACTIVE' ||
          root.project_id !== null && root.project_id !== proposal.project_id) return true;
    }
    const dependencies = object(baseline.read_dependencies);
    if (dependencies === null || !Array.isArray(dependencies.tasks)) return true;
    const taskRows = await r.tasks.listProjectTasksByStatus(proposal.project_id,
      ['INBOX', 'READY', 'IN_PROGRESS', 'WAITING', 'BLOCKED', 'DONE', 'CANCELLED']);
    const currentTasks = taskRows.map((task) => ({ id: task.id,
      revision: task.revision.toString(),
      acceptance_revision: task.acceptance_revision.toString(),
      current_completion_id: task.current_completion_id })).sort((a, b) =>
      a.id.localeCompare(b.id));
    const previousTasks = dependencies.tasks.map(object);
    if (previousTasks.some((task) => task === null) ||
        canonicalizeJson(previousTasks.sort((a, b) =>
          String(a?.id).localeCompare(String(b?.id)))) !==
          canonicalizeJson(currentTasks)) return true;
  }
  return blueprintHash(proposal.candidate, proposal.baseline,
    proposal.source) !== proposal.candidate_sha256;
}

export function projectBlueprintDto(row: ProjectBlueprintProposalRow,
  stale: boolean, sourceAvailable = true): JsonObject {
  const candidate = row.candidate;
  const baseline = row.baseline;
  const currentView = baseline.view_configuration;
  return { id: row.id, workspace_id: row.workspace_id,
    project_id: row.project_id, status: row.status, origin: row.origin,
    skill_message_id: row.skill_message_id,
    supersedes_proposal_id: row.supersedes_proposal_id,
    candidate_sha256: row.candidate_sha256,
    candidate: sourceAvailable ? candidate : null,
    baseline: sourceAvailable ? baseline : null,
    source: row.source, stale,
    content_availability: sourceAvailable ? 'AVAILABLE' : 'SOURCE_UNAVAILABLE',
    diff: sourceAvailable ? { goal_link: { before_goal_ids: baseline.goal_ids ?? null,
      add_goal_id: candidate.goal_id ?? null },
      state: { phase: { before: baseline.phase_key ?? null, after: candidate.phase_key ?? null },
        next_action: { before_task_id: baseline.next_action_task_id ?? null,
          after: candidate.next_action ?? null } },
      new_tasks: candidate.tasks ?? null,
      view_configuration: { before: currentView ?? null,
        after: candidate.view_configuration ?? null,
        changed: canonicalizeJson(currentView ?? null) !==
          canonicalizeJson(candidate.view_configuration ?? null) } } : null,
    follow_up_suggestions: sourceAvailable
      ? candidate.follow_up_suggestions ?? null : [],
    decision: row.decision, created_at: row.created_at.toISOString(),
    decided_at: row.decided_at?.toISOString() ?? null,
    updated_at: row.updated_at.toISOString() };
}
