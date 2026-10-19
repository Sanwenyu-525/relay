import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyClick } from '../../src/browser/risk.js';
import type { BrowserElement } from '../../src/browser/provider.js';

function element(partial: Partial<BrowserElement> & { uid: string }): BrowserElement {
  return { uid: partial.uid, role: partial.role ?? 'button',
    name: partial.name ?? '', inForm: partial.inForm ?? false };
}

test('提交控件：表单内的按钮按 HIGH 升级', () => {
  const elements = [
    element({ uid: '1_0', role: 'RootWebArea' }),
    element({ uid: '1_2', role: 'form' }),
    element({ uid: '1_4', role: 'textbox', name: '关键词', inForm: true }),
    element({ uid: '1_5', role: 'button', name: '提交查询', inForm: true }),
    element({ uid: '1_6', role: 'link', name: '普通链接' }),
  ];
  const verdict = classifyClick(elements, '1_5');
  assert.equal(verdict.risk, 'HIGH');
  assert.match(verdict.reason, /提交/);
});

test('不在表单里的普通按钮按 LOW 放行', () => {
  const elements = [element({ uid: '1_5', role: 'button', name: '展开菜单' })];
  assert.equal(classifyClick(elements, '1_5').risk, 'LOW');
});

test('中英提交动词都命中，不问它是否在表单里', () => {
  for (const name of ['Submit', 'SEND MESSAGE', 'Buy now', '删除账号', '确认支付',
    'Place order', 'unsubscribe']) {
    const verdict = classifyClick([element({ uid: 'x', name })], 'x');
    assert.equal(verdict.risk, 'HIGH', name);
    assert.match(verdict.reason, /提交|发送|支付|删除|确认|Order|unsub/i);
  }
});

test('拿不准时不升级：链接、输入框、无名称按钮都不算提交', () => {
  assert.equal(classifyClick([element({ uid: 'a', role: 'link', name: '下一页' })], 'a').risk, 'LOW');
  assert.equal(classifyClick([element({ uid: 'b', role: 'textbox', name: '邮箱',
    inForm: true })], 'b').risk, 'LOW');
  assert.equal(classifyClick([element({ uid: 'c', role: 'button', name: '' })], 'c').risk, 'LOW');
});

test('uid 不在快照里：按 LOW 处理，让动作自己失败', () => {
  const verdict = classifyClick([element({ uid: '1_5', name: 'Submit', inForm: true })], '9_9');
  assert.equal(verdict.risk, 'LOW');
  assert.match(verdict.reason, /不存在/);
});
