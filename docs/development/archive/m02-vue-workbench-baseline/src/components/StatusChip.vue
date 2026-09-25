<script setup lang="ts">
import {
  Ban,
  CheckCircle2,
  Circle,
  CircleDashed,
  CircleSlash,
  Clock,
  Timer
} from "lucide-vue-next";
import { taskStatusLabels, taskStatusTone } from "../lib/labels";
import type { TaskStatus } from "../types";

defineProps<{ status: TaskStatus }>();

/** 工作状态同时用图标与文字表达，颜色只作辅助，不单独承载语义。 */
const icons = {
  INBOX: CircleDashed,
  READY: Circle,
  IN_PROGRESS: Timer,
  WAITING: Clock,
  BLOCKED: Ban,
  DONE: CheckCircle2,
  CANCELLED: CircleSlash
};
</script>

<template>
  <span class="status-chip" :class="`status-chip--${taskStatusTone(status)}`">
    <component :is="icons[status]" aria-hidden="true" />
    {{ taskStatusLabels[status] }}
  </span>
</template>
