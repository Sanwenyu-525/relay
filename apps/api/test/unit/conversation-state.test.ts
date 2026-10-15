import assert from 'node:assert/strict';
import test from 'node:test';

import type { ConversationStateChangeRow, StateChangeKind, StateChangeStatus } from
  '../../src/infrastructure/database-schema.js';
import type { JsonObject } from '../../src/infrastructure/json.js';
import {
  buildCompensationPlan, deriveCompensationCommandId, matchTitle,
  validateStateMaintenanceCandidate,
} from '../../src/application/conversation-state.js';

/**
 * 自然语言状态维护的确定性校验纯函数（无数据库）：
 * 候选形状、标题解析与撤回补偿计划。所有判定在模型输出与数据库之间充当栅栏。
 */

function changeRow(input: {
  readonly id: string; readonly ordinal: number; readonly changeKind: StateChangeKind;
  readonly commandId: string; readonly payload: JsonObject;
  readonly status?: StateChangeStatus;
  readonly beforeRef?: JsonObject | null; readonly afterRef?: JsonObject | null;
}): ConversationStateChangeRow {
  return { id: input.id, request_id: 'req-1', ordinal: input.ordinal,
    change_kind: input.changeKind, command_id: input.commandId, payload: input.payload,
    status: input.status ?? 'APPLIED', before_ref: input.beforeRef ?? null,
    after_ref: input.afterRef ?? null, baseline_ref: null, error: null,
    applied_at: new Date(), compensation_command_id: null, compensated_at: null };
}

test('MAINTAIN 候选通过校验并按 kind 归一化参数', () => {
  const validated = validateStateMaintenanceCandidate({
    decision: 'MAINTAIN',
    questions: [],
    changes: [
      { kind: 'SET_PHASE', phase: '构建' },
      { kind: 'SET_NEXT_ACTION' },
      { kind: 'CREATE_TASK', title: '写发布说明' },
      { kind: 'ADD_TASK_DEPENDENCY', task_title: '发布', depends_on_task_title: '测试通过',
        dependency_kind: 'BLOCKS' },
      { kind: 'ADD_BLOCKER', target_kind: 'PROJECT', reason: '等待外部接口确认' },
      { kind: 'RESOLVE_BLOCKER', target_kind: 'TASK', task_title: '联调',
        reason: '上游资料尚未确认' },
      { kind: 'CREATE_GOAL', title: '按期发布' },
      { kind: 'LINK_GOAL', goal_title: '按期发布' },
      { kind: 'CREATE_DECISION', title: '选数据库', choice: 'PostgreSQL',
        rationale: '事务与生态' },
      { kind: 'CREATE_KNOWLEDGE', title: '部署手册', content: '第一步……' },
      { kind: 'VERSION_KNOWLEDGE', knowledge_title: '部署手册', content: '第一步改……' },
    ],
    decision_required: null,
  });
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const candidate = validated.candidate;
  assert.equal(candidate.decision, 'MAINTAIN');
  assert.equal(candidate.changes.length, 11);
  // CREATE_TASK 的 objective 缺省取标题：轻量起步语义不需要验收条件，但 Owner 要求非空目标。
  const created = candidate.changes.find((change) => change.kind === 'CREATE_TASK');
  assert.deepEqual(created, { kind: 'CREATE_TASK', title: '写发布说明', objective: '写发布说明' });
  // SET_NEXT_ACTION 缺失任务标题 = 清空下一步。
  const nextAction = candidate.changes.find((change) => change.kind === 'SET_NEXT_ACTION');
  assert.deepEqual(nextAction, { kind: 'SET_NEXT_ACTION', task_title: null });
  // ADD_BLOCKER 的 PROJECT 目标不需要标题。
  const blocker = candidate.changes.find((change) => change.kind === 'ADD_BLOCKER');
  assert.deepEqual(blocker, { kind: 'ADD_BLOCKER', target_kind: 'PROJECT', task_title: null,
    goal_title: null, reason: '等待外部接口确认' });
});

