import { isTauri, invoke } from "@tauri-apps/api/core";

/**
 * 宿主只负责选目录。返回 null 表示用户取消选择：调用方保留草稿，不当作失败。
 * 浏览器/示例模式下没有原生选择器，调用方必须提供手动输入的替代路径。
 */
export async function selectWorkingDirectory(): Promise<string | null> {
  if (!isTauri()) throw new Error("当前不是桌面宿主，无法打开原生目录选择器。");
  const selected = await invoke<string | null>("select_working_directory");
  return selected === null || selected === "" ? null : selected;
}

export function nativeFolderPickerAvailable(): boolean {
  return isTauri();
}
