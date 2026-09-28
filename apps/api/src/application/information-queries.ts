import { createHash } from 'node:crypto';
import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type { DecisionRow, DecisionVersionRow, InformationRootRow, KnowledgeVersionRow,
  MemoryVersionRow, RuleRow, RuleVersionRow } from '../infrastructure/database-schema.js';
import { resourceNotFound, invalidCursor, validationFailed } from './domain-error.js';
import { createRepositories } from './unit-of-work.js';
import type { ManagedContentStore } from '../storage/managed-content-store.js';

type Kind = 'knowledge' | 'memory' | 'decision' | 'rule';
type Root = InformationRootRow | DecisionRow | RuleRow;

function base(row: Root) {
  return { id: row.id, project_id: row.project_id, status: row.status,
    revision: row.revision.toString(), current_version: row.current_version.toString(),
    created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString() };
}

function versionDto(kind: Kind, version: unknown): Record<string, unknown> {
  if (kind === 'knowledge') {
    const v = version as KnowledgeVersionRow;
    return { id: v.id, knowledge_id: v.knowledge_id, version: v.version.toString(),
      source_kind: v.source_kind, media_type: v.media_type,
      content_sha256: v.content_sha256.toString('hex'), availability: v.availability,
      excerpt: v.content_text?.slice(0, 240) ?? null, source_refs: v.source_refs,
      created_at: v.created_at.toISOString() };
  }
  if (kind === 'memory') {
    const v = version as MemoryVersionRow;
    return { id: v.id, memory_id: v.memory_id, version: v.version.toString(),
      title: v.title, text: v.body_text, confirmed_by: v.confirmed_by,
      confirmed_at: v.confirmed_at.toISOString(),
      expires_at: v.expires_at?.toISOString() ?? null, created_at: v.created_at.toISOString() };
  }
  if (kind === 'decision') {
    const v = version as DecisionVersionRow;
    return { id: v.id, decision_id: v.decision_id, version: v.version.toString(),
      choice: v.choice, rationale: v.rationale, alternatives: v.alternatives,
      costs: v.costs, created_at: v.created_at.toISOString() };
  }
  const v = version as RuleVersionRow;
  return { rule_id: v.rule_id, version: v.version.toString(), rule_key: v.rule_key,
    statement: v.statement, strength: v.strength, applicability: v.applicability,
    enforcement: v.enforcement, method: v.method, target_spec: v.target_spec,
    created_at: v.created_at.toISOString() };
}

async function dto(db: DbExecutor, kind: Kind, row: Root): Promise<Record<string, unknown>> {
  const v = await createRepositories(db).information.readCurrentVersion<unknown>(kind, row.id);
  if (v === undefined) throw new Error(`${kind} current version missing`);
  if (kind === 'knowledge') return { ...base(row), title: (row as InformationRootRow).title };
  if (kind === 'memory') {
    const m = v as MemoryVersionRow;
    return { ...base(row), title: (row as InformationRootRow).title, text: m.body_text,
      confirmed_by: m.confirmed_by, confirmed_at: m.confirmed_at.toISOString(),
      expires_at: m.expires_at?.toISOString() ?? null };
  }
  if (kind === 'decision') {
    const d = v as DecisionVersionRow;
    return { ...base(row), title: (row as InformationRootRow).title, choice: d.choice, rationale: d.rationale,
      alternatives: d.alternatives, costs: d.costs,
      superseded_by_id: (row as DecisionRow).superseded_by_id };
  }
  const rule = row as RuleRow;
  const rv = v as RuleVersionRow;
  return { ...base(row), scope: rule.scope,
    scope_id: rule.scope === 'WORKSPACE' ? rule.workspace_id : rule.scope === 'PROJECT'
      ? rule.project_id : rule.task_id, task_id: rule.task_id,
    ...versionDto('rule', rv), current_version: rule.current_version.toString(),
    created_at: rule.created_at.toISOString() };
}

