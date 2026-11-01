import type { AssistSessionRow } from '../infrastructure/database-schema.js';
import type { DbExecutor } from '../infrastructure/database.js';
import { INTERNAL_TOOL_DEFINITIONS, type InternalToolName } from '../workflow/tool-catalog.js';
import { computerRuntimeStatus } from '../plugins/runtime-status.js';
import { resolveMachineAttribution } from './conversation-execution.js';
import { createRepositories } from './unit-of-work.js';
import { findKnownPluginMentions } from './plugin-mentions.js';

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
 * 顺序即报告顺序：文件优先（日常最常缺的就是它），然后检查命令。
 *
 * 这里**只列文件/检查族**（2026-11-01 COMPUTER-PLUGIN-E2E 复核）：
 * BROWSER_READ 与 COMPUTER_READ 也不在会话轮次词表里——观察—操作—再观察属于 Run 的
 * 工具循环。把它们列成「本轮没有这些能力」会让模型以为在连接里补一项就能在对话里
 * 截图或点鼠标；机器插件的可用性由上面的专用两行说明，不混进这份缺口清单。
 */
const REPORTED_CAPABILITIES: readonly {
  readonly capability: string; readonly label: string;
}[] = [
  { capability: 'FILE_READ', label: '读取文件' },
  { capability: 'FILE_QUERY', label: '列出目录与搜索文件' },
  { capability: 'FILE_WRITE', label: '修改文件' },
  { capability: 'GIT_READ', label: '查看 Git 状态与历史' },
  { capability: 'CLI_RUN', label: '运行检查命令' },
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
  /**
   * 工作区是否已登记电脑操控（COMPUTER_INPUT）／浏览器操控（BROWSER_ACTION）连接。
   * 机器插件是安装级资源、按项目登记连接，但会话没归入项目时仍可经执行请求使用；
   * 未归属会话的说明必须以这两项事实为据，不能把「没归入项目」说成「插件不存在」。
   */
  readonly computerPlugin: boolean;
  readonly browserPlugin: boolean;
  /**
   * 该能力只在**别的项目**登记了 ACTIVE 连接（本会话所属项目没有）。
   *
   * 未归属会话可以跨项目借用这条安装级能力；已绑定工作目录的会话不能——执行阶段按
   * 请求行上的项目解析连接。把「别的项目有」写成「本会话可用」会让模型承诺一件
   * 随后被准入拒绝的事，所以这两种事实必须分开说明。
   */
  readonly computerPluginBorrowedOnly?: boolean;
  readonly browserPluginBorrowedOnly?: boolean;
  /**
   * 电脑操控运行时的安装级状态（`computerRuntimeStatus().state`）：READY / NOT_PAIRED /
   * UNAVAILABLE / NOT_INSTALLED / NOT_AUTHENTICATED。未探测时为 undefined。
   *
   * 它与「连接是否登记」是两件事：连接登记在项目里，运行时装在这台机器上。两层都写，
   * 模型才不会把「运行时没就位」说成「没有这项授权」。
   */
  readonly computerRuntimeState?: string | undefined;
}

/** 某个能力族在本轮是否有可用工具：同一能力下任一工具可用即算可用。 */
function capabilityUsable(tools: readonly string[], capability: string): boolean {
  return INTERNAL_TOOL_DEFINITIONS.some((definition) =>
    definition.capability === capability && tools.includes(definition.name));
}

/**
 * 机器插件只有在「本次执行真的能用它」时才算可用。
 *
 * 未归属会话允许借用别的项目登记的安装级插件；已绑定目录的会话只按本项目连接执行。
 * Runtime 缺失对电脑操控同样是否决项。三种事实都由服务端给出，不在这里推断权限。
 */
