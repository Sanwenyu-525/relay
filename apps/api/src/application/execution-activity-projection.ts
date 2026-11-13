import { createHash } from 'node:crypto';

import { sql } from 'kysely';

import type { SessionToolCallRow } from '../assist/session-tool-call-repository.js';
import { SessionToolCallRepository } from '../assist/session-tool-call-repository.js';
import type { DbExecutor } from '../infrastructure/database.js';
import type {
  AssistDelegationRow,
  AssistMessageRow,
  AssistSessionRow,
  ChangeSetFileRow,
  ChangeSetRow,
  ConversationExecutionRequestRow,
  InvocationAttemptRow,
  LogicalOperationRow,
  ModelCallRow,
  RunRow,
  RunStepRow,
} from '../infrastructure/database-schema.js';
import type { JsonObject, JsonValue } from '../infrastructure/json.js';
import { canonicalizeJson } from '../receipt/payload-hash.js';
import { resourceNotFound } from './domain-error.js';
import { ModelCallRepository } from '../model/model-call-repository.js';
import { createRepositories } from './unit-of-work.js';

export type RecoveryDisposition =
  | 'NO_OPERATION'
  | 'OPERATION_MISSING'
  | 'ORIGIN_UNVERIFIED'
  | 'UNRESOLVED_OPEN'
  | 'UNRESOLVED_UNKNOWN'
  | 'ORDERING_UNPROVEN'
  | 'CONFIRMED_NOT_EXECUTED'
  | 'CONFIRMED_SUCCESS'
  | 'CONFIRMED_FAILURE';

export interface ActivityRecovery {
  readonly disposition: RecoveryDisposition;
  readonly effective_outcome: 'SUCCEEDED' | 'FAILED' | 'NOT_EXECUTED' | null;
  readonly operation_ref: string | null;
  readonly operation_status: LogicalOperationRow['status'] | null;
  readonly invocation_status: InvocationAttemptRow['status'] | null;
  readonly effect_state: 'NOT_APPLICABLE' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'UNKNOWN';
  readonly reconcile_required: boolean;
  readonly reconciled: boolean;
  readonly resolved_at: string | null;
  readonly provenance: 'LIVE' | 'RECONCILED' | 'LEDGER' | 'ABSENT';
  readonly reason: string | null;
  readonly evidence_refs: readonly { kind: string; id: string }[];
}

export interface ActivityItem {
  readonly activity_id: string;
  readonly kind: 'MODEL_CALL' | 'TOOL_CALL' | 'TODO_WRITE' | 'DELEGATION' |
    'EXECUTION_REQUEST' | 'RUN_STEP' | 'APPROVAL' | 'CONTROL' | 'RECOVERY';
  readonly owner: { kind: 'SESSION_MESSAGE'; session_id: string; message_id: string };
  readonly source: { table: string; row_id: string };
  readonly state: { raw: string; view: string; tone: 'active' | 'wait' | 'success' |
    'error' | 'neutral'; terminal: boolean };
  readonly started_at: string | null;
  readonly ended_at: string | null;
  readonly order: { message_seq: string; round: number | null; ordinal: number | null;
    rank: number };
  readonly refs: { model_call_id: string | null; tool_call_id: string | null;
    operation_id: string | null; invocation_id: string | null };
  readonly wait: { code: string; detail: string | null } | null;
  readonly error: { code: string; detail: string | null } | null;
  readonly evidence: { result_available: boolean; result_digest: string | null;
    failure_kind: string | null; detail_visibility: 'USER' | 'DEVELOPER' };
  readonly recovery: ActivityRecovery | null;
  readonly facts: null;
  readonly tool_name?: string;
  readonly delegation_role?: AssistDelegationRow['role'];
  readonly child_session_id?: string | null;
  readonly attempt_count?: number;
  readonly max_attempts?: number;
  readonly result_summary?: string | null;
}

export interface ExecutionRequestSummary {
  readonly request_id: string;
  readonly status: ConversationExecutionRequestRow['status'];
  readonly decision: ConversationExecutionRequestRow['decision'];
  readonly candidate_status: ConversationExecutionRequestRow['candidate_status'];
  readonly task_id: string | null;
  readonly run_id: string | null;
  readonly failure_code: string | null;
}

export interface RunSummary {
  readonly run_id: string;
  readonly status: RunRow['status'];
  readonly current_step_kind: RunStepRow['step_kind'] | null;
  readonly wait_reason: string | null;
  readonly unresolved_count: number;
  readonly updated_at: string;
  readonly run_event_seq: string | null;
}

export interface MessagePhase {
  readonly raw: string;
  readonly view: string;
  readonly tone: 'active' | 'wait' | 'success' | 'error' | 'neutral';
  readonly since: string | null;
  readonly detail: string;
  readonly wait: { code: string; detail: string | null } | null;
}

export interface MessageActivity {
  readonly message_id: string;
  readonly seq: string;
  readonly role: AssistMessageRow['role'];
  readonly status: AssistMessageRow['status'];
  readonly intent: AssistMessageRow['intent'];
  readonly created_at: string;
  readonly claimed_at: string | null;
  readonly settled_at: string | null;
  readonly updated_at: string;
  readonly cancel_requested: boolean;
  readonly source_user_message_id: string | null;
  readonly content_fingerprint: string;
  readonly activity_version: null;
  readonly process_evidence: 'RECORDED' | 'UNKNOWN';
  readonly phase: MessagePhase;
  readonly execution_request: ExecutionRequestSummary | null;
  readonly run_summary: RunSummary | null;
  readonly activities: readonly ActivityItem[] | undefined;
  readonly activity_counts: { model_calls: number; tool_calls: number;
    todo_writes: number; delegations: number };
  readonly gaps: readonly { code: string; refs: JsonObject }[];
}

export interface ExecutionActivitySnapshot {
  readonly schema_version: 1;
  readonly session: { id: string; workspace_id: string; status: AssistSessionRow['status'];
    conversation_mode: AssistSessionRow['conversation_mode']; revision: string };
  readonly generated_at: string;
  readonly snapshot_at: string;
  readonly messages: readonly MessageActivity[];
  readonly next_before_seq: string | null;
  readonly has_more: boolean;
}

