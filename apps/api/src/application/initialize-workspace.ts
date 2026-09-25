import { randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import { toDecimalString } from '../shared/decimal.js';
import { runIdempotentCommand, type CommandOutcome } from './command.js';

export interface InitializeWorkspaceInput {
  /** 应用预分配 Workspace ID（不使用有业务含义的路径作主键）。 */
  readonly workspaceId: string;
  readonly name: string;
  readonly commandId: string;
  /** 发起者标识（本机 CLI / 桌面启动方），不是权限结果。 */
  readonly actorRef: string;
}

export type InitializeWorkspaceResult = {
  readonly workspace_id: string;
  readonly workspace_revision: string;
  readonly authority_revision: string;
};

/**
 * 初始化 Workspace：同一事务建立 workspaces、workspace_execution_authority、审计记录与命令回执。
 *
 * 物理设计第 4 节要求存在 Workspace 级执行权威行，缺行时不得继续准入；这里保证它随 Workspace 一起建立，
 * 不需要手工改库。相同 command_id 重放返回原结果，不会重复创建 Workspace。
 */
export async function initializeWorkspace(
  db: DbExecutor,
  input: InitializeWorkspaceInput,
): Promise<CommandOutcome<InitializeWorkspaceResult>> {
  return runIdempotentCommand<InitializeWorkspaceResult>(db, {
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