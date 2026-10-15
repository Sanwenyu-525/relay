import assert from 'node:assert/strict';
import { realpath, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import test from 'node:test';

import { CHECK_TRUST_REASON, computeCheckTrustBasis,
  type CheckTrustBasis } from '../../src/application/check-trust-basis.js';
import { canonicalResourceIdentity } from '../../src/application/gateway-configuration.js';
import { evaluateScopeGrant, resolveFrozenCheck,
  type FrozenCheck } from '../../src/application/run-scope-grant.js';
import type { DbExecutor } from '../../src/infrastructure/database.js';
import type { RunScopeGrantRow } from '../../src/infrastructure/database-schema.js';
import type { JsonObject } from '../../src/infrastructure/json.js';

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

interface Tree {
  readonly root: string;
  readonly entry: string;
  readonly referenced: string;
  readonly source: string;
  readonly packageJson: string;
  readonly tsconfig: string;
}

async function writeTree(): Promise<Tree> {
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

async function withTree(work: (tree: Tree) => Promise<void>): Promise<void> {
  const tree = await writeTree();
  try {
    await work(tree);
  } finally {
    // 只删本次 mkdtemp 出来的那一层；dirname(tree.root) 就是它。
    // 写成 dirname(dirname(...)) 会指到系统 Temp 根目录，那是不可接受的目标。
    await rm(dirname(tree.root), { recursive: true, force: true });
  }
}

async function basisOf(tree: Tree, args: readonly string[] = ['scripts/assert.mjs']):
Promise<CheckTrustBasis> {
  const result = await computeCheckTrustBasis({ canonicalRoot: tree.root,
    executable: tree.entry, args });
  if (!result.ok) throw new Error(`信任摘要应当可计算：${result.reason} ${result.detail}`);
  return result.basis;
}

function materialAt(basis: CheckTrustBasis, path: string) {
  const identity = canonicalResourceIdentity(path);
  return basis.materials.find((material) => material.path === identity);
}

/** 以当前 node 可执行程序为入口计算摘要：`node <script>` / `node -- <entry>` 这类真实检查形态。 */
async function nodeBasisOf(tree: Tree, args: readonly string[]): Promise<CheckTrustBasis> {
  const result = await computeCheckTrustBasis({ canonicalRoot: tree.root,
    executable: process.execPath, args });
  if (!result.ok) throw new Error(`信任摘要应当可计算：${result.reason} ${result.detail}`);
  return result.basis;
}

/** 派发侧会这样实测：拿到当前磁盘状态重新算一遍摘要。 */
async function observedDigest(tree: Tree, args: readonly string[]): Promise<string | undefined> {
  const result = await computeCheckTrustBasis({ canonicalRoot: tree.root,
    executable: tree.entry, args });
  return result.ok ? result.basis.digest : undefined;
}

function grantRow(tree: Tree, checks: readonly JsonObject[]): RunScopeGrantRow {
  return { id: GRANT_ID, workspace_id: 'ws-1', project_id: 'proj-1', run_id: RUN_ID,
    task_id: 'task-1', resource_id: 'res-1', version: 1n,
    root_identity: canonicalResourceIdentity(tree.root),
    allowed_actions: ['CLI_RUN', 'APPLY_CHANGESET'], checks: [...checks],
    boundary_digest: 'a'.repeat(64), issued_at: new Date(0), expires_at: GRANT_EXPIRY,
    revoked_at: null, revoked_reason: null, survives_run_terminal: false, revision: 0n,
    updated_at: new Date(0) };
}

function dbOf(row: RunScopeGrantRow): DbExecutor {
  // 授权判定只通过 readByRun 读一行；这里给一个只回答这一次查询的最小执行器。
  // Kysely 的 raw builder 执行链会依次调用 transformQuery / compileQuery / executeQuery。
  const executor = {
    transformQuery: (node: unknown) => node,
    compileQuery: () => ({ sql: '', parameters: [], query: {} }),
    executeQuery: async () => ({ rows: [row] }),
  };
  return { getExecutor: () => executor } as unknown as DbExecutor;
}

function baseInput(tree: Tree) {
  return { runId: RUN_ID, actionType: 'CLI_RUN', capability: 'CLI_RUN' as const,
    canonicalRoot: tree.root, runTerminal: false };
}

// 反例 1：同路径、同命令名，入口脚本正文变了。
test('the same command on the same path still changes the basis when the entry script body changes', async () => {
  await withTree(async (tree) => {
    const before = await basisOf(tree);
    await writeFile(tree.entry, 'console.log("check v2");\nprocess.exit(0);\n', 'utf8');
    const after = await basisOf(tree);

    assert.notEqual(after.digest, before.digest,
      '入口脚本正文被替换后信任摘要必须变化，命令名相同不能掩盖内容变化');
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

    assert.equal(materialAt(before, tree.referenced)?.role, 'REFERENCED_SCRIPT',
      '参数里明确引用的脚本文件必须进入信任材料');
    assert.notEqual(after.digest, before.digest,
      '被参数引用的检查脚本正文变化后信任摘要必须变化');
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
      .map((m) => m.role), ['BUILD_CONFIG'],
    '包清单是直接决定检查行为的配置，必须进入信任材料');
    assert.notEqual(after.digest, before.digest,
      '构建/测试配置内容变化后信任摘要必须变化');

    const beforeConfig = await basisOf(tree);
    await writeFile(tree.tsconfig, JSON.stringify({ compilerOptions: { strict: false } }), 'utf8');
    const afterConfig = await basisOf(tree);
    assert.notEqual(afterConfig.digest, beforeConfig.digest,
      'tsconfig 变化同样必须让信任摘要变化');
  });
});

// 反例 4：只改被检查的源文件，摘要保持相同。
test('editing the checked source file leaves the trust basis unchanged', async () => {
  await withTree(async (tree) => {
    const before = await basisOf(tree);
    await writeFile(tree.source, 'export const feature = 2;\n// 修复被检查的正文\n', 'utf8');
    const after = await basisOf(tree);

    assert.deepEqual(after, before,
      '被检查的源文件本来就是检查对象，不得因此让原信任依据失效');
    assert.equal(materialAt(after, tree.source), undefined,
      '被检查的源文件不是信任材料');
  });
});

// 反例 5：材料读不到不是「摘要相同」。
test('an unreadable material is reported as unreadable instead of an unchanged digest', async () => {
  await withTree(async (tree) => {
    const missingScript = await computeCheckTrustBasis({ canonicalRoot: tree.root,
      executable: tree.entry, args: ['scripts/absent.mjs'] });
    assert.equal(missingScript.ok, false);
    assert.equal(missingScript.ok ? '' : missingScript.reason,
      CHECK_TRUST_REASON.MATERIAL_UNREADABLE,
    '参数点名的脚本在磁盘上不存在时必须是读不到，而不是摘要相同');

    const missingEntry = await computeCheckTrustBasis({ canonicalRoot: tree.root,
      executable: join(tree.root, 'scripts', 'absent.mjs'), args: ['scripts/assert.mjs'] });
    assert.equal(missingEntry.ok, false);
    assert.equal(missingEntry.ok ? '' : missingEntry.reason,
      CHECK_TRUST_REASON.MATERIAL_UNREADABLE, '入口脚本读不到时必须明确失败');

    const directoryAsScript = await computeCheckTrustBasis({ canonicalRoot: tree.root,
      executable: join(tree.root, 'scripts'), args: ['scripts/assert.mjs'] });
    assert.equal(directoryAsScript.ok, false);
    assert.equal(directoryAsScript.ok ? '' : directoryAsScript.reason,
      CHECK_TRUST_REASON.MATERIAL_UNREADABLE, '路径存在但不是可哈希的普通文件时也算读不到');
  });
});

// 反例 6：解释器间接执行与命令连接明确不支持。
test('interpreter inline evaluation, command chaining and command substitution are refused', async () => {
  await withTree(async (tree) => {
    const refusals: readonly string[][] = [
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
      assert.equal(result.ok ? '' : result.reason,
        CHECK_TRUST_REASON.DYNAMIC_EXECUTION_UNSUPPORTED,
      `参数 ${JSON.stringify(args)} 必须明确不支持动态执行`);
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
      assert.equal(material.path, material.path.toLowerCase(),
      'Windows 上的材料身份必须是规范小写绝对路径');
      assert.ok(material.path.includes('managed root'),
        '含空格的路径必须原样保留，不能被截断或替换');
    }
    assert.equal(materialAt(lower, tree.entry)?.rootRelativePath, join('scripts', 'check.mjs'),
      '根内材料必须带上根内相对路径');

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
      if (!outside.ok) return;
      assert.equal(materialAt(outside.basis, outsideEntry)?.rootRelativePath, null,
        '根外材料不得伪造根内相对路径');
      const canonicalEntry = canonicalResourceIdentity(await realpath(outsideEntry));
      assert.equal(materialAt(outside.basis, outsideEntry)?.path, canonicalEntry,
        '根外入口仍按规范绝对路径参与摘要');
      const casedOutside = await computeCheckTrustBasis({ canonicalRoot: outsideRoot.toUpperCase(),
        executable: outsideEntry.toUpperCase(), args: [] });
      assert.equal(casedOutside.ok, true);
      if (casedOutside.ok) {
        assert.equal(casedOutside.basis.digest, outside.basis.digest,
          '根外入口不能靠改大小写换一份新身份');
      }
    } finally {
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
    assert.equal(reversedArgs.digest, first.digest,
      '同一材料用位置参数还是 --config 传，身份必须相同');
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
      executable_sha256: materialAt(basis, tree.entry)?.sha256 }] as readonly JsonObject[];
    const row = grantRow(tree, historical);

    const check = resolveFrozenCheck(row, 'check-1');
    assert.notEqual(check, undefined, '历史行必须仍能解析出冻结检查');
    assert.equal(check?.trust_basis, undefined, '历史行没有信任摘要，视为缺省而不是伪造');
    assert.equal(check?.executable_sha256, materialAt(basis, tree.entry)?.sha256);

    const decision = await evaluateScopeGrant(dbOf(row), { ...baseInput(tree),
      check, observedExecutableSha256: check?.executable_sha256,
      observedTrustDigest: basis.digest });
    assert.deepEqual(decision, { covered: false, reason: 'SCOPE_GRANT_CHECK_CHANGED' },
      '缺信任摘要的历史行必须退回人工确认，不得当作通过');
  });
});

