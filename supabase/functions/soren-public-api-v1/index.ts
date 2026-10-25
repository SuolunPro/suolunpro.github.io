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
    &&x.payload?.shadow!==true
    &&Number.isFinite(kickoff)&&Number.isFinite(produced)&&produced<kickoff;
};
function adaptRow(m:any,date:string){
  const f=out(m,"ft"), h=out(m,"handicap"), daily=out(m,"daily_selection");
  const risk=out(m,"upset_warning"), score=out(m,"score_top3");
  const goals=out(m,"total_goals"), htft=out(m,"htft_top3");
  const fRank=Array.isArray(f?.top3)?f.top3:[];
  const hRank=Array.isArray(h?.top3)?h.top3:[];
  const ftReady=Boolean(formal(m,"ft")&&f?.status==="READY"&&fRank.length>=2);
  const hadReady=Boolean(formal(m,"handicap")&&h?.status==="READY"&&hRank.length>=2);
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
    pregameVerified:false,
    saleFreezeStatus:"SHADOW_PREMATCH_NOT_FORMAL",
    predictionState:hasVerifiedPrematch?"SHADOW_PREMATCH":"SHADOW_NOT_FORMAL",
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
    dailySelectionTier:null,dailySelectionCustomerPublished:false,
    dailySelectionRiskLocked:warn||m.upset_locked===true,
    upsetWarning:null,shadowUpsetWarningPending:warn,
    // Three score candidates are not a published Top4. Do not pad or mislabel.
    scoreTop4:null,htftTop4:null,goalPrediction:null,dynamicScoreTop4:null,
    dynamicHTFT:null,dynamicGoalPrediction:null,
    shadowAnalysis:null
  };
}
function shadowSupport(m:any){
  const ft=out(m,"ft"),handicap=out(m,"handicap"),score=out(m,"score_top3");
  const htft=out(m,"htft_top3"),goals=out(m,"total_goals"),daily=out(m,"daily_selection");
  const ftRank=Array.isArray(ft?.top3)?ft.top3:[],handicapRank=Array.isArray(handicap?.top3)?handicap.top3:[];
  const produced=(key:string)=>m?.outputs?.[key]?.produced_at??null;
  const pending=(payload:any,key:string)=>payload?.status==="READY"&&Array.isArray(payload?.top3)&&payload.top3.length===3?{
    sourceKind:"SG_PREMATCH_SHADOW",formalEligible:false,referenceOnly:true,
    modelMethod:payload.method??null,
    picks:payload.top3,publishedAt:produced(key),settlementStatus:"PENDING",top1Status:"PENDING"
  }:null;
  return {
    homeProbability:ft?.status==="READY"?pct(ft?.probabilities?.home):null,
    drawProbability:ft?.status==="READY"?pct(ft?.probabilities?.draw):null,
    awayProbability:ft?.status==="READY"?pct(ft?.probabilities?.away):null,
    confidence:ft?.status==="READY"?pct(ftRank[0]?.probability):null,
    shadowHandicap:handicap?.status==="READY"&&handicapRank.length>=2?{
      line:handicap?.handicap_line??null,top1:handicapRank[0]?.direction??null,second:handicapRank[1]?.direction??null,
      top1Probability:pct(handicapRank[0]?.probability),secondProbability:pct(handicapRank[1]?.probability)
    }:null,
    shadowScoreTop3:pending(score,"score_top3"),
    shadowHTFTTop3:pending(htft,"htft_top3"),
    shadowGoalsTop3:pending(goals,"total_goals"),
    shadowDailySelection:daily?.status==="SELECTED"?{
      selected:true,sourceKind:"SG_PREMATCH_SHADOW_DAILY",formalEligible:false,publishedAt:produced("daily_selection"),
      direction:daily?.direction??null,probability:daily?.probability??null,ftStatus:"PENDING",
      handicapDirection:null,handicapProbability:null,handicapLine:null
    }:null,
    dailySelectionTier:null,dailySelectionCustomerPublished:false
  };
}

/* Verified 90-minute scoring for STRICTLY prematch SG module snapshots.
   This is shadow scoring, never original Soren Top4, formal forecasts or VIP publishing.
   Exact match_key, both clubs, kickoff and production timestamp prevent cross-fixture
   joining, post-kickoff leakage or accidental promotion from stale snapshots. */
async function attachVerifiedModuleSettlements(rows:any[],matches:any[]){
  if(!rows.length||!matches.length)return rows;
  const keys=[...new Set(matches.map((m:any)=>String(m.match_key||""))
    .filter((v:string)=>/^[0-9]{8}-[0-9]{3}$/.test(v)))];
  if(!keys.length)return rows;
  const res=await sb.schema("ninety_core").from("module_settlements_v1")
    .select("match_key,module,forecast_at,forecast_revision,prediction_shadow,forecast_picks,actual,top1_hit,top3_hit,settlement_status,result_source,result_observed_at")
    .in("match_key",keys).order("forecast_at",{ascending:false}).limit(500);
  if(res.error)throw res.error;
  const byKey=new Map<string,any>();
  for(const e of res.data||[]){
    const k=String(e.match_key)+"|"+String(e.module);
    if(!byKey.has(k))byKey.set(k,e);
  }
  const matchNo=(n:any)=>String(n??"").padStart(3,"0");
  const result=rows.map((r:any)=>{
    const m=matches.find((x:any)=>matchNo(x.match_no)===matchNo(r.no)
      &&String(x.home_team)===String(r.home)&&String(x.away_team)===String(r.away)
      &&Number.isFinite(Date.parse(String(r.kickoff||"")))
      &&Math.abs(Date.parse(String(x.kickoff_at||""))-Date.parse(String(r.kickoff||"")))<60000);
    if(!m||String(m.status).toLowerCase()!=="finished")return r;
    const fields:any={score_top3:"shadowScoreTop3",htft_top3:"shadowHTFTTop3",total_goals:"shadowGoalsTop3"};
    const extras:any={};
    const shadowGrades:any={};
    for(const module of ["ft","handicap","score_top3","htft_top3","total_goals"]){
      const current=m.outputs?.[module];
      const e=byKey.get(String(m.match_key)+"|"+module);
      if(!e||e.prediction_shadow!==true||!current||current.payload?.status!=="READY")continue;
      const frozen=Date.parse(String(e.forecast_at||""));
      const displayed=Date.parse(String(current.produced_at||""));
      const ko=Date.parse(String(m.kickoff_at||""));
      if(!Number.isFinite(frozen)||!Number.isFinite(displayed)||!Number.isFinite(ko)
        ||frozen!==displayed||frozen>=ko)continue;
      const verified=e.settlement_status==="GRADED";
      // Top2 evaluation uses ONLY the exact two frozen prematch picks attached
      // to this match_key/module, never latest rankings or postmatch forecasts.
      const top2Picks=(module==="ft"||module==="handicap")&&Array.isArray(e.forecast_picks)
        ?e.forecast_picks.slice(0,2).map((x:any)=>String(x?.direction??"").replace("平局","平")):[];
      const top2Actual=module==="ft"?String(e.actual?.ft??"")
        :module==="handicap"?String(e.actual?.handicap_result??""):"";
      const validTop2=top2Picks.length===2&&new Set(top2Picks).size===2&&
        top2Picks.every((x:string)=>module==="ft"?["主胜","平","客胜"].includes(x):["让胜","让平","让负"].includes(x))&&
        (module==="ft"?["主胜","平","客胜"].includes(top2Actual):["让胜","让平","让负"].includes(top2Actual));
      const top2Status=verified&&validTop2?(top2Picks.includes(top2Actual)?"SUCCESS":"FAILURE"):"PENDING";
      const grade={
        forecastAt:e.forecast_at,sourceKind:"SG_PREMATCH_SHADOW",
        formalEligible:false,resultSource:e.result_source,
        resultObservedAt:e.result_observed_at,
        // Frontend verdict format is SUCCESS/FAILURE; provenance remains SHADOW.
        settlementStatus:verified?(e.top3_hit===true?"SUCCESS":"FAILURE"):"PENDING",
        gradeStatus:verified?"VERIFIED_SHADOW_SETTLED":e.settlement_status,
        top1Status:verified?(e.top1_hit===true?"SUCCESS":"FAILURE"):"PENDING",
        top2Status,
        top3Status:verified?(e.top3_hit===true?"SUCCESS":"FAILURE"):"PENDING",
        pendingReason:e.settlement_status==="PENDING_HALFTIME"?"HALFTIME_NOT_VERIFIED":null,
        actual:module==="score_top3"?e.actual?.score??null
          :module==="total_goals"?e.actual?.goals??null
          :module==="htft_top3"?(e.actual?.half_direction&&e.actual?.ft
            ?[e.actual.half_direction,e.actual.ft].map((v:string)=>v==="平"?"平局":v).join("/"):null)
          :e.actual?.ft??null,
        actualScore:e.actual?.score??null,
        halfScore:e.actual?.half_home_score===null||e.actual?.half_home_score===undefined
          ?null:e.actual.half_home_score+":"+e.actual.half_away_score,
        actualFT:e.actual?.ft??null,
        actualHandicap:e.actual?.handicap_result??null,
        actualGoals:e.actual?.goals??null
      };
      shadowGrades[module]=grade;
      if(fields[module]){
        extras[fields[module]]={
          ...(r[fields[module]]||{}),picks:e.forecast_picks,
          publishedAt:e.forecast_at,...grade
        };
      }else if(module==="handicap"){
        extras.shadowHandicap={...(r.shadowHandicap||{}),...grade};
      }
    }
    // Merge only independently verified 90-minute Singapore results; customer
    // FT / daily selection / cold-direction grades retain their original forecast.
    const matchResult=m.result||{};
    const verifiedSources=Array.isArray(matchResult.sources)?matchResult.sources:[];
    const home=Number(matchResult.home_score),away=Number(matchResult.away_score);
    const verifiedResult=matchResult.verified===true&&matchResult.match_scope==="90min_ft"&&
      verifiedSources.length>=2&&Number.isInteger(home)&&Number.isInteger(away)&&home>=0&&away>=0&&
      Date.parse(String(matchResult.verified_at||""))>=Date.parse(String(m.kickoff_at||""))&&
      Date.parse(String(matchResult.verified_at||""))<=Date.now();
    const conflicts=verifiedResult&&r.resultVerified===true&&
      (Number(r.resultHome)!==home||Number(r.resultAway)!==away);
    let finished=r;
    if(conflicts){
      finished={...r,resultVerified:false,resultSourceConflict:true,
        settlement:{...(r.settlement||{}),verified:false,ftTop1Status:"RESULT_CONFLICT",
          ftTop2Status:"RESULT_CONFLICT",handicapTop1Status:"RESULT_CONFLICT"}};
    }else if(verifiedResult&&r.pregameVerified===true){
      const ft=home>away?"主胜":home===away?"平":"客胜";
      const line=r.officialHandicap===null||r.officialHandicap===undefined?null:Number(r.officialHandicap);
      const had=Number.isInteger(line)?home+line>away?"让胜":home+line===away?"让平":"让负":null;
      const validH=["让胜","让平","让负"].includes(String(r.handicapTop1||""));
      const primary=String(r.ftTop1||""),secondary=String(r.second||"");
      finished={...r,resultVerified:true,result:ft,resultHome:home,resultAway:away,
        resultScore:home+":"+away,
        settlement:{...(r.settlement||{}),verified:true,source:"SG_INDEPENDENT_VERIFIED_90MIN",
          verifiedAt:matchResult.verified_at,homeScore:home,awayScore:away,score:home+":"+away,
          ftResult:ft,handicapResult:had,handicapActual:had==="让胜"?"主胜":had==="让平"?"平":had==="让负"?"客胜":null,
          ftTop1Status:primary?primary===ft?"SUCCESS":"FAILURE":"PENDING",
          ftTop2Status:primary?(primary===ft||secondary===ft?"SUCCESS":"FAILURE"):"PENDING",
          handicapTop1Status:validH&&had?(r.handicapTop1===had?"SUCCESS":"FAILURE"):"NOT_PUBLISHED"}};
    }
    return Object.keys(shadowGrades).length
      ?{...finished,...extras,shadowModuleSettlements:shadowGrades}:finished;
  });
  return result;
}

