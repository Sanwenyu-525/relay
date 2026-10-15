import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import type { ArtifactImpactCandidateRow } from '../artifact/impact-repository.js';
import { httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand } from './command.js';
import { DomainError, invalidTransition, resourceNotFound } from './domain-error.js';
import { lockArtifactInWorkspace } from './guards.js';
import { createRepositories, type Repositories } from './unit-of-work.js';
import { readArtifactImpactCandidate, parseImpactCandidateMarkdown } from './artifact-impact-checks.js';

export interface ImpactGroupDependency {
  readonly target_version_id: string;
  readonly depends_on_target_version_id: string;
}

/** 只对用户明确登记的组内关系排序，不从文本或目录推断依赖。 */
export function impactDependencyOrder(targets: readonly string[], dependencies: readonly ImpactGroupDependency[]): string[] {
  const scope = new Set(targets), seen = new Set<string>();
  if (dependencies.length > 90) throw invalidTransition('候选组最多登记 90 条依赖。');
  for (const d of dependencies) {
    const key = `${d.target_version_id}:${d.depends_on_target_version_id}`;
    if (!scope.has(d.target_version_id) || !scope.has(d.depends_on_target_version_id) ||
        d.target_version_id === d.depends_on_target_version_id || seen.has(key)) {
      throw invalidTransition('依赖须为组内不同目标间的不重复关系。');
    }
    seen.add(key);
  }
  const pending = [...targets], ordered: string[] = [];
  while (pending.length > 0) {
    const index = pending.findIndex(id => dependencies.every(d => d.target_version_id !== id || ordered.includes(d.depends_on_target_version_id)));
    if (index < 0) throw invalidTransition('候选组依赖存在循环，请重新圈定。');
    ordered.push(pending.splice(index, 1)[0]!);
  }
  return ordered;
}

interface SelectedItem extends JsonObject {
  candidate_id: string; target_artifact_id: string; target_version_id: string;
  expected_target_revision: string; dependency_candidate_ids: string[];
}

async function dependencyState(r: Repositories, ids: readonly string[]) {
  for (const id of ids) {
    const parent = await r.impacts.readCandidate(id);
    if (parent?.applied_version_id == null) return 'PREREQUISITE_NOT_APPLIED';
    const latest = (await r.artifacts.listArtifactVersions(parent.target_artifact_id)).at(-1);
    if (latest?.id !== parent.applied_version_id) return 'PREREQUISITE_CHANGED';
  }
  return null;
}

export async function createImpactGroupSelection(db: DbExecutor, input: {
  workspaceId: string; groupId: string; commandId: string; candidateIds: readonly string[];
}) {
  if (input.candidateIds.length < 1 || input.candidateIds.length > 10 || new Set(input.candidateIds).size !== input.candidateIds.length) {
    throw invalidTransition('需要明确选择 1–10 个不同候选。');
  }
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'CreateImpactGroupSelection', target: { group_id: input.groupId },
    body: { candidate_ids: [...input.candidateIds] }, execute: async r => {
      const group = await r.impacts.readGroup(input.groupId);
      if (group?.workspace_id !== input.workspaceId) throw resourceNotFound('Impact candidate group');
      const source = await lockArtifactInWorkspace(r, input.workspaceId, group.source_artifact_id);
      if (source.revision !== group.source_artifact_revision || (await r.artifacts.listArtifactVersions(source.id)).at(-1)?.id !== group.source_after_version_id) {
        throw invalidTransition('来源已变化，请重新圈定候选组。');
      }
      const groupItems = await r.impacts.listGroupItems(group.id);
      const candidates = new Map<string, ArtifactImpactCandidateRow>();
      for (const item of groupItems) {
        const candidate = await r.impacts.findCandidateByTarget(group.impact_check_id, item.target_version_id);
        if (candidate !== undefined) candidates.set(item.target_version_id, candidate);
      }
      const selected = new Set(input.candidateIds);
      if (input.candidateIds.some(id => ![...candidates.values()].some(c => c.id === id))) throw invalidTransition('只能选择本组确切候选。');
      const dependencies = group.dependencies as unknown as ImpactGroupDependency[];
      const order = impactDependencyOrder(groupItems.map(i => i.target_version_id), dependencies);
      const items: SelectedItem[] = [];
      for (const targetId of order) {
        const candidate = candidates.get(targetId);
        if (candidate === undefined || !selected.has(candidate.id)) continue;
        const message = await r.assist.readMessage(candidate.assist_message_id);
        const target = await r.artifacts.readArtifact(candidate.target_artifact_id);
        if (message?.status !== 'COMPLETED' || parseImpactCandidateMarkdown(message.content) === null || candidate.applied_version_id !== null ||
            candidate.source_artifact_revision !== source.revision || target?.revision !== candidate.target_artifact_revision ||
            (await r.artifacts.listArtifactVersions(candidate.target_artifact_id)).at(-1)?.id !== candidate.target_version_id) {
          throw invalidTransition('所选候选未就绪、已应用或基线已变化。');
        }
        const parents: string[] = [];
        for (const d of dependencies.filter(d => d.target_version_id === targetId)) {
          const parent = candidates.get(d.depends_on_target_version_id);
          if (parent === undefined || !selected.has(parent.id) && await dependencyState(r, [parent.id]) !== null) {
            throw invalidTransition('选择缺少必要前置候选；请一并选择，或先应用仍有效的前置。');
          }
          parents.push(parent.id);
        }
        items.push({ candidate_id: candidate.id, target_artifact_id: candidate.target_artifact_id,
          target_version_id: candidate.target_version_id, expected_target_revision: candidate.target_artifact_revision.toString(), dependency_candidate_ids: parents });
      }
      const id = randomUUID(); await r.impacts.insertSelection(id, input.workspaceId, group.id, items);
      return { selection_id: id, group_id: group.id, item_count: String(items.length) };
    } });
}

