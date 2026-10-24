import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeUserFileParams, userFileOperationId, userFileIntentKey,
  projectUserFileResult, assertUserFileAction, userFileTarget,
  type UserFileReadRequest,
} from '../../src/application/file-user-action.js';

const base: UserFileReadRequest = {
  workspaceId: 'ws-1', projectId: 'proj-1', resourceId: 'res-1', connectionId: 'conn-1',
  actionType: 'LIST_DIRECTORY',
};

test('assertUserFileAction 只放行 LIST_DIRECTORY / READ_FILE，并抛出可映射的 409', () => {
  assert.doesNotThrow(() => assertUserFileAction('LIST_DIRECTORY'));
  assert.doesNotThrow(() => assertUserFileAction('READ_FILE'));
  for (const action of ['FIND_PATHS', 'SEARCH_TEXT', 'GIT_STAGE', 'WRITE_FILE', 'CLI_RUN']) {
    assert.throws(() => assertUserFileAction(action), (error: any) =>
      error?.code === 'GATEWAY_ORIGIN_DENIED' && error?.status === 409, `${action} 应被拒`);
  }
});

test('LIST_DIRECTORY 收敛 relative_path 与 limit；绝对路径与 .. 段在 IO 前被拒', () => {
  assert.deepEqual(normalizeUserFileParams(base), {});
  assert.deepEqual(normalizeUserFileParams({ ...base, relativePath: 'sub' }),
    { relative_path: 'sub' });
  // limit 在适配器内生效（有界枚举），因此进冻结参数——与 git 的投影 limit 分属两种口径。
  assert.deepEqual(normalizeUserFileParams({ ...base, relativePath: 'sub', limit: 10 }),
    { relative_path: 'sub', limit: 10 });
  assert.throws(() => normalizeUserFileParams({ ...base, relativePath: 'C:/Windows' }));
  assert.throws(() => normalizeUserFileParams({ ...base, relativePath: '../outside' }));
  assert.throws(() => normalizeUserFileParams({ ...base, relativePath: '  ' }));
  assert.throws(() => normalizeUserFileParams({ ...base, limit: 0 }));
  assert.throws(() => normalizeUserFileParams({ ...base, limit: 1.5 }));
});

test('READ_FILE 必须带相对路径且不接受 limit；路径只进 target 不进 params', () => {
  const read: UserFileReadRequest = { ...base, actionType: 'READ_FILE', relativePath: 'a.txt' };
  assert.deepEqual(normalizeUserFileParams(read), {});
  assert.throws(() => normalizeUserFileParams({ ...base, actionType: 'READ_FILE' }));
  assert.throws(() => normalizeUserFileParams({ ...read, limit: 100 }));
  assert.throws(() => normalizeUserFileParams({ ...read, relativePath: '../escape.txt' }));
});

test('动作身份由参数与 command_id 确定：同命令同 ID，换命令或换参数即不同 ID', () => {
  const withCommand = { ...base, commandId: 'cmd-1' };
  const first = userFileOperationId(withCommand);
  assert.equal(first, userFileOperationId(withCommand));
  // command_id 参与身份是本模块与 git 人工读取的分界：新命令（用户每次点击）产生新读取事实。
  assert.notEqual(first, userFileOperationId({ ...base, commandId: 'cmd-2' }));
  assert.notEqual(first, userFileOperationId({ ...withCommand, actionType: 'READ_FILE' }));
  assert.notEqual(first, userFileOperationId({ ...withCommand, relativePath: 'sub' }));
  // limit 改变适配器行为，因此同样参与身份。
  assert.notEqual(first, userFileOperationId({ ...withCommand, limit: 10 }));
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
  assert.equal(userFileIntentKey(first), `user-file-read:${first}`);
});

test('userFileTarget 把相对路径拼到受管根上（绝对形态交 prepare 归一）', () => {
  assert.equal(userFileTarget('D:/work/root', base), 'D:\\work\\root');
  assert.equal(userFileTarget('D:/work/root', { ...base, relativePath: 'sub/deep' }),
    'D:\\work\\root\\sub\\deep');
});

test('projectUserFileResult：失败与缺失走类型化 reason，不冒充空目录或空文件', () => {
  const failure = projectUserFileResult(base, { failure_kind: 'FILE_TOO_LARGE' });
  assert.deepEqual(failure, { reason: 'FILE_TOO_LARGE' });
  const withDetail = projectUserFileResult(base, { reason: 'ADAPTER_ERROR', error: 'boom' });
  assert.deepEqual(withDetail, { reason: 'ADAPTER_ERROR', detail: 'boom' });

  const listingMissing = projectUserFileResult(base, { directory: '.' });
  assert.equal((listingMissing as { reason?: string }).reason, 'FILE_QUERY_RESULT_MISSING');
  assert.equal('entries' in listingMissing, false);

  const read: UserFileReadRequest = { ...base, actionType: 'READ_FILE' };
  const readMissing = projectUserFileResult(read, { target: 'x', size: 3 });
  assert.equal((readMissing as { reason?: string }).reason, 'FILE_READ_RESULT_MISSING');
  assert.equal('content' in readMissing, false);

  // 合法结果原样透出（有界化在适配器内完成）。
  const listing = projectUserFileResult(base, { directory: '.', entries: [], count: 0,
    limit: 200, truncated: false, skipped: 0 });
  assert.equal((listing as { count: number }).count, 0);
});
