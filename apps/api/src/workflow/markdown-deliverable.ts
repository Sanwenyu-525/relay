import type { RunStepKind } from '../infrastructure/database-schema.js';

/**
 * 内置固定 Workflow `markdown-deliverable-v1`（docs/architecture/runtime-context.md 第 2 节）。
 *
 * 本模块只声明固定步骤序列与候选 Markdown 的结构校验，不引入任意图结构或通用 Workflow Builder。
 * P05 执行前三个步骤；VERIFY/COMPLETE 自 P06 起由 Verification 与完成 Gate 执行。
 * Runtime 不得写 Task DONE，也不得伪造 PASS：候选产物只有在 VERIFY 总决策 PASS 后，才由 COMPLETE
 * 步骤按完成 Gate 提交业务完成。
 */

export const WORKFLOW_KEY = 'markdown-deliverable-v1';
export const WORKFLOW_VERSION = '1';
export const DEFAULT_EXECUTION_CONFIG_VERSION = 'default-execution-config-v1';

/**
 * Delegate 请求里的版本选择器唯一接受的标识。
 *
 * P05 只有内置固定 Workflow，没有 ExecutionConfiguration 表，因此 `workflow_version_id` 与
 * `execution_config_version_id` 只能等于内置默认值；给出其他值一律 CAPABILITY_DISABLED。
 * 这是本阶段的取舍：不提前建设版本化配置平台。
 */
export const BUILT_IN_WORKFLOW_VERSION_ID = WORKFLOW_KEY;
export const BUILT_IN_EXECUTION_CONFIG_VERSION_ID = DEFAULT_EXECUTION_CONFIG_VERSION;

/** 固定步骤序列；每个 Run 创建时按此顺序写入 run_steps，全部初始 PENDING。 */
export const WORKFLOW_STEPS: readonly RunStepKind[] = [
  'BUILD_CONTEXT',
  'DRAFT',
  'PERSIST_CANDIDATE',
  'VERIFY',
  'COMPLETE',
];

/** P05 实际执行的步骤；VERIFY/COMPLETE 自 P06 起由 Verification 与完成 Gate 执行。 */
export const P05_EXECUTED_STEP_KINDS: readonly RunStepKind[] = [
  'BUILD_CONTEXT',
  'DRAFT',
  'PERSIST_CANDIDATE',
];

/** P06 起执行的步骤（Verification 与自动完成 Gate）。 */
export const P06_EXECUTED_STEP_KINDS: readonly RunStepKind[] = [
  'VERIFY',
  'COMPLETE',
];

export const ALL_EXECUTED_STEP_KINDS: readonly RunStepKind[] = [
  ...P05_EXECUTED_STEP_KINDS,
  ...P06_EXECUTED_STEP_KINDS,
];

/** 候选 Markdown 的输出 schema 名（进入 ModelPort 请求，Fake 只按它返回受约束结果）。 */
export const CANDIDATE_OUTPUT_SCHEMA = 'markdown-deliverable-candidate-v1';

/** 候选 Markdown 的固定必需二级标题（去空白后精确匹配）。 */
export const REQUIRED_SECTIONS: readonly string[] = ['摘要', '结论'];

/** 候选正文的最小长度（字符）：过短的“输出”不能当作可验证候选。 */
export const MIN_CANDIDATE_CHARS = 20;

export type CandidateValidationIssueCode =
  | 'MISSING_TITLE'
  | 'MISSING_SECTION'
  | 'EMPTY_SECTION'
  | 'TOO_SHORT';

export interface CandidateValidationIssue {
  readonly code: CandidateValidationIssueCode;
  readonly detail: string;
}

export interface CandidateValidation {
  readonly ok: boolean;
  readonly issues: readonly CandidateValidationIssue[];
}

interface Heading {
  readonly level: number;
  readonly text: string;
  readonly lineIndex: number;
}

/**
 * 候选 Markdown 的确定性结构校验：必需一级标题、必需二级节、非空节体、最小长度。
 *
 * 同一输入永远得到同一结论；不调用模型，也不依赖随机或时间。DRAFT 步骤在 Fake 返回 CONTENT 后
 * 仍会再跑一次该校验，作为“模型输出只变成受约束结果”的防线。
 */
export function validateCandidate(content: string): CandidateValidation {
  const issues: CandidateValidationIssue[] = [];
  const trimmed = content.trim();
  const lines = trimmed.split(/\r?\n/u);
  const headings = collectHeadings(lines);

  if (!headings.some((heading) => heading.level === 1 && heading.text !== '')) {
    issues.push({
      code: 'MISSING_TITLE',
      detail: '候选正文缺少一级标题（# 标题）。',
    });
  }

  if (trimmed.length < MIN_CANDIDATE_CHARS) {
    issues.push({
      code: 'TOO_SHORT',
      detail: `候选正文长度必须不少于 ${MIN_CANDIDATE_CHARS} 个字符。`,
    });
  }

  for (const section of REQUIRED_SECTIONS) {
    const heading = headings.find(
      (candidate) => candidate.level === 2 && candidate.text === section,
    );

    if (heading === undefined) {
      issues.push({
        code: 'MISSING_SECTION',
        detail: `候选正文缺少必需小节：## ${section}。`,
      });
      continue;
    }

    if (sectionBody(lines, headings, heading).trim() === '') {
      issues.push({
        code: 'EMPTY_SECTION',
        detail: `候选小节 ## ${section} 的内容为空。`,
      });
    }
  }

  return { ok: issues.length === 0, issues };
}

function collectHeadings(lines: readonly string[]): readonly Heading[] {
  const headings: Heading[] = [];

  lines.forEach((line, lineIndex) => {
    const match = /^(#{1,6})\s+(.*)$/u.exec(line);

    if (match !== null) {
      headings.push({
        level: (match[1] ?? '').length,
        text: (match[2] ?? '').trim(),
        lineIndex,
      });
    }
  });

  return headings;
}

/** 取某个标题到下一个同级或更高级标题之间的正文行。 */
function sectionBody(
  lines: readonly string[],
  headings: readonly Heading[],
  heading: Heading,
): string {
  const nextBoundary = headings.find(
    (candidate) => candidate.lineIndex > heading.lineIndex && candidate.level <= heading.level,
  );
  const end = nextBoundary === undefined ? lines.length : nextBoundary.lineIndex;

  return lines.slice(heading.lineIndex + 1, end).join('\n');
}
