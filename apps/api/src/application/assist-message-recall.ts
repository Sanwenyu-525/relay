/**
 * 用户消息撤回（迁移 0132 / 工作台 §27.3 / 运行架构 §8.5）。
 *
 * 一次撤回＝恢复目标用户消息**发送前**的文件内容/存在性：
 *   * 目标消息及其直接回复标记 withdrawn；原文、工具记录与来源仍保留；
 *   * 目标消息之后本会话关联的已确认写入按路径归并，只回退到各自最早写入前的前像；
 *   * 预检发现冲突/缺失基线/未决效果时**先不写任何文件**，返回逐路径原因；
 *   * 首版只允许沿对话向后逐条撤回（目标 seq 必须大于已撤回的最大 seq），不做嵌套恢复。
 *
 * 文件前像由 Gateway 在真正落盘前按消息记录；这里不读 Git HEAD，也不从当前文件反推历史。
 */

import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';

import type {
  AssistMessageBaselineFileRow, AssistMessageRecallFileRow, AssistMessageRecallFileStatus,
  AssistMessageRecallRow, AssistMessageRecallStatus, AssistMessageRecallProtectionRow,
  AssistMessageRecallUndoRow, AssistMessageRow, AssistSessionRow,
} from '../infrastructure/database-schema.js';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import { isPostgresError, POSTGRES_ERROR_CODES } from '../infrastructure/postgres-error.js';
import {
  canonicalRelativePath, executeFileChangeset, isFrozenBaseline, isProtectedPath,
  validateSafeRelativePath, type FileChange,
} from '../files/file-changeset.js';
import type { DirectWriteOperationRow } from '../assist/message-recall-repository.js';
import { readMessageSnapshotLimits } from './assist-file-baseline.js';
import { reopenTask } from './completion-commands.js';
import { DomainError, invalidTransition, resourceNotFound } from './domain-error.js';
import { createRepositories, withTransaction, type Repositories } from './unit-of-work.js';

/** 当前文件参与摘要核对的单文件上限；超过只能明确报告不可自动回退。 */
const MAX_CURRENT_HASH_BYTES = 64 * 1024 * 1024;
/** RUNNING 回执超过该时长视为崩溃遗留，可按同一回执继续，不新建第二次撤回。 */
export const RECALL_STALE_RUNNING_MS = 60_000;
/** 保护副本的单文件上限；与基线上限同值（§27.3.3/§27.3.4，待校准推荐值）。 */
const MAX_PROTECTION_BYTES = 50 * 1024 * 1024;

export interface RecallAssistMessageInput {
  readonly workspaceId: string;
  readonly messageId: string;
  readonly commandId: string;
}

export interface AssistMessageRecallFileDto {
  readonly path: string;
  readonly status: AssistMessageRecallFileStatus;
  readonly reason: string | null;
  readonly baseline: 'PRESENT' | 'ABSENT';
  readonly baseline_sha256: string | null;
}

export interface AssistMessageRecallDto {
  readonly id: string;
  readonly message_id: string;
  readonly assistant_message_id: string;
  readonly status: AssistMessageRecallStatus;
  readonly root_path: string | null;
  readonly planned_files: number;
  readonly restored_files: number;
  readonly skipped_files: number;
  readonly detail: JsonObject;
  readonly requested_at: string;
  readonly completed_at: string | null;
  readonly files: readonly AssistMessageRecallFileDto[];
}

export interface RecallAssistMessageResult {
  readonly recall: AssistMessageRecallDto;
  /** true＝同一 command_id 或同一消息的既有回执，不是本次新建的撤回。 */
  readonly replayed: boolean;
}

/** 消息列表用的轻量撤回摘要：不逐条读文件结果。 */
export interface AssistMessageRecallSummary {
  readonly id: string;
  readonly message_id: string;
  readonly assistant_message_id: string;
  readonly status: AssistMessageRecallStatus;
  readonly planned_files: number;
  readonly restored_files: number;
  readonly skipped_files: number;
  readonly requested_at: string;
  readonly completed_at: string | null;
}

interface WriteEvent {
  readonly messageId: string;
  readonly messageSeq: bigint;
  readonly relativePath: string;
  readonly action: 'CREATE' | 'MODIFY' | 'DELETE';
  readonly expectedSha256: string | null;
  readonly expectedKnown: boolean;
  readonly rootPath: string;
  readonly observedAt: Date;
}

interface CurrentFileState {
  readonly exists: boolean;
  readonly sha256: string | null;
  readonly reason: string | null;
}

type PreflightStatus = 'RESTORABLE' | 'ALREADY_RESTORED' | 'CONFLICT' | 'UNAVAILABLE' | 'UNCERTAIN';

interface BaselineFacts {
  readonly baselineExisted: boolean;
  readonly baselineSha256: string | null;
  readonly baselineMessageId: string | null;
  readonly baselineContent: Buffer | null;
  readonly expectedSha256: string | null;
  readonly expectedKnown: boolean;
  readonly unavailableReason: string | null;
}

interface RecallPlanFile extends BaselineFacts {
  readonly relativePath: string;
  readonly observedSha256: string | null;
  readonly status: PreflightStatus;
  readonly reason: string | null;
}

type RestoreStep =
  | { readonly kind: 'restored'; readonly observedSha256: string | null }
  | { readonly kind: 'blocked'; readonly status: 'CONFLICT' | 'UNAVAILABLE';
      readonly reason: string; readonly observedSha256: string | null }
  | { readonly kind: 'change'; readonly change: FileChange;
      readonly restoredSha256: string | null };

