import type { JsonObject } from '../infrastructure/json.js';
import type { GatewayActionType } from '../application/gateway-actions.js';
import type { ModelToolSpec } from './fake-model-port.js';

/**
 * 首批内部工具词表（docs/architecture/tool-adapters.md §1.3、§1.4）。
 *
 * 这份词表是冻结协议：模型能请求的工具、它们的参数 schema、以及每个工具对应的
 * Gateway 逻辑动作都在这里定义一次。模型不能自带动作名，也不能通过改名绕过准入——
 * 未在词表内的工具名在落库前即被拒绝。
 *
 * 工具名使用 snake_case，与 Gateway 的 action_type 不同：模型面对的是稳定的对外名，
 * action_type 是 Gateway 内部的逻辑动作分类。
 */

export type InternalToolName =
  | 'list_directory'
  | 'find_paths'
  | 'search_text'
  | 'read_file'
  | 'git_status'
  | 'git_diff'
  | 'git_log';

export interface InternalToolDefinition {
  readonly name: InternalToolName;
  /** 对应的 Gateway 逻辑动作；写入类工具在后续片加入同一张表。 */
  readonly actionType: GatewayActionType;
  /** 执行时使用的连接能力。 */
  readonly capability: 'FILE_QUERY' | 'FILE_READ' | 'GIT_READ' | 'FILE_WRITE' | 'CLI_RUN';
  readonly spec: ModelToolSpec;
}

const RELATIVE_PATH_PROPERTY: JsonObject = {
  type: 'string',
  description: '受管根内的相对路径；缺省表示受管根本身。只接受 / 分隔的相对路径。',
};

function definition(name: InternalToolName, actionType: GatewayActionType,
  capability: InternalToolDefinition['capability'], description: string,
  parameters: JsonObject, required: readonly string[]): InternalToolDefinition {
  return { name, actionType, capability,
    spec: { name, description, parameters: { type: 'object', properties: parameters,
      required: [...required], additionalProperties: false } } };
}

export const INTERNAL_TOOL_DEFINITIONS: readonly InternalToolDefinition[] = [
  definition('list_directory', 'LIST_DIRECTORY', 'FILE_QUERY',
    '列出受管根内某个目录的一层条目。返回有界的相对路径、类型与大小，截断时显式标记。',
    { relative_path: RELATIVE_PATH_PROPERTY, limit: { type: 'integer', minimum: 1 } }, []),
  definition('find_paths', 'FIND_PATHS', 'FILE_QUERY',
    '在受管根内按路径子串查找文件。不读取正文，只返回相对路径。',
    { pattern: { type: 'string', description: '大小写不敏感的路径子串。' },
      relative_path: RELATIVE_PATH_PROPERTY,
      limit: { type: 'integer', minimum: 1 } }, ['pattern']),
  definition('search_text', 'SEARCH_TEXT', 'FILE_QUERY',
    '在受管根内按字面串搜索文件正文。每个文件只返回第一处命中的行号与该行文本。',
    { query: { type: 'string', description: '字面查询串，区分大小写。' },
      relative_path: RELATIVE_PATH_PROPERTY,
      limit: { type: 'integer', minimum: 1 } }, ['query']),
  definition('read_file', 'READ_FILE', 'FILE_READ',
    '读取受管根内一个既有普通文件的完整文本。最多 128 KiB；不支持的格式返回类型化失败。',
    { relative_path: { type: 'string', description: '受管根内必填的相对文件路径。' } },
    ['relative_path']),
  definition('git_status', 'GIT_STATUS', 'GIT_READ',
    '读取受管根的 Git 工作区状态：分支、HEAD、已暂存/未暂存/未跟踪。',
    {}, []),
  definition('git_diff', 'GIT_DIFF', 'GIT_READ',
    '读取受管根的 Git 差异。非 Git 目录返回类型化失败而不是空输出。',
    { path: { type: 'string', description: '可选的根内相对路径限定。' },
      staged: { type: 'boolean', description: '只读已暂存差异。' } }, []),
  definition('git_log', 'GIT_LOG', 'GIT_READ',
    '读取受管根最近的 Git 提交。非 Git 目录或无 HEAD 返回类型化失败。',
    { max_count: { type: 'integer', minimum: 1, maximum: 50 } }, []),
];

const BY_NAME = new Map<string, InternalToolDefinition>(
  INTERNAL_TOOL_DEFINITIONS.map((entry) => [entry.name, entry]),
);

export function readInternalTool(name: string): InternalToolDefinition | undefined {
  return BY_NAME.get(name);
}

/** 本次 DRAFT 向模型声明的工具集合，按词表顺序固定，保证请求可复现。 */
export function declaredToolSpecs(
  allowed: readonly string[] | undefined,
): readonly ModelToolSpec[] {
  const permitted = allowed === undefined ? null : new Set(allowed);
  return INTERNAL_TOOL_DEFINITIONS
    .filter((entry) => permitted === null || permitted.has(entry.name))
    .map((entry) => entry.spec);
}