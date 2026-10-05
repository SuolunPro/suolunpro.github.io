import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SECRET_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36";
const CUSTOMER_API = "https://ttydbcejxqxdkcfoizkj.supabase.co/functions/v1/soren-public-api-v1";
const CUSTOMER_PUBLISHABLE_KEY = "sb_publishable_n5thZ1g6h93ronyzPfqhsg_N_lFaoSa";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-soren-bridge-token",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "no-store",
};
let cookieJar = "";
const ALIAS: Record<string, string> = {
  "阿斯顿维拉": "维拉", "阿斯顿维拉队": "维拉", "伍尔弗汉普顿": "狼队",
  "布里斯托尔城": "布城", "布里斯托城": "布城", "布里斯托": "布城",
  "南安普敦": "南安普顿", "西汉姆": "西汉姆联", "谢菲尔德联": "谢菲联",
  "朴次茅斯": "朴茨茅斯", "弗洛西诺内": "弗洛西诺", "TPS土尔库": "TPS图尔",
  "国际图尔库": "国际图尔", "库普斯": "库奥皮奥", "赫塔菲": "赫塔费", "巴塞罗那": "巴萨",
  "枥木UvaFC": "枥木城", "枥木UVAFC": "枥木城", "栃木UvaFC": "枥木城", "枥木市FC": "枥木城",
  "女王公园巡游者": "女王巡游", "女王公园巡游": "女王巡游", "女王巡游者": "女王巡游",
  "雷克斯": "雷克瑟姆", "弗洛西诺尼": "弗洛西诺", "奥斯纳布鲁克": "奥斯纳",
  "米拉索尔": "米拉索", "町田泽维亚": "町田泽维", "斯洛文尼": "斯洛文尼亚",
};

function bjtDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function strip(s: string) {
  return s.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&")
    .replace(/&minus;|&#8722;|−/g, "-").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ").trim();
}
function canon(x: unknown) {
  const z = String(x || "").replace(/\s+/g, "").replace(/足球俱乐部|俱乐部|FC$/ig, "");
  return ALIAS[z] || z;
}
function lev(a: string, b: string) {
  const d = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) d[i][0] = i;
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}
function one(a: string, b: string) {
  a = canon(a); b = canon(b);
  return a === b || (Math.min(a.length, b.length) >= 3 && lev(a, b) <= 1) || a.includes(b) || b.includes(a);
}
function decodeBest(buf: Uint8Array) {
  const choices: { enc: string; text: string; score: number }[] = [];
  for (const enc of ["gb18030", "utf-8"]) {
    try {
      const text = new TextDecoder(enc as "utf-8").decode(buf);
      const score = (text.match(/竞彩|比赛时间|欧赔|平均|情报|伤停|有利|不利|主队|客队/g) || []).length;
      choices.push({ enc, text, score });
    } catch { /* ignore unsupported decoder */ }
  }
  choices.sort((a, b) => b.score - a.score);
  return choices[0];
}
async function fetchHtml(url: string, referer = "https://www.okooo.com/jingcai/") {
  let last: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, { headers: {
        "user-agent": UA, "accept-language": "zh-CN,zh;q=0.9",
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "cache-control": "no-cache", "upgrade-insecure-requests": "1", referer,
        ...(cookieJar ? { cookie: cookieJar } : {}),
      }, signal: AbortSignal.timeout(18000) });
      const bytes = new Uint8Array(await r.arrayBuffer());
      const setCookie = r.headers.get("set-cookie");
      if (setCookie) cookieJar = setCookie.split(",").map((x) => x.split(";")[0]).join("; ");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const decoded = decodeBest(bytes);
      return { url, html: decoded.text, enc: decoded.enc, status: r.status, bytes: bytes.length };
    } catch (e) {
      last = e;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1400));
    }
  }
  throw last;
}
function parseRows(html: string, url: string) {
  const out: any[] = [];
  for (const raw of html.split('<div class="touzhu_1"')) {
    const no = raw.match(/<span class="xulie"[^>]*>([0-9]{3})<\/span>/)?.[1];
    if (!no) continue;
    const mid = raw.match(/id="match_([0-9]+)"/)?.[1] || null;
    const kickoff = raw.match(/title="比赛时间:([^"]+)"/)?.[1] || null;
    const names = [...raw.matchAll(/class="zhum[^"]*"[^>]*title="([^"]*)"[^>]*>([^<]+)<\/div>/g)]
      .map((m) => ({ title: strip(m[1]), text: strip(m[2]) })).filter((x) => x.title || x.text);
    if (names.length >= 2) {
      const home = names[0], away = names[names.length - 1];
      out.push({ no, mid, kickoff, home: home.title || home.text, away: away.title || away.text,
        homeVariants: [home.title, home.text].filter(Boolean), awayVariants: [away.title, away.text].filter(Boolean), url });
    }
  }
  return out;
}
function rowCells(tr: string) {
  return [...tr.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => strip(m[1]));
}
function numericCell(s: string) {
  const m = String(s || "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}
function parseOdds(html: string) {
  const rows: any[] = [];
  for (const m of html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)) {
    const cells = rowCells(m[0]);
    if (cells.length < 16 || !/^\d+$/.test(cells[0] || "")) continue;
    const company = cells[1];
    const trio = [numericCell(cells[5]), numericCell(cells[6]), numericCell(cells[7])];
    if (company && trio.every((v) => v !== null && v > 1 && v < 100)) {
      rows.push({ company, home: trio[0], draw: trio[1], away: trio[2],
        initial: [numericCell(cells[2]), numericCell(cells[3]), numericCell(cells[4])],
        probabilities: [numericCell(cells[9]), numericCell(cells[10]), numericCell(cells[11])],
        kelly: [numericCell(cells[12]), numericCell(cells[13]), numericCell(cells[14])],
        payout: numericCell(cells[15]) });
    }
  }
  const unique = [...new Map(rows.map((r) => [r.company, r])).values()];
  const mean = (key: "home" | "draw" | "away") => unique.length ? unique.reduce((s, r) => s + r[key], 0) / unique.length : null;
  return { bookmaker_count: unique.length, avg_home: mean("home"), avg_draw: mean("draw"), avg_away: mean("away"), bookmakers: unique };
}
function meanNumbers(values: Array<number | null>) {
  const valid = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}
function summarizeKelly(bookmakers: any[]) {
  const complete = (bookmakers || []).filter((row) => Array.isArray(row?.kelly) && row.kelly.length === 3
    && row.kelly.every((value: unknown) => typeof value === "number" && Number.isFinite(value)));
  const average = [0, 1, 2].map((index) => meanNumbers(complete.map((row) => row.kelly[index])));
  const labels = ["home", "draw", "away"];
  const comparable = average.map((value, index) => ({ direction: labels[index], value })).filter((x) => x.value !== null) as Array<{ direction: string; value: number }>;
  comparable.sort((a, b) => a.value - b.value);
  return {
    complete_count: complete.length,
    average: { home: average[0], draw: average[1], away: average[2] },
    lowest_direction: comparable[0]?.direction || null,
    lowest_value: comparable[0]?.value ?? null,
  };
}
function numberOrPercent(s: string) {
  const value = numericCell(s);
  return value === null ? null : value;
}
function parseExchange(html: string) {
  const tables = [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)].map((m) => ({
    html: m[0], rows: [...m[0].matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)].map((row) => rowCells(row[0])),
  }));
  const volumeTable = tables.find((table) => /必发买家挂牌/.test(table.html) && /做单人气比例/.test(table.html));
  const indexTable = tables.find((table) => /交易冷热指数/.test(table.html) && /庄家盈亏指数/.test(table.html));
  const notesTable = tables.find((table) => /数据\s*要点/.test(strip(table.html)));
  const rowKey = (value: string) => /平局|和局/.test(value) ? "draw" : null;
  const selectionRows: Record<string, any> = {};
  const rawVolumeRows = (volumeTable?.rows || []).filter((cells) => cells.length >= 13
    && numericCell(cells[5]) !== null && numericCell(cells[6]) !== null);
  rawVolumeRows.slice(0, 3).forEach((cells, index) => {
    const key = rowKey(cells[0]) || (index === 0 ? "home" : index === 2 ? "away" : null);
    if (!key) return;
    selectionRows[key] = {
      label: cells[0], betfair_price: numericCell(cells[5]), betfair_volume: numericCell(cells[6]),
      bookmaker_profit_loss: numericCell(cells[7]), jc_odds: numericCell(cells[8]),
      jc_saved_volume: numericCell(cells[9]), jc_bookmaker_profit_loss: numericCell(cells[10]),
      jc_saved_popularity: numericCell(cells[11]), maker_popularity_pct: numberOrPercent(cells[12]),
    };
  });
  const indexRows: Record<string, any> = {};
  const rawIndexRows = (indexTable?.rows || []).filter((cells) => cells.length >= 15
    && numericCell(cells[1]) !== null && numberOrPercent(cells[2]) !== null);
  rawIndexRows.slice(0, 3).forEach((cells, index) => {
    const key = rowKey(cells[0]) || (index === 0 ? "home" : index === 2 ? "away" : null);
    if (!key) return;
    indexRows[key] = {
      label: cells[0], average_odds: numericCell(cells[1]), average_probability_pct: numberOrPercent(cells[2]),
      betfair_share_pct: numberOrPercent(cells[3]), jc_share_pct: numberOrPercent(cells[4]), bd_share_pct: numberOrPercent(cells[5]),
      betfair_cold_heat: numericCell(cells[6]), jc_cold_heat: numericCell(cells[7]),
      betfair_market_index: numericCell(cells[8]), jc_market_index: numericCell(cells[9]),
      betfair_profit_index: numericCell(cells[10]), jc_profit_index: numericCell(cells[11]),
      sell_tendency: numericCell(cells[12]), buy_tendency: numericCell(cells[13]), jc_saved_tendency: numericCell(cells[14]),
    };
  });
  const selections: Record<string, any> = {};
  for (const key of ["home", "draw", "away"]) selections[key] = { ...(selectionRows[key] || {}), ...(indexRows[key] || {}) };
  const notes = notesTable ? [...new Set((notesTable.rows.flat().join(" ").match(/[^。]+。/g) || []).map((x) => strip(x)).filter((x) => x.length >= 8))] : [];
  const completeCount = ["home", "draw", "away"].filter((key) => typeof selections[key]?.betfair_volume === "number"
    && typeof selections[key]?.bookmaker_profit_loss === "number" && typeof selections[key]?.betfair_share_pct === "number").length;
  return { complete_count: completeCount, selections, notes: notes.slice(0, 12) };
}
function oddsDebug(html: string) {
  return [...html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)]
    .map((m) => rowCells(m[0])).filter((x) => x.length >= 16).slice(0, 30);
}
function pageHints(html: string) {
  const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);
  const urls = [...html.matchAll(/(?:src|href|url)\s*(?:=|:)\s*["']([^"'<> ]+)["']/gi)]
    .map((m) => m[1]).filter((x) => /odds|match|ajax|api|soccer/i.test(x));
  const snippets: string[] = [];
  for (const token of ["ajax", "odds", "company", "average", "赔率", "欧赔"]) {
    let at = html.toLowerCase().indexOf(token.toLowerCase());
    for (let n = 0; at >= 0 && n < 4; n++) {
      snippets.push(strip(html.slice(Math.max(0, at - 180), Math.min(html.length, at + 360))));
      at = html.toLowerCase().indexOf(token.toLowerCase(), at + token.length);
    }
  }
  return { scripts: [...new Set(scripts)].slice(0, 80), urls: [...new Set(urls)].slice(0, 80), snippets: [...new Set(snippets)].slice(0, 30) };
}
async function fetchFirst(urls: string[], referer: string) {
  let last: unknown = null;
  for (const url of urls) {
    try { return await fetchHtml(url, referer); } catch (e) { last = e; }
  }
  throw last;
}
function textItems(html: string) {
  const items: string[] = [];
  for (const m of html.matchAll(/<(?:li|p|dd|div)[^>]*>([\s\S]*?)<\/(?:li|p|dd|div)>/gi)) {
    const t = strip(m[1]);
    if (t.length >= 8 && t.length <= 280 && /伤|停|缺|出战|复出|有利|不利|主队|客队|近况|状态|阵容|交锋|赛程|体能|战意/.test(t)) items.push(t);
  }
  return [...new Set(items)].slice(0, 120);
}
function parseIntel(html: string, home: string, away: string) {
  const all = textItems(html);
  const injuries = all.filter((x) => /伤|停赛|缺阵|出战成疑|复出/.test(x));
  const homeItems = all.filter((x) => x.includes(home) || x.includes(canon(home)) || /主队/.test(x));
  const awayItems = all.filter((x) => x.includes(away) || x.includes(canon(away)) || /客队/.test(x));
  const assigned = new Set([...homeItems, ...awayItems, ...injuries]);
  const remainder = all.filter((x) => !assigned.has(x));
  return { home_items: [...homeItems, ...remainder.filter((_, i) => i % 2 === 0)].slice(0, 40),
    away_items: [...awayItems, ...remainder.filter((_, i) => i % 2 === 1)].slice(0, 40),
    injury_items: injuries.slice(0, 40), all_items: all };
}
function timing(kickoffLocal: string) {
  const kickoff = new Date(String(kickoffLocal).replace(" ", "T") + "+08:00").getTime();
  const mins = (kickoff - Date.now()) / 60000;
  if (!Number.isFinite(mins)) return { eligible: false, mins: null, quality: "UNKNOWN" };
  if (mins <= 0) return { eligible: false, mins, quality: "POST_KICKOFF_REJECT" };
  if (mins >= 360) return { eligible: true, mins, quality: "PREMATCH_GT6H" };
  if (mins >= 180) return { eligible: true, mins, quality: "PREMATCH_3_6H" };
  if (mins >= 60) return { eligible: true, mins, quality: "PREMATCH_1_3H" };
  if (mins >= 30) return { eligible: true, mins, quality: "PREMATCH_30_60M" };
  return { eligible: true, mins, quality: "PREMATCH_LT30M" };
}
async function sha(value: unknown) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}


