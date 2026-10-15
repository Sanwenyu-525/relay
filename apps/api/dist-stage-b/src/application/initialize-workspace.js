import { randomUUID } from 'node:crypto';
import { toDecimalString } from '../shared/decimal.js';
import { runIdempotentCommand } from './command.js';
/**
 * 初始化 Workspace：同一事务建立 workspaces、workspace_execution_authority、审计记录与命令回执。
 *
 * 物理设计第 4 节要求存在 Workspace 级执行权威行，缺行时不得继续准入；这里保证它随 Workspace 一起建立，
 * 不需要手工改库。相同 command_id 重放返回原结果，不会重复创建 Workspace。
 */
export async function initializeWorkspace(db, input) {
    return runIdempotentCommand(db, {
        scopeKey: `workspace:${input.workspaceId}`,
        commandId: input.commandId,
        commandType: 'InitializeWorkspace',
        target: { workspace_id: input.workspaceId },
        body: { name: input.name },
        execute: async (repositories) => {
            const workspace = await repositories.workspaces.insertWorkspace({
                id: input.workspaceId,
                name: input.name,
            });
            const authority = await repositories.workspaces.insertAuthorityRow(workspace.id);
            await repositories.activities.insertActivityRecord({
                id: randomUUID(),
                workspaceId: input.workspaceId,
                actorKind: 'HUMAN',
                actorRef: input.actorRef,
                commandId: input.commandId,
                projectId: null,
                taskId: null,
                eventType: 'WORKSPACE_INITIALIZED',
                factRefs: {
                    workspace_id: workspace.id,
                    authority_revision: toDecimalString(authority.revision),
                },
            });
            return {
                workspace_id: workspace.id,
                workspace_revision: toDecimalString(workspace.revision),
                authority_revision: toDecimalString(authority.revision),
            };
        },
    });
}
