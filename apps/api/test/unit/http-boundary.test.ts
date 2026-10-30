import assert from 'node:assert/strict';
import test from 'node:test';

import { createServer } from '../../src/api/server.js';

test('IPv6 loopback requests pass Host and Origin checks while other hosts and ports are refused', async () => {
  const app = createServer({
    bindHost: '::1', port: 8787, allowedOrigins: ['http://[::1]:5173'],
    bearerToken: 'a'.repeat(48), logLevel: 'fatal', dataRoot: '',
    databaseUrl: '', databasePoolMax: 1, databaseConnectTimeoutMs: 1000,
    stopOnStdinEof: false,
  });
  app.get('/probe', async () => ({ ok: true }));
  try {
    const accepted = await app.inject({
      url: '/probe', headers: { host: '[::1]:8787', origin: 'http://[::1]:5173' },
    });
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.headers['access-control-allow-origin'], 'http://[::1]:5173');
    for (const host of ['[::1]:8788', '[::]:8787', '[2001:db8::1]:8787', 'evil.example:8787']) {
      const refused = await app.inject({ url: '/probe', headers: { host } });
      assert.equal(refused.statusCode, 400);
      assert.equal(refused.json().type, '/problems/invalid-host');
    }
    const wrongOrigin = await app.inject({
      url: '/probe', headers: { host: '[::1]:8787', origin: 'http://[2001:db8::1]:5173' },
    });
    assert.equal(wrongOrigin.statusCode, 403);
    const address = await app.listen({ host: '::1', port: 0 });
    const response = await fetch(`${address}/probe`, { headers: { origin: 'http://[::1]:5173' } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    await app.close();
  }
});
