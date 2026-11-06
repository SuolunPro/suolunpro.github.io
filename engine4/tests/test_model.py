import unittest
from engine4.engine import model, normalize_pool, cold_warning, asian_snapshot, daily_pick, calibrate_goals, outcome_probs
from engine4.settle import score
from engine4.fotmob import FotmobXg, xg_pair

class EngineTests(unittest.TestCase):
    def test_cross_midnight_sale_day(self):
        rows=[{'matchTypeValue':0,'displayNo':'周五 001','dayLabel':'2026 - 11 - 07 周六','state':'upcoming','id':3,'home':'甲','away':'乙','kickoff':'01:30','spfSp':'1.74 3.82 3.30','rqspfSp':'主(-1) 3.10 3.75 1.82'}]
        pool=normalize_pool(rows,'2026-11-06')
        self.assertEqual(pool['001']['handicap'],-1)
        self.assertEqual(pool['001']['kickoff'],'2026-11-07 01:30')
    def test_seven_modules(self):
        p=model({'spf':[1.8,3.6,4.2],'rqspf':[3.1,3.5,2.2],'handicap':-1})
        self.assertEqual(len(p['modules']),7)
        self.assertEqual(len(p['modules']['比分']['top3']),3)
        self.assertNotEqual(set(p['modules']['让球']['top2']), {'让胜','让负'})
        for name, key in [('胜平负','top2'),('让球','top2'),('比分','top3'),('总进球','top3'),('半全场','top3')]:
            module=p['modules'][name]
            for choice in module[key]:
                probability=module['probabilities'][str(choice)]
                self.assertGreaterEqual(probability,0)
                self.assertLessEqual(probability,1)
    def test_no_sp_no_prediction(self):
        self.assertEqual(model({'spf':None})['status'],'NO_PREDICTION')
    def test_score(self):
        self.assertEqual(score('2:1'),(2,1))
    def test_original_e2_needs_both_draw_signals(self):
        fixture={'spf':[2.4,3.1,2.6], 'handicap':-1,
          'market':{'william':{'initial':'2.40 / 3.60 / 2.60','current':'2.40 / 3.10 / 2.60'},'asia':{}}}
        result=cold_warning(fixture,'胜',{})
        self.assertEqual(result['channels'],['E2'])
        self.assertEqual(result['direction'],'主队不胜')
        fixture['market']['william']=None
        self.assertFalse(cold_warning(fixture,'胜',{})['triggered'])
    def test_original_d_needs_two_high_water_retreats(self):
        fixture={'spf':[1.8,3.5,4.0], 'handicap':-1,
          'market':{'william':{'initial':'1.80 / 3.50 / 4.00','current':'1.98 / 3.50 / 3.60'},
            'asia':{c:{'initial':'0.92 0.5 0.90','current':'1.03 0/0.5 0.82'} for c in ('澳门','皇冠')}}}
        self.assertEqual(asian_snapshot('0.92 0.5 0.90')['line'],-.5)
        self.assertIn('D',cold_warning(fixture,'胜',{})['channels'])
        fixture['market']['asia']['皇冠']['current']='0.98 0/0.5 0.87'
        result=cold_warning(fixture,'胜',{})
        self.assertFalse(result['triggered'])
        self.assertEqual(result['status'],'WATCH')
    def test_daily_market_candidate_not_formal(self):
        fixture={'spf':[1.43,3.98,5.30],'handicap':-1,
          'market':{'william':{'initial':'1.67 / 4.00 / 4.59','current':'1.70 / 3.80 / 4.59'},
            'asia':{c:{'initial':'0.93 0.5/1 0.91','current':'0.86 0.5/1 0.98'} for c in ('澳门','皇冠')}}}
        p=model(fixture)['modules']['今日优选']
        self.assertEqual(p['status'],'CANDIDATE')
        self.assertIsNone(p['selection'])
        self.assertEqual(p['candidate'],['胜','平'])
        self.assertEqual(p['top2'],['胜','平'])
        fixture['market']['asia']['皇冠']['current']='0.86 0.5 0.98'
        fixture['market']['asia']['澳门']['current']='0.86 0.5 0.98'
        self.assertEqual(model(fixture)['modules']['今日优选']['status'],'BLOCKED')
    def test_daily_cold_watch_excluded(self):
        fixture={'spf':[1.65,3.60,4.0],'handicap':-1,
          'market':{'william':{'initial':'1.60 / 3.90 / 4.20','current':'1.70 / 3.80 / 4.40'},
            'asia':{c:{'initial':'0.90 0.5 0.90','current':'0.90 0/0.5 0.90'} for c in ('澳门','皇冠')}}}
        d=model(fixture)['modules']['今日优选']
        self.assertEqual(d['status'],'BLOCKED')
        self.assertIn('退让',d['reason'])
    def test_goals_fit_pre_match_market_and_vary_by_match(self):
        low_draw=(.52,.17,.31)
        high_draw=(.52,.30,.18)
        lo=calibrate_goals(low_draw)
        hi=calibrate_goals(high_draw)
        self.assertGreater(sum(lo),sum(hi))
        self.assertAlmostEqual(outcome_probs(*lo)[1],low_draw[1],places=3)
        self.assertAlmostEqual(outcome_probs(*hi)[1],high_draw[1],places=3)
        a=model({'spf':[1.22,5.15,8.0]})['modules']['总进球']
        b=model({'spf':[1.7,3.17,4.25]})['modules']['总进球']
        self.assertNotEqual(a['top3'],b['top3'])
        self.assertNotEqual(a['estimated_total_goals'],b['estimated_total_goals'])
    def test_total_goals_full_distribution_from_verified_xg(self):
        fixture={'spf':[1.7,3.5,4.6], 'fotmob_xg':{
            'status':'AVAILABLE','source':'FotMob历史完赛xG',
            'home_lambda':2.4,'away_lambda':1.3,
            'samples':{'home':[{'xgf':2.4,'xga':1.2}]*3,
                       'away':[{'xgf':1.3,'xga':2.0}]*3}}}
        goals=model(fixture)['modules']['总进球']
        self.assertEqual(goals['source'],'FotMob历史完赛xG')
        self.assertEqual(goals['xg_status'],'AVAILABLE')
        self.assertAlmostEqual(goals['estimated_total_goals'],3.7)
        self.assertEqual(set(goals['probabilities']),{'0','1','2','3','4','5','6','7+'})
        self.assertAlmostEqual(sum(goals['probabilities'].values()),1,places=4)
        self.assertEqual(goals['top3'],[int(k) if k!='7+' else k for k in
            sorted(goals['probabilities'],key=lambda k:(-goals['probabilities'][k],k))[:3]])
        fallback=model({'spf':[1.7,3.5,4.6]})['modules']['总进球']
        self.assertEqual(fallback['xg_status'],'UNAVAILABLE')
        self.assertEqual(fallback['source'],'SP')

    def test_score_top3_uses_same_fotmob_xg_as_total_goals(self):
        fixture={'spf':[1.7,3.5,4.6], 'fotmob_xg':{
            'status':'AVAILABLE','source':'FotMob历史完赛xG',
            'home_lambda':2.4,'away_lambda':0.7,
            'samples':{'home':[{'xgf':2.4,'xga':0.8}]*3,
                       'away':[{'xgf':0.7,'xga':2.1}]*3}}}
        modules=model(fixture)['modules']
        score=modules['比分']
        goals=modules['总进球']
        self.assertEqual(score['source'],'FotMob历史完赛xG')
        self.assertEqual(score['xg_status'],'AVAILABLE')
        self.assertEqual((score['home_expected_goals'],score['away_expected_goals']),(2.4,0.7))
        self.assertEqual(score['top3'][0],'2:0')
        self.assertEqual(score['home_expected_goals'],goals['home_expected_goals'])
        self.assertEqual(score['away_expected_goals'],goals['away_expected_goals'])
        self.assertGreater(score['matrix_probability_mass'],.999)
        self.assertEqual(set(score['top3']),set(score['probabilities']))

    def test_handicap_and_halftime_use_fotmob_xg(self):
        fixture={'spf':[1.8,3.4,4.5],'rqspf':[2.9,3.3,2.1],'handicap':-1,
            'fotmob_xg':{'status':'AVAILABLE','source':'FotMob历史完赛xG',
                'home_lambda':2.5,'away_lambda':0.7,
                'samples':{'home':[{'xgf':2.5,'xga':0.7}]*3,
                           'away':[{'xgf':0.7,'xga':2.5}]*3}}}
        p=model(fixture)['modules']
        rq=p['让球']
        self.assertEqual(rq['source'],'FotMob历史完赛xG')
        self.assertAlmostEqual(sum(rq['probabilities'].values()),1,places=4)
        self.assertAlmostEqual(sum(rq['market_probabilities'].values()),1,places=4)
        self.assertEqual(rq['probabilities'],rq['xg_probabilities'])
        self.assertEqual(rq['top2'][0],max(rq['probabilities'],key=rq['probabilities'].get))
        hft=p['半全场']
        self.assertEqual(hft['source'],'FotMob历史完赛xG')
        self.assertEqual(len(hft['probabilities']),9)
        self.assertAlmostEqual(sum(hft['probabilities'].values()),1,places=4)
        self.assertEqual(hft['top3'][0],max(hft['probabilities'],key=hft['probabilities'].get))
        no_xg=model({'spf':[1.8,3.4,4.5],'rqspf':[2.9,3.3,2.1],'handicap':-1})['modules']
        self.assertEqual(no_xg['让球']['source'],'SP')
        self.assertEqual(no_xg['半全场']['xg_status'],'UNAVAILABLE')

    def test_fotmob_historical_xg_precedes_market_fallback(self):
        kickoff='2030-11-06T20:00:00.000Z'
        fixture={'id':50,'home':{'id':8668,'name':'Everton'},'away':{'id':8669,'name':'Coventry City'},
                 'status':{'utcTime':kickoff}}
        def get(url):
            if '/matches?' in url:
                return {'leagues':[{'matches':[] if 'date=20301107' in url else [fixture]}]}
            if 'matchId=50' in url:
                return {'general':{'matchId':50,'homeTeam':{'id':8668},'awayTeam':{'id':8669},
                                   'matchTimeUTCDate':kickoff,'started':False,'finished':False}}
            if '/teams?id=' in url:
                team=int(url.split('=')[-1])
                return {'fixtures':{'allFixtures':{'fixtures':[
                    {'id':team*10+i,'home':{'id':team},'away':{'id':999},
                     'status':{'utcTime':f'2026-10-{i+10:02d}T12:00:00.000Z','finished':True}}
                    for i in range(3)]}}}
            if '/matchDetails?' in url:
                match_id=int(url.split('=')[-1])
                team=match_id//10
                return {'general':{'matchId':match_id,'homeTeam':{'id':team},'awayTeam':{'id':999},'finished':True},
                    'content':{'stats':{'stats':[{'key':'expected_goals','stats':['1.80','1.20']}]}}}
            raise AssertionError(url)
        collector=FotmobXg('2030-11-06',get=get)
        match={'home':'埃弗顿','away':'考文垂','kickoff':'2030-11-07 04:00',
               'spf':[1.43,3.98,5.3]}
        found=collector.collect(match)
        self.assertEqual(found['status'],'AVAILABLE',found)
        self.assertEqual(found['match_id'],50)
        self.assertEqual(found['home_lambda'],1.5)
        prediction=model(dict(match,fotmob_xg=found))
        self.assertTrue(prediction['coverage']['independent_xg'])
        self.assertEqual(prediction['modules']['总进球']['source'],'FotMob历史完赛xG')
        self.assertEqual(prediction['modules']['总进球']['estimated_total_goals'],3.0)
        self.assertEqual(collector.collect(dict(match,home='未知球队'))['status'],'UNAVAILABLE')
        self.assertEqual(xg_pair({'key':'expected_goals','stats':['1.2','0.9']}),(1.2,.9))
