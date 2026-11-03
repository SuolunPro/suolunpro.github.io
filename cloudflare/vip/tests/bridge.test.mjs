// Node 22 test runner; no network or Cloudflare credentials needed.
// Run from cloudflare/vip after installing bcryptjs@2.4.3.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import {webcrypto} from 'node:crypto';
const crypto=webcrypto;

const enc=new TextEncoder();
const b64=s=>Buffer.from(s).toString('base64url');
const sign=async(payload,secret)=>{
 const key=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return Buffer.from(await crypto.subtle.sign('HMAC',key,enc.encode(payload))).toString('base64url');
};
const token=async(sub,exp,secret='test-session-secret')=>{
 const p=b64(JSON.stringify({sub,exp}));return p+'.'+await sign(p,secret);
};
const member={user_id:'u-1',email:'member@example.test',vip_name:'尊贵月卡VIP',active:1,expires_at:'2099-01-01T00:00:00Z'};
function mockDb(row=member) {
 return {prepare(sql){return {bind(){return this},async first(){
   if(sql.includes('FROM vip_admins'))return null;
   if(sql.includes('FROM vip_members'))return row;
   throw Error('unexpected SQL '+sql);
 }}}};
}
const env=(row=member)=>({DB:mockDb(row),SESSION_SECRET:'test-session-secret',VIP_BRIDGE_SECRET:'server-only-secret'});
async function check(t,e=env(),secret='server-only-secret') {
 return worker.fetch(new Request('https://worker.test/internal/verify-vip',{method:'POST',
  headers:{'content-type':'application/json','x-vip-bridge-secret':secret},
  body:JSON.stringify({token:t})}),e);
}
test('valid VIP session is accepted',async()=>{
 const r=await check(await token('u-1',Math.floor(Date.now()/1000)+120));
 assert.equal(r.status,200);const data=await r.json();assert.equal(data.ok,true);assert.equal(data.user_id,'u-1');
});
test('invalid bridge secret rejected',async()=>{
 const r=await check(await token('u-1',Math.floor(Date.now()/1000)+120),env(),'wrong');
 assert.equal(r.status,403);
});
test('expired session rejected',async()=>{
 const r=await check(await token('u-1',Math.floor(Date.now()/1000)-10));
 assert.equal(r.status,401);
});
test('tampered session rejected',async()=>{
 const t=await token('u-1',Math.floor(Date.now()/1000)+120);
 const r=await check(t.slice(0,-1)+(t.endsWith('a')?'b':'a'));
 assert.equal(r.status,401);
});
test('disabled VIP rejected',async()=>{
 const r=await check(await token('u-1',Math.floor(Date.now()/1000)+120),env({...member,active:0}));
 assert.equal(r.status,403);
});
test('expired VIP rejected even with valid token',async()=>{
 const r=await check(await token('u-1',Math.floor(Date.now()/1000)+120),env({...member,expires_at:'2020-01-01T00:00:00Z'}));
 assert.equal(r.status,403);
});
test('missing bridge secret fails closed',async()=>{
 const e=env();delete e.VIP_BRIDGE_SECRET;
 const r=await check(await token('u-1',Math.floor(Date.now()/1000)+120),e);
 assert.equal(r.status,403);
});
