import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const handicapName: Record<string,string> = { HWIN: "让胜", HDRAW: "让平", HLOSS: "让负" };

/* A per-match customer-side freeze, independent of later mother-model refreshes.
   Without verified official cutoff, lock the first valid published snapshot early.
   Results and independent team/logo metadata remain live; prediction fields do not. */
async function applySaleFreeze(rows:Record<string,unknown>[],date:string):Promise<Record<string,unknown>[]> {
  if(date<"2026-09-23")return rows; // historic data predating deployment: do not relabel as sale-verified.
  const {data,error}=await db.rpc("soren_capture_sale_snapshots_v1",{p_date:date,p_rows:rows});
  if(error||!Array.isArray(data))throw new Error("SALE_FREEZE_UNAVAILABLE:"+String(error?.message??"INVALID_RESPONSE"));
  const byNo=new Map(data.map((x:Record<string,unknown>)=>[String(x.no??""),x]));
  const pick=(v:unknown)=>({"主胜":"H","平":"D","客胜":"A","3":"H","1":"D","0":"A","H":"H","D":"D","A":"A"}[String(v??"")]??null);
  return rows.map(row=>{
    const freeze=byNo.get(String(row.no??"").padStart(3,"0"));
    const saved=freeze?.snapshot;
    if(saved&&typeof saved==="object"&&!Array.isArray(saved)){
      const original=saved as Record<string,unknown>;
      // Only results, actual match status and presentation assets may change after locking.
      const output:Record<string,unknown>={...original};
      const mutable=["resultVerified","result","resultHome","resultAway","resultScore",
        "resultSource","resultVerifiedAt","matchStatus","resultStatus","resultAt",
        "handicapResult","homeLogo","awayLogo","logoSource","venueName",
        "venueCity","pitchSurface"];
      for(const key of mutable)if(Object.prototype.hasOwnProperty.call(row,key))output[key]=row[key];
      const hasResult=output.resultVerified===true;
      if(hasResult){
        const actual=pick(output.result);
        const first=pick(original.ftTop1),second=pick(original.second);
        output.top1Hit=actual!==null&&first===actual;
        output.coverageHit=actual!==null&&(first===actual||second===actual);
        const hp=String(original.handicapTop1??original.handicap??"");
        output.handicapHit=["让胜","让平","让负"].includes(String(output.handicapResult??""))
          ?hp===String(output.handicapResult):null;
      }else{output.top1Hit=null;output.coverageHit=null;output.handicapHit=null;}
      output.saleFreezeStatus=freeze?.status??"UNKNOWN";
      output.saleFreezeCapturedAt=freeze?.capturedAt??null;
      output.saleFreezeLockedAt=freeze?.lockedAt??null;
      output.saleCutoffAt=freeze?.cutoffAt??null;
      return settlePublishedScoreTop4(output);
    }
    // A legacy match whose kickoff preceded this feature cannot be certified retroactively.
    if(date==="2026-09-23"&&Number.isFinite(Date.parse(String(row.kickoff??"")))
       &&Date.now()>=Date.parse(String(row.kickoff)))
      return {...row,saleFreezeStatus:"LEGACY_SALE_CUTOFF_UNVERIFIED",saleCutoffAt:null};
    // Missing pre-cutoff evidence: fail closed rather than display a post-sale new prediction.
    return {...row,pregameVerified:false,ftTop1:null,second:null,handicap:null,
      handicapTop1:null,handicapSecond:null,scoreTop4:null,goalPrediction:null,
      upsetWarning:null,confidence:null,probabilities:null,homePct:null,drawPct:null,
      awayPct:null,saleFreezeStatus:String(freeze?.status??"UNVERIFIED"),
      saleCutoffAt:freeze?.cutoffAt??null};
  });
}

const TEAM_LOGO_PUBLIC_BASE = Deno.env.get("SUPABASE_URL") + "/storage/v1/object/public/team-logos/";

async function loadTeamLogoMap(){
  const [{data:aliases,error:aliasError},{data:logos,error:logoError}]=await Promise.all([
    db.from("soren_team_alias_fotmob").select("jc_team,fotmob_team_id"),
    db.from("soren_team_logo_cache").select("fotmob_team_id,object_path").eq("cache_status","cached").not("object_path","is",null),
  ]);
  if(aliasError)throw aliasError;
  if(logoError)throw logoError;
  const byId=new Map((logos??[]).map((x:Record<string,unknown>)=>[
    Number(x.fotmob_team_id),
    TEAM_LOGO_PUBLIC_BASE+String(x.object_path),
  ]));
  return new Map((aliases??[]).map((x:Record<string,unknown>)=>[
    String(x.jc_team),
    byId.get(Number(x.fotmob_team_id))??null,
  ]).filter((x:[string,string|null])=>x[1]));
}

function attachTeamLogos(row:Record<string,unknown>,logos:Map<string,string>){
  const home=String(row.home??row.homeTeam??row.home_team??"");
  const away=String(row.away??row.awayTeam??row.away_team??"");
  return {
    ...row,
    homeLogo:logos.get(home)??null,
    awayLogo:logos.get(away)??null,
    logoSource:"supabase-cache",
  };
}

/* Read verified environment snapshots with the day list, avoiding an extra
   report-network wait before displaying the weather and stadium header. */
async function loadDayEnvironment(date:string){
 const out=new Map<string,Record<string,unknown>>();
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return out;
 try{
  const {data,error}=await db.from("soren_environment_cache_v1")
   .select("match_no,home_team,away_team,kickoff_at,venue_name,venue_city,pitch_surface,temperature_c,humidity_pct,precipitation_probability_pct,wind_speed_kmh,forecast_time,forecast_fetched_at,quality,prematch_verified,created_at")
   .eq("pool_date",date).order("created_at",{ascending:false}).limit(200);
  if(error)throw error;
  for(const v of data??[]){
   const no=String(v.match_no??"").padStart(3,"0");
   if(!v.venue_name||!["EXACT_STADIUM_FORECAST","VERIFIED_STADIUM_PREMATCH","VERIFIED_STADIUM_POSTMATCH"].includes(String(v.quality)))continue;
   const key=no+"|"+String(v.home_team)+"|"+String(v.away_team);
   const kickoff=Date.parse(String(v.kickoff_at??""));
   if(!Number.isFinite(kickoff))continue;
   const prev=out.get(key);
   const hasWeather=v.quality==="EXACT_STADIUM_FORECAST"&&v.prematch_verified===true&&
     Number.isFinite(Date.parse(String(v.forecast_fetched_at??"")))&&
     Date.parse(String(v.forecast_fetched_at))<kickoff&&
     v.temperature_c!==null&&v.humidity_pct!==null&&
     Number.isFinite(Number(v.temperature_c))&&Number.isFinite(Number(v.humidity_pct));
   if(prev?.historicalForecast===true&&!hasWeather)continue;
   if(prev&&!(hasWeather&&prev.historicalForecast!==true))continue;
   out.set(key,{venueName:v.venue_name,venueCity:v.venue_city,pitchSurface:v.pitch_surface,
    kickoffAt:v.kickoff_at,temperatureC:hasWeather?v.temperature_c:null,
    humidityPct:hasWeather?v.humidity_pct:null,
    precipitationProbabilityPct:hasWeather?v.precipitation_probability_pct:null,
    windKmh:hasWeather?v.wind_speed_kmh:null,
    historicalForecast:hasWeather,venueRecoveredAfterKickoff:v.quality==="VERIFIED_STADIUM_POSTMATCH"});
  }
 }catch(error){console.error("DAY_ENVIRONMENT_READ_UNAVAILABLE",error)}
 return out;
}
function attachDayEnvironment(row:Record<string,unknown>,snapshots:Map<string,Record<string,unknown>>){
 const home=String(row.home??row.homeTeam??row.home_team??"");
 const away=String(row.away??row.awayTeam??row.away_team??"");
 const key=String(row.no??row.match_no??"").padStart(3,"0")+"|"+home+"|"+away;
 const env=snapshots.get(key);
 const kickoff=Date.parse(String(row.kickoff??row.kickoff_at??""));
 if(!env||!Number.isFinite(kickoff)||!Number.isFinite(Date.parse(String(env.kickoffAt)))||
    Math.abs(kickoff-Date.parse(String(env.kickoffAt)))>300000)return row;
 const {kickoffAt,...environment}=env;
 return {...row,environment};
}

async function loadVerifiedResults(date:string){
  const out=new Map<string,Record<string,unknown>>();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return out;
  const {data:matches,error:me}=await db.from("soren_matches").select("id,match_no,home_team,away_team,official_handicap").eq("pool_date",date);
  if(me)throw me;
  const ids=(matches??[]).map((m:Record<string,unknown>)=>Number(m.id)).filter(Number.isFinite);
  if(!ids.length)return out;
  const byId=new Map((matches??[]).map((m:Record<string,unknown>)=>[Number(m.id),m]));
  const {data:results,error:re}=await db.from("soren_results").select("match_id,home_score,away_score,ft_result,handicap_result,result_source,verified,verified_at").in("match_id",ids).eq("verified",true);
  if(re)throw re;
  for(const result of results??[]){
    const match=byId.get(Number(result.match_id));if(!match)continue;
    out.set(String(match.match_no??"").padStart(3,"0"),{...result,home_team:match.home_team,away_team:match.away_team,official_handicap:match.official_handicap});
  }
  return out;
}

async function loadHandicapBackfill(date: string) {
  const { data, error } = await db.from("soren_handicap_backfill_v1")
    .select("pool_date,match_no,source_kind,source_model_version,source_revision_tag,source_frozen_at,original_handicap_pick,handicap_top1,top1_probability,handicap_second,second_probability,probability_source,reconstruction_version,result_verified,actual_handicap_result,top1_hit,coverage_hit")
    .eq("pool_date", date).order("match_no", { ascending: true });
  if (error) throw error;
  return new Map((data ?? []).map((row: Record<string,unknown>) => [String(row.match_no ?? "").padStart(3,"0"), row]));
}
function applyHandicapBackfill(row: Record<string,unknown>, backfill: Map<string,Record<string,unknown>>) {
  const no = String(row.no ?? "").padStart(3,"0");
  const b = backfill.get(no);
  if (!b) return row;
  const sourceKind = String(b.source_kind ?? "");
  const primary = handicapName[String(b.handicap_top1 ?? "")] ?? null;
  const secondary = handicapName[String(b.handicap_second ?? "")] ?? null;
  const actual = handicapName[String(b.actual_handicap_result ?? "")] ?? null;
  const pct = (value: unknown) => Number.isFinite(Number(value)) ? Math.round(Number(value) * 1000) / 10 : null;
  const probabilitySource = b.probability_source === "MODEL_MARGIN" ? "模型净胜球概率" : "官方让球市场概率";
  return {
    ...row,
    handicap: primary,
    handicapTop1: primary,
    handicapProbability: pct(b.top1_probability),
    handicapSecond: secondary,
    handicapSecondProbability: pct(b.second_probability),
    handicapProbabilitySource: probabilitySource,
    handicapEligible: primary !== null,
    handicapQualityEligible: sourceKind === "ORIGINAL_PREMATCH",
    handicapSourceKind: sourceKind,
    handicapSourceLabel: sourceKind === "ORIGINAL_PREMATCH" ? "原始赛前预测" : "历史盲跑重建",
    handicapSourceVersion: b.source_model_version ?? null,
    handicapSourceRevision: b.source_revision_tag ?? null,
    handicapFrozenAt: b.source_frozen_at ?? null,
    handicapOriginalPick: b.original_handicap_pick ?? null,
    handicapReconstructionVersion: b.reconstruction_version ?? null,
    handicapReconstructed: sourceKind === "HISTORICAL_BLIND_REPLAY",
    handicapResult: b.result_verified === true ? actual : null,
    handicapTop1Hit: b.result_verified === true ? b.top1_hit === true : null,
    handicapCoverageHit: b.result_verified === true ? b.coverage_hit === true : null,
    handicapHit: b.result_verified === true ? b.coverage_hit === true : null,
    handicapAnalysis: sourceKind === "ORIGINAL_PREMATCH"
      ? "已恢复原始赛前让球首选；次选按同一冻结时点概率排序"
      : "原始PASS/空值；使用赛前冻结概率盲排首选与次选，未读取赛果",
  };
}

