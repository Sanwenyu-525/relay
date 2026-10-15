import { createHash } from 'node:crypto';
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
export const DEFAULT_FAKE_SCENARIO = 'LEGAL';
const FAKE_SCENARIOS = [
    'LEGAL',
    'SCHEMA_INVALID',
    'MISSING_MATERIAL',
    'CHECKER_ERROR',
    'NO_CITATION',
    'SEMANTIC_UNSUPPORTED',
    'SEMANTIC_UNCERTAIN',
    'CITATION_MISSING_ONCE',
];
export function isFakeScenario(value) {
    return FAKE_SCENARIOS.includes(value);
}
export function buildContextFixture(input) {
    const fakeScenario = input.fakeScenario ?? DEFAULT_FAKE_SCENARIO;
    const payload = {
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
function correctionToJson(correction) {
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
