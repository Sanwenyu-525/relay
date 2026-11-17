import { randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import type { MemoryRootRow } from '../infrastructure/database-schema.js';
import { httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand } from './command.js';
import { invalidTransition, resourceNotFound, validationFailed } from './domain-error.js';
import { computeMemoryConfidence } from './memory-model.js';
import { runMemoryConsolidation } from './memory-consolidation.js';
import { requireRevision } from './revisions.js';

import type { Repositories } from './unit-of-work.js';

async function requireMemory(r: Repositories,
  workspaceId: string, memoryId: string): Promise<MemoryRootRow> {
  const row = await r.information.readRoot<MemoryRootRow>('memory', memoryId);
  if (row?.workspace_id !== workspaceId) throw resourceNotFound('Memory');
  return row;
}

/** 固定/取消固定：只影响每轮常驻召回；固定不等于「已验证」，两者分列。 */
export async function setMemoryPinnedCommand(db: DbExecutor, input: { workspaceId: string;
  memoryId: string; pinned: boolean; commandId: string; expectedRevision: string }) {
  const expected = requireRevision(input.expectedRevision, 'expected_revision');
  return runIdempotentCommand<JsonObject>(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'SetMemoryPinned', target: { memory_id: input.memoryId },
    body: { expected_revision: expected.toString(), pinned: input.pinned },
    execute: async (r) => {
      if (await r.workspaces.lockAuthority(input.workspaceId, 'update') === undefined) {
        throw resourceNotFound('Workspace');
      }
      const prior = await r.receipts.findReceipt({ scopeKey: httpCommandScopeKey(input.workspaceId),
        commandId: input.commandId });
      if (prior !== undefined) return prior.result_ref;
      const row = await requireMemory(r, input.workspaceId, input.memoryId);
      if (row.revision !== expected) {
        throw invalidTransition('Memory 修订已变化，请刷新后重试。');
      }
      if (row.status !== 'ACTIVE' || row.superseded_by_id !== null) {
        throw invalidTransition('只能固定当前有效的 Memory。');
      }
      await r.information.setMemoryPinned(row.id, input.pinned);
      await r.activities.insertActivityRecord({ id: randomUUID(), workspaceId: input.workspaceId,
        actorKind: 'HUMAN', actorRef: 'memory-pin', commandId: input.commandId,
        projectId: row.project_id, taskId: row.task_id, eventType: 'MEMORY_PINNED',
        factRefs: { memory_id: row.id, pinned: input.pinned } });
      await r.workspaces.bumpContextRevision(input.workspaceId);
      return { memory_id: row.id, revision: (row.revision + 1n).toString(),
        pinned: input.pinned };
    } });
}

/**
 * 人工验证：VERIFIED 表示用户确认该结论已被验证；FAILED 只允许经验记忆，
 * 且不能被召回成有效解决方法。任何标记都保留原正文与来源。
 */
export async function setMemoryVerificationCommand(db: DbExecutor, input: { workspaceId: string;
  memoryId: string; verification: 'VERIFIED' | 'UNVERIFIED' | 'FAILED'; clearStale: boolean;
  commandId: string; expectedRevision: string }) {
  const expected = requireRevision(input.expectedRevision, 'expected_revision');
  return runIdempotentCommand<JsonObject>(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'SetMemoryVerification',
    target: { memory_id: input.memoryId },
    body: { expected_revision: expected.toString(), verification: input.verification,
      clear_stale: input.clearStale }, execute: async (r) => {
      if (await r.workspaces.lockAuthority(input.workspaceId, 'update') === undefined) {
        throw resourceNotFound('Workspace');
      }
      const prior = await r.receipts.findReceipt({ scopeKey: httpCommandScopeKey(input.workspaceId),
        commandId: input.commandId });
      if (prior !== undefined) return prior.result_ref;
      const row = await requireMemory(r, input.workspaceId, input.memoryId);
      if (row.revision !== expected) {
        throw invalidTransition('Memory 修订已变化，请刷新后重试。');
      }
      if (row.status !== 'ACTIVE' || row.superseded_by_id !== null) {
        throw invalidTransition('只能验证当前有效的 Memory。');
      }
      if (input.verification === 'FAILED' && row.memory_type !== 'EXPERIENCE') {
        throw validationFailed([{ field: 'verification',
          message: '只有经验记忆可以标记为明确失败。' }]);
      }
      const confidence = computeMemoryConfidence({ origin: row.origin, sourceKind: row.source_kind,
        verification: input.verification });
      await r.information.setMemoryVerification(row.id, input.verification, confidence);
      if (input.clearStale) await r.information.clearMemoryStale(row.id);
      await r.activities.insertActivityRecord({ id: randomUUID(), workspaceId: input.workspaceId,
        actorKind: 'HUMAN', actorRef: 'memory-verification', commandId: input.commandId,
        projectId: row.project_id, taskId: row.task_id, eventType: 'MEMORY_VERIFIED',
        factRefs: { memory_id: row.id, verification: input.verification } });
      await r.workspaces.bumpContextRevision(input.workspaceId);
      const refreshed = await requireMemory(r, input.workspaceId, input.memoryId);
      return { memory_id: row.id, revision: refreshed.revision.toString(),
        verification: input.verification };
    } });
}

