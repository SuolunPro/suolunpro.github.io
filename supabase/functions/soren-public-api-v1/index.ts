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
async function applySaleFreeze(rows:Record<string,unknown>[],date:string,readOnly=false):Promise<Record<string,unknown>[]> {
  if(date<"2026-09-23")return rows; // historic data predating deployment: do not relabel as sale-verified.
  let data:Record<string,unknown>[]=[];
  if(readOnly){
    // Historical navigation must never create/refresh freezes. Reuse the already locked customer snapshot.
    const {data:stored,error:storedError}=await db.from("soren_sale_freezes_v1")
      .select("match_no,snapshot,source_frozen_at,captured_at,locked_at,lock_reason,cutoff_at")
      .eq("pool_date",date).order("match_no",{ascending:true});
    if(storedError)throw new Error("SALE_FREEZE_READ_UNAVAILABLE:"+String(storedError.message));
    data=(stored??[]).map((s:Record<string,unknown>)=>({
      no:String(s.match_no??"").padStart(3,"0"),
      status:s.locked_at?String(s.lock_reason??"LOCKED"):(s.cutoff_at?"PRE_SALE_REFRESHABLE":"EARLY_LOCK_CUTOFF_UNVERIFIED"),
      snapshot:s.snapshot??null,
      sourceFrozenAt:s.source_frozen_at??null,
      capturedAt:s.captured_at??null,
      lockedAt:s.locked_at??null,
      cutoffAt:s.cutoff_at??null,
    }));
  }else{
    const captured=await db.rpc("soren_capture_sale_snapshots_v1",{p_date:date,p_rows:rows});
    if(captured.error||!Array.isArray(captured.data))throw new Error("SALE_FREEZE_UNAVAILABLE:"+String(captured.error?.message??"INVALID_RESPONSE"));
    data=captured.data as Record<string,unknown>[];
    // Save immutable, time-verified model versions before each fixture's kickoff/cutoff.
    const {error:captureError}=await db.rpc("soren_capture_prematch_updates_v1",{p_date:date,p_rows:rows});
    if(captureError)throw new Error("PREMATCH_CAPTURE_UNAVAILABLE:"+String(captureError.message));
  }
  const {data:updates,error:updatesError}=await db.from("soren_prematch_updates_v1")
    .select("match_no,source_frozen_at,captured_at,snapshot").eq("pool_date",date)
    .order("source_frozen_at",{ascending:false}).limit(2500);
  if(updatesError)throw new Error("PREMATCH_ARCHIVE_UNAVAILABLE:"+String(updatesError.message));
  const latestByNo=new Map<string,Record<string,unknown>>();
  for(const entry of updates??[]){
    const key=String(entry.match_no??"").padStart(3,"0");
    if(!latestByNo.has(key))latestByNo.set(key,entry as Record<string,unknown>);
  }
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
      // Serve exactly one latest VERIFIED pre-kickoff snapshot; historical
      // official sale-time records in soren_sale_freezes_v1 remain untouched.
      const stored=latestByNo.get(String(row.no??"").padStart(3,"0"));
      const candidate=stored?.snapshot as Record<string,unknown>|undefined;
      const sourceAt=Date.parse(String(stored?.source_frozen_at??""));
      const capturedAt=Date.parse(String(stored?.captured_at??""));
      const kick=Date.parse(String(original.kickoff??""));
      const originalAt=Date.parse(String(original.frozenAt??""));
      const candidateKick=Date.parse(String(candidate?.kickoff??""));
      if(candidate&&candidate.pregameVerified===true&&
         Number.isFinite(sourceAt)&&Number.isFinite(capturedAt)&&Number.isFinite(kick)&&
         Number.isFinite(originalAt)&&Number.isFinite(candidateKick)&&
         sourceAt>originalAt&&sourceAt<kick&&capturedAt<kick&&
         Math.abs(kick-candidateKick)<120000&&
         String(candidate.home??"")===String(original.home??"")&&
         String(candidate.away??"")===String(original.away??"")&&
         String(candidate.date??"")===String(original.date??"")&&
         [candidate.homeProbability,candidate.drawProbability,candidate.awayProbability]
           .every(v=>v!==null&&v!==undefined&&Number.isFinite(Number(v))&&Number(v)>=0&&Number(v)<=100)){
        const newest:Record<string,unknown>={...candidate};
        for(const key of mutable)if(Object.prototype.hasOwnProperty.call(row,key))newest[key]=row[key];
        if(newest.resultVerified===true){
          const actual=pick(newest.result);
          const first=pick(candidate.ftTop1),second=pick(candidate.second);
          newest.top1Hit=actual!==null&&first===actual;
          newest.coverageHit=actual!==null&&(first===actual||second===actual);
          const hp=String(candidate.handicapTop1??candidate.handicap??"");
          newest.handicapHit=["让胜","让平","让负"].includes(String(newest.handicapResult??""))
            ?hp===String(newest.handicapResult):null;
        }else{newest.top1Hit=null;newest.coverageHit=null;newest.handicapHit=null;}
        newest.predictionView="LATEST_PREMATCH_ONLY";
        newest.prematchLastCapturedAt=stored?.captured_at??null;
        newest.originalFormalFrozenAt=original.frozenAt;
        newest.saleFreezeStatus=freeze?.status??"UNKNOWN";
        newest.saleFreezeCapturedAt=freeze?.capturedAt??null;
        newest.saleFreezeLockedAt=freeze?.lockedAt??null;
        newest.saleCutoffAt=freeze?.cutoffAt??null;
        return settlePublishedScoreTop4(newest);
      }
      return settlePublishedScoreTop4(output);
    }
    // Show an unpublished placeholder while the fixture is still upcoming; do not
    // lock an empty/pending prediction or remove tomorrow's match from the day list.
    if(Number.isFinite(Date.parse(String(row.kickoff??""))) &&
       Date.now()<Date.parse(String(row.kickoff)) &&
       !row.ftTop1 && freeze?.status==="CUTOFF_UNVERIFIED_NO_EARLY_SNAPSHOT")
      return {...row,saleFreezeStatus:"PENDING_VALID_PUBLICATION",saleCutoffAt:null};
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


/* Independent, immutable, pre-kickoff market-anchored Poisson reference.
   Never overwrite formal scoreTop4, goalPrediction or the sale freeze. */
function attachLiveScoreGoalsFromRecords(rows:Record<string,unknown>[],records:Record<string,unknown>[]):Record<string,unknown>[]{
 const newest=new Map<string,Record<string,unknown>>();
 for(const x of records??[]){
   const key=String(x.match_no??"").padStart(3,"0");
   if(!newest.has(key))newest.set(key,x as Record<string,unknown>);
 }
 return rows.map(row=>{
   if(row.pregameVerified!==true)return row;
   const x=newest.get(String(row.no??"").padStart(3,"0"));
   if(!x)return row;
   const kickoff=Date.parse(String(row.kickoff??""));
   const calc=Date.parse(String(x.computed_at??""));
   const source=Date.parse(String(x.market_at??""));
   const base=Date.parse(String(x.base_frozen_at??""));
   const lh=Number(x.lambda_home),la=Number(x.lambda_away);
   const scores=x.scores;
   if(!Number.isFinite(kickoff)||!Number.isFinite(calc)||!Number.isFinite(source)||
      !Number.isFinite(base)||calc>=kickoff||source>calc||source<base||
      !Number.isFinite(lh)||!Number.isFinite(la)||lh<0.2||la<0.2||
      lh>3.8||la>3.8||!Array.isArray(scores)||scores.length!==4||
      scores.some(p=>!p||!String(p.score??"").split("-").every(v=>v!==""&&Number.isInteger(Number(v))&&Number(v)>=0&&Number(v)<=8)||
        !Number.isFinite(Number(p.baseProbability))||
        Number(p.baseProbability)<0||Number(p.baseProbability)>1))return row;
   // These two references use one source record, so their lambdas and version timestamps match.
   const actual=row.resultVerified===true&&Number.isInteger(Number(row.resultHome))&&
     Number.isInteger(Number(row.resultAway))?
       String(row.resultHome)+"-"+String(row.resultAway):null;
   const referenceHit=actual!==null&&scores.some(p=>String(p.score)===actual);
   const dynamicScoreTop4={
     pregameVerified:true,formalEligible:false,
     sourceKind:"MARKET_ANCHORED_POISSON_SHADOW_V01",
     sourceLiveScoreId:x.id,
     frozenAt:x.computed_at,marketAt:x.market_at,
     baselineAt:x.base_frozen_at,lambdaHome:lh,lambdaAway:la,
     picks:scores,settlementStatus:actual===null?"PENDING":referenceHit?"SUCCESS":"FAILURE",
     hitScore:referenceHit?actual:null,inputManifest:x.input_manifest
   };
   const dynamicGoalPrediction={
     pregameVerified:true,formalEligible:false,
     sourceKind:"MARKET_ANCHORED_POISSON_SHADOW_V01",
     sourceLiveScoreId:x.id,
     frozenAt:x.computed_at,marketAt:x.market_at,
     lambdaHome:lh,lambdaAway:la,
     source:"原冻结进球参数与威廉希尔欧赔条件胜率校准的赛前动态研究参考；尚未通过历史验证"
   };
   return {...row,dynamicScoreTop4,dynamicGoalPrediction};
 });
}

async function attachLiveScoreGoals(rows:Record<string,unknown>[],date:string):Promise<Record<string,unknown>[]>{
 if(date<"2026-09-25")return rows;
 const {data,error}=await db.from("soren_live_score_goals_v1")
   .select("id,match_no,market_at,base_frozen_at,computed_at,lambda_home,lambda_away,scores,input_manifest")
   .eq("pool_date",date).order("computed_at",{ascending:false}).limit(1200);
 if(error){console.error("LIVE_SCORE_GOALS_UNAVAILABLE",error);return rows;}
 return attachLiveScoreGoalsFromRecords(rows,(data??[]) as Record<string,unknown>[]);
}

/* Match half/full-time reference to the exact same immutable Poisson+score
   version. Avoid mixing an older HTFT forecast with a newer score distribution. */
function attachLiveHTFTFromRecords(rows:Record<string,unknown>[],records:Record<string,unknown>[],verifiedResults:Map<string,Record<string,unknown>>):Record<string,unknown>[]{
 const byScoreId=new Map<string,Record<string,unknown>>();
 for(const item of records??[])byScoreId.set(String(item.source_live_score_id),item as Record<string,unknown>);
 return rows.map(row=>{
   const score=row.dynamicScoreTop4 as Record<string,unknown>|undefined;
   if(!score||row.pregameVerified!==true)return row;
   const matching=byScoreId.get(String(score.sourceLiveScoreId??""));
   const kickoff=Date.parse(String(row.kickoff??""));
   if(!matching||String(matching.match_no??"").padStart(3,"0")!==String(row.no??"").padStart(3,"0"))
     // Never generate an unrecorded dynamic forecast after kickoff: show the
     // original genuine prematch publication, rather than a permanent loading state.
     return Date.now()>=kickoff?row:{...row,dynamicHTFTPending:true};
   const source=Date.parse(String(matching.source_frozen_at??""));
   const calc=Date.parse(String(matching.computed_at??""));
   const scoreAt=Date.parse(String(score.frozenAt??""));
   const lh=Number(matching.lambda_home),la=Number(matching.lambda_away);
   const picks=matching.picks;
   if(!Number.isFinite(kickoff)||!Number.isFinite(source)||!Number.isFinite(calc)||
     source>=kickoff||calc>=kickoff||source!==scoreAt||source>calc||
     !Number.isFinite(lh)||!Number.isFinite(la)||
     Math.abs(lh-Number(score.lambdaHome))>0.000001||
     Math.abs(la-Number(score.lambdaAway))>0.000001||
     !Array.isArray(picks)||picks.length!==4||picks.some(x=>!x||
       !["胜胜","胜平","胜负","平胜","平平","平负","负胜","负平","负负"].includes(String(x.direction))||
       !Number.isFinite(Number(x.probability))||Number(x.probability)<0||Number(x.probability)>1))
     return {...row,dynamicHTFTPending:true};
   // Result data are read independently and ONLY after the four prematch picks passed
   // their timestamp, provenance and probability checks above. Never rewrite any pick.
   const verified=verifiedResults.get(String(row.no??"").padStart(3,"0"));
   let actual:string|null=null,halfScore:string|null=null;
   let settlementStatus="PENDING";
   if(row.resultVerified===true&&verified?.verified===true&&
      verified.home_score!==null&&verified.away_score!==null){
     settlementStatus="PENDING_HALFTIME_VERIFICATION";
     const raw=(verified.raw_result as Record<string,unknown>|null)?.score_text;
     const score=String(raw??"").match(/^\s*(\d+)\s*[:：-]\s*(\d+)\s*\(\s*(\d+)\s*[:：-]\s*(\d+)\s*\)\s*$/);
     if(score){
       const [,fh,fa,hh,ha]=score.map(Number);
       if(fh===Number(verified.home_score)&&fa===Number(verified.away_score)&&
          hh>=0&&ha>=0&&hh<=fh&&ha<=fa){
         const dir=(h:number,a:number)=>h>a?"胜":h===a?"平":"负";
         actual=dir(hh,ha)+dir(fh,fa);halfScore=hh+":"+ha;
         settlementStatus=picks.some((x:Record<string,unknown>)=>String(x.direction)===actual)?"SUCCESS":"FAILURE";
       }
     }
   }
   return {...row,dynamicHTFT:{
     sourceKind:"MARKET_ANCHORED_POISSON_HTFT_SHADOW_V01",formalEligible:false,
     methodVersion:matching.method_version,
     sourceLiveScoreId:matching.source_live_score_id,
     sourceFrozenAt:matching.source_frozen_at,
     publishedAt:matching.computed_at,
     picks,top4Probability:matching.top4_probability,
     htDrawProbability:matching.ht_draw_probability,
     lowGoalDrawAudit:matching.low_goal_draw_audit===true,
     settlementStatus,actual,halfScore,
     lambdaHome:lh,lambdaAway:la
   }};
 });
}

async function attachLiveHTFT(rows:Record<string,unknown>[],date:string,verifiedResults:Map<string,Record<string,unknown>>):Promise<Record<string,unknown>[]>{
 if(date<"2026-09-25")return rows;
 const {data,error}=await db.from("soren_live_htft_v1")
   .select("match_no,source_live_score_id,source_frozen_at,computed_at,lambda_home,lambda_away,picks,top4_probability,ht_draw_probability,low_goal_draw_audit,method_version")
   .eq("pool_date",date).order("source_frozen_at",{ascending:false}).limit(1200);
 if(error){console.error("LIVE_HTFT_UNAVAILABLE",error);return rows;}
 return attachLiveHTFTFromRecords(rows,(data??[]) as Record<string,unknown>[],verifiedResults);
}
/* Immutable pre-kickoff half-time/full-time Top4, published from the existing
   customer-side sale freeze. Independent of later model refresh and results. */
async function loadPublishedHTFTTop4(date:string){
  const {data,error}=await db.from("soren_htft_top4_v1")
    .select("match_id,pool_date,match_no,home_team,away_team,kickoff_at,source_frozen_at,published_at,picks,top4_probability,ht_draw_probability,low_goal_draw_audit,method_version")
    .eq("pool_date",date);
  if(error)throw error;
  return new Map((data??[]).map((v:Record<string,unknown>)=>[String(v.match_no??"").padStart(3,"0"),v]));
}
function attachPublishedHTFTTop4(row:Record<string,unknown>,
  published:Map<string,Record<string,unknown>>,verifiedResults:Map<string,Record<string,unknown>>):Record<string,unknown>{
  const no=String(row.no??"").padStart(3,"0");
  const p=published.get(no);
  if(!p)return {...row,htftTop4:null};
  const kickoff=Date.parse(String(row.kickoff??""));
  const originalKickoff=Date.parse(String(p.kickoff_at??""));
  const source=Date.parse(String(p.source_frozen_at??""));
  const publication=Date.parse(String(p.published_at??""));
  const picks=p.picks;
  if(String(p.home_team)!==String(row.home)||String(p.away_team)!==String(row.away)
    ||!Number.isFinite(kickoff)||!Number.isFinite(originalKickoff)||Math.abs(kickoff-originalKickoff)>60000
    ||!Number.isFinite(source)||!Number.isFinite(publication)||source>publication||publication>=kickoff
    ||!Array.isArray(picks)||picks.length!==4)return {...row,htftTop4:null};
  const verified=verifiedResults.get(no);
  let result:string|null=null;
  let halfScore:string|null=null;
  let settlementStatus="PENDING";
  if(verified && row.resultVerified===true && verified.home_score!==null && verified.away_score!==null){
    const raw=(verified.raw_result as Record<string,unknown>|null)?.score_text;
    const match=String(raw??"").match(/^\s*(\d+)\s*[:：-]\s*(\d+)\s*\(\s*(\d+)\s*[:：-]\s*(\d+)\s*\)\s*$/);
    if(match){
      const [,fh,fa,hh,ha]=match.map(Number);
      if(fh===Number(verified.home_score)&&fa===Number(verified.away_score)
        &&hh<=fh&&ha<=fa&&hh>=0&&ha>=0){
        const direction=(h:number,a:number)=>h>a?"胜":h===a?"平":"负";
        result=direction(hh,ha)+direction(fh,fa);
        halfScore=hh+":"+ha;
        settlementStatus=picks.some((item:Record<string,unknown>)=>String(item.direction)===result)?"SUCCESS":"FAILURE";
      }else settlementStatus="PENDING_HALFTIME_VERIFICATION";
    }else settlementStatus="PENDING_HALFTIME_VERIFICATION";
  }
  return {...row,htftTop4:{
    sourceKind:"PUBLISHED_PREMATCH",methodVersion:p.method_version,sourceFrozenAt:p.source_frozen_at,
    publishedAt:p.published_at,picks,top4Probability:p.top4_probability,
    htDrawProbability:p.ht_draw_probability,lowGoalDrawAudit:p.low_goal_draw_audit===true,
    settlementStatus,actual:result,halfScore
  }};
}


