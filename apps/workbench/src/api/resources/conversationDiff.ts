import { RelayTransportError } from "../core/errors";
import { RelayHttp } from "../core/http";
import { boolean, object, string } from "../core/primitives";
import { conversationDiffFileDetailFrom, conversationDiffFrom } from "../parse/assist";
import type { RelayConversationDiff, RelayConversationDiffFile, RelayConversationDiffScope } from "../dtos/assist";

/** 范围参数只加在 URL 上：省略＝会话口径，服务端默认就是它。 */
function scopeQuery(scope: RelayConversationDiffScope | undefined, prefix: string): string {
  return scope === undefined || scope === "SESSION" ? prefix : `${prefix}${prefix.includes("?") ? "&" : "?"}scope=${scope}`;
}

/**
 * 读会话 diff（基线到当前已落盘内容的净变化）；不可用时返回带原因的对象。
 *
 * `scope` 决定范围：`SESSION`（默认）只算本会话落盘的路径——对话入口用这一档；
 * `DIRECTORY` 算整段目录净变化（含同期外部修改）——工作详情的「变更」页签用这一档。
 */
export async function getConversationDiff(http: RelayHttp, sessionId: string,
  scope?: RelayConversationDiffScope): Promise<RelayConversationDiff> {
  try {
    const body = await http.request(http.workspacePath(scopeQuery(scope,
      `/assist-sessions/${encodeURIComponent(sessionId)}/conversation-diff`)));
    return conversationDiffFrom(body);
  } catch (error) {
    throw new RelayTransportError("会话 diff 当前读不到；这与磁盘上的实际改动无关。");
  }
}

/**
 * 展开阅读：读单个文件的完整 diff 正文（工作台 §34.2 / CD-18）。
 * 与总数同一份基线修订与同一份当前快照；行数不可统计时正文也不编造。
 */
export async function getConversationDiffFileDetail(http: RelayHttp, sessionId: string,
  path: string, scope?: RelayConversationDiffScope): Promise<RelayConversationDiffFile> {
  try {
    const body = await http.request(http.workspacePath(scopeQuery(scope,
      `/assist-sessions/${encodeURIComponent(sessionId)}/conversation-diff/file` +
      `?path=${encodeURIComponent(path)}`)));
    return conversationDiffFileDetailFrom(body);
  } catch {
    throw new RelayTransportError("该文件的 diff 正文当前读不到；总数与磁盘实际改动不受影响。");
  }
}

/**
 * CD-05：主动「从现在开始统计」——为当前目录新建一段基线（不倒造过去）。
 * 幂等：若同目录已有基线，服务端复用而不新建第二个起点。
 */
export async function establishConversationDiffBaseline(http: RelayHttp, sessionId: string): Promise<{ established: boolean; reason: string }> {
  const row = await http.request(
    http.workspacePath(`/assist-sessions/${encodeURIComponent(sessionId)}/conversation-diff/baseline`),
    { method: "POST", body: JSON.stringify({}) }, 200);
  try {
    const body = object(row, "conversation diff baseline");
    return { established: boolean(body, "established", "conversation diff baseline"),
      reason: string(body, "reason", "conversation diff baseline") };
  } catch {
    throw new RelayTransportError("会话基线建立回执无法核对。");
  }
}
