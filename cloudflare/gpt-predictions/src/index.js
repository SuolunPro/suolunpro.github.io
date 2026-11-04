// Private GPT prediction API. Bind KV namespace PREDICTIONS and secret PUBLISH_TOKEN.
// All reads validate the caller's existing SoulunPro bearer token against the
// authoritative membership endpoint; no prediction snapshots are publicly hosted.
const ORIGIN='https://suolunpro.github.io';
const AUTH_API='https://ttydbcejxqxdkcfoizkj.supabase.co/functions/v1/soren-public-api-v1?view=membership&forceFunctionRegion=ap-south-1';
const reply=(body,status=200,origin='')=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...(origin===ORIGIN?{'access-control-allow-origin':ORIGIN,'vary':'Origin'}:{})}});
export default {async fetch(request,env){
 const origin=request.headers.get('Origin')||'';
 const headers={'access-control-allow-origin':ORIGIN,'access-control-allow-methods':'GET,PUT,OPTIONS','access-control-allow-headers':'Authorization,Content-Type,X-Publish-Token','vary':'Origin'};
 if(request.method==='OPTIONS')return origin===ORIGIN?new Response(null,{status:204,headers}):new Response(null,{status:403});
 if(origin&&origin!==ORIGIN)return reply({error:'origin_denied'},403,origin);
 const u=new URL(request.url);
 if(u.pathname==='/health')return reply({ok:true,service:'gpt-predictions',configured:!!env.PREDICTIONS},200,origin);
 if(u.pathname==='/'&&request.method==='GET')return reply({service:'九十刻度 GPT VIP API',status:'online',prediction_data:'not_configured',message:'这是API接口，不是预测展示页面；请返回九十刻度网站查看。'},200,origin);

 if(u.pathname==='/publish'&&request.method==='PUT'){
  if(!env.PREDICTIONS)return reply({error:'storage_unconfigured'},503,origin);
  if(!env.PUBLISH_TOKEN)return reply({error:'publishing_unconfigured'},503,origin);
  const supplied=request.headers.get('X-Publish-Token')||'';
  // constant-time comparison of secret digests
  const hash=async s=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)));
  const a=await hash(supplied),b=await hash(env.PUBLISH_TOKEN);
  let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];
  if(!supplied||diff)return reply({error:'forbidden'},403,origin);
  if(Number(request.headers.get('content-length')||0)>1000000)return reply({error:'too_large'},413,origin);
  const raw=await request.text();if(raw.length>1000000)return reply({error:'too_large'},413,origin);
  let data;try{data=JSON.parse(raw)}catch{return reply({error:'invalid_json'},400,origin)}
  if(data.schema_version!==1||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(data.date||'')||!Array.isArray(data.matches)||data.matches.length>100)return reply({error:'invalid_schema'},400,origin);
  if(data.matches.some(m=>!m||typeof m!=='object'||m.verified!==true))return reply({error:'unverified_matches'},422,origin);
  await env.PREDICTIONS.put('day:'+data.date,JSON.stringify(data));
  return reply({ok:true,date:data.date,count:data.matches.length},200,origin);
 }
 if(u.pathname!=='/predictions'||request.method!=='GET')return reply({error:'not_found'},404,origin);
 const date=u.searchParams.get('date')||'';
 if(!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date))return reply({error:'invalid_date'},400,origin);
 const bearer=request.headers.get('Authorization')||'';
 if(!/^Bearer [^\s]+$/.test(bearer))return reply({error:'login_required'},401,origin);
 let response;
 try{response=await fetch(AUTH_API,{headers:{Authorization:bearer},signal:AbortSignal.timeout(12000),cache:'no-store'})}catch{return reply({error:'membership_unavailable'},503,origin)}
 if(!response.ok)return reply({error:response.status===401?'login_expired':'membership_unavailable'},response.status===401?401:503,origin);
 let member;try{member=(await response.json()).membership}catch{return reply({error:'membership_invalid'},503,origin)}
 if(member?.vipActive!==true)return reply({error:'vip_required'},403,origin);
 if(!env.PREDICTION_STORE)return reply({error:'prediction_data_unavailable'},503,origin);
 const id=env.PREDICTION_STORE.idFromName('predictions');
 const store=env.PREDICTION_STORE.get(id);
 const result=await store.fetch('https://internal/read?date='+encodeURIComponent(date));
 const stored=result.ok?await result.text():null;
 return stored?new Response(stored,{status:200,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...(origin===ORIGIN?{'access-control-allow-origin':ORIGIN,'vary':'Origin'}:{})}}):reply({error:'not_published'},404,origin);
}};
// Storage is private: no public writes or direct public reads are exposed.
export class PredictionStore {
 constructor(state){this.state=state;}
 async fetch(request){
  const url=new URL(request.url);
  if(url.pathname==='/read'){
   const date=url.searchParams.get('date')||'';
   if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(date))return new Response(null,{status:400});
   const data=await this.state.storage.get('day:'+date);
   return data?new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}}):new Response(null,{status:404});
  }
  return new Response(null,{status:404});
 }
}
