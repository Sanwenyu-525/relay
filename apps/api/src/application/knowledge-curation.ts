import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import type { ManagedContentStore } from '../storage/managed-content-store.js';
import { httpCommandScopeKey } from './actor.js';
import { sql } from 'kysely';

import { runIdempotentCommand, resolveExistingReceipt, type CommandOutcome } from './command.js';
import { invalidTransition, resourceNotFound, revisionConflict } from './domain-error.js';
import { addKnowledgeVersion, createKnowledge } from './information-commands.js';
import { addKnowledgeVersionInTransaction, createKnowledgeInTransaction } from
  './information-commands.js';
import { computePayloadHash } from '../receipt/payload-hash.js';
import { withTransaction } from './unit-of-work.js';
import { lockProjectInWorkspace, readArtifactVersionInWorkspace, readTaskInWorkspace }
  from './guards.js';
import { requireRevision } from './revisions.js';
import { createRepositories } from './unit-of-work.js';

/**
 * N03 整理候选。候选只由用户主动请求产生，是「可能重复」的人工提示与建议归类，
 * 不是模型判断：它不自动合并、不自动删除、不改写任何 Rule / Decision，
 * 也不因模型或相似度而自行产生新知识版本。接受仍走既有 AddKnowledgeVersion。
 */
const MAX_CANDIDATES = 20;
const MAX_SOURCES = 10;
const MAX_TITLE = 200;
const TITLE_MATCH_FLOOR = 4;

export interface CurationCandidateDto extends JsonObject {
  readonly id: string;
  readonly project_id: string;
  readonly source_artifact_version_id: string;
  readonly source_artifact_id: string;
  readonly source_version_number: string;
  readonly source_title: string;
  readonly suggested_title: string;
  readonly suggested_knowledge_id: string | null;
  readonly suggested_knowledge_title: string | null;
  readonly similar: readonly { readonly knowledge_id: string; readonly title: string;
    readonly status: string; readonly reason: string }[];
  readonly status: 'PROPOSED' | 'ACCEPTED' | 'REJECTED' | 'STALE';
  readonly accepted_knowledge_id: string | null;
  readonly accepted_knowledge_version_id: string | null;
  readonly stale_reason: string | null;
  readonly rejected_at: string | null;
}

interface CandidateRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly project_id: string;
  readonly source_artifact_id: string;
  readonly source_artifact_version_id: string;
  readonly source_artifact_revision: bigint;
  readonly suggested_title: string;
  readonly suggested_knowledge_id: string | null;
  readonly accepted_knowledge_id: string | null;
  readonly accepted_knowledge_version_id: string | null;
  readonly created_at: Date;
}

/** 字面相似提示：只提示，不合并。标题去掉空白后取公共前缀，长度不足不给结论。 */
function sharedPrefixLength(left: string, right: string): number {
  const a = left.replace(/\s+/gu, '');
  const b = right.replace(/\s+/gu, '');
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index += 1;
  return index;
}

async function buildSimilar(db: DbExecutor, workspaceId: string, projectId: string,
  title: string): Promise<readonly { knowledge_id: string; title: string; status: string;
    reason: string }[]> {
  const r = createRepositories(db);
  // 规则没有标题，相似提示只对知识与决定有意义，因此按知识条目查询。
  const rows = await r.information.listRoots('knowledge', workspaceId, projectId);
  // 只看本项目的知识：工作空间级知识不能作为本项目收录的目标，
  // 把它列为「建议归入」会造出一个永远无法执行的动作（P2-4）。
  const titled = rows.filter((row): row is typeof row & { title: string; project_id: string | null } =>
    'title' in row && typeof row.title === 'string' && row.project_id === projectId);
  const exact = new Set(titled.filter((row) => row.title === title).map((row) => row.id));
  const near = titled.filter((row) => row.title !== title &&
    sharedPrefixLength(row.title, title) >= TITLE_MATCH_FLOOR);
  return [
    ...titled.filter((row) => exact.has(row.id))
      .map((row) => ({ knowledge_id: row.id, title: row.title, status: row.status,
        reason: '标题完全相同；可能是同一条内容的重复收录。' })),
    ...near.map((row) => ({ knowledge_id: row.id, title: row.title, status: row.status,
      reason: '标题前若干字相同；仅提示，不自动合并。' })),
  ];
}