const SHADOW_DIR_ZH: Record<string,string> = { home:"主胜", draw:"平局", away:"客胜" };
function nval(v: unknown) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function maxDir(values: Record<string, unknown>) {
  const rows = ["home","draw","away"].map(direction => ({ direction, value: nval(values[direction]) }))
    .filter((x): x is {direction:string,value:number} => x.value !== null);
  rows.sort((a,b)=>b.value-a.value);
  return rows[0] || null;
}

type ShadowIntelSide = "主队"|"客队";
type ShadowIntelImpact = "利空"|"利好";
function semanticIntel(intel:any, home:string, away:string){
  const all=safeIntelItems(intel?.all_items || []);
  const injury=safeIntelItems(intel?.injury_items || []);
  const items=[...new Set([...all,...injury])];
  const homeName=String(home||"").trim(),awayName=String(away||"").trim();
  let context:ShadowIntelSide|null=null;
  const categories:any[]=[];
  const adverseRe=/伤退|伤停|伤缺|缺席|缺阵|停赛|受伤|无法出战|无缘出战|出战成疑|出场存疑|出战存疑|可能缺阵|可能缺席|伤疑|带伤|身体不适|未随队|无缘名单|撕裂|骨折|手术|伤病困扰|阵容深度受考验|赛季报销/;
  const positiveRe=/复出|伤愈|恢复训练|恢复合练|回归阵容|重返阵容|解禁复出|可以出战|确认出战|伤愈归队/;
  const highRe=/主力|核心|头号|队长|门将|多人|多名重要球员|赛季报销|十字韧带|前十字韧带|骨折|手术/;
  const mediumRe=/伤缺|缺席|缺阵|停赛|受伤|无法出战|出战成疑|出场存疑|出战存疑|可能缺阵|可能缺席|伤疑|带伤|身体不适|未随队|撕裂|阵容深度受考验/;

  const sideFor=(text:string)=>{
    const h=homeName?text.indexOf(homeName):-1,a=awayName?text.indexOf(awayName):-1;
    const explicitHome=/^(?:主队|主场球队)/.test(text),explicitAway=/^(?:客队|客场球队)/.test(text);
    if(explicitHome){context="主队";return {side:"主队" as ShadowIntelSide,confidence:"高"};}
    if(explicitAway){context="客队";return {side:"客队" as ShadowIntelSide,confidence:"高"};}
    if(h>=0&&a>=0){
      const side=h<a?"主队":"客队";
      context=side;
      return {side,confidence:"高"};
    }
    const pos=h>=0?h:a;
    const named:ShadowIntelSide|null=h>=0?"主队":a>=0?"客队":null;
    // A team name appearing late in a paragraph is often the opponent/object
    // ("成为冰岛重点盯防目标"). Preserve the established subject in that case.
    if(named&&pos<=24){context=named;return {side:named,confidence:"高"};}
    if(context&&(/球队|球员|阵容|主帅|后卫|中场|前锋|门将|然而|此外|同时|关键/.test(text)||pos>24))
      return {side:context,confidence:"中"};
    if(named){context=named;return {side:named,confidence:"中"};}
    return {side:null,confidence:"低"};
  };

  for(const text of items){
    if(!text||/绝密情报|绝密爆料|伤停解析等/.test(text))continue;
    const sideInfo=sideFor(text);
    if(!sideInfo.side)continue;
    const adverse=adverseRe.test(text),positive=positiveRe.test(text);
    // Recovery/return language wins over generic injury words in the same sentence.
    let impact:ShadowIntelImpact|null=positive?"利好":adverse?"利空":null;
    if(!impact)continue;
    const type=/伤|停赛|缺|复出|伤愈|恢复|出战|撕裂|骨折|手术/.test(text)?"伤停":"阵容";
    let level="低";
    if(highRe.test(text))level="高";
    else if(mediumRe.test(text)||positive)level="中";
    categories.push({
      side:sideInfo.side,type,level,impact,
      confidence:sideInfo.confidence,
      summary:text.slice(0,220)
    });
  }

  const unique:any[]=[];const seen=new Set<string>();
  for(const x of categories){
    const k=[x.side,x.type,x.level,x.impact,x.summary].join("|");
    if(seen.has(k))continue;seen.add(k);unique.push(x);
  }
  const weight=(x:any)=>{
    const level=String(x.level)==="高"?2:String(x.level)==="中"?1:0.5;
    return (x.impact==="利空"?-1:1)*level*(x.confidence==="高"?1:0.75);
  };
  const homeScore=unique.filter(x=>x.side==="主队").reduce((s,x)=>s+weight(x),0);
  const awayScore=unique.filter(x=>x.side==="客队").reduce((s,x)=>s+weight(x),0);
  const homeAdverse=unique.some(x=>x.side==="主队"&&x.impact==="利空"&&["中","高"].includes(x.level));
  const awayAdverse=unique.some(x=>x.side==="客队"&&x.impact==="利空"&&["中","高"].includes(x.level));
  const homePositive=unique.some(x=>x.side==="主队"&&x.impact==="利好"&&["中","高"].includes(x.level));
  const awayPositive=unique.some(x=>x.side==="客队"&&x.impact==="利好"&&["中","高"].includes(x.level));
  let impactSide="中性";
  if(homeAdverse&&awayAdverse)impactSide="双方利空";
  else if(homeAdverse&&homeScore<0)impactSide="主队利空";
  else if(awayAdverse&&awayScore<0)impactSide="客队利空";
  else if(homePositive&&homeScore>0)impactSide="主队利好";
  else if(awayPositive&&awayScore>0)impactSide="客队利好";
  const adverseLevels=unique.filter(x=>x.impact==="利空").map(x=>x.level);
  const impactLevel=adverseLevels.includes("高")?"高":adverseLevels.includes("中")?"中":unique.length?"低":"无";
  const confidence=unique.some(x=>x.confidence==="高")?"高":unique.some(x=>x.confidence==="中")?"中":"低";
  const reasons=unique.filter(x=>x.impact==="利空").sort((a,b)=>(b.level==="高"?2:b.level==="中"?1:0)-(a.level==="高"?2:a.level==="中"?1:0)).slice(0,3).map(x=>x.summary);
  return {
    impact_side:impactSide,
    impact_level:impactLevel,
    confidence,
    home_score:Number(homeScore.toFixed(2)),
    away_score:Number(awayScore.toFixed(2)),
    categories:unique.slice(0,8),
    adverse_reasons:[...new Set(reasons)],
    summary:impactSide==="中性"?"未识别到可确认的中高等级单方利空":
      impactSide+" · "+impactLevel+(reasons[0]?(" · "+reasons[0]):"")
  };
}
function buildShadowAnalysis(market: any, exchange: any, intel: any, marketStatus: string, intelStatus: string, home = "", away = "") {
  const s = exchange?.selections || {};
  const p99 = { home:nval(s.home?.average_probability_pct), draw:nval(s.draw?.average_probability_pct), away:nval(s.away?.average_probability_pct) };
  const bfShare = { home:nval(s.home?.betfair_share_pct), draw:nval(s.draw?.betfair_share_pct), away:nval(s.away?.betfair_share_pct) };
  const bfHeat = { home:nval(s.home?.betfair_cold_heat), draw:nval(s.draw?.betfair_cold_heat), away:nval(s.away?.betfair_cold_heat) };
  const bfProfit = { home:nval(s.home?.betfair_profit_index), draw:nval(s.draw?.betfair_profit_index), away:nval(s.away?.betfair_profit_index) };
  const pTop=maxDir(p99), bfTop=maxDir(bfShare);
  const kelly=summarizeKelly(market?.bookmakers || []);
  const kellyDir=kelly?.lowest_direction || null;
  const cleanInj=safeIntelItems(intel?.injury_items || []);
  const cleanHome=safeIntelItems(intel?.home_items || []);
  const cleanAway=safeIntelItems(intel?.away_items || []);
  const intelSemantic=semanticIntel(intel,home,away);
  let points=0;
  const flags:string[]=[];
  if(pTop && bfTop){
    if(pTop.direction!==bfTop.direction){
      points+=2;
      flags.push("99家与必发资金方向分歧");
      const base=nval((p99 as any)[bfTop.direction]);
      if(bfTop.value>=50 && base!==null && bfTop.value-base>=15){
        points+=1; flags.push("必发出现强反向资金");
      }
    }else if(bfTop.value>=70){
      flags.push("99家与必发同向且资金集中");
    }else{
      flags.push("99家与必发方向一致");
    }
  }
  const drawShare=bfShare.draw, drawHeat=bfHeat.draw;
  if((drawShare!==null && drawShare>=40) || (drawHeat!==null && drawHeat>=100)){
    points+=2; flags.push("平局交易异常活跃");
  }
  const extremeHeat=Math.max(...["home","draw","away"].map(k=>Math.abs(nval((bfHeat as any)[k]) ?? 0)));
  if(extremeHeat>=150){ points+=1; flags.push("必发冷热出现极端值"); }
  const minProfit=Math.min(...["home","draw","away"].map(k=>nval((bfProfit as any)[k]) ?? 999));
  if(minProfit<=-100){ points+=1; flags.push("必发盈亏指数存在明显负值"); }
  if(kellyDir && pTop && kellyDir!==pTop.direction){ points+=1; flags.push("凯利最低方向与99家主方向不同"); }
  if(cleanInj.length>=3){ points+=1; flags.push("伤停/阵容信息较多"); }
  const hasMarket=!!(pTop || bfTop || kellyDir);
  let level="数据不足";
  if(hasMarket){
    if(points>=4) level="重点异常";
    else if(points>=2) level="分歧观察";
    else if(pTop && bfTop && pTop.direction===bfTop.direction) level="同向强化";
    else level="常规观察";
  }
  const bits:string[]=[];
  if(pTop) bits.push("99家偏"+SHADOW_DIR_ZH[pTop.direction]+" "+pTop.value.toFixed(1)+"%");
  if(bfTop) bits.push("必发资金偏"+SHADOW_DIR_ZH[bfTop.direction]+" "+bfTop.value.toFixed(1)+"%");
  if(kellyDir) bits.push("凯利最低方向"+SHADOW_DIR_ZH[kellyDir]);
  if(cleanInj.length) bits.push("有效伤停/阵容信息"+cleanInj.length+"条");
  if(flags.length) bits.push(flags.slice(0,3).join("；"));
  return {
    shadow_only:true,
    level,
    anomaly_points:points,
    summary:bits.length?bits.join("；"):"当前影子源不足，暂不形成市场结论",
    market_99:{ top:pTop?SHADOW_DIR_ZH[pTop.direction]:null, probabilities_pct:p99 },
    betfair:{ top:bfTop?SHADOW_DIR_ZH[bfTop.direction]:null, share_pct:bfShare, cold_heat:bfHeat, profit_index:bfProfit },
    kelly:{ status:marketStatus, complete_count:kelly?.complete_count||0, lowest_direction:kellyDir?SHADOW_DIR_ZH[kellyDir]:null, lowest_value:kelly?.lowest_value??null, average:kelly?.average||null },
    intelligence:{
      status:intelStatus,
      injury_count:cleanInj.length,
      home_count:cleanHome.length,
      away_count:cleanAway.length,
      highlights:[...new Set([...cleanInj,...cleanHome,...cleanAway])].slice(0,3),
      impact_side:intelSemantic.impact_side,
      impact_level:intelSemantic.impact_level,
      confidence:intelSemantic.confidence,
      home_score:intelSemantic.home_score,
      away_score:intelSemantic.away_score,
      categories:intelSemantic.categories,
      adverse_reasons:intelSemantic.adverse_reasons,
      semantic_summary:intelSemantic.summary
    },
    flags
  };
}

