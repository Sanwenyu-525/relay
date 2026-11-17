import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type { Repositories } from './unit-of-work.js';
import {
  computeMemoryConfidence, containsInstructionOverride, detectSensitiveContent, memoryBodyTokens,
  memoryContentHash,
  memoryOverlap, memoryTitleTokens, MEMORY_NEAR_DUPLICATE_THRESHOLD, memoryTrustRank,
  normalizeMemoryKey, normalizeMemoryText, parseMemoryType, type MemoryOrigin,
  type MemoryScope, type MemorySourceKind, type MemoryType, type MemoryVerification,
} from './memory-model.js';
import type { MemoryStateRow } from '../information/information-repository.js';

/** 写入前的候选：所有字段已是校验后的确定值。 */
export interface PreparedMemoryCandidate {
  readonly workspaceId: string;
  readonly projectId: string | null;
  readonly taskId: string | null;
  readonly agentId: string | null;
  readonly scope: MemoryScope;
  readonly memoryType: MemoryType;
  readonly memoryKey: string | null;
  readonly keyInvalid: boolean;
  readonly title: string;
  readonly text: string;
  readonly origin: MemoryOrigin;
  readonly sourceKind: MemorySourceKind;
  readonly importance: number;
  readonly verification: MemoryVerification;
  readonly confidence: number;
  readonly expiresAt: Date | null;
  readonly pinned: boolean;
  readonly contentHash: string;
  readonly titleTokens: string;
  readonly bodyTokens: string;
  readonly sensitiveKinds: readonly string[];
  readonly instructionOverride: boolean;
}

export interface MemoryVersionInput {
  readonly version: number;
  readonly title: string;
  readonly text: string;
  readonly confirmedBy: string;
  readonly confirmedAt?: Date | null;
  readonly expiresAt?: Date | null;
}

export interface MemoryWriteInput {
  readonly workspaceId: string;
  readonly projectId: string | null;
  readonly taskId?: string | null;
  readonly agentId?: string | null;
  readonly scope?: MemoryScope;
  readonly memoryType?: MemoryType | string;
  readonly memoryKey?: string | null;
  readonly title: string;
  readonly text: string;
  readonly origin: MemoryOrigin;
  readonly sourceKind: MemorySourceKind;
  readonly importance?: number;
  readonly verification?: MemoryVerification;
  readonly expiresAt?: Date | null;
  readonly pinned?: boolean;
  /** 导入：已有版本的完整回放；缺省时只写当前版本 v1。 */
  readonly versions?: readonly MemoryVersionInput[];
  /** 导入：保留导出时的可信度（只在 0–100 内取值，不改变验证状态）。 */
  readonly confidenceOverride?: number;
  /** 导入：保留原验证时间；缺省按验证状态生成。 */
  readonly verifiedAt?: Date | null;
}

export type MemoryWriteOutcome =
  | { readonly kind: 'CREATED'; readonly memoryId: string }
  | { readonly kind: 'SUPERSEDED'; readonly memoryId: string; readonly replacedId: string }
  | { readonly kind: 'DUPLICATE'; readonly existingId: string; readonly similarity: number }
  | { readonly kind: 'CONFLICT'; readonly existingId: string;
    readonly reason: 'KEY_TRUST' | 'KEY_VERIFIED' | 'KEY_PINNED' }
  | { readonly kind: 'REJECTED_SENSITIVE'; readonly kinds: readonly string[] };

export function resolveMemoryScope(input: {
  projectId: string | null; taskId?: string | null; agentId?: string | null;
  scope?: MemoryScope;
}): MemoryScope {
  if (input.scope !== undefined) return input.scope;
  if (input.agentId !== undefined && input.agentId !== null) return 'AGENT';
  if (input.taskId !== undefined && input.taskId !== null) return 'TASK';
  if (input.projectId !== null) return 'PROJECT';
  return 'WORKSPACE';
}

