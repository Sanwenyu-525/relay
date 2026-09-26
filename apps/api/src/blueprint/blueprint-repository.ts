import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type { ProjectBlueprintProposalRow } from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';

export class BlueprintRepository {
  constructor(private readonly db: DbExecutor) {}

  async insert(input: { id: string; workspaceId: string; projectId: string;
    origin: 'USER_DRAFT' | 'SKILL'; skillMessageId?: string | null;
    supersedesProposalId?: string | null; candidate: JsonObject;
    baseline: JsonObject; source: JsonObject; candidateSha256: string }):
    Promise<ProjectBlueprintProposalRow> {
    return (await sql<ProjectBlueprintProposalRow>`
      insert into project_blueprint_proposals (id, workspace_id, project_id,
        origin, skill_message_id, supersedes_proposal_id, candidate, baseline,
        source, candidate_sha256)
      values (${input.id}, ${input.workspaceId}, ${input.projectId}, ${input.origin},
        ${input.skillMessageId ?? null}, ${input.supersedesProposalId ?? null},
        ${JSON.stringify(input.candidate)}::jsonb,
        ${JSON.stringify(input.baseline)}::jsonb,
        ${JSON.stringify(input.source)}::jsonb, ${input.candidateSha256})
      returning *`.execute(this.db)).rows[0]!;
  }

  async read(id: string, lock = false): Promise<ProjectBlueprintProposalRow | undefined> {
    return (await sql<ProjectBlueprintProposalRow>`
      select * from project_blueprint_proposals where id = ${id}
      ${lock ? sql`for update` : sql``}`.execute(this.db)).rows[0];
  }

  async list(workspaceId: string, projectId: string):
    Promise<readonly ProjectBlueprintProposalRow[]> {
    return (await sql<ProjectBlueprintProposalRow>`
      select * from project_blueprint_proposals
      where workspace_id = ${workspaceId} and project_id = ${projectId}
      order by created_at desc, id desc limit 30`.execute(this.db)).rows;
  }

  async settle(id: string, expectedStatus: ProjectBlueprintProposalRow['status'],
    status: ProjectBlueprintProposalRow['status'], decision: JsonObject):
    Promise<ProjectBlueprintProposalRow | undefined> {
    return (await sql<ProjectBlueprintProposalRow>`
      update project_blueprint_proposals set status = ${status},
        decision = ${JSON.stringify(decision)}::jsonb,
        decided_at = now(), updated_at = now()
      where id = ${id} and status = ${expectedStatus}
      returning *`.execute(this.db)).rows[0];
  }
}
