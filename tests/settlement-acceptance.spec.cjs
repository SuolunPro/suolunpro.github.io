const { test, expect } = require('@playwright/test');
const base='https://suolunpro.github.io';
test('live deployment, independent score and module settlement',async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base,{waitUntil:'domcontentloaded'});
 const deployed=await page.evaluate(async()=>{const s=await (await fetch('/index.html?audit='+Date.now(),{cache:'no-store'})).text();return s.includes('function independentSettlement')&&s.includes('m.settlement=verified')});
 expect(deployed).toBe(true);
 const frozen=await page.evaluate(async()=>await (await fetch('/data/engine4/sales/2026-11-15.json',{cache:'no-store'})).json());
 const staged=await page.evaluate(async()=>await (await fetch('https://zssourkgabcxibggwhqm.supabase.co/functions/v1/ninety-public-settlement-staging-v1?sale_day=2026-11-15',{cache:'no-store'})).json());
 expect(staged.mode).toBe('verified_staging_not_official');
 const source=await page.evaluate(async()=>await (await fetch('/index.html',{cache:'no-store'})).text());
 const start=source.indexOf('function independentSettlement('),end=source.indexOf('async function checkSupabaseSettlementStaging',start);
 expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
 const compute=await page.evaluate(src=>new Function(src+';return independentSettlement;')(),source.slice(start,end));
 for(const no of ['002','003']){
  const m=frozen.matches.find(x=>String(x.match_no)===no);
  const x=staged.results.find(x=>String(x.match_no)===no);
  expect(x, 'staging '+no).toBeTruthy();expect(x.independent_verified).toBe(true);
  expect(x.fotmob_match_id).toBe(m.fotmob_match_id);
  const settlement=await page.evaluate(({m,x,src})=>new Function(src+';return independentSettlement;')()(m,x),{m,x,src:source.slice(start,end)});
  expect(settlement,'settlement '+no).toBeTruthy();
  expect(Object.keys(settlement.hits)).toHaveLength(16);
  expect(Object.keys(settlement.module_results)).toHaveLength(8);
  expect(settlement.ft).toBe(x.ft);
  expect(await page.evaluate(({m,x,src})=>new Function(src+';return independentSettlement;')()(m,{...x,fotmob_match_id:-1}),{m,x,src:source.slice(start,end)})).toBeNull();
 }
 expect(errors).toEqual([]);
});

test('historical day isolation, refresh and no duplicate official settlement',async({page})=>{
 const source=await (await page.request.get('https://suolunpro.github.io/index.html')).text();
 const start=source.indexOf('function independentSettlement('),end=source.indexOf('async function checkSupabaseSettlementStaging',start);
 expect(start).toBeGreaterThan(0);
 const fn=source.slice(start,end);
 for(const day of ['2026-11-14','2026-11-15']){
  const res=await page.request.get(base+'/data/engine4/sales/'+day+'.json');
  expect(res.ok()).toBe(true);
  const data=await res.json();
  expect(data.sale_day).toBe(day);
  const audit=await page.request.get('https://zssourkgabcxibggwhqm.supabase.co/functions/v1/ninety-public-settlement-staging-v1?sale_day='+day);
  expect(audit.ok()).toBe(true);
  const body=await audit.json();expect(body.sale_day).toBe(day);
  for(const x of body.results){
   const m=data.matches.find(m=>String(m.match_no)===String(x.match_no));
   if(!m||m.settlement||x.published_settlement_present!==false)continue;
   const v=await page.evaluate(({m,x,fn})=>new Function(fn+';return independentSettlement;')()(m,x),{m,x,fn});
   if(v){expect(Object.keys(v.hits)).toHaveLength(16);expect(Object.keys(v.module_results)).toHaveLength(8);}
  }
 }
 const published=await (await page.request.get(base+'/data/engine4/sales/2026-11-15.json')).json();
 const official=published.matches.find(m=>m.settlement);
 if(official){
  const original=JSON.stringify(official.settlement);
  const audit=await (await page.request.get('https://zssourkgabcxibggwhqm.supabase.co/functions/v1/ninety-public-settlement-staging-v1?sale_day=2026-11-15')).json();
  const x=audit.results.find(x=>String(x.match_no)===String(official.match_no));
  if(x){const candidate=await page.evaluate(({m,x,fn})=>new Function(fn+';return independentSettlement;')()(m,x),{m:official,x,fn});expect(JSON.stringify(official.settlement)).toBe(original);expect(candidate?.ft||x.ft).toBe(official.settlement.ft);}
 }
});
