import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import test, { after, before } from 'node:test';
import { pathToFileURL } from 'node:url';

import { probeRestoreRuntime, RestoreRuntimeProbeError } from '../../src/runtime/restore-runtime-probe.js';

let repository = resolve(process.cwd());
while (!existsSync(join(repository, 'test-release/api/node_modules'))) {
  if (repository === dirname(repository)) throw new Error('ordinary production dependency fixture is unavailable');
  repository = dirname(repository);
}
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
let temporary: string, packageRoot: string, resources: Record<string, string>, declarations: Record<string, string>;
const version = 'v24.21.0';
const refusal = (code?: string) => (cause: unknown) => cause instanceof RestoreRuntimeProbeError &&
  cause.message === cause.code && (code === undefined || cause.code === code);
function input(signal = new AbortController().signal) { return { packageRoot, resourceHashes: resources, nodeVersion: version, signal }; }

before(async () => {
  assert.equal(process.platform, 'win32');
  temporary = await mkdtemp(join(tmpdir(), 'relay-runtime-probe-'));
  packageRoot = join(temporary, '包-离线'); await mkdir(join(packageRoot, 'api'), { recursive: true });
  await copyFile(join(repository, '.research/runtime-cache/node-v24.21.0-win-x64/node.exe'), join(packageRoot, 'node.exe'));
  const current = JSON.parse(await readFile(join(repository, 'apps/api/package.json'), 'utf8')) as { dependencies: Record<string, string> };
  declarations = current.dependencies;
  assert.equal(Object.keys(declarations).length, 10);
  await writeFile(join(packageRoot, 'api/package.json'), JSON.stringify({ name: '@relay-agent/api', type: 'module', dependencies: declarations }));
  // This is the existing ordinary full production tree, never synthetic library exports.
  await cp(join(repository, 'test-release/api/node_modules'), join(packageRoot, 'api/node_modules'), { recursive: true, dereference: false });
  resources = {};
  async function inventory(directory: string): Promise<void> {
    for (const name of await readdir(directory)) {
      const path = join(directory, name), stat = await lstat(path);
      assert.equal(stat.isSymbolicLink(), false);
      if (stat.isDirectory()) await inventory(path);
      else {
        assert.ok(stat.isFile()); assert.equal(stat.nlink, 1);
        resources[relative(packageRoot, path).split(sep).join('/')] = sha(await readFile(path));
      }
    }
  }
  await inventory(packageRoot);
  for (const [name, expected] of Object.entries(declarations)) {
    const pkg = JSON.parse(await readFile(join(packageRoot, 'api/node_modules', name, 'package.json'), 'utf8')) as { name: string; version: string };
    assert.equal(pkg.name, name); assert.equal(pkg.version, expected);
  }
});
after(async () => {
  if (temporary !== undefined) {
    assert.ok(temporary.startsWith(join(tmpdir(), 'relay-runtime-probe-')));
    await rm(temporary, { recursive: true, force: true });
    assert.equal(existsSync(temporary), false);
  }
});

async function changed(ref: string, mutate: (bytes: Buffer) => Buffer, work: () => Promise<void>, bind = false): Promise<void> {
  const path = join(packageRoot, ref), original = await readFile(path), expected = resources[ref]!;
  const next = mutate(original); await writeFile(path, next); if (bind) resources[ref] = sha(next);
  try { await work(); }
  finally { await writeFile(path, original); resources[ref] = expected; }
}

