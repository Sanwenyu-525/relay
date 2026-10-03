import { createHash } from 'node:crypto';

import type { JsonObject, JsonValue } from '../infrastructure/json.js';
import { canonicalizeJson } from '../receipt/payload-hash.js';
import { toDecimalString } from '../shared/decimal.js';
import {
  DEFAULT_EXECUTION_CONFIG_VERSION,
  WORKFLOW_KEY,
  WORKFLOW_VERSION,
} from './markdown-deliverable.js';

/**
 * 创建 Run 时冻结的执行契约（contracts/02-state-and-execution.md 第 3 节、
 * docs/database/physical-design-postgresql.md 第 2 节）。
 *
 * 契约一旦随 Run 冻结即不可变：BUILD_CONTEXT 只装配上下文，不重写这份快照。
 * 快照摘要用固定版本的规范 JSON 编码再算 SHA-256，禁止用 JSON.stringify 的键顺序，
 * 否则同一语义内容会得到不同摘要。
 */

export const CONTRACT_SOURCE_DELEGATE = 'DELEGATE';

/** 契约摘要使用的算法（与 command_receipts 的 payload_hash_algorithm 保持一致）。 */
export const CONTRACT_HASH_ALGORITHM = 'sha256';

export interface FrozenContractCriterion {
  readonly criterionId: string;
  readonly statement: string;
  readonly required: boolean;
  readonly method: string;
  readonly targetSpec: JsonObject;
  /** 显式检查器覆盖（HARD SEMANTIC 规则的真实语义检查器）。 */
  readonly checkerId?: string | undefined;
}

export interface FreezeExecutionContractInput {
  readonly taskId: string;
  readonly acceptanceRevision: bigint;
  readonly objective: string;
  readonly expectedOutputs: JsonObject;
  readonly criteria: readonly FrozenContractCriterion[];
  readonly ruleRevision?: bigint;
  readonly ruleRefs?: readonly JsonValue[];
  readonly workflowKey?: string | undefined;
  readonly workflowVersion?: string | undefined;
  readonly executionConfigVersion?: string | undefined;
  readonly mockGatewayAction?: MockGatewayActionIntent | undefined;
  readonly fileReadAction?: FileReadActionIntent | undefined;
  readonly webFetchAction?: WebFetchActionIntent | undefined;
  readonly fileWriteAction?: FileWriteActionIntent | undefined;
  readonly cliRunAction?: CliRunActionIntent | undefined;
  readonly contextSources?: readonly ContextSourceRef[] | undefined;
}

/** The optional fixed Mock tool intent is frozen before a Worker can prepare it. */
export interface MockGatewayActionIntent {
  readonly operation_id: string;
  readonly intent_key: 'mock-write-marker-v1';
  readonly connection_id: string;
  readonly resource_id: string;
  readonly target: string;
  readonly content: string;
}

/** The optional fixed Mock file-read intent is frozen before a Worker can prepare it. */
export interface FileReadActionIntent {
  readonly operation_id: string;
  readonly intent_key: 'mock-file-read-v1';
  readonly connection_id: string;
  readonly resource_id: string;
  readonly relative_target: string;
}

export interface FileWriteChangeIntent {
  readonly path: string;
  readonly action: 'CREATE' | 'MODIFY' | 'DELETE';
  readonly content?: string;
  readonly baselineSha256?: string;
  readonly targetSha256?: string;
}

/** A bounded, explicit files changeset attached to the original Run command. */
export interface FileWriteActionIntent {
  readonly operation_id: string;
  readonly intent_key: 'file-write-v1';
  readonly connection_id: string;
  readonly resource_id: string;
  readonly changes: readonly FileWriteChangeIntent[];
}

