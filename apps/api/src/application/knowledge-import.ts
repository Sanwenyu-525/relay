import { createHash } from 'node:crypto';
import { crc32, inflateRawSync } from 'node:zlib';

/**
 * 知识导入的格式判定与正文提取（0167）。
 *
 * 原则：
 *   * 不信任扩展名：格式由魔数/结构判定，声明与实际不一致直接拒绝；
 *   * 不静默成功：扫描型 PDF 没有文本层时返回 `NO_TEXT`，绝不把空正文当成功；
 *   * 不落盘：本模块只处理内存中的 Buffer，不解析路径、不写文件系统，
 *     因此文件名里的路径片段不会变成任何真实的文件访问；
 *   * 不引入新的第三方依赖：DOCX 用 zlib 解 zip，PDF 用 zlib 解 Flate 流。
 *
 * 能力边界（必须在界面与文档中如实说明）：
 *   * PDF 仅支持 `/FlateDecode` 或未压缩的内容流，且字体编码可映射到 Unicode；
 *     CID/ToUnicode 缺失的扫描件或特殊编码会返回 `NO_TEXT`（本系统没有 OCR）。
 *   * DOCX 读取 `word/document.xml` 的段落文本，不保留样式、表格结构或图片。
 *
 * 自研解析器的生产边界：不追求完整 PDF 排版还原，也不承诺 DOCX 表格/页眉页脚；
 * 资源上限按文件、ZIP 成员、PDF 流、累计解压输出分别设置固定硬上限。声明的大小
 * 只用于一致性校验，绝不被当作可信预算。
 */

export const IMPORT_LIMITS = Object.freeze({
  maxFileBytes: 10 * 1024 * 1024,
  maxBatchFiles: 20,
  maxBatchBytes: 40 * 1024 * 1024,
  maxTextBytes: 262_144,
  maxHtmlBytes: 8 * 1024 * 1024,
  /** ZIP 条目数与单条/全部解压输出上限；即使声明值很小，也按实际输出硬截断。 */
  maxZipEntries: 2000,
  maxZipEntryUncompressedBytes: 8 * 1024 * 1024,
  maxZipTotalUncompressedBytes: 16 * 1024 * 1024,
  /** PDF 流数量、单流与累计输出上限；每个流不能独立消耗内存。 */
  maxPdfStreams: 1000,
  maxPdfStreamOutputBytes: 8 * 1024 * 1024,
  maxPdfTotalOutputBytes: 16 * 1024 * 1024,
  maxPdfTextChars: 4 * 1024 * 1024,
  maxParseMilliseconds: 3000,
});

export type ImportFormat = 'MARKDOWN' | 'TEXT' | 'PDF' | 'DOCX' | 'HTML';

export type ImportFailure =
  | 'EMPTY_FILE' | 'TOO_LARGE' | 'FORMAT_MISMATCH' | 'UNSUPPORTED_FORMAT'
  | 'INVALID_ENCODING' | 'NO_TEXT' | 'TEXT_TOO_LARGE' | 'MALFORMED' | 'RESOURCE_LIMIT';

export interface ExtractedDocument {
  readonly format: ImportFormat;
  readonly mediaType: string;
  readonly title: string;
  readonly text: string;
  readonly textBytes: number;
  readonly contentSha256: string;
  /** 提取器给出的可核对说明（例如 PDF 页数、DOCX 段落数）。 */
  readonly detail: Readonly<Record<string, string>>;
}

export type ExtractResult =
  | { readonly ok: true; readonly document: ExtractedDocument }
  | { readonly ok: false; readonly failure: ImportFailure; readonly message: string };

function fail(failure: ImportFailure, message: string): ExtractResult {
  return { ok: false, failure, message };
}

/** 展示用文件名：只保留最后一段、去掉控制字符；不用于任何文件系统访问。 */
export function displayFileName(raw: string): string {
  const base = raw.split(/[\\/]/u).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/gu, '').trim();
  return (cleaned === '' ? '未命名文件' : cleaned).slice(0, 200);
}

