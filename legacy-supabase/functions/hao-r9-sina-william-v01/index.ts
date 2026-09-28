import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const sb=createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||Deno.env.get("SUPABASE_SECRET_KEY")!,
  {auth:{persistSession:false,autoRefreshToken:false}}
);

const strip=(s:any)=>String(s??"")
  .replace(/<script[\s\S]*?<\/script>/gi," ")
  .replace(/<style[\s\S]*?<\/style>/gi," ")
  .replace(/<[^>]*>/g," ")
  .replace(/&nbsp;|&#160;/gi," ")
  .replace(/&amp;/gi,"&")
  .replace(/\s+/g," ").trim();

const TEAM_ALIAS:Record<string,string>={
  "布里斯托尔城":"布里斯托城",
  "谢菲尔德联":"谢菲联",
  "西布罗姆维奇":"西布罗姆",
  "南安普敦":"南安普顿",
  "弗洛西诺":"弗罗西诺内",
  "弗洛西诺内":"弗罗西诺内",
  "雷克斯汉姆":"雷克瑟姆",
  "伍尔弗汉普顿":"狼队",
  "贝蒂斯":"皇家贝蒂斯",
  "皇马":"皇家马德里",
  "昂纳西":"阿纳西",
  "莫雷拉人":"摩雷伦斯",
  "桑德菲杰":"桑讷菲尤尔",
  "哈萨克斯坦":"哈萨克",
  "哈萨克":"哈萨克"
};
const canon=(s:any)=>{
  const t=String(s??"").replace(/\s+/g,"").trim();
  return TEAM_ALIAS[t]||t;
};
const num=(s:any)=>{const x=Number(strip(s));return Number.isFinite(x)&&x>1&&x<100?x:null};
const tdTexts=(tr:string)=>[...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m=>strip(m[1]));
const EXECUTOR_MARKER="hao-r9-sina-william-v01-v8-no-update-row-leak";

function bjtText(d:Date){
  const ps=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).formatToParts(d);
  const z:any={};for(const p of ps)z[p.type]=p.value;
  return z.year+"-"+z.month+"-"+z.day+" "+z.hour+":"+z.minute+":"+z.second;
}
function bjtNowText(){return bjtText(new Date())}

async function discoverIssue(explicit:string|null){
  if(explicit)return explicit;
  const now=bjtNowText();
  const {data,error}=await sb.from("r9_issues_2026").select("issue_no,sale_start,sale_end").lte("sale_start",now).gt("sale_end",now).order("sale_end").limit(40);
  if(error)throw error;
  const counts=new Map<string,number>();
  for(const r of data||[])counts.set(String(r.issue_no),(counts.get(String(r.issue_no))||0)+1);
  const active=[...counts.entries()].find(([,n])=>n===14);
  if(active)return active[0];

  // Prefetch the next issue shortly before it opens so the first formal run is not data-starved.
  const soon=bjtText(new Date(Date.now()+45*60*1000));
  const {data:up,error:ue}=await sb.from("r9_issues_2026").select("issue_no,sale_start,sale_end")
    .gt("sale_start",now).lte("sale_start",soon).order("sale_start").limit(40);
  if(ue)throw ue;
  const uc=new Map<string,number>();
  for(const r of up||[])uc.set(String(r.issue_no),(uc.get(String(r.issue_no))||0)+1);
  const upcoming=[...uc.entries()].find(([,n])=>n===14);
  return upcoming?.[0]||null;
}

