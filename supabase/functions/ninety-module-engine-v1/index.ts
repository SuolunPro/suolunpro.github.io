import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SECRET_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const REVISION = "singapore_ft_okooo_input_v3";
const DIR = ["home", "draw", "away"] as const;
const DIR_ZH: Record<string, string> = { home: "主胜", draw: "平局", away: "客胜" };

function bjtDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}
function n(value: unknown) {
  const x = Number(value);
  return Number.isFinite(x) ? x : null;
}
function clamp(value: number, low: number, high: number) {
  return Math.max(low, Math.min(high, value));
}
function normalizedFromOdds(values: Array<number | null>) {
  if (values.some((x) => x === null || x <= 1)) return null;
  const inverse = values.map((x) => 1 / Number(x));
  const sum = inverse.reduce((a, b) => a + b, 0);
  return inverse.map((x) => x / sum);
}
function rank(values: number[], labels: string[]) {
  return values.map((probability, i) => ({ direction: labels[i], probability }))
    .sort((a, b) => b.probability - a.probability);
}
function poisson(lambda: number, k: number) {
  let factorial = 1;
  for (let i = 2; i <= k; i++) factorial *= i;
  return Math.exp(-lambda) * Math.pow(lambda, k) / factorial;
}
function scoreDistribution(homeLambda: number, awayLambda: number, maxGoals = 10) {
  const rows: Array<{ home: number; away: number; probability: number }> = [];
  let sum = 0;
  for (let h = 0; h <= maxGoals; h++) for (let a = 0; a <= maxGoals; a++) {
    const probability = poisson(homeLambda, h) * poisson(awayLambda, a);
    rows.push({ home: h, away: a, probability }); sum += probability;
  }
  return rows.map((x) => ({ ...x, probability: x.probability / sum }));
}
/* Same deterministic legacy HJ3.8 policy: Top1-3 base probability, Top4 best
   remaining score by direction-posterior challenger weight. Input lambdas are
   separately tagged: SG market-inferred lambda is NOT old HJ frozen xG. */
function selectScoreTop4(scores: Array<{ home: number; away: number; probability: number }>,
  finalProb: {home:number;draw:number;away:number}) {
  const direction=(x:{home:number;away:number})=>x.home>x.away?"home":x.home===x.away?"draw":"away";
  const tie=(a:{home:number;away:number},b:{home:number;away:number})=>
    (a.home+a.away)-(b.home+b.away)||a.home-b.home||a.away-b.away;
  const byBase=[...scores].sort((a,b)=>b.probability-a.probability||tie(a,b));
  const mass={home:0,draw:0,away:0};
  for(const s of scores)mass[direction(s)]+=s.probability;
  const enrich=(s:typeof scores[number], rank:number, role:string)=>{
    const d=direction(s);
    const posterior=s.probability*Math.sqrt(finalProb[d]/Math.max(mass[d],1e-12));
    return {rank,score:`${s.home}-${s.away}`,home:s.home,away:s.away,
      direction:d,role,probability:s.probability,baseProbability:s.probability,posteriorWeight:posterior};
  };
  const base=byBase.slice(0,3).map((s,i)=>enrich(s,i+1,"BASE"));
  const challenger=byBase.slice(3).map(s=>enrich(s,4,"DIRECTION_CHALLENGER"))
    .sort((a,b)=>b.posteriorWeight-a.posteriorWeight||b.probability-a.probability||tie(a,b))[0];
  return challenger?[...base,challenger]:[];
}

/* HJ3.8 score freeze compatibility. Mirrors old hao_fit_lambdas_from_1x2_v01:
   0.20..4.00 / 0.05 coarse and +/-0.06 / 0.01 fine, 0..10 DC grid,
   squared 1X2 fit error <= .01. Do not use match outcomes or late odds. */
