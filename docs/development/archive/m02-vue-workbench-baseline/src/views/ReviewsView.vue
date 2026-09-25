<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { RotateCcw } from "lucide-vue-next";
import {
  createCommandId,
  RelayApiError,
  RelayTransportError,
  type RelayReview,
  type RelayReviewDecision
} from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { liveClient, relayConnection } from "../lib/relayConnection";

const route = useRoute();
const router = useRouter();
const live = computed(() => relayConnection.mode === "live");
const reviews = ref<readonly RelayReview[]>([]);
const selected = ref<RelayReview | null>(null);
const loading = ref(true);
const refreshing = ref(false);
const submitting = ref(false);
const error = ref<string | null>(null);
const actionError = ref<string | null>(null);
const receiptMessage = ref<string | null>(null);
const feedback = ref("");
const retryBudget = ref(2);
const pendingCommand = ref<{ reviewId: string; commandId: string } | null>(null);
let requestVersion = 0;

const kindLabels: Record<RelayReview["kind"], string> = {
  CRITERION: "人工验收",
  RETRY_BUDGET: "修正预算",
  CHECKER_RETRY: "检查器重试",
  ACTION_APPROVAL: "动作批准",
  STATE_PROPOSAL: "项目状态提案"
};

const decisionLabels: Record<RelayReviewDecision, string> = {
  ACCEPT: "接受这项判断",
  REQUEST_CHANGES: "请求修改",
  SET_RETRY_BUDGET: "设置修正预算",
  RETRY_CHECKS: "重新运行检查",
  APPROVE: "批准这项动作",
  DENY: "拒绝这项请求"
};

const reasonLabels: Record<string, string> = {
  CORRECTION_BUDGET_EXHAUSTED: "修正预算已用尽，需要你决定是否增加上限。",
  CHECKER_UNAVAILABLE: "检查器持续不可用，需要你决定是否重新运行检查。",
  AWAITING_HUMAN_EVIDENCE: "必需验收条件需要你的判断。",
  UNCERTAIN_REQUIRES_HUMAN: "检查结果不确定，需要你判断这项验收条件。"
};

const fieldLabels: Record<string, string> = {
  artifact_version_id: "产物版本 ID",
  content_hash: "内容摘要",
  acceptance_revision: "验收版本",
  criterion_id: "验收条件 ID",
  session_id: "验证会话 ID",
  operation_id: "动作 ID",
  action_type: "动作类型",
  normalized_target: "动作目标",
  params_hash: "参数摘要",
  base_revision: "项目状态基线版本",
  typed_changes: "建议修改",
  check_plan_hash: "检查计划摘要"
};

const preview: RelayReview = {
  id: "sample-review",
  kind: "CRITERION",
  status: "OPEN",
  revision: "1",
  projectId: "sample-project",
  taskId: "sample-task",
  runId: "sample-run",
  reason: "需要你判断候选产物是否满足必需验收条件。",
  targetHash: "示例摘要",
  target: { artifact_version_id: "示例产物 v3", acceptance_revision: "2", criterion_id: "human-1" },
  evidence: { check_result: "自动检查无法代替人工判断" },
  effect: { on_accept: "保存人工判断后重新核对完成条件", on_request_changes: "按原验收契约继续修正" },
  allowedDecisions: ["ACCEPT", "REQUEST_CHANGES"],
  expiresAt: null,
  createdAt: "2026-09-23T00:00:00.000Z",
  decidedAt: null
};

const selectedId = computed(() => (typeof route.query.id === "string" ? route.query.id : null));
const selectedKind = computed(() => selected.value === null ? "" : kindLabels[selected.value.kind]);

function summary(review: RelayReview): string {
  const version = review.target.artifact_version_id;
  if (typeof version === "string") {
    return `产物版本 ${version}`;
  }
  const target = review.target.normalized_target;
  if (typeof target === "string") {
    return target;
  }
  return reasonText(review.reason);
}

function reasonText(reason: string): string {
  return reasonLabels[reason] ?? reason;
}

function displayValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function fieldLabel(key: string): string {
  return fieldLabels[key] ?? key.replaceAll("_", " ");
}

