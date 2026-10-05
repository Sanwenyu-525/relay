import { useCallback, useEffect, useRef, useState } from "react";
import type { RelayApiClient, RelayRunToolCalls } from "../api/relayClient";
import { describeLiveError } from "./liveErrors";

/**
 * 工具轨迹投影的单一读取入口（docs/frontend/workbench-design.md §18.8）。
 *
 * 聊天区摘要与右栏轨迹页签共用这一个 hook：两处都订阅事件流、各自读一次同一份投影，
 * 会让同一 Run 出现两条可能不同步的事实来源。共享读取让它们必然一致。
 *
 * 三件事在这里做对，别处就不必重复：
 *   * 游标续读。事件流只推进不重放；`after` 带上已收到的最大 seq，重连才不会把整段历史
 *     重播一遍、把一次挂载变成上百次投影读取。
 *   * 同一批提示合并成一次读取。事件是逐条推的，逐条重读会让 Loading 反复闪烁。
 *   * 版本守卫。切换 Run 或卸载后到达的响应一律丢弃，不复活已清除的行。
 */
export interface RunToolCallsState {
  readonly projection: RelayRunToolCalls | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly readAt: string | null;
  readonly streaming: boolean;
  readonly reload: () => void;
}
export function useRunToolCalls(client: RelayApiClient, runId: string | null,
  revision: string | null): RunToolCallsState {
  const [projection, setProjection] = useState<RelayRunToolCalls | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readAt, setReadAt] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const version = useRef(0);
  const cursor = useRef("0");
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  const read = useCallback(async () => {
    if (runId === null) {
      // 没有 Run 时必须把读取态收干净：否则上一条在途请求的 finally 已被版本守卫跳过，
      // 面板会永远停在「正在读取」。
      setProjection(null); setLoading(false); setError(null); setReadAt(null);
      return;
    }
    const current = ++version.current;
    setLoading(true); setError(null);
    try {
      const next = await client.getRunToolCalls(runId);
      if (current !== version.current) return;
      // 整体替换而不是合并：断线重读后不允许复活已被清除的旧行。
      setProjection(next); setReadAt(new Date().toISOString());
    } catch (caught) {
      if (current !== version.current) return;
      setProjection(null);
      setError(describeLiveError(caught).message);
    } finally { if (current === version.current) setLoading(false); }
  }, [client, runId]);

  useEffect(() => {
    void read();
    return () => { version.current++; };
  }, [read, revision]);

  useEffect(() => {
    if (runId === null) return;
    let active = true;
    const abort = new AbortController();
    const schedule = () => {
      // 一批事件提示只触发一次读取；否则一次工具循环的十几条提示会让 Loading 反复闪。
      if (pending.current !== null) return;
      pending.current = setTimeout(() => { pending.current = null; void read(); }, 60);
    };
    const live = async () => {
      while (active) {
        try {
          await client.readRunEvents(runId, cursor.current, abort.signal,
            (seq) => { cursor.current = seq; schedule(); }, () => setStreaming(true));
        } catch { /* 流不可用时降级到按 revision 重读，由界面如实说明 */ }
        if (!active) break;
        setStreaming(false);
        // 连接断开后按已收到的游标续读，而不是从 0 重播整段历史。
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    };
    void live();
    return () => {
      active = false;
      abort.abort();
      if (pending.current !== null) { clearTimeout(pending.current); pending.current = null; }
    };
  }, [client, runId, read]);

  return { projection, loading, error, readAt, streaming, reload: () => { void read(); } };
}