// 反例 10：既有不涉及宿主执行的动作不被新机制误挡，CLI_RUN 摘要一致时仍然放行。
test('non CLI_RUN capabilities are untouched and a matching CLI_RUN trust digest is still covered', async () => {
  await withTree(async (tree) => {
    const basis = await basisOf(tree);
    const entrySha = materialAt(basis, tree.entry)?.sha256 ?? '';
    const frozen: FrozenCheck = { id: 'check-1', executable: tree.entry,
      args: ['scripts/assert.mjs'], trust_basis: basis,
      executable_sha256: entrySha };
    const row = grantRow(tree, [frozen as unknown as JsonObject]);
    const db = dbOf(row);

    const covered = await evaluateScopeGrant(db, { ...baseInput(tree), check: frozen,
      observedExecutableSha256: frozen.executable_sha256,
      observedTrustDigest: await observedDigest(tree, frozen.args) });
    assert.deepEqual(covered, { covered: true }, '摘要一致时原有 AUTO 放行必须保持');

    const write = await evaluateScopeGrant(db, { ...baseInput(tree),
      actionType: 'APPLY_CHANGESET', capability: 'FILE_WRITE' });
    assert.deepEqual(write, { covered: true },
      '不涉及宿主执行的写动作不得被信任摘要机制误挡');

    const missingObservation = await evaluateScopeGrant(db, { ...baseInput(tree),
      check: frozen, observedExecutableSha256: frozen.executable_sha256 });
    assert.deepEqual(missingObservation,
      { covered: false, reason: 'SCOPE_GRANT_CHECK_CHANGED' },
    '没有实测信任摘要时按不一致处理，与既有 executable_sha256 口径一致');
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

    assert.equal(materialAt(before, target), undefined,
      '后续位置参数是本次检查的输入，不得计入执行材料');
    assert.deepEqual(after, before,
      '改被检查的输入必须产生新输入依据，而不是让原信任依据失效');
  });
});

// BE-01：node --test 多显式入口全部进材料，第二个变化失效。
test('node --test includes every explicit entry, so changing the second entry invalidates the basis', async () => {
  await withTree(async (tree) => {
    const first = join(tree.root, 'a.test.mjs');
    const second = join(tree.root, 'b.test.mjs');
    await writeFile(first, 'console.log("a v1");\n', 'utf8');
    await writeFile(second, 'console.log("b v1");\n', 'utf8');
    const args = ['--test', 'a.test.mjs', 'b.test.mjs'];
    const beforeResult = await computeCheckTrustBasis({ canonicalRoot: tree.root,
      executable: process.execPath, args });
    assert.equal(beforeResult.ok, true, '多显式测试入口必须可计算信任摘要');
    if (!beforeResult.ok) return;
    assert.notEqual(materialAt(beforeResult.basis, first), undefined,
      '第一个测试入口必须进材料');
    assert.notEqual(materialAt(beforeResult.basis, second), undefined,
      '第二个测试入口必须进材料（BE-01：只取第一个会漏算）');

    await writeFile(second, 'console.log("b v2");\n', 'utf8');
    const afterResult = await computeCheckTrustBasis({ canonicalRoot: tree.root,
      executable: process.execPath, args });
    assert.equal(afterResult.ok, true);
    if (!afterResult.ok) return;
    assert.notEqual(afterResult.basis.digest, beforeResult.basis.digest,
      '第二个测试入口正文变化后摘要必须变化，否则旧授权会沿用新代码');

    await writeFile(first, 'console.log("a v2");\n', 'utf8');
    const third = await computeCheckTrustBasis({ canonicalRoot: tree.root,
      executable: process.execPath, args });
    assert.equal(third.ok, true);
    if (!third.ok) return;
    assert.notEqual(third.basis.digest, afterResult.basis.digest,
      '第一个测试入口变化同样必须让摘要变化');
  });
});

