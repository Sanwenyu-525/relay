<script setup lang="ts">
import type { SourceKind, SourceReference } from "../types";
import AppDialog from "./AppDialog.vue";

defineProps<{
  modelValue: boolean;
  source: SourceReference | null;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
}>();

const kindLabels: Record<SourceKind, string> = {
  "project-state": "项目状态",
  "task-list": "任务列表",
  artifact: "产物",
  verification: "验收",
  note: "资料",
  goal: "目标",
  "checker-registry": "检查器注册表",
  "review-record": "待审记录",
  evidence: "完成依据",
  "result-definition": "结果定义"
};
</script>

<template>
  <AppDialog
    :model-value="modelValue"
    :title="source ? `${source.title} ${source.version}` : '来源详情'"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <template v-if="source">
      <p class="eyebrow">只读来源详情 · 示例数据</p>
      <p class="source-detail-status" :class="`source-detail-status--${source.availability}`">
        {{ source.availability === 'available' ? '来源当前可读取' : '来源当前不可读取' }}
      </p>
      <p class="source-detail-copy">{{ source.excerpt }}</p>
      <dl class="detail-list">
        <div>
          <dt>来源类型</dt>
          <dd>{{ kindLabels[source.kind] }}</dd>
        </div>
        <div>
          <dt>版本</dt>
          <dd>{{ source.version }}</dd>
        </div>
        <div>
          <dt>标题</dt>
          <dd>{{ source.title }}</dd>
        </div>
      </dl>
      <p class="helper-text">此面板只展示获准的示例来源摘要，不包含模型私有推理；来源被引用也不表示它决定了某个结论。</p>
    </template>
  </AppDialog>
</template>