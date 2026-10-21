import assert from 'node:assert/strict';
import test from 'node:test';

import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';

import type { AssistRequest } from '../../src/workflow/fake-model-port.js';
import { ASSIST_STEERING_RULES } from '../../src/workflow/prompts/conversation-prompts.js';
import { assistMessages } from '../../src/workflow/openai-compatible-model-port.js';

/**
 * 0122：插话在模型上下文里的位置。
 *
 * 上游（`.research/upstream/deepseek-harness` `core/agent-loop/src/agent.ts:167-173`）
 * 把插话插进 `next-step` inbox：它在**已经发生的那一步之后**、下一次模型请求之前生效。
 * 对应到本项目的消息序列就是「历史轮次 → 工具轮次 → 插话」，而不是把插话塞进历史轮次
 * （那会让模型以为它在工具调用之前就说过），也不是丢掉工具结果（那会让它看不见读到了什么）。
 *
 * 这里只锁顺序，不涉及真实 Provider：`assistMessages` 是 `assist()` 唯一的消息装配入口。
 */
test('插话排在工具轮次之后，历史轮次与工具结果都保留', () => {
  const request: AssistRequest = {
    intent: 'DISCUSS',
    system: 'SYSTEM',
    turns: [
      { role: 'user', content: '看一下这个目录' },
      { role: 'assistant', content: '我看看。' },
    ],
    toolTurns: [{
      calls: [{ providerToolCallId: 'call-1', name: 'read_file', arguments: { relative_path: 'README.md' } }],
      results: [{ providerToolCallId: 'call-1', name: 'read_file',
        content: '文件内容：RELAY-MARKER', isError: false }],
      preamble: '',
    }],
    steers: ['先别改 README，先看 src'],
  };

  const messages = assistMessages(request);

  assert.equal(messages.length, 6);
  assert.ok(messages[0] instanceof SystemMessage);
  assert.ok(messages[1] instanceof HumanMessage);
  assert.equal(messages[1].content, '看一下这个目录');
  assert.ok(messages[2] instanceof AIMessage);
  assert.ok(messages[3] instanceof AIMessage, '工具请求轮次');
  assert.ok(messages[4] instanceof ToolMessage, '工具结果紧随其请求');
  // 插话是最后一条，逐字使用用户原文（不加 UNTRUSTED 前缀：它是指令，不是资料）。
  assert.ok(messages[5] instanceof HumanMessage);
  assert.equal(messages[5].content, '先别改 README，先看 src');
});

test('没有插话时消息序列逐字不变（缺省行为不因新增字段改变）', () => {
  const request: AssistRequest = { intent: 'DISCUSS', system: 'SYSTEM',
    turns: [{ role: 'user', content: '只问一句' }] };
  const messages = assistMessages(request);
  assert.equal(messages.length, 2);
  assert.ok(messages[0] instanceof SystemMessage);
  assert.ok(messages[1] instanceof HumanMessage);
  assert.equal(messages[1].content, '只问一句');
});

test('多条插话按发送顺序接在最后', () => {
  const request: AssistRequest = { intent: 'DISCUSS', system: 'SYSTEM',
    turns: [{ role: 'user', content: '开始' }], steers: ['第一句插话', '第二句插话'] };
  const messages = assistMessages(request);
  assert.deepEqual(messages.slice(-2).map((message) => message.content),
    ['第一句插话', '第二句插话']);
});

test('连续插话保留真实时序：旧插话在其引发的工具之前，新插话在结果之后', () => {
  const request: AssistRequest = { intent: 'DISCUSS', system: 'SYSTEM',
    turns: [{ role: 'user', content: '做登录页' }],
    toolTurns: [{
      steersBefore: ['支持手机号', '先看看现有实现'],
      calls: [{ providerToolCallId: 'read-login', name: 'read_file', arguments: {} }],
      results: [{ providerToolCallId: 'read-login', name: 'read_file',
        content: '已读到原登录实现', isError: false }],
    }],
    steers: ['登录先不做了', '只分析启动失败，先不要修改'],
  };
  const messages = assistMessages(request);
  assert.deepEqual(messages.filter((item) => item instanceof HumanMessage)
    .map((item) => item.content),
  ['做登录页', '支持手机号', '先看看现有实现', '登录先不做了', '只分析启动失败，先不要修改']);
  const callIndex = messages.findIndex((item) => item instanceof AIMessage);
  assert.equal(messages[callIndex - 1]?.content, '先看看现有实现');
  assert.ok(messages[callIndex + 1] instanceof ToolMessage);
  assert.equal(messages[callIndex + 2]?.content, '登录先不做了');
});

test('插话规则必须声明正式 Run 不受聊天改向影响，禁止模型承诺已停止或已改向', () => {
  // 已登记的执行候选与正在执行的 Run 由原领域入口拥有；插话消费方没有停止它们的
  // 工具。规则文本若不写清这一点，模型会替用户「宣称已停止」，而 Run 还在跑。
  assert.match(ASSIST_STEERING_RULES,
    /只作用于本轮会话工具循环里尚未执行的动作/u);
  assert.match(ASSIST_STEERING_RULES,
    /已经登记的执行候选与正在执行的正式 Run 不受聊天改向影响/u);
  assert.match(ASSIST_STEERING_RULES, /不要声称「已停止该任务」/u);
  assert.match(ASSIST_STEERING_RULES, /任务与运行控制入口/u);
});