interface RecoveryContext {
  readonly session: AssistSessionRow;
  readonly operations: ReadonlyMap<string, LogicalOperationRow>;
  readonly invocationsByOperation: ReadonlyMap<string, readonly InvocationAttemptRow[]>;
  readonly changeSetsByOperation: ReadonlyMap<string, readonly ChangeSetRow[]>;
  readonly filesByChangeSet: ReadonlyMap<string, readonly ChangeSetFileRow[]>;
  readonly delegationsByToolCall: ReadonlyMap<string, AssistDelegationRow>;
}

function iso(value: Date | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toISOString();
}

function lastInvocation(
  rows: readonly InvocationAttemptRow[] | undefined): InvocationAttemptRow | undefined {
  if (rows === undefined || rows.length === 0) return undefined;
  return rows.slice().sort((left, right) =>
    Number(right.attempt_number - left.attempt_number))[0];
}

function hasDispatch(invocation: InvocationAttemptRow | undefined): boolean {
  return invocation !== undefined && (invocation.dispatched_at !== null ||
    invocation.status === 'DISPATCHING' || invocation.status === 'SUCCEEDED' ||
    invocation.status === 'FAILED' || invocation.status === 'UNKNOWN');
}

function effectStateFor(operation: LogicalOperationRow | undefined,
  context: RecoveryContext): {
  state: ActivityRecovery['effect_state']; failureEvidence: boolean;
  resolvedAt: Date | null; changeSetId: string | null;
} {
  if (operation === undefined) {
    return { state: 'NOT_APPLICABLE', failureEvidence: false, resolvedAt: null,
      changeSetId: null };
  }
  const sets = context.changeSetsByOperation.get(operation.id) ?? [];
  if (sets.length === 0) {
    return { state: operation.capability_key === 'FILE_WRITE' ? 'UNKNOWN' : 'NOT_APPLICABLE',
      failureEvidence: false, resolvedAt: null, changeSetId: null };
  }
  const latest = sets.slice().sort((left, right) =>
    right.updated_at.getTime() - left.updated_at.getTime())[0]!;
  const files = context.filesByChangeSet.get(latest.id) ?? [];
  const fileFailure = files.some((file) =>
    file.status === 'FAILED' || file.status === 'CONFLICT');
  if (latest.status === 'PARTIAL' || fileFailure) {
    return { state: 'PARTIAL', failureEvidence: true, resolvedAt: latest.updated_at,
      changeSetId: latest.id };
  }
  if (latest.status === 'SUCCEEDED') {
    return { state: 'SUCCEEDED', failureEvidence: false, resolvedAt: latest.updated_at,
      changeSetId: latest.id };
  }
  return { state: 'UNKNOWN', failureEvidence: false, resolvedAt: latest.updated_at,
    changeSetId: latest.id };
}

/**
 * 工具记录到 Gateway 证据的只读归因。
 *
 * `messageActive` 决定「没有 Operation」是否是结论：会话仍在执行时，一条 REQUESTED
 * 记录可能停在 prepare 与 attach 之间，Worker 随时会提交动作；此时只能说结果未决，
 * 不能提前宣称永久未执行（ENG-OBS-02 §3.3）。消息已终态时同样的缺席才可结算。
 */
