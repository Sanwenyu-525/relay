/**
 * 有界响应读取（P1-2）。
 *
 * 账户额度、连接验证这类响应来自**不可信**的上游：没有 `content-length`、长度写错、
 * 分块传输、甚至持续灌数据都可能发生。先 `await response.text()` 再判长度已经太晚——
 * 内存已经按对方的节奏涨完了。这里在流式读取过程中逐块累加，超过上限立刻取消读取。
 *
 * 边界：
 *   * `content-length` 只是提前拒绝的提示，不是保证：写小了也会在读取过程中被拦下；
 *   * 超限抛 `BoundedResponseError`，调用方按「未知」处理，不把半截响应当结论；
 *   * 不改变超时与取消：调用方仍把 `AbortSignal` 交给 fetch，读取用的是同一个响应流；
 *   * 非法 JSON 由 `JSON.parse` 抛出，与超限区分开。
 */

export class BoundedResponseError extends Error {
  override readonly name = 'BoundedResponseError';
  constructor(readonly reason: 'DECLARED_TOO_LARGE' | 'BODY_TOO_LARGE') {
    super(`response body is not acceptable: ${reason}`);
  }
}

/** 流式读取文本，超过 `maxBytes` 立即停止并抛错；绝不把整个响应读进内存再判断。 */
export async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('bounded read requires a positive byte limit');
  }
  if (response.body === null) return '';
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body.cancel().catch(() => undefined);
    throw new BoundedResponseError('DECLARED_TOO_LARGE');
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BoundedResponseError('BODY_TOO_LARGE');
      }
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 有界读取 + JSON 解析：超限与非法 JSON 是两种不同的失败，调用方可以分开处理。 */
export async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  return JSON.parse(await readBoundedText(response, maxBytes)) as unknown;
}