/** 原成果 Owner 在统一任务/成果锁序前取范围，在持锁后核对前置实际结果。 */
export async function loadImpactSelectionBinding(r: Repositories, workspaceId: string,
  candidate: ArtifactImpactCandidateRow, selectionId?: string) {
  const requiredGroups = await r.impacts.dependencyGroups(candidate.impact_check_id, candidate.target_version_id);
  if (selectionId === undefined) {
    if (requiredGroups.length > 0) throw invalidTransition('此候选有组内前置，请先确认完整选择并携带 selection_id。');
    return [];
  }
  const selection = await r.impacts.readSelection(selectionId);
  if (selection?.workspace_id !== workspaceId) throw resourceNotFound('Impact group selection');
  const group = await r.impacts.readGroup(selection.group_id);
  const item = (selection.items as SelectedItem[]).find(i => i.candidate_id === candidate.id);
  if (group?.impact_check_id !== candidate.impact_check_id || item === undefined ||
      item.target_version_id !== candidate.target_version_id || requiredGroups.length > 0 && !requiredGroups.includes(group.id)) {
    throw invalidTransition('此候选不在确认选择的依赖范围内。');
  }
  const parents: ArtifactImpactCandidateRow[] = [];
  for (const id of item.dependency_candidate_ids) {
    const parent = await r.impacts.readCandidate(id);
    if (parent?.workspace_id !== workspaceId || parent.impact_check_id !== group.impact_check_id) throw invalidTransition('前置候选依据不可用。');
    parents.push(parent);
  }
  return parents;
}

export async function requireImpactDependenciesCurrent(r: Repositories, parents: readonly ArtifactImpactCandidateRow[]) {
  const reason = await dependencyState(r, parents.map(p => p.id));
  if (reason !== null) throw new DomainError({ code: reason, status: 409,
    type: '/problems/impact-prerequisite', title: '前置候选尚未满足',
    detail: '必要前置尚未应用，或应用版本已被后续修改替代。', retryable: false, retryAction: 'REFRESH_AND_REDECIDE' });
}

export async function readImpactGroupSelection(db: DbExecutor, workspaceId: string, selectionId: string) {
  const r = createRepositories(db), selection = await r.impacts.readSelection(selectionId);
  if (selection?.workspace_id !== workspaceId) throw resourceNotFound('Impact group selection');
  const items: JsonObject[] = [];
  for (const saved of selection.items as SelectedItem[]) {
    const view = await readArtifactImpactCandidate(db, workspaceId, saved.candidate_id);
    const current = (await r.artifacts.listArtifactVersions(saved.target_artifact_id)).at(-1);
    const appliedCurrent = view.applied_version_id !== null && current?.id === view.applied_version_id;
    const taskArtifact = await r.artifacts.readArtifact(saved.target_artifact_id);
    const task = taskArtifact === undefined ? undefined : await r.tasks.readTask(taskArtifact.task_id);
    const reason = view.applied_version_id !== null ? appliedCurrent ? 'ALREADY_APPLIED' : 'APPLIED_VERSION_CHANGED'
      : view.status !== 'COMPLETED' ? 'CANDIDATE_UNAVAILABLE' : view.stale ? 'SOURCE_OR_TARGET_CHANGED'
      : task?.status !== 'IN_PROGRESS' || task.executor_kind !== 'HUMAN' ? 'TASK_NOT_EDITABLE'
      : await dependencyState(r, saved.dependency_candidate_ids);
    items.push({ ...saved, candidate_status: view.status, applied_version_id: view.applied_version_id,
      applied_is_current: appliedCurrent, can_apply: reason === null, reason });
  }
  return { id: selection.id, group_id: selection.group_id, created_at: selection.created_at.toISOString(),
    items, applied_count: items.filter(i => i.applied_version_id !== null).length, overall_result: 'NONE' as const };
}
