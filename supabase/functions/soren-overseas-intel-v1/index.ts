import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const SOURCE = "overseas_gdelt_shadow_v1";
const USER_AGENT = "Mozilla/5.0 (compatible; SorenOverseasIntel/1.0)";
const HOUR = 3600_000;

const COUNTRY_BY_LEAGUE: Record<string,string> = {
  "巴甲":"brazil","巴乙":"brazil",
  "芬超":"finland",
  "英超":"unitedkingdom","英冠":"unitedkingdom","英甲":"unitedkingdom","英乙":"unitedkingdom","苏超":"unitedkingdom",
  "西甲":"spain","西乙":"spain",
  "意甲":"italy","意乙":"italy",
  "德甲":"germany","德乙":"germany",
  "法甲":"france","法乙":"france",
  "荷甲":"netherlands","荷乙":"netherlands",
  "葡超":"portugal",
  "日职":"japan","日乙":"japan",
  "韩职":"southkorea",
  "澳超":"australia",
  "美职":"unitedstates",
  "瑞超":"sweden","挪超":"norway","丹超":"denmark",
  "比甲":"belgium","奥甲":"austria","瑞士超":"switzerland","土超":"turkey"
};

const IMPORTANT = /(captain|key player|star|first[- ]choice|goalkeeper|keeper|top scorer|titular|capit[aã]o|goleiro|artilheiro|portero|capit[aá]n|gardien|torwart)/i;
const NEG_INJURY = /(injur(?:y|ed|ies)|ruled out|will miss|misses the match|fitness doubt|doubtful|illness|did not travel|not travel(?:led)?|absence|absent|suspend(?:ed|ed)|suspension|les[aã]o|lesionado|desfalque|suspenso|n[aã]o viajou|contus[aã]o|d[uú]vida para o jogo|lesi[oó]n|baja para el partido|suspendido|infortunio|assente|squalificato|bless[ée]|suspendu|incertain|verletzt|gesperrt|fraglich|loukkaant|pelikielto)/i;
const POS_RETURN = /(returns? to (?:training|the squad|action)|back in training|available again|declared fit|recovered|cleared to play|retorna aos treinos|volta aos treinos|fica [àa] disposi[cç][aã]o|recuperado|refor[cç]o para|regresa al equipo|vuelve a entrenar|recuperado para|rientra|recuperato|torna disponibile|de retour|reprend l'entra[iî]nement|wieder im training|kehrt zur[uü]ck|palasi harjoituksiin|palaa kokoonpanoon)/i;
const ROTATION = /(rested|rotation|rotated squad|rotate the squad|poupado|rod[ií]zio|preservado|descanso|rotaciones|turnover|riposo|rotation de l'effectif|geschont)/i;
const INTERNAL = /(unpaid wages?|salary arrears|wages? delayed|bonuses? unpaid|image rights.*(?:late|unpaid)|strike|boycott|internal crisis|disciplinary issue|sal[aá]rios? atrasados|direitos? de imagem.*atrasad|premia[cç][aã]o.*atrasad|greve|crise interna|problema disciplinar|sueldos? atrasados|impagos?|huelga)/i;

function stripTags(s:string){
  return s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi," ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi," ")
    .replace(/<[^>]+>/g," ")
    .replace(/&nbsp;|&#160;/gi," ")
    .replace(/&amp;/gi,"&")
    .replace(/&quot;/gi,'"')
    .replace(/&#39;|&apos;/gi,"'")
    .replace(/\s+/g," ").trim();
}
function norm(s:unknown){
  return String(s??"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase()
    .replace(/\b(football club|futebol clube|club de futbol|soccer club)\b/g," ")
    .replace(/\b(fc|cf|sc|ac)\b/g," ")
    .replace(/[^a-z0-9\p{L}]+/gu," ").replace(/\s+/g," ").trim();
}
function aliasNeedle(s:string){
  return norm(s).replace(/^(red bull)\s+/,"").trim();
}
function parseSeenDate(v:unknown){
  const s=String(v??"").trim();
  if(!s)return NaN;
  const direct=Date.parse(s);
  if(Number.isFinite(direct))return direct;
  const m=s.match(/^(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})(\d{2})Z?$/);
  if(!m)return NaN;
  return Date.UTC(Number(m[1]),Number(m[2])-1,Number(m[3]),Number(m[4]),Number(m[5]),Number(m[6]));
}
async function fetchText(url:string,timeout=7000){
  const c=new AbortController(), t=setTimeout(()=>c.abort(),timeout);
  try{
    const r=await fetch(url,{headers:{"user-agent":USER_AGENT,"accept-language":"en,*;q=0.8"},signal:c.signal,redirect:"follow"});
    if(!r.ok)return "";
    const ct=r.headers.get("content-type")??"";
    if(!/text|html|json/i.test(ct))return "";
    const raw=await r.text();
    return raw.slice(0,300_000);
  }catch{return ""}finally{clearTimeout(t)}
}
function classify(text:string, side:"主队"|"客队"|"双方", title:string, domain:string){
  const out:any[]=[];
  const level=IMPORTANT.test(text)?"高":"中";
  const push=(type:string,impact:"利好"|"利空",summary:string)=>out.push({
    side,type,level,impact,summary:summary.slice(0,220),domain
  });
  if(NEG_INJURY.test(text))push("伤停","利空",title);
  if(ROTATION.test(text))push("轮换","利空",title);
  if(INTERNAL.test(text))push("内部","利空",title);
  if(POS_RETURN.test(text))push("复出","利好",title);
  return out;
}
function dueIntervalMs(mins:number){
  if(mins<=120)return 30*60_000;
  if(mins<=360)return 60*60_000;
  return 120*60_000;
}
function gdeltUrl(home:string,away:string,country:string|null){
  let q=`"${home.replaceAll('"',"")}" "${away.replaceAll('"',"")}"`;
  if(country)q+=` sourcecountry:${country}`;
  const p=new URLSearchParams({
    query:q,mode:"artlist",format:"json",maxrecords:"12",sort:"datedesc",timespan:"3d"
  });
  return "https://api.gdeltproject.org/api/v2/doc/doc?"+p.toString();
}

Deno.serve(async(req:Request)=>{
  if(req.method!=="POST")return Response.json({ok:false,error:"METHOD_NOT_ALLOWED"},{status:405});
  const key=req.headers.get("x-soren-intel-key")??"";
  if(key.length<32)return Response.json({ok:false,error:"UNAUTHORIZED"},{status:401});
  const {data:authorized,error:authError}=await db.rpc("soren_intel_authorized",{p_key:key});
  if(authError||authorized!==true)return Response.json({ok:false,error:"UNAUTHORIZED"},{status:401});

  const now=new Date(), nowMs=now.getTime(), nowIso=now.toISOString();
  let body:any={};
  try{body=await req.json()}catch{}
  const maxMatches=Math.max(1,Math.min(10,Number(body?.max_matches??8)));

  try{
    const until=new Date(nowMs+36*HOUR).toISOString();
    const {data:matches,error:matchError}=await db.from("soren_matches")
      .select("id,pool_date,match_no,league,home_team,away_team,kickoff_at,is_world_cup")
      .eq("is_world_cup",false).gt("kickoff_at",nowIso).lte("kickoff_at",until)
      .order("kickoff_at",{ascending:true}).limit(120);
    if(matchError)throw matchError;
    const pool=matches??[];
    if(!pool.length)return Response.json({ok:true,status:"NO_FUTURE_MATCHES",source:SOURCE});

    const teams=[...new Set(pool.flatMap((m:any)=>[String(m.home_team),String(m.away_team)]))];
    const {data:aliases,error:aliasError}=await db.from("soren_team_alias_fotmob")
      .select("jc_team,fotmob_team,confidence").in("jc_team",teams).limit(500);
    if(aliasError)throw aliasError;
    const aliasMap=new Map<string,string>();
    for(const a of aliases??[]){
      const n=String((a as any).fotmob_team??"").trim();
      if(n)aliasMap.set(String((a as any).jc_team),n);
    }

    const dates=[...new Set(pool.map((m:any)=>String(m.pool_date)))];
    const {data:healthRows}=await db.from("soren_source_health")
      .select("pool_date,details").eq("source_code",SOURCE).in("pool_date",dates);
    const lastByMatch=new Map<string,string>();
    for(const h of healthRows??[]){
      const d=(h as any).details;
      const map=d&&typeof d==="object"?(d.last_by_match??{}):{};
      for(const [k,v] of Object.entries(map))if(typeof v==="string")lastByMatch.set(k,v);
    }

    const due=pool.filter((m:any)=>{
      const home=aliasMap.get(String(m.home_team)), away=aliasMap.get(String(m.away_team));
      if(!home||!away)return false;
      const kick=Date.parse(String(m.kickoff_at));
      const mins=(kick-nowMs)/60_000;
      if(!(mins>0))return false;
      const last=Date.parse(lastByMatch.get(String(m.id))??"");
      return !Number.isFinite(last)||(nowMs-last)>=dueIntervalMs(mins);
    }).slice(0,maxMatches);

    if(!due.length)return Response.json({
      ok:true,status:"THROTTLED_NO_DUE_MATCHES",source:SOURCE,candidateMatches:pool.length
    });

    const stats:any[]=[]; const errors:string[]=[]; const saved:any[]=[];
    const attemptsByDate=new Map<string,Record<string,string>>();
    for(const d of dates)attemptsByDate.set(d,{});
    for(const [id,ts] of lastByMatch.entries()){
      const m=pool.find((x:any)=>String(x.id)===id);
      if(m)attemptsByDate.get(String(m.pool_date))![id]=ts;
    }

    for(const m of due){
      const homeAlias=aliasMap.get(String(m.home_team))!, awayAlias=aliasMap.get(String(m.away_team))!;
      const homeNeedle=aliasNeedle(homeAlias), awayNeedle=aliasNeedle(awayAlias);
      const kickoff=Date.parse(String(m.kickoff_at));
      const country=COUNTRY_BY_LEAGUE[String(m.league)]??null;
      attemptsByDate.get(String(m.pool_date))![String(m.id)]=nowIso;
      let articles:any[]=[];
      try{
        const r=await fetch(gdeltUrl(homeAlias,awayAlias,country),{
          headers:{"user-agent":USER_AGENT,"accept":"application/json"},signal:AbortSignal.timeout(8000)
        });
        if(r.ok){
          const j=await r.json();
          articles=Array.isArray(j?.articles)?j.articles:[];
        }else errors.push(String(m.match_no)+":GDELT_"+r.status);
      }catch(e){errors.push(String(m.match_no)+":GDELT_FETCH")}
      let stored=0, classified=0;
      for(const a of articles.slice(0,5)){
        if(stored>=2)break;
        const url=String(a?.url??""); const title=String(a?.title??"").trim();
        if(!/^https?:\/\//i.test(url)||!title)continue;
        const published=parseSeenDate(a?.seendate??a?.date);
        if(!Number.isFinite(published)||published>=kickoff||published>nowMs||published<nowMs-72*HOUR)continue;
        const raw=await fetchText(url,5500);
        const page=raw?stripTags(raw):"";
        const combined=(title+" "+page).slice(0,120_000);
        const n=norm(combined);
        const hasHome=homeNeedle.length>=4&&n.includes(homeNeedle);
        const hasAway=awayNeedle.length>=4&&n.includes(awayNeedle);
        if(!hasHome&&!hasAway)continue;
        const side: "主队"|"客队"|"双方" = hasHome&&hasAway?"双方":hasHome?"主队":"客队";
        const categories=classify(combined,side,title,String(a?.domain??new URL(url).hostname));
        if(!categories.length)continue;
        classified++;
        const quality=country?"overseas_local_media_shadow":"overseas_media_shadow";
        const highlights={
          schema:"overseas_intel_shadow_v1",
          shadow_only:true,
          sourceCountry:String(a?.sourcecountry??country??""),
          language:String(a?.language??""),
          categories,
          benefit_side: categories.some((x:any)=>x.impact==="利空")
            ? (side==="主队"?"客队":side==="客队"?"主队":"不明确")
            : (side==="双方"?"不明确":side),
          note:"仅影子情报，不参与正式预测/冷门预警权重"
        };
        const record={
          match_id:m.id,pool_date:m.pool_date,match_no:m.match_no,home_team:m.home_team,away_team:m.away_team,
          source_code:SOURCE,source_url:url,headline:title,published_at:new Date(published).toISOString(),
          fetched_at:nowIso,quality,highlights
        };
        const {error:saveError}=await db.from("soren_intelligence_reports_v1")
          .upsert(record,{onConflict:"match_id,source_url",ignoreDuplicates:true});
        if(saveError)errors.push(String(m.match_no)+":SAVE_"+saveError.code);
        else {stored++; saved.push({no:m.match_no,headline:title,quality});}
      }
      stats.push({no:m.match_no,articles:articles.length,classified,stored,country,homeAlias,awayAlias});
    }

    for(const d of dates){
      const dateMatches=pool.filter((m:any)=>String(m.pool_date)===d);
      const dateStats=stats.filter((s:any)=>dateMatches.some((m:any)=>String(m.match_no)===String(s.no)));
      const details={
        schema:"overseas_gdelt_shadow_health_v1",
        last_by_match:attemptsByDate.get(d)??{},
        due_processed:dateStats.length,
        stored:dateStats.reduce((n:number,x:any)=>n+Number(x.stored??0),0),
        errors:errors.filter(x=>dateStats.some((s:any)=>x.startsWith(String(s.no)+":"))).slice(0,10)
      };
      await db.from("soren_source_health").upsert({
        source_code:SOURCE,pool_date:d,status:details.errors.length?"partial":"ok",
        expected:dateMatches.length,captured:details.stored,verified:details.stored,
        last_attempt_at:nowIso,last_success_at:details.errors.length?null:nowIso,
        last_error:details.errors[0]??null,details,updated_at:nowIso
      },{onConflict:"source_code,pool_date"});
    }

    return Response.json({
      ok:errors.length===0,status:errors.length?"PARTIAL":"DONE",source:SOURCE,
      candidateMatches:pool.length,processed:due.length,stored:saved.length,
      sample:saved.slice(0,6),stats,errors:errors.slice(0,12),
      policy:"shadow_only_no_public_api_no_prediction_change"
    },{status:errors.length?207:200,headers:{"Cache-Control":"no-store"}});
  }catch(error){
    console.error("SOREN_OVERSEAS_INTEL_ERROR",error);
    return Response.json({ok:false,error:"OVERSEAS_INTEL_FAILED",source:SOURCE},{status:502});
  }
});
