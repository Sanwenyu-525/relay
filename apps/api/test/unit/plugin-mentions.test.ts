import assert from 'node:assert/strict';
import test from 'node:test';

import { detectMachineActionIntent, findKnownPluginMentions,
  isMachineCapabilityQuestion, KNOWN_PLUGIN_MENTIONS }
  from '../../src/application/plugin-mentions.js';

/**
 * 服务端插件 mention 识别（2026-11-01 COMPUTER-PLUGIN-E2E）。
 *
 * 只锁识别边界：标签集合、`@` 前/后的词边界与相邻 mention。识别不是授权，
 * 也不产生执行请求。
 */

test('三个内置插件标签都可识别，并与工作台展示集合一致', () => {
  assert.deepEqual(KNOWN_PLUGIN_MENTIONS.map((entry) => entry.label),
    ['电脑操控', '浏览器操控', 'GitHub']);
  const matches = findKnownPluginMentions('@电脑操控 打开记事本，再用 @浏览器操控 看页面');
  assert.deepEqual(matches.map((entry) => [entry.key, entry.label]),
    [['computer', '电脑操控'], ['browser', '浏览器操控']]);
});

test('不把邮箱、路径或更长词的一部分识别成插件选择', () => {
  for (const text of ['user@GitHub', 'src/@x', '@GitHubX', '@电脑操控一下']) {
    assert.deepEqual(findKnownPluginMentions(text), [], text);
  }
});

test('相邻 mention 与句首 mention 正常识别', () => {
  const matches = findKnownPluginMentions('@GitHub@浏览器操控 都看一下');
  assert.equal(matches.length, 2);
  assert.equal(matches[0]?.key, 'github');
  assert.equal(matches[1]?.key, 'browser');
  assert.equal(findKnownPluginMentions('请用 @电脑操控 打开记事本')[0]?.key, 'computer');
});

test('能力询问只降级候选，不把命令式请求当成问题', () => {
  for (const text of ['@电脑操控 能不能打开记事本？', '电脑插件可不可以打开记事本？',
    '这个插件是否支持打开应用？', '@电脑操控 怎么打开记事本？']) {
    assert.equal(isMachineCapabilityQuestion(text), true, text);
  }
  // 「可以吗？」是征询确认，不是能力询问；仍按命令式执行链路处理。
  for (const text of ['@电脑操控 打开记事本', '请帮我打开记事本', '打开记事本，可以吗？']) {
    assert.equal(isMachineCapabilityQuestion(text), false, text);
  }
});

test('机器操作意图：普通聊天不触发信封修复', () => {
  for (const text of ['你好', '谢谢', '好的', '', '   ', '今天天气怎么样',
    '这个项目现在什么状态', '帮我看看 README']) {
    assert.equal(detectMachineActionIntent(text), false, text);
  }
});

test('机器操作意图：显式插件选择或明确动作请求触发', () => {
  for (const text of ['@电脑操控 你好', '@浏览器操控 看一下这个页面',
    '请帮我打开记事本', '打开浏览器', '把窗口关掉', '帮我截图',
    '点击右上角的按钮', '在输入框里输入 hello', '打开记事本可以吗？']) {
    assert.equal(detectMachineActionIntent(text), true, text);
  }
});

test('机器操作意图：询问、讨论与文件/文字动作不算', () => {
  for (const text of ['怎么打开记事本', '能不能打开记事本？',
    '这个插件是否支持打开应用？', '打开项目目录', '打开文件', '复制这段代码',
    '看看键盘布局的实现', '介绍一下浏览器插件']) {
    assert.equal(detectMachineActionIntent(text), false, text);
  }
});
