// Staging-only Supabase Edge Function: verifies Cloudflare VIP identity server-to-server.
// Deployment requires VIP_BRIDGE_SECRET in BOTH Supabase and Cloudflare environments.
// Do not deploy until the Worker /internal/verify-vip endpoint is deployed and tested.
// Does not grant access to any football data by itself.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const CF_VERIFY_URL="https://suolun-vip-staging.hjh19970220.workers.dev/internal/verify-vip";
const ORIGIN="https://suolunpro.github.io";
const reply=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{
 "content-type":"application/json; charset=utf-8","cache-control":"no-store",
 "access-control-allow-origin":ORIGIN,"vary":"Origin","x-content-type-options":"nosniff"
}});
Deno.serve(async req=>{
 if(req.method==="OPTIONS")return new Response(null,{status:204,headers:{
  "access-control-allow-origin":ORIGIN,"access-control-allow-methods":"POST,OPTIONS",
  "access-control-allow-headers":"Authorization,Content-Type","access-control-max-age":"600"
 }});
 if(req.method!=="POST")return reply({ok:false,error:"method_not_allowed"},405);
 const origin=req.headers.get("origin");
 if(origin&&origin!==ORIGIN)return reply({ok:false,error:"origin_not_allowed"},403);
 const secret=Deno.env.get("VIP_BRIDGE_SECRET");
 if(!secret)return reply({ok:false,error:"bridge_not_configured"},503);
 const auth=req.headers.get("authorization")||"";
 if(!/^Bearer\s+\S{10,3000}$/i.test(auth))return reply({ok:false,error:"unauthorized"},401);
 try{
  const upstream=await fetch(CF_VERIFY_URL,{method:"POST",headers:{
   "content-type":"application/json","x-vip-bridge-secret":secret
  },body:JSON.stringify({token:auth.replace(/^Bearer\s+/i,"")}),signal:AbortSignal.timeout(8000)});
  if(!upstream.ok)return reply({ok:false,error:upstream.status===401?"unauthorized":upstream.status===403?"vip_inactive":"verification_unavailable"},upstream.status===401?401:upstream.status===403?403:503);
  const result=await upstream.json();
  if(result?.ok!==true||result?.vipActive!==true||!result?.user_id||!result?.expires_at)
   return reply({ok:false,error:"invalid_verification"},503);
  return reply({ok:true,identity:{user_id:result.user_id,email:result.email,
   vipActive:true,active:true,vipUntil:result.expires_at,vipName:result.vip_name,role:result.role}});
 }catch{return reply({ok:false,error:"verification_unavailable"},503)}
});
