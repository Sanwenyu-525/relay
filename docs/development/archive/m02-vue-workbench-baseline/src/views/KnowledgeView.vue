<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRoute } from "vue-router";
import ProjectNav from "../components/ProjectNav.vue";
import {
  createCommandId, RelayApiError, RelayTransportError,
  type RelayApiClient, type RelayCommandEnvelope, type RelayDecision,
  type RelayInformationKind, type RelayKnowledge, type RelayKnowledgeSource, type RelayKnowledgeVersion,
  type RelayMemory, type RelayMemoryRevision, type RelayRule, type RelayRuleEnforcement,
  type RelayRuleStrength, type RelayRuleVersion, type RelaySearchItem
} from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { liveClient, relayConnection } from "../lib/relayConnection";

type InformationRow = RelayKnowledge | RelayMemory | RelayDecision | RelayRule;
type Scope = "WORKSPACE" | "PROJECT" | "TASK";
interface PendingCommand {
  readonly id: string;
  readonly commandType: string;
  readonly resultKey: string;
  readonly targetId: string | null;
  readonly replacementId: string | null;
}

const route = useRoute();
const projectId = computed(() => typeof route.params.id === "string" ? route.params.id : null);
const live = computed(() => relayConnection.mode === "live");
const kind = ref<RelayInformationKind>("KNOWLEDGE");
const kinds: readonly { kind: RelayInformationKind; label: string }[] = [
  { kind: "KNOWLEDGE", label: "Knowledge 资料" },
  { kind: "MEMORY", label: "Memory 记忆" },
  { kind: "DECISION", label: "Decision 决定" },
  { kind: "RULE", label: "Rule 规则" }
];
const rows = ref<readonly InformationRow[]>([]);
const selectedId = ref<string | null>(null);
const selected = ref<InformationRow | null>(null);
const knowledgeVersions = ref<readonly RelayKnowledgeVersion[]>([]);
const memoryRevisions = ref<readonly RelayMemoryRevision[]>([]);
const ruleVersions = ref<readonly RelayRuleVersion[]>([]);
const loading = ref(false);
const refreshing = ref(false);
const submitting = ref(false);
const error = ref<string | null>(null);
const actionError = ref<string | null>(null);
const actionMessage = ref<string | null>(null);
const pendingCommand = ref<PendingCommand | null>(null);
let readVersion = 0;
let contextVersion = 0;

const query = ref("");
const searchItems = ref<readonly RelaySearchItem[]>([]);
const nextCursor = ref<string | null>(null);
const searching = ref(false);
const searchError = ref<string | null>(null);
let searchVersion = 0;
let searchTimer: ReturnType<typeof setTimeout> | null = null;

const formOpen = ref(false);
const revisionMode = ref(false);
const title = ref("");
const text = ref("");
const sourceKind = ref<RelayKnowledgeSource>("NOTE");
const artifactVersionId = ref("");
const mediaType = ref("text/plain");
const confirmed = ref(false);
const expiresAt = ref("");
const choice = ref("");
const rationale = ref("");
const alternatives = ref("");
const costs = ref("");
const replacementId = ref("");
const scope = ref<Scope>("WORKSPACE");
const scopeId = ref("");
const ruleKey = ref("");
const statement = ref("");
const strength = ref<RelayRuleStrength>("PREFERENCE");
const enforcement = ref<RelayRuleEnforcement>("HUMAN");
const method = ref("");
const targetSpec = ref("");

const selectedKnowledge = computed(() => kind.value === "KNOWLEDGE" ? selected.value as RelayKnowledge | null : null);
const selectedMemory = computed(() => kind.value === "MEMORY" ? selected.value as RelayMemory | null : null);
const selectedDecision = computed(() => kind.value === "DECISION" ? selected.value as RelayDecision | null : null);
const selectedRule = computed(() => kind.value === "RULE" ? selected.value as RelayRule | null : null);

