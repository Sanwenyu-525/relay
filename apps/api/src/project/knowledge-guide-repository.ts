import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import { requireRow } from '../shared/sql-rows.js';

export type GuideRefKind = 'KNOWLEDGE' | 'DECISION' | 'RULE' | 'ARTIFACT_VERSION';
export type GuideReferenceMode = 'PINNED' | 'CURRENT';

export interface KnowledgeGuideRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly project_id: string;
  readonly revision: bigint;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface KnowledgeGuideEntryRow {
  readonly guide_id: string;
  readonly ordinal: number;
  readonly ref_kind: GuideRefKind;
  readonly reference_mode: GuideReferenceMode;
  readonly knowledge_id: string | null;
  readonly decision_id: string | null;
  readonly rule_id: string | null;
  readonly artifact_version_id: string | null;
  readonly pinned_version_id: string | null;
  readonly target_id: string;
  readonly label: string | null;
}

export interface NewGuideEntry {
  readonly guideId: string;
  readonly ordinal: number;
  readonly refKind: GuideRefKind;
  readonly referenceMode: GuideReferenceMode;
  readonly knowledgeId: string | null;
  readonly decisionId: string | null;
  readonly ruleId: string | null;
  readonly artifactVersionId: string | null;
  readonly pinnedVersionId: string | null;
  readonly label: string | null;
}

/**
 * 导读编排本身由 Project 拥有；这里只保存确切引用与人工标签。
 * 当前状态一律现查，不在导读里维护第二份 revision 或正文。
 */
export class KnowledgeGuideRepository {
  constructor(private readonly db: DbExecutor) {}

  async insertGuide(guide: { id: string; workspaceId: string; projectId: string }):
    Promise<KnowledgeGuideRow> {
    const result = await sql<KnowledgeGuideRow>`insert into project_knowledge_guides
      (id, workspace_id, project_id) values (${guide.id}, ${guide.workspaceId}, ${guide.projectId})
      returning *`.execute(this.db);
    return requireRow(result.rows, 'insert into project_knowledge_guides');
  }

  async readGuideByProject(projectId: string): Promise<KnowledgeGuideRow | undefined> {
    return (await sql<KnowledgeGuideRow>`select * from project_knowledge_guides
      where project_id = ${projectId}`.execute(this.db)).rows[0];
  }

  async lockGuideByProject(projectId: string): Promise<KnowledgeGuideRow | undefined> {
    return (await sql<KnowledgeGuideRow>`select * from project_knowledge_guides
      where project_id = ${projectId} for update`.execute(this.db)).rows[0];
  }

  /** 替换式保存：条目是可编辑的导航清单，不追加成第二份历史。 */
  async bumpRevision(guideId: string, expected: bigint): Promise<boolean> {
    const result = await sql`update project_knowledge_guides
      set revision = revision + 1, updated_at = now()
      where id = ${guideId} and revision = ${expected}`.execute(this.db);
    return (result.numAffectedRows ?? 0n) === 1n;
  }

  async replaceEntries(guideId: string, entries: readonly NewGuideEntry[]): Promise<void> {
    await sql`delete from project_knowledge_guide_entries where guide_id = ${guideId}`
      .execute(this.db);
    for (const entry of entries) {
      await sql`insert into project_knowledge_guide_entries (guide_id, ordinal, ref_kind,
        reference_mode, knowledge_id, decision_id, rule_id, artifact_version_id,
        pinned_version_id, label)
        values (${entry.guideId}, ${entry.ordinal}, ${entry.refKind}, ${entry.referenceMode},
          ${entry.knowledgeId}, ${entry.decisionId}, ${entry.ruleId},
          ${entry.artifactVersionId}, ${entry.pinnedVersionId}, ${entry.label})`.execute(this.db);
    }
  }

  async listEntries(guideId: string): Promise<readonly KnowledgeGuideEntryRow[]> {
    return (await sql<KnowledgeGuideEntryRow>`select * from project_knowledge_guide_entries
      where guide_id = ${guideId} order by ordinal`.execute(this.db)).rows;
  }

  async listGuidesReferencing(knowledgeId: string): Promise<readonly KnowledgeGuideRow[]> {
    return (await sql<KnowledgeGuideRow>`select g.* from project_knowledge_guides g
      join project_knowledge_guide_entries e on e.guide_id = g.id
      where e.knowledge_id = ${knowledgeId}`.execute(this.db)).rows;
  }
}
