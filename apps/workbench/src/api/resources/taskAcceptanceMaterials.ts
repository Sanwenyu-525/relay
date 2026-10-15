import { RelayHttp } from '../core/http';
import { array, availability, boolean, decimal, nullableString, object, string, stringArray } from '../core/primitives';
import { commandEnvelopeFrom } from '../parse/projects';
import { createKnowledge } from './information';
import type { RelayAcceptanceMaterial, RelayAcceptanceMaterialImport, RelayAcceptanceMaterialInput,
  RelayAcceptanceMaterialResult, RelayAcceptanceMaterials } from '../dtos/taskAcceptanceMaterials';

function materialResult(value: unknown): RelayAcceptanceMaterialResult {
  const row = object(value, 'acceptance material');
  const status = string(row, 'status', 'acceptance material');
  if (status !== 'ACTIVE' && status !== 'WITHDRAWN') throw new Error('无法识别验收材料关联状态。');
  return { materialId: string(row, 'material_id', 'acceptance material'),
    taskId: string(row, 'task_id', 'acceptance material'), status,
    revision: decimal(row, 'revision', 'acceptance material') };
}

function materialFrom(value: unknown): RelayAcceptanceMaterial {
  const row = object(value, 'acceptance material');
  const evidenceKind = string(row, 'evidence_kind', 'acceptance material');
  if (evidenceKind !== 'UNVERIFIED_REFERENCE') throw new Error('外部材料不能作为正式通过证据。');
  return { ...materialResult(row), acceptanceRevision: decimal(row, 'acceptance_revision', 'acceptance material'),
    criterionId: nullableString(row, 'criterion_id', 'acceptance material'),
    knowledgeId: nullableString(row, 'knowledge_id', 'acceptance material'),
    knowledgeVersion: row.knowledge_version === null ? null : decimal(row, 'knowledge_version', 'acceptance material'),
    knowledgeVersionId: string(row, 'knowledge_version_id', 'acceptance material'),
    title: nullableString(row, 'title', 'acceptance material'),
    sha256: nullableString(row, 'content_sha256', 'acceptance material'),
    materialAvailability: availability(row, 'material_availability', 'acceptance material'),
    testedArtifactVersionId: nullableString(row, 'tested_artifact_version_id', 'acceptance material'),
    acceptanceMatches: boolean(row, 'acceptance_matches', 'acceptance material'),
    testedArtifactIsCurrent: row.tested_artifact_is_current === null ? null :
      boolean(row, 'tested_artifact_is_current', 'acceptance material'),
    evidenceKind, sourceLabel: nullableString(row, 'source_label', 'acceptance material'),
    note: nullableString(row, 'note', 'acceptance material'),
    missingFields: stringArray(row, 'missing_fields', 'acceptance material'),
    createdAt: string(row, 'created_at', 'acceptance material'),
    withdrawnAt: nullableString(row, 'withdrawn_at', 'acceptance material') };
}

export async function attachTaskAcceptanceMaterial(http: RelayHttp, input: RelayAcceptanceMaterialInput) {
  const envelope = commandEnvelopeFrom(await http.request(http.workspacePath(
    `/tasks/${encodeURIComponent(input.taskId)}/acceptance-materials`), {
    method: 'POST', body: JSON.stringify({ command_id: input.commandId,
      expected_acceptance_revision: input.expectedAcceptanceRevision, knowledge_id: input.knowledgeId,
      knowledge_version: input.knowledgeVersion, criterion_id: input.criterionId ?? null,
      tested_artifact_version_id: input.testedArtifactVersionId ?? null,
      source_label: input.sourceLabel ?? null, note: input.note ?? null }) }, 200));
  const result = materialResult(envelope.result);
  if (envelope.commandId !== input.commandId || result.taskId !== input.taskId) {
    throw new Error('验收材料回执与原命令、任务不匹配。');
  }
  return result;
}

/** 两个原 Owner 命令：导入成功而关联失败时，原导入回执仍可读；原 ID 重试复用材料。 */
export async function importTaskAcceptanceMaterial(http: RelayHttp, input: RelayAcceptanceMaterialImport) {
  const imported = await createKnowledge(http, { commandId: input.importCommandId,
    projectId: input.projectId, title: input.title, sourceKind: 'MANAGED_TEXT',
    text: input.text, mediaType: input.mediaType });
  return attachTaskAcceptanceMaterial(http, { ...input,
    knowledgeId: string(imported.result, 'knowledge_id', 'material import'),
    knowledgeVersion: decimal(imported.result, 'version', 'material import') });
}

export async function getTaskAcceptanceMaterials(http: RelayHttp, taskId: string): Promise<RelayAcceptanceMaterials> {
  const row = object(await http.request(http.workspacePath(
    `/tasks/${encodeURIComponent(taskId)}/acceptance-materials`)), 'acceptance materials');
  const result = { taskId: string(row, 'task_id', 'acceptance materials'),
    acceptanceRevision: decimal(row, 'acceptance_revision', 'acceptance materials'),
    items: array(row, 'items', 'acceptance materials').map(materialFrom) };
  if (result.taskId !== taskId || result.items.some((item) => item.taskId !== taskId)) {
    throw new Error('验收材料读取结果与原任务不匹配。');
  }
  return result;
}

export async function withdrawTaskAcceptanceMaterial(http: RelayHttp, input: {
  taskId: string; materialId: string; commandId: string; expectedRevision: string;
}) {
  const envelope = commandEnvelopeFrom(await http.request(http.workspacePath(
    `/tasks/${encodeURIComponent(input.taskId)}/acceptance-materials/${encodeURIComponent(input.materialId)}/withdrawals`), {
    method: 'POST', body: JSON.stringify({ command_id: input.commandId, expected_revision: input.expectedRevision }) }, 200));
  const result = materialResult(envelope.result);
  if (envelope.commandId !== input.commandId || result.taskId !== input.taskId || result.materialId !== input.materialId) {
    throw new Error('撤销材料关联的回执与原命令不匹配。');
  }
  return result;
}
