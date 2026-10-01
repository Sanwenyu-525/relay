import { randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject, JsonValue } from '../infrastructure/json.js';
import type { ManagedContentStore } from '../storage/managed-content-store.js';
import { blueprintHash, buildBlueprintCandidate, normalizeBlueprintDraft } from '../blueprint/blueprint-candidate.js';
import { canonicalizeJson, computePayloadHash } from '../receipt/payload-hash.js';
import { toDecimalString } from '../shared/decimal.js';
import { FIRST_PARTY_REGISTRY, availableFrozenSkill,
  type FrozenSkill } from '../skills/first-party-registry.js';
import { loadSkillBasisInSnapshot } from '../skills/skill-basis.js';
import { skillOutputHash } from '../skills/skill-proposal.js';
import { resolveViewTemplate } from '../view/builtin-view.js';
import { LOCAL_ACTOR_REF, httpCommandScopeKey } from './actor.js';
import { CommandIdReusedError, runIdempotentCommand, resolveExistingReceipt,
  type CommandOutcome } from './command.js';
import { applyTaskCreation, prepareTaskCreation } from './create-task.js';
import { DomainError, invalidTransition, resourceNotFound,
  revisionConflict, validationFailed } from './domain-error.js';
import { lockProjectInWorkspace } from './guards.js';
import { requireRevision } from './revisions.js';
import { normalizeStateAction } from './state-action.js';
import { applyAction } from './state-commands.js';
import { createRepositories } from './unit-of-work.js';
import { loadAssistSourceContent } from './assist-runner.js';
import { readAdmission, requireNormalAdmission } from './maintenance-admission.js';

function object(value: JsonValue | undefined): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject : null;
}

