import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUserGitParams, userGitOperationId, userGitIntentKey, projectUserGitResult, assertUserGitAction, } from '../../src/application/git-user-action.js';
import { GIT_DIFF_MAX_BYTES, GIT_STATUS_MAX_PATHS, projectGitDiff, projectGitStatus, } from '../../src/git/git-read-projection.js';
import { originAllows } from '../../src/application/gateway-actions.js';
const base = {
    workspaceId: 'ws-1', projectId: 'proj-1', resourceId: 'res-1', connectionId: 'conn-1',
    actionType: 'GIT_STATUS',
};
test('USER_ACTION 只放行 GIT_STATUS / GIT_DIFF，不放行任何写或 CLI 动作', () => {
    const origin = { kind: 'USER_ACTION', projectId: 'proj-1', resourceId: 'res-1' };
    const allowed = [
        ['GIT_STATUS', 'GIT_READ'],
        ['GIT_DIFF', 'GIT_READ'],
    ];
    for (const [action, capability] of allowed) {
        assert.equal(originAllows(origin, action, capability), true, `${action} 应放行`);
    }
    // 人工只读不能被拿来触发写入、暂存、提交、推送、受控 CLI、文件读写或目录查询。
    const denied = [
        ['GIT_STAGE', 'GIT_WRITE'], ['GIT_COMMIT', 'GIT_WRITE'], ['GIT_PUSH', 'GIT_WRITE'],
        ['GIT_LOG', 'GIT_READ'],
        ['CLI_RUN', 'CLI_RUN'], ['RUN_BUILD', 'CLI_RUN'], ['RUN_TEST', 'CLI_RUN'],
        ['WRITE_FILE', 'FILE_WRITE'], ['APPLY_CHANGESET', 'FILE_WRITE'],
        ['LIST_DIRECTORY', 'FILE_QUERY'], ['FIND_PATHS', 'FILE_QUERY'], ['SEARCH_TEXT', 'FILE_QUERY'],
        ['READ_FILE', 'FILE_READ'], ['READ_PUBLIC', 'FAKE_PUBLIC_READ'], ['WEB_FETCH', 'WEB_FETCH'],
        ['WRITE_MARKER', 'FAKE_WRITE'],
    ];
    for (const [action, capability] of denied) {
        assert.equal(originAllows(origin, action, capability), false, `${action} 不应放行`);
    }
});
test('RUN / USER_IMPORT 的原有放行口径不因新增 USER_ACTION 而改变', () => {
    const run = { kind: 'RUN', runId: 'r', stepId: 's', workerId: 'w', workerEpoch: 1n };
    assert.equal(originAllows(run, 'GIT_STAGE', 'GIT_WRITE'), true);
    assert.equal(originAllows(run, 'APPLY_CHANGESET', 'FILE_WRITE'), true);
    const importOrigin = { kind: 'USER_IMPORT', importJobId: 'j', actorRef: 'user:local', configVersion: 'v' };
    assert.equal(originAllows(importOrigin, 'WEB_FETCH', 'WEB_FETCH'), true);
    assert.equal(originAllows(importOrigin, 'READ_PUBLIC', 'FAKE_PUBLIC_READ'), true);
    assert.equal(originAllows(importOrigin, 'GIT_STATUS', 'GIT_READ'), false);
    assert.equal(originAllows(importOrigin, 'WRITE_MARKER', 'FAKE_WRITE'), false);
});
test('assertUserGitAction 拒绝写动作并抛出可映射的 409', () => {
    assert.doesNotThrow(() => assertUserGitAction('GIT_STATUS'));
    assert.doesNotThrow(() => assertUserGitAction('GIT_DIFF'));
    for (const action of ['GIT_STAGE', 'GIT_COMMIT', 'GIT_PUSH', 'CLI_RUN', 'APPLY_CHANGESET']) {
        assert.throws(() => assertUserGitAction(action), (error) => error?.code === 'GATEWAY_ORIGIN_DENIED' && error?.status === 409, `${action} 应被拒`);
    }
});
test('GIT_STATUS 不接受 path / cached；limit 只作用于投影，不进冻结参数', () => {
    assert.deepEqual(normalizeUserGitParams(base), {});
    // limit 是展示上限，不是「读了什么」：进 params 会让同一次读取换上限就变成意图冲突。
    assert.deepEqual(normalizeUserGitParams({ ...base, limit: 5 }), {});
    assert.throws(() => normalizeUserGitParams({ ...base, relativePath: 'src/a.ts' }));
    assert.throws(() => normalizeUserGitParams({ ...base, cached: true }));
    assert.throws(() => normalizeUserGitParams({ ...base, limit: 0 }));
    assert.throws(() => normalizeUserGitParams({ ...base, limit: 1.5 }));
});
test('GIT_DIFF 收敛 path / cached；非法类型在 IO 前被拒', () => {
    const diff = { ...base, actionType: 'GIT_DIFF' };
    assert.deepEqual(normalizeUserGitParams(diff), {});
    assert.deepEqual(normalizeUserGitParams({ ...diff, relativePath: 'src/a.ts', cached: true }), { path: 'src/a.ts', cached: true });
    assert.deepEqual(normalizeUserGitParams({ ...diff, limit: 4096 }), {});
    assert.throws(() => normalizeUserGitParams({ ...diff, relativePath: '  ' }));
    assert.throws(() => normalizeUserGitParams({ ...diff, cached: 'yes' }));
    assert.throws(() => normalizeUserGitParams({ ...diff, limit: 0 }));
    assert.throws(() => normalizeUserGitParams({ ...diff, limit: 1.5 }));
});
test('动作身份由内容确定性导出：同参数同 ID，任一参数变化即不同 ID', () => {
    const first = userGitOperationId(base);
    assert.equal(first, userGitOperationId({ ...base }));
    // 不同 Workspace / Project / 受管资源不能共享动作身份。
    assert.notEqual(first, userGitOperationId({ ...base, workspaceId: 'ws-2' }));
    assert.notEqual(first, userGitOperationId({ ...base, projectId: 'proj-2' }));
    assert.notEqual(first, userGitOperationId({ ...base, resourceId: 'res-2' }));
    // 不同动作或参数也不能共享。
    assert.notEqual(first, userGitOperationId({ ...base, actionType: 'GIT_DIFF' }));
    // limit 只是投影上限，不改变「读了什么」，因此不参与动作身份。
    assert.equal(userGitOperationId({ ...base, limit: 1 }), first);
    // 形态像 uuid，便于人工按 ID 检索账本。
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(userGitIntentKey(first), `user-git-read:${first}`);
});
test('GIT_STATUS 投影：三个列表各自有界，截断带 truncated 与真实计数', () => {
    const many = Array.from({ length: GIT_STATUS_MAX_PATHS + 20 }, (_, i) => `f${i}.ts`);
    const projected = projectGitStatus({
        branch: 'main', headCommit: 'abc', staged: [], unstaged: many, untracked: ['new.ts'],
    });
    assert.equal(projected.unstaged.length, GIT_STATUS_MAX_PATHS);
    assert.equal(projected.truncated, true);
    assert.equal(projected.limit, GIT_STATUS_MAX_PATHS);
    assert.equal(projected.totals.unstaged, many.length);
    // 未溢出时 truncated 为 false，界面才能把它当作完整证据。
    const small = projectGitStatus({
        branch: 'main', headCommit: null, staged: ['a.ts'], unstaged: [], untracked: [],
    });
    assert.equal(small.truncated, false);
    assert.equal(small.head_commit, null);
    assert.equal(small.totals && small.totals.staged, 1);
});
test('GIT_DIFF 投影：按字节有界，不在多字节字符中间切断，并给出省略字节数', () => {
    const ascii = 'x'.repeat(GIT_DIFF_MAX_BYTES + 100);
    const projected = projectGitDiff(ascii);
    assert.equal(projected.truncated, true);
    assert.equal(projected.diff.length, GIT_DIFF_MAX_BYTES);
    assert.equal(projected.returned_bytes, GIT_DIFF_MAX_BYTES);
    assert.equal(projected.omitted_bytes, 100);
    const small = projectGitDiff('diff --git a/a b/a');
    assert.equal(small.truncated, false);
    assert.equal(small.omitted_bytes, 0);
    assert.equal(small.diff, 'diff --git a/a b/a');
    // 正文含中文时不能切出半个字符。
    const chinese = '中'.repeat(1000);
    const cut = projectGitDiff(chinese, 11); // 11 不是 3 的整数倍
    assert.equal(cut.truncated, true);
    assert.equal(Buffer.from(cut.diff, 'utf8').length % 3, 0);
    assert.ok(cut.diff.length > 0);
});
test('projectUserGitResult 在结果缺失时返回类型化 reason，绝不返回空列表冒充干净', () => {
    const statusMissing = projectUserGitResult(base, null);
    assert.equal(statusMissing.reason, 'GIT_STATUS_RESULT_MISSING');
    // 关键反例：非 Git 目录导致读取失败时，绝不能落成 staged/unstaged/untracked 全空的成功形态。
    assert.equal('staged' in statusMissing, false);
    const diff = { ...base, actionType: 'GIT_DIFF' };
    const diffMissing = projectUserGitResult(diff, { status: {} });
    assert.equal(diffMissing.reason, 'GIT_DIFF_RESULT_MISSING');
    assert.equal('diff' in diffMissing, false);
    // 合法状态原样透出且带上限标记。
    const ok = projectUserGitResult(base, { status: { branch: 'main', headCommit: 'sha',
            staged: [], unstaged: ['x.ts'], untracked: [] } });
    assert.equal(ok.branch, 'main');
    assert.equal(ok.truncated, false);
});
