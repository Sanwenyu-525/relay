import assert from 'node:assert/strict';
import test from 'node:test';

import { BUILTIN_METHOD_REGISTRY, availableFrozenMethod,
  createBuiltinMethodRegistry, frozenMethodIdentity, frozenMethodSnapshot,
  inspectFrozenMethodSnapshot, type BuiltinMethodDefinition } from '../../src/skills/builtin-methods.js';
import { listChatCommands, resolveChatCommand,
  systemCommandDefinition } from '../../src/application/chat-commands.js';
import { detectMethodIntent, isMethodDiscussion } from '../../src/application/method-intent.js';
import type { JsonObject } from '../../src/infrastructure/json.js';

test('builtin method registry freezes definitions and rejects conflicting command tokens', () => {
  assert.deepEqual(BUILTIN_METHOD_REGISTRY.methods.map((entry) => entry.id).sort(),
    ['code-review', 'docs-maintenance', 'fault-diagnosis']);
  const review = BUILTIN_METHOD_REGISTRY.method('code-review', '1.0.0')!;
  assert.match(review.sha256, /^[0-9a-f]{64}$/u);
  // 英文命令名与中文别名解析到同一个登记项。
  assert.equal(BUILTIN_METHOD_REGISTRY.byCommand('review')?.sha256, review.sha256);
  assert.equal(BUILTIN_METHOD_REGISTRY.byCommand('代码审查')?.sha256, review.sha256);
  assert.equal(BUILTIN_METHOD_REGISTRY.byCommand('REVIEW')?.sha256, review.sha256);
  assert.equal(BUILTIN_METHOD_REGISTRY.byCommand('nope'), undefined);

  // 同一别名指向两个不同方法时构造直接失败，绝不按扫描顺序静默覆盖。
  const a: BuiltinMethodDefinition = { ...review.definition, id: 'code-review', version: '1.0.0' };
  const b: BuiltinMethodDefinition = { ...review.definition, id: 'docs-maintenance', version: '1.0.0' };
  assert.throws(() => createBuiltinMethodRegistry([a, b]), /conflicting builtin method command token/u);
});

test('frozen method snapshot is self-verifying and rejects unknown fields', () => {
  const review = BUILTIN_METHOD_REGISTRY.method('code-review', '1.0.0')!;
  const snapshot = frozenMethodSnapshot(review);
  assert.equal(availableFrozenMethod(snapshot)?.sha256, review.sha256);
  const identity = inspectFrozenMethodSnapshot(snapshot)!;
  assert.equal(identity.command, 'review');
  assert.equal(identity.default_action, 'INSPECT');
  assert.equal(identity.default_scope, 'CURRENT_CHANGES');

  // 定义被改动后摘要不再自洽：历史绑定不能被当前内容替代。
  const tampered = JSON.parse(JSON.stringify(snapshot)) as { definition: Record<string, unknown> };
  tampered.definition.default_action = 'MODIFY';
  assert.equal(inspectFrozenMethodSnapshot(tampered as unknown as JsonObject), null);
  assert.equal(availableFrozenMethod(tampered as unknown as JsonObject), null);
  // 未知字段与未知 id 一律拒绝，不从当前注册表补造。
  const unknownField = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
  unknownField.extra = true;
  assert.equal(inspectFrozenMethodSnapshot(unknownField as unknown as JsonObject), null);
  assert.equal(inspectFrozenMethodSnapshot({ id: 'delete-everything', version: '1.0.0',
    sha256: review.sha256, definition: review.definition } as unknown as JsonObject), null);
});

