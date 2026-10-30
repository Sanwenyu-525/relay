import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';

import type { DbExecutor } from '../infrastructure/database.js';
import type { GatewayCapability } from '../infrastructure/database-schema.js';
import { RELAY_AGENT_CORE_PROMPT } from '../workflow/agent-system-prompt.js';
import { readModelPortConfig } from '../workflow/model-port-config.js';
import { targetMatches } from './gateway-actions.js';
import { createRepositories } from './unit-of-work.js';

/**
 * 项目必读文件体积审计（2026-10-30）。
 *
 * 目的只有一个：在**一次高风险必读文件加载造成上下文压力之前**把风险说出来——哪个文件、
 * 多大、占有效输入预算几成、为什么危险、怎么降。它不新开一套预算体系：
 *
 *   · 预算口径与执行链一致——单次调用预算取工作区档位（0135），且不得大于 Provider
 *     声明的物理窗口，与 `planAssistModelBudget()` 同一判据；
 *   · Token 口径与 `context-builder` / `openai-compatible-model-port` 一致——
 *     UTF-8 字节数 ÷ 3，方法名 `ESTIMATED_UTF8_BYTES_DIV_3` 原样沿用，不换算法；
 *   · 权限口径与 `resolveSessionReadTools()` 一致——没有覆盖该目录的 ACTIVE
 *     `FILE_READ` 连接就不扫，不绕过 Gateway 判定，也不碰写权限。
 *
 * 三条硬边界：
 *   1. **只 stat，不读正文**（唯一例外是 ≤64 KiB 的项目声明清单）。估算是字节数换算，
 *      不调模型，也不把任何大型文件放进上下文。
 *   2. **只读**：不截断、不改写、不移动、不删除任何规则文件。
 *   3. **只提醒**：风险再高也不阻止发送，严重时给出明确的发送前提醒。
 *
 * 「必读」靠枚举而不是猜测：只认各 Agent 的官方规则入口 + 项目显式声明。项目里其余
 * Markdown 一律不进这份清单——把非必读的大型资料报成「自动加载」比漏报更糟。
 */

/* ------------------------------------------------------------------ 阈值 */

/**
 * 阈值集中在这一处：UI 只渲染服务端给的 severity 与文案，不自己算比例、不重复数字。
 * 调整阈值只改这里。
 */
export const REQUIRED_CONTEXT_THRESHOLDS = {
  /** 单个必读文件占有效输入预算的比例。 */
  single_file: { notice: 0.15, high: 0.30, severe: 0.50 },
  /** 多份必读文件的累计占比：单份都不高、加起来很高同样是风险。 */
  total_files: { notice: 0.30, high: 0.50, severe: 0.75 },
  /**
   * 工具定义预留：按「本轮真实可用的读取类工具」估，不按全量工具目录算，否则浏览器 /
   * 电脑操控的工具说明会把分母压低、把占比抬成假警报。
   */
  tool_definition_reserve_tokens: 4_096,
  /** 目录遍历与声明解析的缓存时长；文件体积与修改时间每次都重新 stat，不靠这个缓存。 */
  walk_cache_ttl_ms: 30_000,
  /** 一层子目录遍历上限：只判断「哪些子目录里还有规则文件」，不递归整棵树。 */
  max_scanned_directories: 50,
  /** `.relay/context-required.json` 的读取上限；超过视为配置不可用，不猜内容。 */
  max_config_bytes: 64 * 1_024,
  /** 单次审计列出的必读文件上限（正常项目远低于此）。 */
  max_required_files: 16,
} as const;

/** 与上下文构建、模型端口同一个估算口径；改这个对象等于换算法。 */
export const REQUIRED_CONTEXT_ESTIMATE = {
  method: 'ESTIMATED_UTF8_BYTES_DIV_3',
  bytes_per_token: 3,
  note: '按 UTF-8 字节数 ÷ 3 估算，与上下文构建和模型端口的预算口径一致；' +
    '中文偏保守、英文偏宽松，与 Provider 真实分词有偏差，只用于判断量级。',
} as const;

export type RequiredContextSeverity = 'NONE' | 'NOTICE' | 'HIGH' | 'SEVERE';

const SEVERITY_ORDER: readonly RequiredContextSeverity[] = ['NONE', 'NOTICE', 'HIGH', 'SEVERE'];

function worst(a: RequiredContextSeverity, b: RequiredContextSeverity): RequiredContextSeverity {
  return SEVERITY_ORDER.indexOf(a) >= SEVERITY_ORDER.indexOf(b) ? a : b;
}

/** 单个文件占比 → 档位。导出给读取前判断复用，不再复制一份阈值。 */
export function singleFileSeverity(ratio: number): RequiredContextSeverity {
  const t = REQUIRED_CONTEXT_THRESHOLDS.single_file;
  if (ratio >= t.severe) return 'SEVERE';
  if (ratio >= t.high) return 'HIGH';
  if (ratio >= t.notice) return 'NOTICE';
  return 'NONE';
}

/** 累计占比 → 档位。 */
export function totalFilesSeverity(ratio: number): RequiredContextSeverity {
  const t = REQUIRED_CONTEXT_THRESHOLDS.total_files;
  if (ratio >= t.severe) return 'SEVERE';
  if (ratio >= t.high) return 'HIGH';
  if (ratio >= t.notice) return 'NOTICE';
  return 'NONE';
}

/* ------------------------------------------------------- Agent 规则入口表 */

export type RequiredContextAgentId = 'relay' | 'codex' | 'claude' | 'codebuddy' | 'gemini' |
  'cursor' | 'copilot' | 'windsurf';

/** `AUTO_INJECTED` 由运行时自己读入；`TASK_REQUIRED` 由规则要求完整读取。 */
export type RequiredContextCategory = 'AUTO_INJECTED' | 'TASK_REQUIRED';
export type RequiredContextScope = 'ROOT' | 'NESTED' | 'DECLARED';

interface RuleEntry { readonly path: string; readonly category: RequiredContextCategory;
  readonly reason: string }

