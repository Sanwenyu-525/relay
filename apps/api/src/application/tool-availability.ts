/**
 * 项目工具有效性投影（2026-11-01，PLUGIN-P0-01）。
 *
 * 解决的问题：工作台的「可以用的工具」此前在浏览器里用「存在任意一条非拒绝策略」拼出
 * 「可用」，于是
 *   * 只授权了 `read_file` 的文件行，仍然写着「按档位写入当前目录」；
 *   * 电脑插件只授权了截图（COMPUTER_READ）时，整行仍显示可执行鼠标键盘；
 *   * 策略的 target_prefix 与项目受管目录不匹配、`gh` 没装、连接已停用，
 *     界面都照旧显示可用。
 * 那是第二套权限引擎，而且比 Gateway 宽松。这里把判定搬回服务端，**复用 Gateway 自己的
 * 原语**（`capabilityFor`、`targetMatches`、`rankActivePolicies`、`ADAPTER_DESCRIPTORS`），
 * 因此界面结论与最终准入不会各说一套。
 *
 * 边界：
 * - 只读。不创建连接、不写策略、不放宽任何权限，也不代替 Gateway 的最终准入；
 * - 结论只描述「按当前配置，这个动作会被怎样对待」，不代表已经执行过任何动作；
 * - 读不到的事实（策略版本缺失、运行时探测失败）一律落到 UNKNOWN，不猜成可用。
 */

import { COMPUTER_DESKTOP_TARGET } from '../computer/protocol.js';
import { ADAPTER_DESCRIPTORS } from '../gateway/adapter-metadata.js';
import type { ActivePolicy } from '../gateway/gateway-repository.js';
import type { DbExecutor } from '../infrastructure/database.js';
import type { GatewayCapability, GatewayConnectionRow } from '../infrastructure/database-schema.js';
import type { PluginRuntimeStatus } from '../plugins/runtime-status.js';
import { capabilityFor, rankActivePolicies, targetMatches,
  type GatewayActionType } from './gateway-actions.js';
import { createRepositories, type Repositories } from './unit-of-work.js';

/** 工作台「可以用的工具」的七行；与 UI 的行 key 一一对应。 */
export type ProjectToolKey = 'files' | 'git' | 'web' | 'cli' | 'computer' | 'browser' | 'github';

/** 一个动作在当前配置下会被怎样对待。 */
export type ToolActionEffect =
  /** 授权有效且适配器允许自动准入。 */
  | 'AUTO'
  /** 授权有效，但每次执行都要批准（策略 ASK，或该能力的适配器不允许 AUTO 直通）。 */
  | 'NEEDS_APPROVAL'
  /** 只按站点收窄的授权，未覆盖全部站点。 */
  | 'SITE_SCOPED'
  /** 没有匹配当前目标的生效策略；默认拒绝。 */
  | 'NOT_AUTHORIZED'
  /** 命中的生效策略明确为 DENY。 */
  | 'DENIED'
  /** 该能力没有 ACTIVE 且边界覆盖当前目标的连接。 */
  | 'NO_CONNECTION'
  /** 有连接，但没有可供动作落地的目标（例如项目还没有受管目录）。 */
  | 'NO_TARGET';

/** 一行工具的合成状态；比单个动作更粗，但每一档都能对应一句可执行的话。 */
export type ProjectToolState =
  | 'READY' | 'NEEDS_APPROVAL' | 'SITE_SCOPED' | 'READ_ONLY' | 'PARTIAL'
  | 'NOT_AUTHORIZED' | 'DENIED' | 'NOT_CONFIGURED' | 'DISABLED' | 'REVOKED'
  | 'RUNTIME_UNAVAILABLE' | 'UNKNOWN';

export interface ProjectToolCounts {
  readonly total: number;
  readonly auto: number;
  readonly needs_approval: number;
  readonly site_scoped: number;
  readonly not_authorized: number;
  readonly denied: number;
  /** 缺连接或缺目标：不是授权问题，而是还没配好。 */
  readonly unavailable: number;
}

export interface ProjectToolAvailability {
  readonly tool: ProjectToolKey;
  readonly state: ProjectToolState;
  readonly detail: string;
  readonly counts: ProjectToolCounts;
}

/**
 * 每个工具行覆盖的能力族。
 *
 * 与 `ConnectionsView` 的 `toolRows` 同构，但这里是**服务端**的唯一一份：界面不再自己
 * 按能力集合判断，避免两处各写一张表。新增能力时两处都要改，缺一处就会让新能力既不显示
 * 也不参与判定——因此测试里对这张表做了闭集断言。
 */
