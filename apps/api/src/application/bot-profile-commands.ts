import { randomUUID } from 'node:crypto';

import type { BotProfileRepository } from '../assist/bot-profile-repository.js';
import type { BotProfileRow, ConversationMode } from '../infrastructure/database-schema.js';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import { httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand, type CommandOutcome } from './command.js';
import { invalidTransition, resourceNotFound, revisionConflict, validationFailed } from './domain-error.js';
import { requireRevision } from './revisions.js';
import { toDecimalString } from '../shared/decimal.js';

/**
 * 人设 bot 配置用例（迁移 0059、ADR-018）。
 *
 * bot 是**配置文本**，不是授权：名字、角色、口吻与只读目录范围在这里落库，
 * 能力来自连接与 Gateway 准入。因此本文件不读也不写任何 capability / connection /
 * permission 字段——0059 的 ck_assist_session_role_snapshot 与 ck_bot_profile_read_scope
 * 会把这类字段挡在存储层。
 *
 * read_scope 只能缩小：它限定 bot 能读到受管根里的哪一段，缺省 {} 表示整根可读。
 * 这里的校验是「只能缩小」的唯一实现点，因此拒绝绝对路径、`..` 与空串——
 * 否则一个 bot 就能把范围写到受管根之外，而那属于连接与策略的职责。
 */

const MAX_NAME = 60;
const MAX_ROLE = 2_000;
const MAX_TONE = 400;
const MAX_SCOPE_ROOTS = 20;
const MAX_SCOPE_ROOT_LENGTH = 400;

/** 建会话时冻结的人设快照。刻意只含四个文本字段：快照是文本，不是授权。 */
export function frozenRoleSnapshot(profile: BotProfileRow): JsonObject {
  return {
    name: profile.name,
    role_description: profile.role_description,
    tone: profile.tone,
    read_scope: profile.read_scope,
  };
}

/** 消息行上的角色标签。用冻结修订而不是当前修订：显示的是这条会话建立时的人设。 */
export function personaDisplayLabel(snapshot: JsonObject, revision: bigint): string {
  const name = typeof snapshot.name === 'string' ? snapshot.name : '未命名 bot';
  return `${name} · 人设 v${revision.toString()}`;
}

/**
 * 校验只读范围并归一化。
 *
 * 接受两种形状：缺省 {}，或 { roots: ["<受管根内相对路径>", ...] }。
 * 拒绝其他键、绝对路径、`..` 与空串——bot 的范围只能是受管根的子集。
 */
export function validateReadScope(raw: JsonObject | undefined): JsonObject {
  if (raw === undefined) return {};
  const entries = Object.entries(raw);
  if (entries.length === 0) return {};
  const roots = raw.roots;
  if (entries.length !== 1 || entries[0]?.[0] !== 'roots' || !Array.isArray(roots)) {
    throw validationFailed([{ field: 'read_scope',
      message: '只读范围只能是 {} 或 { roots: [...] }' }]);
  }
  if (roots.length > MAX_SCOPE_ROOTS) {
    throw validationFailed([{ field: 'read_scope', message: `只读范围最多 ${MAX_SCOPE_ROOTS} 项` }]);
  }
  const normalized: string[] = [];
  for (const entry of roots) {
    if (typeof entry !== 'string') {
      throw validationFailed([{ field: 'read_scope', message: '只读范围的每一项必须是字符串' }]);
    }
    const value = entry.replaceAll('\\', '/').trim();
    if (value === '' || value.length > MAX_SCOPE_ROOT_LENGTH ||
        value.startsWith('/') || /^[a-zA-Z]:/u.test(value) ||
        value.split('/').some((segment) => segment === '..' || segment === '.')) {
      throw validationFailed([{ field: 'read_scope',
        message: '只读范围只能是受管根内的相对路径' }]);
    }
    if (!normalized.includes(value)) normalized.push(value);
  }
  return { roots: normalized };
}

