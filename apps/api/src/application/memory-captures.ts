import { createHash, randomUUID } from 'node:crypto';
import type { JsonObject } from '../infrastructure/json.js';
import type { DbExecutor } from '../infrastructure/database.js';
import { LOCAL_ACTOR_REF, httpCommandScopeKey } from './actor.js';
import type { MemorySourceKind } from '../infrastructure/database-schema.js';
import { runIdempotentCommand } from './command.js';
import { invalidTransition, resourceNotFound, revisionConflict } from './domain-error.js';
import { requireRevision } from './revisions.js';
import { createRepositories, type Repositories } from './unit-of-work.js';
import { sql } from 'kysely';

/**
 * 零点击自动记忆（ADR-030）。
 *
 * 与「候选 + 确认」的关键差别：这里没有待确认态。写入即生效，用户事后撤销。
 * 因此本文件承担三件事，且顺序不能颠倒：
 *   1. 归一化与去重（同一来源同一内容只写一次；撤销过的内容不再写回）；
 *   2. 写入（Memory 根/版本/来源 + 捕获记账，同一事务）；
 *   3. 撤销（停用 Memory + 记 RETIRED + 留决定人与时刻）。
 *
 * 召回排序、origin 投影不在这里——那是读取侧的事，改在 memory-recall 与查询投影。
 */

/** 归一化：只用来判断「是不是同一句」，不用于展示，也不改写入正文。 */
export function normalizeCaptureText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
}

export function captureFingerprint(title: string, text: string): string {
  return createHash('sha256').update(`${normalizeCaptureText(title)}\u0000${normalizeCaptureText(text)}`, 'utf8')
    .digest('hex');
}

export function sourceContentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export const MEMORY_AUTO_CAPTURE_DAILY_LIMIT = 5;
export const MEMORY_AUTO_CAPTURE_MAX_ITEMS = 3;

/**
 * 写入一条自动记忆。
 *
 * 调用方必须已经在事务里（提取链用 `withTransaction`）。顺序与理由：
 * 先按**当前**事实复核范围 → 再取会话级 advisory 锁 → 查重 → 写 Memory → 最后写捕获行。
 * 锁挡的是「同一消息两个 Worker 同时提取」，不是业务互斥；冲突键相同只会串行，
 * 不会阻塞别的会话。
 *
 * 2026-10-25 的两处修正：
 *   1. **写入前复核**：提取要花一次模型调用，期间用户可能已经关掉自动记忆、关掉会话记忆、
 *      归档会话或把会话挪到别的项目。模型结果是「旧时间点」的产物，不能绕过已经生效的关闭。
 *      复核与写入在同一事务里，中间没有新的窗口。
 *   2. **来源分列**：`triggerMessageId` 是触发本轮提取的助手消息（轮次身份），
 *      `evidenceMessageId` 是逐字引文实际所在的消息（用户原话或助手回复）。此前两者
 *      混用同一个助手消息 id，导致引自用户原话的条目指不回它真正的那句话。
 */
