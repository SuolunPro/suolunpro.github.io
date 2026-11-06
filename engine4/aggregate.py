"""Keep the last valid prematch snapshot and publish each module with its own denominator."""
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from engine4.settle import settle, mark

ROOT = Path("data/engine4")
LATEST = ROOT / "latest.json"
SALES = ROOT / "sales"
BJT = timezone(timedelta(hours=8))


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def key(match):
    return str(match.get("source_id") or (match.get("match_no"), match.get("home"), match.get("away")))


def is_prematch(match):
    try:
        predicted = datetime.fromisoformat(match["predicted_at"].replace("Z", "+00:00"))
        kickoff = datetime.fromisoformat(match["kickoff"].replace(" ", "T")).replace(tzinfo=BJT)
        return predicted.tzinfo is not None and predicted < kickoff and (match.get("prediction") or {}).get("status") == "PREDICTED"
    except (KeyError, ValueError, TypeError):
        return False


def metrics(matches):
    settled = [m for m in matches if m.get("settlement")]
    keys = ("胜平负Top1", "胜平负Top2", "让球Top1", "让球Top2", "比分Top1", "比分Top3",
            "总进球Top1", "总进球Top3", "半全场Top1", "半全场Top3",
            "今日优选Top1", "今日优选Top2", "今日优选", "冷门预警")
    rows = {}
    for name in keys:
        values = [(m["settlement"].get("hits") or {}).get(name) for m in settled]
        eligible = [v for v in values if isinstance(v, bool)]
        hit = sum(eligible)
        rows[name] = {"hit": hit, "total": len(eligible),
                      "rate": round(hit / len(eligible), 4) if eligible else None}
    groups = {"胜平负": ("胜平负Top1", "胜平负Top2"),
              "让球": ("让球Top1", "让球Top2"),
              "比分": ("比分Top1", "比分Top3"),
              "总进球": ("总进球Top1", "总进球Top3"),
              "半全场": ("半全场Top1", "半全场Top3"),
              "今日优选": ("今日优选Top1", "今日优选Top2", "今日优选"),
              "冷门预警": ("冷门预警",)}
    module_stats = {}
    for name, names in groups.items():
        def has_selection(m):
            modules = (m.get("prediction") or {}).get("modules") or {}
            entry = modules.get(name) or {}
            if name == "今日优选":
                return entry.get("selection") is not None
            if name == "冷门预警":
                return entry.get("triggered") is True and entry.get("direction") in ("主队不胜", "主队不败")
            return (m.get("prediction") or {}).get("status") == "PREDICTED" and bool(entry.get("top2") or entry.get("top3"))
        predicted = sum(has_selection(m) for m in matches)
        verified = rows[names[-1]]["total"]
        module_stats[name] = {"predicted": predicted, "verified": verified,
                              "pending": max(0, predicted - verified),
                              "rates": {n.removeprefix(name): rows[n] for n in names}}
    return {"total": len(matches), "settled": len(settled), "pending": len(matches) - len(settled),
            "top1_hit_rate": rows["胜平负Top1"]["rate"], "module_hits": rows, "module_stats": module_stats}


def run(current=None):
    current = current or datetime.now(timezone.utc)
    SALES.mkdir(parents=True, exist_ok=True)
    reports = {}
    # Chronological history ensures an early prediction survives later pool refreshes.
    for path in sorted((ROOT / "history").glob("*.json")) + sorted(SALES.glob("*.json")) + ([LATEST] if LATEST.exists() else []):
        doc = read(path)
        day = doc.get("sale_day")
        if not day:
            continue
        target = reports.setdefault(day, {"sale_day": day, "version": doc.get("version", "4.0"), "matches": []})
        by_id = {key(m): m for m in target["matches"]}
        for match in doc.get("matches", []):
            identity = key(match)
            previous = by_id.get(identity)
            if previous is None:
                if is_prematch(match):
                    target["matches"].append(match)
                    by_id[identity] = match
            elif is_prematch(match) and match["predicted_at"] > previous["predicted_at"]:
                # Select the last valid snapshot before kickoff. Re-evaluate any already
                # verified result against that snapshot without fetching or changing scores.
                settled = previous.get("settlement") or match.get("settlement")
                if settled:
                    at = datetime.fromisoformat(settled["verified_at"].replace("Z", "+00:00"))
                    match["settlement"] = mark(match, settled, at)
                index = target["matches"].index(previous)
                target["matches"][index] = match
                by_id[identity] = match
            elif match.get("settlement") and not previous.get("settlement"):
                previous["settlement"] = mark(previous, match["settlement"],
                    datetime.fromisoformat(match["settlement"]["verified_at"].replace("Z", "+00:00")))
        if path == LATEST:
            target.update({k: v for k, v in doc.items() if k not in ("matches", "metrics", "historical_metrics")})
    for day, doc in sorted(reports.items()):
        # Migrate already verified rows to per-module results from the same immutable
        # score and snapshot. This performs no result lookup or prediction change.
        for match in doc["matches"]:
            existing = match.get("settlement")
            if existing and not existing.get("module_results"):
                at = datetime.fromisoformat(existing["verified_at"].replace("Z", "+00:00"))
                match["settlement"] = mark(match, existing, at) or existing
        path = SALES / (day + ".json")
        write(path, doc)
        if (current.astimezone(BJT).date() - datetime.strptime(day, "%Y-%m-%d").date()).days <= 2:
            settled_doc = settle(path, current=current)
            if settled_doc:
                reports[day] = settled_doc
        reports[day]["metrics"] = metrics(reports[day]["matches"])
        write(path, reports[day])
    today = current.astimezone(BJT).date().isoformat()
    # A sale-day report remains visible after midnight until the next sale day has fixtures.
    visible_day = today if reports.get(today, {}).get("matches") else max(reports, default=today)
    latest = reports.get(visible_day, {"sale_day": visible_day, "matches": []})
    all_matches = [m for doc in reports.values() for m in doc["matches"]]
    latest["metrics"] = metrics(latest["matches"])
    latest["historical_metrics"] = metrics(all_matches)
    latest["generated_at"] = current.isoformat()
    write(LATEST, latest)
    print(json.dumps({"sale_day": visible_day, "today": latest["metrics"], "historical": latest["historical_metrics"]}, ensure_ascii=False))
    return latest


if __name__ == "__main__":
    run()
