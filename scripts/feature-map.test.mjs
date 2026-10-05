import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { collectMap, parseAcceptance, parseStages, sourceFile, startServer, renderPage } from './feature-map.mjs';

const acceptancePath = 'docs/testing/overall-acceptance-2026-09-28.md';
const catalogPath = 'docs/feature-map/catalog.json';
const acceptance = '# 验收\n## 当前功能验收表\n| 功能 | 结论 | 已验证范围与依据 | 剩余项 |\n|---|---|---|---|\n| 功能 A | 已通过（有限范围）；真实模型未验收 | `A | B` 与转义 A \\| B | Windows 待验 |\n\n| 功能 B | 未通过 | 四项反例失败 | 需复验 |\n| 功能 C | 已通过 | 源列一 | 源列二 | 最后范围 |\n## 历史验收记录\n| 历史 | 已通过 | 旧基准 | 无 |';
const progress = '## N 阶段当前状态\n| 包 | 状态 | 当前范围与剩余出口 |\n|---|---|---|\n| N04 周期计划 | 未进入 | 待协议 |\n## 当前改造模块状态\n| 模块 | 状态 | 当前范围与剩余出口 |\n|---|---|---|\n| M04：模型 | IN_PROGRESS | Windows 待验 |';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-feature-map-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function write(name, value) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), value);
  }
  const catalog = { version: 1, modules: [{ id: 'model', name: '模型', description: '测试目录', stageIds: ['M04'], features: [
    { id: 'model-call', name: '模型调用', description: '受控调用', intent: 'current', code: ['apps/api/src/model.ts'], docs: [acceptancePath],
      prompts: ['prompts/model.md'], tests: [], acceptance: ['功能 A'] },
    { id: 'model-next', name: '后续协议', description: '等待输入', intent: 'planned', code: [], docs: [], prompts: [], tests: [], acceptance: [] },
  ] }] };
  write(catalogPath, JSON.stringify(catalog)); write(acceptancePath, acceptance); write('CODEX_NEXT_STEP.md', progress);
  write('docs/frontend/design-tokens.json', JSON.stringify({ tokens: { 'color.bg.canvas': { $value: '#fff' } } }));
  write('apps/api/src/model.ts', 'export const model = 1;'); write('prompts/model.md', '# 模型输入');
  return { root, write, catalog };
}

test('读取整个当前H2区域，保留空行后记录、复合结论和异常列，不继承历史表', () => {
  const rows = parseAcceptance(acceptance);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].kind, 'partial');
  assert.match(rows[0].evidence, /A \| B/);
  assert.equal(rows[1].kind, 'failed');
  assert.equal(rows[2].remaining, '源列二 | 最后范围');
  assert.match(rows[2].sourceWarning, /列数/);
  assert.equal(rows[0].line, 5);
});

test('验收标题消失或必要列不完整时拒绝猜测；阶段状态直接保留原文', () => {
  assert.throws(() => parseAcceptance('## 历史\n| A | 通过 |'), /未找到/);
  assert.throws(() => parseAcceptance(acceptance.replace('| 功能 B | 未通过 | 四项反例失败 | 需复验 |', '| 功能 B | 未通过 |')), /格式变化/);
  assert.equal(parseStages(progress).find((stage) => stage.id === 'M04').status, 'IN_PROGRESS');
});

test('快照分开保留代码关联、规划和验收；不会把代码存在当成通过', (t) => {
  const { root } = fixture(t);
  const map = collectMap(root);
  assert.equal(map.summary.features, 2);
  assert.equal(map.modules[0].features[0].code[0].exists, true);
  assert.equal(map.modules[0].features[0].acceptance[0].kind, 'partial');
  assert.equal(map.modules[0].features[1].intent, 'planned');
  assert.equal(map.modules[0].features[1].acceptance.length, 0);
  assert.deepEqual(map.diagnostics, []);
});

test('新增资料出现在未归类列表；关联源码变动、更改验收原文会改变revision', (t) => {
  const { root, write } = fixture(t);
  const before = collectMap(root);
  write('apps/api/src/new-tool.ts', 'export const tool = true;');
  const next = collectMap(root);
  assert.notEqual(before.revision, next.revision);
  assert.equal(next.resources.find((file) => file.path.endsWith('new-tool.ts')).owners.length, 0);
  write(acceptancePath, acceptance.replace('功能 B | 未通过', '功能 B | 部分通过'));
  const updated = collectMap(root);
  assert.notEqual(next.revision, updated.revision);
  assert.equal(updated.acceptance[1].conclusion, '部分通过');
});

