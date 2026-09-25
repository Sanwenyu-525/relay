import { validateDatabaseUrl } from '../config/config.js';

/** 与 apps/api 主进程一致的退出码约定：2 = 配置/用法错误，1 = 运行失败。 */
export const CONFIG_FAILURE_EXIT_CODE = 2;
export const FAILURE_EXIT_CODE = 1;

export class CliConfigError extends Error {
  override readonly name = 'CliConfigError';
}

export function readRequiredEnvironment(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = env[name]?.trim();

  if (value === undefined || value === '') {
    throw new CliConfigError(`${name} is required`);
  }

  return value;
}

export function readOptionalEnvironment(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const value = env[name]?.trim();

  return value === undefined || value === '' ? undefined : value;
}

export function readRequiredDatabaseUrl(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = readRequiredEnvironment(env, name);
  const problem = validateDatabaseUrl(value);

  if (problem !== undefined) {
    throw new CliConfigError(`${name} ${problem}`);
  }

  return value;
}

export function readFlag(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);

  if (index === -1) {
    return undefined;
  }

  const value = argv[index + 1];

  if (value === undefined || value.startsWith('--')) {
    throw new CliConfigError(`${flag} requires a value`);
  }

  return value;
}

export function reportFailure(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);

  process.stderr.write(`${message}\n`);

  return error instanceof CliConfigError ? CONFIG_FAILURE_EXIT_CODE : FAILURE_EXIT_CODE;
}