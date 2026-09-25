import { randomUUID } from 'node:crypto';

import type {
  ArtifactKind,
  RunRow,
  TaskRow,
  VerificationSessionRow,
} from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import type { ManagedContentStore } from '../storage/managed-content-store.js';
import { toDecimalString } from '../shared/decimal.js';
import { evidenceUnavailable, invalidTransition, revisionConflict } from './domain-error.js';
import { checkDeclaredOutputs } from './declared-output-requirements.js';
import type { Repositories } from './unit-of-work.js';

/**
 * COMPLETE 步骤：自动完成的业务提交 Gate
 * （contracts/03-verification-and-approval.md 第 4、5 节、contracts/04-recovery-and-commit.md 第 7 节）。
 *
 * 前置核对不满足时返回 BLOCKED，而不是抛错：**“等待人工”不是执行失败**，
 * 步骤保持 PENDING、Run 与 Task 不变，等人工完成必需项或撤销适用性后再推进即可。
 *
 * 满足时在同一个短事务里提交：CompletionRecord(AUTO)、Task 完成指针与执行权释放、
 * Project State 的确定性 delta、关键审计。Run 的终态迁移由 Workflow 生命周期（run-steps）统一写。
 */

export type CompleteRunOutcome =
  | { readonly outcome: 'COMPLETE'; readonly resultRef: JsonObject; readonly completionId: string }
  | { readonly outcome: 'BLOCKED'; readonly reason: string };

/** 完成被阻塞的原因；写入步骤尝试证据与推进结果，便于区分“等人工”和“失败”。 */
export const COMPLETION_BLOCKED_REASON = {
  ACCEPTANCE_REVISION_CHANGED: 'ACCEPTANCE_REVISION_CHANGED',
  VERIFICATION_NOT_PASSED: 'VERIFICATION_NOT_PASSED',
  VERIFICATION_REVOKED: 'VERIFICATION_REVOKED',
  DECLARED_OUTPUTS_UNSATISFIED: 'DECLARED_OUTPUTS_UNSATISFIED',
  GATEWAY_OPERATION_UNRESOLVED: 'GATEWAY_OPERATION_UNRESOLVED',
} as const;

export interface CompleteRunInput {
  readonly run: RunRow;
  readonly task: TaskRow;
  readonly storage: ManagedContentStore;
}

