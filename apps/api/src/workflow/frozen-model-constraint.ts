/**
 * 会话/请求冻结后随调用携带的**非密钥**模型约束快照（免费模型专项 · 阶段 C）。
 *
 * 设计边界见 runtime-context §8.6：新请求在准入时冻结「有效连接、确切模型 ID、参数/预算、
 * 免费约束和目录依据」；Workflow 创建 Run 时保存该快照，续轮、重试、重启按快照恢复，
 * 不临时读取当前会话选择，也不把升级时的当前配置倒造为原冻结配置。
 *
 * 这里只定义快照的形状与严格解析，不含密钥：密钥只在服务端按引用解析。
 * 解析对「缺省（旧 Run/旧会话无快照）」返回 undefined，调用方据此保留原默认行为——
 * 不能伪造模型身份或免费约束（§8 停止条件、FM-06 旧 Run 兼容）。
 */

/** 配置指纹：与 ModelIdentity.configFingerprint 同算法（sha256 hex，不含密钥明文）。 */
const HEX64 = /^[0-9a-f]{64}$/u;
const DIGITS = /^[0-9]+$/u;

/** 冻结的调用连接引用：足以指向一次具体登记连接，但不含任何凭据。 */
export interface FrozenModelConnection {
  readonly provider: string;
  /** 冻结时选定的**确切**模型 ID；续轮/重启按此恢复，不换成目录里的其他型号。 */
  readonly model: string;
  /** 冻结时的配置指纹；连接配置变化后指纹不符，旧快照不能沿用新配置。 */
  readonly configFingerprint: string;
}

/** 冻结时的调用预算（对应 ModelIdentity.budget）；缺省表示沿用端口进程配置。 */
export interface FrozenModelBudget {
  readonly callReservationTokens: number;
  readonly scopeCallLimit: number;
  readonly scopeTokenLimit: number;
}

/** 免费判定的目录依据：来自哪个来源、哪一版快照、哪个目录模型 ID。原默认连接无此项。 */
export interface FrozenCatalogBasis {
  readonly source: 'openrouter';
  /** 已成功发布的快照序号（model_catalog_sync_state.snapshot_seq），字符串避免精度丢失。 */
  readonly snapshotSeq: string;
  readonly sourceModelId: string;
}

/**
 * 冻结约束：随每次模型外呼读取的免费准入依据。
 *
 * `freeOnly` 为 true 才强制零价格硬限制；false 或缺省（无快照）保持原默认行为，
 * 不受免费目录故障影响。「未知」用 undefined 表达，不用 false 冒充已知非免费。
 */
export interface FrozenModelConstraint {
  readonly connection: FrozenModelConnection;
  readonly freeOnly: boolean;
  readonly catalogBasis: FrozenCatalogBasis | null;
  readonly budget?: FrozenModelBudget;
}

/** 校验冻结快照的合法形状并原样返回；任何越界或畸形一律判为不合法。 */
export class FrozenModelConstraintError extends Error {
  override readonly name = 'FrozenModelConstraintError';
  constructor(readonly issues: readonly string[]) {
    super(`invalid frozen model constraint: ${issues.join('; ')}`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function positiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * 严格解析冻结快照。
 *
 * `undefined`/`null` 返回 `undefined`（旧数据兼容：不伪造，调用方保留原默认）。
 * 传入值必须是完整合法的对象，否则抛 `FrozenModelConstraintError`——
 * 半截或畸形快照不能升级为「免费」或「确切模型」的判定。
 */
export function parseFrozenModelConstraint(value: unknown):
  FrozenModelConstraint | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) throw new FrozenModelConstraintError(['constraint is not an object']);
  const issues: string[] = [];
  const connection = value.connection;
  if (!isPlainObject(connection)) {
    issues.push('connection is required and must be an object');
  } else {
    if (!nonEmptyString(connection.provider)) issues.push('connection.provider must be non-empty');
    if (!nonEmptyString(connection.model)) issues.push('connection.model must be a concrete model id');
    if (!(typeof connection.configFingerprint === 'string' && HEX64.test(connection.configFingerprint)))
      issues.push('connection.configFingerprint must be 64 lowercase hex');
  }
  // freeOnly 允许缺省（视为无免费约束），但给出就必须是布尔——不能用字符串或数字冒充。
  if (value.freeOnly !== undefined && value.freeOnly !== null &&
      typeof value.freeOnly !== 'boolean') {
    issues.push('freeOnly must be a boolean when present');
  }
  const catalogBasis = value.catalogBasis;
  if (catalogBasis !== undefined && catalogBasis !== null && !isPlainObject(catalogBasis)) {
    issues.push('catalogBasis must be an object or null');
  } else if (isPlainObject(catalogBasis)) {
    if (catalogBasis.source !== 'openrouter') issues.push('catalogBasis.source must be openrouter');
    if (!(typeof catalogBasis.snapshotSeq === 'string' && DIGITS.test(catalogBasis.snapshotSeq)))
      issues.push('catalogBasis.snapshotSeq must be a digits string');
    if (!nonEmptyString(catalogBasis.sourceModelId))
      issues.push('catalogBasis.sourceModelId must be non-empty');
  }
  const budget = value.budget;
  if (budget !== undefined && budget !== null) {
    if (!isPlainObject(budget)) issues.push('budget must be an object when present');
    else {
      if (!positiveInt(budget.callReservationTokens))
        issues.push('budget.callReservationTokens must be a positive integer');
      if (!positiveInt(budget.scopeCallLimit))
        issues.push('budget.scopeCallLimit must be a positive integer');
      if (!positiveInt(budget.scopeTokenLimit))
        issues.push('budget.scopeTokenLimit must be a positive integer');
    }
  }
  if (issues.length > 0) throw new FrozenModelConstraintError(issues);

  const parsedConnection = connection as FrozenModelConnection;
  const parsed: FrozenModelConstraint = {
    connection: { provider: parsedConnection.provider, model: parsedConnection.model,
      configFingerprint: parsedConnection.configFingerprint },
    freeOnly: value.freeOnly === true,
    catalogBasis: isPlainObject(catalogBasis) ? catalogBasis as unknown as FrozenCatalogBasis : null,
  };
  if (budget !== undefined && budget !== null) {
    return { ...parsed, budget: budget as FrozenModelBudget };
  }
  return parsed;
}
