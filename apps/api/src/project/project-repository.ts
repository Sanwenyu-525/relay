import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type {
  GoalRow,
  GoalStatus,
  ProjectBlockerRow,
  ProjectBlockerTargetKind,
  ProjectGoalLinkRow,
  ProjectGoalRow,
  ProjectRiskRow,
  ProjectRow,
  ProjectStateRow,
  ProjectType,
  StateArtifactRefRow,
  StateCompletionRefRow,
} from '../infrastructure/database-schema.js';
import { requireRow } from '../shared/sql-rows.js';

export interface NewProject {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly projectType: ProjectType;
}

export interface NewGoal {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly description: string;
  readonly status: GoalStatus;
}

export interface NewProjectBlocker {
  readonly id: string;
  readonly projectId: string;
  readonly targetKind: ProjectBlockerTargetKind;
  readonly targetId: string;
  readonly reason: string;
  readonly sourceRef: string;
}

export interface NewProjectRisk {
  readonly id: string;
  readonly projectId: string;
  readonly statement: string;
  readonly sourceRef: string;
  readonly confirmationRef: string;
}

/** Project State 组合视图需要的完成依据引用（联表补出所属 Task 与验收版本）。 */
export interface StateCompletionRefViewRow {
  readonly project_id: string;
  readonly completion_id: string;
  readonly source_ref: string;
  readonly task_id: string;
  readonly acceptance_revision: bigint;
  readonly committed_at: Date;
}

/** Project State 组合视图需要的所选产物版本引用（联表补出版本号）。 */
export interface StateArtifactRefViewRow {
  readonly project_id: string;
  readonly artifact_version_id: string;
  readonly source_ref: string;
  readonly artifact_id: string;
  readonly version_number: bigint;
}

/**
 * Project Owner 的写入面：Project 自身、Project–Goal 关联、Project State 与类型化 State 引用、
 * blocker/risk。Task、Artifact、完成凭据的写入不在这里。
 */
export class ProjectRepository {
  private readonly db: DbExecutor;

  constructor(db: DbExecutor) {
    this.db = db;
  }

  async insertProject(project: NewProject): Promise<ProjectRow> {
    const result = await sql<ProjectRow>`
      insert into projects (id, workspace_id, title, project_type)
      values (${project.id}, ${project.workspaceId}, ${project.title}, ${project.projectType})
      returning id, workspace_id, title, project_type, archived_at, revision, created_at, updated_at
    `.execute(this.db);

    return requireRow(result.rows, 'insert into projects');
  }

  async readProject(projectId: string, lock = false): Promise<ProjectRow | undefined> {
    const result = await sql<ProjectRow>`
      select id, workspace_id, title, project_type, archived_at, revision, created_at, updated_at
      from projects
      where id = ${projectId} ${lock ? sql`for share` : sql``}
    `.execute(this.db);

    return result.rows[0];
  }

  async insertProjectState(projectId: string, phaseKey: string): Promise<ProjectStateRow> {
    const result = await sql<ProjectStateRow>`
      insert into project_states (project_id, phase_key)
      values (${projectId}, ${phaseKey})
      returning project_id, phase_key, next_action_task_id, revision, created_at, updated_at
    `.execute(this.db);

    return requireRow(result.rows, 'insert into project_states');
  }

  async readProjectState(projectId: string): Promise<ProjectStateRow | undefined> {
    const result = await sql<ProjectStateRow>`
      select project_id, phase_key, next_action_task_id, revision, created_at, updated_at
      from project_states
      where project_id = ${projectId}
    `.execute(this.db);

    return result.rows[0];
  }

  async insertGoal(goal: NewGoal): Promise<GoalRow> {
    const result = await sql<GoalRow>`
      insert into goals (id, workspace_id, title, description, status)
      values (${goal.id}, ${goal.workspaceId}, ${goal.title}, ${goal.description}, ${goal.status})
      returning id, workspace_id, title, description, status, revision, created_at, updated_at
    `.execute(this.db);

    return requireRow(result.rows, 'insert into goals');
  }

