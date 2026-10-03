import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import { httpCommandScopeKey } from './actor.js';
import { resolveExistingReceipt, runIdempotentCommand, type CommandOutcome } from './command.js';
import { invalidTransition, resourceNotFound, revisionConflict } from './domain-error.js';
import { computePayloadHash } from '../receipt/payload-hash.js';
import { lockProjectInWorkspace, readArtifactVersionInWorkspace, readProjectInWorkspace,
  readTaskInWorkspace } from './guards.js';
import { requireRevision } from './revisions.js';
import { createRepositories } from './unit-of-work.js';
import type { GuideRefKind, NewGuideEntry } from '../project/knowledge-guide-repository.js';

/**
 * N03 项目知识导读。Project 拥有导读编排本身；条目只保存确切引用与人工标签，
 * 不复制正文、不维护第二份当前状态，也不改写任何 Rule / Decision。
 * PINNED 钉住确切知识版本，CURRENT 只作导航并在读取时解析到当前版本。
 */
const MAX_ENTRIES = 200;
const MAX_LABEL = 200;

export interface GuideEntryInput {
  readonly ref_kind: GuideRefKind;
  readonly reference_mode: 'PINNED' | 'CURRENT';
  readonly knowledge_id?: string;
  readonly decision_id?: string;
  readonly rule_id?: string;
  readonly artifact_version_id?: string;
  readonly pinned_version_id?: string;
  readonly label?: string;
}

export interface KnowledgeGuideEntryView extends JsonObject {
  readonly ordinal: number;
  readonly ref_kind: GuideRefKind;
  readonly reference_mode: 'PINNED' | 'CURRENT';
  readonly target_id: string;
  readonly label: string | null;
  readonly title: string | null;
  readonly resolved_version_id: string | null;
  readonly resolved_version_number: string | null;
  readonly target_status: string;
  readonly is_current: boolean;
  readonly resolution:
    | 'AVAILABLE' | 'ARCHIVED' | 'SUPERSEDED' | 'STALE' | 'CROSS_SCOPE' | 'MISSING';
  readonly note: string;
}

export interface ProjectKnowledgeGuideDto extends JsonObject {
  readonly project_id: string;
  readonly exists: boolean;
  readonly revision: string;
  readonly entry_count: number;
  readonly entries: readonly KnowledgeGuideEntryView[];
  readonly gaps: readonly string[];
}

interface ResolvedRef {
  readonly kind: GuideRefKind;
  readonly targetId: string;
  readonly knowledgeId: string | null;
  readonly decisionId: string | null;
  readonly ruleId: string | null;
  readonly artifactVersionId: string | null;
  readonly pinnedVersionId: string | null;
}

function normalizeEntry(input: GuideEntryInput, seen: Set<string>): ResolvedRef {
  const supplied = [
    input.knowledge_id === undefined ? null : input.knowledge_id,
    input.decision_id === undefined ? null : input.decision_id,
    input.rule_id === undefined ? null : input.rule_id,
    input.artifact_version_id === undefined ? null : input.artifact_version_id,
  ];
  const present = supplied.filter((value) => value !== null);
  const expectedKind: Record<GuideRefKind, number> = {
    KNOWLEDGE: 0, DECISION: 1, RULE: 2, ARTIFACT_VERSION: 3,
  };
  const slot = expectedKind[input.ref_kind];
  if (present.length !== 1 || supplied[slot] === null) {
    throw invalidTransition('导读条目必须且只能提供与 ref_kind 对应的一个对象 ID。');
  }
  const label = input.label ?? null;
  if (label !== null && (label.length > MAX_LABEL || label.trim() === '')) {
    throw invalidTransition(`导读条目说明需为 1–${MAX_LABEL} 字。`);
  }
  const targetId = present[0]!;
  if (seen.has(`${input.ref_kind}:${targetId}`)) {
    throw invalidTransition('同一对象不能在导读里重复出现。');
  }
  seen.add(`${input.ref_kind}:${targetId}`);
  if (input.reference_mode === 'PINNED') {
    if (input.ref_kind !== 'KNOWLEDGE' || input.pinned_version_id === undefined) {
      throw invalidTransition('固定引用只适用于知识，且必须给出确切知识版本 ID。');
    }
  } else if (input.pinned_version_id !== undefined) {
    throw invalidTransition('跟随当前的条目不能同时钉住版本。');
  }
  return { kind: input.ref_kind, targetId,
    knowledgeId: input.knowledge_id ?? null,
    decisionId: input.decision_id ?? null,
    ruleId: input.rule_id ?? null,
    artifactVersionId: input.artifact_version_id ?? null,
    pinnedVersionId: input.pinned_version_id ?? null };
}

