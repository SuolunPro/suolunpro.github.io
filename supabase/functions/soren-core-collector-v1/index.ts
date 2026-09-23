import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.95.0';

const sb=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
const QAPI='https://qiulaile.vip/api';
const ASIA4=['Bet365','皇冠','威廉希尔','12bet'];
const K=20,HA=60,BASE=1500;
const TEAM_ALIAS:Record<string,string>={
  'VPS瓦萨':'瓦萨','哥德堡盖斯':'盖斯','桑德菲杰':'桑纳菲','红星':'圣旺红星',
  '利雅新月':'利雅得新月','伍尔弗':'狼队','朴次茅斯':'朴茨茅斯'
};
const LEAGUE_ALIAS:Record<string,string>={'沙职':'沙特联'};
const EXTRA:Record<string,string[]>={'八户南源':['Vanraure Hachinohe'],'枥木城':['Tochigi City'],'卡迪夫城':['Cardiff City'],'奥斯纳':['VfL Osnabrück','Osnabruck'],'米拉索':['Mirassol'],'雷克瑟姆':['Wrexham'],'拜仁':['Bayern Munich','Bayern München']};
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const num=(v:any)=>Number(v);
const canonTeam=(v:any)=>TEAM_ALIAS[String(v||'').trim()]||String(v||'').trim();
const canonLeague=(v:any)=>LEAGUE_ALIAS[String(v||'').trim()]||String(v||'').trim();
function bjtDate(offset=0){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(Date.now()+offset*86400000))}
function weekday(d:string){const dt=new Date(d+'T12:00:00+08:00');return ['周日','周一','周二','周三','周四','周五','周六'][dt.getUTCDay()]}
function p3(v:any){return String(Number(v)).padStart(3,'0')}
function dayLabel(v:any){const m=String(v||'').match(/(20\d{2})\s*-\s*(\d{2})\s*-\s*(\d{2})/);return m?`${m[1]}-${m[2]}-${m[3]}`:null}
function handicap(v:any){const s=String(v||'');const m=s.match(/主\(([+-]?\d+)\)/);return m?Number(m[1]):null}
function odds3(v:any){const a=String(v||'').match(/[0-9]+\.[0-9]+/g)?.map(Number)||[];return a.length>=3?a.slice(-3):null}
function hasPublishedJcOdds(m:any){return !!odds3(m?.spfSp)||!!odds3(m?.rqspfSp)}
function split3(v:any){const a=String(v||'').trim().split(/\s+/);if(a.length<3)return null;const h=Number(a[0]),w=Number(a[a.length-1]),line=a.slice(1,-1).join(' ');return Number.isFinite(h)&&Number.isFinite(w)?{home:h,line,away:w}:null}
function numericLine(v:any){const x=Number(String(v||'').trim());return Number.isFinite(x)?x:null}
function norm(s:any){return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\b(fc|cf|afc|as|sl|gd|fco|ff)\b/g,' ').replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim()}
function similar(a:string,b:string){const x=norm(a),y=norm(b);return !!x&&!!y&&(x===y||x.includes(y)||y.includes(x))}
async function sha(s:string){const d=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s));return [...new Uint8Array(d)].map(x=>x.toString(16).padStart(2,'0')).join('')}
async function gj(url:string,timeout=15000){let last:any=null;for(let i=0;i<3;i++){try{const r=await fetch(url,{cache:'no-store',headers:{'user-agent':'Mozilla/5.0','accept':'application/json','cache-control':'no-cache'},signal:AbortSignal.timeout(timeout)});const t=await r.text();if(r.ok)return JSON.parse(t);last=new Error(`HTTP ${r.status} ${url}`)}catch(e){last=e}if(i<2)await sleep(400*(i+1))}throw last||new Error('fetch_failed')}
async function ft(url:string,timeout=20000){const r=await fetch(url,{cache:'no-store',headers:{'user-agent':'Mozilla/5.0','accept':'text/html,text/plain','cache-control':'no-cache'},signal:AbortSignal.timeout(timeout)});if(!r.ok)throw new Error(`HTTP ${r.status} ${url}`);return await r.text()}
async function health(code:string,status:string,poolDate:string|null,expected:number,captured:number,verified:number,lastError:string|null,details:any={}){const now=new Date().toISOString();await sb.from('soren_source_health').upsert({source_code:code,status,pool_date:poolDate,expected,captured,verified,last_attempt_at:now,last_success_at:status==='ok'||status==='partial'?now:null,last_error:lastError,details,updated_at:now},{onConflict:'source_code'})}

