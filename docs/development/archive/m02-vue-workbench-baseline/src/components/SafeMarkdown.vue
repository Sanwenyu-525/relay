<script setup lang="ts">
import { computed } from "vue";
import SafeInline from "./SafeInline.vue";

/**
 * 安全 Markdown 预览：只渲染受支持的少量语法，并且**不使用 v-html**。
 *
 * 原文里的 HTML 标签、脚本、事件属性与危险协议都不会被解释：它们只会作为普通文本
 * 出现在插值里（Vue 默认转义），因此不会执行资料中的任何脚本。
 * 链接只对 http/https 生成 <a>；其他协议保留文本并标注未渲染。
 */

interface InlineSegment {
  readonly kind: "text" | "strong" | "em" | "code" | "link";
  readonly text: string;
  readonly href?: string;
}

type Block =
  | { readonly kind: "heading"; readonly level: number; readonly segments: readonly InlineSegment[] }
  | { readonly kind: "paragraph"; readonly segments: readonly InlineSegment[] }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "list"; readonly ordered: boolean; readonly items: readonly (readonly InlineSegment[])[] };

const props = defineProps<{ source: string }>();

const blocks = computed(() => parseBlocks(props.source));

function parseBlocks(source: string): readonly Block[] {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const result: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (line.trim() === "") {
      index += 1;
      continue;
    }

    if (line.trimStart().startsWith("```")) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").trimStart().startsWith("```")) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      index += 1;
      result.push({ kind: "code", text: code.join("\n") });
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/u.exec(line);
    if (heading !== null) {
      result.push({ kind: "heading", level: heading[1]?.length ?? 1, segments: parseInline(heading[2] ?? "") });
      index += 1;
      continue;
    }

    const bullet = /^\s*[-*]\s+(.*)$/u.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/u.exec(line);
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items: (readonly InlineSegment[])[] = [];
      while (index < lines.length) {
        const candidate = lines[index] ?? "";
        const match = isOrdered ? /^\s*\d+[.)]\s+(.*)$/u.exec(candidate) : /^\s*[-*]\s+(.*)$/u.exec(candidate);
        if (match === null) {
          break;
        }
        items.push(parseInline(match[1] ?? ""));
        index += 1;
      }
      result.push({ kind: "list", ordered: isOrdered, items });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const candidate = lines[index] ?? "";
      if (candidate.trim() === "" || /^(#{1,4})\s+/u.test(candidate) || candidate.trimStart().startsWith("```")) {
        break;
      }
      paragraph.push(candidate);
      index += 1;
    }
    result.push({ kind: "paragraph", segments: parseInline(paragraph.join(" ")) });
  }

  return result;
}

function parseInline(text: string): readonly InlineSegment[] {
  const segments: InlineSegment[] = [];
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/gu;
  let cursor = 0;

  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      segments.push({ kind: "text", text: text.slice(cursor, start) });
    }
    const token = match[0];
    segments.push(parseToken(token));
    cursor = start + token.length;
  }

  if (cursor < text.length) {
    segments.push({ kind: "text", text: text.slice(cursor) });
  }

  return segments;
}

function parseToken(token: string): InlineSegment {
  if (token.startsWith("**")) {
    return { kind: "strong", text: token.slice(2, -2) };
  }
  if (token.startsWith("`")) {
    return { kind: "code", text: token.slice(1, -1) };
  }
  if (token.startsWith("[")) {
    const separator = token.indexOf("](");
    const label = token.slice(1, separator);
    const target = token.slice(separator + 2, -1);
    // 只放行 http/https；其他协议（javascript:、data: 等）不生成链接。
    if (/^https?:\/\//iu.test(target)) {
      return { kind: "link", text: label, href: target };
    }
    return { kind: "text", text: `${label}（链接协议不受支持，未渲染）` };
  }
  return { kind: "em", text: token.slice(1, -1) };
}
</script>

<template>
  <div class="markdown-preview" data-testid="markdown-preview">
    <template v-for="(block, index) in blocks" :key="index">
      <h3 v-if="block.kind === 'heading' && block.level <= 2" class="markdown-preview__heading">
        <SafeInline :segments="block.segments" />
      </h3>
      <h4 v-else-if="block.kind === 'heading'" class="markdown-preview__subheading">
        <SafeInline :segments="block.segments" />
      </h4>
      <pre v-else-if="block.kind === 'code'" class="markdown-preview__code"><code>{{ block.text }}</code></pre>
      <ul v-else-if="block.kind === 'list' && !block.ordered" class="markdown-preview__list">
        <li v-for="(item, itemIndex) in block.items" :key="itemIndex"><SafeInline :segments="item" /></li>
      </ul>
      <ol v-else-if="block.kind === 'list'" class="markdown-preview__list">
        <li v-for="(item, itemIndex) in block.items" :key="itemIndex"><SafeInline :segments="item" /></li>
      </ol>
      <p v-else class="markdown-preview__paragraph"><SafeInline :segments="block.segments" /></p>
    </template>
  </div>
</template>