  async linkGoalToProject(input: {
    readonly workspaceId: string;
    readonly projectId: string;
    readonly goalId: string;
  }): Promise<ProjectGoalRow> {
    const result = await sql<ProjectGoalRow>`
      insert into project_goals (workspace_id, project_id, goal_id)
      values (${input.workspaceId}, ${input.projectId}, ${input.goalId})
      returning workspace_id, project_id, goal_id, created_at
    `.execute(this.db);

    return requireRow(result.rows, 'insert into project_goals');
  }

  async insertStateCompletionRef(input: {
    readonly projectId: string;
    readonly completionId: string;
    readonly sourceRef: string;
  }): Promise<StateCompletionRefRow> {
    const result = await sql<StateCompletionRefRow>`
      insert into state_completion_refs (project_id, completion_id, source_ref)
      values (${input.projectId}, ${input.completionId}, ${input.sourceRef})
      returning project_id, completion_id, source_ref, created_at
    `.execute(this.db);

    return requireRow(result.rows, 'insert into state_completion_refs');
  }

  async insertStateArtifactRef(input: {
    readonly projectId: string;
    readonly artifactVersionId: string;
    readonly sourceRef: string;
  }): Promise<StateArtifactRefRow> {
    const result = await sql<StateArtifactRefRow>`
      insert into state_artifact_refs (project_id, artifact_version_id, source_ref)
      values (${input.projectId}, ${input.artifactVersionId}, ${input.sourceRef})
      returning project_id, artifact_version_id, source_ref, created_at
    `.execute(this.db);

    return requireRow(result.rows, 'insert into state_artifact_refs');
  }

  async insertBlocker(blocker: NewProjectBlocker): Promise<ProjectBlockerRow> {
    const result = await sql<ProjectBlockerRow>`
      insert into project_blockers (id, project_id, target_kind, target_id, reason, source_ref)
      values (
        ${blocker.id}, ${blocker.projectId}, ${blocker.targetKind}, ${blocker.targetId},
        ${blocker.reason}, ${blocker.sourceRef}
      )
      returning id, project_id, target_kind, target_id, reason, source_ref, resolved_at, created_at
    `.execute(this.db);

    return requireRow(result.rows, 'insert into project_blockers');
  }

  async insertRisk(risk: NewProjectRisk): Promise<ProjectRiskRow> {
    const result = await sql<ProjectRiskRow>`
      insert into project_risks (id, project_id, statement, source_ref, confirmation_ref)
      values (
        ${risk.id}, ${risk.projectId}, ${risk.statement}, ${risk.sourceRef}, ${risk.confirmationRef}
      )
      returning id, project_id, statement, source_ref, confirmation_ref, resolved_at, created_at
    `.execute(this.db);

    return requireRow(result.rows, 'insert into project_risks');
  }

  /**
   * Goal 关联与 Task 显式对齐的串行化点。
   * 用 FOR NO KEY UPDATE（而不是 FOR UPDATE）：既让同类命令互斥，又不阻塞其他事务对同一 Project
   * 行加 KEY SHARE（例如创建 Task 时的复合外键检查）。
   */
  async lockProject(projectId: string): Promise<ProjectRow | undefined> {
    const result = await sql<ProjectRow>`
      select id, workspace_id, title, project_type, archived_at, revision, created_at, updated_at
      from projects
      where id = ${projectId}
      for no key update
    `.execute(this.db);

    return result.rows[0];
  }

  /** 关联 Goal 集合是 Project 的事实：变更时按 Project revision 做 CAS。 */
  async bumpProjectRevision(
    projectId: string,
    expectedRevision: bigint,
  ): Promise<ProjectRow | undefined> {
    const result = await sql<ProjectRow>`
      update projects
      set revision = revision + 1, updated_at = now()
      where id = ${projectId} and revision = ${expectedRevision}
      returning id, workspace_id, title, project_type, archived_at, revision, created_at, updated_at
    `.execute(this.db);

    return result.rows[0];
  }

  async readGoal(goalId: string): Promise<GoalRow | undefined> {
    const result = await sql<GoalRow>`
      select id, workspace_id, title, description, status, revision, created_at, updated_at
      from goals
      where id = ${goalId}
    `.execute(this.db);

    return result.rows[0];
  }

