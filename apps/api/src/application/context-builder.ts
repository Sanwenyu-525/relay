import { createHash } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import type { DecisionRow, DecisionVersionRow, InformationRootRow, KnowledgeVersionRow,
  MemoryVersionRow, RunRow, TaskRow } from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import { canonicalizeJson } from '../receipt/payload-hash.js';
import type { ManagedContentStore } from '../storage/managed-content-store.js';
import { toDecimalString } from '../shared/decimal.js';
import type { ContextCorrectionInput, FakeScenario } from '../workflow/context-fixture.js';
import { DEFAULT_FAKE_SCENARIO } from '../workflow/context-fixture.js';
import { searchInformation } from './information-queries.js';
import { createRepositories } from './unit-of-work.js';

export const CONTEXT_BUILDER_VERSION = 'context-builder-v1';
export const CONTEXT_TEMPLATE_VERSION = 'markdown-draft-v1';
export const CONTEXT_PROFILE_ID = 'run-default';
export const CONTEXT_PROFILE_VERSION = '1';
const DEFAULT_LIMIT = 8192;
const RESERVED_TOKENS = 1536;
const MAX_RELEVANT = 10;
const MAX_FALLBACK = 3;
const MAX_FRAGMENT_CHARS = 1600;

const profileDefinition: JsonObject = { id: CONTEXT_PROFILE_ID, version: CONTEXT_PROFILE_VERSION,
  required: ['CONTRACT', 'TASK', 'PROJECT', 'RUN'],
  optional: ['KNOWLEDGE', 'MEMORY', 'DECISION'], max_relevant: MAX_RELEVANT,
  max_recent_fallback: MAX_FALLBACK };
const profileDigest = hash(canonicalizeJson(profileDefinition));

export interface ContextSource extends JsonObject {
  kind: string;
  source_ref: string;
  version: string;
  /** Hash of the exact fragment sent to ModelPort. */
  sha256: string;
  /** Hash of the immutable full source, before range selection. */
  source_sha256: string;
  range: { start: number; end: number; unit: 'UTF8_BYTE' };
  content: string;
  role: 'MANDATORY' | 'RELEVANT' | 'STEP_SPECIFIC';
  trust: 'CANONICAL' | 'UNTRUSTED_DATA';
  selection_reason?: 'TITLE_MATCH' | 'RECENT_SCOPE_FALLBACK';
}

export type BuiltContext = { readonly kind: 'READY'; readonly builderVersion: string;
  readonly payload: JsonObject; readonly manifestHash: Buffer;
  readonly contextRevision: string; readonly authorityRevision: string;
  readonly projectRevision: string; readonly taskRevision: string } |
  { readonly kind: 'FAILED'; readonly reason: 'CONTEXT_REQUIRED_OVER_BUDGET' |
    'CONTEXT_REQUIRED_SOURCE_UNAVAILABLE'; readonly evidence: JsonObject };

