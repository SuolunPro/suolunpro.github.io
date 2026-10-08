/* Administrator-only. Loads deep market only after clicking the admin button.
 * No frontend customer route, subscription polling or writes. */
(function(){
  "use strict";
  if(window.haoAdminFinalRender)return;
  const API="https://ttydbcejxqxdkcfoizkj.supabase.co/functions/v1/soren-admin-final-identification-v1";
  const DEEP_API="https://tqlibowvnwfkaseqqvvp.supabase.co/functions/v1/hao-r9-discovery-test-v01";
  const PUB="sb_publishable_n5thZ1g6h93ronyzPfqhsg_N_lFaoSa";
  const cache=new Map();
  const el=(tag,cls,txt)=>{const x=document.createElement(tag);if(cls)x.className=cls;if(txt!==undefined)x.textContent=String(txt);return x};
  const name=v=>String(v??"").trim();
  const fmt=v=>{const t=Date.parse(name(v));return Number.isFinite(t)?new Intl.DateTimeFormat("zh-CN",
    {timeZone:"Asia/Shanghai",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}).format(t):"待确认"};
  const p100=v=>{const n=Number(v);return Number.isFinite(n)&&n>0&&n<=100?n:null};
  const pickCode=v=>({HWIN:"让胜",HDRAW:"让平",HLOSS:"让负",H:"主胜",D:"平",A:"客胜"})[name(v)]||name(v);
  const textOr=(v,f="未确认")=>name(v)||f;
  const fullQuality=row=>["DQ-A","DQ-B"].includes(name(row.dq));
  const kickoffValid=(snapshot,deadline)=>{const t=Date.parse(name(snapshot));return Number.isFinite(t)&&Number.isFinite(deadline)&&t<deadline&&t<=Date.now()};
  function qualifiedDeep(row,raw){
    if(!raw?.ok||!raw.analysis)return {ok:false,why:"深度分析无数据"};
    if(raw.match?.no&&name(raw.match.no)!==name(row.no))return {ok:false,why:"竞彩号不匹配"};
    const a=raw.analysis;
    const cutoff=Date.parse(row.kickoff),at=a.capturedAt;
    if(!kickoffValid(at,cutoff))return {ok:false,why:"深度市场采集时间未通过赛前验证"};
    const market99=a.market_99||{},betfair=a.betfair||{},kelly=a.kelly||{},intel=a.intelligence||{};
    return {ok:true,at,market99,betfair,kelly,intel,
      summary:textOr(a.summary,"暂无明确总结"),flags:Array.isArray(a.flags)?a.flags.slice(0,5):[],
      marketStatus:raw.market?.status||null,bookmakerCount:Number(raw.market?.bookmakerCount||0),
      timingQuality:a.timingQuality||null};
  }
  function decide(row,deep){
    if(!deep.ok)return {label:"PASS",kind:"pass",reason:"未完整读取合法赛前深度市场分析，不能替代验证。"};
    const risk=row.handicap?.risk||{},hur=name(risk.hur);
    const source=row.handicap||{},hp=p100(source.probability);
    const hcVerified=source.originalVerified===true&&source.qualityEligible===true&&hp!==null
      &&["让胜","让平","让负"].includes(pickCode(source.pick))&&fullQuality(row);
    const both=deep.market99?.top===row.top1&&deep.betfair?.top===row.top1;
    const kelly=deep.kelly||{},kellyValid=Number(kelly.complete_count??kelly.completeCount??0)>=15;
    const kellyAgainst=kellyValid&&name(kelly.lowest_direction||kelly.top) &&
       name(kelly.lowest_direction||kelly.top)!==name(row.top1);
    const conf=Number(row.confidence);
    const baseValid=fullQuality(row)&&["主胜","平","客胜"].includes(row.top1)&&
       Number.isFinite(conf)&&conf>=.51;
    // This is a transparent RESEARCH tie-breaker, not a trained six-way winner model.
    // A verifiable original handicap direction can be investigated when the
    // ordinary FT choice is heavily exposed to tail risks or its confidence is low.
    if(hcVerified&&hp>=64&&(hur==="红"||conf<.49||row.action==="PASS")
        &&deep.bookmakerCount>=10){
      return {label:"让球胜平负 · "+pickCode(source.pick),kind:"single",
        reason:"原始赛前让球概率"+hp.toFixed(1)+"%，风险尾部需审计；这是影子候选，不是已证明比胜平负更准。"};
    }
    if(baseValid&&both&&deep.bookmakerCount>=10){
      if(kellyAgainst&&["重点复核","情报与机构分歧","情报风险提示"].includes(row.status)
         &&row.action==="PASS"){
        return {label:"PASS",kind:"pass",reason:"99家与必发虽支持首选，但凯利与海外风险同时形成分歧，不强行单选。"};
      }
      const caveat=row.action==="PASS"?"（原正式模型PASS，仅影子研究）":
        row.action==="DOUBLE"?"（原正式模型双选，仅影子研究）":"（与正式单选同向）";
      return {label:"胜平负 · "+row.top1,kind:"single",
        reason:"99家机构概率方向与必发资金方向均支持Top1"+caveat+"；情报与凯利分歧仍须人工复核。"};
    }
    if(row.action==="SINGLE"&&baseValid&&!["重点复核","情报与机构分歧"].includes(row.status))
      return {label:"胜平负 · "+row.top1,kind:"single",
        reason:"保持原正式单选，但深度市场未完全同向，影子层不提高信心。"};
    return {label:"PASS",kind:"pass",reason:"没有足够独立的赛前数据支持唯一市场与方向，禁止单纯为降低PASS而凑选。"};
  }
  async function getJson(url,token,ms,secondary=false){
    const c=new AbortController(),timer=setTimeout(()=>c.abort(),ms);
    try{
      const response=await fetch(url,{
        method:"GET",headers:{Authorization:"Bearer "+token,...(secondary?{}:{apikey:PUB})},
        cache:"no-store",signal:c.signal
      });
      const j=await response.json().catch(()=>null);
      if(!response.ok||j?.ok!==true)
        throw Error(response.status===403?"管理员授权未通过":name(j?.error)||"HTTP "+response.status);
      return j;
    }finally{clearTimeout(timer)}
  }
  function deepEvidence(card,row,deep,choice){
    const d=el("div","final-intel-pick "+choice.kind,choice.label);
    const original=el("p","muted",choice.reason);
    const box=el("div","");
    box.append(d,original);
    if(!deep.ok){
      box.append(el("p","muted","深度市场：不可用（"+textOr(deep.why)+"）"));card.append(box);return;
    }
    box.append(el("p","muted","深度市场已核对 · "+fmt(deep.at)+"（北京时间） · "+
      "机构数 "+(deep.bookmakerCount||"待确认")));
    const details=el("details","");
    details.append(el("summary","","查看完整交叉依据（"+textOr(row.status)+"）"));
    const m=deep.market99,b=deep.betfair,k=deep.kelly,h=row.handicap||{};
    details.append(el("p","muted","九十刻度Top1："+textOr(row.top1)+"，第二方向："+textOr(row.second)+
      "，正式处理："+textOr(row.action)+"，冻结："+fmt(row.evidenceAt)));
    details.append(el("p","muted","99家欧赔方向："+textOr(m.top)+" · 主/平/客 "+
      [m.probabilities_pct?.home,m.probabilities_pct?.draw,m.probabilities_pct?.away].map(v=>p100(v)?.toFixed(1)??"—").join(" / ")+"%"));
    details.append(el("p","muted","必发资金方向："+textOr(b.top)+" · 主/平/客 "+
      [b.share_pct?.home,b.share_pct?.draw,b.share_pct?.away].map(v=>p100(v)?.toFixed(1)??"—").join(" / ")+"%"));
    details.append(el("p","muted","凯利最低方向："+textOr(k.lowest_direction)+
      " · 有效机构 "+Number(k.complete_count||0)+"（最低凯利不能直接等于赛果预测）"));
    details.append(el("p","muted","正式让球Top1："+pickCode(h.pick||"未确认")+
      " · 让球值 "+textOr(h.officialLine)+
      " · 影子概率 "+(p100(h.probability)?.toFixed(1)??"未确认")+"%"+
      " · 原始冻结 "+(h.originalVerified?"是":"未确认")));
    details.append(el("p","muted","四大风险：HUR "+textOr(h.risk?.hur)+"、DTR "+textOr(h.risk?.dtr)+
      "、DLR "+textOr(h.risk?.dlr)+"；"+"情报状态："+textOr(row.status)));
    details.append(el("p","muted","深度市场原结论："+textOr(deep.summary)));
    for(const f of deep.flags)details.append(el("p","muted","市场提醒："+name(f)));
    details.append(el("p","muted","国内情报："+textOr(deep.intel.semantic_summary,"未形成可靠单边结论")));
    for(const f of (row.overseas?.facts||[]).slice(0,3))
      details.append(el("p","muted","海外："+name(f.summary).slice(0,200)+"（"+textOr(f.source)+"）"));
    details.append(el("p","muted","威廉变化："+textOr(row.market?.direction)+
      " · 数据源来自两套生产项目，均须符合原始赛前时间限制。"));
    box.append(details);card.append(box);
  }
  let generation=0;
  window.haoAdminFinalRender=async function({holder,token,date,isAuthorized}){
    const current=++generation;
    if(!holder||!token||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(name(date)))return;
    const valid=()=>generation===current&&isAuthorized()&&holder.isConnected;
    holder.replaceChildren(el("p","muted","正在读取管理员联合识别…"));
    let primary;
    try{primary=await getJson(API+"?date="+encodeURIComponent(date),token,12000)}
    catch(e){if(valid())holder.replaceChildren(el("p","muted","联合识别读取失败："+name(e?.message)));return}
    if(!valid())return;
    holder.replaceChildren(
      el("p","muted","管理员影子测试 · "+date+" · "+(primary.rows||[]).length+"场 · 分析时间 "+fmt(primary.generatedAt)),
      el("p","muted","已接入99家机构、必发、凯利及国内深度市场分析（单击加载，限制并发），再对照海外新闻和正式胜平负/让球。每场最多一个影子结果或PASS；规则未经回测，不计正式命中率。")
    );
    const matches=(primary.rows||[]).slice(0,40),widgets=[];
    for(const row of matches){
      const card=el("article","final-intel-row");
      card.append(el("h4","",textOr(row.no)+" "+textOr(row.home)+" VS "+textOr(row.away)),
        el("p","muted","正在读取本场深度市场（99家/必发/凯利）…"));
      holder.append(card);widgets.push(card);
    }
    // Two concurrent requests maximum; admin-only, on-click. Other services
    // and the customer homepage never load this data. Cache three minutes.
    let index=0;
    const worker=async()=>{
      while(index<matches.length&&valid()){
        const i=index++,row=matches[i],card=widgets[i],key=name(date)+"|"+name(row.no);
        try{
          let deepRaw;const found=cache.get(key);
          if(found&&Date.now()-found.at<180000)deepRaw=found.payload;
          else{
            deepRaw=await getJson(DEEP_API+"?view=admin-preview&date="+encodeURIComponent(date)+
              "&no="+encodeURIComponent(name(row.no)),token,10500,true);
            cache.set(key,{at:Date.now(),payload:deepRaw});
            while(cache.size>40)cache.delete(cache.keys().next().value);
          }
          if(!valid())return;
          const deep=qualifiedDeep(row,deepRaw),choice=decide(row,deep);
          card.replaceChildren(el("h4","",textOr(row.no)+" "+textOr(row.home)+" VS "+textOr(row.away)));
          deepEvidence(card,row,deep,choice);
        }catch(e){
          if(!valid())return;
          card.replaceChildren(el("h4","",textOr(row.no)+" "+textOr(row.home)+" VS "+textOr(row.away)));
          deepEvidence(card,row,{ok:false,why:"二级深度市场服务暂不可用："+name(e?.message)},
            {label:"待确认",kind:"pass",reason:"暂时无法完成完整交叉分析，不得冒充有证据的PASS或方向。"});
        }
      }
    };
    await Promise.all([worker(),worker()]);
  };
})();
