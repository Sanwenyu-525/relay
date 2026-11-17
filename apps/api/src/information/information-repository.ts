import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type { InformationRootRow, KnowledgeVersionRow, MemoryCaptureTaskRow,
  MemoryMaintenanceRunRow, MemoryRootRow, MemorySettingsRow, MemorySourceKind, MemoryVersionRow,
  RuleRow, RuleVersionRow } from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';

type Kind = 'knowledge' | 'memory' | 'decision' | 'rule';
export type MemoryEffectiveStatus = 'ACTIVE' | 'EXPIRED' | 'RETIRED' | 'SUPERSEDED' | 'STALE';
export type MemoryStateRow = MemoryRootRow &
  Pick<MemoryVersionRow, 'body_text' | 'confirmed_by' | 'confirmed_at' | 'expires_at'> & {
    readonly effective_status: MemoryEffectiveStatus;
  };

/** 0164：召回/管理需要的扩展设置。未提供时沿用 0162 的产品默认。 */
export interface MemorySettingExtras {
  readonly coreTokenBudget?: number;
  readonly retrievalTokenBudget?: number;
  readonly retrievalTopK?: number;
  readonly retrievalMode?: 'LITERAL' | 'HYBRID';
  readonly autoConsolidate?: boolean;
  readonly consolidationIntervalHours?: number;
  readonly memoryStaleAfterDays?: number;
  readonly embeddingProvider?: 'disabled' | 'openai-compatible';
  readonly remoteEmbeddingAllowed?: boolean;
  readonly includeStaleInRecall?: boolean;
}
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
   * 整行写入三个开关与压缩阈值（0125 起含 `auto_capture`；0162 起含阈值）。
   *
   * `autoCapture` 缺省视为开启：这是 0125 之前旧调用方的语义；生产入口一律显式传值，
   * 避免「只改一个开关把另一个写成默认」。
   *
   * `compactionThresholdTokens` 是**已解析**的值：`null` 表示「回到产品默认 350K」，
   * 不是「未提供」。应用层负责把「旧客户端没带这个字段」解析成当前已保存的值
   * （见 `memory-settings.ts`），仓库只负责把这个确切值写进去。直接调用本方法的
   * 测试与旧路径保持 0162 之前的行为（写入 NULL）。
   */
  async setMemorySettings(workspaceId: string, recallEnabled: boolean,
    automaticCompaction: boolean, autoCapture = true,
    compactionThresholdTokens: number | null = null,
    extras: MemorySettingExtras = {}): Promise<MemorySettingsRow> {
    const core = extras.coreTokenBudget ?? 2000;
    const retrieval = extras.retrievalTokenBudget ?? 3000;
    const topK = extras.retrievalTopK ?? 5;
    const mode = extras.retrievalMode ?? 'LITERAL';
    const consolidate = extras.autoConsolidate ?? true;
    const interval = extras.consolidationIntervalHours ?? 24;
    const staleDays = extras.memoryStaleAfterDays ?? 180;
    const provider = extras.embeddingProvider ?? 'disabled';
    const remote = extras.remoteEmbeddingAllowed ?? false;
    const includeStale = extras.includeStaleInRecall ?? false;
    return (await sql<MemorySettingsRow>`insert into workspace_memory_settings
      (workspace_id, recall_enabled, automatic_compaction, auto_capture,
        compaction_threshold_tokens, core_token_budget, retrieval_token_budget, retrieval_top_k,
        retrieval_mode, auto_consolidate, consolidation_interval_hours, memory_stale_after_days,
        embedding_provider, remote_embedding_allowed, include_stale_in_recall, revision)
      values (${workspaceId}, ${recallEnabled}, ${automaticCompaction}, ${autoCapture},
        ${compactionThresholdTokens}, ${core}, ${retrieval}, ${topK}, ${mode}, ${consolidate},
        ${interval}, ${staleDays}, ${provider}, ${remote}, ${includeStale}, 1)
      on conflict (workspace_id) do update set recall_enabled = excluded.recall_enabled,
        automatic_compaction = excluded.automatic_compaction,
        auto_capture = excluded.auto_capture,
        compaction_threshold_tokens = excluded.compaction_threshold_tokens,
        core_token_budget = excluded.core_token_budget,
        retrieval_token_budget = excluded.retrieval_token_budget,
        retrieval_top_k = excluded.retrieval_top_k,
        retrieval_mode = excluded.retrieval_mode,
        auto_consolidate = excluded.auto_consolidate,
        consolidation_interval_hours = excluded.consolidation_interval_hours,
        memory_stale_after_days = excluded.memory_stale_after_days,
        embedding_provider = excluded.embedding_provider,
        remote_embedding_allowed = excluded.remote_embedding_allowed,
        include_stale_in_recall = excluded.include_stale_in_recall,
        revision = workspace_memory_settings.revision + 1, updated_at = now()
      returning *`.execute(this.db)).rows[0]!;
  }

  /** 写入裁决的事务级串行锁；必须由持有同一事务连接的 Repository 执行。 */
  async lockMemoryWrite(key: string): Promise<void> {
    await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(this.db);
  }

  async insertMemoryMessageSource(input: { memoryId: string; sessionId: string;
    messageId: string; contentSha256: string }): Promise<void> {
    await sql`insert into memory_message_sources
      (memory_id, memory_version, session_id, message_id, content_sha256)
      values (${input.memoryId}, 1, ${input.sessionId}, ${input.messageId},
        ${input.contentSha256})`.execute(this.db);
  }

  /**
   * 0167：来源证据按真实消息读取；消息被撤回/删除/正文变化时如实返回状态，不补造内容。
   */
  async readMemorySourceEvidence(memoryId: string): Promise<readonly {
    memory_version: bigint; session_id: string; message_id: string; content_sha256: string;
    role: string | null; content: string | null; status: string | null;
    withdrawn_at: Date | null; session_title: string | null; source_quote: string | null;
  }[]> {
    return (await sql<{
      memory_version: bigint; session_id: string; message_id: string; content_sha256: string;
      role: string | null; content: string | null; status: string | null;
      withdrawn_at: Date | null; session_title: string | null; source_quote: string | null;
    }>`select s.memory_version, s.session_id, s.message_id, s.content_sha256,
      am.role, am.content, am.status, am.withdrawn_at, sess.title as session_title,
      (select c.source_quote from memory_auto_captures c where c.memory_id = s.memory_id limit 1)
        as source_quote
      from memory_message_sources s
      left join assist_messages am on am.id = s.message_id
      left join assist_sessions sess on sess.id = s.session_id
      where s.memory_id = ${memoryId} order by s.memory_version`
      .execute(this.db)).rows;
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
   *
   * 0164：新增「被替代」「已过期」「已标记陈旧」的过滤；旧调用方仍用本方法取候选列表。
   */
  async recallMemories(workspaceId: string, projectId: string | null, terms: readonly string[],
    limit: number, excludedIds: readonly string[] = []): Promise<readonly (MemoryStateRow & { literal_match: boolean })[]> {
    return (await sql<MemoryStateRow & { literal_match: boolean }>`select m.*, v.body_text,
      v.confirmed_by, v.confirmed_at, v.expires_at,
      case when m.status <> 'ACTIVE' then 'RETIRED'
        when m.superseded_by_id is not null then 'SUPERSEDED'
        when v.expires_at <= now() then 'EXPIRED'
        when m.stale_at is not null then 'STALE' else 'ACTIVE' end as effective_status,
      exists (select 1 from unnest(${[...terms]}::text[]) term
        where position(lower(term) in lower(m.title || ' ' || v.body_text)) > 0) as literal_match
      from memory_items m join memory_versions v
        on v.memory_id = m.id and v.version = m.current_version
      where m.workspace_id = ${workspaceId} and m.status = 'ACTIVE'
        and m.superseded_by_id is null
        and not (m.id = any(${[...excludedIds]}::uuid[]))
        and (m.project_id is null or m.project_id = ${projectId})
        and (coalesce(m.expires_at_override, v.expires_at) is null
          or coalesce(m.expires_at_override, v.expires_at) > now())
        -- 来源失效（0132 撤回）：自动记忆绑定的那条原消息已撤回时，这条记忆不再有可核对的
        -- 依据，不能继续进入模型上下文。人工记忆没有消息绑定，不受影响。
        and not exists (
          select 1 from memory_message_sources s
          join assist_messages am on am.id = s.message_id
          where s.memory_id = m.id and am.withdrawn_at is not null)
      order by literal_match desc,
        m.pinned desc,
        case when m.origin = 'HUMAN_CONFIRMED' then 0 else 1 end,
        case m.source_kind when 'USER_STATEMENT' then 0 when 'UNKNOWN' then 1 else 2 end,
        m.updated_at desc, m.id desc limit ${limit}`.execute(this.db)).rows;
  }

  /**
   * 0164 召回：作用域过滤 → 倒排全文/结构化键 → 排序 → 有界候选。
   *
   * 只对满足以下任一条件的行取候选：
   *   * `memory_key` 精确命中（结构化冲突/现行规则优先）；
   *   * 倒排索引命中（search_*_tokens 非空的 FTS 表达式）；
   *   * 旧行没有 token 时按字面包含兜底，避免迁移后旧记忆消失。
   * 不提供查询词且没有 key 时返回空数组——调用方不得退化成全表扫描。
   */
  async recallMemoriesV2(workspaceId: string, input: {
    readonly terms: readonly string[];
    readonly tsQuery: string | null;
    readonly key: string | null;
    readonly projectId: string | null;
    readonly taskId: string | null;
    readonly typeHints: readonly string[];
    readonly includeStale: boolean;
    readonly excludePinned: boolean;
    readonly excludedIds: readonly string[];
    readonly limit: number;
  }): Promise<readonly (MemoryStateRow & {
    literal_match: boolean; fts_rank: number; key_match: boolean; type_match: boolean;
  })[]> {
    if (input.tsQuery === null && input.key === null) return [];
    const fts = sql`(setweight(to_tsvector('simple', m.search_title_tokens), 'A')
      || setweight(to_tsvector('simple', m.search_body_tokens), 'B'))`;
    const legacyLiteral = input.terms.length === 0 ? sql`false` : sql`exists (
      select 1 from unnest(${[...input.terms]}::text[]) term
      where position(lower(term) in lower(m.title || ' ' || v.body_text)) > 0)`;
    const keyMatch = input.key === null ? sql`false` : sql`m.memory_key = ${input.key}`;
    const ftsMatch = input.tsQuery === null ? sql`false`
      : sql`${fts} @@ to_tsquery('simple', ${input.tsQuery})`;
    const unindexed = sql`(m.search_title_tokens = '' and m.search_body_tokens = '')`;
    const candidate = sql`(${keyMatch} or ${ftsMatch} or (${unindexed} and ${legacyLiteral}))`;
    const scope = input.projectId === null
      ? sql`and m.scope = 'WORKSPACE'`
      : sql`and ((m.scope = 'WORKSPACE')
          or (m.scope = 'PROJECT' and m.project_id = ${input.projectId})
          or (m.scope = 'TASK' and m.project_id = ${input.projectId}
            and m.task_id = ${input.taskId}))`;
    const stale = input.includeStale ? sql`` : sql`and m.stale_at is null`;
    const pinned = input.excludePinned ? sql`and m.pinned = false` : sql``;
    const typeHints = input.typeHints.length === 0 ? sql`false`
      : sql`m.memory_type = any(${[...input.typeHints]}::text[])`;
    return (await sql<MemoryStateRow & { literal_match: boolean; fts_rank: number;
      key_match: boolean; type_match: boolean }>`select m.*, v.body_text,
      v.confirmed_by, v.confirmed_at, coalesce(m.expires_at_override, v.expires_at) as expires_at,
      case when m.status <> 'ACTIVE' then 'RETIRED'
        when m.superseded_by_id is not null then 'SUPERSEDED'
        when coalesce(m.expires_at_override, v.expires_at) <= now() then 'EXPIRED'
        when m.stale_at is not null then 'STALE' else 'ACTIVE' end as effective_status,
      (${keyMatch} or ${legacyLiteral}) as literal_match,
      ${input.tsQuery === null ? sql`0::float4` : sql`ts_rank(${fts}, to_tsquery('simple', ${input.tsQuery}))`} as fts_rank,
      (${keyMatch}) as key_match,
      (${typeHints}) as type_match
      from memory_items m join memory_versions v
        on v.memory_id = m.id and v.version = m.current_version
      where m.workspace_id = ${workspaceId} and m.status = 'ACTIVE'
        and m.superseded_by_id is null
        and (coalesce(m.expires_at_override, v.expires_at) is null
          or coalesce(m.expires_at_override, v.expires_at) > now())
        -- 0167：含指令覆盖意图的记忆只作为管理页面数据，不自动进入提示词。
        and not m.instruction_risk
        ${scope} ${stale} ${pinned}
        and not (m.id = any(${[...input.excludedIds]}::uuid[]))
        and ${candidate}
        and not exists (
          select 1 from memory_message_sources s
          join assist_messages am on am.id = s.message_id
          where s.memory_id = m.id and am.withdrawn_at is not null)
      order by m.pinned desc, key_match desc, type_match desc, fts_rank desc,
        case when m.origin = 'HUMAN_CONFIRMED' then 0 else 1 end,
        case m.source_kind when 'USER_STATEMENT' then 0 when 'UNKNOWN' then 1 else 2 end,
        m.importance desc, m.confidence desc, m.updated_at desc, m.id desc
      limit ${input.limit}`.execute(this.db)).rows;
  }

  /** 固定（pinned）记忆：每轮常驻，仍有作用域/失效/来源撤回检查。 */
  async recallPinnedMemories(workspaceId: string, input: {
    readonly projectId: string | null; readonly taskId: string | null;
    readonly includeStale: boolean; readonly excludedIds: readonly string[];
    readonly limit: number;
  }): Promise<readonly MemoryStateRow[]> {
    const scope = input.projectId === null
      ? sql`and m.scope = 'WORKSPACE'`
      : sql`and ((m.scope = 'WORKSPACE')
          or (m.scope = 'PROJECT' and m.project_id = ${input.projectId})
          or (m.scope = 'TASK' and m.project_id = ${input.projectId}
            and m.task_id = ${input.taskId}))`;
    const stale = input.includeStale ? sql`` : sql`and m.stale_at is null`;
    return (await sql<MemoryStateRow>`select m.*, v.body_text, v.confirmed_by, v.confirmed_at,
      coalesce(m.expires_at_override, v.expires_at) as expires_at,
      case when m.status <> 'ACTIVE' then 'RETIRED'
        when m.superseded_by_id is not null then 'SUPERSEDED'
        when coalesce(m.expires_at_override, v.expires_at) <= now() then 'EXPIRED'
        when m.stale_at is not null then 'STALE' else 'ACTIVE' end as effective_status
      from memory_items m join memory_versions v
        on v.memory_id = m.id and v.version = m.current_version
      where m.workspace_id = ${workspaceId} and m.status = 'ACTIVE' and m.pinned
        and m.superseded_by_id is null
        and (coalesce(m.expires_at_override, v.expires_at) is null
          or coalesce(m.expires_at_override, v.expires_at) > now())
        and not m.instruction_risk
        ${scope} ${stale}
        and not (m.id = any(${[...input.excludedIds]}::uuid[]))
        and not exists (
          select 1 from memory_message_sources s
          join assist_messages am on am.id = s.message_id
          where s.memory_id = m.id and am.withdrawn_at is not null)
      order by m.importance desc, m.confidence desc, m.updated_at desc, m.id desc
      limit ${input.limit}`.execute(this.db)).rows;
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
    id?: string; effectiveStatus?: MemoryEffectiveStatus | 'ALL';
    memoryType?: string; origin?: string; query?: string; limit?: number;
    verification?: string; sourceKind?: string; pinned?: boolean;
    sort?: 'updated' | 'created' | 'importance';
    /** 排序键 + id 的游标；由上一页最后一行的真实字段生成，不接受客户端猜测。 */
    cursor?: { readonly at: Date; readonly id: string; readonly importance?: number };
  }): Promise<readonly MemoryStateRow[]> {
    const project = input.projectId === undefined ? sql``
      : sql`and (m.project_id is null or m.project_id = ${input.projectId})`;
    const identity = input.id === undefined ? sql`` : sql`and m.id = ${input.id}`;
    const type = input.memoryType === undefined || input.memoryType === 'ALL' ? sql``
      : sql`and m.memory_type = ${input.memoryType}`;
    const origin = input.origin === undefined || input.origin === 'ALL' ? sql``
      : sql`and m.origin = ${input.origin}`;
    const verification = input.verification === undefined || input.verification === 'ALL' ? sql``
      : sql`and m.verification = ${input.verification}`;
    const sourceKind = input.sourceKind === undefined || input.sourceKind === 'ALL' ? sql``
      : sql`and m.source_kind = ${input.sourceKind}`;
    const pinned = input.pinned === undefined ? sql``
      : input.pinned ? sql`and m.pinned` : sql`and not m.pinned`;
    // 结构化键也参与搜索；此前占位文案承诺了“键”，SQL 只查标题/正文。
    const query = input.query === undefined || input.query.trim() === '' ? sql``
      : sql`and (position(lower(${input.query.trim().slice(0, 200)}) in lower(m.title || ' ' || v.body_text)) > 0
          or position(lower(${input.query.trim().slice(0, 200)}) in lower(coalesce(m.memory_key, ''))) > 0)`;
    const status = input.effectiveStatus === undefined || input.effectiveStatus === 'ALL' ? sql``
      : sql`and effective_status = ${input.effectiveStatus}`;
    const sort = input.sort ?? 'updated';
    const cursor = input.cursor === undefined ? sql``
      : sort === 'importance'
        ? sql`and (importance, updated_at, id) < (${input.cursor.importance ?? 0}::smallint,
            ${input.cursor.at}::timestamptz, ${input.cursor.id}::uuid)`
        : sort === 'created'
          ? sql`and (created_at, id) < (${input.cursor.at}::timestamptz, ${input.cursor.id}::uuid)`
          : sql`and (updated_at, id) < (${input.cursor.at}::timestamptz, ${input.cursor.id}::uuid)`;
    const order = sort === 'importance'
      ? sql`order by importance desc, updated_at desc, id desc`
      : sort === 'created' ? sql`order by created_at desc, id desc`
        : sql`order by updated_at desc, id desc`;
    const limit = input.id === undefined ? Math.min(Math.max(input.limit ?? 50, 1), 101) : 1;
    return (await sql<MemoryStateRow>`with memories as (
      select m.*, v.body_text, v.confirmed_by, v.confirmed_at,
        coalesce(m.expires_at_override, v.expires_at) as expires_at,
        case when m.status = 'RETIRED' then 'RETIRED'
          when m.superseded_by_id is not null then 'SUPERSEDED'
          when coalesce(m.expires_at_override, v.expires_at) <= now() then 'EXPIRED'
          when m.stale_at is not null then 'STALE' else 'ACTIVE' end as effective_status
      from memory_items m join memory_versions v
        on v.memory_id = m.id and v.version = m.current_version
      where m.workspace_id = ${workspaceId} ${project} ${identity} ${type} ${origin}
        ${verification} ${sourceKind} ${pinned} ${query}
    ) select * from memories where true ${status} ${cursor} ${order} limit ${limit}`
      .execute(this.db)).rows;
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

  /**
   * 知识检索索引（0167）：摘要与分词随当前版本写入根行。
   *
   * 摘要存在根上，是为了让列表不为「显示两行摘要」去读整段正文；
   * 分词存在根上，是为了让倒排索引与版本正文解耦——旧版本正文留在版本表，
   * 索引永远描述**当前**版本，不会把旧版本词元错误地算进新版本。
   */
  async setKnowledgeIndex(knowledgeId: string, input: { summary: string | null;
    titleTokens: string; bodyTokens: string }): Promise<void> {
    await sql`update knowledge_items set summary = ${input.summary},
      search_title_tokens = ${input.titleTokens}, search_body_tokens = ${input.bodyTokens}
      where id = ${knowledgeId}`.execute(this.db);
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
   *
   * 0164 追加的分层字段都有明确默认：旧调用方不传时保持迁移前的行为（UNKNOWN /
   * WORKSPACE / UNVERIFIED），不会凭空把一条记忆标成已验证或项目事实。
   */
  async insertMemoryRoot(input: {
    id: string; workspaceId: string; projectId: string | null;
    title: string; sourceKind?: MemorySourceKind;
    origin?: 'HUMAN_CONFIRMED' | 'AUTO_CAPTURE';
    memoryType?: string; scope?: string; taskId?: string | null; agentId?: string | null;
    memoryKey?: string | null; importance?: number; confidence?: number;
    verification?: string; verifiedAt?: Date | null; lastAccessedAt?: Date | null;
    staleAt?: Date | null; pinned?: boolean; supersedesId?: string | null;
    contentHash?: string | null; searchTitleTokens?: string; searchBodyTokens?: string;
    retiredReason?: string | null; instructionRisk?: boolean; expiresAtOverride?: Date | null;
  }): Promise<void> {
    const scope = input.scope ?? (input.projectId === null ? 'WORKSPACE' : 'PROJECT');
    await sql`insert into memory_items (id, workspace_id, project_id, title, source_kind, origin,
      memory_type, scope, task_id, agent_id, memory_key, importance, confidence, verification,
      verified_at, last_accessed_at, stale_at, pinned, supersedes_id, content_hash,
      search_title_tokens, search_body_tokens, retired_reason, instruction_risk, expires_at_override)
      values (${input.id}, ${input.workspaceId}, ${input.projectId}, ${input.title},
        ${input.sourceKind ?? 'MANUAL'}, ${input.origin ?? 'HUMAN_CONFIRMED'},
        ${input.memoryType ?? 'UNKNOWN'}, ${scope}, ${input.taskId ?? null}, ${input.agentId ?? null},
        ${input.memoryKey ?? null}, ${input.importance ?? 3}, ${input.confidence ?? 50},
        ${input.verification ?? 'UNVERIFIED'}, ${input.verifiedAt ?? null},
        ${input.lastAccessedAt ?? null}, ${input.staleAt ?? null}, ${input.pinned ?? false},
        ${input.supersedesId ?? null}, ${input.contentHash ?? null},
        ${input.searchTitleTokens ?? ''}, ${input.searchBodyTokens ?? ''},
        ${input.retiredReason ?? null}, ${input.instructionRisk ?? false},
        ${input.expiresAtOverride ?? null})`.execute(this.db);
  }

  async insertMemoryVersion(input: { id: string; memoryId: string; version: bigint;
    title: string; text: string; confirmedBy: string; expiresAt: Date | null;
    confirmedAt?: Date | null }): Promise<void> {
    await sql`insert into memory_versions (id, memory_id, version, title, body_text, confirmed_by,
      confirmed_at, expires_at) values (${input.id}, ${input.memoryId}, ${input.version},
      ${input.title}, ${input.text}, ${input.confirmedBy}, ${input.confirmedAt ?? new Date()},
      ${input.expiresAt})`.execute(this.db);
  }

  /** 0167：导入保留版本号后把根的 current_version/title 对齐到最新版本。 */
  async setMemoryCurrentVersion(memoryId: string, version: bigint, title: string): Promise<void> {
    await sql`update memory_items set current_version = ${version}, title = ${title},
      revision = revision + 1, updated_at = now() where id = ${memoryId}`.execute(this.db);
  }

  /** 0164：编辑/验证/固定后的当前分类元数据；版本正文仍由 AddMemoryRevision 负责。 */
  async updateMemoryMetadata(input: {
    memoryId: string; memoryType?: string; memoryKey?: string | null;
    importance?: number; confidence?: number; verification?: string;
    verifiedAt?: Date | null; pinned?: boolean; staleAt?: Date | null;
    contentHash?: string | null; searchTitleTokens?: string; searchBodyTokens?: string;
    supersedesId?: string | null; retiredReason?: string | null;
    instructionRisk?: boolean; expiresAtOverride?: Date | null;
  }): Promise<void> {
    await sql`update memory_items set
      memory_type = ${input.memoryType === undefined ? sql`memory_type` : input.memoryType},
      memory_key = ${input.memoryKey === undefined ? sql`memory_key` : input.memoryKey},
      importance = ${input.importance === undefined ? sql`importance` : input.importance},
      confidence = ${input.confidence === undefined ? sql`confidence` : input.confidence},
      verification = ${input.verification === undefined ? sql`verification` : input.verification},
      verified_at = ${input.verifiedAt === undefined ? sql`verified_at` : input.verifiedAt},
      pinned = ${input.pinned === undefined ? sql`pinned` : input.pinned},
      stale_at = ${input.staleAt === undefined ? sql`stale_at` : input.staleAt},
      content_hash = ${input.contentHash === undefined ? sql`content_hash` : input.contentHash},
      search_title_tokens = ${input.searchTitleTokens === undefined ? sql`search_title_tokens` : input.searchTitleTokens},
      search_body_tokens = ${input.searchBodyTokens === undefined ? sql`search_body_tokens` : input.searchBodyTokens},
      supersedes_id = ${input.supersedesId === undefined ? sql`supersedes_id` : input.supersedesId},
      retired_reason = ${input.retiredReason === undefined ? sql`retired_reason` : input.retiredReason},
      instruction_risk = ${input.instructionRisk === undefined ? sql`instruction_risk` : input.instructionRisk},
      expires_at_override = ${input.expiresAtOverride === undefined
        ? sql`expires_at_override` : input.expiresAtOverride},
      revision = revision + 1, updated_at = now()
      where id = ${input.memoryId}`.execute(this.db);
  }

  /** 0164：把旧事实标记为「已被替代」；根状态不写回 SUPERSEDED，由两列派生追溯链。 */
  async supersedeMemory(oldId: string, replacementId: string, reason: string): Promise<void> {
    await sql`update memory_items set superseded_by_id = ${replacementId},
      retired_reason = ${reason}, revision = revision + 1, updated_at = now()
      where id = ${oldId} and status = 'ACTIVE' and superseded_by_id is null`.execute(this.db);
  }

  /** 0164：固定/取消固定；固定只影响常驻召回，不改变事实可信度。 */
  async setMemoryPinned(memoryId: string, pinned: boolean): Promise<void> {
    await sql`update memory_items set pinned = ${pinned}, revision = revision + 1,
      updated_at = now() where id = ${memoryId}`.execute(this.db);
  }

  /** 0164：人工标记已验证/失败；只改验证列，不重写正文。 */
  async setMemoryVerification(memoryId: string, verification: string, confidence: number): Promise<void> {
    await sql`update memory_items set verification = ${verification},
      verified_at = ${verification === 'VERIFIED' ? sql`now()` : sql`null`},
      confidence = ${confidence}, revision = revision + 1, updated_at = now()
      where id = ${memoryId}`.execute(this.db);
  }

  async touchMemoryAccessed(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await sql`update memory_items set last_accessed_at = now()
      where id = any(${[...ids]}::uuid[])`.execute(this.db);
  }

  async clearMemoryStale(memoryId: string): Promise<void> {
    await sql`update memory_items set stale_at = null, revision = revision + 1,
      updated_at = now() where id = ${memoryId}`.execute(this.db);
  }

  /**
   * 0164 写前去重候选：结构化键/内容指纹精确命中，或同作用域同类型的最近若干条。
   *
   * 不做全库扫描：键与 hash 都有索引，最近候选按 updated_at 倒序取有界窗口；近似重复
   * 只在窗口内比较，宁可把「很久以前的相似记忆」当成新事实，也不让每次写入拖慢。
   */
  async listMemoryWriteCandidates(workspaceId: string, input: {
    readonly projectId: string | null; readonly taskId: string | null;
    readonly memoryType: string; readonly memoryKey: string | null;
    readonly contentHash: string; readonly recentLimit?: number;
  }): Promise<readonly MemoryStateRow[]> {
    // 写入裁决只在「完全相同的作用域」内比较：项目事实不能顶掉工作空间偏好，
    // 任务经验也不能替代项目规则。召回才允许从工作空间/项目/任务逐层叠加。
    const scope = input.taskId !== null
      ? sql`and m.scope = 'TASK' and m.project_id = ${input.projectId}
          and m.task_id = ${input.taskId}`
      : input.projectId !== null
        ? sql`and m.scope = 'PROJECT' and m.project_id = ${input.projectId}`
        : sql`and m.scope = 'WORKSPACE'`;
    const key = input.memoryKey === null ? sql`false` : sql`m.memory_key = ${input.memoryKey}`;
    // ORDER BY 里不能直接放 `false` 常量（PostgreSQL 42601），用 CASE 生成 0/1 排序键。
    const keyOrder = input.memoryKey === null ? sql``
      : sql`(case when m.memory_key = ${input.memoryKey} then 1 else 0 end) desc,`;
    const limit = Math.min(Math.max(input.recentLimit ?? 30, 1), 60);
    return (await sql<MemoryStateRow>`select m.*, v.body_text, v.confirmed_by, v.confirmed_at,
      coalesce(m.expires_at_override, v.expires_at) as expires_at,
      case when m.status <> 'ACTIVE' then 'RETIRED'
        when m.superseded_by_id is not null then 'SUPERSEDED'
        when coalesce(m.expires_at_override, v.expires_at) <= now() then 'EXPIRED'
        when m.stale_at is not null then 'STALE' else 'ACTIVE' end as effective_status
      from memory_items m join memory_versions v
        on v.memory_id = m.id and v.version = m.current_version
      where m.workspace_id = ${workspaceId} and m.status = 'ACTIVE'
        and m.superseded_by_id is null
        and (coalesce(m.expires_at_override, v.expires_at) is null
          or coalesce(m.expires_at_override, v.expires_at) > now())
        ${scope}
        and (${key} or m.content_hash = ${input.contentHash}
          or m.memory_type = ${input.memoryType})
        and not exists (
          select 1 from memory_message_sources s
          join assist_messages am on am.id = s.message_id
          where s.memory_id = m.id and am.withdrawn_at is not null)
      order by ${keyOrder}
        (case when m.content_hash = ${input.contentHash} then 1 else 0 end) desc,
        m.updated_at desc
      limit ${limit}`.execute(this.db)).rows;
  }

  /** 0164：管理端统计只读聚合；时间窗口由调用方给，避免在 SQL 里猜时区。 */
  async memoryStats(workspaceId: string, projectId: string | null): Promise<{
    readonly total: number; readonly active: number; readonly superseded: number;
    readonly retired: number; readonly expired: number; readonly stale: number;
    readonly unverified: number; readonly failed: number; readonly instruction_risk: number;
    readonly pinned: number; readonly storage_bytes: number; readonly unindexed: number;
    readonly last_recall_at: Date | null; readonly last_maintenance_at: Date | null;
    readonly recall_24h: number; readonly avg_latency_ms: number | null;
    readonly capture_pending: number; readonly capture_failed: number;
    readonly capture_last_24h: number;
  }> {
    const project = projectId === null ? sql`` : sql`and (m.project_id is null or m.project_id = ${projectId})`;
    const row = (await sql<{ total: number; active: number; superseded: number; retired: number;
      expired: number; stale: number; unverified: number; failed: number; instruction_risk: number;
      pinned: number; storage_bytes: number; unindexed: number;
      last_recall_at: Date | null; last_maintenance_at: Date | null; recall_24h: number;
      avg_latency_ms: number | null; capture_pending: number; capture_failed: number;
      capture_last_24h: number }>`select
        count(*)::int as total,
        count(*) filter (where m.status = 'ACTIVE' and m.superseded_by_id is null
          and (coalesce(m.expires_at_override, v.expires_at) is null
            or coalesce(m.expires_at_override, v.expires_at) > now())
          and m.stale_at is null and m.verification <> 'FAILED')::int as active,
        count(*) filter (where m.superseded_by_id is not null)::int as superseded,
        count(*) filter (where m.status = 'RETIRED')::int as retired,
        count(*) filter (where m.status = 'ACTIVE' and m.superseded_by_id is null
          and coalesce(m.expires_at_override, v.expires_at) <= now())::int as expired,
        count(*) filter (where m.status = 'ACTIVE' and m.superseded_by_id is null
          and m.stale_at is not null)::int as stale,
        count(*) filter (where m.verification = 'UNVERIFIED')::int as unverified,
        count(*) filter (where m.verification = 'FAILED')::int as failed,
        count(*) filter (where m.instruction_risk)::int as instruction_risk,
        count(*) filter (where m.status = 'ACTIVE' and m.pinned)::int as pinned,
        coalesce(sum(octet_length(m.title) + octet_length(v.body_text)), 0)::bigint as storage_bytes,
        count(*) filter (where m.search_title_tokens = '' and m.search_body_tokens = '')::int as unindexed,
        (select max(created_at) from memory_recall_events e
          where e.workspace_id = ${workspaceId}) as last_recall_at,
        (select max(started_at) from memory_maintenance_runs r
          where r.workspace_id = ${workspaceId} and r.status = 'COMPLETED') as last_maintenance_at,
        (select count(*)::int from memory_recall_events e
          where e.workspace_id = ${workspaceId} and e.created_at > now() - interval '24 hours') as recall_24h,
        (select round(avg(e.latency_ms))::int from memory_recall_events e
          where e.workspace_id = ${workspaceId} and e.created_at > now() - interval '24 hours') as avg_latency_ms,
        (select count(*)::int from memory_capture_tasks t
          where t.workspace_id = ${workspaceId}
            and t.status in ('PENDING', 'RUNNING')) as capture_pending,
        (select count(*)::int from memory_capture_tasks t
          where t.workspace_id = ${workspaceId} and t.status = 'FAILED') as capture_failed,
        (select count(*)::int from memory_capture_tasks t
          where t.workspace_id = ${workspaceId}
            and t.created_at > now() - interval '24 hours') as capture_last_24h
      from memory_items m join memory_versions v
        on v.memory_id = m.id and v.version = m.current_version
      where m.workspace_id = ${workspaceId} ${project}`.execute(this.db)).rows[0]!;
    return { ...row, storage_bytes: Number(row.storage_bytes) };
  }

  async memoryCountsByType(workspaceId: string, projectId: string | null): Promise<readonly {
    memory_type: string; count: number;
  }[]> {
    const project = projectId === null ? sql`` : sql`and (project_id is null or project_id = ${projectId})`;
    return (await sql<{ memory_type: string; count: number }>`select memory_type, count(*)::int as count
      from memory_items where workspace_id = ${workspaceId} ${project}
      group by memory_type order by count desc, memory_type`.execute(this.db)).rows;
  }

  /** 0164/0167 整理互斥：事务级锁；必须由持有同一事务连接的 Repository 执行。 */
  async tryLockMemoryConsolidation(workspaceId: string): Promise<boolean> {
    const row = (await sql<{ locked: boolean }>`select pg_try_advisory_xact_lock(
      hashtextextended(${`memory-consolidation:${workspaceId}`}, 0)) as locked`
      .execute(this.db)).rows[0];
    return row?.locked === true;
  }

  async insertMemoryRecallEvent(input: {
    id: string; workspaceId: string; projectId: string | null; sessionId: string | null;
    querySha256: string; queryExcerpt: string; mode: string; candidates: number;
    selected: number; tokens: number; latencyMs: number; degraded: string | null;
  }): Promise<void> {
    await sql`insert into memory_recall_events (id, workspace_id, project_id, session_id,
      query_sha256, query_excerpt, mode, candidates, selected, tokens, latency_ms, degraded)
      values (${input.id}, ${input.workspaceId}, ${input.projectId}, ${input.sessionId},
        ${input.querySha256}, ${input.queryExcerpt}, ${input.mode}, ${input.candidates},
        ${input.selected}, ${input.tokens}, ${input.latencyMs}, ${input.degraded})`.execute(this.db);
  }

  async insertMemoryMaintenanceRun(input: {
    id: string; workspaceId: string; trigger: 'MANUAL' | 'AUTO' | 'CLI';
  }): Promise<void> {
    await sql`insert into memory_maintenance_runs (id, workspace_id, trigger)
      values (${input.id}, ${input.workspaceId}, ${input.trigger})`.execute(this.db);
  }

  async finishMemoryMaintenanceRun(input: {
    id: string; status: 'COMPLETED' | 'FAILED'; stats: JsonObject; error: string | null;
  }): Promise<void> {
    await sql`update memory_maintenance_runs set status = ${input.status},
      stats = ${JSON.stringify(input.stats)}::jsonb, error = ${input.error},
      finished_at = now() where id = ${input.id}`.execute(this.db);
  }

  async listMemoryMaintenanceRuns(workspaceId: string, limit = 20):
    Promise<readonly MemoryMaintenanceRunRow[]> {
    return (await sql<MemoryMaintenanceRunRow>`select * from memory_maintenance_runs
      where workspace_id = ${workspaceId} order by started_at desc, id desc limit ${Math.min(limit, 100)}`
      .execute(this.db)).rows;
  }

  /** 0167：到期可领取任务（Worker tick 用）；只取 PENDING 且已过退避时间。 */
  async listDueMemoryCaptureTasks(limit = 5): Promise<readonly MemoryCaptureTaskRow[]> {
    return (await sql<MemoryCaptureTaskRow>`select * from memory_capture_tasks
      where status = 'PENDING' and next_attempt_at <= now()
      order by next_attempt_at asc, created_at asc
      limit ${Math.min(Math.max(limit, 1), 20)}`.execute(this.db)).rows;
  }

  /** 0167：人工延长/取消有效期；只改根行覆盖值，不动历史版本。 */
  async setMemoryExpiryOverride(memoryId: string, expiresAt: Date | null): Promise<void> {
    await sql`update memory_items set expires_at_override = ${expiresAt},
      revision = revision + 1, updated_at = now() where id = ${memoryId}`.execute(this.db);
  }

  async retryMemoryCaptureTask(id: string, workspaceId: string): Promise<boolean> {
    const result = await sql`update memory_capture_tasks set status = 'PENDING',
      attempts = 0, next_attempt_at = now(), lease_until = null, claimed_by = null,
      error_kind = null, last_error = null, completed_at = null, updated_at = now()
      where id = ${id} and workspace_id = ${workspaceId}
        and status in ('FAILED', 'CANCELLED')
      returning id`.execute(this.db);
    return Number(result.numAffectedRows ?? 0n) > 0;
  }

  async cancelMemoryCaptureTask(id: string, workspaceId: string): Promise<boolean> {
    const result = await sql`update memory_capture_tasks set status = 'CANCELLED',
      error_kind = 'USER_CANCELLED', last_error = '用户取消了这条捕获任务',
      completed_at = now(), updated_at = now()
      where id = ${id} and workspace_id = ${workspaceId}
        and status in ('PENDING', 'RUNNING')
      returning id`.execute(this.db);
    return Number(result.numAffectedRows ?? 0n) > 0;
  }

  /** 0167：幂等登记一条捕获任务；同一轮同一类型只允许一条。 */
  async insertMemoryCaptureTask(input: {
    readonly id: string; readonly workspaceId: string; readonly projectId: string | null;
    readonly sessionId: string; readonly triggerMessageId: string;
    readonly userMessageId: string | null; readonly kind: 'AUTO' | 'EXPLICIT';
    readonly maxAttempts?: number;
  }): Promise<boolean> {
    const result = await sql`insert into memory_capture_tasks
      (id, workspace_id, project_id, session_id, trigger_message_id, user_message_id, kind,
        max_attempts)
      values (${input.id}, ${input.workspaceId}, ${input.projectId}, ${input.sessionId},
        ${input.triggerMessageId}, ${input.userMessageId}, ${input.kind},
        ${input.maxAttempts ?? 3})
      on conflict (session_id, trigger_message_id, kind) do nothing
      returning id`.execute(this.db);
    return Number(result.numAffectedRows ?? 0n) > 0;
  }

  async readMemoryCaptureTask(id: string): Promise<MemoryCaptureTaskRow | undefined> {
    return (await sql<MemoryCaptureTaskRow>`
      select * from memory_capture_tasks where id = ${id}`.execute(this.db)).rows[0];
  }

  async readMemoryCaptureTaskForMessage(sessionId: string, messageId: string,
    kind: 'AUTO' | 'EXPLICIT'): Promise<MemoryCaptureTaskRow | undefined> {
    return (await sql<MemoryCaptureTaskRow>`
      select * from memory_capture_tasks
      where session_id = ${sessionId} and trigger_message_id = ${messageId} and kind = ${kind}`
      .execute(this.db)).rows[0];
  }

  async listMemoryCaptureTasks(workspaceId: string, filter: {
    readonly sessionId?: string | undefined;
    readonly status?: string | undefined;
    readonly limit?: number;
  }): Promise<readonly MemoryCaptureTaskRow[]> {
    const session = filter.sessionId === undefined ? sql`` : sql`and session_id = ${filter.sessionId}`;
    const status = filter.status === undefined || filter.status === 'ALL' ? sql``
      : sql`and status = ${filter.status}`;
    return (await sql<MemoryCaptureTaskRow>`
      select * from memory_capture_tasks where workspace_id = ${workspaceId} ${session} ${status}
      order by created_at desc, id desc limit ${Math.min(Math.max(filter.limit ?? 20, 1), 100)}`
      .execute(this.db)).rows;
  }

  /** 消息页专用：一次取回这些助手消息的全部捕获任务（AUTO/EXPLICIT 各一条）。 */
  async listMemoryCaptureTasksByMessages(messageIds: readonly string[]):
    Promise<readonly MemoryCaptureTaskRow[]> {
    if (messageIds.length === 0) return [];
    return (await sql<MemoryCaptureTaskRow>`select * from memory_capture_tasks
      where trigger_message_id = any(${[...messageIds]}::uuid[])
      order by created_at asc, id asc`.execute(this.db)).rows;
  }

  /**
   * 0167：领取一条到期任务。条件更新保证同一任务只有一个 Worker 进入 RUNNING；
   * 前一次 RUNNING 租约过期后由 `recoverExpiredMemoryCaptureTasks` 放回 PENDING。
   */
  async claimMemoryCaptureTask(input: {
    readonly id: string; readonly workerId: string; readonly leaseMs: number;
  }): Promise<boolean> {
    const result = await sql`update memory_capture_tasks set status = 'RUNNING',
      claimed_by = ${input.workerId},
      lease_until = now() + (${Math.max(input.leaseMs, 1000)}::int * interval '1 millisecond'),
      attempts = attempts + 1, error_kind = null, last_error = null, updated_at = now()
      where id = ${input.id} and status = 'PENDING' and next_attempt_at <= now()
      returning id`.execute(this.db);
    return Number(result.numAffectedRows ?? 0n) > 0;
  }

  /** 0167：成功/空结果/取消/失败收口；终态必须写 completed_at。 */
  async finishMemoryCaptureTask(input: {
    readonly id: string; readonly status: 'SUCCEEDED' | 'EMPTY' | 'FAILED' | 'CANCELLED';
    readonly result: JsonObject; readonly errorKind: string | null; readonly lastError: string | null;
  }): Promise<void> {
    await sql`update memory_capture_tasks set status = ${input.status},
      result = ${JSON.stringify(input.result)}::jsonb, error_kind = ${input.errorKind},
      last_error = ${input.lastError}, lease_until = null, updated_at = now(),
      completed_at = now() where id = ${input.id}
        and status in ('PENDING', 'RUNNING')`.execute(this.db);
  }

  /** 0167：可重试失败放回 PENDING，并写下一次尝试时间与错误类别。 */
  async rescheduleMemoryCaptureTask(input: {
    readonly id: string; readonly errorKind: string; readonly lastError: string;
    readonly nextAttemptAt: Date; readonly maxAttempts: number;
  }): Promise<boolean> {
    const result = await sql`update memory_capture_tasks set status = case
        when attempts >= ${input.maxAttempts} then 'FAILED' else 'PENDING' end,
      error_kind = ${input.errorKind}, last_error = ${input.lastError},
      next_attempt_at = ${input.nextAttemptAt}, lease_until = null, updated_at = now(),
      completed_at = case when attempts >= ${input.maxAttempts} then now() else null end
      where id = ${input.id} and status = 'RUNNING'
      returning status`.execute(this.db);
    return Number(result.numAffectedRows ?? 0n) > 0;
  }

  /** 0167：Worker 崩溃/进程退出留下的 RUNNING 租约回收。 */
  async recoverExpiredMemoryCaptureTasks(limit = 20): Promise<number> {
    const result = await sql`update memory_capture_tasks set
      status = case when attempts >= max_attempts then 'FAILED' else 'PENDING' end,
      lease_until = null, claimed_by = null, error_kind = 'LEASE_EXPIRED',
      last_error = 'worker lease expired before task completion',
      next_attempt_at = now(), updated_at = now(),
      completed_at = case when attempts >= max_attempts then now() else null end
      where id in (
        select id from memory_capture_tasks
        where status = 'RUNNING' and lease_until < now()
        order by lease_until asc limit ${Math.min(Math.max(limit, 1), 100)})
      returning id`.execute(this.db);
    return Number(result.numAffectedRows ?? 0n);
  }

  /** 0167：压缩前屏障；只统计即将被 Checkpoint 覆盖的消息，较新的未落定任务不阻塞旧段。 */
  async countUnsettledCaptureTasks(sessionId: string,
    messageIds?: readonly string[]): Promise<number> {
    const scope = messageIds === undefined ? sql``
      : sql`and (trigger_message_id = any(${[...messageIds]}::uuid[])
          or user_message_id = any(${[...messageIds]}::uuid[]))`;
    const row = (await sql<{ count: number }>`select count(*)::int as count
      from memory_capture_tasks where session_id = ${sessionId}
        and status in ('PENDING', 'RUNNING') ${scope}`.execute(this.db)).rows[0];
    return row?.count ?? 0;
  }

  /**
   * 恢复扫描的候选轮次（只读事实，不写任务）。
   *
   * `kind` 必须由应用层按用户原话再次识别：这里只把“完全没有任务”或
   * “旧版关闭自动捕获时被 CANCELLED 的明确记住轮次”找出来，不把普通寒暄当成显式。
   */
  async listMissingCaptureTurns(limit = 20): Promise<readonly {
    readonly workspace_id: string; readonly project_id: string | null;
    readonly session_id: string; readonly trigger_message_id: string;
    readonly user_message_id: string;
  }[]> {
    return (await sql<{
      workspace_id: string; project_id: string | null; session_id: string;
      trigger_message_id: string; user_message_id: string;
    }>`select s.workspace_id, s.project_id, s.id as session_id,
        am.id as trigger_message_id, prev.id as user_message_id
      from assist_messages am
      join assist_sessions s on s.id = am.session_id
      join assist_messages prev on prev.session_id = am.session_id and prev.seq = am.seq - 1
      where am.role = 'ASSISTANT' and am.status = 'COMPLETED' and am.withdrawn_at is null
        and am.created_at > now() - interval '7 days'
        and am.content is not null and am.content <> ''
        and prev.role = 'USER' and prev.status = 'COMPLETED' and prev.withdrawn_at is null
        and prev.content is not null and prev.content <> ''
        and s.status = 'ACTIVE' and s.remember and s.conversation_mode = 'AGENT'
        and (
          not exists (select 1 from memory_capture_tasks t
            where t.session_id = am.session_id and t.trigger_message_id = am.id)
          or (
            not exists (select 1 from memory_capture_tasks t
              where t.session_id = am.session_id and t.trigger_message_id = am.id
                and t.kind = 'EXPLICIT')
            and exists (select 1 from memory_capture_tasks t
              where t.session_id = am.session_id and t.trigger_message_id = am.id
                and t.kind = 'AUTO' and t.status = 'CANCELLED'
                and t.error_kind = 'AUTO_CAPTURE_DISABLED')
            and prev.content ~* '记住|记一下|记下|牢记|别忘了|别忘记|不要忘记|remember'
          )
        )
      order by am.created_at asc limit ${Math.min(Math.max(limit, 1), 100)}`
      .execute(this.db)).rows;
  }

  /** 兼容入口：只补 AUTO 的旧扫描；新 Worker 使用 `listMissingCaptureTurns`。 */
  async enqueueMissingCaptureTasks(limit = 20): Promise<number> {
    const result = await sql`insert into memory_capture_tasks
      (id, workspace_id, project_id, session_id, trigger_message_id, user_message_id, kind)
      select gen_random_uuid(), s.workspace_id, s.project_id, s.id, am.id, prev.id, 'AUTO'
      from assist_messages am
      join assist_sessions s on s.id = am.session_id
      join assist_messages prev on prev.session_id = am.session_id and prev.seq = am.seq - 1
      left join memory_capture_tasks t on t.session_id = am.session_id
        and t.trigger_message_id = am.id and t.kind = 'AUTO'
      left join workspace_memory_settings ws on ws.workspace_id = s.workspace_id
      where am.role = 'ASSISTANT' and am.status = 'COMPLETED' and am.withdrawn_at is null
        and am.created_at > now() - interval '7 days'
        and am.content is not null and am.content <> ''
        and prev.role = 'USER' and prev.status = 'COMPLETED' and prev.withdrawn_at is null
        and prev.content is not null and prev.content <> ''
        and s.status = 'ACTIVE' and s.remember and s.conversation_mode = 'AGENT'
        and coalesce(ws.auto_capture, true)
        and t.id is null
      order by am.created_at asc limit ${Math.min(Math.max(limit, 1), 100)}
      on conflict (session_id, trigger_message_id, kind) do nothing
      returning id`.execute(this.db);
    return Number(result.numAffectedRows ?? 0n);
  }

  /** 0164 整理：按 id 读当前有效行，供确定性选择保留者。 */
  async listMemoryStatesByIds(workspaceId: string, ids: readonly string[]):
    Promise<readonly MemoryStateRow[]> {
    if (ids.length === 0) return [];
    return (await sql<MemoryStateRow>`select m.*, v.body_text, v.confirmed_by, v.confirmed_at,
      coalesce(m.expires_at_override, v.expires_at) as expires_at,
      case when m.status <> 'ACTIVE' then 'RETIRED'
        when m.superseded_by_id is not null then 'SUPERSEDED'
        when coalesce(m.expires_at_override, v.expires_at) <= now() then 'EXPIRED'
        when m.stale_at is not null then 'STALE' else 'ACTIVE' end as effective_status
      from memory_items m join memory_versions v
        on v.memory_id = m.id and v.version = m.current_version
      where m.workspace_id = ${workspaceId} and m.id = any(${[...ids]}::uuid[])`
      .execute(this.db)).rows;
  }

  /** 0164 整理：列出同内容指纹的重复组（只含当前有效行）。 */
  async listDuplicateMemoryGroups(workspaceId: string, limit: number): Promise<readonly {
    readonly content_hash: string; readonly ids: readonly string[];
  }[]> {
    const rows = (await sql<{ content_hash: string; ids: string[] }>`select m.content_hash,
      array_agg(m.id order by m.updated_at desc, m.id) as ids
      from memory_items m join memory_versions v
        on v.memory_id = m.id and v.version = m.current_version
      where m.workspace_id = ${workspaceId} and m.status = 'ACTIVE'
        and m.superseded_by_id is null and m.content_hash is not null
        and (coalesce(m.expires_at_override, v.expires_at) is null
          or coalesce(m.expires_at_override, v.expires_at) > now())
      group by m.content_hash, m.scope, m.project_id, m.task_id, m.memory_type
      having count(*) > 1
      order by count(*) desc, m.content_hash limit ${Math.min(limit, 200)}`.execute(this.db)).rows;
    return rows.map((row) => ({ content_hash: row.content_hash, ids: row.ids }));
  }

  /** 0164 整理：列出同结构化键的重复组（只含当前有效行）。 */
  async listDuplicateMemoryKeyGroups(workspaceId: string, limit: number): Promise<readonly {
    readonly memory_key: string; readonly ids: readonly string[];
  }[]> {
    const rows = (await sql<{ memory_key: string; ids: string[] }>`select m.memory_key,
      array_agg(m.id order by m.updated_at desc, m.id) as ids
      from memory_items m join memory_versions v
        on v.memory_id = m.id and v.version = m.current_version
      where m.workspace_id = ${workspaceId} and m.status = 'ACTIVE'
        and m.superseded_by_id is null and m.memory_key is not null
        and (coalesce(m.expires_at_override, v.expires_at) is null
          or coalesce(m.expires_at_override, v.expires_at) > now())
      group by m.memory_key, m.scope, m.project_id, m.task_id, m.memory_type
      having count(*) > 1
      order by count(*) desc, m.memory_key limit ${Math.min(limit, 200)}`.execute(this.db)).rows;
    return rows.map((row) => ({ memory_key: row.memory_key, ids: row.ids }));
  }

  /** 0164/0167 整理：按类型与各自陈旧窗口标记，不删除、不改正文。 */
  async markMemoriesStale(workspaceId: string, memoryType: string, olderThan: Date,
    limit: number): Promise<number> {
    const result = await sql`update memory_items set stale_at = now(), revision = revision + 1,
      updated_at = now()
      where id in (
        select m.id from memory_items m join memory_versions v
          on v.memory_id = m.id and v.version = m.current_version
        where m.workspace_id = ${workspaceId} and m.status = 'ACTIVE'
          and m.superseded_by_id is null and m.pinned = false and m.stale_at is null
          and m.memory_type = ${memoryType}
          and coalesce(m.verified_at, m.updated_at) < ${olderThan}
          and (coalesce(m.expires_at_override, v.expires_at) is null
          or coalesce(m.expires_at_override, v.expires_at) > now())
        order by coalesce(m.verified_at, m.updated_at) asc, m.id
        limit ${Math.min(limit, 500)}
      )`.execute(this.db);
    return Number(result.numAffectedRows ?? 0n);
  }

  /** 0164 索引回填：旧行没有 token，按批量返回正文由应用层重新分词。 */
  async listUnindexedMemories(workspaceId: string, limit: number): Promise<readonly {
    readonly id: string; readonly title: string; readonly body_text: string;
  }[]> {
    return (await sql<{ id: string; title: string; body_text: string }>`select m.id, m.title,
      v.body_text from memory_items m join memory_versions v
        on v.memory_id = m.id and v.version = m.current_version
      where m.workspace_id = ${workspaceId}
        and m.search_title_tokens = '' and m.search_body_tokens = ''
      order by m.updated_at asc, m.id limit ${Math.min(limit, 200)}`.execute(this.db)).rows;
  }

  /** 0164 真删除前按作用域取 id；只给显式确认的清理入口使用。 */
  async listMemoryIdsForPurge(workspaceId: string, filter: {
    readonly projectId?: string | null; readonly memoryType?: string;
    readonly origin?: string; readonly includeActive?: boolean;
    readonly memoryIds?: readonly string[];
  }): Promise<readonly string[]> {
    const project = filter.projectId === undefined || filter.projectId === null ? sql``
      : sql`and m.project_id = ${filter.projectId}`;
    const type = filter.memoryType === undefined || filter.memoryType === 'ALL' ? sql``
      : sql`and m.memory_type = ${filter.memoryType}`;
    const origin = filter.origin === undefined || filter.origin === 'ALL' ? sql``
      : sql`and m.origin = ${filter.origin}`;
    const ids = filter.memoryIds === undefined || filter.memoryIds.length === 0 ? sql``
      : sql`and m.id = any(${[...filter.memoryIds]}::uuid[])`;
    // 「清理失效项」不能只看 status：过期、被替代、可能过时都是 ACTIVE 根 + 派生状态。
    // 只有真正当前有效（且未固定）的行才受保护；显式 includeActive 才允许删有效行。
    const active = filter.includeActive === true ? sql`` : sql`and m.pinned = false
      and not (m.status = 'ACTIVE' and m.superseded_by_id is null
        and (coalesce(m.expires_at_override, v.expires_at) is null
          or coalesce(m.expires_at_override, v.expires_at) > now()) and m.stale_at is null)`;
    return (await sql<{ id: string }>`select m.id from memory_items m
      join memory_versions v on v.memory_id = m.id and v.version = m.current_version
      where m.workspace_id = ${workspaceId} ${project} ${type} ${origin} ${ids} ${active}
      order by m.created_at asc, m.id`.execute(this.db)).rows.map((row) => row.id);
  }

  async lastMemoryMaintenanceFinishedAt(workspaceId: string): Promise<Date | null> {
    const row = (await sql<{ at: Date | null }>`select max(finished_at) as at
      from memory_maintenance_runs where workspace_id = ${workspaceId} and status = 'COMPLETED'`
      .execute(this.db)).rows[0];
    return row?.at ?? null;
  }

  async listMemoryExportRows(workspaceId: string, projectId: string | null):
    Promise<readonly (MemoryStateRow & { source_count: number })[]> {
    const project = projectId === null ? sql`` : sql`and (m.project_id is null or m.project_id = ${projectId})`;
    return (await sql<MemoryStateRow & { source_count: number }>`select m.*, v.body_text,
      v.confirmed_by, v.confirmed_at, coalesce(m.expires_at_override, v.expires_at) as expires_at,
      case when m.status <> 'ACTIVE' then 'RETIRED'
        when m.superseded_by_id is not null then 'SUPERSEDED'
        when coalesce(m.expires_at_override, v.expires_at) <= now() then 'EXPIRED'
        when m.stale_at is not null then 'STALE' else 'ACTIVE' end as effective_status,
      (select count(*)::int from memory_message_sources s where s.memory_id = m.id) as source_count
      from memory_items m join memory_versions v
        on v.memory_id = m.id and v.version = m.current_version
      where m.workspace_id = ${workspaceId} ${project}
      order by m.created_at asc, m.id asc`.execute(this.db)).rows;
  }

  /**
   * 0164 真删除：先摘除替代链与自动捕获/来源引用，再删版本与根。
   *
   * 调用方必须已按作用域筛选并显式确认；本方法只执行传入的 id 集合，不接受 WHERE 条件。
   * 返回真正删除的条数，供审计对账。
   */
  async purgeMemories(workspaceId: string, ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    await sql`update memory_items set supersedes_id = null
      where workspace_id = ${workspaceId} and supersedes_id = any(${[...ids]}::uuid[])`.execute(this.db);
    // 删除“新事实”不能复活被它替代的“旧事实”：旧行收口为 RETIRED 并留下原因，
    // 而不是把 superseded_by_id 置空后让它重新变成 ACTIVE。
    await sql`update memory_items set status = 'RETIRED',
      retired_reason = coalesce(retired_reason, 'SUPERSEDED_BY_PURGED'),
      superseded_by_id = null, revision = revision + 1, updated_at = now()
      where workspace_id = ${workspaceId} and superseded_by_id = any(${[...ids]}::uuid[])`.execute(this.db);
    await sql`delete from memory_auto_captures
      where workspace_id = ${workspaceId} and memory_id = any(${[...ids]}::uuid[])`.execute(this.db);
    await sql`delete from memory_message_sources
      where memory_id = any(${[...ids]}::uuid[])`.execute(this.db);
    await sql`delete from memory_versions
      where memory_id = any(${[...ids]}::uuid[])`.execute(this.db);
    const result = await sql`delete from memory_items
      where workspace_id = ${workspaceId} and id = any(${[...ids]}::uuid[])`.execute(this.db);
    return Number(result.numAffectedRows ?? 0n);
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
  async listContextCandidates(workspaceId: string, projectId: string, taskId: string,
    limit: number): Promise<readonly {
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
            -- 作用域必须与本次 Run 一致：工作区级永远可见，项目/任务级只在本项目/本任务可见，
            -- AGENT 级记忆需要显式 Agent 身份，Delegate 上下文无从匹配，因此排除。
            and (m.scope = 'WORKSPACE'
              or (m.scope = 'PROJECT' and m.project_id = ${projectId})
              or (m.scope = 'TASK' and m.task_id = ${taskId}))
            and m.instruction_risk = false
            and (coalesce(m.expires_at_override, v.expires_at) is null
          or coalesce(m.expires_at_override, v.expires_at) > now())
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