function poolForDate(all:any[],date:string){const wd=weekday(date),max=bjtDate(Math.round((+new Date(date+'T12:00:00+08:00')-+new Date(bjtDate(0)+'T12:00:00+08:00'))/86400000)+1),byNo=new Map<string,any>();for(const m of all){const disp=String(m?.displayNo||'').trim(),mm=disp.match(/(\d{3})$/),day=dayLabel(m?.dayLabel),state=String(m?.state||'').toLowerCase();if(!mm||!disp.startsWith(wd+' ')||!day||day<date||day>max||state!=='upcoming'||!hasPublishedJcOdds(m))continue;byNo.set(p3(mm[1]),m)}return [...byNo.values()].sort((a,b)=>String(a.displayNo).localeCompare(String(b.displayNo),'zh-CN',{numeric:true}))}
async function sourcePool(explicit:string|null){const today=explicit||bjtDate(0),prev=bjtDate(-1);const j=await gj(`${QAPI}/matches?matchType=0&mode=full`);const all=(Array.isArray(j?.matches)?j.matches:[]).filter((m:any)=>Number(m?.matchTypeValue)===0),tp=poolForDate(all,today);if(explicit)return{saleDate:explicit,pool:tp};const pp=poolForDate(all,prev);return tp.length?{saleDate:today,pool:tp}:{saleDate:prev,pool:pp}}

async function syncPool(explicit:string|null){const now=new Date().toISOString();const {saleDate,pool}=await sourcePool(explicit);const activeNos=new Set(pool.map((m:any)=>p3(String(m.displayNo||'').match(/(\d{3})$/)?.[1]||0)));
const {data:existing,error:ee}=await sb.from('soren_matches').select('id,match_no,source_status').eq('pool_date',saleDate);if(ee)throw ee;
for(const e of existing||[]){if(!activeNos.has(String(e.match_no))){await sb.from('soren_matches').update({source_status:{...(e.source_status||{}),pool_status:'STALE',pool_checked_at:now},updated_at:now}).eq('id',e.id)}}
let upserted=0;
for(const m of pool){const mm=String(m.displayNo||'').match(/(\d{3})$/);const d=dayLabel(m.dayLabel);if(!mm||!d)continue;const no=p3(mm[1]),kick=new Date(`${d}T${String(m.kickoff||'00:00')}:00+08:00`).toISOString();const row={pool_date:saleDate,match_no:no,match_code:saleDate.replaceAll('-','')+'-'+no,league:canonLeague(m.league),home_team:canonTeam(m.home),away_team:canonTeam(m.away),kickoff_at:kick,official_handicap:handicap(m.rqspfSp),is_world_cup:/世界杯/.test(String(m.league||'')),source_status:{pool_status:'ACTIVE',source:'qiulaile',source_match_id:String(m.id),source_home:m.home,source_away:m.away,display_no:m.displayNo,pool_checked_at:now},updated_at:now};const {error}=await sb.from('soren_matches').upsert(row,{onConflict:'pool_date,match_no'});if(error)throw error;upserted++}
await health('jc_pool','ok',saleDate,pool.length,upserted,upserted,null,{source:'qiulaile',sale_rule:'upcoming_with_published_had_or_hhad_odds'});return {saleDate,pool,upserted,stale:(existing||[]).filter((e:any)=>!activeNos.has(String(e.match_no))).map((e:any)=>e.match_no)}}

