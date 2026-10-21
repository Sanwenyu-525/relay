import type { RelayHttp } from "../core/http";
import { array, nullableString, object, string } from "../core/primitives";

/**
 * 插件运行时状态（2026-10-20，P0-2；HTTP §10.101）。
 *
 * 这是**安装级**事实：插件在这台机器上装没装、运行时在不在、登录没登录。
 * 项目级授权仍从项目连接登记读取，两者不合并——合并就会让「没登录」看起来像「没授权」。
 */
export type RelayPluginRuntimeState = "READY" | "NOT_INSTALLED" | "NOT_PAIRED"
  | "NOT_AUTHENTICATED" | "UNAVAILABLE";

export interface RelayPluginRuntimeStatus {
  readonly plugin: string;
  readonly state: string;
  readonly detail: string;
  readonly remediation: string | null;
}

export async function getPluginStatus(http: RelayHttp): Promise<readonly RelayPluginRuntimeStatus[]> {
  const body = object(await http.request(http.workspacePath("/plugins/status")), "plugin status");
  return array(body, "items", "plugin status").map((value) => {
    const row = object(value, "plugin status item");
    return { plugin: string(row, "plugin", "plugin status item"),
      state: string(row, "state", "plugin status item"),
      detail: string(row, "detail", "plugin status item"),
      remediation: nullableString(row, "remediation", "plugin status item") };
  });
}
