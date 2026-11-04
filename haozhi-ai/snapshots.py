"""Immutable local pre-match snapshot writer. No database or network access."""
import hashlib
import json
from datetime import datetime
from pathlib import Path

def _time(value):
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        raise ValueError("timestamp requires timezone")
    return dt

def freeze(fixture, output_dir):
    """Write one unique immutable JSON snapshot; never overwrite or backfill."""
    required = ("fixture_id", "kickoff", "collected_at", "source")
    missing = [key for key in required if not fixture.get(key)]
    if missing:
        raise ValueError("missing provenance: " + ", ".join(missing))
    if _time(fixture["collected_at"]) >= _time(fixture["kickoff"]):
        raise ValueError("not a pre-kickoff snapshot")
    body = json.dumps(fixture, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(body.encode("utf-8")).hexdigest()
    folder = Path(output_dir)
    folder.mkdir(parents=True, exist_ok=True)
    # Hash-based filename avoids unsafe fixture IDs and collisions.
    path = folder / (digest + ".json")
    with path.open("x", encoding="utf-8") as stream:
        stream.write(body + "\n")
    return {"path": str(path), "sha256": digest}