async function insertMarket(row:any){const {error}=await sb.from('soren_market_snapshots').upsert(row,{onConflict:'match_id,source_code,market_type,snapshot_type,source_hash',ignoreDuplicates:true});if(error)throw error}
async function syncMarkets(explicit:string|null){const {saleDate,pool}=await sourcePool(explicit);const {data:matches,error}=await sb.from('soren_matches').select('*').eq('pool_date',saleDate);if(error)throw error;const map=new Map((matches||[]).filter((x:any)=>x?.source_status?.pool_status==='ACTIVE').map((x:any)=>[String(x.match_no),x]));const now=new Date().toISOString();let william=0,asiaPairs=0,had=0,hhad=0;const per:any[]=[];
for(const sm of pool){const no=p3(String(sm.displayNo||'').match(/(\d{3})$/)?.[1]||0),m=map.get(no);if(!m)continue;const sourceId=String(sm.id);
 const hv=odds3(sm.spfSp);if(hv){const h=await sha(`sp|${m.id}|HAD|${hv.join('|')}`);await insertMarket({match_id:m.id,source_code:'qiulaile_sp_mirror',market_type:'HAD',snapshot_type:'current',home_value:hv[0],draw_value:hv[1],away_value:hv[2],line:null,data_quality:'verified_mirror',payload:{source_match_id:sourceId,raw:sm.spfSp},captured_at:now,source_hash:h});had++}
 const rv=odds3(sm.rqspfSp);if(rv){const ln=handicap(sm.rqspfSp);const h=await sha(`sp|${m.id}|HHAD|${ln}|${rv.join('|')}`);await insertMarket({match_id:m.id,source_code:'qiulaile_sp_mirror',market_type:'HHAD',snapshot_type:'current',home_value:rv[0],draw_value:rv[1],away_value:rv[2],line:ln,data_quality:'verified_mirror',payload:{source_match_id:sourceId,raw:sm.rqspfSp},captured_at:now,source_hash:h});hhad++}
 try{const j=await gj(`${QAPI}/match/odds?matchId=${encodeURIComponent(sourceId)}&matchType=0&home=${encodeURIComponent(sm.home)}&away=${encodeURIComponent(sm.away)}`);const lines=Array.isArray(j?.lines)?j.lines:[];const w=lines.find((x:any)=>x.market==='欧赔'&&x.company==='威廉希尔');if(w){for(const [typ,val] of [['initial',w.initial],['current',w.primary]] as any[]){const v=odds3(val);if(!v)continue;const h=await sha(`wh|${m.id}|${typ}|${v.join('|')}|${w.time||''}`);await insertMarket({match_id:m.id,source_code:'zucaijia_william',market_type:'FT_1X2',snapshot_type:typ,home_value:v[0],draw_value:v[1],away_value:v[2],data_quality:'verified',payload:{source_match_id:sourceId,company:'威廉希尔',time:w.time||null},captured_at:now,source_hash:h})}william++}}
 catch(e){per.push({match_no:no,william_error:String(e)})}
 try{const j=await gj(`${QAPI}/match/odds?matchId=${encodeURIComponent(sourceId)}&matchType=1&home=${encodeURIComponent(sm.home)}&away=${encodeURIComponent(sm.away)}`);const lines=Array.isArray(j?.lines)?j.lines:[];for(const name of ASIA4){const x=lines.find((q:any)=>q.market==='亚赔'&&String(q.company||'').toLowerCase()===name.toLowerCase());if(!x)continue;const ini=split3(x.initial),cur=split3(x.primary);if(!ini||!cur)continue;for(const [typ,v] of [['initial',ini],['current',cur]] as any[]){const h=await sha(`ah|${m.id}|${x.companyId??name}|${typ}|${v.home}|${v.line}|${v.away}|${x.time||''}`);await insertMarket({match_id:m.id,source_code:`zucaijia_asia4:${String(x.companyId??name)}`,market_type:'ASIAN_HANDICAP',snapshot_type:typ,line:numericLine(v.line),home_water:v.home,away_water:v.away,data_quality:'verified',payload:{source_match_id:sourceId,institution_name:name,institution_code:String(x.companyId??name),original_line:v.line,time:x.time||null},captured_at:now,source_hash:h})}asiaPairs++}}
 catch(e){per.push({match_no:no,asia_error:String(e)})}
}
await Promise.all([health('william',william===pool.length?'ok':william?'partial':'error',saleDate,pool.length,william,william,william===pool.length?null:`${william}/${pool.length}`),health('asia4',asiaPairs===pool.length*4?'ok':asiaPairs?'partial':'error',saleDate,pool.length*4,asiaPairs,asiaPairs,asiaPairs===pool.length*4?null:`${asiaPairs}/${pool.length*4}`),health('sporttery_sp','ok',saleDate,pool.length,hhad,hhad,null,{had_available:had,hhad_available:hhad})]);return {saleDate,matches:pool.length,william,asia_pairs:asiaPairs,asia_expected:pool.length*4,had,hhad,errors:per}}

