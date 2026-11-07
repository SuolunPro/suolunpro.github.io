"""Independent, public-source football model. No legacy database access."""
import json
import math
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from engine4.legacy_score import legacy_score_top4
from engine4.fotmob import FotmobXg
from engine4.market_bridge import load as load_betfair, attach as attach_betfair

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

def william_dynamic_shadow(match, base):
    """Auditable shadow calibration; never changes formal frozen selections.

    Experimental 25% market blend is not a historically validated weight.
    """
    directions=('胜','平','负')
    w=((match.get('market') or {}).get('william') or {})
    initial=odds3(w.get('initial'))
    current=odds3(w.get('current'))
    pi=normalize_probs(initial)
    pc=normalize_probs(current)
    baseline={d:round(v,6) for d,v in zip(directions,base)}
    if not pi or not pc:
        return {'status':'UNAVAILABLE','reason':'威廉同机构初赔及即时赔未同时核实',
                'base_probabilities':baseline,'formal':False}
    alpha=.25
    adjusted=[(1-alpha)*base[i]+alpha*pc[i] for i in range(3)]
    ranked=sorted(range(3),key=lambda i:(-adjusted[i],i))
    original=sorted(range(3),key=lambda i:(-base[i],i))
    return {'status':'SHADOW','version':'WILLIAM_DYNAMIC_SHADOW_V01',
            'formal':False,'weight_experimental':alpha,
            'source':'威廉希尔同机构初赔→即时赔',
            'initial_probabilities':dict(zip(directions,[round(v,6) for v in pi])),
            'current_probabilities':dict(zip(directions,[round(v,6) for v in pc])),
            'probability_movement_pp':dict(zip(directions,[round((pc[i]-pi[i])*100,3) for i in range(3)])),
            'base_probabilities':baseline,
            'calibrated_probabilities':dict(zip(directions,[round(v,6) for v in adjusted])),
            'base_top1':directions[original[0]],'base_top2':[directions[i] for i in original[:2]],
            'shadow_top1':directions[ranked[0]],'shadow_top2':[directions[i] for i in ranked[:2]],
            'changed_top1':ranked[0]!=original[0]}

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

def outcome_probs(home_goals, away_goals):
    """Independent Poisson 1X2 implied by two goal rates, truncated at 12 goals."""
    hp=[poisson(home_goals,n) for n in range(13)]
    ap=[poisson(away_goals,n) for n in range(13)]
    h=sum(hp[i]*ap[j] for i in range(13) for j in range(i))
    d=sum(hp[i]*ap[i] for i in range(13))
    a=sum(hp[i]*ap[j] for i in range(13) for j in range(i+1,13))
    s=h+d+a
    return h/s,d/s,a/s

