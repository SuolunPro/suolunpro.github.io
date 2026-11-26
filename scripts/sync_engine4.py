"""Merge engine snapshots into the website without reverting settled fixtures."""
import json
import sys
from pathlib import Path
from datetime import datetime, timedelta, timezone

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
    return (str(match.get("source_id") or ""), str(match.get("kickoff") or ""), str(match.get("home") or ""), str(match.get("away") or ""))

def reconcile_metrics(doc):
    """Count the merged public settlements, including Supabase-only results."""
    metrics = doc.get("metrics")
    if not isinstance(metrics, dict):
        return doc
    matches = doc.get("matches", [])
    metrics["total"] = len(matches)
    metrics["settled"] = sum(bool(m.get("settlement")) for m in matches)
    metrics["pending"] = len(matches) - metrics["settled"]
    for name in metrics.get("module_hits", {}):
        values = [m.get("settlement", {}).get("hits", {}).get(name)
                  for m in matches if isinstance(m.get("settlement"), dict)]
        values = [v for v in values if isinstance(v, bool)]
        hit, total = sum(values), len(values)
        metrics["module_hits"][name] = {"hit": hit, "total": total,
                                        "rate": round(hit / total, 4) if total else None}
    metrics["top1_hit_rate"] = metrics.get("module_hits", {}).get("胜平负Top1", {}).get("rate")
    for name, stat in metrics.get("module_stats", {}).items():
        statuses = [m["settlement"].get("module_results", {}).get(name, {}).get("status")
                    for m in matches if isinstance(m.get("settlement"), dict)]
        statuses = [s for s in statuses if s in ("HIT", "MISS")]
        hit, total = statuses.count("HIT"), len(statuses)
        stat["verified"] = total
        stat["pending"] = max(0, (stat.get("predicted") or 0) - total)
        stat["evaluation"] = {"hit": hit, "total": total,
                              "rate": round(hit / total, 4) if total else None}
        for suffix in stat.get("rates", {}):
            row = metrics.get("module_hits", {}).get(name + suffix)
            if row:
                stat["rates"][suffix] = row.copy()
    return doc

def merge(source, existing):
    if not isinstance(existing, dict):
        return source
    # Preserve the newest document metadata, but reconcile each fixture independently.
    # A sale-day generated_at can be stale even after an individual match settles.
    if stamp(existing.get("generated_at")) > stamp(source.get("generated_at")):
        base, other = existing, source
    else:
        base, other = source, existing
    # Legacy sales files may already contain duplicate versions of a fixture.
    # Reject conflicting verified results; prefer the latest valid prematch version.
    import copy
    base, other = copy.deepcopy(base), copy.deepcopy(other)
    def dedupe(doc):
        selected = {}
        for m in doc.get("matches", []):
            if not isinstance(m, dict):
                raise ValueError("Invalid fixture")
            k = key(m)
            if not k[0] or not k[1]:
                raise ValueError("Missing fixture identity")
            prev = selected.get(k)
            if prev is None:
                selected[k] = m
                continue
            if (m.get("result_verification") or {}).get("status") == "VERIFIED" and (prev.get("result_verification") or {}).get("status") == "VERIFIED" and m.get("settlement") != prev.get("settlement"):
                raise ValueError("Conflicting verified settlements")
            # Preserve verified settlement while choosing a pre-kickoff prediction.
            try:
                kickoff = datetime.fromisoformat(m["kickoff"].replace(" ", "T")).replace(tzinfo=timezone(timedelta(hours=8))).timestamp()
            except (KeyError, ValueError, TypeError):
                raise ValueError("Cannot verify kickoff for duplicate")
            def valid(x):
                t = stamp(x.get("predicted_at"))
                return bool(t and t < kickoff)
            if valid(m) and (not valid(prev) or stamp(m.get("predicted_at")) > stamp(prev.get("predicted_at"))):
                chosen, alternate = m, prev
            else:
                chosen, alternate = prev, m
            if (alternate.get("result_verification") or {}).get("status") == "VERIFIED" and (chosen.get("result_verification") or {}).get("status") != "VERIFIED":
                chosen["settlement"] = alternate.get("settlement")
                chosen["result_verification"] = alternate["result_verification"]
            selected[k] = chosen
        doc["matches"] = list(selected.values())
        return doc
    base, other = dedupe(base), dedupe(other)
    old_matches = {key(m): m for m in other.get("matches", []) if isinstance(m, dict)}
    for index, match in enumerate(base.get("matches", [])):
        old = old_matches.get(key(match))
        if not old:
            continue
        # For an unstarted fixture, keep the latest valid prematch forecast.
        # Never overwrite a frozen prediction with a post-kickoff version.
        try:
            kickoff = datetime.fromisoformat(match["kickoff"].replace(" ", "T")).replace(
                tzinfo=timezone(timedelta(hours=8))).timestamp()
        except (KeyError, ValueError, TypeError):
            kickoff = 0
        if kickoff and stamp(old.get("predicted_at")) < kickoff and (
            stamp(old.get("predicted_at")) > stamp(match.get("predicted_at"))):
            base["matches"][index] = old.copy()
            match = base["matches"][index]
        current_settlement = match.get("settlement")
        other_settlement = old.get("settlement")
        current_verified = bool(current_settlement) and (match.get("result_verification") or {}).get("status") == "VERIFIED"
        other_verified = bool(other_settlement) and (old.get("result_verification") or {}).get("status") == "VERIFIED"
        if current_verified and other_verified and any(
            current_settlement.get(field) != other_settlement.get(field)
            for field in ("ht", "ft", "fotmob_match_id")
        ):
            raise ValueError(f"Conflicting verified result for {key(match)}")
        # The engine snapshot is authoritative for recalculated module results.
        # A later verification timestamp on an older site copy is not a newer model.
        if other_verified and not current_verified:
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
    # Never publish a settled score with a contradictory PENDING verification.
    for match in base.get("matches", []):
        if match.get("settlement") and (match.get("result_verification") or {}).get("status") != "VERIFIED":
            match["result_verification"] = {
                "status": "VERIFIED",
                "checked_at": match["settlement"].get("verified_at"),
            }
    ids = [key(m) for m in base.get("matches", [])]
    if len(ids) != len(set(ids)):
        raise ValueError("Duplicate fixture after merge")
    if isinstance(base.get("metrics"), dict) and base["metrics"].get("total") is not None and base["metrics"]["total"] != len(ids):
        raise ValueError("Sales snapshot count mismatch")
    return reconcile_metrics(base)