/**
 * 候选归一化：不改写用户的正文，只做去重/索引/可信度所需的确定性派生。
 *
 * 关键点：
 * - 类型非法 → UNKNOWN，不猜；
 * - 结构化键非法 → key=null 且 `keyInvalid=true`，人工入口可以报错，自动入口忽略；
 * - 自动经验默认 UNVERIFIED；只有调用方显式传 VERIFIED 才会写成已验证；
 * - 敏感信息不在这里抛异常：自动入口要静默跳过，人工入口由命令层给出可读错误。
 */
export function prepareMemoryCandidate(input: MemoryWriteInput): PreparedMemoryCandidate {
  const title = input.title.trim();
  const text = input.text.trim();
  const scope = resolveMemoryScope(input);
  const memoryType = parseMemoryType(input.memoryType);
  const rawKey = input.memoryKey ?? null;
  const memoryKey = normalizeMemoryKey(rawKey);
  const keyInvalid = rawKey !== null && rawKey.trim() !== '' && memoryKey === null;
  const origin = input.origin;
  const sourceKind = input.sourceKind;
  const verification: MemoryVerification = input.verification
    ?? (origin === 'HUMAN_CONFIRMED' ? 'VERIFIED' : 'UNVERIFIED');
  const confidence = input.confidenceOverride === undefined
    ? computeMemoryConfidence({ origin, sourceKind, verification })
    : Math.min(Math.max(Math.round(input.confidenceOverride), 0), 100);
  const importance = Math.min(Math.max(Math.round(input.importance ?? 3), 1), 5);
  const contentHash = memoryContentHash(title, text);
  const titleTokens = memoryTitleTokens(title).join(' ');
  const bodyTokens = memoryBodyTokens(text).join(' ');
  const sensitive = detectSensitiveContent(`${title}\n${text}`);
  return {
    workspaceId: input.workspaceId, projectId: input.projectId,
    taskId: input.taskId ?? null, agentId: input.agentId ?? null,
    scope, memoryType, memoryKey, keyInvalid, title, text, origin, sourceKind,
    importance, verification, confidence, expiresAt: input.expiresAt ?? null,
    pinned: input.pinned ?? false, contentHash, titleTokens, bodyTokens,
    sensitiveKinds: sensitive.map((item) => item.kind),
    instructionOverride: containsInstructionOverride(`${title}\n${text}`),
  };
}

function sameText(existing: MemoryStateRow, candidate: PreparedMemoryCandidate): boolean {
  return normalizeMemoryText(existing.title) === normalizeMemoryText(candidate.title)
    && normalizeMemoryText(existing.body_text) === normalizeMemoryText(candidate.text);
}

function existingTokens(existing: MemoryStateRow): readonly string[] {
  if (existing.search_title_tokens !== '' || existing.search_body_tokens !== '') {
    return `${existing.search_title_tokens} ${existing.search_body_tokens}`.split(' ').filter(Boolean);
  }
  return memoryBodyTokens(`${existing.title} ${existing.body_text}`);
}

export type MemoryWriteDecision =
  | { readonly kind: 'CREATE' }
  | { readonly kind: 'SUPERSEDE'; readonly existingId: string }
  | { readonly kind: 'DUPLICATE'; readonly existingId: string; readonly similarity: number }
  | { readonly kind: 'CONFLICT'; readonly existingId: string;
    readonly reason: 'KEY_TRUST' | 'KEY_VERIFIED' | 'KEY_PINNED' };

/**
 * 写前裁决（纯函数）：
 * 1. 同作用域同内容 → 重复，不再写第二份；
 * 2. 同结构化键且内容不同 → 新事实替代旧事实；但低可信来源不能顶掉高可信/已验证/固定事实；
 * 3. 没有键时，仅在 token 重叠 ≥ 0.8 时判近似重复，避免语义相近但事实不同的条目被合并。
 *
 * `force` 只给人工显式保存/导入使用：用户确认过一次修订，可信度高于自动观察。
 */
