/**
 * `READ_FILE` 的范围参数与 UTF-8 安全切片。
 *
 * 语义：`offset` / `limit` 都按 **UTF-8 字节**计，不是行号也不是 UTF-16 字符。
 *   · `offset` 是片段起始字节（从 0 开始）；落在多字节字符内部时向前对齐到该字符起点。
 *   · `limit` 是本次最多返回的字节数；终点落在完整码点边界，绝不切开字符。
 *   · 首个码点就超过 `limit` 时仍返回该码点（最多超出 3 字节），避免出现「限 1 字节却什么都没返回」。
 *   · 按 `next_offset` 连续读取，首/中/尾片段按字节拼接可无损还原原文（CRLF 也不改写）。
 *
 * 文件仍然是整份读取（上层已有 128 KiB 上限），切片只影响回传正文；因此完整文件的
 * SHA-256 不受范围参数影响，`baselineSha256` 的校验语义保持不变。
 */

import type { JsonObject } from '../infrastructure/json.js';
import { FILE_READ_MAX_BYTES } from '../workflow/tool-catalog.js';

export interface FileReadRangeParams {
  readonly offset: number;
  readonly limit: number;
}

/** 参数非法：调用方负责映射成自己的校验错误（prepare 用 validationFailed）。 */
export class FileReadRangeValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'FileReadRangeValidationError';
    this.field = field;
  }
}

function isContinuationByte(byte: number): boolean {
  return byte >= 0x80 && byte <= 0xbf;
}

/** 前导字节对应的码点字节数；孤立续字节/非法前导按 1 字节前进，避免死循环。 */
function codePointByteLength(lead: number): number {
  if (lead < 0x80) return 1;
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 1;
}

/**
 * 解析并校验 `read_file` 的 offset/limit；没有范围参数时返回 undefined（保持整读语义）。
 * 只接受 offset/limit 两个键，其它键一律拒绝，避免模型把额外字段带进动作参数。
 */
export function readFileRangeParams(params: JsonObject): FileReadRangeParams | undefined {
  const keys = Object.keys(params);
  if (keys.length === 0) return undefined;
  for (const key of keys) {
    if (key !== 'offset' && key !== 'limit') {
      throw new FileReadRangeValidationError(key, 'read_file only takes offset and limit');
    }
  }
  const rawOffset = params.offset;
  const rawLimit = params.limit;
  if (rawOffset !== undefined) {
    if (typeof rawOffset !== 'number' || !Number.isInteger(rawOffset) || rawOffset < 0) {
      throw new FileReadRangeValidationError('params.offset',
        `offset must be a non-negative integer no greater than ${FILE_READ_MAX_BYTES}`);
    }
    if (rawOffset > FILE_READ_MAX_BYTES) {
      throw new FileReadRangeValidationError('params.offset',
        `offset must be a non-negative integer no greater than ${FILE_READ_MAX_BYTES}`);
    }
  }
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit) || rawLimit < 1 ||
        rawLimit > FILE_READ_MAX_BYTES) {
      throw new FileReadRangeValidationError('params.limit',
        `limit must be a positive integer no greater than ${FILE_READ_MAX_BYTES}`);
    }
  }
  return {
    offset: typeof rawOffset === 'number' ? rawOffset : 0,
    limit: typeof rawLimit === 'number' ? rawLimit : FILE_READ_MAX_BYTES,
  };
}

export interface Utf8RangeSlice {
  /** 实际回传正文；始终由完整码点组成。 */
  readonly content: string;
  /** 实际起始字节（offset 落在字符内部时已向前对齐）。 */
  readonly offset: number;
  readonly returnedBytes: number;
  /** 下一次续读应传的 offset；没有剩余内容时为 null。 */
  readonly nextOffset: number | null;
  readonly hasMoreBefore: boolean;
  readonly hasMoreAfter: boolean;
  /** 请求的 offset 已经越过文件末尾（空内容，但仍给出总大小）。 */
  readonly offsetBeyondEnd: boolean;
}

/** 按 UTF-8 字节切出 `[offset, offset+limit)`；起点/终点都对齐到完整码点。 */
export function sliceUtf8Range(bytes: Buffer, range: FileReadRangeParams): Utf8RangeSlice {
  const total = bytes.length;
  const requested = range.offset;
  if (requested >= total) {
    return {
      content: '',
      offset: requested,
      returnedBytes: 0,
      nextOffset: null,
      hasMoreBefore: requested > 0,
      hasMoreAfter: false,
      offsetBeyondEnd: requested > 0,
    };
  }
  // 起点若落在续字节上，向前退到该字符的前导字节。
  let start = requested;
  while (start > 0 && isContinuationByte(bytes[start]!)) start -= 1;
  let end = Math.min(total, start + range.limit);
  // 终点若落在续字节上，退到上一个完整码点之后。
  while (end > start && end < total && isContinuationByte(bytes[end]!)) end -= 1;
  if (end <= start) {
    // 一个码点都放不下：至少返回起点处的完整码点。
    end = Math.min(total, start + codePointByteLength(bytes[start]!));
  }
  // 不把 CRLF 拆成两段：切点落在 \r 与 \n 之间时，把 \r 留给下一段。
  if (end > start && end < total && bytes[end - 1] === 0x0d && bytes[end] === 0x0a && end - 1 > start) {
    end -= 1;
  }
  return {
    content: bytes.subarray(start, end).toString('utf8'),
    offset: start,
    returnedBytes: end - start,
    nextOffset: end < total ? end : null,
    hasMoreBefore: start > 0,
    hasMoreAfter: end < total,
    offsetBeyondEnd: false,
  };
}
