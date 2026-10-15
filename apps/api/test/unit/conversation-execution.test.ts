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

test('只读请求不会因为新增字段拿到写能力；缺省声明仍按文件列表推导写意图', () => {
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

test('只读声明压过文件列表：把路径当定位提示的读取请求不得拿到写工具', () => {
  // 实测真实模型对「读取 README.md」会给 writes_files:false 同时把路径列进 file_changes
  //（当定位提示用）。按「有变更即写」处理会让一次纯读取静默拿到 apply_changeset 与范围授权。
  const wantsWrite = conversationExecution.wantsConversationFileWrite;
  const validated = validateConversationCandidate({ task: { ...validTask,
    writes_files: false, file_changes: [{ path: 'README.md', action: 'MODIFY' }] } });
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  assert.equal(wantsWrite(validated.candidate), false);
  // 显式声明要写时，路径列表只是额外的定位信息，仍然是写意图。
  const declaredWrite = validateConversationCandidate({ task: { ...validTask,
    writes_files: true, file_changes: [{ path: 'src/parse.ts', action: 'MODIFY' }] } });
  assert.equal(declaredWrite.ok, true);
  if (!declaredWrite.ok) return;
  assert.equal(wantsWrite(declaredWrite.candidate), true);
});

test('schema 的 check 空占位按「本次不跑检查」处理，不把只读候选判成澄清', () => {
  // schema 无条件声明了 check，真实模型对只读请求照样填 {"executable":"","args":[]}。
  // 当成格式错误的检查命令会让「列一下当前目录」被追问「检查命令需要一个可执行文件名」。
  for (const check of [{ executable: '', args: [] }, {}, null]) {
    const validated = validateConversationCandidate({ task: { ...validTask,
      writes_files: false, file_changes: [], check } });
    assert.equal(validated.ok, true, `空占位 check 应被接受：${JSON.stringify(check)}`);
    if (!validated.ok) continue;
    assert.equal(validated.candidate.check, undefined);
  }
  // 真的写了可执行名却缺参数，仍然按非法拒绝：丢掉空占位只让权限更小，不能放宽成任意命令。
  const partial = validateConversationCandidate({ task: { ...validTask,
    writes_files: false, file_changes: [], check: { executable: 'node', args: [] } } });
  assert.equal(partial.ok, false);
  assert.match(partial.ok ? '' : partial.reason, /可执行文件名/u);
});

test('auto_start 只对就绪的只读候选成立；写意图与未就绪一律 false', () => {
  const isReadOnly = conversationExecution.isReadOnlyConversationExecution;
  const readOnly = validateConversationCandidate({ task: { ...validTask,
    title: '列出目录', writes_files: false, file_changes: [] } });
  assert.equal(readOnly.ok, true);
  if (!readOnly.ok) return;
  const candidate = readOnly.candidate as unknown as JsonObject;
  assert.equal(isReadOnly({ decision: 'PREPARE', candidate_status: 'READY', candidate }), true);
  // 带写意图的候选必须回到人工确认：只读豁免不能顺带覆盖会改文件的请求。
  assert.equal(isReadOnly({ decision: 'PREPARE', candidate_status: 'READY', candidate: validTask }),
    false, '缺省 writes_files 按文件列表推导，validTask 含 MODIFY，应视为写意图');
  const declaredWrite = validateConversationCandidate({ task: { ...validTask, writes_files: true } });
  assert.equal(declaredWrite.ok, true);
  if (!declaredWrite.ok) return;
  assert.equal(isReadOnly({ decision: 'PREPARE', candidate_status: 'READY',
    candidate: declaredWrite.candidate as unknown as JsonObject }), false);
  // 讨论、澄清与不可用候选一律不是可启动的执行请求。
  for (const row of [
    { decision: 'DISCUSS', candidate_status: 'UNAVAILABLE', candidate: null },
    { decision: 'CLARIFY', candidate_status: 'UNAVAILABLE', candidate: null },
    { decision: 'PREPARE', candidate_status: 'INVALID', candidate },
    { decision: 'PREPARE', candidate_status: 'READY', candidate: null },
  ]) assert.equal(isReadOnly(row), false, JSON.stringify(row.decision));
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
