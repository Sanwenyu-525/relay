// Local visual fixture: synthetic data only, no database or model calls.
import http from 'node:http';
const workspace = '11111111-1111-4111-8111-111111111111';
const sessionId = '66666666-6666-4666-8666-666666666666';
const prefix = `/api/v1/workspaces/${workspace}`;
const session = { id: sessionId, workspace_id: workspace, project_id: null, task_id: null,
  title: '已有普通讨论', status: 'ACTIVE', revision: '1',
  created_at: '2026-10-05T00:00:00Z', updated_at: '2026-10-05T00:00:00Z' };
const messages = [];
http.createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:4173');
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  const reply = (body, status = 200) => {
    if (body.command_id) body.committed_at = '2026-10-05T00:00:00Z';
    response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body));
  };
  if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
  const path = new URL(request.url, 'http://127.0.0.1:8798').pathname;
  if (request.method === 'POST') {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    if (path === `${prefix}/assist-sessions`) {
      reply({ command_id: body.command_id, result: { session_id: sessionId, ...session } }, 201); return;
    }
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) {
      const index = messages.length / 2 + 1;
      for (const [role, content] of [['USER', body.content], ['ASSISTANT', `第 ${index} 条回复：可以继续讨论。`]])
        messages.push({ id: `${role}-${index}`, session_id: sessionId, seq: String(messages.length + 1), role,
          status: 'COMPLETED', intent: 'DISCUSS', content, error_code: null, sources: [],
          usage: { input_tokens: null, output_tokens: null }, cancel_requested: false });
      reply({ command_id: body.command_id, result: { session_id: sessionId,
        user_message_id: `USER-${index}`, assistant_message_id: `ASSISTANT-${index}` } }, 202); return;
    }
    reply({ code: 'NOT_FOUND' }, 404); return;
  }
  if (path === '/health/ready') reply({ status: 'ready' });
  else if (path === `${prefix}/assist-sessions`) reply({ items: [session] });
  else if (path === `${prefix}/assist-sessions/${sessionId}`) reply(session);
  else if (path.endsWith('/messages')) reply({ items: messages });
  else if (path.endsWith('/model-port')) reply({ provider: 'fake', configured: false, model: null,
    base_url: null, max_call_tokens: null });
  else reply({ items: [], next_cursor: null });
}).listen(8798, '127.0.0.1', () => process.stdout.write('Visual fixture listening on 8798\n'));