function kickoffUtc(v:any){return new Date(v)}
function prevSeason(s:string){if(/^\d{4}$/.test(s))return String(Number(s)-1);const m=s.match(/^(\d{4})\/(\d{4})$/);return m?(Number(m[1])-1)+'/'+m[1]:''}
function score(fi:any){let h=num(fi?.home?.score),a=num(fi?.away?.score);if(Number.isFinite(h)&&Number.isFinite(a))return[h,a];const s=String(fi?.status?.scoreStr||'').match(/(-?\d+)\s*-\s*(-?\d+)/);return s?[Number(s[1]),Number(s[2])]:null}
function expHome(rh:number,ra:number){return 1/(1+Math.pow(10,(ra-(rh+HA))/400))}
function actual(h:number,a:number){return h>a?1:h<a?0:.5}
async function fj(url:string){return await gj(url,20000)}
async function insertFeature(row:any){const {error}=await sb.from('soren_feature_snapshots').upsert(row,{onConflict:'match_id,source_code,feature_type,source_hash',ignoreDuplicates:true});if(error)throw error}
async function syncElo(explicit:string|null){const {saleDate}=await sourcePool(explicit);const now=new Date();const {data:matches,error}=await sb.from('soren_matches').select('*').eq('pool_date',saleDate);if(error)throw error;const active=(matches||[]).filter((x:any)=>x?.source_status?.pool_status==='ACTIVE'&&!x.is_world_cup&&now<kickoffUtc(x.kickoff_at));const teams=[...new Set(active.flatMap((x:any)=>[x.home_team,x.away_team]))];const {data:als,error:ae}=await sb.from('soren_team_alias_fotmob').select('*').in('jc_team',teams);if(ae)throw ae;const amap=new Map<string,any>();for(const t of teams){const rs=(als||[]).filter((x:any)=>x.jc_team===t),ids=[...new Set(rs.map((x:any)=>num(x.fotmob_team_id)).filter(Number.isFinite))];if(ids.length===1)amap.set(t,{id:ids[0],rows:rs})}
const teamCache=new Map<number,any>();async function teamJson(id:number){if(teamCache.has(id))return teamCache.get(id);const j=await fj('https://www.fotmob.com/api/data/teams?id='+id);teamCache.set(id,j);return j}
const targets:any[]=[],fail:any[]=[];for(const m of active){const ha=amap.get(m.home_team),aa=amap.get(m.away_team);if(!ha||!aa){fail.push({match_no:m.match_no,status:'alias_unconfirmed'});continue}const hj=await teamJson(ha.id);const fs=hj?.fixtures?.allFixtures?.fixtures||[];const cand=fs.filter((f:any)=>num(f?.home?.id)===ha.id&&num(f?.away?.id)===aa.id&&Math.abs(+new Date(f?.status?.utcTime)-+new Date(m.kickoff_at))<=6*3600e3);if(cand.length!==1){fail.push({match_no:m.match_no,status:'fixture_unconfirmed',candidates:cand.map((x:any)=>x.id)});continue}const fi=cand[0],leagueId=num(fi?.tournament?.leagueId||hj?.details?.primaryLeagueId),season=String(hj?.details?.latestSeason||''),ccode=String(hj?.details?.country||'');if(!leagueId||!season){fail.push({match_no:m.match_no,status:'league_context_unconfirmed'});continue}targets.push({...m,home_id:ha.id,away_id:aa.id,fotmob_match_id:num(fi.id),league_id:leagueId,season,ccode})}
const groups=new Map<string,any[]>();for(const t of targets){const k=[t.league_id,t.season,t.ccode].join('|');if(!groups.has(k))groups.set(k,[]);groups.get(k)!.push(t)}let written=0;
for(const [,ts] of groups){const t0=ts[0],ps=prevSeason(t0.season),urls=[ps?`https://www.fotmob.com/api/data/leagues?id=${t0.league_id}&season=${encodeURIComponent(ps)}&ccode3=${encodeURIComponent(t0.ccode)}`:null,`https://www.fotmob.com/api/data/leagues?id=${t0.league_id}&season=${encodeURIComponent(t0.season)}&ccode3=${encodeURIComponent(t0.ccode)}`].filter(Boolean) as string[];const js=[];for(const u of urls){try{js.push(await fj(u))}catch{js.push(null)}}const games:any[]=[];const seen=new Set<number>();for(const j of js)if(j)for(const fi of (j?.fixtures?.allMatches||j?.fixtures?.allFixtures?.fixtures||[])){const id=num(fi?.id);if(!id||seen.has(id)||!fi?.status?.finished||fi?.status?.cancelled)continue;const sc=score(fi);if(!sc)continue;seen.add(id);games.push({id,utc:new Date(fi.status.utcTime).toISOString(),home_id:num(fi.home.id),away_id:num(fi.away.id),hg:sc[0],ag:sc[1]})}games.sort((a,b)=>+new Date(a.utc)-+new Date(b.utc));const events:any[]=[...games.map(g=>({type:'match',utc:g.utc,data:g})),...ts.map(t=>({type:'target',utc:t.kickoff_at,data:t}))];events.sort((a,b)=>{const d=+new Date(a.utc)-+new Date(b.utc);return d!==0?d:(a.type==='target'?-1:1)});const rating=new Map<number,number>(),gc=new Map<number,number>();const gr=(id:number)=>rating.get(id)??BASE,gg=(id:number)=>gc.get(id)??0;for(const ev of events){if(ev.type==='target'){const t=ev.data,rh=gr(t.home_id),ra=gr(t.away_id),gh=gg(t.home_id),ga=gg(t.away_id),ex=expHome(rh,ra);const payload={elo_home:rh,elo_away:ra,elo_diff:rh-ra,expected_home:ex,home_games_seen:gh,away_games_seen:ga,cold_start_home:gh<5,cold_start_away:ga<5,fotmob_match_id:t.fotmob_match_id,league_id:t.league_id,season:t.season,previous_season:ps,k_factor:K,home_advantage:HA,strict_prematch:true};const h=await sha(JSON.stringify(payload));await insertFeature({match_id:t.id,source_code:'fotmob_elo',feature_type:'ELO',data_quality:(gh<5||ga<5)?'confirmed_cold_start':'confirmed',payload,captured_at:now.toISOString(),source_hash:h});written++}else{const g=ev.data;if(new Date(g.utc)>=now)continue;const rh=gr(g.home_id),ra=gr(g.away_id),e=expHome(rh,ra),a=actual(g.hg,g.ag),delta=K*(a-e);rating.set(g.home_id,rh+delta);rating.set(g.away_id,ra-delta);gc.set(g.home_id,gg(g.home_id)+1);gc.set(g.away_id,gg(g.away_id)+1)}}}
await health('elo',written===active.length?'ok':written?'partial':'error',saleDate,active.length,written,written,written===active.length?null:`${written}/${active.length}`,{failed:fail});return {saleDate,eligible:active.length,confirmed:written,failed:fail}}

