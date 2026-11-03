// Isolated legacy-Supabase compatibility probe. It only checks Cloudflare's
// existing /auth/me endpoint and does not expose football data.
// No shared bridge secret is required: Cloudflare verifies the signed session
// and checks current D1 membership on EVERY request.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const CF_ME="https://suolun-vip-staging.hjh19970220.workers.dev/auth/me";
const ORIGIN="https://suolunpro.github.io";
const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff","access-control-allow-origin":ORIGIN,"vary":"Origin"}});
Deno.serve(async req=>{
 if(req.method==="OPTIONS")return new Response(null,{status:204,headers:{"access-control-allow-origin":ORIGIN,"access-control-allow-methods":"POST,OPTIONS","access-control-allow-headers":"Authorization,Content-Type","access-control-max-age":"600"}});
 if(req.method!=="POST")return reply({ok:false,error:"method_not_allowed"},405);
 const origin=req.headers.get("origin");
 if(origin&&origin!==ORIGIN)return reply({ok:false,error:"origin_not_allowed"},403);
 const auth=req.headers.get("authorization")||"";
 if(!/^Bearer\\s+\\S{10,3000}$/i.test(auth))return reply({ok:false,error:"unauthorized"},401);
 try {
  const upstream=await fetch(CF_ME,{headers:{"Authorization":auth},signal:AbortSignal.timeout(8000)});
  if(!upstream.ok)return reply({ok:false,error:upstream.status===403?"vip_inactive":upstream.status===401?"unauthorized":"verification_unavailable"},upstream.status===401?401:upstream.status===403?403:503);
  const m=await upstream.json();
  if(!m?.email||!m?.expires_at||Date.parse(m.expires_at)<=Date.now())return reply({ok:false,error:"invalid_verification"},403);
  return reply({ok:true,identity:{email:m.email,vipActive:true,active:true,vipUntil:m.expires_at,vipName:m.vip_name,role:m.role}});
 }catch{return reply({ok:false,error:"verification_unavailable"},503)}
});
