import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {createClient} from "npm:@supabase/supabase-js@2";
const headers={"content-type":"application/json","access-control-allow-origin":"*","access-control-allow-headers":"authorization,apikey,content-type"};
const sb=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
const num=(x:any)=>x==null?null:Number.isFinite(Number(x))?Number(x):null;
const probs=(a:any)=>{const v=[num(a?.home),num(a?.draw),num(a?.away)];if(v.some(x=>x===null||x<=1))return null;const z=v.map(x=>1/x),t=z.reduce((a,b)=>a+b,0);return {home:100*z[0]/t,draw:100*z[1]/t,away:100*z[2]/t};};
const dir=(o:any)=>o.home>=o.draw&&o.home>=o.away?"主胜":o.draw>=o.away?"平":"客胜";
Deno.serve(async req=>{
 if(req.method==="OPTIONS")return new Response(null,{status:204,headers});
 const send=(v:any,status=200)=>new Response(JSON.stringify(v),{status,headers});
 const rawAuth=req.headers.get("authorization")||""; const jwt=rawAuth.startsWith("Bearer ")?rawAuth.slice(7):rawAuth;
 // This is paid member evidence, not an unauthenticated Singapore test page.
 if(!jwt)return send({ok:false,error:"LOGIN_REQUIRED"},401);
 const {data:auth,error:ae}=await sb.auth.getUser(jwt);
 if(ae||!auth.user)return send({ok:false,error:"LOGIN_REQUIRED"},401);
 const admin=auth.user.app_metadata?.role==="admin"||auth.user.app_metadata?.is_admin===true;
 const {data:member,error:me}=await sb.rpc("ninety_membership_status",{p_user_id:auth.user.id});
 if(me)return send({ok:false,error:"MEMBERSHIP_STATUS_UNAVAILABLE"},503);
 const vip=admin||(member?.active===true&&["vip_monthly","vip_manual","admin"].includes(String(member?.tier)));
 if(!vip)return send({ok:false,error:"VIP_MEMBERSHIP_REQUIRED"},403);
 const u=new URL(req.url),date=u.searchParams.get("date")||"",no=u.searchParams.get("no")||"";
 const proofContext=u.searchParams.get("context")==="cold"?"cold":"detail";
 if(!(date.length===10&&date[4]==="-"&&date[7]==="-"&&date.replaceAll("-","").split("").every(c=>c>="0"&&c<="9"))||!(no.length>=1&&no.length<=3&&no.split("").every(c=>c>="0"&&c<="9")))return send({ok:false,error:"INVALID_MATCH"},400);
 const key=date.replaceAll("-","")+"-"+no.padStart(3,"0");
 const {data:match}=await sb.schema("ninety_core").from("match_pool").select("match_key,match_no,home_team,away_team,league,kickoff_at").eq("match_key",key).maybeSingle();
 if(!match)return send({ok:false,error:"MATCH_NOT_FOUND"},404);

 // Singapore market master chain: verified William, Sporttery, Asian four-firm
 // snapshots + prematch Betfair. The original member-intel endpoint depended on
 // legacy match_pool/source_state, where today's 10 fixtures had ONLY official_sp.
 // Prefer actual production evidence. Never substitute one vendor's probability
 // for 99 independent companies, nor use data captured after a cold publication.
 const db=sb.schema("ninety_core");
 const {data:fixture,error:fe}=await db.from("soren_matches")
   .select("id,home_team,away_team,kickoff_at,cutoff_at,is_world_cup")
   .eq("pool_date",date).eq("match_no",no.padStart(3,"0")).maybeSingle();
 if(fe)return send({ok:false,error:"MATCH_IDENTITY_READ_FAILED"},503);
 if(fixture&&fixture.is_world_cup!==true&&fixture.home_team===match.home_team
   &&fixture.away_team===match.away_team
   &&Math.abs(Date.parse(fixture.kickoff_at)-Date.parse(match.kickoff_at))<=60000){
   const [marketRes,behaviorRes,warningsRes,intelligenceRes,archiveRes]=await Promise.all([
     db.from("soren_market_snapshots").select("source_code,market_type,snapshot_type,home_value,draw_value,away_value,line,home_water,away_water,payload,captured_at,ingested_at,data_quality")
       .eq("match_id",fixture.id).order("captured_at",{ascending:false}).limit(300),
     db.from("soren_market_behavior_v1").select("source_quality,exchange_scale,prematch_verified,index_rows,captured_at,home_team,away_team,kickoff_at")
       .eq("match_id",fixture.id).order("captured_at",{ascending:false}).limit(15),
     db.from("soren_upset_warnings_v1").select("home_team,away_team,warning_direction,source_frozen_at,synced_at,result_fields_used,hur_direction_used,directional_domain_count,source_payload")
       .eq("pool_date",date).eq("match_no",no.padStart(3,"0")).order("synced_at",{ascending:false}).limit(30),
     db.from("soren_intelligence_reports_v1").select("home_team,away_team,headline,highlights,source_code,quality,published_at,fetched_at")
       .eq("pool_date",date).eq("match_no",no.padStart(3,"0")).order("fetched_at",{ascending:false}).limit(20),
     db.from("soren_deep_market_snapshot_v1")
       .select("match_id,match_no,home_team,away_team,kickoff_at,captured_at,source_project,source_match_id,timing_quality,market_status,intel_status,analysis")
       .eq("pool_date",date).eq("match_no",no.padStart(3,"0"))
       .order("captured_at",{ascending:false}).limit(20)
   ]);
   for(const result of [marketRes,behaviorRes,warningsRes,intelligenceRes,archiveRes])
     if(result.error)return send({ok:false,error:"MARKET_EVIDENCE_READ_FAILED"},503);
   const now=Date.now(),ko=Date.parse(fixture.kickoff_at);
   const dow=new Date(date+"T12:00:00+08:00").getUTCDay();
   const sale=Date.parse(date+"T"+([0,6].includes(dow)?"23":"22")+":00:00+08:00");
   const cutoffTs=fixture.cutoff_at?Date.parse(fixture.cutoff_at):Infinity;
   const certified=(warningsRes.data||[]).find((w:any)=>
     ["主队不胜","主队不败"].includes(String(w.warning_direction))&&
     w.source_payload?.publish===true&&w.source_payload?.directionPublicationEligible===true&&
     w.result_fields_used===false&&w.hur_direction_used===false&&
     Number(w.directional_domain_count)>=2&&
     w.home_team===match.home_team&&w.away_team===match.away_team&&
     Number.isFinite(Date.parse(w.synced_at))&&Number.isFinite(Date.parse(w.source_frozen_at))&&
     Date.parse(w.source_frozen_at)<=Date.parse(w.synced_at)&&Date.parse(w.synced_at)<Math.min(ko,sale,now));
   const boundary=Math.min(ko,sale,cutoffTs,now,proofContext==="cold"&&certified?Date.parse(certified.synced_at):Infinity);
   const goodTime=(at:any)=>Number.isFinite(Date.parse(String(at||"")))&&Date.parse(String(at))<=boundary;
   const numeric=(v:any)=>v===null||v===undefined||v===""?null:
      (Number.isFinite(Number(v))?Number(v):null);
   const chance=(v:any)=>[numeric(v?.home),numeric(v?.draw),numeric(v?.away)];
   const complete=(a:any)=>Array.isArray(a)&&a.length===3&&a.every((v:any)=>v!==null&&v>=0&&v<=100);
   const selection=(a:number[]|null)=>a?["主胜","平","客胜"][a.indexOf(Math.max(...a))]:null;
   const validRows=(marketRes.data||[]).filter((x:any)=>
      goodTime(x.captured_at)&&goodTime(x.ingested_at)&&
      ((x.source_code==="zucaijia_william"&&x.data_quality==="verified")||
       (x.source_code.startsWith("zucaijia_asia4:")&&x.data_quality==="verified")||
       (x.source_code==="qiulaile_sp_mirror"&&x.data_quality==="verified_mirror")));
   const one=(code:string,type:string,phase:string)=>validRows.find((x:any)=>
      x.source_code===code&&x.market_type===type&&x.snapshot_type===phase);
   const odds=(x:any):number[]|null=>{const out=[numeric(x?.home_value),numeric(x?.draw_value),numeric(x?.away_value)];
     return out.every((v:any)=>v!==null&&v>1&&v<1000)?out as number[]:null};
   const implied=(out:number[]|null)=>{if(!out)return null;const inv=out.map(x=>1/x),sum=inv.reduce((a,b)=>a+b,0);
     return {home:100*inv[0]/sum,draw:100*inv[1]/sum,away:100*inv[2]/sum}};
   const wi=one("zucaijia_william","FT_1X2","initial"),wc=one("zucaijia_william","FT_1X2","current");
   const wOdds=odds(wc),initialOdds=odds(wi),sp=one("qiulaile_sp_mirror","HAD","current"),
     hsp=one("qiulaile_sp_mirror","HHAD","current");
   const behavior=(behaviorRes.data||[]).find((v:any)=>
     v.prematch_verified===true&&
     ["okooo_exchange_exact_identity_prematch_auto","okooo_exchange_exact_identity_prematch"].includes(String(v.source_quality))&&
     v.home_team===match.home_team&&v.away_team===match.away_team&&
     Math.abs(Date.parse(String(v.kickoff_at))-ko)<=60000&&goodTime(v.captured_at)&&
     Array.isArray(v.index_rows)&&v.index_rows.length===3&&
     v.index_rows[0]?.team===match.home_team&&v.index_rows[1]?.team==="平局"&&v.index_rows[2]?.team===match.away_team);
   const index=behavior?.index_rows||[];
   const trio=(k:string)=>index.length===3?{home:numeric(index[0]?.[k]),
     draw:numeric(index[1]?.[k]),away:numeric(index[2]?.[k])}:{home:null,draw:null,away:null};
   const shares=trio("bfShare"),fundArray=chance(shares);
   const fundReady=complete(fundArray)&&Math.abs((fundArray as number[]).reduce((a:number,b:number)=>a+b,0)-100)<=1;
   // True copy of the ORIGINAL old-Hao pregame market report (same screenshot
   // fields, same source timestamps). Preserve SG independence: no old HTTP or
   // database call is ever required at customer read time.
   const archived=(archiveRes.data||[]).find((x:any)=>x.match_id===fixture.id&&
      x.home_team===match.home_team&&x.away_team===match.away_team&&
      Math.abs(Date.parse(String(x.kickoff_at))-ko)<=60000&&
      ["OLD_HJ_PREMATCH_SOURCE_ARCHIVE_ONLY","SG_INDEPENDENT_NATIVE_OKOOO"].includes(x.source_project)&&
      ["PREMATCH","VERIFIED_PREMATCH"].some((prefix:string)=>String(x.timing_quality||"").startsWith(prefix))&&
      goodTime(x.captured_at)&&
      x.analysis&&typeof x.analysis==="object"&&!Array.isArray(x.analysis));
   const frozenWarning=certified?.source_payload?.focusGate?.shadow_analysis||
      certified?.source_payload?.focusGate?.shadowAnalysis||null;
   const warningAt=frozenWarning?.capturedAt??frozenWarning?.captured_at??null;
   const safeWarning=frozenWarning&&goodTime(warningAt)?frozenWarning:null;
   const safeShadow=(proofContext==="cold"&&safeWarning)?safeWarning:archived?.analysis??safeWarning;
   const shadowAt=(proofContext==="cold"&&safeWarning)?warningAt:
      archived?.captured_at??(safeWarning?warningAt:null);
   const shadow99=safeShadow?.market_99||safeShadow?.market99||null;
   const shadowProb=shadow99?.probabilities_pct||shadow99?.probabilities||null;
   // Original bookmaker probabilities from Okooo's verified "99家平均"
   // exchange index, NOT probabilities imputed from William, SP or average odds.
   // Only accept the identity-matched, timestamp-verified pre-match 3-way row.
   const avg99=trio("avgProb"),avg99Arr=chance(avg99);
   const original99FromExchange=complete(avg99Arr)&&
     Math.abs((avg99Arr as number[]).reduce((a,b)=>a+b,0)-100)<=1.5 ? avg99 : null;
   const originalFromArchive=complete(chance(shadowProb))?shadowProb:null;
   // Keep the latest VERIFIED pre-sale evidence for live detail only.
   // Historical reports and certified cold-warning evidence stay frozen.
   const exchangeCurrent=proofContext==="detail"&&now<Math.min(ko,sale,cutoffTs)&&
     !!original99FromExchange&&!!behavior&&
     (!shadowAt||Date.parse(behavior.captured_at)>Date.parse(shadowAt));
   const approved99=exchangeCurrent?original99FromExchange:(originalFromArchive??original99FromExchange);
   const liveFunds=fundReady?shares:{home:null,draw:null,away:null};
   const shadowFunds=safeShadow?.betfair?.share_pct??null;
   const finalFunds=complete(chance(shadowFunds))?shadowFunds:liveFunds;
   const finalFundArray=chance(finalFunds);
   const effectiveFundComplete=complete(finalFundArray);
   const attachedIntel=(intelligenceRes.data||[]).filter((x:any)=>
     x.home_team===match.home_team&&x.away_team===match.away_team&&
     ["attributed_prematch_article_pair_verified","okooo_public_prematch_observed"].includes(String(x.quality))&&
     goodTime(x.published_at)&&goodTime(x.fetched_at));
   const firstIntel=attachedIntel[0]||null;
   const snapshotIntel=safeShadow?.intelligence||null;
   const highlightParts=Array.isArray(snapshotIntel?.highlights)?snapshotIntel.highlights:
      (Array.isArray(firstIntel?.highlights)?firstIntel.highlights:[]);
   const strip=(x:any)=>String(x??"").replace(/<[^>]*>/g,"").replace(/\\+["']?\s*\/>/g,"").replace(/\s+/g," ").trim();
   const highlights=[...new Set(highlightParts.map((x:any)=>strip(typeof x==="string"?x:(x?.summary||x?.headline||""))).filter(Boolean))].slice(0,8);
   const shadowKelly=safeShadow?.kelly??null;
   const count=numeric(shadowKelly?.complete_count);
   const kellyValid=count!==null&&count>0;
   const has99=Boolean(approved99);
   const market99=has99?{probabilities_pct:approved99,
      top:!exchangeCurrent&&originalFromArchive&&shadow99?.top?shadow99.top:selection(chance(approved99)),
      probability_source:!exchangeCurrent&&originalFromArchive?(archived?.source_project==="SG_INDEPENDENT_NATIVE_OKOOO"?"SG_NATIVE_VERIFIED_ORIGINAL_BOOKMAKERS":"FROZEN_ORIGINAL_PREMATCH_REPORT"):"VERIFIED_OKOOO_99_AVERAGE_COLUMN"}:
      {probabilities_pct:{home:null,draw:null,away:null},top:null};
   // Original-style, evidence-only comprehensive market analysis.
   // Saved historical conclusions are never recalculated.
   const firmTop=has99?market99.top:null;
   const fundTop=effectiveFundComplete?selection(finalFundArray):null;
   const kellyTop=kellyValid?String(shadowKelly?.lowest_direction||""):null;
   const marketVotes=has99?chance(approved99):null;
   const firmIdx=firmTop==="主胜"?0:firmTop==="平"?1:firmTop==="客胜"?2:-1;
   const fundIdx=fundTop==="主胜"?0:fundTop==="平"?1:fundTop==="客胜"?2:-1;
   const aligned=firmIdx>=0&&fundIdx>=0&&firmIdx===fundIdx;
   const divergent=firmIdx>=0&&fundIdx>=0&&firmIdx!==fundIdx;
   const strongFunds=aligned&&finalFundArray[fundIdx]>=60;
   const fmtPercent=(v:any)=>Number(v).toFixed(1)+"%";
   const summary=!exchangeCurrent&&typeof safeShadow?.summary==="string"&&safeShadow.summary.trim()?safeShadow.summary:
     [
       firmIdx>=0&&marketVotes?"99家偏"+firmTop+" "+fmtPercent(marketVotes[firmIdx]):null,
       fundIdx>=0?"必发资金偏"+fundTop+" "+fmtPercent(finalFundArray[fundIdx]):null,
       kellyTop?"凯利最低方向"+kellyTop:null,
       numeric(snapshotIntel?.injury_count)>0?"有效伤停/阵容信息"+numeric(snapshotIntel?.injury_count)+"条":null,
       divergent?"99家与必发方向背离":strongFunds?"99家与必发同向且资金集中":
         aligned?"99家与必发同向":null
     ].filter(Boolean).join("；")||"市场资料尚未完整核验";
   const level=!exchangeCurrent&&typeof safeShadow?.level==="string"&&safeShadow.level.trim()?safeShadow.level:
     divergent?"市场分歧":aligned&&kellyTop===firmTop?"同向强化":
     aligned?"同向观察":"市场观察";
   const synthesisFlags=[
     ...(divergent?["99家与必发资金方向背离"]:[]),
     ...(strongFunds?["99家与必发同向且资金集中"]:[]),
     ...(kellyTop&&firmIdx>=0&&kellyTop!==firmTop?["凯利方向与机构方向不一致"]:[])
   ];
   const analysis={
     level,summary,
     market_99:market99,
     betfair:{share_pct:finalFunds,top:effectiveFundComplete?selection(finalFundArray):null,
       cold_heat:safeShadow?.betfair?.cold_heat??trio("bfHotCold"),
       profit_index:safeShadow?.betfair?.profit_index??trio("bfProfitIndex")},
     kelly:kellyValid?{lowest_direction:shadowKelly?.lowest_direction??null,
       lowest_value:numeric(shadowKelly?.lowest_value),complete_count:count}:
       {lowest_direction:null,lowest_value:null,complete_count:0},
     intelligence:{highlights,injury_count:numeric(snapshotIntel?.injury_count)??null,
       impact_side:snapshotIntel?.impact_side??null,impact_level:snapshotIntel?.impact_level??null},
     flags:[...(Array.isArray(safeShadow?.flags)?safeShadow.flags.filter((v:any)=>typeof v==="string"):[]),
       ...synthesisFlags,
       ...(archived?.market_status!=="ok"&&archived?["本期来源市场采集异常，已保留可核验的赛前部分指标"]:[]),
       ...(!has99?["99家机构完整概率待确认"]:[]),
       ...(!effectiveFundComplete?["必发真实资金占比未核验"]:[])].slice(0,8),
     capturedAt:exchangeCurrent?behavior?.captured_at:(shadowAt&&safeShadow?shadowAt:(behavior?.captured_at??wc?.captured_at??sp?.captured_at??null)),
     sourcePrematchAt:certified?.source_frozen_at??null,
     proofBoundaryAt:new Date(boundary).toISOString(),
     provenance:archived&&safeShadow===archived.analysis?
       (archived.source_project==="SG_INDEPENDENT_NATIVE_OKOOO"?"SINGAPORE_INDEPENDENT_NATIVE_PREMATCH":"OLD_HAO_PREMATCH_ARCHIVED_IN_SINGAPORE"):
       safeWarning&&safeShadow===safeWarning?"SOREN_COLD_PREPUBLICATION_SNAPSHOT":
       "SG_VERIFIED_PREMATCH_SOURCES",
   };
   const asianCodes=["1","11","18","31"];
   const asian=asianCodes.map(c=>{const i=one("zucaijia_asia4:"+c,"ASIAN_HANDICAP","initial"),
     current=one("zucaijia_asia4:"+c,"ASIAN_HANDICAP","current"),any=current||i;
     return any?{institution:any.payload?.institution_name??c,
       initialLine:i?.payload?.original_line??i?.line??null,
       currentLine:current?.payload?.original_line??current?.line??null,
       initialHomeWater:numeric(i?.home_water),initialAwayWater:numeric(i?.away_water),
       currentHomeWater:numeric(current?.home_water),currentAwayWater:numeric(current?.away_water)}:null;
   }).filter(Boolean);
   return send({ok:true,shadow:false,formal:!!certified,match:{no:match.match_no,
       home:match.home_team,away:match.away_team,league:match.league},
     analysis,
     market:{average:complete(chance(trio("avgOdds")))?trio("avgOdds"):null,
       william:{initial:initialOdds,current:wOdds,fair:implied(wOdds)},
       official:{had:odds(sp),hhad:odds(hsp),hhadLine:numeric(hsp?.line)},
       asian,marketSource:"ninety_core.soren_market_snapshots",
       capturedAt:behavior?.captured_at??wc?.captured_at??sp?.captured_at??null},
     source_quality:{ft_odds:wOdds?"verified_william":"missing",
       betfair:effectiveFundComplete?"verified_prematch":"missing",
       firm99:!has99?"missing":!exchangeCurrent&&originalFromArchive?
         (archived&&safeShadow===archived.analysis?(archived.source_project==="SG_INDEPENDENT_NATIVE_OKOOO"?"SG_NATIVE_PREMATCH_VERIFIED":"ARCHIVED_ORIGINAL_HAO_PREMATCH"):"ORIGINAL_SOREN_PREPUBLICATION"):
         "VERIFIED_OKOOO_ORIGINAL_99_AVERAGE_COLUMN",
       kelly:kellyValid?(shadowKelly?.status==="verified_single_bookmaker"?"WILLIAM_SINGLE_FIRM_ONLY":
         archived&&safeShadow===archived.analysis?(archived.source_project==="SG_INDEPENDENT_NATIVE_OKOOO"?"SG_NATIVE_BOOKMAKER_KELLY":"ARCHIVED_ORIGINAL_HAO_PREMATCH"):"ORIGINAL_SOREN_PREPUBLICATION"):"missing",
       intelligence:highlights.length?"PREMATCH_VERIFIED":"missing",
       identity:"MATCH_DATE_NUMBER_AND_TEAMS_VERIFIED"},
     source:"SG_VERIFIED_PREMATCH_MARKET_CHAIN_V3_WITH_ORIGINAL_REPORT",
     reportProvenance:{originalSourceProject:archived?(archived.source_project==="SG_INDEPENDENT_NATIVE_OKOOO"?"SG_NATIVE_PREMATCH":"ORIGINAL_HAO_SOURCE_COPY"):null,
       originalCapturedAt:archived?.captured_at??null,
       prepublicationProof:proofContext==="cold"&&Boolean(certified),
       proofBoundary:new Date(boundary).toISOString()}});
 }
 const {data:fields,error}=await sb.schema("ninety_core").from("source_state").select("field_key,source_name,quality,payload,observed_at").eq("match_key",key).in("field_key",["ft_odds","betfair","official_sp","match_identity","team_form","injuries"]);
 if(error)return send({ok:false,error:"SOURCE_READ_FAILED"},500);
 const identity=fields?.find((x:any)=>x.field_key==="match_identity")?.payload;
 const clean=(v:any)=>String(v||"").replace(/\s+/g,"");
 const identityOk=!identity||(clean(identity.home)===clean(match.home_team)&&clean(identity.away)===clean(match.away_team));
 const cutoff=Date.parse(String(match.kickoff_at||""));
 // Recover previously captured pre-match snapshots when a reused match number overwrote the latest cache.
 const {data:changes,error:changeError}=await sb.schema("ninety_core").from("source_changes")
   .select("field_key,source_name,payload,recorded_at").eq("match_key",key)
   .in("field_key",["match_identity","official_sp","ft_odds","betfair"])
   .order("recorded_at",{ascending:false}).limit(300);
 const anchored=(changes||[]).filter((x:any)=>x.field_key==="match_identity"
   &&clean(x.payload?.home)===clean(match.home_team)&&clean(x.payload?.away)===clean(match.away_team)
   &&Date.parse(x.recorded_at)<cutoff);
 const recovered=(field:string)=>{
   if(changeError||!anchored.length)return null;
   const candidates=(changes||[]).filter((x:any)=>x.field_key===field&&Date.parse(x.recorded_at)<cutoff);
   for(const c of candidates){
     const t=Date.parse(c.recorded_at);
     const identity=anchored.find((a:any)=>Math.abs(Date.parse(a.recorded_at)-t)<=2000
       &&(!c.payload?.source_match_id||!a.payload?.source_match_id
         ||String(c.payload.source_match_id)===String(a.payload.source_match_id)));
     if(identity)return {...c,quality:"provisional",observed_at:c.recorded_at,recovered:true};
   }
   return null;
 };
 const get=(k:string)=>{
   if(identityOk){
     const row=fields?.find((x:any)=>x.field_key===k&&x.quality==="verified"&&Date.parse(x.observed_at)<cutoff);
     if(row)return row;
   }
   return recovered(k);
 };
 const identityId=identityOk?String(identity?.source_match_id||""):"";
 const archivedOdds=identityId?(changes||[]).find((x:any)=>x.field_key==="ft_odds"&&x.source_name==="okooo"
   &&String(x.payload?.source_match_id||"")===identityId&&Date.parse(x.recorded_at)<cutoff
   &&Array.isArray(x.payload?.bookmakers)&&x.payload.bookmakers.length>0):null;
 const odds=get("ft_odds")?.payload?.bookmakers?.length?get("ft_odds"):(archivedOdds?{...archivedOdds,quality:"verified",observed_at:archivedOdds.recorded_at,recovered:true}:get("ft_odds"));
 const bet=get("betfair"),book=odds?.payload||{},selections=bet?.payload?.selections||{};
 const av=book.average||{},p=book.institution_probabilities||{};
 const imputed=probs(av)||probs(get("official_sp")?.payload?.had);
 const probabilities={home:num(p.home)??imputed?.home??num(selections.home?.average_probability_pct),draw:num(p.draw)??imputed?.draw??num(selections.draw?.average_probability_pct),away:num(p.away)??imputed?.away??num(selections.away?.average_probability_pct)};
 const shares={home:num(selections.home?.share_pct),draw:num(selections.draw?.share_pct),away:num(selections.away?.share_pct)};
 const hot={home:num(selections.home?.hot_index),draw:num(selections.draw?.hot_index),away:num(selections.away?.hot_index)};
 const profit={home:num(selections.home?.profit_index),draw:num(selections.draw?.profit_index),away:num(selections.away?.profit_index)};
 const completeKelly=(Array.isArray(book.bookmakers)?book.bookmakers:[]).map((b:any)=>Array.isArray(b.kelly)?b.kelly.map(num):[]).filter((a:any[])=>a.length===3&&a.every(v=>v!==null&&v>0));
 const avgKelly=[0,1,2].map(i=>completeKelly.length?completeKelly.reduce((sum:number,k:any[])=>sum+k[i],0)/completeKelly.length:null);
 const lowest=avgKelly.every(x=>x!==null)?avgKelly.map((value,i)=>({value,direction:["主胜","平","客胜"][i]})).sort((a:any,b:any)=>a.value-b.value)[0]:null;
 const analysis={market_99:{probabilities_pct:probabilities,top:Object.values(probabilities).every(x=>x!==null)?dir(probabilities):null,average_odds:{home:num(av.home),draw:num(av.draw),away:num(av.away)}},betfair:{share_pct:shares,top:Object.values(shares).every(x=>x!==null)?dir(shares):null,cold_heat:hot,profit_index:profit},kelly:{lowest_direction:lowest?.direction||null,lowest_value:lowest?.value??null,complete_count:completeKelly.length},intelligence:{highlights:[...(get("team_form")?.payload?.items||[]),...(get("injuries")?.payload?.items||[])].filter((x:any)=>typeof x==="string").slice(0,16),injury_count:Array.isArray(get("injuries")?.payload?.items)?get("injuries")!.payload.items.length:null,impact_side:null,impact_level:null},flags:[identityOk?"新加坡测试数据，未正式发布":"当前缓存球队不一致，已隔离",odds?.recovered||bet?.recovered||get("official_sp")?.recovered?"从历史赛前采集日志恢复，来源待复核":"",!p.home&&imputed?"赔率隐含概率（非机构原始概率）":""].filter(Boolean),captured_at:fields?.map((x:any)=>x.observed_at).filter(Boolean).sort().at(-1)||null};
 return send({ok:true,shadow:true,formal:false,match:{no:match.match_no,home:match.home_team,away:match.away_team,league:match.league},analysis,source_quality:{ft_odds:odds?.quality||"missing",betfair:bet?.quality||"missing"},market:{},source:"singapore_okooo_verified"});
});