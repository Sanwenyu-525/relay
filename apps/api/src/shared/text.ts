/**
 * 入口文本校验：物理设计第 1 节规定“文本大小限制由入口验证”。
 * 这里的上限是入口约束（不写进 CHECK，避免迁移调整需要改约束）；超限与空值都由用例拒绝，
 * 不接受只改前端的“软限制”。
 */
export const TEXT_LIMITS = {
  title: 200,
  objective: 2000,
  criterionStatement: 500,
  criterionId: 64,
  goalTitle: 200,
  goalDescription: 2000,
  riskStatement: 500,
  sourceRef: 200,
  confirmationRef: 200,
  phaseKey: 64,
  reason: 500,
  /** P03：人工接受陈述（完成命令里的 acceptance.statement）。 */
  acceptanceStatement: 500,
} as const;

/** 期望输出等受约束参数快照的最大序列化长度（字符），避免把大对象塞进命令体。 */
export const MAX_JSON_SPEC_CHARS = 4096;

export type TextLimit = keyof typeof TEXT_LIMITS;

export interface TextProblem {
  readonly field: string;
  readonly message: string;
}

/** 去除首尾空白后校验：空值、超长与不可见字符返回 problem，调用方转成字段错误。 */
export function checkRequiredText(
  value: string,
  field: string,
  limit: TextLimit,
): TextProblem | undefined {
  const trimmed = value.trim();

  if (trimmed === '') {
    return { field, message: 'must not be empty' };
  }

  if (trimmed.length > TEXT_LIMITS[limit]) {
    return { field, message: `must be at most ${TEXT_LIMITS[limit]} characters` };
  }

  if (containsControlCharacters(trimmed)) {
    return { field, message: 'must not contain control characters' };
  }

  return undefined;
}

export function checkOptionalText(
  value: string,
  field: string,
  limit: TextLimit,
): TextProblem | undefined {
  const trimmed = value.trim();

  if (trimmed === '') {
    return undefined;
  }

  return checkRequiredText(value, field, limit);
}

/** 规范化：入库与命令摘要都使用同一个已去空白的结果，保证重放摘要稳定。 */
export function normalizeText(value: string): string {
  return value.trim();
}

function containsControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;

    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }

  return false;
}