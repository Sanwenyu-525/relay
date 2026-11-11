import type { RelayAssistSession } from "../api/relayClient";

/**
 * 左栏「会话（按目录）」的分组键，也是「清空这段会话集合」的作用域键。
 *
 * 目录资源身份优先；没有目录依据的会话按两种**可核对的缺口**分开：
 * `unknown` 表示这次读取根本没拿到上下文，`unbound` 表示上下文读到了但工作目录为空。
 * 两者不能合成一个键——把它们混在一起，界面上「目录待核对」的条目会被误删进
 * 「未绑定目录」那一组。
 */
export function sessionDirectoryKey(session: RelayAssistSession): string {
  const directory = session.context?.workingDirectory;
  return directory?.resourceId ?? (session.context === undefined ? "unknown" : "unbound");
}