interface AgentRuleProfile {
  readonly id: RequiredContextAgentId;
  readonly label: string;
  /** 从受管根读起、必定生效的入口文件。 */
  readonly entries: readonly RuleEntry[];
  /** 在子目录同名出现时对该子树继续生效的规则文件名（`AGENTS.md` 这类继承链）。 */
  readonly nested_names: readonly string[];
  /** 目录型规则入口（如 `.cursor/rules/*.mdc`）：只列一层，按名称排序取前若干个。 */
  readonly rule_directory?: { readonly dir: string; readonly suffix: string;
    readonly limit: number; readonly category: RequiredContextCategory;
    readonly reason: string };
}

const AGENT_RULE_PROFILES: readonly AgentRuleProfile[] = [
  {
    id: 'relay', label: 'Relay 内置 Agent',
    entries: [
      { path: 'AGENTS.md', category: 'TASK_REQUIRED',
        reason: '项目规则入口：会话按项目约定在首轮完整读取，改动前复核约束。' },
      { path: 'CODEBUDDY.md', category: 'TASK_REQUIRED',
        reason: '本仓的 Agent 原生入口，AGENTS.md 要求先读它再按路由展开。' },
    ],
    nested_names: ['AGENTS.md'],
  },
  {
    id: 'codex', label: 'Codex CLI',
    entries: [{ path: 'AGENTS.md', category: 'AUTO_INJECTED',
      reason: '运行时把工作目录到仓库根的 AGENTS.md 链自动放进系统提示。' }],
    nested_names: ['AGENTS.md'],
  },
  {
    id: 'claude', label: 'Claude Code',
    entries: [
      { path: 'CLAUDE.md', category: 'AUTO_INJECTED', reason: '运行时自动读取并注入项目指令文件。' },
      { path: '.claude/CLAUDE.md', category: 'AUTO_INJECTED',
        reason: '运行时自动合并的目录级指令文件。' },
    ],
    nested_names: ['CLAUDE.md'],
  },
  {
    id: 'codebuddy', label: 'CodeBuddy / WorkBuddy',
    entries: [
      { path: 'CODEBUDDY.md', category: 'AUTO_INJECTED', reason: '原生规则入口，自动注入。' },
      { path: 'AGENTS.md', category: 'TASK_REQUIRED',
        reason: '由入口文件指向的规则主文档，要求完整读取。' },
    ],
    nested_names: ['AGENTS.md', 'CODEBUDDY.md'],
  },
  {
    id: 'gemini', label: 'Gemini CLI',
    entries: [{ path: 'GEMINI.md', category: 'AUTO_INJECTED',
      reason: '运行时自动读取并注入项目指令文件。' }],
    nested_names: ['GEMINI.md'],
  },
  {
    id: 'cursor', label: 'Cursor',
    entries: [{ path: '.cursorrules', category: 'AUTO_INJECTED',
      reason: '旧版规则入口，运行时自动注入。' }],
    nested_names: [],
    rule_directory: { dir: '.cursor/rules', suffix: '.mdc', limit: 8,
      category: 'AUTO_INJECTED', reason: '目录型规则入口，符合 glob 的规则会被自动注入。' },
  },
  {
    id: 'copilot', label: 'GitHub Copilot',
    entries: [{ path: '.github/copilot-instructions.md', category: 'AUTO_INJECTED',
      reason: '运行时自动注入的仓库级指令文件。' }],
    nested_names: [],
  },
  {
    id: 'windsurf', label: 'Windsurf',
    entries: [{ path: '.windsurfrules', category: 'AUTO_INJECTED',
      reason: '运行时自动注入的规则文件。' }],
    nested_names: [],
  },
];

/** 项目可显式声明的必读文档清单（只读；不存在即视为没有声明）。 */
export const REQUIRED_CONTEXT_DECLARATION_PATH = '.relay/context-required.json';

function resolveProfile(agentId: string | null | undefined): AgentRuleProfile {
  return AGENT_RULE_PROFILES.find((profile) => profile.id === agentId) ?? AGENT_RULE_PROFILES[0]!;
}

/* ------------------------------------------------------------------ 类型 */

export type RequiredContextState = 'OK' | 'NO_FILE_ACCESS' | 'SCAN_UNAVAILABLE';

export interface RequiredContextFile {
  /** 受管根内的相对路径，统一 `/` 分隔（界面直接显示）。 */
  readonly path: string;
  readonly category: RequiredContextCategory;
  readonly scope: RequiredContextScope;
  readonly reason: string;
  readonly bytes: number;
  readonly estimated_tokens: number;
  /** ISO 时间；「文件在扫描后被修改」的判据之一。 */
  readonly modified_at: string;
  /** 占有效输入预算的比例；分母不可用时为 null，不编造百分比。 */
  readonly share: number | null;
  readonly severity: RequiredContextSeverity;
}

export interface RequiredContextBudget {
  /** Provider 声明的物理窗口；未知必须是 null，不假定 256K/512K/无限。 */
  readonly provider_window_tokens: number | null;
  readonly provider_window_known: boolean;
  /** Relay-Agent 配置的单次调用预算（工作区档位优先）。 */
  readonly call_budget_tokens: number;
  readonly call_budget_source: 'SESSION' | 'WORKSPACE_TIER' | 'APPLICATION_DEFAULT';
  /** 有效输入预算 = min(窗口, 调用预算) − 预留；不可计算时为 null。 */
  readonly effective_input_tokens: number | null;
  readonly effective_basis: 'PROVIDER_WINDOW' | 'CALL_BUDGET' | 'UNAVAILABLE';
  readonly reserves: {
    readonly output_tokens: number;
    readonly system_prompt_tokens: number;
    readonly tool_definition_tokens: number;
    /** 首次发送前历史尚未进入本次调用，按 0 计；历史占用由圆环的实测读数单独表达。 */
    readonly history_tokens: number;
  };
  /** 本次预计总输入 = 必读文件 + 预留。 */
  readonly estimated_total_input_tokens: number | null;
  readonly required_total_tokens: number;
  readonly required_total_share: number | null;
  readonly confidence: 'EXACT_WINDOW' | 'WINDOW_UNKNOWN' | 'UNAVAILABLE';
  readonly estimate: typeof REQUIRED_CONTEXT_ESTIMATE;
}

