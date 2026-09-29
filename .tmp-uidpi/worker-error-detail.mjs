// 诊断：镜像 worker main.ts 的最小领取路径，打印真实错误与栈（只跑一次领取，不改任何行为）。
process.env.RELAY_DB_URL = "postgresql://relay_app@127.0.0.1:6189/relay_trial";
process.env.RELAY_DATA_ROOT = "D:\\Develop\\Relay-Agent\\.relay-test\\data";
const { randomUUID } = await import("node:crypto");
const { RelayDatabase } = await import("file://" + process.cwd().replace(/\\/g, "/") + "/test-release/api/dist/src/infrastructure/database.js");
const { SchemaReadinessChecker } = await import("file://" + process.cwd().replace(/\\/g, "/") + "/test-release/api/dist/src/infrastructure/schema-readiness.js");
const { graphCheckpointsReady } = await import("file://" + process.cwd().replace(/\\/g, "/") + "/test-release/api/dist/src/infrastructure/graph-checkpoints.js");
const { runOneCommand } = await import("file://" + process.cwd().replace(/\\/g, "/") + "/test-release/api/dist/src/worker/run-command.js");
const { resolve, dirname } = await import("node:path");
const { fileURLToPath } = await import("node:url");

const MIGRATIONS_DIRECTORY = resolve(dirname(fileURLToPath(new URL(import.meta.url).href)), "..", "test-release", "api", "migrations");
const database = new RelayDatabase({
  databaseUrl: process.env.RELAY_DB_URL, databasePoolMax: 4, databaseConnectTimeoutMs: 5000,
}, () => {});
const readiness = await database.checkReadiness(new SchemaReadinessChecker(MIGRATIONS_DIRECTORY));
console.log("readiness:", JSON.stringify(readiness));
const databaseUrl = process.env.RELAY_DB_URL;
console.log("checkpoints:", await graphCheckpointsReady(database.executor, databaseUrl));
try {
  const result = await runOneCommand(database.executor, {
    workerId: `worker:diag:${randomUUID()}`, dataRoot: process.env.RELAY_DATA_ROOT, checkpointUrl: databaseUrl,
    leaseMs: 30000,
    onClaim: async (claim) => console.log("claimed:", claim.commandId, claim.runId, "epoch", claim.epoch.toString(), "kind", claim.kind),
    afterStep: async (step) => console.log("step:", step.step_kind, step.status, "run_status", step.run_status),
    afterGatewayPrepared: async (p) => console.log("gatewayPrepared:", JSON.stringify(p).slice(0, 200)),
    afterGatewayAdmit: async () => console.log("gatewayAdmit"),
    afterGatewayFakeEffect: async () => console.log("gatewayFakeEffect"),
    afterGraph: async () => console.log("graph done"),
  });
  console.log("result:", JSON.stringify(result));
} catch (error) {
  console.error("WORKER ERROR:", error?.message);
  console.error(error?.stack ?? error);
} finally {
  await database.close();
}