export async function recordAutoCapture(r: Repositories, input: {
  workspaceId: string; projectId: string | null; sessionId: string;
  /** 触发本轮提取的助手消息（去重指纹的轮次身份）。 */
  triggerMessageId: string;
  /** 逐字引文实际所在的消息：USER_STATEMENT 绑用户消息，MODEL_OBSERVATION 绑助手回复。 */
  evidenceMessageId: string;
  /** 证据消息的原文：`source_sha256` 由它计算，并与库里那一行复核。 */
  evidenceText: string;
  title: string; text: string; reason: string | null;
  /** DEV-0042：来源类别（USER_STATEMENT / MODEL_OBSERVATION）与它对应的原消息逐字片段。 */
  sourceKind: MemorySourceKind; sourceQuote: string;
}): Promise<{ memoryId: string; captureId: string } | null> {
  const title = input.title.trim();
  const text = input.text.trim();
  if (title === '' || text === '') return null;

  // ---- 范围复核（P0-D）：任何一项不再成立就整条放弃，不写半条 ----
  const session = await r.assist.readSession(input.sessionId, true);
  if (session === undefined || session.workspace_id !== input.workspaceId ||
      session.status !== 'ACTIVE' || !session.remember ||
      session.project_id !== input.projectId) return null;
  const settings = await r.information.readMemorySettings(input.workspaceId);
  if (settings?.auto_capture === false) return null;
  const trigger = await r.assist.readMessage(input.triggerMessageId, 'share');
  if (trigger === undefined || trigger.status !== 'COMPLETED' || trigger.withdrawn_at !== null) return null;
  const evidence = await r.assist.readMessage(input.evidenceMessageId, 'share');
  if (evidence === undefined || evidence.session_id !== input.sessionId ||
      evidence.status !== 'COMPLETED' || evidence.withdrawn_at !== null ||
      evidence.content === null) return null;
  // 证据正文必须就是库里那条消息的正文：哈希是「这条记忆引自哪一段原文」的唯一凭据，
  // 不能用调用方手里的副本冒充。
  const sourceSha256 = sourceContentHash(input.evidenceText);
  if (sourceContentHash(evidence.content) !== sourceSha256) return null;

  const normalizedSha256 = captureFingerprint(title, text);

  await r.memoryCaptures.lockSource(`${input.sessionId}:${input.triggerMessageId}:${normalizedSha256}`);
  if (await r.memoryCaptures.hasCaptured(input.sessionId, input.triggerMessageId, normalizedSha256)) return null;
  if (await r.memoryCaptures.hasMemoryWithText(input.workspaceId, input.projectId, title, text)) return null;
  if (await r.memoryCaptures.countToday(input.sessionId) >= MEMORY_AUTO_CAPTURE_DAILY_LIMIT) return null;

  const memoryId = randomUUID();
  const captureId = randomUUID();
  await r.information.insertMemoryRoot(memoryId, input.workspaceId, input.projectId, title,
    input.sourceKind, 'AUTO_CAPTURE');
  await r.information.insertMemoryVersion({ id: randomUUID(), memoryId, version: 1n,
    title, text, confirmedBy: 'auto-capture', expiresAt: null });
  await r.information.insertMemoryMessageSource({ memoryId, sessionId: input.sessionId,
    messageId: input.evidenceMessageId, contentSha256: sourceSha256 });
  const capture = await r.memoryCaptures.insert({ id: captureId, workspaceId: input.workspaceId,
    projectId: input.projectId, sessionId: input.sessionId, messageId: input.triggerMessageId,
    sourceSha256, normalizedSha256, memoryId, sourceQuote: input.sourceQuote });
  // 唯一键冲突说明并发方已经写过：它写的那条才是事实，本事务不能留下第二份 Memory。
  if (capture === undefined) throw new Error('AUTO_CAPTURE_CONFLICT');
  await r.workspaces.bumpContextRevision(input.workspaceId);
  await r.activities.insertActivityRecord({ id: randomUUID(), workspaceId: input.workspaceId,
    actorKind: 'AI', actorRef: 'auto-capture', commandId: null,
    projectId: input.projectId, taskId: null, eventType: 'MEMORY_AUTO_CAPTURED',
    factRefs: { memory_id: memoryId, capture_id: captureId, session_id: input.sessionId,
      message_id: input.triggerMessageId, evidence_message_id: input.evidenceMessageId,
      source_kind: input.sourceKind, version: '1',
      ...(input.reason === null ? {} : { reason: input.reason }) } });
  return { memoryId, captureId };
}

