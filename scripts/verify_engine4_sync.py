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
        web_matches = {identity(m):m for m in website.get("matches",[])}
        for m in engine.get("matches",[]):
            match = web_matches.get(identity(m))
            if match is None:
                raise RuntimeError(f"Missing match {identity(m)} in {relative}")
            expected = m.get("settlement")
            if expected:
                actual = match.get("settlement")
                if not actual or actual.get("ft") != expected.get("ft") or actual.get("ht") != expected.get("ht"):
                    raise RuntimeError(f"Settlement mismatch {identity(m)} in {relative}")
        print(f"Verified {relative}: {len(engine['matches'])} engine fixtures")
    print("Engine-to-website snapshot verification PASSED")

if __name__ == "__main__":
    check(Path(sys.argv[1]),Path(sys.argv[2]))
