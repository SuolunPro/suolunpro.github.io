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

def fetch_market(match, errors):
    """Capture source evidence before kickoff; never treat a failed request as a zero signal."""
    market = {'source':'qiulaile.vip/match/odds', 'captured_at':now().isoformat(),
              'william':None, 'asia':{}}
    params = {'matchId':match['source_id'],'home':match['home'],'away':match['away']}
    for name, kind in [('william',0),('asia',1)]:
        try:
            doc = fetch('/match/odds',dict(params,matchType=kind))
            lines = doc.get('lines',[]) if isinstance(doc,dict) else []
            if not isinstance(lines,list):
                raise ValueError('missing odds lines')
            for line in lines:
                company = str(line.get('company') or '').strip()
                if name=='william' and company=='威廉希尔' and line.get('market')=='欧赔':
                    market['william']={'initial':line.get('initial'),'current':line.get('primary'),
                                       'time':line.get('time')}
                if name=='asia' and company in ('澳门','威廉希尔','Bet365','皇冠') and line.get('market')=='亚赔':
                    market['asia'][company]={'initial':line.get('initial'),'current':line.get('primary'),
                                             'time':line.get('time')}
        except Exception as error:
            errors.append({'match_no':match['match_no'],'market':name,'error':str(error)})
    return market

def poisson(lam, k):
    return math.exp(-lam) * lam**k / math.factorial(k)

def asian_snapshot(raw):
    match = re.fullmatch(r'\s*(\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?(?:/\d+(?:\.\d+)?)?)\s+(\d+(?:\.\d+)?)\s*',str(raw or ''))
    if not match:
        return None
    home_water, line, away_water = match.groups()
    neg = line.startswith('-')
    numbers = [float(v) for v in line.lstrip('-').split('/')]
    magnitude = sum(numbers)/len(numbers)
    # Mirror displays the home giving 0.5 as "0.5"; map to home handicap -0.5.
    return {'line':round(magnitude if neg else -magnitude,3),
            'home_water':float(home_water),'away_water':float(away_water)}

def cold_warning(match, top, ft):
    """Old ABCDE gates, evaluated only where the corresponding pre-match evidence exists."""
    market = match.get('market') or {}
    william = market.get('william') or {}
    initial, current = odds3(william.get('initial')), odds3(william.get('current'))
    fi, fc = normalize_probs(initial), normalize_probs(current)
    sp = normalize_probs(match.get('spf'))
    direction = '主队不胜' if top=='胜' else '主队不败' if top=='负' else None
    idx = 0 if top=='胜' else 2 if top=='负' else None
    asian = []
    if idx is not None:
        for company, quote in (market.get('asia') or {}).items():
            first, last = asian_snapshot(quote.get('initial')),asian_snapshot(quote.get('current'))
            if not first or not last:
                continue
            retreat = last['line']-first['line'] if idx==0 else first['line']-last['line']
            high_water = last['home_water'] if idx==0 else last['away_water']
            asian.append({'company':company,'retreat':round(retreat,3),'water':high_water,
                          'initial':quote.get('initial'),'current':quote.get('current')})
    price_rise = idx is not None and bool(initial and current and current[idx]>initial[idx])
    deep_high_water = [a for a in asian if a['retreat']>=.249999 and a['water']>=1]
    channels=[]
    evidence=[]
    if price_rise and len(deep_high_water)>=2:
        channels.append('D')
        evidence.append('威廉主方向升赔；'+ '、'.join(a['company'] for a in deep_high_water)+'盘口退让至少0.25球且主方向水位≥1')
    if sp and fi and fc and sp[1]>=.28 and (fc[1]-fi[1])*100>=1:
        channels.append('E2')
        evidence.append(f'竞彩平局隐含比例{sp[1]*100:.1f}%；威廉平局公平比例上升{(fc[1]-fi[1])*100:.1f}个百分点')
    watch=[]
    if sp and sp[1]>=.30 and match.get('handicap')==-1:
        watch.append(f'高平风险观察：平局隐含比例{sp[1]*100:.1f}%且官方让球-1')
    retreats=[a for a in asian if a['retreat']>=.249999]
    if price_rise and fi and fc and (fi[idx]-fc[idx])*100>=3 and len(retreats)>=2:
        watch.append('市场异动观察：威廉主方向公平比例下降'+f'{(fi[idx]-fc[idx])*100:.1f}个百分点，'+
                     '、'.join(a['company'] for a in retreats)+'盘口退让；未达到D通道高水位条件')
    triggered=bool(channels and direction)
    status='TRIGGERED' if triggered else 'WATCH' if watch else 'NOT_TRIGGERED'
    return {'status':status,'level':'高' if triggered else '关注' if watch else '未触发',
            'triggered':triggered,'direction':direction if triggered else None,
            'watch_direction':direction if watch and not triggered else None,'channels':channels,
            'evidence':evidence,'watch':watch,
            'missing':['必发资金方向（A/B/C未评估）','严格赛前独立比分（E1未评估）']+
                      ([] if fi and fc else ['威廉初盘与即时盘（D/E2未评估）'])+
                      ([] if asian else ['亚洲盘口（D未评估）']),
            'checked':['D','E2'] if fi and fc and asian else ['E2'] if fi and fc else [],
            'model':'SOREN_ABCDE_EVIDENCE_V1'}