const TOOL_CAPABILITIES: Readonly<Record<ProjectToolKey,
  { readonly capabilities: readonly GatewayCapability[];
    readonly plugin: PluginRuntimeStatus['plugin'] | null }>> = {
  files: { capabilities: ['FILE_READ', 'FILE_QUERY', 'FILE_WRITE'], plugin: null },
  git: { capabilities: ['GIT_READ'], plugin: null },
  web: { capabilities: ['WEB_FETCH'], plugin: null },
  cli: { capabilities: ['CLI_RUN'], plugin: null },
  computer: { capabilities: ['COMPUTER_READ', 'COMPUTER_INPUT'], plugin: 'computer' },
  browser: { capabilities: ['BROWSER_READ', 'BROWSER_ACTION', 'BROWSER_COMMIT'], plugin: 'browser' },
  github: { capabilities: ['GITHUB_READ'], plugin: 'github' },
};

/**
 * 参与判定的一批动作。
 *
 * 能力的归属不在这里手写：一律用 Gateway 的 `capabilityFor` 反查，因此这张表与
 * `capabilityFor` 之间不可能出现「界面认为属于 FILE_WRITE、Gateway 认为属于别的能力」
 * 这种分叉。表里列的是**动作身份**，也就是策略里 action_type 的取值。
 */
const PROJECT_ACTIONS: readonly GatewayActionType[] = [
  'READ_FILE',
  'LIST_DIRECTORY', 'FIND_PATHS', 'SEARCH_TEXT',
  'APPLY_CHANGESET', 'READ_CHANGE_SET', 'WRITE_FILE',
  'GIT_STATUS', 'GIT_DIFF', 'GIT_LOG',
  'WEB_FETCH',
  'CLI_RUN', 'RUN_BUILD', 'RUN_TEST',
  'COMPUTER_SCREENSHOT', 'COMPUTER_GET_WINDOWS',
  'COMPUTER_ACTIVATE_WINDOW', 'COMPUTER_MOVE', 'COMPUTER_CLICK', 'COMPUTER_DOUBLE_CLICK',
  'COMPUTER_SCROLL', 'COMPUTER_DRAG', 'COMPUTER_TYPE', 'COMPUTER_KEYPRESS', 'COMPUTER_HOTKEY',
  'GITHUB_REPO_VIEW', 'GITHUB_PR_LIST', 'GITHUB_PR_VIEW', 'GITHUB_ISSUE_LIST', 'GITHUB_ISSUE_VIEW',
  'BROWSER_LIST_PAGES', 'BROWSER_READ_PAGE', 'BROWSER_SCREENSHOT', 'BROWSER_WAIT_FOR',
  'BROWSER_NEW_PAGE', 'BROWSER_NAVIGATE', 'BROWSER_CLICK', 'BROWSER_FILL',
  'BROWSER_PRESS_KEY', 'BROWSER_CLOSE_PAGE', 'BROWSER_SUBMIT_FORM', 'BROWSER_UPLOAD_FILE',
];

/** 浏览器「全部站点」的合成目标；与 `targetMatches` 里 `browser://` 前缀同义。 */
const BROWSER_ALL_SITES = 'browser://';

/** 连接必须绑定一个覆盖受管根的目录；与 Gateway prepare 的 rootBoundCapability 同一份。 */
const ROOT_BOUND: ReadonlySet<GatewayCapability> = new Set<GatewayCapability>(
  ['FILE_READ', 'FILE_QUERY', 'FILE_WRITE', 'GIT_READ', 'GIT_WRITE', 'CLI_RUN'],
);

const BROWSER_CAPABILITIES: ReadonlySet<GatewayCapability> = new Set<GatewayCapability>(
  ['BROWSER_READ', 'BROWSER_ACTION', 'BROWSER_COMMIT'],
);

const isBrowserCapability = (capability: GatewayCapability): boolean =>
  BROWSER_CAPABILITIES.has(capability);

/** 只读效果的能力；用于区分「只有读取权限」与「读与操作都有权限」。 */
const isReadEffect = (capability: GatewayCapability): boolean =>
  ADAPTER_DESCRIPTORS[capability]?.effectKind === 'READ';

/** 空参数的载荷字节数：与工作台表单里的说明、以及策略上限的最小有效值一致。 */
const MIN_PAYLOAD_BYTES = 2;

interface ConnectionView {
  readonly row: GatewayConnectionRow;
  readonly capabilities: ReadonlySet<GatewayCapability>;
}