/** 写入前逐条复核当前作用域；跨项目引用在保存时就被拒绝，而不是读时才隐藏。 */
async function requireReferenceInScope(db: DbExecutor, workspaceId: string, projectId: string,
  entry: ResolvedRef): Promise<void> {
  const r = createRepositories(db);
  if (entry.kind === 'ARTIFACT_VERSION') {
    const { version, artifact } = await readArtifactVersionInWorkspace(r, workspaceId,
      entry.artifactVersionId!);
    const task = await readTaskInWorkspace(r, workspaceId, artifact.task_id);
    if (task.project_id !== projectId) {
      throw invalidTransition('导读不能引用其他项目的成果版本。');
    }
    void version;
    return;
  }
  const kind = entry.kind === 'KNOWLEDGE' ? 'knowledge'
    : entry.kind === 'DECISION' ? 'decision' : 'rule';
  const root = await r.information.readRoot(kind, entry.targetId);
  if (!root || root.workspace_id !== workspaceId) throw resourceNotFound(entry.kind);
  if (root.project_id !== null && root.project_id !== projectId) {
    throw invalidTransition('导读不能引用其他项目的条目。');
  }
  if (entry.pinnedVersionId !== null) {
    const versions = await r.information.listVersions<{ id: string; knowledge_id: string }>(
      'knowledge', entry.targetId);
    if (!versions.some((version) => version.id === entry.pinnedVersionId)) {
      throw invalidTransition('固定的知识版本不属于该知识条目。');
    }
  }
}

function guidePayloadHash(input: { workspaceId: string; projectId: string;
  commandId: string; expectedRevision: string; entries: readonly GuideEntryInput[] }): Buffer {
  return computePayloadHash({ commandType: 'SaveProjectKnowledgeGuide',
    target: { project_id: input.projectId },
    body: { expected_revision: input.expectedRevision,
      entries: input.entries.map((entry) => ({ ...entry })) } });
}

