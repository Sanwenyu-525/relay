import { randomUUID } from 'node:crypto';

import { ActivityRecordRepository } from '../audit/activity-record-repository.js';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import { ModelCallRepository, type ModelCallOrigin,
  type ModelCallSettlement } from '../model/model-call-repository.js';
import type { ModelIdentity } from '../workflow/fake-model-port.js';
import { classifyProviderError } from '../workflow/model-error-classification.js';

/**
 * 首个流事件证据写入的阻塞上限。超过后流回调继续处理正文，证据写入仍在后台完成；
 * 这个值只限制「等待」时长，不改变已写入的事实。
 */
const FIRST_STREAM_EVIDENCE_TIMEOUT_MS = 500;

/** The begin insert commits before invoking a Provider. A lost process leaves
 * STARTED as an unknown outcome and never silently invents zero usage. */
export async function recordModelInvocation<T>(db: DbExecutor, input: {
  readonly callId?: string;
  readonly origin: ModelCallOrigin;
  /**
   * 0145：本次请求的上下文构成。与 STARTED 行一起提交——它是「这次调用送进去了什么」
   * 的事实，必须在调用发出前就固定；结算时再补写就变成事后重构。
   */
  readonly contextUsage?: JsonObject;
  readonly identity: ModelIdentity;
  readonly signal?: AbortSignal;
  readonly invoke: (callId: string) => Promise<T>;
  readonly settle: (result: T) => ModelCallSettlement;
}): Promise<{ readonly callId: string; readonly result: T }> {
  const callId = input.callId ?? randomUUID();
  const calls = new ModelCallRepository(db);
  await calls.begin(callId, input.contextUsage === undefined ? input.origin
    : { ...input.origin, contextUsage: input.contextUsage }, input.identity);
  let result: T;
  try {
    result = await input.invoke(callId);
  } catch (error) {
    const evidence = typeof error === 'object' && error !== null
      ? error as { providerRequestId?: unknown; usage?: unknown } : {};
    const usage = evidence.usage;
    const fields = typeof usage === 'object' && usage !== null
      ? usage as { inputTokens?: unknown; outputTokens?: unknown;
        cacheReadTokens?: unknown; cacheCreationTokens?: unknown } : {};
    const knownUsage = 'inputTokens' in fields && 'outputTokens' in fields &&
      (fields.inputTokens === null || (Number.isSafeInteger(fields.inputTokens) &&
        (fields.inputTokens as number) >= 0)) &&
      (fields.outputTokens === null || (Number.isSafeInteger(fields.outputTokens) &&
        (fields.outputTokens as number) >= 0))
      ? { inputTokens: fields.inputTokens as number | null,
        outputTokens: fields.outputTokens as number | null,
        cacheReadTokens: cacheToken(fields.cacheReadTokens),
        cacheCreationTokens: cacheToken(fields.cacheCreationTokens) } : undefined;
    // Provider 传输层失败记统一分类（与连接验证同一词表，可聚合）；Relay 自身的
    // 预算、工具拒绝、语义解析等失败不是 Provider 故障，保留错误名以便定位。
    const aborted = input.signal?.aborted === true;
    const providerCategory = aborted ? undefined : classifyProviderError(error);
    await calls.settle(callId, { status: aborted ? 'CANCELLED' : 'FAILED',
      errorKind: aborted ? null
        : providerCategory ?? (error instanceof Error ? error.name : 'UNKNOWN'),
      ...(typeof evidence.providerRequestId === 'string'
        ? { providerRequestId: evidence.providerRequestId } : {}),
      ...(knownUsage === undefined ? {} : { usage: knownUsage }) });
    throw error;
  }
  await calls.settle(callId, input.settle(result));
  return { callId, result };
}

/**
 * 首个 Provider 流事件的**观测**（AGENT_STREAM_VISIBILITY，2026-11-01）。
 *
 * 这是证据写入，不是业务动作：写不进去（调用已结算、租约已失、数据库瞬时错误）
 * 都不能把一次成功的模型调用改判成失败。条件 UPDATE 只记第一次；调用方与免费路由
 * 重复包装时第二次是空操作。
 */
export async function observeModelFirstStream(db: DbExecutor, callId: string): Promise<void> {
  // 有界观测：这条证据写入位于 Provider 流回调内。正常情况下是几毫秒的条件 UPDATE；
  // 数据库瞬时变慢时不能把它变成正文增量的阻塞点。超时后仍让原写入在后台完成，
  // 只是不继续阻塞流读取；写失败/超时都不会改判业务调用。
  let timer: ReturnType<typeof setTimeout> | undefined;
  const write = recordFirstStreamEvidence(db, callId);
  try {
    await Promise.race([write, new Promise<void>((resolve) => {
      timer = setTimeout(resolve, FIRST_STREAM_EVIDENCE_TIMEOUT_MS);
      timer.unref?.();
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function recordFirstStreamEvidence(db: DbExecutor, callId: string): Promise<void> {
  try {
    await new ModelCallRepository(db).recordFirstStreamEvent(callId, new Date());
  } catch (error) {
    // ENG-OBS-02：证据写入失败不能改判业务结算；只留可诊断记录，绝不再抛出。
    try {
      const call = await new ModelCallRepository(db).read(callId);
      if (call !== undefined) {
        await new ActivityRecordRepository(db).insertActivityRecord({
          id: randomUUID(),
          workspaceId: call.workspace_id,
          actorKind: 'SYSTEM',
          actorRef: 'model-call-evidence',
          commandId: null,
          projectId: null,
          taskId: null,
          runId: null,
          eventType: 'MODEL_CALL_EVIDENCE_WRITE_FAILED',
          factRefs: {
            model_call_id: callId,
            assist_message_id: call.assist_message_id,
            step_attempt_id: call.step_attempt_id,
            error_name: error instanceof Error ? error.name : 'UNKNOWN',
            observed_at: new Date().toISOString(),
          },
        });
      }
    } catch (diagnosticError) {
      // 诊断写入也失败时只写服务器日志；调用结算、正文与预览仍走原路径。
      console.error('MODEL_CALL_EVIDENCE_WRITE_FAILED', {
        callId,
        errorName: error instanceof Error ? error.name : 'UNKNOWN',
        diagnosticErrorName: diagnosticError instanceof Error
          ? diagnosticError.name : 'UNKNOWN',
      });
    }
  }
}

/** Provider cache fields are optional extras; absent or malformed means unknown. */
function cacheToken(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}