async function loadHistoricalScoreTop4(date:string){
 const {data,error}=await db.from("soren_score_top4_hj38_replay_v1").select("match_id,pool_date,match_no,scores,source_frozen_at,kickoff_at,provenance").eq("pool_date",date);
 if(error)throw error;
 return new Map((data??[]).map((v:Record<string,unknown>)=>[String(v.match_no??"").padStart(3,"0"),v]));
}
function attachHistoricalScoreTop4(row:Record<string,unknown>,scores:Map<string,Record<string,unknown>>){
 const item=scores.get(String(row.no??"").padStart(3,"0"));
 if(!item||row.scoreTop4)return row;
 const picks=item.scores as Array<Record<string,unknown>>;
 const frozen=Date.parse(String(item.source_frozen_at)),kickoff=Date.parse(String(row.kickoff)),sourceKickoff=Date.parse(String(item.kickoff_at));
 if(!Array.isArray(picks)||picks.length!==4||!Number.isFinite(frozen)||!Number.isFinite(kickoff)||frozen>=kickoff||Math.abs(sourceKickoff-kickoff)>60000)return row;
 const actual=row.resultVerified===true&&Number.isFinite(Number(row.resultHome))&&Number.isFinite(Number(row.resultAway))?String(row.resultHome)+"-"+String(row.resultAway):null;
 const hit=actual!==null&&picks.some(p=>String(p.score)===actual);
 return {...row,scoreTop4:{pregameVerified:true,frozenAt:item.source_frozen_at,picks,sourceKind:"HISTORICAL_BLIND_REPLAY",sourceLabel:"历史盲跑重建 · 豪竞3.8比分规则",settlementStatus:actual===null?"PENDING":hit?"SUCCESS":"FAILURE",hitScore:hit?actual:null}};
}

/* Score predictions are immutable; settle only a response copy against verified 90-minute results.
   Upstream snapshots can retain PENDING after customer result synchronization. */
function settlePublishedScoreTop4(row:Record<string,unknown>){
 const original=row.scoreTop4 as Record<string,unknown>|null|undefined;
 if(!original||original.pregameVerified!==true||!Array.isArray(original.picks)||original.picks.length!==4||row.resultVerified!==true)return row;
 const frozen=Date.parse(String(original.frozenAt??"")),kickoff=Date.parse(String(row.kickoff??""));
 if(!Number.isFinite(frozen)||!Number.isFinite(kickoff)||frozen>=kickoff)return row;
 if(row.resultHome===null||row.resultHome===undefined||row.resultAway===null||row.resultAway===undefined)return row;
 const home=Number(row.resultHome),away=Number(row.resultAway);
 if(!Number.isInteger(home)||!Number.isInteger(away)||home<0||away<0)return row;
 const actual=home+"-"+away;
 const hit=(original.picks as Record<string,unknown>[]).some(p=>String(p.score)===actual);
 const updated={...original,settlementStatus:hit?"SUCCESS":"FAILURE",hitScore:hit?actual:null,
   resultHome:home,resultAway:away,resultSource:row.resultSource??null,
   settledAt:row.resultVerifiedAt??original.settledAt??null};
 return {...row,scoreTop4:updated};
}

async function loadGoalPredictions(date: string) {
  const {data,error}=await db.from("soren_prematch_goals_v1").select("pool_date,match_no,home_team,away_team,kickoff_at,frozen_at,lambda_home,lambda_away").eq("pool_date",date);
  if(error)throw error;
  return new Map((data??[]).map((g:Record<string,unknown>)=>[String(g.match_no??"").padStart(3,"0"),g]));
}
function attachGoalPrediction(row:Record<string,unknown>,goals:Map<string,Record<string,unknown>>){
  const g=goals.get(String(row.no??"").padStart(3,"0"));
  if(!g||String(g.home_team)!==String(row.home)||String(g.away_team)!==String(row.away))return row;
  const frozen=Date.parse(String(g.frozen_at)),kickoff=Date.parse(String(row.kickoff)),sourceKickoff=Date.parse(String(g.kickoff_at));
  const home=Number(g.lambda_home),away=Number(g.lambda_away);
  if(!Number.isFinite(frozen)||!Number.isFinite(kickoff)||!Number.isFinite(sourceKickoff)||frozen>=kickoff||Math.abs(kickoff-sourceKickoff)>60000||!Number.isFinite(home)||!Number.isFinite(away)||home<=0||away<=0||home+away>15)return row;
  return {...row,goalPrediction:{pregameVerified:true,frozenAt:g.frozen_at,lambdaHome:home,lambdaAway:away,source:"豪竞赛前冻结泊松参数"}};
}
async function loadGoalFormReferences(date: string) {
  const {data,error}=await db.from("soren_prematch_goals_form_shadow_v1")
    .select("pool_date,match_no,home_team,away_team,kickoff_at,frozen_at,lambda_home,lambda_away,home_hist_n,away_hist_n,method")
    .eq("pool_date",date);
  if(error)throw error;
  return new Map((data??[]).map((g:Record<string,unknown>)=>[String(g.match_no??"").padStart(3,"0"),g]));
}
function attachGoalFormReference(row:Record<string,unknown>,goals:Map<string,Record<string,unknown>>){
  if((row.goalPrediction as Record<string,unknown>|undefined)?.pregameVerified===true)return row;
  const g=goals.get(String(row.no??"").padStart(3,"0"));
  if(!g||String(g.home_team)!==String(row.home)||String(g.away_team)!==String(row.away)
     ||g.method!=="FORM_LAST6_GOALS_POISSON_SHADOW_V1")return row;
  const freeze=Date.parse(String(g.frozen_at)),kickoff=Date.parse(String(row.kickoff)),originalKickoff=Date.parse(String(g.kickoff_at));
  const home=Number(g.lambda_home),away=Number(g.lambda_away);
  if(!Number.isFinite(freeze)||!Number.isFinite(kickoff)||!Number.isFinite(originalKickoff)
     ||freeze>=kickoff||Math.abs(kickoff-originalKickoff)>60000
     ||Number(g.home_hist_n)<6||Number(g.away_hist_n)<6
     ||!Number.isFinite(home)||!Number.isFinite(away)||home<0.2||away<0.2||home>3.8||away>3.8)return row;
  return {...row,goalPrediction:{pregameVerified:true,frozenAt:g.frozen_at,lambdaHome:home,lambdaAway:away,
     sourceKind:"FORM_LAST6_GOALS_POISSON_SHADOW_V1",formalEligible:false,source:"近6场历史得失球泊松参考（非严格xG）",
     sampleHome:Number(g.home_hist_n),sampleAway:Number(g.away_hist_n)}};
}
async function loadTeamScheduleSnapshots(date:string){
 const {data,error}=await db.from("soren_team_schedule_snapshot_v1")
  .select("pool_date,match_no,home_team,away_team,kickoff_at,fotmob_match_id,home_team_id,away_team_id,home_schedule,away_schedule,captured_at,fetched_at,source_quality")
  .eq("pool_date",date);
 if(error)throw error;
 return new Map((data??[]).map((s:Record<string,unknown>)=>[String(s.match_no??"").padStart(3,"0"),s]));
}
function attachTeamSchedule(row:Record<string,unknown>,snapshots:Map<string,Record<string,unknown>>){
 const s=snapshots.get(String(row.no??"").padStart(3,"0"));
 if(!s||String(s.home_team)!==String(row.home)||String(s.away_team)!==String(row.away))return row;
 const kick=Date.parse(String(row.kickoff)),sourceKick=Date.parse(String(s.kickoff_at)),frozen=Date.parse(String(s.captured_at));
 if(!Number.isFinite(kick)||!Number.isFinite(sourceKick)||!Number.isFinite(frozen)||frozen>=kick
 ||Math.abs(kick-sourceKick)>60000||s.source_quality!=="two_team_fixture_orientation_time_verified"
 ||!s.home_schedule||!s.away_schedule)return row;
 const home=s.home_schedule as Record<string,unknown>,away=s.away_schedule as Record<string,unknown>;
 if(home.next7Verified!==true||away.next7Verified!==true)return row;
 return {...row,teamSchedule:{verified:true,capturedAt:s.captured_at,home,away,source:"FotMob双方赛程核验",sourceQuality:s.source_quality}};
}
async function loadTeamFormH2hSnapshots(date:string){
 const {data,error}=await db.from("soren_team_form_h2h_snapshot_v1")
  .select("pool_date,match_no,home_team,away_team,kickoff_at,home_form,away_form,h2h,captured_at,fetched_at,source_quality")
  .eq("pool_date",date);
 if(error)throw error;
 return new Map((data??[]).map((s:Record<string,unknown>)=>[String(s.match_no??"").padStart(3,"0"),s]));
}
function attachTeamFormH2h(row:Record<string,unknown>,forms:Map<string,Record<string,unknown>>){
 const s=forms.get(String(row.no??"").padStart(3,"0"));
 if(!s||String(s.home_team)!==String(row.home)||String(s.away_team)!==String(row.away)
  ||s.source_quality!=="two_team_and_fixture_verified")return row;
 const kick=Date.parse(String(row.kickoff)),sourceKick=Date.parse(String(s.kickoff_at));
 const frozen=Date.parse(String(s.captured_at)),fetched=Date.parse(String(s.fetched_at));
 if(!Number.isFinite(kick)||!Number.isFinite(sourceKick)||!Number.isFinite(frozen)||!Number.isFinite(fetched)
  ||frozen>=kick||fetched>=kick||Math.abs(kick-sourceKick)>60000)return row;
 const home=s.home_form as Record<string,unknown>,away=s.away_form as Record<string,unknown>,h2h=s.h2h as Record<string,unknown>;
 const valid=(g:Record<string,unknown>,keys:string[])=>{
  const n=Number(g?.n);
  return Number.isInteger(n)&&n>=0&&n<=6&&Array.isArray(g?.matches)&&(g.matches as unknown[]).length===n
   &&keys.every(k=>Number.isInteger(Number(g[k]))&&Number(g[k])>=0)
   &&keys.reduce((sum,k)=>sum+Number(g[k]),0)===n;
 };
 if(!valid(home,["wins","draws","losses"])||!valid(away,["wins","draws","losses"])
  ||!valid(h2h,["homeWins","draws","awayWins"]))return row;
 return {...row,teamFormH2h:{verified:true,capturedAt:s.captured_at,home,away,h2h,
  source:"FotMob赛前球队历史比赛与直接交锋",definition:"最近6场独立球队战绩与直接交锋分别统计；非本场预测概率"}};
}
function buildHandicapStats(rows: Record<string,unknown>[]) {
  const settled = rows.filter((r) => r.handicapTop1Hit !== null && r.handicapTop1Hit !== undefined);
  const original = rows.filter((r) => r.handicapSourceKind === "ORIGINAL_PREMATCH");
  const replay = rows.filter((r) => r.handicapSourceKind === "HISTORICAL_BLIND_REPLAY");
  const summarize = (items: Record<string,unknown>[]) => {
    const done = items.filter((r) => r.handicapTop1Hit !== null && r.handicapTop1Hit !== undefined);
    const top1Hits = done.filter((r) => r.handicapTop1Hit === true).length;
    const coverageHits = done.filter((r) => r.handicapCoverageHit === true).length;
    return { total: items.length, settled: done.length, top1Hits, coverageHits,
      top1Rate: done.length ? Math.round(top1Hits / done.length * 1000) / 10 : null,
      coverageRate: done.length ? Math.round(coverageHits / done.length * 1000) / 10 : null };
  };
  return { total: rows.length, filled: rows.filter((r) => r.handicapTop1 && r.handicapSecond).length,
    missing: rows.filter((r) => !r.handicapTop1 || !r.handicapSecond).length, settled: settled.length,
    original: summarize(original), replay: summarize(replay) };
}

