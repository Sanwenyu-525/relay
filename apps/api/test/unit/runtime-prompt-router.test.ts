import assert from 'node:assert/strict';
import test from 'node:test';

import { assistantSystemPrompt } from '../../src/application/assistant-readonly-round.js';
import { INTERPRETATION_SYSTEM_PROMPT } from '../../src/application/conversation-execution.js';
import { STATE_MAINTENANCE_SYSTEM_PROMPT } from '../../src/application/conversation-state.js';
import { learningSystemPrompt } from '../../src/application/learning-round.js';
import { FIRST_PARTY_REGISTRY } from '../../src/skills/first-party-registry.js';
import { BUILTIN_METHOD_REGISTRY } from '../../src/skills/builtin-methods.js';
import { RELAY_AGENT_CORE_PROMPT } from '../../src/workflow/agent-system-prompt.js';
import { CANDIDATE_OUTPUT_SCHEMA } from '../../src/workflow/markdown-deliverable.js';
import { OpenAiCompatibleModelPort } from '../../src/workflow/openai-compatible-model-port.js';
import { VERIFY_PROMPT } from '../../src/workflow/model-port-verify.js';
import { declaredToolSpecs } from '../../src/workflow/tool-catalog.js';
import { RUNTIME_ROUTES, RUNTIME_ROUTE_IDS, selectRuntimePrompt,
  selectRuntimeSystemPrompt, UnknownRuntimePromptRouteError }
  from '../../src/workflow/prompts/index.js';
import type { RuntimePromptRoute, RuntimeSystemRoute } from '../../src/workflow/prompts/index.js';

/**
 * 统一路由入口的回归（运行时提示词路由）。
 *
 * 三件事必须同时成立，缺一件就说明「集中提示词」只是把文本搬了家：
 *   1. 每条已登记路由都能被选中，且元数据与登记表互锁；
 *   2. 连接验证是唯一的 user 探针，类型上不可能被当成 system 发送；
 *   3. 原调用文件不再各自保存正文——兼容再导出与统一入口给出同一个字符串，
 *      真实端口发出的 system 也与路由输出一致。
 */

const coreOccurrences = (text: string): number =>
  text.split(RELAY_AGENT_CORE_PROMPT).length - 1;

const fixtureSkill = FIRST_PARTY_REGISTRY.skills[0]!;
const fixtureMethod = BUILTIN_METHOD_REGISTRY.methods[0]!;
const assistantSnapshot = { name: '审读', role_description: '只读复核这份改动', tone: '直接' };
const learningState = { goal: '理解架构', topics: [], open_items: [], recent: [] };

const SYSTEM_ROUTES: readonly RuntimeSystemRoute[] = [
  { kind: 'ASSIST_DISCUSS' }, { kind: 'ASSIST_IMPACT_CHECK' },
  { kind: 'ASSIST_IMPACT_CANDIDATE' }, { kind: 'ASSIST_PROPOSE_CANDIDATE' },
  { kind: 'ASSIST_PROPOSE_TASK' },
  { kind: 'ASSISTANT_READONLY', snapshot: assistantSnapshot, readScopeRoots: [] },
  // 0087：普通 Agent 连续主流程的读取轮次。登记在案就必须能被选中并与登记表互锁——
  // 漏掉它会让「每条已登记路由都可解析」这条保证对新增路由失效。
  { kind: 'AGENT_MAIN_LOOP' },
  { kind: 'LEARNING_PARTNER', state: learningState, material: [] },
  { kind: 'SKILL', skill: fixtureSkill },
  { kind: 'METHOD', method: fixtureMethod, action: null },
  { kind: 'INTERPRETATION_EXECUTION' },
  { kind: 'INTERPRETATION_STATE_MAINTENANCE' },
  { kind: 'DRAFT', capability: { toolsEnabled: false, canWrite: false } },
  { kind: 'DRAFT', capability: { toolsEnabled: true, canWrite: false } },
  { kind: 'DRAFT', capability: { toolsEnabled: true, canWrite: true } },
  { kind: 'SEMANTIC_VERDICT' },
];

interface WireRequest {
  messages: { role: string; content: string }[];
  response_format?: { type: string };
  tools?: unknown;
}

