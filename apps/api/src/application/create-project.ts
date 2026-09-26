import { randomUUID } from 'node:crypto';

import type { ProjectType } from '../infrastructure/database-schema.js';
import type { DbExecutor } from '../infrastructure/database.js';
import { INITIAL_PHASE_BY_PROJECT_TYPE } from '../project/project-phase.js';
import { toDecimalString } from '../shared/decimal.js';
import { checkRequiredText } from '../shared/text.js';
import { defaultViewKind } from '../view/builtin-view.js';
import { LOCAL_ACTOR_REF, httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand, type CommandOutcome } from './command.js';
import { validationFailed } from './domain-error.js';
import { requireWorkspace } from './guards.js';

export interface CreateProjectInput {
  readonly workspaceId: string;
  readonly commandId: string;
  readonly title: string;
  readonly projectType: ProjectType;
}

/** 用 type 别名（而非 interface）声明：命令结果必须是可赋给 JsonObject 的开放结构。 */
export type CreateProjectResult = {
  readonly project_id: string;
  readonly revision: string;
  readonly phase_key: string;
  readonly state_revision: string;
};

/**
 * CreateProject：同一事务建立 Project、它的 ProjectState 与审计记录，并保存命令回执。
 *
 * 物理设计第 4 节要求 Workspace 存在 authority 行才可继续准入，这里先确认 Workspace 存在；
 * Project State 与 Project 必须同时创建，否则组合视图会缺少锁定点。
 */
export async function createProject(
  db: DbExecutor,
  input: CreateProjectInput,
): Promise<CommandOutcome<CreateProjectResult>> {
  const titleProblem = checkRequiredText(input.title, 'title', 'title');

  if (titleProblem !== undefined) {
    throw validationFailed([titleProblem]);
  }

  const title = input.title.trim();

  return runIdempotentCommand<CreateProjectResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'CreateProject',
    target: { workspace_id: input.workspaceId },
    body: { title, project_type: input.projectType },
    execute: async (repositories) => {
      await requireWorkspace(repositories, input.workspaceId);

      const projectId = randomUUID();

      const project = await repositories.projects.insertProject({
        id: projectId,
        workspaceId: input.workspaceId,
        title,
        projectType: input.projectType,
      });

      const state = await repositories.projects.insertProjectState(
        project.id,
        INITIAL_PHASE_BY_PROJECT_TYPE[input.projectType],
      );
      await repositories.views.insertDefault(project.id, input.workspaceId,
        defaultViewKind(input.projectType));

      await repositories.activities.insertActivityRecord({
        id: randomUUID(),
        workspaceId: input.workspaceId,
        actorKind: 'HUMAN',
        actorRef: LOCAL_ACTOR_REF,
        commandId: input.commandId,
        projectId: project.id,
        taskId: null,
        eventType: 'PROJECT_CREATED',
        factRefs: {
          project_id: project.id,
          project_type: project.project_type,
          phase_key: state.phase_key,
        },
      });

      return {
        project_id: project.id,
        revision: toDecimalString(project.revision),
        phase_key: state.phase_key,
        state_revision: toDecimalString(state.revision),
      };
    },
  });
}
