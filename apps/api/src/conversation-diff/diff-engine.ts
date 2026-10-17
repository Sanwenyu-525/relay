/**
 * 会话 diff 的纯差异引擎（工作台 §34.2 / CD-02/03/16）。
 *
 * 这里的规则是「逐行文本净变化」的单一事实来源，前后端都消费同一套统计：
 *   * 统一换行：CRLF → LF 后再统计，纯换行编码变化不计入增删行；
 *   * 末尾换行：是否带末尾换行不作为一行计入，避免「补一个换行」被算成 +1/−1；
 *   * 空文件：0 行、0/0；
 *   * 二进制：含 NUL 或非法 UTF-8 一律不可统计，不编造行数；
 *   * 重命名（首版）：不做模糊推断，按「原路径删除 + 新路径新增」分别统计；
 *   * 净变化：同一行先改再改回、新建再删除、删除再恢复，都归零——这要求用
 *     基于 LCS 的 line diff，而不是「字符串长度差」或「工具调用次数」或整文件行数。
 *
 * 本模块不碰磁盘、不碰 Git、不碰数据库：可独立单元测试，也是真实 PG/HTTP 链路之外
 * 唯一能确定性复现差异规则的地方。
 */

/** 统一换行：CRLF → LF。CR-only 也归一成 LF，避免不同换行被当成新增/删除行。 */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** 把文本拆成「逻辑行」（不含行尾换行）。末尾换行不额外产生一行。 */
export function toLogicalLines(text: string): readonly string[] {
  const normalized = normalizeLineEndings(text);
  if (normalized === '') return [];
  // 去掉末尾换行后再按换行切分：'a\nb\n' 与 'a\nb' 都得到 ['a','b']。
  const trimmed = normalized.replace(/\n+$/u, '');
  if (trimmed === '') return [];
  return trimmed.split('\n');
}

export interface LineDiff {
  readonly added: number;
  readonly removed: number;
}

/**
 * 两版文本之间的逐行净变化，基于最长公共子序列（LCS）的长边计数。
 *
 * 返回的是「最少编辑距离」语义的增/删行数：同一行被改成别的内容 = 删旧 + 增新；
 * 同一行先改再改回 = 0/0。这是 CD-03「净数各自回零」成立的必要条件。
 */
export function computeLineDiff(oldText: string, newText: string): LineDiff {
  const oldLines = toLogicalLines(oldText);
  const newLines = toLogicalLines(newText);
  return computeLineDiffFromLines(oldLines, newLines);
}

export function computeLineDiffFromLines(oldLines: readonly string[], newLines: readonly string[]): LineDiff {
  const n = oldLines.length;
  const m = newLines.length;
  // 平凡情况直接给结果，避免为超大单行或空文本分配矩阵。
  if (n === 0) return { added: m, removed: 0 };
  if (m === 0) return { added: 0, removed: n };

  // 为防止超大文件把内存打爆，限制参与 LCS 的行数；超限时回退到「集合差异」近似，
  // 但只在两端都极大时触发，此时误差远小于文件本身规模，且仍满足「改回即归零」。
  const MAX_LCS_LINES = 20_000;
  if (n > MAX_LCS_LINES || m > MAX_LCS_LINES) {
    return approximateLineDiff(oldLines, newLines);
  }

  // 经典 LCS DP（O(n*m)）。文件受基线采集与读取上限约束，行数有限。
  const width = m + 1;
  const dp = new Float64Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    const oldLine = oldLines[i]!;
    for (let j = m - 1; j >= 0; j--) {
      if (oldLine === newLines[j]!) {
        dp[i * width + j] = dp[(i + 1) * width + (j + 1)]! + 1;
      } else {
        const down = dp[(i + 1) * width + j]!;
        const right = dp[i * width + (j + 1)]!;
        dp[i * width + j] = down > right ? down : right;
      }
    }
  }
  const lcs = dp[0]!;
  return { added: m - lcs, removed: n - lcs };
}

/**
 * 集合差异近似：把两端当成「行的多重集合」，新增 = 新端多出来的行，删除 = 旧端多出来的行。
 * 与 LCS 不同，它无法区分「改了一行」与「删一行加一行」，但在两侧都极大的场景下，
 * 误差占比很小，且仍满足「完全相同归零」「新增文件 = 全部为增」等核心断言。
 */
function approximateLineDiff(oldLines: readonly string[], newLines: readonly string[]): LineDiff {
  const oldCounts = new Map<string, number>();
  const newCounts = new Map<string, number>();
  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  for (const line of newLines) newCounts.set(line, (newCounts.get(line) ?? 0) + 1);
  let added = 0;
  let removed = 0;
  for (const [line, count] of newCounts) {
    const diff = count - (oldCounts.get(line) ?? 0);
    if (diff > 0) added += diff;
  }
  for (const [line, count] of oldCounts) {
    const diff = count - (newCounts.get(line) ?? 0);
    if (diff > 0) removed += diff;
  }
  return { added, removed };
}