def daily_pick(match, top, ft, cold):
    """Legacy-style risk gates; independent model/Bifa absence forbids formal publication."""
    reasons=[]
    if top not in ('胜','负'):
        reasons.append('胜平负 Top1 为平局')
    if ft[top] < .55:
        reasons.append(f'Top1 SP 隐含比例 {ft[top]*100:.1f}% < 55%')
    if cold['status'] in ('TRIGGERED','WATCH'):
        reasons.append('冷门预警或市场异动观察已排除')
    if match.get('handicap')==-1 and ft['平']>=.29:
        reasons.append('官方让球 -1 且高平风险')
    william=(match.get('market') or {}).get('william') or {}
    odds=odds3(william.get('current'))
    wp=normalize_probs(odds)
    idx={'胜':0,'平':1,'负':2}[top]
    if not wp:
        reasons.append('威廉即时欧赔缺失')
    elif wp[idx] < max(wp):
        reasons.append('威廉欧赔主方向与 SP Top1 不一致')
    asia=(match.get('market') or {}).get('asia') or {}
    valid=[]
    retreat=[]
    for company, quote in asia.items():
        current=asian_snapshot(quote.get('current'))
        initial=asian_snapshot(quote.get('initial'))
        if not current:
            continue
        valid.append(company)
        if initial and ((top=='胜' and current['line']-initial['line']>=.249999) or
                        (top=='负' and initial['line']-current['line']>=.249999)):
            retreat.append(company)
    if len(valid)<2:
        reasons.append('可读亚洲盘口不足两家')
    if len(retreat)>=2:
        reasons.append('两家以上亚洲盘口对 Top1 退让：'+'、'.join(retreat))
    if odds and not 1.45 <= odds[idx] <= 1.75:
        reasons.append(f'威廉方向赔率 {odds[idx]:.2f} 不在原版补充档 1.45–1.75')
    evidence=[f'SP Top1 {top} 去水隐含比例 {ft[top]*100:.1f}%']
    if odds:
        evidence.append(f'威廉同方向赔率 {odds[idx]:.2f}' if wp[idx]==max(wp) else '威廉方向不一致')
    evidence.append(f'亚洲盘口可读 {len(valid)} 家，退让 {len(retreat)} 家')
    # The old CORE/SUPPLEMENT selector also requires a verified independent
    # model class, selection mode, risk lock, and Bifa funding alignment.
    if reasons:
        return {'status':'BLOCKED','selection':None,'candidate':None,'reason':'；'.join(reasons),
                'evidence':evidence,'missing':['独立赛前模型 A 档/SINGLE/HUR','必发资金方向与份额'],
                'model':'DAILY_VALUE_EVIDENCE_V1'}
    return {'status':'CANDIDATE','selection':None,'candidate':top,
            'reason':'市场候选，等待独立模型与必发同向核验；不计入正式今日优选',
            'evidence':evidence,'missing':['独立赛前模型 A 档/SINGLE/HUR','必发资金方向与份额'],
            'model':'DAILY_VALUE_EVIDENCE_V1'}

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
    cold = cold_warning(match,ranked[0],ft)
    daily = daily_pick(match, ranked[0], ft, cold)
    rq_top2 = [k for k,_ in rq_ranked[:2]]
    if set(rq_top2) == {'让胜','让负'}:
        rq_top2 = [rq_top2[0], '让平']
    return {'status':'PREDICTED','method':'赛前 SP 去水基线 + 固定总进球泊松近似；比分、半全场未经独立 xG 校准',
        'confidence':'低（缺少必发与独立球队、xG信号）', 'modules':{
            '胜平负':{'top1':ranked[0],'top2':ranked[:2], 'probabilities':{k:round(v,4) for k,v in ft.items()}},
            '让球':{'handicap':handicap,'top2':rq_top2,'status':'有数据' if rq_ranked else '缺少让球 SP',
                'probabilities':{k:round(v,4) for k,v in zip(('让胜','让平','让负'),rq)} if rq else {}},
            '比分':{'top3':[f'{h}:{a}' for h,a,_ in score],
                'probabilities':{f'{h}:{a}':round(v,4) for h,a,v in score}},
            '总进球':{'top3':[n for n,_ in goals],
                'probabilities':{str(n):round(v,4) for n,v in goals}},
            '半全场':{'top3':[k for k,_ in hft],
                'probabilities':{k:round(v,4) for k,v in hft}},
            '冷门预警':cold,
            '今日优选':daily},
        'coverage':{'independent_xg':False,
                    'william':bool((match.get('market') or {}).get('william')),
                    'macau_asia':bool((match.get('market') or {}).get('asia',{}).get('澳门')),
                    'bifa':False}}

