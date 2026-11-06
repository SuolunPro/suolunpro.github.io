"""Independent, public-source football model. No legacy database access."""
import json
import math
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

BJT = timezone(timedelta(hours=8))
API = 'https://qiulaile.vip/api'
OFFICIAL = 'https://webapi.sporttery.cn/gateway/jc/football/getMatchCalculatorV1.qry?channel=c&poolCode=had,hhad,crs,ttg,hafu'
WEEK = '一二三四五六日'

def now():
    return datetime.now(timezone.utc)

def fetch(path, params=None):
    url = API + path + ('?' + urlencode(params) if params else '')
    with urlopen(Request(url, headers={'User-Agent':'Mozilla/5.0', 'Accept':'application/json'}), timeout=20) as response:
        if response.status != 200:
            raise ValueError(f'HTTP {response.status}')
        return json.load(response)

def official_pool(sale_day):
    request = Request(OFFICIAL, headers={'User-Agent':'Mozilla/5.0', 'Referer':'https://m.sporttery.cn/', 'Accept':'application/json'})
    with urlopen(request, timeout=20) as response:
        doc = json.load(response)
    groups = doc.get('value', {}).get('matchInfoList')
    if not isinstance(groups, list):
        raise ValueError('中国体彩网赛事接口格式不正确')
    found = {}
    for group in groups:
        for item in group.get('subMatchList', []):
            date = str(item.get('businessDate') or group.get('businessDate') or '')
            if not date:
                compact = str(item.get('matchNumDate') or group.get('matchNumDate') or '')
                date = f'20{compact[:2]}-{compact[2:4]}-{compact[4:6]}' if re.fullmatch(r'\d{6}', compact) else ''
            if date != sale_day:
                continue
            number = str(item.get('matchNumStr') or item.get('matchNum') or '').strip()
            match_id = str(item.get('matchId') or '')
            had, hhad = item.get('had') or {}, item.get('hhad') or {}
            def triple(raw):
                try:
                    vals = [float(raw[k]) for k in ('h','d','a')]
                    return vals if all(1 < x < 1000 for x in vals) else None
                except (KeyError, ValueError, TypeError):
                    return None
            if not match_id or not number or not item.get('homeTeamAllName') or not item.get('awayTeamAllName'):
                continue
            key = re.search(r'(\d{3})$', number)
            if not key:
                continue
            no = key.group(1)
            if no in found:
                raise ValueError(f'官方销售日编号重复：{no}')
            try:
                handicap = int(hhad.get('goalLineValue'))
            except (TypeError, ValueError):
                handicap = None
            kickoff = f"{item.get('matchDate') or ''} {item.get('matchTime') or ''}".strip()
            found[no] = {'match_no':no,'source_id':match_id,'league':item.get('leagueAllName'),
                'home':item.get('homeTeamAllName'),'away':item.get('awayTeamAllName'),
                'kickoff':kickoff,'spf':triple(had),'rqspf':triple(hhad),'handicap':handicap,
                'source_url':OFFICIAL,'data_quality':{'spf':bool(triple(had)),'rqspf':bool(triple(hhad))}}
    return found, len(groups)

def odds3(raw):
    if not isinstance(raw, str):
        return None
    values = [float(v) for v in re.findall(r'\d+(?:\.\d+)?', raw)]
    values = values[-3:]
    return values if len(values) == 3 and all(1 < x < 1000 for x in values) else None

def normalize_pool(items, sale_day):
    day = datetime.strptime(sale_day, '%Y-%m-%d').date()
    prefix = '周' + WEEK[day.weekday()]
    result = {}
    for item in items:
        if not isinstance(item, dict) or str(item.get('matchTypeValue')) != '0':
            continue
        label = str(item.get('displayNo') or '').strip()
        match = re.fullmatch(re.escape(prefix) + r'\s*(\d{3})', label)
        if not match or str(item.get('state', '')).lower() not in ('upcoming', 'selling', 'on_sale'):
            continue
        # dayLabel is the kickoff calendar day, not necessarily the lottery sale day.
        calendar = re.search(r'(\d{4})\s*-\s*(\d{1,2})\s*-\s*(\d{1,2})', str(item.get('dayLabel') or ''))
        if not calendar:
            continue
        kickoff_day = datetime.strptime('-'.join(calendar.groups()), '%Y-%m-%d').date()
        if kickoff_day not in (day, day + timedelta(days=1)):
            continue
        number = match.group(1)
        if number in result:
            raise ValueError(f'duplicate lottery number {number}')
        spf, rq = odds3(item.get('spfSp')), odds3(item.get('rqspfSp'))
        handicap = re.search(r'主\(([+-]?\d+)\)', str(item.get('rqspfSp') or ''))
        result[number] = {'match_no':number, 'source_id':item.get('id'), 'league':item.get('league'),
            'home':item.get('home'), 'away':item.get('away'), 'kickoff':f'{kickoff_day} {item.get("kickoff") or ""}'.strip(),
            'spf':spf, 'rqspf':rq, 'handicap':int(handicap.group(1)) if handicap else None,
            'source_url':API + '/matches?matchType=0&mode=full', 'data_quality':{'spf':bool(spf),'rqspf':bool(rq)}}
    return result

def normalize_probs(odds):
    if not odds:
        return None
    inv = [1 / x for x in odds]
    return [v / sum(inv) for v in inv]

def poisson(lam, k):
    return math.exp(-lam) * lam**k / math.factorial(k)