export async function buildRunContext(db: DbExecutor, input: { readonly run: RunRow;
  readonly task: TaskRow; readonly storage: ManagedContentStore;
  readonly fakeScenario?: FakeScenario; readonly correction?: ContextCorrectionInput;
  readonly budgetTokens?: number }): Promise<BuiltContext> {
  const r = createRepositories(db);
  const contract = await r.runs.readContract(input.run.id);
  const project = input.task.project_id === null ? undefined :
    await r.projects.readProject(input.task.project_id);
  const authority = await r.workspaces.readAuthority(input.run.workspace_id);
  if (contract === undefined || project === undefined || authority === undefined ||
      project.workspace_id !== input.run.workspace_id) {
    return { kind: 'FAILED', reason: 'CONTEXT_REQUIRED_SOURCE_UNAVAILABLE',
      evidence: { reason: 'CONTEXT_REQUIRED_SOURCE_UNAVAILABLE' } };
  }
  const limit = input.budgetTokens ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100_000) {
    throw new Error('context budget must be an integer in 1..100000');
  }
  const contractContent = canonicalizeJson(contract.frozen_snapshot);
  const required: ContextSource[] = [
    source('CONTRACT', `run:${input.run.id}:contract`, contract.contract_hash.toString('hex'),
      contractContent, 'MANDATORY', 'CANONICAL'),
    source('PROJECT', `project:${project.id}`, toDecimalString(project.revision),
      canonicalizeJson({ id: project.id, title: project.title, type: project.project_type }),
      'MANDATORY', 'CANONICAL'),
    source('TASK', `task:${input.task.id}`, toDecimalString(input.task.acceptance_revision),
      canonicalizeJson({ id: input.task.id, title: input.task.title,
        acceptance_revision: toDecimalString(input.task.acceptance_revision) }),
      'MANDATORY', 'CANONICAL'),
    source('RUN', `run:${input.run.id}`, toDecimalString(input.run.ownership_epoch),
      canonicalizeJson({ id: input.run.id, task_id: input.task.id,
        ownership_epoch: toDecimalString(input.run.ownership_epoch) }),
      'MANDATORY', 'CANONICAL'),
  ];
  if (input.correction !== undefined) {
    required.push(source('CORRECTION', `run:${input.run.id}:correction:${input.correction.round}`,
      String(input.correction.round), canonicalizeJson(input.correction as unknown as JsonObject),
      'STEP_SPECIFIC', 'CANONICAL'));
  }
  const dependencies: JsonObject = {
    contract_hash: contract.contract_hash.toString('hex'),
    workflow_version: String((contract.frozen_snapshot.workflow as JsonObject | undefined)?.version ?? ''),
    execution_config_version: String(contract.frozen_snapshot.execution_config_version ?? ''),
    rule_revision: String(contract.frozen_snapshot.rule_revision ?? '0'),
    context_revision: toDecimalString(authority.context_revision),
    authority_revision: toDecimalString(authority.revision),
    project_revision: toDecimalString(project.revision),
    task_revision: toDecimalString(input.task.revision),
    profile: { id: CONTEXT_PROFILE_ID, version: CONTEXT_PROFILE_VERSION, digest: profileDigest },
    skill: null,
  };
  const base: JsonObject = { builder_version: CONTEXT_BUILDER_VERSION,
    template_version: CONTEXT_TEMPLATE_VERSION,
    task: { id: input.task.id, title: input.task.title },
    project: { id: project.id, title: project.title, type: project.project_type },
    run: { id: input.run.id, ownership_epoch: toDecimalString(input.run.ownership_epoch) },
    contract: contract.frozen_snapshot, dependencies,
    fake_scenario: input.fakeScenario ?? DEFAULT_FAKE_SCENARIO,
    ...(input.correction === undefined ? {} : { correction: input.correction as unknown as JsonObject }),
  };
  const budgetSkeleton: JsonObject = { limit_tokens: limit, reserved_tokens: RESERVED_TOKENS,
    required_tokens: 0, selected_tokens: 0, estimation: 'ESTIMATED_UTF8_BYTES_DIV_3' };
  const projected = (sources: readonly ContextSource[], excluded: readonly JsonObject[]) =>
    estimate({ ...base, sources, exclusions: excluded, budget: budgetSkeleton });
  const requiredTokens = projected(required, []);
  if (requiredTokens + RESERVED_TOKENS > limit) {
    return { kind: 'FAILED', reason: 'CONTEXT_REQUIRED_OVER_BUDGET',
      evidence: { reason: 'CONTEXT_REQUIRED_OVER_BUDGET', limit_tokens: limit,
        required_tokens: requiredTokens, reserved_tokens: RESERVED_TOKENS } };
  }

  const selected = [...required];
  const exclusions: JsonObject[] = [];
  const query = input.task.title.trim().slice(0, 12);
  const matches = query ? await searchInformation(db, { workspaceId: input.run.workspace_id,
      projectId: project.id, query, types: 'KNOWLEDGE,MEMORY,DECISION', limit: MAX_RELEVANT })
    : { items: [] };
  const ranked = matches.items.filter((match) => match.type !== 'RULE').map((match) => ({
    type: match.type as 'KNOWLEDGE' | 'MEMORY' | 'DECISION', id: match.id,
    source_ref: match.source_ref, selection_reason: 'TITLE_MATCH' as const }));
  const recent = await r.information.listContextCandidates(input.run.workspace_id, project.id, MAX_FALLBACK);
  const candidates = [...ranked, ...recent.map((entry) => ({ type: entry.kind, id: entry.id,
    source_ref: `${entry.kind.toLowerCase()}:${entry.id}`,
    selection_reason: 'RECENT_SCOPE_FALLBACK' as const }))];
  const seen = new Set<string>();
  for (const match of candidates) {
    if (seen.has(`${match.type}:${match.id}`) || seen.size >= MAX_RELEVANT) continue;
    seen.add(`${match.type}:${match.id}`);
    const optional = await loadRelevant(db, input.storage, input.run.workspace_id,
      project.id, match.type, match.id, query, match.selection_reason);
    if (optional === null) {
      exclusions.push({ source_ref: match.source_ref, reason: 'SOURCE_UNAVAILABLE' });
      continue;
    }
    if (projected([...selected, optional], exclusions) + RESERVED_TOKENS > limit) {
      exclusions.push({ source_ref: optional.source_ref, reason: 'BUDGET_TRIMMED' });
      continue;
    }
    selected.push(optional);
  }
  // Exclusion evidence also consumes budget. Keep the mandatory set intact.
  while (projected(selected, exclusions) + RESERVED_TOKENS > limit && exclusions.length > 0) {
    exclusions.pop();
  }
  const selectedTokens = projected(selected, exclusions);
  const payload: JsonObject = { ...base, sources: selected, exclusions,
    budget: { limit_tokens: limit, reserved_tokens: RESERVED_TOKENS,
      required_tokens: requiredTokens, selected_tokens: selectedTokens,
      estimation: 'ESTIMATED_UTF8_BYTES_DIV_3' } };
  return { kind: 'READY', builderVersion: CONTEXT_BUILDER_VERSION,
    payload, manifestHash: createHash('sha256').update(canonicalizeJson(payload)).digest(),
    contextRevision: toDecimalString(authority.context_revision),
    authorityRevision: toDecimalString(authority.revision),
    projectRevision: toDecimalString(project.revision),
    taskRevision: toDecimalString(input.task.revision) };
}

