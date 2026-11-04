import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from collectors.official_ingest import validate_record

class OfficialIngestTest(unittest.TestCase):
    def fixture(self):
        return {"retrieved_at":"2026-11-04T10:00:00+08:00","source_url":"https://example.org/test",
                "fixtures":[{"fixture_id":"DEMO","home":"A","away":"B",
                "kickoff":"2026-11-04T20:00:00+08:00","sale_end":"2026-11-04T19:50:00+08:00",
                "official_handicap":1,"sp_1x2":{"3":2.1,"1":3.1,"0":3.4},
                "sp_handicap":{"3":1.8,"1":3.2,"0":4.0}}]}
    def test_structure(self):
        self.assertEqual(validate_record(self.fixture())["fixture_count"],1)
    def test_late(self):
        f=self.fixture()
        f["retrieved_at"]="2026-11-04T19:55:00+08:00"
        with self.assertRaises(ValueError):validate_record(f)
    def test_missing_sp(self):
        f=self.fixture()
        del f["fixtures"][0]["sp_handicap"]
        with self.assertRaises(ValueError):validate_record(f)
if __name__=="__main__":
    unittest.main()
