import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import type { ManagedContentStore } from '../storage/managed-content-store.js';
import { httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand, type CommandOutcome } from './command.js';
import { invalidTransition, resourceNotFound } from './domain-error.js';
import { lockArtifactInWorkspace } from './guards.js';
import { readArtifactImpactCheck } from './artifact-impact-checks.js';
import { createRepositories } from './unit-of-work.js';
import type { NewCombinationCheckItem } from '../artifact/impact-repository.js';

/**
 * N02 跨成果共创。候选组只回答「哪几个确切目标被放在一起看」，逐项应用仍走既有
 * ApplyArtifactImpactCandidate；组合检查只保存被一起看过的那的确切版本集合与当时
 * 看到的单项验证事实。两者都不产生整体 PASS，也不持有成果正文或执行权。
 */
const MAX_GROUP_ITEMS = 10;
const MAX_COMBINATION_ITEMS = 20;

interface GroupItemView extends JsonObject {
  readonly ordinal: number;
  readonly target_artifact_id: string;
  readonly target_version_id: string;
  readonly relation: string;
  readonly speculative: boolean;
  readonly availability: string;
  readonly analysed: boolean;
  readonly target_artifact_revision: string;
  readonly target_is_current_version: boolean;
  readonly candidate_id: string | null;
  readonly candidate_status: string | null;
  readonly candidate_error_code: string | null;
  readonly candidate_stale: boolean;
  readonly applied_version_id: string | null;
}

export interface ImpactCandidateGroupDto extends JsonObject {
  readonly id: string;
  readonly impact_check_id: string;
  readonly source_artifact_id: string;
  readonly source_before_version_id: string;
  readonly source_after_version_id: string;
  readonly source_artifact_revision: string;
  readonly created_at: string;
  readonly stale: boolean;
  readonly items: readonly GroupItemView[];
  readonly summary: {
    readonly total: number;
    readonly applied: number;
    readonly with_candidate: number;
    readonly without_candidate: number;
    readonly stale_candidates: number;
    readonly unavailable: number;
  };
  readonly unanalysed_scope: readonly string[];
  readonly combination_check_ids: readonly string[];
}

async function loadGroupScope(db: DbExecutor, workspaceId: string, groupId: string) {
  const r = createRepositories(db);
  const group = await r.impacts.readGroup(groupId);
  if (!group || group.workspace_id !== workspaceId) throw resourceNotFound('Impact candidate group');
  const check = await readArtifactImpactCheck(db, workspaceId, group.impact_check_id);
  const items = await r.impacts.listGroupItems(groupId);
  const source = await r.artifacts.readArtifact(group.source_artifact_id);
  const sourceLatest = source && (await r.artifacts.listArtifactVersions(source.id)).at(-1);
  if (!source || source.workspace_id !== workspaceId) throw resourceNotFound('Impact candidate group');
  return { r, group, check, items, source, sourceLatest };
}

