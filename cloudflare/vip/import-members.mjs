// Private, local-only import: never commit member exports, tokens or password hashes.
// Usage: CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node import-members.mjs ./private-members.json --dry-run
// After reviewing: remove --dry-run. Input is a private JSON array of {user_id,email,vip_name,expires_at,active,password_hash,is_admin}.
import fs from 'node:fs';
import path from 'node:path';

const args=process.argv.slice(2), file=args.find(x=>!x.startsWith('--'));
const dryRun=args.includes('--dry-run');
if(!file || !fs.existsSync(file))throw Error('Provide a local private JSON file (not in git)');
if(path.resolve(file).startsWith(path.resolve(process.cwd())+path.sep))throw Error('Private input must be outside the repository working directory');
const records=JSON.parse(fs.readFileSync(file,'utf8'));
if(!Array.isArray(records)||records.length===0)throw Error('Expected non-empty array');
const normalized=[], emails=new Set(), ids=new Set();
for(const [i,r] of records.entries()){
 const email=String(r.email||'').trim().toLowerCase(),id=String(r.user_id||'').trim();
 const expires=String(r.expires_at||''), hash=String(r.password_hash||'');
 if(!id||!/^\S+@\S+\.\S+$/.test(email)||!/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(hash)||!Number.isFinite(Date.parse(expires))||r.active!==true||r.vip_name!=='尊贵月卡VIP')throw Error('Invalid record at index '+i);
 if(ids.has(id)||emails.has(email))throw Error('Duplicate id/email at index '+i);
 ids.add(id);emails.add(email);
 normalized.push({id,email,expires,hash,is_admin:r.is_admin===true});
}
if(normalized.filter(x=>x.is_admin).length!==1)throw Error('Exactly one explicit admin is required');
console.log(JSON.stringify({valid_records:normalized.length,admin_records:1,dry_run:dryRun}));
if(dryRun)process.exit(0);
const token=process.env.CLOUDFLARE_API_TOKEN,account=process.env.CLOUDFLARE_ACCOUNT_ID;
if(!token||!account)throw Error('Cloudflare token and account ID required');
const base='https://api.cloudflare.com/client/v4/accounts/'+encodeURIComponent(account)+'/d1/database';
async function cf(url,opts={}){
 const response=await fetch(url,{...opts,headers:{Authorization:'Bearer '+token,...opts.headers}});
 if(!response.ok)throw Error('Cloudflare HTTP '+response.status);
 const result=await response.json();
 if(!result.success)throw Error('Cloudflare API rejected request');
 return result.result;
}
const databases=await cf(base+'?per_page=100');
const db=databases.find(x=>x.name==='suolun-vip-staging');
if(!db)throw Error('Staging database not found');
async function sql(query,params=[]){
 const result=await cf(base+'/'+db.uuid+'/query',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sql:query,params})});
 if(!result[0]?.success)throw Error('D1 query failed');
 return result[0].results||[];
}
const existing=await sql('SELECT user_id,email,vip_name,expires_at,active,password_hash FROM vip_members');
const expected=new Map(normalized.map(r=>[r.id,r]));
if(existing.length>normalized.length)throw Error('Unexpected existing members; refusing to import');
for(const row of existing){
 const r=expected.get(row.user_id);
 if(!r || row.email.toLowerCase()!==r.email || row.vip_name!=='尊贵月卡VIP' || row.expires_at!==r.expires || Number(row.active)!==1 || row.password_hash!==r.hash)throw Error('Existing member conflict; no writes performed');
}
const currentAdmins=await sql('SELECT user_id FROM vip_admins');
if(currentAdmins.some(row=>!expected.get(row.user_id)?.is_admin))throw Error('Unexpected admin role; no writes performed');
console.log(JSON.stringify({existing_verified:existing.length,remaining:normalized.length-existing.length}));
const existingIds=new Set(existing.map(x=>x.user_id));
for(const r of normalized){
 if(!existingIds.has(r.id))await sql('INSERT INTO vip_members (user_id,email,vip_name,expires_at,active,password_hash) VALUES (?,?,?,?,1,?)',[r.id,r.email,'尊贵月卡VIP',r.expires,r.hash]);
 if(r.is_admin && !currentAdmins.some(x=>x.user_id===r.id))await sql('INSERT INTO vip_admins(user_id) VALUES (?)',[r.id]);
}
const result=await sql('SELECT COUNT(*) AS n FROM vip_members');
const admins=await sql('SELECT COUNT(*) AS n FROM vip_admins');
if(Number(result[0]?.n)!==normalized.length||Number(admins[0]?.n)!==1)throw Error('Post-import count mismatch; review database before retrying');
const verified=await sql('SELECT user_id,email,vip_name,expires_at,active,password_hash FROM vip_members');
for(const row of verified){
 const r=expected.get(row.user_id);
 if(!r || row.email.toLowerCase()!==r.email || row.vip_name!=='尊贵月卡VIP' || row.expires_at!==r.expires || Number(row.active)!==1 || row.password_hash!==r.hash)throw Error('Post-import record mismatch');
}
console.log(JSON.stringify({imported:Number(result[0].n),admins:Number(admins[0].n),verified:true}));
