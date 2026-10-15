import { isAbsolute, relative, sep } from 'node:path';
/**
 * 检查入口准入（docs/architecture/tool-adapters.md §2，plans/2026-10-05-cli-executable-admission.md）。
 *
 * 模型只**提出**一个可执行入口；能不能跑由受管根与用户在 CLI_RUN 连接上配置的允许清单
 * 决定。模型输出不是授权——把它当授权就是把外部内容升级成了规则。
 *
 * 与 `evaluateScopeGrant` 同构：判定是纯函数，只用调用方取来的持久化事实，
 * 因此 prepare 与 admit 调用同一个函数必然得到同一结论。
 *
 * 刻意不管根身份：`evaluateScopeGrant` 已经先于任何清单比对核对过根物理身份
 * （授权失效时返回 `SCOPE_GRANT_ROOT_CHANGED`）。同一规则实现两处会漂移，
 * 所以这里只回答「这个入口允许跑吗」这一个问题。
 */
export const EXECUTABLE_ADMISSION_REASON = {
    /** 入口既不在受管根内，也不在连接的允许清单里。 */
    NOT_ALLOWED: 'EXECUTABLE_NOT_ALLOWED',
};
/**
 * 严格包含：等于根不算在根内。
 *
 * 可执行文件不可能是目录，所以「等于根」没有可接受的语义，按不在根内处理。
 * 路径大小写按 Windows 的解析口径归一，与 Gateway 的根内判定同规则。
 */
export function isWithinRoot(root, target) {
    const normalizedRoot = process.platform === 'win32' ? root.toLowerCase() : root;
    const normalizedTarget = process.platform === 'win32' ? target.toLowerCase() : target;
    const part = relative(normalizedRoot, normalizedTarget);
    return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}
export function evaluateExecutableAdmission(input) {
    // 项目自己的脚本不需要额外配置；根外入口（包管理器、解释器、系统工具）必须由用户点名。
    if (isWithinRoot(input.canonicalRoot, input.frozenExecutable))
        return { covered: true };
    const allowed = input.allowedExecutables;
    if (allowed !== undefined) {
        const fold = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
        const target = fold(input.frozenExecutable);
        if (allowed.some((entry) => fold(entry) === target))
            return { covered: true };
    }
    return { covered: false, reason: EXECUTABLE_ADMISSION_REASON.NOT_ALLOWED };
}