export async function applyBlueprintProposal(db: DbExecutor, input: {
  readonly workspaceId: string; readonly projectId: string;
  readonly proposalId: string; readonly commandId: string;
  readonly candidateSha256: string;
  readonly expectedProjectRevision: string;
  readonly expectedStateRevision: string;
  readonly expectedViewRevision: string;
  readonly storage?: ManagedContentStore;
}): Promise<CommandOutcome<JsonObject>> {
  const expectedProject = requireRevision(input.expectedProjectRevision,
    'expected_project_revision');
  const expectedState = requireRevision(input.expectedStateRevision,
    'expected_state_revision');
  const expectedView = requireRevision(input.expectedViewRevision,
    'expected_view_revision');
  if (!/^[0-9a-f]{64}$/u.test(input.candidateSha256)) {
    throw validationFailed([{ field: 'candidate_sha256', message: 'invalid SHA-256' }]);
  }
  const scopeKey = httpCommandScopeKey(input.workspaceId);
  const payloadHash = computePayloadHash({ commandType: 'ApplyProjectBlueprint',
    target: { project_id: input.projectId, proposal_id: input.proposalId },
    body: { candidate_sha256: input.candidateSha256,
      expected_project_revision: toDecimalString(expectedProject),
      expected_state_revision: toDecimalString(expectedState),
      expected_view_revision: toDecimalString(expectedView) } });
  let expiredWith: DomainError | null = null;
  const committed = await db.transaction().execute(async (trx) => {
    const r = createRepositories(trx);
    const existingReceipt = await r.receipts.findReceipt({ scopeKey,
      commandId: input.commandId });
    if (existingReceipt !== undefined) {
      if (!Buffer.from(existingReceipt.payload_hash).equals(payloadHash)) {
        throw new CommandIdReusedError(scopeKey, input.commandId);
      }
      return { result: existingReceipt.result_ref as JsonObject,
        replayed: true, committedAt: existingReceipt.created_at };
    }
    const gate = await readAdmission(r, 'share');
    const committedWhileWaiting = await r.receipts.findReceipt({ scopeKey,
      commandId: input.commandId });
    if (committedWhileWaiting !== undefined) {
      return resolveExistingReceipt<JsonObject>(committedWhileWaiting, payloadHash);
    }
    requireNormalAdmission(gate);
    const proposal = await r.blueprints.read(input.proposalId, true);
    if (proposal?.workspace_id !== input.workspaceId ||
        proposal.project_id !== input.projectId) throw resourceNotFound('Blueprint proposal');
    if (proposal.candidate_sha256 !== input.candidateSha256 ||
        blueprintHash(proposal.candidate, proposal.baseline,
          proposal.source) !== proposal.candidate_sha256) {
      throw invalidTransition('蓝图候选摘要与本次确认不一致。');
    }
    if (proposal.status === 'ACCEPTED') {
      const result = object(proposal.decision?.result);
      if (result === null) throw invalidTransition('蓝图应用记录不可核对。');
      const receipt = await r.receipts.insertReceipt({ scopeKey,
        commandId: input.commandId, commandType: 'ApplyProjectBlueprint',
        payloadHash, result });
      return { result, replayed: true, committedAt: receipt.created_at };
    }
    if (proposal.status !== 'PENDING') {
      throw invalidTransition('蓝图候选已拒绝、过期或被替代。');
    }
    const baseline = proposal.baseline;
    if (baseline.project_revision !== toDecimalString(expectedProject) ||
        baseline.state_revision !== toDecimalString(expectedState) ||
        baseline.view_revision !== toDecimalString(expectedView)) {
      throw invalidTransition('确认的蓝图基线与原候选不一致。');
    }
    const candidate = proposal.candidate;
    const selectedView = object(candidate.view_configuration);
    if (selectedView === null ||
        !['general', 'thesis', 'development'].includes(String(selectedView.kind)) ||
        selectedView.template_sha256 !==
          resolveViewTemplate(selectedView.kind as 'general' | 'thesis' |
            'development').template_sha256 ||
        !Array.isArray(candidate.tasks) || candidate.tasks.length > 5) {
      throw invalidTransition('蓝图注册模板或任务形态已不可用。');
    }
    const pack = object(proposal.source.pack);
    if (pack !== null) {
      const current = FIRST_PARTY_REGISTRY.pack(String(pack.id), String(pack.version));
      if (current === undefined || current.sha256 !== pack.sha256 ||
          current.availability !== 'AVAILABLE') {
        throw invalidTransition('本次 Pack 来源不再可用。');
      }
    }
    let sourceSkill: FrozenSkill | null = null;
    let sourceMessage = null as NonNullable<Awaited<ReturnType<typeof r.assist.readMessage>>> | null;
    if (proposal.origin === 'SKILL') {
      const authority = await r.workspaces.lockAuthority(input.workspaceId, 'share');
      if (authority === undefined) throw resourceNotFound('Workspace authority');
      sourceMessage = proposal.skill_message_id === null ? null :
        await r.assist.readMessage(proposal.skill_message_id) ?? null;
      const sourceSession = sourceMessage === null ? null :
        await r.assist.readSession(sourceMessage.session_id) ?? null;
      const sourceRef = object(proposal.source.skill);
      sourceSkill = sourceMessage?.skill_snapshot === null ||
        sourceMessage?.skill_snapshot === undefined ? null :
        availableFrozenSkill(sourceMessage.skill_snapshot);
      if (sourceMessage?.status !== 'COMPLETED' ||
          sourceSession?.workspace_id !== input.workspaceId ||
          sourceSession.project_id !== input.projectId ||
          sourceSkill === null || sourceRef?.id !== sourceSkill.id ||
          sourceRef.version !== sourceSkill.version ||
          sourceRef.sha256 !== sourceSkill.sha256 ||
          sourceMessage.skill_output === null ||
          proposal.source.skill_output_sha256 !==
            skillOutputHash(sourceMessage.skill_output)) {
        throw invalidTransition('生成此蓝图的 Skill 来源不可用或无法核对。');
      }
      for (const raw of Array.isArray(sourceMessage.sources)
        ? sourceMessage.sources : []) {
        const ref = object(raw);
        if (ref === null ||
            (ref.kind !== 'KNOWLEDGE' && ref.kind !== 'MEMORY' &&
             ref.kind !== 'DECISION') ||
            typeof ref.root_id !== 'string' || typeof ref.version !== 'string' ||
            input.storage === undefined) {
          throw invalidTransition('蓝图的显式来源当前不可核对。');
        }
        const loaded = await loadAssistSourceContent(r, input.storage,
          sourceSession, { kind: ref.kind, root_id: ref.root_id,
            version: ref.version });
        if (loaded.record.status !== 'SENT' ||
            loaded.record.sha256 !== ref.sha256) {
          throw invalidTransition('蓝图的显式来源当前不可用。');
        }
      }
    }
    const project = proposal.origin === 'SKILL'
      ? await r.projects.lockProjectExclusive(input.projectId)
      : await lockProjectInWorkspace(r, input.workspaceId, input.projectId);
    if (project?.workspace_id !== input.workspaceId) throw resourceNotFound('Project');
    if (project.archived_at !== null) throw invalidTransition('Project 已归档。');
    const draft = normalizeBlueprintDraft({
      intent: candidate.intent as string,
      goal_id: candidate.goal_id as string | null,
      phase_key: candidate.phase_key as string | null,
      tasks: (candidate.tasks as JsonObject[]).map((task) => ({
        local_key: task.local_key as string,
        title: task.title as string,
        objective: task.objective as string,
      })),
      next_action: candidate.next_action as null,
      view_kind: selectedView.kind as 'general' | 'thesis' | 'development',
      pack_ref: pack === null ? null : { id: String(pack.id), version: String(pack.version) },
    }, project.project_type);
    if (canonicalizeJson(buildBlueprintCandidate(draft)) !== canonicalizeJson(candidate)) {
      throw invalidTransition('蓝图候选包含未支持或已变化的字段。');
    }
    if (project.revision !== expectedProject) {
      expiredWith = revisionConflict({ entityType: 'PROJECT',
        expectedRevision: toDecimalString(expectedProject),
        actualRevision: toDecimalString(project.revision) });
      await r.blueprints.settle(proposal.id, 'PENDING', 'EXPIRED',
        { reason: 'PROJECT_REVISION_CHANGED' });
      return null;
    }
    const goalRef = object(baseline.goal_ref);
    const goal = goalRef === null ? null : await r.projects.lockGoal(String(goalRef.id));
    if (goalRef !== null &&
        (goal?.workspace_id !== input.workspaceId || goal.status !== 'ACTIVE' ||
         goal.revision.toString() !== goalRef.revision)) {
      expiredWith = revisionConflict({ entityType: 'GOAL',
        expectedRevision: String(goalRef.revision),
        actualRevision: goal?.revision.toString() ?? '0' });
      await r.blueprints.settle(proposal.id, 'PENDING', 'EXPIRED',
        { reason: 'GOAL_CHANGED' });
      return null;
    }
    const taskRef = object(baseline.next_action_task_ref);
    if (proposal.origin === 'SKILL') {
      const allTasks = await r.tasks.listProjectTasksByStatus(project.id,
        ['INBOX', 'READY', 'IN_PROGRESS', 'WAITING', 'BLOCKED', 'DONE', 'CANCELLED']);
      for (const taskId of allTasks.map((task) => task.id).sort()) {
        await r.tasks.lockTask(taskId);
      }
    }
    const nextExisting = taskRef === null ? null :
      await r.tasks.lockTask(String(taskRef.id)) ?? null;
    if (taskRef !== null &&
        (nextExisting?.project_id !== project.id ||
         nextExisting.revision.toString() !== taskRef.revision)) {
      expiredWith = revisionConflict({ entityType: 'TASK',
        expectedRevision: String(taskRef.revision),
        actualRevision: nextExisting?.revision.toString() ?? '0' });
      await r.blueprints.settle(proposal.id, 'PENDING', 'EXPIRED',
        { reason: 'NEXT_ACTION_TASK_CHANGED' });
      return null;
    }
    if (sourceSkill !== null && sourceMessage !== null) {
      const fresh = await loadSkillBasisInSnapshot(trx, input.workspaceId,
        project.id, null, sourceSkill, sourceMessage.skill_input);
      if (fresh.factsSha256 !== proposal.source.basis_facts_sha256 ||
          canonicalizeJson(fresh.baseline) !==
            canonicalizeJson(baseline.read_dependencies ?? null)) {
        throw invalidTransition('蓝图所依据的当前事实已变化，请重新生成。');
      }
    }
    const tasks = candidate.tasks.map(object);
    if (tasks.some((task) => task === null)) {
      throw invalidTransition('蓝图任务内容已不可核对。');
    }
    const goalId = candidate.goal_id;
    let projectRevision = project.revision;
    if (typeof goalId === 'string') {
      if (goal?.id !== goalId) throw invalidTransition('Goal 关联与候选来源不一致。');
      const linked = await r.projects.findProjectGoalLink(project.id, goalId);
      if (linked === undefined) {
        await r.projects.linkGoalToProject({ workspaceId: input.workspaceId,
          projectId: project.id, goalId });
        const updated = await r.projects.bumpProjectRevision(project.id, projectRevision);
        if (updated === undefined) throw revisionConflict({ entityType: 'PROJECT',
          expectedRevision: toDecimalString(projectRevision),
          actualRevision: toDecimalString(projectRevision) });
        projectRevision = updated.revision;
      }
    }
    const taskIdMap: JsonObject[] = [];
    for (const task of tasks) {
      const prepared = prepareTaskCreation({ workspaceId: input.workspaceId,
        projectId: project.id, commandId: input.commandId,
        title: String(task!.title), objective: String(task!.objective),
        criteria: [{ criterionId: 'human', statement: '结果由人工核对。',
          required: true, method: 'HUMAN' }],
        expectedOutputs: {}, mode: 'ME' });
      const created = await applyTaskCreation(r, prepared);
      taskIdMap.push({ local_key: String(task!.local_key), task_id: created.task_id,
        status: created.status, revision: created.revision });
    }
    // Existing SetNextAction and Reopen both require Task → ProjectState order.
    const state = await r.projects.lockProjectState(project.id);
    const view = await r.views.read(project.id, true);
    if (state === undefined || view === undefined) throw resourceNotFound('Project configuration');
    if (state.revision !== expectedState || view.revision !== expectedView ||
        view.template_version !== '1' ||
        resolveViewTemplate(view.kind).template_sha256 !==
          object(baseline.view_configuration)?.template_sha256) {
      throw revisionConflict({ entityType: state.revision !== expectedState
        ? 'PROJECT_STATE' : 'VIEW_CONFIGURATION',
        expectedRevision: toDecimalString(state.revision !== expectedState
          ? expectedState : expectedView),
        actualRevision: toDecimalString(state.revision !== expectedState
          ? state.revision : view.revision) });
    }
    let stateRevision = state.revision;
    if (typeof candidate.phase_key === 'string' &&
        candidate.phase_key !== state.phase_key) {
      stateRevision = await applyAction(r, project.id, project.project_type,
        stateRevision, normalizeStateAction('SET_PHASE',
          { phase_key: candidate.phase_key }));
    }
    const nextAction = object(candidate.next_action);
    let nextActionTaskId = state.next_action_task_id;
    if (nextAction !== null) {
      if (nextAction.kind === 'CLEAR') nextActionTaskId = null;
      else if (nextAction.kind === 'EXISTING_TASK') {
        if (nextExisting === null || nextExisting.id !== nextAction.task_id) {
          throw invalidTransition('Next Action 的现有 Task 与基线不一致。');
        }
        nextActionTaskId = nextExisting.id;
      } else if (nextAction.kind === 'NEW_TASK') {
        const mapped = taskIdMap.find((entry) =>
          entry.local_key === nextAction.local_key);
        if (typeof mapped?.task_id !== 'string') {
          throw invalidTransition('Next Action 的局部 Task 未创建。');
        }
        nextActionTaskId = mapped.task_id;
      } else throw invalidTransition('未知 Next Action 类型。');
      if (nextActionTaskId !== state.next_action_task_id) {
        stateRevision = await applyAction(r, project.id, project.project_type,
          stateRevision, normalizeStateAction('SET_NEXT_ACTION',
            { next_action_task_id: nextActionTaskId }));
      }
    }
    let viewRevision = view.revision;
    if (view.kind !== selectedView.kind) {
      const changed = await r.views.setKind(project.id, view.revision,
        selectedView.kind as 'general' | 'thesis' | 'development');
      if (changed === undefined) throw revisionConflict({ entityType: 'VIEW_CONFIGURATION',
        expectedRevision: toDecimalString(view.revision),
        actualRevision: toDecimalString(view.revision) });
      viewRevision = changed.revision;
    }
    const goalIds = (await r.projects.listProjectGoalLinks(project.id))
      .map((link) => link.goal_id);
    const result: JsonObject = { proposal_id: proposal.id,
      candidate_sha256: proposal.candidate_sha256, project_id: project.id,
      project_revision: toDecimalString(projectRevision),
      state_revision: toDecimalString(stateRevision),
      view_revision: toDecimalString(viewRevision), goal_ids: goalIds,
      task_id_map: taskIdMap, next_action_task_id: nextActionTaskId,
      view_configuration: { ...resolveViewTemplate(selectedView.kind as
        'general' | 'thesis' | 'development'),
        revision: toDecimalString(viewRevision) },
      applied_effects: { goal_linked: goalId !== null &&
        !(baseline.goal_ids as string[]).includes(String(goalId)),
        tasks_created: taskIdMap.length,
        state_changed: stateRevision !== state.revision,
        view_changed: viewRevision !== view.revision },
    };
    await r.activities.insertActivityRecord({ id: randomUUID(),
      workspaceId: input.workspaceId, actorKind: 'HUMAN',
      actorRef: LOCAL_ACTOR_REF, commandId: input.commandId,
      projectId: project.id, taskId: null,
      eventType: 'PROJECT_BLUEPRINT_APPLIED', factRefs: {
        proposal_id: proposal.id, candidate_sha256: proposal.candidate_sha256,
        project_revision: toDecimalString(projectRevision),
        state_revision: toDecimalString(stateRevision),
        view_revision: toDecimalString(viewRevision),
        task_ids: taskIdMap.map((entry) => entry.task_id as string),
        goal_id: goalId ?? null,
      } });
    const settled = await r.blueprints.settle(proposal.id, 'PENDING', 'ACCEPTED',
      { command_id: input.commandId, result });
    if (settled === undefined) throw invalidTransition('蓝图状态已变化。');
    const receipt = await r.receipts.insertReceipt({ scopeKey,
      commandId: input.commandId, commandType: 'ApplyProjectBlueprint',
      payloadHash, result });
    return { result, replayed: false, committedAt: receipt.created_at };
  });
  if (expiredWith !== null) throw expiredWith;
  if (committed === null) throw new Error('blueprint apply ended without outcome');
  return committed;
}