const legacySnapshots = {"2026-09-13":[{"date":"2026-09-13","no":"001","league":"日职联","home":"东京绿茵","away":"千叶市原","kickoff":"2026-09-13T09:00:00.000Z","ftTop1":"平","second":"主胜","confidence":null,"risk":{"hur":"红","dtr":"黄","dlr":"绿","dq":"DQ-A"},"officialHandicap":-1,"handicap":null,"frozenAt":"2026-09-13T08:28:07.476Z","pregameVerified":true,"version":"3.2","resultVerified":true,"result":"D"},{"date":"2026-09-13","no":"002","league":"日职乙","home":"仙台七夕","away":"札幌冈萨","kickoff":"2026-09-13T09:00:00.000Z","ftTop1":"主胜","second":"平","confidence":null,"risk":{"hur":"绿","dtr":"黄","dlr":"绿","dq":"DQ-A"},"officialHandicap":-1,"handicap":null,"frozenAt":"2026-09-13T08:28:07.476Z","pregameVerified":true,"version":"3.2","resultVerified":false,"result":null},{"date":"2026-09-13","no":"003","league":"西甲","home":"塞尔塔","away":"马拉加","kickoff":"2026-09-13T12:00:00.000Z","ftTop1":"主胜","second":"平","confidence":null,"risk":{"hur":"黄","dtr":"黄","dlr":"绿","dq":"DQ-A"},"officialHandicap":-1,"handicap":null,"frozenAt":"2026-09-13T10:19:02.068Z","pregameVerified":true,"version":"3.2","resultVerified":true,"result":"D"},{"date":"2026-09-13","no":"004","league":"瑞典超","home":"哈马比","away":"布鲁马波","kickoff":"2026-09-13T12:00:00.000Z","ftTop1":"主胜","second":"平","confidence":null,"risk":{"hur":"绿","dtr":"绿","dlr":"绿","dq":"DQ-C"},"officialHandicap":-2,"handicap":"让负","frozenAt":"2026-09-13T10:19:02.068Z","pregameVerified":true,"version":"3.2","resultVerified":true,"result":"H"},{"date":"2026-09-13","no":"005","league":"芬超","home":"库奥皮奥","away":"赫尔辛基","kickoff":"2026-09-13T12:00:00.000Z","ftTop1":"平","second":"主胜","confidence":null,"risk":{"hur":"红","dtr":"绿","dlr":"黄","dq":"DQ-A"},"officialHandicap":-1,"handicap":null,"frozenAt":"2026-09-13T10:19:02.068Z","pregameVerified":true,"version":"3.2","resultVerified":true,"result":"D"},{"date":"2026-09-13","no":"006","league":"荷甲","home":"海伦芬","away":"特尔斯达","kickoff":"2026-09-13T12:30:00.000Z","ftTop1":"主胜","second":"平","confidence":null,"risk":{"hur":"黄","dtr":"黄","dlr":"绿","dq":"DQ-A"},"officialHandicap":-1,"handicap":"让负","frozenAt":"2026-09-13T10:19:02.068Z","pregameVerified":true,"version":"3.2","resultVerified":true,"result":"D"},{"date":"2026-09-13","no":"007","league":"意甲","home":"莱切","away":"蒙扎","kickoff":"2026-09-13T13:00:00.000Z","ftTop1":"平","second":"客胜","confidence":null,"risk":{"hur":"红","dtr":"绿","dlr":"黄","dq":"DQ-A"},"officialHandicap":-1,"handicap":"让负","frozenAt":"2026-09-13T10:19:02.068Z","pregameVerified":true,"version":"3.2","resultVerified":true,"result":"H"},{"date":"2026-09-13","no":"008","league":"法甲","home":"里尔","away":"特鲁瓦","kickoff":"2026-09-13T13:00:00.000Z","ftTop1":"主胜","second":"平","confidence":null,"risk":{"hur":"绿","dtr":"黄","dlr":"绿","dq":"DQ-A"},"officialHandicap":-1,"handicap":"让负","frozenAt":"2026-09-13T10:19:02.068Z","pregameVerified":true,"version":"3.2","resultVerified":true,"result":"H"},{"date":"2026-09-13","no":"009","league":"德甲","home":"莱红牛","away":"汉堡","kickoff":"2026-09-13T13:30:00.000Z","ftTop1":"主胜","second":"平","confidence":null,"risk":{"hur":"绿","dtr":"绿","dlr":"绿","dq":"DQ-A"},"officialHandicap":-1,"handicap":"让负","frozenAt":"2026-09-13T13:15:20.346Z","pregameVerified":true,"version":"3.2","resultVerified":true,"result":"H"},{"date":"2026-09-13","no":"010","league":"西甲","home":"莱万特","away":"巴萨","kickoff":"2026-09-13T14:15:00.000Z","ftTop1":"客胜","second":"平","confidence":null,"risk":{"hur":"绿","dtr":"绿","dlr":"绿","dq":"DQ-C"},"officialHandicap":2,"handicap":"让胜","frozenAt":"2026-09-13T13:15:20.346Z","pregameVerified":true,"version":"3.2","resultVerified":true,"result":"A"},{"date":"2026-09-13","no":"011","league":"挪超","home":"汉坎","away":"莫尔德","kickoff":"2026-09-13T15:00:00.000Z","ftTop1":"客胜","second":"平","confidence":null,"risk":{"hur":"黄","dtr":"黄","dlr":"绿","dq":"DQ-A"},"officialHandicap":1,"handicap":"让负","frozenAt":"2026-09-13T13:15:20.346Z","pregameVerified":true,"version":"3.2","resultVerified":true,"result":"A"},{"date":"2026-09-13","no":"012","league":"法甲","home":"勒芒","away":"朗斯","kickoff":"2026-09-13T15:15:00.000Z","ftTop1":"客胜","second":"平","confidence":null,"risk":{"hur":"黄","dtr":"黄","dlr":"绿","dq":"DQ-A"},"officialHandicap":1,"handicap":null,"frozenAt":"2026-09-13T13:15:20.346Z","pregameVerified":true,"version":"3.2","resultVerified":true,"result":"D"},{"date":"2026-09-13","no":"013","league":"英超","home":"曼联","away":"曼城","kickoff":"2026-09-13T15:30:00.000Z","ftTop1":"客胜","second":"主胜","confidence":null,"risk":{"hur":"红","dtr":"绿","dlr":"黄","dq":"DQ-A"},"officialHandicap":1,"handicap":"让胜","frozenAt":"2026-09-13T13:15:20.346Z","pregameVerified":true,"version":"3.2","resultVerified":true,"result":"A"},{"date":"2026-09-13","no":"014","league":"德甲","home":"埃沃斯堡","away":"拜仁","kickoff":"2026-09-13T15:30:00.000Z","ftTop1":"客胜","second":"平","confidence":null,"risk":{"hur":"绿","dtr":"绿","dlr":"绿","dq":"DQ-C"},"officialHandicap":2,"handicap":"让胜","frozenAt":"2026-09-13T13:15:20.346Z","pregameVerified":true,"version":"3.2","resultVerified":true,"result":"A"},{"date":"2026-09-13","no":"015","league":"意甲","home":"那不勒斯","away":"博洛尼亚","kickoff":"2026-09-13T16:00:00.000Z","ftTop1":"主胜","second":"平","confidence":null,"risk":{"hur":"红","dtr":"黄","dlr":"绿","dq":"DQ-A"},"officialHandicap":-1,"handicap":null,"frozenAt":"2026-09-13T15:42:01.787Z","pregameVerified":true,"version":"3.2","resultVerified":true,"result":"H"},{"date":"2026-09-13","no":"016","league":"西甲","home":"赫塔费","away":"拉科","kickoff":"2026-09-13T16:30:00.000Z","ftTop1":"平","second":"主胜","confidence":null,"risk":{"hur":"红","dtr":"黄","dlr":"绿","dq":"DQ-A"},"officialHandicap":-1,"handicap":"让负","frozenAt":"2026-09-13T15:42:01.787Z","pregameVerified":true,"version":"3.2","resultVerified":true,"result":"D"},{"date":"2026-09-13","no":"017","league":"葡超","home":"本菲卡","away":"吉维森特","kickoff":"2026-09-13T17:00:00.000Z","ftTop1":"主胜","second":"平","confidence":null,"risk":{"hur":"绿","dtr":"绿","dlr":"绿","dq":"DQ-C"},"officialHandicap":-2,"handicap":"让负","frozenAt":"2026-09-13T15:42:01.787Z","pregameVerified":true,"version":"3.2","resultVerified":true,"result":"H"},{"date":"2026-09-13","no":"018","league":"荷甲","home":"埃因霍温","away":"鹿斯巴达","kickoff":"2026-09-13T18:00:00.000Z","ftTop1":"主胜","second":"平","confidence":null,"risk":{"hur":"绿","dtr":"绿","dlr":"绿","dq":"DQ-C"},"officialHandicap":-2,"handicap":"让负","frozenAt":"2026-09-13T15:42:01.787Z","pregameVerified":true,"version":"3.2","resultVerified":true,"result":"H"},{"date":"2026-09-13","no":"019","league":"意甲","home":"萨索洛","away":"尤文图斯","kickoff":"2026-09-13T18:45:00.000Z","ftTop1":"客胜","second":"平","confidence":null,"risk":{"hur":"黄","dtr":"黄","dlr":"绿","dq":"DQ-A"},"officialHandicap":1,"handicap":null,"frozenAt":"2026-09-13T15:42:01.787Z","pregameVerified":true,"version":"3.2","resultVerified":true,"result":"H"},{"date":"2026-09-13","no":"020","league":"法甲","home":"布雷斯特","away":"巴黎圣曼","kickoff":"2026-09-13T18:45:00.000Z","ftTop1":"客胜","second":"平","confidence":null,"risk":{"hur":"绿","dtr":"绿","dlr":"绿","dq":"DQ-A"},"officialHandicap":2,"handicap":"让胜","frozenAt":"2026-09-13T15:42:01.787Z","pregameVerified":true,"version":"3.2","resultVerified":true,"result":"A"},{"date":"2026-09-13","no":"021","league":"西甲","home":"皇家社会","away":"马竞","kickoff":"2026-09-13T19:00:00.000Z","ftTop1":"客胜","second":"主胜","confidence":null,"risk":{"hur":"红","dtr":"绿","dlr":"黄","dq":"DQ-A"},"officialHandicap":1,"handicap":"让胜","frozenAt":"2026-09-13T15:42:01.787Z","pregameVerified":true,"version":"3.2","resultVerified":true,"result":"A"},{"date":"2026-09-13","no":"022","league":"葡超","home":"法马利康","away":"里斯本","kickoff":"2026-09-13T19:30:00.000Z","ftTop1":"客胜","second":"平","confidence":null,"risk":{"hur":"绿","dtr":"黄","dlr":"绿","dq":"DQ-A"},"officialHandicap":1,"handicap":"让胜","frozenAt":"2026-09-13T15:42:01.787Z","pregameVerified":true,"version":"3.2","resultVerified":true,"result":"D"},{"date":"2026-09-13","no":"023","league":"巴甲","home":"弗拉门戈","away":"科林蒂安","kickoff":"2026-09-13T20:30:00.000Z","ftTop1":"主胜","second":"平","confidence":null,"risk":{"hur":"绿","dtr":"绿","dlr":"绿","dq":"DQ-A"},"officialHandicap":-1,"handicap":"让负","frozenAt":"2026-09-13T15:42:01.787Z","pregameVerified":true,"version":"3.2","resultVerified":true,"result":"H"},{"date":"2026-09-13","no":"024","league":"美职业","home":"芝加哥","away":"新英格兰","kickoff":"2026-09-13T21:30:00.000Z","ftTop1":"主胜","second":"客胜","confidence":null,"risk":{"hur":"红","dtr":"绿","dlr":"黄","dq":"DQ-A"},"officialHandicap":-1,"handicap":"让负","frozenAt":"2026-09-13T15:42:01.787Z","pregameVerified":true,"version":"3.2","resultVerified":true,"result":"A"}],"2026-09-14":[{"date":"2026-09-14","no":"001","league":"亚运女足","home":"中国女","away":"中国香港女","kickoff":"2026-09-14T10:00:00.000Z","ftTop1":"主胜","second":"平","confidence":null,"risk":{"hur":"绿","dtr":"绿","dlr":"绿","dq":"DQ-C"},"officialHandicap":-4,"handicap":null,"frozenAt":"2026-09-14T07:42:00.447Z","pregameVerified":true,"version":"3.3","resultVerified":true,"result":"H"},{"date":"2026-09-14","no":"002","league":"芬超","home":"国际图尔","away":"瓦萨","kickoff":"2026-09-14T15:00:00.000Z","ftTop1":"主胜","second":"平","confidence":null,"risk":{"hur":"黄","dtr":"黄","dlr":"绿","dq":"DQ-A"},"officialHandicap":-1,"handicap":null,"frozenAt":"2026-09-14T14:00:00.646Z","pregameVerified":true,"version":"3.3","resultVerified":true,"result":"H"},{"date":"2026-09-14","no":"003","league":"意甲","home":"科莫","away":"帕尔马","kickoff":"2026-09-14T16:30:00.000Z","ftTop1":"主胜","second":"平","confidence":null,"risk":{"hur":"绿","dtr":"绿","dlr":"绿","dq":"DQ-A"},"officialHandicap":-2,"handicap":"让负","frozenAt":"2026-09-14T14:00:00.646Z","pregameVerified":true,"version":"3.3","resultVerified":true,"result":"H"},{"date":"2026-09-14","no":"004","league":"意甲","home":"都灵","away":"罗马","kickoff":"2026-09-14T16:30:00.000Z","ftTop1":"客胜","second":"平","confidence":null,"risk":{"hur":"绿","dtr":"黄","dlr":"绿","dq":"DQ-A"},"officialHandicap":1,"handicap":"让负","frozenAt":"2026-09-14T14:00:00.646Z","pregameVerified":true,"version":"3.3","resultVerified":true,"result":"A"},{"date":"2026-09-14","no":"005","league":"瑞典超","home":"佐加顿斯","away":"盖斯","kickoff":"2026-09-14T17:00:00.000Z","ftTop1":"主胜","second":"平","confidence":null,"risk":{"hur":"绿","dtr":"黄","dlr":"绿","dq":"DQ-A"},"officialHandicap":-1,"handicap":"让负","frozenAt":"2026-09-14T14:00:00.646Z","pregameVerified":true,"version":"3.3","resultVerified":true,"result":"H"},{"date":"2026-09-14","no":"006","league":"挪超","home":"博德闪耀","away":"桑纳菲","kickoff":"2026-09-14T17:00:00.000Z","ftTop1":"主胜","second":"平","confidence":null,"risk":{"hur":"绿","dtr":"绿","dlr":"绿","dq":"DQ-C"},"officialHandicap":-2,"handicap":"让负","frozenAt":"2026-09-14T14:00:00.646Z","pregameVerified":true,"version":"3.3","resultVerified":true,"result":"H"},{"date":"2026-09-14","no":"007","league":"亚冠精英","home":"吉达国民","away":"塔什干棉农","kickoff":"2026-09-14T18:15:00.000Z","ftTop1":"主胜","second":"平","confidence":null,"risk":{"hur":"绿","dtr":"绿","dlr":"绿","dq":"DQ-C"},"officialHandicap":-2,"handicap":null,"frozenAt":"2026-09-14T14:00:00.646Z","pregameVerified":true,"version":"3.3","resultVerified":true,"result":"D"},{"date":"2026-09-14","no":"008","league":"意甲","home":"国际米兰","away":"乌迪内斯","kickoff":"2026-09-14T18:45:00.000Z","ftTop1":"主胜","second":"平","confidence":null,"risk":{"hur":"绿","dtr":"绿","dlr":"绿","dq":"DQ-A"},"officialHandicap":-2,"handicap":"让负","frozenAt":"2026-09-14T14:00:00.646Z","pregameVerified":true,"version":"3.3","resultVerified":true,"result":"H"},{"date":"2026-09-14","no":"009","league":"法乙","home":"圣旺红星","away":"梅斯","kickoff":"2026-09-14T18:45:00.000Z","ftTop1":"平","second":"主胜","confidence":null,"risk":{"hur":"红","dtr":"绿","dlr":"黄","dq":"DQ-A"},"officialHandicap":-1,"handicap":"让负","frozenAt":"2026-09-14T14:00:00.646Z","pregameVerified":true,"version":"3.3","resultVerified":true,"result":"H"},{"date":"2026-09-14","no":"010","league":"英超","home":"利兹联","away":"纽卡斯尔","kickoff":"2026-09-14T19:00:00.000Z","ftTop1":"平","second":"主胜","confidence":null,"risk":{"hur":"红","dtr":"绿","dlr":"黄","dq":"DQ-A"},"officialHandicap":-1,"handicap":"让负","frozenAt":"2026-09-14T14:00:00.646Z","pregameVerified":true,"version":"3.3","resultVerified":true,"result":"H"},{"date":"2026-09-14","no":"011","league":"西甲","home":"比利亚雷","away":"贝蒂斯","kickoff":"2026-09-14T19:00:00.000Z","ftTop1":"主胜","second":"平","confidence":null,"risk":{"hur":"红","dtr":"绿","dlr":"黄","dq":"DQ-A"},"officialHandicap":-1,"handicap":"让负","frozenAt":"2026-09-14T14:00:00.646Z","pregameVerified":true,"version":"3.3","resultVerified":true,"result":"A"},{"date":"2026-09-14","no":"012","league":"葡超","home":"布拉加","away":"埃斯托里","kickoff":"2026-09-14T19:45:00.000Z","ftTop1":"主胜","second":"平","confidence":null,"risk":{"hur":"绿","dtr":"黄","dlr":"绿","dq":"DQ-A"},"officialHandicap":-1,"handicap":"让负","frozenAt":"2026-09-14T14:00:00.646Z","pregameVerified":true,"version":"3.3","resultVerified":true,"result":"H"},{"date":"2026-09-14","no":"013","league":"亚运女足","home":"中国女","away":"中国香港女","kickoff":"2026-09-14T10:00:00.000Z","ftTop1":"主胜","second":"平","confidence":null,"risk":{"hur":"绿","dtr":"绿","dlr":"绿","dq":"DQ-C"},"officialHandicap":-4,"handicap":null,"frozenAt":"2026-09-14T07:42:00.447Z","pregameVerified":true,"version":"3.3","resultVerified":true,"result":"H"},{"date":"2026-09-14","no":"014","league":"亚运女足","home":"中国女","away":"中国香港女","kickoff":"2026-09-14T10:00:00.000Z","ftTop1":"主胜","second":"平","confidence":null,"risk":{"hur":"绿","dtr":"绿","dlr":"绿","dq":"DQ-C"},"officialHandicap":-4,"handicap":null,"frozenAt":"2026-09-14T07:42:00.447Z","pregameVerified":true,"version":"3.3","resultVerified":true,"result":"H"}],"2026-09-15":[{"date":"2026-09-15","no":"001","league":"亚冠精英","home":"拉查布里府","away":"上海海港","kickoff":"2026-09-15T10:00:00.000Z","ftTop1":"客胜","second":"主胜","confidence":null,"risk":{"hur":"红","dtr":"绿","dlr":"黄","dq":"DQ-A"},"officialHandicap":1,"handicap":null,"frozenAt":"2026-09-15T08:00:03.033Z","pregameVerified":true,"version":"3.3","resultVerified":false,"result":null},{"date":"2026-09-15","no":"002","league":"亚冠精英","home":"大田市民","away":"京都","kickoff":"2026-09-15T10:00:00.000Z","ftTop1":"主胜","second":"平","confidence":null,"risk":{"hur":"红","dtr":"绿","dlr":"黄","dq":"DQ-A"},"officialHandicap":-1,"handicap":null,"frozenAt":"2026-09-15T08:00:03.033Z","pregameVerified":true,"version":"3.3","resultVerified":true,"result":"H"},{"date":"2026-09-15","no":"003","league":"亚运男足","home":"卡塔尔U23","away":"韩国U23","kickoff":"2026-09-15T10:30:00.000Z","ftTop1":"客胜","second":"平","confidence":null,"risk":{"hur":"绿","dtr":"绿","dlr":"绿","dq":"DQ-A"},"officialHandicap":2,"handicap":null,"frozenAt":"2026-09-15T10:00:00.404Z","pregameVerified":true,"version":"3.3","resultVerified":true,"result":"A"},{"date":"2026-09-15","no":"004","league":"亚冠精英","home":"柔佛","away":"布里兰","kickoff":"2026-09-15T12:15:00.000Z","ftTop1":"主胜","second":"平","confidence":null,"risk":{"hur":"黄","dtr":"黄","dlr":"绿","dq":"DQ-A"},"officialHandicap":-1,"handicap":null,"frozenAt":"2026-09-15T12:00:00.396Z","pregameVerified":true,"version":"3.3","resultVerified":true,"result":"D"},{"date":"2026-09-15","no":"005","league":"亚冠精英","home":"北京国安","away":"浦项制铁","kickoff":"2026-09-15T12:15:00.000Z","ftTop1":"主胜","second":"平","confidence":null,"risk":{"hur":"绿","dtr":"黄","dlr":"绿","dq":"DQ-A"},"officialHandicap":-1,"handicap":null,"frozenAt":"2026-09-15T12:00:00.396Z","pregameVerified":true,"version":"3.3","resultVerified":true,"result":"H"},{"date":"2026-09-15","no":"006","league":"亚冠精英","home":"艾因","away":"利雅得胜利","kickoff":"2026-09-15T16:00:00.000Z","ftTop1":"客胜","second":"平","confidence":null,"risk":{"hur":"黄","dtr":"黄","dlr":"绿","dq":"DQ-A"},"officialHandicap":1,"handicap":null,"frozenAt":"2026-09-15T14:00:05.809Z","pregameVerified":true,"version":"3.3","resultVerified":true,"result":"H"},{"date":"2026-09-15","no":"007","league":"西甲","home":"巴列卡诺","away":"西班牙人","kickoff":"2026-09-15T17:00:00.000Z","ftTop1":"平","second":"主胜","confidence":null,"risk":{"hur":"红","dtr":"绿","dlr":"黄","dq":"DQ-A"},"officialHandicap":-1,"handicap":"让负","frozenAt":"2026-09-15T14:00:05.809Z","pregameVerified":true,"version":"3.3","resultVerified":true,"result":"H"},{"date":"2026-09-15","no":"008","league":"西甲","home":"阿拉维斯","away":"巴伦西亚","kickoff":"2026-09-15T18:00:00.000Z","ftTop1":"主胜","second":"平","confidence":null,"risk":{"hur":"黄","dtr":"黄","dlr":"绿","dq":"DQ-A"},"officialHandicap":-1,"handicap":null,"frozenAt":"2026-09-15T14:00:05.809Z","pregameVerified":true,"version":"3.3","resultVerified":true,"result":"A"},{"date":"2026-09-15","no":"009","league":"荷甲","home":"阿贾克斯","away":"威廉二世","kickoff":"2026-09-15T18:00:00.000Z","ftTop1":"主胜","second":"平","confidence":null,"risk":{"hur":"绿","dtr":"绿","dlr":"绿","dq":"DQ-C"},"officialHandicap":-2,"handicap":"让负","frozenAt":"2026-09-15T14:00:05.809Z","pregameVerified":true,"version":"3.3","resultVerified":true,"result":"H"},{"date":"2026-09-15","no":"010","league":"英冠","home":"米堡","away":"米尔沃尔","kickoff":"2026-09-15T18:45:00.000Z","ftTop1":"主胜","second":"平","confidence":null,"risk":{"hur":"绿","dtr":"黄","dlr":"绿","dq":"DQ-A"},"officialHandicap":-1,"handicap":"让负","frozenAt":"2026-09-15T14:00:05.809Z","pregameVerified":true,"version":"3.3","resultVerified":true,"result":"D"},{"date":"2026-09-15","no":"011","league":"英联杯","home":"利物浦","away":"热刺","kickoff":"2026-09-15T19:00:00.000Z","ftTop1":"主胜","second":"平","confidence":null,"risk":{"hur":"黄","dtr":"黄","dlr":"绿","dq":"DQ-A"},"officialHandicap":-1,"handicap":"让负","frozenAt":"2026-09-15T14:00:05.809Z","pregameVerified":true,"version":"3.3","resultVerified":true,"result":"H"},{"date":"2026-09-15","no":"012","league":"英联杯","home":"伊普斯维奇","away":"阿森纳","kickoff":"2026-09-15T19:00:00.000Z","ftTop1":"客胜","second":"平","confidence":null,"risk":{"hur":"绿","dtr":"绿","dlr":"绿","dq":"DQ-A"},"officialHandicap":1,"handicap":"让负","frozenAt":"2026-09-15T14:00:05.809Z","pregameVerified":true,"version":"3.3","resultVerified":true,"result":"A"},{"date":"2026-09-15","no":"013","league":"西甲","home":"埃尔切","away":"皇马","kickoff":"2026-09-15T19:30:00.000Z","ftTop1":"客胜","second":"平","confidence":null,"risk":{"hur":"绿","dtr":"绿","dlr":"绿","dq":"DQ-C"},"officialHandicap":2,"handicap":"让胜","frozenAt":"2026-09-15T14:00:05.809Z","pregameVerified":true,"version":"3.3","resultVerified":true,"result":"A"},{"date":"2026-09-15","no":"014","league":"解放者杯","home":"普拉腾斯","away":"弗鲁米嫩","kickoff":"2026-09-15T22:00:00.000Z","ftTop1":"平","second":"主胜","confidence":null,"risk":{"hur":"红","dtr":"绿","dlr":"黄","dq":"DQ-A"},"officialHandicap":-1,"handicap":"让负","frozenAt":"2026-09-15T14:00:05.809Z","pregameVerified":true,"version":"3.3","resultVerified":true,"result":"H"}]};
const upstream = "https://tqlibowvnwfkaseqqvvp.supabase.co/functions/v1/hao-console-v1";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
};
const allowed = new Map([
  ["3.3", "3.3-clean-green-single-v0.1-20260916"],
  ["3.6", "3.6-draw-route-v0.1-20260918"],
  ["3.8", "3.8-bplus-single-double-v0.1-20260919"],
]);
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: cors });