export async function recallAssistMessage(db: DbExecutor,
  input: RecallAssistMessageInput): Promise<RecallAssistMessageResult> {
  const r = createRepositories(db);
  const message = await r.assist.readMessage(input.messageId);
  if (message === undefined) throw resourceNotFound('Assist message');
  const session = await r.assist.readSession(message.session_id);
  if (session === undefined || session.workspace_id !== input.workspaceId) {
    throw resourceNotFound('Assist message');
  }

  // §27.3.4 保留清理：超过保留期且不被在途撤回/撤销引用的快照按最旧先清；
  // 被清理的路径此后在预检里如实报「缺少基线」，不静默缩小范围。
  try {
    await r.messageRecall.sweepExpiredSnapshots(readMessageSnapshotLimits().retentionDays);
  } catch {
    // 清理失败不阻断本次撤回判断；占用与可恢复性以设置投影如实呈现。
  }

  // 同一 command_id 必须指向同一条消息；否则是复用命令身份，不是重放。
  const byCommand = await r.messageRecall.findRecallByCommand(input.workspaceId, input.commandId);
  if (byCommand !== undefined) {
    if (byCommand.session_id !== session.id || byCommand.message_id !== message.id) {
      throw commandIdReused();
    }
    return { recall: await readRecallReceipt(r, byCommand), replayed: true };
  }

  const assistant = await r.assist.readMessageAtSeq(session.id, message.seq + 1n);
  const existing = await r.messageRecall.findRecallByMessage(message.id);
  if (existing !== undefined) {
    if (existing.status === 'RUNNING') {
      const anchor = existing.last_resumed_at ?? existing.requested_at;
      if (Date.now() - anchor.getTime() >= RECALL_STALE_RUNNING_MS &&
          await r.messageRecall.claimStaleRecall(existing.id, RECALL_STALE_RUNNING_MS)) {
        return { recall: await resumeRecall(db, r, existing), replayed: false };
      }
      throw recallInProgress(session.id, message.id, '这条消息的撤回尚未结算；请按原回执读取实际进展，不要新建第二次撤回。');
    }
    return { recall: await readRecallReceipt(r, existing), replayed: true };
  }

  await assertRecallEligible(r, session, message, assistant);

  const events = await collectWriteEvents(r, session, message.seq);
  if (events.uncertain) {
    throw new DomainError({ code: 'RECALL_EFFECT_UNCERTAIN', status: 409,
      type: '/problems/recall-effect-uncertain', title: '仍有未决文件效果',
      detail: '该消息之后存在 UNKNOWN 的文件写入；先核对实际结果，暂不能宣称已恢复。',
      retryable: true, retryAction: 'REFRESH_AND_REDECIDE',
      conflict: { sessionId: session.id, messageId: message.id } });
  }
  const rootPath = await resolveRecallRoot(r, session, message, events.events);
  const plan = await buildRecallPlan(r, message.id, rootPath, events.events);
  const blocked = plan.filter(isBlocked);
  if (blocked.length > 0) {
    throw new DomainError({ code: 'RECALL_PREFLIGHT_BLOCKED', status: 409,
      type: '/problems/recall-preflight-blocked', title: '撤回预检未通过',
      detail: '至少一个目标文件与发送前基线不一致或缺少可信前像；本次没有写入任何文件。',
      retryable: true, retryAction: 'REFRESH_AND_REDECIDE',
      conflict: { sessionId: session.id, messageId: message.id,
        recallPaths: blocked.map((file) => `${file.relativePath}｜${file.status}｜${file.reason ?? ''}`) } });
  }

  const recallId = randomUUID();
  try {
    await withTransaction(db, async (tx) => {
      // 锁住会话行再复核资格：新消息的受理事务也先锁同一行，两者因此串行。
      // 预检读的是文件系统，这里只补查「预检之后是否又出现新的在途生成/未结算调用」。
      const locked = await tx.assist.readSession(session.id, true);
      if (locked === undefined) throw resourceNotFound('Assist message');
      await assertRecallEligible(tx, locked, message, assistant);
      await tx.messageRecall.insertRecall({
        id: recallId, workspaceId: locked.workspace_id, sessionId: locked.id,
        messageId: message.id, assistantMessageId: assistant!.id, commandId: input.commandId,
        rootPath, plannedFiles: plan.length,
        files: plan.map((file) => ({
          relativePath: file.relativePath, baselineExisted: file.baselineExisted,
          baselineSha256: file.baselineSha256, baselineMessageId: file.baselineMessageId,
          expectedCurrentSha256: file.expectedSha256,
          observedSha256: file.observedSha256, status: 'PLANNED', reason: null,
        })),
      });
    });
  } catch (error) {
    if (isPostgresError(error, POSTGRES_ERROR_CODES.uniqueViolation)) {
      const racedByCommand = await r.messageRecall.findRecallByCommand(
        input.workspaceId, input.commandId);
      if (racedByCommand !== undefined && racedByCommand.session_id === session.id &&
          racedByCommand.message_id === message.id) {
        return { recall: await readRecallReceipt(r, racedByCommand), replayed: true };
      }
      if (await r.messageRecall.findRecallByMessage(message.id) !== undefined) {
        throw recallInProgress(session.id, message.id,
          '这条消息已有一条撤回请求；请读取该回执，不要重复发起。');
      }
    }
    throw error;
  }

  return { recall: await executeRecallPlan(db, r, recallId, rootPath, plan), replayed: false };
}

export async function readAssistMessageRecall(db: DbExecutor, workspaceId: string,
  messageId: string): Promise<AssistMessageRecallDto | undefined> {
  const r = createRepositories(db);
  const row = await r.messageRecall.findRecallByMessage(messageId);
  if (row === undefined || row.workspace_id !== workspaceId) return undefined;
  return readRecallReceipt(r, row);
}