export async function rejectBlueprintProposal(db: DbExecutor, input: {
  readonly workspaceId: string; readonly projectId: string;
  readonly proposalId: string; readonly commandId: string;
  readonly candidateSha256: string;
}): Promise<CommandOutcome<JsonObject>> {
  return runIdempotentCommand<JsonObject>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId,
    commandType: 'RejectProjectBlueprint',
    target: { project_id: input.projectId, proposal_id: input.proposalId },
    body: { candidate_sha256: input.candidateSha256 },
    execute: async (r) => {
      const proposal = await r.blueprints.read(input.proposalId, true);
      if (proposal?.workspace_id !== input.workspaceId ||
          proposal.project_id !== input.projectId) {
        throw resourceNotFound('Blueprint proposal');
      }
      await lockProjectInWorkspace(r, input.workspaceId, input.projectId);
      if (proposal.candidate_sha256 !== input.candidateSha256 ||
          proposal.status !== 'PENDING') throw invalidTransition('蓝图已变化或不可拒绝。');
      await r.blueprints.settle(proposal.id, 'PENDING', 'REJECTED',
        { command_id: input.commandId });
      await r.activities.insertActivityRecord({ id: randomUUID(),
        workspaceId: input.workspaceId, actorKind: 'HUMAN',
        actorRef: LOCAL_ACTOR_REF, commandId: input.commandId,
        projectId: input.projectId, taskId: null,
        eventType: 'PROJECT_BLUEPRINT_REJECTED', factRefs: {
          proposal_id: proposal.id, candidate_sha256: proposal.candidate_sha256,
        } });
      return { proposal_id: proposal.id, status: 'REJECTED' };
    },
  });
}
