import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type { InformationRootRow, KnowledgeVersionRow, RuleRow, RuleVersionRow }
  from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';

type Kind = 'knowledge' | 'memory' | 'decision' | 'rule';
const ROOTS = {
  knowledge: 'knowledge_items', memory: 'memory_items', decision: 'decisions', rule: 'rules',
} as const;
const VERSIONS = {
  knowledge: 'knowledge_versions', memory: 'memory_versions',
  decision: 'decision_versions', rule: 'rule_versions',
} as const;

/** Information 模块独占四类事实的写入口；表名只来自内部枚举。 */
export class InformationRepository {
  constructor(private readonly db: DbExecutor) {}

  async readRoot<T extends InformationRootRow | RuleRow>(kind: Kind, id: string,
    lock = false): Promise<T | undefined> {
    const suffix = lock ? sql`for update` : sql``;
    return (await sql<T>`select * from ${sql.table(ROOTS[kind])} where id = ${id} ${suffix}`
      .execute(this.db)).rows[0];
  }

  async listRoots<T extends InformationRootRow | RuleRow>(kind: Kind, workspaceId: string,
    projectId?: string): Promise<readonly T[]> {
    const project = projectId === undefined ? sql`` : sql`and (project_id is null or project_id = ${projectId})`;
    return (await sql<T>`select * from ${sql.table(ROOTS[kind])}
      where workspace_id = ${workspaceId} ${project} order by created_at desc, id desc`
      .execute(this.db)).rows;
  }

  async listVersions<T>(kind: Kind, rootId: string): Promise<readonly T[]> {
    const key = `${kind}_id`;
    return (await sql<T>`select * from ${sql.table(VERSIONS[kind])}
      where ${sql.ref(key)} = ${rootId} order by version desc`.execute(this.db)).rows;
  }

  async readCurrentVersion<T>(kind: Kind, rootId: string): Promise<T | undefined> {
    const key = `${kind}_id`;
    return (await sql<T>`select v.* from ${sql.table(VERSIONS[kind])} v
      join ${sql.table(ROOTS[kind])} r on r.id = v.${sql.ref(key)} and r.current_version = v.version
      where r.id = ${rootId}`.execute(this.db)).rows[0];
  }

  async insertKnowledgeRoot(id: string, workspaceId: string, projectId: string | null,
    title: string): Promise<void> {
    await sql`insert into knowledge_items (id, workspace_id, project_id, title)
      values (${id}, ${workspaceId}, ${projectId}, ${title})`.execute(this.db);
  }

  async insertKnowledgeVersion(input: { id: string; workspaceId: string; knowledgeId: string;
    projectId: string | null;
    version: bigint; sourceKind: KnowledgeVersionRow['source_kind']; mediaType: string;
    text: string | null; hash: Buffer; artifactId: string | null;
    artifactVersionId: string | null; sourceRefs: JsonObject }): Promise<void> {
    await sql`insert into knowledge_versions (id, workspace_id, knowledge_id, project_id,
      version, source_kind,
      media_type, content_text, content_sha256, source_artifact_id, artifact_version_id, source_refs)
      values (${input.id}, ${input.workspaceId}, ${input.knowledgeId}, ${input.projectId}, ${input.version},
      ${input.sourceKind}, ${input.mediaType}, ${input.text}, ${input.hash}, ${input.artifactId},
      ${input.artifactVersionId}, ${JSON.stringify(input.sourceRefs)}::jsonb)`.execute(this.db);
  }

  async readArtifactSource(workspaceId: string, versionId: string): Promise<{
    artifact_id: string; project_id: string | null; content_hash: Buffer; media_type: string;
  } | undefined> {
    // 同一来源的并发提升在这个事务级锁下串行；不可变 ArtifactVersion 不需要 UPDATE 权限。
    await sql`select pg_advisory_xact_lock(hashtextextended(${versionId}, 0))`.execute(this.db);
    return (await sql<{ artifact_id: string; project_id: string | null;
      content_hash: Buffer; media_type: string }>`
      select a.id as artifact_id, a.project_id, v.content_hash, v.media_type
      from artifact_versions v join artifacts a on a.id = v.artifact_id
      where a.workspace_id = ${workspaceId} and v.id = ${versionId}`.execute(this.db)).rows[0];
  }

  async readPromotedArtifact(workspaceId: string, versionId: string): Promise<{
    knowledge_id: string; version: bigint; project_id: string | null;
    revision: bigint; status: string;
  } | undefined> {
    return (await sql<{ knowledge_id: string; version: bigint;
      project_id: string | null; revision: bigint; status: string }>`
      select v.knowledge_id, v.version, k.project_id, k.revision, k.status
      from knowledge_versions v join knowledge_items k on k.id = v.knowledge_id
      where v.workspace_id = ${workspaceId} and v.artifact_version_id = ${versionId}`
      .execute(this.db)).rows[0];
  }

  async insertMemoryRoot(id: string, workspaceId: string, projectId: string | null,
    title: string): Promise<void> {
    await sql`insert into memory_items (id, workspace_id, project_id, title)
      values (${id}, ${workspaceId}, ${projectId}, ${title})`.execute(this.db);
  }

  async insertMemoryVersion(input: { id: string; memoryId: string; version: bigint;
    title: string; text: string; confirmedBy: string; expiresAt: Date | null }): Promise<void> {
    await sql`insert into memory_versions (id, memory_id, version, title, body_text, confirmed_by,
      confirmed_at, expires_at) values (${input.id}, ${input.memoryId}, ${input.version},
      ${input.title}, ${input.text}, ${input.confirmedBy}, now(), ${input.expiresAt})`.execute(this.db);
  }