export function fileStem(name: string): string {
  const base = displayFileName(name).replace(/\.[^.]+$/u, '').trim();
  return base === '' ? '导入的知识' : base.slice(0, 120);
}

/**
 * 按 UTF-8 严格解码；失败时尝试 GB18030（中文 Windows 常见编码）；
 * 两者都失败返回 null，不退回 latin-1 制造看似成功的结果。
 */
export function decodeTextFile(buffer: Buffer): string | null {
  const bom = buffer.subarray(0, 3);
  if (bom[0] === 0xef && bom[1] === 0xbb && bom[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8');
  }
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return utf16(buffer.subarray(2), 'utf-16le');
  }
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    return utf16(buffer.subarray(2), 'utf-16be');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch { /* try legacy Chinese encoding next */ }
  try {
    return new TextDecoder('gb18030', { fatal: true }).decode(buffer);
  } catch { /* neither */ }
  return null;
}

function utf16(buffer: Buffer, encoding: 'utf-16le' | 'utf-16be'): string | null {
  try { return new TextDecoder(encoding, { fatal: true }).decode(buffer); }
  catch { return null; }
}

/** 二进制嗅探：出现 NUL 或大量控制字符时不是可导入的纯文本。 */
function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) control += 1;
  }
  return control > sample.length / 20;
}

export function detectFormat(buffer: Buffer, declaredName: string,
  declaredMediaType: string): ImportFormat | null {
  const head = buffer.subarray(0, 8);
  const name = declaredName.toLocaleLowerCase();
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'PDF';
  if (head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05)
    && (head[3] === 0x04 || head[3] === 0x06)) {
    return isDocxZip(buffer) ? 'DOCX' : null;
  }
  const text = buffer.subarray(0, 512).toString('utf8').trimStart().toLocaleLowerCase();
  if (text.startsWith('<!doctype html') || text.startsWith('<html')) return 'HTML';
  if (looksBinary(buffer)) return null;
  if (name.endsWith('.md') || name.endsWith('.markdown') ||
      declaredMediaType === 'text/markdown') return 'MARKDOWN';
  if (name.endsWith('.txt') || declaredMediaType === 'text/plain' ||
      declaredMediaType === '') return 'TEXT';
  if (name.endsWith('.pdf') || declaredMediaType === 'application/pdf') return 'PDF';
  if (name.endsWith('.docx')) return 'DOCX';
  if (name.endsWith('.html') || name.endsWith('.htm') ||
      declaredMediaType === 'text/html') return 'HTML';
  // 无扩展名的纯文本按 TEXT 处理；有扩展名但内容与声明都识别不出则拒绝。
  return name.includes('.') ? null : 'TEXT';
}

/** 扩展名与内容判定不一致：例如 .pdf 里其实是纯文本。 */
function declaredExtensionMismatch(format: ImportFormat, name: string): boolean {
  const lower = name.toLocaleLowerCase();
  if (lower.endsWith('.pdf')) return format !== 'PDF';
  if (lower.endsWith('.docx')) return format !== 'DOCX';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return format !== 'MARKDOWN';
  if (lower.endsWith('.txt')) return format !== 'TEXT';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return format !== 'HTML';
  return false;
}

