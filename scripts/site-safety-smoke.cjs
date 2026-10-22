'use strict';
// Guard against UI regressions without touching any customer data.
const fs=require('node:fs');
const assert=require('node:assert/strict');
const index=fs.readFileSync('index.html','utf8');
const bundle=fs.readFileSync('assets/app-20261003.js','utf8');
assert.ok(fs.existsSync('assets/app-20261003.css'),'Site stylesheet missing');
for(const module of ['daily','overview','handicap','htft','score','goals','cold']){
  assert.ok(index.includes('data-model="'+module+'"'),'Module tab missing: '+module);
}
assert.ok(index.includes('assets/app-20261003.js'),'App bundle not linked');
for(const marker of [
  "function htftCard(", "function sgShadowTop3Panel(", "function goalPredictionPanel(",
  "function updateMetrics()", "function renderHome()", "function load("
])assert.ok(bundle.includes(marker),'Critical UI route missing: '+marker);
const metrics=bundle.slice(bundle.indexOf('function updateMetrics()'),bundle.indexOf('function render(){closeDetail()'));
assert.ok(metrics.includes("if(state.model==='htft')"),'HTFT metrics missing');
assert.ok(metrics.includes("if(state.model==='goals')"),'Goals metrics missing');
assert.ok(metrics.includes("labels[1].textContent='Top3命中 / 已评测'"),'Top3-only evaluation lost');
assert.ok(metrics.includes("if(state.model==='score'){\n            const top1Hits"),'Score-only Top1 scope regressed');
assert.ok(bundle.includes("if(state.model!=='htft'&&state.model!=='goals')reportLine"),
  'HTFT/Goals Top1 detail display regressed');
const goalStats=bundle.slice(bundle.indexOf('function goalStatSummary('),bundle.indexOf('function isFormalGoalPrediction('));
const goalDetail=bundle.slice(bundle.indexOf('function goalPredictionPanel('),bundle.indexOf('function teamOverviewPanel('));
assert.ok(goalStats.includes("return {total:items.length,n:finished.length,top3};"),'Goal results must expose only Top3 hit rate');
assert.ok(!/\btop1\b/i.test(goalStats),'Poisson results cannot compute a Top1 rate');
assert.ok(!goalDetail.includes("top1="),'Poisson details cannot score Top1 separately');
assert.ok(goalDetail.includes("Top3 · "),'Poisson results must grade Top3');
assert.ok(bundle.includes("const status=data.settlementStatus;"),'Top3 settlement evaluator missing');
console.log('PASS: seven tabs, content renderers, Top3-only HTFT/Goals and match evaluator.');