function machinePluginUsableForSession(facts: SessionCapabilityFacts,
  plugin: 'computer' | 'browser'): boolean {
  const registered = plugin === 'computer' ? facts.computerPlugin : facts.browserPlugin;
  if (!registered) return false;
  if (plugin === 'computer' && facts.computerRuntimeState !== undefined &&
      facts.computerRuntimeState !== 'READY') return false;
  const borrowedOnly = plugin === 'computer'
    ? facts.computerPluginBorrowedOnly === true : facts.browserPluginBorrowedOnly === true;
  return facts.workingRoot === null || !borrowedOnly;
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
    // 2026-10-25：未归属会话不再把「没归入项目」说成「没有任何连接」——电脑/浏览器
    // 插件是安装级资源，跨项目登记也可用；那句话会让用户以为要先补项目才能开浏览器。
    lines.push('这条会话还没有归入项目，因此没有受管目录，文件与 Git 类工具不可用。');
  } else if (facts.workingRoot === null) {
    /*
     * 「没有绑定目录」与「文件工具不可用」不是同一件事，这句却把后者当前者写死了。
     * 人设助手与学习档的来源解析本来就按项目取唯一 ACTIVE 受管根（assistantReadOrigin），
     * 所以没绑目录的会话仍可能真的读到文件；此时再说一句「因此文件类工具不可用」，
     * 模型就会拿着可用的 read_file 却回答读不到——同一段事实块自相矛盾。
     * 推断出来的范围必须标成推断：它是可核对的作用域说明，不是用户确认过的绑定。
     */
    const fileToolsUsable = ['FILE_READ', 'FILE_QUERY', 'GIT_READ'].some(
      (capability) => capabilityUsable(facts.tools, capability));
    lines.push(fileToolsUsable
      ? '这条会话还没有选定工作目录；本轮的文件工具按项目内唯一可用的受管目录读取，'
        + '这是系统推断的作用域，不是用户指定的绑定。请照这个范围回答，不要说成已绑定目录。'
      : '这条会话还没有选定工作目录，因此文件类工具不可用。');
  } else {
    lines.push(`工作目录：${lastSegment(facts.workingRoot)}（${facts.workingRoot}）`);
    lines.push(`目录写档位：${facts.writeTier === null ? '未设置'
      : WRITE_TIER_LABELS[facts.writeTier] ?? facts.writeTier}`);
  }
  lines.push(`本轮可用工具：${facts.tools.length === 0 ? '无' : facts.tools.join('、')}`);
  /*
   * 机器插件两行（2026-11-01 COMPUTER-PLUGIN-E2E）。
   *
   * 原实现只在「会话没有工作目录」时输出这两行。那会让绑定目录的普通会话只看到文件
   * 工具，模型于是把一条明确的电脑操作请求读成普通讨论——真实账本里 `@电脑操控 打开
   * 记事本` 的回复整段是「让我看看本轮可用的工具」正是这条缺口的后果。
   *
   * 现在两行的事实按「本次有没有可用的机器连接」输出，而不是按「有没有目录」输出：
   *   * 未归属会话允许跨项目借用安装级插件；
   *   * 已绑定目录的会话只按本项目连接执行，借用事实必须如实说成不可用。
   * 这一段仍然只是事实说明，不授予任何权限。
   */
  const runtimeUnavailable = facts.computerRuntimeState !== undefined &&
    facts.computerRuntimeState !== 'READY';
  const computerUsable = machinePluginUsableForSession(facts, 'computer');
  if (computerUsable) {
    lines.push('电脑操控：可用。用户明确要求操作电脑（打开应用、点击、输入）时，在 execution 里带 '
      + 'interaction="COMPUTER" 作为执行候选交给后台执行；输入类动作在执行阶段可能触发'
      + '人工审批。不要在 reply 里回答「做不到」。本轮没有 computer_ 工具不代表不能执行：'
      + '操作类工具只在实际执行阶段提供。');
  } else if (facts.computerPlugin && runtimeUnavailable) {
    lines.push('电脑操控：连接已登记，但本机运行时不可用（' + facts.computerRuntimeState + '）；'
      + '用户这样要求时请如实说明缺的是运行时，而不是连接授权。');
  } else if (facts.computerPlugin && facts.workingRoot !== null &&
      facts.computerPluginBorrowedOnly === true) {
    lines.push('电脑操控：本会话所属项目还没有可用的电脑操控连接；工作区其他项目有登记，'
      + '但这次执行按本项目连接检查，不能跨项目借用。用户这样要求时请说明缺的是本项目连接。');
  } else {
    lines.push('电脑操控：工作区还没有登记可用的电脑操控连接；用户这样要求时请如实说明缺这一项，'
      + '并指出可在项目的「连接与权限」页一键启用。不要说成本轮缺少桌面工具，也不要说本机没有这个工具。');
  }
  if (machinePluginUsableForSession(facts, 'browser')) {
    lines.push('浏览器操控：可用。用户明确要求浏览器操作（打开网页、点击、填表）时，在 execution 里带 '
      + 'interaction="BROWSER" 作为执行候选交给后台执行。');
  } else if (facts.browserPlugin && facts.workingRoot !== null &&
      facts.browserPluginBorrowedOnly === true) {
    lines.push('浏览器操控：本会话所属项目还没有可用的浏览器操控连接；工作区其他项目有登记，'
      + '但这次执行按本项目连接检查，不能跨项目借用。');
  } else {
    lines.push('浏览器操控：工作区还没有登记可用的浏览器操控连接；用户这样要求时请如实说明缺这一项。');
  }

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
  // 2026-10-22（DEV-0117）：上面那一句列的全是读取族，模型会把「没有 computer_ 开头的工具」
  // 说成这一轮缺某项授权，让用户以为补上连接就能在对话里点鼠标、开应用。操作类能力从来
  // 不在会话轮次里提供，这条边界是设计事实，不是配置缺口，必须自己说清楚。
  // 同一天复核截图再补一类措辞：模型原话是「本地没有 computer、camera 的桌面工具」——
  // 把配置边界说成了「本机没装软件」。「缺少」与「本机没有」是两种错法，都要堵。
  lines.push('操作类能力（点击、输入、打开应用、页面动作）不在会话轮次里提供，只能在任务执行中'
    + '按授权进行。用户这样要求时请说明这条边界，并把这件事作为执行请求交给后台执行，'
    + '不要说成本轮缺少某个桌面工具、或让用户去补这项授权，也不要说「本机／本地没有'
    + '这个工具」——工具一直都在，不可用是本会话没有对应授权。');
  lines.push('以上是配置事实，不是系统限制清单。如果用户的要求需要上面缺失或未开放的一项，'
    + '就直接说明缺的是哪一项、在哪里补，不要把原因说成「没有被赋予访问能力」，'
    + '也不要转成「请补充任务目标或验收标准」。');
  return lines.join('\n');
}