export async function saveProjectKnowledgeGuide(db: DbExecutor, input: { workspaceId: string;
  projectId: string; expectedRevision: string; entries: readonly GuideEntryInput[];
  commandId: string }): Promise<CommandOutcome<{ readonly revision: string;
    readonly entry_count: string }>> {
  const expected = requireRevision(input.expectedRevision, 'expected_revision');
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'SaveProjectKnowledgeGuide',
    target: { project_id: input.projectId },
    body: { expected_revision: expected.toString(),
      entries: input.entries.map((entry) => ({ ...entry })) },
    execute: async (r) => {
      await lockProjectInWorkspace(r, input.workspaceId, input.projectId);
      // 取得 Project 行锁后再查一次原回执：否则并发同 command_id 的两个事务都在
      // 首次回执查询时看不到对方，输家会拿到 REVISION_CONFLICT 而不是原回执重放，
      // 客户端据此换新 ID 重发就会静默覆盖人工编排（P2-3）。
      const committedWhileWaiting = await r.receipts.findReceipt({
        scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId });
      if (committedWhileWaiting !== undefined) {
        // 摘要不同则由 resolveExistingReceipt 抛 CommandIdReusedError，与首次路径一致。
        // 摘要相同则直接返回结果；随后的 insertReceipt 会撞唯一键，整笔回滚后由
        // runIdempotentCommand 的 catch 重查并返回 replayed: true 的原回执。
        const replayed = resolveExistingReceipt<{ revision: string; entry_count: string }>(
          committedWhileWaiting, guidePayloadHash(input));
        return { ...replayed.result };
      }
      const existing = await r.knowledgeGuides.lockGuideByProject(input.projectId);
      if (existing !== undefined && existing.workspace_id !== input.workspaceId) {
        throw resourceNotFound('Project knowledge guide');
      }
      if ((existing?.revision ?? 0n) !== expected) {
        throw revisionConflict({ entityType: 'KNOWLEDGE_GUIDE',
          expectedRevision: expected.toString(),
          actualRevision: (existing?.revision ?? 0n).toString() });
      }
      if (input.entries.length > MAX_ENTRIES) {
        throw invalidTransition(`导读条目最多 ${MAX_ENTRIES} 项。`);
      }
      const seen = new Set<string>();
      const resolved = input.entries.map((entry) => normalizeEntry(entry, seen));
      for (const entry of resolved) {
        await requireReferenceInScope(db, input.workspaceId, input.projectId, entry);
      }
      const guide = existing ?? await r.knowledgeGuides.insertGuide({ id: randomUUID(),
        workspaceId: input.workspaceId, projectId: input.projectId });
      const rows: NewGuideEntry[] = resolved.map((entry, ordinal) => ({ guideId: guide.id,
        ordinal, refKind: entry.kind, referenceMode:
          input.entries[ordinal]!.reference_mode,
        knowledgeId: entry.knowledgeId, decisionId: entry.decisionId, ruleId: entry.ruleId,
        artifactVersionId: entry.artifactVersionId, pinnedVersionId: entry.pinnedVersionId,
        label: input.entries[ordinal]!.label ?? null }));
      await r.knowledgeGuides.replaceEntries(guide.id, rows);
      if (!await r.knowledgeGuides.bumpRevision(guide.id, expected)) {
        throw invalidTransition('保存导读期间基线已变化。');
      }
      return { revision: (expected + 1n).toString(), entry_count: String(rows.length) };
    } });
}

export async function readProjectKnowledgeGuide(db: DbExecutor, workspaceId: string,
  projectId: string): Promise<ProjectKnowledgeGuideDto> {
  const r = createRepositories(db);
  await readProjectInWorkspace(r, workspaceId, projectId);
  const guide = await r.knowledgeGuides.readGuideByProject(projectId);
  if (!guide || guide.workspace_id !== workspaceId) {
    return { project_id: projectId, exists: false, revision: '0', entry_count: 0,
      entries: [], gaps: [] };
  }
  const rows = await r.knowledgeGuides.listEntries(guide.id);
  const entries: KnowledgeGuideEntryView[] = [];
  const gaps: string[] = [];
  for (const row of rows) {
    const view = await resolveEntry(db, workspaceId, projectId, row, gaps);
    entries.push(view);
  }
  return { project_id: projectId, exists: true, revision: guide.revision.toString(),
    entry_count: entries.length, entries, gaps };
}

