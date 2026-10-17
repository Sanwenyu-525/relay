import type { FrozenModelConstraint } from './frozen-model-constraint.js';

/**
 * 免费模型外呼的「服务商端零价格硬限制」（免费模型专项 · 阶段 C，FM-07）。
 *
 * 依据 §8.6 与 OpenRouter Provider 价格上限文档：对携带「仅免费」约束的具体型号，
 * 每次外呼（含续轮、重试、该免费选择的连接验证）在最终 HTTP 请求体上附
 * `provider.max_price`，把 prompt/completion/request/image 全部钉死为 0，并关闭收费
 * fallback 链与参数不匹配的 provider 顶替。目录检查与远端计价并非原子，这只是请求时
 * 的补充防线——不能证明时不宣称零收费保证（§8）。
 *
 * 关键约束：
 * 1. 只在 `freeOnly` 为 true 时注入；原默认/其他无此约束的连接保持原请求体，不受目录故障影响。
 * 2. 不调用 `openrouter/free`：那会随机选具体型号，违反 Run 模型稳定语义。确切模型 ID 由
 *    已配置的连接提供，本守卫只加价格上限与路由约束，绝不改写 `model`。
 * 3. 单位：prompt/completion 为 USD / 百万 token，request 为每请求，image 为每张；全部取 0。
 */

/** 注入到 OpenAI 兼容请求体的服务商路由硬限制。 */
export interface ProviderRoutingGuard {
  readonly provider: {
    readonly max_price: {
      readonly prompt: 0;
      readonly completion: 0;
      readonly request: 0;
      readonly image: 0;
    };
    /** 关闭备份 provider，杜绝「免费端不可用就落到付费端」。 */
    readonly allow_fallbacks: false;
    /** 只接受支持本次全部参数的 provider，避免能力被静默替换。 */
    readonly require_parameters: true;
  };
}

export class FreeCallGuardError extends Error {
  override readonly name = 'FreeCallGuardError';
  constructor() {
    super('FREE_CALL_GUARD_UNAPPLIED');
  }
}

/**
 * 从冻结约束构造硬限制；`undefined` 或未携带「仅免费」约束时返回 `undefined`，
 * 端口据此完全不改动原请求体（原默认行为逐字不变）。
 */
export function buildFreePriceGuard(constraint: FrozenModelConstraint | undefined):
  ProviderRoutingGuard | undefined {
  if (constraint === undefined || constraint.freeOnly !== true) return undefined;
  return {
    provider: {
      // 覆盖 prompt/completion/request/image 四项价格上限，全部为绝对零——不用极小非零冒充免费。
      max_price: { prompt: 0, completion: 0, request: 0, image: 0 },
      allow_fallbacks: false,
      require_parameters: true,
    },
  };
}

/**
 * 把硬限制并入服务商路由对象的纯函数，供端口 fetch 包装与单测共用。
 *
 * 合并而非整体替换：保留 SDK 可能已设置的其它 `provider` 字段，但价格上限、fallback 与
 * require_parameters 三项由本守卫强制覆盖，防止上游把免费约束稀释掉。
 */
export function mergeProviderGuard(body: Record<string, unknown>,
  guard: ProviderRoutingGuard): Record<string, unknown> {
  const existing = isPlainObject(body.provider) ? body.provider as Record<string, unknown> : {};
  return { ...body,
    provider: { ...existing, max_price: guard.provider.max_price,
      allow_fallbacks: false, require_parameters: true } };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 外呼边界注入：包在 guardedModelFetch 之外、SDK 之内，改写**最终**发出体。
 *
 * 与端口既有的 reasoning 包装同层——只有在这里改写才能用捕获到的 HTTP body 证明
 * 免费硬限制确实到达外呼边界，而不只是停留在内部参数（§7 验证 3、FM-07）。
 * 无法解析为 JSON 对象的请求体（非本端口预期）原样放行，不臆造字段。
 */
export function withProviderGuard(modelFetch: typeof fetch, guard: ProviderRoutingGuard):
  typeof fetch {
  return async (input, init) => {
    if (typeof init?.body !== 'string') throw new FreeCallGuardError();
    let body: Record<string, unknown>;
    try { body = JSON.parse(init.body) as Record<string, unknown>; }
    catch { throw new FreeCallGuardError(); }
    if (!isPlainObject(body) || typeof body.model !== 'string' || body.model.trim() === '') {
      throw new FreeCallGuardError();
    }
    return modelFetch(input, { ...init, body: JSON.stringify(mergeProviderGuard(body, guard)) });
  };
}
