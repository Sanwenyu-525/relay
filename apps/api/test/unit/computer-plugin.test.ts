import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPUTER_ACTION_TYPES,
  capabilityFor,
  isComputerAction,
  originAllows,
  type GatewayActionType,
  type GatewayOrigin,
} from '../../src/application/gateway-actions.js';
import { getAdapterDescriptor } from '../../src/gateway/adapter-metadata.js';
import {
  COMPUTER_DESKTOP_TARGET,
  COMPUTER_ERROR_CODES,
  COMPUTER_FOREGROUND_INPUT_ACTIONS,
  COMPUTER_METHODS,
  COMPUTER_PROTOCOL_VERSION,
  isComputerErrorCode,
  isComputerMethod,
  isForegroundInputAction,
  type ComputerEnvironment,
} from '../../src/computer/protocol.js';
import { isAuthorizationPending, isBlocked, planComputerAction }
  from '../../src/computer/execution-router.js';
import { computerExecute, computerParamsForAction, projectComputerResult,
  MAX_WINDOWS_IN_RESULT } from '../../src/computer/computer-adapter.js';
import { replaceComputerRuntimeClientForTest, shutdownComputerRuntimeClient }
  from '../../src/computer/client-holder.js';
import { ComputerRuntimeClient, ComputerRuntimeError } from '../../src/computer/runtime-client.js';
import {
  ASSISTANT_READ_TOOLS,
  toolTarget,
} from '../../src/application/assistant-readonly-round.js';
import {
  INTERNAL_TOOL_DEFINITIONS,
  declaredToolSpecs,
  readInternalTool,
} from '../../src/workflow/tool-catalog.js';
import { gatewayParamsFor, toolTargetFor, validateToolArguments, ToolRequestRejected,
  type ToolLoopPlan } from '../../src/application/tool-loop.js';
import { SCOPE_GRANT_ACTIONS, SCOPE_GRANT_ACTION_CAPABILITIES, scopeGrantActionFor }
  from '../../src/application/run-scope-grant.js';
import type { JsonObject } from '../../src/infrastructure/json.js';

/* —— 词表与协议投影 ——————————————————————————— */

test('十个 computer 工具全部注册，命名遵守 snake_case 词表约定', () => {
  const names = INTERNAL_TOOL_DEFINITIONS.filter((entry) => entry.name.startsWith('computer_'))
    .map((entry) => entry.name).sort();
  assert.deepEqual(names, [
    'computer_activate_window', 'computer_click', 'computer_double_click', 'computer_drag',
    'computer_get_windows', 'computer_hotkey', 'computer_keypress', 'computer_screenshot',
    'computer_scroll', 'computer_type',
  ]);
  // 每个工具都有 JSON Schema、必填声明与禁止额外属性：模型多带字段必须被拒。
  for (const name of names) {
    const spec = declaredToolSpecs([name])[0]!;
    assert.equal(spec.name, name);
    assert.equal(spec.parameters.type, 'object');
    assert.equal(spec.parameters.additionalProperties, false);
    assert.ok(spec.description.length > 0);
  }
});

test('协议词表与 Rust 侧逐字一致的数量与形状', () => {
  // V1 十个方法 + V2 的环境探测。
  assert.equal(COMPUTER_METHODS.length, 11);
  assert.ok(isComputerMethod('computer.describe_environment'));
  assert.equal(COMPUTER_PROTOCOL_VERSION, 'relay-computer-v1');
  for (const method of COMPUTER_METHODS) assert.ok(isComputerMethod(method));
  for (const code of COMPUTER_ERROR_CODES) assert.ok(isComputerErrorCode(code));
  // V1 十一码 + V2 三码。
  assert.equal(COMPUTER_ERROR_CODES.length, 14);
  for (const code of ['FOREGROUND_NOT_AUTHORIZED', 'ISOLATED_SESSION_UNAVAILABLE',
    'CAPTURE_TARGET_UNAVAILABLE'] as const) {
    assert.ok(isComputerErrorCode(code), `${code} 必须保留在错误词表内`);
  }
  // 前台输入动作合集与词表的能力划分一致。
  assert.equal(COMPUTER_FOREGROUND_INPUT_ACTIONS.length, 8);
  for (const action of COMPUTER_ACTION_TYPES) {
    const isInput = action !== 'COMPUTER_SCREENSHOT' && action !== 'COMPUTER_GET_WINDOWS';
    assert.equal(isForegroundInputAction(action), isInput, `${action} 的前台属性必须一致`);
  }
});

