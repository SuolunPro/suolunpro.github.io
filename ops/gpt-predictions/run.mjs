// A scheduled publisher. Nothing is published unless the official fixture and
// every model output pass the same validation as the private Worker.
const official = 'https://webapi.sporttery.cn/gateway/jc/football/getMatchCalculatorV1.qry?channel=c&poolCode=had,hhad,crs,ttg,hafu';
const worker = 'https://suolun-gpt-predictions.hjh19970220.workers.dev';
const dateBjt = () => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const timeout = ms => AbortSignal.timeout(ms);
const odds = (p, codes) => Object.fromEntries(codes.map(k => [k,Number(p?.[k])]).filter(([,v]) => Number.isFinite(v) && v > 1));
const fetchOfficial = async () => {
  const response=await fetch(official,{headers:{accept:'application/json',referer:'https://m.sporttery.cn/', 'user-agent':'Mozilla/5.0'},signal:timeout(15000)});
  if(!response.ok)throw Error('official_http_'+response.status);
  const doc=await response.json();
  if(!Array.isArray(doc?.value?.matchInfoList))throw Error('official_schema');
  const fetched_at=new Date().toISOString(), today=dateBjt();
  const matches=doc.value.matchInfoList.flatMap(group => (group.subMatchList||[]).map(m => {
    const kickoff=String(m.matchDate||'')+'T'+String(m.matchTime||'').slice(0,8).padEnd(8,'0')+'+08:00';
    const poolDate=String(m.businessDate||group.businessDate||'');
    const numDate=String(m.matchNumDate||group.matchNumDate||'');
    const businessDate=/^\d{4}-\d\d-\d\d$/.test(poolDate)?poolDate:/^\d{6}$/.test(numDate)?'20'+numDate.slice(0,2)+'-'+numDate.slice(2,4)+'-'+numDate.slice(4,6):'';
    return {fixture_id:String(m.matchId||''),number:String(m.matchNumStr||m.matchNum||''),date:businessDate,league:String(m.leagueAllName||''),home:String(m.homeTeamAllName||''),away:String(m.awayTeamAllName||''),kickoff_at:kickoff,source:'中国体育彩票',source_url:official,source_fetched_at:fetched_at,source_published_at:doc.value.lastUpdateTime||null,odds:{wdl:odds(m.had,['h','d','a']),handicap:m.hhad?.goalLineValue==null?null:Number(m.hhad.goalLineValue),hwdl:odds(m.hhad,['h','d','a']),score:odds(m.crs,Object.keys(m.crs||{}).filter(x=>/^s\d\ds\d\d$/.test(x))),htft:odds(m.hafu,['hh','hd','ha','dh','dd','da','ah','ad','aa']),goals:odds(m.ttg,['s0','s1','s2','s3','s4','s5','s6','s7'])}};
  })).filter(m=>m.fixture_id&&m.home&&m.away&&m.date===today&&Number.isFinite(Date.parse(m.kickoff_at))&&Date.parse(m.kickoff_at)>Date.now()+60000&&Object.keys(m.odds.wdl).length===3);
  return {today,fetched_at,matches};
};
const parseResponse = data => {
  const raw=(data.output||[]).flatMap(x=>x.content||[]).find(x=>x.type==='output_text')?.text;
  if(data.status!=='completed'||!raw)throw Error('model_incomplete');
  return JSON.parse(raw);
};
async function analyze(fixture,key){
  const input={fixture_id:fixture.fixture_id,number:fixture.number,league:fixture.league,home:fixture.home,away:fixture.away,kickoff_at:fixture.kickoff_at,odds:fixture.odds,source_fetched_at:fixture.source_fetched_at};
  const instruction='你是九十刻度赛前分析。只使用输入中的体彩赔率与可核实字段，不得编造近期战绩、伤停、机构变化或战意。赔率归一化仅是市场隐含比例，不是官方胜率；你的预测概率为模型估计。返回严格 JSON：wdl_top2 为两个不同对象 {pick:主胜|平|客胜,probability:0..1}；score_top3 为三个不同的90分钟比分字符串如 1-0；htft_top3 为三个不同的半场/全场字符串如 平/胜；goals_top3 为三个不同的进球数字符串 0..6 或 7+；upset 为 false 或 {direction:主队不胜|主队不败,risk:低|中|高,focus:简短依据}；daily_pick 为 null 或主胜|平|客胜，只有风险低且证据足够时才选；reason 简短文字；confidence 0..1。没有足够信息时降低信心，不能补造事实。';
  const response=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify({model:process.env.OPENAI_MODEL||'gpt-5-mini',store:false,max_output_tokens:1800,input:[{role:'system',content:instruction},{role:'user',content:JSON.stringify(input)}],text:{format:{type:'json_object'}}}),signal:timeout(45000)});
  if(!response.ok)throw Error('model_http_'+response.status);
  return parseResponse(await response.json());
}
const uniq=(a,n,valid)=>Array.isArray(a)&&a.length===n&&new Set(a.map(x=>typeof x==='string'?x:x?.pick)).size===n&&a.every(valid);
function normalize(f,m){
  if(!uniq(m.wdl_top2,2,x=>['主胜','平','客胜'].includes(x?.pick)&&Number.isFinite(x.probability)&&x.probability>=0&&x.probability<=1) ||
     !uniq(m.score_top3,3,x=>/^\d+-\d+$/.test(x)) ||
     !uniq(m.htft_top3,3,x=>/^[胜平负][\/／][胜平负]$/.test(x)) ||
     !uniq(m.goals_top3,3,x=>/^(?:[0-6]|7\+)$/.test(x)) ||
     (m.upset!==false&&(!m.upset||!['主队不胜','主队不败'].includes(m.upset.direction))) ||
     (m.daily_pick!==null&&!['主胜','平','客胜'].includes(m.daily_pick)) ||
     (m.upset&&m.daily_pick))throw Error('model_validation_'+f.fixture_id);
  const generated_at=new Date().toISOString();
  if(Date.parse(generated_at)>=Date.parse(f.kickoff_at))throw Error('after_kickoff_'+f.fixture_id);
  return {...f,verified:true,wdl_top2:m.wdl_top2,score_top3:m.score_top3,htft_top3:m.htft_top3,goals_top3:m.goals_top3,upset:m.upset,daily_pick:m.daily_pick,reason:String(m.reason||'').slice(0,500),confidence:Number(m.confidence)||0,note:'概率为模型估计；未提供的情报不参与分析。',generated_at};
}
async function main(){
  const {today,fetched_at,matches}=await fetchOfficial();
  console.log(JSON.stringify({phase:'collect',date:today,count:matches.length,fetched_at,source:official}));
  if(!matches.length)throw Error('no_verified_upcoming_fixture');
  if(!process.env.OPENAI_API_KEY)throw Error('missing_OPENAI_API_KEY');
  if(process.env.OPENAI_SPEND_AUTHORIZED!=='true')throw Error('OPENAI_SPEND_AUTHORIZED_required');
  if(!process.env.PUBLISH_TOKEN)throw Error('missing_PUBLISH_TOKEN');
  const predictions=[];const failures=[];
  for(const fixture of matches){
    try{predictions.push(normalize(fixture,await analyze(fixture,process.env.OPENAI_API_KEY)))}
    catch(e){failures.push({fixture_id:fixture.fixture_id,reason:String(e.message).slice(0,100)});if(/model_http_40[139]/.test(String(e)))break}
  }
  console.log(JSON.stringify({phase:'analyze',date:today,generated:predictions.length,failures}));
  if(!predictions.length)throw Error('zero_valid_predictions');
  const data={schema_version:1,date:today,generated_at:new Date().toISOString(),status:'赛前动态',source:official,source_fetched_at:fetched_at,matches:predictions};
  const response=await fetch(worker+'/publish',{method:'PUT',headers:{'content-type':'application/json','x-publish-token':process.env.PUBLISH_TOKEN},body:JSON.stringify(data),signal:timeout(15000)});
  const result=await response.json();
  if(!response.ok||result.count!==predictions.length)throw Error('publish_failed_'+response.status+'_'+JSON.stringify(result));
  console.log(JSON.stringify({phase:'published',date:today,count:result.count}));
}
main().catch(e=>{console.error(JSON.stringify({phase:'failed',error:String(e.message)}));process.exitCode=1});
