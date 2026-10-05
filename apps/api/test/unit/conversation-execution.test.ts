import assert from 'node:assert/strict';
import test from 'node:test';

import * as conversationExecution from '../../src/application/conversation-execution.js';
import { readInterpretation, validateConversationCandidate } from
  '../../src/application/conversation-execution.js';
import type { ConversationTaskCandidate } from
  '../../src/application/conversation-execution.js';

/** 编译期读结构化候选：RED 阶段新字段还不存在，用投影读法让断言先失败而不是编译先报错。 */
function candidateView(candidate: ConversationTaskCandidate): {
  readonly writes_files?: boolean;
} {
  return candidate as unknown as { readonly writes_files?: boolean };
}
import type { JsonObject } from '../../src/infrastructure/json.js';
import { freezeExecutionContract, readFrozenActionOperationIds, readFrozenRunActions } from
  '../../src/workflow/execution-contract.js';
import type { AssistResult } from '../../src/workflow/fake-model-port.js';

function content(value: JsonObject): AssistResult {
  return { kind: 'CONTENT', content: JSON.stringify(value), providerRequestId: 'test',
    usage: { inputTokens: 1, outputTokens: 1 } };
}

const validTask: JsonObject = {
  title: '修复解析报错',
  objective: '给定输入不再抛出解析异常，且检查通过',
  criteria: [{ statement: '解析结果与基线一致', required: true, method: 'HUMAN' }],
  expected_outputs: { kind: 'MARKDOWN_DOCUMENT' },
  file_changes: [{ path: 'src/parse.ts', action: 'MODIFY' }],
  check: { executable: 'node', args: ['--version'] },
};

test('一个明确的执行请求通过确定性校验并保留范围、验收与检查命令', () => {
  const validated = validateConversationCandidate({ task: validTask });
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  assert.equal(validated.candidate.file_changes.length, 1);
  assert.deepEqual(validated.candidate.check, { executable: 'node', args: ['--version'] });
});

test('解释阶段不接受文件正文：正文由执行时读取真实文件后决定', () => {
  const withContent = validateConversationCandidate({ task: { ...validTask,
    file_changes: [{ path: 'src/parse.ts', action: 'MODIFY', content: 'export const parse = 1;\n' }] } });
  assert.equal(withContent.ok, false);
  assert.match(withContent.ok ? '' : withContent.reason, /不要提供文件内容/u);
});

test('解释模型声明要改文件但还不知道具体路径时，写能力不被「文件列表为空」关掉', () => {
  // 反例：解释模型没有目录访问，拿不准文件名是常态。若只按 file_changes 非空授权，
  // 「目录里搜索结果里那个抛错的解析函数改好」这类请求永远拿不到写工具。
  const validated = validateConversationCandidate({ task: { ...validTask,
    writes_files: true, file_changes: [] } });
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  assert.equal(candidateView(validated.candidate).writes_files, true);
  assert.equal(validated.candidate.file_changes.length, 0);
  // 判定入口必须是对外的纯函数：调用方（执行准备）只按这一个判定放行写能力。
  const wantsWrite = (conversationExecution as unknown as {
    wantsConversationFileWrite?: (candidate: ConversationTaskCandidate) => boolean })
    .wantsConversationFileWrite;
  assert.equal(typeof wantsWrite, 'function');
  assert.equal(wantsWrite!(validated.candidate), true);
});

test('只读请求不会因为新增字段拿到写能力；声明了文件列表本身就是写意图', () => {
  const readOnly = validateConversationCandidate({ task: { ...validTask,
    writes_files: false, file_changes: [] } });
  assert.equal(readOnly.ok, true);
  if (!readOnly.ok) return;
  const wantsWrite = (conversationExecution as unknown as {
    wantsConversationFileWrite?: (candidate: ConversationTaskCandidate) => boolean })
    .wantsConversationFileWrite;
  assert.equal(typeof wantsWrite, 'function');
  assert.equal(wantsWrite!(readOnly.candidate), false);

  const legacy = validateConversationCandidate({ task: validTask });
  assert.equal(legacy.ok, true);
  if (!legacy.ok) return;
  assert.equal(wantsWrite!(legacy.candidate), true);
});

test('不可判断的验收条件被拒绝，而不是用占位措辞凑齐任务', () => {
  const noRequired = validateConversationCandidate({ task: { ...validTask,
    criteria: [{ statement: '已完成', required: false, method: 'HUMAN' }] } });
  assert.equal(noRequired.ok, false);
  const badMethod = validateConversationCandidate({ task: { ...validTask,
    criteria: [{ statement: '结果正确', required: true, method: 'VIBES' }] } });
  assert.equal(badMethod.ok, false);
  const noCriteria = validateConversationCandidate({ task: { ...validTask, criteria: [] } });
  assert.equal(noCriteria.ok, false);
});

