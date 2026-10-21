import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureFingerprint, normalizeCaptureText, sourceContentHash }
  from '../../src/application/memory-captures.js';
import { capturePrompt, classifyExtractedSource, parseExtractedMemories }
  from '../../src/application/memory-auto-capture.js';

/**
 * 自动捕获的纯逻辑（ADR-030、DEV-0042）。
 *
 * 这里只断言「解析、来源核验与归一化」这类可离线证明的部分；写入、撤销与召回排序必须用真实 PG，
 * 不能拿这些单测代替集成证据。
 */

test('归一化把空白、全半角与大小写收敛到同一指纹', () => {
  const a = captureFingerprint('数据库选型', '采用 PostgreSQL 作为唯一业务数据库。');
  const b = captureFingerprint(' 数据库选型 ', '采用　PostgreSQL  作为唯一业务数据库。');
  assert.equal(a, b, '空白与全角空格不应产生第二条记忆');
  assert.match(a, /^[0-9a-f]{64}$/u);
  // 归一化只用于判重，不改写入正文：展示值仍是原样。
  assert.equal(normalizeCaptureText('  采用　PostgreSQL  '), '采用 postgresql');
});

test('不同内容不会撞指纹', () => {
  assert.notEqual(captureFingerprint('标题', '内容 A'), captureFingerprint('标题', '内容 B'));
});

test('来源摘要按 UTF-8 计算，与客户端保存来源的口径一致', () => {
  assert.equal(sourceContentHash('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sourceContentHash('你好，世界'),
    '46932f1e6ea5216e77f58b1908d72ec9322ed129318c6d4bd4450b5eaab9d7e7');
});

test('解析：接受纯 JSON、代码块与前后带解释三种形态', () => {
  const body = '{"memories":[{"title":"数据库","text":"采用 PostgreSQL","source":"user",'
    + '"quote":"我们决定用 PostgreSQL","reason":"用户明确说了"}]}';
  for (const raw of [body, `\`\`\`json\n${body}\n\`\`\``, `这是结果：\n${body}\n以上。`]) {
    const parsed = parseExtractedMemories(raw);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]!.title, '数据库');
    assert.equal(parsed[0]!.reason, '用户明确说了');
    assert.equal(parsed[0]!.source, 'user');
    assert.equal(parsed[0]!.quote, '我们决定用 PostgreSQL');
  }
});

test('解析：空数组是合法结果，不是失败', () => {
  assert.deepEqual(parseExtractedMemories('{"memories":[]}'), []);
});

test('解析：非法 JSON、缺字段、超条数都按契约收敛，不猜测补全', () => {
  assert.deepEqual(parseExtractedMemories('not json'), []);
  assert.deepEqual(parseExtractedMemories('{"memories":"none"}'), []);
  assert.deepEqual(parseExtractedMemories('{"memories":[{"title":"","text":"正文"}]}'), []);
  assert.deepEqual(parseExtractedMemories('{"memories":[{"title":"只有标题"}]}'), []);
  const many = JSON.stringify({ memories: Array.from({ length: 6 }, (_, index) => ({
    title: `标题${index}`, text: `正文${index}`, source: 'user', quote: `引用${index}` })) });
  assert.equal(parseExtractedMemories(many).length, 3, '最多 3 条');
});

test('解析：缺 reason 落为 null，不编造依据', () => {
  const parsed = parseExtractedMemories(
    '{"memories":[{"title":"t","text":"x","source":"user","quote":"q"}]}');
  assert.equal(parsed[0]!.reason, null);
});

test('解析：没有来源或没有逐字引用的候选直接丢弃，不留「来源不明」的记忆', () => {
  assert.deepEqual(parseExtractedMemories('{"memories":[{"title":"t","text":"x"}]}'), []);
  assert.deepEqual(parseExtractedMemories('{"memories":[{"title":"t","text":"x","source":"bot"}]}'), []);
  assert.deepEqual(parseExtractedMemories('{"memories":[{"title":"t","text":"x","source":"user"}]}'), []);
  assert.deepEqual(parseExtractedMemories(
    '{"memories":[{"title":"t","text":"x","source":"user","quote":"  "}]}'), []);
});

test('来源核验：引用必须逐字出现在它声明的那一段里', () => {
  const user = '我们决定用 PostgreSQL 做唯一业务数据库。';
  const reply = '好的，网页正文说 pnpm 是这个仓库的包管理器。';
  assert.equal(classifyExtractedSource({ source: 'user', quote: '我们决定用 PostgreSQL' }, user, reply),
    'USER_STATEMENT');
  assert.equal(classifyExtractedSource({ source: 'assistant', quote: '网页正文说 pnpm' }, user, reply),
    'MODEL_OBSERVATION');
  // 声明来自用户、但原话里没有这句：不认。
  assert.equal(classifyExtractedSource({ source: 'user', quote: '用户同意用 MySQL' }, user, reply),
    null);
  // 归一化后仍算逐字：全角空格与换行不算改写。
  assert.equal(classifyExtractedSource({ source: 'user', quote: '用　PostgreSQL' }, user, reply),
    'USER_STATEMENT');
});

test('输入上限：超长对话只截断不重写', () => {
  const user = 'u'.repeat(5000);
  const reply = 'r'.repeat(5000);
  const prompt = capturePrompt(user, reply);
  assert.equal(prompt.length, 8000);
  assert.ok(prompt.startsWith('【用户原话】\n' + 'u'.repeat(10)));
  const short = capturePrompt('短', '回复');
  assert.ok(short.includes('【用户原话】\n短'));
  assert.ok(short.includes('【助手答复'));
  assert.ok(short.includes('回复'));
});
