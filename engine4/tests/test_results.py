import unittest
import json
import tempfile
from pathlib import Path
from unittest.mock import patch
from datetime import datetime, timezone
from engine4.fotmob_results import result_for, BASE
from engine4.settle import mark, score
from engine4.aggregate import metrics


class VerificationTests(unittest.TestCase):
    def fixture(self):
        return {
            "home": "悉尼FC", "away": "中央海岸", "match_no": "001",
            "kickoff": "2026-11-06 16:40", "predicted_at": "2026-11-06T08:20:36+00:00",
            "handicap": -1,
            "fotmob_xg": {"match_id": 1000017575, "home_team_id": 10164, "away_team_id": 8164},
            "prediction": {"status": "PREDICTED", "modules": {
                "胜平负": {"top1": "胜", "top2": ["胜", "平"]},
                "让球": {"top2": ["让负", "让平"]},
                "比分": {"top3": ["1:1", "0:1", "1:0"]},
                "总进球": {"top3": [2, 3, 1]},
                "半全场": {"top3": ["负-负", "胜-胜", "平-平"]},
                "今日优选": {"selection": None},
                "冷门预警": {"triggered": False, "direction": None},
            }}
        }

    def details(self):
        return {"general": {"matchId": 1000017575, "homeTeam": {"id": 10164},
                 "awayTeam": {"id": 8164}, "matchTimeUTCDate": "2026-11-06T08:40:00Z"},
                "header": {"status": {"finished": True, "cancelled": False,
                            "awarded": False, "reason": {"short": "FT"}, "scoreStr": "4 - 1"},
                           "teams": [{"id": 10164, "score": 4}, {"id": 8164, "score": 1}]},
                "content": {"matchFacts": {"events": {"events": [
                    {"type": "Half", "halfStrShort": "HT", "homeScore": 2, "awayScore": 0}]}}}}

    def test_verified_identity_and_scores(self):
        result, error = result_for(self.fixture(), lambda url: self.details(),
            datetime(2026, 11, 6, 12, 0, tzinfo=timezone.utc))
        self.assertIsNone(error)
        self.assertEqual((result["ht"], result["ft"]), ("2:0", "4:1"))
        hit = mark(self.fixture(), result, datetime(2026, 11, 6, 12, 0, tzinfo=timezone.utc))["hits"]
        self.assertEqual(hit["胜平负Top1"], True)
        row = mark(self.fixture(), result, datetime(2026, 11, 6, 12, tzinfo=timezone.utc))["module_results"]
        self.assertEqual(row["胜平负"]["status"], "HIT")
        self.assertEqual(row["让球"]["actual"], "让胜")
        self.assertEqual(row["让球"]["status"], "MISS")
        self.assertEqual(row["半全场"]["hits"]["Top3"], True)
        self.assertEqual(row["今日优选"]["status"], "NO_FORMAL_SELECTION")
        self.assertEqual(hit["让球Top1"], False)
        self.assertEqual(hit["总进球Top3"], False)
        self.assertIsNone(hit["今日优选"])
        self.assertEqual(metrics([dict(self.fixture(), settlement={"hits": hit})])["module_hits"]["胜平负Top1"]["total"], 1)
        sample = metrics([dict(self.fixture(), settlement={"hits": hit})])
        self.assertEqual(sample["module_hits"]["今日优选"]["total"], 0)
        self.assertEqual(sample["module_stats"]["胜平负"]["rates"]["Top1"]["hit"], 1)
        self.assertEqual(sample["module_stats"]["今日优选"]["verified"], 0)

    def test_latest_pre_kickoff_prediction_survives_old_settlement(self):
        import engine4.aggregate as aggregate
        old = self.fixture()
        old["predicted_at"] = "2026-11-06T04:18:22+00:00"
        old["prediction"]["modules"]["让球"]["top2"] = ["让胜", "让负"]
        result = {"ht": "2:0", "ft": "4:1", "source_url": "https://www.fotmob.com/api/data/matchDetails?matchId=1000017575",
                  "verified_at": "2026-11-06T12:00:00+00:00"}
        old["settlement"] = mark(old, result, datetime(2026, 11, 6, 12, tzinfo=timezone.utc))
        latest = self.fixture()
        latest["predicted_at"] = "2026-11-06T08:20:36+00:00"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "history").mkdir()
            (root / "history" / "earlier.json").write_text(json.dumps({"sale_day": "2026-11-06", "matches": [old]}))
            (root / "history" / "later.json").write_text(json.dumps({"sale_day": "2026-11-06", "matches": [latest]}))
            (root / "latest.json").write_text(json.dumps({"sale_day": "2026-11-06", "matches": []}))
            with patch.object(aggregate, "ROOT", root), patch.object(aggregate, "LATEST", root / "latest.json"), patch.object(aggregate, "SALES", root / "sales"), patch.object(aggregate, "settle", side_effect=lambda p, current: json.loads(p.read_text())):
                report = aggregate.run(datetime(2026, 11, 6, 12, tzinfo=timezone.utc))
            self.assertEqual(report["matches"][0]["predicted_at"], latest["predicted_at"])
            self.assertFalse(report["matches"][0]["settlement"]["hits"]["让球Top1"])
            self.assertEqual(report["metrics"]["settled"], 1)

    def test_daily_value_two_picks_settle_by_either_option(self):
        match = self.fixture()
        match["prediction"]["modules"]["今日优选"] = {
            "status": "SELECTED", "selection": ["负", "胜"], "top2": ["负", "胜"]
        }
        result = {"ht": "2:0", "ft": "4:1", "source_url": "https://www.fotmob.com/api/data/matchDetails?matchId=1000017575"}
        settled = mark(match, result, datetime(2026, 11, 6, 12, tzinfo=timezone.utc))
        self.assertIs(settled["hits"]["今日优选Top1"], False)
        self.assertIs(settled["hits"]["今日优选Top2"], True)
        self.assertIs(settled["hits"]["今日优选"], True)
        self.assertEqual(settled["module_results"]["今日优选"]["picks"], ["负", "胜"])
        self.assertEqual(settled["module_results"]["今日优选"]["status"], "HIT")
        stats = metrics([dict(match, settlement=settled)])["module_stats"]["今日优选"]
        self.assertEqual(stats["predicted"], 1)
        self.assertEqual(stats["verified"], 1)
        self.assertEqual(stats["rates"]["Top1"]["hit"], 0)
        self.assertEqual(stats["rates"]["Top2"]["hit"], 1)
        self.assertEqual(stats["rates"][""]["hit"], 1)

    def test_daily_value_candidate_is_not_a_formal_sample(self):
        match = self.fixture()
        match["prediction"]["modules"]["今日优选"] = {
            "status": "CANDIDATE", "selection": None, "candidate": ["胜", "平"], "top2": ["胜", "平"]
        }
        result = {"ht": "2:0", "ft": "4:1", "source_url": "https://www.fotmob.com/api/data/matchDetails?matchId=1000017575"}
        settled = mark(match, result, datetime(2026, 11, 6, 12, tzinfo=timezone.utc))
        self.assertIsNone(settled["hits"]["今日优选"])
        self.assertEqual(metrics([dict(match, settlement=settled)])["module_stats"]["今日优选"]["verified"], 0)

    def test_reject_mismatched_score_and_early_result(self):
        self.assertEqual(score("4 - 1"), (4, 1))
        self.assertEqual(result_for(self.fixture(), lambda url: self.details(),
            datetime(2026, 11, 6, 9, 0, tzinfo=timezone.utc))[1], "NOT_DUE")
        wrong = self.details()
        wrong["header"]["teams"][0]["score"] = 3
        self.assertEqual(result_for(self.fixture(), lambda url: wrong,
            datetime(2026, 11, 6, 12, 0, tzinfo=timezone.utc))[1], "FT_SCORE_CONFLICT")


if __name__ == "__main__":
    unittest.main()
