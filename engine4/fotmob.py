"""Read-only FotMob historical xG inputs for exact pre-match fixtures.

No live/current fixture xG, result fields, or legacy database is used.
"""
import json
import math
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode
from urllib.request import Request, urlopen

BJT=timezone(timedelta(hours=8))
BASE='https://www.fotmob.com/api/data/'

# Exact team IDs verified against FotMob's dated fixture listing. Unknown
# translations are deliberately not guessed or matched by kickoff alone.
TEAM_IDS={
    '悉尼FC':10164,'中央海岸':8164,'不伦瑞克':9776,'科特布斯':8398,
    '哈马比':8248,'埃夫斯堡':8014,'蒙彼利埃':10249,'梅斯':8550,
    '威廉二世':8525,'兹沃勒':6413,'奥斯':7781,'瓦尔韦克':10219,
    '汉堡':9790,'门兴':9788,'威尼斯':7881,'乌迪内斯':8600,
    '图卢兹':9941,'斯特拉斯':9848,'埃弗顿':8668,'考文垂':8669,
    '德比郡':10170,'博尔顿':8559,'塞维利亚':8302,'阿拉维斯':9866,
    '法马利卡':1634,'阿罗卡':158085,'维多利亚':7733,'弗鲁米嫩':9863,
}

# Reused from the old 九十刻度 verified FotMob alias backfill (2026-09-22).
# This is a static, read-only identity map; no Supabase dependency.
# Fixture identity and kickoff must still pass collect()'s strict checks.
TEAM_IDS.update({
    'KFUM奥斯陆':2305,
    'OFI克里特':7753,
    'RB大宫松鼠':4398,
    '上海海港':198616,
    '上海申花':6628,
    '不莱梅':8697,
    '中国U23':317240,
    '中国香港U23':951610,
    '乌兹女':1243552,
    '仙台七夕':162192,
    '伊朗U23':622101,
    '克劳利':8647,
    '北京国安':4177,
    '卡塔尔U23':304032,
    '吉尔吉斯坦U23':638900,
    '埃弗斯堡':8232,
    '基多体育大学':6721,
    '山谷独立':192875,
    '拉查布里府':421346,
    '日本U23':298067,
    '朝鲜U23':624265,
    '札幌冈萨':112688,
    '杜连斯':212820,
    '格尼斯坦':2361,
    '格拉茨':10014,
    '格林斯比':10005,
    '沃夫斯堡':8721,
    '沙特U23':610874,
    '泰国U23':623768,
    '淡滨尼士':67386,
    '瓦斯特拉斯':6194,
    '米尔顿':8645,
    '艾因':102117,
    '菲律宾女':633428,
    '藤枝MYFC':305776,
    '诺茨郡':9819,
    '赫塔菲':8305,
    '赫尔蒙德':6417,
    '达姆斯塔':8262,
    '邓伯什':9835,
    '阿联酋U23':316113,
    '韩国U23':300702,
})


