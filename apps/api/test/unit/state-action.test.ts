import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { DomainError } from '../../src/application/domain-error.js';
import { normalizeStateAction } from '../../src/application/state-action.js';

/** 类型化 State action：允许字段集合、必需参数与规范化后的命令摘要 body。 */

function expectDomainError(error: unknown, code: string): boolean {
  assert.ok(error instanceof DomainError, `expected DomainError, got ${String(error)}`);
  assert.equal(error.code, code);
  return true;
}

test('normalizes SET_PHASE with trimmed text', () => {
  const action = normalizeStateAction('SET_PHASE', { phase_key: '  DESIGN  ' });

  assert.deepEqual(action, {
    action: 'SET_PHASE',
    phaseKey: 'DESIGN',
    body: { action: 'SET_PHASE', phase_key: 'DESIGN' },
  });
});

test('accepts null for SET_NEXT_ACTION and rejects non-uuid values', () => {
  assert.deepEqual(normalizeStateAction('SET_NEXT_ACTION', { next_action_task_id: null }), {
    action: 'SET_NEXT_ACTION',
    nextActionTaskId: null,
    body: { action: 'SET_NEXT_ACTION', next_action_task_id: null },
  });

  const taskId = randomUUID();
  const action = normalizeStateAction('SET_NEXT_ACTION', {
    next_action_task_id: taskId.toUpperCase(),
  });

  assert.equal(action.action === 'SET_NEXT_ACTION' ? action.nextActionTaskId : undefined, taskId);

  assert.throws(
    () => normalizeStateAction('SET_NEXT_ACTION', { next_action_task_id: 'nope' }),
    (error: unknown) => expectDomainError(error, 'VALIDATION_FAILED'),
  );
});

test('requires the parameters of each action', () => {
  assert.throws(
    () => normalizeStateAction('SELECT_ARTIFACT_VERSION', {}),
    (error: unknown) => expectDomainError(error, 'REQUIRED_INPUT_MISSING'),
  );
  assert.throws(
    () => normalizeStateAction('SELECT_ARTIFACT_VERSION', { artifact_version_id: randomUUID() }),
    (error: unknown) => expectDomainError(error, 'REQUIRED_INPUT_MISSING'),
  );
  assert.throws(
    () => normalizeStateAction('RESOLVE_BLOCKER', { blocker_id: '' }),
    (error: unknown) => expectDomainError(error, 'VALIDATION_FAILED'),
  );
});

test('rejects parameters that do not belong to the action', () => {
  assert.throws(
    () =>
      normalizeStateAction('SET_PHASE', {
        phase_key: 'DESIGN',
        statement: 'not part of SET_PHASE',
      }),
    (error: unknown) => expectDomainError(error, 'VALIDATION_FAILED'),
  );
  assert.throws(
    () =>
      normalizeStateAction('RESOLVE_BLOCKER', {
        blocker_id: randomUUID(),
        phase_key: 'DESIGN',
      }),
    (error: unknown) => expectDomainError(error, 'VALIDATION_FAILED'),
  );
});

test('rejects unknown actions without inventing a placeholder branch', () => {
  assert.throws(
    () => normalizeStateAction('REPLACE_STATE', {}),
    (error: unknown) => expectDomainError(error, 'VALIDATION_FAILED'),
  );
});

test('enforces entry text limits and produces a canonical body', () => {
  assert.throws(
    () => normalizeStateAction('SET_PHASE', { phase_key: 'x'.repeat(65) }),
    (error: unknown) => expectDomainError(error, 'VALIDATION_FAILED'),
  );

  const versionId = randomUUID();
  const action = normalizeStateAction('SELECT_ARTIFACT_VERSION', {
    artifact_version_id: versionId,
    source_ref: ' task:manual-check ',
  });

  assert.deepEqual(action.body, {
    action: 'SELECT_ARTIFACT_VERSION',
    artifact_version_id: versionId,
    source_ref: 'task:manual-check',
  });
});

test('keeps every action result assignable to a JSON command body', () => {
  const risk = normalizeStateAction('ADD_CONFIRMED_RISK', {
    statement: '样本量可能不足',
    source_ref: 'decision-review',
    confirmation_ref: 'user:confirmed',
  });

  assert.deepEqual(risk.body, {
    action: 'ADD_CONFIRMED_RISK',
    statement: '样本量可能不足',
    source_ref: 'decision-review',
    confirmation_ref: 'user:confirmed',
  });
});