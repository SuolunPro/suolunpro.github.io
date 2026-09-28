import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const WEB_HEADERS = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.7",
  "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "cache-control": "no-cache"
};

function decodeEntities(s:string) {
  return s
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_,n)=>String.fromCharCode(Number(n)));
}

function cellText(s:string) {
  return decodeEntities(
    s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
     .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
     .replace(/<br\s*\/?>/gi, " ")
     .replace(/<[^>]+>/g, " ")
  ).replace(/\s+/g, " ").trim();
}

function htmlText(s:string) {
  return decodeEntities(
    s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
     .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
     .replace(/<br\s*\/?>/gi, "\n")
     .replace(/<\/(?:p|div|li|tr|table|section|header|footer)>/gi, "\n")
     .replace(/<[^>]+>/g, " ")
  ).replace(/[ \t]+/g, " ").replace(/\n\s+/g, "\n").trim();
}

function normalizeTeam(v:unknown) {
  return String(v ?? "").toLowerCase()
    .replace(/足球俱乐部|俱乐部|football club|\bfc\b/gi, "")
    .replace(/迈国际/g, "迈阿密国际")
    .replace(/國際/g, "国际")
    .replace(/马其顿/g, "北马其顿")
    .replace(/哈萨克$/g, "哈萨克斯坦")
    .replace(/[·•.\-－—_()（）\[\]【】\s]/g, "")
    .trim();
}

function teamMatch(a:unknown,b:unknown) {
  const x=normalizeTeam(a), y=normalizeTeam(b);
  if(!x||!y)return false;
  if(x===y)return true;
  if(Math.min(x.length,y.length)>=3&&(x.includes(y)||y.includes(x)))return true;
  const xs=new Set([...x]), ys=new Set([...y]);
  const inter=[...xs].filter(ch=>ys.has(ch)).length;
  return inter/Math.max(xs.size,ys.size)>=0.8;
}

function numberValue(v:unknown) {
  const s=String(v??"").replace(/,/g,"").replace(/%/g,"").trim();
  if(!s||s==="-")return null;
  const n=Number(s);
  return Number.isFinite(n)?n:null;
}

function pageTitle(html:string) {
  return cellText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
}

function parseIdentity(html:string) {
  const title=pageTitle(html);
  let m=title.match(/交易盈亏\s*[-－_:：]?\s*(.+?)\s*vs\s*(.+?)\s*[-－_|｜]/i);
  if(!m){
    const text=htmlText(html).slice(0,1800);
    m=text.match(/交易盈亏\s*[-－_:：]?\s*([^\n]{2,30}?)\s*vs\s*([^\n]{2,30}?)(?:\s*[-－_|｜]|\s+(?:欧|亚|竞足|单场|14场|开通))/i);
  }
  if(!m){
    const title2=title.match(/[-－]\s*(.+?)\s*vs\s*(.+?)\s*[-－]/i);
    if(title2)m=title2;
  }
  return m?{home:m[1].trim(),away:m[2].trim()}:null;
}

function parseOkoooKickoff(html:string) {
  const text=htmlText(html);
  const m=text.match(/(?:^|\s)(\d{2})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?:\s|$)/);
  if(!m)return null;
  return Date.UTC(2000+Number(m[1]),Number(m[2])-1,Number(m[3]),Number(m[4])-8,Number(m[5]),0,0);
}

function tableRows(html:string) {
  const tables:string[][][]=[];
  for(const tm of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)){
    const rows:string[][]=[];
    for(const rm of tm[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)){
      const cells:string[]=[];
      for(const cm of rm[1].matchAll(/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi))cells.push(cellText(cm[1]));
      if(cells.length)rows.push(cells);
    }
    if(rows.length)tables.push(rows);
  }
  return tables;
}

