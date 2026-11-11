import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isTrivialConversationTurn } from '../../src/application/trivial-turn.js';

/**
 * 纯寒暄轮判据（2026-11-10）。
 *
 * 它只用于掐掉辅助外呼（标题、记忆提取），不参与主流程路由；因此这里同时锁住
 * 「该省的」和「不能误伤的」两侧：带任何具体内容的句子都必须返回 false。
 */

test('寒暄轮：纯问候、致谢、确认整句命中', () => {
  for (const text of ['你好', '您好！', 'hi', 'Hello.', '在吗？', '早上好',
    '谢谢', '谢谢你！', '谢谢，辛苦了', '多谢了', '好的', 'OK', '嗯嗯', '收到。',
    '再见', '辛苦了，谢谢']) {
    assert.equal(isTrivialConversationTurn(text), true, `应当判为寒暄：${text}`);
  }
});

test('寒暄轮：带任何具体内容的句子都不算', () => {
  for (const text of [
    '你好，帮我看看登录接口',
    '谢谢，刚才那个 bug 修好了吗',
    '好的，打开浏览器',
    '收到，改 README 的安装步骤',
    '你好呀，介绍一下这个项目',
    '打开记事本',
    '今天我们决定用 PostgreSQL 做唯一业务数据库。',
    '帮我截图',
    'README',
  ]) {
    assert.equal(isTrivialConversationTurn(text), false, `不应判为寒暄：${text}`);
  }
});

test('寒暄轮：超长、空串与纯标点都不算', () => {
  assert.equal(isTrivialConversationTurn(''), false);
  assert.equal(isTrivialConversationTurn('   '), false);
  assert.equal(isTrivialConversationTurn('！！！'), false);
  assert.equal(isTrivialConversationTurn('你好'.repeat(20)), false);
});