async function requireProjectFilter(db: DbExecutor, workspaceId: string,
  projectId?: string): Promise<void> {
  if (projectId === undefined) return;
  if ((await createRepositories(db).projects.readProject(projectId))?.workspace_id !== workspaceId) {
    throw resourceNotFound('Project');
  }
}

export async function listInformation(db: DbExecutor, kind: Kind, workspaceId: string,
  projectId?: string): Promise<readonly Record<string, unknown>[]> {
  const repo = createRepositories(db).information;
  await requireProjectFilter(db, workspaceId, projectId);
  const rows = await repo.listRoots<Root>(kind, workspaceId, projectId);
  return Promise.all(rows.map((row) => dto(db, kind, row)));
}

export async function readInformation(db: DbExecutor, kind: Kind, workspaceId: string,
  id: string): Promise<Record<string, unknown>> {
  const row = await createRepositories(db).information.readRoot<Root>(kind, id);
  if (row?.workspace_id !== workspaceId) throw resourceNotFound(kind);
  return dto(db, kind, row);
}

export async function listInformationVersions(db: DbExecutor, kind: Kind,
  workspaceId: string, id: string): Promise<readonly Record<string, unknown>[]> {
  const repo = createRepositories(db).information;
  const row = await repo.readRoot<Root>(kind, id);
  if (row?.workspace_id !== workspaceId) throw resourceNotFound(kind);
  const versions = await repo.listVersions<unknown>(kind, id);
  return versions.map((version) => versionDto(kind, version));
}

export interface KnowledgeVersionContentDto {
  readonly knowledge_id: string;
  readonly title: string;
  readonly project_id: string | null;
  readonly current_version: string;
  readonly id: string;
  readonly version: string;
  readonly source_kind: KnowledgeVersionRow['source_kind'];
  readonly media_type: string;
  readonly content_sha256: string;
  readonly availability: KnowledgeVersionRow['availability'];
  readonly source_refs: KnowledgeVersionRow['source_refs'];
  readonly source_uri: string | null;
  readonly created_at: string;
  readonly content_status: 'FULL' | 'PARTIAL' | 'UNAVAILABLE' | 'UNSUPPORTED' | 'READ_FAILED';
  readonly content: string | null;
}