async function syncUpsetWarnings(rows: Record<string,unknown>[], data: Record<string,unknown>) {
  const payload = rows.flatMap((row) => {
    const warning = row.upsetWarning;
    if (!warning || typeof warning !== "object" || row.pregameVerified !== true) return [];
    const w = warning as Record<string,unknown>;
    const frozenAt = String(w.prematchAt ?? w.prematch_at ?? row.frozenAt ?? "");
    const poolDate = String(row.date ?? data.date ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(poolDate) || !frozenAt) return [];
    return [{
      pool_date: poolDate,
      match_no: String(row.no ?? "").padStart(3,"0"),
      league: row.league ?? null,
      home_team: row.home ?? null,
      away_team: row.away ?? null,
      kickoff_bjt: row.kickoff ?? null,
      source_model_version: String(w.sourceModelVersion ?? w.source_model_version ?? row.version ?? data.modelVersion ?? "3.8"),
      source_revision: String(w.sourceRevision ?? w.source_revision ?? row.revision ?? data.revision ?? "unconfirmed"),
      warning_model_version: String(w.modelVersion ?? w.model_version ?? "HJ38-UPSET-v1.0.0"),
      risk_level: String(w.riskLevel ?? w.risk_level ?? "未确认"),
      risk_score: Number(w.riskScore ?? w.risk_score ?? 0),
      original_top1: w.originalTop1 ?? w.original_top1 ?? row.ftTop1 ?? null,
      warning_direction: w.warningDirection ?? w.warning_direction ?? null,
      alternative_pick: w.alternativePick ?? w.alternative_pick ?? null,
      risk_basis: Array.isArray(w.riskBasis) ? w.riskBasis : (Array.isArray(w.risk_basis) ? w.risk_basis : []),
      direction_basis: Array.isArray(w.directionBasis) ? w.directionBasis : (Array.isArray(w.direction_basis) ? w.direction_basis : []),
      evidence_domains: Array.isArray(w.evidenceDomains) ? w.evidenceDomains : (Array.isArray(w.evidence_domains) ? w.evidence_domains : []),
      directional_domain_count: Number(w.directionalDomainCount ?? w.directional_domain_count ?? 0),
      source_frozen_at: frozenAt,
      result_fields_used: w.resultFieldsUsed === true || w.result_fields_used === true,
      hur_direction_used: w.hurDirectionUsed === true || w.hur_direction_used === true,
      source_payload: w,
      synced_at: new Date().toISOString(),
    }];
  });
  if (!payload.length) return {synced:0};
  const {error}=await db.from("soren_upset_warnings_v1").upsert(payload,{onConflict:"pool_date,match_no,source_frozen_at"});
  if(error)throw error;
  return {synced:payload.length};

}