test('只读工具进入会话词表，输入类工具不进入', () => {
  assert.ok(ASSISTANT_READ_TOOLS.includes('computer_screenshot'));
  assert.ok(ASSISTANT_READ_TOOLS.includes('computer_get_windows'));
  for (const name of ['computer_click', 'computer_type', 'computer_keypress', 'computer_hotkey',
    'computer_activate_window', 'computer_drag', 'computer_scroll', 'computer_double_click']) {
    assert.ok(!ASSISTANT_READ_TOOLS.includes(name as never),
      `${name} 是输入类工具，不得出现在会话只读词表`);
  }
});

/* —— 能力与来源判定 ——————————————————————————— */

const runOrigin: GatewayOrigin = { kind: 'RUN', runId: 'r', stepId: 's', workerId: 'w',
  workerEpoch: 1n };
const sessionOrigin: GatewayOrigin = { kind: 'AGENT_SESSION_READ', projectId: 'p',
  resourceId: 'res', sessionId: 'sess', messageId: 'm' };
const userActionOrigin: GatewayOrigin = { kind: 'USER_ACTION', projectId: 'p', resourceId: 'res' };

test('Computer 动作映射到两个能力，来源判定符合「会话只读、Run 全量」', () => {
  assert.equal(capabilityFor('COMPUTER_SCREENSHOT'), 'COMPUTER_READ');
  assert.equal(capabilityFor('COMPUTER_GET_WINDOWS'), 'COMPUTER_READ');
  for (const action of COMPUTER_ACTION_TYPES) {
    if (action === 'COMPUTER_SCREENSHOT' || action === 'COMPUTER_GET_WINDOWS') continue;
    assert.equal(capabilityFor(action), 'COMPUTER_INPUT', `${action} 必须是输入能力`);
  }
  for (const action of COMPUTER_ACTION_TYPES) {
    assert.ok(originAllows(runOrigin, action, capabilityFor(action)),
      `RUN 来源必须允许 ${action}`);
  }
  assert.ok(originAllows(sessionOrigin, 'COMPUTER_SCREENSHOT', 'COMPUTER_READ'));
  assert.ok(originAllows(sessionOrigin, 'COMPUTER_GET_WINDOWS', 'COMPUTER_READ'));
  assert.ok(!originAllows(sessionOrigin, 'COMPUTER_CLICK', 'COMPUTER_INPUT'),
    '会话轮次不得放行桌面输入');
  assert.ok(!originAllows(userActionOrigin, 'COMPUTER_SCREENSHOT', 'COMPUTER_READ'),
    'USER_ACTION 不放行 Computer');
});

test('Computer 适配器描述符：读取可自动、输入必须人工', () => {
  const read = getAdapterDescriptor('COMPUTER_READ');
  assert.equal(read.effectKind, 'READ');
  assert.equal(read.approvalPassthrough, true, '截图/窗口枚举没有可审批的外部效果');
  assert.equal(read.sandboxed, false, '桌面读取不是 OS 沙箱');
  const input = getAdapterDescriptor('COMPUTER_INPUT');
  assert.equal(input.effectKind, 'WRITE');
  assert.equal(input.approvalPassthrough, false,
    '桌面输入与 CLI_RUN 同纪律：不可无人审批自动执行');
  assert.equal(input.resumable, false, '已发生的输入不能盲目重放');
});

/* —— 目标与参数 ——————————————————————————— */