test('real packaged production libraries have bound ESM entries and finite offline checks', async () => {
  const old = { NODE_OPTIONS: process.env.NODE_OPTIONS, PGPORT: process.env.PGPORT, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  process.env.NODE_OPTIONS = '--require=must-not-read-outside-package'; process.env.PGPORT = 'invalid';
  process.env.OPENAI_API_KEY = 'must-not-inherit-provider-secret';
  try {
    const report = await probeRestoreRuntime(input());
    assert.equal(report.format, 'relay-restore-runtime-probe-v1'); assert.equal(report.scope, 'PACKAGED_DEPENDENCIES_OFFLINE_ONLY');
    assert.equal(report.node_version, version); assert.equal(report.node_sha256, resources['node.exe']);
    assert.equal(report.package_metadata_sha256, resources['api/package.json']);
    assert.equal(report.direct_dependencies.length, 10); assert.ok(report.loaded_file_count > 1000);
    assert.match(report.loaded_files_canonical_sha256, /^[0-9a-f]{64}$/u);
    for (const dependency of report.direct_dependencies) {
      assert.equal(dependency.version, declarations[dependency.name]);
      assert.equal(dependency.entry_sha256, resources[dependency.entry_ref]);
      assert.equal(dependency.package_sha256, resources[dependency.package_ref]);
      assert.ok(dependency.entry_ref.startsWith(`api/node_modules/${dependency.name}/`));
    }
    // The official package has different import/require entries. This proves the import condition.
    assert.equal(report.direct_dependencies.find(item => item.name === 'pg-connection-string')?.entry_ref,
      'api/node_modules/pg-connection-string/esm/index.mjs');
    assert.ok(Object.values(report.checks).every(value => value === true));
    assert.equal(JSON.stringify(report).includes(temporary), false);
    assert.equal(JSON.stringify(report).includes('must-not-inherit-provider-secret'), false);
  } finally {
    for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('a direct package borrowed from ancestor node_modules is refused', async () => {
  const inside = join(packageRoot, 'api/node_modules/pg-connection-string'), outside = join(temporary, 'node_modules/pg-connection-string');
  await mkdir(dirname(outside), { recursive: true }); await rename(inside, outside);
  try { await assert.rejects(probeRestoreRuntime(input()), refusal()); }
  finally { await rename(outside, inside); }
});

test('a transitive CJS package borrowed from ancestor node_modules is refused', async () => {
  const inside = join(packageRoot, 'api/node_modules/pg-protocol'), outside = join(temporary, 'node_modules/pg-protocol');
  await mkdir(dirname(outside), { recursive: true }); await rename(inside, outside);
  try { await assert.rejects(probeRestoreRuntime(input()), refusal('RESTORE_PROBE_RESOLUTION_REJECTED')); }
  finally { await rename(outside, inside); }
});

test('missing direct metadata and an omitted resource binding are refused', async () => {
  const ref = 'api/node_modules/pg/package.json', path = join(packageRoot, ref), moved = join(temporary, 'pg-metadata');
  await rename(path, moved);
  try { await assert.rejects(probeRestoreRuntime(input()), refusal()); }
  finally { await rename(moved, path); }
  const expected = resources[ref]!; delete resources[ref];
  try { await assert.rejects(probeRestoreRuntime(input()), refusal('RESTORE_PROBE_DEPENDENCY_INVALID')); }
  finally { resources[ref] = expected; }
});

test('changed direct metadata is refused even when its new bytes are bound but version is incompatible', async () => {
  const ref = 'api/node_modules/pg/package.json';
  await changed(ref, bytes => Buffer.concat([bytes, Buffer.from(' ')]), async () => {
    await assert.rejects(probeRestoreRuntime(input()), refusal('RESTORE_PROBE_HASH_MISMATCH'));
  });
  await changed(ref, bytes => {
    const pkg = JSON.parse(bytes.toString('utf8')) as { version: string }; pkg.version = '0.0.0'; return Buffer.from(JSON.stringify(pkg));
  }, async () => { await assert.rejects(probeRestoreRuntime(input()), refusal('RESTORE_PROBE_DEPENDENCY_INVALID')); }, true);
});

test('actual ESM source tampering and a removed module resource binding are refused', async () => {
  const ref = 'api/node_modules/pg-connection-string/esm/index.mjs';
  await changed(ref, bytes => Buffer.concat([bytes, Buffer.from('\n// changed entry\n')]), async () => {
    await assert.rejects(probeRestoreRuntime(input()), refusal('RESTORE_PROBE_HASH_MISMATCH'));
  });
  const hash = resources[ref]!; delete resources[ref];
  try { await assert.rejects(probeRestoreRuntime(input()), refusal('RESTORE_PROBE_RESOLUTION_REJECTED')); }
  finally { resources[ref] = hash; }
});

test('range, missing, unknown, malformed and invalid UTF8 declarations are refused', async () => {
  for (const mode of ['range', 'missing', 'unknown']) {
    await changed('api/package.json', bytes => {
      const pkg = JSON.parse(bytes.toString('utf8')) as { dependencies: Record<string, string> };
      if (mode === 'range') pkg.dependencies.pg = '^' + pkg.dependencies.pg;
      if (mode === 'missing') delete pkg.dependencies.pg;
      if (mode === 'unknown') pkg.dependencies.unapproved = '1.0.0';
      return Buffer.from(JSON.stringify(pkg));
    }, async () => { await assert.rejects(probeRestoreRuntime(input()), refusal('RESTORE_PROBE_DEPENDENCY_INVALID')); }, true);
  }
  for (const bytes of [Buffer.from('{'), Buffer.from([0xff])]) await changed('api/package.json', () => bytes, async () => {
    await assert.rejects(probeRestoreRuntime(input()), refusal('RESTORE_PROBE_DEPENDENCY_INVALID'));
  }, true);
});

test('bound but unsupported library behavior and its secret exception never become a successful report', async () => {
  await changed('api/node_modules/pg-connection-string/esm/index.mjs', bytes => Buffer.concat([
    Buffer.from('throw new Error("fixture-secret-must-not-be-exposed");\n'), bytes]), async () => {
    await assert.rejects(probeRestoreRuntime(input()), refusal('RESTORE_PROBE_OFFLINE_CHECK_FAILED'));
  }, true);
});

test('the target Node hash/version and input budgets are enforced before success', async () => {
  const wrongHash = { ...resources, 'node.exe': '0'.repeat(64) };
  await assert.rejects(probeRestoreRuntime({ ...input(), resourceHashes: wrongHash }), refusal('RESTORE_PROBE_HASH_MISMATCH'));
  await assert.rejects(probeRestoreRuntime({ ...input(), nodeVersion: 'v24.0.0' }), refusal('RESTORE_PROBE_DEPENDENCY_INVALID'));
  await assert.rejects(probeRestoreRuntime({ ...input(), packageRoot: join(packageRoot, '../package') + '/../package' }), refusal('RESTORE_PROBE_INVALID_INPUT'));
  const many = Object.fromEntries(Array.from({ length: 100_001 }, (_value, index) => [`api/${index}`, '0'.repeat(64)]));
  await assert.rejects(probeRestoreRuntime({ ...input(), resourceHashes: many }), refusal('RESTORE_PROBE_INVALID_INPUT'));
  await assert.rejects(probeRestoreRuntime({ ...input(), resourceHashes: { ...resources, 'api/../bad': '0'.repeat(64) } }), refusal('RESTORE_PROBE_INVALID_INPUT'));
});

// Capture the actual owned target Node process, without replacing its behavior.
async function observed(work: (controller: AbortController, children: childProcess.ChildProcess[], closed: Set<childProcess.ChildProcess>) => Promise<void>,
  onTarget?: (child: childProcess.ChildProcess) => void) {
  const original = childProcess.spawn, children: childProcess.ChildProcess[] = [], closed = new Set<childProcess.ChildProcess>();
  const controller = new AbortController();
  const spy = test.mock.method(childProcess, 'spawn', ((...args: Parameters<typeof childProcess.spawn>) => {
    const child = original(...args);
    if (args[0] === join(packageRoot, 'node.exe')) { children.push(child); child.once('close', () => closed.add(child)); onTarget?.(child); }
    return child;
  }) as typeof childProcess.spawn);
  syncBuiltinESMExports();
  try { await work(controller, children, closed); }
  finally {
    spy.mock.restore(); syncBuiltinESMExports();
    for (const child of children) {
      if (!closed.has(child)) { child.kill(); await new Promise<void>(done => child.once('close', () => done())); }
    }
  }
}

test('pre-abort creates no target child, and live abort waits for its real close', async () => {
  await observed(async (controller, children, closed) => {
    controller.abort(); await assert.rejects(probeRestoreRuntime(input(controller.signal)), refusal('RESTORE_PROBE_ABORTED'));
    assert.equal(children.length, 0); assert.equal(closed.size, 0);
  });
  await changed('api/node_modules/pg-connection-string/esm/index.mjs', bytes => Buffer.concat([Buffer.from('while (true) {}\n'), bytes]), async () => {
    await observed(async (controller, children, closed) => {
      const timer = setInterval(() => { if (children.length) { clearInterval(timer); setTimeout(() => controller.abort(), 200); } }, 25);
      try {
        await assert.rejects(probeRestoreRuntime(input(controller.signal)), refusal('RESTORE_PROBE_ABORTED'));
        assert.equal(children.length, 1); assert.ok(closed.has(children[0]!));
        assert.ok(children[0]!.exitCode !== null || children[0]!.signalCode !== null);
      } finally { clearInterval(timer); }
    });
  }, true);
});

test('a real bound dependency cannot create an inherited-stdio grandchild or Worker', async () => {
  const ref = 'api/node_modules/pg-connection-string/esm/index.mjs', marker = join(temporary, 'forbidden-child-marker');
  const code = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'escaped');`;
  for (const prefix of [
    `import { spawn } from 'node:child_process'; const child = spawn(process.execPath, ['--eval', ${JSON.stringify(code)}], { stdio: 'inherit' }); await new Promise(done => child.once('close', done));\n`,
    `import { Worker } from 'node:worker_threads'; const child = new Worker(${JSON.stringify(code)}, { eval: true }); await new Promise(done => child.once('exit', done));\n`
  ]) await changed(ref, bytes => Buffer.concat([Buffer.from(prefix), bytes]), async () => {
    await observed(async (_controller, children, closed) => {
      await assert.rejects(probeRestoreRuntime(input()), refusal('RESTORE_PROBE_OFFLINE_CHECK_FAILED'));
      assert.equal(children.length, 1); assert.ok(closed.has(children[0]!)); assert.equal(existsSync(marker), false);
    });
  }, true);
});

test('bound dependency DNS callback, promises and Resolver requests are rejected synchronously', async () => {
  const ref = 'api/node_modules/pg-connection-string/esm/index.mjs';
  for (const prefix of [
    `import dns from 'node:dns'; dns.lookup('offline.invalid', () => {});\n`,
    `import dns from 'node:dns/promises'; await dns.lookup('offline.invalid');\n`,
    `import dns from 'node:dns'; const resolver = new dns.Resolver(); resolver.setServers(['127.0.0.1:1']); resolver.resolve4('offline.invalid', () => {});\n`,
    `import dns from 'node:dns/promises'; const resolver = new dns.Resolver(); resolver.setServers(['127.0.0.1:1']); await resolver.resolve4('offline.invalid');\n`
  ]) await changed(ref, bytes => Buffer.concat([Buffer.from(prefix), bytes]), async () => {
    await observed(async (_controller, children, closed) => {
      await assert.rejects(probeRestoreRuntime(input()), refusal('RESTORE_PROBE_OFFLINE_CHECK_FAILED'));
      assert.equal(children.length, 1); assert.ok(closed.has(children[0]!));
    });
  }, true);
});

test('actual target stdin accepts a Chinese root split inside UTF8 and rejects invalid UTF8', async () => {
  await observed(async (_controller, children, closed) => {
    const result = await probeRestoreRuntime(input());
    assert.equal(result.scope, 'PACKAGED_DEPENDENCIES_OFFLINE_ONLY'); assert.equal(children.length, 1); assert.ok(closed.has(children[0]!));
  }, child => {
    const stdin = child.stdin!, end = stdin.end.bind(stdin);
    test.mock.method(stdin, 'end', (payload: string) => {
      const bytes = Buffer.from(payload), position = bytes.indexOf(Buffer.from('包'));
      assert.ok(position >= 0); stdin.write(bytes.subarray(0, position + 1));
      setTimeout(() => end(bytes.subarray(position + 1)), 250); return stdin;
    });
  });
  await observed(async (_controller, children, closed) => {
    await assert.rejects(probeRestoreRuntime(input()), refusal('RESTORE_PROBE_CHILD_FAILED'));
    assert.equal(children.length, 1); assert.ok(closed.has(children[0]!));
  }, child => {
    const stdin = child.stdin!, end = stdin.end.bind(stdin);
    test.mock.method(stdin, 'end', () => { end(Buffer.from([0xff])); return stdin; });
  });
});

test('delayed dynamic imports stay guarded after reporting and cannot extend the sealed load set', async () => {
  const marker = join(temporary, 'forbidden-late-load-marker');
  const moduleBytes = Buffer.from(`import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'escaped'); export const value = 1;`);
  for (const path of [join(temporary, 'outside-probe.mjs'), join(packageRoot, 'api/late-probe.mjs')]) {
    await writeFile(path, moduleBytes);
    const ref = relative(packageRoot, path).split(sep).join('/');
    if (path.startsWith(packageRoot)) resources[ref] = sha(moduleBytes);
    // Schedule from the actual report write, so the counter cannot accidentally run before cleanup.
    const prefix = `const probeWrite = process.stdout.write.bind(process.stdout); process.stdout.write = (...args) => { const result = probeWrite(...args); setTimeout(() => import(${JSON.stringify(pathToFileURL(path).href)}), 2000); return result; };\n`;
    try {
      await changed('api/node_modules/pg-connection-string/esm/index.mjs', bytes => Buffer.concat([Buffer.from(prefix), bytes]), async () => {
        await observed(async (_controller, children, closed) => {
          await assert.rejects(probeRestoreRuntime(input()), refusal('RESTORE_PROBE_CHILD_FAILED'));
          assert.equal(children.length, 1); assert.ok(closed.has(children[0]!)); assert.equal(existsSync(marker), false);
        });
      }, true);
    } finally { delete resources[ref]; await rm(path); }
  }
});

test('over-budget child output is rejected only after the owned process closes', async () => {
  await changed('api/node_modules/pg-connection-string/esm/index.mjs', bytes => Buffer.concat([
    Buffer.from('process.stdout.write("x".repeat(70000)); await new Promise(() => {});\n'), bytes]), async () => {
    await observed(async (_controller, children, closed) => {
      await assert.rejects(probeRestoreRuntime(input()), refusal('RESTORE_PROBE_OUTPUT_LIMIT'));
      assert.equal(children.length, 1); assert.ok(closed.has(children[0]!));
    });
  }, true);
});

test('a genuinely hung target module reaches the finite child deadline and real close', { timeout: 90_000 }, async () => {
  await changed('api/node_modules/pg-connection-string/esm/index.mjs', bytes => Buffer.concat([Buffer.from('while (true) {}\n'), bytes]), async () => {
    await observed(async (_controller, children, closed) => {
      const started = Date.now();
      await assert.rejects(probeRestoreRuntime(input()), refusal('RESTORE_PROBE_TIMEOUT'));
      assert.ok(Date.now() - started >= 59_000); assert.equal(children.length, 1); assert.ok(closed.has(children[0]!));
    });
  }, true);
});