function parseBehavior(html:string,home:string,away:string) {
  const tables=tableRows(html);
  const txTable=tables.find(rows=>{
    const t=rows.flat().join("|");
    return t.includes("必发成交数据")&&t.includes("竞彩数据")&&t.includes("做单人气比例");
  });
  const idxTable=tables.find(rows=>{
    const t=rows.flat().join("|");
    return t.includes("99家平均")&&t.includes("交易量比例")&&t.includes("交易冷热指数")&&t.includes("庄家盈亏指数");
  });
  if(!txTable||!idxTable)return null;
  const role=(name:string)=>teamMatch(name,home)?"home":teamMatch(name,away)?"away":/平局|^平$/.test(name)?"draw":null;
  const tx:any[]=[];
  const idx:any[]=[];
  for(const c of txTable){
    const r=role(c[0]??"");
    if(!r||c.length<13)continue;
    tx.push({role:r,team:r==="home"?home:r==="away"?away:"平局",
      bfOdds:numberValue(c[5]),bfVolume:numberValue(c[6]),bfProfitLoss:numberValue(c[7]),
      jcOdds:numberValue(c[8]),jcSavedVolume:numberValue(c[9]),jcProfitLoss:numberValue(c[10]),
      savedPopularity:numberValue(c[11]),doerPct:numberValue(c[12])});
  }
  for(const c of idxTable){
    const r=role(c[0]??"");
    if(!r||c.length<12)continue;
    idx.push({role:r,team:r==="home"?home:r==="away"?away:"平局",
      avgOdds:numberValue(c[1]),avgProb:numberValue(c[2]),bfShare:numberValue(c[3]),
      jcSavedShare:numberValue(c[4]),northShare:numberValue(c[5]),
      bfHotCold:numberValue(c[6]),jcHotCold:numberValue(c[7]),
      bfMarketIndex:numberValue(c[8]),jcMarketIndex:numberValue(c[9]),
      bfProfitIndex:numberValue(c[10]),jcProfitIndex:numberValue(c[11])});
  }
  const order:any={home:0,draw:1,away:2};
  tx.sort((a,b)=>order[a.role]-order[b.role]);
  idx.sort((a,b)=>order[a.role]-order[b.role]);
  if(tx.length<3||idx.length<3)return null;
  const source=[
    htmlText(html),
    ...tables.flatMap(rows=>rows.flat())
  ].join("\n").replace(/[\u00a0\u2000-\u200b\u3000]/g," ").replace(/[ \t]+/g," ");
  const scale=
    source.match(/本场比赛\s*必发交易规模\s*(?:为|[:：])?\s*(较大|适中|较小)/)?.[1] ??
    source.match(/必发交易规模\s*(?:为|[:：])?\s*(较大|适中|较小)/)?.[1] ?? null;
  return {
    exchangeScale:scale,
    transactionRows:tx.map(({role,...x})=>x),
    indexRows:idx.map(({role,...x})=>x)
  };
}

