import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPOSER_MAX_OUTLINE_ITEMS,
  ComposerOutlineRejected,
  ComposerPolishRejected,
  buildOutline,
  codePointLength,
  hasLineBreak,
  looksLikeSlashCommand,
  outlineEligible,
  parsePolishedText,
  reconstructOutline,
} from '../../src/workflow/composer-draft.js';

/**
 * 输入框草稿辅助的协议与切片（测试计划 §31 CO-02/CO-03 的确定性部分）。
 *
 * 这些断言不依赖任何模型：它们证明「程序新增格式可被精确撤销」是构造出来的，
 * 而不是靠比对模型输出猜出来的。语义质量（模型是否切在正确的位置）不在本文件，
 * 见 §31 对真实 Provider 样本的单独要求。
 */

const DOC_EXAMPLE = '给登录页加个记住密码，密码输错了要提示原因，还有登录按钮现在太小了改大一点，'
  + '手机上也要能正常显示，先不要做短信登录';

test('文档示例：只加编号与换行，去掉程序格式可逐字重建原文', () => {
  const outline = buildOutline(DOC_EXAMPLE, '{"breaks":[11,22,38,49]}');
  assert.ok(outline !== null);
  assert.equal(outline.itemCount, 5);
  assert.equal(outline.text, [
    '1. 给登录页加个记住密码，',
    '2. 密码输错了要提示原因，',
    '3. 还有登录按钮现在太小了改大一点，',
    '4. 手机上也要能正常显示，',
    '5. 先不要做短信登录',
  ].join('\n'));
  // 「先不要做短信登录」必须原样留在最后一条，不能被改写成待实施项。
  assert.ok(outline.text.includes('先不要做短信登录'));
  assert.equal(reconstructOutline(outline.text), DOC_EXAMPLE);
});

test('原话保真：重复句、标点、空白、路径、URL、代码、emoji 都逐字保留', () => {
  const cases: readonly (readonly [string, string])[] = [
    // 重复句：位置由序号决定，不靠内容匹配，重复内容不会串位。
    ['改按钮，改按钮，再改一次按钮', '{"breaks":[4,8]}'],
    // 空白与标点原样保留：程序不做 trim，也不归一标点。
    ['先读 src/a.ts ，然后改 config.json  ', '{"breaks":[15]}'],
    // 路径与 URL 不被拆坏。
    ['看一下 https://example.com/a?b=1 这个链接，再改 apps/api/src/main.ts', '{"breaks":[31]}'],
    // emoji（代理对）边界按码点计，不会切开半个字符。
    ['修好登录页 🐛 这个报错，再加一条日志', '{"breaks":[14]}'],
    // 无标点的连续需求。
    ['加个记住密码 密码输错了要提示原因 按钮改大一点', '{"breaks":[8,19]}'],
  ];
  for (const [text, raw] of cases) {
    const outline = buildOutline(text, raw);
    assert.ok(outline !== null, `expected an outline for ${text}`);
    assert.equal(reconstructOutline(outline.text), text, `fidelity failed for ${text}`);
  }
});

test('emoji 按码点计数：序号落在字符边界上，不产生半个代理对', () => {
  const text = 'a🐛b🐛c';
  assert.equal(codePointLength(text), 5);
  const outline = buildOutline(text, '{"breaks":[2,4]}');
  assert.ok(outline !== null);
  assert.deepEqual(outline.text.split('\n'), ['1. a🐛', '2. b🐛', '3. c']);
  assert.equal(reconstructOutline(outline.text), text);
});

test('畸形边界整条拒绝，不产生部分分点', () => {
  const reject = (raw: string, code: string, text = DOC_EXAMPLE): void => {
    assert.throws(() => buildOutline(text, raw),
      (error: unknown) => error instanceof ComposerOutlineRejected && error.code === code,
      `expected rejection ${code} for ${raw}`);
  };
  reject('不是 JSON', 'OUTLINE_NOT_JSON');
  reject('[1,2]', 'OUTLINE_NOT_OBJECT');
  reject('{"breaks":[11],"note":"顺手润色了"}', 'OUTLINE_UNEXPECTED_FIELDS');
  reject('{"breaks":"11"}', 'OUTLINE_BREAKS_MISSING');
  reject('{"breaks":[11.5]}', 'OUTLINE_BREAK_NOT_INTEGER');
  reject('{"breaks":[0]}', 'OUTLINE_BREAK_OUT_OF_RANGE');
  reject('{"breaks":[57]}', 'OUTLINE_BREAK_OUT_OF_RANGE');
  reject('{"breaks":[11,11]}', 'OUTLINE_BREAK_NOT_INCREASING');
  reject('{"breaks":[49,22]}', 'OUTLINE_BREAK_NOT_INCREASING');
  reject(`{"breaks":[${Array.from({ length: COMPOSER_MAX_OUTLINE_ITEMS },
    (_unused, index) => index + 1).join(',')}]}`, 'OUTLINE_BREAK_COUNT_EXCEEDED');
  // 只含空白的条目：边界落在空白两侧，程序不 trim，因此整条建议被拒绝。
  reject('{"breaks":[2,3]}', 'OUTLINE_SEGMENT_BLANK', 'a  b');
});

test('空边界是合法回答：表示没有合理分点，而不是畸形', () => {
  assert.equal(buildOutline(DOC_EXAMPLE, '{"breaks":[]}'), null);
});

test('润色协议：只接受非空 text，空结果与非法响应都拒绝（拒绝 ≠ 清空草稿）', () => {
  assert.equal(parsePolishedText('{"text":"  精简后的草稿  "}'), '精简后的草稿');
  assert.throws(() => parsePolishedText('{"text":""}'),
    (error: unknown) => error instanceof ComposerPolishRejected && error.code === 'POLISH_TEXT_MISSING');
  assert.throws(() => parsePolishedText('{"text":"   "}'),
    (error: unknown) => error instanceof ComposerPolishRejected && error.code === 'POLISH_TEXT_MISSING');
  assert.throws(() => parsePolishedText('{"text":123}'),
    (error: unknown) => error instanceof ComposerPolishRejected && error.code === 'POLISH_TEXT_MISSING');
  assert.throws(() => parsePolishedText('{"text":"a","summary":"b"}'),
    (error: unknown) => error instanceof ComposerPolishRejected && error.code === 'POLISH_UNEXPECTED_FIELDS');
  assert.throws(() => parsePolishedText('不是 JSON'),
    (error: unknown) => error instanceof ComposerPolishRejected && error.code === 'POLISH_NOT_JSON');
  assert.throws(() => parsePolishedText(JSON.stringify({ text: 'x'.repeat(8001) })),
    (error: unknown) => error instanceof ComposerPolishRejected && error.code === 'POLISH_TEXT_TOO_LONG');
});

test('适用性：短输入、已分行、斜杠命令与空文都不自动分点', () => {
  assert.equal(outlineEligible('太短'), false);
  assert.equal(outlineEligible('       '), false);
  assert.equal(outlineEligible('/review 这个改动'), false);
  assert.equal(outlineEligible('  /clear'), false);
  assert.equal(outlineEligible('第一行\n第二行也要改，而且还有第三件事'), false);
  assert.equal(outlineEligible('第一行\r\n第二行也要改，而且还有第三件事'), false);
  assert.equal(outlineEligible('给登录页加个记住密码，密码输错了要提示原因'), true);
  assert.equal(hasLineBreak('a\r\nb'), true);
  assert.equal(looksLikeSlashCommand('a/b'), false);
});
