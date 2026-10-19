import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePages, parseSnapshotText, pngSize } from '../../src/browser/snapshot-parse.js';

test('页面列表：结构化结果优先，文本解析作为回退', () => {
  const structured = { pages: [
    { id: 1, url: 'about:blank', title: '', selected: false },
    { id: 2, url: 'https://example.com/x', title: 'Example', selected: true },
  ] };
  assert.deepEqual(parsePages(structured, 'ignored'), [
    { pageId: 1, url: 'about:blank', title: '' },
    { pageId: 2, url: 'https://example.com/x', title: 'Example' },
  ]);
  // structuredContent 缺失（上游换版本或关闭该选项）时退回文本。
  const text = ['## Pages', '1: about:blank', '2: Example (https://example.com/x) [selected]']
    .join('\n');
  assert.deepEqual(parsePages(undefined, text), [
    { pageId: 1, url: 'about:blank', title: '' },
    { pageId: 2, url: 'https://example.com/x', title: 'Example' },
  ]);
  assert.deepEqual(parsePages({ pages: 'nope' }, ''), []);
});

test('快照文本：uid、角色、名称与缩进层级', () => {
  const text = [
    '## Latest page snapshot',
    'uid=1_0 RootWebArea url="https://example.com/form"',
    '  uid=1_1 heading "Sign in" level="1"',
    '  uid=1_2 form',
    '    uid=1_3 textbox "Email"',
    '    uid=1_4 button "Submit"',
    '  uid=1_5 link "Help"',
  ].join('\n');
  const parsed = parseSnapshotText(text);
  assert.equal(parsed.url, 'https://example.com/form');
  assert.deepEqual(parsed.elements, [
    { uid: '1_0', role: 'RootWebArea', name: '', inForm: false },
    { uid: '1_1', role: 'heading', name: 'Sign in', inForm: false },
    { uid: '1_2', role: 'form', name: '', inForm: false },
    { uid: '1_3', role: 'textbox', name: 'Email', inForm: true },
    { uid: '1_4', role: 'button', name: 'Submit', inForm: true },
    // 退出 form 层级后不再算"在表单里"：祖先链而不是"曾经出现过 form"。
    { uid: '1_5', role: 'link', name: 'Help', inForm: false },
  ]);
});

test('快照文本：没有角色的节点只保留名称（实测 1.11.0 形状）', () => {
  const text = [
    'uid=1_0 RootWebArea "Relay Fixture" url="http://127.0.0.1:4839/"',
    '  uid=1_2 form',
    '    uid=1_3 "关键词 "',
    '    uid=1_4 textbox "关键词"',
  ].join('\n');
  const parsed = parseSnapshotText(text);
  assert.equal(parsed.title, 'Relay Fixture');
  assert.deepEqual(parsed.elements, [
    { uid: '1_0', role: 'RootWebArea', name: 'Relay Fixture', inForm: false },
    { uid: '1_2', role: 'form', name: '', inForm: false },
    // 没有角色的静态文本：角色记为 generic，名称保留，仍算在表单里。
    { uid: '1_3', role: 'generic', name: '关键词', inForm: true },
    { uid: '1_4', role: 'textbox', name: '关键词', inForm: true },
  ]);
});

test('快照文本：引号转义与空快照', () => {
  const parsed = parseSnapshotText('uid=2_0 RootWebArea url="https://a.test/x"');
  assert.equal(parsed.url, 'https://a.test/x');
  const quoted = parseSnapshotText('uid=2_1 button "say \\"hi\\""');
  assert.equal(quoted.elements[0]?.name, 'say "hi"');
  assert.deepEqual(parseSnapshotText('').elements, []);
});

test('PNG 头部宽高解析：非 PNG 返回 null', () => {
  // 手工构造一个 24 字节的 PNG 头：签名 + IHDR 长度/类型 + 宽高。
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(1280, 16);
  buffer.writeUInt32BE(720, 20);
  assert.deepEqual(pngSize(buffer.toString('base64')), { width: 1280, height: 720 });
  assert.equal(pngSize(Buffer.from('not a png at all, definitely not').toString('base64')), null);
  assert.equal(pngSize(''), null);
});
