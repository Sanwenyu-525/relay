import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_PREVIEW_TEXT_CHARS, ToolCallPreviewPublisher,
  type PreviewFileReader } from '../../src/conversation-diff/tool-call-preview.js';
import type { ToolCallPreviewRecord, ToolCallPreviewRepository,
  UpsertToolCallPreviewInput } from '../../src/conversation-diff/tool-call-preview-repository.js';

/** 只记录 upsert 的假仓储：预览是展示证据，测试只关心「写了什么」。 */
class RecordingRepository implements ToolCallPreviewRepository {
  readonly upserts: UpsertToolCallPreviewInput[] = [];
  failWrites = false;

  async upsert(input: UpsertToolCallPreviewInput): Promise<void> {
    if (this.failWrites) throw new Error('preview write failed');
    this.upserts.push(structuredClone(input) as UpsertToolCallPreviewInput);
  }

  async listActiveByRun(): Promise<readonly ToolCallPreviewRecord[]> {
    return [];
  }

  async deleteForCall(): Promise<void> {}
}

function makePublisher(repository: ToolCallPreviewRepository, options: {
  readonly files?: Record<string, string>;
  readonly minFlushMs?: number;
  readonly now?: () => number;
  readonly ordinal?: number;
} = {}): ToolCallPreviewPublisher {
  const disk = new Map(Object.entries(options.files ?? {}));
  const readFile: PreviewFileReader = async (relativePath) => disk.get(relativePath) ?? null;
  return new ToolCallPreviewPublisher({
    repositories: { toolCallPreview: repository },
    sink: { workspaceId: 'w1', runId: 'r1', modelCallId: 'm1',
      ordinal: options.ordinal ?? 0 },
    toolName: 'apply_changeset',
    readFile,
    ...(options.minFlushMs === undefined ? {} : { minFlushMs: options.minFlushMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

/** 参数文本形如 {"items":[...]}；content 为「已解码」内容，这里按 JSON 原文转义。 */
function changeText(entries: readonly { path?: string; action?: string; content?: string }[]): string {
  const items = entries.map((entry) => '{' + Object.entries(entry).map(([key, value]) =>
    `${JSON.stringify(key)}:${JSON.stringify(value)}`).join(',') + '}').join(',');
  return `{"tool":"apply_changeset","items":[${items}]}`;
}

test('feed: CREATE 先给已收到内容的插入行数，闭合后标记完整（CD-09）', async () => {
  const repository = new RecordingRepository();
  const publisher = makePublisher(repository, { minFlushMs: 0 });
  // 半截 content：两行已到达，尾部未闭合（切掉结尾 "]} 让字符串停在内容里）。
  await publisher.feed(changeText([{ path: 'new.ts', action: 'CREATE', content: 'a\nb' }])
    .slice(0, -4));
  const partial = repository.upserts.at(-1);
  assert.equal(partial?.ordinal, 0);
  assert.equal(partial?.files.length, 1);
  assert.equal(partial?.files[0]?.path, 'new.ts');
  assert.equal(partial?.files[0]?.action, 'CREATE');
  assert.equal(partial?.files[0]?.added, 2);
  assert.equal(partial?.files[0]?.removed, 0);
  assert.equal(partial?.files[0]?.targetComplete, false);

  await publisher.feed(changeText([{ path: 'new.ts', action: 'CREATE', content: 'a\nb\nc' }]));
  const complete = repository.upserts.at(-1);
  assert.equal(complete?.files[0]?.added, 3);
  assert.equal(complete?.files[0]?.targetComplete, true);
});

test('feed: MODIFY 目标未收全时记待核对，收全后按磁盘现状算净增删（CD-11）', async () => {
  const repository = new RecordingRepository();
  const publisher = makePublisher(repository, { files: { 'edit.ts': 'a\nb\nc' }, minFlushMs: 0 });
  const full = changeText([{ path: 'edit.ts', action: 'MODIFY', content: 'a\nc' }]);
  await publisher.feed(full.slice(0, -4));
  assert.equal(repository.upserts.at(-1)?.files[0]?.added, -1);
  assert.equal(repository.upserts.at(-1)?.files[0]?.removed, -1);
  assert.equal(repository.upserts.at(-1)?.files[0]?.targetComplete, false);

  await publisher.feed(full);
  const settled = repository.upserts.at(-1)?.files[0];
  assert.equal(settled?.added, 0);
  assert.equal(settled?.removed, 1);
  assert.equal(settled?.targetComplete, true);
});

test('feed: 累计文本整份替换，重复喂入不累加行数', async () => {
  const repository = new RecordingRepository();
  const publisher = makePublisher(repository, { minFlushMs: 0 });
  const first = changeText([{ path: 'n.ts', action: 'CREATE', content: 'one' }]);
  await publisher.feed(first);
  await publisher.feed(first); // 同一份累计文本再来一次
  await publisher.feed(changeText([{ path: 'n.ts', action: 'CREATE', content: 'one\ntwo' }]));
  const latest = repository.upserts.at(-1);
  assert.equal(latest?.files[0]?.added, 2);
});

test('feed: 路径晚到的 item 不展示；DELETE 不猜行数', async () => {
  const repository = new RecordingRepository();
  const publisher = makePublisher(repository, { minFlushMs: 0 });
  await publisher.feed('{"items":[{"action":"CREATE","content":"z"}]}');
  assert.equal(repository.upserts.length, 0);

  await publisher.feed(changeText([{ path: 'gone.ts', action: 'DELETE' }]));
  const removed = repository.upserts.at(-1)?.files[0];
  assert.equal(removed?.action, 'DELETE');
  assert.equal(removed?.added, -1);
  assert.equal(removed?.removed, -1);
});

test('feed: 两个工具序号各自独立，交错不串缓冲（CD-10）', async () => {
  const repository = new RecordingRepository();
  const first = makePublisher(repository, { ordinal: 0, minFlushMs: 0 });
  const second = makePublisher(repository, { ordinal: 1, minFlushMs: 0 });
  await first.feed(changeText([{ path: 'a.ts', action: 'CREATE', content: 'a1' }]));
  await second.feed(changeText([{ path: 'b.ts', action: 'CREATE', content: 'b1\nb2' }]));
  await first.feed(changeText([{ path: 'a.ts', action: 'CREATE', content: 'a1\na2' }]));
  const rows = repository.upserts;
  const firstRow = rows.filter((row) => row.ordinal === 0).at(-1);
  const secondRow = rows.filter((row) => row.ordinal === 1).at(-1);
  assert.equal(firstRow?.files[0]?.path, 'a.ts');
  assert.equal(firstRow?.files[0]?.added, 2);
  assert.equal(secondRow?.files[0]?.path, 'b.ts');
  assert.equal(secondRow?.files[0]?.added, 2);
});

test('feed: 节流到期前不写库，flush 补齐最后一版', async () => {
  const repository = new RecordingRepository();
  // 初始时间不能是 0：发布器用 0 表示「尚未写过」。
  const clock = { now: 1_000 };
  const publisher = makePublisher(repository, { minFlushMs: 1_000, now: () => clock.now });
  await publisher.feed(changeText([{ path: 't.ts', action: 'CREATE', content: 'x' }]));
  assert.equal(repository.upserts.length, 1); // 首次立即写
  clock.now = 1_100;
  await publisher.feed(changeText([{ path: 't.ts', action: 'CREATE', content: 'x\ny' }]));
  assert.equal(repository.upserts.length, 1); // 节流内不写
  await publisher.flush();
  assert.equal(repository.upserts.length, 2);
  assert.equal(repository.upserts.at(-1)?.files[0]?.added, 2);
});

test('feed: 超长累计文本有界截断并标记 truncated', async () => {
  const repository = new RecordingRepository();
  const publisher = makePublisher(repository);
  const padding = 'p'.repeat(MAX_PREVIEW_TEXT_CHARS * 8 + 64);
  await publisher.feed(changeText([{ path: 'big.ts', action: 'CREATE', content: padding }]));
  const row = repository.upserts.at(-1);
  assert.equal(row?.truncated, true);
});

test('feed: 写库失败后停用预览，但不抛错也不污染后续模型调用', async () => {
  const repository = new RecordingRepository();
  repository.failWrites = true;
  const publisher = makePublisher(repository, { files: { 'x.ts': 'old' } });
  await publisher.feed(changeText([{ path: 'x.ts', action: 'MODIFY', content: 'new' }]));
  repository.failWrites = false;
  await publisher.feed(changeText([{ path: 'x.ts', action: 'MODIFY', content: 'newer' }]));
  await publisher.flush();
  assert.equal(repository.upserts.length, 0);
});
