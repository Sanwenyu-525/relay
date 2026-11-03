import type { DbExecutor } from '../infrastructure/database.js';
import type { SessionModelSelectionRow } from '../infrastructure/database-schema.js';
import {
  computeModelConfigFingerprint,
  readModelPortConfig,
  readOpenRouterModelPortConfig,
  type ModelPortConfig,
} from '../workflow/model-port-config.js';
import { ConfigError } from '../config/config.js';
import type { CredentialStore } from '../credentials/credential-store.js';
import { CredentialStoreError } from '../credentials/credential-store.js';
import { toDecimalString } from '../shared/decimal.js';
import { httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand, type CommandOutcome } from './command.js';
import { DomainError, invalidTransition, resourceNotFound } from './domain-error.js';
import {
  connectionConfigFingerprint,
  credentialStoreFailure,
} from './model-connection-runtime.js';
import {
  resolveModelSelection,
  type ModelSelectionRejection,
} from './model-selection-resolve.js';
import { createRepositories, type Repositories } from './unit-of-work.js';

/**
 * 会话模型选择的唯一应用 Owner（专项阶段 C，迁移 0089）。
 *
 * 它是「本会话后续新发起的请求改用哪个模型」这一事实的写入点：只读会话/目录/配置、
 * 只写 session_model_selection，绝不写回进程默认（RELAY_MODEL_*），也不建 Task/Run、
 * 不发外呼、不写 model_calls。选择沿用命令回执与幂等基础：同一 command_id 重放返回
 * 当时结果，不同 payload 被拒；跨会话互不影响。
 *
 *   * 命中进程已配置的默认模型 → 解析出连接指纹并落库（free_only=false，沿用原默认行为）；
 *   * 命中目录里的严格免费 OpenRouter 型号 → 只从独立 RELAY_OPENROUTER_API_KEY
 *     （缺省回退 OPENROUTER_API_KEY）解析凭据与固定官方端点，落库非密钥指纹；
 *   * 命中工作区已登记连接（迁移 0158）→ 绑定稳定 `connection_id`，型号取该连接当前
 *     `default_model`；连接停用或凭据缺失即类型化拒绝，绝不退回进程默认；
 *   * 目录外的型号 / 收费型号 → 类型化拒绝，绝不悄悄接成一次外呼或换型号（FM-05/FM-06）。
 *
 * 清除选择（恢复跟随默认）同样经命令回执：DELETE 不推进 revision，重放返回当时结果。
 *
 * env / now 可注入，供无凭据、可控时钟的隔离验证；生产缺省读 process。
 */

export type SessionModelSelectionResult = {
  readonly session_id: string;
  readonly connection: 'default' | 'openrouter' | 'registered';
  /** `connection=registered` 时指向的模型连接；另两枚恒为 null。 */
  readonly connection_id: string | null;
  readonly model: string;
  readonly free_only: boolean;
  readonly config_fingerprint: string;
  readonly catalog_source: 'openrouter' | null;
  readonly catalog_snapshot_seq: string | null;
  readonly catalog_model_id: string | null;
  readonly revision: string;
};

export async function selectSessionModel(db: DbExecutor, input: {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly commandId: string;
  readonly requestedModel: string;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly now?: Date | undefined;
}): Promise<CommandOutcome<SessionModelSelectionResult>> {
  const env = input.env ?? process.env;
  const now = input.now ?? new Date();
  return runIdempotentCommand<SessionModelSelectionResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'SelectSessionModel',
    target: { session_id: input.sessionId },
    body: { model: input.requestedModel },
    execute: async (repositories) => {
      // 1) 会话必须存在、属于本 Workspace、处于 ACTIVE。选择只影响后续新请求，不触碰在途消息。
      await lockSelectableSession(repositories, input.workspaceId, input.sessionId);

      // 2) 纯解析：默认连接模型 vs 目录型号 vs 拒绝。目录读的是已发布快照，不外呼。
      const portConfig = readModelPortConfig(env);
      const sync = await repositories.modelCatalog.readSyncState();
      const entries = await repositories.modelCatalog.readEntries(false);
      const resolved = resolveModelSelection({
        requested: input.requestedModel,
        ...(portConfig === undefined ? {} : { defaultModel: portConfig.model }),
        catalog: {
          snapshotSeq: toDecimalString(sync.snapshot_seq),
          models: entries.map((entry) => ({
            source_model_id: entry.source_model_id, is_free: entry.is_free,
          })),
        },
      });
      if (!resolved.ok) throw selectionRejected(resolved.rejection);

      // 3) 连接指纹：OpenRouter 凭据与默认连接完全独立，不得串用 RELAY_MODEL_API_KEY。
      let selectedConfig: ModelPortConfig | undefined;
      try {
        selectedConfig = resolved.selection.connection === 'openrouter'
          ? readOpenRouterModelPortConfig(env, resolved.selection.model) : portConfig;
      } catch (error) {
        if (resolved.selection.connection === 'openrouter' && error instanceof ConfigError) {
          throw openRouterChatNotConfigured();
        }
        throw error;
      }
      if (selectedConfig === undefined) {
        // 命中 default 连接必然有 portConfig；到此说明默认连接未配置，按未登记处理（防御性）。
        throw selectionRejected({ code: 'MODEL_NOT_REGISTERED',
          detail: `“${input.requestedModel}”不可选：本实例未配置默认可执行模型连接。` });
      }
      const configFingerprint = computeModelConfigFingerprint(selectedConfig);

      // 4) CAS 写入本会话选择：以当前 revision 为基线，冲突即回拒，绝不覆盖更新的值。
      const existing = await repositories.modelSelection.readForSession(input.sessionId);
      const applied = await repositories.modelSelection.applySelection({
        sessionId: input.sessionId,
        connection: resolved.selection.connection,
        connectionId: null,
        model: resolved.selection.model,
        configFingerprint,
        freeOnly: resolved.selection.freeOnly,
        catalogSource: resolved.selection.catalogSource,
        catalogSnapshotSeq: resolved.selection.catalogSnapshotSeq,
        catalogModelId: resolved.selection.catalogModelId,
        expectedRevision: existing === undefined ? null : toDecimalString(existing.revision),
        commandId: input.commandId,
        now,
      });
      if (applied === null) throw selectionRevisionConflict(input.sessionId);
      return toSelectionResult(applied);
    },
  });
}

