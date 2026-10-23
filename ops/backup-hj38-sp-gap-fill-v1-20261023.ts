import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const sb=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||Deno.env.get("SUPABASE_SECRET_KEY")!,{db:{schema:'ninety_core'},auth:{persistSession:false,autoRefreshToken:false}});
const API="https://qiulaile.vip/api/matches?matchType=0&mode=full";
function bjtDate(){return new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date())}
async function activeSaleDate(explicit:string|null){if(explicit)return explicit;const {data}=await sb.from("hao_source_health_v01").select("latest_pool_date,expected_matches").eq("source_code","jc_pool_discovery").maybeSingle();if(data?.latest_pool_date&&Number(data.expected_matches||0)>0)return String(data.latest_pool_date);return bjtDate()}
function wd(d:string){const dt=new Date(d+"T12:00:00+08:00");return ["周日","周一","周二","周三","周四","周五","周六"][dt.getUTCDay()]}
function norm(x:any){return String(x||"").replace(/\s+/g,"").replace(/足球俱乐部|俱乐部|FC$/ig,"")
 .replaceAll("阿斯顿维拉","维拉").replaceAll("巴塞罗那","巴萨").replaceAll("赫塔菲","赫塔费").replaceAll("TPS土尔库","TPS图尔").replaceAll("古比斯","库奥皮奥")
 .replaceAll("女王公园巡游者","女王巡游").replaceAll("女王公园巡游","女王巡游").replaceAll("女王巡游者","女王巡游")
 .replaceAll("雷克斯","雷克瑟姆").replaceAll("弗洛西诺尼","弗洛西诺").replaceAll("弗洛西诺内","弗洛西诺")
 .replaceAll("奥斯纳布鲁克","奥斯纳").replaceAll("米拉索尔","米拉索").replaceAll("町田泽维亚","町田泽维")}