test('Computer 动作的 Gateway 目标是合成值，不是受管根', () => {
  const plan = { canonicalRoot: 'D:\\managed', intent: { connections: {} } } as unknown as ToolLoopPlan;
  const screenshot = readInternalTool('computer_screenshot')!;
  const click = readInternalTool('computer_click')!;
  assert.equal(toolTargetFor(plan, screenshot, {}), COMPUTER_DESKTOP_TARGET);
  assert.equal(toolTargetFor(plan, click, { x: 1, y: 2 }), COMPUTER_DESKTOP_TARGET);
  assert.equal(toolTarget('D:\\managed', 'COMPUTER_GET_WINDOWS', {}), COMPUTER_DESKTOP_TARGET);
  // 文件工具目标不受影响。
  const readFile = readInternalTool('read_file')!;
  assert.notEqual(toolTargetFor(plan, readFile, { relative_path: 'a.ts' }), COMPUTER_DESKTOP_TARGET);
});

test('参数白名单转发：模型多带的字段不会变成运行时参数', () => {
  const click = readInternalTool('computer_click')!;
  assert.deepEqual(gatewayParamsFor(click, { x: 1, y: 2, evil: 'drop' }), { x: 1, y: 2 });
  assert.deepEqual(gatewayParamsFor(click, { x: 1, y: 2, button: 'right' }), { x: 1, y: 2, button: 'right' });
  const scroll = readInternalTool('computer_scroll')!;
  assert.deepEqual(gatewayParamsFor(scroll, { delta_y: -600 }), { delta_y: -600 });
  const hotkey = readInternalTool('computer_hotkey')!;
  assert.deepEqual(gatewayParamsFor(hotkey, { keys: ['CTRL', 'C'] }), { keys: ['CTRL', 'C'] });
  const drag = readInternalTool('computer_drag')!;
  assert.deepEqual(gatewayParamsFor(drag, { start: { x: 1, y: 2 }, end: { x: 3, y: 4 } }),
    { start: { x: 1, y: 2 }, end: { x: 3, y: 4 } });
  const type_ = readInternalTool('computer_type')!;
  assert.deepEqual(gatewayParamsFor(type_, { text: 'hi' }), { text: 'hi' });
  assert.deepEqual(gatewayParamsFor(type_, { text: 'hi', delay_ms: 30 }), { text: 'hi', delay_ms: 30 });
  const screenshot = readInternalTool('computer_screenshot')!;
  assert.deepEqual(gatewayParamsFor(screenshot, { anything: 1 }), {});
});

test('适配器参数规范化拒绝半截与非法坐标', () => {
  assert.deepEqual(computerParamsForAction('COMPUTER_CLICK', { x: 1, y: 2 }), { x: 1, y: 2 });
  assert.throws(() => computerParamsForAction('COMPUTER_CLICK', { x: 1 }),
    (error: unknown) => error instanceof ComputerRuntimeError && error.code === 'INVALID_REQUEST');
  assert.throws(() => computerParamsForAction('COMPUTER_CLICK', { x: 1, y: 2, button: 'double' }),
    (error: unknown) => error instanceof ComputerRuntimeError && error.code === 'INVALID_REQUEST');
  assert.throws(() => computerParamsForAction('COMPUTER_DRAG', { start: { x: 1 }, end: { x: 2, y: 3 } }),
    (error: unknown) => error instanceof ComputerRuntimeError && error.code === 'INVALID_REQUEST');
  assert.throws(() => computerParamsForAction('COMPUTER_HOTKEY', { keys: [] }),
    (error: unknown) => error instanceof ComputerRuntimeError && error.code === 'INVALID_REQUEST');
  assert.throws(() => computerParamsForAction('COMPUTER_TELEPORT', {}),
    (error: unknown) => error instanceof ComputerRuntimeError && error.code === 'INVALID_REQUEST');
});

/* —— 词表层 schema 校验（enum 与嵌套对象） ——————————————————— */