function recoveryFor(row: SessionToolCallRow, context: RecoveryContext,
  messageActive: boolean): ActivityRecovery {
  const candidateIds = [row.operation_id, row.id].filter((value): value is string =>
    value !== null);
  const operation = candidateIds.map((id) => context.operations.get(id))
    .find((value): value is LogicalOperationRow => value !== undefined);
  const appTool = row.tool_name === 'todo_write' || row.tool_name === 'delegate_subagent';
  if (appTool) {
    const delegation = context.delegationsByToolCall.get(row.id);
    if (row.tool_name === 'delegate_subagent' && delegation !== undefined) {
      if (delegation.status === 'SUCCEEDED') {
        return { disposition: 'CONFIRMED_SUCCESS', effective_outcome: 'SUCCEEDED',
          operation_ref: null, operation_status: null, invocation_status: null,
          effect_state: 'NOT_APPLICABLE', reconcile_required: false, reconciled: false,
          resolved_at: iso(delegation.closed_at), provenance: 'LEDGER',
          reason: null, evidence_refs: [{ kind: 'DELEGATION', id: delegation.id }] };
      }
      if (delegation.status === 'FAILED' || delegation.status === 'CANCELLED') {
        return { disposition: 'CONFIRMED_FAILURE', effective_outcome: 'FAILED',
          operation_ref: null, operation_status: null, invocation_status: null,
          effect_state: 'NOT_APPLICABLE', reconcile_required: false, reconciled: false,
          resolved_at: iso(delegation.closed_at), provenance: 'LEDGER',
          reason: delegation.status, evidence_refs: [{ kind: 'DELEGATION', id: delegation.id }] };
      }
      return { disposition: 'UNRESOLVED_OPEN', effective_outcome: null, operation_ref: null,
        operation_status: null, invocation_status: null, effect_state: 'NOT_APPLICABLE',
        reconcile_required: true, reconciled: false, resolved_at: null,
        provenance: 'LIVE', reason: delegation.status,
        evidence_refs: [{ kind: 'DELEGATION', id: delegation.id }] };
    }
    if (row.status === 'SETTLED') {
      return { disposition: 'CONFIRMED_SUCCESS', effective_outcome: 'SUCCEEDED',
        operation_ref: null, operation_status: null, invocation_status: null,
        effect_state: 'NOT_APPLICABLE', reconcile_required: false, reconciled: false,
        resolved_at: iso(row.settled_at), provenance: 'LEDGER', reason: null,
        evidence_refs: [{ kind: 'TOOL_CALL', id: row.id }] };
    }
    if (row.status === 'ABANDONED') {
      return { disposition: 'CONFIRMED_NOT_EXECUTED', effective_outcome: 'NOT_EXECUTED',
        operation_ref: null, operation_status: null, invocation_status: null,
        effect_state: 'NOT_APPLICABLE', reconcile_required: false, reconciled: false,
        resolved_at: iso(row.settled_at), provenance: 'LEDGER',
        reason: row.rejection_reason ?? 'NOT_EXECUTED',
        evidence_refs: [{ kind: 'TOOL_CALL', id: row.id }] };
    }
    return { disposition: row.status === 'UNKNOWN' ? 'UNRESOLVED_UNKNOWN' : 'UNRESOLVED_OPEN',
      effective_outcome: null, operation_ref: null, operation_status: null,
      invocation_status: null, effect_state: 'NOT_APPLICABLE', reconcile_required: true,
      reconciled: false, resolved_at: null, provenance: 'LIVE',
      reason: row.rejection_reason, evidence_refs: [{ kind: 'TOOL_CALL', id: row.id }] };
    }
  if (operation === undefined) {
    if (row.status === 'UNKNOWN' || row.status === 'SETTLED') {
      // SETTLED 声称执行过，却找不到提交过的动作：这是证据缺口，不是「未执行」。
      return { disposition: 'OPERATION_MISSING', effective_outcome: null, operation_ref: null,
        operation_status: null, invocation_status: null, effect_state: 'NOT_APPLICABLE',
        reconcile_required: true, reconciled: false, resolved_at: null,
        provenance: 'ABSENT', reason: row.status === 'SETTLED'
          ? 'executed_without_committed_action' : 'operation_not_found',
        evidence_refs: [{ kind: 'TOOL_CALL', id: row.id }] };
    }
    if (row.status === 'REQUESTED' && messageActive) {
      // prepare 前/attach 前的正常窗口：动作可能马上被提交，不给出任何执行结论。
      return { disposition: 'UNRESOLVED_OPEN', effective_outcome: null, operation_ref: null,
        operation_status: null, invocation_status: null, effect_state: 'NOT_APPLICABLE',
        reconcile_required: true, reconciled: false, resolved_at: null, provenance: 'LIVE',
        reason: 'gateway_action_not_committed',
        evidence_refs: [{ kind: 'TOOL_CALL', id: row.id }] };
    }
    return { disposition: 'NO_OPERATION', effective_outcome: 'NOT_EXECUTED', operation_ref: null,
      operation_status: null, invocation_status: null, effect_state: 'NOT_APPLICABLE',
      reconcile_required: false, reconciled: false, resolved_at: null,
      provenance: 'ABSENT', reason: 'no_committed_gateway_action',
      evidence_refs: [{ kind: 'TOOL_CALL', id: row.id }] };
  }
  const originAllowed = operation.workspace_id === context.session.workspace_id &&
    operation.project_id === context.session.project_id &&
    (operation.origin === 'ASSISTANT_READ' || operation.origin === 'AGENT_SESSION_READ' ||
      operation.origin === 'AGENT_SESSION_WRITE') &&
    (operation.intent_key === `session-read:${row.id}` ||
      operation.intent_key === `session-write:${row.id}`) &&
    (context.session.working_resource_id === null || operation.resource_id === null ||
      operation.resource_id === context.session.working_resource_id);
  if (!originAllowed) {
    return { disposition: 'ORIGIN_UNVERIFIED', effective_outcome: null,
      operation_ref: operation.id, operation_status: operation.status, invocation_status: null,
      effect_state: 'UNKNOWN', reconcile_required: true, reconciled: false, resolved_at: null,
      provenance: 'LIVE', reason: 'origin_or_intent_mismatch',
      evidence_refs: [{ kind: 'OPERATION', id: operation.id }] };
  }
  const invocation = lastInvocation(context.invocationsByOperation.get(operation.id));
  const dispatched = hasDispatch(invocation);
  const effect = effectStateFor(operation, context);
  const terminalAt = (() => {
    const dates = [operation.updated_at, invocation?.resolved_at ?? null,
      effect.resolvedAt].filter((value): value is Date => value !== null);
    return dates.length === 0 ? null : new Date(Math.max(...dates.map((value) => value.getTime())));
  })();
  const evidenceRefs = [
    { kind: 'OPERATION', id: operation.id },
    ...(invocation === undefined ? [] : [{ kind: 'INVOCATION', id: invocation.id }]),
    ...(effect.changeSetId === null ? [] : [{ kind: 'CHANGE_SET', id: effect.changeSetId }]),
  ];
  const unresolved = (disposition: RecoveryDisposition, reason: string):
    ActivityRecovery => ({ disposition, effective_outcome: null, operation_ref: operation.id,
      operation_status: operation.status, invocation_status: invocation?.status ?? null,
      effect_state: effect.state, reconcile_required: true, reconciled: false,
      resolved_at: iso(terminalAt), provenance: 'LIVE', reason, evidence_refs: evidenceRefs });
  const confirmed = (disposition: RecoveryDisposition,
    outcome: ActivityRecovery['effective_outcome'], reason: string | null):
    ActivityRecovery => ({ disposition, effective_outcome: outcome,
      operation_ref: operation.id, operation_status: operation.status,
      invocation_status: invocation?.status ?? null, effect_state: effect.state,
      reconcile_required: false, reconciled: row.status === 'UNKNOWN',
      resolved_at: iso(terminalAt), provenance: 'RECONCILED', reason, evidence_refs: evidenceRefs });
  const isTerminal = operation.status === 'SUCCEEDED' || operation.status === 'FAILED' ||
    operation.status === 'DENIED' || operation.status === 'MANUALLY_CLOSED';
  if (row.status === 'UNKNOWN' && isTerminal) {
    const orderingProven = row.settled_at !== null && terminalAt !== null &&
      terminalAt.getTime() > row.settled_at.getTime();
    if (!orderingProven) return unresolved('ORDERING_UNPROVEN', 'evidence_before_unknown');
  }
  if (operation.status === 'PREPARED' || operation.status === 'WAITING_APPROVAL') {
    return unresolved('UNRESOLVED_OPEN', operation.status);
  }
  if (dispatched) {
    if (invocation?.status === 'SUCCEEDED' || operation.status === 'SUCCEEDED') {
      return confirmed('CONFIRMED_SUCCESS', 'SUCCEEDED', null);
    }
    if (invocation?.status === 'FAILED' || operation.status === 'FAILED') {
      if (effect.state === 'UNKNOWN' && operation.capability_key === 'FILE_WRITE') {
        return unresolved('UNRESOLVED_UNKNOWN', 'failure_effect_unconfirmed');
      }
      // Invocation 的 FAILED 本身就是真实失败证据；只有写类动作在效果未知时才需要继续
      // 待核对（上面那条 FILE_WRITE 分支）。会话行自己没落失败结果不改变 Gateway 的结论。
      const failureEvidence = effect.failureEvidence || invocation?.status === 'FAILED' ||
        invocation?.result_ref !== null || operation.result_ref !== null;
      if (!failureEvidence) return unresolved('UNRESOLVED_UNKNOWN', 'failure_evidence_missing');
      return confirmed('CONFIRMED_FAILURE', 'FAILED', 'failed_after_dispatch');
    }
    if (invocation?.status === 'DISPATCHING' || invocation?.status === 'UNKNOWN' ||
      operation.status === 'DISPATCHING' || operation.status === 'UNKNOWN') {
      return unresolved('UNRESOLVED_UNKNOWN', 'result_unresolved');
    }
    if (invocation?.status === 'NOT_EXECUTED') {
      return effect.state === 'UNKNOWN'
        ? unresolved('UNRESOLVED_UNKNOWN', 'not_executed_effect_unknown')
        : confirmed('CONFIRMED_NOT_EXECUTED', 'NOT_EXECUTED', 'not_executed');
    }
  }
  if (operation.status === 'DENIED' ||
      (operation.status === 'FAILED' && !dispatched) ||
      (operation.status === 'MANUALLY_CLOSED' && effect.state !== 'UNKNOWN')) {
    return confirmed('CONFIRMED_NOT_EXECUTED', 'NOT_EXECUTED', operation.status);
  }
  if (operation.status === 'MANUALLY_CLOSED') {
    if (effect.state === 'PARTIAL') return confirmed('CONFIRMED_FAILURE', 'FAILED',
      'manual_close_partial');
    return unresolved('UNRESOLVED_UNKNOWN', 'manual_close_effect_unresolved');
  }
  return unresolved('UNRESOLVED_UNKNOWN', 'result_unresolved');
}