function adaptFormalPrediction(p:any,date:string){
  const scored=p.result_verified===true&&Number.isInteger(p.result_home)&&Number.isInteger(p.result_away);
  const actual=scored?(p.result_home>p.result_away?"主胜":p.result_home===p.result_away?"平":"客胜"):null;
  // Customer-visible verdicts come strictly from an independently verified 90-minute result
  // for a genuine pre-kickoff HJ38 frozen prediction. Top1 and Top2 are distinct.
  const first=label(p.top1),secondPick=label(p.second_pick);
  const officialLine=p.official_handicap===null||p.official_handicap===undefined
    ?null:Number(p.official_handicap);
  const handicapPick=String(p.handicap_pick??"");
  const handicapLabels:any={"让胜":"主胜","让平":"平","让负":"客胜","主胜":"主胜","平":"平","客胜":"客胜"};
  const publishedHandicap=Number.isInteger(officialLine)&&handicapLabels[handicapPick]!==undefined;
  const handicapActual=scored&&publishedHandicap
    ?(p.result_home+officialLine>p.result_away?"主胜":p.result_home+officialLine===p.result_away?"平":"客胜")
    :null;
  const settlement={
    verified:scored,source:"HJ38_FORMAL_PREMATCH_VERIFIED",
    ftTop1Status:scored&&first?(first===actual?"SUCCESS":"FAILURE"):"PENDING",
    ftTop2Status:scored&&first?(first===actual||secondPick===actual?"SUCCESS":"FAILURE"):"PENDING",
    handicapTop1Status:scored&&publishedHandicap
      ?(handicapLabels[handicapPick]===handicapActual?"SUCCESS":"FAILURE")
      :publishedHandicap?"PENDING":"NOT_PUBLISHED",
    handicapActual:handicapActual,
    officialHandicap:publishedHandicap?officialLine:null
  };
  const warning=p?.source_status?.upset_warning;
  const warningPublished=warning?.publish===true;
  const source=p?.source_status||{};
  const drawPct=pct(source?.p_final?.draw??source?.p_raw?.draw);
  const highDrawRisk=drawPct!==null&&drawPct>=29&&Number(p.official_handicap)===-1;
  const marketDirectionAnomaly=source?.market_direction_conflict===true;
  const formalEligible=source?.final_selection_eligible===true;
  const dow=new Date(date+"T12:00:00+08:00").getUTCDay();
  const saleDeadline=Date.parse(date+"T"+([0,6].includes(dow)?"23":"22")+":00:00+08:00");
  const kickoff=Date.parse(String(p.kickoff_bjt||""));
  const phaseDeadline=Math.min(saleDeadline,Number.isFinite(kickoff)?kickoff:Infinity);
  const livePrematch=Number.isFinite(phaseDeadline)&&Date.now()<phaseDeadline;
  // HJ formal eligibility alone never promotes to original Soren 今日优选.
  const productionRisk=warningPublished||highDrawRisk||marketDirectionAnomaly;
  const homeProbability=pct(source?.p_final?.home??source?.p_raw?.home);
  const drawProbability=pct(source?.p_final?.draw??source?.p_raw?.draw);
  const awayProbability=pct(source?.p_final?.away??source?.p_raw?.away);
  const confidence=pct(source?.top1_prob??Math.max(
    Number(source?.p_final?.home??source?.p_raw?.home??0),
    Number(source?.p_final?.draw??source?.p_raw?.draw??0),
    Number(source?.p_final?.away??source?.p_raw?.away??0),
  ));
  return {
    date,no:String(p.match_no||"").padStart(3,"0"),league:p.league??"",home:p.home_team??"",away:p.away_team??"",
    kickoff:p.kickoff_bjt??null,matchStatus:"SCHEDULED",resultVerified:scored,result:actual,
    resultHome:scored?p.result_home:null,resultAway:scored?p.result_away:null,
    resultScore:scored?`${p.result_home}:${p.result_away}`:null,settlement,
    pregameVerified:Boolean(p.frozen_at&&Date.parse(p.frozen_at)<Date.parse(p.kickoff_bjt)),
    saleFreezeStatus:livePrematch?"LIVE":"SALE_CLOSED_FROZEN",
    predictionState:"PREMATCH_VERIFIED",
    frozenAt:livePrematch?null:p.frozen_at??null,latestPrematchAt:p.frozen_at??null,
    analysisPending:false,ftTop1:label(p.top1),second:label(p.second_pick),
    homeProbability,drawProbability,awayProbability,confidence,
    mode:"PASS",hj38TicketMode:p.ticket_pick?(String(p.ticket_pick).includes("/")?"DOUBLE":"SINGLE"):(p.keep_discard==="KEEP"?"SINGLE":"PASS"),
    tier:"PASS",pass:true,hj38FormalEligible:formalEligible,
    officialHandicap:p.official_handicap??null,handicapTop1:p.handicap_pick&&p.handicap_pick!=="PASS"?p.handicap_pick:null,
    handicapSecond:null,handicapProbability:null,handicapSecondProbability:null,
    handicapSourceLabel:p.handicap_pick&&p.handicap_pick!=="PASS"?"豪竞3.8赛前冻结":null,
    dailySelectionTier:null,dailySelectionLabel:null,
    dailySelectionCustomerPublished:false,
    dailySelectionRiskLocked:productionRisk,
    dailySelectionRiskLockReason:warningPublished?"COLD_WARNING_PUBLISHED":
      highDrawRisk?"HIGH_DRAW_RISK":marketDirectionAnomaly?"MARKET_DIRECTION_ANOMALY_5PCT":null,
    sorenProduction:{ruleVersion:"SOREN-PRODUCTION-v237-COMPAT",selectorVersion:"DAILY-VALUE-v2.0-20261013",
      formalEligible,highDrawRisk,marketDirectionAnomaly,coldWarning:warningPublished,
      threeWayStatus:"SG_FUNDS_COLLECTED_VIP_GATE_PENDING",customerDailyPublished:false},
    upsetWarning:warningPublished?{publish:true,publicationEligible:true,riskDisplayEligible:true,
      riskLevel:warning.risk_level??null,direction:warning.warning_direction??null,originalTop1:label(p.top1),
      riskBasis:Array.isArray(warning.risk_basis)?warning.risk_basis:[],prematchAt:p.frozen_at}:null,
    scoreTop4:null,htftTop4:null,goalPrediction:null,dynamicScoreTop4:null,dynamicHTFT:null,
    dynamicGoalPrediction:null,shadowAnalysis:null
  };
}

// Verbatim customer environment contract from original Soren, backed solely by
// independently copied SG exact-fixture FotMob + pregame Open-Meteo records.
async function attachVerifiedDayEnvironment(rows:any[],date:string){
 if(!rows.length)return rows;
 const q=await sb.schema("ninety_core").from("soren_environment_cache_v1")
   .select("match_no,home_team,away_team,kickoff_at,venue_name,venue_city,pitch_surface,temperature_c,humidity_pct,precipitation_probability_pct,wind_speed_kmh,forecast_time,forecast_fetched_at,venue_source,weather_source,quality,prematch_verified,created_at")
   .eq("pool_date",date).order("created_at",{ascending:false}).limit(250);
 if(q.error){console.error("SG_ENVIRONMENT_READ_FAILED",q.error);return rows;}
 const index=new Map<string,any[]>();
 for(const v of q.data||[]){const key=String(v.match_no).padStart(3,"0")+"|"+v.home_team+"|"+v.away_team;
   const list=index.get(key)||[];list.push(v);index.set(key,list);}
 const number=(v:any)=>v===null||v===undefined||v===""||!Number.isFinite(Number(v))?null:Number(v);
 return rows.map((r:any)=>{
   const key=String(r.no||"").padStart(3,"0")+"|"+String(r.home||"")+"|"+String(r.away||"");
   const ko=Date.parse(String(r.kickoff||""));
   const found=(index.get(key)||[]).filter((v:any)=>v.venue_name&&
     ["EXACT_STADIUM_FORECAST","VERIFIED_STADIUM_PREMATCH","VERIFIED_STADIUM_POSTMATCH"].includes(String(v.quality))&&
     Number.isFinite(ko)&&Number.isFinite(Date.parse(String(v.kickoff_at)))&&
     Math.abs(Date.parse(String(v.kickoff_at))-ko)<=60000);
   if(!found.length)return r;
   const good=(v:any)=>{
     const captured=Date.parse(String(v.forecast_fetched_at||"")),at=Date.parse(String(v.forecast_time||""));
     const temp=number(v.temperature_c),humid=number(v.humidity_pct),rain=number(v.precipitation_probability_pct),wind=number(v.wind_speed_kmh);
     return v.quality==="EXACT_STADIUM_FORECAST"&&v.prematch_verified===true&&
       Number.isFinite(captured)&&captured<ko&&captured<=Date.now()&&
       Number.isFinite(at)&&Math.abs(at-ko)<=3600000&&temp!==null&&temp>=-80&&temp<=70&&
       humid!==null&&humid>=0&&humid<=100&&(rain===null||rain>=0&&rain<=100)&&
       (wind===null||wind>=0&&wind<=300);
   };
   const v=found.find(good)||found[0],hasWeather=good(v);
   return {...r,environment:{
     venueName:v.venue_name,venueCity:v.venue_city,pitchSurface:v.pitch_surface,
     temperatureC:hasWeather?number(v.temperature_c):null,
     humidityPct:hasWeather?number(v.humidity_pct):null,
     precipitationProbabilityPct:hasWeather?number(v.precipitation_probability_pct):null,
     windKmh:hasWeather?number(v.wind_speed_kmh):null,
     forecastTime:hasWeather?v.forecast_time:null,
     fetchedAt:hasWeather?v.forecast_fetched_at:v.created_at,
     venueSource:v.venue_source,weatherSource:hasWeather?v.weather_source:null,
     historicalForecast:hasWeather,
     venueRecoveredAfterKickoff:v.quality==="VERIFIED_STADIUM_POSTMATCH",
     note:hasWeather?"赛前采集的开球时段天气预报，非赛后实际天气；不可据此推断正式预测输入":
       "球场已核验，但未取得可核验的赛前天气"
   }};
 });
}


/* Original strict xG parameter formula, now fed by verified FotMob historical xG.
   The independent Soren Top4 is kept separate from Hao 3.8 scoreTop4. */
async function attachFotmobStrictScoreTop4(rows:any[],date:string){
 if(!rows.length)return rows;
 const q=await sb.schema("ninety_core").from("soren_fotmob_score_top4_v1")
   .select("match_id,match_no,home_team,away_team,kickoff_at,computed_at,lambda_home,lambda_away,scores,input_manifest,method")
   .eq("pool_date",date).limit(150);
 if(q.error){console.error("SOREN_FOTMOB_SCORE_READ",q.error);return rows;}
 const byNo=new Map((q.data||[]).map((v:any)=>[String(v.match_no).padStart(3,"0"),v]));
 const weekend=[0,6].includes(new Date(date+"T12:00:00+08:00").getUTCDay());
 const sale=Date.parse(date+"T"+(weekend?"23":"22")+":00:00+08:00");
 return rows.map((r:any)=>{
   const x:any=byNo.get(String(r.no||"").padStart(3,"0"));
   if(!x||r.pregameVerified!==true||r.dynamicScoreTop4)return r;
   const ko=Date.parse(String(r.kickoff)),xko=Date.parse(String(x.kickoff_at));
   const at=Date.parse(String(x.computed_at)),lh=Number(x.lambda_home),la=Number(x.lambda_away);
   const p=x.scores,manifest=x.input_manifest;
   if(x.home_team!==r.home||x.away_team!==r.away||
     !Number.isFinite(ko)||!Number.isFinite(xko)||Math.abs(ko-xko)>60000||
     !Number.isFinite(at)||at>=Math.min(ko-600000,sale)||at>Date.now()||
     !Number.isFinite(lh)||!Number.isFinite(la)||lh<0.2||la<0.2||lh>3.8||la>3.8||
     x.method!=="FOTMOB_XG_STRICT_PREMATCH_POISSON_DC_V1"||
     manifest?.result_used!==false||manifest?.strict_prematch!==true||
     Number(manifest?.home_hist_n)<3||Number(manifest?.away_hist_n)<3||
     Number(manifest?.league_xg_n)<6||
     !Array.isArray(p)||p.length!==4||
     p.some((v:any)=>!/^\d+-\d+$/.test(String(v?.score??""))||
       !Number.isFinite(Number(v?.probability))||Number(v.probability)<=0||Number(v.probability)>=1))return r;
   const actual=r.resultVerified===true&&Number.isInteger(Number(r.resultHome))&&
     Number.isInteger(Number(r.resultAway))?String(r.resultHome)+"-"+String(r.resultAway):null;
   const hit=actual!==null&&p.some((v:any)=>String(v.score)===actual);
   return {...r,dynamicScoreTop4:{
     pregameVerified:true,formalEligible:true,sourceKind:x.method,
     sourceLabel:"索伦严格赛前xG比分",frozenAt:x.computed_at,
     lambdaHome:lh,lambdaAway:la,picks:p,inputManifest:manifest,
     settlementStatus:actual===null?"PENDING":hit?"SUCCESS":"FAILURE",
     hitScore:hit?actual:null
   },dynamicGoalPrediction:{
     pregameVerified:true,formalEligible:true,sourceKind:x.method,
     frozenAt:x.computed_at,lambdaHome:lh,lambdaAway:la,
     source:"FotMob历史xG：双方最近3场与本赛季联赛均值"
   }};
 });
}

