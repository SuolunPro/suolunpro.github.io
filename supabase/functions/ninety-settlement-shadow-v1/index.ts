import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {createClient} from "npm:@supabase/supabase-js@2.95.0";
Deno.serve(async(req:Request)=>{
 if(req.method!=="POST")return Response.json({ok:false,error:"POST_REQUIRED"},{status:405});
 const key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||Deno.env.get("SUPABASE_SECRET_KEY");
 if(!key)return Response.json({ok:false,error:"KEY_MISSING"},{status:503});
 const sb=createClient(Deno.env.get("SUPABASE_URL")!,key);
 const auth=await sb.schema("ninety_core").rpc("check_collector_token",{p_token:req.headers.get("x-ninety-collector-token")||""});
 if(auth.error||auth.data!==true)return Response.json({ok:false,error:"UNAUTHORIZED"},{status:403});
 try{
 const now=Date.now();
 const urls=["https://raw.githubusercontent.com/SuolunPro/suolunpro.github.io/main/data/engine4/latest.json?v="+Math.floor(now/60000)];
 const today=new Date(now+8*3600000).toISOString().slice(0,10);
 for(let offset=0;offset<4;offset++){const day=new Date(Date.parse(today+"T00:00:00Z")-offset*86400000).toISOString().slice(0,10);urls.push("https://raw.githubusercontent.com/SuolunPro/suolunpro.github.io/main/data/engine4/sales/"+day+".json?v="+Math.floor(now/60000))}
 const docs:any[]=[];const seen=new Set<string>();const sourceErrors:any[]=[];
 for(const url of urls){try{const resp=await fetch(url,{signal:AbortSignal.timeout(8000)});if(!resp.ok){sourceErrors.push({url:url.split("/").pop(),status:resp.status});continue}const doc=await resp.json();if(!Array.isArray(doc.matches)||!/^2026-[0-9]{2}-[0-9]{2}$/.test(String(doc.sale_day||""))||seen.has(doc.sale_day))continue;seen.add(doc.sale_day);docs.push(doc)}catch(e){sourceErrors.push({url:url.split("/").pop(),error:String(e).slice(0,80)})}}
 if(!docs.length)return Response.json({ok:false,error:"NO_VALID_SNAPSHOTS",source_errors:sourceErrors},{status:502});
 const work:any[]=[];
 for(const doc of docs){const due=doc.matches.filter((m:any)=>{const t=Date.parse(String(m.kickoff||"").replace(" ","T")+"+08:00");return Number.isFinite(t)&&t<now-7200000});
 const pending=due.filter((m:any)=>m.result_verification?.status!=="VERIFIED" && !m.settlement);
 const sample=pending;
 for(const m of sample)work.push({m,doc});
 }
 const sample=work;
 const due=work;const pending=work.filter(({m}:any)=>m.result_verification?.status!=="VERIFIED");
 const doc=docs[0];
 const results=[]; const auditErrors=[]; let auditWritten=0;
 for(const {m,doc} of sample){
  const id=Number(m.fotmob_match_id);
  if(!Number.isSafeInteger(id)||id<=0){results.push({match_no:m.match_no,status:"NO_FOTMOB_ID"});continue}
  try{
   const r=await fetch("https://www.fotmob.com/api/data/matchDetails?matchId="+id,{signal:AbortSignal.timeout(10000),headers:{"User-Agent":"Mozilla/5.0"}});
   if(!r.ok){results.push({match_no:m.match_no,status:"HTTP_"+r.status});continue}
   const d=await r.json(),h=d.header||{},teams=h.teams||{},status=h.status||{};
   const home=teams.home||teams[0],away=teams.away||teams[1];
   const kickoff=Date.parse(String(m.kickoff||"").replace(" ","T")+"+08:00");
   const fotmobKickoff=Date.parse(String(d.general?.matchTimeUTCDate||""));
   const valid=String(d.general?.matchId)===String(id)&&Number(d.general?.homeTeam?.id)===Number(m.fotmob_home_team_id)&&Number(d.general?.awayTeam?.id)===Number(m.fotmob_away_team_id)&&Number(home?.id)===Number(m.fotmob_home_team_id)&&Number(away?.id)===Number(m.fotmob_away_team_id)&&Number.isFinite(kickoff)&&Number.isFinite(fotmobKickoff)&&Math.abs(kickoff-fotmobKickoff)<=600000;
   const score=String(status.scoreStr||"").match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
   const ft=score?score[1]+":"+score[2]:null;
   const halves=((((d.content||{}).matchFacts||{}).events||{}).events||[]).filter((e:any)=>e.type==="Half"&&e.halfStrShort==="HT");
   const rawHt=halves.length===1&&Number.isInteger(halves[0].homeScore)&&Number.isInteger(halves[0].awayScore)?halves[0].homeScore+":"+halves[0].awayScore:null;
   const ht=rawHt??(ft==="0:0"?"0:0":null);
   const htSafe=ht&&score&&Number(ht.split(":")[0])<=Number(score[1])&&Number(ht.split(":")[1])<=Number(score[2]);
   const eligible=valid&&status.finished===true&&!status.cancelled&&!status.awarded&&(status.reason?.short==="FT"&&!/extra time|penalt/i.test(String(status.reason?.long||""))||status.reason?.short==="Pen"&&String(m.league)==="美职业"&&ft!==null&&String(status.scoreStr||"").trim()===String(score?.[1])+" - "+String(score?.[2])&&!(((((d.content||{}).matchFacts||{}).events||{}).events||[]).some((e:any)=>e.type==="Half"&&/^(1ET|2ET|ET)$/i.test(String(e.halfStrShort||"")))))&&!!ft&&!!htSafe&&Number(home?.score)===Number(score?.[1])&&Number(away?.score)===Number(score?.[2]);
   const auditStatus=!valid?"IDENTITY_MISMATCH":!eligible?"NOT_90MIN_FT":!m.settlement?"VERIFIED_UNPUBLISHED":m.settlement?.ft===ft&&m.settlement?.ht===ht?"MATCHES_PUBLISHED":"SCORE_DIFFERS";
   results.push({match_no:m.match_no,status:auditStatus,fotmob_ft:eligible?ft:null,fotmob_ht:eligible?ht:null,published_ft:m.settlement?.ft||null,diagnostics:eligible?undefined:{finished:status.finished,reason:status.reason?.short,score_string:status.scoreStr,header_scores:[home?.score,away?.score],ht_available:!!ht,identity_valid:valid}});
   if(eligible&&/^2026-[0-9]{2}-[0-9]{2}$/.test(String(doc.sale_day||""))){
    const saved=await sb.schema("ninety_core").from("engine4_result_shadow_audit").upsert({sale_day:doc.sale_day,match_no:String(m.match_no),fotmob_match_id:id,home_team_id:Number(m.fotmob_home_team_id),away_team_id:Number(m.fotmob_away_team_id),fotmob_ft:ft,fotmob_ht:ht,identity_verified:true,published_ft:m.settlement?.ft||null,audit_status:auditStatus,checked_at:new Date().toISOString()},{onConflict:"sale_day,match_no"});
    if(saved.error)auditErrors.push({match_no:m.match_no,error:saved.error.message});else auditWritten++;
   }
  }catch(e){results.push({match_no:m.match_no,status:"FETCH_ERROR",detail:String(e)})}
 }
 // Keep a durable per-match retry trail. A failed or unfinished fixture stays eligible on the next run.
 for(let i=0;i<sample.length;i++){
  const {m,doc}=sample[i],result=results[i]||{status:"UNKNOWN"};
  const existing=await sb.schema("ninety_core").from("engine4_result_attempts").select("attempts").eq("sale_day",doc.sale_day).eq("match_no",String(m.match_no)).maybeSingle();
  if(existing.error){auditErrors.push({match_no:m.match_no,error:"ATTEMPT_READ: "+existing.error.message});continue}
  const saved=await sb.schema("ninety_core").from("engine4_result_attempts").upsert({sale_day:doc.sale_day,match_no:String(m.match_no),fotmob_match_id:Number(m.fotmob_match_id)||null,status:String(result.status),detail:result,attempts:(existing.data?.attempts||0)+1,last_checked_at:new Date().toISOString()},{onConflict:"sale_day,match_no"});
  if(saved.error)auditErrors.push({match_no:m.match_no,error:"ATTEMPT_WRITE: "+saved.error.message});
 }
 let independentRun:any=[];
 if(auditWritten>0){
  for(const saleDay of [...new Set(sample.map(({doc}:any)=>doc.sale_day))]){
   try{
    const u=Deno.env.get("SUPABASE_URL")+"/functions/v1/ninety-settlement-compare-v1";
    const resp=await fetch(u,{method:"POST",headers:{"Content-Type":"application/json","Authorization":req.headers.get("Authorization")||"","apikey":req.headers.get("apikey")||"","x-ninety-collector-token":req.headers.get("x-ninety-collector-token")||""},body:JSON.stringify({sale_day:saleDay,independent:true}),signal:AbortSignal.timeout(20000)});
    const payload=await resp.json().catch(()=>({}));
    independentRun.push({sale_day:saleDay,http_status:resp.status,ok:payload.ok===true,results:(payload.results||[]).map((r:any)=>({match_no:r.match_no,status:r.status}))});
   }catch(e){independentRun.push({sale_day:saleDay,ok:false,error:String(e).slice(0,180)})}
  }
 }
 return Response.json({ok:true,mode:"automatic_settlement_verification",sale_days:docs.map((d:any)=>d.sale_day),total:docs.reduce((n:number,d:any)=>n+d.matches.length,0),due:due.length,pending:pending.length,checked:results.length,audit_written:auditWritten,audit_errors:auditErrors,independent_run:independentRun,results,checked_at:new Date().toISOString(),note:"Verification and settlement staging; website publication is downstream."});
 }catch(e){return Response.json({ok:false,error:String(e)},{status:502})}
});