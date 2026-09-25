<script setup lang="ts">
import { computed, ref } from "vue";
import { Info, Link2, Unplug } from "lucide-vue-next";
import AppDialog from "./AppDialog.vue";
import { describeLiveError } from "../lib/liveErrors";
import { activateRelayConnection, relayConnection, useFixtureData } from "../lib/relayConnection";

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ "update:modelValue": [value: boolean] }>();

const baseUrl = ref("http://127.0.0.1:8787");
const workspaceId = ref("");
const bearerToken = ref("");
const checking = ref(false);
const failure = ref<string | null>(null);
const success = ref<string | null>(null);

const connected = computed(() => relayConnection.mode === "live");
const connectionLabel = computed(() => relayConnection.baseUrl ?? "");

function close(): void {
  emit("update:modelValue", false);
}

async function connect(): Promise<void> {
  if (checking.value) {
    return;
  }
  failure.value = null;
  success.value = null;
  checking.value = true;
  try {
    activateRelayConnection({
      baseUrl: baseUrl.value,
      workspaceId: workspaceId.value,
      bearerToken: bearerToken.value
    });
    const client = relayConnection.client;
    if (client === null) {
      failure.value = "连接未建立：请重新填写后重试。";
      return;
    }
    await client.getHealthReady();
    success.value = "已连接：/health/ready 返回 200，数据库与 schema 均匹配。";
    // 令牌只保留在内存客户端里，不再显示在表单上。
    bearerToken.value = "";
  } catch (caught) {
    // readiness 未通过时不能进入 live：服务存活不等于业务可用。
    useFixtureData();
    failure.value = describeLiveError(caught).message;
  } finally {
    checking.value = false;
  }
}

function disconnect(): void {
  useFixtureData();
  bearerToken.value = "";
  success.value = null;
  failure.value = "已断开：页面回到示例数据，内存中的凭据已清除。";
}
</script>

<template>
  <AppDialog :model-value="props.modelValue" title="连接本机 API" @update:model-value="emit('update:modelValue', $event)">
    <p class="helper-text">
      工作台默认使用示例数据。连接本机 API 后，创建项目、创建任务、开始任务等操作会写入真实 PostgreSQL。
    </p>

    <p v-if="connected" class="receipt-message" role="status" data-testid="relay-connection-state">
      已连接 {{ connectionLabel }}
    </p>
    <p v-else class="helper-text" data-testid="relay-connection-state">当前：示例数据（fixture），不调用任何 API。</p>

    <form class="create-form" novalidate @submit.prevent="connect">
      <label class="field">
        <span class="field-label">API 地址<span class="field-required" aria-hidden="true">*</span></span>
        <input v-model="baseUrl" name="relay-base-url" required autocomplete="off" />
        <span class="field-hint">只接受 http 或 https 的完整地址；本机 API 默认监听 http://127.0.0.1:8787。</span>
      </label>

      <label class="field">
        <span class="field-label">Workspace ID<span class="field-required" aria-hidden="true">*</span></span>
        <input v-model="workspaceId" name="relay-workspace-id" required autocomplete="off" />
        <span class="field-hint">由 apps/api 的 Workspace 初始化入口创建；未初始化时后端会按不可见处理。</span>
      </label>

      <label class="field">
        <span class="field-label">Bearer 令牌<span class="field-required" aria-hidden="true">*</span></span>
        <input
          v-model="bearerToken"
          name="relay-bearer-token"
          type="password"
          required
          autocomplete="off"
          :disabled="connected"
        />
        <span class="field-hint">
          与 apps/api/.env 的 RELAY_API_BEARER_TOKEN 一致。令牌只保存在当前页面内存，不写入浏览器存储、URL 或日志，刷新即清除。
        </span>
      </label>

      <div class="form-actions">
        <button class="primary-button" type="submit" data-testid="relay-connect" :disabled="checking">
          {{ checking ? "正在检查" : "连接并检查就绪" }}
        </button>
        <button v-if="connected" class="secondary-button" type="button" data-testid="relay-disconnect" @click="disconnect">
          <Unplug aria-hidden="true" />断开并回到示例数据
        </button>
        <button class="text-button" type="button" @click="close">关闭</button>
      </div>

      <p v-if="success" class="receipt-message" role="status">{{ success }}</p>
      <p v-if="failure" class="action-error" role="alert" data-testid="relay-connection-error">{{ failure }}</p>
      <p class="helper-text">
        <Info aria-hidden="true" />
        连接前请先启动本机 PostgreSQL、执行迁移入口与 Workspace 初始化；未通过 /health/ready 时工作台不会进入 live 模式。
      </p>
      <p class="helper-text">
        <Link2 aria-hidden="true" />
        真实 API 目前没有项目列表、归档、资料导入与四项 Skill 端点，这些入口在 live 模式下仍显示未接入。
      </p>
    </form>
  </AppDialog>
</template>