/* Independently frozen Singapore Top4, with truthful market-lambda provenance. */
async function attachSingaporeScoreTop4(rows:any[],sourceMatches:any[],date:string){
  if(!rows.length||!sourceMatches.length)return rows;
  const keys=[...new Set(sourceMatches.map((m:any)=>String(m.match_key||"")).filter(Boolean))];
  const q=await sb.schema("ninety_core").from("module_settlements_v1")
    .select("match_key,module,forecast_at,top1_hit,top4_hit,actual,settlement_status,result_source")
    .in("match_key",keys).eq("module","score_top4").order("forecast_at",{ascending:false}).limit(250);
  if(q.error){console.error("SG_SCORE_TOP4_SETTLEMENT_READ",q.error);return rows;}
  return rows.map((r:any)=>{
    if(r.dynamicScoreTop4)return r;
    const m=sourceMatches.find((x:any)=>String(x.match_no).padStart(3,"0")===String(r.no).padStart(3,"0")
      &&x.home_team===r.home&&x.away_team===r.away
      &&Math.abs(Date.parse(String(x.kickoff_at))-Date.parse(String(r.kickoff)))<60000);
    const o=m?.outputs?.score_top4,p=o?.payload;
    if(!o||p?.status!=="READY"||p?.shadow!==true||o.quality!=="provisional"
      ||!Array.isArray(p.top4)||p.top4.length!==4)return r;
    const ko=Date.parse(String(r.kickoff)),at=Date.parse(String(o.produced_at));
    const weekend=[0,6].includes(new Date(date+"T12:00:00Z").getUTCDay());
    const sale=Date.parse(date+"T"+(weekend?"15:00:00":"14:00:00")+"Z");
    if(!Number.isFinite(at)||!Number.isFinite(ko)||at>=Math.min(ko-600000,sale)||at>Date.now())return r;
    const distinct=new Set<string>();
    for(const x of p.top4){
      const s=String(x?.score??""),v=Number(x?.probability),parts=s.split("-");
      if(parts.length!==2||parts.some(t=>!/^[0-9]+$/.test(t))||!Number.isFinite(v)||v<=0||v>=1||distinct.has(s))return r;
      distinct.add(s);
    }
    const e=(q.data||[]).find((x:any)=>x.match_key===m.match_key
      &&Date.parse(String(x.forecast_at))===at&&x.settlement_status==="GRADED");
    const graded=Boolean(e&&typeof e.top4_hit==="boolean");
    const hit=graded&&e.top4_hit===true;
    const actual=graded?e.actual?.score??null:null;
    const sourceAt=Date.parse(String(p.source_frozen_at||""));
    const legacy=p.legacy_method_restored===true&&p.input_method==="PFINAL_INVERSE_POISSON_BLIND_V1"&&
      Number.isFinite(Number(p.fit_error))&&Number(p.fit_error)<=0.01&&
      Number.isFinite(sourceAt)&&sourceAt<=at&&sourceAt<ko&&sourceAt<sale;
    const obj={sourceKind:legacy?"SG_HJ38_TOP4_PFINAL_INVERSE_POISSON_BLIND_V1":"SG_HJ38_TOP4_SELECTION_MARKET_LAMBDA_SHADOW_V1",
      formalEligible:false,referenceOnly:true,pregameVerified:true,
      publishedAt:o.produced_at,sourceFrozenAt:legacy?p.source_frozen_at:o.produced_at,
      sourceRunId:legacy?p.source_run_id:null,
      methodVersion:p.method,lambdaHome:p.inputs?.home_lambda,lambdaAway:p.inputs?.away_lambda,
      inputMethod:p.input_method,calibration:p.direction_calibration,
      fitError:legacy?p.fit_error:null,legacyMethodRestored:legacy,
      picks:p.top4,top4Probability:p.top4_probability,
      settlementStatus:graded?(hit?"SUCCESS":"FAILURE"):"PENDING",
      top1Status:graded?(e.top1_hit?"SUCCESS":"FAILURE"):"PENDING",
      top4Status:graded?(hit?"SUCCESS":"FAILURE"):"PENDING",
      actual,hitScore:hit?actual:null,resultSource:graded?e.result_source:null};
    return {...r,scoreTop4:r.scoreTop4??obj,dynamicScoreTop4:obj,
      scoreTop4ReferenceStatus:"SG_PREMATCH_SNAPSHOT_VERIFIED"};
  });
}

/* Genuine pre-kickoff Soren score/goals/HTFT snapshots copied into the independent
   Singapore database. All 3 are explicitly SHADOW research references and
   MUST NOT enter production module hit-rate accounting. Do not synthesize a
   prediction from final results, or retroactively promote quality=PASS. */
async function attachOriginalPrematchScoreGoalHtftReferences(rows:any[],date:string){
 if(!rows.length)return rows;
 const db=sb.schema("ninety_core"),nos=[...new Set(rows.map(r=>String(r.no||"").padStart(3,"0")))];
 const [scoreQ,halfQ]=await Promise.all([
   db.from("soren_live_score_goals_archive_v1")
     .select("match_id,match_no,home_team,away_team,kickoff_at,original_source_id,market_at,base_frozen_at,computed_at,lambda_home,lambda_away,scores,input_manifest,source_kind")
     .eq("pool_date",date).in("match_no",nos).order("computed_at",{ascending:false}).limit(250),
   db.from("soren_live_htft_archive_v1")
     .select("match_id,match_no,home_team,away_team,kickoff_at,original_source_score_id,source_frozen_at,computed_at,lambda_home,lambda_away,picks,top4_probability,ht_draw_probability,low_goal_draw_audit,method_version,source_kind")
     .eq("pool_date",date).in("match_no",nos).order("computed_at",{ascending:false}).limit(250)
 ]);
 if(scoreQ.error||halfQ.error){console.error("ORIGINAL_SOREN_MODULE_READ_UNAVAILABLE",scoreQ.error||halfQ.error);return rows;}
 const scores=new Map<string,any>();
 for(const x of scoreQ.data||[]){
   const no=String(x.match_no||"").padStart(3,"0");
   if(!scores.has(no))scores.set(no,x);
 }
 const halves=new Map<string,any>();
 for(const x of halfQ.data||[]){
   const key=String(x.match_no||"").padStart(3,"0")+"|"+String(x.original_source_score_id);
   if(!halves.has(key))halves.set(key,x);
 }
 const diff=(a:any,b:any)=>Math.abs(Number(a)-Number(b));
 return rows.map(r=>{
  const no=String(r.no||"").padStart(3,"0"),x=scores.get(no);
  if(!x||r.pregameVerified!==true)return r;
  const ko=Date.parse(String(r.kickoff||"")),xKo=Date.parse(String(x.kickoff_at||""));
  const base=Date.parse(String(x.base_frozen_at||"")),market=Date.parse(String(x.market_at||"")),
    calc=Date.parse(String(x.computed_at||""));
  const lh=Number(x.lambda_home),la=Number(x.lambda_away),p=x.scores;
  const scoreValid=x.home_team===r.home&&x.away_team===r.away&&
    Number.isFinite(ko)&&Number.isFinite(xKo)&&Math.abs(ko-xKo)<60000&&
    Number.isFinite(base)&&Number.isFinite(market)&&Number.isFinite(calc)&&
    base<=market&&market<=calc&&calc<ko&&calc<=Date.now()&&
    x.source_kind==="OLD_SOREN_VERIFIED_PREMATCH_SHADOW"&&
    x.input_manifest?.formal_eligible===false&&x.input_manifest?.result_used===false&&
    Number.isFinite(lh)&&Number.isFinite(la)&&lh>=0.2&&la>=0.2&&lh<=3.8&&la<=3.8&&
    Array.isArray(p)&&p.length===4&&
    p.every((item:any)=>/^\d+-\d+$/.test(String(item?.score??""))&&
      String(item.score).split("-").every((v:string)=>Number(v)<=8)&&
      Number.isFinite(Number(item.baseProbability))&&
      Number(item.baseProbability)>=0&&Number(item.baseProbability)<=1);
  if(!scoreValid)return r;
  const score=r.resultVerified===true&&r.resultHome!=null&&r.resultAway!=null
    ?String(r.resultHome)+"-"+String(r.resultAway):null;
  const scoreHit=score!==null&&p.some((x:any)=>x.score===score);
  const scoreRef={
    pregameVerified:true,formalEligible:false,sourceKind:"MARKET_ANCHORED_POISSON_SHADOW_V01",
    sourceLiveScoreId:x.original_source_id,frozenAt:x.computed_at,marketAt:x.market_at,
    baselineAt:x.base_frozen_at,lambdaHome:lh,lambdaAway:la,picks:p,
    settlementStatus:score===null?"PENDING":scoreHit?"SUCCESS":"FAILURE",
    hitScore:scoreHit?score:null,inputManifest:x.input_manifest,
    provenance:"SG_ARCHIVED_AUTHENTIC_OLD_SOREN_PREMATCH"
  };
  const goalsRef={
    pregameVerified:true,formalEligible:false,sourceKind:"MARKET_ANCHORED_POISSON_SHADOW_V01",
    sourceLiveScoreId:x.original_source_id,frozenAt:x.computed_at,marketAt:x.market_at,
    lambdaHome:lh,lambdaAway:la,
    source:"旧索伦真实赛前冻结进球参数＋威廉希尔欧赔校准，仅参考，不计入正式战绩"
  };
  const h=halves.get(no+"|"+String(x.original_source_id));
  let halfRef:any=null;
  if(h&&h.home_team===r.home&&h.away_team===r.away&&
    Math.abs(Date.parse(String(h.kickoff_at))-ko)<60000&&
    h.source_kind==="OLD_SOREN_VERIFIED_PREMATCH_SHADOW"&&
    Date.parse(String(h.source_frozen_at))===calc&&
    Date.parse(String(h.computed_at))>=calc&&Date.parse(String(h.computed_at))<ko&&
    Math.abs(Number(h.lambda_home)-lh)<0.000001&&Math.abs(Number(h.lambda_away)-la)<0.000001&&
    Array.isArray(h.picks)&&h.picks.length===4&&
    h.picks.every((v:any)=>["胜胜","胜平","胜负","平胜","平平","平负","负胜","负平","负负"].includes(String(v.direction))&&
      Number.isFinite(Number(v.probability))&&Number(v.probability)>=0&&Number(v.probability)<=1))
    halfRef={
      sourceKind:"MARKET_ANCHORED_POISSON_HTFT_SHADOW_V01",formalEligible:false,
      methodVersion:h.method_version,sourceLiveScoreId:h.original_source_score_id,
      sourceFrozenAt:h.source_frozen_at,publishedAt:h.computed_at,
      picks:h.picks,top4Probability:h.top4_probability,htDrawProbability:h.ht_draw_probability,
      lowGoalDrawAudit:h.low_goal_draw_audit===true,settlementStatus:"PENDING_HALFTIME_VERIFICATION",
      actual:null,halfScore:null,lambdaHome:lh,lambdaAway:la,
      provenance:"SG_ARCHIVED_AUTHENTIC_OLD_SOREN_PREMATCH"
    };
  // Overlay only the audited, genuine frozen copies; never rewrite FT directions.
  // Distinct provenance keeps all legacy 0/10 provisional readiness separate.
  const halfTop3=halfRef?{
    sourceKind:"SG_PREMATCH_SHADOW",formalEligible:false,referenceOnly:true,
    picks:halfRef.picks.slice(0,3).map((p:any)=>({combination:p.direction,probability:p.probability})),
    publishedAt:halfRef.publishedAt,sourceFrozenAt:halfRef.sourceFrozenAt,
    settlementStatus:"PENDING",top1Status:"PENDING",pendingReason:"HALFTIME_NOT_VERIFIED",
    source:"RESTORED_ORIGINAL_SOREN_PREMATCH_HTFT_REFERENCE"
  }:null;
  return {...r,dynamicScoreTop4:scoreRef,dynamicGoalPrediction:goalsRef,
    ...(halfRef?{dynamicHTFT:halfRef,dynamicHTFTPending:false,
      shadowHTFTTop3:r.shadowHTFTTop3??halfTop3}:{}),
    originalSorenModuleReferenceStatus:halfRef?"THREE_AUTHENTIC_PREMATCH_REFERENCES":"SCORE_GOALS_PREMATCH_REFERENCES"};
 });
}

