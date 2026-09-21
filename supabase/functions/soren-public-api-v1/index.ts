import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const handicapName: Record<string,string> = { HWIN: "让胜", HDRAW: "让平", HLOSS: "让负" };
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
      const handicapBackfill = await loadHandicapBackfill(date);
      const goalPredictions=await loadGoalPredictions(date);
      const historicalScores=await loadHistoricalScoreTop4(date);
      const upsetWarnings=await loadUpsetWarningMap(date);
      const teamLogos=await loadTeamLogoMap();
      const full = originalFull.map((r: Record<string,unknown>) => attachTeamLogos(attachHistoricalScoreTop4(attachUpsetWarning(attachGoalPrediction(applyHandicapBackfill(r,handicapBackfill),goalPredictions),upsetWarnings),historicalScores),teamLogos));
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
    const handicapBackfill = await loadHandicapBackfill(dynamicDate);
    const goalPredictions=await loadGoalPredictions(dynamicDate);
    const historicalScores=await loadHistoricalScoreTop4(dynamicDate);
    const upsetWarnings=await loadUpsetWarningMap(dynamicDate);
    const teamLogos=await loadTeamLogoMap();
    const rows = sourceRows.map((row: Record<string,unknown>) => attachTeamLogos(attachHistoricalScoreTop4(attachUpsetWarning(attachGoalPrediction(applyHandicapBackfill(row,handicapBackfill),goalPredictions),upsetWarnings),historicalScores),teamLogos));
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
