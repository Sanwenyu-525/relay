import { createHash } from 'node:crypto';

import type { JsonObject } from '../infrastructure/json.js';
import { canonicalizeJson } from '../receipt/payload-hash.js';

/**
 * 内置工作方法（docs/architecture/relay-skills.md §9，ADR-019）。
 *
 * 与首批四项提案型 Skill 的区别：方法可以**实际开展工作**（读取、调用合法工具、按用户本次
 * 意图修改与验证），而不只是输出结构化建议。因此方法定义与第一方 Skill 注册表分开：
 * 那张表被冻结、归档并参与备份包校验（`inspectBackupRegistryArchive` 逐字校验 4 个 id 与
 * definition 键集），把执行型方法塞进去会改变归档契约与既有回归。
 *
 * 这里只放**定义与登记**：固定 ID/版本/中英文别名/默认行为/作用范围/能力需求/验证说明。
 * 命令解析、自然语言意图与执行接线分别在 `application/chat-commands.ts` 与
 * `application/method-intent.ts`；实际写入仍走原 Task/Run/Gateway 与领域 Owner。
 */

export type BuiltinMethodId = 'code-review' | 'fault-diagnosis' | 'docs-maintenance';

/** 默认作用范围：审查/文档默认当前任务与当前改动及相关影响，"全项目"才扩大。 */
export type MethodActionScope = 'CURRENT_TASK' | 'CURRENT_CHANGES' | 'RELATED_IMPACT' | 'PROJECT';

/**
 * 方法默认行动。
 *
 * * `INSPECT`：只读取、复现、定位并报告，不修改任何文件。
 * * `MODIFY`：本次明确要求修改；只有在用户显式表达（"修好"、"更新文档"）时才成立，
 *   且实际写入仍走原会话执行请求 → Task/Delegate/Run → Gateway 准入。
 */
export type MethodActionKind = 'INSPECT' | 'MODIFY';

export interface BuiltinMethodDefinition {
  readonly id: BuiltinMethodId;
  readonly version: string;
  readonly title: string;
  /** 规范英文命令名（不含前导 `/`）。中文别名解析到同一登记项。 */
  readonly command: string;
  readonly aliases: readonly string[];
  /** 菜单与回执展示的用途说明。 */
  readonly summary: string;
  /** 默认作用范围；PROJECT 只由用户显式"全项目"触发。 */
  readonly default_scope: MethodActionScope;
  /** 默认行动。三种方法默认都是 INSPECT。 */
  readonly default_action: MethodActionKind;
  /** 是否允许在用户显式要求修改时进入 MODIFY；代码审查同样允许，但绝不由审查本身触发。 */
  readonly modify_when_requested: boolean;
  /** 该方法可用的能力；只引用已注册能力，不因方法名获得任意 Shell。 */
  readonly required_capabilities: readonly string[];
  readonly optional_capabilities: readonly string[];
  /** 必要上下文：缺失时先澄清目标，不猜。 */
  readonly context_requirements: readonly string[];
  /** 验证说明：方法自身的工程验收边界（与运行时 Task Verification 分开）。 */
  readonly verification: readonly string[];
  readonly instructions: string;
}

export interface FrozenMethod {
  readonly id: BuiltinMethodId;
  readonly version: string;
  readonly sha256: string;
  readonly definition: BuiltinMethodDefinition;
}

export interface FrozenMethodIdentity {
  readonly id: BuiltinMethodId;
  readonly version: string;
  readonly sha256: string;
  readonly command: string;
  readonly title: string;
  readonly default_scope: MethodActionScope;
  readonly default_action: MethodActionKind;
  readonly modify_when_requested: boolean;
}

/** 会话方法进入 Run 的最小绑定；不携带权限、连接或可执行命令。 */
export interface RunMethodBinding extends JsonObject {
  readonly method_snapshot: JsonObject;
  readonly action: MethodActionKind;
  readonly argument: string | null;
  readonly session_id: string;
  readonly source_message_id: string;
}

export function readRunMethodBinding(value: unknown): RunMethodBinding | undefined {
  if (value === undefined) return undefined;
  const row = object(value);
  const snapshot = row === null ? null : object(row.method_snapshot);
  if (row === null || snapshot === null || inspectFrozenMethodSnapshot(snapshot) === null ||
      (row.action !== 'INSPECT' && row.action !== 'MODIFY') ||
      (row.argument !== null && (typeof row.argument !== 'string' || row.argument.length > 2000)) ||
      typeof row.session_id !== 'string' || row.session_id === '' ||
      typeof row.source_message_id !== 'string' || row.source_message_id === '') {
    throw new Error('frozen Run method binding is invalid');
  }
  return row as RunMethodBinding;
}