/* Post-kickoff reconstruction is a separate collection and NEVER a published
   prematch record or an input to the formal Top4 performance metrics. */
async function loadHistoricalHTFTTop4(date:string){
  if(date<"2026-09-19")return new Map<string,Record<string,unknown>>();
  const {data,error}=await db.from("soren_htft_top4_history_v1")
    .select("match_id,pool_date,match_no,home_team,away_team,kickoff_at,source_frozen_at,reconstructed_at,original_source_kind,original_replay_at,picks,top4_probability,ht_draw_probability,low_goal_draw_audit,method_version")
    .eq("pool_date",date);
  if(error)throw error;
  return new Map((data??[]).map((v:Record<string,unknown>)=>[String(v.match_no??"").padStart(3,"0"),v]));
}
function attachHistoricalHTFTTop4(row:Record<string,unknown>,
  historical:Map<string,Record<string,unknown>>,verifiedResults:Map<string,Record<string,unknown>>):Record<string,unknown>{
  if(row.htftTop4&&typeof row.htftTop4==="object")return row;
  const no=String(row.no??"").padStart(3,"0");
  const p=historical.get(no);
  if(!p)return row;
  const kickoff=Date.parse(String(row.kickoff??""));
  const sourceKickoff=Date.parse(String(p.kickoff_at??""));
  const frozen=Date.parse(String(p.source_frozen_at??""));
  const computed=Date.parse(String(p.reconstructed_at??""));
  if(String(p.home_team)!==String(row.home)||String(p.away_team)!==String(row.away)
    ||!Number.isFinite(kickoff)||!Number.isFinite(sourceKickoff)||Math.abs(kickoff-sourceKickoff)>60000
    ||!Number.isFinite(frozen)||!Number.isFinite(computed)||frozen>=kickoff||computed<kickoff
    ||!Array.isArray(p.picks)||p.picks.length!==4)return {...row,htftTop4:null};
  const verified=verifiedResults.get(no);
  let actual:string|null=null,halfScore:string|null=null,settlementStatus="PENDING";
  if(verified?.verified===true && String(verified.home_team)===String(row.home)
     &&String(verified.away_team)===String(row.away)
     &&verified.home_score!==null&&verified.away_score!==null){
    const match=String((verified.raw_result as Record<string,unknown>|null)?.score_text??"")
      .match(/^\s*(\d+)\s*[:：-]\s*(\d+)\s*\(\s*(\d+)\s*[:：-]\s*(\d+)\s*\)\s*$/);
    if(match){
      const [,fh,fa,hh,ha]=match.map(Number);
      if(fh===Number(verified.home_score)&&fa===Number(verified.away_score)&&hh<=fh&&ha<=fa){
        const dir=(h:number,a:number)=>h>a?"胜":h===a?"平":"负";
        actual=dir(hh,ha)+dir(fh,fa);halfScore=hh+":"+ha;
        settlementStatus=(p.picks as Record<string,unknown>[]).some(x=>String(x.direction)===actual)?"SUCCESS":"FAILURE";
      }else settlementStatus="PENDING_HALFTIME_VERIFICATION";
    }else settlementStatus="PENDING_HALFTIME_VERIFICATION";
  }
  return {...row,htftTop4:{
    sourceKind:"HISTORICAL_POSTMATCH_RECONSTRUCTION",originalSourceKind:p.original_source_kind,
    sourceFrozenAt:p.source_frozen_at,reconstructedAt:p.reconstructed_at,
    methodVersion:p.method_version,picks:p.picks,top4Probability:p.top4_probability,
    htDrawProbability:p.ht_draw_probability,lowGoalDrawAudit:p.low_goal_draw_audit===true,
    settlementStatus,actual,halfScore
  }};
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
  const {data:results,error:re}=await db.from("soren_results").select("match_id,home_score,away_score,ft_result,handicap_result,result_source,verified,verified_at,raw_result").in("match_id",ids).eq("verified",true);
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
 return {...row,scoreTop4:{pregameVerified:true,frozenAt:item.source_frozen_at,picks,sourceKind:"HISTORICAL_BLIND_REPLAY",sourceLabel:"历史盲跑重建 · 九十刻度比分规则",settlementStatus:actual===null?"PENDING":hit?"SUCCESS":"FAILURE",hitScore:hit?actual:null}};
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

/* A display-only reference from the SAME already-frozen score model inputs.
   No new prediction, post-result inference, mutation of sale freezes or xG classification. */
function attachScoreGoalReference(row:Record<string,unknown>):Record<string,unknown> {
  if(row.pregameVerified===false || row.goalPrediction!==null && row.goalPrediction!==undefined)return row;
  const score=row.scoreTop4 as Record<string,unknown>|null|undefined;
  if(!score || score.pregameVerified!==true || !Array.isArray(score.picks) || score.picks.length!==4)return row;
  const frozenAt=String(score.frozenAt??"");
  const frozen=Date.parse(frozenAt),kickoff=Date.parse(String(row.kickoff??""));
  if(!Number.isFinite(frozen)||!Number.isFinite(kickoff)||frozen>=kickoff)return row;
  if(score.lambdaHome===null||score.lambdaHome===undefined||score.lambdaAway===null||score.lambdaAway===undefined)return row;
  const home=Number(score.lambdaHome),away=Number(score.lambdaAway);
  if(!Number.isFinite(home)||!Number.isFinite(away)||home<=0||away<=0||home+away>15)return row;
  return {...row,goalPrediction:{
    pregameVerified:true,frozenAt,lambdaHome:home,lambdaAway:away,
    formalEligible:false,sourceKind:"SCORE_TOP4_FROZEN_LAMBDA_REFERENCE",
    source:"同场赛前冻结比分模型泊松参数（非严格xG）"
  }};
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
function settleTop5Handicap(row:Record<string,unknown>):Record<string,unknown>{
  if(!String(row.handicapModelVersion??'').startsWith('HJ38-HHAD-TOP5-FT-MKT'))return row;
  const actual=String(row.handicapResult??'');
  const known=['让胜','让平','让负'].includes(actual);
  if(row.resultVerified!==true||!known)return {...row,handicapTop1Hit:null,handicapCoverageHit:null,handicapHit:null};
  const first=String(row.handicapTop1??row.handicap??'');
  const second=String(row.handicapSecond??'');
  return {...row,handicapTop1Hit:first===actual,handicapCoverageHit:first===actual||second===actual,handicapHit:first===actual||second===actual};
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
  "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-soren-device",
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

async function fetchPublicUpstream(view:string,date:string|null){
  const query=new URLSearchParams({public_hj38:"1",view});
  if(date)query.set("date",date);
  const response=await fetch(upstream+"?"+query.toString(),{
    headers:{accept:"application/json"},
    signal:AbortSignal.timeout(10_000),
  });
  if(!response.ok)throw new Error("UPSTREAM_"+response.status);
  const data=await response.json();
  const expectedRevision=allowed.get(String(data?.modelVersion??""));
  if(data?.ok!==true||!expectedRevision||data?.revision!==expectedRevision||!Array.isArray(data?.rows))
    throw new Error("UPSTREAM_VALIDATION_FAILED");
  return data;
}

async function archiveDayFullySettled(date:string):Promise<boolean>{
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return false;
  const {data:matches,error:matchError}=await db.from("soren_matches")
    .select("id").eq("pool_date",date).limit(200);
  if(matchError||!Array.isArray(matches)||matches.length===0)return false;
  const ids=matches.map((m:Record<string,unknown>)=>Number(m.id)).filter(Number.isFinite);
  if(ids.length!==matches.length)return false;
  const {data:results,error:resultError}=await db.from("soren_results")
    .select("match_id").in("match_id",ids).eq("verified",true);
  if(resultError||!Array.isArray(results))return false;
  const settled=new Set(results.map((r:Record<string,unknown>)=>Number(r.match_id)).filter(Number.isFinite));
  return settled.size===ids.length;
}

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
      warning_model_version: String(w.modelVersion ?? w.model_version ?? "HJ38-UPSET-v1.1.0"),
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
    .eq("pool_date",date).order("match_no",{ascending:true}).order("source_frozen_at",{ascending:true});
  if(error)throw error;
  const map=new Map<string,Record<string,unknown>>();
  for(const w of data??[]){
    const row=w as Record<string,unknown>,no=String(row.match_no??"").padStart(3,"0");
    map.set(warningKey(row.match_no,row.source_frozen_at),row);
    map.set("LATEST|"+no,row);
  }
  return map;
}
function publicWarning(w:Record<string,unknown>){
  const p=(w.source_payload&&typeof w.source_payload==="object"?w.source_payload:{}) as Record<string,unknown>;
  const risk=String(w.risk_level??"未确认");
  const explicitPublish=typeof p.publish==="boolean"?p.publish:null;
  return {
    status:String(p.status??"ACTIVE"),
    publish:explicitPublish??(risk==="中"||risk==="高"),
    riskLevel:risk,
    riskScore:Number(w.risk_score??0),
    displayTier:p.display_tier??p.displayTier??(risk==="高"?"强风险信号":risk==="中"?"重点风险":"一般风险"),
    detailOnly:p.detail_only===true||p.detailOnly===true,
    publicationEligible:
      typeof p.publication_eligible==="boolean"?p.publication_eligible:
      typeof p.publicationEligible==="boolean"?p.publicationEligible:null,
    publicationReason:p.publication_reason??p.publicationReason??null,
    formalPredictionAt:p.formal_prediction_at??p.formalPredictionAt??null,
    formalPredictionDq:p.formal_prediction_dq??p.formalPredictionDq??null,
    focusGate:(p.focus_gate&&typeof p.focus_gate==="object")?p.focus_gate:(p.focusGate&&typeof p.focusGate==="object"?p.focusGate:null),
    marketSignals:Array.isArray(p.market_signals)?p.market_signals:(Array.isArray(p.marketSignals)?p.marketSignals:[]),
    independentDrawProbability:Number.isFinite(Number(p.independent_draw_probability??p.independentDrawProbability))?Number(p.independent_draw_probability??p.independentDrawProbability):null,
    originalTop1:w.original_top1??null,
    warningDirection:w.warning_direction??null,
    alternativePick:w.alternative_pick??null,
    riskBasis:Array.isArray(w.risk_basis)?w.risk_basis:[],
    directionBasis:Array.isArray(w.direction_basis)?w.direction_basis:[],
    evidenceDomains:Array.isArray(w.evidence_domains)?w.evidence_domains:[],
    directionalDomainCount:Number(w.directional_domain_count??0),
    modelVersion:w.warning_model_version??null,
    sourceModelVersion:w.source_model_version??null,
    sourceRevision:w.source_revision??null,
    prematchAt:w.source_frozen_at??null,
    resultFieldsUsed:w.result_fields_used===true,
    hurDirectionUsed:w.hur_direction_used===true,
    note:p.note??null,replayMode:p.replay_mode??null,historyRewrite:p.history_rewrite===true
  };
}
function attachUpsetWarning(row:Record<string,unknown>,warnings:Map<string,Record<string,unknown>>){
  if(row.upsetWarning&&typeof row.upsetWarning==="object")return row;
  const exact=warnings.get(warningKey(row.no,row.frozenAt));
  const day=String(row.date??"");
  const historicalReplay=day>="2026-09-20"&&day<"2026-09-26";
  const fallback=historicalReplay?warnings.get("LATEST|"+String(row.no??"").padStart(3,"0")):null;
  const w=exact??fallback;
  return w?{...row,upsetWarning:publicWarning(w)}:row;
}

const riskPick=(v:unknown)=>({"主胜":"H","平":"D","客胜":"A","3":"H","1":"D","0":"A","H":"H","D":"D","A":"A"}[String(v??"")]??null);
const riskNum=(v:unknown)=>v===null||v===undefined||v===""?null:(Number.isFinite(Number(v))?Number(v):null);
function riskLine(v:unknown){
  if(v===null||v===undefined||v==="")return null;
  const raw=String(v).trim(),sign=raw.startsWith("-")?-1:1;
  const parts=raw.replace(/^-/,"").split("/").map(Number);
  if(!parts.length||parts.some(x=>!Number.isFinite(x)))return null;
  return sign*(parts.reduce((a,b)=>a+b,0)/parts.length);
}
async function applyRiskFocusLayer(rows:Record<string,unknown>[],date:string):Promise<Record<string,unknown>[]>{
  if(date<"2026-09-20"||!rows.length)return rows;
  try{
    const {data:matches,error:matchError}=await db.from("soren_matches")
      .select("id,match_no,kickoff_at,cutoff_at").eq("pool_date",date).limit(200);
    if(matchError)throw matchError;
    const matchByNo=new Map<string,Record<string,unknown>>();
    const ids:number[]=[];
    for(const m of matches??[]){
      const no=String(m.match_no??"").padStart(3,"0");
      matchByNo.set(no,m as Record<string,unknown>);
      if(Number.isFinite(Number(m.id)))ids.push(Number(m.id));
    }
    if(!ids.length)return rows;
    const [{data:market,error:marketError},{data:features,error:featureError},{data:formalPredictions,error:predictionError},{data:riskLedger,error:riskLedgerError}]=await Promise.all([
      db.from("soren_market_snapshots")
        .select("match_id,source_code,market_type,snapshot_type,home_value,draw_value,away_value,line,data_quality,payload,captured_at,ingested_at")
        .in("match_id",ids)
        .in("source_code",["zucaijia_william","zucaijia_asia4:1","qiulaile_sp_mirror"])
        .in("market_type",["FT_1X2","ASIAN_HANDICAP","HAD"])
        .in("data_quality",["verified","verified_mirror"])
        .order("captured_at",{ascending:false}).limit(6000),
      db.from("soren_feature_snapshots")
        .select("match_id,feature_type,data_quality,payload,captured_at,ingested_at")
        .in("match_id",ids).like("feature_type","SCORE_ENGINE%")
        .order("captured_at",{ascending:false}).limit(1000),
      db.from("soren_predictions")
        .select("match_id,ft_top1,ft_second,dq,frozen_at")
        .in("match_id",ids)
        .order("frozen_at",{ascending:false}).limit(1000),
      db.from("soren_upset_warnings_v1")
        .select("pool_date,match_no,source_model_version,source_revision,warning_model_version,risk_level,risk_score,original_top1,warning_direction,alternative_pick,risk_basis,direction_basis,evidence_domains,directional_domain_count,source_frozen_at,result_fields_used,hur_direction_used,source_payload")
        .eq("pool_date",date)
        .order("source_frozen_at",{ascending:false}).limit(1200),
    ]);
    if(marketError)throw marketError;
    if(featureError)throw featureError;
    if(predictionError)throw predictionError;
    if(riskLedgerError)throw riskLedgerError;
    const marketById=new Map<number,Record<string,unknown>[]>();
    for(const x of market??[]){
      const id=Number(x.match_id);if(!Number.isFinite(id))continue;
      if(!marketById.has(id))marketById.set(id,[]);
      marketById.get(id)!.push(x as Record<string,unknown>);
    }
    const featureById=new Map<number,Record<string,unknown>[]>();
    for(const x of features??[]){
      const id=Number(x.match_id);if(!Number.isFinite(id))continue;
      if(!featureById.has(id))featureById.set(id,[]);
      featureById.get(id)!.push(x as Record<string,unknown>);
    }
    const formalPredictionById=new Map<number,Record<string,unknown>>();
    for(const x of formalPredictions??[]){
      const id=Number(x.match_id);if(!Number.isFinite(id)||formalPredictionById.has(id))continue;
      formalPredictionById.set(id,x as Record<string,unknown>);
    }
    const riskLedgerByNo=new Map<string,Record<string,unknown>[]>();
    for(const x of riskLedger??[]){
      const no=String(x.match_no??"").padStart(3,"0");
      if(!riskLedgerByNo.has(no))riskLedgerByNo.set(no,[]);
      riskLedgerByNo.get(no)!.push(x as Record<string,unknown>);
    }
    const before=(x:Record<string,unknown>,cut:number)=>{
      const c=Date.parse(String(x.captured_at??"")),i=Date.parse(String(x.ingested_at??x.captured_at??""));
      return Number.isFinite(c)&&Number.isFinite(i)&&c<=cut&&i<=cut;
    };
    const latestMarket=(list:Record<string,unknown>[],source:string,type:string,snapshot:string,cut:number)=>
      list.find(x=>String(x.source_code)===source&&String(x.market_type)===type&&String(x.snapshot_type)===snapshot&&before(x,cut))??null;
    const latestScore=(list:Record<string,unknown>[],cut:number)=>
      list.find(x=>before(x,cut)&&String(x.feature_type).startsWith("SCORE_ENGINE"))??null;

    return rows.map(row=>{
      let raw=(row.upsetWarning&&typeof row.upsetWarning==="object"&&!Array.isArray(row.upsetWarning))
        ?row.upsetWarning as Record<string,unknown>:null;
      if(!raw||row.pregameVerified!==true)return row;
      const no=String(row.no??"").padStart(3,"0"),match=matchByNo.get(no);
      if(!match)return row;
      const id=Number(match.id),formal=formalPredictionById.get(id)??null;
      const formalAt=Date.parse(String(formal?.frozen_at??""));
      const formalTop=riskPick(formal?.ft_top1),formalSecond=riskPick(formal?.ft_second);
      const formalDq=String(formal?.dq??"");
      const kick=Date.parse(String(row.kickoff??match.kickoff_at??""));
      const cutoff=Date.parse(String(row.saleCutoffAt??match.cutoff_at??""));
      const boundary=Number.isFinite(cutoff)&&Number.isFinite(boundary)&&cutoff<kick?cutoff:kick;

      // Public risk is anchored to the immutable formal prediction. If a later
      // upstream refresh changes the Top1, retain it in the ledger for audit but
      // serve the latest pre-freeze warning that still matches the formal Top1.
      if(date>="2026-09-26"&&formalTop&&Number.isFinite(formalAt)&&Number.isFinite(boundary)){
        const currentTop=riskPick(raw.originalTop1??raw.original_top1);
        const servedAt=Date.parse(String(row.frozenAt??""));
        const warningAt=Date.parse(String(raw.prematchAt??raw.prematch_at??""));
        const currentWarningMatchesServedSnapshot=currentTop!==null&&currentTop===riskPick(row.ftTop1)&&
          Number.isFinite(servedAt)&&Number.isFinite(warningAt)&&Math.abs(servedAt-warningAt)<=300000;
        if(currentTop!==formalTop&&!currentWarningMatchesServedSnapshot){
          const stable=(riskLedgerByNo.get(no)??[]).find(x=>{
            const payload=(x.source_payload&&typeof x.source_payload==="object"?x.source_payload:{}) as Record<string,unknown>;
            const candidateTop=riskPick(x.original_top1??payload.originalTop1);
            const at=Date.parse(String(x.source_frozen_at??payload.prematchAt??""));
            const gate=(payload.focusGate&&typeof payload.focusGate==="object"?payload.focusGate:{}) as Record<string,unknown>;
            const basis=Array.isArray(x.risk_basis)?x.risk_basis:[];
            const marketEvidence=gate.market_anomaly===true||
              basis.some(v=>/竞彩HAD首选.*与William原始首选.*冲突|升赔|退盘/.test(String(v??"")));
            return candidateTop===formalTop&&marketEvidence&&Number.isFinite(at)&&at>=formalAt&&at<boundary;
          });
          if(stable)raw=publicWarning(stable);
        }
      }

      const sourcePublish=raw.publish===true;
      const rawScore=riskNum(raw.riskScore??raw.risk_score);
      // Preserve meaningful broad-risk records in the detail page even when they
      // do not qualify for a highlighted focus strip. Low-signal (0–2) rows stay quiet.
      const generalCandidate=sourcePublish||(rawScore!==null&&rawScore>=3);
      if(!generalCandidate)return row;
      const freezeAt=String(raw.prematchAt??raw.prematch_at??row.frozenAt??"");
      const cut=Date.parse(freezeAt);
      if(!Number.isFinite(cut)||!Number.isFinite(boundary)||cut>=boundary)return row;
      const top=riskPick(raw.originalTop1??raw.original_top1??row.ftTop1);
      const rowFreeze=Date.parse(String(row.frozenAt??""));
      const rowTop=riskPick(row.ftTop1),rowSecond=riskPick(row.second);
      const rowRisk=(row.risk&&typeof row.risk==="object"?row.risk:{}) as Record<string,unknown>;
      const servedDq=String(rowRisk.dq??formalDq??"");
      // The customer page serves the newest verified pre-freeze snapshot, which can
      // legitimately be newer than soren_predictions. When the warning belongs to
      // that exact served snapshot, evaluate the visible Top1/Top2 pair instead of
      // forcing an older formal-prediction pair and suppressing a real H/A split.
      const servedSnapshotMatchesTop=date>="2026-09-26"&&rowTop!==null&&rowTop===top;
      const second=date>="2026-09-26"?
        (servedSnapshotMatchesTop?(rowSecond??formalSecond):(formalSecond??rowSecond)):
        rowSecond;
      const oppositeSecond=!!(top&&second&&["H","A"].includes(top)&&["H","A"].includes(second)&&top!==second);
      const historicalReplay=date<"2026-09-26";
      const historicalDq=servedDq;
      const historicalPredictionAt=Number.isFinite(rowFreeze)?rowFreeze:formalAt;
      const historicalTop=rowTop??formalTop;
      const historicalSecond=rowSecond??formalSecond;
      const historicalEligible=historicalReplay&&row.pregameVerified===true&&
        ["DQ-A","DQ-B"].includes(historicalDq)&&
        Number.isFinite(historicalPredictionAt)&&historicalPredictionAt<boundary&&historicalPredictionAt<=cut&&
        Number.isFinite(cut)&&cut<boundary&&
        historicalTop===top&&historicalSecond===second;
      const formalStoreEligible=!historicalReplay&&!!formal&&Number.isFinite(formalAt)&&formalAt<boundary&&
        ["DQ-A","DQ-B"].includes(formalDq)&&formalTop===top&&formalSecond===second;
      const servedPredictionEligible=!historicalReplay&&row.pregameVerified===true&&
        Number.isFinite(rowFreeze)&&rowFreeze<boundary&&Number.isFinite(cut)&&
        Math.abs(rowFreeze-cut)<=300000&&["DQ-A","DQ-B"].includes(servedDq)&&
        rowTop===top&&rowSecond===second;
      const formalPredictionEligible=!historicalReplay&&(formalStoreEligible||servedPredictionEligible);
      const publicationEligible=historicalReplay?historicalEligible:formalPredictionEligible;
      if(!publicationEligible){
        // A low-DQ snapshot may still contain a directly visible H/A split.
        // Keep that risk visible, but do not publish a concrete reverse direction.
        const lowDqBasis=Array.isArray(raw.riskBasis)?raw.riskBasis:(Array.isArray(raw.risk_basis)?raw.risk_basis:[]);
        const lowDqMarketAnomaly=lowDqBasis.some(v=>/竞彩HAD首选.*与William原始首选.*冲突|升赔|退盘/.test(String(v??"")));
        const riskDisplayEligible=!historicalReplay&&row.pregameVerified===true&&
          Number.isFinite(rowFreeze)&&rowFreeze<boundary&&Number.isFinite(cut)&&Math.abs(rowFreeze-cut)<=300000&&
          rowTop===top&&oppositeSecond;
        const lowDqDisplayTier=riskDisplayEligible?(lowDqMarketAnomaly?"强风险信号":"重点风险"):null;
        return {...row,upsetWarning:{...raw,
          sourcePublish,publish:riskDisplayEligible,detailOnly:false,displayTier:lowDqDisplayTier,
          publicationEligible:false,
          riskDisplayEligible,
          directionPublicationEligible:false,
          publicationReason:riskDisplayEligible?"RISK_SPLIT_VISIBLE_DIRECTION_BLOCKED_DQ":
            (historicalReplay?"HISTORICAL_FREEZE_MISMATCH":"NO_MATCHING_FORMAL_PREDICTION"),
          replayMode:historicalReplay?"STRICT_PREMATCH_LAYER_REPLAY":raw.replayMode??null,
          historyRewrite:false,
          focusGate:{
            opposite_second:riskDisplayEligible&&oppositeSecond,
            qualified_draw:false,
            market_anomaly:riskDisplayEligible&&lowDqMarketAnomaly,
            rule_version:"HJ38-RISK-LAYER-v1.2.6",
            evaluated_at:freezeAt
          },
          marketSignals:riskDisplayEligible&&lowDqMarketAnomaly?["冻结风险依据存在市场反向变化"]:[],
          independentDrawProbability:null,
          focusRuleVersion:"HJ38-RISK-LAYER-v1.2.6"
        }};
      }

      const scoreRow=latestScore(featureById.get(id)??[],cut);
      const scorePayload=(scoreRow?.payload&&typeof scoreRow.payload==="object"?scoreRow.payload:{}) as Record<string,unknown>;
      const drawProb=riskNum(scorePayload.dc_p_draw??scorePayload.p_draw);
      const strictScore=scoreRow!==null&&
        String(scoreRow.data_quality??scorePayload.input_quality??"")==="STRICT_PREMATCH_XG"&&
        scorePayload.strict_prematch===true&&scorePayload.target_result_used!==true&&
        Number.isFinite(drawProb??NaN);
      const qualifiedDraw=second==="D"&&strictScore&&(drawProb??0)>=0.27;

      const list=marketById.get(id)??[],signals:string[]=[];
      // Preserve a market conflict already certified inside the same frozen upstream warning.
      // Count it only when William's original side equals the frozen Top1 and the lottery HAD side opposes it.
      const frozenRiskBasis=Array.isArray(raw.riskBasis)?raw.riskBasis:(Array.isArray(raw.risk_basis)?raw.risk_basis:[]);
      for(const item of frozenRiskBasis){
        const m=String(item??"").match(/竞彩HAD首选(主胜|平|客胜)与William原始首选(主胜|平|客胜)冲突/);
        if(!m)continue;
        const sporttery=riskPick(m[1]),williamOriginal=riskPick(m[2]);
        if(top&&williamOriginal===top&&sporttery&&sporttery!==top){
          signals.push("体彩HAD方向冲突");
          break;
        }
      }
      const wi=latestMarket(list,"zucaijia_william","FT_1X2","initial",cut);
      const wc=latestMarket(list,"zucaijia_william","FT_1X2","current",cut);
      if(top&&wi&&wc){
        const a=riskNum(top==="H"?wi.home_value:wi.away_value),b=riskNum(top==="H"?wc.home_value:wc.away_value);
        if(a!==null&&b!==null&&b>a&&(b-a>=0.08||b/a>=1.05))signals.push("William热门方向升赔");
      }
      const ai=latestMarket(list,"zucaijia_asia4:1","ASIAN_HANDICAP","initial",cut);
      const ac=latestMarket(list,"zucaijia_asia4:1","ASIAN_HANDICAP","current",cut);
      if(ai&&ac){
        const api=(ai.payload&&typeof ai.payload==="object"?ai.payload:{}) as Record<string,unknown>;
        const acp=(ac.payload&&typeof ac.payload==="object"?ac.payload:{}) as Record<string,unknown>;
        const a=riskLine(api.original_line??ai.line),b=riskLine(acp.original_line??ac.line);
        if(a!==null&&b!==null&&Math.abs(b)+0.24<=Math.abs(a))signals.push("亚洲盘退盘");
      }
      const si=latestMarket(list,"qiulaile_sp_mirror","HAD","initial",cut);
      const sc=latestMarket(list,"qiulaile_sp_mirror","HAD","current",cut);
      if(top&&sc){
        const sh=riskNum(sc.home_value),sa=riskNum(sc.away_value);
        if(sh!==null&&sa!==null){
          const side=sh<sa?"H":"A";
          if(side!==top)signals.push("体彩HAD方向冲突");
        }
        if(si){
          const a=riskNum(top==="H"?si.home_value:si.away_value),b=riskNum(top==="H"?sc.home_value:sc.away_value);
          if(a!==null&&b!==null&&b-a>=0.08)signals.push("体彩HAD热门方向升赔");
        }
      }
      const marketSignals=[...new Set(signals)],marketAnomaly=marketSignals.length>0;
      const focus=oppositeSecond||qualifiedDraw;
      const displayTier=focus?(marketAnomaly?"强风险信号":"重点风险"):"一般风险";
      return {...row,upsetWarning:{...raw,
        sourcePublish,publish:focus,detailOnly:!focus,displayTier,
        focusGate:{
          opposite_second:oppositeSecond,
          qualified_draw:qualifiedDraw,
          market_anomaly:marketAnomaly,
          rule_version:"HJ38-RISK-LAYER-v1.2.6",
          evaluated_at:freezeAt
        },
        marketSignals,
        independentDrawProbability:strictScore?drawProb:null,
        publicationEligible:true,
        publicationReason:historicalReplay?"HISTORICAL_PREMATCH_FREEZE_MATCHED":
          (servedPredictionEligible&&!formalStoreEligible?"LATEST_PREMATCH_FREEZE_MATCHED":"FORMAL_PREDICTION_MATCHED"),
        formalPredictionAt:historicalReplay?(row.frozenAt??null):
          (servedPredictionEligible&&!formalStoreEligible?(row.frozenAt??null):(formal?.frozen_at??null)),
        formalPredictionDq:historicalReplay?(row.risk&&typeof row.risk==="object"?(row.risk as Record<string,unknown>).dq??null:null):
          (servedPredictionEligible&&!formalStoreEligible?servedDq:formalDq),
        replayMode:historicalReplay?"STRICT_PREMATCH_LAYER_REPLAY":raw.replayMode??null,
        historyRewrite:false,
        focusRuleVersion:"HJ38-RISK-LAYER-v1.2.6"
      }};
    });
  }catch(error){
    console.error("RISK_FOCUS_LAYER_UNAVAILABLE",error);
    // Fail closed for the new highlighted layer: preserve detail data but do not invent a strong signal.
    return rows.map(row=>{
      const raw=(row.upsetWarning&&typeof row.upsetWarning==="object"&&!Array.isArray(row.upsetWarning))
        ?row.upsetWarning as Record<string,unknown>:null;
      if(!raw||row.pregameVerified!==true)return row;
      const sourcePublish=raw.publish===true,rawScore=riskNum(raw.riskScore??raw.risk_score);
      const generalCandidate=sourcePublish||(rawScore!==null&&rawScore>=3);
      if(!generalCandidate)return row;
      return {...row,upsetWarning:{...raw,sourcePublish,publish:false,detailOnly:false,
        displayTier:null,publicationEligible:false,publicationReason:"RISK_LAYER_UNAVAILABLE",
        focusGate:{opposite_second:false,qualified_draw:false,market_anomaly:false,rule_version:"HJ38-RISK-LAYER-v1.2.6-FALLBACK"},
        marketSignals:[]}};
    });
  }
}
function upsetStatsFor(rows:Record<string,unknown>[]){
  const published=rows.filter(r=>{const w=r.upsetWarning as Record<string,unknown>|null;return w?.publish===true});
  const tierOf=(r:Record<string,unknown>)=>{
    const w=r.upsetWarning as Record<string,unknown>|null;
    return String(w?.displayTier??w?.display_tier??"");
  };
  const strong=published.filter(r=>tierOf(r)==="强风险信号").length;
  const focus=published.filter(r=>tierOf(r)==="重点风险").length;
  return {
    modelVersion:"HJ38-UPSET-v1.1.0",
    riskLayerVersion:"HJ38-RISK-LAYER-v1.2.6",
    published:published.length,
    strong,focus,
    // Backward-compatible keys: high/medium now follow the public layered tier, not legacy risk_score bands.
    high:strong,medium:focus,
    directionPublished:published.filter(r=>!!(r.upsetWarning as Record<string,unknown>)?.warningDirection).length,
    resultFieldsUsed:published.some(r=>(r.upsetWarning as Record<string,unknown>)?.resultFieldsUsed===true),
    hurDirectionUsed:published.some(r=>(r.upsetWarning as Record<string,unknown>)?.hurDirectionUsed===true)
  };
}



/* Daily selection layer v1.1.
   Core and supplement must both pass the highlighted-risk gate.
   Supplement only from the daily Top3 William 1.45–1.75 value band, then remove
   core overlap and highlighted risk. Ranking happens BEFORE core/risk removal
   and never backfills from rank 4+. */
/* High-draw risk shadow v0.1.
   Historical trigger is deliberately narrow: frozen draw probability >=29%
   AND official home handicap -1. It does not rewrite FT Top1; it only exposes
   the already-frozen handicap Top1/Top2 as the protection layer. */
function applyHighDrawRiskLayer(rows:Record<string,unknown>[]):Record<string,unknown>[]{
  return rows.map(row=>{
    const drawRaw=row.drawProbability??row.drawPct??row.draw_pct;
    const draw=Number(drawRaw);
    const drawPct=Number.isFinite(draw)?(draw<=1?draw*100:draw):null;
    const official=Number(row.officialHandicap);
    const top1=String(row.handicapTop1??row.handicap??"").trim();
    const second=String(row.handicapSecond??"").trim();
    const p1=Number(row.handicapProbability??row.handicap_probability);
    const p2=Number(row.handicapSecondProbability??row.handicap_second_probability);
    const validPick=(v:string)=>["让胜","让平","让负","HWIN","HDRAW","HLOSS"].includes(v);
    const eligible=row.pregameVerified===true&&drawPct!==null&&drawPct>=29&&official===-1&&
      validPick(top1)&&validPick(second)&&Number.isFinite(p1)&&Number.isFinite(p2);
    if(!eligible)return {...row,highDrawRisk:false};
    return {...row,
      highDrawRisk:true,
      highDrawRiskLabel:"高平风险",
      highDrawRiskReason:"平局风险偏高",
      highDrawRiskDrawProbability:drawPct,
      highDrawRiskVersion:"HIGH-DRAW-SHADOW-v0.1-20260927"
    };
  });
}

function dailySelectionRiskBlocked(row:Record<string,unknown>){
  if(row.highDrawRisk===true)return true;
  if(row.marketDirectionAnomaly===true)return true;
  if(row.dailySelectionRiskLocked===true)return true;
  const warning=(row.upsetWarning&&typeof row.upsetWarning==="object"&&!Array.isArray(row.upsetWarning))
    ?row.upsetWarning as Record<string,unknown>:null;
  const tier=String(warning?.displayTier??warning?.display_tier??"");
  return warning?.publish===true||tier==="重点风险"||tier==="强风险信号";
}
function dailyCorePick(row:Record<string,unknown>){
  const tier=String(row.tier??"").trim().toUpperCase();
  const mode=String(row.mode??"").trim().toUpperCase();
  return row.pregameVerified===true&&(mode==="SINGLE"||mode==="DOUBLE")&&tier!==""&&tier!=="PASS"&&row.pass!==true
    &&!dailySelectionRiskBlocked(row);
}
function dailySelectionStatsFor(rows:Record<string,unknown>[]){
  const core=rows.filter(r=>String(r.dailySelectionTier??"")==="CORE");
  const supplement=rows.filter(r=>String(r.dailySelectionTier??"")==="SUPPLEMENT");
  const odds=supplement.map(r=>Number((r.dailySelectionMeta as Record<string,unknown>|null)?.williamTop1Odds))
    .filter(Number.isFinite);
  return {
    selectorVersion:"DAILY-VALUE-v1.3-20260928",
    core:core.length,
    supplement:supplement.length,
    total:core.length+supplement.length,
    frozenRiskLocked:rows.filter(r=>r.dailySelectionRiskLocked===true).length,
    coldWarningLocked:rows.filter(r=>String(r.dailySelectionRiskLockReason??"")==="VIP_COLD_WARNING_PUBLISHED").length,
    supplementAverageWilliamOdds:odds.length?Math.round(odds.reduce((a,b)=>a+b,0)/odds.length*1000)/1000:null
  };
}
async function attachDailySupplementLayer(rows:Record<string,unknown>[],date:string):Promise<Record<string,unknown>[]>{
  const selectorVersion="DAILY-VALUE-v1.3-20260928";
  // High-draw risk shadow: only the historically validated structure is enabled.
  // It does not rewrite FT Top1; it forces the already-frozen handicap protection into customer display.
  const highDrawTagged=rows.map(row=>{
    const draw=riskNum(row.drawProbability??row.drawPct??row.draw_pct);
    const official=Number(row.officialHandicap);
    const first=String(row.handicapTop1??row.handicap??"");
    const second=String(row.handicapSecond??"");
    const trigger=row.pregameVerified===true&&draw!==null&&draw>=29&&official===-1&&
      ["让胜","让平","让负"].includes(first)&&["让胜","让平","让负"].includes(second);
    return trigger?{...row,highDrawRisk:true,highDrawRiskLabel:"高平风险",
      highDrawRiskReason:"平局风险偏高",highDrawRiskProbability:draw,
      highDrawRiskRuleVersion:"HJ38-HIGH-DRAW-SHADOW-v0.1"}:row;
  });
  let tagged=highDrawTagged.map(row=>dailyCorePick(row)?{...row,dailySelectionTier:"CORE",dailySelectionLabel:"核心优选"}:{...row,dailySelectionTier:null,dailySelectionLabel:null});
  if(!rows.length||date<"2026-09-20")return tagged;
  try{
    // Immutable one-way eligibility lock: if the first formal customer freeze was
    // already blocked by published/focus risk, later prematch risk downgrades may
    // update analysis but must never promote the match into CORE or SUPPLEMENT.
    const [{data:saleFreezes,error:saleFreezeError},{data:coldLocks,error:coldLockError}]=await Promise.all([
      db.from("soren_sale_freezes_v1")
        .select("match_no,source_frozen_at,snapshot").eq("pool_date",date).limit(300),
      db.from("soren_daily_selection_locks_v1")
        .select("match_no,locked_at").eq("pool_date",date).eq("lock_type","VIP_COLD_WARNING").limit(300),
    ]);
    if(saleFreezeError)throw saleFreezeError;
    if(coldLockError)throw coldLockError;
    const frozenRiskLocks=new Map<string,string|null>();
    for(const freeze of saleFreezes??[]){
      const snapshot=freeze.snapshot;
      if(!snapshot||typeof snapshot!=="object"||Array.isArray(snapshot))continue;
      const warning=(snapshot as Record<string,unknown>).upsetWarning;
      if(!warning||typeof warning!=="object"||Array.isArray(warning))continue;
      const w=warning as Record<string,unknown>;
      const tier=String(w.displayTier??w.display_tier??"");
      if(w.publish===true||tier==="重点风险"||tier==="强风险信号"){
        frozenRiskLocks.set(String(freeze.match_no??"").padStart(3,"0"),
          freeze.source_frozen_at?String(freeze.source_frozen_at):null);
      }
    }
    const coldLockByNo=new Map<string,string|null>();
    for(const lock of coldLocks??[]){
      coldLockByNo.set(String(lock.match_no??"").padStart(3,"0"),lock.locked_at?String(lock.locked_at):null);
    }
    tagged=rows.map(row=>{
      const no=String(row.no??"").padStart(3,"0");
      const coldLocked=coldLockByNo.has(no);
      const frozenLocked=frozenRiskLocks.has(no);
      const prepared=coldLocked?{...row,
        dailySelectionRiskLocked:true,
        dailySelectionRiskLockReason:"VIP_COLD_WARNING_PUBLISHED",
        dailySelectionRiskLockAt:coldLockByNo.get(no)??null}
        :frozenLocked?{...row,
          dailySelectionRiskLocked:true,
          dailySelectionRiskLockReason:"FORMAL_FREEZE_RISK_BLOCK",
          dailySelectionRiskLockAt:frozenRiskLocks.get(no)??null}:row;
      return dailyCorePick(prepared)
        ?{...prepared,dailySelectionTier:"CORE",dailySelectionLabel:"核心优选"}
        :{...prepared,dailySelectionTier:null,dailySelectionLabel:null};
    });

    const {data:matches,error:matchError}=await db.from("soren_matches")
      .select("id,match_no,home_team,away_team,kickoff_at,official_handicap")
      .eq("pool_date",date).limit(200);
    if(matchError)throw matchError;
    const byNo=new Map<string,Record<string,unknown>>();
    const ids:number[]=[];
    for(const m of matches??[]){
      const no=String(m.match_no??"").padStart(3,"0");
      byNo.set(no,m as Record<string,unknown>);
      if(Number.isFinite(Number(m.id)))ids.push(Number(m.id));
    }
    if(!ids.length)return tagged;

    const {data:markets,error:marketError}=await db.from("soren_market_snapshots")
      .select("match_id,snapshot_type,home_value,draw_value,away_value,data_quality,captured_at,ingested_at")
      .in("match_id",ids)
      .eq("source_code","zucaijia_william")
      .eq("market_type","FT_1X2")
      .in("data_quality",["verified","verified_mirror"])
      .order("captured_at",{ascending:false}).limit(5000);
    if(marketError)throw marketError;

    const marketById=new Map<number,Record<string,unknown>[]>();
    for(const x of markets??[]){
      const id=Number(x.match_id);if(!Number.isFinite(id))continue;
      if(!marketById.has(id))marketById.set(id,[]);
      marketById.get(id)!.push(x as Record<string,unknown>);
    }

    // Dynamic market-direction anomaly: official +/-1 only. Compare the earliest
    // verified William current quote with the latest verified pre-kickoff quote.
    // This is a risk/exclusion layer only; it never rewrites the frozen FT Top1.
    tagged=tagged.map(row=>{
      const no=String(row.no??"").padStart(3,"0"),match=byNo.get(no);
      if(!match)return row;
      const official=Number(match.official_handicap);
      if(Math.abs(official)!==1)return row;
      const kick=Date.parse(String(row.kickoff??match.kickoff_at??""));
      const now=Math.min(Date.now(),Number.isFinite(kick)?kick-1:Date.now());
      const list=(marketById.get(Number(match.id))??[])
        .filter(x=>String(x.snapshot_type)==="current"&&Date.parse(String(x.captured_at??""))<=now)
        .sort((a,b)=>Date.parse(String(a.captured_at??""))-Date.parse(String(b.captured_at??"")));
      if(list.length<2)return row;
      const first=list[0],last=list[list.length-1];
      const h0=riskNum(first.home_value),a0=riskNum(first.away_value);
      const h1=riskNum(last.home_value),a1=riskNum(last.away_value);
      if(h0===null||a0===null||h1===null||a1===null||h0===a0||h0<=0||a0<=0)return row;
      const homeFav=h0<a0;
      const fav0=homeFav?h0:a0,fav1=homeFav?h1:a1;
      const opp0=homeFav?a0:h0,opp1=homeFav?a1:h1;
      const rise=(fav1/fav0-1)*100,drop=(1-opp1/opp0)*100;
      if(rise<5||drop<5)return row;
      return {...row,
        marketDirectionAnomaly:true,
        marketDirectionRiskLabel:"市场异动信号",
        marketDirectionRiskReason:"市场方向变化",
        marketDirectionRisePct:Math.round(rise*100)/100,
        marketDirectionDropPct:Math.round(drop*100)/100,
        marketDirectionFirstAt:first.captured_at??null,
        marketDirectionLatestAt:last.captured_at??null,
        marketProtectionFirst:official<0?"让负":"让胜",
        marketProtectionSecond:"让平",
        dailySelectionRiskLocked:true,
        dailySelectionRiskLockReason:"MARKET_DIRECTION_ANOMALY_5PCT"
      };
    });
    // Re-evaluate CORE after the dynamic risk annotation. Triggered rows can never
    // remain in 今日优选 during this response.
    tagged=tagged.map(row=>dailyCorePick(row)
      ?{...row,dailySelectionTier:"CORE",dailySelectionLabel:"核心优选"}
      :{...row,dailySelectionTier:null,dailySelectionLabel:null});

    const raw:{row:Record<string,unknown>;odds:number;confidence:number;no:string}[]=[];
    for(const row of tagged){
      if(row.pregameVerified!==true)continue;
      const no=String(row.no??"").padStart(3,"0"),match=byNo.get(no);
      if(!match||String(match.home_team)!==String(row.home??"")||String(match.away_team)!==String(row.away??""))continue;
      const cut=Date.parse(String(row.frozenAt??"")),kick=Date.parse(String(row.kickoff??match.kickoff_at??""));
      if(!Number.isFinite(cut)||!Number.isFinite(kick)||cut>=kick)continue;

      const list=marketById.get(Number(match.id))??[];
      const snap=list.find(x=>{
        const captured=Date.parse(String(x.captured_at??""));
        const ingested=Date.parse(String(x.ingested_at??x.captured_at??""));
        return String(x.snapshot_type)==="current"&&Number.isFinite(captured)&&Number.isFinite(ingested)&&captured<=cut&&ingested<=cut;
      });
      if(!snap)continue;

      const code=riskPick(row.ftTop1);
      const odds=riskNum(code==="H"?snap.home_value:code==="D"?snap.draw_value:code==="A"?snap.away_value:null);
      const confidence=riskNum(row.confidence);
      if(odds===null||odds<1.45||odds>1.75||confidence===null)continue;
      raw.push({row,odds,confidence,no});
    }

    raw.sort((a,b)=>b.confidence-a.confidence||a.odds-b.odds||a.no.localeCompare(b.no));
    const selected=new Map<string,{rank:number;odds:number;confidence:number}>();
    raw.slice(0,3).forEach((x,i)=>{
      if(dailyCorePick(x.row))return;
      if(dailySelectionRiskBlocked(x.row))return;
      selected.set(String(x.row.no??"").padStart(3,"0"),{rank:i+1,odds:x.odds,confidence:x.confidence});
    });

    tagged=tagged.map(row=>{
      if(dailyCorePick(row))return row;
      const no=String(row.no??"").padStart(3,"0"),hit=selected.get(no);
      if(!hit)return row;
      return {...row,
        dailySelectionTier:"SUPPLEMENT",
        dailySelectionLabel:"精选补充",
        dailySelectionMeta:{
          selectorVersion,
          rank:hit.rank,
          williamTop1Odds:Math.round(hit.odds*100)/100,
          frozenAt:row.frozenAt??null,
          rule:"William 1.45–1.75 · 日内Top3 · 非核心 · 风险过滤通过"
        }
      };
    });

    // Final hard gate: 今日优选 and VIP 冷门预警 must never overlap.
    // Evaluate only the tiny set already selected above, reusing the exact VIP cold-warning algorithm.
    // A published cold warning is persisted as a one-way daily lock, so later market/risk downgrades
    // cannot promote the match back into CORE or SUPPLEMENT.
    const todayBjt=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"})
      .format(new Date()).split("/").join("-");
    if(date>="2026-09-28"&&date>=todayBjt){
      const dailyNos=new Set(tagged
        .filter(r=>["CORE","SUPPLEMENT"].includes(String(r.dailySelectionTier??"")))
        .map(r=>String(r.no??"").padStart(3,"0")));
      if(dailyNos.size){
        try{
          const coldZone=await paidMemberZone(date,tagged,dailyNos);
          const coldNos=new Set((coldZone.rows??[]).map((r:any)=>String(r.no??"").padStart(3,"0")));
          if(coldNos.size){
            tagged=tagged.map(row=>{
              const no=String(row.no??"").padStart(3,"0");
              if(!coldNos.has(no))return row;
              return {...row,
                dailySelectionTier:null,
                dailySelectionLabel:null,
                dailySelectionRiskLocked:true,
                dailySelectionRiskLockReason:"VIP_COLD_WARNING_PUBLISHED",
                dailySelectionRiskLockAt:new Date().toISOString()
              };
            });
          }
        }catch(coldGateError){
          console.error("DAILY_VIP_COLD_GATE_UNAVAILABLE",coldGateError);
          // Fail closed: if exact cold-warning verification is unavailable, do not expose a
          // possibly-conflicting 今日优选. This temporary block is not persisted.
          tagged=tagged.map(row=>["CORE","SUPPLEMENT"].includes(String(row.dailySelectionTier??""))
            ?{...row,dailySelectionTier:null,dailySelectionLabel:null,
              dailySelectionRiskLocked:true,dailySelectionRiskLockReason:"VIP_COLD_GATE_UNAVAILABLE"}
            :row);
        }
      }
    }
    return tagged;
  }catch(error){
    console.error("DAILY_SUPPLEMENT_LAYER_UNAVAILABLE",error);
    return tagged;
  }
}

/* Read-only, authenticated, on-demand match report. All inputs are cached
   in Soren customer DB; this route never invokes an external football API. */
function vipRiskSignalPresent(row:Record<string,unknown>){
  const raw=(row.upsetWarning&&typeof row.upsetWarning==="object"&&!Array.isArray(row.upsetWarning))
    ?row.upsetWarning as Record<string,unknown>:{};
  const tier=String(raw.displayTier??raw.display_tier??"");
  const drawRaw=Number(row.drawProbability??row.drawPct??row.draw_pct);
  const drawPct=Number.isFinite(drawRaw)?(drawRaw<=1?drawRaw*100:drawRaw):null;
  const official=Number(row.officialHandicap);
  const first=String(row.handicapTop1??row.handicap??"").trim();
  const second=String(row.handicapSecond??"").trim();
  const p1=Number(row.handicapProbability??row.handicap_probability);
  const p2=Number(row.handicapSecondProbability??row.handicap_second_probability);
  const valid=(v:string)=>["让胜","让平","让负","HWIN","HDRAW","HLOSS"].includes(v);
  const highDrawFallback=row.pregameVerified===true&&drawPct!==null&&drawPct>=29&&official===-1&&
    valid(first)&&valid(second)&&Number.isFinite(p1)&&Number.isFinite(p2);
  return row.highDrawRisk===true||highDrawFallback||row.marketDirectionAnomaly===true||
    raw.publish===true||["重点风险","强风险信号"].includes(tier);
}
function redactLiveVipRisk(row:Record<string,unknown>){
  const locked=vipRiskSignalPresent(row);
  return {
    ...row,
    vipRiskAccessRestricted:true,
    vipRiskLocked:locked,
    vipRiskNotice:locked?"VIP风险信号已触发":null,
    highDrawRisk:false,
    highDrawRiskReason:null,
    marketDirectionAnomaly:false,
    marketProtectionFirst:null,
    marketProtectionSecond:null,
    upsetWarning:null,
    upset_warning:null,
    riskAnalysis:locked?"VIP_RISK_LOCKED":null
  };
}

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


/* Compact time series read only when the user expands a market chart.
   Match identity + verified source + pre-kickoff time are mandatory. */
async function marketTrend(date:string,no:string){
  const {data:match,error:matchError}=await db.from("soren_matches")
    .select("id,home_team,away_team,kickoff_at")
    .eq("pool_date",date).eq("match_no",no).maybeSingle();
  if(matchError)throw matchError;
  if(!match)return null;
  const kickoff=String(match.kickoff_at??"");
  const source="zucaijia_william";
  const select="captured_at,home_value,draw_value,away_value,data_quality";
  const [recent,opening]=await Promise.all([
    db.from("soren_market_snapshots").select(select).eq("match_id",match.id)
      .eq("source_code",source).eq("market_type","FT_1X2").eq("snapshot_type","current")
      .in("data_quality",["verified","verified_mirror"]).lt("captured_at",kickoff)
      .order("captured_at",{ascending:false}).limit(360),
    db.from("soren_market_snapshots").select(select).eq("match_id",match.id)
      .eq("source_code",source).eq("market_type","FT_1X2").eq("snapshot_type","initial")
      .in("data_quality",["verified","verified_mirror"]).lt("captured_at",kickoff)
      .order("captured_at",{ascending:true}).limit(1),
  ]);
  if(recent.error||opening.error)throw recent.error??opening.error;
  const normalize=(v:Record<string,unknown>,phase:string)=>{
    const values=[v.home_value,v.draw_value,v.away_value].map(x=>x===null||x===undefined?NaN:Number(x));
    const t=Date.parse(String(v.captured_at??""));
    if(!Number.isFinite(t)||values.some(n=>!Number.isFinite(n)||n<=1||n>100))return null;
    return {at:v.captured_at,phase,home:values[0],draw:values[1],away:values[2]};
  };
  const unique=new Map<string,Record<string,unknown>>();
  for(const raw of recent.data??[]){
    const point=normalize(raw,"赛前");
    if(point&&!unique.has(String(point.at)))unique.set(String(point.at),point);
  }
  const ascending=[...unique.values()].sort((a,b)=>Date.parse(String(a.at))-Date.parse(String(b.at)));
  const selected=ascending.length<=12?ascending:Array.from({length:12},(_,i)=>ascending[Math.round(i*(ascending.length-1)/11)]);
  const first=opening.data?.[0]?normalize(opening.data[0],"初赔"):null;
  const points=first&&(!selected.length||Date.parse(String(first.at))<Date.parse(String(selected[0].at)))?[first,...selected]:selected;
  return {date,no,home:match.home_team,away:match.away_team,source:"威廉希尔",points,
    note:"同一机构赛前已核验赔率快照；仅展示抽样关键时点，非连续全量报价。"};
}


async function serveFastArchiveBundle(date:string,view:string,vipActive=false):Promise<Response|null>{
  try{
    const {data:bundle,error}=await db.rpc("soren_fast_archive_bundle_v2",{p_date:date});
    if(error||!bundle||typeof bundle!=="object"||Array.isArray(bundle)){
      if(error)console.error("FAST_ARCHIVE_BUNDLE_UNAVAILABLE",error);
      return null;
    }
    const b=bundle as Record<string,unknown>;
    const rawRows=Array.isArray(b.rows)?(b.rows as Record<string,unknown>[]):[];
    if(!rawRows.length)return null;
    const modelVersion=String(rawRows.find(r=>r.version)?.version??"");
    const revision=allowed.get(modelVersion);
    if(!revision)return null;

    const resultRecords=Array.isArray(b.results)?(b.results as Record<string,unknown>[]):[];
    const verifiedResults=new Map<string,Record<string,unknown>>();
    for(const r of resultRecords)verifiedResults.set(String(r.match_no??"").padStart(3,"0"),r);

    const pick=(v:unknown)=>({"主胜":"H","平":"D","客胜":"A","3":"H","1":"D","0":"A",H:"H",D:"D",A:"A"}[String(v??"")]??null);
    let rows=rawRows.map(row=>{
      const no=String(row.no??"").padStart(3,"0");
      const stored=verifiedResults.get(no);
      if(!stored){
        return {...row,resultVerified:false,result:null,resultHome:null,resultAway:null,resultScore:null,
          resultSource:null,resultVerifiedAt:null,top1Hit:null,coverageHit:null,handicapResult:null,
          handicapTop1Hit:null,handicapCoverageHit:null,handicapHit:null};
      }
      const actual=String(stored.ft_result??"");
      const primary=pick(row.ftTop1),secondary=pick(row.second);
      const handicapActual=handicapName[String(stored.handicap_result??"")]??null;
      return {...row,
        resultVerified:true,result:actual,
        resultHome:Number(stored.home_score),resultAway:Number(stored.away_score),
        resultScore:String(stored.home_score)+"-"+String(stored.away_score),
        resultSource:stored.result_source??"客户库已核验赛果",
        resultVerifiedAt:stored.verified_at??null,
        top1Hit:primary===actual,coverageHit:primary===actual||secondary===actual,
        handicapResult:handicapActual
      };
    }).map(settlePublishedScoreTop4).map(settleTop5Handicap);

    rows=attachLiveScoreGoalsFromRecords(
      rows,
      Array.isArray(b.liveScoreGoals)?(b.liveScoreGoals as Record<string,unknown>[]):[]
    );

    const published=new Map<string,Record<string,unknown>>();
    for(const x of (Array.isArray(b.htftPublished)?(b.htftPublished as Record<string,unknown>[]):[]))
      published.set(String(x.match_no??"").padStart(3,"0"),x);
    const historical=new Map<string,Record<string,unknown>>();
    for(const x of (Array.isArray(b.htftHistorical)?(b.htftHistorical as Record<string,unknown>[]):[]))
      historical.set(String(x.match_no??"").padStart(3,"0"),x);

    rows=rows
      .map(r=>attachPublishedHTFTTop4(r,published,verifiedResults))
      .map(r=>attachHistoricalHTFTTop4(r,historical,verifiedResults));

    rows=attachLiveHTFTFromRecords(
      rows,
      Array.isArray(b.liveHtft)?(b.liveHtft as Record<string,unknown>[]):[],
      verifiedResults
    ).map(attachScoreGoalReference);

    const liveUnsettled=rows.some((r:Record<string,unknown>)=>r.resultVerified!==true&&r.matchStatus!=="POSTPONED");
    if(!vipActive&&liveUnsettled)rows=rows.map(redactLiveVipRisk);

    const handicapStats=buildHandicapStats(rows);
    const dataTimes=rows.map(r=>Date.parse(String(r.frozenAt??""))).filter(Number.isFinite);
    return reply({
      ok:true,view,date,count:rows.length,model:"索伦引擎",
      modelVersion,revision,batchTime:null,
      dataTime:dataTimes.length?new Date(Math.max(...dataTimes)).toISOString():null,
      pregameVerifiedCount:rows.filter(r=>r.pregameVerified===true).length,
      handicapStats,
      upsetStats:upsetStatsFor(rows),
      dailySelectionStats:dailySelectionStatsFor(rows),
      warningSync:{synced:0,readOnly:true,replayMode:"FAST_ARCHIVE_LIVE_RESULTS_V2"},
      updatedAt:new Date().toISOString(),
      rows,
    });
  }catch(error){
    console.error("FAST_ARCHIVE_BUNDLE_ERROR",error);
    return null;
  }
}


async function vipAccessStatus(userId:string){
  const {data:vip,error}=await db.from("soren_vip_members_v1")
    .select("vip_name,expires_at,active,source")
    .eq("user_id",userId).maybeSingle();
  if(error)throw error;
  const expiresMs=Date.parse(String(vip?.expires_at??""));
  const active=vip?.active===true&&Number.isFinite(expiresMs)&&expiresMs>Date.now();
  return {active,name:active?String(vip?.vip_name||"尊贵月卡VIP"):null,until:active?vip?.expires_at??null:null};
}
function fair3(h:unknown,d:unknown,a:unknown){
  const odds=[Number(h),Number(d),Number(a)];
  if(!odds.every(v=>Number.isFinite(v)&&v>1))return null;
  const inv=odds.map(v=>1/v),sum=inv.reduce((x,y)=>x+y,0);
  return inv.map(v=>Number((100*v/sum).toFixed(1)));
}
function cnResult(v:unknown){
  return ({H:"主胜",D:"平",A:"客胜","主胜":"主胜","平":"平","客胜":"客胜"} as Record<string,string>)[String(v??"")]??null;
}
async function paidMemberZone(
  date:string,
  runtimeRowsOverride:Record<string,unknown>[]|null=null,
  onlyNos:Set<string>|null=null
){
  let runtimeRows:Record<string,unknown>[];
  if(runtimeRowsOverride){
    runtimeRows=runtimeRowsOverride;
  }else{
    const upstreamData=await fetchPublicUpstream("today",date);
    const expectedRevision=allowed.get(String(upstreamData?.modelVersion??""));
    if(upstreamData?.ok!==true||!expectedRevision||upstreamData?.revision!==expectedRevision||!Array.isArray(upstreamData?.rows))
      throw new Error("VIP_RUNTIME_UPSTREAM_INVALID");

    const runtimeSource=(upstreamData.rows as Record<string,unknown>[])
      .filter((row)=>String(row?.version??"")===String(upstreamData.modelVersion??"")&&row?.no&&row?.kickoff);
    runtimeRows=await applySaleFreeze(runtimeSource,String(upstreamData.date??date),false);
    runtimeRows=await applyRiskFocusLayer(runtimeRows,String(upstreamData.date??date));
    runtimeRows=applyHighDrawRiskLayer(runtimeRows);
  }
  const runtimeByNo=new Map<string,any>(runtimeRows.map((r:any)=>[String(r.no??"").padStart(3,"0"),r]));

  let matchQuery:any=db.from("soren_matches")
    .select("id,pool_date,match_no,home_team,away_team,kickoff_at,league,is_world_cup")
    .eq("pool_date",date).eq("is_world_cup",false);
  if(onlyNos&&onlyNos.size)matchQuery=matchQuery.in("match_no",[...onlyNos]);
  const {data:matches,error:matchError}=await matchQuery.order("match_no",{ascending:true});
  if(matchError)throw matchError;
  const list=matches??[];
  if(!list.length)return {date,rows:[]};

  const ids=list.map((m:any)=>Number(m.id));
  const [{data:markets,error:marketError},{data:behaviors,error:behaviorError},{data:intelRows,error:intelError},{data:resultRows,error:resultError}]=await Promise.all([
    db.from("soren_market_snapshots")
      .select("match_id,source_code,market_type,snapshot_type,home_value,draw_value,away_value,line,home_water,away_water,payload,captured_at,data_quality")
      .in("match_id",ids)
      .in("source_code",["zucaijia_william","qiulaile_sp_mirror","zucaijia_asia4:1","zucaijia_asia4:11","zucaijia_asia4:18","zucaijia_asia4:31"])
      .in("market_type",["FT_1X2","HAD","HHAD","ASIAN_HANDICAP"])
      .order("captured_at",{ascending:false}).limit(6000),
    db.from("soren_market_behavior_v1")
      .select("match_id,match_no,okooo_match_id,exchange_scale,transaction_rows,index_rows,captured_at,kickoff_at,prematch_verified,source_quality")
      .eq("pool_date",date).in("match_id",ids).eq("prematch_verified",true).order("captured_at",{ascending:false}).limit(300),
    db.from("soren_intelligence_reports_v1")
      .select("match_id,source_code,source_url,headline,published_at,fetched_at,quality,highlights")
      .eq("pool_date",date).in("match_id",ids)
      .in("source_code",["okooo_public_intel","sina_xiaopao_attributed"])
      .in("quality",["okooo_public_prematch_observed","attributed_prematch_article_pair_verified"])
      .order("fetched_at",{ascending:false}).limit(300),
    db.from("soren_results")
      .select("match_id,home_score,away_score,ft_result,handicap_result,result_source,verified,verified_at")
      .in("match_id",ids)
  ]);
  if(marketError||behaviorError||intelError||resultError)throw marketError||behaviorError||intelError||resultError;

  const marketBy=new Map<string,any>(),officialBy=new Map<number,any>(),asiaBy=new Map<number,any[]>(),behaviorBy=new Map<number,any>(),intelBy=new Map<number,any[]>(),resultBy=new Map<number,any>();
  for(const r of resultRows??[])if(r.verified===true)resultBy.set(Number(r.match_id),r);
  const asiaSources=["zucaijia_asia4:1","zucaijia_asia4:11","zucaijia_asia4:18","zucaijia_asia4:31"];
  for(const m of list){
    const id=Number(m.id),kick=Date.parse(String(m.kickoff_at));
    const rt=runtimeByNo.get(String(m.match_no??"").padStart(3,"0"))??null;
    const cutoffCandidate=Date.parse(String(rt?.saleCutoffAt??""));
    const freezeBoundary=Number.isFinite(cutoffCandidate)&&cutoffCandidate<kick?cutoffCandidate:kick;
    const pre=(markets??[]).filter((q:any)=>Number(q.match_id)===id&&Date.parse(String(q.captured_at))<freezeBoundary);
    for(const typ of ["initial","current"]){
      const x=pre.find((q:any)=>q.source_code==="zucaijia_william"&&q.market_type==="FT_1X2"&&q.snapshot_type===typ);
      if(x)marketBy.set(id+"|"+typ,x);
    }
    const had=pre.find((q:any)=>q.source_code==="qiulaile_sp_mirror"&&q.market_type==="HAD"&&q.snapshot_type==="current")??null;
    const hhad=pre.find((q:any)=>q.source_code==="qiulaile_sp_mirror"&&q.market_type==="HHAD"&&q.snapshot_type==="current")??null;
    if(had||hhad)officialBy.set(id,{had,hhad});
    const asian=asiaSources.map((source)=>{
      const initial=pre.find((q:any)=>q.source_code===source&&q.market_type==="ASIAN_HANDICAP"&&q.snapshot_type==="initial")??null;
      const current=pre.find((q:any)=>q.source_code===source&&q.market_type==="ASIAN_HANDICAP"&&q.snapshot_type==="current")??null;
      const ref=current??initial;
      if(!ref)return null;
      const payload=(ref.payload&&typeof ref.payload==="object"?ref.payload:{}) as Record<string,any>;
      const initPayload=(initial?.payload&&typeof initial.payload==="object"?initial.payload:{}) as Record<string,any>;
      const curPayload=(current?.payload&&typeof current.payload==="object"?current.payload:{}) as Record<string,any>;
      const lineText=(x:any,p:Record<string,any>)=>p?.original_line??(Number.isFinite(Number(x?.line))?Number(x.line):null);
      return {
        source,
        institution:String(payload.institution_name??source),
        initialLine:lineText(initial,initPayload),
        currentLine:lineText(current,curPayload),
        initialHomeWater:Number.isFinite(Number(initial?.home_water))?Number(initial.home_water):null,
        initialAwayWater:Number.isFinite(Number(initial?.away_water))?Number(initial.away_water):null,
        currentHomeWater:Number.isFinite(Number(current?.home_water))?Number(current.home_water):null,
        currentAwayWater:Number.isFinite(Number(current?.away_water))?Number(current.away_water):null,
        capturedAt:current?.captured_at??initial?.captured_at??null
      };
    }).filter(Boolean);
    if(asian.length)asiaBy.set(id,asian as any[]);
    const b=(behaviors??[]).find((x:any)=>Number(x.match_id)===id&&x.prematch_verified===true&&Date.parse(String(x.captured_at))<freezeBoundary);
    if(b)behaviorBy.set(id,b);
    const intel=(intelRows??[]).filter((x:any)=>{
      const fetched=Date.parse(String(x.fetched_at));
      const published=Date.parse(String(x.published_at??x.fetched_at));
      return Number(x.match_id)===id&&Number.isFinite(fetched)&&Number.isFinite(published)&&fetched<freezeBoundary&&published<freezeBoundary;
    });
    if(intel.length)intelBy.set(id,intel);
  }

  const labels=["主胜","平","客胜"];
  const maxIndex=(arr:number[])=>arr.length?arr.indexOf(Math.max(...arr)):-1;
  const toNums=(rows:any[],key:string)=>Array.isArray(rows)?rows.map((x:any)=>Number(x?.[key])).map((v:number)=>Number.isFinite(v)?v:0):[0,0,0];

  const rows=list.map((m:any)=>{
    const id=Number(m.id),no=String(m.match_no).padStart(3,"0"),rt=runtimeByNo.get(no)??null;
    const ini=marketBy.get(id+"|initial"),cur=marketBy.get(id+"|current"),b=behaviorBy.get(id),intelRowsForMatch=intelBy.get(id)??[],intelRow=intelRowsForMatch.find((x:any)=>x.source_code==="okooo_public_intel")??intelRowsForMatch[0]??null,resultRow=resultBy.get(id)??null;
    const officialRaw=officialBy.get(id)??{},asianHandicap=asiaBy.get(id)??[];
    const initialFair=fair3(ini?.home_value,ini?.draw_value,ini?.away_value);
    const currentFair=fair3(cur?.home_value,cur?.draw_value,cur?.away_value);
    const marketTop=currentFair?labels[maxIndex(currentFair)]:null;
    const hadFair=fair3(officialRaw?.had?.home_value,officialRaw?.had?.draw_value,officialRaw?.had?.away_value);
    const officialTop=hadFair?labels[maxIndex(hadFair)]:null;
    const officialMarket={
      had:officialRaw?.had?{
        top1:officialTop,
        odds:[Number(officialRaw.had.home_value),Number(officialRaw.had.draw_value),Number(officialRaw.had.away_value)],
        fair:hadFair,capturedAt:officialRaw.had.captured_at
      }:null,
      hhad:officialRaw?.hhad?{
        line:Number.isFinite(Number(officialRaw.hhad.line))?Number(officialRaw.hhad.line):null,
        odds:[Number(officialRaw.hhad.home_value),Number(officialRaw.hhad.draw_value),Number(officialRaw.hhad.away_value)],
        capturedAt:officialRaw.hhad.captured_at
      }:null
    };

    const modelTop=rt?cnResult(rt.ftTop1):null;
    const secondTop=rt?cnResult(rt.second):null;
    const modelProb=rt&&[rt.homeProbability,rt.drawProbability,rt.awayProbability].every((v:any)=>Number.isFinite(Number(v)))
      ?[Number(rt.homeProbability),Number(rt.drawProbability),Number(rt.awayProbability)]:null;
    const mode=String(rt?.mode??"");
    const codes=Array.isArray(rt?.selectionCodes)?rt.selectionCodes.map((x:any)=>String(x)):[];
    const risk=(rt?.risk&&typeof rt.risk==="object"?rt.risk:{}) as Record<string,any>;
    const warning=(rt?.upsetWarning&&typeof rt.upsetWarning==="object"?rt.upsetWarning:{}) as Record<string,any>;
    const hur=String(risk?.hur??"");
    const dtr=String(risk?.dtr??"");
    const dlr=String(risk?.dlr??"");
    const riskLevel=String(warning?.riskLevel??"");
    const displayTier=String(warning?.displayTier??"");
    const officialHandicap=Number.isFinite(Number(rt?.officialHandicap))?Number(rt.officialHandicap):null;
    const handicapTop1=String(rt?.handicapTop1??rt?.handicap??"")||null;
    const handicapSecond=String(rt?.handicapSecond??"")||null;
    const handicapProb=Number.isFinite(Number(rt?.handicapProbability))?Number(rt.handicapProbability):null;
    const handicapSecondProb=Number.isFinite(Number(rt?.handicapSecondProbability))?Number(rt.handicapSecondProbability):null;

    let behavior:any=null,behaviorTop:string|null=null,behaviorStrength:string|null=null,drawSignal=false,overheat=false;
    if(b){
      const tr=Array.isArray(b.transaction_rows)?b.transaction_rows:[],ix=Array.isArray(b.index_rows)?b.index_rows:[];
      const doer=toNums(tr,"doerPct"),bfShare=toNums(ix,"bfShare"),jcShare=toNums(ix,"jcSavedShare"),
        avgProb=toNums(ix,"avgProb"),bfHot=toNums(ix,"bfHotCold"),jcHot=toNums(ix,"jcHotCold"),
        bfProfitIndex=toNums(ix,"bfProfitIndex"),jcProfitIndex=toNums(ix,"jcProfitIndex"),
        bfProfitLoss=toNums(tr,"bfProfitLoss"),jcProfitLoss=toNums(tr,"jcProfitLoss");

      const score=[0,0,0];
      const addTop=(arr:number[],w:number)=>{const k=maxIndex(arr);if(k>=0)score[k]+=w};
      addTop(avgProb,1);addTop(jcShare,2);addTop(doer,1);addTop(bfShare,b.exchange_scale==="较小"?1:2);
      const bfHotTop=maxIndex(bfHot),jcHotTop=maxIndex(jcHot);
      if(bfHotTop>=0&&bfHot[bfHotTop]>=15)score[bfHotTop]+=b.exchange_scale==="较小"?0.5:1;
      if(jcHotTop>=0&&jcHot[jcHotTop]>=15)score[jcHotTop]+=1;
      const rank=score.map((v:number,i:number)=>({i,v})).sort((a:any,c:any)=>c.v-a.v);
      behaviorTop=rank[0]?.v>0?labels[rank[0].i]:null;
      const margin=(rank[0]?.v??0)-(rank[1]?.v??0);
      behaviorStrength=margin>=3?"强":margin>=1.5?"中":"弱";
      drawSignal=(jcHot[1]>=25)||(bfHot[1]>=40)||(jcShare[1]-avgProb[1]>=8);

      const bi=behaviorTop?labels.indexOf(behaviorTop):-1;
      const highHeat=bi>=0&&doer[bi]>=75&&(bfShare[bi]>=75||jcShare[bi]>=75);
      const priceSupport=bi>=0&&initialFair&&currentFair?(currentFair[bi]-initialFair[bi]>=1.5):false;
      overheat=highHeat&&!priceSupport;

      behavior={
        source:"澳客交易盈亏",okoooMatchId:b.okooo_match_id,capturedAt:b.captured_at,scale:b.exchange_scale,
        top1:behaviorTop,strength:behaviorStrength,
        doerPct:doer,betfairShare:bfShare,jcSavedShare:jcShare,avgProbability:avgProb,
        betfairHotCold:bfHot,jcHotCold:jcHot,
        betfairProfitIndex:bfProfitIndex,jcProfitIndex,
        betfairProfitLoss:bfProfitLoss,jcProfitLoss,
        drawSignal,overheat
      };
    }

    let alignment:string|null=null,marketConfirm="待确认";
    if(modelTop&&marketTop&&behaviorTop){
      if(modelTop===marketTop&&modelTop===behaviorTop){alignment="三方同向";marketConfirm=overheat?"中":"强";}
      else if(modelTop===behaviorTop||modelTop===marketTop){alignment=modelTop===behaviorTop?"九十刻度×资金同向":"九十刻度×威廉同向";marketConfirm="中";}
      else {alignment="多方分歧";marketConfirm="弱";}
    }else if(behaviorTop&&marketTop){
      alignment=behaviorTop===marketTop?"赔率×资金同向":"赔率×资金分歧";
      marketConfirm=behaviorTop===marketTop?(behaviorStrength==="强"?"强":"中"):"弱";
    }else if(modelTop&&marketTop){
      alignment=modelTop===marketTop?"九十刻度×威廉同向":"九十刻度×威廉分歧";
      marketConfirm=modelTop===marketTop?"中":"弱";
    }

    const highDraw=rt?.highDrawRisk===true||rt?.high_draw_risk===true||
      String(rt?.highDrawRiskLevel??rt?.high_draw_risk_level??"")==="高";
    const drawProb=modelProb?Number(modelProb[1]):null;
    let drawRisk=highDraw?"高":"低";
    if(!highDraw){
      if((drawProb!==null&&drawProb>=30)||(drawSignal&&drawProb!==null&&drawProb>=27))drawRisk="高";
      else if(drawSignal||(drawProb!==null&&drawProb>=27))drawRisk="中";
    }

    // Prematch intelligence normalization: merge structured Okooo summaries with
    // verified Sina/Xiaopao headlines. Medium/high adverse news on the current FT
    // first-pick side may downgrade confidence, but never reverses a pick by itself.
    const primaryHighlights=(intelRow?.highlights&&typeof intelRow.highlights==="object"&&!Array.isArray(intelRow.highlights)?intelRow.highlights:{}) as Record<string,any>;
    const normalizedIntel:any[]=[];
    for(const ir of intelRowsForMatch){
      const hi=ir?.highlights;
      if(hi&&typeof hi==="object"&&!Array.isArray(hi)&&Array.isArray(hi.categories)){
        for(const raw of hi.categories){
          if(!raw)continue;
          normalizedIntel.push({
            side:String(raw.side??""),
            type:String(raw.type??"情报"),
            level:String(raw.level??"低"),
            impact:String(raw.impact??"中性"),
            summary:String(raw.summary??""),
            source:String(ir.source_code??"")
          });
        }
      }
      if(ir?.source_code==="sina_xiaopao_attributed"){
        const headline=String(ir.headline??"").trim();
        const adverse=/伤退|伤停|伤缺|缺席|缺阵|停赛|受伤|无法出战|无缘出战|多人缺席|多名重要球员缺席/.test(headline);
        if(adverse){
          const homeName=String(m.home_team??"").trim(),awayName=String(m.away_team??"").trim();
          if(homeName&&headline.includes(homeName))normalizedIntel.push({
            side:"主队",type:"伤停",level:"中",impact:"利空",summary:headline,source:"sina_xiaopao_attributed"
          });
          if(awayName&&headline.includes(awayName))normalizedIntel.push({
            side:"客队",type:"伤停",level:"中",impact:"利空",summary:headline,source:"sina_xiaopao_attributed"
          });
        }
      }
    }
    const seenIntel=new Set<string>();
    const intelCategories=normalizedIntel.filter((x:any)=>{
      const k=[x.side,x.type,x.level,x.impact,x.summary].join("|");
      if(seenIntel.has(k))return false;seenIntel.add(k);return true;
    });
    const top1Side=modelTop==="主胜"?"主队":modelTop==="客胜"?"客队":null;
    const intelAdverse=intelCategories.filter((x:any)=>
      x&&String(x.impact)==="利空"&&["中","高"].includes(String(x.level))&&
      top1Side!==null&&String(x.side)===top1Side
    );
    const intelligenceRisk=intelAdverse.length>0;
    const intelligenceRiskReasons=[...new Set(intelAdverse.map((x:any)=>String(x.summary??"")).filter(Boolean))].slice(0,3);
    const hasHomeAdverse=intelCategories.some((x:any)=>x.impact==="利空"&&["中","高"].includes(String(x.level))&&x.side==="主队");
    const hasAwayAdverse=intelCategories.some((x:any)=>x.impact==="利空"&&["中","高"].includes(String(x.level))&&x.side==="客队");
    const intelImpactSide=hasHomeAdverse&&hasAwayAdverse?"双方利空":hasHomeAdverse?"主队利空":hasAwayAdverse?"客队利空":String(primaryHighlights.impact_side??"中性");
    const intelImpactLevel=intelCategories.some((x:any)=>x.impact==="利空"&&String(x.level)==="高")?"高":
      intelCategories.some((x:any)=>x.impact==="利空"&&String(x.level)==="中")?"中":String(primaryHighlights.impact_level??"低");

    const doubleDirection=(()=>{
      if(codes.includes("H")&&codes.includes("D"))return "主队不败";
      if(codes.includes("A")&&codes.includes("D"))return "客队不败";
      if(codes.includes("H")&&codes.includes("A"))return "分胜负";
      if(modelTop==="主胜"&&secondTop==="平"||modelTop==="平"&&secondTop==="主胜")return "主队不败";
      if(modelTop==="客胜"&&secondTop==="平"||modelTop==="平"&&secondTop==="客胜")return "客队不败";
      if(modelTop&&secondTop&&modelTop!==secondTop)return modelTop+" + "+secondTop;
      return modelTop;
    })();
    const formalDirection=mode==="PASS"?"暂不发布":mode==="DOUBLE"?doubleDirection:modelTop;
    const riskOverride=(hur==="红"||riskLevel==="高"||displayTier==="强风险信号");
    const validHandicap=(v:any)=>["让胜","让平","让负"].includes(String(v??""));
    const frozenHandicapProtection=validHandicap(handicapTop1)
      ?(String(handicapTop1)+(validHandicap(handicapSecond)?(" + "+String(handicapSecond)):""))
      :null;
    const warningFocus=(warning?.focusGate&&typeof warning.focusGate==="object"?warning.focusGate:{}) as Record<string,any>;
    const ftOppositeSecond=(modelTop==="主胜"&&secondTop==="客胜")||(modelTop==="客胜"&&secondTop==="主胜");
    const warningOppositeSecond=warningFocus?.opposite_second===true||warningFocus?.oppositeSecond===true||
      warning?.oppositeSecond===true||ftOppositeSecond;
    const marketProtectionFirst=String(rt?.marketProtectionFirst??(officialHandicap!==null&&officialHandicap<0?"让负":officialHandicap!==null&&officialHandicap>0?"让胜":""));
    const marketProtectionSecond=String(rt?.marketProtectionSecond??"让平");
    const marketProtection=validHandicap(marketProtectionFirst)
      ?(marketProtectionFirst+(validHandicap(marketProtectionSecond)?(" + "+marketProtectionSecond):""))
      :null;

    // Customer-facing FT risk modules all reroute the main handling to handicap protection.
    // High-draw is the one special case: it is eligible only on official -1.
    const riskRoutes:{label:string;protection:string;priority:number}[]=[];
    if(highDraw&&officialHandicap===-1&&frozenHandicapProtection)
      riskRoutes.push({label:"高平风险",protection:frozenHandicapProtection,priority:1});
    if(rt?.marketDirectionAnomaly===true&&officialHandicap!==null&&Math.abs(officialHandicap)===1&&marketProtection)
      riskRoutes.push({label:"市场异动信号",protection:marketProtection,priority:3});
    if(displayTier==="重点风险"&&warningOppositeSecond&&frozenHandicapProtection)
      riskRoutes.push({label:"重点风险",protection:frozenHandicapProtection,priority:2});
    if(displayTier==="强风险信号"&&warningOppositeSecond&&frozenHandicapProtection)
      riskRoutes.push({label:"强风险信号",protection:frozenHandicapProtection,priority:4});
    const activeRiskRoute=riskRoutes.slice().sort((a,b)=>b.priority-a.priority)[0]??null;
    const triggeredRiskLabels=[...new Set(riskRoutes.map(x=>x.label))];

    let status="观察",summary="",conclusionType="市场观察",conclusionDirection=formalDirection??behaviorTop??marketTop??null;
    if(modelTop){
      conclusionType=mode==="PASS"?"风险处理":"九十刻度综合方向";
      if(activeRiskRoute){
        status="谨慎";
        conclusionType="风险转让球";
        conclusionDirection="让球保护 "+activeRiskRoute.protection;
        summary="胜平负触发"+triggeredRiskLabels.join("、")+"，主处理转入让球保护："+activeRiskRoute.protection+"。原始胜平负方向继续保留并独立核验。";
      }else if(mode==="PASS"){
        status="谨慎";
        conclusionDirection="不强化胜平负";
        const dqText=String(risk?.dq??"")==="DQ-C"?"赛前关键数据完整度不足":"胜平负方向存在风险分歧";
        summary=dqText+"，原始"+modelTop+"不做强化。当前保留概率和风险提示；让球数据仅作模型参考。";
      }else if(riskOverride&&mode==="DOUBLE"){
        status="谨慎";conclusionType="风险处理";
        conclusionDirection=formalDirection;
        summary="原始胜平负首选为"+modelTop+"，同时存在风险信号；当前按"+formalDirection+"保护。";
      }else if(alignment==="三方同向"){
        status=overheat?"谨慎":"强化";
        summary=overheat
          ?"九十刻度、威廉与资金行为方向一致，但热门程度偏高，赔率支撑不足，需防过热。"
          :"九十刻度、威廉与必发/竞彩资金行为三方同向，原方向获得额外市场确认。";
      }else if(alignment==="九十刻度×资金同向"){
        status="分歧";summary="九十刻度与资金行为同向，但威廉当前概率首位不同，降低确认等级。";
      }else if(alignment==="九十刻度×威廉同向"){
        status="分歧";summary="九十刻度与威廉方向一致，但必发/竞彩资金行为未同步，当前不做强化。";
      }else if(alignment==="多方分歧"){
        status="分歧";summary="九十刻度、赔率与资金行为未形成一致方向，本场保持谨慎。";
      }else{
        status=riskOverride?"谨慎":"稳定";
        summary="九十刻度赛前方向已核验；当前结合已有赔率与风险信息观察。";
      }
    }else if(behaviorTop&&marketTop){
      if(behaviorTop===marketTop){
        status="市场确认";summary="九十刻度方向待更新；当前威廉与必发/竞彩资金行为暂时同向于"+behaviorTop+"，仅作市场观察。";
      }else{
        status="分歧";summary="九十刻度方向待更新；当前威廉与必发/竞彩资金行为存在分歧，不提前替代模型结论。";
      }
    }else if(marketTop){
      status="市场观察";summary="九十刻度方向待更新；当前仅有赛前赔率结构，暂不形成综合方向。";
    }else summary="当前赛前数据仍在更新，暂不形成综合方向。";

    if(drawRisk==="高"&&!summary.includes("平局"))summary+=" 平局风险偏高。";
    else if(drawRisk==="中"&&!summary.includes("平局"))summary+=" 平局风险需留意。";

    if(intelligenceRisk){
      if(["强化","稳定","市场确认"].includes(status))status="谨慎";
      const adverseSide=modelTop==="主胜"?"主队":modelTop==="客胜"?"客队":"首选侧";
      const adverseLevel=intelAdverse.some((x:any)=>String(x.level)==="高")?"高":"中";
      const detail=intelligenceRiskReasons.length?("："+intelligenceRiskReasons.join("；")):"";
      summary+=` 赛前情报确认${adverseSide}存在${adverseLevel}等级利空${detail}。该信息与当前${modelTop}方向构成反向校验，已纳入风险降级，但不单独反转方向。`;
    }

    const fundBehavior=behavior
      ?(overheat?(behaviorTop??"热门方向")+"过热":
        drawSignal&&behaviorTop!=="平"?(behaviorTop??"资金")+"占优，平局资金偏热":
        (behaviorTop??"方向未定")+" · "+(behaviorStrength??"弱")+"确认")
      :"赛前资金快照未冻结";

    const intelligence=intelRowsForMatch.length?{
      source:intelRowsForMatch.length>1?"多源赛前情报":(intelRow?.source_code==="okooo_public_intel"?"澳客公开赛前情报":"新浪小炮赛前情报"),
      sourceUrl:intelRow?.source_url??null,
      fetchedAt:intelRowsForMatch.map((x:any)=>x.fetched_at).filter(Boolean).sort().slice(-1)[0]??null,
      impactSide:intelImpactSide,
      impactLevel:intelImpactLevel,
      categories:intelCategories.slice(0,8),
      riskActivated:intelligenceRisk,
      riskReasons:intelligenceRiskReasons,
      sources:[...new Set(intelRowsForMatch.map((x:any)=>String(x.source_code??"")).filter(Boolean))],
      formation:(primaryHighlights.formation&&typeof primaryHighlights.formation==="object")?primaryHighlights.formation:null,
      formationUrl:primaryHighlights.formation_url??null,
      note:"赛前多源情报归一化；中/高等级且明确利空当前首选一方时进入风险降级"
    }:null;
    const intelAlignment=(()=>{
      if(!intelligence||!modelTop)return "未参与";
      if(intelligence.impactSide==="主队利空"){
        if(modelTop==="客胜")return "支持";
        if(modelTop==="主胜")return "反向";
      }
      if(intelligence.impactSide==="客队利空"){
        if(modelTop==="主胜")return "支持";
        if(modelTop==="客胜")return "反向";
      }
      return "中性";
    })();
    if(intelligence)intelligence.alignment=intelAlignment;

    // VIP shadow upset-recognition layer. It separates "the original Top1 looks unsafe"
    // from "which alternative result has independent support". It never mutates the formal Top1.
    const topIdx=modelTop?labels.indexOf(modelTop):-1;
    const arrVal=(arr:any,idx:number)=>Array.isArray(arr)&&idx>=0&&Number.isFinite(Number(arr[idx]))?Number(arr[idx]):null;
    const topAvgProb=arrVal(behavior?.avgProbability,topIdx);
    const topBfShare=arrVal(behavior?.betfairShare,topIdx);
    const topJcShare=arrVal(behavior?.jcSavedShare,topIdx);
    const topBfHot=arrVal(behavior?.betfairHotCold,topIdx);
    const topJcHot=arrVal(behavior?.jcHotCold,topIdx);
    const topBfProfitIndex=arrVal(behavior?.betfairProfitIndex,topIdx);
    const topJcProfitIndex=arrVal(behavior?.jcProfitIndex,topIdx);
    const popularityGap=topAvgProb===null?null:Math.max(
      topBfShare===null?-999:topBfShare-topAvgProb,
      topJcShare===null?-999:topJcShare-topAvgProb
    );
    const topHeat=Math.max(topBfHot??-999,topJcHot??-999);
    const topProfitIndex=Math.min(topBfProfitIndex??999,topJcProfitIndex??999);
    const williamMove=(topIdx>=0&&initialFair&&currentFair)?Number(currentFair[topIdx])-Number(initialFair[topIdx]):null;
    const popularityDivergence=topIdx>=0&&popularityGap!==null&&popularityGap>=10&&!(williamMove!==null&&williamMove>=1.5);
    const fundAnomaly=topIdx>=0&&popularityGap!==null&&popularityGap>=5&&topHeat>=15&&topProfitIndex<=-15;
    const marketConflict=!!modelTop&&!!marketTop&&marketTop!==modelTop;
    const oddsAnomaly=rt?.marketDirectionAnomaly===true;
    const modelRiskSignal=hur==="红"||["重点风险","强风险信号"].includes(displayTier);
    const drawUpsetSignal=modelTop!=="平"&&(highDraw||drawRisk==="高");

    const coldEvidence:string[]=[];
    const coldDomains:string[]=[];
    if(intelligenceRisk){coldEvidence.push("首选方情报利空");coldDomains.push("intelligence");}
    if(popularityDivergence){
      coldEvidence.push("人气—市场背离"+(popularityGap!==null?(" +"+popularityGap.toFixed(1)+"pp"):""));
      coldDomains.push("market_behavior");
    }
    if(fundAnomaly){
      coldEvidence.push("必发盈亏结构异常");
      if(!coldDomains.includes("market_behavior"))coldDomains.push("market_behavior");
    }
    if(oddsAnomaly){coldEvidence.push("赔率市场异动");coldDomains.push("market_odds");}
    else if(marketConflict){coldEvidence.push("威廉方向与Top1分歧");coldDomains.push("market_odds");}
    if(modelRiskSignal){coldEvidence.push(displayTier==="强风险信号"?"强风险信号":"重点风险/HUR");coldDomains.push("risk_model");}
    if(drawUpsetSignal){coldEvidence.push("高平风险");coldDomains.push("draw_risk");}

    const strongBehavior=popularityGap!==null&&popularityGap>=15&&topProfitIndex<=-15;
    let coldLevel="低";
    if(coldDomains.length===1)coldLevel="留意";
    if(coldDomains.length===2)coldLevel="中";
    if(coldDomains.length>=3)coldLevel="高";
    if(intelligenceRisk&&strongBehavior)coldLevel="高";
    if(displayTier==="强风险信号"&&coldDomains.length>=2)coldLevel="高";

    const altScores=[0,0,0];
    const altReasons=[[] as string[],[] as string[],[] as string[]];
    const addAlt=(pick:any,score:number,reason:string)=>{
      const idx=labels.indexOf(String(pick??""));
      if(idx>=0&&idx!==topIdx){altScores[idx]+=score;altReasons[idx].push(reason);}
    };
    addAlt(secondTop,0.5,"九十刻度次选");
    addAlt(marketTop,1,"威廉");
    addAlt(officialTop,1,"体彩SP");
    addAlt(behaviorTop,1,"必发/竞彩资金");
    addAlt(warning?.alternativePick,1,"风险模块");
    if(drawUpsetSignal||drawSignal)addAlt("平",1,"平局风险");
    const altRank=altScores.map((v:number,i:number)=>({i,v})).filter((x:any)=>x.i!==topIdx).sort((a:any,b:any)=>b.v-a.v);
    const bestAlt=altRank[0]??null,secondAlt=altRank[1]??null;
    const coldDirection=bestAlt&&bestAlt.v>=2&&bestAlt.v-(secondAlt?.v??0)>=0.5?labels[bestAlt.i]:null;
    const coldDirectionSupport=coldDirection?altReasons[labels.indexOf(coldDirection)]:[];
    const coldAction=(coldLevel==="高"||coldLevel==="中")
      ?(coldDirection?("原Top1降级 · 防"+coldDirection):"原Top1降级 · 冷门方向待确认")
      :"原Top1保留";

    // Customer-facing VIP cold-upset gate:
    // publish only when the opposite side's unbeaten direction is explicit.
    // Soft warnings/heat alone stay internal and do not clutter the VIP page.
    const warningSignals=Array.isArray(warning?.marketSignals)?warning.marketSignals.map((x:any)=>String(x)):[];
    const asianRetreatSignal=warningSignals.some((x:string)=>/亚洲盘/.test(x)&&/退/.test(x));
    const verifiedBehaviorScale=String(b?.exchange_scale??"");
    const trustedBehaviorScale=["适中","较大"].includes(verifiedBehaviorScale);
    const hardMarketReverse=asianRetreatSignal&&(popularityDivergence||fundAnomaly);
    const hardRiskReverse=["重点风险","强风险信号"].includes(displayTier)&&fundAnomaly&&trustedBehaviorScale;
    const vipPublish=["主胜","客胜"].includes(String(modelTop))&&(
      (intelligenceRisk&&hardMarketReverse)||
      (hardRiskReverse&&(intelligenceRisk||marketConflict||oddsAnomaly))
    );
    const vipUnbeatenDirection=vipPublish
      ?(modelTop==="主胜"?"客队不败":"主队不败")
      :null;
    const vipReferenceIndices=modelTop==="主胜"?[1,2]:modelTop==="客胜"?[0,1]:[];
    const vipReferencePicks=vipReferenceIndices
      .map((idx:number)=>({pick:labels[idx],probability:modelProb?Number(modelProb[idx]):null}))
      .sort((a:any,b:any)=>(Number(b.probability)||0)-(Number(a.probability)||0));
    const vipEvidence:string[]=[];
    if(intelligenceRisk)vipEvidence.push("首选方重要利空");
    if(popularityDivergence)vipEvidence.push("人气过热");
    if(williamMove!==null&&williamMove<=-1.5)vipEvidence.push("William支持减弱");
    if(asianRetreatSignal)vipEvidence.push("亚盘退盘");
    if(["重点风险","强风险信号"].includes(displayTier))vipEvidence.push(displayTier);
    if(fundAnomaly)vipEvidence.push("资金结构异常");

    const coldRecognition={
      shadow:true,
      level:coldLevel,
      originalTop1:modelTop,
      direction:coldDirection,
      directionSupport:coldDirectionSupport,
      evidence:[...new Set(coldEvidence)],
      evidenceDomains:[...new Set(coldDomains)],
      action:coldAction,
      vipPublish,
      unbeatenDirection:vipUnbeatenDirection,
      referencePicks:vipReferencePicks,
      vipEvidence:[...new Set(vipEvidence)].slice(0,4),
      gate:{
        hardMarketReverse,
        hardRiskReverse,
        asianRetreatSignal,
        verifiedBehaviorScale:verifiedBehaviorScale||null,
        trustedBehaviorScale
      },
      popularity:{
        marketProbability:topAvgProb,
        betfairShare:topBfShare,
        sportterySavedShare:topJcShare,
        gap:popularityGap,
        heat:topHeat>-900?topHeat:null,
        profitIndex:topProfitIndex<900?topProfitIndex:null,
        williamProbabilityMove:williamMove,
        divergence:popularityDivergence,
        fundAnomaly
      }
    };

    const ftCode=String(resultRow?.ft_result??"").toUpperCase();
    const ftActual=({H:"主胜",D:"平",A:"客胜"} as Record<string,string>)[ftCode]??null;
    const handicapCode=String(resultRow?.handicap_result??"").toUpperCase();
    const handicapActual=({HWIN:"让胜",HDRAW:"让平",HLOSS:"让负","让胜":"让胜","让平":"让平","让负":"让负"} as Record<string,string>)[handicapCode]??null;
    let evaluation:{evaluable:boolean,hit:boolean|null,label:string,basis?:string}|null=null;
    let ftEvaluation:{evaluable:boolean,hit:boolean|null,label:string}|null=null;
    let handicapEvaluation:{evaluable:boolean,hit:boolean|null,label:string}|null=null;
    if(resultRow?.verified===true){
      if(mode==="DOUBLE"){
        const effectiveCodes=codes.length?codes:[
          ({主胜:"H",平:"D",客胜:"A"} as Record<string,string>)[modelTop]??"",
          ({主胜:"H",平:"D",客胜:"A"} as Record<string,string>)[secondTop]??""
        ].filter(Boolean);
        const hit=!!ftCode&&effectiveCodes.includes(ftCode);
        ftEvaluation={evaluable:true,hit,label:hit?"胜平负覆盖":"胜平负未覆盖"};
      }else if(modelTop){
        const code=({主胜:"H",平:"D",客胜:"A"} as Record<string,string>)[modelTop]??null;
        const hit=!!code&&code===ftCode;
        ftEvaluation={
          evaluable:true,
          hit,
          label:mode==="PASS"
            ?(hit?"原始胜平负首选命中":"原始胜平负首选未中")
            :(hit?"胜平负命中":"胜平负未中")
        };
      }else{
        ftEvaluation={evaluable:false,hit:null,label:"无有效胜平负预测"};
      }

      const hpicks=[handicapTop1,handicapSecond].filter((x:any)=>["让胜","让平","让负"].includes(String(x)));
      if(handicapActual&&hpicks.length){
        const hhit=hpicks.includes(handicapActual);
        handicapEvaluation={evaluable:true,hit:hhit,label:hhit?"让球命中":"让球未中"};
      }else{
        handicapEvaluation={evaluable:false,hit:null,label:"让球未形成有效评测"};
      }

      if(activeRiskRoute){
        const hit=handicapEvaluation?.hit===true;
        evaluation={evaluable:handicapEvaluation?.evaluable===true,hit:handicapEvaluation?.evaluable===true?hit:null,
          label:handicapEvaluation?.evaluable===true?(hit?"评测成功":"评测未覆盖"):"赛果已核验",basis:"让球保护"};
      }else if(mode!=="PASS"&&ftEvaluation?.evaluable===true){
        const hit=ftEvaluation.hit===true;
        evaluation={evaluable:true,hit,label:hit?"评测成功":"评测未覆盖",basis:"胜平负"};
      }else{
        evaluation={evaluable:false,hit:null,label:"赛果已核验",basis:mode==="PASS"?"PASS不计正式主评测":"无正式主结论"};
      }
    }
    const coldSettlement=resultRow?.verified===true&&modelTop&&ftActual?{
      upsetOccurred:ftActual!==modelTop,
      riskEvaluable:["中","高"].includes(coldLevel),
      riskHit:["中","高"].includes(coldLevel)?ftActual!==modelTop:null,
      directionEvaluable:!!coldDirection,
      directionHit:coldDirection?ftActual===coldDirection:null,
      vipDirectionEvaluable:vipPublish,
      vipDirectionHit:vipPublish?ftActual!==modelTop:null
    }:null;
    const settlement=resultRow?.verified===true?{
      verified:true,
      homeScore:Number(resultRow.home_score),
      awayScore:Number(resultRow.away_score),
      score:Number(resultRow.home_score)+" : "+Number(resultRow.away_score),
      ftResult:ftActual,
      handicapResult:handicapActual,
      source:resultRow.result_source??null,
      verifiedAt:resultRow.verified_at??null,
      evaluation,
      ftEvaluation,
      handicapEvaluation,
      coldRecognition:coldSettlement
    }:{
      verified:false,homeScore:null,awayScore:null,score:null,ftResult:null,handicapResult:null,source:null,verifiedAt:null,
      evaluation:null,ftEvaluation:null,handicapEvaluation:null,coldRecognition:null
    };

    const coverage={
      model:!!rt,
      william:!!(ini||cur),
      sporttery:!!(officialMarket.had||officialMarket.hhad),
      asian:Array.isArray(asianHandicap)&&asianHandicap.length>0,
      behavior:!!behavior,
      intelligence:!!intelligence
    };
    return {
      no,league:m.league??rt?.league??null,home:m.home_team,away:m.away_team,kickoff:m.kickoff_at,
      homeLogo:rt?.homeLogo??null,awayLogo:rt?.awayLogo??null,
      highDrawRisk:rt?.highDrawRisk===true,
      highDrawRiskReason:rt?.highDrawRiskReason??null,
      marketDirectionAnomaly:rt?.marketDirectionAnomaly===true,
      coldRecognition,
      riskRouting:{
        active:!!activeRiskRoute,
        triggered:triggeredRiskLabels,
        primary:activeRiskRoute?.label??null,
        protection:activeRiskRoute?.protection??null
      },
      status,summary,alignment,coverage,settlement,
      conclusion:{type:conclusionType,direction:conclusionDirection,marketConfirm,drawRisk,fundBehavior,
        intelligenceRisk,intelligenceImpactSide:intelImpactSide,intelligenceImpactLevel:intelImpactLevel},
      market:{institution:"威廉希尔",top1:marketTop,initialOdds:ini?[Number(ini.home_value),Number(ini.draw_value),Number(ini.away_value)]:null,
        currentOdds:cur?[Number(cur.home_value),Number(cur.draw_value),Number(cur.away_value)]:null,
        initialFair,currentFair,capturedAt:cur?.captured_at??ini?.captured_at??null},
      officialMarket,
      asianHandicap,
      behavior,
      intelligence,
      model:rt?{
        top1:modelTop,second:secondTop,probability:modelProb,
        confidence:Number.isFinite(Number(rt.confidence))?Number(rt.confidence):null,
        dq:String(risk?.dq??"")||null,mode:mode||null,tier:String(rt?.tier??"")||null,frozenAt:rt?.frozenAt??null,
        risk:{hur:hur||null,dtr:dtr||null,dlr:dlr||null,warning:riskLevel||null,displayTier:displayTier||null,
          marketSignals:Array.isArray(warning?.marketSignals)?warning.marketSignals:[]},
        handicap:{official:officialHandicap,top1:handicapTop1,second:handicapSecond,top1Probability:handicapProb,secondProbability:handicapSecondProb}
      }:null
    };
  });

  const vipRows=rows.filter((r:any)=>r?.coldRecognition?.vipPublish===true);
  const todayBjt=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"})
    .format(new Date()).split("/").join("-");
  if(date>="2026-09-28"&&date>=todayBjt&&vipRows.length){
    const payload=vipRows.map((r:any)=>({
      pool_date:date,
      match_no:String(r.no??"").padStart(3,"0"),
      lock_type:"VIP_COLD_WARNING",
      source:"MEMBER_ZONE_VIP_COLD",
      source_payload:{
        ruleVersion:"DAILY-COLD-EXCLUSION-v1.0-20260928",
        unbeatenDirection:r?.coldRecognition?.unbeatenDirection??null,
        evidence:Array.isArray(r?.coldRecognition?.vipEvidence)?r.coldRecognition.vipEvidence:[],
      }
    }));
    const {error:lockError}=await db.from("soren_daily_selection_locks_v1")
      .upsert(payload,{onConflict:"pool_date,match_no,lock_type",ignoreDuplicates:true});
    if(lockError)throw lockError;
  }
  return {
    date,
    title:"尊贵月卡VIP · 今日冷门识别",
    subtitle:"仅展示形成明确不败方向的高价值冷门候选",
    poolCount:rows.length,
    publishedCount:vipRows.length,
    rows:vipRows
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "GET" && req.method !== "POST") return reply({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
  if(req.method==="POST" && new URL(req.url).searchParams.get("action")!=="invite") return reply({ok:false,error:"METHOD_NOT_ALLOWED"},405);
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
      const requestedDate=requestUrl.searchParams.get("date");
      const historicalReplay=!!requestedDate&&/^2026-09-(14|15|16|17|18|19|20)$/.test(requestedDate);
      if(requestedDate&&!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate))return reply({ok:false,error:"VALID_DATE_REQUIRED"},400);
      if(historicalReplay){
        const replayUrl="https://tqlibowvnwfkaseqqvvp.supabase.co/functions/v1/hao-model-hourly-executor-v01?upset_replay=1&date="+encodeURIComponent(requestedDate!);
        const response=await fetch(replayUrl,{headers:{accept:"application/json"},signal:AbortSignal.timeout(45_000)});
        if(!response.ok)throw new Error("REPLAY_UPSTREAM_"+response.status);
        const data=await response.json();
        if(data?.ok!==true||data?.replay!==true||data?.read_only!==true||data?.resultFieldsUsed!==false||data?.hurDirectionUsed!==false||data?.historyRewrite!==false||!Array.isArray(data?.rows))throw new Error("REPLAY_VALIDATION_FAILED");
        const result=await syncUpsetWarnings(data.rows,data);
        return reply({ok:true,sync:"upset-warning-history",date:data.date,count:data.count,published:data.published,high:data.high,medium:data.medium,directionPublished:data.directionPublished,resultFieldsUsed:data.resultFieldsUsed,hurDirectionUsed:data.hurDirectionUsed,historyRewrite:data.historyRewrite,...result});
      }
      const upstreamUrl=upstream+"?public_hj38=1&view=today"+(requestedDate?"&date="+encodeURIComponent(requestedDate):"");
      const response=await fetch(upstreamUrl,{headers:{accept:"application/json"},signal:AbortSignal.timeout(10_000)});
      if(!response.ok)throw new Error("UPSTREAM_"+response.status);
      const data=await response.json();
      const expectedRevision=allowed.get(String(data?.modelVersion??""));
      if(data?.ok!==true||!expectedRevision||data?.revision!==expectedRevision||!Array.isArray(data?.rows))throw new Error("UPSTREAM_VALIDATION_FAILED");
      const syncDate=String(data.date??requestedDate??"");
      const layered=await applyRiskFocusLayer(data.rows as Record<string,unknown>[],syncDate);
      const result=await syncUpsetWarnings(layered,data);
      return reply({
        ok:true,sync:"upset-warning",date:syncDate,
        modelVersion:data.modelVersion??null,revision:data.revision??null,
        upsetStats:upsetStatsFor(layered),
        riskLayerVersion:"HJ38-RISK-LAYER-v1.2.6",
        ...result
      });
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
    return reply({ok:true,health:"upset-warning",revision:"HJ38-UPSET-v1.1.0",count:rows.length,high:rows.filter(r=>r.risk_level==="高").length,medium:rows.filter(r=>r.risk_level==="中").length,directionPublished:rows.filter(r=>!!r.warning_direction).length,resultFieldsUsed:rows.some(r=>r.result_fields_used===true),hurDirectionUsed:rows.some(r=>r.hur_direction_used===true),latestFrozenAt:rows.map(r=>r.source_frozen_at).filter(Boolean).sort().at(-1)??null});
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

    // Past archive pages are available to any authenticated account. Serve the
    // one-bundle path before trial/member RPCs so date switching is not delayed
    // by account bookkeeping. Current/future pages keep the original checks.
    const fastToday=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()).split("/").join("-");
    const fastDate=requestUrl.searchParams.get("date");
    if(requestUrl.searchParams.get("view")==="archive"&&fastDate&&/^\d{4}-\d{2}-\d{2}$/.test(fastDate)&&fastDate<fastToday&&fastDate>="2026-09-26"){
      let fastVip=false;
      try{fastVip=(await vipAccessStatus(String(user.id))).active===true}catch(e){console.error("FAST_ARCHIVE_VIP_CHECK_UNAVAILABLE",e)}
      const fastResponse=await serveFastArchiveBundle(fastDate,"archive",fastVip);
      if(fastResponse)return fastResponse;
    }

    // Store only pseudonymous hashes; the raw IP and browser UUID never enter the claims table.
    // IP is advisory only; a shared IP must not independently deny a trial.
    const browserId=req.headers.get("x-soren-device")??"";
    const ipForAudit=req.headers.get("cf-connecting-ip")||
      req.headers.get("x-real-ip")||
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()||"";
    const hashAudit=async(value:string,prefix:string)=>Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(prefix+value)))
    ).map(byte=>byte.toString(16).padStart(2,"0")).join("");
    let trialStatus="DEVICE_REQUIRED";
    try {
      const deviceHash=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(browserId)
        ?await hashAudit(browserId.toLowerCase(),"soren-welcome-device-v2:"):null;
      const ipHash=ipForAudit&&ipForAudit.length<=64
        ?await hashAudit(ipForAudit,"soren-welcome-ip-v2:"):null;
      const {data:claimResult,error:claimError}=await db.rpc("soren_welcome_claim_v2",{
        p_user:String(user.id),p_device_hash:deviceHash,p_ip_hash:ipHash,
      });
      if(claimError)throw claimError;
      trialStatus=String(claimResult??"CHECK_UNAVAILABLE");
    }catch(e){
      console.error("WELCOME_CLAIM_CHECK_UNAVAILABLE",e);
      trialStatus="CHECK_UNAVAILABLE";
    }
    // Enforce membership on the server before exposing current/future recommendations.
    let submittedInvite:string|null=null;
    const redeeming=req.method==="POST"&&requestUrl.searchParams.get("action")==="invite";
    if(redeeming){
      let payload:Record<string,unknown>;
      try{payload=await req.json()}catch{return reply({ok:false,error:"INVALID_JSON"},400)}
      submittedInvite=String(payload?.inviteCode??"").trim().toUpperCase();
      if(!/^[A-F0-9]{10}$/.test(submittedInvite))return reply({ok:false,error:"INVALID_INVITE_CODE"},400);
    }
    const {data:membership,error:membershipError}=await db.rpc("soren_member_status_v1",{
      p_user:String(user.id),p_invite_code:submittedInvite,
    });
    if(membershipError||!membership||typeof membership!=="object"){
      console.error("MEMBER_STATUS_UNAVAILABLE",membershipError);
      return reply({ok:false,error:"MEMBERSHIP_STATUS_UNAVAILABLE"},503);
    }
    (membership as Record<string,unknown>).trialStatus=trialStatus;
    let vipAccess:{active:boolean;name:string|null;until:any}={active:false,name:null,until:null};
    try{vipAccess=await vipAccessStatus(String(user.id));}
    catch(e){console.error("VIP_ACCESS_STATUS_UNAVAILABLE",e);}
    (membership as Record<string,unknown>).vipActive=vipAccess.active;
    (membership as Record<string,unknown>).vipName=vipAccess.name;
    (membership as Record<string,unknown>).vipUntil=vipAccess.until;
    (membership as Record<string,unknown>).paidActive=vipAccess.active;
    (membership as Record<string,unknown>).paidUntil=vipAccess.until;
    if(redeeming){
      const accepted=["BOUND","ALREADY_BOUND"].includes(String(membership.inviteStatus??""));
      return reply({ok:accepted,membership,error:accepted?null:String(membership.inviteStatus??"INVITE_UNAVAILABLE")},accepted?200:400);
    }
    if(requestUrl.searchParams.get("view")==="membership")return reply({ok:true,membership});
    const beijingToday=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()).split("/").join("-");
    const requestedDate=requestUrl.searchParams.get("date");
    const latestKnownPoolDate=async(candidate:string|null)=>{
      if(candidate&&/^\d{4}-\d{2}-\d{2}$/.test(candidate)){
        const {data:exact,error:exactError}=await db.from("soren_matches").select("pool_date").eq("pool_date",candidate).limit(1);
        if(exactError)throw exactError;
        if(Array.isArray(exact)&&exact.length)return candidate;
      }
      const {data:latest,error:latestError}=await db.from("soren_matches")
        .select("pool_date,source_status").lte("pool_date",beijingToday)
        .order("pool_date",{ascending:false}).limit(100);
      if(latestError)throw latestError;
      const active=(latest??[]).find((x:any)=>x?.source_status?.pool_status==="ACTIVE");
      return String(active?.pool_date??latest?.[0]?.pool_date??candidate??beijingToday);
    };
    if(requestUrl.searchParams.get("view")==="member-zone"){
      if(vipAccess.active!==true)return reply({ok:false,error:"VIP_MEMBERSHIP_REQUIRED",membership},403);
      try{
        const zoneDate=await latestKnownPoolDate(requestedDate);
        return reply({ok:true,membership,zone:await paidMemberZone(zoneDate),updatedAt:new Date().toISOString()});
      }
      catch(error){console.error("MEMBER_ZONE_ERROR",error);return reply({ok:false,error:"MEMBER_ZONE_UNAVAILABLE"},502);}
    }
    if(membership.active!==true&&(!requestedDate||requestedDate>=beijingToday))
      return reply({ok:false,error:"MEMBERSHIP_REQUIRED",membership},403);

    if(requestUrl.searchParams.get("view")==="market-trend"){
      const date=requestUrl.searchParams.get("date")??"";
      const no=requestUrl.searchParams.get("no")??"";
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^\d{3}$/.test(no))
        return reply({ok:false,error:"INVALID_TREND_ID"},400);
      if(vipAccess.active!==true)
        return reply({ok:false,error:"VIP_DEEP_DATA_REQUIRED",membership},403);
      try{
        const trend=await marketTrend(date,no);
        if(!trend)return reply({ok:false,error:"TREND_MATCH_NOT_FOUND"},404);
        return reply({ok:true,trend,updatedAt:new Date().toISOString()});
      }catch(error){console.error("TREND_READ_ERROR",error);return reply({ok:false,error:"TREND_UNAVAILABLE"},502);}
    }

    if(requestUrl.searchParams.get("view")==="report"){
      const date=requestUrl.searchParams.get("date")??"";
      const no=requestUrl.searchParams.get("no")??"";
      if(!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)||!/^[0-9]{3}$/.test(no))
        return reply({ok:false,error:"INVALID_REPORT_ID"},400);
      if(vipAccess.active!==true)
        return reply({ok:false,error:"VIP_DEEP_DATA_REQUIRED",membership},403);
      try{
        const report=await professionalReport(date,no);
        if(!report)return reply({ok:false,error:"REPORT_MATCH_NOT_FOUND"},404);
        return reply({ok:true,report,updatedAt:new Date().toISOString()});
      }catch(error){console.error("REPORT_ERROR",error);return reply({ok:false,error:"REPORT_UNAVAILABLE"},502);}
    }

    const url = requestUrl;
    const view = url.searchParams.get("view") ?? "today";
    let date = url.searchParams.get("date");
    if (!["today", "history", "archive"].includes(view)) return reply({ ok: false, error: "INVALID_VIEW" }, 400);
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return reply({ ok: false, error: "INVALID_DATE" }, 400);
    if(view==="archive"&&date&&date>=beijingToday){
      date=await latestKnownPoolDate(date);
    }

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
      let rows = view === "history" ? full.filter((r) => r.resultVerified) : full;
      if(date>="2026-09-19"&&date<="2026-09-24"){
        try{
          const [historic,verified]=await Promise.all([loadHistoricalHTFTTop4(date),loadVerifiedResults(date)]);
          rows=rows.map((r:Record<string,unknown>)=>attachHistoricalHTFTTop4(r,historic,verified));
        }catch(htftError){
          console.error("HISTORICAL_HTFT_UNAVAILABLE",htftError);
          rows=rows.map((r:Record<string,unknown>)=>({...r,htftTop4:null}));
        }
      }
      const handicapStats = buildHandicapStats(rows);
      const version = date === "2026-09-13" ? "3.2" : "3.3";
      const revision = date === "2026-09-13" ? "3.2-native-pass-v0.1.1-20260913" : "3.3-best-play-selector-v1.0-20260914";
      return reply({ok:true,view,date,count:rows.length,model:"索伦引擎",modelVersion:version,revision,batchTime:null,dataTime:full.at(-1)?.frozenAt??null,pregameVerifiedCount:rows.length,handicapStats,upsetStats:upsetStatsFor(rows),updatedAt:new Date().toISOString(),rows:rows.map(attachScoreGoalReference)});
    }
    // Locked past pools can serve frozen pre-match analysis directly while still
    // overlaying verified results on every request. This keeps yesterday's unfinished
    // fixtures live without rebuilding the full analysis stack for the whole day.
    const fastLockedArchive=view==="archive"&&!!date&&date<beijingToday&&date>="2026-09-23";
    if(fastLockedArchive){
      try{
        const {data:fastRows,error:fastError}=await db.rpc("soren_fast_locked_archive_rows_v1",{p_date:date});
        if(fastError)throw fastError;
        if(Array.isArray(fastRows)&&fastRows.length){
          const modelVersion=String((fastRows as Record<string,unknown>[]).find(r=>r.version)?.version??"");
          const revision=allowed.get(modelVersion);
          if(revision){
            const databaseResults=await loadVerifiedResults(date);
            const pick=(v:unknown)=>({"主胜":"H","平":"D","客胜":"A","3":"H","1":"D","0":"A",H:"H",D:"D",A:"A"}[String(v??"")]??null);
            let rows=(fastRows as Record<string,unknown>[]).map(row=>{
              const no=String(row.no??"").padStart(3,"0");
              const stored=databaseResults.get(no);
              if(!stored){
                if(date==="2026-09-26"&&no==="019"){
                  return {...row,resultVerified:false,result:null,resultHome:null,resultAway:null,resultScore:null,
                    resultSource:"MLS官方延期公告",resultVerifiedAt:null,top1Hit:null,coverageHit:null,handicapResult:null,
                    handicapTop1Hit:null,handicapCoverageHit:null,handicapHit:null,
                    matchStatus:"POSTPONED",resultStatus:"赛事延期"};
                }
                return {...row,resultVerified:false,result:null,resultHome:null,resultAway:null,resultScore:null,
                  resultSource:null,resultVerifiedAt:null,top1Hit:null,coverageHit:null,handicapResult:null,
                  handicapTop1Hit:null,handicapCoverageHit:null,handicapHit:null};
              }
              const actual=String(stored.ft_result??"");
              const primary=pick(row.ftTop1),secondary=pick(row.second);
              const handicapActual=handicapName[String(stored.handicap_result??"")]??null;
              return {...row,
                resultVerified:true,result:actual,
                resultHome:Number(stored.home_score),resultAway:Number(stored.away_score),
                resultScore:String(stored.home_score)+"-"+String(stored.away_score),
                resultSource:stored.result_source??"客户库已核验赛果",
                resultVerifiedAt:stored.verified_at??null,
                top1Hit:primary===actual,coverageHit:primary===actual||secondary===actual,
                handicapResult:handicapActual
              };
            }).map(settlePublishedScoreTop4).map(settleTop5Handicap).map(attachScoreGoalReference);

            // Daily selection is the only customer-facing layer not embedded in the prematch snapshots.
            // Rebuild just this thin layer; do not rerun the full risk/model pipeline.
            rows=applyHighDrawRiskLayer(rows);
            rows=await attachDailySupplementLayer(rows,date);

            try{
              const [htftPublished,historicalHTFT]=await Promise.all([
                loadPublishedHTFTTop4(date),
                loadHistoricalHTFTTop4(date),
              ]);
              rows=rows
                .map((r:Record<string,unknown>)=>attachPublishedHTFTTop4(r,htftPublished,databaseResults))
                .map((r:Record<string,unknown>)=>attachHistoricalHTFTTop4(r,historicalHTFT,databaseResults));
              rows=await attachLiveHTFT(rows,date,databaseResults);
            }catch(htftError){
              console.error("FAST_ARCHIVE_HTFT_UNAVAILABLE",htftError);
            }

            const liveUnsettled=rows.some((r:Record<string,unknown>)=>r.resultVerified!==true&&r.matchStatus!=="POSTPONED");
            if(vipAccess.active!==true&&liveUnsettled)rows=rows.map(redactLiveVipRisk);
            const handicapStats=buildHandicapStats(rows);
            const dataTimes=rows.map(r=>Date.parse(String(r.frozenAt??""))).filter(Number.isFinite);
            return reply({
              ok:true,view,date,count:rows.length,model:"索伦引擎",
              modelVersion,revision,batchTime:null,
              dataTime:dataTimes.length?new Date(Math.max(...dataTimes)).toISOString():null,
              pregameVerifiedCount:rows.filter(r=>r.pregameVerified===true).length,
              handicapStats,
              upsetStats:upsetStatsFor(rows),
              dailySelectionStats:dailySelectionStatsFor(rows),
              warningSync:{synced:0,readOnly:true,replayMode:"LOCKED_ARCHIVE_LIVE_RESULTS"},
              updatedAt:new Date().toISOString(),
              rows,
            });
          }
        }
      }catch(fastArchiveError){
        console.error("FAST_LOCKED_ARCHIVE_FALLBACK",fastArchiveError);
      }
    }

    // Fully settled fallback path retained for dates that do not yet have complete fast snapshots.
    const archiveReadOnly=view==="archive"&&!!date&&date<beijingToday&&date>="2026-09-23"&&await archiveDayFullySettled(date);
    let data:any=null;
    if(archiveReadOnly){
      const {data:freezeRows,error:freezeError}=await db.from("soren_sale_freezes_v1")
        .select("match_no,snapshot,source_frozen_at").eq("pool_date",date).order("match_no",{ascending:true});
      if(freezeError)throw new Error("ARCHIVE_FREEZE_READ_UNAVAILABLE:"+String(freezeError.message));
      const frozenRows=(freezeRows??[])
        .map((x:Record<string,unknown>)=>x.snapshot)
        .filter((x:unknown)=>x&&typeof x==="object"&&!Array.isArray(x)) as Record<string,unknown>[];
      const modelVersion=String(frozenRows.find(r=>r.version)?.version??"");
      const expectedRevision=allowed.get(modelVersion);
      if(frozenRows.length&&expectedRevision){
        const sourceTimes=(freezeRows??[]).map((x:Record<string,unknown>)=>Date.parse(String(x.source_frozen_at??""))).filter(Number.isFinite);
        data={ok:true,date,rows:frozenRows,modelVersion,revision:expectedRevision,batchTime:null,
          dataTime:sourceTimes.length?new Date(Math.max(...sourceTimes)).toISOString():null};
      }
    }
    if(!data)data=await fetchPublicUpstream(view,date);

    const verifiedResults: Record<string, Record<string, { result: string; score: string; source: string }>> = {
      "2026-09-17": {
        "001": { result: "D", score: "1-1", source: "https://www.sportschau.de/live-und-ergebnisse/fussball/ma12416761/usbekistan_china/fifa-freundschaft-frauen/se105569/2026/ro330517/oktober/ma12416761/spiel-spiele-und-ergebnisse" },
        "002": { result: "H", score: "2-1", source: "https://www.the-afc.com/en/club/afc_champions_league_two.html/news/group-g-shanghai-shenhua-fc-chn-2-1-tampines-rovers-fc-sgp" }
      }
    };
    const databaseResults=await loadVerifiedResults(String(data.date ?? date ?? ""));
    const sourceRows = data.rows.filter((row: Record<string, unknown>) =>
      row?.version === data.modelVersion && row?.no && row?.kickoff
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
        return { ...row, resultVerified: false, result: null, matchStatus: "POSTPONED", resultStatus: "赛事延期", resultSource: "https://www.athletic-club.eus/en/news/2026/09/16/the-match-between-levante-ud-and-athletic-club-on-matchday-6-of-laliga-has-been-postponed/" };
      }
      if (day === "2026-09-26" && no === "019") {
        return { ...row, resultVerified: false, result: null, matchStatus: "POSTPONED", resultStatus: "赛事延期", resultSource: "MLS官方延期公告" };
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
    let rows = (await applySaleFreeze(sourceRows.map((row: Record<string,unknown>) => settlePublishedScoreTop4(attachDayEnvironment(attachTeamLogos(attachHistoricalScoreTop4(attachUpsetWarning(attachTeamFormH2h(attachTeamSchedule(attachGoalFormReference(attachGoalPrediction(applyHandicapBackfill(row,handicapBackfill),goalPredictions),goalFormReferences),teamSchedules),teamFormH2h),upsetWarnings),historicalScores),teamLogos),dayEnvironment))),dynamicDate,archiveReadOnly)).map(settleTop5Handicap);
    rows=await applyRiskFocusLayer(rows,dynamicDate);
    rows=applyHighDrawRiskLayer(rows);
    rows=await attachDailySupplementLayer(rows,dynamicDate);
    rows=await attachLiveScoreGoals(rows,dynamicDate);
        try {
      // Safe to invoke repeatedly: the producer inserts only future fixtures and never overwrites.
      if(!archiveReadOnly&&dynamicDate>="2026-09-25"){
        const {error:publishError}=await db.rpc("soren_publish_htft_top4_v1");
        if(publishError)throw publishError;
      }
      if(dynamicDate>="2026-09-19"&&dynamicDate<="2026-09-24"){
        const historicalHTFT=await loadHistoricalHTFTTop4(dynamicDate);
        rows=rows.map((r:Record<string,unknown>)=>attachHistoricalHTFTTop4(r,historicalHTFT,databaseResults));
      }else{
        const [htftPublished,historicalHTFT]=await Promise.all([
          loadPublishedHTFTTop4(dynamicDate),
          loadHistoricalHTFTTop4(dynamicDate),
        ]);
        rows=rows
          .map((r:Record<string,unknown>)=>attachPublishedHTFTTop4(r,htftPublished,databaseResults))
          .map((r:Record<string,unknown>)=>attachHistoricalHTFTTop4(r,historicalHTFT,databaseResults));
      }
    } catch(htftError){
      console.error("HTFT_TOP4_UNAVAILABLE",htftError);
      rows=rows.map((r:Record<string,unknown>)=>({...r,htftTop4:null}));
    }
    rows=await attachLiveHTFT(rows,dynamicDate,databaseResults);
    const liveUnsettled=rows.some((r:Record<string,unknown>)=>r.resultVerified!==true&&r.matchStatus!=="POSTPONED");
    if(vipAccess.active!==true&&liveUnsettled)rows=rows.map(redactLiveVipRisk);
    const handicapStats = buildHandicapStats(rows);
    const riskHistoricalReplay=dynamicDate>="2026-09-20"&&dynamicDate<"2026-09-26";
    const warningSync=archiveReadOnly
      ?{synced:0,readOnly:true,replayMode:"ARCHIVE_READ_ONLY"}
      :riskHistoricalReplay
        ?{synced:0,readOnly:true,replayMode:"STRICT_PREMATCH_LAYER_REPLAY"}
        :await syncUpsetWarnings(rows,data);
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
      dailySelectionStats: dailySelectionStatsFor(rows),
      warningSync,
      updatedAt: new Date().toISOString(),
      rows: rows.map(attachScoreGoalReference),
    });
  } catch (error) {
    console.error(error);
    return reply({ ok: false, error: "PUBLIC_API_UPSTREAM_ERROR", rows: [] }, 502);
  }
});