// Certified directional warnings are read from genuine pre-kickoff Soren snapshots.
// Risk-only HJ38 warnings can appear as observation cards, never as invented
// "主队不胜 / 主队不败" picks and never as a verified ABC publication.
async function attachCertifiedColdReadOnly(rows:any[],date:string){
  if(!rows.length)return rows;
  const nos=[...new Set(rows.map((r:any)=>String(r.no||"").padStart(3,"0")))];
  const q=await sb.schema("ninety_core").from("soren_upset_warnings_v1")
    .select("match_no,home_team,away_team,kickoff_bjt,source_frozen_at,synced_at,source_payload,result_fields_used,hur_direction_used,warning_direction,original_top1,risk_level,risk_score,risk_basis,direction_basis,directional_domain_count")
    .eq("pool_date",date).in("match_no",nos)
    .in("warning_direction",["主队不胜","主队不败"])
    .order("synced_at",{ascending:false}).limit(400);
  if(q.error)throw q.error;
  // The Singapore ABCDE publisher binds a warning to a verified HJ38 run.
  // Check that exact saved run, rather than comparing it to the unrelated,
  // subsequently refreshed Soren prediction timestamp.
  // An immutable published ABCDE warning must keep its ORIGINAL HJ frozen
  // source, even after frequent live predictions push it past the latest 500.
  const sourceTimes=[...new Set((q.data||[])
    .filter((w:any)=>w.source_payload?.source==="SG_ABCDE_V2_ORIGINAL_GATES")
    .map((w:any)=>String(w.source_payload?.inputModelAt||""))
    .filter((s:string)=>Number.isFinite(Date.parse(s))))];
  const hp=sourceTimes.length?await sb.schema("ninety_core").from("hao_console_predictions")
    .select("match_no,home_team,away_team,top1,frozen_at,kickoff_bjt,run_id,model_version")
    .eq("pool_date",date).in("match_no",nos).in("frozen_at",sourceTimes).limit(2000)
    :{data:[],error:null};
  if(hp.error)throw hp.error;
  const runIds=[...new Set((hp.data||[]).map((p:any)=>Number(p.run_id)).filter(Number.isInteger))];
  const hr=runIds.length?await sb.schema("ninety_core").from("hao_console_model_runs")
    .select("id,formal_allowed,data_complete").in("id",runIds).limit(500):{data:[],error:null};
  if(hr.error)throw hr.error;
  const validRuns=new Set((hr.data||[]).filter((x:any)=>x.formal_allowed===true&&x.data_complete===true).map((x:any)=>Number(x.id)));
  const byNo=new Map<string,any>();
  const dow=new Date(date+"T12:00:00+08:00").getUTCDay();
  const sale=Date.parse(date+"T"+([0,6].includes(dow)?"23":"22")+":00:00+08:00");
  for(const w of q.data||[]){
    const no=String(w.match_no||"").padStart(3,"0");
    const row=rows.find((r:any)=>String(r.no).padStart(3,"0")===no);
    if(!row||byNo.has(no)||row.pregameVerified!==true)continue;
    const kickoff=Date.parse(String(row.kickoff||""));
    const frozen=Date.parse(String(w.source_frozen_at||""));
    const published=Date.parse(String(w.synced_at||""));
    const wko=Date.parse(String(w.kickoff_bjt||""));
    const original=label(w.original_top1);
    // A certified Soren warning is anchored to its ORIGINAL frozen Top1.
    // The newer HJ38 customer forecast can differ; that is not a reason to
    // hide a previously published and independently certified pregame warning.
    const sourceAt=Date.parse(String(w.source_payload?.inputModelAt||""));
    const sourceHJ=w.source_payload?.source==="SG_ABCDE_V2_ORIGINAL_GATES"&&
      Number.isFinite(sourceAt)&&sourceAt<=frozen&&sourceAt<Math.min(kickoff,sale)&&
      (hp.data||[]).some((p:any)=>String(p.match_no||"").padStart(3,"0")===no&&
        p.home_team===row.home&&p.away_team===row.away&&
        p.model_version==="3.8"&&p.top1===original&&validRuns.has(Number(p.run_id))&&
        Date.parse(String(p.frozen_at||""))===sourceAt&&
        Math.abs(Date.parse(String(p.kickoff_bjt||""))-kickoff)<=60000);
    const originalMatch=(row.sorenOriginalVerified===true&&
      row.sorenOriginalTop1===original&&
      Date.parse(String(row.sorenOriginalFrozenAt||""))===frozen)||sourceHJ;
    const validDirection=originalMatch&&(
      (w.warning_direction==="主队不胜"&&original==="主胜")||
      (w.warning_direction==="主队不败"&&original==="客胜"));
    const proof=Array.isArray(w.direction_basis)?w.direction_basis:[];
    const evidence=Number(w.directional_domain_count)||0;
    // Original ABCDE A/B triggers can be directional from one independently
    // verified Betfair domain; legacy strict-HJ38 warnings require two domains.
    const abc=w.source_payload?.abc_verified===true&&
      w.source_payload?.source==="SG_ABCDE_V2_ORIGINAL_GATES"&&
      Array.isArray(w.source_payload?.channels)&&w.source_payload.channels.some((x:any)=>["A","B","C","D","E1","E2"].includes(String(x)));
    const minimum=abc?1:2;
    if(!validDirection||w.result_fields_used!==false||w.hur_direction_used!==false
      ||w.source_payload?.publish!==true||w.source_payload?.directionPublicationEligible!==true
      ||proof.length<minimum||evidence<minimum||!Number.isFinite(frozen)||!Number.isFinite(published)
      ||!Number.isFinite(kickoff)||!Number.isFinite(wko)||Math.abs(wko-kickoff)>60000
      ||frozen>published||published>=Math.min(kickoff,sale)
      ||String(w.home_team)!==String(row.home)||String(w.away_team)!==String(row.away))continue;
    byNo.set(no,{...w,verifiedSourceHJ:sourceHJ});
  }
  return rows.map((r:any)=>{
    const ko=Date.parse(String(r.kickoff||""));
    const risk=r?.upsetWarning;
    const at=Date.parse(String(risk?.prematchAt||""));
    const riskPublished=r.pregameVerified===true&&risk?.publish===true
      &&Number.isFinite(at)&&Number.isFinite(ko)&&at<Math.min(ko,sale);
    const verified=byNo.get(String(r.no||"").padStart(3,"0"));
    if(!verified&&!riskPublished)return r;
    const chosen=verified||risk;
    const directional=Boolean(verified);
    // Saved original cold snapshot contains genuinely frozen pre-publication
    // 99-firm, exchange, Kelly, Asian and intelligence evidence. The previous
    // Singapore adapter dropped it, leaving every "查看依据" field blank.
    // Only expose details captured before both publication and lottery cutoff.
    const focus=(verified?.source_payload?.focusGate&&typeof verified.source_payload.focusGate==="object")
      ?verified.source_payload.focusGate:null;
    const shadowCandidate=focus?.shadow_analysis??focus?.shadowAnalysis??null;
    const shadowAt=Date.parse(String(shadowCandidate?.capturedAt??shadowCandidate?.captured_at??""));
    const warningPublishedAt=Date.parse(String(verified?.synced_at??""));
    const proofCutoff=Math.min(ko,sale,warningPublishedAt);
    const frozenShadow=directional&&shadowCandidate&&Number.isFinite(shadowAt)&&
      Number.isFinite(proofCutoff)&&shadowAt<=proofCutoff&&
      shadowAt<=Date.now()?shadowCandidate:null;
    const route=directional?{
      type:"FOCUS_AVOID",source:"SOREN_VERIFIED_DIRECTIONAL_PREMATCH",
      direction:verified.warning_direction,originalTop1:label(verified.original_top1),
      ftPicks:verified.warning_direction==="主队不胜"?["平","客胜"]:["主胜","平"],
      publicationAt:verified.synced_at,
      formalABCVerified:false
    }:{type:"RISK_OBSERVE",source:"HJ38_PREMATCH_RISK_ONLY",originalTop1:r.ftTop1};
    const score=r.resultVerified===true&&r.resultHome!==null&&r.resultAway!==null
      ?String(r.resultHome)+":"+String(r.resultAway):null;
    const handicapActual=r.settlement?.handicapActual;
    const hResult=handicapActual==="主胜"?"让胜":handicapActual==="平"?"让平":handicapActual==="客胜"?"让负":null;
    return {...r,
      upsetWarning:directional?{...risk,publish:true,publicationEligible:true,riskDisplayEligible:true,
        source:"SOREN_VERIFIED_DIRECTIONAL_PREMATCH",prematchAt:verified.synced_at,
        direction:verified.warning_direction,riskLevel:verified.risk_level,
        riskBasis:verified.risk_basis,directionBasis:verified.direction_basis,
        originalTop1:verified.original_top1,sourceModelAt:verified.verifiedSourceHJ?verified.source_payload.inputModelAt:verified.source_frozen_at}:risk,
      dailySelectionRiskLocked:true,
      model:{top1:directional?label(verified.original_top1):r.ftTop1,
        second:directional?(r.sorenOriginalSecond??r.second):r.second,probability:[r.homeProbability,r.drawProbability,r.awayProbability],
        handicap:{top1:r.handicapTop1,second:r.handicapSecond,
          top1Probability:r.handicapProbability,secondProbability:r.handicapSecondProbability}},
      coldRecognition:{
        customerVisible:true,vipPublish:directional,customerTier:directional?"重点避开":"风险观察",
        originalTop1:directional?label(verified.original_top1):r.ftTop1, riskBasis:chosen.risk_basis??chosen.riskBasis??[],
        directionBasis:verified?.direction_basis??[],riskScore:verified?.risk_score??0,
        riskDirection:directional?{status:"CONFIRMED",direction:verified.warning_direction}:{status:"UNCONFIRMED",direction:null},
        customerRoute:route, sourceKind:directional?"SOREN_VERIFIED_PREMATCH":"HJ38_RISK_ONLY",
        gate:directional?{...(focus?{...focus,shadow_analysis:undefined}:{}),
          channels:verified?.source_payload?.abc_verified===true?verified.source_payload.channels:[]}:null,
        directionProofAt:directional?verified?.synced_at:null,
        riskLevel:verified?.risk_level??risk?.riskLevel??null,
        abcGateComplete:verified?.source_payload?.abc_verified===true
      },
      shadowAnalysis:frozenShadow,
      proofProvenance:directional?{
        source:"SOREN_ORIGINAL_PUBLISHED_PREMATCH",
        warningAt:verified.verifiedSourceHJ?verified.source_payload.inputModelAt:verified.source_frozen_at,
        publishedAt:verified.synced_at,
        deepSnapshotAt:frozenShadow?.capturedAt??frozenShadow?.captured_at??null,
        marketSource:"SG_VERIFIED_AS_OF_PUBLICATION"
      }:null,
      settlement:{...(r.settlement||{}),verified:r.resultVerified===true,score,
        homeScore:r.resultHome,awayScore:r.resultAway,ftResult:r.result??null,
        handicapResult:hResult}
    };
  });
}

/* Reconstruct member cold proof strictly from copied Singapore prematch
   source snapshots at or BEFORE the warning publication. No live post-warning
   market movement is passed off as the original warning's evidence.
   This is batched and read-only, and never downgrades a published warning. */
