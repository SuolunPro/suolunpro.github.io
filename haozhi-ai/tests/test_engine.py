import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from engine import predict

class EngineTest(unittest.TestCase):
    def test_missing_inputs(self):
        self.assertEqual(predict({"fixture_id":"test"})["status"],"未完成")
    def test_probability_mass(self):
        f={"fixture_id":"DEMO","home":"A","away":"B","kickoff":"2026-11-05T18:00:00+08:00",
           "collected_at":"2026-11-04T16:00:00+08:00","source":"synthetic test only",
           "home_xg":1.5,"away_xg":1.1,"official_handicap":-1,"first_half_goal_share":0.45}
        r=predict(f)
        for key in ("胜平负","让球胜平负","总进球","半全场"):
            self.assertAlmostEqual(sum(r[key].values()),1,places=6)
        self.assertEqual(r["今日优选"]["status"],"不入选")
    def test_no_postkickoff(self):
        f={"fixture_id":"X","home":"A","away":"B","kickoff":"2026-11-04T10:00:00Z",
           "collected_at":"2026-11-04T11:00:00Z","source":"test","home_xg":1.5,"away_xg":1.1,"official_handicap":1}
        self.assertEqual(predict(f)["status"],"未完成")

if __name__=="__main__":
    unittest.main()