const DEFINITIONS: readonly BuiltinMethodDefinition[] = [
  {
    id: 'code-review', version: '1.0.0', title: '代码审查',
    command: 'review',
    aliases: ['code-review', '代码审查', '审查', '代码评审', '评审'],
    summary: '阅读当前任务、当前改动及相关影响，报告有依据的问题和位置；不自动修复。',
    default_scope: 'CURRENT_CHANGES', default_action: 'INSPECT', modify_when_requested: true,
    required_capabilities: [],
    optional_capabilities: ['READ_FILE', 'SEARCH_TEXT', 'FIND_PATHS', 'LIST_DIRECTORY',
      'GIT_READ', 'RUN_CHECK'],
    context_requirements: ['当前任务或当前改动', '受管工作目录'],
    verification: ['只报告有依据的问题并给出位置', '不因“审查”自动修改文件',
      '范围默认当前任务/改动，明确“全项目”才扩大'],
    instructions: [
      '本次职责是代码审查：阅读当前任务、当前改动及其相关影响，报告有依据的问题。',
      '只报告你在实际读取到的内容中能指出位置与依据的问题；无法核实的怀疑明确标为待确认，不编造。',
      '审查本身不修改任何文件：即使你发现了明确的缺陷，也只报告与建议，等待用户明确要求修复。',
      '范围默认限于当前任务、当前改动及其相关影响；用户明确要求“全项目”时才扩大。',
      '目标或基线确实不明确时先说明缺什么，不猜一个范围就动手。',
    ].join('\n'),
  },
  {
    id: 'fault-diagnosis', version: '1.0.0', title: '故障诊断',
    command: 'diagnose',
    aliases: ['fault-diagnosis', '故障诊断', '诊断', '排查', '定位问题'],
    summary: '复现、定位、核对证据并给出结论与修复建议；默认不修文件，明确“修好”才继续。',
    default_scope: 'CURRENT_TASK', default_action: 'INSPECT', modify_when_requested: true,
    required_capabilities: [],
    optional_capabilities: ['READ_FILE', 'SEARCH_TEXT', 'FIND_PATHS', 'LIST_DIRECTORY',
      'GIT_READ', 'RUN_CHECK'],
    context_requirements: ['可复现的现象或失败入口', '受管工作目录'],
    verification: ['默认复现/定位/报告，不修文件', '明确“修好”后可继续修改并验证',
      '结论须绑定实际证据，不把推测当已定位'],
    instructions: [
      '本次职责是故障诊断：复现、定位、核对证据，并给出结论与修复建议。',
      '先复现或读取真实证据，再下结论；证据不足时明确说明还缺什么，不把推测说成已定位。',
      '默认不修改任何文件：报告根因、影响与建议即可。用户明确要求“修好/修复”时才继续修改并验证。',
      '需要执行检查时只使用当前已注册、已配置并获准的能力，不自行构造命令。',
      '范围默认限于当前任务；用户明确要求“全项目”时才扩大。',
    ].join('\n'),
  },
  {
    id: 'docs-maintenance', version: '1.0.0', title: '文档维护',
    command: 'docs',
    aliases: ['docs-maintenance', '文档维护', '维护文档', '更新文档', '整理文档'],
    summary: '核对当前代码、需求、决定及本次改动，维护确实受影响的已有文档；不扩成全仓重写。',
    default_scope: 'RELATED_IMPACT', default_action: 'INSPECT', modify_when_requested: true,
    required_capabilities: [],
    optional_capabilities: ['READ_FILE', 'SEARCH_TEXT', 'FIND_PATHS', 'LIST_DIRECTORY', 'GIT_READ'],
    context_requirements: ['受影响的事实源入口', '本次改动范围'],
    verification: ['只维护确实受影响的已有文档', '不补造实现、历史或通过结果',
      '范围默认当前改动及相关影响，明确“全项目”才扩大'],
    instructions: [
      '本次职责是文档维护：核对当前代码、需求、决定及本次改动，维护确实受影响的已有文档。',
      '只更新受影响的事实源，优先改已有主文档；同一事实只维护一处，不新建空文档凑清单。',
      '不得补造未实现的实现、历史或通过结果；无法确定的内容标为待确认。',
      '范围默认限于本次改动及相关影响；用户明确要求“全项目”时才扩大，不顺手重写无关文档。',
      '受影响的已有文档才是目标；没有受影响的文档时如实说明，不为完成而写文档。',
    ].join('\n'),
  },
];

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalizeJson(value as JsonObject), 'utf8').digest('hex');
}

/** 别名归一：小写、去空白、去前导 `/`；中文别名原样保留大小写不敏感比较。 */
export function normalizeMethodToken(raw: string): string {
  return raw.trim().replace(/^\/+/u, '').toLowerCase();
}

export interface BuiltinMethodRegistry {
  readonly methods: readonly FrozenMethod[];
  readonly method: (id: string, version: string) => FrozenMethod | undefined;
  /** 命令名或别名 → 登记项；未知返回 undefined。不按扫描顺序静默覆盖，冲突在构造时抛错。 */
  readonly byCommand: (token: string) => FrozenMethod | undefined;
}

