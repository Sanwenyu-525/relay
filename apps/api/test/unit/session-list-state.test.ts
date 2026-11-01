import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveListState, type AssistSessionStateFacts }
  from '../../src/assist/assist-repository.js';

/**
 * 会话列表状态的派生优先级（2026-10-30）。
 *
 * 这条链是左栏八种图标的唯一依据：它错一档，界面就会把「在跑」画成「完成」，
 * 或者把「等确认」画成「已完成」。因此这里逐档钉住，不依赖数据库：
 *
 *   在途（RUNNING / PENDING）→ 等待确认提案 → 归档 → 未开始 → 最后一轮终态 → 未知
 *
 * 与数据库、HTTP 无关；列表与单条读取共用同一个函数，真实 PG 侧的等价性归
 * `assist-run-state.integration.test.ts`。
 */

const facts = (patch: Partial<AssistSessionStateFacts> = {}): AssistSessionStateFacts => ({
  status: 'ACTIVE',
  has_messages: true,
  run_state: null,
  last_assistant_status: 'COMPLETED',
  waiting_approval: false,
  ...patch
});

test('在途压过一切：RUNNING / PENDING 就是列表状态本身', () => {
  assert.equal(deriveListState(facts({ run_state: 'RUNNING', last_assistant_status: 'RUNNING' })), 'RUNNING');
  assert.equal(deriveListState(facts({ run_state: 'PENDING', last_assistant_status: 'PENDING' })), 'PENDING');
  // 即便同时有一条待确认提案、会话还归档了，正在生成的那一轮仍是这一行此刻的样子。
  assert.equal(deriveListState(facts({ run_state: 'RUNNING', waiting_approval: true, status: 'ARCHIVED' })), 'RUNNING');
});

test('等待确认提案排在归档与终态之前：它需要人动手，不能被「已完成」盖住', () => {
  assert.equal(deriveListState(facts({ waiting_approval: true })), 'WAITING_APPROVAL');
  assert.equal(deriveListState(facts({ waiting_approval: true, status: 'ARCHIVED' })), 'WAITING_APPROVAL');
  assert.equal(deriveListState(facts({ waiting_approval: true, last_assistant_status: 'FAILED' })), 'WAITING_APPROVAL');
});

test('归档与未开始是会话自身的事实，排在终态之前', () => {
  assert.equal(deriveListState(facts({ status: 'ARCHIVED' })), 'ARCHIVED');
  // 归档的空会话读成 ARCHIVED：归档比「还没说过话」更能描述这条会话现在在哪。
  assert.equal(deriveListState(facts({ status: 'ARCHIVED', has_messages: false,
    last_assistant_status: null })), 'ARCHIVED');
  assert.equal(deriveListState(facts({ has_messages: false, last_assistant_status: null })), 'NOT_STARTED');
});

test('最后一轮终态逐字回显：COMPLETED / FAILED / CANCELLED 各自成立', () => {
  assert.equal(deriveListState(facts({ last_assistant_status: 'COMPLETED' })), 'COMPLETED');
  assert.equal(deriveListState(facts({ last_assistant_status: 'FAILED' })), 'FAILED');
  assert.equal(deriveListState(facts({ last_assistant_status: 'CANCELLED' })), 'CANCELLED');
});

test('读不出时为 null：不把 null 解释成完成，也不挑一个终态顶上', () => {
  // 有消息，但一条助手回复行都没有（历史数据或投影错位）。
  assert.equal(deriveListState(facts({ last_assistant_status: null })), null);
  // 「在途」与「最后一轮」错位时不猜：run_state 说没有在途，最后一轮却是 PENDING/RUNNING。
  assert.equal(deriveListState(facts({ last_assistant_status: 'PENDING' })), null);
  assert.equal(deriveListState(facts({ last_assistant_status: 'RUNNING' })), null);
});
