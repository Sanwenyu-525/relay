<script setup lang="ts">
import type { RelayContextBuild, RelayContextManifestDetail, RelayContextManifestSummary } from "../api/relayClient";

defineProps<{
  loading: boolean;
  detailLoading: boolean;
  error: string | null;
  build: RelayContextBuild | null;
  manifests: readonly RelayContextManifestSummary[];
  selectedId: string | null;
  detail: RelayContextManifestDetail | null;
}>();

const emit = defineEmits<{
  refresh: [];
  select: [manifestId: string];
}>();

const roleLabels = { MANDATORY: "必需", RELEVANT: "相关", STEP_SPECIFIC: "当前步骤" } as const;
const selectionLabels = { TITLE_MATCH: "标题字面命中", RECENT_SCOPE_FALLBACK: "同范围最近资料补位" } as const;
const exclusionLabels: Record<string, string> = {
  BUDGET_TRIMMED: "可选片段因预算裁剪",
  SOURCE_UNAVAILABLE: "已选择的可选来源正文不可用"
};
</script>

<template>
  <section class="surface-panel run-sources" data-testid="run-sources">
    <div class="section-heading-row">
      <h2>本次输入来源</h2>
      <button type="button" class="secondary-button" data-testid="run-sources-refresh" :disabled="loading || detailLoading" @click="emit('refresh')">重新读取来源</button>
    </div>
    <p class="helper-text">展示实际 Manifest 的输入版本与片段。来源被采用不表示它决定了模型结论；不展示隐藏思考。</p>
    <p v-if="loading" role="status">正在按当前权限读取来源…</p>
    <p v-if="error" class="action-error" role="alert">{{ error }}</p>
    <template v-if="!loading && !error">
      <p v-if="build?.status === 'NOT_STARTED'" class="helper-text" data-testid="run-sources-not-started">BUILD_CONTEXT 尚未开始，暂无 Manifest。</p>
      <p v-else-if="build?.status === 'RUNNING'" class="helper-text" role="status">BUILD_CONTEXT 正在进行，完成前不显示虚构来源。</p>
      <p v-else-if="build?.status === 'FAILED'" class="action-error" data-testid="run-sources-build-failed">
        上次构建失败：{{ build.message ?? build.reasonCode ?? "原因待查询" }}。没有为失败的构建伪造 Manifest。
      </p>
      <p v-if="manifests.length === 0 && build?.status === 'SUCCEEDED'" class="helper-text">构建记录已完成，但暂无可读取的 Manifest；请刷新核对。</p>
      <template v-if="manifests.length > 0">
        <label class="field" for="run-source-manifest"><span class="field-label">构建记录</span>
          <select id="run-source-manifest" :value="selectedId ?? ''" data-testid="run-source-manifest" :disabled="detailLoading"
            @change="emit('select', ($event.target as HTMLSelectElement).value)">
            <option v-for="manifest in manifests" :key="manifest.id" :value="manifest.id">{{ manifest.createdAt }} · {{ manifest.id }}</option>
          </select>
        </label>
        <p v-if="detailLoading" role="status">正在重新核对所选 Manifest 的读取权限…</p>
        <template v-else-if="detail">
          <p class="helper-text">Manifest {{ detail.id }} · {{ detail.createdAt }} · 摘要 {{ detail.manifestHash }}</p>
          <p class="helper-text">构建器 {{ detail.builderVersion }} · 模板 {{ detail.templateVersion }}<template v-if="detail.dependencies.profile"> · Profile {{ detail.dependencies.profile.id }} v{{ detail.dependencies.profile.version }} / {{ detail.dependencies.profile.digest }}</template><template v-if="detail.dependencies.skill"> · Skill {{ detail.dependencies.skill.id }} v{{ detail.dependencies.skill.version }} / {{ detail.dependencies.skill.digest }}</template></p>
          <p v-if="detail.dependencies.contractHash" class="helper-text">执行契约 {{ detail.dependencies.contractHash }}<template v-if="detail.dependencies.workflowVersion"> · Workflow v{{ detail.dependencies.workflowVersion }}</template><template v-if="detail.dependencies.executionConfigVersion"> · 执行配置 v{{ detail.dependencies.executionConfigVersion }}</template></p>
          <p v-if="detail.budget" class="helper-text">预算上限 {{ detail.budget.limitTokens }} tokens；预留 {{ detail.budget.reservedTokens }}<template v-if="detail.budget.requiredTokens !== null && detail.budget.selectedTokens !== null"> · 必需 {{ detail.budget.requiredTokens }} · 实际选入 {{ detail.budget.selectedTokens }}</template><template v-else> · 部分用量按当前权限隐藏</template>（{{ detail.budget.estimation }}）</p>
          <p v-else class="helper-text">此历史 Manifest 未记录预算明细。</p>
          <h3>已采用的可读片段</h3>
          <p v-if="detail.sources.length === 0" class="helper-text">当前没有可展示的片段。来源列表已按当前权限过滤。</p>
          <ol v-else class="run-source-list">
            <li v-for="source in detail.sources" :key="`${source.sourceRef}:${source.version}:${source.range.start}`">
              <strong>{{ roleLabels[source.role] }} · {{ source.kind }} · v{{ source.version }}</strong>
              <p class="helper-text">{{ source.sourceRef }} · UTF-8 字节范围 {{ source.range.start }}–{{ source.range.end }} · 片段摘要 {{ source.sha256 }} · 来源版本摘要 {{ source.sourceSha256 }}<template v-if="source.selectionReason"> · {{ selectionLabels[source.selectionReason] }}</template><template v-if="source.trust === 'UNTRUSTED_DATA'"> · 外部数据</template></p>
              <pre class="run-source-content">{{ source.content }}</pre>
            </li>
          </ol>
          <h3>合法排除与裁剪</h3>
          <p v-if="detail.exclusions.length === 0" class="helper-text">没有可展示的排除记录；这不表示其他范围内不存在资料。</p>
          <ul v-else class="run-source-list"><li v-for="(item, index) in detail.exclusions" :key="index">
            {{ exclusionLabels[item.reason] ?? "其他合法排除原因" }}<template v-if="item.sourceRef"> · {{ item.sourceRef }}</template>
          </li></ul>
        </template>
      </template>
    </template>
  </section>
</template>

<style scoped>
.run-sources h3 { margin: var(--relay-space-6) 0 var(--relay-space-3); font-size: var(--relay-font-size-section); }
.run-source-list { margin: var(--relay-space-3) 0 0; padding-left: var(--relay-space-6); }
.run-source-list li { padding: var(--relay-space-2) 0; overflow-wrap: anywhere; }
.run-source-content { padding: var(--relay-space-4); overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--relay-color-bg-canvas); border: var(--relay-border-width) solid var(--relay-color-border-separator); border-radius: var(--relay-radius-control); }
</style>