test('目录外路径、非受支持输出与超量文件变更都被拒绝', () => {
  for (const fileChanges of [
    [{ path: '../outside.txt', action: 'CREATE' }],
    [{ path: 'src/ok.txt', action: 'RENAME' }],
    [{ path: 'D:/abs.txt', action: 'CREATE' }],
    [{ path: 'a.txt', action: 'CREATE' }, { path: 'A.TXT', action: 'CREATE' }],
    Array.from({ length: 17 }, (_, index) => ({ path: `f${index}.txt`, action: 'CREATE' })),
  ]) {
    assert.equal(validateConversationCandidate({ task: { ...validTask,
      file_changes: fileChanges } }).ok, false);
  }
  assert.equal(validateConversationCandidate({ task: { ...validTask,
    expected_outputs: { kind: 'ANYTHING' } } }).ok, false);
});

test('模型输出按 decision 分流；解析失败与非法字段都退回一个聚焦澄清', () => {
  assert.equal(readInterpretation(content({ decision: "DISCUSS" })).status, 'DISCUSSED');
  const clarify = readInterpretation(content({ decision: "CLARIFY", questions: ["改哪里？", "第二个问题"] }));
  assert.equal(clarify.status, 'CLARIFY');
  assert.deepEqual(clarify.clarification, { questions: ["改哪里？"] });
  const broken: AssistResult = { kind: 'CONTENT', content: '{"decision":', providerRequestId: 'x',
    usage: { inputTokens: 1, outputTokens: 1 } };
  assert.equal(readInterpretation(broken).decision, 'CLARIFY');
  const invalid = readInterpretation(content({ decision: "PREPARE", task: { title: "x" } }));
  assert.equal(invalid.status, 'CLARIFY');
  assert.equal(invalid.candidateStatus, 'INVALID');
  const prepared = readInterpretation(content({ decision: "PREPARE", task: validTask }));
  assert.equal(prepared.status, 'READY');
  assert.equal(prepared.candidateStatus, 'READY');
  // 取消不是授权：按普通讨论收敛，不创建任务。
  assert.equal(readInterpretation({ kind: 'CANCELLED' }).status, 'DISCUSSED');
});

test('冻结契约允许「文件变更 + 一次检查命令」，但 Fake 标记不能与真实写入并存', () => {
  const base = { taskId: '11111111-1111-1111-1111-111111111111', acceptanceRevision: 1n,
    objective: 'o', expectedOutputs: {}, criteria: [] };
  const chain = freezeExecutionContract({ ...base,
    fileWriteAction: { operation_id: 'w1', intent_key: 'file-write-v1' as const,
      connection_id: 'c', resource_id: 'r', changes: [{ path: 'a.txt', action: 'CREATE', content: '' }] },
    cliRunAction: { operation_id: 'k1', intent_key: 'cli-run-v1' as const,
      connection_id: 'c', resource_id: 'r', executable: 'node', args: ['--version'] } });
  assert.deepEqual(readFrozenActionOperationIds(chain.snapshot), ['w1', 'k1']);
  assert.deepEqual(readFrozenRunActions(chain.snapshot).writes.map((write) => write.kind),
    ['FILE_WRITE', 'CLI']);
  const marker = freezeExecutionContract({ ...base,
    mockGatewayAction: { operation_id: 'm1', intent_key: 'mock-write-marker-v1' as const,
      connection_id: 'c', resource_id: 'r', target: 't', content: 'x' },
    fileWriteAction: { operation_id: 'w1', intent_key: 'file-write-v1' as const,
      connection_id: 'c', resource_id: 'r', changes: [{ path: 'a.txt', action: 'CREATE', content: '' }] } });
  assert.throws(() => readFrozenRunActions(marker.snapshot), /cannot be combined/);
});

test('冻结的检查命令必须是可执行文件加参数数组，不能是 shell 字符串', () => {
  const frozen = freezeExecutionContract({ taskId: '11111111-1111-1111-1111-111111111111',
    acceptanceRevision: 1n, objective: 'o', expectedOutputs: {}, criteria: [],
    cliRunAction: { operation_id: 'k1', intent_key: 'cli-run-v1' as const,
      connection_id: 'c', resource_id: 'r', executable: 'node', args: ['--version'] } });
  assert.deepEqual(readFrozenRunActions(frozen.snapshot).writes.map((write) => write.kind), ['CLI']);
  assert.throws(() => readFrozenRunActions({ cli_run_action: { operation_id: 'k1',
    intent_key: 'cli-run-v1', connection_id: 'c', resource_id: 'r',
    executable: 'node && rm -rf /', args: [] } }), /invalid/);
});