test('删除文件与验收关联失效、重复功能ID都报出，不静默遗漏', (t) => {
  const { root, write, catalog } = fixture(t);
  fs.unlinkSync(path.join(root, 'apps/api/src/model.ts'));
  catalog.modules[0].features[0].acceptance = ['不存在的源行'];
  catalog.modules[0].features[1].id = 'model-call';
  write(catalogPath, JSON.stringify(catalog));
  const map = collectMap(root);
  assert.equal(map.modules[0].features[0].code[0].exists, false);
  assert.ok(map.diagnostics.some((message) => message.includes('资料缺失')));
  assert.ok(map.diagnostics.some((message) => message.includes('关联失效')));
  assert.ok(map.diagnostics.some((message) => message.includes('重复')));
});

test('资料路径拒绝越界、环境文件及目录；扫描不索引构建输出和验收原始材料', (t) => {
  const { root, write } = fixture(t);
  write('.env', 'do-not-read'); write('docs/evidence/raw.json', '{}'); write('apps/api/src/dist/generated.js', '1');
  for (const name of ['../README.md', '.env', 'docs/../README.md', 'apps/api/src']) assert.throws(() => sourceFile(root, name));
  const map = collectMap(root);
  assert.equal(map.resources.some((file) => /raw.json|generated.js|\.env/.test(file.path)), false);
});

test('离线页面内嵌完整数据，恶意名称不能提前结束script，设计值来自唯一token源', (t) => {
  const { root, write, catalog } = fixture(t);
  catalog.modules[0].features[0].name = '</script><script>alert(1)</script>';
  write(catalogPath, JSON.stringify(catalog));
  const html = renderPage(collectMap(root));
  assert.ok(html.includes('window.FEATURE_MAP'));
  assert.ok(html.includes('\\u003c/script>'));
  assert.equal(html.includes('</script><script>alert(1)</script>'), false);
  assert.ok(html.includes('--relay-color-bg-canvas:#fff'));
});

test('实时HTTP按请求重扫并保留失败前快照、资料只读白名单、Host/Origin检查', async (t) => {
  const { root, write } = fixture(t);
  const live = await startServer({ root, port: 0 });
  t.after(() => new Promise((resolve) => live.server.close(resolve)));
  let response = await fetch(`${live.url}/api/map`);
  assert.equal(response.status, 200);
  const before = await response.json();
  write('apps/api/src/new-feature.ts', 'export const feature = 1;'); live.refresh();
  const updated = await (await fetch(`${live.url}/api/map`)).json();
  assert.notEqual(updated.revision, before.revision);
  write('apps/api/src/second-feature.ts', 'export const second = 1;');
  const onDemand = await (await fetch(`${live.url}/api/map`)).json();
  assert.notEqual(onDemand.revision, updated.revision);
  write(catalogPath, '{invalid'); live.refresh();
  const stale = await (await fetch(`${live.url}/api/map`)).json();
  assert.equal(stale.revision, onDemand.revision); assert.ok(stale.scanError);
  write(catalogPath, JSON.stringify(fixtureCatalog())); live.refresh();
  assert.equal((await (await fetch(`${live.url}/api/map`)).json()).scanError, null);
  response = await fetch(`${live.url}/source?path=apps%2Fapi%2Fsrc%2Fmodel.ts`);
  assert.equal(response.status, 200); assert.ok((await response.text()).includes('export const model'));
  assert.equal((await fetch(`${live.url}/source?path=..%2F.env`)).status, 404);
  assert.equal((await fetch(`${live.url}/api/map`, { headers: { Origin: 'https://example.com' } })).status, 403);
  const wrongHost = await new Promise((resolve, reject) => {
    const request = http.get(`${live.url}/api/map`, { headers: { Host: 'example.com' } }, (reply) => { reply.resume(); resolve(reply.statusCode); });
    request.on('error', reject);
  });
  assert.equal(wrongHost, 403);
  assert.equal((await fetch(`${live.url}/api/map`, { method: 'POST' })).status, 405);
});

function fixtureCatalog() {
  return { version: 1, modules: [{ id: 'model', name: '模型', description: '', stageIds: ['M04'], features: [
    { id: 'model-call', name: '模型调用', description: '', intent: 'current', code: ['apps/api/src/model.ts'], docs: [], prompts: [], tests: [], acceptance: ['功能 A'] },
  ] }] };
}
