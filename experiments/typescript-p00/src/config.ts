import { randomUUID } from 'node:crypto';

const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export function assertSafeIdentifier(value: string, label: string): string {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(`${label} must be a lower-case PostgreSQL identifier`);
  }

  return value;
}

export function quoteIdentifier(value: string, label: string): string {
  return `"${assertSafeIdentifier(value, label)}"`;
}

export function randomIdentifier(prefix: string): string {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  return assertSafeIdentifier(`${prefix}_${suffix}`, 'generated identifier');
}

export function requireEnvironment(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}