// One customer-safe projection of the saved shadow analysis.  All VIP and
// production bridge views use this exact shape; raw source URLs, source ids,
// scoring thresholds and administrator-only fields stay out of it.
function publicShadowAnalysis(row: any) {
  const a = row?.analysis && typeof row.analysis === "object" ? row.analysis : {};
  const market99 = a?.market_99 && typeof a.market_99 === "object" ? a.market_99 : {};
  const betfair = a?.betfair && typeof a.betfair === "object" ? a.betfair : {};
  const kelly = a?.kelly && typeof a.kelly === "object" ? a.kelly : {};
  const intel = a?.intelligence && typeof a.intelligence === "object" ? a.intelligence : {};
  const numberOrNull = (value: unknown) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
  const trio = (value: any) => ({
    home: numberOrNull(value?.home),
    draw: numberOrNull(value?.draw),
    away: numberOrNull(value?.away),
  });
  return {
    market_99: {
      probabilities_pct: trio(market99?.probabilities_pct),
      top: market99?.top ?? null,
    },
    betfair: {
      share_pct: trio(betfair?.share_pct),
      top: betfair?.top ?? null,
      cold_heat: trio(betfair?.cold_heat),
      profit_index: trio(betfair?.profit_index),
    },
    kelly: {
      lowest_direction: kelly?.lowest_direction ?? null,
      lowest_value: numberOrNull(kelly?.lowest_value),
      complete_count: Number.isFinite(Number(kelly?.complete_count)) ? Number(kelly.complete_count) : 0,
    },
    intelligence: {
      highlights: safeIntelItems(intel?.highlights || []).slice(0, 3),
      injury_count: Number.isFinite(Number(intel?.injury_count)) ? Number(intel.injury_count) : 0,
      impact_side: intel?.impact_side ?? null,
      impact_level: intel?.impact_level ?? null,
    },
    flags: safeIntelItems(Array.isArray(a?.flags) ? a.flags : []).slice(0, 6),
    capturedAt: row?.captured_at ?? null,
  };
}

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: CORS });
}
async function requireProductionBridge(req: Request) {
  const bridgeToken=req.headers.get("x-soren-bridge-token")?.trim()??"";
  if(!bridgeToken)return {ok:false as const,response:json({ok:false,error:"BRIDGE_AUTH_REQUIRED"},401)};
  const authHeader="Bearer "+bridgeToken;
  try{
    const response=await fetch(CUSTOMER_API+"?view=shadow-bridge-auth",{
      headers:{apikey:bridgeToken},
      signal:AbortSignal.timeout(8_000),
    });
    const data=await response.json().catch(()=>null);
    if(!response.ok||data?.ok!==true||data?.bridge!=="shadow-risk-v1")
      return {ok:false as const,response:json({ok:false,error:"BRIDGE_FORBIDDEN"},403)};
    return {ok:true as const};
  }catch(error){
    console.error("SHADOW_BRIDGE_AUTH_FAILED",error);
    return {ok:false as const,response:json({ok:false,error:"BRIDGE_AUTH_UNAVAILABLE"},503)};
  }
}

