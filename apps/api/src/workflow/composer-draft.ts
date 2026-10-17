/**
 * 输入框草稿辅助的协议与切片（工作台 §30.2、测试计划 §31 CO-02/CO-03）。
 *
 * 这里只有**纯函数**：没有数据库、没有网络、没有模型端口、没有状态。它定义两件事：
 *
 *   1. 模型返回的**分点边界**协议与校验：模型只给「新要点从哪里开始」的序号，
 *      程序按原文切片并加编号换行。模型的任何改写文本都不进入结果——保真是构造出来的，
 *      不是比对出来的。
 *   2. **润色**返回的窄协议：只有一个 `text` 字段，非法或为空一律拒绝（拒绝 ≠ 清空草稿）。
 *
 * 字符计数规则（唯一口径）：所有序号都按 **Unicode 码点**（`Array.from` 的单元）计数，
 * 0 起、左闭右开。这样模型给出的边界天然不会切开代理对（emoji、增补平面汉字），
 * 程序也不需要再猜 UTF-16 索引是否落在半个字符上。
 *
 * 「程序新增的格式」定义（CO-02 的逐字重建口径）：每段前的 `^\d+\. ` 与段间的一个
 * `\n`。除此之外**不做** trim、不去标点、不合并空白——去掉这两样必须逐字还原输入。
 */

export type ComposerDraftOperation = 'OUTLINE' | 'POLISH';

/** 短输入不强拆（工作台 §30.5：最小触发长度按现有边界核定，此处取保守值）。 */
export const COMPOSER_MIN_DRAFT_CODE_POINTS = 8;
/** 单次请求的草稿上界：与输入器 32768 字符上限相比刻意收紧，草稿辅助不是长文通道。 */
export const COMPOSER_MAX_DRAFT_CODE_POINTS = 4000;
/** 建议条目上限：超过就拒绝整条建议，而不是截断成半截分点。 */
export const COMPOSER_MAX_OUTLINE_ITEMS = 12;
/** 润色结果上界：明显超过输入长度的结果一律拒绝。 */
export const COMPOSER_MAX_POLISHED_CODE_POINTS = 8000;

/** 按码点计长度。全仓草稿辅助的唯一计数口径。 */
export function codePointLength(text: string): number {
  return Array.from(text).length;
}

/** 已含换行的草稿视为用户已经分行：不再自动分点，避免把用户自己的换行当成程序格式。 */
export function hasLineBreak(text: string): boolean {
  return text.includes('\n') || text.includes('\r');
}

/** 行首斜杠命令（`/review`、`/clear` 等）不进入草稿辅助；命令 token 与参数不受影响。 */
export function looksLikeSlashCommand(text: string): boolean {
  return /^\s*\//u.test(text);
}

/**
 * 自动分点是否适用：短输入、空文、已分行、斜杠命令一律不适用。
 * 客户端据此决定要不要发起请求，服务端据此决定要不要返回 NO_SUGGESTION。
 */
export function outlineEligible(text: string): boolean {
  if (text.trim() === '') return false;
  if (looksLikeSlashCommand(text)) return false;
  if (hasLineBreak(text)) return false;
  return codePointLength(text) >= COMPOSER_MIN_DRAFT_CODE_POINTS;
}

export type ComposerOutlineRejectionCode =
  | 'OUTLINE_NOT_JSON'
  | 'OUTLINE_NOT_OBJECT'
  | 'OUTLINE_UNEXPECTED_FIELDS'
  | 'OUTLINE_BREAKS_MISSING'
  | 'OUTLINE_BREAK_NOT_INTEGER'
  | 'OUTLINE_BREAK_OUT_OF_RANGE'
  | 'OUTLINE_BREAK_NOT_INCREASING'
  | 'OUTLINE_BREAK_COUNT_EXCEEDED'
  | 'OUTLINE_SEGMENT_BLANK';

/** 畸形边界：整条建议拒绝，不显示任何「部分分点」，也不回退成按标点正则硬拆。 */
export class ComposerOutlineRejected extends Error {
  override readonly name = 'ComposerOutlineRejected';
  constructor(readonly code: ComposerOutlineRejectionCode) {
    super(`composer outline rejected: ${code}`);
  }
}

export interface ComposerOutline {
  readonly itemCount: number;
  /** 程序按原文切片并加编号换行后的文本；去掉程序格式可逐字重建原文。 */
  readonly text: string;
}

const OUTLINE_KEYS: readonly string[] = ['breaks'];

