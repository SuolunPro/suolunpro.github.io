import bcrypt from 'bcryptjs';
const ORIGIN = 'https://suolunpro.github.io';
const enc = new TextEncoder();
const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const from64 = str => Uint8Array.from(atob(str.replace(/-/g,'+').replace(/_/g,'/') + '='.repeat((4-str.length%4)%4)), c=>c.charCodeAt(0));
const json = (body,status=200,extra={}) => new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...extra}});
const cors = origin => origin===ORIGIN ? {'access-control-allow-origin':ORIGIN,'vary':'Origin','access-control-allow-credentials':'true'} : {};
async function hashPassword(password,salt) {
 const key=await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveBits']);
 return b64(await crypto.subtle.deriveBits({name:'PBKDF2',salt:from64(salt),iterations:210000,hash:'SHA-256'},key,256));
}
async function sign(payload,secret) {
 const key=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return b64(await crypto.subtle.sign('HMAC',key,enc.encode(payload)));
}
async function verify(token,secret) {
 if(!token || token.length>3000)return null;
 const parts=token.split('.');if(parts.length!==2)return null;
 const key=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
 if(!await crypto.subtle.verify('HMAC',key,from64(parts[1]),enc.encode(parts[0])))return null;
 const payload=JSON.parse(new TextDecoder().decode(from64(parts[0])));
 return payload.exp>Date.now()/1000 ? payload : null;
}
export default {
 async fetch(request,env) {
  const origin=request.headers.get('Origin');
  const headers=cors(origin);
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{...headers,'access-control-allow-methods':'GET,POST,OPTIONS','access-control-allow-headers':'Content-Type,Authorization','access-control-max-age':'600'}});
  const u=new URL(request.url);
  if(u.pathname==='/health' && request.method==='GET')return json({ok:true,service:'suolun-vip',status:'staging'},200,headers);
  if(u.pathname==='/health/db' && request.method==='GET') {
    if(!env.DB || !env.SESSION_SECRET)return json({ok:false,database:'unconfigured',session:'unconfigured'},503,headers);
    try {
      const result=await env.DB.prepare('SELECT COUNT(*) AS count FROM vip_members').first();
      return json({ok:true,database:'ready',session:'configured',membership_table:result?'ready':'unavailable'},200,headers);
    } catch(e) {
      return json({ok:false,database:'unavailable'},503,headers);
    }
  }
  if(origin && origin!==ORIGIN)return json({error:'origin_not_allowed'},403,headers);
  if(!env.DB || !env.SESSION_SECRET)return json({error:'not_configured'},503,headers);
  let stage='routing';
  try {
   if(u.pathname==='/auth/login' && request.method==='POST') {
    if(Number(request.headers.get('content-length')||0)>4096)return json({error:'bad_request'},400,headers);
    const data=await request.json();
    const email=String(data.email||'').trim().toLowerCase();
    const password=String(data.password||'');
    if(!/^\S+@\S+\.\S+$/.test(email)||email.length>254||password.length>256||!password)return json({error:'invalid_credentials'},401,headers);
    stage='read_attempts';
    const attempts=await env.DB.prepare('SELECT failures,blocked_until FROM login_attempts WHERE email=?').bind(email).first();
    if(attempts?.blocked_until && Date.parse(attempts.blocked_until)>Date.now())return json({error:'temporarily_locked'},429,headers);
    stage='read_member';
    const member=await env.DB.prepare('SELECT user_id,email,active,expires_at,password_salt,password_hash FROM vip_members WHERE email=?').bind(email).first();
    stage='verify_password';
    let valid=false;
    if(member?.password_hash && /^\$2[aby]\$\d{2}\$/.test(member.password_hash)) {
      valid=await bcrypt.compare(password,member.password_hash);
    } else if(member?.password_salt && member?.password_hash) {
      const calculated=await hashPassword(password,member.password_salt);
      valid=calculated===member.password_hash;
    }
    if(!valid) {
      const failures=(attempts?.failures||0)+1;
      const blocked=failures>=5 ? new Date(Date.now()+15*60*1000).toISOString():null;
      await env.DB.prepare('INSERT INTO login_attempts(email,failures,blocked_until,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(email) DO UPDATE SET failures=excluded.failures,blocked_until=excluded.blocked_until,updated_at=CURRENT_TIMESTAMP').bind(email,failures>=5?0:failures,blocked).run();
      return json({error:'invalid_credentials'},401,headers);
    }
    stage='clear_attempts';
    await env.DB.prepare('DELETE FROM login_attempts WHERE email=?').bind(email).run();
    if(!member.active || Date.parse(member.expires_at)<=Date.now())return json({error:'vip_inactive'},403,headers);
    stage='sign_session';
    const payload=b64(enc.encode(JSON.stringify({sub:member.user_id,exp:Math.floor(Date.now()/1000)+3600})));
    return json({token:payload+'.'+await sign(payload,env.SESSION_SECRET),expires_in:3600},200,headers);
   }
   if(u.pathname==='/auth/me' && request.method==='GET') {
     const session=await verify((request.headers.get('Authorization')||'').replace(/^Bearer /i,''),env.SESSION_SECRET);
     if(!session)return json({error:'unauthorized'},401,headers);
     const m=await env.DB.prepare('SELECT email,vip_name,active,expires_at FROM vip_members WHERE user_id=?').bind(session.sub).first();
     if(!m||!m.active||Date.parse(m.expires_at)<=Date.now())return json({error:'vip_inactive'},403,headers);
     const admin=await env.DB.prepare('SELECT 1 AS allowed FROM vip_admins WHERE user_id=?').bind(session.sub).first();
     return json({email:m.email,vip_name:m.vip_name,expires_at:m.expires_at,role:admin?'admin':'vip'},200,headers);
   }
   if(u.pathname==='/predictions/days' && request.method==='GET') {
     const session=await verify((request.headers.get('Authorization')||'').replace(/^Bearer /i,''),env.SESSION_SECRET);
     if(!session)return json({error:'unauthorized'},401,headers);
     const member=await env.DB.prepare('SELECT active,expires_at FROM vip_members WHERE user_id=?').bind(session.sub).first();
     if(!member?.active||Date.parse(member.expires_at)<=Date.now())return json({error:'vip_inactive'},403,headers);
     const rows=await env.DB.prepare("SELECT sale_day FROM vip_predictions WHERE sale_day GLOB '20??-??-??' ORDER BY sale_day DESC LIMIT 60").all();
     return json({days:(rows.results||[]).map(row=>row.sale_day)},200,headers);
   }
   if(u.pathname==='/predictions' && request.method==='GET') {
     const session=await verify((request.headers.get('Authorization')||'').replace(/^Bearer /i,''),env.SESSION_SECRET);
     if(!session)return json({error:'unauthorized'},401,headers);
     const member=await env.DB.prepare('SELECT active,expires_at FROM vip_members WHERE user_id=?').bind(session.sub).first();
     if(!member?.active||Date.parse(member.expires_at)<=Date.now())return json({error:'vip_inactive'},403,headers);
     const day=u.searchParams.get('day')||'latest';
     if(day!=='latest'&&!/^20\\d{2}-(0[1-9]|1[0-2])-[0-3]\\d$/.test(day))return json({error:'invalid_day'},400,headers);
     const snapshot=await env.DB.prepare('SELECT payload FROM vip_predictions WHERE sale_day=?').bind(day).first();
     if(!snapshot)return json({error:'not_found'},404,headers);
     return new Response(snapshot.payload,{headers:{'content-type':'application/json; charset=utf-8','cache-control':'private, no-store','x-content-type-options':'nosniff',...headers}});
   }
   if(u.pathname==='/admin/members/bulk-create' && request.method==='POST') {
     const session=await verify((request.headers.get('Authorization')||'').replace(/^Bearer /i,''),env.SESSION_SECRET);
     if(!session)return json({error:'unauthorized'},401,headers);
     const admin=await env.DB.prepare('SELECT 1 AS allowed FROM vip_admins WHERE user_id=?').bind(session.sub).first();
     const current=await env.DB.prepare('SELECT active,expires_at FROM vip_members WHERE user_id=?').bind(session.sub).first();
     if(!admin||!current?.active||Date.parse(current.expires_at)<=Date.now())return json({error:'forbidden'},403,headers);
     if(Number(request.headers.get('content-length')||0)>12000)return json({error:'too_large'},413,headers);
     const body=await request.json();
     const members=body.members;
     if(!Array.isArray(members)||members.length<1||members.length>30)return json({error:'invalid_member_count'},400,headers);
     const seen=new Set(),validated=[];
     for(const m of members){
       const email=String(m.email||'').trim().toLowerCase(),expires=String(m.expires_at||'');
       const ts=Date.parse(expires);
       if(!/^\S+@\S+\.\S+$/.test(email)||email.length>254||seen.has(email)||!Number.isFinite(ts)||ts<=Date.now()||ts>Date.now()+366*86400000)return json({error:'invalid_member_input'},400,headers);
       seen.add(email);validated.push({email,expires});
     }
     const results=[];
     for(const m of validated){
       const exists=await env.DB.prepare('SELECT user_id FROM vip_members WHERE email=?').bind(m.email).first();
       if(exists){results.push({email:m.email,status:'already_exists'});continue;}
       const password=b64(crypto.getRandomValues(new Uint8Array(18)));
       const salt=null;
       const hash=await bcrypt.hash(password,10);
       try{
         await env.DB.prepare("INSERT INTO vip_members(user_id,email,vip_name,expires_at,active,password_salt,password_hash) VALUES (?,?, '尊贵月卡VIP',?,1,?,?)").bind(crypto.randomUUID(),m.email,m.expires,salt,hash).run();
         results.push({email:m.email,status:'created',expires_at:m.expires,temporary_password:password});
       }catch(e){results.push({email:m.email,status:'failed'});}
     }
     return json({ok:results.every(x=>x.status!=='failed'),results},200,headers);
   }
   if(u.pathname.startsWith('/admin/') && request.method==='POST') {
     const session=await verify((request.headers.get('Authorization')||'').replace(/^Bearer /i,''),env.SESSION_SECRET);
     if(!session)return json({error:'unauthorized'},401,headers);
     const admin=await env.DB.prepare('SELECT 1 AS allowed FROM vip_admins WHERE user_id=?').bind(session.sub).first();
     const current=await env.DB.prepare('SELECT active,expires_at FROM vip_members WHERE user_id=?').bind(session.sub).first();
     if(!admin||!current?.active||Date.parse(current.expires_at)<=Date.now())return json({error:'forbidden'},403,headers);
     if(Number(request.headers.get('content-length')||0)>4096)return json({error:'bad_request'},400,headers);
     const data=await request.json();
     const email=String(data.email||'').trim().toLowerCase();
     if(!/^\S+@\S+\.\S+$/.test(email)||email.length>254)return json({error:'invalid_email'},400,headers);
     const member=await env.DB.prepare('SELECT user_id FROM vip_members WHERE email=?').bind(email).first();
     if(u.pathname==='/admin/member/create') {
       if(member)return json({error:'already_exists'},409,headers);
       const expires=String(data.expires_at||'');
       if(!Number.isFinite(Date.parse(expires))||Date.parse(expires)<=Date.now()||Date.parse(expires)>Date.now()+366*86400000)return json({error:'invalid_expiry'},400,headers);
       const password=b64(crypto.getRandomValues(new Uint8Array(18)));
       const salt=null;
       const hash=await bcrypt.hash(password,10);
       await env.DB.prepare("INSERT INTO vip_members(user_id,email,vip_name,expires_at,active,password_salt,password_hash) VALUES (?,?, '尊贵月卡VIP',?,1,?,?)").bind(crypto.randomUUID(),email,expires,salt,hash).run();
       return json({ok:true,email,temporary_password:password,expires_at:expires},201,headers);
     }
     if(!member)return json({error:'not_found'},404,headers);
     if(u.pathname==='/admin/member/reset-password') {
       const password=b64(crypto.getRandomValues(new Uint8Array(18)));
       const salt=null;
       const hash=await bcrypt.hash(password,10);
       await env.DB.prepare('UPDATE vip_members SET password_salt=?,password_hash=?,updated_at=CURRENT_TIMESTAMP WHERE user_id=?').bind(salt,hash,member.user_id).run();
       return json({ok:true,email,temporary_password:password},200,headers);
     }
     if(u.pathname==='/admin/member/renew') {
       const days=Number(data.days);
       if(!Number.isInteger(days)||days<1||days>366)return json({error:'invalid_days'},400,headers);
       const existing=await env.DB.prepare('SELECT expires_at FROM vip_members WHERE user_id=?').bind(member.user_id).first();
       const base=Math.max(Date.now(),Date.parse(existing.expires_at));
       const expiry=new Date(base+days*86400000).toISOString();
       await env.DB.prepare('UPDATE vip_members SET expires_at=?,active=1,updated_at=CURRENT_TIMESTAMP WHERE user_id=?').bind(expiry,member.user_id).run();
       return json({ok:true,email,expires_at:expiry},200,headers);
     }
     if(u.pathname==='/admin/member/disable') {
       if(member.user_id===session.sub)return json({error:'cannot_disable_self'},400,headers);
       await env.DB.prepare('UPDATE vip_members SET active=0,updated_at=CURRENT_TIMESTAMP WHERE user_id=?').bind(member.user_id).run();
       return json({ok:true,email,active:false},200,headers);
     }
     return json({error:'not_found'},404,headers);
   }
   return json({error:'not_found'},404,headers);
  } catch(e) {console.error('VIP request failure',u.pathname,stage,e?.name||'Error',e?.message||'');const reason=stage==='verify_password' ? (e?.name||'unknown_error') : undefined;return json({error:'request_failed',stage,...(reason?{reason}:{})},500,headers);}
 }
};