function odds3(s:any){const a=String(s||"").match(/\d+\.\d+/g)?.map(Number)||[];return a.length>=3?a.slice(-3):null}
function lineFromRq(s:any){const m=String(s||"").match(/主\(([+-]\d+)\)/);return m?Number(m[1]):null}
async function sha(s:string){const d=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s));return [...new Uint8Array(d)].map(x=>x.toString(16).padStart(2,"0")).join("")}
Deno.serve(async req=>{
 if(req.headers.get("x-internal-key")!==Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"))return new Response("Forbidden",{status:403});
 const now=new Date().toISOString();
 try{
  const u=new URL(req.url),date=await activeSaleDate(u.searchParams.get("date")),weekday=wd(date);
  const {data:offs,error:oe}=await sb.from("jc_offerings_2026").select("id,match_no,home_team,away_team,handicap_line").eq("offer_date",date).order("match_no"); if(oe)throw oe;
  const recentCut=new Date(Date.now()-20*60*1000).toISOString();
  const {data:primaryRows}=await sb.from("hao_jc_sp_mirror_raw_v01").select("offering_id,market_type,fetched_at").eq("pool_date",date).in("source_code",["okooo_sp_mirror","500_sp_mirror","qiulaile_sp_mirror"]).eq("parse_status","verified_mirror").gte("fetched_at",recentCut);
  const primaryKeys=new Set((primaryRows||[]).map((x:any)=>String(x.offering_id)+"|"+String(x.market_type)));
  const r=await fetch(API,{headers:{"user-agent":"Mozilla/5.0","accept":"application/json"},signal:AbortSignal.timeout(15000)}); const tx=await r.text(); if(!r.ok)throw new Error("HTTP "+r.status+": "+tx.slice(0,120)); const j=JSON.parse(tx),matches=Array.isArray(j?.matches)?j.matches:[];
  const primaryFull=(offs||[]).every((o:any)=>primaryKeys.has(String(o.id)+"|HAD")&&primaryKeys.has(String(o.id)+"|HHAD"));
  const gapMap=new Map<string,string[]>();
  for(const o of offs||[]){const miss:string[]=[];for(const m of ["HAD","HHAD"])if(!primaryKeys.has(String(o.id)+"|"+m))miss.push(m);if(miss.length)gapMap.set(String(o.id),miss)}
  const gapExpected=gapMap.size;
  let matched=0,hadN=0,hhadN=0,written=0,filledGapMatches=0; const details:any[]=[];
  for(const o of offs||[]){
    const display=weekday+" "+String(o.match_no).padStart(3,"0");
    const needed=gapMap.get(String(o.id))||[];
    if(!needed.length){details.push({match_no:o.match_no,status:"no_gap_needed"});continue}
    const cand=matches.filter((m:any)=>Number(m.matchTypeValue)===0&&String(m.displayNo||"").trim()===display);
    const strict=cand.find((x:any)=>norm(x.home)===norm(o.home_team)&&norm(x.away)===norm(o.away_team));
    const m=strict;
    const identityMethod="displayNo+normalized_teams";
    if(!m){details.push({match_no:o.match_no,status:"identity_unconfirmed",needed,candidates:cand.map((x:any)=>({id:x.id,home:x.home,away:x.away}))});continue}
    matched++;
    const had=odds3(m.spfSp),hhad=odds3(m.rqspfSp),line=lineFromRq(m.rqspfSp)??o.handicap_line;
    const filled:string[]=[];
    const resolved:string[]=[];
    if(needed.includes("HAD")&&!had&&hhad){
      const raw={source_match_id:String(m.id),displayNo:m.displayNo,home:m.home,away:m.away,kickoff:m.kickoff,dayLabel:m.dayLabel,spfSp:m.spfSp,rqspfSp:m.rqspfSp,market:"HAD",availability:"MIRROR_UNAVAILABLE",identity_method:identityMethod};
      const hash=await sha(JSON.stringify(raw)+now.slice(0,16));
      const {error}=await sb.from("hao_jc_sp_mirror_raw_v01").insert({
        offering_id:o.id,pool_date:date,match_no:String(o.match_no).padStart(3,"0"),source_code:"qiulaile_sp_mirror",
        source_match_id:String(m.id),source_match_url:API,market_type:"HAD",handicap_line:null,
        home_sp:null,draw_sp:null,away_sp:null,snapshot_type:"current",captured_at:now,fetched_at:now,
        source_kind:"qiulaile_jc_market_availability",source_hash:hash,parse_status:"mirror_unavailable",raw_payload:raw
      }); if(error)throw error;
      resolved.push("HAD");
    }
    for(const g of [{market:"HAD",vals:had,line:null},{market:"HHAD",vals:hhad,line}]){
      if(!needed.includes(g.market)) continue;
      if(!g.vals||g.vals.some((x:number)=>!(x>1&&x<100)))continue;
      const raw={source_match_id:String(m.id),displayNo:m.displayNo,home:m.home,away:m.away,kickoff:m.kickoff,dayLabel:m.dayLabel,spfSp:m.spfSp,rqspfSp:m.rqspfSp,market:g.market,identity_method:identityMethod};
      const hash=await sha(JSON.stringify(raw)+now.slice(0,16));
      const {error}=await sb.from("hao_jc_sp_mirror_raw_v01").insert({
        offering_id:o.id,pool_date:date,match_no:String(o.match_no).padStart(3,"0"),source_code:"qiulaile_sp_mirror",
        source_match_id:String(m.id),source_match_url:API,market_type:g.market,handicap_line:g.line,
        home_sp:g.vals[0],draw_sp:g.vals[1],away_sp:g.vals[2],snapshot_type:"current",captured_at:now,fetched_at:now,
        source_kind:"qiulaile_structured_jc_mirror_strict_team_identity",source_hash:hash,parse_status:"verified_mirror",raw_payload:raw
      }); if(error)throw error; written++; filled.push(g.market); resolved.push(g.market); if(g.market==="HAD")hadN++;else hhadN++;
    }
    const gapFilled=needed.every((x:string)=>resolved.includes(x));
    if(gapFilled)filledGapMatches++;
    details.push({match_no:o.match_no,status:gapFilled?"gap_resolved":"gap_partial",source_match_id:m.id,needed,filled,resolved,had,hhad,line,identity_method:identityMethod});
  }
  const gapStatus=gapExpected===0||filledGapMatches===gapExpected?"ok":filledGapMatches>0?"partial":"error";
  await sb.from("hao_source_health_v01").upsert({
    source_code:"qiulaile_sp_mirror",source_role:"sporttery_sp_gap_fill_fallback",
    status:gapStatus,last_attempt_at:now,last_success_at:(gapExpected===0||filledGapMatches>0)?now:null,latest_pool_date:date,expected_matches:gapExpected,
    mapped_matches:matched,captured_matches:filledGapMatches,verified_matches:filledGapMatches,
    consecutive_failures:gapStatus==="error"?1:0,last_error:gapStatus==="error"?"unresolved SP gaps remain":null,
    notes:"GAP-FILL ONLY; MIRROR_UNAVAILABLE resolves mirror coverage without inventing odds and is not an official availability claim; expected means actual primary gaps.",updated_at:now
  },{onConflict:"source_code"});

  const combinedVerified=(offs?.length||0)-gapExpected+filledGapMatches;
  const combinedStatus=(offs?.length||0)>0&&combinedVerified===(offs?.length||0)?"ok":combinedVerified>0?"partial":"error";
  await sb.from("hao_source_health_v01").upsert({
    source_code:"jc_sp_combined",source_role:"sporttery_sp_combined_main_chain",
    status:combinedStatus,last_attempt_at:now,last_success_at:combinedVerified?now:null,latest_pool_date:date,
    expected_matches:offs?.length||0,mapped_matches:offs?.length||0,captured_matches:combinedVerified,verified_matches:combinedVerified,
    consecutive_failures:combinedStatus==="error"?1:0,last_error:combinedStatus==="ok"?null:"combined SP chain unresolved",
    notes:"Combined Okooo + 500 + Qiulaile; a match is complete when HHAD is verified and HAD is either verified or independently unavailable on current mirrors.",updated_at:now
  },{onConflict:"source_code"});

  return Response.json({ok:gapStatus!=="error",poolDate:date,gapExpected,filledGapMatches,combinedVerified,combinedStatus,matched,had:hadN,hhad:hhadN,written,details});
 }catch(e:any){return Response.json({ok:false,error:String(e?.message||e)},{status:500})}
});