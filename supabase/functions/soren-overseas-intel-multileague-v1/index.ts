import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const db=createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  {auth:{persistSession:false,autoRefreshToken:false}}
);

const HEALTH_SOURCE="overseas_multileague_shadow_v1";
const RSS_REPORT_SOURCE="overseas_multileague_rss_shadow_v1";
const REPORT_SOURCE="overseas_uol_shadow_v1";
const UOL_STREAM="https://www.uol.com.br/esporte/noticias/v1/";
const USER_AGENT="Mozilla/5.0 (compatible; NinetyMarkAdminShadow/1.0; +https://suolunpro.github.io)";
const HOUR=3600_000;

const IMPORTANT=/(captain|key player|star|first[- ]choice|goalkeeper|keeper|top scorer|titular|capit[aã]o|goleiro|artilheiro|portero|capit[aá]n)/i;
const NEG_INJURY=/(injur(?:y|ed|ies)|ruled out|will miss|fitness doubt|doubtful|illness|absence|absent|suspend(?:ed|ed)|suspension|les[aã]o|lesionado|desfalque|suspenso|n[aã]o viajou|contus[aã]o|d[uú]vida para o jogo|fora do jogo|fora da partida|não joga|nao joga|vetado)/i;
const POS_RETURN=/(returns? to (?:training|the squad|action)|back in training|available again|declared fit|recovered|cleared to play|retorna aos treinos|volta aos treinos|fica [àa] disposi[cç][aã]o|recuperado|refor[cç]o para|retorno ao time|volta ao time|liberado para jogar)/i;
const ROTATION=/(rested|rotation|rotated squad|poupado|rod[ií]zio|preservado|descanso|time misto|poupar)/i;
const INTERNAL=/(unpaid wages?|salary arrears|wages? delayed|bonuses? unpaid|image rights.*(?:late|unpaid)|strike|boycott|internal crisis|disciplinary issue|sal[aá]rios? atrasados|direitos? de imagem.*atrasad|premia[cç][aã]o.*atrasad|greve|crise interna|problema disciplinar)/i;
const COACH_PRESSURE=/(coach.*(?:sacked|dismissed|under pressure)|manager.*(?:sacked|dismissed|under pressure)|demitid[oa]|demiss[aã]o|t[eé]cnico.*pressionad|futuro.*(?:em jogo|incerto)|cargo.*(?:em jogo|amea[cç]ado))/i;
const BROADCAST=/(onde vai passar|como assistir|assistir ao vivo|transmiss[aã]o ao vivo|hor[aá]rio e onde assistir)/i;
const OPINION=/(colunistas?|comentaristas?|palpites?|opini[aã]o|debate|analisam|an[aá]lise dos comentaristas|casagrande:|lavieri:|mauro cezar:|pvc:|tironi:|samir:|arnaldo:|bira:|acho que|aposta em|diz colunista)/i;

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
  if(n.length>=3)out.add(n);
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
  return variants.some(v=>v.length>=3&&(" "+n+" ").includes(" "+v+" "));
}
function detectSide(text:string,homeVars:string[],awayVars:string[]):"主队"|"客队"|"双方"|null{
  const n=norm(text);
  const hPos=homeVars.flatMap(v=>{const out:number[]=[];let i=n.indexOf(v);while(i>=0){out.push(i);i=n.indexOf(v,i+1)}return out});
  const aPos=awayVars.flatMap(v=>{const out:number[]=[];let i=n.indexOf(v);while(i>=0){out.push(i);i=n.indexOf(v,i+1)}return out});
  if(!hPos.length&&!aPos.length)return null;
  if(hPos.length&&!aPos.length)return "主队";
  if(aPos.length&&!hPos.length)return "客队";
  const signals=["desfalque","lesao","suspens","fora do jogo","fora da partida","poupad","retorn","volta ao time","recuperad","salario","atrasad","demit","demissao","pressionad"];
  let best:{side:"主队"|"客队",d:number}|null=null;
  for(const s of signals){
    let p=n.indexOf(s);
    while(p>=0){
      const hd=Math.min(...hPos.map(x=>Math.abs(x-p)));
      const ad=Math.min(...aPos.map(x=>Math.abs(x-p)));
      if(hd!==ad){
        const cand={side:(hd<ad?"主队":"客队") as "主队"|"客队",d:Math.min(hd,ad)};
        if(cand.d<=180&&(!best||cand.d<best.d))best=cand;
      }
      p=n.indexOf(s,p+1);
    }
  }
  return best?.side??"双方";
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
  if(COACH_PRESSURE.test(text)&&!OPINION.test(title))add("帅位","利空");
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
function extractNextToken(html:string){
  const m=html.match(/[?&]next=([A-Za-z0-9]+)/i);
  return m?.[1]??null;
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


/* Admin-only, nonblocking all-JCZQ-league discovery. Official JCZQ pool defines
   coverage; publisher RSS feeds provide best-effort hard news, never synthetic
   articles. Feed parsing is bounded and requires publication before kickoff. */
const LANG_INJURY=/(injur(?:y|ed|ies)|suspend(?:ed|sion)|ruled out|doubtful|unavailable|absence|desfalqu|les[aã]o|lesionad|suspens|vetad|fora da partida|verletz|gesperrt|f[aä]llt aus|bless[ué]|suspendu|geblesseerd|geschors|loukkaant|sivussa|出場停止|負傷|欠場|離脱|出場辞退|부상|결장|징계|停赛|伤停|受伤|缺阵)/i;
const LANG_RETURN=/(return(?:s|ed)? to (?:training|squad)|back in training|recovered|fit again|retorn|recuperad|zur[uü]ck|r[ué]tour|terugkeer|palaa kokoonpanoon|復帰|復出|복귀|回归)/i;
const LANG_ROTATION=/(rotation|rotated|rested|poupad|rod[ií]zio|escala[cç][aã]o alternat|rotacion|rotatie|rotation|turnover|kierr[aä]t|ローテーション|ターンオーバー|로테이션|轮换)/i;
const LANG_INTERNAL=/(unpaid wages|salary arrears|strike|boycott|internal crisis|sal[aá]rios? atrasad|greve|crise interna|未払い|給与未払|임금 체불|拖欠工资)/i;
const LANG_COACH=/(sacked|dismissed|manager under pressure|demitid|demiss[aã]o|t[eé]cnico pressionad|trainer ontslagen|entlassen|d[eé]mis|監督解任|경질|下课)/i;
const LANG_NOISE=/(where to watch|live stream|tv channel|onde assistir|transmiss[aã]o ao vivo|predict(?:ion|ed)|betting tips|palpites|hor[aá]rio e onde|生中継|直播|赔率|賭け|배당률)/i;
const RSS_CATALOG:Record<string,{name:string,url:string,locale:string}> = {
  bbc:{name:"BBC Sport",url:"https://www.bbc.co.uk/sport/football/rss.xml",locale:"international"},
  espn:{name:"ESPN Soccer",url:"https://www.espn.com/espn/rss/soccer/news",locale:"international"},
  japan:{name:"Soccer King",url:"https://www.soccer-king.jp/feed",locale:"japan"},
  korea:{name:"Footballist",url:"https://www.footballist.co.kr/rss/allArticle.xml",locale:"korea"},
  dutch:{name:"Voetbal International",url:"https://www.vi.nl/rss",locale:"netherlands"},
  finland:{name:"SuomiFutis",url:"https://www.suomifutis.com/feed/",locale:"finland"},
  finland2:{name:"Ilta-Sanomat Sport",url:"https://www.is.fi/rss/urheilu.xml",locale:"finland"},
  finland3:{name:"Iltalehti Sport",url:"https://www.iltalehti.fi/rss/urheilu.xml",locale:"finland"}
};
function feedKeysForLeague(v:unknown):string[]{
  const league=String(v??"");
  if(/日职|日联|天皇杯|日本|亚运/.test(league))return ["japan","espn"];
  if(/韩|韩国|K联|K2/.test(league))return ["korea","espn"];
  if(/荷/.test(league))return ["dutch","espn"];
  if(/芬/.test(league))return ["finland","finland2","finland3","espn"];
  if(/巴甲|巴乙|巴西/.test(league))return ["espn"];
  return ["espn","bbc"];
}
function rssField(part:string,key:string):string{
  const escaped=key; // Fixed internal RSS tag names only.
  const re=new RegExp("<"+escaped+"(?:\\s[^>]*)?>([\\s\\S]*?)<\\/"+escaped+">","i");
  return stripTags(part.match(re)?.[1]??"").trim();
}
function rssEntries(xml:string,feedKey:string){
  const catalog=RSS_CATALOG[feedKey];
  const out:any[]=[];
  const chunks=[...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].slice(0,75);
  for(const match of chunks){
    const chunk=match[1],title=rssField(chunk,"title");
    const href=rssField(chunk,"link");
    const pub=rssField(chunk,"pubDate")||rssField(chunk,"dc:date")||rssField(chunk,"published");
    const ts=Date.parse(pub);
    if(title.length<12||!/^https:\/\//i.test(href)||!Number.isFinite(ts))continue;
    let host="";try{host=new URL(href).hostname.toLowerCase()}catch{continue}
    if(!host||host==="news.google.com"||host==="www.bing.com")continue;
    out.push({
      title:title.slice(0,280),url:href.slice(0,900),published:ts,
      desc:rssField(chunk,"description").slice(0,600),name:catalog.name,
      locale:catalog.locale,domain:host
    });
  }
  return out;
}
const extraAliases:Record<string,string>={
  "古比斯":"KuPS","奥卢":"AC Oulu","瑞模贝雷":"Remo",
  "沙佩科恩斯":"Chapecoense"
};
function allTeamVariants(chineseName:string,translated:string){
  return [...new Set([...teamVariants(translated),...teamVariants(chineseName)])];
}
function classifyRSS(text:string,side:"主队"|"客队"|"双方",title:string,host:string){
  const out:any[]=[];
  const level=IMPORTANT.test(text)||/主力|核心|隊長|主将|代表主将|주장|goleiro|keeper/i.test(text)?"高":"中";
  const add=(type:string,impact:"利好"|"利空")=>out.push({side,type,level,impact,summary:title.slice(0,220),domain:host});
  if(LANG_INJURY.test(text))add("伤停","利空");
  if(LANG_ROTATION.test(text))add("轮换","利空");
  if(LANG_INTERNAL.test(text))add("内部","利空");
  if(LANG_COACH.test(text))add("帅位","利空");
  if(LANG_RETURN.test(text))add("复出","利好");
  return out;
}

Deno.serve(async(req:Request)=>{
  if(req.method!=="POST")return Response.json({ok:false,error:"METHOD_NOT_ALLOWED"},{status:405});
  const key=req.headers.get("x-soren-intel-key")??"";
  if(key.length<32)return Response.json({ok:false,error:"UNAUTHORIZED"},{status:401});
  const {data:authorized,error:authError}=await db.rpc("soren_intel_authorized",{p_key:key});
  if(authError||authorized!==true)return Response.json({ok:false,error:"UNAUTHORIZED"},{status:401});

  let body:any={};try{body=await req.json()}catch{}
  const maxMatches=Math.max(1,Math.min(4,Number(body?.max_matches??4)));
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
      // All valid non-World-Cup JCZQ leagues enter the same bounded queue.
      const kick=Date.parse(String(m.kickoff_at)),mins=(kick-nowMs)/60_000;
      const last=Date.parse(lastByMatch[String(m.id)]??"");
      return mins>0&&(body?.force_rescan===true||!Number.isFinite(last)||(nowMs-last)>=dueMs(mins));
    }).slice(0,maxMatches);

    if(!due.length)return Response.json({
      ok:true,status:"THROTTLED_OR_NOT_DUE",source:HEALTH_SOURCE,candidateMatches:pool.length
    });

    const errors:string[]=[],saved:any[]=[],stats:any[]=[];
    const runtimeDeadline=Date.now()+23000;
    const keys=[...new Set(due.flatMap((m:any)=>feedKeysForLeague(m.league)))].slice(0,5);
    const rssCache=new Map<string,{ok:boolean,items:any[],status:number}>();
    const fetchedFeeds=await Promise.all(keys.map(async k=>{
      const t=await getText(RSS_CATALOG[k].url,3500);
      return {key:k,ok:t.ok,status:t.status,items:t.ok?rssEntries(t.text,k):[]};
    }));
    for(const f of fetchedFeeds){
      rssCache.set(f.key,{ok:f.ok,status:f.status,items:f.items});
      if(!f.ok)errors.push("FEED_"+f.key+"_"+f.status);
    }
    const isBrazilPool=due.some((m:any)=>/巴甲|巴乙/.test(String(m.league)));
    const first=isBrazilPool?await getText(UOL_STREAM,4500):{ok:true,status:200,text:"",finalUrl:UOL_STREAM};
    if(isBrazilPool&&!first.ok)errors.push("UOL_STREAM_"+first.status);
    const streamPages:string[]=first.ok?[first.text]:[];
    const linkMap=new Map<string,{url:string,title:string}>();
    for(const html of streamPages){
      for(const a of parseLatest(html)){
        if(!linkMap.has(a.url)||(a.title.length>(linkMap.get(a.url)?.title.length??0)))linkMap.set(a.url,a);
      }
    }
    const links=[...linkMap.values()].slice(0,80);
    const pageCache=new Map<string,{ok:boolean,status:number,text:string,finalUrl:string}>();

    for(const m of due){
      if(Date.now()>runtimeDeadline)break;
      lastByMatch[String(m.id)]=nowIso;
      const homeName=String(m.home_team),awayName=String(m.away_team);
      const homeAlias=aliasMap.get(homeName)||extraAliases[homeName]||"";
      const awayAlias=aliasMap.get(awayName)||extraAliases[awayName]||"";
      const homeVars=allTeamVariants(homeName,homeAlias);
      const awayVars=allTeamVariants(awayName,awayAlias);
      const kickoff=Date.parse(String(m.kickoff_at));
      const candidates=(/巴甲|巴乙/.test(String(m.league))?links:[]).filter(x=>{
        const text=x.title+" "+x.url;
        return mentions(text,homeVars)||mentions(text,awayVars);
      }).map(x=>{
        const hard=NEG_INJURY.test(x.title)||POS_RETURN.test(x.title)||ROTATION.test(x.title)||INTERNAL.test(x.title);
        const coach=COACH_PRESSURE.test(x.title)&&!OPINION.test(x.title);
        const score=hard?10:coach?7:BROADCAST.test(x.title)?-10:OPINION.test(x.title)?-5:1;
        return {...x,score};
      }).filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,8);

      let stored=0,classified=0,bodyFetches=0;
      for(const a of candidates){
        if(stored>=2||bodyFetches>=1||Date.now()>runtimeDeadline)break;
        bodyFetches++;
        let page=pageCache.get(a.url);
        if(!page){
          page=await getText(a.url,2200);
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

      let rssStored=0,newsCandidates=0;
      const useFeeds=feedKeysForLeague(m.league),seenRss=new Set<string>();
      const matching:any[]=[];
      for(const k of useFeeds){
        for(const item of (rssCache.get(k)?.items??[])){
          if(seenRss.has(item.url))continue;
          seenRss.add(item.url);
          if(item.published>=kickoff||item.published>nowMs||item.published<nowMs-96*HOUR)continue;
          if(LANG_NOISE.test(item.title)||OPINION.test(item.title)||BROADCAST.test(item.title))continue;
          // A report has to name an actual participant, not merely the league.
          if(!mentions(item.title,homeVars)&&!mentions(item.title,awayVars))continue;
          newsCandidates++;
          const side=detectSide(item.title,homeVars,awayVars);
          if(!side)continue;
          const categories=classifyRSS(item.title+" "+item.desc,side,item.title,item.domain);
          if(!categories.length)continue;
          matching.push({...item,categories});
        }
      }
      matching.sort((a,b)=>b.published-a.published);
      for(const item of matching.slice(0,2)){
        if(Date.now()>runtimeDeadline)break;
        const hi={
          schema:"overseas_multileague_rss_shadow_v1",shadow_only:true,
          sourceCountry:item.locale,sourceName:item.name,originDomain:item.domain,
          categories:item.categories,benefit_side:benefitSide(item.categories),
          note:"媒体RSS发布时间已核验在开球前；正文未独立核验；仅管理员影子信息，不影响正式预测/冷门预警"
        };
        const {error:err}=await db.from("soren_intelligence_reports_v1").upsert({
          match_id:m.id,pool_date:m.pool_date,match_no:m.match_no,
          home_team:m.home_team,away_team:m.away_team,
          source_code:RSS_REPORT_SOURCE,source_url:item.url,headline:item.title,
          published_at:new Date(item.published).toISOString(),fetched_at:nowIso,
          quality:"overseas_rss_prematch_shadow",highlights:hi
        },{onConflict:"match_id,source_url",ignoreDuplicates:true});
        if(err)errors.push(String(m.match_no)+":RSS_SAVE_"+err.code);
        else{rssStored++;saved.push({no:m.match_no,headline:item.title,published:new Date(item.published).toISOString()});}
      }
      stats.push({
        no:m.match_no,poolDate:m.pool_date,league:m.league,
        candidates:candidates.length,classified,stored,bodyFetches,homeAlias,awayAlias,
        aliasConfirmed:!!homeAlias&&!!awayAlias,rssFeeds:useFeeds,
        rssFeedOk:useFeeds.filter(k=>rssCache.get(k)?.ok===true).length,
        rssCandidates:newsCandidates,rssStored
      });
    }

    const previousScans=(health as any)?.details?.scan_by_match??{};
    const scans:Record<string,unknown>={};
    if(previousScans&&typeof previousScans==="object")Object.assign(scans,previousScans);
    for(const row of stats){
      scans[String(row.poolDate)+"|"+String(row.no)]={
        scannedAt:nowIso,league:row.league,
        status:row.rssStored+row.stored>0?"FOUND":
          row.rssFeedOk>0?"NO_HARD_NEWS":"FEED_UNAVAILABLE",
        aliasConfirmed:row.aliasConfirmed,
        rssFeedOk:row.rssFeedOk,rssCandidates:row.rssCandidates
      };
    }
    const recentScans=Object.fromEntries(Object.entries(scans).slice(-150));
    const healthDetails={
      schema:"overseas_multileague_shadow_health_v1",
      last_by_match:lastByMatch,scan_by_match:recentScans,
      supported:[...new Set(pool.map((m:any)=>String(m.league)))],
      scope:"all_non_world_cup_jczq_future_matches",
      feed:"region-matched original publisher RSS + Brazil UOL; shadow-only",
      feedKeys:keys,feedSuccess:keys.filter(k=>rssCache.get(k)?.ok===true),
      feedItemCounts:Object.fromEntries(keys.map(k=>[k,rssCache.get(k)?.items.length??0])),
      stream_pages:streamPages.length,list_links:links.length,
      processed:stats.length,candidateMatches:pool.length,stored:saved.length,errors:errors.slice(0,12)
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
      processed:due.length,streamPages:streamPages.length,listLinks:links.length,stored:saved.length,
      sample:saved.slice(0,8),stats,errors:errors.slice(0,12),
      policy:"shadow_only_no_public_api_no_prediction_change"
    },{status:errors.length?207:200,headers:{"Cache-Control":"no-store"}});
  }catch(error){
    console.error("SOREN_OVERSEAS_INTEL_ERROR",error);
    return Response.json({ok:false,error:"OVERSEAS_INTEL_FAILED",source:HEALTH_SOURCE},{status:502});
  }
});