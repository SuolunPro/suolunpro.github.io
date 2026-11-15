"""Fail-closed matching and publication rules for the LOTA desktop assistant."""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from typing import Any

CN = timezone(timedelta(hours=8))
FIELDS = ("home_volume", "draw_volume", "away_volume", "trade_ratio", "trade_price", "updated_at")


def current_sale_day(now: datetime | None = None) -> str:
    return (now or datetime.now(CN)).astimezone(CN).date().isoformat()


def official_matches(payload: dict, sale_day: str) -> list[dict]:
    if payload.get("sale_day") != sale_day or not isinstance(payload.get("matches"), list):
        raise ValueError("正式竞彩销售日不符或比赛清单缺失")
    out = []
    seen = set()
    for m in payload["matches"]:
        key = (str(m.get("match_no", "")), str(m.get("source_id", "")))
        if not all(m.get(k) for k in ("match_no", "source_id", "home", "away", "league", "kickoff")) or key in seen:
            raise ValueError("正式竞彩清单含缺失字段或重复比赛")
        seen.add(key)
        out.append({k: m[k] for k in ("match_no", "source_id", "home", "away", "league", "kickoff")})
    return out


def normalize(s: str) -> str:
    return re.sub(r"[\s·•.（）()\-]", "", s).casefold()


def match_candidate(official: dict, candidate: dict) -> bool:
    """Require number, teams, league, kickoff and an independent LOTA ID.

    Aliases must be explicitly reviewed; fuzzy names alone never authorize a match.
    """
    required = ("match_no", "home", "away", "league", "kickoff", "lota_match_id")
    if not all(candidate.get(k) for k in required):
        return False
    if str(candidate["match_no"]).zfill(3) != str(official["match_no"]).zfill(3):
        return False
    if any(normalize(str(candidate[k])) != normalize(str(official[k])) for k in ("home", "away", "league")):
        return False
    try:
        a = datetime.fromisoformat(str(official["kickoff"]).replace(" ", "T"))
        b = datetime.fromisoformat(str(candidate["kickoff"]).replace(" ", "T"))
    except ValueError:
        return False
    return abs((a - b).total_seconds()) <= 300


def validate_record(record: dict, official: dict) -> dict:
    if not match_candidate(official, record):
        raise ValueError("比赛匹配证据不足")
    if record.get("access") != "public" or record.get("page_verified") is not True:
        raise ValueError("公开分发权限或页面核对未证实")
    for key in FIELDS:
        if record.get(key) is None:
            raise ValueError(f"缺少真实业务字段：{key}")
    for key in FIELDS[:3]:
        if isinstance(record[key], bool) or not isinstance(record[key], (int, float)) or record[key] < 0:
            raise ValueError(f"成交量不合法：{key}")
    if not isinstance(record["trade_ratio"], dict) or not isinstance(record["trade_price"], dict):
        raise ValueError("比例和价格必须按胜平负结构化")
    for key in ("home", "draw", "away"):
        ratio, price = record["trade_ratio"].get(key), record["trade_price"].get(key)
        if not isinstance(ratio, (int, float)) or not 0 <= ratio <= 100:
            raise ValueError("交易比例不合法")
        if not isinstance(price, (int, float)) or price <= 1:
            raise ValueError("交易价格不合法")
    if abs(sum(record["trade_ratio"].values()) - 100) > 1.5:
        raise ValueError("交易比例合计不合理")
    updated = datetime.fromisoformat(str(record["updated_at"]).replace("Z", "+00:00"))
    if updated.tzinfo is None:
        raise ValueError("更新时间缺少时区")
    return record


def publishable_payload(sale_day: str, officials: list[dict], records: list[dict]) -> dict:
    by_no = {str(m["match_no"]).zfill(3): m for m in officials}
    valid: dict[str, dict] = {}
    for record in records:
        no = str(record.get("match_no", "")).zfill(3)
        if no not in by_no or no in valid:
            raise ValueError("未知或重复的竞彩编号")
        valid[no] = validate_record(record, by_no[no])
    if not valid:
        raise ValueError("没有经过页面核对的真实业务数据，禁止上传")
    return {"schema": "lota-public-v1", "sale_day": sale_day,
            "official_count": len(officials), "matches": [valid[k] for k in sorted(valid)]}


def canonical_bytes(payload: dict) -> bytes:
    return (json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()


def digest(payload: dict) -> str:
    return hashlib.sha256(canonical_bytes(payload)).hexdigest()