function issueKickoff(text:string) {
  const m=String(text??"").match(/(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
  if(!m)return null;
  const year=Number(new Intl.DateTimeFormat("en",{timeZone:"Asia/Shanghai",year:"numeric"}).format(new Date()));
  return new Date(Date.UTC(year,Number(m[1])-1,Number(m[2]),Number(m[3])-8,Number(m[4]),0,0)).toISOString();
}

function issueMarketCell(cell:string) {
  const s=String(cell??"").replace(/\s+/g," ").trim();
  const ms=[...s.matchAll(/\d+\.\d+/g)];
  if(ms.length<3)return null;
  const odds=ms.slice(0,3).map(x=>Number(x[0]));
  if(odds.some(x=>!Number.isFinite(x)||x<=1))return null;
  const hStart=(ms[0].index??0)+ms[0][0].length;
  const hEnd=ms[1].index??hStart;
  const aStart=(ms[2].index??0)+ms[2][0].length;
  const home=s.slice(hStart,hEnd).replace(/^[\s:：-]+|[\s:：-]+$/g,"").trim();
  const away=s.slice(aStart).replace(/^[\s:：-]+|[\s:：-]+$/g,"").trim();
  if(!home||!away)return null;
  const inv=odds.map(x=>1/x),sum=inv.reduce((a,b)=>a+b,0);
  const probs=inv.map(x=>Number((x/sum*100).toFixed(2)));
  return {home,away,odds,probs};
}

function fallbackBehavior(row:any) {
  const fm=row.fallbackMarket;
  if(!fm)return null;
  const teams=[fm.home,"平局",fm.away];
  return {
    exchangeScale:null,
    transactionRows:[],
    indexRows:[0,1,2].map(i=>({
      team:teams[i],avgOdds:fm.odds[i],avgProb:fm.probs[i],
      bfShare:null,jcSavedShare:null,northShare:null,bfHotCold:null,jcHotCold:null,
      bfMarketIndex:null,jcMarketIndex:null,bfProfitIndex:null,jcProfitIndex:null
    }))
  };
}

function parseIssueRows(html:string) {
  const out:any[]=[];
  const seen=new Set<number>();
  for(const rm of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)){
    const tr=rm[1];
    const cells=[...tr.matchAll(/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)].map(x=>cellText(x[1]));
    if(cells.length<4)continue;
    const sm=String(cells[0]??"").match(/(?:^|\s)(1[0-4]|[1-9])(?:\s|$)/);
    const mm=tr.match(/\/soccer\/match\/(\d+)\/odds\//i);
    if(!sm||!mm)continue;
    const slot=Number(sm[1]);
    if(seen.has(slot))continue;
    seen.add(slot);
    out.push({
      slot,league:cells[1]??null,kickoffText:cells[2]??null,okoooMatchId:mm[1],
      fallbackKickoffAt:issueKickoff(cells[2]??""),
      fallbackMarket:issueMarketCell(cells[3]??"")
    });
  }
  return out.sort((a,b)=>a.slot-b.slot);
}

function parseIssueNo(html:string) {
  return htmlText(html).match(/(?:第\s*)?(\d{5})期/)?.[1] ?? null;
}

function parseSaleCutoff(html:string) {
  const t=htmlText(html);
  const m=t.match(/截止时间\s*[:：]?\s*(\d{2})-(\d{2})[^0-9]{0,10}(\d{2}):(\d{2})/);
  if(!m)return null;
  const now=new Date();
  const year=Number(new Intl.DateTimeFormat("en",{timeZone:"Asia/Shanghai",year:"numeric"}).format(now));
  return new Date(Date.UTC(year,Number(m[1])-1,Number(m[2]),Number(m[3])-8,Number(m[4]),0,0)).toISOString();
}

async function getHtml(url:string,timeout=18000){
  let last:any=null;
  for(let attempt=0;attempt<3;attempt++){
    const ctl=new AbortController();
    const timer=setTimeout(()=>ctl.abort(),timeout);
    try{
      const r=await fetch(url,{headers:{...WEB_HEADERS,referer:"https://www.okooo.com/zucai/"},signal:ctl.signal,redirect:"follow"});
      if(!r.ok)throw new Error("HTTP_"+r.status);
      const buf=await r.arrayBuffer();
      const ct=String(r.headers.get("content-type")??"").toLowerCase();
      const declared=(ct.match(/charset=([^;\s]+)/)?.[1]??"").toLowerCase();
      const pref=/gb2312|gbk|gb18030/.test(declared)?"gb18030":"utf-8";
      let text=new TextDecoder(pref).decode(buf);
      if(pref==="utf-8"&&(text.match(/�/g)||[]).length>3)text=new TextDecoder("gb18030").decode(buf);
      return text;
    }catch(e){
      last=e;
      if(attempt<2)await new Promise(r=>setTimeout(r,500*(attempt+1)));
    }finally{clearTimeout(timer);}
  }
  throw last??new Error("FETCH_FAILED");
}

function behaviorDirection(b:any){
  if(!b)return {top:null,strength:null,margin:0};
  const tr=Array.isArray(b.transactionRows)?b.transactionRows:[];
  const ix=Array.isArray(b.indexRows)?b.indexRows:[];
  if(tr.length<3||ix.length<3)return {top:null,strength:null,margin:0};
  const nums=(list:any[],key:string)=>[0,1,2].map(i=>Number.isFinite(Number(list[i]?.[key]))?Number(list[i][key]):0);
  const doer=nums(tr,"doerPct"),bf=nums(ix,"bfShare"),jc=nums(ix,"jcSavedShare"),
    avg=nums(ix,"avgProb"),bfHot=nums(ix,"bfHotCold"),jcHot=nums(ix,"jcHotCold");
  const score=[0,0,0];
  const maxIndex=(a:number[])=>a.indexOf(Math.max(...a));
  const add=(a:number[],w:number)=>{const i=maxIndex(a);if(i>=0)score[i]+=w;};
  add(avg,1);add(jc,2);add(doer,1);add(bf,b.exchangeScale==="较小"?1:2);
  const bi=maxIndex(bfHot),ji=maxIndex(jcHot);
  if(bi>=0&&bfHot[bi]>=15)score[bi]+=b.exchangeScale==="较小"?0.5:1;
  if(ji>=0&&jcHot[ji]>=15)score[ji]+=1;
  const rank=score.map((v,i)=>({i,v})).sort((a,c)=>c.v-a.v);
  const margin=(rank[0]?.v??0)-(rank[1]?.v??0);
  return {top:["主胜","平","客胜"][rank[0]?.i]??null,strength:margin>=3?"强":margin>=1.5?"中":"弱",margin};
}

function analyzeMatch(m:any){
  const labels=["主胜","平","客胜"];
  const ix=m.behavior?.indexRows??[];
  const probs=[0,1,2].map(i=>Number(ix[i]?.avgProb));
  if(probs.some(v=>!Number.isFinite(v)))return {...m,analysis:{eligible:false,reason:"NO_99_PROB"}};
  const rank=probs.map((v,i)=>({i,v})).sort((a,b)=>b.v-a.v);
  const topIdx=rank[0].i,secondIdx=rank[1].i;
  const top=labels[topIdx],second=labels[secondIdx],topProb=rank[0].v,secondProb=rank[1].v;
  const consensusGap=topProb-secondProb;
  const bfShare=Number(ix[topIdx]?.bfShare),jcShare=Number(ix[topIdx]?.jcSavedShare);
  const popularityGap=Math.max(
    Number.isFinite(bfShare)?bfShare-topProb:-999,
    Number.isFinite(jcShare)?jcShare-topProb:-999
  );
  const heat=Math.max(Number(ix[topIdx]?.bfHotCold??-999),Number(ix[topIdx]?.jcHotCold??-999));
  const profit=Math.min(Number(ix[topIdx]?.bfProfitIndex??999),Number(ix[topIdx]?.jcProfitIndex??999));
  const fundAnomaly=popularityGap>=5&&heat>=15&&profit<=-15;
  const bd=behaviorDirection(m.behavior);
  const behaviorAdverse=!!(bd.top&&bd.top!==top&&["中","强"].includes(String(bd.strength)));
  const tier=String(m.hj38?.displayTier??"");
  const hjTop=String(m.hj38?.top1??"");
  const reasons:string[]=[];
  let risk=0;
  if(tier==="强风险信号"){risk+=60;reasons.push("3.8强风险信号");}
  else if(tier==="重点风险"){risk+=45;reasons.push("3.8重点风险");}
  else if(tier==="一般风险"){risk+=18;reasons.push("3.8一般风险");}
  if(fundAnomaly){risk+=35;reasons.push("澳客资金结构异常");}
  if(behaviorAdverse){risk+=30;reasons.push("澳客资金方向反向");}
  if(hjTop&&hjTop!==top){risk+=20;reasons.push("3.8方向与99家分歧");}
  if(consensusGap<3){risk+=35;reasons.push("99家方向极弱");}
  else if(consensusGap<6){risk+=25;reasons.push("99家方向偏弱");}
  else if(consensusGap<10){risk+=15;reasons.push("99家优势有限");}
  if(topProb<40){risk+=30;reasons.push("99家Top1低于40%");}
  else if(topProb<45){risk+=20;reasons.push("99家Top1低于45%");}
  else if(topProb<50){risk+=10;reasons.push("99家Top1低于50%");}
  if(m.behaviorCompleteness!=="FULL"){risk+=8;reasons.push("澳客资金页未确认，仅99家");}
  else if(!["适中","较大"].includes(String(m.behavior?.exchangeScale??""))){risk+=5;reasons.push("交易规模偏小/未确认");}
  const hardCold=["重点风险","强风险信号"].includes(tier)&&fundAnomaly;
  const safety=Number((topProb+Math.min(consensusGap,25)*0.8-risk*0.7).toFixed(2));
  return {...m,analysis:{
    eligible:true,top1:top,second,topProb,secondProb,consensusGap:Number(consensusGap.toFixed(2)),
    popularityGap:Number(popularityGap.toFixed(2)),heat,profitIndex:profit,fundAnomaly,
    behaviorTop:bd.top,behaviorStrength:bd.strength,behaviorAdverse,
    hj38Top1:hjTop||null,hj38DisplayTier:tier||null,hardCold,riskScore:risk,safetyScore:safety,reasons
  }};
}

Deno.serve(async(req:Request)=>{
  if(req.method!=="POST")return Response.json({ok:false,error:"METHOD_NOT_ALLOWED"},{status:405});
  const key=req.headers.get("x-soren-intel-key")??"";
  if(key.length<32)return Response.json({ok:false,error:"UNAUTHORIZED"},{status:401});
  const {data:authorized,error:authError}=await db.rpc("soren_intel_authorized",{p_key:key});
  if(authError||authorized!==true)return Response.json({ok:false,error:"UNAUTHORIZED"},{status:401});

  try{
    let body:any={};try{body=await req.json();}catch{}
    const requestedIssue=typeof body?.issue==="string"&&/^\d{5}$/.test(body.issue)?body.issue:null;
    let sourceUrl=requestedIssue?"https://www.okooo.com/zucai/"+requestedIssue+"/":"https://www.okooo.com/zucai/";
    let issueHtml:string;
    try{issueHtml=await getHtml(sourceUrl,18000);}
    catch(e){
      if(!requestedIssue)throw e;
      sourceUrl="https://www.okooo.com/zucai/";
      issueHtml=await getHtml(sourceUrl,18000);
    }
    const issueNo=parseIssueNo(issueHtml);
    if(!issueNo)return Response.json({ok:false,error:"ISSUE_NOT_FOUND"},{status:502});
    if(requestedIssue&&issueNo!==requestedIssue)return Response.json({ok:false,error:"ISSUE_MISMATCH",requestedIssue,seen:issueNo},{status:409});
    const saleCutoff=parseSaleCutoff(issueHtml);
    if(saleCutoff&&Date.now()>=Date.parse(saleCutoff))return Response.json({ok:false,status:"FROZEN",issueNo,saleCutoff},{status:409});

    const issueRows=parseIssueRows(issueHtml);
    if(issueRows.length!==14)return Response.json({ok:false,error:"POOL_PARSE_INCOMPLETE",issueNo,count:issueRows.length,rows:issueRows},{status:502});

    const parsed:any[]=[];
    const failures:any[]=[];
    for(let offset=0;offset<issueRows.length;offset+=2){
      const chunk=issueRows.slice(offset,offset+2);
      const batch=await Promise.all(chunk.map(async(r:any)=>{
        const url="https://www.okooo.com/soccer/match/"+r.okoooMatchId+"/exchanges/";
        try{
          const html=await getHtml(url,18000);
          const ident=parseIdentity(html);
          const kickMs=parseOkoooKickoff(html);
          if(ident&&kickMs){
            const behavior=parseBehavior(html,ident.home,ident.away);
            if(behavior)return {...r,status:"OK",behaviorCompleteness:"FULL",home:ident.home,away:ident.away,kickoffAt:new Date(kickMs).toISOString(),behavior,sourceUrl:url};
          }
          const fallback=fallbackBehavior(r);
          if(fallback&&r.fallbackMarket&&r.fallbackKickoffAt){
            return {...r,status:"OK_99_ONLY",behaviorCompleteness:"99_ONLY",
              home:r.fallbackMarket.home,away:r.fallbackMarket.away,kickoffAt:r.fallbackKickoffAt,
              behavior:fallback,sourceUrl:"https://www.okooo.com/zucai/"+issueNo+"/"};
          }
          return {...r,status:"BEHAVIOR_MISSING"};
        }catch(e){
          const fallback=fallbackBehavior(r);
          if(fallback&&r.fallbackMarket&&r.fallbackKickoffAt){
            return {...r,status:"OK_99_ONLY",behaviorCompleteness:"99_ONLY",
              home:r.fallbackMarket.home,away:r.fallbackMarket.away,kickoffAt:r.fallbackKickoffAt,
              behavior:fallback,sourceUrl:"https://www.okooo.com/zucai/"+issueNo+"/",
              fallbackError:String(e).slice(0,160)};
          }
          return {...r,status:"FETCH_ERROR",error:String(e).slice(0,160)};
        }
      }));
      for(const x of batch){if(String(x.status).startsWith("OK"))parsed.push(x);else failures.push(x);}
      if(offset+2<issueRows.length)await new Promise(r=>setTimeout(r,350));
    }

    const minKick=Math.min(...parsed.map(x=>Date.parse(x.kickoffAt)));
    const maxKick=Math.max(...parsed.map(x=>Date.parse(x.kickoffAt)));
    let sorenMatches:any[]=[];
    if(Number.isFinite(minKick)&&Number.isFinite(maxKick)){
      const {data}=await db.from("soren_matches")
        .select("id,pool_date,match_no,home_team,away_team,kickoff_at,is_world_cup")
        .eq("is_world_cup",false)
        .gte("kickoff_at",new Date(minKick-3600000).toISOString())
        .lte("kickoff_at",new Date(maxKick+3600000).toISOString())
        .limit(200);
      sorenMatches=data??[];
    }

    const matched:any[]=[];
    for(const p of parsed){
      const pk=Date.parse(p.kickoffAt);
      const sm=sorenMatches.find((x:any)=>
        Math.abs(Date.parse(String(x.kickoff_at))-pk)<=15*60000&&
        teamMatch(x.home_team,p.home)&&teamMatch(x.away_team,p.away)
      );
      matched.push({...p,sorenMatch:sm??null});
    }

    const dates=[...new Set(matched.filter(x=>x.sorenMatch).map(x=>String(x.sorenMatch.pool_date)))];
    let updates:any[]=[];
    let warnings:any[]=[];
    if(dates.length){
      const [{data:u},{data:w}]=await Promise.all([
        db.from("soren_prematch_updates_v1").select("pool_date,match_no,snapshot,source_frozen_at").in("pool_date",dates).order("source_frozen_at",{ascending:false}).limit(1000),
        db.from("soren_upset_warnings_v1").select("pool_date,match_no,risk_level,risk_score,source_payload,source_frozen_at").in("pool_date",dates).order("source_frozen_at",{ascending:false}).limit(1000)
      ]);
      updates=u??[];warnings=w??[];
    }

    const enriched=matched.map((p:any)=>{
      const sm=p.sorenMatch;
      if(!sm)return {...p,hj38:null};
      const u=updates.find((x:any)=>String(x.pool_date)===String(sm.pool_date)&&String(x.match_no).padStart(3,"0")===String(sm.match_no).padStart(3,"0"));
      const w=warnings.find((x:any)=>String(x.pool_date)===String(sm.pool_date)&&String(x.match_no).padStart(3,"0")===String(sm.match_no).padStart(3,"0"));
      const snap=u?.snapshot??{};
      const payload=w?.source_payload??{};
      return {...p,hj38:{
        top1:snap?.ftTop1??payload?.originalTop1??null,
        displayTier:snap?.upsetWarning?.displayTier??payload?.displayTier??null,
        riskLevel:w?.risk_level??null,riskScore:w?.risk_score??null,
        sourceFrozenAt:u?.source_frozen_at??w?.source_frozen_at??null
      }};
    });

    const analyzed=enriched.map(analyzeMatch);
    const eligible=analyzed.filter((x:any)=>x.analysis?.eligible===true);
    const hard=eligible.filter((x:any)=>x.analysis.hardCold).sort((a:any,b:any)=>a.analysis.safetyScore-b.analysis.safetyScore);
    const soft=eligible.filter((x:any)=>!x.analysis.hardCold).sort((a:any,b:any)=>a.analysis.safetyScore-b.analysis.safetyScore);
    const drop=[...hard,...soft].slice(0,5);
    const dropSlots=new Set(drop.map((x:any)=>x.slot));
    const kept=eligible.filter((x:any)=>!dropSlots.has(x.slot)).sort((a:any,b:any)=>b.analysis.safetyScore-a.analysis.safetyScore);
    const singles=kept.slice(0,4);
    const doubles=kept.slice(4,9);
    const ticketRows=kept.map((x:any)=>({
      slot:x.slot,home:x.home,away:x.away,
      mode:singles.some((s:any)=>s.slot===x.slot)?"单":"双",
      picks:singles.some((s:any)=>s.slot===x.slot)?[x.analysis.top1]:[x.analysis.top1,x.analysis.second],
      top1:x.analysis.top1,second:x.analysis.second,safetyScore:x.analysis.safetyScore,
      riskScore:x.analysis.riskScore
    })).sort((a:any,b:any)=>a.slot-b.slot);
    const formalShapeOk=eligible.length===14&&kept.length===9&&singles.length===4&&doubles.length===5;
    const retainedHardCold=kept.filter((x:any)=>x.analysis.hardCold).map((x:any)=>x.slot);
    const fullBehaviorCount=analyzed.filter((x:any)=>x.behaviorCompleteness==="FULL").length;
    const fallback99Count=analyzed.filter((x:any)=>x.behaviorCompleteness==="99_ONLY").length;
    const runStatus=!formalShapeOk?"PARTIAL":
      (retainedHardCold.length||fallback99Count>0)?"SHADOW_REVIEW":"SHADOW_READY";
    const selection={
      ruleVersion:"HAOCHUAN-2.4-R9-SHADOW-v0.1",
      principle:"14场全池→99家市场共识→3.8冷门/澳客资金排雷→舍5留9→4单5双64元；冷门层不翻Top1",
      dropSlots:[...dropSlots].sort((a,b)=>a-b),
      keepSlots:kept.map((x:any)=>x.slot).sort((a:number,b:number)=>a-b),
      singles:singles.map((x:any)=>x.slot).sort((a:number,b:number)=>a-b),
      doubles:doubles.map((x:any)=>x.slot).sort((a:number,b:number)=>a-b),
      retainedHardCold,
      ticketCostRmb:formalShapeOk?64:null,
      ticketRows
    };

    const pool=analyzed.map((x:any)=>({
      slot:x.slot,league:x.league,home:x.home,away:x.away,kickoffAt:x.kickoffAt,
      okoooMatchId:x.okoooMatchId,exchangeScale:x.behavior?.exchangeScale??null,
      avgProbability:x.behavior?.indexRows?.map((r:any)=>r.avgProb)??null,
      avgOdds:x.behavior?.indexRows?.map((r:any)=>r.avgOdds)??null,
      analysis:x.analysis,hj38:x.hj38,
      matchedSorenMatch:x.sorenMatch?{poolDate:x.sorenMatch.pool_date,matchNo:x.sorenMatch.match_no,id:x.sorenMatch.id}:null
    })).sort((a:any,b:any)=>a.slot-b.slot);

    const record={
      issue_no:issueNo,model_version:"HAOCHUAN-2.4-R9-SHADOW-v0.1",
      captured_at:new Date().toISOString(),source_url:sourceUrl,sale_cutoff_at:saleCutoff,
      status:runStatus,pool,selection,
      diagnostics:{issueRows:issueRows.length,behaviorParsed:parsed.length,fullBehaviorCount,fallback99Count,failures,matchedHj38:enriched.filter((x:any)=>x.hj38).length},
      no_result_leakage:true
    };
    const {data:stored,error:storeError}=await db.from("soren_r9_shadow_runs_v1").insert(record).select("id").single();
    if(storeError)throw storeError;

    return Response.json({ok:true,id:stored?.id,issueNo,saleCutoff,status:runStatus,
      parsed:parsed.length,fullBehaviorCount,fallback99Count,matchedHj38:enriched.filter((x:any)=>x.hj38).length,
      dropSlots:selection.dropSlots,keepSlots:selection.keepSlots,
      singles:selection.singles,doubles:selection.doubles,cost:selection.ticketCostRmb,
      retainedHardCold,failures}, {status:200,headers:{"Cache-Control":"no-store"}});
  }catch(e){
    console.error("SOREN_R9_SHADOW_ERROR",e);
    return Response.json({ok:false,error:"R9_SHADOW_FAILED",detail:String(e).slice(0,220)},{status:502});
  }
});