test('computer_click 的 button 是封闭枚举，非法值在落库前被拒', () => {
  const spec = declaredToolSpecs(['computer_click'])[0]!;
  const validated = validateToolArguments(spec, { x: 10, y: 20, button: 'middle' });
  assert.deepEqual(validated, { x: 10, y: 20, button: 'middle' });
  assert.throws(() => validateToolArguments(spec, { x: 10, y: 20, button: 'double' }),
    (error: unknown) => (error as ToolRequestRejected).reason === 'TOOL_ARGUMENT_INVALID');
  assert.throws(() => validateToolArguments(spec, { x: 10, y: 20, zoom: true }),
    (error: unknown) => (error as ToolRequestRejected).reason === 'TOOL_ARGUMENT_UNKNOWN');
  assert.throws(() => validateToolArguments(spec, { x: 1.5, y: 2 }),
    (error: unknown) => (error as ToolRequestRejected).reason === 'TOOL_ARGUMENT_INVALID');
});

test('computer_drag 的坐标点是嵌套对象，缺字段被拒', () => {
  const spec = declaredToolSpecs(['computer_drag'])[0]!;
  const validated = validateToolArguments(spec,
    { start: { x: 1, y: 2 }, end: { x: 3, y: 4 }, duration_ms: 300 });
  assert.deepEqual(validated, { start: { x: 1, y: 2 }, end: { x: 3, y: 4 }, duration_ms: 300 });
  assert.throws(() => validateToolArguments(spec, { start: { x: 1 }, end: { x: 3, y: 4 } }),
    (error: unknown) => (error as ToolRequestRejected).reason === 'TOOL_ARGUMENT_MISSING');
  assert.throws(() => validateToolArguments(spec, { start: { x: 1, y: 2, z: 9 }, end: { x: 3, y: 4 } }),
    (error: unknown) => (error as ToolRequestRejected).reason === 'TOOL_ARGUMENT_UNKNOWN');
  assert.throws(() => validateToolArguments(spec,
    { start: { x: 1, y: 2 }, end: { x: 3, y: 4 }, duration_ms: 99999 }),
    (error: unknown) => (error as ToolRequestRejected).reason === 'TOOL_ARGUMENT_OUT_OF_RANGE');
});

/* —— 结果投影 ———————————————————————————— */

test('截图结果只保留摘要：图片正文不进入账本', () => {
  const raw = Buffer.from('fake-png-bytes');
  const result = projectComputerResult('COMPUTER_SCREENSHOT', {
    type: 'computer_screenshot',
    image: raw.toString('base64'),
    width: 1920, height: 1080, origin_x: 0, origin_y: 0, timestamp: 123,
  });
  assert.equal(result.width, 1920);
  assert.equal(result.height, 1080);
  assert.equal(result.image_bytes, raw.length);
  assert.equal(typeof result.image_sha256, 'string');
  assert.equal((result as Record<string, unknown>).image, undefined,
    'base64 图片不得进入 result_ref');
});

test('mock 回复带 mock 标记透传，不冒充真实桌面状态', () => {
  const result = projectComputerResult('COMPUTER_GET_WINDOWS', {
    windows: [{ id: '1000', title: 'Mock', process_name: null, process_id: 1,
      x: 0, y: 0, width: 10, height: 10, visible: true, focused: true }], mock: true,
  });
  assert.equal(result.mock, true);
  assert.equal(result.count, 1);
});

test('窗口列表有界：超出上限显式截断', () => {
  const windows = Array.from({ length: MAX_WINDOWS_IN_RESULT + 5 }, (_, index) => ({
    id: String(index), title: `w${index}`, process_name: null, process_id: index,
    x: 0, y: 0, width: 1, height: 1, visible: true, focused: false,
  }));
  const result = projectComputerResult('COMPUTER_GET_WINDOWS', { windows });
  assert.equal(result.count, MAX_WINDOWS_IN_RESULT + 5);
  assert.equal((result.windows as unknown[]).length, MAX_WINDOWS_IN_RESULT);
  assert.equal(result.truncated, true);
});

