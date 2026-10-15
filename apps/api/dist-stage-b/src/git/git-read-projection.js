/**
 * 人工触发的 Git 只读结果有界化（docs/architecture/tool-adapters.md §1.4 的同一口径）。
 *
 * 与 `files/file-query.ts` 一致：结果必须显式带 `limit` 与 `truncated`，截断的结果不能被下游
 * 当作完整证据。这里只做**投影层**的有界化，不改适配器本身：`GIT_STATUS` 限制路径条目数，
 * `GIT_DIFF` 限制正文字节数，两者都保留真实计数而不是丢掉溢出部分的事实。
 */
/** GIT_STATUS 单次最多返回的路径条目数（staged / unstaged / untracked 各自独立计数）。 */
export const GIT_STATUS_MAX_PATHS = 200;
/** GIT_DIFF 单次最多返回的正文字节数。 */
export const GIT_DIFF_MAX_BYTES = 256 * 1024;
function boundedLimit(limit, max) {
    if (limit === undefined || !Number.isInteger(limit) || limit <= 0)
        return max;
    return Math.min(limit, max);
}
function boundPaths(paths, limit) {
    return { paths: paths.slice(0, limit), truncated: paths.length > limit, total: paths.length };
}
/** 三个列表各自按 limit 截断；`truncated` 是它们的合取，`totals` 保留真实计数。 */
export function projectGitStatus(status, limit) {
    const bounded = boundedLimit(limit, GIT_STATUS_MAX_PATHS);
    const staged = boundPaths(status.staged, bounded);
    const unstaged = boundPaths(status.unstaged, bounded);
    const untracked = boundPaths(status.untracked, bounded);
    return {
        branch: status.branch,
        head_commit: status.headCommit,
        staged: [...staged.paths],
        unstaged: [...unstaged.paths],
        untracked: [...untracked.paths],
        limit: bounded,
        truncated: staged.truncated || unstaged.truncated || untracked.truncated,
        totals: {
            staged: staged.total, unstaged: unstaged.total, untracked: untracked.total,
        },
    };
}
/** 按字节截断 diff；不完整文本不得呈现为完整，因此显式给出 omitted_bytes。 */
export function projectGitDiff(diff, limitBytes) {
    const bounded = boundedLimit(limitBytes, GIT_DIFF_MAX_BYTES);
    const bytes = Buffer.byteLength(diff, 'utf8');
    if (bytes <= bounded) {
        return { diff, limit_bytes: bounded, truncated: false,
            returned_bytes: bytes, omitted_bytes: 0 };
    }
    // 不在多字节字符中间切断：diff 里可能出现中文正文，按字节硬切会产生半个字符。
    const buffer = Buffer.from(diff, 'utf8');
    let end = bounded;
    while (end > 0 && (buffer[end] & 0xc0) === 0x80)
        end -= 1;
    const omitted = bytes - end;
    return { diff: buffer.subarray(0, end).toString('utf8'), limit_bytes: bounded,
        truncated: true, returned_bytes: end, omitted_bytes: omitted };
}