function fitHJ38InverseLambdas(p:{home:number;draw:number;away:number}){
  const total=p.home+p.draw+p.away;
  if(!Number.isFinite(total)||total<=0||[p.home,p.draw,p.away].some(x=>!Number.isFinite(x)||x<=0))return null;
  const target=[p.home/total,p.draw/total,p.away/total];
  const memo=new Map<number,number[]>();
  const pmf=(hundredths:number)=>{
    let cache=memo.get(hundredths);if(cache)return cache;
    const lambda=hundredths/100,prob=[Math.exp(-lambda)];
    for(let k=1;k<=10;k++)prob.push(prob[k-1]*lambda/k);
    memo.set(hundredths,prob);return prob;
  };
  let best:{hi:number;ai:number;error:number;tie:number}|null=null;
  const consider=(hi:number,ai:number)=>{
    const lh=hi/100,la=ai/100,h=pmf(hi),a=pmf(ai);
    let home=0,draw=0,away=0;
    for(let hg=0;hg<=10;hg++)for(let ag=0;ag<=10;ag++){
      let mass=h[hg]*a[ag];
      if(hg===0&&ag===0)mass*=1+lh*la*0.08;
      else if(hg===0&&ag===1)mass*=1-lh*0.08;
      else if(hg===1&&ag===0)mass*=1-la*0.08;
      else if(hg===1&&ag===1)mass*=1.08;
      if(hg>ag)home+=mass;else if(hg===ag)draw+=mass;else away+=mass;
    }
    const total=home+draw+away,hh=home/total,dd=draw/total,aa=away/total;
    const error=(hh-target[0])**2+(dd-target[1])**2+(aa-target[2])**2;
    const tie=Math.abs(lh+la-2.6);
    if(!best||error<best.error||
        (error===best.error&&(tie<best.tie||(tie===best.tie&&hi<best.hi))))
      best={hi,ai,error,tie};
  };
  for(let hi=20;hi<=400;hi+=5)for(let ai=20;ai<=400;ai+=5)consider(hi,ai);
  const coarse=best;if(!coarse)return null;best=null;
  for(let hi=Math.max(10,coarse.hi-6);hi<=Math.min(500,coarse.hi+6);hi++)
    for(let ai=Math.max(10,coarse.ai-6);ai<=Math.min(500,coarse.ai+6);ai++)consider(hi,ai);
  if(!best||best.error>0.01)return null;
  // Old blind freezer divides by 1.037475, then official freezer multiplies
  // by 1.037475 again. Final lambda is the fitted value without extra scaling.
  return {home:best.hi/100,away:best.ai/100,error:best.error};
}
function scoreDistributionHJ38(homeLambda:number,awayLambda:number){
  const rows=scoreDistribution(homeLambda,awayLambda,10),rho=-0.08;
  const adjusted=rows.map(x=>{
    const h=x.home,a=x.away;
    const weight=h===0&&a===0?1-homeLambda*awayLambda*rho:
      h===0&&a===1?1+homeLambda*rho:
      h===1&&a===0?1+awayLambda*rho:h===1&&a===1?1-rho:1;
    return {...x,probability:x.probability*weight};
  });
  const mass=adjusted.reduce((sum,x)=>sum+x.probability,0);
  return adjusted.map(x=>({...x,probability:x.probability/mass}));
}


/* Strictly prematch derivative modules, using the SAME qualified HJ38 P-final fit
   as score Top4. Calculation methods are tagged as research, not the original
   3.8 xG goal engine. No result data, no later market snapshot. */
function hj38TotalGoalsTop3(home:number,away:number){
  const lambda=home+away;
  const ranked=Array.from({length:25},(_,goals)=>({goals,probability:poisson(lambda,goals)}));
  return ranked.sort((a,b)=>b.probability-a.probability||a.goals-b.goals).slice(0,3);
}
function sorenJointHtftTop3(home:number,away:number){
  const share=0.45;
  const hp1=Array.from({length:11},(_,k)=>poisson(home*share,k));
  const ap1=Array.from({length:11},(_,k)=>poisson(away*share,k));
  const hp2=Array.from({length:11},(_,k)=>poisson(home*(1-share),k));
  const ap2=Array.from({length:11},(_,k)=>poisson(away*(1-share),k));
  const masses=new Array<number>(9).fill(0);
  for(let h1=0;h1<=10;h1++)for(let a1=0;a1<=10;a1++){
    const ht=h1>a1?0:h1===a1?1:2;
    const htMass=hp1[h1]*ap1[a1];
    for(let h2=0;h2<=10;h2++)for(let a2=0;a2<=10;a2++){
      const ft=h1+h2>a1+a2?0:h1+h2===a1+a2?1:2;
      masses[ht*3+ft]+=htMass*hp2[h2]*ap2[a2];
    }
  }
  const mass=masses.reduce((a,b)=>a+b,0);
  if(mass<0.99)return null; // old Soren v1.3 density gate
  const names=["主胜","平局","客胜"];
  const rows=masses.map((p,k)=>({
    combination:names[Math.floor(k/3)]+"/"+names[k%3],
    probability:p/mass,rank:k
  }));
  rows.sort((a,b)=>b.probability-a.probability||a.rank-b.rank);
  return {top3:rows.slice(0,3).map(({combination,probability})=>({combination,probability})),
    htDrawProbability:(masses[3]+masses[4]+masses[5])/mass,
    mass,share};
}