  async listProjectGoalLinks(projectId: string): Promise<readonly ProjectGoalLinkRow[]> {
    const result = await sql<ProjectGoalLinkRow>`
      select pg.project_id, pg.goal_id, g.title as goal_title, g.status as goal_status,
             g.revision as goal_revision, pg.created_at
      from project_goals pg
      join goals g on g.id = pg.goal_id
      where pg.project_id = ${projectId}
      order by pg.goal_id
    `.execute(this.db);

    return result.rows;
  }

  async findProjectGoalLink(
    projectId: string,
    goalId: string,
  ): Promise<ProjectGoalRow | undefined> {
    const result = await sql<ProjectGoalRow>`
      select workspace_id, project_id, goal_id, created_at
      from project_goals
      where project_id = ${projectId} and goal_id = ${goalId}
    `.execute(this.db);

    return result.rows[0];
  }

  async deleteProjectGoalLink(projectId: string, goalId: string): Promise<boolean> {
    const result = await sql`
      delete from project_goals
      where project_id = ${projectId} and goal_id = ${goalId}
    `.execute(this.db);

    return Number(result.numAffectedRows ?? 0n) > 0;
  }

  /** 解除关联前的影响清单：显式对齐该 Goal 的 Task 及其当前 revision。 */
  async listExplicitGoalTasksForGoal(
    projectId: string,
    goalId: string,
  ): Promise<readonly { readonly task_id: string; readonly revision: bigint }[]> {
    const result = await sql<{ task_id: string; revision: bigint }>`
      select teg.task_id, t.revision
      from task_explicit_goals teg
      join tasks t on t.id = teg.task_id
      where teg.project_id = ${projectId} and teg.goal_id = ${goalId}
      order by teg.task_id
    `.execute(this.db);

    return result.rows;
  }

  /** Project State 行锁：所有类型化 State 命令的串行化点（统一锁序中的 ProjectState）。 */
  async lockProjectState(projectId: string): Promise<ProjectStateRow | undefined> {
    const result = await sql<ProjectStateRow>`
      select project_id, phase_key, next_action_task_id, revision, created_at, updated_at
      from project_states
      where project_id = ${projectId}
      for update
    `.execute(this.db);

    return result.rows[0];
  }

  async bumpProjectStateRevision(
    projectId: string,
    expectedRevision: bigint,
  ): Promise<ProjectStateRow | undefined> {
    const result = await sql<ProjectStateRow>`
      update project_states
      set revision = revision + 1, updated_at = now()
      where project_id = ${projectId} and revision = ${expectedRevision}
      returning project_id, phase_key, next_action_task_id, revision, created_at, updated_at
    `.execute(this.db);

    return result.rows[0];
  }

  async setProjectStatePhase(
    projectId: string,
    expectedRevision: bigint,
    phaseKey: string,
  ): Promise<ProjectStateRow | undefined> {
    const result = await sql<ProjectStateRow>`
      update project_states
      set phase_key = ${phaseKey}, revision = revision + 1, updated_at = now()
      where project_id = ${projectId} and revision = ${expectedRevision}
      returning project_id, phase_key, next_action_task_id, revision, created_at, updated_at
    `.execute(this.db);

    return result.rows[0];
  }

  async setProjectStateNextAction(
    projectId: string,
    expectedRevision: bigint,
    nextActionTaskId: string | null,
  ): Promise<ProjectStateRow | undefined> {
    const result = await sql<ProjectStateRow>`
      update project_states
      set next_action_task_id = ${nextActionTaskId}, revision = revision + 1, updated_at = now()
      where project_id = ${projectId} and revision = ${expectedRevision}
      returning project_id, phase_key, next_action_task_id, revision, created_at, updated_at
    `.execute(this.db);

    return result.rows[0];
  }

  async findProjectStateArtifactRef(
    projectId: string,
    artifactVersionId: string,
  ): Promise<StateArtifactRefRow | undefined> {
    const result = await sql<StateArtifactRefRow>`
      select project_id, artifact_version_id, source_ref, created_at
      from state_artifact_refs
      where project_id = ${projectId} and artifact_version_id = ${artifactVersionId}
    `.execute(this.db);

    return result.rows[0];
  }

