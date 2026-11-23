#!/usr/bin/env node
// Public-repository settlement publisher: no private Actions minutes or external PAT.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const start=html.indexOf('function independentSettlement('),end=html.indexOf('const verifiedScoreCache',start);
if(start<0||end<start)throw Error('Missing settlement function');
const calculate=vm.runInNewContext('('+html.slice(start,end).trim()+')',{Date,Number,Array,Math});
const today=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
// Scan every retained sale day for unresolved results, not just the last four days.
const dates=fs.readdirSync(path.join(root,'data/engine4/sales'))
 .filter(name=>/^\d{4}-\d{2}-\d{2}\.json$/.test(name))
 .map(name=>name.slice(0,10))
 .filter(day=>day<=today)
 .sort().reverse();
const url='https://zssourkgabcxibggwhqm.supabase.co/functions/v1/ninety-public-settlement-staging-v1';
function refreshMetrics(doc){
 const metrics=doc.metrics;
 if(!metrics)return;
 metrics.total=doc.matches.length;
 metrics.settled=doc.matches.filter(m=>Boolean(m.settlement)).length;
 metrics.pending=metrics.total-metrics.settled;
 for(const [name,old] of Object.entries(metrics.module_hits||{})){
  let hit=0,total=0;
  for(const m of doc.matches){
   const value=m.settlement?.hits?.[name];
   if(typeof value==='boolean'){total++;if(value)hit++}
  }
  metrics.module_hits[name]={hit,total,rate:total?+(hit/total).toFixed(4):null};
 }
 metrics.top1_hit_rate=metrics.module_hits?.['胜平负Top1']?.rate??null;
 for(const [name,stat] of Object.entries(metrics.module_stats||{})){
  const statuses=doc.matches.map(m=>m.settlement?.module_results?.[name]?.status)
   .filter(s=>s==='HIT'||s==='MISS');
  const hit=statuses.filter(s=>s==='HIT').length,total=statuses.length;
  stat.verified=total;
  stat.pending=Math.max(0,(Number(stat.predicted)||0)-total);
  stat.evaluation={hit,total,rate:total?+(hit/total).toFixed(4):null};
  for(const key of Object.keys(stat.rates||{})){
   const row=metrics.module_hits[name+key];
   if(row)stat.rates[key]={...row};
  }
 }
}
function uniqueNumbers(rows, day) {
 const seen = new Set();
 for (const row of rows) {
  const key = String(row.match_no);
  if (!/^\d{3}$/.test(key) || seen.has(key)) throw Error('Ambiguous lottery identity '+day+' '+key);
  seen.add(key);
 }
}
function validateResults(day, matches, results) {
 uniqueNumbers(matches, day);
 uniqueNumbers(results, day);
 const blocked = new Set();
 for (const row of results.filter(x=>x.independent_verified === true)) {
  const m = matches.find(x=>String(x.match_no) === String(row.match_no));
  if (!m) continue;
  const pairs = [[m.source_id,row.qiulaile_id],[m.fotmob_match_id,row.fotmob_match_id]]
    .filter(([a,b])=>a != null && b != null);
  if (!pairs.length || pairs.some(([a,b])=>String(a)!==String(b)))
   if (!m.settlement || pairs.length) blocked.add(String(row.match_no));
  if (m.settlement && (m.settlement.ft!==row.ft || m.settlement.ht!==row.ht))
   blocked.add(String(row.match_no));
 }
 return blocked;
}
async function main(){
 let written=0,conflicts=0,missingVerified=[];
 for(const day of dates){
  const file=path.join(root,'data/engine4/sales',day+'.json');
  if(!fs.existsSync(file))continue;
  const doc=JSON.parse(fs.readFileSync(file,'utf8'));
  if(doc.sale_day!==day||!Array.isArray(doc.matches))throw Error('Invalid snapshot '+day);
  const latestFile=path.join(root,'data/engine4/latest.json');
  const latest=JSON.parse(fs.readFileSync(latestFile,'utf8'));
  const live=latest.sale_day===day;
  if(![...doc.matches,...(live?latest.matches:[])].some(m=>m.predicted_at&&!m.settlement))continue;
  const response=await fetch(url+'?sale_day='+day,{signal:AbortSignal.timeout(12000)});
  if(!response.ok)throw Error('Supabase staging HTTP '+response.status+' for '+day);
  const audit=await response.json();
  if(audit.mode!=='verified_staging_not_official'||audit.sale_day!==day||!Array.isArray(audit.results))throw Error('Invalid staging '+day);
  const blocked=validateResults(day,doc.matches,audit.results);
  if(live) for(const no of validateResults(day,latest.matches,audit.results)) blocked.add(no);
  for(const no of blocked) console.error('Settlement identity or score requires review',day,no);
  conflicts+=blocked.size;
  let updated=0;
  for(const x of audit.results){
   if(x.independent_verified!==true || blocked.has(String(x.match_no)))continue;
   const m=doc.matches.find(m=>String(m.match_no)===String(x.match_no));
   if(!m)continue;
   if(m.settlement){if(m.settlement.ft!==x.ft||m.settlement.ht!==x.ht){conflicts++;console.error('CONFLICT',day,m.match_no)}continue}
   const settlement=calculate(m,x);
   if(!settlement)continue;
   m.settlement=settlement;
   m.result_verification={status:'VERIFIED',checked_at:x.calculated_at,source:'supabase_independent'};
   updated++;
  }
  for(const x of audit.results){
   if(x.independent_verified!==true || blocked.has(String(x.match_no)))continue;
   const m=doc.matches.find(m=>String(m.match_no)===String(x.match_no));
   if(m?.predicted_at && (!m.settlement || m.settlement.ft!==x.ft || m.settlement.ht!==x.ht)){
    missingVerified.push(day+' '+x.match_no);
   }
  }
  if(updated){
   refreshMetrics(doc);
   fs.writeFileSync(file,JSON.stringify(doc,null,2)+'\n');
   written+=updated;
  }
  if(live){
    let changed=false;
     for(const m of latest.matches||[]){
      const fresh=doc.matches.find(x=>String(x.match_no)===String(m.match_no));
      if(blocked.has(String(m.match_no)))continue;
      if(fresh?.settlement&&!m.settlement&&fresh.home===m.home&&fresh.away===m.away&&fresh.kickoff===m.kickoff&&fresh.predicted_at===m.predicted_at&&JSON.stringify(fresh.prediction)===JSON.stringify(m.prediction)){m.settlement=fresh.settlement;m.result_verification=fresh.result_verification;changed=true}
     }
    if(changed){
     refreshMetrics(latest);
     fs.writeFileSync(latestFile,JSON.stringify(latest,null,2)+'\n');
    }
  }
  console.log(day,'newly published',updated,'verified staging rows',audit.results.length);
 }
 console.log(JSON.stringify({written,conflicts,missingVerified,dates}));
 if(missingVerified.length){console.error('::error::Verified settlements not published:',missingVerified.join(', '));process.exitCode=2;}
 if(conflicts)process.exitCode=2;
}
main().catch(e=>{console.error(e);process.exitCode=1});