def model(match):
    probs = normalize_probs(match['spf'])
    if not probs:
        return {'status':'NO_PREDICTION', 'reason':'缺少真实赛前胜平负 SP'}
    # Market implied probabilities are a baseline, not independent team ratings.
    home, draw, away = probs
    strength = math.log(max(home, .03) / max(away, .03))
    total = 2.55
    lam_h = max(.35, min(3.5, total * math.exp(strength / 2) / (1 + math.exp(strength / 2))))
    lam_a = max(.35, min(3.5, total - lam_h))
    grid = [(h, a, poisson(lam_h,h)*poisson(lam_a,a)) for h in range(8) for a in range(8)]
    score = sorted(grid, key=lambda x:x[2], reverse=True)[:3]
    goals = sorted([(n, sum(p for h,a,p in grid if h+a==n)) for n in range(8)], key=lambda x:x[1], reverse=True)[:3]
    half = [(h,a,poisson(lam_h/2,h)*poisson(lam_a/2,a)) for h in range(5) for a in range(5)]
    ht = {'胜':sum(p for h,a,p in half if h>a),'平':sum(p for h,a,p in half if h==a),'负':sum(p for h,a,p in half if h<a)}
    ft = dict(zip(('胜','平','负'),probs))
    hft = sorted([(x+'-'+y,ht[x]*ft[y]) for x in ht for y in ft],key=lambda x:x[1],reverse=True)[:3]
    ranked = sorted(ft,key=ft.get,reverse=True)
    handicap = match.get('handicap')
    rq = normalize_probs(match.get('rqspf'))
    rq_ranked = sorted(zip(('让胜','让平','让负'),rq),key=lambda x:x[1],reverse=True) if rq and handicap is not None else []
    disagreement = bool(rq_ranked and ((ranked[0]=='胜' and rq_ranked[0][0]=='让负') or (ranked[0]=='负' and rq_ranked[0][0]=='让胜')))
    risk = '高' if disagreement or (ranked[0]!='平' and draw>=.31) else ('中' if draw>=.28 else '低')
    warning = risk=='高'
    value = ranked[0] if (not warning and ft[ranked[0]] >= .55 and match['spf'][('胜','平','负').index(ranked[0])] >= 1.5) else None
    return {'status':'PREDICTED','method':'赛前 SP 去水基线 + 固定总进球泊松近似；比分、半全场未经独立 xG 校准',
        'confidence':'低（缺少独立球队与盘口信息）', 'modules':{
            '胜平负':{'top1':ranked[0],'top2':ranked[:2], 'probabilities':{k:round(v,4) for k,v in ft.items()}},
            '让球':{'handicap':handicap,'top2':[k for k,_ in rq_ranked[:2]],'status':'有数据' if rq_ranked else '缺少让球 SP'},
            '比分':{'top3':[f'{h}:{a}' for h,a,_ in score]},
            '总进球':{'top3':[n for n,_ in goals]},
            '半全场':{'top3':[k for k,_ in hft]},
            '冷门预警':{'level':risk,'triggered':warning,'reason':'让球方向冲突或平局隐含概率偏高' if warning else '未触发简化风险阈值'},
            '今日优选':{'selection':value,'reason':'仅 SP 基线筛选，尚未得到机构及必发同向确认' if value else '未通过基线阈值或风险过滤'}},
        'coverage':{'independent_xg':False,'william':False,'macau_asia':False,'bifa':False}}

def run(sale_day=None, out='data/engine4/latest.json'):
    sale_day = sale_day or datetime.now(BJT).strftime('%Y-%m-%d')
    report = {'version':'4.0-prototype', 'sale_day':sale_day,'generated_at':now().isoformat(),
        'source':'中国体育彩票赛事及 SP 官方接口',
        'pool_verification':'OFFICIAL_SOURCE','status':'ERROR','matches':[],'errors':[], 'metrics':{'settled':0,'top1_hit_rate':None}}
    try:
        try:
            pool, source_total = official_pool(sale_day)
        except Exception as official_error:
            report['errors'].append('官方接口不可用：'+str(official_error))
            raw = fetch('/matches',{'matchType':0,'mode':'full'})
            items = raw.get('matches') if isinstance(raw,dict) else raw
            if not isinstance(items,list):
                raise ValueError('第三方赛事源格式不正确')
            pool, source_total = normalize_pool(items,sale_day),len(items)
            report['source'] = 'qiulaile.vip 第三方竞彩镜像；未获体彩官方全池确认'
            report['pool_verification'] = 'UNVERIFIED_MIRROR'
        report['source_total'] = source_total
        for number in sorted(pool):
            match = pool[number]
            try:
                kickoff = datetime.fromisoformat(match['kickoff'].replace(' ','T')).replace(tzinfo=BJT)
                if kickoff.astimezone(timezone.utc) <= now():
                    continue
            except ValueError:
                report['errors'].append(f'{number}: 开赛时间格式不正确')
                continue
            match['predicted_at'] = now().isoformat()
            match['prediction'] = model(match)
            report['matches'].append(match)
        report['status'] = ('OFFICIAL_POOL' if report['pool_verification']=='OFFICIAL_SOURCE' else 'MIRROR_CANDIDATES') if pool else 'NO_VERIFIED_MATCHES'
        if not pool:
            report['errors'].append('未找到符合销售日的真实候选场次；不能据此断言今日无赛事')
    except Exception as e:
        report['errors'].append(str(e))
    target = Path(out)
    target.parent.mkdir(parents=True,exist_ok=True)
    target.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'status':report['status'],'sale_day':sale_day,'candidates':len(report['matches']),
        'predicted':sum(x['prediction']['status']=='PREDICTED' for x in report['matches']), 'errors':report['errors']},ensure_ascii=False))
    return report

if __name__ == '__main__':
    run(os.getenv('POOL_DATE'),os.getenv('ENGINE_OUTPUT','data/engine4/latest.json'))