function activityForModel(call: ModelCallRow, message: AssistMessageRow,
  rank: number): ActivityItem {
  const started = iso(call.started_at);
  const ended = iso(call.settled_at);
  const view = call.status === 'STARTED'
    ? (call.first_text_delta_at !== null ? 'RECEIVING_TEXT'
      : call.first_stream_event_at !== null ? 'WAITING_TEXT' : 'WAITING_RESPONSE')
    : call.status === 'COMPLETED' ? 'COMPLETED'
      : call.status === 'FAILED' ? 'FAILED' : 'CANCELLED';
  const tone = call.status === 'STARTED' ? 'active' : call.status === 'COMPLETED'
    ? 'success' : call.status === 'FAILED' ? 'error' : 'neutral';
  return {
    activity_id: `model-call:${call.id}`,
    kind: 'MODEL_CALL',
    owner: { kind: 'SESSION_MESSAGE', session_id: message.session_id, message_id: message.id },
    source: { table: 'model_calls', row_id: call.id },
    state: { raw: call.status, view, tone, terminal: call.status !== 'STARTED' },
    started_at: started,
    ended_at: ended,
    order: { message_seq: String(message.seq), round: null, ordinal: null, rank },
    refs: { model_call_id: call.id, tool_call_id: null, operation_id: null,
      invocation_id: null },
    wait: call.status === 'STARTED' ? {
      code: call.first_stream_event_at === null ? 'PROVIDER_RESPONSE' : 'TEXT',
      detail: null,
    } : null,
    error: call.status === 'FAILED' ? { code: call.error_kind ?? 'MODEL_FAILED',
      detail: null } : null,
    evidence: { result_available: false, result_digest: null, failure_kind: call.error_kind,
      detail_visibility: 'USER' },
    recovery: null,
    facts: null,
  };
}

function activityForTool(row: SessionToolCallRow, message: AssistMessageRow,
  recovery: ActivityRecovery, rank: number): ActivityItem {
  const view = recovery.disposition === 'CONFIRMED_SUCCESS' ? 'SUCCEEDED'
    : recovery.disposition === 'CONFIRMED_FAILURE' ? 'FAILED'
      : recovery.disposition === 'CONFIRMED_NOT_EXECUTED' ||
        recovery.disposition === 'NO_OPERATION' ? 'NOT_EXECUTED'
        : recovery.disposition === 'UNRESOLVED_OPEN' ? 'PENDING' : 'UNKNOWN';
  const tone = view === 'SUCCEEDED' ? 'success' : view === 'FAILED' ? 'error'
    : view === 'NOT_EXECUTED' ? 'neutral' : view === 'PENDING' ? 'wait' : 'active';
  return {
    activity_id: `tool-call:${row.id}`,
    kind: row.tool_name === 'todo_write' ? 'TODO_WRITE' : 'TOOL_CALL',
    owner: { kind: 'SESSION_MESSAGE', session_id: message.session_id, message_id: message.id },
    source: { table: 'session_tool_calls', row_id: row.id },
    state: { raw: row.status, view, tone, terminal: row.status !== 'REQUESTED' },
    started_at: iso(row.requested_at),
    ended_at: iso(row.settled_at),
    order: { message_seq: String(message.seq), round: row.round, ordinal: row.ordinal, rank },
    refs: { model_call_id: null, tool_call_id: row.id, operation_id: recovery.operation_ref,
      invocation_id: recovery.evidence_refs.find((ref) => ref.kind === 'INVOCATION')?.id ?? null },
    wait: view === 'PENDING' || view === 'UNKNOWN'
      ? { code: recovery.reason ?? view, detail: null } : null,
    error: view === 'FAILED' ? { code: recovery.reason ?? 'TOOL_FAILED', detail: null } : null,
    evidence: { result_available: row.result_digest !== null, result_digest: row.result_digest,
      failure_kind: view === 'FAILED' ? recovery.reason : null, detail_visibility: 'USER' },
    recovery,
    facts: null,
    tool_name: row.tool_name,
  };
}

