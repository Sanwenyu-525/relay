/**
 * 会话模型选择的纯决策（专项阶段 C）。
 *
 * 只做一件事：把用户请求的模型标识确定地解析成「落到哪一枚已登记连接、是否仅免费、
 * 带哪份目录依据」，或给出一个类型化拒绝。它不读数据库、不调模型、不写存储、不改默认——
 * 因此「未知型号」「收费型号」「未配置目录」都不会被偷偷接成一次外呼（FM-05/FM-06）。
 *
 * 客户端只能选两类已登记对象：
 *   1. 原默认连接上已配置的模型（沿用其指纹，freeOnly=false，不受免费目录影响）；
 *   2. 当前目录快照里**严格免费**的 OpenRouter 型号（connection=openrouter，freeOnly=true，
 *      带 snapshot_seq/source_model_id 依据）。
 * 收费的 OpenRouter 型号、目录外型号一律拒绝；本专项不建收费调用，也不建通用连接平台。
 */

export interface CatalogModelSummary {
  readonly source_model_id: string;
  readonly is_free: boolean;
}

export interface CatalogInput {
  readonly snapshotSeq: string;
  readonly models: readonly CatalogModelSummary[];
}

export interface ResolveSelectionInput {
  readonly requested: string;
  /** 进程已配置的默认模型名（RELAY_MODEL_NAME）；未配置真实默认连接时缺省。 */
  readonly defaultModel?: string | undefined;
  readonly catalog?: CatalogInput | undefined;
}

export type ResolvedModelSelection = {
  readonly connection: 'default';
  readonly model: string;
  readonly freeOnly: false;
  readonly catalogSource: null;
  readonly catalogSnapshotSeq: null;
  readonly catalogModelId: null;
} | {
  readonly connection: 'openrouter';
  readonly model: string;
  readonly freeOnly: true;
  readonly catalogSource: 'openrouter';
  readonly catalogSnapshotSeq: string;
  readonly catalogModelId: string;
};

export type ModelSelectionRejection =
  | { readonly code: 'MODEL_NOT_REGISTERED'; readonly detail: string }
  | { readonly code: 'MODEL_PAID_NOT_AVAILABLE'; readonly detail: string };

export type ResolveSelectionResult =
  | { readonly ok: true; readonly selection: ResolvedModelSelection }
  | { readonly ok: false; readonly rejection: ModelSelectionRejection };

/** 命中默认连接的模型名做大小写/空白无关比较，与连接登记的确切 ID 仍原样返回。 */
function sameModel(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function resolveModelSelection(input: ResolveSelectionInput): ResolveSelectionResult {
  const requested = input.requested.trim();
  if (requested === '') {
    return { ok: false, rejection: { code: 'MODEL_NOT_REGISTERED',
      detail: '需要一个模型名；/model <模型名>。' } };
  }
  if (requested.toLowerCase() === 'openrouter/free') {
    return { ok: false, rejection: { code: 'MODEL_NOT_REGISTERED',
      detail: '不能选择 openrouter/free 随机路由；请从目录选择一个具体模型 ID。' } };
  }
  // 1) 原默认连接上已配置的模型：继续可用，freeOnly=false，不受免费目录故障影响。
  if (input.defaultModel !== undefined && sameModel(requested, input.defaultModel)) {
    return { ok: true, selection: {
      connection: 'default', model: input.defaultModel,
      freeOnly: false, catalogSource: null, catalogSnapshotSeq: null, catalogModelId: null } };
  }
  // 2) 严格免费的 OpenRouter 型号：只有当前目录快照里有且判免费才可选。
  const entry = input.catalog?.models.find((model) => model.source_model_id === requested);
  if (entry === undefined) {
    return { ok: false, rejection: { code: 'MODEL_NOT_REGISTERED',
      detail: `“${requested}”既不是本实例已配置的默认模型，也不在当前免费模型目录快照里；`
        + '客户端只能选已登记连接上的模型。' } };
  }
  if (entry.is_free !== true) {
    return { ok: false, rejection: { code: 'MODEL_PAID_NOT_AVAILABLE',
      detail: `目录里的“${requested}”不是严格免费型号；本功能不发起收费调用，也不自动换成其他型号。` } };
  }
  return { ok: true, selection: {
    connection: 'openrouter', model: requested, freeOnly: true,
    catalogSource: 'openrouter', catalogSnapshotSeq: input.catalog!.snapshotSeq,
    catalogModelId: requested } };
}
