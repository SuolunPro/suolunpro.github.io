"""Verify regular-time scores against the prematch FotMob fixture identity."""
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode
from engine4.fotmob import TEAM_IDS, team_name_matches, json_get, BASE

BJT = timezone(timedelta(hours=8))


def parse_time(value):
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def result_for(match, get=json_get, current=None):
    current = current or datetime.now(timezone.utc)
    evidence = match.get("fotmob_xg") or {}
    home = evidence.get("home_team_id") or match.get("fotmob_home_team_id") or TEAM_IDS.get(match.get("home"))
    away = evidence.get("away_team_id") or match.get("fotmob_away_team_id") or TEAM_IDS.get(match.get("away"))
    try:
        kickoff = datetime.fromisoformat(match["kickoff"].replace(" ", "T")).replace(tzinfo=BJT).astimezone(timezone.utc)
    except (ValueError, KeyError):
        return None, "KICKOFF_INVALID"
    if current < kickoff + timedelta(minutes=120):
        return None, "NOT_DUE"

    fixture_id = evidence.get("match_id") or match.get("fotmob_match_id")
    # Existing identity is accepted only after matchDetails checks the match ID,
    # both teams and kickoff. An unknown translation must match an explicit
    # bilingual alias; a coincident kickoff can never establish identity.
    if not (fixture_id and home and away):
        candidates = {}
        source_errors = []
        dates = {kickoff.date(), (kickoff + timedelta(days=1)).date(),
                 (kickoff - timedelta(days=1)).date()}
        for day in sorted(dates):
            try:
                doc = get(BASE + "matches?" + urlencode({"date": day.strftime("%Y%m%d")}))
            except Exception as exc:
                source_errors.append(str(exc)[:120])
                continue
            for league in doc.get("leagues", []):
                for fixture in league.get("matches", []):
                    try:
                        h, a = fixture["home"], fixture["away"]
                        if home and int(h["id"]) != int(home):
                            continue
                        if away and int(a["id"]) != int(away):
                            continue
                        if not home and not team_name_matches(match.get("home"), h.get("name")):
                            continue
                        if not away and not team_name_matches(match.get("away"), a.get("name")):
                            continue
                        if abs((parse_time(fixture["status"]["utcTime"]) - kickoff).total_seconds()) > 600:
                            continue
                        candidates[str(fixture["id"])] = (int(h["id"]), int(a["id"]))
                    except (KeyError, ValueError, TypeError):
                        continue
        if len(candidates) != 1 and (home or away):
            # Legacy self-heal: the home team's season fixtures can include
            # matches absent from FotMob's date index.
            try:
                team_id = home or away
                doc = get(BASE + "teams?" + urlencode({"id": team_id}))
                fixtures = ((doc.get("fixtures") or {}).get("allFixtures") or {}).get("fixtures") or []
                for fixture in fixtures:
                    try:
                        h, a = fixture["home"], fixture["away"]
                        if home and int(h["id"]) != int(home):
                            continue
                        if away and int(a["id"]) != int(away):
                            continue
                        if not home and not team_name_matches(match.get("home"), h.get("name")):
                            continue
                        if not away and not team_name_matches(match.get("away"), a.get("name")):
                            continue
                        if abs((parse_time(fixture["status"]["utcTime"]) - kickoff).total_seconds()) > 600:
                            continue
                        candidates[str(fixture["id"])] = (int(h["id"]), int(a["id"]))
                    except (KeyError, ValueError, TypeError):
                        continue
            except Exception as exc:
                source_errors.append(str(exc)[:120])
        if len(candidates) != 1:
            if source_errors and not candidates:
                return None, "FOTMOB_FIXTURE_FETCH_FAILED: " + source_errors[0]
            return None, ("FIXTURE_AMBIGUOUS" if len(candidates) > 1 else
                          "TEAM_ID_UNCONFIRMED: " + str(match.get("home")) + " / " + str(match.get("away")))
        fixture_id, (home, away) = next(iter(candidates.items()))

    try:
        details = get(BASE + "matchDetails?" + urlencode({"matchId": fixture_id}))
    except Exception as exc:
        return None, "FOTMOB_DETAILS_FETCH_FAILED: " + str(exc)[:120]
    general = details.get("general") or {}
    header = details.get("header") or {}
    status = header.get("status") or {}
    teams = header.get("teams") or []
    if str(general.get("matchId")) != str(fixture_id):
        return None, "DETAILS_IDENTITY_MISMATCH"
    if int((general.get("homeTeam") or {}).get("id") or 0) != int(home) or int((general.get("awayTeam") or {}).get("id") or 0) != int(away):
        return None, "DETAILS_TEAM_MISMATCH"
    try:
        if abs((parse_time(general["matchTimeUTCDate"]) - kickoff).total_seconds()) > 600:
            return None, "DETAILS_KICKOFF_MISMATCH"
    except (KeyError, ValueError):
        return None, "DETAILS_KICKOFF_MISSING"
    if not status.get("finished") or status.get("cancelled") or status.get("awarded") or (status.get("reason") or {}).get("short") != "FT" or re.search(r"extra time|penalt", str((status.get("reason") or {}).get("long") or ""), re.I):
        return None, "NOT_REGULAR_FT"
    if len(teams) != 2 or int(teams[0].get("id") or 0) != int(home) or int(teams[1].get("id") or 0) != int(away):
        return None, "HEADER_TEAM_MISMATCH"
    full = re.fullmatch(r"\s*(\d+)\s*[-:]\s*(\d+)\s*", str(status.get("scoreStr") or ""))
    if not full:
        return None, "FT_SCORE_MISSING"
    ft = tuple(map(int, full.groups()))
    try:
        if ft != (int(teams[0]["score"]), int(teams[1]["score"])):
            return None, "FT_SCORE_CONFLICT"
    except (KeyError, TypeError, ValueError):
        return None, "HEADER_SCORE_MISSING"
    events = (((details.get("content") or {}).get("matchFacts") or {}).get("events") or {}).get("events") or []
    halves = [e for e in events if e.get("type") == "Half" and e.get("halfStrShort") == "HT"]
    if len(halves) != 1:
        return None, "HT_SCORE_NOT_UNIQUE"
    try:
        ht = (int(halves[0]["homeScore"]), int(halves[0]["awayScore"]))
    except (KeyError, TypeError, ValueError):
        return None, "HT_SCORE_INVALID"
    if any(h < 0 or h > f for h, f in zip(ht, ft)):
        return None, "HT_FT_CONFLICT"
    return {"ht": f"{ht[0]}:{ht[1]}", "ft": f"{ft[0]}:{ft[1]}",
            "source_url": BASE + "matchDetails?matchId=" + str(fixture_id),
            "verified_at": current.isoformat(), "fotmob_match_id": int(fixture_id),
            "fotmob_home_team_id": int(home), "fotmob_away_team_id": int(away)}, None
