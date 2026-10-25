import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {createClient} from "npm:@supabase/supabase-js@2.95.0";
const sb=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false,autoRefreshToken:false}});
const db=sb.schema("ninety_core");
const reply=(data:any,status=200)=>Response.json(data,{status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
const n=(v:any)=>v===null||v===undefined||v===""?null:(Number.isFinite(Number(v))?Number(v):null);
const numOdds=(x:any)=>[n(x?.home_value),n(x?.draw_value),n(x?.away_value)];
const fair=(o:any[])=>o.length===3&&o.every(x=>x!==null&&x>1&&x<1000)?(()=>{const inv=o.map(x=>1/x),s=inv.reduce((a,b)=>a+b,0);return inv.map(v=>100*v/s)})():null;
const idx=(d:string)=>d==="H"?0:d==="D"?1:d==="A"?2:-1;
const dateBjt=()=>new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
const earliest=(m:any,now:number)=>{const dow=new Date(String(m.pool_date)+"T12:00:00+08:00").getUTCDay();
 const sale=Date.parse(String(m.pool_date)+"T"+([0,6].includes(dow)?"23":"22")+":00:00+08:00");
 return Math.min(Date.parse(String(m.kickoff_at)),m.cutoff_at?Date.parse(String(m.cutoff_at)):Infinity,sale)};
function lineNum(v:any):number|null{if(v===null||v===undefined)return null;let s=String(v).trim().replace(/[−﹣]/g,"-");
 if(/^[-+]?\d+(?:\.\d+)?$/.test(s))return Number(s);
 const a=s.match(/^(-?)(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
 if(!a)return null;const p=Number(a[2]),q=Number(a[3]);return Math.abs(p-q)<=.500001?(a[1]==="-"?-1:1)*(p+q)/2:null}
function validSource(cap:any,ing:any,quality:any,expected:string,boundary:number,kickoff:number){let a=Date.parse(String(cap||"")),b=Date.parse(String(ing||""));return String(quality)===expected&&Number.isFinite(a)&&Number.isFinite(b)&&a<=boundary&&b<=boundary&&a<kickoff&&b<kickoff}
Deno.serve(async req=>{
 if(req.method!=="POST")return reply({ok:false,error:"METHOD_NOT_ALLOWED"},405);
 const token=req.headers.get("x-ninety-collector-token")||"";
 if(token.length<32)return reply({ok:false,error:"UNAUTHORIZED"},401);
 const test=await db.rpc("soren_collector_token_valid_v1",{p_token:token});
 if(test.error||test.data!==true)return reply({ok:false,error:"UNAUTHORIZED"},401);
 try{
  const body=await req.json().catch(()=>({})),date=String(body.date||dateBjt());
  if(!/^20\d\d-\d\d-\d\d$/.test(date)||date!==dateBjt())return reply({ok:false,error:"CURRENT_DAY_ONLY"},400);
  const {data:pending,error:pe}=await db.from("soren_daily_selection_candidate_audit_v1")
    .select("pool_date,match_no,match_id,model_top1,model_frozen_at,confidence_pct,institution_top1,funds_top1,funds_share_pct,william_top1_odds,william_rank,permanent_risk_lock,high_draw_risk,market_direction_anomaly,v1_candidate,v2_decision,publication_status,verified_inputs")
    .eq("pool_date",date).eq("publication_status","PENDING_VIP_COLD_REVIEW").limit(20);
  if(pe)throw pe;
  if(!pending?.length)return reply({ok:true,checked:0,reason:"NO_PENDING_CANDIDATES",customerPublished:0});
  const ids=pending.map(x=>x.match_id);
  const [mq,pq,wq,bq,eq]=await Promise.all([
    db.from("soren_matches").select("id,pool_date,match_no,home_team,away_team,kickoff_at,cutoff_at,official_handicap").in("id",ids),
    db.from("soren_predictions").select("id,run_id,match_id,ft_top1,primary_reason,frozen_at,source_snapshot").in("match_id",ids).order("frozen_at",{ascending:false}).limit(50),
    db.from("soren_market_snapshots").select("id,match_id,source_code,market_type,snapshot_type,home_value,draw_value,away_value,line,home_water,away_water,payload,captured_at,ingested_at,data_quality")
      .in("match_id",ids).order("captured_at",{ascending:false}).limit(400),
    db.from("soren_market_behavior_v1").select("match_id,captured_at,index_rows,exchange_scale,prematch_verified,source_quality").in("match_id",ids).order("captured_at",{ascending:false}).limit(50),
    db.rpc("soren_cold_e_inputs_v1",{p_date:date})
  ]);
  for(const r of [mq,pq,wq,bq,eq])if(r.error)throw r.error;

  // A gate can only certify a real Soren formal run, never the Singapore HJ
  // placeholder that was populated before the original rule chain was restored.
  const runIds=[...new Set((pq.data||[]).map((x:any)=>Number(x.run_id)).filter(Number.isInteger))];
  const [runq,iq,rq,lq,archiveQ]=await Promise.all([
    db.from("soren_runs").select("id,run_type,status,data_complete,formal_allowed,no_result_leakage,freeze_at").in("id",runIds),
    db.from("soren_intelligence_reports_v1").select("match_id,quality,source_code,source_url,headline,highlights,published_at,fetched_at")
      .eq("pool_date",date).in("match_id",ids).order("fetched_at",{ascending:false}).limit(100),
    db.from("soren_upset_warnings_v1").select("match_no,source_frozen_at,source_payload,risk_score,warning_direction,result_fields_used")
      .eq("pool_date",date).order("source_frozen_at",{ascending:false}).limit(300),
    db.from("soren_daily_selection_locks_v1").select("match_no,lock_type").eq("pool_date",date),
    // Authentic original pregame HJ intelligence saved in Singapore as an
    // isolated provenance-checked copy, not invented or outcome-backed news.
    db.from("soren_deep_market_snapshot_v1")
      .select("match_id,match_no,home_team,away_team,kickoff_at,captured_at,timing_quality,intel_status,analysis")
      .eq("pool_date",date).in("match_id",ids)
      .order("captured_at",{ascending:false}).limit(60)
  ]);
  for(const v of [runq,iq,rq,lq,archiveQ])if(v.error)throw v.error;
  const [hq]=await Promise.all([
    db.from("hao_console_predictions").select("id,run_id,match_no,home_team,away_team,kickoff_bjt,top1,model_version,frozen_at,pool_date")
      .eq("pool_date",date).order("updated_at",{ascending:false}).limit(500)
  ]);
  if(hq.error)throw hq.error;
  const hjRunIds=[...new Set((hq.data||[]).map((x:any)=>Number(x.run_id)).filter(Number.isInteger))];
  const hjr=await db.from("hao_console_model_runs").select("id,formal_allowed,data_complete").in("id",hjRunIds);
  if(hjr.error)throw hjr.error;
  const hjRuns=new Set((hjr.data||[]).filter((x:any)=>x.formal_allowed===true&&x.data_complete===true).map((x:any)=>Number(x.id)));
  const hjById=new Map((hq.data||[]).map((x:any)=>[Number(x.id),x]));
  const runs=new Map((runq.data||[]).map((x:any)=>[Number(x.id),x]));
  const locked=new Set((lq.data||[]).map((x:any)=>String(x.match_no||"").padStart(3,"0")));
  const riskBy=new Map<string,any>();
  for(const r of rq.data||[]){const no=String(r.match_no||"").padStart(3,"0");if(!riskBy.has(no))riskBy.set(no,r);}
  const matches=new Map((mq.data||[]).map((x:any)=>[x.id,x])),eo=new Map((eq.data||[]).map((x:any)=>[x.match_id,x]));
  const now=Date.now();const outcomes=[];
  for(const item of pending){

   const m:any=matches.get(item.match_id);
   const candidates=(pq.data||[]).filter((x:any)=>x.match_id===item.match_id);
   const original:any=candidates.find((x:any)=>{
     const run:any=runs.get(Number(x.run_id));
     return x.primary_reason!=="SG_LOCAL_HJ38_VERIFIED"&&run&&run.status==="COMPLETE"&&
       run.run_type==="FORMAL"&&run.formal_allowed===true&&run.data_complete===true&&
       run.no_result_leakage===true&&
       Math.abs(Date.parse(String(x.frozen_at))-Date.parse(String(run.freeze_at)))<1000&&
       x.source_snapshot?.pregameVerified===true;
   });
   const local:any=!original?candidates.find((x:any)=>{
     const hj:any=hjById.get(Number(x.source_snapshot?.sync_mother_id));
     return x.primary_reason==="SG_LOCAL_HJ38_VERIFIED"&&
       x.source_snapshot?.pregameVerified===true&&x.source_snapshot?.sync_source==="sg_local_hj38_forward_v1"&&
       hj&&hjRuns.has(Number(hj.run_id))&&hj.model_version==="3.8"&&
       hj.pool_date===date&&hj.match_no===item.match_no&&
       hj.home_team===m?.home_team&&hj.away_team===m?.away_team&&
       Date.parse(String(hj.kickoff_bjt))===Date.parse(String(m?.kickoff_at))&&
       Math.abs(Date.parse(String(x.frozen_at))-Date.parse(String(hj.frozen_at)))<1000&&
       (hj.top1==="主胜"?"H":hj.top1==="客胜"?"A":"D")===x.ft_top1;
   }):null;
   const p:any=original||local;
   const origin=original?"ORIGINAL_SOREN":"SG_FORMAL_HJ38_ADAPTED";
   const sourceHjRun:any=local?hjById.get(Number(local.source_snapshot?.sync_mother_id))?.run_id:null;
   if(!m||!p||!["H","A"].includes(p.ft_top1)||p.ft_top1!==item.model_top1)continue;
   const top=idx(p.ft_top1),kickoff=Date.parse(String(m.kickoff_at)),cut=earliest(m,now);

   if(!(Number.isFinite(kickoff)&&now<kickoff&&now<cut-10*60000&&Date.parse(p.frozen_at)<kickoff))continue;
   const quotes=(wq.data||[]).filter((x:any)=>x.match_id===m.id&&
     validSource(x.captured_at,x.ingested_at,x.data_quality,x.source_code==="qiulaile_sp_mirror"?"verified_mirror":"verified",cut,kickoff));
   const market=(type:string)=>quotes.filter((x:any)=>x.source_code==="zucaijia_william"&&x.market_type==="FT_1X2"&&x.snapshot_type===type)[0]||null;
   const ini=market("initial"),cur=market("current");
   const wi=fair(numOdds(ini)),wc=fair(numOdds(cur));
   const b=(bq.data||[]).find((x:any)=>x.match_id===m.id&&x.prematch_verified===true&&
     Date.parse(String(x.captured_at))<=cut&&Date.parse(String(x.captured_at))<kickoff);
   const ix=b?.index_rows||[];
   const raw=ix.length===3?ix.map((x:any)=>n(x?.bfShare)):[];
   const bfValid=raw.length===3&&raw.every((v:any)=>v!==null&&v>=0&&v<=100)&&
     Math.abs(raw.reduce((a:number,v:number)=>a+v,0)-100)<=1&&
     ix[0]?.team===m.home_team&&ix[1]?.team==="平局"&&ix[2]?.team===m.away_team;
   const bfPick=bfValid?raw.indexOf(Math.max(...raw)):-1;
   const delta=wi&&wc?wc[top]-wi[top]:null;
   const a=bfValid&&bfPick!==top&&(bfPick===0||bfPick===2);
   const bb=bfValid&&bfPick===1&&["适中","较大"].includes(String(b.exchange_scale));
   const cc=bfValid&&wi!==null&&wc!==null&&bfPick!==top&&delta!==null&&delta<=-7;
   let firms:string[]=[];const rising=!!ini&&!!cur&&Number(numOdds(cur)[top])>Number(numOdds(ini)[top])+0.000001;
   for(const code of ["1","11","18","31"]){
     const s=quotes.filter((x:any)=>x.source_code==="zucaijia_asia4:"+code&&x.market_type==="ASIAN_HANDICAP");
     const i=s.find((x:any)=>x.snapshot_type==="initial"),u=s.find((x:any)=>x.snapshot_type==="current");
     if(!i||!u)continue;const l0=lineNum(i.payload?.original_line??i.line),l1=lineNum(u.payload?.original_line??u.line);
     const w0=n(top===0?i.home_water:i.away_water),w1=n(top===0?u.home_water:u.away_water);
     if(l0===null||l1===null||w0===null||w1===null||w0<=0)continue;
     if((top===0?l1-l0:l0-l1)>=.249999&&w1>=1)firms.push(code)
   }
   const dd=rising&&firms.length>=2;
   const e:any=eo.get(m.id),valid=(prefix:string,quality:string)=>validSource(e?.[prefix+"_captured_at"],e?.[prefix+"_ingested_at"],e?.[prefix+"_quality"],quality,cut,kickoff);
   const esp=valid("sp","verified_mirror"),escore=valid("score","STRICT_PREMATCH_XG")&&e?.score_strict==="true"&&e?.score_target_result_used==="false";
   const ewi=valid("william_initial","verified"),ewc=valid("william_current","verified");
   const spFair=esp?fair([n(e.sp_home),n(e.sp_draw),n(e.sp_away)]):null;
   const ei=ewi?fair([n(e.william_initial_home),n(e.william_initial_draw),n(e.william_initial_away)]):null;
   const ec=ewc?fair([n(e.william_current_home),n(e.william_current_draw),n(e.william_current_away)]):null;
   const scoreDraw=n(e?.score_draw);
   const e1=!!spFair&&spFair[1]>=28&&escore&&scoreDraw!==null&&scoreDraw>=0&&scoreDraw<=1&&scoreDraw*100>=30;
   const e2=!!spFair&&spFair[1]>=28&&!!ei&&!!ec&&(ec[1]-ei[1]>=1);
   const triggers=[a?"A":null,bb?"B":null,cc?"C":null,dd?"D":null,e1?"E1":null,e2?"E2":null].filter(Boolean);

   // Original ABCDE A/B/C/D/E1/E2 exact gates are evaluated above.
   // E1 is logically impossible when verified official draw fair prob <28,
   // so the absent strict-XG score must not automatically block such a match.
   const e1Excluded=!!spFair&&spFair[1]<28;
   const code=String(item.match_no||"").padStart(3,"0");
   const risk=riskBy.get(code);
   const riskTriggered=risk?.source_payload?.publish===true||Number(risk?.risk_score||0)>=4;
   // The original selector can cover verified handicap-only offerings:
   // absent HAD is not a zero-value probability and cannot activate E1/E2.
   // Prove that a genuine same-identity official HHAD quote exists and that
   // the fixture handicap is deep, rather than silently pretending HAD exists.
   const officialOnly=quotes.some((x:any)=>x.market_type==="HHAD"&&
     x.source_code==="qiulaile_sp_mirror"&&x.snapshot_type==="current"&&
     x.data_quality==="verified_mirror"&&
     Math.abs(Number(x.line)-Number(m.official_handicap))<.00001)&&
     Number.isFinite(Number(m.official_handicap))&&
     !quotes.some((x:any)=>x.market_type==="HAD"&&x.source_code==="qiulaile_sp_mirror")&&
     Math.abs(Number(m.official_handicap))>=2;
   const eNotApplicable=!spFair&&officialOnly;
   const marketComplete=!!wi&&!!wc&&bfValid&&
     ((!!spFair&&(escore||e1Excluded))||eNotApplicable);
   const newsOriginal=(iq.data||[]).some((x:any)=>{
     if(x.match_id!==m.id)return false;
     const observed=Date.parse(String(x.fetched_at||""));
     if(!Number.isFinite(observed)||observed>cut||observed>=kickoff||observed>now)return false;
     if(x.quality==="attributed_prematch_article_pair_verified"){
       const published=Date.parse(String(x.published_at||""));
       return Number.isFinite(published)&&published<=observed&&published<=cut;
     }
     // Exact FotMob fixture and team IDs were checked before the first injury snapshot.
     // An unavailable list is not a confirmed current starting lineup.
     if(x.quality==="fotmob_exact_fixture_prematch_unavailable_first_observed"){
       return x.source_code==="fotmob_match_unavailable_public"&&
         /^https:\/\/www\.fotmob\.com\/api\/data\/matchDetails\?matchId=\d+$/.test(String(x.source_url||""))&&
         x.published_at===null&&Array.isArray(x.highlights)&&
         x.highlights.some((v:any)=>String(v||"").trim().length>=20);
     }
     // Public Okooo pregame reports do not disclose authoring timestamps.
     // Use the true first observed-at timestamp, never invent published_at.
     return x.quality==="okooo_public_prematch_observed"&&
       x.source_code==="okooo_prematch_qingbao_public"&&
       /^https:\/\/www\.okooo\.com\/soccer\/match\/\d+\/qingbao\/$/.test(String(x.source_url||""))&&
       Array.isArray(x.highlights)&&x.highlights.some((v:any)=>String(v||"").trim().length>=20)&&
       x.published_at===null;
   });
   const deep=(archiveQ.data||[]).find((x:any)=>x.match_id===m.id&&
     x.home_team===m.home_team&&x.away_team===m.away_team&&
     Math.abs(Date.parse(String(x.kickoff_at))-kickoff)<=60000&&
     String(x.timing_quality||"").startsWith("PREMATCH")&&x.intel_status==="ok"&&
     Date.parse(String(x.captured_at))<kickoff&&
     Date.parse(String(x.captured_at))<=cut&&Date.parse(String(x.captured_at))<=now&&
     Array.isArray(x.analysis?.intelligence?.highlights)&&
     x.analysis.intelligence.highlights.some((v:any)=>String(v||"").trim().length>10));
   const news=newsOriginal||!!deep;
   const directionalSame=idx(String(item.model_top1))===top&&
      item.institution_top1===item.model_top1&&item.funds_top1===item.model_top1;
   const threeWayValid=Number(item.funds_share_pct)>=50&&
      ["CORE","SUPPLEMENT"].includes(String(item.v1_candidate))||
      item.v2_decision==="ADD"&&Number(item.funds_share_pct)>=50&&directionalSame;
   // The explicit legacy supplement band and daily confidence rank remain
   // mandatory even when the V2 three-way overlay proposes an addition.
   const supplementRule=item.v1_candidate==="CORE"||
     (Number(item.william_top1_odds)>=1.45&&Number(item.william_top1_odds)<=1.75&&
      Number.isInteger(Number(item.william_rank))&&Number(item.william_rank)>=1&&
      Number(item.william_rank)<=3);
   const verifiedCandidate=!!threeWayValid&&directionalSame&&supplementRule&&
     !item.permanent_risk_lock&&!item.high_draw_risk&&!item.market_direction_anomaly&&!locked.has(code)&&
     !riskTriggered&&marketComplete&&news&&triggers.length===0;
   // With no high-risk source warning, the V2.1 bridge predicate is false by
   // definition (its original candidate requires risk >=6 and opposing Top2).
   // Never claim a bridge-negative assessment for a warning with missing sources.
   const bridgeChecked=!riskTriggered&&Number(risk?.risk_score??0)<4&&
     marketComplete&&news;
   const state=triggers.length?"ABCDE_RISK_TRIGGERED":
      verifiedCandidate&&bridgeChecked?"VERIFIED_NO_COLD_OR_BRIDGE_TRIGGER":
      "ABCDE_NO_TRIGGER_BRIDGE_INTEL_PENDING";
   const prior=item.verified_inputs&&typeof item.verified_inputs==="object"?item.verified_inputs:{};
   const evidence={
     version:"ABCDE12_PREMATCH_READONLY_PRECHECK_v2_OFFICIAL_OFFERINGS",reviewedAt:new Date(now).toISOString(),

     sourceMarketCutoffAt:new Date(cut).toISOString(),originalModelTop1:p.ft_top1,
     verifiedOriginalSorenRunId:original?p.run_id:null,
     verifiedHj38RunId:sourceHjRun,publicationOrigin:origin,
     verifiedOriginalPredictionAt:p.frozen_at,
     channels:triggers,sourceQuality:{williamInitial:!!wi,williamCurrent:!!wc,
       betfair:bfValid,asianFirms:firms.length,sp:!!spFair,
       strictScore:escore,e1LogicallyExcluded:e1Excluded,eNotApplicable,
       officialHandicapOnlyQuoteVerified:officialOnly,williamForE:!!ei&&!!ec,
       prematchIntelligence:news,prematchIntelligenceSource:newsOriginal?"SG_VERIFIED_PREMATCH_INTELLIGENCE":
          deep?"ARCHIVED_ORIGINAL_HJ_PREGAME_INTELLIGENCE":null,
       prematchIntelligenceCapturedAt:deep?.captured_at??null},
     originalABCDEChecked:true,bridgeCandidateChecked:bridgeChecked,
     fullOriginalVipGateVerified:verifiedCandidate&&bridgeChecked,
     bridgeGateVerified:bridgeChecked,intelligenceGateVerified:news
   };
   if(verifiedCandidate&&bridgeChecked){
     const tier=String(item.v1_candidate)==="CORE"?"CORE":"SUPPLEMENT";
     const {error:pubErr}=await db.from("soren_daily_selection_publications_v1")
       .upsert({pool_date:date,match_no:code,match_id:m.id,model_top1:p.ft_top1,
         model_frozen_at:p.frozen_at,original_run_id:p.run_id,published_at:new Date(now).toISOString(),
         publication_origin:origin,hj38_model_run_id:sourceHjRun,
         selector_version:original?"SOREN_DAILY_VALUE_V2_VERIFIED_RESTORATION":"SG_HJ38_FORMAL_SOREN_VALUE_V2_ADAPTED",
         vip_cold_gate_version:"ABCDE12_AND_BRIDGE_PREMATCH_V1",
         publication_tier:tier,evidence:evidence},{onConflict:"pool_date,match_no",ignoreDuplicates:true});
     if(pubErr)throw pubErr;
   }
   const update=await db.from("soren_daily_selection_candidate_audit_v1").update({
      vip_cold_gate:state,

      publication_status:triggers.length?"BLOCKED":verifiedCandidate&&bridgeChecked?"PUBLISHED":"PENDING_VIP_COLD_REVIEW",
      reason:triggers.length?"ORIGINAL_ABCDE_COLD_SIGNAL":
        verifiedCandidate&&bridgeChecked?"VERIFIED_SOREN_COLD_AND_V2_CORE_GATE":"ORIGINAL_VIP_BRIDGE_INTEL_GATE_PENDING",
      verified_inputs:{...prior,vip_cold_precheck:evidence},audited_at:new Date(now).toISOString()
   }).eq("pool_date",date).eq("match_no",item.match_no).eq("publication_status","PENDING_VIP_COLD_REVIEW");
   if(update.error)throw update.error;
   outcomes.push({no:item.match_no,gate:state,channels:triggers,coverage:evidence.sourceQuality,customerPublished:verifiedCandidate&&bridgeChecked});
  }
  return reply({ok:true,date,checked:outcomes.length,rows:outcomes,customerPublished:outcomes.filter(x=>x.customerPublished).length,source:"SG_VERIFIED_ORIGINAL_SOREN_CORE_COLD_V1",fullOriginalVipGateVerified:outcomes.some(x=>x.customerPublished)});
 }catch(e){console.error("VIP_PRECHECK_ERROR",e);return reply({ok:false,error:"VIP_PRECHECK_UNAVAILABLE"},503)}
});