export function readFileWriteAction(snapshot: JsonObject): FileWriteActionIntent | undefined {
  const value = snapshot.file_write_action;
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('frozen Mock file write action is invalid');
  }
  const action = value as JsonObject;
  if (typeof action.operation_id !== 'string' || action.intent_key !== 'file-write-v1' ||
      typeof action.connection_id !== 'string' || typeof action.resource_id !== 'string' ||
      !Array.isArray(action.changes) || action.changes.length === 0 || action.changes.length > 16 ||
      action.changes.some((item) => typeof item !== 'object' || item === null || Array.isArray(item) ||
        typeof item.path !== 'string' || item.path === '' ||
        !['CREATE', 'MODIFY', 'DELETE'].includes(String(item.action)) ||
        (item.content !== undefined && typeof item.content !== 'string') ||
        (item.baselineSha256 !== undefined && typeof item.baselineSha256 !== 'string') ||
        (item.targetSha256 !== undefined && typeof item.targetSha256 !== 'string'))) {
    throw new Error('frozen Mock file write action is invalid');
  }
  return action as unknown as FileWriteActionIntent;
}

export function readFileReadAction(snapshot: JsonObject): FileReadActionIntent | undefined {
  const value = snapshot.file_read_action;
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('frozen Mock file read action is invalid');
  }
  const action = value as JsonObject;
  if (typeof action.operation_id !== 'string' || action.intent_key !== 'mock-file-read-v1' ||
      typeof action.connection_id !== 'string' || typeof action.resource_id !== 'string' ||
      typeof action.relative_target !== 'string' || action.relative_target === '' ||
      action.relative_target.includes('\u0000')) {
    throw new Error('frozen Mock file read action is invalid');
  }
  return action as unknown as FileReadActionIntent;
}

/** The optional fixed Mock web-read intent is frozen before a Worker can prepare it.
 * The URL is syntactic only; host binding and SSRF checks happen at Gateway prepare. */
export interface WebFetchActionIntent {
  readonly operation_id: string;
  readonly intent_key: 'mock-web-fetch-v1';
  readonly connection_id: string;
  readonly url: string;
}

export function readWebFetchAction(snapshot: JsonObject): WebFetchActionIntent | undefined {
  const value = snapshot.web_fetch_action;
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('frozen Mock web fetch action is invalid');
  }
  const action = value as JsonObject;
  if (typeof action.operation_id !== 'string' || action.intent_key !== 'mock-web-fetch-v1' ||
      typeof action.connection_id !== 'string' || typeof action.url !== 'string' ||
      action.url === '') {
    throw new Error('frozen Mock web fetch action is invalid');
  }
  return action as unknown as WebFetchActionIntent;
}

/** 统一读取冻结 Mock 意图的操作身份。 */
export function readMockActionOperationId(snapshot: JsonObject): string | undefined {
  return readMockGatewayAction(snapshot)?.operation_id ??
    readFileReadAction(snapshot)?.operation_id ?? readWebFetchAction(snapshot)?.operation_id ??
    readFileWriteAction(snapshot)?.operation_id;
}

/**
 * A bounded, real command execution frozen before a Worker can prepare it.
 * It runs through the same Gateway admission and the same per-action approval as a
 * file write; the executable is resolved by the CLI adapter, never by a shell string.
 */
export interface CliRunActionIntent {
  readonly operation_id: string;
  readonly intent_key: 'cli-run-v1';
  readonly connection_id: string;
  readonly resource_id: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly max_output_bytes?: number;
}

export function readCliRunAction(snapshot: JsonObject): CliRunActionIntent | undefined {
  const value = snapshot.cli_run_action;
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('frozen CLI run action is invalid');
  }
  const action = value as JsonObject;
  if (typeof action.operation_id !== 'string' || action.intent_key !== 'cli-run-v1' ||
      typeof action.connection_id !== 'string' || typeof action.resource_id !== 'string' ||
      typeof action.executable !== 'string' || action.executable.trim() === '' ||
      action.executable.includes('\u0000') || !Array.isArray(action.args) ||
      action.args.length === 0 || !action.args.every((item) => typeof item === 'string') ||
      action.args.some((item) => item.includes('\u0000')) ||
      (action.max_output_bytes !== undefined &&
        (typeof action.max_output_bytes !== 'number' || !Number.isInteger(action.max_output_bytes) ||
          action.max_output_bytes < 0 || action.max_output_bytes > 1048576))) {
    throw new Error('frozen CLI run action is invalid');
  }
  return action as unknown as CliRunActionIntent;
}

