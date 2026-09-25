import { createHash } from 'node:crypto';

import type { JsonObject } from '../infrastructure/json.js';
import { canonicalizeJson } from '../receipt/payload-hash.js';

/**
 * P05 的固定上下文 fixture（docs/architecture/runtime-context.md 第 3 节）。
 *
 * 这不是通用 Context Builder：它只按冻结契约与 Task 事实装配一份确定性的 Manifest payload，
 * 资料是固定占位。真正的范围校验、Mandatory/预算裁剪与来源版本追踪属 P11。
 * BUILD_CONTEXT 只装配与复核，绝不重写冻结契约。
 *
 * P06 追加：修正轮把失败证据作为输入装进 payload 的 `correction`，摘要随之变化，
 * 因此同一 Run 的每一轮都有独立的不可变 Manifest（(run_id, manifest_hash) 唯一不冲突）。
 */

export const CONTEXT_FIXTURE_BUILDER_VERSION = 'context-fixture-v1';

/**
 * Fake 场景：决定 FakeModelPort 的行为；它进入 payload 与摘要，从而可追溯。
 * P06 追加检查器故障、引用缺失、语义不支持/不确定与“只在第一轮缺引用”四种验证场景。
 */
export type FakeScenario =
  | 'LEGAL'
  | 'SCHEMA_INVALID'
  | 'MISSING_MATERIAL'
  | 'CHECKER_ERROR'
  | 'NO_CITATION'
  | 'SEMANTIC_UNSUPPORTED'
  | 'SEMANTIC_UNCERTAIN'
  | 'CITATION_MISSING_ONCE';

export const DEFAULT_FAKE_SCENARIO: FakeScenario = 'LEGAL';

const FAKE_SCENARIOS: readonly FakeScenario[] = [
  'LEGAL',
  'SCHEMA_INVALID',
  'MISSING_MATERIAL',
  'CHECKER_ERROR',
  'NO_CITATION',
  'SEMANTIC_UNSUPPORTED',
  'SEMANTIC_UNCERTAIN',
  'CITATION_MISSING_ONCE',
];

export function isFakeScenario(value: string): value is FakeScenario {
  return (FAKE_SCENARIOS as readonly string[]).includes(value);
}

/**
 * 修正轮输入（docs/architecture/runtime-context.md 第 6 节 Repair Contract 的最小形态）：
 * round 是已 finalize 为 RETRY 的 session 数；failures 是上一轮验证的失败证据。
 */
export interface ContextCorrectionInput {
  readonly round: number;
  readonly failures: readonly {
    readonly criterion_id: string;
    readonly result: string;
    readonly severity: string;
    readonly reason?: string | undefined;
  }[];
}

export interface ContextFixtureInput {
  readonly taskId: string;
  readonly taskTitle: string;
  /** 冻结契约快照（execution_contracts.frozen_snapshot）；原样嵌入，不做改写。 */
  readonly contractSnapshot: JsonObject;
  readonly fakeScenario?: FakeScenario | undefined;
  /** 修正轮（round ≥ 1）的失败证据；round 0 不提供，payload 因此不含 `correction`。 */
  readonly correction?: ContextCorrectionInput | undefined;
}

export interface ContextFixture {
  readonly builderVersion: string;
  readonly payload: JsonObject;
  readonly manifestHash: Buffer;
}

export function buildContextFixture(input: ContextFixtureInput): ContextFixture {
  const fakeScenario = input.fakeScenario ?? DEFAULT_FAKE_SCENARIO;

  const payload: JsonObject = {
    builder_version: CONTEXT_FIXTURE_BUILDER_VERSION,
    task: {
      id: input.taskId,
      title: input.taskTitle,
    },
    contract: input.contractSnapshot,
    material: {
      kind: 'FIXTURE',
      // 固定占位：P05 不读取真实资料，也不建立通用检索/裁剪管道。
      note: 'P05 固定占位资料；通用 Context Builder 与来源版本追踪属 P11。',
    },
    fake_scenario: fakeScenario,
    ...(input.correction === undefined ? {} : { correction: correctionToJson(input.correction) }),
  };

  const manifestHash = createHash('sha256')
    .update(canonicalizeJson(payload), 'utf8')
    .digest();

  return {
    builderVersion: CONTEXT_FIXTURE_BUILDER_VERSION,
    payload,
    manifestHash,
  };
}

/** payload 里的 correction 用稳定的 snake_case 键，且不写入 undefined（规范编码拒绝 undefined）。 */
function correctionToJson(correction: ContextCorrectionInput): JsonObject {
  return {
    round: correction.round,
    failures: correction.failures.map((failure) => ({
      criterion_id: failure.criterion_id,
      result: failure.result,
      severity: failure.severity,
      ...(failure.reason === undefined ? {} : { reason: failure.reason }),
    })),
  };
}