/**
 * 判定所需的全部事实，一次组装好再判定。
 *
 * 抽成显式输入是为了让判定本身可被单独验证：读库的部分只负责把行取回来，
 * 判定不碰数据库、不探测进程，因此用例可以直接给出「只授权了 read_file」这种
 * 具体配置来断言结论，而不必先搭一套真实网关数据。
 */
export interface ToolAvailabilityFacts {
  readonly connections: readonly ConnectionView[];
  readonly resources: readonly { readonly canonical_root: string }[];
  readonly policies: readonly ActivePolicy[];
  /** ACTIVE 但 active_version 指向的版本行读不到：策略事实不完整。 */
  readonly policyIncomplete: boolean;
}

type EvaluationInput = ToolAvailabilityFacts;

/** 一条连接是否真的能承载这个能力：ACTIVE、具备该能力、且目录边界覆盖某个受管根。 */
function coversCapability(connection: ConnectionView, capability: GatewayCapability,
  resources: EvaluationInput['resources']): boolean {
  if (connection.row.status !== 'ACTIVE') return false;
  if (!connection.capabilities.has(capability)) return false;
  if (!ROOT_BOUND.has(capability)) return true;
  const rootPath = connection.row.config.root_path;
  if (typeof rootPath !== 'string') return false;
  return resources.some((resource) => targetMatches(rootPath, resource.canonical_root, capability));
}

/** 这个能力的动作可以落在哪些目标上。空数组 = 没有可落地目标。 */
function targetsFor(capability: GatewayCapability, connections: readonly ConnectionView[],
  resources: EvaluationInput['resources']): readonly string[] {
  if (capability === 'COMPUTER_READ' || capability === 'COMPUTER_INPUT') {
    return [COMPUTER_DESKTOP_TARGET];
  }
  if (isBrowserCapability(capability)) return [BROWSER_ALL_SITES];
  if (capability === 'WEB_FETCH') {
    return connections.flatMap((connection) => {
      const host = connection.row.config.allowed_host;
      return typeof host === 'string' && host !== '' ? [`https://${host.toLowerCase()}/`] : [];
    });
  }
  // 文件、Git、CLI、GitHub：动作目标就是受管根本身。
  return resources.map((resource) => resource.canonical_root);
}

function effectiveOf(capability: GatewayCapability, action: GatewayActionType,
  input: EvaluationInput): ToolActionEffect {
  const connections = input.connections.filter((connection) =>
    coversCapability(connection, capability, input.resources));
  if (connections.length === 0) return 'NO_CONNECTION';
  const targets = targetsFor(capability, connections, input.resources);
  if (targets.length === 0) return 'NO_TARGET';
  const candidates = input.policies.filter((policy) =>
    policy.capability_key === capability && policy.action_type === action &&
    targets.some((target) => targetMatches(policy.target_prefix, target, capability)));
  const selected = rankActivePolicies(candidates);
  const passthrough = ADAPTER_DESCRIPTORS[capability]?.approvalPassthrough === true;
  const fromDecision = (decision: ActivePolicy['decision']): ToolActionEffect =>
    decision === 'DENY' ? 'DENIED'
      : decision === 'ASK' || !passthrough ? 'NEEDS_APPROVAL' : 'AUTO';
  if (selected !== undefined) {
    // 载荷上限与 `selectedPolicy` 同一口径：空参数也编成 2 字节，上限更小的策略等于不可用。
    return selected.max_payload_bytes < MIN_PAYLOAD_BYTES ? 'DENIED' : fromDecision(selected.decision);
  }
  if (isBrowserCapability(capability)) {
    // 全部站点没有策略时，站点级策略仍可能覆盖某些站点：结论降级为「仅部分站点」，
    // 而不是「未授权」——后者会让按站点授权的用户看到与事实相反的状态。
    const scoped = input.policies.filter((policy) =>
      policy.capability_key === capability && policy.action_type === action &&
      policy.target_prefix.toLowerCase() !== BROWSER_ALL_SITES &&
      policy.target_prefix.toLowerCase().startsWith(BROWSER_ALL_SITES) &&
      policy.decision !== 'DENY');
    if (scoped.length > 0) return 'SITE_SCOPED';
  }
  return 'NOT_AUTHORIZED';
}

function emptyCounts(): ProjectToolCounts {
  return { total: 0, auto: 0, needs_approval: 0, site_scoped: 0,
    not_authorized: 0, denied: 0, unavailable: 0 };
}

