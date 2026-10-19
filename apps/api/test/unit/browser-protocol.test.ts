import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BROWSER_ACTIONS, BROWSER_COMMIT_ACTIONS, BROWSER_READ_ACTIONS, BROWSER_UNKNOWN_TARGET,
  browserCapabilityFor, browserTargetForOrigin, isAllowedNavigationUrl, isBrowserAction,
  isBrowserCommitAction, isBrowserReadAction, originFromBrowserTarget, originOfUrl,
} from '../../src/browser/protocol.js';
import { capabilityFor, originAllows, type GatewayActionType, type GatewayOrigin }
  from '../../src/application/gateway-actions.js';
import { projectBrowserHealth } from '../../src/browser/state.js';
import { SCOPE_GRANT_ACTIONS, SCOPE_GRANT_ACTION_CAPABILITIES, scopeGrantActionFor }
  from '../../src/application/run-scope-grant.js';
import { readInternalTool } from '../../src/workflow/tool-catalog.js';

test('浏览器动作词表：三族划分与能力映射一一对应', () => {
  assert.equal(BROWSER_ACTIONS.length, 12);
  assert.equal(BROWSER_READ_ACTIONS.length, 4);
  assert.equal(BROWSER_COMMIT_ACTIONS.length, 2);
  for (const action of BROWSER_READ_ACTIONS) {
    assert.equal(browserCapabilityFor(action), 'BROWSER_READ', action);
    assert.equal(capabilityFor(action as GatewayActionType), 'BROWSER_READ', action);
    assert.equal(isBrowserReadAction(action), true);
  }
  for (const action of ['BROWSER_NEW_PAGE', 'BROWSER_NAVIGATE', 'BROWSER_CLICK', 'BROWSER_FILL',
    'BROWSER_PRESS_KEY', 'BROWSER_CLOSE_PAGE']) {
    assert.equal(browserCapabilityFor(action), 'BROWSER_ACTION', action);
    assert.equal(capabilityFor(action as GatewayActionType), 'BROWSER_ACTION', action);
    assert.equal(isBrowserReadAction(action), false);
  }
  for (const action of BROWSER_COMMIT_ACTIONS) {
    assert.equal(browserCapabilityFor(action), 'BROWSER_COMMIT', action);
    assert.equal(isBrowserCommitAction(action), true);
  }
  assert.equal(isBrowserAction('COMPUTER_CLICK'), false);
  assert.equal(browserCapabilityFor('COMPUTER_CLICK'), null);
});

test('浏览器工具都在冻结词表里，且能力与动作一致', () => {
  const expected: Record<string, string> = {
    browser_list_pages: 'BROWSER_LIST_PAGES',
    browser_read_page: 'BROWSER_READ_PAGE',
    browser_screenshot: 'BROWSER_SCREENSHOT',
    browser_wait_for: 'BROWSER_WAIT_FOR',
    browser_new_page: 'BROWSER_NEW_PAGE',
    browser_navigate: 'BROWSER_NAVIGATE',
    browser_click: 'BROWSER_CLICK',
    browser_fill: 'BROWSER_FILL',
    browser_press_key: 'BROWSER_PRESS_KEY',
    browser_close_page: 'BROWSER_CLOSE_PAGE',
    browser_submit_form: 'BROWSER_SUBMIT_FORM',
    browser_upload_file: 'BROWSER_UPLOAD_FILE',
  };
  for (const [name, actionType] of Object.entries(expected)) {
    const definition = readInternalTool(name);
    assert.ok(definition !== undefined, `${name} 必须在词表内`);
    assert.equal(definition.actionType, actionType);
    assert.equal(definition.capability, browserCapabilityFor(actionType));
  }
});

test('范围授权只覆盖交互族：提交与上传永远需要单动作批准', () => {
  assert.ok(SCOPE_GRANT_ACTIONS.includes('BROWSER_ACTION'));
  assert.equal(SCOPE_GRANT_ACTIONS.includes('BROWSER_COMMIT'), false);
  assert.equal(SCOPE_GRANT_ACTION_CAPABILITIES.BROWSER_ACTION, 'BROWSER_ACTION');
  assert.equal(SCOPE_GRANT_ACTION_CAPABILITIES.BROWSER_COMMIT, undefined);
  // 六个交互动作在授权层合成同一类，与 COMPUTER_INPUT 同构。
  for (const action of ['BROWSER_NEW_PAGE', 'BROWSER_NAVIGATE', 'BROWSER_CLICK', 'BROWSER_FILL',
    'BROWSER_PRESS_KEY', 'BROWSER_CLOSE_PAGE']) {
    assert.equal(scopeGrantActionFor(action), 'BROWSER_ACTION', action);
  }
  // 提交类不被归一：授权判定看不到这一类，因此范围授权覆盖不到它们。
  assert.equal(scopeGrantActionFor('BROWSER_SUBMIT_FORM'), 'BROWSER_SUBMIT_FORM');
  assert.equal(scopeGrantActionFor('BROWSER_UPLOAD_FILE'), 'BROWSER_UPLOAD_FILE');
});

