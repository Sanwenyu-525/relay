<script setup lang="ts">
/**
 * 行内片段渲染：只输出受支持的标签，且不使用 v-html。
 * 危险协议（javascript:、data: 等）在解析阶段就不会变成链接，这里只负责渲染。
 */
interface InlineSegment {
  readonly kind: "text" | "strong" | "em" | "code" | "link";
  readonly text: string;
  readonly href?: string;
}

defineProps<{ segments: readonly InlineSegment[] }>();
</script>

<template>
  <template v-for="(segment, index) in segments" :key="index">
    <strong v-if="segment.kind === 'strong'">{{ segment.text }}</strong>
    <em v-else-if="segment.kind === 'em'">{{ segment.text }}</em>
    <code v-else-if="segment.kind === 'code'">{{ segment.text }}</code>
    <a v-else-if="segment.kind === 'link'" :href="segment.href" rel="noreferrer noopener" target="_blank">{{ segment.text }}</a>
    <template v-else>{{ segment.text }}</template>
  </template>
</template>