// BE-01：删除 / 目录展开不是摘要相同，而是类型化拒绝。
test('a deleted or directory test entry is a typed rejection, not an unchanged digest', async () => {
  await withTree(async (tree) => {
    const first = join(tree.root, 'a.test.mjs');
    const second = join(tree.root, 'b.test.mjs');
    await writeFile(first, 'console.log("a v1");\n', 'utf8');
    await writeFile(second, 'console.log("b v1");\n', 'utf8');
    const args = ['--test', 'a.test.mjs', 'b.test.mjs'];

    await rm(second, { force: true });
    const missing = await computeCheckTrustBasis({ canonicalRoot: tree.root,
      executable: process.execPath, args });
    assert.equal(missing.ok, false);
    assert.equal(missing.ok ? '' : missing.reason,
      CHECK_TRUST_REASON.MATERIAL_UNREADABLE, '第二个入口被删除后必须是读不到');

    await writeFile(second, 'console.log("b v1");\n', 'utf8');
    await mkdir(join(tree.root, 'tests'), { recursive: true });
    const directory = await computeCheckTrustBasis({ canonicalRoot: tree.root,
      executable: process.execPath, args: ['--test', 'a.test.mjs', join(tree.root, 'tests')] });
    assert.equal(directory.ok, false);
    assert.equal(directory.ok ? '' : directory.reason,
      CHECK_TRUST_REASON.MATERIAL_UNREADABLE, '目录展开无法枚举确切文件，不得静默放行');
  });
});

// BE-01：默认发现与 --test 带值无法枚举，一律明确拒绝。
test('node --test without explicit entries is refused instead of a stable digest', async () => {
  await withTree(async (tree) => {
    for (const args of [['--test'], ['--test=foo']] as const) {
      const result = await computeCheckTrustBasis({ canonicalRoot: tree.root,
        executable: process.execPath, args: [...args] });
      assert.equal(result.ok, false, `参数 ${JSON.stringify(args)} 无法枚举执行范围`);
      assert.equal(result.ok ? '' : result.reason,
        CHECK_TRUST_REASON.DYNAMIC_EXECUTION_UNSUPPORTED,
      `参数 ${JSON.stringify(args)} 必须明确不支持动态执行`);
    }
  });
});

// BE-02：--import= 挤占主脚本位置的旧缺口必须判为动态不支持；主脚本仍是材料。
test('an equals-form dynamic preload does not squeeze out the main script, it is refused', async () => {
  await withTree(async (tree) => {
    const preload = join(tree.root, 'preload.mjs');
    const main = join(tree.root, 'check.mjs');
    await writeFile(preload, 'console.log("preload v1");\n', 'utf8');
    await writeFile(main, 'console.log("check v1");\n', 'utf8');

    const squeezed = await computeCheckTrustBasis({ canonicalRoot: tree.root,
      executable: process.execPath, args: ['--import=./preload.mjs', 'check.mjs'] });
    assert.equal(squeezed.ok, false, '--import= 的值不得占主脚本位置（BE-02）');
    assert.equal(squeezed.ok ? '' : squeezed.reason,
      CHECK_TRUST_REASON.DYNAMIC_EXECUTION_UNSUPPORTED);

    const clean = await computeCheckTrustBasis({ canonicalRoot: tree.root,
      executable: process.execPath, args: ['check.mjs'] });
    assert.equal(clean.ok, true);
    if (!clean.ok) return;
    assert.notEqual(materialAt(clean.basis, main), undefined, '主脚本必须进材料');
    assert.equal(materialAt(clean.basis, preload), undefined, '未引用的 preload 不得进材料');

    await writeFile(main, 'console.log("check v2");\n', 'utf8');
    const changed = await computeCheckTrustBasis({ canonicalRoot: tree.root,
      executable: process.execPath, args: ['check.mjs'] });
    assert.equal(changed.ok, true);
    if (!changed.ok) return;
    assert.notEqual(changed.basis.digest, clean.basis.digest, '主脚本变化必须让摘要变化');
  });
});

// BE-02：分离形式与等号形式同一规则；--require / 短参数 / 紧凑写法全覆盖。
test('separated dynamic preload flags are refused the same as their equals forms', async () => {
  await withTree(async (tree) => {
    const preload = join(tree.root, 'preload.mjs');
    const main = join(tree.root, 'check.mjs');
    await writeFile(preload, 'console.log("preload v1");\n', 'utf8');
    await writeFile(main, 'console.log("check v1");\n', 'utf8');
    const cases: readonly string[][] = [
      ['--import', './preload.mjs', 'check.mjs'],
      ['--require', './preload.mjs', 'check.mjs'],
      ['--require=./preload.mjs', 'check.mjs'],
      ['-r', './preload.mjs', 'check.mjs'],
      ['-r./preload.mjs', 'check.mjs'],
      ['--loader=./preload.mjs', 'check.mjs'],
      ['--loader', './preload.mjs', 'check.mjs'],
      ['--experimental-loader=./preload.mjs', 'check.mjs'],
    ];
    for (const args of cases) {
      const result = await computeCheckTrustBasis({ canonicalRoot: tree.root,
        executable: process.execPath, args });
      assert.equal(result.ok, false, `参数 ${JSON.stringify(args)} 必须与等号形式一致拒绝`);
      assert.equal(result.ok ? '' : result.reason,
        CHECK_TRUST_REASON.DYNAMIC_EXECUTION_UNSUPPORTED,
      `参数 ${JSON.stringify(args)} 必须明确不支持动态执行`);
    }
  });
});

// 紧凑内联求值、stdin 与测试模式稳定性。
test('attached short inline evaluation, stdin and test-mode stability are handled', async () => {
  await withTree(async (tree) => {
    const first = join(tree.root, 'a.test.mjs');
    const second = join(tree.root, 'b.test.mjs');
    await writeFile(first, 'console.log("a v1");\n', 'utf8');
    await writeFile(second, 'console.log("b v1");\n', 'utf8');
    for (const args of [['-econsole.log(1)'], ['-pconsole.log(1)'], ['-'],
      ['--eval=process.exit(0)'], ['--input-type=module']] as const) {
      const result = await computeCheckTrustBasis({ canonicalRoot: tree.root,
        executable: process.execPath, args: [...args] });
      assert.equal(result.ok, false, `参数 ${JSON.stringify(args)} 不得被判为可自动信任`);
      assert.equal(result.ok ? '' : result.reason,
        CHECK_TRUST_REASON.DYNAMIC_EXECUTION_UNSUPPORTED);
    }

    const args = ['--test', 'a.test.mjs', 'b.test.mjs'];
    const firstRun = await computeCheckTrustBasis({ canonicalRoot: tree.root,
      executable: process.execPath, args });
    const secondRun = await computeCheckTrustBasis({ canonicalRoot: tree.root,
      executable: process.execPath, args });
    assert.equal(firstRun.ok, true);
    assert.equal(secondRun.ok, true);
    if (!firstRun.ok || !secondRun.ok) return;
    assert.deepEqual(secondRun.basis, firstRun.basis, '材料不变时测试模式摘要必须稳定');
  });
});