def calibrate_goals(probs):
    """Fit match-specific Poisson rates to pre-match 1X2 implied probabilities.

    This remains a market-derived estimate; it is not independently measured xG.
    """
    home,draw,away=probs
    target_share=home/(home+away)
    def at_total(total):
        lo,hi=.02,.98
        for _ in range(22):
            share=(lo+hi)/2
            h,d,a=outcome_probs(total*share,total*(1-share))
            if h/(h+a)<target_share:
                lo=share
            else:
                hi=share
        share=(lo+hi)/2
        h,d,a=outcome_probs(total*share,total*(1-share))
        return total*share,total*(1-share),d
    lo,hi=1.2,6.0
    for _ in range(24):
        mid=(lo+hi)/2
        if at_total(mid)[2]>draw:
            lo=mid
        else:
            hi=mid
    lam_h,lam_a,_=at_total((lo+hi)/2)
    return lam_h,lam_a

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
    bifa=match.get('bifa') or {}
    funding_direction=None
    hot_cold=None
    institution_support=None
    if bifa.get('prematch_verified') and idx is not None:
        rows=bifa.get('index_rows') or []
        tx=bifa.get('transaction_rows') or []
        shares=[r.get('bfShare') for r in rows]
        valid=(len(shares)==3 and len(tx)==3 and
               all(isinstance(v,(int,float)) and 0<=v<=100 for v in shares) and
               abs(sum(shares)-100)<=1.5 and
               all(isinstance(r.get('bfVolume'),(int,float)) and r['bfVolume']>=0 for r in tx))
        if valid:
            leader=max(range(3),key=lambda i:shares[i])
            funding_direction=('主胜','平局','客胜')[leader]
            hot_cold=[r.get('bfHotCold') for r in rows]
            institution_support=[r.get('avgProb') for r in rows]
            evidence.append('澳客必发赛前资金比例 '+ '/'.join(f'{v:g}%' for v in shares)+
                            '；成交量 '+ '/'.join(f'{r["bfVolume"]:g}' for r in tx))
            if leader!=idx and leader!=1:
                channels.append('A')
                evidence.append('A：必发最高资金方向为反向胜负 '+funding_direction)
            if leader==1 and bifa.get('exchange_scale') in ('适中','较大'):
                channels.append('B')
                evidence.append('B：必发平局资金最多且交易规模'+bifa['exchange_scale'])
            if leader!=idx and fi and fc and (fc[idx]-fi[idx])*100<=-7:
                channels.append('C')
                evidence.append('C：威廉主方向公平比例下降至少7个百分点且必发反向')
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
            'funding_direction':funding_direction,'hot_cold_index':hot_cold,
            'institution_support':institution_support,
            'market_captured_at':bifa.get('captured_at') or market.get('captured_at'),
            'missing':([] if funding_direction else ['必发资金方向（A/B/C未评估）'])+['严格赛前独立比分（E1未评估）']+
                      ([] if fi and fc else ['威廉初盘与即时盘（D/E2未评估）'])+
                      ([] if asian else ['亚洲盘口（D未评估）']),
            'checked':(['A','B','C'] if funding_direction else [])+(['D'] if fi and fc and asian else [])+(['E2'] if fi and fc else []),
            'model':'SOREN_ABCDE_EVIDENCE_V1'}

def daily_pick(match, top2, ft, cold):
    """Legacy-style risk gates; independent model/Bifa absence forbids formal publication."""
    top = top2[0]
    reasons=[]
    if top not in ('胜','负'):
        reasons.append('胜平负 Top1 为平局')
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
    bifa=match.get('bifa') or {}
    shares=[r.get('bfShare') for r in (bifa.get('index_rows') or [])]
    if bifa.get('prematch_verified') and len(shares)==3 and all(isinstance(v,(int,float)) for v in shares):
        if max(range(3),key=lambda i:shares[i])!=idx:
            reasons.append('必发最大资金方向不支持 Top1')
        if shares[idx]<50:
            reasons.append(f'必发 Top1 资金占比 {shares[idx]:.1f}% 低于旧版 50% 门槛')
        institution=[r.get('avgProb') for r in bifa['index_rows']]
        if not all(isinstance(v,(int,float)) for v in institution) or abs(sum(institution)-100)>3:
            reasons.append('99家机构概率不完整')
        elif max(range(3),key=lambda i:institution[i])!=idx:
            reasons.append('99家机构平均概率首选方向不支持 Top1')
    # Historical fixed odds/probability gates are diagnostic only, not automatic vetoes.
    evidence=[f'原版门槛审计：SP Top1 {ft[top]*100:.1f}%'+('（低于旧55%门槛）' if ft[top]<.55 else '（达到旧55%门槛）')]
    if odds:
        evidence.append(f'原版赔率区间审计：{odds[idx]:.2f}'+('（超出旧1.45–1.75）' if not 1.45<=odds[idx]<=1.75 else '（位于旧区间）'))
    evidence.append(f'SP Top1 {top} 去水隐含比例 {ft[top]*100:.1f}%')
    if odds:
        evidence.append(f'威廉同方向赔率 {odds[idx]:.2f}' if wp[idx]==max(wp) else '威廉方向不一致')
    evidence.append(f'亚洲盘口可读 {len(valid)} 家，退让 {len(retreat)} 家')
    # The old CORE/SUPPLEMENT selector also requires a verified independent
    # model class, selection mode, risk lock, and Bifa funding alignment.
    if reasons:
        return {'status':'BLOCKED','selection':None,'candidate':None,'reason':'；'.join(reasons),
                'evidence':evidence,'missing':['独立赛前模型 A 档/SINGLE/HUR','必发资金方向与份额'],
                'model':'DAILY_VALUE_EVIDENCE_V2_SHADOW'}
    if not (match.get('bifa') or {}).get('prematch_verified'):
        return {'status':'CANDIDATE','selection':None,'candidate':top2[:2],'top2':top2[:2],
                'reason':'市场筛选候选；缺少赛前必发资金方向，暂不发布正式今日优选',
                'evidence':evidence,'missing':['独立赛前模型 A 档/SINGLE/HUR','必发资金方向与份额'],
                'model':'DAILY_VALUE_EVIDENCE_V2_SHADOW'}
    return {'status':'SELECTED','selection':top2[:2],'candidate':None,'top2':top2[:2],
            'reason':'通过4.0市场风险闸门的正式双选；未具备旧版母模型 A 档/SINGLE/HUR 证明',
            'evidence':evidence,'missing':['独立赛前模型 A 档/SINGLE/HUR'],
            'model':'DAILY_MARKET_DOUBLE_V4'}