/** 只读取所指版本；受管内容失效时返回状态，不以当前版本或外部网页补齐。 */
export async function readKnowledgeVersionContent(db: DbExecutor, storage: ManagedContentStore,
  workspaceId: string, knowledgeId: string, versionText: string): Promise<KnowledgeVersionContentDto> {
  if (!/^[1-9][0-9]{0,18}$/u.test(versionText) || BigInt(versionText) > 9223372036854775807n) {
    throw validationFailed([{ field: 'version', message: 'expected positive PostgreSQL bigint' }]);
  }
  const repo = createRepositories(db);
  const root = await repo.information.readRoot<InformationRootRow>('knowledge', knowledgeId);
  if (root?.workspace_id !== workspaceId || root.project_id !== null &&
      (await repo.projects.readProject(root.project_id))?.workspace_id !== workspaceId) {
    throw resourceNotFound('knowledge');
  }
  const version = await repo.information.readVersion<KnowledgeVersionRow>(
    'knowledge', knowledgeId, BigInt(versionText));
  if (version === undefined) throw resourceNotFound('KnowledgeVersion');
  const artifactVersion = version.source_kind === 'ARTIFACT_VERSION' &&
    version.artifact_version_id !== null ?
      await repo.artifacts.readArtifactVersion(version.artifact_version_id) : undefined;
  const artifact = artifactVersion === undefined ? undefined :
    await repo.artifacts.readArtifact(artifactVersion.artifact_id);
  if (version.source_kind === 'ARTIFACT_VERSION' && artifact !== undefined &&
      (artifact.workspace_id !== workspaceId || artifact.project_id !== root.project_id)) {
    throw resourceNotFound('KnowledgeVersion');
  }
  const summary = {
    knowledge_id: root.id, title: root.title, project_id: root.project_id,
    current_version: root.current_version.toString(), id: version.id,
    version: version.version.toString(), source_kind: version.source_kind,
    media_type: version.media_type, content_sha256: version.content_sha256.toString('hex'),
    availability: version.availability, source_refs: version.source_refs,
    source_uri: version.source_uri, created_at: version.created_at.toISOString(),
  };
  const result = (content_status: KnowledgeVersionContentDto['content_status'], content: string | null)
    : KnowledgeVersionContentDto => ({ ...summary, content_status, content });
  if (version.availability !== 'AVAILABLE') return result('UNAVAILABLE', null);
  if (version.media_type !== 'text/plain' && version.media_type !== 'text/markdown') {
    return result('UNSUPPORTED', null);
  }
  if (version.source_kind === 'ARTIFACT_VERSION') {
    if (artifact === undefined || artifactVersion === undefined ||
        artifactVersion.content_hash.toString('hex') !== summary.content_sha256 ||
        artifactVersion.media_type !== version.media_type) return result('UNAVAILABLE', null);
    const read = await storage.readWithHashCheck(artifactVersion.storage_ref,
      { contentHash: artifactVersion.content_hash, size: artifactVersion.size });
    if (read.status !== 'OK') return result(read.status === 'MISSING' ? 'UNAVAILABLE' : 'READ_FAILED', null);
    return result('FULL', read.content.toString('utf8'));
  }
  if (version.content_text !== null) {
    const actualHash = createHash('sha256').update(version.content_text, 'utf8').digest();
    return actualHash.equals(version.content_sha256)
      ? result('FULL', version.content_text) : result('READ_FAILED', null);
  }
  return result('UNAVAILABLE', null);
}

type SearchType = 'KNOWLEDGE' | 'MEMORY' | 'DECISION' | 'RULE';
const TYPES: readonly SearchType[] = ['KNOWLEDGE', 'MEMORY', 'DECISION', 'RULE'];
type SearchRow = { type: SearchType; id: string; version: bigint; title: string;
  body: string; status: string; project_id: string | null; updated_at: Date;
  updated_at_sort: string; rank: number };
export interface SearchInput {
  workspaceId: string; query: string; projectId?: string;
  types?: string; limit?: number; cursor?: string;
}

