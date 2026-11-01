import type { AssistSessionRow } from '../infrastructure/database-schema.js';
import type { MemorySourceKind } from '../infrastructure/database-schema.js';
import type { Repositories } from './unit-of-work.js';

/** Bounded literal tokens, including Chinese bigrams; this is not semantic search. */
export function memoryRecallTerms(text: string): readonly string[] {
  const terms = new Set<string>();
  // MEMORY_RECALL_ELIGIBILITY: split script boundaries so 中文PostgreSQL is searchable.
  for (const token of text.slice(0, 500).toLowerCase()
    .match(/\p{Script=Han}+|(?:(?!\p{Script=Han})[\p{L}\p{N}_-]){2,}/gu) ?? []) {
    if (/^[\p{Script=Han}]+$/u.test(token)) {
      for (let i = 0; i < token.length - 1 && terms.size < 24; i++) terms.add(token.slice(i, i + 2));
    } else terms.add(token.slice(0, 60));
    if (terms.size >= 24) break;
  }
  return [...terms].slice(0, 24);
}

export async function recallConfirmedMemoryRefs(r: Repositories, session: AssistSessionRow,
  content: string, excludedIds: ReadonlySet<string>, remaining: number): Promise<readonly {
    kind: 'MEMORY'; root_id: string; version: string; selection: 'AUTO_MEMORY';
    selection_basis: 'LITERAL_MATCH' | 'RECENT_CONFIRMED';
    origin: 'HUMAN_CONFIRMED' | 'AUTO_CAPTURE'; source_kind: MemorySourceKind;
  }[]> {
  if (session.conversation_mode !== 'AGENT' || !session.remember || remaining <= 0) return [];
  const settings = await r.information.readMemorySettings(session.workspace_id);
  if (settings?.recall_enabled === false) return [];
  const candidates = await r.information.recallMemories(session.workspace_id, session.project_id,
    memoryRecallTerms(content), 8, [...excludedIds]);
  const selected: { kind: 'MEMORY'; root_id: string; version: string; selection: 'AUTO_MEMORY';
    selection_basis: 'LITERAL_MATCH' | 'RECENT_CONFIRMED';
    origin: 'HUMAN_CONFIRMED' | 'AUTO_CAPTURE'; source_kind: MemorySourceKind }[] = [];
  let chars = 0;
  for (const memory of candidates) {
    // MEMORY_RECALL_RELEVANCE（BUG-CHAT-CONTEXT-CROSS-TALK）：只注入与当前消息字面命中的
    // 记忆。此前未命中的记忆会按 updated_at 顺序作为「近期已确认」回退带进来——用户只发
    // 「你好」时，最近保存的那条「请求打开记事本」就成了本轮输入，模型把它当成用户这次
    // 选中的资料。recallMemories 仍返回未命中行（管理面需要看全部候选），是否注入由应用层
    // 决定：没有字面依据就宁可少召回，也不拿时间排序冒充相关性。
    // 来源可信度排序（人工确认 → 用户原话 → 模型观察）仍在 SQL 里，只对命中项生效。
    if (!memory.literal_match) continue;
    if (excludedIds.has(memory.id) || chars + memory.body_text.length > 8000) continue;
    chars += memory.body_text.length;
    // origin 随来源冻结：后续答复与摘要据此知道「这条是自动记住的」，
    // 不必回查 Memory 根（根可能已被改写，来源版本才是当时事实）。
    // source_kind 同样随行：模型据此知道这条是用户自己的话，还是模型叙述的观察。
    selected.push({ kind: 'MEMORY', root_id: memory.id, version: memory.current_version.toString(),
      selection: 'AUTO_MEMORY', selection_basis: 'LITERAL_MATCH',
      origin: memory.origin, source_kind: memory.source_kind });
    if (selected.length >= Math.min(3, remaining)) break;
  }
  return selected;
}
