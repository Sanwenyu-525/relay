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

/**
 * 开发者诊断：打开受管日志目录。宿主只认自己的 data_root/logs，
 * 不接受任意路径，浏览器形态没有这个能力。
 */
export async function openLogDirectory(): Promise<string> {
  if (!isTauri()) throw new Error("当前不是桌面宿主，无法打开本机日志目录。");
  return invoke<string>("open_log_directory");
}

export function nativeLogDirectoryAvailable(): boolean {
  return isTauri();
}

/** 导出诊断结果：宿主弹出保存对话框；返回 null 表示用户取消，不当作失败。 */
export async function saveDiagnosticsExport(suggestedName: string, content: string): Promise<string | null> {
  if (!isTauri()) throw new Error("当前不是桌面宿主，无法保存诊断导出文件。");
  const saved = await invoke<string | null>("save_diagnostics_export", { suggestedName, content });
  return saved === null || saved === "" ? null : saved;
}
