<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { RotateCcw } from "lucide-vue-next";
import AssistSourcePicker from "../components/AssistSourcePicker.vue";
import { describeLiveError } from "../lib/liveErrors";
import { liveClient, relayConnection } from "../lib/relayConnection";

type AssistTarget = {
  readonly kind: "PROJECT" | "TASK";
  readonly id: string;
  readonly title: string;
  readonly revision: string;
  readonly projectId: string | null;
  readonly executor: string | null;
};

const route = useRoute();
const kind = computed(() => route.name === "project-assist" ? "PROJECT" : "TASK");
const targetId = computed(() => String(route.params.id));
const live = computed(() => relayConnection.mode === "live");
const target = ref<AssistTarget | null>(null);
const selectedRefs = ref<readonly string[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
let requestVersion = 0;

async function loadTarget(): Promise<void> {
  const version = ++requestVersion;
  target.value = null;
  selectedRefs.value = [];
  error.value = null;
  loading.value = live.value;
  const client = liveClient();
  if (client === null) return;
  try {
    if (kind.value === "PROJECT") {
      const project = await client.getProject(targetId.value);
      if (version !== requestVersion) return;
      target.value = { kind: "PROJECT", id: project.id, title: project.title,
        revision: project.revision, projectId: project.id, executor: null };
    } else {
      const task = await client.getTask(targetId.value);
      if (version !== requestVersion) return;
      target.value = { kind: "TASK", id: task.id, title: task.title,
        revision: task.revision, projectId: task.projectId, executor: task.executor };
    }
  } catch (caught) {
    if (version === requestVersion) error.value = describeLiveError(caught).message;
  } finally {
    if (version === requestVersion) loading.value = false;
  }
}

watch([kind, targetId, () => relayConnection.client], () => { void loadTarget(); }, { immediate: true });
onBeforeUnmount(() => { requestVersion += 1; });
</script>

<template>
  <section v-if="loading" class="page-state" aria-live="polite"><p class="eyebrow">Assist</p><h1>正在核对对话目标</h1></section>
  <section v-else-if="!live" class="page-state" data-testid="assist-fixture-gap">
    <p class="eyebrow">Assist</p><h1>示例模式没有真实会话</h1>
    <p>连接本机 API 后才能读取项目或任务目标。此处不生成示例模型回复或提案。</p>
  </section>
  <section v-else-if="error" class="page-state page-state--error" role="alert">
    <p class="eyebrow">Assist</p><h1>暂时无法核对对话目标</h1><p>{{ error }}</p>
    <button class="secondary-button" type="button" @click="loadTarget"><RotateCcw aria-hidden="true" />重新读取</button>
  </section>
  <section v-else-if="target" class="skill-page" data-testid="assist-target">
    <p class="eyebrow">{{ target.kind === "PROJECT" ? "项目 Assist" : "任务 Assist" }} · {{ target.id }}</p>
    <h1>{{ target.title }}</h1>
    <p class="page-lede">当前目标修订 v{{ target.revision }}<template v-if="target.executor"> · 当前执行者 {{ target.executor }}</template></p>
    <p class="helper-text">消息目标固定为当前{{ target.kind === "PROJECT" ? "项目" : "任务" }}；切换目标后须重新读取会话与来源。Assist 建议不会自动修改业务事实。</p>
    <RouterLink class="text-link" :to="target.kind === 'PROJECT' ? `/projects/${target.id}/tasks` : `/tasks/${target.id}`">返回{{ target.kind === "PROJECT" ? "项目" : "任务" }}</RouterLink>
    <AssistSourcePicker v-if="target.projectId" :key="target.projectId" v-model:selected-refs="selectedRefs" :project-id="target.projectId" />
    <p v-else class="helper-text">无 Project 的任务不能从项目范围选择资料；来源入口须由服务端按范围单独确认。</p>
    <section class="surface-panel">
      <h2>会话与提案</h2>
      <p class="helper-text">真实 Assist 消息与类型化提案接口仍在接线；当前页面只核对目标与可见资料版本，不发起模型请求或业务写入。</p>
    </section>
  </section>
</template>
