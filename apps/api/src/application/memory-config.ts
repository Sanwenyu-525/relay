/**
 * 记忆系统的集中配置默认值（0164）。
 *
 * 所有预算/间隔/模式只在这里定义一次；应用层、召回、整理与设置页都从这里取，
 * 不在各模块里散落魔法数字。环境变量只控制「是否允许启动自动整理」这类部署开关，
 * 用户可见的取值仍以工作区设置为准。
 */

export const MEMORY_DEFAULTS = {
  coreTokenBudget: 2000,
  retrievalTokenBudget: 3000,
  retrievalTopK: 5,
  retrievalMode: 'LITERAL' as const,
  autoConsolidate: true,
  consolidationIntervalHours: 24,
  memoryStaleAfterDays: 180,
  embeddingProvider: 'disabled' as const,
  remoteEmbeddingAllowed: false,
  includeStaleInRecall: false,
  /** 整理时每批处理的记忆条数：限制单次事务的工作量。 */
  maintenanceBatchSize: 50,
  /** 单条记忆正文上限（字节），与命令层 262144 的产品上限一致。 */
  maxTextBytes: 262144,
} as const;

export interface MemoryBudgetSettings {
  readonly coreTokenBudget: number;
  readonly retrievalTokenBudget: number;
  readonly retrievalTopK: number;
  readonly retrievalMode: 'LITERAL' | 'HYBRID';
  readonly autoConsolidate: boolean;
  readonly consolidationIntervalHours: number;
  readonly memoryStaleAfterDays: number;
  readonly embeddingProvider: 'disabled' | 'openai-compatible';
  readonly remoteEmbeddingAllowed: boolean;
  readonly includeStaleInRecall: boolean;
}

export function validateMemoryBudgetSettings(input: Partial<MemoryBudgetSettings>):
  { readonly ok: true; readonly value: MemoryBudgetSettings }
  | { readonly ok: false; readonly field: string; readonly message: string } {
  const core = input.coreTokenBudget ?? MEMORY_DEFAULTS.coreTokenBudget;
  if (!Number.isInteger(core) || core < 0 || core > 20000) {
    return { ok: false, field: 'core_token_budget', message: '必须是 0–20000 的整数' };
  }
  const retrieval = input.retrievalTokenBudget ?? MEMORY_DEFAULTS.retrievalTokenBudget;
  if (!Number.isInteger(retrieval) || retrieval < 0 || retrieval > 50000) {
    return { ok: false, field: 'retrieval_token_budget', message: '必须是 0–50000 的整数' };
  }
  const topK = input.retrievalTopK ?? MEMORY_DEFAULTS.retrievalTopK;
  if (!Number.isInteger(topK) || topK < 1 || topK > 20) {
    return { ok: false, field: 'retrieval_top_k', message: '必须是 1–20 的整数' };
  }
  const mode = input.retrievalMode ?? MEMORY_DEFAULTS.retrievalMode;
  if (mode !== 'LITERAL' && mode !== 'HYBRID') {
    return { ok: false, field: 'retrieval_mode', message: '只支持 LITERAL 或 HYBRID' };
  }
  const interval = input.consolidationIntervalHours ?? MEMORY_DEFAULTS.consolidationIntervalHours;
  if (!Number.isInteger(interval) || interval < 1 || interval > 720) {
    return { ok: false, field: 'consolidation_interval_hours', message: '必须是 1–720 的整数' };
  }
  const stale = input.memoryStaleAfterDays ?? MEMORY_DEFAULTS.memoryStaleAfterDays;
  if (!Number.isInteger(stale) || stale < 7 || stale > 3650) {
    return { ok: false, field: 'memory_stale_after_days', message: '必须是 7–3650 的整数' };
  }
  const provider = input.embeddingProvider ?? MEMORY_DEFAULTS.embeddingProvider;
  if (provider !== 'disabled' && provider !== 'openai-compatible') {
    return { ok: false, field: 'embedding_provider', message: '只支持 disabled 或 openai-compatible' };
  }
  return { ok: true, value: {
    coreTokenBudget: core, retrievalTokenBudget: retrieval, retrievalTopK: topK,
    retrievalMode: mode, autoConsolidate: input.autoConsolidate ?? MEMORY_DEFAULTS.autoConsolidate,
    consolidationIntervalHours: interval, memoryStaleAfterDays: stale,
    embeddingProvider: provider,
    remoteEmbeddingAllowed: input.remoteEmbeddingAllowed ?? MEMORY_DEFAULTS.remoteEmbeddingAllowed,
    includeStaleInRecall: input.includeStaleInRecall ?? MEMORY_DEFAULTS.includeStaleInRecall,
  } };
}
