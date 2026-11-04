/**
 * 工具结果回传文本的有界投影。
 *
 * 对齐上游 codex-rs `utils/string/truncate.rs` 的 `truncate_middle_chars`：超过上限时保留
 * 首尾两段、截去中间，并在断点插入显式标记。只保留头部的旧做法会让长测试日志、大文件
 * 和命令输出的尾部（往往正是失败原因）永远不可见，模型据此判断会失真。
 *
 * 预算按 UTF-8 字节计算，切点落在完整码点上，不产生半个字符。标记本身占用固定预留的
 * 字节预算，因此返回值不会突破调用方给定的硬上限。
 *
 * 标记键名是 `tool_result_truncated` 而不是裸 `truncated`：`read_file` 的范围结果也会
 * 用 `truncated` 表示「这不是完整文件」，两层省略必须能区分，不能出现两个互相矛盾的
 * 省略标记。`omitted_bytes` 指的是**本次回传文本**被截去的字节，不是文件剩余字节。
 */

const MARKER_RESERVE_BYTES = 64;

export interface BoundedToolResultText {
  /** 实际回传的文本；未截断时等于原文。 */
  readonly text: string;
  readonly truncated: boolean;
  readonly omittedBytes: number;
  readonly originalBytes: number;
}

function utf8ByteLength(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

/** 从头部取不超过 budget 字节的完整码点前缀。 */
function takePrefix(text: string, budget: number): string {
  let bytes = 0;
  let index = 0;
  while (index < text.length) {
    const codePoint = text.codePointAt(index) ?? 0;
    const size = utf8ByteLength(codePoint);
    if (bytes + size > budget) break;
    bytes += size;
    index += codePoint > 0xffff ? 2 : 1;
  }
  return text.slice(0, index);
}

/** 从尾部取不超过 budget 字节的完整码点后缀。 */
function takeSuffix(text: string, budget: number): string {
  let bytes = 0;
  let index = text.length;
  while (index > 0) {
    const last = text.charCodeAt(index - 1);
    const hasHighSurrogate = last >= 0xdc00 && last <= 0xdfff && index >= 2 &&
      text.charCodeAt(index - 2) >= 0xd800 && text.charCodeAt(index - 2) <= 0xdbff;
    const step = hasHighSurrogate ? 2 : 1;
    const codePoint = text.codePointAt(index - step) ?? 0;
    const size = utf8ByteLength(codePoint);
    if (bytes + size > budget) break;
    bytes += size;
    index -= step;
  }
  return text.slice(index);
}

export function boundToolResultText(text: string, maxBytes: number): BoundedToolResultText {
  const originalBytes = Buffer.byteLength(text, 'utf8');
  if (originalBytes <= maxBytes) {
    return { text, truncated: false, omittedBytes: 0, originalBytes };
  }

  const contentBudget = maxBytes - MARKER_RESERVE_BYTES;
  if (contentBudget < 1) {
    // 上限小于标记预留：只保留头部，仍保证不越过硬上限。
    const kept = takePrefix(text, Math.max(0, maxBytes));
    return {
      text: kept,
      truncated: true,
      omittedBytes: originalBytes - Buffer.byteLength(kept, 'utf8'),
      originalBytes,
    };
  }

  const headBudget = Math.ceil(contentBudget / 2);
  const tailBudget = contentBudget - headBudget;
  const head = takePrefix(text, headBudget);
  const tail = takeSuffix(text, tailBudget);
  const keptBytes = Buffer.byteLength(head, 'utf8') + Buffer.byteLength(tail, 'utf8');
  const omittedBytes = originalBytes - keptBytes;
  const marker = `…{"tool_result_truncated":true,"omitted_bytes":${omittedBytes}}…`;
  return {
    text: `${head}${marker}${tail}`,
    truncated: true,
    omittedBytes,
    originalBytes,
  };
}
