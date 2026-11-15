import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import { httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand } from './command.js';
import { resourceNotFound, revisionConflict, validationFailed } from './domain-error.js';
import { requireWorkspace } from './guards.js';
import { requireRevision } from './revisions.js';
import { createRepositories } from './unit-of-work.js';
import { getRuntimeLogger } from '../infrastructure/runtime-log.js';
import { COMPACTION_THRESHOLD_RECOMMENDED, DEFAULT_COMPACTION_THRESHOLD_TOKENS,
  validateThreshold } from './assist-context-policy.js';
import { MEMORY_DEFAULTS, validateMemoryBudgetSettings,
  type MemoryBudgetSettings } from './memory-config.js';

/**
 * 工作区级记忆设置（0118 / 0125 / 0162）。
 *
 * 四个字段分成两类：
 *   * 三个开关（自动使用记忆、普通自动压缩、自动记住）决定「要不要做」；
 *   * 压缩阈值（0162）决定「历史涨到多少 tokens 时做」。
 *
 * 阈值存 `null` = 产品默认 350K，不是「关闭」。它与普通自动压缩开关互相独立：
 * 关掉开关只停止「到阈值就压」，溢出保护仍会在请求装不下时做安全压缩（由用例层判定）。
 *
 * 响应里附带默认值与推荐区间：界面不该把 350000 / 256000–400000 再抄一份常量，
 * 否则产品口径一改就出现「设置页和实际判定不一样」。
 */
export async function readMemorySettings(db: DbExecutor, workspaceId: string): Promise<JsonObject> {
  const r = createRepositories(db);
  await requireWorkspace(r, workspaceId);
  const settings = await r.information.readMemorySettings(workspaceId);
  return { workspace_id: workspaceId, recall_enabled: settings?.recall_enabled ?? true,
    automatic_compaction: settings?.automatic_compaction ?? true,
    auto_capture: settings?.auto_capture ?? true,
    compaction_threshold_tokens: settings?.compaction_threshold_tokens ?? null,
    compaction_threshold_default_tokens: DEFAULT_COMPACTION_THRESHOLD_TOKENS,
    compaction_threshold_recommended: { min: COMPACTION_THRESHOLD_RECOMMENDED.min,
      max: COMPACTION_THRESHOLD_RECOMMENDED.max },
    core_token_budget: settings?.core_token_budget ?? MEMORY_DEFAULTS.coreTokenBudget,
    retrieval_token_budget: settings?.retrieval_token_budget ?? MEMORY_DEFAULTS.retrievalTokenBudget,
    retrieval_top_k: settings?.retrieval_top_k ?? MEMORY_DEFAULTS.retrievalTopK,
    retrieval_mode: settings?.retrieval_mode ?? MEMORY_DEFAULTS.retrievalMode,
    auto_consolidate: settings?.auto_consolidate ?? MEMORY_DEFAULTS.autoConsolidate,
    consolidation_interval_hours: settings?.consolidation_interval_hours
      ?? MEMORY_DEFAULTS.consolidationIntervalHours,
    memory_stale_after_days: settings?.memory_stale_after_days
      ?? MEMORY_DEFAULTS.memoryStaleAfterDays,
    embedding_provider: settings?.embedding_provider ?? MEMORY_DEFAULTS.embeddingProvider,
    remote_embedding_allowed: settings?.remote_embedding_allowed
      ?? MEMORY_DEFAULTS.remoteEmbeddingAllowed,
    include_stale_in_recall: settings?.include_stale_in_recall
      ?? MEMORY_DEFAULTS.includeStaleInRecall,
    revision: (settings?.revision ?? 0n).toString() };
}

