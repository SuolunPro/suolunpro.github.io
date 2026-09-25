import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {createClient} from "npm:@supabase/supabase-js@2.95.0";

const db=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false,autoRefreshToken:false}});
const HEADERS={"user-agent":"Mozilla/5.0 (compatible; SorenStadiumCache/2.0)","accept":"application/json"};
const finite=(v:unknown):number|null=>v!==null&&v!==undefined&&v!==""&&Number.isFinite(Number(v))?Number(v):null;
const stamp=(v:unknown)=>Date.parse(String(v??""));
const matchesFixture=(j:any)=>j?.fixtures?.allFixtures?.fixtures??[];
const dayBjt=(d:Date)=>new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(d);
async function getJson(url:string):Promise<any>{
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),9500);
 try{const r=await fetch(url,{headers:HEADERS,signal:controller.signal});if(!r.ok)throw Error("UPSTREAM_"+r.status);return await r.json()}
 finally{clearTimeout(timer)}
}
async function fetchForecast(lat:number,lon:number,kickoff:string,nowMs:number){
 const u=new URL("https://api.open-meteo.com/v1/forecast");
 u.searchParams.set("latitude",String(lat));u.searchParams.set("longitude",String(lon));
 u.searchParams.set("hourly","temperature_2m,relative_humidity_2m,precipitation_probability,wind_speed_10m");
 u.searchParams.set("timezone","UTC");u.searchParams.set("forecast_days","4");
 const j=await getJson(u.toString()),h=j?.hourly;
 const target=new Date(kickoff).toISOString().slice(0,13)+":00";
 const idx=(h?.time??[]).indexOf(target);
 if(idx<0)return null;
 const t=finite(h?.temperature_2m?.[idx]),hu=finite(h?.relative_humidity_2m?.[idx]),
   p=finite(h?.precipitation_probability?.[idx]),w=finite(h?.wind_speed_10m?.[idx]);
 if(t===null||hu===null||t < -80||t > 70||hu<0||hu>100||p!==null&&(p<0||p>100)||w!==null&&(w<0||w>300))return null;
 if(nowMs>=stamp(kickoff))return null;
 return {temperature_c:t,humidity_pct:hu,precipitation_probability_pct:p,wind_speed_kmh:w,
   forecast_time:new Date(stamp(kickoff.slice(0,13)+":00Z")).toISOString(),forecast_fetched_at:new Date(nowMs).toISOString(),
   weather_source:"Open-Meteo hourly forecast at independently verified stadium coordinates"};
}
Deno.serve(async req=>{
 if(req.method!=="POST")return Response.json({ok:false,error:"METHOD_NOT_ALLOWED"},{status:405});
 const token=req.headers.get("x-soren-intel-key")??"";
 if(token.length<32)return Response.json({ok:false,error:"UNAUTHORIZED"},{status:401});
 const {data:ok,error:authError}=await db.rpc("soren_intel_authorized",{p_key:token});
 if(authError||ok!==true)return Response.json({ok:false,error:"UNAUTHORIZED"},{status:401});
 try{
  const u=new URL(req.url),now=new Date(),nowMs=now.getTime(),backfill=u.searchParams.get("mode")==="backfill";
  const targetDate=u.searchParams.get("date")??dayBjt(now);
  const limit=Math.min(Math.max(Number(u.searchParams.get("limit")||20),1),25);
  const offset=Math.max(Math.min(Number(u.searchParams.get("offset")||0),400),0);
  if(backfill&&(!/^2026-09-(15|16|17|18|19|20|21|22)$/.test(targetDate)||targetDate>dayBjt(now)))
    return Response.json({ok:false,error:"BACKFILL_DATE_OUT_OF_RANGE"},{status:400});
  let query=db.from("soren_matches").select("id,pool_date,match_no,home_team,away_team,kickoff_at,source_status,is_world_cup")
    .eq("is_world_cup",false).order("kickoff_at",{ascending:true});
  if(backfill)query=query.eq("pool_date",targetDate).lte("kickoff_at",now.toISOString());
  else query=query.gt("kickoff_at",now.toISOString()).lt("kickoff_at",new Date(nowMs+72*3600000).toISOString());
  const {data:matches,error:matchError}=await query.range(offset,offset+limit-1);
  if(matchError)throw matchError;
  const list=matches??[];
  if(!list.length)return Response.json({ok:true,mode:backfill?"backfill":"live",checked:0,cached:0,venueOnly:0,weather:0});
  const ids=list.map(m=>Number(m.id));
  const [{data:maps,error:mapError},{data:env,error:envError},{data:context,error:ctxError},{data:venueEvidence,error:venueEvidenceError}]=await Promise.all([
    db.from("soren_environment_fixture_map_v1").select("match_id,fotmob_match_id,mapping_quality,home_team_id,away_team_id").in("match_id",ids),
    db.from("soren_environment_cache_v1").select("*").in("match_id",ids).order("created_at",{ascending:false}).limit(250),
    db.from("soren_feature_snapshots").select("match_id,payload,captured_at").in("match_id",ids).eq("feature_type","FOTMOB_CONTEXT").order("captured_at",{ascending:false}).limit(80),
    db.from("soren_environment_venue_evidence_v1").select("*").in("match_id",ids)
  ]);
  if(mapError||envError||ctxError||venueEvidenceError)throw mapError||envError||ctxError||venueEvidenceError;
  const mapping=new Map<number,any>((maps??[]).map(m=>[Number(m.match_id),m]));
  const existing=new Map<number,any>();
  for(const e of env??[])if(!existing.has(Number(e.match_id))&&e.venue_name)existing.set(Number(e.match_id),e);
  const contexts=new Map<number,any>();
  for(const c of context??[])if(!contexts.has(Number(c.match_id))&&c.payload?.fotmob_match_id)
    contexts.set(Number(c.match_id),c.payload);
  // Match-specific venue evidence is never inferred from a team's usual stadium.
  const venueEvidenceMap=new Map<number,any>((venueEvidence??[]).map(e=>[Number(e.match_id),e]));
  const verifiedVenue=(m:any)=>{
    const e=venueEvidenceMap.get(Number(m.id));
    if(!e||String(e.pool_date)!==String(m.pool_date)||
      String(e.match_no).padStart(3,"0")!==String(m.match_no).padStart(3,"0")||
      e.home_team!==m.home_team||e.away_team!==m.away_team||
      !Number.isFinite(stamp(e.kickoff_at))||
      Math.abs(stamp(e.kickoff_at)-stamp(m.kickoff_at))>300000||
      typeof e.venue_name!=="string"||!e.venue_name.trim()||
      typeof e.fixture_source!=="string"||!e.fixture_source.startsWith("https://"))return null;
    const lat=finite(e.venue_lat),lon=finite(e.venue_lon);
    const coords=lat!==null&&lon!==null&&lat>=-90&&lat<=90&&lon>=-180&&lon<=180&&
      typeof e.coordinates_source==="string"&&e.coordinates_source.startsWith("https://");
    return {name:e.venue_name,city:e.venue_city,country:e.venue_country,
      lat:coords?lat:null,long:coords?lon:null,
      surface:typeof e.turf_source==="string"&&e.turf_source.startsWith("https://")?e.pitch_surface:null,
      venue_source:"Verified fixture venue "+e.fixture_source+"; turf "+(e.turf_source??"unverified")+
        "; coordinates "+(e.coordinates_source??"unverified")};
  };
  const teams=[...new Set(list.flatMap(m=>[m.home_team,m.away_team]))];
  const {data:aliases,error:aliasError}=await db.from("soren_team_alias_fotmob").select("jc_team,fotmob_team_id,fotmob_team").in("jc_team",teams);
  if(aliasError)throw aliasError;
  // Reuse only fixture-verified shadow aliases: no transliteration guessing and no
  // silent override if the live and verified shadow mappings conflict.
  const {data:shadowRows,error:shadowError}=await db.from("soren_team_alias_fotmob_v2_shadow")
    .select("jc_team,fotmob_team_id,status,resolution_method,evidence_match_id,evidence_kickoff_at,evidence")
    .in("jc_team",teams).eq("status","fixture_verified")
    .eq("resolution_method","fixture_time_orientation_strict");
  if(shadowError)throw shadowError;
  const aliasMap=new Map<string,Set<number>>(),formalMap=new Map<string,Set<number>>(),shadowMap=new Map<string,any[]>();
  const addAlias=(map:Map<string,Set<number>>,name:string,value:unknown)=>{
    const id=finite(value);if(id===null||id<=0)return;
    const ids=map.get(name)??new Set<number>();ids.add(id);map.set(name,ids);
  };
  for(const a of aliases??[]){
    // Known corrupted legacy alias: 中国女 was imported as the men's club FC Osaka.
    // Do not reuse it until the exact women's national team ID is independently verified.
    if(String(a.jc_team)==="中国女"&&String(a.fotmob_team)==="FC Osaka")continue;
    addAlias(formalMap,String(a.jc_team),a.fotmob_team_id);
  }
  for(const a of shadowRows??[]){
    const name=String(a.jc_team),id=finite(a.fotmob_team_id);
    if(id===null||id<=0||a.evidence?.strict_time_orientation!==true)continue;
    const all=shadowMap.get(name)??[];all.push(a);shadowMap.set(name,all);
    addAlias(aliasMap,name,id);
  }
  const alias=(name:string)=>{
    const formal=formalMap.get(name),shadow=aliasMap.get(name);
    if(formal?.size){
      if(formal.size!==1||shadow?.size&&([...shadow].some(id=>!formal.has(id))))return null;
      return [...formal][0];
    }
    return shadow?.size===1?[...shadow][0]:null;
  };
  // Same-fixture evidence is reusable only when BOTH sides, orientation,
  // sale date, match number and kickoff match the current customer fixture.
  const shadowFixture=(m:any,homeId:number|null,awayId:number|null):number|null=>{
    if(homeId===null||awayId===null)return null;
    const h=shadowMap.get(String(m.home_team))??[],a=shadowMap.get(String(m.away_team))??[];
    const approved=(v:any)=>finite(v.fotmob_team_id)>0&&
      v.evidence?.strict_time_orientation===true&&v.evidence?.jc_home===m.home_team&&
      v.evidence?.jc_away===m.away_team&&String(v.evidence?.pool_date)===String(m.pool_date)&&
      String(v.evidence?.match_no).padStart(3,"0")===String(m.match_no).padStart(3,"0")&&
      Math.abs(stamp(v.evidence_kickoff_at)-stamp(m.kickoff_at))<=300000;
    const ids=new Set<number>();
    for(const x of h)for(const y of a)
      if(approved(x)&&approved(y)&&finite(x.fotmob_team_id)===homeId&&
        finite(y.fotmob_team_id)===awayId&&finite(x.evidence_match_id)!==null&&
        finite(x.evidence_match_id)===finite(y.evidence_match_id))ids.add(Number(x.evidence_match_id));
    return ids.size===1?[...ids][0]:null;
  };
  let budget=backfill?limit:Math.min(limit,12),cached=0,venueOnly=0,weather=0,skipped=0;const details:any[]=[];
  const teamCache=new Map<number,any>();
  for(const m of list){
   const id=Number(m.id),kickoff=String(m.kickoff_at),old=existing.get(id),pre=nowMs<stamp(kickoff),date=String(m.pool_date),no=String(m.match_no);
   const record=(status:string,reason?:string)=>details.push({date,no,status,...(reason?{reason}: {})});
   // At most two successful forecasts: first when a fixture is available and one
   // optional refresh inside the final three hours. Checks must never re-fetch a
   // valid forecast simply because a generic four-hour TTL has elapsed.
   const kickoffMs=stamp(kickoff);
   const lastForecastMs=stamp(old?.forecast_fetched_at);
   const hasSavedForecast=old?.quality==="EXACT_STADIUM_FORECAST"&&
     Number.isFinite(lastForecastMs)&&lastForecastMs<kickoffMs;
   const finalWindowStart=kickoffMs-3*3600000;
   const finalRefreshDue=pre&&nowMs>=finalWindowStart&&
     hasSavedForecast&&lastForecastMs<finalWindowStart;
   if(old&&(!pre||(hasSavedForecast&&!finalRefreshDue))){
     cached++;record("cached");continue;
   }
   // Verified stadium data remains cached even where FotMob has no reliable
   // coordinates. Re-downloading the identical venue every check cannot add
   // a defensible weather forecast for that fixture.
   if(old?.venue_name&&old.venue_source&&
      (finite(old.venue_lat)===null||finite(old.venue_lon)===null)&&!verifiedVenue(m)){
     cached++;record("venue_cached_coordinates_unverified");continue;
   }
   const fallbackVenue=verifiedVenue(m);
   if(budget<=0&&!fallbackVenue){skipped++;record("budget_limited");continue}
   const homeId=alias(String(m.home_team)),awayId=alias(String(m.away_team));
   const mapped=mapping.get(id),ctx=contexts.get(id);
   let fixtureId=finite(mapped?.fotmob_match_id)||finite(ctx?.fotmob_match_id)||
     shadowFixture(m,homeId,awayId);
   if(!fixtureId&&pre&&homeId!==null&&awayId!==null){
    try{
      let teamJson=teamCache.get(homeId);
      if(!teamJson){teamJson=await getJson("https://www.fotmob.com/api/data/teams?id="+homeId);teamCache.set(homeId,teamJson)}
      const cand=matchesFixture(teamJson).filter((f:any)=>finite(f?.home?.id)===homeId&&finite(f?.away?.id)===awayId
        &&Math.abs(stamp(f?.status?.utcTime)-stamp(kickoff))<=300000);
      if(cand.length===1)fixtureId=finite(cand[0].id);
    }catch{record("fixture_lookup_failed")}
   }
   if(!fixtureId){skipped++;record("fixture_unmatched");continue}
   let stadium:any,matchJson:any,venueSource:string|null=null;
   if(old?.venue_name&&old.venue_source){
     stadium={name:old.venue_name,city:old.venue_city,country:old.venue_country,
       lat:old.venue_lat,long:old.venue_lon,surface:old.pitch_surface};
     venueSource=old.venue_source;
     if(fallbackVenue&&old.venue_name.trim().toLowerCase()===fallbackVenue.name.trim().toLowerCase()){
       stadium.surface=stadium.surface??fallbackVenue.surface;
       stadium.lat=stadium.lat??fallbackVenue.lat;
       stadium.long=stadium.long??fallbackVenue.long;
       venueSource+="; additional verified evidence "+fallbackVenue.venue_source;
     }
   }else if(fallbackVenue){
     stadium=fallbackVenue;
     venueSource=fallbackVenue.venue_source;
     record("venue_from_verified_fixture_source");
   }else{
    if(budget<=0){skipped++;record("budget_limited");continue}
    budget--;
    try{matchJson=await getJson("https://www.fotmob.com/api/data/matchDetails?matchId="+fixtureId)}
    catch{skipped++;record("match_details_unavailable");continue}
    const g=matchJson?.general;
    if(finite(g?.matchId)!==fixtureId||!Number.isFinite(stamp(g?.matchTimeUTCDate))||
      Math.abs(stamp(g?.matchTimeUTCDate)-stamp(kickoff))>300000 ||
      homeId!==null&&finite(g?.homeTeam?.id)!==homeId||
      awayId!==null&&finite(g?.awayTeam?.id)!==awayId||
      homeId===null&&awayId===null){
      skipped++;record("fixture_identity_conflict");continue;
    }
    // Persist the verified fixture independently of stadium availability.
    // An upstream page can publish the venue later; do not rediscover the match.
    const {error:fixtureMapError}=await db.from("soren_environment_fixture_map_v1")
      .upsert({match_id:id,fotmob_match_id:fixtureId,home_team_id:homeId,away_team_id:awayId,
        mapping_source:mapped?.mapping_source??"fotmob_fixture_verified_details",
        mapping_quality:"fixture_id_time_orientation_verified"},{onConflict:"match_id"});
    if(fixtureMapError)record("fixture_map_write_failed",fixtureMapError.code);
    stadium=matchJson?.content?.matchFacts?.infoBox?.Stadium;
    if(stadium?.name)venueSource="FotMob matchDetails verified fixture "+fixtureId;
   }
   const lat=finite(stadium?.lat),lon=finite(stadium?.long);
   // The venue name is match-specific FotMob evidence; coordinates are separately
   // verified and are only needed for weather, not for displaying the stadium.
   if(typeof stadium?.name!=="string"||!stadium.name.trim()){skipped++;record("stadium_unconfirmed");continue}
   const coordinatesVerified=lat!==null&&lon!==null&&lat>=-90&&lat<=90&&lon>=-180&&lon<=180;
   let forecast:any=null;
   if(pre&&coordinatesVerified){
    try{forecast=await fetchForecast(lat!,lon!,kickoff,Date.now())}catch{forecast=null}
   }
   // If the optional refresh fails, keep the original timestamped pre-match
   // forecast. Never replace it with an empty or post-kickoff weather snapshot.
   if(!forecast&&hasSavedForecast){
     cached++;record("forecast_refresh_unavailable_retained");continue;
   }
   const saveTime=new Date().toISOString();
   const venueVerifiedPre=pre&&Date.now()<stamp(kickoff);
   const entry={
    match_id:id,pool_date:date,match_no:no,home_team:m.home_team,away_team:m.away_team,
    kickoff_at:kickoff,venue_name:String(stadium.name),venue_city:stadium.city??null,
    venue_country:stadium.country??null,pitch_surface:stadium.surface??null,
    venue_lat:lat,venue_lon:lon,
    temperature_c:forecast?.temperature_c??null,humidity_pct:forecast?.humidity_pct??null,
    precipitation_probability_pct:forecast?.precipitation_probability_pct??null,
    wind_speed_kmh:forecast?.wind_speed_kmh??null,
    forecast_time:forecast?.forecast_time??null,forecast_fetched_at:forecast?.forecast_fetched_at??null,
    venue_source:venueSource??"FotMob matchDetails verified fixture "+fixtureId,
    weather_source:forecast?.weather_source??null,
    quality:forecast?"EXACT_STADIUM_FORECAST":venueVerifiedPre?"VERIFIED_STADIUM_PREMATCH":"VERIFIED_STADIUM_POSTMATCH",
    prematch_verified:!!forecast||venueVerifiedPre,
    imported_from:"soren_environment_fotmob_cache_v2",updated_at:saveTime
   };
   const {error:writeError}=await db.from("soren_environment_cache_v1").upsert(entry,{onConflict:"match_id,imported_from"});
   if(writeError){skipped++;record("cache_write_failed",writeError.code);continue}
   const {error:mapWrite}=await db.from("soren_environment_fixture_map_v1")
      .upsert({match_id:id,fotmob_match_id:fixtureId,home_team_id:homeId,away_team_id:awayId,
        mapping_source:mapped?.mapping_source??"fotmob_fixture_verified_details",
        mapping_quality:"fixture_id_time_orientation_verified"},{onConflict:"match_id"});
   if(mapWrite)record("mapped_cache_saved_mapping_warning",mapWrite.code);
   if(forecast){weather++;record("weather_cached")}else{venueOnly++;record(pre?"venue_only_pregame":"venue_only_postmatch")}
  }
  return Response.json({ok:true,mode:backfill?"backfill":"live",date:backfill?targetDate:dayBjt(now),
    checked:list.length,cached,venueOnly,weather,skipped,remainingMatchDetailBudget:budget,details},
    {headers:{"Cache-Control":"no-store"}});
 }catch(error){console.error("SOREN_ENVIRONMENT_COLLECTOR_ERROR",error);return Response.json({ok:false,error:"ENVIRONMENT_COLLECTOR_FAILED"},{status:502})}
});