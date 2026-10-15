import { sql } from 'kysely';
export class BlueprintRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async insert(input) {
        return (await sql `
      insert into project_blueprint_proposals (id, workspace_id, project_id,
        origin, skill_message_id, supersedes_proposal_id, candidate, baseline,
        source, candidate_sha256)
      values (${input.id}, ${input.workspaceId}, ${input.projectId}, ${input.origin},
        ${input.skillMessageId ?? null}, ${input.supersedesProposalId ?? null},
        ${JSON.stringify(input.candidate)}::jsonb,
        ${JSON.stringify(input.baseline)}::jsonb,
        ${JSON.stringify(input.source)}::jsonb, ${input.candidateSha256})
      returning *`.execute(this.db)).rows[0];
    }
    async read(id, lock = false) {
        return (await sql `
      select * from project_blueprint_proposals where id = ${id}
      ${lock ? sql `for update` : sql ``}`.execute(this.db)).rows[0];
    }
    async list(workspaceId, projectId) {
        return (await sql `
      select * from project_blueprint_proposals
      where workspace_id = ${workspaceId} and project_id = ${projectId}
      order by created_at desc, id desc limit 30`.execute(this.db)).rows;
    }
    async settle(id, expectedStatus, status, decision) {
        return (await sql `
      update project_blueprint_proposals set status = ${status},
        decision = ${JSON.stringify(decision)}::jsonb,
        decided_at = now(), updated_at = now()
      where id = ${id} and status = ${expectedStatus}
      returning *`.execute(this.db)).rows[0];
    }
}
