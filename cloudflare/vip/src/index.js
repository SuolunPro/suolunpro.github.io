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
  try {
   if(u.pathname==='/auth/login' && request.method==='POST') {
    if(Number(request.headers.get('content-length')||0)>4096)return json({error:'bad_request'},400,headers);
    const data=await request.json();
    const email=String(data.email||'').trim().toLowerCase();
    const password=String(data.password||'');
    if(!/^\S+@\S+\.\S+$/.test(email)||email.length>254||password.length>256||!password)return json({error:'invalid_credentials'},401,headers);
    const attempts=await env.DB.prepare('SELECT failures,blocked_until FROM login_attempts WHERE email=?').bind(email).first();
    if(attempts?.blocked_until && Date.parse(attempts.blocked_until)>Date.now())return json({error:'temporarily_locked'},429,headers);
    const member=await env.DB.prepare('SELECT user_id,email,active,expires_at,password_salt,password_hash FROM vip_members WHERE email=?').bind(email).first();
    let valid=false;
    if(member?.password_salt && member?.password_hash) {
      const calculated=await hashPassword(password,member.password_salt);
      valid=calculated===member.password_hash;
    }
    if(!valid) {
      const failures=(attempts?.failures||0)+1;
      const blocked=failures>=5 ? new Date(Date.now()+15*60*1000).toISOString():null;
      await env.DB.prepare('INSERT INTO login_attempts(email,failures,blocked_until,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(email) DO UPDATE SET failures=excluded.failures,blocked_until=excluded.blocked_until,updated_at=CURRENT_TIMESTAMP').bind(email,failures>=5?0:failures,blocked).run();
      return json({error:'invalid_credentials'},401,headers);
    }
    await env.DB.prepare('DELETE FROM login_attempts WHERE email=?').bind(email).run();
    if(!member.active || Date.parse(member.expires_at)<=Date.now())return json({error:'vip_inactive'},403,headers);
    const payload=b64(enc.encode(JSON.stringify({sub:member.user_id,exp:Math.floor(Date.now()/1000)+3600})));
    return json({token:payload+'.'+await sign(payload,env.SESSION_SECRET),expires_in:3600},200,headers);
   }
   if(u.pathname==='/auth/me' && request.method==='GET') {
     const session=await verify((request.headers.get('Authorization')||'').replace(/^Bearer /i,''),env.SESSION_SECRET);
     if(!session)return json({error:'unauthorized'},401,headers);
     const m=await env.DB.prepare('SELECT email,vip_name,active,expires_at FROM vip_members WHERE user_id=?').bind(session.sub).first();
     if(!m||!m.active||Date.parse(m.expires_at)<=Date.now())return json({error:'vip_inactive'},403,headers);
     return json({email:m.email,vip_name:m.vip_name,expires_at:m.expires_at},200,headers);
   }
   return json({error:'not_found'},404,headers);
  } catch(e) {return json({error:'request_failed'},500,headers);}
 }
};