/** kind 同时区分读取组（READ/WEB，绑定 BUILD_CONTEXT）与写入组（其余，绑定 DRAFT）。 */
export type FrozenReadAction =
  | ({ readonly kind: 'READ' } & FileReadActionIntent)
  | ({ readonly kind: 'WEB' } & WebFetchActionIntent);

export type FrozenWriteAction =
  | ({ readonly kind: 'WRITE' } & MockGatewayActionIntent)
  | ({ kind: 'FILE_WRITE' } & FileWriteActionIntent)
  | ({ kind: 'CLI' } & CliRunActionIntent);

export type FrozenRunAction = FrozenReadAction | FrozenWriteAction;

export type FrozenRunActions = {
  readonly read?: FrozenReadAction | undefined;
  /** 写入链：真实场景是「文件变更 + 一次检查命令」；Fake 标记独占一项。 */
  readonly writes: readonly FrozenWriteAction[];
};

/**
 * Validates the frozen action set once, for every reader.
 *
 * A Run may read before its DRAFT and then, still before the candidate is published,
 * write the files and run one bounded check command. The Fake marker write stays
 * exclusive because it is a Mock capability, not a real project effect.
 */
export function readFrozenRunActions(snapshot: JsonObject): FrozenRunActions {
  const fileRead = readFileReadAction(snapshot);
  const web = readWebFetchAction(snapshot);
  if (fileRead !== undefined && web !== undefined) {
    throw new Error('frozen contract carries more than one read action');
  }
  const marker = readMockGatewayAction(snapshot);
  const fileWrite = readFileWriteAction(snapshot);
  const cliRun = readCliRunAction(snapshot);
  if (marker !== undefined && (fileWrite !== undefined || cliRun !== undefined)) {
    throw new Error('frozen Mock marker write cannot be combined with a real write or check');
  }
  if (marker !== undefined && (fileRead !== undefined || web !== undefined)) {
    throw new Error('frozen Mock marker write cannot be combined with a read');
  }
  const read = fileRead !== undefined ? { kind: 'READ', ...fileRead } as const
    : web !== undefined ? { kind: 'WEB', ...web } as const : undefined;
  const writes: readonly FrozenWriteAction[] = marker !== undefined
    ? [{ kind: 'WRITE', ...marker }]
    : fileWrite !== undefined
      ? [{ kind: 'FILE_WRITE', ...fileWrite },
        ...(cliRun === undefined ? [] : [{ kind: 'CLI', ...cliRun } as const])]
      : cliRun === undefined ? [] : [{ kind: 'CLI', ...cliRun }];
  return { read, writes };
}

/**
 * Frozen operation identities in execution order: a read first, then the write or check.
 * A repeated delivery replays the same identities; it never creates a second operation.
 */
export function readFrozenActionOperationIds(snapshot: JsonObject): readonly string[] {
  const { read, writes } = readFrozenRunActions(snapshot);
  return [read?.operation_id, ...writes.map((write) => write.operation_id)]
    .filter((id): id is string => id !== undefined);
}

/** The single frozen action a Run contract still has to settle, in execution order. */
export function readFrozenActionOperationId(snapshot: JsonObject,
  settled: ReadonlySet<string>): string | undefined {
  return readFrozenActionOperationIds(snapshot).find((id) => !settled.has(id));
}

/** 用户在 Delegate 时显式选中的长期信息来源；版本随 Run 冻结，不可变。 */
export interface ContextSourceRef {
  readonly kind: 'KNOWLEDGE' | 'MEMORY' | 'DECISION';
  readonly root_id: string;
  readonly version: string;
}

const CONTEXT_SOURCE_KINDS: readonly string[] = ['KNOWLEDGE', 'MEMORY', 'DECISION'];