/**
 * 选择一个**已登记连接**（迁移 0158）。
 *
 * 型号不由客户端指定：连接行自己就是「型号 + 端点 + 预算 + 凭据」的完整声明，允许客户端
 * 另报型号会造出「连接 A 的凭据跑型号 B」的状态。与 `selectSessionModel` 共用同一会话前提
 * 与同一 CAS 写入口，区别只在解析来源与失败口径：连接不存在 / 停用 / 缺凭据都是显式错误，
 * 绝不退回进程默认——那等于在用户不知情时换了 Provider。
 */
export async function selectSessionConnection(db: DbExecutor, input: {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly commandId: string;
  readonly connectionId: string;
  readonly credentials: CredentialStore;
  readonly now?: Date | undefined;
}): Promise<CommandOutcome<SessionModelSelectionResult>> {
  const now = input.now ?? new Date();
  return runIdempotentCommand<SessionModelSelectionResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'SelectSessionConnection',
    // 载荷不含密钥也不含连接配置：回执摘要只记录「选了哪条连接」。
    target: { session_id: input.sessionId },
    body: { connection_id: input.connectionId },
    execute: async (repositories) => {
      await lockSelectableSession(repositories, input.workspaceId, input.sessionId);
      const connection = await repositories.modelConnections.read(input.workspaceId,
        input.connectionId);
      if (connection === undefined) throw resourceNotFound('Model connection');
      if (connection.status !== 'ACTIVE') throw connectionDisabledForSelection(connection.name);
      // 选模型只需要「凭据还在」这一事实，不把秘密读进本进程；指纹由冻结端按同一行重算。
      let present: boolean;
      try {
        present = await input.credentials.status(connection.credential_ref);
      } catch (error) {
        throw credentialStoreFailure(error instanceof CredentialStoreError ? error.code : 'UNKNOWN');
      }
      if (!present) throw connectionCredentialMissing(connection.name);
      const existing = await repositories.modelSelection.readForSession(input.sessionId);
      const applied = await repositories.modelSelection.applySelection({
        sessionId: input.sessionId,
        connection: 'registered',
        connectionId: connection.id,
        model: connection.default_model,
        configFingerprint: connectionConfigFingerprint(connection),
        freeOnly: false,
        catalogSource: null,
        catalogSnapshotSeq: null,
        catalogModelId: null,
        expectedRevision: existing === undefined ? null : toDecimalString(existing.revision),
        commandId: input.commandId,
        now,
      });
      if (applied === null) throw selectionRevisionConflict(input.sessionId);
      return toSelectionResult(applied);
    },
  });
}

export type ClearSessionModelSelectionResult = {
  readonly session_id: string;
  readonly cleared: boolean;
};

/** 清除本会话选择，恢复「跟随工作区聊天默认 → 进程默认」。 */
export async function clearSessionModelSelection(db: DbExecutor, input: {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly commandId: string;
}): Promise<CommandOutcome<ClearSessionModelSelectionResult>> {
  return runIdempotentCommand<ClearSessionModelSelectionResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'ClearSessionModelSelection',
    target: { session_id: input.sessionId },
    body: { clear: true },
    execute: async (repositories) => {
      await lockSelectableSession(repositories, input.workspaceId, input.sessionId);
      // 已受理的消息各自带着冻结快照与连接身份，删选择行不影响历史归因。
      const cleared = await repositories.modelSelection.clearForSession(input.sessionId);
      return { session_id: input.sessionId, cleared };
    },
  });
}