function tally(counts: ProjectToolCounts, effect: ToolActionEffect): ProjectToolCounts {
  const next = { ...counts, total: counts.total + 1 };
  switch (effect) {
    case 'AUTO': return { ...next, auto: next.auto + 1 };
    case 'NEEDS_APPROVAL': return { ...next, needs_approval: next.needs_approval + 1 };
    case 'SITE_SCOPED': return { ...next, site_scoped: next.site_scoped + 1 };
    case 'DENIED': return { ...next, denied: next.denied + 1 };
    case 'NOT_AUTHORIZED': return { ...next, not_authorized: next.not_authorized + 1 };
    default: return { ...next, unavailable: next.unavailable + 1 };
  }
}

const usableCount = (counts: ProjectToolCounts): number =>
  counts.auto + counts.needs_approval + counts.site_scoped;

/** 一行工具里，已授权的动作是否全部只读。 */
function onlyReadActionsUsable(capabilities: readonly GatewayCapability[],
  input: EvaluationInput): boolean {
  for (const capability of capabilities) {
    for (const action of PROJECT_ACTIONS) {
      if (capabilityFor(action) !== capability) continue;
      const effect = effectiveOf(capability, action, input);
      if (effect === 'NO_CONNECTION' || effect === 'NO_TARGET' ||
          effect === 'NOT_AUTHORIZED' || effect === 'DENIED') continue;
      if (!isReadEffect(capability)) return false;
    }
  }
  return true;
}

function stateOf(counts: ProjectToolCounts, capabilities: readonly GatewayCapability[],
  input: EvaluationInput): ProjectToolState {
  const usable = usableCount(counts);
  if (usable === 0) {
    if (counts.denied > 0 && counts.not_authorized === 0) return 'DENIED';
    return 'NOT_AUTHORIZED';
  }
  // 完全没有「全部站点」授权、只有按站点收窄的授权时，先把这件事说清：
  // 写成「只读可用」会让人以为整个浏览器都通了。
  if (counts.auto === 0 && counts.needs_approval === 0 && counts.site_scoped > 0) return 'SITE_SCOPED';
  // 未授权、已拒绝与「根本没有对应连接/目标」都算这一行的缺口：行文案承诺的是
  // 整族能力，缺一项就不能读作整行可用。
  const unusable = counts.not_authorized + counts.denied + counts.unavailable;
  if (unusable > 0) {
    return onlyReadActionsUsable(capabilities, input) ? 'READ_ONLY' : 'PARTIAL';
  }
  if (counts.site_scoped > 0) return 'SITE_SCOPED';
  if (counts.needs_approval > 0) return 'NEEDS_APPROVAL';
  return 'READY';
}

/** 状态对应的说明。每句只描述当前事实与下一步，不写「请配置」这种空话。 */
function detailOf(state: ProjectToolState, counts: ProjectToolCounts,
  runtime: PluginRuntimeStatus | undefined): string {
  const suffix = `（${usableCount(counts)}/${counts.total} 个动作已授权）`;
  switch (state) {
    case 'NOT_CONFIGURED':
      return '本项目还没有登记这项能力的连接。';
    case 'DISABLED':
      return '连接已停用；重新启用或重新授权前不会执行。';
    case 'REVOKED':
      return '连接已撤销；原批准不能继续复用。';
    case 'RUNTIME_UNAVAILABLE':
      return `本机运行时不可用：${runtime?.detail ?? '状态无法确认'}。`;
    case 'UNKNOWN':
      return '策略版本或连接状态无法完整读取，不推断可用。';
    case 'NOT_AUTHORIZED':
      return '连接有效，但没有任何匹配当前目标的生效策略；默认拒绝仍然生效。';
    case 'DENIED':
      return '命中的生效策略为拒绝；拒绝不会被批准或范围授权覆盖。';
    case 'READ_ONLY':
      return `只有读取类动作已授权，操作类动作未授权${suffix}。`;
    case 'PARTIAL':
      return `部分动作已授权，其余未授权或已拒绝${suffix}。`;
    case 'SITE_SCOPED':
      return `授权只覆盖部分站点，未覆盖全部站点${suffix}。`;
    case 'NEEDS_APPROVAL':
      return `动作已授权，但每次执行前需要批准${suffix}。`;
    default:
      return `动作已授权且可自动准入${suffix}。`;
  }
}