export type CompletionGateResult =
  | {
      readonly ok: true;
      readonly session: VerificationSessionRow;
      readonly requiredOutputSpec: JsonObject;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * 完成 Gate 的前置核对：验收周期匹配、该 Run 最新 session 为 PASS、适用性未被撤销。
 *
 * 单独暴露给 Workflow 生命周期，使“等待人工”可以在**建立步骤尝试之前**就被识别：
 * 等待人工不是执行失败，反复轮询也不应留下失败尝试。真正写完成事实前会再核对一次，
 * 因此“校验后又变化”的竞争窗口仍然关闭（contracts/03 第 5 节）。
 */
export async function evaluateCompletionGate(
  repositories: Repositories,
  input: { readonly run: RunRow; readonly task: TaskRow },
): Promise<CompletionGateResult> {
  const contract = await repositories.runs.readContract(input.run.id);

  if ((await repositories.gateway.listUnresolvedRunOperations(input.run.id)).length > 0) {
    return { ok: false, reason: COMPLETION_BLOCKED_REASON.GATEWAY_OPERATION_UNRESOLVED };
  }

  if (contract === undefined) {
    throw invalidTransition('Run 缺少冻结的执行契约，无法核对完成依据。', {
      taskId: input.task.id,
    });
  }

  // C01：验收契约变了，旧 PASS 不能完成新 acceptance_revision。
  if (contract.acceptance_revision !== input.task.acceptance_revision) {
    return { ok: false, reason: COMPLETION_BLOCKED_REASON.ACCEPTANCE_REVISION_CHANGED };
  }

  const sessions = await repositories.verifications.listSessionsByRun(input.run.id);
  const latest = sessions.at(-1);

  if (latest === undefined || latest.status !== 'PASS') {
    return { ok: false, reason: COMPLETION_BLOCKED_REASON.VERIFICATION_NOT_PASSED };
  }

  // 完成前重新核对适用性：被显式撤销的 PASS 不能再作为完成依据（contracts/03 第 5 节）。
  if (!(await repositories.verifications.isApplicable(latest.id))) {
    return { ok: false, reason: COMPLETION_BLOCKED_REASON.VERIFICATION_REVOKED };
  }

  const requiredOutputSpec = frozenExpectedOutputs(contract.frozen_snapshot);

  if (requiredOutputSpec === undefined) {
    return { ok: false, reason: COMPLETION_BLOCKED_REASON.DECLARED_OUTPUTS_UNSATISFIED };
  }

  const targets = await repositories.verifications.listTargets(latest.id);
  const providedArtifactKinds: ArtifactKind[] = [];

  for (const target of targets) {
    const version = await repositories.artifacts.readArtifactVersion(target.artifact_version_id);
    const artifact = version === undefined ? undefined : await repositories.artifacts.readArtifact(version.artifact_id);

    if (artifact === undefined) {
      return { ok: false, reason: COMPLETION_BLOCKED_REASON.DECLARED_OUTPUTS_UNSATISFIED };
    }

    providedArtifactKinds.push(artifact.artifact_kind);
  }

  const outputs = checkDeclaredOutputs({ requiredOutputSpec, providedArtifactKinds });

  if (outputs.status !== 'SATISFIED') {
    return { ok: false, reason: COMPLETION_BLOCKED_REASON.DECLARED_OUTPUTS_UNSATISFIED };
  }

  return { ok: true, session: latest, requiredOutputSpec };
}

export async function completeRun(
  repositories: Repositories,
  input: CompleteRunInput,
): Promise<CompleteRunOutcome> {
  const gate = await evaluateCompletionGate(repositories, input);

  if (!gate.ok) {
    return { outcome: 'BLOCKED', reason: gate.reason };
  }

  const latest = gate.session;
  const targets = await repositories.verifications.listTargets(latest.id);
  const artifactVersionIds: string[] = [];
  const providedArtifactKinds: ArtifactKind[] = [];

  for (const target of targets) {
    const version = await repositories.artifacts.readArtifactVersion(target.artifact_version_id);

    if (version === undefined) {
      throw evidenceUnavailable({
        artifactVersionId: target.artifact_version_id,
        reason: 'MISSING',
      });
    }

    const artifact = await repositories.artifacts.readArtifact(version.artifact_id);

    if (artifact === undefined) {
      throw evidenceUnavailable({ artifactVersionId: version.id, reason: 'MISSING' });
    }

    const read = await input.storage.readWithHashCheck(version.storage_ref, {
      contentHash: target.content_hash,
      size: version.size,
    });

    if (read.status !== 'OK') {
      throw evidenceUnavailable({ artifactVersionId: version.id, reason: read.status });
    }

    artifactVersionIds.push(version.id);
    providedArtifactKinds.push(artifact.artifact_kind);
  }

  // Gate 与真正写完成事实前都核对同一份冻结要求和确切 verification target 集合。
  if (checkDeclaredOutputs({ requiredOutputSpec: gate.requiredOutputSpec, providedArtifactKinds }).status !== 'SATISFIED') {
    return { outcome: 'BLOCKED', reason: COMPLETION_BLOCKED_REASON.DECLARED_OUTPUTS_UNSATISFIED };
  }

  const completionId = randomUUID();
  const acceptanceRevision = input.task.acceptance_revision;
  const completionRef =
    input.task.project_id === null
      ? null
      : {
          project_id: input.task.project_id,
          completion_id: completionId,
          source_ref: `task:${input.task.id}/acceptance:${toDecimalString(acceptanceRevision)}`,
        };

  // 锁序固定为 Task → ProjectState（与 completeHumanTask 一致，不反向）。
  const state =
    input.task.project_id === null
      ? undefined
      : await repositories.projects.lockProjectState(input.task.project_id);

  if (input.task.project_id !== null && state === undefined) {
    throw invalidTransition('所属 Project 缺少 Project State，不能自动完成本 Task。', {
      taskId: input.task.id,
    });
  }

  const nextActionCleared = state?.next_action_task_id === input.task.id;
  const stateDelta: JsonObject = {
    completion_ref: completionRef,
    next_action_cleared: nextActionCleared,
    artifact_version_ids: [...artifactVersionIds],
  };

  const completion = await repositories.completions.insertCompletionRecord({
    id: completionId,
    taskId: input.task.id,
    acceptanceRevision,
    basisKind: 'AUTO',
    humanAcceptanceId: null,
    verificationSessionId: latest.id,
    runId: input.run.id,
    stateDelta,
  });

  const completed = await repositories.tasks.completeFromRun({
    taskId: input.task.id,
    runId: input.run.id,
    expectedRevision: input.task.revision,
    acceptanceRevision,
    completionId: completion.id,
  });

  if (completed === undefined) {
    throw new Error('task completion CAS failed while holding the task lock');
  }

  if (state !== undefined && completionRef !== null) {
    await repositories.projects.insertStateCompletionRef({
      projectId: state.project_id,
      completionId: completion.id,
      sourceRef: completionRef.source_ref,
    });

    const nextState = nextActionCleared
      ? await repositories.projects.setProjectStateNextAction(state.project_id, state.revision, null)
      : await repositories.projects.bumpProjectStateRevision(state.project_id, state.revision);

    if (nextState === undefined) {
      throw revisionConflict({
        entityType: 'PROJECT_STATE',
        expectedRevision: toDecimalString(state.revision),
        actualRevision: toDecimalString(state.revision),
      });
    }
  }

  await repositories.activities.insertActivityRecord({
    id: randomUUID(),
    actorKind: 'AI',
    actorRef: `run:${input.run.id}`,
    commandId: null,
    projectId: input.task.project_id,
    taskId: input.task.id,
    eventType: 'TASK_COMPLETED',
    factRefs: {
      completion_id: completion.id,
      verification_session_id: latest.id,
      run_id: input.run.id,
      acceptance_revision: toDecimalString(acceptanceRevision),
      artifact_version_ids: [...artifactVersionIds],
      state_delta: stateDelta,
    },
  });

  return {
    outcome: 'COMPLETE',
    completionId: completion.id,
    resultRef: {
      completion_id: completion.id,
      verification_session_id: latest.id,
      acceptance_revision: toDecimalString(acceptanceRevision),
      artifact_version_ids: [...artifactVersionIds],
    },
  };
}

function frozenExpectedOutputs(snapshot: JsonObject): JsonObject | undefined {
  const expectedOutputs = snapshot.expected_outputs;

  return isJsonObject(expectedOutputs) ? expectedOutputs : undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
