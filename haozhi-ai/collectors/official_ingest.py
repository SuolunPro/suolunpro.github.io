"""Validate externally acquired official lottery fixture records. No scraping claims.

Input JSON schema:
{"retrieved_at":"ISO8601 with timezone","source_url":"https://...",
 "fixtures":[{"fixture_id":"2026-11-04-001","home":"...","away":"...",
 "kickoff":"ISO8601","sale_end":"ISO8601",
 "official_handicap":1,"sp_1x2":{"3":2.5,"1":3.1,"0":2.8},
 "sp_handicap":{"3":1.8,"1":3.3,"0":3.8}}]}
"""
import json
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

def parse_time(value):
    dt=datetime.fromisoformat(value.replace("Z","+00:00"))
    if dt.tzinfo is None:
        raise ValueError("timezone required")
    return dt

def validate_record(data):
    if not isinstance(data,dict):
        raise ValueError("expected JSON object")
    source=data.get("source_url","")
    if urlparse(source).scheme!="https" or not urlparse(source).netloc:
        raise ValueError("source_url must be an HTTPS source")
    retrieved=parse_time(data["retrieved_at"])
    fixtures=data.get("fixtures")
    if not isinstance(fixtures,list):
        raise ValueError("fixtures must be list")
    seen=set()
    for f in fixtures:
        for key in ("fixture_id","home","away","kickoff","sale_end","official_handicap","sp_1x2","sp_handicap"):
            if key not in f or f[key] is None:
                raise ValueError(f"missing {key} in fixture")
        if f["fixture_id"] in seen:
            raise ValueError("duplicate fixture_id")
        seen.add(f["fixture_id"])
        if not isinstance(f["official_handicap"],int) or isinstance(f["official_handicap"],bool):
            raise ValueError("official handicap must be integer")
        if parse_time(f["sale_end"])>parse_time(f["kickoff"]):
            raise ValueError("sale end after kickoff")
        if retrieved>=parse_time(f["sale_end"]):
            raise ValueError("retrieval too late for pre-sale snapshot")
        for key in ("sp_1x2","sp_handicap"):
            odds=f[key]
            if not isinstance(odds,dict) or set(odds)!={"3","1","0"}:
                raise ValueError("SP must have 3/1/0")
            if any(isinstance(x,bool) or not isinstance(x,(int,float)) or not 1.0<float(x)<1000 for x in odds.values()):
                raise ValueError("invalid SP")
    return {"status":"结构校验通过，真实性未独立核验",
            "fixture_count":len(fixtures),"source_url":source,"retrieved_at":data["retrieved_at"]}

def ingest(path):
    data=json.loads(Path(path).read_text(encoding="utf-8"))
    return validate_record(data)

if __name__=="__main__":
    import sys
    print(json.dumps(ingest(sys.argv[1]),ensure_ascii=False,indent=2))
