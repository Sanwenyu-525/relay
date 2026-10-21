import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { startTestApi, workspacePath } from './api-harness.js';

/**
 * 插件运行时状态端点（2026-10-20，P0-2）。
 *
 * 锁三件事：三个内置插件恒在（不因为「没有项目」或「没装」而整块消失）、状态词表属于
 * 约定的五态、响应里不出现任何凭据。真实 `gh` 登录态与真实浏览器/电脑运行时的组合
 * 不在这一例里断言——那取决于本机装了什么，断言具体值会把测试写成环境探测。
 */
test('PL-01: GET /plugins/status 返回三个插件的安装级状态，且不泄漏凭据', async () => {
  const api = await startTestApi();
  try {
    const workspaceId = randomUUID();
    const response = await api.get(workspacePath(workspaceId, '/plugins/status'));
    assert.equal(response.status, 200, response.text);
    const items = (response.body as { items: { plugin: string; state: string; detail: string;
      remediation: string | null }[] }).items;
    assert.deepEqual(items.map((item) => item.plugin), ['computer', 'browser', 'github']);
    const states = ['READY', 'NOT_INSTALLED', 'NOT_PAIRED', 'NOT_AUTHENTICATED', 'UNAVAILABLE'];
    for (const item of items) {
      assert.ok(states.includes(item.state), `${item.plugin} 的状态落在约定词表内：${item.state}`);
      assert.equal(typeof item.detail, 'string');
      assert.ok(item.detail.length > 0, `${item.plugin} 必须给出可读说明`);
      assert.ok(item.remediation === null || typeof item.remediation === 'string');
    }
    // 这是只读投影：不能把进程里的任何凭据带出来。
    assert.equal(/bearer|api[_-]?key|token=|password/i.test(response.text), false);
  } finally { await api.stop(); }
});