function rowTitle(row: InformationRow): string {
  return "title" in row ? row.title : row.ruleKey;
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

function clearDraft(): void {
  title.value = ""; text.value = ""; sourceKind.value = "NOTE"; artifactVersionId.value = "";
  mediaType.value = "text/plain"; confirmed.value = false; expiresAt.value = "";
  choice.value = ""; rationale.value = ""; alternatives.value = ""; costs.value = "";
  replacementId.value = ""; scope.value = projectId.value === null ? "WORKSPACE" : "PROJECT";
  scopeId.value = ""; ruleKey.value = ""; statement.value = ""; strength.value = "PREFERENCE";
  enforcement.value = "HUMAN"; method.value = ""; targetSpec.value = "";
}

async function load(): Promise<void> {
  const version = ++readVersion;
  const client = liveClient();
  if (selected.value === null) loading.value = true;
  else refreshing.value = true;
  error.value = null;
  try {
    if (!live.value) {
      rows.value = []; selected.value = null;
      return;
    }
    if (client === null) throw new Error("本机 API 连接已失效，请重新连接。");
    const list = kind.value === "KNOWLEDGE" ? await client.getKnowledge(projectId.value)
      : kind.value === "MEMORY" ? await client.getMemories(projectId.value)
        : kind.value === "DECISION" ? await client.getDecisions(projectId.value)
          : await client.getRules(projectId.value);
    const id = selectedId.value ?? list[0]?.id ?? null;
    let detail: InformationRow | null = null;
    let versions: readonly RelayKnowledgeVersion[] = [];
    let revisions: readonly RelayMemoryRevision[] = [];
    let rules: readonly RelayRuleVersion[] = [];
    if (id !== null) {
      if (kind.value === "KNOWLEDGE") {
        [detail, versions] = await Promise.all([client.getKnowledgeDetail(id), client.getKnowledgeVersions(id)]);
      } else if (kind.value === "MEMORY") {
        [detail, revisions] = await Promise.all([client.getMemory(id), client.getMemoryRevisions(id)]);
      } else if (kind.value === "DECISION") {
        detail = await client.getDecision(id);
      } else {
        [detail, rules] = await Promise.all([client.getRule(id), client.getRuleVersions(id)]);
      }
    }
    if (version !== readVersion) return;
    rows.value = list;
    selectedId.value = id;
    selected.value = detail;
    knowledgeVersions.value = versions;
    memoryRevisions.value = revisions;
    ruleVersions.value = rules;
  } catch (caught) {
    if (version === readVersion) error.value = describeLiveError(caught).message;
  } finally {
    if (version === readVersion) { loading.value = false; refreshing.value = false; }
  }
}

function switchKind(next: RelayInformationKind): void {
  if (pendingCommand.value !== null || kind.value === next) return;
  kind.value = next;
  selectedId.value = null;
  selected.value = null;
  formOpen.value = false;
  actionError.value = null;
  actionMessage.value = null;
  clearDraft();
  void load();
}

function selectRow(id: string): void {
  if (pendingCommand.value !== null) return;
  selectedId.value = id;
  formOpen.value = false;
  actionError.value = null;
  void load();
}

function openForm(asRevision: boolean): void {
  if (pendingCommand.value !== null) return;
  clearDraft();
  revisionMode.value = asRevision;
  formOpen.value = true;
  actionError.value = null;
  if (asRevision && selectedMemory.value !== null) {
    title.value = selectedMemory.value.title;
    text.value = selectedMemory.value.text;
  }
  if (asRevision && selectedRule.value !== null) {
    ruleKey.value = selectedRule.value.ruleKey;
    statement.value = selectedRule.value.statement;
    strength.value = selectedRule.value.strength;
    enforcement.value = selectedRule.value.enforcement;
    method.value = selectedRule.value.method ?? "";
    targetSpec.value = JSON.stringify(selectedRule.value.targetSpec, null, 2);
  }
}

function scheduleSearch(): void {
  const version = ++searchVersion;
  if (searchTimer !== null) clearTimeout(searchTimer);
  searchItems.value = []; nextCursor.value = null; searchError.value = null;
  const q = query.value.trim();
  if (!live.value || q === "") { searching.value = false; return; }
  if (q.length > 200) { searchError.value = "搜索词不能超过 200 个字符。"; searching.value = false; return; }
  searching.value = true;
  searchTimer = setTimeout(() => { void runSearch(version, undefined); }, 250);
}

async function runSearch(version: number, cursor: string | undefined): Promise<void> {
  const client = liveClient();
  if (client === null || !live.value) return;
  searching.value = true;
  try {
    const page = await client.searchInformation({
      q: query.value.trim(), projectId: projectId.value,
      types: ["KNOWLEDGE", "MEMORY", "DECISION", "RULE"], limit: 20, cursor
    });
    if (version !== searchVersion) return;
    searchItems.value = cursor === undefined ? page.items : [...searchItems.value, ...page.items];
    nextCursor.value = page.nextCursor;
  } catch (caught) {
    if (version === searchVersion) searchError.value = describeLiveError(caught).message;
  } finally {
    if (version === searchVersion) searching.value = false;
  }
}

function openSearchItem(item: RelaySearchItem): void {
  if (pendingCommand.value !== null) return;
  kind.value = item.type;
  selected.value = null;
  formOpen.value = false;
  clearDraft();
  selectedId.value = item.id;
  void load();
}

function validResult(result: Readonly<Record<string, unknown>>, pending: PendingCommand): string | null {
  const id = result[pending.resultKey];
  if (typeof id !== "string" || id.length === 0 ||
    (pending.targetId !== null && id !== pending.targetId) ||
    typeof result.revision !== "string" || !/^\d+$/u.test(result.revision) ||
    typeof result.status !== "string") return null;
  if (pending.replacementId !== null && result.replacement_decision_id !== pending.replacementId) return null;
  if (["CreateKnowledge", "AddKnowledgeVersion", "CreateMemory", "AddMemoryRevision", "CreateDecision", "CreateRule", "AddRuleVersion"].includes(pending.commandType) &&
    (typeof result.version !== "string" || !/^\d+$/u.test(result.version))) return null;
  return id;
}

async function submit(
  commandType: string, resultKey: string, targetId: string | null,
  send: (client: RelayApiClient, commandId: string) => Promise<RelayCommandEnvelope>,
  replacement: string | null = null
): Promise<void> {
  const client = liveClient();
  if (client === null || submitting.value || pendingCommand.value !== null) return;
  const command: PendingCommand = { id: createCommandId(), commandType, resultKey, targetId, replacementId: replacement };
  const context = contextVersion;
  pendingCommand.value = command;
  submitting.value = true;
  actionError.value = null;
  actionMessage.value = null;
  try {
    const envelope = await send(client, command.id);
    if (context !== contextVersion) return;
    const id = envelope.commandId === command.id ? validResult(envelope.result, command) : null;
    if (id === null) throw new RelayTransportError("命令回执无法核对。");
    pendingCommand.value = null;
    selectedId.value = id;
    actionMessage.value = "命令已提交；正在读取服务端最新资料。";
    formOpen.value = false;
    await load();
  } catch (caught) {
    if (context !== contextVersion) return;
    if (caught instanceof RelayTransportError) {
      actionError.value = "响应丢失或无法核对。请只查询原 command_id 回执，不要换 ID 再提交。";
    } else {
      pendingCommand.value = null;
      actionError.value = describeLiveError(caught).message;
    }
  } finally {
    if (context === contextVersion) submitting.value = false;
  }
}

async function save(): Promise<void> {
  const id = selected.value?.id ?? null;
  const revision = selected.value?.revision;
  const titleValue = title.value.trim();
  const textValue = text.value.trim();
  actionError.value = null;
  if (kind.value === "KNOWLEDGE") {
    if ((!revisionMode.value && !titleValue) || (sourceKind.value === "ARTIFACT_VERSION" ? !artifactVersionId.value.trim() : !textValue)) {
      actionError.value = "请填写标题及当前来源所需的正文或产物版本 ID。"; return;
    }
    const source = sourceKind.value === "ARTIFACT_VERSION"
      ? { artifactVersionId: artifactVersionId.value.trim() }
      : { text: textValue, mediaType: mediaType.value.trim() || "text/plain" };
    if (revisionMode.value && id !== null && revision !== undefined) {
      await submit("AddKnowledgeVersion", "knowledge_id", id, (client, commandId) =>
        client.addKnowledgeVersion({ id, commandId, expectedRevision: revision, sourceKind: sourceKind.value, ...source }));
    } else {
      await submit("CreateKnowledge", "knowledge_id", null, (client, commandId) =>
        client.createKnowledge({ commandId, projectId: projectId.value, title: titleValue, sourceKind: sourceKind.value, ...source }));
    }
  } else if (kind.value === "MEMORY") {
    if (!titleValue || !textValue) { actionError.value = "请填写记忆标题与内容。"; return; }
    if (!confirmed.value) { actionError.value = "只有明确确认后才能保存 Memory。"; return; }
    const expiry = expiresAt.value.trim() || null;
    if (expiry !== null && Number.isNaN(Date.parse(expiry))) { actionError.value = "到期时间须为有效日期时间。"; return; }
    const expires = expiry === null ? null : new Date(expiry).toISOString();
    if (revisionMode.value && id !== null && revision !== undefined) {
      await submit("AddMemoryRevision", "memory_id", id, (client, commandId) =>
        client.addMemoryRevision({ id, commandId, expectedRevision: revision, title: titleValue,
          text: textValue, confirmed: true, expiresAt: expires }));
    } else {
      await submit("CreateMemory", "memory_id", null, (client, commandId) =>
        client.createMemory({ commandId, projectId: projectId.value, title: titleValue,
          text: textValue, confirmed: true, expiresAt: expires }));
    }
  } else if (kind.value === "DECISION") {
    if (!titleValue || !choice.value.trim() || !rationale.value.trim()) {
      actionError.value = "请填写决定标题、选择和依据。"; return;
    }
    await submit("CreateDecision", "decision_id", null, (client, commandId) =>
      client.createDecision({ commandId, projectId: projectId.value, title: titleValue,
        choice: choice.value.trim(), rationale: rationale.value.trim(),
        alternatives: splitLines(alternatives.value), costs: splitLines(costs.value) }));
  } else {
    if (!ruleKey.value.trim() || !statement.value.trim()) { actionError.value = "请填写规则键与陈述。"; return; }
    let spec: Record<string, unknown> | undefined;
    if (targetSpec.value.trim()) {
      try {
        const parsed: unknown = JSON.parse(targetSpec.value);
        if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") throw new Error();
        spec = parsed as Record<string, unknown>;
      } catch { actionError.value = "目标约束须是 JSON 对象。"; return; }
    }
    const config = { ruleKey: ruleKey.value.trim(), statement: statement.value.trim(),
      strength: strength.value, enforcement: enforcement.value,
      ...(method.value.trim() ? { method: method.value.trim() } : {}),
      ...(spec === undefined ? {} : { targetSpec: spec }) };
    if (revisionMode.value && id !== null && revision !== undefined) {
      await submit("AddRuleVersion", "rule_id", id, (client, commandId) =>
        client.addRuleVersion({ id, commandId, expectedRevision: revision, ...config }));
    } else {
      const client = liveClient();
      if (client === null) return;
      const resolvedScopeId = scope.value === "WORKSPACE" ? client.workspaceId
        : scope.value === "PROJECT" && projectId.value !== null ? projectId.value : scopeId.value.trim();
      if (!resolvedScopeId) { actionError.value = "请填写规则作用域 ID。"; return; }
      await submit("CreateRule", "rule_id", null, (api, commandId) =>
        api.createRule({ commandId, scope: scope.value, scopeId: resolvedScopeId, ...config }));
    }
  }
}

async function retire(): Promise<void> {
  const item = selected.value;
  if (item === null) return;
  if (kind.value === "KNOWLEDGE") {
    await submit("ArchiveKnowledge", "knowledge_id", item.id, (client, commandId) => client.archiveKnowledge(item.id, commandId, item.revision));
  } else if (kind.value === "MEMORY") {
    await submit("RetireMemory", "memory_id", item.id, (client, commandId) => client.retireMemory(item.id, commandId, item.revision));
  } else if (kind.value === "RULE") {
    await submit("RetireRule", "rule_id", item.id, (client, commandId) => client.retireRule(item.id, commandId, item.revision));
  }
}

async function supersede(): Promise<void> {
  const item = selectedDecision.value;
  const replacement = replacementId.value.trim();
  if (item === null || replacement === "" || replacement === item.id) {
    actionError.value = "请填写另一个已有 Decision 的 ID。"; return;
  }
  await submit("SupersedeDecision", "decision_id", item.id,
    (client, commandId) => client.supersedeDecision({ id: item.id, commandId,
      expectedRevision: item.revision, replacementDecisionId: replacement }), replacement);
}

async function checkReceipt(): Promise<void> {
  const pending = pendingCommand.value;
  const client = liveClient();
  if (pending === null || client === null || submitting.value) return;
  const context = contextVersion;
  submitting.value = true;
  try {
    const receipt = await client.getCommandReceipt(pending.id);
    if (context !== contextVersion) return;
    const id = receipt.commandId === pending.id && receipt.commandType === pending.commandType
      ? validResult(receipt.result, pending) : null;
    if (id === null) { actionError.value = "原命令回执类型或目标不匹配，结果仍未确定。请保留 command_id 核对。"; return; }
    pendingCommand.value = null;
    selectedId.value = id;
    actionError.value = null;
    actionMessage.value = "已核对原命令回执；正在读取最新资料。";
    formOpen.value = false;
    await load();
  } catch (caught) {
    if (context !== contextVersion) return;
    actionError.value = caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND"
      ? "暂未找到原命令回执。请稍后仍用同一个 command_id 核对。"
      : describeLiveError(caught).message;
  } finally {
    if (context === contextVersion) submitting.value = false;
  }
}

watch([projectId, () => relayConnection.client], () => {
  contextVersion += 1;
  readVersion += 1;
  searchVersion += 1;
  if (searchTimer !== null) clearTimeout(searchTimer);
  pendingCommand.value = null;
  selectedId.value = null;
  selected.value = null;
  rows.value = [];
  actionError.value = null;
  actionMessage.value = null;
  formOpen.value = false;
  clearDraft();
  scheduleSearch();
  void load();
}, { immediate: true });
watch(query, scheduleSearch);
watch(sourceKind, (next) => { if (next === "NOTE") mediaType.value = "text/plain"; });
onBeforeUnmount(() => {
  contextVersion += 1;
  readVersion += 1;
  searchVersion += 1;
  if (searchTimer !== null) clearTimeout(searchTimer);
});
</script>

<template>
  <section class="knowledge-page">
    <p class="eyebrow">{{ projectId ? "项目资料" : "工作空间资料" }}</p>
    <h1>知识与长期信息</h1>
    <p class="page-lede">资料、已确认记忆、决定和规则分别保存版本；搜索只查真实服务端事实。</p>
    <ProjectNav v-if="projectId" :project-id="projectId" active="knowledge" />

    <section v-if="!live" class="surface-panel" data-testid="knowledge-fixture-gap">
      <h2>示例模式未接入资料</h2>
      <p>此处不生成虚构的 Knowledge、Memory、Decision 或 Rule。连接本机 API 后可读取和管理真实资料。</p>
    </section>

    <template v-else>
      <section class="surface-panel" aria-label="资料搜索">
        <h2>有界搜索</h2>
        <label class="field" for="knowledge-search"><span class="field-label">搜索词</span>
          <span class="field-hint">按当前范围搜索四类资料，支持中文短词；每页最多 20 条。</span>
          <input id="knowledge-search" v-model="query" data-testid="knowledge-search" type="search" maxlength="200" autocomplete="off" />
        </label>
        <p v-if="searching" role="status">正在搜索…</p>
        <p v-if="searchError" class="action-error" role="alert">{{ searchError }}</p>
        <ul v-if="searchItems.length" class="knowledge-search-list">
          <li v-for="item in searchItems" :key="`${item.type}-${item.id}-${item.version}`">
            <button type="button" class="knowledge-result" :disabled="pendingCommand !== null" @click="openSearchItem(item)">
              <strong>{{ item.title }}</strong> · {{ item.type }} v{{ item.version }} · {{ item.status }}
              <span>{{ item.snippet }}</span>
              <small>匹配：{{ item.matchedFields.join("、") }} · 来源 {{ item.sourceRef }}</small>
            </button>
          </li>
        </ul>
        <p v-else-if="query.trim() && !searching && !searchError" class="helper-text">没有匹配的当前有效资料。</p>
        <button v-if="nextCursor" type="button" class="secondary-button" data-testid="knowledge-more" :disabled="searching" @click="runSearch(searchVersion, nextCursor)">加载下一页</button>
      </section>

      <nav class="knowledge-tabs" aria-label="资料类型">
        <button v-for="item in kinds" :key="item.kind" type="button" class="subnav-item"
          :class="{ 'subnav-item--active': kind === item.kind }" :aria-current="kind === item.kind ? 'page' : undefined"
          :disabled="pendingCommand !== null" :data-testid="`knowledge-tab-${item.kind}`" @click="switchKind(item.kind)">{{ item.label }}</button>
      </nav>
      <p v-if="error" class="action-error" role="alert">{{ error }} <button type="button" class="text-button" @click="load">重新读取</button></p>
      <p v-if="loading" role="status">正在读取资料…</p>
      <p v-if="refreshing" role="status">正在读取最新版本…</p>
      <p v-if="actionError" class="action-error" role="alert">{{ actionError }}</p>
      <p v-if="actionMessage" class="receipt-message" role="status">{{ actionMessage }}</p>
      <div v-if="pendingCommand" class="surface-panel" data-testid="knowledge-pending-receipt">
        <h2>提交结果待核对</h2>
        <p>原 command_id：{{ pendingCommand.id }}。查询原命令回执前不再次提交。</p>
        <button type="button" class="secondary-button" data-testid="knowledge-check-receipt" :disabled="submitting" @click="checkReceipt">核对原命令回执</button>
      </div>

      <div class="knowledge-columns">
        <section class="surface-panel knowledge-list">
          <div class="section-heading-row"><h2>{{ kinds.find((item) => item.kind === kind)?.label }}</h2>
            <button type="button" class="secondary-button" data-testid="knowledge-create" :disabled="pendingCommand !== null" @click="openForm(false)">新建</button></div>
          <p v-if="!loading && rows.length === 0" class="helper-text">当前范围还没有这类资料。</p>
          <button v-for="row in rows" :key="row.id" type="button" class="knowledge-row"
            :class="{ 'knowledge-row--active': row.id === selectedId }" :disabled="pendingCommand !== null"
            @click="selectRow(row.id)"><strong>{{ rowTitle(row) }}</strong><small>{{ row.status }} · v{{ row.revision }}</small></button>
        </section>

        <div class="knowledge-detail">
          <section v-if="selected" class="surface-panel">
            <div class="section-heading-row"><h2>{{ rowTitle(selected) }}</h2><span>{{ selected.status }} · 修订 v{{ selected.revision }}</span></div>
            <p class="helper-text">ID：{{ selected.id }} · 当前版本 v{{ selected.currentVersion }}</p>
            <p v-if="selectedKnowledge" class="helper-text">资料归属：{{ selectedKnowledge.projectId ?? "工作空间" }}</p>
            <template v-if="selectedMemory"><p class="knowledge-body">{{ selectedMemory.text }}</p>
              <p class="helper-text">明确确认：{{ selectedMemory.confirmedBy }} · {{ selectedMemory.confirmedAt }}<template v-if="selectedMemory.expiresAt"> · 到期 {{ selectedMemory.expiresAt }}</template></p></template>
            <template v-if="selectedDecision"><p class="knowledge-body">选择：{{ selectedDecision.choice }}</p>
              <p class="knowledge-body">依据：{{ selectedDecision.rationale }}</p>
              <p>备选：{{ selectedDecision.alternatives.join("、") || "未记录" }}</p><p>代价：{{ selectedDecision.costs.join("、") || "未记录" }}</p>
              <p v-if="selectedDecision.supersededById" data-testid="decision-supersession">已由 Decision {{ selectedDecision.supersededById }} 替代；旧决定保留可查。</p></template>
            <template v-if="selectedRule"><p class="knowledge-body">{{ selectedRule.statement }}</p>
              <p>{{ selectedRule.strength }} · {{ selectedRule.scope }} / {{ selectedRule.scopeId }} · {{ selectedRule.applicability }}</p>
              <p>执行检查：{{ selectedRule.enforcement }}<template v-if="selectedRule.method"> · {{ selectedRule.method }}</template></p>
              <p class="helper-text">目标约束：{{ JSON.stringify(selectedRule.targetSpec) }}</p></template>

            <div class="knowledge-actions" v-if="selected.status === 'ACTIVE' && pendingCommand === null">
              <button v-if="kind !== 'DECISION'" type="button" class="secondary-button" data-testid="knowledge-new-version" @click="openForm(true)">追加新版本</button>
              <button v-if="kind === 'KNOWLEDGE'" type="button" class="danger-button" @click="retire">归档资料</button>
              <button v-if="kind === 'MEMORY' || kind === 'RULE'" type="button" class="danger-button" @click="retire">停用{{ kind === 'MEMORY' ? '记忆' : '规则' }}</button>
            </div>
            <template v-if="selectedDecision && selectedDecision.status === 'ACTIVE' && pendingCommand === null">
              <label class="field" for="decision-replacement"><span class="field-label">替代它的 Decision ID</span>
                <input id="decision-replacement" v-model="replacementId" data-testid="decision-replacement" /></label>
              <button type="button" class="secondary-button" data-testid="decision-supersede" @click="supersede">记录替代关系</button>
            </template>

            <section v-if="selectedKnowledge" class="knowledge-history"><h3>不可变资料版本</h3>
              <ol><li v-for="version in knowledgeVersions" :key="version.id">v{{ version.version }} · {{ version.sourceKind }} · {{ version.availability }}
                <p>{{ version.excerpt ?? "该版本引用受管产物，无内联摘录。" }}</p><small>摘要 {{ version.contentSha256 }}<template v-if="version.sourceRefs.artifact_version_id"> · 产物版本 {{ version.sourceRefs.artifact_version_id }}</template></small></li></ol></section>
            <section v-if="selectedMemory" class="knowledge-history"><h3>确认修订历史</h3>
              <ol><li v-for="revision in memoryRevisions" :key="revision.id">v{{ revision.version }} · {{ revision.title }} · {{ revision.confirmedBy }} 于 {{ revision.confirmedAt }}<p>{{ revision.text }}</p></li></ol></section>
            <section v-if="selectedRule" class="knowledge-history"><h3>规则版本历史</h3>
              <ol><li v-for="version in ruleVersions" :key="`${version.ruleId}-${version.version}`">v{{ version.version }} · {{ version.strength }} · {{ version.enforcement }} · {{ version.ruleKey }}<p>{{ version.statement }}</p></li></ol></section>
          </section>
          <section v-else-if="!loading" class="surface-panel"><p>选择一项资料查看详情与版本。</p></section>

          <form v-if="formOpen" class="surface-panel knowledge-form" data-testid="knowledge-form" @submit.prevent="save">
            <h2>{{ revisionMode ? "追加新版本" : `新建 ${kind}` }}</h2>
            <p v-if="revisionMode" class="helper-text">基于当前修订 v{{ selected?.revision }} 提交；旧版本不会被覆盖。</p>
            <label v-if="kind === 'MEMORY' || (kind !== 'RULE' && !revisionMode)" class="field"><span class="field-label">标题</span><input v-model="title" data-testid="knowledge-title" required :disabled="pendingCommand !== null" /></label>
            <template v-if="kind === 'KNOWLEDGE'">
              <label class="field"><span class="field-label">来源类型</span><select v-model="sourceKind" :disabled="pendingCommand !== null">
                <option value="NOTE">NOTE</option><option value="MANAGED_TEXT">MANAGED_TEXT</option><option value="ARTIFACT_VERSION">ARTIFACT_VERSION</option></select></label>
              <label v-if="sourceKind === 'ARTIFACT_VERSION'" class="field"><span class="field-label">产物版本 ID</span><input v-model="artifactVersionId" data-testid="knowledge-artifact-id" :disabled="pendingCommand !== null" /></label>
              <template v-else><label class="field"><span class="field-label">受管文本</span><textarea v-model="text" data-testid="knowledge-text" rows="6" :disabled="pendingCommand !== null" /></label>
                <label class="field"><span class="field-label">媒体类型</span><select v-model="mediaType" :disabled="pendingCommand !== null"><option value="text/plain">text/plain</option><option v-if="sourceKind === 'MANAGED_TEXT'" value="text/markdown">text/markdown</option></select></label></template>
            </template>
            <template v-if="kind === 'MEMORY'">
              <label class="field"><span class="field-label">需要长期保留的事实</span><textarea v-model="text" data-testid="memory-text" rows="6" :disabled="pendingCommand !== null" /></label>
              <label class="field"><span class="field-label">到期时间（可选）</span><input v-model="expiresAt" type="datetime-local" :disabled="pendingCommand !== null" /></label>
              <label class="knowledge-check"><input v-model="confirmed" type="checkbox" data-testid="memory-confirmed" :disabled="pendingCommand !== null" />我已核对并明确确认这条 Memory</label>
            </template>
            <template v-if="kind === 'DECISION'">
              <label class="field"><span class="field-label">做出的选择</span><textarea v-model="choice" rows="3" :disabled="pendingCommand !== null" /></label>
              <label class="field"><span class="field-label">依据</span><textarea v-model="rationale" rows="3" :disabled="pendingCommand !== null" /></label>
              <label class="field"><span class="field-label">备选方案（每行一项）</span><textarea v-model="alternatives" rows="3" :disabled="pendingCommand !== null" /></label>
              <label class="field"><span class="field-label">代价（每行一项）</span><textarea v-model="costs" rows="3" :disabled="pendingCommand !== null" /></label>
            </template>
            <template v-if="kind === 'RULE'">
              <template v-if="!revisionMode"><label class="field"><span class="field-label">作用域</span><select v-model="scope" :disabled="pendingCommand !== null"><option value="WORKSPACE">WORKSPACE</option><option value="PROJECT">PROJECT</option><option value="TASK">TASK</option></select></label>
                <label v-if="scope === 'TASK' || (scope === 'PROJECT' && !projectId)" class="field"><span class="field-label">作用域 ID</span><input v-model="scopeId" data-testid="rule-scope-id" :disabled="pendingCommand !== null" /></label></template>
              <label class="field"><span class="field-label">规则键</span><input v-model="ruleKey" :disabled="pendingCommand !== null" /></label>
              <label class="field"><span class="field-label">规则陈述</span><textarea v-model="statement" rows="4" :disabled="pendingCommand !== null" /></label>
              <label class="field"><span class="field-label">强度</span><select v-model="strength" data-testid="rule-strength" :disabled="pendingCommand !== null"><option value="PREFERENCE">PREFERENCE · 偏好</option><option value="HARD">HARD · 硬约束</option></select></label>
              <label class="field"><span class="field-label">执行检查路径</span><select v-model="enforcement" data-testid="rule-enforcement" :disabled="pendingCommand !== null"><option value="PRE_ACTION">PRE_ACTION</option><option value="POST_CHECK">POST_CHECK</option><option value="SEMANTIC">SEMANTIC</option><option value="HUMAN">HUMAN</option></select></label>
              <label class="field"><span class="field-label">检查方法</span><select v-model="method" :disabled="pendingCommand !== null">
                <option value="">未指定</option><option value="MARKDOWN_STRUCTURE">MARKDOWN_STRUCTURE</option>
                <option value="CITATION_EXISTS">CITATION_EXISTS</option><option value="SEMANTIC">SEMANTIC</option>
                <option value="HUMAN">HUMAN</option></select></label>
              <label class="field"><span class="field-label">目标约束 JSON（可选）</span><textarea v-model="targetSpec" rows="3" :disabled="pendingCommand !== null" /></label>
              <p class="field-hint">HARD 冲突或必需检查路径不可用时，服务端拒绝写入；不会把未检查的规则当作生效。</p>
            </template>
            <div class="knowledge-actions"><button type="submit" class="primary-button" data-testid="knowledge-save" :disabled="submitting || pendingCommand !== null || (kind === 'MEMORY' && !confirmed)">保存{{ revisionMode ? "新版本" : "" }}</button>
              <button type="button" class="secondary-button" :disabled="pendingCommand !== null" @click="formOpen = false">取消</button></div>
          </form>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.knowledge-page { max-width: var(--relay-layout-content-maxWidth); margin: 0 auto; padding: var(--relay-layout-main-padding); }
.knowledge-page h1 { margin: var(--relay-space-3) 0 var(--relay-space-4); font-size: var(--relay-font-size-page); }
.knowledge-tabs { display: flex; flex-wrap: wrap; gap: var(--relay-space-2); margin-top: var(--relay-space-6); }
.knowledge-tabs button { cursor: pointer; }
.knowledge-columns { display: grid; grid-template-columns: minmax(15rem, 0.35fr) minmax(0, 1fr); gap: var(--relay-space-6); }
.knowledge-list { align-self: start; }
.knowledge-row, .knowledge-result { display: flex; flex-direction: column; width: 100%; gap: var(--relay-space-2); padding: var(--relay-space-4); border: 0; border-bottom: var(--relay-border-width) solid var(--relay-color-border-separator); background: transparent; color: var(--relay-color-text-primary); text-align: left; cursor: pointer; overflow-wrap: anywhere; }
.knowledge-row:hover, .knowledge-result:hover { background: var(--relay-color-selection-hover); }
.knowledge-row--active { background: var(--relay-color-selection-bg); border-left: var(--relay-focus-width) solid var(--relay-color-action-primary); }
.knowledge-row small, .knowledge-result small { color: var(--relay-color-text-muted); }
.knowledge-detail { min-width: 0; }
.knowledge-body { white-space: pre-wrap; overflow-wrap: anywhere; }
.knowledge-actions { display: flex; flex-wrap: wrap; gap: var(--relay-space-3); margin-top: var(--relay-space-5); }
.knowledge-history { margin-top: var(--relay-space-6); border-top: var(--relay-border-width) solid var(--relay-color-border-separator); }
.knowledge-history li { padding: var(--relay-space-3) 0; overflow-wrap: anywhere; }
.knowledge-search-list { list-style: none; margin: var(--relay-space-4) 0; padding: 0; }
.knowledge-check { display: flex; align-items: center; gap: var(--relay-space-3); margin-top: var(--relay-space-5); }
@media (max-width: 60rem) { .knowledge-columns { grid-template-columns: 1fr; } }
</style>