async function serveRiskFeed(req:Request,u:URL){
  const auth=await requireProductionBridge(req);
  if(!auth.ok)return auth.response;
  const date=u.searchParams.get("date")||"";
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return json({ok:false,error:"VALID_DATE_REQUIRED"},400);

  const {data:offerings,error:offeringError}=await sb.from("jc_offerings_2026")
    .select("id,offer_date,match_no,home_team,away_team,kickoff_local")
    .eq("offer_date",date).order("match_no");
  if(offeringError)throw offeringError;
  const list=offerings??[];
  const ids=list.map((x:any)=>Number(x.id)).filter(Number.isFinite);
  if(!ids.length)return json({ok:true,date,count:0,rows:[],updatedAt:new Date().toISOString()});

  const {data:analysisRows,error:analysisError}=await sb.from("hao_okooo_analysis_shadow_v01")
    .select("offering_id,analysis,captured_at,timing_quality,market_status,intel_status")
    .in("offering_id",ids).order("captured_at",{ascending:false}).limit(600);
  if(analysisError)throw analysisError;

  const byOffering=new Map<number,any[]>();
  for(const row of analysisRows??[]){
    const id=Number((row as any).offering_id);
    if(!Number.isFinite(id))continue;
    if(!byOffering.has(id))byOffering.set(id,[]);
    byOffering.get(id)!.push(row);
  }

  const compact=(row:any)=>{
    const a=(row?.analysis&&typeof row.analysis==="object")?row.analysis:{};
    const intel=(a?.intelligence&&typeof a.intelligence==="object")?a.intelligence:{};
    const market99=(a?.market_99&&typeof a.market_99==="object")?a.market_99:{};
    const betfair=(a?.betfair&&typeof a.betfair==="object")?a.betfair:{};
    const kelly=(a?.kelly&&typeof a.kelly==="object")?a.kelly:{};
    return {
      capturedAt:row?.captured_at??null,
      timingQuality:row?.timing_quality??null,
      marketStatus:row?.market_status??null,
      intelStatus:row?.intel_status??null,
      market:{
        market99Top:market99?.top??null,
        market99Probabilities:market99?.probabilities_pct??null,
        betfairTop:betfair?.top??null,
        betfairShare:betfair?.share_pct??null,
        betfairHeat:betfair?.cold_heat??null,
        betfairProfit:betfair?.profit_index??null,
        kellyTop:kelly?.lowest_direction??null,
        kellyValue:kelly?.lowest_value??null,
        kellyComplete:Number.isFinite(Number(kelly?.complete_count))?Number(kelly.complete_count):0,
        anomalyPoints:Number.isFinite(Number(a?.anomaly_points))?Number(a.anomaly_points):0,
        level:a?.level??null,
        flags:Array.isArray(a?.flags)?a.flags.map((x:any)=>String(x)).slice(0,6):[],
      },
      intelligence:{
        injuryCount:Number.isFinite(Number(intel?.injury_count))?Number(intel.injury_count):0,
        homeCount:Number.isFinite(Number(intel?.home_count))?Number(intel.home_count):0,
        awayCount:Number.isFinite(Number(intel?.away_count))?Number(intel.away_count):0,
        highlights:safeIntelItems(intel?.highlights||[]).slice(0,3),
        impactSide:intel?.impact_side??null,
        impactLevel:intel?.impact_level??null,
        confidence:intel?.confidence??null,
        categories:Array.isArray(intel?.categories)?intel.categories.slice(0,8):[],
        adverseReasons:safeIntelItems(intel?.adverse_reasons||[]).slice(0,3),
        semanticSummary:intel?.semantic_summary??null,
      },
      analysis:publicShadowAnalysis(row),
    };
  };

  const rows=list.map((off:any)=>{
    const kickoff=Date.parse(String(off.kickoff_local??"").replace(" ","T")+"+08:00");
    const valid=(byOffering.get(Number(off.id))??[]).filter((row:any)=>{
      const captured=Date.parse(String(row?.captured_at??""));
      const tq=String(row?.timing_quality??"");
      return Number.isFinite(captured)&&(!Number.isFinite(kickoff)||captured<kickoff)&&/^PREMATCH/.test(tq);
    }).slice(0,2);
    const latest=valid[0]?compact(valid[0]):null;
    const history=valid.map(compact);
    return {
      no:String(off.match_no).padStart(3,"0"),
      home:off.home_team,
      away:off.away_team,
      kickoffLocal:off.kickoff_local,
      latest,
      history,
    };
  }).filter((x:any)=>x.latest!==null);

  return json({ok:true,date,count:rows.length,rows,updatedAt:new Date().toISOString()});
}

