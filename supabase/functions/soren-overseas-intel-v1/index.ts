import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const db=createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  {auth:{persistSession:false,autoRefreshToken:false}}
);

const SOURCE="overseas_google_news_shadow_v1";
const USER_AGENT="Mozilla/5.0 (compatible; SorenOverseasIntel/1.1)";
const HOUR=3600_000;

const COUNTRY_BY_LEAGUE:Record<string,string>={
  "巴甲":"brazil","巴乙":"brazil","芬超":"finland",
  "英超":"unitedkingdom","英冠":"unitedkingdom","英甲":"unitedkingdom","英乙":"unitedkingdom","苏超":"unitedkingdom",
  "西甲":"spain","西乙":"spain","意甲":"italy","意乙":"italy",
  "德甲":"germany","德乙":"germany","法甲":"france","法乙":"france",
  "荷甲":"netherlands","荷乙":"netherlands","葡超":"portugal",
  "日职":"japan","日乙":"japan","韩职":"southkorea","澳超":"australia","美职":"unitedstates",
  "瑞超":"sweden","挪超":"norway","丹超":"denmark","比甲":"belgium","奥甲":"austria",
  "瑞士超":"switzerland","土超":"turkey"
};
const LOCALE:Record<string,{hl:string,gl:string,ceid:string}>={
  brazil:{hl:"pt-BR",gl:"BR",ceid:"BR:pt-419"},
  finland:{hl:"fi",gl:"FI",ceid:"FI:fi"},
  unitedkingdom:{hl:"en-GB",gl:"GB",ceid:"GB:en"},
  spain:{hl:"es",gl:"ES",ceid:"ES:es"},
  italy:{hl:"it",gl:"IT",ceid:"IT:it"},
  germany:{hl:"de",gl:"DE",ceid:"DE:de"},
  france:{hl:"fr",gl:"FR",ceid:"FR:fr"},
  netherlands:{hl:"nl",gl:"NL",ceid:"NL:nl"},
  portugal:{hl:"pt-PT",gl:"PT",ceid:"PT:pt-150"},
  japan:{hl:"ja",gl:"JP",ceid:"JP:ja"},
  southkorea:{hl:"ko",gl:"KR",ceid:"KR:ko"},
  australia:{hl:"en-AU",gl:"AU",ceid:"AU:en"},
  unitedstates:{hl:"en-US",gl:"US",ceid:"US:en"},
  sweden:{hl:"sv",gl:"SE",ceid:"SE:sv"},
  norway:{hl:"no",gl:"NO",ceid:"NO:no"},
  denmark:{hl:"da",gl:"DK",ceid:"DK:da"},
  belgium:{hl:"nl",gl:"BE",ceid:"BE:nl"},
  austria:{hl:"de",gl:"AT",ceid:"AT:de"},
  switzerland:{hl:"de",gl:"CH",ceid:"CH:de"},
  turkey:{hl:"tr",gl:"TR",ceid:"TR:tr"}
};

