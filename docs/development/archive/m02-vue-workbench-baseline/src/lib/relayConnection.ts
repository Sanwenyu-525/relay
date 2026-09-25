import { markRaw, reactive } from "vue";
import { RelayApiClient, type RelayApiConnection } from "../api/relayClient";

export type RelayDataMode = "fixture" | "live";

interface RelayConnectionState {
  mode: RelayDataMode;
  client: RelayApiClient | null;
  /** 仅用于界面显示数据来源，不含凭据。 */
  baseUrl: string | null;
}

/**
 * 默认仍是示例数据；只有用户显式连接本机 API 后才进入 live。
 * 连接与 Bearer 只保存在当前页面内存：不写入 URL、localStorage、日志或源码，
 * 重新加载页面会丢失连接并回到 fixture。
 */
export const relayConnection = reactive<RelayConnectionState>({
  mode: "fixture",
  client: null,
  baseUrl: null
});

export function activateRelayConnection(input: RelayApiConnection): void {
  // markRaw：客户端实例不能进 reactive 代理，否则方法内访问私有字段（#workspaceId 等）会失败。
  relayConnection.client = markRaw(new RelayApiClient(input));
  relayConnection.baseUrl = input.baseUrl;
  relayConnection.mode = "live";
}

export function useFixtureData(): void {
  relayConnection.client = null;
  relayConnection.baseUrl = null;
  relayConnection.mode = "fixture";
}

/** live 模式下必须拿到客户端；拿不到说明连接已在别处断开。 */
export function liveClient(): RelayApiClient | null {
  // reactive 会把类实例展开为结构化类型（丢掉私有字段），这里显式还原为类类型。
  return relayConnection.mode === "live" ? (relayConnection.client as RelayApiClient | null) : null;
}

/** 测试清理用；生产路径不会读取或输出之前的凭据。 */
export function resetRelayConnectionForTest(): void {
  useFixtureData();
}