export async function createImpactCandidateGroup(db: DbExecutor, input: { workspaceId: string;
  checkId: string; targetVersionIds: readonly string[]; commandId: string }): Promise<
  CommandOutcome<{ readonly group_id: string; readonly item_count: string }>> {
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'CreateImpactCandidateGroup',
    target: { impact_check_id: input.checkId },
    body: { target_version_ids: [...input.targetVersionIds] },
    execute: async (r) => {
      const check = await readArtifactImpactCheck(db, input.workspaceId, input.checkId);
      const checkRow = await r.impacts.read(input.checkId);
      if (!checkRow) throw resourceNotFound('Impact check');
      // 与 startArtifactImpactCheck 同序：先锁来源成果行再复核基线，
      // 否则并发保存来源版本能在读取与写入之间插入，产生一个立刻 stale 的组。
      await lockArtifactInWorkspace(r, input.workspaceId, checkRow.artifact_id);
      const source = await r.artifacts.readArtifact(checkRow.artifact_id);
      const sourceLatest = source && (await r.artifacts.listArtifactVersions(source.id)).at(-1);
      if (!source || source.workspace_id !== input.workspaceId) {
        throw resourceNotFound('Impact check');
      }
      if (source.revision !== checkRow.artifact_revision ||
          sourceLatest?.id !== checkRow.source_after_version_id) {
        throw invalidTransition('来源成果已变化，请重新发起影响检查再建候选组。');
      }
      const selected = [...input.targetVersionIds];
      if (selected.length === 0 || selected.length > MAX_GROUP_ITEMS ||
          new Set(selected).size !== selected.length) {
        throw invalidTransition(`候选组须选择 1–${MAX_GROUP_ITEMS} 个不重复的已登记直接引用目标。`);
      }
      const relationByVersion = new Map<string, { relation: string; availability: string;
        analysed: boolean }>();
      for (const target of check.direct_targets) {
        relationByVersion.set(String(target.target_version_id), {
          relation: String(target.relation), availability: String(target.availability),
          analysed: target.analysed === true });
      }
      const speculative = new Set(check.possibly_related.map((item) =>
        String(item.target_version_id)));
      const rows = selected.map((versionId, ordinal) => {
        const known = relationByVersion.get(versionId);
        if (!known) {
          throw invalidTransition('候选组目标须逐项来自该检查已登记的直接引用；未登记范围不进入组。');
        }
        return { ordinal, targetVersionId: versionId, relation: known.relation,
          speculative: speculative.has(versionId) };
      });
      const artifacts = new Map<string, string>();
      for (const row of rows) {
        const version = await r.artifacts.readArtifactVersion(row.targetVersionId);
        if (!version) throw invalidTransition('候选组目标的成果版本已不存在。');
        artifacts.set(row.targetVersionId, version.artifact_id);
      }
      const groupId = randomUUID();
      await r.impacts.insertGroup({ id: groupId, workspaceId: input.workspaceId,
        checkId: checkRow.id, sourceArtifactId: source.id,
        beforeVersionId: checkRow.source_before_version_id,
        afterVersionId: checkRow.source_after_version_id,
        sourceArtifactRevision: source.revision });
      await r.impacts.insertGroupItems(rows.map((row) => ({ groupId, ordinal: row.ordinal,
        targetArtifactId: artifacts.get(row.targetVersionId)!, targetVersionId: row.targetVersionId,
        relation: row.relation, speculative: row.speculative })));
      return { group_id: groupId, item_count: String(rows.length) };
    } });
}

export async function readImpactCandidateGroup(db: DbExecutor, workspaceId: string,
  groupId: string): Promise<ImpactCandidateGroupDto> {
  const { r, group, check, items, source, sourceLatest } =
    await loadGroupScope(db, workspaceId, groupId);
  const analysed = new Set(check.direct_targets.filter((target) => target.analysed === true)
    .map((target) => String(target.target_version_id)));
  const views: GroupItemView[] = [];
  for (const item of items) {
    const target = await r.artifacts.readArtifact(item.target_artifact_id);
    const targetLatest = target && (await r.artifacts.listArtifactVersions(target.id)).at(-1);
    const candidate = await r.impacts.findCandidateByTarget(group.impact_check_id,
      item.target_version_id);
    const candidateStale = candidate === undefined ? false
      : target === undefined || target.revision !== candidate.target_artifact_revision ||
        targetLatest?.id !== candidate.target_version_id ||
        source.revision !== candidate.source_artifact_revision ||
        sourceLatest?.id !== group.source_after_version_id;
    const direct = check.direct_targets.find((entry) =>
      String(entry.target_version_id) === item.target_version_id);
    views.push({
      ordinal: item.ordinal,
      target_artifact_id: item.target_artifact_id,
      target_version_id: item.target_version_id,
      relation: item.relation,
      speculative: item.speculative,
      availability: String(direct?.availability ?? 'UNKNOWN'),
      analysed: analysed.has(item.target_version_id),
      target_artifact_revision: (target?.revision ?? 0n).toString(),
      target_is_current_version: targetLatest?.id === item.target_version_id,
      candidate_id: candidate?.id ?? null,
      candidate_status: candidate === undefined ? null
        : (await r.assist.readMessage(candidate.assist_message_id))?.status ?? 'PENDING',
      candidate_error_code: candidate === undefined ? null
        : (await r.assist.readMessage(candidate.assist_message_id))?.error_code ?? null,
      candidate_stale: candidateStale,
      applied_version_id: candidate?.applied_version_id ?? null,
    });
  }
  const combinationChecks = await r.impacts.listCombinationCheckIds(groupId);
  return { id: group.id, impact_check_id: group.impact_check_id,
    source_artifact_id: group.source_artifact_id,
    source_before_version_id: group.source_before_version_id,
    source_after_version_id: group.source_after_version_id,
    source_artifact_revision: group.source_artifact_revision.toString(),
    created_at: group.created_at.toISOString(),
    stale: source.revision !== group.source_artifact_revision ||
      sourceLatest?.id !== group.source_after_version_id,
    items: views,
    summary: {
      total: views.length,
      applied: views.filter((view) => view.applied_version_id !== null).length,
      with_candidate: views.filter((view) => view.candidate_id !== null).length,
      without_candidate: views.filter((view) => view.candidate_id === null).length,
      stale_candidates: views.filter((view) => view.candidate_stale).length,
      unavailable: views.filter((view) => view.availability !== 'AVAILABLE').length,
    },
    unanalysed_scope: check.unanalysed_scope,
    combination_check_ids: combinationChecks };
}