function outcomeFromScores(rows: Array<{ home: number; away: number; probability: number }>) {
  const out = { home: 0, draw: 0, away: 0 };
  for (const row of rows) out[row.home > row.away ? "home" : row.home === row.away ? "draw" : "away"] += row.probability;
  return out;
}
function median(values: number[]) {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}
function totalsLine(payload: any) {
  const values: number[] = [];
  for (const line of Array.isArray(payload?.lines) ? payload.lines : []) {
    const tokens = String(line?.primary || "").match(/-?\d+(?:\.\d+)?/g)?.map(Number) || [];
    if (tokens.length >= 3 && tokens[1] >= 1.5 && tokens[1] <= 5.5) values.push(tokens[1]);
  }
  return median(values);
}
function betfairDirections(payload: any) {
  const selections = payload?.selections || {};
  const shares = DIR.map((key) => n(selections?.[key]?.share_pct));
  const averages = DIR.map((key) => n(selections?.[key]?.average_odds));
  if (shares.some((x) => x === null) || averages.some((x) => x === null)) return null;
  const fund = DIR.map((direction, i) => ({ direction, value: Number(shares[i]) })).sort((a, b) => b.value - a.value);
  const institution = DIR.map((direction, i) => ({ direction, value: Number(averages[i]) })).sort((a, b) => a.value - b.value);
  return { fund, institution, selections };
}
function output(module: string, payload: any, quality: "provisional" | "pass" = "provisional") {
  const revision=(module==="score_top3"||module==="score_top4") && payload?.legacy_method_restored===true
    ? "SG_HJ38_SCORE_PFINAL_INVERSE_COMPAT_V1" :
    (module==="total_goals"||module==="htft_top3") && payload?.source_kind==="HJ38_VERIFIED_PREMATCH_INVERSE_PFINAL"
    ? "SG_HJ38_SHARED_LAMBDA_GOALS_HTFT_V1" :
    (module==="htft_top3"&&payload?.legacy_joint_method_restored===true)
    ? "SG_HJ38_SHARED_LAMBDA_GOALS_HTFT_V1" : REVISION;
  return { module, revision, payload: { ...payload, shadow: true, revision }, quality };
}

