import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type { InformationRootRow, KnowledgeVersionRow, MemoryRootRow, MemorySettingsRow,
  MemorySourceKind, MemoryVersionRow, RuleRow, RuleVersionRow } from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';

type Kind = 'knowledge' | 'memory' | 'decision' | 'rule';
export type MemoryEffectiveStatus = 'ACTIVE' | 'EXPIRED' | 'RETIRED';
export type MemoryStateRow = MemoryRootRow &
  Pick<MemoryVersionRow, 'body_text' | 'confirmed_by' | 'confirmed_at' | 'expires_at'> & {
    readonly effective_status: MemoryEffectiveStatus;
  };
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

  async readMemorySettings(workspaceId: string): Promise<MemorySettingsRow | undefined> {
    return (await sql<MemorySettingsRow>`select * from workspace_memory_settings
      where workspace_id = ${workspaceId}`.execute(this.db)).rows[0];
  }

  /**
   * 整行写入三个开关（0125 起含 `auto_capture`）。
   *
   * `autoCapture` 缺省视为开启：这是 0125 之前旧调用方的语义；生产入口一律显式传值，
   * 避免「只改一个开关把另一个写成默认」。
   */
  async setMemorySettings(workspaceId: string, recallEnabled: boolean,
    automaticCompaction: boolean, autoCapture = true): Promise<MemorySettingsRow> {
    return (await sql<MemorySettingsRow>`insert into workspace_memory_settings
      (workspace_id, recall_enabled, automatic_compaction, auto_capture, revision)
      values (${workspaceId}, ${recallEnabled}, ${automaticCompaction}, ${autoCapture}, 1)
      on conflict (workspace_id) do update set recall_enabled = excluded.recall_enabled,
        automatic_compaction = excluded.automatic_compaction,
        auto_capture = excluded.auto_capture,
        revision = workspace_memory_settings.revision + 1, updated_at = now()
      returning *`.execute(this.db)).rows[0]!;
  }

  async insertMemoryMessageSource(input: { memoryId: string; sessionId: string;
    messageId: string; contentSha256: string }): Promise<void> {
    await sql`insert into memory_message_sources
      (memory_id, memory_version, session_id, message_id, content_sha256)
      values (${input.memoryId}, 1, ${input.sessionId}, ${input.messageId},
        ${input.contentSha256})`.execute(this.db);
  }

  async readMemoryMessageSources(memoryId: string): Promise<readonly {
    memory_version: bigint; session_id: string; message_id: string; content_sha256: string;
  }[]> {
    return (await sql<{ memory_version: bigint; session_id: string; message_id: string;
      content_sha256: string }>`select memory_version, session_id, message_id, content_sha256
      from memory_message_sources where memory_id = ${memoryId}
      order by memory_version`.execute(this.db)).rows;
  }

  /**
   * 召回排序（DEV-0042）：先人工确认，再来源类别。
   *
   * 人工确认的在前（用户自己选的）；同为自动捕获时，引用用户原话的
   * （USER_STATEMENT）先于来源未标注的（UNKNOWN），再后于引用助手叙述的
   * （MODEL_OBSERVATION）——后者可能是工具结果或网页正文的转述，最不能当依据。
   */
  async recallMemories(workspaceId: string, projectId: string | null, terms: readonly string[],
    limit: number, excludedIds: readonly string[] = []): Promise<readonly (MemoryStateRow & { literal_match: boolean })[]> {
    return (await sql<MemoryStateRow & { literal_match: boolean }>`select m.*, v.body_text,
      v.confirmed_by, v.confirmed_at, v.expires_at, 'ACTIVE'::text as effective_status,
      exists (select 1 from unnest(${[...terms]}::text[]) term
        where position(lower(term) in lower(m.title || ' ' || v.body_text)) > 0) as literal_match
      from memory_items m join memory_versions v
        on v.memory_id = m.id and v.version = m.current_version
      where m.workspace_id = ${workspaceId} and m.status = 'ACTIVE'
        and not (m.id = any(${[...excludedIds]}::uuid[]))
        and (m.project_id is null or m.project_id = ${projectId})
        and (v.expires_at is null or v.expires_at > now())
        -- 来源失效（0132 撤回）：自动记忆绑定的那条原消息已撤回时，这条记忆不再有可核对的
        -- 依据，不能继续进入模型上下文。人工记忆没有消息绑定，不受影响。
        and not exists (
          select 1 from memory_message_sources s
          join assist_messages am on am.id = s.message_id
          where s.memory_id = m.id and am.withdrawn_at is not null)
      order by literal_match desc,
        case when m.origin = 'HUMAN_CONFIRMED' then 0 else 1 end,
        case m.source_kind when 'USER_STATEMENT' then 0 when 'UNKNOWN' then 1 else 2 end,
        m.updated_at desc, m.id desc limit ${limit}`.execute(this.db)).rows;
  }

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

  /** One snapshot for lifecycle, current revision and expiry; reading never retires a memory. */
  async listMemoryStates(workspaceId: string, input: { projectId?: string | undefined;
    id?: string; effectiveStatus?: MemoryEffectiveStatus | 'ALL' }): Promise<readonly MemoryStateRow[]> {
    const project = input.projectId === undefined ? sql``
      : sql`and (m.project_id is null or m.project_id = ${input.projectId})`;
    const identity = input.id === undefined ? sql`` : sql`and m.id = ${input.id}`;
    const status = input.effectiveStatus === undefined || input.effectiveStatus === 'ALL' ? sql``
      : sql`where effective_status = ${input.effectiveStatus}`;
    return (await sql<MemoryStateRow>`with memories as (
      select m.*, v.body_text, v.confirmed_by, v.confirmed_at, v.expires_at,
        case when m.status = 'RETIRED' then 'RETIRED'
          when v.expires_at <= now() then 'EXPIRED' else 'ACTIVE' end as effective_status
      from memory_items m join memory_versions v
        on v.memory_id = m.id and v.version = m.current_version
      where m.workspace_id = ${workspaceId} ${project} ${identity}
    ) select * from memories ${status} order by created_at desc, id desc`.execute(this.db)).rows;
  }

  async readCurrentVersion<T>(kind: Kind, rootId: string): Promise<T | undefined> {
    const key = `${kind}_id`;
    return (await sql<T>`select v.* from ${sql.table(VERSIONS[kind])} v
      join ${sql.table(ROOTS[kind])} r on r.id = v.${sql.ref(key)} and r.current_version = v.version
      where r.id = ${rootId}`.execute(this.db)).rows[0];
  }

  async readVersion<T>(kind: Kind, rootId: string, version: bigint): Promise<T | undefined> {
    const key = `${kind}_id`;
    return (await sql<T>`select * from ${sql.table(VERSIONS[kind])}
      where ${sql.ref(key)} = ${rootId} and version = ${version}`.execute(this.db)).rows[0];
  }

  async readKnowledgeVersionById(id: string): Promise<KnowledgeVersionRow | undefined> {
    return (await sql<KnowledgeVersionRow>`select * from knowledge_versions where id = ${id}`
      .execute(this.db)).rows[0];
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
    artifactVersionId: string | null; sourceUri: string | null;
    sourceRefs: JsonObject }): Promise<void> {
    await sql`insert into knowledge_versions (id, workspace_id, knowledge_id, project_id,
      version, source_kind,
      media_type, content_text, content_sha256, source_uri, source_artifact_id, artifact_version_id, source_refs)
      values (${input.id}, ${input.workspaceId}, ${input.knowledgeId}, ${input.projectId}, ${input.version},
      ${input.sourceKind}, ${input.mediaType}, ${input.text}, ${input.hash}, ${input.sourceUri},
      ${input.artifactId},
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

  /**
   * 写入记忆根。`sourceKind` 记「内容来自谁的哪一段」（DEV-0042）：
   * 人工保存是 MANUAL，自动捕获按核验结果写 USER_STATEMENT / MODEL_OBSERVATION。
   * `origin` 记「谁写的」（ADR-030）：自动捕获必须显式写 AUTO_CAPTURE——留默认会
   * 让自动记住的条目在召回排序与界面标注上冒充人工确认。
   */
  async insertMemoryRoot(id: string, workspaceId: string, projectId: string | null,
    title: string, sourceKind: MemorySourceKind = 'MANUAL',
    origin: 'HUMAN_CONFIRMED' | 'AUTO_CAPTURE' = 'HUMAN_CONFIRMED'): Promise<void> {
    await sql`insert into memory_items (id, workspace_id, project_id, title, source_kind, origin)
      values (${id}, ${workspaceId}, ${projectId}, ${title}, ${sourceKind}, ${origin})`
      .execute(this.db);
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
            and not exists (
              select 1 from memory_message_sources s
              join assist_messages am on am.id = s.message_id
              where s.memory_id = m.id and am.withdrawn_at is not null)
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

  // N03 整理候选：只保存来源成果版本与建议归类，接受与否由既有知识命令决定。
  async insertCurationCandidate(input: { id: string; workspaceId: string; projectId: string;
    sourceArtifactId: string; sourceArtifactVersionId: string;
    sourceArtifactRevision: bigint; suggestedTitle: string;
    suggestedKnowledgeId: string | null }): Promise<CurationCandidateRow> {
    const result = await sql<CurationCandidateRow>`insert into knowledge_curation_candidates
      (id, workspace_id, project_id, source_artifact_id, source_artifact_version_id,
        source_artifact_revision, suggested_title, suggested_knowledge_id)
      values (${input.id}, ${input.workspaceId}, ${input.projectId}, ${input.sourceArtifactId},
        ${input.sourceArtifactVersionId}, ${input.sourceArtifactRevision},
        ${input.suggestedTitle}, ${input.suggestedKnowledgeId}) returning *`.execute(this.db);
    return result.rows[0]!;
  }

  async readCurationCandidate(id: string, lock = false):
    Promise<CurationCandidateRow | undefined> {
    const suffix = lock ? sql`for update` : sql``;
    return (await sql<CurationCandidateRow>`select * from knowledge_curation_candidates
      where id = ${id} ${suffix}`.execute(this.db)).rows[0];
  }

  async listCurationCandidates(workspaceId: string, projectId: string, limit: number):
    Promise<readonly CurationCandidateRow[]> {
    return (await sql<CurationCandidateRow>`select * from knowledge_curation_candidates
      where workspace_id = ${workspaceId} and project_id = ${projectId}
      order by created_at desc, id desc limit ${limit}`.execute(this.db)).rows;
  }

  /** 一次性绑定接受结果；已被接受或已拒绝的候选不会被覆盖。 */
  async markCurationAccepted(id: string, knowledgeId: string, knowledgeVersionId: string):
    Promise<boolean> {
    const result = await sql`update knowledge_curation_candidates
      set accepted_knowledge_id = ${knowledgeId},
        accepted_knowledge_version_id = ${knowledgeVersionId}, decided_at = now()
      where id = ${id} and accepted_knowledge_version_id is null
        and rejected_at is null`.execute(this.db);
    return (result.numAffectedRows ?? 0n) === 1n;
  }

  async markCurationRejected(id: string): Promise<boolean> {
    const result = await sql`update knowledge_curation_candidates set rejected_at = now()
      where id = ${id} and accepted_knowledge_version_id is null and rejected_at is null`
      .execute(this.db);
    return (result.numAffectedRows ?? 0n) === 1n;
  }
}

export interface CurationCandidateRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly project_id: string;
  readonly source_artifact_id: string;
  readonly source_artifact_version_id: string;
  readonly source_artifact_revision: bigint;
  readonly suggested_title: string;
  readonly suggested_knowledge_id: string | null;
  readonly accepted_knowledge_id: string | null;
  readonly accepted_knowledge_version_id: string | null;
  readonly created_at: Date;
  readonly decided_at: Date | null;
  readonly rejected_at: Date | null;
}
