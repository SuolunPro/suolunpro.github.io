import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {createClient} from "npm:@supabase/supabase-js@2.95.0";
const sb=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
const db=sb.schema("ninety_core");
const bjt=()=>new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
const n=(v:any)=>v===null||v===undefined||v===""?null:Number(v);
const fair=(r:any)=>{if(!r)return null;const z=[r.home_value,r.draw_value,r.away_value].map(n);if(!z.every(x=>x!==null&&Number.isFinite(x)&&x>1))return null;const inv=z.map(x=>1/x!),sum=inv.reduce((a,b)=>a+b,0);return inv.map(x=>100*x/sum)};
const ln=(x:any)=>{if(x===null||x===undefined)return null;const s=String(x).replace(/[−﹣]/g,"-");if(/^[-+]?\d+(?:\.\d+)?$/.test(s))return Number(s);const v=s.match(/^(-?)(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);if(!v)return null;return (v[1]==="-"?-1:1)*(Number(v[2])+Number(v[3]))/2};
const ok=(q:any,cut:number,ko:number)=>!!q&&q.data_quality==="verified"&&
 [q.captured_at,q.ingested_at].every((z:any)=>Number.isFinite(Date.parse(String(z)))&&Date.parse(String(z))<=cut&&Date.parse(String(z))<ko);
Deno.serve(async req=>{
 if(req.method!=="POST")return Response.json({ok:false,error:"METHOD"}, {status:405});
 const token=req.headers.get("x-ninety-collector-token")||"";
 if(token.length<32)return Response.json({ok:false,error:"AUTH"},{status:401});
 const chk=await db.rpc("soren_collector_token_valid_v1",{p_token:token});
 if(chk.error||chk.data!==true)return Response.json({ok:false,error:"AUTH"},{status:401});
 try{
  const date=String((await req.json().catch(()=>({}))).date||bjt());
  if(date!==bjt())return Response.json({ok:false,error:"CURRENT_DAY_ONLY"},{status:400});
  const [mm,hh,rr,bb,ww,ee]=await Promise.all([
   db.from("soren_matches").select("id,pool_date,match_no,home_team,away_team,kickoff_at,cutoff_at").eq("pool_date",date).limit(150),
   db.from("hao_console_predictions").select("id,run_id,match_no,home_team,away_team,top1,model_version,model_revision_tag,frozen_at,kickoff_bjt").eq("pool_date",date).order("updated_at",{ascending:false}).limit(400),
   db.from("hao_console_model_runs").select("id,formal_allowed,data_complete").order("id",{ascending:false}).limit(500),
   db.from("soren_market_behavior_v1").select("match_id,index_rows,exchange_scale,captured_at,prematch_verified,source_quality").eq("pool_date",date).order("captured_at",{ascending:false}).limit(350),
   db.from("soren_upset_warnings_v1").select("match_no,warning_direction,source_payload").eq("pool_date",date).in("warning_direction",["主队不胜","主队不败"]).limit(500),
   db.rpc("soren_cold_e_inputs_v1",{p_date:date})
  ]);
  for(const r of [mm,hh,rr,bb,ww,ee])if(r.error)throw r.error;
  const matches=mm.data||[],ids=matches.map((x:any)=>x.id);
  if(!ids.length)return Response.json({ok:true,checked:0,published:0});
  const markets=await db.from("soren_market_snapshots").select("match_id,source_code,market_type,snapshot_type,home_value,draw_value,away_value,line,home_water,away_water,payload,captured_at,ingested_at,data_quality").in("match_id",ids).order("captured_at",{ascending:false}).limit(3500);
  if(markets.error)throw markets.error;
  const runs=new Set((rr.data||[]).filter((x:any)=>x.formal_allowed===true&&x.data_complete===true).map((x:any)=>x.id));
  const done=new Set((ww.data||[]).filter((x:any)=>x.source_payload?.publish===true).map((x:any)=>String(x.match_no).padStart(3,"0")));
  const eMap=new Map((ee.data||[]).map((x:any)=>[Number(x.match_id),x]));
  const dow=new Date(date+"T12:00:00+08:00").getUTCDay();
  const sale=Date.parse(date+"T"+([0,6].includes(dow)?"23":"22")+":00:00+08:00");
  let checked=0,published=0;const matchesPublished:any[]=[];
  for(const m of matches){
   const no=String(m.match_no||"").padStart(3,"0"),ko=Date.parse(String(m.kickoff_at));
   if(done.has(no)||Date.now()>=Math.min(ko,sale)||!Number.isFinite(ko))continue;
   const h=(hh.data||[]).find((x:any)=>x.match_no===no&&x.home_team===m.home_team&&x.away_team===m.away_team&&runs.has(x.run_id)&&
     x.model_version==="3.8"&&["主胜","客胜"].includes(x.top1)&&Date.parse(String(x.kickoff_bjt))===ko&&Date.parse(String(x.frozen_at))<Math.min(sale,ko));
   if(!h)continue;checked++;
   const top=h.top1==="主胜"?0:2,cut=Math.min(ko,sale,Date.now(),m.cutoff_at?Date.parse(String(m.cutoff_at)):Infinity);
   const qs=(markets.data||[]).filter((x:any)=>x.match_id===m.id&&ok(x,cut,ko));
   const get=(c:string,t:string,s:string)=>qs.find((x:any)=>x.source_code===c&&x.market_type===t&&x.snapshot_type===s);
   const i=get("zucaijia_william","FT_1X2","initial"),u=get("zucaijia_william","FT_1X2","current"),fi=fair(i),fu=fair(u);
   const bf=(bb.data||[]).find((x:any)=>x.match_id===m.id&&x.prematch_verified===true&&
      String(x.source_quality).startsWith("okooo_exchange_exact_identity_prematch")&&Date.parse(String(x.captured_at))<=cut);
   const arows=bf?.index_rows,shares=Array.isArray(arows)&&arows.length===3?arows.map((x:any)=>n(x.bfShare)):[];
   const bv=shares.length===3&&shares.every((x:any)=>x!==null&&x>=0&&x<=100)&&Math.abs(shares.reduce((a:number,b:number)=>a+b,0)-100)<=1&&
     arows[0]?.team===m.home_team&&arows[1]?.team==="平局"&&arows[2]?.team===m.away_team;
   const btop=bv?shares.indexOf(Math.max(...shares)):-1;
   const A=bv&&btop!==top&&btop!==1,B=bv&&btop===1&&["适中","较大"].includes(String(bf.exchange_scale));
   const C=bv&&!!fi&&!!fu&&btop!==top&&fu[top]-fi[top]<=-7;
   const rise=!!i&&!!u&&Number(top===0?u.home_value:u.away_value)>Number(top===0?i.home_value:i.away_value);
   let firms=0;
   if(rise)for(const c of ["1","11","18","31"]){
      const x=get("zucaijia_asia4:"+c,"ASIAN_HANDICAP","initial"),y=get("zucaijia_asia4:"+c,"ASIAN_HANDICAP","current");
      const xh=ln(x?.payload?.original_line??x?.line),yh=ln(y?.payload?.original_line??y?.line);
      const w0=n(top===0?x?.home_water:x?.away_water),w1=n(top===0?y?.home_water:y?.away_water);
      if(x&&y&&xh!==null&&yh!==null&&w0!==null&&w0>0&&w1!==null&&w1>=1&&(top===0?yh-xh:xh-yh)>=.249999)firms++;
   }
   const D=rise&&firms>=2;const e:any=eMap.get(Number(m.id));
   const eok=(k:string,v:string)=>e?.[k+"_quality"]===v&&[e?.[k+"_captured_at"],e?.[k+"_ingested_at"]].every((x:any)=>Number.isFinite(Date.parse(String(x)))&&Date.parse(String(x))<=cut&&Date.parse(String(x))<ko);
   const sp=eok("sp","verified_mirror")?fair({home_value:e.sp_home,draw_value:e.sp_draw,away_value:e.sp_away}):null;
   const E1=!!sp&&sp[1]>=28&&eok("score","STRICT_PREMATCH_XG")&&String(e?.score_strict)==="true"&&String(e?.score_target_result_used)==="false"&&Number(e?.score_draw)>=.30&&Number(e?.score_draw)<=1;
   const ei=eok("william_initial","verified")?fair({home_value:e.william_initial_home,draw_value:e.william_initial_draw,away_value:e.william_initial_away}):null;
   const ec=eok("william_current","verified")?fair({home_value:e.william_current_home,draw_value:e.william_current_draw,away_value:e.william_current_away}):null;
   const E2=!!sp&&sp[1]>=28&&!!ei&&!!ec&&ec[1]-ei[1]>=1;
   const channels=[A?"A":null,B?"B":null,C?"C":null,D?"D":null,E1?"E1":null,E2?"E2":null].filter(Boolean);
   if(!channels.length)continue;
   const proof=channels.map((c:any)=>({A:"必发最高资金方向为反向胜负",B:"必发平局资金最多且成交量有效",C:"威廉主方向公平概率下降≥7pp且必发反向",D:"威廉升赔且两家以上亚洲机构深盘高水",E1:"官方SP与严格赛前比分均提示平局",E2:"官方SP与威廉市场变化均提示平局"} as any)[c]);
   const domains=[A||B?"market_behavior":null,C||D||E2?"william":null,D?"asian_market":null,E1||E2?"sporttery_market":null,E1?"strict_score":null].filter(Boolean);
   const direction=h.top1==="主胜"?"主队不胜":"主队不败",stamp=new Date().toISOString();
   const payload={publish:true,directionPublicationEligible:true,abc_verified:true,
     source:"SG_ABCDE_V2_ORIGINAL_GATES",channels,direction,originalTop1:h.top1,
     inputModelAt:h.frozen_at,modelRevision:h.model_revision_tag,result_fields_used:false,
     direction_basis:proof,customerRoute:{source:"SG_ABCDE_V2_ORIGINAL_GATES",type:"FOCUS_AVOID",
      direction,ftPicks:h.top1==="主胜"?["平","客胜"]:["主胜","平"]}};
   const pub=await db.from("soren_upset_warnings_v1").insert({
      id:Date.now()*100+Number(no),pool_date:date,match_no:no,home_team:m.home_team,away_team:m.away_team,
      kickoff_bjt:m.kickoff_at,source_model_version:"3.8",source_revision:h.model_revision_tag||"SG_3.8",
      warning_model_version:"SG_ABC_COLD_v2.2",risk_level:"高",risk_score:4,
      original_top1:h.top1,warning_direction:direction,alternative_pick:null,
      risk_basis:proof,direction_basis:proof,evidence_domains:domains,
      directional_domain_count:domains.length,source_frozen_at:stamp,
      result_fields_used:false,hur_direction_used:false,source_payload:payload,synced_at:stamp
   });
   if(pub.error)throw pub.error;
   done.add(no);published++;matchesPublished.push({no,direction,channels});
  }
  return Response.json({ok:true,date,checked,published,rows:matchesPublished});
 }catch(e){console.error("SG_ABC_PUBLISH",e);return Response.json({ok:false,error:"COLD_PUBLISH_UNAVAILABLE"},{status:503})}
});