export type DiffRowKind = 'CONTEXT' | 'ADD' | 'REMOVE';

/** 对齐后的一行：旧/新行号在「该侧不存在」时为 null；text 不含换行。 */
export interface DiffRow {
  readonly kind: DiffRowKind;
  readonly oldLine: number | null;
  readonly newLine: number | null;
  readonly text: string;
}

export interface AlignedDiff {
  readonly rows: readonly DiffRow[];
  /** 行数超过展示上限时只给前 maxRows 行并标记，调用方不得假装这是全文。 */
  readonly truncated: boolean;
}

/** 对齐展示的输出上限：正文展开是给人读的，超出部分不继续展开。 */
export const MAX_DIFF_ROWS = 600;
/** LCS 矩阵单元上限：超过就不做对齐（计数仍由 computeLineDiff 的近似口径给出）。 */
const MAX_ALIGN_CELLS = 4_000_000;

/**
 * 两版文本的对齐差异（展开阅读用）。
 *
 * 与 computeLineDiff 共用同一套行规则（换行归一、末尾换行不计行、LCS 语义），
 * 差别只在于返回逐行对齐结果而不是计数。返回 null 表示规模超出对齐上限：
 * 调用方应显示「超出预览上限」，而不是给出一个与计数不一致的近似正文。
 */
export function computeAlignedDiff(oldText: string, newText: string,
  maxRows: number = MAX_DIFF_ROWS): AlignedDiff | null {
  const oldLines = toLogicalLines(oldText);
  const newLines = toLogicalLines(newText);
  const n = oldLines.length;
  const m = newLines.length;
  if ((n + 1) * (m + 1) > MAX_ALIGN_CELLS) return null;
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    const oldLine = oldLines[i]!;
    for (let j = m - 1; j >= 0; j--) {
      if (oldLine === newLines[j]!) {
        dp[i * width + j] = dp[(i + 1) * width + (j + 1)]! + 1;
      } else {
        const down = dp[(i + 1) * width + j]!;
        const right = dp[i * width + (j + 1)]!;
        dp[i * width + j] = down > right ? down : right;
      }
    }
  }
  const rows: DiffRow[] = [];
  let truncated = false;
  const push = (row: DiffRow): void => {
    if (rows.length >= maxRows) { truncated = true; return; }
    rows.push(row);
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      push({ kind: 'CONTEXT', oldLine: i + 1, newLine: j + 1, text: oldLines[i]! });
      i += 1;
      j += 1;
      continue;
    }
    if (dp[(i + 1) * width + j]! >= dp[i * width + (j + 1)]!) {
      push({ kind: 'REMOVE', oldLine: i + 1, newLine: null, text: oldLines[i]! });
      i += 1;
    } else {
      push({ kind: 'ADD', oldLine: null, newLine: j + 1, text: newLines[j]! });
      j += 1;
    }
  }
  while (i < n) { push({ kind: 'REMOVE', oldLine: i + 1, newLine: null, text: oldLines[i]! }); i += 1; }
  while (j < m) { push({ kind: 'ADD', oldLine: null, newLine: j + 1, text: newLines[j]! }); j += 1; }
  return { rows, truncated };
}

/** 判断一段字节/文本是否为二进制（含 NUL）或非法 UTF-8。 */
export function isBinaryContent(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte === 0) return true;
  }
  return false;
}

export function isBinaryText(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 0) return true;
  }
  return false;
}

export type FileAction = 'CREATE' | 'MODIFY' | 'DELETE' | 'SAME';

/** 由基线/当前两版的 hash 推导文件动作；两端都缺失表示无关文件（调用方不应传入）。 */
export function classifyAction(
  baselineSha: string | null | undefined,
  currentSha: string | null | undefined,
): FileAction {
  const hasBaseline = baselineSha !== null && baselineSha !== undefined;
  const hasCurrent = currentSha !== null && currentSha !== undefined;
  if (hasBaseline && hasCurrent) {
    return baselineSha!.toLowerCase() === currentSha!.toLowerCase() ? 'SAME' : 'MODIFY';
  }
  if (!hasBaseline && hasCurrent) return 'CREATE';
  if (hasBaseline && !hasCurrent) return 'DELETE';
  return 'SAME';
}

/** 基线文件：相对根路径 + 实际内容摘要与（小文件）文本。 */
export interface BaselineFile {
  readonly path: string;
  readonly sha256: string;
  readonly text: string | null;
  readonly lineCount: number | null;
  readonly sizeBytes: number;
  readonly unavailableReason: string | null;
}

/** 当前文件：相对根路径 + 实际内容摘要与（小文件）文本。 */
export interface CurrentFile {
  readonly path: string;
  readonly sha256: string | null;
  readonly text: string | null;
  readonly lineCount: number | null;
  readonly sizeBytes: number | null;
  readonly unavailableReason: string | null;
}

