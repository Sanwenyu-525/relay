import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chatImageInputAccepted, chatImageInputRejection, decideChatImageInput,
} from '../../src/application/chat-image-input.js';

// 2026-10-19：图片输入能力的判定抽成一份，发送闸门与 /model-port 的提前说明共用。
// 这里锁的是四层优先级（目录 > 声明表 > 环境变量 > 拒绝）与「同一组输入必然同一结论」。

test('目录条目是唯一准绳：声明不能把目录判定的「不支持」改成支持', () => {
  assert.deepEqual(decideChatImageInput({ configured: true,
    catalogEntry: { imageInput: true }, declared: false }), { state: 'SUPPORTED', source: 'CATALOG' });
  // 目录说不能，即使有人声明能、env 也开着，仍然拒绝。
  assert.deepEqual(decideChatImageInput({ configured: true,
    catalogEntry: { imageInput: false }, declaration: true, declared: true }),
  { state: 'MODEL_LACKS_IMAGE_INPUT', source: 'CATALOG' });
  // 能力未知（null）同样按不支持处理：未知不等于可用。
  assert.deepEqual(decideChatImageInput({ configured: true,
    catalogEntry: { imageInput: null }, declared: true }),
  { state: 'MODEL_LACKS_IMAGE_INPUT', source: 'CATALOG' });
});

test('目录没有条目时按声明表裁决，声明压过环境变量', () => {
  assert.deepEqual(decideChatImageInput({ configured: true,
    declaration: true, declared: false }), { state: 'DECLARED', source: 'DECLARED' });
  // 声明为「不支持」也是一条明确主张：state 与「模型不支持」一致，但来源是人的声明。
  assert.deepEqual(decideChatImageInput({ configured: true,
    declaration: false, declared: true }),
  { state: 'MODEL_LACKS_IMAGE_INPUT', source: 'DECLARED' });
});

test('既无目录条目也无声明时，环境变量仍能放行（兼容期）', () => {
  assert.deepEqual(decideChatImageInput({ configured: true, declared: true }),
    { state: 'DECLARED', source: 'ENV' });
  assert.deepEqual(decideChatImageInput({ configured: true, declared: false }),
    { state: 'MODEL_NOT_IN_CATALOG', source: 'NONE' });
});

test('没有真实模型端口时单独一档：不是「模型不支持」，而是根本没配模型', () => {
  assert.deepEqual(decideChatImageInput({ configured: false, declared: true }),
    { state: 'NOT_CONFIGURED', source: 'NONE' });
});

test('放行与拒绝一一对应，拒绝文案与闸门抛出的一致', () => {
  for (const state of ['SUPPORTED', 'DECLARED'] as const) {
    assert.equal(chatImageInputAccepted(state), true);
    assert.equal(chatImageInputRejection(state), null);
  }
  for (const state of ['MODEL_LACKS_IMAGE_INPUT', 'MODEL_NOT_IN_CATALOG', 'NOT_CONFIGURED'] as const) {
    assert.equal(chatImageInputAccepted(state), false);
    assert.ok((chatImageInputRejection(state) ?? '').length > 0);
  }
  // 自建模型的出路必须写在文案里：换模型或声明，二者之一。
  assert.match(String(chatImageInputRejection('MODEL_NOT_IN_CATALOG')), /声明该模型接受图片输入/u);
  assert.equal(chatImageInputRejection('MODEL_LACKS_IMAGE_INPUT'),
    '当前聊天模型不支持图片输入，不能发送图片附件。');
});