  async listProjectStateArtifactRefs(
    projectId: string,
  ): Promise<readonly StateArtifactRefViewRow[]> {
    const result = await sql<StateArtifactRefViewRow>`
      select sar.project_id, sar.artifact_version_id, sar.source_ref,
             av.artifact_id, av.version_number
      from state_artifact_refs sar
      join artifact_versions av on av.id = sar.artifact_version_id
      where sar.project_id = ${projectId}
      order by sar.artifact_version_id
    `.execute(this.db);

    return result.rows;
  }

  async listProjectStateCompletionRefs(
    projectId: string,
  ): Promise<readonly StateCompletionRefViewRow[]> {
    const result = await sql<StateCompletionRefViewRow>`
      select scr.project_id, scr.completion_id, scr.source_ref,
             cr.task_id, cr.acceptance_revision, cr.committed_at
      from state_completion_refs scr
      join completion_records cr on cr.id = scr.completion_id
      join tasks t
        on t.id = cr.task_id
        and t.project_id = scr.project_id
        and t.status = 'DONE'
        and t.acceptance_revision = cr.acceptance_revision
        and t.current_completion_id = scr.completion_id
      where scr.project_id = ${projectId}
      order by scr.completion_id
    `.execute(this.db);

    return result.rows;
  }

  async listProjectBlockers(projectId: string): Promise<readonly ProjectBlockerRow[]> {
    const result = await sql<ProjectBlockerRow>`
      select id, project_id, target_kind, target_id, reason, source_ref, resolved_at, created_at
      from project_blockers
      where project_id = ${projectId}
      order by created_at, id
    `.execute(this.db);

    return result.rows;
  }

  /**
   * 阻止某个 Task 开始的未解除 blocker：作用在 Project 上的 blocker，或作用在该 Task 上的 blocker。
   * 依据 contracts/01-facts-and-ownership.md 第 3 节与 information-planning 第 4 节的资格过滤。
   */
  async listUnresolvedBlockersForTask(
    projectId: string,
    taskId: string,
  ): Promise<readonly ProjectBlockerRow[]> {
    const result = await sql<ProjectBlockerRow>`
      select id, project_id, target_kind, target_id, reason, source_ref, resolved_at, created_at
      from project_blockers
      where project_id = ${projectId}
        and resolved_at is null
        and ((target_kind = 'TASK' and target_id = ${taskId})
             or (target_kind = 'PROJECT' and target_id = ${projectId}))
      order by created_at, id
    `.execute(this.db);

    return result.rows;
  }

  /** 一次取出多个 Task 的未解除 blocker，供列表投影批量计算可执行动作。 */
  async listUnresolvedBlockersForTasks(
    projectId: string,
    taskIds: readonly string[],
  ): Promise<readonly ProjectBlockerRow[]> {
    if (taskIds.length === 0) {
      return [];
    }

    const result = await sql<ProjectBlockerRow>`
      select id, project_id, target_kind, target_id, reason, source_ref, resolved_at, created_at
      from project_blockers
      where project_id = ${projectId}
        and resolved_at is null
        and ((target_kind = 'TASK' and target_id = any(${taskIds}::uuid[]))
             or (target_kind = 'PROJECT' and target_id = ${projectId}))
      order by created_at, id
    `.execute(this.db);

    return result.rows;
  }

  async readBlocker(blockerId: string): Promise<ProjectBlockerRow | undefined> {
    const result = await sql<ProjectBlockerRow>`
      select id, project_id, target_kind, target_id, reason, source_ref, resolved_at, created_at
      from project_blockers
      where id = ${blockerId}
    `.execute(this.db);

    return result.rows[0];
  }

  /** 只在未解除时写入解除时间，返回受影响行；已解除返回 undefined。 */
  async resolveBlocker(blockerId: string): Promise<ProjectBlockerRow | undefined> {
    const result = await sql<ProjectBlockerRow>`
      update project_blockers
      set resolved_at = now()
      where id = ${blockerId} and resolved_at is null
      returning id, project_id, target_kind, target_id, reason, source_ref, resolved_at, created_at
    `.execute(this.db);

    return result.rows[0];
  }

  async listProjectRisks(projectId: string): Promise<readonly ProjectRiskRow[]> {
    const result = await sql<ProjectRiskRow>`
      select id, project_id, statement, source_ref, confirmation_ref, resolved_at, created_at
      from project_risks
      where project_id = ${projectId}
      order by created_at, id
    `.execute(this.db);

    return result.rows;
  }
}