function fixtureModel(content: string, requests: WireRequest[]): OpenAiCompatibleModelPort {
  return new OpenAiCompatibleModelPort({ provider: 'openai-compatible',
    model: 'fixture-model', apiKey: 'fixture-key', baseUrl: 'https://models.vendor.com/v1',
    timeoutMs: 1000, maxOutputTokens: 256, maxCallTokens: 8192,
    maxScopeCalls: 32, maxScopeTokens: 262_144 }, {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    fetch: async (_input, init) => {
      assert.equal(typeof init?.body, 'string');
      requests.push(JSON.parse(init!.body as string) as WireRequest);
      const chunk = { id: 'chatcmpl-prompts', object: 'chat.completion.chunk',
        created: 1, model: 'fixture-model', choices: [{ index: 0,
          delta: { role: 'assistant', content }, finish_reason: 'stop' }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } });
    },
  });
}

test('every registered route resolves and its metadata matches the registry', () => {
  const seen = new Set<string>();
  for (const route of SYSTEM_ROUTES) {
    const selection = selectRuntimeSystemPrompt(route);
    assert.equal(selection.kind, 'SYSTEM');
    assert.equal(seen.has(selection.route.routeId), false);
    seen.add(selection.route.routeId);
    const descriptor = RUNTIME_ROUTES[selection.route.routeId];
    assert.equal(selection.route, descriptor);
    // 每条路由的模板版本各自独立：AGENT_MAIN_LOOP 随本次信封扩展升到 1.0.2，
    // DRAFT 只读/含写工具集的 1.0.1 是它们自己的版本，不能顺手一起抬。
    const expectedVersion =
      descriptor.routeId === 'AGENT_MAIN_LOOP' ? '1.0.2' :
      descriptor.routeId === 'DRAFT_READ_ONLY_TOOLS' || descriptor.routeId === 'DRAFT_WRITE_TOOLS'
        ? '1.0.1' : '1.0.0';
    assert.equal(descriptor.templateVersion, expectedVersion);
    // 元数据声称包含核心，模板里就必须恰好出现一次；声称不含就必须为零。
    assert.equal(coreOccurrences(selection.system), descriptor.coreVersion === null ? 0 : 1,
      `${selection.route.routeId} core occurrences`);
    assert.equal(selection.coreIncluded, descriptor.coreVersion !== null);
  }
  const probe = selectRuntimePrompt({ kind: 'CONNECTION_VERIFY' });
  assert.equal(probe.kind, 'USER_PROBE');
  seen.add(probe.route.routeId);
  assert.deepEqual([...seen].sort(), [...RUNTIME_ROUTE_IDS].sort());
});

test('only the connection verify returns a user probe, never a system text', () => {
  for (const route of SYSTEM_ROUTES) {
    const selection = selectRuntimePrompt(route);
    assert.equal(selection.kind, 'SYSTEM');
    assert.equal('probe' in selection, false);
    assert.equal(typeof selection.system, 'string');
  }
  const probe = selectRuntimePrompt({ kind: 'CONNECTION_VERIFY' });
  assert.equal(probe.kind, 'USER_PROBE');
  // 类型区分在运行时的落点：探针选择上不存在 system 字段。
  assert.equal('system' in probe, false);
  assert.equal(probe.probe, 'relay-verify-1');
});

test('unknown route kinds are rejected instead of falling back to a template', () => {
  assert.throws(() => selectRuntimePrompt({ kind: 'FUTURE_ROUTE' } as never),
    (error: unknown) => error instanceof UnknownRuntimePromptRouteError &&
      error.received === 'FUTURE_ROUTE');
  // 五种合法意图必须是五条不同文本：任务提案不再吞掉未知意图，也不再与交付候选混同。
  const texts = SYSTEM_ROUTES.slice(0, 5)
    .map((route) => selectRuntimeSystemPrompt(route).system);
  for (const [index, text] of texts.entries()) {
    for (const other of texts.slice(index + 1)) assert.notEqual(text, other);
  }
});

test('dynamic data changes the rendered text but never the chosen route', () => {
  const first = selectRuntimeSystemPrompt({ kind: 'ASSISTANT_READONLY',
    snapshot: { name: '甲', role_description: '角色一' }, readScopeRoots: [] });
  const second = selectRuntimeSystemPrompt({ kind: 'ASSISTANT_READONLY',
    snapshot: { name: '乙', role_description: '角色二' }, readScopeRoots: ['D:/repo'] });
  assert.equal(first.route.routeId, second.route.routeId);
  assert.equal(first.route.templateVersion, second.route.templateVersion);
  assert.notEqual(first.system, second.system);
});

