import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const sb=createClient(Deno.env.get("SUPABASE_URL")!, (Deno.env.get("SUPABASE_SECRET_KEY")||Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"))!, {auth:{persistSession:false,autoRefreshToken:false}});
const bjt=(d:Date)=>new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(d);
async function fetchLeague(id:number,season:string) {
  const url="https://www.fotmob.com/api/data/leagues?id="+id+"&season="+encodeURIComponent(season);
  let error="";
  for(let n=0;n<2;n++){
    try{
      const r=await fetch(url,{headers:{"User-Agent":"Mozilla/5.0","Accept":"application/json"},signal:AbortSignal.timeout(12000)});
      if(!r.ok)throw new Error("FotMob HTTP "+r.status);
      return (await r.json())?.fixtures?.allMatches||[];
    }catch(e){error=String(e)}
  }
  throw new Error(error);
}
function ftScore(f:any){
  const st=f?.status||{},reason=st.reason||{};
  if(st.finished!==true||st.cancelled===true||st.awarded===true||reason.short!=="FT")return null;
  const score=String(st.scoreStr||"").match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
  return score?[Number(score[1]),Number(score[2])]:null;
}
Deno.serve(async(req:Request)=>{
  if(req.method!=="POST")return Response.json({ok:false,error:"POST_REQUIRED"},{status:405});
  const token=req.headers.get("x-ninety-collector-token")||"";
  const access=await sb.schema("ninety_core").rpc("check_collector_token",{p_token:token});
  if(access.error||access.data!==true)return Response.json({ok:false,error:"CRON_TOKEN_REQUIRED"},{status:403});
  const started=new Date();
  const today=bjt(started),yesterday=bjt(new Date(started.getTime()-86400000));
  const diagnostics:any[]=[],verified:any[]=[],conflicts:any[]=[],toWrite:any[]=[];
  try{
    const {data:elos,error:ee}=await sb.schema("ninety_core").from("elo_match_scores")
      .select("match_key,match_date,match_no,league_id,season_label,fotmob_match_id,home_team_id,away_team_id")
      .gte("match_date",yesterday).lte("match_date",today).limit(200);
    if(ee)throw ee;
    const ids=(elos||[]).map((e:any)=>e.match_key);
    const {data:pool,error:pe}=await sb.schema("ninety_core").from("match_pool")
      .select("match_key,match_date,match_no,league,home_team,away_team,kickoff_at,status")
      .gte("match_date",yesterday).lte("match_date",today).neq("status","invalid_test").limit(200);
    if(pe)throw pe;
    const keys=(pool||[]).map((m:any)=>m.match_key);
    if(!keys.length)return Response.json({ok:true,checked:0,verified:0,conflicts:0,diagnostics});
    const {data:states,error:se}=await sb.schema("ninety_core").from("source_state")
      .select("match_key,field_key,source_name,payload,quality,observed_at").in("match_key",keys).eq("field_key","result");
    if(se)throw se;
    const pm=new Map((pool||[]).map((x:any)=>[x.match_key,x]));
    const sm=new Map((states||[]).map((x:any)=>[x.match_key,x]));
    const candidates=(elos||[]).filter((e:any)=>{
      const m:any=pm.get(e.match_key),s:any=sm.get(e.match_key);
      return m&&s&&s.quality==="provisional"&&s.source_name==="qiulaile_result_fallback"
        &&m.status==="finished"&&new Date(m.kickoff_at).getTime()<Date.now()-2*3600000;
    });
    const groups=new Map<string,any[]>();
    for(const e of candidates){const k=e.league_id+"|"+e.season_label;if(!groups.has(k))groups.set(k,[]);groups.get(k)!.push(e)}
    for(const [key,entries] of groups){
      const [id,season]=key.split("|");
      let fixtures:any[];
      try{fixtures=await fetchLeague(Number(id),season)}catch(error){diagnostics.push({league_id:id,error:String(error)});continue}
      const fm=new Map(fixtures.map((f:any)=>[Number(f.id),f]));
      for(const e of entries){
        const f:any=fm.get(Number(e.fotmob_match_id)),m:any=pm.get(e.match_key),s:any=sm.get(e.match_key);
        if(!f){diagnostics.push({match_key:e.match_key,status:"FOTMOB_FIXTURE_MISSING"});continue}
        if(Number(f.home?.id)!==Number(e.home_team_id)||Number(f.away?.id)!==Number(e.away_team_id)
          ||Math.abs(new Date(f.status?.utcTime).getTime()-new Date(m.kickoff_at).getTime())>10*60000){
          diagnostics.push({match_key:e.match_key,status:"IDENTITY_MISMATCH"});continue;
        }
        const score=ftScore(f);
        if(!score){diagnostics.push({match_key:e.match_key,status:"FOTMOB_90MIN_NOT_FINAL"});continue}
        const mh=Number(s.payload?.home_score),ma=Number(s.payload?.away_score);
        if(!Number.isInteger(mh)||!Number.isInteger(ma)){diagnostics.push({match_key:e.match_key,status:"MIRROR_SCORE_INVALID"});continue}
        if(score[0]!==mh||score[1]!==ma){
          conflicts.push({match_key:e.match_key,mirror:[mh,ma],fotmob:score});
          continue;
        }
        const payload={home_score:mh,away_score:ma,verified:true,match_scope:"90min_ft",
          sources:[{name:"qiulaile_result_fallback",match_id:s.payload?.source_match_id,observed_at:s.observed_at},
                   {name:"fotmob_league_ft",match_id:e.fotmob_match_id,league_id:e.league_id,season:e.season_label}],
          verified_at:new Date().toISOString()};
        toWrite.push({...m,fields:[{field_key:"result",source_name:"qiulaile_fotmob_agreement",payload,quality:"verified",observed_at:new Date().toISOString()}]});
        verified.push({match_key:e.match_key,score:mh+"-"+ma});
      }
    }
    const noElo=(pool||[]).filter((m:any)=>{
      const s:any=sm.get(m.match_key);
      return !ids.includes(m.match_key)&&s?.quality==="provisional"
        &&s.source_name==="qiulaile_result_fallback"&&m.status==="finished"
        &&new Date(m.kickoff_at).getTime()<Date.now()-2*3600000;
    });
    if(noElo.length){
      const names=[...new Set(noElo.flatMap((m:any)=>[m.home_team,m.away_team]))];
      const {data:aliases,error:ae}=await sb.schema("ninety_core").from("hao_team_alias_fotmob_v01")
        .select("jc_team,fotmob_team_id").in("jc_team",names);
      if(ae)throw ae;
      const amap=new Map<string,number>();
      for(const name of names){
        const unique=[...new Set((aliases||[]).filter((a:any)=>a.jc_team===name)
          .map((a:any)=>Number(a.fotmob_team_id)).filter(Number.isFinite))];
        if(unique.length===1)amap.set(name,unique[0]);
      }
      const teamCache=new Map<number,any>();
      for(const m of noElo){
        const hid=amap.get(m.home_team),aid=amap.get(m.away_team);
        if(!hid&&!aid){diagnostics.push({match_key:m.match_key,status:"BOTH_ALIASES_UNCONFIRMED"});continue}
        const lookupId=hid||aid;
        let team:any;
        try{
          if(!teamCache.has(lookupId)){
            const url="https://www.fotmob.com/api/data/teams?id="+lookupId;
            const resp=await fetch(url,{headers:{"User-Agent":"Mozilla/5.0","Accept":"application/json"},
              signal:AbortSignal.timeout(12000)});
            if(!resp.ok)throw new Error("FotMob team HTTP "+resp.status);
            teamCache.set(lookupId,await resp.json());
          }
          team=teamCache.get(lookupId);
        }catch(error){diagnostics.push({match_key:m.match_key,status:"FOTMOB_TEAM_FETCH_FAILED",error:String(error)});continue}
        const fixture=(team?.fixtures?.allFixtures?.fixtures||[]).filter((f:any)=>
          (!hid||Number(f.home?.id)===hid)&&(!aid||Number(f.away?.id)===aid)&&
          Math.abs(new Date(f.status?.utcTime).getTime()-new Date(m.kickoff_at).getTime())<=10*60000);
        if(fixture.length!==1){diagnostics.push({match_key:m.match_key,status:"FIXTURE_UNCONFIRMED",candidates:fixture.length});continue}
        const score=ftScore(fixture[0]),s:any=sm.get(m.match_key);
        if(!score){diagnostics.push({match_key:m.match_key,status:"FOTMOB_90MIN_NOT_FINAL"});continue}
        const mh=Number(s.payload?.home_score),ma=Number(s.payload?.away_score);
        if(!Number.isInteger(mh)||!Number.isInteger(ma)){diagnostics.push({match_key:m.match_key,status:"MIRROR_SCORE_INVALID"});continue}
        if(score[0]!==mh||score[1]!==ma){
          conflicts.push({match_key:m.match_key,mirror:[mh,ma],fotmob:score});continue;
        }
        const payload={home_score:mh,away_score:ma,verified:true,match_scope:"90min_ft",
          sources:[{name:"qiulaile_result_fallback",match_id:s.payload?.source_match_id,observed_at:s.observed_at},
            {name:"fotmob_team_fixture_ft",match_id:fixture[0].id,home_id:Number(fixture[0].home?.id),away_id:Number(fixture[0].away?.id),identity_method:hid&&aid?"both_team_ids":"one_team_id_unique_kickoff"}],
          verified_at:new Date().toISOString()};
        toWrite.push({...m,fields:[{field_key:"result",source_name:"qiulaile_fotmob_agreement",
          payload,quality:"verified",observed_at:new Date().toISOString()}]});
        verified.push({match_key:m.match_key,score:mh+"-"+ma});
      }
    }
    if(toWrite.length){
      const result=await sb.rpc("ninety_ingest_batch",{p_payload:{source_name:"ninety_dual_source_result_verifier_v1",matches:toWrite}});
      if(result.error)throw result.error;
      diagnostics.push({status:"BATCH_WRITTEN",run_id:result.data?.run_id,fields_changed:result.data?.fields_changed});
    }
    if(conflicts.length||diagnostics.some((x:any)=>x.status!=="BATCH_WRITTEN")){
      await sb.schema("ninety_core").from("ingest_runs").insert({source_name:"ninety_result_verification_audit_v1",status:conflicts.length?"conflict":"partial",
        finished_at:new Date().toISOString(),summary:{checked:candidates.length+noElo.length,verified:verified.length,conflicts,diagnostics}});
    }
    return Response.json({ok:true,date_range:[yesterday,today],checked:candidates.length+noElo.length,verified:verified.length,
      conflicts:conflicts.length,rows:verified,conflict_rows:conflicts,diagnostics,at:started.toISOString()});
  }catch(error){
    console.error("RESULT_VERIFICATION_FAILED",error);
    try {
      await sb.schema("ninety_core").from("ingest_runs").insert({
        source_name:"ninety_result_verification_audit_v1",status:"failed",
        started_at:started.toISOString(),finished_at:new Date().toISOString(),
        summary:{error:String(error).slice(0,1000)}
      });
    }catch(logError){console.error("RESULT_VERIFICATION_LOG_FAILED",logError)}
    return Response.json({ok:false,error:String(error),at:started.toISOString()},{status:500});
  }
});