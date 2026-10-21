import { BUILTIN_METHOD_REGISTRY, frozenMethodIdentity,
  type BuiltinMethodId, type FrozenMethodIdentity, type MethodActionKind,
  type MethodActionScope } from '../skills/builtin-methods.js';
import { methodActionForArgument } from './method-intent.js';

/**
 * 聊天 `/命令` 的登记与受限解析（docs/frontend/workbench-design.md §27，
 * docs/architecture/relay-skills.md §9.4，测试计划 BC-01/BC-03/BC-06）。
 *
 * 本模块只做一件事：把一段用户输入**确定地**解析成「登记项 + 参数」或一个类型化拒绝。
 * 它不执行任何动作、不写任何存储、不调用模型——因此「菜单选中未发送」天然是零效果，
 * 「未知命令」也不会被偷偷转成任意工具请求。
 *
 * 命令同时容纳两类登记项：
 *   * 方法命令：来自 `BUILTIN_METHOD_REGISTRY`，交给 Assist/执行链；
 *   * 系统命令：`/clear`、`/new`、`/model`、`/undo`、`/compact`，交给既有应用用例。
 * 英文固定名与中文别名解析到**同一个**登记项，不维护两套行为。
 */

export type SystemCommandId = 'clear' | 'new' | 'model' | 'undo' | 'compact' | 'plan' | 'goal';

export interface SystemCommandDefinition {
  readonly id: SystemCommandId;
  readonly command: string;
  readonly aliases: readonly string[];
  readonly summary: string;
  /** 用法模板，供菜单展示。 */
  readonly usage: string;
  /** 参数形状：NONE 不接受参数；TEXT 接受一段文本；MODEL_NAME 接受模型标识。 */
  readonly argument: 'NONE' | 'TEXT' | 'MODEL_NAME';
}

const SYSTEM_COMMANDS: readonly SystemCommandDefinition[] = [
  { id: 'clear', command: 'clear', aliases: ['新会话', '清空'], argument: 'NONE',
    summary: '新建一个空会话，保留项目与目录绑定；原会话留作历史，不删除记录。',
    usage: '/clear' },
  { id: 'new', command: 'new', aliases: ['新对话'], argument: 'NONE',
    summary: '与 /clear 同义：新建空会话，保留项目与目录绑定。',
    usage: '/new' },
  { id: 'model', command: 'model', aliases: ['模型'], argument: 'MODEL_NAME',
    summary: '为当前会话后续新发起的请求选择模型；已开始的 Run 保持其冻结模型。',
    usage: '/model <模型名>' },
  { id: 'undo', command: 'undo', aliases: ['撤回'], argument: 'NONE',
    summary: '撤回可撤回的业务状态；复用既有自然语言状态撤回，不负责文件回退。',
    usage: '/undo' },
  { id: 'compact', command: 'compact', aliases: ['压缩'], argument: 'NONE',
    summary: '在安全边界手动整理当前会话上下文；不会替换在途请求的输入。',
    usage: '/compact' },
  /*
   * 0127：`/plan` 与 `/goal`（工作台 §44.1）。
   *
   * 与前五条的关键差别：它们是**命令 + 正文**。命令决定这条消息按哪种行为模式受理，
   * 正文就是这一轮要说的话——因此 `argument` 是 TEXT，且发送路径不是 `ExecuteChatCommand`
   * 而是普通消息命令（`chat_mode` 随消息进同一命令、同一事务）。
   *
   * 菜单里列出它们只为**预填**：选中只把 `/plan ` 插进草稿，用户补完内容再发送。
   * 不带正文的形式（只输入 `/plan`）才是「只切模式」，走模式切换 Owner。
   */
  { id: 'plan', command: 'plan', aliases: ['计划'], argument: 'TEXT',
    summary: '计划模式：只调查、读取与比较方案，不改项目；形成计划后可挑某一版执行。',
    usage: '/plan <要说的事>' },
  { id: 'goal', command: 'goal', aliases: ['目标'], argument: 'TEXT',
    summary: '目标模式：说明目标后由服务端逐轮持续推进，直到完成、暂停或需要你决定。',
    usage: '/goal <要说的事>' },
];

/** 命令名语法：字母或汉字开头，后接字母/数字/连字符/汉字。 */
const COMMAND_NAME = /^[A-Za-z\u4e00-\u9fa5][A-Za-z0-9\u4e00-\u9fa5-]*$/u;
const MODEL_NAME = /^[A-Za-z0-9._:/-]{1,100}$/u;
const MAX_ARGUMENT_CHARS = 2_000;

export interface ChatCommandMenuEntry {
  readonly kind: 'METHOD' | 'SYSTEM';
  readonly name: string;
  readonly aliases: readonly string[];
  readonly title: string;
  readonly summary: string;
  readonly usage: string;
  readonly method_id?: BuiltinMethodId;
  readonly system_id?: SystemCommandId;
}