function requireText(value: string | undefined, field: string, label: string,
  max: number): string {
  const trimmed = (value ?? '').trim();
  if (trimmed === '') throw validationFailed([{ field, message: `${label}不能为空` }]);
  if (trimmed.length > max) {
    throw validationFailed([{ field, message: `${label}最多 ${max} 字` }]);
  }
  return trimmed;
}

function profileResult(profile: BotProfileRow): JsonObject {
  return { bot_profile_id: profile.id, workspace_id: profile.workspace_id,
    name: profile.name, role_description: profile.role_description,
    tone: profile.tone, read_scope: profile.read_scope, status: profile.status,
    revision: toDecimalString(profile.revision) };
}

/** workspace 内活跃名唯一。并发建同名 bot 时由部分唯一索引兜底，冲突翻译成明确报错。 */
const UNIQUE_VIOLATION = '23505';

export type CreateBotProfileResult = JsonObject;
export type ReviseBotProfileResult = JsonObject;
export type ArchiveBotProfileResult = JsonObject;

export interface CreateBotProfileInput {
  readonly workspaceId: string;
  readonly commandId: string;
  readonly name: string;
  readonly roleDescription: string;
  readonly tone?: string | undefined;
  readonly readScope?: JsonObject | undefined;
}

export async function createBotProfile(db: DbExecutor, input: CreateBotProfileInput):
Promise<CommandOutcome<CreateBotProfileResult>> {
  const name = requireText(input.name, 'name', 'bot 名称', MAX_NAME);
  const roleDescription = requireText(input.roleDescription, 'role_description', '角色描述', MAX_ROLE);
  const tone = input.tone === undefined ? null
    : requireText(input.tone, 'tone', '口吻', MAX_TONE);
  const readScope = validateReadScope(input.readScope);

  try {
    return await runIdempotentCommand<CreateBotProfileResult>(db, {
      scopeKey: httpCommandScopeKey(input.workspaceId),
      commandId: input.commandId,
      commandType: 'CreateBotProfile',
      target: { workspace_id: input.workspaceId },
      body: { name, role_description: roleDescription, tone, read_scope: readScope },
      execute: async (repositories) => {
        const id = randomUUID();
        await repositories.botProfiles.insert({ id, workspaceId: input.workspaceId, name,
          roleDescription, tone, readScope });
        const created = await repositories.botProfiles.read(id);
        if (created === undefined) {
          throw new Error('bot profile row vanished within its creating transaction');
        }
        return profileResult(created);
      },
    });
  } catch (error) {
    throw translateDuplicateName(error, name);
  }
}

export interface ReviseBotProfileInput {
  readonly workspaceId: string;
  readonly botProfileId: string;
  readonly commandId: string;
  readonly expectedRevision: string;
  readonly name: string;
  readonly roleDescription: string;
  readonly tone?: string | undefined;
  readonly readScope?: JsonObject | undefined;
}

/**
 * 改内容而不是改边界：既有会话的冻结快照因此不受影响（快照在建会话时已定稿）。
 * CAS 落后按 REVISION_CONFLICT 拒绝，不静默覆盖并发的另一次改写。
 */
export async function reviseBotProfile(db: DbExecutor, input: ReviseBotProfileInput):
Promise<CommandOutcome<ReviseBotProfileResult>> {
  const expectedRevision = requireRevision(input.expectedRevision, 'expected_revision');
  const name = requireText(input.name, 'name', 'bot 名称', MAX_NAME);
  const roleDescription = requireText(input.roleDescription, 'role_description', '角色描述', MAX_ROLE);
  const tone = input.tone === undefined ? null
    : requireText(input.tone, 'tone', '口吻', MAX_TONE);
  const readScope = validateReadScope(input.readScope);

  try {
    return await runIdempotentCommand<ReviseBotProfileResult>(db, {
      scopeKey: httpCommandScopeKey(input.workspaceId),
      commandId: input.commandId,
      commandType: 'ReviseBotProfile',
      target: { bot_profile_id: input.botProfileId },
      body: { expected_revision: expectedRevision.toString(), name,
        role_description: roleDescription, tone, read_scope: readScope },
      execute: async (repositories) => {
        const current = await repositories.botProfiles.read(input.botProfileId, true);
        if (current === undefined || current.workspace_id !== input.workspaceId) {
          throw resourceNotFound('Bot profile');
        }
        if (current.status !== 'ACTIVE') {
          throw invalidTransition('bot 已归档，不能改写；请新建一个。');
        }
        const revised = await repositories.botProfiles.revise({ id: input.botProfileId,
          expectedRevision, name, roleDescription, tone, readScope });
        if (!revised) throw staleBot(current.revision, expectedRevision);
        const updated = await repositories.botProfiles.read(input.botProfileId);
        if (updated === undefined) {
          throw new Error('bot profile row vanished within its revising transaction');
        }
        return profileResult(updated);
      },
    });
  } catch (error) {
    throw translateDuplicateName(error, name);
  }
}