export function decideMemoryWrite(candidates: readonly MemoryStateRow[],
  candidate: PreparedMemoryCandidate, force: boolean): MemoryWriteDecision {
  const byHash = candidates.find((row) => row.content_hash === candidate.contentHash
    || sameText(row, candidate));
  if (byHash !== undefined) {
    return { kind: 'DUPLICATE', existingId: byHash.id, similarity: 1 };
  }
  const byKey = candidate.memoryKey === null ? undefined
    : candidates.filter((row) => row.memory_key === candidate.memoryKey)
      .sort((left, right) => right.updated_at.getTime() - left.updated_at.getTime())[0];
  if (byKey !== undefined) {
    if (force) return { kind: 'SUPERSEDE', existingId: byKey.id };
    // 固定记忆是用户明确要求每轮常驻的约束；自动观察不能顶掉它，哪怕置信度更高。
    // 用户显式保存/导入（force）仍然可以替代，权限来自用户而不是模型。
    if (byKey.pinned) {
      return { kind: 'CONFLICT', existingId: byKey.id, reason: 'KEY_PINNED' };
    }
    if (byKey.verification === 'VERIFIED' && candidate.verification !== 'VERIFIED') {
      return { kind: 'CONFLICT', existingId: byKey.id, reason: 'KEY_VERIFIED' };
    }
    const existingTrust = memoryTrustRank(byKey.origin, byKey.source_kind);
    const candidateTrust = memoryTrustRank(candidate.origin, candidate.sourceKind);
    if (candidateTrust > existingTrust ||
        (candidateTrust === existingTrust && candidate.confidence >= byKey.confidence)) {
      return { kind: 'SUPERSEDE', existingId: byKey.id };
    }
    return { kind: 'CONFLICT', existingId: byKey.id, reason: 'KEY_TRUST' };
  }
  let best: { id: string; score: number } | null = null;
  const candidateTokens = `${candidate.titleTokens} ${candidate.bodyTokens}`.split(' ').filter(Boolean);
  for (const row of candidates) {
    if (row.memory_type !== candidate.memoryType) continue;
    const score = memoryOverlap(candidateTokens, existingTokens(row));
    if (score >= MEMORY_NEAR_DUPLICATE_THRESHOLD && (best === null || score > best.score)) {
      best = { id: row.id, score };
    }
  }
  if (best !== null) return { kind: 'DUPLICATE', existingId: best.id, similarity: best.score };
  return { kind: 'CREATE' };
}

