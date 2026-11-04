"""Generate an honest seven-module audit report from verified fixture inputs.

Never interprets unverified candidate count as official full-pool coverage.
Run: python haozhi-ai/report.py verified_inputs.json
"""
import json
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from engine import predict

MODULES=("胜平负","让球胜平负","总进球","比分Top3","半全场","冷门预警","今日优选")

def build_report(document):
    fixtures=document.get("fixtures",[])
    if not isinstance(fixtures,list):
        raise ValueError("fixtures must be a list")
    ids=[f.get("fixture_id") for f in fixtures]
    if len(ids)!=len(set(ids)):
        raise ValueError("duplicate fixture IDs")
    results=[predict(f) for f in fixtures]
    finished={key:0 for key in MODULES}
    for r in results:
        for key in MODULES[:4]:
            if isinstance(r.get(key), (dict,list)) and r.get("status")=="部分完成":
                finished[key]+=1
        if isinstance(r.get("半全场"),dict) and "status" not in r["半全场"]:
            finished["半全场"]+=1
        # No risk clearance / cold warning implementation yet, so 0 for both.
    official_count=document.get("verified_official_full_pool_count")
    coverage=None
    if isinstance(official_count,int) and not isinstance(official_count,bool) and official_count>0 and document.get("official_pool_verified") is True:
        coverage={"verified_inputs":len(fixtures),"official_total":official_count,
                  "rate":len(fixtures)/official_count}
    return {"engine":"豪智AI v0.1","overall":"未通过完整七模块验收",
            "official_pool_coverage":coverage if coverage else "未确认",
            "candidate_count":len(fixtures),"module_completed_counts":finished,
            "fixtures":results,
            "cold_warning_list":{"status":"未确认","reason":"尚无可核验的全池冷门触发审计"},
            "daily_selection":{"status":"暂不发布","reason":"风险审计未完成"},
            "limitations":["官方赛程及SP真实性未由本程序核验",
                           "进球期望须由独立赛前来源提供",
                           "市场资金、机构盘口和冷门审计未实现",
                           "没有历史赛前冻结样本的校准或命中率证明"]}

if __name__=="__main__":
    source=json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    print(json.dumps(build_report(source),ensure_ascii=False,indent=2))
