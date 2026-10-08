/* Admin-only statistics subpanel: loaded on demand, never from the customer homepage. */
(function(){
  "use strict";
  if(window.haoAdminFinalRender)return;
  const api="https://ttydbcejxqxdkcfoizkj.supabase.co/functions/v1/soren-admin-final-identification-v1";
  const publicKey="sb_publishable_n5thZ1g6h93ronyzPfqhsg_N_lFaoSa";
  const node=(tag,cls,txt)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(txt!==undefined)n.textContent=String(txt);return n};
  const fmt=v=>{const n=Date.parse(String(v||""));return Number.isFinite(n)?new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}).format(n):"待确认"};
  const opposite=x=>x==="主胜"?"客队":x==="客胜"?"主队":null;
  function decide(row){
    // Shadow single-choice display. Never infer handicap confidence from FT confidence.
    // Handicap alternatives need separate true handicap calibration, otherwise PASS.
    const conf=Number(row.confidence);
    const eligible=["主胜","客胜","平"].includes(row.top1)&&row.action==="SINGLE"
      &&Number.isFinite(conf)&&conf>=.60
      &&!["重点复核","情报与机构分歧","情报风险提示","双方因素交错"].includes(row.status)
      &&row.market?.direction!==opposite(row.top1)
      &&!["高","强","红"].includes(String(row.warnings?.riskLevel||""));
    return eligible?{label:"胜平负 · "+row.top1,reason:"仅引用原正式单选并进行基础风险校验；并非已验证的六方向联合最优。"}
      :{label:"PASS",reason:"现阶段未发现证据充分、经过六方向校准的唯一选择；不强行改选让球。"};
  }
  let requestId=0;
  window.haoAdminFinalRender=async function({holder,token,date,isAuthorized}){
    const own=++requestId;
    if(!holder||!token||!/^\d{4}-\d{2}-\d{2}$/.test(String(date)))return;
    holder.replaceChildren(node("p","muted","正在读取管理员联合识别数据…"));
    try{
      const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),12000);
      let response;
      try{response=await fetch(api+"?date="+encodeURIComponent(date),{
        method:"GET",headers:{Authorization:"Bearer "+token,apikey:publicKey},
        cache:"no-store",signal:controller.signal
      })}finally{clearTimeout(timeout)}
      const json=await response.json().catch(()=>null);
      if(!response.ok||json?.ok!==true)throw Error(response.status===403?"当前账号没有管理员权限":json?.error||"HTTP "+response.status);
      if(requestId!==own||!isAuthorized())return;
      holder.replaceChildren();
      const info=node("p","muted","管理员影子研究 · "+date+" · 共"+(json.rows||[]).length+"场 · 更新时间 "+fmt(json.generatedAt));
      holder.append(info);
      const note=node("p","muted","当前阶段是保守的单结果筛选：符合条件才显示胜平负单选，否则PASS。让球与胜平负的独立横向校准、澳客跨库完整同步仍在测试中；绝不把未核验结果冒充正式推荐。");
      holder.append(note);
      for(const row of json.rows||[]){
        const box=node("article","final-intel-row");
        const d=decide(row);
        box.append(node("h4","",String(row.no||"")+" "+String(row.home||"")+" VS "+String(row.away||"")));
        const picked=node("div","final-intel-pick "+(d.label==="PASS"?"pass":"single"),d.label);
        box.append(picked);
        box.append(node("p","muted",String(row.description||"待确认")));
        box.append(node("p","muted",d.reason));
        const details=node("details","");
        details.append(node("summary","","查看联合依据（"+String(row.status||"待确认")+"）"));
        const mk=row.market||{},initial=mk.initial,current=mk.current;
        details.append(node("p","muted","原Top1："+String(row.top1||"待确认")+" · 第二方向："+String(row.second||"待确认")+" · 市场变化："+String(mk.direction||"待确认")));
        details.append(node("p","muted","威廉初赔："+(initial?[initial.home,initial.draw,initial.away].join("/"): "未确认")+
          " → 即时："+(current?[current.home,current.draw,current.away].join("/"): "未确认")));
        const abroad=Array.isArray(row.overseas?.facts)?row.overseas.facts:[];
        details.append(node("p","muted","海外合格事实摘要："+abroad.length+"条"));
        for(const f of abroad.slice(0,3))details.append(node("p","muted","· "+String(f.summary||"").slice(0,240)+" / "+String(f.source||"")+" / 发布 "+fmt(f.publishedAt)));
        const domestic=Array.isArray(row.domestic?.items)?row.domestic.items:[];
        details.append(node("p","muted","国内归档："+(domestic.length?domestic.map(x=>String(x.title||"")).join("；"):"澳客跨库原文尚未完整同步")));
        details.append(node("p","muted","模型冻结时间："+fmt(row.evidenceAt)+" · 开球："+fmt(row.kickoff)));
        box.append(details);
        holder.append(box);
      }
      if(!json.rows?.length)holder.append(node("p","muted","该日期暂无可核验赛事。"));
    }catch(e){
      if(requestId===own&&isAuthorized())holder.replaceChildren(node("p","muted",
        "联合识别暂不可用："+String(e.message||"网络异常")+"。不影响管理员统计及客户服务。"));
    }
  };
})();
