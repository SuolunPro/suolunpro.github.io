
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const sb=createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  {auth:{persistSession:false,autoRefreshToken:false}}
);

const RULE_VERSION="HC24-R9-OKOOO-HJ38-v0.1";
const FIXTURE_URL="https://data.7m.com.cn/lottery/wsfc_fixture.shtml";
const WEB_HEADERS={
  "user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  "accept-language":"zh-CN,zh;q=0.9,en;q=0.7",
  "accept":"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "sec-fetch-site":"same-origin",
  "sec-fetch-mode":"navigate",
  "sec-fetch-dest":"document",
  "upgrade-insecure-requests":"1",
  "cache-control":"no-cache"
};

const pad=(x:any)=>String(x).padStart(2,"0");
const strip=(s:any)=>String(s??"").replace(/<[^>]*>/g,"").replace(/&nbsp;|&#160;/gi," ").replace(/&amp;/gi,"&").replace(/\s+/g," ").trim();
const aliases:Record<string,string>={
  "阿斯顿维拉":"维拉","维拉":"维拉","马德里竞技":"马竞","马竞":"马竞","巴塞罗那":"巴萨","巴萨":"巴萨",
  "拉科鲁尼亚":"拉科","拉科":"拉科","毕尔巴鄂竞技":"毕尔巴鄂","毕尔巴鄂":"毕尔巴鄂",
  "桑坦德竞技":"桑坦德","桑坦德":"桑坦德","伍尔弗汉普顿":"狼队","狼队":"狼队",
  "维戈塞尔塔":"塞尔塔","塞尔塔":"塞尔塔","哈萨克斯坦":"哈萨克","迈国际":"迈阿密国际"
};

const displayAliases:Record<string,string>={
  "亚美尼":"亚美尼亚","拉脱维":"拉脱维亚","塞浦路":"塞浦路斯","北爱":"北爱尔兰",
  "罗马尼":"罗马尼亚","保加利":"保加利亚","爱沙尼":"爱沙尼亚","斯洛文":"斯洛文尼亚",
  "马其顿":"北马其顿","克罗地":"克罗地亚","斯洛伐":"斯洛伐克"
};
const expandTeam=(s:any)=>displayAliases[strip(s)]||strip(s);

const canon=(s:any)=>{
  let x=strip(s).replace(/[·•.\-－—_()（）\[\]【】\s]/g,"").replace(/足球俱乐部|俱乐部|footballclub|\bfc\b/ig,"");
  return aliases[x]||x;
};
const teamMatch=(a:any,b:any)=>{
  const x=canon(a),y=canon(b);
  if(!x||!y)return false;
  if(x===y)return true;
  if(Math.min(x.length,y.length)>=3&&(x.includes(y)||y.includes(x)))return true;
  const xs=new Set(Array.from(x)),ys=new Set(Array.from(y));
  let inter=0;
  for(const ch of xs)if(ys.has(ch))inter++;
  return inter/Math.max(xs.size,ys.size)>=0.8;
};

function decodeEntities(s:string){
  return s.replace(/&nbsp;|&#160;/gi," ").replace(/&amp;/gi,"&").replace(/&quot;/gi,'"')
    .replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,"<").replace(/&gt;/gi,">")
    .replace(/&#(\d+);/g,(_:string,n:string)=>String.fromCharCode(Number(n)));
}
function htmlText(s:string){
  return decodeEntities(
    s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi," ")
     .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi," ")
     .replace(/<br\s*\/?>/gi,"\n")
     .replace(/<\/(?:p|div|li|tr|table|section|header|footer)>/gi,"\n")
     .replace(/<[^>]+>/g," ")
  ).replace(/[ \t]+/g," ").replace(/\n\s+/g,"\n").trim();
}
function cellText(s:string){
  return decodeEntities(
    s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi," ")
     .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi," ")
     .replace(/<br\s*\/?>/gi," ")
     .replace(/<[^>]+>/g," ")
  ).replace(/\s+/g," ").trim();
}
function tableRows(html:string){
  const tables:string[][][]=[];
  for(const tm of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)){
    const rows:string[][]=[];
    for(const rm of tm[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)){
      const cells:string[]=[];
      for(const cm of rm[1].matchAll(/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)){
        cells.push(cellText(cm[1]));
      }
      if(cells.length)rows.push(cells);
    }
    if(rows.length)tables.push(rows);
  }
  return tables;
}
function numberValue(v:any){
  const s=String(v??"").replace(/,/g,"").replace(/%/g,"").trim();
  if(!s||s==="-")return null;
  const n=Number(s);
  return Number.isFinite(n)?n:null;
}
function parse7m(html:string){
  const marks=[...html.matchAll(/第\s*(20\d{5,6})\s*期\s*开售时间：([0-9/]+\s+[0-9:]+)\s*停售时间：([0-9/]+\s+[0-9:]+)/g)];
  const out:any[]=[];
  for(let i=0;i<marks.length;i++){
    const m=marks[i];
    const start=m.index||0;
    const end=i+1<marks.length?(marks[i+1].index||html.length):html.length;
    const block=html.slice(start,end);
    const fs:any[]=[];
    for(const tr of block.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)){
      const c=[...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(x=>strip(x[1]));
      if(c.length>=6&&/^\d{2}$/.test(c[0])&&/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}$/.test(c[2])){
        fs.push({seq:+c[0],league:c[1],kickoff:c[2],home:c[3],away:c[5]});
      }
    }
    const raw=m[1],issue=raw.startsWith("20")?raw.slice(2):raw;
    out.push({issue,sale_start:m[2],sale_end:m[3],fixtures:fs.slice(0,14)});
  }
  return out;
}
function isoBjt(s:string){
  if(!s)return null;
  const z=String(s).trim().replace(/\//g,"-");
  const [d,t="00:00:00"]=z.split(/\s+/);
  return d+"T"+t+"+08:00";
}
function bjtDate(d:any){
  return new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(d));
}
function bjtNowText(){
  const ps=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).formatToParts(new Date());
  const o:any={};
  for(const p of ps)o[p.type]=p.value;
  return o.year+"-"+o.month+"-"+o.day+" "+o.hour+":"+o.minute+":"+o.second;
}
function uniqueMatchIds(html:string){
  const out:string[]=[],seen=new Set<string>();
  for(const m of html.matchAll(/\/soccer\/match\/(\d+)\//g)){
    const id=m[1];
    if(!seen.has(id)){seen.add(id);out.push(id);}
  }
  return out;
}
function pageTitle(html:string){
  return cellText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]??""));
}
function parseIdentity(html:string){
  const title=pageTitle(html);
  let m=title.match(/交易盈亏\s*[-－_:：]?\s*(.+?)\s*vs\s*(.+?)\s*[-－_|｜]/i);
  if(!m){
    const text=htmlText(html).slice(0,1800);
    m=text.match(/交易盈亏\s*[-－_:：]?\s*([^\n]{2,30}?)\s*vs\s*([^\n]{2,30}?)(?:\s*[-－_|｜]|\s+(?:欧|亚|竞足|单场|14场|开通))/i);
  }
  if(!m)return null;
  return {home:m[1].trim(),away:m[2].trim()};
}
function parseOkoooKickoff(html:string){
  const text=htmlText(html);
  const m=text.match(/(?:^|\s)(\d{2})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?:\s|$)/);
  if(!m)return null;
  return Date.UTC(2000+Number(m[1]),Number(m[2])-1,Number(m[3]),Number(m[4])-8,Number(m[5]),0,0);
}
function parseBehavior(html:string,expectedHome:string,expectedAway:string){
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

  const pickRows=(rows:string[][])=>rows.filter(c=>{
    if(!c.length)return false;
    const name=c[0];
    return teamMatch(name,expectedHome)||teamMatch(name,expectedAway)||/平局|^平$/.test(name);
  });

  const tx=pickRows(txTable),idx=pickRows(idxTable);
  if(tx.length<3||idx.length<3)return null;

  const role=(name:string)=>teamMatch(name,expectedHome)?"home":teamMatch(name,expectedAway)?"away":/平局|^平$/.test(name)?"draw":null;
  const txRows:any[]=[],idxRows:any[]=[];

  for(const c of tx){
    const r=role(c[0]);
    if(!r||c.length<13)continue;
    txRows.push({
      role:r,
      team:r==="draw"?"平局":r==="home"?expectedHome:expectedAway,
      bfOdds:numberValue(c[5]),bfVolume:numberValue(c[6]),bfProfitLoss:numberValue(c[7]),
      jcOdds:numberValue(c[8]),jcSavedVolume:numberValue(c[9]),jcProfitLoss:numberValue(c[10]),
      savedPopularity:numberValue(c[11]),doerPct:numberValue(c[12])
    });
  }
  for(const c of idx){
    const r=role(c[0]);
    if(!r||c.length<12)continue;
    idxRows.push({
      role:r,
      team:r==="draw"?"平局":r==="home"?expectedHome:expectedAway,
      avgOdds:numberValue(c[1]),avgProb:numberValue(c[2]),
      bfShare:numberValue(c[3]),jcSavedShare:numberValue(c[4]),northShare:numberValue(c[5]),
      bfHotCold:numberValue(c[6]),jcHotCold:numberValue(c[7]),
      bfMarketIndex:numberValue(c[8]),jcMarketIndex:numberValue(c[9]),
      bfProfitIndex:numberValue(c[10]),jcProfitIndex:numberValue(c[11])
    });
  }

  const rs=(a:any[])=>new Set(a.map(x=>x.role));
  const a=rs(txRows),b=rs(idxRows);
  if(!["home","draw","away"].every(x=>a.has(x)&&b.has(x)))return null;

  const sortOrder:any={home:0,draw:1,away:2};
  txRows.sort((x,y)=>sortOrder[x.role]-sortOrder[y.role]);
  idxRows.sort((x,y)=>sortOrder[x.role]-sortOrder[y.role]);

  const scaleSource=[htmlText(html),...tables.flatMap(rows=>rows.flat())]
    .join("\n")
    .replace(/[\u00a0\u2000-\u200b\u3000]/g," ")
    .replace(/[ \t]+/g," ");
  const scale=
    scaleSource.match(/本场比赛\s*必发交易规模\s*(?:为|[:：])?\s*(较大|适中|较小)/)?.[1]??
    scaleSource.match(/必发交易规模\s*(?:为|[:：])?\s*(较大|适中|较小)/)?.[1]??
    null;

  return {
    exchangeScale:scale,
    transactionRows:txRows.map(({role,...x})=>x),
    indexRows:idxRows.map(({role,...x})=>x)
  };
}
async function getHtml(url:string,timeout=12000){
  let last:any=null;
  for(let attempt=0;attempt<3;attempt++){
    const c=new AbortController();
    const timer=setTimeout(()=>c.abort(),timeout);
    try{
      const r=await fetch(url,{
        headers:{...WEB_HEADERS,referer:"https://www.okooo.com/jingcai/"},
        signal:c.signal,
        redirect:"follow"
      });
      if(!r.ok){
        last=new Error("HTTP_"+r.status);
        if([403,405,408,425,429,500,502,503,504].includes(r.status)&&attempt<2){
          const wait=[403,405,429].includes(r.status)?3000*(attempt+1):800*(attempt+1);
          await new Promise(z=>setTimeout(z,wait));
          continue;
        }
        throw last;
      }
      const buf=await r.arrayBuffer();
      const ct=String(r.headers.get("content-type")??"").toLowerCase();
      const declared=(ct.match(/charset=([^;\s]+)/)?.[1]??"").toLowerCase();
      const preferred=/gb2312|gbk|gb18030/.test(declared)?"gb18030":"utf-8";
      let txt=new TextDecoder(preferred).decode(buf);
      if(preferred==="utf-8"&&(txt.match(/�/g)||[]).length>3){
        txt=new TextDecoder("gb18030").decode(buf);
      }
      return txt;
    }catch(e){
      last=e;
      if(attempt<2)await new Promise(z=>setTimeout(z,1200*(attempt+1)));
    }finally{
      clearTimeout(timer);
    }
  }
  throw last??new Error("FETCH_FAILED");
}

