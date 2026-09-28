import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import type { ManagedContentStore } from '../storage/managed-content-store.js';
import { httpCommandScopeKey, LOCAL_ACTOR_REF } from './actor.js';
import { runIdempotentCommand, type CommandOutcome } from './command.js';
import { evidenceUnavailable, invalidTransition, resourceNotFound,
  revisionConflict } from './domain-error.js';
import { lockArtifactInWorkspace, lockTaskInWorkspace,
  lockWritableProjectInWorkspace, readArtifactVersionInWorkspace } from './guards.js';
import { requireRevision } from './revisions.js';
import { createRepositories } from './unit-of-work.js';
import { MAX_MARKDOWN_BYTES } from '../storage/managed-content-store.js';
import { advanceAiTextLocks, normalizeArtifactContent, requireAiTextLocks,
  requireHumanInProgress } from './artifact-commands.js';
import { StorageConflictError, StorageUnavailableError } from '../storage/managed-content-store.js';
import { storageUnavailable } from './domain-error.js';

const MAX_SOURCE_CHARS = 12_000;
const MAX_TARGETS = 10;
const MAX_TARGET_CHARS = 1_000;

export interface ImpactCheckDto extends JsonObject {
  readonly id: string;
  readonly artifact_id: string;
  readonly source_before_version_id: string;
  readonly source_after_version_id: string;
  readonly status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  readonly error_code: string | null;
  readonly direct_targets: readonly JsonObject[];
  readonly possibly_related: readonly JsonObject[];
  readonly has_more: boolean;
  readonly input_truncated: boolean;
  readonly unanalysed_scope: readonly string[];
  readonly stale: boolean;
}

