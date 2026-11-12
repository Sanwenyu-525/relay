#!/usr/bin/env node
/**
 * Relay runtime JSONL log query (read-only, dependency-free).
 *
 * 默认数据根与桌面/服务进程一致：显式 --dir > RELAY_DATA_ROOT > 打包桌面默认目录。
 * 只读取 *.log / *.log.N，不修改、不轮转、不写任何文件；坏行按原样保留供 --grep。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const LEVEL_ORDER = { fatal: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 };
const CORRELATION_FLAGS = {
  '--request-id': 'request_id', '--command-id': 'command_id',
  '--session-id': 'session_id', '--message-id': 'message_id',
  '--model-call-id': 'model_call_id', '--project-id': 'project_id',
  '--task-id': 'task_id', '--run-id': 'run_id', '--operation-id': 'operation_id',
  '--invocation-id': 'invocation_id', '--worker-id': 'worker_id',
};
const USAGE = `用法: node scripts/log-query.mjs [选项]

目录:
  --dir <path>          日志目录（默认 RELAY_DATA_ROOT/logs 或桌面数据根/logs）
  --file <name>         只读某个文件（可重复，支持前缀匹配如 relay-worker）
  --list                只列出目录内的日志文件及大小

过滤:
  --level <level>       最低级别 fatal|error|warn|info|debug|trace（默认 info）
  --since <time>        ISO 时间或相对窗口 30m / 2h / 1d
  --until <time>        ISO 时间或相对窗口
  --event <pattern>     事件名，支持 * 通配（可重复）
  --namespace <name>    命名空间精确匹配
  --request-id/--session-id/--message-id/--model-call-id/--run-id/... 关联 id 精确匹配
  --id <value>          任一关联 id 精确匹配
  --grep <text>         原始行包含该文本（含错误栈）

输出:
  --json                输出原始 JSONL 行
  --limit <n>           最多输出 n 条（默认 200，0 表示不限）
  --help                显示本帮助
`;

function fail(message) {
  process.stderr.write(`log-query: ${message}\n`);
  process.exit(2);
}

function defaultLogDirectory() {
  const fromEnv = process.env.RELAY_DATA_ROOT?.trim();
  if (fromEnv !== undefined && fromEnv !== '') return join(fromEnv, 'logs');
  const appData = process.env.APPDATA?.trim();
  if (appData === undefined || appData === '') {
    return join(homedir(), 'AppData', 'Roaming', 'dev.relay.agent', 'data', 'logs');
  }
  for (const candidate of ['trial-data', 'data']) {
    const directory = join(appData, 'dev.relay.agent', candidate, 'logs');
    if (existsSync(directory)) return directory;
  }
  return join(appData, 'dev.relay.agent', 'data', 'logs');
}

function parseRelative(value) {
  const matched = /^(\d+)([mhd])$/u.exec(value.trim());
  if (matched === null) return undefined;
  const amount = Number(matched[1]);
  const unit = matched[2] === 'm' ? 60_000 : matched[2] === 'h' ? 3_600_000 : 86_400_000;
  return new Date(Date.now() - amount * unit);
}

function parseTime(value, option) {
  const relative = parseRelative(value);
  if (relative !== undefined) return relative.getTime();
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) fail(`${option} 需要 ISO 时间或 30m/2h/1d：${value}`);
  return parsed;
}

function parseArgs(argv) {
  const options = {
    directory: undefined, files: [], list: false, level: 'info',
    since: undefined, until: undefined, events: [], namespace: undefined,
    correlations: [], id: undefined, grep: undefined, json: false, limit: 200,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = () => {
      const next = argv[index + 1];
      if (next === undefined) fail(`${arg} 缺少取值`);
      index += 1;
      return next;
    };
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE);
      process.exit(0);
    } else if (arg === '--dir') options.directory = resolve(take());
    else if (arg === '--file') options.files.push(take());
    else if (arg === '--list') options.list = true;
    else if (arg === '--level') {
      const level = take().trim().toLowerCase();
      if (!(level in LEVEL_ORDER)) fail(`未知级别 ${level}`);
      options.level = level;
    } else if (arg === '--since') options.since = parseTime(take(), arg);
    else if (arg === '--until') options.until = parseTime(take(), arg);
    else if (arg === '--event') options.events.push(take());
    else if (arg === '--namespace') options.namespace = take();
    else if (arg in CORRELATION_FLAGS) options.correlations.push([CORRELATION_FLAGS[arg], take()]);
    else if (arg === '--id') options.id = take();
    else if (arg === '--grep') options.grep = take();
    else if (arg === '--json') options.json = true;
    else if (arg === '--limit') {
      const limit = Number(take());
      if (!Number.isInteger(limit) || limit < 0) fail('--limit 需要非负整数');
      options.limit = limit;
    } else {
      fail(`未知选项 ${arg}（--help 查看用法）`);
    }
  }
  if (options.since !== undefined && options.until !== undefined && options.since > options.until) {
    fail('--since 晚于 --until');
  }
  return options;
}

function eventMatcher(patterns) {
  if (patterns.length === 0) return () => true;
  const matchers = patterns.map((pattern) => {
    if (!pattern.includes('*')) return (event) => event === pattern;
    const regex = new RegExp('^' + pattern.split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('.*') + '$', 'u');
    return (event) => regex.test(event);
  });
  return (event) => matchers.some((match) => match(event));
}

function listFiles(directory, prefixes) {
  const names = readdirSync(directory).filter((name) =>
    /\.log(?:\.\d+)?$/u.test(name) && !name.endsWith('.rotate.lock'));
  const selected = prefixes.length === 0 ? names : names.filter((name) =>
    prefixes.some((prefix) => name === prefix || name.startsWith(prefix)));
  return selected.map((name) => join(directory, name))
    .sort((left, right) => statSync(left).mtimeMs - statSync(right).mtimeMs
      || left.localeCompare(right));
}

function parseLine(line) {
  if (!line.startsWith('{')) return { raw: line };
  try {
    const record = JSON.parse(line);
    return typeof record === 'object' && record !== null ? record : { raw: line };
  } catch {
    return { raw: line };
  }
}

function matches(record, options, matcher) {
  if (record.raw !== undefined) {
    // 纯文本行没有时间与级别；一旦按结构化字段过滤就不再纳入，避免污染精确查询。
    const needle = options.grep ?? '';
    return options.since === undefined && options.until === undefined
      && options.events.length === 0 && options.correlations.length === 0
      && options.id === undefined && options.namespace === undefined
      && (needle === '' || String(record.raw).includes(needle));
  }
  if (options.since !== undefined || options.until !== undefined) {
    const ts = Date.parse(record.ts ?? '');
    if (Number.isNaN(ts)) return false;
    if (options.since !== undefined && ts < options.since) return false;
    if (options.until !== undefined && ts > options.until) return false;
  }
  const level = String(record.level ?? 'info').toLowerCase();
  if ((LEVEL_ORDER[level] ?? LEVEL_ORDER.info) > LEVEL_ORDER[options.level]) return false;
  if (!matcher(String(record.event ?? ''))) return false;
  if (options.namespace !== undefined && record.namespace !== options.namespace) return false;
  for (const [key, value] of options.correlations) {
    if (String(record[key] ?? '') !== value) return false;
  }
  if (options.id !== undefined) {
    const hit = Object.values(CORRELATION_FLAGS).some((key) => String(record[key] ?? '') === options.id);
    if (!hit) return false;
  }
  if (options.grep !== undefined && !JSON.stringify(record).includes(options.grep)) return false;
  return true;
}

function formatHuman(record) {
  if (record.raw !== undefined) return `(unparsed) ${String(record.raw)}`;
  const parts = [
    String(record.ts ?? '-'),
    String(record.level ?? '-').toUpperCase().padEnd(5),
    String(record.process ?? '-').padEnd(10),
    String(record.event ?? '-'),
  ];
  const detail = [];
  if (record.namespace !== undefined) detail.push(`ns=${record.namespace}`);
  for (const key of Object.values(CORRELATION_FLAGS)) {
    if (record[key] !== undefined) detail.push(`${key}=${String(record[key])}`);
  }
  if (record.error_code !== undefined) detail.push(`error_code=${String(record.error_code)}`);
  if (record.error_name !== undefined) detail.push(`error_name=${String(record.error_name)}`);
  if (record.error_message !== undefined) detail.push(`error_message=${String(record.error_message)}`);
  if (record.failure_stage !== undefined) detail.push(`failure_stage=${String(record.failure_stage)}`);
  if (record.duration_ms !== undefined) detail.push(`duration_ms=${String(record.duration_ms)}`);
  if (record.log_truncated === true) detail.push('log_truncated=true');
  return `${parts.join(' ')}${detail.length > 0 ? ` | ${detail.join(' ')}` : ''}`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const directory = options.directory ?? defaultLogDirectory();
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    fail(`日志目录不存在：${directory}（用 --dir 指定，或先启动一次应用）`);
  }
  const files = listFiles(directory, options.files);
  if (options.list) {
    for (const file of files) {
      process.stdout.write(`${String(statSync(file).size).padStart(10)}  ${file}\n`);
    }
    return;
  }
  if (files.length === 0) fail(`目录内没有匹配的日志文件：${directory}`);

  const matcher = eventMatcher(options.events);
  const matched = [];
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    for (const line of content.split(/\r?\n/u)) {
      if (line === '') continue;
      const record = parseLine(line);
      if (matches(record, options, matcher)) matched.push(record);
    }
  }
  matched.sort((left, right) => Date.parse(left.ts ?? '') - Date.parse(right.ts ?? ''));
  const limited = options.limit === 0 ? matched : matched.slice(-options.limit);
  for (const record of limited) {
    if (options.json) {
      process.stdout.write(`${record.raw === undefined ? JSON.stringify(record) : record.raw}\n`);
    } else {
      process.stdout.write(`${formatHuman(record)}\n`);
    }
  }
  if (!options.json && limited.length > 0) {
    process.stderr.write(`log-query: ${limited.length} 条（目录 ${directory}）\n`);
  }
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
