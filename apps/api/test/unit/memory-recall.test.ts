import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryRecallTerms } from '../../src/application/memory-recall.js';

test('mixed Chinese and Latin queries retain searchable words and Chinese bigrams', () => {
  const terms = memoryRecallTerms('继续完善PostgreSQL数据库与React18前端');
  assert.ok(terms.includes('postgresql'));
  assert.ok(terms.includes('数据库'.slice(0, 2)));
  assert.ok(terms.includes('react18'));
  assert.ok(terms.length <= 24);
});

test('recall terms remain bounded, unique and case insensitive', () => {
  assert.deepEqual(memoryRecallTerms('PG pg PG'), ['pg']);
  assert.deepEqual(memoryRecallTerms('!?'), []);
  assert.ok(memoryRecallTerms('数据库'.repeat(200)).length <= 24);
});