export async function startArtifactImpactCheck(db: DbExecutor, storage: ManagedContentStore,
  input: { workspaceId: string; beforeVersionId: string; afterVersionId: string;
    expectedArtifactRevision: string; analysisTargetVersionIds: readonly string[];
    commandId: string }): Promise<CommandOutcome<{
      readonly impact_check_id: string; readonly assistant_message_id: string }>> {
  const expected = requireRevision(input.expectedArtifactRevision, 'expected_artifact_revision');
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'StartArtifactImpactCheck',
    target: { source_before_version_id: input.beforeVersionId },
    body: { source_after_version_id: input.afterVersionId,
      expected_artifact_revision: expected.toString(),
      analysis_target_version_ids: input.analysisTargetVersionIds },
    execute: async (r) => {
      const { version: before, artifact: observed } = await readArtifactVersionInWorkspace(r,
        input.workspaceId, input.beforeVersionId);
      await lockTaskInWorkspace(r, input.workspaceId, observed.task_id);
      const artifact = await lockArtifactInWorkspace(r, input.workspaceId, observed.id);
      if (artifact.revision !== expected) throw revisionConflict({ entityType: 'ARTIFACT',
        expectedRevision: expected.toString(), actualRevision: artifact.revision.toString() });
      const after = await r.artifacts.readArtifactVersion(input.afterVersionId);
      const latest = (await r.artifacts.listArtifactVersions(artifact.id)).at(-1);
      if (!after || after.artifact_id !== artifact.id || latest?.id !== after.id ||
          before.id === after.id || before.version_number >= after.version_number) {
        throw invalidTransition('影响检查必须选择同一产物的旧来源版本与当前最新版本。');
      }
      const oldRead = await storage.readWithHashCheck(before.storage_ref,
        { contentHash: before.content_hash, size: before.size });
      const newRead = await storage.readWithHashCheck(after.storage_ref,
        { contentHash: after.content_hash, size: after.size });
      if (oldRead.status !== 'OK') throw evidenceUnavailable({ artifactVersionId: before.id,
        reason: oldRead.status });
      if (newRead.status !== 'OK') throw evidenceUnavailable({ artifactVersionId: after.id,
        reason: newRead.status });
      const edges = (await r.lineage.listByParent(input.workspaceId, before.id))
        .filter((edge) => edge.child_version_id !== after.id);
      if (new Set(input.analysisTargetVersionIds).size !== input.analysisTargetVersionIds.length ||
          input.analysisTargetVersionIds.length > MAX_TARGETS ||
          input.analysisTargetVersionIds.some((id) => !edges.slice(0, MAX_TARGETS)
            .some((edge) => edge.child_version_id === id))) {
        throw invalidTransition('模型分析目标须从该旧来源的已登记直接引用中逐项选择。');
      }
      const selectedTargets = new Set(input.analysisTargetVersionIds);
      const directTargets: JsonObject[] = [];
      const modelTargets: JsonObject[] = [];
      for (const edge of edges.slice(0, MAX_TARGETS)) {
        const child = await r.artifacts.readArtifactVersion(edge.child_version_id);
        const owner = child === undefined ? undefined : await r.artifacts.readArtifact(child.artifact_id);
        if (!child || !owner || owner.workspace_id !== input.workspaceId) continue;
        const content = await storage.readWithHashCheck(child.storage_ref,
          { contentHash: child.content_hash, size: child.size });
        const available = content.status === 'OK';
        directTargets.push({ target_version_id: child.id, target_artifact_id: owner.id,
          relation: edge.relation, version_number: child.version_number.toString(),
          availability: available ? 'AVAILABLE' : 'UNAVAILABLE',
          analysed: available && selectedTargets.has(child.id) });
        if (available && selectedTargets.has(child.id)) modelTargets.push({ version_id: child.id,
          excerpt: content.content.toString('utf8').slice(0, MAX_TARGET_CHARS) });
      }
      const oldText = oldRead.content.toString('utf8');
      const newText = newRead.content.toString('utf8');
      const truncated = oldText.length > MAX_SOURCE_CHARS || newText.length > MAX_SOURCE_CHARS ||
        modelTargets.some((target) => String(target.excerpt).length === MAX_TARGET_CHARS);
      const sessionId = randomUUID();
      const userMessageId = randomUUID();
      const assistantMessageId = randomUUID();
      const checkId = randomUUID();
      await r.assist.insertSession({ id: sessionId, workspaceId: input.workspaceId,
        projectId: artifact.project_id, taskId: artifact.task_id,
        title: `影响检查 ${before.version_number}→${after.version_number}` });
      const modelInput = JSON.stringify({ kind: 'ARTIFACT_IMPACT_CHECK',
        before_version_id: before.id, after_version_id: after.id,
        before_sha256: before.content_hash.toString('hex'),
        after_sha256: after.content_hash.toString('hex'),
        before_text: oldText.slice(0, MAX_SOURCE_CHARS),
        after_text: newText.slice(0, MAX_SOURCE_CHARS),
        direct_targets: modelTargets, input_truncated: truncated });
      await r.assist.insertMessage({ id: userMessageId, sessionId, seq: 1n,
        role: 'USER', status: 'COMPLETED', intent: 'DISCUSS', content: modelInput,
        sources: [] });
      await r.assist.insertMessage({ id: assistantMessageId, sessionId, seq: 2n,
        role: 'ASSISTANT', status: 'PENDING', intent: 'IMPACT_CHECK', content: null,
        sources: [] });
      await r.impacts.insert({ id: checkId, workspaceId: input.workspaceId,
        artifactId: artifact.id, beforeVersionId: before.id, afterVersionId: after.id,
        artifactRevision: artifact.revision, sessionId, messageId: assistantMessageId,
        directTargets, hasMore: edges.length > MAX_TARGETS, inputTruncated: truncated });
      return { impact_check_id: checkId, assistant_message_id: assistantMessageId };
    } });
}

