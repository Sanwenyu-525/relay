import type { AssistSessionRow } from '../infrastructure/database-schema.js';
import type { MemorySourceKind } from '../infrastructure/database-schema.js';
import type { Repositories } from './unit-of-work.js';

/** Bounded literal tokens, including Chinese bigrams; this is not semantic search. */
export function memoryRecallTerms(text: string): readonly string[] {
  const terms = new Set<string>();
  for (const token of text.slice(0, 500).toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []) {
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
    memoryRecallTerms(content), 8);
  const selected: { kind: 'MEMORY'; root_id: string; version: string; selection: 'AUTO_MEMORY';
    selection_basis: 'LITERAL_MATCH' | 'RECENT_CONFIRMED';
    origin: 'HUMAN_CONFIRMED' | 'AUTO_CAPTURE'; source_kind: MemorySourceKind }[] = [];
  let chars = 0;
  for (const memory of candidates) {
    if (excludedIds.has(memory.id) || chars + memory.body_text.length > 8000) continue;
    chars += memory.body_text.length;
    // origin 随来源冻结：后续答复与摘要据此知道「这条是自动记住的」，
    // 不必回查 Memory 根（根可能已被改写，来源版本才是当时事实）。
    // source_kind 同样随行：模型据此知道这条是用户自己的话，还是模型叙述的观察。
    selected.push({ kind: 'MEMORY', root_id: memory.id, version: memory.current_version.toString(),
      selection: 'AUTO_MEMORY', selection_basis: memory.literal_match ? 'LITERAL_MATCH' : 'RECENT_CONFIRMED',
      origin: memory.origin, source_kind: memory.source_kind });
    if (selected.length >= Math.min(3, remaining)) break;
  }
  return selected;
}
