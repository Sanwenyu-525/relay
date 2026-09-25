import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const outputDir = process.env.RELAY_M03_BENCH_OUTPUT_DIR;
if (outputDir) {
  mkdirSync(outputDir, { recursive: true });
  const entry = (process.argv[1] ?? '').replaceAll('\\', '/');
  const role = entry.endsWith('/worker/supervisor-main.js') ? 'supervisor'
    : entry.endsWith('/worker/main.js') ? 'worker' : 'api';
  const file = join(outputDir, `node-${process.pid}.jsonl`);
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  let previousCpu = process.cpuUsage();

  const record = (kind) => {
    const cpu = process.cpuUsage(previousCpu);
    previousCpu = process.cpuUsage();
    const toMs = (nanoseconds) => Number.isFinite(nanoseconds) && nanoseconds > 0
      ? nanoseconds / 1_000_000 : null;
    appendFileSync(file, `${JSON.stringify({
      kind, at_ms: Date.now(), pid: process.pid, role,
      rss_bytes: process.memoryUsage().rss,
      cpu_delta_ms: (cpu.user + cpu.system) / 1_000,
      loop_p95_ms: toMs(delay.percentile(95)),
      loop_p99_ms: toMs(delay.percentile(99)),
      loop_max_ms: toMs(delay.max),
    })}\n`);
    delay.reset();
  };

  record('start');
  setInterval(() => record('sample'), 250).unref();
  process.on('exit', () => record('exit'));
}
