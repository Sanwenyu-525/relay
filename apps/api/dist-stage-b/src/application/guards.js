import { projectArchived, resourceNotFound } from './domain-error.js';
import { createRepositories } from './unit-of-work.js';
/**
 * 作用域守卫：所有读写都以路径中的 Workspace 为范围，跨作用域 ID 按不可见处理（404），
 * 不返回“存在但无权限”，避免泄漏其他作用域的对象存在性。
 */
export async function requireWorkspace(repositories, workspaceId) {
    const workspace = await repositories.workspaces.readWorkspace(workspaceId);
    if (workspace === undefined) {
        throw resourceNotFound('Workspace');
    }
    return workspace;
}
/** 读取端点也用同一可见性规则：不可见的 Workspace 返回 404，不返回空结果掩盖作用域错误。 */
export async function requireWorkspaceVisible(db, workspaceId) {
    await requireWorkspace(createRepositories(db), workspaceId);
}
export async function readProjectInWorkspace(repositories, workspaceId, projectId) {
    const project = await repositories.projects.readProject(projectId);
    if (project === undefined || project.workspace_id !== workspaceId) {
        throw resourceNotFound('Project');
    }
    return project;
}
/** 写事务持有至提交的 Project 归档栅栏；历史读取继续使用 readProjectInWorkspace。 */
export async function lockWritableProjectInWorkspace(repositories, workspaceId, projectId) {
    const project = await repositories.projects.lockProjectArchiveGate(projectId);
    if (project === undefined || project.workspace_id !== workspaceId) {
        throw resourceNotFound('Project');
    }
    if (project.archived_at !== null)
        throw projectArchived();
    return project;
}
/** 同时取的 Project 行锁（FOR NO KEY UPDATE）：Goal 关联与 Task 显式对齐共用同一串行化点。 */
export async function lockProjectInWorkspace(repositories, workspaceId, projectId) {
    const project = await repositories.projects.lockProject(projectId);
    if (project === undefined || project.workspace_id !== workspaceId) {
        throw resourceNotFound('Project');
    }
    if (project.archived_at !== null)
        throw projectArchived();
    return project;
}
export async function readTaskInWorkspace(repositories, workspaceId, taskId) {
    const task = await repositories.tasks.readTask(taskId);
    if (task === undefined || task.workspace_id !== workspaceId) {
        throw resourceNotFound('Task');
    }
    return task;
}
/** Task 行锁（FOR UPDATE）：状态迁移与属于 Task 的可变事实都通过它串行化。 */
export async function lockTaskInWorkspace(repositories, workspaceId, taskId) {
    const task = await repositories.tasks.lockTask(taskId);
    if (task === undefined || task.workspace_id !== workspaceId) {
        throw resourceNotFound('Task');
    }
    if (task.project_id !== null) {
        await lockWritableProjectInWorkspace(repositories, workspaceId, task.project_id);
    }
    return task;
}
export async function readArtifactInWorkspace(repositories, workspaceId, artifactId) {
    const artifact = await repositories.artifacts.readArtifact(artifactId);
    if (artifact === undefined || artifact.workspace_id !== workspaceId) {
        throw resourceNotFound('Artifact');
    }
    return artifact;
}
/** Artifact 行锁：分配新版本序号与递增 artifact revision 的串行化点。 */
export async function lockArtifactInWorkspace(repositories, workspaceId, artifactId) {
    const artifact = await repositories.artifacts.lockArtifact(artifactId);
    if (artifact === undefined || artifact.workspace_id !== workspaceId) {
        throw resourceNotFound('Artifact');
    }
    return artifact;
}
/** 版本内容的可见性：先解析版本 → 所属 Artifact → Workspace，跨作用域按不可见处理。 */
export async function readArtifactVersionInWorkspace(repositories, workspaceId, versionId) {
    const version = await repositories.artifacts.readArtifactVersion(versionId);
    if (version === undefined) {
        throw resourceNotFound('Artifact version');
    }
    const artifact = await readArtifactInWorkspace(repositories, workspaceId, version.artifact_id);
    return { version, artifact };
}
