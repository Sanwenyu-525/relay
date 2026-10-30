import type { JsonObject } from '../infrastructure/json.js';
import type { AssistRequest } from '../workflow/fake-model-port.js';
import { readInternalTool } from '../workflow/tool-catalog.js';

/**
 * 一次模型调用的**上下文构成**统计（2026-10-30）。
 *
 * 为什么必须在这里算：Provider 只回一个 `input_tokens` 总量，它说明这一轮一共送进去多少，
 * 但说不了「这些 token 是历史消息、系统指令，还是刚读进来的文件」。把总量平均分摊到几个
 * 分类只是把总量换个说法，不是构成。真正可追溯的做法只有一个——在**装配请求**的那一刻，
 * 按每一段内容的来源分类累加，然后随那次调用一起存下来。
 *
 * 因此这份统计的口径是「请求里实际存在的文本字节」：
 *   * 只统计真的进了本次请求的内容（读过但没进 Prompt 的文件不在这里）；
 *   * 每个片段只归一个分类，文件读取与工具调用按工具能力互斥，不重复计；
 *   * 数值是**估算**：UTF-8 字节 / 3，与 `OpenAiCompatibleModelPort` 的外呼前容量检查
 *     同一个换算，所以它和端口的预算判定一致；但它不是 Provider 的分词结果，
 *     快照里 `precision` 恒为 `ESTIMATED`，界面必须照此标注；
 *   * 缓存读取 token 是输入量的缓存维度，不参与构成加总（它不额外占上下文）。
 *
 * 不保存任何正文：只有分类键、字节数与估算 token。系统提示词、文件内容、工具输出、
 * 隐私路径与凭据一次都不进这张表。
 */

export const CONTEXT_USAGE_CATEGORIES = ['HISTORY', 'SYSTEM', 'TOOLS', 'FILE_READS',
  'MEMORY', 'OTHER'] as const;
export type ContextUsageCategory = (typeof CONTEXT_USAGE_CATEGORIES)[number];

/** 分类的固定顺序：界面上按这个顺序排，不随统计顺序跳动。 */
export const CONTEXT_USAGE_CATEGORY_ORDER: readonly ContextUsageCategory[] = CONTEXT_USAGE_CATEGORIES;

export interface ContextUsageEntry {
  readonly key: ContextUsageCategory;
  readonly bytes: number;
  readonly tokens: number;
}

export interface ContextUsageSnapshot {
  readonly version: 1;
  /** 换算方法。写进快照，读侧不需要猜这份数字是怎么来的。 */
  readonly method: 'UTF8_BYTES_DIV_3';
  readonly precision: 'ESTIMATED';
  readonly categories: readonly ContextUsageEntry[];
  readonly estimated_total_tokens: number;
  readonly covered_bytes: number;
  /**
   * 请求里无法用文本字节换算的部分（当前只有图片片段）。
   *
   * 图片是多模态 parts，token 由 Provider 的图像编码决定，`bytes / 3` 对它没有意义。
   * 因此这里只记条数，说明「估算没有覆盖这些片段」，不把它们塞进任何一个分类凑数。
   */
  readonly image_parts: number;
}

/**
 * 把一段文本计入某个分类。
 *
 * 用累加器而不是先收集字符串：分类只关心规模，收集正文会让这份统计本身变成又一份
 * 「可能泄漏内容」的缓存。
 */
class ContextUsageBuilder {
  readonly #bytes = new Map<ContextUsageCategory, number>();
  #imageParts = 0;

  add(category: ContextUsageCategory, text: string | null | undefined): void {
    if (text === null || text === undefined || text === '') return;
    this.#bytes.set(category, (this.#bytes.get(category) ?? 0) + Buffer.byteLength(text, 'utf8'));
  }

  addBytes(category: ContextUsageCategory, bytes: number): void {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    this.#bytes.set(category, (this.#bytes.get(category) ?? 0) + Math.ceil(bytes));
  }

  addImages(count: number): void {
    if (Number.isInteger(count) && count > 0) this.#imageParts += count;
  }

