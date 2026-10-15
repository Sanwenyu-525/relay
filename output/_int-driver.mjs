// 集成复验驱动：从 Bash 调用（PowerShell 工具在本会话不回传 native stdout）。
// 它**原样**调用官方 runner，只负责把子进程 stdout/stderr 实时落盘，便于边跑边看。
// 不使用管道等待 EOF：postgres 会继承 runner 的 stdout 写句柄，等待 EOF 会永久挂住。
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';

const root = 'D:\\Develop\\Relay-Agent';
const runner = `${root}\\apps\\api\\scripts\\run-integration.ps1`;
const powershell = `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

const testFile = process.argv[2] ?? '';
const logPath = process.argv[3] ?? `${root}\\output\\_int-run.log`;

writeFileSync(logPath, `# driver start ${new Date().toISOString()} testFile=${testFile}\n`, 'utf8');

const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', runner,
  '-UseCLocale', '-SkipBuild'];
if (testFile !== '') args.push('-TestFile', testFile);

const child = spawn(powershell, args, {
  cwd: root,
  env: { ...process.env,
    RELAY_FILE_IO_HELPER: `${root}\\apps\\file-io-helper\\target\\x86_64-pc-windows-msvc\\debug\\relay-file-io-helper.exe` },
  windowsHide: true,
});

const write = (chunk) => { try { appendFileSync(logPath, chunk, 'utf8'); } catch { /* ignore */ } };
child.stdout.on('data', (d) => write(d.toString('utf8')));
child.stderr.on('data', (d) => write(`[stderr] ${d.toString('utf8')}`));

child.on('exit', (code) => {
  write(`\n# driver exit code=${code} at ${new Date().toISOString()}\n`);
  // postgres 可能仍持有 stdout 写句柄：不让事件循环等它，直接结束驱动进程。
  try { child.stdout.destroy(); child.stderr.destroy(); } catch { /* ignore */ }
  process.stdout.write(`driver finished code=${code} log=${logPath}\n`);
  process.exit(code ?? 0);
});
child.on('error', (error) => {
  write(`\n# driver spawn error: ${error.message}\n`);
  process.stdout.write(`driver spawn error: ${error.message}\n`);
  process.exit(97);
});