/** 三种写入（选择 / 换成连接 / 清除）共用的会话前提：存在、本工作区、ACTIVE、无在途消息。 */
async function lockSelectableSession(repositories: Repositories, workspaceId: string,
  sessionId: string): Promise<void> {
  const session = await repositories.assist.readSession(sessionId, true);
  if (session === undefined || session.workspace_id !== workspaceId) {
    throw resourceNotFound('Assist session');
  }
  if (session.status !== 'ACTIVE') {
    throw invalidTransition('会话已归档，不能为其选择模型；请在新会话或当前会话中选择。',
      { sessionId });
  }
  if (await repositories.assist.hasInflightMessages(session.id)) {
    throw invalidTransition('消息已经按当前会话模型排队或正在生成；请等它结束后再切换模型。',
      { sessionId: session.id });
  }
}

function selectionRevisionConflict(sessionId: string): DomainError {
  return invalidTransition('该会话的模型选择刚被其他命令改变；请重新读取当前选择后再决定。',
    { sessionId });
}

function connectionDisabledForSelection(name: string): DomainError {
  return new DomainError({
    code: 'MODEL_CONNECTION_DISABLED', status: 409,
    type: '/problems/model-connection-disabled', title: '模型连接已停用',
    detail: `连接「${name}」已停用，不能为会话选择；请先启用该连接，或选择其他模型。`,
    retryable: false, retryAction: 'REFRESH_AND_REDECIDE',
  });
}

function connectionCredentialMissing(name: string): DomainError {
  return new DomainError({
    code: 'MODEL_CONNECTION_CREDENTIAL_MISSING', status: 409,
    type: '/problems/model-connection-credential-missing', title: '模型连接缺少凭据',
    detail: `连接「${name}」在系统凭据库里没有可用凭据；`
      + '请先在设置里填写该连接的 API Key，再为会话选择。',
    retryable: false, retryAction: 'REFRESH_AND_REDECIDE',
  });
}

/** 只读当前会话选择（供 UI 与 GET 端点）：无选择行返回 undefined，前端据此显示沿用默认。 */
export async function readSessionModel(db: DbExecutor, input: {
  readonly workspaceId: string;
  readonly sessionId: string;
}): Promise<SessionModelSelectionResult | undefined> {
  const repositories = createRepositories(db);
  const session = await repositories.assist.readSession(input.sessionId);
  if (session === undefined || session.workspace_id !== input.workspaceId) {
    throw resourceNotFound('Assist session');
  }
  const row = await repositories.modelSelection.readForSession(input.sessionId);
  return row === undefined ? undefined : toSelectionResult(row);
}

function toSelectionResult(row: SessionModelSelectionRow): SessionModelSelectionResult {
  return {
    session_id: row.session_id,
    connection: row.connection,
    connection_id: row.connection_id,
    model: row.model,
    free_only: row.free_only,
    config_fingerprint: row.config_fingerprint,
    catalog_source: row.catalog_source,
    catalog_snapshot_seq: row.catalog_snapshot_seq === null
      ? null : toDecimalString(row.catalog_snapshot_seq),
    catalog_model_id: row.catalog_model_id,
    revision: toDecimalString(row.revision),
  };
}

/** 模型选择解析失败的类型化问题（会话选择与 Agent 成员模型配置共用同一口径）。 */
export function selectionRejected(rejection: ModelSelectionRejection): DomainError {
  if (rejection.code === 'MODEL_NOT_REGISTERED') {
    return new DomainError({
      code: 'MODEL_NOT_REGISTERED', status: 400,
      type: '/problems/model-not-registered', title: '模型未登记',
      detail: rejection.detail, retryable: false, retryAction: 'NONE',
    });
  }
  return new DomainError({
    code: 'MODEL_PAID_NOT_AVAILABLE', status: 409,
    type: '/problems/model-paid-not-available', title: '非免费型号不可选',
    detail: rejection.detail, retryable: false, retryAction: 'NONE',
  });
}

/** OpenRouter 聊天凭据缺失的类型化问题（会话选择与 Agent 成员模型配置共用）。 */
export function openRouterChatNotConfigured(): DomainError {
  return new DomainError({
    code: 'OPENROUTER_CHAT_NOT_CONFIGURED', status: 409,
    type: '/problems/openrouter-chat-not-configured', title: 'OpenRouter 聊天凭据未配置',
    detail: '目录存在严格免费型号，但需要在服务端配置独立凭据：RELAY_OPENROUTER_API_KEY'
      + '（缺省时回退系统环境变量 OPENROUTER_API_KEY）；默认模型和目录读取凭据不会用作聊天凭据。',
    retryable: false, retryAction: 'NONE',
  });
}