function computeMatch(match: any) {
  const fields = match?.fields || {};
  const official = fields?.official_sp?.payload || null;
  // FT: prefer independently verified original institutional percentages; otherwise use verified Okooo SP.
  const marketField = fields?.ft_odds;
  const rawInstitution = marketField?.quality === "verified" && marketField?.source_name === "okooo"
    ? marketField?.payload?.institution_probabilities : null;
  const rawTriplet = rawInstitution ? [n(rawInstitution.home), n(rawInstitution.draw), n(rawInstitution.away)] : null;
  const rawValid = rawTriplet && rawTriplet.every((v) => v !== null && v >= 0 && v <= 100)
    && Math.abs(rawTriplet.reduce((a, b) => a + Number(b), 0) - 100) <= 1;
  const officialVerified = fields?.official_sp?.quality === "verified" &&
    ["okooo", "okooo_mirror"].includes(fields?.official_sp?.source_name);
  const spProb = officialVerified ? normalizedFromOdds([
    n(official?.had?.home), n(official?.had?.draw), n(official?.had?.away),
  ]) : null;
  // One Okooo market snapshot, shared by FT and upset. No substituted odds may be labeled Okooo.
  const okoooAverage = marketField?.quality === "verified" && marketField?.source_name === "okooo"
    ? marketField?.payload?.average : null;
  const avgProb = okoooAverage ? normalizedFromOdds([
    n(okoooAverage.home), n(okoooAverage.draw), n(okoooAverage.away),
  ]) : null;
  const ftProb = rawValid
    ? rawTriplet!.map((v) => Number(v) / rawTriplet!.reduce((a, b) => a + Number(b), 0))
    : (avgProb || spProb);
  const ftMethod = rawValid ? "okooo_original_institution_probabilities"
    : avgProb ? "okooo_average_european_odds_implied" : "okooo_verified_sp_implied";
  const ftSource = rawValid || avgProb ? "okooo" : (officialVerified ? fields?.official_sp?.source_name : null);
  const handicapProb = official ? normalizedFromOdds([
    n(official?.hhad?.home), n(official?.hhad?.draw), n(official?.hhad?.away),
  ]) : null;
  const outputs: any[] = [];

  if (ftProb) {
    const ranking = rank(ftProb, ["主胜", "平局", "客胜"]);
    outputs.push(output("ft", { status: "READY", method: ftMethod, source: ftSource, probability_kind: rawValid ? "institution_original" : "odds_implied",
      probabilities: { home: ftProb[0], draw: ftProb[1], away: ftProb[2] }, top3: ranking,
      top1: ranking[0], top2: ranking.slice(0, 2) }));
  } else outputs.push(output("ft", { status: "PASS", reason: "official_sp_missing_or_frozen" }, "pass"));

  if (handicapProb) {
    const ranking = rank(handicapProb, ["让胜", "让平", "让负"]);
    outputs.push(output("handicap", { status: "READY", method: "official_hhad_sp_implied_probability",
      handicap_line: official?.hhad?.line ?? null,
      probabilities: { home: handicapProb[0], draw: handicapProb[1], away: handicapProb[2] },
      top3: ranking, top1: ranking[0], top2: ranking.slice(0, 2) }));
  } else outputs.push(output("handicap", { status: "PASS", reason: "official_hhad_missing_or_frozen" }, "pass"));


  // Prefer exact historical HJ3.8 inverse-P-final score policy over O/U shortcuts.
  // Its input is a verified, matching, sale-before HJ3.8 frozen prediction.
  const hjScoreSource=match.hj38_final;
  const hjScoreFit=hjScoreSource?fitHJ38InverseLambdas(hjScoreSource):null;
  if(hjScoreFit){
    const rows=scoreDistributionHJ38(hjScoreFit.home,hjScoreFit.away);
    const top4=selectScoreTop4(rows,hjScoreSource);
    const top3=[...rows].sort((a,b)=>b.probability-a.probability||
      (a.home+a.away)-(b.home+b.away)||a.home-b.home||a.away-b.away).slice(0,3)
      .map(x=>({score:`${x.home}-${x.away}`,probability:x.probability}));
    const evidence={source_frozen_at:match.hj38_source?.frozen_at??null,
      source_run_id:match.hj38_source?.run_id??null,
      dc_rho:-0.08,home_lambda:hjScoreFit.home,away_lambda:hjScoreFit.away};
    outputs.push(output("score_top3",{status:"READY",method:"HJ38_PFINAL_INVERSE_POISSON_BLIND_V1",
      input_method:"PFINAL_INVERSE_POISSON_BLIND_V1",legacy_method_restored:true,fit_error:hjScoreFit.error,
      inputs:evidence,top3}));
    outputs.push(output("score_top4",{status:top4.length===4?"READY":"PASS",
      method:"HJ38_SCORE_TOP4_v1.0.0_PFINAL_INVERSE_POISSON_BLIND_V1",
      input_method:"PFINAL_INVERSE_POISSON_BLIND_V1",
      original_hj38_lambda_available:false,legacy_method_restored:true,
      formalEligible:false,referenceOnly:true,
      source_frozen_at:evidence.source_frozen_at,source_run_id:evidence.source_run_id,
      fit_error:hjScoreFit.error,direction_calibration:"HJ38_VERIFIED_PREMATCH_P_FINAL",
      inputs:evidence,top4,top4_probability:top4.reduce((s,x)=>s+x.probability,0)
    },top4.length===4?"provisional":"pass"));
  }else if(hjScoreSource){
    // An unfittable verified HJ38 snapshot is a PASS, not a fabricated prediction.
    outputs.push(output("score_top3",{status:"PASS",reason:"HJ38_PFINAL_INVERSE_FIT_FAILED"},"pass"));
    outputs.push(output("score_top4",{status:"PASS",reason:"HJ38_PFINAL_INVERSE_FIT_FAILED"},"pass"));
  }


  // Restore missing half/full and goal feeds even when O/U market is absent.
  // Input is matched HJ38, sale-time valid frozen P-final (not invented O/U data).
  if(hjScoreFit){
    const evidence={home_lambda:hjScoreFit.home,away_lambda:hjScoreFit.away,
      source_frozen_at:match.hj38_source?.frozen_at??null,source_run_id:match.hj38_source?.run_id??null,
      input_method:"PFINAL_INVERSE_POISSON_BLIND_V1",fit_error:hjScoreFit.error};
    const totalTop=hj38TotalGoalsTop3(hjScoreFit.home,hjScoreFit.away);
    outputs.push(output("total_goals",{status:"READY",method:"HJ38_FROZEN_LAMBDA_POISSON_TOTAL_TOP3_REFERENCE_V1",
      legacy_method_restored:true,source_kind:"HJ38_VERIFIED_PREMATCH_INVERSE_PFINAL",
      formalEligible:false,referenceOnly:true,inputs:evidence,top3:totalTop,top1:totalTop[0]}));
    const half=sorenJointHtftTop3(hjScoreFit.home,hjScoreFit.away);
    if(half){
      outputs.push(output("htft_top3",{status:"READY",
        method:"SOREN_HTFT_POISSON_JOINT_TOP3_V13_ON_HJ38_FROZEN_LAMBDA",
        source_method:"HTFT-POISSON-JOINT-TOP4-v1.3",legacy_joint_method_restored:true,
        formalEligible:false,referenceOnly:true,inputs:{...evidence,ht_goal_share:half.share},
        ht_draw_probability:half.htDrawProbability,top3:half.top3}));
    }else outputs.push(output("htft_top3",{status:"PASS",reason:"SOREN_HTFT_JOINT_MASS_BELOW_GATE"},"pass"));
  }

  const goalLine = totalsLine(fields?.over_under?.payload);
  if (ftProb && goalLine !== null) {
    const totalLambda = clamp(goalLine, 1.5, 4.5);
    const homeRatio = clamp(0.5 + 0.45 * (ftProb[0] - ftProb[2]), 0.2, 0.8);
    let homeLambda = totalLambda * homeRatio, awayLambda = totalLambda - homeLambda;
    const elo=match.elo_input;
    const eloDiff=Number(elo?.elo_diff);
    const eloValid=elo&&elo.source_status==="confirmed"&&Number.isFinite(eloDiff)
      &&Math.abs(eloDiff)<=400&&Number(elo.home_games_seen)>=10&&Number(elo.away_games_seen)>=10
      &&Date.parse(String(elo.reconstructed_at))<Date.parse(String(match.kickoff_at));
    if(eloValid){
      const homeShare=clamp(homeLambda/totalLambda+clamp(eloDiff/400,-1,1)*0.04,0.2,0.8);
      homeLambda=totalLambda*homeShare;awayLambda=totalLambda-homeLambda;
    }
    const rho=-0.08;
    const scoresBase=scoreDistribution(homeLambda,awayLambda);
    const dc=(h:number,a:number)=>h===0&&a===0?1-homeLambda*awayLambda*rho:h===0&&a===1?1+homeLambda*rho:h===1&&a===0?1+awayLambda*rho:h===1&&a===1?1-rho:1;
    const adjusted=scoresBase.map(x=>({...x,probability:x.probability*Math.max(0,dc(x.home,x.away))}));
    const norm=adjusted.reduce((v,x)=>v+x.probability,0);
    const scores=adjusted.map(x=>({...x,probability:x.probability/norm}));
    // Market-derived legacy fallback is always marked SHADOW, never old HJ38.
    if(!hjScoreSource){
    const scoreTop4=selectScoreTop4(scores,match.hj38_final||{
      home:ftProb[0],draw:ftProb[1],away:ftProb[2]
    });
    const scoreTop = [...scores].sort((a, b) => b.probability - a.probability).slice(0, 3)
      .map((x) => ({ score: `${x.home}-${x.away}`, probability: x.probability }));
    outputs.push(output("score_top3", { status: "READY", method: "market_total_poisson_dc_shadow_v1",
      inputs: { dc_rho:-0.08,total_line: goalLine, home_lambda: homeLambda, away_lambda: awayLambda }, top3: scoreTop }));
    outputs.push(output("score_top4", {status: scoreTop4.length===4?"READY":"PASS",
      method:"HJ38_TOP3_PLUS_DIRECTION_CHALLENGER_ON_SG_POISSON_DC_V1",
      original_hj38_lambda_available:false, formalEligible:false,
      input_method:"OKOOO_MARKET_TOTAL_AND_FT_PROB_INFERRED_LAMBDAS",
      direction_calibration:match.hj38_final?"HJ38_VERIFIED_PREMATCH_P_FINAL":"SG_VERIFIED_INSTITUTION_FT",
      inputs:{dc_rho:-0.08,total_line:goalLine,home_lambda:homeLambda,away_lambda:awayLambda},
      top4:scoreTop4,top4_probability:scoreTop4.reduce((s:any,x:any)=>s+x.probability,0)
    },scoreTop4.length===4?"provisional":"pass"));

    }

    const totals = new Map<number, number>();
    for (const row of scores) totals.set(row.home + row.away, (totals.get(row.home + row.away) || 0) + row.probability);
    const totalTop = [...totals.entries()].map(([goals, probability]) => ({ goals, probability }))
      .sort((a, b) => b.probability - a.probability).slice(0, 3);
    if(!hjScoreFit){
    outputs.push(output("total_goals", { status: "READY", method: "market_total_poisson_shadow",
      inputs: { total_line: goalLine }, top3: totalTop, top1: totalTop[0] }));

    const halfOutcome = outcomeFromScores(scoreDistribution(homeLambda * 0.45, awayLambda * 0.45, 5));
    const half = DIR.map((direction) => ({ direction, probability: halfOutcome[direction] }));
    const combos: Array<{ combination: string; probability: number }> = [];
    for (const h of half) for (let i = 0; i < DIR.length; i++) combos.push({
      combination: `${DIR_ZH[h.direction]}/${DIR_ZH[DIR[i]]}`, probability: h.probability * ftProb[i],
    });
    const comboSum = combos.reduce((sum, x) => sum + x.probability, 0);
    const htftTop = combos.map((x) => ({ ...x, probability: x.probability / comboSum }))
      .sort((a, b) => b.probability - a.probability).slice(0, 3);
    outputs.push(output("htft_top3", { status: "READY", method: "halftime_poisson_x_fulltime_market_shadow",
      top3: htftTop }));
    }
  } else {
    if(!hjScoreSource){
      outputs.push(output("score_top3", { status: "PASS", reason: "goal_line_or_ft_probability_missing" }, "pass"));
      outputs.push(output("score_top4", { status: "PASS", reason: "goal_line_or_ft_probability_missing" }, "pass"));
    }
    if(!hjScoreFit){
      outputs.push(output("total_goals", { status: "PASS", reason: "goal_line_or_ft_probability_missing" }, "pass"));
      outputs.push(output("htft_top3", { status: "PASS", reason: "goal_line_or_ft_probability_missing" }, "pass"));
    }
  }

  // Only complete, source-verified Okooo Betfair data can trigger customer-impacting risk signals.
  const market = fields?.betfair?.quality === "verified" && fields?.betfair?.source_name === "okooo"
    ? betfairDirections(fields.betfair.payload) : null;
  let upset: any = { status: "PASS", triggered: false, reason: "verified_three_way_market_missing" };
  let daily: any = { status: "PASS", reason: "entry_conditions_not_met" };
  if (ftProb && market) {
    const ftRank = DIR.map((direction, i) => ({ direction, probability: ftProb[i] })).sort((a, b) => b.probability - a.probability);
    const ftTop = ftRank[0], fundTop = market.fund[0], institutionTop = market.institution[0];
    const fundGap = fundTop.value - market.fund[1].value;
    const drawShare = Number(market.selections?.draw?.share_pct || 0);
    const strongReverse = fundTop.direction !== ftTop.direction && fundTop.value >= 40 && fundGap >= 8;
    const drawHot = drawShare >= 35 && ftTop.direction !== "draw";
    if (strongReverse || drawHot) {
      const pressure = drawHot ? "draw" : fundTop.direction;
      const direction = ftTop.direction === "home" ? "主队不胜" : ftTop.direction === "away" ? "主队不败" : null;
      if (direction) upset = { status: "TRIGGERED", triggered: true, channel: strongReverse ? "A" : "C",
        direction, reason: strongReverse ? "verified_betfair_strong_reverse" : "verified_draw_funds_overheated",
        evidence: { ft_top1: ftTop, fund_top1: fundTop, fund_gap: fundGap, draw_share: drawShare, pressure } };
    } else upset = { status: "PASS", triggered: false, reason: "no_verified_reverse_signal",
      evidence: { ft_top1: ftTop, institution_direction: institutionTop.direction, fund_direction: fundTop.direction } };

    const aligned = ftTop.direction === institutionTop.direction && ftTop.direction === fundTop.direction;
    if (!upset.triggered && !match.upset_locked && aligned && ftTop.probability >= 0.55) {
      daily = { status: "SELECTED", tier: ftTop.probability >= 0.60 ? "稳健" : "激进",
        direction: DIR_ZH[ftTop.direction], probability: ftTop.probability,
        evidence: { ft: ftTop.direction, institution: institutionTop.direction, funds: fundTop.direction } };
    } else daily = { status: "PASS", reason: upset.triggered || match.upset_locked ? "upset_warning_hard_exclusion" :
      !aligned ? "three_way_alignment_failed" : "top1_below_55_percent" };
  }
  outputs.push(output("upset_warning", upset, upset.triggered ? "provisional" : "pass"));
  outputs.push(output("daily_selection", daily, daily.status === "SELECTED" ? "provisional" : "pass"));
  return { match_key: match.match_key, outputs };
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const date = url.searchParams.get("date") || bjtDate();
  const dry = url.searchParams.get("dry") === "1";
  try {
    const { data: input, error: inputError } = await sb.rpc("ninety_engine_inputs", { p_date: date });
    if (inputError) throw inputError;
    const sourceMatches=Array.isArray(input?.matches)?input.matches:[];
    const {data:eloRows,error:eloError}=await sb.schema("ninety_core").from("hao_elo_live_v01")
      .select("offer_date,match_no,home_team,away_team,elo_diff,home_games_seen,away_games_seen,source_status,reconstructed_at").eq("offer_date",date);
    if(eloError)throw eloError;
    const normalizeTeam=(v:unknown)=>String(v||"").toLowerCase().replace(/[\\s·.．-]/g,"");
    const {data:aliasRows,error:aliasError}=await sb.schema("ninety_core").from("hao_team_alias_full_v01").select("jc_team,fotmob_team_id");
    if(aliasError)throw aliasError;
    const names=new Map<string,Set<number>>();
    for(const a of aliasRows||[]){const k=normalizeTeam(a.jc_team);if(!names.has(k))names.set(k,new Set());names.get(k)!.add(Number(a.fotmob_team_id));}
    const sameTeam=(a:string,b:string)=>{const x=normalizeTeam(a),y=normalizeTeam(b);if(x===y)return true;const i=names.get(x),j=names.get(y);return !!i&&!!j&&i.size===1&&j.size===1&&[...i][0]===[...j][0];};
    // HJ38 P-final is usable only from an independently frozen, exact-identity,
    // timestamped 3.8 prediction. Never backfill after kickoff.
    const {data:formalHjRuns,error:formalHjRunsError}=await sb.schema("ninety_core")
      .from("hao_console_model_runs").select("id").eq("pool_date",date)
      .eq("formal_allowed",true).eq("data_complete",true).limit(500);
    if(formalHjRunsError)throw formalHjRunsError;
    const formalHjRunIds=new Set((formalHjRuns||[]).map((r:any)=>Number(r.id)));
    const {data:hjRows,error:hjError}=await sb.schema("ninety_core").from("hao_console_predictions")
      .select("pool_date,match_no,home_team,away_team,kickoff_bjt,frozen_at,model_version,run_id,source_status")
      .eq("pool_date",date).order("frozen_at",{ascending:false}).limit(3000);
    if(hjError)throw hjError;
    const matches=sourceMatches.map((m:any)=>{
      const candidates=(eloRows||[]).filter((x:any)=>String(x.match_no).padStart(3,"0")===String(m.match_no).padStart(3,"0")&&sameTeam(x.home_team,m.home_team)&&sameTeam(x.away_team,m.away_team));
      const eligible=candidates.filter((x:any)=>x.source_status==="confirmed"&&Number.isFinite(Date.parse(String(x.reconstructed_at)))&&Date.parse(String(x.reconstructed_at))<Date.parse(String(m.kickoff_at))&&Math.abs(Number(x.elo_diff))<=400&&Number(x.home_games_seen)>=10&&Number(x.away_games_seen)>=10);
      const candidate=eligible.length===1?eligible[0]:null;
      const mk=Date.parse(String(m.kickoff_at));
      const sale=Date.parse(date+"T"+([0,6].includes(new Date(date+"T12:00:00Z").getUTCDay())?"15:00:00":"14:00:00")+"Z");
      const source=(hjRows||[]).find((x:any)=>{
        const at=Date.parse(String(x.frozen_at)),ko=Date.parse(String(x.kickoff_bjt));
        return x.model_version==="3.8"&&formalHjRunIds.has(Number(x.run_id))&&
          String(x.match_no).padStart(3,"0")===String(m.match_no).padStart(3,"0")&&
          sameTeam(x.home_team,m.home_team)&&sameTeam(x.away_team,m.away_team)&&
          Number.isFinite(at)&&Number.isFinite(ko)&&Number.isFinite(mk)&&
          Math.abs(ko-mk)<60000&&at<Math.min(mk,sale)&&at<=Date.now();
      });
      const p=source?.source_status?.p_final;
      const probs=p&&[Number(p.home),Number(p.draw),Number(p.away)];
      const verifiedFinal=probs&&probs.every((v:number)=>Number.isFinite(v)&&v>0&&v<=1)
        &&Math.abs(probs.reduce((a:number,b:number)=>a+b,0)-1)<0.02
        ?{home:probs[0],draw:probs[1],away:probs[2]}:null;
      return computeMatch({...m,elo_input:candidate||null,hj38_final:verifiedFinal,hj38_source:verifiedFinal?{frozen_at:source?.frozen_at,run_id:source?.run_id}:null});
    });
    let publish: any = { dry: true };
    if (!dry) {
      const { data, error } = await sb.rpc("ninety_publish_modules", { p_payload: { date, matches } });
      if (error) throw error;
      publish = data;
    }
    const summary: Record<string, any> = {};
    for (const module of ["ft", "handicap", "score_top3", "score_top4", "htft_top3", "total_goals", "upset_warning", "daily_selection"]) {
      const rows = matches.map((m: any) => m.outputs.find((x: any) => x.module === module)).filter(Boolean);
      summary[module] = { outputs: rows.length, ready: rows.filter((x: any) => !["PASS"].includes(x.payload.status)).length,
        pass: rows.filter((x: any) => x.payload.status === "PASS").length };
    }
    return Response.json({ ok: true, dry, date, shadow: true, matches: matches.length, summary, publish,
      previews: matches.slice(0, 5).map((m: any) => ({ match_key: m.match_key,
        ft: m.outputs.find((x: any) => x.module === "ft")?.payload,
        upset: m.outputs.find((x: any) => x.module === "upset_warning")?.payload,
        daily: m.outputs.find((x: any) => x.module === "daily_selection")?.payload,
        score_top4: m.outputs.find((x:any)=>x.module==="score_top4")?.payload })) });
  } catch (error) {
    console.error("NINETY_MODULE_ENGINE_FAILED", error);
    return Response.json({ ok: false, date, error: String((error as Error)?.message || error) }, { status: 500 });
  }
});
