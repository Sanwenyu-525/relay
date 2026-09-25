import { shallowRef } from "vue";

/**
 * 创建项目成功后的跨页面交接：创建页写入，项目列表读取一次后清空。
 * 只保存本次导航的演示回执，不是业务事实，刷新后自然消失。
 */
export interface CreationFlash {
  projectId: string;
  receipt: string;
  importStatus: "none" | "SUCCEEDED" | "FAILED";
}

const flash = shallowRef<CreationFlash | null>(null);

export function setCreationFlash(value: CreationFlash): void {
  flash.value = value;
}

export function takeCreationFlash(): CreationFlash | null {
  const value = flash.value;
  flash.value = null;
  return value;
}

export function clearCreationFlash(): void {
  flash.value = null;
}