export interface ArchiveBotProfileInput {
  readonly workspaceId: string;
  readonly botProfileId: string;
  readonly commandId: string;
  readonly expectedRevision: string;
}

/**
 * 归档推进「是否仍适用」，不改写配置文本。
 *
 * 归档会让正挂着它的会话冻结（发消息被拒），但历史仍可读：撤销依据不能让既有讨论消失。
 * 名字因此释放给新 bot 复用。
 */
export async function archiveBotProfile(db: DbExecutor, input: ArchiveBotProfileInput):
Promise<CommandOutcome<ArchiveBotProfileResult>> {
  const expectedRevision = requireRevision(input.expectedRevision, 'expected_revision');
  return runIdempotentCommand<ArchiveBotProfileResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'ArchiveBotProfile',
    target: { bot_profile_id: input.botProfileId },
    body: { expected_revision: expectedRevision.toString() },
    execute: async (repositories) => {
      const current = await repositories.botProfiles.read(input.botProfileId, true);
      if (current === undefined || current.workspace_id !== input.workspaceId) {
        throw resourceNotFound('Bot profile');
      }
      if (current.status === 'ARCHIVED') return profileResult(current);
      const archived = await repositories.botProfiles.archive(input.botProfileId, expectedRevision);
      if (!archived) throw staleBot(current.revision, expectedRevision);
      const updated = await repositories.botProfiles.read(input.botProfileId);
      if (updated === undefined) {
        throw new Error('bot profile row vanished within its archiving transaction');
      }
      return profileResult(updated);
    },
  });
}

/**
 * 会话建立与发送准入共用的 bot 判定。
 *
 * 跨 workspace 读不到；已归档一律拒，错误文案带上 bot 名与「换一个 bot」的指引，
 * 因为人在这时需要的是一个下一步，而不是一个错误码。
 * 依据是「批准不能覆盖已撤销权限」：冻结快照不替归档后的 bot 续命。
 */
export async function requireActiveBotProfile(repository: BotProfileRepository,
  workspaceId: string, botProfileId: string): Promise<BotProfileRow> {
  const profile = await repository.read(botProfileId);
  if (profile === undefined || profile.workspace_id !== workspaceId) {
    throw resourceNotFound('Bot profile');
  }
  if (profile.status !== 'ACTIVE') {
    throw invalidTransition(`bot「${profile.name}」已归档，不能再发送消息；请换一个 bot 或打开它继续读历史。`);
  }
  return profile;
}

export type { ConversationMode };

/**
 * CAS 落空一律走既有的 REVISION_CONFLICT，而不是笼统的「状态不对」：
 * 调用方需要知道该重新读取哪个实体、带哪个修订重试。
 */
function staleBot(actualRevision: bigint, expectedRevision: bigint): Error {
  return revisionConflict({ entityType: 'Bot profile',
    expectedRevision: expectedRevision.toString(), actualRevision: actualRevision.toString() });
}

/** 同名冲突翻译成明确报错，绝不改写既有 bot。 */
function translateDuplicateName(error: unknown, name: string): unknown {
  if (typeof error === 'object' && error !== null &&
      (error as { code?: unknown }).code === UNIQUE_VIOLATION) {
    return validationFailed([{ field: 'name', message: `已有同名 bot「${name}」，请换一个名字。` }]);
  }
  return error;
}