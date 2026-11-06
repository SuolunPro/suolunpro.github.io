import unittest
from engine4.engine import model, normalize_pool, cold_warning, asian_snapshot, daily_pick
from engine4.settle import score

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
        self.assertEqual(p['candidate'],'胜')
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