async function resolveEntry(db: DbExecutor, workspaceId: string, projectId: string,
  row: { ordinal: number; ref_kind: GuideRefKind; reference_mode: 'PINNED' | 'CURRENT';
    target_id: string; label: string | null; pinned_version_id: string | null },
  gaps: string[]): Promise<KnowledgeGuideEntryView> {
  const r = createRepositories(db);
  const base = { ordinal: row.ordinal, ref_kind: row.ref_kind,
    reference_mode: row.reference_mode, target_id: row.target_id, label: row.label };
  if (row.ref_kind === 'ARTIFACT_VERSION') {
    const version = await r.artifacts.readArtifactVersion(row.target_id);
    if (!version) {
      gaps.push(`第 ${row.ordinal + 1} 项的成果版本已不可读。`);
      return { ...base, title: null, resolved_version_id: null, resolved_version_number: null,
        target_status: 'UNKNOWN', is_current: false, resolution: 'MISSING',
        note: '该确切成果版本当前不可读；不以最新版替代。' };
    }
    const artifact = await r.artifacts.readArtifact(version.artifact_id);
    const latest = artifact && (await r.artifacts.listArtifactVersions(artifact.id)).at(-1);
    const task = artifact && await r.tasks.readTask(artifact.task_id);
    const current = latest?.id === version.id;
    const crossScope = task !== undefined && task.workspace_id === workspaceId &&
      task.project_id !== projectId;
    return { ...base, title: artifact?.title ?? null, resolved_version_id: version.id,
      resolved_version_number: version.version_number.toString(),
      target_status: artifact === undefined ? 'UNKNOWN' : 'ACTIVE', is_current: current,
      resolution: crossScope ? 'CROSS_SCOPE' : current ? 'AVAILABLE' : 'STALE',
      note: current ? '该确切版本仍是当前版本。' : '该确切版本已被更新版本取代，仍按原版本阅读。' };
  }
  const kind = row.ref_kind === 'KNOWLEDGE' ? 'knowledge'
    : row.ref_kind === 'DECISION' ? 'decision' : 'rule';
  const root = await r.information.readRoot(kind, row.target_id);
  if (!root || root.workspace_id !== workspaceId) {
    gaps.push(`第 ${row.ordinal + 1} 项的${kindLabel(row.ref_kind)}当前不可读或无权查看。`);
    return { ...base, title: null, resolved_version_id: null, resolved_version_number: null,
      target_status: 'UNKNOWN', is_current: false, resolution: 'MISSING',
      note: '该条目当前不可读或无权查看；不以来源最新版替代。' };
  }
  const crossScope = root.project_id !== null && root.project_id !== projectId;
  const archived = root.status !== 'ACTIVE';
  const superseded = row.ref_kind === 'DECISION' && root.status === 'SUPERSEDED';
  const versions = await r.information.listVersions<{ id: string; version: bigint }>(kind,
    row.target_id);
  const currentVersion = versions[0];
  const resolved = row.pinned_version_id ?? currentVersion?.id ?? null;
  const resolvedVersion = versions.find((version) => version.id === resolved) ?? null;
  const isCurrent = row.reference_mode === 'CURRENT'
    ? resolvedVersion !== null && resolvedVersion.id === currentVersion?.id
    : resolvedVersion !== null && resolvedVersion.id === currentVersion?.id;
  const resolution = crossScope ? 'CROSS_SCOPE'
    : superseded ? 'SUPERSEDED'
    : archived ? 'ARCHIVED'
    : row.pinned_version_id !== null && resolvedVersion === null ? 'MISSING'
    : isCurrent ? 'AVAILABLE' : 'STALE';
  if (resolution === 'MISSING' || resolution === 'CROSS_SCOPE') {
    gaps.push(`第 ${row.ordinal + 1} 项的${kindLabel(row.ref_kind)}${
      resolution === 'MISSING' ? '固定版本已不存在' : '属于其他项目'}。`);
  }
  const title = 'title' in root && typeof root.title === 'string' ? root.title : null;
  return { ...base, title, resolved_version_id: resolved,
    resolved_version_number: resolvedVersion?.version.toString() ?? null,
    target_status: root.status, is_current: isCurrent, resolution,
    note: guideNote(row.ref_kind, row.reference_mode, resolution, isCurrent) };
}

function kindLabel(kind: GuideRefKind): string {
  return kind === 'KNOWLEDGE' ? '知识' : kind === 'DECISION' ? '决定' : '规则';
}

function guideNote(kind: GuideRefKind, mode: 'PINNED' | 'CURRENT',
  resolution: KnowledgeGuideEntryView['resolution'], isCurrent: boolean): string {
  if (resolution === 'CROSS_SCOPE') return '该条目属于其他项目，未在导读中展开。';
  if (resolution === 'SUPERSEDED') return '该决定已被替代；导读保留原决定，不改写历史。';
  if (resolution === 'ARCHIVED') return '该条目已归档或停用，仍按原版本阅读。';
  if (resolution === 'MISSING') return '固定的确切版本已不存在；不静默换成当前版本。';
  if (mode === 'PINNED') {
    return isCurrent ? '固定引用；该版本目前也正是当前版本。'
      : '固定引用；其后已有新版本，这里仍按钉住的确切版本阅读。';
  }
  return kind === 'ARTIFACT_VERSION' ? '' : '跟随当前；读取时解析到确切版本。';
}