export async function createCurationCandidates(db: DbExecutor, input: { workspaceId: string;
  projectId: string; sources: readonly { readonly artifact_version_id: string;
    readonly suggested_title?: string }[]; commandId: string }): Promise<CommandOutcome<{
      readonly candidate_ids: readonly string[] }>> {
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'CreateKnowledgeCurationCandidates',
    target: { project_id: input.projectId },
    body: { sources: input.sources.map((source) => ({ ...source })) },
    execute: async (r) => {
      await lockProjectInWorkspace(r, input.workspaceId, input.projectId);
      if (input.sources.length === 0 || input.sources.length > MAX_SOURCES) {
        throw invalidTransition(`一次可对 ${MAX_SOURCES} 个成果版本提出整理候选。`);
      }
      const ids: string[] = [];
      for (const source of input.sources) {
        const { version, artifact } = await readArtifactVersionInWorkspace(r, input.workspaceId,
          source.artifact_version_id);
        const task = await readTaskInWorkspace(r, input.workspaceId, artifact.task_id);
        if (task.project_id !== input.projectId) {
          throw invalidTransition('只能对本项目的成果版本提出整理候选。');
        }
        const title = source.suggested_title ?? artifact.title ?? '';
        const trimmed = title.trim();
        if (trimmed === '' || trimmed.length > MAX_TITLE) {
          throw invalidTransition(`整理候选标题需为 1–${MAX_TITLE} 字。`);
        }
        const similar = await buildSimilar(db, input.workspaceId, input.projectId, trimmed);
        // 只在字面完全相同时建议归入既有条目；否则一律建议新建，不猜。
        const exactMatch = similar.find((row) => row.title === trimmed);
        const candidate = await r.information.insertCurationCandidate({
          id: randomUUID(), workspaceId: input.workspaceId, projectId: input.projectId,
          sourceArtifactId: artifact.id, sourceArtifactVersionId: version.id,
          sourceArtifactRevision: artifact.revision, suggestedTitle: trimmed,
          suggestedKnowledgeId: exactMatch?.knowledge_id ?? null });
        ids.push(candidate.id);
      }
      return { candidate_ids: ids };
    } });
}



export async function listCurationCandidates(db: DbExecutor, workspaceId: string,
  projectId: string): Promise<readonly CurationCandidateDto[]> {
  const r = createRepositories(db);
  const rows = await r.information.listCurationCandidates(workspaceId, projectId,
    MAX_CANDIDATES);
  const out: CurationCandidateDto[] = [];
  for (const row of rows) {
    const version = await r.artifacts.readArtifactVersion(row.source_artifact_version_id);
    const artifact = await r.artifacts.readArtifact(row.source_artifact_id);
    const latest = artifact && (await r.artifacts.listArtifactVersions(artifact.id)).at(-1);
    const moved = artifact === undefined || artifact.revision !== row.source_artifact_revision ||
      latest?.id !== row.source_artifact_version_id;
    const similar = await buildSimilar(db, workspaceId, projectId, row.suggested_title);
    const accepted = row.accepted_knowledge_version_id !== null;
    const rejected = row.rejected_at !== null;
    // 终态优先于缺口：已拒绝的候选不该再被「来源已变化」之类的说法盖过。
    const staleReason = accepted || rejected ? null
      : moved ? '来源成果已变化；旧候选不能沿用，请按当前版本重新提出。'
      : similar.some((item) => item.knowledge_id !== row.suggested_knowledge_id &&
          item.title === row.suggested_title)
        ? '已有同标题条目；请先确认是新增一条还是归入既有条目。'
        : null;
    out.push({ id: row.id, project_id: row.project_id,
      source_artifact_version_id: row.source_artifact_version_id,
      source_artifact_id: row.source_artifact_id,
      source_version_number: version?.version_number.toString() ?? '0',
      source_title: artifact?.title ?? '（成果已不可读）',
      suggested_title: row.suggested_title,
      suggested_knowledge_id: row.suggested_knowledge_id,
      suggested_knowledge_title: similar.find((item) =>
        item.knowledge_id === row.suggested_knowledge_id)?.title ?? null,
      similar,
      status: accepted ? 'ACCEPTED' : rejected ? 'REJECTED'
        : staleReason !== null ? 'STALE' : 'PROPOSED',
      accepted_knowledge_id: row.accepted_knowledge_id,
      accepted_knowledge_version_id: row.accepted_knowledge_version_id,
      stale_reason: staleReason,
      rejected_at: row.rejected_at?.toISOString() ?? null });
  }
  return out;
}