/* —— 派发：受控客户端 ———————————————————————— */

function stubClient(handler: (method: string, params: Record<string, unknown>) =>
  Promise<Record<string, unknown>>): ComputerRuntimeClient {
  return {
    request: (method: never, params: never) => handler(method as string, params),
    // 默认按「本机真实状态」报环境：后台不可用 → 输入类动作必须授权。
    describeEnvironment: () => Promise.resolve(environment()),
  } as unknown as ComputerRuntimeClient;
}

test('派发成功：参数到达运行时，结果投影回传', async () => {
  replaceComputerRuntimeClientForTest(stubClient(async (method, params) => {
    assert.equal(method, 'computer.click');
    assert.deepEqual({ ...params, allow_foreground: undefined }, { x: 5, y: 6,
      allow_foreground: undefined });
    return { clicked: true, x: 5, y: 6 };
  }));
  const outcome = await computerExecute({ actionType: 'COMPUTER_CLICK',
    params: { x: 5, y: 6 } as JsonObject, foregroundAuthorized: true });
  assert.equal(outcome.outcome, 'SUCCEEDED');
  assert.equal(outcome.result.clicked, true);
});

test('派发时运行时不存在：FAILED + RUNTIME_UNAVAILABLE，不抛出', async () => {
  replaceComputerRuntimeClientForTest(stubClient(() =>
    Promise.reject(new ComputerRuntimeError('RUNTIME_UNAVAILABLE', 'runtime gone', true))));
  const outcome = await computerExecute({ actionType: 'COMPUTER_SCREENSHOT', params: {} });
  assert.equal(outcome.outcome, 'FAILED');
  assert.equal(outcome.result.reason, 'RUNTIME_UNAVAILABLE');
  assert.equal(outcome.result.retryable, true);
});

test('效果未知按 UNKNOWN 结算：不把可能已发生的点击算成失败', async () => {
  replaceComputerRuntimeClientForTest(stubClient(() =>
    Promise.reject(new ComputerRuntimeError('IPC_DISCONNECTED', 'reply lost', true, true))));
  const outcome = await computerExecute({ actionType: 'COMPUTER_TYPE',
    params: { text: 'hi' } as JsonObject, foregroundAuthorized: true });
  assert.equal(outcome.outcome, 'UNKNOWN');
  assert.equal(outcome.result.reason, 'COMPUTER_EFFECT_UNCERTAIN');
});

test('参数非法在派发前就是 FAILED，不触碰运行时', async () => {
  replaceComputerRuntimeClientForTest(stubClient(() => {
    throw new Error('must not be called');
  }));
  const outcome = await computerExecute({ actionType: 'COMPUTER_CLICK',
    params: { x: 'left' } as unknown as JsonObject, foregroundAuthorized: true });
  assert.equal(outcome.outcome, 'FAILED');
  assert.equal(outcome.result.reason, 'INVALID_REQUEST');
});

/* —— 范围授权（Allow for task） ——————————————————— */

test('Computer 输入八动作在授权层合成一类，读取类不占授权', () => {
  for (const action of COMPUTER_ACTION_TYPES) {
    const grantAction = scopeGrantActionFor(action);
    if (action === 'COMPUTER_SCREENSHOT' || action === 'COMPUTER_GET_WINDOWS') {
      assert.equal(grantAction, action, '读取类不需要授权，保持原动作名');
    } else {
      assert.equal(grantAction, 'COMPUTER_INPUT');
    }
  }
  assert.ok(SCOPE_GRANT_ACTIONS.includes('COMPUTER_INPUT'));
  assert.equal(SCOPE_GRANT_ACTION_CAPABILITIES.COMPUTER_INPUT, 'COMPUTER_INPUT');
  // 文件类动作不受影响。
  assert.equal(scopeGrantActionFor('APPLY_CHANGESET'), 'APPLY_CHANGESET');
  assert.equal(scopeGrantActionFor('CLI_RUN'), 'CLI_RUN');
});

