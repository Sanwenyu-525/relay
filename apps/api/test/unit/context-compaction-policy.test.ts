import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COMPACTION_THRESHOLD_BOUNDS, COMPACTION_THRESHOLD_RECOMMENDED, CONTEXT_PROTOCOL_OVERHEAD_TOKENS,
  DEFAULT_COMPACTION_THRESHOLD_TOKENS, POST_COMPACTION_TARGET_TOKENS,
  decideContextCompaction, planContextCompaction, readCompactionAudit, validateThreshold,
} from '../../src/application/assist-context-policy.js';

/**
 * 0162 压缩策略的纯算术。
 *
 * 这里用**确定的 token 数字**做输入（不是字符串长度），断言的是产品口径本身：
 *   1M 目标窗口 → 默认 350K 触发；模型只有 256K 时按真实窗口收敛；
 *   用户 256K / 400K / 500K 的自定义值各自生效；未知窗口不冒充真实能力；
 *   关闭自动压缩后不再「到阈值就压」，但安全上限仍然拦得住（OVERFLOW）。
 */

const MIB = 1_048_576;
const OUTPUT = 8_192;
/** 1M 窗口：5% 安全预留 = ceil(52428.8) = 52429。 */
const SAFETY_1M = 52_429;
/** 256K 窗口：5% 安全预留 = ceil(13107.2) = 13108。 */
const SAFETY_256K = 13_108;

test('1M 目标窗口使用 350K 默认阈值，压缩后目标 100K', () => {
  const policy = planContextCompaction({ targetWindowTokens: MIB, modelWindowTokens: MIB,
    outputReserveTokens: OUTPUT, userThresholdTokens: null });
  assert.equal(policy.effectiveWindowTokens, MIB);
  assert.equal(policy.windowSource, 'MODEL_CATALOG');
  assert.equal(policy.outputReserveTokens, OUTPUT);
  assert.equal(policy.protocolOverheadTokens, CONTEXT_PROTOCOL_OVERHEAD_TOKENS);
  assert.equal(policy.safetyReserveTokens, SAFETY_1M);
  assert.equal(policy.safeInputTokens, MIB - OUTPUT - CONTEXT_PROTOCOL_OVERHEAD_TOKENS - SAFETY_1M);
  assert.equal(policy.requestedThresholdTokens, DEFAULT_COMPACTION_THRESHOLD_TOKENS);
  assert.equal(policy.effectiveThresholdTokens, 350_000);
  assert.equal(policy.thresholdClamped, false);
  assert.equal(policy.postCompactionTargetTokens, POST_COMPACTION_TARGET_TOKENS);
  assert.deepEqual(COMPACTION_THRESHOLD_RECOMMENDED, { min: 256_000, max: 400_000 });
});

test('模型只有 256K 窗口时按真实窗口收敛，不把默认 350K 当成装得下', () => {
  const policy = planContextCompaction({ targetWindowTokens: MIB, modelWindowTokens: 262_144,
    outputReserveTokens: OUTPUT, userThresholdTokens: null });
  assert.equal(policy.effectiveWindowTokens, 262_144);
  assert.equal(policy.safetyReserveTokens, SAFETY_256K);
  assert.equal(policy.safeInputTokens, 232_652);
  // 生效阈值 = min(350K, 安全输入上限的 90% = floor(232652*0.9) = 209386)；
  // 与硬上限留出 23266 tokens 的观察间隔。
  assert.equal(policy.effectiveThresholdTokens, 209_386);
  assert.equal(policy.thresholdClamped, true, '收敛必须可被界面识别，不能静默使用无效配置');
  // 压缩后目标取 min(100K, 生效阈值的一半)：209386/2 = 104693，仍高于 100K。
  assert.equal(policy.postCompactionTargetTokens, POST_COMPACTION_TARGET_TOKENS);
});

test('用户自定义 256K / 400K / 500K 在 1M 模型上都按原值生效', () => {
  for (const threshold of [256_000, 400_000, 500_000]) {
    const policy = planContextCompaction({ targetWindowTokens: MIB, modelWindowTokens: MIB,
      outputReserveTokens: OUTPUT, userThresholdTokens: threshold });
    assert.equal(policy.requestedThresholdTokens, threshold);
    assert.equal(policy.effectiveThresholdTokens, threshold, `${threshold} 应原样生效`);
    assert.equal(policy.thresholdClamped, false);
  }
});

test('用户阈值高于当前模型安全上限时收敛到安全上限', () => {
  const policy = planContextCompaction({ targetWindowTokens: MIB, modelWindowTokens: 262_144,
    outputReserveTokens: OUTPUT, userThresholdTokens: 500_000 });
  assert.equal(policy.requestedThresholdTokens, 500_000);
  assert.equal(policy.effectiveThresholdTokens, 209_386);
  assert.equal(policy.thresholdClamped, true);
});

test('未知窗口按会话档位估算，并如实标记 SESSION_TIER', () => {
  const policy = planContextCompaction({ targetWindowTokens: 262_144, modelWindowTokens: null,
    outputReserveTokens: OUTPUT, userThresholdTokens: null });
  assert.equal(policy.windowSource, 'SESSION_TIER');
  assert.equal(policy.modelWindowTokens, null);
  assert.equal(policy.effectiveWindowTokens, 262_144);
  assert.equal(policy.effectiveThresholdTokens, 209_386);
});

