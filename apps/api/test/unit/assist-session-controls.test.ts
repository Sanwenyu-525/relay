import assert from 'node:assert/strict';
import test from 'node:test';

import {
  archiveAssistSession,
  forkAssistSession,
  reopenAssistSession,
  renameAssistSession,
  setAssistSessionPin,
} from '../../src/application/assist-session-controls.js';
import { DomainError } from '../../src/application/domain-error.js';
import type { DbExecutor } from '../../src/infrastructure/database.js';

/**
 * 会话行内控制（改名/置顶/归档/重开/分叉）的纯判定单元。
 *
 * 这里只覆盖进入幂等命令之前、不依赖数据库的入口栅栏：标题文本规则与
 * `expected_revision` 的十进制字符串规则。这两道都是 422，必须在应用层就挡住，
 * 不能靠「前端已挡」兜底。
 * 落库、同 `command_id` 重放、`revision` CAS、跨 Workspace 不可见、归档态拒绝、
 * 在途消息挡归档与置顶排序，都在
 * test/integration/assist-session-controls.integration.test.ts 用真实 PostgreSQL 验证。
 *
 * 全部用例传 `null` 当执行器：栅栏若漏过去，`runIdempotentCommand` 会在空执行器上炸出
 * 非 DomainError，因此「拿到的是 422 DomainError」这一条断言同时也是「栅栏没漏」的证明；
 * 反向用例（合法载荷）则断言错误**不是** DomainError。
 */

const db = null as unknown as DbExecutor;
const workspaceId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const commandId = '33333333-3333-4333-8333-333333333333';
const revisionShape = 'must be a decimal string within the bigint range';

async function caught(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }

  throw new Error('expected the call to be rejected');
}

async function assertValidation(work: () => Promise<unknown>, field: string, message: string): Promise<void> {
  const error = await caught(work);
  assert.ok(error instanceof DomainError, `expected a DomainError, got ${String(error)}`);
  assert.equal(error.code, 'VALIDATION_FAILED');
  assert.equal(error.status, 422);
  assert.equal(error.type, '/problems/validation-failed');
  // 422 不是「稍后可重试」：重发同一载荷只会再撞同一条规则，重试语义留给 409/503。
  assert.equal(error.retryable, false);
  assert.equal(error.retryAction, 'NONE');
  assert.deepEqual(error.fieldErrors, [{ field, message }]);
}

/** 合法输入必须穿过入口栅栏：空执行器上的失败不能是 422。 */
async function assertPassedTheGates(work: () => Promise<unknown>): Promise<void> {
  const error = await caught(work);
  assert.ok(!(error instanceof DomainError), `unexpected domain rejection: ${error}`);
}

const rename = (title: string, expectedRevision = '1') =>
  () => renameAssistSession(db, { workspaceId, sessionId, commandId, expectedRevision, title });

test('改名拒绝空标题与纯空白标题', async () => {
  for (const title of ['', '   ', '\t\n']) {
    await assertValidation(rename(title), 'title', 'must not be empty');
  }
});

test('改名沿用建会话的 200 字上限，且按去空白后的长度计', async () => {
  await assertValidation(rename('标'.repeat(201)), 'title', 'must be at most 200 characters');
  // 首尾空白不计长度：这一条必须与 normalizeText 的入库结果一致，否则重放摘要会漂。
  await assertPassedTheGates(rename(`  ${'标'.repeat(200)}  `));
  await assertPassedTheGates(rename('标'.repeat(200)));
});

test('改名拒绝标题里的控制字符', async () => {
  await assertValidation(rename('正常标题\u0007尾部'), 'title', 'must not contain control characters');
});

test('五条命令都要求十进制字符串的 expected_revision', async () => {
  for (const expectedRevision of ['', 'abc', '-1', '1.5', '1e3', '9'.repeat(20)]) {
    await assertValidation(rename('可用的新标题', expectedRevision), 'expected_revision', revisionShape);
    await assertValidation(() => setAssistSessionPin(db, {
      workspaceId, sessionId, commandId, expectedRevision, pinned: true,
    }), 'expected_revision', revisionShape);
    await assertValidation(() => archiveAssistSession(db, {
      workspaceId, sessionId, commandId, expectedRevision,
    }), 'expected_revision', revisionShape);
    await assertValidation(() => reopenAssistSession(db, {
      workspaceId, sessionId, commandId, expectedRevision,
    }), 'expected_revision', revisionShape);
    // 分叉没有可调参数，修订是它唯一的入口栅栏；子会话标题由服务端算，不经过调用方。
    await assertValidation(() => forkAssistSession(db, {
      workspaceId, sessionId, commandId, expectedRevision,
    }), 'expected_revision', revisionShape);
  }
});

test('标题先于修订被判定：两个都不合法时只报标题', async () => {
  await assertValidation(rename('', 'abc'), 'title', 'must not be empty');
});

test('pinned=false 是真实取值，不是被缺省掉的字段', async () => {
  // 「取消置顶」与「没带这个字段」在命令摘要里必须是两件事，否则重放会分不清用户想取消还是想置顶。
  await assertPassedTheGates(() => setAssistSessionPin(db, {
    workspaceId, sessionId, commandId, expectedRevision: '1', pinned: false,
  }));
});
