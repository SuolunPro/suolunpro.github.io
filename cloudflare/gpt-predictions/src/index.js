export class PredictionStore {
 constructor(state){this.state=state;}
 async fetch(request){
  const u=new URL(request.url),date=u.searchParams.get('date')||'';
  if(!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date))return new Response('invalid date',{status:400});
  if(u.pathname==='/stats'&&request.method==='GET'){
   const end=Date.parse(date+'T00:00:00Z');const daily=[];
   for(let n=0;n<31;n++){
    const d=new Date(end-n*86400000).toISOString().slice(0,10);
    const predictions=await this.state.storage.get('day:'+d),results=await this.state.storage.get('results:'+d)||{};
    if(!predictions)continue;
    const rows=(predictions.matches||[]).map(m=>({m,r:results[String(m.fixture_id)]})).filter(x=>x.r);
    const metrics=['wdl_top1','wdl_top2','score_top1','score_top3','htft_top1','htft_top3','goals_top1','goals_top3','daily_pick'];
    const totals=Object.fromEntries(metrics.map(k=>[k,{hit:rows.filter(x=>x.r.hit[k]===true).length,total:rows.filter(x=>x.r.hit[k]!==null).length}]));
    daily.push({date:d,settled:rows.length,predicted:predictions.matches.length,upset_triggered:predictions.matches.filter(x=>x.upset).length,totals});
   }
   const sum=items=>({settled:items.reduce((v,x)=>v+x.settled,0),upset_triggered:items.reduce((v,x)=>v+x.upset_triggered,0),totals:Object.fromEntries(['wdl_top1','wdl_top2','score_top1','score_top3','htft_top1','htft_top3','goals_top1','goals_top3','daily_pick'].map(k=>[k,{hit:items.reduce((v,x)=>v+x.totals[k].hit,0),total:items.reduce((v,x)=>v+x.totals[k].total,0)}]))});
   return Response.json({daily,week:sum(daily.slice(0,7)),month:sum(daily)});
  }
  const key='day:'+date;
  if(request.method==='GET'){
   const data=await this.state.storage.get(key);
   if(!data)return new Response('',{status:404});
   const results=await this.state.storage.get('results:'+date)||{};
   return Response.json({...data,matches:data.matches.map(m=>({...m,settlement:results[String(m.fixture_id)]||null}))});
  }
  if(request.method==='PUT'){
   let data;try{data=await request.json()}catch{return Response.json({error:'invalid_json'},{status:400})}
   if(u.pathname==='/settle'){
    const results=await this.state.storage.get('results:'+date)||{};
    const current=await this.state.storage.get(key);
    if(!current)return Response.json({error:'no_frozen_predictions'},{status:404});
    for(const item of data.results||[]){
     const id=String(item.fixture_id), fixture=current.matches.find(m=>String(m.fixture_id)===id);
     if(!fixture||!Number.isInteger(item.ht_home)||!Number.isInteger(item.ht_away)||!Number.isInteger(item.ft_home)||!Number.isInteger(item.ft_away)||
        Math.min(item.ht_home,item.ht_away,item.ft_home,item.ft_away)<0||item.status!=='FINISHED'||
        !/^https:\/\//.test(item.source_url||'')||Date.now()<Date.parse(fixture.kickoff_at)+120*60000||
        Date.parse(fixture.generated_at)>=Date.parse(fixture.kickoff_at))return Response.json({error:'invalid_result'},{status:422});
     if(results[id]&&(results[id].ft_home!==item.ft_home||results[id].ft_away!==item.ft_away||results[id].ht_home!==item.ht_home||results[id].ht_away!==item.ht_away))return Response.json({error:'result_conflict'},{status:409});
     const ft=item.ft_home>item.ft_away?'主胜':item.ft_home===item.ft_away?'平':'客胜';
     const half=item.ht_home>item.ht_away?'胜':item.ht_home===item.ht_away?'平':'负';
     const full=item.ft_home>item.ft_away?'胜':item.ft_home===item.ft_away?'平':'负';
     const score=item.ft_home+'-'+item.ft_away, goals=item.ft_home+item.ft_away;
     results[id]={...item,verified_at:new Date().toISOString(),hit:{wdl_top1:fixture.wdl_top2[0]?.pick===ft,wdl_top2:fixture.wdl_top2.some(x=>x.pick===ft),score_top1:fixture.score_top3[0]===score,score_top3:fixture.score_top3.includes(score),htft_top1:fixture.htft_top3[0]===half+'/'+full,htft_top3:fixture.htft_top3.includes(half+'/'+full),goals_top1:fixture.goals_top3[0]===(goals>=7?'7+':String(goals)),goals_top3:fixture.goals_top3.includes(goals>=7?'7+':String(goals)),daily_pick:fixture.daily_pick?fixture.daily_pick===ft:null}};
    }
    await this.state.storage.put('results:'+date,results);
    return Response.json({ok:true,count:(data.results||[]).length});
   }
   const warnedKey='warned:'+date;
   const warned=new Set(await this.state.storage.get(warnedKey)||[]);
   const matchId=m=>String(m.fixture_id||[m.number,m.home,m.away].join('|'));
   for(const m of data.matches||[])if(m.upset && m.upset!==false)warned.add(matchId(m));
   if((data.matches||[]).some(m=>m.daily_pick&&warned.has(matchId(m))))
    return Response.json({error:'cold_warning_exclusion'},{status:422});
   const previous=await this.state.storage.get(key);
   const prior=new Map((previous?.matches||[]).map(m=>[String(m.fixture_id),m]));
   if((data.matches||[]).some(m=>Date.parse(m.generated_at)>=Date.parse(m.kickoff_at)||
     (prior.has(String(m.fixture_id))&&Date.now()>=Date.parse(m.kickoff_at))))return Response.json({error:'prediction_after_kickoff'},{status:422});
   // Preserve first-to-last revisions for audit and use the last legal prematch
   // snapshot as the settlement baseline.
   const history=await this.state.storage.get('history:'+date)||{};
   for(const m of data.matches||[])history[String(m.fixture_id)]=[...(history[String(m.fixture_id)]||[]),m];
   await this.state.storage.put('history:'+date,history);
   await this.state.storage.put(warnedKey,[...warned]);
   const merged=new Map((previous?.matches||[]).map(m=>[String(m.fixture_id),m]));
   for(const m of data.matches||[])merged.set(String(m.fixture_id),m);
   await this.state.storage.put(key,{...data,matches:[...merged.values()]});
   return Response.json({ok:true});
  }
  return new Response('',{status:405});
 }
}
// Private prediction API using a Durable Object and optional PUBLISH_TOKEN secret.
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
 if(u.pathname==='/health')return reply({ok:true,service:'gpt-predictions',configured:!!env.PREDICTION_STORE},200,origin);
 if(u.pathname==='/'&&request.method==='GET')return reply({service:'九十刻度智能预测接口',status:'online',message:'请返回九十刻度网站查看。'},200,origin);

 if((u.pathname==='/publish'||u.pathname==='/settle')&&request.method==='PUT'){
  if(!env.PREDICTION_STORE)return reply({error:'storage_unconfigured'},503,origin);
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
  if(u.pathname==='/settle'){
   if(!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(data.date||'')||!Array.isArray(data.results)||data.results.length>100)return reply({error:'invalid_schema'},400,origin);
   const store=env.PREDICTION_STORE.get(env.PREDICTION_STORE.idFromName('verified-predictions'));
   const written=await store.fetch('https://internal/settle?date='+data.date,{method:'PUT',body:raw});
   return reply(await written.json(),written.status,origin);
  }
  if(data.schema_version!==1||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(data.date||'')||!Array.isArray(data.matches)||data.matches.length>100)return reply({error:'invalid_schema'},400,origin);
  if(data.matches.some(m=>!m||typeof m!=='object'||m.verified!==true))return reply({error:'unverified_matches'},422,origin);
  // Do not publish untraceable predictions or allow warned matches into daily picks.
  const invalid=data.matches.some(m=>
    !String(m.source||'').trim() || !String(m.fixture_id||'').trim() ||
    !String(m.home||'').trim() ||
    !String(m.away||'').trim() ||
    !Number.isFinite(Date.parse(m.kickoff_at)) || !Number.isFinite(Date.parse(m.generated_at)) ||
    !Number.isFinite(Date.parse(m.source_fetched_at)) || Date.parse(m.source_fetched_at)>Date.parse(m.generated_at) ||
    Date.parse(m.generated_at)>=Date.parse(m.kickoff_at) ||
    !Array.isArray(m.wdl_top2) || m.wdl_top2.length!==2 ||
    !Array.isArray(m.score_top3) || m.score_top3.length!==3 ||
    !Array.isArray(m.htft_top3) || m.htft_top3.length!==3 ||
    !Array.isArray(m.goals_top3) || m.goals_top3.length!==3 ||
    (m.upset && m.daily_pick)
  );
  if(invalid)return reply({error:'prediction_validation_failed'},422,origin);
  const store=env.PREDICTION_STORE.get(env.PREDICTION_STORE.idFromName('verified-predictions'));
  const written=await store.fetch('https://internal/data?date='+data.date,{method:'PUT',body:JSON.stringify(data),headers:{'content-type':'application/json'}});
  if(written.status===422)return reply(await written.json(),422,origin);
  if(!written.ok)return reply({error:'storage_write_failed'},503,origin);
  return reply({ok:true,date:data.date,count:data.matches.length},200,origin);
 }
 if(!['/predictions','/statistics'].includes(u.pathname)||request.method!=='GET')return reply({error:'not_found'},404,origin);
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
 const id=env.PREDICTION_STORE.idFromName('verified-predictions');
 const store=env.PREDICTION_STORE.get(id);
 const result=await store.fetch('https://internal/'+(u.pathname==='/statistics'?'stats':'read')+'?date='+encodeURIComponent(date));
 const stored=result.ok?await result.text():null;
 return stored?new Response(stored,{status:200,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...(origin===ORIGIN?{'access-control-allow-origin':ORIGIN,'vary':'Origin'}:{})}}):reply({error:'not_published'},404,origin);
}};
// Storage is private: no public writes or direct public reads are exposed.
