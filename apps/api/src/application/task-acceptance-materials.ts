import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '../infrastructure/database.js';
import type { InformationRootRow, KnowledgeVersionRow } from '../infrastructure/database-schema.js';
import type { TaskAcceptanceMaterialRow } from '../task/task-acceptance-material-repository.js';
import { httpCommandScopeKey, LOCAL_ACTOR_REF } from './actor.js';
import { runIdempotentCommand } from './command.js';
import { invalidTransition, resourceNotFound, revisionConflict, validationFailed } from './domain-error.js';
import { lockWritableProjectInWorkspace } from './guards.js';
import { requireRevision } from './revisions.js';
import { withTransaction, type Repositories } from './unit-of-work.js';

export async function lockAcceptanceTask(r: Repositories, workspaceId: string, taskId: string) {
  if (await r.workspaces.lockAuthority(workspaceId, 'update') === undefined) {
    throw resourceNotFound('Workspace');
  }
  const located = await r.tasks.readTask(taskId);
  if (located?.workspace_id !== workspaceId) throw resourceNotFound('Task');
  if (located.project_id === null) throw invalidTransition('验收材料需要明确的项目归属。');
  await lockWritableProjectInWorkspace(r, workspaceId, located.project_id);
  const task = await r.tasks.lockTask(taskId);
  if (task === undefined) throw resourceNotFound('Task');
  return task;
}

function result(row: TaskAcceptanceMaterialRow) {
  return { material_id: row.id, task_id: row.task_id, status: row.status,
    revision: row.revision.toString() };
}

export async function attachTaskAcceptanceMaterial(db: DbExecutor, input: {
  workspaceId: string; taskId: string; commandId: string; expectedAcceptanceRevision: string;
  knowledgeId: string; knowledgeVersion: string; criterionId?: string | null;
  testedArtifactVersionId?: string | null; sourceLabel?: string | null; note?: string | null;
}) {
  const acceptanceRevision = requireRevision(input.expectedAcceptanceRevision, 'expected_acceptance_revision');
  const knowledgeVersion = requireRevision(input.knowledgeVersion, 'knowledge_version');
  const criterionId = input.criterionId ?? null;
  const targetId = input.testedArtifactVersionId ?? null;
  const sourceLabel = input.sourceLabel ?? null;
  const note = input.note ?? null;
  for (const [field, value, max] of [
    ['criterion_id', criterionId, 128], ['source_label', sourceLabel, 1024], ['note', note, 4000],
  ] as const) {
    if (value !== null && (!value.trim() || value.length > max)) {
      throw validationFailed([{ field, message: `需要 1 至 ${max} 个字符。` }]);
    }
  }
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'AttachTaskAcceptanceMaterial',
    target: { task_id: input.taskId }, body: { expected_acceptance_revision: acceptanceRevision.toString(),
      knowledge_id: input.knowledgeId, knowledge_version: knowledgeVersion.toString(),
      criterion_id: criterionId, tested_artifact_version_id: targetId, source_label: sourceLabel, note },
    execute: async (r) => {
      const task = await lockAcceptanceTask(r, input.workspaceId, input.taskId);
      if (task.acceptance_revision !== acceptanceRevision) throw revisionConflict({
        entityType: 'TASK_ACCEPTANCE', expectedRevision: acceptanceRevision.toString(),
        actualRevision: task.acceptance_revision.toString() });
      if (criterionId !== null && !(await r.tasks.listCriteria(task.id, acceptanceRevision))
        .some((criterion) => criterion.criterion_id === criterionId)) {
        throw validationFailed([{ field: 'criterion_id', message: '条件不属于本次验收修订。' }]);
      }
      const knowledge = await r.information.readRoot<InformationRootRow>('knowledge', input.knowledgeId, true);
      if (knowledge?.workspace_id !== input.workspaceId || knowledge.project_id !== task.project_id ||
          knowledge.status !== 'ACTIVE') throw resourceNotFound('Knowledge');
      const version = await r.information.readVersion<KnowledgeVersionRow>('knowledge', knowledge.id, knowledgeVersion);
      if (version === undefined || version.availability !== 'AVAILABLE') throw resourceNotFound('KnowledgeVersion');
      if (!['text/plain', 'text/markdown'].includes(version.media_type)) {
        throw validationFailed([{ field: 'knowledge_version', message: '首片只接受纯文本或 Markdown 材料。' }]);
      }
      if (targetId !== null) {
        const target = await r.artifacts.readArtifactVersion(targetId);
        const artifact = target === undefined ? undefined : await r.artifacts.readArtifact(target.artifact_id);
        if (artifact?.workspace_id !== input.workspaceId || artifact.task_id !== task.id) {
          throw resourceNotFound('ArtifactVersion');
        }
      }
      const row = await r.acceptanceMaterials.insert({ id: randomUUID(), workspace_id: input.workspaceId,
        task_id: task.id, acceptance_revision: acceptanceRevision, criterion_id: criterionId,
        knowledge_version_id: version.id, tested_artifact_version_id: targetId,
        source_label: sourceLabel, note });
      await r.activities.insertActivityRecord({ id: randomUUID(), workspaceId: input.workspaceId,
        actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF, commandId: input.commandId,
        projectId: task.project_id, taskId: task.id, eventType: 'TASK_ACCEPTANCE_MATERIAL_ATTACHED',
        factRefs: { material_id: row.id, knowledge_version_id: version.id,
          acceptance_revision: acceptanceRevision.toString(), criterion_id: criterionId,
          tested_artifact_version_id: targetId } });
      return result(row);
    } });
}