export type ChatCommandResolution =
  /** 不是命令：普通自然语言文本，交给既有意图解释。 */
  | { readonly kind: 'NOT_COMMAND' }
  /** 只输入了 `/`：展开菜单，不执行任何动作。 */
  | { readonly kind: 'MENU'; readonly entries: readonly ChatCommandMenuEntry[] }
  /** 已登记的方法命令。 */
  | { readonly kind: 'METHOD'; readonly method: FrozenMethodIdentity;
      readonly argument: string; readonly scope: MethodActionScope;
      readonly action: MethodActionKind }
  /** 已登记的系统命令。 */
  | { readonly kind: 'SYSTEM'; readonly system: SystemCommandId;
      readonly argument: string | null }
  /** 未登记命令：如实拒绝，保留可修改输入。 */
  | { readonly kind: 'UNKNOWN_COMMAND'; readonly name: string; readonly detail: string }
  /** 已登记但参数不合法：保留可修改输入。 */
  | { readonly kind: 'INVALID_ARGUMENT'; readonly name: string; readonly detail: string };

function normalizeToken(raw: string): string {
  return raw.trim().replace(/^\/+/u, '').toLowerCase();
}

/** 菜单登记项：方法在前，系统命令在后；顺序稳定，便于前端渲染与测试。 */
export function listChatCommands(): readonly ChatCommandMenuEntry[] {
  const entries: ChatCommandMenuEntry[] = [];
  for (const method of BUILTIN_METHOD_REGISTRY.methods) {
    entries.push({ kind: 'METHOD', name: method.definition.command,
      aliases: [...method.definition.aliases], title: method.definition.title,
      summary: method.definition.summary,
      usage: `/${method.definition.command} [目标]`, method_id: method.id });
  }
  for (const system of SYSTEM_COMMANDS) {
    entries.push({ kind: 'SYSTEM', name: system.command, aliases: [...system.aliases],
      title: system.usage, summary: system.summary, usage: system.usage,
      system_id: system.id });
  }
  return entries;
}

const SYSTEM_BY_TOKEN = new Map<string, SystemCommandDefinition>();
for (const system of SYSTEM_COMMANDS) {
  for (const token of [system.command, ...system.aliases]) {
    SYSTEM_BY_TOKEN.set(normalizeToken(token), system);
  }
}

/**
 * 解析一段用户输入。
 *
 * 只把**行首**的 `/名称` 当作命令：正文中间或代码块里的 `/` 不触发；名称后必须紧跟空白
 * 或输入结束，因此 `/usr/bin/env` 这类路径不会被误认成命令。未登记的名称一律类型化拒绝，
 * 既不执行也不猜测。
 */
export function resolveChatCommand(text: string): ChatCommandResolution {
  const trimmed = text.replace(/^\s+/u, '');
  // 代码块（``` 开头）整体按普通文本处理：其中的 `/` 是内容，不是命令。
  if (!trimmed.startsWith('/') || trimmed.startsWith('```')) return { kind: 'NOT_COMMAND' };
  if (trimmed === '/') return { kind: 'MENU', entries: listChatCommands() };
  const firstLineEnd = trimmed.indexOf('\n');
  const firstLine = firstLineEnd === -1 ? trimmed : trimmed.slice(0, firstLineEnd);
  const match = /^\/([^\s/]+)(.*)$/u.exec(firstLine);
  if (match === null) return { kind: 'NOT_COMMAND' };
  const rawName = match[1]!;
  const restOfFirstLine = match[2] ?? '';
  // 名称后紧跟 `/`（如 /usr/bin）说明这是路径而非命令，按普通文本处理。
  if (restOfFirstLine.startsWith('/')) return { kind: 'NOT_COMMAND' };
  if (!COMMAND_NAME.test(rawName)) {
    return { kind: 'UNKNOWN_COMMAND', name: rawName,
      detail: `“${rawName}”不是合法命令名；命令以字母或汉字开头。` };
  }
  const token = normalizeToken(rawName);
  const argument = (firstLineEnd === -1 ? restOfFirstLine
    : `${restOfFirstLine}\n${trimmed.slice(firstLineEnd + 1)}`).trim();

  const method = BUILTIN_METHOD_REGISTRY.byCommand(token);
  if (method !== undefined) {
    if (argument.length > MAX_ARGUMENT_CHARS) {
      return { kind: 'INVALID_ARGUMENT', name: rawName,
        detail: `命令参数超过 ${MAX_ARGUMENT_CHARS} 字符。` };
    }
    return { kind: 'METHOD', method: frozenMethodIdentity(method), argument,
      scope: method.definition.default_scope, action: method.definition.modify_when_requested
        ? methodActionForArgument(argument) : method.definition.default_action };
  }
  const system = SYSTEM_BY_TOKEN.get(token);
  if (system !== undefined) {
    if (system.argument === 'NONE') {
      if (argument !== '') {
        return { kind: 'INVALID_ARGUMENT', name: rawName,
          detail: `/${system.command} 不接受参数；用法：${system.usage}` };
      }
      return { kind: 'SYSTEM', system: system.id, argument: null };
    }
    if (system.argument === 'MODEL_NAME') {
      if (!MODEL_NAME.test(argument)) {
        return { kind: 'INVALID_ARGUMENT', name: rawName,
          detail: `/${system.command} 需要一个模型名；用法：${system.usage}` };
      }
      return { kind: 'SYSTEM', system: system.id, argument };
    }
    return { kind: 'SYSTEM', system: system.id, argument: argument === '' ? null : argument };
  }
  return { kind: 'UNKNOWN_COMMAND', name: rawName,
    detail: `没有登记名为 /${rawName} 的命令或方法；输入 / 查看可用项。` };
}

export function systemCommandDefinition(id: SystemCommandId): SystemCommandDefinition {
  const found = SYSTEM_COMMANDS.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`unknown system command: ${id}`);
  return found;
}