export async function readArtifactImpactCheck(db: DbExecutor, workspaceId: string,
  checkId: string): Promise<ImpactCheckDto> {
  const r = createRepositories(db);
  const check = await r.impacts.read(checkId);
  if (!check || check.workspace_id !== workspaceId) throw resourceNotFound('Impact check');
  const artifact = await r.artifacts.readArtifact(check.artifact_id);
  const latest = artifact && (await r.artifacts.listArtifactVersions(artifact.id)).at(-1);
  const message = await r.assist.readMessage(check.assist_message_id);
  if (!artifact || artifact.workspace_id !== workspaceId || !message) throw resourceNotFound('Impact check');
  let status = message.status;
  let errorCode = message.error_code;
  let possible: JsonObject[] = [];
  if (status === 'COMPLETED') {
    try {
      const parsed = JSON.parse(message.content ?? '') as { possibly_related?: unknown };
      if (!Array.isArray(parsed.possibly_related)) throw new Error('missing possibly_related');
      const allowed = new Set(check.direct_targets.filter((target) => target.analysed === true)
        .map((target) => target.target_version_id));
      const seen = new Set<string>();
      for (const item of parsed.possibly_related) {
        if (!item || typeof item !== 'object') throw new Error('invalid item');
        const row = item as Record<string, unknown>;
        if (typeof row.target_version_id !== 'string' || !allowed.has(row.target_version_id) ||
            seen.has(row.target_version_id) || typeof row.reason !== 'string' ||
            row.reason.trim() === '' || row.reason.length > 500) throw new Error('invalid target');
        seen.add(row.target_version_id);
        possible.push({ target_version_id: row.target_version_id, reason: row.reason });
      }
    } catch { status = 'FAILED'; errorCode = 'OUTPUT_SCHEMA_INVALID'; possible = []; }
  }
  return { id: check.id, artifact_id: check.artifact_id,
    source_before_version_id: check.source_before_version_id,
    source_after_version_id: check.source_after_version_id,
    status, error_code: errorCode, direct_targets: check.direct_targets,
    possibly_related: possible, has_more: check.has_more,
    input_truncated: check.input_truncated,
    unanalysed_scope: ['未登记引用', '间接下游',
      ...(check.direct_targets.some((target) => target.analysed !== true)
        ? ['未选入模型分析的直接引用正文'] : []),
      ...(check.has_more ? ['超过本轮上限的已登记直接引用'] : []),
      ...(check.input_truncated ? ['超出模型输入上限的正文'] : [])],
    stale: artifact.revision !== check.artifact_revision || latest?.id !== check.source_after_version_id };
}