TEAM_NAMES = {
    '横滨水手': ('Yokohama F.Marinos', 'Yokohama F Marinos'),
    '冈山绿雉': ('Fagiano Okayama', 'Fagiano Okayama FC'), '鸟栖沙岩': ('Sagan Tosu',),
    '富山胜利': ('Kataller Toyama',), '柏太阳神': ('Kashiwa Reysol',),
    '川崎前锋': ('Kawasaki Frontale',), '金泉尚武': ('Gimcheon Sangmu', 'Gimcheon Sangmu FC'),
    'FC安养': ('FC Anyang',), '珀斯': ('Perth Glory',), '纽喷气机': ('Newcastle Jets',),
    '利兹联': ('Leeds United',), '热刺': ('Tottenham Hotspur',),
    '朴茨茅斯': ('Portsmouth',), '斯托克城': ('Stoke City',),
    '马拉加': ('Malaga', 'Málaga'), '桑坦德竞技': ('Racing Santander', 'Racing de Santander'),
    '都灵': ('Torino',), '莱切': ('Lecce',), '卡利亚里': ('Cagliari',),
    '弗洛西诺尼': ('Frosinone',), '莱红牛': ('RB Leipzig',),
    '奥格斯堡': ('Augsburg',), '帕德博恩': ('Paderborn', 'SC Paderborn 07'),
    '法兰克福': ('Eintracht Frankfurt',), '多特蒙德': ('Borussia Dortmund',),
    '埃尔沃斯贝格': ('Elversberg', 'SV Elversberg'),
    '美因茨': ('Mainz 05', 'Mainz'), '拜仁': ('Bayern München', 'Bayern Munich'),
    '阿森纳': ('Arsenal',), '赫尔城': ('Hull City',),
    '富勒姆': ('Fulham',), '纽卡斯尔': ('Newcastle United',),
    '伯明翰': ('Birmingham City',), '斯旺西': ('Swansea City',),
    '西班牙人': ('Espanyol',), '拉科鲁尼亚': ('Deportivo La Coruna', 'Deportivo La Coruña'),
    '福图纳': ('Fortuna Sittard',), '特尔斯达': ('Telstar',),
    '代格福什': ('Degerfors', 'Degerfors IF'), '哥德堡盖斯': ('GAIS',),
    '帕尔马': ('Parma',), '博洛尼亚': ('Bologna',),
    '诺丁汉': ('Nottingham Forest',), '曼城': ('Manchester City',),
    '斯图加特': ('VfB Stuttgart', 'Stuttgart'), '不莱梅': ('Werder Bremen',),
    '奥萨苏纳': ('Osasuna',), '毕尔巴鄂': ('Athletic Club', 'Athletic Bilbao'),
    '欧塞尔': ('Auxerre',), '巴黎FC': ('Paris FC',),
    '艾华卡': ('Alverca', 'FC Alverca'), '卡沙比亚': ('Casa Pia AC', 'Casa Pia'),
    '罗马': ('Roma', 'AS Roma'), '萨索洛': ('Sassuolo',),
    '米竞技': ('Atletico MG', 'Atlético MG', 'Atletico Mineiro'),
    '格雷米奥': ('Gremio', 'Grêmio'), '盐湖城': ('Real Salt Lake',),
    '洛城银河': ('LA Galaxy',),
}

def team_name_matches(label, fixture_name):
    norm = lambda value: ''.join(c.casefold() for c in str(value or '') if c.isalnum())
    return norm(fixture_name) in {norm(name) for name in TEAM_NAMES.get(label, (label,))}

def json_get(url):
    with urlopen(Request(url,headers={'User-Agent':'Mozilla/5.0',
                                      'Accept':'application/json'}),timeout=12) as response:
        if response.status!=200 or int(response.headers.get('Content-Length') or 0)>2500000:
            raise ValueError('FotMob response rejected')
        raw=response.read(2500001)
        if len(raw)>2500000:
            raise ValueError('FotMob response too large')
        return json.loads(raw)


def xg_pair(value):
    """Only match-level expected_goals; xGOT and player stats are excluded."""
    if isinstance(value,list):
        for item in value:
            found=xg_pair(item)
            if found is not None:
                return found
    if isinstance(value,dict):
        if value.get('key')=='expected_goals' and isinstance(value.get('stats'),list):
            try:
                h,a=map(float,value['stats'][:2])
                if all(math.isfinite(n) and 0<=n<=6 for n in (h,a)):
                    return h,a
            except (ValueError,TypeError):
                pass
        for key,item in value.items():
            if key not in ('stats','Periods','All','content') and key in ('playerStats','shotmap','lineup'):
                continue
            found=xg_pair(item)
            if found is not None:
                return found
    return None