async function loadRelevant(db: DbExecutor, storage: ManagedContentStore,
  workspaceId: string, projectId: string, kind: 'KNOWLEDGE' | 'MEMORY' | 'DECISION',
  id: string, query: string, selectionReason: 'TITLE_MATCH' | 'RECENT_SCOPE_FALLBACK'):
    Promise<ContextSource | null> {
  const r = createRepositories(db);
  const key = kind.toLowerCase() as 'knowledge' | 'memory' | 'decision';
  const root = await r.information.readRoot<InformationRootRow | DecisionRow>(key, id);
  if (root?.workspace_id !== workspaceId || root.status !== 'ACTIVE' ||
      root.project_id !== null && root.project_id !== projectId) return null;
  const version = await r.information.readCurrentVersion<KnowledgeVersionRow | MemoryVersionRow |
    DecisionVersionRow>(key, id);
  if (version === undefined) return null;
  let content: string;
  let fullHash: string;
  if (kind === 'KNOWLEDGE') {
    const v = version as KnowledgeVersionRow;
    if (v.availability !== 'AVAILABLE') return null;
    fullHash = v.content_sha256.toString('hex');
    if (v.source_kind === 'ARTIFACT_VERSION') {
      const artifact = v.artifact_version_id === null ? undefined :
        await r.artifacts.readArtifactVersion(v.artifact_version_id);
      if (artifact === undefined || artifact.content_hash.toString('hex') !== fullHash) return null;
      const read = await storage.readWithHashCheck(artifact.storage_ref,
        { contentHash: artifact.content_hash, size: artifact.size });
      if (read.status !== 'OK') return null;
      content = read.content.toString('utf8');
    } else {
      if (v.content_text === null || hash(v.content_text) !== fullHash) return null;
      content = v.content_text;
    }
  } else if (kind === 'MEMORY') {
    const v = version as MemoryVersionRow;
    if (v.expires_at !== null && v.expires_at.getTime() <= Date.now()) return null;
    content = v.body_text;
    fullHash = hash(content);
  } else {
    const v = version as DecisionVersionRow;
    content = `${v.choice}\n${v.rationale}`;
    fullHash = hash(content);
  }
  const matchAt = content.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  let startAt = matchAt < 0 ? 0 : Math.max(0, matchAt - 120);
  if (startAt > 0 && isLowSurrogate(content.charCodeAt(startAt)) &&
      isHighSurrogate(content.charCodeAt(startAt - 1))) startAt--;
  let endAt = Math.min(content.length, startAt + MAX_FRAGMENT_CHARS);
  if (endAt < content.length && isLowSurrogate(content.charCodeAt(endAt)) &&
      isHighSurrogate(content.charCodeAt(endAt - 1))) endAt--;
  const queryContent = content.slice(startAt, endAt);
  const startByte = Buffer.byteLength(content.slice(0, startAt), 'utf8');
  return { kind, source_ref: `${kind.toLowerCase()}:${id}:v${version.version}`,
    version: toDecimalString(version.version), sha256: hash(queryContent), source_sha256: fullHash,
    range: { start: startByte, end: startByte + Buffer.byteLength(queryContent, 'utf8'),
      unit: 'UTF8_BYTE' },
    content: queryContent, role: 'RELEVANT', trust: 'UNTRUSTED_DATA',
    selection_reason: selectionReason };
}

function source(kind: string, ref: string, version: string, content: string,
  role: ContextSource['role'], trust: ContextSource['trust']): ContextSource {
  return { kind, source_ref: ref, version, sha256: hash(content), source_sha256: hash(content),
    range: { start: 0, end: Buffer.byteLength(content, 'utf8'), unit: 'UTF8_BYTE' },
    content, role, trust };
}

function hash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function isHighSurrogate(code: number): boolean { return code >= 0xd800 && code <= 0xdbff; }
function isLowSurrogate(code: number): boolean { return code >= 0xdc00 && code <= 0xdfff; }

function estimate(payload: JsonObject): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(canonicalizeJson(payload), 'utf8') / 3));
}