export async function startArtifactImpactCandidate(db: DbExecutor,
  storage: ManagedContentStore, input: { workspaceId: string; checkId: string;
    targetVersionId: string; expectedTargetRevision: string; confirmedPossible: boolean;
    commandId: string }): Promise<CommandOutcome<{
      readonly candidate_id: string; readonly assistant_message_id: string }>> {
  const expected = requireRevision(input.expectedTargetRevision, 'expected_target_revision');
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'StartArtifactImpactCandidate',
    target: { impact_check_id: input.checkId, target_version_id: input.targetVersionId },
    body: { expected_target_revision: expected.toString(),
      confirmed_possible: input.confirmedPossible },
    execute: async (r) => {
      const check = await r.impacts.read(input.checkId);
      if (!check || check.workspace_id !== input.workspaceId) throw resourceNotFound('Impact check');
      const analysis = await r.assist.readMessage(check.assist_message_id);
      if (analysis?.status !== 'COMPLETED' || !analysis.content) {
        throw invalidTransition('影响分析尚未完成，不能生成修改候选。');
      }
      const allowed = check.direct_targets.filter((target) => target.availability === 'AVAILABLE')
        .map((target) => String(target.target_version_id));
      const analysed = check.direct_targets.filter((target) => target.analysed === true)
        .map((target) => String(target.target_version_id));
      const possible = parsePossiblyRelated(analysis.content, analysed);
      if (possible === null) throw invalidTransition('AI 影响分析结果无效，不能据此生成候选。');
      if (!allowed.includes(input.targetVersionId)) throw invalidTransition('目标不在本次已登记直接引用中。');
      if (possible.includes(input.targetVersionId) && !input.confirmedPossible) {
        throw invalidTransition('AI 推测项须先由用户确认才能进入处理范围。');
      }
      const source = await r.artifacts.readArtifact(check.artifact_id);
      const sourceLatest = source && (await r.artifacts.listArtifactVersions(source.id)).at(-1);
      if (!source || source.workspace_id !== input.workspaceId ||
          source.revision !== check.artifact_revision ||
          sourceLatest?.id !== check.source_after_version_id) {
        throw invalidTransition('来源版本已变化，请重新检查影响。');
      }
      const targetVersion = await r.artifacts.readArtifactVersion(input.targetVersionId);
      const target = targetVersion && await r.artifacts.readArtifact(targetVersion.artifact_id);
      const targetLatest = target && (await r.artifacts.listArtifactVersions(target.id)).at(-1);
      if (!target || target.workspace_id !== input.workspaceId ||
          target.revision !== expected || targetLatest?.id !== input.targetVersionId) {
        throw invalidTransition('目标版本或授权基线已变化，请重新选择处理范围。');
      }
      const sourceRead = await storage.readWithHashCheck(sourceLatest.storage_ref,
        { contentHash: sourceLatest.content_hash, size: sourceLatest.size });
      const targetRead = await storage.readWithHashCheck(targetLatest.storage_ref,
        { contentHash: targetLatest.content_hash, size: targetLatest.size });
      if (sourceRead.status !== 'OK') throw evidenceUnavailable({ artifactVersionId: sourceLatest.id,
        reason: sourceRead.status });
      if (targetRead.status !== 'OK') throw evidenceUnavailable({ artifactVersionId: targetLatest.id,
        reason: targetRead.status });
      const sourceText = sourceRead.content.toString('utf8');
      const targetText = targetRead.content.toString('utf8');
      if (sourceText.length > 12_000 || targetText.length > 32_000) {
        throw invalidTransition('来源或目标正文超出本轮模型输入范围；未生成部分候选。');
      }
      const sessionId = randomUUID();
      const userMessageId = randomUUID();
      const assistantMessageId = randomUUID();
      const candidateId = randomUUID();
      await r.assist.insertSession({ id: sessionId, workspaceId: input.workspaceId,
        projectId: target.project_id, taskId: target.task_id,
        title: `影响候选 ${targetVersion.version_number}` });
      await r.assist.insertMessage({ id: userMessageId, sessionId, seq: 1n,
        role: 'USER', status: 'COMPLETED', intent: 'DISCUSS',
        content: JSON.stringify({ kind: 'ARTIFACT_IMPACT_CANDIDATE',
          source_version_id: sourceLatest.id, source_sha256: sourceLatest.content_hash.toString('hex'),
          source_text: sourceText, target_version_id: targetLatest.id,
          target_sha256: targetLatest.content_hash.toString('hex'), target_text: targetText }),
        sources: [] });
      await r.assist.insertMessage({ id: assistantMessageId, sessionId, seq: 2n,
        role: 'ASSISTANT', status: 'PENDING', intent: 'IMPACT_CANDIDATE', content: null,
        sources: [] });
      await r.impacts.insertCandidate({ id: candidateId, workspaceId: input.workspaceId,
        checkId: check.id, sourceArtifactRevision: source.revision,
        targetArtifactId: target.id, targetArtifactRevision: target.revision,
        targetVersionId: targetLatest.id, sessionId, messageId: assistantMessageId,
        confirmedPossible: input.confirmedPossible });
      return { candidate_id: candidateId, assistant_message_id: assistantMessageId };
    } });
}

function parsePossiblyRelated(content: string, allowedIds: readonly string[]): string[] | null {
  try {
    const parsed = JSON.parse(content) as { possibly_related?: unknown };
    if (!Array.isArray(parsed.possibly_related)) return null;
    const allowed = new Set(allowedIds);
    const seen = new Set<string>();
    for (const raw of parsed.possibly_related) {
      if (!raw || typeof raw !== 'object') return null;
      const item = raw as Record<string, unknown>;
      if (typeof item.target_version_id !== 'string' || !allowed.has(item.target_version_id) ||
          seen.has(item.target_version_id) || typeof item.reason !== 'string' ||
          item.reason.trim() === '' || item.reason.length > 500) return null;
      seen.add(item.target_version_id);
    }
    return [...seen];
  } catch { return null; }
}