// BE-02（一般形态）：等号形式的非动态开关值属于开关本身，不占主脚本位置。
// 主脚本必须进材料，改主脚本必须让摘要变化，否则旧授权会沿用新代码继续 AUTO。
test('an equals-form flag value never occupies the main script position', async () => {
  await withTree(async (tree) => {
    const envFile = join(tree.root, '.env');
    const configFile = join(tree.root, 'cfg.json');
    const main = join(tree.root, 'check.mjs');
    await writeFile(envFile, 'RELAY_TRUST_ENV=1\n', 'utf8');
    await writeFile(configFile, '{"check":"v1"}\n', 'utf8');
    await writeFile(main, 'console.log("main v1");\n', 'utf8');

    const withEnv = await computeCheckTrustBasis({ canonicalRoot: tree.root,
      executable: process.execPath, args: ['--env-file=.env', 'check.mjs'] });
    assert.equal(withEnv.ok, true, '等号开关值 + 主脚本是受支持的有限形态');
    if (!withEnv.ok) return;
    assert.notEqual(materialAt(withEnv.basis, main), undefined,
      '等号开关值不得挤掉主脚本：主脚本必须进材料（BE-02 一般形态）');
    assert.notEqual(materialAt(withEnv.basis, envFile), undefined,
      '等号开关引用的文件也是本次执行的材料');

    await writeFile(main, 'console.log("main v2");\n', 'utf8');
    const mainChanged = await computeCheckTrustBasis({ canonicalRoot: tree.root,
      executable: process.execPath, args: ['--env-file=.env', 'check.mjs'] });
    assert.equal(mainChanged.ok, true);
    if (!mainChanged.ok) return;
    assert.notEqual(mainChanged.basis.digest, withEnv.basis.digest,
      '修改被执行的主脚本后摘要必须变化，不得沿用旧授权 AUTO');

    await writeFile(main, 'console.log("main v1");\n', 'utf8');
    await writeFile(envFile, 'RELAY_TRUST_ENV=2\n', 'utf8');
    const envChanged = await computeCheckTrustBasis({ canonicalRoot: tree.root,
      executable: process.execPath, args: ['--env-file=.env', 'check.mjs'] });
    assert.equal(envChanged.ok, true);
    if (!envChanged.ok) return;
    assert.notEqual(envChanged.basis.digest, withEnv.basis.digest,
      '等号开关引用的文件变化同样必须让摘要变化');

    await writeFile(envFile, 'RELAY_TRUST_ENV=1\n', 'utf8');
    const combined = await computeCheckTrustBasis({ canonicalRoot: tree.root,
      executable: process.execPath,
      args: ['--env-file=.env', '--config=cfg.json', 'check.mjs'] });
    assert.equal(combined.ok, true, '多个等号开关值 + 主脚本是受支持的有限形态');
    if (!combined.ok) return;
    assert.notEqual(materialAt(combined.basis, main), undefined,
      '多个等号开关值同样不得挤掉主脚本');
    assert.notEqual(materialAt(combined.basis, configFile), undefined,
      '组合形态下每个等号开关引用的文件都进材料');

    // 边界保护：主脚本之后的位置参数仍是检查输入，不得计入执行材料，
    // 「检查失败 → 修正 → 再检查」链条不因本次修复收紧。
    const checkedInput = join(tree.root, 'src', 'feature.ts');
    const withInput = await computeCheckTrustBasis({ canonicalRoot: tree.root,
      executable: process.execPath, args: ['--env-file=.env', 'check.mjs', checkedInput] });
    assert.equal(withInput.ok, true);
    if (!withInput.ok) return;
    assert.equal(materialAt(withInput.basis, checkedInput), undefined,
      '主脚本之后的位置参数仍是检查输入，不得计入执行材料');
  });
});

// 分离式开关值与主脚本无法区分：同一开关之后还有两个以上文件参数时，
// 任何一个候选都可能是真正被执行的脚本，有限模型无法证明 → 明确拒绝，不猜。
test('a separated flag followed by two or more file arguments is refused instead of guessing', async () => {
  await withTree(async (tree) => {
    const envFile = join(tree.root, '.env');
    const main = join(tree.root, 'check.mjs');
    await writeFile(envFile, 'RELAY_TRUST_ENV=1\n', 'utf8');
    await writeFile(main, 'console.log("main v1");\n', 'utf8');

    const ambiguous = await computeCheckTrustBasis({ canonicalRoot: tree.root,
      executable: process.execPath, args: ['--env-file', '.env', 'check.mjs'] });
    assert.equal(ambiguous.ok, false, '分离式开关 + 多个文件参数无法证明哪一个是主脚本');
    assert.equal(ambiguous.ok ? '' : ambiguous.reason,
      CHECK_TRUST_REASON.DYNAMIC_EXECUTION_UNSUPPORTED,
    '歧义形态必须类型化拒绝，不得静默算出一份漏算主脚本的摘要');

    // 唯一文件参数不构成歧义：无论它是开关值还是主脚本，都会作为材料参与摘要。
    const single = await computeCheckTrustBasis({ canonicalRoot: tree.root,
      executable: process.execPath, args: ['--env-file', '.env'] });
    assert.equal(single.ok, true, '开关后只有一个文件参数时不构成主脚本歧义');
    if (!single.ok) return;
    assert.notEqual(materialAt(single.basis, envFile), undefined,
      '唯一文件参数无论解释为开关值还是主脚本都必须进材料');

    // `--test` 不取值（带值写法已被拒绝），其后的多个位置参数全是测试入口，不构成歧义。
    const first = join(tree.root, 'a.test.mjs');
    const second = join(tree.root, 'b.test.mjs');
    await writeFile(first, 'console.log("a v1");\n', 'utf8');
    await writeFile(second, 'console.log("b v1");\n', 'utf8');
    const testMode = await computeCheckTrustBasis({ canonicalRoot: tree.root,
      executable: process.execPath, args: ['--test', 'a.test.mjs', 'b.test.mjs'] });
    assert.equal(testMode.ok, true, '--test 后跟多个入口不构成开关值歧义（BE-01 不回归）');
    if (!testMode.ok) return;
    assert.notEqual(materialAt(testMode.basis, first), undefined,
      '测试模式下第一个入口必须进材料');
  });
});

// 引号包裹的等号值按字面文件名处理：读不到就是类型化拒绝，不靠猜测放行。
test('a quoted equals flag value is a typed unreadable, not a guess', async () => {
  await withTree(async (tree) => {
    const main = join(tree.root, 'check.mjs');
    await writeFile(main, 'console.log("main v1");\n', 'utf8');
    const quoted = await computeCheckTrustBasis({ canonicalRoot: tree.root,
      executable: process.execPath, args: ['--env-file=".env"', 'check.mjs'] });
    assert.equal(quoted.ok, false, '引号包裹的开关值按字面文件名处理，读不到即拒绝');
    assert.equal(quoted.ok ? '' : quoted.reason, CHECK_TRUST_REASON.MATERIAL_UNREADABLE,
    '引号形态不得被剥壳猜测，也不得静默放行');
  });
});

