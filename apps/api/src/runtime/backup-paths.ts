import { spawn } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';

const CODES = ['BACKUP_UNSAFE_ENTRY', 'BACKUP_ALTERNATE_STREAM', 'BACKUP_METADATA_UNAVAILABLE', 'BACKUP_INVALID_PATH'] as const;
export class BackupWindowsPathsError extends Error {
  override readonly name = 'BackupWindowsPathsError';
  readonly code: typeof CODES[number];
  constructor(code: typeof CODES[number] = 'BACKUP_METADATA_UNAVAILABLE') {
    const safe = CODES.includes(code) ? code : 'BACKUP_METADATA_UNAVAILABLE';
    super(safe);
    this.code = safe;
  }
}
function absoluteRoot(value: string): string {
  if (!isAbsolute(value) || !/^[a-z]:[\\/]/iu.test(value) || value.includes('\0') ||
      value.slice(3).split(/[\\/]/u).some((part) => part === '.' || part === '..' || part.includes(':'))) {
    throw new BackupWindowsPathsError('BACKUP_INVALID_PATH');
  }
  return resolve(value);
}
// Node does not expose arbitrary Windows reparse attributes or alternate streams.
// This fixed, hidden Windows metadata probe accepts JSON strings on stdin, never shell text.
// It supplies rejection checks, not a native handle isolation claim; trusted writers must be stopped.
const WINDOWS_METADATA_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false, $true)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RelayBackupMetadata {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct StreamData {
    public long Size;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 296)] public string Name;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr FindFirstStreamW(string path, int level, out StreamData data, int flags);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool FindNextStreamW(IntPtr handle, out StreamData data);
  [DllImport("kernel32.dll")] static extern bool FindClose(IntPtr handle);
  public static bool OnlyDefaultStream(string path) {
    StreamData data;
    IntPtr handle = FindFirstStreamW(path, 0, out data, 0);
    if (handle == new IntPtr(-1)) {
      int code = Marshal.GetLastWin32Error();
      if (code == 38) return true;
      throw new InvalidOperationException();
    }
    try {
      do { if (data.Name != "::$DATA") return false; }
      while (FindNextStreamW(handle, out data));
      if (Marshal.GetLastWin32Error() != 38) throw new InvalidOperationException();
      return true;
    } finally { FindClose(handle); }
  }
}
'@ | Out-Null
$count = 0
while ($null -ne ($line = [Console]::ReadLine())) {
  $path = ConvertFrom-Json -InputObject $line
  if ($path -isnot [string]) { exit 4 }
  $attributes = [System.IO.File]::GetAttributes($path)
  if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { exit 2 }
  if (-not [RelayBackupMetadata]::OnlyDefaultStream($path)) { exit 3 }
  $count++
}
[Console]::WriteLine('OK:' + $count)
`;

export async function assertBackupWindowsPaths(paths: readonly string[]): Promise<void> {
  if (process.platform !== 'win32') return;
  if (paths.length > 500_000 || paths.reduce((bytes, path) => bytes + Buffer.byteLength(path), 0) > 64 * 1024 * 1024) {
    throw new BackupWindowsPathsError('BACKUP_METADATA_UNAVAILABLE');
  }
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const executable = join(absoluteRoot(systemRoot), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['SystemRoot', 'WINDIR', 'SystemDrive', 'TEMP', 'TMP']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(WINDOWS_METADATA_SCRIPT, 'utf16le').toString('base64')],
  { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
  let output = '';
  let errorBytes = 0;
  let failed = false;
  const timeout = setTimeout(() => { failed = true; child.kill(); }, 60_000);
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
    if (output.length > 128) { failed = true; child.kill(); }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    errorBytes += chunk.length;
    if (errorBytes > 4096) { failed = true; child.kill(); }
  });
  child.stdin.on('error', () => { failed = true; });
  const closed = new Promise<number | null>((resolve) => {
    child.once('error', () => { failed = true; });
    child.once('close', (code) => { clearTimeout(timeout); resolve(code); });
  });
  // Streams keep metadata input bounded; paths are already bounded by the inventory.
  for (const path of paths) {
    if (failed || child.exitCode !== null) break;
    if (!child.stdin.write(`${JSON.stringify(path)}\n`)) {
      await new Promise<void>((resolve) => {
        const done = () => {
          child.stdin.off('drain', done); child.stdin.off('error', done); child.off('close', done); resolve();
        };
        child.stdin.once('drain', done); child.stdin.once('error', done); child.once('close', done);
      });
    }
  }
  child.stdin.end();
  const code = await closed;
  if (code === 2) throw new BackupWindowsPathsError('BACKUP_UNSAFE_ENTRY');
  if (code === 3) throw new BackupWindowsPathsError('BACKUP_ALTERNATE_STREAM');
  if (failed || code !== 0 || output.trim() !== `OK:${paths.length}`) throw new BackupWindowsPathsError('BACKUP_METADATA_UNAVAILABLE');
}
