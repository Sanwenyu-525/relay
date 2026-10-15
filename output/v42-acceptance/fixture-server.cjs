// Local, read-only acceptance fixture; never connects to the user's API/database.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const ts = require(path.join(root, 'apps/workbench/node_modules/typescript'));
let source = fs.readFileSync(path.join(root, 'apps/workbench/tests/screenshots/ui-refactor-v42.spec.ts'), 'utf8');
source = source.slice(source.indexOf('const apiBase'), source.indexOf('async function connect'));
source = source.replace('http://127.0.0.1:8787', 'http://127.0.0.1:4877').replace('http://127.0.0.1:4174', 'http://127.0.0.1:4173');
source = source.replace('role === "USER" ? "DISCUSS" : null', '"DISCUSS"');
let handle;
const context = { URL, page: { route: async (_pattern, callback) => { handle = callback; } } };
vm.runInNewContext(ts.transpileModule(source + '\ninstallApi(page);', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, context);
const artifact = { id: '88888888-8888-4888-8888-888888888888', task_id: '33333333-3333-4333-8333-333333333333',
  title: 'acceptance-checklist.md', revision: '2', latest_version_id: '99999999-9999-4999-8999-999999999992', version_count: 2,
  versions: [1, 2].map(n => ({ artifact_version_id: `99999999-9999-4999-8999-99999999999${n}`, version_number: String(n),
    media_type: 'text/markdown', sha256: String(n).repeat(64), size: '120', source_kind: n === 1 ? 'HUMAN' : 'AI', created_at: '2026-10-15T01:00:00Z' })) };
const scenarioPath = path.join(__dirname, 'scenario.json');
function scenario() { return fs.existsSync(scenarioPath) ? JSON.parse(fs.readFileSync(scenarioPath, 'utf8')) : {}; }
http.createServer(async (req, res) => {
  try {
    if (!['GET', 'OPTIONS'].includes(req.method)) { res.writeHead(405); res.end('Read-only fixture'); return; }
    const headers = { 'access-control-allow-origin': 'http://127.0.0.1:4173', 'access-control-allow-headers': 'Authorization, Content-Type' };
    const send = (status, body, type = 'application/json') => { res.writeHead(status, { ...headers, 'content-type': type }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
    const state = scenario();
    if (req.method === 'GET' && req.url.endsWith(`/tasks/${artifact.task_id}/artifacts`)) {
      if (state.list === 'error') return send(503, { code: 'FIXTURE_READ_UNAVAILABLE', detail: '隔离夹具：成果读取失败' });
      return send(200, { items: state.list === 'empty' ? [] : [artifact], current_accepted_version_ids: [artifact.versions[0].artifact_version_id] });
    }
    if (req.method === 'GET' && /\/artifact-versions\/.+\/content$/.test(req.url)) {
      if (state.content === 'error') return send(503, { code: 'FIXTURE_CONTENT_UNAVAILABLE', detail: '隔离夹具：正文读取失败' });
      const old = req.url.includes(artifact.versions[0].artifact_version_id);
      return send(200, `# 桌面验收清单 · ${old ? 'v1 已接受历史版本' : 'v2 当前工作版本'}\n\n此内容来自独立只读验收夹具，不是真实交付成果。\n\n- [x] 中文布局\n- [ ] 独立验收\n\n${old ? '历史基线保留。' : '最新版本不自动继承历史接受。'}`, 'text/markdown');
    }
    if (req.method === 'GET' && req.url.endsWith(`/artifacts/${artifact.id}`)) return send(200, artifact);
    await handle({ request: () => ({ url: () => 'http://127.0.0.1:4877' + req.url, method: () => req.method }),
      fulfill: async ({ status = 200, contentType, headers = {}, body = '' }) => {
        res.writeHead(status, { ...headers, ...(contentType ? { 'content-type': contentType } : {}) }); res.end(body);
      } });
  } catch (error) { res.writeHead(500); res.end(String(error)); }
}).listen(4877, '127.0.0.1', () => process.stdout.write('Read-only V4.2 fixture on 4877\n'));