// 普通参数顺序与既有检查仍正常：等号值与分离写法同一身份，脚本后开关不改变形态。
test('ordinary flag values keep the existing material identity', async () => {
  await withTree(async (tree) => {
    const bare = await basisOf(tree);
    const viaEquals = await computeCheckTrustBasis({ canonicalRoot: tree.root,
      executable: tree.entry, args: ['--config=scripts/assert.mjs'] });
    assert.equal(viaEquals.ok, true);
    if (!viaEquals.ok) return;
    assert.equal(viaEquals.basis.digest, bare.digest,
      '同一材料用等号还是分离传，身份必须相同');

    const trailingFlag = await basisOf(tree, ['scripts/assert.mjs', '--verbose']);
    assert.deepEqual(trailingFlag.digest, bare.digest,
      '脚本之后的普通开关不得改变信任摘要');

    const trailingTest = await basisOf(tree, ['scripts/assert.mjs', '--test']);
    assert.deepEqual(trailingTest.digest, bare.digest,
      '跟在脚本之后的 --test 是脚本参数，不进入测试运行器形态');
  });
});

// P1：选项结束标记 `--` 之后，横线开头的参数是真正被执行的入口，不是开关。
// Node 24 实测：`node -- --entry.mjs src/value.txt` 执行 --entry.mjs；去掉终止符时
// 同一参数是 bad option。终止符正是「开关」与「被执行入口」的身份分界。
test('after the option terminator a leading dash argument is the executed entry, not a flag', async () => {
  await withTree(async (tree) => {
    const entry = join(tree.root, '--entry.mjs');
    const input = join(tree.root, 'src', 'feature.ts');
    await writeFile(entry, 'console.log("entry v1");\n', 'utf8');
    const args = ['--', '--entry.mjs', input];

    const basis = await nodeBasisOf(tree, args);
    assert.equal(materialAt(basis, entry)?.role, 'REFERENCED_SCRIPT',
      '终止符之后真正被执行、名称以横线开头的入口脚本必须进材料');
    assert.equal(materialAt(basis, input), undefined,
      '终止符之后的第二个路径参数是这次检查的输入，不是程序');

    await writeFile(entry, 'console.log("entry v2");\n', 'utf8');
    const entryChanged = await nodeBasisOf(tree, args);
    assert.notEqual(entryChanged.digest, basis.digest,
      '改真正执行的主脚本后摘要必须变化，否则冻结之后换入口仍会 AUTO');

    await writeFile(input, 'export const feature = 5;\n// 受验输入变了\n', 'utf8');
    assert.deepEqual(await nodeBasisOf(tree, args), entryChanged,
      '修被检查的输入不得因此让原信任依据失效');
  });
});

// P1：冻结之后才替换终止符形态下真正被执行的入口，原授权不再自动覆盖。
test('a replaced executed entry after the option terminator invalidates the frozen grant', async () => {
  await withTree(async (tree) => {
    const entry = join(tree.root, '--entry.mjs');
    await writeFile(entry, 'console.log("entry v1");\n', 'utf8');
    const args = ['--', '--entry.mjs', join(tree.root, 'src', 'feature.ts')];
    const basis = await nodeBasisOf(tree, args);
    const frozen: FrozenCheck = { id: 'check-1', executable: process.execPath, args,
      trust_basis: basis,
      executable_sha256: materialAt(basis, process.execPath)?.sha256 ?? '' };
    const db = dbOf(grantRow(tree, [frozen as unknown as JsonObject]));

    const unchanged = await evaluateScopeGrant(db, { ...baseInput(tree), check: frozen,
      observedExecutableSha256: frozen.executable_sha256,
      observedTrustDigest: basis.digest });
    assert.deepEqual(unchanged, { covered: true }, '材料未变时原授权照旧放行');

    // 冻结之后才把主脚本换成固定成功：入口没换路径、命令名也没换。
    await writeFile(entry, 'console.log("always ok");\nprocess.exit(0);\n', 'utf8');
    const decision = await evaluateScopeGrant(db, { ...baseInput(tree), check: frozen,
      observedExecutableSha256: frozen.executable_sha256,
      observedTrustDigest: (await nodeBasisOf(tree, args)).digest });
    assert.deepEqual(decision, { covered: false, reason: 'SCOPE_GRANT_CHECK_CHANGED' },
      '终止符之后真正被执行的入口被换掉后必须退回人工确认，不得沿用冻结时的 AUTO');
  });
});

// P1：终止符形态的入口在冻结期读不到时，必须在冻结期就报读不到。
test('an unreadable entry after the option terminator is refused at freeze time', async () => {
  await withTree(async (tree) => {
    const missing = await computeCheckTrustBasis({ canonicalRoot: tree.root,
      executable: process.execPath,
      args: ['--', '--entry.mjs', join(tree.root, 'src', 'feature.ts')] });
    assert.equal(missing.ok, false,
      '真正被执行的入口不存在时不得算出一份漏算入口的摘要');
    assert.equal(missing.ok ? '' : missing.reason,
      CHECK_TRUST_REASON.MATERIAL_UNREADABLE,
    '入口缺失必须在冻结期类型化报读不到，而不是留一份没有依据的授权');

    await mkdir(join(tree.root, '--entry.mjs'), { recursive: true });
    const directory = await computeCheckTrustBasis({ canonicalRoot: tree.root,
      executable: process.execPath, args: ['--', '--entry.mjs'] });
    assert.equal(directory.ok ? '' : directory.reason,
      CHECK_TRUST_REASON.MATERIAL_UNREADABLE,
      '目录形态的入口同样不是可哈希材料');
  });
});

// 边界保护：普通形态 `node check.mjs src/feature.ts` 仍是「入口 + 受验输入」。
test('an ordinary entry keeps the checked source mutable across repeated runs', async () => {
  await withTree(async (tree) => {
    const main = join(tree.root, 'check.mjs');
    const input = join(tree.root, 'src', 'feature.ts');
    await writeFile(main, 'console.log("check v1");\n', 'utf8');
    const args = [main, input];

    const basis = await nodeBasisOf(tree, args);
    assert.equal(materialAt(basis, main)?.role, 'REFERENCED_SCRIPT',
      '普通形态的第一个路径参数仍是主脚本');
    assert.equal(materialAt(basis, input), undefined, '受验源码是输入，不是程序');

    await writeFile(input, 'export const feature = 6;\n// 修复后的正文\n', 'utf8');
    assert.deepEqual(await nodeBasisOf(tree, args), basis,
      '「检查失败 → 修正 → 再跑同一检查」不能因为信任摘要而失效');
  });
});

// BE-01：终止符出现在 `--test` 之后时，全部显式测试入口仍然进材料。
test('the option terminator after --test still includes every explicit test entry', async () => {
  await withTree(async (tree) => {
    const first = join(tree.root, 'a.test.mjs');
    const second = join(tree.root, 'b.test.mjs');
    await writeFile(first, 'console.log("a v1");\n', 'utf8');
    await writeFile(second, 'console.log("b v1");\n', 'utf8');
    const args = ['--test', '--', first, second];

    const basis = await nodeBasisOf(tree, args);
    assert.equal(materialAt(basis, first)?.role, 'REFERENCED_SCRIPT');
    assert.equal(materialAt(basis, second)?.role, 'REFERENCED_SCRIPT',
      '终止符在 --test 之后时，终止符之后的路径参数仍全是入口（BE-01 不回归）');
    await writeFile(second, 'console.log("b v2");\n', 'utf8');
    assert.notEqual((await nodeBasisOf(tree, args)).digest, basis.digest,
      '第二个测试入口正文变化后摘要必须变化');
  });
});

