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
