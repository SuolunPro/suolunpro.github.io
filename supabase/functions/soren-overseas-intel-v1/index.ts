import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const db=createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  {auth:{persistSession:false,autoRefreshToken:false}}
);

const HEALTH_SOURCE="overseas_direct_shadow_v1";
const REPORT_SOURCE="overseas_uol_shadow_v1";
const UOL_LATEST="https://www.uol.com.br/esporte/futebol/ultimas/";
const USER_AGENT="Mozilla/5.0 (compatible; SorenOverseasIntel/1.3)";
const HOUR=3600_000;

const IMPORTANT=/(captain|key player|star|first[- ]choice|goalkeeper|keeper|top scorer|titular|capit[aã]o|goleiro|artilheiro|portero|capit[aá]n)/i;
const NEG_INJURY=/(injur(?:y|ed|ies)|ruled out|will miss|fitness doubt|doubtful|illness|absence|absent|suspend(?:ed|ed)|suspension|les[aã]o|lesionado|desfalque|suspenso|n[aã]o viajou|contus[aã]o|d[uú]vida para o jogo|fora do jogo|fora da partida|não joga|nao joga|vetado)/i;
const POS_RETURN=/(returns? to (?:training|the squad|action)|back in training|available again|declared fit|recovered|cleared to play|retorna aos treinos|volta aos treinos|fica [àa] disposi[cç][aã]o|recuperado|refor[cç]o para|retorno ao time|volta ao time|liberado para jogar)/i;
const ROTATION=/(rested|rotation|rotated squad|poupado|rod[ií]zio|preservado|descanso|time misto|poupar)/i;
const INTERNAL=/(unpaid wages?|salary arrears|wages? delayed|bonuses? unpaid|image rights.*(?:late|unpaid)|strike|boycott|internal crisis|disciplinary issue|sal[aá]rios? atrasados|direitos? de imagem.*atrasad|premia[cç][aã]o.*atrasad|greve|crise interna|problema disciplinar)/i;