// BE-02：动态预加载开关的拒绝规则不因终止符修复而放松（终止符也不给 `--import` 开口子）。
test('dynamic preload flags stay refused with or without the option terminator', async () => {
  await withTree(async (tree) => {
    await writeFile(join(tree.root, 'preload.mjs'), 'console.log("preload");\n', 'utf8');
    await writeFile(join(tree.root, 'check.mjs'), 'console.log("check");\n', 'utf8');
    for (const args of [['--import=./preload.mjs', 'check.mjs'],
      ['--import', './preload.mjs', 'check.mjs'],
      ['--require=./preload.mjs', 'check.mjs'],
      ['--import=./preload.mjs', '--', 'check.mjs']] as const) {
      const result = await computeCheckTrustBasis({ canonicalRoot: tree.root,
        executable: process.execPath, args: [...args] });
      assert.equal(result.ok ? '' : result.reason,
        CHECK_TRUST_REASON.DYNAMIC_EXECUTION_UNSUPPORTED,
      `参数 ${JSON.stringify(args)} 必须与修复前一致明确拒绝（BE-02）`);
    }

    // 终止符之后不再套用开关语义：同一个 `--import=...` 按字面文件名处理。
    // Node 24 实测 `node -- --test a.mjs` 是把 --test 当模块名去找，不是开关。
    const literal = await computeCheckTrustBasis({ canonicalRoot: tree.root,
      executable: process.execPath, args: ['--', '--import=./preload.mjs', 'check.mjs'] });
    assert.equal(literal.ok, false, '终止符之后不得把 `--import=...` 当开关放行');
    assert.equal(literal.ok ? '' : literal.reason, CHECK_TRUST_REASON.MATERIAL_UNREADABLE,
      '终止符之后按字面文件名处理，读不到就是读不到');
  });
});

// 终止符形态里无法证明执行范围的形态一律拒绝，不猜。
test('terminator forms whose execution range cannot be proven are refused', async () => {
  await withTree(async (tree) => {
    await writeFile(join(tree.root, '.env'), 'RELAY_TRUST_ENV=1\n', 'utf8');
    await writeFile(join(tree.root, 'check.mjs'), 'console.log("check");\n', 'utf8');
    const refusals: readonly string[][] = [
      ['--'],                                     // 终止符之后没有任何入口
      ['--verbose', '--'],                        // 同上
      ['--', 'run'],                              // 裸词不是单一文件引用
      ['--', '*.mjs'],                            // 通配符
      ['--', '-'],                                // 标准输入
      ['--', 'a&&b'],                             // shell 元字符
      ['--', ''],                                 // 空参数
      ['--', '--verbose'],                        // 横线开头但不是单一文件引用
      ['--env-file', '.env', '--', 'check.mjs'],  // 两侧各有一个候选入口，无法证明
      ['--', '--', 'check.mjs'],                  // 终止符自身重复出现
    ];
    for (const args of refusals) {
      const result = await computeCheckTrustBasis({ canonicalRoot: tree.root,
        executable: process.execPath, args });
      assert.equal(result.ok, false, `参数 ${JSON.stringify(args)} 不得被判为可自动信任`);
      assert.equal(result.ok ? '' : result.reason,
        CHECK_TRUST_REASON.DYNAMIC_EXECUTION_UNSUPPORTED,
      `参数 ${JSON.stringify(args)} 必须明确不支持执行范围`);
    }

    // 终止符之后按字面文件名处理：读不到就是读不到，不剥壳猜测也不静默放行。
    const literal = await computeCheckTrustBasis({ canonicalRoot: tree.root,
      executable: process.execPath, args: ['--', '--preload.mjs'] });
    assert.equal(literal.ok ? '' : literal.reason, CHECK_TRUST_REASON.MATERIAL_UNREADABLE,
      '终止符之后不存在的文件按材料读不到处理');
  });
});

// 终止符只在入口之前有「选项结束」含义：解释器的选项解析在第一个位置参数处停止，
// 入口之后的参数全部是传给脚本的 argv。Node 24 实测 `node check.mjs -- --verbose`
// 正常执行 check.mjs 并把 ["--","--verbose"] 原样传下去，因此这种形态完全可证明，
// 不得被判成「无法证明执行范围」而平白退回人工确认。
test('a terminator after the entry is an ordinary script argument, not an option terminator', async () => {
  await withTree(async (tree) => {
    const main = join(tree.root, 'check.mjs');
    const input = join(tree.root, 'src', 'feature.ts');
    await writeFile(main, 'console.log("main v1");\n', 'utf8');
    const plain = await nodeBasisOf(tree, [main]);

    // 入口之后的 `--` 与 `--verbose` 都是脚本 argv：不新增材料，摘要不变。
    const withArgv = await nodeBasisOf(tree, [main, '--', '--verbose']);
    assert.deepEqual(withArgv, plain,
      '入口之后的 `--` 与其后的横线参数是脚本 argv，不得改变执行材料集合');
    assert.equal(materialAt(withArgv, join(tree.root, '--verbose')), undefined,
      '脚本 argv 不是被执行材料');

    // 入口之后的路径参数仍是受验输入，改它不失效（「失败→修正→再跑」链不收紧）。
    const withInput = await nodeBasisOf(tree, [main, '--', input]);
    assert.equal(materialAt(withInput, input), undefined,
      '入口之后的路径参数仍是这次检查的输入，不是程序');
    assert.deepEqual(withInput, plain, '受验输入变化不得使原信任依据失效');
  });
});

// ── 环境文件值形状（Node 24.21.0 实测）──────────────────────────────────────
// 实测结论（固定 Node v24.21.0，受管根内放一个名为 `--` 的文件与 `check.mjs`）：
//   node --env-file=-- check.mjs        → exit 0，真实打开名为 `--` 的文件；
//                                          把该文件内容从 A 改成 B，脚本读到的环境变量随之变化。
//   node --env-file --  check.mjs       → exit 9 `--env-file requires an argument`，不执行任何脚本。
//   node --env-file=.envx check.mjs     → exit 9 `.envx: not found`，不执行任何脚本。
//   node --env-file=--argv.mjs -- --verbose → ARGV=["--","--verbose"]，入口之后的 `--` 仍是脚本 argv。
// 因此值位置没有终止符语义：一个**恰好等于 `--` 的值**是被真实读取的文件名，必须进材料；
// 而分离形态下 `--` 根本不是该选项的值，执行范围无法证明，必须明确拒绝。

/** 受管根里名为 `--` 的文件：等号开关值形态下它就是真实 Node 会打开的那个文件。 */
async function writeDashDashEnvFile(tree: Tree, text: string): Promise<string> {
  const path = join(tree.root, '--');
  await writeFile(path, text, 'utf8');
  return path;
}

const DASH_DASH_ARGS = (tree: Tree) => ['--env-file=--', join(tree.root, 'check.mjs')];