def retain_verified_settlements(incoming, published):
    """Keep Supabase-verified website results when the private prediction snapshot is older.

    Only settlement fields are copied; frozen predictions remain authoritative
    from the engine. A verified score conflict stops publication.
    """
    if not isinstance(published, dict) or incoming.get("sale_day") != published.get("sale_day"):
        return incoming
    prior = {key(m): m for m in published.get("matches", []) if isinstance(m, dict)}
    for match in incoming.get("matches", []):
        old = prior.get(key(match))
        if not old or not old.get("settlement") or (old.get("result_verification") or {}).get("status") != "VERIFIED":
            continue
        existing = match.get("settlement")
        verified = old["settlement"]
        if existing:
            if any(existing.get(field) != verified.get(field) for field in ("ft", "ht", "fotmob_match_id")):
                raise ValueError("Conflicting verified result: " + str(key(match)))
            continue
        import copy
        match["settlement"] = copy.deepcopy(verified)
        match["result_verification"] = copy.deepcopy(old["result_verification"])
    return reconcile_metrics(incoming)


def public_snapshot(doc, existing, instant):
    """Freeze the published forecast while allowing verified settlements to advance."""
    if not isinstance(doc, dict) or not isinstance(doc.get("matches"), list):
        return
    previous = {key(m): m for m in (existing or {}).get("matches", [])}
    tz = timezone(timedelta(hours=8))
    def local(value):
        stamp = datetime.fromisoformat(str(value))
        return stamp if stamp.tzinfo else stamp.replace(tzinfo=tz)

    source_matches = __import__('copy').deepcopy(doc['matches'])
    for row in doc["matches"]:
        old = previous.get(key(row))
        if old and old.get("prediction"):
            try:
                date = local(row.get("sale_day") or doc.get("sale_day"))
                deadlines = [date.replace(hour=22 if date.weekday()<5 else 23,
                                          minute=0, second=0, microsecond=0),
                             local(row["kickoff"])]
                for item in (old, row):
                    for field in ("sale_end", "sale_end_at", "stop_sale_at"):
                        if item.get(field):
                            deadlines.append(local(item[field]))
                closed = instant >= min(deadlines)
            except (KeyError, TypeError, ValueError):
                closed = True
            if closed or any(item.get(flag) for item in (old,row)
                             for flag in ("frozen", "frozen_at", "settlement")):
                for field in ("prediction", "predicted_at", "single_pick"):
                    if field in old:
                        row[field] = old[field]
                    else:
                        row.pop(field,None)
        # Restore display-only prematch goal expectations from the *same*
        # frozen engine prediction. Never recalculate or replace its forecasts.
        # The prior public sync stripped these fields from dynamic-score modules.
        source_row = next((m for m in source_matches
                           if key(m) == key(row)), None)
        if source_row and row.get("predicted_at") == source_row.get("predicted_at"):
            frozen_modules = (row.get("prediction") or {}).get("modules") or {}
            source_modules = (source_row.get("prediction") or {}).get("modules") or {}
            for name in ("比分", "半全场", "总进球"):
                frozen_module = frozen_modules.get(name)
                source_module = source_modules.get(name)
                if not isinstance(frozen_module, dict) or not isinstance(source_module, dict):
                    continue
                # Verify unchanged forecast distribution and method before
                # recovering only fields previously removed by the publisher.
                if (frozen_module.get("method") != source_module.get("method")
                        or frozen_module.get("probabilities") != source_module.get("probabilities")
                        or frozen_module.get("top3") != source_module.get("top3")
                        or frozen_module.get("top4") != source_module.get("top4")):
                    continue
                for field in ("home_expected_goals", "away_expected_goals",
                              "estimated_total_goals"):
                    value = source_module.get(field)
                    if isinstance(value, (int, float)) and not isinstance(value, bool) and 0 < value < 30:
                        frozen_module.setdefault(field, value)
        prediction = row.get("prediction") or {}
        prediction.pop("dynamic_goals_audit", None)
        prediction.pop("william_dynamic_shadow", None)
        modules = prediction.get("modules") or {}
        for name in ("比分", "半全场", "总进球"):
            module = modules.get(name) or {}
            module.pop("william_calibration", None)
            module.pop("matrix_probability_mass", None)