function decode(s:string){
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,"$1")
    .replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'")
    .replace(/&lt;/g,"<").replace(/&gt;/g,">")
    .replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(Number(n))).trim();
}
function stripTags(s:string){
  return decode(s).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi," ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi," ")
    .replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
}
function norm(v:unknown){
  return String(v??"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase()
    .replace(/\b(football club|futebol clube|club de futbol|soccer club)\b/g," ")
    .replace(/\b(fc|cf|sc|ac)\b/g," ")
    .replace(/[^a-z0-9\p{L}]+/gu," ").replace(/\s+/g," ").trim();
}
function teamVariants(name:string){
  const n=norm(name).replace(/\brj$/,"").trim();
  const out=new Set<string>();
  if(n.length>=4)out.add(n);
  const words=n.split(" ").filter(Boolean);
  const first=words[0]??"",last=words[words.length-1]??"";
  if(first.length>=5&&!["red","sport","club"].includes(first))out.add(first);
  if(last.length>=5&&!["gama","janeiro","paranaense"].includes(last))out.add(last);
  if(n.includes("bragantino"))out.add("bragantino");
  if(n.includes("athletico paranaense")){out.add("athletico");out.add("athletico pr");}
  if(n.includes("atletico mg")){out.add("atletico mg");out.add("galo");}
  if(n.includes("botafogo"))out.add("botafogo");
  if(n.includes("vasco da gama"))out.add("vasco");
  if(n.includes("internacional"))out.add("inter");
  return [...out];
}
function mentions(text:string,variants:string[]){
  const n=norm(text);
  return variants.some(v=>v.length>=4&&n.includes(v));
}
function detectSide(text:string,homeVars:string[],awayVars:string[]):"主队"|"客队"|"双方"|null{
  const n=norm(text);
  const h=homeVars.map(v=>n.indexOf(v)).filter(i=>i>=0).sort((a,b)=>a-b)[0]??-1;
  const a=awayVars.map(v=>n.indexOf(v)).filter(i=>i>=0).sort((x,y)=>x-y)[0]??-1;
  if(h<0&&a<0)return null;
  if(h>=0&&a<0)return "主队";
  if(a>=0&&h<0)return "客队";
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
function benefitSide(categories:any[]){
  const b=new Set<string>();
  for(const c of categories){
    if(c.side==="主队")b.add(c.impact==="利好"?"主队":"客队");
    else if(c.side==="客队")b.add(c.impact==="利好"?"客队":"主队");
  }
  return b.size===1?[...b][0]:"不明确";
}
function dueMs(mins:number){
  if(mins<=120)return 30*60_000;
  if(mins<=360)return 60*60_000;
  return 120*60_000;
}
async function getText(url:string,timeoutMs:number){
  const c=new AbortController(),timer=setTimeout(()=>c.abort(),timeoutMs);
  try{
    const r=await fetch(url,{
      headers:{"user-agent":USER_AGENT,"accept":"text/html,application/xhtml+xml;q=0.9,*/*;q=0.5"},
      signal:c.signal,redirect:"follow"
    });
    if(!r.ok)return {ok:false,status:r.status,text:"",finalUrl:r.url};
    return {ok:true,status:r.status,text:(await r.text()).slice(0,1_200_000),finalUrl:r.url};
  }catch{return {ok:false,status:0,text:"",finalUrl:url}}
  finally{clearTimeout(timer)}
}
function parseLatest(html:string){
  const byUrl=new Map<string,{url:string,title:string}>();
  const re=/<a\b([^>]*?)href=(["'])(https?:\/\/(?:www\.)?uol\.com\.br\/esporte\/[^"'<>]+?\.ghtm(?:\?[^"'<>]*)?)\2([^>]*)>([\s\S]*?)<\/a>/gi;
  for(const m of html.matchAll(re)){
    const url=decode(m[3]).split("#")[0];
    let title=stripTags(m[5]);
    if(title.length<8){
      const attrs=(m[1]??"")+" "+(m[4]??"");
      const t=attrs.match(/\b(?:title|aria-label)=(["'])([\s\S]*?)\1/i);
      if(t)title=decode(t[2]);
    }
    if(!title){
      try{title=new URL(url).pathname.split("/").pop()?.replace(/\.ghtm$/,"").replace(/-/g," ")??""}catch{}
    }
    if(!byUrl.has(url)||title.length>(byUrl.get(url)?.title.length??0))byUrl.set(url,{url,title});
  }
  return [...byUrl.values()].slice(0,80);
}
function extractPublished(html:string){
  const patterns=[
    /"datePublished"\s*:\s*"([^"]+)"/i,
    /property=(["'])article:published_time\1\s+content=(["'])([^"']+)\2/i,
    /content=(["'])([^"']+)\1\s+property=(["'])article:published_time\3/i
  ];
  for(const re of patterns){
    const m=html.match(re);
    const raw=m?(m[3]??m[2]??m[1]):"";
    const t=Date.parse(raw);
    if(Number.isFinite(t))return t;
  }
  return NaN;
}

Deno.serve(async(req:Request)=>{
  if(req.method!=="POST")return Response.json({ok:false,error:"METHOD_NOT_ALLOWED"},{status:405});
  const key=req.headers.get("x-soren-intel-key")??"";
  if(key.length<32)return Response.json({ok:false,error:"UNAUTHORIZED"},{status:401});
  const {data:authorized,error:authError}=await db.rpc("soren_intel_authorized",{p_key:key});
  if(authError||authorized!==true)return Response.json({ok:false,error:"UNAUTHORIZED"},{status:401});

  let body:any={};try{body=await req.json()}catch{}
  const maxMatches=Math.max(1,Math.min(10,Number(body?.max_matches??6)));
  const nowMs=Date.now(),nowIso=new Date(nowMs).toISOString();

  try{
    const until=new Date(nowMs+36*HOUR).toISOString();
    const {data:matches,error:matchError}=await db.from("soren_matches")
      .select("id,pool_date,match_no,league,home_team,away_team,kickoff_at,is_world_cup")
      .eq("is_world_cup",false).gt("kickoff_at",nowIso).lte("kickoff_at",until)
      .order("kickoff_at",{ascending:true}).limit(120);
    if(matchError)throw matchError;
    const pool=matches??[];
    if(!pool.length)return Response.json({ok:true,status:"NO_FUTURE_MATCHES",source:HEALTH_SOURCE});

    const teams=[...new Set(pool.flatMap((m:any)=>[String(m.home_team),String(m.away_team)]))];
    const {data:aliases,error:aliasError}=await db.from("soren_team_alias_fotmob")
      .select("jc_team,fotmob_team").in("jc_team",teams).limit(500);
    if(aliasError)throw aliasError;
    const aliasMap=new Map<string,string>();
    for(const a of aliases??[]){
      const n=String((a as any).fotmob_team??"").trim();
      if(n)aliasMap.set(String((a as any).jc_team),n);
    }

    const {data:health}=await db.from("soren_source_health")
      .select("details").eq("source_code",HEALTH_SOURCE).maybeSingle();
    const oldMap=(health as any)?.details?.last_by_match??{};
    const lastByMatch:Record<string,string>={};
    if(oldMap&&typeof oldMap==="object"){
      for(const [k,v] of Object.entries(oldMap))if(typeof v==="string")lastByMatch[k]=v;
    }

    const due=pool.filter((m:any)=>{
      if(String(m.league)!=="巴甲"&&String(m.league)!=="巴乙")return false;
      if(!aliasMap.get(String(m.home_team))||!aliasMap.get(String(m.away_team)))return false;
      const kick=Date.parse(String(m.kickoff_at)),mins=(kick-nowMs)/60_000;
      const last=Date.parse(lastByMatch[String(m.id)]??"");
      return mins>0&&(!Number.isFinite(last)||(nowMs-last)>=dueMs(mins));
    }).slice(0,maxMatches);

    if(!due.length)return Response.json({
      ok:true,status:"THROTTLED_OR_UNSUPPORTED",source:HEALTH_SOURCE,candidateMatches:pool.length
    });

    const listPage=await getText(UOL_LATEST,6500);
    const errors:string[]=[],saved:any[]=[],stats:any[]=[];
    if(!listPage.ok)errors.push("UOL_LATEST_"+listPage.status);
    const links=listPage.ok?parseLatest(listPage.text):[];
    const pageCache=new Map<string,{ok:boolean,status:number,text:string,finalUrl:string}>();

    for(const m of due){
      lastByMatch[String(m.id)]=nowIso;
      const homeAlias=aliasMap.get(String(m.home_team))!,awayAlias=aliasMap.get(String(m.away_team))!;
      const homeVars=teamVariants(homeAlias),awayVars=teamVariants(awayAlias);
      const kickoff=Date.parse(String(m.kickoff_at));
      const candidates=links.filter(x=>{
        const text=x.title+" "+x.url;
        return mentions(text,homeVars)||mentions(text,awayVars);
      }).slice(0,8);

      let stored=0,classified=0,bodyFetches=0;
      for(const a of candidates){
        if(stored>=3||bodyFetches>=3)break;
        bodyFetches++;
        let page=pageCache.get(a.url);
        if(!page){
          page=await getText(a.url,4000);
          pageCache.set(a.url,page);
        }
        if(!page.ok)continue;
        const published=extractPublished(page.text);
        if(!Number.isFinite(published)||published>=kickoff||published>nowMs||published<nowMs-72*HOUR)continue;

        const evidence=(a.title+" "+stripTags(page.text)).slice(0,120_000);
        const titleSide=detectSide(a.title,homeVars,awayVars);
        const side=titleSide??detectSide(evidence,homeVars,awayVars);
        if(!side)continue;
        const categories=classify(evidence,side,a.title,"uol.com.br");
        if(!categories.length)continue;
        classified++;

        const highlights={
          schema:"overseas_intel_shadow_v1",shadow_only:true,
          sourceCountry:"brazil",sourceName:"UOL Esporte",originDomain:"uol.com.br",
          categories,benefit_side:benefitSide(categories),
          note:"仅影子情报，不参与正式预测/冷门预警权重"
        };
        const {error:saveError}=await db.from("soren_intelligence_reports_v1").upsert({
          match_id:m.id,pool_date:m.pool_date,match_no:m.match_no,home_team:m.home_team,away_team:m.away_team,
          source_code:REPORT_SOURCE,source_url:a.url,headline:a.title,
          published_at:new Date(published).toISOString(),fetched_at:nowIso,
          quality:"overseas_local_media_shadow",highlights
        },{onConflict:"match_id,source_url",ignoreDuplicates:true});
        if(saveError)errors.push(String(m.match_no)+":SAVE_"+saveError.code);
        else{stored++;saved.push({no:m.match_no,headline:a.title,benefit:highlights.benefit_side,published:new Date(published).toISOString()});}
      }
      stats.push({no:m.match_no,candidates:candidates.length,classified,stored,bodyFetches,homeAlias,awayAlias});
    }

    const healthDetails={
      schema:"overseas_direct_shadow_health_v2",
      last_by_match:lastByMatch,supported:["巴甲","巴乙"],feed:"UOL football latest HTML",
      list_links:links.length,processed:due.length,stored:saved.length,errors:errors.slice(0,12)
    };
    const {error:healthError}=await db.from("soren_source_health").upsert({
      source_code:HEALTH_SOURCE,pool_date:String(due[0]?.pool_date??""),
      status:errors.length?"partial":"ok",expected:due.length,captured:saved.length,verified:saved.length,
      last_attempt_at:nowIso,last_success_at:errors.length?null:nowIso,last_error:errors[0]??null,
      details:healthDetails,updated_at:nowIso
    },{onConflict:"source_code"});
    if(healthError)errors.push("HEALTH_"+healthError.code);

    return Response.json({
      ok:errors.length===0,status:errors.length?"PARTIAL":"DONE",source:HEALTH_SOURCE,
      processed:due.length,listLinks:links.length,stored:saved.length,
      sample:saved.slice(0,8),stats,errors:errors.slice(0,12),
      policy:"shadow_only_no_public_api_no_prediction_change"
    },{status:errors.length?207:200,headers:{"Cache-Control":"no-store"}});
  }catch(error){
    console.error("SOREN_OVERSEAS_INTEL_ERROR",error);
    return Response.json({ok:false,error:"OVERSEAS_INTEL_FAILED",source:HEALTH_SOURCE},{status:502});
  }
});