/** 有界字面搜索；通配符被转义，固定类型/ID 排序与过滤条件绑定游标。 */
export async function searchInformation(db: DbExecutor, input: SearchInput) {
  await requireProjectFilter(db, input.workspaceId, input.projectId);
  const query = input.query.trim();
  if (!query || query.length > 200) {
    throw validationFailed([{ field: 'q', message: 'must be 1..200 characters' }]);
  }
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw validationFailed([{ field: 'limit', message: 'must be 1..50' }]);
  }
  const types = input.types === undefined ? [...TYPES] : input.types.split(',') as SearchType[];
  if (types.length === 0 || types.some((type) => !TYPES.includes(type)) ||
      new Set(types).size !== types.length) {
    throw validationFailed([{ field: 'types', message: 'invalid type list' }]);
  }
  const filter = JSON.stringify({ q: query, project_id: input.projectId ?? null, types: [...types].sort() });
  const after = input.cursor === undefined ? null : decodeSearchCursor(input.cursor, filter);
  const pattern = `%${query.replace(/[\\%_]/gu, '\\$&')}%`;
  const scope = input.projectId === undefined ? sql`` :
    sql`and (project_id is null or project_id = ${input.projectId})`;
  const result = await sql<SearchRow>`
    with records as (
      select 'KNOWLEDGE'::text as type, k.id, k.current_version as version, k.title,
        coalesce(v.content_text, '') as body, k.status, k.project_id, k.updated_at
      from knowledge_items k join knowledge_versions v
        on v.knowledge_id = k.id and v.version = k.current_version
      where k.workspace_id = ${input.workspaceId} and k.status = 'ACTIVE'
      union all
      select 'MEMORY', m.id, m.current_version, m.title, v.body_text, m.status, m.project_id,
        m.updated_at
      from memory_items m join memory_versions v
        on v.memory_id = m.id and v.version = m.current_version
      where m.workspace_id = ${input.workspaceId} and m.status = 'ACTIVE'
        and (v.expires_at is null or v.expires_at > now())
      union all
      select 'DECISION', d.id, d.current_version, d.title,
        v.choice || ' ' || v.rationale, d.status, d.project_id, d.updated_at
      from decisions d join decision_versions v
        on v.decision_id = d.id and v.version = d.current_version
      where d.workspace_id = ${input.workspaceId} and d.status = 'ACTIVE'
      union all
      select 'RULE', r.id, r.current_version, v.rule_key,
        v.statement, r.status, r.project_id, r.updated_at
      from rules r join rule_versions v
        on v.rule_id = r.id and v.version = r.current_version
      where r.workspace_id = ${input.workspaceId} and r.status = 'ACTIVE'
    ), matches as (
      select *, case when lower(title) = lower(${query}) then 0
        when title ilike ${pattern} escape '\\' then 1 else 2 end as rank
      from records where type in (${sql.join(types)}) ${scope}
        and (title ilike ${pattern} escape '\\' or body ilike ${pattern} escape '\\')
    ) select *, updated_at::text as updated_at_sort from matches
      ${after === null ? sql`` : sql`where rank > ${after.rank}
        or (rank = ${after.rank} and updated_at < ${after.updatedAt})
        or (rank = ${after.rank} and updated_at = ${after.updatedAt} and id < ${after.id})
        or (rank = ${after.rank} and updated_at = ${after.updatedAt} and id = ${after.id}
          and type > ${after.type})`}
    order by rank, updated_at desc, id desc, type limit ${limit + 1}`.execute(db);
  const page = result.rows.slice(0, limit);
  return { items: page.map((row) => ({ type: row.type, id: row.id,
    version: row.version.toString(), title: row.title,
    snippet: snippet(row.body, query, row.title),
    matched_fields: [row.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()) ? 'title' : 'text'],
    source_ref: `${row.type.toLowerCase()}:${row.id}:v${row.version}`,
    status: row.status, project_id: row.project_id })),
    next_cursor: result.rows.length > limit && page.length > 0 ?
      Buffer.from(JSON.stringify({ filter, type: page.at(-1)?.type, id: page.at(-1)?.id,
        rank: page.at(-1)?.rank, updated_at: page.at(-1)?.updated_at_sort }), 'utf8')
        .toString('base64url') : null };
}

function snippet(body: string, query: string, title: string): string {
  const index = body.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  return index < 0 ? title.slice(0, 160) : body.slice(Math.max(0, index - 40), index + 120);
}

function decodeSearchCursor(raw: string, filter: string): {
  type: SearchType; id: string; rank: number; updatedAt: string;
} {
  if (raw.length > 1000) throw invalidCursor('cursor', '游标过长。');
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (parsed.filter !== filter || !TYPES.includes(parsed.type as SearchType) ||
        typeof parsed.id !== 'string' || !/^[0-9a-f-]{36}$/iu.test(parsed.id) ||
        !Number.isInteger(parsed.rank) || typeof parsed.updated_at !== 'string') {
      throw new Error('mismatch');
    }
    const updatedAt = parsed.updated_at;
    if (updatedAt.length > 60 || !Number.isFinite(new Date(updatedAt).getTime())) {
      throw new Error('timestamp');
    }
    return { type: parsed.type as SearchType, id: parsed.id, rank: parsed.rank as number,
      updatedAt };
  } catch {
    throw invalidCursor('cursor', '游标不可解析或与当前过滤条件不一致。');
  }
}