function activityForDelegation(delegation: AssistDelegationRow,
  message: AssistMessageRow, rank: number): ActivityItem {
  const terminal = delegation.status === 'SUCCEEDED' || delegation.status === 'FAILED' ||
    delegation.status === 'CANCELLED';
  const view = delegation.status === 'QUEUED' ? 'QUEUED'
    : delegation.status === 'RUNNING' ? 'RUNNING'
      : delegation.status === 'SUCCEEDED' ? 'SUCCEEDED'
        : delegation.status === 'FAILED' ? 'FAILED' : 'CANCELLED';
  return {
    activity_id: `delegation:${delegation.id}`,
    kind: 'DELEGATION',
    owner: { kind: 'SESSION_MESSAGE', session_id: message.session_id, message_id: message.id },
    source: { table: 'assist_delegations', row_id: delegation.id },
    state: { raw: delegation.status, view, tone: delegation.status === 'FAILED' ? 'error'
      : terminal ? (delegation.status === 'SUCCEEDED' ? 'success' : 'neutral') : 'active',
    terminal },
    started_at: iso(delegation.created_at),
    ended_at: iso(delegation.closed_at),
    order: { message_seq: String(message.seq), round: null, ordinal: null, rank },
    refs: { model_call_id: null, tool_call_id: delegation.parent_tool_call_id,
      operation_id: null, invocation_id: null },
    wait: terminal ? null : { code: delegation.status, detail: null },
    error: delegation.status === 'FAILED' ? { code: 'DELEGATION_FAILED', detail: null } : null,
    evidence: { result_available: delegation.result_summary !== null, result_digest: null,
      failure_kind: delegation.status === 'FAILED' ? 'DELEGATION_FAILED' : null,
      detail_visibility: 'USER' },
    recovery: null,
    facts: null,
    delegation_role: delegation.role,
    child_session_id: delegation.child_session_id,
    attempt_count: delegation.attempt_count,
    max_attempts: delegation.max_attempts,
    result_summary: delegation.result_summary,
  };
}

function phaseFor(message: AssistMessageRow, modelCalls: readonly ModelCallRow[],
  toolRows: readonly SessionToolCallRow[], recoveries: ReadonlyMap<string, ActivityRecovery>,
  run: RunSummary | null): MessagePhase {
  const base = basePhaseFor(message, modelCalls, toolRows, recoveries, run);
  // 0163：中断接续事实只由服务端派生。前端读 phase.detail / wait，不自行推断恢复成功。
  if (message.status === 'PENDING' && message.generation_attempt > 1) {
    return { raw: message.status, view: 'RECOVERING', tone: 'wait',
      since: iso(message.interrupted_at ?? message.created_at),
      detail: `上次执行意外中断，正在自动恢复（第 ${message.generation_attempt} 次生成）`,
      wait: { code: 'RECOVERY', detail: message.interruption_reason } };
  }
  if (message.status === 'FAILED' && message.error_code === 'RECOVERY_BLOCKED_UNRESOLVED_TOOL') {
    return { raw: message.status, view: 'BLOCKED', tone: 'error',
      since: iso(message.settled_at),
      detail: '执行中断；有外部操作结果未确认，需要人工核对',
      wait: { code: 'RECOVERY_BLOCKED_UNRESOLVED_TOOL',
        detail: '存在未结算的有副作用工具请求或 UNKNOWN 动作；核对真实结果后才能继续。' } };
  }
  if (message.status === 'FAILED' && message.error_code === 'RECOVERY_EXHAUSTED') {
    return { raw: message.status, view: 'RECOVERY_EXHAUSTED', tone: 'error',
      since: iso(message.settled_at),
      detail: `已自动恢复 ${Math.max(0, message.generation_attempt - 1)} 次仍未完成，已停止自动重试`,
      wait: { code: 'RECOVERY_EXHAUSTED', detail: '可以重新发送请求或检查执行环境。' } };
  }
  if (message.status === 'RUNNING' && message.generation_attempt > 1) {
    return { ...base, detail: `已自动恢复 · ${base.detail}` };
  }
  return base;
}