/** 最近自动记住的列表：已生效记录，不是待确认队列。 */
export async function readAutoCaptures(db: DbExecutor, workspaceId: string, limit = 20): Promise<JsonObject[]> {
  const r = createRepositories(db);
  const rows = (await sql<{ id: string; memory_id: string; session_id: string; message_id: string;
    title: string; text: string; origin: string; source_kind: string; status: string;
    source_sha256: string; source_quote: string; created_at: Date; revision: bigint }>`
    select c.id, c.memory_id, c.session_id, c.message_id, m.title, v.body_text as text,
      m.origin, m.source_kind, c.status, c.source_sha256, c.source_quote, c.created_at, c.revision
    from memory_auto_captures c
    join memory_items m on m.id = c.memory_id
    join memory_versions v on v.memory_id = m.id and v.version = m.current_version
    where c.workspace_id = ${workspaceId} and c.status = 'ACTIVE'
    order by c.created_at desc limit ${Math.min(Math.max(limit, 1), 50)}`.execute(db)).rows;
  return rows.map((row) => ({ id: row.id, memory_id: row.memory_id, session_id: row.session_id,
    message_id: row.message_id, title: row.title, text: row.text, origin: row.origin,
    source_kind: row.source_kind, status: row.status, source_sha256: row.source_sha256,
    source_quote: row.source_quote,
    created_at: row.created_at.toISOString(), revision: row.revision.toString() }));
}

/**
 * 撤销一条自动记忆。
 *
 * 只停用、不删除：版本与来源保留可查，撤销本身也留审计。撤销后同一
 * `(session, message, normalized)` 不会再被提取——这条由捕获行停在 RETIRED 保证，
 * 而不是靠提取链记得「上次撤过」。
 */
export async function retireAutoCapture(db: DbExecutor, input: { workspaceId: string;
  captureId: string; commandId: string; expectedRevision: string }) {
  const expected = requireRevision(input.expectedRevision, 'expected_revision');
  return runIdempotentCommand<JsonObject>(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'RetireAutoMemoryCapture',
    target: { capture_id: input.captureId }, body: { expected_revision: expected.toString() },
    execute: async (r) => {
      const capture = await r.memoryCaptures.byId(input.captureId, true);
      if (capture === undefined || capture.workspace_id !== input.workspaceId) {
        throw resourceNotFound('Auto memory capture');
      }
      const prior = await r.receipts.findReceipt({ scopeKey: httpCommandScopeKey(input.workspaceId),
        commandId: input.commandId });
      if (prior !== undefined) return prior.result_ref;
      if (capture.revision !== expected) {
        throw revisionConflict({ entityType: 'MEMORY_AUTO_CAPTURE',
          expectedRevision: expected.toString(), actualRevision: capture.revision.toString() });
      }
      if (capture.status !== 'ACTIVE') throw invalidTransition('这条自动记忆已经撤销。');
      const memory = await r.information.readRoot('memory', capture.memory_id);
      if (memory === undefined || memory.workspace_id !== input.workspaceId) {
        throw resourceNotFound('Memory');
      }
      if (memory.status !== 'ACTIVE') throw invalidTransition('对应记忆已非有效状态，不能再按自动记忆撤销。');
      await r.information.setRootStatus('memory', capture.memory_id, 'RETIRED');
      const retired = await r.memoryCaptures.retire(capture.id, LOCAL_ACTOR_REF);
      if (retired === undefined) throw invalidTransition('这条自动记忆已经撤销。');
      await r.workspaces.bumpContextRevision(input.workspaceId);
      await r.activities.insertActivityRecord({ id: randomUUID(), workspaceId: input.workspaceId,
        actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF, commandId: input.commandId,
        projectId: capture.project_id, taskId: null, eventType: 'MEMORY_AUTO_CAPTURE_RETIRED',
        factRefs: { memory_id: capture.memory_id, capture_id: capture.id,
          session_id: capture.session_id, message_id: capture.message_id } });
      return { capture_id: capture.id, memory_id: capture.memory_id, status: 'RETIRED',
        memory_status: 'RETIRED' };
    } });
}