/** 写入结果与来源绑定；调用方负责把 capture/审计记录放进同一事务。 */
export async function createMemoryRecord(db: DbExecutor, r: Repositories, input: MemoryWriteInput & {
  readonly commandId: string | null;
  readonly actorRef: string;
  readonly source?: { readonly sessionId: string; readonly messageId: string;
    readonly contentSha256: string };
  readonly force?: boolean;
  readonly suppressActivity?: boolean;
}): Promise<MemoryWriteOutcome> {
  const candidate = prepareMemoryCandidate(input);
  if (candidate.sensitiveKinds.length > 0) {
    return { kind: 'REJECTED_SENSITIVE', kinds: candidate.sensitiveKinds };
  }
  if (candidate.title === '' || candidate.text === '') {
    throw new Error('MEMORY_EMPTY');
  }
  // 同一作用域+键的并发写入串行化：先拿事务级 advisory lock，再读候选并裁决。
  const lockKey = `${input.workspaceId}:${candidate.scope}:${candidate.projectId ?? ''}:${candidate.taskId ?? ''}:${candidate.memoryKey ?? candidate.contentHash}`;
  // 锁必须走 r 绑定的事务连接；在池上另开一条连接会在语句结束后立刻释放，挡不住并发。
  await r.information.lockMemoryWrite(lockKey);
  const candidates = await r.information.listMemoryWriteCandidates(input.workspaceId, {
    projectId: candidate.projectId, taskId: candidate.taskId,
    memoryType: candidate.memoryType, memoryKey: candidate.memoryKey,
    contentHash: candidate.contentHash,
  });
  const decision = decideMemoryWrite(candidates, candidate, input.force ?? false);
  if (decision.kind === 'DUPLICATE') {
    return { kind: 'DUPLICATE', existingId: decision.existingId, similarity: decision.similarity };
  }
  if (decision.kind === 'CONFLICT') {
    return { kind: 'CONFLICT', existingId: decision.existingId, reason: decision.reason };
  }
  const memoryId = randomUUID();
  await r.information.insertMemoryRoot({
    id: memoryId, workspaceId: candidate.workspaceId, projectId: candidate.projectId,
    title: candidate.title, sourceKind: candidate.sourceKind, origin: candidate.origin,
    memoryType: candidate.memoryType, scope: candidate.scope,
    taskId: candidate.taskId, agentId: candidate.agentId,
    memoryKey: candidate.memoryKey, importance: candidate.importance,
    confidence: candidate.confidence, verification: candidate.verification,
    verifiedAt: input.verifiedAt ?? (candidate.verification === 'VERIFIED' ? new Date() : null),
    pinned: candidate.pinned,
    supersedesId: decision.kind === 'SUPERSEDE' ? decision.existingId : null,
    contentHash: candidate.contentHash,
    searchTitleTokens: candidate.titleTokens, searchBodyTokens: candidate.bodyTokens,
    instructionRisk: candidate.instructionOverride,
  });
  const versions = input.versions !== undefined && input.versions.length > 0
    ? input.versions
    : [{ version: 1, title: candidate.title, text: candidate.text,
      confirmedBy: input.actorRef, expiresAt: candidate.expiresAt }];
  let current = 1n;
  for (const version of versions) {
    current = BigInt(version.version);
    await r.information.insertMemoryVersion({ id: randomUUID(), memoryId, version: current,
      title: version.title.trim(), text: version.text.trim(), confirmedBy: version.confirmedBy,
      expiresAt: version.expiresAt ?? null,
      ...(version.confirmedAt === undefined ? {} : { confirmedAt: version.confirmedAt }) });
  }
  // 根表的 title/current_version 对齐到最后一条版本；历史版本仍保留在 memory_versions。
  if (current !== 1n) await r.information.setMemoryCurrentVersion(memoryId, current, candidate.title);
  if (input.source !== undefined) {
    await r.information.insertMemoryMessageSource({ memoryId,
      sessionId: input.source.sessionId, messageId: input.source.messageId,
      contentSha256: input.source.contentSha256 });
  }
  if (decision.kind === 'SUPERSEDE') {
    await r.information.supersedeMemory(decision.existingId, memoryId, 'SUPERSEDED_BY_NEW_FACT');
  }
  if (input.suppressActivity !== true) {
    await r.activities.insertActivityRecord({ id: randomUUID(), workspaceId: candidate.workspaceId,
      actorKind: candidate.origin === 'HUMAN_CONFIRMED' ? 'HUMAN' : 'AI',
      actorRef: input.actorRef, commandId: input.commandId,
      projectId: candidate.projectId, taskId: candidate.taskId,
      eventType: decision.kind === 'SUPERSEDE' ? 'MEMORY_SUPERSEDED' : 'MEMORY_SAVED',
      factRefs: { memory_id: memoryId, memory_type: candidate.memoryType,
        scope: candidate.scope, ...(decision.kind === 'SUPERSEDE'
          ? { superseded_id: decision.existingId } : {}) } });
  }
  await r.workspaces.bumpContextRevision(candidate.workspaceId);
  return decision.kind === 'SUPERSEDE'
    ? { kind: 'SUPERSEDED', memoryId, replacedId: decision.existingId }
    : { kind: 'CREATED', memoryId };
}
