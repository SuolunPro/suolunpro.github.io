"""Verify regular-time scores against the prematch FotMob fixture identity."""
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode
from engine4.fotmob import TEAM_IDS, json_get, BASE

BJT = timezone(timedelta(hours=8))


def parse_time(value):
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def result_for(match, get=json_get, current=None):
    current = current or datetime.now(timezone.utc)
    evidence = match.get("fotmob_xg") or {}
    home = evidence.get("home_team_id") or TEAM_IDS.get(match.get("home"))
    away = evidence.get("away_team_id") or TEAM_IDS.get(match.get("away"))
    if not home or not away:
        return None, "TEAM_ID_UNCONFIRMED"
    try:
        kickoff = datetime.fromisoformat(match["kickoff"].replace(" ", "T")).replace(tzinfo=BJT).astimezone(timezone.utc)
    except (ValueError, KeyError):
        return None, "KICKOFF_INVALID"
    if current < kickoff + timedelta(minutes=120):
        return None, "NOT_DUE"

    fixture_id = evidence.get("match_id")
    if not fixture_id:
        candidates = {}
        for day in {kickoff.date(), (kickoff + timedelta(hours=12)).date(), (kickoff - timedelta(hours=12)).date()}:
            doc = get(BASE + "matches?" + urlencode({"date": day.strftime("%Y%m%d")}))
            for league in doc.get("leagues", []):
                for fixture in league.get("matches", []):
                    try:
                        if int(fixture["home"]["id"]) != int(home) or int(fixture["away"]["id"]) != int(away):
                            continue
                        if abs((parse_time(fixture["status"]["utcTime"]) - kickoff).total_seconds()) > 600:
                            continue
                        candidates[str(fixture["id"])] = fixture
                    except (KeyError, ValueError, TypeError):
                        continue
        if len(candidates) != 1:
            return None, "FIXTURE_NOT_UNIQUE"
        fixture_id = next(iter(candidates))

    details = get(BASE + "matchDetails?" + urlencode({"matchId": fixture_id}))
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
    if not status.get("finished") or status.get("cancelled") or status.get("awarded") or (status.get("reason") or {}).get("short") != "FT":
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
            "verified_at": current.isoformat(), "fotmob_match_id": int(fixture_id)}, None