test('slash resolution separates methods, system commands, paths and prose', () => {
  const repair = resolveChatCommand('/diagnose 修好 parse.ts');
  assert.equal(repair.kind === 'METHOD' ? repair.action : null, 'MODIFY');
  const discussRepair = resolveChatCommand('/diagnose 讨论如何修复 parse.ts');
  assert.equal(discussRepair.kind === 'METHOD' ? discussRepair.action : null, 'INSPECT');
  assert.equal(resolveChatCommand('帮我审查一下这段代码').kind, 'NOT_COMMAND');
  assert.equal(resolveChatCommand('```\n/review 全部\n```').kind, 'NOT_COMMAND');
  // 路径不是命令：名称后紧跟 `/` 的输入按普通文本处理。
  assert.equal(resolveChatCommand('/usr/bin/env node').kind, 'NOT_COMMAND');

  const menu = resolveChatCommand('/');
  assert.equal(menu.kind, 'MENU');
  if (menu.kind === 'MENU') assert.ok(menu.entries.some((entry) => entry.name === 'review'));

  const review = resolveChatCommand('/review 帮我看看并发写入');
  assert.equal(review.kind, 'METHOD');
  if (review.kind === 'METHOD') {
    assert.equal(review.method.id, 'code-review');
    assert.equal(review.argument, '帮我看看并发写入');
    assert.equal(review.action, 'INSPECT');
    assert.equal(review.scope, 'CURRENT_CHANGES');
  }
  // 中文别名与英文固定名解析到同一登记项。
  const chinese = resolveChatCommand('/诊断 启动失败');
  assert.equal(chinese.kind, 'METHOD');
  if (chinese.kind === 'METHOD') assert.equal(chinese.method.id, 'fault-diagnosis');

  const clear = resolveChatCommand('/clear');
  assert.equal(clear.kind, 'SYSTEM');
  if (clear.kind === 'SYSTEM') assert.equal(clear.system, 'clear');
  const model = resolveChatCommand('/model deepseek-chat');
  assert.equal(model.kind, 'SYSTEM');
  if (model.kind === 'SYSTEM') { assert.equal(model.system, 'model'); assert.equal(model.argument, 'deepseek-chat'); }
  assert.equal(systemCommandDefinition('compact').argument, 'NONE');

  // 未知命令如实拒绝，不偷偷转成任意工具请求。
  const unknown = resolveChatCommand('/nope 做点什么');
  assert.equal(unknown.kind, 'UNKNOWN_COMMAND');
  assert.equal(resolveChatCommand('/命令是什么').kind, 'UNKNOWN_COMMAND');
  // 参数不合法保留可修改输入。
  assert.equal(resolveChatCommand('/model').kind, 'INVALID_ARGUMENT');
  assert.equal(resolveChatCommand('/clear 现在').kind, 'INVALID_ARGUMENT');
});

test('command menu lists methods before system commands with unique names', () => {
  const entries = listChatCommands();
  const names = entries.map((entry) => entry.name);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(names.slice(0, 3), ['review', 'diagnose', 'docs']);
  assert.ok(entries.some((entry) => entry.kind === 'SYSTEM' && entry.name === 'clear'));
  assert.ok(entries.some((entry) => entry.aliases.includes('代码审查')));
});

test('natural language method intent separates discussion, inspection and explicit repair', () => {
  const discussion = detectMethodIntent('讨论诊断方法')!;
  assert.equal(discussion.method_id, 'fault-diagnosis');
  assert.equal(discussion.discussion, true);
  assert.equal(discussion.action, 'INSPECT');
  assert.equal(isMethodDiscussion('讨论诊断方法'), true);

  // "谈谈如何修复" 只是讨论：不得升级为修改授权。
  const talk = detectMethodIntent('谈谈如何修复启动失败')!;
  assert.equal(talk.method_id, 'fault-diagnosis');
  assert.equal(talk.discussion, true);
  assert.equal(talk.action, 'INSPECT');

  const inspect = detectMethodIntent('帮我诊断启动失败')!;
  assert.equal(inspect.method_id, 'fault-diagnosis');
  assert.equal(inspect.discussion, false);
  assert.equal(inspect.action, 'INSPECT');
  assert.equal(inspect.scope, 'CURRENT_TASK');

  // 明确 "修好" 才是修改请求。
  const repair = detectMethodIntent('诊断并修好启动失败')!;
  assert.equal(repair.action, 'MODIFY');

  const review = detectMethodIntent('审查一下这次改动')!;
  assert.equal(review.method_id, 'code-review');
  assert.equal(review.scope, 'CURRENT_CHANGES');
  assert.equal(review.explicit_scope, false);

  // "全项目" 才扩大范围。
  const wide = detectMethodIntent('全项目审查一遍')!;
  assert.equal(wide.method_id, 'code-review');
  assert.equal(wide.scope, 'PROJECT');
  assert.equal(wide.explicit_scope, true);

  const docs = detectMethodIntent('帮我看看文档有没有过期')!;
  assert.equal(docs.method_id, 'docs-maintenance');
  assert.equal(detectMethodIntent('更新一下文档')!.action, 'MODIFY');
  assert.equal(detectMethodIntent('今天天气不错'), null);
});
