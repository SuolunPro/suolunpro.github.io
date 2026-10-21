import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {createClient} from "npm:@supabase/supabase-js@2.95.0";
const sb=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SECRET_KEY")||Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false,autoRefreshToken:false}});
const db=sb.schema("ninety_core");
const bjt=(d:Date)=>new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(d);
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function getJson(url:string){
  let last="";
  for(let attempt=0;attempt<2;attempt++){
    try{
      const response=await fetch(url,{headers:{"accept":"application/json","user-agent":"Mozilla/5.0","cache-control":"no-cache"},signal:AbortSignal.timeout(13000)});
      if(!response.ok)throw Error("SOURCE_HTTP_"+response.status);
      return await response.json();
    }catch(e){last=String(e);if(attempt===0)await delay(600)}
  }
  throw Error(last);
}
const matchTime=(a:any,b:any)=>Number.isFinite(Date.parse(String(a||"")))&&Number.isFinite(Date.parse(String(b||"")))&&Math.abs(Date.parse(String(a))-Date.parse(String(b)))<=600000;
const validFt=(st:any)=>{
  const score=String(st?.scoreStr||"").match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
  return st?.finished===true&&st?.cancelled!==true&&st?.awarded!==true&&st?.reason?.short==="FT"&&score?[Number(score[1]),Number(score[2])]:null;
};
function verifiedHalf(info:any,ft:number[]){
  const events=info?.content?.matchFacts?.events?.events;
  const halves=Array.isArray(events)?events.filter((x:any)=>x?.type==="Half"&&x?.halfStrShort==="HT"):[];
  if(halves.length!==1)return null;
  const home=Number(halves[0]?.homeScore),away=Number(halves[0]?.awayScore);
  return Number.isInteger(home)&&Number.isInteger(away)&&home>=0&&away>=0&&home<=ft[0]&&away<=ft[1]?[home,away]:null;
}
Deno.serve(async(req:Request)=>{
  if(req.method!=="POST")return Response.json({ok:false,error:"POST_REQUIRED"},{status:405});
  const secret=req.headers.get("x-ninety-collector-token")||"";
  const token=await db.rpc("check_collector_token",{p_token:secret});
  if(token.error||token.data!==true)return Response.json({ok:false,error:"COLLECTOR_AUTH_REQUIRED"},{status:403});
  const now=new Date(),url=new URL(req.url),arg=url.searchParams.get("date");
  const lookback=Math.min(3,Math.max(2,Number(url.searchParams.get("lookback_days"))||2));
  const dates=arg&&/^20\d\d-\d\d-\d\d$/.test(arg)?[arg]:Array.from({length:lookback},(_,i)=>bjt(new Date(now.getTime()-i*86400000))).reverse();
  const dry=url.searchParams.get("dry")==="1",issues:any[]=[],verified:any[]=[],batch:any[]=[];
  try{
    const [{data:pool,error:pe},{data:elos,error:ee}]=await Promise.all([
      db.from("match_pool").select("match_key,match_date,match_no,league,home_team,away_team,kickoff_at,status").in("match_date",dates).neq("status","invalid_test").limit(180),
      db.from("elo_match_scores").select("match_key,league_id,season_label,fotmob_match_id,home_team_id,away_team_id").in("match_date",dates).limit(180)
    ]);
    if(pe||ee)throw pe||ee;
    const matches=(pool||[]).filter((m:any)=>Date.parse(String(m.kickoff_at))<Date.now()-90*60000&&m.status!=="invalid_test");
    const keys=matches.map((m:any)=>m.match_key);
    if(keys.length===0)return Response.json({ok:true,checked:0,verified:0,dry,dates});
    const {data:states,error:se}=await db.from("source_state").select("match_key,quality,payload,source_name").in("match_key",keys).eq("field_key","result");
    if(se)throw se;
    const resultBy=new Map((states||[]).map((s:any)=>[s.match_key,s]));
    const due=matches.filter((m:any)=>!["verified","conflict"].includes(String(resultBy.get(m.match_key)?.quality||"")));
    const eloBy=new Map((elos||[]).map((e:any)=>[e.match_key,e]));
    const names=[...new Set(due.flatMap((m:any)=>[m.home_team,m.away_team]))];
    const {data:aliases,error:ae}=names.length?await db.from("hao_team_alias_fotmob_v01").select("jc_team,fotmob_team_id").in("jc_team",names):{data:[],error:null};
    if(ae)throw ae;
    const alias=(name:string)=>{
      const ids=[...new Set((aliases||[]).filter((a:any)=>a.jc_team===name).map((a:any)=>Number(a.fotmob_team_id)).filter(Number.isInteger))];
      return ids.length===1?ids[0]:null;
    };
    const leagueCache=new Map<string,Promise<any>>(),teamCache=new Map<number,Promise<any>>();
    const league=(id:number,season:string)=>{const key=id+"|"+season;if(!leagueCache.has(key))leagueCache.set(key,getJson("https://www.fotmob.com/api/data/leagues?id="+id+"&season="+encodeURIComponent(season)));return leagueCache.get(key)!};
    const team=(id:number)=>{if(!teamCache.has(id))teamCache.set(id,getJson("https://www.fotmob.com/api/data/teams?id="+id));return teamCache.get(id)!};
    for(const m of due){
      try{
        const e=eloBy.get(m.match_key),h=alias(m.home_team),a=alias(m.away_team);
        let candidates:any[]=[],proof="";
        if(e?.fotmob_match_id&&e?.league_id&&e?.season_label&&e?.home_team_id&&e?.away_team_id){
          const fixtures=(await league(Number(e.league_id),String(e.season_label)))?.fixtures?.allMatches||[];
          candidates=fixtures.filter((f:any)=>Number(f?.id)===Number(e.fotmob_match_id)&&Number(f?.home?.id)===Number(e.home_team_id)&&Number(f?.away?.id)===Number(e.away_team_id)&&matchTime(f?.status?.utcTime,m.kickoff_at)&&!!validFt(f?.status));
          proof="ELO_KICKOFF_TEAM_IDS_AND_LEAGUE";
        }else if(h!==null&&a!==null){
          const fixtures=(await team(h))?.fixtures?.allFixtures?.fixtures||[];
          candidates=fixtures.filter((f:any)=>Number(f?.home?.id)===h&&Number(f?.away?.id)===a&&matchTime(f?.status?.utcTime,m.kickoff_at)&&!!validFt(f?.status));
          proof="BOTH_EXACT_TEAM_IDS_AND_KICKOFF";
        }else{
          issues.push({key:m.match_key,reason:"VERIFIED_TEAM_IDS_UNAVAILABLE"});continue;
        }
        if(candidates.length!==1){issues.push({key:m.match_key,reason:"NO_UNIQUE_VERIFIED_FIXTURE",candidates:candidates.length});continue}
        const fixture=candidates[0],score=validFt(fixture.status);
        const detail=await getJson("https://www.fotmob.com/api/data/matchDetails?matchId="+fixture.id);
        const hd=detail?.header?.status,teams=detail?.header?.teams||[],gd=detail?.general||{};
        const ds=validFt(hd),dh=Number(teams[0]?.score),da=Number(teams[1]?.score);
        if(!score||!ds||score[0]!==ds[0]||score[1]!==ds[1]||
          ds[0]!==dh||ds[1]!==da||teams.length!==2||
          String(gd.matchId)!==String(fixture.id)||
          Number(gd.homeTeam?.id)!==Number(fixture.home?.id)||
          Number(gd.awayTeam?.id)!==Number(fixture.away?.id)||
          Number(teams[0]?.id)!==Number(fixture.home?.id)||
          Number(teams[1]?.id)!==Number(fixture.away?.id)||
          !matchTime(gd.matchTimeUTCDate,m.kickoff_at)||
          !matchTime(hd.utcTime,m.kickoff_at)){
          issues.push({key:m.match_key,reason:"MATCH_DETAILS_CONFLICT"});continue;
        }
        const prior=resultBy.get(m.match_key)?.payload;
        if(prior?.home_score!=null&&prior?.away_score!=null
          &&(Number(prior.home_score)!==ds[0]||Number(prior.away_score)!==ds[1])){
          issues.push({key:m.match_key,reason:"PRIOR_RESULT_CONFLICT_REQUIRE_REVIEW"});continue;
        }
        const ht=verifiedHalf(detail,ds);
        const payload:any={home_score:ds[0],away_score:ds[1],verified:true,match_scope:"90min_ft",
          result_quality:"FOTMOB_TWO_ENDPOINTS_SAME_PROVIDER_EXACT_IDENTITY",
          sources:[{name:"fotmob_league_or_team_fixtures",match_id:Number(fixture.id),identity:proof},
                   {name:"fotmob_match_details",match_id:Number(gd.matchId)}],
          verified_at:new Date().toISOString()};
        if(ht){payload.half_home_score=ht[0];payload.half_away_score=ht[1];payload.halftime_verified=true;
          payload.halftime_source="fotmob_verified_ht_event";payload.halftime_match_id=Number(fixture.id);
          payload.halftime_verified_at=new Date().toISOString();}
        verified.push({key:m.match_key,score:ds.join("-"),ht:ht?.join("-")||null});
        batch.push({...m,status:"finished",fields:[{field_key:"result",source_name:"fotmob_two_endpoint_verified_ft",quality:"verified",payload,observed_at:new Date().toISOString()}]});
      }catch(e){issues.push({key:m.match_key,reason:"SOURCE_ERROR",error:String(e).slice(0,200)})}
    }
    let ingested:any=null,settled:any=null,hj38:any=null;
    if(!dry&&batch.length){
      const {data,error}=await sb.rpc("ninety_ingest_batch",{p_payload:{source_name:"ninety_fotmob_results_v1",matches:batch}});
      if(error)throw error;ingested=data;
      const r=await db.rpc("refresh_module_settlements_v1");
      if(r.error)throw r.error;settled=r.data;
      const h=await db.rpc("settle_hj38_predictions");
      if(h.error)throw h.error;hj38=h.data;
    }
    if(issues.length)await db.from("ingest_runs").insert({source_name:"ninety_fotmob_results_audit_v1",status:"partial",finished_at:new Date().toISOString(),summary:{dates,checked:due.length,verified:verified.length,issues:issues.slice(0,50),dry}});
    return Response.json({ok:true,dates,dry,checked:due.length,verified:verified.length,rows:verified,issues:issues.slice(0,50),ingested,settled,hj38});
  }catch(e){
    console.error("NINETY_FOTMOB_RESULT_FAILURE",e);
    return Response.json({ok:false,error:String(e),dates},{status:500});
  }
});