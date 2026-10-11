// Shadow-only, side-effect-free selector. No imports, network, DB writes, or result inference.
const LEAK_KEYS = ["result","resultHome","resultAway","resultScore","resultSource","resultVerifiedAt","top1Hit","coverageHit","handicapResult","handicapHit","handicapTop1Hit","handicapCoverageHit"];
const time = value => Date.parse(String(value ?? ""));
const present = value => value !== null && value !== undefined && value !== "";
const valueOf = (row, ...names) => names.map(k => row?.[k]).find(present);

export function verifiedBeforeKickoff(snapshot, match, sourceAt, capturedAt) {
  if (!snapshot || snapshot.pregameVerified !== true || snapshot.resultVerified === true) return false;
  if (LEAK_KEYS.some(key => present(snapshot[key]))) return false;
  const kick = time(match?.kickoff_at), inSnapshot = time(snapshot.kickoff);
  const source = time(sourceAt), captured = time(capturedAt);
  if (![kick,inSnapshot,source,captured].every(Number.isFinite)) return false;
  if (source >= kick || captured >= kick || Math.abs(kick-inSnapshot) >= 120000) return false;
  if (String(snapshot.date) !== String(match.pool_date) ||
      String(snapshot.home) !== String(match.home_team) ||
      String(snapshot.away) !== String(match.away_team)) return false;
  const p = [
    valueOf(snapshot,"homeProbability","homePct","home_pct"),
    valueOf(snapshot,"drawProbability","drawPct","draw_pct"),
    valueOf(snapshot,"awayProbability","awayPct","away_pct"),
  ];
  return p.every(v => present(v) && Number.isFinite(Number(v)) && +v >= 0 && +v <= 100);
}
function project(snapshot) {
  const prob=(...fields)=>Number(valueOf(snapshot,...fields));
  const values=[
    {pick:"主胜",p:prob("homeProbability","homePct","home_pct")},
    {pick:"平",p:prob("drawProbability","drawPct","draw_pct")},
    {pick:"客胜",p:prob("awayProbability","awayPct","away_pct")}
  ].sort((a,b)=>b.p-a.p);
  return {
    modelVersion:String(snapshot.version??""),
    ftTop1:values[0].pick, ftTop2:values[1].pick,
    confidence:values[0].p,
    homePct:prob("homeProbability","homePct","home_pct"),
    drawPct:prob("drawProbability","drawPct","draw_pct"),
    awayPct:prob("awayProbability","awayPct","away_pct"),
    handicapTop1:snapshot.handicapTop1??snapshot.handicap??null,
    handicapSecond:snapshot.handicapSecond??null,
    scoreTop4:snapshot.scoreTop4??null,
    goalPrediction:snapshot.goalPrediction??null
  };
}
// Strict rollout guard: never infer a final result from an unfinalized freeze.
// If a legitimate ledger revision is newer than the locked copy, flag the discrepancy.
export function choosePrematchShadow(match, ledger=[], freeze=null, nowMs=Date.now()) {
  const no=String(match.match_no).padStart(3,"0");
  const kickoff=time(match.kickoff_at);
  if (!Number.isFinite(kickoff)) return {no,status:"INVALID_FIXTURE",safe:false};
  const candidates=ledger.filter(v=>verifiedBeforeKickoff(v.snapshot,match,v.source_frozen_at,v.captured_at))
    .sort((a,b)=>time(b.source_frozen_at)-time(a.source_frozen_at)||time(b.captured_at)-time(a.captured_at));
  const latest=candidates[0]??null;
  const freezeValid=freeze&&verifiedBeforeKickoff(freeze.snapshot,match,freeze.source_frozen_at,freeze.captured_at);
  const live=nowMs<kickoff;
  if (live) {
    const chosen=latest&&(!freezeValid||time(latest.source_frozen_at)>=time(freeze.source_frozen_at))?latest:(freezeValid?freeze:null);
    if (!chosen) return {no,status:"NO_VERIFIED_PREMATCH",safe:false};
    return {no,status:"LIVE",safe:true,sourceFrozenAt:chosen.source_frozen_at,
      capturedAt:chosen.captured_at,...project(chosen.snapshot)};
  }
  // Do not label a fixture as locked if the database has not marked a freeze final.
  if (!freeze?.locked_at) return {no,status:"LOCK_NOT_FINAL",safe:false};
  if (!freezeValid) return {no,status:"INVALID_LOCKED_SNAPSHOT",safe:false};
  if (latest&&time(latest.source_frozen_at)>time(freeze.source_frozen_at))
    return {no,status:"LEDGER_NEWER_THAN_LOCK",safe:false};
  return {no,status:"KICKOFF_LOCKED",safe:true,sourceFrozenAt:freeze.source_frozen_at,
    capturedAt:freeze.captured_at,lockedAt:freeze.locked_at,...project(freeze.snapshot)};
}