const warningKey=(no:unknown,frozen:unknown)=>{
  const t=Date.parse(String(frozen??""));
  return String(no??"").padStart(3,"0")+"|"+(Number.isFinite(t)?new Date(t).toISOString():String(frozen??""));
};
async function loadUpsetWarningMap(date:string){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return new Map<string,Record<string,unknown>>();
  const {data,error}=await db.from("soren_upset_warnings_v1")
    .select("pool_date,match_no,source_model_version,source_revision,warning_model_version,risk_level,risk_score,original_top1,warning_direction,alternative_pick,risk_basis,direction_basis,evidence_domains,directional_domain_count,source_frozen_at,result_fields_used,hur_direction_used,source_payload")
    .eq("pool_date",date).order("match_no",{ascending:true});
  if(error)throw error;
  return new Map((data??[]).map((w:Record<string,unknown>)=>[warningKey(w.match_no,w.source_frozen_at),w]));
}
function publicWarning(w:Record<string,unknown>){
  const p=(w.source_payload&&typeof w.source_payload==="object"?w.source_payload:{}) as Record<string,unknown>;
  const risk=String(w.risk_level??"未确认");
  return {status:String(p.status??"ACTIVE"),publish:risk==="中"||risk==="高",riskLevel:risk,riskScore:Number(w.risk_score??0),originalTop1:w.original_top1??null,warningDirection:w.warning_direction??null,alternativePick:w.alternative_pick??null,riskBasis:Array.isArray(w.risk_basis)?w.risk_basis:[],directionBasis:Array.isArray(w.direction_basis)?w.direction_basis:[],evidenceDomains:Array.isArray(w.evidence_domains)?w.evidence_domains:[],directionalDomainCount:Number(w.directional_domain_count??0),modelVersion:w.warning_model_version??null,sourceModelVersion:w.source_model_version??null,sourceRevision:w.source_revision??null,prematchAt:w.source_frozen_at??null,resultFieldsUsed:w.result_fields_used===true,hurDirectionUsed:w.hur_direction_used===true,note:p.note??null,replayMode:p.replay_mode??null,historyRewrite:p.history_rewrite===true};
}
function attachUpsetWarning(row:Record<string,unknown>,warnings:Map<string,Record<string,unknown>>){
  if(row.upsetWarning&&typeof row.upsetWarning==="object")return row;
  const w=warnings.get(warningKey(row.no,row.frozenAt));
  return w?{...row,upsetWarning:publicWarning(w)}:row;
}
function upsetStatsFor(rows:Record<string,unknown>[]){
  const published=rows.filter(r=>{const w=r.upsetWarning as Record<string,unknown>|null;return w?.publish===true});
  return {modelVersion:"HJ38-UPSET-v1.0.0",published:published.length,high:published.filter(r=>(r.upsetWarning as Record<string,unknown>)?.riskLevel==="高").length,medium:published.filter(r=>(r.upsetWarning as Record<string,unknown>)?.riskLevel==="中").length,directionPublished:published.filter(r=>!!(r.upsetWarning as Record<string,unknown>)?.warningDirection).length,resultFieldsUsed:published.some(r=>(r.upsetWarning as Record<string,unknown>)?.resultFieldsUsed===true),hurDirectionUsed:published.some(r=>(r.upsetWarning as Record<string,unknown>)?.hurDirectionUsed===true)};
}


/* Read-only, authenticated, on-demand match report. All inputs are cached
   in Soren customer DB; this route never invokes an external football API. */