export function extractDocument(input: { readonly name: string; readonly mediaType: string;
  readonly buffer: Buffer }): ExtractResult {
  if (input.buffer.length === 0) return fail('EMPTY_FILE', '文件为空，没有可收录的正文。');
  if (input.buffer.length > IMPORT_LIMITS.maxFileBytes) {
    return fail('TOO_LARGE', `单个文件不能超过 ${IMPORT_LIMITS.maxFileBytes / 1024 / 1024} MB。`);
  }
  const format = detectFormat(input.buffer, input.name, input.mediaType);
  if (format === null) {
    const zipMagic = input.buffer[0] === 0x50 && input.buffer[1] === 0x4b;
    if (zipMagic) {
      return fail('MALFORMED',
        'ZIP/DOCX 结构无效或条目/解压声明超过安全上限；为避免资源耗尽，已拒绝导入。');
    }
    return fail('UNSUPPORTED_FORMAT',
      '无法识别为 Markdown / 纯文本 / PDF / DOCX / HTML。压缩包、二进制文件不导入。');
  }
  if (declaredExtensionMismatch(format, input.name)) {
    return fail('FORMAT_MISMATCH', `扩展名与实际格式不一致（实际是 ${format}）。请改名后重试。`);
  }
  let text: string;
  let detail: Record<string, string> = {};
  if (format === 'MARKDOWN' || format === 'TEXT') {
    const decoded = decodeTextFile(input.buffer);
    if (decoded === null) {
      return fail('INVALID_ENCODING', '无法以 UTF-8 或 GB18030 解码；请另存为 UTF-8 后重试。');
    }
    text = decoded;
  } else if (format === 'HTML') {
    if (input.buffer.length > IMPORT_LIMITS.maxHtmlBytes) {
      return fail('TOO_LARGE', 'HTML 文件不能超过 8 MB。');
    }
    const decoded = decodeTextFile(input.buffer);
    if (decoded === null) {
      return fail('INVALID_ENCODING', '无法解码该 HTML 文件。');
    }
    const converted = htmlToText(decoded);
    text = converted.text;
    detail = { page_title: converted.title ?? '' };
  } else if (format === 'PDF') {
    const extracted = extractPdfText(input.buffer);
    if (!extracted.ok) return fail(extracted.failure, extracted.message);
    text = extracted.text;
    detail = extracted.detail;
  } else {
    const extracted = extractDocxText(input.buffer);
    if (!extracted.ok) return fail(extracted.failure, extracted.message);
    text = extracted.text;
    detail = extracted.detail;
  }
  text = text.replace(/\r\n?/gu, '\n').trim();
  if (text === '') {
    return fail('NO_TEXT', format === 'PDF'
      ? '这个 PDF 没有可提取的文本层（可能是扫描件）；本系统没有 OCR，无法自动提取正文。'
      : '文件里没有可收录的正文。');
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > IMPORT_LIMITS.maxTextBytes) {
    return fail('TEXT_TOO_LARGE',
      `提取出的正文 ${(bytes / 1024).toFixed(0)} KB，超过单条知识 256 KB 上限。请拆分后分别导入。`);
  }
  const htmlTitle = detail.page_title ?? '';
  const suggestedTitle = format === 'MARKDOWN' ? markdownTitle(text) ?? fileStem(input.name)
    : format === 'HTML' ? (htmlTitle === '' ? fileStem(input.name) : htmlTitle)
      : fileStem(input.name);
  return { ok: true, document: { format, mediaType: format === 'MARKDOWN' ? 'text/markdown'
    : format === 'HTML' || format === 'TEXT' || format === 'PDF' || format === 'DOCX'
      ? 'text/plain' : 'text/plain', title: suggestedTitle, text, textBytes: bytes,
    contentSha256: createHash('sha256').update(text, 'utf8').digest('hex'), detail } };
}

/** Markdown 第一个一级标题作为候选标题；没有标题时退回文件名。 */
function markdownTitle(text: string): string | null {
  const heading = /^#\s+([^\n]{1,120})\s*$/mu.exec(text)?.[1]?.trim();
  return heading === undefined || heading === '' ? null : heading;
}

/** HTML 转文本：去掉脚本/样式，保留段落换行，解码常见实体；不执行任何 HTML。 */
function htmlToText(html: string): { text: string; title: string | null } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html)?.[1]?.trim() ?? null;
  const body = html
    .replace(/<script[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style[\s\S]*?<\/style>/giu, ' ')
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/giu, '\n')
    .replace(/<[^>]+>/gu, ' ');
  return { text: decodeHtmlEntities(body).replace(/[ \t]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n').trim(), title: title === null ? null : decodeHtmlEntities(title) };
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/giu, ' ')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&amp;/giu, '&')
    .replace(/&#(\d+);/gu, (_, code: string) => safeCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_, code: string) =>
      safeCodePoint(Number.parseInt(code, 16)));
}

