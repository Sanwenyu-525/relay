import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  REQUIRED_CONTEXT_ESTIMATE,
  REQUIRED_CONTEXT_THRESHOLDS,
  assessReadRisk,
  assessRequiredContextFiles,
  resetRequiredContextScanCache,
  scanRequiredContextFiles,
  singleFileSeverity,
  totalFilesSeverity,
  type BudgetInput,
} from '../../src/application/required-context-files.js';

/**
 * 必读文件审计的判定与扫描行为（2026-10-30）。
 *
 * 覆盖验收场景 1–9 中不依赖数据库的部分：窗口已知/未知、有效预算取 min(窗口, 档位)、
 * 单文件与累计阈值、非必读资料不误报、文件被改/被删后更新、越界与链接异常安全失败。
 */

/** 与实现同一估算口径：UTF-8 字节 ÷ 3。 */
function bytesFor(tokens: number): number {
  return tokens * REQUIRED_CONTEXT_ESTIMATE.bytes_per_token;
}

function budget(overrides: Partial<BudgetInput> = {}): BudgetInput {
  return { providerWindow: 256_000, callBudget: 256_000,
    callBudgetSource: 'WORKSPACE_TIER', outputReserve: 8_192, ...overrides };
}

function file(path: string, tokens: number) {
  return { path, category: 'AUTO_INJECTED' as const, scope: 'ROOT' as const,
    reason: '测试入口', bytes: bytesFor(tokens), mtimeMs: 1_700_000_000_000 };
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'relay-required-context-'));
  try { await run(root); }
  finally {
    resetRequiredContextScanCache();
    await rm(root, { recursive: true, force: true });
  }
}

test('256K 窗口 + 必读文件 180K tokens：判为严重并说明占比', () => {
  const assessed = assessRequiredContextFiles([file('AGENTS.md', 180_000)], budget());
  assert.equal(assessed.severity, 'SEVERE');
  assert.equal(assessed.budget.confidence, 'EXACT_WINDOW');
  assert.equal(assessed.budget.effective_basis, 'PROVIDER_WINDOW');
  assert.ok(assessed.budget.provider_window_known);
  // 有效输入预算 = 256000 − (8192 输出 + 系统提示 + 4096 工具)，必读占比远高于 50%。
  assert.ok(assessed.files[0]!.share !== null && assessed.files[0]!.share > 0.7);
  assert.ok(assessed.reasons.some((reason) => reason.code === 'SINGLE_FILE_SEVERE'));
  assert.ok(assessed.suggestions.some((suggestion) => suggestion.code === 'SPLIT_ENTRY'));
});

test('256K 窗口 + 普通 5K tokens 文件：不提醒、不给建议', () => {
  const assessed = assessRequiredContextFiles([file('AGENTS.md', 5_000)], budget());
  assert.equal(assessed.severity, 'NONE');
  assert.deepEqual(assessed.reasons, []);
  assert.deepEqual(assessed.suggestions, []);
});

test('单文件都不足 15% 但累计超阈值：按累计规则提醒', () => {
  const assessed = assessRequiredContextFiles([
    file('AGENTS.md', 30_000), file('docs/rules.md', 30_000), file('docs/style.md', 30_000),
  ], budget());
  assert.ok(assessed.files.every((entry) => singleFileSeverity(entry.share!) === 'NONE'));
  assert.equal(totalFilesSeverity(assessed.budget.required_total_share!), 'NOTICE');
  assert.equal(assessed.severity, 'NOTICE');
  assert.ok(assessed.reasons.some((reason) => reason.code === 'TOTAL_FILES_NOTICE'));
});

test('工作区选 512K 但 Provider 只支持 256K：按有效预算预警', () => {
  const assessed = assessRequiredContextFiles([file('AGENTS.md', 180_000)],
    budget({ callBudget: 512_000 }));
  assert.equal(assessed.severity, 'SEVERE');
  assert.equal(assessed.budget.effective_basis, 'PROVIDER_WINDOW');
  assert.ok(assessed.budget.effective_input_tokens! < 256_000);
  // 档位高于窗口时附带「调回档位」建议，但不改任何配置。
  assert.ok(assessed.suggestions.some((suggestion) => suggestion.code === 'TRIM_WINDOW'));
});

test('模型窗口未知：标记估算限制，不冒充精确读数', () => {
  const assessed = assessRequiredContextFiles([file('AGENTS.md', 20_000)],
    budget({ providerWindow: null, callBudget: 128_000 }));
  assert.equal(assessed.budget.provider_window_tokens, null);
  assert.equal(assessed.budget.provider_window_known, false);
  assert.equal(assessed.budget.confidence, 'WINDOW_UNKNOWN');
  assert.equal(assessed.budget.effective_basis, 'CALL_BUDGET');
  assert.ok(assessed.reasons.some((reason) => reason.code === 'WINDOW_UNKNOWN'));
  assert.doesNotMatch(JSON.stringify(assessed.reasons.at(-1)), /无限/u);
});