test('Slice B 与自然语言撤回的三个新 kind 归一化；单请求仍受 12 条上限约束', () => {
  const validated = validateStateMaintenanceCandidate({
    decision: 'MAINTAIN',
    questions: [],
    changes: [
      { kind: 'SYNC_EXTERNAL_RESULT', task_title: '导出任务' },
      { kind: 'COMPLETE_TASK', task_title: '导出任务' },
      { kind: 'UNDO_STATE_CHANGE' },
    ],
    decision_required: null,
  });
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const candidate = validated.candidate;
  if (candidate.decision !== 'MAINTAIN') return;
  assert.equal(candidate.changes.length, 3);
  const sync = candidate.changes.find((change) => change.kind === 'SYNC_EXTERNAL_RESULT');
  assert.deepEqual(sync, { kind: 'SYNC_EXTERNAL_RESULT', task_title: '导出任务' });
  const complete = candidate.changes.find((change) => change.kind === 'COMPLETE_TASK');
  assert.deepEqual(complete, { kind: 'COMPLETE_TASK', task_title: '导出任务' });
  const undo = candidate.changes.find((change) => change.kind === 'UNDO_STATE_CHANGE');
  assert.deepEqual(undo, { kind: 'UNDO_STATE_CHANGE' });
  // 缺任务标题的核对/完成条目整单澄清，不静默丢弃。
  const missingTitle = validateStateMaintenanceCandidate({
    decision: 'MAINTAIN', questions: [],
    changes: [{ kind: 'SYNC_EXTERNAL_RESULT' }], decision_required: null });
  assert.equal(missingTitle.ok, false);
  // 12 条上限对新 kind 同样生效。
  const overflow = validateStateMaintenanceCandidate({
    decision: 'MAINTAIN', questions: [],
    changes: Array.from({ length: 13 }, () => ({ kind: 'UNDO_STATE_CHANGE' })),
    decision_required: null });
  assert.equal(overflow.ok, false);
});

test('DISCUSS / CLARIFY 不携带任何业务变更；decision_required 只在 MAINTAIN 上生效', () => {
  const discussed = validateStateMaintenanceCandidate({
    decision: 'DISCUSS', questions: [], changes: [], decision_required: null });
  assert.equal(discussed.ok, true);
  if (!discussed.ok) return;
  assert.equal(discussed.candidate.decision, 'DISCUSS');
  assert.equal('changes' in discussed.candidate, false);

  const clarified = validateStateMaintenanceCandidate({
    decision: 'CLARIFY',
    questions: ['要改哪个阶段？', '对象是哪个任务？', '第三个问题被截断'],
    changes: [{ kind: 'SET_PHASE', phase: '构建' }],
    decision_required: null });
  assert.equal(clarified.ok, true);
  if (!clarified.ok) return;
  assert.equal(clarified.candidate.decision, 'CLARIFY');
  // 最多保留 2 个聚焦问题。
  assert.equal(clarified.candidate.questions.length, 2);

  const withDecision = validateStateMaintenanceCandidate({
    decision: 'MAINTAIN', questions: [],
    changes: [{ kind: 'CREATE_TASK', title: '跟进评审意见' }],
    decision_required: { summary: '影响既定的发布计划', question: '是否调整发布时间？',
      affected: ['发布说明'] } });
  assert.equal(withDecision.ok, true);
  if (!withDecision.ok || withDecision.candidate.decision !== 'MAINTAIN') return;
  assert.deepEqual(withDecision.candidate.decision_required,
    { summary: '影响既定的发布计划', question: '是否调整发布时间？', affected: ['发布说明'],
      // 缺省 = 整组等待这个决定（最保守）。
      blocked_changes: null });

  // 只指定等待的序号：独立且明确的修改不被另一项必要决定整组冻结。
  const partiallyBlocked = validateStateMaintenanceCandidate({
    decision: 'MAINTAIN', questions: [],
    changes: [{ kind: 'SET_NEXT_ACTION', task_title: '搜索' },
      { kind: 'SET_PHASE', phase: '构建' }],
    decision_required: { summary: '发布依赖导出', question: '是否先不包含导出？',
      affected: ['本周发布'], blocked_changes: [1] } });
  assert.equal(partiallyBlocked.ok, true);
  if (!partiallyBlocked.ok || partiallyBlocked.candidate.decision !== 'MAINTAIN') return;
  assert.deepEqual(partiallyBlocked.candidate.decision_required?.blocked_changes, [1]);

  // 引用不存在的变更序号或形状非法 → 整单澄清，不猜。
  const outOfRange = validateStateMaintenanceCandidate({
    decision: 'MAINTAIN', questions: [],
    changes: [{ kind: 'SET_PHASE', phase: '构建' }],
    decision_required: { summary: 's', question: 'q', affected: [], blocked_changes: [7] } });
  assert.equal(outOfRange.ok, false);
  const notArray = validateStateMaintenanceCandidate({
    decision: 'MAINTAIN', questions: [],
    changes: [{ kind: 'SET_PHASE', phase: '构建' }],
    decision_required: { summary: 's', question: 'q', affected: [], blocked_changes: 'all' } });
  assert.equal(notArray.ok, false);

  // 非空但形状非法的 decision_required 不是「没有待决定」：整单退回聚焦澄清，
  // 否则会绕过待决定门直接写入。
  const malformed = validateStateMaintenanceCandidate({
    decision: 'MAINTAIN', questions: [],
    changes: [{ kind: 'CREATE_TASK', title: '跟进评审意见' }],
    decision_required: { summary: '缺问题' } });
  assert.equal(malformed.ok, false);
  assert.match(malformed.ok ? '' : malformed.reason, /连带影响说明/u);

  const affectedNotArray = validateStateMaintenanceCandidate({
    decision: 'MAINTAIN', questions: [],
    changes: [{ kind: 'CREATE_TASK', title: '跟进评审意见' }],
    decision_required: { summary: '影响发布', question: '是否调整？', affected: '发布' } });
  assert.equal(affectedNotArray.ok, false);

  const affectedJunkItem = validateStateMaintenanceCandidate({
    decision: 'MAINTAIN', questions: [],
    changes: [{ kind: 'CREATE_TASK', title: '跟进评审意见' }],
    decision_required: { summary: '影响发布', question: '是否调整？', affected: ['发布', 3] } });
  assert.equal(affectedJunkItem.ok, false);
});

