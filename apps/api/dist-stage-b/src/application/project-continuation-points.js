import { randomUUID } from 'node:crypto';
import { toDecimalString } from '../shared/decimal.js';
import { LOCAL_ACTOR_REF, httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand } from './command.js';
import { projectArchived, resourceNotFound, validationFailed } from './domain-error.js';
import { readProjectInWorkspace } from './guards.js';
import { createRepositories } from './unit-of-work.js';
/**
 * N01 项目接续点：Project 拥有接续点身份与说明，其他对象只保存捕获时的确切版本引用。
 *
 * 首片只做保存、查看与比较。捕获不停止活动 Run，打开项目也不重设基线；
 * 比较只给事实差异，解读留空，不在这里生成第二套 Project State。
 */
const MAX_REFS = 200;
const MAX_LIST = 50;
const OPEN_TASK_STATUSES = ['INBOX', 'READY', 'IN_PROGRESS', 'WAITING', 'BLOCKED'];
const TERMINAL_TASK_STATUSES = ['DONE', 'CANCELLED'];
function validateInput(name, note) {
    const failures = [];
    if (name.trim() === '' || name.trim().length > 120) {
        failures.push({ field: 'name', message: '接续点名称需为 1–120 个字符' });
    }
    if (note !== null && (note.trim() === '' || note.length > 2000)) {
        failures.push({ field: 'note', message: '接续说明需为 1–2000 个字符，或不填' });
    }
    if (failures.length > 0)
        throw validationFailed(failures);
}
async function currentFacts(r, projectId) {
    const state = await r.projects.readProjectState(projectId);
    if (state === undefined)
        throw resourceNotFound('Project state');
    return {
        state,
        tasks: await r.tasks.listProjectTasksByStatus(projectId, OPEN_TASK_STATUSES),
        artifactRefs: await r.projects.listProjectStateArtifactRefs(projectId),
    };
}
function summaryDto(row, refCount) {
    return {
        id: row.id, project_id: row.project_id, name: row.name, note: row.note,
        captured_at: row.captured_at.toISOString(),
        captured_state: { phase_key: row.state_phase_key,
            revision: toDecimalString(row.state_revision),
            next_action_task_id: row.next_action_task_id },
        ref_count: refCount,
    };
}
const refDto = (ref) => ({
    ref_kind: ref.ref_kind, ref_id: ref.ref_id,
    captured_revision: toDecimalString(ref.ref_revision),
});
export async function captureProjectContinuationPoint(db, input) {
    validateInput(input.name, input.note);
    return runIdempotentCommand(db, {
        scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId,
        commandType: 'CreateProjectContinuationPoint',
        target: { project_id: input.projectId },
        body: { name: input.name.trim(), note: input.note },
        execute: async (r) => {
            // 捕获要排除并发 Task 插入，否则未决集合会漏项；FOR UPDATE 同时挡住进行中的归档。
            const project = await r.projects.lockProjectExclusive(input.projectId);
            if (project === undefined || project.workspace_id !== input.workspaceId) {
                throw resourceNotFound('Project');
            }
            if (project.archived_at !== null)
                throw projectArchived();
            const { state, tasks, artifactRefs } = await currentFacts(r, project.id);
            const refs = [
                ...tasks.map((task, ordinal) => ({ refKind: 'TASK', refId: task.id,
                    refRevision: task.revision, ordinal })),
                ...artifactRefs.map((ref, index) => ({ refKind: 'ARTIFACT_VERSION',
                    refId: ref.artifact_version_id, refRevision: ref.version_number,
                    ordinal: tasks.length + index })),
            ];
            if (refs.length > MAX_REFS) {
                throw validationFailed([{ field: 'project',
                        message: `未决事项与选用成果共 ${refs.length} 项，超过单点 ${MAX_REFS} 项上限` }]);
            }
            const point = await r.continuationPoints.insert({
                id: randomUUID(), workspaceId: input.workspaceId, projectId: project.id,
                name: input.name.trim(), note: input.note,
                statePhaseKey: state.phase_key, stateRevision: state.revision,
                nextActionTaskId: state.next_action_task_id,
            });
            for (const ref of refs) {
                await r.continuationPoints.insertRef({ continuationPointId: point.id,
                    refKind: ref.refKind, refId: ref.refId, refRevision: ref.refRevision,
                    ordinal: ref.ordinal });
            }
            await r.activities.insertActivityRecord({ id: randomUUID(),
                workspaceId: input.workspaceId, actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF,
                commandId: input.commandId, projectId: project.id, taskId: null,
                eventType: 'PROJECT_CONTINUATION_POINT_CAPTURED', factRefs: {
                    continuation_point_id: point.id, state_revision: toDecimalString(state.revision),
                    ref_count: refs.length,
                } });
            return { ...summaryDto(point, refs.length), refs: refs.map((ref) => ({
                    ref_kind: ref.refKind, ref_id: ref.refId, captured_revision: toDecimalString(ref.refRevision),
                })) };
        },
    });
}
export async function listProjectContinuationPoints(db, input) {
    const r = createRepositories(db);
    await readProjectInWorkspace(r, input.workspaceId, input.projectId);
    const rows = await r.continuationPoints.listByProject(input.workspaceId, input.projectId, MAX_LIST);
    const counts = await Promise.all(rows.map(async (row) => (await r.continuationPoints.listRefs(row.id)).length));
    return rows.map((row, index) => summaryDto(row, counts[index]));
}
async function readPointRow(r, input) {
    await readProjectInWorkspace(r, input.workspaceId, input.projectId);
    const row = await r.continuationPoints.read(input.continuationPointId);
    if (row === undefined || row.workspace_id !== input.workspaceId ||
        row.project_id !== input.projectId) {
        throw resourceNotFound('Continuation point');
    }
    return row;
}
export async function readProjectContinuationPoint(db, input) {
    const r = createRepositories(db);
    const row = await readPointRow(r, input);
    const refs = await r.continuationPoints.listRefs(row.id);
    return { ...summaryDto(row, refs.length), refs: refs.map(refDto) };
}
async function resolveRefChanges(r, projectId, refs) {
    return Promise.all(refs.map(async (ref) => {
        const base = refDto(ref);
        if (ref.ref_kind === 'TASK') {
            const task = await r.tasks.readTask(ref.ref_id);
            // 跨项目引用在捕获路径上不可能产生，但读取按当前作用域复核，不假设库里一定干净。
            if (task === undefined || task.project_id !== projectId) {
                return { ...base, change: 'MISSING', current_revision: null,
                    note: '捕获时的任务在本项目当前不可见' };
            }
            const change = TERMINAL_TASK_STATUSES.includes(task.status)
                ? 'CLOSED'
                : task.revision !== ref.ref_revision ? 'REVISED' : 'UNCHANGED';
            return { ...base, change, current_revision: toDecimalString(task.revision),
                note: `当前状态 ${task.status}` };
        }
        const version = await r.artifacts.readArtifactVersion(ref.ref_id);
        const artifact = version === undefined ? undefined :
            await r.artifacts.readArtifact(version.artifact_id);
        if (version === undefined || artifact?.project_id !== projectId) {
            return { ...base, change: 'MISSING', current_revision: null,
                note: '捕获时的成果版本在本项目当前不可见' };
        }
        const versions = await r.artifacts.listArtifactVersions(version.artifact_id);
        const latest = versions.reduce((max, item) => (item.version_number > max ? item.version_number : max), version.version_number);
        return { ...base,
            change: latest > version.version_number ? 'SUPERSEDED' : 'CURRENT',
            current_revision: toDecimalString(version.version_number),
            note: latest > version.version_number ? `该成果已有更新版本 v${latest}` : null };
    }));
}
export async function compareProjectToContinuationPoint(db, input) {
    const r = createRepositories(db);
    const row = await readPointRow(r, input);
    const refs = await r.continuationPoints.listRefs(row.id);
    const { state, tasks, artifactRefs } = await currentFacts(r, input.projectId);
    const refChanges = await resolveRefChanges(r, input.projectId, refs);
    const capturedTaskIds = new Set(refs.filter((ref) => ref.ref_kind === 'TASK')
        .map((ref) => ref.ref_id));
    const capturedVersionIds = new Set(refs.filter((ref) => ref.ref_kind === 'ARTIFACT_VERSION')
        .map((ref) => ref.ref_id));
    return {
        continuation_point: summaryDto(row, refs.length),
        current_state: { phase_key: state.phase_key, revision: toDecimalString(state.revision),
            next_action_task_id: state.next_action_task_id },
        facts: {
            state_revision_changed: state.revision !== row.state_revision,
            phase_changed: state.phase_key !== row.state_phase_key,
            next_action_changed: state.next_action_task_id !== row.next_action_task_id,
            task_added: tasks.filter((task) => !capturedTaskIds.has(task.id))
                .map((task) => ({ task_id: task.id, title: task.title, status: task.status })),
            artifact_version_added: artifactRefs
                .filter((ref) => !capturedVersionIds.has(ref.artifact_version_id))
                .map((ref) => ({ artifact_version_id: ref.artifact_version_id,
                artifact_id: ref.artifact_id, version_number: toDecimalString(ref.version_number) })),
        },
        ref_changes: refChanges,
        interpretation: null,
    };
}
