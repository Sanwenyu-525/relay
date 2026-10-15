import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import { canonicalizeJson } from '../receipt/payload-hash.js';
import { canonicalResourceIdentity } from './gateway-configuration.js';
/**
 * 检查入口信任摘要（Stage A）。
 *
 * 只回答一个问题：**这次检查实际要跑的材料，此刻在磁盘上是什么**。
 *
 * 它刻意只覆盖一个**有限、明确、可枚举**的集合：
 *   - 入口可执行程序（冻结清单里的 executable，根内或根外都算）；
 *   - 入口程序的**第一个位置脚本参数**（`node <script>` / `python <script>` 形态里真正被执行的脚本）；
 *   - 受管根**顶层**直接决定检查行为的构建/测试配置（package.json / tsconfig / vitest / jest 等）。
 *
 * 它不做的事，和它做的事同样重要：
 *   - 不放宽连接允许的可执行入口清单，也不放宽用户授予的动作权限（那是
 *     `evaluateExecutableAdmission` 与 `evaluateScopeGrant` 的职责）；
 *   - 不遍历整个仓库、node_modules 或动态依赖；
 *   - 不把**被检查的源文件**当材料。工作集本来就是要被读取、修改、再检查的对象，
 *     把它算进材料会让「检查失败 → 修正 → 再跑同一检查」这条主链直接不可用。
 *
 * 因此后续位置参数（`node check.mjs src/feature.mjs` 里的 `src/feature.mjs`）是这次检查的
 * **输入**而不是程序，不进材料。检查程序自己 import 的兄弟模块同理不进材料；这一范围限制
 * 已在架构文档中写明，不用「静默少算材料」去维持 AUTO。
 *
 * 解释器内联求值（`-e` / `-c` / `--eval`）、shell 组合（`&&`、`|`、`;`、反引号、`$()`）与
 * 通配符无法在有限模型内证明范围，一律明确判为不支持自动信任（进入 ASK/DENY），
 * 而不是当成「没有额外材料」放行。
 */
export const CHECK_TRUST_REASON = {
    /** 材料在磁盘上不存在、不是普通文件或读不出来。 */
    MATERIAL_UNREADABLE: 'CHECK_TRUST_MATERIAL_UNREADABLE',
    /** 参数含解释器内联求值、shell 组合或通配符，无法证明执行范围。 */
    DYNAMIC_EXECUTION_UNSUPPORTED: 'CHECK_TRUST_DYNAMIC_EXECUTION_UNSUPPORTED',
};
const TRUST_BASIS_VERSION = 'check-trust-v1';
/**
 * 直接决定检查行为的构建/测试配置：只在受管根**顶层**按名单取，不递归、不遍历仓库。
 * 名单之外的文件（源码、夹具、数据）都不是材料。
 */
const TRUST_BUILD_CONFIG_FILES = [
    'package.json',
    'tsconfig.json',
    'tsconfig.base.json',
    'vitest.config.ts',
    'vitest.config.js',
    'vitest.config.mjs',
    'vitest.config.mts',
    'vitest.config.cts',
    'vite.config.ts',
    'vite.config.js',
    'vite.config.mjs',
    'jest.config.ts',
    'jest.config.js',
    'jest.config.mjs',
    'jest.config.cjs',
];
/** 只有这些扩展名的位置参数才被当作「被引用的脚本」；`.txt` / `.json` 之类是输入，不是程序。 */
const SCRIPT_EXTENSIONS = new Set([
    '.mjs', '.cjs', '.js', '.mts', '.cts', '.ts', '.tsx', '.jsx',
    '.sh', '.bash', '.zsh', '.ps1', '.psm1', '.bat', '.cmd', '.py', '.rb',
]);
/**
 * 解释器内联求值 / 动态加载开关：无法在有限模型内证明范围，明确不支持自动信任。
 * 覆盖 node / python / shell 的常见形态。
 */