export async function withdrawTaskAcceptanceMaterial(db: DbExecutor, input: {
  workspaceId: string; taskId: string; materialId: string; commandId: string; expectedRevision: string;
}) {
  const expectedRevision = requireRevision(input.expectedRevision, 'expected_revision');
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'WithdrawTaskAcceptanceMaterial',
    target: { task_id: input.taskId, material_id: input.materialId },
    body: { expected_revision: expectedRevision.toString() }, execute: async (r) => {
      const task = await lockAcceptanceTask(r, input.workspaceId, input.taskId);
      const row = await r.acceptanceMaterials.read(input.materialId, true);
      if (row?.workspace_id !== input.workspaceId || row.task_id !== task.id) {
        throw resourceNotFound('TaskAcceptanceMaterial');
      }
      if (row.revision !== expectedRevision) throw revisionConflict({ entityType: 'TASK_ACCEPTANCE_MATERIAL',
        expectedRevision: expectedRevision.toString(), actualRevision: row.revision.toString() });
      if (row.status === 'WITHDRAWN') return result(row);
      const withdrawn = await r.acceptanceMaterials.withdraw(row.id);
      await r.activities.insertActivityRecord({ id: randomUUID(), workspaceId: input.workspaceId,
        actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF, commandId: input.commandId,
        projectId: task.project_id, taskId: task.id, eventType: 'TASK_ACCEPTANCE_MATERIAL_WITHDRAWN',
        factRefs: { material_id: row.id } });
      return result(withdrawn);
    } });
}

export async function listTaskAcceptanceMaterials(db: DbExecutor, workspaceId: string, taskId: string) {
  return withTransaction(db, async (r) => {
    const task = await r.tasks.readTaskForShare(taskId);
    if (task?.workspace_id !== workspaceId) throw resourceNotFound('Task');
    const rows = await r.acceptanceMaterials.list(workspaceId, taskId);
    const items = [];
    for (const row of rows) {
      const version = await r.information.readKnowledgeVersionById(row.knowledge_version_id);
      const knowledge = version === undefined ? undefined :
        await r.information.readRoot<InformationRootRow>('knowledge', version.knowledge_id);
      const available = knowledge?.workspace_id === workspaceId && knowledge.project_id === task.project_id &&
        knowledge.status === 'ACTIVE' && version?.availability === 'AVAILABLE';
      const target = row.tested_artifact_version_id === null ? undefined :
        await r.artifacts.readArtifactVersion(row.tested_artifact_version_id);
      const versions = target === undefined ? [] : await r.artifacts.listArtifactVersions(target.artifact_id);
      items.push({ ...result(row), acceptance_revision: row.acceptance_revision.toString(),
        criterion_id: row.criterion_id, knowledge_id: available ? knowledge.id : null,
        knowledge_version: available ? version.version.toString() : null,
        knowledge_version_id: row.knowledge_version_id, title: available ? knowledge.title : null,
        content_sha256: available ? version.content_sha256.toString('hex') : null,
        material_availability: available ? 'AVAILABLE' : 'UNAVAILABLE',
        tested_artifact_version_id: row.tested_artifact_version_id,
        acceptance_matches: row.acceptance_revision === task.acceptance_revision,
        tested_artifact_is_current: target === undefined ? null : versions[0]?.id === target.id,
        evidence_kind: 'UNVERIFIED_REFERENCE', source_label: row.source_label, note: row.note,
        missing_fields: [row.criterion_id === null ? 'criterion_id' : null,
          row.tested_artifact_version_id === null ? 'tested_artifact_version_id' : null]
          .filter((field): field is string => field !== null),
        created_at: row.created_at.toISOString(), withdrawn_at: row.withdrawn_at?.toISOString() ?? null });
    }
    return { task_id: task.id, acceptance_revision: task.acceptance_revision.toString(), items };
  });
}
