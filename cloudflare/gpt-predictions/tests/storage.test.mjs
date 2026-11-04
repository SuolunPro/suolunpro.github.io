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
const match={fixture_id:'fixture-test',home:'Home',away:'Away',verified:true,source:'test',wdl_top2:['主胜','平'],score_top3:['1-0','2-0','1-1'],htft_top3:['胜胜','平胜','平平'],goals_top3:['1','2','3'],upset:false,daily_pick:'主胜'};
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
});
test('reject malformed date',async()=>{
 assert.equal((await store.fetch(new Request('https://internal/data?date=bad'))).status,400);
});
test('unauthenticated VIP read blocked',async()=>{
 const response=await api.fetch(new Request('https://test.invalid/predictions?date='+date),{PREDICTION_STORE:{idFromName:x=>x,get:()=>store}});
 assert.equal(response.status,401);
});