def daily_pick_shadow_v2(match, ft, cold, use_xg=False, xg_ft=None):
    """Independent double-choice shadow audit; never counted as a formal pick."""
    directions=('胜','平','负')
    market=match.get('market') or {}
    william=market.get('william') or {}
    wi=normalize_probs(odds3(william.get('initial')))
    wc=normalize_probs(odds3(william.get('current')))
    asian=market.get('asia') or {}
    top=max(ft,key=ft.get)
    signals=[]
    blockers=[]
    if cold.get('status')=='TRIGGERED' or cold.get('triggered'):
        blockers.append('正式冷门预警：整期排除')
    if not wc:
        blockers.append('威廉即时赔率不可核验')
    elif directions[wc.index(max(wc))]!=top:
        blockers.append('威廉与体彩首选背离')
    valid=0
    retreat=0
    for quote in asian.values():
        cur=asian_snapshot(quote.get('current'))
        initial=asian_snapshot(quote.get('initial'))
        if cur:
            valid+=1
        if cur and initial and ((top=='胜' and cur['line']-initial['line']>=.249999) or
                                (top=='负' and initial['line']-cur['line']>=.249999)):
            retreat+=1
    if valid<2:
        blockers.append('亚洲盘口有效机构不足两家')
    if retreat>=2:
        blockers.append('至少两家亚洲机构对首选退让')
    if cold.get('status')=='WATCH':
        signals.append('冷门观察：需进一步市场复核')
    if retreat:
        signals.append('盘口退让 '+str(retreat)+' 家')
    if wi and wc and wc[1]>wi[1]+.015:
        signals.append('威廉平局隐含概率上升')
    if ft['平']>=.27:
        signals.append('平局市场基线较高')
    if use_xg and xg_ft:
        if xg_ft.get('平',0)>ft['平']+.025:
            signals.append('独立历史xG支持提高平局权重')
    else:
        signals.append('独立历史xG缺失：不进行伪独立概率加权')
    # Keep market probabilities as the baseline. Do not turn correlated
    # qualitative signals into fabricated numerical probability boosts.
    choices=sorted(directions,key=lambda d:(-ft[d],directions.index(d)))[:2]
    if '平' not in choices and len(signals)>=2 and any('平局' in x for x in signals):
        choices=[top,'平']
    coverage=sum(ft[d] for d in choices)
    omitted=next(d for d in directions if d not in choices)
    if coverage<.70:
        blockers.append('双选市场覆盖率低于探索门槛70%')
    if ft[omitted]>.30:
        blockers.append('第三方向市场风险高于30%')
    return {'version':'DAILY_DOUBLE_V2_SHADOW_0_1','status':'BLOCKED' if blockers else 'SHADOW_CANDIDATE',
            'selection':choices if not blockers else None,'shadow_choices':choices,
            'market_coverage':round(coverage,4),'omitted_direction':omitted,
            'omitted_market_risk':round(ft[omitted],4),'signals':signals,'blockers':blockers,
            'source':'赛前体彩SP+威廉+亚洲盘口；历史xG仅在核验可用时辅助',
            'official':False,'settlement_eligible':False}