export interface ImpactCandidateDto extends JsonObject {
  readonly id: string;
  readonly impact_check_id: string;
  readonly target_artifact_id: string;
  readonly target_version_id: string;
  readonly status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  readonly error_code: string | null;
  readonly markdown: string | null;
  readonly stale: boolean;
  readonly applied_version_id: string | null;
}

function parseImpactCandidateMarkdown(content: string | null): string | null {
  try {
    const parsed: unknown = JSON.parse(content ?? '');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        !('markdown' in parsed) || typeof parsed.markdown !== 'string' ||
        !parsed.markdown.trim() || Buffer.byteLength(parsed.markdown, 'utf8') > MAX_MARKDOWN_BYTES) {
      return null;
    }
    return parsed.markdown;
  } catch { return null; }
}

export async function readArtifactImpactCandidate(db: DbExecutor, workspaceId: string,
  candidateId: string): Promise<ImpactCandidateDto> {
  const r = createRepositories(db);
  const candidate = await r.impacts.readCandidate(candidateId);
  if (!candidate || candidate.workspace_id !== workspaceId) throw resourceNotFound('Impact candidate');
  const check = await r.impacts.read(candidate.impact_check_id);
  const source = check && await r.artifacts.readArtifact(check.artifact_id);
  const target = await r.artifacts.readArtifact(candidate.target_artifact_id);
  const sourceLatest = source && (await r.artifacts.listArtifactVersions(source.id)).at(-1);
  const targetLatest = target && (await r.artifacts.listArtifactVersions(target.id)).at(-1);
  const message = await r.assist.readMessage(candidate.assist_message_id);
  if (!check || !source || !target || !message || source.workspace_id !== workspaceId ||
      target.workspace_id !== workspaceId) throw resourceNotFound('Impact candidate');
  let status = message.status;
  let errorCode = message.error_code;
  let markdown: string | null = null;
  if (status === 'COMPLETED') {
    markdown = parseImpactCandidateMarkdown(message.content);
    if (markdown === null) { status = 'FAILED'; errorCode = 'OUTPUT_SCHEMA_INVALID'; }
  }
  return { id: candidate.id, impact_check_id: candidate.impact_check_id,
    target_artifact_id: candidate.target_artifact_id,
    target_version_id: candidate.target_version_id,
    status, error_code: errorCode, markdown,
    stale: source.revision !== candidate.source_artifact_revision ||
      sourceLatest?.id !== check.source_after_version_id ||
      target.revision !== candidate.target_artifact_revision ||
      targetLatest?.id !== candidate.target_version_id,
    applied_version_id: candidate.applied_version_id };
}