async function load(): Promise<void> {
  const version = ++requestVersion;
  const client = liveClient();
  if (selected.value === null) {
    loading.value = true;
  } else {
    refreshing.value = true;
  }
  error.value = null;
  try {
    if (!live.value) {
      reviews.value = [preview];
      selected.value = preview;
      return;
    }
    if (client === null) {
      throw new Error("本机 API 连接已失效，请重新连接后读取待审请求。");
    }
    const items = await client.getReviews();
    const previousId = selected.value?.id === "sample-review" ? null : selected.value?.id ?? null;
    const id = selectedId.value ?? previousId ?? items[0]?.id ?? null;
    const detail = id === null ? null : await client.getReview(id);
    if (version !== requestVersion) {
      return;
    }
    reviews.value = items;
    selected.value = detail;
    if (detail?.kind === "RETRY_BUDGET") {
      const currentLimit = Number(detail.evidence.limit);
      retryBudget.value = Number.isInteger(currentLimit) ? Math.min(6, currentLimit + 1) : 3;
    }
  } catch (caught) {
    if (version === requestVersion) {
      error.value = describeLiveError(caught).message;
    }
  } finally {
    if (version === requestVersion) {
      loading.value = false;
      refreshing.value = false;
    }
  }
}

watch([live, selectedId], () => { void load(); }, { immediate: true });
onBeforeUnmount(() => { requestVersion += 1; });

function selectReview(reviewId: string): void {
  actionError.value = null;
  receiptMessage.value = null;
  feedback.value = "";
  void router.push({ path: "/reviews", query: { id: reviewId } });
}

async function decide(decision: RelayReviewDecision): Promise<void> {
  const review = selected.value;
  const client = liveClient();
  if (!live.value || client === null || review === null || !review.allowedDecisions.includes(decision) || pendingCommand.value !== null || submitting.value) {
    return;
  }
  actionError.value = null;
  receiptMessage.value = null;
  const note = feedback.value.trim();
  if (decision === "REQUEST_CHANGES" && note === "") {
    actionError.value = "请求修改时请说明需要调整的内容。";
    return;
  }
  if (decision === "SET_RETRY_BUDGET" && (!Number.isInteger(retryBudget.value) || retryBudget.value < 1 || retryBudget.value > 6)) {
    actionError.value = "修正预算须为 1 到 6 之间的整数。";
    return;
  }
  const commandId = createCommandId();
  pendingCommand.value = { reviewId: review.id, commandId };
  submitting.value = true;
  try {
    await client.decideReview({
      reviewId: review.id,
      commandId,
      expectedRevision: review.revision,
      targetHash: review.targetHash,
      decision,
      ...(note === "" ? {} : { feedback: note }),
      ...(decision === "SET_RETRY_BUDGET" ? { retryBudget: retryBudget.value } : {})
    });
    pendingCommand.value = null;
    receiptMessage.value = "决定已保存。请查看最新状态；动作批准不表示动作已经执行。";
    await load();
  } catch (caught) {
    if (caught instanceof RelayTransportError) {
      actionError.value = "服务端响应未到达，提交结果待核对。请查询原命令回执，不要重新提交新命令。";
    } else {
      pendingCommand.value = null;
      actionError.value = describeLiveError(caught).message;
      if (caught instanceof RelayApiError && ["REVIEW_TARGET_CHANGED", "REVIEW_EXPIRED", "REVISION_CONFLICT"].includes(caught.problem.code)) {
        await load();
      }
    }
  } finally {
    submitting.value = false;
  }
}