// ---------------------------------------------------------------------------
// DOCX（zip + word/document.xml）
// ---------------------------------------------------------------------------

interface ZipEntry { readonly name: string; readonly offset: number; readonly compressed: number;
  readonly uncompressed: number; readonly method: number; readonly crc: number;
  readonly flags: number; }

function readZipEntries(buffer: Buffer): ZipEntry[] | null {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) return null;
  const diskNumber = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
  const total = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const offset = buffer.readUInt32LE(eocd + 16);
  // 分卷 ZIP 不在支持范围；条目数必须在固定上限内。
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== total ||
      total === 0xffff || offset === 0xffffffff || directorySize === 0xffffffff ||
      total > IMPORT_LIMITS.maxZipEntries) return null;
  // 中央目录必须完整落在文件内，且不能与 EOCD 重叠。
  if (offset > buffer.length || directorySize > buffer.length - offset ||
      offset + directorySize > eocd) return null;
  const entries: ZipEntry[] = [];
  let cursor = offset;
  let declaredTotal = 0;
  for (let i = 0; i < total; i++) {
    if (cursor + 46 > buffer.length) return null;
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) return null;
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressed = buffer.readUInt32LE(cursor + 20);
    const uncompressed = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    if (nameLength === 0 || nameLength > 512 ||
        cursor + 46 + nameLength + extraLength + commentLength > buffer.length ||
        localOffset >= offset) return null;
    if (uncompressed > IMPORT_LIMITS.maxZipEntryUncompressedBytes) return null;
    declaredTotal += uncompressed;
    if (declaredTotal > IMPORT_LIMITS.maxZipTotalUncompressedBytes) return null;
    if (flags & 0x0001) return null; // 加密条目直接拒绝，不能把密文当 XML。
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (name.includes('\u0000') || name.includes('\\')) return null;
    entries.push({ name, offset: localOffset, compressed, uncompressed, method, crc, flags });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const start = Math.max(0, buffer.length - 65_557);
  for (let i = buffer.length - 22; i >= start; i--) {
    if (i + 22 > buffer.length || buffer.readUInt32LE(i) !== 0x06054b50) continue;
    const commentLength = buffer.readUInt16LE(i + 20);
    // 避免把注释里的伪 EOCD 当成中央目录起点；允许少量尾部数据，但不能越过文件。
    if (i + 22 + commentLength <= buffer.length) return i;
  }
  return -1;
}

function readZipEntry(buffer: Buffer, entry: ZipEntry): Buffer | null {
  const at = entry.offset;
  if (at + 30 > buffer.length || buffer.readUInt32LE(at) !== 0x04034b50) return null;
  const flags = buffer.readUInt16LE(at + 6);
  const method = buffer.readUInt16LE(at + 8);
  const crc = buffer.readUInt32LE(at + 14);
  const compressed = buffer.readUInt32LE(at + 18);
  const uncompressed = buffer.readUInt32LE(at + 22);
  const nameLength = buffer.readUInt16LE(at + 26);
  const extraLength = buffer.readUInt16LE(at + 28);
  const dataStart = at + 30 + nameLength + extraLength;
  // 本地文件头必须与中央目录一致；否则用伪造的“小尺寸”头部绕过中央目录预算。
  if (method !== entry.method || compressed !== entry.compressed ||
      uncompressed !== entry.uncompressed || crc !== entry.crc || (flags & 0x0001) !== 0 ||
      dataStart > buffer.length || compressed > buffer.length - dataStart) return null;
  const localName = buffer.subarray(at + 30, at + 30 + nameLength).toString('utf8');
  if (localName !== entry.name) return null;
  const raw = buffer.subarray(dataStart, dataStart + compressed);
  let output: Buffer;
  if (entry.method === 0) {
    if (compressed !== uncompressed) return null;
    output = raw;
  } else if (entry.method === 8) {
    try {
      // 关键：maxOutputLength 用固定上限，不采用攻击者声明的 uncompressed。
      output = inflateRawSync(raw, {
        maxOutputLength: IMPORT_LIMITS.maxZipEntryUncompressedBytes,
      });
    } catch { return null; }
  } else {
    return null;
  }
  // 声明值只做一致性校验；实际输出不能超过声明，也不能超过固定上限。
  if (output.length !== entry.uncompressed ||
      output.length > IMPORT_LIMITS.maxZipEntryUncompressedBytes) return null;
  if (crc32(output) !== entry.crc) return null;
  return output;
}

