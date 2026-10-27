import { randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import type { ModelConnectionRow } from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import { httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand, type CommandOutcome } from './command.js';
import { DomainError, resourceNotFound, revisionConflict } from './domain-error.js';
import { ModelConnectionNameTakenError,
  ModelConnectionRepository } from '../model/model-connection-repository.js';
import type { CredentialStore } from '../credentials/credential-store.js';
import { CredentialStoreError } from '../credentials/credential-store.js';
import { parseModelBaseUrl } from '../workflow/model-endpoint-policy.js';

/**
 * 模型连接登记用例（P2 阶段一，ADR-036）。
 *
 * 这一层是**唯一一处**业务判断，仓库只做 SQL：
 *   * 输入校验（名称、端点、型号、预算上下界与跨列关系）；
 *   * 凭据写入顺序（先落秘密、再落引用；落库失败要把刚写的秘密删掉，不留孤儿 blob）；
 *   * 轮换时覆盖**同一引用**下的秘密并把 `credential_version` 加一——版本是「凭据代数」，
 *     冻结在旧代上的调用据此发现凭据已换并安全停止；不换引用就没有孤儿文件要清理。
 *
 * 写命令走 `runIdempotentCommand`：回执与业务事实同事务提交，重放返回当时结果、
 * 相同 command_id 配不同载荷被拒绝。更新一律 revision CAS，不做 last-write-wins。
 *
 * 明确不做：不发外呼、不解析凭据、不写 `model_calls`、不参与模型解析。
 * 「连接能不能执行」是下一阶段（会话/Run 的冻结接线）；本轮只保证「登记是真实的」。
 */

export interface ModelConnectionBudget {
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
  readonly maxCallTokens: number;
  readonly maxScopeCalls: number;
  readonly maxScopeTokens: number;
}

export const DEFAULT_MODEL_CONNECTION_BUDGET: ModelConnectionBudget = {
  timeoutMs: 30_000,
  maxOutputTokens: 8_192,
  maxCallTokens: 65_536,
  maxScopeCalls: 32,
  maxScopeTokens: 262_144,
};

/** 与迁移 0143 的 CHECK 完全一致：能在 API 通过的值，不会被执行端以「配置非法」拒绝。 */
const BUDGET_BOUNDS = {
  timeoutMs: [1_000, 600_000],
  maxOutputTokens: [256, 65_536],
  maxCallTokens: [1_024, 1_048_576],
  maxScopeCalls: [1, 256],
  maxScopeTokens: [1_024, 2_000_000],
} as const satisfies Record<keyof ModelConnectionBudget, readonly [number, number]>;

export interface ModelConnectionView {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly providerKind: 'openai-compatible';
  readonly baseUrl: string | null;
  readonly defaultModel: string;
  readonly budget: ModelConnectionBudget;
  /** 凭据代数；不含引用、不含摘要。 */
  readonly credentialVersion: number;
  readonly status: 'ACTIVE' | 'DISABLED';
  readonly revision: bigint;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** 命令回执的返回体。与 `JsonObject` 相交是刻意的：回执会被序列化进 `command_receipts`。 */
export type ModelConnectionCommandResult = JsonObject & { readonly connection: JsonObject };

/**
 * 对外投影：**永不包含 `credential_ref`**。
 *
 * 引用本身不是秘密，但它是凭据库里的文件名；把它暴露给前端只会扩大可枚举面，
 * 而界面没有任何合法用途需要它。需要判断「凭据是否还在」时用专门的读取端点。
 */
export function toModelConnectionView(row: ModelConnectionRow): ModelConnectionView {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    providerKind: row.provider_kind,
    baseUrl: row.base_url,
    defaultModel: row.default_model,
    budget: {
      timeoutMs: row.timeout_ms,
      maxOutputTokens: row.max_output_tokens,
      maxCallTokens: row.max_call_tokens,
      maxScopeCalls: row.max_scope_calls,
      maxScopeTokens: row.max_scope_tokens,
    },
    credentialVersion: row.credential_version,
    status: row.status,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 命令回执里保存的 JSON 投影（日期转 ISO、revision 转字符串）。 */
export function toModelConnectionJson(view: ModelConnectionView): JsonObject {
  return {
    id: view.id,
    workspace_id: view.workspaceId,
    name: view.name,
    provider_kind: view.providerKind,
    base_url: view.baseUrl,
    default_model: view.defaultModel,
    budget: {
      timeout_ms: view.budget.timeoutMs,
      max_output_tokens: view.budget.maxOutputTokens,
      max_call_tokens: view.budget.maxCallTokens,
      max_scope_calls: view.budget.maxScopeCalls,
      max_scope_tokens: view.budget.maxScopeTokens,
    },
    credential_version: view.credentialVersion,
    status: view.status,
    revision: view.revision.toString(),
    created_at: view.createdAt.toISOString(),
    updated_at: view.updatedAt.toISOString(),
  };
}

type ModelConnectionField =
  | 'name' | 'base_url' | 'default_model' | 'api_key' | keyof ModelConnectionBudget;

function invalidConnection(issues: readonly { readonly field: ModelConnectionField;
  readonly message: string }[]): DomainError {
  return new DomainError({
    code: 'MODEL_CONNECTION_INVALID',
    status: 422,
    type: '/problems/model-connection-invalid',
    title: '模型连接配置无效',
    detail: issues.map((issue) => `${issue.field}: ${issue.message}`).join('; '),
    retryable: false,
    retryAction: 'NONE',
    fieldErrors: issues.map((issue) => ({ field: issue.field, message: issue.message })),
  });
}

function nameTaken(name: string): DomainError {
  return new DomainError({
    code: 'MODEL_CONNECTION_NAME_TAKEN',
    status: 409,
    type: '/problems/model-connection-name-taken',
    title: '连接名称已被占用',
    detail: `工作区里已存在名为「${name}」的模型连接；名称用于区分「用的是哪条连接」，不能重复。`,
    retryable: false,
    retryAction: 'REFRESH_AND_REDECIDE',
  });
}

/**
 * 凭据存储不可用：这不是「用户填错了」，而是这台机器的凭据库出了问题。
 * 503 而不是 500，是因为重试有意义（例如 helper 被杀掉后恢复）。
 */
function credentialUnavailable(code: string): DomainError {
  return new DomainError({
    code: 'MODEL_CREDENTIAL_STORE_UNAVAILABLE',
    status: 503,
    type: '/problems/model-credential-store-unavailable',
    title: '凭据存储不可用',
    detail: `系统凭据库无法读写（${code}）；连接未创建、未修改。`,
    retryable: true,
    retryAction: 'CHECK_RECEIPT_THEN_RETRY',
  });
}

function validateName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0 || name.length > 60) {
    throw invalidConnection([{ field: 'name',
      message: 'must be 1-60 characters after trimming' }]);
  }
  return name;
}

function validateModel(raw: string): string {
  const model = raw.trim();
  if (model.length === 0 || model.length > 200) {
    throw invalidConnection([{ field: 'default_model', message: 'must be 1-200 characters' }]);
  }
  // 通配不能当「确切型号」登记：它会让「这条连接到底调哪个模型」无法回答。
  if (model.includes('*')) {
    throw invalidConnection([{ field: 'default_model',
      message: 'must be an exact model id, not a wildcard' }]);
  }
  return model;
}

function validateBaseUrl(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null || raw.trim() === '') return null;
  try {
    return parseModelBaseUrl(raw.trim());
  } catch {
    throw invalidConnection([{ field: 'base_url',
      message: 'must be an https URL with a public host and no credentials, query or fragment' }]);
  }
}

