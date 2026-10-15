const RELATIVE_PATH_PROPERTY = {
    type: 'string',
    description: '受管根内的相对路径；缺省表示受管根本身。只接受 / 分隔的相对路径。',
};
function definition(name, actionType, capability, description, parameters, required) {
    return { name, actionType, capability,
        spec: { name, description, parameters: { type: 'object', properties: parameters,
                required: [...required], additionalProperties: false } } };
}
export const INTERNAL_TOOL_DEFINITIONS = [
    definition('apply_changeset', 'APPLY_CHANGESET', 'FILE_WRITE', '在受管根内新建、修改或删除文件。修改与删除必须带实际读取到的基线摘要，' +
        '落盘前会再次比对；基线变化时保留用户的新改动而不覆盖。删除始终需要单独确认。', { changes: { type: 'array', description: '1 到 8 项文件变更。',
            items: { type: 'object', additionalProperties: false,
                properties: {
                    path: { type: 'string', description: '受管根内的相对文件路径。' },
                    action: { type: 'string', enum: ['CREATE', 'MODIFY', 'DELETE'],
                        description: 'CREATE 新建（目标必须不存在）、MODIFY 修改、DELETE 删除。' },
                    content: { type: 'string',
                        description: '新建或修改后的完整文件内容；DELETE 不给这一项。' },
                    baselineSha256: { type: 'string',
                        description: 'MODIFY/DELETE 必填：read_file 读到的那份内容对应的 64 位 SHA-256；' +
                            'CREATE 不给这一项。' },
                },
                required: ['path', 'action'] } } }, ['changes']),
    definition('read_change_set', 'READ_CHANGE_SET', 'FILE_WRITE', '读取某一次已冻结文件变更的基线、目标与实际结果摘要，以及受保护路径与越界拒绝原因。' +
        '用于在不重新读盘的情况下核对「究竟改了什么」。', { operation_id: { type: 'string', description: '此前 apply_changeset 返回的 operation_id。' } }, ['operation_id']),
    definition('run_check', 'CLI_RUN', 'CLI_RUN', '运行本次任务范围内已配置的一次检查（测试或构建）。只能按 check_id 点名已配置命令，' +
        '不能提交任意命令字符串。输出有上限，超时或被取消会如实记录。', { check_id: { type: 'string', description: '已配置检查的标识。' } }, ['check_id']),
    definition('list_directory', 'LIST_DIRECTORY', 'FILE_QUERY', '列出受管根内某个目录的一层条目。返回有界的相对路径、类型与大小，截断时显式标记。', { relative_path: RELATIVE_PATH_PROPERTY, limit: { type: 'integer', minimum: 1 } }, []),
    definition('find_paths', 'FIND_PATHS', 'FILE_QUERY', '在受管根内按路径子串查找文件。不读取正文，只返回相对路径。', { pattern: { type: 'string', description: '大小写不敏感的路径子串。' },
        relative_path: RELATIVE_PATH_PROPERTY,
        limit: { type: 'integer', minimum: 1 } }, ['pattern']),
    definition('search_text', 'SEARCH_TEXT', 'FILE_QUERY', '在受管根内按字面串搜索文件正文。每个文件只返回第一处命中的行号与该行文本。', { query: { type: 'string', description: '字面查询串，区分大小写。' },
        relative_path: RELATIVE_PATH_PROPERTY,
        limit: { type: 'integer', minimum: 1 } }, ['query']),
    definition('read_file', 'READ_FILE', 'FILE_READ', '读取受管根内一个既有普通文件的完整文本。最多 128 KiB；不支持的格式返回类型化失败。', { relative_path: { type: 'string', description: '受管根内必填的相对文件路径。' } }, ['relative_path']),
    definition('git_status', 'GIT_STATUS', 'GIT_READ', '读取受管根的 Git 工作区状态：分支、HEAD、已暂存/未暂存/未跟踪。', {}, []),
    definition('git_diff', 'GIT_DIFF', 'GIT_READ', '读取受管根的 Git 差异。非 Git 目录返回类型化失败而不是空输出。', { path: { type: 'string', description: '可选的根内相对路径限定。' },
        staged: { type: 'boolean', description: '只读已暂存差异。' } }, []),
    definition('git_log', 'GIT_LOG', 'GIT_READ', '读取受管根最近的 Git 提交。非 Git 目录或无 HEAD 返回类型化失败。', { max_count: { type: 'integer', minimum: 1, maximum: 50 } }, []),
];
const BY_NAME = new Map(INTERNAL_TOOL_DEFINITIONS.map((entry) => [entry.name, entry]));
export function readInternalTool(name) {
    return BY_NAME.get(name);
}
/** 本次 DRAFT 向模型声明的工具集合，按词表顺序固定，保证请求可复现。 */
export function declaredToolSpecs(allowed) {
    const permitted = allowed === undefined ? null : new Set(allowed);
    return INTERNAL_TOOL_DEFINITIONS
        .filter((entry) => permitted === null || permitted.has(entry.name))
        .map((entry) => entry.spec);
}