function basePhaseFor(message: AssistMessageRow, modelCalls: readonly ModelCallRow[],
  toolRows: readonly SessionToolCallRow[], recoveries: ReadonlyMap<string, ActivityRecovery>,
  run: RunSummary | null): MessagePhase {
  const terminal = (view: string, tone: MessagePhase['tone'], detail: string,
    since: Date | null, wait: MessagePhase['wait'] = null): MessagePhase =>
    ({ raw: message.status, view, tone, since: iso(since), detail, wait });
  if (message.status === 'CANCELLED') return terminal('CANCELLED', 'neutral',
    '已取消；已停止后续动作', message.settled_at);
  if (message.status === 'FAILED' && message.error_code === 'LEASE_LOST') {
    return terminal('INTERRUPTED', 'error', '执行中断；部分结果可能未确认',
      message.settled_at, { code: 'LEASE_LOST', detail: '结果待核对' });
  }
  if (message.status === 'FAILED') return terminal('FAILED', 'error', '执行失败',
    message.settled_at);
  if (message.status === 'COMPLETED') return terminal('COMPLETED', 'success',
    '回复已完成', message.settled_at);
  if (message.cancel_requested) {
    // 取消意图已持久化但生成方尚未结算：没有记录取消发起时刻，因此 since 保持 null，
    // 不能用心跳 updated_at 冒充起点。
    return terminal('CANCELLING', 'wait', '正在取消；等待当前动作安全结束', null,
      { code: 'CANCEL_REQUESTED', detail: null });
  }
  if (message.status === 'PENDING') return terminal('WAITING_WORKER', 'wait',
    '已排队，等待执行', message.created_at, { code: 'QUEUE', detail: null });
  if (message.status === 'RUNNING' && message.generation_attempt > 1 &&
      message.interrupted_at !== null) {
    // 0163：上一次尝试的调用行还在账本里。它早于中断时刻就说明本回合还没有登记新请求，
    // 不能据此显示「正在处理返回结果」——那是上一次尝试的结论。
    const previous = modelCalls.slice().sort((left, right) =>
      right.started_at.getTime() - left.started_at.getTime())[0];
    if (previous === undefined || previous.started_at < message.interrupted_at) {
      return terminal('RECOVERING', 'wait', '正在恢复原任务，准备下一次请求',
        message.interrupted_at, { code: 'RECOVERY', detail: message.interruption_reason });
    }
  }
  const unresolvedTool = toolRows.find((row) => {
    const recovery = recoveries.get(row.id);
    return recovery !== undefined && recovery.reconcile_required;
  });
  if (unresolvedTool !== undefined) {
    const recovery = recoveries.get(unresolvedTool.id)!;
    if (recovery.disposition === 'UNRESOLVED_OPEN' &&
        recovery.operation_status === 'WAITING_APPROVAL') {
      return terminal('WAITING_APPROVAL', 'wait', '等待审批',
        unresolvedTool.requested_at, { code: 'APPROVAL', detail: recovery.reason });
    }
    const unknown = recovery.disposition === 'UNRESOLVED_UNKNOWN' ||
      recovery.disposition === 'ORDERING_UNPROVEN' ||
      recovery.disposition === 'OPERATION_MISSING' ||
      recovery.disposition === 'ORIGIN_UNVERIFIED';
    return terminal(unknown ? 'WAITING_CONFIRMATION' : 'RUNNING_TOOL',
      unknown ? 'wait' : 'active',
      unknown ? '工具有结果待核对'
        : recovery.operation_status === 'PREPARED' ? '工具请求已登记，准备执行' : '正在执行工具',
      unresolvedTool.requested_at, { code: recovery.reason ?? recovery.disposition,
        detail: null });
    }
  const runningTool = toolRows.find((row) => row.status === 'REQUESTED');
  if (runningTool !== undefined) {
    // 账本行还停在 REQUESTED，但 Gateway 证据已经给出结论：阶段必须跟着证据走，
    // 不能继续写「正在执行」。这不是替运行时结算，只是把已确认的事实说出来。
    const recovery = recoveries.get(runningTool.id);
    if (recovery?.disposition === 'CONFIRMED_NOT_EXECUTED') {
      return terminal('TOOL_NOT_EXECUTED', 'neutral', '工具已确认未执行，等待后续处理',
        runningTool.requested_at, { code: recovery.reason ?? 'NOT_EXECUTED', detail: null });
    }
    if (recovery?.disposition === 'CONFIRMED_FAILURE') {
      return terminal('TOOL_FAILED', 'error', '工具执行失败，等待后续处理',
        runningTool.requested_at, { code: recovery.reason ?? 'TOOL_FAILED', detail: null });
    }
    if (recovery?.disposition === 'CONFIRMED_SUCCESS') {
      return terminal('TOOL_SETTLING', 'wait', '工具已完成，等待写入结果',
        runningTool.requested_at, { code: 'TOOL_SETTLING', detail: null });
    }
    return terminal('RUNNING_TOOL', 'active', '正在执行工具', runningTool.requested_at,
      { code: 'TOOL_RUNNING', detail: null });
  }
  const lastModel = modelCalls.slice().sort((left, right) =>
    right.started_at.getTime() - left.started_at.getTime())[0];
  if (lastModel !== undefined && lastModel.status === 'STARTED') {
    if (lastModel.first_text_delta_at !== null) {
      return terminal('RECEIVING_TEXT', 'active', '正在接收回复',
        lastModel.first_text_delta_at, { code: 'TEXT', detail: null });
    }
    if (lastModel.first_stream_event_at !== null) {
      return terminal('WAITING_TEXT', 'wait', '模型已响应，等待文本',
        lastModel.first_stream_event_at, { code: 'TEXT', detail: null });
    }
    return terminal('WAITING_MODEL_RESPONSE', 'wait', '模型请求已登记，等待响应',
      lastModel.started_at, { code: 'MODEL_RESPONSE', detail: null });
  }
  if (run !== null && run.wait_reason !== null) {
    return terminal(run.wait_reason.includes('APPROVAL') ? 'WAITING_APPROVAL' : 'RUNNING_RUN',
      'wait', run.wait_reason, message.claimed_at ?? message.created_at,
      { code: 'RUN_WAIT', detail: run.wait_reason });
  }
  if (message.claimed_at !== null && modelCalls.length === 0) {
    return terminal('PREPARING_CONTEXT', 'active', '已领取，准备本次请求',
      message.claimed_at, { code: 'PREPARING', detail: null });
  }
  if (message.claimed_at === null) {
    return terminal('RUNNING_UNKNOWN_CLAIM_TIME', 'wait', '正在执行；领取时间未记录',
      null, { code: 'CLAIM_TIME_MISSING', detail: null });
  }
  return terminal('PROCESSING', 'active', '正在处理', message.claimed_at,
    { code: 'PROCESSING', detail: null });
}

function signalFor(message: AssistMessageRow, sourceUserMessageId: string | null,
  phase: MessagePhase, activities: readonly ActivityItem[],
  executionRequest: ExecutionRequestSummary | null, run: RunSummary | null,
  gaps: readonly { code: string; refs: JsonObject }[]): JsonObject {
  const activitySignals = activities.map((activity) => ({
    activity_id: activity.activity_id,
    kind: activity.kind,
    raw: activity.state.raw,
    view: activity.state.view,
    started_at: activity.started_at,
    ended_at: activity.ended_at,
    refs: activity.refs as unknown as JsonObject,
    result_available: activity.evidence.result_available,
    failure_kind: activity.evidence.failure_kind,
    tool_name: activity.tool_name ?? null,
    delegation_role: activity.delegation_role ?? null,
    attempt_count: activity.attempt_count ?? null,
    disposition: activity.recovery?.disposition ?? null,
    effective_outcome: activity.recovery?.effective_outcome ?? null,
    operation_status: activity.recovery?.operation_status ?? null,
    invocation_status: activity.recovery?.invocation_status ?? null,
    effect_state: activity.recovery?.effect_state ?? null,
  }));
  return {
    message_id: message.id,
    seq: String(message.seq),
    role: message.role,
    status: message.status,
    intent: message.intent,
    created_at: message.created_at.toISOString(),
    claimed_at: iso(message.claimed_at),
    settled_at: iso(message.settled_at),
    cancel_requested: message.cancel_requested,
    error_code: message.error_code,
    source_user_message_id: sourceUserMessageId,
    phase: {
      raw: phase.raw,
      view: phase.view,
      tone: phase.tone,
      since: phase.since,
      detail: phase.detail,
      wait: phase.wait === null ? null : { code: phase.wait.code, detail: phase.wait.detail },
    },
    execution_request: executionRequest === null ? null : {
      request_id: executionRequest.request_id,
      status: executionRequest.status,
      decision: executionRequest.decision,
      candidate_status: executionRequest.candidate_status,
      task_id: executionRequest.task_id,
      run_id: executionRequest.run_id,
      failure_code: executionRequest.failure_code,
    },
    run_summary: run === null ? null : {
      run_id: run.run_id,
      status: run.status,
      current_step_kind: run.current_step_kind,
      wait_reason: run.wait_reason,
      unresolved_count: run.unresolved_count,
    },
    activities: activitySignals,
    gaps: gaps as unknown as readonly JsonValue[],
  } as unknown as JsonObject;
}

