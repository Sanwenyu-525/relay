import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveModelSelection, type CatalogInput } from '../../src/application/model-selection-resolve.js';

/**
 * 会话模型选择的纯决策单测（专项阶段 C，FM-05/FM-06 的解析层）。
 * 纯函数、无数据库、无网络：这里证明「未知型号 / 收费型号 / 目录外型号」都得到确定结果，
 * 绝不会被悄悄接成一次外呼或换成别的型号；真正的 CAS/回执/跨会话隔离在真实 PG 集成用例覆盖。
 */

function freeCatalog(models: [string, boolean][], seq = '7'): CatalogInput {
  return { snapshotSeq: seq, models: models.map(([source_model_id, is_free]) =>
    ({ source_model_id, is_free })) };
}

test('空请求一律按未登记拒绝，不猜默认', () => {
  const r = resolveModelSelection({ requested: '   ', defaultModel: 'gpt-x',
    catalog: freeCatalog([['free-a', true]]) });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.rejection.code, 'MODEL_NOT_REGISTERED');
});

test('命中默认连接模型：走默认连接、freeOnly=false、无目录依据（大小写/空白无关）', () => {
  const r = resolveModelSelection({ requested: '  GPT-X  ', defaultModel: 'gpt-x' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.selection.connection, 'default');
  assert.equal(r.selection.model, 'gpt-x');
  assert.equal(r.selection.freeOnly, false);
  assert.equal(r.selection.catalogSource, null);
  assert.equal(r.selection.catalogSnapshotSeq, null);
  assert.equal(r.selection.catalogModelId, null);
});

test('未配置默认连接时，命中目录严格免费型号走 OpenRouter 连接并带快照依据', () => {
  const r = resolveModelSelection({ requested: 'free-a', catalog: freeCatalog([['free-a', true]], '42') });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.selection.connection, 'openrouter');
  assert.equal(r.selection.model, 'free-a');
  assert.equal(r.selection.freeOnly, true);
  assert.equal(r.selection.catalogSource, 'openrouter');
  assert.equal(r.selection.catalogSnapshotSeq, '42');
  assert.equal(r.selection.catalogModelId, 'free-a');
});

test('目录里的收费型号被明确拒绝，不悄悄换成免费项也不发起调用', () => {
  const r = resolveModelSelection({ requested: 'paid-b', catalog: freeCatalog([['free-a', true], ['paid-b', false]]) });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.rejection.code, 'MODEL_PAID_NOT_AVAILABLE');
});

test('目录外、非默认的型号按未登记拒绝（不引入第三主机、不猜测）', () => {
  const r = resolveModelSelection({ requested: 'unknown-z', defaultModel: 'gpt-x',
    catalog: freeCatalog([['free-a', true]]) });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.rejection.code, 'MODEL_NOT_REGISTERED');
});

test('默认连接优先：请求名同时等于默认与目录项时，按已配置的默认连接处理', () => {
  const r = resolveModelSelection({ requested: 'gpt-x', defaultModel: 'gpt-x',
    catalog: freeCatalog([['gpt-x', true]]) });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.selection.connection, 'default');
  assert.equal(r.selection.freeOnly, false);
});

test('无默认、无目录时任何型号都不可选', () => {
  const r = resolveModelSelection({ requested: 'anything' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.rejection.code, 'MODEL_NOT_REGISTERED');
});