/**
 * 本条消息的插件选择事实（2026-11-01 COMPUTER-PLUGIN-E2E）。
 *
 * 输入器里的 `@电脑操控` 只是用户选择的标签；这里把它变成一条模型能读到的服务端事实。
 * 它**不**是授权、不是候选，也不绕过任何校验：模型仍要按执行候选协议写出 `execution`，
 * 由原入口做确定性与准入判定。
 *
 * 只在用户明确选了电脑/浏览器插件时输出；GitHub mention 没有对应的 interaction 协议，
 * 不在这里伪装成可执行操作。用户只是在问「能不能」时，明确要求模型保持 execution=null。
 */
export function formatSelectedPluginFact(content: string,
  facts: SessionCapabilityFacts): string | null {
  const selected = findKnownPluginMentions(content).filter(
    (mention) => mention.key === 'computer' || mention.key === 'browser');
  if (selected.length === 0) return null;
  const labels = [...new Set(selected.map((mention) => mention.label))];
  const lines: string[] = [
    '【本条消息的插件选择（服务端识别的事实，不是授权）】',
    `用户在本条消息里明确选择了内置插件：${labels.map((label) => `${label}（@${label}）`).join('、')}。`,
    '这表示用户这次要求使用该插件完成任务；它不等于连接已登记、运行时就绪或已经获得审批。',
  ];
  if (selected.some((mention) => mention.key === 'computer')) {
    lines.push(machinePluginUsableForSession(facts, 'computer')
      ? '用户要求操作电脑时，必须按执行候选协议在 execution 中带 interaction="COMPUTER"，'
        + '目标写进 objective；不要只给操作步骤，也不要把明确的操作请求写成普通讨论。'
        + '打开应用或窗口操作不需要在仓库里找脚本或配置：不要先读文件、搜索路径或列目录，'
        + '直接在 execution 里声明候选；具体动作由执行阶段观察后再决定。'
      : '本会话当前没有可用的电脑操控连接或运行时；用户要求操作电脑时，按上面的能力事实'
        + '说明缺哪一项，不要伪造执行候选，也不要把缺项说成「本轮缺少桌面工具」。');
  }
  if (selected.some((mention) => mention.key === 'browser')) {
    lines.push(machinePluginUsableForSession(facts, 'browser')
      ? '用户要求浏览器操作时，必须按执行候选协议在 execution 中带 interaction="BROWSER"；'
        + '不要只给页面步骤，也不要把明确的操作请求写成普通讨论。'
      : '本会话当前没有可用的浏览器操控连接；用户要求浏览器操作时，按事实说明缺这一项。');
  }
  lines.push('判定是否要填候选时，按用户语句本身区分，不要因为看到了插件标签就一律执行：',
    '- 询问能力、可行性、是否支持、怎么做，或以问号结尾的句子：execution=null，直接回答；',
    '- 命令式请求（打开、启动、点击、输入、切换、关闭，含「请」「帮我」的可执行要求）：填候选；',
    '- 只有标签、没有明确动作或目标：execution=null，只问那一个缺失的目标。');
  return lines.join('\n');
}