test('the original call sites keep a single source for the prompt body', () => {
  assert.equal(INTERPRETATION_SYSTEM_PROMPT,
    selectRuntimeSystemPrompt({ kind: 'INTERPRETATION_EXECUTION' }).system);
  assert.equal(STATE_MAINTENANCE_SYSTEM_PROMPT,
    selectRuntimeSystemPrompt({ kind: 'INTERPRETATION_STATE_MAINTENANCE' }).system);
  assert.equal(assistantSystemPrompt(assistantSnapshot, []),
    selectRuntimeSystemPrompt({ kind: 'ASSISTANT_READONLY', snapshot: assistantSnapshot,
      readScopeRoots: [] }).system);
  assert.equal(learningSystemPrompt(learningState, []),
    selectRuntimeSystemPrompt({ kind: 'LEARNING_PARTNER', state: learningState,
      material: [] }).system);
  assert.equal(VERIFY_PROMPT,
    (() => { const verify = selectRuntimePrompt({ kind: 'CONNECTION_VERIFY' });
      assert.equal(verify.kind, 'USER_PROBE');
      return verify.probe; })());
  // 两条解释模板保持两套不同输出，不能因集中而合并。
  assert.notEqual(INTERPRETATION_SYSTEM_PROMPT, STATE_MAINTENANCE_SYSTEM_PROMPT);
});

test('DRAFT selects its template from the actual tool list, and the wire shape is unchanged',
  async () => {
    const requests: WireRequest[] = [];
    const model = fixtureModel('# 候选\n\n## 摘要\n说明\n\n## 结论\n待审阅', requests);

    await model.generate({ outputSchema: CANDIDATE_OUTPUT_SCHEMA, manifest: {} });
    assert.equal(requests[0]!.messages[0]!.content,
      selectRuntimeSystemPrompt({ kind: 'DRAFT',
        capability: { toolsEnabled: false, canWrite: false } }).system);
    assert.deepEqual(requests[0]!.messages.map((message) => message.role), ['system', 'user']);
    assert.equal(requests[0]!.response_format, undefined);
    assert.equal(requests[0]!.tools, undefined);

    await model.generate({ outputSchema: CANDIDATE_OUTPUT_SCHEMA, manifest: {},
      tools: declaredToolSpecs(['list_directory', 'find_paths', 'search_text', 'read_file']) });
    assert.equal(requests[1]!.messages[0]!.content,
      selectRuntimeSystemPrompt({ kind: 'DRAFT',
        capability: { toolsEnabled: true, canWrite: false } }).system);
    assert.match(requests[1]!.messages[0]!.content, /工具只读，不修改任何文件/u);

    await model.generate({ outputSchema: CANDIDATE_OUTPUT_SCHEMA, manifest: {},
      tools: declaredToolSpecs(['list_directory', 'find_paths', 'search_text', 'read_file',
        'apply_changeset', 'read_change_set']) });
    assert.equal(requests[2]!.messages[0]!.content,
      selectRuntimeSystemPrompt({ kind: 'DRAFT',
        capability: { toolsEnabled: true, canWrite: true } }).system);
    assert.match(requests[2]!.messages[0]!.content, /删除文件不在本次授权内/u);
    // 声明的工具必须原样到达 Provider Adapter：重构不得顺手改动工具声明。
    const declared = declaredToolSpecs(['list_directory', 'find_paths', 'search_text',
      'read_file', 'apply_changeset', 'read_change_set']);
    assert.deepEqual(requests[2]!.tools, declared.map((tool) => ({ type: 'function',
      function: { name: tool.name, description: tool.description,
        parameters: tool.parameters } })));
  });

test('the semantic checker keeps its independent narrow prompt on the wire', async () => {
  const requests: WireRequest[] = [];
  const model = fixtureModel('{"verdict":"UNCERTAIN","reason":"依据不足"}', requests);
  const result = await model.evaluate({ statement: '提供可核对来源', content: '候选正文' });
  assert.equal(result.verdict, 'UNCERTAIN');
  const request = requests[0]!;
  assert.equal(request.messages[0]!.content,
    selectRuntimeSystemPrompt({ kind: 'SEMANTIC_VERDICT' }).system);
  assert.equal(coreOccurrences(request.messages[0]!.content), 0);
  assert.ok(request.messages[1]!.content.includes('候选正文'));
  assert.deepEqual(request.response_format, { type: 'json_object' });
});