test('有效预算被预留吃光：不给占比、不给假警报', () => {
  const assessed = assessRequiredContextFiles([file('AGENTS.md', 10_000)],
    budget({ providerWindow: null, callBudget: 1_000, outputReserve: 8_192 }));
  assert.equal(assessed.budget.effective_input_tokens, null);
  assert.equal(assessed.budget.confidence, 'UNAVAILABLE');
  assert.equal(assessed.budget.required_total_share, null);
  assert.equal(assessed.severity, 'NONE');
  assert.ok(assessed.reasons.some((reason) => reason.code === 'BUDGET_UNAVAILABLE'));
});

test('总输入超过可用预算：即使单文件比例不高也判严重', () => {
  const assessed = assessRequiredContextFiles([file('AGENTS.md', 40_000)],
    budget({ providerWindow: 40_000, callBudget: 40_000, outputReserve: 8_192 }));
  assert.equal(assessed.severity, 'SEVERE');
  assert.ok(assessed.reasons.some((reason) => reason.code === 'TOTAL_EXCEEDS_BUDGET'));
});

test('阈值集中在一处且与 UI 无关：只暴露数字与顺序', () => {
  assert.deepEqual(REQUIRED_CONTEXT_THRESHOLDS.single_file,
    { notice: 0.15, high: 0.30, severe: 0.50 });
  assert.deepEqual(REQUIRED_CONTEXT_THRESHOLDS.total_files,
    { notice: 0.30, high: 0.50, severe: 0.75 });
  assert.equal(singleFileSeverity(0.1499), 'NONE');
  assert.equal(singleFileSeverity(0.15), 'NOTICE');
  assert.equal(singleFileSeverity(0.30), 'HIGH');
  assert.equal(singleFileSeverity(0.50), 'SEVERE');
  assert.equal(totalFilesSeverity(0.75), 'SEVERE');
});

test('读取前的风险判断与预发送审计是同一套阈值', () => {
  const small = assessReadRisk({ bytes: bytesFor(5_000), effectiveInputTokens: 250_000 });
  assert.equal(small.severity, 'NONE');
  assert.equal(small.tokens, 5_000);
  const large = assessReadRisk({ bytes: bytesFor(180_000), effectiveInputTokens: 250_000 });
  assert.equal(large.severity, 'SEVERE');
  // 分母不可用时不判风险、不给比例：null 与 0% 是两件事。
  const unknown = assessReadRisk({ bytes: bytesFor(180_000), effectiveInputTokens: null });
  assert.equal(unknown.severity, 'NONE');
  assert.equal(unknown.ratio, null);
});

test('扫描只认规则入口：目录里的普通大文档不会被当成自动加载', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'AGENTS.md'), 'a'.repeat(300));
    await writeFile(join(root, 'huge-notes.md'), 'b'.repeat(50_000));
    await mkdir(join(root, 'docs'));
    await writeFile(join(root, 'docs', 'AGENTS.md'), 'c'.repeat(120));
    const scanned = await scanRequiredContextFiles({ root, agent: 'relay', refresh: true });
    const paths = scanned.files.map((entry) => entry.path).sort();
    assert.deepEqual(paths, ['AGENTS.md', 'docs/AGENTS.md']);
    assert.ok(!paths.includes('huge-notes.md'));
    assert.equal(scanned.files.find((entry) => entry.path === 'docs/AGENTS.md')?.scope, 'NESTED');
  });
});

test('不同 Agent 的规则入口不同：同一目录换 Agent 得到不同清单', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'AGENTS.md'), 'a'.repeat(300));
    await writeFile(join(root, 'CLAUDE.md'), 'd'.repeat(90));
    const relay = await scanRequiredContextFiles({ root, agent: 'relay', refresh: true });
    const claude = await scanRequiredContextFiles({ root, agent: 'claude', refresh: true });
    assert.deepEqual(relay.files.map((entry) => entry.path), ['AGENTS.md']);
    assert.deepEqual(claude.files.map((entry) => entry.path), ['CLAUDE.md']);
    assert.equal(claude.files[0]!.category, 'AUTO_INJECTED');
  });
});

