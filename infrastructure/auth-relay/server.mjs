import {createServer} from 'node:http';

const UPSTREAM = 'https://ttydbcejxqxdkcfoizkj.supabase.co';
const ORIGIN = 'https://suolunpro.github.io';
const KEY = 'sb_publishable_n5thZ1g6h93ronyzPfqhsg_N_lFaoSa';
const MAX_BODY = 16 * 1024;
const ROUTES = new Map([
  ['/auth/v1/token', 'POST'],
  ['/auth/v1/signup', 'POST'],
  ['/auth/v1/recover', 'POST'],
  ['/auth/v1/resend', 'POST'],
  ['/auth/v1/user', 'GET'],
  ['/auth/v1/logout', 'POST'],
]);

export function makeServer(upstreamFetch = fetch) {
  return createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, {'Content-Type': 'text/plain; charset=utf-8'}).end('ok');
      return;
    }
    if (req.headers.origin !== ORIGIN) {
      res.writeHead(403).end();
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'apikey, authorization, content-type, x-client-info');
    res.setHeader('Access-Control-Max-Age', '600');
    res.setHeader('Vary', 'Origin');
    const method = ROUTES.get(url.pathname);
    if (!method) {
      res.writeHead(404).end();
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    if (req.method !== method) {
      res.writeHead(405).end();
      return;
    }
    if (req.headers.apikey !== KEY) {
      res.writeHead(401).end();
      return;
    }
    const headers = {apikey: KEY};
    if (req.headers.authorization) headers.authorization = req.headers.authorization;
    let body;
    if (method === 'POST') {
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
        res.writeHead(415).end();
        return;
      }
      headers['content-type'] = 'application/json';
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks);
    }
    try {
      const target = new URL(url.pathname + url.search, UPSTREAM);
      const response = await upstreamFetch(target, {
        method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(20000),
      });
      const outgoing = {};
      const contentType = response.headers.get('content-type');
      if (contentType) outgoing['Content-Type'] = contentType;
      res.writeHead(response.status, outgoing);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      if (!res.headersSent) res.writeHead(502, {'Content-Type': 'application/json'});
      res.end('{"error":"auth_upstream_unavailable"}');
    }
  });
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  makeServer().listen(Number(process.env.PORT || 3000), '0.0.0.0');
}