// 1. 值恰好等于 `--` 的等号开关必须把那个文件算成材料，不能按「看起来像开关」丢掉。
test('an equals-form flag value of -- is a hashed file, not a dropped flag', async () => {
  await withTree(async (tree) => {
    const main = join(tree.root, 'check.mjs');
    await writeFile(main, 'console.log("main v1");\n', 'utf8');
    const dashFile = await writeDashDashEnvFile(tree,
      'RELAY_ACCEPTANCE_SENTINEL_ENVFILE=first\n');

    const basis = await nodeBasisOf(tree, DASH_DASH_ARGS(tree));
    const material = materialAt(basis, dashFile);
    assert.equal(material?.role, 'REFERENCED_SCRIPT',
      '值为 `--` 的等号开关读到的文件必须进入信任材料，而不是被当成 FLAG 丢弃');
    assert.equal(material?.rootRelativePath, '--',
      '名为 `--` 的文件在根内，必须按根内相对路径登记');
    assert.notEqual(materialAt(basis, main), undefined,
      '开关引用文件不占主脚本位置：主脚本仍必须进材料');
  });
});

// 2. 该环境文件正文变化必须让摘要变化，并使旧冻结不再自动放行。
test('changing the equals-form -- env file body invalidates the frozen grant', async () => {
  await withTree(async (tree) => {
    const main = join(tree.root, 'check.mjs');
    await writeFile(main, 'console.log("main v1");\n', 'utf8');
    const dashFile = await writeDashDashEnvFile(tree,
      'RELAY_ACCEPTANCE_SENTINEL_ENVFILE=first\n');
    const args = DASH_DASH_ARGS(tree);

    const before = await nodeBasisOf(tree, args);
    const frozen: FrozenCheck = { id: 'check-1', executable: process.execPath, args,
      trust_basis: before,
      executable_sha256: materialAt(before, process.execPath)?.sha256 ?? '' };
    const db = dbOf(grantRow(tree, [frozen as unknown as JsonObject]));

    const unchanged = await evaluateScopeGrant(db, { ...baseInput(tree), check: frozen,
      observedExecutableSha256: frozen.executable_sha256,
      observedTrustDigest: before.digest });
    assert.deepEqual(unchanged, { covered: true },
      '环境文件未变时原授权照旧放行，不把这条链变成永久人工确认');

    // 只改环境文件：入口路径、命令名、参数一字未动。
    await writeFile(dashFile, 'RELAY_ACCEPTANCE_SENTINEL_ENVFILE=second\n', 'utf8');
    const after = await nodeBasisOf(tree, args);
    assert.notEqual(after.digest, before.digest,
      '环境文件正文变化后信任摘要必须变化，否则旧授权会沿用被替换的环境配置');

    const changed = await evaluateScopeGrant(db, { ...baseInput(tree), check: frozen,
      observedExecutableSha256: frozen.executable_sha256,
      observedTrustDigest: after.digest });
    assert.deepEqual(changed, { covered: false, reason: 'SCOPE_GRANT_CHECK_CHANGED' },
      '冻结之后被替换的环境文件必须使原授权退回人工确认');
  });
});

// 3. 根内没有名为 `--` 的文件时，冻结期必须明确拒绝，而不是静默算出一份漏算材料的授权。
// Node 24.21.0 实测这种形态 exit 9 `--: not found`，根本不执行任何脚本。
test('an equals-form -- env file that cannot be read is refused at freeze time', async () => {
  await withTree(async (tree) => {
    await writeFile(join(tree.root, 'check.mjs'), 'console.log("main v1");\n', 'utf8');
    const missing = await computeCheckTrustBasis({ canonicalRoot: tree.root,
      executable: process.execPath, args: DASH_DASH_ARGS(tree) });
    assert.equal(missing.ok, false, '读不到的环境文件不得被判为可自动信任');
    assert.equal(missing.ok ? '' : missing.reason, CHECK_TRUST_REASON.MATERIAL_UNREADABLE,
      '环境文件读不到必须在冻结期类型化报读不到，而不是落一份没有依据的授权');

    await mkdir(join(tree.root, '--'), { recursive: true });
    const directory = await computeCheckTrustBasis({ canonicalRoot: tree.root,
      executable: process.execPath, args: DASH_DASH_ARGS(tree) });
    assert.equal(directory.ok ? '' : directory.reason, CHECK_TRUST_REASON.MATERIAL_UNREADABLE,
      '名为 `--` 的路径是目录时同样不是可哈希材料（Node 实测 invalid format）');
  });
});

// 4. 分离形态下 `--` 不是取值开关的值：Node 24.21.0 实测 exit 9 `requires an argument`，
//    一个脚本都不执行。执行范围无法证明，必须明确拒绝，不得按终止符放行。
test('a separated value-taking flag followed by -- is refused instead of read as a terminator', async () => {
  await withTree(async (tree) => {
    await writeFile(join(tree.root, '.env'), 'RELAY_ACCEPTANCE_SENTINEL_ENVFILE=dotenv\n', 'utf8');
    await writeFile(join(tree.root, 'check.mjs'), 'console.log("main v1");\n', 'utf8');
    await writeDashDashEnvFile(tree, 'RELAY_ACCEPTANCE_SENTINEL_ENVFILE=dashdash\n');
    const refusals: readonly string[][] = [
      ['--env-file', '--'],
      ['--env-file', '--', join(tree.root, 'check.mjs')],
      ['--env-file', '--', join(tree.root, 'check.mjs'), join(tree.root, 'src', 'feature.ts')],
    ];
    for (const args of refusals) {
      const result = await computeCheckTrustBasis({ canonicalRoot: tree.root,
        executable: process.execPath, args });
      assert.equal(result.ok, false, `参数 ${JSON.stringify(args)} 不得被判为可自动信任`);
      assert.equal(result.ok ? '' : result.reason,
        CHECK_TRUST_REASON.DYNAMIC_EXECUTION_UNSUPPORTED,
      `参数 ${JSON.stringify(args)} 无法证明执行范围，必须类型化拒绝`);
    }
  });
});

// 5. 既有等号普通值形态不得回归：`.env` 与主脚本都进材料，改主脚本摘要变化。
test('the existing equals-form env file material set is unchanged', async () => {
  await withTree(async (tree) => {
    const envFile = join(tree.root, '.env');
    const main = join(tree.root, 'check.mjs');
    await writeFile(envFile, 'RELAY_ACCEPTANCE_SENTINEL_ENVFILE=dotenv\n', 'utf8');
    await writeFile(main, 'console.log("main v1");\n', 'utf8');
    const args = ['--env-file=.env', main];

    const before = await nodeBasisOf(tree, args);
    assert.notEqual(materialAt(before, envFile)?.role, undefined,
      '等号开关引用的普通文件仍必须进材料');
    assert.equal(materialAt(before, main)?.role, 'REFERENCED_SCRIPT',
      '等号开关值不占主脚本位置：主脚本仍必须进材料');

    await writeFile(main, 'console.log("main v2");\n', 'utf8');
    assert.notEqual((await nodeBasisOf(tree, args)).digest, before.digest,
      '改主脚本正文必须让摘要变化（既有形态不得回归）');

    await writeFile(main, 'console.log("main v1");\n', 'utf8');
    await writeFile(envFile, 'RELAY_ACCEPTANCE_SENTINEL_ENVFILE=dotenv2\n', 'utf8');
    assert.notEqual((await nodeBasisOf(tree, args)).digest, before.digest,
      '改等号开关引用的环境文件正文必须让摘要变化（既有形态不得回归）');
  });
});