function validateBudget(input: Partial<ModelConnectionBudget> | undefined): ModelConnectionBudget {
  const merged: ModelConnectionBudget = { ...DEFAULT_MODEL_CONNECTION_BUDGET, ...input };
  const issues: { field: ModelConnectionField; message: string }[] = [];
  for (const field of Object.keys(BUDGET_BOUNDS) as (keyof ModelConnectionBudget)[]) {
    const value = merged[field];
    const [minimum, maximum] = BUDGET_BOUNDS[field];
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      issues.push({ field, message: `must be an integer in [${minimum}, ${maximum}]` });
    }
  }
  if (issues.length === 0) {
    if (merged.maxCallTokens < merged.maxOutputTokens) {
      issues.push({ field: 'maxCallTokens', message: 'must cover maxOutputTokens' });
    }
    if (merged.maxScopeTokens < merged.maxCallTokens) {
      issues.push({ field: 'maxScopeTokens', message: 'must cover maxCallTokens' });
    }
  }
  if (issues.length > 0) throw invalidConnection(issues);
  return merged;
}

/** 引用是凭据库里的文件名：生成时只含 `[A-Za-z0-9-]`，天然不会产生路径分隔符。 */
function newCredentialReference(): string {
  return `cred-${randomUUID().replaceAll('-', '')}`;
}