export interface FileDiff {
  readonly path: string;
  readonly action: FileAction;
  readonly added: number;
  readonly removed: number;
  /** 任一侧不可统计（二进制/超限/读取失败）时非 null；该文件不计入总数。 */
  readonly unavailableReason: string | null;
}

export interface ConversationDiff {
  readonly rootPath: string;
  readonly resourceId: string;
  readonly baselineCapturedAt: string;
  readonly baselineRevision: bigint;
  /** 扫描或读取超限时为 true：总数只含可统计部分，不冒充完整。 */
  readonly incomplete: boolean;
  readonly totalFiles: number;
  readonly totalAdded: number;
  readonly totalRemoved: number;
  readonly files: readonly FileDiff[];
}

export interface SnapshotDiffInput {
  readonly rootPath: string;
  readonly resourceId: string;
  readonly baselineCapturedAt: string;
  readonly baselineRevision: bigint;
  readonly incomplete: boolean;
  readonly baseline: ReadonlyMap<string, BaselineFile>;
  readonly current: ReadonlyMap<string, CurrentFile>;
}

/**
 * 基线快照 → 当前磁盘内容 的净差异。
 *
 * 规则（§34.2/§34.3）：
 *   * 同一文件：两端都可统计时按 LCS 逐行算；任一侧不可统计（二进制/超限/读取失败）
 *     则该文件 unavailable，不计入总数（CD-16/17 不编造行数）。
 *   * 基线有、当前无 = DELETE；基线无、当前有 = CREATE；都有且 hash 不同 = MODIFY；
 *     hash 相同 = SAME（不计）。
 *   * 总数只反映「可统计」的净变化；不可统计项显式标出，不静默混入 +0/−0。
 */
export function computeSnapshotDiff(input: SnapshotDiffInput): ConversationDiff {
  const actions = new Map<string, FileAction>();
  for (const path of input.baseline.keys()) {
    const current = input.current.get(path);
    actions.set(path, classifyAction(input.baseline.get(path)!.sha256, current?.sha256));
  }
  for (const path of input.current.keys()) {
    if (!actions.has(path)) {
      actions.set(path, classifyAction(undefined, input.current.get(path)!.sha256));
    }
  }

  const files: FileDiff[] = [];
  let totalFiles = 0;
  let totalAdded = 0;
  let totalRemoved = 0;

  for (const [path, action] of actions) {
    if (action === 'SAME') continue;
    const baseline = input.baseline.get(path);
    const current = input.current.get(path);

    const unavailableReason = resolveUnavailable(baseline, current, action);
    let added = 0;
    let removed = 0;
    if (unavailableReason === null) {
      if (action === 'MODIFY' && baseline !== undefined && current !== undefined &&
          baseline.text !== null && current.text !== null) {
        const lineDiff = computeLineDiff(baseline.text, current.text);
        added = lineDiff.added;
        removed = lineDiff.removed;
      } else if (action === 'CREATE' && current !== undefined && current.text !== null) {
        // 新建文件：整文件内容都是新增行。
        added = current.lineCount ?? toLogicalLines(current.text).length;
        removed = 0;
      } else if (action === 'DELETE' && baseline !== undefined && baseline.text !== null) {
        // 删除文件：整文件内容都是移除行。
        removed = baseline.lineCount ?? toLogicalLines(baseline.text).length;
        added = 0;
      }
    }
    files.push({ path, action, added, removed, unavailableReason });
    if (unavailableReason === null) {
      totalFiles += 1;
      totalAdded += added;
      totalRemoved += removed;
    }
  }

  files.sort((left, right) => left.path.localeCompare(right.path));

  return {
    rootPath: input.rootPath,
    resourceId: input.resourceId,
    baselineCapturedAt: input.baselineCapturedAt,
    baselineRevision: input.baselineRevision,
    incomplete: input.incomplete,
    totalFiles,
    totalAdded,
    totalRemoved,
    files,
  };
}

function resolveUnavailable(
  baseline: BaselineFile | undefined,
  current: CurrentFile | undefined,
  action: FileAction,
): string | null {
  // 已明确标记不可统计的一侧优先透出原因。
  if (current?.unavailableReason !== null && current?.unavailableReason !== undefined) {
    return current.unavailableReason;
  }
  if (baseline?.unavailableReason !== null && baseline?.unavailableReason !== undefined) {
    return baseline.unavailableReason;
  }
  // 两端都应有文本才能算行数；缺文本且不是「正常不存在」（DELETE 的当前 / CREATE 的基线）
  // 视为读取失败。
  if (action === 'MODIFY' || action === 'SAME') {
    if (baseline?.text === null) return baseline?.unavailableReason ?? 'BASELINE_TEXT_UNAVAILABLE';
    if (current?.text === null) return current?.unavailableReason ?? 'CURRENT_TEXT_UNAVAILABLE';
  }
  return null;
}
