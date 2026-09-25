<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import { X } from "lucide-vue-next";
import { isTopDialog, popDialog, pushDialog } from "../lib/dialogStack";

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    title: string;
    variant?: "dialog" | "drawer";
  }>(),
  { variant: "dialog" }
);

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  close: [];
}>();

const token = Symbol("relay-dialog");
const panel = ref<HTMLElement | null>(null);
let returnFocus: HTMLElement | null = null;

function close(): void {
  emit("update:modelValue", false);
  emit("close");
}

function focusableElements(): HTMLElement[] {
  return panel.value
    ? Array.from(
        panel.value.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((element) => !element.hasAttribute("hidden") && element.offsetParent !== null)
    : [];
}

function onKeydown(event: KeyboardEvent): void {
  if (!props.modelValue || !isTopDialog(token)) {
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    close();
    return;
  }
  if (event.key !== "Tab") {
    return;
  }
  const elements = focusableElements();
  if (elements.length === 0) {
    event.preventDefault();
    panel.value?.focus();
    return;
  }
  const first = elements[0];
  const last = elements[elements.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

watch(
  () => props.modelValue,
  async (open) => {
    if (open) {
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      pushDialog(token);
      document.addEventListener("keydown", onKeydown);
      await nextTick();
      focusableElements()[0]?.focus();
      return;
    }
    popDialog(token);
    document.removeEventListener("keydown", onKeydown);
    await nextTick();
    if (returnFocus?.isConnected) {
      returnFocus.focus();
    }
    returnFocus = null;
  }
);

onBeforeUnmount(() => {
  popDialog(token);
  document.removeEventListener("keydown", onKeydown);
});
</script>

<template>
  <Teleport to="body">
    <div v-if="modelValue" class="dialog-backdrop" @mousedown.self="close">
      <section
        ref="panel"
        class="dialog-panel"
        :class="`dialog-panel--${variant}`"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
        tabindex="-1"
      >
        <header class="dialog-header">
          <h2>{{ title }}</h2>
          <button class="icon-button" type="button" aria-label="关闭面板" @click="close">
            <X aria-hidden="true" />
          </button>
        </header>
        <div class="dialog-content">
          <slot />
        </div>
      </section>
    </div>
  </Teleport>
</template>