async function professionalReport(date:string,no:string){
  const {data:match,error:matchError}=await db.from("soren_matches")
    .select("id,pool_date,match_no,home_team,away_team,kickoff_at,official_handicap")
    .eq("pool_date",date).eq("match_no",no).maybeSingle();
  if(matchError)throw matchError;
  if(!match)return null;
  const kickoff=String(match.kickoff_at??"");
  const id=Number(match.id);
  const {data:environmentRows,error:environmentError}=await db.from("soren_environment_cache_v1")
    .select("home_team,away_team,kickoff_at,venue_name,venue_city,pitch_surface,temperature_c,humidity_pct,precipitation_probability_pct,wind_speed_kmh,forecast_time,forecast_fetched_at,venue_source,weather_source,quality,prematch_verified,created_at")
    .eq("match_id",id).order("created_at",{ascending:false}).limit(12);
  if(environmentError)throw environmentError;
  const verifiedVenues=(environmentRows??[]).filter(v=>
    String(v.home_team)===String(match.home_team)&&String(v.away_team)===String(match.away_team)&&
    Number.isFinite(Date.parse(String(v.kickoff_at)))&&
    Math.abs(Date.parse(String(v.kickoff_at))-Date.parse(kickoff))<300000&&
    typeof v.venue_name==="string"&&v.venue_name.trim().length>1&&
    ["EXACT_STADIUM_FORECAST","VERIFIED_STADIUM_PREMATCH","VERIFIED_STADIUM_POSTMATCH"].includes(String(v.quality)));
  const forecastUsable=(v:Record<string,unknown>)=>
    v.quality==="EXACT_STADIUM_FORECAST"&&v.prematch_verified===true&&
    Number.isFinite(Date.parse(String(v.forecast_fetched_at)))&&
    Date.parse(String(v.forecast_fetched_at))<Date.parse(kickoff)&&
    Number.isFinite(Number(v.temperature_c))&&Number.isFinite(Number(v.humidity_pct));
  const environmentRow=verifiedVenues.find(v=>forecastUsable(v))??verifiedVenues[0]??null;
  const forecastAvailable=environmentRow?forecastUsable(environmentRow):false;
  const environment=environmentRow?{
    venueName:environmentRow.venue_name,venueCity:environmentRow.venue_city,
    pitchSurface:environmentRow.pitch_surface,
    temperatureC:forecastAvailable?environmentRow.temperature_c:null,
    humidityPct:forecastAvailable?environmentRow.humidity_pct:null,
    precipitationProbabilityPct:forecastAvailable?environmentRow.precipitation_probability_pct:null,
    windKmh:forecastAvailable?environmentRow.wind_speed_kmh:null,
    forecastTime:forecastAvailable?environmentRow.forecast_time:null,
    fetchedAt:forecastAvailable?environmentRow.forecast_fetched_at:environmentRow.created_at,
    venueSource:environmentRow.venue_source,weatherSource:forecastAvailable?environmentRow.weather_source:null,
    historicalForecast:forecastAvailable,
    venueRecoveredAfterKickoff:environmentRow.quality==="VERIFIED_STADIUM_POSTMATCH",
    note:forecastAvailable?"赛前采集的开球时段天气预报，非赛后实际天气；不可据此推断模型正式预测输入":
      "仅核对该场比赛的球场；未取得可核验赛前天气，不得推断当时气温、湿度和降雨"
  }:null;
  // Verified pair and collection time belong to the target match, never inferred from final scores.
  const {data:newsRows,error:newsError}=await db.from("soren_intelligence_reports_v1")
    .select("home_team,away_team,source_code,source_url,headline,published_at,fetched_at,quality,highlights")
    .eq("match_id",id)
    .lt("published_at",kickoff).lt("fetched_at",kickoff)
    .order("published_at",{ascending:false}).limit(6);
  if(newsError)throw newsError;
  const articles=(newsRows??[]).filter(v=>String(v.home_team)===String(match.home_team)
    &&String(v.away_team)===String(match.away_team)
    &&v.quality==="attributed_prematch_article_pair_verified"
    &&/^https:\/\/sports\.sina\.com\.cn\/l\//.test(String(v.source_url||"")))
    .map(v=>({source:"新浪小炮赛前情报（媒体观点，未独立核验）",
      title:v.headline,url:v.source_url,publishedAt:v.published_at,fetchedAt:v.fetched_at,
      sections:Array.isArray(v.highlights)?v.highlights:[]}));
  const [{data:market,error:marketError},{data:predictions,error:predError},{data:features,error:featureError}]=await Promise.all([
    db.from("soren_market_snapshots")
      .select("source_code,market_type,snapshot_type,home_value,draw_value,away_value,line,home_water,away_water,data_quality,payload,captured_at")
      .eq("match_id",id)
      .in("source_code",["zucaijia_william","zucaijia_asia4:1","zucaijia_asia4:11","zucaijia_asia4:18","zucaijia_asia4:31"])
      .lte("captured_at",kickoff).order("captured_at",{ascending:false}).limit(1000),
    db.from("soren_predictions").select("confidence,primary_reason,dq,frozen_at,source_snapshot")
      .eq("match_id",id).lte("frozen_at",kickoff).order("frozen_at",{ascending:false}).limit(1),
    db.from("soren_feature_snapshots")
      .select("source_code,feature_type,data_quality,payload,captured_at")
      .eq("match_id",id).in("feature_type",["ELO","PRO_PREDICTION"])
      .lte("captured_at",kickoff).order("captured_at",{ascending:false}).limit(100),
  ]);
  if(marketError)throw marketError;
  if(predError)throw predError;
  if(featureError)throw featureError;
  const selected=new Map<string,Record<string,unknown>>();
  for(const row of market??[]){
    if(!["verified","verified_mirror"].includes(String(row.data_quality)))continue;
    if(String(row.market_type)!=="FT_1X2"&&String(row.market_type)!=="ASIAN_HANDICAP")continue;
    const key=String(row.source_code)+"|"+String(row.snapshot_type);
    if(!selected.has(key))selected.set(key,row);
  }
  const numeric=(x:unknown)=>x===null||x===undefined||x===""?null:Number.isFinite(Number(x))?Number(x):null;
  const compact=(row:Record<string,unknown>|undefined)=> {
    if(!row)return null;
    const payload=(row.payload&&typeof row.payload==="object"?row.payload:{}) as Record<string,unknown>;
    return {source:String(row.source_code),type:String(row.market_type),
      capturedAt:row.captured_at,home:numeric(row.home_value),draw:numeric(row.draw_value),
      away:numeric(row.away_value),line:numeric(row.line),lineText:payload.original_line??null,
      homeWater:numeric(row.home_water),awayWater:numeric(row.away_water)};
  };
  const bookmaker=compact(selected.get("zucaijia_william|current"));
  const initial=compact(selected.get("zucaijia_william|initial"));
  const companies:Record<string,string>={"zucaijia_asia4:1":"Bet365","zucaijia_asia4:11":"皇冠","zucaijia_asia4:18":"12bet","zucaijia_asia4:31":"威廉希尔"};
  const asian=Object.entries(companies).map(([key,name])=>({
    institution:name,initial:compact(selected.get(key+"|initial")),current:compact(selected.get(key+"|current"))
  })).filter(c=>c.initial||c.current);
  const prediction=predictions?.[0]??null;
  const snap=(prediction?.source_snapshot&&typeof prediction.source_snapshot==="object"?prediction.source_snapshot:{}) as Record<string,unknown>;
  const strictlyFrozen=prediction&&Date.parse(String(prediction.frozen_at))<Date.parse(kickoff)&&
    String(snap.home??"")===String(match.home_team)&&String(snap.away??"")===String(match.away_team);
  const pct=(v:unknown)=>{const n=numeric(v);if(n===null||n<0)return null;return n<=1?n*100:n<=100?n:null;};
  const probability=strictlyFrozen?[pct(snap.homeProbability),pct(snap.drawProbability),pct(snap.awayProbability)]:[null,null,null];
  const odds=[bookmaker?.home,bookmaker?.draw,bookmaker?.away];
  const implied=odds.every(x=>typeof x==="number"&&x>1)?odds.map(x=>1/(x as number)):null;
  const denominator=implied?.reduce((a,b)=>a+b,0)??0;
  const fair=denominator>0?implied!.map(x=>Math.round(x/denominator*1000)/10):null;
  // This is a theoretical model-based Kelly fraction, NOT a bookmaker's published Kelly index.
  const kelly=odds.every(x=>typeof x==="number"&&x>1)&&probability.every(x=>x!==null)?
    odds.map((o,i)=>Math.round(10000*Math.max(0,((probability[i] as number)/100*(o as number)-1)/((o as number)-1)))/100):null;
  // Distinct from the institution/market-average Kelly index. Benchmark is the
  // ORIGINAL frozen model probabilities, not a verified multi-bookmaker consensus.
  const modelOddsIndex=odds.every(x=>typeof x==="number"&&x>1)&&
    probability.every(x=>x!==null)&&
    Math.abs(probability.reduce((a,b)=>a+Number(b),0)-100)<=1?
    odds.map((o,i)=>Math.round((o as number)*(probability[i] as number)/100*10000)/10000):null;
  const featureSet=new Map<string,Record<string,unknown>>();
  for(const f of features??[]){
    const key=String(f.source_code);
    if(!featureSet.has(key)&&!String(f.data_quality).includes("unverified"))featureSet.set(key,f);
  }
  const elo=featureSet.get("fotmob_elo_v2_shadow")??featureSet.get("fotmob_elo")??featureSet.get("elo");
  const kickoffAi=featureSet.get("kickoff_ai");
  const eloPayload=(elo?.payload&&typeof elo.payload==="object"?elo.payload:{}) as Record<string,unknown>;
  const aiPayload=(kickoffAi?.payload&&typeof kickoffAi.payload==="object"?kickoffAi.payload:{}) as Record<string,unknown>;
  return {matchId:id,date,no,kickoff,home:match.home_team,away:match.away_team,
    environment,
    intelligence:{articles,status:articles.length?"VERIFIED_PAIR_MEDIA":"NO_VERIFIED_MEDIA",note:"媒体稿件仅展示原文标题、赛前时间和核验场次；伤停名单尚未独立确认"},
    source:"索伦客户库赛前缓存",market:{european:{institution:"威廉希尔",initial,current:bookmaker,fairProbability:fair},asian},
    model:{top1:strictlyFrozen?snap.ftTop1??null:null,second:strictlyFrozen?snap.second??null:null,
      confidence:strictlyFrozen?pct(prediction.confidence):null,probability,probabilitySource:strictlyFrozen?snap.ftProbabilitySource??null:null,
      reason:strictlyFrozen?prediction.primary_reason??null:null,riskAnalysis:strictlyFrozen?snap.riskAnalysis??null:null,
      handicapAnalysis:strictlyFrozen?snap.handicapAnalysis??null:null,dq:strictlyFrozen?prediction.dq??null:null,
      frozenAt:strictlyFrozen?prediction.frozen_at:null,sourceKind:strictlyFrozen?"ORIGINAL_PREMATCH":null},
    modelOddsIndex:modelOddsIndex===null?null:{values:modelOddsIndex,formula:"frozen_model_probability × william_decimal_odds",label:"豪竞模型赔率参照值（非机构公布凯利指数）",probabilitySource:"原始赛前冻结豪竞最终概率",
      oddsSource:"威廉希尔赛前欧赔",probabilityAt:prediction?.frozen_at??null,oddsAt:bookmaker?.capturedAt??null},
    kelly:kelly===null?null:{percent:kelly,formula:"max(0,(p×odds−1)/(odds−1))",label:"理论凯利资金比例（非机构凯利指数）",
      probabilityAt:prediction?.frozen_at??null,oddsAt:bookmaker?.capturedAt??null},
    feature:{elo:elo?{home:numeric(eloPayload.elo_home),away:numeric(eloPayload.elo_away),diff:numeric(eloPayload.elo_diff),at:elo.captured_at,shadow:String(elo.source_code).includes("shadow")}:null,
      kickoffAi:kickoffAi?{home:pct(aiPayload.p_home),draw:pct(aiPayload.p_draw),away:pct(aiPayload.p_away),at:kickoffAi.captured_at}:null},
    injuries:{status:"UNAVAILABLE",note:"客户库尚未有本场已核验的赛前球员伤停名单"},
    capturedLimit:"仅使用开球前已采集的缓存；盘口采集时间可能晚于原预测冻结时间，不能视作原预测输入"};
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "GET") return reply({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
  const requestUrl = new URL(req.url);
  if (requestUrl.searchParams.get("health") === "team-logos") {
    try {
      const logos=await loadTeamLogoMap();
      const [{data:cache,error:cacheError},{data:matches,error:matchError}]=await Promise.all([
        db.from("soren_team_logo_cache").select("fotmob_team_id,cache_status,object_path,byte_size,fetched_at"),
        db.from("soren_matches").select("pool_date,match_no,home_team,away_team").order("pool_date",{ascending:false}).order("match_no",{ascending:true}).limit(100),
      ]);
      if(cacheError)throw cacheError;if(matchError)throw matchError;
      const sample=(matches??[]).slice(0,12).map((m:Record<string,unknown>)=>({
        date:m.pool_date,no:m.match_no,home:m.home_team,away:m.away_team,
        homeLogo:logos.get(String(m.home_team))??null,
        awayLogo:logos.get(String(m.away_team))??null,
      }));
      return reply({
        ok:true,health:"team-logos",
        mappedNames:logos.size,
        cacheRows:(cache??[]).length,
        cached:(cache??[]).filter((x:Record<string,unknown>)=>x.cache_status==="cached"&&x.object_path).length,
        bytes:(cache??[]).reduce((sum:number,x:Record<string,unknown>)=>sum+Number(x.byte_size??0),0),
        sampleComplete:sample.filter((x)=>x.homeLogo&&x.awayLogo).length,
        sample,
        updatedAt:(cache??[]).map((x:Record<string,unknown>)=>String(x.fetched_at??"")).sort().at(-1)??null,
      });
    } catch(error) {
      console.error(error);
      return reply({ok:false,error:"TEAM_LOGO_HEALTH_ERROR"},500);
    }
  }
  if (requestUrl.searchParams.get("sync_upset") === "1") {
    try {
      const replayDate=requestUrl.searchParams.get("date");
      if(replayDate){
        if(!/^2026-09-(14|15|16|17|18|19|20)$/.test(replayDate))return reply({ok:false,error:"UPSET_REPLAY_DATE_OUT_OF_SCOPE"},400);
        const replayUrl="https://tqlibowvnwfkaseqqvvp.supabase.co/functions/v1/hao-model-hourly-executor-v01?upset_replay=1&date="+encodeURIComponent(replayDate);
        const response=await fetch(replayUrl,{headers:{accept:"application/json"},signal:AbortSignal.timeout(45_000)});
        if(!response.ok)throw new Error("REPLAY_UPSTREAM_"+response.status);
        const data=await response.json();
        if(data?.ok!==true||data?.replay!==true||data?.read_only!==true||data?.resultFieldsUsed!==false||data?.hurDirectionUsed!==false||data?.historyRewrite!==false||!Array.isArray(data?.rows))throw new Error("REPLAY_VALIDATION_FAILED");
        const result=await syncUpsetWarnings(data.rows,data);
        return reply({ok:true,sync:"upset-warning-history",date:data.date,count:data.count,published:data.published,high:data.high,medium:data.medium,directionPublished:data.directionPublished,resultFieldsUsed:data.resultFieldsUsed,hurDirectionUsed:data.hurDirectionUsed,historyRewrite:data.historyRewrite,...result});
      }
      const response=await fetch(upstream+"?public_hj38=1&view=today",{headers:{accept:"application/json"},signal:AbortSignal.timeout(10_000)});
      if(!response.ok)throw new Error("UPSTREAM_"+response.status);
      const data=await response.json();
      const expectedRevision=allowed.get(String(data?.modelVersion??""));
      if(data?.ok!==true||!expectedRevision||data?.revision!==expectedRevision||!Array.isArray(data?.rows))throw new Error("UPSTREAM_VALIDATION_FAILED");
      const result=await syncUpsetWarnings(data.rows,data);
      return reply({ok:true,sync:"upset-warning",date:data.date??null,modelVersion:data.modelVersion??null,revision:data.revision??null,upsetStats:data.upsetStats??null,...result});
    } catch(error) {
      console.error(error);
      return reply({ok:false,error:"UPSET_WARNING_SYNC_ERROR"},502);
    }
  }
  if (requestUrl.searchParams.get("health") === "upset-warning") {
    const {data,error}=await db.from("soren_upset_warnings_v1")
      .select("pool_date,match_no,risk_level,warning_direction,source_model_version,source_revision,warning_model_version,source_frozen_at,result_fields_used,hur_direction_used")
      .order("pool_date",{ascending:false}).order("match_no",{ascending:true}).limit(300);
    if(error)return reply({ok:false,error:"UPSET_WARNING_HEALTH_ERROR"},500);
    const rows=data??[];
    return reply({ok:true,health:"upset-warning",revision:"HJ38-UPSET-v1.0.0",count:rows.length,high:rows.filter(r=>r.risk_level==="高").length,medium:rows.filter(r=>r.risk_level==="中").length,directionPublished:rows.filter(r=>!!r.warning_direction).length,resultFieldsUsed:rows.some(r=>r.result_fields_used===true),hurDirectionUsed:rows.some(r=>r.hur_direction_used===true),latestFrozenAt:rows.map(r=>r.source_frozen_at).filter(Boolean).sort().at(-1)??null});
  }
  if (requestUrl.searchParams.get("health") === "results") {
    const resultDate=requestUrl.searchParams.get("date")??"";
    if(!/^\d{4}-\d{2}-\d{2}$/.test(resultDate))return reply({ok:false,error:"VALID_DATE_REQUIRED"},400);
    const resultMap=await loadVerifiedResults(resultDate);
    return reply({ok:true,health:"results",date:resultDate,count:resultMap.size,rows:[...resultMap.entries()].map(([matchNo,row])=>({matchNo,...row}))});
  }
  if (requestUrl.searchParams.get("health") === "handicap-backfill") {
    const { data, error } = await db.from("soren_handicap_backfill_v1")
      .select("pool_date,source_kind,handicap_top1,handicap_second,result_verified,top1_hit,coverage_hit")
      .gte("pool_date","2026-09-13").lte("pool_date","2026-09-19");
    if (error) return reply({ok:false,error:"HANDICAP_BACKFILL_HEALTH_ERROR"},500);
    const byDate: Record<string,Record<string,unknown>> = {};
    for (const row of data ?? []) {
      const day=String(row.pool_date), bucket=(byDate[day]??={total:0,filled:0,settled:0,original:0,replay:0});
      bucket.total=Number(bucket.total)+1;
      if(row.handicap_top1&&row.handicap_second)bucket.filled=Number(bucket.filled)+1;
      if(row.result_verified===true)bucket.settled=Number(bucket.settled)+1;
      if(row.source_kind==="ORIGINAL_PREMATCH")bucket.original=Number(bucket.original)+1;
      if(row.source_kind==="HISTORICAL_BLIND_REPLAY")bucket.replay=Number(bucket.replay)+1;
    }
    return reply({ok:true,health:"handicap-backfill",revision:"handicap-history-backfill-v1.0-20260920",count:(data??[]).length,byDate});
  }
  try {
    const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i,"").trim();
    if (!token) return reply({ok:false,error:"LOGIN_REQUIRED"},401);
    const auth = await fetch("https://ttydbcejxqxdkcfoizkj.supabase.co/auth/v1/user",{headers:{"apikey":Deno.env.get("SUPABASE_ANON_KEY")??"","Authorization":"Bearer "+token}});
    if (!auth.ok) return reply({ok:false,error:"LOGIN_REQUIRED"},401);
    const user = await auth.json();
    if (!user?.id) return reply({ok:false,error:"LOGIN_REQUIRED"},401);
    if(requestUrl.searchParams.get("view")==="report"){
      const date=requestUrl.searchParams.get("date")??"";
      const no=requestUrl.searchParams.get("no")??"";
      if(!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)||!/^[0-9]{3}$/.test(no))
        return reply({ok:false,error:"INVALID_REPORT_ID"},400);
      try{
        const report=await professionalReport(date,no);
        if(!report)return reply({ok:false,error:"REPORT_MATCH_NOT_FOUND"},404);
        return reply({ok:true,report,updatedAt:new Date().toISOString()});
      }catch(error){console.error("REPORT_ERROR",error);return reply({ok:false,error:"REPORT_UNAVAILABLE"},502);}
    }

    const url = requestUrl;
    const view = url.searchParams.get("view") ?? "today";
    const date = url.searchParams.get("date");
    if (!["today", "history", "archive"].includes(view)) return reply({ ok: false, error: "INVALID_VIEW" }, 400);
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return reply({ ok: false, error: "INVALID_DATE" }, 400);

    const archivedScores: Record<string, {home:string;away:string;h:number;a:number}> = {"2026-09-13|001":{"home":"东京绿茵","away":"千叶市原","h":1,"a":1},"2026-09-13|003":{"home":"塞尔塔","away":"马拉加","h":1,"a":1},"2026-09-13|004":{"home":"哈马比","away":"布鲁马波","h":3,"a":1},"2026-09-13|005":{"home":"库奥皮奥","away":"赫尔辛基","h":0,"a":0},"2026-09-13|006":{"home":"海伦芬","away":"特尔斯达","h":0,"a":0},"2026-09-13|007":{"home":"莱切","away":"蒙扎","h":3,"a":2},"2026-09-13|008":{"home":"里尔","away":"特鲁瓦","h":2,"a":0},"2026-09-13|009":{"home":"莱红牛","away":"汉堡","h":5,"a":0},"2026-09-13|010":{"home":"莱万特","away":"巴萨","h":2,"a":4},"2026-09-13|011":{"home":"汉坎","away":"莫尔德","h":1,"a":5},"2026-09-13|012":{"home":"勒芒","away":"朗斯","h":2,"a":2},"2026-09-13|013":{"home":"曼联","away":"曼城","h":0,"a":1},"2026-09-13|014":{"home":"埃沃斯堡","away":"拜仁","h":1,"a":2},"2026-09-13|015":{"home":"那不勒斯","away":"博洛尼亚","h":1,"a":0},"2026-09-13|016":{"home":"赫塔费","away":"拉科","h":1,"a":1},"2026-09-13|017":{"home":"本菲卡","away":"吉维森特","h":3,"a":1},"2026-09-13|018":{"home":"埃因霍温","away":"鹿斯巴达","h":4,"a":1},"2026-09-13|019":{"home":"萨索洛","away":"尤文图斯","h":3,"a":2},"2026-09-13|020":{"home":"布雷斯特","away":"巴黎圣曼","h":0,"a":1},"2026-09-13|021":{"home":"皇家社会","away":"马竞","h":0,"a":3},"2026-09-13|022":{"home":"法马利康","away":"里斯本","h":1,"a":1},"2026-09-13|023":{"home":"弗拉门戈","away":"科林蒂安","h":2,"a":1},"2026-09-13|024":{"home":"芝加哥","away":"新英格兰","h":1,"a":2},"2026-09-13|04":{"home":"莱切","away":"蒙扎","h":3,"a":2},"2026-09-13|05":{"home":"那不勒斯","away":"博洛尼亚","h":1,"a":0},"2026-09-13|06":{"home":"萨索洛","away":"尤文图斯","h":3,"a":2},"2026-09-13|07":{"home":"莱万特","away":"巴塞罗那","h":2,"a":4},"2026-09-13|08":{"home":"赫塔费","away":"拉科鲁尼亚","h":1,"a":1},"2026-09-13|10":{"home":"里尔","away":"特鲁瓦","h":2,"a":0},"2026-09-13|11":{"home":"勒芒","away":"朗斯","h":2,"a":2},"2026-09-13|13":{"home":"阿罗卡","away":"圣克拉拉","h":1,"a":2},"2026-09-14|001":{"home":"中国女","away":"中国香港女","h":2,"a":1},"2026-09-14|002":{"home":"国际图尔","away":"瓦萨","h":1,"a":0},"2026-09-14|003":{"home":"科莫","away":"帕尔马","h":2,"a":1},"2026-09-14|004":{"home":"都灵","away":"罗马","h":0,"a":2},"2026-09-14|005":{"home":"佐加顿斯","away":"盖斯","h":2,"a":0},"2026-09-14|006":{"home":"博德闪耀","away":"桑纳菲","h":3,"a":2},"2026-09-14|007":{"home":"吉达国民","away":"塔什干棉农","h":1,"a":1},"2026-09-14|008":{"home":"国际米兰","away":"乌迪内斯","h":5,"a":3},"2026-09-14|009":{"home":"圣旺红星","away":"梅斯","h":1,"a":0},"2026-09-14|010":{"home":"利兹联","away":"纽卡斯尔","h":4,"a":1},"2026-09-14|011":{"home":"比利亚雷","away":"贝蒂斯","h":1,"a":2},"2026-09-14|012":{"home":"布拉加","away":"埃斯托里","h":1,"a":0},"2026-09-14|013":{"home":"中国女","away":"中国香港女","h":2,"a":1},"2026-09-14|014":{"home":"中国女","away":"中国香港女","h":2,"a":1},"2026-09-14|04":{"home":"都灵","away":"罗马","h":0,"a":2},"2026-09-14|05":{"home":"科莫","away":"帕尔马","h":2,"a":1},"2026-09-14|06":{"home":"国际米兰","away":"乌迪内斯","h":5,"a":3},"2026-09-14|08":{"home":"圣旺红星","away":"梅斯","h":1,"a":0},"2026-09-14|09":{"home":"里奥阿维","away":"阿马多拉","h":3,"a":3},"2026-09-14|10":{"home":"摩雷伦斯","away":"马里迪莫","h":3,"a":1},"2026-09-14|11":{"home":"布拉加","away":"埃斯托里尔","h":1,"a":0},"2026-09-14|12":{"home":"佐加顿斯","away":"哥德堡盖斯","h":2,"a":0},"2026-09-14|13":{"home":"天狼星","away":"代格福什","h":2,"a":0},"2026-09-15|002":{"home":"大田市民","away":"京都","h":1,"a":0},"2026-09-15|004":{"home":"柔佛","away":"布里兰","h":1,"a":1},"2026-09-15|005":{"home":"北京国安","away":"浦项制铁","h":3,"a":1},"2026-09-15|006":{"home":"艾因","away":"利雅得胜利","h":4,"a":0},"2026-09-15|007":{"home":"巴列卡诺","away":"西班牙人","h":2,"a":1},"2026-09-15|008":{"home":"阿拉维斯","away":"巴伦西亚","h":0,"a":1},"2026-09-15|009":{"home":"阿贾克斯","away":"威廉二世","h":5,"a":1},"2026-09-15|01":{"home":"北京国安","away":"浦项制铁","h":3,"a":1},"2026-09-15|010":{"home":"米堡","away":"米尔沃尔","h":2,"a":2},"2026-09-15|011":{"home":"利物浦","away":"热刺","h":3,"a":1},"2026-09-15|012":{"home":"伊普斯维奇","away":"阿森纳","h":2,"a":4},"2026-09-15|013":{"home":"埃尔切","away":"皇马","h":2,"a":3},"2026-09-15|014":{"home":"普拉腾斯","away":"弗鲁米嫩","h":2,"a":1},"2026-09-15|03":{"home":"艾因","away":"利雅得胜利","h":4,"a":0},"2026-09-15|05":{"home":"布里斯托城","away":"林肯城","h":0,"a":1},"2026-09-15|06":{"home":"米德尔斯堡","away":"米尔沃尔","h":2,"a":2},"2026-09-15|07":{"home":"西汉姆联","away":"富勒姆","h":2,"a":3},"2026-09-15|08":{"home":"伊普斯维奇","away":"阿森纳","h":2,"a":4},"2026-09-15|10":{"home":"巴列卡诺","away":"西班牙人","h":2,"a":1},"2026-09-15|11":{"home":"阿拉维斯","away":"巴伦西亚","h":0,"a":1},"2026-09-15|13":{"home":"阿贾克斯","away":"威廉二世","h":5,"a":1},"2026-09-16|001":{"home":"中国U23","away":"朝鲜U23","h":2,"a":1},"2026-09-16|002":{"home":"全北现代","away":"柏太阳神","h":2,"a":1},"2026-09-16|003":{"home":"日本U23","away":"中国香港U23","h":2,"a":0},"2026-09-16|004":{"home":"奥莫尼亚","away":"塞尔塔","h":1,"a":0},"2026-09-16|005":{"home":"拉科","away":"塞维利亚","h":0,"a":1},"2026-09-16|006":{"home":"马竞","away":"奥萨苏纳","h":4,"a":0},"2026-09-16|007":{"home":"AC米兰","away":"本菲卡","h":0,"a":2},"2026-09-16|008":{"home":"勒沃库森","away":"采列","h":2,"a":0},"2026-09-16|009":{"home":"桑德兰","away":"阿尔克马","h":1,"a":0},"2026-09-16|010":{"home":"格拉茨","away":"雷恩","h":0,"a":0},"2026-09-16|011":{"home":"安德莱赫特","away":"里昂","h":1,"a":2},"2026-09-16|012":{"home":"考文垂","away":"维拉","h":1,"a":3},"2026-09-16|013":{"home":"巴萨","away":"桑坦德","h":7,"a":2},"2026-09-16|015":{"home":"基多体大","away":"帕梅拉斯","h":3,"a":2},"2026-09-16|016":{"home":"博塔弗戈","away":"格雷米奥","h":3,"a":2},"2026-09-16|017":{"home":"科林蒂安","away":"拉普大学","h":0,"a":1},"2026-09-16|02":{"home":"奥莫尼亚","away":"塞尔塔","h":1,"a":0},"2026-09-16|03":{"home":"AC米兰","away":"本菲卡","h":0,"a":2},"2026-09-16|04":{"home":"安德莱赫特","away":"里昂","h":1,"a":2},"2026-09-16|05":{"home":"勒沃库森","away":"采列","h":2,"a":0},"2026-09-16|09":{"home":"埃弗顿","away":"狼队","h":1,"a":0},"2026-09-16|10":{"home":"考文垂","away":"阿斯顿维拉","h":1,"a":3},"2026-09-16|12":{"home":"拉科鲁尼亚","away":"塞维利亚","h":0,"a":1},"2026-09-17|003":{"home":"克里特","away":"霍芬海姆","h":2,"a":0},"2026-09-17|004":{"home":"贝蒂斯","away":"赫塔费","h":1,"a":0},"2026-09-17|005":{"home":"水晶宫","away":"波兹南","h":4,"a":0},"2026-09-17|006":{"home":"皇家社会","away":"伯恩茅斯","h":1,"a":2},"2026-09-17|007":{"home":"尤文图斯","away":"奈梅亨","h":5,"a":0},"2026-09-17|008":{"home":"贝西克塔","away":"马赛","h":4,"a":1},"2026-09-17|009":{"home":"利勒斯特","away":"托林斯","h":1,"a":2},"2026-09-17|010":{"home":"马拉加","away":"比利亚雷","h":1,"a":3},"2026-09-17|011":{"home":"弗拉门戈","away":"德尔瓦耶","h":1,"a":1}};
    const outcomeCode=(h:number,a:number)=>h>a?"H":h<a?"A":"D";
    if (date && Object.prototype.hasOwnProperty.call(legacySnapshots,date)) {
      const originalFull = legacySnapshots[date].map((r: Record<string, unknown>) => {
        const match=archivedScores[String(r.date)+"|"+String(r.no).padStart(3,"0")];
        if (!match || String(r.home)!==match.home || String(r.away)!==match.away || r.resultVerified!==true || String(r.result)!==outcomeCode(match.h,match.a)) return r;
        const line=Number(r.officialHandicap); const handicapResult=Number.isInteger(line)?outcomeCode(match.h+line,match.a):null; const first=["让胜","让平","让负"].includes(String(r.handicap))?String(r.handicap):null; return {...r,resultHome:match.h,resultAway:match.a,resultScore:match.h+"-"+match.a,handicapResult:handicapResult?({H:"让胜",D:"让平",A:"让负"}[handicapResult]):null,handicapHit:first!==null&&first===({H:"让胜",D:"让平",A:"让负"}[handicapResult])};
      });
      // Independent, read-only enrichments must not block each other.
      const [handicapBackfill,goalPredictions,goalFormReferences,teamSchedules,teamFormH2h,historicalScores,upsetWarnings,teamLogos,dayEnvironment]=await Promise.all([
        loadHandicapBackfill(date),loadGoalPredictions(date),loadGoalFormReferences(date),
        loadTeamScheduleSnapshots(date),loadTeamFormH2hSnapshots(date),loadHistoricalScoreTop4(date),
        loadUpsetWarningMap(date),loadTeamLogoMap(),loadDayEnvironment(date),
      ]);
      const full = originalFull.map((r: Record<string,unknown>) => settlePublishedScoreTop4(attachDayEnvironment(attachTeamLogos(attachHistoricalScoreTop4(attachUpsetWarning(attachTeamFormH2h(attachTeamSchedule(attachGoalFormReference(attachGoalPrediction(applyHandicapBackfill(r,handicapBackfill),goalPredictions),goalFormReferences),teamSchedules),teamFormH2h),upsetWarnings),historicalScores),teamLogos),dayEnvironment)));
      const rows = view === "history" ? full.filter((r) => r.resultVerified) : full;
      const handicapStats = buildHandicapStats(rows);
      const version = date === "2026-09-13" ? "3.2" : "3.3";
      const revision = date === "2026-09-13" ? "3.2-native-pass-v0.1.1-20260913" : "3.3-best-play-selector-v1.0-20260914";
      return reply({ok:true,view,date,count:rows.length,model:"索伦引擎",modelVersion:version,revision,batchTime:null,dataTime:full.at(-1)?.frozenAt??null,pregameVerifiedCount:rows.length,handicapStats,upsetStats:upsetStatsFor(rows),updatedAt:new Date().toISOString(),rows});
    }
    const query = new URLSearchParams({ public_hj38: "1", view });
    if (date) query.set("date", date);
    const response = await fetch(upstream + "?" + query.toString(), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("UPSTREAM_" + response.status);
    const data = await response.json();
    const expectedRevision = allowed.get(String(data?.modelVersion ?? ""));
    if (
      data?.ok !== true ||
      !expectedRevision ||
      data?.revision !== expectedRevision ||
      !Array.isArray(data?.rows)
    ) throw new Error("UPSTREAM_VALIDATION_FAILED");

    const verifiedResults: Record<string, Record<string, { result: string; score: string; source: string }>> = {
      "2026-09-17": {
        "001": { result: "D", score: "1-1", source: "https://www.sportschau.de/live-und-ergebnisse/fussball/ma12416761/usbekistan_china/fifa-freundschaft-frauen/se105569/2026/ro330517/oktober/ma12416761/spiel-spiele-und-ergebnisse" },
        "002": { result: "H", score: "2-1", source: "https://www.the-afc.com/en/club/afc_champions_league_two.html/news/group-g-shanghai-shenhua-fc-chn-2-1-tampines-rovers-fc-sgp" }
      }
    };
    const databaseResults=await loadVerifiedResults(String(data.date ?? date ?? ""));
    const sourceRows = data.rows.filter((row: Record<string, unknown>) =>
      row?.version === data.modelVersion && row?.pregameVerified === true && row?.frozenAt
    ).map((row: Record<string, unknown>) => {
      const day = String(row.date ?? data.date ?? "");
      const no = String(row.no ?? "").padStart(3, "0");
      const stored=databaseResults.get(no);
      if(stored){
        const pick=(v:unknown)=>({"主胜":"H","平":"D","客胜":"A","3":"H","1":"D","0":"A",H:"H",D:"D",A:"A"}[String(v??"")]??null);
        const actual=String(stored.ft_result??"");
        const primary=pick(row.ftTop1),secondary=pick(row.second);
        const handicapActual=handicapName[String(stored.handicap_result??"")]??null;
        const handicapPick=String(row.handicapTop1??row.handicap??"");
        return {...row,resultVerified:true,result:actual,resultHome:Number(stored.home_score),resultAway:Number(stored.away_score),resultScore:String(stored.home_score)+"-"+String(stored.away_score),resultSource:stored.result_source??"客户库已核验赛果",resultVerifiedAt:stored.verified_at??null,top1Hit:primary===actual,coverageHit:primary===actual||secondary===actual,handicapResult:handicapActual,handicapHit:handicapActual!==null&&handicapPick===handicapActual};
      }
      if (day === "2026-09-16" && no === "014") {
        return { ...row, resultVerified: false, result: null, matchStatus: "POSTPONED", resultStatus: "比赛延期", resultSource: "https://www.athletic-club.eus/en/news/2026/09/16/the-match-between-levante-ud-and-athletic-club-on-matchday-6-of-laliga-has-been-postponed/" };
      }
      const verified = verifiedResults[day]?.[no];
      if (!verified || row.resultVerified === true) return row;
      const pick = (v: unknown) => ({ "主胜": "H", "平": "D", "客胜": "A", "3": "H", "1": "D", "0": "A", H: "H", D: "D", A: "A" }[String(v ?? "")] ?? null);
      return { ...row, resultVerified: true, result: verified.result, resultScore: verified.score, resultSource: verified.source, top1Hit: pick(row.ftTop1) === verified.result, coverageHit: pick(row.ftTop1) === verified.result || pick(row.second) === verified.result };
    });
    const dynamicDate = String(data.date ?? date ?? "");
    const [handicapBackfill,goalPredictions,goalFormReferences,teamSchedules,teamFormH2h,historicalScores,upsetWarnings,teamLogos,dayEnvironment]=await Promise.all([
      loadHandicapBackfill(dynamicDate),loadGoalPredictions(dynamicDate),loadGoalFormReferences(dynamicDate),
      loadTeamScheduleSnapshots(dynamicDate),loadTeamFormH2hSnapshots(dynamicDate),loadHistoricalScoreTop4(dynamicDate),
      loadUpsetWarningMap(dynamicDate),loadTeamLogoMap(),loadDayEnvironment(dynamicDate),
    ]);
    const rows = await applySaleFreeze(sourceRows.map((row: Record<string,unknown>) => settlePublishedScoreTop4(attachDayEnvironment(attachTeamLogos(attachHistoricalScoreTop4(attachUpsetWarning(attachTeamFormH2h(attachTeamSchedule(attachGoalFormReference(attachGoalPrediction(applyHandicapBackfill(row,handicapBackfill),goalPredictions),goalFormReferences),teamSchedules),teamFormH2h),upsetWarnings),historicalScores),teamLogos),dayEnvironment))),dynamicDate);
    const handicapStats = buildHandicapStats(rows);
    const warningSync=await syncUpsetWarnings(rows,data);
    return reply({
      ok: true,
      view,
      date: data.date ?? null,
      count: rows.length,
      model: "索伦引擎",
      modelVersion: data.modelVersion,
      revision: data.revision,
      batchTime: data.batchTime ?? null,
      dataTime: data.dataTime ?? null,
      pregameVerifiedCount: rows.length,
      handicapStats,
      upsetStats: upsetStatsFor(rows),
      warningSync,
      updatedAt: new Date().toISOString(),
      rows,
    });
  } catch (error) {
    console.error(error);
    return reply({ ok: false, error: "PUBLIC_API_UPSTREAM_ERROR", rows: [] }, 502);
  }
});
