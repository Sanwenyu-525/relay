import { ref, type Ref } from "vue";

const stack: Ref<symbol[]> = ref([]);

export function pushDialog(token: symbol): void {
  stack.value = [...stack.value, token];
}

export function popDialog(token: symbol): void {
  stack.value = stack.value.filter((candidate) => candidate !== token);
}

export function isTopDialog(token: symbol): boolean {
  return stack.value[stack.value.length - 1] === token;
}

export function otherDialogAbove(token: symbol): boolean {
  const index = stack.value.indexOf(token);
  return index >= 0 && index < stack.value.length - 1;
}

export const dialogStack = stack;