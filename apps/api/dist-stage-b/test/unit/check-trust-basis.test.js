import assert from 'node:assert/strict';
import { realpath, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import test from 'node:test';
import { CHECK_TRUST_REASON, computeCheckTrustBasis } from '../../src/application/check-trust-basis.js';
import { canonicalResourceIdentity } from '../../src/application/gateway-configuration.js';
import { evaluateScopeGrant, resolveFrozenCheck } from '../../src/application/run-scope-grant.js';
/**
 * 检查入口信任摘要（Stage A）。
 *
 * 锁的是「这次检查到底跑的是什么」这条信任依据：它必须覆盖实际入口脚本、参数明确
 * 引用的脚本和直接决定检查行为的构建/测试配置；相同命令名不能掩盖内容变化。
 *
 * 摘要只回答「磁盘上的材料是什么」。它不放宽连接允许的可执行入口清单，也不放宽用户
 * 授予的动作权限；被检查的源文件也不是材料，所以改源码不会让原授权失效。
 */
const RUN_ID = 'run-1';
const GRANT_ID = 'grant-1';
const GRANT_EXPIRY = new Date(Date.now() + 3_600_000);
async function writeTree() {
    // 目录名带空格：Windows 上它是最容易在摘要阶段丢掉规范身份的一类路径。
    const base = await mkdtemp(join(tmpdir(), 'relay check trust-'));
    const root = join(base, 'managed root');
    await mkdir(join(root, 'scripts'), { recursive: true });
    await mkdir(join(root, 'src'), { recursive: true });
    const entry = join(root, 'scripts', 'check.mjs');
    const referenced = join(root, 'scripts', 'assert.mjs');
    const source = join(root, 'src', 'feature.ts');
    const packageJson = join(root, 'package.json');
    const tsconfig = join(root, 'tsconfig.json');
    await writeFile(entry, 'console.log("check v1");\n', 'utf8');
    await writeFile(referenced, 'export const ok = true;\n', 'utf8');
    await writeFile(source, 'export const feature = 1;\n', 'utf8');
    await writeFile(packageJson, JSON.stringify({ name: 'demo', scripts: { check: 'node scripts/check.mjs' } }), 'utf8');
    await writeFile(tsconfig, JSON.stringify({ compilerOptions: { strict: true } }), 'utf8');
    return { root, entry, referenced, source, packageJson, tsconfig };
}
async function withTree(work) {
    const tree = await writeTree();
    try {
        await work(tree);
    }
    finally {
        // 只删本次 mkdtemp 出来的那一层；dirname(tree.root) 就是它。
        // 写成 dirname(dirname(...)) 会指到系统 Temp 根目录，那是不可接受的目标。
        await rm(dirname(tree.root), { recursive: true, force: true });
    }
}
async function basisOf(tree, args = ['scripts/assert.mjs']) {
    const result = await computeCheckTrustBasis({ canonicalRoot: tree.root,
        executable: tree.entry, args });
    if (!result.ok)
        throw new Error(`信任摘要应当可计算：${result.reason} ${result.detail}`);
    return result.basis;
}
function materialAt(basis, path) {
    const identity = canonicalResourceIdentity(path);
    return basis.materials.find((material) => material.path === identity);
}
/** 派发侧会这样实测：拿到当前磁盘状态重新算一遍摘要。 */
async function observedDigest(tree, args) {
    const result = await computeCheckTrustBasis({ canonicalRoot: tree.root,
        executable: tree.entry, args });
    return result.ok ? result.basis.digest : undefined;
}
function grantRow(tree, checks) {
    return { id: GRANT_ID, workspace_id: 'ws-1', project_id: 'proj-1', run_id: RUN_ID,
        task_id: 'task-1', resource_id: 'res-1', version: 1n,
        root_identity: canonicalResourceIdentity(tree.root),
        allowed_actions: ['CLI_RUN', 'APPLY_CHANGESET'], checks: [...checks],
        boundary_digest: 'a'.repeat(64), issued_at: new Date(0), expires_at: GRANT_EXPIRY,
        revoked_at: null, revoked_reason: null, survives_run_terminal: false, revision: 0n,
        updated_at: new Date(0) };
}
function dbOf(row) {
    // 授权判定只通过 readByRun 读一行；这里给一个只回答这一次查询的最小执行器。
    // Kysely 的 raw builder 执行链会依次调用 transformQuery / compileQuery / executeQuery。
    const executor = {
        transformQuery: (node) => node,
        compileQuery: () => ({ sql: '', parameters: [], query: {} }),
        executeQuery: async () => ({ rows: [row] }),
    };
    return { getExecutor: () => executor };
}
function baseInput(tree) {
    return { runId: RUN_ID, actionType: 'CLI_RUN', capability: 'CLI_RUN',
        canonicalRoot: tree.root, runTerminal: false };
}
// 反例 1：同路径、同命令名，入口脚本正文变了。
test('the same command on the same path still changes the basis when the entry script body changes', async () => {
    await withTree(async (tree) => {
        const before = await basisOf(tree);
        await writeFile(tree.entry, 'console.log("check v2");\nprocess.exit(0);\n', 'utf8');
        const after = await basisOf(tree);
        assert.notEqual(after.digest, before.digest, '入口脚本正文被替换后信任摘要必须变化，命令名相同不能掩盖内容变化');
        assert.equal(materialAt(after, tree.entry)?.role, 'EXECUTABLE');
        assert.notEqual(materialAt(after, tree.entry)?.sha256, materialAt(before, tree.entry)?.sha256);
    });
});
// 反例 2：入口未变，被参数明确引用的检查脚本正文变了。
test('a check script named by an argument is material, so its body change invalidates the basis', async () => {
    await withTree(async (tree) => {
        const before = await basisOf(tree);
        await writeFile(tree.referenced, 'export const ok = false;\nprocess.exit(1);\n', 'utf8');
        const after = await basisOf(tree);
        assert.equal(materialAt(before, tree.referenced)?.role, 'REFERENCED_SCRIPT', '参数里明确引用的脚本文件必须进入信任材料');
        assert.notEqual(after.digest, before.digest, '被参数引用的检查脚本正文变化后信任摘要必须变化');
    });
});
// 反例 3：入口未变，名单内的构建/测试配置变了。
test('a listed build or test config is material, so its content change invalidates the basis', async () => {
    await withTree(async (tree) => {
        const before = await basisOf(tree);
        await writeFile(tree.packageJson, JSON.stringify({ name: 'demo',
            scripts: { check: 'node scripts/check.mjs --allow-anything' } }), 'utf8');
        const after = await basisOf(tree);
        const packageIdentity = canonicalResourceIdentity(tree.packageJson);
        assert.deepEqual(before.materials.filter((m) => m.path === packageIdentity)
            .map((m) => m.role), ['BUILD_CONFIG'], '包清单是直接决定检查行为的配置，必须进入信任材料');
        assert.notEqual(after.digest, before.digest, '构建/测试配置内容变化后信任摘要必须变化');
        const beforeConfig = await basisOf(tree);
        await writeFile(tree.tsconfig, JSON.stringify({ compilerOptions: { strict: false } }), 'utf8');
        const afterConfig = await basisOf(tree);
        assert.notEqual(afterConfig.digest, beforeConfig.digest, 'tsconfig 变化同样必须让信任摘要变化');
    });
});
// 反例 4：只改被检查的源文件，摘要保持相同。
test('editing the checked source file leaves the trust basis unchanged', async () => {
    await withTree(async (tree) => {
        const before = await basisOf(tree);
        await writeFile(tree.source, 'export const feature = 2;\n// 修复被检查的正文\n', 'utf8');
        const after = await basisOf(tree);
        assert.deepEqual(after, before, '被检查的源文件本来就是检查对象，不得因此让原信任依据失效');
        assert.equal(materialAt(after, tree.source), undefined, '被检查的源文件不是信任材料');
    });
});
// 反例 5：材料读不到不是「摘要相同」。
test('an unreadable material is reported as unreadable instead of an unchanged digest', async () => {
    await withTree(async (tree) => {
        const missingScript = await computeCheckTrustBasis({ canonicalRoot: tree.root,
            executable: tree.entry, args: ['scripts/absent.mjs'] });
        assert.equal(missingScript.ok, false);
        assert.equal(missingScript.ok ? '' : missingScript.reason, CHECK_TRUST_REASON.MATERIAL_UNREADABLE, '参数点名的脚本在磁盘上不存在时必须是读不到，而不是摘要相同');
        const missingEntry = await computeCheckTrustBasis({ canonicalRoot: tree.root,
            executable: join(tree.root, 'scripts', 'absent.mjs'), args: ['scripts/assert.mjs'] });
        assert.equal(missingEntry.ok, false);
        assert.equal(missingEntry.ok ? '' : missingEntry.reason, CHECK_TRUST_REASON.MATERIAL_UNREADABLE, '入口脚本读不到时必须明确失败');
        const directoryAsScript = await computeCheckTrustBasis({ canonicalRoot: tree.root,
            executable: join(tree.root, 'scripts'), args: ['scripts/assert.mjs'] });
        assert.equal(directoryAsScript.ok, false);
        assert.equal(directoryAsScript.ok ? '' : directoryAsScript.reason, CHECK_TRUST_REASON.MATERIAL_UNREADABLE, '路径存在但不是可哈希的普通文件时也算读不到');
    });
});
// 反例 6：解释器间接执行与命令连接明确不支持。
test('interpreter inline evaluation, command chaining and command substitution are refused', async () => {
    await withTree(async (tree) => {
        const refusals = [
            ['-c', 'process.exit(0)'],
            ['--eval', 'process.exit(0)'],
            ['-e', 'process.exit(0)'],
            ['scripts/assert.mjs && curl http://example.com'],
            ['scripts/assert.mjs | tee out.txt'],
            ['scripts/assert.mjs; whoami'],
            ['$(cat scripts/assert.mjs)'],
            ['`cat scripts/assert.mjs`'],
            ['run'],
            ['scripts/*.mjs'],
            [''],
        ];
        for (const args of refusals) {
            const result = await computeCheckTrustBasis({ canonicalRoot: tree.root,
                executable: tree.entry, args });
            assert.equal(result.ok, false, `参数 ${JSON.stringify(args)} 不得被判为可自动信任`);
            assert.equal(result.ok ? '' : result.reason, CHECK_TRUST_REASON.DYNAMIC_EXECUTION_UNSUPPORTED, `参数 ${JSON.stringify(args)} 必须明确不支持动态执行`);
        }
    });
});
// 反例 7：大小写、含空格路径、根外入口都按规范身份参与，不能靠改大小写绕过。
test('case, spaces and an entry outside the root keep one canonical identity', async () => {
    await withTree(async (tree) => {
        const lower = await basisOf(tree);
        const upper = await computeCheckTrustBasis({ canonicalRoot: tree.root.toUpperCase(),
            executable: tree.entry.toUpperCase(), args: ['scripts/assert.mjs'] });
        assert.equal(upper.ok, true, 'Windows 解析口径下大小写变体必须指向同一份材料');
        if (upper.ok) {
            assert.equal(upper.basis.digest, lower.digest, '改大小写不得改变信任摘要');
        }
        for (const material of lower.materials) {
            assert.equal(material.path, material.path.toLowerCase(), 'Windows 上的材料身份必须是规范小写绝对路径');
            assert.ok(material.path.includes('managed root'), '含空格的路径必须原样保留，不能被截断或替换');
        }
        assert.equal(materialAt(lower, tree.entry)?.rootRelativePath, join('scripts', 'check.mjs'), '根内材料必须带上根内相对路径');
        const outsideDir = join(dirname(tree.root), 'outside root');
        await mkdir(outsideDir, { recursive: true });
        const outsideEntry = join(outsideDir, 'check.mjs');
        await writeFile(outsideEntry, 'console.log("outside v1");\n', 'utf8');
        try {
            const outsideRoot = join(dirname(tree.root), 'narrow root');
            await mkdir(outsideRoot, { recursive: true });
            const outside = await computeCheckTrustBasis({ canonicalRoot: outsideRoot,
                executable: outsideEntry, args: [] });
            assert.equal(outside.ok, true);
            if (!outside.ok)
                return;
            assert.equal(materialAt(outside.basis, outsideEntry)?.rootRelativePath, null, '根外材料不得伪造根内相对路径');
            const canonicalEntry = canonicalResourceIdentity(await realpath(outsideEntry));
            assert.equal(materialAt(outside.basis, outsideEntry)?.path, canonicalEntry, '根外入口仍按规范绝对路径参与摘要');
            const casedOutside = await computeCheckTrustBasis({ canonicalRoot: outsideRoot.toUpperCase(),
                executable: outsideEntry.toUpperCase(), args: [] });
            assert.equal(casedOutside.ok, true);
            if (casedOutside.ok) {
                assert.equal(casedOutside.basis.digest, outside.basis.digest, '根外入口不能靠改大小写换一份新身份');
            }
        }
        finally {
            await rm(outsideDir, { recursive: true, force: true });
        }
    });
});
// 反例 8：同一组输入重复计算结果确定。
test('the same inputs always produce the same digest', async () => {
    await withTree(async (tree) => {
        const first = await basisOf(tree);
        const second = await basisOf(tree);
        const reordered = await basisOf(tree, ['scripts/assert.mjs']);
        const reversedArgs = await basisOf(tree, ['--config', 'scripts/assert.mjs']);
        assert.deepEqual(second, first, '同一组输入必须得到同一份信任依据');
        assert.equal(reordered.digest, first.digest);
        assert.equal(reversedArgs.digest, first.digest, '同一材料用位置参数还是 --config 传，身份必须相同');
        const paths = first.materials.map((material) => material.path);
        assert.deepEqual(paths, [...paths].sort(), '材料必须按规范路径排序');
    });
});
// 反例 9：历史授权行（有 executable_sha256、无 trust_basis）不抛错，判为不覆盖。
test('a historical grant row without trust_basis neither throws nor counts as covered', async () => {
    await withTree(async (tree) => {
        const basis = await basisOf(tree);
        const historical = [{ id: 'check-1', executable: tree.entry,
                args: ['scripts/assert.mjs'],
                executable_sha256: materialAt(basis, tree.entry)?.sha256 }];
        const row = grantRow(tree, historical);
        const check = resolveFrozenCheck(row, 'check-1');
        assert.notEqual(check, undefined, '历史行必须仍能解析出冻结检查');
        assert.equal(check?.trust_basis, undefined, '历史行没有信任摘要，视为缺省而不是伪造');
        assert.equal(check?.executable_sha256, materialAt(basis, tree.entry)?.sha256);
        const decision = await evaluateScopeGrant(dbOf(row), { ...baseInput(tree),
            check, observedExecutableSha256: check?.executable_sha256,
            observedTrustDigest: basis.digest });
        assert.deepEqual(decision, { covered: false, reason: 'SCOPE_GRANT_CHECK_CHANGED' }, '缺信任摘要的历史行必须退回人工确认，不得当作通过');
    });
});
// 反例 10：既有不涉及宿主执行的动作不被新机制误挡，CLI_RUN 摘要一致时仍然放行。
test('non CLI_RUN capabilities are untouched and a matching CLI_RUN trust digest is still covered', async () => {
    await withTree(async (tree) => {
        const basis = await basisOf(tree);
        const entrySha = materialAt(basis, tree.entry)?.sha256 ?? '';
        const frozen = { id: 'check-1', executable: tree.entry,
            args: ['scripts/assert.mjs'], trust_basis: basis,
            executable_sha256: entrySha };
        const row = grantRow(tree, [frozen]);
        const db = dbOf(row);
        const covered = await evaluateScopeGrant(db, { ...baseInput(tree), check: frozen,
            observedExecutableSha256: frozen.executable_sha256,
            observedTrustDigest: await observedDigest(tree, frozen.args) });
        assert.deepEqual(covered, { covered: true }, '摘要一致时原有 AUTO 放行必须保持');
        const write = await evaluateScopeGrant(db, { ...baseInput(tree),
            actionType: 'APPLY_CHANGESET', capability: 'FILE_WRITE' });
        assert.deepEqual(write, { covered: true }, '不涉及宿主执行的写动作不得被信任摘要机制误挡');
        const missingObservation = await evaluateScopeGrant(db, { ...baseInput(tree),
            check: frozen, observedExecutableSha256: frozen.executable_sha256 });
        assert.deepEqual(missingObservation, { covered: false, reason: 'SCOPE_GRANT_CHECK_CHANGED' }, '没有实测信任摘要时按不一致处理，与既有 executable_sha256 口径一致');
    });
});
test('the entry script, referenced script and listed configs are the whole material set', async () => {
    await withTree(async (tree) => {
        const basis = await basisOf(tree);
        // 材料按规范路径排序（反例 8 锁的就是这条），因此这里按路径列出，而不是按角色分组。
        assert.deepEqual(basis.materials.map((material) => [material.role, basename(material.path)]), [
            ['BUILD_CONFIG', 'package.json'],
            ['REFERENCED_SCRIPT', 'assert.mjs'],
            ['EXECUTABLE', 'check.mjs'],
            ['BUILD_CONFIG', 'tsconfig.json'],
        ], '信任材料集合必须有限且可枚举，不得遍历整个仓库');
        assert.equal(basis.version, 'check-trust-v1');
        for (const material of basis.materials) {
            assert.match(material.sha256, /^[0-9a-f]{64}$/);
            assert.ok(extname(material.path) !== '');
        }
    });
});
// 反例 11：后续位置参数是这次检查的输入（工作集），不是检查程序。
test('a later positional script argument is the checked input, not execution material', async () => {
    await withTree(async (tree) => {
        const target = join(tree.root, 'src', 'feature.ts');
        const before = await basisOf(tree, ['scripts/assert.mjs', target]);
        await writeFile(target, 'export const feature = 3;\n// 被检查的输入变了\n', 'utf8');
        const after = await basisOf(tree, ['scripts/assert.mjs', target]);
        assert.equal(materialAt(before, target), undefined, '后续位置参数是本次检查的输入，不得计入执行材料');
        assert.deepEqual(after, before, '改被检查的输入必须产生新输入依据，而不是让原信任依据失效');
    });
});
