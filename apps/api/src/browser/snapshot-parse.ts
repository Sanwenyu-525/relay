/**
 * 上游输出的纯解析函数（F26）。
 *
 * 这些函数不碰进程、不碰网络，只把 chrome-devtools-mcp 的文本/结构化输出变成 Relay
 * 自己的形状。抽出来单独测：上游文本格式是「人读」的，解析错了会表现为「元素找不到」
 * 这种难以归因的失败，必须有独立用例锁住。
 *
 * 优先用 `--experimentalStructuredContent` 给的 `structuredContent`（精确）；
 * 它缺失时退回文本解析（有损但可用）。两条路径都在这里收口。
 *
 * 实测快照行有三种形状（chrome-devtools-mcp 1.11.0）：
 *   `uid=1_0 RootWebArea "Relay Fixture" url="http://…"`
 *   `uid=1_4 textbox "关键词"`
 *   `uid=1_3 "关键词 "`            ← 没有角色，只有名称（静态文本类节点）
 */

import type { BrowserElement, BrowserPageRef } from './provider.js';

/** `## Pages` 文本里的一行：`1: 标题 (url) [selected]`。 */
const PAGE_LINE = /^(\d+):\s?(.*)$/;

/** 快照行：缩进 + uid + 其余。角色与名称按形状再拆。 */
const SNAPSHOT_LINE = /^(\s*)uid=(\S+)(.*)$/;

/** 一个完整的双引号串（允许反斜杠转义）。 */
const QUOTED_AT_START = /^"((?:[^"\\]|\\.)*)"/;

export function parsePages(structured: unknown, text: string): readonly BrowserPageRef[] {
  const fromStructured = pagesFromStructured(structured);
  if (fromStructured !== null) return fromStructured;
  return pagesFromText(text);
}

function pagesFromStructured(structured: unknown): readonly BrowserPageRef[] | null {
  if (typeof structured !== 'object' || structured === null) return null;
  const pages = (structured as { pages?: unknown }).pages;
  if (!Array.isArray(pages)) return null;
  const result: BrowserPageRef[] = [];
  for (const entry of pages) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const pageId = typeof record.id === 'number' ? record.id : null;
    if (pageId === null) continue;
    result.push({
      pageId,
      url: typeof record.url === 'string' ? record.url : '',
      title: typeof record.title === 'string' ? record.title : '',
    });
  }
  return result;
}

function pagesFromText(text: string): readonly BrowserPageRef[] {
  const result: BrowserPageRef[] = [];
  for (const line of text.split('\n')) {
    const match = PAGE_LINE.exec(line.trim());
    if (match === null) continue;
    const pageId = Number(match[1]);
    if (!Number.isInteger(pageId)) continue;
    const rest = (match[2] ?? '').replace(/\s*\[selected\]\s*$/, '').trim();
    const urlMatch = /\((.*)\)\s*$/.exec(rest);
    if (urlMatch !== null) {
      result.push({ pageId, url: urlMatch[1] ?? '', title: rest.slice(0, urlMatch.index).trim() });
      continue;
    }
    // 没有括号时上游打印的是「标题（空标题则退回 URL）」，只能按形状判断：
    // 像 URL 就当 URL，否则当标题。精确值以 structuredContent 为准。
    if (/^[a-z][a-z0-9+.-]*:/i.test(rest)) result.push({ pageId, url: rest, title: '' });
    else result.push({ pageId, url: '', title: rest });
  }
  return result;
}

export interface ParsedSnapshot {
  readonly elements: readonly BrowserElement[];
  readonly url: string | null;
  readonly title: string | null;
}

/**
 * 解析 a11y 文本快照。
 *
 * 层级由缩进推导（上游每层两个空格），`inForm` 由祖先链推导——风险分类需要知道
 * 「这个按钮是不是在表单里」，而文本快照本身不打印 form 归属。
 */
export function parseSnapshotText(text: string): ParsedSnapshot {
  const elements: BrowserElement[] = [];
  const stack: { depth: number; role: string }[] = [];
  let url: string | null = null;
  let title: string | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const match = SNAPSHOT_LINE.exec(line);
    if (match === null) continue;
    const depth = Math.floor((match[1] ?? '').length / 2);
    const uid = match[2] ?? '';
    let rest = (match[3] ?? '').replace(/^\s+/, '');
    let role = '';
    let name = '';
    const quotedFirst = QUOTED_AT_START.exec(rest);
    if (quotedFirst !== null) {
      // 没有角色的节点：整段只剩名称。
      name = unescapeQuoted(quotedFirst[1] ?? '').trim();
      role = 'generic';
      rest = rest.slice(quotedFirst[0].length);
    } else {
      const space = rest.indexOf(' ');
      role = space < 0 ? rest : rest.slice(0, space);
      rest = space < 0 ? '' : rest.slice(space);
      const quoted = QUOTED_AT_START.exec(rest.replace(/^\s+/, ''));
      if (quoted !== null) name = unescapeQuoted(quoted[1] ?? '').trim();
    }
    while (stack.length > 0 && (stack[stack.length - 1]?.depth ?? 0) >= depth) stack.pop();
    const inForm = stack.some((ancestor) => ancestor.role === 'form');
    stack.push({ depth, role });
    if (role === 'RootWebArea') {
      const urlMatch = /url="((?:[^"\\]|\\.)*)"/.exec(rest);
      if (urlMatch !== null) url = unescapeQuoted(urlMatch[1] ?? '');
      if (name !== '') title = name;
    }
    elements.push({ uid, role, name, inForm });
  }
  return { elements, url, title };
}

function unescapeQuoted(value: string): string {
  return value.replace(/\\(["\\])/g, '$1');
}

/** 从 PNG 头部读宽高；不是 PNG 或长度不足时返回 null。 */
export function pngSize(base64: string): { width: number; height: number } | null {
  if (base64.length < 32) return null;
  const buffer = Buffer.from(base64.slice(0, 64), 'base64');
  if (buffer.length < 24) return null;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let index = 0; index < signature.length; index += 1) {
    if (buffer[index] !== signature[index]) return null;
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}