export async function setMemorySettings(db: DbExecutor, input: { workspaceId: string;
  commandId: string; expectedRevision: string; recallEnabled: boolean; automaticCompaction: boolean;
  autoCapture: boolean;
  /**
   * 0162：`undefined` = 保持当前已保存的阈值（旧客户端只发三个开关时不会把它清空）；
   * `null` = 恢复产品默认 350K；数字 = 保存该值（调用前先过 `validateThreshold`）。
   */
  compactionThresholdTokens?: number | null;
  /** 0164：未提供的预算/模式保持当前值，旧客户端不会把它们悄悄重置成默认。 */
  coreTokenBudget?: number; retrievalTokenBudget?: number; retrievalTopK?: number;
  retrievalMode?: 'LITERAL' | 'HYBRID'; autoConsolidate?: boolean;
  consolidationIntervalHours?: number; memoryStaleAfterDays?: number;
  embeddingProvider?: 'disabled' | 'openai-compatible'; remoteEmbeddingAllowed?: boolean;
  includeStaleInRecall?: boolean }) {
  const expected = requireRevision(input.expectedRevision, 'expected_revision');
  if (input.compactionThresholdTokens !== undefined) {
    const checked = validateThreshold(input.compactionThresholdTokens);
    if (!checked.ok) throw validationFailed([{ field: 'compaction_threshold_tokens',
      message: checked.message }]);
  }
  return runIdempotentCommand<JsonObject>(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'SetMemorySettings', target: { workspace_id: input.workspaceId },
    body: { expected_revision: expected.toString(), recall_enabled: input.recallEnabled,
      automatic_compaction: input.automaticCompaction, auto_capture: input.autoCapture,
      compaction_threshold_tokens: input.compactionThresholdTokens ?? null,
      core_token_budget: input.coreTokenBudget ?? null,
      retrieval_token_budget: input.retrievalTokenBudget ?? null,
      retrieval_top_k: input.retrievalTopK ?? null,
      retrieval_mode: input.retrievalMode ?? null,
      auto_consolidate: input.autoConsolidate ?? null,
      consolidation_interval_hours: input.consolidationIntervalHours ?? null,
      memory_stale_after_days: input.memoryStaleAfterDays ?? null,
      embedding_provider: input.embeddingProvider ?? null,
      remote_embedding_allowed: input.remoteEmbeddingAllowed ?? null,
      include_stale_in_recall: input.includeStaleInRecall ?? null },
    execute: async (r) => {
      if (await r.workspaces.lockAuthority(input.workspaceId, 'update') === undefined) throw resourceNotFound('Workspace');
      const prior = await r.receipts.findReceipt({ scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId });
      if (prior !== undefined) return prior.result_ref;
      const current = await r.information.readMemorySettings(input.workspaceId);
      if ((current?.revision ?? 0n) !== expected) throw revisionConflict({ entityType: 'MEMORY_SETTINGS',
        expectedRevision: expected.toString(), actualRevision: (current?.revision ?? 0n).toString() });
      // 「没提供」不等于「清空」：整行 CAS 写入必须保持用户已保存的阈值，
      // 否则一次只改开关的保存会把 300K 静默写回 350K。
      const threshold = input.compactionThresholdTokens === undefined
        ? current?.compaction_threshold_tokens ?? null
        : input.compactionThresholdTokens;
      const budgetInput: MemoryBudgetSettings = {
        coreTokenBudget: input.coreTokenBudget ?? current?.core_token_budget
          ?? MEMORY_DEFAULTS.coreTokenBudget,
        retrievalTokenBudget: input.retrievalTokenBudget ?? current?.retrieval_token_budget
          ?? MEMORY_DEFAULTS.retrievalTokenBudget,
        retrievalTopK: input.retrievalTopK ?? current?.retrieval_top_k
          ?? MEMORY_DEFAULTS.retrievalTopK,
        retrievalMode: input.retrievalMode ?? current?.retrieval_mode
          ?? MEMORY_DEFAULTS.retrievalMode,
        autoConsolidate: input.autoConsolidate ?? current?.auto_consolidate
          ?? MEMORY_DEFAULTS.autoConsolidate,
        consolidationIntervalHours: input.consolidationIntervalHours
          ?? current?.consolidation_interval_hours ?? MEMORY_DEFAULTS.consolidationIntervalHours,
        memoryStaleAfterDays: input.memoryStaleAfterDays ?? current?.memory_stale_after_days
          ?? MEMORY_DEFAULTS.memoryStaleAfterDays,
        embeddingProvider: input.embeddingProvider ?? current?.embedding_provider
          ?? MEMORY_DEFAULTS.embeddingProvider,
        remoteEmbeddingAllowed: input.remoteEmbeddingAllowed
          ?? current?.remote_embedding_allowed ?? MEMORY_DEFAULTS.remoteEmbeddingAllowed,
        includeStaleInRecall: input.includeStaleInRecall ?? current?.include_stale_in_recall
          ?? MEMORY_DEFAULTS.includeStaleInRecall,
      };
      const checked = validateMemoryBudgetSettings(budgetInput);
      if (!checked.ok) throw validationFailed([{ field: checked.field, message: checked.message }]);
      const saved = await r.information.setMemorySettings(input.workspaceId, input.recallEnabled,
        input.automaticCompaction, input.autoCapture, threshold, checked.value);
      if (threshold !== (current?.compaction_threshold_tokens ?? null) ||
          input.automaticCompaction !== (current?.automatic_compaction ?? true)) {
        // 只记配置事实，不记历史内容。阈值是用户偏好；窗口与该阈值的关系在压缩判定时再算。
        getRuntimeLogger('context-compaction').info('context_compaction_settings_updated', {
          workspace_id: input.workspaceId,
          configured_threshold_tokens: threshold,
          effective_default_threshold_tokens: DEFAULT_COMPACTION_THRESHOLD_TOKENS,
          automatic_compaction: input.automaticCompaction,
        });
      }
      return { workspace_id: input.workspaceId, recall_enabled: saved.recall_enabled,
        automatic_compaction: saved.automatic_compaction, auto_capture: saved.auto_capture,
        compaction_threshold_tokens: saved.compaction_threshold_tokens,
        core_token_budget: saved.core_token_budget,
        retrieval_token_budget: saved.retrieval_token_budget,
        retrieval_top_k: saved.retrieval_top_k, retrieval_mode: saved.retrieval_mode,
        auto_consolidate: saved.auto_consolidate,
        consolidation_interval_hours: saved.consolidation_interval_hours,
        memory_stale_after_days: saved.memory_stale_after_days,
        embedding_provider: saved.embedding_provider,
        remote_embedding_allowed: saved.remote_embedding_allowed,
        include_stale_in_recall: saved.include_stale_in_recall,
        revision: saved.revision.toString() };
    } });
}