const DYNAMIC_FLAGS = new Set([
    '-c', '-e', '-p', '-i', '-m', '-r',
    '--eval', '--print', '--input-type', '--interactive', '--module', '--require',
    '--import', '--loader', '--experimental-loader',
]);
/** shell 元字符：出现即说明参数不是单一文件引用。 */
const SHELL_METACHARACTERS = /[&|;`$><\n\r]/;
/** 通配符 / 花括号展开：出现即说明参数指向一组未知文件。 */
const GLOB_CHARACTERS = /[*?{}]/;
async function readRegularFile(path) {
    let real;
    try {
        real = await realpath(path);
    }
    catch {
        return null;
    }
    let info;
    try {
        info = await stat(real);
    }
    catch {
        return null;
    }
    if (!info.isFile())
        return null;
    let bytes;
    try {
        bytes = await readFile(real);
    }
    catch {
        return null;
    }
    return { identity: canonicalResourceIdentity(real), sha256: sha256(bytes) };
}
function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}
function rootRelative(rootIdentity, materialIdentity) {
    const part = relative(rootIdentity, materialIdentity);
    if (part === '' || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part))
        return null;
    return part;
}
function classifyValue(value) {
    if (value === '')
        return { kind: 'FLAG' };
    if (SHELL_METACHARACTERS.test(value)) {
        return { kind: 'DYNAMIC', detail: `参数 ${JSON.stringify(value)} 含 shell 元字符` };
    }
    if (GLOB_CHARACTERS.test(value)) {
        return { kind: 'DYNAMIC', detail: `参数 ${JSON.stringify(value)} 含通配符` };
    }
    // 裸词（既不是开关，也不含扩展名或路径分隔符）无法证明是哪一个文件。
    if (!/[.\\/]/.test(value)) {
        return { kind: 'DYNAMIC', detail: `参数 ${JSON.stringify(value)} 不是单一文件引用` };
    }
    return { kind: 'PATH', value };
}
function classifyArg(raw) {
    if (raw === '')
        return { kind: 'DYNAMIC', detail: '空参数无法证明执行范围' };
    if (SHELL_METACHARACTERS.test(raw)) {
        return { kind: 'DYNAMIC', detail: `参数 ${JSON.stringify(raw)} 含 shell 元字符` };
    }
    if (GLOB_CHARACTERS.test(raw)) {
        return { kind: 'DYNAMIC', detail: `参数 ${JSON.stringify(raw)} 含通配符` };
    }
    if (raw.startsWith('-')) {
        if (DYNAMIC_FLAGS.has(raw.toLowerCase())) {
            return { kind: 'DYNAMIC', detail: `开关 ${raw} 属于解释器内联求值或动态加载` };
        }
        const separator = raw.indexOf('=');
        if (separator > 0)
            return classifyValue(raw.slice(separator + 1));
        return { kind: 'FLAG' };
    }
    return classifyValue(raw);
}
export async function computeCheckTrustBasis(input) {
    const rootIdentity = canonicalResourceIdentity((await realpathOrNull(input.canonicalRoot)) ?? input.canonicalRoot);
    const materials = [];
    const seen = new Set();
    const push = (identity, digest, role) => {
        if (seen.has(identity))
            return;
        seen.add(identity);
        materials.push({ path: identity, rootRelativePath: rootRelative(rootIdentity, identity),
            sha256: digest, role });
    };
    const executable = await readRegularFile(input.executable);
    if (executable === null) {
        return unreadable(input.executable);
    }
    push(executable.identity, executable.sha256, 'EXECUTABLE');
    // 只有第一个位置脚本参数是「被执行的程序」；后续位置参数是这次检查的输入（工作集）。
    let positional = 0;
    for (const arg of input.args) {
        const classified = classifyArg(arg);
        if (classified.kind === 'DYNAMIC') {
            return { ok: false, reason: CHECK_TRUST_REASON.DYNAMIC_EXECUTION_UNSUPPORTED,
                detail: classified.detail };
        }
        if (classified.kind !== 'PATH')
            continue;
        positional += 1;
        if (positional > 1)
            continue;
        const resolved = isAbsolute(classified.value)
            ? classified.value : join(rootIdentity, classified.value);
        if (!SCRIPT_EXTENSIONS.has(extname(resolved).toLowerCase()))
            continue;
        const material = await readRegularFile(resolved);
        if (material === null)
            return unreadable(classified.value);
        push(material.identity, material.sha256, 'REFERENCED_SCRIPT');
    }
    for (const name of TRUST_BUILD_CONFIG_FILES) {
        const material = await readRegularFile(join(rootIdentity, name));
        if (material !== null)
            push(material.identity, material.sha256, 'BUILD_CONFIG');
    }
    materials.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    const digest = sha256(canonicalizeJson({
        version: TRUST_BASIS_VERSION,
        materials: materials.map((material) => ({ path: material.path,
            rootRelativePath: material.rootRelativePath, sha256: material.sha256, role: material.role })),
    }));
    return { ok: true, basis: { version: TRUST_BASIS_VERSION, materials, digest } };
}
async function realpathOrNull(path) {
    try {
        return await realpath(path);
    }
    catch {
        return null;
    }
}
function unreadable(path) {
    return { ok: false, reason: CHECK_TRUST_REASON.MATERIAL_UNREADABLE,
        detail: `检查材料 ${path} 不存在、不是普通文件或无法读取。` };
}
const ROLES = ['EXECUTABLE', 'REFERENCED_SCRIPT', 'BUILD_CONFIG'];
/**
 * 从持久化 JSON 还原信任摘要。形状不合法就返回 undefined——调用方据此把这次检查当作
 * 缺信任依据处理，而不是猜一个「看起来一样」的摘要。
 */
export function parseCheckTrustBasis(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return undefined;
    const record = value;
    if (record.version !== TRUST_BASIS_VERSION)
        return undefined;
    if (typeof record.digest !== 'string' || !/^[0-9a-f]{64}$/.test(record.digest))
        return undefined;
    if (!Array.isArray(record.materials) || record.materials.length === 0)
        return undefined;
    const materials = [];
    for (const entry of record.materials) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
            return undefined;
        const material = entry;
        if (typeof material.path !== 'string' || material.path === '')
            return undefined;
        if (material.rootRelativePath !== null && typeof material.rootRelativePath !== 'string') {
            return undefined;
        }
        if (typeof material.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(material.sha256))
            return undefined;
        if (typeof material.role !== 'string' || !ROLES.includes(material.role)) {
            return undefined;
        }
        materials.push({ path: material.path, rootRelativePath: material.rootRelativePath,
            sha256: material.sha256, role: material.role });
    }
    return { version: TRUST_BASIS_VERSION, materials, digest: record.digest };
}