async function storeCredential(credentials: CredentialStore, reference: string,
  apiKey: string): Promise<void> {
  if (apiKey.trim() === '') {
    throw invalidConnection([{ field: 'api_key', message: 'must not be empty' }]);
  }
  try {
    await credentials.put(reference, apiKey.trim());
  } catch (error) {
    throw credentialUnavailable(error instanceof CredentialStoreError ? error.code : 'UNKNOWN');
  }
}

async function discardCredential(credentials: CredentialStore, reference: string): Promise<void> {
  try {
    await credentials.delete(reference);
  } catch {
    // 回滚删除失败不能盖掉原始错误（通常是「名称重复」）；孤儿 blob 可用 CLI 清理。
  }
}

export interface ModelConnectionDependencies {
  readonly db: DbExecutor;
  readonly credentials: CredentialStore;
}

export async function listModelConnections(db: DbExecutor, workspaceId: string):
Promise<readonly ModelConnectionView[]> {
  const rows = await new ModelConnectionRepository(db).list(workspaceId);
  return rows.map(toModelConnectionView);
}

export async function readModelConnection(db: DbExecutor, workspaceId: string, id: string):
Promise<ModelConnectionView | undefined> {
  const row = await new ModelConnectionRepository(db).read(workspaceId, id);
  return row === undefined ? undefined : toModelConnectionView(row);
}

/** 凭据是否还在库里。只回布尔，不回引用、不回摘要、不回长度。 */
export async function readModelConnectionCredentialPresence(
  dependencies: ModelConnectionDependencies,
  input: { readonly workspaceId: string; readonly id: string },
): Promise<boolean> {
  const current = await new ModelConnectionRepository(dependencies.db)
    .read(input.workspaceId, input.id);
  if (current === undefined) throw resourceNotFound('Model connection');
  try {
    return await dependencies.credentials.status(current.credential_ref);
  } catch (error) {
    throw credentialUnavailable(error instanceof CredentialStoreError ? error.code : 'UNKNOWN');
  }
}

export async function createModelConnectionCommand(
  dependencies: ModelConnectionDependencies,
  input: {
    readonly workspaceId: string;
    readonly commandId: string;
    readonly name: string;
    readonly baseUrl?: string | null | undefined;
    readonly defaultModel: string;
    readonly budget?: Partial<ModelConnectionBudget> | undefined;
    readonly apiKey: string;
  },
): Promise<CommandOutcome<ModelConnectionCommandResult>> {
  return runIdempotentCommand<ModelConnectionCommandResult>(dependencies.db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'CreateModelConnection',
    target: { workspace_id: input.workspaceId },
    // 载荷不含 api_key：回执摘要会随结果一起留在库里，秘密不能进摘要输入。
    body: { name: input.name, base_url: input.baseUrl ?? null,
      default_model: input.defaultModel, budget: input.budget ?? null },
    execute: async (repositories) => {
      const name = validateName(input.name);
      const defaultModel = validateModel(input.defaultModel);
      const baseUrl = validateBaseUrl(input.baseUrl);
      const budget = validateBudget(input.budget);
      const reference = newCredentialReference();

      // 先落秘密再落引用：反过来的话，落库成功而存储失败会留下「指向空气」的连接。
      await storeCredential(dependencies.credentials, reference, input.apiKey);
      try {
        const row = await repositories.modelConnections.create({
          id: randomUUID(), workspaceId: input.workspaceId, name, baseUrl, defaultModel,
          timeoutMs: budget.timeoutMs, maxOutputTokens: budget.maxOutputTokens,
          maxCallTokens: budget.maxCallTokens, maxScopeCalls: budget.maxScopeCalls,
          maxScopeTokens: budget.maxScopeTokens, credentialRef: reference,
        });
        return { connection: toModelConnectionJson(toModelConnectionView(row)) };
      } catch (error) {
        // 名称重复等落库失败：把刚写的秘密删掉，避免留下没人引用的 blob。
        await discardCredential(dependencies.credentials, reference);
        if (error instanceof ModelConnectionNameTakenError) throw nameTaken(error.connectionName);
        throw error;
      }
    },
  });
}

