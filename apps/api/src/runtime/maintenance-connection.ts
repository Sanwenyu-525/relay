import type { ClientConfig } from 'pg';
import { parse, toClientConfig } from 'pg-connection-string';

/** Resolve the explicit URL once; missing fields must not select another PG environment target. */
export function maintenanceConnectionOptions(url: string): ClientConfig {
  try {
    const protocol = new URL(url).protocol;
    if (protocol !== 'postgres:' && protocol !== 'postgresql:') throw new Error();
    const parsed = parse(url);
    // pg also supports ssl=no-verify; toClientConfig otherwise drops this string and disables TLS.
    if (parsed.ssl === 'no-verify') parsed.ssl = { rejectUnauthorized: false };
    else if (typeof parsed.ssl === 'string') throw new Error();
    if (![parsed.host, parsed.user, parsed.database].every(value => typeof value === 'string' && value.length > 0) ||
        parsed.port != null && parsed.port !== '' && !/^[0-9]+$/u.test(parsed.port)) throw new Error();
    const config = toClientConfig(parsed);
    const port = config.port ?? 5432;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
    const password = typeof config.password === 'string' ? config.password : '';
    // Unknown URL query keys must not become Client/Pool constructors or trigger another parse.
    return { host: config.host, user: config.user, database: config.database,
      port, password: async () => password, ssl: config.ssl ?? false,
      options: config.options || '-c default_transaction_read_only=off',
      client_encoding: config.client_encoding || 'UTF8' };
  } catch { throw new Error('MAINTENANCE_CONNECTION_INVALID'); }
}
