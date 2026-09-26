import { validationFailed } from './domain-error.js';

export function requireLocalDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw validationFailed([{ field, message: 'must be a valid YYYY-MM-DD date' }]);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw validationFailed([{ field, message: 'must be a valid YYYY-MM-DD date' }]);
  }
  return value;
}

export function requireTimezone(value: string, field: string): string {
  try {
    if (value.trim() !== value || value === '') throw new RangeError('empty timezone');
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    throw validationFailed([{ field, message: 'must be a valid IANA timezone' }]);
  }
}
