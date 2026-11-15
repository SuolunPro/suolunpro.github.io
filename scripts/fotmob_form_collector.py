"""Collect verified pre-match FotMob form independently of the prediction model."""
import json
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from time import sleep

BJT = timezone(timedelta(hours=8))
BASE = 'https://www.fotmob.com/api/data/'


def fetch(path, **params):
    url = BASE + path + '?' + urlencode(params)
    last = None
    for attempt in range(3):
        try:
            with urlopen(Request(url, headers={'User-Agent': 'Mozilla/5.0',
                                               'Accept': 'application/json'}), timeout=15) as response:
                raw = response.read(2500001)
                if response.status != 200 or len(raw) > 2500000:
                    raise ValueError('FotMob response rejected')
                return json.loads(raw)
        except (OSError, ValueError) as exc:
            last = exc
            if attempt < 2:
                sleep(1 + attempt)
    raise last


def score(fixture):
    result = fixture.get('status', {}).get('scoreStr') or fixture.get('scoreStr')
    if isinstance(result, str):
        parts = result.replace(' ', '').split('-')
        if len(parts) == 2 and all(p.isdigit() for p in parts):
            return int(parts[0]), int(parts[1])
    return None


def collect_match(match, now, get=fetch):
    base = {key: match.get(key) for key in ('match_no', 'source_id', 'home', 'away', 'kickoff')}
    base.update(status='failed', source='FotMob', collected_at=now.isoformat(),
                sources=[], missing=['recent_form', 'home_away', 'injuries', 'lineup', 'motivation'])
    try:
        kickoff = datetime.fromisoformat(match['kickoff'].replace(' ', 'T')).replace(tzinfo=BJT).astimezone(timezone.utc)
        if now >= kickoff:
            base['reason'] = 'kickoff passed; frozen, no new pre-match evidence'
            return base
        ids = (match.get('fotmob_home_team_id'), match.get('fotmob_away_team_id'))
        if not all(ids) or not match.get('fotmob_match_id'):
            base['reason'] = 'verified FotMob identity unavailable'
            return base
        details = get('matchDetails', matchId=match['fotmob_match_id'])
        general = details['general']
        stamp = datetime.fromisoformat(general['matchTimeUTCDate'].replace('Z', '+00:00'))
        if (str(general['matchId']) != str(match['fotmob_match_id']) or
                tuple(int(general[k]['id']) for k in ('homeTeam', 'awayTeam')) != tuple(map(int, ids)) or
                abs((stamp - kickoff).total_seconds()) > 600 or general.get('started') or general.get('finished')):
            base['reason'] = 'fixture identity or pre-match state mismatch'
            return base
        evidence = {}
        for side, team_id in zip(('home', 'away'), ids):
            team = get('teams', id=team_id)
            fixtures = team.get('fixtures', {}).get('allFixtures', {}).get('fixtures', [])
            rows = []
            for fixture in fixtures:
                try:
                    status = fixture['status']
                    when = datetime.fromisoformat(status['utcTime'].replace('Z', '+00:00'))
                    home, away = int(fixture['home']['id']), int(fixture['away']['id'])
                    result = score(fixture)
                    if (int(team_id) not in (home, away) or not status.get('finished') or
                            status.get('cancelled') or result is None or
                            when >= kickoff or when + timedelta(minutes=90) >= now):
                        continue
                    gf, ga = result if int(team_id) == home else result[::-1]
                    rows.append({'match_id': fixture['id'], 'utc_time': when.isoformat(),
                                 'venue': 'home' if int(team_id) == home else 'away',
                                 'goals_for': gf, 'goals_against': ga,
                                 'result': 'W' if gf > ga else 'D' if gf == ga else 'L'})
                except (KeyError, TypeError, ValueError):
                    continue
            rows.sort(key=lambda row: row['utc_time'], reverse=True)
            venue = 'home' if side == 'home' else 'away'
            evidence[side] = {'team_id': team_id, 'recent_five': rows[:5],
                              'venue_five': [row for row in rows if row['venue'] == venue][:5]}
            base['sources'].append({'url': f'https://www.fotmob.com/api/data/teams?id={team_id}',
                                    'captured_at': now.isoformat()})
        base['form'] = evidence
        base['sources'].append({'url': f'https://www.fotmob.com/api/data/matchDetails?matchId={match["fotmob_match_id"]}',
                                'captured_at': now.isoformat()})
        base['status'] = 'partial' if min(len(evidence[s]['recent_five']) for s in evidence) < 5 else 'collected'
        if base['status'] == 'collected':
            base['missing'].remove('recent_form')
        if min(len(evidence[s]['venue_five']) for s in evidence) >= 5:
            base['missing'].remove('home_away')
        return base
    except (KeyError, TypeError, ValueError, OSError) as exc:
        base['reason'] = str(exc)[:180]
        return base


def main():
    path = Path(sys.argv[1])
    doc = json.loads(path.read_text(encoding='utf-8'))
    now = datetime.now(timezone.utc)
    day = doc['sale_day']
    output = Path('data/engine4/intelligence') / (day + '.json')
    prior = json.loads(output.read_text()) if output.exists() else {}
    saved = {m['source_id']: m for m in prior.get('matches', []) if m.get('source_id')}
    results = []
    for match in doc['matches']:
        key = match.get('source_id')
        old = saved.get(key)
        kickoff = datetime.fromisoformat(match['kickoff'].replace(' ', 'T')).replace(tzinfo=BJT).astimezone(timezone.utc)
        if now >= kickoff and old:
            results.append(old)
        else:
            results.append(collect_match(match, now))
    if len({(m['match_no'], m['source_id']) for m in results}) != len(doc['matches']):
        raise ValueError('fixture identity collision; refusing to publish')
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({'sale_day': day, 'generated_at': now.isoformat(),
                                  'engine_generated_at': doc.get('generated_at'),
                                  'source': 'FotMob verified prematch form',
                                  'matches': results}, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'sale_day': day, 'total': len(results),
                      'collected': sum(m['status'] == 'collected' for m in results),
                      'partial': sum(m['status'] == 'partial' for m in results),
                      'failed': sum(m['status'] == 'failed' for m in results)}))


if __name__ == '__main__':
    main()