interface CombinationCheckItemView extends JsonObject {
  readonly ordinal: number;
  readonly artifact_id: string;
  readonly artifact_version_id: string;
  readonly is_current_version: boolean;
  readonly readable: boolean;
  readonly verification_session_id: string | null;
  readonly verification_status: string | null;
}

export interface CombinationCheckDto extends JsonObject {
  readonly id: string;
  readonly group_id: string;
  readonly task_id: string;
  readonly acceptance_revision: string;
  readonly created_at: string;
  readonly overall_result: 'NONE';
  readonly overall_note: string;
  readonly stale: boolean;
  readonly gaps: readonly string[];
  readonly items: readonly CombinationCheckItemView[];
}

export async function createCombinationCheck(db: DbExecutor, storage: ManagedContentStore,
  input: { workspaceId: string; groupId: string; artifactVersionIds: readonly string[];
    commandId: string }): Promise<CommandOutcome<{ readonly combination_check_id: string;
      readonly item_count: string; readonly gap_count: string }>> {
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'CreateArtifactCombinationCheck',
    target: { group_id: input.groupId },
    body: { artifact_version_ids: [...input.artifactVersionIds] },
    execute: async (r) => {
      const { group, check, items, source, sourceLatest } =
        await loadGroupScope(db, input.workspaceId, input.groupId);
      const selected = [...input.artifactVersionIds];
      if (selected.length === 0 || selected.length > MAX_COMBINATION_ITEMS ||
          new Set(selected).size !== selected.length) {
        throw invalidTransition(`组合检查须选择 1–${MAX_COMBINATION_ITEMS} 个不重复的确切版本。`);
      }
      const inScope = new Set([group.source_after_version_id,
        ...items.map((item) => item.target_version_id)]);
      if (selected.some((id) => !inScope.has(id))) {
        throw invalidTransition('组合检查的版本集合须落在该候选组的来源与目标范围内。');
      }
      const snapshots = [];
      for (const versionId of selected) {
        const version = await r.artifacts.readArtifactVersion(versionId);
        if (!version) throw invalidTransition('组合检查的成果版本已不存在。');
        const artifact = await r.artifacts.readArtifact(version.artifact_id);
        if (!artifact || artifact.workspace_id !== input.workspaceId) {
          throw resourceNotFound('Artifact version');
        }
        const latest = (await r.artifacts.listArtifactVersions(artifact.id)).at(-1);
        const read = await storage.readWithHashCheck(version.storage_ref,
          { contentHash: version.content_hash, size: version.size });
        snapshots.push({ version, artifact, latest,
          isCurrentVersion: latest?.id === versionId, readable: read.status === 'OK' });
      }
      const taskIds = new Set(snapshots.map((entry) => entry.artifact.task_id));
      if (taskIds.size !== 1) {
        throw invalidTransition('组合检查只能覆盖同一 Task 的成果；跨 Task 的整体判断需另由验收流程给出。');
      }
      const taskId = [...taskIds][0]!;
      const task = await r.tasks.readTask(taskId);
      if (!task || task.workspace_id !== input.workspaceId) throw resourceNotFound('Task');
      const sessions = await r.verifications.listSessionsByTaskCycle(taskId,
        task.acceptance_revision);
      const versionToSession = new Map<string, { id: string; status: string }>();
      for (const session of sessions) {
        for (const target of await r.verifications.listTargets(session.id)) {
          if (!versionToSession.has(target.artifact_version_id)) {
            versionToSession.set(target.artifact_version_id,
              { id: session.id, status: session.status });
          }
        }
      }
      // 登记的直接引用是「变化前版本」的下游（见 startArtifactImpactCheck），
      // 核 after 版本会把每一条正常登记的引用都误报为不存在。
      const edges = await r.lineage.listByParent(input.workspaceId, group.source_before_version_id);
      const recorded = new Set(edges.map((edge) => edge.child_version_id));
      const gaps: string[] = [];
      if (source.revision !== group.source_artifact_revision ||
          sourceLatest?.id !== group.source_after_version_id) {
        gaps.push('来源成果基线已变化，本检查单只反映捕获时点。');
      }
      if (check.has_more) gaps.push('已登记直接引用超过本轮上限，检查范围不完整。');
      if (check.input_truncated) gaps.push('超出模型输入上限的正文未纳入本轮检查。');
      for (const item of items) {
        if (!recorded.has(item.target_version_id)) {
          gaps.push(`组内目标 ${item.target_version_id} 的登记引用在当前事实中不存在。`);
        }
      }
      const rows: NewCombinationCheckItem[] = [];
      let ordinal = 0;
      for (const entry of snapshots) {
        const session = versionToSession.get(entry.version.id);
        if (!entry.readable) gaps.push(`${entry.version.id} 的正文当前不可读，未纳入内容核对。`);
        if (!entry.isCurrentVersion) gaps.push(`${entry.version.id} 已不是该成果的当前版本。`);
        if (!session) {
          gaps.push(`${entry.version.id} 在验收修订 ${task.acceptance_revision.toString()} 下没有单项验证会话。`);
        } else {
          if (session.status !== 'PASS') {
            gaps.push(`${entry.version.id} 的单项验证状态为 ${session.status}，不是 PASS。`);
          }
          if (!await r.verifications.isApplicable(session.id)) {
            gaps.push(`${entry.version.id} 的验证结论已因适用性撤销而失效。`);
          }
        }
        rows.push({ combinationCheckId: '', ordinal, artifactId: entry.artifact.id,
          artifactVersionId: entry.version.id, contentHash: entry.version.content_hash,
          isCurrentVersion: entry.isCurrentVersion, readable: entry.readable,
          verificationSessionId: session?.id ?? null,
          verificationStatus: session?.status ?? null });
        ordinal += 1;
      }
      const combinationCheckId = randomUUID();
      await r.impacts.insertCombinationCheck({ id: combinationCheckId,
        workspaceId: input.workspaceId, groupId: group.id, taskId,
        acceptanceRevision: task.acceptance_revision,
        gaps: gaps.map((text) => ({ gap: text })) });
      await r.impacts.insertCombinationCheckItems(rows.map((row) =>
        ({ ...row, combinationCheckId })));
      return { combination_check_id: combinationCheckId, item_count: String(rows.length),
        gap_count: String(gaps.length) };
    } });
}

