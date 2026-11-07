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
    # Never replace a newer website snapshot with an older engine snapshot.
    if stamp(existing.get("generated_at")) > stamp(source.get("generated_at")):
        base, other = existing, source
    else:
        base, other = source, existing
    old_matches = {key(m): m for m in other.get("matches", []) if isinstance(m, dict)}
    for match in base.get("matches", []):
        old = old_matches.get(key(match))
        if not old:
            continue
        # A completed, verified settlement is immutable against PENDING rollbacks.
        for field in ("settlement", "result_verification"):
            if old.get("settlement") and old.get("result_verification", {}).get("status") == "VERIFIED":
                if field == "settlement" and not match.get("settlement"):
                    match[field] = old[field]
                elif field == "result_verification" and match.get(field, {}).get("status") != "VERIFIED":
                    match[field] = old[field]
        # Also protect verified settlement present in the non-base source.
        if old.get("settlement") and old.get("result_verification", {}).get("status") == "VERIFIED" and match.get("result_verification", {}).get("status") != "VERIFIED":
            match["settlement"] = old["settlement"]
            match["result_verification"] = old["result_verification"]
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
