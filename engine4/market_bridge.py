"""Strict prematch bridge for the legacy Okooo Betfair research collector.

Never identify a fixture by lottery number alone: Okooo listings can contain
duplicates, and numbers repeat across dates. Historical downloads are NOT
retroactive prematch evidence.
"""
import json
import re
from datetime import datetime, timezone
from pathlib import Path

def norm(name):
    value=re.sub(r"[\s·•.（）()\-]","",str(name or "")).lower()
    # Explicit, reviewed names only; generic fuzzy similarity risks cross-match.
    aliases={'珀斯':'珀斯光荣','纽喷气机':'纽卡斯托','紐卡斯托':'纽卡斯托',
             '莱红牛':'莱比锡','弗洛西诺尼':'弗洛西诺内',
             '埃尔沃斯贝格':'埃沃斯堡','拉科鲁尼亚':'拉科',
             '诺丁汉':'诺丁汉森林','不莱梅':'不来梅','卡沙比亚':'卡萨皮亚'}
    return aliases.get(value,value)

def load(sale_day, root="data/engine4/okooo_research"):
    p=Path(root)/(sale_day+".json")
    try:
        doc=json.loads(p.read_text(encoding="utf-8"))
        if doc.get("sale_day")!=sale_day:return []
        return doc.get("records",[])
    except (OSError,ValueError,TypeError):
        return []

def attach(match, records):
    """Return verified, frozen-prematch market evidence or None."""
    kickoff_text=str(match.get("kickoff") or "").replace(" ","T")
    try:
        dt=datetime.fromisoformat(kickoff_text)
        if dt.tzinfo is None:
            dt=dt.replace(tzinfo=timezone.utc) if match.get("kickoff_is_utc") else dt.replace(tzinfo=__import__("datetime").timezone(__import__("datetime").timedelta(hours=8)))
        kickoff=dt.astimezone(timezone.utc)
    except (ValueError, TypeError):
        return None
    choices=[]
    for rec in records:
        if rec.get("match_no")!=match.get("match_no") or rec.get("status")!="parsed_unverified":
            continue
        if not rec.get("source_timestamp_verified"):
            continue
        stamp=rec.get("source_captured_at")
        if not stamp:continue
        try:
            at=datetime.fromisoformat(stamp.replace("Z","+00:00"))
            if at.tzinfo is None or at.astimezone(timezone.utc)>=kickoff:continue
        except (ValueError, TypeError):continue
        tx=rec.get("transaction_rows") or []
        idx=rec.get("index_rows") or []
        if len(tx)!=3 or len(idx)!=3:continue
        if norm(tx[0].get("team"))!=norm(match.get("home")):continue
        if norm(tx[2].get("team"))!=norm(match.get("away")):continue
        if norm(idx[0].get("team"))!=norm(match.get("home")):continue
        if norm(idx[2].get("team"))!=norm(match.get("away")):continue
        choices.append((at,rec))
    if len({x[1].get("okooo_id") for x in choices})>1:return None
    if not choices:return None
    at,rec=max(choices,key=lambda x:x[0])
    return {"source":"澳客必发交易所","source_url":rec.get("source_url"),"okooo_id":rec.get("okooo_id"),
            "captured_at":at.isoformat(),"transaction_rows":rec["transaction_rows"],
            "index_rows":rec["index_rows"],"exchange_scale":rec.get("exchange_scale"),"prematch_verified":True}