export function createBuiltinMethodRegistry(
  definitions: readonly BuiltinMethodDefinition[] = DEFINITIONS,
): BuiltinMethodRegistry {
  if (definitions.length === 0 || definitions.length > 16) {
    throw new Error('builtin method registry exceeds its fixed size budget');
  }
  const methodMap = new Map<string, FrozenMethod>();
  const commandMap = new Map<string, FrozenMethod>();
  for (const definition of definitions) {
    const key = `${definition.id}@${definition.version}`;
    const frozen: FrozenMethod = { id: definition.id, version: definition.version,
      definition, sha256: hash({ definition }) };
    const previous = methodMap.get(key);
    if (previous !== undefined && previous.sha256 !== frozen.sha256) {
      throw new Error(`conflicting builtin method definition: ${key}`);
    }
    methodMap.set(key, frozen);
    // 同一命令名/别名只能解析到一个登记项：冲突即构造失败，绝不按顺序覆盖。
    for (const token of [definition.command, ...definition.aliases]) {
      const normalized = normalizeMethodToken(token);
      if (normalized === '') throw new Error(`empty builtin method command: ${key}`);
      const existing = commandMap.get(normalized);
      if (existing !== undefined && `${existing.id}@${existing.version}` !== key) {
        throw new Error(`conflicting builtin method command token: ${normalized}`);
      }
      commandMap.set(normalized, frozen);
    }
  }
  return { methods: [...methodMap.values()],
    method: (id, version) => methodMap.get(`${id}@${version}`),
    byCommand: (token) => commandMap.get(normalizeMethodToken(token)) };
}

export const BUILTIN_METHOD_REGISTRY = createBuiltinMethodRegistry();

/** 该方法的当前登记版本：注册表按定义顺序保存，用于自然语言识别等无版本来源的调用。 */
export function currentBuiltinMethod(id: BuiltinMethodId): FrozenMethod | undefined {
  return BUILTIN_METHOD_REGISTRY.methods.find((entry) => entry.id === id);
}

export function frozenMethodIdentity(method: FrozenMethod): FrozenMethodIdentity {
  return { id: method.id, version: method.version, sha256: method.sha256,
    command: method.definition.command, title: method.definition.title,
    default_scope: method.definition.default_scope,
    default_action: method.definition.default_action,
    modify_when_requested: method.definition.modify_when_requested };
}

/** 冻结快照：调用冻结实际采用的定义与摘要，磁盘/注册表后续变化不重放旧调用。 */
export function frozenMethodSnapshot(method: FrozenMethod): JsonObject {
  return JSON.parse(JSON.stringify(method)) as JsonObject;
}

/**
 * 读取已冻结方法身份。
 *
 * 与 `inspectFrozenSkillSnapshot` 同一口径：形状、摘要自洽与未知字段全部校验，
 * 摘要对不上就拒绝，不从当前注册表补造历史绑定。
 */
export function inspectFrozenMethodSnapshot(snapshot: JsonObject): FrozenMethodIdentity | null {
  const definition = object(snapshot.definition);
  if (definition === null || typeof snapshot.id !== 'string' ||
      !['code-review', 'fault-diagnosis', 'docs-maintenance'].includes(snapshot.id) ||
      typeof snapshot.version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(snapshot.version) ||
      typeof snapshot.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(snapshot.sha256) ||
      definition.id !== snapshot.id || definition.version !== snapshot.version ||
      typeof definition.command !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/u.test(definition.command) ||
      typeof definition.title !== 'string' ||
      !['CURRENT_TASK', 'CURRENT_CHANGES', 'RELATED_IMPACT', 'PROJECT']
        .includes(definition.default_scope as string) ||
      (definition.default_action !== 'INSPECT' && definition.default_action !== 'MODIFY') ||
      typeof definition.modify_when_requested !== 'boolean' ||
      Object.keys(snapshot).some((key) => !['id', 'version', 'sha256', 'definition'].includes(key))) {
    return null;
  }
  try {
    if (hash({ definition }) !== snapshot.sha256) return null;
    return { id: snapshot.id as BuiltinMethodId, version: snapshot.version,
      sha256: snapshot.sha256, command: definition.command as string,
      title: definition.title as string,
      default_scope: definition.default_scope as MethodActionScope,
      default_action: definition.default_action as MethodActionKind,
      modify_when_requested: definition.modify_when_requested as boolean };
  } catch { return null; }
}

/** 冻结快照仍与当前注册表同一摘要时才可用于新调用；被替换的旧版本返回 null。 */
export function availableFrozenMethod(snapshot: JsonObject): FrozenMethod | null {
  const inspected = inspectFrozenMethodSnapshot(snapshot);
  if (inspected === null) return null;
  const current = BUILTIN_METHOD_REGISTRY.method(inspected.id, inspected.version);
  return current?.sha256 === inspected.sha256 ? current : null;
}

function object(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject : null;
}
