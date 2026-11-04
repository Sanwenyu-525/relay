import type { AssistModelPort, ComposerDraftPort, ModelPort, ModelUsage } from
  './fake-model-port.js';
import { AnthropicMessagesModelPort } from './anthropic-messages-model-port.js';
import type { ModelFetchDependencies } from './model-endpoint-policy.js';
import type { ProviderRoutingGuard } from './free-call-guard.js';
import { protocolOf, type ModelPortConfig } from './model-port-config.js';
import { OpenAiCompatibleModelPort, type ModelCallBudget } from
  './openai-compatible-model-port.js';

/**
 * 真实模型端口的唯一构造入口（MODEL-SETTINGS-03）。
 *
 * 协议由配置**显式声明**（`ModelPortConfig.protocol`），这里只做分派，不根据 URL、
 * 品牌或型号推断。API 进程的聊天、Worker 的 Run 执行、压缩/自动提取、连接验证都走
 * 同一个入口，因此「冻结的是哪种协议」与「执行的是哪种协议」不可能分叉。
 *
 * `freeGuard` 只对 OpenRouter 免费路由（OpenAI 兼容协议）有意义；Anthropic 端口忽略它
 * （该路径不会产生免费路由约束）。
 */
export type RuntimeModelPort = ModelPort & AssistModelPort & ComposerDraftPort & {
  /** 语义验收（Run 的语义检查器用）。Anthropic 实现在无 JSON 模式时仍按提示词严格解析。 */
  evaluate(input: { readonly statement: string; readonly content: string },
    signal?: AbortSignal): Promise<{
      readonly verdict: 'PASS' | 'FAIL' | 'UNCERTAIN';
      readonly reason: string;
      readonly providerRequestId: string;
      readonly usage: ModelUsage;
    }>;
  /** 换用冻结快照的预算；配置指纹不变（同一配置、同一凭据）。 */
  withBudget(budget: ModelCallBudget): RuntimeModelPort;
};

export function createModelPort(config: ModelPortConfig,
  transport: ModelFetchDependencies = {},
  freeGuard?: ProviderRoutingGuard,
  budget?: ModelCallBudget): RuntimeModelPort {
  return protocolOf(config) === 'anthropic-messages'
    ? new AnthropicMessagesModelPort(config, transport, freeGuard, budget)
    : new OpenAiCompatibleModelPort(config, transport, freeGuard, budget);
}
