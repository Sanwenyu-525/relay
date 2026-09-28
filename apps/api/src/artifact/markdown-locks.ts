export type BlockKind = 'PARAGRAPH' | 'SECTION';

export interface MarkdownBlock {
  readonly kind: BlockKind;
  readonly index: number;
  readonly text: string;
}

export interface TextLock {
  readonly id: string;
  readonly kind: BlockKind;
  readonly block_index: number | null;
  readonly text: string;
  readonly status: 'MAPPED' | 'UNMAPPED';
}

/** Positions are display selectors only. Protection always compares exact text and its context. */
export function markdownBlocks(content: string, kind: BlockKind): readonly MarkdownBlock[] {
  const lines = content.match(/[^\r\n]*(?:\r\n|\n|\r|$)/gu)?.filter(Boolean) ?? [];
  const lineText = (line: string) => line.replace(/(?:\r\n|\n|\r)$/u, '');
  const result: MarkdownBlock[] = [];
  if (kind === 'PARAGRAPH') {
    let current: string[] = [];
    const flush = () => {
      if (current.length) result.push({ kind, index: result.length,
        text: current.join('').replace(/(?:\r\n|\n|\r)$/u, '') });
      current = [];
    };
    let fenced = false;
    for (const line of lines) {
      const text = lineText(line);
      if (/^\s*```/u.test(text)) fenced = !fenced;
      if (!fenced && /^\s*$/u.test(text)) { flush(); continue; }
      current.push(line);
    }
    flush();
    return result;
  }
  const headings: { start: number; level: number }[] = [];
  let fenced = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lineText(lines[index]!);
    if (/^\s*```/u.test(line)) fenced = !fenced;
    if (fenced) continue;
    const match = /^(#{1,6})\s+\S/u.exec(line);
    if (match) headings.push({ start: index, level: match[1]!.length });
  }
  for (const [index, heading] of headings.entries()) {
    const next = headings.slice(index + 1).find((item) => item.level <= heading.level);
    result.push({ kind, index, text: lines.slice(heading.start, next?.start ?? lines.length).join('') });
  }
  return result;
}

export function mapHumanLocks(locks: readonly TextLock[], oldContent: string,
  newContent: string): readonly TextLock[] {
  const occupied = new Set<string>();
  return locks.map((lock) => {
    const blocks = markdownBlocks(newContent, lock.kind);
    const oldBlocks = markdownBlocks(oldContent, lock.kind);
    if (lock.block_index === null || oldBlocks[lock.block_index]?.text !== lock.text) {
      return { ...lock, block_index: null, status: 'UNMAPPED' as const };
    }
    const exact = blocks.filter((block) => block.text === lock.text);
    const selected = exact.length === 1 ? exact[0] :
      exact.length > 1 || oldBlocks.length !== blocks.length ? undefined :
        lock.block_index === null ? undefined :
        blocks[lock.block_index];
    const key = selected && `${lock.kind}:${selected.index}`;
    if (!selected || !key || occupied.has(key) ||
        lock.status === 'UNMAPPED' && exact.length !== 1) {
      return { ...lock, block_index: null, status: 'UNMAPPED' as const };
    }
    // A same-position fallback is safe only when the old selector still pointed at this text.
    const old = lock.block_index === null ? undefined : oldBlocks[lock.block_index];
    if (exact.length === 0 && (old?.text !== lock.text || oldBlocks.some((block, index) =>
      index !== lock.block_index && block.text !== blocks[index]?.text))) {
      return { ...lock, block_index: null, status: 'UNMAPPED' as const };
    }
    occupied.add(key);
    return { ...lock, block_index: selected.index, text: selected.text, status: 'MAPPED' as const };
  });
}

/** An AI version cannot delete, edit, split, merge or reorder a protected block. */
export function protectedTextConflict(locks: readonly TextLock[], oldContent: string,
  candidate: string): string | null {
  if (!locks.length) return null;
  if (locks.some((lock) => lock.status !== 'MAPPED' || lock.block_index === null)) {
    return '锁定区域在人工修订后无法可靠映射；请先由用户核对并解除或重新锁定。';
  }
  for (const kind of ['PARAGRAPH', 'SECTION'] as const) {
    const relevant = locks.filter((lock) => lock.kind === kind);
    if (!relevant.length) continue;
    const old = markdownBlocks(oldContent, kind);
    const next = markdownBlocks(candidate, kind);
    for (const lock of relevant) {
      if (old[lock.block_index!]?.text !== lock.text) return '锁定基线已变化，不能应用旧候选。';
      const matches = next.filter((block) => block.text === lock.text);
      if (matches.length !== 1 || old.filter((block) => block.text === lock.text).length !== 1) {
        return 'AI 候选修改、删除、拆分或无法唯一识别锁定原文。';
      }
      const position = matches[0]!.index;
      if (position !== lock.block_index) {
        const neighbours = [old[lock.block_index! - 1], old[lock.block_index! + 1]]
          .filter((block): block is MarkdownBlock => block !== undefined);
        if (neighbours.some((block) => next.filter((item) => item.text === block.text).length !== 1 ||
            old.filter((item) => item.text === block.text).length !== 1)) {
          return 'AI 候选移动了锁定原文，且相邻结构无法可靠核对。';
        }
      }
      // Stable neighbouring blocks anchor order; insertion or edits beside the lock remain possible.
      for (const block of old) {
        if (block.index === lock.block_index) continue;
        const anchors = next.filter((item) => item.text === block.text);
        if (anchors.length !== 1 || old.filter((item) => item.text === block.text).length !== 1) continue;
        if ((block.index < lock.block_index!) !== (anchors[0]!.index < position)) {
          return 'AI 候选移动了锁定原文或其相邻结构。';
        }
      }
    }
  }
  return null;
}
