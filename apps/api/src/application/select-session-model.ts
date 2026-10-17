import type { DbExecutor } from '../infrastructure/database.js';
import type { SessionModelSelectionRow } from '../infrastructure/database-schema.js';
import {
  computeModelConfigFingerprint,
  readModelPortConfig,
  readOpenRouterModelPortConfig,
  type ModelPortConfig,
} from '../workflow/model-port-config.js';
import { ConfigError } from '../config/config.js';
import { toDecimalString } from '../shared/decimal.js';
import { httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand, type CommandOutcome } from './command.js';
import { DomainError, invalidTransition, resourceNotFound } from './domain-error.js';
import {
  resolveModelSelection,
  type ModelSelectionRejection,
} from './model-selection-resolve.js';
import { createRepositories } from './unit-of-work.js';

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
 *     解析凭据与固定官方端点，落库非密钥指纹；
 *   * 目录外的型号 / 收费型号 → 类型化拒绝，绝不悄悄接成一次外呼或换型号（FM-05/FM-06）。
 *
 * env / now 可注入，供无凭据、可控时钟的隔离验证；生产缺省读 process。
 */

export type SessionModelSelectionResult = {
  readonly session_id: string;
  readonly connection: 'default' | 'openrouter';
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
      const session = await repositories.assist.readSession(input.sessionId, true);
      if (session === undefined || session.workspace_id !== input.workspaceId) {
        throw resourceNotFound('Assist session');
      }
      if (session.status !== 'ACTIVE') {
        throw invalidTransition('会话已归档，不能为其选择模型；请在新会话或当前会话中选择。',
          { sessionId: input.sessionId });
      }
      if (await repositories.assist.hasInflightMessages(session.id)) {
        throw invalidTransition('消息已经按当前会话模型排队或正在生成；请等它结束后再切换模型。',
          { sessionId: session.id });
      }

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
      if (applied === null) {
        throw invalidTransition('该会话的模型选择刚被其他命令改变；请重新读取当前选择后再决定。',
          { sessionId: input.sessionId });
      }
      return toSelectionResult(applied);
    },
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

function selectionRejected(rejection: ModelSelectionRejection): DomainError {
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

function openRouterChatNotConfigured(): DomainError {
  return new DomainError({
    code: 'OPENROUTER_CHAT_NOT_CONFIGURED', status: 409,
    type: '/problems/openrouter-chat-not-configured', title: 'OpenRouter 聊天凭据未配置',
    detail: '目录存在严格免费型号，但需要在服务端配置独立 RELAY_OPENROUTER_API_KEY；'
      + '默认模型和目录读取凭据不会用作聊天凭据。',
    retryable: false, retryAction: 'NONE',
  });
}
