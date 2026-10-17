/**
 * apply_changeset 增量预览解析（工作台 §34.4 / CD-09/10）。
 *
 * 模型端口当前累计完整工具参数再解析；要在「生成中」就给出局部行数变化，需要在原参数流上
 * 做**只读、有界、临时**的增量提取——不改完整校验之后才执行的规则。本模块只做解析，
 * 不执行、不 eval、不作数：真正的写入仍走原 Gateway，预览不授予任何权限、也不进入总数。
 *
 * 规则（CD-10）：
 *   * 处理转义换行、反斜杠、拆开的 Unicode（\uXXXX 跨 chunk）、半截 content、路径晚到、
 *     多文件、两个交错工具调用（交错由各工具调用独立喂流，不混 buf）；
 *   * 不数原始 JSON 行、不执行片段；
 *   * 输出/CPU/频率有上限：preview 文本只保留有界长度，超出截断并标记。
 *
 * 这是「预览」而非「结算」：内容尚未收全时 content 标 incomplete，调用方据此显示「待核对」。
 */

export type PreviewAction = 'CREATE' | 'MODIFY' | 'DELETE' | 'UNKNOWN';

export interface PreviewChangeFile {
  /** 路径尚未收到时为 null（CD-10 路径晚到）。 */
  readonly path: string | null;
  readonly action: PreviewAction;
  /** CREATE/MODIFY 的 best-effort 内容；DELETE 或不适用为 null。 */
  readonly contentPreview: string | null;
  /** content 字符串是否已完整闭合（含空文件 "" 的场景）。 */
  readonly contentComplete: boolean;
  /** item 对象是否已闭合。 */
  readonly itemComplete: boolean;
}


export interface ApplyChangesetPreview {
  readonly files: readonly PreviewChangeFile[];
  /** 解析过程中遇到的硬错误（如非法结构）；软的截断不算错误。 */
  readonly parseError: string | null;
  /** 顶层对象是否已闭合（整段参数到达）。 */
  readonly complete: boolean;
}

/** 单次流式解析的有界上限，防止超大 content 占内存/CPU。 */
export const MAX_PREVIEW_CONTENT_CHARS = 8_192;

/**
 * 从（可能截断的）apply_changeset 参数文本中提取预览。
 *
 * 不要求整段是合法 JSON：用括号深度扫描定位 items 数组与各 item，逐 item 抽取 path/
 * action/content。截断处的字符串返回 incomplete，不抛错。
 */
export function extractApplyChangesetPreview(text: string): ApplyChangesetPreview {
  const files: PreviewChangeFile[] = [];
  let parseError: string | null = null;
  let complete = false;

  const itemsStart = findItemsArrayStart(text);
  if (itemsStart === -1) {
    return { files, parseError, complete: isBalancedObject(text) };
  }

  let index = itemsStart;
  // itemsStart 指向 '[' 之后的位置（跳过 '['）。
  let depth = 1; // items 数组本身为 1
  let current: { path: string | null; action: PreviewAction; contentPreview: string | null;
    contentClosed: boolean; itemComplete: boolean } | null = null;

  while (index < text.length) {
    const char = text[index]!;
    if (char === '{' && depth === 1) {
      depth += 1;
      current = { path: null, action: 'UNKNOWN', contentPreview: null, contentClosed: false,
        itemComplete: false };
      index += 1;
      continue;
    }
    if (char === '}') {
      if (depth === 2 && current !== null) {
        files.push({ ...toPreviewFile(current), itemComplete: true });
        current = null;
      }
      depth -= 1;
      index += 1;
      continue;
    }
    if (char === '[' && depth >= 1) { depth += 1; index += 1; continue; }
    if (char === ']' && depth >= 1) {
      depth -= 1;
      if (depth === 0) {
        complete = true;
        index += 1;
        break;
      }
      index += 1;
      continue;
    }
    if ((char === '"') && depth === 2 && current !== null) {
      // 读一个 key，然后期待 ':' 与其值。
      const keyResult = readString(text, index);
      const key = keyResult.value;
      let cursor = keyResult.end;
      cursor = skipWs(text, cursor);
      if (text[cursor!] === ':') {
        cursor = skipWs(text, cursor + 1);
        const valueStart = cursor;
        if (text[valueStart!] === '"') {
          const str = readString(text, valueStart);
          if (key === 'path') current.path = str.value;
          else if (key === 'action') {
            current.action = normalizeAction(str.value);
          } else if (key === 'content') {
            current.contentPreview = str.value;
            // 字符串闭合与「读到上限截断」是两件事：空文件 "" 也是完整内容。
            current.contentClosed = str.complete;
          }
          cursor = str.end;
        } else {
          // 非字符串值（action 也可能以裸字符串出现；其余跳过）。
          const skip = skipValue(text, valueStart);
          if (key === 'action' && text[valueStart!] === '"') {
            const str = readString(text, valueStart);
            current.action = normalizeAction(str.value);
            cursor = str.end;
          } else {
            cursor = skip.end;
          }
        }
      }
      index = cursor;
      continue;
    }
    index += 1;
  }

  if (current !== null) {
    files.push({ ...toPreviewFile(current), itemComplete: false });
  }
  return { files, parseError, complete };
}

