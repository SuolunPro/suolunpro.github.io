"""Settle one immutable pre-match prediction against verified 90-minute scores."""
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from engine4.fotmob_results import result_for
from engine4.fotmob import json_get

BJT = timezone(timedelta(hours=8))


def score(raw):
    value = re.fullmatch(r"\s*(\d+)\s*[:\-]\s*(\d+)\s*", str(raw or ""))
    return tuple(map(int, value.groups())) if value else None


def outcome(home, away):
    return "胜" if home > away else "平" if home == away else "负"


def mark(match, result, current):
    ht, ft = score(result.get("ht")), score(result.get("ft"))
    if ht is None or ft is None or any(h > f for h, f in zip(ht, ft)):
        return None
    try:
        kickoff = datetime.fromisoformat(match["kickoff"].replace(" ", "T")).replace(tzinfo=BJT).astimezone(timezone.utc)
        predicted = datetime.fromisoformat(match["predicted_at"].replace("Z", "+00:00"))
        if predicted.tzinfo is None or predicted >= kickoff or current < kickoff + timedelta(minutes=120):
            return None
    except (KeyError, ValueError):
        return None
    p = match.get("prediction") or {}
    if p.get("status") != "PREDICTED":
        return None
    modules = p.get("modules") or {}
    spf = outcome(*ft)
    half_full = outcome(*ht) + "-" + spf
    handicap = match.get("handicap")
    rq = "让" + outcome(ft[0] + handicap, ft[1]) if isinstance(handicap, int) else None

    def ranked(name, field, actual, index):
        picks = (modules.get(name) or {}).get(field) or []
        return actual in picks[:index] if isinstance(picks, list) and len(picks) >= index else None

    def top1(name, actual, field="top1"):
        picks = (modules.get(name) or {}).get(field)
        if field == "top3":
            picks = picks[0] if isinstance(picks, list) and picks else None
        if field == "top2":
            picks = picks[0] if isinstance(picks, list) and picks else None
        return picks == actual if picks is not None else None

    total = ft[0] + ft[1]
    goals = "7+" if total >= 7 else total
    cold = modules.get("冷门预警") or {}
    risk = cold.get("direction")
    cold_occurred = (spf != "胜" if risk == "主队不胜" else spf != "负" if risk == "主队不败" else None)
    selection = (modules.get("今日优选") or {}).get("selection")
    picks = selection if isinstance(selection, list) else [selection] if selection is not None else []
    daily_top1 = picks[0] == spf if picks else None
    daily_top2 = spf in picks[:2] if len(picks) >= 2 else None
    hits = {
        "胜平负Top1": top1("胜平负", spf),
        "胜平负Top2": ranked("胜平负", "top2", spf, 2),
        "让球Top1": top1("让球", rq, "top2") if rq else None,
        "让球Top2": ranked("让球", "top2", rq, 2) if rq else None,
        "比分Top1": top1("比分", f"{ft[0]}:{ft[1]}", "top3"),
        "比分Top3": ranked("比分", "top3", f"{ft[0]}:{ft[1]}", 3),
        "比分Top4": ranked("比分", "top4", f"{ft[0]}:{ft[1]}", 4),
        "总进球Top1": top1("总进球", goals, "top3"),
        "总进球Top3": ranked("总进球", "top3", goals, 3),
        "半全场Top1": top1("半全场", half_full, "top3"),
        "半全场Top3": ranked("半全场", "top3", half_full, 3),
        "今日优选Top1": daily_top1,
        "今日优选Top2": daily_top2,
        "今日优选": daily_top2 if daily_top2 is not None else daily_top1,
        "冷门预警": cold_occurred if cold.get("triggered") is True else None,
    }
    def detail(name, actual, picks, fields):
        values = {field: hits.get(name + field) for field in fields}
        primary = next((values[field] for field in reversed(fields) if values[field] is not None), None)
        return {"actual": actual, "picks": picks, "hits": values,
                "status": "HIT" if primary is True else "MISS" if primary is False else "NO_FORMAL_SELECTION"}
    module_results = {
        "胜平负": detail("胜平负", spf, (modules.get("胜平负") or {}).get("top2"), ("Top1", "Top2")),
        "让球": detail("让球", rq, (modules.get("让球") or {}).get("top2"), ("Top1", "Top2")),
        "比分": detail("比分", f"{ft[0]}:{ft[1]}", (modules.get("比分") or {}).get("top4") or (modules.get("比分") or {}).get("top3"), ("Top1", "Top3", "Top4")),
        "总进球": detail("总进球", goals, (modules.get("总进球") or {}).get("top3"), ("Top1", "Top3")),
        "半全场": detail("半全场", half_full, (modules.get("半全场") or {}).get("top3"), ("Top1", "Top3")),
        "今日优选": {"actual": spf, "picks": picks, "hits": {"Top1": daily_top1, "Top2": daily_top2},
                     "hit": hits["今日优选"],
                     "status": "HIT" if hits["今日优选"] is True else "MISS" if hits["今日优选"] is False else "NO_FORMAL_SELECTION"},
        "冷门预警": {"actual": spf, "direction": risk if cold.get("triggered") is True else None,
                     "upset_occurred": cold_occurred if cold.get("triggered") is True else None,
                     "hit": hits["冷门预警"],
                     "status": "HIT" if hits["冷门预警"] is True else "MISS" if hits["冷门预警"] is False else "NO_FORMAL_TRIGGER"},
    }
    return {"ht": result["ht"], "ft": result["ft"], "verified_at": result.get("verified_at") or current.isoformat(),
            "source_url": result["source_url"], "fotmob_match_id": result.get("fotmob_match_id"),
            "scope": "90min_regular_ft", "hits": hits, "module_results": module_results}


def settle(path, current=None):
    current = current or datetime.now(timezone.utc)
    path = Path(path)
    if not path.exists():
        return None
    report = json.loads(path.read_text(encoding="utf-8"))
    changed = False
    cache = {}
    def cached_get(url):
        if url not in cache:
            cache[url] = json_get(url)
        return cache[url]
    for match in report.get("matches", []):
        if match.get("settlement") or not match.get("predicted_at"):
            continue
        try:
            result, error = result_for(match, get=cached_get, current=current)
            if error:
                diagnostic = {"status": "PENDING", "reason": error, "checked_at": current.isoformat()}
                if match.get("result_verification", {}).get("reason") != error:
                    match["result_verification"] = diagnostic
                    changed = True
                print(json.dumps({"match_no": match.get("match_no"), "pending": error}, ensure_ascii=False))
                continue
            settlement = mark(match, result, current)
            if settlement:
                for field in ("fotmob_match_id", "fotmob_home_team_id", "fotmob_away_team_id"):
                    if result.get(field):
                        match[field] = result[field]
                match["settlement"] = settlement
                match["result_verification"] = {"status": "VERIFIED", "checked_at": current.isoformat()}
                changed = True
        except Exception as exc:
            print(json.dumps({"match_no": match.get("match_no"), "source_error": str(exc)[:200], "action": "keep_pending"}))
    if changed:
        path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"sale_day": report.get("sale_day"), "settled": sum(bool(m.get("settlement")) for m in report.get("matches", []))}))
    return report


if __name__ == "__main__":
    import sys
    for filename in sys.argv[1:]:
        settle(filename)
