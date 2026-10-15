import { useCallback, useEffect, useRef, useState } from "react";
import type { RelayApiClient, RelayRunToolCalls } from "../api/relayClient";
import { describeLiveError } from "./liveErrors";

/**
 * 工具轨迹投影的单一读取入口（docs/frontend/workbench-design.md §18.8）。
 *
 * 聊天区摘要与右栏轨迹页签共用这一个 hook：两处都订阅事件流、各自读一次同一份投影，
 * 会让同一 Run 出现两条可能不同步的事实来源。共享读取让它们必然一致。
 *
 * 四件事在这里做对，别处就不必重复：
 *   * 身份核对。响应带自己的 run_id；它与请求的 Run 不一致时整份投影作废。这里按身份对齐，
 *     绝不用「它在列表里的位置」去猜它属于哪条消息或哪个 Run。
 *   * 不跨 Run 闪旧数据。快照与请求的 run_id 一起存放，取用时再比对；切换 Run 的那一帧
 *     旧投影立刻不可见，于是不会出现「新 Run 的标题 + 上一次 Run 的工具清单」。
 *   * 游标续读。事件流只推进不重放；`after` 带上已收到的最大 seq，重连才不会把整段历史
 *     重播一遍、把一次挂载变成上百次投影读取。
 *   * 同一批提示合并成一次读取。事件是逐条推的，逐条重读会让 Loading 反复闪烁。
 *
 * 版本守卫仍然保留：切换 Run 或卸载后到达的响应一律丢弃，不复活已清除的行。
 */

interface Snapshot {
  readonly runId: string;
  readonly projection: RelayRunToolCalls;
  readonly readAt: string;
}
interface Failure {
  readonly runId: string;
  readonly message: string;
}

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
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [inFlight, setInFlight] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const version = useRef(0);
  const cursor = useRef("0");
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  const read = useCallback(async () => {
    if (runId === null) {
      // 没有 Run 时必须把读取态收干净：否则上一条在途请求的 finally 已被版本守卫跳过，
      // 面板会永远停在「正在读取」。
      setSnapshot(null); setFailure(null); setInFlight(false);
      return;
    }
    const current = ++version.current;
    setInFlight(true); setFailure((previous) => previous?.runId === runId ? previous : null);
    try {
      const next = await client.getRunToolCalls(runId);
      if (current !== version.current) return;
      // 身份核对在这里落一次：投影自己声明它属于哪个 Run，不一致就整份作废。
      // 按列表位置归属正是「把别的 Run 的工具清单挂到这条消息上」的来源。
      if (next.runId !== runId) {
        setSnapshot(null);
        setFailure({ runId, message: `工具轨迹响应的 run_id 是 ${next.runId}，与请求的 Run ${runId} 不一致；` +
          "该响应已整体丢弃，不会按位置猜它属于哪次执行。" });
        return;
      }
      // 整体替换而不是合并：断线重读后不允许复活已被清除的旧行。
      setSnapshot({ runId, projection: next, readAt: new Date().toISOString() });
    } catch (caught) {
      if (current !== version.current) return;
      setSnapshot(null);
      setFailure({ runId, message: describeLiveError(caught).message });
    } finally { if (current === version.current) setInFlight(false); }
  }, [client, runId]);

  useEffect(() => {
    void read();
    return () => { version.current++; };
  }, [read, revision]);

  useEffect(() => {
    if (runId === null) return;
    // 事件游标按 Run 独立：换 Run（或换连接）后必须从 0 起订阅，否则会带着上一 Run 的
    // 最大 seq 去读新 Run 的事件流，跳过 seq 更小的事件，轨迹就会停在旧状态。
    cursor.current = "0";
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

  // 快照与失败都带 run_id：切换 Run 的那一帧，旧 Run 的清单与旧错误都不可取用。
  const mine = snapshot !== null && snapshot.runId === runId ? snapshot : null;
  const error = failure !== null && failure.runId === runId ? failure.message : null;
  // 还没有为当前 Run 读到任何事实时（含刚切换 Run 的第一帧）一律算作读取中，
  // 否则面板会在旧数据与空白之间闪一下。
  const settled = mine !== null || error !== null;
  return {
    projection: mine?.projection ?? null,
    loading: runId !== null && (inFlight || !settled),
    error,
    readAt: mine?.readAt ?? null,
    streaming,
    reload: () => { void read(); }
  };
}