test('来源边界：会话只读只放行 BROWSER_READ，交互与提交只属于 RUN', () => {
  const sessionRead: GatewayOrigin = { kind: 'AGENT_SESSION_READ', projectId: 'p',
    resourceId: 'r', sessionId: 's', messageId: 'm' };
  const assistantRead: GatewayOrigin = { kind: 'ASSISTANT_READ', projectId: 'p',
    resourceId: 'r', sessionId: 's', messageId: 'm' };
  const run: GatewayOrigin = { kind: 'RUN', runId: 'r', stepId: 's', resourceId: 'r',
    workerId: 'w', workerEpoch: 1n };
  for (const origin of [sessionRead, assistantRead]) {
    assert.equal(originAllows(origin, 'BROWSER_READ_PAGE', 'BROWSER_READ'), true);
    assert.equal(originAllows(origin, 'BROWSER_CLICK', 'BROWSER_ACTION'), false);
    assert.equal(originAllows(origin, 'BROWSER_SUBMIT_FORM', 'BROWSER_COMMIT'), false);
  }
  for (const action of ['BROWSER_READ_PAGE', 'BROWSER_CLICK', 'BROWSER_UPLOAD_FILE'] as const) {
    assert.equal(originAllows(run, action, capabilityFor(action)), true, action);
  }
  // 人工动作与导入不碰浏览器。
  const userAction: GatewayOrigin = { kind: 'USER_ACTION', projectId: 'p', resourceId: 'r' };
  assert.equal(originAllows(userAction, 'BROWSER_READ_PAGE', 'BROWSER_READ'), false);
});

test('健康投影：把内存结论变成与 GET /browser/status 同形的 DTO', () => {
  const dto = projectBrowserHealth({
    status: 'CHROME_MISSING', backendVersion: null, chromeVersion: null, tools: [],
    detail: '未找到 Google Chrome。', remediation: '安装 Chrome 或设置路径。',
  });
  assert.equal(dto.status, 'CHROME_MISSING');
  assert.equal(dto.backend_version, null);
  assert.equal(dto.tool_count, 0);
  assert.equal(dto.remediation, '安装 Chrome 或设置路径。');
  assert.match(dto.updated_at ?? '', /^\d{4}-\d{2}-\d{2}T/);
  const ready = projectBrowserHealth({
    status: 'READY', backendVersion: '1.11.0', chromeVersion: 'Chrome/155',
    tools: ['a', 'b'], detail: 'ok', remediation: null,
  });
  assert.equal(ready.backend_version, '1.11.0');
  assert.equal(ready.tool_count, 2);
  assert.equal(ready.remediation, null);
});

test('目标合成值只接受 origin，且可逆', () => {
  // 主机形式：协议被剥掉，端口保留；非 http(s) 页面（origin 为 null）退到 unknown。
  assert.equal(browserTargetForOrigin('HTTPS://Example.COM'), 'browser://example.com');
  assert.equal(browserTargetForOrigin('http://127.0.0.1:5155/x'), 'browser://127.0.0.1:5155');
  // 调用方传的是 originOfUrl 的结果：非 http(s) 页面的 origin 是字面量 'null'。
  assert.equal(browserTargetForOrigin(originOfUrl('about:blank')), BROWSER_UNKNOWN_TARGET);
  assert.equal(browserTargetForOrigin(originOfUrl('data:text/html,x')), BROWSER_UNKNOWN_TARGET);
  assert.equal(browserTargetForOrigin(null), BROWSER_UNKNOWN_TARGET);
  assert.equal(browserTargetForOrigin(''), BROWSER_UNKNOWN_TARGET);
  assert.equal(originFromBrowserTarget('browser://example.com'), 'example.com');
  assert.equal(originFromBrowserTarget('computer://desktop'), null);
  assert.equal(originOfUrl('https://Example.com/a?b=1'), 'https://example.com');
  assert.equal(originOfUrl('not a url'), null);
});

test('导航只允许 http/https：file 与脚本协议一律拒绝', () => {
  assert.equal(isAllowedNavigationUrl('https://example.com'), true);
  assert.equal(isAllowedNavigationUrl('http://127.0.0.1:8080/x'), true);
  assert.equal(isAllowedNavigationUrl('file:///C:/Windows/win.ini'), false);
  assert.equal(isAllowedNavigationUrl('javascript:alert(1)'), false);
  assert.equal(isAllowedNavigationUrl('data:text/html,<h1>x</h1>'), false);
  assert.equal(isAllowedNavigationUrl('about:blank'), false);
});