export async function updateModelConnectionCommand(
  dependencies: ModelConnectionDependencies,
  input: {
    readonly workspaceId: string;
    readonly commandId: string;
    readonly id: string;
    readonly expectedRevision: bigint;
    readonly name?: string | undefined;
    readonly baseUrl?: string | null | undefined;
    readonly defaultModel?: string | undefined;
    readonly budget?: Partial<ModelConnectionBudget> | undefined;
  },
): Promise<CommandOutcome<ModelConnectionCommandResult>> {
  return runIdempotentCommand<ModelConnectionCommandResult>(dependencies.db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'UpdateModelConnection',
    target: { workspace_id: input.workspaceId, connection_id: input.id },
    body: { expected_revision: input.expectedRevision.toString(),
      name: input.name ?? null, base_url: input.baseUrl ?? null,
      default_model: input.defaultModel ?? null, budget: input.budget ?? null },
    execute: async (repositories) => {
      const current = await repositories.modelConnections.read(input.workspaceId, input.id);
      if (current === undefined) throw resourceNotFound('Model connection');
      if (current.revision !== input.expectedRevision) {
        throw revisionConflict({ entityType: 'model_connection',
          expectedRevision: input.expectedRevision.toString(),
          actualRevision: current.revision.toString() });
      }
      const name = input.name === undefined ? undefined : validateName(input.name);
      const defaultModel = input.defaultModel === undefined
        ? undefined : validateModel(input.defaultModel);
      const baseUrl = input.baseUrl === undefined ? undefined : validateBaseUrl(input.baseUrl);
      // 预算按「合并后的整行」校验：只改一档也要与另两档自洽，判断点只留一处。
      const budget = input.budget === undefined ? undefined : validateBudget({
        timeoutMs: input.budget.timeoutMs ?? current.timeout_ms,
        maxOutputTokens: input.budget.maxOutputTokens ?? current.max_output_tokens,
        maxCallTokens: input.budget.maxCallTokens ?? current.max_call_tokens,
        maxScopeCalls: input.budget.maxScopeCalls ?? current.max_scope_calls,
        maxScopeTokens: input.budget.maxScopeTokens ?? current.max_scope_tokens,
      });

      let updated: ModelConnectionRow | undefined;
      try {
        updated = await repositories.modelConnections.update(input.workspaceId, input.id,
          input.expectedRevision, {
            ...(name === undefined ? {} : { name }),
            ...(baseUrl === undefined ? {} : { baseUrl }),
            ...(defaultModel === undefined ? {} : { defaultModel }),
            ...(budget === undefined ? {} : {
              timeoutMs: budget.timeoutMs, maxOutputTokens: budget.maxOutputTokens,
              maxCallTokens: budget.maxCallTokens, maxScopeCalls: budget.maxScopeCalls,
              maxScopeTokens: budget.maxScopeTokens,
            }),
          });
      } catch (error) {
        if (error instanceof ModelConnectionNameTakenError) throw nameTaken(error.connectionName);
        throw error;
      }
      if (updated === undefined) {
        const latest = await repositories.modelConnections.read(input.workspaceId, input.id);
        throw revisionConflict({ entityType: 'model_connection',
          expectedRevision: input.expectedRevision.toString(),
          actualRevision: (latest?.revision ?? 0n).toString() });
      }
      return { connection: toModelConnectionJson(toModelConnectionView(updated)) };
    },
  });
}

/**
 * 轮换凭据：覆盖**同一引用**下的秘密，并把 `credential_version` 加一。
 *
 * 为什么覆盖同一引用而不是换新引用：引用是凭据库里的文件名，换引用会留下一份没人引用的
 * 旧 blob（旧秘密仍在磁盘上），那才是真正的风险。代数变化由 `credential_version` 表达，
 * 冻结在旧代上的调用据此停止，而不是靠「找不到文件」这种含糊信号。
 */