export interface RequiredContextReason {
  readonly code: string;
  readonly text: string;
  /** 与本次判定相关的比例（无则 null）。 */
  readonly ratio: number | null;
  readonly path: string | null;
}

export interface RequiredContextAudit {
  readonly state: RequiredContextState;
  readonly detail: string;
  readonly agent: { readonly id: RequiredContextAgentId; readonly label: string };
  readonly root: string | null;
  readonly scanned_at: string;
  /**
   * 该目录当前必读文件集合的指纹：增删文件或体积/修改时间变化都会变。前端据此判断
   * 「本次忽略」是否还有效——文件实质变化后必须重新评估。
   */
  readonly fingerprint: string;
  readonly severity: RequiredContextSeverity;
  readonly files: readonly RequiredContextFile[];
  readonly budget: RequiredContextBudget;
  readonly reasons: readonly RequiredContextReason[];
  readonly suggestions: readonly { readonly code: string; readonly text: string }[];
  /** 跳过的条目（符号链接逃逸、无权限、声明不可用等），如实列出。 */
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
  /**
   * 本次扫描所用的读取入口（「查看文件」直接用同一连接与同一路径，不另开一条读取通道）。
   * 无权限或不适用时为 null。
   */
  readonly access: { readonly project_id: string; readonly connection_id: string } | null;
  readonly thresholds: typeof REQUIRED_CONTEXT_THRESHOLDS;
}

/* -------------------------------------------------------------- 只读扫描 */

interface RuleCandidate {
  readonly path: string;
  readonly category: RequiredContextCategory;
  readonly scope: RequiredContextScope;
  readonly reason: string;
}

interface Discovery {
  readonly candidates: readonly RuleCandidate[];
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
  /** 声明文件的 mtime:size；`none` 表示没有声明文件。 */
  readonly configKey: string;
}

interface CachedDiscovery { readonly at: number; readonly discovery: Discovery }
const discoveryCache = new Map<string, CachedDiscovery>();

/**
 * 受管根的真实路径缓存。根自身也可能是链接（导出的扫描函数会被直接调用），
 * 判断「真实目标是否仍在根内」必须拿真实根去比。
 */
const rootRealCache = new Map<string, string>();

/** 测试钩子：清掉遍历缓存，避免用例之间互相影响。 */
export function resetRequiredContextScanCache(): void {
  discoveryCache.clear(); rootRealCache.clear();
}

async function rootReal(root: string): Promise<string> {
  const cached = rootRealCache.get(root);
  if (cached !== undefined) return cached;
  let resolved: string;
  try { resolved = await realpath(root); } catch { resolved = root; }
  if (rootRealCache.size >= 16) rootRealCache.clear();
  rootRealCache.set(root, resolved);
  return resolved;
}

/** 大小写口径跟平台一致：Windows 上路径比较不区分大小写，也不做字符串前缀比较。 */
function containedIn(root: string, target: string): boolean {
  const norm = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;
  const part = relative(norm(root), norm(target));
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

/** 受管根内相对路径 → 绝对路径；越界（绝对路径、`..`、盘符）一律拒绝。 */
function insideRoot(root: string, relativePath: string): string | null {
  if (relativePath === '' || isAbsolute(relativePath) || /^[a-zA-Z]:/u.test(relativePath)) return null;
  const parts = relativePath.split(/[\\/]+/u).filter((part) => part !== '' && part !== '.');
  if (parts.length === 0 || parts.includes('..')) return null;
  const target = resolve(root, join(...parts));
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return target;
}

/**
 * 单文件探测：只 `lstat` + `stat`，不读正文。
 *
 * 符号链接 / Junction 先解析真实路径再判是否仍在受管根内——指向根外时按越界跳过，
 * 既不读也不抛错（安全失败），并把原因记进 `skipped` 让用户看得见。
 */
async function probeFile(root: string, relativePath: string): Promise<
  { readonly ok: true; readonly bytes: number; readonly mtimeMs: number;
    readonly canonical: string } |
  { readonly ok: false; readonly reason: string }> {
  const absolute = insideRoot(root, relativePath);
  if (absolute === null) return { ok: false, reason: '路径越出受管根，未读取' };
  try {
    // 先解析真实路径再判根内（2026-10-30 安全边界）：只查叶子链接挡不住父目录符号链接与
    // Windows Junction——`.relay` 指向根外时，lstat 会顺着父链接看到根外那个普通文件。
    let canonical: string;
    try { canonical = await realpath(absolute); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { ok: false, reason: '不存在' };
      if (code === 'EACCES' || code === 'EPERM') return { ok: false, reason: '没有读取权限' };
      if (code === 'ELOOP') return { ok: false, reason: '符号链接形成回路' };
      return { ok: false, reason: '链接路径无法解析（可能已失效），未读取' };
    }
    if (!containedIn(await rootReal(root), canonical)) {
      return { ok: false, reason: '真实路径落在受管根之外（父目录链接或 Junction 越界），未读取' };
    }
    const target = await stat(canonical);
    if (!target.isFile()) return { ok: false, reason: '不是普通文件' };
    return { ok: true, bytes: target.size, mtimeMs: target.mtimeMs, canonical };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, reason: '不存在' };
    if (code === 'EACCES' || code === 'EPERM') return { ok: false, reason: '没有读取权限' };
    if (code === 'ELOOP') return { ok: false, reason: '符号链接形成回路' };
    return { ok: false, reason: '无法读取文件属性' };
  }
}

/** 这些目录名不展开：只影响「有没有嵌套规则文件」，不影响任何必读判定。 */
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target',
  'coverage', '.next', '.venv', 'venv', '__pycache__', 'vendor']);

