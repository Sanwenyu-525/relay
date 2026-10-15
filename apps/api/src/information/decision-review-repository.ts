import { sql } from 'kysely';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';

export interface DecisionPremiseRow {
  id: string; workspace_id: string; project_id: string; decision_id: string; decision_revision: bigint;
  statement: string; knowledge_id: string | null; hypothesis_id: string | null;
  baseline_ref: JsonObject; revision: bigint; created_at: Date;
}
export interface DecisionReviewRow {
  id: string; premise_id: string; decision_revision: bigint; premise_revision: bigint; fingerprint: string;
  before_ref: JsonObject; after_ref: JsonObject; cause_command_id: string;
  status: 'PENDING' | 'KEPT' | 'DISMISSED'; revision: bigint; reason: string | null;
  created_at: Date; resolved_at: Date | null;
}
export class DecisionReviewRepository {
  constructor(private readonly db: DbExecutor) {}
  async register(row: Omit<DecisionPremiseRow, 'revision' | 'created_at'>) {
    return (await sql<DecisionPremiseRow>`insert into decision_premises
      (id, workspace_id, project_id, decision_id, decision_revision, statement, knowledge_id, hypothesis_id, baseline_ref)
      values (${row.id}, ${row.workspace_id}, ${row.project_id}, ${row.decision_id}, ${row.decision_revision},
        ${row.statement}, ${row.knowledge_id}, ${row.hypothesis_id}, ${JSON.stringify(row.baseline_ref)}::jsonb)
      returning *`.execute(this.db)).rows[0]!;
  }
  async premises(workspaceId: string, decisionId: string) {
    return (await sql<DecisionPremiseRow>`select * from decision_premises where workspace_id = ${workspaceId}
      and decision_id = ${decisionId} order by created_at, id`.execute(this.db)).rows;
  }
  async premise(id: string, lock = false) {
    return (await sql<DecisionPremiseRow>`select * from decision_premises where id = ${id}
      ${lock ? sql`for update` : sql``}`.execute(this.db)).rows[0];
  }
  async related(workspaceId: string, source: { knowledgeId?: string; hypothesisId?: string }) {
    return (await sql<DecisionPremiseRow>`select p.* from decision_premises p where p.workspace_id = ${workspaceId}
      and (${source.hypothesisId === undefined ? sql`false` : sql`p.hypothesis_id = ${source.hypothesisId}`} or
        ${source.knowledgeId === undefined ? sql`false` : sql`p.knowledge_id = ${source.knowledgeId} or exists (
          select 1 from hypotheses h where h.id = p.hypothesis_id and (
            exists (select 1 from hypothesis_versions v join knowledge_versions k on k.id = v.source_knowledge_version_id
              where v.hypothesis_id = h.id and v.version = h.current_version and k.knowledge_id = ${source.knowledgeId}) or
            exists (select 1 from hypothesis_observations o join knowledge_versions k on k.id = o.knowledge_version_id
              where o.hypothesis_id = h.id and o.hypothesis_version = h.current_version and k.knowledge_id = ${source.knowledgeId})))`})`
      .execute(this.db)).rows;
  }
  async prepare(row: Omit<DecisionReviewRow, 'status' | 'revision' | 'reason' | 'created_at' | 'resolved_at'>) {
    return (await sql<DecisionReviewRow>`insert into decision_review_candidates
      (id, premise_id, decision_revision, premise_revision, fingerprint, before_ref, after_ref, cause_command_id)
      values (${row.id}, ${row.premise_id}, ${row.decision_revision}, ${row.premise_revision}, ${row.fingerprint},
        ${JSON.stringify(row.before_ref)}::jsonb, ${JSON.stringify(row.after_ref)}::jsonb, ${row.cause_command_id})
      on conflict (premise_id, fingerprint) do nothing returning *`.execute(this.db)).rows[0];
  }
  async read(id: string, lock = false) {
    return (await sql<DecisionReviewRow>`select * from decision_review_candidates where id = ${id}
      ${lock ? sql`for update` : sql``}`.execute(this.db)).rows[0];
  }
  async list(workspaceId: string, projectId: string) {
    return (await sql<DecisionReviewRow>`select c.* from decision_review_candidates c join decision_premises p on p.id = c.premise_id
      where p.workspace_id = ${workspaceId} and p.project_id = ${projectId} order by c.created_at desc, c.id desc`.execute(this.db)).rows;
  }
  async resolve(id: string, status: 'KEPT' | 'DISMISSED', reason: string) {
    return (await sql<DecisionReviewRow>`update decision_review_candidates set status = ${status}, reason = ${reason},
      resolved_at = now(), revision = revision + 1 where id = ${id} returning *`.execute(this.db)).rows[0]!;
  }
  async acceptBaseline(id: string, baseline: JsonObject) {
    await sql`update decision_premises set baseline_ref = ${JSON.stringify(baseline)}::jsonb,
      revision = revision + 1 where id = ${id}`.execute(this.db);
  }
}
