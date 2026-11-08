"""Merge engine snapshots into the website without reverting settled fixtures."""
import json
import sys
from pathlib import Path
from datetime import datetime

def read(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None

def stamp(value):
    try:
        return datetime.fromisoformat(str(value or "").replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError):
        return 0

def key(match):
    return (str(match.get("sale_day") or ""), str(match.get("source_id") or ""), str(match.get("kickoff") or ""), str(match.get("home") or ""), str(match.get("away") or ""))

def merge(source, existing):
    if not isinstance(existing, dict):
        return source
    # Preserve the newest document metadata, but reconcile each fixture independently.
    # A sale-day generated_at can be stale even after an individual match settles.
    if stamp(existing.get("generated_at")) > stamp(source.get("generated_at")):
        base, other = existing, source
    else:
        base, other = source, existing
    old_matches = {key(m): m for m in other.get("matches", []) if isinstance(m, dict)}
    for match in base.get("matches", []):
        old = old_matches.get(key(match))
        if not old:
            continue
        current_settlement = match.get("settlement")
        other_settlement = old.get("settlement")
        current_verified = bool(current_settlement) and (match.get("result_verification") or {}).get("status") == "VERIFIED"
        other_verified = bool(other_settlement) and (old.get("result_verification") or {}).get("status") == "VERIFIED"
        if other_verified and (not current_verified or
            stamp(other_settlement.get("verified_at")) > stamp(current_settlement.get("verified_at"))):
            match["settlement"] = other_settlement
            match["result_verification"] = old["result_verification"]
            for field in ("fotmob_match_id", "fotmob_home_team_id", "fotmob_away_team_id"):
                if old.get(field) is not None:
                    match[field] = old[field]
        elif not current_verified and not other_verified:
            if stamp((old.get("result_verification") or {}).get("checked_at")) > stamp(
                (match.get("result_verification") or {}).get("checked_at")):
                match["result_verification"] = old["result_verification"]
    # If a verified match only exists in the older document, retain it too.
    seen = {key(m) for m in base.get("matches", [])}
    for old in other.get("matches", []):
        if isinstance(old, dict) and key(old) not in seen:
            base.setdefault("matches", []).append(old)
            seen.add(key(old))
    return base

def main(src, dst):
    if not src.is_dir():
        raise SystemExit("Engine snapshot directory missing")
    count = 0
    for path in sorted(src.rglob("*.json")):
        relative = path.relative_to(src)
        # History snapshots are immutable; don't repeatedly copy large run archives.
        if relative.parts[0] == "history":
            continue
        target = dst / relative
        incoming = read(path)
        if incoming is None:
            raise SystemExit(f"Invalid engine JSON: {relative}")
        if isinstance(incoming, dict) and isinstance(incoming.get("matches"), list):
            incoming = merge(incoming, read(target))
        target.parent.mkdir(parents=True, exist_ok=True)
        output = json.dumps(incoming, ensure_ascii=False, indent=2) + "\n"
        if not target.exists() or target.read_text(encoding="utf-8") != output:
            target.write_text(output, encoding="utf-8")
            count += 1
    print(f"Updated {count} website JSON files")

if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
