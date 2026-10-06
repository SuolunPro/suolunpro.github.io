    const AUTH_BASE='https://ttydbcejxqxdkcfoizkj.supabase.co';const AUTH_KEY='sb_publishable_n5thZ1g6h93ronyzPfqhsg_N_lFaoSa';
    const AUTH_STORE='soren_auth_v2',LEGACY_AUTH_STORE='soren_auth';
    const MEMBER_CACHE_KEY='soren_member_cache_v1';
    let authSession=null,authPersistence='session',authRefreshPending=null,memberInfo=null;
    const storageRead=(store,key)=>{try{return store.getItem(key)}catch{return null}};
    const storageWrite=(store,key,value)=>{try{store.setItem(key,value);return true}catch{return false}};
    const storageDelete=(store,key)=>{try{store.removeItem(key)}catch{}};
    function clearAuthSession(){
      authSession=null;authRefreshPending=null;memberInfo=null;
      storageDelete(localStorage,AUTH_STORE);storageDelete(sessionStorage,AUTH_STORE);
      storageDelete(sessionStorage,LEGACY_AUTH_STORE);storageDelete(localStorage,MEMBER_CACHE_KEY);
    }
    function storedAuth(){
      for(const [store,mode,key] of [[localStorage,'local',AUTH_STORE],[sessionStorage,'session',AUTH_STORE],[sessionStorage,'session',LEGACY_AUTH_STORE]]){
        try{const saved=JSON.parse(storageRead(store,key)||'null');if(saved?.access_token&&saved?.user){authPersistence=mode;return saved}}catch{}
      }
      return null;
    }
    function saveAuthSession(data,remember=authPersistence==='local'){
      if(!data?.access_token||!data?.user)throw Error('登录信息不完整，请重新登录');
      const previous=authSession;
      const expires=Number(data.expires_at);
      const ttl=Number(data.expires_in);
      authSession={user:data.user,access_token:data.access_token,
        refresh_token:data.refresh_token||previous?.refresh_token||null,
        expires_at:Number.isFinite(ttl)&&ttl>0?Date.now()+ttl*1000:
          Number.isFinite(expires)&&expires>0?(expires>1e12?expires:expires*1000):Date.now()+45*60000};
      const serialized=JSON.stringify(authSession);
      storageDelete(localStorage,AUTH_STORE);storageDelete(sessionStorage,AUTH_STORE);
      storageDelete(sessionStorage,LEGACY_AUTH_STORE);
      authPersistence=remember?'local':'session';
      let stored=storageWrite(remember?localStorage:sessionStorage,AUTH_STORE,serialized);
      if(!stored&&remember){authPersistence='session';stored=storageWrite(sessionStorage,AUTH_STORE,serialized)}
      return stored&&authPersistence==='local';
    }
    function saveMemberCache(info){
      try{
        if(!authSession?.user?.id||!info||typeof info!=='object')return;
        localStorage.setItem(MEMBER_CACHE_KEY,JSON.stringify({userId:String(authSession.user.id),savedAt:Date.now(),membership:info}));
      }catch{}
    }
    function readMemberCache(maxAgeMs=30*60*1000){
      try{
        const cached=JSON.parse(localStorage.getItem(MEMBER_CACHE_KEY)||'null');
        if(!cached?.membership||String(cached.userId)!==String(authSession?.user?.id||''))return null;
        if(!Number.isFinite(Number(cached.savedAt))||Date.now()-Number(cached.savedAt)>maxAgeMs)return null;
        return cached.membership;
      }catch{return null}
    }
    function timeoutSignal(ms){
      if(typeof AbortSignal!=='undefined'&&typeof AbortSignal.timeout==='function')return AbortSignal.timeout(ms);
      if(typeof AbortController==='undefined')return undefined;
      const controller=new AbortController();
      setTimeout(()=>controller.abort(),ms);
      return controller.signal;
    }
    async function authRequest(path,body){
      // Supabase Auth uses redirect_to to route email confirmations back to this website.
      const redirectUrl=location.origin+location.pathname;
      const authPath=/^(signup|recover|resend)$/.test(path)?path+'?redirect_to='+encodeURIComponent(redirectUrl):path;
      // GoTrue reads CAPTCHA from gotrue_meta_security, not a top-level captcha_token.
      // Normalize centrally so signup, password login, recovery and resend all work.
      const payload=body&&typeof body==='object'&&typeof body.captcha_token==='string'
        ? {...body,gotrue_meta_security:{...(body.gotrue_meta_security||{}),captcha_token:body.captcha_token}}:body;
      if(payload!==body)delete payload.captcha_token;
      const authUrl=AUTH_BASE+'/auth/v1/'+authPath;
      const isPasswordLogin=path==='token?grant_type=password';
      const maxRetries=isPasswordLogin?2:(path==='signup'?1:0);
      let res;
      for(let attempt=0;;attempt++){
        try{
          res=await fetch(authUrl,{method:'POST',
            headers:{'Content-Type':'application/json','apikey':AUTH_KEY},body:JSON.stringify(payload),cache:'no-store',signal:timeoutSignal(30000)});
          break;
        }catch(error){
          // Retry transport failures only. HTTP/auth errors are handled below and are never retried.
          if(attempt>=maxRetries){
            const err=Error('当前网络连接认证服务失败，请切换网络后重试。');
            err.code='AUTH_NETWORK_ERROR';err.cause=error;throw err;
          }
          await new Promise(resolve=>setTimeout(resolve,attempt===0?800:1500));
        }
      }
      let json={};
      try{json=await res.json()}catch(_){}
      if(!res.ok){const err=Error(json.msg||json.error_description||json.message||'请求失败');err.status=res.status;throw err}
      return json;
    }
    async function refreshAuthSession(force=false){
      if(authRefreshPending)return authRefreshPending;
      authRefreshPending=(async()=>{
        const current=authSession;
        if(!current?.access_token)throw Error('LOGIN_REQUIRED');
        if(!force&&current.expires_at&&current.expires_at>Date.now()+120000)return current.access_token;
        if(!current.refresh_token){
          if(!force&&(!current.expires_at||current.expires_at>Date.now()+60000))return current.access_token;
          clearAuthSession();throw Error('LOGIN_REQUIRED');
        }
        try{
          const updated=await authRequest('token?grant_type=refresh_token',{refresh_token:current.refresh_token});
          if(!updated.access_token||!updated.refresh_token||!updated.user)throw Error('SESSION_REFRESH_INCOMPLETE');
          saveAuthSession(updated,authPersistence==='local');return authSession.access_token;
        }catch(error){
          // Another tab might have rotated the token; reuse its stored session before asking for a password.
          const parallel=storedAuth();
          if(parallel?.access_token&&parallel.refresh_token&&parallel.refresh_token!==current.refresh_token){
            authSession=parallel;
            if(!parallel.expires_at||parallel.expires_at>Date.now()+30000)return parallel.access_token;
            throw Error('SESSION_REFRESH_RETRY');
          }
          if([400,401,403].includes(error.status)||error.message==='SESSION_REFRESH_INCOMPLETE')clearAuthSession();
          throw error;
        }
      })();
      try{return await authRefreshPending}finally{authRefreshPending=null}
    }
    async function verifiedAuthToken(){
      if(!authSession?.access_token)throw Error('LOGIN_REQUIRED');
      await refreshAuthSession();
      const check=await fetch(AUTH_BASE+'/auth/v1/user',{headers:{apikey:AUTH_KEY,Authorization:'Bearer '+authSession.access_token},cache:'no-store',signal:timeoutSignal(10000)});
      if(check.status===401){
        await refreshAuthSession(true);
        const retry=await fetch(AUTH_BASE+'/auth/v1/user',{headers:{apikey:AUTH_KEY,Authorization:'Bearer '+authSession.access_token},cache:'no-store',signal:timeoutSignal(10000)});
        if(retry.status===401){clearAuthSession();throw Error('LOGIN_REQUIRED')}
        if(!retry.ok)throw Error('登录状态核验暂时失败（HTTP '+retry.status+'）');
        const user=await retry.json();
        if(!user?.id||user.id!==authSession.user?.id){clearAuthSession();throw Error('LOGIN_REQUIRED')}
        authSession.user=user;saveAuthSession(authSession,authPersistence==='local');
        return authSession.access_token;
      }
      if(!check.ok)throw Error('登录状态核验暂时失败（HTTP '+check.status+'）');
      const user=await check.json();
      if(!user?.id||user.id!==authSession.user?.id){clearAuthSession();throw Error('LOGIN_REQUIRED')}
      authSession.user=user;return authSession.access_token;
    }
    // Persistent browser-level welcome-trial marker. The API hashes it before storage.
    function welcomeBrowserId(){
      try{
        let id=localStorage.getItem('soren_visit_id');
        if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id||'')){
          id=crypto.randomUUID();localStorage.setItem('soren_visit_id',id);
        }
        return id;
      }catch{return ''}
    }
    async function authorizedApiFetch(url,options={}){
      if(!authSession?.access_token)throw Error('LOGIN_REQUIRED');
      await refreshAuthSession();
      const welcomeHeader=url.startsWith('https://ttydbcejxqxdkcfoizkj.supabase.co/functions/v1/soren-public-api-v1')
        ?{'X-Soren-Device':welcomeBrowserId()}:{};
      const request=()=>fetch(url,{...options,headers:{...(options.headers||{}),...welcomeHeader,Authorization:'Bearer '+authSession.access_token}});
      let response=await request();
      if(response.status===401&&authSession?.refresh_token){
        await refreshAuthSession(true);response=await request();
      }
      if(response.status===401){clearAuthSession();showLoginGate('登录已过期，请重新登录');throw Error('LOGIN_REQUIRED')}
      return response;
    }
    async function logoutAuth(){
      const old=authSession;clearAuthSession();
      if(old?.access_token){try{await fetch(AUTH_BASE+'/auth/v1/logout?scope=local',{
        method:'POST',headers:{apikey:AUTH_KEY,Authorization:'Bearer '+old.access_token},
        signal:timeoutSignal(5000),cache:'no-store'});}catch{}}
      location.reload();
    }

    // Password visibility is local to the input; never store or transmit the revealed text.
    function passwordInput(input){
      const wrap=el('div','password-input-wrap');
      const button=el('button','password-visibility');
      button.type='button';
      const shownIcon='<svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
      const hiddenIcon='<svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 5.1A11 11 0 0 1 12 5c6.4 0 10 7 10 7a15 15 0 0 1-3.5 4.3M6.3 6.4C3.6 8.2 2 12 2 12s3.6 7 10 7a10.8 10.8 0 0 0 4.4-.9"/><path d="M10.7 10.7a3 3 0 0 0 2.6 2.6"/></svg>';
      const update=()=>{
        const visible=input.type==='text';
        button.innerHTML=visible?hiddenIcon:shownIcon;
        button.setAttribute('aria-label',visible?'隐藏密码':'显示密码');
        button.setAttribute('aria-pressed',String(visible));
        button.title=visible?'隐藏密码':'显示密码';
      };
      button.onclick=()=>{input.type=input.type==='password'?'text':'password';update()};
      update();wrap.append(input,button);
      return wrap;
    }
    function accountPanel(){const wrap=el('div','account-panel'),title=el('h2','','会员中心'),msg=el('div','sub','');wrap.append(title,msg);if(authSession?.user){const settings=el('div','member-account member-account-primary');settings.append(el('span','','当前账户：'+authSession.user.email));const out=el('button','secondary','退出登录');out.onclick=()=>logoutAuth();settings.append(out);wrap.append(settings,memberPanel());return wrap}const email=el('input'),pass=el('input');email.type='email';email.autocomplete='email';email.placeholder='邮箱';pass.type='password';pass.autocomplete='current-password';pass.placeholder='密码（至少6位）';const rememberLabel=el('label','auth-remember'),remember=el('input');remember.type='checkbox';remember.checked=true;rememberLabel.append(remember,el('span','','在此设备保持登录（共用设备请取消）'));wrap.append(email,passwordInput(pass),rememberLabel);const legalLabel=el('label','auth-remember'),legal=el('input'),legalText=el('span');legal.type='checkbox';legal.checked=false;legalText.append(document.createTextNode('我已阅读并同意 '));const terms=document.createElement('a');terms.href='./legal.html#terms';terms.target='_blank';terms.rel='noopener';terms.textContent='《用户服务协议》';const privacy=document.createElement('a');privacy.href='./legal.html#privacy';privacy.target='_blank';privacy.rel='noopener';privacy.textContent='《隐私政策》';legalText.append(terms,document.createTextNode(' 和 '),privacy);legalLabel.append(legal,legalText);wrap.append(legalLabel);const run=async type=>{if(!email.value.trim()||!pass.value){msg.textContent='请输入邮箱和密码';return}if(type==='注册'&&!legal.checked){msg.textContent='请先阅读并同意《用户服务协议》和《隐私政策》';return}msg.textContent='处理中…';try{const body={email:email.value.trim(),password:pass.value};if(type==='注册')body.data={legal_consent:true,terms_version:'2026-10-05',privacy_version:'2026-10-05',legal_consented_at:new Date().toISOString()};const data=await authRequest(type==='注册'?'signup':'token?grant_type=password',body);if(data.access_token&&data.user){const persisted=saveAuthSession(data,remember.checked);if(remember.checked&&!persisted)msg.textContent='当前浏览器不支持持久保存，下次可能需要重新登录';else msg.textContent='登录成功';location.reload()}else msg.textContent='注册申请已提交，请查收邮箱验证邮件后登录；点击最新验证链接将返回九十刻度。'}catch(e){msg.textContent=e.message}};for(const name of ['注册','登录']){const b=el('button',name==='注册'?'':'secondary',name);b.onclick=()=>run(name);wrap.append(b)}const reset=el('button','secondary','忘记密码');reset.onclick=async()=>{if(!email.value.trim()){msg.textContent='请先填写邮箱';return}try{await authRequest('recover',{email:email.value.trim()});msg.textContent='若邮箱已注册，请查收密码重置邮件'}catch(e){msg.textContent=e.message}};wrap.append(reset);return wrap}
    async function initVisits(){try{let id=localStorage.getItem('soren_visit_id');if(!id){id=crypto.randomUUID();localStorage.setItem('soren_visit_id',id)}const res=await fetch(AUTH_BASE+'/rest/v1/rpc/soren_record_visit_v1',{method:'POST',headers:{'apikey':AUTH_KEY,'Content-Type':'application/json'},body:JSON.stringify({p_visitor:id}),signal:timeoutSignal(6000)});if(!res.ok)throw Error('counter');const n=Number(await res.json());document.getElementById('visitCount').textContent=(30000+n).toLocaleString('zh-CN')}catch(e){document.getElementById('visitCount').textContent='—'}}
    authSession=storedAuth();initVisits();
    async function recoverEmailConfirmationRedirect(){
      const hash=location.hash.startsWith('#')?new URLSearchParams(location.hash.slice(1)):null;
      if(!hash)return null;
      if(hash.has('error')){
        const code=hash.get('error_code')||hash.get('error')||'UNKNOWN';
        history.replaceState(null,'',location.pathname+location.search);
        return code==='otp_expired'?'邮箱验证链接已过期或已使用。若账号仍无法登录，请联系客服处理。':'邮箱验证未完成（'+code+'），如仍无法登录，请联系客服核实。';
      }
      const token=hash.get('access_token'),refresh=hash.get('refresh_token');
      if(!token||!refresh)return null;
      const check=await fetch(AUTH_BASE+'/auth/v1/user',{headers:{apikey:AUTH_KEY,Authorization:'Bearer '+token},cache:'no-store',signal:timeoutSignal(10000)});
      if(!check.ok)throw Error('EMAIL_CALLBACK_TOKEN_INVALID');
      const user=await check.json();
      if(!user?.id)throw Error('EMAIL_CALLBACK_USER_MISSING');
      saveAuthSession({user,access_token:token,refresh_token:refresh,expires_in:Number(hash.get('expires_in')||3600)},true);
      history.replaceState(null,'',location.pathname+location.search);
      return null;
    }
    const API='https://ttydbcejxqxdkcfoizkj.supabase.co/functions/v1/soren-public-api-v1';
    function customerApiUrl(params){
      const qs=params instanceof URLSearchParams?new URLSearchParams(params):new URLSearchParams(params||{});
      // The production database is in Mumbai. Running the data-heavy function in
      // the same region avoids repeated inter-region round trips before first paint.
      qs.set('forceFunctionRegion','ap-south-1');
      return API+'?'+qs.toString();
    }
    const CLIENT_DIAG_API=AUTH_BASE+'/functions/v1/soren-client-diag-v1';
    const CLIENT_BUILD='20261006-fast-live-v1';
    function clientDiag(stage,details={}){
      try{
        const body=JSON.stringify({stage,version:CLIENT_BUILD,browserId:welcomeBrowserId(),
          online:navigator.onLine!==false,...details});
        // Diagnostic payload contains no email, password, token or membership data.
        fetch(CLIENT_DIAG_API,{method:'POST',headers:{'Content-Type':'application/json'},
          body,cache:'no-store',keepalive:true,signal:timeoutSignal(6000)}).catch(()=>{});
      }catch{}
    }
    const OKOOO_SHADOW_API='https://tqlibowvnwfkaseqqvvp.supabase.co/functions/v1/hao-r9-discovery-test-v01';
    // Feedback uses an isolated client-database Edge Function; existing membership API is unchanged.
    const FEEDBACK_API=AUTH_BASE+'/functions/v1/soren-feedback-api-v1';
    let feedbackMode=null,feedbackFilter='all',feedbackDraft={category:'功能建议',content:''};
    function feedbackError(code){
      return ({LOGIN_REQUIRED:'请重新登录后提交',FORBIDDEN:'当前账号没有留言管理权限',
        RATE_LIMIT:'留言过于频繁，请稍后再试（10分钟最多3条，每24小时最多15条）',
        INVALID_LENGTH:'留言内容请控制在1至500字以内',INVALID_FEEDBACK:'请选择类型并填写留言内容',
        INVALID_REPLY:'请输入有效回复内容',INVALID_BODY:'请求内容格式不正确',
        SERVICE_UNAVAILABLE:'留言服务暂不可用，请稍后重试',SUBMIT_FAILED:'提交失败，请稍后再试',
        REPLY_FAILED:'回复失败，请稍后再试'})[code]||'操作未成功，请稍后重试';
    }
    async function feedbackRequest(query,body){
      const qs=new URLSearchParams(query),res=await authorizedApiFetch(FEEDBACK_API+'?'+qs,{
        ...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}),
        cache:'no-store',signal:timeoutSignal(12000)});
      let data=null;try{data=await res.json()}catch{}
      if(!res.ok||data?.ok!==true)throw Error(feedbackError(data?.error));
      return data;
    }
    function openFeedback(mode='write'){
      feedbackMode=mode;state.tab='profile';
      document.querySelectorAll('.nav').forEach(n=>n.classList.toggle('active',n.dataset.tab==='profile'));
      render();
    }
    function feedbackTime(value){
      if(!value)return '';
      try{return new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',
        month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})}
      catch{return ''}
    }
    function showAccountNotice(info){
      const notice=info?.accountNotice;
      if(!notice?.message||!authSession?.user?.id)return;
      const seenKey='soren_account_notice_seen_v1:'+String(authSession.user.id)+':'+String(notice.code||'NOTICE')+':'+String(notice.createdAt||'');
      try{if(sessionStorage.getItem(seenKey)==='1')return}catch{}
      let shade=document.getElementById('accountNoticeShade');
      if(shade)shade.remove();
      shade=document.createElement('div');shade.id='accountNoticeShade';
      shade.style.cssText='position:fixed;inset:0;z-index:99999;background:rgba(17,20,26,.72);display:grid;place-items:center;padding:22px;backdrop-filter:blur(3px)';
      const card=document.createElement('section');
      card.style.cssText='width:min(100%,390px);background:#fff;border-radius:18px;padding:20px 18px 16px;box-shadow:0 18px 55px #0005;border:1px solid #ead8b6;color:#272b31';
      const badge=document.createElement('div');
      badge.textContent='账号安全提醒';
      badge.style.cssText='display:inline-flex;align-items:center;padding:5px 9px;border-radius:999px;background:#fff3dd;color:#9a5d13;font-size:11px;font-weight:800';
      const title=document.createElement('h2');
      title.textContent=String(notice.title||'邀请行为安全提醒');
      title.style.cssText='margin:12px 0 8px;font-size:20px;line-height:1.35';
      const msg=document.createElement('p');
      msg.textContent=String(notice.message);
      msg.style.cssText='margin:0;color:#525964;font-size:13px;line-height:1.8;white-space:pre-wrap';
      const note=document.createElement('p');
      note.textContent='如认为属于正常多人共用设备场景，可向管理员说明情况；平台将以人工复核结果为准。';
      note.style.cssText='margin:12px 0 0;padding:10px 11px;border-radius:10px;background:#f6f7f9;color:#6e7480;font-size:11px;line-height:1.65';
      const btn=document.createElement('button');
      btn.type='button';btn.textContent='我已知悉';
      btn.style.cssText='width:100%;margin-top:15px;border:0;border-radius:11px;background:#303846;color:#fff;min-height:44px;font-size:14px;font-weight:800';
      btn.onclick=()=>{try{sessionStorage.setItem(seenKey,'1')}catch{}shade.remove()};
      card.append(badge,title,msg,note,btn);shade.append(card);document.body.append(shade);
    }
    async function membershipFetch(){
      const diagStarted=Date.now();clientDiag('membership_start',{attempt:1});
      // Some Android/MIUI browsers can deliver the server response after a
      // short transport stall. Do not let an aggressive per-request abort race
      // turn a successful 200 membership check into a blocking boot failure.
      let r;
      try{
        r=await authorizedApiFetch(customerApiUrl({view:'membership'}),{cache:'no-store',signal:timeoutSignal(20000)});
      }catch(error){
        clientDiag('membership_fetch_error',{attempt:1,elapsedMs:Date.now()-diagStarted,errorName:error?.name,errorMessage:error?.message});
        if(!isTransientConnectionError(error))throw error;
        await new Promise(resolve=>setTimeout(resolve,700));
        clientDiag('membership_retry',{attempt:2,elapsedMs:Date.now()-diagStarted});
        try{r=await authorizedApiFetch(customerApiUrl({view:'membership'}),{cache:'no-store',signal:timeoutSignal(30000)});}
        catch(retryError){
          clientDiag('membership_fetch_error',{attempt:2,elapsedMs:Date.now()-diagStarted,errorName:retryError?.name,errorMessage:retryError?.message});
          throw retryError;
        }
      }
      clientDiag('membership_response',{attempt:1,elapsedMs:Date.now()-diagStarted,status:r.status});
      let j;
      try{j=await r.json()}catch(error){
        clientDiag('membership_json_error',{elapsedMs:Date.now()-diagStarted,status:r.status,errorName:error?.name,errorMessage:error?.message});
        const err=Error('会员信息响应读取失败，请稍后重试');err.cause=error;throw err;
      }
      if(!r.ok||j.ok!==true||!j.membership){
        clientDiag('membership_invalid_payload',{elapsedMs:Date.now()-diagStarted,status:r.status});
        throw Error('会员信息暂不可用，请稍后重试');
      }
      clientDiag('membership_success',{elapsedMs:Date.now()-diagStarted,status:r.status});
      memberInfo=j.membership;saveMemberCache(memberInfo);showAccountNotice(memberInfo);return memberInfo;
    }
    function isTransientConnectionError(error){
      return error instanceof TypeError||['AbortError','TimeoutError'].includes(error?.name)||
        /network|fetch|timeout|load failed|temporarily|会员信息暂不可用|SESSION_REFRESH_RETRY|HTTP 5\d\d/i.test(String(error?.message||error||''));
    }
    async function membershipFetchWithRetry(attempts=4){
      let lastError=null;
      for(let attempt=0;attempt<attempts;attempt++){
        try{return await membershipFetch()}catch(error){
          lastError=error;
          if(!authSession?.access_token||error?.message==='LOGIN_REQUIRED'||!isTransientConnectionError(error))throw error;
          if(attempt<attempts-1)await new Promise(resolve=>setTimeout(resolve,[450,900,1800][Math.min(attempt,2)]));
        }
      }
      throw lastError||Error('会员信息暂不可用，请稍后重试');
    }
    function memberPanel(){
      const panel=el('section','member-panel');
      if(!memberInfo){const card=el('div','member-card');card.append(el('h3','','会员状态'),el('p','member-muted','正在核验会员状态…'));panel.append(card);return panel}
      const expiryRaw=memberInfo.vipActive===true?(memberInfo.vipUntil||memberInfo.memberUntil):memberInfo.memberUntil;
      const expires=expiryRaw?new Date(expiryRaw).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):null;
      const stateCard=el('div','member-card member-state');
      stateCard.append(el('h3','','我的会员'));
      const label=memberInfo.legacyGrace?'今日活动体验中':memberInfo.active?'尊贵月卡VIP':'会员已到期';
      stateCard.append(el('div','member-deadline',label));
      stateCard.append(el('div','member-muted',expires?'有效期至：'+expires+'（北京时间）':memberInfo.legacyGrace?'免费体验截至9月24日00:00（北京时间）':'有效会员可查看当日完整赛事数据与分析。'));
      panel.append(stateCard);
      // The single membership plan is handled manually by customer service;
      // there is no self-service payment in the current backend.
      const purchaseCard=el('div','member-card member-purchase');
      const purchaseHeader=el('div','member-purchase-head');
      purchaseHeader.append(el('span','member-purchase-eyebrow','九十刻度 · 会员中心'),
        el('span','member-beta-tag','活动期间'));
      purchaseCard.append(purchaseHeader,el('h3','','尊贵月卡VIP'),
        el('p','member-muted','解锁九十刻度会员赛事数据、今日优选与风险分析功能。'));
      const planGrid=el('div','member-plan-grid');
      const makePlan=(name,monthly,formal,features)=>{
        const card=el('div','member-plan member-plan-promo');
        const top=el('div','member-plan-top');
        top.append(el('h4','',name),el('span','member-plan-tag member-plan-sale-tag','限时优惠'));
        const priceBox=el('div','member-plan-price-box');
        const cost=el('div','member-plan-price');
        cost.append(el('strong','','¥'+monthly),el('span','','/30天'));
        const saving=el('span','member-plan-saving','立省 ¥30');
        priceBox.append(cost,saving);
        const compare=el('div','member-plan-compare');
        const original=document.createElement('span');original.className='member-plan-original';original.textContent='原价 ¥'+formal;
        compare.append(original,el('span','member-plan-discount','约5折'));
        card.append(top,priceBox,compare);
        const items=el('ul','member-plan-list');
        features.forEach(feature=>items.append(el('li','',feature)));
        card.append(items,el('div','member-plan-future','活动结束恢复 ¥'+formal+'/月'));
        return card;
      };
      const membershipPlan=makePlan('尊贵月卡VIP','29.9','59.9',
        ['解锁当日完整赛事数据与分析','查看「今日优选」筛选结果','查看胜平负、让球等会员赛事数据','使用已开放的冷门预警与风险保护功能']);
      const contactNote=el('p','member-muted member-purchase-help','点击申请后确认会员协议，确认后才会显示官方客服联系方式。');
      const vipRisk=el('p','member-muted member-vip-risk','足球数据、概率模型及风险分析服务；预测存在不确定性，不构成收益承诺。非自动续费。');
      const membershipContact=el('button','member-plan-apply','申请开通VIP');
      const service=el('div','member-purchase-service member-vip-service');service.hidden=true;
      const serviceTitle=el('strong','','开通申请已生成');
      const serviceText=el('p','','请复制申请信息并添加官方客服。确认付款后由管理员人工开通，返回本页即可查看VIP有效期。');
      const contactRow=el('div','member-contact-row'),copyWechat=el('button','member-wechat-copy','复制客服微信'),copyApply=el('button','member-wechat-copy','复制申请信息');
      const wechatText=el('span','','官方客服：GoodLuck_H3');let vipApplyMessage='';
      copyWechat.onclick=async()=>{try{await navigator.clipboard.writeText('GoodLuck_H3');contactNote.textContent='客服微信已复制：GoodLuck_H3'}catch{window.prompt('请复制官方客服微信号','GoodLuck_H3')}};
      copyApply.onclick=async()=>{try{await navigator.clipboard.writeText(vipApplyMessage);contactNote.textContent='VIP申请信息已复制，请发送给官方客服。'}catch{window.prompt('请复制VIP申请信息',vipApplyMessage)}};
      contactRow.append(wechatText,copyWechat,copyApply);service.append(serviceTitle,serviceText,contactRow,contactNote);

      const openVipConsent=()=>{
        const overlay=el('div','vip-consent-overlay'),dialog=el('div','vip-consent-dialog');
        dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');dialog.setAttribute('aria-label','开通尊贵月卡VIP');
        const close=el('button','vip-consent-close','×');close.type='button';close.setAttribute('aria-label','关闭');
        dialog.append(close,el('h3','','开通尊贵月卡VIP'),el('div','vip-consent-plan','¥29.9 / 30天 · 非自动续费'),
          el('p','vip-consent-risk','九十刻度提供足球赛事数据、概率模型及风险分析服务。预测存在不确定性，不构成收益承诺。'));
        const agreement=el('p','vip-consent-agreement','点击下方按钮即表示您已阅读并同意 ');
        const link=document.createElement('a');link.href='./legal.html#vip';link.target='_blank';link.rel='noopener';link.textContent='《尊贵月卡VIP会员服务协议》';
        agreement.append(link);dialog.append(agreement);
        const status=el('p','vip-consent-error',''),actions=el('div','vip-consent-actions vip-consent-actions-single'),cancel=el('button','secondary','取消'),confirm=el('button','','我已阅读并同意 · 继续开通');
        let submitting=false;
        const dismiss=()=>{if(!submitting)overlay.remove()};close.onclick=dismiss;cancel.onclick=dismiss;overlay.onclick=e=>{if(e.target===overlay)dismiss()};
        confirm.onclick=async()=>{
          if(submitting)return;submitting=true;confirm.disabled=true;cancel.disabled=true;close.disabled=true;confirm.textContent='正在生成申请…';status.textContent='';
          try{
            if(!authSession?.access_token||!authSession?.user?.id)throw Error('LOGIN_REQUIRED');
            const consentRes=await fetch(AUTH_BASE+'/rest/v1/soren_vip_consents_v1',{
              method:'POST',headers:{apikey:AUTH_KEY,Authorization:'Bearer '+authSession.access_token,'Content-Type':'application/json',Prefer:'return=minimal'},
              body:JSON.stringify({user_id:authSession.user.id,agreement_version:'2026-10-05',plan_code:'vip_monthly',price_cents:2990,duration_days:30,source:'vip_apply'}),
              cache:'no-store',signal:timeoutSignal(10000)
            });
            if(consentRes.status===401)throw Error('LOGIN_REQUIRED');
            if(!consentRes.ok)throw Error('CONSENT_SAVE_FAILED');
            vipApplyMessage='九十刻度尊贵月卡VIP开通申请\\n注册邮箱：'+String(authSession.user.email||'')+'\\n方案：尊贵月卡VIP 29.9元/30天\\n自动续费：否\\n会员协议版本：2026-10-05\\n用户已主动确认同意会员服务协议';
            service.hidden=false;membershipContact.hidden=true;contactNote.textContent='申请已生成。请复制客服微信和申请信息，联系官方客服办理。';overlay.remove();
            requestAnimationFrame(()=>service.scrollIntoView({behavior:'smooth',block:'nearest'}));
          }catch(e){
            submitting=false;confirm.disabled=false;cancel.disabled=false;close.disabled=false;confirm.textContent='我已阅读并同意 · 继续开通';
            status.textContent=e?.message==='LOGIN_REQUIRED'?'登录状态已失效，请重新登录后申请。':'申请暂未生成，请检查网络后重试。';
          }
        };
        actions.append(cancel,confirm);dialog.append(status,actions);overlay.append(dialog);document.body.append(overlay);
      };
      membershipContact.onclick=openVipConsent;
      membershipPlan.append(vipRisk,membershipContact);
      planGrid.append(membershipPlan);
      const explainer=el('div','member-beta-explainer');
      explainer.append(el('strong','','开通流程'),
        el('p','','① 确认29.9元/30天方案 → ② 阅读并同意会员协议 → ③ 申请后获取官方客服 → ④ 确认付款并人工开通。当前不自动续费。'));
      purchaseCard.append(planGrid,explainer,service);
      panel.append(purchaseCard);
      return panel;
    }
    function renderMemberRequired(){
      const box=$('content');box.replaceChildren(sectionHead('会员赛事数据','当日赛事分析'));
      const trial=memberInfo?.trialStatus;
      const blocked=trial==='DEVICE_USED'||trial==='REVIEW_REQUIRED';
      const browserUnavailable=trial==='DEVICE_REQUIRED'||trial==='CHECK_UNAVAILABLE';
      const p=el('section','member-panel');
      p.append(el('h3','',blocked?'新人体验资格暂不可领取':browserUnavailable?'新人体验资格暂不可核验':'会员有效期已结束'),
        el('p','',blocked?'该浏览器的新人体验资格可能已被领取。账号仍可正常登录，已开通的会员权益不受影响；如有疑问请联系客服核实。':browserUnavailable?'请开启浏览器本地存储后重新登录；如果仍无法领取，请联系客服核实。':'当日完整赛事数据与分析目前仅向有效会员开放。可前往「我的」查看会员方案与有效期。'));
      const b=el('button','','前往我的会员中心');b.onclick=()=>{state.tab='profile';document.querySelectorAll('.nav').forEach(n=>n.classList.toggle('active',n.dataset.tab==='profile'));render()};p.append(b);box.append(p);
    }

    function renderPaidMemberRequired(){
      const box=$('content');box.replaceChildren(sectionHead('冷门预警','会员专享'));
      const p=el('section','member-zone-lock');
      p.append(el('h3','','冷门预警 · 会员专享'),
        el('p','','该功能仅对尊贵月卡 VIP 会员开放。开通会员后，可查看冷门预警、风险依据及相关深度分析。'));
      const b=el('button','','查看会员方案');
      b.onclick=()=>{state.tab='profile';document.querySelectorAll('.nav').forEach(n=>n.classList.toggle('active',n.dataset.tab==='profile'));render()};
      p.append(b);box.append(p);
    }
    function memberPct3(v){return Array.isArray(v)?v.map(x=>x!==null&&x!==undefined&&x!==''&&Number.isFinite(Number(x))?Number(x).toFixed(1)+'%':'—'):['—','—','—']}
    function memberOdds3(v){return Array.isArray(v)?v.map(x=>x!==null&&x!==undefined&&x!==''&&Number.isFinite(Number(x))?Number(x).toFixed(2):'—').join(' / '):'—'}
    function memberSigned3(v){return Array.isArray(v)?v.map(x=>x!==null&&x!==undefined&&x!==''&&Number.isFinite(Number(x))?(Number(x)>0?'+':'')+Number(x).toFixed(0):'—').join(' / '):'—'}
    function normalizeShadowAnalysis(value){
      const source=value?.analysis&&typeof value.analysis==='object'?value.analysis:(value&&typeof value==='object'?value:{});
      const m99=source.market_99||source.market99||{},bf=source.betfair||{},kelly=source.kelly||{},intel=source.intelligence||{};
      const number=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))?Number(v):null;
      const trio=v=>({home:number(v?.home),draw:number(v?.draw),away:number(v?.away)});
      const clean=v=>String(v||'').replace(/\\+["']?\s*\/>/g,'').replace(/<[^>]*>/g,'').replace(/\s+/g,' ').trim();
      const cleanList=v=>Array.isArray(v)?[...new Set(v.map(clean).filter(Boolean))]:[];
      const out={
        market99:{probabilities:trio(m99.probabilities_pct||m99.probabilities),top:clean(m99.top)||null},
        betfair:{share:trio(bf.share_pct||bf.share),top:clean(bf.top)||null,coldHeat:trio(bf.cold_heat||bf.coldHeat),profitIndex:trio(bf.profit_index||bf.profitIndex)},
        kelly:{lowestDirection:clean(kelly.lowest_direction||kelly.lowestDirection)||null,lowestValue:number(kelly.lowest_value??kelly.lowestValue),completeCount:number(kelly.complete_count??kelly.completeCount)??0},
        intelligence:{highlights:cleanList(intel.highlights).slice(0,3),injuryCount:number(intel.injury_count??intel.injuryCount)??0,impactSide:clean(intel.impact_side||intel.impactSide)||null,impactLevel:clean(intel.impact_level||intel.impactLevel)||null},
        flags:cleanList(source.flags).slice(0,6),
        capturedAt:source.capturedAt||source.captured_at||null
      };
      out.available=[...Object.values(out.market99.probabilities),...Object.values(out.betfair.share)].some(v=>v!==null)||
        out.kelly.completeCount>0||out.intelligence.highlights.length>0||out.flags.length>0;
      return out;
    }
    function shadowTop1Relation(analysis,top1){
      const dir=v=>({H:'主胜',D:'平',A:'客胜','平局':'平','主胜':'主胜','平':'平','客胜':'客胜'})[String(v||'')]||null;
      const top=dir(top1);if(!top)return '中性';
      const dirs=[analysis.market99.top,analysis.betfair.top,analysis.kelly.lowestDirection].map(dir).filter(Boolean);
      if(!dirs.length)return '中性';
      const same=dirs.some(x=>x===top),opposite=dirs.filter(x=>x!==top);
      if(same&&opposite.length)return '冲突';
      if(same)return '支持原Top1';
      return new Set(opposite).size===1?'反对原Top1':'冲突';
    }
    function renderShadowAnalysisFields(holder,value,options={}){
      const a=normalizeShadowAnalysis(value),line=(wrap,label,val)=>{const x=el('div','member-zone-proof-line');x.append(el('span','',label),el('b','',String(val??'—')));wrap.append(x)};
      holder.replaceChildren();
      if(options.title)holder.append(el('div','member-zone-proof-title',options.title));
      if(!a.available){holder.append(el('div','member-zone-intel-state','本场深度市场分析暂无可展示数据'));return a}
      const pct=v=>v===null?'—':v.toFixed(1)+'%',num=(v,d=0)=>v===null?'—':v.toFixed(d);
      if(options.top1){
        line(holder,'与原Top1',shadowTop1Relation(a,options.top1));
        if(options.conclusion)line(holder,'九十刻度结论',options.conclusion);
      }
      const pg=el('div','member-zone-proof-probs');
      [['机构主胜',a.market99.probabilities.home],['机构平局',a.market99.probabilities.draw],['机构客胜',a.market99.probabilities.away]].forEach(([label,value])=>{const x=el('div','member-zone-proof-prob');x.append(el('span','',label),el('b','',pct(value)));pg.append(x)});
      holder.append(pg);
      line(holder,'机构主方向',a.market99.top||'待确认');
      line(holder,'市场资金 主 / 平 / 客',[a.betfair.share.home,a.betfair.share.draw,a.betfair.share.away].map(pct).join(' / '));
      line(holder,'市场资金主方向',a.betfair.top||'待确认');
      line(holder,'市场冷热 主 / 平 / 客',[a.betfair.coldHeat.home,a.betfair.coldHeat.draw,a.betfair.coldHeat.away].map(v=>num(v)).join(' / '));
      line(holder,'市场盈亏 主 / 平 / 客',[a.betfair.profitIndex.home,a.betfair.profitIndex.draw,a.betfair.profitIndex.away].map(v=>num(v)).join(' / '));
      line(holder,'凯利最低方向',(a.kelly.lowestDirection||'待确认')+(a.kelly.lowestValue!==null?' · '+num(a.kelly.lowestValue,3):''));
      line(holder,'凯利完整机构',a.kelly.completeCount+' 家');
      if(a.flags.length){holder.append(el('b','','系统识别要点'));const ul=el('ul','member-zone-intel-list');a.flags.forEach(x=>ul.append(el('li','',x)));holder.append(ul)}
      line(holder,'情报影响',(a.intelligence.impactSide||'中性')+' · '+(a.intelligence.impactLevel||'低'));
      line(holder,'有效伤停/阵容',a.intelligence.injuryCount+' 条');
      if(a.intelligence.highlights.length){const ul=el('ul','member-zone-intel-list');a.intelligence.highlights.forEach(x=>ul.append(el('li','',x)));holder.append(ul)}
      line(holder,'深度分析更新',a.capturedAt?fmtStamp(a.capturedAt):'时间待确认');
      return a;
    }
    // Cold-warning cards are DOM-heavy. Reuse the exact page while its source
    // object is unchanged; a successful changed API response gets a new object
    // and therefore a fresh render automatically.
    const memberZonePageCache=new WeakMap();
    const memberZoneDataCache=new Map();
    const memberIntelCache=new Map();
    let memberZoneFingerprint='',memberZoneRequest=null;

    async function loadMemberIntelProof(date,no){
      const key=String(date)+'|'+String(no).padStart(3,'0');
      const cached=memberIntelCache.get(key);
      if(cached&&Date.now()-cached.at<5*60*1000)return cached.data;
      const qs=new URLSearchParams({view:'member-intel',date:String(date),no:String(no).padStart(3,'0')});
      const r=await authorizedApiFetch(OKOOO_SHADOW_API+'?'+qs.toString(),{cache:'no-store',signal:timeoutSignal(10000)});
      const j=await r.json().catch(()=>null);
      if(!r.ok||j?.ok!==true)throw Error(j?.error||'情报暂不可用');
      memberIntelCache.set(key,{at:Date.now(),data:j});
      while(memberIntelCache.size>40)memberIntelCache.delete(memberIntelCache.keys().next().value);
      return j;
    }
    function renderMemberZone(){
      const box=$('content');box.replaceChildren(sectionHead('冷门预警','重点避开 · 让球保护 · 风险观察'));
      if(memberInfo?.vipActive!==true){renderPaidMemberRequired();return}
      if(!state.memberZoneLoading&&!state.memberZoneError&&state.memberZone){
        const cached=memberZonePageCache.get(state.memberZone);
        if(cached){box.append(cached);return}
      }
      const page=el('div','member-zone-page');
      const info=el('details','cold-warning-info compact');info.open=true;
      const infoSummary=el('summary','','冷门预警更新说明');
      const infoBody=el('div','cold-warning-info-body');
      infoBody.append(
        el('p','','每日冷门预警通常于北京时间12:00前后陆续发布。'),
        el('p','','建议在赛前2–4小时再次查看。随着比赛临近，赔率、资金、盘口及赛前情报会持续变化，冷门预警通常会逐步趋于稳定。'),
        el('p','','冷门预警以最后一次有效赛前版本为准。开球后立即冻结，不会根据赛果修改。'),
        el('p','','不同数据项的更新时间可能存在差异，请以页面显示的最新更新时间为准。'),
        el('p','','点击「查看依据」可查看本场赔率、资金、盘口及风险信号。')
      );
      info.append(infoSummary,infoBody);
      page.append(info);
      if(state.memberZoneLoading){page.append(el('div','empty','','正在读取冷门识别…'));box.append(page);return}
      if(state.memberZoneError){page.append(el('div','empty','',state.memberZoneError));box.append(page);return}
      const rows=state.memberZone?.rows||[];
      const zoneDate=state.memberZone?.date||memberZoneDate();

      const hasMemberNumber=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v));
      const fmtPct=v=>hasMemberNumber(v)?Number(v).toFixed(1)+'%':'—';
      const fmtPp=v=>hasMemberNumber(v)?(Number(v)>=0?'+':'')+Number(v).toFixed(1)+'pp':'—';
      const fmtNum=v=>hasMemberNumber(v)?Number(v).toFixed(0):'—';
      const fundPct=v=>hasMemberNumber(v)?fmtPct(v):'—';
      const fundPp=v=>hasMemberNumber(v)?fmtPp(v):'—';
      const fundNum=v=>hasMemberNumber(v)?fmtNum(v):'—';
      const addLine=(wrap,label,value)=>{const x=el('div','member-zone-proof-line');x.append(el('span','',label),el('b','',String(value??'—')));wrap.append(x)};
      const handicapText=h=>{
        if(!h)return '未发布';
        const first=h.top1?(h.top1+' '+fmtPct(h.top1Probability)):'—';
        const second=h.second?(h.second+' '+fmtPct(h.secondProbability)):'';
        return (h.official===null||h.official===undefined?'':('官方 '+(Number(h.official)>0?'+':'')+h.official+' · '))+first+(second?' / '+second:'');
      };
      const resultCls=x=>x?.evaluable===true?(x.hit===true?'hit':'miss'):'';

      // Backend is the single three-tier publication gate.
      // Yellow/orange are observation-only; only formal red warnings expose a direction.
      const publishable=rows.filter(row=>row?.coldRecognition?.customerVisible===true);

      if(!publishable.length){
        const empty=el('div','empty','','今日暂无达到展示门槛的冷门风险');
        page.append(empty);
        if(state.memberZone)memberZonePageCache.set(state.memberZone,page);
        box.append(page);return;
      }

      const historicalShadowAvoidSamples=new Set([
        '2026-09-25|008',
        '2026-09-26|003','2026-09-26|006','2026-09-26|008','2026-09-26|013',
        '2026-09-27|009'
      ]);
      const historicalHandicapReference24=new Map([
        ['2026-09-24|002',['让负','让平']],
        ['2026-09-24|004',['让负','让平']],
        ['2026-09-24|006',['让负','让平']],
        ['2026-09-24|007',['让负','让平']]
      ]);
      const historicalHandicapSamples=new Set([
        '2026-09-25|013',
        '2026-09-26|002','2026-09-26|021','2026-09-26|023','2026-09-26|024','2026-09-26|025',
        '2026-09-27|003','2026-09-27|008',
        '2026-09-28|002','2026-09-28|003','2026-09-28|004','2026-09-28|006','2026-09-28|008',
        '2026-09-29|012'
      ]);
      const historicalHandicapReferenceSamples=new Set([
        '2026-09-24|002','2026-09-24|004','2026-09-24|006','2026-09-24|007'
      ]);
      const recoveredHistoricalHandicapTop2=new Map([
        ['2026-09-24|002',['让负','让平']],
        ['2026-09-24|004',['让负','让平']],
        ['2026-09-24|006',['让负','让平']],
        ['2026-09-24|007',['让负','让平']],
        ['2026-09-26|021',['让负','让平']],
        ['2026-09-26|023',['让负','让平']],
        ['2026-09-26|024',['让负','让胜']],
        ['2026-09-26|025',['让负','让平']],
        ['2026-09-27|008',['让胜','让平']],
        ['2026-09-29|012',['让胜','让平']]
      ]);
      const cleanColdRiskText=v=>{
        const s=String(v||'').trim();
        if(!s)return '';
        if(/HUR.*红灯/.test(s))return '热门稳定性不足';
        if(/原始首选置信度偏低/.test(s))return '原Top1置信度偏低';
        if(/原始首选概率低于50%/.test(s))return '原Top1优势不足';
        if(/William.*升赔/.test(s))return '主流欧赔对原Top1支持减弱';
        if(/竞彩HAD.*冲突/.test(s))return '官方SP与主流市场出现分歧';
        if(/亚盘.*反向/.test(s))return '亚盘多机构与原Top1背离';
        if(/市场.*反向/.test(s))return '市场综合方向与原Top1背离';
        if(/情报.*反向|重要利空/.test(s))return '赛前情报对原Top1不利';
        if(/人气过热/.test(s))return '人气偏热，市场支持不足';
        return s.replace(/仅计风险，不生成方向/g,'').replace(/[，,;；]+$/,'').trim();
      };
      const buildColdRiskSummary=(row,cold,route)=>{
        const gate=(cold?.gate&&typeof cold.gate==='object')?cold.gate:{};
        const pop=(cold?.popularity&&typeof cold.popularity==='object')?cold.popularity:{};
        const list=[];
        const push=v=>{const t=cleanColdRiskText(v);if(t&&!list.includes(t))list.push(t)};
        (Array.isArray(cold?.vipEvidence)?cold.vipEvidence:[]).forEach(push);
        (Array.isArray(cold?.evidence)?cold.evidence:[]).forEach(push);
        if(gate.asianAdverseTop===true)push('亚盘多机构与原Top1背离');
        if(gate.shadowMarketAdverse===true)push('市场综合方向与原Top1背离');
        if(gate.shadowIntelligenceAdverseTop===true)push('赛前情报对原Top1不利');
        if(pop.divergence===true)push('人气偏热，市场支持不足');
        if(pop.fundAnomaly===true)push('资金结构出现异常');
        if(!list.length&&route?.displayReason)push(route.displayReason);
        if(!list.length&&cold?.customerRiskScore>=4)push('多项赛前风险指标同时触发');
        return list.slice(0,2).join(' · ');
      };
      const validDailyHandicap=x=>['让胜','让平','让负'].includes(String(x||''));
      const coldDailyPerformance={
        avoid:{label:'重点避开',hit:0,total:0},
        handicap:{label:'让球保护',hit:0,total:0},
        reference:{label:'历史让球参考',hit:0,total:0}
      };
      for(const row of publishable){
        const st=row.settlement||{};
        if(st.verified!==true)continue;
        const cold=row.coldRecognition||{};
        const route=(cold.customerRoute&&typeof cold.customerRoute==='object')?cold.customerRoute:{};
        const key=String(zoneDate)+'|'+String(row.no||'').padStart(3,'0');
        const actualFt=String(st.ftResult||'');
        const actualH=String(st.handicapResult||'');
        const historicalShadow=historicalShadowAvoidSamples.has(key);
        const historicalReference=historicalHandicapReferenceSamples.has(key);
        const historicalHp=historicalHandicapSamples.has(key);
        if(historicalShadow){
          const top=String(cold.originalTop1||row.model?.top1||'');
          const evaluable=['主胜','客胜'].includes(top)&&['主胜','平','客胜'].includes(actualFt);
          if(evaluable){
            coldDailyPerformance.avoid.total++;
            const hit=top==='主胜'?['平','客胜'].includes(actualFt):['主胜','平'].includes(actualFt);
            if(hit)coldDailyPerformance.avoid.hit++;
          }
          continue;
        }
        if(historicalReference){
          const picks=recoveredHistoricalHandicapTop2.get(key)||[];
          if(validDailyHandicap(actualH)&&picks.length>=2){
            coldDailyPerformance.reference.total++;
            if(picks.includes(actualH))coldDailyPerformance.reference.hit++;
          }
          continue;
        }
        if(historicalHp){
          const hp=row.model?.handicap||{};
          const recovered=recoveredHistoricalHandicapTop2.get(key)||null;
          const p1=recovered?.[0]||(validDailyHandicap(hp.top1)?String(hp.top1):null);
          const p2=recovered?.[1]||(validDailyHandicap(hp.second)&&String(hp.second)!==p1?String(hp.second):null);
          if(validDailyHandicap(actualH)&&validDailyHandicap(p1)&&validDailyHandicap(p2)){
            coldDailyPerformance.handicap.total++;
            if([p1,p2].includes(actualH))coldDailyPerformance.handicap.hit++;
          }
          continue;
        }
        const routeType=String(route.type||'');
        if(routeType==='FOCUS_AVOID'){
          const top=String(route.originalTop1||cold.originalTop1||row.model?.top1||'');
          const evaluable=['主胜','客胜'].includes(top)&&['主胜','平','客胜'].includes(actualFt);
          if(evaluable){
            coldDailyPerformance.avoid.total++;
            const hit=top==='主胜'?['平','客胜'].includes(actualFt):['主胜','平'].includes(actualFt);
            if(hit)coldDailyPerformance.avoid.hit++;
          }
        }else if(routeType==='HANDICAP_PROTECT'){
          const hp=row.model?.handicap||{};
          const picks=Array.isArray(route.handicapPicks)&&route.handicapPicks.length>=2
            ?route.handicapPicks.filter(validDailyHandicap).slice(0,2)
            :[hp.top1,hp.second].filter(validDailyHandicap).map(String).slice(0,2);
          if(validDailyHandicap(actualH)&&picks.length>=2){
            coldDailyPerformance.handicap.total++;
            if(picks.includes(actualH))coldDailyPerformance.handicap.hit++;
          }
        }
      }
      const dailyStats=Object.values(coldDailyPerformance).filter(x=>x.total>0);
      if(dailyStats.length){
        const perf=el('section','cold-daily-performance');
        const ph=el('div','cold-daily-performance-head');
        ph.append(
          el('strong','','当日表现'),
          el('span','',dailyStats.reduce((n,x)=>n+x.total,0)+'场已结算')
        );
        perf.append(ph);
        const grid=el('div','cold-daily-performance-grid');
        dailyStats.forEach(x=>{
          const pct=x.total?((x.hit/x.total)*100):0;
          const item=el('div','cold-daily-performance-item');
          item.append(
            el('span','cold-daily-performance-label',x.label),
            el('b','cold-daily-performance-score',x.hit+' / '+x.total),
            el('span','cold-daily-performance-pct',pct.toFixed(1).replace(/\.0$/,'')+'%')
          );
          grid.append(item);
        });
        perf.append(grid);
        page.append(perf);
      }

      for(const row of publishable){
        const st=row.settlement||{},ftEv=st.ftEvaluation||null,hEv=st.handicapEvaluation||null;
        const cold=row.coldRecognition||null;
        const probs=Array.isArray(row.model?.probability)?row.model.probability:[null,null,null];
        const ftProbByPick={主胜:Number(probs[0]),平:Number(probs[1]),客胜:Number(probs[2])};
        const sortFtPicksByProb=picks=>[...picks].sort((a,b)=>{
          const pa=Number.isFinite(ftProbByPick[a])?ftProbByPick[a]:-Infinity;
          const pb=Number.isFinite(ftProbByPick[b])?ftProbByPick[b]:-Infinity;
          return pb-pa;
        });
        const isHomeTop=row.model?.top1==='主胜';
        const tier=String(cold?.customerTier||'持续观察');
        const isCooling=tier==='风险回落';
        const validHandicap=x=>['让胜','让平','让负'].includes(String(x||''));
        const hp=row.model?.handicap||{};
        const handicapPrimary=validHandicap(hp.top1)?String(hp.top1):null;
        const handicapCover=validHandicap(hp.second)&&String(hp.second)!==handicapPrimary?String(hp.second):null;
        const route=(cold?.customerRoute&&typeof cold.customerRoute==='object')?cold.customerRoute:null;
        const routeType=String(route?.type||'');
        const routeSource=String(route?.source||'');
        const sampleKey=String(zoneDate)+'|'+String(row.no||'').padStart(3,'0');
        const historicalShadow=historicalShadowAvoidSamples.has(sampleKey);
        const historicalHandicapReference=historicalHandicapReferenceSamples.has(sampleKey);
        const historicalHandicap=historicalHandicapSamples.has(sampleKey)||historicalHandicapReference;
        const recoveredHandicapPair=recoveredHistoricalHandicapTop2.get(sampleKey)||null;
        const historicalReference24=historicalHandicapReference;
        const historicalReferencePair=historicalHandicapReference?recoveredHandicapPair:null;
        const historicalHandicapPrimary=recoveredHandicapPair?.[0]||handicapPrimary;
        const historicalHandicapCover=recoveredHandicapPair?.[1]||handicapCover;
        const historicalHandicapRecovered=Array.isArray(recoveredHandicapPair);
        const legacyHistorical=String(zoneDate)<'2026-09-30'&&routeSource==='LEGACY_NO_STRICT_SEED';
        const shadowTop=String(cold?.originalTop1||row.model?.top1||'');
        const shadowIsHomeTop=shadowTop==='主胜';
        const isFormal=cold?.vipPublish===true&&['主胜','客胜'].includes(String(row.model?.top1||''));
        const displayMode=historicalShadow
          ?'HIST_SHADOW'
          :historicalReference24
            ?'HIST_REFERENCE'
            :historicalHandicap
            ?'HIST_HANDICAP'
            :legacyHistorical
              ?'LEGACY'
              :routeType==='FOCUS_AVOID'
                ?'FT_AVOID'
                :routeType==='HANDICAP_PROTECT'
                  ?'HANDICAP_PROTECT'
                  :routeType==='RISK_OBSERVE'
                    ?'OBSERVE'
                    :(isFormal?'FT_AVOID':(!isCooling&&handicapPrimary&&handicapCover?'HANDICAP_PROTECT':'OBSERVE'));
        const displayLabel=displayMode==='FT_AVOID'
          ?'重点避开'
          :displayMode==='HIST_SHADOW'
            ?'历史影子验证'
            :displayMode==='HIST_REFERENCE'
              ?'历史让球参考'
              :displayMode==='HIST_HANDICAP'
              ?(historicalHandicapReference?'历史让球参考':'让球保护')
              :displayMode==='HANDICAP_PROTECT'
                ?'让球保护'
              :displayMode==='LEGACY'
                ?'历史风险记录'
                :'风险观察';
        const direction=displayMode==='FT_AVOID'
          ?(route?.direction||(isHomeTop?'主队不胜（平 / 客）':'主队不败（主 / 平）'))
          :displayMode==='HIST_SHADOW'
            ?(shadowIsHomeTop?'主队不胜（平 / 客）':'主队不败（主 / 平）')
            :displayMode==='HIST_REFERENCE'
              ?historicalReferencePair.join(' + ')
              :displayMode==='HIST_HANDICAP'
              ?([historicalHandicapPrimary,historicalHandicapCover].filter(Boolean).join(' + ')||'让球方向待恢复')
              :displayMode==='HANDICAP_PROTECT'
                ?((Array.isArray(route?.handicapPicks)&&route.handicapPicks.length>=2)?route.handicapPicks.join(' + '):(handicapPrimary+' + '+handicapCover))
              :displayMode==='LEGACY'
                ?'历史赛前风险记录'
                :(isCooling?'原方向仍获支持':'暂不发布方向');
        const refText=(displayMode==='FT_AVOID'||displayMode==='HIST_SHADOW')
          ?sortFtPicksByProb(
            displayMode==='HIST_SHADOW'
              ?(shadowIsHomeTop?['平','客胜']:['主胜','平'])
              :(Array.isArray(route?.ftPicks)&&route.ftPicks.length
                ?route.ftPicks
                :(isHomeTop?['平','客胜']:['主胜','平']))
          ).join(' + ')
          :'';
        const badgeClass=(displayMode==='FT_AVOID'||displayMode==='HIST_SHADOW')?'formal-cold':(displayMode==='HANDICAP_PROTECT'||displayMode==='HIST_HANDICAP'||displayMode==='HIST_REFERENCE')?'risk-high':'light-risk';

        const card=el('article','card member-zone-regular-card cold-card-v3');
        const head=el('div','cold-card-head');
        const id=el('div','cold-card-meta');
        id.append(
          el('span','cold-card-league',safe(row.league)),
          el('span','',fmtTime(row.kickoff)),
          el('span','','· '+safe(row.no))
        );
        const cleanBadge=displayMode==='LEGACY'?'历史记录':displayLabel;
        head.append(id,el('span','cold-card-badge '+badgeClass,cleanBadge));
        card.append(head);

        const matchline=el('div','cold-card-match');
        const homeNode=teamNode(row.home,row.homeLogo),awayNode=teamNode(row.away,row.awayLogo);
        homeNode.classList.add('cold-card-team','home');
        awayNode.classList.add('cold-card-team','away');
        matchline.append(homeNode,el('div','cold-card-vs','VS'),awayNode);
        card.append(matchline);

        const action=el('div','cold-card-action '+displayMode.toLowerCase());
        const actionLabel=(displayMode==='FT_AVOID'||displayMode==='HIST_SHADOW')
          ?'防范方向'
          :(displayMode==='HANDICAP_PROTECT'||displayMode==='HIST_HANDICAP'||displayMode==='HIST_REFERENCE')
            ?(displayMode==='HIST_REFERENCE'||(displayMode==='HIST_HANDICAP'&&historicalHandicapReference)?'让球参考':'让球保护')
            :displayMode==='LEGACY'
              ?'赛前风险'
              :'风险状态';
        const actionValue=displayMode==='LEGACY'
          ?'风险已记录'
          :displayMode==='OBSERVE'
            ?'继续观察'
            :direction;
        action.append(
          el('span','cold-card-action-label',actionLabel),
          el('strong','cold-card-action-value',actionValue)
        );
        const chips=el('div','cold-card-chips');
        if(displayMode==='FT_AVOID'||displayMode==='HIST_SHADOW'){
          const picks=sortFtPicksByProb(
            displayMode==='HIST_SHADOW'
              ?(shadowIsHomeTop?['平','客胜']:['主胜','平'])
              :(Array.isArray(route?.ftPicks)&&route.ftPicks.length?route.ftPicks:(isHomeTop?['平','客胜']:['主胜','平']))
          );
          picks.forEach((x,i)=>chips.append(el('span',i===0?'primary':'',String(x))));
        }else if(displayMode==='HIST_REFERENCE'){
          chips.append(el('span','primary','参考 '+historicalReferencePair[0]));
          chips.append(el('span','','保护 '+historicalReferencePair[1]));
        }else if(displayMode==='HIST_HANDICAP'){
          if(historicalHandicapPrimary)chips.append(el('span','primary','主推 '+historicalHandicapPrimary));
          if(historicalHandicapCover)chips.append(el('span','','保护 '+historicalHandicapCover));
        }else if(displayMode==='HANDICAP_PROTECT'){
          const primary=(Array.isArray(route?.handicapPicks)&&route.handicapPicks[0])||handicapPrimary;
          const cover=(Array.isArray(route?.handicapPicks)&&route.handicapPicks[1])||handicapCover;
          if(primary)chips.append(el('span','primary','主推 '+primary));
          if(cover)chips.append(el('span','','保护 '+cover));
        }else if(displayMode==='LEGACY'){
          chips.append(el('span','','历史赛前记录'));
        }else{
          chips.append(el('span','','等待更多赛前确认'));
        }
        if(chips.childNodes.length)action.append(chips);
        card.append(action);

        const riskSummaryText=buildColdRiskSummary(row,cold,route);
        if(riskSummaryText){
          const riskSummary=el('div','cold-card-risk-summary');
          riskSummary.append(
            el('span','cold-card-risk-summary-label','风险摘要'),
            el('span','cold-card-risk-summary-text',riskSummaryText)
          );
          card.append(riskSummary);
        }

        const resultLine=el('div','cold-card-result');
        const scoreText=st.score||((st.homeScore??'—')+' : '+(st.awayScore??'—'));
        if(st.verified){
          const actual=st.ftResult;
          resultLine.append(el('b','cold-card-score',scoreText));
          if(displayMode==='LEGACY'){
            resultLine.append(el('span','cold-card-result-text','已结算 · 历史记录'));
          }else if(displayMode==='HIST_SHADOW'){
            const avoidHit=shadowIsHomeTop?['平','客胜'].includes(actual):['主胜','平'].includes(actual);
            resultLine.classList.add(avoidHit?'hit':'miss');
            resultLine.append(el('span','cold-card-result-text',
              (actual?actual+' · ':'')+(avoidHit?'✓ 避开成功':'× 避开失败')));
          }else if(displayMode==='FT_AVOID'){
            const avoidHit=isHomeTop?['平','客胜'].includes(actual):['主胜','平'].includes(actual);
            resultLine.classList.add(avoidHit?'hit':'miss');
            resultLine.append(el('span','cold-card-result-text',
              (actual?actual+' · ':'')+(avoidHit?'✓ 避开成功':'× 避开失败')));
          }else if(displayMode==='HIST_REFERENCE'){
            const handicapActual=String(st.handicapResult||'');
            const evaluable=validHandicap(handicapActual);
            const protectHit=evaluable&&historicalReferencePair.includes(handicapActual);
            if(evaluable)resultLine.classList.add(protectHit?'hit':'miss');
            resultLine.append(el('span','cold-card-result-text',
              evaluable?(handicapActual+' · '+(protectHit?'✓ 参考命中':'× 参考未中')):'让球赛果待核验'));
          }else if(displayMode==='HIST_HANDICAP'){
            const handicapActual=String(st.handicapResult||'');
            const evaluable=validHandicap(handicapActual)&&validHandicap(historicalHandicapPrimary)&&validHandicap(historicalHandicapCover);
            const protectHit=evaluable&&[historicalHandicapPrimary,historicalHandicapCover].includes(handicapActual);
            if(evaluable)resultLine.classList.add(protectHit?'hit':'miss');
            resultLine.append(el('span','cold-card-result-text',
              evaluable?(handicapActual+' · '+(protectHit?'✓ 保护命中':'× 保护未中')):'让球赛果待核验'));
          }else if(displayMode==='HANDICAP_PROTECT'){
            const handicapActual=String(st.handicapResult||'');
            const primary=(Array.isArray(route?.handicapPicks)&&route.handicapPicks[0])||handicapPrimary;
            const cover=(Array.isArray(route?.handicapPicks)&&route.handicapPicks[1])||handicapCover;
            const evaluable=validHandicap(handicapActual);
            const protectHit=evaluable&&[primary,cover].includes(handicapActual);
            if(evaluable)resultLine.classList.add(protectHit?'hit':'miss');
            resultLine.append(el('span','cold-card-result-text',
              evaluable?(handicapActual+' · '+(protectHit?'✓ 保护命中':'× 保护未中')):'让球赛果待核验'));
          }else{
            resultLine.append(el('span','cold-card-result-text',(actual?actual+' · ':'')+'已结算'));
          }
        }else{
          resultLine.classList.add('pending');
          resultLine.append(
            el('b','cold-card-score','—'),
            el('span','cold-card-result-text','等待评测')
          );
        }
        card.append(resultLine);

        const details=el('details','member-zone-proof');
        details.append(el('summary','','查看依据'));
        const body=el('div','member-zone-proof-body');

        const psec=el('section','member-zone-proof-section');
        psec.append(el('div','member-zone-proof-title','九十刻度'));
        const pg=el('div','member-zone-proof-probs');
        ['主胜','平','客胜'].forEach((lab,i)=>{
          const x=el('div','member-zone-proof-prob');
          x.append(el('span','',lab),el('b','',fmtPct(probs[i])));pg.append(x);
        });
        psec.append(pg);
        addLine(psec,'原始首选 / 次选',(row.model?.top1||'—')+' / '+(row.model?.second||'—'));
        addLine(psec,'让球模型',handicapText(row.model?.handicap));
        body.append(psec);

        // Customer-facing summary of the useful shadow-observation layer.
        // Keep source/vendor names and internal scoring thresholds private.
        if(cold){
          const gate=(cold.gate&&typeof cold.gate==='object')?cold.gate:{};
          const ssec=el('section','member-zone-proof-section');
          ssec.append(el('div','member-zone-proof-title','冷门观察'));
          addLine(ssec,'风险状态',displayLabel);
          addLine(ssec,'方向状态',displayMode==='LEGACY'?'历史记录，不按新规则重算':direction);
          if(displayMode==='HIST_SHADOW')addLine(ssec,'验证口径','历史影子样本，不计入9月30日起正式新规则成绩');
          if(displayMode==='HIST_REFERENCE')addLine(ssec,'历史让球参考来源','赛前冻结HHAD三项概率排序；当时正式让球结论为PASS，不计作正式推荐');
          if(displayMode==='HIST_HANDICAP')addLine(ssec,'让球Top2来源',
            historicalHandicapRecovered?'赛前冻结HHAD三项概率排序恢复（非赛后倒推）':'赛前快照直接冻结Top1 + 第二方向');
          if(displayMode==='HIST_HANDICAP')addLine(ssec,'验证口径',
            historicalHandicapReference?'当时正式让球为PASS；仅展示赛前冻结概率恢复参考，不计正式成绩':'历史让球保护样本，不计入9月30日起正式新规则成绩');
          if(displayMode==='HANDICAP_PROTECT')addLine(ssec,'让球主推 / 保护',handicapPrimary+' / '+handicapCover);
          if(row.behavior?.top1)addLine(ssec,'市场资金',(row.behavior.top1||'待确认')+' · '+(row.behavior.strength||'观察'));
          const unifiedRiskDirection=(cold.riskDirection&&typeof cold.riskDirection==='object')?cold.riskDirection:null;
          const unifiedDirectionConfirmed=unifiedRiskDirection?.status==='CONFIRMED'&&!!unifiedRiskDirection?.direction;
          addLine(ssec,'多源一致性',unifiedDirectionConfirmed?('已形成确认 · '+unifiedRiskDirection.direction):(gate.stableDirection===true?'已形成确认':'方向待确认'));
          const shadowFlags=Array.isArray(gate.shadow_flags)?gate.shadow_flags:(Array.isArray(gate.shadowFlags)?gate.shadowFlags:[]);
          const shadowVotes=(gate.shadow_market_votes&&typeof gate.shadow_market_votes==='object')?gate.shadow_market_votes:((gate.shadowMarketVotes&&typeof gate.shadowMarketVotes==='object')?gate.shadowMarketVotes:null);
          if(shadowVotes){
            const voteTop=[['主胜',Number(shadowVotes.H||0)],['平',Number(shadowVotes.D||0)],['客胜',Number(shadowVotes.A||0)]].sort((a,b)=>b[1]-a[1])[0];
            addLine(ssec,'99家判断',voteTop[1]>0?(voteTop[0]+'占优 · '+((gate.shadow_market_anomaly===true||gate.shadowMarketAnomaly===true)?'与资金/市场存在分歧':'市场结构正常')):'待确认');
          }
          if(shadowFlags.length)addLine(ssec,'资金判断',shadowFlags.slice(0,2).join('；'));
          if(Number(gate.shadow_kelly_complete??gate.shadowKellyComplete??0)>0)addLine(ssec,'凯利覆盖',String(gate.shadow_kelly_complete??gate.shadowKellyComplete)+'家机构 · 已纳入交叉核验');
          if((gate.shadow_intelligence_observed===true||gate.shadowIntelligenceObserved===true)){
            addLine(ssec,'影子情报判断',String(gate.shadow_intelligence_summary??gate.shadowIntelligenceSummary??'已完成赛前情报核验'));
            if(Number(gate.shadow_injury_count??gate.shadowInjuryCount??0)>0)addLine(ssec,'有效伤停/阵容',String(gate.shadow_injury_count??gate.shadowInjuryCount)+'条');
          }
          if(gate.asianState){
            const asiaRelation=gate.asianSupportsTop===true?'支持原方向':gate.asianAdverseTop===true?'反向原方向':'分歧 / 中性';
            const asiaCount=Number(gate.asianSources||0);
            addLine(ssec,'亚盘共识',asiaRelation+' · '+String(gate.asianStrength||'观察')+(asiaCount?(' · '+asiaCount+'家'):''));
          }else if(Array.isArray(row.asianHandicap)&&row.asianHandicap.length){
            addLine(ssec,'亚盘共识','持续观察');
          }
          if(row.intelligence)addLine(ssec,'赛前情报',(row.intelligence.impactSide||'中性')+' · '+(row.intelligence.impactLevel||'低'));
          else if(gate.shadowIntelligenceImpactSide){
            addLine(ssec,'赛前情报',String(gate.shadowIntelligenceImpactSide)+' · '+String(gate.shadowIntelligenceImpactLevel||'低'));
            addLine(ssec,'与原Top1',gate.shadowIntelligenceAdverseTop===true?'反向':gate.shadowIntelligenceSupportsTop===true?'支持':'中性');
          }
          body.append(ssec);
        }

        if(row.behavior&&Array.isArray(row.behavior.avgProbability)){
          const b=row.behavior,cons=el('section','member-zone-proof-section');
          cons.append(el('div','member-zone-proof-title','99家机构观点'));
          addLine(cons,'机构概率',memberPct3(b.avgProbability).join(' / '));
          addLine(cons,'共识方向',b.top1||'待确认');
          addLine(cons,'共识强度',b.strength||'待确认');
          const relation=b.top1&&row.model?.top1?(b.top1===row.model.top1?'与九十刻度同向':'与九十刻度分歧'):'待确认';
          addLine(cons,'方向关系',relation);
          if(b.drawSignal===true)addLine(cons,'平局观察','平局信号增强');
          if(b.overheat===true)addLine(cons,'市场热度','热度偏高，需继续观察');
          body.append(cons);
        }

        if(cold?.popularity){
          const pop=cold.popularity,popsec=el('section','member-zone-proof-section');
          const hasFundSnapshot=[pop.marketProbability,pop.betfairShare,pop.sportterySavedShare,pop.gap,pop.heat,pop.profitIndex].some(hasMemberNumber);
          if(hasFundSnapshot){
            popsec.append(el('div','member-zone-proof-title','人气—市场背离'));
            addLine(popsec,'市场概率',fundPct(pop.marketProbability));
            addLine(popsec,'必发资金占比',fundPct(pop.betfairShare));
            addLine(popsec,'竞彩保存资金占比',fundPct(pop.sportterySavedShare));
            addLine(popsec,'人气溢价',fundPp(pop.gap));
            addLine(popsec,'冷热指数',fundNum(pop.heat));
            addLine(popsec,'盈亏指数',fundNum(pop.profitIndex));
            addLine(popsec,'William概率变化',fundPp(pop.williamProbabilityMove));
            addLine(popsec,'识别结果',pop.divergence?'人气过热 / 市场支持不足':pop.fundAnomaly?'资金盈亏异常':'暂无强背离');
            body.append(popsec);
          }
        }

        const msec=el('section','member-zone-proof-section');
        msec.append(el('div','member-zone-proof-title','赔率与资金'));
        addLine(msec,'市场确认',row.conclusion?.marketConfirm||'待确认');
        addLine(msec,'资金行为',row.conclusion?.fundBehavior||'待确认');
        addLine(msec,'威廉概率',memberPct3(row.market?.currentFair).join(' / '));
        addLine(msec,'威廉 初盘→赛前',memberOdds3(row.market?.initialOdds)+' → '+memberOdds3(row.market?.currentOdds));
        if(row.officialMarket?.had)addLine(msec,'体彩胜平负SP',memberOdds3(row.officialMarket.had.odds));
        if(row.officialMarket?.hhad){
          const ln=row.officialMarket.hhad.line;
          addLine(msec,'体彩让球SP',(Number.isFinite(Number(ln))?('主'+(Number(ln)>0?'+':'')+Number(ln)):'让球')+' · '+memberOdds3(row.officialMarket.hhad.odds));
        }
        if(Array.isArray(row.asianHandicap)&&row.asianHandicap.length){
          row.asianHandicap.slice(0,4).forEach(x=>{
            const fmtLine=v=>v===null||v===undefined?'—':String(v);
            const fmtWater=v=>Number.isFinite(Number(v))?Number(v).toFixed(2):'—';
            addLine(msec,String(x.institution||'亚盘'),
              fmtLine(x.initialLine)+' '+fmtWater(x.initialHomeWater)+'/'+fmtWater(x.initialAwayWater)+
              ' → '+fmtLine(x.currentLine)+' '+fmtWater(x.currentHomeWater)+'/'+fmtWater(x.currentAwayWater));
          });
        }
        body.append(msec);

        if(row.intelligence){
          const isec=el('section','member-zone-proof-section');
          isec.append(el('div','member-zone-proof-title','赛前情报'));
          addLine(isec,'总体影响',(row.intelligence.impactSide||'中性')+' · '+(row.intelligence.impactLevel||'低'));
          if(row.intelligence.riskActivated===true)addLine(isec,'结论校验','已进入冷门识别');
          (Array.isArray(row.intelligence.categories)?row.intelligence.categories:[]).slice(0,5)
            .forEach(x=>addLine(isec,String(x.side||'')+' '+String(x.type||'情报'),String(x.summary||'')));
          body.append(isec);
        }

        // Load the same saved analysis object used by the match-detail preview.
        // The member endpoint returns only the customer-safe projection.
        const xsec=el('section','member-zone-proof-section');
        xsec.append(el('div','member-zone-proof-title','九十刻度 · 深度市场依据'),el('div','member-zone-intel-state','展开后读取最新赛前深度分析…'));
        body.append(xsec);
        const inlineShadow=(row?.shadowAnalysis&&typeof row.shadowAnalysis==='object')?row.shadowAnalysis:((cold?.gate?.shadowAnalysis&&typeof cold.gate.shadowAnalysis==='object')?cold.gate.shadowAnalysis:null);
        let shadowProofLoaded=false;
        const loadShadowProof=async()=>{
          if(shadowProofLoaded)return;shadowProofLoaded=true;
          try{
            const analysis=inlineShadow||(await loadMemberIntelProof(zoneDate,row.no))?.analysis;
            renderShadowAnalysisFields(xsec,analysis,{title:'九十刻度 · 深度市场依据',top1:row.model?.top1,conclusion:displayLabel});
          }catch(error){
            shadowProofLoaded=false;
            xsec.replaceChildren(el('div','member-zone-proof-title','九十刻度 · 深度市场依据'),el('div','member-zone-intel-state','深度市场依据读取失败，请稍后重试'));
          }
        };
        if(inlineShadow)loadShadowProof();
        details.addEventListener('toggle',()=>{if(details.open)loadShadowProof()},{passive:true});

        const cov=row.coverage||{},dsec=el('section','member-zone-proof-section');
        dsec.append(el('div','member-zone-proof-title','数据完整度'));
        addLine(dsec,'九十刻度 / 威廉 / 体彩 / 亚盘',
          [cov.model,cov.william,cov.sporttery,cov.asian].map(v=>v===true?'✓':'—').join(' / '));
        const fundsIntelLine=el('div','member-zone-proof-line');
        fundsIntelLine.append(el('span','','资金 / 情报'));
        const coverageFundsIntelValue=el('b','',[cov.behavior,cov.intelligence].map(v=>v===true?'✓':'—').join(' / '));
        fundsIntelLine.append(coverageFundsIntelValue);
        dsec.append(fundsIntelLine);
        body.append(dsec);


        details.append(body);card.append(details);page.append(card);
      }
      if(state.memberZone)memberZonePageCache.set(state.memberZone,page);
      box.append(page);
    }
    function memberZoneDate(){
      return state.model==='cold'
        ?(state.selectedDate||state.baseDate||state.today?.date||beijingToday())
        :(state.baseDate||state.today?.date||state.selectedDate||beijingToday());
    }

    function memberZoneStorageKey(date){return 'soren_member_zone_snapshot_v2:'+String(date)}
    function restoreMemberZoneSnapshot(date){
      try{
        const raw=localStorage.getItem(memberZoneStorageKey(date));
        if(!raw)return false;
        const x=JSON.parse(raw);
        if(!x?.zone||x.zone.date!==date)return false;
        // Active-day snapshots are only a fast first paint. The authoritative
        // request still refreshes them in the background below.
        const maxAge=date<beijingToday()?24*60*60*1000:6*60*60*1000;
        if(Date.now()-Number(x.at||0)>maxAge)return false;
        state.memberZone=x.zone;
        memberZoneFingerprint=String(x.fingerprint||JSON.stringify(x.zone));
        memberZoneDataCache.set(date,{at:Number(x.at||0),zone:x.zone,membership:memberInfo,fingerprint:memberZoneFingerprint});
        return true;
      }catch{return false}
    }
    function persistMemberZoneSnapshot(date,zone,fingerprint){
      try{localStorage.setItem(memberZoneStorageKey(date),JSON.stringify({at:Date.now(),zone,fingerprint}))}catch{}
    }

    async function loadMemberZone(silent=false){
      if(memberInfo?.vipActive!==true)return;
      const zoneDate=memberZoneDate();
      const cacheTtl=zoneDate<beijingToday()?30*60*1000:2*60*1000;
      let cachedZone=memberZoneDataCache.get(zoneDate);
      if(!cachedZone&&restoreMemberZoneSnapshot(zoneDate))cachedZone=memberZoneDataCache.get(zoneDate);
      if(cachedZone){
        // Stale-while-revalidate for the active cold-warning page: paint the last
        // successful payload immediately. Fresh entries need no network request;
        // stale entries continue below and refresh silently without blocking UI.
        state.memberZone=cachedZone.zone;
        if(cachedZone.membership)memberInfo=cachedZone.membership;
        memberZoneFingerprint=cachedZone.fingerprint;
        state.memberZoneLoading=false;
        state.memberZoneError=null;
        if(!silent){
          if(state.tab==='memberzone')renderMemberZone();
          else if(state.tab==='home'&&state.model==='cold')render();
        }
        if(Date.now()-cachedZone.at<cacheTtl)return;
        silent=true;
      }
      // Deduplicate a foreground tap and a scheduled refresh for the same date.
      if(memberZoneRequest?.date===zoneDate){
        try{await memberZoneRequest.promise}finally{
          if(!silent&&state.tab==='home'&&state.model==='cold')renderMemberZone();
        }
        return;
      }
      if(!silent){state.memberZoneLoading=true;state.memberZoneError=null;renderMemberZone()}
      let changed=false;
      const request=(async()=>{
        // Cold list uses the lightweight projection; heavy proof stays lazy in member-intel.
        const qs=new URLSearchParams({view:'cold-feed',date:zoneDate,_:String(Date.now())});
        const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),10000);let r;
        try{r=await authorizedApiFetch(customerApiUrl(qs),{cache:'no-store',signal:ctrl.signal})}
        finally{clearTimeout(timer)}
        const j=await r.json();
        if(r.status===403&&j.error==='VIP_MEMBERSHIP_REQUIRED'){memberInfo=j.membership||memberInfo;throw Error('冷门预警暂未全面开放')}
        if(!r.ok||j.ok!==true||!j.zone)throw Error(j.error||'会员专区暂不可用');
        memberInfo=j.membership||memberInfo;
        const fingerprint=JSON.stringify(j.zone);
        if(!state.memberZone||state.memberZone.date!==j.zone.date||fingerprint!==memberZoneFingerprint){
          state.memberZone=j.zone;
          memberZoneFingerprint=fingerprint;
          changed=true;
        }
        memberZoneDataCache.set(zoneDate,{at:Date.now(),zone:j.zone,membership:j.membership||memberInfo,fingerprint});
        persistMemberZoneSnapshot(zoneDate,j.zone,fingerprint);
        while(memberZoneDataCache.size>10)memberZoneDataCache.delete(memberZoneDataCache.keys().next().value);
        state.memberZoneError=null;
      })();
      memberZoneRequest={date:zoneDate,promise:request};
      try{await request}
      catch(e){if(!silent)state.memberZoneError=e.message||'会员专区暂不可用'}
      finally{
        if(memberZoneRequest?.promise===request)memberZoneRequest=null;
        if(!silent)state.memberZoneLoading=false;
        // Silent refreshes must not rebuild the expensive cold-warning page
        // when the payload is byte-for-byte unchanged.
        if(!silent||changed){
          if(state.tab==='memberzone')renderMemberZone();
          else if(state.tab==='home'&&state.model==='cold')render();
        }
      }
    }
    const TURNSTILE_SITE_KEY='0x4AAAAAAFBKndRZlD2qH4Km';
    let turnstileLoadPromise=null;
    function loadTurnstile(){
      if(window.turnstile)return Promise.resolve(window.turnstile);
      if(!turnstileLoadPromise)turnstileLoadPromise=new Promise((resolve,reject)=>{
        const script=document.createElement('script');
        script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        script.async=true;script.onload=()=>window.turnstile?resolve(window.turnstile):reject(Error('验证码服务尚未就绪'));
        script.onerror=()=>reject(Error('验证码加载失败，请检查网络后刷新页面'));document.head.append(script);
      }).catch(error=>{turnstileLoadPromise=null;throw error});
      return turnstileLoadPromise;
    }
    function showLoginGate(message=''){
      document.querySelector('.app').style.display='none';document.querySelector('.bottom').style.display='none';
      let gate=document.getElementById('loginGate');
      if(!gate){gate=document.createElement('div');gate.id='loginGate';gate.className='account-panel';gate.style='max-width:420px;margin:7vh auto;padding:25px';document.body.append(gate)}
      gate.replaceChildren();
      const h=document.createElement('h2');h.textContent='九十刻度 · 账号注册';
      const note=document.createElement('p');note.textContent='新用户填写邮箱和密码即可注册；已有账号可直接登录。';
      gate.append(h,note);
      const email=document.createElement('input'),pass=document.createElement('input'),msg=document.createElement('p');
      email.type='email';email.autocomplete='email';email.placeholder='邮箱';pass.type='password';pass.autocomplete='new-password';pass.placeholder='密码（至少6位）';
      const rememberLabel=document.createElement('label'),remember=document.createElement('input');
      rememberLabel.className='auth-remember';remember.type='checkbox';remember.checked=true;
      rememberLabel.append(remember,document.createTextNode('在此设备保持登录（共用设备请取消）'));
      const captchaBox=document.createElement('div');captchaBox.style='display:none';
      const captchaLabel=document.createElement('p');captchaLabel.style='font-size:12px;color:#666;margin:8px 0';
      captchaLabel.textContent='';captchaLabel.style.display='none';
      const legalLabel=document.createElement('label'),legal=document.createElement('input'),legalText=document.createElement('span');
      legalLabel.className='auth-remember';legal.type='checkbox';legal.checked=false;
      legalText.append(document.createTextNode('我已阅读并同意 '));
      const terms=document.createElement('a');terms.href='./legal.html#terms';terms.target='_blank';terms.rel='noopener';terms.textContent='《用户服务协议》';
      const privacy=document.createElement('a');privacy.href='./legal.html#privacy';privacy.target='_blank';privacy.rel='noopener';privacy.textContent='《隐私政策》';
      legalText.append(terms,document.createTextNode(' 和 '),privacy);legalLabel.append(legal,legalText);
      gate.append(email,passwordInput(pass),rememberLabel,legalLabel,captchaLabel,captchaBox,msg);
      if(message)msg.textContent=message;
      let captchaToken='',captchaWidget=null;
      // Turnstile temporarily disabled for auth network diagnosis.
      const takeToken=()=>'';
      const resetCaptcha=()=>{};
      const saveSession=data=>{const persisted=saveAuthSession(data,remember.checked);if(remember.checked&&!persisted)msg.textContent='当前浏览器无法保存登录状态，下次可能需要重新登录';location.reload()};
      const mainActions=document.createElement('div');mainActions.className='auth-main-actions';
      for(const mode of ['注册','登录']){
        const btn=document.createElement('button');btn.textContent=mode==='注册'?'注册新账号':'已有账号 · 登录';
        btn.className=mode==='注册'?'auth-action-register':'auth-action-login';
        btn.type='button';
        btn.onclick=async()=>{
          if(!email.value.trim()||!pass.value){msg.textContent='请填写邮箱和密码';return}
          if(mode==='注册'&&pass.value.length<6){msg.textContent='密码至少6位';return}
          if(mode==='注册'&&!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.value.trim())){msg.textContent='请填写有效的邮箱地址，例如 name@example.com';return}
          if(mode==='注册'&&!legal.checked){msg.textContent='请先阅读并同意《用户服务协议》和《隐私政策》';return}
          let token;try{token=takeToken()}catch(e){msg.textContent=e.message;return}
          btn.disabled=true;msg.textContent='处理中…';
          try{
            const data=await authRequest(mode==='注册'?'signup':'token?grant_type=password',{
              email:email.value.trim(),password:pass.value,
              ...(mode==='注册'?{data:{legal_consent:true,terms_version:'2026-10-05',privacy_version:'2026-10-05',legal_consented_at:new Date().toISOString()}}:{})
            });
            if(data.access_token&&data.user)saveSession(data);
            else msg.textContent='注册申请已提交。如未自动登录，请点击「已有账号 · 登录」；如系统提示需要邮箱验证，请检查注册邮箱。';
          }catch(e){msg.textContent=e.message}finally{resetCaptcha();btn.disabled=false}
        };mainActions.append(btn);
      }
      gate.append(mainActions);
      const accountHelp=document.createElement('details');accountHelp.className='auth-help-details';
      const helpTitle=document.createElement('summary');helpTitle.textContent='忘记密码？';
      accountHelp.append(helpTitle);
      const recover=document.createElement('button');recover.textContent='忘记密码（需邮件）';
      recover.onclick=async()=>{
        if(!email.value.trim()){msg.textContent='请先填写邮箱';return}
        let token;try{token=takeToken()}catch(e){msg.textContent=e.message;return}
        recover.disabled=true;
        try{await authRequest('recover',{email:email.value.trim()});msg.textContent='已请求发送密码重置邮件；是否送达取决于邮件服务'}
        catch(e){msg.textContent=e.message}finally{resetCaptcha();recover.disabled=false}
      };accountHelp.append(recover);
      gate.append(accountHelp);
    }
    const state={today:null,history:null,tab:'home',filter:'jczq',model:'daily',selected:null,selectedDate:null,baseDate:null,unopenedDate:null,futureDate:null,memberZone:null,memberZoneLoading:false,memberZoneError:null};
    const publicSettledAccess=row=>verified(row)&&hasScore(row);
    const fullMemberAnalysis=row=>memberInfo?.active===true||(row?publicSettledAccess(row):false);
    const vipDeepAccess=()=>memberInfo?.vipActive===true;
    const ARCHIVED_FOCUS={
      '2026-09-13':['002','006','008','009','020','022','023'],
      '2026-09-14':['003','008'],
      '2026-09-15':['003','008','011','012'],
      '2026-09-16':['016'],
      '2026-09-17':['002','003','005','007','011'],
      '2026-09-18':['001','012','014'],
      '2026-09-19':['006','008','013','014','017','027']
    };
    const $=id=>document.getElementById(id);
    const safe=v=>{if(v===null||v===undefined||v==='')return '未确认';const s=String(v);return s==='PASS'?'未确认':s.replace(/PASS/g,'未确认')};
    const resultName={H:'主胜',D:'平',A:'客胜'},pickCode={'主胜':'H','平':'D','客胜':'A'};
    const normalizeResult=v=>({H:'H',D:'D',A:'A','3':'H','1':'D','0':'A','主胜':'H','平':'D','客胜':'A'}[String(v??'')]||null);
    const verified=row=>row.resultVerified===true&&normalizeResult(row.result)!==null;
    const hasScore=row=>verified(row)&&row.resultHome!==null&&row.resultHome!==undefined&&row.resultHome!==''&&row.resultAway!==null&&row.resultAway!==undefined&&row.resultAway!==''&&Number.isFinite(Number(row.resultHome))&&Number.isFinite(Number(row.resultAway));
    const scoreline=row=>hasScore(row)?Number(row.resultHome)+' : '+Number(row.resultAway):'未确认';
    const scoreInfo=row=>{const x=row?.dynamicScoreTop4??row?.scoreTop4;if(!x||x.pregameVerified!==true||!Array.isArray(x.picks)||x.picks.length!==4)return null;const frozen=Date.parse(String(x.frozenAt||'')),kickoff=Date.parse(String(row.kickoff||''));return Number.isFinite(frozen)&&Number.isFinite(kickoff)&&frozen<kickoff?x:null};
    // Read-only display simulation for the specifically missing, already finished 09-23/003 match.
    // Never write to scoreTop4 or take part in pre-match score settlement/coverage metrics.
    const scoreSimulationInfo=row=>{
      if(String(row?.date)!=='2026-09-23'||String(row?.no??'').padStart(3,'0')!=='003'||scoreInfo(row))return null;
      const g=row?.goalPrediction, frozen=Date.parse(String(g?.frozenAt||'')),kickoff=Date.parse(String(row?.kickoff||''));
      const home=Number(g?.lambdaHome),away=Number(g?.lambdaAway);
      if(g?.pregameVerified!==true||g?.source!=='豪竞赛前冻结泊松参数'||!Number.isFinite(frozen)||!Number.isFinite(kickoff)||frozen>=kickoff||Date.now()<=kickoff||g?.lambdaHome==null||g?.lambdaAway==null||!Number.isFinite(home)||!Number.isFinite(away)||home<=0||away<=0||home+away>15)return null;
      const pmf=(k,lambda)=>{let p=Math.exp(-lambda);for(let n=1;n<=k;n++)p*=lambda/n;return p};
      const picks=[];
      for(let h=0;h<=8;h++)for(let a=0;a<=8;a++)picks.push({home:h,away:a,score:h+'-'+a,baseProbability:pmf(h,home)*pmf(a,away),role:'SIMULATION'});
      picks.sort((a,b)=>b.baseProbability-a.baseProbability||(a.home+a.away)-(b.home+b.away)||a.home-b.home||a.away-b.away);
      return {sourceKind:'POSTMATCH_POISSON_SIMULATION_NOT_PUBLISHED',picks:picks.slice(0,4),frozenAt:g.frozenAt};
    };
    const scoreSettled=row=>['SUCCESS','FAILURE'].includes(String(scoreInfo(row)?.settlementStatus||''));
    const scoreHit=row=>String(scoreInfo(row)?.settlementStatus||'')==='SUCCESS';
    const handicapHit=row=>verified(row)&&row.handicapHit===true;
    const ftChoiceHit=(row,v)=>verified(row)&&normalizeResult(v)!==null&&normalizeResult(v)===normalizeResult(row.result);
    const handicapChoiceHit=(row,v)=>verified(row)&&effectiveHandicapResult(row)!==null&&String(v??'').split(' · ')[0].trim()===effectiveHandicapResult(row);
    const directionHit=(row,key,value)=>{if(!verified(row))return false;if(key==='FT首选'||key==='第二方向'||key==='首选建议'||key==='次选建议')return ftChoiceHit(row,value);if(key==='让球方向'||key==='让球首选'||key==='让球次选')return handicapChoiceHit(row,value);return false};
    const ftHit=row=>verified(row)&&(pickCode[row.ftTop1]===normalizeResult(row.result)||pickCode[row.second]===normalizeResult(row.result));
    const probability=v=>{if(v===null||v===undefined||v==='')return '未确认';const n=Number(v);return Number.isFinite(n)?(Math.round(n*10)/10).toFixed(Number.isInteger(Math.round(n*10)/10)?0:1)+'%':'未确认'};
    const ftProbability=(row,code)=>{const fields={H:['homeProbability','homePct','home_pct','ftHomeProbability','ft_home_probability'],D:['drawProbability','drawPct','draw_pct','ftDrawProbability','ft_draw_probability'],A:['awayProbability','awayPct','away_pct','ftAwayProbability','ft_away_probability']}[code];const raw=fields.map(k=>row[k]).find(v=>v!==null&&v!==undefined&&v!=='');if(raw!==undefined)return probability(raw);return normalizeResult(row.ftTop1)===code?probability(row.confidence):'—'};
    const handicapChoice=(pick,prob)=>{const p=safe(pick);return p==='未确认'?p:p+' · '+probability(prob)};
    const modelCopy={
      overview:['九十刻度赛事分析','汇总赛前数据，展示模型概率、主要方向与让球分析'],
      handicap:['九十刻度全场让球','展示赛前让球方向、辅助方向及对应概率'],
      wdl:['九十刻度胜平负','展示主胜、平局、客胜三个方向的正式赛前概率与预测标签'],
      goals:['九十刻度泊松进球','基于赛前冻结的主客队预期进球参数，通过泊松概率模型计算不同总进球数的概率分布。'],
      score:['九十刻度比分矩阵','展示赛前冻结的4项比分与模型概率；赛后对照实际比分'],
      htft:['九十刻度半全场','测试阶段 · 展示模型Top3半全场走势及概率，按日期核对实际覆盖情况'],
      daily:['九十刻度今日优选','从当日赛事中筛选通过核心条件与风险过滤的关注场次'],
      upset:['九十刻度赛事风险观察','仅突出重点风险与强风险信号，一般风险保留在详情分析中'],
      cold:['九十刻度冷门预警','仅展示达到发布门槛且方向明确的冷门识别']
    };
    const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n};
    const matchTimeFormatter=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
    const matchStampFormatter=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
    function fmtTime(v){if(!v)return '未确认';try{return matchTimeFormatter.format(new Date(v))}catch{return '未确认'}}
    function fmtStamp(v){if(!v)return '未确认';try{return matchStampFormatter.format(new Date(v))}catch{return '未确认'}}
    function initial(name){const s=safe(name);return s==='未确认'?'?':s.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g,'').slice(0,1).toUpperCase()||'?'}
    // Validated national-team flag fallback while their own crest is unavailable.
    const nationalFlags=Object.freeze({
      '日本':'🇯🇵','乌拉圭':'🇺🇾','韩国':'🇰🇷','厄瓜多尔':'🇪🇨',
      '中国':'🇨🇳','马尔代夫':'🇲🇻','科索沃':'🇽🇰','爱尔兰':'🇮🇪',
      '葡萄牙':'🇵🇹','威尔士':'🏴','荷兰':'🇳🇱','德国':'🇩🇪',
      '塞尔维亚':'🇷🇸','希腊':'🇬🇷','挪威':'🇳🇴','丹麦':'🇩🇰'
    });
    function teamIconFallback(name){return nationalFlags[String(name??'').trim()]||initial(name)}
    function showTeamIconFallback(crest,name){
      crest.textContent=teamIconFallback(name);
      if(nationalFlags[String(name??'').trim()])crest.classList.add('national-flag');
    }
    function crestNode(name,logo){
      const crest=el('span','crest');
      if(logo){
        const img=document.createElement('img');
        img.alt=safe(name)+'队徽';img.loading='lazy';img.decoding='async';
        img.onerror=()=>{img.remove();showTeamIconFallback(crest,name)};
        crest.append(img);img.src=String(logo);
      }else showTeamIconFallback(crest,name);
      return crest
    }
    function teamNode(name,logo){
      const team=el('div','team');
      team.append(crestNode(name,logo),el('span','team-name',safe(name)));
      return team
    }
    const validHandicapPick=v=>['让胜','让平','让负'].includes(String(v??'').split(' · ')[0].trim());
    // A verified 90-minute score and the official handicap suffice to derive the handicap result.
    // Never derive the official handicap itself or fabricate a missing pre-match pick.
    const effectiveHandicapResult=row=>{
      if(['让胜','让平','让负'].includes(String(row.handicapResult??'').trim()))return String(row.handicapResult).trim();
      if(row.officialHandicap===null||row.officialHandicap===undefined||row.officialHandicap==='')return null;
      if(!hasScore(row))return null;
      const handicap=Number(row.officialHandicap);
      if(!Number.isFinite(handicap))return null;
      const margin=Number(row.resultHome)+handicap-Number(row.resultAway);
      return margin>0?'让胜':margin<0?'让负':'让平';
    };
    const handicapEvaluable=row=>verified(row)&&effectiveHandicapResult(row)!==null&&[row.handicapTop1,row.handicapSecond,row.handicap].some(validHandicapPick);
    function evaluationHit(row){
      if(state.model==='htft'){const h=row.dynamicHTFTPending?row.htftTop4:(row.dynamicHTFT??row.htftTop4);return !!(h&&Array.isArray(h.picks)&&String(h.actual??'')&&h.picks.slice(0,3).some(p=>String(p?.direction??'')===String(h.actual)));}
      if(state.model==='score')return scoreHit(row);
      if(state.model==='handicap')return handicapHit(row)||handicapChoiceHit(row,row.handicapTop1??row.handicap)||handicapChoiceHit(row,row.handicapSecond);
      if(state.model==='overview')return ftHit(row);
      return ftHit(row)
    }
    function postponedMatch(row){
      if(row?.matchStatus==='POSTPONED'||row?.resultStatus==='赛事延期'||row?.resultStatus==='比赛延期')return true;
      const no=String(row?.no??'').padStart(3,'0');
      const day=String(row?.date??row?.poolDate??row?.pool_date??'');
      const home=String(row?.home??row?.homeTeam??'');
      const away=String(row?.away??row?.awayTeam??'');
      return !verified(row)&&no==='019'&&day==='2026-09-26'&&home==='纽约红牛'&&away==='圣路易斯城';
    }
    function statusText(row,history){
      if(row?.analysisPending===true)return '赛前分析待发布';
      if(state.model==='htft'){
        const h=row.dynamicHTFTPending?row.htftTop4:(row.dynamicHTFT??row.htftTop4),historical=h?.sourceKind==='HISTORICAL_POSTMATCH_RECONSTRUCTION',dynamic=h?.sourceKind==='MARKET_ANCHORED_POISSON_HTFT_SHADOW_V01';
        if(!h||!Array.isArray(h.picks)||h.picks.length!==4)return '半全场数据待确认';
        if(h.settlementStatus==='SUCCESS'||h.settlementStatus==='FAILURE'){const hit=String(h.actual??'')&&h.picks.slice(0,3).some(p=>String(p?.direction??'')===String(h.actual));return historical?(hit?'历史复算 · 评测成功':'历史复算 · 评测失败'):dynamic?(hit?'动态预测 · 评测成功':'动态预测 · 评测失败'):(hit?'Top3 · 评测成功':'Top3 · 评测失败');}
        return historical?'历史复算 · 等待核验':'赛前Top3 · 等待评测';
      }
      if(state.model==='score'){const x=scoreInfo(row);if(!x&&scoreSimulationInfo(row))return verified(row)?'赛果已核验':'比分预测未发布';if(!x)return history?'未发布比分预测':'比分预测待确认';if(x.settlementStatus==='SUCCESS')return x.sourceKind==='HISTORICAL_BLIND_REPLAY'?'历史回放一致':'评测成功';if(x.settlementStatus==='FAILURE')return x.sourceKind==='HISTORICAL_BLIND_REPLAY'?'历史回放不一致':'评测失败';return '等待评测';}
      if(verified(row)){if(state.model==='goals')return hasScore(row)?'赛果已核验':'等待评测';if(state.model==='handicap'&&!handicapEvaluable(row))return [row.handicapTop1,row.handicapSecond,row.handicap].some(v=>String(v??'').trim().toUpperCase()==='PASS')?'未发布正式让球方向':'赛前让球预测未记录';return evaluationHit(row)?'评测成功':'评测失败';}
      if(postponedMatch(row))return '赛事延期';if(row.resultVerified===true)return '赛果待复核';if(history)return '等待评测';if(state.model==='daily')return '等待评测';
      return '赛前冻结'
    }
    function statusClass(row,history){if(postponedMatch(row))return 'status pass';if(state.model==='htft'){const h=row.dynamicHTFTPending?row.htftTop4:(row.dynamicHTFT??row.htftTop4);return 'status '+(h?.settlementStatus==='SUCCESS'?'verified':h?.settlementStatus==='FAILURE'?'fail':'');}if(state.model==='score'){const x=scoreInfo(row);if(!x&&scoreSimulationInfo(row)&&verified(row))return 'status verified';return 'status '+(!x||x.settlementStatus==='PENDING'?'':x.settlementStatus==='SUCCESS'?'verified':'fail')}if(verified(row))return 'status '+(state.model==='goals'?'verified':state.model==='handicap'&&!handicapEvaluable(row)?'':evaluationHit(row)?'verified':'fail');return 'status'}
    function moduleData(row){
      if(state.model==='handicap')return [['官方让球',row.officialHandicap],['让球首选',handicapChoice(row.handicapTop1??row.handicap,row.handicapProbability)],['让球次选',handicapChoice(row.handicapSecond,row.handicapSecondProbability)]];
      if(state.model==='wdl')return [['主胜',ftProbability(row,'H')],['平局',ftProbability(row,'D')],['客胜',ftProbability(row,'A')]];
      if(state.model==='daily'){const pct=pick=>{const code=normalizeResult(pick);return code?ftProbability(row,code):'—'};return [['胜平负首选',safe(row.ftTop1)+' · '+pct(row.ftTop1)],['胜平负次选',safe(row.second)+' · '+pct(row.second)]];}
      return [['胜平负首选',safe(row.ftTop1)+' · '+(normalizeResult(row.ftTop1)?ftProbability(row,normalizeResult(row.ftTop1)):'—')],['胜平负次选',safe(row.second)+' · '+(normalizeResult(row.second)?ftProbability(row,normalizeResult(row.second)):'—')]];
    }
    function adviceText(row){
      if(state.model==='handicap'){const first=safe(row.handicapTop1??row.handicap),second=safe(row.handicapSecond);return first==='未确认'?'让球分析：'+([row.handicapTop1,row.handicapSecond,row.handicap].some(v=>String(v??'').trim().toUpperCase()==='PASS')?'未发布正式方向':'数据待确认'):'让球分析：'+first+(second==='未确认'?'':' / '+second)}
      if(state.model==='wdl')return '胜平负分析：'+safe(row.ftTop1)+' / '+safe(row.second);
      if(state.model==='daily')return '模型参考：'+safe(row.ftTop1)+' / '+safe(row.second);
      return '模型参考：'+safe(row.ftTop1)+' / '+safe(row.second);
    }



    function htftVersionInfo(row,kind){
      const info=kind==='dynamic'?(row.dynamicHTFTPending?null:row.dynamicHTFT):row.htftTop4;
      const expected=kind==='dynamic'?'MARKET_ANCHORED_POISSON_HTFT_SHADOW_V01':'PUBLISHED_PREMATCH';
      if(!info||info.sourceKind!==expected||!Array.isArray(info.picks)||info.picks.length!==4)return null;
      const kickoff=Date.parse(String(row.kickoff??'')),frozen=Date.parse(String(info.sourceFrozenAt??'')),published=Date.parse(String(info.publishedAt??''));
      if(!Number.isFinite(kickoff)||!Number.isFinite(frozen)||!Number.isFinite(published)||frozen>published||published>=kickoff)return null;
      return info;
    }
    function htftVersionPanel(row){
      const box=el('div','htft-version-area');
      const original=htftVersionInfo(row,'original'),dynamic=htftVersionInfo(row,'dynamic');
      if(!original&&!dynamic){box.append(htftTop4Panel(row));return box;}
      const tabs=el('div','htft-version-tabs');tabs.setAttribute('role','group');tabs.setAttribute('aria-label','选择半全场赛前预测版本');
      const dynamicButton=el('button','htft-version-tab','动态赛前'),originalButton=el('button','htft-version-tab','原始赛前');
      dynamicButton.type=originalButton.type='button';
      dynamicButton.disabled=!dynamic;originalButton.disabled=!original;
      const sub=el('div','htft-version-sub'),body=el('div','');
      const renderVersion=kind=>{
        const info=kind==='dynamic'?dynamic:original;if(!info)return;
        dynamicButton.classList.toggle('active',kind==='dynamic');originalButton.classList.toggle('active',kind==='original');
        dynamicButton.setAttribute('aria-pressed',String(kind==='dynamic'));originalButton.setAttribute('aria-pressed',String(kind==='original'));
        sub.textContent=kind==='dynamic'
          ?'动态版：冻结进球参数＋赛前威廉希尔欧赔校准 · '+fmtStamp(info.publishedAt)
          :'原始版：初次锁定的赛前进球参数 · '+fmtStamp(info.publishedAt);
        body.replaceChildren(htftTop4Panel(row,info));
        if(original&&dynamic){
          const same=original.picks[0]?.direction===dynamic.picks[0]?.direction;
          body.append(el('p','htft-version-compare',
            '版本对比：Top1 '+(same?'一致（'+safe(dynamic.picks[0]?.direction)+'）':'原始 '+safe(original.picks[0]?.direction)+' → 动态 '+safe(dynamic.picks[0]?.direction))+
            '；两版均为开赛前留存，成绩分别统计。'));
        }
      };
      dynamicButton.onclick=()=>renderVersion('dynamic');originalButton.onclick=()=>renderVersion('original');
      tabs.append(dynamicButton,originalButton);box.append(tabs,sub,body);
      renderVersion(dynamic?'dynamic':'original');return box;
    }
    function htftTop4Panel(row,selectedInfo){
      const info=selectedInfo===undefined?(row.dynamicHTFTPending?null:(row.dynamicHTFT??row.htftTop4)):selectedInfo;
      const full=fullMemberAnalysis(row);
      const marketShadow=info?.sourceKind==='MARKET_ANCHORED_POISSON_HTFT_SHADOW_V01';
      const historical=info?.sourceKind==='HISTORICAL_POSTMATCH_RECONSTRUCTION';
      const panel=reportSection(marketShadow?(full?'赛前动态半全场 · Top3预测':'赛前动态半全场 · Top1'):historical?(full?'半全场 Top3 · 历史补算':'半全场 Top1 · 历史补算'):(full?'半全场 Top3':'半全场 Top1'));
      panel.classList.add('htft-top4-panel');
      const kickoff=Date.parse(String(row.kickoff??''));
      const frozen=Date.parse(String(info?.sourceFrozenAt??''));
      const published=Date.parse(String(info?.publishedAt??''));
      const reconstructed=Date.parse(String(info?.reconstructedAt??''));
      const validTime=marketShadow
        ?Number.isFinite(frozen)&&Number.isFinite(published)&&frozen<=published&&published<kickoff
        :historical
        ?Number.isFinite(frozen)&&Number.isFinite(reconstructed)&&frozen<kickoff&&reconstructed>=kickoff
        :info?.sourceKind==='PUBLISHED_PREMATCH'&&Number.isFinite(frozen)&&Number.isFinite(published)
          &&frozen<=published&&published<kickoff;
      if(!info||!Array.isArray(info.picks)||info.picks.length!==4||!Number.isFinite(kickoff)||!validTime){
        panel.append(el('p','report-empty',Date.now()<kickoff
          ?'本场半全场三选数据待发布；仅在赛前参数和发布时间核验通过后展示。'
          :'本场缺少可核验的半全场三选数据，无法补算；不会使用赛果倒推三选。'));
        return panel;
      }
      const percentage=value=>{
        const n=Number(value);
        return value!==null&&value!==undefined&&Number.isFinite(n)&&n>=0&&n<=1?(n*100).toFixed(1)+'%':'—';
      };
      if(marketShadow)
        panel.append(el('p','htft-top4-flag','赛前动态预测 · 按开球前最后一次有效更新进行赛后评测。'));
      if(historical)
        panel.append(el('p','htft-top4-flag','历史资料补算：开球后根据留存的开球前来源参数重新计算，不属于当时已发布的半全场预测；仅作历史回放对照，不计入正式赛前战绩。'));
      if(full){
        const summary=el('div','htft-top4-summary');
        const top3Probability=info.picks.slice(0,3).reduce((n,p)=>n+(Number.isFinite(Number(p?.probability))?Number(p.probability):0),0);summary.append(el('small','','Top3合计模型概率'),el('strong','',percentage(top3Probability)));
        summary.append(el('div','htft-top4-note','覆盖九种半全场结果中的三种；合计概率不是历史命中率。'));
        panel.append(summary);
      }
      const grid=el('div','htft-top4-grid');
      (full?info.picks.slice(0,3):info.picks.slice(0,1)).forEach((pick,i)=>{
        const name=String(pick.direction??'');
        const cell=el('div','htft-top4-pick'+(info.picks.slice(0,3).some(p=>String(p?.direction??'')===String(info.actual??''))&&name===info.actual?' is-hit':''));
        cell.append(el('small','','Top '+(i+1)),el('b','',name),el('span','htft-prob',percentage(pick.probability)));
        grid.append(cell);
      });
      panel.append(grid);
      if(full)reportLine(panel,'半场平局模型概率',percentage(info.htDrawProbability));
      if(!full)panel.append(el('div','member-preview-lock','会员可查看完整Top3、合计概率与半场平局概率'));
      if(info.lowGoalDrawAudit===true)
        panel.append(el('p','htft-top4-flag','低进球＋双方预期接近：半场平局已列入重点观察，四个方向仍按九项联合概率排序。'));
      const top3Hit=String(info.actual??'')!==''&&info.picks.slice(0,3).some(p=>String(p?.direction??'')===String(info.actual));
      const top3Settled=info.settlementStatus==='SUCCESS'||info.settlementStatus==='FAILURE';
      if(marketShadow){
        if(top3Settled){
          const hit=top3Hit;
          panel.append(el('div','score-top4-verdict '+(hit?'success':'fail'),
            (hit?'动态预测 · 评测成功':'动态预测 · 评测失败')+' · 实际半全场 '+safe(info.actual)+'（计入动态版战绩）'));
          if(info.halfScore)panel.append(el('p','htft-top4-note','核验半场比分：'+safe(info.halfScore)+'；全场按90分钟正式赛果。'));
        }else panel.append(el('div','score-top4-verdict pending',
          info.settlementStatus==='PENDING_HALFTIME_VERIFICATION'?'半场赛果待核验，暂不评测':'等待评测 · 暂未对照'));
      }
      else if(top3Settled){
        const hit=top3Hit;
        const verdict=historical
          ?(hit?'历史回放一致 · 实际半全场 ':'历史回放不一致 · 实际半全场 ')+String(info.actual)
          :hit?'评测成功 · 实际半全场 '+String(info.actual):
            '评测失败 · 实际半全场 '+String(info.actual)+' 未落在三选内';
        panel.append(el('div','score-top4-verdict '+(hit?'success':'fail'),verdict));
        if(info.halfScore)panel.append(el('p','htft-top4-note','核验半场比分：'+String(info.halfScore)+'；全场按90分钟正式赛果。'));
      }else panel.append(el('div','score-top4-verdict pending',info.settlementStatus==='PENDING_HALFTIME_VERIFICATION'
        ?'半场赛果尚未核验，不进行对照':'等待评测 · 暂未对照'));
      if(marketShadow){
        panel.append(el('p','htft-top4-note','赛前动态版更新于 '+fmtStamp(info.publishedAt)+'；使用开球前留存数据。'));
      }else if(historical){
        panel.append(el('p','htft-top4-note','历史资料回放 · 来源数据冻结于 '+fmtStamp(info.sourceFrozenAt)+'；仅作对照，不计入正式赛前战绩。'));
      }else panel.append(el('p','htft-top4-note','赛前发布于 '+fmtStamp(info.publishedAt)+'；预测记录已锁定。'));
      return panel;
    }

    function scoreVersionInfo(row,kind){
      const info=kind==='dynamic'?row.dynamicScoreTop4:row.scoreTop4;
      if(!info||info.pregameVerified!==true||!Array.isArray(info.picks)||info.picks.length!==4)return null;
      if(kind==='dynamic'&&info.sourceKind!=='MARKET_ANCHORED_POISSON_SHADOW_V01')return null;
      if(kind==='original'&&(info.sourceKind==='HISTORICAL_BLIND_REPLAY'||info.sourceKind==='POSTMATCH_POISSON_SIMULATION_NOT_PUBLISHED'))return null;
      const freeze=Date.parse(String(info.frozenAt??'')),kickoff=Date.parse(String(row.kickoff??''));
      if(!Number.isFinite(freeze)||!Number.isFinite(kickoff)||freeze>=kickoff)return null;
      if(kind==='dynamic'){
        const market=Date.parse(String(info.marketAt??'')),baseline=Date.parse(String(info.baselineAt??''));
        if(!Number.isFinite(market)||!Number.isFinite(baseline)||baseline>market||market>freeze||market>=kickoff)return null;
      }
      if(info.picks.some(p=>!p||!/^\d+-\d+$/.test(String(p.score??''))||p.baseProbability==null||!Number.isFinite(Number(p.baseProbability))||Number(p.baseProbability)<0||Number(p.baseProbability)>1))return null;
      return info;
    }
    function scoreActual(row){
      if(!verified(row)||!hasScore(row))return null;
      const h=Number(row.resultHome),a=Number(row.resultAway);
      return Number.isInteger(h)&&Number.isInteger(a)&&h>=0&&a>=0?h+'-'+a:null;
    }
    function scoreVersionStat(items){
      const settled=items.filter(({row})=>scoreActual(row)!==null);
      return {total:items.length,n:settled.length,
        top1:settled.filter(({row,info})=>String(info.picks[0].score)===scoreActual(row)).length,
        top4:settled.filter(({row,info})=>info.picks.some(p=>String(p.score)===scoreActual(row))).length};
    }
    function scoreVersionPanel(row){
      const original=scoreVersionInfo(row,'original'),dynamic=scoreVersionInfo(row,'dynamic');
      const box=el('section','score-version-wrap');
      if(!original&&!dynamic){
        box.append(scoreTop4Panel(row));
        return box;
      }
      box.append(el('h3','','全场比分 · 赛前版本对比'));
      const tabs=el('div','htft-version-tabs');tabs.setAttribute('role','group');tabs.setAttribute('aria-label','选择全场比分赛前预测版本');
      const dyn=el('button','htft-version-tab','动态赛前'),orig=el('button','htft-version-tab','原始赛前');
      dyn.type=orig.type='button';dyn.disabled=!dynamic;orig.disabled=!original;
      const sub=el('p','score-version-label'),body=el('div','');
      const renderVersion=kind=>{
        const info=kind==='dynamic'?dynamic:original;if(!info)return;
        dyn.classList.toggle('active',kind==='dynamic');orig.classList.toggle('active',kind==='original');
        dyn.setAttribute('aria-pressed',String(kind==='dynamic'));orig.setAttribute('aria-pressed',String(kind==='original'));
        sub.textContent=(kind==='dynamic'?'动态赛前':'原始赛前')+' · '+fmtStamp(info.frozenAt)+' 留存';
        body.replaceChildren(scoreTop4Panel(row,info));
        if(original&&dynamic){
          const firstOriginal=String(original.picks[0].score).replace('-',':'),firstDynamic=String(dynamic.picks[0].score).replace('-',':');
          body.append(el('p','score-version-summary','版本对比：原始Top1 '+firstOriginal+' → 动态Top1 '+firstDynamic+
            (firstOriginal===firstDynamic?'（首选一致）':'（首选有变化）')+'。两版各自计算命中率，不合并为两场。'));
        }
      };
      dyn.onclick=()=>renderVersion('dynamic');orig.onclick=()=>renderVersion('original');
      tabs.append(dyn,orig);box.append(tabs,sub,body);renderVersion(dynamic?'dynamic':'original');
      return box;
    }
    function scoreTop4Panel(row,selectedInfo){
      const simulation=selectedInfo===undefined?scoreSimulationInfo(row):null,panel=el('section','score-top4'),info=selectedInfo===undefined?(scoreInfo(row)||simulation):selectedInfo;
      const full=fullMemberAnalysis(row);
      const title=el('div','score-top4-title');
      const historical=info?.sourceKind==='HISTORICAL_BLIND_REPLAY';
      const marketShadow=info?.sourceKind==='MARKET_ANCHORED_POISSON_SHADOW_V01';
      const originalPrematch=!!info&&!simulation&&!historical&&!marketShadow;
      title.append(
        el('span','',simulation?'比分概率参考':historical?(full?'历史比分回放 · Top4':'历史比分回放 · Top1'):marketShadow?(full?'最新比分预测 · Top4':'最新比分预测 · Top1'):originalPrematch?(full?'原始赛前比分 · Top4':'原始赛前比分 · Top1'):(full?'全场比分 · Top4':'全场比分 · Top1')),
        el('small','',simulation?'补充分析':!info?'等待赛前参数':historical?'历史资料回放':marketShadow?'':'原始冻结 '+fmtStamp(info.frozenAt))
      );
      panel.append(title);
      if(!info){panel.append(el('p','score-top4-note','暂无比分预测 · 赛前参数未确认，不计入比分覆盖统计。'));return panel}
      const grid=el('div','score-top4-grid');
      (full?info.picks:info.picks.slice(0,1)).forEach((pick,i)=>{
        const isHit=scoreActual(row)!==null&&String(pick.score)===scoreActual(row);
        const cell=el('div','score-pick'+(String(pick.role).includes('CHALLENGER')?' challenger':'')+(isHit?' hit':''));
        const p=Number(pick.baseProbability);
        const prob=pick.baseProbability!==null&&pick.baseProbability!==undefined&&Number.isFinite(p)&&p>=0&&p<=1?(p*100).toFixed(1)+'%':'概率未确认';
        cell.append(el('small','',simulation?'回放Top'+(i+1):'Top'+(i+1)),el('b','',String(pick.score).replace('-',':')),el('small','',prob));grid.append(cell)
      });panel.append(grid);
      if(!full)panel.append(el('div','member-preview-lock','会员可查看完整Top4及全部概率分布'));
      if(simulation){
        panel.append(el('p','score-top4-note','赛后依据赛前参数模拟，仅供参考；未在开球前发布，不计入赛前比分战绩。'));
        return panel;
      }
      const actual=scoreActual(row),top1=actual!==null&&String(info.picks[0].score)===actual;
      const top4=actual!==null&&info.picks.some(p=>String(p.score)===actual);
      const cls=actual===null?'pending':top4?'success':'fail';
      const verdict=actual===null?'等待评测':!full
        ?'实际比分 '+actual.replace('-',':')+' · Top1 · '+(top1?'评测成功':'评测失败')
        :historical
          ?'历史复算 · '+(top4?'Top4 · 评测成功':'Top4 · 评测失败')
          :'实际比分 '+actual.replace('-',':')+' · Top1 · '+(top1?'评测成功':'评测失败')+' · Top4 '+(top4?'覆盖':'未覆盖');
      panel.append(el('div','score-top4-verdict '+cls,verdict));
      if(marketShadow)panel.append(el('p','score-top4-note','赛前记录 · 赛果核验后计算Top1和Top4。'));
      else if(historical)panel.append(el('p','score-top4-note','本场为赛后依据赛前留存参数复算，不属于当时发布的赛前比分预测，不计入赛前版命中率。'));
      else panel.append(el('p','score-top4-note','赛前记录 · 赛果核验后计算Top1和Top4。'));
      panel.append(el('p','score-top4-note','比分概率为模型估算值，不代表历史命中率或结果保证。'));
      return panel
    }
    function htftCard(row,history=false){
      const c=el('article','card'),head=el('div','card-head'),id=el('div','match-id');
      const info=htftVersionInfo(row,'dynamic')??htftVersionInfo(row,'original')??row.htftTop4,marketShadow=info?.sourceKind==='MARKET_ANCHORED_POISSON_HTFT_SHADOW_V01',historical=info?.sourceKind==='HISTORICAL_POSTMATCH_RECONSTRUCTION';
      const valid=info&&Array.isArray(info.picks)&&info.picks.length===4&&
        ['PUBLISHED_PREMATCH','HISTORICAL_POSTMATCH_RECONSTRUCTION','MARKET_ANCHORED_POISSON_HTFT_SHADOW_V01'].includes(info.sourceKind);
      const full=fullMemberAnalysis(row);
      id.append(el('span','league',safe(row.league)),document.createTextNode(fmtTime(row.kickoff)+' · '+safe(row.no)));
      if(marketShadow)id.append(el('span','focus-label','赛前动态预测'));
      if(historical)id.append(el('span','focus-label','历史复算'));
      const done=valid&&['SUCCESS','FAILURE'].includes(info.settlementStatus);
      const label=!valid?'数据待更新':marketShadow?(done?(info.settlementStatus==='SUCCESS'?'动态预测 · 评测成功':'动态预测 · 评测失败'):'赛前动态'):done?(historical?(info.settlementStatus==='SUCCESS'?'历史复算 · 评测成功':'历史复算 · 评测失败'):(info.settlementStatus==='SUCCESS'?'评测成功':'评测失败')):'等待评测';
      head.append(id,el('span','status'+(done?(info.settlementStatus==='SUCCESS'?' verified':' fail'):'') ,label));
      const fixture=el('div','fixture'),teams=el('div','team-list');
      [[row.home,row.homeLogo],[row.away,row.awayLogo]].forEach(([name,logo])=>teams.append(teamNode(name,logo)));
      const settled=verified(row),score=el('div','score',settled&&hasScore(row)?scoreline(row):'VS');
      score.append(el('span','',settled&&hasScore(row)?'90分钟正式赛果':marketShadow?'半全场 · 赛前动态预测':'半全场 · Top4测试'));
      fixture.append(teams,score);c.append(head,fixture);
      const panel=el('div','analysis');
      if(valid){
        const grid=el('div','htft-top4-grid');
        (full?info.picks.slice(0,3):info.picks.slice(0,1)).forEach((pick,i)=>{
          const direction=String(pick.direction??''),prob=Number(pick.probability),hit=done&&info.picks.slice(0,3).some(p=>String(p?.direction??'')===String(info.actual??''))&&info.actual===direction;
          const cell=el('div','htft-top4-pick'+(hit?' is-hit':''));
          cell.append(el('small','','Top'+(i+1)),el('b','',direction),el('span','htft-prob',pick.probability!==null&&pick.probability!==undefined&&Number.isFinite(prob)&&prob>=0&&prob<=1?(prob*100).toFixed(1)+'%':'—'));
          grid.append(cell);
        });
        panel.append(grid);
        // Show the SAME frozen HT draw estimate already used by the detail view; never derive it from the settled result.
        const htDraw=Number(info.htDrawProbability);
        if(full&&info.htDrawProbability!==null&&info.htDrawProbability!==undefined&&Number.isFinite(htDraw)&&htDraw>=0&&htDraw<=1){
          const drawLine=el('div','htft-list-draw');
          drawLine.append(el('span','','半场平局模型概率'),el('strong','',(htDraw*100).toFixed(1)+'%'));
          panel.append(drawLine);
        }
        if(!full)panel.append(el('div','member-preview-lock','会员可查看完整Top3及概率分布'));
        if(done){
          const top1Hit=String(info.picks?.[0]?.direction??'')===String(info.actual??''),top3Hit=info.picks.slice(0,3).some(p=>String(p?.direction??'')===String(info.actual??''));
          panel.append(el('div','score-top4-verdict '+(full?(top3Hit?'success':'fail'):(top1Hit?'success':'fail')),
            '实际半全场：'+safe(info.actual)+' · '+(full?(marketShadow?(top3Hit?'动态预测 · 评测成功':'动态预测 · 评测失败'):historical?(top3Hit?'历史复算 · 评测成功':'历史复算 · 评测失败'):(top3Hit?'Top3 · 评测成功':'Top3 · 评测失败')):'Top1 · '+(top1Hit?'评测成功':'评测失败'))));
        }
        else panel.append(el('div','score-top4-verdict pending',info.settlementStatus==='PENDING_HALFTIME_VERIFICATION'?'半场赛果待核验，不计入覆盖率':'赛果待核验，不计入覆盖率'));
        panel.append(el('p','htft-list-meta',marketShadow?'动态赛前 · 更新于 '+fmtStamp(info.publishedAt)+' · 冻结进球参数＋赛前威廉希尔欧赔校准。':historical?'本场为赛后依据赛前留存参数复算，非当时发布的预测；不计入赛前战绩。':'原始赛前 · 冻结的进球参数计算，发布于 '+fmtStamp(info.publishedAt)+'。'));
        const original=htftVersionInfo(row,'original'),dynamic=htftVersionInfo(row,'dynamic');
        if(original&&dynamic){
          const same=original.picks[0]?.direction===dynamic.picks[0]?.direction;
          panel.append(el('p','htft-list-compare',
            '原始版 Top1：'+safe(original.picks[0]?.direction)+' · '+(same?'与动态版一致':'动态版已调整为 '+safe(dynamic.picks[0]?.direction))+' · 点击查看两版依据'));
        }
      }else panel.append(el('p','htft-top4-note','本场半全场最新数据尚未更新完成；不会使用赛果补写预测。'));
      c.append(panel);c.setAttribute('role','button');c.tabIndex=0;
      c.onclick=()=>openDetail(row,history);
      c.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openDetail(row,history)}};
      return c;
    }
    function scoreCard(row,history=false){
      const c=el('article','card'),head=el('div','card-head'),id=el('div','match-id');
      const dynamic=scoreVersionInfo(row,'dynamic'),original=scoreVersionInfo(row,'original');
      const selected=dynamic??original;
      id.append(el('span','league',safe(row.league)),document.createTextNode(fmtTime(row.kickoff)+' · '+safe(row.no)));
      if(dynamic)id.append(el('span','focus-label','赛前动态预测'));
      else if(original)id.append(el('span','focus-label','原始赛前预测'));
      head.append(id,el('span',statusClass(row,history),statusText(row,history)));
      const fixture=el('div','fixture'),teams=el('div','team-list');
      [[row.home,row.homeLogo],[row.away,row.awayLogo]].forEach(([name,logo])=>teams.append(teamNode(name,logo)));
      const settled=verified(row),score=el('div','score',settled&&hasScore(row)?scoreline(row):'VS');
      score.append(el('span','',settled&&hasScore(row)?'90分钟正式赛果':
        scoreSimulationInfo(row)?'赛后比分模拟':
        scoreInfo(row)?.sourceKind==='HISTORICAL_BLIND_REPLAY'?'历史比分回放':
        dynamic?'动态赛前比分预测':
        original?'原始赛前比分预测':'赛前比分预测'));
      fixture.append(teams,score);
      if(selected)c.append(head,fixture,scoreTop4Panel(row,selected));
      else if(scoreSimulationInfo(row))c.append(head,fixture,el('p','score-top4-note','赛前比分预测未发布 · 查看比赛详情 ›'));
      else c.append(head,fixture,scoreTop4Panel(row));
      c.setAttribute('role','button');c.tabIndex=0;c.onclick=()=>openDetail(row,history);c.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openDetail(row,history)}};return c
    }
    function matchCard(row,history=false){
      if(state.model==='htft')return htftCard(row,history);
      if(state.model==='score')return scoreCard(row,history);
      const c=el('article','card');
      const head=el('div','card-head');
      const id=el('div','match-id');id.append(el('span','league',safe(row.league)),document.createTextNode(fmtTime(row.kickoff)+' · '+safe(row.no)));
      if(state.model==='daily'&&row?.analysisPending!==true){const supplementary=isSupplement(row)&&!isFocus(row);id.append(el('span','focus-label '+(supplementary?'supplement':'core'),supplementary?'精选补充':'核心优选'));}if(state.model==='handicap'&&row.handicapSourceLabel)id.append(el('span','focus-label',String(row.handicapSourceLabel).includes('Top5新方案赛前冻结')?'赛前预测':row.handicapSourceLabel));head.append(id,el('span',statusClass(row,history),statusText(row,history)));
      const fixture=el('div','fixture'),teams=el('div','team-list');
      [[row.home,row.homeLogo],[row.away,row.awayLogo]].forEach(([name,logo])=>teams.append(teamNode(name,logo)));
      const settled=verified(row),outcome=safe(resultName[row.result]||row.result),score=el('div','score',settled?(hasScore(row)?scoreline(row):'比分待核验'):'VS');score.append(el('span','',settled?(hasScore(row)?outcome+' · 正式赛果':'比分待核验'):postponedMatch(row)?'赛事延期':'官方让球 '+(row.officialHandicap==null?'待确认':String(row.officialHandicap))));
      fixture.append(teams,score);
      const analysis=el('div','analysis'),values=state.model==='goals'?[]:moduleData(row),triplet=el('div','triplet'+(values.length===2?' pair':values.length===6?' six-grid':''));
      values.forEach(([k,v],i)=>{if(state.model==='wdl'){const code=['H','D','A'][i],top=normalizeResult(row.ftTop1)===code,second=normalizeResult(row.second)===code,hit=verified(row)&&normalizeResult(row.result)===code&&(top||second),actual=verified(row)&&normalizeResult(row.result)===code;const d=el('div','datum wdl-prob'+(top||second?' wdl-pick':'')+(actual?' wdl-actual':'')+(hit?' hit':''));d.append(el('span','',k),el('b','',safe(v)),el('span','',top?'首选':second?'次选':actual?'实际赛果':'　'));if(hit)d.append(el('span','hit-check','✓'));triplet.append(d);return}const hit=directionHit(row,k,v),isHandicap=state.model==='handicap',d=el('div','datum'+(verified(row)&&!isHandicap?(hit?' hit':' miss'):(i===0?' primary':'')));d.append(el('span','',k),el('b','',safe(v)));if(hit&&!isHandicap)d.append(el('span','hit-check','✓'));triplet.append(d)});
      analysis.append(triplet);
      if(state.model==='goals')c.append(head,fixture);else c.append(head,fixture,analysis);
      // Show Poisson goals on the match list itself, immediately after the FT 1X2 block.
      if(state.model==='goals'){
        const lambda=publishedGoalLambda(row);
        const goals=el('section','goals-inline');
        const goalSource=row.dynamicGoalPrediction??row.goalPrediction;
        const goalsShadow=goalSource?.formalEligible===false;
        const marketShadow=goalSource?.sourceKind==='MARKET_ANCHORED_POISSON_SHADOW_V01';
        const scoreBasedGoal=goalSource?.sourceKind==='SCORE_TOP4_FROZEN_LAMBDA_REFERENCE';
        const full=fullMemberAnalysis(row);
        goals.append(el('div','goals-inline-title',full?'泊松进球 · Top3':'泊松进球 · 概率最高'));
        if(lambda===null){
          goals.append(el('p','goals-note','赛前进球参数未确认'));
        }else{
          let p=Math.exp(-lambda);const ranked=[];
          for(let k=0;k<=15;k++){if(k>0)p*=lambda/k;ranked.push({goals:k,p})}
          ranked.sort((a,b)=>b.p-a.p||a.goals-b.goals);
          goals.append(el('p','goals-note','预计总进球 λ：'+lambda.toFixed(2)+(marketShadow?' · 赛前威廉希尔欧赔校准双方λ（总λ不变）':scoreBasedGoal?' · 基于赛前冻结的主客队预期进球参数，通过泊松概率模型计算不同总进球数的概率分布。':goalsShadow?' · 最近6场得失球估计':'')));
          if(goalsShadow)goals.append(el('p','goals-note','赛前更新 '+fmtStamp(goalSource.frozenAt)));
          const grid=el('div','goals-grid');
          (full?ranked.slice(0,3):ranked.slice(0,1)).forEach((item,i)=>{
            const cell=el('div','goal-cell');
            cell.append(el('small','',full?'Top'+(i+1):'最高概率'),el('b','',item.goals+'球'),el('small','',(item.p*100).toFixed(1)+'%'));
            grid.append(cell);
          });
          goals.append(grid);
          if(!full)goals.append(el('div','member-preview-lock','会员可查看Top3及完整概率分布'));
          if(hasScore(row)){
            const actual=Number(row.resultHome)+Number(row.resultAway);
            const rank=ranked.slice(0,3).findIndex(item=>item.goals===actual);
            const goalHit=rank>=0;
            if(full){
              const verdict=el('div','goals-inline-verdict '+(goalHit?'goals-inline-success':'goals-inline-fail'));
              verdict.append(el('span','goals-inline-icon',goalHit?'✓':'×'),
                el('b','',goalHit?'Top3 · 评测成功':'Top3 · 评测失败'),
                el('span','','实际总进球 '+actual+'球'+(marketShadow?' · 动态参数版':goalsShadow?' · 原始参数参考':'')));
              goals.append(verdict);
            }else{
              if(rank===0){
                const verdict=el('div','goals-inline-verdict goals-inline-success');
                verdict.append(el('span','goals-inline-icon','✓'),el('b','','最高概率 · 评测成功'),el('span','','实际总进球 '+actual+'球'));
                goals.append(verdict);
              }else{
                goals.append(el('div','goals-inline-verdict','实际总进球 '+actual+'球'));
              }
            }
          }else goals.append(el('p','goals-note',full?'待评测 · 统计Top3覆盖':'等待评测'));
        }
        c.append(goals);
      }
      // FT risk observation belongs to the 1X2 layer only.
      // Do not repeat it on handicap/goals/score/HTFT cards, where it can be mistaken for risk on that market.
      if(['overview','wdl','daily'].includes(state.model))appendRiskStrip(c,row);
      if(history&&state.model!=='goals'){const r=el('div','history-result');r.append(document.createTextNode('比分 '),el('b','',scoreline(row)),document.createTextNode(' · '));if(state.model==='handicap')r.append(document.createTextNode('来源 '+safe(row.handicapSourceLabel)+' · 首选 '+safe(row.handicapTop1??row.handicap)+' · 次选 '+safe(row.handicapSecond)+' · 赛果 '+safe(effectiveHandicapResult(row))+' · '),el('b','',!handicapEvaluable(row)?'待核验':evaluationHit(row)?'评测成功':'评测失败'));else{r.append(document.createTextNode('首选 '),el('b','',pickCode[row.ftTop1]===normalizeResult(row.result)?'命中':'未中'),document.createTextNode(' · 次选 '),el('b','',pickCode[row.second]===normalizeResult(row.result)?'命中':'未中'));if(state.model==='overview')r.append(document.createTextNode(' · 让球 '),el('b','',handicapHit(row)?'命中':'未中'));r.append(document.createTextNode(' · 评测 '),el('b','',evaluationHit(row)?'成功':'未中'))}c.append(r)}
      c.setAttribute('role','button');c.tabIndex=0;c.onclick=()=>openDetail(row,history);c.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openDetail(row,history)}};
      return c
    }
    function sectionHead(title,sub){const h=el('div','section-head');h.append(el('h2','',title),el('span','',sub));return h}
    function empty(title,text){const x=el('div','empty');x.append(el('b','',title),el('div','',text));return x}
    function notice(){return document.createDocumentFragment()}
    function dailySelectionHardBlocked(row){
      if(row?.dailySelectionRiskLocked===true||row?.vipRiskLocked===true||row?.highDrawRisk===true||row?.marketDirectionAnomaly===true)return true;
      const warning=(row?.upsetWarning&&typeof row.upsetWarning==='object')?row.upsetWarning:null;
      const tier=String(warning?.displayTier??warning?.display_tier??'');
      return warning?.publish===true||tier==='重点风险'||tier==='强风险信号';
    }
    function isFocus(row){
      if(dailySelectionHardBlocked(row))return false;
      const archived=ARCHIVED_FOCUS[row.date],no=String(row.no??'').padStart(3,'0');
      if(Array.isArray(archived))return row.pregameVerified===true&&archived.includes(no);
      const dailyTier=String(row.dailySelectionTier??row.daily_selection_tier??'').trim().toUpperCase();
      if(dailyTier==='CORE')return row.pregameVerified===true;
      // Since 2026-09-20 the API is the single source of truth for 今日优选.
      // Do not re-promote SINGLE/DOUBLE rows on the client after the server risk gate removed them.
      if(String(row.date??'')>='2026-09-20')return false;
      const tags=[row.focusTag,row.focus_tag,row.recommendationLevel,row.recommendation_level,row.priorityTag,row.priority_tag,row.bestPlayLevel,row.best_play_level,row.bestPlay?.level,row.best_play?.level];
      const explicit=tags.some(v=>/^(重心|重点|核心|FOCUS|PRIORITY|BEST_PLAY|A\+|A\+单|A\+双)$/i.test(String(v??'').trim()));
      const marked=row.isFocus===true||row.is_focus===true||row.isKeyMatch===true||row.is_key_match===true||row.isBestPlay===true||row.is_best_play===true;
      const tier=String(row.tier??'').trim().toUpperCase(),mode=String(row.mode??'').trim().toUpperCase();
      const frozenFormal=(mode==='SINGLE'||mode==='DOUBLE')&&tier!==''&&tier!=='PASS'&&row.pass!==true;
      return row.pregameVerified===true&&(explicit||marked||frozenFormal);
    }
    function isSupplement(row){
      return !dailySelectionHardBlocked(row)&&row.pregameVerified===true&&String(row.dailySelectionTier??row.daily_selection_tier??'').toUpperCase()==='SUPPLEMENT';
    }
    // Historical replay uses only evidence available at the original pre-kickoff freeze; HUR never determines direction and result fields are excluded.
    function upsetInfo(row){
      const raw=row.upsetWarning??row.upset_warning;
      const riskDisplayEligible=raw?.riskDisplayEligible===true||raw?.risk_display_eligible===true;
      if(!raw||typeof raw!=='object'||row.pregameVerified!==true||raw.publish!==true||
        ((raw.publicationEligible===false||raw.publication_eligible===false)&&!riskDisplayEligible))return null;
      const level=String(raw.riskLevel??raw.risk_level??'未确认');
      const basis=Array.isArray(raw.riskBasis)?raw.riskBasis:Array.isArray(raw.risk_basis)?raw.risk_basis:[];
      const directionBasis=Array.isArray(raw.directionBasis)?raw.directionBasis:Array.isArray(raw.direction_basis)?raw.direction_basis:[];
      const alternativePick=raw.alternativePick??raw.alternative_pick??null;
      const originalPick=raw.originalTop1??raw.original_top1??row.ftTop1;
      const originalCode=normalizeResult(originalPick),secondCode=normalizeResult(row.second);
      const gate=(raw.focusGate&&typeof raw.focusGate==='object')?raw.focusGate:
        (raw.focus_gate&&typeof raw.focus_gate==='object'?raw.focus_gate:null);
      const oppositeSecond=gate?.opposite_second===true||
        (['H','A'].includes(originalCode)&&['H','A'].includes(secondCode)&&originalCode!==secondCode);
      const qualifiedDraw=gate?.qualified_draw===true;
      const marketAnomaly=gate?.market_anomaly===true;
      const marketSignals=Array.isArray(raw.marketSignals)?raw.marketSignals:
        (Array.isArray(raw.market_signals)?raw.market_signals:[]);
      const modelVersion=String(raw.modelVersion??raw.model_version??'HJ38-UPSET-v1.0.0');
      // Do not rewrite older historical publications. For the 9/26 transition only,
      // legacy v1.0 rows are visually narrowed by the verified opposite-second rule
      // until the next v1.1 prematch freeze arrives.
      if(!gate&&String(row.date??'')>='2026-09-26'&&!oppositeSecond)return null;
      const displayTier=String(raw.displayTier??raw.display_tier??
        (gate?(level==='高'?'强风险信号':'重点风险'):
          String(row.date??'')>='2026-09-26'?'重点风险':level==='高'?'强风险信号':'重点风险'));
      const directionEligible=raw.directionPublicationEligible!==false&&raw.direction_publication_eligible!==false;
      let direction=directionEligible?String(raw.warningDirection??raw.warning_direction??'').trim():'';
      if(direction==='主队不胜')direction='客队不败';
      else if(direction==='客队不胜')direction='主队不败';
      else if(direction==='平局不稳'&&alternativePick==='主胜')direction='主队不败';
      else if(direction==='平局不稳'&&alternativePick==='客胜')direction='客队不败';
      if(!['主队不败','客队不败','平局风险'].includes(direction))direction='';
      let inlineReason='';
      if(displayTier==='强风险信号'){
        const focusText=oppositeSecond&&qualifiedDraw?'胜负方向分歧 · 防平信号':oppositeSecond?'胜负方向分歧':'防平信号';
        inlineReason=focusText+' · 市场反向变化';
      }else if(qualifiedDraw&&!oppositeSecond)inlineReason='独立进球模型提示平局风险';
      else if(oppositeSecond)inlineReason='胜负方向分歧';
      else inlineReason=basis[0]||'赛前风险证据达到重点观察门槛';
      const evidenceLines=[];
      if(oppositeSecond)evidenceLines.push('首选与次选形成主/客胜方向分歧');
      if(qualifiedDraw)evidenceLines.push('严格赛前独立进球模型提示平局风险');
      if(marketAnomaly)evidenceLines.push('赛前市场异常：'+(marketSignals.slice(0,2).join('、')||'赔率或盘口出现反向变化'));
      for(const item of basis){
        const value=String(item??'').trim();
        if(evidenceLines.length>=3)break;
        if(value&&!evidenceLines.includes(value))evidenceLines.push(value);
      }
      return {
        level,displayTier,
        gate,
        score:Number.isFinite(Number(raw.riskScore??raw.risk_score))?Number(raw.riskScore??raw.risk_score):null,
        direction,alternativePick,
        reason:evidenceLines.length?evidenceLines.join('；'):'赛前风险证据已达到发布门槛',
        directionReason:directionBasis.slice(0,3).join('；'),
        evidenceLines,
        originalPick,oppositeSecond,qualifiedDraw,marketAnomaly,marketSignals,inlineReason,
        directionEligible,riskDisplayEligible,
        modelVersion,
        sourceModelVersion:raw.sourceModelVersion??raw.source_model_version??row.version??'未确认',
        sourceRevision:raw.sourceRevision??raw.source_revision??row.revision??'未确认',
        prematchAt:raw.prematchAt??raw.prematch_at??row.frozenAt,
        source:'九十刻度赛前风险观察'
      };
    }
    function appendRiskStrip(card,row){
      if(row?.vipRiskAccessRestricted===true&&!vipDeepAccess()){
        if(row?.vipRiskLocked===true){
          const publicLabel=String(row?.vipRiskPublicLabel||'风险信号');
          const publicReason=String(row?.vipRiskPublicReason||'本场存在赛前风险变化');
          const cls=publicLabel==='强风险信号'||publicLabel==='市场异动信号'?'strong':'focus';
          const strip=el('div','risk-inline '+cls);
          const main=el('div','risk-inline-main');
          main.append(el('strong','',publicLabel),el('span','',publicReason));
          strip.append(main);
          const locked=el('div','vip-inline-lock');
          locked.append(el('b','','详细风险依据 🔒'),el('span','','方向、让球保护概率及市场/情报依据仅向尊贵月卡VIP开放。'));
          strip.append(locked);
          card.append(strip);
        }
        return;
      }
      const highDrawFallback=(()=>{
        const draw=Number(row.drawProbability??row.drawPct??row.draw_pct);
        const drawPct=Number.isFinite(draw)?(draw<=1?draw*100:draw):null;
        const official=Number(row.officialHandicap);
        const first=String(row.handicapTop1??row.handicap??'').trim();
        const second=String(row.handicapSecond??'').trim();
        const p1=Number(row.handicapProbability??row.handicap_probability);
        const p2=Number(row.handicapSecondProbability??row.handicap_second_probability);
        const valid=v=>['让胜','让平','让负','HWIN','HDRAW','HLOSS'].includes(v);
        return row.pregameVerified===true&&drawPct!==null&&drawPct>=29&&official===-1&&
          valid(first)&&valid(second)&&Number.isFinite(p1)&&Number.isFinite(p2);
      })();
      if(row.highDrawRisk===true||highDrawFallback){
        const strip=el('div','risk-inline focus');
        const main=el('div','risk-inline-main');
        main.append(el('strong','','高平风险'),el('span','','胜平负结构接近，平局风险偏高'));
        strip.append(main);
        const had=el('div','risk-inline-handicap');
        const official=Number(row.officialHandicap);
        const officialText=Number.isFinite(official)
          ?'主队 '+(official>0?'+':'')+(Number.isInteger(official)?official:official.toFixed(2).replace(/0+$/,'').replace(/\.$/,''))
          :'未确认';
        const officialLine=el('div','risk-inline-handicap-line');
        officialLine.append(el('strong','','官方让球'),el('span','',officialText));had.append(officialLine);
        const pickLabel=v=>({HWIN:'让胜',HDRAW:'让平',HLOSS:'让负'})[String(v??'').trim()]||String(v??'').trim();
        const first=pickLabel(row.handicapTop1??row.handicap),second=pickLabel(row.handicapSecond);
        const p1=Number(row.handicapProbability??row.handicap_probability);
        const p2=Number(row.handicapSecondProbability??row.handicap_second_probability);
        const result=verified(row)?effectiveHandicapResult(row):null;
        const picksLine=el('div','risk-inline-handicap-line');picksLine.append(el('strong','','让球保护'));
        const picks=el('div','risk-inline-handicap-picks');
        const firstText=first+(Number.isFinite(p1)?' '+probability(p1):'')+(result===first?' ✅':'');
        picks.append(el('span','risk-inline-handicap-pick'+(result===first?' hit':''),firstText));
        if(validHandicapPick(second)&&Number.isFinite(p2)){
          picks.append(el('span','risk-inline-handicap-sep',' + '));
          const secondText=second+' '+probability(p2)+(result===second?' ✅':'');
          picks.append(el('span','risk-inline-handicap-pick'+(result===second?' hit':''),secondText));
        }
        picksLine.append(picks);had.append(picksLine);strip.append(had);card.append(strip);
      }
      if(row.marketDirectionAnomaly===true){
        const strip=el('div','risk-inline strong');
        const main=el('div','risk-inline-main');
        main.append(el('strong','','市场异动信号'),el('span','','市场方向变化'));
        strip.append(main);
        const had=el('div','risk-inline-handicap');
        const official=Number(row.officialHandicap);
        const officialText=Number.isFinite(official)
          ?'主队 '+(official>0?'+':'')+(Number.isInteger(official)?official:official.toFixed(2).replace(/0+$/,'').replace(/\.$/,''))
          :'未确认';
        const officialLine=el('div','risk-inline-handicap-line');
        officialLine.append(el('strong','','官方让球'),el('span','',officialText));
        had.append(officialLine);
        const picksLine=el('div','risk-inline-handicap-line');
        picksLine.append(el('strong','','让球保护'));
        const picks=el('div','risk-inline-handicap-picks');
        const protectionFirst=String(row.marketProtectionFirst??(official<0?'让负':'让胜'));
        const protectionSecond=String(row.marketProtectionSecond??'让平');
        const frozenTop1=String(row.handicapTop1??row.handicap_pick??row.handicapPick??'');
        const frozenSecond=String(row.handicapSecond??'');
        const top1Pct=Number(row.handicapProbability);
        const secondPct=Number(row.handicapSecondProbability);
        const result=String(row.handicapResult??'');
        const firstPct=(protectionFirst===frozenTop1&&Number.isFinite(top1Pct))?top1Pct:((protectionFirst===frozenSecond&&Number.isFinite(secondPct))?secondPct:null);
        const secondPctShown=(protectionSecond===frozenTop1&&Number.isFinite(top1Pct))?top1Pct:((protectionSecond===frozenSecond&&Number.isFinite(secondPct))?secondPct:null);
        const firstText=protectionFirst+(firstPct!==null?' '+probability(firstPct):'')+(result===protectionFirst?' ✅':'');
        const secondText=protectionSecond+(secondPctShown!==null?' '+probability(secondPctShown):'')+(result===protectionSecond?' ✅':'');
        picks.append(el('span','risk-inline-handicap-pick'+(result===protectionFirst?' hit':''),firstText));
        picks.append(el('span','risk-inline-handicap-sep',' + '));
        picks.append(el('span','risk-inline-handicap-pick'+(result===protectionSecond?' hit':''),secondText));
        picksLine.append(picks);had.append(picksLine);strip.append(had);card.append(strip);return;
      }
      const info=upsetInfo(row);if(!info)return;
      const strip=el('div','risk-inline '+(info.displayTier==='强风险信号'?'strong':'focus'));
      const main=el('div','risk-inline-main');
      main.append(el('strong','',info.displayTier),el('span','',info.inlineReason));
      strip.append(main);

      const pickLabel=value=>{
        const raw=String(value??'').split(' · ')[0].trim();
        return ({HWIN:'让胜',HDRAW:'让平',HLOSS:'让负'})[raw]||raw;
      };
      const handicapPick=pickLabel(row.handicapTop1??row.handicap);
      const handicapSecond=pickLabel(row.handicapSecond);
      const readPct=keys=>{
        for(const key of keys){
          const raw=row[key];
          if(raw===null||raw===undefined||raw==='')continue;
          const n=Number(raw);
          if(Number.isFinite(n))return n<=1?n*100:n;
        }
        return null;
      };
      const hadPct=readPct(['handicapProbability','handicap_probability','top1Probability','top1_probability']);
      const hadSecondPct=readPct(['handicapSecondProbability','handicap_second_probability','secondProbability','second_probability']);
      const homePct=readPct(['homeProbability','homePct','home_pct','ftHomeProbability','ft_home_probability']);
      const awayPct=readPct(['awayProbability','awayPct','away_pct','ftAwayProbability','ft_away_probability']);
      const confidencePct=readPct(['confidence']);
      const gap=homePct!==null&&awayPct!==null?Math.abs(homePct-awayPct):null;
      const strongHandicap=info.oppositeSecond===true&&
        confidencePct!==null&&confidencePct<=42&&
        gap!==null&&gap<=6&&
        hadPct!==null&&hadPct>=58;

      if(info.oppositeSecond===true&&validHandicapPick(handicapPick)&&hadPct!==null){
        const had=el('div','risk-inline-handicap'+(strongHandicap?' strong-handicap':''));

        const official=Number(row.officialHandicap);
        const officialText=Number.isFinite(official)
          ?'主队 '+(official>0?'+':'')+(Number.isInteger(official)?official:official.toFixed(2).replace(/0+$/,'').replace(/\.$/,''))
          :'未确认';
        const officialLine=el('div','risk-inline-handicap-line');
        officialLine.append(el('strong','','官方让球'),el('span','',officialText));
        had.append(officialLine);

        const result=verified(row)?pickLabel(effectiveHandicapResult(row)):null;
        const picksLine=el('div','risk-inline-handicap-line');
        picksLine.append(el('strong','','让球保护'));
        const picks=el('div','risk-inline-handicap-picks');
        const firstText=handicapPick+' '+probability(hadPct)+(result===handicapPick?' ✅':'');
        picks.append(el('span','risk-inline-handicap-pick'+(result===handicapPick?' hit':''),firstText));
        if(validHandicapPick(handicapSecond)&&hadSecondPct!==null){
          picks.append(el('span','risk-inline-handicap-sep',' + '));
          const secondText=handicapSecond+' '+probability(hadSecondPct)+(result===handicapSecond?' ✅':'');
          picks.append(el('span','risk-inline-handicap-pick'+(result===handicapSecond?' hit':''),secondText));
        }
        picksLine.append(picks);
        had.append(picksLine);
        strip.append(had);
      }
      card.append(strip);
    }
    function upsetCard(row){
      const info=upsetInfo(row),card=el('article','match-card upset-card');
      const isVerified=verified(row),original=normalizeResult(info.originalPick),actual=normalizeResult(row.result);
      const evaluable=isVerified&&original&&actual&&original!=='未确认'&&actual!=='未确认';
      const caught=evaluable&&original!==actual,stateText=!isVerified?'待核验':!evaluable?'已完赛':caught?'风险预警有效':'风险预警无效';
      const top=el('div','upset-top');
      const kickoff=row.kickoff?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(row.kickoff)).replaceAll('/','-'):'时间未确认';
      const weekday=row.kickoff?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',weekday:'short'}).format(new Date(row.kickoff)):'';
      top.append(el('span','upset-league',safe(row.league)),el('span','upset-kickoff',kickoff),el('span','upset-match-no',weekday+safe(row.no)));
      const state=el('div','upset-state '+(!isVerified?'pending':caught?'success':'fail'),stateText);
      const home=safe(row.homeTeam??row.home),away=safe(row.awayTeam??row.away);
      const team=(name,logo,side)=>{
        const box=el('div','upset-team '+side),crest=el('div','upset-crest');
        if(logo){const img=document.createElement('img');img.alt=name+'队徽';img.loading='lazy';img.onerror=()=>{img.remove();showTeamIconFallback(crest,name)};crest.append(img);img.src=String(logo)}
        else showTeamIconFallback(crest,name);
        box.append(crest,el('div','upset-team-name',name));return box;
      };
      const fixture=el('div','upset-fixture');
      const score=isVerified?(row.resultScore??(row.resultHome!==null&&row.resultHome!==undefined&&row.resultAway!==null&&row.resultAway!==undefined?row.resultHome+':'+row.resultAway:'完赛')):'VS';
      fixture.append(team(home,row.homeLogo??row.home_logo??row.homeTeamLogo,'home'),el('div','upset-score',String(score).replace('-',':')),team(away,row.awayLogo??row.away_logo??row.awayTeamLogo,'away'));
      const main=el('div','upset-main'),indexPanel=el('div','upset-panel'),directionPanel=el('div','upset-panel');
      indexPanel.append(el('div','upset-value risk-level'+(info.displayTier==='强风险信号'?' high':''),info.displayTier),el('div','upset-label',info.score===null?'分值待确认':Number(info.score).toFixed(1)+'分'));
      directionPanel.append(el('div','upset-value direction',info.direction||(info.qualifiedDraw?'平局风险':'首选失手风险')),el('div','upset-label','风险类型'));
      main.append(indexPanel,directionPanel);
      const evidence=el('details','upset-evidence'),summary=el('summary','','查看分析依据');
      evidence.append(summary,
        el('p','upset-evidence-heading','风险提示'),
        el('p','','风险层级由赛前多维数据综合评估；页面仅展示已核验的风险结论与主要证据。'),
        el('p','','数据分值用于辅助理解风险强弱，不是胜率、准确率或结果保证。'),
        el('p','upset-evidence-heading','本场分析依据'),
        el('p','','当前层级：'+info.displayTier+' ｜ 赛前原始首选：'+safe(info.originalPick)));
      (info.evidenceLines||[info.reason]).slice(0,3).forEach((line,i)=>evidence.append(el('p','','依据'+(i+1)+'：'+line)));
      if(info.directionEligible===false)evidence.append(el('p','','方向依据：当前数据质量不足以发布具体反向方向，仅保留已核验的风险分歧提示。'));
      else if(info.directionReason)evidence.append(el('p','','方向依据：'+info.directionReason));
      else evidence.append(el('p','','方向依据：独立证据域不足，不强行反推具体方向'));
      if(info.alternativePick)evidence.append(el('p','','证据倾向：'+safe(info.alternativePick)));
      evidence.append(el('p','','九十刻度赛前预警'),el('p','','赛前冻结：'+fmtStamp(info.prematchAt)));
      card.append(top,state,fixture,main,evidence);card.setAttribute('role','button');card.tabIndex=0;card.onclick=e=>{if(e.target.closest('details'))return;openDetail(row,false)};card.onkeydown=e=>{if(e.key==='Enter'&&e.target===card)openDetail(row,false)};return card;
    }
    function filterRows(rows){
      if(state.model==='daily')return rows.filter(r=>isFocus(r)||isSupplement(r));
      if(state.model==='upset')return rows.filter(r=>upsetInfo(r)!==null);
      return rows
    }
    function visibleRows(){if(!state.today)return [];return filterRows(state.today.rows||[])}
    // Reuse already-built match-card DOM while switching modules on the same data generation.
    // A background API refresh that returns identical rows updates freshness but keeps the same
    // generation, so it no longer destroys every module cache every two minutes.
    const moduleGridCache=new Map(),moduleGridBuildState=new WeakMap(),MODULE_GRID_CACHE_MAX=4;
    function moduleGridKey(rows,history,scope){
      const snapshot=dayCache.get(state.selectedDate)?.version||0;
      return [state.selectedDate||'',state.model,history?'history':'live',scope,
        (memberInfo?.active===true||rows.every(publicSettledAccess))?'full':'preview',vipDeepAccess()?'vip':'standard',snapshot,rows.length].join('|');
    }
    function scheduleModuleGridBuild(grid){
      const meta=moduleGridBuildState.get(grid);
      if(!meta||meta.cancelled||meta.scheduled||meta.next>=meta.rows.length||state.model!==meta.model)return;
      meta.scheduled=true;
      const run=deadline=>{
        meta.scheduled=false;
        if(meta.cancelled||state.model!==meta.model)return;
        const started=performance.now();let built=0,fragment=document.createDocumentFragment();
        while(meta.next<meta.rows.length){
          const row=meta.rows[meta.next++];
          fragment.append(meta.model==='upset'?upsetCard(row):matchCard(row,meta.history));
          built++;
          const lowIdle=deadline&&typeof deadline.timeRemaining==='function'&&deadline.timeRemaining()<5;
          if(lowIdle||(!deadline&&(built>=2||performance.now()-started>8)))break;
        }
        if(fragment.childNodes.length)grid.append(fragment);
        if(meta.next<meta.rows.length)scheduleModuleGridBuild(grid);
      };
      if('requestIdleCallback' in window)window.requestIdleCallback(run,{timeout:140});
      else setTimeout(()=>run(null),16);
    }
    function getModuleGrid(rows,history=false,scope='main'){
      const key=moduleGridKey(rows,history,scope),cached=moduleGridCache.get(key);
      if(cached){
        moduleGridCache.delete(key);moduleGridCache.set(key,cached);
        scheduleModuleGridBuild(cached);
        return cached;
      }
      const grid=el('div','cards'),meta={rows,history,model:state.model,next:0,scheduled:false,cancelled:false};
      moduleGridBuildState.set(grid,meta);
      const immediate=Math.min(rows.length,2);
      while(meta.next<immediate){
        const row=rows[meta.next++];
        grid.append(meta.model==='upset'?upsetCard(row):matchCard(row,history));
      }
      moduleGridCache.set(key,grid);
      while(moduleGridCache.size>MODULE_GRID_CACHE_MAX){
        const oldest=moduleGridCache.keys().next().value,oldGrid=moduleGridCache.get(oldest);
        const oldMeta=oldGrid&&moduleGridBuildState.get(oldGrid);if(oldMeta)oldMeta.cancelled=true;
        moduleGridCache.delete(oldest);
      }
      scheduleModuleGridBuild(grid);
      return grid;
    }
    function currentTitle(){return {overview:'今日竞足',handicap:'全场让球',wdl:'胜平负',goals:'泊松进球',score:'比分Top4',htft:'半全场Top4',daily:'今日优选',upset:'风险观察'}[state.model]||'今日竞足'}

    function engineBanner(){const b=el('button','engine-banner');b.type='button';b.append(el('strong','','九十刻度 · 多维赛事数据分析'),el('small','','结合球队表现、市场赔率、比赛进球分布与风险信息，提供结构化赛事数据报告'));const tags=el('div','engine-tags');['市场赔率','球队实力','独立概率','风险审计'].forEach(t=>tags.append(el('span','',t)));b.append(tags);b.onclick=()=>{state.tab='profile';document.querySelectorAll('.nav').forEach(n=>n.classList.toggle('active',n.dataset.tab==='profile'));render()};return b}
    function updateNotice(){if(state.tab!=='home'||!['daily','overview','handicap','htft','score','goals'].includes(state.model))return null;const p=el('div','');p.style.cssText='margin:10px 16px;padding:12px 13px;background:#fff8ec;border:1px solid #f1d9b0;border-radius:10px;color:#795726;font-size:12px;line-height:1.7';const heading=el('strong','','赛事数据更新说明');heading.style.cssText='display:block;color:#654718;font-size:13px;margin-bottom:5px';const main=el('div','','每日赛事分析通常于北京时间12:00前后陆续发布。');main.style.cssText='margin-bottom:5px';const detail=el('div','','建议在赛前2–4小时再次查看。随着比赛临近，赔率、盘口及相关赛事数据会持续变化，这一阶段的数据通常更接近临场状态。');detail.style.cssText='margin-bottom:5px';const freeze=el('div','','模型预测以赛前确认版本为准。后续即使赔率或盘口发生变化，也不会自动改写已经发布的预测结果，避免出现赛后回改。');freeze.style.cssText='margin-bottom:7px';const foot=el('div','','不同数据项的更新时间可能存在差异，请以页面显示的最新更新时间为准。');foot.style.cssText='padding:7px 9px;background:#fffdf8;border-radius:7px;color:#806c4c';p.append(heading,main,detail,freeze,foot);return p}
    function renderCards(title,sub,rows,history=false){
      const box=$('content');box.replaceChildren(sectionHead(title,sub));const updateTip=updateNotice();if(updateTip)box.append(updateTip);
      if(state.model==='upset'&&state.selectedDate>='2026-09-20'&&state.selectedDate<'2026-09-26'){
        const tip=el('div','htft-list-note');
        tip.textContent='新版规则历史回放 · 仅使用该场当时赛前冻结的首选/次选、市场快照与独立模型数据重新分层；不使用赛果，不改写当时原始风险记录。';
        box.append(tip);
      }
      if(!rows.length){box.append(empty(state.model==='upset'?'暂无可核验的赛前风险记录':state.model==='daily'?'今日暂无优选场次':'暂无已发布赛事',state.model==='upset'?'本日暂无通过重点风险门槛的赛前记录；一般风险仅保留在比赛详情中。':'当前没有符合筛选条件的赛事记录。'),notice());return}
      const grid=getModuleGrid(rows,history,'renderCards');box.append(grid,notice())
    }
    function hasNoEvents(){return Array.isArray(state.today?.rows)&&state.today.rows.length===0}
    function noEventsBox(){return state.today?.publicationStatus==='LOTTERY_CLOSED'
      ?empty('休市期间，暂无竞彩赛事','10月5日恢复开售后自动更新')
      :empty('暂无已发布赛事','当前没有符合筛选条件的赛事记录。')}
    function renderHome(){
      if(state.model==='cold'){
        if(memberInfo?.vipActive!==true){renderPaidMemberRequired();return}
        const d=memberZoneDate();
        if(!state.memberZone||state.memberZone.date!==d){
          if(!state.memberZoneLoading){loadMemberZone();return}
        }
        renderMemberZone();return
      }
      if(hasNoEvents()&&!state.unopenedDate){
        const box=$('content');box.replaceChildren();
        const updateTip=updateNotice();if(updateTip)box.append(updateTip);
        box.append(noEventsBox(),notice());return
      }
      if(state.unopenedDate){
        const box=$('content');box.replaceChildren();
        const updateTip=updateNotice();if(updateTip)box.append(updateTip);
        box.append(empty('赛事数据待更新','正在等待该日期比赛与预测同步。'));return
      }
      if(state.today?.analysisPending===true){
        const pendingRows=state.today.rows||[];
        renderCards('今日赛事',pendingRows.length+'场 · 赛前分析待发布',pendingRows);return
      }
      const all=visibleRows();
      const pending=state.model==='daily'?(state.today?.rows||[]).filter(r=>r.analysisPending===true):[];
      const focus=state.model==='daily'?all.filter(isFocus):[];
      const supplement=state.model==='daily'?all.filter(r=>isSupplement(r)&&!isFocus(r)):[];
      if(state.model==='daily'&&pending.length){
        const box=$('content');box.replaceChildren();
        const updateTip=updateNotice();if(updateTip)box.append(updateTip);
        const summary=el('div','daily-summary');
        summary.append(
          el('b','core-count','赛前分析待发布'),
          el('span','dot','·'),
          el('span','','今日共 '+pending.length+'场')
        );
        box.append(summary,sectionHead('今日赛事',pending.length+'场 · 赛前分析待发布'));
        box.append(getModuleGrid(pending,false,'daily-pending'),notice());
        return;
      }
      if(state.model==='upset'){
        const replay=state.selectedDate>='2026-09-20'&&state.selectedDate<'2026-09-26';
        renderCards('风险观察',all.length+'场 · '+(replay?'新版规则历史回放':'九十刻度赛前风险记录'),all);return
      }
      if(state.model==='overview'){renderCards('全场胜平负',all.length+'场 · 九十刻度',all);return}
      if(state.model!=='daily'){renderCards(currentTitle(),all.length+'场 · 九十刻度',all);return}
      const box=$('content');box.replaceChildren();
      const updateTip=updateNotice();if(updateTip)box.append(updateTip);
      const summary=el('div','daily-summary');
      summary.append(
        el('b','core-count','核心优选 '+focus.length+'场'),
        el('span','dot','·'),
        el('b','supp-count','精选补充 '+supplement.length+'场'),
        el('span','dot','·'),
        el('span','','今日共 '+all.length+'场')
      );
      box.append(summary);
      box.append(sectionHead('核心优选',focus.length+'场 · 通过核心筛选'));
      if(focus.length){
        box.append(getModuleGrid(focus,false,'daily-focus'))
      }else box.append(empty('今日暂无核心优选','当前没有通过核心筛选条件的场次。'));
      box.append(sectionHead('精选补充',supplement.length+'场 · 高性价比筛选 · 风险过滤通过'));
      if(supplement.length){
        box.append(getModuleGrid(supplement,false,'daily-supplement'))
      }else box.append(empty('今日暂无精选补充','仅补充未进入核心优选、且通过高性价比筛选与风险过滤的场次。'));
      box.append(notice())
    }
    function renderMatches(){const rows=visibleRows();renderCards(currentTitle()+'赛事',rows.length+'场 · 九十刻度',rows)}
    async function renderHistory(){
      if(state.unopenedDate){$('content').replaceChildren(empty('赛事数据待更新','可选择此前日期查看赛果。'));return}
      const box=$('content');box.replaceChildren(sectionHead('真实战绩','仅已核验赛果'));
      if(!state.history){box.append(empty('正在读取战绩','只统计同时具备赛前冻结证据和赛果核验的记录。'));try{const h=await load('history',state.selectedDate);state.history=h;renderHistory()}catch(e){box.replaceChildren(errorBox(e))}return}
      const rows=filterRows(state.history.rows||[]);if(!rows.length){box.append(empty('暂无已核验战绩','当前模块没有同时满足赛前冻结与赛果核验的记录。'),notice());return}
      const grid=getModuleGrid(rows,true,'history');const statsNote=el('section','risk-sample');statsNote.style.cssText='margin:12px 16px;padding:14px 15px;background:#fff;border:1px solid #eee;border-radius:12px;font-size:12px;line-height:1.7;color:#555';statsNote.textContent='统计口径：本页仅展示已核验赛果的场次；顶部百分比按当前所选玩法、当前日期和有效评测场次计算。胜平负首选=首选命中数/有效场次；双选覆盖=首选或次选命中数/有效场次；让球=对应让球方向命中数/具备赛前让球预测及赛果的场次；综合评测=页面所列方向任一命中/有效场次；冷门避冷=原始首选未打出/已核验预警场次。各玩法分母不同，不可混作同一胜率；缺预测或缺赛果的场次不计入命中率，须另行列示。';box.replaceChildren(sectionHead('真实战绩',rows.length+'场 · 赛果已核验'),statsNote,grid,notice())
    }
    function renderFeedbackPage(){
      const box=$('content');box.replaceChildren(sectionHead('留言与建议','用户反馈'));
      const page=el('div','profile-page feedback-page'),head=el('div','feedback-head');
      const back=el('button','feedback-back','‹ 返回');back.type='button';back.onclick=()=>{feedbackMode=null;render()};
      const title=el('div');title.append(el('h3','',feedbackMode==='admin'?'客户留言管理':'留言与建议'),
        el('p','','你提交的留言仅本人和授权管理员可查看。'));
      head.append(back,title);page.append(head);
      const tabs=el('div','feedback-tabs');
      const choices=[['write','我要留言'],['mine','我的留言']];
      if(memberInfo?.isAdmin===true)choices.push(['admin','管理留言']);
      choices.forEach(([mode,label])=>{
        const b=el('button',feedbackMode===mode?'active':'',label);
        b.type='button';b.onclick=()=>{feedbackMode=mode;renderFeedbackPage()};tabs.append(b);
      });
      page.append(tabs);box.append(page);
      if(feedbackMode==='write'){
        const form=el('div','feedback-card');
        form.append(el('h4','','请选择反馈类型'));
        const categories=el('div','feedback-categories');
        for(const category of ['功能建议','网站问题','会员咨询','其他反馈']){
          const button=el('button',feedbackDraft.category===category?'active':'',category);
          button.type='button';
          button.onclick=()=>{feedbackDraft.category=category;renderFeedbackPage()};
          categories.append(button);
        }
        form.append(categories,el('label','','留言内容'));
        const input=el('textarea','feedback-input');input.placeholder='请描述遇到的问题，或者希望九十刻度增加的功能…';
        input.maxLength=500;input.value=feedbackDraft.content;input.setAttribute('aria-label','留言内容');
        const counter=el('div','feedback-char'),send=el('button','feedback-submit','提交留言'),msg=el('p','feedback-message','');
        send.type='button';
        const update=()=>{feedbackDraft.content=input.value;counter.textContent=String(input.value.length)+'/500字';send.disabled=!input.value.trim()||input.value.length>500};
        input.oninput=update;update();
        send.onclick=async()=>{
          send.disabled=true;msg.textContent='正在提交…';
          try{
            await feedbackRequest({action:'create'},{category:feedbackDraft.category,content:feedbackDraft.content});
            feedbackDraft={category:'功能建议',content:''};feedbackMode='mine';renderFeedbackPage();
          }catch(error){msg.textContent=error.message;update()}
        };
        form.append(input,counter,send,msg);page.append(form);
        page.append(el('p','feedback-hint','请勿填写密码、身份证号或其他敏感个人信息。留言仅用于网站服务与问题处理。'));
        return;
      }
      if(feedbackMode==='admin'&&memberInfo?.isAdmin!==true){feedbackMode='mine';renderFeedbackPage();return}
      if(feedbackMode==='admin'){
        const filters=el('div','feedback-tabs');
        for(const [filter,label] of [['all','全部'],['pending','待处理'],['replied','已回复'],['resolved','已处理']]){
          const b=el('button',feedbackFilter===filter?'active':'',label);
          b.type='button';b.onclick=()=>{feedbackFilter=filter;renderFeedbackPage()};filters.append(b);
        }
        page.append(filters);
      }
      const meta=el('div','feedback-list-meta','正在读取留言…'),list=el('div','feedback-list');
      page.append(meta,list);
      const mode=feedbackMode;
      (async()=>{
        try{
          const data=await feedbackRequest({scope:mode==='admin'?'admin':'mine',
            ...(mode==='admin'?{filter:feedbackFilter}:{})});
          if(!list.isConnected||feedbackMode!==mode)return;
          meta.textContent=(mode==='admin'?'待处理 '+data.pendingCount+' 条 · ':'')+
            '共 '+data.count+' 条'+(data.count>50?'，仅展示最近50条':'');
          list.replaceChildren();
          if(!data.items.length){list.append(el('div','feedback-card','暂无留言记录'));return}
          for(const item of data.items){
            const card=el('div','feedback-card'),heading=el('div','feedback-card-head');
            heading.append(el('strong','',item.category));
            const label=({pending:'待处理',replied:'已回复',resolved:'已处理'})[item.status]||'待处理';
            heading.append(el('span','feedback-chip '+item.status,label));card.append(heading);
            if(mode==='admin')card.append(el('div','feedback-time','用户 '+String(item.user_id||'').slice(0,8)+'…'));
            card.append(el('div','feedback-text',item.content),
              el('div','feedback-time','提交于 '+feedbackTime(item.created_at)));
            if(item.admin_reply){
              const reply=el('div','feedback-reply');
              reply.append(el('strong','','管理员回复'),el('div','feedback-text',item.admin_reply));
              if(item.replied_at)reply.append(el('div','feedback-time',feedbackTime(item.replied_at)));
              card.append(reply);
            }
            if(mode==='admin'){
              const replyInput=el('textarea','feedback-input');replyInput.maxLength=1000;
              replyInput.setAttribute('aria-label','回复留言 '+item.id);
              replyInput.placeholder='请输入给客户的回复…';replyInput.value=item.admin_reply||'';
              const actions=el('div','feedback-admin-actions'),info=el('p','feedback-message','');
              for(const [status,title] of [['replied','回复客户'],['resolved','回复并处理']]){
                const button=el('button','',title);button.type='button';
                button.onclick=async()=>{
                  const clean=replyInput.value.trim();
                  if(!clean||Array.from(clean).length>1000){info.textContent='回复内容请控制在1至1000字以内';return}
                  [...actions.querySelectorAll('button')].forEach(b=>b.disabled=true);
                  info.textContent='正在提交回复…';
                  try{await feedbackRequest({action:'reply'},{id:item.id,reply:clean,status});
                    renderFeedbackPage()}
                  catch(error){info.textContent=error.message;[...actions.querySelectorAll('button')].forEach(b=>b.disabled=false)}
                };
                actions.append(button);
              }
              card.append(replyInput,actions,info);
            }
            list.append(card);
          }
        }catch(error){
          if(!list.isConnected||feedbackMode!==mode)return;
          meta.textContent='暂时无法读取留言';
          const retry=el('button','feedback-submit','重试读取');retry.onclick=()=>renderFeedbackPage();
          list.replaceChildren(el('p','feedback-message',error.message),retry);
        }
      })();
    }
    function renderProfile(){
      if(feedbackMode){renderFeedbackPage();return}
      const box=$('content');
      box.replaceChildren(sectionHead('我的','账号与会员'));
      const page=el('div','profile-page');
      page.append(accountPanel());

      const serviceCard=el('section','profile-service-card');
      serviceCard.append(el('h3','','服务与协议'));
      const serviceLinks=el('div','profile-service-links');
      const terms=document.createElement('a');terms.href='./legal.html#terms';terms.target='_blank';terms.rel='noopener';terms.textContent='用户服务协议';
      const privacy=document.createElement('a');privacy.href='./legal.html#privacy';privacy.target='_blank';privacy.rel='noopener';privacy.textContent='隐私政策';
      const vip=document.createElement('a');vip.href='./legal.html#vip';vip.target='_blank';vip.rel='noopener';vip.textContent='VIP会员协议';
      serviceLinks.append(terms,privacy,vip);serviceCard.append(serviceLinks);page.append(serviceCard);

      const entry=el('section','feedback-entry profile-feedback-compact');
      entry.append(el('h3','','留言与建议'),el('p','','网站问题、功能建议或会员疑问，都可以在这里告诉我们。'));
      const actions=el('div','feedback-entry-actions'),write=el('button','','我要留言');
      write.type='button';write.onclick=()=>openFeedback('write');
      const mine=el('button','','我的留言');mine.type='button';mine.onclick=()=>openFeedback('mine');
      actions.append(write,mine);
      if(memberInfo?.isAdmin===true){
        const admin=el('button','feedback-admin-open','客户留言管理');
        admin.type='button';admin.onclick=()=>openFeedback('admin');actions.append(admin);
      }
      entry.append(actions);page.append(entry);

      const more=el('details','profile-more profile-more-group');
      more.append(el('summary','','更多'));
      const moreBody=el('div','profile-more-body');
      const updates=el('details','profile-more-inner profile-changelog');
      updates.append(el('summary','','网站更新日志'));
      const updateList=el('div','profile-changelog-list');
      [
        ['09/26','赛事风险升级为重点风险 / 强风险信号分层，并在对应比赛卡片下直接展示'],
        ['09/25','完善比赛详情的数据状态与指标说明'],
        ['09/25','优化会员方案展示与人工开通流程'],
        ['09/25','补充9月19日至24日赛事球场与草皮资料']
      ].forEach(([day,description])=>{
        const item=el('div','profile-changelog-entry');
        item.append(el('span','',day),el('p','',description));updateList.append(item);
      });
      updates.append(updateList);
      const about=el('details','profile-more-inner');
      about.append(el('summary','','关于九十刻度'));
      const intro=el('p','sub','九十刻度专注赛事数据整理与分析，提供赛前优选场次及赛后数据回顾。');
      const note=el('p','sub','模型结果为概率分析，赛事结果具有不确定性。');
      about.append(intro,note);moreBody.append(updates,about);more.append(moreBody);page.append(more);
      box.append(page);
    }

    // Only accept independently published, pre-kickoff goal inputs. Never infer them from final scores.
    function publishedGoalLambda(row){
      const g=row.dynamicGoalPrediction??row.goalPrediction;
      if(!g||g.pregameVerified!==true||!g.frozenAt||!row.kickoff)return null;
      const frozen=Date.parse(g.frozenAt),kickoff=Date.parse(row.kickoff);
      if(!Number.isFinite(frozen)||!Number.isFinite(kickoff)||frozen>=kickoff)return null;
      const home=Number(g.lambdaHome),away=Number(g.lambdaAway);
      if(g.lambdaHome==null||g.lambdaAway==null||!Number.isFinite(home)||!Number.isFinite(away)||home<0||away<0||home+away<=0||home+away>15)return null;
      return home+away;
    }

    // A version is eligible only if its source parameters were retained before kickoff.
    // Original score-frozen lambda references are not relabelled as independently published goal predictions.
    function goalVersionInfo(row,kind){
      const g=kind==='dynamic'?row.dynamicGoalPrediction:row.goalPrediction;
      if(!g||g.pregameVerified!==true)return null;
      if(kind==='dynamic'&&g.sourceKind!=='MARKET_ANCHORED_POISSON_SHADOW_V01')return null;
      const kickoff=Date.parse(String(row.kickoff??'')),frozen=Date.parse(String(g.frozenAt??''));
      const home=Number(g.lambdaHome),away=Number(g.lambdaAway);
      if(!Number.isFinite(kickoff)||!Number.isFinite(frozen)||frozen>=kickoff
         ||g.lambdaHome==null||g.lambdaAway==null||!Number.isFinite(home)||!Number.isFinite(away)||home<0||away<0||home+away<=0||home+away>15)return null;
      if(kind==='dynamic'){
        const market=Date.parse(String(g.marketAt??''));
        if(!Number.isFinite(market)||market>frozen||market>=kickoff)return null;
      }
      return g;
    }
    function goalRanks(g){
      const lambda=Number(g.lambdaHome)+Number(g.lambdaAway);
      let prob=Math.exp(-lambda);const ranked=[];
      for(let k=0;k<=15;k++){if(k>0)prob*=lambda/k;ranked.push({goals:k,p:prob})}
      ranked.sort((a,b)=>b.p-a.p||a.goals-b.goals);
      return ranked;
    }
    function goalVersionPanel(row){
      const box=el('section','htft-version-area'),original=goalVersionInfo(row,'original'),dynamic=goalVersionInfo(row,'dynamic');
      if(!original&&!dynamic){box.append(el('p','goals-note','本场缺少可核验的赛前总进球参数，暂不展示预测。'));return box;}
      box.append(el('h3','','泊松进球 · 赛前版本对比'));
      const tabs=el('div','htft-version-tabs');tabs.setAttribute('role','group');tabs.setAttribute('aria-label','选择总进球计算版本');
      const dynBtn=el('button','htft-version-tab','动态赛前'),origBtn=el('button','htft-version-tab','原始赛前');
      dynBtn.type=origBtn.type='button';dynBtn.disabled=!dynamic;origBtn.disabled=!original;
      const sub=el('p','htft-version-sub'),body=el('div','');
      const renderVersion=kind=>{
        const g=kind==='dynamic'?dynamic:original;if(!g)return;
        dynBtn.classList.toggle('active',kind==='dynamic');origBtn.classList.toggle('active',kind==='original');
        dynBtn.setAttribute('aria-pressed',String(kind==='dynamic'));origBtn.setAttribute('aria-pressed',String(kind==='original'));
        sub.textContent=kind==='dynamic'?'动态赛前参数 · '+fmtStamp(g.frozenAt):'原始赛前参数 · '+fmtStamp(g.frozenAt);
        body.replaceChildren(goalPredictionPanel(row,g));
        if(original&&dynamic){
          const origTotal=Number(original.lambdaHome)+Number(original.lambdaAway);
          const dynTotal=Number(dynamic.lambdaHome)+Number(dynamic.lambdaAway);
          body.append(el('p','htft-version-compare',
            '参数对比：主队 '+Number(original.lambdaHome).toFixed(2)+' → '+Number(dynamic.lambdaHome).toFixed(2)+
            '，客队 '+Number(original.lambdaAway).toFixed(2)+' → '+Number(dynamic.lambdaAway).toFixed(2)+
            '；总进球 λ '+origTotal.toFixed(2)+' → '+dynTotal.toFixed(2)+
            (Math.abs(origTotal-dynTotal)<0.00001?'。总进球Top3一致，不重复计作两次预测。':'。两版来源可能不同，按各自有效记录展示。')));
        }
      };
      dynBtn.onclick=()=>renderVersion('dynamic');origBtn.onclick=()=>renderVersion('original');
      tabs.append(dynBtn,origBtn);box.append(tabs,sub,body);renderVersion(dynamic?'dynamic':'original');return box;
    }
    function goalStatRows(rows,kind){
      return rows.map(row=>({row,g:goalVersionInfo(row,kind)})).filter(x=>x.g);
    }
    function goalStatSummary(items){
      const finished=items.filter(({row})=>verified(row)&&hasScore(row)&&Number.isInteger(Number(row.resultHome))&&Number.isInteger(Number(row.resultAway)));
      const top1=finished.filter(({row,g})=>goalRanks(g)[0]?.goals===Number(row.resultHome)+Number(row.resultAway)).length;
      const top3=finished.filter(({row,g})=>goalRanks(g).slice(0,3).some(x=>x.goals===Number(row.resultHome)+Number(row.resultAway))).length;
      return {total:items.length,n:finished.length,top1,top3};
    }
    function isFormalGoalPrediction(row){return row.goalPrediction?.formalEligible!==false&&publishedGoalLambda({...row,dynamicGoalPrediction:null})!==null}
    function goalPredictionPanel(row,selectedGoal){
      const g=selectedGoal===undefined?(row.dynamicGoalPrediction??row.goalPrediction):selectedGoal;
      const full=fullMemberAnalysis(row);
      const marketShadow=g?.sourceKind==='MARKET_ANCHORED_POISSON_SHADOW_V01';
      const scoreReference=g?.sourceKind==='SCORE_TOP4_FROZEN_LAMBDA_REFERENCE';
      const panel=el('section','goals-panel');
      const heading=el('div','report-metric-title');
      heading.append(el('h3','',full?'泊松进球 · Top3':'泊松进球 · 概率最高'),
        metricHelp('总进球概率',full?'展示赛前模型给出的总进球概率分布，并按Top3覆盖口径进行结果核对。':'展示赛前模型概率最高的总进球数；单点概率不作为公开成败评测口径。'));
      panel.append(heading);
      const lambda=g?publishedGoalLambda({...row,dynamicGoalPrediction:null,goalPrediction:g}):null;
      if(lambda===null){panel.append(el('p','goals-note','赛前总进球参数未确认，不计入本版统计。'));return panel}
      const ranks=goalRanks(g);
      panel.append(el('p','sub','双方预期进球：'+Number(g.lambdaHome).toFixed(2)+' / '+Number(g.lambdaAway).toFixed(2)+'；预计总进球λ：'+lambda.toFixed(2)+'。'));
      const grid=el('div','goals-grid');
      (full?ranks.slice(0,3):ranks.slice(0,1)).forEach((item,i)=>{
        const cell=el('div','goal-cell');
        cell.append(el('small','', 'Top'+(i+1)),el('b','',item.goals+'球'),el('small','',(item.p*100).toFixed(1)+'%'));grid.append(cell);
      });panel.append(grid);
      if(!full)panel.append(el('div','member-preview-lock','会员可查看Top3及完整概率分布'));
      if(verified(row)&&hasScore(row)){
        const actual=Number(row.resultHome)+Number(row.resultAway),top1=ranks[0]?.goals===actual,top3=ranks.slice(0,3).some(x=>x.goals===actual);
        panel.append(el('div','goals-verdict',full?('实际总进球 '+actual+'球 · Top3 · '+(top3?'评测成功':'评测失败')):(top1?('✓ 最高概率 · 评测成功 · 实际总进球 '+actual+'球'):('实际总进球 '+actual+'球'))));
      }else panel.append(el('div','goals-verdict','等待评测'));
      panel.append(el('p','goals-note','赛前数据已留存；赛果核验后每场只评测一次。'));
      return panel;
    }
    function teamOverviewPanel(row){
      const kickoff=Date.parse(row.kickoff);
      const valid=item=>item?.verified===true&&Number.isFinite(kickoff)&&Number.isFinite(Date.parse(item.capturedAt))&&Date.parse(item.capturedAt)<kickoff;
      const form=valid(row.teamFormH2h)?row.teamFormH2h:null;
      const schedule=valid(row.teamSchedule)?row.teamSchedule:null;
      if(!form&&!schedule)return null;
      const panel=reportSection('球队近况');panel.classList.add('team-overview');
      const futureFresh=!!schedule&&(kickoff<=Date.now()||Date.now()-Date.parse(schedule.capturedAt)<=24*3600000);
      const percentage=(n,v)=>n>0&&v!==null&&v!==undefined&&Number.isFinite(Number(v))?Number(v).toFixed(1)+'%':'—';
      const days=v=>v!==null&&v!==undefined&&Number.isFinite(Number(v))&&Number(v)>=0?Number(v).toFixed(1)+'天':'—';
      const sides=[[row.home,form?.home,schedule?.home],[row.away,form?.away,schedule?.away]];
      const cards=el('div','team-overview-grid');
      for(const [team,record,plan] of sides){
        const card=el('div','team-overview-team');card.append(el('div','team-overview-name',String(team)));
        if(record&&Number.isInteger(record.n)&&record.n>0){
          card.append(el('div','team-overview-metric',record.wins+'胜 '+record.draws+'平 '+record.losses+'负'));
          card.append(el('div','team-overview-muted','近'+record.n+'场 · 胜率 '+percentage(record.n,record.winPct)));
        }else card.append(el('div','team-overview-muted','近期比赛资料不足，暂不展示胜率'));
        card.append(el('div','team-overview-rest','赛前休息 '+days(plan?.restDays)));
        cards.append(card);
      }
      panel.append(cards);
      const h=form?.h2h,h2h=el('div','team-overview-h2h');
      if(h&&Number.isInteger(h.n)&&h.n>0){
        h2h.append(el('span','team-overview-h2h-name','双方近'+h.n+'次交锋'));
        h2h.append(el('span','team-overview-h2h-values',
          String(row.home)+'胜 '+percentage(h.n,h.homeWinPct)+' · 平 '+percentage(h.n,h.drawPct)+' · '+String(row.away)+'胜 '+percentage(h.n,h.awayWinPct)));
      }else h2h.append(el('span','team-overview-h2h-name','历史交锋资料不足，暂不计算胜率'));
      panel.append(h2h);
      const details=el('details','team-overview-details');details.append(el('summary','','查看逐场比分及未来赛程'));
      const expanded=el('div','team-overview-expanded');
      for(const [team,record,plan] of sides){
        expanded.append(el('div','team-overview-group-title',String(team)+' · 比赛记录'));
        if(record?.n>0&&Array.isArray(record.matches)){
          for(const item of record.matches){
            if(!item?.kickoffAt)continue;
            reportLine(expanded,fmtTime(item.kickoffAt)+' · '+String(item.outcome||''),
              String(item.venue||'')+' 对 '+String(item.opponent||'未确认')+' '+String(item.goalsFor)+'—'+String(item.goalsAgainst));
          }
        }else expanded.append(el('p','report-sub','近期逐场比分暂无可靠记录'));
        if(!plan)expanded.append(el('p','report-sub','后续赛程尚未确认'));
        else if(!futureFresh)expanded.append(el('p','report-sub','未来赛程正在更新，暂不展示过期安排'));
        else{
          const upcoming=Array.isArray(plan.next7)?plan.next7:[];
          expanded.append(el('p','report-sub','本场后7天已收录 '+String(plan.next7Count??upcoming.length)+' 场'));
          for(const item of upcoming)if(item?.kickoffAt)
            reportLine(expanded,fmtTime(item.kickoffAt),String(item.venue||'')+' 对 '+String(item.opponent||'未确认')+(item.competition?' · '+String(item.competition):''));
        }
      }
      expanded.append(el('div','team-overview-group-title','双方历史交锋'));
      if(h?.n>0&&Array.isArray(h.matches)){
        for(const item of h.matches)if(item?.kickoffAt)
          reportLine(expanded,fmtTime(item.kickoffAt),
            String(item.homeName||'主队')+' '+String(item.homeScore)+'—'+String(item.awayScore)+' '+String(item.awayName||'客队'));
      }else expanded.append(el('p','report-sub','暂无可核验的交锋记录，不代表双方从未交手'));
      expanded.append(el('p','team-overview-foot','来源：FotMob · 数据采集于'+fmtStamp(form?.capturedAt||schedule?.capturedAt)+'。仅为历史统计，非本场预测概率；赛程可能调整。'));
      details.append(expanded);panel.append(details);
      return panel;
    }
    function reportSection(title){const section=el('section','report-section');section.append(el('h3','',title));return section}
    function reportLine(parent,label,value){const line=el('div','report-line');line.append(el('span','',label),el('b','',safe(value)));parent.append(line)}
    // Lightweight, locally rendered disclosure: no API calls or background observers.
    function metricHelp(label,explanation){
      const help=el('details','metric-help');
      const toggle=el('summary','','?');toggle.setAttribute('aria-label','查看'+label+'说明');
      toggle.title='查看'+label+'说明';
      help.append(toggle,el('p','',explanation));
      return help;
    }
    function reportProbability(parent,label,fields,row){
      const wrap=el('div','report-grid');
      fields.forEach((field,i)=>{const cell=el('div','report-cell');cell.append(el('small','',['主胜','平局','客胜'][i]),el('strong','',probability(row[field])));wrap.append(cell)});
      const heading=el('div','report-metric-title');
      heading.append(el('span','',label),
        metricHelp('胜平负概率','主胜、平局、客胜为模型对90分钟赛果的概率估算。平局概率表示模型估计双方90分钟战平的可能性，不代表必然发生，也不等于投注收益。'));
      parent.append(heading,wrap);
    }

    function reportOddsGrid(section,label,values){
      const grid=el('div','report-grid');['主胜','平局','客胜'].forEach((name,i)=>{
        const cell=el('div','report-cell'),value=values?.[i];cell.append(el('small','',name),el('strong','',value===null||value===undefined?'未确认':String(value)));grid.append(cell)
      });section.append(el('p','report-sub',label),grid)
    }

    const reportHas=v=>v!==null&&v!==undefined&&String(v).trim()!==''&&String(v)!=='未确认'&&String(v)!=='PASS';
    const reportTriplet=a=>Array.isArray(a)&&a.length===3&&a.every(v=>v!==null&&v!==undefined&&Number.isFinite(Number(v))&&Number(v)>=0&&Number(v)<=100);
    function reportDisclosure(title){
      const details=el('details','report-section report-more'),summary=el('summary','',title);
      details.append(summary);return details;
    }
    // Verified match venues: customer-facing Chinese display names only; retain FotMob originals for audit.
    const venueChineseNames={
      "Allianz Stadium": "都灵安联体育场",
      "BayArena": "拜耳竞技场",
      "Estadio Abanca-Riazor": "里亚索球场",
      "Johan Cruijff ArenA": "约翰·克鲁伊夫竞技场",
      "Riyadh Air Metropolitano": "大都会球场",
      "Stadio Giuseppe Meazza": "朱塞佩·梅阿查球场",
      "The Brick Community Stadium": "布里克社区球场",
      "Allianz Arena": "慕尼黑安联球场",
      "Allianz Riviera": "安联里维埃拉球场",
      "Anfield": "安菲尔德球场",
      "Nagoya City Mizuho Park Rugby Field": "名古屋市瑞穗公园橄榄球场",
      "Toyota Stadium": "丰田体育场",
      "Yanmar Stadium Nagai": "大阪长居体育场",
      "Fujieda Soccer Stadium": "藤枝综合运动公园足球场",
      "Wave Stadium Kariya": "刈谷波浪体育场",
      "Gifu Nagaragawa Stadium": "岐阜长良川竞技场",
      "Q&A Stadium Miyagi": "宫城体育场",
      "Suwon World Cup Stadium": "水原世界杯体育场",
      "Chongqing Longxing Football Stadium": "重庆龙兴足球场",
      "Stadiumi Fadil Vokrri": "法迪尔·沃克里体育场",
      "Stadion Rajko Mitić": "拉伊科·米蒂奇体育场",
      "Ullevaal Stadion": "乌勒瓦尔体育场",
      "Anyang Stadium": "安养体育场",
      "Åråsen Stadion": "阿罗森球场",
      "Ashton Gate Stadium": "阿什顿门球场",
      "bet365 Stadium": "bet365球场",
      "Bluenergy Stadium": "蓝色能源球场",
      "CEPAC Vélodrome": "马赛韦洛德罗姆球场",
      "Coventry Building Society Arena": "考文垂建筑协会竞技场",
      "Craven Cottage": "克拉文农场球场",
      "Daejeon World Cup Stadium": "大田世界杯体育场",
      "De Grolsch Veste": "赫罗尔斯城堡球场",
      "Deutsche Bank Park": "德意志银行公园球场",
      "Elland Road": "埃兰路球场",
      "Estadio Abanca-Balaídos": "巴莱多斯球场",
      "Estadio Benito Villamarín": "贝尼托·比利亚马林球场",
      "Estadio Ciudad de Vicente López": "比森特·洛佩斯城市球场",
      "Estadio Coliseum": "科利塞姆球场",
      "Estadio de la Cerámica": "陶瓷球场",
      "Estadio de Mendizorroza": "门迪索罗萨球场",
      "Estadio de Mestalla": "梅斯塔利亚球场",
      "Estadio de San Mamés": "圣马梅斯球场",
      "Estádio Do Dragão": "巨龙球场",
      "Estadio El Sadar": "埃尔萨达尔球场",
      "Estadio Jornalista Mário Filho (Maracanã)": "马拉卡纳球场",
      "Estádio José Alvalade": "若泽·阿尔瓦拉德球场",
      "Estádio José Maria de Campos Maia": "若泽·玛丽亚·德坎波斯·马亚球场",
      "Estadio La Rosaleda": "玫瑰园球场",
      "Estadio Manuel Martínez Valero": "曼努埃尔·马丁内斯·巴莱罗球场",
      "Estádio Mário Celso Petraglia": "马里奥·塞尔索·佩特拉利亚球场",
      "Estadio Municipal de Anoeta": "阿诺埃塔球场",
      "Estádio Olímpico Nilton Santos": "尼尔顿·桑托斯奥林匹克体育场",
      "Estadio Ontime Butarque": "布塔尔克球场",
      "Estadio Ramón Sánchez Pizjuán": "拉蒙·桑切斯·皮斯胡安球场",
      "Estadio Rodrigo Paz Delgado": "罗德里戈·帕斯·德尔加多球场",
      "Etihad Stadium": "伊蒂哈德球场",
      "Euroborg": "欧罗堡球场",
      "Groupama Stadium": "奥林匹克里昂公园球场",
      "Gtech Community Stadium": "Gtech社区球场",
      "Hazza Bin Zayed Stadium": "哈扎·本·扎耶德球场",
      "Hill Dickinson Stadium": "希尔·迪金森球场",
      "Hitachi Energy Arena": "日立能源竞技场",
      "Home Deluxe Arena": "家居豪华竞技场",
      "ista-Borussia-Park": "普鲁士公园球场",
      "Jeonju World Cup Stadium": "全州世界杯体育场",
      "Lotto Park": "乐透公园球场",
      "Lumen Field": "流明球场",
      "Lyse Arena": "莱瑟竞技场",
      "Machida Gion Stadium": "町田祇园体育场",
      "Markku.fi Areena": "马尔库竞技场",
      "Meadow Lane": "梅多巷球场",
      "MHPArena": "MHP竞技场",
      "Molineux Stadium": "莫利纽球场",
      "Neo GSP": "新GSP球场",
      "Neo Química Arena": "新化学竞技场",
      "Nissan Stadium": "日产体育场",
      "Nordmøre stadion": "北默勒球场",
      "Panasonic Stadium Suita": "吹田松下体育场",
      "Pankritio Stadio": "泛克里特体育场",
      "PEACE STADIUM Connected by SoftBank": "长崎和平体育场",
      "Portman Road": "波特曼路球场",
      "RCDE Stadium": "RCDE球场",
      "Riverside Stadium": "河畔球场",
      "Sarpsborg Stadion": "萨普斯堡球场",
      "Selhurst Park": "塞尔赫斯特公园球场",
      "Spotify Camp Nou": "诺坎普球场",
      "St. James' Park": "圣詹姆斯公园球场",
      "Stade Auguste-Delaune": "奥古斯特·德洛纳球场",
      "Stade Jean Bouin": "让·布安球场",
      "Stade Louis-II": "路易二世球场",
      "Stade Raymond Kopa": "雷蒙·科帕球场",
      "Stadio Artemio Franchi": "阿尔特米奥·弗兰基球场",
      "Stadio Benito Stirpe": "贝尼托·斯蒂尔佩球场",
      "Stadio Ennio Tardini": "恩尼奥·塔尔迪尼球场",
      "Stadio Olimpico": "罗马奥林匹克球场",
      "Stadio Pier Luigi Penzo": "皮埃尔·路易吉·彭佐球场",
      "Stadio Renato Dall'Ara": "雷纳托·达拉拉球场",
      "Stadion De Vliert": "德弗利尔特球场",
      "Stadion Graz-Liebenau": "格拉茨利本瑙球场",
      "Stadium MK": "米尔顿凯恩斯球场",
      "Stadium of Light": "光明球场",
      "Stadium Sultan Ibrahim Larkin": "苏丹易卜拉欣体育场",
      "Strandvallen": "斯特兰德瓦伦球场",
      "Sungui Arena Park": "崇义竞技场",
      "The City Ground": "城市球场",
      "Tottenham Hotspur Stadium": "托特纳姆热刺球场",
      "Tüpraş Stadyumu": "图普拉什球场",
      "U-Power Stadium": "U-Power球场",
      "VELTINS-Arena": "费尔廷斯竞技场",
      "Vitality Stadium": "活力球场",
      "Volksparkstadion": "人民公园球场",
      "Volkswagen Arena": "大众汽车竞技场",
      "Weserstadion": "威悉球场",
      "Workers' Stadium": "北京工人体育场",
      "Yankee Stadium": "洋基体育场"
};
    function localizedVenueName(original){
      const name=String(original??'').trim();
      return Object.prototype.hasOwnProperty.call(venueChineseNames,name)?venueChineseNames[name]:name;
    }
    function chinesePitchSurface(raw){
      const normalized=String(raw??'').trim().toLowerCase();
      if(['grass','natural grass','natural turf'].includes(normalized))return '天然草地';
      if(['artificial','artificial turf','artificial grass','synthetic grass','synthetic turf'].includes(normalized))return '人工草地';
      if(['hybrid','hybrid grass','hybrid turf'].includes(normalized))return '混合草皮';
      return null;
    }
    function summarizeEnvironmentImpact(environment){
      const num=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))?Number(v):null;
      const temp=num(environment?.temperatureC),humidity=num(environment?.humidityPct);
      const rain=num(environment?.precipitationProbabilityPct),wind=num(environment?.windKmh);
      const surface=chinesePitchSurface(environment?.pitchSurface);
      const candidates=[];
      const add=(level,score,text)=>candidates.push({level,score,text});
      if(temp!==null&&humidity!==null&&temp>=32&&humidity>=80)add('高',100,'高温高湿，比赛后段体能影响值得关注');
      else if(temp!==null&&temp>=35)add('高',95,'高温明显，体能消耗可能显著增加');
      if(wind!==null&&wind>=35)add('高',92,'风力较强，传球、传中与高空球稳定性可能受明显影响');
      if(temp!==null&&humidity!==null&&temp>=30&&humidity>=70)add('中',76,'高温高湿，体能消耗可能增加');
      else if(temp!==null&&temp>=30)add('中',72,'气温偏高，体能消耗可能增加');
      if(wind!==null&&wind>=20)add('中',70,'风力偏强，长传与高空球稳定性需留意');
      if(rain!==null&&rain>=65)add('中',66,'降雨概率较高，场地与技术动作稳定性需留意');
      if(surface==='人工草地')add('中',62,'人工草，球速与反弹节奏可能不同');
      if(!candidates.length)return {level:'低',text:'比赛条件正常'};
      candidates.sort((a,b)=>b.score-a.score);
      return {level:candidates[0].level,text:candidates[0].text};
    }
    function renderHeroWeather(environment){
      const hero=$('detailCard')?.querySelector('.report-hero');
      const anchor=hero?.querySelector('.report-weather-anchor');
      if(!hero||!anchor)return;
      anchor.replaceChildren();
      hero.querySelector('.report-venue-line')?.remove();
      hero.querySelector('.report-env-impact-line')?.remove();
      // Missing cache entries must be visible as missing, not silently erase this section.
      const hasVenue=typeof environment?.venueName==='string'&&environment.venueName.trim().length>1;
      const num=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))?Number(v):null;
      const temp=num(environment?.temperatureC),humidity=num(environment?.humidityPct);
      const rain=num(environment?.precipitationProbabilityPct),wind=num(environment?.windKmh);
      if(temp!==null||humidity!==null){
        const pill=el('div','report-weather-pill');
        pill.append(el('small','','开球时段预报'));
        pill.append(el('strong','',[temp!==null?temp.toFixed(1)+'°C':null,humidity!==null?'湿度 '+humidity.toFixed(0)+'%':null].filter(Boolean).join(' · ')));
        const secondary=[rain!==null?'降雨 '+rain.toFixed(0)+'%':null,wind!==null?'风 '+wind.toFixed(1)+'km/h':null].filter(Boolean);
        if(secondary.length)pill.append(el('small','',secondary.join(' · ')));
        anchor.append(pill);
      }else{
        const pill=el('div','report-weather-pill report-weather-pending');
        pill.append(el('small','','开球时段天气'),el('strong','','暂无已核验预报'));
        anchor.append(pill);
      }
      if(!hasVenue){hero.append(el('div','report-venue-line','球场 · 暂无已核验资料'));return;}
      const surface=chinesePitchSurface(environment.pitchSurface);
      const displayed=localizedVenueName(environment.venueName);
      const venue=el('div','report-venue-line','球场 · '+displayed);
      if(surface)venue.append(el('span','report-surface-badge',' · '+surface));
      if(environment.venueCity)venue.append(el('span','',' · '+String(environment.venueCity)));
      venue.title='球场原名：'+String(environment.venueName)+'。'+(environment.venueRecoveredAfterKickoff?'球场资料在赛后核验；没有可核验的赛前天气。':'球场及草皮来自已核验的场地资料；若有天气数值，来源为 Open-Meteo 赛前预报。');
      hero.append(venue);
      const impact=summarizeEnvironmentImpact(environment);
      const impactLine=el('div','report-env-impact-line');
      impactLine.append(el('b','','环境影响：'+impact.level),document.createTextNode(' · '+impact.text));
      impactLine.title='根据已核验的天气与草地条件生成的辅助提示，不单独代表胜负或进球数。';
      hero.append(impactLine);
    }

    // Uses the already validated day-list snapshot. No new API call on detail open.
    function renderAttackDefensePanel(row){
      const kickoff=Date.parse(String(row.kickoff||'')),snapshot=row.teamFormH2h;
      if(snapshot?.verified!==true||!Number.isFinite(kickoff)||
        !Number.isFinite(Date.parse(String(snapshot.capturedAt||'')))||
        Date.parse(String(snapshot.capturedAt))>=kickoff)return null;
      const summarize=form=>{
        if(!Array.isArray(form?.matches))return null;
        const games=form.matches.filter(g=>{
          const at=Date.parse(String(g?.kickoffAt||''));
          return Number.isFinite(at)&&at<kickoff&&
            Number.isInteger(g.goalsFor)&&g.goalsFor>=0&&
            Number.isInteger(g.goalsAgainst)&&g.goalsAgainst>=0;
        }).slice(0,6);
        if(games.length<2)return null;
        const n=games.length;
        return {n,for:games.reduce((a,g)=>a+g.goalsFor,0)/n,
          against:games.reduce((a,g)=>a+g.goalsAgainst,0)/n,
          clean:games.filter(g=>g.goalsAgainst===0).length};
      };
      const entries=[[row.home,summarize(snapshot.home)],[row.away,summarize(snapshot.away)]];
      if(!entries.some(x=>x[1]))return null;
      const panel=reportSection('近期攻防对比');
      panel.classList.add('report-attack');
      const grid=el('div','report-attack-grid');
      for(const [name,stats] of entries){
        const card=el('div','report-attack-team');
        card.append(el('strong','',String(name)),el('small','',stats?'赛前最近'+stats.n+'场':'赛前样本不足'));
        const add=(label,value)=>{const line=el('div','report-attack-row');line.append(el('span','',label),el('b','',value));card.append(line)};
        add('场均进球',stats?stats.for.toFixed(1):'—');
        add('场均失球',stats?stats.against.toFixed(1):'—');
        add('零封场次',stats?stats.clean+'/'+stats.n:'—');
        grid.append(card);
      }
      panel.append(grid,el('p','report-sub','仅统计本场开球前已核验的历史90分钟比分；不同球队可用场次可能不同。射门、射正缺少本场可比的完整赛前样本，暂不填造。'));
      return panel;
    }
    // The authenticated market history endpoint is called only after an explicit tap.
    const oddsTrendCache=new Map();
    function renderOddsTrendChart(holder,trend){
      holder.replaceChildren();
      const points=Array.isArray(trend?.points)?trend.points.filter(p=>
        Number.isFinite(Date.parse(String(p.at||'')))&&
        ['home','draw','away'].every(k=>Number.isFinite(Number(p[k]))&&Number(p[k])>1&&Number(p[k])<=100)): [];
      if(points.length<2){
        holder.append(el('p','report-sub','本场已核验的赔率时间点不足，暂时无法绘制走势图。'));
        return;
      }
      const wrap=el('div','report-trend-chart'),legend=el('div','report-trend-key');
      const series=[['home','主胜','#bd3038'],['draw','平局','#b88a28'],['away','客胜','#257eac']];
      for(const [key,label,color] of series){
        const node=el('span',''),dot=el('i','');
        dot.style.backgroundColor=color;node.append(dot,document.createTextNode(label));legend.append(node);
      }
      wrap.append(legend);
      const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
      svg.setAttribute('viewBox','0 0 320 134');
      svg.setAttribute('role','img');svg.setAttribute('aria-label','威廉希尔已核验主胜、平局及客胜赔率变化趋势');
      const nums=points.flatMap(p=>series.map(([key])=>Number(p[key])));
      const low=Math.min(...nums),high=Math.max(...nums),padding=Math.max(.05,(high-low)*.09);
      const bottom=low-padding,top=high+padding, x=i=>27+i*280/(points.length-1);
      const y=n=>111-(n-bottom)*89/(top-bottom);
      const svgEl=(name,props)=>{
        const node=document.createElementNS('http://www.w3.org/2000/svg',name);
        for(const [k,v] of Object.entries(props))node.setAttribute(k,String(v));
        return node;
      };
      for(let i=0;i<3;i++){
        const yy=16+i*46;svg.append(svgEl('line',{x1:27,y1:yy,x2:309,y2:yy,stroke:'#e9e9e9','stroke-width':1}));
      }
      for(const [key,label,color] of series){
        const path=points.map((p,i)=>(i?'L':'M')+x(i).toFixed(1)+' '+y(Number(p[key])).toFixed(1)).join(' ');
        svg.append(svgEl('path',{d:path,fill:'none',stroke:color,'stroke-width':2,'stroke-linecap':'round','stroke-linejoin':'round'}));
        const end=points[points.length-1];svg.append(svgEl('circle',{cx:x(points.length-1),cy:y(Number(end[key])),r:2.4,fill:color}));
      }
      const label=(s,attrs)=>{const t=svgEl('text',attrs);t.textContent=s;svg.append(t)};
      label(points[0].phase==='初赔'?'初赔':'较早',{x:27,y:129,fill:'#888','font-size':9});
      label('最新赛前',{x:309,y:129,fill:'#888','text-anchor':'end','font-size':9});
      wrap.append(svg);
      const latest=points[points.length-1];
      wrap.append(el('p','report-sub','最后记录：'+
        '主胜 '+Number(latest.home).toFixed(2)+' · 平 '+Number(latest.draw).toFixed(2)+
        ' · 客胜 '+Number(latest.away).toFixed(2)+'（'+fmtStamp(latest.at)+'）'));
      wrap.append(el('p','report-sub','按采集先后等距抽样展示；横向间距不代表实际时长。赔率变化不等于赛果判断。'));
      holder.append(wrap);
    }
    function lazyOddsTrendPanel(context){
      const row=context?.row;
      if(!row)return null;
      const panel=reportSection('赔率与盘口变化');
      panel.append(el('p','report-sub','本场威廉希尔赔率走势。默认不请求历史数据，点击后才读取。'));
      const button=el('button','report-trend-toggle','展开赔率走势');
      button.type='button';
      const body=el('div','report-trend-body');body.hidden=true;
      panel.append(button,body);
      button.onclick=async()=>{
        if(!body.hidden){body.hidden=true;button.textContent='展开赔率走势';return}
        body.hidden=false;button.textContent='收起赔率走势';
        if(body.dataset.ready==='1')return;
        const key=String(row.date||state.selectedDate)+'|'+String(row.no).padStart(3,'0');
        const old=oddsTrendCache.get(key);
        if(old&&old.token===authSession?.access_token&&Date.now()-old.at<5*60*1000){
          renderOddsTrendChart(body,old.trend);body.dataset.ready='1';return;
        }
        body.replaceChildren(el('p','report-sub','正在按需读取本场已核验市场快照…'));
        button.disabled=true;
        try{
          const params=new URLSearchParams({view:'market-trend',date:String(row.date||state.selectedDate),no:String(row.no).padStart(3,'0')});
          const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),12000);let response;
          try{response=await authorizedApiFetch(customerApiUrl(params),{cache:'no-store',signal:ctrl.signal})}
          finally{clearTimeout(timer)}
          if(!response.ok)throw Error('HTTP '+response.status);
          const data=await response.json();
          if(!data.ok||!data.trend||data.trend.home!==row.home||data.trend.away!==row.away)throw Error('场次或数据未通过核验');
          if(state.selected!==row||!body.isConnected||!authSession?.access_token)return;
          oddsTrendCache.delete(key);oddsTrendCache.set(key,{token:authSession.access_token,at:Date.now(),trend:data.trend});
          while(oddsTrendCache.size>12)oddsTrendCache.delete(oddsTrendCache.keys().next().value);
          renderOddsTrendChart(body,data.trend);body.dataset.ready='1';
        }catch(error){
          if(state.selected===row&&body.isConnected)body.replaceChildren(el('p','report-sub','本场赔率走势暂不可用；不影响现有赛前分析及赔率展示。'));
        }finally{button.disabled=false}
      };
      return panel;
    }
    function appendProfessionalReport(slot,report,context){
      const stories=Array.isArray(report.intelligence?.articles)?report.intelligence.articles.filter(x=>{
        try{const u=new URL(String(x.url||''));return u.protocol==='https:'&&u.hostname==='sports.sina.com.cn'&&u.pathname.startsWith('/l/')}
        catch{return false}
      }):[];
      const market=report.market?.european??null,first=market?.initial,last=market?.current;
      updateDetailMarketStatus(context?.dataStatus,report);
      const meaningfulChange=first&&last?['home','draw','away'].some(k=>Number.isFinite(Number(first[k]))&&Number.isFinite(Number(last[k]))&&Number(first[k])>1&&Number(last[k])>1&&Math.abs(Number(first[k])-Number(last[k]))>=0.015):false;
      // Keep raw research riskAnalysis in its source record. Do not repeat
      // internal PASS/risk-gate jargon as an alarming customer-facing banner.
      if(stories.length||meaningfulChange){
        const intel=reportSection('赛前情报与市场变化');
        stories.forEach(item=>{
          const article=el('div','report-story'),title=el('a','report-story-link',String(item.title||'赛前报道').replace(/^\[小炮APP\]竞彩情报：/,'').replace(/澳客|新浪小炮|小炮APP|小炮/g,'媒体'));
          title.href=item.url;title.target='_blank';title.rel='noopener noreferrer';
          const verifiedNotes=(Array.isArray(item.sections)?item.sections:[]).filter(x=>typeof x==='string'&&x.length>10&&x.length<65&&!/^(主队|客队)(有利|不利)$/.test(x)&&!/伤停|缺阵|需核实/.test(x)).slice(0,2);
          article.classList.add('report-insight-line');
          article.append(title);
          for(const note of verifiedNotes)article.append(el('p','report-sub',note));
          article.append(el('small','','媒体赛前报道 · '+fmtStamp(item.publishedAt)+' · 媒体观点，点击标题查看原文'));intel.append(article);
        });
        if(meaningfulChange){
          const changed=el('div','report-story');
          changed.append(el('b','','赛前市场变化'));
          [['主胜','home'],['平局','draw'],['客胜','away']].forEach(([label,key])=>{
            const a=Number(first[key]),b=Number(last[key]);
            if(a>1&&b>1&&Math.abs(a-b)>=0.015)reportLine(changed,label,a.toFixed(2)+' → '+b.toFixed(2));
          });
          changed.append(el('p','report-sub','威廉希尔 · 赔率采集于 '+fmtStamp(last.capturedAt)+'；变化不等于赛果判断'));intel.append(changed);
        }
        slot.append(intel);
      }
      renderHeroWeather(report.environment??context?.fallbackEnvironment??null);
      const hasOdds=!!(last||first||(report.market?.asian??[]).some(x=>x.current||x.initial));
      const hasModelOddsProduct=context?.row?.predictionView!=='LATEST_PREMATCH_ONLY'&&Array.isArray(report.modelOddsIndex?.values)&&report.modelOddsIndex.values.length===3&&
        report.modelOddsIndex.values.every(v=>v!==null&&v!==undefined&&Number.isFinite(Number(v))&&Number(v)>=0);

      const elo=report.feature?.elo,ai=report.feature?.kickoffAi;
      const hasElo=!!(elo&&elo.home!==null&&elo.away!==null&&Number.isFinite(Number(elo.home))&&Number.isFinite(Number(elo.away)));
      const hasAi=!!(ai&&reportTriplet([ai.home,ai.draw,ai.away]));
      const hasDetail=hasOdds||hasModelOddsProduct||hasElo||hasAi;
      if(hasDetail){
        const detail=reportDisclosure('专业数据 · 赔率、走势与实力');
        if(hasOdds){
          const odds=reportSection('机构赔率与盘口');
          if(first&&[first.home,first.draw,first.away].every(v=>Number.isFinite(Number(v))&&Number(v)>1))
            reportOddsGrid(odds,'威廉希尔初赔',[first.home,first.draw,first.away]);
          if(last&&[last.home,last.draw,last.away].every(v=>Number.isFinite(Number(v))&&Number(v)>1)){
            reportOddsGrid(odds,'威廉希尔最新赛前欧赔',[last.home,last.draw,last.away]);
            reportLine(odds,'赔率采集时间',fmtStamp(last.capturedAt));
          }
          (report.market?.asian??[]).forEach(item=>{
            const quote=item.current??item.initial;
            if(!quote)return;
            const name=String(item.institution||'机构');
            const format=x=>{
              if(!x)return null;
              const value=x.lineText??x.line;
              const water=[];
              if(x.homeWater!==null&&x.homeWater!==undefined)water.push('主水'+x.homeWater);
              if(x.awayWater!==null&&x.awayWater!==undefined)water.push('客水'+x.awayWater);
              return [value===null||value===undefined?'盘口待核验':String(value),...water].join(' · ');
            };
            const initial=format(item.initial),current=format(item.current);
            if(initial)reportLine(odds,name+'初盘',initial);
            if(current)reportLine(odds,name+'赛前盘口',current);
          });
          detail.append(odds);
          if(first||last){
            const trend=lazyOddsTrendPanel(context);
            if(trend)detail.append(trend);
          }
        }
        if(hasModelOddsProduct){
          const k=reportSection('市场对照');
          const values=report.modelOddsIndex.values.map(Number);
          const names=['主胜','平局','客胜'],higher=values.map((v,i)=>v>1.00005?names[i]:null).filter(Boolean);
          const max=Math.max(...values),leaders=values.map((v,i)=>Math.abs(v-max)<0.00005?names[i]:null).filter(Boolean);
          const headline=values.every(v=>v<0.99995)
            ?'本场三方向均低于参考线：本项未发现高于基准的方向。'
            :higher.length
              ?'本场'+higher.join('、')+'高于参考线：仅表示这些方向的模型概率与赔率乘积较高。'
              :'本场各方向均未明显高于参考线：本项没有给出突出的方向。';
          const summary=el('p','report-sub',headline);
          summary.style.cssText='font-size:13px;line-height:1.6;color:#333;font-weight:650;margin:4px 0 9px';
          k.append(summary);
          k.append(el('p','report-sub',leaders.length===1?'当前市场对照中'+leaders[0]+'相对突出；该项仅作辅助参考，最终以胜平负概率、风险提示及赛前资料综合判断。':'当前市场对照未形成单一突出方向；请结合胜平负概率、风险提示及赛前资料查看。'));
          detail.append(k);
        }
        if(hasElo||hasAi){
          const independent=reportSection('球队实力与独立概率');
          if(hasElo){
            const homeElo=Number(elo.home),awayElo=Number(elo.away),eloGap=homeElo-awayElo;
            reportLine(independent,'Elo 历史实力评分','主队 '+homeElo.toFixed(1)+' 分 · 客队 '+awayElo.toFixed(1)+' 分');
            reportLine(independent,'双方评分差',Math.abs(eloGap).toFixed(1)+' 分（'+(eloGap>0?'主队较高':eloGap<0?'客队较高':'双方相同')+'）');
            independent.append(el('p','report-sub',eloGap>0?'本场历史实力评分：主队较高 '+Math.abs(eloGap).toFixed(1)+' 分。':eloGap<0?'本场历史实力评分：客队较高 '+Math.abs(eloGap).toFixed(1)+' 分。':'双方历史实力评分相同。'));
            const eloHelp=el('details','report-inline-help');
            eloHelp.append(el('summary','','Elo 分数怎么看？'),el('p','report-sub','在同一评分体系下，分数较高表示历史实力评价相对较高，分差越大表示评分差距越大。它不是本场胜率或比分预测，阵容、赛程等信息仍需单独核对。'+(elo.shadow?' 本项仍属于影子研究数据。':'')));
            independent.append(eloHelp);
          }
          if(hasAi)reportOddsGrid(independent,'Kickoff.ai 赛前概率',[ai.home,ai.draw,ai.away].map(v=>probability(v)));
          detail.append(independent);
        }
        (context?.advancedSlot||slot).append(detail);
      }
      // Keep noncritical completeness details in the opt-in provenance panel.
      if(context?.audit){
        const available=[];
        if(stories.length)available.push('媒体报道');
        if(hasOdds)available.push('机构赔率');
        if(hasElo||hasAi)available.push('独立模型');
        if(report.environment?.venueName)available.push('球场');
        if(report.environment?.historicalForecast)available.push('赛前天气');
        if(available.length)context.audit.append(el('p','report-sub','本场已匹配资料：'+available.join('、')+'。'));
        if(!hasOdds)context.audit.append(el('p','report-sub','本场尚无可展示的机构赔率与盘口核验记录。'));
        context.audit.append(el('p','report-sub','媒体信息属于原报道观点；不同信息源采集时间可能不同。'));
      }
    }
    const professionalReportCache=new Map();
    async function loadProfessionalDetail(row,slot,context){
      if(row?.vipRiskAccessRestricted===true&&!vipDeepAccess()){
        const lock=el('div','vip-inline-lock');
        lock.append(el('b','',row?.vipRiskLocked===true?'VIP风险信号已触发 🔒':'VIP深层分析 🔒'),
          el('span','',row?.vipRiskLocked===true?'William、亚盘升退、水位、资金与重要情报依据仅向尊贵月卡VIP开放。':'William、亚盘升退、水位、资金与重要情报仅向尊贵月卡VIP开放。'));
        slot.replaceChildren(lock);
        if(context?.advancedSlot)context.advancedSlot.replaceChildren();
        return;
      }
      const key=String(row.date||state.selectedDate)+'|'+String(row.no).padStart(3,'0');
      const cached=professionalReportCache.get(key);
      const useReport=report=>{
        if(state.selected!==row)return;
        slot.replaceChildren();
        appendProfessionalReport(slot,report,context);
      };
      if(cached&&cached.token===authSession?.access_token&&Date.now()-cached.at<4*60*1000){
        useReport(cached.report);return;
      }
      slot.replaceChildren(el('p','report-loading','正在读取本场赛前资料…'));
      try{
        const params=new URLSearchParams({view:'report',date:String(row.date||state.selectedDate),no:String(row.no).padStart(3,'0')});
        const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),12000);let response;
        try{response=await authorizedApiFetch(customerApiUrl(params),{cache:'no-store',signal:ctrl.signal})}
        finally{clearTimeout(timer)}
        if(!response.ok)throw Error('HTTP '+response.status);
        const data=await response.json();
        if(!data.ok||!data.report||data.report.home!==row.home||data.report.away!==row.away)throw Error('场次或来源不匹配');
        if(state.selected!==row||!authSession?.access_token)return;
        professionalReportCache.delete(key);
        professionalReportCache.set(key,{token:authSession.access_token,at:Date.now(),report:data.report});
        while(professionalReportCache.size>12)professionalReportCache.delete(professionalReportCache.keys().next().value);
        useReport(data.report);
      }catch(err){
        if(state.selected!==row)return;
        slot.replaceChildren(el('p','report-loading','扩展赛事资料暂时无法获取，已发布的赛前分析仍可查看。'));
        const odds=context?.dataStatus?.querySelector('.report-data-odds b');if(odds)odds.textContent='采集时间未确认';
        if(context?.audit)context.audit.append(el('p','report-sub','扩展资料暂时无法读取：'+safe(err?.message||err)));
      }
    }
    // Show only the warning tied to this match's verified pre-kickoff record.
    // Never infer a directional warning from the original Top1 or from final results.
    function detailUpsetWarningPanel(row){
      const panel=reportSection('风险观察 · 赛前数据迹象');panel.classList.add('vip-exclusive-card','vip-risk-exclusive');panel.querySelector('h2,h3')?.append(el('span','vip-exclusive-badge','VIP专享'));
      if(row?.vipRiskAccessRestricted===true&&!vipDeepAccess()){
        panel.classList.add('report-detail-upset-empty');
        panel.append(el('p','vip-inline-lock',row?.vipRiskLocked===true?'VIP风险信号已触发 🔒 · 风险类型与保护方向仅向尊贵月卡VIP开放。':'深层风险审计仅向尊贵月卡VIP开放。'));
        return panel;
      }
      panel.classList.add('report-detail-upset');
      const raw=row.upsetWarning??row.upset_warning;
      const eligible=raw&&typeof raw==='object'&&row.pregameVerified===true&&raw.publicationEligible!==false&&raw.publication_eligible!==false;
      const kickoff=Date.parse(String(row.kickoff??''));
      const freezeAt=eligible?(raw.prematchAt??raw.prematch_at??null):null;
      const freeze=Date.parse(String(freezeAt??''));
      const original=raw?.originalTop1??raw?.original_top1??null;
      const sameOriginal=original&&row.ftTop1&&normalizeResult(original)===normalizeResult(row.ftTop1);
      const timeValid=Number.isFinite(kickoff)&&Number.isFinite(freeze)&&freeze<kickoff;
      const sourceClean=raw?.resultFieldsUsed!==true&&raw?.result_fields_used!==true&&
        raw?.hurDirectionUsed!==true&&raw?.hur_direction_used!==true;
      if(!eligible||!timeValid||!sameOriginal||!sourceClean){
        panel.classList.add('report-detail-upset-empty');
        panel.append(el('p','report-sub','本场暂无可核验的赛前风险记录；不代表比赛没有风险。'));
        return panel;
      }
      const level=String(raw.riskLevel??raw.risk_level??'未确认');
      const detailOnly=raw.detailOnly===true||raw.detail_only===true;
      const published=raw.publish===true;
      if(!published&&!detailOnly){
        panel.classList.add('report-detail-upset-empty');
        const note=level==='低'?'本场未达到重点风险门槛；不代表没有风险。':'本场暂无已核验的重点风险记录。';
        panel.append(el('p','report-sub',note));
        return panel;
      }
      const tier=published?String(raw.displayTier??raw.display_tier??(level==='高'?'强风险信号':'重点风险')):'一般风险';
      const score=raw.riskScore??raw.risk_score;
      const numericScore=score!==null&&score!==undefined&&score!==''&&Number.isFinite(Number(score))?Number(score):null;
      const risk=el('div','report-detail-upset-status');
      risk.append(el('b','',tier));
      if(numericScore!==null)risk.append(el('span','','数据分值 '+numericScore.toFixed(1)));
      risk.append(metricHelp('风险数据分值','分值用于归纳赛前已核验的风险迹象；分值越高表示触发的风险信号越明显。它不是胜率或准确率，也不保证实际赛果。'));
      panel.append(risk);
      reportLine(panel,'赛前原始首选',String(original));
      const gate=(raw.focusGate&&typeof raw.focusGate==='object')?raw.focusGate:
        (raw.focus_gate&&typeof raw.focus_gate==='object'?raw.focus_gate:null);
      const gateReasons=[];
      if(gate?.opposite_second===true)gateReasons.push('首选与次选形成主/客胜方向分歧');
      if(gate?.qualified_draw===true){
        const p=Number(raw.independentDrawProbability??raw.independent_draw_probability);
        gateReasons.push(Number.isFinite(p)?'独立进球模型提示平局风险 '+(p*100).toFixed(1)+'%':'独立进球模型提示平局风险');
      }
      const marketSignals=Array.isArray(raw.marketSignals)?raw.marketSignals:
        (Array.isArray(raw.market_signals)?raw.market_signals:[]);
      if(gate?.market_anomaly===true){
        if(marketSignals.length)gateReasons.push(...marketSignals.map(x=>'市场变化：'+String(x)));
        else gateReasons.push('市场出现反向变化');
      }
      if(detailOnly)reportLine(panel,'当前层级','一般风险，仅保留详情分析，不在比赛卡片突出显示');
      else if(gateReasons.length)reportLine(panel,'重点依据',gateReasons.slice(0,3).join('；'));
      const rawDirection=String(raw.warningDirection??raw.warning_direction??'').trim();
      const actualDirection=({'主队不胜':'客队不败','客队不胜':'主队不败'}[rawDirection]??rawDirection);
      if(published&&['主队不败','客队不败'].includes(actualDirection))
        reportLine(panel,'风险方向',actualDirection);
      else if(published&&gate?.qualified_draw===true)
        reportLine(panel,'风险方向','平局风险');
      else if(published)
        reportLine(panel,'风险方向','首选失手风险，不强行反推具体赛果');
      const reasons=Array.isArray(raw.riskBasis)?raw.riskBasis:Array.isArray(raw.risk_basis)?raw.risk_basis:[];
      const verifiedReasons=reasons.filter(x=>typeof x==='string'&&x.trim()).slice(0,3);
      if(verifiedReasons.length){
        const details=el('details','report-detail-upset-evidence');
        details.append(el('summary','','查看赛前风险依据'));
        for(const reason of verifiedReasons)details.append(el('p','report-sub',String(reason)));
        panel.append(details);
      }else panel.append(el('p','report-sub','本场暂无可展示的详细风险依据。'));
      const warningAudit=el('details','report-inline-help');
      warningAudit.append(el('summary','','数据记录说明'),
        el('p','report-sub','风险记录于 '+fmtStamp(freezeAt)+'；仅使用赛前冻结资料，不根据赛果补写。'));
      panel.append(warningAudit);
      return panel;
    }
    function renderDetailDataStatus(row){
      const status=el('section','report-data-status');
      const head=el('div','report-data-status-heading');
      head.append(el('strong','','数据更新状态'),
        metricHelp('数据更新状态','预测冻结时间、机构赔率采集时间和赛果核验状态来自不同资料。后续赔率更新不等于模型预测已更新；无可靠时间戳时显示未确认。'));
      status.append(head);
      const list=el('div','report-data-status-items');
      const item=(name,value,cls='')=>{
        const line=el('div','report-data-status-item');
        line.append(el('span','',name),el('b',cls,value));list.append(line);
        return line;
      };
      const cutoff=Number.isFinite(Date.parse(String(row.kickoff??'')))?Date.parse(row.kickoff):null;
      const freeze=Number.isFinite(Date.parse(String(row.frozenAt??'')))?Date.parse(row.frozenAt):null;
      item('模型预测更新',freeze!==null&&cutoff!==null&&freeze<cutoff?fmtStamp(row.frozenAt):'时间未确认');
      const oddsLine=item('机构赔率采集','读取中','report-data-odds');
      oddsLine.querySelector('b').textContent='查看本场资料';
      item('赛果核验',verified(row)?'已核验':postponedMatch(row)?'赛事延期':'待核验',verified(row)?'report-data-verified':'');
      status.dataset.detailStatus='1';
      return status;
    }
    function updateDetailMarketStatus(status,report){
      if(!status)return;
      const odds=status.querySelector('.report-data-odds b');
      if(!odds)return;
      const quotes=[report?.market?.european?.current?.capturedAt,
        ...(Array.isArray(report?.market?.asian)?report.market.asian.flatMap(x=>[x?.current?.capturedAt,x?.initial?.capturedAt]):[])];
      const valid=quotes.filter(t=>t&&Number.isFinite(Date.parse(String(t)))).map(t=>new Date(t).getTime());
      // Display the verified European quote's timestamp; never confuse an API response time
      // or an unrelated source's newer fetch with the frozen model's update time.
      const euro=report?.market?.european?.current?.capturedAt;
      odds.textContent=euro&&Number.isFinite(Date.parse(String(euro)))?fmtStamp(euro):'采集时间未确认';
    }
    const okoooShadowCache=new Map();
    function shadowSourceLink(url){
      try{
        const parsed=new URL(String(url||''));
        if(parsed.protocol!=='https:'||!['www.okooo.com','m.okooo.com'].includes(parsed.hostname))return null;
        const link=el('a','','查看澳客原页');link.href=parsed.href;link.target='_blank';link.rel='noopener noreferrer';return link;
      }catch{return null}
    }
    function renderDeepMarketAnalysis(holder,data){
      if(state.selected===null||!holder.isConnected)return;
      holder.replaceChildren();
      const panel=reportSection('九十刻度 · 深度市场分析');panel.classList.add('shadow-admin-preview','vip-exclusive-card');panel.querySelector('h2,h3')?.append(el('span','vip-exclusive-badge','VIP专享'));
      const match=data?.match||{},market=data?.market;
      const rawAnalysis=data?.analysis||data?.proof||data?.marketAnalysis||data?.intelligence?.analysis||data||null;
      const analysis=rawAnalysis&&typeof rawAnalysis==='object'?rawAnalysis:null;
      const brandSafe=v=>String(v||'')
        .replace(/澳客/g,'市场数据')
        .replace(/\\+["']?\s*\/>/g,'')
        .replace(/<[^>]*>/g,'').trim();
      panel.append(el('p','report-sub',[match.no,match.home,match.away].filter(Boolean).join(' · ')+'。市场与情报数据按采集窗口自动更新，仅作为赛前概率分析依据。'));
      if(analysis){
        const normalized=normalizeShadowAnalysis(analysis);
        const explicitLevel=analysis.level||analysis.riskLevel||analysis.risk_level||analysis.conclusionLevel||analysis.conclusion_level;
        const explicitSummary=analysis.summary||analysis.conclusion||analysis.verdict||analysis.analysisSummary||analysis.analysis_summary;
        const derivedSummary=(()=>{
          if(!normalized.available)return null;
          const dirs=[normalized.market99.top,normalized.betfair.top].filter(Boolean);
          const kelly=normalized.kelly.lowestDirection;
          const same=dirs.length>=2&&dirs.every(x=>x===dirs[0]);
          const fundMax=Math.max(...Object.values(normalized.betfair.share).filter(v=>v!==null));
          if(same&&kelly&&kelly===dirs[0])return '多项市场指标同向，资金与凯利方向形成一致支持';
          if(same&&Number.isFinite(fundMax)&&fundMax>=60)return '机构方向与必发资金同向，市场支持较集中';
          if(dirs.length>=2&&new Set(dirs).size>1)return '机构概率与必发资金方向存在分歧，需重点关注市场背离';
          if(normalized.flags.length)return normalized.flags.slice(0,2).join('；');
          return '市场与情报证据已采集，当前以分项指标为主要参考';
        })();
        const level=explicitLevel?brandSafe(explicitLevel):(normalized.available?'证据已采集':'数据不足');
        const summary=explicitSummary?brandSafe(explicitSummary):brandSafe(derivedSummary||'暂无综合结论');
        const status=el('div','shadow-admin-status');
        status.append(el('b','',level),document.createTextNode(' · '+summary));
        panel.append(status);
        const fields=el('section','member-zone-proof-section');
        renderShadowAnalysisFields(fields,analysis);
        fields.querySelectorAll('li,b,span').forEach(node=>{if(node.childElementCount===0)node.textContent=brandSafe(node.textContent)});
        panel.append(fields);
      }else{
        panel.append(el('div','shadow-admin-status','本场深度市场分析暂无可展示数据。'));
        if(market){
          const marketText=market.status==='ok'&&Number(market.bookmakerCount)>0
            ?'市场数据采集成功 · '+market.bookmakerCount+' 家机构'
            :market.status==='login_required'?'部分市场数据暂受来源访问限制'
            :'市场数据状态：'+String(market.status||'未确认');
          panel.append(el('div','shadow-admin-status',marketText));
        }
      }
      if(market?.average&&[market.average.home,market.average.draw,market.average.away].every(v=>v!==null&&v!==undefined&&Number.isFinite(Number(v)))){
        reportLine(panel,'机构平均欧赔 主 / 平 / 客',[market.average.home,market.average.draw,market.average.away].map(v=>Number(v).toFixed(3)).join(' / '));
      }
      holder.append(panel);
    }
    async function loadDeepMarketAnalysis(row,holder){
      if(memberInfo?.vipActive!==true||!authSession?.access_token)return;
      const key=String(row.date||state.selectedDate)+'|'+String(row.no).padStart(3,'0');
      const cached=okoooShadowCache.get(key);
      if(cached&&cached.token===authSession.access_token&&Date.now()-cached.at<2*60*1000){renderDeepMarketAnalysis(holder,cached.data);return}
      holder.replaceChildren(el('p','report-loading','正在读取深度市场分析…'));
      try{
        const params=new URLSearchParams({view:'member-intel',date:String(row.date||state.selectedDate),no:String(row.no).padStart(3,'0')});
        const response=await authorizedApiFetch(OKOOO_SHADOW_API+'?'+params.toString(),{cache:'no-store',signal:timeoutSignal(12000)});
        const data=await response.json().catch(()=>null);
        if(!response.ok||data?.ok!==true)throw Error(String(data?.error||'HTTP '+response.status));
        if(state.selected!==row||memberInfo?.vipActive!==true)return;
        okoooShadowCache.set(key,{token:authSession.access_token,at:Date.now(),data});
        while(okoooShadowCache.size>20)okoooShadowCache.delete(okoooShadowCache.keys().next().value);
        renderDeepMarketAnalysis(holder,data);
      }catch(error){
        if(state.selected===row&&holder.isConnected)holder.replaceChildren(el('p','report-loading','深度市场分析暂不可用，请稍后重试'));
      }
    }
    function openDetail(row,history){
      state.selected=row;$('main').classList.add('hide');$('detail').classList.add('show');
      const c=$('detailCard');c.replaceChildren();
      const hero=el('header','report-hero');
      const heroTop=el('div','report-hero-top');
      heroTop.append(el('div','report-meta report-meta-left',[safe(row.league),safe(row.no),fmtTime(row.kickoff),'北京时间'].join(' · ')),el('div','report-weather-anchor'));
      hero.append(heroTop);
      const fixture=el('div','report-fixture'),home=el('div','report-team'),away=el('div','report-team');
      home.append(teamNode(row.home,row.homeLogo));away.append(teamNode(row.away,row.awayLogo));
      const center=el('div','');
      center.append(el('div','report-score',hasScore(row)?scoreline(row):'VS'),el('div','report-status',statusText(row,history)));
      fixture.append(home,center,away);hero.append(fixture,el('div','report-meta','九十刻度'));c.append(hero);
      const dataStatus=renderDetailDataStatus(row);
      c.append(dataStatus);
      const summary=reportSection('赛前核心数据');
      summary.classList.add('report-core-summary');
      const choices=el('div','report-key-picks');
      const first=el('div','report-main-pick');
      first.append(el('small','','胜平负首选'),el('strong','',reportHas(row.ftTop1)?String(row.ftTop1):'赛前分析更新中'));
      choices.append(first);
      if(reportHas(row.second)){const second=el('div','report-alt-pick');second.append(el('small','','胜平负次选'),el('strong','',String(row.second)));choices.append(second)}
      summary.append(choices);
      if(state.model==='daily'){
        const supplement=isSupplement(row)&&!isFocus(row);
        const selection=el('div','daily-detail-selection '+(supplement?'supplement':'core'));
        selection.append(el('strong','',supplement?'精选补充':'核心优选'));
        if(supplement){
          const meta=row.dailySelectionMeta??row.daily_selection_meta??{};
          const odds=Number(meta.williamTop1Odds??meta.william_top1_odds);
          selection.append(el('span','',Number.isFinite(odds)?'高性价比筛选通过 · 风险过滤通过 · 参考赔率 '+odds.toFixed(2):'高性价比筛选通过 · 风险过滤通过'));
        }else selection.append(el('span','','通过核心筛选'));
        summary.append(selection);
      }
      const hasOfficial=row.officialHandicap!==null&&row.officialHandicap!==undefined&&row.officialHandicap!=='';
      const handicap=[reportHas(row.handicapTop1)?row.handicapTop1:reportHas(row.handicap)?row.handicap:null,reportHas(row.handicapSecond)?row.handicapSecond:null].filter(Boolean);
      const isTop5=String(row.handicapModelVersion??'').startsWith('HJ38-HHAD-TOP5-FT-MKT');
      const handicapMarketOnly=row.handicapQualityEligible===false&&!isTop5;
      if(hasOfficial||handicap.length)reportLine(summary,isTop5?'官方让球 / 综合双选':handicapMarketOnly?'官方让球 / 市场参考':'官方让球 / 让球方向',(hasOfficial?String(row.officialHandicap):'—')+' / '+(handicap.length?handicap.join('、'):'未发布'));
      if(isTop5&&handicap.length)summary.append(el('p','report-sub','让球双选为赛前综合分析结果；双选表示覆盖两个方向，不代表确定赛果。'));
      if(handicapMarketOnly&&handicap.length)summary.append(el('p','report-sub','让球方向来自市场概率排序，尚未通过模型让球数据质量审核，仅供统计参考。'));
      const prob=Number(row.homeProbability),draw=Number(row.drawProbability),awayProb=Number(row.awayProbability);
      if([row.homeProbability,row.drawProbability,row.awayProbability].every(v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v)))&&[prob,draw,awayProb].every(v=>v>=0&&v<=100))
        reportProbability(summary,'九十刻度赛前概率',['homeProbability','drawProbability','awayProbability'],row);
      if(reportHas(row.frozenAt))summary.append(el('p','report-sub',(row.predictionView==='LATEST_PREMATCH_ONLY'?'最新赛前预测更新于 ':'赛前预测记录于 ')+fmtStamp(row.frozenAt)));
      c.append(summary);
      let deepMarketSlot=null;
      if(memberInfo?.vipActive===true){deepMarketSlot=el('div','report-professional');c.append(deepMarketSlot);}
      else{
        const deepMarketLock=reportSection('九十刻度 · 深度市场分析');
        deepMarketLock.classList.add('vip-exclusive-card','vip-exclusive-locked');deepMarketLock.querySelector('h2,h3')?.append(el('span','vip-exclusive-badge','VIP专享'));
        deepMarketLock.append(el('div','member-preview-lock','尊贵月卡VIP专享 · 解锁99家机构概率、必发资金/冷热/盈亏、凯利风险与赛事情报'));
        c.append(deepMarketLock);
      }
      const teamOverview=teamOverviewPanel(row);
      const attackDefense=renderAttackDefensePanel(row);
      if(teamOverview&&attackDefense){teamOverview.append(attackDefense);c.append(teamOverview);}
      else {if(teamOverview)c.append(teamOverview);if(attackDefense)c.append(attackDefense);}
      if(state.model==='htft')c.append(htftVersionPanel(row));
      else if(state.model!=='score')c.append(htftTop4Panel(row));
      c.append(detailUpsetWarningPanel(row));
      if(state.model==='score'){
        c.append(scoreTop4Panel(row,scoreVersionInfo(row,'dynamic')??scoreVersionInfo(row,'original')??undefined));
        if(publishedGoalLambda(row)!==null){const goals=reportDisclosure('展开泊松总进球');goals.append(goalPredictionPanel(row));c.append(goals);}
      }else if(state.model==='goals'){
        const selected=goalVersionInfo(row,'dynamic')??goalVersionInfo(row,'original');
        if(selected)c.append(goalPredictionPanel(row,selected));
        else c.append(el('p','goals-note','本场赛前进球参数待确认'));
        if(scoreInfo(row)){const score=reportDisclosure('展开比分 · Top4');score.append(scoreTop4Panel(row));c.append(score);}
      }else if(scoreInfo(row)||publishedGoalLambda(row)!==null){
        const score=reportDisclosure('展开比分与进球 · Top4 / 总进球');
        if(scoreInfo(row))score.append(scoreTop4Panel(row));
        if(publishedGoalLambda(row)!==null)score.append(goalPredictionPanel(row));
        c.append(score);
      }
      if(scoreSimulationInfo(row)&&state.model!=='score'){
        const supplement=reportDisclosure('比分概率参考 · 补充分析');
        supplement.append(scoreTop4Panel(row));
        c.append(supplement);
      }
      const professionalSlot=el('div','report-professional');c.append(professionalSlot);
      const advancedSlot=el('div','report-professional');c.append(advancedSlot);
      if(verified(row)){
        const review=reportSection('赛后数据对照');
        reportLine(review,'90分钟赛果',resultName[row.result]||row.result);
        if(hasScore(row))reportLine(review,'比分',scoreline(row));
        if(state.model==='htft'){
          const original=htftVersionInfo(row,'original'),dynamic=htftVersionInfo(row,'dynamic');
          const verdict=info=>!info?'无有效赛前记录':info.settlementStatus==='SUCCESS'?'Top4 · 评测成功':info.settlementStatus==='FAILURE'?'Top4 · 评测失败':'等待半场赛果核验';
          reportLine(review,'原始赛前Top4',verdict(original));
          reportLine(review,'动态赛前Top4',verdict(dynamic));
          review.append(el('p','report-sub','两个版本按各自赛前留存的方向独立核验与统计；历史补算不计入赛前发布成绩。'));
        }else if(state.model==='score'){
          const info=scoreVersionInfo(row,'dynamic')??scoreVersionInfo(row,'original'),actual=scoreActual(row);
          const verdict=!info?'无有效赛前比分':actual===null?'赛果待核验':info.picks.some(p=>String(p.score)===actual)?'Top4 · 评测成功':'Top4 · 评测失败';
          reportLine(review,'赛前比分Top4',verdict);
        }else{
          reportLine(review,'模型方向与赛果',evaluationHit(row)?'评测成功':'评测失败');
          review.append(el('p','report-sub','评测仅在赛前预测落库、赛果核验后进行。'));
        }
        c.append(review);
      }
      const audit=reportDisclosure('预测来源与数据说明');
      
      if(reportHas(row.frozenAt))reportLine(audit,'模型版本时间',fmtStamp(row.frozenAt));
      if(reportHas(row.dq))reportLine(audit,'数据质量',row.dq);
      if(reportHas(row.handicapSourceLabel))reportLine(audit,'让球数据来源',row.handicapSourceLabel);
      if(reportHas(row.handicapFrozenAt))reportLine(audit,'让球冻结时间',fmtStamp(row.handicapFrozenAt));
      audit.append(el('p','report-sub','赛前预测、后续盘口和媒体消息采集时间可能不同；未确认数据不填造。'));
      c.append(audit);
      c.append(el('div','report-disclaimer','模型结果为概率分析，赛事结果具有不确定性；平台不提供收益承诺。'));
      renderHeroWeather(row.environment??null);
      loadProfessionalDetail(row,professionalSlot,{summary,audit,advancedSlot,row,dataStatus,fallbackEnvironment:row.environment??null});
      if(deepMarketSlot)loadDeepMarketAnalysis(row,deepMarketSlot);
      window.scrollTo({top:0,behavior:'instant'});
    }
    function closeDetail(){$('detail').classList.remove('show');$('main').classList.remove('hide');state.selected=null}
    function errorBox(e){const x=el('div','error');x.append(el('b','','数据暂时无法加载'),el('div','',safe(e?.message||e)+'。请稍后重试。'));return x}
    function htftSample(rows,kind){
      return rows.map(row=>({row,info:kind==='dynamic'?row.dynamicHTFT:row.htftTop4})).filter(({row,info})=>{
        if(!info||info.sourceKind!==(kind==='dynamic'?'MARKET_ANCHORED_POISSON_HTFT_SHADOW_V01':kind==='original'?'PUBLISHED_PREMATCH':'HISTORICAL_POSTMATCH_RECONSTRUCTION')||!Array.isArray(info.picks)||info.picks.length!==4)return false;
        if(kind==='replay')return true;
        const k=Date.parse(String(row.kickoff??'')),f=Date.parse(String(info.sourceFrozenAt??'')),p=Date.parse(String(info.publishedAt??''));
        return Number.isFinite(k)&&Number.isFinite(f)&&Number.isFinite(p)&&f<=p&&p<k;
      });
    }
    function htftSummary(items){
      const finished=items.filter(({info})=>['SUCCESS','FAILURE'].includes(info.settlementStatus)&&typeof info.actual==='string');
      return {total:items.length,n:finished.length,top1:finished.filter(({info})=>info.picks[0]?.direction===info.actual).length,top3:finished.filter(({info})=>info.picks.slice(0,3).some(p=>p?.direction===info.actual)).length};
    }
    function htftRate(h,n){return n?(100*h/n).toFixed(1)+'%':'—'}
    function updateMetrics(){
      document.getElementById('htftStatsBreakdown')?.remove();
      document.getElementById('goalStatsBreakdown')?.remove();
      document.getElementById('scoreStatsBreakdown')?.remove();
      if(hasNoEvents()&&!state.unopenedDate){
        const labels=document.querySelectorAll('.metric span');
        ['totalCount','pickCount','passCount'].forEach(id=>$(id).textContent='0');
        ['赛事总数','已核验赛事','待核验赛事'].forEach((label,i)=>{if(labels[i])labels[i].textContent=label});
        $('poolCount').textContent=state.selectedDate+' · 0场';return;
      }
      if(state.today?.analysisPending===true){
        const rows=state.today.rows||[],labels=document.querySelectorAll('.metric span');
        $('totalCount').textContent=String(rows.length);
        $('pickCount').textContent='0';
        $('passCount').textContent='0';
        if(labels[0])labels[0].textContent='赛事已入池';
        if(labels[1])labels[1].textContent='正式分析已发布';
        if(labels[2])labels[2].textContent='风险/结果待更新';
        $('poolCount').textContent=state.selectedDate+' · 已入池 '+rows.length+'场 · 赛前分析待发布';
        return;
      }
      if(state.model==='htft'){
        const rows=state.today?.rows||[],original=htftSample(rows,'original'),dynamic=htftSample(rows,'dynamic'),replay=htftSample(rows,'replay'),selected=dynamic.length?dynamic:original.length?original:replay;
        const stat=htftSummary(selected),labels=document.querySelectorAll('.metric span');
        $('totalCount').textContent=htftRate(stat.top3,stat.n);
        $('pickCount').textContent=stat.top3+'/'+stat.n;
        $('passCount').textContent=(stat.total-stat.n)+' / '+(rows.length-stat.total);
        labels[0].textContent=dynamic.length?'动态赛前Top3 · 评测成功率':original.length?'原始赛前Top3 · 评测成功率':replay.length?'历史复算Top3 · 评测成功率':'半全场Top3 · 评测成功率';
        labels[1].textContent='覆盖 / 已核验';labels[2].textContent='待核验 / 无Top3';
        $('poolCount').textContent=state.selectedDate+' · 全池 '+rows.length+'场 · 原始赛前 '+original.length+'场 · 动态赛前 '+dynamic.length+'场 · 历史复算 '+replay.length+'场';
        return;
      }
      if(state.model==='goals'){
        const rows=state.today?.rows||[];
        const selected=rows.map(row=>({row,g:goalVersionInfo(row,'dynamic')??goalVersionInfo(row,'original')})).filter(x=>x.g);
        const st=goalStatSummary(selected),labels=document.querySelectorAll('.metric span');
        $('totalCount').textContent=htftRate(st.top3,st.n);
        $('pickCount').textContent=st.top3+'/'+st.n;
        $('passCount').textContent=(st.total-st.n)+' / '+(rows.length-st.total);
        labels[0].textContent='总进球Top3覆盖率';labels[1].textContent='覆盖 / 已核验';labels[2].textContent='待核验 / 无预测';
        $('poolCount').textContent=state.selectedDate+' · 全池 '+rows.length+'场 · 赛前总进球 '+st.total+'场';
        return;
      }
      if(state.model==='score'){
        const rows=state.today?.rows||[];
        const chosen=rows.map(row=>({row,info:scoreVersionInfo(row,'dynamic')??scoreVersionInfo(row,'original')})).filter(x=>x.info);
        const replay=rows.map(row=>({row,info:scoreInfo({...row,dynamicScoreTop4:null})}))
          .filter(({row,info})=>!scoreVersionInfo(row,'original')&&!scoreVersionInfo(row,'dynamic')&&info?.sourceKind==='HISTORICAL_BLIND_REPLAY');
        const selected=chosen.length?chosen:replay,st=scoreVersionStat(selected),labels=document.querySelectorAll('.metric span');
        $('totalCount').textContent=htftRate(st.top4,st.n);
        $('pickCount').textContent=st.top4+'/'+st.n;
        $('passCount').textContent=(st.total-st.n)+' / '+(rows.length-st.total);
        labels[0].textContent=chosen.length?'比分Top4 · 评测成功率':replay.length?'历史回放Top4 · 评测成功率':'比分Top4 · 评测成功率';
        labels[1].textContent='覆盖 / 已核验';labels[2].textContent='待核验 / 无预测';
        $('poolCount').textContent=state.selectedDate+' · 全池 '+rows.length+'场 · 赛前比分 '+chosen.length+'场'+(!chosen.length&&replay.length?' · 历史回放 '+replay.length+'场':'');
        return;
      }
      if(state.model==='upset'){
        const rows=visibleRows(),settled=rows.filter(verified);
        const hits=settled.filter(row=>normalizeResult(upsetInfo(row)?.originalPick)!==normalizeResult(row.result)).length;
        $('totalCount').textContent=settled.length?(100*hits/settled.length).toFixed(1)+'%':'—';
        $('pickCount').textContent=hits+'/'+settled.length;
        $('passCount').textContent=rows.length-settled.length;
        const labels=document.querySelectorAll('.metric span');
        labels[0].textContent='风险预警有效率';labels[1].textContent='有效 / 已核验';labels[2].textContent='待核验';
        $('poolCount').textContent=state.selectedDate+' · 赛前风险记录 '+rows.length+'场';
        return;
      }
      const rows=state.model==='daily'?visibleRows():(state.today?.rows||[]);
      const settled=rows.filter(verified);
      // Poisson statistics include only settled matches with a valid frozen pre-kickoff goal prediction and verified score.
      // Formal goal predictions and the separately-labelled frozen-score Poisson references
      // have different provenance: show reference coverage when there is no formal sample,
      // without recategorizing a reference as an independently published goal prediction.
      const formalGoals=state.model==='goals'?settled.filter(row=>isFormalGoalPrediction(row)&&hasScore(row)):[];
      const referenceGoals=state.model==='goals'?settled.filter(row=>row.goalPrediction?.formalEligible===false&&publishedGoalLambda({...row,dynamicGoalPrediction:null})!==null&&hasScore(row)):[];
      const showGoalReference=state.model==='goals'&&formalGoals.length===0&&referenceGoals.length>0;
      const evaluable=state.model==='goals'?(showGoalReference?referenceGoals:formalGoals):state.model==='handicap'?settled.filter(handicapEvaluable):settled;
      const hits=state.model==='goals'?evaluable.filter(row=>{
        const lambda=publishedGoalLambda({...row,dynamicGoalPrediction:null}),actual=Number(row.resultHome)+Number(row.resultAway);
        let p=Math.exp(-lambda);const ranked=[];
        for(let k=0;k<=15;k++){if(k>0)p*=lambda/k;ranked.push({goals:k,p})}
        ranked.sort((a,b)=>b.p-a.p||a.goals-b.goals);
        return ranked.slice(0,3).some(item=>item.goals===actual);
      }).length:evaluable.filter(evaluationHit).length;
      const rate=evaluable.length?Number((100*hits/evaluable.length).toFixed(1))+'%':'—';
      $('totalCount').textContent=rate;
      $('pickCount').textContent=hits+'/'+evaluable.length;
      $('passCount').textContent=rows.length-settled.length;
      const labels=document.querySelectorAll('.metric span');
      labels[0].textContent=state.model==='goals'?(showGoalReference?'泊松Top3参考覆盖率':'进球Top3正式覆盖率'):({ft:'胜平负首选命中率',double:'双选覆盖率',handicap:'让球命中率',combined:'综合评测成功率',daily:'今日优选双向覆盖率'})[state.model]||'当日评测命中率';
      labels[1].textContent=showGoalReference?'参考命中 / 已核验':'命中 / 有效评测';
      labels[2].textContent='未核验赛果';
      const coverage=state.model==='goals'?' · 独立正式预测 '+rows.filter(isFormalGoalPrediction).length+'场 · 泊松参考 '+rows.filter(row=>row.goalPrediction?.formalEligible===false&&publishedGoalLambda({...row,dynamicGoalPrediction:null})!==null).length+'场 · 正式已评测 '+formalGoals.length+'场 · 参考已评测 '+referenceGoals.length+'场':state.model==='handicap'?' · 让球有效评测 '+evaluable.length+'/'+settled.length+'场 · 缺失 '+Math.max(0,rows.length-evaluable.length)+'场':'';
      $('poolCount').textContent=state.selectedDate+' · '+rows.length+'场'+coverage;
    }
    function render(){closeDetail();const coldView=state.tab==='home'&&state.model==='cold';const currentNonMember=memberInfo?.active===false&&state.tab!=='profile'&&(!state.selectedDate||state.selectedDate>=beijingToday());document.querySelector('.toolbar').hidden=state.tab==='profile'||state.tab==='memberzone'||coldView||currentNonMember;if(state.tab==='memberzone'){if(memberInfo?.vipActive!==true){renderPaidMemberRequired();return}renderMemberZone();return}if(currentNonMember){renderMemberRequired();return}if(state.tab!=='profile'&&!coldView)updateMetrics();if(state.tab==='home')renderHome();else if(state.tab==='history')renderHistory();else renderProfile()}
    async function load(view,date){const qs=new URLSearchParams({view,client:'1'});if(date)qs.set('date',date);qs.set('_',String(Date.now()));let r;for(let attempt=0;attempt<2;attempt++){const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),20000);try{r=await authorizedApiFetch(customerApiUrl(qs),{cache:'no-store',signal:ctrl.signal});break}catch(e){if(!(e?.name==='AbortError'||/aborted/i.test(String(e?.message||e)))||attempt===1)throw e}finally{clearTimeout(timer)}}try{if(r.status===403){const denied=await r.json();if(denied.error==='MEMBERSHIP_REQUIRED'){memberInfo=denied.membership||{active:false};state.today=null;state.history=null;dayCache.clear();professionalReportCache.clear();render();throw Error('MEMBERSHIP_REQUIRED')}throw Error('接口返回 HTTP 403')}if(!r.ok)throw Error('接口返回 HTTP '+r.status);const j=await r.json();if(!j.ok||!Array.isArray(j.rows))throw Error(j.error||'接口数据异常');if(j.rows.length>0&&j.analysisPending!==true&&!['3.2','3.3','3.6','3.8'].includes(j.modelVersion))throw Error('赛事数据暂未通过完整性检查');return j}finally{}}
    function isoDate(d){return d.toISOString().slice(0,10)}
    function addDays(iso,delta){const d=new Date(iso+'T12:00:00+08:00');d.setUTCDate(d.getUTCDate()+delta);return isoDate(d)}
    function beijingToday(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()).replace(/\//g,'-')}
    function displayLatestDate(){const today=beijingToday();return state.baseDate&&state.baseDate>today?state.baseDate:today}
    function hasUnsettledPool(d){return !!(d&&Array.isArray(d.rows)&&d.rows.length&&d.rows.some(r=>r.matchStatus!=='POSTPONED'&&!verified(r)))}
    async function resolveActivePool(){
      const today=beijingToday(),previous=addDays(today,-1);
      // A JCZQ sale day may run past Beijing midnight. Prefer the unfinished
      // previous pool, but never turn a transient current-day API failure into
      // a blank homepage when we already have a valid previous pool snapshot.
      // Start today's read at the same time so a settled previous day never adds
      // its full network latency in front of the current-day first paint.
      const currentTask=readDay(today,true).then(data=>({data,error:null}),error=>({data:null,error}));
      let prior=null;
      try{
        prior=await readDay(previous);
        if(hasUnsettledPool(prior))return prior;
      }catch(e){console.warn('上一竞彩池状态核验暂不可用',e)}
      const current=await currentTask;
      if(current.data)return current.data;
      {
        const e=current.error;
        const fallback=prior||cachedDay(previous,true);
        if(fallback&&Array.isArray(fallback.rows)&&fallback.rows.length){
          console.warn('今日竞彩池暂不可用，继续展示上一有效竞彩池',e);
          return fallback;
        }
        throw e;
      }
    }
    function showUnopened(date){
      state.selectedDate=date;state.unopenedDate=date;state.futureDate=null;state.today={date,count:0,rows:[],modelVersion:state.today?.modelVersion||'3.8'};state.history={rows:[],count:0};
      $('poolCount').textContent=date+' · 数据待更新';$('totalCount').textContent='0';$('pickCount').textContent='0';$('passCount').textContent='0';
      buildDates();render();
    }
    function buildDates(){
      const days=['日','一','二','三','四','五','六'],box=$('dates'),latest=displayLatestDate();box.replaceChildren();
      box.classList.toggle('htft-dates',state.model==='htft');
      const firstOffset=state.model==='htft'?Math.max(-14,Math.round((Date.parse('2026-09-19T00:00:00Z')-Date.parse(latest+'T00:00:00Z'))/86400000)):-14;
      for(let offset=firstOffset;offset<=0;offset++){const iso=addDays(latest,offset),d=new Date(iso+'T12:00:00+08:00'),isActive=iso===state.selectedDate,b=el('button','day'+(isActive?' active':''));
        b.append(el('b','','周'+days[d.getDay()]),el('span','',iso.slice(5)));b.onclick=()=>selectDate(iso);box.append(b)}
    }
    // Historical days that are already fully settled are immutable for customer display.
    // Keep settled snapshots across normal return visits for a week; active/unsettled days
    // retain their short TTLs so live prematch updates are never frozen by archive caching.
    const dayCache=new Map(),dayRequests=new Map(),dayContentVersions=new Map();let dateRequestId=0,historyPrefetchStarted=false;
    const ARCHIVE_SESSION_PREFIX='soren-archive-v4:';
    const SETTLED_CACHE_TTL=7*24*60*60*1000,ACTIVE_CACHE_TTL=30*1000,ACTIVE_BOOT_CACHE_TTL=15*60*1000;
    function dayCacheScope(){return [authSession?.user?.id||'',memberInfo?.active===true?'1':'0',memberInfo?.vipActive===true?'1':'0'].join('|')}
    function fullySettledDay(d){
      return !!(d&&d.date&&d.date<beijingToday()&&Array.isArray(d.rows)&&d.rows.length&&
        d.rows.every(r=>verified(r)||r.matchStatus==='POSTPONED'));
    }
    function rememberDay(d){
      if(!d||!d.date||!Array.isArray(d.rows))return;
      const settled=fullySettledDay(d),signature=JSON.stringify([d.rows,d.publicationStatus,d.analysisPending]),known=dayContentVersions.get(d.date);
      const version=known?.signature===signature?(known.version||1):(known?.version||0)+1;
      dayContentVersions.delete(d.date);dayContentVersions.set(d.date,{signature,version});
      while(dayContentVersions.size>20)dayContentVersions.delete(dayContentVersions.keys().next().value);
      const scope=dayCacheScope(),entry={data:d,at:Date.now(),settled,signature,version,scope};
      dayCache.delete(d.date);dayCache.set(d.date,entry);
      while(dayCache.size>7)dayCache.delete(dayCache.keys().next().value);
      // Persist both settled history and the latest active-day snapshot.
      // Active snapshots are only used for fast boot and are refreshed in the
      // background immediately, so they never replace authoritative live sync.
      const persist=()=>{try{sessionStorage.setItem(ARCHIVE_SESSION_PREFIX+d.date,JSON.stringify({data:d,at:entry.at,settled,scope}))}catch{}};
      if('requestIdleCallback' in window)window.requestIdleCallback(persist,{timeout:5000});
      else setTimeout(persist,1200);
    }
    function cachedDay(date,allowStaleActive=false){
      const entry=dayCache.get(date);
      if(entry){
        if(entry.scope!==dayCacheScope()){dayCache.delete(date);return null}
        const ttl=entry.settled?SETTLED_CACHE_TTL:(allowStaleActive?ACTIVE_BOOT_CACHE_TTL:ACTIVE_CACHE_TTL);
        if(Date.now()-entry.at<ttl)return entry.data;
        dayCache.delete(date);
      }
      try{
        const raw=sessionStorage.getItem(ARCHIVE_SESSION_PREFIX+date);
        if(!raw)return null;
        const stored=JSON.parse(raw),settled=fullySettledDay(stored?.data);
        if(stored?.scope!==dayCacheScope()){
          sessionStorage.removeItem(ARCHIVE_SESSION_PREFIX+date);return null;
        }
        const ttl=settled?SETTLED_CACHE_TTL:(allowStaleActive?ACTIVE_BOOT_CACHE_TTL:ACTIVE_CACHE_TTL);
        if(!stored?.data||!Number.isFinite(Number(stored.at))||Date.now()-Number(stored.at)>ttl){
          sessionStorage.removeItem(ARCHIVE_SESSION_PREFIX+date);return null;
        }
        const signature=JSON.stringify([stored.data.rows||[],stored.data.publicationStatus,stored.data.analysisPending]),known=dayContentVersions.get(date);
        const version=known?.signature===signature?(known.version||1):(known?.version||0)+1;
        dayContentVersions.delete(date);dayContentVersions.set(date,{signature,version});
        dayCache.set(date,{data:stored.data,at:Number(stored.at),settled,signature,version,scope:stored.scope});
        return stored.data;
      }catch{return null}
    }
    // Deduplicate both user clicks and background prefetches. Settled archive hits return instantly.
    function readDay(date,force=false){
      // Never let an undated "latest" request jump the homepage into a future pool.
      // Default navigation is always anchored to Beijing today; the API may only
      // fall back to an available pool on or before today.
      const target=date||beijingToday();
      const cached=force?null:cachedDay(target);
      if(cached)return Promise.resolve(cached);
      const key=target;
      if(dayRequests.has(key))return dayRequests.get(key);
      const request=load('archive',target).then(d=>{rememberDay(d);return d}).finally(()=>{if(dayRequests.get(key)===request)dayRequests.delete(key)});
      dayRequests.set(key,request);return request;
    }
    function scheduleHistoryPrefetch(){
      if(historyPrefetchStarted||!authSession?.access_token)return;
      if(window.matchMedia&&window.matchMedia('(pointer: coarse)').matches)return;
      historyPrefetchStarted=true;
      const latest=state.baseDate||beijingToday();
      // Mobile-first: prefetch only the two nearest archive days, serially and only
      // when the browser is idle. Never compete with active scrolling/date switching.
      const queue=[-1,-2].map(offset=>addDays(latest,offset));
      const worker=async()=>{
        while(queue.length){
          if(document.hidden||state.tab!=='home'||state.selectedDate!==state.baseDate)return;
          const date=queue.shift();
          if(!date||cachedDay(date))continue;
          try{await readDay(date)}catch(e){console.warn('历史日期预取暂不可用',date,e)}
          await new Promise(resolve=>setTimeout(resolve,900));
        }
      };
      const start=()=>worker();
      if('requestIdleCallback' in window)window.requestIdleCallback(start,{timeout:4500});
      else setTimeout(start,3200);
    }
    function applyDay(d){state.unopenedDate=null;state.today=d;state.selectedDate=d.date;const settled=d.rows.filter(r=>verified(r));state.history={...d,count:settled.length,rows:settled};setHeader(d);render()}
    function paintCachedActivePool(today){
      const previous=addDays(today,-1),prior=cachedDay(previous,true),current=cachedDay(today,true);
      const cached=hasUnsettledPool(prior)?prior:current;
      if(!cached||!Array.isArray(cached.rows))return false;
      state.baseDate=cached.date||today;applyDay(cached);return true;
    }
    async function selectDate(date){
      const earliest=state.model==='htft'?(addDays(displayLatestDate(),-14)>'2026-09-19'?addDays(displayLatestDate(),-14):'2026-09-19'):addDays(displayLatestDate(),-14);
      if(date<earliest||date>displayLatestDate()){alert(state.model==='htft'?'半全场仅展示近15天可核验记录。':'仅展示最近15天的记录。');return}
      // Date navigation is an entry into match history, even when an expired member starts on "我的".
      // Switch tabs before the same-date shortcut or cached-day path; never change membership/report access.
      const wasOutsideHome=state.tab!=='home';
      if(wasOutsideHome){
        state.tab='home';feedbackMode=null;
        document.querySelectorAll('.nav').forEach(n=>n.classList.toggle('active',n.dataset.tab==='home'));
      }
      if(date===state.selectedDate){if(wasOutsideHome)render();return}
      const requestId=++dateRequestId;
      const cached=cachedDay(date);
      if(cached){applyDay(cached);return}
      state.selectedDate=date;buildDates();
      // Historical daily coverage is public to expired members; today's paywall remains unchanged.
      document.querySelector('.toolbar').hidden=memberInfo?.active===false&&date>=beijingToday();
      $('content').replaceChildren(empty('正在读取 '+date,'核对当日正式版本与赛前冻结记录。'));
      try{
        const d=await readDay(date);
        if(requestId!==dateRequestId)return;
        if(state.baseDate&&date>state.baseDate&&(!d||d.date!==date||!Array.isArray(d.rows))){showUnopened(date);return}
        rememberDay(d);applyDay(d)
      }catch(e){if(requestId!==dateRequestId)return;$('content').replaceChildren(errorBox(e))}
    }
    function setHeader(d){const settled=d.rows.filter(r=>verified(r)).length;$('version').textContent='九十刻度';$('poolCount').textContent=safe(d.date)+' · '+d.count+' 场比赛';$('totalCount').textContent=d.count;$('pickCount').textContent=settled;$('passCount').textContent=Math.max(0,d.rows.filter(r=>r.matchStatus!=='POSTPONED'&&!verified(r)).length);buildDates(state.baseDate||d.date)}
    let moduleRenderFrame=0;
    function scheduleModuleRender(model){
      if(moduleRenderFrame)cancelAnimationFrame(moduleRenderFrame);
      moduleRenderFrame=requestAnimationFrame(()=>{
        moduleRenderFrame=0;
        if(state.model===model&&state.tab==='home')render();
      });
    }
    document.querySelectorAll('.model').forEach(b=>b.onclick=()=>{
      const next=b.dataset.model;
      if(state.model===next&&state.tab==='home')return;
      const previous=state.model;
      document.querySelectorAll('.model').forEach(x=>x.classList.remove('active'));b.classList.add('active');
      state.model=next;state.tab='home';if(state.model==='cold')state.memberZoneError=null;
      document.querySelectorAll('.nav').forEach(n=>n.classList.toggle('active',n.dataset.tab==='home'));
      [$('modelTitle').textContent,$('modelDesc').textContent]=modelCopy[state.model];
      if((previous==='htft')!==(next==='htft'))buildDates();
      scheduleModuleRender(next)
    });
    document.querySelectorAll('.filter').forEach(b=>b.onclick=()=>{document.querySelectorAll('.filter').forEach(x=>x.classList.remove('active'));b.classList.add('active');state.filter=b.dataset.filter;render()});
    document.querySelectorAll('.nav').forEach(b=>b.onclick=()=>{document.querySelectorAll('.nav').forEach(x=>x.classList.remove('active'));b.classList.add('active');state.tab=b.dataset.tab;if(state.tab==='profile')feedbackMode=null;if(state.tab==='home'){const target=state.baseDate||beijingToday();if(state.selectedDate!==target){selectDate(target);return}}if(state.tab==='memberzone'&&memberInfo?.vipActive===true&&!state.memberZoneLoading){const d=memberZoneDate();if(!state.memberZone||state.memberZone.date!==d){loadMemberZone();return}}render()});
    $('back').onclick=closeDetail;
    function showAuthRetry(message,working=false){
      document.querySelector('.app').style.display='none';document.querySelector('.bottom').style.display='none';
      const gate=document.getElementById('loginGate')||document.createElement('div');
      gate.id='loginGate';gate.className='account-panel auth-retry';
      gate.replaceChildren(el('h2','','九十刻度'),el('p','',message||'正在核验登录状态，请检查网络后重试'));
      if(!working){
        const retry=el('button','','重新连接');
        // Re-check the retained session in place; do not reload or discard member credentials.
        retry.onclick=()=>{retry.disabled=true;retry.textContent='正在重试…';beginAuthenticatedApp()};
        gate.append(retry);
      }
      if(!gate.isConnected)document.body.append(gate);
    }
    async function verifyAuthWithNetworkRetry(){
      for(let attempt=0;attempt<2;attempt++){
        try{return await verifiedAuthToken()}catch(error){
          if(!authSession?.access_token||error.message==='LOGIN_REQUIRED')throw error;
          const temporary=error instanceof TypeError||['AbortError','TimeoutError'].includes(error.name)||
            /network|fetch|timeout|temporarily|SESSION_REFRESH_RETRY|HTTP 5\d\d/i.test(String(error.message||''));
          if(!temporary||attempt===1)throw error;
          await new Promise(resolve=>setTimeout(resolve,600));
        }
      }
    }
    let authBootInFlight=false,authBootRetryCount=0;
    async function beginAuthenticatedApp(){
      if(authBootInFlight)return;
      authBootInFlight=true;
      let usedCachedMembership=false;
      try{
      if(!authSession?.access_token){showLoginGate();return}
      showAuthRetry('正在恢复登录状态…',true);
      // Fast boot on mobile: a recently verified membership snapshot may paint
      // the app immediately. The authoritative membership endpoint is refreshed
      // in the background right after the UI becomes usable.
      const bootCachedMembership=readMemberCache(30*60*1000);
      if(bootCachedMembership){
        memberInfo=bootCachedMembership;usedCachedMembership=true;authBootRetryCount=0;
      }else try{
        // Network handoffs on mobile Safari can briefly fail while the retained
        // auth session is still valid. Retry the membership check before showing
        // a blocking reconnect screen, so a single transient request cannot trap
        // an otherwise healthy logged-in user.
        await membershipFetchWithRetry(3);
        authBootRetryCount=0;
      }catch(error){
        if(!authSession?.access_token||error?.message==='LOGIN_REQUIRED'){showLoginGate('登录状态已过期，请重新登录');return}
        const cached=readMemberCache();
        if(cached){
          memberInfo=cached;usedCachedMembership=true;
        }else if(isTransientConnectionError(error)){
          authBootRetryCount++;
          showAuthRetry('网络连接有波动，请点击重新连接。');
          return;
        }else{
          showAuthRetry('会员状态暂不可核验；登录信息已保留，请稍后重试。');return;
        }
      }
      const gate=document.getElementById('loginGate');if(gate)gate.remove();
      if(usedCachedMembership){
        setTimeout(()=>membershipFetchWithRetry(2).then(()=>{
          authBootRetryCount=0;
          // If the authoritative membership state changed while the cached UI
          // was shown, rerender the current page without forcing a reload.
          if(state.tab==='profile'||state.tab==='memberzone'||(state.tab==='home'&&state.model==='cold'))render();
        }).catch(()=>{}),1200);
      }
      document.querySelector('.app').style.display='';document.querySelector('.bottom').style.display='';
      const today=beijingToday();
      if(memberInfo?.active!==true){state.tab='home';state.model='overview';state.today=null;state.history=null;state.selectedDate=today;state.baseDate=today;document.querySelectorAll('.nav').forEach(n=>n.classList.toggle('active',n.dataset.tab==='home'));document.querySelectorAll('.model').forEach(n=>n.classList.toggle('active',n.dataset.model==='overview'));$('version').textContent='九十刻度';$('poolCount').textContent='当日赛事分析 · 会员可见';$('totalCount').textContent='—';$('pickCount').textContent='—';$('passCount').textContent='—';buildDates();paintCachedActivePool(today);resolveActivePool().then(d=>{state.baseDate=d.date||today;rememberDay(d);applyDay(d)}).catch(e=>{$('content').replaceChildren(errorBox(e));buildDates()});return}
      // Resolve the active JCZQ pool, not the calendar date. After Beijing
      // midnight an unfinished previous sale day must stay selected.
      paintCachedActivePool(today);
      resolveActivePool().then(d=>{
        state.baseDate=d.date||today;rememberDay(d);
        applyDay(d);scheduleHistoryPrefetch()
      }).catch(e=>{$('version').textContent='数据未确认';$('poolCount').textContent='接口异常';const box=errorBox(e),retry=el('button','secondary','重新加载比赛');retry.onclick=()=>{box.replaceWith(empty('正在重新读取比赛','正在加载赛事数据…'));beginAuthenticatedApp()};box.append(retry);$('content').replaceChildren(box);buildDates()});
      }finally{authBootInFlight=false}
    }
    (async()=>{
      try{
        const issue=await recoverEmailConfirmationRedirect();
        if(issue){showLoginGate(issue);return}
      }catch(error){
        console.error('EMAIL_CALLBACK_UNAVAILABLE',String(error?.message||error));
        showLoginGate('邮箱验证回跳未完成，请返回登录页使用邮箱密码登录，或联系管理员。');
        return;
      }
      await beginAuthenticatedApp();
    })();
    // Keep following the newest published match day without disrupting manual history browsing.
    // One scheduler owns foreground data sync. Session refresh remains demand-driven inside
    // authorizedApiFetch/refreshAuthSession, so a separate five-minute refresh loop is unnecessary.
    let syncInFlight=false,smartRefreshInFlight=null,smartRefreshTimer=null,lastPublishedSyncAt=0;
    const PUBLISHED_SYNC_MS=120000;
    async function smartPublishedRefresh(force=false){
      if(!authSession?.access_token||document.hidden)return;
      if(!force&&lastPublishedSyncAt&&Date.now()-lastPublishedSyncAt<PUBLISHED_SYNC_MS)return;
      if(smartRefreshInFlight)return smartRefreshInFlight;
      smartRefreshInFlight=(async()=>{
        try{
          // refreshAuthSession is internally deduplicated and only rotates the token near expiry.
          await refreshAuthSession();
          await refreshPublishedData();
          lastPublishedSyncAt=Date.now();
        }catch(e){console.warn('赛前数据同步暂不可用',e)}
        finally{smartRefreshInFlight=null}
      })();
      return smartRefreshInFlight;
    }
    function schedulePublishedRefresh(){
      if(smartRefreshTimer)clearTimeout(smartRefreshTimer);
      smartRefreshTimer=setTimeout(async()=>{
        try{await smartPublishedRefresh()}finally{schedulePublishedRefresh()}
      },PUBLISHED_SYNC_MS);
    }
    document.addEventListener('visibilitychange',()=>{
      if(!document.hidden&&authSession?.access_token&&(!lastPublishedSyncAt||Date.now()-lastPublishedSyncAt>=PUBLISHED_SYNC_MS)){
        smartPublishedRefresh().catch(e=>console.warn('前台恢复同步暂不可用',e));
      }
    });
    window.addEventListener('online',()=>{if(document.getElementById('loginGate')&&authSession?.access_token)beginAuthenticatedApp()});
    schedulePublishedRefresh();
    async function refreshPublishedData(){
      if((state.tab==='memberzone'||(state.tab==='home'&&state.model==='cold'))&&memberInfo?.vipActive===true){
        if(!state.memberZoneLoading)await loadMemberZone(true);
        return;
      }
      if(syncInFlight||!state.selectedDate||state.selectedDate===state.futureDate)return;
      // Never poll a fully settled historical day. Results and prematch content are immutable,
      // and re-fetching them was the main cause of lag while browsing 21–25.
      if(fullySettledDay(state.today)&&state.selectedDate===state.today?.date)return;
      syncInFlight=true;
      try{
        const previousDate=state.selectedDate;
        const previousVersion=dayContentVersions.get(previousDate)?.version||0;
        const followingLatest=previousDate===state.baseDate&&previousDate!==beijingToday();
        // Foreground/interval refreshes always bypass the short active-day cache.
        // The request itself is already de-duplicated, and cache:no-store plus the
        // timestamp query ensures the newest lawful prematch version is displayed.
        const d=await readDay(followingLatest?undefined:previousDate,true);
        // A manual date change while refreshing must win over an older response.
        if(state.selectedDate!==previousDate)return;
        if(followingLatest){state.baseDate=d.date;if(state.unopenedDate&&state.unopenedDate>d.date){buildDates();return}state.selectedDate=d.date;state.unopenedDate=null}else if(d.date!==previousDate)return;
        const refreshedVersion=dayContentVersions.get(d.date)?.version||0;
        // readDay already remembered the payload. If its content generation did
        // not change, do not serialize the full row tree or rebuild any DOM.
        if(state.today?.date===d.date&&d.date===previousDate&&refreshedVersion===previousVersion)return;
        const previousSelected=state.selected;
        const updatedDetail=previousSelected&&$('detail').classList.contains('show')?
          d.rows.find(r=>String(r.no).padStart(3,'0')===String(previousSelected.no).padStart(3,'0')
            &&r.home===previousSelected.home&&r.away===previousSelected.away):null;
        state.today=d;const settled=d.rows.filter(verified);state.history={...d,count:settled.length,rows:settled};setHeader(d);
        if(updatedDetail&&JSON.stringify(updatedDetail)!==JSON.stringify(previousSelected)){
          const scrollY=window.scrollY;
          openDetail(updatedDetail,false);
          window.scrollTo({top:scrollY,behavior:'instant'});
        }else if(!state.selected)render();
      }catch(e){console.warn('正式数据刷新失败',e)}finally{syncInFlight=false}
    }