class FotmobXg:
    def __init__(self, sale_day, get=json_get):
        self.get=get
        self.cache={}
        self.by_teams={}
        self.error=None
        day=datetime.strptime(sale_day,'%Y-%m-%d')
        for date in (day,day+timedelta(days=1)):
            try:
                doc=self.fetch('matches',date=date.strftime('%Y%m%d'))
                for league in doc.get('leagues',[]):
                    for fixture in league.get('matches',[]):
                        home,away=fixture.get('home',{}).get('id'),fixture.get('away',{}).get('id')
                        if home and away:
                            self.by_teams.setdefault((int(home),int(away)),[]).append(fixture)
            except Exception as exc:
                self.error=str(exc)[:150]
        if self.by_teams:
            self.error=None

    def fetch(self,path,**params):
        url=BASE+path+('?' + urlencode(params) if params else '')
        if url not in self.cache:
            self.cache[url]=self.get(url)
        return self.cache[url]

    def resolve_identity(self, match):
        """Persist an unambiguous FotMob fixture independently of historical xG."""
        try:
            kickoff=datetime.fromisoformat(match['kickoff'].replace(' ','T')).replace(tzinfo=BJT)
        except (KeyError,ValueError,TypeError):
            return None
        home_id=TEAM_IDS.get(match.get('home'))
        away_id=TEAM_IDS.get(match.get('away'))
        norm=lambda value: ''.join(c.casefold() for c in str(value or '') if c.isalnum())
        candidates={}
        for (hid,aid),fixtures in self.by_teams.items():
            if home_id and hid!=home_id:
                continue
            if away_id and aid!=away_id:
                continue
            for fixture in fixtures:
                try:
                    stamp=datetime.fromisoformat(fixture['status']['utcTime'].replace('Z','+00:00'))
                    if abs((stamp-kickoff).total_seconds())>600:
                        continue
                    if not home_id and not team_name_matches(match.get('home'), fixture['home']['name']):
                        continue
                    if not away_id and not team_name_matches(match.get('away'), fixture['away']['name']):
                        continue
                    candidates[int(fixture['id'])]=(hid,aid)
                except (KeyError,ValueError,TypeError):
                    continue
        if len(candidates)!=1:
            return None
        fixture_id,(hid,aid)=next(iter(candidates.items()))
        return {'fotmob_match_id':fixture_id,'fotmob_home_team_id':hid,
                'fotmob_away_team_id':aid}

    def collect(self,match):
        missing=lambda reason:{'status':'UNAVAILABLE','reason':reason,'source':'FotMob'}
        if self.error:
            return missing('FotMob赛程读取失败：'+self.error)
        home_id,away_id=TEAM_IDS.get(match['home']),TEAM_IDS.get(match['away'])
        if not home_id or not away_id:
            # Legacy exact-fixture matching without the legacy Elo/Supabase DB.
            # Resolve only when both names match FotMob fixture labels exactly,
            # or when the match carries independently verified FotMob team IDs.
            def norm(value):
                return ''.join(ch.casefold() for ch in str(value or '') if ch.isalnum())
            kickoff_text=match.get('kickoff','')
            try:
                kickoff_probe=datetime.fromisoformat(kickoff_text.replace(' ','T')).replace(tzinfo=BJT)
            except (ValueError,TypeError):
                return missing('开赛时间无法核实')
            pairs=set()
            for (hid,aid),fixtures in self.by_teams.items():
                for fixture in fixtures:
                    try:
                        stamp=datetime.fromisoformat(fixture['status']['utcTime'].replace('Z','+00:00'))
                        if abs((stamp-kickoff_probe).total_seconds())>60:
                            continue
                        hname=fixture.get('home',{}).get('name')
                        aname=fixture.get('away',{}).get('name')
                        if team_name_matches(match['home'], hname) and team_name_matches(match['away'], aname):
                            pairs.add((hid,aid))
                    except (KeyError,ValueError,TypeError):
                        continue
            if len(pairs)!=1:
                return missing('球队缺少经核实的FotMob ID映射；动态赛程匹配未唯一确认')
            home_id,away_id=next(iter(pairs))
        try:
            kickoff=datetime.fromisoformat(match['kickoff'].replace(' ','T')).replace(tzinfo=BJT)
        except ValueError:
            return missing('开赛时间无法核实')
        candidates={}
        for item in self.by_teams.get((home_id,away_id),[]):
            try:
                time=datetime.fromisoformat(item['status']['utcTime'].replace('Z','+00:00'))
                if abs((time-kickoff).total_seconds())<=60:
                    candidates[int(item['id'])]=item
            except (KeyError,ValueError,TypeError):
                continue
        if len(candidates)!=1:
            return missing('FotMob双方球队及开赛时间未唯一对应')
        target=next(iter(candidates.values()))
        try:
            details=self.fetch('matchDetails',matchId=target['id'])
            g=details['general']
            time=datetime.fromisoformat(g['matchTimeUTCDate'].replace('Z','+00:00'))
            if (int(g['matchId'])!=int(target['id']) or int(g['homeTeam']['id'])!=home_id or
                int(g['awayTeam']['id'])!=away_id or abs((time-kickoff).total_seconds())>60 or
                g.get('started') or g.get('finished') or details.get('header',{}).get('status',{}).get('started')):
                return missing('目标比赛身份或赛前状态核验失败')
            boundary=datetime.now(timezone.utc)
            if boundary>=kickoff.astimezone(timezone.utc):
                return missing('比赛已经开赛')
            teams=[]
            for team_id in (home_id,away_id):
                team=self.fetch('teams',id=team_id)
                fixtures=team.get('fixtures',{}).get('allFixtures',{}).get('fixtures',[])
                past=[]
                for f in fixtures:
                    try:
                        stamp=datetime.fromisoformat(f['status']['utcTime'].replace('Z','+00:00'))
                        if (f['status'].get('finished') and not f['status'].get('cancelled') and
                            stamp+timedelta(minutes=90)<boundary and stamp<kickoff):
                            past.append((stamp,f))
                    except (KeyError,ValueError,TypeError):
                        continue
                past.sort(key=lambda row:row[0],reverse=True)
                samples=[]
                for _,fixture in past[:8]:
                    if len(samples)>=5:
                        break
                    try:
                        old=self.fetch('matchDetails',matchId=fixture['id'])
                    except Exception:
                        continue
                    general=old.get('general',{})
                    if (str(general.get('matchId'))!=str(fixture['id']) or
                        not (general.get('finished') or old.get('header',{}).get('status',{}).get('finished')) or
                        int(general.get('homeTeam',{}).get('id') or 0)!=int(fixture['home']['id']) or
                        int(general.get('awayTeam',{}).get('id') or 0)!=int(fixture['away']['id'])):
                        continue
                    pair=xg_pair(old.get('content',{}).get('stats',{}))
                    if pair is None:
                        continue
                    xgf,xga=pair if int(fixture['home']['id'])==team_id else pair[::-1]
                    samples.append({'match_id':fixture['id'],'xgf':xgf,'xga':xga})
                teams.append(samples)
            if min(map(len,teams))<3:
                return missing(f'历史完赛xG样本不足：主{len(teams[0])}场、客{len(teams[1])}场')
            home,away=teams
            avg=lambda rows,key:sum(row[key] for row in rows)/len(rows)
            home_lambda=(avg(home,'xgf')+avg(away,'xga'))/2
            away_lambda=(avg(away,'xgf')+avg(home,'xga'))/2
            if not all(.15<=n<=5 for n in (home_lambda,away_lambda)):
                return missing('历史xG均值超出有效范围')
            return {'status':'AVAILABLE','source':'FotMob历史完赛xG','match_id':target['id'],
                    'home_team_id':home_id,'away_team_id':away_id,
                    'home_lambda':round(home_lambda,4),'away_lambda':round(away_lambda,4),
                    'samples':{'home':home,'away':away},'captured_at':boundary.isoformat(),
                    'method':'最近5场已结束比赛双方xG进攻与对手xG防守均值各占一半'}
        except Exception as exc:
            return missing('FotMob历史xG读取失败：'+str(exc)[:120])
