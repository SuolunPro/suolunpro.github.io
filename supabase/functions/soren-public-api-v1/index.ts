import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

/* Singapore-only, truthful contract adapter for the unchanged production frontend.
   Do NOT send data to either legacy Supabase project.
   Do NOT promote provisional outputs to formal pregame forecasts. */
const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SECRET_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  {auth:{persistSession:false,autoRefreshToken:false}}
);
const headers={
  "access-control-allow-origin":"*",
  "access-control-allow-headers":"authorization, apikey, content-type, x-client-info, x-soren-device",
  "access-control-allow-methods":"GET, OPTIONS",
  "cache-control":"no-store",
};
const reply=(body:unknown,status=200)=>Response.json(body,{status,headers});
const currentBjt=()=>new Intl.DateTimeFormat("en-CA",{
  timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"
}).format(new Date());
const validDate=(v:string)=>/^\d{4}-\d{2}-\d{2}$/.test(v)&&!Number.isNaN(Date.parse(v+"T00:00:00Z"));
const label=(v:unknown)=>{
  if(v==="平局"||v==="平")return "平";
  if(v==="主胜"||v==="客胜")return v;
  return null;
};
const pct=(v:unknown)=>{
  const x=Number(v);return v!==null&&v!==undefined&&Number.isFinite(x)&&x>=0&&x<=1?+(x*100).toFixed(2):null;
};
const out=(m:any,key:string)=>m?.outputs?.[key]?.payload??null;
const formal=(m:any,key:string)=>{
  const x=m?.outputs?.[key];const kickoff=Date.parse(String(m?.kickoff_at||""));
  const produced=Date.parse(String(x?.produced_at||""));
  return x&&["formal","verified","published"].includes(String(x.quality).toLowerCase())
    &&Number.isFinite(kickoff)&&Number.isFinite(produced)&&produced<kickoff;
};
function adaptRow(m:any,date:string){
  const f=out(m,"ft"), h=out(m,"handicap"), daily=out(m,"daily_selection");
  const risk=out(m,"upset_warning"), score=out(m,"score_top3");
  const goals=out(m,"total_goals"), htft=out(m,"htft_top3");
  const fRank=Array.isArray(f?.top3)?f.top3:[];
  const hRank=Array.isArray(h?.top3)?h.top3:[];
  const ftReady=f?.status==="READY" && fRank.length>=2;
  const hadReady=h?.status==="READY" && hRank.length>=2;
  const hasVerifiedPrematch=["ft","handicap","daily_selection","upset_warning","score_top3","htft_top3","total_goals"].some(k=>formal(m,k));
  const vr=m?.result?.verified===true;
  const rh=vr?Number(m.result?.home??m.result?.home_score):null;
  const ra=vr?Number(m.result?.away??m.result?.away_score):null;
  const scored=vr&&Number.isInteger(rh)&&Number.isInteger(ra)&&rh>=0&&ra>=0;
  const actual=scored?(rh>ra?"主胜":rh===ra?"平":"客胜"):null;
  const warn=Boolean(formal(m,"upset_warning")&&risk?.triggered===true&&risk?.status==="TRIGGERED");
  const selected=Boolean(formal(m,"daily_selection")&&daily?.status==="SELECTED"&&!warn&&!m.upset_locked);
  const dates=Object.values(m?.outputs||{}).map((x:any)=>Date.parse(String(x?.produced_at||""))).filter(Number.isFinite);
  const frozenAt=dates.length?new Date(Math.max(...dates)).toISOString():null;
  return {
    date,no:String(m.match_no||"").padStart(3,"0"),league:m.league??"",
    home:m.home_team??"",away:m.away_team??"",kickoff:m.kickoff_at??null,
    matchStatus:String(m.status||"").toLowerCase()==="postponed"?"POSTPONED":String(m.status||"").toUpperCase(),
    resultVerified:scored,result:actual,resultHome:scored?rh:null,resultAway:scored?ra:null,
    resultScore:scored?rh+":"+ra:null,
    pregameVerified:hasVerifiedPrematch,
    saleFreezeStatus:hasVerifiedPrematch?"VERIFIED_PREMATCH":"SHADOW_PROVISIONAL_NOT_FROZEN",
    predictionState:hasVerifiedPrematch?"LIVE_OR_FROZEN":"SHADOW_NOT_FORMAL",
    frozenAt:hasVerifiedPrematch?frozenAt:null,
    analysisPending:!hasVerifiedPrematch,
    ftTop1:ftReady?label(fRank[0]?.direction):null,
    second:ftReady?label(fRank[1]?.direction):null,
    homeProbability:ftReady?pct(f?.probabilities?.home):null,
    drawProbability:ftReady?pct(f?.probabilities?.draw):null,
    awayProbability:ftReady?pct(f?.probabilities?.away):null,
    confidence:ftReady?pct(fRank[0]?.probability):null,
    officialHandicap:hadReady?(h?.handicap_line??null):null,
    handicapTop1:hadReady?hRank[0]?.direction:null,
    handicapSecond:hadReady?hRank[1]?.direction:null,
    handicapProbability:hadReady?pct(hRank[0]?.probability):null,
    handicapSecondProbability:hadReady?pct(hRank[1]?.probability):null,
    handicapSourceLabel:hadReady?"新加坡影子概率（未正式冻结）":null,
    dailySelectionTier:selected?(daily?.tier==="稳健"?"CORE":"SUPPLEMENT"):null,
    dailySelectionRiskLocked:warn||m.upset_locked===true,
    upsetWarning:warn?{
      publish:true,publicationEligible:true,riskDisplayEligible:true,riskLevel:"影子已核验",
      direction:risk?.direction??null,originalTop1:label(fRank[0]?.direction),
      riskBasis:Array.isArray(risk?.evidence)?risk.evidence:[],
      prematchAt:m?.outputs?.upset_warning?.produced_at??null
    }:null,
    // Three score candidates are not a published Top4. Do not pad or mislabel.
    scoreTop4:null,htftTop4:null,goalPrediction:null,dynamicScoreTop4:null,
    dynamicHTFT:null,dynamicGoalPrediction:null,
    shadowAnalysis:{
      revision:"singapore_shadow_adapter_0.1",provisional:!hasVerifiedPrematch,
      source_match_key:m.match_key,ft:f,handicap:h,score_top3:score,
      htft_top3:htft,total_goals:goals,daily_selection:daily,upset_warning:risk,
      produced_at:frozenAt
    }
  };
}
Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers});
  if(req.method!=="GET")return reply({ok:false,error:"METHOD_NOT_ALLOWED"},405);
  const url=new URL(req.url),view=url.searchParams.get("view")||"today";
  if(url.pathname.endsWith("/health")||url.searchParams.get("health")==="compat"){
    return reply({ok:true,service:"soren-public-api-v1",shadow:true,revision:"singapore_adapter_0.1",legacy_runtime_dependency:false,now:new Date().toISOString()});
  }
  const jwt=(req.headers.get("authorization")||"").match(/^Bearer\s+(.+)$/i)?.[1];
  if(!jwt)return reply({ok:false,error:"LOGIN_REQUIRED"},401);
  const auth=await sb.auth.getUser(jwt);
  if(auth.error||!auth.data.user)return reply({ok:false,error:"LOGIN_REQUIRED"},401);
  const user=auth.data.user;
  const admin=user.app_metadata?.role==="admin"||user.app_metadata?.is_admin===true;
  const mem=await sb.rpc("ninety_membership_status",{p_user_id:user.id});
  if(mem.error)return reply({ok:false,error:"MEMBERSHIP_STATUS_UNAVAILABLE"},503);
  const member=mem.data||{active:false,tier:"free"};
  const vip=Boolean(admin||(member.active&&["vip_monthly","vip_manual","admin"].includes(member.tier)));
  const membership={
    active:vip,vipActive:vip,isAdmin:admin,trialStatus:null,
    tier:admin?"admin":member.tier??"free",
    vipUntil:member.ends_at??null,memberUntil:member.ends_at??null,
    shadow:true
  };
  if(view==="membership")return reply({ok:true,membership});
  const date=url.searchParams.get("date")||currentBjt();
  if(!validDate(date))return reply({ok:false,error:"INVALID_DATE"},400);
  try{
    const x=await sb.rpc("ninety_customer_payload",{p_date:date});
    if(x.error)throw x.error;
    const all=Array.isArray(x.data?.matches)?x.data.matches:[];
    const history=date<currentBjt();
    const matches=vip?all:history?
      all.map((m:any)=>({...m,outputs:Object.fromEntries(Object.entries(m.outputs||{}).filter(([k])=>k!=="upset_warning"))})):
      all.map((m:any,i:number)=>({...m,outputs:i<2&&m.outputs?.ft?{ft:m.outputs.ft}:{} }));
    const rows=matches.map((m:any)=>adaptRow(m,date));
    if(view==="cold-feed"||view==="member-zone"){
      if(!vip)return reply({ok:false,error:"VIP_REQUIRED"},403);
      const published=rows.filter((r:any)=>r.upsetWarning?.publish===true);
      return reply({ok:true,date,shadow:true,routeRuleVersion:"SG-PENDING-FORMAL",
        count:published.length,rows:published.map((r:any)=>({...r,coldRecognition:{customerVisible:true,vipPublish:true}})),
        partial:true,publishedOnly:true});
    }
    if(view==="history"){
      const settled=rows.filter((r:any)=>r.resultVerified);
      return reply({ok:true,date,view,count:settled.length,rows:settled,
        modelVersion:"SG-ADAPTER-0.1",analysisPending:true,shadow:true});
    }
    if(view==="market-trend"||view==="report"||view==="member-intel"||view==="admin-overseas-intel"){
      return reply({ok:false,error:"FEATURE_NOT_MIGRATED",view,shadow:true},501);
    }
    if(!["today","archive"].includes(view))
      return reply({ok:false,error:"UNKNOWN_VIEW",view},400);
    const latest=all.flatMap((m:any)=>Object.values(m.outputs||{}).map((o:any)=>String(o?.produced_at||""))).sort().at(-1)||null;
    const pending=rows.some((r:any)=>r.analysisPending===true);
    return reply({ok:true,view,date,count:rows.length,rows,model:"九十刻度 · 新加坡影子",
      modelVersion:"SG-ADAPTER-0.1",revision:"singapore_adapter_0.1",shadow:true,
      analysisPending:pending,publicationStatus:pending?"SHADOW_PENDING_FORMAL":"PUBLISHED",
      batchTime:latest,pregameVerifiedCount:rows.filter((r:any)=>r.pregameVerified).length,
      upsetStats:{published:rows.filter((r:any)=>r.upsetWarning?.publish===true).length},
      dailySelectionStats:{core:rows.filter((r:any)=>r.dailySelectionTier==="CORE").length,
        supplement:rows.filter((r:any)=>r.dailySelectionTier==="SUPPLEMENT").length}
    });
  }catch(e){console.error("SG_COMPAT_FAILURE",e);return reply({ok:false,error:"SG_COMPAT_UNAVAILABLE"},503)}
});
