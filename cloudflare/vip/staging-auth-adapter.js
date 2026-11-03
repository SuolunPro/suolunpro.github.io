/* Cloudflare VIP session adapter — staging only.
 * Does not replace Supabase bearer tokens on legacy football APIs.
 * Integrate only after those APIs accept Cloudflare-issued identity securely.
 */
export function createVipAuthAdapter(base='https://suolun-vip-staging.hjh19970220.workers.dev') {
 let token=null,expiresAt=0;
 const api=async(path,body)=>{
  const res=await fetch(base+path,{method:body?'POST':'GET',cache:'no-store',
   headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{})},
   ...(body?{body:JSON.stringify(body)}:{})});
  const data=await res.json().catch(()=>({}));
  if(!res.ok)throw Object.assign(new Error(data.error||'vip_api_failed'),{status:res.status});
  return data;
 };
 return {
  async login(email,password){
   const result=await api('/auth/login',{email,password});
   if(!result.token||!Number.isFinite(Number(result.expires_in)))throw Error('invalid_login_response');
   token=result.token;expiresAt=Date.now()+Number(result.expires_in)*1000;
   try{return await this.me()}catch(e){token=null;expiresAt=0;throw e}
  },
  async me(){
   if(!token||Date.now()>=expiresAt){token=null;throw Error('vip_session_expired')}
   const info=await api('/auth/me');
   if(!info.email||!info.expires_at||Date.parse(info.expires_at)<=Date.now())throw Error('vip_inactive');
   return {...info,vipActive:true,active:true,vipUntil:info.expires_at};
  },
  logout(){token=null;expiresAt=0},
  getToken(){return token&&Date.now()<expiresAt?token:null},
  get expiresAt(){return expiresAt}
 };
}
