const worker='https://suolun-gpt-predictions.hjh19970220.workers.dev';
const source='https://webapi.sporttery.cn/gateway/jc/football/getMatchResultV1.qry';
const token=process.env.PUBLISH_TOKEN;
if(!token)throw Error('missing_PUBLISH_TOKEN');
const dates=[0,1,2].map(n=>new Date(Date.now()+8*3600000-n*86400000).toISOString().slice(0,10));
const score=s=>{const m=/^(\d+)[:\-](\d+)$/.exec(String(s||''));return m?[Number(m[1]),Number(m[2])]:null};
for(const date of dates){
 const pendingResponse=await fetch(worker+'/pending?date='+date,{headers:{'x-publish-token':token},signal:AbortSignal.timeout(12000)});
 if(!pendingResponse.ok)throw Error('pending_http_'+pendingResponse.status);
 const pending=(await pendingResponse.json()).matches;
 if(!pending.length){console.log(JSON.stringify({date,pending:0,external_requests:0}));continue}
 const url=source+'?matchPage=1&matchBeginDate='+date+'&matchEndDate='+date+'&leagueId=&pageSize=200&pageNo=1&isFix=0&pcOrWap=1';
 const response=await fetch(url,{headers:{referer:'https://www.sporttery.cn/','user-agent':'Mozilla/5.0'},signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw Error('results_http_'+response.status);
 const body=await response.json();
 if(!Array.isArray(body?.value?.matchResult))throw Error('results_schema');
 const matches=new Map(body.value.matchResult.map(m=>[String(m.matchId),m]));
 const results=[];
 for(const fixture of pending){
  const m=matches.get(String(fixture.fixture_id));
  if(!m||String(m.matchResultStatus)!=='2'||String(m.poolStatus).toLowerCase()!=='payout')continue;
  if(String(m.allHomeTeam||'')!==fixture.home||String(m.allAwayTeam||'')!==fixture.away)continue;
  const ht=score(m.sectionsNo1),ft=score(m.sectionsNo999);
  if(!ht||!ft)continue;
  results.push({fixture_id:fixture.fixture_id,ht_home:ht[0],ht_away:ht[1],ft_home:ft[0],ft_away:ft[1],status:'FINISHED',source_url:url,source_fetched_at:new Date().toISOString()});
 }
 if(results.length){
  const posted=await fetch(worker+'/settle',{method:'PUT',headers:{'content-type':'application/json','x-publish-token':token},body:JSON.stringify({date,results}),signal:AbortSignal.timeout(12000)});
  if(!posted.ok)throw Error('settle_http_'+posted.status+'_'+await posted.text());
 }
 console.log(JSON.stringify({date,pending:pending.length,settled:results.length,unconfirmed:pending.length-results.length}));
}
