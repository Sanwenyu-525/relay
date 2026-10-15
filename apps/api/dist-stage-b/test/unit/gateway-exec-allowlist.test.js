import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAllowedExecutables } from '../../src/application/gateway-commands.js';
/**
 * CLI_RUN 连接上的可执行文件允许清单。
 *
 * 模型只提出入口；根外入口（包管理器、解释器、系统工具）必须由用户在这里点名。
 * 这些用例锁住「配了、没配、配错」三种形状各自的判定。
 */
const roots = [];
after(async () => {
    for (const root of roots)
        await rm(root, { recursive: true, force: true });
});
async function syntheticRoot() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'relay-exec-allowlist-')));
    roots.push(root);
    await mkdir(join(root, 'tools'), { recursive: true });
    await writeFile(join(root, 'check.ps1'), 'exit 0\n', 'utf8');
    await writeFile(join(root, 'tools', 'runner.cmd'), '@exit /b 0\n', 'utf8');
    return root;
}
const CLI_RUN = ['CLI_RUN'];
const FILE_WRITE = ['FILE_WRITE'];
function codeOf(error) {
    return error.code ?? '';
}
function fieldOf(error) {
    return (error.fieldErrors?.[0]?.field) ?? '';
}
test('a listed executable is stored as its realpath so the effective value is readable', async () => {
    const root = await syntheticRoot();
    const resolved = await resolveAllowedExecutables(CLI_RUN, [join(root, 'tools', 'runner.cmd')]);
    assert.deepEqual(resolved, [join(root, 'tools', 'runner.cmd')]);
});
test('an absent list stays absent so existing connections keep their exact config shape', async () => {
    assert.equal(await resolveAllowedExecutables(CLI_RUN, undefined), undefined);
});
test('an empty list is refused rather than stored as a silent no-op', async () => {
    await assert.rejects(resolveAllowedExecutables(CLI_RUN, []), (error) => {
        assert.equal(codeOf(error), 'VALIDATION_FAILED');
        assert.equal(fieldOf(error), 'allowed_executables');
        return true;
    });
});
test('a list on a connection without CLI_RUN is refused instead of widening another capability', async () => {
    await assert.rejects(resolveAllowedExecutables(FILE_WRITE, ['C:/tools/node.exe']), (error) => {
        assert.equal(codeOf(error), 'VALIDATION_FAILED');
        assert.equal(fieldOf(error), 'allowed_executables');
        return true;
    });
});
test('a relative entry is refused because the managed root cannot be assumed here', async () => {
    await assert.rejects(resolveAllowedExecutables(CLI_RUN, ['check.ps1']), (error) => {
        assert.equal(codeOf(error), 'VALIDATION_FAILED');
        assert.equal(fieldOf(error), 'allowed_executables');
        return true;
    });
});
test('an entry that does not exist is refused rather than trusted until first run', async () => {
    const root = await syntheticRoot();
    await assert.rejects(resolveAllowedExecutables(CLI_RUN, [join(root, 'not-there.exe')]), (error) => {
        assert.equal(codeOf(error), 'VALIDATION_FAILED');
        assert.equal(fieldOf(error), 'allowed_executables');
        return true;
    });
});
test('a directory is refused because an executable entry must be a runnable file', async () => {
    const root = await syntheticRoot();
    await assert.rejects(resolveAllowedExecutables(CLI_RUN, [join(root, 'tools')]), (error) => {
        assert.equal(codeOf(error), 'VALIDATION_FAILED');
        assert.equal(fieldOf(error), 'allowed_executables');
        return true;
    });
});
test('a blank entry is refused instead of reaching realpath', async () => {
    await assert.rejects(resolveAllowedExecutables(CLI_RUN, ['   ']), (error) => {
        assert.equal(codeOf(error), 'VALIDATION_FAILED');
        assert.equal(fieldOf(error), 'allowed_executables');
        return true;
    });
});
test('more entries than the cap are refused in one shot rather than truncated', async () => {
    const root = await syntheticRoot();
    const many = Array.from({ length: 33 }, (_, index) => join(root, `runner-${index}.cmd`));
    await assert.rejects(resolveAllowedExecutables(CLI_RUN, many), (error) => {
        assert.equal(codeOf(error), 'VALIDATION_FAILED');
        assert.equal(fieldOf(error), 'allowed_executables');
        return true;
    });
});
test('a script inside the managed root may be listed explicitly and duplicates collapse', async () => {
    const root = await syntheticRoot();
    const target = join(root, 'check.ps1');
    // 同��文件经两种写法给出：规范化之后应当只剩一项，用户回读到的是真正生效的那份。
    const resolved = await resolveAllowedExecutables(CLI_RUN, [target, join(root, 'tools', '..', 'check.ps1')]);
    assert.deepEqual(resolved, [target]);
});
test('in-root and out-of-root entries coexist in one list', async () => {
    const root = await syntheticRoot();
    const resolved = await resolveAllowedExecutables(CLI_RUN, [join(root, 'check.ps1'), join(root, 'tools', 'runner.cmd')]);
    assert.deepEqual(resolved, [join(root, 'check.ps1'), join(root, 'tools', 'runner.cmd')]);
});