def main(src, dst):
    if not src.is_dir():
        raise SystemExit("Engine snapshot directory missing")
    count = 0
    for path in sorted(src.rglob("*.json")):
        relative = path.relative_to(src)
        # History snapshots are immutable; don't repeatedly copy large run archives.
        if relative.parts[0] in ("history", "intelligence"):
            continue
        target = dst / relative
        incoming = read(path)
        if incoming is None:
            raise SystemExit(f"Invalid engine JSON: {relative}")
        if isinstance(incoming, dict) and isinstance(incoming.get("matches"), list):
            if relative.as_posix() == "latest.json":
                incoming = retain_verified_settlements(incoming, read(target))
            # latest.json may switch to a different sale day; never append prior-day fixtures.
            # Engine latest is authoritative; sale-day files retain their settlement merge.
            if relative.as_posix() != "latest.json":
                published = read(target)
                if isinstance(published, dict) and relative.parts[0] == "sales":
                    incoming_by_id = {
                        (str(m.get("source_id")), str(m.get("kickoff"))): m
                        for m in incoming.get("matches", []) if isinstance(m, dict)
                    }
                    promoted = {
                        str(m.get("match_no")) for m in incoming.get("matches", [])
                        if m.get("match_no") and m.get("predicted_at")
                        and (m.get("prediction") or {}).get("status") == "PREDICTED"
                    }
                    kept = []
                    for old_match in published.get("matches", []):
                        if (old_match.get("collection_status") == "PENDING_DATA"
                                and not old_match.get("predicted_at") and not old_match.get("settlement")
                                and not old_match.get("frozen") and not old_match.get("frozen_at")
                                and str(old_match.get("match_no")) in promoted):
                            continue
                        identity = (str(old_match.get("source_id")), str(old_match.get("kickoff")))
                        new_match = incoming_by_id.get(identity)
                        if new_match and key(old_match) != key(new_match):
                            if old_match.get("settlement") or (old_match.get("result_verification") or {}).get("status") == "VERIFIED":
                                raise ValueError("Verified fixture identity conflict: " + str(identity))
                            approved = (
                                relative.as_posix() == "sales/2026-11-17.json"
                                and identity == ("503109631", "2026-11-17 21:10")
                                and old_match.get("home") == new_match.get("home") == "日本"
                                and old_match.get("away") == "乌拉圭"
                                and new_match.get("away") == "巴拉圭"
                            )
                            if not approved:
                                raise ValueError("Unapproved fixture identity conflict: " + str(identity))
                            archive = dst / "identity_conflicts" / "2026-11-17_503109631_old.json"
                            archive.parent.mkdir(parents=True, exist_ok=True)
                            archived_payload = json.dumps(old_match, ensure_ascii=False, indent=2) + "\n"
                            if archive.exists() and archive.read_text(encoding="utf-8") != archived_payload:
                                raise ValueError("Identity conflict archive differs; refusing overwrite")
                            if not archive.exists():
                                archive.write_text(archived_payload, encoding="utf-8")
                            continue
                        kept.append(old_match)
                    published["matches"] = kept
                incoming = merge(incoming, published)
        public_snapshot(incoming, read(target), datetime.now(timezone.utc))
        target.parent.mkdir(parents=True, exist_ok=True)
        output = json.dumps(incoming, ensure_ascii=False, indent=2) + "\n"
        if not target.exists() or target.read_text(encoding="utf-8") != output:
            target.write_text(output, encoding="utf-8")
            count += 1
    # The public Supabase publisher may have settled a fixture in sales while
    # the private engine latest.json is still pending. Reconcile after sales sync.
    latest_path = dst / "latest.json"
    latest = read(latest_path)
    if isinstance(latest, dict) and latest.get("sale_day"):
        dated = read(dst / "sales" / (latest["sale_day"] + ".json"))
        before = json.dumps(latest, ensure_ascii=False, sort_keys=True)
        latest = retain_verified_settlements(latest, dated)
        if json.dumps(latest, ensure_ascii=False, sort_keys=True) != before:
            latest_path.write_text(json.dumps(latest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            count += 1
    # Keep date navigation aligned with all available sale-day reports, including empty days.
    sales = dst / "sales"
    days = sorted(p.stem for p in sales.glob("????-??-??.json") if p.is_file())
    index = sales / "index.json"
    payload = json.dumps({"days": days}, ensure_ascii=False, indent=2) + "\n"
    if not index.exists() or index.read_text(encoding="utf-8") != payload:
        index.write_text(payload, encoding="utf-8")
        count += 1
    print(f"Updated {count} website JSON files")

if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