function parseKickoff(html:string){const out:any[]=[];const re=/<div class="prediction prediction-fixture">([\s\S]*?)<!-- \/prediction: fixture -->/g;let m;while((m=re.exec(html))){const b=m[1],id=(b.match(/href="\/match\/(\d+)"/)||[])[1],home=(b.match(/team-home[\s\S]*?team-name">([^<]+)</)||[])[1],away=(b.match(/team-away[\s\S]*?team-name">([^<]+)</)||[])[1],ph=Number((b.match(/prediction-win-home[^>]*>(\d+)%</)||[])[1]),pd=Number((b.match(/prediction-draw[^>]*>(\d+)%</)||[])[1]),pa=Number((b.match(/prediction-win-away[^>]*>(\d+)%</)||[])[1]);if(id&&home&&away&&[ph,pd,pa].every(Number.isFinite))out.push({id,home,away,ph:ph/100,pd:pd/100,pa:pa/100})}return out}
function findForebet(text:string,o:any,aliases:Map<string,string[]>){const hs=aliases.get(o.home_team)||[],as=aliases.get(o.away_team)||[],lower=text.toLowerCase();for(const h of hs)for(const a of as){if(!h||!a||/[\u4e00-\u9fff]/.test(h+a))continue;let pos=0;while((pos=lower.indexOf(String(h).toLowerCase(),pos))>=0){const seg=text.slice(Math.max(0,pos-180),pos+900),sl=seg.toLowerCase();if(sl.includes(String(a).toLowerCase())){const triples=[...seg.matchAll(/(?:^|\s)(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})(?:\s|$)/g)].map(m=>[+m[1],+m[2],+m[3]]).filter(v=>Math.abs(v[0]+v[1]+v[2]-100)<=2);if(triples.length){const v=triples[0];return {home:h,away:a,ph:v[0]/100,pd:v[1]/100,pa:v[2]/100}}}pos+=String(h).length}}return null}
async function syncPro(explicit:string|null){const {saleDate}=await sourcePool(explicit);const now=new Date();const {data:matches,error}=await sb.from('soren_matches').select('*').eq('pool_date',saleDate);if(error)throw error;const active=(matches||[]).filter((x:any)=>x?.source_status?.pool_status==='ACTIVE'&&!x.is_world_cup&&now<new Date(x.kickoff_at));const teams=[...new Set(active.flatMap((x:any)=>[x.home_team,x.away_team]))];const {data:als}=await sb.from('soren_team_alias_fotmob').select('jc_team,fotmob_team').in('jc_team',teams);const amap=new Map<string,string[]>();for(const t of teams)amap.set(t,[t,...(als||[]).filter((x:any)=>x.jc_team===t).map((x:any)=>x.fotmob_team),...(EXTRA[t]||[])]);const matchOne=(h:string,a:string)=>{const c=active.filter((o:any)=>(amap.get(o.home_team)||[]).some(x=>similar(x,h))&&(amap.get(o.away_team)||[]).some(x=>similar(x,a)));return c.length===1?c[0]:null};let fore=0,kick=0,api=0;let foreErr:string|null=null,kickErr:string|null=null,apiErr:string|null=null;
try{const d1=bjtDate(1);let text='';for(const d of [saleDate,d1]){try{text+='\n'+await ft('https://r.jina.ai/http://www.forebet.com/en/football-predictions/predictions-1x2/'+d)}catch{}}if(!text)throw new Error('FOREBET_EMPTY');for(const o of active){const x=findForebet(text,o,amap);if(!x)continue;const payload={p_home:x.ph,p_draw:x.pd,p_away:x.pa,source_home:x.home,source_away:x.away};const h=await sha(JSON.stringify(payload));await insertFeature({match_id:o.id,source_code:'forebet',feature_type:'PRO_PREDICTION',data_quality:'confirmed',payload,captured_at:now.toISOString(),source_hash:h});fore++}}catch(e){foreErr=String(e)}
try{const html=await ft('https://kickoff.ai/matches');const ks=parseKickoff(html);for(const x of ks){const o=matchOne(x.home,x.away);if(!o)continue;const payload={p_home:x.ph,p_draw:x.pd,p_away:x.pa,source_match_id:x.id,source_home:x.home,source_away:x.away};const h=await sha(JSON.stringify(payload));await insertFeature({match_id:o.id,source_code:'kickoff_ai',feature_type:'PRO_PREDICTION',data_quality:'confirmed',payload,captured_at:now.toISOString(),source_hash:h});kick++}}catch(e){kickErr=String(e)}
try{const {data:sec}=await sb.from('soren_internal_secrets').select('secret_value').eq('secret_name','api_sports_key').maybeSingle();const key=String(sec?.secret_value||'');if(!key){apiErr='UNCONFIGURED_API_SPORTS_KEY'}else{const next=bjtDate(1);let fixtures:any[]=[];for(const d of [saleDate,next]){const r=await fetch('https://v3.football.api-sports.io/fixtures?date='+d,{headers:{'x-apisports-key':key,'accept':'application/json'},signal:AbortSignal.timeout(20000)});const j=await r.json();fixtures.push(...(j?.response||[]))}const matched:any[]=[];for(const f of fixtures){const o=matchOne(f?.teams?.home?.name,f?.teams?.away?.name);if(o&&now<new Date(o.kickoff_at))matched.push({o,f})}for(const {o,f} of matched.slice(0,6)){const r=await fetch('https://v3.football.api-sports.io/predictions?fixture='+f.fixture.id,{headers:{'x-apisports-key':key,'accept':'application/json'},signal:AbortSignal.timeout(20000)});const j=await r.json(),p=j?.response?.[0];if(!p)continue;const pct=(v:any)=>Number(String(v||'').replace('%',''))/100,ph=pct(p.predictions?.percent?.home),pd=pct(p.predictions?.percent?.draw),pa=pct(p.predictions?.percent?.away);if(![ph,pd,pa].every(Number.isFinite))continue;const payload={p_home:ph,p_draw:pd,p_away:pa,fixture_id:f.fixture.id,winner:p.predictions?.winner?.name||null,advice:p.predictions?.advice||null};const h=await sha(JSON.stringify(payload));await insertFeature({match_id:o.id,source_code:'api_football',feature_type:'PRO_PREDICTION',data_quality:'confirmed',payload,captured_at:now.toISOString(),source_hash:h});api++}}}catch(e){apiErr=String(e)}
await Promise.all([health('forebet',fore?'ok':'partial',saleDate,active.length,fore,fore,foreErr||(!fore?'NO_MATCHED_FIXTURE':null)),health('kickoff_ai',kick?'ok':'partial',saleDate,active.length,kick,kick,kickErr||(!kick?'NO_MATCHED_FIXTURE':null)),health('api_football',api?'ok':(apiErr==='UNCONFIGURED_API_SPORTS_KEY'?'unconfigured':'partial'),saleDate,active.length,api,api,apiErr)]);return {saleDate,eligible:active.length,forebet:fore,kickoff_ai:kick,api_football:api,errors:{forebet:foreErr,kickoff:kickErr,api:apiErr}}}