async function checkReceipt(): Promise<void> {
  const pending = pendingCommand.value;
  const client = liveClient();
  if (pending === null || client === null || submitting.value) {
    return;
  }
  submitting.value = true;
  try {
    await client.getCommandReceipt(pending.commandId);
    pendingCommand.value = null;
    actionError.value = null;
    receiptMessage.value = "已找到原命令回执，正在读取最新待审状态。";
    await load();
  } catch (caught) {
    actionError.value = caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND"
      ? "尚未找到原命令回执，结果仍未确定。请稍后继续核对。"
      : describeLiveError(caught).message;
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <section class="review-page" data-testid="review-inbox">
    <header class="review-heading">
      <div>
        <p class="eyebrow">{{ live ? "真实待审" : "示例待审" }}</p>
        <h1>等待你的判断</h1>
        <p class="page-lede">每条请求都绑定确切对象与版本。保存判断后，执行与完成状态仍以服务端最新事实为准。</p>
      </div>
      <button class="secondary-button" type="button" :disabled="loading || refreshing" @click="load">
        <RotateCcw aria-hidden="true" />{{ refreshing ? "正在更新" : "刷新" }}
      </button>
    </header>

    <p v-if="!live" class="warning-callout">当前为只读示例。连接本机 API 后可处理真实 Review 请求。</p>
    <p v-if="error" class="action-error" role="alert">{{ error }}</p>
    <p v-if="loading" class="helper-text" role="status">正在读取待审请求…</p>
    <div v-else class="review-columns">
      <section class="review-list" aria-label="待审请求">
        <h2>待处理 <span>{{ reviews.length }}</span></h2>
        <p v-if="reviews.length === 0" class="helper-text">当前没有待处理请求。新的人工判断会在验证或动作准入需要时出现。</p>
        <button
          v-for="review in reviews"
          :key="review.id"
          class="review-list-item"
          :class="{ 'review-list-item--selected': selected?.id === review.id }"
          type="button"
          :aria-current="selected?.id === review.id ? 'true' : undefined"
          @click="selectReview(review.id)"
        >
          <strong>{{ kindLabels[review.kind] }}</strong>
          <span>{{ summary(review) }}</span>
          <small>请求 v{{ review.revision }} · {{ review.status === "OPEN" ? "待判断" : "已处理" }}</small>
        </button>
      </section>

      <article v-if="selected" class="review-detail">
        <div class="review-detail-heading">
          <div>
            <p class="eyebrow">{{ selectedKind }} · 请求 v{{ selected.revision }}</p>
            <h2>{{ reasonText(selected.reason) }}</h2>
          </div>
          <span class="status-chip" :class="selected.status === 'OPEN' ? 'status-chip--warning' : 'status-chip--neutral'">
            {{ selected.status === "OPEN" ? "待判断" : "已处理" }}
          </span>
        </div>
        <p class="helper-text">请求 ID：{{ selected.id }}</p>
        <p v-if="selected.expiresAt" class="helper-text">有效期至：{{ selected.expiresAt }}</p>
        <p v-if="selected.taskId && live"><RouterLink class="text-link" :to="`/tasks/${selected.taskId}`">查看关联任务</RouterLink></p>

        <section class="review-fact-section">
          <h3>绑定对象</h3>
          <dl class="review-facts">
            <div v-for="(value, key) in selected.target" :key="key">
              <dt>{{ fieldLabel(String(key)) }}</dt><dd>{{ displayValue(value) }}</dd>
            </div>
            <div><dt>请求目标摘要</dt><dd>{{ selected.targetHash }}</dd></div>
          </dl>
        </section>

        <section class="review-fact-section">
          <h3>判断依据</h3>
          <dl class="review-facts">
            <div v-for="(value, key) in selected.evidence" :key="key">
              <dt>{{ fieldLabel(String(key)) }}</dt><dd>{{ displayValue(value) }}</dd>
            </div>
          </dl>
        </section>

        <section class="review-fact-section">
          <h3>可能影响</h3>
          <dl class="review-facts">
            <div v-for="(value, key) in selected.effect" :key="key">
              <dt>{{ fieldLabel(String(key)) }}</dt><dd>{{ displayValue(value) }}</dd>
            </div>
          </dl>
        </section>

        <div v-if="selected.status === 'OPEN'" class="review-decision">
          <h3>作出决定</h3>
          <label class="field" for="review-feedback">
            <span class="field-label">说明</span>
            <span class="field-hint">请求修改时必填；其他决定可留空。</span>
            <textarea id="review-feedback" v-model="feedback" rows="3" :disabled="!live || submitting || pendingCommand !== null" />
          </label>
          <label v-if="selected.allowedDecisions.includes('SET_RETRY_BUDGET')" class="field" for="review-budget">
            <span class="field-label">新的修正预算</span>
            <span class="field-hint">填写 1 到 6 次；服务端会重新核对当前已用次数。</span>
            <input id="review-budget" v-model.number="retryBudget" type="number" min="1" max="6" step="1" :disabled="!live || submitting || pendingCommand !== null" />
          </label>
          <p v-if="actionError" class="action-error" role="alert">{{ actionError }}</p>
          <p v-if="receiptMessage" class="receipt-message" role="status">{{ receiptMessage }}</p>
          <button v-if="pendingCommand" class="secondary-button" type="button" data-testid="review-check-receipt" :disabled="submitting" @click="checkReceipt">
            核对原命令回执
          </button>
          <div v-else class="review-actions">
            <button
              v-for="decision in selected.allowedDecisions"
              :key="decision"
              :class="decision === 'DENY' || decision === 'REQUEST_CHANGES' ? 'secondary-button' : 'primary-button'"
              type="button"
              :data-testid="`review-decision-${decision}`"
              :disabled="!live || submitting"
              @click="decide(decision)"
            >{{ submitting ? "正在保存" : decisionLabels[decision] }}</button>
          </div>
          <p v-if="!live" class="disabled-reason">示例数据不提交决定。连接本机 API 后再操作。</p>
          <p v-else-if="selected.allowedDecisions.length === 0" class="disabled-reason">当前请求没有可用决定。请刷新核对有效性。</p>
        </div>
        <p v-else class="receipt-message" role="status">这条请求已有决定。历史判断保留；如需继续操作，请读取新的请求。</p>
      </article>
      <div v-else class="review-detail review-empty"><p>选择一条待审请求查看绑定对象、证据和可用决定。</p></div>
    </div>
  </section>
</template>

<style scoped>
.review-page { max-width: var(--relay-layout-content-maxWidth); margin: 0 auto; padding: var(--relay-layout-main-padding); }
.review-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--relay-space-6); }
.review-heading h1 { margin: var(--relay-space-3) 0 var(--relay-space-4); font-size: var(--relay-font-size-page); }
.review-columns { display: grid; grid-template-columns: minmax(15rem, 0.35fr) minmax(0, 1fr); gap: var(--relay-space-6); margin-top: var(--relay-layout-section-gap); }
.review-list { border-right: var(--relay-border-width) solid var(--relay-color-border-separator); padding-right: var(--relay-space-4); }
.review-list h2, .review-fact-section h3, .review-decision h3 { font-size: var(--relay-font-size-section); margin: 0 0 var(--relay-space-4); }
.review-list h2 span { color: var(--relay-color-text-muted); font-size: var(--relay-font-size-meta); }
.review-list-item { display: flex; flex-direction: column; width: 100%; gap: var(--relay-space-2); padding: var(--relay-space-4); background: transparent; border: 0; border-bottom: var(--relay-border-width) solid var(--relay-color-border-separator); color: var(--relay-color-text-primary); text-align: left; cursor: pointer; }
.review-list-item:hover { background: var(--relay-color-selection-hover); }
.review-list-item--selected { background: var(--relay-color-selection-bg); border-left: var(--relay-focus-width) solid var(--relay-color-action-primary); }
.review-list-item span { overflow-wrap: anywhere; }
.review-list-item small { color: var(--relay-color-text-muted); }
.review-detail { min-width: 0; }
.review-detail-heading { display: flex; justify-content: space-between; align-items: start; gap: var(--relay-space-4); }
.review-detail-heading h2 { margin: var(--relay-space-2) 0 var(--relay-space-4); font-size: var(--relay-font-size-section); }
.review-fact-section { margin-top: var(--relay-space-6); padding-top: var(--relay-space-5); border-top: var(--relay-border-width) solid var(--relay-color-border-separator); }
.review-facts { margin: 0; }
.review-facts > div { display: grid; grid-template-columns: minmax(7rem, 0.3fr) minmax(0, 1fr); gap: var(--relay-space-4); padding: var(--relay-space-2) 0; }
.review-facts dt { color: var(--relay-color-text-secondary); font-size: var(--relay-font-size-meta); }
.review-facts dd { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.review-decision { margin-top: var(--relay-space-6); padding-top: var(--relay-space-5); border-top: var(--relay-border-width) solid var(--relay-color-border-separator); }
.review-actions { display: flex; flex-wrap: wrap; gap: var(--relay-space-3); margin-top: var(--relay-space-5); }
.review-empty { color: var(--relay-color-text-secondary); }
@media (max-width: 60rem) { .review-columns { grid-template-columns: 1fr; } .review-list { border-right: 0; border-bottom: var(--relay-border-width) solid var(--relay-color-border-separator); padding-right: 0; padding-bottom: var(--relay-space-4); } }
</style>
