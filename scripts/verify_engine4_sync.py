"""Fail closed if engine results are not present in the published site snapshot."""
import json
import sys
from pathlib import Path
from datetime import datetime

def load(p):
    return json.loads(p.read_text(encoding="utf-8"))

def timestamp(x):
    try:
        return datetime.fromisoformat(str(x).replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError):
        return 0

def identity(m):
    return str(m.get("source_id") or (m.get("match_no"),m.get("kickoff"),m.get("home"),m.get("away")))

def check(src, dst):
    for path in sorted(src.rglob("*.json")):
        if "history" in path.relative_to(src).parts:
            continue
        relative = path.relative_to(src)
        target = dst / relative
        if not target.exists():
            raise RuntimeError(f"Missing website file: {relative}")
        engine, website = load(path), load(target)
        if not isinstance(engine, dict) or "matches" not in engine:
            continue
        if timestamp(website.get("generated_at")) < timestamp(engine.get("generated_at")):
            raise RuntimeError(f"Stale website snapshot: {relative}")
        if relative.as_posix() == "latest.json":
            if website.get("sale_day") != engine.get("sale_day"):
                raise RuntimeError("Latest sale day mismatch")
            if len(website.get("matches", [])) != len(engine.get("matches", [])):
                raise RuntimeError("Latest match count mismatch")
            if {identity(m) for m in website.get("matches", [])} != {identity(m) for m in engine.get("matches", [])}:
                raise RuntimeError("Latest fixture identity mismatch")
            expected_total = (engine.get("metrics") or {}).get("total")
            actual_total = (website.get("metrics") or {}).get("total")
            if expected_total is not None and (actual_total != expected_total or actual_total != len(website["matches"])):
                raise RuntimeError("Latest daily metrics count mismatch")
        web_ids = [identity(m) for m in website.get("matches", [])]
        engine_ids = [identity(m) for m in engine.get("matches", [])]
        if len(web_ids) != len(set(web_ids)):
            raise RuntimeError(f"Duplicate website fixture in {relative}")
        if len(engine_ids) != len(set(engine_ids)):
            raise RuntimeError(f"Duplicate engine fixture in {relative}")
        if len(web_ids) != len(engine_ids) or set(web_ids) != set(engine_ids):
            raise RuntimeError(f"Sale-day fixture count or identity mismatch in {relative}")
        total = (website.get("metrics") or {}).get("total")
        if total is not None and total != len(web_ids):
            raise RuntimeError(f"Sales metrics.total mismatch in {relative}")
        web_matches = {identity(m):m for m in website.get("matches",[])}
        for m in engine.get("matches",[]):
            match = web_matches.get(identity(m))
            if match is None:
                raise RuntimeError(f"Missing match {identity(m)} in {relative}")
            expected = m.get("settlement")
            if expected:
                actual = match.get("settlement")
                if not actual or any(actual.get(field) != expected.get(field)
                                     for field in ("ft", "ht", "fotmob_match_id", "hits", "module_results")):
                    raise RuntimeError(f"Settlement or module result mismatch {identity(m)} in {relative}")
                if (match.get("result_verification") or {}).get("status") != "VERIFIED":
                    raise RuntimeError(f"Verified settlement marked pending {identity(m)} in {relative}")
        print(f"Verified {relative}: {len(engine['matches'])} engine fixtures")
    print("Engine-to-website snapshot verification PASSED")

if __name__ == "__main__":
    check(Path(sys.argv[1]),Path(sys.argv[2]))