const IMPORTANT=/(captain|key player|star|first[- ]choice|goalkeeper|keeper|top scorer|titular|capit[aã]o|goleiro|artilheiro|portero|capit[aá]n|gardien|torwart)/i;
const NEG_INJURY=/(injur(?:y|ed|ies)|ruled out|will miss|misses the match|fitness doubt|doubtful|illness|did not travel|not travel(?:led)?|absence|absent|suspend(?:ed|ed)|suspension|les[aã]o|lesionado|desfalque|suspenso|n[aã]o viajou|contus[aã]o|d[uú]vida para o jogo|lesi[oó]n|baja para el partido|suspendido|infortunio|assente|squalificato|bless[ée]|suspendu|incertain|verletzt|gesperrt|fraglich|loukkaant|pelikielto)/i;
const POS_RETURN=/(returns? to (?:training|the squad|action)|back in training|available again|declared fit|recovered|cleared to play|retorna aos treinos|volta aos treinos|fica [àa] disposi[cç][aã]o|recuperado|refor[cç]o para|regresa al equipo|vuelve a entrenar|recuperado para|rientra|recuperato|torna disponibile|de retour|reprend l'entra[iî]nement|wieder im training|kehrt zur[uü]ck|palasi harjoituksiin|palaa kokoonpanoon)/i;
const ROTATION=/(rested|rotation|rotated squad|rotate the squad|poupado|rod[ií]zio|preservado|descanso|rotaciones|turnover|riposo|rotation de l'effectif|geschont)/i;
const INTERNAL=/(unpaid wages?|salary arrears|wages? delayed|bonuses? unpaid|image rights.*(?:late|unpaid)|strike|boycott|internal crisis|disciplinary issue|sal[aá]rios? atrasados|direitos? de imagem.*atrasad|premia[cç][aã]o.*atrasad|greve|crise interna|problema disciplinar|sueldos? atrasados|impagos?|huelga)/i;

function xmlDecode(s:string){
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,"$1")
    .replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'")
    .replace(/&lt;/g,"<").replace(/&gt;/g,">").trim();
}
function stripTags(s:string){
  return s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi," ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi," ")
    .replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
}
function norm(v:unknown){
  return String(v??"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase()
    .replace(/\b(football club|futebol clube|club de futbol|soccer club)\b/g," ")
    .replace(/\b(fc|cf|sc|ac)\b/g," ")
    .replace(/[^a-z0-9\p{L}]+/gu," ").replace(/\s+/g," ").trim();
}
function aliasNeedle(s:string){
  return norm(s).replace(/^(red bull)\s+/,"").replace(/\brj$/,"").trim();
}
function detectSide(text:string,homeAlias:string,awayAlias:string):"主队"|"客队"|"双方"|null{
  const n=norm(text),h=aliasNeedle(homeAlias),a=aliasNeedle(awayAlias);
  const hi=h.length>=4?n.indexOf(h):-1, ai=a.length>=4?n.indexOf(a):-1;
  if(hi<0&&ai<0)return null;
  if(hi>=0&&ai<0)return "主队";
  if(ai>=0&&hi<0)return "客队";
  if(Math.min(hi,ai)<80&&Math.abs(hi-ai)>8)return hi<ai?"主队":"客队";
  return "双方";
}
function classify(text:string,side:"主队"|"客队"|"双方",title:string,domain:string){
  const out:any[]=[];
  const level=IMPORTANT.test(text)?"高":"中";
  const add=(type:string,impact:"利好"|"利空")=>out.push({
    side,type,level,impact,summary:title.slice(0,220),domain
  });
  if(NEG_INJURY.test(text))add("伤停","利空");
  if(ROTATION.test(text))add("轮换","利空");
  if(INTERNAL.test(text))add("内部","利空");
  if(POS_RETURN.test(text))add("复出","利好");
  return out;
}
function dueMs(mins:number){
  if(mins<=120)return 30*60_000;
  if(mins<=360)return 60*60_000;
  return 120*60_000;
}
async function getText(url:string,timeoutMs:number,accept:string){
  const c=new AbortController(),timer=setTimeout(()=>c.abort(),timeoutMs);
  try{
    const r=await fetch(url,{headers:{"user-agent":USER_AGENT,"accept":accept},signal:c.signal,redirect:"follow"});
    if(!r.ok)return {ok:false,status:r.status,text:""};
    const text=(await r.text()).slice(0,300_000);
    return {ok:true,status:r.status,text};
  }catch{return {ok:false,status:0,text:""}}
  finally{clearTimeout(timer)}
}
function newsUrl(home:string,away:string,country:string|null){
  const loc=LOCALE[country??""]??{hl:"en-US",gl:"US",ceid:"US:en"};
  const q='"'+home.replaceAll('"',"")+'" "'+away.replaceAll('"',"")+'"';
  const p=new URLSearchParams({q,hl:loc.hl,gl:loc.gl,ceid:loc.ceid});
  return "https://news.google.com/rss/search?"+p.toString();
}
function parseRss(xml:string,country:string|null){
  const out:any[]=[];
  const re=/<item>([\s\S]*?)<\/item>/gi;
  for(const m of xml.matchAll(re)){
    const block=m[1];
    const pick=(tag:string)=>{
      const x=block.match(new RegExp("<"+tag+"(?:\\s[^>]*)?>([\\s\\S]*?)<\\/"+tag+">","i"));
      return x?xmlDecode(x[1]):"";
    };
    const src=block.match(/<source(?:\s+url="([^"]*)")?[^>]*>([\s\S]*?)<\/source>/i);
    const link=pick("link"),title=pick("title"),pubDate=pick("pubDate");
    if(!link||!title)continue;
    let domain="";
    try{domain=src?.[1]?new URL(xmlDecode(src[1])).hostname:new URL(link).hostname}catch{}
    out.push({url:link,title,published:Date.parse(pubDate),domain,sourceName:src?.[2]?xmlDecode(src[2]):"",country});
  }
  return out;
}
function benefitSide(categories:any[]){
  const benefits=new Set<string>();
  for(const c of categories){
    if(c.side==="主队"){
      if(c.impact==="利好")benefits.add("主队"); else if(c.impact==="利空")benefits.add("客队");
    }else if(c.side==="客队"){
      if(c.impact==="利好")benefits.add("客队"); else if(c.impact==="利空")benefits.add("主队");
    }
  }
  return benefits.size===1?[...benefits][0]:"不明确";
}

Deno.serve(async(req:Request)=>{
  if(req.method!=="POST")return Response.json({ok:false,error:"METHOD_NOT_ALLOWED"},{status:405});
  const key=req.headers.get("x-soren-intel-key")??"";
  if(key.length<32)return Response.json({ok:false,error:"UNAUTHORIZED"},{status:401});
  const {data:authorized,error:authError}=await db.rpc("soren_intel_authorized",{p_key:key});
  if(authError||authorized!==true)return Response.json({ok:false,error:"UNAUTHORIZED"},{status:401});

  let body:any={}; try{body=await req.json()}catch{}
  const maxMatches=Math.max(1,Math.min(8,Number(body?.max_matches??6)));
  const now=new Date(),nowMs=now.getTime(),nowIso=now.toISOString();

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
      const name=String((a as any).fotmob_team??"").trim();
      if(name)aliasMap.set(String((a as any).jc_team),name);
    }

    const {data:health}=await db.from("soren_source_health")
      .select("details").eq("source_code",SOURCE).maybeSingle();
    const oldMap=(health as any)?.details?.last_by_match??{};
    const lastByMatch:Record<string,string>={};
    if(oldMap&&typeof oldMap==="object"){
      for(const [k,v] of Object.entries(oldMap))if(typeof v==="string")lastByMatch[k]=v;
    }

    const due=pool.filter((m:any)=>{
      if(!aliasMap.get(String(m.home_team))||!aliasMap.get(String(m.away_team)))return false;
      const kick=Date.parse(String(m.kickoff_at)),mins=(kick-nowMs)/60_000;
      const last=Date.parse(lastByMatch[String(m.id)]??"");
      return mins>0&&(!Number.isFinite(last)||(nowMs-last)>=dueMs(mins));
    }).slice(0,maxMatches);

    if(!due.length)return Response.json({
      ok:true,status:"THROTTLED_NO_DUE_MATCHES",source:SOURCE,candidateMatches:pool.length
    });

    const errors:string[]=[],stats:any[]=[],saved:any[]=[];
    for(const m of due){
      const homeAlias=aliasMap.get(String(m.home_team))!,awayAlias=aliasMap.get(String(m.away_team))!;
      const country=COUNTRY_BY_LEAGUE[String(m.league)]??null;
      const kickoff=Date.parse(String(m.kickoff_at));
      lastByMatch[String(m.id)]=nowIso;

      const feed=await getText(newsUrl(homeAlias,awayAlias,country),5000,"application/rss+xml,application/xml,text/xml");
      if(!feed.ok){
        errors.push(String(m.match_no)+":GNEWS_"+feed.status);
        stats.push({no:m.match_no,feedOk:false,items:0,stored:0,country,homeAlias,awayAlias});
        continue;
      }

      const items=parseRss(feed.text,country)
        .filter((x:any)=>Number.isFinite(x.published)&&x.published<kickoff&&x.published<=nowMs&&x.published>=nowMs-72*HOUR)
        .slice(0,10);

      let stored=0,bodyFetches=0,classified=0;
      for(const item of items){
        if(stored>=2)break;
        let evidence=item.title;
        let side=detectSide(evidence,homeAlias,awayAlias);
        let categories=side?classify(evidence,side,item.title,item.domain):[];

        if(!categories.length&&bodyFetches<2){
          bodyFetches++;
          const page=await getText(item.url,3500,"text/html,application/xhtml+xml,text/plain");
          if(page.ok&&page.text){
            evidence=(item.title+" "+stripTags(page.text)).slice(0,100_000);
            side=detectSide(evidence,homeAlias,awayAlias);
            categories=side?classify(evidence,side,item.title,item.domain):[];
          }
        }
        if(!categories.length)continue;
        classified++;

        const highlights={
          schema:"overseas_intel_shadow_v1",shadow_only:true,
          sourceCountry:country??"",sourceName:item.sourceName??"",originDomain:item.domain??"",
          categories,benefit_side:benefitSide(categories),
          note:"仅影子情报，不参与正式预测/冷门预警权重"
        };
        const {error:saveError}=await db.from("soren_intelligence_reports_v1").upsert({
          match_id:m.id,pool_date:m.pool_date,match_no:m.match_no,home_team:m.home_team,away_team:m.away_team,
          source_code:SOURCE,source_url:item.url,headline:item.title,
          published_at:new Date(item.published).toISOString(),fetched_at:nowIso,
          quality:country?"overseas_local_media_shadow":"overseas_media_shadow",highlights
        },{onConflict:"match_id,source_url",ignoreDuplicates:true});
        if(saveError)errors.push(String(m.match_no)+":SAVE_"+saveError.code);
        else{stored++;saved.push({no:m.match_no,headline:item.title,benefit:highlights.benefit_side});}
      }
      stats.push({no:m.match_no,feedOk:true,items:items.length,classified,stored,bodyFetches,country,homeAlias,awayAlias});
    }

    const healthDetails={
      schema:"overseas_google_news_shadow_health_v1",
      last_by_match:lastByMatch,
      processed:due.length,stored:saved.length,
      errors:errors.slice(0,12)
    };
    const {error:healthError}=await db.from("soren_source_health").upsert({
      source_code:SOURCE,
      pool_date:String(due[0]?.pool_date??pool[0]?.pool_date??""),
      status:errors.length?"partial":"ok",
      expected:pool.length,captured:saved.length,verified:saved.length,
      last_attempt_at:nowIso,last_success_at:errors.length?null:nowIso,
      last_error:errors[0]??null,details:healthDetails,updated_at:nowIso
    },{onConflict:"source_code"});
    if(healthError)errors.push("HEALTH_"+healthError.code);

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