function isDocxZip(buffer: Buffer): boolean {
  const entries = readZipEntries(buffer);
  return entries?.some((entry) => entry.name === 'word/document.xml') === true;
}

function extractDocxText(buffer: Buffer):
{ ok: true; text: string; detail: Record<string, string> } |
{ ok: false; failure: ImportFailure; message: string } {
  const entries = readZipEntries(buffer);
  const entry = entries?.find((item) => item.name === 'word/document.xml');
  if (entries === null || entry === undefined) {
    return { ok: false, failure: 'MALFORMED', message: '不是有效的 DOCX（缺少 word/document.xml）。' };
  }
  const xml = readZipEntry(buffer, entry);
  if (xml === null) {
    return { ok: false, failure: 'MALFORMED', message: 'DOCX 正文无法解压。' };
  }
  const source = xml.toString('utf8');
  const paragraphs: string[] = [];
  // 段落：<w:p> ... </w:p>；表格单元格内的段落同样保留为一行，不做表格还原。
  for (const paragraph of source.match(/<w:p\b[\s\S]*?<\/w:p>/gu) ?? []) {
    const runs = paragraph.match(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/gu) ?? [];
    const line = runs.map((run) => decodeXmlEntities(run.replace(/<[^>]+>/gu, ''))).join('');
    const tab = /<w:tab\b/iu.test(paragraph) ? ' ' : '';
    const text = `${line}${tab}`.trim();
    if (text !== '') paragraphs.push(text);
  }
  if (paragraphs.length === 0) {
    return { ok: false, failure: 'NO_TEXT', message: 'DOCX 里没有可提取的段落文本。' };
  }
  return { ok: true, text: paragraphs.join('\n\n'),
    detail: { paragraphs: String(paragraphs.length) } };
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&lt;/gu, '<').replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"').replace(/&apos;/gu, "'").replace(/&amp;/gu, '&')
    .replace(/&#(\d+);/gu, (_, code: string) => safeCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_, code: string) => safeCodePoint(Number.parseInt(code, 16)));
}

/** XML 实体可能指向 surrogate/超范围码点；非法值返回空串，不让解析器崩溃。 */
function safeCodePoint(value: number): string {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff &&
    !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : '';
}

// ---------------------------------------------------------------------------
// PDF（内容流 + 文本算子）
// ---------------------------------------------------------------------------

type PdfTextResult = { readonly ok: true; readonly text: string;
  readonly detail: Record<string, string> } |
  { readonly ok: false; readonly failure: ImportFailure; readonly message: string };

/**
 * `indexOf('stream')` 会命中 `endstream` 里的子串，导致把结束标记当成新流起点，
 * 进而漏计流数量并错误拼接正文。只接受前面不是 `end` 的 stream 关键字。
 */
function findPdfStreamKeyword(buffer: Buffer, from: number): number {
  let at = buffer.indexOf('stream', from, 'latin1');
  while (at >= 0) {
    if (buffer.subarray(Math.max(0, at - 3), at).toString('latin1') !== 'end') return at;
    at = buffer.indexOf('stream', at + 6, 'latin1');
  }
  return -1;
}