function fingerprint(signal: JsonObject): string {
  return `sha256:${createHash('sha256').update(canonicalizeJson(signal), 'utf8')
    .digest('hex')}`;
}

function emptyRecoveryContext(session: AssistSessionRow): RecoveryContext {
  return { session, operations: new Map(), invocationsByOperation: new Map(),
    changeSetsByOperation: new Map(), filesByChangeSet: new Map(),
    delegationsByToolCall: new Map() };
}

async function loadRecoveryContext(db: DbExecutor, session: AssistSessionRow,
  toolRows: readonly SessionToolCallRow[],
  delegations: readonly AssistDelegationRow[]):
  Promise<RecoveryContext> {
  const operationIds = [...new Set(toolRows.flatMap((row) =>
    [row.operation_id, row.id]).filter((value): value is string => value !== null))];
  if (operationIds.length === 0) {
    return { ...emptyRecoveryContext(session), delegationsByToolCall: new Map(
      delegations.flatMap((row) => row.parent_tool_call_id === null ? []
        : [[row.parent_tool_call_id, row] as const])) };
  }
  const operations = (await sql<LogicalOperationRow>`select * from logical_operations
    where id in (${sql.join(operationIds, sql`, `)})`.execute(db)).rows;
  if (operations.length === 0) {
    return { ...emptyRecoveryContext(session), delegationsByToolCall: new Map(
      delegations.flatMap((row) => row.parent_tool_call_id === null ? []
        : [[row.parent_tool_call_id, row] as const])) };
  }
  const operationMap = new Map(operations.map((row) => [row.id, row]));
  const invocations = (await sql<InvocationAttemptRow>`select * from invocation_attempts
    where operation_id in (${sql.join(operations.map((row) => row.id), sql`, `)})`
    .execute(db)).rows;
  const invocationMap = new Map<string, InvocationAttemptRow[]>();
  for (const row of invocations) {
    const list = invocationMap.get(row.operation_id) ?? [];
    list.push(row);
    invocationMap.set(row.operation_id, list);
  }
  const changeSets = (await sql<ChangeSetRow>`select * from change_sets
    where operation_id in (${sql.join(operations.map((row) => row.id), sql`, `)})`
    .execute(db)).rows;
  const changeSetMap = new Map<string, ChangeSetRow[]>();
  for (const row of changeSets) {
    const list = changeSetMap.get(row.operation_id) ?? [];
    list.push(row);
    changeSetMap.set(row.operation_id, list);
  }
  const files = changeSets.length === 0 ? [] :
    (await sql<ChangeSetFileRow>`select * from change_set_files
      where change_set_id in (${sql.join(changeSets.map((row) => row.id), sql`, `)})`
      .execute(db)).rows;
  const fileMap = new Map<string, ChangeSetFileRow[]>();
  for (const row of files) {
    const list = fileMap.get(row.change_set_id) ?? [];
    list.push(row);
    fileMap.set(row.change_set_id, list);
  }
  return { session, operations: operationMap,
    invocationsByOperation: invocationMap, changeSetsByOperation: changeSetMap,
    filesByChangeSet: fileMap,
    delegationsByToolCall: new Map(delegations.flatMap((row) =>
      row.parent_tool_call_id === null ? [] : [[row.parent_tool_call_id, row] as const])) };
}

/**
 * 「还要人核对」的事项。正常的在途窗口不是缺口：prepare/attach 之间、等待审批与
 * 派发中的动作仍在推进，把它们计成待核对会让每一次工具执行都亮黄。
 */
function gapsFor(message: AssistMessageRow, toolRows: readonly SessionToolCallRow[],
  recoveries: ReadonlyMap<string, ActivityRecovery>): { code: string; refs: JsonObject }[] {
  const gaps: { code: string; refs: JsonObject }[] = [];
  const active = message.status === 'PENDING' || message.status === 'RUNNING';
  for (const row of toolRows) {
    const recovery = recoveries.get(row.id);
    if (recovery === undefined || !recovery.reconcile_required) continue;
    const inProgress = active && recovery.disposition === 'UNRESOLVED_OPEN' &&
      (recovery.operation_status === null || recovery.operation_status === 'PREPARED' ||
        recovery.operation_status === 'WAITING_APPROVAL' ||
        recovery.operation_status === 'DISPATCHING');
    if (inProgress) continue;
    gaps.push({ code: recovery.disposition === 'UNRESOLVED_OPEN'
        ? 'GATEWAY_OPERATION_NOT_CLOSED' : recovery.disposition, refs: {
        tool_call_id: row.id, operation_id: recovery.operation_ref,
        reason: recovery.reason,
      } });
  }
  if (message.claimed_at === null && message.status !== 'PENDING') {
    gaps.push({ code: 'CLAIM_TIME_MISSING', refs: { message_id: message.id } });
  }
  return gaps;
}