export function readContextSources(snapshot: JsonObject): readonly ContextSourceRef[] {
  const value = snapshot.context_sources;
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('frozen context sources are invalid');
  return value.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error('frozen context sources are invalid');
    }
    const source = entry as JsonObject;
    if (typeof source.kind !== 'string' || !CONTEXT_SOURCE_KINDS.includes(source.kind) ||
        typeof source.root_id !== 'string' || typeof source.version !== 'string' ||
        !/^[1-9][0-9]*$/u.test(source.version)) {
      throw new Error('frozen context sources are invalid');
    }
    return { kind: source.kind as ContextSourceRef['kind'],
      root_id: source.root_id, version: source.version };
  });
}

export function readMockGatewayAction(snapshot: JsonObject): MockGatewayActionIntent | undefined {
  const value = snapshot.mock_gateway_action;
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('frozen Mock Gateway action is invalid');
  }
  const action = value as JsonObject;
  if (typeof action.operation_id !== 'string' || action.intent_key !== 'mock-write-marker-v1' ||
      typeof action.connection_id !== 'string' || typeof action.resource_id !== 'string' ||
      typeof action.target !== 'string' || typeof action.content !== 'string') {
    throw new Error('frozen Mock Gateway action is invalid');
  }
  return action as unknown as MockGatewayActionIntent;
}

export interface FrozenExecutionContract {
  readonly workflowKey: string;
  readonly workflowVersion: string;
  readonly executionConfigVersion: string;
  /** 不可变快照，直接写入 execution_contracts.frozen_snapshot。 */
  readonly snapshot: JsonObject;
  readonly contractHash: Buffer;
}

/**
 * 从 Task 当前验收版本与 criteria 生成冻结快照与摘要。
 *
 * 只接受已经读取到的验收事实（objective/expected_outputs/criteria），不在本函数内查询数据库，
 * 因此 workflow 层不反向依赖应用协调器，也不自行决定“当前”验收版本。
 */
export function freezeExecutionContract(
  input: FreezeExecutionContractInput,
): FrozenExecutionContract {
  const workflowKey = input.workflowKey ?? WORKFLOW_KEY;
  const workflowVersion = input.workflowVersion ?? WORKFLOW_VERSION;
  const executionConfigVersion =
    input.executionConfigVersion ?? DEFAULT_EXECUTION_CONFIG_VERSION;

  const criteria: readonly JsonValue[] = input.criteria.map((criterion) => ({
    criterion_id: criterion.criterionId,
    statement: criterion.statement,
    required: criterion.required,
    method: criterion.method,
    target_spec: criterion.targetSpec,
    ...(criterion.checkerId === undefined ? {} : { checker_id: criterion.checkerId }),
  }));

  const snapshot: JsonObject = {
    source: CONTRACT_SOURCE_DELEGATE,
    task_id: input.taskId,
    acceptance_revision: toDecimalString(input.acceptanceRevision),
    objective: input.objective,
    expected_outputs: input.expectedOutputs,
    criteria,
    rule_revision: toDecimalString(input.ruleRevision ?? 0n),
    rule_refs: input.ruleRefs ?? [],
    workflow: {
      key: workflowKey,
      version: workflowVersion,
    },
    execution_config_version: executionConfigVersion,
    ...(input.mockGatewayAction === undefined ? {} : { mock_gateway_action: { ...input.mockGatewayAction } }),
    ...(input.fileReadAction === undefined ? {} : { file_read_action: { ...input.fileReadAction } }),
    ...(input.webFetchAction === undefined ? {} : { web_fetch_action: { ...input.webFetchAction } }),
    ...(input.fileWriteAction === undefined ? {} : { file_write_action: { ...input.fileWriteAction,
      changes: input.fileWriteAction.changes.map((change) => ({ ...change })) } }),
    ...(input.cliRunAction === undefined ? {} : { cli_run_action: { ...input.cliRunAction,
      args: [...input.cliRunAction.args] } }),
    ...(input.contextSources === undefined || input.contextSources.length === 0 ? {} :
      { context_sources: input.contextSources.map((source) => ({ ...source })) }),
  };

  const contractHash = createHash(CONTRACT_HASH_ALGORITHM)
    .update(canonicalizeJson(snapshot), 'utf8')
    .digest();

  return {
    workflowKey,
    workflowVersion,
    executionConfigVersion,
    snapshot,
    contractHash,
  };
}