const MOTHER_PUBLIC='https://tqlibowvnwfkaseqqvvp.supabase.co/functions/v1/hao-console-v1';
const REV38='3.8-bplus-single-double-v0.1-20260919';
function ftCode(v:any){return ({'主胜':'H','平':'D','客胜':'A','H':'H','D':'D','A':'A'} as any)[String(v??'')]??null}
function hpCode(v:any){return ({'让胜':'HWIN','让平':'HDRAW','让负':'HLOSS','HWIN':'HWIN','HDRAW':'HDRAW','HLOSS':'HLOSS'} as any)[String(v??'')]??null}

function ftOutcome(h:number,a:number){return h>a?'H':h<a?'A':'D'}
function handicapOutcome(h:number,a:number,line:number){const r=ftOutcome(h+line,a);return r==='H'?'HWIN':r==='D'?'HDRAW':'HLOSS'}
async function syncResults(lookbackDays=14){
  const now=new Date().toISOString();
  const j=await gj(`${QAPI}/matches?matchType=0&mode=full`,25000);
  const all=(Array.isArray(j?.matches)?j.matches:[]).filter((x:any)=>Number(x?.matchTypeValue)===0);
  const finished=new Map(all.filter((x:any)=>String(x?.state).toLowerCase()==='finished'&&String(x?.statusText||'').includes('完')).map((x:any)=>[String(x.id),x]));
  const from=bjtDate(-Math.max(1,Math.min(31,lookbackDays)));
  const {data:matches,error}=await sb.from('soren_matches').select('id,pool_date,match_no,home_team,away_team,kickoff_at,official_handicap,source_status').gte('pool_date',from).lte('kickoff_at',now);
  if(error)throw error;
  let verified=0,unchanged=0;const missing:any[]=[],rejected:any[]=[],settledRuns:any[]=[];const verifiedMatchIds:number[]=[];
  for(const m of matches||[]){
    const sourceId=String(m?.source_status?.source_match_id||'');
    const sm=finished.get(sourceId);
    if(!sm){missing.push({match_id:m.id,date:m.pool_date,no:m.match_no,reason:'SOURCE_NOT_FINISHED'});continue}
    if(canonTeam(sm.home)!==String(m.home_team)||canonTeam(sm.away)!==String(m.away_team)){
      rejected.push({match_id:m.id,date:m.pool_date,no:m.match_no,reason:'TEAM_MISMATCH',source_id:sourceId});continue
    }
    const hs=Number(sm.homeScore),as=Number(sm.awayScore);
    if(!Number.isInteger(hs)||!Number.isInteger(as)||hs<0||as<0){
      rejected.push({match_id:m.id,date:m.pool_date,no:m.match_no,reason:'INVALID_SCORE',source_id:sourceId});continue
    }
    const ft=ftOutcome(hs,as),line=Number(m.official_handicap);
    const hcap=Number.isInteger(line)?handicapOutcome(hs,as,line):null;
    const row={match_id:m.id,home_score:hs,away_score:as,ft_result:ft,handicap_result:hcap,result_source:'qiulaile_finished_exact_id_v1',verified:true,verified_at:now,raw_result:{source:'qiulaile',source_match_id:sourceId,state:sm.state,status_text:sm.statusText,score_text:sm.scoreText,home:sm.home,away:sm.away,day_label:sm.dayLabel,display_no:sm.displayNo,fetched_at:now},updated_at:now};
    const {data:prior,error:qe}=await sb.from('soren_results').select('match_id,home_score,away_score,ft_result,handicap_result,verified').eq('match_id',m.id).maybeSingle();if(qe)throw qe;
    const same=prior?.verified===true&&Number(prior.home_score)===hs&&Number(prior.away_score)===as&&prior.ft_result===ft&&prior.handicap_result===hcap;
    const {error:ue}=await sb.from('soren_results').upsert(row,{onConflict:'match_id'});if(ue)throw ue;
    same?unchanged++:verified++;verifiedMatchIds.push(Number(m.id));
  }
  if(verifiedMatchIds.length){
    const {data:preds,error:pe}=await sb.from('soren_predictions').select('run_id').in('match_id',verifiedMatchIds);if(pe)throw pe;
    const runIds=[...new Set((preds||[]).map((p:any)=>Number(p.run_id)).filter(Number.isFinite))];
    for(const runId of runIds){const {data,error:se}=await sb.rpc('soren_settle_run',{p_run_id:runId});if(se)throw se;settledRuns.push({run_id:runId,rows:Number(data||0)})}
  }
  await health('results',rejected.length?'partial':'ok',bjtDate(0),(matches||[]).length,verified+unchanged,verified+unchanged,rejected.length?rejected[0].reason:null,{from,finished_source_rows:finished.size,new_or_changed:verified,unchanged,missing:missing.length,rejected});
  return{from,checked:(matches||[]).length,finished_source_rows:finished.size,new_or_changed:verified,unchanged,missing:missing.length,rejected,settled_runs:settledRuns};
}

