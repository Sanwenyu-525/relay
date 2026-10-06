import assert from 'node:assert/strict';
import test from 'node:test';

import { frozenRoleSnapshot, personaDisplayLabel, validateReadScope } from
  '../../src/application/assistant-profile-commands.js';
import type { AssistantProfileRow } from '../../src/infrastructure/database-schema.js';
import type { JsonObject } from '../../src/infrastructure/json.js';

/**
 * 人设 助手配置的纯判定单元。
 *
 * 只覆盖不依赖数据库的判定：冻结快照的字段形状、消息行标签、以及
 * 「read_scope 只能缩小受管根范围」这条唯一实现点。
 * 幂等回执、revision CAS、归档与并发在
 * test/integration/assistant-readonly-session.integration.test.ts 用真实 PostgreSQL 验证。
 */

function profile(overrides: Partial<AssistantProfileRow> = {}): AssistantProfileRow {
  return {
    id: '助手-1',
    workspace_id: 'ws-1',
    name: '审读',
    role_description: '只读复核这份改动',
    tone: '简短',
    read_scope: {},
    revision: 3n,
    status: 'ACTIVE',
    created_at: new Date('2026-10-05T00:00:00Z'),
    updated_at: new Date('2026-10-05T00:00:00Z'),
    ...overrides,
  };
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code) : undefined;
}

test('冻结快照只含四个文本字段，不含任何授权信息', () => {
  const snapshot = frozenRoleSnapshot(profile());
  assert.deepEqual(Object.keys(snapshot).sort(),
    ['name', 'read_scope', 'role_description', 'tone']);
  // 快照冻结的是文本：能力、连接与权限一旦出现在这里，就说明某处把权限写进了配置。
  assert.equal('capabilities' in snapshot, false);
  assert.equal('connections' in snapshot, false);
  assert.equal('permissions' in snapshot, false);
});

test('冻结快照不跟随 助手之后的改写', () => {
  const before = frozenRoleSnapshot(profile());
  const after = frozenRoleSnapshot(profile({ role_description: '改过的人设', revision: 9n }));
  assert.equal(before.role_description, '只读复核这份改动');
  assert.equal(after.role_description, '改过的人设');
});

test('消息标签用冻结修订，而不是 助手 当前修订', () => {
  assert.equal(personaDisplayLabel(frozenRoleSnapshot(profile()), 3n), '审读 · 人设 v3');
  // 缺名字的快照仍要能显示，不允许渲染成空白标签。
  assert.equal(personaDisplayLabel({}, 1n), '未命名 助手 · 人设 v1');
});

test('read_scope 缺省是整根可读', () => {
  assert.deepEqual(validateReadScope(undefined), {});
  assert.deepEqual(validateReadScope({}), {});
});

test('read_scope 接受受管根内相对路径并去重', () => {
  assert.deepEqual(validateReadScope({ roots: ['src', 'src', 'docs/api'] }),
    { roots: ['src', 'docs/api'] });
  // 分隔符统一：Windows 上写反斜杠也归一到同一范围，不当成两个范围。
  assert.deepEqual(validateReadScope({ roots: ['src\\lib'] }), { roots: ['src/lib'] });
});

test('read_scope 拒绝越出受管根的形状', () => {
  // 绝对路径、`..` 与空串都会把范围写到受管根之外，那属于连接与策略的职责。
  for (const scope of [{ roots: ['/etc'] }, { roots: ['../outside'] }, { roots: ['src/../..'] },
    { roots: [''] }, { roots: ['C:/Windows'] }, { roots: ['src', '..'] }]) {
    assert.throws(() => validateReadScope(scope as JsonObject),
      (error: unknown) => { assert.equal(codeOf(error), 'VALIDATION_FAILED'); return true; },
      `必须拒绝 ${JSON.stringify(scope)}`);
  }
});

test('read_scope 拒绝其他键，避免范围之外的语义混进来', () => {
  for (const scope of [{ paths: ['src'] }, { roots: ['src'], capabilities: ['FILE_WRITE'] },
    { roots: 'src' }, { roots: [1] }]) {
    assert.throws(() => validateReadScope(scope as JsonObject),
      (error: unknown) => { assert.equal(codeOf(error), 'VALIDATION_FAILED'); return true; },
      `必须拒绝 ${JSON.stringify(scope)}`);
  }
});

test('read_scope 项数有上限', () => {
  const roots = Array.from({ length: 21 }, (_, index) => `dir-${index}`);
  assert.throws(() => validateReadScope({ roots }),
    (error: unknown) => { assert.equal(codeOf(error), 'VALIDATION_FAILED'); return true; });
});