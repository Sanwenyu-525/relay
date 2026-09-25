<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import type { RelaySearchItem } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { liveClient, relayConnection } from "../lib/relayConnection";

const props = defineProps<{
  projectId: string;
  selectedRefs: readonly string[];
}>();
const emit = defineEmits<{ "update:selectedRefs": [refs: readonly string[]] }>();
const query = ref("");
const results = ref<readonly RelaySearchItem[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
let requestVersion = 0;

watch(query, () => {
  requestVersion += 1;
  results.value = [];
  loading.value = false;
  error.value = null;
});
watch([() => props.projectId, () => relayConnection.client], () => {
  requestVersion += 1;
  query.value = "";
  results.value = [];
  loading.value = false;
  error.value = null;
  emit("update:selectedRefs", []);
});
onBeforeUnmount(() => { requestVersion += 1; });

async function search(): Promise<void> {
  const client = liveClient();
  const text = query.value.trim();
  const projectId = props.projectId;
  const version = ++requestVersion;
  results.value = [];
  error.value = null;
  if (client === null) {
    error.value = "连接本机 API 后才能选择真实来源。";
    return;
  }
  if (text.length < 1 || text.length > 200) {
    error.value = "请输入 1–200 个字符的检索词。";
    return;
  }
  loading.value = true;
  try {
    const page = await client.searchInformation({
      q: text, projectId, types: ["KNOWLEDGE", "MEMORY", "DECISION"], limit: 20
    });
    if (version !== requestVersion || client !== liveClient() || projectId !== props.projectId) return;
    results.value = page.items.filter((item) =>
      (item.projectId === null || item.projectId === projectId) && item.type !== "RULE");
  } catch (caught) {
    if (version === requestVersion) error.value = describeLiveError(caught).message;
  } finally {
    if (version === requestVersion) loading.value = false;
  }
}

function toggle(sourceRef: string): void {
  const refs = new Set(props.selectedRefs);
  if (refs.has(sourceRef)) refs.delete(sourceRef);
  else refs.add(sourceRef);
  emit("update:selectedRefs", [...refs]);
}
</script>

<template>
  <section class="surface-panel" data-testid="assist-source-picker">
    <h2>本次显式选择的资料</h2>
    <p class="helper-text">只检索当前获准范围内的资料版本。选中项仅是本次请求的候选输入，不授予新的读取或写入权限。</p>
    <form class="form-actions" @submit.prevent="search">
      <label class="field" for="assist-source-query"><span class="field-label">检索词</span>
        <input id="assist-source-query" v-model="query" type="search" maxlength="200" autocomplete="off" />
      </label>
      <button class="secondary-button" type="submit" :disabled="loading || relayConnection.mode !== 'live'">查找来源</button>
    </form>
    <p v-if="loading" role="status">正在查找可选资料…</p>
    <p v-if="error" class="action-error" role="alert">{{ error }}</p>
    <p v-if="!loading && results.length === 0 && query.trim() !== '' && !error" class="helper-text">没有可见的匹配资料；不据此推断其他范围的资料数量。</p>
    <ul v-if="results.length > 0" class="assist-source-list">
      <li v-for="item in results" :key="item.sourceRef">
        <label class="assist-source-option">
          <input type="checkbox" :checked="selectedRefs.includes(item.sourceRef)" @change="toggle(item.sourceRef)" />
          <span><strong>{{ item.title }}</strong><small>{{ item.type }} · v{{ item.version }} · {{ item.sourceRef }}</small><small>{{ item.snippet }}</small></span>
        </label>
      </li>
    </ul>
    <p v-if="selectedRefs.length > 0" class="helper-text">已选择 {{ selectedRefs.length }} 个当前可见的资料版本；发送前仍须由服务端复核。</p>
  </section>
</template>

<style scoped>
.assist-source-list { margin: var(--relay-space-4) 0; padding-left: var(--relay-space-5); }
.assist-source-list li { padding: var(--relay-space-2) 0; }
.assist-source-option { display: flex; gap: var(--relay-space-3); align-items: flex-start; }
.assist-source-option span { display: grid; gap: var(--relay-space-1); overflow-wrap: anywhere; }
.assist-source-option small { color: var(--relay-color-text-secondary); }
</style>