export async function readExecutionActivity(db: DbExecutor, input: {
  workspaceId: string; sessionId: string; limit?: number; beforeSeq?: bigint;
  detail?: 'summary' | 'full';
}): Promise<ExecutionActivitySnapshot> {
  const repositories = createRepositories(db);
  const session = await repositories.assist.readSession(input.sessionId);
  if (session === undefined || session.workspace_id !== input.workspaceId) {
    throw resourceNotFound('Assist session');
  }
  const page = await repositories.assist.listMessagesPage(session.id, {
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.beforeSeq === undefined ? {} : { beforeSeq: input.beforeSeq }),
  });
  const assistantMessages = page.items.filter((row) => row.role === 'ASSISTANT');
  const messageIds = assistantMessages.map((row) => row.id);
  const toolRows = await new SessionToolCallRepository(db).listByMessages(messageIds);
  const modelCalls = messageIds.length === 0 ? [] :
    await new ModelCallRepository(db).listForAssistMessages(messageIds);
  const delegations = messageIds.length === 0 ? [] :
    (await sql<AssistDelegationRow>`select * from assist_delegations
      where parent_message_id in (${sql.join(messageIds, sql`, `)})`.execute(db)).rows;
  const userMessages = page.items.filter((row) => row.role === 'USER');
  const executionRequests = userMessages.length === 0 ? [] :
    (await sql<ConversationExecutionRequestRow>`select * from conversation_execution_requests
      where source_message_id in (${sql.join(userMessages.map((row) => row.id), sql`, `)})`
      .execute(db)).rows;
  const requestByUserMessage = new Map(executionRequests.map((row) =>
    [row.source_message_id, row]));
  const runIds = [...new Set(executionRequests.flatMap((row) =>
    row.run_id === null ? [] : [row.run_id]))];
  const runs = runIds.length === 0 ? [] :
    (await sql<RunRow>`select * from runs where id in (${sql.join(runIds, sql`, `)})`
      .execute(db)).rows;
  const stepIds = runs.flatMap((row) => row.current_step_id === null ? [] : [row.current_step_id]);
  const steps = stepIds.length === 0 ? [] :
    (await sql<RunStepRow>`select * from run_steps where id in (${sql.join(stepIds, sql`, `)})`
      .execute(db)).rows;
  const runMap = new Map(runs.map((row) => [row.id, row]));
  const stepMap = new Map(steps.map((row) => [row.id, row]));
  const context = await loadRecoveryContext(db, session, toolRows, delegations);
  const activeByMessage = new Map(page.items.map((row) => [row.id,
    row.status === 'PENDING' || row.status === 'RUNNING']));
  const recoveries = new Map(toolRows.map((row) => [row.id,
    recoveryFor(row, context, activeByMessage.get(row.message_id) ?? false)]));
  const toolByMessage = new Map<string, SessionToolCallRow[]>();
  for (const row of toolRows) {
    const list = toolByMessage.get(row.message_id) ?? [];
    list.push(row);
    toolByMessage.set(row.message_id, list);
  }
  const modelByMessage = new Map<string, ModelCallRow[]>();
  for (const row of modelCalls) {
    if (row.assist_message_id === null) continue;
    const list = modelByMessage.get(row.assist_message_id) ?? [];
    list.push(row);
    modelByMessage.set(row.assist_message_id, list);
  }
  const delegationByMessage = new Map<string, AssistDelegationRow[]>();
  for (const row of delegations) {
    const list = delegationByMessage.get(row.parent_message_id) ?? [];
    list.push(row);
    delegationByMessage.set(row.parent_message_id, list);
  }
  // AssistMessageRow 没有 source_user_message_id 列；按同一页 seq 顺序取紧邻前一条 USER。
  const sourceUserByAssistant = new Map<string, string>();
  let precedingUser: AssistMessageRow | undefined;
  for (const item of page.items) {
    if (item.role === 'USER') precedingUser = item;
    else if (item.role === 'ASSISTANT' && precedingUser !== undefined) {
      sourceUserByAssistant.set(item.id, precedingUser.id);
    }
  }
  const messages = assistantMessages.map((message): MessageActivity => {
    const messageTools = toolByMessage.get(message.id) ?? [];
    // 过程区只列**这一次回复的主调用**（2026-11-10）。TITLE / MEMORY_CAPTURE /
    // MEMORY_COMPACT 是挂在同一条消息上的辅助外呼：它们会出现在账本与导出里，
    // 但不是用户可见回复的步骤。不过滤会把一句问候读成「模型 3 次」，
    // 也与 token 读数（本来就只含 PRIMARY）对不上。
    const messageModels = (modelByMessage.get(message.id) ?? [])
      .filter((call) => call.purpose === 'PRIMARY');
    const sourceUserMessageId = sourceUserByAssistant.get(message.id) ?? null;
    const request = sourceUserMessageId === null ? undefined
      : requestByUserMessage.get(sourceUserMessageId);
    const run = request === undefined || request.run_id === null ? null
      : (() => {
        const row = runMap.get(request.run_id);
        if (row === undefined) return null;
        const step = row.current_step_id === null ? undefined : stepMap.get(row.current_step_id);
        return { run_id: row.id, status: row.status,
          current_step_kind: step?.step_kind ?? null, wait_reason: row.wait_reason,
          unresolved_count: messageTools.filter((tool) =>
            recoveries.get(tool.id)?.reconcile_required === true).length,
          updated_at: row.updated_at.toISOString(), run_event_seq: null } satisfies RunSummary;
      })();
    const executionRequest: ExecutionRequestSummary | null = request === undefined ? null : {
      request_id: request.id, status: request.status, decision: request.decision,
      candidate_status: request.candidate_status, task_id: request.task_id,
      run_id: request.run_id, failure_code: null,
    };
    const phase = phaseFor(message, messageModels, messageTools, recoveries, run);
    const activities: ActivityItem[] = [
      ...messageModels.map((call, index) => activityForModel(call, message, index + 1)),
      ...messageTools.map((row, index) => activityForTool(row, message,
        recoveries.get(row.id)!, 10 + index)),
      ...(delegationByMessage.get(message.id) ?? []).map((row, index) =>
        activityForDelegation(row, message, 20 + index)),
    ];
    const gaps = gapsFor(message, messageTools, recoveries);
    const signal = signalFor(message, sourceUserMessageId, phase, activities,
      executionRequest, run, gaps);
    const contentFingerprint = fingerprint(signal);
    return {
      message_id: message.id,
      seq: String(message.seq),
      role: message.role,
      status: message.status,
      intent: message.intent,
      created_at: message.created_at.toISOString(),
      claimed_at: iso(message.claimed_at),
      settled_at: iso(message.settled_at),
      updated_at: message.updated_at.toISOString(),
      cancel_requested: message.cancel_requested,
      source_user_message_id: sourceUserMessageId,
      content_fingerprint: contentFingerprint,
      activity_version: null,
      process_evidence: messageModels.length > 0 || messageTools.length > 0
        ? 'RECORDED' : 'UNKNOWN',
      phase,
      execution_request: executionRequest,
      run_summary: run,
      activities: input.detail === 'summary' ? undefined : activities,
      activity_counts: {
        model_calls: messageModels.length,
        tool_calls: messageTools.filter((row) => row.tool_name !== 'todo_write').length,
        todo_writes: messageTools.filter((row) => row.tool_name === 'todo_write').length,
        delegations: (delegationByMessage.get(message.id) ?? []).length,
      },
      gaps,
    };
  });
  const now = new Date();
  return {
    schema_version: 1,
    session: { id: session.id, workspace_id: session.workspace_id,
      status: session.status, conversation_mode: session.conversation_mode,
      revision: String(session.revision) },
    generated_at: now.toISOString(),
    snapshot_at: now.toISOString(),
    messages,
    next_before_seq: page.nextBeforeSeq === null ? null : String(page.nextBeforeSeq),
    has_more: page.hasMore,
  };
}