/**
 * 解析模型返回的分点边界并按**原文**切片。
 *
 * 校验顺序与反例一一对应：JSON → 对象 → 只有 `breaks` 一个键 → 数组 → 每个是整数 →
 * 落在 `(0, 码点总数)` 内 → 严格递增 → 条目数不超上限 → 每段至少含一个非空白字符。
 * 任何一条不满足都抛 `ComposerOutlineRejected`，调用方保留原文。
 *
 * 空数组是**合法回答**（「没有合理分点」），返回 `null` 表示不产生建议——这与畸形
 * 边界不同：前者是模型说「不必拆」，后者是协议不成立。
 */
export function buildOutline(original: string, raw: string): ComposerOutline | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    throw new ComposerOutlineRejected('OUTLINE_NOT_JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ComposerOutlineRejected('OUTLINE_NOT_OBJECT');
  }
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).some((key) => !OUTLINE_KEYS.includes(key))) {
    throw new ComposerOutlineRejected('OUTLINE_UNEXPECTED_FIELDS');
  }
  const rawBreaks = record.breaks;
  if (!Array.isArray(rawBreaks)) throw new ComposerOutlineRejected('OUTLINE_BREAKS_MISSING');
  if (rawBreaks.length === 0) return null;
  if (rawBreaks.length > COMPOSER_MAX_OUTLINE_ITEMS - 1) {
    throw new ComposerOutlineRejected('OUTLINE_BREAK_COUNT_EXCEEDED');
  }
  const points = Array.from(original);
  const total = points.length;
  const breaks: number[] = [];
  let previous = 0;
  for (const value of rawBreaks) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      throw new ComposerOutlineRejected('OUTLINE_BREAK_NOT_INTEGER');
    }
    if (value <= 0 || value >= total) {
      throw new ComposerOutlineRejected('OUTLINE_BREAK_OUT_OF_RANGE');
    }
    if (value <= previous) throw new ComposerOutlineRejected('OUTLINE_BREAK_NOT_INCREASING');
    breaks.push(value);
    previous = value;
  }
  const segments: string[] = [];
  let start = 0;
  for (const boundary of [...breaks, total]) {
    segments.push(points.slice(start, boundary).join(''));
    start = boundary;
  }
  if (segments.some((segment) => segment.trim() === '')) {
    throw new ComposerOutlineRejected('OUTLINE_SEGMENT_BLANK');
  }
  return { itemCount: segments.length, text: renderOutline(segments) };
}

/** 程序新增格式的唯一来源：`N. ` 前缀与段间 `\n`，不做 trim 或标点归一。 */
export function renderOutline(segments: readonly string[]): string {
  return segments.map((segment, index) => `${index + 1}. ${segment}`).join('\n');
}

/**
 * CO-02 的逐字重建口径：去掉程序新增的编号与换行后必须等于原文。
 * 只作为保真验收与测试的**定义**存在，产品路径不依赖它。
 */
export function reconstructOutline(rendered: string): string {
  return rendered.split('\n').map((line) => line.replace(/^\d+\. /u, '')).join('');
}

export type ComposerPolishRejectionCode =
  | 'POLISH_NOT_JSON'
  | 'POLISH_NOT_OBJECT'
  | 'POLISH_UNEXPECTED_FIELDS'
  | 'POLISH_TEXT_MISSING'
  | 'POLISH_TEXT_TOO_LONG';

export class ComposerPolishRejected extends Error {
  override readonly name = 'ComposerPolishRejected';
  constructor(readonly code: ComposerPolishRejectionCode) {
    super(`composer polish rejected: ${code}`);
  }
}

/**
 * 解析润色结果。只接受 `{"text": "..."}`，且非空、不超上界。
 * 拒绝时抛错，调用方保留原文——**绝不用空结果清空草稿**。
 */
export function parsePolishedText(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    throw new ComposerPolishRejected('POLISH_NOT_JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ComposerPolishRejected('POLISH_NOT_OBJECT');
  }
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'text')) {
    throw new ComposerPolishRejected('POLISH_UNEXPECTED_FIELDS');
  }
  const text = record.text;
  if (typeof text !== 'string' || text.trim() === '') {
    throw new ComposerPolishRejected('POLISH_TEXT_MISSING');
  }
  if (codePointLength(text) > COMPOSER_MAX_POLISHED_CODE_POINTS) {
    throw new ComposerPolishRejected('POLISH_TEXT_TOO_LONG');
  }
  return text.trim();
}