/* —— V2 执行路由（Phase 2） ——————————————————————— */

/** 构造探测结果：默认「后台不可用、独立会话不可用、前台需授权」——即本机真实状态。 */
function environment(overrides: {
  browserCdp?: boolean; uiAutomation?: boolean; isolated?: boolean;
} = {}): ComputerEnvironment {
  return {
    platform: 'windows',
    dpi_awareness: 'PER_MONITOR_AWARE_V2',
    virtual_screen: { x: 0, y: 0, width: 1920, height: 1080 },
    monitors: [{ x: 0, y: 0, width: 1920, height: 1080, primary: true }],
    child_session: { enabled: true, enabled_query_ok: true,
      available: overrides.isolated === true, session_id: overrides.isolated === true ? 3 : null },
    ui_automation: { client_library_loadable: true,
      provider_implemented: overrides.uiAutomation === true, already_loaded: false },
    mode_availability: {
      background: { status: overrides.browserCdp === true || overrides.uiAutomation === true
        ? 'available' : 'unavailable',
        browser_cdp: overrides.browserCdp === true ? 'available' : 'not_configured',
        ui_automation: overrides.uiAutomation === true ? 'available' : 'provider_not_implemented' },
      isolated: { status: overrides.isolated === true ? 'available' : 'unavailable', reason: null },
      foreground: { status: 'requires_user_authorization' },
    },
  };
}

test('只读动作不需要前台授权；不可用的目标明确拒绝而不是退回用户桌面', () => {
  const env = environment();
  const desktop = planComputerAction({ actionType: 'COMPUTER_SCREENSHOT', environment: env,
    foregroundAuthorized: false, captureTarget: 'user_desktop' });
  assert.equal(isBlocked(desktop), false);
  assert.equal(desktop.coordinateSpace, 'user_desktop');

  const win = planComputerAction({ actionType: 'COMPUTER_SCREENSHOT', environment: env,
    foregroundAuthorized: false, captureTarget: 'window' });
  assert.equal(isBlocked(win), false);
  assert.equal(win.coordinateSpace, 'window');

  const isolated = planComputerAction({ actionType: 'COMPUTER_SCREENSHOT', environment: env,
    foregroundAuthorized: false, captureTarget: 'agent_session' });
  assert.equal(isBlocked(isolated), true);
  assert.equal(isolated.refusal?.code, 'ISOLATED_SESSION_UNAVAILABLE');
  assert.equal(isolated.refusal?.message.includes('不退回'), true,
    '拒绝原因必须写明不会退回截取用户桌面');

  const browser = planComputerAction({ actionType: 'COMPUTER_SCREENSHOT', environment: env,
    foregroundAuthorized: false, captureTarget: 'browser_page' });
  assert.equal(browser.refusal?.code, 'CAPTURE_TARGET_UNAVAILABLE');
});

test('输入动作在后台路径不可用时是「需要授权」而不是「静默执行」', () => {
  const env = environment();
  const pending = planComputerAction({ actionType: 'COMPUTER_CLICK', environment: env,
    foregroundAuthorized: false });
  assert.equal(isAuthorizationPending(pending), true);
  assert.equal(isBlocked(pending), false, '需要授权不是不可执行');
  assert.equal(pending.mode, 'foreground');
  assert.equal(pending.requiresUserAuthorization, true);

  const authorized = planComputerAction({ actionType: 'COMPUTER_CLICK', environment: env,
    foregroundAuthorized: true });
  assert.equal(authorized.mode, 'foreground');
  assert.equal(authorized.refusal, undefined);
});

test('路由优先级：UIA 可用走后台，独立工作区可用走 isolated', () => {
  const uia = planComputerAction({ actionType: 'COMPUTER_CLICK',
    environment: environment({ uiAutomation: true }), foregroundAuthorized: false });
  assert.equal(uia.mode, 'background');
  assert.equal(uia.provider, 'ui_automation');
  assert.equal(uia.refusal, undefined, 'UIA 可用时不需要用户接管');

  const isolated = planComputerAction({ actionType: 'COMPUTER_SCREENSHOT',
    environment: environment({ isolated: true }), foregroundAuthorized: false,
    captureTarget: 'agent_session' });
  assert.equal(isolated.mode, 'isolated');
  assert.equal(isBlocked(isolated), false);
});

