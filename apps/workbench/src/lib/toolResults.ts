/** 只读取工具回执的失败事实，不把普通输出或缺失结果猜成失败。 */
export function failedToolResult(result: Readonly<Record<string, unknown>> | null): boolean {
  return result?.outcome === "FAILED" || typeof result?.reason === "string";
}
