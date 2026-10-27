import assert from 'node:assert/strict';
import test from 'node:test';

import { BoundedResponseError, readBoundedJson, readBoundedText } from
  '../../src/workflow/bounded-response.js';

/**
 * P1-2 有界响应读取：上限必须在读取过程中生效，不能先整体读入再判断。
 * 覆盖：声明过大、声明偏小、无 content-length、分块传输、非法 JSON、空体。
 */

function chunkedResponse(chunks: readonly string[], headers: Record<string, string> = {}):
  Response {
  const encoder = new TextEncoder();
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) { controller.close(); return; }
      controller.enqueue(encoder.encode(chunks[index]!));
      index += 1;
    },
  });
  return new Response(stream, { status: 200, headers });
}

test('正常分块响应按原样拼回文本', async () => {
  const response = chunkedResponse(['{"data":', '{"ok":true}}']);
  assert.equal(await readBoundedText(response, 1024), '{"data":{"ok":true}}');
});

test('声明长度超过上限时立即拒绝，不读取响应体', async () => {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { pulled += 1; controller.enqueue(new TextEncoder().encode('x')); },
  });
  const response = new Response(stream, { status: 200, headers: { 'content-length': '999999' } });
  await assert.rejects(readBoundedText(response, 1024), (error: unknown) =>
    error instanceof BoundedResponseError && error.reason === 'DECLARED_TOO_LARGE');
  assert.equal(pulled, 0);
});

test('声明长度偏小时仍在读取过程中截断（不信任 content-length）', async () => {
  const response = chunkedResponse(['a'.repeat(600), 'b'.repeat(600)],
    { 'content-length': '10' });
  await assert.rejects(readBoundedText(response, 1024), (error: unknown) =>
    error instanceof BoundedResponseError && error.reason === 'BODY_TOO_LARGE');
});

test('没有 content-length 的分块响应同样受上限约束', async () => {
  const response = chunkedResponse(Array.from({ length: 8 }, () => 'y'.repeat(400)));
  await assert.rejects(readBoundedText(response, 1024), (error: unknown) =>
    error instanceof BoundedResponseError && error.reason === 'BODY_TOO_LARGE');
});

test('恰好等于上限的响应可以读完', async () => {
  const response = chunkedResponse(['z'.repeat(512), 'z'.repeat(512)]);
  assert.equal((await readBoundedText(response, 1024)).length, 1024);
});

test('空响应体按空文本处理', async () => {
  assert.equal(await readBoundedText(new Response(null, { status: 204 }), 16), '');
});

test('非法 JSON 与超限是两种不同的失败', async () => {
  await assert.rejects(readBoundedJson(chunkedResponse(['{not json']), 1024),
    (error: unknown) => error instanceof SyntaxError);
  await assert.rejects(readBoundedJson(chunkedResponse(['x'.repeat(4096)]), 1024),
    (error: unknown) => error instanceof BoundedResponseError);
});

test('合法 JSON 正常解析', async () => {
  const value = await readBoundedJson(chunkedResponse(['{"data":{"free_model_daily_requests":',
    '{"remaining":7}}}']), 1024) as { data: { free_model_daily_requests: { remaining: number } } };
  assert.equal(value.data.free_model_daily_requests.remaining, 7);
});

test('非正数上限是编程错误，直接抛错', async () => {
  await assert.rejects(readBoundedText(chunkedResponse(['x']), 0), /positive byte limit/u);
});
