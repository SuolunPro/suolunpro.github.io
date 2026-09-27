import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const WEB_HEADERS = {
  "user-agent": "Mozilla/5.0 (compatible; NinetyScaleMarketBehavior/1.0)",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.7",
  "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
};

type MatchRow = {
  id:number;
  pool_date:string;
  match_no:string;
  home_team:string;
  away_team:string;
  kickoff_at:string;
  is_world_cup?:boolean;
};

function normalizeTeam(value: unknown) {
  return String(value ?? "").toLowerCase()
    .replace(/足球俱乐部|俱乐部|football club|\bfc\b/gi, "")
    .replace(/迈国际/g, "迈阿密国际")
    .replace(/國際/g, "国际")
    .replace(/[·•.\-－—_()（）\[\]【】\s]/g, "")
    .trim();
}

function teamMatch(a: unknown, b: unknown) {
  const x = normalizeTeam(a), y = normalizeTeam(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (Math.min(x.length, y.length) >= 3 && (x.includes(y) || y.includes(x))) return true;
  const xs = new Set([...x]), ys = new Set([...y]);
  const inter = [...xs].filter(ch => ys.has(ch)).length;
  return inter / Math.max(xs.size, ys.size) >= 0.8;
}

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

function htmlText(s:string) {
  return decodeEntities(
    s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
     .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
     .replace(/<br\s*\/?>/gi, "\n")
     .replace(/<\/(?:p|div|li|tr|table|section|header|footer)>/gi, "\n")
     .replace(/<[^>]+>/g, " ")
  ).replace(/[ \t]+/g, " ").replace(/\n\s+/g, "\n").trim();
}

function cellText(s:string) {
  return decodeEntities(
    s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
     .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
     .replace(/<br\s*\/?>/gi, " ")
     .replace(/<[^>]+>/g, " ")
  ).replace(/\s+/g, " ").trim();
}

function tableRows(html:string) {
  const tables:string[][][] = [];
  for (const tm of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const rows:string[][] = [];
    for (const rm of tm[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells:string[] = [];
      for (const cm of rm[1].matchAll(/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)) {
        cells.push(cellText(cm[1]));
      }
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }
  return tables;
}

function numberValue(v:unknown) {
  const s = String(v ?? "").replace(/,/g,"").replace(/%/g,"").trim();
  if (!s || s === "-") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function uniqueMatchIds(html:string) {
  const out:string[] = [], seen = new Set<string>();
  for (const m of html.matchAll(/\/soccer\/match\/(\d+)\//g)) {
    const id = m[1];
    if (!seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

function matchIdFromUrl(url:unknown) {
  const m = String(url ?? "").match(/\/soccer\/match\/(\d+)\//);
  return m?.[1] ?? null;
}

function pageTitle(html:string) {
  return cellText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ""));
}

function parseIdentity(html:string) {
  const title = pageTitle(html);
  let m = title.match(/交易盈亏\s*[-－_:：]?\s*(.+?)\s*vs\s*(.+?)\s*[-－_|｜]/i);
  if (!m) {
    const text=htmlText(html).slice(0,1800);
    m=text.match(/交易盈亏\s*[-－_:：]?\s*([^\n]{2,30}?)\s*vs\s*([^\n]{2,30}?)(?:\s*[-－_|｜]|\s+(?:欧|亚|竞足|单场|14场|开通))/i);
  }
  if (!m) {
    const desc=cellText((html.match(/<meta\b[^>]*(?:name|property)=["'](?:description|og:description)["'][^>]*content=["']([^"']+)["'][^>]*>/i)?.[1] ?? ""));
    m=desc.match(/(?:最精准的|最准确的)?\s*([^，。]{2,30}?)\s*VS\s*([^，。]{2,30}?)(?:必发|阵容|澳客)/i);
  }
  if (!m) return null;
  return { home:m[1].trim(), away:m[2].trim() };
}

function parseOkoooKickoff(html:string) {
  const text = htmlText(html);
  const m = text.match(/(?:^|\s)(\d{2})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?:\s|$)/);
  if (!m) return null;
  const year = 2000 + Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  const hour = Number(m[4]), minute = Number(m[5]);
  // 澳客赛事页显示北京时间（UTC+8）
  return Date.UTC(year, month-1, day, hour-8, minute, 0, 0);
}

function parseBehavior(html:string, expectedHome:string, expectedAway:string) {
  const tables = tableRows(html);
  const txTable = tables.find(rows => {
    const t = rows.flat().join("|");
    return t.includes("必发成交数据") && t.includes("竞彩数据") && t.includes("做单人气比例");
  });
  const idxTable = tables.find(rows => {
    const t = rows.flat().join("|");
    return t.includes("99家平均") && t.includes("交易量比例") && t.includes("交易冷热指数") && t.includes("庄家盈亏指数");
  });
  if (!txTable || !idxTable) return null;

  const pickRows = (rows:string[][]) => rows.filter(c => {
    if (!c.length) return false;
    const name = c[0];
    return teamMatch(name, expectedHome) || teamMatch(name, expectedAway) || /平局|平/.test(name);
  });

  const tx = pickRows(txTable);
  const idx = pickRows(idxTable);
  if (tx.length < 3 || idx.length < 3) return null;

  const txByRole:any[] = [];
  const idxByRole:any[] = [];
  const role = (name:string) => teamMatch(name,expectedHome) ? "home" : teamMatch(name,expectedAway) ? "away" : /平局|^平$/.test(name) ? "draw" : null;
  for (const c of tx) {
    const r = role(c[0]);
    if (!r || c.length < 13) continue;
    txByRole.push({
      role:r, team:r==="draw"?"平局":(r==="home"?expectedHome:expectedAway),
      bfOdds:numberValue(c[5]),
      bfVolume:numberValue(c[6]),
      bfProfitLoss:numberValue(c[7]),
      jcOdds:numberValue(c[8]),
      jcSavedVolume:numberValue(c[9]),
      jcProfitLoss:numberValue(c[10]),
      savedPopularity:numberValue(c[11]),
      doerPct:numberValue(c[12])
    });
  }
  for (const c of idx) {
    const r = role(c[0]);
    if (!r || c.length < 12) continue;
    idxByRole.push({
      role:r, team:r==="draw"?"平局":(r==="home"?expectedHome:expectedAway),
      avgOdds:numberValue(c[1]),
      avgProb:numberValue(c[2]),
      bfShare:numberValue(c[3]),
      jcSavedShare:numberValue(c[4]),
      northShare:numberValue(c[5]),
      bfHotCold:numberValue(c[6]),
      jcHotCold:numberValue(c[7]),
      bfMarketIndex:numberValue(c[8]),
      jcMarketIndex:numberValue(c[9]),
      bfProfitIndex:numberValue(c[10]),
      jcProfitIndex:numberValue(c[11])
    });
  }

  const roles = (rows:any[]) => new Set(rows.map(x=>x.role));
  const txRoles=roles(txByRole), idxRoles=roles(idxByRole);
  if (!["home","draw","away"].every(x=>txRoles.has(x)&&idxRoles.has(x))) return null;

  const text = htmlText(html);
  const scale = text.match(/本场比赛必发交易规模(较大|适中|较小)/)?.[1] ?? null;
  const order = {home:0,draw:1,away:2} as Record<string,number>;
  txByRole.sort((a,b)=>order[a.role]-order[b.role]);
  idxByRole.sort((a,b)=>order[a.role]-order[b.role]);
  return {
    exchangeScale:scale,
    transactionRows:txByRole.map(({role,...x})=>x),
    indexRows:idxByRole.map(({role,...x})=>x)
  };
}

async function getHtml(url:string, timeout=15000) {
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), timeout);
  try {
    const r = await fetch(url,{headers:WEB_HEADERS,signal:controller.signal,redirect:"follow"});
    if (!r.ok) throw new Error("HTTP_"+r.status);
    const buf=await r.arrayBuffer();
    const ct=String(r.headers.get("content-type")??"").toLowerCase();
    const declared=(ct.match(/charset=([^;\s]+)/)?.[1]??"").toLowerCase();
    const preferred=/gb2312|gbk|gb18030/.test(declared)?"gb18030":"utf-8";
    let text=new TextDecoder(preferred).decode(buf);
    if(preferred==="utf-8"){
      const bad=(text.match(/�/g)||[]).length;
      if(bad>3)text=new TextDecoder("gb18030").decode(buf);
    }
    return text;
  } finally { clearTimeout(timer); }
}

function beijingDate(d=new Date()) {
  return new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(d);
}

Deno.serve(async (req:Request) => {
  if (req.method !== "POST") return Response.json({ok:false,error:"METHOD_NOT_ALLOWED"},{status:405});
  const internalKey = req.headers.get("x-soren-intel-key") ?? "";
  if (internalKey.length < 32) return Response.json({ok:false,error:"UNAUTHORIZED"},{status:401});
  const {data:authorized,error:authError}=await db.rpc("soren_intel_authorized",{p_key:internalKey});
  if (authError || authorized !== true) return Response.json({ok:false,error:"UNAUTHORIZED"},{status:401});

  try {
    let body:any={};
    try { body=await req.json(); } catch {}
    const now = new Date(), nowMs=now.getTime(), nowIso=now.toISOString();
    const requestedDate = typeof body?.date==="string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : null;
    const until = new Date(nowMs + 48*3600*1000).toISOString();

    let q = db.from("soren_matches")
      .select("id,pool_date,match_no,home_team,away_team,kickoff_at,is_world_cup")
      .eq("is_world_cup",false)
      .gt("kickoff_at",new Date(nowMs+60_000).toISOString())
      .lte("kickoff_at",until)
      .order("pool_date",{ascending:true})
      .order("match_no",{ascending:true})
      .limit(80);
    if (requestedDate) q=q.eq("pool_date",requestedDate);
    const {data:matches,error:matchError}=await q;
    if (matchError) throw matchError;
    const pool=(matches??[]) as MatchRow[];
    if (!pool.length) return Response.json({ok:true,status:"NO_FUTURE_MATCHES",at:nowIso,stored:0});

    const ids=pool.map(m=>m.id);
    const [{data:existing,error:existingError},{data:intel,error:intelError}]=await Promise.all([
      db.from("soren_market_behavior_v1")
        .select("match_id,okooo_match_id,captured_at")
        .in("match_id",ids)
        .order("captured_at",{ascending:false}).limit(1000),
      db.from("soren_intelligence_reports_v1")
        .select("match_id,source_url,fetched_at")
        .in("match_id",ids)
        .order("fetched_at",{ascending:false}).limit(1000)
    ]);
    if (existingError || intelError) throw existingError || intelError;

    const mapped = new Map<number,string>();
    for (const r of existing??[]) {
      const id=Number(r.match_id), oid=String(r.okooo_match_id??"");
      if (id && oid && !mapped.has(id)) mapped.set(id,oid);
    }
    for (const r of intel??[]) {
      const id=Number(r.match_id), oid=matchIdFromUrl(r.source_url);
      if (id && oid && !mapped.has(id)) mapped.set(id,oid);
    }

    const dates=[...new Set(pool.map(m=>String(m.pool_date)))];
    const scheduleIdsByDate=new Map<string,string[]>();
    for (const date of dates) {
      try {
        const html=await getHtml("https://www.okooo.com/jingcai/"+date+"/",15000);
        scheduleIdsByDate.set(date,uniqueMatchIds(html));
      } catch (e) {
        scheduleIdsByDate.set(date,[]);
        console.error("OKOOO_SCHEDULE_FETCH",date,String(e));
      }
    }

    for (const date of dates) {
      const dayMatches=pool.filter(m=>String(m.pool_date)===date).sort((a,b)=>String(a.match_no).localeCompare(String(b.match_no)));
      const candidates=scheduleIdsByDate.get(date)??[];
      for (let i=0;i<dayMatches.length;i++) {
        const m=dayMatches[i];
        if (!mapped.has(m.id) && candidates[i]) mapped.set(m.id,candidates[i]);
      }
    }

    const results:any[]=[];
    const failures:any[]=[];
    for (let offset=0; offset<pool.length; offset+=5) {
      const chunk=pool.slice(offset,offset+5);
      const batch=await Promise.all(chunk.map(async m=>{
        const oid=mapped.get(m.id);
        if (!oid) return {no:m.match_no,status:"NO_OKOOO_ID"};
        const kickoffMs=Date.parse(String(m.kickoff_at));
        if (!(nowMs < kickoffMs-30_000)) return {no:m.match_no,status:"TOO_LATE"};
        const url="https://www.okooo.com/soccer/match/"+oid+"/exchanges/";
        try {
          const html=await getHtml(url,18000);
          const ident=parseIdentity(html);
          if (!ident || !teamMatch(ident.home,m.home_team) || !teamMatch(ident.away,m.away_team)) {
            return {no:m.match_no,status:"IDENTITY_MISMATCH",oid,seen:ident,title:pageTitle(html),head:htmlText(html).slice(0,240)};
          }
          const okoooKick=parseOkoooKickoff(html);
          if (!okoooKick || Math.abs(okoooKick-kickoffMs)>15*60_000) {
            return {no:m.match_no,status:"KICKOFF_MISMATCH",oid,okoooKickoff:okoooKick?new Date(okoooKick).toISOString():null,dbKickoff:m.kickoff_at};
          }
          const parsed=parseBehavior(html,String(m.home_team),String(m.away_team));
          if (!parsed) return {no:m.match_no,status:"PARSE_INCOMPLETE",oid};
          const record={
            pool_date:m.pool_date,
            match_no:String(m.match_no).padStart(3,"0"),
            match_id:m.id,
            okooo_match_id:oid,
            home_team:m.home_team,
            away_team:m.away_team,
            source_url:url,
            exchange_scale:parsed.exchangeScale,
            transaction_rows:parsed.transactionRows,
            index_rows:parsed.indexRows,
            captured_at:nowIso,
            kickoff_at:m.kickoff_at,
            prematch_verified:true,
            source_quality:"okooo_exchange_exact_identity_prematch_auto"
          };
          const {error:insertError}=await db.from("soren_market_behavior_v1").insert(record);
          if (insertError) return {no:m.match_no,status:"STORE_ERROR",oid,error:insertError.code};
          return {no:m.match_no,status:"STORED",oid,scale:parsed.exchangeScale};
        } catch(e) {
          return {no:m.match_no,status:"FETCH_ERROR",oid,error:String(e).slice(0,180)};
        }
      }));
      for(const r of batch) {
        if(r.status==="STORED") results.push(r); else failures.push(r);
      }
    }

    return Response.json({
      ok:true,
      status:failures.length?"PARTIAL":"DONE",
      collector:"market-behavior-v1",
      capturedAt:nowIso,
      beijingDate:beijingDate(now),
      candidateMatches:pool.length,
      mapped:mapped.size,
      stored:results.length,
      skippedOrFailed:failures.length,
      sample:results.slice(0,12),
      issues:failures.slice(0,20),
      policy:"prematch-only; exact teams + kickoff verification; no postkickoff backfill"
    },{status:200,headers:{"Cache-Control":"no-store"}});
  } catch(error) {
    console.error("SOREN_MARKET_BEHAVIOR_COLLECTOR_ERROR",error);
    return Response.json({ok:false,error:"MARKET_BEHAVIOR_COLLECTOR_FAILED"},{status:502});
  }
});