/** 内部状态 → 对外预览：内容完整 = 字符串闭合或 item 已闭合（含空文件 ""）。 */
function toPreviewFile(state: { path: string | null; action: PreviewAction;
  contentPreview: string | null; contentClosed: boolean; itemComplete: boolean }):
  PreviewChangeFile {
  return {
    path: state.path,
    action: state.action,
    contentPreview: state.contentPreview,
    contentComplete: state.contentClosed || state.itemComplete,
    itemComplete: state.itemComplete,
  };
}

function normalizeAction(value: string): PreviewAction {
  if (value === 'CREATE' || value === 'MODIFY' || value === 'DELETE') return value;
  return 'UNKNOWN';
}

/** 定位 `{ ... "items": [ ` 中 '[' 之后的游标；找不到返回 -1。 */
function findItemsArrayStart(text: string): number {
  const marker = '"items"';
  let at = text.indexOf(marker);
  while (at !== -1) {
    let cursor = at + marker.length;
    cursor = skipWs(text, cursor);
    if (text[cursor!] !== ':') { at = text.indexOf(marker, at + 1); continue; }
    cursor = skipWs(text, cursor + 1);
    if (text[cursor!] !== '[') { at = text.indexOf(marker, at + 1); continue; }
    return cursor + 1;
  }
  return -1;
}

/** 读取一个 JSON 字符串（含引号），返回解码后的内容、结束位置与是否完整闭合。 */
export function readString(text: string, startIndex: number): {
  readonly value: string; readonly end: number; readonly complete: boolean;
} {
  if (text[startIndex!] !== '"') {
    return { value: '', end: startIndex, complete: false };
  }
  let index = startIndex + 1;
  let out = '';
  while (index < text.length) {
    const char = text[index]!;
    if (char === '"') {
      return { value: out, end: index + 1, complete: true };
    }
    if (char === '\\') {
      const next = text[index + 1];
      if (next === undefined) {
        return { value: out, end: index, complete: false };
      }
      switch (next) {
        case 'n': out += '\n'; break;
        case 't': out += '\t'; break;
        case 'r': out += '\r'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case '/': out += '/'; break;
        case '\\': out += '\\'; break;
        case '"': out += '"'; break;
        case 'u': {
          const hex = text.slice(index + 2, index + 6);
          if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/u.test(hex)) {
            // 半截 \u（截断）或非法：保留原转义文本，标记不完整。
            out += text.slice(index, index + 2 + hex.length);
            index = index + 2 + hex.length;
            continue;
          }
          out += String.fromCharCode(Number.parseInt(hex, 16));
          index += 6;
          continue;
        }
        default:
          out += next;
          index += 2;
          continue;
      }
      index += 2;
      continue;
    }
    out += char;
    if (out.length > MAX_PREVIEW_CONTENT_CHARS) {
      // 有界截断：超出上限即停止读取，标记不完整（CD-10 输出有上限）。
      return { value: out.slice(0, MAX_PREVIEW_CONTENT_CHARS), end: index + 1, complete: false };
    }
    index += 1;
  }
  return { value: out, end: index, complete: false };
}

function skipWs(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length && /\s/u.test(text[cursor!]!)) cursor += 1;
  return cursor;
}

/** 跳过一个 JSON 值（对象/数组/字符串/标量），返回结束游标。 */
function skipValue(text: string, startIndex: number): { readonly end: number } {
  const char = text[startIndex!];
  if (char === '"') return { end: readString(text, startIndex).end };
  if (char === '{' || char === '[') {
    let depth = 0;
    let index = startIndex;
    while (index < text.length) {
      const c = text[index]!;
      if (c === '{' || c === '[') depth += 1;
      else if (c === '}' || c === ']') { depth -= 1; if (depth === 0) return { end: index + 1 }; }
      else if (c === '"') { const s = readString(text, index); index = s.end; continue; }
      index += 1;
    }
    return { end: index };
  }
  let index = startIndex;
  while (index < text.length && !/[,}\]\s]/u.test(text[index]!)) index += 1;
  return { end: index };
}

function isBalancedObject(text: string): boolean {
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/**
 * 流式包装：逐块喂入 apply_changeset 参数文本（同一工具调用），随时可取 best-effort 预览。
 * 交错的工具调用由调用方用不同实例隔离（CD-10）。
 */
export class ApplyChangesetStreamParser {
  private buffer = '';

  push(chunk: string): void {
    this.buffer += chunk;
  }

  snapshot(): ApplyChangesetPreview {
    return extractApplyChangesetPreview(this.buffer);
  }

  get text(): string {
    return this.buffer;
  }
}
