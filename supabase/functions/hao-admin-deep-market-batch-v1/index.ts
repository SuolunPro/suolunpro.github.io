import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

// Read-only, administrator-only, isolated cross-project deep market feed.
// No writes, collectors, scheduled tasks, customer UI or prediction recomputation.
const sb=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{
  auth:{persistSession:false,autoRefreshToken:false}
});
const PRIMARY="https://ttydbcejxqxdkcfoizkj.supabase.co/functions/v1/soren-public-api-v1";
const KEY="sb_publishable_n5thZ1g6h93ronyzPfqhsg_N_lFaoSa";
const cors={"Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Headers":"authorization,apikey,content-type,x-client-info",
  "Access-Control-Allow-Methods":"GET,OPTIONS"};
const reply=(v:unknown,code=200)=>new Response(JSON.stringify(v),{status:code,headers:{
  ...cors,"Content-Type":"application/json; charset=utf-8","Cache-Control":"private,no-store",Vary:"Authorization"
}});
const val=(v:unknown)=>String(v??"").trim();
const clean=(v:unknown,max=300)=>val(v).replace(/<[^>]+>/g," ").replace(/\s+/g," ").slice(0,max);
const simpleNum=(v:unknown)=>Number.isFinite(Number(v))?Number(v):null;
Deno.serve(async req=>{
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors});
  if(req.method!=="GET")return reply({ok:false,error:"METHOD_NOT_ALLOWED"},405);
  const token=(req.headers.get("authorization")||"").match(/^Bearer\s+(.+)$/i)?.[1]||"";
  if(!token)return reply({ok:false,error:"LOGIN_REQUIRED"},401);
  const u=new URL(req.url),date=val(u.searchParams.get("date"));
  const today=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()).split("/").join("-");
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||date>today||date<new Date(Date.now()-16*864e5).toISOString().slice(0,10))
    return reply({ok:false,error:"DATE_OUT_OF_RANGE"},400);
  try{
    // Authenticated user from the *primary* project, using the exact membership flag.
    const ctrl=AbortSignal.timeout(9000);
    const auth=await fetch(PRIMARY+"?view=membership",{
      method:"GET",headers:{apikey:KEY,Authorization:"Bearer "+token},signal:ctrl,cache:"no-store"
    });
    if(!auth.ok)return reply({ok:false,error:auth.status===401?"LOGIN_REQUIRED":"ADMIN_AUTH_UNAVAILABLE"},auth.status===401?401:503);
    const result=await auth.json().catch(()=>null);
    if(result?.ok!==true||result?.membership?.isAdmin!==true)
      return reply({ok:false,error:"ADMIN_REQUIRED"},403);
    const {data:offerings,error:offerError}=await sb.from("jc_offerings_2026")
      .select("id,offer_date,match_no,home_team,away_team,kickoff_local")
      .eq("offer_date",date).order("match_no",{ascending:true}).limit(50);
    if(offerError)throw offerError;
    const pool=offerings||[];
    if(pool.length===0)return reply({ok:true,date,rows:[],asOf:new Date().toISOString(),source:"hao_okooo_analysis_shadow_v01"});
    const ids=pool.map((x:any)=>x.id);
    const {data:analyses,error:analysisError}=await sb.from("hao_okooo_analysis_shadow_v01")
      .select("offering_id,analysis,captured_at,timing_quality,market_status,intel_status")
      .in("offering_id",ids).order("captured_at",{ascending:false}).limit(450);
    if(analysisError)throw analysisError;
    const byId=new Map<number,any>();
    for(const offering of pool){
      const kickoff=Date.parse(val(offering.kickoff_local).replace(" ","T")+"+08:00");
      if(!Number.isFinite(kickoff))continue;
      for(const x of analyses||[]){
        if(Number(x.offering_id)!==Number(offering.id))continue;
        const at=Date.parse(x.captured_at||"");
        if(!(Number.isFinite(at)&&at<kickoff&&at<=Date.now()))continue;
        const existing=byId.get(Number(offering.id));
        if(!existing||Date.parse(existing.captured_at)<at)byId.set(Number(offering.id),x);
        break;
      }
    }
    const rows=pool.map((o:any)=>{
      const a=byId.get(Number(o.id));
      if(!a)return {no:String(o.match_no).padStart(3,"0"),available:false,reason:"NO_VALID_PREMATCH_SNAPSHOT"};
      const data=a.analysis&&typeof a.analysis==="object"?a.analysis:{};
      const m99=data.market_99&&typeof data.market_99==="object"?data.market_99:{};
      const bf=data.betfair&&typeof data.betfair==="object"?data.betfair:{};
      const kelly=data.kelly&&typeof data.kelly==="object"?data.kelly:{};
      const intel=data.intelligence&&typeof data.intelligence==="object"?data.intelligence:{};
      const pct=m99.probabilities_pct||{},share=bf.share_pct||{};
      return {
        no:String(o.match_no).padStart(3,"0"),available:true,
        match:{home:o.home_team,away:o.away_team,kickoffLocal:o.kickoff_local},
        capturedAt:a.captured_at,timingQuality:a.timing_quality,
        marketStatus:a.market_status,intelStatus:a.intel_status,
        market99:{top:clean(m99.top,14),home:simpleNum(pct.home),
          draw:simpleNum(pct.draw),away:simpleNum(pct.away)},
        betfair:{top:clean(bf.top,14),home:simpleNum(share.home),
          draw:simpleNum(share.draw),away:simpleNum(share.away)},
        kelly:{status:clean(kelly.status,55),top:clean(kelly.lowest_direction,14),
          completeCount:simpleNum(kelly.complete_count),value:simpleNum(kelly.lowest_value)},
        intelligence:{summary:clean(intel.semantic_summary,360),impactSide:clean(intel.impact_side,45),
          impactLevel:clean(intel.impact_level,30),confidence:clean(intel.confidence,20)},
        level:clean(data.level,40),summary:clean(data.summary,480),
        flags:Array.isArray(data.flags)?data.flags.slice(0,5).map((x:unknown)=>clean(x,140)):[],
        shadowOnly:true
      };
    });
    return reply({ok:true,date,rows,asOf:new Date().toISOString(),
      source:"hao_okooo_analysis_shadow_v01",shadowOnly:true,
      note:"管理员专用：按竞彩号读取独立澳客99家、必发、凯利、国内情报分析。只选开球前采集快照；不将凯利最低方向直接等同结果。"});
  }catch(e){console.error("ADMIN_DEEP_BATCH_FAILED",e);return reply({ok:false,error:"DEEP_DATA_UNAVAILABLE"},503)}
});
