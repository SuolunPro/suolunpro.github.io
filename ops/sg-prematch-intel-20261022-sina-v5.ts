import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {createClient} from "npm:@supabase/supabase-js@2.95.0";

const db=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{
  db:{schema:"ninety_core"},auth:{persistSession:false,autoRefreshToken:false}
});
const headers={"user-agent":"Mozilla/5.0 (compatible; SorenPrematchCache/1.0)","accept-language":"zh-CN,zh;q=0.9"};
function normalize(value:unknown){
  return String(value??"").toLowerCase()
    .replace(/利勒斯特罗姆/g,"利勒斯特")
    .replace(/莱赫波兹南|波兹南莱赫/g,"波兹南")
    .replace(/沙特阿拉伯/g,"沙特")
    .replace(/足球俱乐部|俱乐部|\bfootball club\b|\bfc\b/gi,"")
    .replace(/[\s·•.－—_()（）]/g,"").trim();
}
function htmlText(s:string){
  return s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi," ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi," ")
    .replace(/<[^>]+>/g," ")
    .replace(/&nbsp;|&#160;/gi," ")
    .replace(/&amp;/gi,"&")
    .replace(/&quot;/gi,'"')
    .replace(/&#39;|&apos;/gi,"'")
    .replace(/\s+/g," ").trim();
}
function structuredTeams(text:string){
  const re=/([^\s，。；：:（）()]{2,30})\s*[（(](主队|客队)[）)]/g;
  let home:string|null=null,away:string|null=null,m:RegExpExecArray|null;
  while((m=re.exec(text))!==null){
    if(m[2]==="主队"&&!home)home=m[1];
    if(m[2]==="客队"&&!away)away=m[1];
    if(home&&away)break;
  }
  return home&&away?{home,away}:null;
}
function sections(text:string){
  const out:string[]=[];
  for(const [label,re] of [
    ["主队有利",/（主队）[\s\S]{0,2000}?有利情报/],
    ["主队不利",/（主队）[\s\S]{0,4000}?不利情报/],
    ["客队有利",/（客队）[\s\S]{0,2000}?有利情报/],
    ["客队不利",/（客队）[\s\S]{0,4000}?不利情报/]
  ] as const){
    if(re.test(text))out.push(label);
  }
  if(/伤停|伤病|因伤|出战成疑|缺阵|缺席|停赛|禁赛/.test(text)){
    const point=text.search(/伤停|伤病|因伤|出战成疑|缺阵|缺席|停赛|禁赛/);
    const fact=text.slice(Math.max(0,point-35),point+130).trim();
    if(fact.length>=25)out.push("原文伤停信息："+fact);
  }
  const first=text.search(/有利情报|不利情报/);
  if(first>=0){
    const excerpt=text.slice(first,first+190).trim();
    if(excerpt.length>=40)out.push("赛前公开情报："+excerpt);
  }
  return [...new Set(out)].slice(0,5);
}
async function get(url:string,timeout=9000):Promise<Response>{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
  try{return await fetch(url,{headers,signal:controller.signal})}
  finally{clearTimeout(timer)}
}
Deno.serve(async(req:Request)=>{
  if(req.method!=="POST")return Response.json({ok:false,error:"METHOD_NOT_ALLOWED"},{status:405});
  const key=req.headers.get("x-ninety-collector-token")??"";
  if(key.length<32)return Response.json({ok:false,error:"UNAUTHORIZED"},{status:401});
  const {data:authorized,error:authError}=await db.rpc("soren_collector_token_valid_v1",{p_token:key});
  if(authError||authorized!==true)return Response.json({ok:false,error:"UNAUTHORIZED"},{status:401});
  try{
    const now=new Date(),nowIso=now.toISOString();
    const until=new Date(now.getTime()+72*3600*1000).toISOString();
    const {data:matches,error:me}=await db.from("soren_matches")
      .select("id,pool_date,match_no,home_team,away_team,kickoff_at")
      .gt("kickoff_at",nowIso).lte("kickoff_at",until).limit(100);
    if(me)throw me;
    const pool=matches??[];
    if(!pool.length)return Response.json({ok:true,status:"NO_FUTURE_MATCHES",published:0,matched:0,stored:0});
    const feedUrls=Array.from({length:12},(_,i)=>
      "https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2512&k=&num=50&page="+(i+1));
    const batches=await Promise.all(feedUrls.map(async url=>{
      try{const r=await get(url,9000);if(!r.ok)return [];const v=await r.json();return Array.isArray(v?.result?.data)?v.result.data:[]}
      catch{return []}
    }));
    const after=now.getTime()-72*3600*1000;
    const allowedUrl=/^https:\/\/sports\.sina\.com\.cn\/l\/20\d{2}-\d{2}-\d{2}\/doc-[a-z0-9-]+\.shtml$/i;
    const byUrl=new Map<string,Record<string,unknown>>();
    for(const v of batches.flat()){
      const title=String(v.title??""),url=String(v.url??"");
      const published=Number(v.ctime)*1000;
      if(!title.includes("[小炮APP]竞彩情报")||!allowedUrl.test(url)||
        !Number.isFinite(published)||published<after||published>now.getTime())continue;
      byUrl.set(url,{title,url,published});
    }
    let homepageCandidates=0;
    // Sina's editorial listing can contain current articles absent from its roll feed.
    if(byUrl.size<20){
      const fronts=await Promise.all([
        "https://lottery.sina.com.cn/",
        "https://sports.sina.com.cn/l/football/"
      ].map(async u=>{
        try{const r=await get(u,10000);return r.ok?await r.text():""}
        catch{return ""}
      }));
      const re=/<a\b[^>]*href=["'](https:\/\/sports\.sina\.com\.cn\/l\/20\d{2}-\d{2}-\d{2}\/doc-[a-z0-9-]+\.shtml)["'][^>]*>([\s\S]*?)<\/a>/gi;
      for(const html of fronts)for(const m of html.matchAll(re)){
        const title=htmlText(m[2]),url=m[1];
        if(!title.includes("[小炮APP]竞彩情报")||!allowedUrl.test(url))continue;
        if(!byUrl.has(url)){byUrl.set(url,{title,url,published:null,source:"sina_public_editorial"});homepageCandidates++}
      }
    }
    const stories=[...byUrl.values()].sort((a:any,b:any)=>Number(b.published??0)-Number(a.published??0)).slice(0,64);
    const saved:Record<string,unknown>[]=[];
    let newlyInserted=0;
    let fetchedOk=0,structured=0,matchedArticles=0;
    const failed:string[]=[];
    for(let i=0;i<stories.length;i+=8){
      const chunk=stories.slice(i,i+8);
      const fetched=await Promise.all(chunk.map(async story=>{
        try{
          const r=await get(String(story.url),12000);
          if(!r.ok)return {body:"",publishedAt:null};
          const html=await r.text();
          // China's Sina article comment includes "published at YYYY-MM-DD HH:MM:SS".
          const m=html.match(/<!--\s*\[\s*published at\s+(20\d{2}-\d\d-\d\d\s+\d\d:\d\d:\d\d)\s*\]\s*-->/i);
          const articleTs=m?Date.parse(m[1].trim().replace(" ","T")+"+08:00"):NaN;
          const feedTs=Number(story.published);
          const publishedAt=Number.isFinite(articleTs)?articleTs:
             (Number.isFinite(feedTs)&&feedTs>1e12?feedTs:null);
          return {body:htmlText(html),publishedAt};
        }catch{return {body:"",publishedAt:null}}
      }));
      for(let j=0;j<chunk.length;j++){
        const story=chunk[j],text=fetched[j]?.body??"";
        if(!text)continue;
        fetchedOk++;
        const t=structuredTeams(text);
        if(!t)continue;
        structured++;
        const sourceHome=normalize(t.home),sourceAway=normalize(t.away);
        const sourceTime=Number(fetched[j]?.publishedAt??NaN);
        for(const m of pool){
          if(normalize(m.home_team)!==sourceHome||normalize(m.away_team)!==sourceAway)continue;
          const kickoff=Date.parse(String(m.kickoff_at));
          // Do not publish after-kickoff articles as pre-match news; no historical backfill.
          if(!(Number.isFinite(sourceTime)&&sourceTime>0&&sourceTime<=now.getTime()&&sourceTime<kickoff&&now.getTime()<kickoff&&kickoff-sourceTime<=72*3600*1000))continue;
          matchedArticles++;
          const facts=sections(text);
          if(!facts.some(x=>x.length>=20))continue;
          const record={
            match_id:m.id,pool_date:m.pool_date,match_no:m.match_no,home_team:m.home_team,away_team:m.away_team,
            source_code:"sina_xiaopao_attributed",source_url:story.url,
            headline:story.title,published_at:new Date(sourceTime).toISOString(),fetched_at:nowIso,
            quality:"attributed_prematch_article_pair_verified",
            highlights:facts
          };
          const {data:inserted,error:saveError}=await db.from("soren_intelligence_reports_v1")
            .upsert(record,{onConflict:"match_id,source_url",ignoreDuplicates:true}).select("id");
          if(saveError)failed.push(String(m.match_no)+":"+saveError.code);
          else {if(inserted?.length)newlyInserted+=inserted.length;
            saved.push({date:m.pool_date,no:m.match_no,headline:story.title});}
        }
      }
    }
    const upsetReaudit:any[]=[]; // Downstream cold and VIP audits run on the staggered cron schedule.
    const sourceStatus=failed.length?"PARTIAL":!stories.length?"NO_SOURCE_ARTICLES":
      !matchedArticles?"NO_MATCHED_PREMATCH_INTEL":"DONE";
    // Cron returning SQL success is not evidence of a successful harvest.
    // Persist meaningful coverage independently, including zero-article scans.
    const {error:logError}=await db.from("ingest_runs").insert({
      source_name:"soren_sina_intelligence_harvest_v3",
      status:sourceStatus==="DONE"?"completed":"partial",
      started_at:nowIso,finished_at:new Date().toISOString(),
      summary:{source_status:sourceStatus,feed_pages:feedUrls.length,
        editorial_candidates:homepageCandidates,scanned_articles:stories.length,
        fetched_articles:fetchedOk,structured_articles:structured,
        prematch_matched:matchedArticles,stored:newlyInserted,
        failures:failed.length,candidate_matches:pool.length}
    });
    if(logError)console.error("SINA_INTEL_AUDIT_LOG_WRITE_FAILED",logError.code);
    return Response.json({ok:failed.length===0,status:sourceStatus,
      scanVersion:"SOREN_12_PAGES_PLUS_VERIFIED_SINA_EDITORIAL_V3",feedPages:feedUrls.length,homepageCandidates,
      scannedArticles:stories.length,articlesFetched:fetchedOk,
      structuredArticles:structured,prematchMatched:matchedArticles,
      candidateMatches:pool.length,matched:saved.length,
      stored:newlyInserted,sample:saved.slice(0,8),errors:failed.slice(0,5),upsetReaudit,
      source:"sina_xiaopao",policy:"media_attribution_only_no_formal_prediction_change; staggered cold and VIP cron re-audits follow collection"},
      {status:failed.length?207:200,headers:{"Cache-Control":"no-store"}});
  }catch(error){
    console.error("SOREN_INTEL_CACHE_ERROR",error);
    return Response.json({ok:false,error:"INTELLIGENCE_CACHE_FAILED"},{status:502});
  }
});