async function syncHJ38(explicit:string|null){
  if(!explicit||!/^20\d{2}-\d{2}-\d{2}$/.test(explicit))throw Error('VALID_DATE_REQUIRED');
  const poolResult=await syncPool(explicit);
  const r=await fetch(MOTHER_PUBLIC+'?public_hj38=1&view=archive&date='+encodeURIComponent(explicit),{headers:{accept:'application/json'},signal:AbortSignal.timeout(20000)});
  if(!r.ok)throw Error('MOTHER_PUBLIC_'+r.status);
  const data=await r.json();
  if(data?.ok!==true||data?.modelVersion!=='3.8'||data?.revision!==REV38||!Array.isArray(data?.rows))throw Error('MOTHER_HJ38_VALIDATION_FAILED');
  const now=new Date().toISOString();
  const modelRow={model_family:'soren',display_name:'索伦引擎',version:'3.8',revision_tag:REV38,status:'active',effective_at:data.dataTime||now,config:{source:'mother_hj38_formal',algorithm_change:false},notes:'客户库同步自豪竞3.8正式赛前冻结输出；不在客户库重算算法。'};
  const {data:model,error:me}=await sb.from('soren_model_registry').upsert(modelRow,{onConflict:'model_family,version,revision_tag'}).select('id').single();if(me)throw me;
  const runKey='mother-hj38:'+explicit+':'+REV38;
  const runRow={run_key:runKey,model_id:model.id,pool_date:explicit,run_type:'FORMAL',status:'COMPLETE',freeze_at:data.dataTime||now,started_at:data.batchTime||data.dataTime||now,finished_at:now,total_matches:data.rows.length,data_complete:data.rows.length===poolResult.pool.length,formal_allowed:true,no_result_leakage:true,input_manifest:{source:'mother_public_hj38',source_revision:REV38,source_data_time:data.dataTime||null,source_count:data.rows.length},notes:'同步正式3.8预测；赛果字段不参与预测生成。'};
  const {data:run,error:re}=await sb.from('soren_runs').upsert(runRow,{onConflict:'run_key'}).select('id').single();if(re)throw re;
  const {data:matches,error:xe}=await sb.from('soren_matches').select('id,match_no,home_team,away_team').eq('pool_date',explicit);if(xe)throw xe;
  const matchByNo=new Map((matches||[]).map((m:any)=>[String(m.match_no).padStart(3,'0'),m]));
  let synced=0,missing:any[]=[];
  for(const row of data.rows){
    const no=String(row.no??'').padStart(3,'0'),match=matchByNo.get(no);if(!match){missing.push({no,reason:'CLIENT_MATCH_MISSING'});continue}
    if(row.pregameVerified!==true||!row.frozenAt){missing.push({no,reason:'PREMATCH_FREEZE_UNVERIFIED'});continue}
    const rawMode=String(row.mode||row.direction||'PASS').toUpperCase(),mode=(rawMode==='SINGLE'||rawMode==='DOUBLE')?rawMode:'PASS';
    const rawCodes=Array.isArray(row.selectionCodes)?row.selectionCodes.map((x:any)=>ftCode(x)).filter(Boolean):[];
    const codes=mode==='PASS'?[]:[...new Set(rawCodes)].slice(0,mode==='SINGLE'?1:2);
    const safeMode=(mode==='SINGLE'&&codes.length===1)||(mode==='DOUBLE'&&codes.length===2)?mode:'PASS',safeCodes=((mode==='SINGLE'&&codes.length===1)||(mode==='DOUBLE'&&codes.length===2))?codes:[];
    const cv=Number(row.confidence),confidence=Number.isFinite(cv)?Math.max(0,Math.min(1,cv>1?cv/100:cv)):null;
    const tags=[row.tier,row.risk?.hur&&('HUR-'+row.risk.hur),row.risk?.dtr&&('DTR-'+row.risk.dtr),row.risk?.dlr&&('DLR-'+row.risk.dlr)].filter(Boolean).map(String);
    const pred={run_id:run.id,match_id:match.id,ft_top1:ftCode(row.ftTop1),ft_second:ftCode(row.second),selection_mode:safeMode,selection_codes:safeCodes,handicap_pick:hpCode(row.handicap),confidence,dq:row.risk?.dq||null,trigger_tags:tags,primary_reason:row.riskAnalysis||row.handicapAnalysis||null,source_snapshot:{...row,sync_source:'mother_public_hj38',sync_at:now},frozen_at:row.frozenAt,ft_class:row.tier||null,recommendation_market:'FT_1X2',recommendation_class:row.tier||null,recommendation_codes:safeCodes,recommendation_action:safeMode};
    // Never create a fresh formal customer prediction after the recognized cutoff.
    const deadline=await sb.from('soren_matches').select('cutoff_at,kickoff_at').eq('id',match.id).single();
    if(deadline.error)throw deadline.error;
    const stop=Date.parse(String(deadline.data?.cutoff_at??deadline.data?.kickoff_at??''));
    if(explicit>='2026-09-23'&&Number.isFinite(stop)&&Date.now()>=stop){
      missing.push({no,reason:'SALE_LOCK_ALREADY_CLOSED'});continue;
    }
    const {error:pe}=await sb.from('soren_predictions').upsert(pred,{onConflict:'run_id,match_id'});if(pe)throw pe;synced++;
  }
  // Scheduled mother->customer sync also captures the last genuine pre-sale publication
  // even when no customer has the website open. The RPC is idempotent and fail-closed.
  let saleFreezeCount=0;
  for(let i=0;i<data.rows.length;i+=80){
    const {data:locks,error:lockError}=await sb.rpc('soren_capture_sale_snapshots_v1',{
      p_date:explicit,p_rows:data.rows.slice(i,i+80)});
    if(lockError)throw lockError;
    saleFreezeCount+=(Array.isArray(locks)?locks:[]).filter((x:any)=>x?.snapshot).length;
  }
  return{date:explicit,source_count:data.rows.length,pool_count:poolResult.pool.length,match_count:(matches||[]).length,predictions_synced:synced,sale_freeze_snapshots:saleFreezeCount,missing,model_version:data.modelVersion,revision:data.revision,source_data_time:data.dataTime||null,run_id:run.id};
}

Deno.serve(async(req)=>{try{const u=new URL(req.url);let body:any={};try{if(req.method!=='GET')body=await req.json()}catch{}const mode=String(u.searchParams.get('mode')||body?.mode||'status'),date=u.searchParams.get('date')||body?.date||null;if(mode==='pool')return Response.json({ok:true,mode,result:await syncPool(date)});if(mode==='hj38_sync')return Response.json({ok:true,mode,result:await syncHJ38(date)});if(mode==='results')return Response.json({ok:true,mode,result:await syncResults(Number(body?.lookback_days||u.searchParams.get('lookback_days')||14))});if(mode==='markets')return Response.json({ok:true,mode,result:await syncMarkets(date)});if(mode==='elo')return Response.json({ok:true,mode,result:await syncElo(date)});if(mode==='pro')return Response.json({ok:true,mode,result:await syncPro(date)});return Response.json({ok:true,service:'soren-core-collector-v1',modes:['pool','markets','elo','pro','hj38_sync','results'],at:new Date().toISOString()})}catch(e:any){return Response.json({ok:false,error:String(e?.message||e),at:new Date().toISOString()},{status:500})}});