export async function readCombinationCheck(db: DbExecutor, workspaceId: string,
  checkId: string): Promise<CombinationCheckDto> {
  const r = createRepositories(db);
  const check = await r.impacts.readCombinationCheck(checkId);
  if (!check || check.workspace_id !== workspaceId) throw resourceNotFound('Combination check');
  const group = await r.impacts.readGroup(check.group_id);
  if (!group || group.workspace_id !== workspaceId) throw resourceNotFound('Combination check');
  const task = await r.tasks.readTask(check.task_id);
  if (!task || task.workspace_id !== workspaceId) throw resourceNotFound('Combination check');
  const rows = await r.impacts.listCombinationCheckItems(checkId);
  const items = [];
  let stale = task.acceptance_revision !== check.acceptance_revision;
  for (const row of rows) {
    const version = await r.artifacts.readArtifactVersion(row.artifact_version_id);
    const latest = version && (await r.artifacts.listArtifactVersions(version.artifact_id)).at(-1);
    const current = latest?.id === row.artifact_version_id;
    if (!current) stale = true;
    items.push({ ordinal: row.ordinal, artifact_id: row.artifact_id,
      artifact_version_id: row.artifact_version_id, is_current_version: current,
      readable: row.readable, verification_session_id: row.verification_session_id,
      verification_status: row.verification_status });
  }
  return { id: check.id, group_id: check.group_id, task_id: check.task_id,
    acceptance_revision: check.acceptance_revision.toString(),
    created_at: check.created_at.toISOString(),
    overall_result: 'NONE',
    overall_note: '这是确切版本集合的覆盖快照，不是整体验收结论；单项 PASS 不等于组合通过。',
    stale, gaps: check.gaps.map((gap) => String(gap.gap ?? '')), items };
}
