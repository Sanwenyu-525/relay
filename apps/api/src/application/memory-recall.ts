import { createHash, randomUUID } from 'node:crypto';

import type { AssistSessionRow, MemoryType, MemoryVerification } from '../infrastructure/database-schema.js';
import type { Repositories } from './unit-of-work.js';
import { getRuntimeLogger } from '../infrastructure/runtime-log.js';
import { estimateTokens } from './assist-context-usage.js';
import {
  memoryQueryTokens, memoryTsQuery, memoryTypeHint, type MemoryType as ModelMemoryType,
} from './memory-model.js';
import { MEMORY_DEFAULTS } from './memory-config.js';

/** Bounded literal tokens, including Chinese bigrams; this is not semantic search. */
export function memoryRecallTerms(text: string): readonly string[] {
  return memoryQueryTokens(text);
}

export type MemoryRecallBasis = 'PINNED' | 'LITERAL_MATCH';

export interface RecallMemoryRef {
  readonly kind: 'MEMORY';
  readonly root_id: string;
  readonly version: string;
  readonly selection: 'AUTO_MEMORY';
  readonly selection_basis: MemoryRecallBasis;
  readonly origin: 'HUMAN_CONFIRMED' | 'AUTO_CAPTURE';
  readonly source_kind: 'MANUAL' | 'USER_STATEMENT' | 'MODEL_OBSERVATION' | 'UNKNOWN';
  readonly memory_type: string;
  readonly verification: MemoryVerification;
  readonly pinned: boolean;
  readonly importance: number;
}

interface SelectedMemory {
  readonly id: string;
  readonly current_version: bigint;
  readonly body_text: string;
  readonly origin: 'HUMAN_CONFIRMED' | 'AUTO_CAPTURE';
  readonly source_kind: 'MANUAL' | 'USER_STATEMENT' | 'MODEL_OBSERVATION' | 'UNKNOWN';
  readonly memory_type: string;
  readonly verification: MemoryVerification;
  readonly pinned: boolean;
  readonly importance: number;
  readonly effective_status: string;
}

const DEFAULT_CORE_BUDGET = MEMORY_DEFAULTS.coreTokenBudget;
const DEFAULT_RETRIEVAL_BUDGET = MEMORY_DEFAULTS.retrievalTokenBudget;
const DEFAULT_TOP_K = MEMORY_DEFAULTS.retrievalTopK;

function tokenCost(text: string): number {
  return estimateTokens(Buffer.byteLength(text, 'utf8'));
}

function toRef(memory: SelectedMemory, basis: MemoryRecallBasis): RecallMemoryRef {
  return { kind: 'MEMORY', root_id: memory.id, version: memory.current_version.toString(),
    selection: 'AUTO_MEMORY', selection_basis: basis, origin: memory.origin,
    source_kind: memory.source_kind, memory_type: memory.memory_type,
    verification: memory.verification, pinned: memory.pinned, importance: memory.importance };
}

/**
 * 自动召回（0164）。
 *
 * 顺序固定：作用域过滤在 SQL 里先做 → 固定记忆按常驻预算 → 普通命中按检索预算。
 * 预算用 UTF-8 字节/3 估算（与模型端口同一换算），只裁剪候选，不截断单条正文：
 * 单条超出预算就跳过，保留它自己的来源与验证标记。
 *
 * 任何失败都返回空数组并留一条日志：记忆是辅助输入，不能阻断本轮聊天或 Agent 执行。
 */
export async function recallConfirmedMemoryRefs(r: Repositories, session: AssistSessionRow,
  content: string, excludedIds: ReadonlySet<string>, remaining: number): Promise<readonly RecallMemoryRef[]> {
  if (session.conversation_mode !== 'AGENT' || !session.remember || remaining <= 0) return [];
  const settings = await r.information.readMemorySettings(session.workspace_id);
  if (settings?.recall_enabled === false) return [];
  const coreBudget = settings?.core_token_budget ?? DEFAULT_CORE_BUDGET;
  const retrievalBudget = settings?.retrieval_token_budget ?? DEFAULT_RETRIEVAL_BUDGET;
  const topK = Math.min(settings?.retrieval_top_k ?? DEFAULT_TOP_K, remaining);
  const includeStale = settings?.include_stale_in_recall ?? false;
  const mode = settings?.retrieval_mode ?? 'LITERAL';
  const started = Date.now();
  const terms = memoryRecallTerms(content);
  const tsQuery = memoryTsQuery(terms);
  const hint = memoryTypeHint(content);
  const querySha256 = createHash('sha256').update(content, 'utf8').digest('hex');
  const queryExcerpt = content.replace(/\s+/gu, ' ').trim().slice(0, 120);
  let candidates = 0;
  let degraded: string | null = null;
  try {
    const pinned = await r.information.recallPinnedMemories(session.workspace_id, {
      projectId: session.project_id, taskId: session.task_id, includeStale,
      excludedIds: [...excludedIds], limit: Math.min(remaining, 50) });
    candidates += pinned.length;
    const pinnedIds = new Set(pinned.map((row) => row.id));
    const literal = tsQuery === null ? [] : await r.information.recallMemoriesV2(
      session.workspace_id, {
        terms, tsQuery, key: null, projectId: session.project_id, taskId: session.task_id,
        typeHints: hint.preferred, includeStale, excludePinned: true,
        excludedIds: [...excludedIds, ...pinnedIds], limit: topK,
      });
    candidates += literal.length;
    const selected: RecallMemoryRef[] = [];
    const seen = new Set<string>();
    let coreTokens = 0;
    let retrievalTokens = 0;
    for (const row of pinned) {
      if (row.effective_status !== 'ACTIVE' || row.verification === 'FAILED') continue;
      if (seen.has(row.id) || selected.length >= remaining) continue;
      const cost = tokenCost(row.body_text);
      if (coreTokens + cost > coreBudget) continue;
      coreTokens += cost;
      seen.add(row.id);
      selected.push(toRef(row as SelectedMemory, 'PINNED'));
    }
    for (const row of literal) {
      if (row.effective_status !== 'ACTIVE' && row.effective_status !== 'STALE') continue;
      if (row.verification === 'FAILED') continue;
      if (seen.has(row.id) || selected.length >= remaining) continue;
      const cost = tokenCost(row.body_text);
      if (retrievalTokens + cost > retrievalBudget) continue;
      retrievalTokens += cost;
      seen.add(row.id);
      selected.push(toRef(row as SelectedMemory, 'LITERAL_MATCH'));
    }
    if (mode === 'HYBRID') degraded = 'EMBEDDING_UNAVAILABLE';
    try {
      await r.information.insertMemoryRecallEvent({
        id: randomUUID(), workspaceId: session.workspace_id,        projectId: session.project_id, sessionId: session.id, querySha256, queryExcerpt,
        mode, candidates, selected: selected.length,
        tokens: coreTokens + retrievalTokens, latencyMs: Math.min(Date.now() - started, 60000),
        degraded,
      });
    } catch {
      // 度量写失败不影响本轮召回事实。
    }
    if (selected.length > 0) {
      try { await r.information.touchMemoryAccessed(selected.map((ref) => ref.root_id)); } catch { /* non-blocking */ }
    }
    return selected;
  } catch (error) {
    getRuntimeLogger('memory').warn('memory_recall_degraded', {
      workspace_id: session.workspace_id,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/** 类型提示用于解释召回原因；不参与权限或写入判断。 */
export function explainMemoryTypeHint(query: string): readonly ModelMemoryType[] {
  return memoryTypeHint(query).preferred;
}

export type { MemoryType as RecallMemoryType };
