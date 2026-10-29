import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {makeServer} from './server.mjs';

test('only the old Soren Auth paths are proxied with CORS and body limits', async () => {
  const seen = [];
  const server = makeServer(async (target, options) => {
    seen.push({url: String(target), method: options.method, body: options.body?.toString()});
    return new Response('{"code":"invalid_credentials"}', {
      status: 400, headers: {'content-type': 'application/json'},
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = {
    Origin: 'https://suolunpro.github.io',
    apikey: 'sb_publishable_n5thZ1g6h93ronyzPfqhsg_N_lFaoSa',
    'Content-Type': 'application/json',
  };
  try {
    const health = await fetch(base + '/health');
    assert.equal(await health.text(), 'ok');
    const preflight = await fetch(base + '/auth/v1/token', {method: 'OPTIONS', headers});
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), headers.Origin);
    const login = await fetch(base + '/auth/v1/token?grant_type=password', {
      method: 'POST', headers, body: '{"email":"example.invalid","password":"dummy"}',
    });
    assert.equal(login.status, 400);
    assert.equal(seen[0].url, 'https://ttydbcejxqxdkcfoizkj.supabase.co/auth/v1/token?grant_type=password');
    for (const route of ['signup', 'recover', 'resend', 'token?grant_type=refresh_token', 'logout']) {
      assert.equal((await fetch(base + '/auth/v1/' + route, {
        method: 'POST', headers, body: '{}',
      })).status, 400);
    }
    assert.equal((await fetch(base + '/auth/v1/user', {headers})).status, 400);
    assert.equal((await fetch(base + '/auth/v1/token', {
      method: 'POST', headers: {...headers, Origin: 'https://other.invalid'}, body: '{}',
    })).status, 403);
    assert.equal((await fetch(base + '/auth/v1/anything', {
      method: 'POST', headers, body: '{}',
    })).status, 404);
    assert.equal((await fetch(base + '/auth/v1/signup', {
      method: 'POST', headers, body: 'x'.repeat(16385),
    })).status, 413);
    assert.equal(seen.length, 7);
  } finally {
    server.close();
  }
});