def handicap_probabilities(lam_h,lam_a,line):
    """90-minute lottery handicap: home score plus integer line."""
    totals={'让胜':0.0,'让平':0.0,'让负':0.0}
    for h in range(13):
        for a in range(13):
            d=h+line-a
            totals['让胜' if d>0 else '让平' if d==0 else '让负']+=poisson(lam_h,h)*poisson(lam_a,a)
    mass=sum(totals.values())
    return {k:v/mass for k,v in totals.items()}


def halftime_fulltime_probabilities(lam_h,lam_a):
    """Joint 9 outcomes; provisional 50/50 half xG split, not measured."""
    totals={h+'-'+f:0.0 for h in ('胜','平','负') for f in ('胜','平','负')}
    halves=[(h,a,poisson(lam_h/2,h)*poisson(lam_a/2,a)) for h in range(10) for a in range(10)]
    def direction(h,a):
        return '胜' if h>a else '平' if h==a else '负'
    for h1,a1,p1 in halves:
        for h2,a2,p2 in halves:
            totals[direction(h1,a1)+'-'+direction(h1+h2,a1+a2)]+=p1*p2
    mass=sum(totals.values())
    return {k:v/mass for k,v in totals.items()}


def model(match):
    probs = normalize_probs(match['spf'])
    if not probs:
        # A match may sell only the official handicap market. Keep it eligible
        # for a real handicap prediction without fabricating regular 1X2 SP.
        rq = normalize_probs(match.get('rqspf'))
        handicap = match.get('handicap')
        if not rq or not isinstance(handicap, int):
            return {'status':'NO_PREDICTION', 'reason':'普通胜平负及有效让球SP均缺失'}
        market = dict(zip(('让胜','让平','让负'), rq))
        ranked = sorted(market, key=market.get, reverse=True)
        top2 = ranked[:2]
        if set(top2) == {'让胜', '让负'}:
            top2 = [top2[0], '让平']
        # Independent goal modules may run only on verified prematch FotMob xG.
        # Official handicap SP alone cannot identify an exact-goal distribution.
        xg = match.get('fotmob_xg') or {}
        use_xg = xg.get('status') == 'AVAILABLE' and all(
            isinstance(xg.get(k), (int, float)) and math.isfinite(xg[k])
            and .15 <= xg[k] <= 5 for k in ('home_lambda', 'away_lambda'))
        goal_modules = {}
        if use_xg:
            lh, la = xg['home_lambda'], xg['away_lambda']
            inferred = outcome_probs(lh, la)
            legacy = legacy_score_top4(lh, la, inferred)
            total = lh + la
            goal_dist = {str(n): poisson(total, n) for n in range(7)}
            goal_dist['7+'] = max(0.0, 1 - sum(goal_dist.values()))
            goals = sorted(goal_dist, key=lambda n: (-goal_dist[n], n))[:3]
            hft_probs = halftime_fulltime_probabilities(lh, la)
            hft = sorted(hft_probs, key=hft_probs.get, reverse=True)[:3]
            goal_modules = {
                '比分': {'top3': legacy['top3'], 'top4': legacy['top4'],
                    'probabilities': legacy['probabilities'],
                    'method': '独立FotMob赛前历史xG；HJ3.8 Top4兼容排序',
                    'legacy_method': legacy['method'],
                    'legacy_input': '独立xG推导胜平负概率（非旧版P-final）',
                    'source': xg.get('source') or 'FotMob', 'xg_status': 'AVAILABLE',
                    'home_expected_goals': round(lh, 3),
                    'away_expected_goals': round(la, 3)},
                '总进球': {'top3': [int(n) if n != '7+' else '7+' for n in goals],
                    'probabilities': {n: round(v, 6) for n, v in goal_dist.items()},
                    'estimated_total_goals': round(total, 3),
                    'method': '独立FotMob赛前历史xG泊松',
                    'source': xg.get('source') or 'FotMob', 'xg_status': 'AVAILABLE'},
                '半全场': {'top3': hft,
                    'probabilities': {k: round(v, 6) for k, v in hft_probs.items()},
                    'method': '独立FotMob赛前历史xG半全场分布',
                    'source': xg.get('source') or 'FotMob', 'xg_status': 'AVAILABLE'}}
        else:
            goal_modules = {k: {'status': 'NO_PREDICTION',
                'reason': '普通胜平负SP缺失且无经核实的独立赛前xG'}
                for k in ('比分', '总进球', '半全场')}
        return {'status':'PREDICTED', 'method':'仅体彩让球胜平负SP去水',
            'confidence':'普通胜平负未开售；进球模块仅在独立xG可用时计算',
            'modules':{
                '胜平负':{'status':'NOT_ON_SALE','reason':'普通胜平负未开售'},
                '让球':{'status':'有数据','handicap':handicap,'top2':top2,
                    'method':'体彩让球SP去水','source':'SP','xg_status':'UNAVAILABLE',
                    'probabilities':{k:round(v,6) for k,v in market.items()},
                    'market_probabilities':{k:round(v,6) for k,v in market.items()},
                    'xg_probabilities':{}},
                **goal_modules,
                '冷门预警':{'status':'NOT_EVALUATED','triggered':False,'direction':None},
                '今日优选':{'status':'BLOCKED','selection':None,'reason':'普通胜平负未开售，不进入今日优选'}
            },'coverage':{'handicap_only':True,'independent_xg':use_xg,
                'william':bool((match.get('market') or {}).get('william')),
                'macau_asia':bool(((match.get('market') or {}).get('asia') or {}).get('澳门')),
                'bifa':bool((match.get('bifa') or {}).get('prematch_verified'))}}
    # Market implied probabilities are a baseline, not independent team ratings.
    home, draw, away = probs
    xg=match.get('fotmob_xg') or {}
    use_xg=xg.get('status')=='AVAILABLE' and all(isinstance(xg.get(k),(int,float)) and
        math.isfinite(xg[k]) and .15<=xg[k]<=5 for k in ('home_lambda','away_lambda'))
    lam_h,lam_a = (xg['home_lambda'],xg['away_lambda']) if use_xg else calibrate_goals(probs)
    total = lam_h+lam_a
    goal_method='FotMob历史完赛xG逐场估算' if use_xg else '赛前胜平负 SP 反推的泊松估算，缺少可用FotMob历史xG'
    # Exact-score matrix from the same verified FotMob historical xG rates
    # as total goals. Include 0..12 to retain virtually all probability mass.
    grid = [(h, a, poisson(lam_h,h)*poisson(lam_a,a)) for h in range(13) for a in range(13)]
    score = sorted(grid, key=lambda x:(-x[2],x[0],x[1]))[:3]
    legacy_score = legacy_score_top4(lam_h, lam_a, probs)
    score_coverage = sum(p for _,_,p in grid)
    # Sum of two independent Poisson goal counts is Poisson(lambda_home+lambda_away).
    # Calculate all 0..6 buckets directly; 7+ is the exact remaining tail.
    # This avoids silently dropping 7+ outcomes from a truncated score grid.
    goal_distribution = {str(n):poisson(total,n) for n in range(7)}
    goal_distribution['7+'] = max(0.0,1.0-sum(goal_distribution.values()))
    goals = sorted(goal_distribution.items(),key=lambda x:(-x[1],x[0]))[:3]
    ft = dict(zip(('胜','平','负'),probs))
    ranked = sorted(ft,key=ft.get,reverse=True)
    handicap = match.get('handicap')
    rq = normalize_probs(match.get('rqspf'))
    rq_market = dict(zip(('让胜','让平','让负'),rq)) if rq else {}
    rq_xg = handicap_probabilities(lam_h,lam_a,handicap) if isinstance(handicap,int) else {}
    rq_used = rq_xg if use_xg and rq_xg else rq_market
    rq_ranked = sorted(rq_used,key=rq_used.get,reverse=True)
    hft_all = halftime_fulltime_probabilities(lam_h,lam_a)
    hft = sorted(hft_all,key=hft_all.get,reverse=True)[:3]
    cold = cold_warning(match,ranked[0],ft)
    # Historical FotMob xG is an independent audit signal, not an automatic upset verdict.
    xg_audit={'status':'AVAILABLE' if use_xg else 'UNAVAILABLE',
              'source':xg.get('source') if use_xg else None,
              'reason':None if use_xg else xg.get('reason','赛前历史xG不可用')}
    if use_xg:
        xg_ft=dict(zip(('胜','平','负'),outcome_probs(lam_h,lam_a)))
        xg_top=max(xg_ft,key=xg_ft.get)
        xg_audit.update({'home_xgf':round(sum(s['xgf'] for s in xg['samples']['home'])/len(xg['samples']['home']),3),
                         'home_xga':round(sum(s['xga'] for s in xg['samples']['home'])/len(xg['samples']['home']),3),
                         'away_xgf':round(sum(s['xgf'] for s in xg['samples']['away'])/len(xg['samples']['away']),3),
                         'away_xga':round(sum(s['xga'] for s in xg['samples']['away'])/len(xg['samples']['away']),3),
                         'xg_top1':xg_top,
                         'xg_probabilities':{k:round(v,4) for k,v in xg_ft.items()},
                         'market_top1':ranked[0],
                         'direction_conflict':xg_top!=ranked[0]})
        if xg_top!=ranked[0]:
            cold.setdefault('watch',[]).append('FotMob历史xG方向与体彩SP首选背离，需人工复核；非独立冷门触发条件')
            if cold['status']=='NOT_TRIGGERED':
                cold['status']='WATCH'
                cold['level']='关注'
    daily = daily_pick(match, ranked[:2], ft, cold)
    daily_shadow_v2 = daily_pick_shadow_v2(match, ft, cold, use_xg, xg_ft if use_xg else None)
    rq_top2 = rq_ranked[:2]
    if set(rq_top2) == {'让胜','让负'}:
        rq_top2 = [rq_top2[0], '让平']
    return {'status':'PREDICTED','william_dynamic_shadow':william_dynamic_shadow(match,probs),'daily_pick_shadow_v2':daily_shadow_v2,'method':'胜平负 SP 去水；比分/进球/半全场采用'+goal_method,
        'confidence':'中低（历史xG样本有限且缺少必发）' if use_xg else '低（缺少必发与独立赛前xG）', 'modules':{
            '胜平负':{'top1':ranked[0],'top2':ranked[:2], 'probabilities':{k:round(v,4) for k,v in ft.items()}},
            '让球':{'handicap':handicap,'top2':rq_top2,
                'status':'有数据' if rq_ranked else '缺少让球SP或有效让球线',
                'method':goal_method+'；90分钟净胜球映射官方让球' if use_xg and rq_xg else '体彩让球SP去水',
                'source':'FotMob历史完赛xG' if use_xg and rq_xg else 'SP',
                'xg_status':'AVAILABLE' if use_xg and rq_xg else 'UNAVAILABLE',
                'probabilities':{k:round(v,6) for k,v in rq_used.items()},
                'market_probabilities':{k:round(v,6) for k,v in rq_market.items()},
                'xg_probabilities':{k:round(v,6) for k,v in rq_xg.items()} if use_xg else {}},
            '比分':{'top3':legacy_score['top3'], 'top4':legacy_score['top4'],
                'legacy_method':legacy_score['method'], 'dc_rho':legacy_score['dc_rho'],
                'legacy_input':'体彩SP去水概率（非旧版冻结P-final）', 'method':goal_method+'；旧版HJ3.8比分Top4兼容排序',
                'source':xg.get('source') if use_xg else 'SP',
                'xg_status':'AVAILABLE' if use_xg else 'UNAVAILABLE',
                'xg_missing_reason':None if use_xg else xg.get('reason','缺少经核实的赛前历史xG'),
                'home_expected_goals':round(lam_h,3),'away_expected_goals':round(lam_a,3),
                'xg_samples':{'home':len(xg['samples']['home']),'away':len(xg['samples']['away'])} if use_xg else None,
                'matrix_probability_mass':round(score_coverage,6),
                'probabilities':legacy_score['probabilities']},
            '总进球':{'top3':[int(n) if n!='7+' else '7+' for n,_ in goals],
                'estimated_total_goals':round(total,3),
                'home_expected_goals':round(lam_h,3),'away_expected_goals':round(lam_a,3),
                'method':goal_method,'source':xg.get('source') if use_xg else 'SP',
                'xg_status':'AVAILABLE' if use_xg else 'UNAVAILABLE',
                'xg_missing_reason':None if use_xg else xg.get('reason','缺少经核实的赛前历史xG'),
                'xg_samples':{'home':len(xg['samples']['home']),'away':len(xg['samples']['away'])} if use_xg else None,
                'probabilities':{n:round(v,6) for n,v in goal_distribution.items()},
                'top3_probabilities':{n:round(v,6) for n,v in goals}},
            '半全场':{'top3':hft,
                'method':goal_method+'；上下半场暂按50/50预期进球分配，联合比分转移计算',
                'source':xg.get('source') if use_xg else 'SP',
                'xg_status':'AVAILABLE' if use_xg else 'UNAVAILABLE',
                'half_split_assumption':'50/50（待真实半场xG验证）',
                'probabilities':{k:round(v,6) for k,v in hft_all.items()}},
            '冷门预警':cold,
            '今日优选':daily},
        'fotmob_audit':xg_audit,
        'coverage':{'independent_xg':use_xg,
                    'william':bool((match.get('market') or {}).get('william')),
                    'macau_asia':bool(((match.get('market') or {}).get('asia') or {}).get('澳门')),
                    'bifa':bool((match.get('bifa') or {}).get('prematch_verified'))}}

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
        # Preserve earlier pre-match snapshots for fixtures that have kicked off.
        # Never recompute their predictions from post-kickoff data.
        previous={}
        for source in [Path(out), *sorted(Path('data/engine4/history').glob('*.json'))]:
            try:
                old=json.loads(source.read_text(encoding='utf-8'))
                if old.get('sale_day')!=sale_day:continue
                for item in old.get('matches',[]):
                    key=str(item.get('match_no') or '')
                    if key and item.get('predicted_at') and item.get('prediction'):
                        if key not in previous or str(item['predicted_at'])>str(previous[key]['predicted_at']):
                            previous[key]=item
            except (OSError,ValueError,TypeError,KeyError):
                continue
        # Beijing-time sale-day cutoff; kickoff can close a fixture earlier.
        sale_date=datetime.strptime(sale_day,'%Y-%m-%d').replace(tzinfo=BJT)
        sale_weekday=sale_date.weekday()
        sale_cutoff=(sale_date.replace(hour=22 if sale_weekday==4 else 23,minute=0)
                     if sale_weekday in (4,5,6) else None)
        locks=prior_cold_locks(sale_day)
        fotmob=FotmobXg(sale_day)
        betfair_records=load_betfair(sale_day)
        for number in sorted(pool):
            match = pool[number]
            try:
                kickoff = datetime.fromisoformat(match['kickoff'].replace(' ','T')).replace(tzinfo=BJT)
                if kickoff.astimezone(timezone.utc) <= now() or (sale_cutoff and now() >= sale_cutoff.astimezone(timezone.utc)):
                    continue
            except ValueError:
                report['errors'].append(f'{number}: 开赛时间格式不正确')
                continue
            match['bifa']=attach_betfair(match,betfair_records)
            match['bifa_status']='已核验赛前' if match['bifa'] else '待更新'
            match['market'] = fetch_market(match, report['errors'])
            match['fotmob_xg'] = fotmob.collect(match)
            if now() >= kickoff.astimezone(timezone.utc):
                report['errors'].append(f'{number}: 市场采集期间已开赛，跳过预测')
                continue
            match['predicted_at'] = now().isoformat()
            match['prediction'] = model(match)
            locked_warning=locks.get(str(match['source_id']))
            if locked_warning and match['prediction']['status']=='PREDICTED':
                match['prediction']['modules']['冷门预警']=dict(locked_warning,locked_from_prior=True)
                match['prediction']['modules']['今日优选']={'status':'BLOCKED','selection':None,'candidate':None,
                    'reason':'赛前冷门预警已触发，销售日内持续排除','evidence':[],
                    'missing':[],'model':'DAILY_VALUE_EVIDENCE_V1'}
            report['matches'].append(match)
        # Keep all prior sale-day fixtures, including those no longer offered
        # by the mirror after kickoff. Settlement reads their frozen predictions.
        present={str(m.get('match_no')) for m in report['matches']}
        for number, frozen in sorted(previous.items()):
            if number not in present:
                report['matches'].append(frozen)
        report['matches'].sort(key=lambda m:str(m.get('match_no') or ''))
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