export async function rotateModelConnectionCredentialCommand(
  dependencies: ModelConnectionDependencies,
  input: {
    readonly workspaceId: string;
    readonly commandId: string;
    readonly id: string;
    readonly expectedRevision: bigint;
    readonly apiKey: string;
  },
): Promise<CommandOutcome<ModelConnectionCommandResult>> {
  return runIdempotentCommand<ModelConnectionCommandResult>(dependencies.db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'RotateModelConnectionCredential',
    target: { workspace_id: input.workspaceId, connection_id: input.id },
    // 载荷不含 api_key：摘要会留在回执里。
    body: { expected_revision: input.expectedRevision.toString() },
    execute: async (repositories) => {
      const current = await repositories.modelConnections.read(input.workspaceId, input.id);
      if (current === undefined) throw resourceNotFound('Model connection');
      if (current.revision !== input.expectedRevision) {
        throw revisionConflict({ entityType: 'model_connection',
          expectedRevision: input.expectedRevision.toString(),
          actualRevision: current.revision.toString() });
      }
      await storeCredential(dependencies.credentials, current.credential_ref, input.apiKey);
      const updated = await repositories.modelConnections.rotateCredential(input.workspaceId,
        input.id, input.expectedRevision, current.credential_ref);
      if (updated === undefined) {
        // 事务内行已被锁住，理论上不会落空；真落空就按冲突返回，绝不假装成功。
        throw revisionConflict({ entityType: 'model_connection',
          expectedRevision: input.expectedRevision.toString(), actualRevision: 'unknown' });
      }
      return { connection: toModelConnectionJson(toModelConnectionView(updated)) };
    },
  });
}

export async function setModelConnectionStatusCommand(
  dependencies: { readonly db: DbExecutor },
  input: {
    readonly workspaceId: string;
    readonly commandId: string;
    readonly id: string;
    readonly expectedRevision: bigint;
    readonly status: 'ACTIVE' | 'DISABLED';
  },
): Promise<CommandOutcome<ModelConnectionCommandResult>> {
  return runIdempotentCommand<ModelConnectionCommandResult>(dependencies.db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'SetModelConnectionStatus',
    target: { workspace_id: input.workspaceId, connection_id: input.id },
    body: { expected_revision: input.expectedRevision.toString(), status: input.status },
    execute: async (repositories) => {
      const updated = await repositories.modelConnections.setStatus(input.workspaceId, input.id,
        input.expectedRevision, input.status);
      if (updated !== undefined) {
        return { connection: toModelConnectionJson(toModelConnectionView(updated)) };
      }
      const latest = await repositories.modelConnections.read(input.workspaceId, input.id);
      if (latest === undefined) throw resourceNotFound('Model connection');
      throw revisionConflict({ entityType: 'model_connection',
        expectedRevision: input.expectedRevision.toString(),
        actualRevision: latest.revision.toString() });
    },
  });
}

/** 工作区默认连接（0144）。只表达「新 Run 从哪条连接冻结」，不写回进程配置。 */
export async function readDefaultModelConnection(db: DbExecutor, workspaceId: string):
Promise<{ readonly connectionId: string; readonly revision: bigint } | undefined> {
  const row = await new ModelConnectionRepository(db).readDefault(workspaceId);
  return row === undefined ? undefined : { connectionId: row.connection_id, revision: row.revision };
}

export interface DefaultModelConnectionResult {
  readonly connection_id: string | null;
  readonly revision: string | null;
}

/**
 * 设置工作区默认连接。幂等：指向同一条连接时不推进 revision，重放同一 command_id 返回原结果。
 *
 * 只接受本工作区的连接——跨工作区的 ID 一律按「不存在」处理，避免用别人的凭据跑自己的任务。
 */
export async function setDefaultModelConnectionCommand(
  dependencies: { readonly db: DbExecutor },
  input: { readonly workspaceId: string; readonly commandId: string;
    readonly connectionId: string },
): Promise<CommandOutcome<DefaultModelConnectionResult & JsonObject>> {
  return runIdempotentCommand<DefaultModelConnectionResult & JsonObject>(dependencies.db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'SetDefaultModelConnection',
    target: { workspace_id: input.workspaceId, connection_id: input.connectionId },
    body: { connection_id: input.connectionId },
    execute: async (repositories) => {
      const updated = await repositories.modelConnections.setDefault(input.workspaceId,
        input.connectionId);
      if (updated === undefined) throw resourceNotFound('Model connection');
      return { connection_id: updated.connection_id, revision: updated.revision.toString() };
    },
  });
}