test('模型切换后生效阈值随真实窗口更新', () => {
  const same = { targetWindowTokens: 524_288, outputReserveTokens: OUTPUT,
    userThresholdTokens: 300_000 };
  const big = planContextCompaction({ ...same, modelWindowTokens: MIB });
  const small = planContextCompaction({ ...same, modelWindowTokens: 262_144 });
  assert.equal(big.effectiveThresholdTokens, 300_000);
  assert.ok(small.effectiveThresholdTokens < big.effectiveThresholdTokens);
  assert.equal(small.effectiveThresholdTokens, 209_386);
});

test('输出预留越大，安全输入上限与生效阈值同步下降', () => {
  const base = planContextCompaction({ targetWindowTokens: MIB, modelWindowTokens: MIB,
    outputReserveTokens: 8_192, userThresholdTokens: 900_000 });
  // 输出预留 131072：安全输入 = 1048576 - 131072 - 8192 - 52429 = 856883，低于 900K 的请求值。
  const larger = planContextCompaction({ targetWindowTokens: MIB, modelWindowTokens: MIB,
    outputReserveTokens: 131_072, userThresholdTokens: 900_000 });
  assert.ok(larger.safeInputTokens < base.safeInputTokens);
  assert.ok(larger.effectiveThresholdTokens < base.effectiveThresholdTokens);
});

test('低于 350K 不触发；达到 350K 触发；关闭自动压缩后只有溢出保护能触发', () => {
  const policy = planContextCompaction({ targetWindowTokens: MIB, modelWindowTokens: MIB,
    outputReserveTokens: OUTPUT, userThresholdTokens: null });
  assert.deepEqual(decideContextCompaction({ policy, tokens: 349_999, automaticCompaction: true }),
    { action: 'NONE', trigger: null, distanceTokens: 1, overflow: false });
  assert.deepEqual(decideContextCompaction({ policy, tokens: 350_000, automaticCompaction: true }),
    { action: 'COMPACT', trigger: 'THRESHOLD', distanceTokens: 0, overflow: false });
  // 关闭普通自动压缩：到阈值不再压，但安全上限仍然拦。
  assert.equal(decideContextCompaction({ policy, tokens: 350_000, automaticCompaction: false })
    .action, 'NONE');
  assert.deepEqual(decideContextCompaction({ policy, tokens: policy.safeInputTokens,
    automaticCompaction: false }),
  { action: 'COMPACT', trigger: 'OVERFLOW', distanceTokens: policy.effectiveThresholdTokens
    - policy.safeInputTokens, overflow: true });
  // 开启时也是溢出保护优先：它比阈值更需要立即处理。
  assert.equal(decideContextCompaction({ policy, tokens: policy.safeInputTokens,
    automaticCompaction: true }).trigger, 'OVERFLOW');
});

test('阈值校验拒绝明显无效的值，但保留「恢复默认」的空值', () => {
  assert.deepEqual(validateThreshold(null), { ok: true, value: null });
  assert.deepEqual(validateThreshold(256_000), { ok: true, value: 256_000 });
  assert.deepEqual(validateThreshold(COMPACTION_THRESHOLD_BOUNDS.max),
    { ok: true, value: COMPACTION_THRESHOLD_BOUNDS.max });
  for (const invalid of [0, -1, 1.5, COMPACTION_THRESHOLD_BOUNDS.min - 1,
    COMPACTION_THRESHOLD_BOUNDS.max + 1, '350000', Number.NaN]) {
    assert.equal(validateThreshold(invalid).ok, false, `${String(invalid)} 应被拒绝`);
  }
});

test('旧请求行没有触发元数据时按 reason 推回，不编造读数', () => {
  assert.deepEqual(readCompactionAudit({ reason: 'AUTO', model_snapshot: {} }),
    { trigger: 'THRESHOLD', tokensBefore: null, tokensAfter: null,
      thresholdTokens: null, windowTokens: null, safeInputTokens: null,
      postCompactionTargetTokens: null, model: null });
  assert.equal(readCompactionAudit({ reason: 'MANUAL', model_snapshot: {} }).trigger, 'MANUAL');
  const explicit = readCompactionAudit({ reason: 'AUTO', model_snapshot: { memory_compaction: {
    trigger: 'OVERFLOW', tokens_before: 980_000, tokens_after: 98_000,
    threshold_tokens: 350_000, window_tokens: 1_048_576,
    safe_input_tokens: 900_000, post_compaction_target_tokens: 100_000,
    model: 'deepseek-v4' } } });
  assert.deepEqual(explicit, { trigger: 'OVERFLOW', tokensBefore: 980_000,
    tokensAfter: 98_000, thresholdTokens: 350_000, windowTokens: 1_048_576,
    safeInputTokens: 900_000, postCompactionTargetTokens: 100_000, model: 'deepseek-v4' });
});

test('压后读数为 0 是合法结果，不被读成「没有读数」', () => {
  assert.equal(readCompactionAudit({ reason: 'MANUAL', model_snapshot: { memory_compaction: {
    tokens_after: 0 } } }).tokensAfter, 0);
  // 负数与小数不是读数，按缺失处理而不是取整。
  assert.equal(readCompactionAudit({ reason: 'MANUAL', model_snapshot: { memory_compaction: {
    tokens_after: -1 } } }).tokensAfter, null);
  assert.equal(readCompactionAudit({ reason: 'MANUAL', model_snapshot: { memory_compaction: {
    tokens_after: 1.5 } } }).tokensAfter, null);
});
