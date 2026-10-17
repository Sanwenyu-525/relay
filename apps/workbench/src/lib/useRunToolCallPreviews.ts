import { useCallback, useEffect, useRef, useState } from "react";
import type { RelayApiClient, RelayRunToolCallPreview } from "../api/relayClient";

/**
 * 工具参数「生成中」预览的有界轮询（工作台 §34.4 / CD-09、CD-11、CD-13）。
 *
 * 预览是可丢弃的临时证据，不是账本：
 *   * 只在 Run 仍非终态时轮询；Run 终态、切 Run、卸载都整份清空——迟到的片段不会复活「正在生成」。
 *   * 响应自带 run_id，与请求的 Run 不一致时整份丢弃，绝不按位置归属到别的执行。
 *   * 读取失败保留上一次预览值并放慢轮询，不反复归零造成数字闪。落账后由 `fileChanges`
 *     的实际数字替换预览（见 localFileDiffRows），所以这里的容错不影响事实。
 *   * 预览不进会话总数：总数另有 `useConversationDiff`，两条读取互不合并。
 */

const FAST_MS = 900;
const BACKOFF_MS = 4000;

export interface RunToolCallPreviewsState {
  readonly previews: readonly RelayRunToolCallPreview[];
}

export function useRunToolCallPreviews(client: RelayApiClient, runId: string | null,
  active: boolean): RunToolCallPreviewsState {
  const [previews, setPreviews] = useState<readonly RelayRunToolCallPreview[]>([]);
  const version = useRef(0);

  /** 返回本轮是否读到了可信响应；失败用来放慢轮询，不让预览读取变成忙等。 */
  const read = useCallback(async (): Promise<"settled" | "failed"> => {
    if (runId === null) return "settled";
    const current = ++version.current;
    try {
      const next = await client.getRunToolCallPreviews(runId);
      if (current !== version.current) return "settled";
      // 身份核对：响应说自己属于哪个 Run，对不上就整份作废。
      setPreviews(next.runId === runId ? next.previews : []);
      return "settled";
    } catch {
      if (current !== version.current) return "settled";
      // 失败不清空：下一次成功读取会替换整份，或由实际账本落定。
      return "failed";
    }
  }, [client, runId]);

  useEffect(() => {
    if (runId === null || active === false) {
      version.current++;
      setPreviews([]);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      const outcome = await read();
      if (!alive) return;
      timer = setTimeout(() => { void poll(); }, outcome === "failed" ? BACKOFF_MS : FAST_MS);
    };
    void poll();
    return () => {
      alive = false;
      version.current++;
      if (timer !== null) clearTimeout(timer);
    };
  }, [read, active, runId]);

  return { previews };
}