/**
 * 人工延长/取消有效期（0167）：只改根的 `expires_at_override`，历史版本保留原到期时间。
 * 不允许把有效期设到过去——真过期就是过期，不能靠改日期伪造“当前有效”。
 */
export async function setMemoryExpiryCommand(db: DbExecutor, input: { workspaceId: string;
  memoryId: string; expiresAt: string | null; commandId: string; expectedRevision: string }) {
  const expected = requireRevision(input.expectedRevision, 'expected_revision');
  const expiresAt = input.expiresAt === null ? null : new Date(input.expiresAt);
  if (expiresAt !== null && Number.isNaN(expiresAt.getTime())) {
    throw validationFailed([{ field: 'expires_at', message: '必须是 ISO 时间或 null' }]);
  }
  if (expiresAt !== null && expiresAt.getTime() <= Date.now()) {
    throw validationFailed([{ field: 'expires_at', message: '新的有效期必须晚于当前时间' }]);
  }
  return runIdempotentCommand<JsonObject>(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'SetMemoryExpiry',
    target: { memory_id: input.memoryId },
    body: { expected_revision: expected.toString(), expires_at: expiresAt?.toISOString() ?? null },
    execute: async (r) => {
      if (await r.workspaces.lockAuthority(input.workspaceId, 'update') === undefined) {
        throw resourceNotFound('Workspace');
      }
      const prior = await r.receipts.findReceipt({ scopeKey: httpCommandScopeKey(input.workspaceId),
        commandId: input.commandId });
      if (prior !== undefined) return prior.result_ref;
      const row = await requireMemory(r, input.workspaceId, input.memoryId);
      if (row.revision !== expected) throw invalidTransition('Memory 修订已变化，请刷新后重试。');
      if (row.status !== 'ACTIVE' || row.superseded_by_id !== null) {
        throw invalidTransition('只能调整当前有效 Memory 的有效期。');
      }
      await r.information.setMemoryExpiryOverride(row.id, expiresAt);
      await r.activities.insertActivityRecord({ id: randomUUID(), workspaceId: input.workspaceId,
        actorKind: 'HUMAN', actorRef: 'memory-expiry', commandId: input.commandId,
        projectId: row.project_id, taskId: row.task_id, eventType: 'MEMORY_EXPIRY_CHANGED',
        factRefs: { memory_id: row.id, expires_at: expiresAt?.toISOString() ?? '' } });
      await r.workspaces.bumpContextRevision(input.workspaceId);
      return { memory_id: row.id, revision: (row.revision + 1n).toString(),
        expires_at: expiresAt?.toISOString() ?? null };
    } });
}

/** 手动整理：与 Worker 使用同一个确定性整理器；没有到期工作区不在这里判断。 */
export async function consolidateMemoriesCommand(db: DbExecutor, input: { workspaceId: string;
  commandId: string }) {
  return runIdempotentCommand<JsonObject>(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'ConsolidateMemories',
    target: { workspace_id: input.workspaceId }, body: {},
    execute: async (r) => {
      if (await r.workspaces.lockAuthority(input.workspaceId, 'update') === undefined) {
        throw resourceNotFound('Workspace');
      }
      const prior = await r.receipts.findReceipt({ scopeKey: httpCommandScopeKey(input.workspaceId),
        commandId: input.commandId });
      if (prior !== undefined) return prior.result_ref;
      const result = await runMemoryConsolidation(db, r, { workspaceId: input.workspaceId,
        trigger: 'MANUAL' });
      await r.activities.insertActivityRecord({ id: randomUUID(), workspaceId: input.workspaceId,
        actorKind: 'HUMAN', actorRef: 'memory-consolidation', commandId: input.commandId,
        projectId: null, taskId: null, eventType: 'MEMORY_CONSOLIDATED',
        factRefs: { status: result.status, ...result.stats } });
      return { status: result.status, ...result.stats };
    } });
}