function runtimeFor(plugin: PluginRuntimeStatus['plugin'] | null,
  runtime: readonly PluginRuntimeStatus[]): PluginRuntimeStatus | undefined {
  if (plugin === null) return undefined;
  return runtime.find((entry) => entry.plugin === plugin);
}

/**
 * 判定一行工具。
 *
 * 顺序即优先级：先看「有没有配」，再看「本机能不能跑」，最后才谈授权。把运行时放在
 * 授权之前，是因为「装都没装」时讨论 AUTO/ASK 没有意义；把连接状态放在运行时之前，
 * 是因为没有连接就没有插件实例可谈。
 */
function evaluateTool(tool: ProjectToolKey, input: EvaluationInput,
  runtime: readonly PluginRuntimeStatus[]): ProjectToolAvailability {
  const spec = TOOL_CAPABILITIES[tool];
  const pluginRuntime = runtimeFor(spec.plugin, runtime);
  const matching = input.connections.filter((connection) =>
    spec.capabilities.some((capability) => connection.capabilities.has(capability)));
  const active = matching.filter((connection) => connection.row.status === 'ACTIVE');
  let counts = emptyCounts();
  for (const capability of spec.capabilities) {
    for (const action of PROJECT_ACTIONS) {
      if (capabilityFor(action) !== capability) continue;
      counts = tally(counts, effectiveOf(capability, action, input));
    }
  }
  const state = ((): ProjectToolState => {
    if (input.policyIncomplete) return 'UNKNOWN';
    if (matching.length === 0) return 'NOT_CONFIGURED';
    if (active.length === 0) {
      return matching.some((connection) => connection.row.status === 'DISABLED')
        ? 'DISABLED' : 'REVOKED';
    }
    if (pluginRuntime !== undefined && pluginRuntime.state !== 'READY') return 'RUNTIME_UNAVAILABLE';
    return stateOf(counts, spec.capabilities, input);
  })();
  return { tool, state, detail: detailOf(state, counts, pluginRuntime), counts };
}

export interface ReadProjectToolAvailabilityInput {
  readonly workspaceId: string;
  readonly projectId: string;
  /**
   * 三个内置插件的安装级状态，由调用方探测后传入。
   *
   * 不在这里探测，是为了让判定本身是纯函数：路由负责跑 `gh`/读浏览器后端状态，
   * 这里只负责「结合授权事实得出结论」，单元测试因此不需要起子进程。
   */
  readonly runtime: readonly PluginRuntimeStatus[];
}

/**
 * 按给定事实判定七行工具（纯函数）。
 *
 * 读库与探测都在调用方完成；这里只做判定，因此可以在用例里直接构造「只授权了
 * read_file」「连接已停用」「gh 未安装」这些配置来核对结论。
 */
export function evaluateToolRows(facts: ToolAvailabilityFacts,
  runtime: readonly PluginRuntimeStatus[]): readonly ProjectToolAvailability[] {
  return (Object.keys(TOOL_CAPABILITIES) as ProjectToolKey[])
    .map((tool) => evaluateTool(tool, facts, runtime));
}

export async function readProjectToolAvailability(db: DbExecutor,
  input: ReadProjectToolAvailabilityInput): Promise<readonly ProjectToolAvailability[]> {
  return projectToolAvailability(createRepositories(db), input);
}

export async function projectToolAvailability(repositories: Repositories,
  input: ReadProjectToolAvailabilityInput): Promise<readonly ProjectToolAvailability[]> {
  const [connections, resources, policies] = await Promise.all([
    repositories.gateway.listConnections(input.workspaceId, input.projectId),
    repositories.gateway.listResources(),
    repositories.gateway.listActivePolicyVersions(input.workspaceId, input.projectId),
  ]);
  const activeResources = resources.filter((resource) =>
    resource.workspace_id === input.workspaceId && resource.project_id === input.projectId &&
    resource.status === 'ACTIVE');
  const connectionViews: ConnectionView[] = await Promise.all(connections.map(async (row) => ({
    row, capabilities: new Set(await repositories.gateway.listConnectionCapabilities(row.id)),
  })));
  // ACTIVE 策略却读不到生效版本 = 策略事实不完整：此时任何「可用」都可能与实际准入不符。
  const declaredActive = await repositories.gateway.listPolicies(input.workspaceId, input.projectId);
  const policyIncomplete = declaredActive.some((policy) =>
    policy.status === 'ACTIVE' && policy.active_version !== null &&
    !policies.some((active) => active.id === policy.id));
  return evaluateToolRows({ connections: connectionViews, resources: activeResources,
    policies, policyIncomplete }, input.runtime);
}
