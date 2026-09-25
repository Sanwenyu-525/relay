import { statSync } from 'node:fs';
import { dirname, isAbsolute, parse, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface ApiConfig {
  readonly bindHost: string;
  readonly port: number;
  readonly allowedOrigins: readonly string[];
  readonly bearerToken: string;
  readonly databaseUrl: string;
  readonly databasePoolMax: number;
  readonly databaseConnectTimeoutMs: number;
  readonly dataRoot: string;
  readonly logLevel: LogLevel;
  readonly stopOnStdinEof: boolean;
  readonly desktopMode?: boolean;
}

const LOOPBACK_BIND_HOSTS: readonly string[] = ['127.0.0.1', '::1'];
const LOOPBACK_ORIGIN_HOSTS: readonly string[] = ['127.0.0.1', '::1', 'localhost'];
const LOG_LEVELS: readonly LogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];
const MINIMUM_BEARER_TOKEN_LENGTH = 32;
const PLACEHOLDER_TOKEN_PREFIX = /^(replace|change|example|placeholder|your)/iu;

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`invalid configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export function findRepositoryRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

export function validateOrigin(value: string): string | undefined {
  if (value === 'null') {
    return 'must not be the null origin';
  }

  if (value.includes('*')) {
    return 'must not contain a wildcard';
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return 'must be an absolute origin such as http://127.0.0.1:5173';
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'must use http or https';
  }

  if (parsed.username !== '' || parsed.password !== '') {
    return 'must not contain credentials';
  }

  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    return 'must not contain a path, query or fragment';
  }

  if (!LOOPBACK_ORIGIN_HOSTS.includes(parsed.hostname)) {
    return 'must point at a loopback host';
  }

  if (parsed.origin !== value) {
    return `must be written in normalized form (expected ${parsed.origin})`;
  }

  return undefined;
}

export function validateDatabaseUrl(value: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return 'must be a PostgreSQL connection URL';
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    return 'must use the postgres or postgresql scheme';
  }

  if (parsed.hostname === '') {
    return 'must include a host';
  }

  return undefined;
}

export function validateDataRoot(value: string, repositoryRoot: string): string | undefined {
  if (value.startsWith('\\\\') || value.startsWith('//')) {
    return 'must not be a UNC or network path';
  }

  if (!isAbsolute(value)) {
    return 'must be an absolute path';
  }

  const resolvedValue = resolve(value);

  if (parse(resolvedValue).root === resolvedValue) {
    return 'must not be a filesystem root';
  }

  const resolvedRepositoryRoot = resolve(repositoryRoot);
  const relativeToRepository = relative(resolvedRepositoryRoot, resolvedValue);

  if (
    relativeToRepository === ''
    || (!relativeToRepository.startsWith('..') && !isAbsolute(relativeToRepository))
  ) {
    return 'must be outside the source repository';
  }

  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(resolvedValue);
  } catch {
    return 'must be an existing directory';
  }

  if (!stats.isDirectory()) {
    return 'must be an existing directory';
  }

  return undefined;
}

function readRequired(
  env: Record<string, string | undefined>,
  name: string,
  issues: string[],
): string | undefined {
  const raw = env[name];

  if (typeof raw !== 'string' || raw.trim() === '') {
    issues.push(`${name} is required`);
    return undefined;
  }

  return raw.trim();
}

function readInteger(
  env: Record<string, string | undefined>,
  name: string,
  minimum: number,
  maximum: number,
  issues: string[],
): number | undefined {
  const raw = readRequired(env, name, issues);

  if (raw === undefined) {
    return undefined;
  }

  if (!/^\d+$/u.test(raw)) {
    issues.push(`${name} must be an integer between ${minimum} and ${maximum}`);
    return undefined;
  }

  const value = Number.parseInt(raw, 10);

  if (value < minimum || value > maximum) {
    issues.push(`${name} must be an integer between ${minimum} and ${maximum}`);
    return undefined;
  }

  return value;
}

function readBoolean(
  env: Record<string, string | undefined>,
  name: string,
  issues: string[],
): boolean | undefined {
  const raw = readRequired(env, name, issues);

  if (raw === undefined) {
    return undefined;
  }

  if (raw !== 'true' && raw !== 'false') {
    issues.push(`${name} must be true or false`);
    return undefined;
  }

  return raw === 'true';
}

interface PendingConfig {
  bindHost: string | undefined;
  port: number | undefined;
  allowedOrigins: readonly string[] | undefined;
  bearerToken: string | undefined;
  databaseUrl: string | undefined;
  databasePoolMax: number | undefined;
  databaseConnectTimeoutMs: number | undefined;
  dataRoot: string | undefined;
  logLevel: LogLevel | undefined;
  stopOnStdinEof: boolean | undefined;
}

type ValidatedConfig = { readonly [Key in keyof PendingConfig]: NonNullable<PendingConfig[Key]> };

export function loadConfig(
  env: Record<string, string | undefined>,
  repositoryRoot: string,
  options: { readonly desktop?: boolean } = {},
): ApiConfig {
  const issues: string[] = [];

  const config: PendingConfig = {
    bindHost: undefined,
    port: undefined,
    allowedOrigins: undefined,
    bearerToken: undefined,
    databaseUrl: undefined,
    databasePoolMax: undefined,
    databaseConnectTimeoutMs: undefined,
    dataRoot: undefined,
    logLevel: undefined,
    stopOnStdinEof: undefined,
  };

  const bindHost = readRequired(env, 'RELAY_API_BIND_HOST', issues);
  if (bindHost !== undefined) {
    if (LOOPBACK_BIND_HOSTS.includes(bindHost)) {
      config.bindHost = bindHost;
    } else {
      issues.push('RELAY_API_BIND_HOST must be a loopback address (127.0.0.1 or ::1)');
    }
  }

  config.port = readInteger(env, 'RELAY_API_PORT', options.desktop ? 0 : 1024, 65535, issues);

  const origins = readRequired(env, 'RELAY_API_ALLOWED_ORIGINS', issues);
  if (origins !== undefined) {
    const entries = origins
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');

    if (entries.length === 0) {
      issues.push('RELAY_API_ALLOWED_ORIGINS must list at least one explicit origin');
    }

    const accepted: string[] = [];
    for (const entry of entries) {
      const problem = options.desktop && entry === 'http://tauri.localhost'
        ? undefined
        : validateOrigin(entry);

      if (problem === undefined) {
        accepted.push(entry);
      } else {
        issues.push(`RELAY_API_ALLOWED_ORIGINS entry "${entry}" ${problem}`);
      }
    }

    if (accepted.length > 0) {
      config.allowedOrigins = accepted;
    }
  }

  const bearerToken = readRequired(env, 'RELAY_API_BEARER_TOKEN', issues);
  if (bearerToken !== undefined) {
    if (/\s/u.test(bearerToken)) {
      issues.push('RELAY_API_BEARER_TOKEN must not contain whitespace');
    } else if (bearerToken.length < MINIMUM_BEARER_TOKEN_LENGTH) {
      issues.push(
        `RELAY_API_BEARER_TOKEN must be at least ${MINIMUM_BEARER_TOKEN_LENGTH} characters long`,
      );
    } else if (PLACEHOLDER_TOKEN_PREFIX.test(bearerToken)) {
      issues.push('RELAY_API_BEARER_TOKEN still looks like a placeholder; generate a fresh value');
    } else {
      config.bearerToken = bearerToken;
    }
  }

  const databaseUrl = readRequired(env, 'RELAY_DB_URL', issues);
  if (databaseUrl !== undefined) {
    const problem = validateDatabaseUrl(databaseUrl);

    if (problem === undefined) {
      config.databaseUrl = databaseUrl;
    } else {
      issues.push(`RELAY_DB_URL ${problem}`);
    }
  }

  config.databasePoolMax = readInteger(env, 'RELAY_DB_POOL_MAX', 1, 64, issues);
  config.databaseConnectTimeoutMs = readInteger(
    env,
    'RELAY_DB_CONNECT_TIMEOUT_MS',
    100,
    60000,
    issues,
  );

  const dataRoot = readRequired(env, 'RELAY_DATA_ROOT', issues);
  if (dataRoot !== undefined) {
    const problem = validateDataRoot(dataRoot, repositoryRoot);

    if (problem === undefined) {
      config.dataRoot = resolve(dataRoot);
    } else {
      issues.push(`RELAY_DATA_ROOT ${problem}`);
    }
  }

  const logLevel = readRequired(env, 'RELAY_LOG_LEVEL', issues);
  if (logLevel !== undefined) {
    if (LOG_LEVELS.includes(logLevel as LogLevel)) {
      config.logLevel = logLevel as LogLevel;
    } else {
      issues.push(`RELAY_LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`);
    }
  }

  config.stopOnStdinEof = readBoolean(env, 'RELAY_API_STOP_ON_STDIN_EOF', issues);

  if (issues.length > 0) {
    throw new ConfigError(issues);
  }

  // Every field is assigned once validation passes; issues are collected before this point.
  return config as ValidatedConfig;
}