test('未知 decision 与非法形状退回聚焦澄清', () => {
  assert.equal(validateStateMaintenanceCandidate({ decision: 'PREPARE' } as JsonObject).ok, false);
  assert.equal(validateStateMaintenanceCandidate({} as JsonObject).ok, false);

  const noChanges = validateStateMaintenanceCandidate({
    decision: 'MAINTAIN', questions: [], changes: [], decision_required: null });
  assert.equal(noChanges.ok, false);

  const notArray = validateStateMaintenanceCandidate({
    decision: 'MAINTAIN', questions: [], changes: '改一下', decision_required: null });
  assert.equal(notArray.ok, false);

  const overflow = validateStateMaintenanceCandidate({
    decision: 'MAINTAIN', questions: [],
    changes: Array.from({ length: 13 }, () => ({ kind: 'CREATE_TASK', title: '任务' })),
    decision_required: null });
  assert.equal(overflow.ok, false);
  assert.match(overflow.ok ? '' : overflow.reason, /最多维护 12 条/u);
});

test('任何一条变更无法解释都整单退回澄清，不静默丢弃条目', () => {
  const outside = validateStateMaintenanceCandidate({
    decision: 'MAINTAIN', questions: [],
    changes: [
      { kind: 'DELETE_PROJECT' },
      { kind: 'SET_PHASE', phase: '构建' },
    ], decision_required: null });
  assert.equal(outside.ok, false);
  assert.match(outside.ok ? '' : outside.reason, /不在支持范围内/u);

  // 合法与非法条目混合：整单澄清，绝不保留合法条目后宣称整组生效。
  const mixed = validateStateMaintenanceCandidate({
    decision: 'MAINTAIN', questions: [],
    changes: [
      { kind: 'SET_PHASE', phase: 'x'.repeat(65) },
      { kind: 'ADD_TASK_DEPENDENCY', task_title: '发布', depends_on_task_title: '测试',
        dependency_kind: 'LIKES' },
      { kind: 'CREATE_TASK', title: '  写发布说明  ' },
    ], decision_required: null });
  assert.equal(mixed.ok, false);
  assert.match(mixed.ok ? '' : mixed.reason, /SET_PHASE/u);

  const allInvalid = validateStateMaintenanceCandidate({
    decision: 'MAINTAIN', questions: [],
    changes: [{ kind: 'SET_PHASE', phase: '' }], decision_required: null });
  assert.equal(allInvalid.ok, false);

  // 白名单内但条目不是对象，同样整单退回。
  const notAnObject = validateStateMaintenanceCandidate({
    decision: 'MAINTAIN', questions: [],
    changes: ['SET_PHASE'], decision_required: null });
  assert.equal(notAnObject.ok, false);
});