/**
 * 读服务端事实并格式化。
 *
 * 读取失败不阻断生成：目录读不到时按「没有目录」这一条可核对的事实说明，而不是让整轮
 * 生成失败——用户要的是一次如实回答，不是又一个错误码。
 */
export async function describeSessionCapabilities(db: DbExecutor, session: AssistSessionRow,
  input: { readonly tools: readonly InternalToolName[]; readonly allowWrite: boolean;
    readonly requestContent?: string | undefined },
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
  // 机器插件状态对任何会话都要读：绑定目录的普通会话同样需要知道「这次能不能用电脑操控」。
  // 与主流程落库门（assist-runner）共用 resolveMachineAttribution：连接与归属项目的受管
  // 资源齐备才算登记；借用事实也原样带出，由格式化层按会话形态解释。
  const [computerAttribution, browserAttribution] = await Promise.all([
    resolveMachineAttribution(repositories, { workspaceId: session.workspace_id,
      projectId: session.project_id, capability: 'COMPUTER_INPUT' }),
    resolveMachineAttribution(repositories, { workspaceId: session.workspace_id,
      projectId: session.project_id, capability: 'BROWSER_ACTION' }),
  ]);
  const facts: SessionCapabilityFacts = {
    hasProject: session.project_id !== null, workingRoot, writeTier,
    tools: input.tools, allowWrite: input.allowWrite,
    computerPlugin: computerAttribution !== undefined,
    browserPlugin: browserAttribution !== undefined,
    computerPluginBorrowedOnly: computerAttribution?.borrowed === true,
    browserPluginBorrowedOnly: browserAttribution?.borrowed === true,
  };
  // 运行时状态是同步的纯路径检查，不产生副作用；探测失败不外抛，缺事实时不写这一层。
  let computerRuntimeState: string | undefined;
  try { computerRuntimeState = computerRuntimeStatus().state; } catch { computerRuntimeState = undefined; }
  const withRuntime: SessionCapabilityFacts = computerRuntimeState === undefined ? facts
    : { ...facts, computerRuntimeState };
  const formatted = formatSessionCapabilities(withRuntime);
  const selected = input.requestContent === undefined ? null
    : formatSelectedPluginFact(input.requestContent, withRuntime);
  return selected === null ? formatted : `${formatted}\n\n${selected}`;
}
