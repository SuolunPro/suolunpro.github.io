"""豪智AI v0.1: deterministic seven-module calculation core. No data collection."""
import math
from datetime import datetime, timezone

def pois(k, lam):
    return math.exp(-lam) * lam**k / math.factorial(k)

def predict(fixture):
    required = ("fixture_id", "home", "away", "kickoff", "collected_at", "source", "home_xg", "away_xg", "official_handicap")
    missing = [k for k in required if k not in fixture or fixture[k] is None]
    if missing:
        return {"fixture_id": fixture.get("fixture_id"), "status": "未完成", "missing": missing}
    a, b = float(fixture["home_xg"]), float(fixture["away_xg"])
    if not (0 < a <= 6 and 0 < b <= 6):
        raise ValueError("Expected goals outside accepted bounds")
    cutoff = datetime.fromisoformat(fixture["kickoff"].replace("Z", "+00:00"))
    collected = datetime.fromisoformat(fixture["collected_at"].replace("Z", "+00:00"))
    if cutoff.tzinfo is None or collected.tzinfo is None or collected >= cutoff:
        return {"fixture_id": fixture["fixture_id"], "status": "未完成", "reason": "赛前时间戳未确认或采集晚于开赛"}
    # 0..19 truncation; residual probability is negligible for accepted lambda bounds.
    probs = {(i,j): pois(i,a)*pois(j,b) for i in range(20) for j in range(20)}
    mass = sum(probs.values())
    probs = {s:p/mass for s,p in probs.items()}
    outcome = {"3":0.0,"1":0.0,"0":0.0}
    handicap = {"让胜":0.0,"让平":0.0,"让负":0.0}
    goals = {str(i):0.0 for i in range(7)}
    goals["7+"] = 0.0
    h = int(fixture["official_handicap"])
    for (i,j),p in probs.items():
        outcome["3" if i>j else "1" if i==j else "0"] += p
        diff = i+h-j
        handicap["让胜" if diff>0 else "让平" if diff==0 else "让负"] += p
        goals[str(i+j) if i+j<7 else "7+"] += p
    top_score = sorted(probs.items(),key=lambda x:-x[1])[:3]
    # Independent increments in first/second halves, using explicit calibrated half-share.
    share = fixture.get("first_half_goal_share")
    htft = None
    if share is not None:
        share = float(share)
        if not 0 < share < 1:
            raise ValueError("Invalid first_half_goal_share")
        htft = {x+y:0.0 for x in "胜平负" for y in "胜平负"}
        for hi in range(12):
            for ai in range(12):
                hp = pois(hi,a*share)*pois(ai,b*share)
                half = "胜" if hi>ai else "平" if hi==ai else "负"
                for hs in range(12):
                    for ass in range(12):
                        p = hp*pois(hs,a*(1-share))*pois(ass,b*(1-share))
                        full = "胜" if hi+hs>ai+ass else "平" if hi+hs==ai+ass else "负"
                        htft[half+full] += p
        total = sum(htft.values())
        htft = {k:v/total for k,v in htft.items()}
    # Cold warning needs independently verified risk evidence; absent evidence != no warning.
    warning = {"status":"未确认","reason":"缺少独立盘口、必发及风险证据"}
    return {"fixture_id":fixture["fixture_id"],"status":"部分完成",
            "provenance":{"source":fixture["source"],"collected_at":fixture["collected_at"],"kickoff":fixture["kickoff"]},
            "model":"independent Poisson baseline; xG provenance supplied by caller",
            "胜平负":outcome,"让球胜平负":handicap,"总进球":goals,
            "比分Top3":[{"score":f"{i}:{j}","prob":p} for (i,j),p in top_score],
            "半全场":htft if htft else {"status":"未完成","reason":"缺少经核验的半场进球比例"},
            "冷门预警":warning,
            "今日优选":{"status":"不入选","reason":"冷门预警未完成；禁止未经审计晋级"}}

if __name__ == "__main__":
    import json,sys
    with open(sys.argv[1],encoding="utf-8") as f:
        inputs=json.load(f)
    print(json.dumps([predict(row) for row in inputs],ensure_ascii=False,indent=2))
