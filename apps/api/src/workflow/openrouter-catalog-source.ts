import { guardedModelFetch, type ModelFetchDependencies } from './model-endpoint-policy.js';
import type { ModelCatalogConfig } from './model-catalog-config.js';
import type { CatalogFailureReason } from '../model/model-catalog-repository.js';

/**
 * 免费模型目录读取的 Infrastructure 边界（专项阶段 B）。
 *
 * 这是**纯读取**：只发一次对已登记来源的 GET，不发聊天/推理/测试调用，不建 Task/Run，不写 model_calls。
 * 来源、分页、响应大小与耗时全部有界；来源返回的名称、描述、能力与价格一律当作**外部数据**，
 * 不能升级为指令、endpoint 或授权。端点复用现有 `guardedModelFetch`/`parseModelBaseUrl`，
 * 目录内容不得引入新的请求主机。凭据只按引用在服务端解析，绝不与其他平台密钥串用。
 */

export class CatalogSourceError extends Error {
  override readonly name = 'CatalogSourceError';
  constructor(readonly reason: CatalogFailureReason, message?: string) {
    super(message ?? `catalog source failed: ${reason}`);
  }
}

export interface CatalogSourcePort {
  /** 成功时返回来源的原始模型条目数组；任何失败以类型化 CatalogSourceError 抛出，调用方据此收口而不发布。 */
  fetchCatalog(signal: AbortSignal): Promise<readonly unknown[]>;
}

/** 读取响应文本并累计字节，超过上限即中止——限制响应大小，不无界吞入内存。 */
async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received += chunk.value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new CatalogSourceError('INCOMPLETE', 'catalog response exceeded the byte budget');
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

function classifyThrown(error: unknown): CatalogSourceError {
  if (error instanceof CatalogSourceError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/MODEL_ENDPOINT_NOT_ALLOWED|MODEL_ENDPOINT_NOT_PUBLIC|MODEL_ENDPOINT_REDIRECTED/u.test(message)) {
    return new CatalogSourceError('ENDPOINT_NOT_ALLOWED', message);
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new CatalogSourceError('TIMEOUT', message);
  }
  return new CatalogSourceError('NETWORK', message);
}

/** 只把「非空字符串 / 有限数值」当作真实的续页游标；null、空串、false 都表示没有下一页。 */
function hasContinuationCursor(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() !== '';
  return value !== null && value !== undefined && value !== false;
}

function readCount(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/u.test(value.trim())) return Number(value.trim());
  return undefined;
}

/**
 * 判断这份响应是不是「整份目录」而不是「某一页」。
 *
 * 真实 `/models` 响应是 `{ data, total_count, links: { next } }`：`links.next` 为 null
 * 表示已经到最后，`total_count` 是服务端自报的完整目录规模。只要出现以下任一信号，
 * 手里这份就只是**一部分**，把它当完整快照发布等于对外声称「目录只剩这些」——会误删
 * 仍然存在的免费型号、并可能把不完整的集合当成免费保证的依据：
 *   * `links.next` / `next` 给了续页游标；
 *   * `has_more` 明确为真；
 *   * `total_count` / `total` 大于本次收到的条目数。
 * 首版不做有界翻页（未核实官方分页参数，猜测翻页比拒绝更危险），一律如实拒绝为
 * INCOMPLETE，由调用方保留旧快照并记录失败。
 */
function assertCompletePage(envelope: Record<string, unknown>, received: number): void {
  const links = (envelope.links !== null && typeof envelope.links === 'object')
    ? envelope.links as Record<string, unknown> : {};
  if (hasContinuationCursor(links.next) || hasContinuationCursor(envelope.next)
      || envelope.has_more === true) {
    throw new CatalogSourceError('INCOMPLETE', 'catalog response carries a next-page cursor');
  }
  for (const key of ['total_count', 'total'] as const) {
    const declared = readCount(envelope[key]);
    if (declared !== undefined && declared > received) {
      throw new CatalogSourceError('INCOMPLETE', `catalog declares ${declared} entries but returned ${received}`);
    }
  }
}

/**
 * OpenRouter 模型目录来源。列表端点公开可读，未配置目录凭据时不带 Authorization，仍可展示可核实目录；
 * 但「目录收录」不等于认证、能力或额度可用，调用凭据是否可用由阶段 C 的真实外呼另行证明。
 * 首版按单次有界读取并**要求得到整份目录**；如来源改为分页须显式扩展并继续施加上限，不能无界抓取，
 * 也不能把某页当整份发布（见 assertCompletePage）。
 */
export function createOpenRouterCatalogSource(
  config: ModelCatalogConfig,
  transport: ModelFetchDependencies = {},
): CatalogSourcePort {
  const doFetch = guardedModelFetch(config.baseUrl, transport);
  const url = `${config.baseUrl}/models`;
  return {
    async fetchCatalog(signal: AbortSignal): Promise<readonly unknown[]> {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (config.apiKey !== undefined) headers.authorization = `Bearer ${config.apiKey}`;
      let response: Response;
      try {
        response = await doFetch(url, { method: 'GET', headers, redirect: 'error', signal });
      } catch (error) {
        throw classifyThrown(error);
      }
      if (response.status === 401 || response.status === 403) throw new CatalogSourceError('AUTH');
      if (response.status === 429) throw new CatalogSourceError('RATE_LIMIT');
      if (!response.ok) throw new CatalogSourceError('PROTOCOL', `unexpected status ${response.status}`);
      let text: string;
      try {
        text = await readBoundedText(response, config.maxBodyBytes);
      } catch (error) {
        throw classifyThrown(error);
      }
      let parsed: unknown;
      try { parsed = JSON.parse(text); }
      catch { throw new CatalogSourceError('PROTOCOL', 'catalog response is not valid JSON'); }
      const envelope = (parsed !== null && typeof parsed === 'object')
        ? parsed as Record<string, unknown> : {};
      const data = envelope.data;
      if (!Array.isArray(data)) throw new CatalogSourceError('INCOMPLETE', 'catalog data is not a complete array');
      assertCompletePage(envelope, data.length);
      if (data.length > config.maxEntries) throw new CatalogSourceError('INCOMPLETE', 'catalog exceeded the entry bound');
      return data;
    },
  };
}

/** 可控 Fake 来源：单测注入固定条目或直接抛出类型化失败，不触碰真实网络。 */
export function createFakeCatalogSource(
  impl: (signal: AbortSignal) => Promise<readonly unknown[]>,
): CatalogSourcePort {
  return { fetchCatalog: impl };
}
