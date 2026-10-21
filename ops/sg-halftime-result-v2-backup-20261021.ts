import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";
const db=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SECRET_KEY")||Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false,autoRefreshToken:false}});
const day=(d:Date)=>new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(d);
const validScore=(v:any)=>Number.isInteger(v)&&v>=0;
async function halftime(fixtureId:number,match:any,source:any){
  const r=await fetch("https://www.fotmob.com/api/data/matchDetails?matchId="+fixtureId,{
    headers:{"Accept":"application/json","User-Agent":"Mozilla/5.0"},signal:AbortSignal.timeout(12000)});
  if(!r.ok)throw new Error("FotMob_HTTP_"+r.status);
  const f=await r.json(),g=f?.general||{},h=f?.header||{},st=h.status||{};
  if(String(g.matchId)!==String(fixtureId)||!st.finished||st.cancelled||st.awarded||st.reason?.short!=="FT")throw new Error("NOT_VERIFIED_FT");
  if(Math.abs(Date.parse(String(g.matchTimeUTCDate))-Date.parse(String(match.kickoff_at)))>900000)throw new Error("KICKOFF_MISMATCH");
  const teams=h.teams||[];
  if(teams.length!==2||Number(teams[0].id)!==Number(source.home_id)||Number(teams[1].id)!==Number(source.away_id))throw new Error("TEAM_ID_MISMATCH");
  const hf=Number(teams[0].score),af=Number(teams[1].score);
  if(!validScore(hf)||!validScore(af)||hf!==Number(match.result.home_score)||af!==Number(match.result.away_score))throw new Error("FINAL_SCORE_MISMATCH");
  const ev=f?.content?.matchFacts?.events?.events;
  if(!Array.isArray(ev))throw new Error("HALFTIME_EVENT_MISSING");
  const halves=ev.filter((e:any)=>e?.type==="Half"&&e?.halfStrShort==="HT");
  if(halves.length!==1)throw new Error("HALFTIME_EVENT_NOT_UNIQUE");
  const hh=Number(halves[0].homeScore),ha=Number(halves[0].awayScore);
  if(!validScore(hh)||!validScore(ha)||hh>hf||ha>af)throw new Error("HALFTIME_SCORE_INVALID");
  return {half_home_score:hh,half_away_score:ha,halftime_verified:true,halftime_source:"fotmob_matchdetails_halftime_event",halftime_match_id:fixtureId,halftime_verified_at:new Date().toISOString()};
}
Deno.serve(async(req:Request)=>{
  if(req.method!=="POST")return Response.json({ok:false,error:"POST_REQUIRED"},{status:405});
  const token=req.headers.get("x-ninety-collector-token")||"";
  const access=await db.schema("ninety_core").rpc("check_collector_token",{p_token:token});
  if(access.error||access.data!==true)return Response.json({ok:false,error:"CRON_TOKEN_REQUIRED"},{status:403});
  const now=new Date(),date=new URL(req.url).searchParams.get("date"),today=date&&/^20\\d{2}-\\d{2}-\\d{2}$/.test(date)?date:day(now);
  const yesterday=day(new Date(Date.parse(today+"T12:00:00+08:00")-86400000));
  const dry=new URL(req.url).searchParams.get("dry")==="1",issues:any[]=[],writes:any[]=[];
  try{
    const {data:pool,error:pe}=await db.schema("ninety_core").from("match_pool")
      .select("match_key,match_date,match_no,league,home_team,away_team,kickoff_at,status")
      .gte("match_date",yesterday).lte("match_date",today).neq("status","invalid_test").limit(120);
    if(pe)throw pe;
    const keys=(pool||[]).map((m:any)=>m.match_key);
    if(!keys.length)return Response.json({ok:true,checked:0,updated:0,dry});
    const {data:rows,error:re}=await db.schema("ninety_core").from("source_state")
      .select("match_key,payload,quality,source_name").in("match_key",keys).eq("field_key","result");
    if(re)throw re;
    const {data:aliases,error:ae}=await db.schema("ninety_core").from("hao_team_alias_full_v01")
      .select("jc_team,fotmob_team_id").limit(1000);
    if(ae)throw ae;
    const aliasMap=new Map<string,Set<number>>();
    for(const a of aliases||[]){
      const name=String(a.jc_team||"").trim();
      if(!aliasMap.has(name))aliasMap.set(name,new Set());
      aliasMap.get(name)!.add(Number(a.fotmob_team_id));
    }
    const uniqueId=(team:string)=>{const v=aliasMap.get(String(team||"").trim());return v?.size===1?[...v][0]:null;};
    const byKey=new Map((rows||[]).map((s:any)=>[s.match_key,s]));
    const targets=(pool||[]).map((m:any)=>{
      const row:any=byKey.get(m.match_key),payload=row?.payload;
      if(row?.quality!=="verified"||payload?.verified!==true||payload?.match_scope!=="90min_ft"||payload?.halftime_verified===true)return null;
      const candidates=payload.sources||[];
      const direct=candidates.find((s:any)=>s.name==="fotmob_team_fixture_ft"&&s.match_id&&s.home_id&&s.away_id);
      const league=candidates.find((s:any)=>s.name==="fotmob_league_ft"&&s.match_id);
      const homeId=direct?.home_id??uniqueId(m.home_team),awayId=direct?.away_id??uniqueId(m.away_team);
      const source=direct||((league&&homeId&&awayId)?{...league,home_id:homeId,away_id:awayId}:null);
      return source?{...m,result:payload,source}:null;
    }).filter(Boolean) as any[];
    for(let i=0;i<targets.length;i+=4){
      await Promise.all(targets.slice(i,i+4).map(async (m:any)=>{
        try{
          const score=await halftime(Number(m.source.match_id),m,m.source);
          const {result,source,...meta}=m;
          writes.push({...meta,fields:[{field_key:"result",source_name:"qiulaile_fotmob_agreement",
            quality:"verified",observed_at:new Date().toISOString(),
            payload:{...result,...score}}]});
        }catch(err){issues.push({match_key:m.match_key,reason:String(err).slice(0,150)});}
      }));
    }
    let published:any=null;
    if(writes.length&&!dry){
      const {data,error}=await db.rpc("ninety_ingest_batch",{p_payload:{source_name:"ninety_halftime_result_verifier_v1",matches:writes}});
      if(error)throw error;published=data;
    }
    return Response.json({ok:true,dry,date_range:[yesterday,today],checked:targets.length,
      updated:dry?0:writes.length,ready_to_update:writes.length,issues:issues.slice(0,20),published});
  }catch(err){console.error("HALFTIME_VERIFIER_FAILED",err);return Response.json({ok:false,error:String(err)},{status:500});}
});