test('标题解析：唯一命中、大小写与空白不敏感、歧义与缺失分别报告', () => {
  const rows = [
    { id: 't1', title: '写发布说明' },
    { id: 't2', title: 'Review Docs' },
    { id: 't3', title: 'review docs' },
    { id: 't4', title: '  写发布说明  ' },
  ];
  const unique = matchTitle(rows.slice(0, 2), '写发布说明');
  assert.deepEqual(unique, { ok: true, id: 't1' });

  const insensitive = matchTitle(rows.slice(0, 2), '  REVIEW DOCS ');
  assert.deepEqual(insensitive, { ok: true, id: 't2' });

  const ambiguous = matchTitle([rows[0]!, rows[3]!], '写发布说明');
  assert.deepEqual(ambiguous, { ok: false, code: 'AMBIGUOUS' });

  const ambiguousCase = matchTitle([rows[1]!, rows[2]!], 'Review Docs');
  assert.deepEqual(ambiguousCase, { ok: false, code: 'AMBIGUOUS' });

  const missing = matchTitle(rows, '不存在的任务');
  assert.deepEqual(missing, { ok: false, code: 'NOT_FOUND' });
});

test('撤回补偿计划：只覆盖已生效变更、按逆序、无撤销入口的如实归类', () => {
  const undoCommandId = '00000000-0000-4000-8000-000000000001';
  const rows = [
    changeRow({ id: 'c0', ordinal: 0, changeKind: 'SET_PHASE', commandId: 'cmd-0',
      payload: { kind: 'SET_PHASE', phase: '构建' },
      beforeRef: { phase: '规划' }, afterRef: { phase: '构建' } }),
    changeRow({ id: 'c1', ordinal: 1, changeKind: 'CREATE_TASK', commandId: 'cmd-1',
      payload: { kind: 'CREATE_TASK', title: '写发布说明', objective: '写发布说明' },
      afterRef: { task_id: 'task-1' } }),
    changeRow({ id: 'c2', ordinal: 2, changeKind: 'SET_NEXT_ACTION', commandId: 'cmd-2',
      payload: { kind: 'SET_NEXT_ACTION', task_title: '写发布说明' },
      beforeRef: { task_id: null }, afterRef: { task_id: 'task-1' } }),
    changeRow({ id: 'c3', ordinal: 3, changeKind: 'ADD_BLOCKER', commandId: 'cmd-3',
      payload: { kind: 'ADD_BLOCKER', target_kind: 'TASK', reason: '等待确认' },
      afterRef: { blocker_id: 'blocker-1' } }),
    changeRow({ id: 'c4', ordinal: 4, changeKind: 'RESOLVE_BLOCKER', commandId: 'cmd-4',
      payload: { kind: 'RESOLVE_BLOCKER', target_kind: 'TASK', reason: '上游' },
      beforeRef: { blocker_id: 'blocker-2', target_kind: 'TASK', target_id: 'task-9',
        reason: '上游资料尚未确认' }, afterRef: { blocker_id: 'blocker-2' } }),
    changeRow({ id: 'c5', ordinal: 5, changeKind: 'CREATE_GOAL', commandId: 'cmd-5',
      payload: { kind: 'CREATE_GOAL', title: '按期发布' }, afterRef: { goal_id: 'goal-1' } }),
    changeRow({ id: 'c6', ordinal: 6, changeKind: 'CREATE_DECISION', commandId: 'cmd-6',
      payload: { kind: 'CREATE_DECISION', title: '选库', choice: 'PG', rationale: 'r' },
      afterRef: { decision_id: 'decision-1' } }),
    changeRow({ id: 'c7', ordinal: 7, changeKind: 'VERSION_KNOWLEDGE', commandId: 'cmd-7',
      payload: { kind: 'VERSION_KNOWLEDGE', knowledge_title: '手册', content: 'v2' },
      afterRef: { knowledge_id: 'knowledge-1', version: '2' } }),
    changeRow({ id: 'c8', ordinal: 8, changeKind: 'LINK_GOAL', commandId: 'cmd-8',
      payload: { kind: 'LINK_GOAL', goal_title: '按期发布' }, afterRef: { goal_id: 'goal-1' } }),
    changeRow({ id: 'c9', ordinal: 9, changeKind: 'CREATE_KNOWLEDGE', commandId: 'cmd-9',
      payload: { kind: 'CREATE_KNOWLEDGE', title: '手册', content: 'v1' },
      afterRef: { knowledge_id: 'knowledge-2', version: '1' } }),
    // 未生效的变更不参与补偿。
    changeRow({ id: 'c10', ordinal: 10, changeKind: 'CREATE_TASK', commandId: 'cmd-10',
      payload: { kind: 'CREATE_TASK', title: '另一条', objective: '另一条' },
      status: 'FAILED', afterRef: null }),
    changeRow({ id: 'c11', ordinal: 11, changeKind: 'ADD_TASK_DEPENDENCY', commandId: 'cmd-11',
      payload: { kind: 'ADD_TASK_DEPENDENCY', task_title: '发布', depends_on_task_title: '测试',
        dependency_kind: 'INFORMS' },
      afterRef: { dependency: { task_id: 'task-1', depends_on_task_id: 'task-2' } } }),
  ];
  const plan = buildCompensationPlan('req-undo', undoCommandId, rows);
  // 逆序：ordinal 11 → 9；FAILED 的 c10 不在计划里。
  assert.deepEqual(plan.map((entry) => entry.ordinal), [11, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);

  const byOrdinal = new Map(plan.map((entry) => [entry.ordinal, entry]));
  assert.deepEqual(byOrdinal.get(11)?.action, { type: 'REMOVE_DEPENDENCY',
    taskId: 'task-1', dependsOnTaskId: 'task-2', dependencyKind: 'INFORMS' });
  assert.deepEqual(byOrdinal.get(9)?.action, { type: 'RETIRE_KNOWLEDGE',
    knowledgeId: 'knowledge-2' });
  assert.deepEqual(byOrdinal.get(8)?.action, { type: 'UNLINK_GOAL', goalId: 'goal-1' });
  // 没有既有撤销入口的三个 kind 如实归类，不造删除、不假装撤销。
  assert.deepEqual(byOrdinal.get(7)?.action,
    { type: 'UNDO_ENTRY_MISSING', missingKind: 'VERSION_KNOWLEDGE' });
  assert.deepEqual(byOrdinal.get(6)?.action,
    { type: 'UNDO_ENTRY_MISSING', missingKind: 'CREATE_DECISION' });
  assert.deepEqual(byOrdinal.get(5)?.action,
    { type: 'UNDO_ENTRY_MISSING', missingKind: 'CREATE_GOAL' });
  // RESOLVE_BLOCKER 的补偿是把原 blocker 重新登记回去，来源标注撤回请求。
  assert.deepEqual(byOrdinal.get(4)?.action, { type: 'ADD_BLOCKER', targetKind: 'TASK',
    targetId: 'task-9', reason: '上游资料尚未确认', sourceRef: 'undo:req-undo' });
  assert.deepEqual(byOrdinal.get(3)?.action, { type: 'RESOLVE_BLOCKER', blockerId: 'blocker-1' });
  assert.deepEqual(byOrdinal.get(2)?.action, { type: 'SET_NEXT_ACTION', taskId: null });
  assert.deepEqual(byOrdinal.get(1)?.action, { type: 'CANCEL_TASK', taskId: 'task-1' });
  assert.deepEqual(byOrdinal.get(0)?.action, { type: 'SET_PHASE', phase: '规划' });

  // 补偿身份确定性派生：同一变更重试不换身份，不同变更身份互不相同。
  assert.equal(byOrdinal.get(1)!.commandId,
    deriveCompensationCommandId(undoCommandId, 'cmd-1'));
  assert.equal(deriveCompensationCommandId(undoCommandId, 'cmd-1'),
    deriveCompensationCommandId(undoCommandId, 'cmd-1'));
  assert.notEqual(deriveCompensationCommandId(undoCommandId, 'cmd-1'),
    deriveCompensationCommandId(undoCommandId, 'cmd-2'));
  assert.match(deriveCompensationCommandId(undoCommandId, 'cmd-1'),
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
});