/**
 * 一层子目录遍历：只为找出「在该子树里还会命中的同名规则文件」。
 *
 * 不递归整棵树——嵌套规则文件的作用域就是它所在的子树，一层足以回答「还有哪些文件会在
 * 子目录里生效」。目录数硬上限保证扫描有界。
 */
async function walkNested(root: string, names: readonly string[], skip: ReadonlySet<string>,
  skipped: { path: string; reason: string }[]): Promise<{ path: string; bytes: number;
    mtimeMs: number }[]> {
  if (names.length === 0) return [];
  let entries: Dirent[];
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch { skipped.push({ path: '.', reason: '根目录无法枚举，未检查嵌套规则文件' }); return []; }
  const directories = entries.filter((entry) => entry.isDirectory() &&
    !SKIPPED_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.'))
    .slice(0, REQUIRED_CONTEXT_THRESHOLDS.max_scanned_directories);
  const found: { path: string; bytes: number; mtimeMs: number }[] = [];
  for (const directory of directories) {
    for (const name of names) {
      const relativePath = posix.join(directory.name, name);
      if (skip.has(relativePath)) continue;
      const probe = await probeFile(root, relativePath);
      if (probe.ok) found.push({ path: relativePath, bytes: probe.bytes, mtimeMs: probe.mtimeMs });
    }
  }
  return found;
}

interface DeclaredDocument { readonly path: string; readonly category: RequiredContextCategory;
  readonly reason: string }

interface Declarations { readonly documents: readonly DeclaredDocument[];
  readonly configKey: string; readonly skipped: { path: string; reason: string }[] }

/**
 * 读项目显式声明的必读文档（`.relay/context-required.json`）。
 *
 * 这是「项目配置显式声明的必读文档」的唯一入口：文件存在才读、有字节上限、逐条校验
 * 字段。配置坏了就如实列进 `skipped`，不猜作者意图，也不把整份 JSON 当正文塞上下文。
 */
async function readDeclarations(root: string): Promise<Declarations> {
  const relativePath = REQUIRED_CONTEXT_DECLARATION_PATH;
  const probe = await probeFile(root, relativePath);
  if (!probe.ok) {
    return { documents: [], configKey: probe.reason === '不存在' ? 'none' : 'unreadable',
      skipped: probe.reason === '不存在' ? [] : [{ path: relativePath, reason: probe.reason }] };
  }
  if (probe.bytes > REQUIRED_CONTEXT_THRESHOLDS.max_config_bytes) {
    return { documents: [], configKey: 'too-large',
      skipped: [{ path: relativePath, reason: '声明文件超过 64 KiB 上限，未解析' }] };
  }
  // 读的路径只用 probeFile 复核过的真实路径：链接换了也改不了这次钉住的 canonical。
  // 读前按真实路径再 stat 一次上限，避免扫描与读取之间被换成超大文件。
  const absolute = probe.canonical;
  let text: string;
  try {
    const current = await stat(absolute);
    if (current.size > REQUIRED_CONTEXT_THRESHOLDS.max_config_bytes) {
      return { documents: [], configKey: 'too-large',
        skipped: [{ path: relativePath, reason: '声明文件超过 64 KiB 上限，未解析' }] };
    }
    text = await readFile(absolute, 'utf8');
  } catch {
    return { documents: [], configKey: 'unreadable',
      skipped: [{ path: relativePath, reason: '声明文件在扫描后被替换或不可读，未采用' }] };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { return { documents: [], configKey: 'invalid',
    skipped: [{ path: relativePath, reason: '声明文件不是有效 JSON，未采用' }] }; }
  const documents: DeclaredDocument[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const list = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>).required_documents : undefined;
  if (Array.isArray(list)) {
    for (const item of list) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
      const row = item as Record<string, unknown>;
      const path = typeof row.path === 'string' ? row.path.trim() : '';
      const category = row.category === 'AUTO_INJECTED' ? 'AUTO_INJECTED'
        : row.category === 'TASK_REQUIRED' ? 'TASK_REQUIRED' : null;
      if (path === '' || category === null) {
        skipped.push({ path: path === '' ? relativePath : path,
          reason: '声明条目缺少 path 或 category 取值非法，未采用' });
        continue;
      }
      documents.push({ path, category,
        reason: typeof row.reason === 'string' && row.reason.trim() !== ''
          ? `项目声明：${row.reason.trim()}` : '项目在 .relay/context-required.json 中声明为必读' });
    }
  }
  return { documents, configKey: `${String(probe.mtimeMs)}:${String(probe.bytes)}`, skipped };
}

function normaliseEntry(path: string): string {
  return path.split(/[\\/]+/u).filter((part) => part !== '').join(posix.sep);
}

/**
 * 发现阶段：算出「这个根下有哪些规则入口候选」。
 *
 * 只做目录枚举与声明解析，不碰文件体积；结果按根 + Agent 缓存 30 秒，换目录或换 Agent
 * 自然不串用。文件体积与修改时间由 `materialise()` 每次重新 stat，所以缓存不会把
 * 「刚被改过的文件」骗成旧读数。
 */
async function discover(root: string, profile: AgentRuleProfile, refresh: boolean):
  Promise<Discovery> {
  const cacheKey = `${root}\u0000${profile.id}`;
  const cached = discoveryCache.get(cacheKey);
  if (!refresh && cached !== undefined &&
      Date.now() - cached.at < REQUIRED_CONTEXT_THRESHOLDS.walk_cache_ttl_ms) {
    // 声明文件可能在缓存期内新建或删除：它的存在性与缓存记的 configKey 对不上就重算。
    const present = (await probeFile(root, REQUIRED_CONTEXT_DECLARATION_PATH)).ok;
    if (present === (cached.discovery.configKey !== 'none' &&
        cached.discovery.configKey !== 'unreadable')) return cached.discovery;
    discoveryCache.delete(cacheKey);
  }
  const skipped: { path: string; reason: string }[] = [];
  const declarations = await readDeclarations(root);
  skipped.push(...declarations.skipped);
  const candidates: RuleCandidate[] = [];
  const seen = new Set<string>();
  const push = (candidate: RuleCandidate): void => {
    if (seen.has(candidate.path) ||
        candidates.length >= REQUIRED_CONTEXT_THRESHOLDS.max_required_files) return;
    seen.add(candidate.path);
    candidates.push(candidate);
  };
  for (const entry of [...profile.entries, ...declarations.documents]) {
    const path = normaliseEntry(entry.path);
    if (path === '') continue;
    push({ path,
      category: entry.category,
      scope: profile.entries.some((known) => known.path === entry.path) ? 'ROOT' : 'DECLARED',
      reason: entry.reason });
  }
  const ruleDirectory = profile.rule_directory;
  if (ruleDirectory !== undefined) {
    const absolute = insideRoot(root, ruleDirectory.dir);
    if (absolute !== null) {
      try {
        const entries = await readdir(absolute, { withFileTypes: true });
        for (const name of entries.filter((entry) => entry.isFile() &&
          entry.name.endsWith(ruleDirectory.suffix)).map((entry) => entry.name).sort()
          .slice(0, ruleDirectory.limit)) {
          push({ path: posix.join(ruleDirectory.dir, name), category: ruleDirectory.category,
            scope: 'ROOT', reason: ruleDirectory.reason });
        }
      } catch { /* 目录不存在或不可读：这类 Agent 的目录型入口本来就可以没有。 */ }
    }
  }
  for (const nested of await walkNested(root, profile.nested_names, seen, skipped)) {
    push({ path: nested.path, category: 'TASK_REQUIRED', scope: 'NESTED',
      reason: '子目录规则文件：在该子树内工作时按继承链继续生效。' });
  }
  const discovery: Discovery = { candidates, skipped, configKey: declarations.configKey };
  if (discoveryCache.size >= 8) discoveryCache.clear();
  discoveryCache.set(cacheKey, { at: Date.now(), discovery });
  return discovery;
}

interface FoundFile { readonly path: string; readonly bytes: number; readonly mtimeMs: number;
  readonly category: RequiredContextCategory; readonly scope: RequiredContextScope;
  readonly reason: string }

/** 物化阶段：对每个候选重新 stat，得到本次真实体积与修改时间。 */
async function materialise(root: string, discovery: Discovery): Promise<{
  found: readonly FoundFile[]; skipped: readonly { path: string; reason: string }[] }> {
  const found: FoundFile[] = [];
  const skipped = [...discovery.skipped];
  for (const candidate of discovery.candidates) {
    const probe = await probeFile(root, candidate.path);
    if (!probe.ok) {
      if (probe.reason !== '不存在') skipped.push({ path: candidate.path, reason: probe.reason });
      continue;
    }
    found.push({ path: candidate.path, bytes: probe.bytes, mtimeMs: probe.mtimeMs,
      category: candidate.category, scope: candidate.scope, reason: candidate.reason });
  }
  return { found, skipped };
}

/** 扫描结果的只读投影（不依赖数据库，便于单测直接验证文件系统行为）。 */
export interface RequiredContextScan {
  readonly files: readonly { readonly path: string;
    readonly category: RequiredContextCategory; readonly scope: RequiredContextScope;
    readonly reason: string; readonly bytes: number; readonly mtimeMs: number }[];
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
}

/**
 * 扫描一个受管根内会真正被读入的规则文件（不做权限判定——调用方必须先过 Gateway 判定）。
 *
 * 拆出来是为了让「文件被改 / 被删 / 被换成链接」这类行为能被单测直接验证，也让预发送审计
 * 与读取前判断共用同一份实现。
 */
export async function scanRequiredContextFiles(input: { readonly root: string;
  readonly agent?: string | null; readonly refresh?: boolean }): Promise<RequiredContextScan> {
  const profile = resolveProfile(input.agent);
  const scanned = await materialise(input.root, await discover(input.root, profile,
    input.refresh === true));
  return { files: scanned.found, skipped: scanned.skipped };
}

/* ------------------------------------------------------------------ 预算 */

const PROMPT_TOKENS = Math.max(1, Math.ceil(
  Buffer.byteLength(RELAY_AGENT_CORE_PROMPT, 'utf8') / REQUIRED_CONTEXT_ESTIMATE.bytes_per_token));

/** 0 字节就是 0 token：不为了「看着有数」把空文件报到 1。 */
function estimateTokens(bytes: number): number {
  return Math.max(0, Math.ceil(bytes / REQUIRED_CONTEXT_ESTIMATE.bytes_per_token));
}

/** 预算事实（调用方负责取数：窗口来自模型目录，档位来自工作区，输出预留来自端口配置）。 */
export interface BudgetInput { readonly providerWindow: number | null; readonly callBudget: number;
  readonly callBudgetSource: RequiredContextBudget['call_budget_source'];
  readonly outputReserve: number;
  /** 上一次调用的实测输入量（历史压力）；null/缺席按 0 预留，不猜。 */
  readonly historyTokens?: number | null }

/**
 * 历史上下文压力：会话上一次模型调用的实测 input tokens。
 *
 * 只读已结算的调用行，不估、不累加全部历史：读不到（新会话、旧数据、查询失败）就返回 null，
 * 预算按「历史 0」算——宁可少报一点，也不拿编出来的数当分母。
 */
async function readHistoryTokens(repositories: ReturnType<typeof createRepositories>,
  sessionId: string | null): Promise<number | null> {
  if (sessionId === null) return null;
  try {
    const call = await repositories.assist.latestContextUsageCall(sessionId);
    const measured = call?.usage_input_tokens ?? null;
    return measured !== null && measured > 0 ? measured : null;
  } catch { return null; }
}

/** 本轮可用上限 = min(Provider 窗口, 单次调用预算)。窗口未知时只看调用预算。 */
function ceilingOf(input: BudgetInput): number {
  return input.providerWindow === null ? input.callBudget
    : Math.min(input.providerWindow, input.callBudget);
}

/**
 * 有效输入预算 = `min(窗口, 调用预算) − 预留`。
 *
 * 工作区选 512K 而模型只支持 256K 时按 256K 算，绝不拿 Provider 装不下的数当分母；
 * 窗口未知时不假装知道，只用已配置的调用预算并把 `confidence` 降级为 `WINDOW_UNKNOWN`。
 */
function computeBudget(input: BudgetInput, requiredTokens: number): RequiredContextBudget {
  const reserves = { output_tokens: input.outputReserve, system_prompt_tokens: PROMPT_TOKENS,
    tool_definition_tokens: REQUIRED_CONTEXT_THRESHOLDS.tool_definition_reserve_tokens,
    history_tokens: Math.max(0, input.historyTokens ?? 0) };
  const reserved = reserves.output_tokens + reserves.system_prompt_tokens +
    reserves.tool_definition_tokens + reserves.history_tokens;
  const ceiling = ceilingOf(input);
  const effective = ceiling - reserved;
  const effectiveInput = effective > 0 ? effective : null;
  // 上限由谁决定：窗口已知且不大于档位时，是窗口在卡；否则是档位在卡；窗口未知只能是档位。
  const basis: RequiredContextBudget['effective_basis'] =
    input.providerWindow !== null && input.providerWindow <= input.callBudget
      ? 'PROVIDER_WINDOW' : 'CALL_BUDGET';
  return {
    provider_window_tokens: input.providerWindow,
    provider_window_known: input.providerWindow !== null,
    call_budget_tokens: input.callBudget,
    call_budget_source: input.callBudgetSource,
    effective_input_tokens: effectiveInput,
    effective_basis: effectiveInput === null ? 'UNAVAILABLE' : basis,
    reserves,
    estimated_total_input_tokens: effectiveInput === null ? null : requiredTokens + reserved,
    required_total_tokens: requiredTokens,
    required_total_share: effectiveInput === null ? null : requiredTokens / effectiveInput,
    confidence: effectiveInput === null ? 'UNAVAILABLE'
      : input.providerWindow === null ? 'WINDOW_UNKNOWN' : 'EXACT_WINDOW',
    estimate: REQUIRED_CONTEXT_ESTIMATE,
  };
}

/**
 * 单个文件的读取风险：**这是「这个文件值不值得读」的唯一判定**。
 *
 * 预发送审计的逐文件档位、以及界面上「查看文件」旁边的风险读数，都从这里出——
 * 用户手动读取与 Agent 自动读取因此不会出现两套结论。它只回答「值不值得提醒」，
 * 不改变读取本身的行为（不截断、不拒绝）。
 */
export function assessReadRisk(input: { readonly bytes: number;
  readonly effectiveInputTokens: number | null }): { readonly severity: RequiredContextSeverity;
  readonly ratio: number | null; readonly tokens: number } {
  const tokens = estimateTokens(input.bytes);
  if (input.effectiveInputTokens === null || input.effectiveInputTokens <= 0) {
    return { severity: 'NONE', ratio: null, tokens };
  }
  const ratio = tokens / input.effectiveInputTokens;
  return { severity: singleFileSeverity(ratio), ratio, tokens };
}

/* ------------------------------------------------------------------ 建议 */

const SUGGESTIONS = {
  SPLIT_ENTRY: '把大型入口文件拆成两段：入口只留导航与硬约束（通常一两百行），' +
    '细节移到 docs/ 下的专题文档，等 Agent 真的需要时再按需读取。',
  MOVE_REFERENCE: '把参考资料移出入口文件——研究笔记、完整日志、历史快照、生成产物不必每次随规则注入。',
  DEDUPLICATE: '同一条规则只在一处维护：入口与专题文档重复的段落删掉一侧，避免重复计费。',
  TRIM_WINDOW: '把工作区上下文档位调到与模型实际窗口一致：档位高于 Provider 窗口只会让读数失真。',
} as const;

/* ---------------------------------------------------------------- 主流程 */

export interface RequiredContextAuditInput {
  readonly workspaceId: string;
  readonly resourceId: string;
  /** 规则入口按哪类 Agent 算（`relay` 默认）；不同 Agent 的入口文件不同。 */
  readonly agent?: string | null;
  /** 当前选中的模型（OpenRouter 目录 id）；没选或不在目录里时按窗口未知处理。 */
  readonly model?: string | null;
  /** 会话 id：0145 起单次调用预算以会话档位为准，有会话就必须传，否则会按工作区默认报偏。 */
  readonly sessionId?: string | null;
  /** 跳过遍历缓存，重新遍历一次（发送前与手动刷新用）。 */
  readonly refresh?: boolean;
  /** 新会话首条消息尚无会话行时，用户已选的上下文档位（不传则按会话/工作区默认）。 */
  readonly budgetTokens?: number | null;
  /** 历史上下文预留（实测 input tokens）；不传则按会话上一次调用自动取。 */
  readonly historyTokens?: number | null;
  readonly env?: NodeJS.ProcessEnv;
}

/** 权限判据与 `resolveSessionReadTools()` 同一口径：必须有覆盖该根的 ACTIVE FILE_READ 连接。 */
async function findFileReadConnection(repositories: ReturnType<typeof createRepositories>,
  workspaceId: string, projectId: string | null, canonicalRoot: string): Promise<string | null> {
  if (projectId === null) return null;
  const capability: GatewayCapability = 'FILE_READ';
  for (const connection of await repositories.gateway.listConnections(workspaceId, projectId)) {
    if (connection.status !== 'ACTIVE') continue;
    if (typeof connection.config.root_path !== 'string') continue;
    if (!targetMatches(connection.config.root_path, canonicalRoot, capability)) continue;
    if (await repositories.gateway.hasConnectionCapability(connection.id, capability)) {
      return connection.id;
    }
  }
  return null;
}

const EMPTY_BUDGET_INPUT: BudgetInput = { providerWindow: null, callBudget: 1,
  callBudgetSource: 'APPLICATION_DEFAULT', outputReserve: 0 };

/**
 * 审计入口：给一个受管目录，回答「哪些必读文件会进上下文、占多少、危不危险」。
 *
 * 失败路径一律返回结构化结果而不是抛错：目录不存在、权限缺失、扫描失败都要能在界面上
 * 说清楚，不能变成一次静默的「没有风险」。
 */
export async function auditRequiredContext(db: DbExecutor,
  input: RequiredContextAuditInput): Promise<RequiredContextAudit> {
  const repositories = createRepositories(db);
  const profile = resolveProfile(input.agent);
  const scannedAt = new Date().toISOString();
  const base = { agent: { id: profile.id, label: profile.label },
    thresholds: REQUIRED_CONTEXT_THRESHOLDS } as const;
  const refuse = (state: RequiredContextState, detail: string, fingerprint: string,
    root: string | null = null): RequiredContextAudit => ({ ...base, state, detail, root,
    scanned_at: scannedAt, fingerprint, severity: 'NONE', files: [],
    budget: computeBudget(EMPTY_BUDGET_INPUT, 0), reasons: [], suggestions: [], skipped: [],
    access: null });

  const resource = await repositories.gateway.readResource(input.resourceId);
  if (resource === undefined || resource.workspace_id !== input.workspaceId) {
    return refuse('SCAN_UNAVAILABLE', '这个目录不属于当前工作空间，未做扫描。', 'unavailable');
  }
  if (resource.status !== 'ACTIVE') {
    return refuse('SCAN_UNAVAILABLE', '这个目录已停用，未做扫描。', 'inactive');
  }
  const connectionId = await findFileReadConnection(repositories, input.workspaceId,
    resource.project_id, resource.canonical_root);
  if (connectionId === null) {
    return refuse('NO_FILE_ACCESS',
      '这个目录没有生效的文件读取权限，未扫描任何文件（也不绕过权限去读）。', 'no-access');
  }

  let root: string;
  try { root = await realpath(resource.canonical_root); }
  catch { return refuse('SCAN_UNAVAILABLE', '目录已不存在或无法核对真实路径。', 'unresolved'); }

  const env = input.env ?? process.env;
  const config = readModelPortConfig(env);
  // 首条消息在建会话前就要预警：用户明确选的档位由调用方传入，已有会话仍读会话行。
  const selectedTier = typeof input.budgetTokens === 'number' && input.budgetTokens > 0
    ? input.budgetTokens : null;
  const budget = selectedTier === null
    ? await readCallBudget(repositories, input.workspaceId, input.sessionId ?? null)
    : { tokens: selectedTier, source: 'SESSION' as const };
  // P1-A 历史压力：显式传入优先；否则取该会话上一次调用的实测 input tokens。
  // 读不到就是「未知 → 按 0 预留」，不拿估计值冒充实测。
  const historyTokens = typeof input.historyTokens === 'number' && input.historyTokens > 0
    ? input.historyTokens
    : await readHistoryTokens(repositories, input.sessionId ?? null);
  const budgetInput: BudgetInput = {
    providerWindow: await readProviderWindow(repositories, input.model ?? null),
    historyTokens,
    callBudget: (budget.tokens ?? config?.maxCallTokens ?? 0) || 1,
    callBudgetSource: budget.source,
    outputReserve: config?.maxOutputTokens ?? 0,
  };

  let scanned: RequiredContextScan;
  try {
    scanned = await scanRequiredContextFiles({ root, agent: profile.id,
      refresh: input.refresh === true });
  } catch {
    return refuse('SCAN_UNAVAILABLE', '扫描这个目录时出错，没有得出任何结论。', 'scan-failed', root);
  }

  const sorted = [...scanned.files].sort((left, right) => right.bytes - left.bytes);
  const assessed = assessRequiredContextFiles(sorted, budgetInput);
  // 指纹要盖住全部「风险相关事实」（P1-C）：文件集合/体积/修改时间，加上模型、Provider 窗口、
  // 调用预算与有效输入预算（按 4K 取整，避免每条消息的历史增长都把忽略作废）。任一项变化
  // 都会生成新指纹，旧的「本次忽略」自动失效，不会拿旧结论掩盖新风险。
  const effectiveBucket = assessed.budget.effective_input_tokens === null ? 'unknown'
    : String(Math.round(assessed.budget.effective_input_tokens / 4_096));
  const fingerprint = createHash('sha256').update([root, profile.id,
    `model:${input.model ?? 'unknown'}`,
    `window:${assessed.budget.provider_window_tokens === null ? 'unknown'
      : String(assessed.budget.provider_window_tokens)}`,
    `budget:${String(assessed.budget.call_budget_tokens)}:${assessed.budget.call_budget_source}`,
    `effective:${effectiveBucket}`,
    `severity:${assessed.severity}`,
    ...assessed.files.map((file) => `${file.path}:${String(file.bytes)}:${file.modified_at}`)]
    .join('\n'), 'utf8').digest('hex').slice(0, 32);

  return { ...base, state: 'OK',
    detail: assessed.files.length === 0 ? '没有发现会进上下文的必读文件。'
      : `${String(assessed.files.length)} 份必读文件已计入预计加载量。`,
    root, scanned_at: scannedAt, fingerprint, severity: assessed.severity,
    files: assessed.files, budget: assessed.budget, reasons: assessed.reasons,
    suggestions: assessed.suggestions, skipped: scanned.skipped,
    access: resource.project_id === null ? null
      : { project_id: resource.project_id, connection_id: connectionId } };
}

/** 评估结果的纯逻辑部分（与扫描、权限、数据库无关，便于单测直接验证判定）。 */
export interface RequiredContextAssessment {
  readonly files: readonly RequiredContextFile[];
  readonly budget: RequiredContextBudget;
  readonly severity: RequiredContextSeverity;
  readonly reasons: readonly RequiredContextReason[];
  readonly suggestions: readonly { readonly code: string; readonly text: string }[];
}

/**
 * 风险判定：把「有哪些必读文件」+「预算事实」算成档位、原因与建议。
 *
 * 判定顺序固定：先单文件，再累计，再看总输入是否超预算，最后按窗口是否已知降级说明。
 * 分母是**有效输入预算**（不是模型窗口、不是文件字节数）——只比字节数会在 32K 窗口的
 * 小模型上漏报，在 1M 窗口的大模型上误报。
 */
export function assessRequiredContextFiles(
  input: readonly { readonly path: string; readonly category: RequiredContextCategory;
    readonly scope: RequiredContextScope; readonly reason: string; readonly bytes: number;
    readonly mtimeMs: number }[],
  budgetInput: BudgetInput): RequiredContextAssessment {
  const sorted = [...input].sort((left, right) => right.bytes - left.bytes);
  const requiredTokens = sorted.reduce((sum, file) => sum + estimateTokens(file.bytes), 0);
  const budget = computeBudget(budgetInput, requiredTokens);
  const denominator = budget.effective_input_tokens;
  const files: RequiredContextFile[] = sorted.map((file) => {
    const risk = assessReadRisk({ bytes: file.bytes, effectiveInputTokens: denominator });
    return { path: file.path, category: file.category, scope: file.scope, reason: file.reason,
      bytes: file.bytes, estimated_tokens: risk.tokens,
      modified_at: new Date(file.mtimeMs).toISOString(), share: risk.ratio,
      severity: risk.severity };
  });

  const reasons: RequiredContextReason[] = [];
  let severity: RequiredContextSeverity = 'NONE';
  for (const file of files) {
    if (file.share === null) continue;
    const level = singleFileSeverity(file.share);
    if (level === 'NONE') continue;
    severity = worst(severity, level);
    reasons.push({ code: `SINGLE_FILE_${level}`, path: file.path, ratio: file.share,
      text: `${file.path} 预计占有效输入预算的 ${percentText(file.share)}` });
  }
  if (budget.required_total_share !== null && files.length > 1) {
    const level = totalFilesSeverity(budget.required_total_share);
    if (level !== 'NONE') {
      severity = worst(severity, level);
      reasons.push({ code: `TOTAL_FILES_${level}`, path: null, ratio: budget.required_total_share,
        text: `${String(files.length)} 份必读文件累计预计占 ${percentText(budget.required_total_share)}` });
    }
  }
  if (budget.estimated_total_input_tokens !== null &&
      budget.estimated_total_input_tokens > ceilingOf(budgetInput)) {
    severity = 'SEVERE';
    reasons.push({ code: 'TOTAL_EXCEEDS_BUDGET', path: null, ratio: null,
      text: `预计总输入 ${String(budget.estimated_total_input_tokens)} tokens 超过本轮可用预算 ` +
        `${String(ceilingOf(budgetInput))} tokens，首轮就可能触发压缩` });
  }
  if (budget.confidence === 'WINDOW_UNKNOWN') {
    reasons.push({ code: 'WINDOW_UNKNOWN', path: null, ratio: null,
      text: '模型窗口未知：占比按已配置的调用预算估算，不是 Provider 物理窗口的精确读数' });
  }
  if (budget.confidence === 'UNAVAILABLE') {
    // 分母算不出来时宁可什么都不说，也不给一个凑出来的百分比。
    severity = 'NONE';
    reasons.push({ code: 'BUDGET_UNAVAILABLE', path: null, ratio: null,
      text: '有效预算无法计算（预留已占满或配置缺失），本次不给占比结论' });
  }

  const suggestions: { code: string; text: string }[] = [];
  if (severity !== 'NONE') {
    suggestions.push({ code: 'SPLIT_ENTRY', text: SUGGESTIONS.SPLIT_ENTRY });
    suggestions.push({ code: 'MOVE_REFERENCE', text: SUGGESTIONS.MOVE_REFERENCE });
    if (files.length > 1) suggestions.push({ code: 'DEDUPLICATE', text: SUGGESTIONS.DEDUPLICATE });
    if (budget.provider_window_tokens !== null &&
        budget.call_budget_tokens > budget.provider_window_tokens) {
      suggestions.push({ code: 'TRIM_WINDOW', text: SUGGESTIONS.TRIM_WINDOW });
    }
  }
  return { files, budget, severity, reasons, suggestions };
}

/**
 * 单次调用预算：会话档位 → 工作区默认档位 → 应用配置默认。
 *
 * 与执行链的优先级**必须一致**（0145 起档位是会话行的事实，工作区行只是新会话的默认）：
 * 有会话却按工作区默认报数，会出现「同一个会话里预警说 43%、圆环说 78%」这种自相矛盾。
 */
async function readCallBudget(repositories: ReturnType<typeof createRepositories>,
  workspaceId: string, sessionId: string | null): Promise<{
  readonly tokens: number | null;
  readonly source: RequiredContextBudget['call_budget_source'] }> {
  if (sessionId !== null && sessionId !== '') {
    const session = await repositories.assist.readSession(sessionId);
    if (session?.workspace_id === workspaceId) {
      return { tokens: session.context_budget_tokens, source: 'SESSION' };
    }
  }
  const configured = await repositories.workspaces.readDefaultDirectory(workspaceId);
  const workspaceTier = configured?.context_budget_tokens ?? null;
  return { tokens: workspaceTier,
    source: workspaceTier === null ? 'APPLICATION_DEFAULT' : 'WORKSPACE_TIER' };
}

/** Provider 声明的物理窗口。未知一律 null——不假定 256K、512K 或无限。 */
async function readProviderWindow(repositories: ReturnType<typeof createRepositories>,
  model: string | null): Promise<number | null> {
  if (model === null || model.trim() === '') return null;
  try {
    // 按实际使用的模型 id 查目录（不限免费项）：只查免费目录会把非免费 / 自建连接的窗口
    // 一律读成未知，从而把「估算限制」当成事实。
    const entry = await repositories.modelCatalog.readEntryBySourceModelId(model);
    return entry?.context_window ?? null;
  } catch {
    // 目录读不到 ≠ 窗口无限；保持未知。
    return null;
  }
}

function percentText(ratio: number): string {
  const percent = ratio * 100;
  return percent >= 10 ? `${String(Math.round(percent))}%` : `${percent.toFixed(1)}%`;
}