async function attachSorenColdEvidenceReadOnly(rows:any[],date:string){
  const visible=rows.filter((r:any)=>r.coldRecognition?.vipPublish===true&&
    r.proofProvenance?.source==="SOREN_ORIGINAL_PUBLISHED_PREMATCH");
  if(!visible.length)return rows;
  const nos=visible.map((r:any)=>String(r.no||"").padStart(3,"0"));
  const identities=await sb.schema("ninety_core").from("soren_matches")
    .select("id,match_no,home_team,away_team,kickoff_at")
    .eq("pool_date",date).in("match_no",nos).limit(150);
  if(identities.error)throw identities.error;
  const byNo=new Map((identities.data||[]).map((m:any)=>[String(m.match_no||"").padStart(3,"0"),m]));
  const ids=(identities.data||[]).map((m:any)=>m.id);
  if(!ids.length)return rows;
  // Independent prematch evidence is fetched concurrently; a proof view must
  // never impose three network round trips on every member open.
  const [markets,funds,deep]=await Promise.all([
    sb.schema("ninety_core").from("soren_market_snapshots")
      .select("match_id,source_code,market_type,snapshot_type,home_value,draw_value,away_value,line,home_water,away_water,payload,captured_at,ingested_at,data_quality")
      .in("match_id",ids).order("captured_at",{ascending:false}).limit(2000),
    sb.schema("ninety_core").from("soren_market_behavior_v1")
      .select("match_id,index_rows,exchange_scale,captured_at,prematch_verified,source_quality")
      .in("match_id",ids).order("captured_at",{ascending:false}).limit(500),
    sb.schema("ninety_core").from("soren_deep_market_snapshot_v1")
      .select("match_no,home_team,away_team,kickoff_at,captured_at,migrated_at,timing_quality,market_status,source_project,analysis")
      .eq("pool_date",date).in("match_no",nos).order("captured_at",{ascending:false}).limit(200)
  ]);
  if(markets.error||funds.error||deep.error)
    throw markets.error||funds.error||deep.error;
  const dow=new Date(date+"T12:00:00+08:00").getUTCDay();
  const sale=Date.parse(date+"T"+([0,6].includes(dow)?"23":"22")+":00:00+08:00");
  const validOdds=(x:any)=>[x?.home_value,x?.draw_value,x?.away_value].map((v:any)=>
    v===null||v===undefined?null:Number(v)).every((v:any)=>v!==null&&Number.isFinite(v)&&v>1&&v<1000);
  const odds=(x:any)=>validOdds(x)?[Number(x.home_value),Number(x.draw_value),Number(x.away_value)]:null;
  const fair=(v:number[]|null)=>{if(!v)return null;const inv=v.map(x=>1/x),sum=inv.reduce((a,b)=>a+b,0);
    return inv.map(x=>+(100*x/sum).toFixed(2))};
  const n=(v:any)=>v===null||v===undefined||v===""?null:
    (Number.isFinite(Number(v))?Number(v):null);
  const trio=(v:any)=>[n(v?.home),n(v?.draw),n(v?.away)];
  const pick=(r:any,index:number)=>index===0?r.home:index===1?"平":r.away;
  return rows.map((r:any)=>{
    if(r.coldRecognition?.vipPublish!==true)return r;
    const id:any=byNo.get(String(r.no||"").padStart(3,"0"));
    const ko=Date.parse(String(r.kickoff||"")),md=Date.parse(String(id?.kickoff_at||""));
    const issued=Date.parse(String(r.proofProvenance?.publishedAt||""));
    const boundary=Math.min(ko,sale,issued);
    if(!id||id.home_team!==r.home||id.away_team!==r.away||
      !Number.isFinite(ko)||!Number.isFinite(md)||Math.abs(md-ko)>60000||
      !Number.isFinite(issued)||!Number.isFinite(boundary))return r;
    const all=(markets.data||[]).filter((x:any)=>Number(x.match_id)===Number(id.id)&&
      ((x.source_code==="zucaijia_william"||x.source_code.startsWith("zucaijia_asia4:"))
        ?x.data_quality==="verified"
        :x.source_code==="qiulaile_sp_mirror"&&x.data_quality==="verified_mirror")&&
      Number.isFinite(Date.parse(String(x.captured_at||"")))&&
      Number.isFinite(Date.parse(String(x.ingested_at||"")))&&
      Date.parse(String(x.captured_at))<=boundary&&Date.parse(String(x.ingested_at))<=boundary);
    const get=(src:string,type:string,phase:string)=>all.find((x:any)=>
      x.source_code===src&&x.market_type===type&&x.snapshot_type===phase)??null;
    const williamI=get("zucaijia_william","FT_1X2","initial"),
      williamC=get("zucaijia_william","FT_1X2","current");
    const wi=odds(williamI),wc=odds(williamC);
    const had=get("qiulaile_sp_mirror","HAD","current"),
      hhad=get("qiulaile_sp_mirror","HHAD","current");
    const asians=["1","11","18","31"].map(code=>{
      const src="zucaijia_asia4:"+code,i=get(src,"ASIAN_HANDICAP","initial"),
        c=get(src,"ASIAN_HANDICAP","current"),a=c||i;
      if(!a)return null;
      return {institution:a.payload?.institution_name??src,
        initialLine:i?.payload?.original_line??i?.line??null,
        currentLine:c?.payload?.original_line??c?.line??null,
        initialHomeWater:n(i?.home_water),initialAwayWater:n(i?.away_water),
        currentHomeWater:n(c?.home_water),currentAwayWater:n(c?.away_water),
        capturedAt:c?.captured_at??i?.captured_at??null,
        sourceQuality:"verified_prematch"};
    }).filter(Boolean);
    const savedFunds=(funds.data||[]).find((x:any)=>Number(x.match_id)===Number(id.id)&&
      x.prematch_verified===true&&String(x.source_quality||"").startsWith("okooo_exchange_exact_identity_prematch")&&
      Number.isFinite(Date.parse(String(x.captured_at||"")))&&Date.parse(String(x.captured_at))<=boundary&&
      Array.isArray(x.index_rows)&&x.index_rows.length===3&&
      x.index_rows[0]?.team===r.home&&x.index_rows[1]?.team==="平局"&&x.index_rows[2]?.team===r.away);
    const fundRows=savedFunds?.index_rows??[];
    const savedProbability=fundRows.length===3?fundRows.map((x:any)=>n(x.avgProb)):null;
    const savedShares=fundRows.length===3?fundRows.map((x:any)=>n(x.bfShare)):null;
    const deepRecord=(deep.data||[]).find((x:any)=>
      String(x.match_no||"").padStart(3,"0")===String(r.no||"").padStart(3,"0")&&
      x.home_team===r.home&&x.away_team===r.away&&
      Math.abs(Date.parse(String(x.kickoff_at||""))-ko)<=60000&&
      x.market_status==="ok"&&
      Number.isFinite(Date.parse(String(x.captured_at||"")))&&
      Date.parse(String(x.captured_at))<=boundary&&
      x.analysis&&typeof x.analysis==="object");
    const deepAnalysis=deepRecord?{...deepRecord.analysis,capturedAt:deepRecord.captured_at}:null;
    const sh=r.shadowAnalysis??deepAnalysis;
    const mk=sh?.market_99??sh?.market99??null;
    const bf=sh?.betfair??null;
    const fb=(bf?.share_pct??bf?.share)??null;
    const pr=(mk?.probabilities_pct??mk?.probabilities)??null;
    const prob=pr?trio(pr):savedProbability;
    const validProb=prob&&prob.every(x=>x!==null&&x>=0&&x<=100);
    const arr=validProb?prob:null;
    const behavior=arr?{
      avgProbability:arr,top1:mk?.top??pick(r,arr.indexOf(Math.max(...arr))),
      strength:r.coldRecognition?.gate?.shadow_market_strength??"已验证",
      sourceKind:mk?"SOREN_ORIGINAL_PREPUBLICATION_SHADOW":"VERIFIED_PREPUBLICATION_MARKET_BEHAVIOR"}:null;
    const bfShares=fb?trio(fb):savedShares;
    const sourceFlags=r.coldRecognition?.gate??{};
    const trend=sourceFlags.shadow_market_top??mk?.top??null;
    const marketReady=Boolean(wi&&wc);
    const fundReady=Boolean(bfShares&&bfShares.every(x=>x!==null&&x>=0&&x<=100));
    const snapshotTime=sh?.capturedAt??sh?.captured_at??null;
    const market={
      initialOdds:wi,currentOdds:wc,currentFair:fair(wc),
      capturedAt:williamC?.captured_at??null,
      initialAt:williamI?.captured_at??null,sourceQuality:marketReady?"verified_prematch":"missing"};
    const officialMarket={
      ...(odds(had)?{had:{odds:odds(had),capturedAt:had.captured_at,source:"qiulaile_sp_mirror_verified"}}:{}),
      ...(odds(hhad)?{hhad:{odds:odds(hhad),line:n(hhad.line),capturedAt:hhad.captured_at,source:"qiulaile_sp_mirror_verified"}}:{})};
    const fundTop=fundReady?["主胜","平","客胜"][bfShares.indexOf(Math.max(...bfShares))]:null;
    const conclusion={
      marketConfirm:trend?("赛前市场方向："+String(trend)):"赛前市场方向尚未核实",
      fundBehavior:fundTop?("赛前必发资金首位："+fundTop):"赛前资金快照暂缺"};
    const pop=sh?.betfair?.share_pct??null;
    const topIdx=r.ftTop1==="主胜"?0:r.ftTop1==="客胜"?2:1;
    const popularity=fundReady&&arr?{
      marketProbability:arr[topIdx],betfairShare:bfShares[topIdx],
      sportterySavedShare:null,gap:null,
      heat:n(bf?.cold_heat?.[topIdx===0?"home":topIdx===1?"draw":"away"]??fundRows[topIdx]?.bfHotCold),
      profitIndex:n(bf?.profit_index?.[topIdx===0?"home":topIdx===1?"draw":"away"]??fundRows[topIdx]?.bfProfitIndex),
      williamProbabilityMove:null,divergence:null,fundAnomaly:null}:null;
    return {...r,
      shadowAnalysis:sh??null,
      league:r.league||"",market,officialMarket,
      asianHandicap:asians,behavior,conclusion,
      coverage:{model:r.pregameVerified===true,william:marketReady,
        sporttery:Boolean(officialMarket.had||officialMarket.hhad),
        asian:asians.length>0,behavior:fundReady,intelligence:
          Array.isArray(sh?.intelligence?.highlights)&&sh.intelligence.highlights.length>0},
      coldRecognition:{...r.coldRecognition,popularity,
        gate:{...sourceFlags,fundsTop:fundTop,bfShares:fundReady?bfShares:null},
        proofQuality:{warningFrozen:true,marketVerified:marketReady,
          fundsVerified:fundReady,officialSPVerified:Boolean(officialMarket.had),
          asianVerified:asians.length>0,shadowSnapshotVerified:Boolean(snapshotTime)}},
      sourceCapturedAt:{william:market.capturedAt,official:had?.captured_at??null,
        asian:asians[0]?.capturedAt??null,analysis:snapshotTime},
      proofProvenance:{...r.proofProvenance,marketAsOfBoundary:new Date(boundary).toISOString(),
        deepSnapshotSource:deepRecord?.source_project??null,
        deepSnapshotImportedAt:deepRecord?.migrated_at??null,
        deepSnapshotUsedByWarning:!!r.shadowAnalysis}
    };
  });
}