  build(): ContextUsageSnapshot {
    const categories: ContextUsageEntry[] = [];
    let covered = 0;
    let estimated = 0;
    for (const key of CONTEXT_USAGE_CATEGORY_ORDER) {
      const bytes = this.#bytes.get(key) ?? 0;
      if (bytes === 0) continue;
      const tokens = estimateTokens(bytes);
      covered += bytes;
      estimated += tokens;
      categories.push({ key, bytes, tokens });
    }
    return { version: 1, method: 'UTF8_BYTES_DIV_3', precision: 'ESTIMATED', categories,
      estimated_total_tokens: estimated, covered_bytes: covered, image_parts: this.#imageParts };
  }
}

/** 与模型端口的容量检查同一个换算（UTF-8 字节 / 3，向上取整）。 */
export function estimateTokens(bytes: number): number {
  return bytes <= 0 ? 0 : Math.ceil(bytes / 3);
}

/**
 * 累积上下文注入的标记。
 *
 * 历史窗口里有几段内容不是「对话」，而是被注入的材料：压缩摘要、Skill 输入与依据、
 * 资料正文。它们在装配时由 `buildGenerationInput` 写进普通 user turn，从请求上看不出
 * 区别。与其在统计时按正文前缀猜（正文可由用户构造，猜错就把用户的话算成系统注入），
 * 不如在装配时**显式登记**这一轮里哪些 turn 属于注入——这里只保存下标与分类，
 * 不保存内容。
 */
export interface ContextUsageHints {
  /**
   * 以 turn 下标为键的分类覆盖：装配方明确知道那一段是被注入的记忆/资料。
   * 下标越界或缺失时按普通历史消息计，不做前缀匹配。
   */
  readonly turnCategories?: Readonly<Record<number, ContextUsageCategory>>;
}

/**
 * 只接受已知分类键。
 *
 * 请求上的 `contextUsage` 是结构化形状（端口不认识分类，见 `AssistRequest`），
 * 读进来时按白名单过滤：写坏一个键只会退回「历史消息」，不会让整份统计抛错。
 */
function normalizeHints(
  hints: { readonly turnCategories?: Readonly<Record<number, string>> } | undefined,
): Readonly<Record<number, ContextUsageCategory>> {
  const raw = hints?.turnCategories;
  if (raw === undefined) return {};
  const accepted: Record<number, ContextUsageCategory> = {};
  for (const [key, value] of Object.entries(raw)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0) continue;
    if (!(CONTEXT_USAGE_CATEGORIES as readonly string[]).includes(value)) continue;
    accepted[index] = value as ContextUsageCategory;
  }
  return accepted;
}

/**
 * 把一次真实请求拆成分类统计。
 *
 * 分类规则（互斥、可解释）：
 *   * `SYSTEM`——`system` 全文（含运行模式模板、能力事实块、插话规则、在途执行说明）；
 *   * `HISTORY`——`turns` 里的对话双方内容，以及会话中途插入的用户插话；
 *   * `TOOLS`——本轮声明的工具规格、模型自己发出的工具调用参数、工具轮次的前置说明与推理，
 *     以及**非文件类**工具结果；
 *   * `FILE_READS`——文件类只读工具（FILE_QUERY / FILE_READ / GIT_READ 能力）返回的结果；
 *     与 `TOOLS` 按工具能力二选一，同一段结果不会两边都算；
 *   * `MEMORY`——装配方登记的注入段（压缩摘要、Skill 输入与依据、资料正文）；
 *   * `OTHER`——确实发送给模型、但不属于上述任何一类的内容（收尾指令、方法输入块）。
 */
