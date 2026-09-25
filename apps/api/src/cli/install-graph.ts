import { installGraphCheckpoints } from '../infrastructure/graph-checkpoints.js';
import { readRequiredDatabaseUrl, reportFailure } from './cli-support.js';

async function main(): Promise<void> {
  try {
    const connectionString = readRequiredDatabaseUrl(process.env, 'RELAY_MIGRATION_DB_URL');
    await installGraphCheckpoints(connectionString);
    process.stdout.write(`${JSON.stringify({ schema: 'relay_graph_v1', ready: true })}\n`);
  } catch (error) {
    process.exitCode = reportFailure(error);
  }
}

await main();