async function get7mHtml(url:string,timeout=15000){
  const c=new AbortController();
  const timer=setTimeout(()=>c.abort(),timeout);
  try{
    const r=await fetch(url,{headers:WEB_HEADERS,signal:c.signal,redirect:"follow"});
    if(!r.ok)throw new Error("7M_HTTP_"+r.status);
    const buf=await r.arrayBuffer();
    return new TextDecoder("gb18030").decode(buf);
  }finally{
    clearTimeout(timer);
  }
}


function devigOdds(h:any,d:any,a:any){
  const vals=[Number(h),Number(d),Number(a)];
  if(vals.some(v=>!Number.isFinite(v)||v<=1))return null;
  const inv=vals.map(v=>1/v);
  const sum=inv.reduce((x,y)=>x+y,0);
  return {home:inv[0]/sum,draw:inv[1]/sum,away:inv[2]/sum};
}
function parseOkoooIssueFixtures(html:string){
  const out:any[]=[];
  for(const m of html.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi)){
    const attrs=m[1],body=m[2];
    const sm=attrs.match(/\bid=["']tr(\d{1,2})["']/i);
    if(!sm)continue;
    const seq=Number(sm[1]);
    if(!(seq>=1&&seq<=14))continue;
    const league=cellText(body.match(/<a[^>]*class=["'][^"']*jsLeagueName[^"']*["'][^>]*>([\s\S]*?)<\/a>/i)?.[1]??"");
    const time=cellText(body.match(/title=["']比赛时间[:：]\s*([^"']+)["']/i)?.[1]??"");
    const home=expandTeam(cellText(body.match(/<span[^>]*class=["'][^"']*homename[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1]??""));
    const away=expandTeam(cellText(body.match(/<span[^>]*class=["'][^"']*awayname[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1]??""));
    const oid=body.match(/\/soccer\/match\/(\d+)\/odds\//i)?.[1]??null;
    const odds=[...body.matchAll(/<em[^>]*class=["'][^"']*pltxt[^"']*["'][^>]*>\s*([0-9.]+)\s*<\/em>/gi)]
      .map(x=>Number(x[1])).filter(Number.isFinite);
    const kickoffIso=time?isoBjt(time):null;
    if(home&&away&&oid&&kickoffIso){
      out.push({
        seq,league:league||"澳客14场",kickoff:time,home,away,kickoffIso,oid,
        issueOdds:odds.length>=3?{home:odds[0],draw:odds[1],away:odds[2]}:null
      });
    }
  }
  return out.sort((a,b)=>a.seq-b.seq);
}

function probOrder(p:any){
  return [["主胜",Number(p.home)],["平",Number(p.draw)],["客胜",Number(p.away)]].sort((a:any,b:any)=>b[1]-a[1]);
}
function risk(top:string,p:any){
  const pt=top==="主胜"?p.home:top==="平"?p.draw:p.away;
  const hur=pt>=.6?"绿":pt>=.5?"黄":"红";
  if(top==="平")return {hur,dtr:"NA",dlr:"NA"};
  const dr=p.draw,op=top==="主胜"?p.away:p.home,tail=1-pt;
  const g=(a:number,s:number)=>a>=.25&&s>=.6?"红":a>=.20&&s>=.5?"黄":"绿";
  return {hur,dtr:g(dr,tail?dr/tail:0),dlr:g(op,tail?op/tail:0)};
}
function confidence(pt:number,g:number){
  return pt>=.65&&g>=.25?"高":pt>=.58&&g>=.15?"中高":pt>=.5&&g>=.08?"中":"低";
}
function singleElig(conf:string,dq:string,hur:string,dtr:string,dlr:string){
  if(!["DQ-A","DQ-B"].includes(dq)||[hur,dtr,dlr].includes("红"))return "禁止单选";
  if(conf==="高"&&hur==="绿"&&dtr==="绿"&&dlr==="绿")return "强单";
  if((conf==="高"||conf==="中高")&&hur!=="红"&&dtr!=="红"&&dlr!=="红")return "可单";
  return "弱单";
}
function oppCost(s:string){
  return s==="强单"?"LOW":s==="可单"?"MEDIUM":s==="弱单"?"HIGH":"PROHIBITIVE";
}
function maxIndex(a:number[]){
  return a.indexOf(Math.max(...a));
}
function behaviorDirection(b:any){
  if(!b||!Array.isArray(b.transactionRows)||!Array.isArray(b.indexRows)||b.transactionRows.length<3||b.indexRows.length<3){
    return {top:null,strength:null,margin:0};
  }
  const nums=(list:any[],key:string)=>[0,1,2].map(i=>{
    const v=Number(list[i]?.[key]);
    return Number.isFinite(v)?v:0;
  });
  const doer=nums(b.transactionRows,"doerPct");
  const bfShare=nums(b.indexRows,"bfShare");
  const jcShare=nums(b.indexRows,"jcSavedShare");
  const avgProb=nums(b.indexRows,"avgProb");
  const bfHot=nums(b.indexRows,"bfHotCold");
  const jcHot=nums(b.indexRows,"jcHotCold");
  const score=[0,0,0];
  const addTop=(a:number[],w:number)=>{
    const i=maxIndex(a);
    if(i>=0)score[i]+=w;
  };
  addTop(avgProb,1);
  addTop(jcShare,2);
  addTop(doer,1);
  addTop(bfShare,b.exchangeScale==="较小"?1:2);
  const bf=maxIndex(bfHot),jc=maxIndex(jcHot);
  if(bf>=0&&bfHot[bf]>=15)score[bf]+=b.exchangeScale==="较小"?0.5:1;
  if(jc>=0&&jcHot[jc]>=15)score[jc]+=1;
  const rank=score.map((v,i)=>({i,v})).sort((a,c)=>c.v-a.v);
  const margin=(rank[0]?.v??0)-(rank[1]?.v??0);
  return {
    top:["主胜","平","客胜"][rank[0]?.i]??null,
    strength:margin>=3?"强":margin>=1.5?"中":"弱",
    margin
  };
}
function pairCode(a:string,b:string){
  const s=new Set([a,b]);
  if(s.has("主胜")&&s.has("平"))return "31";
  if(s.has("客胜")&&s.has("平"))return "10";
  if(s.has("主胜")&&s.has("客胜"))return "30";
  return null;
}
function pickCode(a:string){
  return a==="主胜"?"3":a==="平"?"1":a==="客胜"?"0":null;
}

Deno.serve(async(req:Request)=>{
  const ik=req.headers.get("x-hao-internal-key")||"";
  const {data:sec}=await sb.from("hao_internal_secrets_v01")
    .select("secret_value").eq("secret_name","cron_internal_v01").maybeSingle();
  if(!sec?.secret_value||ik!==sec.secret_value){
    return Response.json({ok:false,error:"UNAUTHORIZED_INTERNAL_CALL"},{status:401});
  }

  try{
    const url=new URL(req.url);
    const want=url.searchParams.get("issue");
    const dry=url.searchParams.get("dry_run")==="1";
    const now=new Date(),nowMs=now.getTime(),nowIso=now.toISOString();

    let fixtureSource="7M_LIVE";
    let issue="";
    let fixtures:any[]=[];
    let okoooIds:string[]=[];
    const behaviorBySeq=new Map<number,any>();
    const behaviorIssues:any[]=[];

    let periods:any[]=[];
    try{
      const fixtureHtml=await get7mHtml(FIXTURE_URL,15000);
      periods=parse7m(fixtureHtml).filter((x:any)=>x.fixtures.length===14);
    }catch(e){
      behaviorIssues.push({scope:"fixture_discovery",source:"7M",status:"FETCH_OR_PARSE_FAILED",error:String(e).slice(0,120)});
    }

    let period:any=null;
    if(want){
      period=periods.find((x:any)=>x.issue===want)||null;
    }else{
      const nowBjt=bjtNowText();
      period=periods.find((x:any)=>
        String(x.sale_start).replace(/\//g,"-")<=nowBjt &&
        String(x.sale_end).replace(/\//g,"-")>nowBjt
      )||null;
    }

    if(period){
      issue=String(period.issue);
      fixtures=period.fixtures.map((f:any)=>({...f,kickoffIso:isoBjt(f.kickoff)}));
      if(fixtures.length!==14||fixtures.some((f:any)=>!f.kickoffIso)){
        return Response.json({ok:false,error:"R9_KICKOFF_UNCONFIRMED",issue},{status:409});
      }
      const issueHtml=await getHtml("https://www.okooo.com/zucai/"+issue+"/",15000);
      okoooIds=uniqueMatchIds(issueHtml).slice(0,14);
    }else if(want){
      issue=String(want);
      fixtureSource="OKOOO_ISSUE_LIVE";
      const issueHtml=await getHtml("https://www.okooo.com/zucai/"+issue+"/",15000);
      const allOkoooIds=uniqueMatchIds(issueHtml);
      const parsedIssueFixtures=parseOkoooIssueFixtures(issueHtml);
      okoooIds=parsedIssueFixtures.map((x:any)=>String(x.oid));
      if(url.searchParams.get("fixture_debug")==="1"){
        return Response.json({
          ok:true,issue,okooo_candidate_ids:allOkoooIds.length,
          parsed_fixtures:parsedIssueFixtures
        },{headers:{"Cache-Control":"no-store"}});
      }
      if(parsedIssueFixtures.length!==14||okoooIds.length!==14){
        return Response.json({
          ok:false,error:"OKOOO_R9_14_UNCONFIRMED",issue,
          okooo_candidate_ids:allOkoooIds.length,
          parsed_fixture_count:parsedIssueFixtures.length,
          seven_m_available_issues:periods.slice(0,8).map((x:any)=>x.issue)
        },{status:409});
      }
      fixtures=parsedIssueFixtures;
    }else{
      return Response.json({
        ok:false,error:"NO_ACTIVE_R9_ISSUE",
        seven_m_available_issues:periods.slice(0,8).map((x:any)=>x.issue)
      },{status:409});
    }

    for(let offset=0;offset<fixtures.length;offset+=1){
      const chunk=fixtures.slice(offset,offset+1);
      const got=await Promise.all(chunk.map(async(f:any)=>{
        if(behaviorBySeq.has(f.seq))return {seq:f.seq,status:"PRELOADED"};
        const oid=okoooIds[f.seq-1]||null;
        const koMs=Date.parse(f.kickoffIso);
        if(!oid)return {seq:f.seq,status:"NO_OKOOO_ID"};
        if(!(nowMs<koMs-30000))return {seq:f.seq,status:"FROZEN",oid};

        const sourceUrl="https://www.okooo.com/soccer/match/"+oid+"/exchanges/";
        try{
          const html=await getHtml(sourceUrl,12000);
          const ident=parseIdentity(html);
          const okKick=parseOkoooKickoff(html);

          if(!ident||!teamMatch(ident.home,f.home)||!teamMatch(ident.away,f.away)){
            return {seq:f.seq,status:"IDENTITY_MISMATCH",oid,seen:ident};
          }
          if(!okKick||Math.abs(okKick-koMs)>15*60_000){
            return {seq:f.seq,status:"KICKOFF_MISMATCH",oid,okoooKickoff:okKick?new Date(okKick).toISOString():null};
          }
          const parsed=parseBehavior(html,f.home,f.away);
          if(!parsed)return {seq:f.seq,status:"PARSE_INCOMPLETE",oid};

          return {seq:f.seq,status:"OK",oid,sourceUrl,...parsed};
        }catch(e){
          return {seq:f.seq,status:"FETCH_ERROR",oid,error:String(e).slice(0,120)};
        }
      }));

      for(const x of got){
        if(x.status==="OK")behaviorBySeq.set(x.seq,x);
        else if(x.status!=="PRELOADED")behaviorIssues.push(x);
      }
      if(offset+2<fixtures.length)await new Promise(z=>setTimeout(z,1200));
    }

    const saleDates=[...new Set(fixtures.map((f:any)=>bjtDate(f.kickoffIso)))];
    const hjPoolDates=[...new Set(saleDates.flatMap((d:string)=>{
      const prev=new Date(new Date(d+"T00:00:00+08:00").getTime()-86400000);
      return [d,bjtDate(prev)];
    }))];
    const {data:runs,error:runLoadError}=await sb.from("hao_console_model_runs")
      .select("id,pool_date,run_time")
      .eq("model_name","豪竞3.8")
      .eq("model_version","3.8")
      .eq("pool_kind","HJ")
      .in("pool_date",hjPoolDates)
      .lte("run_time",nowIso)
      .order("run_time",{ascending:false})
      .limit(300);
    if(runLoadError)throw runLoadError;

    const latestRun=new Map<string,number>();
    for(const r of runs||[]){
      if(!latestRun.has(String(r.pool_date)))latestRun.set(String(r.pool_date),Number(r.id));
    }

    let hjPred:any[]=[];
    const runIds=[...latestRun.values()];
    if(runIds.length){
      const {data,error}=await sb.from("hao_console_predictions").select("*").in("run_id",runIds);
      if(error)throw error;
      hjPred=data||[];
    }

    const {data:r9William,error:r9WilliamError}=await sb.from("r9_market_sina_2026")
      .select("*").eq("issue_no",issue).order("seq_no");
    if(r9WilliamError)throw r9WilliamError;
    const williamBySeq=new Map<number,any>();
    for(const w of r9William||[]){
      const seq=Number(w.seq_no);
      if(!williamBySeq.has(seq)||String(w.imported_at||"")>String(williamBySeq.get(seq)?.imported_at||"")){
        williamBySeq.set(seq,w);
      }
    }

    const hjByDate=new Map<string,any[]>();
    for(const p of hjPred){
      const d=bjtDate(p.kickoff_bjt);
      if(!hjByDate.has(d))hjByDate.set(d,[]);
      hjByDate.get(d)!.push(p);
    }

    const rows:any[]=[];

    for(const f of fixtures){
      const ko=new Date(f.kickoffIso);
      const day=bjtDate(f.kickoffIso);
      const hp=(hjByDate.get(day)||[])
        .filter((p:any)=>teamMatch(f.home,p.home_team)&&teamMatch(f.away,p.away_team))
        .sort((a:any,b:any)=>String(b.frozen_at||"").localeCompare(String(a.frozen_at||"")))[0]||null;
      const b=behaviorBySeq.get(f.seq)||null;
      const wr=williamBySeq.get(Number(f.seq))||null;

      let p:any=null,top1:string|null=null,second:string|null=null;
      let dq="DQ-D",hur:any=null,dtr:any=null,dlr:any=null,conf="未确认";
      let baseSource="UNCONFIRMED",hj38PredictionId=null,hj38Upset:any=null;

      if(hp?.top1&&hp?.frozen_at&&new Date(hp.frozen_at)<ko){
        p=hp.source_status?.p_final||hp.source_status?.p_raw||null;
        top1=hp.top1;
        second=hp.second_pick;
        dq=hp.dq;
        hur=hp.hur;
        dtr=hp.dtr;
        dlr=hp.dlr;
        conf=hp.confidence_label;
        baseSource="HJ38_FORMAL_OVERLAP";
        hj38PredictionId=hp.id;
        hj38Upset=hp.source_status?.upset_warning||null;
      }else if(
        wr &&
        String(wr.source_quality||"")==="A-SINA_WILLIAM_SAME_COMPANY" &&
        String(wr.timing_quality||"")==="PREMATCH_ARTICLE_SNAPSHOT" &&
        Number(wr.william_latest_home)>1 &&
        Number(wr.william_latest_draw)>1 &&
        Number(wr.william_latest_away)>1 &&
        wr.imported_at &&
        new Date(wr.imported_at)<ko
      ){
        p=devigOdds(wr.william_latest_home,wr.william_latest_draw,wr.william_latest_away);
        if(p){
          const rk=probOrder(p);
          top1=String(rk[0][0]);
          second=String(rk[1][0]);
          dq="DQ-B";
          const rr=risk(top1,p);
          hur=rr.hur;
          dtr=rr.dtr;
          dlr=rr.dlr;
          conf=confidence(Number(rk[0][1]),Number(rk[0][1])-Number(rk[1][1]));
          baseSource="R9_WILLIAM_PREMATCH";
        }
      }else if(b?.indexRows?.length>=3){
        const probs=b.indexRows.map((x:any)=>Number(x.avgProb)||0);
        const sum=probs.reduce((a:number,c:number)=>a+c,0)||100;
        p={home:probs[0]/sum,draw:probs[1]/sum,away:probs[2]/sum};
        const rk=probOrder(p);
        top1=String(rk[0][0]);
        second=String(rk[1][0]);
        dq=b.exchangeScale?"DQ-B":"DQ-C";
        const rr=risk(top1,p);
        hur=rr.hur;
        dtr=rr.dtr;
        dlr=rr.dlr;
        conf=confidence(Number(rk[0][1]),Number(rk[0][1])-Number(rk[1][1]));
        baseSource="OKOOO_99_MARKET_FALLBACK";
      }else if(f.issueOdds){
        p=devigOdds(f.issueOdds.home,f.issueOdds.draw,f.issueOdds.away);
        if(p){
          const rk=probOrder(p);
          top1=String(rk[0][0]);
          second=String(rk[1][0]);
          dq="DQ-C";
          const rr=risk(top1,p);
          hur=rr.hur;
          dtr=rr.dtr;
          dlr=rr.dlr;
          conf=confidence(Number(rk[0][1]),Number(rk[0][1])-Number(rk[1][1]));
          baseSource="OKOOO_ISSUE_ODDS_FALLBACK";
        }
      }

      const topIdx=top1==="主胜"?0:top1==="平"?1:top1==="客胜"?2:-1;
      const idx=b?.indexRows||[];
      const bd=behaviorDirection(b);
      const issueMarketP=f.issueOdds?devigOdds(f.issueOdds.home,f.issueOdds.draw,f.issueOdds.away):null;
      const marketIdx=idx.length>=3?maxIndex(idx.map((x:any)=>Number(x.avgProb)||0)):-1;
      const issueRank=issueMarketP?probOrder(issueMarketP):[];
      const marketTop=marketIdx>=0?["主胜","平","客胜"][marketIdx]:(issueRank[0]?.[0]??null);
      const marketTopProb=marketIdx>=0?Number(idx[marketIdx]?.avgProb):
        (issueRank[0]?Number(issueRank[0][1])*100:null);

      const topAvg=topIdx>=0?Number(idx[topIdx]?.avgProb):NaN;
      const topBf=topIdx>=0?Number(idx[topIdx]?.bfShare):NaN;
      const topJc=topIdx>=0?Number(idx[topIdx]?.jcSavedShare):NaN;
      const topHeat=Math.max(
        topIdx>=0?Number(idx[topIdx]?.bfHotCold):-999,
        topIdx>=0?Number(idx[topIdx]?.jcHotCold):-999
      );
      const topProfit=Math.min(
        topIdx>=0?Number(idx[topIdx]?.bfProfitIndex):999,
        topIdx>=0?Number(idx[topIdx]?.jcProfitIndex):999
      );
      const gap=Number.isFinite(topAvg)
        ?Math.max(Number.isFinite(topBf)?topBf-topAvg:-999,Number.isFinite(topJc)?topJc-topAvg:-999)
        :null;

      const fundAnomaly=gap!==null&&gap>=5&&topHeat>=15&&topProfit<=-15;
      const popularityDivergence=gap!==null&&gap>=10;
      const trustedScale=["适中","较大"].includes(String(b?.exchangeScale||""));
      const behaviorAdverse=!!(top1&&bd.top&&bd.top!==top1&&["中","强"].includes(String(bd.strength||"")));
      const marketConflict=!!(top1&&marketTop&&marketTop!==top1);
      const tier=String(hj38Upset?.display_tier||hj38Upset?.displayTier||"");

      let coldScore=0;
      const coldReasons:string[]=[];
      if(tier==="强风险信号"){
        coldScore+=4;
        coldReasons.push("豪竞3.8强风险信号");
      }else if(tier==="重点风险"){
        coldScore+=3;
        coldReasons.push("豪竞3.8重点风险");
      }
      if(behaviorAdverse){
        coldScore+=3;
        coldReasons.push("澳客资金方向反向");
      }
      if(fundAnomaly&&trustedScale){
        coldScore+=2;
        coldReasons.push("资金结构异常");
      }
      if(marketConflict){
        coldScore+=2;
        coldReasons.push("99家方向与Top1分歧");
      }
      if(popularityDivergence){
        coldScore+=1;
        coldReasons.push("热门过热");
      }
      if(b?.exchangeScale==="较大"&&fundAnomaly){
        coldScore+=1;
        coldReasons.push("较大交易规模异常");
      }

      const coldLevel=coldScore>=5?"高":coldScore>=3?"中":"低";
      const rawGap=(p&&top1&&second)
        ?Math.abs((top1==="主胜"?Number(p.home):top1==="平"?Number(p.draw):Number(p.away))-
                  (second==="主胜"?Number(p.home):second==="平"?Number(p.draw):Number(p.away)))
        :0;
      let sing="禁止单选";
      if(top1&&p){
        const hasRed=[hur,dtr,dlr].includes("红");
        const allGreen=[hur,dtr,dlr].every(x=>x==="绿"||x==="NA");
        const topProb=top1==="主胜"?Number(p.home):top1==="平"?Number(p.draw):Number(p.away);
        if(dq==="DQ-D"||hasRed){
          sing="禁止单选";
        }else if(allGreen&&topProb>=0.60){
          sing="强单";
        }else if(topProb>=0.58&&rawGap>=0.15){
          sing="可单";
        }else{
          sing="弱单";
        }
      }
      if(coldLevel==="高"){
        sing="禁止单选";
      }else if(coldLevel==="中"&&sing!=="强单"){
        sing="弱单";
      }

      const pt=p&&top1
        ?(top1==="主胜"?Number(p.home):top1==="平"?Number(p.draw):Number(p.away))
        :null;
      const secondProb=p&&second
        ?(second==="主胜"?Number(p.home):second==="平"?Number(p.draw):Number(p.away))
        :null;

      rows.push({
        seq:f.seq,league:f.league,home:f.home,away:f.away,kickoff:f.kickoffIso,
        top1,second,p,dq,hur,dtr,dlr,conf,sing,opp:oppCost(sing),pt,secondProb,
        baseSource,hj38PredictionId,hj38Upset,b,
        marketTop,marketTopProb,behaviorTop:bd.top,behaviorStrength:bd.strength,
        popularityGap:gap,
        topHeat:Number.isFinite(topHeat)?topHeat:null,
        topProfitIndex:Number.isFinite(topProfit)?topProfit:null,
        fundAnomaly,popularityDivergence,coldScore,coldLevel,coldReasons
      });
    }

    const dqRank=(x:string)=>x==="DQ-A"?0:x==="DQ-B"?1:x==="DQ-C"?2:3;
    const oppRank=(x:string)=>x==="LOW"?0:x==="MEDIUM"?1:x==="HIGH"?2:3;

    const sorted=[...rows].sort((a,b)=>{
      const va=[
        a.p?0:1,
        a.dq==="DQ-D"?1:0,
        a.coldLevel==="高"?1:0,
        a.coldScore,
        ((["红","黄"].includes(a.dtr)&&["红","黄"].includes(a.dlr))?1:0),
        a.hur==="红"?1:0,
        (a.hur==="红"?2:a.hur==="黄"?1:0)+(a.dtr==="红"?2:a.dtr==="黄"?1:0)+(a.dlr==="红"?2:a.dlr==="黄"?1:0),
        -(a.pt??-1),
        -((a.pt??0)-(a.secondProb??0)),
        oppRank(a.opp),
        dqRank(a.dq),
        a.seq
      ];
      const vb=[
        b.p?0:1,
        b.dq==="DQ-D"?1:0,
        b.coldLevel==="高"?1:0,
        b.coldScore,
        ((["红","黄"].includes(b.dtr)&&["红","黄"].includes(b.dlr))?1:0),
        b.hur==="红"?1:0,
        (b.hur==="红"?2:b.hur==="黄"?1:0)+(b.dtr==="红"?2:b.dtr==="黄"?1:0)+(b.dlr==="红"?2:b.dlr==="黄"?1:0),
        -(b.pt??-1),
        -((b.pt??0)-(b.secondProb??0)),
        oppRank(b.opp),
        dqRank(b.dq),
        b.seq
      ];
      for(let i=0;i<va.length;i++){
        if(va[i]!==vb[i])return va[i]-vb[i];
      }
      return 0;
    });

    sorted.forEach((r,i)=>{
      r.keepRank=i+1;
      r.kept=i<9;
    });

    const bySeq=new Map(sorted.map(r=>[r.seq,r]));

    for(const r of rows){
      const ranked=bySeq.get(r.seq);
      r.keepRank=ranked.keepRank;
      r.kept=ranked.kept;

      if(!r.kept||!r.top1||!r.p){
        r.ticketRole=r.kept?"未确认":"舍";
        r.ticketPick=null;
        r.coverage=null;
        continue;
      }

      const dRisk=["红","黄"].includes(r.dtr);
      const lRisk=["红","黄"].includes(r.dlr);
      let alt:string|null=r.second;

      if(r.coldScore>=3){
        if(r.behaviorTop&&r.behaviorTop!==r.top1)alt=r.behaviorTop;
        else if(r.marketTop&&r.marketTop!==r.top1)alt=r.marketTop;
      }

      const isSingle=
        ["强单","可单"].includes(r.sing) &&
        r.hur==="绿" &&
        r.dtr==="绿" &&
        r.dlr==="绿" &&
        r.coldScore<3;

      const isTriple=!isSingle&&dRisk&&lRisk&&r.top1!=="平";

      if(isSingle){
        r.ticketRole="单";
        r.ticketPick=pickCode(r.top1);
        r.coverage=r.pt;
      }else if(isTriple){
        r.ticketRole="三";
        r.ticketPick="310";
        r.coverage=1;
      }else{
        if(dRisk&&!lRisk)alt="平";
        else if(lRisk&&!dRisk)alt=r.top1==="主胜"?"客胜":r.top1==="客胜"?"主胜":alt;
        if(!alt||alt===r.top1)alt=r.second;

        r.ticketRole="双";
        r.ticketPick=alt?pairCode(r.top1,alt):null;
        const ap=alt==="主胜"?Number(r.p.home):alt==="平"?Number(r.p.draw):alt==="客胜"?Number(r.p.away):0;
        r.coverage=r.ticketPick?(r.pt+ap):null;
      }
    }

    const kept=rows.filter(r=>r.kept);
    const singles=kept.filter(r=>r.ticketRole==="单").length;
    const doubles=kept.filter(r=>r.ticketRole==="双").length;
    const triples=kept.filter(r=>r.ticketRole==="三").length;
    const structural=kept.length===9&&kept.every(r=>r.ticketPick);
    const combos=structural?Math.pow(2,doubles)*Math.pow(3,triples):0;
    const cost=combos*2;
    const ticketStatus=structural&&combos<=32?"READY_SHADOW":structural?"PASS_BUDGET":"PASS_DATA";

    const retained=[...kept].sort((a,b)=>a.keepRank-b.keepRank).map(r=>pad(r.seq));
    const discarded=rows.filter(r=>!r.kept).sort((a,b)=>a.keepRank-b.keepRank).map(r=>pad(r.seq));
    const ticket:any={};
    for(const r of kept)if(r.ticketPick)ticket[pad(r.seq)]=r.ticketPick;

    const summary={
      rule_version:RULE_VERSION,
      issue,
      fixture_source:fixtureSource,
      okooo_candidate_ids:okoooIds.length,
      okooo_fixture_verified:fixtures.length,
      okooo_verified:behaviorBySeq.size,
      william_verified:williamBySeq.size,
      hj38_overlap:rows.filter(r=>r.baseSource==="HJ38_FORMAL_OVERLAP").length,
      confirmed:rows.filter(r=>r.p&&r.top1).length,
      retained_9:retained,
      discarded_5:discarded,
      ticket_310:ticket,
      singles,doubles,triples,
      combination_count:combos,
      cost_rmb:cost,
      ticket_status:ticketStatus,
      behavior_issues:behaviorIssues,
      history_rewrite:false,
      result_used:false,
      formal_effect:false
    };

    if(dry){
      return Response.json({
        ok:true,
        dry_run:true,
        ...summary,
        rows:rows.sort((a,b)=>a.seq-b.seq).map(r=>({
          seq:pad(r.seq),
          home:r.home,
          away:r.away,
          top1:r.top1,
          second:r.second,
          base_source:r.baseSource,
          dq:r.dq,
          cold_score:r.coldScore,
          cold_level:r.coldLevel,
          cold_reasons:r.coldReasons,
          market_top1:r.marketTop,
          behavior_top1:r.behaviorTop,
          keep_rank:r.keepRank,
          kept:r.kept,
          ticket_role:r.ticketRole,
          ticket_pick:r.ticketPick
        }))
      },{headers:{"Cache-Control":"no-store"}});
    }

    const {data:shadowRun,error:shadowRunError}=await sb.from("hao_r9_okooo_shadow_runs_v01").insert({
      issue_no:issue,
      rule_version:RULE_VERSION,
      fixture_source:fixtureSource,
      status:ticketStatus,
      total_matches:14,
      confirmed_matches:summary.confirmed,
      hj38_overlap:summary.hj38_overlap,
      okooo_verified:summary.okooo_verified,
      retained_9:retained,
      discarded_5:discarded,
      ticket_310:ticket,
      combination_count:combos,
      cost_rmb:cost,
      ticket_status:ticketStatus,
      base_model_revision_id:197,
      summary
    }).select("id").single();

    if(shadowRunError||!shadowRun)throw shadowRunError||new Error("SHADOW_RUN_INSERT_FAILED");

    const payload=rows.map(r=>({
      shadow_run_id:shadowRun.id,
      issue_no:issue,
      seq_no:r.seq,
      competition:r.league,
      home_team:r.home,
      away_team:r.away,
      kickoff_at:r.kickoff,
      top1:r.top1,
      second_pick:r.second,
      p_home:r.p?.home??null,
      p_draw:r.p?.draw??null,
      p_away:r.p?.away??null,
      confidence_label:r.conf,
      dq:r.dq,
      hur:r.hur,
      dtr:r.dtr,
      dlr:r.dlr,
      base_source:r.baseSource,
      hj38_prediction_id:r.hj38PredictionId,
      hj38_upset:r.hj38Upset,
      okooo_match_id:r.b?.oid??null,
      okooo_source_url:r.b?.sourceUrl??null,
      exchange_scale:r.b?.exchangeScale??null,
      transaction_rows:r.b?.transactionRows??null,
      index_rows:r.b?.indexRows??null,
      market_top1:r.marketTop,
      market_top1_prob:r.marketTopProb,
      behavior_top1:r.behaviorTop,
      behavior_strength:r.behaviorStrength,
      popularity_gap:r.popularityGap,
      top_heat:r.topHeat,
      top_profit_index:r.topProfitIndex,
      fund_anomaly:r.fundAnomaly,
      popularity_divergence:r.popularityDivergence,
      cold_score:r.coldScore,
      cold_level:r.coldLevel,
      cold_reasons:r.coldReasons,
      keep_rank:r.keepRank,
      kept_in_9:r.kept,
      ticket_role:r.ticketRole,
      ticket_pick:r.ticketPick,
      coverage_probability:r.coverage,
      source_payload:{
        single_eligibility:r.sing,
        r9_william:williamBySeq.get(Number(r.seq))?{
          latest_home:williamBySeq.get(Number(r.seq)).william_latest_home,
          latest_draw:williamBySeq.get(Number(r.seq)).william_latest_draw,
          latest_away:williamBySeq.get(Number(r.seq)).william_latest_away,
          imported_at:williamBySeq.get(Number(r.seq)).imported_at,
          source_quality:williamBySeq.get(Number(r.seq)).source_quality
        }:null,
        single_opportunity_cost:r.opp,
        rule_version:RULE_VERSION,
        history_rewrite:false,
        result_used:false,
        formal_effect:false
      },
      captured_at:nowIso
    }));

    const {error:rowError}=await sb.from("hao_r9_okooo_shadow_v01").insert(payload);
    if(rowError)throw rowError;

    return Response.json({ok:true,shadow_run_id:shadowRun.id,...summary},{headers:{"Cache-Control":"no-store"}});
  }catch(e:any){
    console.error("HC24_R9_OKOOO_SHADOW_ERROR",e);
    return Response.json({ok:false,error:String(e?.message||e),rule_version:RULE_VERSION},{status:500});
  }
});