async function applySorenProductionLocks(rows:any[],date:string){
  // READ ONLY on GET. The SG database trigger creates irreversible
  // exclusion locks ONLY for verified published prematch cold warnings.
  // Other transient risks (high draw/market anomaly) must not create
  // permanent locks from a customer's page refresh.
  const locks=await sb.schema("ninety_core").from("soren_daily_selection_locks_v1")
    .select("match_no,lock_type,locked_at").eq("pool_date",date);
  if(locks.error)throw locks.error;
  const byNo=new Map((locks.data||[]).map((x:any)=>[String(x.match_no||"").padStart(3,"0"),x]));
  return rows.map(r=>{
    const lock=byNo.get(String(r.no||"").padStart(3,"0"));
    if(!lock)return r;
    return {...r,dailySelectionTier:null,dailySelectionLabel:null,dailySelectionRiskLocked:true,
      dailySelectionRiskLockReason:r.dailySelectionRiskLockReason??String(lock.lock_type),
      dailySelectionRiskLockAt:lock.locked_at??null};
  });
}
Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers});
  if(req.method!=="GET")return reply({ok:false,error:"METHOD_NOT_ALLOWED"},405);
  const url=new URL(req.url),view=url.searchParams.get("view")||"today";
  if(url.pathname.endsWith("/health")||url.searchParams.get("health")==="compat"){
    return reply({ok:true,service:"soren-public-api-v1",formalPipeline:true,shadowFallback:true,
      revision:"singapore_formal_preferred_1.0",legacyRuntimeDependency:false,now:new Date().toISOString()});
  }
  const prefetch=url.searchParams.get("prefetch")==="1";
  let admin=false, member:any={active:false,tier:"free"}, vip=false;
  if(prefetch){
    const token=req.headers.get("x-prefetch-token")||"";
    const verified=await sb.rpc("ninety_verify_today_prefetch_v1",{p_token:token});
    if(verified.error||verified.data!==true)return reply({ok:false,error:"PREFETCH_FORBIDDEN"},403);
    vip=url.searchParams.get("audience")==="vip";
  }else{
    const jwt=(req.headers.get("authorization")||"").match(/^Bearer\s+(.+)$/i)?.[1];
    if(!jwt)return reply({ok:false,error:"LOGIN_REQUIRED"},401);
    const auth=await sb.auth.getUser(jwt);
    if(auth.error||!auth.data.user)return reply({ok:false,error:"LOGIN_REQUIRED"},401);
    const user=auth.data.user;
    admin=user.app_metadata?.role==="admin"||user.app_metadata?.is_admin===true;
    const mem=await sb.rpc("ninety_membership_status",{p_user_id:user.id});
    if(mem.error)return reply({ok:false,error:"MEMBERSHIP_STATUS_UNAVAILABLE"},503);
    member=mem.data||{active:false,tier:"free"};
    vip=Boolean(admin || (member.active && ["vip_monthly","vip_manual","admin"].includes(String(member.tier))));
  }
  const membership={
    active:vip,vipActive:vip,isAdmin:admin,trialStatus:null,
    tier:admin?"admin":member.tier??"free",
    vipUntil:member.ends_at??null,memberUntil:member.ends_at??null,
    shadow:true
  };
  if(view==="membership")return reply({ok:true,membership});
  const date=url.searchParams.get("date")||currentBjt();
  if(!validDate(date))return reply({ok:false,error:"INVALID_DATE"},400);
  // Completed-date archive cache: never cache live predictions or current cold gates.
  const archiveCacheEligible=(date<currentBjt()&&["archive","history"].includes(view))||(vip&&["cold-feed","member-zone"].includes(view));
  const archiveAudience=vip?"vip":"free";
  if(archiveCacheEligible&&!prefetch){
    const cached=await sb.schema("ninety_core").from("soren_customer_published_payload_cache_v1")
      .select("payload,expires_at").eq("match_date",date).eq("audience",archiveAudience)
      .eq("view_name",view).maybeSingle();
    if(cached.error)console.warn("SOREN_CACHE_READ_ERROR",JSON.stringify({view,code:cached.error.code}));
    if(!cached.error&&cached.data&&Date.parse(cached.data.expires_at)>Date.now()){
      console.info("SOREN_CACHE_HIT",JSON.stringify({view,audience:archiveAudience}));
      if(date===currentBjt()&&["today","archive"].includes(view)){
        let safeRows:any[]=[];
        try{safeRows=await applySorenProductionLocks(cached.data.payload.rows||[],date);}
        catch(e){console.error("PREFETCH_LOCK_CHECK_FAILED",String(e));safeRows=(cached.data.payload.rows||[]).map((r:any)=>({...r,dailySelectionTier:null,dailySelectionLabel:null,dailySelectionRiskLocked:true}));}
        return reply({...cached.data.payload,rows:safeRows,membership});
      }
      return reply({...cached.data.payload,membership});
    }
    console.info("SOREN_CACHE_MISS",JSON.stringify({view,audience:archiveAudience}));
  }
  const archiveCacheReply=async(body:any)=>{
    if(archiveCacheEligible&&body?.ok===true&&!(["cold-feed","member-zone"].includes(view)&&body.shadow!==false)){
      const ttlMs=(["cold-feed","member-zone"].includes(view)&&date>=currentBjt())?45*1000:10*60*1000;
      const expiresAt=new Date(Date.now()+ttlMs).toISOString();
      const saved=await sb.schema("ninety_core").from("soren_customer_published_payload_cache_v1")
        .upsert({match_date:date,audience:archiveAudience,view_name:view,payload:{...body,membership:null},
          source_version:"soren-public-api-v1-v70",generated_at:new Date().toISOString(),expires_at:expiresAt},
          {onConflict:"match_date,audience,view_name"});
      if(saved.error)console.warn("SOREN_ARCHIVE_CACHE_WRITE_FAILED",saved.error.code);
    }
    return reply(body);
  };
  try{
    // Historical customer cold feed is a copied, immutable ledger of formal
    // pre-sale old Soren publications. It never re-runs a cold rule from results.
    if((view==="cold-feed"||view==="member-zone")&&date<"2026-10-19"){
      if(!vip)return reply({ok:false,error:"VIP_REQUIRED"},403);
      const hist=await sb.schema("ninety_core").from("soren_cold_history_import_v1")
        .select("match_no,source_record,result_record").eq("pool_date",date)
        .order("match_no",{ascending:true}).limit(100);
      if(hist.error)throw hist.error;
      const rows=(hist.data||[]).flatMap((item:any)=>{
        const w=item.source_record||{},res=item.result_record||{};
        const issued=Date.parse(String(w.synced_at||""));
        const frozen=Date.parse(String(w.source_frozen_at||""));
        const kickoff=Date.parse(String(w.kickoff_bjt||""));
        const dow=new Date(date+"T12:00:00+08:00").getUTCDay();
        const sale=Date.parse(date+"T"+([0,6].includes(dow)?"23":"22")+":00:00+08:00");
        if(w.pool_date!==date||String(w.match_no||"").padStart(3,"0")!==String(item.match_no||"").padStart(3,"0")||
          !Number.isFinite(issued)||!Number.isFinite(frozen)||!Number.isFinite(kickoff)||
          frozen>=Math.min(kickoff,sale)||issued>=Math.min(kickoff,sale)||
          w.source_payload?.publish!==true||w.source_payload?.directionPublicationEligible!==true||
          Number(w.directional_domain_count)<1||
          !((w.warning_direction==="主队不胜"&&w.original_top1==="主胜")||
            (w.warning_direction==="主队不败"&&w.original_top1==="客胜")))return [];
        const gate=w.source_payload?.focusGate??null;
        const candidate=gate?.shadow_analysis??null;
        const captured=Date.parse(String(candidate?.capturedAt??candidate?.captured_at??""));
        const shadow=candidate&&Number.isFinite(captured)&&captured<=issued&&captured<kickoff?candidate:null;
        const rawProb=shadow?.market_99?.probabilities_pct??shadow?.market99?.probabilities_pct??null;
        const probs=rawProb?[rawProb.home,rawProb.draw,rawProb.away].map((x:any)=>Number(x)):null;
        const modelProb=probs&&probs.every((x:number)=>Number.isFinite(x)&&x>=0&&x<=100)?probs:[null,null,null];
        const resultMap:any={H:"主胜",D:"平",A:"客胜"};
        const actual=res.verified===true?resultMap[String(res.ft_result)]??null:null;
        const score=res.verified===true&&res.home_score!==null&&res.away_score!==null
          ?String(res.home_score)+":"+String(res.away_score):null;
        const direction=w.warning_direction;
        const route={type:"FOCUS_AVOID",source:"SOREN_OLD_FORMAL_PREMATCH_ARCHIVE",
          direction,originalTop1:w.original_top1,
          ftPicks:direction==="主队不胜"?["平","客胜"]:["主胜","平"],publicationAt:w.synced_at};
        return [{
          no:item.match_no,date,league:w.league??"",home:w.home_team,away:w.away_team,
          kickoff:w.kickoff_bjt,pregameVerified:true,resultVerified:!!actual,
          resultHome:res.home_score??null,resultAway:res.away_score??null,result:actual,
          ftTop1:w.original_top1,
          model:{top1:w.original_top1,second:null,probability:modelProb,handicap:{}},
          upsetWarning:{publish:true,direction,riskLevel:w.risk_level,riskScore:w.risk_score,
            riskBasis:w.risk_basis,directionBasis:w.direction_basis,prematchAt:w.source_frozen_at},
          coldRecognition:{customerVisible:true,vipPublish:true,customerTier:"重点避开",
            originalTop1:w.original_top1,riskLevel:w.risk_level,riskScore:w.risk_score,
            riskBasis:Array.isArray(w.risk_basis)?w.risk_basis:[],
            directionBasis:Array.isArray(w.direction_basis)?w.direction_basis:[],
            customerRoute:route,riskDirection:{status:"CONFIRMED",direction},gate},
          shadowAnalysis:shadow,
          behavior:modelProb[0]!==null?{avgProbability:modelProb,
            top1:shadow?.market_99?.top??null,strength:gate?.shadow_market_strength??"已验证"}:null,
          settlement:{verified:!!actual,score,homeScore:res.home_score??null,
            awayScore:res.away_score??null,ftResult:actual},
          proofProvenance:{source:"SOREN_OLD_FORMAL_PREMATCH_ARCHIVE",
            warningAt:w.source_frozen_at,publishedAt:w.synced_at,
            deepSnapshotAt:shadow?.capturedAt??shadow?.captured_at??null}
        }];
      });
      return await archiveCacheReply({ok:true,date,shadow:false,routeRuleVersion:"SOREN_OLD_FORMAL_PREMATCH_ARCHIVE",
        count:rows.length,rows,partial:false,publishedOnly:true,certifiedDirectional:rows.length,
        riskObservations:0,membership,zone:{date,rows,shadow:false,
          routeRuleVersion:"SOREN_OLD_FORMAL_PREMATCH_ARCHIVE",certifiedDirectional:rows.length,riskObservations:0}});
    }
    // A legacy migration imported six test fixtures (020-025) as
    // invalid_test; they must never be rendered as customer matches or
    // counted as real forecasts / results, even if model rows still exist.
    // Customer filtering only: preserve archived data for audit.
    // Three independent, date-scoped reads run concurrently before processing.
    const predPromise=sb.schema("ninety_core").from("hao_console_predictions")
      .select("run_id,pool_date,match_no,league,home_team,away_team,kickoff_bjt,top1,second_pick,confidence_label,official_handicap,handicap_pick,ticket_pick,keep_discard,source_status,source_provenance,frozen_at,freeze_status,result_home,result_away,result_verified,model_version,model_revision_tag,updated_at")
      .eq("pool_date",date).order("updated_at",{ascending:false}).order("match_no");
    const matchPromise=sb.schema("ninety_core").from("soren_matches")
      .select("id,match_no,home_team,away_team,kickoff_at,cutoff_at,is_world_cup")
      .eq("pool_date",date).limit(150);
    const invalidQ=await sb.schema("ninety_core").from("match_pool")
      .select("match_key,match_no").eq("match_date",date).eq("status","invalid_test").limit(200);
    if(invalidQ.error)throw invalidQ.error;
    const invalidDisplayNos=new Set((invalidQ.data||[]).map((m:any)=>String(m.match_no||"").padStart(3,"0")));
    const predQ=await predPromise;
    if(predQ.error)throw predQ.error;
    // Match the original Soren customer fixture identity: date, display number and both teams.
    // A valid HJ run alone is insufficient to display a cross-matched fixture.
    const mq=await matchPromise;
    if(mq.error)throw mq.error;
    const realPool=new Map((mq.data||[]).filter((m:any)=>
      !invalidDisplayNos.has(String(m.match_no||"").padStart(3,"0")))
      .map((m:any)=>[String(m.match_no).padStart(3,"0"),m]));
    // Original Soren formal selection is the ONLY source of SINGLE/DOUBLE/A/B+.
    // Never derive Soren tier from the Hao 3.8 ticket_pick or an unverified candidate.
    const originalByNo=new Map<string,any>();
    const sourceIds=(mq.data||[]).map((m:any)=>Number(m.id)).filter(Number.isInteger);
    if(sourceIds.length){
      const op=await sb.schema("ninety_core").from("soren_predictions")
        .select("match_id,run_id,ft_top1,ft_second,selection_mode,selection_codes,ft_class,recommendation_class,primary_reason,frozen_at")
        .in("match_id",sourceIds).order("frozen_at",{ascending:false}).limit(200);
      if(!op.error){
        const srIds=[...new Set((op.data||[]).map((p:any)=>Number(p.run_id)).filter(Number.isInteger))];
        const runs=srIds.length?await sb.schema("ninety_core").from("soren_runs")
          .select("id,status,run_type,formal_allowed,data_complete,no_result_leakage,freeze_at")
          .in("id",srIds).limit(200):{data:[],error:null};
        if(!runs.error){
          const eligibleRuns=new Map((runs.data||[]).filter((r:any)=>r.status==="COMPLETE"
            &&r.run_type==="FORMAL"&&r.formal_allowed===true
            &&r.data_complete===true&&r.no_result_leakage===true).map((r:any)=>[Number(r.id),r]));
          const byId=new Map((mq.data||[]).map((m:any)=>[Number(m.id),m]));
          for(const p of op.data||[]){
            const verifiedRun:any=eligibleRuns.get(Number(p.run_id));
            if(!verifiedRun||p.primary_reason==="SG_LOCAL_HJ38_VERIFIED"
              ||Math.abs(Date.parse(String(p.frozen_at||""))-Date.parse(String(verifiedRun.freeze_at||"")))>1000)continue;
            const m:any=byId.get(Number(p.match_id));
            if(!m||m.is_world_cup===true)continue;
            const no=String(m.match_no||"").padStart(3,"0");
            if(originalByNo.has(no))continue;
            const frozen=Date.parse(String(p.frozen_at||""));
            const ko=Date.parse(String(m.kickoff_at||""));
            const cutoff=m.cutoff_at?Date.parse(String(m.cutoff_at)):Infinity;
            const day=new Date(date+"T12:00:00+08:00").getUTCDay();
            const sale=Date.parse(date+"T"+([0,6].includes(day)?"23":"22")+":00:00+08:00");
            const mode=String(p.selection_mode||"PASS");
            const codes=Array.isArray(p.selection_codes)?p.selection_codes:[];
            if(!Number.isFinite(frozen)||!Number.isFinite(ko)
              ||frozen> Date.now()||frozen>=Math.min(ko,cutoff,sale)
              ||!["H","D","A"].includes(String(p.ft_top1))
              ||!["SINGLE","DOUBLE","PASS"].includes(mode)
              ||(mode==="SINGLE"&&(codes.length!==1||codes[0]!==p.ft_top1))
              ||(mode==="DOUBLE"&&(codes.length!==2||codes[0]!==p.ft_top1
                ||!["H","D","A"].includes(String(codes[1]))||codes[1]===p.ft_top1))
              ||(mode==="PASS"&&codes.length!==0))continue;
            originalByNo.set(no,p);
          }
        }
      }
    }
    const runIds=[...new Set((predQ.data||[]).map((p:any)=>Number(p.run_id)).filter(Number.isInteger))];
    const runQ=runIds.length?await sb.schema("ninety_core").from("hao_console_model_runs")
      .select("id,formal_allowed,data_complete").in("id",runIds).limit(500):{data:[],error:null};
    if(runQ.error)throw runQ.error;
    const validRuns=new Set((runQ.data||[]).filter((r:any)=>r.formal_allowed===true&&r.data_complete===true).map((r:any)=>Number(r.id)));
    const seen=new Set<string>();
    const formalRows=(predQ.data||[]).filter((p:any)=>{
      if(!validRuns.has(Number(p.run_id))||p.model_version!=="3.8"
        ||!["主胜","平","客胜"].includes(String(p.top1)))return false;
      const date=String(p.pool_date||"");
      const dow=new Date(date+"T12:00:00+08:00").getUTCDay();
      const sale=Date.parse(date+"T"+([0,6].includes(dow)?"23":"22")+":00:00+08:00");
      const fixture:any=realPool.get(String(p.match_no).padStart(3,"0"));
      if(!fixture||fixture.is_world_cup===true
        ||String(fixture.home_team)!==String(p.home_team)
        ||String(fixture.away_team)!==String(p.away_team))return false;
      const frozen=Date.parse(String(p.frozen_at||"")),kickoff=Date.parse(String(p.kickoff_bjt||""));
      const officialKickoff=Date.parse(String(fixture.kickoff_at||""));
      const actualCutoff=fixture.cutoff_at?Date.parse(String(fixture.cutoff_at)):Infinity;
      if(!Number.isFinite(frozen)||!Number.isFinite(kickoff)||!Number.isFinite(officialKickoff)
        ||frozen>=Math.min(kickoff,officialKickoff,actualCutoff,sale)||frozen>Date.now())return false;
      const no=String(p.match_no).padStart(3,"0");
      if(seen.has(no))return false;
      seen.add(no);return true;
    });
    if(formalRows.length){
      const allowed=vip?formalRows:formalRows.slice(0,2);
      const supportQ=await sb.rpc("ninety_customer_payload",{p_date:date});
      const supportMatches=Array.isArray(supportQ.data?.matches)?supportQ.data.matches:[];
      const supportByNo=new Map(supportMatches.map((m:any)=>[String(m.match_no||"").padStart(3,"0"),m]));
      let rows=allowed.map((p:any)=>{
        const base={...adaptFormalPrediction(p,date),hj38ModelRunId:p.run_id},match=supportByNo.get(String(p.match_no||"").padStart(3,"0"));
        if(!match)return base;
        const support=shadowSupport(match),h=support.shadowHandicap;
        return {...base,
          // A formal Hao 3.8 forecast owns FT probabilities. Shadow module odds
          // are support-only and may fill a genuinely absent legacy field, but
          // must never overwrite p_final from the v87 production executor.
          homeProbability:base.homeProbability??support.homeProbability,
          drawProbability:base.drawProbability??support.drawProbability,
          awayProbability:base.awayProbability??support.awayProbability,
          confidence:base.confidence??support.confidence,
          officialHandicap:base.officialHandicap??h?.line??null,
          handicapTop1:base.handicapTop1??h?.top1??null,handicapSecond:base.handicapSecond??h?.second??null,
          handicapProbability:base.handicapProbability??h?.top1Probability??null,
          handicapSecondProbability:base.handicapSecondProbability??h?.secondProbability??null,
          handicapSourceLabel:base.handicapSourceLabel??(h?"新加坡实时赛前参考":""),
          shadowScoreTop3:support.shadowScoreTop3,shadowHTFTTop3:support.shadowHTFTTop3,
          shadowGoalsTop3:support.shadowGoalsTop3,shadowDailySelection:null,
          // 今日优选 is owned by the Soren production gate. Provisional module
          // output must never promote a formal Hao row into the customer list.
          dailySelectionTier:base.dailySelectionTier
        };
      });
      // Restore genuine, run-verified Soren frozen selection; HJ FT remains separate.
      rows=rows.map((r:any)=>{
        const x:any=originalByNo.get(String(r.no).padStart(3,"0"));
        if(!x)return {...r,sorenOriginalVerified:false,sorenOriginalStatus:"NO_VERIFIED_FORMAL_SELECTION"};
        const names:any={H:"主胜",D:"平",A:"客胜"};
        const top=names[String(x.ft_top1)]??null;
        const second=names[String(x.ft_second)]??null;
        const aligned=top===r.ftTop1;
        const verified={sorenOriginalVerified:true,sorenOriginalFrozenAt:x.frozen_at,
          sorenOriginalRunId:x.run_id,sorenOriginalTop1:top,sorenOriginalSecond:second,
          sorenOriginalMode:x.selection_mode,sorenOriginalClass:x.ft_class??x.recommendation_class??null,
          sorenOriginalSelectionCodes:x.selection_codes,
          sorenOriginalStatus:aligned?"FORMAL_ALIGNED":"FORMAL_DIRECTION_DIVERGENCE"};
        if(!aligned)return {...r,...verified};
        const mode=String(x.selection_mode);
        const cls=String(x.ft_class??x.recommendation_class??"");
        const tier=mode==="PASS"?"PASS":cls==="A"?"A":cls.startsWith("B+")?"B+":null;
        return {...r,...verified,mode,pass:mode==="PASS",tier,
          second:mode==="DOUBLE"?names[String(x.selection_codes[1])]??r.second:r.second,
          sourceModel:"豪竞3.8＋索伦原版赛前单双选"};
      });
      // Published Soren cold warnings come from the ORIGINAL frozen warning table,
      // never from a Hao source_status proxy or SG shadow candidate.
      const coldQ=await sb.schema("ninety_core").rpc("soren_prematch_risk_compact_v1",{p_pool_date:date});
      const coldByNo=new Map<string,any>();
      if(!coldQ.error)for(const w of coldQ.data||[])coldByNo.set(String(w.match_no||"").padStart(3,"0"),w);
      rows=rows.map((r:any)=>{
        const w:any=coldByNo.get(String(r.no).padStart(3,"0"));
        const snap=Date.parse(String(w?.source_frozen_at||""));
        const ko=Date.parse(String(r.kickoff||""));
        const validSnapshot=r.sorenOriginalVerified===true&&Number.isFinite(snap)
          &&Number.isFinite(ko)&&snap<ko&&snap<=Date.now();
        const sorenActive=validSnapshot&&w?.published===true;
        const ever=validSnapshot&&w?.ever_published===true;
        const originalRisk=sorenActive?{
          publish:true,publicationEligible:true,riskDisplayEligible:true,
          source:"SOREN_ORIGINAL_PREMATCH_SNAPSHOT",
          riskLevel:w.risk_level??null,direction:w.warning_direction??null,
          alternativePick:w.alternative_pick??null,
          originalTop1:w.original_top1??r.sorenOriginalTop1??null,
          riskScore:w.risk_score??null,
          riskBasis:Array.isArray(w.risk_basis)?w.risk_basis:[],
          directionBasis:Array.isArray(w.direction_basis)?w.direction_basis:[],
          prematchAt:w.source_frozen_at
        }:null;
        // A local HJ38-forwarded row remains HJ38, not an independent Soren original.
        // Preserve its *verified formal prematch* risk, with truthful HJ provenance.
        const hj:any=r.upsetWarning;
        const hjAt=Date.parse(String(r.latestPrematchAt||""));
        const hjRisk=hj?.publish===true&&r.pregameVerified===true&&
          Number.isFinite(hjAt)&&Number.isFinite(ko)&&hjAt<ko&&hjAt<=Date.now()
          ?{...hj,source:"HJ38_FORMAL_PREMATCH_VERIFIED",publicationEligible:true,
            riskDisplayEligible:true,prematchAt:r.latestPrematchAt}:null;
        return {...r,upsetWarning:originalRisk??hjRisk,
          hj38RiskReference:hj??null,
          sorenOriginalColdPublished:sorenActive,sorenOriginalColdEverPublished:ever,
          hj38ColdPublished:!!hjRisk,
          dailySelectionRiskLocked:r.dailySelectionRiskLocked||ever,
          dailySelectionRiskLockReason:ever?"ORIGINAL_SOREN_COLD_PUBLISHED":r.dailySelectionRiskLockReason};
      });
      // Cold list is an independent published-ledger read. Do not make VIP
      // customers load Score/Goals/HTFT grading, daily selector audits and all
      // other modules before showing the two-or-more published warnings.
      // Keep the original certified gating and 1:1 market evidence intact.
      if(view==="cold-feed"||view==="member-zone"){
        if(!vip)return reply({ok:false,error:"VIP_REQUIRED"},403);
        const verifiedRows=await attachCertifiedColdReadOnly(rows,date);
        const confirmed=verifiedRows.filter((r:any)=>
          r.coldRecognition?.vipPublish===true&&
          r.coldRecognition?.customerRoute?.type==="FOCUS_AVOID"&&
          ["主队不胜","主队不败"].includes(String(r.coldRecognition?.customerRoute?.direction??"")));
        // Weather/venue is read independently from the preserved evidence
        // and must never delay the evidence query by a full extra round trip.
        const [withEvidence,withEnvironment,withResults]=await Promise.all([
          attachSorenColdEvidenceReadOnly(confirmed,date),
          attachVerifiedDayEnvironment(confirmed,date),
          attachVerifiedModuleSettlements(confirmed,supportMatches)
        ]);
        const visible=withEvidence.map((row:any,i:number)=>{
          const graded:any=withResults[i]||row;
          // The original cold page also included independently verified
          // settlement. Preserve its exact grading and anti-leakage rules.
          return {...row,
            ...(withEnvironment[i]?.environment?{environment:withEnvironment[i].environment}:{}),
            resultVerified:graded.resultVerified,
            resultHome:graded.resultHome,resultAway:graded.resultAway,
            result:graded.result,resultScore:graded.resultScore,
            settlement:graded.settlement,
            ...(graded.resultSourceConflict?{resultSourceConflict:true}:{})
          };
        });
        return await archiveCacheReply({ok:true,date,shadow:false,
          routeRuleVersion:"SG_PREMATCH_CERTIFIED_FOCUS_ONLY_v2",count:visible.length,
          rows:visible,partial:false,publishedOnly:true,
          certifiedDirectional:visible.length,riskObservations:0,
          membership,zone:{date,rows:visible,shadow:false,
            routeRuleVersion:"SG_PREMATCH_CERTIFIED_FOCUS_ONLY_v2",
            certifiedDirectional:visible.length,riskObservations:0}});
      }
      // Source-backed Soren original HTFT Top4, copied with exact JSONB/numeric precision.
      // Strict source fixture identity and historical publication time are mandatory.
      // Fallback form-only source is reference-only, never counted as formal forecasting.
      if(vip){
        const hq=await sb.schema("ninety_core").from("soren_htft_top4_v1")
          .select("match_no,home_team,away_team,kickoff_at,source_frozen_at,published_at,picks,top4_probability,ht_draw_probability,low_goal_draw_audit,source_kind,method_version")
          .eq("pool_date",date).limit(100);
        if(hq.error)throw hq.error;
        const htftByNo=new Map((hq.data||[]).map((x:any)=>[String(x.match_no).padStart(3,"0"),x]));
        rows=rows.map((r:any)=>{
          const a:any=htftByNo.get(String(r.no).padStart(3,"0"));
          if(!a)return r;
          const ko=Date.parse(String(r.kickoff||"")),origKo=Date.parse(String(a.kickoff_at||""));
          const sourceAt=Date.parse(String(a.source_frozen_at||"")),publishedAt=Date.parse(String(a.published_at||""));
          if(String(a.home_team)!==String(r.home)||String(a.away_team)!==String(r.away)
            ||!Number.isFinite(ko)||!Number.isFinite(origKo)||Math.abs(ko-origKo)>60000
            ||!Number.isFinite(sourceAt)||!Number.isFinite(publishedAt)
            ||sourceAt>publishedAt||publishedAt>=ko||publishedAt>Date.now()
            ||!Array.isArray(a.picks)||a.picks.length!==4)return r;
          return {...r,htftTop4:{
            sourceKind:"PUBLISHED_PREMATCH",
            formalEligible:a.source_kind!=="FORM_LAST6_GOALS_POISSON_SHADOW_FALLBACK",
            referenceOnly:a.source_kind==="FORM_LAST6_GOALS_POISSON_SHADOW_FALLBACK",
            inputSourceKind:a.source_kind,methodVersion:a.method_version,
            sourceFrozenAt:a.source_frozen_at,publishedAt:a.published_at,
            picks:a.picks,top4Probability:a.top4_probability,
            htDrawProbability:a.ht_draw_probability,lowGoalDrawAudit:a.low_goal_draw_audit===true,
            settlementStatus:"PENDING_HALFTIME_VERIFICATION",actual:null,halfScore:null
          }};
        });
      }
      rows=await attachVerifiedModuleSettlements(rows,supportMatches);
      rows=await attachOriginalPrematchScoreGoalHtftReferences(rows,date);
    rows=await attachFotmobStrictScoreTop4(rows,date);
       rows=await attachSingaporeScoreTop4(rows,supportMatches,date);
       rows=await attachCertifiedColdReadOnly(rows,date);
      rows=await applySorenProductionLocks(rows,date);
       // Original Soren selection has not completed its VIP cold/full-bridge gate.
       // Reflect genuine audit state to the customer without publishing a shadow candidate.
       const aud=await sb.schema("ninety_core").from("soren_daily_selection_candidate_audit_v1")
         .select("match_no,publication_status,vip_cold_gate,reason,v1_candidate,v2_decision,confidence_pct,funds_share_pct,institution_top1,funds_top1")
         .eq("pool_date",date).limit(150);
       if(!aud.error){
         const statusByNo=new Map((aud.data||[]).map((x:any)=>[String(x.match_no).padStart(3,"0"),x]));
         rows=rows.map((r:any)=>{
           const a:any=statusByNo.get(String(r.no).padStart(3,"0"));
           return {...r,dailySelectionTier:null,dailySelectionLabel:null,
             dailySelectionCustomerPublished:false,
             sorenSelectorAudit:a?{
               publicationStatus:a.publication_status,vipColdGate:a.vip_cold_gate,
               reason:a.reason,customerVisible:false,
               originalV1Candidate:a.v1_candidate,originalV2Decision:a.v2_decision,
               fundsSharePct:a.funds_share_pct,institutionTop1:a.institution_top1,
               fundsTop1:a.funds_top1,confidencePct:a.confidence_pct
             }:null};
         });
       }
      // Durable signed Soren publication; transient 15-minute audits never
      // promote or erase verified customer output.
      const publishedQ=await sb.schema("ninety_core").from("soren_daily_selection_publications_v1")
        .select("match_no,match_id,model_top1,model_frozen_at,original_run_id,published_at,publication_tier,selector_version,vip_cold_gate_version,publication_origin,hj38_model_run_id")
        .eq("pool_date",date).limit(150);
      if(publishedQ.error)throw publishedQ.error;
      // Verify the William band from the quote already captured before the
      // publication's pinned model freeze. V2 overlays outside this band are
      // preserved in the ledger but are not displayed as 精选补充.
      const supplementEntries=(publishedQ.data||[]).filter((x:any)=>
        x.publication_tier==="SUPPLEMENT");
      const supplementIds=[...new Set(supplementEntries.map((x:any)=>Number(x.match_id))
        .filter((x:number)=>Number.isInteger(x)&&x>0))];
      const williamQ=supplementIds.length
        ?await sb.schema("ninety_core").from("soren_market_snapshots")
          .select("match_id,home_value,draw_value,away_value,captured_at,ingested_at,data_quality")
          .in("match_id",supplementIds).eq("source_code","zucaijia_william")
          .eq("market_type","FT_1X2").eq("snapshot_type","current")
          .in("data_quality",["verified","verified_mirror"])
          .order("captured_at",{ascending:false}).limit(2000)
        :{data:[],error:null};
      if(williamQ.error)throw williamQ.error;
      const supplementOdds=new Map<string,number>();
      for(const entry of supplementEntries){
        const frozenAt=Date.parse(String(entry.model_frozen_at||""));
        const quote=(williamQ.data||[]).find((x:any)=>
          Number(x.match_id)===Number(entry.match_id)&&
          Date.parse(String(x.captured_at||""))<=frozenAt&&
          Date.parse(String(x.ingested_at||""))<=frozenAt);
        const odds=Number(entry.model_top1==="H"?quote?.home_value:
          entry.model_top1==="D"?quote?.draw_value:quote?.away_value);
        if(quote&&Number.isFinite(odds))supplementOdds.set(String(entry.match_no).padStart(3,"0"),odds);
      }
      // A durable selection must be verified against the exact prematch
      // HJ 3.8 run that created the publication, NOT the latest 15m rerun.
      // Reruns (or later settlement updates) may never erase an archived pick.
      const pinnedRunIds=[...new Set((publishedQ.data||[])
        .filter((x:any)=>x.publication_origin==="SG_FORMAL_HJ38_ADAPTED")
        .map((x:any)=>Number(x.hj38_model_run_id))
        .filter((id:number)=>Number.isInteger(id)&&id>0))];
      const pinnedQ=pinnedRunIds.length
        ?await sb.schema("ninety_core").from("hao_console_predictions")
          .select("pool_date,match_no,run_id,model_version,top1,frozen_at,kickoff_bjt,home_team,away_team")
          .eq("pool_date",date).in("run_id",pinnedRunIds).limit(200)
        :{data:[],error:null};
      if(pinnedQ.error)throw pinnedQ.error;
      const pinnedRunsQ=pinnedRunIds.length
        ?await sb.schema("ninety_core").from("hao_console_model_runs")
          .select("id,formal_allowed,data_complete").in("id",pinnedRunIds).limit(100)
        :{data:[],error:null};
      if(pinnedRunsQ.error)throw pinnedRunsQ.error;
      const pinnedFormalRuns=new Set((pinnedRunsQ.data||[])
        .filter((x:any)=>x.formal_allowed===true&&x.data_complete===true)
        .map((x:any)=>Number(x.id)));
      const pinnedByRunNo=new Map((pinnedQ.data||[]).map((x:any)=>
        [String(x.run_id)+":"+String(x.match_no||"").padStart(3,"0"),x]));
      const publicationBy=new Map((publishedQ.data||[]).map((x:any)=>[String(x.match_no).padStart(3,"0"),x]));
      rows=rows.map((r:any)=>{
        const entry:any=publicationBy.get(String(r.no||"").padStart(3,"0"));
        if(!entry)return r;
        const ko=Date.parse(String(r.kickoff||""));
        const published=Date.parse(String(entry.published_at||""));
        const frozen=Date.parse(String(entry.model_frozen_at||""));
        const original=Date.parse(String(r.sorenOriginalFrozenAt||""));
        const pickCode:Record<string,string>={主胜:"H",平:"D",客胜:"A"};
        const originalVerifiable=entry.publication_origin==="ORIGINAL_SOREN"&&
          r.sorenOriginalVerified===true&&r.sorenOriginalStatus==="FORMAL_ALIGNED"&&
          Number(r.sorenOriginalRunId)===Number(entry.original_run_id)&&
          r.sorenOriginalTop1===r.ftTop1&&Number.isFinite(original)&&original===frozen;
        const pinned:any=pinnedByRunNo.get(
          String(entry.hj38_model_run_id)+":"+String(entry.match_no||"").padStart(3,"0"));
        const fixture:any=realPool.get(String(r.no||"").padStart(3,"0"));
        const pinnedAt=Date.parse(String(pinned?.frozen_at||""));
        const pinnedKo=Date.parse(String(pinned?.kickoff_bjt||""));
        const adaptedVerifiable=entry.publication_origin==="SG_FORMAL_HJ38_ADAPTED"&&
          !!pinned&&!!fixture&&pinnedFormalRuns.has(Number(entry.hj38_model_run_id))&&
          Number(pinned.run_id)===Number(entry.hj38_model_run_id)&&
          Number(entry.match_id)===Number(fixture.id)&&
          pinned.pool_date===date&&pinned.model_version==="3.8"&&
          String(pinned.match_no||"").padStart(3,"0")===String(r.no||"").padStart(3,"0")&&
          pinned.home_team===r.home&&pinned.away_team===r.away&&
          pinned.top1===r.ftTop1&&pinned.top1===({H:"主胜",D:"平",A:"客胜"} as Record<string,string>)[String(entry.model_top1)]&&
          Number.isFinite(pinnedAt)&&pinnedAt===frozen&&
          Number.isFinite(pinnedKo)&&pinnedKo===ko&&
          // Validate the publication against its pinned formal run. A later
          // rerun may be non-formal or missing without erasing this record.
          Number.isFinite(pinnedAt)&&pinnedAt<Math.min(
            ko,
            fixture.cutoff_at?Date.parse(String(fixture.cutoff_at)):Infinity,
            Date.parse(date+"T"+([0,6].includes(new Date(date+"T12:00:00+08:00").getUTCDay())?"23":"22")+":00:00+08:00")
          );
        const supplementOdd=supplementOdds.get(String(entry.match_no).padStart(3,"0"));
        const supplementBandVerified=entry.publication_tier!=="SUPPLEMENT"||
          (supplementOdd!==undefined&&supplementOdd>=1.45&&supplementOdd<=1.75);
        const valid=r.pregameVerified===true&&(originalVerifiable||adaptedVerifiable)&&
          supplementBandVerified&&
          pickCode[String(r.ftTop1||"")]===entry.model_top1&&
          Number.isFinite(ko)&&Number.isFinite(published)&&Number.isFinite(frozen)&&
          frozen<=published&&published<ko&&published<=Date.now()&&
          r.dailySelectionRiskLocked!==true&&r.vipRiskLocked!==true&&
          r.highDrawRisk!==true&&r.marketDirectionAnomaly!==true&&r.upsetWarning?.publish!==true;
        // Current shadow audit is never a revocation of an already durably
        // published pregame CORE/SUPPLEMENT. Only a separately verified hard
        // risk lock may remove the customer recommendation.
        if(!valid)return {...r,sorenSelectorAudit:{...r.sorenSelectorAudit,
          publicationStatus:"FROZEN_PUBLICATION_BLOCKED_BY_CURRENT_RISK",customerVisible:false}};
        return {...r,dailySelectionTier:entry.publication_tier,
          dailySelectionLabel:entry.publication_tier==="CORE"?"核心优选":"精选补充",
          dailySelectionCustomerPublished:true,
          dailySelectionMeta:{
            selectorVersion:entry.selector_version,publishedAt:entry.published_at,
            publicationOrigin:entry.publication_origin,
            historicalRebuild:false,
            williamTop1Odds:entry.publication_tier==="SUPPLEMENT"?supplementOdd:null,
            source:entry.publication_origin==="ORIGINAL_SOREN"?
              "ORIGINAL_SOREN_PREMATCH_PUBLICATION":"SG_VERIFIED_ADAPTED_PREMATCH_PUBLICATION",
            rule:entry.publication_tier==="CORE"?"赛前单双选 · 风险审计通过":
              "精选补充 · 赛前市场与冷门过滤通过",
            fundsTop1Share:r.sorenSelectorAudit?.fundsSharePct??null
          },
          sorenSelectorAudit:{...r.sorenSelectorAudit,publicationStatus:"PUBLISHED",
            vipColdGate:"VERIFIED_NO_COLD_OR_BRIDGE_TRIGGER",customerVisible:true,
            verifiedPublishedAt:entry.published_at,selectorVersion:entry.selector_version,
            publicationOrigin:entry.publication_origin,gateVersion:entry.vip_cold_gate_version}};
      });
      // Original Soren DAILY-VALUE-v2.0: calculate CORE and top-3 verified market supplements.
      // Reconstructed historical candidates are NOT backdated as historical publications.
      if(date >= "2026-10-21"){
        const eligible=(r:any)=>r.pregameVerified===true &&
          r.dailySelectionRiskLocked!==true && r.vipRiskLocked!==true &&
          r.highDrawRisk!==true && r.marketDirectionAnomaly!==true &&
          r.upsetWarning?.publish!==true &&
          r.sorenOriginalVerified===true && r.sorenOriginalStatus==="FORMAL_ALIGNED";
        const core=(r:any)=>eligible(r)&&
          ["SINGLE","DOUBLE"].includes(String(r.mode||"").toUpperCase()) &&
          !!String(r.tier||"") && String(r.tier||"").toUpperCase()!=="PASS" &&
          r.pass!==true;
        const supplement=(r:any)=>eligible(r)&&!core(r)&&
          Number(r.sorenSelectorAudit?.confidencePct)>0 &&
          Number(r.sorenSelectorAudit?.williamTop1Odds)>=1.45 &&
          Number(r.sorenSelectorAudit?.williamTop1Odds)<=1.75 &&
          r.sorenSelectorAudit?.williamVerified===true;
        const supplementNos=new Set(rows.filter(supplement).sort((a:any,b:any)=>
          Number(b.sorenSelectorAudit?.confidencePct)-Number(a.sorenSelectorAudit?.confidencePct)||
          Number(a.sorenSelectorAudit?.williamTop1Odds)-Number(b.sorenSelectorAudit?.williamTop1Odds)||
          String(a.no).localeCompare(String(b.no))).slice(0,3).map((r:any)=>String(r.no)));
        rows=rows.map((r:any)=>{
          if(r.dailySelectionCustomerPublished===true)return r;
          const tier=core(r)?"CORE":supplementNos.has(String(r.no))?"SUPPLEMENT":null;
          if(!tier)return r;
          return {...r,dailySelectionTier:tier,dailySelectionLabel:tier==="CORE"?"核心优选":"精选补充",
            dailySelectionCustomerPublished:false,
            dailySelectionMeta:{selectorVersion:"DAILY-VALUE-v2.0-20261013",
              source:"ORIGINAL_SOREN_RULE_RECONSTRUCTED",historicalPublicationVerified:false,
              rule:tier==="CORE"?"索伦原版单双选 · 风险过滤":"William赔率与信心排序 · 风险过滤"}};
        });
      }
      rows=await attachVerifiedDayEnvironment(rows,date);
      if(view==="history")return await archiveCacheReply({ok:true,date,view,count:rows.filter((r:any)=>r.resultVerified).length,rows:rows.filter((r:any)=>r.resultVerified),modelVersion:formalRows[0]?.model_version??"3.8",analysisPending:false,shadow:false});
      if(["market-trend","report","member-intel","admin-overseas-intel"].includes(view))return reply({ok:false,error:"FEATURE_NOT_MIGRATED",view,shadow:false},501);
      if(!["today","archive"].includes(view))return reply({ok:false,error:"UNKNOWN_VIEW",view},400);
      return await archiveCacheReply({ok:true,view,date,count:rows.length,rows,model:"豪竞3.8",modelVersion:formalRows[0]?.model_version??"3.8",
        revision:formalRows[0]?.model_revision_tag??null,shadow:false,analysisPending:false,publicationStatus:"PREMATCH_VERIFIED",
        batchTime:formalRows[0]?.frozen_at??null,pregameVerifiedCount:rows.filter((r:any)=>r.pregameVerified).length,
        upsetStats:{published:rows.filter((r:any)=>r.upsetWarning?.publish===true).length},
        dailySelectionStats:{
          selectorVersion:"SG_ADAPTED_DAILY_VALUE_V2",
          core:rows.filter((r:any)=>r.dailySelectionTier==="CORE").length,
          supplement:rows.filter((r:any)=>r.dailySelectionTier==="SUPPLEMENT").length,
          total:rows.filter((r:any)=>["CORE","SUPPLEMENT"].includes(r.dailySelectionTier)).length,
          locked:rows.filter((r:any)=>r.dailySelectionRiskLocked===true).length
        }});
    }
    const x=await sb.rpc("ninety_customer_payload",{p_date:date});
    if(x.error)throw x.error;
    const all=(Array.isArray(x.data?.matches)?x.data.matches:[]).filter((m:any)=>
      !invalidDisplayNos.has(String(m.match_no||m.no||"").padStart(3,"0")));
    const history=date<currentBjt();
    const matches=vip?all:history?
      all.map((m:any)=>({...m,outputs:Object.fromEntries(Object.entries(m.outputs||{}).filter(([k])=>k!=="upset_warning"))})):
      all.map((m:any)=>({...m,outputs:all.filter((x:any)=>x.outputs?.ft).slice(0,2).some((x:any)=>x.match_key===m.match_key)?{ft:m.outputs.ft}:{}}));
    const perfStart=performance.now();
    let rows=await attachVerifiedModuleSettlements(matches.map((m:any)=>adaptRow(m,date)),matches);
    const settlementMs=Math.round(performance.now()-perfStart);
    rows=await attachCertifiedColdReadOnly(rows,date);
    const coldMs=Math.round(performance.now()-perfStart)-settlementMs;
    // Environment lookup is independent of the score-reference chain. Run it
    // concurrently, then apply its field changes last to preserve precedence.
    const envInput=rows;
    const environmentPromise=attachVerifiedDayEnvironment(envInput,date);
    rows=await attachOriginalPrematchScoreGoalHtftReferences(rows,date);
    rows=await attachFotmobStrictScoreTop4(rows,date);
    rows=await attachSingaporeScoreTop4(rows,matches,date);
    const environmentRows=await environmentPromise;
    rows=rows.map((row:any,i:number)=>{
      const env=environmentRows[i];
      if(!env||env===envInput[i])return row;
      const changed=Object.fromEntries(Object.entries(env).filter(([k,v])=>v!==envInput[i]?.[k]));
      return {...row,...changed};
    });
    console.info("SOREN_READ_PERF",JSON.stringify({view,settlementMs,coldMs,remainingMs:Math.round(performance.now()-perfStart)-settlementMs-coldMs,totalMs:Math.round(performance.now()-perfStart),rowCount:rows.length}));
    if(view==="cold-feed"||view==="member-zone"){
      if(!vip)return reply({ok:false,error:"VIP_REQUIRED"},403);
      const visible=rows.filter((r:any)=>r.coldRecognition?.customerVisible===true);
      return reply({ok:true,date,shadow:true,routeRuleVersion:"SG-PENDING-FORMAL",
        count:visible.length,rows:visible,partial:true,publishedOnly:false,
        membership,zone:{date,rows:visible,shadow:true,routeRuleVersion:"SG-PENDING-FORMAL"}});
    }
    if(view==="history"){
      const settled=rows.filter((r:any)=>r.resultVerified);
      return await archiveCacheReply({ok:true,date,view,count:settled.length,rows:settled,
        modelVersion:"SG-ADAPTER-0.5",analysisPending:true,shadow:true});
    }
    if(view==="market-trend"||view==="report"||view==="member-intel"||view==="admin-overseas-intel"){
      return reply({ok:false,error:"FEATURE_NOT_MIGRATED",view,shadow:true},501);
    }
    if(!["today","archive"].includes(view))
      return reply({ok:false,error:"UNKNOWN_VIEW",view},400);
    const latest=all.flatMap((m:any)=>Object.values(m.outputs||{}).map((o:any)=>String(o?.produced_at||""))).sort().at(-1)||null;
    const pending=rows.some((r:any)=>r.analysisPending===true);
    return await archiveCacheReply({ok:true,view,date,count:rows.length,rows,model:"九十刻度 · 新加坡影子",
      modelVersion:"SG-ADAPTER-0.5",revision:"singapore_adapter_0.5",shadow:true,
      analysisPending:pending,publicationStatus:pending?"SHADOW_PENDING_FORMAL":"SHADOW_PREMATCH_VISIBLE",
      batchTime:latest,pregameVerifiedCount:rows.filter((r:any)=>r.pregameVerified).length,
      upsetStats:{published:rows.filter((r:any)=>r.upsetWarning?.publish===true).length},
      dailySelectionStats:{core:rows.filter((r:any)=>r.dailySelectionTier==="CORE").length,
        supplement:rows.filter((r:any)=>r.dailySelectionTier==="SUPPLEMENT").length}
    });
  }catch(e){console.error("SG_COMPAT_FAILURE",e);return reply({ok:false,error:"SG_COMPAT_UNAVAILABLE"},503)}
});
