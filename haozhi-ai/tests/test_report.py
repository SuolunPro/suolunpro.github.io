import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from report import build_report

class ReportTest(unittest.TestCase):
    def test_empty_is_not_full_coverage(self):
        r=build_report({"fixtures":[]})
        self.assertEqual(r["official_pool_coverage"],"未确认")
        self.assertEqual(r["module_completed_counts"]["冷门预警"],0)
    def test_missing_inputs(self):
        r=build_report({"fixtures":[{"fixture_id":"X"}]})
        self.assertEqual(r["fixtures"][0]["status"],"未完成")
    def test_duplicates(self):
        with self.assertRaises(ValueError):
            build_report({"fixtures":[{"fixture_id":"X"},{"fixture_id":"X"}]})
if __name__=="__main__":
    unittest.main()
