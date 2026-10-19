import type { ServerResponse } from 'node:http';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { DomainError } from '../application/domain-error.js';
import { readAssistLivePreview } from '../application/assist-queries.js';
import { readRunDraftPreview, type RunDraftPreviewDto } from '../application/run-draft-preview.js';
import { createRepositories } from '../application/unit-of-work.js';
import type { DbExecutor } from '../infrastructure/database.js';
import type { ManagedContentStore } from '../storage/managed-content-store.js';
import { sendReadError } from './envelope.js';
import { waitForPoll, writeRunEventFrame } from './run-events-api.js';

/**
 * 生成中预览 SSE 推送（docs/api/http-command-contract.md §10.59）。
 *
 * 与 run_events 的口径差异：帧体即与 GET 完全相同的预览 DTO，不是刷新提示。
 * 权限不变式与 GET 一致——每一帧的文本都来自一次完整的重新授权读取（同函数、
 * 同成本）；主键快查只是节流信号，不授权、不承载内容（commit-point 语义：
 * 只从已提交且仍可见的内容推 UI）。
 *
 * 游标规则：`preview_revision` 在同一 (Run, model_call) 世代内单调，换 attempt/
 * 模型调用时重置为 1 且旧行被删，因此 revision 单独不是连续游标。本端点不声明
 * `after`、不读 `Last-Event-ID`、不做连续性断言；连接建立即推当前快照，断线
 * 重连天然得到当前完整状态，客户端按身份 + revision 去重。
 */

/** 低于被替换的 400ms 客户端轮询；最坏端到端 ≈ 100ms flush + 200ms 检测 + 一次读取。 */
const DETECT_POLL_MS = 200;
const HEARTBEAT_MS = 15_000;

const RUN_TERMINAL_STATUSES: readonly string[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

export interface RunDraftPreviewProbe {
  readonly revision: bigint;
  readonly step_attempt_id: string;
  readonly attempt_claim_epoch: bigint;
  readonly run_worker_epoch: bigint;
  readonly model_call_id: string;
  readonly truncated: boolean;
}

export interface AssistPreviewProbe {
  readonly revision: bigint;
  readonly truncated: boolean;
}

/** 廉价比键：身份字段在内，换 attempt/模型调用（revision 重置）必然触发一次完整读取。 */
export function runDraftProbeKey(probe: RunDraftPreviewProbe | undefined): string {
  return probe === undefined ? '\u0000none' :
    `${probe.step_attempt_id}|${probe.attempt_claim_epoch}|${probe.run_worker_epoch}` +
    `|${probe.model_call_id}|${probe.revision}|${probe.truncated}`;
}

/** message_id 即身份（一流一连），revision 在途严格单调，键只需 revision 与截断标志。 */
export function assistPreviewProbeKey(probe: AssistPreviewProbe | undefined): string {
  return probe === undefined ? '\u0000none' : `${probe.revision}|${probe.truncated}`;
}

export function isRunDraftTerminal(dto: RunDraftPreviewDto): boolean {
  return RUN_TERMINAL_STATUSES.includes(dto.run_status);
}

export function isAssistPreviewTerminal(dto: { readonly status: string }): boolean {
  return dto.status !== 'PENDING' && dto.status !== 'RUNNING';
}

interface PreviewStreamSpec<TProbe, TDto> {
  readonly eventName: string;
  readonly logLabel: string;
  readonly probe: () => Promise<TProbe | undefined>;
  readonly probeKey: (probe: TProbe | undefined) => string;
  readonly read: () => Promise<TDto>;
  readonly revisionOf: (dto: TDto) => string;
  readonly isTerminal: (dto: TDto) => boolean;
}

/** 帧体即完整 DTO（与 GET 同形）；id 是 preview_revision，仅作记录不做连续性断言。 */
export function writePreviewFrame(response: ServerResponse, eventName: string,
    revision: string, dto: unknown, signal: AbortSignal): Promise<boolean> {
  return writeRunEventFrame(response,
    `id: ${revision}\nevent: ${eventName}\ndata: ${JSON.stringify(dto)}\n\n`, signal);
}

async function sendPreviewStream<TProbe, TDto>(
  request: FastifyRequest, reply: FastifyReply, db: DbExecutor,
  storage: ManagedContentStore, spec: PreviewStreamSpec<TProbe, TDto>,
): Promise<FastifyReply | void> {
  let first: TDto;
  let key: string;
  try {
    // 首轮同时完成资源存在性校验与当前快照；失败在流升级前映射为 Problem Details。
    key = spec.probeKey(await spec.probe());
    first = await spec.read();
  } catch (error) {
    return sendReadError(reply, error, request.id);
  }

  const headers = reply.getHeaders();
  reply.hijack();
  const response = reply.raw;
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) response.setHeader(name, value);
  }
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'x-content-type-options': 'nosniff',
    // 反代缓冲会破坏 SSE 逐帧到达；本地部署无反代，加上是上游通行做法。
    'x-accel-buffering': 'no',
  });
  response.flushHeaders();

  const stopped = new AbortController();
  const onClose = () => stopped.abort();
  response.once('close', onClose);
  let lastWrite = Date.now();
  try {
    if (!(await writePreviewFrame(response, spec.eventName,
        spec.revisionOf(first), first, stopped.signal))) {
      response.destroy();
      return;
    }
    lastWrite = Date.now();
    if (spec.isTerminal(first)) return;
    while (!stopped.signal.aborted) {
      if (Date.now() - lastWrite >= HEARTBEAT_MS) {
        if (!(await writeRunEventFrame(response, ': keepalive\n\n', stopped.signal))) {
          response.destroy();
          return;
        }
        lastWrite = Date.now();
      }
      await waitForPoll(stopped.signal, DETECT_POLL_MS);
      if (stopped.signal.aborted) break;
      const probed = await spec.probe();
      if (stopped.signal.aborted) break;
      const nextKey = spec.probeKey(probed);
      if (nextKey === key) continue;
      key = nextKey;
      let dto: TDto;
      try {
        dto = await spec.read();
      } catch (error) {
        // 流打开后资源消失是正常不可见（DomainError），不记 error 日志；客户端
        // 重连后由流升级前的路径拿到 404 再停。
        if (!(error instanceof DomainError) && !stopped.signal.aborted) {
          request.log.error({ err: error }, `${spec.logLabel}_read_failed`);
        }
        return;
      }
      if (stopped.signal.aborted) break;
      if (!(await writePreviewFrame(response, spec.eventName,
          spec.revisionOf(dto), dto, stopped.signal))) {
        response.destroy();
        return;
      }
      lastWrite = Date.now();
      if (spec.isTerminal(dto)) return;
    }
  } catch (error) {
    if (!stopped.signal.aborted) request.log.error({ err: error }, `${spec.logLabel}_failed`);
    response.destroy();
  } finally {
    response.off('close', onClose);
    if (!response.destroyed) response.end();
  }
}

