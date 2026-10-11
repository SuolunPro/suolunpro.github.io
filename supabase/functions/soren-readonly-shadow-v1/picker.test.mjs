import test from "node:test";
import assert from "node:assert/strict";
import {verifiedBeforeKickoff,choosePrematchShadow} from "./picker.js";

const m={pool_date:"2026-10-11",match_no:"001",home_team:"主队",away_team:"客队",kickoff_at:"2026-10-11T15:00:00Z"};
const snap=(more={})=>({pregameVerified:true,date:m.pool_date,home:m.home_team,away:m.away_team,
  kickoff:m.kickoff_at,version:"3.8",homeProbability:60,drawProbability:25,awayProbability:15,...more});
const update=(at="2026-10-11T13:00:00Z",more={})=>({source_frozen_at:at,captured_at:"2026-10-11T13:01:00Z",snapshot:snap(),...more});
const before=Date.parse("2026-10-11T14:00:00Z"),after=Date.parse("2026-10-11T15:01:00Z");

test("confirmed prematch update is accepted",()=>{
 assert.equal(verifiedBeforeKickoff(snap(),m,update().source_frozen_at,update().captured_at),true);
});
test("read-only live uses freshest verified snapshot",()=>{
 const old=update("2026-10-11T12:00:00Z",{captured_at:"2026-10-11T12:01:00Z",snapshot:snap({homeProbability:15,awayProbability:60})});
 const latest=update();
 const out=choosePrematchShadow(m,[old,latest],old,before);
 assert.equal(out.status,"LIVE");assert.equal(out.ftTop1,"主胜");assert.equal(out.safe,true);
});
test("does not publish result-leaked snapshot",()=>{
 const row=update(undefined,{snapshot:snap({resultScore:"2-0"})});
 assert.equal(choosePrematchShadow(m,[row],null,before).safe,false);
});
test("rejects wrong fixture team or date",()=>{
 assert.equal(verifiedBeforeKickoff(snap({home:"错队"}),m,update().source_frozen_at,update().captured_at),false);
 assert.equal(verifiedBeforeKickoff(snap({date:"2026-10-10"}),m,update().source_frozen_at,update().captured_at),false);
});
test("rejects after-kickoff capture even if source was earlier",()=>{
 const wrong=update("2026-10-11T14:59:00Z",{captured_at:"2026-10-11T15:01:00Z"});
 assert.equal(choosePrematchShadow(m,[wrong],null,before).safe,false);
});
test("rejects invalid probability",()=>{
 const wrong=update(undefined,{snapshot:snap({homeProbability:110})});
 assert.equal(choosePrematchShadow(m,[wrong],null,before).status,"NO_VERIFIED_PREMATCH");
});
test("rejects post-kickoff unfinalized freeze",()=>{
 assert.equal(choosePrematchShadow(m,[update()],update(),after).status,"LOCK_NOT_FINAL");
});
test("locked snapshot is immutable across later reads",()=>{
 const final={...update(),locked_at:m.kickoff_at};
 const out=choosePrematchShadow(m,[update()],final,after);
 assert.equal(out.status,"KICKOFF_LOCKED");assert.equal(out.safe,true);assert.equal(out.ftTop1,"主胜");
});
test("alerts when a newer legitimate ledger version conflicts with the lock",()=>{
 const freeze={...update("2026-10-11T12:00:00Z",{captured_at:"2026-10-11T12:01:00Z"}),locked_at:m.kickoff_at};
 const later=update("2026-10-11T14:00:00Z",{captured_at:"2026-10-11T14:00:30Z"});
 assert.equal(choosePrematchShadow(m,[later],freeze,after).status,"LEDGER_NEWER_THAN_LOCK");
});
test("missing match 024 is not silently fabricated",()=>{
 const out=choosePrematchShadow({...m,match_no:"024"},[],null,before);
 assert.deepEqual({no:out.no,status:out.status,safe:out.safe},
   {no:"024",status:"NO_VERIFIED_PREMATCH",safe:false});
});
test("missing locked snapshot blocks rollout",()=>{
 const f={...update(),locked_at:m.kickoff_at,snapshot:snap({pregameVerified:false})};
 assert.equal(choosePrematchShadow(m,[update()],f,after).status,"INVALID_LOCKED_SNAPSHOT");
});