/** Explicit user application, still fenced as AI-origin content at the Artifact write boundary. */
export async function applyArtifactImpactCandidate(db: DbExecutor,
  storage: ManagedContentStore, input: { workspaceId: string; candidateId: string;
    commandId: string; expectedTargetRevision: string }): Promise<CommandOutcome<{
      readonly artifact_id: string; readonly version_id: string;
      readonly artifact_revision: string; readonly task_revision: string }>> {
  const expected = requireRevision(input.expectedTargetRevision, 'expected_target_revision');
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'ApplyArtifactImpactCandidate',
    target: { candidate_id: input.candidateId },
    body: { expected_target_revision: expected.toString() },
    execute: async (r) => {
      const candidate = await r.impacts.readCandidate(input.candidateId, true);
      if (!candidate || candidate.workspace_id !== input.workspaceId) throw resourceNotFound('Impact candidate');
      if (candidate.applied_version_id !== null) {
        throw invalidTransition('该修改候选已应用，不能再次生成版本。');
      }
      const check = await r.impacts.read(candidate.impact_check_id);
      const message = await r.assist.readMessage(candidate.assist_message_id);
      if (!check || check.workspace_id !== input.workspaceId || message?.status !== 'COMPLETED') {
        throw invalidTransition('候选尚未完成或来源不可核对，不能应用。');
      }
      const markdown = parseImpactCandidateMarkdown(message.content);
      if (markdown === null) throw invalidTransition('候选正文格式无效，不能应用。');
      normalizeArtifactContent('text/markdown', markdown);
      const source = await r.artifacts.readArtifact(check.artifact_id);
      const target = await r.artifacts.readArtifact(candidate.target_artifact_id);
      if (!source || !target || source.workspace_id !== input.workspaceId ||
          target.workspace_id !== input.workspaceId) throw resourceNotFound('Artifact');
      const tasks = [...new Set([source.task_id, target.task_id])].sort();
      const taskRows = [];
      for (const id of tasks) taskRows.push(await lockTaskInWorkspace(r, input.workspaceId, id));
      const targetTask = taskRows.find((task) => task.id === target.task_id)!;
      requireHumanInProgress(targetTask, '应用 AI 修改候选');
      if (target.project_id) await lockWritableProjectInWorkspace(r, input.workspaceId, target.project_id);
      const artifacts = [...new Set([source.id, target.id])].sort();
      for (const id of artifacts) await lockArtifactInWorkspace(r, input.workspaceId, id);
      const sourceCurrent = await r.artifacts.readArtifact(source.id);
      const targetCurrent = await r.artifacts.readArtifact(target.id);
      const sourceLatest = (await r.artifacts.listArtifactVersions(source.id)).at(-1);
      const targetLatest = (await r.artifacts.listArtifactVersions(target.id)).at(-1);
      if (!sourceCurrent || sourceCurrent.revision !== candidate.source_artifact_revision ||
          sourceLatest?.id !== check.source_after_version_id) {
        throw invalidTransition('来源或授权基线已变化；旧候选不能应用。');
      }
      if (!targetCurrent || targetCurrent.revision !== expected ||
          targetCurrent.revision !== candidate.target_artifact_revision ||
          targetLatest?.id !== candidate.target_version_id) {
        throw revisionConflict({ entityType: 'ARTIFACT', expectedRevision: expected.toString(),
          actualRevision: targetCurrent?.revision.toString() ?? '0' });
      }
      const textLocks = await requireAiTextLocks(r, storage, target.id, markdown);
      const versionId = randomUUID();
      let published;
      try { published = await storage.publish({ artifactId: target.id, versionId,
        content: Buffer.from(markdown, 'utf8') }); }
      catch (error) {
        if (error instanceof StorageConflictError || error instanceof StorageUnavailableError)
          throw storageUnavailable();
        throw error;
      }
      const version = await r.artifacts.insertArtifactVersion({ id: versionId,
        artifactId: target.id, versionNumber: await r.artifacts.nextVersionNumber(target.id),
        storageRef: published.storageRef, contentHash: published.contentHash,
        size: published.size, mediaType: 'text/markdown', sourceKind: 'AI',
        sourceRef: `impact-candidate:${candidate.id}` });
      await advanceAiTextLocks(r, version.id, textLocks);
      await r.lineage.insertExactEdge({ workspaceId: input.workspaceId,
        childVersionId: version.id, relation: 'REVISED_FROM',
        parentKind: 'ARTIFACT_VERSION', parentId: targetLatest.id });
      if (sourceLatest.id !== targetLatest.id) await r.lineage.insertExactEdge({
        workspaceId: input.workspaceId, childVersionId: version.id,
        relation: 'DERIVED_FROM', parentKind: 'ARTIFACT_VERSION', parentId: sourceLatest.id });
      const bumped = await r.artifacts.bumpArtifactRevision(target.id, expected);
      const task = await r.tasks.bumpTaskRevision(target.task_id);
      if (!bumped || !task || !await r.impacts.markApplied(candidate.id, version.id)) {
        throw invalidTransition('应用候选期间基线已变化。');
      }
      await r.activities.insertActivityRecord({ id: randomUUID(),
        workspaceId: input.workspaceId, actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF,
        commandId: input.commandId, projectId: target.project_id, taskId: target.task_id,
        eventType: 'ARTIFACT_VERSION_SAVED', factRefs: {
          artifact_id: target.id, artifact_version_id: version.id,
          source_impact_candidate_id: candidate.id, source_kind: 'AI',
          sha256: published.contentHash.toString('hex') } });
      return { artifact_id: target.id, version_id: version.id,
        artifact_revision: bumped.revision.toString(), task_revision: task.revision.toString() };
    } });
}
