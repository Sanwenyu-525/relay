import test from 'node:test';
import assert from 'node:assert/strict';

import { describeComputerAction } from '../../src/computer/action-labels.js';

/** 状态条「当前操作」文案：来自真实动作参数，不虚构应用名。 */
test('describeComputerAction 按动作类型与参数生成当前操作文案', () => {
  assert.equal(describeComputerAction('COMPUTER_SCREENSHOT', {}), '正在截取屏幕画面');
  assert.equal(describeComputerAction('COMPUTER_CLICK', { x: 120, y: 340 }), '正在点击 (120, 340)');
  assert.equal(describeComputerAction('COMPUTER_CLICK', {}), '正在点击 (…, …)');
  assert.equal(describeComputerAction('COMPUTER_TYPE', { text: '你好世界' }), '正在输入内容（4 字符）');
  assert.equal(describeComputerAction('COMPUTER_TYPE', {}), '正在输入内容');
  assert.equal(describeComputerAction('COMPUTER_KEYPRESS', { key: 'Enter' }), '正在按键 Enter');
  assert.equal(describeComputerAction('COMPUTER_HOTKEY', { keys: ['Ctrl', 'C'] }), '正在按组合键 Ctrl+C');
  assert.equal(describeComputerAction('COMPUTER_SCROLL', {}), '正在滚动页面');
  assert.equal(describeComputerAction('COMPUTER_UNKNOWN', {}), 'Relay 正在操作电脑');
});