async function requireCustomerVip(req: Request) {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!token) return { ok: false as const, response: json({ ok: false, error: "LOGIN_REQUIRED" }, 401) };
  try {
    const response = await fetch(CUSTOMER_API + "?view=membership", {
      headers: { Authorization: "Bearer " + token, apikey: CUSTOMER_PUBLISHABLE_KEY },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { ok: false as const, response: json({ ok: false, error: response.status === 401 ? "LOGIN_REQUIRED" : "VIP_CHECK_FAILED" }, response.status === 401 ? 401 : 403) };
    const data = await response.json();
    if (data?.ok !== true || data?.membership?.vipActive !== true)
      return { ok: false as const, response: json({ ok: false, error: "VIP_MEMBERSHIP_REQUIRED" }, 403) };
    return { ok: true as const };
  } catch (error) {
    console.error("SHADOW_VIP_CHECK_FAILED", error);
    return { ok: false as const, response: json({ ok: false, error: "VIP_CHECK_UNAVAILABLE" }, 503) };
  }
}

async function serveMemberIntel(req: Request, u: URL) {
  const auth = await requireCustomerVip(req);
  if (!auth.ok) return auth.response;
  const date = u.searchParams.get("date") || "";
  const no = u.searchParams.get("no") || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{3}$/.test(no))
    return json({ ok: false, error: "INVALID_MATCH_ID" }, 400);

  const { data: offering, error: offeringError } = await sb.from("jc_offerings_2026")
    .select("id,offer_date,match_no,league,home_team,away_team,kickoff_local")
    .eq("offer_date", date).eq("match_no", Number(no)).maybeSingle();
  if (offeringError) throw offeringError;
  if (!offering) return json({ ok: false, error: "MATCH_NOT_FOUND" }, 404);

  const [intelResult, analysisResult] = await Promise.all([
    sb.from("hao_okooo_intel_shadow_v01")
      .select("home_items,away_items,injury_items,captured_at,timing_quality,fetch_status")
      .eq("offering_id", offering.id).eq("fetch_status","ok")
      .order("captured_at", { ascending: false }).limit(1).maybeSingle(),
    sb.from("hao_okooo_analysis_shadow_v01")
      .select("analysis,captured_at,timing_quality,intel_status")
      .eq("offering_id", offering.id)
      .order("captured_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (intelResult.error) throw intelResult.error;
  if (analysisResult.error) throw analysisResult.error;

  const intel = intelResult.data;
  const analysis = analysisResult.data;
  const analysisPayload = analysis?.analysis && typeof analysis.analysis === "object" ? analysis.analysis : {};
  const analysisIntel = analysisPayload?.intelligence && typeof analysisPayload.intelligence === "object" ? analysisPayload.intelligence : {};
  const highlightsFromAnalysis = safeIntelItems(analysisIntel?.highlights || []);
  const injuryItems = safeIntelItems(intel?.injury_items || []);
  const homeItems = safeIntelItems(intel?.home_items || []);
  const awayItems = safeIntelItems(intel?.away_items || []);
  const fallbackHighlights = [...new Set([...injuryItems, ...homeItems, ...awayItems])].slice(0, 3);
  const highlights = (highlightsFromAnalysis.length ? highlightsFromAnalysis : fallbackHighlights).slice(0, 3);
  const flags = safeIntelItems(Array.isArray(analysisPayload?.flags) ? analysisPayload.flags : []).slice(0, 5);
  const publicAnalysis = analysis ? publicShadowAnalysis(analysis) : null;

  return json({
    ok: true,
    match: {
      date: String(offering.offer_date),
      no: String(offering.match_no).padStart(3, "0"),
      home: offering.home_team,
      away: offering.away_team,
    },
    intelligence: {
      available: highlights.length > 0,
      highlights,
      injuryCount: Number.isFinite(Number(analysisIntel?.injury_count)) ? Number(analysisIntel.injury_count) : injuryItems.length,
      homeCount: Number.isFinite(Number(analysisIntel?.home_count)) ? Number(analysisIntel.home_count) : homeItems.length,
      awayCount: Number.isFinite(Number(analysisIntel?.away_count)) ? Number(analysisIntel.away_count) : awayItems.length,
      flags,
      impactSide: analysisIntel?.impact_side ?? null,
      impactLevel: analysisIntel?.impact_level ?? null,
      confidence: analysisIntel?.confidence ?? null,
      categories: Array.isArray(analysisIntel?.categories) ? analysisIntel.categories.slice(0,8) : [],
      adverseReasons: safeIntelItems(analysisIntel?.adverse_reasons || []).slice(0,3),
      semanticSummary: analysisIntel?.semantic_summary ?? null,
      capturedAt: analysis?.captured_at ?? intel?.captured_at ?? null,
      timingQuality: analysis?.timing_quality ?? intel?.timing_quality ?? null,
    },
    analysis: publicAnalysis,
    updatedAt: new Date().toISOString(),
  });
}

async function requireCustomerAdmin(req: Request) {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!token) return { ok: false as const, response: json({ ok: false, error: "LOGIN_REQUIRED" }, 401) };
  try {
    const response = await fetch(CUSTOMER_API + "?view=membership", {
      headers: { Authorization: "Bearer " + token, apikey: CUSTOMER_PUBLISHABLE_KEY },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { ok: false as const, response: json({ ok: false, error: response.status === 401 ? "LOGIN_REQUIRED" : "ADMIN_CHECK_FAILED" }, response.status === 401 ? 401 : 403) };
    const data = await response.json();
    if (data?.ok !== true || data?.membership?.isAdmin !== true)
      return { ok: false as const, response: json({ ok: false, error: "ADMIN_REQUIRED" }, 403) };
    return { ok: true as const };
  } catch (error) {
    console.error("SHADOW_ADMIN_CHECK_FAILED", error);
    return { ok: false as const, response: json({ ok: false, error: "ADMIN_CHECK_UNAVAILABLE" }, 503) };
  }
}
function safeIntelItems(value: unknown) {
  if (!Array.isArray(value)) return [];
  const clean = (v: unknown) => String(v || "")
    .replace(/\\+["']?\s*\/>/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
  return [...new Set(value.map(clean)
    .filter((x) => x.length >= 8 && !/绝密情报|绝密爆料|伤停解析等/.test(x)))].slice(0, 12);
}
async function serveAdminPreview(req: Request, u: URL) {
  const auth = await requireCustomerAdmin(req);
  if (!auth.ok) return auth.response;
  const date = u.searchParams.get("date") || "";
  const no = u.searchParams.get("no") || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{3}$/.test(no))
    return json({ ok: false, error: "INVALID_MATCH_ID" }, 400);
  const { data: offering, error: offeringError } = await sb.from("jc_offerings_2026")
    .select("id,offer_date,match_no,league,home_team,away_team,kickoff_local")
    .eq("offer_date", date).eq("match_no", Number(no)).maybeSingle();
  if (offeringError) throw offeringError;
  if (!offering) return json({ ok: false, error: "MATCH_NOT_FOUND" }, 404);
  const [marketResult, intelResult, analysisResult] = await Promise.all([
    sb.from("hao_okooo_market_shadow_v01")
      .select("source_match_id,source_url,bookmaker_count,avg_home,avg_draw,avg_away,market_payload,captured_at,timing_quality,fetch_status")
      .eq("offering_id", offering.id).order("captured_at", { ascending: false }).limit(1).maybeSingle(),
    sb.from("hao_okooo_intel_shadow_v01")
      .select("source_match_id,source_url,home_items,away_items,injury_items,captured_at,timing_quality,fetch_status")
      .eq("offering_id", offering.id).order("captured_at", { ascending: false }).limit(1).maybeSingle(),
    sb.from("hao_okooo_analysis_shadow_v01")
      .select("analysis,captured_at,timing_quality,market_status,intel_status")
      .eq("offering_id", offering.id).order("captured_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (marketResult.error) throw marketResult.error;
  if (intelResult.error) throw intelResult.error;
  if (analysisResult.error) throw analysisResult.error;
  const market = marketResult.data;
  const intel = intelResult.data;
  const analysis = analysisResult.data;
  return json({
    ok: true,
    shadowOnly: true,
    match: {
      date: String(offering.offer_date), no: String(offering.match_no).padStart(3, "0"),
      league: offering.league, home: offering.home_team, away: offering.away_team,
      kickoffLocal: offering.kickoff_local,
    },
    market: market ? {
      status: market.fetch_status, bookmakerCount: market.bookmaker_count,
      average: { home: market.avg_home, draw: market.avg_draw, away: market.avg_away },
      kelly: market.market_payload?.kelly_summary || summarizeKelly(market.market_payload?.bookmakers || []),
      exchange: market.market_payload?.exchange || null,
      capturedAt: market.captured_at, timingQuality: market.timing_quality,
      sourceMatchId: market.source_match_id, sourceUrl: market.source_url,
    } : null,
    intelligence: intel ? {
      status: intel.fetch_status,
      homeItems: safeIntelItems(intel.home_items), awayItems: safeIntelItems(intel.away_items),
      injuryItems: safeIntelItems(intel.injury_items),
      capturedAt: intel.captured_at, timingQuality: intel.timing_quality,
      sourceMatchId: intel.source_match_id, sourceUrl: intel.source_url,
    } : null,
    analysis: analysis ? { ...analysis.analysis, capturedAt: analysis.captured_at, timingQuality: analysis.timing_quality } :
      buildShadowAnalysis(market?.market_payload ? { bookmakers: market.market_payload?.bookmakers || [] } : null,
        market?.market_payload?.exchange || null,
        intel ? { home_items:intel.home_items, away_items:intel.away_items, injury_items:intel.injury_items } : null,
        market?.fetch_status || "missing", intel?.fetch_status || "missing", offering.home_team, offering.away_team),
    updatedAt: new Date().toISOString(),
  });
}

Deno.serve(async (req) => {
  const u = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (u.searchParams.get("view") === "risk-feed") {
    if (req.method !== "GET") return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
    try { return await serveRiskFeed(req, u); }
    catch (error) {
      console.error("SHADOW_RISK_FEED_FAILED", error);
      return json({ ok: false, error: "RISK_FEED_UNAVAILABLE" }, 502);
    }
  }
  if (u.searchParams.get("view") === "member-intel") {
    if (req.method !== "GET") return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
    try { return await serveMemberIntel(req, u); }
    catch (error) {
      console.error("SHADOW_MEMBER_INTEL_FAILED", error);
      return json({ ok: false, error: "MEMBER_INTEL_UNAVAILABLE" }, 502);
    }
  }
  if (u.searchParams.get("view") === "admin-preview") {
    if (req.method !== "GET") return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
    try { return await serveAdminPreview(req, u); }
    catch (error) {
      console.error("SHADOW_PREVIEW_FAILED", error);
      return json({ ok: false, error: "SHADOW_PREVIEW_UNAVAILABLE" }, 502);
    }
  }
  if (u.searchParams.get("jsprobe") === "1") {
    const targets = [
      "https://imgv1.okoooimg.cn/min/?b=JS&f=dataanalysis%2fnewfootvictorysp.js&v=202602271022",
      "https://imgv1.okoooimg.cn/min/?b=JS&f=dataanalysis%2fpushdata.js,dataanalysis%2fheaderdata.js&v=202603181616",
    ];
    const out: any[] = [];
    for (const target of targets) {
      try {
        const p = await fetchHtml(target, "https://www.okooo.com/");
        const hits = [...p.html.matchAll(/.{0,220}(?:ajax|url|odds|matchid|betting_type|company).{0,420}/gi)]
          .map((m) => m[0]).slice(0, 80);
        out.push({ target, bytes: p.bytes, hits });
      } catch (e) { out.push({ target, error: String(e) }); }
    }
    return Response.json({ ok: true, jsprobe: out });
  }
  const date = u.searchParams.get("date") || bjtDate();
  const dry = u.searchParams.get("dry") === "1";
  const debug = dry && u.searchParams.get("debug") === "1";
  const fromNo = Math.max(1, Number(u.searchParams.get("from") || 1));
  const toNo = Math.min(999, Number(u.searchParams.get("to") || 15));
  const now = new Date().toISOString();
  try {
    const { data: offerings, error } = await sb.from("jc_offerings_2026")
      .select("id,match_no,home_team,away_team,kickoff_local")
      .eq("offer_date", date).gte("match_no", fromNo).lte("match_no", toNo).order("match_no");
    if (error) throw error;
    const listPages = await Promise.allSettled([
      "https://www.okooo.com/jingcai/", "https://www.okooo.com/jingcai/shuju/", `https://www.okooo.com/jingcai/${date}/`,
    ].map((url) => fetchHtml(url)));
    let sourceRows: any[] = [];
    for (const page of listPages) if (page.status === "fulfilled") sourceRows.push(...parseRows(page.value.html, page.value.url));
    sourceRows = [...new Map(sourceRows.map((r) => [[r.mid, r.no, r.kickoff, r.home, r.away].join("|"), r])).values()];

    const results: any[] = [];
    for (const offering of offerings || []) {
      const sameNo = sourceRows.filter((r) => Number(r.no) === Number(offering.match_no));
      const strict = sameNo.filter((r) => (r.homeVariants || [r.home]).some((x: string) => one(x, offering.home_team))
        && (r.awayVariants || [r.away]).some((x: string) => one(x, offering.away_team)));
      const near = sameNo.filter((r) => r.kickoff && Math.abs(
        new Date(String(r.kickoff).replace(" ", "T") + "+08:00").getTime() -
        new Date(String(offering.kickoff_local).replace(" ", "T") + "+08:00").getTime(),
      ) <= 10 * 60 * 1000);
      const candidates = strict.length ? strict : (near.length === 1 ? near : []);
      const best = candidates.sort((a, b) => Math.abs(new Date(String(a.kickoff).replace(" ", "T") + "+08:00").getTime() - new Date(String(offering.kickoff_local).replace(" ", "T") + "+08:00").getTime()) - Math.abs(new Date(String(b.kickoff).replace(" ", "T") + "+08:00").getTime() - new Date(String(offering.kickoff_local).replace(" ", "T") + "+08:00").getTime()))[0];
      if (!best?.mid) { results.push({ match_no: offering.match_no, status: "identity_unconfirmed", candidates: sameNo.length }); continue; }
      const t = timing(offering.kickoff_local);
      if (!t.eligible) { results.push({ match_no: offering.match_no, mid: best.mid, status: "post_kickoff_rejected", timing_quality: t.quality }); continue; }
      const base = `https://www.okooo.com/soccer/match/${best.mid}`;
      const oddsShell = await Promise.resolve().then(() => fetchFirst([
        `${base}/odds/`, `https://m.okooo.com/soccer/match/${best.mid}/odds/`,
      ], `${base}/`)).then((value) => ({ status: "fulfilled" as const, value }), (reason) => ({ status: "rejected" as const, reason }));
      let oddsPage = oddsShell.status === "fulfilled"
        ? await Promise.resolve().then(() => fetchHtml(
          `${base}/odds/ajax/?page=0&all=1&companytype=BaijiaBooks&type=1`, oddsShell.value.url,
        )).then((value) => ({ status: "fulfilled" as const, value }), (reason) => ({ status: "rejected" as const, reason }))
        : oddsShell;
      const mobileOddsUrl = oddsShell.status === "fulfilled"
        ? oddsShell.value.html.match(/mobile-agent[^>]+url=(https:\/\/m\.okooo\.com\/[^"' ;>]+)/i)?.[1]?.replace(/&amp;/g, "&")
        : null;
      let marketBlockedByLogin = oddsPage.status === "fulfilled" && /needLogin\s*=\s*['"]1['"]/.test(oddsPage.value.html);
      if (marketBlockedByLogin && mobileOddsUrl) {
        oddsPage = await Promise.resolve().then(() => fetchHtml(mobileOddsUrl, oddsShell.status === "fulfilled" ? oddsShell.value.url : `${base}/odds/`))
          .then((value) => ({ status: "fulfilled" as const, value }), (reason) => ({ status: "rejected" as const, reason }));
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
      const exchangePage = await Promise.resolve().then(() => fetchFirst([
        `${base}/exchanges/`, `https://m.okooo.com/soccer/match/${best.mid}/exchanges/`,
      ], `${base}/`)).then((value) => ({ status: "fulfilled" as const, value }), (reason) => ({ status: "rejected" as const, reason }));
      await new Promise((resolve) => setTimeout(resolve, 700));
      const intelPage = await Promise.resolve().then(() => fetchFirst([
        `${base}/qingbao/`, `https://m.okooo.com/soccer/match/${best.mid}/qingbao/`,
      ], `${base}/`)).then((value) => ({ status: "fulfilled" as const, value }), (reason) => ({ status: "rejected" as const, reason }));
      let marketStatus = "fetch_error", intelStatus = "fetch_error", exchangeStatus = "fetch_error";
      let market: any = null, intel: any = null, exchange: any = null;
      if (exchangePage.status === "fulfilled") {
        exchange = parseExchange(exchangePage.value.html);
        exchangeStatus = exchange.complete_count === 3 ? "ok" : (/needLogin\s*=\s*['\"]1['\"]|请登录|登录后/.test(exchangePage.value.html) ? "login_required" : "parse_empty");
      }
      const exchangePayload = exchangePage.status === "fulfilled" ? {
        status: exchangeStatus, endpoint: exchangePage.value.url, charset: exchangePage.value.enc,
        bytes: exchangePage.value.bytes, ...(exchange || {}),
      } : { status: "fetch_error", endpoint: `${base}/exchanges/`, error: String(exchangePage.reason) };
      if (oddsPage.status === "fulfilled") {
        market = parseOdds(oddsPage.value.html);
        marketStatus = market.bookmaker_count > 0 ? "ok" : "parse_empty";
        const payload = { source: "okooo", match_no: offering.match_no, home: best.home, away: best.away,
          endpoint: oddsPage.value.url, charset: oddsPage.value.enc, bytes: oddsPage.value.bytes, ...market,
          kelly_summary: summarizeKelly(market.bookmakers), exchange: exchangePayload };
        if (!dry) {
          const { error: writeError } = await sb.from("hao_okooo_market_shadow_v01").insert({
            offering_id: offering.id, source_match_id: best.mid, source_url: oddsPage.value.url,
            bookmaker_count: market.bookmaker_count, avg_home: market.avg_home, avg_draw: market.avg_draw, avg_away: market.avg_away,
            market_payload: payload, captured_at: now, timing_quality: t.quality, fetch_status: marketStatus, source_hash: await sha(payload),
          });
          if (writeError) throw writeError;
        }
      }
      if (oddsPage.status === "rejected") {
        marketStatus = marketBlockedByLogin ? "login_required" : "fetch_error";
        const payload = { source: "okooo", match_no: offering.match_no, home: best.home, away: best.away,
          endpoint: `${base}/odds/`, error: String(oddsPage.reason), blocked_by_login: marketBlockedByLogin,
          kelly_summary: summarizeKelly([]), exchange: exchangePayload };
        if (!dry) {
          const { error: writeError } = await sb.from("hao_okooo_market_shadow_v01").insert({
            offering_id: offering.id, source_match_id: best.mid, source_url: `${base}/odds/`,
            bookmaker_count: 0, avg_home: null, avg_draw: null, avg_away: null,
            market_payload: payload, captured_at: now, timing_quality: t.quality, fetch_status: marketStatus, source_hash: await sha(payload),
          });
          if (writeError) throw writeError;
        }
      }
      if (intelPage.status === "fulfilled") {
        intel = parseIntel(intelPage.value.html, best.home, best.away);
        intelStatus = intel.all_items.length > 0 ? "ok" : "parse_empty";
        const payload = { source: "okooo", match_no: offering.match_no, home: best.home, away: best.away,
          endpoint: intelPage.value.url, charset: intelPage.value.enc, bytes: intelPage.value.bytes, all_items: intel.all_items };
        if (!dry) {
          const { error: writeError } = await sb.from("hao_okooo_intel_shadow_v01").insert({
            offering_id: offering.id, source_match_id: best.mid, source_url: intelPage.value.url,
            home_items: intel.home_items, away_items: intel.away_items, injury_items: intel.injury_items,
            raw_payload: payload, captured_at: now, timing_quality: t.quality, fetch_status: intelStatus, source_hash: await sha(payload),
          });
          if (writeError) throw writeError;
        }
      }
      if (intelPage.status === "rejected") {
        const payload = { source: "okooo", match_no: offering.match_no, home: best.home, away: best.away,
          endpoint: `${base}/qingbao/`, error: String(intelPage.reason) };
        if (!dry) {
          const { error: writeError } = await sb.from("hao_okooo_intel_shadow_v01").insert({
            offering_id: offering.id, source_match_id: best.mid, source_url: `${base}/qingbao/`,
            home_items: [], away_items: [], injury_items: [], raw_payload: payload,
            captured_at: now, timing_quality: t.quality, fetch_status: intelStatus, source_hash: await sha(payload),
          });
          if (writeError) throw writeError;
        }
      }
      const shadowAnalysis = buildShadowAnalysis(market, exchange, intel, marketStatus, intelStatus, offering.home_team, offering.away_team);
      if (!dry) {
        const { error: analysisWriteError } = await sb.from("hao_okooo_analysis_shadow_v01").insert({
          offering_id: offering.id, source_match_id: best.mid, captured_at: now, timing_quality: t.quality,
          market_status: marketStatus, intel_status: intelStatus, analysis: shadowAnalysis, source_hash: await sha(shadowAnalysis),
        });
        if (analysisWriteError) throw analysisWriteError;
      }
      results.push({ match_no: offering.match_no, mid: best.mid, status: "mapped", timing_quality: t.quality,
        market: { status: marketStatus, bookmaker_count: market?.bookmaker_count || 0, averages: market ? [market.avg_home, market.avg_draw, market.avg_away] : null,
          kelly: market ? summarizeKelly(market.bookmakers) : summarizeKelly([]),
          exchange: { status: exchangeStatus, complete_count: exchange?.complete_count || 0, selections: exchange?.selections || null, notes: exchange?.notes || [] },
          debug_rows: debug && oddsPage.status === "fulfilled" ? oddsDebug(oddsPage.value.html) : undefined,
          debug_hints: debug && oddsPage.status === "fulfilled" ? pageHints(oddsPage.value.html) : undefined,
          debug_raw: debug && oddsPage.status === "fulfilled" ? oddsPage.value.html.slice(0, 1800) : undefined,
          debug_bytes: debug && oddsPage.status === "fulfilled" ? oddsPage.value.bytes : undefined,
          error: oddsPage.status === "rejected" ? String(oddsPage.reason) : null },
        intel: { status: intelStatus, total: intel?.all_items?.length || 0, home: intel?.home_items?.length || 0,
          away: intel?.away_items?.length || 0, injuries: intel?.injury_items?.length || 0,
          debug_items: debug ? intel?.all_items : undefined,
          error: intelPage.status === "rejected" ? String(intelPage.reason) : null } });
    }
    return Response.json({ ok: true, shadow_only: true, dry, date, range: [fromNo, toNo], expected: offerings?.length || 0, results });
  } catch (e) {
    return Response.json({ ok: false, shadow_only: true, error: String((e as Error)?.message || e) }, { status: 500 });
  }
});