export async function listAssistMessageRecallSummaries(db: DbExecutor,
  sessionId: string): Promise<readonly AssistMessageRecallSummary[]> {
  const rows = await createRepositories(db).messageRecall.listRecallsForSession(sessionId);
  return rows.map((row) => ({
    id: row.id, message_id: row.message_id,
    assistant_message_id: row.assistant_message_id, status: row.status,
    planned_files: row.planned_files, restored_files: row.restored_files,
    skipped_files: row.skipped_files, requested_at: row.requested_at.toISOString(),
    completed_at: row.completed_at?.toISOString() ?? null,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// §27.3.3 单层「撤销这次回退」：保护副本驱动的反向恢复。
//
// 撤销是**新的受控动作**（独立命令与回执身份），只覆盖最近一次完整成功撤回里
// 「实际恢复过（RESTORED）且有保护副本」的文件，恢复到该次撤回开始写入前的内容；
// 预检任一目标已被后续修改/副本缺失时先不写任何文件；反向成功后不再提供再反向。
// ─────────────────────────────────────────────────────────────────────────────

export interface UndoAssistMessageRecallInput {
  readonly workspaceId: string;
  readonly recallId: string;
  readonly commandId: string;
}

export type AssistMessageRecallUndoFileStatus = 'RESTORED' | 'ALREADY_RESTORED' | 'CONFLICT'
  | 'UNAVAILABLE' | 'FAILED' | 'SKIPPED';

export interface AssistMessageRecallUndoFileDto {
  readonly path: string;
  readonly status: AssistMessageRecallUndoFileStatus;
  readonly reason: string | null;
}

export interface AssistMessageRecallUndoDto {
  readonly id: string;
  readonly source_recall_id: string;
  readonly status: AssistMessageRecallStatus;
  readonly root_path: string;
  readonly files: readonly AssistMessageRecallUndoFileDto[];
  readonly detail: JsonObject;
  readonly requested_at: string;
  readonly completed_at: string | null;
}

export interface UndoAssistMessageRecallResult {
  readonly undo: AssistMessageRecallUndoDto;
  readonly replayed: boolean;
}

interface ProtectionCapture {
  readonly relativePath: string;
  readonly existed: boolean;
  readonly content: Buffer | null;
  readonly sha256: string | null;
  readonly sizeBytes: bigint | null;
  readonly unavailableReason: string | null;
}

interface UndoPlanFile {
  readonly relativePath: string;
  readonly protection: AssistMessageRecallProtectionRow;
  /** 撤销前期望的当前态＝该撤回的恢复结果（RESTORED 文件回到各自基线态）。 */
  readonly expectedExists: boolean;
  readonly expectedSha256: string | null;
  readonly status: 'RESTORE' | 'ALREADY_RESTORED' | 'CONFLICT' | 'UNAVAILABLE';
  readonly reason: string | null;
}

export async function undoAssistMessageRecall(db: DbExecutor,
  input: UndoAssistMessageRecallInput): Promise<UndoAssistMessageRecallResult> {
  const r = createRepositories(db);
  const recall = await r.messageRecall.findRecallById(input.recallId);
  if (recall === undefined || recall.workspace_id !== input.workspaceId) {
    throw resourceNotFound('Assist message recall');
  }
  const session = await r.assist.readSession(recall.session_id);
  if (session === undefined) throw resourceNotFound('Assist session');

  // §27.3.4：撤销入口同样先做保留清理；RUNNING 撤销自身的保护副本在保护范围内。
  try {
    await r.messageRecall.sweepExpiredSnapshots(readMessageSnapshotLimits().retentionDays);
  } catch { /* 清理失败不阻断判定 */ }

  const byCommand = await r.messageRecall.findUndoByCommand(input.workspaceId, input.commandId);
  if (byCommand !== undefined) {
    if (byCommand.source_recall_id !== recall.id) throw commandIdReused();
    return { undo: undoDto(byCommand), replayed: true };
  }
  const existing = await r.messageRecall.findUndoBySource(recall.id);
  if (existing !== undefined) {
    if (existing.status === 'RUNNING') {
      const anchorTime = existing.last_resumed_at ?? existing.requested_at;
      if (Date.now() - anchorTime.getTime() >= RECALL_STALE_RUNNING_MS &&
          await r.messageRecall.claimStaleUndo(existing.id, RECALL_STALE_RUNNING_MS)) {
        return { undo: await executeUndoPlan(r, existing), replayed: false };
      }
      throw new DomainError({ code: 'RECALL_UNDO_IN_PROGRESS', status: 409,
        type: '/problems/recall-undo-in-progress', title: '撤销正在进行',
        detail: '这条撤回的撤销尚未结算；请按原回执读取实际进展，不要新建第二次撤销。',
        retryable: true, retryAction: 'POLL_RESOURCE',
        conflict: { sessionId: session.id } });
    }
    return { undo: undoDto(existing), replayed: true };
  }

  await assertUndoEligible(r, recall, session);
  const plan = await buildUndoPlan(r, recall);
  const blocked = plan.filter((file) =>
    file.status === 'CONFLICT' || file.status === 'UNAVAILABLE');
  if (blocked.length > 0) {
    throw new DomainError({ code: 'RECALL_UNDO_PREFLIGHT_BLOCKED', status: 409,
      type: '/problems/recall-undo-preflight-blocked', title: '撤销预检未通过',
      detail: '至少一个目标文件在撤回后又被修改，或缺少可用的保护副本；本次没有写入任何文件。',
      retryable: true, retryAction: 'REFRESH_AND_REDECIDE',
      conflict: { sessionId: session.id,
        recallPaths: blocked.map((file) => `${file.relativePath}|${file.status}`
          + `${file.reason === null ? '' : `|${file.reason}`}`) } });
  }

  const undoId = randomUUID();
  try {
    await r.messageRecall.insertUndo({ id: undoId, workspaceId: recall.workspace_id,
      sessionId: recall.session_id, sourceRecallId: recall.id, commandId: input.commandId,
      rootPath: recall.root_path ?? '' });
  } catch (error) {
    if (isPostgresError(error, POSTGRES_ERROR_CODES.uniqueViolation)) {
      const raced = await r.messageRecall.findUndoBySource(recall.id);
      if (raced !== undefined) return { undo: undoDto(raced), replayed: true };
    }
    throw error;
  }
  const row = await r.messageRecall.findUndoBySource(recall.id);
  if (row === undefined) throw new Error('Recall undo row disappeared after insert');
  return { undo: await executeUndoPlan(r, row), replayed: false };
}

export interface MessageRecallSettingsDto {
  /** 生效配置（推荐默认，待实测校准；§27.3.4）。 */
  readonly retention_days: number;
  readonly capacity_bytes: number;
  readonly per_file_cap_bytes: number;
  /** 实际占用（前像＋保护副本）与最旧快照时间；oldest 为 null 表示暂无快照。 */
  readonly usage_bytes: string;
  readonly snapshot_count: number;
  readonly oldest_snapshot_at: string | null;
}

/** §27.3.4：设置可查看生效配置、实际占用、可恢复时段（最旧快照）与清理影响。 */
export async function readMessageRecallSettings(db: DbExecutor,
  workspaceId: string): Promise<MessageRecallSettingsDto> {
  const r = createRepositories(db);
  const limits = readMessageSnapshotLimits();
  const usage = await r.messageRecall.snapshotUsage(workspaceId);
  return { retention_days: limits.retentionDays, capacity_bytes: limits.budgetBytes,
    per_file_cap_bytes: limits.maxFileBytes,
    usage_bytes: usage.bytes.toString(), snapshot_count: usage.count,
    oldest_snapshot_at: usage.oldestAt?.toISOString() ?? null };
}

export async function readAssistMessageRecallUndo(db: DbExecutor, workspaceId: string,
  recallId: string): Promise<AssistMessageRecallUndoDto | undefined> {
  const r = createRepositories(db);
  const row = await r.messageRecall.findUndoBySource(recallId);
  if (row === undefined || row.workspace_id !== workspaceId) return undefined;
  return undoDto(row);
}

async function assertUndoEligible(r: Repositories, recall: AssistMessageRecallRow,
  session: AssistSessionRow): Promise<void> {
  if (recall.status !== 'COMPLETED') {
    throw invalidTransition('只有完整成功的撤回可以撤销；部分恢复或失败的撤回请先核对原回执。',
      { sessionId: session.id });
  }
  if ((await r.messageRecall.listProtections(recall.id)).length === 0) {
    throw invalidTransition('这条撤回没有保存保护副本（空计划或早于本增量），不可自动撤销。',
      { sessionId: session.id });
  }
  if (await r.messageRecall.existsNewerCompletedRecall(session.id, recall.id)) {
    throw invalidTransition('已有更新的成功撤回；旧请求不再提供快捷反向操作。',
      { sessionId: session.id });
  }
  if (await r.messageRecall.hasRunningRecall(session.id) ||
      await r.messageRecall.hasRunningUndo(session.id)) {
    throw invalidTransition('该会话仍有未结算的撤回或撤销；先读取其回执再操作。',
      { sessionId: session.id });
  }
  if ((await r.messageRecall.listNonTerminalMessagesFrom(session.id, 0n)).length > 0) {
    throw invalidTransition('会话仍有在途生成；完成或停止后再撤销。',
      { sessionId: session.id });
  }
  if (await r.conversationExecutions.findLiveRunForSession(
      recall.workspace_id, session.id, null) !== undefined) {
    throw invalidTransition('该会话仍有在途执行；先安全停止并结算再撤销。',
      { sessionId: session.id });
  }
}

/** 撤销计划：范围＝该撤回实际恢复过（RESTORED）且有保护副本的文件。 */
async function buildUndoPlan(r: Repositories,
  recall: AssistMessageRecallRow): Promise<readonly UndoPlanFile[]> {
  if (recall.root_path === null) return [];
  const outcomes = await r.messageRecall.listRecallFiles(recall.id);
  const restoredByPath = new Map(outcomes
    .filter((file) => file.status === 'RESTORED').map((file) => [file.relative_path, file]));
  const plan: UndoPlanFile[] = [];
  for (const protection of await r.messageRecall.listProtections(recall.id)) {
    const outcome = restoredByPath.get(protection.relative_path);
    if (outcome === undefined) continue; // 未实际触及的文件不进撤销范围。
    // 撤回前不存在且撤回恢复了它（基线存在）的路径：撤销＝删除，无需副本字节。
    const needsBytes = protection.existed;
    if (needsBytes && (protection.unavailable_reason !== null || protection.content === null)) {
      plan.push({ relativePath: protection.relative_path, protection,
        expectedExists: outcome.baseline_existed,
        expectedSha256: outcome.baseline_sha256, status: 'UNAVAILABLE',
        reason: protection.unavailable_reason ?? 'PROTECTION_MISSING' });
      continue;
    }
    const expectedExists = outcome.baseline_existed;
    const expectedSha256 = outcome.baseline_sha256;
    const current = await readCurrentState(recall.root_path, protection.relative_path);
    let status: UndoPlanFile['status'];
    let reason: string | null = null;
    if (current.reason !== null) {
      status = 'UNAVAILABLE';
      reason = current.reason;
    } else {
      // 目标态＝保护副本态（撤销完成后应在的样子）；期望态＝该撤回的恢复结果
      // （撤销开始前应在的样子）。既不在目标也不在期望＝撤回后被改过→冲突，
      // 绝不能用旧的撤销授权覆盖新变化（§27.3.3）。
      const targetExists = protection.existed;
      const targetSha256 = protection.sha256;
      const atTarget = targetExists === current.exists &&
        (targetExists ? current.sha256 === targetSha256 : true);
      const atExpected = expectedExists === current.exists &&
        (expectedExists ? current.sha256 === expectedSha256 : true);
      if (atTarget) status = 'ALREADY_RESTORED';
      else if (atExpected) status = 'RESTORE';
      else {
        status = 'CONFLICT';
        reason = 'CURRENT_CHANGED_SINCE_RECALL';
      }
    }
    plan.push({ relativePath: protection.relative_path, protection,
      expectedExists, expectedSha256, status, reason });
  }
  return plan;
}

async function executeUndoPlan(r: Repositories,
  undoRow: AssistMessageRecallUndoRow): Promise<AssistMessageRecallUndoDto> {
  const recall = await r.messageRecall.findRecallById(undoRow.source_recall_id);
  if (recall === undefined) throw new Error('Source recall disappeared during undo');
  const rootPath = recall.root_path ?? undoRow.root_path;
  const plan = await buildUndoPlan(r, recall);
  const results: AssistMessageRecallUndoFileDto[] = [];
  let stopped = false;
  for (const file of plan) {
    if (stopped) {
      results.push({ path: file.relativePath, status: 'SKIPPED',
        reason: 'PREVIOUS_FAILURE' });
      continue;
    }
    if (file.status === 'ALREADY_RESTORED') {
      results.push({ path: file.relativePath, status: 'ALREADY_RESTORED', reason: null });
      continue;
    }
    if (file.status !== 'RESTORE') {
      results.push({ path: file.relativePath, status: file.status, reason: file.reason });
      stopped = true;
      continue;
    }
    const change = await buildUndoChange(rootPath, file);
    if (typeof change === 'string') {
      results.push({ path: file.relativePath,
        status: change === 'CURRENT_CHANGED' ? 'CONFLICT' : 'FAILED', reason: change });
      stopped = true;
      continue;
    }
    if (change === null) {
      results.push({ path: file.relativePath, status: 'ALREADY_RESTORED', reason: null });
      continue;
    }
    const result = await executeFileChangeset(rootPath, [change]);
    const outcome = result.changes[0];
    if (outcome?.status === 'APPLIED') {
      results.push({ path: file.relativePath, status: 'RESTORED', reason: null });
    } else {
      results.push({ path: file.relativePath,
        status: outcome?.status === 'CONFLICT' ? 'CONFLICT' : 'FAILED',
        reason: outcome?.error ?? result.reason ?? 'UNDO_RESTORE_FAILED' });
      stopped = true;
    }
  }
  const restored = results.filter((file) =>
    file.status === 'RESTORED' || file.status === 'ALREADY_RESTORED').length;
  const status: AssistMessageRecallStatus = results.length === restored ? 'COMPLETED'
    : restored > 0 ? 'PARTIAL' : 'FAILED';
  const finalized = await r.messageRecall.finalizeUndo(undoRow.id, status,
    results as unknown as JsonObject,
    { file_count: results.length, restored_count: restored,
      skipped_count: results.length - restored });
  return undoDto(finalized);
}

/** 撤销的写入变更：按保护副本回写；撤回前不存在的路径撤销为删除。 */
async function buildUndoChange(rootPath: string,
  file: UndoPlanFile): Promise<FileChange | string | null> {
  const current = await readCurrentState(rootPath, file.relativePath);
  if (current.reason !== null) return current.reason;
  if (!file.protection.existed) {
    if (!current.exists) return null;
    if (!isFrozenBaseline(current.sha256)) return 'CURRENT_UNREADABLE';
    return { path: file.relativePath, action: 'DELETE', baselineSha256: current.sha256 };
  }
  if (file.protection.content === null || !isFrozenBaseline(file.protection.sha256)) {
    return 'PROTECTION_UNAVAILABLE';
  }
  if (current.exists) {
    if (!isFrozenBaseline(current.sha256)) return 'CURRENT_UNREADABLE';
    return { path: file.relativePath, action: 'MODIFY', baselineSha256: current.sha256,
      contentBytes: file.protection.content, targetSha256: file.protection.sha256! };
  }
  return { path: file.relativePath, action: 'CREATE',
    contentBytes: file.protection.content, targetSha256: file.protection.sha256! };
}

/** 保护副本采集：撤回开始写入前读取目标路径的当前字节（含二进制）。 */
async function captureProtection(rootPath: string,
  relativePath: string): Promise<ProtectionCapture> {
  let absolute: string;
  try {
    absolute = validateSafeRelativePath(rootPath, relativePath);
  } catch {
    return { relativePath, existed: true, content: null, sha256: null, sizeBytes: null,
      unavailableReason: 'READ_FAILED' };
  }
  let info;
  try {
    info = await lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { relativePath, existed: false, content: null, sha256: null, sizeBytes: null,
        unavailableReason: null };
    }
    return { relativePath, existed: true, content: null, sha256: null, sizeBytes: null,
      unavailableReason: 'READ_FAILED' };
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    return { relativePath, existed: true, content: null, sha256: null, sizeBytes: null,
      unavailableReason: 'TARGET_NOT_REGULAR' };
  }
  if (info.size > MAX_PROTECTION_BYTES) {
    return { relativePath, existed: true, content: null, sha256: null,
      sizeBytes: BigInt(info.size), unavailableReason: 'CONTENT_TOO_LARGE' };
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(absolute);
  } catch {
    return { relativePath, existed: true, content: null, sha256: null, sizeBytes: null,
      unavailableReason: 'READ_FAILED' };
  }
  return { relativePath, existed: true, content: bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: BigInt(bytes.byteLength), unavailableReason: null };
}

function undoDto(row: AssistMessageRecallUndoRow): AssistMessageRecallUndoDto {
  return { id: row.id, source_recall_id: row.source_recall_id, status: row.status,
    root_path: row.root_path, files: row.files as unknown as AssistMessageRecallUndoFileDto[],
    detail: row.detail, requested_at: row.requested_at.toISOString(),
    completed_at: row.completed_at?.toISOString() ?? null };
}

function commandIdReused(): DomainError {
  return new DomainError({ code: 'COMMAND_ID_REUSED', status: 409,
    type: '/problems/command-id-reused', title: '命令身份已被使用',
    detail: '该 command_id 已用于另一条消息的撤回；请为新动作使用新的 command_id。',
    retryable: false, retryAction: 'NONE' });
}

function recallInProgress(sessionId: string, messageId: string, detail: string): DomainError {
  return new DomainError({ code: 'RECALL_IN_PROGRESS', status: 409,
    type: '/problems/recall-in-progress', title: '撤回正在进行',
    detail, retryable: true, retryAction: 'POLL_RESOURCE',
    conflict: { sessionId, messageId } });
}

async function assertRecallEligible(r: Repositories, session: AssistSessionRow,
  message: AssistMessageRow, assistant: AssistMessageRow | undefined): Promise<void> {
  if (message.role !== 'USER') {
    throw invalidTransition('只能撤回用户消息。', { messageId: message.id });
  }
  if (message.status !== 'COMPLETED') {
    throw invalidTransition('仅完成态消息可撤回。', { messageId: message.id });
  }
  if (message.withdrawn_at !== null) {
    throw invalidTransition('这条消息已经撤回。', { messageId: message.id });
  }
  if (session.status !== 'ACTIVE') {
    throw invalidTransition('会话已归档；先恢复会话再撤回消息。', { sessionId: session.id });
  }
  if (assistant === undefined || assistant.role !== 'ASSISTANT') {
    throw invalidTransition('找不到这条消息的直接回复，不能确定撤回范围。', { messageId: message.id });
  }
  if ((await r.messageRecall.listNonTerminalMessagesFrom(session.id, message.seq)).length > 0) {
    throw invalidTransition('这条消息之后仍有在途生成；完成或停止后再撤回。',
      { sessionId: session.id, messageId: message.id });
  }
  if ((await r.messageRecall.listOpenToolCallsFrom(session.id, message.seq)).length > 0) {
    throw invalidTransition('这条消息之后仍有未结算的工具调用；先完成核对再撤回。',
      { sessionId: session.id, messageId: message.id });
  }
  if (await r.conversationExecutions.findLiveRunForSession(session.workspace_id, session.id, null)
    !== undefined) {
    throw invalidTransition('该会话仍有在途执行；先安全停止并结算再撤回。',
      { sessionId: session.id, messageId: message.id });
  }
  // §27.3.5 方向规则已放开（2026-10-24 用户拍板）：完成一次撤回后再选更早消息是允许的，
  // 其「当前仍生效的文件效果」由 collectWriteEvents 把已结算撤回的效果折入重算。
}

async function resolveRecallRoot(r: Repositories, session: AssistSessionRow,
  message: AssistMessageRow, events: readonly WriteEvent[]): Promise<string | null> {
  const rootPath = await resolveWorkingRoot(r, session);
  if (events.length === 0) return rootPath;
  const roots = [...new Set(events.map((event) => event.rootPath))];
  if (roots.length > 1) {
    throw new DomainError({ code: 'RECALL_MULTIPLE_ROOTS', status: 409,
      type: '/problems/recall-multiple-roots', title: '撤回范围跨多个工作目录',
      detail: `这条消息之后的写入分布在 ${roots.join('、')}；一次撤回只覆盖一个受管目录，本次没有写入任何文件。`,
      retryable: true, retryAction: 'REFRESH_AND_REDECIDE',
      conflict: { sessionId: session.id, messageId: message.id } });
  }
  const eventRoot = roots[0]!;
  if (rootPath === null) {
    throw new DomainError({ code: 'RECALL_ROOT_UNAVAILABLE', status: 409,
      type: '/problems/recall-root-unavailable', title: '工作目录不可用',
      detail: '该消息之后有文件写入，但当前会话绑定的受管目录不可用；不能回退到不确定的位置。',
      retryable: true, retryAction: 'REFRESH_AND_REDECIDE',
      conflict: { sessionId: session.id, messageId: message.id } });
  }
  if (!sameRootPath(eventRoot, rootPath)) {
    throw new DomainError({ code: 'RECALL_ROOT_CHANGED', status: 409,
      type: '/problems/recall-root-changed', title: '工作目录已变化',
      detail: `文件写入发生在 ${eventRoot}，当前会话绑定的是 ${rootPath}；为避免写入未授权位置，本次没有回退任何文件。`,
      retryable: true, retryAction: 'REFRESH_AND_REDECIDE',
      conflict: { sessionId: session.id, messageId: message.id } });
  }
  return rootPath;
}

async function resolveWorkingRoot(r: Repositories, session: AssistSessionRow): Promise<string | null> {
  if (session.working_resource_id === null) return null;
  const resource = await r.gateway.readResource(session.working_resource_id);
  if (resource === undefined || resource.workspace_id !== session.workspace_id ||
      resource.status !== 'ACTIVE') {
    return null;
  }
  return resource.canonical_root;
}

function sameRootPath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/**
 * 目标 seq 之后本会话关联的已确认写入。
 *
 * 只看真正 APPLIED 的变更；UNKNOWN 的工具调用/变更集让整次撤回先停下核对，
 * 不能用「暂时没看到变更」推断已经恢复。
 */
async function collectWriteEvents(r: Repositories, session: AssistSessionRow,
  minSeq: bigint): Promise<{ events: readonly WriteEvent[]; uncertain: boolean }> {
  const events: WriteEvent[] = [];
  let uncertain = false;

  for (const row of await r.messageRecall.listDirectWriteOperations(session.id, minSeq)) {
    if (row.call_status === 'UNKNOWN' || row.operation_status === 'UNKNOWN') uncertain = true;
    for (const event of directEvents(row)) events.push(event);
  }

  // §27.3.5：已结算撤回也是「当前仍生效状态」的一部分——更早消息的再撤回必须把
  // 这些恢复效果按结算时序折进期望态，否则会把已被撤回的写入当作当前内容判冲突。
  for (const effect of await r.messageRecall.listRecallEffectsForFold(session.id, minSeq)) {
    events.push({ messageId: effect.messageId, messageSeq: effect.messageSeq,
      relativePath: effect.relativePath,
      action: effect.exists ? 'MODIFY' : 'DELETE',
      expectedSha256: effect.sha256, expectedKnown: true,
      rootPath: effect.rootPath, observedAt: effect.settledAt });
  }

  for (const row of await r.messageRecall.listDelegatedWriteFiles(
    session.workspace_id, session.id, minSeq)) {
    if (row.change_set_status === 'UNKNOWN') uncertain = true;
    if (row.file_status !== 'APPLIED') continue;
    const path = safeCanonicalPath(row.root_path, row.relative_path);
    if (path === null) continue;
    const expected = row.action === 'DELETE' ? null
      : (row.actual_sha256 ?? row.target_sha256)?.toLowerCase() ?? null;
    events.push({ messageId: row.message_id, messageSeq: row.message_seq,
      relativePath: path, action: row.action, expectedSha256: expected,
      expectedKnown: row.action === 'DELETE' || expected !== null,
      rootPath: row.root_path, observedAt: row.observed_at });
  }

  return { events, uncertain };
}

function directEvents(row: DirectWriteOperationRow): readonly WriteEvent[] {
  const rawChanges = Array.isArray(row.params.changes) ? row.params.changes : [];
  const rawResults = row.result_ref !== null && isJsonObject(row.result_ref) &&
    Array.isArray(row.result_ref.changes) ? row.result_ref.changes : [];
  const events: WriteEvent[] = [];
  rawChanges.forEach((rawChange, index) => {
    if (!isJsonObject(rawChange) || typeof rawChange.path !== 'string') return;
    const rawResult = rawResults[index];
    if (!isJsonObject(rawResult) || rawResult.status !== 'APPLIED') return;
    const action = rawChange.action;
    if (action !== 'CREATE' && action !== 'MODIFY' && action !== 'DELETE') return;
    const path = safeCanonicalPath(row.root_path, rawChange.path);
    if (path === null) return;
    const expected = action === 'DELETE' ? null
      : typeof rawResult.targetSha256 === 'string' ? rawResult.targetSha256.toLowerCase()
        : typeof rawChange.content === 'string'
          ? createHash('sha256').update(rawChange.content, 'utf8').digest('hex') : null;
    events.push({ messageId: row.message_id, messageSeq: row.message_seq,
      relativePath: path, action, expectedSha256: expected,
      expectedKnown: action === 'DELETE' || expected !== null,
      rootPath: row.root_path, observedAt: row.observed_at });
  });
  return events;
}

async function buildRecallPlan(r: Repositories, targetMessageId: string,
  rootPath: string | null, events: readonly WriteEvent[]): Promise<RecallPlanFile[]> {
  // 恢复目标读**发送前基线**（2026-10-24 用户拍板）：目标用户消息在准入时对受管根
  // 建立的字节基线；没有基线（早于本增量的消息/采集失败未留行）按不可恢复处理。
  const baseline = await r.messageRecall.findBaselineByMessage(targetMessageId);
  const baselineFiles = baseline === undefined ? new Map<string, AssistMessageBaselineFileRow>()
    : new Map((await r.messageRecall.listBaselineFiles(baseline.id))
      .map((file) => [file.relative_path, file]));

  const grouped = new Map<string, WriteEvent[]>();
  for (const event of events) {
    const key = process.platform === 'win32'
      ? event.relativePath.toLowerCase() : event.relativePath;
    const list = grouped.get(key) ?? [];
    list.push(event);
    grouped.set(key, list);
  }

  const plan: RecallPlanFile[] = [];
  for (const key of [...grouped.keys()].sort()) {
    // 按时间折叠（§27.3.5）：撤回效果（completed_at）必然晚于它撤销的写入，时间序
    // 才是「当前仍生效状态」的正确顺序——消息 seq 不能用：写事件归属助手消息
    // （seq=用户 seq+1），而撤回效果挂在其目标用户消息 seq 上，按 seq 排会把
    // 撤回效果排到被撤销写入之前，令更早消息的再撤回永远判冲突。
    const pathEvents = grouped.get(key)!.slice().sort((left, right) =>
      left.observedAt.getTime() - right.observedAt.getTime()
        || (left.messageSeq < right.messageSeq ? -1 : 1));
    const earliest = pathEvents[0]!;
    const latest = pathEvents[pathEvents.length - 1]!;
    const entry = baselineFiles.get(earliest.relativePath);
    const facts = await baselineFacts(r, targetMessageId, baseline?.status ?? null,
      earliest.relativePath, entry, latest);
    const current = rootPath === null
      ? { exists: false, sha256: null, reason: 'ROOT_UNAVAILABLE' }
      : await readCurrentState(rootPath, earliest.relativePath);
    plan.push({ relativePath: earliest.relativePath, ...facts,
      observedSha256: current.sha256, ...preflight(facts, current) });
  }
  return plan;
}

async function baselineFacts(r: Repositories, targetMessageId: string,
  baselineStatus: 'COMPLETE' | 'INCOMPLETE' | null, relativePath: string,
  entry: AssistMessageBaselineFileRow | undefined, latest: WriteEvent): Promise<BaselineFacts> {
  const expected = { expectedSha256: latest.expectedSha256, expectedKnown: latest.expectedKnown };
  const missing = (reason: string): BaselineFacts => ({
    baselineExisted: false, baselineSha256: null, baselineMessageId: null,
    baselineContent: null, ...expected, unavailableReason: reason });
  if (baselineStatus === null) return missing('BASELINE_MISSING');
  if (entry === undefined) {
    // COMPLETE 基线下无条目＝发送前不存在（整份覆盖已核对）；INCOMPLETE 下
    // 无条目分不清「不存在」与「没扫到」，如实按不可恢复。
    return baselineStatus === 'COMPLETE'
      ? { baselineExisted: false, baselineSha256: null, baselineMessageId: null,
        baselineContent: null, ...expected, unavailableReason: null }
      : missing('BASELINE_UNKNOWN');
  }
  if (entry.unavailable_reason !== null || !isFrozenBaseline(entry.blob_sha256)) {
    return missing(entry.unavailable_reason ?? 'BASELINE_MISSING');
  }
  const content = await r.messageRecall.readBaselineBlob(entry.blob_sha256!);
  if (content === undefined) return missing('BASELINE_BLOB_MISSING');
  return { baselineExisted: true, baselineSha256: entry.blob_sha256,
    baselineMessageId: targetMessageId, baselineContent: content, ...expected,
    unavailableReason: null };
}

function preflight(facts: BaselineFacts, current: CurrentFileState): {
  status: PreflightStatus; reason: string | null;
} {
  if (facts.unavailableReason !== null) {
    return { status: 'UNAVAILABLE', reason: facts.unavailableReason };
  }
  if (current.reason !== null) {
    return { status: 'UNAVAILABLE', reason: current.reason };
  }
  if (!facts.expectedKnown) {
    return { status: 'UNCERTAIN', reason: 'EXPECTED_HASH_MISSING' };
  }
  const atBaseline = facts.baselineExisted
    ? current.exists && current.sha256 === facts.baselineSha256
    : !current.exists;
  const atLatest = facts.expectedSha256 === null
    ? !current.exists
    : current.exists && current.sha256 === facts.expectedSha256;
  if (atBaseline) return { status: 'ALREADY_RESTORED', reason: null };
  if (atLatest) return { status: 'RESTORABLE', reason: null };
  return { status: 'CONFLICT', reason: 'CURRENT_CHANGED_SINCE_LAST_WRITE' };
}

function isBlocked(file: RecallPlanFile):
file is RecallPlanFile & { status: 'CONFLICT' | 'UNAVAILABLE' | 'UNCERTAIN' } {
  return file.status === 'CONFLICT' || file.status === 'UNAVAILABLE' || file.status === 'UNCERTAIN';
}

async function executeRecallPlan(db: DbExecutor, r: Repositories, recallId: string,
  rootPath: string | null, plan: readonly RecallPlanFile[]): Promise<AssistMessageRecallDto> {
  // 预检全组阻塞时一个文件都不写；逐路径原因已经足够让人重新决定。
  if (plan.some(isBlocked)) {
    for (const file of plan) {
      if (isBlocked(file)) {
        await r.messageRecall.updateRecallFile(recallId, file.relativePath, {
          observedSha256: file.observedSha256, status: file.status, reason: file.reason });
      } else {
        await r.messageRecall.updateRecallFile(recallId, file.relativePath, {
          observedSha256: file.observedSha256, status: 'SKIPPED', reason: 'PREFLIGHT_BLOCKED' });
      }
    }
    return finalizeRecallRun(db, r, recallId);
  }

  // §27.3.3：首个恢复写入前保存本次目标文件的实际内容（保护副本）。副本不可用时
  // 整次撤回不执行——不写半个回退，也不承诺事后一定可撤销；接续重跑不覆盖首份。
  if (rootPath !== null) {
    const toProtect = plan.filter((file) => file.status === 'RESTORABLE');
    if (toProtect.length > 0) {
      const existing = new Set((await r.messageRecall.listProtections(recallId))
        .map((row) => row.relative_path));
      const captured: ProtectionCapture[] = [];
      for (const file of toProtect) {
        if (existing.has(file.relativePath)) continue;
        captured.push(await captureProtection(rootPath, file.relativePath));
      }
      // §27.3.4 容量预算：占满时保护副本不可用→整次撤回不执行（§27.3.3 的前置），
      // 不删既有快照腾空间。同批按顺序共享余量。
      const limits = readMessageSnapshotLimits();
      let remaining = limits.budgetBytes;
      try {
        const recallRow = await r.messageRecall.findRecallById(recallId);
        remaining -= Number((await r.messageRecall.snapshotUsage(
          recallRow?.workspace_id ?? '')).bytes);
      } catch {
        remaining = 0;
      }
      for (let index = 0; index < captured.length; index++) {
        const entry = captured[index]!;
        if (entry.content !== null && entry.sizeBytes !== null &&
            Number(entry.sizeBytes) > remaining) {
          captured[index] = { ...entry, content: null, sha256: null,
            unavailableReason: 'CAPACITY_FULL' };
        } else if (entry.content !== null && entry.sizeBytes !== null) {
          remaining -= Number(entry.sizeBytes);
        }
      }
      const failed = captured.find((entry) => entry.unavailableReason !== null);
      if (failed !== undefined) {
        for (const file of plan) {
          await r.messageRecall.updateRecallFile(recallId, file.relativePath, {
            observedSha256: file.observedSha256, status: 'SKIPPED',
            reason: `PROTECTION_UNAVAILABLE:${failed.relativePath}:${failed.unavailableReason}` });
        }
        return finalizeRecallRun(db, r, recallId);
      }
      await r.messageRecall.insertProtections(recallId, captured);
    }
  }

  let stopped = false;
  for (const file of plan) {
    await r.messageRecall.touchRunningRecall(recallId);
    if (stopped) {
      await r.messageRecall.updateRecallFile(recallId, file.relativePath, {
        observedSha256: file.observedSha256, status: 'SKIPPED', reason: 'PREVIOUS_FAILURE' });
      continue;
    }
    if (file.status === 'ALREADY_RESTORED') {
      await r.messageRecall.updateRecallFile(recallId, file.relativePath, {
        observedSha256: file.observedSha256, status: 'ALREADY_RESTORED', reason: null });
      continue;
    }
    if (rootPath === null) {
      await r.messageRecall.updateRecallFile(recallId, file.relativePath, {
        observedSha256: file.observedSha256, status: 'UNAVAILABLE', reason: 'ROOT_UNAVAILABLE' });
      stopped = true;
      continue;
    }
    const step = await buildRestoreStep(rootPath, file);
    if (step.kind === 'restored') {
      await r.messageRecall.updateRecallFile(recallId, file.relativePath, {
        observedSha256: step.observedSha256, status: 'ALREADY_RESTORED', reason: null });
      continue;
    }
    if (step.kind === 'blocked') {
      await r.messageRecall.updateRecallFile(recallId, file.relativePath, {
        observedSha256: step.observedSha256, status: step.status, reason: step.reason });
      stopped = true;
      continue;
    }
    const result = await executeFileChangeset(rootPath, [step.change]);
    const outcome = result.changes[0];
    if (outcome?.status === 'APPLIED') {
      await r.messageRecall.updateRecallFile(recallId, file.relativePath, {
        observedSha256: step.restoredSha256, status: 'RESTORED', reason: null });
    } else {
      await r.messageRecall.updateRecallFile(recallId, file.relativePath, {
        observedSha256: outcome?.actualBaselineSha256 ?? null,
        status: outcome?.status === 'CONFLICT' ? 'CONFLICT' : 'FAILED',
        reason: outcome?.error ?? result.reason ?? 'RESTORE_FAILED' });
      stopped = true;
    }
  }
  return finalizeRecallRun(db, r, recallId);
}

/**
 * 写入前最后一次核对当前内容仍等于预检看到的状态。
 *
 * 预检与真正写入之间可能有人改过文件；这里以「预检的期望摘要」为准，
 * 不一致就按冲突停下，绝不把刚读到的任意内容当作新基线覆盖。
 */
async function buildRestoreStep(rootPath: string,
  file: RecallPlanFile): Promise<RestoreStep> {
  const current = await readCurrentState(rootPath, file.relativePath);
  if (current.reason !== null) {
    return { kind: 'blocked', status: 'UNAVAILABLE', reason: current.reason,
      observedSha256: current.sha256 };
  }
  const matchesExpected = file.expectedSha256 === null
    ? !current.exists
    : current.exists && current.sha256 === file.expectedSha256;
  if (!matchesExpected) {
    return { kind: 'blocked', status: 'CONFLICT', reason: 'CURRENT_CHANGED_SINCE_PREFLIGHT',
      observedSha256: current.sha256 };
  }
  if (file.baselineExisted) {
    if (file.baselineContent === null || !isFrozenBaseline(file.baselineSha256)) {
      return { kind: 'blocked', status: 'UNAVAILABLE', reason: 'BASELINE_MISSING',
        observedSha256: current.sha256 };
    }
    if (current.exists) {
      return { kind: 'change', restoredSha256: file.baselineSha256, change: {
        path: file.relativePath, action: 'MODIFY', baselineSha256: current.sha256,
        contentBytes: file.baselineContent, targetSha256: file.baselineSha256 } };
    }
    return { kind: 'change', restoredSha256: file.baselineSha256, change: {
      path: file.relativePath, action: 'CREATE', contentBytes: file.baselineContent,
      targetSha256: file.baselineSha256 } };
  }
  if (!current.exists) return { kind: 'restored', observedSha256: null };
  if (!isFrozenBaseline(current.sha256)) {
    return { kind: 'blocked', status: 'UNAVAILABLE', reason: 'CURRENT_UNREADABLE',
      observedSha256: null };
  }
  return { kind: 'change', restoredSha256: null, change: {
    path: file.relativePath, action: 'DELETE', baselineSha256: current.sha256 } };
}

/**
 * 崩溃/超时后的接续：只重做仍为 PLANNED 的行，并按同一份前像重新预检。
 *
 * 已经 RESTORED/ALREADY_RESTORED 的行保持原结果；重新预检发现的新冲突不会
 * 让本次接续继续写其它文件，而是如实落为冲突/跳过，再结算整张回执。
 */
async function resumeRecall(db: DbExecutor, r: Repositories,
  row: AssistMessageRecallRow): Promise<AssistMessageRecallDto> {
  const files = await r.messageRecall.listRecallFiles(row.id);
  const pendingRows = files.filter((file) => file.status === 'PLANNED');
  if (pendingRows.length === 0) return finalizeRecallRun(db, r, row.id);

  if (row.root_path === null) {
    const pending: RecallPlanFile[] = [];
    for (const file of pendingRows) {
      const facts = await storedFacts(r, file, undefined);
      pending.push({ relativePath: file.relative_path, ...facts,
        observedSha256: file.observed_sha256, status: 'UNAVAILABLE' as const,
        reason: 'ROOT_UNAVAILABLE' });
    }
    return executeRecallPlan(db, r, row.id, null, pending);
  }

  // 接续复用目标消息的发送前基线（同一身份、同一目标；基线被清理则如实不可恢复）。
  const resumeBaseline = await r.messageRecall.findBaselineByMessage(row.message_id);
  const resumeFiles = resumeBaseline === undefined
    ? new Map<string, AssistMessageBaselineFileRow>()
    : new Map((await r.messageRecall.listBaselineFiles(resumeBaseline.id))
      .map((file) => [file.relative_path, file]));
  const pending: RecallPlanFile[] = [];
  for (const file of pendingRows) {
    const facts = await storedFacts(r, file, resumeFiles.get(file.relative_path));
    const current = await readCurrentState(row.root_path, file.relative_path);
    pending.push({ relativePath: file.relative_path, ...facts,
      observedSha256: current.sha256, ...preflight(facts, current) });
  }
  return executeRecallPlan(db, r, row.id, row.root_path, pending);
}

async function storedFacts(r: Repositories, file: AssistMessageRecallFileRow,
  entry: AssistMessageBaselineFileRow | undefined): Promise<BaselineFacts> {
  const base = {
    baselineExisted: file.baseline_existed,
    baselineSha256: file.baseline_sha256,
    baselineMessageId: file.baseline_message_id,
    baselineContent: null as Buffer | null,
    expectedSha256: file.expected_current_sha256,
    // 落库前预检已确认过期望摘要；null 只表示「最后写入是删除」。
    expectedKnown: true,
    unavailableReason: null as string | null,
  };
  if (!file.baseline_existed) return base;
  if (entry === undefined || entry.unavailable_reason !== null
      || entry.blob_sha256 !== file.baseline_sha256) {
    return { ...base, unavailableReason: 'BASELINE_MISSING' };
  }
  const content = await r.messageRecall.readBaselineBlob(entry.blob_sha256!);
  if (content === undefined) return { ...base, unavailableReason: 'BASELINE_BLOB_MISSING' };
  return { ...base, baselineContent: content };
}

async function finalizeRecallRun(db: DbExecutor, r: Repositories,
  recallId: string): Promise<AssistMessageRecallDto> {
  const recallRow = await r.messageRecall.findRecallById(recallId);
  if (recallRow === undefined) throw new Error('Recall row disappeared during execution');
  const files = await r.messageRecall.listRecallFiles(recallId);
  const restored = files.filter((file) =>
    file.status === 'RESTORED' || file.status === 'ALREADY_RESTORED').length;
  const skipped = files.length - restored;
  const status: AssistMessageRecallStatus = skipped === 0 ? 'COMPLETED'
    : restored > 0 ? 'PARTIAL' : 'FAILED';
  const detail: JsonObject = {
    file_count: files.length,
    restored_count: restored,
    skipped_count: skipped,
    ...(skipped === 0 ? {} : { note: '部分文件未能恢复；逐路径实际状态与原因见 files。' }),
  };
  await withTransaction(db, async (tx) => {
    await tx.messageRecall.finalizeRecall({
      id: recallId, status, restoredFiles: restored, skippedFiles: skipped, detail,
      // 部分恢复仍是一次生效的撤回：消息标明已撤回，未恢复的文件由回执逐项交代。
      withdrawnMessageIds: status === 'FAILED'
        ? [] : [recallRow.message_id, recallRow.assistant_message_id],
    });
  });
  const finalized = await r.messageRecall.findRecallById(recallId);
  if (finalized === undefined) throw new Error('Recall row disappeared after finalization');
  // BC-16：确实撤销了已完成任务的当前成果时，沿既有 ReopenTask 入口重开受影响任务，
  // 新验收周期、历史完成保留、不自动 Run；结果与文件恢复分别记录（§8.5）。
  await reopenAffectedDoneTasks(db, r, recallId);
  const withReopens = await r.messageRecall.findRecallById(recallId);
  return readRecallReceipt(r, withReopens ?? finalized);
}

/**
 * 受影响任务的判定：本次撤回**实际恢复（RESTORED）**的路径里，来自委派执行
 * （conversation_execution_requests → Run → change_sets）且该请求绑定了 Task 的写入。
 * 只有状态为 DONE 的任务重开；revision 冲突等失败逐项记录，不显示整体完成。
 */
async function reopenAffectedDoneTasks(db: DbExecutor, r: Repositories,
  recallId: string): Promise<void> {
  const recall = await r.messageRecall.findRecallById(recallId);
  if (recall === undefined) return;
  const files = await r.messageRecall.listRecallFiles(recallId);
  const restoredPaths = new Set(files.filter((file) => file.status === 'RESTORED')
    .map((file) => file.relative_path));
  if (restoredPaths.size === 0) return;
  const recallMessage = await r.assist.readMessage(recall.message_id);
  const delegated = await r.messageRecall.listDelegatedWriteFiles(
    recall.workspace_id, recall.session_id, recallMessage?.seq ?? 0n);
  const affectedTaskIds = new Set<string>();
  for (const row of delegated) {
    if (row.file_status !== 'APPLIED' || row.task_id === null) continue;
    if (restoredPaths.has(row.relative_path)) affectedTaskIds.add(row.task_id);
  }
  if (affectedTaskIds.size === 0) return;
  const results: JsonObject[] = [];
  for (const taskId of affectedTaskIds) {
    const task = await r.tasks.readTask(taskId);
    if (task === undefined || task.status !== 'DONE') continue;
    try {
      const outcome = await reopenTask(db, { workspaceId: recall.workspace_id, taskId,
        commandId: randomUUID(), expectedRevision: task.revision.toString(),
        reason: `消息撤回恢复了该任务执行写入的文件（撤回 ${recallId}）；进入新验收周期。` });
      results.push({ task_id: taskId, status: 'REOPENED',
        revision: outcome.result.revision, acceptance_revision: outcome.result.acceptance_revision });
    } catch (error) {
      results.push({ task_id: taskId, status: 'FAILED',
        reason: error instanceof Error ? error.message : String(error) });
    }
  }
  if (results.length > 0) {
    await r.messageRecall.mergeRecallDetail(recallId, { task_reopens: results });
  }
}

async function readCurrentState(rootPath: string,
  relativePath: string): Promise<CurrentFileState> {
  let absolute: string;
  try {
    absolute = validateSafeRelativePath(rootPath, relativePath);
  } catch {
    return { exists: false, sha256: null, reason: 'PATH_UNSAFE' };
  }
  let info;
  try {
    info = await lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, sha256: null, reason: null };
    }
    return { exists: true, sha256: null, reason: 'CURRENT_UNREADABLE' };
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    return { exists: true, sha256: null, reason: 'TARGET_NOT_REGULAR' };
  }
  if (info.size > MAX_CURRENT_HASH_BYTES) {
    return { exists: true, sha256: null, reason: 'CURRENT_TOO_LARGE' };
  }
  try {
    const bytes = await readFile(absolute);
    return { exists: true, sha256: createHash('sha256').update(bytes).digest('hex'), reason: null };
  } catch {
    return { exists: true, sha256: null, reason: 'CURRENT_UNREADABLE' };
  }
}

function safeCanonicalPath(rootPath: string, relativePath: string): string | null {
  try {
    const path = canonicalRelativePath(rootPath, relativePath);
    return path === '' || isProtectedPath(path) ? null : path;
  } catch {
    return null;
  }
}

async function readRecallReceipt(r: Repositories,
  row: AssistMessageRecallRow): Promise<AssistMessageRecallDto> {
  const files = await r.messageRecall.listRecallFiles(row.id);
  return {
    id: row.id, message_id: row.message_id,
    assistant_message_id: row.assistant_message_id, status: row.status,
    root_path: row.root_path, planned_files: row.planned_files,
    restored_files: row.restored_files, skipped_files: row.skipped_files,
    detail: row.detail, requested_at: row.requested_at.toISOString(),
    completed_at: row.completed_at?.toISOString() ?? null,
    files: files.map((file) => fileDto(file)),
  };
}

function fileDto(file: AssistMessageRecallFileRow): AssistMessageRecallFileDto {
  return { path: file.relative_path, status: file.status, reason: file.reason,
    baseline: file.baseline_existed ? 'PRESENT' : 'ABSENT',
    baseline_sha256: file.baseline_sha256 };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
