// NineTen auth fallback proxy. Deploy separately to a trusted Cloudflare Worker domain.
// This file is NOT activated in production until its endpoint passes end-to-end tests.
const UPSTREAM = 'https://zssourkgabcxibggwhqm.supabase.co';
const ORIGINS = new Set(['https://suolunpro.github.io','https://hjh19970220.github.io']);
const METHODS = new Set(['GET','POST','OPTIONS']);
const ROUTES = /^\/auth\/v1\/(?:token|signup|recover|resend|user|logout|verify|otp|magiclink|authorize|callback|settings|health)(?:\/|$)/;
export default {
  async fetch(request) {
    const incoming = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ORIGINS.has(origin) ? origin : 'null',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'apikey, authorization, content-type, x-client-info',
      'Access-Control-Max-Age': '600',
      'Vary': 'Origin',
      'Cache-Control': 'no-store'
    };
    if (!ORIGINS.has(origin)) return new Response('Forbidden origin',{status:403,headers:cors});
    if (!METHODS.has(request.method) || !ROUTES.test(incoming.pathname)) {
      return new Response('Not found',{status:404,headers:cors});
    }
    if (request.method === 'OPTIONS') return new Response(null,{status:204,headers:cors});
    const upstream = new URL(incoming.pathname + incoming.search, UPSTREAM);
    const headers = new Headers();
    for (const h of ['apikey','authorization','content-type','x-client-info']) {
      if (request.headers.has(h)) headers.set(h,request.headers.get(h));
    }
    headers.set('Accept','application/json');
    try {
      const response = await fetch(upstream.toString(), {
        method: request.method,
        headers,
        body: request.method === 'POST' ? request.body : undefined,
        redirect:'manual'
      });
      const out = new Headers(cors);
      out.set('Content-Type',response.headers.get('Content-Type') || 'application/json');
      if (response.headers.has('Location')) out.set('Location',response.headers.get('Location'));
      return new Response(response.body,{status:response.status,headers:out});
    } catch {
      return new Response(JSON.stringify({error:'auth_upstream_unavailable'}),{
        status:502,headers:{...cors,'Content-Type':'application/json'}
      });
    }
  }
};
