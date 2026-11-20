import unittest

from core import official_matches, match_candidate, publishable_payload


class MatchingTests(unittest.TestCase):
    def setUp(self):
        self.match = {"match_no": "005", "source_id": "502996551", "home": "马斯特里",
                      "away": "维特斯", "league": "荷乙", "kickoff": "2026-11-15 21:30"}

    def test_sale_day_and_count(self):
        self.assertEqual(official_matches({"sale_day": "2026-11-15", "matches": [self.match]}, "2026-11-15"), [self.match])
        with self.assertRaises(ValueError):
            official_matches({"sale_day": "2026-11-14", "matches": [self.match]}, "2026-11-15")

    def test_match_requires_independent_id_and_exact_evidence(self):
        candidate = {k: self.match[k] for k in ("match_no", "home", "away", "league", "kickoff")}
        self.assertFalse(match_candidate(self.match, candidate))
        candidate["lota_match_id"] = "source-lota-id"
        self.assertTrue(match_candidate(self.match, candidate))
        candidate["away"] = "其他球队"
        self.assertFalse(match_candidate(self.match, candidate))

    def test_missing_business_data_never_published(self):
        with self.assertRaises(ValueError):
            publishable_payload("2026-11-15", [self.match], [])
        with self.assertRaises(ValueError):
            publishable_payload("2026-11-15", [self.match], [{"match_no": "005"}])


if __name__ == "__main__":
    unittest.main()
