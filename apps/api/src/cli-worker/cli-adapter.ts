import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import type { JsonObject } from '../infrastructure/json.js';
import { isProcessAlive, killProcessTree } from './process-tree.js';

export interface CliExecutionConfig {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string; // root resource path
  readonly timeoutMs?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
  readonly additionalEnv?: Record<string, string> | undefined;
}

export interface CliExecutionResult {
  readonly outcome: 'SUCCEEDED' | 'FAILED' | 'TIMEOUT' | 'CANCELLED';
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly durationMs: number;
  readonly pid?: number | undefined;
  readonly reason?: string | undefined;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024; // 4 MiB

const SAFE_SYSTEM_ENV_VARS = [
  'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'PATH', 'PATHEXT',
  'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'COMSPEC', 'NUMBER_OF_PROCESSORS', 'OS', 'PROCESSOR_ARCHITECTURE',
  'HOME', 'LANG', 'LC_ALL',
];

export function buildSafeEnvironment(additionalEnv?: Record<string, string>): NodeJS.ProcessEnv {
  const safeEnv: NodeJS.ProcessEnv = {};
  for (const key of SAFE_SYSTEM_ENV_VARS) {
    if (process.env[key] !== undefined) {
      safeEnv[key] = process.env[key];
    }
  }

  // Filter additional environment variables: explicitly deny sensitive keys
  if (additionalEnv) {
    for (const [k, v] of Object.entries(additionalEnv)) {
      const upper = k.toUpperCase();
      if (
        upper.includes('KEY') ||
        upper.includes('SECRET') ||
        upper.includes('TOKEN') ||
        upper.includes('PASSWORD') ||
        upper.startsWith('RELAY_') ||
        upper.startsWith('DATABASE_')
      ) {
        continue; // Disallow passing sensitive environment keys
      }
      safeEnv[k] = v;
    }
  }
  return safeEnv;
}

export async function executeCliCommand(
  config: CliExecutionConfig,
  signal?: AbortSignal,
): Promise<CliExecutionResult> {
  const canonicalCwd = await realpath(config.cwd);
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const startTime = Date.now();

  let truncated = false;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  const safeEnv = buildSafeEnvironment(config.additionalEnv);

  return new Promise<CliExecutionResult>((resolvePromise) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const child = spawn(config.executable, [...config.args], {
      cwd: canonicalCwd,
      env: safeEnv,
      shell: false, // Shell execution is strictly prohibited
      windowsHide: true,
    });

    const finish = (result: CliExecutionResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise(result);
    };

    if (child.pid === undefined) {
      finish({
        outcome: 'FAILED',
        exitCode: -1,
        stdout: '',
        stderr: 'Failed to spawn process',
        truncated: false,
        durationMs: Date.now() - startTime,
        reason: 'SPAWN_FAILED',
      });
      return;
    }

    timer = setTimeout(async () => {
      if (!settled && child.pid) {
        await killProcessTree(child.pid);
        finish({
          outcome: 'TIMEOUT',
          exitCode: null,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8') + '\n[Process timed out and killed]',
          truncated,
          durationMs: Date.now() - startTime,
          pid: child.pid,
          reason: 'GATEWAY_DEADLINE_EXCEEDED',
        });
      }
    }, timeoutMs);

    if (signal) {
      signal.addEventListener('abort', async () => {
        if (!settled && child.pid) {
          await killProcessTree(child.pid);
          finish({
            outcome: 'CANCELLED',
            exitCode: null,
            stdout: Buffer.concat(stdoutChunks).toString('utf8'),
            stderr: Buffer.concat(stderrChunks).toString('utf8') + '\n[Process cancelled via AbortSignal]',
            truncated,
            durationMs: Date.now() - startTime,
            pid: child.pid,
            reason: 'CONTROL_CANCELLED',
          });
        }
      });
    }

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutBytes < maxBytes) {
        const remaining = maxBytes - stdoutBytes;
        if (chunk.length > remaining) {
          stdoutChunks.push(chunk.subarray(0, remaining));
          stdoutBytes += remaining;
          truncated = true;
        } else {
          stdoutChunks.push(chunk);
          stdoutBytes += chunk.length;
        }
      } else {
        truncated = true;
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes < maxBytes) {
        const remaining = maxBytes - stderrBytes;
        if (chunk.length > remaining) {
          stderrChunks.push(chunk.subarray(0, remaining));
          stderrBytes += remaining;
          truncated = true;
        } else {
          stderrChunks.push(chunk);
          stderrBytes += chunk.length;
        }
      } else {
        truncated = true;
      }
    });

    child.on('error', (err) => {
      finish({
        outcome: 'FAILED',
        exitCode: -1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: err.message,
        truncated,
        durationMs: Date.now() - startTime,
        pid: child.pid,
        reason: 'CHILD_ERROR',
      });
    });

    child.on('close', (code) => {
      const durationMs = Date.now() - startTime;
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      const outcome = code === 0 ? 'SUCCEEDED' : 'FAILED';
      finish({
        outcome,
        exitCode: code,
        stdout,
        stderr,
        truncated,
        durationMs,
        pid: child.pid,
      });
    });
  });
}

export function reconcileCliExecution(pid?: number): {
  outcome: 'STOPPED' | 'STILL_RUNNING';
  details: JsonObject;
} {
  if (pid === undefined) {
    return { outcome: 'STOPPED', details: { reason: 'NO_PID_RECORDED' } };
  }
  const alive = isProcessAlive(pid);
  return {
    outcome: alive ? 'STILL_RUNNING' : 'STOPPED',
    details: { pid, alive, quarantined: alive },
  };
}
