import { sql } from 'kysely';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';

/**
 * 项目级长期 Agent 成员的两张表（ADR-034 包 A，迁移 0139）。
 *
 * 与 `scheduled_tasks` 同例：计划类表不进 `RelayDatabaseSchema`，用原生 SQL 自带
 * Row 接口。成员只是身份与配置；Task/Run、会话与执行权仍归原 Owner。
 */
export type AgentMemberStatus = 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
export type AgentMemberRunMode = 'BUILTIN' | 'EXTERNAL';

export interface AgentMemberRow {
  id: string;
  workspace_id: string;
  project_id: string;
  name: string;
  role_key: string;
  duties: string;
  status: AgentMemberStatus;
  run_mode: AgentMemberRunMode;
  model_selection: JsonObject;
  external_binding: JsonObject;
  revision: bigint;
  created_at: Date;
  updated_at: Date;
}

export interface AgentMemberInsert {
  readonly id: string;
  readonly workspace_id: string;
  readonly project_id: string;
  readonly name: string;
  readonly role_key: string;
  readonly duties: string;
  readonly run_mode: AgentMemberRunMode;
  readonly model_selection: JsonObject;
  readonly external_binding: JsonObject;
}

export interface AgentMemberUpdate {
  readonly name: string;
  readonly duties: string;
  readonly run_mode: AgentMemberRunMode;
  readonly model_selection: JsonObject;
  readonly external_binding: JsonObject;
}

export interface ProjectCoordinatorRow {
  project_id: string;
  workspace_id: string;
  member_id: string;
  revision: bigint;
  assigned_at: Date;
  command_id: string;
}

export class AgentMemberRepository {
  constructor(private readonly db: DbExecutor) {}

  async insert(row: AgentMemberInsert): Promise<AgentMemberRow> {
    return (await sql<AgentMemberRow>`insert into project_agent_members
      (id, workspace_id, project_id, name, role_key, duties, run_mode, model_selection, external_binding)
      values (${row.id}, ${row.workspace_id}, ${row.project_id}, ${row.name}, ${row.role_key},
        ${row.duties}, ${row.run_mode}, ${JSON.stringify(row.model_selection)}::jsonb,
        ${JSON.stringify(row.external_binding)}::jsonb)
      returning *`.execute(this.db)).rows[0]!;
  }

  async read(id: string, lock = false): Promise<AgentMemberRow | undefined> {
    return (await sql<AgentMemberRow>`select * from project_agent_members where id = ${id}
      ${lock ? sql`for update` : sql``}`.execute(this.db)).rows[0];
  }

  async list(workspaceId: string, projectId: string): Promise<AgentMemberRow[]> {
    return (await sql<AgentMemberRow>`select * from project_agent_members
      where workspace_id = ${workspaceId} and project_id = ${projectId}
      order by created_at, id`.execute(this.db)).rows;
  }

  async update(id: string, change: AgentMemberUpdate): Promise<AgentMemberRow> {
    return (await sql<AgentMemberRow>`update project_agent_members
      set name = ${change.name}, duties = ${change.duties}, run_mode = ${change.run_mode},
        model_selection = ${JSON.stringify(change.model_selection)}::jsonb,
        external_binding = ${JSON.stringify(change.external_binding)}::jsonb,
        revision = revision + 1, updated_at = now()
      where id = ${id} returning *`.execute(this.db)).rows[0]!;
  }

  async setStatus(id: string, status: AgentMemberStatus): Promise<AgentMemberRow> {
    return (await sql<AgentMemberRow>`update project_agent_members
      set status = ${status}, revision = revision + 1, updated_at = now()
      where id = ${id} returning *`.execute(this.db)).rows[0]!;
  }

  async readCoordinator(projectId: string, lock = false): Promise<ProjectCoordinatorRow | undefined> {
    return (await sql<ProjectCoordinatorRow>`select * from project_agent_coordinators
      where project_id = ${projectId} ${lock ? sql`for update` : sql``}`.execute(this.db)).rows[0];
  }

  /** 指派或更换协调者：一项目一行，无条件 upsert——指派命令就是协调者事实的唯一写方。 */
  async assignCoordinator(projectId: string, workspaceId: string, memberId: string, commandId: string): Promise<ProjectCoordinatorRow> {
    return (await sql<ProjectCoordinatorRow>`insert into project_agent_coordinators
      (project_id, workspace_id, member_id, command_id)
      values (${projectId}, ${workspaceId}, ${memberId}, ${commandId})
      on conflict (project_id) do update
        set member_id = ${memberId}, command_id = ${commandId},
            revision = project_agent_coordinators.revision + 1, assigned_at = now()
      returning *`.execute(this.db)).rows[0]!;
  }
}
