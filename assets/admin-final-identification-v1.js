(function(){
  "use strict";
  // Isolated administrator homepage panel: no changes to the engine, timers or customer API.
  if(document.getElementById("adminFinalIdentificationButton"))return;
  const models=document.getElementById("models"),main=document.getElementById("main");
  if(!models||!main)return;
  const button=document.createElement("button");
  button.type="button";button.id="adminFinalIdentificationButton";
  button.className="model";button.dataset.model="admin-final";
  button.textContent="最终识别";button.style.display="none";
  models.append(button);
  const board=document.createElement("section");
  board.id="adminFinalIdentificationBoard";board.setAttribute("aria-label","管理员最终识别影子模块");
  board.className="admin-final-board";
  const mainContent=document.getElementById("content");
  main.insertBefore(board,mainContent);
  const sheet=document.createElement("style");
  sheet.textContent=`
    body:not(.admin-final-open) .admin-final-board {display:none !important}
    body.admin-final-open #content,body.admin-final-open .toolbar {display:none !important}
    body.admin-final-open .admin-final-board {display:block;padding:0 14px 18px}
    .admin-final-intro{background:#fffaf2;border:1px solid #f2dfc3;border-radius:14px;padding:14px;margin:14px 0;color:#6b5331;font-size:12px;line-height:1.7}
    .admin-final-intro strong{display:block;font-size:15px;color:#523818;margin-bottom:3px}
    .admin-final-row{background:#fff;border:1px solid #e9e9ed;border-radius:14px;padding:15px;margin:12px 0;box-shadow:0 2px 8px #1d253105}
    .admin-final-row-title{font-size:15px;font-weight:750;color:#202b40;line-height:1.5;margin:0 0 7px}
    .admin-final-line{display:flex;gap:6px 10px;flex-wrap:wrap;align-items:center;font-size:12px;margin:7px 0;color:#546070}
    .admin-final-tag{padding:4px 9px;border-radius:8px;font-size:12px;font-weight:700;background:#eef3f9;color:#355571}
    .admin-final-tag.review{background:#fff0e4;color:#9a4820}
    .admin-final-tag.conflict{background:#fff3db;color:#8c5a11}
    .admin-final-tag.support{background:#eaf6ee;color:#286d48}
    .admin-final-tag.pending{background:#f2f3f4;color:#5e6570}
    .admin-final-description{color:#283849;line-height:1.65;font-size:13px;margin:9px 0}
    .admin-final-evidence{border-top:1px solid #edf0f4;margin-top:10px;padding-top:9px;font-size:12px;color:#586472;line-height:1.7}
    .admin-final-evidence b{display:block;color:#32425a;margin-bottom:5px;font-size:12px}
    .admin-final-evidence p{margin:5px 0;overflow-wrap:anywhere}
    .admin-final-meta{font-size:11px;color:#858c96;margin-top:8px;line-height:1.65}
    .admin-final-toolbar{display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap;margin:12px 0}
    .admin-final-refresh{background:#d62e35;color:#fff;border:0;border-radius:8px;padding:8px 12px;font-size:12px;cursor:pointer}
    .admin-final-refresh:disabled{opacity:.5;cursor:default}
    .admin-final-error{background:#fff5f1;border-radius:12px;padding:16px;font-size:13px;color:#8d422f}
    @media(min-width:760px){body.admin-final-open .admin-final-board{padding:0 24px 24px}}
  `;
  document.head.append(sheet);
  let open=false,loading=false,currentDate="",loadedAt=0,requestId=0;
  const cache=new Map();
  const el=(tag,cls,txt)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(txt!=null)n.textContent=String(txt);return n};
  const admin=()=>typeof memberInfo!=="undefined"&&memberInfo?.isAdmin===true&&
    typeof authSession!=="undefined"&&Boolean(authSession?.access_token);
  const selected=()=>typeof state!=="undefined"?String(state.selectedDate||""):"";
  const fmt=v=>{
    const t=Date.parse(String(v||""));return Number.isFinite(t)?new Intl.DateTimeFormat("zh-CN",
      {timeZone:"Asia/Shanghai",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}).format(new Date(t)):"未确认";
  };
  function close(){
    if(!open)return;
    open=false;requestId++;
    document.body.classList.remove("admin-final-open");
    button.classList.remove("active");
    board.replaceChildren();
  }
  function show(data){
    board.replaceChildren();
    const intro=el("div","admin-final-intro");
    intro.append(el("strong","","最终识别 · 管理员影子测试"),
      el("div","","汇总海外事实情报、已归档国内资讯、威廉赔率走势与九十刻度Top1。仅供人工复核，不修改正式预测、四大风险、冷门预警或让球输出。"),
      el("div","","重要：澳客影子原文目前尚未完整跨库接入；结论为试运行的部分交叉验证，不得据此宣称三方已完整验证。"));
    board.append(intro);
    const bar=el("div","admin-final-toolbar");
    bar.append(el("strong","","竞彩日期 "+String(data.date||selected())+" · "+(data.rows?.length||0)+"场"),
      el("span","admin-final-meta","分析生成 "+fmt(data.generatedAt)));
    const refresh=el("button","admin-final-refresh","重新核验");
    refresh.type="button";refresh.onclick=()=>load(true);
    bar.append(refresh);board.append(bar);
    if(!Array.isArray(data.rows)||!data.rows.length){
      board.append(el("div","admin-final-error","当前日期没有可核验的竞彩比赛。"));return;
    }
    const priority={"重点复核":0,"情报与机构分歧":1,"情报风险提示":2,"双方因素交错":3,"有限支持":4,"同向支持":5,"市场单线支持":6,"待确认":7};
    const entries=[...data.rows].sort((a,b)=>(priority[a.status]??7)-(priority[b.status]??7)||String(a.no).localeCompare(String(b.no)));
    for(const row of entries){
      const card=el("article","admin-final-row");
      card.append(el("h3","admin-final-row-title",
        String(row.no)+" · "+String(row.league||"")+" · "+String(row.home||"")+" vs "+String(row.away||"")));
      const meta=el("div","admin-final-line");
      const tag=el("span","admin-final-tag "+
        (/重点复核|风险提示/.test(row.status)?"review":/分歧|交错/.test(row.status)?"conflict":
        /支持/.test(row.status)?"support":"pending"),String(row.status||"待确认"));
      meta.append(tag,el("span","","正式Top1："+String(row.top1||"未确认")),
        el("span","","第二方向："+String(row.second||"未确认")));
      if(row.confidence!==null&&Number.isFinite(Number(row.confidence)))
        meta.append(el("span","","Top1信心："+(Number(row.confidence)*100).toFixed(1)+"%"));
      meta.append(el("span","","原方案："+({PASS:"PASS",DOUBLE:"双选",SINGLE:"单选"}[row.action]||row.action||"未确认")));
      card.append(meta,el("p","admin-final-description",String(row.description||"暂无已核验结论")));
      const mk=row.market||{},first=mk.initial,latest=mk.current;
      const market=el("div","admin-final-evidence");
      market.append(el("b","","① 威廉同机构赔率核对"),
        el("p","","初赔 "+(first?[first.home,first.draw,first.away].join(" / "):"未确认")+" → 即时 "+
          (latest?[latest.home,latest.draw,latest.away].join(" / "):"未确认")+
          " · 市场方向："+String(mk.direction||"未确认")));
      if(latest?.at)market.append(el("div","admin-final-meta","市场采集 "+fmt(latest.at)));
      card.append(market);
      const abroad=el("div","admin-final-evidence");
      abroad.append(el("b","","② 海外当地事实 · 已核验摘要 "+(row.overseas?.count??0)+"条"));
      const facts=Array.isArray(row.overseas?.facts)?row.overseas.facts:[];
      if(!facts.length)abroad.append(el("p","","无合格的赛前事实摘要；标题关键词自动分类不计为可靠证据。"));
      for(const fact of facts.slice(0,3)){
        abroad.append(el("p","","• "+String(fact.summary||"")+"（"+String(fact.source||"来源未确认")+
          " · 发布时间 "+fmt(fact.publishedAt)+" · 采集 "+fmt(fact.fetchedAt)+"）"));
      }
      card.append(abroad);
      const domestic=el("div","admin-final-evidence");
      domestic.append(el("b","","③ 国内情报 · "+String(row.domestic?.coverage||"待确认")));
      const d=Array.isArray(row.domestic?.items)?row.domestic.items:[];
      if(!d.length)domestic.append(el("p","","国内澳客影子情报暂未完整同步；不等于此场没有国内消息。"));
      else for(const item of d.slice(0,2))domestic.append(el("p","","• "+String(item.title||"")+
        "（"+String(item.source||"")+" · "+fmt(item.fetchedAt)+"）"));
      card.append(domestic);
      card.append(el("div","admin-final-meta",
        "正式风险等级："+String(row.warnings?.riskLevel||"未确认")+" · 比赛时间（北京）"+
        fmt(row.kickoff)+" · 仅管理员影子输出；暂未开放月卡会员"));
      board.append(card);
    }
  }
  async function load(force=false){
    if(!open||!admin()||loading)return;
    const date=selected();
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return;
    const cached=cache.get(date);
    if(!force&&cached&&Date.now()-cached.at<120000){
      currentDate=date;loadedAt=cached.at;show(cached.data);return;
    }
    loading=true;const own=++requestId;
    if(!board.children.length||force)board.replaceChildren(el("div","admin-final-intro","正在核验管理员联合情报…"));
    try{
      const api="https://ttydbcejxqxdkcfoizkj.supabase.co/functions/v1/soren-admin-final-identification-v1?date="+encodeURIComponent(date);
      const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),12000);
      let res;
      try{res=await authorizedApiFetch(api,{cache:"no-store",signal:ctrl.signal,headers:{apikey:"sb_publishable_n5thZ1g6h93ronyzPfqhsg_N_lFaoSa"}})}
      finally{clearTimeout(timer)}
      const payload=await res.json().catch(()=>null);
      if(!res.ok||payload?.ok!==true)throw Error(res.status===403?"当前账户无管理员权限":String(payload?.error||"HTTP "+res.status));
      if(!open||requestId!==own||selected()!==date)return;
      const at=Date.now();cache.set(date,{at,data:payload});
      while(cache.size>5)cache.delete(cache.keys().next().value);
      currentDate=date;loadedAt=at;show(payload);
    }catch(error){
      if(!open||requestId!==own)return;
      if(cached){currentDate=date;loadedAt=cached.at;show(cached.data);board.prepend(el("div","admin-final-error","本次刷新失败，展示上次缓存；"+String(error?.message||"网络异常")));}
      else board.replaceChildren(el("div","admin-final-error","联合情报暂时不可用（"+String(error?.message||"网络异常")+"），正式预测与客户页面不受影响。"));
    }finally{loading=false}
  }
  button.addEventListener("click",()=>{
    if(!admin())return;
    open=true;
    document.body.classList.add("admin-final-open");
    document.querySelectorAll(".model").forEach(x=>x.classList.toggle("active",x===button));
    document.querySelectorAll(".nav").forEach(x=>x.classList.toggle("active",x.dataset.tab==="home"));
    if(typeof state!=="undefined")state.tab="home";
    const title=document.getElementById("modelTitle"),desc=document.getElementById("modelDesc");
    if(title)title.textContent="最终识别";
    if(desc)desc.textContent="国内外事实情报 × 机构赔率 × 九十刻度预测 · 管理员影子测试";
    board.replaceChildren();currentDate="";load(true);
  });
  models.addEventListener("click",e=>{const b=e.target.closest(".model");if(b&&b!==button)close()},true);
  document.querySelectorAll(".nav").forEach(nav=>nav.addEventListener("click",()=>close(),true));
  setInterval(()=>{
    const allowed=admin();
    button.style.display=allowed?"":"none";
    if(open&&!allowed){close();return}
    if(open&&typeof state!=="undefined"&&state.tab!=="home"){close();return}
    if(open&&document.hidden)return;
    if(open&&!loading&&selected()!==currentDate)load();
    else if(open&&!loading&&Date.now()-loadedAt>120000)load();
  },1600);
  document.addEventListener("visibilitychange",()=>{if(!document.hidden&&open&&admin()&&Date.now()-loadedAt>120000)load()});
})();
