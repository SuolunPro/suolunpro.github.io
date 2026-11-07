import unittest
from datetime import datetime, timezone, timedelta
from engine4.market_bridge import attach, norm

class MarketBridgeTests(unittest.TestCase):
    def setUp(self):
        self.match={"match_no":"006","home":"利兹联","away":"热刺","kickoff":"2026-11-07 22:00"}
        self.rows=[{"team":"利兹联"},{"team":"平局"},{"team":"热刺"}]
        self.record={"match_no":"006","okooo_id":"123","status":"parsed_unverified",
          "source_timestamp_verified":True,"source_captured_at":"2026-11-07T10:00:00+00:00",
          "transaction_rows":self.rows,"index_rows":self.rows}
    def test_prematch(self):
        self.assertTrue(attach(self.match,[self.record])["prematch_verified"])
    def test_after_kickoff_rejected(self):
        self.record["source_captured_at"]="2026-11-07T15:00:00+00:00"
        self.assertIsNone(attach(self.match,[self.record]))
    def test_wrong_team_rejected(self):
        self.record["transaction_rows"]=[{"team":"其他队"},{"team":"平局"},{"team":"热刺"}]
        self.assertIsNone(attach(self.match,[self.record]))
    def test_wrong_number_rejected(self):
        self.record["match_no"]="007"
        self.assertIsNone(attach(self.match,[self.record]))
    def test_unverified_rejected(self):
        self.record["source_timestamp_verified"]=False
        self.assertIsNone(attach(self.match,[self.record]))
    def test_normalization(self):
        self.assertEqual(norm("利 兹 联"),norm("利兹联"))

if __name__=="__main__":
    unittest.main()
