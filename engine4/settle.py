"""Settle immutable pre-match snapshots against official half/full-time results."""
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

BJT = timezone(timedelta(hours=8))
SOURCE = 'https://webapi.sporttery.cn/gateway/jc/football/getMatchResultV1.qry'

def score(raw):
    match = re.fullmatch(r'(\d+)[:\-](\d+)', str(raw or ''))
    return tuple(map(int, match.groups())) if match else None

def result_rows(day):
    query = {'matchPage':1,'matchBeginDate':day,'matchEndDate':day,'leagueId':'','pageSize':200,'pageNo':1,'isFix':0,'pcOrWap':1}
    url = SOURCE + '?' + urlencode(query)
    with urlopen(Request(url,headers={'User-Agent':'Mozilla/5.0','Referer':'https://www.sporttery.cn/'}),timeout=20) as response:
        body = json.load(response)
    rows = body.get('value',{}).get('matchResult')
    if not isinstance(rows,list):
        raise ValueError('官方赛果格式不正确')
    return {str(row.get('matchId')):row for row in rows},url

def mark(match, row, url, timestamp):
    if str(row.get('matchResultStatus')) != '2' or str(row.get('poolStatus','')).lower() != 'payout':
        return None
    if row.get('allHomeTeam') != match['home'] or row.get('allAwayTeam') != match['away']:
        return None
    ht, ft = score(row.get('sectionsNo1')),score(row.get('sectionsNo999'))
    if not ht or not ft:
        return None
    try:
        kickoff = datetime.fromisoformat(match['kickoff'].replace(' ','T')).replace(tzinfo=BJT)
        if timestamp < kickoff.astimezone(timezone.utc) + timedelta(minutes=120):
            return None
        predicted = datetime.fromisoformat(match['predicted_at'])
        if predicted >= kickoff.astimezone(timezone.utc):
            return None
    except (ValueError,KeyError):
        return None
    p = match.get('prediction',{})
    if p.get('status') != 'PREDICTED':
        return None
    def outcome(a,b):
        return '胜' if a>b else '平' if a==b else '负'
    ht_label,ft_label = outcome(*ht),outcome(*ft)
    m = p['modules']
    handicap = match.get('handicap')
    rq_out = outcome(ft[0]+handicap,ft[1]) if handicap is not None else None
    hits = {'胜平负Top1':m['胜平负']['top1']==ft_label,
        '胜平负Top2':ft_label in m['胜平负']['top2'],
        '比分Top3':f'{ft[0]}:{ft[1]}' in m['比分']['top3'],
        '总进球Top3':ft[0]+ft[1] in m['总进球']['top3'],
        '半全场Top3':ht_label+'-'+ft_label in m['半全场']['top3'],
        '让球Top2':('让'+rq_out) in m['让球']['top2'] if rq_out else None,
        '今日优选':m['今日优选']['selection']==ft_label if m['今日优选']['selection'] else None}
    return {'ht':f'{ht[0]}:{ht[1]}','ft':f'{ft[0]}:{ft[1]}','verified_at':timestamp.isoformat(),
        'source_url':url,'hits':hits}

def settle(path, current=None):
    current = current or datetime.now(timezone.utc)
    path = Path(path)
    if not path.exists():
        return None
    report = json.loads(path.read_text(encoding='utf-8'))
    cache = {}
    for match in report.get('matches',[]):
        if match.get('settlement') or not match.get('source_id'):
            continue
        day = report['sale_day']
        if day not in cache:
            try:
                cache[day] = result_rows(day)
            except Exception as error:
                print(json.dumps({'sale_day':day,'result_source_error':str(error),'action':'keep_pending'}))
                break
        row,url = cache[day][0].get(str(match['source_id'])),cache[day][1]
        if row:
            match['settlement'] = mark(match,row,url,current)
    settled = [m for m in report.get('matches',[]) if m.get('settlement')]
    hits = [m['settlement']['hits']['胜平负Top1'] for m in settled]
    report['metrics'] = {'settled':len(settled),'top1_hit_rate':round(sum(hits)/len(hits),4) if hits else None,
        'module_hits':{key:{'hit':sum(m['settlement']['hits'][key] is True for m in settled),
            'total':sum(m['settlement']['hits'][key] is not None for m in settled)} for key in (settled[0]['settlement']['hits'] if settled else [])}}
    path.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'sale_day':report['sale_day'],'settled':len(settled),'top1_hit_rate':report['metrics']['top1_hit_rate']}))
    return report

if __name__=='__main__':
    import sys
    for filename in sys.argv[1:]:
        settle(filename)