/**
 * Run DRAFT 生成中草稿 SSE。终态（Run 三终态）帧后关闭连接；PAUSED 或换
 * attempt 的间隙保持连接——客户端在这些间隙只清空预览、继续等新身份帧。
 */
export async function sendRunDraftPreviewStream(request: FastifyRequest, reply: FastifyReply,
    db: DbExecutor, storage: ManagedContentStore, workspaceId: string, runId: string,
): Promise<FastifyReply | void> {
  const runs = createRepositories(db).runs;
  return sendPreviewStream(request, reply, db, storage, {
    eventName: 'draft_preview', logLabel: 'run_draft_preview_stream',
    probe: () => runs.readDraftPreviewFingerprint(runId),
    probeKey: runDraftProbeKey,
    read: () => readRunDraftPreview(db, storage, workspaceId, runId),
    revisionOf: (dto) => dto.preview_revision,
    isTerminal: isRunDraftTerminal,
  });
}

/** Assist DISCUSS 生成中预览 SSE。消息终态帧后关闭连接。 */
export async function sendAssistLivePreviewStream(request: FastifyRequest, reply: FastifyReply,
    db: DbExecutor, storage: ManagedContentStore, workspaceId: string, sessionId: string,
    messageId: string,
): Promise<FastifyReply | void> {
  const assist = createRepositories(db).assist;
  return sendPreviewStream(request, reply, db, storage, {
    eventName: 'assist_preview', logLabel: 'assist_live_preview_stream',
    probe: () => assist.readLivePreviewFinger(messageId),
    probeKey: assistPreviewProbeKey,
    read: () => readAssistLivePreview(db, storage, { workspaceId, sessionId, messageId }),
    revisionOf: (dto) => dto.preview_revision,
    isTerminal: isAssistPreviewTerminal,
  });
}
