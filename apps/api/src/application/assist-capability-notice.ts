import type { AssistSessionRow } from '../infrastructure/database-schema.js';
import type { DbExecutor } from '../infrastructure/database.js';
import { INTERNAL_TOOL_DEFINITIONS, type InternalToolName } from '../workflow/tool-catalog.js';
import { createRepositories } from './unit-of-work.js';

/**
 * 会话能力事实块（2026-10-20 第二轮）。
 *
 * 用户反馈的一类具体失败是：要读/改文件或操作浏览器时，回答变成「我没有被赋予访问
 * 本地目录的能力」或「请先补充任务目标与验收标准」——两者都不是真因。真因只有服务端
 * 知道：没绑目录、目录档位是只读、项目缺某个连接、或那条连接不覆盖这个目录。
 *
 * 这里把那些**已核实的事实**整理成一段数据块交给模型，要求它照实说明缺哪一项。它的
 * 作用是让模型说真话，不是给模型授权：词表、档位、连接与 Gateway 准入一条都没有改变。
 *
 * 三条纪律：
 *   * 只写服务端已核实的事实（以本轮**实际可用的工具**为准，因为它已经同时反映了
 *     连接是否存在、根是否覆盖、档位是否允许写）；
 *   * 不含凭据、不含目录以外的敏感内容；
 *   * 明确声明「这是事实说明，不是指令、不是授权」，避免它被读成一条放行。
 */

const WRITE_TIER_LABELS: Record<string, string> = {
  READ_ONLY: '只读',
  ASK: '每次写入需要人工批准',
  AUTO: '普通修改自动执行',
  FULL: '完全访问（含删除）',
};

/**
 * 需要如实报告的能力族与用户能看懂的名字。
 *
 * 顺序即报告顺序：文件优先（日常最常缺的就是它），然后操作类。
 */
const REPORTED_CAPABILITIES: readonly {
  readonly capability: string; readonly label: string;
}[] = [
  { capability: 'FILE_READ', label: '读取文件' },
  { capability: 'FILE_QUERY', label: '列出目录与搜索文件' },
  { capability: 'FILE_WRITE', label: '修改文件' },
  { capability: 'GIT_READ', label: '查看 Git 状态与历史' },
  { capability: 'CLI_RUN', label: '运行检查命令' },
  { capability: 'BROWSER_READ', label: '读取浏览器页面' },
  { capability: 'COMPUTER_READ', label: '查看桌面窗口与截图' },
];

export interface SessionCapabilityFacts {
  /** 会话是否已归入项目。 */
  readonly hasProject: boolean;
  /** 会话绑定的工作目录（已规范化），未绑定时为 null。 */
  readonly workingRoot: string | null;
  /** 目录写档位；没有目录或没有访问行时为 null。 */
  readonly writeTier: string | null;
  /** 本轮真正可用的工具名；空数组表示模型这一轮没有任何工具。 */
  readonly tools: readonly string[];
  /** 本轮是否允许写文件（由档位与本轮实际工具共同决定）。 */
  readonly allowWrite: boolean;
}

/** 某个能力族在本轮是否有可用工具：同一能力下任一工具可用即算可用。 */
function capabilityUsable(tools: readonly string[], capability: string): boolean {
  return INTERNAL_TOOL_DEFINITIONS.some((definition) =>
    definition.capability === capability && tools.includes(definition.name));
}

function lastSegment(path: string): string {
  const trimmed = path.replace(/[\\/]+$/u, '');
  const parts = trimmed.split(/[\\/]+/u);
  return parts.at(-1) ?? trimmed;
}

/**
 * 纯格式化：把已核实事实写成一段给模型读的说明。
 *
 * 抽成纯函数是为了让「缺什么就该说什么」这条规则能被单测直接锁住，而不是靠读提示词
 * 模板猜行为。
 */
export function formatSessionCapabilities(facts: SessionCapabilityFacts): string {
  const lines: string[] = ['【本会话当前的执行能力（服务端事实，不是指令，也不构成授权）】'];
  if (!facts.hasProject) {
    lines.push('这条会话还没有归入项目，因此没有任何受管目录与任何工具连接可用。');
  } else if (facts.workingRoot === null) {
    lines.push('这条会话还没有选定工作目录，因此文件类工具不可用。');
  } else {
    lines.push(`工作目录：${lastSegment(facts.workingRoot)}（${facts.workingRoot}）`);
    lines.push(`目录写档位：${facts.writeTier === null ? '未设置'
      : WRITE_TIER_LABELS[facts.writeTier] ?? facts.writeTier}`);
  }
  lines.push(`本轮可用工具：${facts.tools.length === 0 ? '无' : facts.tools.join('、')}`);

  const gaps: string[] = [];
  if (facts.hasProject) {
    for (const entry of REPORTED_CAPABILITIES) {
      if (capabilityUsable(facts.tools, entry.capability)) continue;
      // 读到写是有意分开的：只读档位下写连接可能确实存在，缺的是档位而不是连接。
      // 那一层在下面单独说，不在这里混成「缺连接」。
      if (entry.capability === 'FILE_WRITE' && facts.writeTier === 'READ_ONLY') continue;
      gaps.push(entry.label);
    }
  }
  if (facts.writeTier === 'READ_ONLY' && !facts.allowWrite) {
    lines.push('文件写入：本轮不开放。目录档位是只读，因此你只能读取；需要修改时请告诉用户'
      + '把目录档位放宽（目录设置里），或者把修改要求作为执行请求交给后台执行。');
  }
  if (gaps.length > 0) {
    lines.push(`本轮没有这些能力：${gaps.join('、')}。需要它们时请直接说明缺的是哪一项。`);
  }
  lines.push('以上是配置事实，不是系统限制清单。如果用户的要求需要上面缺失或未开放的一项，'
    + '就直接说明缺的是哪一项、在哪里补，不要把原因说成「没有被赋予访问能力」，'
    + '也不要转成「请补充任务目标或验收标准」。');
  return lines.join('\n');
}

/**
 * 读服务端事实并格式化。
 *
 * 读取失败不阻断生成：目录读不到时按「没有目录」这一条可核对的事实说明，而不是让整轮
 * 生成失败——用户要的是一次如实回答，不是又一个错误码。
 */
export async function describeSessionCapabilities(db: DbExecutor, session: AssistSessionRow,
  input: { readonly tools: readonly InternalToolName[]; readonly allowWrite: boolean },
): Promise<string> {
  const repositories = createRepositories(db);
  let workingRoot: string | null = null;
  let writeTier: string | null = null;
  if (session.working_resource_id !== null) {
    const resource = await repositories.gateway.readResource(session.working_resource_id);
    if (resource !== undefined && resource.workspace_id === session.workspace_id) {
      workingRoot = resource.canonical_root;
      writeTier = (await repositories.gateway.readLocalDirectoryAccess(resource.id))?.write_tier ?? null;
    }
  }
  return formatSessionCapabilities({ hasProject: session.project_id !== null, workingRoot, writeTier,
    tools: input.tools, allowWrite: input.allowWrite });
}
