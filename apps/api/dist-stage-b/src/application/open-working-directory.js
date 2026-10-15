import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { INITIAL_PHASE_BY_PROJECT_TYPE } from '../project/project-phase.js';
import { toDecimalString } from '../shared/decimal.js';
import { defaultViewKind } from '../view/builtin-view.js';
import { LOCAL_ACTOR_REF, httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand } from './command.js';
import { invalidTransition, resourceNotFound, validationFailed } from './domain-error.js';
import { canonicalResourceIdentity, registrationFileWriteRootId, rootsOverlap } from './gateway-configuration.js';
import { lockWritableProjectInWorkspace, requireWorkspace } from './guards.js';
import { createRepositories } from './unit-of-work.js';
async function authorityWrite(repositories, workspaceId) {
    if (await repositories.workspaces.lockAuthority(workspaceId, 'update') === undefined) {
        throw resourceNotFound('Workspace authority');
    }
}
function candidateOf(project, resource) {
    return { project_id: project.id, project_title: project.title,
        project_archived: project.archived_at !== null,
        resource_id: resource.id, resource_status: resource.status,
        file_write_identity_bound: resource.file_write_root_id !== null };
}
/** 只读投影：现有配置能支持到哪一步，不创建连接、不放宽权限。 */
async function writeReadiness(repositories, workspaceId, association, canonicalRoot) {
    if (association.project_archived) {
        return { status: 'RESOURCE_DISABLED', detail: '项目已归档，其目录不提供执行准入。' };
    }
    if (association.resource_status !== 'ACTIVE') {
        return { status: 'RESOURCE_DISABLED', detail: '受管目录已停用，需要在受管资源中恢复后才能执行。' };
    }
    if (!association.file_write_identity_bound) {
        return { status: 'RESOURCE_IDENTITY_UNBOUND', detail: '该目录尚未绑定 Windows 写身份，只能对话，不能写入文件。' };
    }
    const occupied = await repositories.gateway.listOccupiedResources();
    if (occupied.some((row) => rootsOverlap(row.identity_key, canonicalRoot))) {
        return { status: 'RESOURCE_BUSY', detail: '该实际工作目录正被其他动作占用或隔离。' };
    }
    const connections = await repositories.gateway.listConnections(workspaceId, association.project_id);
    const writeConnections = (await Promise.all(connections
        .filter((row) => row.status === 'ACTIVE')
        .map(async (row) => ({ row, capabilities: await repositories.gateway.listConnectionCapabilities(row.id) }))))
        .filter((entry) => entry.capabilities.includes('FILE_WRITE'));
    if (writeConnections.length === 0) {
        return { status: 'NEEDS_CONNECTION', detail: '本项目还没有绑定该目录的文件写入连接。' };
    }
    const grants = await Promise.all(writeConnections.map(() => repositories.gateway.listActivePolicies(workspaceId, association.project_id, 'FILE_WRITE', 'APPLY_CHANGESET')));
    if (!grants.some((rows) => rows.length > 0)) {
        return { status: 'NEEDS_PERMISSION', detail: '还没有生效的文件写入权限条目；执行时仍会单独请求动作批准。' };
    }
    return { status: 'READY', detail: '已具备受控文件修改的连接与权限；具体动作仍需逐次批准。' };
}
export async function openWorkingDirectory(db, input) {
    const scopeKey = httpCommandScopeKey(input.workspaceId);
    // 已提交回执必须重放，即使目录此后被移动或删除；原生核对只在首次请求时发生。
    const prior = await createRepositories(db).receipts.findReceipt({ scopeKey, commandId: input.commandId });
    let prepared;
    if (prior === undefined) {
        let root;
        try {
            root = await realpath(input.rootPath);
        }
        catch (error) {
            if (['ENOENT', 'ENOTDIR'].includes(error.code ?? '')) {
                throw validationFailed([{ field: 'root_path', message: 'must be an existing directory' }]);
            }
            throw error;
        }
        if (!(await stat(root)).isDirectory()) {
            throw validationFailed([{ field: 'root_path', message: 'must be an existing directory' }]);
        }
        prepared = { root, fileWriteRootId: await registrationFileWriteRootId(root) };
    }
    return runIdempotentCommand(db, {
        scopeKey, commandId: input.commandId, commandType: 'OpenWorkingDirectory',
        target: { workspace_id: input.workspaceId },
        body: { root_path: input.rootPath, project_id: input.projectId ?? null },
        execute: async (repositories) => {
            if (prepared === undefined)
                throw new Error('Working directory receipt disappeared during replay');
            const { root, fileWriteRootId } = prepared;
            const key = canonicalResourceIdentity(root);
            await authorityWrite(repositories, input.workspaceId);
            await requireWorkspace(repositories, input.workspaceId);
            await repositories.gateway.lockResourceRegistry();
            const all = await repositories.gateway.listResources();
            const sameIdentity = all.filter((row) => row.workspace_id === input.workspaceId &&
                row.identity_key === key && row.status === 'ACTIVE');
            const disabled = all.filter((row) => row.workspace_id === input.workspaceId &&
                row.identity_key === key && row.status !== 'ACTIVE');
            // 嵌套根不因为不同 identity_key 而成为第二个写 Owner；重叠只如实报告，不静默改作用域。
            const overlapping = all.filter((row) => row.workspace_id === input.workspaceId &&
                row.status === 'ACTIVE' && rootsOverlap(row.canonical_root, root));
            const projectOf = async (resource) => {
                const project = await repositories.projects.readProject(resource.project_id);
                if (project === undefined || project.workspace_id !== input.workspaceId) {
                    throw resourceNotFound('Project');
                }
                return project;
            };
            const finish = async (resource, createdProject, createdResource, candidates, status, reason) => {
                const project = await projectOf(resource);
                const association = candidateOf(project, resource);
                return { canonical_root: resource.canonical_root, display_name: basename(root) || root,
                    status, reason, association,
                    created_project: createdProject, created_resource: createdResource,
                    candidates,
                    write_readiness: await writeReadiness(repositories, input.workspaceId, association, resource.canonical_root) };
            };
            if (input.projectId !== undefined && input.projectId !== null) {
                const chosen = [...sameIdentity, ...disabled].find((row) => row.project_id === input.projectId);
                if (chosen !== undefined && chosen.status !== 'ACTIVE') {
                    // 停用过的同一目录不靠重新打开获得写准入，也不换新资源 ID 绕过停用。
                    return finish(chosen, false, false, [], 'NOT_READY', 'RESOURCE_DISABLED');
                }
                if (chosen !== undefined) {
                    const project = await projectOf(chosen);
                    if (project.archived_at !== null) {
                        return finish(chosen, false, false, [], 'NOT_READY', 'PROJECT_ARCHIVED');
                    }
                    const siblings = overlapping.filter((row) => row.id !== chosen.id);
                    return finish(chosen, false, false, siblings.length === 0 ? [] :
                        await Promise.all(siblings.map(async (row) => candidateOf(await projectOf(row), row))), 'READY', null);
                }
                // 显式选定作用域但该目录尚未登记：在选定项目内建立关联，不另开项目。
                if (input.projectId === '')
                    throw validationFailed([{ field: 'project_id', message: 'must be a uuid' }]);
                const project = await repositories.projects.readProject(input.projectId);
                if (project === undefined || project.workspace_id !== input.workspaceId) {
                    throw resourceNotFound('Project');
                }
                if (project.archived_at !== null) {
                    const placeholder = all.find((row) => row.project_id === input.projectId);
                    if (placeholder === undefined)
                        throw invalidTransition('所选项目已归档。');
                    return finish(placeholder, false, false, [], 'NOT_READY', 'PROJECT_ARCHIVED');
                }
            }
            if (sameIdentity.length > 1) {
                const candidates = await Promise.all(sameIdentity.map(async (row) => candidateOf(await projectOf(row), row)));
                return { canonical_root: root, display_name: basename(root) || root, status: 'AMBIGUOUS',
                    reason: 'MULTIPLE_PROJECTS', association: null, created_project: false, created_resource: false,
                    candidates,
                    write_readiness: { status: 'NEEDS_PERMISSION',
                        detail: '同一实际目录关联了多个项目；先选定作用域再继续。' } };
            }
            if (sameIdentity.length === 1) {
                const existing = sameIdentity[0];
                const project = await projectOf(existing);
                if (project.archived_at !== null) {
                    return finish(existing, false, false, [], 'NOT_READY', 'PROJECT_ARCHIVED');
                }
                const candidates = overlapping.filter((row) => row.id !== existing.id);
                return finish(existing, false, false, candidates.length === 0 ? [] :
                    await Promise.all(candidates.map(async (row) => candidateOf(await projectOf(row), row))), 'READY', null);
            }
            if (disabled.length > 0) {
                // 停用过的同一目录不靠重新打开获得写准入，也不换新资源 ID 绕过停用。
                return finish(disabled[0], false, false, [], 'NOT_READY', 'RESOURCE_DISABLED');
            }
            let projectId;
            let createdProject = false;
            if (input.projectId === undefined || input.projectId === null) {
                // 已有重叠受管根时不新开项目：那会让同一片实际目录出现第二个写 Owner。
                // 改为列出既有作用域，由用户显式选定；选定后同一项目内仍可登记子根。
                if (overlapping.length > 0) {
                    const candidates = await Promise.all(overlapping.map(async (row) => candidateOf(await projectOf(row), row)));
                    return { canonical_root: root, display_name: basename(root) || root, status: 'NOT_READY',
                        reason: 'OVERLAPPING_OTHER_PROJECT', association: candidates[0] ?? null,
                        created_project: false, created_resource: false, candidates,
                        write_readiness: { status: 'RESOURCE_BUSY',
                            detail: '这个目录落在另一个已受管根之内或包含它；先选定作用域，不会另建第二个写 Owner。' } };
                }
                const projectId0 = randomUUID();
                const project = await repositories.projects.insertProject({ id: projectId0,
                    workspaceId: input.workspaceId, title: basename(root) || root, projectType: 'GENERAL' });
                await repositories.projects.insertProjectState(project.id, INITIAL_PHASE_BY_PROJECT_TYPE.GENERAL);
                await repositories.views.insertDefault(project.id, input.workspaceId, defaultViewKind('GENERAL'));
                await repositories.activities.insertActivityRecord({ id: randomUUID(), workspaceId: input.workspaceId,
                    actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF, commandId: input.commandId,
                    projectId: project.id, taskId: null, eventType: 'PROJECT_CREATED',
                    factRefs: { project_id: project.id, project_type: project.project_type,
                        source: 'WORKING_DIRECTORY', root_path: root } });
                projectId = project.id;
                createdProject = true;
            }
            else {
                projectId = input.projectId;
                await lockWritableProjectInWorkspace(repositories, input.workspaceId, projectId);
            }
            const resource = await repositories.gateway.insertResource({ id: randomUUID(),
                workspaceId: input.workspaceId, projectId, canonicalRoot: root,
                identityKey: key, fileWriteRootId });
            await repositories.workspaces.bumpAuthority(input.workspaceId);
            const siblings = overlapping.filter((row) => row.project_id === projectId);
            return finish(resource, createdProject, true, siblings.length === 0 ? [] :
                await Promise.all(siblings.map(async (row) => candidateOf(await projectOf(row), row))), 'READY', null);
        }
    });
}