test('项目显式声明的必读文档才计入；非法条目只记 skipped', async () => {
  await withRoot(async (root) => {
    await mkdir(join(root, '.relay'));
    await writeFile(join(root, 'guide.md'), 'x'.repeat(600));
    await writeFile(join(root, '.relay', 'context-required.json'), JSON.stringify({
      required_documents: [
        { path: 'guide.md', category: 'TASK_REQUIRED', reason: '每次开工都读' },
        { path: 'missing.md', category: 'TASK_REQUIRED' },
        { path: 'bad.md', category: 'WHATEVER' },
      ],
    }));
    const scanned = await scanRequiredContextFiles({ root, agent: 'relay', refresh: true });
    assert.deepEqual(scanned.files.map((entry) => entry.path), ['guide.md']);
    assert.equal(scanned.files[0]!.scope, 'DECLARED');
    assert.match(scanned.files[0]!.reason, /每次开工都读/u);
    assert.ok(scanned.skipped.some((entry) => entry.path === 'bad.md'));
  });
});

test('文件在扫描后被改、被删：下一次扫描读数跟着变', async () => {
  await withRoot(async (root) => {
    const target = join(root, 'AGENTS.md');
    await writeFile(target, 'a'.repeat(300));
    const first = await scanRequiredContextFiles({ root, agent: 'relay' });
    assert.equal(first.files[0]!.bytes, 300);
    await writeFile(target, 'a'.repeat(9_000));
    const second = await scanRequiredContextFiles({ root, agent: 'relay' });
    assert.equal(second.files[0]!.bytes, 9_000);
    assert.ok(second.files[0]!.mtimeMs >= first.files[0]!.mtimeMs);
    await rm(target);
    const third = await scanRequiredContextFiles({ root, agent: 'relay' });
    assert.deepEqual(third.files, []);
  });
});

test('越界路径与指向根外的符号链接：安全失败并给出原因', async () => {
  await withRoot(async (root) => {
    const outside = await mkdtemp(join(tmpdir(), 'relay-outside-'));
    try {
      await writeFile(join(outside, 'secret.md'), 'x'.repeat(1_000));
      // 声明文件想借绝对路径与 `..` 越界：两条都必须被拒。
      await mkdir(join(root, '.relay'));
      await writeFile(join(root, '.relay', 'context-required.json'), JSON.stringify({
        required_documents: [
          { path: join(outside, 'secret.md'), category: 'AUTO_INJECTED' },
          { path: '../escape.md', category: 'AUTO_INJECTED' },
        ],
      }));
      // 根内指向根外的链接：不得读入，只记 skipped。
      try {
        await symlink(join(outside, 'secret.md'), join(root, 'AGENTS.md'));
      } catch { /* Windows 无权限建链接时跳过这一条，其余断言仍然成立。 */ }
      const scanned = await scanRequiredContextFiles({ root, agent: 'relay', refresh: true });
      assert.ok(!scanned.files.some((entry) => entry.path.includes('secret')));
      assert.ok(!scanned.files.some((entry) => entry.path.includes('..')));
      assert.ok(scanned.skipped.every((entry) => typeof entry.reason === 'string'));
    } finally { await rm(outside, { recursive: true, force: true }); }
  });
});

test('父目录是指向根外的链接：声明文件不得被读入（父链接 / Junction 越界）', async () => {
  await withRoot(async (root) => {
    const outside = await mkdtemp(join(tmpdir(), 'relay-outside-'));
    try {
      await writeFile(join(outside, 'context-required.json'), JSON.stringify({
        required_documents: [{ path: 'secret-outside.md', category: 'AUTO_INJECTED' }],
      }));
      await writeFile(join(outside, 'secret-outside.md'), 'x'.repeat(4_000));
      // .relay 本身是指向根外的目录链接：父目录这层以前不查，读声明文件就等于越界读。
      try { await symlink(outside, join(root, '.relay'), 'junction'); }
      catch { return; }
      const scanned = await scanRequiredContextFiles({ root, agent: 'relay', refresh: true });
      assert.ok(!scanned.files.some((entry) => entry.path.includes('secret-outside')));
      // 不是静默踉过：链接目录不得被当成「扫过了没危险」。
      assert.deepEqual(scanned.files, []);
    } finally { await rm(outside, { recursive: true, force: true }); }
  });
});

test('声明文件自身是根外链接：不读，并留下可解释的原因', async () => {
  await withRoot(async (root) => {
    const outside = await mkdtemp(join(tmpdir(), 'relay-outside-'));
    try {
      await mkdir(join(root, '.relay'));
      await writeFile(join(outside, 'context-required.json'), JSON.stringify({
        required_documents: [{ path: 'hidden.md', category: 'AUTO_INJECTED' }],
      }));
      await writeFile(join(outside, 'hidden.md'), 'y'.repeat(2_000));
      try { await symlink(join(outside, 'context-required.json'),
        join(root, '.relay', 'context-required.json'), 'file'); }
      catch { return; }
      const scanned = await scanRequiredContextFiles({ root, agent: 'relay', refresh: true });
      assert.ok(!scanned.files.some((entry) => entry.path.includes('hidden')));
      assert.ok(scanned.skipped.every((entry) => entry.reason.length > 0));
    } finally { await rm(outside, { recursive: true, force: true }); }
  });
});