test('探测失败按最保守假设：后台一律不可用，输入仍需授权', () => {
  const plan = planComputerAction({ actionType: 'COMPUTER_TYPE', environment: null,
    foregroundAuthorized: false });
  assert.equal(plan.mode, 'foreground');
  assert.equal(isAuthorizationPending(plan), true);
  const read = planComputerAction({ actionType: 'COMPUTER_GET_WINDOWS', environment: null,
    foregroundAuthorized: false });
  assert.equal(isBlocked(read), false, '窗口枚举是只读，探测失败不影响');
});

test('派发时注入前台授权；未授权时拒绝执行真实输入', async () => {
  let received: Record<string, unknown> | undefined;
  replaceComputerRuntimeClientForTest({
    request: (_method: never, params: never) => {
      received = params as Record<string, unknown>;
      return Promise.resolve({ clicked: true });
    },
    describeEnvironment: () => Promise.resolve(environment()),
  } as unknown as ComputerRuntimeClient);
  // 已授权（Gateway 批准/范围授权后的派发路径）。
  const ok = await computerExecute({ actionType: 'COMPUTER_CLICK',
    params: { x: 5, y: 6 } as JsonObject, foregroundAuthorized: true });
  assert.equal(ok.outcome, 'SUCCEEDED');
  assert.equal(received?.allow_foreground, true, '派发必须带上运行时侧的硬闸门参数');
  // 未授权：不允许执行真实输入。
  const refused = await computerExecute({ actionType: 'COMPUTER_CLICK',
    params: { x: 5, y: 6 } as JsonObject });
  assert.equal(refused.outcome, 'FAILED');
  assert.equal(refused.result.reason, 'FOREGROUND_REQUIRES_AUTHORIZATION');
  assert.equal(refused.result.requires_user_action, true);
  // 只读动作不注入该参数。
  await computerExecute({ actionType: 'COMPUTER_GET_WINDOWS', params: {} });
  assert.equal('allow_foreground' in (received ?? {}), false,
    '只读动作不得携带前台授权参数');
});

test('不可用的截图目标在派发前就被类型化拒绝', async () => {
  replaceComputerRuntimeClientForTest({
    request: () => { throw new Error('must not be called'); },
    describeEnvironment: () => Promise.resolve(environment()),
  } as unknown as ComputerRuntimeClient);
  const blocked = await computerExecute({ actionType: 'COMPUTER_SCREENSHOT',
    params: { target: 'agent_session' } as JsonObject });
  assert.equal(blocked.outcome, 'FAILED');
  assert.equal(blocked.result.reason, 'ISOLATED_SESSION_UNAVAILABLE');
  assert.equal(blocked.result.requires_user_action, true);
});

test('截图目标的词表与规范化：非法目标在落库前被拒', () => {
  const spec = declaredToolSpecs(['computer_screenshot'])[0]!;
  const validated = validateToolArguments(spec, { target: 'window', window_id: '123' });
  assert.deepEqual(validated, { target: 'window', window_id: '123' });
  assert.throws(() => validateToolArguments(spec, { target: 'screen' }),
    (error: unknown) => (error as ToolRequestRejected).reason === 'TOOL_ARGUMENT_INVALID');
  // 规范化转发：只放行声明过的字段。
  assert.deepEqual(gatewayParamsFor(readInternalTool('computer_screenshot')!,
    { target: 'user_desktop', evil: 'drop' }), { target: 'user_desktop' });
  assert.deepEqual(gatewayParamsFor(readInternalTool('computer_screenshot')!, {}), {});
});

test.after(() => {
  shutdownComputerRuntimeClient();
});