// 6. 动态预加载开关的拒绝规则不因值形状修复而放松；`--` 形态按**开关身份**拒绝，
//    与值形状无关（Node 实测 `--import=--` 报 `Cannot find module '--'`）。
test('dynamic preload flags stay refused and a -- valued preload is refused by flag identity', async () => {
  await withTree(async (tree) => {
    await writeFile(join(tree.root, 'preload.mjs'), 'console.log("preload");\n', 'utf8');
    await writeFile(join(tree.root, 'check.mjs'), 'console.log("check");\n', 'utf8');
    await writeDashDashEnvFile(tree, 'RELAY_ACCEPTANCE_SENTINEL_ENVFILE=dashdash\n');
    const main = join(tree.root, 'check.mjs');
    const cases: readonly string[][] = [
      ['--import=./preload.mjs', main],
      ['--import', './preload.mjs', main],
      ['--require=./preload.mjs', main],
      ['--require', './preload.mjs', main],
      ['-r./preload.mjs', main],
      ['--loader=./preload.mjs', main],
      ['--loader', './preload.mjs', main],
      // 值为 `--` 的同类形态：按开关身份一致拒绝，不得因为值可读就放行。
      ['--import=--', main],
      ['--require=--', main],
      ['--loader=--', main],
      ['--experimental-loader=--', main],
    ];
    for (const args of cases) {
      const result = await computeCheckTrustBasis({ canonicalRoot: tree.root,
        executable: process.execPath, args });
      assert.equal(result.ok, false, `参数 ${JSON.stringify(args)} 不得被判为可自动信任`);
      assert.equal(result.ok ? '' : result.reason,
        CHECK_TRUST_REASON.DYNAMIC_EXECUTION_UNSUPPORTED,
      `参数 ${JSON.stringify(args)} 必须明确不支持动态执行`);
    }
  });
});

// 7. BE-01 不回归：`node --test` 多显式入口全部进材料，第二个变化让摘要变化。
test('node --test still includes every explicit entry after the value-shape change', async () => {
  await withTree(async (tree) => {
    const first = join(tree.root, 'a.test.mjs');
    const second = join(tree.root, 'b.test.mjs');
    await writeFile(first, 'console.log("a v1");\n', 'utf8');
    await writeFile(second, 'console.log("b v1");\n', 'utf8');
    const args = ['--test', first, second];

    const before = await nodeBasisOf(tree, args);
    assert.equal(materialAt(before, first)?.role, 'REFERENCED_SCRIPT',
      '第一个测试入口必须进材料（BE-01）');
    assert.equal(materialAt(before, second)?.role, 'REFERENCED_SCRIPT',
      '第二个测试入口必须进材料（BE-01：只取第一个会漏算）');

    await writeFile(second, 'console.log("b v2");\n', 'utf8');
    assert.notEqual((await nodeBasisOf(tree, args)).digest, before.digest,
      '第二个测试入口正文变化后摘要必须变化');
  });
});

// 8. 上一轮 P1 不回归：终止符之后真正被执行、名称以横线开头的入口进材料，受验输入不进。
test('the executed entry after the option terminator keeps its material set', async () => {
  await withTree(async (tree) => {
    const entry = join(tree.root, '--entry.mjs');
    const input = join(tree.root, 'src', 'feature.ts');
    await writeFile(entry, 'console.log("entry v1");\n', 'utf8');
    const args = ['--', entry, input];

    const basis = await nodeBasisOf(tree, args);
    assert.equal(materialAt(basis, entry)?.role, 'REFERENCED_SCRIPT',
      '终止符之后真正被执行的入口必须进材料');
    assert.equal(materialAt(basis, input), undefined,
      '终止符之后的受验输入不是执行材料');
    await writeFile(entry, 'console.log("entry v2");\n', 'utf8');
    assert.notEqual((await nodeBasisOf(tree, args)).digest, basis.digest,
      '改真正执行的入口后摘要必须变化');
  });
});

// 9. 上一轮语义不回归：入口之后的 `--` 与其后的横线参数是脚本 argv，摘要不变。
//    注意与「入口之后、没有 `--` 的等号开关」区分：实测 Node 对后者仍然校验该文件存在
//    （`node check.mjs --env-file=--` 在没有名为 `--` 的文件时报 `--: not found`，exit 9），
//    入口之后紧跟一个显式 `--` 时才完全不看它（纯 argv，exit 0）。两种形态都按实测断言。
test('a terminator after the executed entry stays an ordinary script argument', async () => {
  await withTree(async (tree) => {
    const main = join(tree.root, 'check.mjs');
    await writeFile(main, 'console.log("main v1");\n', 'utf8');
    const plain = await nodeBasisOf(tree, [main]);

    assert.deepEqual(await nodeBasisOf(tree, [main, '--']), plain,
      '入口之后的 `--` 自身是脚本 argv，不得改变执行材料集合（也不得被判成无法证明）');
    assert.deepEqual(await nodeBasisOf(tree, [main, '--', '--verbose']), plain,
      '入口之后的 `--` 与其后的横线参数都是脚本 argv，不得被重新当成选项解析');

    // 实测：入口之后**没有**显式 `--` 时，Node 仍会校验 `--env-file` 的值存在
    // （缺文件报 `--: not found`，exit 9）。这种形态必须保持「读不到即拒绝」。
    await writeDashDashEnvFile(tree, 'RELAY_ACCEPTANCE_SENTINEL_ENVFILE=argv\n');
    const postEntry = await nodeBasisOf(tree, [main, '--env-file=--']);
    assert.equal(materialAt(postEntry, join(tree.root, '--'))?.role, 'REFERENCED_SCRIPT',
      '入口之后的等号开关值仍按被校验的文件处理（与 `--env-file=.env` 同一约定）');
    await rm(join(tree.root, '--'), { force: true });
    const missing = await computeCheckTrustBasis({ canonicalRoot: tree.root,
      executable: process.execPath, args: [main, '--env-file=--'] });
    assert.equal(missing.ok ? '' : missing.reason, CHECK_TRUST_REASON.MATERIAL_UNREADABLE,
      '入口之后 Node 仍校验该文件存在（实测 exit 9 not found），读不到必须拒绝');
  });
});

// 10. 普通检查形态的受验源码修改链不回归：`node check.mjs src/feature.ts` 改源码摘要不变。
test('the checked source file of an ordinary check form stays mutable', async () => {
  await withTree(async (tree) => {
    const main = join(tree.root, 'check.mjs');
    const input = join(tree.root, 'src', 'feature.ts');
    await writeFile(main, 'console.log("check v1");\n', 'utf8');
    const args = [main, input];

    const before = await nodeBasisOf(tree, args);
    assert.equal(materialAt(before, main)?.role, 'REFERENCED_SCRIPT',
      '普通形态的第一个路径参数仍是主脚本');
    assert.equal(materialAt(before, input), undefined, '受验源码是输入，不是程序');

    await writeFile(input, 'export const feature = 7;\n// 修复后的正文\n', 'utf8');
    assert.deepEqual(await nodeBasisOf(tree, args), before,
      '「检查失败 → 修正 → 再跑同一检查」不能因为这次值形状修复而失效');
  });
});
