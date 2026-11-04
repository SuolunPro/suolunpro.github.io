import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../src/index.js',import.meta.url),'utf8');
const url='data:text/javascript;base64,'+Buffer.from(source).toString('base64');
const {PredictionStore,default:api}=await import(url);
const records=new Map();
const state={storage:{get:async k=>records.get(k),put:async(k,v)=>{records.set(k,v)}}};
const store=new PredictionStore(state);
const date='2026-11-05';
const match={fixture_id:'fixture-test',home:'Home',away:'Away',verified:true,source:'test',kickoff_at:'2099-11-05T20:00:00+08:00',generated_at:'2026-11-05T11:00:00Z',source_fetched_at:'2026-11-05T10:00:00Z',wdl_top2:[{pick:'主胜',probability:.5},{pick:'平',probability:.3}],score_top3:['1-0','2-0','1-1'],htft_top3:['胜/胜','平/胜','平/平'],goals_top3:['1','2','3'],upset:false,daily_pick:'主胜'};
const endpoint='https://internal/data?date='+date;
test('valid date and snapshot read/write',async()=>{
 assert.equal((await store.fetch(new Request(endpoint,{method:'PUT',body:JSON.stringify({schema_version:1,date,matches:[match]})}))).status,200);
 const result=await store.fetch(new Request(endpoint));
 assert.equal(result.status,200);
 assert.equal((await result.json()).matches[0].home,'Home');
});
test('cold-warning cannot return to daily picks after updates',async()=>{
 const warned={...match,upset:{direction:'平'},daily_pick:null};
 assert.equal((await store.fetch(new Request(endpoint,{method:'PUT',body:JSON.stringify({date,matches:[warned]})}))).status,200);
 assert.equal((await store.fetch(new Request(endpoint,{method:'PUT',body:JSON.stringify({date,matches:[match]})}))).status,422);
 const read=await (await store.fetch(new Request(endpoint))).json();
 assert.equal(read.matches[0].daily_pick,null);
 const next='2026-11-06';
 const across=await store.fetch(new Request('https://internal/data?date='+next,{method:'PUT',body:JSON.stringify({date:next,matches:[match]})}));
 assert.equal(across.status,422);
});
test('reject malformed date',async()=>{
 assert.equal((await store.fetch(new Request('https://internal/data?date=bad'))).status,400);
});
test('unauthenticated VIP read blocked',async()=>{
 const response=await api.fetch(new Request('https://test.invalid/predictions?date='+date),{PREDICTION_STORE:{idFromName:x=>x,get:()=>store}});
 assert.equal(response.status,401);
});
test('invalid evidence timestamp cannot be published',async()=>{
 const bad={...match,generated_at:'2100-11-05T11:00:00Z'};
 const env={PREDICTION_STORE:{idFromName:x=>x,get:()=>store},PUBLISH_TOKEN:'test-token'};
 const req=new Request('https://test.invalid/publish',{method:'PUT',headers:{'x-publish-token':'test-token'},body:JSON.stringify({schema_version:1,date,matches:[bad]})});
 assert.equal((await api.fetch(req,env)).status,422);
});
test('settlement uses frozen prematch directions and rejects conflicting result',async()=>{
 const past={...match,kickoff_at:'2026-11-04T10:00:00+08:00',generated_at:'2026-11-04T00:00:00Z'};
 records.set('day:'+date,{schema_version:1,date,matches:[past]});
 const result={fixture_id:'fixture-test',ht_home:0,ht_away:0,ft_home:1,ft_away:0,status:'FINISHED',source_url:'https://www.sporttery.cn/'};
 const settled=await store.fetch(new Request('https://internal/settle?date='+date,{method:'PUT',body:JSON.stringify({results:[result]})}));
 assert.equal(settled.status,200);
 const read=await (await store.fetch(new Request(endpoint))).json();
 assert.equal(read.matches[0].settlement.hit.wdl_top1,true);
 assert.equal(read.matches[0].settlement.hit.htft_top1,false);
 const conflict=await store.fetch(new Request('https://internal/settle?date='+date,{method:'PUT',body:JSON.stringify({results:[{...result,ft_home:0}]})}));
 assert.equal(conflict.status,409);
});
