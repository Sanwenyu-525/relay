import assert from 'node:assert/strict';
import test from 'node:test';

import { describeAssistRequestContext, estimateTokens } from '../../src/application/assist-context-usage.js';
import type { AssistRequest } from '../../src/workflow/fake-model-port.js';

/**
 * 0145：上下文构成的计数口径。
 *
 * 这组用例锁的是「只统计真正发给 Provider 的内容」：
 *   · 端口（`assistMessages`）只发送 system + turns + toolTurns + steers，
 *     `request.skill` **不会**单独发出去——Skill 的输入与依据已经被应用层渲染进 turns。
 *     再把 facts/input 加一遍就是把同一段内容累计两次；
 *   · 文件类只读工具的结果记「文件读取」，其余工具记「工具调用」，两者互斥；
 *   · 缓存读取不是上下文的加数（它属于输入量的缓存维度），这里不涉及。
 */

test('Skill 依据与输入只按 turns 里的那一段落账，不重复累计 facts', () => {
  const skillSection = '【Skill 输入｜UNTRUSTED_DATA】{"goal":"x"}\n\n依据正文';
  const request: AssistRequest = {
    intent: 'DISCUSS',
    system: '系统提示',
    turns: [{ role: 'user', content: skillSection }],
    skill: { id: 'demo', version: '1', facts: { huge: 'x'.repeat(600) }, input: { goal: 'x' } },
  };
  // 装配方登记这一段是注入（MEMORY）；统计只按那一段落账。
  const snapshot = describeAssistRequestContext(request, { turnCategories: { 0: 'MEMORY' } });
  const memory = snapshot.categories.find((entry) => entry.key === 'MEMORY');
  assert.ok(memory, '注入段应记在 MEMORY');
  // 只算 turns 里的那一段：facts 与 input 都没有额外进账。
  assert.equal(memory.bytes, Buffer.byteLength(skillSection, 'utf8'));
  assert.equal(memory.tokens, estimateTokens(Buffer.byteLength(skillSection, 'utf8')));
  assert.equal(snapshot.categories.some((entry) => entry.key === 'TOOLS'), false);

  // 没有登记时按普通历史消息计：统计不靠正文前缀猜，也不把 facts 补进来。
  const plain = describeAssistRequestContext(request);
  const history = plain.categories.find((entry) => entry.key === 'HISTORY');
  assert.ok(history);
  assert.equal(history.bytes, Buffer.byteLength(skillSection, 'utf8'));
  assert.equal(plain.categories.some((entry) => entry.key === 'MEMORY'), false);
});

test('文件类只读工具记「文件读取」，其余工具记「工具调用」，互斥不重复', () => {
  const request: AssistRequest = {
    intent: 'DISCUSS',
    system: '系统提示',
    turns: [{ role: 'user', content: '读一下' }],
    tools: [{ name: 'read_file', description: '读文件', parameters: { type: 'object' } }],
    toolTurns: [{
      calls: [{ providerToolCallId: 'call-1', name: 'read_file', arguments: { relative_path: 'a.md' } }],
      results: [{ providerToolCallId: 'call-1', name: 'read_file', content: '文件正文', isError: false }],
    }],
  };
  const snapshot = describeAssistRequestContext(request);
  const file = snapshot.categories.find((entry) => entry.key === 'FILE_READS');
  const tools = snapshot.categories.find((entry) => entry.key === 'TOOLS');
  assert.ok(file && tools);
  // 文件正文只在 FILE_READS 里出现一次。
  assert.equal(file.bytes, Buffer.byteLength('文件正文', 'utf8'));
  // TOOLS 里是工具声明与调用参数，不含那份正文。
  assert.equal(tools.bytes, Buffer.byteLength('read_file读文件{"type":"object"}read_file'
    + '{"relative_path":"a.md"}', 'utf8'));
  const total = snapshot.categories.reduce((sum, entry) => sum + entry.bytes, 0);
  assert.equal(total, snapshot.covered_bytes);
});

test('零值分类不出现；估算总量等于各分类之和', () => {
  const request: AssistRequest = {
    intent: 'DISCUSS',
    system: '系统提示',
    turns: [{ role: 'user', content: '你好' }],
  };
  const snapshot = describeAssistRequestContext(request);
  assert.equal(snapshot.categories.every((entry) => entry.tokens > 0), true);
  assert.equal(snapshot.estimated_total_tokens,
    snapshot.categories.reduce((sum, entry) => sum + entry.tokens, 0));
  assert.equal(snapshot.precision, 'ESTIMATED');
  assert.equal(snapshot.method, 'UTF8_BYTES_DIV_3');
});