async function sinaSearch(issue:string){
  const q=encodeURIComponent("胜负彩"+issue+"期欧洲四大机构最新数据");
  const url=`https://search.sina.com.cn/api/news?q=${q}&tp=news&sort=1&page=1&size=20&from=search_result`;
  const r=await fetch(url,{headers:{"user-agent":"Mozilla/5.0","accept":"application/json"},signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw new Error("sina search HTTP "+r.status);
  const j=await r.json();
  const list=Array.isArray(j?.data?.list)?j.data.list:[];
  const hit=list.find((x:any)=>{
    const title=strip(x?.title);
    return title.includes("胜负彩")&&title.includes(issue+"期")&&title.includes("欧洲")&&title.includes("机构")&&String(x?.url||"").includes("sports.sina.com.cn/l/");
  });
  return {search_url:url,hit};
}

function parseWilliam(html:string,issueRows:any[]){
  const trs=[...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(m=>m[0]);
  const out:any[]=[];
  const nameMismatches:any[]=[];
  let current:any=null;
  for(const tr of trs){
    const cells=tdTexts(tr);
    if(cells.length<5)continue;
    const seq=Number(cells[0]);
    if(Number.isInteger(seq)&&seq>=1&&seq<=14){
      // A new fixture row always closes the previous fixture context.
      // If identity/odds validation fails, following update rows must NOT leak into the previous fixture.
      current=null;
      const fixture=issueRows.find((x:any)=>Number(x.seq_no)===seq);
      if(!fixture)continue;
      const teams=String(cells[1]||"").split(/\s+vs\s+|\s+VS\s+/i);
      const sourceHome=teams.length===2?String(teams[0]||"").trim():null;
      const sourceAway=teams.length===2?String(teams[1]||"").trim():null;
      const namesMatch=teams.length===2
        && canon(sourceHome)===canon(fixture.home_team)
        && canon(sourceAway)===canon(fixture.away_team);
      if(!namesMatch){
        nameMismatches.push({
          seq_no:seq,
          source_home:sourceHome,
          source_away:sourceAway,
          official_home:fixture.home_team,
          official_away:fixture.away_team
        });
        continue;
      }
      const open=[num(cells[2]),num(cells[3]),num(cells[4])];
      if(open.some(x=>x==null))continue;
      current={
        issue_no:String(fixture.issue_no),seq_no:seq,home_team:fixture.home_team,away_team:fixture.away_team,
        william_open_home:open[0],william_open_draw:open[1],william_open_away:open[2],
        william_latest_home:open[0],william_latest_draw:open[1],william_latest_away:open[2],
        latest_label:"OPEN"
      };
      out.push(current);
      continue;
    }
    if(current && /^\d{1,2}日\d{1,2}:\d{2}$/.test(String(cells[1]||""))){
      const v=[num(cells[2]),num(cells[3]),num(cells[4])];
      if(v.every(x=>x!=null)){
        current.william_latest_home=v[0];
        current.william_latest_draw=v[1];
        current.william_latest_away=v[2];
        current.latest_label=cells[1];
      }
    }
  }
  return {rows:out,nameMismatches};
}

Deno.serve(async(req)=>{
  const now=new Date().toISOString();
  try{
    const u=new URL(req.url);
    const issue=await discoverIssue(u.searchParams.get("issue"));
    if(!issue)return Response.json({ok:true,status:"NO_ACTIVE_R9_ISSUE"});
    const {data:issueRows,error:ie}=await sb.from("r9_issues_2026").select("issue_no,seq_no,home_team,away_team,sale_start,sale_end").eq("issue_no",issue).order("seq_no");
    if(ie)throw ie;
    if((issueRows||[]).length!==14)return Response.json({ok:true,status:"ISSUE_NOT_14",issue,rows:issueRows?.length||0});

    const sr=await sinaSearch(issue);
    const [{data:existingRows},{data:prevHealth}]=await Promise.all([
      sb.from("r9_market_sina_2026").select("seq_no,imported_at,source_url").eq("issue_no",issue),
      sb.from("hao_source_health_v01").select("last_success_at,consecutive_failures").eq("source_code","r9_sina_william").maybeSingle()
    ]);
    const existingSeq=[...new Set((existingRows||[]).map((x:any)=>Number(x.seq_no)).filter((x:any)=>Number.isFinite(x)))];
    const existingN=existingSeq.length;
    const existingLatest=(existingRows||[]).map((x:any)=>x.imported_at).filter(Boolean).sort().slice(-1)[0]||null;
    const verifiedExistingUrl=[...new Set((existingRows||[]).map((x:any)=>String(x.source_url||"").split("?")[0]).filter((u:any)=>/^https:\/\/sports\.sina\.com\.cn\/l\/\d{4}-\d{2}-\d{2}\/doc-[^/]+\.shtml$/i.test(u)))][0]||null;
    const articleUrl=sr.hit?String(sr.hit.url).split("?")[0]:verifiedExistingUrl;

    if(!articleUrl){
      await sb.from("hao_source_health_v01").upsert({
        source_code:"r9_sina_william",source_role:"r9_william_same_company",
        status:existingN===14?"ok":existingN>0?"partial":"error",
        last_attempt_at:now,
        last_success_at:prevHealth?.last_success_at||existingLatest,
        latest_pool_date:String(issueRows![0].sale_end).slice(0,10),
        expected_matches:14,mapped_matches:existingN,captured_matches:existingN,verified_matches:existingN,
        consecutive_failures:Number(prevHealth?.consecutive_failures||0)+1,
        last_error:"Sina exact issue odds article not found and no previously verified article URL available",
        notes:existingN>0
          ?`Refresh miss; retained ${existingN}/14 previously verified William rows. No verified source URL fallback available; no guessing.`
          :"Search API exact title gate; no guessing.",
        updated_at:now
      },{onConflict:"source_code"});
      return Response.json({ok:true,status:existingN>0?"ARTICLE_NOT_FOUND_RETAINED":"ARTICLE_NOT_FOUND",issue,retained_rows:existingN});
    }

    const discoveryMode=sr.hit?"SINA_SEARCH_EXACT":"VERIFIED_EXISTING_SOURCE_URL_FALLBACK";
    const ar=await fetch(articleUrl,{headers:{"user-agent":"Mozilla/5.0","accept":"text/html"},signal:AbortSignal.timeout(15000)});
    const html=await ar.text();
    if(!ar.ok)throw new Error("sina article HTTP "+ar.status);
    const parsed=parseWilliam(html,issueRows||[]);
    const rows=parsed.rows;
    for(const r of rows){
      const {error}=await sb.from("r9_market_sina_2026").upsert({
        ...r,source_url:articleUrl,source_quality:"A-SINA_WILLIAM_SAME_COMPANY",
        timing_quality:"PREMATCH_ARTICLE_SNAPSHOT",imported_at:now
      },{onConflict:"issue_no,seq_no,source_url"});
      if(error)throw error;
    }
    const n=rows.length;
    await sb.from("hao_source_health_v01").upsert({
      source_code:"r9_sina_william",source_role:"r9_william_same_company",
      status:n===14?"ok":n>0?"partial":"error",last_attempt_at:now,last_success_at:n?now:null,
      latest_pool_date:String(issueRows![0].sale_end).slice(0,10),expected_matches:14,mapped_matches:n,captured_matches:n,verified_matches:n,
      consecutive_failures:n?0:1,last_error:n===14?null:`William rows ${n}/14`,
      notes:`${discoveryMode} -> SFC ${issue} European four-book article -> William first/latest valid row; strict seq + canonical team identity; ${articleUrl}`,updated_at:now
    },{onConflict:"source_code"});
    return Response.json({ok:true,status:n===14?"COMPLETE":"PARTIAL",issue,article_url:articleUrl,discovery_mode:discoveryMode,rows:n,name_mismatch_audit:parsed.nameMismatches,data:rows});
  }catch(e:any){
    try{await sb.from("hao_source_health_v01").upsert({source_code:"r9_sina_william",source_role:"r9_william_same_company",status:"error",last_attempt_at:now,consecutive_failures:1,last_error:String(e?.message||e),updated_at:now},{onConflict:"source_code"})}catch{}
    return Response.json({ok:false,error:String(e?.message||e)},{status:500});
  }
});