  async insertDecisionRoot(id: string, workspaceId: string, projectId: string | null,
    title: string): Promise<void> {
    await sql`insert into decisions (id, workspace_id, project_id, title)
      values (${id}, ${workspaceId}, ${projectId}, ${title})`.execute(this.db);
  }

  async insertDecisionVersion(input: { id: string; decisionId: string; version: bigint;
    choice: string; rationale: string; alternatives: readonly string[]; costs: readonly string[] }): Promise<void> {
    await sql`insert into decision_versions (id, decision_id, version, choice, rationale,
      alternatives, costs) values (${input.id}, ${input.decisionId}, ${input.version},
      ${input.choice}, ${input.rationale}, ${JSON.stringify(input.alternatives)}::jsonb,
      ${JSON.stringify(input.costs)}::jsonb)`.execute(this.db);
  }

  async supersedeDecision(id: string, successorId: string): Promise<void> {
    await sql`update decisions set status = 'SUPERSEDED', superseded_by_id = ${successorId},
      revision = revision + 1, updated_at = now() where id = ${id}`.execute(this.db);
  }

  async decisionChain(id: string): Promise<readonly { id: string; superseded_by_id: string | null }[]> {
    return (await sql<{ id: string; superseded_by_id: string | null }>`
      with recursive chain as (
        select id, superseded_by_id from decisions where id = ${id}
        union all select d.id, d.superseded_by_id from decisions d
          join chain c on d.id = c.superseded_by_id
      ) select * from chain`.execute(this.db)).rows;
  }

  async insertRuleRoot(input: { id: string; workspaceId: string;
    scope: RuleRow['scope']; projectId: string | null; taskId: string | null }): Promise<void> {
    await sql`insert into rules (id, workspace_id, scope, project_id, task_id)
      values (${input.id}, ${input.workspaceId}, ${input.scope}, ${input.projectId},
      ${input.taskId})`.execute(this.db);
  }

  async insertRuleVersion(input: { id: string; ruleId: string; version: bigint;
    ruleKey: string; statement: string; strength: RuleVersionRow['strength'];
    enforcement: RuleVersionRow['enforcement']; method: RuleVersionRow['method'];
    targetSpec: JsonObject }): Promise<void> {
    await sql`insert into rule_versions (id, rule_id, version, rule_key, statement,
      strength, applicability, enforcement, method, target_spec)
      values (${input.id}, ${input.ruleId}, ${input.version}, ${input.ruleKey},
      ${input.statement}, ${input.strength}, 'AI_RUN', ${input.enforcement},
      ${input.method}, ${JSON.stringify(input.targetSpec)}::jsonb)`.execute(this.db);
  }

  async listApplicableRules(workspaceId: string, projectId: string,
    taskId: string): Promise<readonly (RuleRow & RuleVersionRow)[]> {
    return (await sql<RuleRow & RuleVersionRow>`
      select r.*, v.id as version_id, v.version, v.rule_key, v.statement,
        v.strength, v.applicability, v.enforcement, v.method, v.target_spec
      from rules r join rule_versions v on v.rule_id = r.id and v.version = r.current_version
      where r.workspace_id = ${workspaceId} and r.status = 'ACTIVE'
        and (r.scope = 'WORKSPACE' or (r.scope = 'PROJECT' and r.project_id = ${projectId})
          or (r.scope = 'TASK' and r.task_id = ${taskId}))
      order by case r.scope when 'WORKSPACE' then 0 when 'PROJECT' then 1 else 2 end, r.id`
      .execute(this.db)).rows;
  }

  /** P11 bounded fallback when no explicit source selection exists for Delegate. */
  async listContextCandidates(workspaceId: string, projectId: string, limit: number): Promise<readonly {
    kind: 'KNOWLEDGE' | 'MEMORY' | 'DECISION'; id: string;
  }[]> {
    return (await sql<{ kind: 'KNOWLEDGE' | 'MEMORY' | 'DECISION'; id: string }>`
      with candidates as (
        select 'KNOWLEDGE'::text as kind, id, updated_at from knowledge_items
          where workspace_id = ${workspaceId} and status = 'ACTIVE'
            and (project_id is null or project_id = ${projectId})
        union all
        select 'MEMORY', m.id, m.updated_at from memory_items m
          join memory_versions v on v.memory_id = m.id and v.version = m.current_version
          where m.workspace_id = ${workspaceId} and m.status = 'ACTIVE'
            and (m.project_id is null or m.project_id = ${projectId})
            and (v.expires_at is null or v.expires_at > now())
        union all
        select 'DECISION', id, updated_at from decisions
          where workspace_id = ${workspaceId} and status = 'ACTIVE'
            and (project_id is null or project_id = ${projectId})
      ) select kind, id from candidates order by updated_at desc, id desc, kind limit ${limit}
    `.execute(this.db)).rows;
  }

  async setRootVersion(kind: Kind, id: string, version: bigint, title?: string): Promise<void> {
    const titleSet = title === undefined ? sql`` : sql`, title = ${title}`;
    await sql`update ${sql.table(ROOTS[kind])} set current_version = ${version},
      revision = revision + 1, updated_at = now() ${titleSet} where id = ${id}`.execute(this.db);
  }

  async setRootStatus(kind: Kind, id: string, status: string): Promise<void> {
    await sql`update ${sql.table(ROOTS[kind])} set status = ${status},
      revision = revision + 1, updated_at = now() where id = ${id}`.execute(this.db);
  }
}