export function describeAssistRequestContext(request: AssistRequest,
  hints?: ContextUsageHints): ContextUsageSnapshot {
  const builder = new ContextUsageBuilder();
  builder.add('SYSTEM', request.system);
  const overrides = normalizeHints(hints ?? request.contextUsage);
  request.turns.forEach((turn, index) => {
    const category = overrides[index] ?? 'HISTORY';
    builder.add(category, turn.content);
    const parts = (turn as { readonly parts?: readonly unknown[] }).parts;
    if (Array.isArray(parts)) builder.addImages(parts.length);
  });
  for (const spec of request.tools ?? []) {
    builder.add('TOOLS', spec.name);
    builder.add('TOOLS', spec.description);
    builder.add('TOOLS', JSON.stringify(spec.parameters));
  }
  for (const turn of request.toolTurns ?? []) {
    for (const steer of turn.steersBefore ?? []) builder.add('HISTORY', steer);
    builder.add('TOOLS', turn.preamble);
    builder.add('TOOLS', turn.reasoningContent);
    for (const call of turn.calls) {
      builder.add('TOOLS', call.name);
      builder.add('TOOLS', JSON.stringify(call.arguments));
    }
    for (const result of turn.results) {
      builder.add(toolResultCategory(result.name), result.content);
    }
  }
  for (const steer of request.steers ?? []) builder.add('HISTORY', steer);
  /*
   * `request.skill` **不计入**：端口（`assistMessages`）只发送 system + turns + toolTurns +
   * steers，Skill 的输入与依据已经由应用层渲染进 turns（`【Skill 输入｜UNTRUSTED_DATA】…`
   * 与 basis.section）。再把 facts/input 加一遍就是把同一段内容累计两次，
   * 而 facts 本身根本不会发给 Provider。Skill 段因此只按 turns 里的那一段落账。
   */
  return builder.build();
}

/**
 * 工具结果归属：文件类只读工具算「文件读取」，其余算「工具调用」。
 *
 * 判据取词表里的 capability 而不是工具名清单——新增一个读文件工具时不会因为忘记
 * 加进某个数组而把文件正文记成工具调用。词表里没有的名字（委派等应用内动作）按
 * 工具调用计，那是它们真实的性质。
 */
export function toolResultCategory(name: string): ContextUsageCategory {
  const definition = readInternalTool(name);
  if (definition === undefined) return 'TOOLS';
  return definition.capability === 'FILE_QUERY' || definition.capability === 'FILE_READ' ||
    definition.capability === 'GIT_READ' ? 'FILE_READS' : 'TOOLS';
}

/** 写进 `model_calls.context_usage` 的形状（camelCase 键统一成 snake_case）。 */
export function contextUsageToJson(snapshot: ContextUsageSnapshot): JsonObject {
  return { version: snapshot.version, method: snapshot.method,
    precision: snapshot.precision,
    categories: snapshot.categories.map((entry) => ({ key: entry.key, bytes: entry.bytes,
      tokens: entry.tokens })),
    estimated_total_tokens: snapshot.estimated_total_tokens,
    covered_bytes: snapshot.covered_bytes, image_parts: snapshot.image_parts };
}

/**
 * 读回一份快照。
 *
 * 读侧按「结构不认识就当没有」处理：旧行没有这一列、或将来换了版本，都只是
 * 「这次调用没有分项统计」，不能让整块用量面板读不出来。数值一律重新核对，
 * 不信任库里可能被手改的 tokens。
 */
export function readContextUsageSnapshot(value: unknown): ContextUsageSnapshot | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  if (object.version !== 1 || object.method !== 'UTF8_BYTES_DIV_3') return null;
  const raw = object.categories;
  if (!Array.isArray(raw)) return null;
  const categories: ContextUsageEntry[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.key !== 'string' ||
        !(CONTEXT_USAGE_CATEGORIES as readonly string[]).includes(row.key)) continue;
    if (!Number.isSafeInteger(row.bytes) || (row.bytes as number) < 0) continue;
    if (!Number.isSafeInteger(row.tokens) || (row.tokens as number) < 0) continue;
    categories.push({ key: row.key as ContextUsageCategory, bytes: row.bytes as number,
      tokens: row.tokens as number });
  }
  const total = categories.reduce((sum, entry) => sum + entry.tokens, 0);
  return { version: 1, method: 'UTF8_BYTES_DIV_3', precision: 'ESTIMATED',
    categories, estimated_total_tokens: total,
    covered_bytes: categories.reduce((sum, entry) => sum + entry.bytes, 0),
    image_parts: Number.isSafeInteger(object.image_parts) ? object.image_parts as number : 0 };
}
