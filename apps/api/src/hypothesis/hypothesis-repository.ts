import { sql } from 'kysely';
import type { DbExecutor } from '../infrastructure/database.js';

export interface HypothesisRow {
  id: string; workspace_id: string; project_id: string; title: string;
  current_version: bigint; revision: bigint; current_conclusion_id: string | null; created_at: Date;
}
export interface HypothesisVersionRow {
  id: string; hypothesis_id: string; version: bigint; claim: string; method: string; criterion: string;
  source_knowledge_version_id: string | null; source_message_id: string | null; created_at: Date;
}
export interface HypothesisObservationRow {
  id: string; hypothesis_id: string; hypothesis_version: bigint; summary: string;
  knowledge_version_id: string | null; created_at: Date;
}
export interface HypothesisConclusionRow {
  id: string; hypothesis_id: string; hypothesis_version: bigint; kind: 'SUGGESTION' | 'USER_CONFIRMED';
  outcome: 'SUPPORTED' | 'NOT_SUPPORTED' | 'INCONCLUSIVE'; rationale: string;
  evidence_sufficient: boolean; method_reliable: boolean; observation_ids: string[];
  suggestion_id: string | null; created_at: Date;
}
export class HypothesisRepository {
  constructor(private readonly db: DbExecutor) {}
  async create(id: string, workspaceId: string, projectId: string, title: string) {
    return (await sql<HypothesisRow>`insert into hypotheses (id, workspace_id, project_id, title)
      values (${id}, ${workspaceId}, ${projectId}, ${title}) returning *`.execute(this.db)).rows[0]!;
  }
  async read(id: string, lock = false) {
    return (await sql<HypothesisRow>`select * from hypotheses where id = ${id}
      ${lock ? sql`for update` : sql``}`.execute(this.db)).rows[0];
  }
  async list(workspaceId: string, projectId: string) {
    return (await sql<HypothesisRow>`select * from hypotheses where workspace_id = ${workspaceId}
      and project_id = ${projectId} order by created_at desc, id desc`.execute(this.db)).rows;
  }
  async advance(row: HypothesisRow) {
    return (await sql<HypothesisRow>`update hypotheses set current_version = ${row.current_version},
      current_conclusion_id = ${row.current_conclusion_id}, revision = revision + 1 where id = ${row.id}
      returning *`.execute(this.db)).rows[0]!;
  }
  async addVersion(row: Omit<HypothesisVersionRow, 'created_at'>) {
    await sql`insert into hypothesis_versions
      (id, hypothesis_id, version, claim, method, criterion, source_knowledge_version_id, source_message_id)
      values (${row.id}, ${row.hypothesis_id}, ${row.version}, ${row.claim}, ${row.method}, ${row.criterion},
        ${row.source_knowledge_version_id}, ${row.source_message_id})`.execute(this.db);
  }
  async versions(id: string) {
    return (await sql<HypothesisVersionRow>`select * from hypothesis_versions where hypothesis_id = ${id}
      order by version desc`.execute(this.db)).rows;
  }
  async observe(row: Omit<HypothesisObservationRow, 'created_at'>) {
    await sql`insert into hypothesis_observations (id, hypothesis_id, hypothesis_version, summary, knowledge_version_id)
      values (${row.id}, ${row.hypothesis_id}, ${row.hypothesis_version}, ${row.summary}, ${row.knowledge_version_id})`.execute(this.db);
  }
  async observations(id: string) {
    return (await sql<HypothesisObservationRow>`select * from hypothesis_observations where hypothesis_id = ${id}
      order by created_at desc, id desc`.execute(this.db)).rows;
  }
  async conclude(row: Omit<HypothesisConclusionRow, 'created_at'>) {
    await sql`insert into hypothesis_conclusions
      (id, hypothesis_id, hypothesis_version, kind, outcome, rationale, evidence_sufficient,
        method_reliable, observation_ids, suggestion_id)
      values (${row.id}, ${row.hypothesis_id}, ${row.hypothesis_version}, ${row.kind}, ${row.outcome},
        ${row.rationale}, ${row.evidence_sufficient}, ${row.method_reliable},
        ${JSON.stringify(row.observation_ids)}::jsonb, ${row.suggestion_id})`.execute(this.db);
  }
  async conclusions(id: string) {
    return (await sql<HypothesisConclusionRow>`select * from hypothesis_conclusions where hypothesis_id = ${id}
      order by created_at desc, id desc`.execute(this.db)).rows;
  }
}
