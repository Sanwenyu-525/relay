import { useCallback, useEffect, useRef, useState } from "react";
import type { RelayApiClient, RelayActivityFilter, RelayActivityItem } from "../api/relayClient";

export interface ActivitiesState {
  readonly items: readonly RelayActivityItem[];
  readonly loading: boolean;
  readonly error: string | null;
  /** 刷新失败但仍保留上次可信值：界面标「更新失败」（§17.13 live 规则）。 */
  readonly stale: boolean;
  readonly refresh: () => void;
}

/**
 * 最近动态（活动流）的一次性读取（首屏「最近动态」区）。
 * 与 useConversationDiff 同契约：刷新失败不清零、保留上次可信值并标 stale；
 * 只读汇总区无需轮询，挂载时取一次即可，refresh 供异常后手动重试。
 * filter 仅按其内容（经 JSON 序列化）决定重取，调用方传入字面量对象也不会触发重复请求。
 */
export function useActivities(client: RelayApiClient, filter: RelayActivityFilter = {}, limit = 5): ActivitiesState {
  const [items, setItems] = useState<readonly RelayActivityItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState(false);
  const version = useRef(0);
  const filterKey = JSON.stringify(filter);

  const read = useCallback(async () => {
    const current = ++version.current;
    setInFlight(true);
    try {
      const page = await client.getActivities({ ...filter, limit });
      if (current !== version.current) return;
      setItems(page.items);
      setError(null);
    } catch (caught) {
      if (current !== version.current) return;
      // 失败时保留同一可信值；从未读到过才显示不可用。
      setError(caught instanceof Error ? caught.message : "最近动态读不到。");
    } finally {
      if (current === version.current) setInFlight(false);
    }
  }, [client, filterKey, limit]);

  useEffect(() => {
    void read();
    return () => { version.current++; };
  }, [read]);

  return {
    items,
    loading: inFlight && items.length === 0,
    error,
    stale: error !== null && items.length > 0,
    refresh: () => { void read(); },
  };
}
