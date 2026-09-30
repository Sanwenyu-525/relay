import type { RelayModelVerifyErrorCategory } from "../api/relayClient";

/** 连接验证与运行期消息共用的 Provider 失败指引。 */
export const modelErrorGuides: Record<RelayModelVerifyErrorCategory, string> = {
  AUTH: "认证失败（401/403）：请核对 API Key 是否有效、是否有该模型权限。",
  RATE_LIMIT: "限流（429）：请稍后重试，或核对配额与账户额度。",
  TIMEOUT: "超时：请检查网络到端点的连通性，或调大 RELAY_MODEL_TIMEOUT_MS 后重启。",
  STREAM_BROKEN: "流中断：端点协议兼容性异常，请核对 Provider 是否为 OpenAI 兼容接口。",
  PROTOCOL: "响应结构异常或模型无效：请核对模型名称与端点是否匹配。",
  NETWORK: "网络不可达：请核对服务端点域名/DNS/防火墙，确认端点可公开访问。"
};
