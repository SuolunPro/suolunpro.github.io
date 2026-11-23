// Candidate independent Auth endpoint. GitHub Pages does not activate this file.
// Deploy to an independently operated HTTPS Worker after target Wi-Fi testing.
const UPSTREAM = 'https://ttydbcejxqxdkcfoizkj.supabase.co';
const ORIGIN = 'https://suolunpro.github.io';
const MAX_BODY = 16 * 1024;
const ROUTES = new Map([
  ['/auth/v1/token', ['POST']],
  ['/auth/v1/signup', ['POST']],
  ['/auth/v1/recover', ['POST']],
  ['/auth/v1/resend', ['POST']],
  ['/auth/v1/user', ['GET']],
  ['/auth/v1/logout', ['POST']],
  ['/auth/v1/verify', ['GET', 'POST']],
]);

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const cors = {
      'Access-Control-Allow-Origin': ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'apikey, authorization, content-type, x-client-info',
      'Access-Control-Max-Age': '600',
      'Vary': 'Origin',
      'Cache-Control': 'no-store',
    };
    if (origin !== ORIGIN) return new Response('Forbidden origin', {status: 403});
    const allowed = ROUTES.get(url.pathname);
    if (!allowed) return new Response('Not found', {status: 404, headers: cors});
    if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: cors});
    if (!allowed.includes(request.method)) return new Response('Method not allowed', {status: 405, headers: cors});
    const length = Number(request.headers.get('Content-Length'));
    if (length > MAX_BODY) return new Response('Payload too large', {status: 413, headers: cors});
    let body;
    if (request.method === 'POST') {
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength > MAX_BODY) return new Response('Payload too large', {status: 413, headers: cors});
      body = bytes;
    }
    const headers = new Headers();
    for (const name of ['apikey', 'authorization', 'content-type', 'x-client-info']) {
      if (request.headers.has(name)) headers.set(name, request.headers.get(name));
    }
    const upstream = new URL(url.pathname + url.search, UPSTREAM);
    try {
      const response = await fetch(upstream, {method: request.method, headers, body, redirect: 'manual'});
      const resultHeaders = new Headers(cors);
      for (const name of ['content-type', 'location']) {
        if (response.headers.has(name)) resultHeaders.set(name, response.headers.get(name));
      }
      return new Response(response.body, {status: response.status, headers: resultHeaders});
    } catch {
      return new Response(JSON.stringify({error: 'auth_upstream_unavailable'}), {
        status: 502, headers: {...cors, 'Content-Type': 'application/json'},
      });
    }
  },
};