/**
 * 接受候选：只调用既有 AddKnowledgeVersion 或 CreateKnowledge，
 * 因此新版本照样不可变、照样要人工验收，也不会顺带升级 Rule / Decision。
 */
/**
 * 接受候选：不外层再包一条命令，而是复用既有 CreateKnowledge / AddKnowledgeVersion 的
 * 幂等与事务（派生命令 ID），随后按候选自身状态绑定接受结果。
 * 这样做是因为命令不可嵌套：内层命令各自开事务，外层再包一层会在同一行上互锁。
 */
export async function acceptCurationCandidate(db: DbExecutor, input: { workspaceId: string;
  projectId: string; candidateId: string; commandId: string }): Promise<{
    readonly candidate_id: string; readonly knowledge_id: string;
    readonly knowledge_version_id: string; readonly knowledge_revision: string;
    readonly mode: 'CREATED' | 'NEW_VERSION'; readonly replayed: boolean }> {
  const scopeKey = httpCommandScopeKey(input.workspaceId);
  // 先在事务外查原回执：重放必须命中它，而不是走到「已接受」的 409。
  const before = createRepositories(db);
  const replayedReceipt = await before.receipts.findReceipt({ scopeKey,
    commandId: input.commandId });
  if (replayedReceipt !== undefined) {
    const resolved = resolveExistingReceipt<JsonObject>(replayedReceipt,
      acceptPayloadHash(input));
    return { ...(resolved.result as unknown as {
      candidate_id: string; knowledge_id: string; knowledge_version_id: string;
      knowledge_revision: string; mode: 'CREATED' | 'NEW_VERSION' }), replayed: true };
  }
  // 接受必须「锁候选 → 复核 → 写知识版本 → 绑定候选」全在同一个事务里。
  // 否则拒绝与接受并发时，拒绝可以先提交，而知识版本已在内层命令的独立事务落地，
  // 产生一个在候选审计链上无归属的孤立版本（P1-1）。
  return withTransaction(db, async (r) => {
    await lockProjectInWorkspace(r, input.workspaceId, input.projectId);
    // 取得 Project 行锁后再查一次回执：两个同 command_id 的并发请求都在事务外查过，
    // 输家等锁期间赢家已提交，此时必须返回原回执而不是「已接受」的 409（P2-2）。
    const committedWhileWaiting = await r.receipts.findReceipt({ scopeKey,
      commandId: input.commandId });
    if (committedWhileWaiting !== undefined) {
      const replayed = resolveExistingReceipt<JsonObject>(committedWhileWaiting,
        acceptPayloadHash(input));
      const value = replayed.result as unknown as { candidate_id: string;
        knowledge_id: string; knowledge_version_id: string; knowledge_revision: string;
        mode: 'CREATED' | 'NEW_VERSION' };
      return { ...value, replayed: true };
    }
    const row = await r.information.readCurationCandidate(input.candidateId, true);
    if (!row || row.workspace_id !== input.workspaceId || row.project_id !== input.projectId) {
      throw resourceNotFound('Curation candidate');
    }
    if (row.rejected_at !== null) throw invalidTransition('该整理候选已被拒绝，不能再接受。');
    if (row.accepted_knowledge_version_id !== null) {
      throw invalidTransition('该整理候选已接受，不能再次产生知识版本。');
    }
    const { artifact, version } = await readArtifactVersionInWorkspace(r, input.workspaceId,
      row.source_artifact_version_id);
    const latest = (await r.artifacts.listArtifactVersions(artifact.id)).at(-1);
    if (artifact.revision !== row.source_artifact_revision ||
        latest?.id !== row.source_artifact_version_id) {
      throw invalidTransition('来源成果已变化；旧候选不能接受。');
    }
    const source = { sourceKind: 'ARTIFACT_VERSION', artifactVersionId: version.id } as const;
    let knowledgeId: string;
    let revision: string;
    let mode: 'CREATED' | 'NEW_VERSION';
    if (row.suggested_knowledge_id !== null) {
      const existing = await r.information.readRoot('knowledge', row.suggested_knowledge_id);
      if (!existing || existing.workspace_id !== input.workspaceId) {
        throw resourceNotFound('Knowledge');
      }
      if (existing.project_id !== input.projectId) {
        throw invalidTransition(existing.project_id === null
          ? '该建议来自工作空间级知识，不能作为本项目的收录目标。'
          : '不能把成果收录进其他项目的知识。');
      }
      if (existing.status !== 'ACTIVE') throw invalidTransition('目标知识已归档。');
      const expected = requireRevision(existing.revision.toString(), 'expected_revision');
      const created = await addKnowledgeVersionInTransaction(r, { workspaceId: input.workspaceId,
        knowledgeId: existing.id, expectedRevision: expected.toString(), source,
        commandId: input.commandId });
      knowledgeId = created.knowledge_id!;
      revision = created.revision;
      mode = 'NEW_VERSION';
    } else {
      const created = await createKnowledgeInTransaction(r, { workspaceId: input.workspaceId,
        projectId: input.projectId, title: row.suggested_title, source,
        commandId: input.commandId });
      knowledgeId = created.knowledge_id!;
      revision = created.revision;
      mode = 'CREATED';
    }
    const versions = await r.information.listVersions<{ id: string }>('knowledge', knowledgeId);
    const versionId = versions[0]?.id;
    if (versionId === undefined) throw invalidTransition('知识版本写入后不可读。');
    if (!await r.information.markCurationAccepted(row.id, knowledgeId, versionId)) {
      throw invalidTransition('接受整理候选期间候选已被处理。');
    }
    // 在同一事务里写自己的回执，重放才有原结果可返回。
    await r.receipts.insertReceipt({ scopeKey, commandId: input.commandId,
      commandType: 'AcceptKnowledgeCurationCandidate',
      payloadHash: acceptPayloadHash(input),
      result: { candidate_id: row.id, knowledge_id: knowledgeId,
        knowledge_version_id: versionId, knowledge_revision: revision, mode } });
    return { candidate_id: row.id, knowledge_id: knowledgeId,
      knowledge_version_id: versionId, knowledge_revision: revision, mode, replayed: false };
  });
}