function extractPdfText(buffer: Buffer): PdfTextResult {
  const startedAt = Date.now();
  const pages: string[] = [];
  let head = 0;
  let streamCount = 0;
  let totalOutputBytes = 0;
  let totalTextChars = 0;
  while (true) {
    if (Date.now() - startedAt > IMPORT_LIMITS.maxParseMilliseconds) {
      return { ok: false, failure: 'RESOURCE_LIMIT',
        message: 'PDF 解析超过时间上限，已停止；请拆分或转换为文本后导入。' };
    }
    const streamAt = findPdfStreamKeyword(buffer, head);
    if (streamAt < 0) break;
    streamCount += 1;
    if (streamCount > IMPORT_LIMITS.maxPdfStreams) {
      return { ok: false, failure: 'RESOURCE_LIMIT',
        message: 'PDF 内容流数量超过安全上限，已拒绝导入。' };
    }
    const dictionary = buffer.subarray(Math.max(0, streamAt - 600), streamAt).toString('latin1');
    let start = streamAt + 6;
    if (buffer[start] === 0x0d) start += 1;
    if (buffer[start] === 0x0a) start += 1;
    const endAt = buffer.indexOf('endstream', start, 'latin1');
    if (endAt < 0) {
      return { ok: false, failure: 'MALFORMED',
        message: 'PDF 内容流缺少 endstream，文件可能被截断；未保存部分正文。' };
    }
    const raw = buffer.subarray(start, endAt);
    head = endAt + 9;
    // 未压缩内容流也可能很大；同样进入累计输出预算。
    let output: Buffer;
    if (dictionary.includes('/FlateDecode')) {
      const inflated = inflatePdfStream(raw);
      if (inflated.tooLarge) {
        return { ok: false, failure: 'RESOURCE_LIMIT',
          message: 'PDF 单个内容流解压超过安全上限，已拒绝导入。' };
      }
      if (inflated.buffer === null) continue; // 异常/不支持 Filter：跳过这个流，不静默补正文。
      output = inflated.buffer;
    } else if (/(\/Filter|\/F)\s*[\[/]/u.test(dictionary)) {
      continue; // DCT/JBIG2/ASCII85 等 Filter 不在支持范围。
    } else {
      output = raw;
    }
    if (output.length > IMPORT_LIMITS.maxPdfStreamOutputBytes) {
      return { ok: false, failure: 'RESOURCE_LIMIT',
        message: 'PDF 单个内容流解压超过安全上限，已拒绝导入。' };
    }
    totalOutputBytes += output.length;
    if (totalOutputBytes > IMPORT_LIMITS.maxPdfTotalOutputBytes) {
      return { ok: false, failure: 'RESOURCE_LIMIT',
        message: 'PDF 内容流累计解压超过安全上限，已拒绝导入。' };
    }
    const stream = output.toString('latin1');
    if (!/\bBT\b/u.test(stream) || !/(\bTj\b|\bTJ\b)/u.test(stream)) continue;
    const text = readPdfOperators(stream);
    if (text === '') continue;
    if (totalTextChars + text.length > IMPORT_LIMITS.maxPdfTextChars) {
      return { ok: false, failure: 'RESOURCE_LIMIT',
        message: 'PDF 可提取文本超过安全上限；为避免静默截断，未保存部分正文。' };
    }
    totalTextChars += text.length;
    pages.push(text);
  }
  if (streamCount === 0) {
    return { ok: false, failure: 'MALFORMED', message: 'PDF 内容流无法解析。' };
  }
  const joined = pages.join('\n\n').replace(/[ \t]+/gu, ' ').replace(/\n{3,}/gu, '\n\n').trim();
  if (joined === '') {
    return { ok: false, failure: 'NO_TEXT',
      message: '这个 PDF 没有可提取的文本层（可能是扫描件或字体编码不支持）；本系统没有 OCR。' };
  }
  const printable = joined.replace(/\s/gu, '');
  const meaningful = printable.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  // 字体没有 ToUnicode 映射时，提取结果会是大量乱码符号；宁可报「无文本层」也不存乱码。
  if (printable.length > 0 && meaningful / printable.length < 0.15) {
    return { ok: false, failure: 'NO_TEXT',
      message: 'PDF 文本使用了不支持的字体编码（缺少 Unicode 映射），无法可靠提取；本系统没有 OCR。' };
  }
  return { ok: true, text: joined,
    detail: { streams: String(pages.length), chars: String(joined.length) } };
}

/** 带固定输出上限的宽松 inflate；区分「数据损坏」与「输出超限」。 */
function inflatePdfStream(raw: Buffer): { buffer: Buffer | null; tooLarge: boolean } {
  const limit = IMPORT_LIMITS.maxPdfStreamOutputBytes;
  const attempt = (candidate: Buffer): { buffer: Buffer | null; tooLarge: boolean } => {
    if (candidate.length < 2) return { buffer: null, tooLarge: false };
    try {
      return { buffer: inflateRawSync(candidate, { maxOutputLength: limit }), tooLarge: false };
    } catch (error: unknown) {
      const code = (error as { code?: string }).code;
      return { buffer: null, tooLarge: code === 'ERR_BUFFER_TOO_LARGE' };
    }
  };
  // Node 的 inflateRaw 对「带 zlib 头」的数据会失败；先去掉 2 字节头再试。
  const first = attempt(raw);
  if (first.buffer !== null || first.tooLarge) return first;
  if (raw.length < 2) return { buffer: null, tooLarge: false };
  return attempt(raw.subarray(2));
}

/**
 * 文本算子读取：只处理 `(literal) Tj`、`<hex> Tj`、`[(a)(b)] TJ`，
 * 以及会换行的 `Td/TD/T*`。复杂排版（多列、表格）不还原，但每个页面的文字顺序保留。
 */
function readPdfOperators(stream: string): string {
  let out = '';
  const tokenPattern = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>|\b(?:Tj|TJ|Td|TD|T\*|ET)\b/gu;
  let match: RegExpExecArray | null;
  let pending: string[] = [];
  const flush = (): void => {
    if (pending.length === 0) return;
    out += pending.join('');
    pending = [];
  };
  while ((match = tokenPattern.exec(stream)) !== null) {
    const token = match[0];
    if (token.startsWith('(')) {
      pending.push(decodePdfLiteral(token.slice(1, -1)));
    } else if (token.startsWith('<')) {
      pending.push(decodePdfHex(token.slice(1, -1)));
    } else if (token === 'Tj' || token === 'TJ') {
      flush();
      out += ' ';
    } else if (token === 'Td' || token === 'TD' || token === 'T*') {
      flush();
      out += '\n';
    } else if (token === 'ET') {
      flush();
      out += '\n';
    }
  }
  flush();
  return out;
}

function decodePdfLiteral(value: string): string {
  return value.replace(/\\([nrtbf()\\])/gu, (_, char: string) => {
    switch (char) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'b': return '\b';
      case 'f': return '\f';
      default: return char;
    }
  }).replace(/\\([0-7]{1,3})/gu, (_, octal: string) => String.fromCodePoint(Number.parseInt(octal, 8)))
    .replace(/\\\r?\n/gu, '');
}

function decodePdfHex(value: string): string {
  const hex = value.replace(/\s+/gu, '');
  const padded = hex.length % 4 === 0 ? hex : hex.padEnd(hex.length + (4 - hex.length % 4), '0');
  const chars: string[] = [];
  for (let i = 0; i < padded.length; i += 4) {
    const code = Number.parseInt(padded.slice(i, i + 4), 16);
    if (!Number.isFinite(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) continue;
    chars.push(String.fromCodePoint(code));
  }
  return chars.join('');
}