def prior_cold_locks(sale_day):
    locked={}
    for path in sorted(Path('data/engine4/history').glob('*.json')):
        try:
            historical=json.loads(path.read_text(encoding='utf-8'))
            if historical.get('sale_day')!=sale_day:
                continue
            for old in historical.get('matches',[]):
                cold=(old.get('prediction') or {}).get('modules',{}).get('冷门预警') or {}
                if cold.get('model')=='SOREN_ABCDE_EVIDENCE_V1' and cold.get('triggered'):
                    locked[str(old.get('source_id'))]=cold
        except (ValueError,OSError,KeyError):
            continue
    return locked

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
        locks=prior_cold_locks(sale_day)
        for number in sorted(pool):
            match = pool[number]
            try:
                kickoff = datetime.fromisoformat(match['kickoff'].replace(' ','T')).replace(tzinfo=BJT)
                if kickoff.astimezone(timezone.utc) <= now():
                    continue
            except ValueError:
                report['errors'].append(f'{number}: 开赛时间格式不正确')
                continue
            match['market'] = fetch_market(match, report['errors'])
            if now() >= kickoff.astimezone(timezone.utc):
                report['errors'].append(f'{number}: 市场采集期间已开赛，跳过预测')
                continue
            match['predicted_at'] = now().isoformat()
            match['prediction'] = model(match)
            previous=locks.get(str(match['source_id']))
            if previous and match['prediction']['status']=='PREDICTED':
                match['prediction']['modules']['冷门预警']=dict(previous,locked_from_prior=True)
                match['prediction']['modules']['今日优选']={'status':'BLOCKED','selection':None,'candidate':None,
                    'reason':'赛前冷门预警已触发，销售日内持续排除','evidence':[],
                    'missing':[],'model':'DAILY_VALUE_EVIDENCE_V1'}
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