function acceptPayloadHash(input: { workspaceId: string; projectId: string;
  candidateId: string; commandId: string }): Buffer {
  return computePayloadHash({ commandType: 'AcceptKnowledgeCurationCandidate',
    target: { candidate_id: input.candidateId },
    body: { project_id: input.projectId } });
}

export async function rejectCurationCandidate(db: DbExecutor, input: { workspaceId: string;
  projectId: string; candidateId: string; commandId: string }): Promise<CommandOutcome<{
    readonly candidate_id: string; readonly status: 'REJECTED' }>> {
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'RejectKnowledgeCurationCandidate',
    target: { candidate_id: input.candidateId },
    body: { project_id: input.projectId },
    execute: async (r) => {
      await lockProjectInWorkspace(r, input.workspaceId, input.projectId);
      const row = await r.information.readCurationCandidate(input.candidateId, true);
      if (!row || row.workspace_id !== input.workspaceId ||
          row.project_id !== input.projectId) {
        throw resourceNotFound('Curation candidate');
      }
      if (row.accepted_knowledge_version_id !== null) {
        throw revisionConflict({ entityType: 'CURATION_CANDIDATE',
          expectedRevision: '0', actualRevision: '1' });
      }
      await r.information.markCurationRejected(row.id);
      return { candidate_id: row.id, status: 'REJECTED' };
    } });
}
